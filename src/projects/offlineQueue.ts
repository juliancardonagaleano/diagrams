import { ProjectError } from '@iark/kernel';

/**
 * Cola de cambios pendientes para el trabajo en la nube sin conexión.
 *
 * Cuando un guardado en un servidor no llega (la red cae, el servidor no responde, el navegador está sin conexión) el cambio no se
 * pierde ni depende de que la pestaña siga abierta: se guarda aquí, en este navegador (IndexedDB), y se reenvía solo cuando se
 * puede. Reglas:
 *
 * - **Solo el último estado de cada diagrama.** La clave es servidor + persona + proyecto + diagrama: guardar otra vez el mismo
 *   diagrama sustituye el texto anterior, no se apila una cola infinita.
 * - **Con tope.** El total de texto guardado y el número de diagramas tienen un máximo (`DEFAULT_LIMITS`). Si un cambio no cabe, no se
 *   guarda a medias: `upsert` lo dice (`full`) y quien llama avisa a la persona.
 * - **Nunca el token.** Un cambio lleva el contenido del diagrama y metadatos (ids, nombre, marca `updatedAt` del servidor). La
 *   credencial no se escribe aquí: la persona se identifica por su identidad (`u:<id>` en una cuenta de GitHub, `t:<nombre>` con un
 *   token de `iark auth`, `open` en un servidor sin autenticación), que da el propio servidor.
 * - **Aislado por persona y servidor.** Lo que escribió otra persona (u otro servidor) se conserva pero no se reenvía nunca con otra
 *   credencial; ver `OfflineSync`.
 */

/** En qué situación está un cambio guardado: `retry` espera a poder enviarse; `auth`, a que haya credenciales buenas; `conflict`, a que la persona decida. */
export type PendingStatus = 'retry' | 'auth' | 'conflict';

/** Por qué un cambio está en conflicto: el servidor cambió (`changed`), el diagrama ya no existe (`gone`) o el servidor no lo acepta (`rejected`). */
export type PendingProblem = 'changed' | 'gone' | 'rejected';

export interface PendingChange {
  /** `queueKey(server, owner, projectId, diagramId)`. */
  key: string;
  /** Dirección del servidor, ya normalizada. */
  server: string;
  /** Quién lo escribió (ver `ownerOf`); `?` si aún no se sabía (se resuelve al hablar con el servidor). */
  owner: string;
  projectId: string;
  diagramId: string;
  /** Nombre del diagrama al guardar el cambio (para los avisos y para nombrar la copia). */
  name: string;
  module?: string;
  /** El documento tal como lo dejó la persona. */
  text: string;
  /** La marca `updatedAt` del servidor sobre la que se escribió: el reenvío usa `ifUpdatedAt` con ella y así nunca pisa un cambio ajeno. */
  baseUpdatedAt: string;
  status: PendingStatus;
  problem?: PendingProblem;
  /** El último mensaje de error del servidor, si lo hubo. */
  reason?: string;
  /** Sube con cada texto nuevo: quien envía sabe si, mientras tanto, la persona siguió escribiendo. */
  rev: number;
  createdAt: number;
  updatedAt: number;
  /** Tamaño del texto en bytes (UTF-8). */
  bytes: number;
}

export interface QueueLimits {
  /** Total de texto guardado, en bytes. */
  maxBytes: number;
  /** Cuántos diagramas distintos. */
  maxEntries: number;
}

/** 8 MiB y 100 diagramas: sobra para trabajar un rato sin red y deja margen en la cuota de IndexedDB. Cada documento ya está limitado a 5 MB por el servidor. */
export const DEFAULT_LIMITS: QueueLimits = { maxBytes: 8 * 1024 * 1024, maxEntries: 100 };

/** Lo que otra persona o servidor dejó sin enviar se borra si lleva tanto sin tocarse (el de la persona actual no caduca nunca). */
export const FOREIGN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const queueKey = (server: string, owner: string, projectId: string, diagramId: string): string => JSON.stringify([server, owner, projectId, diagramId]);

const encoder = new TextEncoder();
export const byteLength = (text: string): number => encoder.encode(text).length;

// ───────────── reintentos ─────────────

export interface RetryPolicy {
  /** Primera espera tras un fallo. */
  baseMs: number;
  /** La espera no crece más allá de esto. */
  maxMs: number;
  /** Variación aleatoria (±) para que varias pestañas o personas no reintenten a la vez. */
  jitter: number;
  /** Entre dos reintentos provocados por recuperar el foco debe pasar al menos esto (el foco puede cambiar muchas veces seguidas). */
  focusGapMs: number;
  /** Mínimo de espera tras un 429 del servidor, si no dijo cuánto. */
  rateLimitMs: number;
  random(): number;
}

