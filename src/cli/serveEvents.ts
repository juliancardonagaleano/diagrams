import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ProjectStore } from '@iark/kernel';
import type { Accounts } from './accounts/service';
import { HttpError } from './httpError';
import { clientAddress, type Authenticator, type Identity } from './serveAuth';
import { guard } from './serveProjects';
import { isWorkspaceId } from './workspace';

/**
 * Cambios de los proyectos en tiempo real (`GET /api/events`, con `--workspace`): un canal de eventos del servidor al navegador (Server-Sent Events,
 * `text/event-stream`) que **avisa** de qué cambió; no lleva documentos ni nombres. Quien lo recibe vuelve a leer lo que le interesa por la API de
 * siempre, con los mismos permisos, así que este canal no amplía lo que nadie puede ver. No hay edición colaborativa: dos personas que guardan el mismo
 * diagrama siguen pasando por `ifUpdatedAt` y el conflicto de siempre.
 *
 *   GET /api/events[?project=<p>]        los cambios de los proyectos de quien llama (o solo los de <p>)
 *
 * Mensajes (`event:`):
 *   ready    { heartbeatMs }                                            al abrir: el canal está en marcha
 *   change   { type, project, diagram?, updatedAt?, by?, at }           un cambio; `type` es `project.created|changed|deleted` o `diagram.created|saved|renamed|deleted|restored`
 *   bye      { reason: "unauthorized" | "shutdown" }                    el servidor cierra el canal (la credencial dejó de valer, o se está parando)
 *   : hb                                                                comentario cada `heartbeatMs`: los proxies no cortan una conexión que habla, y el cliente da por muerta la que calla
 *
 * Seguridad (las mismas reglas que el resto de `/api/projects`):
 *  - la credencial es la cabecera `Authorization` (nunca la dirección: `EventSource` no puede enviarla y por eso el cliente usa `fetch`); con tokens o cuentas,
 *    sin ella 401; sin autenticación valen las comprobaciones de `Host` y `Origin` de siempre;
 *  - cada cambio solo llega a quien pertenece al proyecto (un administrador de la instancia o un token ven todos); la pertenencia se mira **al publicar**, no al
 *    conectar, así que quien deja de pertenecer a un proyecto deja de recibir sus cambios (y recibe el aviso de que se le quitó);
 *  - cada latido se vuelve a comprobar la credencial: si se revocó el token o caducó la sesión, el servidor envía `bye` y cierra;
 *  - hay un tope de canales abiertos por persona (por nombre de token o por dirección, sin autenticación) y otro global: pasado el tope, 429 con `Retry-After`;
 *    el cliente sigue sondeando. Es memoria de este proceso: con varias instancias sobre la misma carpeta solo se avisa de lo que pasó por cada una.
 *
 * No hay reanudación (`Last-Event-ID`): al reconectar, el cliente vuelve a leer la lista, que es la verdad. Tampoco avisa de lo que se cambie sin pasar por
 * este servicio (el CLI `iark project` sobre la misma carpeta): ese caso lo cubre el sondeo de siempre.
 */

export type ChangeType = 'project.created' | 'project.changed' | 'project.deleted' | 'diagram.created' | 'diagram.saved' | 'diagram.renamed' | 'diagram.deleted' | 'diagram.restored';

/** Lo que cuenta un aviso: identificadores y marcas, nunca contenido. */
export interface ChangeEvent {
  type: ChangeType;
  project: string;
  diagram?: string;
  updatedAt?: string;
  /** Quién lo hizo: el nombre del token o `@usuario` de la sesión. */
  by?: string;
}

export interface PublishOptions {
  /** Cuentas que deben recibir el aviso aunque ya no pertenezcan al proyecto: a quien se quitó, o los miembros de un proyecto que se acaba de borrar. */
  alsoUsers?: Iterable<string>;
}

