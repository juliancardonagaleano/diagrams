import { ProjectError, type DiagramMeta, type ProjectStore, type RemoteSession } from '@iark/kernel';
import { projectErrorText } from '../i18n/errores';
import {
  backoffDelay,
  byteLength,
  DEFAULT_RETRY,
  FOREIGN_TTL_MS,
  isTransient,
  queueKey,
  type OfflineQueue,
  type PendingChange,
  type PendingProblem,
  type PendingStatus,
  type RetryPolicy,
  type UpsertResult,
} from './offlineQueue';

/**
 * El motor del trabajo sin conexión: guarda en la cola lo que no llegó al servidor y lo reenvía solo, sin pisar nada.
 *
 * - **Cuándo reintenta.** Al volver `online`, al recuperar el foco, al abrir la app (los pendientes sobreviven a cerrar la pestaña) y
 *   con una espera exponencial acotada (2 s, 4 s, 8 s… hasta 60 s, con variación aleatoria). Un 429 del servidor se respeta
 *   (`Retry-After`, o 60 s como mínimo). Sin tormentas: solo hay **un envío en curso** a la vez (los diagramas se envían de uno en uno,
 *   y si un envío falla por la red se corta la ronda: los demás fallarían igual), el foco no provoca más de un intento cada 5 s y,
 *   con varias pestañas abiertas, un cerrojo (`navigator.locks`) deja que solo una envíe.
 * - **Sin pisar.** El envío lleva `ifUpdatedAt` con la marca del servidor sobre la que se escribió. Si otra persona cambió el diagrama
 *   mientras tanto, el servidor responde `conflict` y el cambio se queda en la cola, intacto, marcado como conflicto: decide la persona.
 * - **Sin insistir con una credencial mala.** `unauthorized` y `forbidden` no se reintentan solos (cada 401 cuenta para el freno de
 *   intentos del servidor, que bloquea a toda la dirección): el cambio espera en la cola hasta que haya credenciales nuevas
 *   (`credentialsChanged`) o se abra la app con una sesión que el servidor reconozca.
 * - **Aislado por persona.** Antes de enviar nada se pregunta al servidor quién es esta credencial (`whoami`). Solo se envía lo que
 *   escribió esa misma persona en ese mismo servidor; lo de otra persona se conserva aislado (y caduca a los 30 días) y nunca se
 *   envía con una credencial que no es suya.
 */

export interface IdentityMemory {
  read(): string | undefined;
  write(value: string | undefined): void;
}

/** La última identidad conocida de ese servidor, en `localStorage` (no es secreta: un id de cuenta o el nombre de un token). Sirve para saber de quién son los pendientes sin red. */
export const identityAt = (key: string): IdentityMemory => ({
  read() {
    try {
      return window.localStorage.getItem(key) || undefined;
    } catch {
      return undefined;
    }
  },
  write(value) {
    try {
      if (value) window.localStorage.setItem(key, value);
      else window.localStorage.removeItem(key);
    } catch {
      /* sin almacenamiento: no se recuerda */
    }
  },
});

/** Quién es una credencial, con lo que el servidor cuenta de ella: `u:<id>` (cuenta de GitHub), `t:<nombre>` (token de `iark auth`) u `open` (servidor sin autenticación). */
export function ownerOf(who: RemoteSession): string {
  return who.user ? `u:${who.user.id}` : who.auth ? `t:${who.name ?? ''}` : 'open';
}

export interface SyncHost {
  /** El servidor ya rechazó la credencial en esta pestaña (la lista no se pudo leer por `unauthorized`): no se insiste. */
  credentialRejected(): boolean;
  /** Cambió algo que la interfaz muestra (`snapshot`). */
  changed(): void;
  /** Un cambio llegó al servidor. */
  sent(change: PendingChange, meta: DiagramMeta): void;
  /** Un cambio quedó en conflicto (el servidor cambió, el diagrama ya no existe o no lo acepta). */
  conflicted(change: PendingChange): void;
  /** El servidor no acepta la credencial (`unauthorized`) o su rol no alcanza (`forbidden`); `change` es el que lo descubrió, si fue un envío. */
  authRequired(error: ProjectError, change?: PendingChange): void;
}

