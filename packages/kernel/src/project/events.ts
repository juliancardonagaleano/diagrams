import { ProjectError } from './errors';

/**
 * Cambios de los proyectos en tiempo real: el cliente del canal de eventos que ofrece `iark serve` (`GET /api/events`, Server-Sent Events).
 *
 * El canal es solo un **aviso**: dice qué cambió (proyecto, diagrama, `updatedAt` y quién), nunca el documento. Quien lo recibe vuelve a leer la lista
 * por el camino de siempre, con los mismos permisos, así que nada de lo que llega por aquí amplía lo que una persona puede ver. No sustituye al sondeo:
 * si el servidor no lo ofrece (uno anterior, un proxy que lo corta, un token sin permiso) el cliente lo cuenta en su estado y quien lo usa sigue
 * sondeando como antes.
 *
 * Lo implementa `fetch` con lectura en flujo, y no `EventSource`, porque `EventSource` no puede enviar la cabecera `Authorization` y el token no debe
 * viajar en la dirección (acabaría en registros de proxies y en el historial del navegador).
 */

/** Los avisos que envía el servidor. Un tipo que este cliente no conozca se acepta igual (sirve para volver a leer la lista). */
export const PROJECT_EVENT_TYPES = [
  'project.created',
  'project.changed',
  'project.deleted',
  'diagram.created',
  'diagram.saved',
  'diagram.renamed',
  'diagram.deleted',
  'diagram.restored',
] as const;
export type ProjectEventType = (typeof PROJECT_EVENT_TYPES)[number];

/** Un cambio en un proyecto, tal como lo cuenta el servidor: sin el documento. */
export interface ProjectEvent {
  type: ProjectEventType | (string & {});
  /** Identificador del proyecto. */
  project: string;
  /** Identificador del diagrama, en los avisos de diagramas. */
  diagram?: string;
  /** La marca `updatedAt` que quedó (proyecto o diagrama); no viene en los borrados. */
  updatedAt?: string;
  /** Quién lo hizo: `@usuario` de una sesión o el nombre del token. Ausente si el servidor no sabe quién es (sin autenticación). */
  by?: string;
  /** Cuándo (ISO 8601, según el reloj del servidor). */
  at: string;
}

/** Cómo va la conexión al canal. `unsupported` y `rejected` son finales (no se reintenta): el primero vuelve al sondeo; el segundo espera un token nuevo. */
export type EventsState = 'connecting' | 'live' | 'retrying' | 'unsupported' | 'rejected' | 'stopped';

export interface EventsStatus {
  state: EventsState;
  /** Por qué no está en directo (el último fallo, o el motivo de `unsupported`/`rejected`). */
  error?: ProjectError;
  /** En `retrying`: cuántos milisegundos falta para el próximo intento. */
  retryInMs?: number;
}

export interface EventsHandlers {
  onEvent(event: ProjectEvent): void;
  onStatus?(status: EventsStatus): void;
}

export interface EventsOptions {
  /** Solo los cambios de este proyecto (el servidor lo comprueba: 404 si la persona no pertenece a él). */
  project?: string;
  /** Espera antes del primer reintento (ms); se duplica con cada fallo seguido. Por omisión 1000. */
  baseMs?: number;
  /** Tope de la espera entre reintentos (ms). Por omisión 60 000. */
  maxMs?: number;
  /** Cuánto silencio (ms) se tolera antes de dar la conexión por muerta (un proxy que se tragó el flujo). Por omisión 3 latidos del servidor, o 75 s hasta saberlos. */
  silenceMs?: number;
  /** Fuente de aleatoriedad del reintento (en las pruebas, una fija). */
  random?: () => number;
}

/** Un identificador o un tipo del servidor: texto corto y sin nada raro; lo demás se descarta en vez de pasar a la interfaz. */
const SHORT = /^[\w.@~-]{1,120}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]{5,16}(Z|[+-]\d{2}:\d{2})$/;

/** Un aviso del servidor (el `data` de un mensaje `change`), o `undefined` si no tiene lo mínimo. */
export function parseProjectEvent(data: string): ProjectEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const e = value as Record<string, unknown>;
  if (typeof e.type !== 'string' || !/^[a-z]+\.[a-z]+$/.test(e.type) || typeof e.project !== 'string' || !SHORT.test(e.project)) return undefined;
  const diagram = typeof e.diagram === 'string' && SHORT.test(e.diagram) ? e.diagram : undefined;
  const updatedAt = typeof e.updatedAt === 'string' && ISO.test(e.updatedAt) ? e.updatedAt : undefined;
  const by = typeof e.by === 'string' && e.by && e.by.length <= 120 ? e.by : undefined;
  return { type: e.type, project: e.project, ...(diagram ? { diagram } : {}), ...(updatedAt ? { updatedAt } : {}), ...(by ? { by } : {}), at: typeof e.at === 'string' && ISO.test(e.at) ? e.at : new Date().toISOString() };
}