/** Lo que `serveProjects.ts` necesita para avisar de un cambio. */
export interface EventPublisher {
  /** Avisa de un cambio y termina cuando ya se entregó a los canales abiertos (con cuentas, mirar a quién pertenece cada uno es una consulta al almacén). Nunca rechaza. */
  publish(event: ChangeEvent, options?: PublishOptions): Promise<void>;
}

export interface EventHubOptions {
  /** Con cuentas, para saber qué proyectos ve cada persona. */
  accounts?: Accounts;
  /** Canales abiertos a la vez por persona. Por omisión 8. */
  maxPerPerson?: number;
  /** Canales abiertos a la vez en todo el servicio. Por omisión 1000. */
  maxTotal?: number;
  /** Cada cuántos milisegundos se envía un latido (y se vuelve a comprobar la credencial). Por omisión 20 000. */
  heartbeatMs?: number;
  /** Lo que se acumula sin que el navegador lo lea antes de cortar (un consumidor lento no debe llenar la memoria). Por omisión 256 KiB. */
  maxBufferedBytes?: number;
  now?: () => Date;
}

export const DEFAULT_MAX_STREAMS_PER_PERSON = 8;
export const DEFAULT_HEARTBEAT_MS = 20_000;

/** Un canal abierto. */
interface Connection {
  readonly id: number;
  /** Quién es, para el tope (`u:<id de cuenta>`, `t:<nombre del token>` o `a:<dirección>`). */
  readonly key: string;
  readonly res: ServerResponse;
  identity: Identity | undefined;
  readonly project: string | undefined;
  /** Vuelve a identificar a quien abrió el canal: su identidad de ahora, `'revoked'` si la credencial ya no vale, o `undefined` si no se pudo comprobar. */
  readonly recheck: () => Promise<Identity | 'revoked' | undefined>;
  /** La credencial con la que se abrió (la cabecera `Authorization`): los canales que comparten credencial se comprueban con una sola consulta por latido. */
  readonly credential: string | undefined;
  /** Lo que se ha enviado por este canal; el registro de accesos lo lee al terminar la respuesta. */
  readonly summary: StreamSummary;
}

/** Cuántos mensajes de cambio y cuántos bytes se enviaron por un canal. */
export interface StreamSummary {
  events: number;
  bytes: number;
}

export interface EventStats {
  open: number;
  published: number;
  delivered: number;
  rejected: number;
  dropped: number;
}