export const DEFAULT_RETRY: RetryPolicy = { baseMs: 2000, maxMs: 60_000, jitter: 0.2, focusGapMs: 5000, rateLimitMs: 60_000, random: Math.random };

/** Espera exponencial acotada: `baseMs`, el doble, el doble… hasta `maxMs`. `failures` cuenta los fallos seguidos (1 = el primero). */
export function backoffDelay(failures: number, policy: RetryPolicy = DEFAULT_RETRY): number {
  const raw = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, failures - 1));
  const spread = 1 + policy.jitter * (2 * policy.random() - 1);
  return Math.max(0, Math.min(policy.maxMs, Math.round(raw * spread)));
}

/**
 * ¿Es un fallo que puede arreglarse solo, esperando? Sin respuesta (red, tiempo agotado), un servidor caído o saturado (5xx), un proxy
 * que contesta otra cosa (un portal cautivo) y el freno de intentos (429). Un 404 (el servidor no ofrece proyectos), un contenido
 * inválido o una credencial que no vale no se arreglan esperando.
 */
export function isTransient(error: unknown): error is ProjectError {
  if (!(error instanceof ProjectError) || error.code !== 'unavailable') return false;
  const { network, status } = error.info;
  return network === true || status === undefined || status === 429 || status >= 500 || (status >= 200 && status < 300);
}

// ───────────── almacenamiento ─────────────

export class QueueStorageError extends Error {
  constructor(
    readonly kind: 'full' | 'storage',
    message: string,
  ) {
    super(message);
    this.name = 'QueueStorageError';
  }
}

/** Dónde se guarda la cola. `durable: false` es solo memoria (sobrevive a un corte de red pero no a cerrar la pestaña). */
export interface QueueBackend {
  readonly durable: boolean;
  list(): Promise<PendingChange[]>;
  put(change: PendingChange): Promise<void>;
  delete(keys: string[]): Promise<void>;
}

export class MemoryQueueBackend implements QueueBackend {
  readonly durable = false;
  private readonly rows = new Map<string, PendingChange>();
  async list(): Promise<PendingChange[]> {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }
  async put(change: PendingChange): Promise<void> {
    this.rows.set(change.key, { ...change });
  }
  async delete(keys: string[]): Promise<void> {
    for (const key of keys) this.rows.delete(key);
  }
}

const DB_NAME = 'iark-offline';
const STORE = 'pending';

const request = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
const finished = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException('Transacción cancelada', 'AbortError'));
  });

function storageError(error: unknown): QueueStorageError {
  if (error instanceof QueueStorageError) return error;
  const name = (error as { name?: string } | null)?.name;
  if (name === 'QuotaExceededError') return new QueueStorageError('storage', 'El navegador no tiene espacio para guardar más cambios sin conexión.');
  return new QueueStorageError('storage', 'El navegador no deja guardar cambios sin conexión (¿ventana privada o permisos bloqueados?).');
}

/** La cola en IndexedDB: una base propia (`iark-offline`) con un almacén de objetos por clave. */
export class IdbQueueBackend implements QueueBackend {
  readonly durable = true;
  private db: Promise<IDBDatabase> | undefined;

  constructor(
    private readonly factory: IDBFactory | null = globalThis.indexedDB ?? null,
    private readonly dbName = DB_NAME,
  ) {}

  private open(): Promise<IDBDatabase> {
    if (!this.factory) return Promise.reject(new QueueStorageError('storage', 'Este navegador no ofrece IndexedDB: los cambios sin conexión solo se conservan mientras la pestaña siga abierta.'));
    this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      let opening: IDBOpenDBRequest;
      try {
        opening = this.factory!.open(this.dbName, 1);
      } catch (error) {
        reject(storageError(error));
        return;
      }
      opening.onupgradeneeded = () => opening.result.createObjectStore(STORE, { keyPath: 'key' });
      opening.onsuccess = () => {
        const db = opening.result;
        db.onversionchange = () => {
          db.close();
          this.db = undefined;
        };
        resolve(db);
      };
      opening.onerror = () => reject(storageError(opening.error));
      opening.onblocked = () => reject(storageError(undefined));
    }).catch((error) => {
      this.db = undefined;
      throw error;
    });
    return this.db;
  }

  async list(): Promise<PendingChange[]> {
    try {
      const db = await this.open();
      return (await request(db.transaction(STORE, 'readonly').objectStore(STORE).getAll())) as PendingChange[];
    } catch (error) {
      throw storageError(error);
    }
  }

  async put(change: PendingChange): Promise<void> {
    try {
      const db = await this.open();
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(change);
      await finished(tx);
    } catch (error) {
      throw storageError(error);
    }
  }

  async delete(keys: string[]): Promise<void> {
    if (!keys.length) return;
    try {
      const db = await this.open();
      const tx = db.transaction(STORE, 'readwrite');
      for (const key of keys) tx.objectStore(STORE).delete(key);
      await finished(tx);
    } catch (error) {
      throw storageError(error);
    }
  }

  close(): void {
    void this.db?.then((db) => db.close()).catch(() => undefined);
    this.db = undefined;
  }
}