/** Un cambio pendiente tal como lo ve la interfaz (sin el texto). */
export interface PendingView {
  key: string;
  projectId: string;
  diagramId: string;
  name: string;
  status: PendingStatus;
  problem?: PendingProblem;
  reason?: string;
  updatedAt: number;
  bytes: number;
}

export interface OfflineSnapshot {
  /** `false` si no hay almacenamiento duradero (ventana privada…): los pendientes solo sobreviven mientras la pestaña siga abierta. */
  durable: boolean;
  /** Cambios míos que esperan a poder enviarse (red, servidor). */
  waiting: number;
  /** Cambios míos que esperan credenciales nuevas. */
  authBlocked: number;
  /** Cambios míos en conflicto: decide la persona. */
  conflicts: number;
  /** Cambios de otra persona (o de este servidor con otra cuenta) guardados en este navegador y que no se enviarán con esta credencial. */
  foreign: number;
  /** Hay un envío en curso. */
  retrying: boolean;
  /** Cuándo toca el próximo reintento automático (ms desde 1970), si hay uno programado. */
  nextRetryAt?: number;
  /** Texto del aviso si el último cambio no cupo en la cola (tope superado o sin almacenamiento). */
  full?: string;
  entries: PendingView[];
}

export interface LockManagerLike {
  request(name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<void>): Promise<unknown>;
}

export interface SyncOptions {
  policy?: Partial<RetryPolicy>;
  now?: () => number;
  /** Dónde se recuerda quién fue la última persona que entró en este servidor. */
  identity?: IdentityMemory;
  /** El cerrojo entre pestañas; `false` lo desactiva (las pruebas). */
  locks?: LockManagerLike | false;
}

export type KickReason = 'start' | 'online' | 'focus' | 'edit' | 'timer' | 'manual' | 'credentials';

export interface ParkInput {
  projectId: string;
  diagramId: string;
  name: string;
  module?: string;
  text: string;
  /** La marca `updatedAt` del servidor sobre la que se escribió este texto. */
  baseUpdatedAt: string;
}

type SendResult = 'next' | 'stop';

export class OfflineSync {
  readonly ready: Promise<void>;
  private readonly policy: RetryPolicy;
  private readonly now: () => number;
  private readonly memory: IdentityMemory | undefined;
  private readonly lockManager: LockManagerLike | undefined;
  /** Quién es la credencial actual, comprobado con el servidor en esta pestaña. */
  private identity: string | undefined;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextRetryAt: number | undefined;
  private draining = false;
  private again = false;
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  /** El servidor rechazó la credencial en esta pestaña: no se envía nada más hasta que haya credenciales nuevas. */
  private authWait = false;
  /** Lo que esperaba credenciales se vuelve a probar una sola vez al abrir la app (y al dar credenciales nuevas), no con cada foco. */
  private authProbe = true;
  private fullMessage: string | undefined;
  private disposed = false;
  /** Hasta cuándo el servidor pidió esperar (429). */
  private holdUntil = Number.NEGATIVE_INFINITY;
  /** Cambios guardados en esta pestaña antes de saber de quién es la credencial; pasan a ser de esa persona al saberlo. */
  private readonly unverified = new Set<string>();
  /** Todo lo que se guardó en la cola desde esta pestaña (y no viene de otra vez): lo escribió quien tiene la pestaña delante. */
  private readonly written = new Set<string>();
  /** Lo escrito en esta pestaña que pasa a ser de quien dé credenciales nuevas (ver `credentialsChanged`). */
  private carry = new Set<string>();
  private verifying: Promise<string> | undefined;