const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export class EventHub implements EventPublisher {
  private readonly connections = new Set<Connection>();
  private readonly perKey = new Map<string, number>();
  private readonly accounts: Accounts | undefined;
  readonly maxPerPerson: number;
  readonly maxTotal: number;
  readonly heartbeatMs: number;
  private readonly maxBuffered: number;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Un latido en curso: con una base de red puede tardar más que el intervalo, y no deben solaparse. */
  private beating = false;
  /** El último aviso en reparto: los cambios llegan a los canales en el orden en que se publicaron. */
  private delivering: Promise<void> = Promise.resolve();
  private nextId = 0;
  private closing = false;
  readonly stats: EventStats = { open: 0, published: 0, delivered: 0, rejected: 0, dropped: 0 };

  constructor(options: EventHubOptions = {}) {
    this.accounts = options.accounts;
    this.maxPerPerson = Math.max(1, options.maxPerPerson ?? DEFAULT_MAX_STREAMS_PER_PERSON);
    this.maxTotal = Math.max(1, options.maxTotal ?? 1000);
    this.heartbeatMs = Math.max(10, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    this.maxBuffered = options.maxBufferedBytes ?? 256 * 1024;
    this.now = options.now ?? (() => new Date());
  }

  /** Canales abiertos ahora mismo. */
  get size(): number {
    return this.connections.size;
  }

  /** ¿Cabe un canal más para esta persona? Si no, `false` y se cuenta como rechazado. */
  admit(key: string): boolean {
    const full = this.closing || this.connections.size >= this.maxTotal || (this.perKey.get(key) ?? 0) >= this.maxPerPerson;
    if (full) this.stats.rejected += 1;
    return !full;
  }

  /**
   * Abre el canal en `res` (que ya pasó la autenticación y `admit`). Devuelve cómo cerrarlo; también se cierra solo cuando el navegador cuelga.
   * `summary` se va rellenando con lo que se envía (para el registro de accesos, que lo lee cuando la respuesta termina).
   */
  open(init: { key: string; res: ServerResponse; identity: Identity | undefined; project: string | undefined; recheck: Connection['recheck']; credential?: string; summary: StreamSummary }): () => void {
    const { res } = init;
    const connection: Connection = { id: (this.nextId += 1), key: init.key, res, identity: init.identity, project: init.project, recheck: init.recheck, credential: init.credential, summary: init.summary };
    res.socket?.setTimeout(0); // un canal abierto no vence por inactividad del socket
    res.socket?.setNoDelay(true); // cada mensaje sale al instante, sin esperar a juntar paquetes
    res.socket?.setKeepAlive(true, 30_000);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // `no-transform`: ningún proxy ni caché debe recomprimir o reescribir el flujo; `X-Accel-Buffering` es el interruptor de nginx para no acumularlo.
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
      Connection: 'keep-alive',
    });
    this.connections.add(connection);
    this.perKey.set(connection.key, (this.perKey.get(connection.key) ?? 0) + 1);
    this.stats.open = this.connections.size;
    if (!this.timer) {
      this.timer = setInterval(() => void this.beat(), this.heartbeatMs);
      this.timer.unref();
    }
    // `retry:` es la espera por omisión de un `EventSource`; el cliente de IArk usa su propia espera exponencial.
    this.write(connection, `retry: 5000\n${frame('ready', { heartbeatMs: this.heartbeatMs })}`);
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      this.connections.delete(connection);
      const left = (this.perKey.get(connection.key) ?? 1) - 1;
      if (left > 0) this.perKey.set(connection.key, left);
      else this.perKey.delete(connection.key);
      this.stats.open = this.connections.size;
      if (this.connections.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    };
    res.once('close', close);
    return () => {
      this.end(connection);
      close();
    };
  }

  /** ¿Puede esta identidad ver los cambios de ese proyecto ahora mismo? `roles` ya trae lo que dice el almacén de cuentas de cada persona (ver `rolesOfViewers`). */
  private sees(identity: Identity | undefined, projectId: string, extra: Set<string>, roles: Map<string, ReadonlySet<string>>): boolean {
    if (!this.accounts || !identity || identity.kind === 'token') return true; // un token vale para toda la carpeta; sin cuentas no hay pertenencia
    if (identity.siteRole === 'admin') return true;
    if (extra.has(identity.user.id)) return true;
    return roles.get(identity.user.id)?.has(projectId) ?? false;
  }

  /**
   * A qué proyectos pertenece cada persona con un canal abierto que no los ve todos (una consulta por persona, en paralelo). Si el almacén de cuentas no
   * responde, lo más prudente es no avisar a esa persona.
   */
  private async rolesOfViewers(connections: Connection[], extra: Set<string>): Promise<Map<string, ReadonlySet<string>>> {
    const roles = new Map<string, ReadonlySet<string>>();
    const accounts = this.accounts;
    if (!accounts) return roles;
    const wanted = new Set<string>();
    for (const { identity } of connections) {
      if (identity?.kind === 'user' && identity.siteRole !== 'admin' && !extra.has(identity.user.id)) wanted.add(identity.user.id);
    }
    await Promise.all(
      [...wanted].map(async (userId) => {
        try {
          roles.set(userId, new Set((await accounts.store.rolesOf(userId)).keys()));
        } catch {
          roles.set(userId, new Set());
        }
      }),
    );
    return roles;
  }

  /** Avisa de un cambio a quien pertenece al proyecto. Nunca rechaza: un canal roto no debe estropear la petición que cambió algo. */
  publish(event: ChangeEvent, options: PublishOptions = {}): Promise<void> {
    this.stats.published += 1;
    if (this.connections.size === 0) return Promise.resolve();
    const run = this.delivering.then(() => this.deliver(event, options));
    this.delivering = run;
    return run;
  }

  private async deliver(event: ChangeEvent, options: PublishOptions): Promise<void> {
    try {
      if (this.connections.size === 0) return;
      const payload = frame('change', {
        type: event.type,
        project: event.project,
        ...(event.diagram ? { diagram: event.diagram } : {}),
        ...(event.updatedAt ? { updatedAt: event.updatedAt } : {}),
        ...(event.by ? { by: event.by } : {}),
        at: this.now().toISOString(),
      });
      const extra = new Set(options.alsoUsers ?? []);
      const roles = await this.rolesOfViewers([...this.connections], extra);
      for (const connection of [...this.connections]) {
        try {
          if (connection.project !== undefined && connection.project !== event.project) continue;
          if (!this.sees(connection.identity, event.project, extra, roles)) continue;
          if (this.write(connection, payload)) {
            connection.summary.events += 1;
            this.stats.delivered += 1;
          }
        } catch {
          this.drop(connection);
        }
      }
    } catch {
      // un fallo al repartir no debe romper la petición que provocó el cambio
    }
  }

  /** Escribe en un canal; `false` si no se pudo (o se cortó por ir demasiado atrasado). */
  private write(connection: Connection, text: string): boolean {
    const { res } = connection;
    if (res.destroyed || res.writableEnded) return false;
    if (res.writableLength > this.maxBuffered) {
      this.drop(connection);
      return false;
    }
    res.write(text);
    connection.summary.bytes += Buffer.byteLength(text);
    return true;
  }

  /** Corta un canal que no se puede atender (el navegador no lee): se vuelve a conectar y a leer la lista. */
  private drop(connection: Connection): void {
    this.stats.dropped += 1;
    connection.res.destroy();
  }

  private end(connection: Connection, reason?: 'unauthorized' | 'shutdown'): void {
    const { res } = connection;
    if (res.destroyed || res.writableEnded) return;
    try {
      if (reason) res.write(frame('bye', { reason }));
      res.end();
    } catch {
      res.destroy();
    }
  }

  /** Un latido: mantiene viva la conexión (los proxies cortan la que calla) y vuelve a comprobar que la credencial sigue valiendo. */
  private async beat(): Promise<void> {
    if (this.beating) return;
    this.beating = true;
    try {
      // Una sola comprobación por credencial y latido: mil canales de la misma sesión no son mil consultas al almacén de cuentas.
      const checks = new Map<string, ReturnType<Connection['recheck']>>();
      await Promise.all(
        [...this.connections].map(async (connection) => {
          try {
            let pending = connection.credential !== undefined ? checks.get(connection.credential) : undefined;
            if (!pending) {
              pending = connection.recheck();
              if (connection.credential !== undefined) checks.set(connection.credential, pending);
            }
            const now = await pending;
            if (!this.connections.has(connection)) return; // se cerró mientras se comprobaba
            if (now === 'revoked') return this.end(connection, 'unauthorized');
            if (now) connection.identity = now;
            this.write(connection, ': hb\n\n');
          } catch {
            this.drop(connection);
          }
        }),
      );
    } finally {
      this.beating = false;
    }
  }

  /** El servidor se para: avisa a cada canal y lo cierra (`server.close()` esperaría para siempre a conexiones que no terminan). */
  closeAll(): void {
    this.closing = true;
    for (const connection of [...this.connections]) this.end(connection, 'shutdown');
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Vuelve a aceptar canales (en las pruebas que reutilizan el concentrador). */
  reopen(): void {
    this.closing = false;
  }
}