// ───────────── formato text/event-stream ─────────────

/** Un mensaje del flujo: `event` (por omisión `message`) y `data` (varias líneas `data:` se unen con un salto). */
export interface SseMessage {
  event: string;
  data: string;
}

/** Lo máximo que se acumula sin completar un mensaje (un servidor roto no debe agotar la memoria de la pestaña). */
const MAX_PENDING = 256 * 1024;

/**
 * Lector de `text/event-stream` (WHATWG HTML, §9.2): líneas terminadas en `\n`, `\r` o `\r\n`, campos `event` y `data`, comentarios (`:`) y mensajes
 * separados por una línea en blanco. Los campos `id` y `retry` se leen y se ignoran: el servidor no reanuda (al reconectar se vuelve a leer la lista)
 * y la espera de reintento la decide el cliente.
 */
export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  private started = false;

  /** Procesa un trozo de texto y devuelve los mensajes que completó. `activity` se llama con cada línea recibida, también con los comentarios (latidos). */
  push(chunk: string, activity?: () => void): SseMessage[] {
    this.buffer += chunk;
    if (!this.started && this.buffer.length > 0) {
      this.started = true;
      if (this.buffer.charCodeAt(0) === 0xfeff) this.buffer = this.buffer.slice(1);
    }
    const out: SseMessage[] = [];
    // Un `\r` final puede ser la mitad de un `\r\n`: se espera al siguiente trozo para saberlo.
    const text = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer;
    const lines = text.split(/\r\n|\n|\r/);
    const rest = lines.pop() ?? '';
    this.buffer = (this.buffer.endsWith('\r') ? `${rest}\r` : rest);
    if (this.buffer.length > MAX_PENDING) throw new ProjectError('unavailable', 'El servidor envió un mensaje de eventos demasiado largo.');
    for (const line of lines) {
      activity?.();
      if (line === '') {
        if (this.data.length > 0) out.push({ event: this.event || 'message', data: this.data.join('\n') });
        this.event = '';
        this.data = [];
      } else if (line.startsWith(':')) {
        continue; // comentario: solo prueba que la conexión sigue viva
      } else {
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') this.event = value;
        else if (field === 'data') this.data.push(value);
        if (this.data.join('\n').length > MAX_PENDING) throw new ProjectError('unavailable', 'El servidor envió un mensaje de eventos demasiado largo.');
      }
    }
    return out;
  }
}

// ───────────── conexión con reintentos ─────────────

const DEFAULT_SILENCE_MS = 75_000;
/** Una conexión que dura menos que esto no cuenta como «se arregló»: la espera de reintento sigue creciendo (un proxy que acepta y corta no debe provocar una tormenta). */
const STABLE_MS = 5_000;
/** Cuánto se espera la respuesta (las cabeceras) del servidor antes de dar el intento por fallido. */
const CONNECT_TIMEOUT_MS = 20_000;

export interface EventsConnectionConfig {
  /** `https://servidor` ya normalizado, sin `/` final. */
  baseUrl: string;
  /** El token de ahora mismo (puede cambiar entre intentos). */
  token(): string | undefined;
  fetch: typeof fetch;
}

/**
 * La conexión viva al canal de eventos, con sus reintentos. Se reconecta sola con espera exponencial y algo de azar (para que mil pestañas que perdieron
 * el servidor a la vez no vuelvan a la vez), da por muerta una conexión sin latidos y se detiene para siempre cuando el servidor dice que no hay canal
 * (`unsupported`) o que el token no vale (`rejected`; `kick` la despierta con el token nuevo).
 */
export class EventsConnection {
  private controller: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private generation = 0;
  private silenceMs: number;
  private status: EventsStatus = { state: 'stopped' };

  constructor(
    private readonly config: EventsConnectionConfig,
    private readonly handlers: EventsHandlers,
    private readonly options: EventsOptions = {},
  ) {
    this.silenceMs = options.silenceMs ?? DEFAULT_SILENCE_MS;
  }

  get current(): EventsStatus {
    return this.status;
  }