  constructor(
    readonly queue: OfflineQueue,
    private readonly host: SyncHost,
    private readonly store: ProjectStore,
    readonly server: string,
    options: SyncOptions = {},
  ) {
    this.policy = { ...DEFAULT_RETRY, ...options.policy };
    this.now = options.now ?? Date.now;
    this.memory = options.identity;
    const locks = options.locks === undefined ? (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks : options.locks || undefined;
    this.lockManager = locks;
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    try {
      await this.queue.load();
    } catch {
      /* sin lectura del almacenamiento: se trabaja con lo que llegue en esta pestaña */
    }
    await this.purgeStale();
    this.host.changed();
  }

  /** Lo que dejó otra persona (o se guardó para otro servidor) y lleva un mes sin tocarse se borra: no se guarda para siempre en un equipo. */
  private async purgeStale(): Promise<void> {
    const stale = this.queue.all().filter((change) => !this.isMine(change) && this.now() - change.updatedAt > FOREIGN_TTL_MS);
    await this.queue.remove(stale.map((change) => change.key));
  }

  // ───────────── de quién es qué ─────────────

  private get me(): string | undefined {
    return this.identity ?? this.memory?.read();
  }

  /**
   * ¿Es de esta persona y de este servidor? Sin saber aún quién es la credencial, lo de este servidor se da por suyo (no se enviará nada hasta
   * comprobarlo). Lo escrito sin saber de quién era (`?`) solo es de quien lo escribió en esta misma pestaña: si la pestaña se cerró antes de
   * saberlo, nadie lo reclama (otra persona no puede quedárselo) y caduca como lo ajeno.
   */
  private isMine(change: PendingChange): boolean {
    if (change.server !== this.server) return false;
    if (change.owner === '?') return this.unverified.has(change.key);
    return this.me === undefined || change.owner === this.me;
  }

  private mine(): PendingChange[] {
    return this.queue.all().filter((change) => this.isMine(change));
  }

  /** El cambio pendiente de esta persona para ese diagrama, si hay. */
  find(projectId: string, diagramId: string): PendingChange | undefined {
    return this.mine().find((change) => change.projectId === projectId && change.diagramId === diagramId);
  }

  get snapshot(): OfflineSnapshot {
    const mine = this.mine();
    return {
      durable: this.queue.durable,
      waiting: mine.filter((change) => change.status === 'retry').length,
      authBlocked: mine.filter((change) => change.status === 'auth').length,
      conflicts: mine.filter((change) => change.status === 'conflict').length,
      foreign: this.queue.all().filter((change) => change.server === this.server && !this.isMine(change)).length,
      retrying: this.draining,
      ...(this.nextRetryAt !== undefined ? { nextRetryAt: this.nextRetryAt } : {}),
      ...(this.fullMessage ? { full: this.fullMessage } : {}),
      entries: mine
        .map((change) => ({
          key: change.key,
          projectId: change.projectId,
          diagramId: change.diagramId,
          name: change.name,
          status: change.status,
          ...(change.problem ? { problem: change.problem } : {}),
          ...(change.reason ? { reason: change.reason } : {}),
          updatedAt: change.updatedAt,
          bytes: change.bytes,
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    };
  }

  // ───────────── guardar en la cola ─────────────

  /**
   * Guarda el último estado de ese diagrama. `status: 'keep'` conserva el estado del cambio que ya hubiera (para anotar lo que la
   * persona sigue escribiendo mientras espera) y, si no lo había, lo deja en `retry`.
   */
  async park(input: ParkInput, status: PendingStatus | 'keep', detail: { problem?: PendingProblem; reason?: string } = {}): Promise<UpsertResult> {
    await this.ready;
    const existing = this.find(input.projectId, input.diagramId);
    const owner = existing?.owner ?? this.me ?? '?';
    const now = this.now();
    const next: PendingChange = {
      key: existing?.key ?? queueKey(this.server, owner, input.projectId, input.diagramId),
      server: this.server,
      owner,
      projectId: input.projectId,
      diagramId: input.diagramId,
      name: input.name,
      ...(input.module ? { module: input.module } : {}),
      text: input.text,
      baseUpdatedAt: existing?.baseUpdatedAt ?? input.baseUpdatedAt,
      status: status === 'keep' ? (existing?.status ?? 'retry') : status,
      ...(status === 'keep' ? (existing?.problem ? { problem: existing.problem } : {}) : detail.problem ? { problem: detail.problem } : {}),
      ...(status === 'keep' ? (existing?.reason ? { reason: existing.reason } : {}) : detail.reason ? { reason: detail.reason } : {}),
      rev: (existing?.rev ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      bytes: byteLength(input.text),
    };
    const result = await this.queue.upsert(next);
    if (result.ok) this.written.add(next.key);
    if (result.ok && owner === '?') this.unverified.add(next.key);
    this.fullMessage = result.ok ? undefined : result.message;
    this.host.changed();
    return result;
  }

  /** Cambia el estado de un cambio ya guardado (conflicto resuelto, credenciales nuevas…). */
  async patch(key: string, patch: Parameters<OfflineQueue['patch']>[1]): Promise<PendingChange | undefined> {
    await this.ready;
    const next = await this.queue.patch(key, patch);
    this.host.changed();
    return next;
  }

  /** Quita de la cola el cambio de ese diagrama (el diagrama se borró o la persona descartó lo suyo). */
  async drop(projectId: string, diagramId?: string): Promise<void> {
    await this.ready;
    await this.queue.remove(this.mine().filter((change) => change.projectId === projectId && (diagramId === undefined || change.diagramId === diagramId)).map((change) => change.key));
    this.fullMessage = undefined;
    this.host.changed();
  }

  async dropKey(key: string): Promise<void> {
    await this.ready;
    await this.queue.remove([key]);
    this.fullMessage = undefined;
    this.host.changed();
  }

  /** Descarta todo lo de esta persona en este servidor (al cerrar sesión con confirmación). */
  async discardMine(): Promise<void> {
    await this.ready;
    await this.queue.remove(this.mine().map((change) => change.key));
    this.fullMessage = undefined;
    this.host.changed();
  }

  /** Descarta lo que dejaron otras personas en este servidor. */
  async discardForeign(): Promise<void> {
    await this.ready;
    await this.queue.remove(this.queue.all().filter((change) => change.server === this.server && !this.isMine(change)).map((change) => change.key));
    this.host.changed();
  }

  // ───────────── reintentos ─────────────

  /** Un envío falló por algo que se arregla esperando: la próxima ronda se programa con la espera exponencial (o la que pidió el servidor). */
  noteFailure(error: ProjectError): void {
    this.failures += 1;
    let delay = backoffDelay(this.failures, this.policy);
    const limited = error.info.status === 429;
    if (limited) delay = Math.max(delay, this.policy.rateLimitMs);
    if (error.info.retryAfterSec) delay = Math.max(delay, error.info.retryAfterSec * 1000);
    // El freno del servidor no se salta ni con `online` ni con el foco: hasta que pase lo que pidió, solo «Reintentar ahora» (una decisión de la persona) lo intenta.
    if (limited || error.info.retryAfterSec) this.holdUntil = this.now() + delay;
    this.schedule(delay);
  }

  private schedule(delay: number): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.nextRetryAt = this.now() + delay;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.nextRetryAt = undefined;
      void this.kick('timer');
    }, delay);
    this.host.changed();
  }

  private clearSchedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.nextRetryAt = undefined;
  }

  /** Pide una ronda de envío. Si ya hay una, se junta con ella; si no hay nada que enviar, no hace nada. */
  async kick(reason: KickReason): Promise<void> {
    if (this.disposed) return;
    await this.ready;
    if (this.disposed) return;
    // El foco puede cambiar muchas veces seguidas (y la persona sigue escribiendo): ninguno de los dos provoca un intento si hubo otro hace nada.
    if (reason !== 'manual' && this.now() < this.holdUntil) return;
    if ((reason === 'focus' || reason === 'edit') && this.now() - this.lastAttemptAt < this.policy.focusGapMs) return;
    if (this.draining) {
      this.again = true;
      return;
    }
    this.draining = true;
    this.host.changed();
    try {
      do {
        this.again = false;
        await this.locked();
      } while (this.again && !this.disposed);
    } finally {
      this.draining = false;
      this.host.changed();
    }
  }

  private async locked(): Promise<void> {
    if (!this.lockManager) return this.round();
    let ran = false;
    try {
      await this.lockManager.request(`iark-offline:${this.server}`, { ifAvailable: true }, async (lock) => {
        if (!lock) return;
        ran = true;
        await this.round();
      });
    } catch {
      if (!ran) return this.round();
    }
    // Otra pestaña está enviando: se vuelve a mirar pronto por si quedó algo.
    if (!ran) this.schedule(this.policy.baseMs);
  }

  /** Quién es la credencial actual (una petición `whoami`, una vez por credencial; las llamadas a la vez comparten la misma petición). */
  private verify(): Promise<string> {
    if (this.identity) return Promise.resolve(this.identity);
    this.verifying ??= (async () => {
      try {
        const store = this.store as { whoami?: () => Promise<RemoteSession> };
        const owner = store.whoami ? ownerOf(await store.whoami()) : 'open';
        this.identity = owner;
        this.memory?.write(owner);
        return owner;
      } finally {
        this.verifying = undefined;
      }
    })();
    return this.verifying;
  }

  /** Lo escrito en esta pestaña antes de saber quién era la credencial pasa a ser de esa persona. */
  private async adopt(owner: string): Promise<void> {
    const mine = (c: PendingChange): boolean => c.server === this.server && c.owner !== owner && (this.carry.has(c.key) || (c.owner === '?' && this.unverified.has(c.key)));
    for (const change of this.queue.all().filter(mine)) {
      this.unverified.delete(change.key);
      this.carry.delete(change.key);
      this.written.delete(change.key);
      const key = queueKey(this.server, owner, change.projectId, change.diagramId);
      await this.queue.rekey(change.key, { ...change, owner, key });
      if (this.queue.get(key)) this.written.add(key);
    }
    this.carry.clear();
    await this.purgeStale();
    this.host.changed();
  }

  /**
   * Averigua en segundo plano quién es la credencial (una petición `whoami`), para que lo que se guarde en la cola ya lleve el nombre de su
   * dueña. Nunca lanza: si no se puede (sin red, credencial mala) se reintenta en la siguiente ronda.
   */
  async verifyQuiet(): Promise<void> {
    await this.ready;
    if (this.disposed || this.identity || this.authWait || this.host.credentialRejected()) return;
    try {
      await this.adopt(await this.verify());
    } catch (error) {
      if (error instanceof ProjectError && error.code === 'unauthorized') {
        this.authWait = true;
        this.host.authRequired(error);
      }
    }
  }

  /** Una ronda: comprueba quién es la credencial y envía, de uno en uno, lo que esta persona dejó pendiente. */
  private async round(): Promise<void> {
    this.lastAttemptAt = this.now();
    try {
      await this.queue.load();
    } catch {
      /* se sigue con lo que hay en memoria */
    }
    const candidates = (): PendingChange[] => this.mine().filter((change) => change.status === 'retry' || (change.status === 'auth' && this.authProbe));
    if (this.authWait || !candidates().length || this.host.credentialRejected()) return;
    try {
      const owner = await this.verify();
      await this.adopt(owner);
    } catch (error) {
      if (error instanceof ProjectError && error.code === 'unauthorized') {
        this.authWait = true;
        this.host.authRequired(error);
      } else this.noteFailure(isTransient(error) ? error : new ProjectError('unavailable', (error as Error)?.message ?? 'No se pudo comprobar la sesión.', (error as Error)?.message ? { network: true } : { network: true, reason: 'offline-check-failed' }));
      return;
    }
    const todo = candidates();
    this.authProbe = false;
    for (const change of todo) {
      if (this.disposed) return;
      if ((await this.send(change)) === 'stop') return;
    }
  }

  private async send(change: PendingChange): Promise<SendResult> {
    let meta: DiagramMeta;
    try {
      meta = await this.store.saveDiagram(change.projectId, { id: change.diagramId, text: change.text, ifUpdatedAt: change.baseUpdatedAt });
    } catch (error) {
      if (isTransient(error)) {
        this.noteFailure(error);
        return 'stop';
      }
      if (error instanceof ProjectError) {
        if (error.code === 'unauthorized' || error.code === 'forbidden') {
          const parked = (await this.queue.patch(change.key, { status: 'auth', reason: projectErrorText(error) })) ?? change;
          if (error.code === 'unauthorized') this.authWait = true;
          this.host.authRequired(error, parked);
          return error.code === 'unauthorized' ? 'stop' : 'next';
        }
        const problem: PendingProblem = error.code === 'conflict' ? 'changed' : error.code === 'not-found' ? 'gone' : 'rejected';
        const parked = (await this.queue.patch(change.key, { status: 'conflict', problem, reason: projectErrorText(error) })) ?? change;
        this.host.conflicted(parked);
        return 'next';
      }
      this.noteFailure(new ProjectError('unavailable', (error as Error)?.message ?? 'No se pudo enviar.', (error as Error)?.message ? { network: true } : { network: true, reason: 'offline-send-failed' }));
      return 'stop';
    }
    this.failures = 0;
    this.holdUntil = Number.NEGATIVE_INFINITY;
    this.clearSchedule();
    // Si mientras se enviaba la persona siguió escribiendo, lo nuevo se queda (sobre la marca nueva del servidor) y se envía en la siguiente vuelta.
    const current = this.queue.get(change.key);
    if (current && current.rev === change.rev) await this.queue.remove([change.key]);
    else if (current) {
      await this.queue.patch(change.key, { baseUpdatedAt: meta.updatedAt, status: 'retry' });
      this.again = true;
    }
    this.host.sent(change, meta);
    return 'next';
  }

  /** Hay credenciales nuevas (otro token, otra sesión): se vuelve a preguntar quién es y se retoma lo que esperaba. */
  async credentialsChanged(): Promise<void> {
    await this.ready;
    this.authWait = false;
    this.authProbe = true;
    this.identity = undefined;
    // Quien tiene la pestaña delante escribió lo que hay en ella y ahora da otra credencial para que se guarde (un token con rol de editor, por ejemplo):
    // eso sí pasa a la credencial nueva. Lo que viene de otra vez (otra pestaña, otra sesión, otra persona) se queda con su dueña.
    this.carry = new Set(this.written);
    this.memory?.write(undefined);
    this.failures = 0;
    for (const change of this.mine().filter((c) => c.status === 'auth')) await this.queue.patch(change.key, { status: 'retry', reason: undefined });
    this.host.changed();
    await this.kick('credentials');
    void this.verifyQuiet();
  }

  /** Un guardado directo del servidor respondió `unauthorized`: no se insiste con esa credencial. */
  noteAuth(error: ProjectError): void {
    if (error.code === 'unauthorized') this.authWait = true;
    this.authProbe = false;
  }

  /** ¿Se dejó de enviar porque el servidor no acepta la credencial? */
  get blocked(): boolean {
    return this.authWait;
  }

  dispose(): void {
    this.disposed = true;
    this.clearSchedule();
  }
}