// ───────────── la ruta ─────────────

export interface EventsApiContext {
  hub: EventHub | undefined;
  /** Sin espacio de trabajo no hay proyectos de los que avisar: 404, como el resto de `/api/projects`. */
  store: ProjectStore | undefined;
  cors: string[];
  auth?: Authenticator;
  /** El mismo `auth` pero sin anotar el contexto de la petición: los latidos vuelven a identificar sin ensuciar el registro de accesos ni las métricas. */
  recheck?: Authenticator;
  accounts?: Accounts;
  trustProxy: boolean;
  /** Avisa al registro de accesos de que esta petición es un canal que se queda abierto (no cuenta como «en curso» ni su duración como latencia); `summary` se va rellenando. */
  streaming?(req: IncomingMessage, summary: StreamSummary): void;
}

/** `GET /api/events`: ver arriba. */
export function createEventsApi(ctx: EventsApiContext): (req: IncomingMessage, res: ServerResponse, url: URL, parts: string[]) => Promise<void> {
  return async (req, res, url, parts) => {
    if (!ctx.store) throw new HttpError(404, 'Este servicio no tiene espacio de trabajo (use --workspace <carpeta>)');
    if (parts.length !== 0) throw new HttpError(404, 'Ruta de eventos desconocida: use /api/events.');
    if (req.method !== 'GET') throw new HttpError(405, 'Este endpoint solo admite GET.', { allow: 'GET' });
    if (!ctx.hub) throw new HttpError(404, 'Este servicio no ofrece el canal de eventos en directo (arrancó con --max-streams 0).');
    const identity = await ctx.auth?.identify(req);
    if (identity?.kind === 'user' && !ctx.accounts) throw new HttpError(401, 'Hace falta un token válido: envíe la cabecera «Authorization: Bearer <token>».', { code: 'unauthorized' });
    guard(req, ctx.cors, !!ctx.auth);

    const project = url.searchParams.get('project') ?? undefined;
    if (project !== undefined) {
      if (!isWorkspaceId(project)) throw new HttpError(400, `Identificador de proyecto inválido «${String(project).slice(0, 60)}».`, { code: 'invalid' });
      // Con cuentas, un proyecto al que no se pertenece no existe (404), igual que en el resto de la API.
      if (identity?.kind === 'user' && ctx.accounts && identity.siteRole !== 'admin' && !(await ctx.accounts.store.rolesOf(identity.user.id)).has(project)) {
        throw new HttpError(404, `No existe el proyecto «${project.slice(0, 60)}».`, { code: 'not-found' });
      }
    }

    const key = identity?.kind === 'user' ? `u:${identity.user.id}` : identity?.kind === 'token' ? `t:${identity.name}` : `a:${clientAddress(req, ctx.trustProxy)}`;
    if (!ctx.hub.admit(key)) {
      throw new HttpError(429, `Hay demasiados canales de eventos abiertos${ctx.hub.size >= ctx.hub.maxTotal ? ' en este servicio' : ` para esta cuenta (máximo ${ctx.hub.maxPerPerson})`}: se sigue sondeando.`, { code: 'limit' }, { 'Retry-After': '30' });
    }

    const recheck = ctx.recheck;
    const summary: StreamSummary = { events: 0, bytes: 0 };
    ctx.streaming?.(req, summary);
    ctx.hub.open({
      summary,
      key,
      res,
      identity,
      project,
      // Sin autenticación no hay nada que comprobar. Con ella, solo un 401 (credencial revocada o caducada) cierra el canal: un 429 (el freno de
      // intentos fallidos de la dirección) o un 503 (archivo de tokens ilegible) son pasajeros y no deben echar a quien ya estaba conectado.
      credential: req.headers.authorization,
      recheck: async () => {
        if (!recheck) return undefined;
        try {
          return await recheck.identify(req);
        } catch (error) {
          return error instanceof HttpError && error.status === 401 ? 'revoked' : undefined;
        }
      },
    });
  };
}