  start(): void {
    if (this.status.state !== 'stopped') return;
    this.begin();
  }

  /** Para la conexión y los reintentos. */
  stop(): void {
    this.generation += 1;
    this.cancel();
    this.set({ state: 'stopped' });
  }

  /** Vuelve a conectar ya (el token cambió, o volvió la red): empieza con la espera mínima. */
  kick(): void {
    if (this.status.state === 'stopped' || this.status.state === 'unsupported') return;
    this.generation += 1;
    this.cancel();
    this.attempt = 0;
    this.begin();
  }

  private set(status: EventsStatus): void {
    this.status = status;
    try {
      this.handlers.onStatus?.(status);
    } catch {
      /* un manejador que falla no debe tumbar la conexión */
    }
  }

  private cancel(): void {
    this.controller?.abort();
    this.controller = undefined;
    if (this.timer) clearTimeout(this.timer);
    if (this.watchdog) clearTimeout(this.watchdog);
    this.timer = this.watchdog = undefined;
  }

  private begin(): void {
    const generation = this.generation;
    this.set({ state: 'connecting', ...(this.status.error ? { error: this.status.error } : {}) });
    void this.run(generation);
  }

  private url(): string {
    const project = this.options.project;
    return `${this.config.baseUrl}/api/events${project ? `?project=${encodeURIComponent(project)}` : ''}`;
  }