/** La cola que se usa cuando no se dice otra: IndexedDB si el navegador la ofrece y, si no, memoria. */
export function defaultQueueBackend(): QueueBackend {
  return typeof indexedDB !== 'undefined' && indexedDB ? new IdbQueueBackend() : new MemoryQueueBackend();
}

export type UpsertResult = { ok: true } | { ok: false; reason: 'full' | 'storage'; message: string };

export const FULL_MESSAGE = (limits: QueueLimits): string =>
  `Se superó el tope de cambios sin conexión que guarda este navegador (${Math.round(limits.maxBytes / (1024 * 1024))} MB o ${limits.maxEntries} diagramas). Lo último que escribiste solo está en esta pestaña: no la cierres hasta recuperar la conexión, o descarga el diagrama.`;

/**
 * La cola en sí: un espejo en memoria (para preguntar sin esperar) que se escribe en el almacenamiento. `load` lo releva desde el
 * almacenamiento (otra pestaña pudo cambiarlo). Una escritura que falla no cambia el espejo.
 */
export class OfflineQueue {
  private rows = new Map<string, PendingChange>();

  constructor(
    readonly backend: QueueBackend = defaultQueueBackend(),
    readonly limits: QueueLimits = DEFAULT_LIMITS,
  ) {}

  get durable(): boolean {
    return this.backend.durable;
  }

  async load(): Promise<void> {
    this.rows = new Map((await this.backend.list()).map((row) => [row.key, row]));
  }

  all(): PendingChange[] {
    return [...this.rows.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(key: string): PendingChange | undefined {
    return this.rows.get(key);
  }

  get totalBytes(): number {
    let total = 0;
    for (const row of this.rows.values()) total += row.bytes;
    return total;
  }

  /** Guarda (o sustituye) el cambio de ese diagrama si cabe en el tope. */
  async upsert(change: PendingChange): Promise<UpsertResult> {
    const previous = this.rows.get(change.key);
    const total = this.totalBytes - (previous?.bytes ?? 0) + change.bytes;
    const count = this.rows.size + (previous ? 0 : 1);
    if (total > this.limits.maxBytes || count > this.limits.maxEntries) return { ok: false, reason: 'full', message: FULL_MESSAGE(this.limits) };
    try {
      await this.backend.put(change);
    } catch (error) {
      const failure = storageError(error);
      return { ok: false, reason: failure.kind === 'full' ? 'full' : 'storage', message: failure.message };
    }
    this.rows.set(change.key, change);
    return { ok: true };
  }

  /** Cambia el estado de un cambio ya guardado, sin tocar su texto. */
  async patch(key: string, patch: Partial<Pick<PendingChange, 'status' | 'problem' | 'reason' | 'baseUpdatedAt' | 'name'>>): Promise<PendingChange | undefined> {
    const current = this.rows.get(key);
    if (!current) return undefined;
    const next: PendingChange = { ...current, ...patch, updatedAt: Date.now() };
    for (const field of ['problem', 'reason'] as const) if (field in patch && patch[field] === undefined) delete next[field];
    try {
      await this.backend.put(next);
    } catch {
      return current;
    }
    this.rows.set(key, next);
    return next;
  }

  async remove(keys: string[]): Promise<void> {
    const present = keys.filter((key) => this.rows.has(key));
    if (!present.length) return;
    try {
      await this.backend.delete(present);
    } catch {
      /* si no se pudo borrar, el espejo tampoco cambia: se reintentará al relevar */
      return;
    }
    for (const key of present) this.rows.delete(key);
  }

  /** Cambia la clave de un cambio (cuando se sabe de quién era): borra la antigua y guarda la nueva. */
  async rekey(from: string, to: PendingChange): Promise<void> {
    const existing = this.rows.get(to.key);
    if (existing && existing.updatedAt > to.updatedAt) {
      await this.remove([from]);
      return;
    }
    if ((await this.upsert(to)).ok) await this.remove([from]);
  }
}