  private armWatchdog(controller: AbortController, generation: number): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (generation === this.generation) controller.abort(new ProjectError('unavailable', 'El servidor dejó de enviar latidos.', { network: true }));
    }, this.silenceMs);
  }

  private async run(generation: number): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    const connecting = setTimeout(() => controller.abort(new ProjectError('unavailable', `${this.config.baseUrl} no respondió al abrir el canal de eventos.`, { network: true })), CONNECT_TIMEOUT_MS);
    const openedAt = Date.now();
    const abortReason = (): ProjectError | undefined => (controller.signal.aborted && controller.signal.reason instanceof ProjectError ? controller.signal.reason : undefined);
    let response: Response;
    try {
      const headers: Record<string, string> = { Accept: 'text/event-stream' };
      const token = this.config.token();
      if (token) headers.Authorization = `Bearer ${token}`;
      response = await this.config.fetch(this.url(), { method: 'GET', headers, signal: controller.signal, credentials: 'omit', cache: 'no-store' } as RequestInit);
    } catch (error) {
      if (generation !== this.generation) return;
      return this.retry(generation, abortReason() ?? new ProjectError('unavailable', `No se pudo abrir el canal de eventos de ${this.config.baseUrl}: ${error instanceof Error ? error.message : String(error)}.`, { network: true }));
    } finally {
      clearTimeout(connecting);
    }
    if (generation !== this.generation) return void controller.abort();
    const refused = this.refusal(response);
    if (refused) {
      void response.body?.cancel().catch(() => undefined);
      if (refused.final) return this.set({ state: refused.state, error: refused.error });
      return this.retry(generation, refused.error, refused.retryAfterMs);
    }
    const ended = await this.read(response, controller, generation, openedAt);
    if (generation !== this.generation) return;
    if (ended.stable) this.attempt = 0;
    this.retry(generation, abortReason() ?? ended.error);
  }

  /** Si la respuesta no es el flujo esperado: qué hacer. `undefined` si es el flujo. */
  private refusal(response: Response): { final: boolean; state: 'unsupported' | 'rejected'; error: ProjectError; retryAfterMs?: number } | undefined {
    if (response.ok) {
      const type = (response.headers.get('Content-Type') ?? '').toLowerCase();
      if (type.startsWith('text/event-stream') && response.body) return undefined;
      // Un 200 que no es el flujo: el sitio estático de un servidor anterior (devuelve su página), o un proxy que lo reescribe.
      return { final: true, state: 'unsupported', error: new ProjectError('unsupported', 'Este servidor no ofrece el canal de eventos en directo.', { status: response.status }) };
    }
    const status = response.status;
    const info = { status };
    if (status === 401) return { final: true, state: 'rejected', error: new ProjectError('unauthorized', 'El servidor no aceptó la credencial para el canal de eventos.', info) };
    if (status === 403) return { final: true, state: 'rejected', error: new ProjectError('forbidden', 'Esta credencial no puede abrir el canal de eventos.', info) };
    if (status === 429) {
      const wait = Number(response.headers.get('Retry-After'));
      return { final: false, state: 'unsupported', error: new ProjectError('unavailable', 'El servidor limita los canales de eventos abiertos: se sigue sondeando.', { ...info, ...(wait > 0 ? { retryAfterSec: Math.ceil(wait) } : {}) }), ...(wait > 0 ? { retryAfterMs: Math.ceil(wait) * 1000 } : {}) };
    }
    if (status === 404 || status === 405 || status === 410 || status === 501) return { final: true, state: 'unsupported', error: new ProjectError('unsupported', 'Este servidor no ofrece el canal de eventos en directo.', info) };
    if (status >= 400 && status < 500 && status !== 408) return { final: true, state: 'unsupported', error: new ProjectError('unsupported', `El servidor rechazó el canal de eventos (${status}).`, info) };
    return { final: false, state: 'unsupported', error: new ProjectError('unavailable', `El servidor respondió ${status} al abrir el canal de eventos.`, info) };
  }

  /** Lee el flujo hasta que se corta. Devuelve por qué terminó y si la conexión duró lo bastante como para contar como estable. */
  private async read(response: Response, controller: AbortController, generation: number, openedAt: number): Promise<{ error: ProjectError; stable: boolean }> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    this.silenceMs = this.options.silenceMs ?? DEFAULT_SILENCE_MS;
    this.armWatchdog(controller, generation);
    let ended: ProjectError | undefined;
    let live = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (generation !== this.generation) return { error: new ProjectError('unavailable', 'Canal cerrado.'), stable: false };
        if (done) break;
        let messages: SseMessage[];
        try {
          messages = parser.push(decoder.decode(value, { stream: true }), () => this.armWatchdog(controller, generation));
        } catch (error) {
          void reader.cancel().catch(() => undefined);
          return { error: error as ProjectError, stable: false };
        }
        for (const message of messages) {
          if (message.event === 'ready') {
            const heartbeat = readyHeartbeat(message.data);
            if (heartbeat && !this.options.silenceMs) this.silenceMs = Math.max(5_000, heartbeat * 3);
            this.armWatchdog(controller, generation);
            live = true;
            this.set({ state: 'live' });
          } else if (message.event === 'change') {
            const event = parseProjectEvent(message.data);
            if (event) {
              try {
                this.handlers.onEvent(event);
              } catch {
                /* un manejador que falla no debe tumbar la conexión */
              }
            }
          } else if (message.event === 'bye') {
            const reason = byeReason(message.data);
            if (reason === 'unauthorized') {
              void reader.cancel().catch(() => undefined);
              this.attempt = 0;
              this.set({ state: 'rejected', error: new ProjectError('unauthorized', 'El servidor cerró el canal: la credencial ya no vale.') });
              this.generation += 1;
              return { error: new ProjectError('unauthorized', 'Credencial rechazada.'), stable: true };
            }
            ended = new ProjectError('unavailable', reason === 'shutdown' ? 'El servidor se está reiniciando.' : 'El servidor cerró el canal.', { network: true });
          }
        }
      }
    } catch (error) {
      if (generation !== this.generation) return { error: new ProjectError('unavailable', 'Canal cerrado.'), stable: false };
      const reason = controller.signal.aborted && controller.signal.reason instanceof ProjectError ? controller.signal.reason : undefined;
      ended = reason ?? new ProjectError('unavailable', `Se cortó el canal de eventos: ${error instanceof Error ? error.message : String(error)}.`, { network: true });
    }
    return { error: ended ?? new ProjectError('unavailable', 'El servidor cerró el canal de eventos.', { network: true }), stable: live && Date.now() - openedAt >= STABLE_MS };
  }

  private retry(generation: number, error: ProjectError, minMs?: number): void {
    if (generation !== this.generation) return;
    if (this.controller) this.controller = undefined;
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = undefined;
    const { baseMs = 1000, maxMs = 60_000, random = Math.random } = this.options;
    this.attempt += 1;
    const exponential = Math.min(maxMs, baseMs * 2 ** Math.min(this.attempt - 1, 20));
    const delay = Math.max(minMs ?? 0, Math.round(exponential * (0.75 + 0.5 * random())));
    this.set({ state: 'retrying', error, retryInMs: delay });
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (generation === this.generation) this.begin();
    }, delay);
  }
}

function readyHeartbeat(data: string): number | undefined {
  try {
    const value = (JSON.parse(data) as { heartbeatMs?: unknown }).heartbeatMs;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function byeReason(data: string): string | undefined {
  try {
    const value = (JSON.parse(data) as { reason?: unknown }).reason;
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}
