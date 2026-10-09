import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { ComputeExecutor, ComputeJob, ComputeOutcome, ComputeReply, ComputeRequest, ComputeRunOptions, ComputeStats } from './compute';

/**
 * Pool de hilos de trabajo (`worker_threads`) para las operaciones de cálculo de `iark serve` (ver `compute.ts`). Tres garantías
 * que antes no había, porque ELK y el análisis de un documento de 5 MB corrían en el hilo que atiende las conexiones y un
 * anónimo podía bloquear el inicio de sesión, los proyectos y el healthcheck:
 *
 *  - El hilo principal no calcula: reparte los trabajos entre `size` hilos (se crean al hacer falta y se reutilizan).
 *  - Tiempo límite por operación (`timeoutMs`): al agotarse se termina el hilo (sea cual sea el bucle en el que esté), se responde
 *    503 y el siguiente trabajo arranca en uno nuevo.
 *  - Cola acotada (`maxQueue`): cuando todos los hilos están ocupados y la cola está llena, 503 con `Retry-After` al instante,
 *    sin acumular peticiones (ni sus cuerpos de hasta 5 MB) en memoria.
 *
 * Un hilo que se cae (error no capturado, memoria agotada) se sustituye igual: la operación que llevaba responde un error y el
 * servicio sigue. El pool no cierra nada por su cuenta: quien lo crea llama a `close()` al parar el servicio.
 *
 * Cada hilo construye su propio registro de módulos (`createDefaultRegistry`, ver `computeWorker.ts`): el pool sirve a un servidor
 * con los módulos por omisión de la suite.
 */

export const DEFAULT_COMPUTE_TIMEOUT_MS = 30_000;
export const DEFAULT_COMPUTE_QUEUE = 16;
const DEFAULT_RETRY_AFTER_SECONDS = 5;

/** Hilos por omisión: dos como mucho y siempre uno menos que las CPU, para que el hilo principal tenga la suya; al menos uno. */
export function defaultWorkerCount(cpus: number = availableParallelism()): number {
  return Math.max(1, Math.min(2, cpus - 1));
}

/**
 * El archivo del hilo de trabajo. Empaquetado (`dist/cli/index.js`), es `compute-worker.js` a su lado (tsup lo construye como entrada
 * propia). Desde el código fuente (`tsx src/cli/index.ts`), es `computeWorker.ts`: ver `newWorker`.
 */
export function defaultWorkerFile(): URL {
  return new URL(import.meta.url.endsWith('.ts') ? './computeWorker.ts' : './compute-worker.js', import.meta.url);
}

/**
 * Crea el hilo. Un archivo `.ts` (desarrollo con `tsx src/cli/index.ts`) no lo carga Node tal cual en un hilo: tsx solo se registra en el
 * hilo principal (y el soporte de TypeScript de Node no resuelve los imports sin extensión del código), así que el hilo arranca con un
 * pequeño guion que registra tsx y luego importa el archivo. Empaquetado (`.js`) no hay nada de eso: es un hilo de Node sin más.
 */
function newWorker(file: string | URL): Worker {
  const href = typeof file === 'string' ? pathToFileURL(file).href : file.href;
  if (!/\.[cm]?ts$/.test(new URL(href).pathname)) return new Worker(file);
  const tsx = import.meta.resolve('tsx/esm/api');
  return new Worker(`import(${JSON.stringify(tsx)}).then(({ register }) => { register(); return import(${JSON.stringify(href)}); })`, { eval: true });
}

export interface ComputePoolOptions {
  /** Hilos como máximo a la vez. Por omisión, `defaultWorkerCount()`. */
  size?: number;
  /** Tiempo máximo (ms) que una operación puede estar ejecutándose, desde que se entrega a un hilo (no cuenta la espera en cola). Por omisión 30 s. */
  timeoutMs?: number;
  /** Operaciones que esperan un hilo libre. Con la cola llena, la siguiente se rechaza con 503. Por omisión 16; con 0 no se hace cola. */
  maxQueue?: number;
  /** Los segundos que se anuncian en `Retry-After` al rechazar por cola llena. Por omisión 5. */
  retryAfterSeconds?: number;
  /** El archivo del hilo (ver `defaultWorkerFile`); las pruebas lo cambian por uno que se cuelga a propósito. */
  workerFile?: string | URL;
}

interface Task {
  id: number;
  job: ComputeJob;
  resolve(outcome: ComputeOutcome): void;
  timer?: NodeJS.Timeout;
  detach?: () => void;
}

interface Slot {
  worker: Worker;
  task?: Task;
  /** Ya no forma parte del pool (se terminó, se cayó o el pool se cerró): sus eventos se ignoran. */
  retired: boolean;
}

const unavailable = (message: string, code: string, headers?: Record<string, string>): ComputeOutcome => ({ kind: 'http', status: 503, message, extra: { code }, ...(headers ? { headers } : {}) });

export class ComputePool implements ComputeExecutor {
  readonly size: number;
  readonly timeoutMs: number;
  readonly maxQueue: number;
  private readonly retryAfterSeconds: number;
  private readonly workerFile: string | URL;
  private readonly slots = new Set<Slot>();
  private readonly idle: Slot[] = [];
  private readonly queue: Task[] = [];
  private sequence = 0;
  private closed = false;
  private completed = 0;
  private timeouts = 0;
  private rejected = 0;
  private crashes = 0;
  /** Hilos que se cayeron seguidos sin que ninguno llegara a contestar una operación (un hilo roto: archivo que falta, memoria, paquete dañado). */
  private crashesInARow = 0;

  constructor(options: ComputePoolOptions = {}) {
    // Un valor que no es un número (NaN, Infinity) se toma como no indicado: un tope que no topa es peor que el de por omisión.
    const finite = (value: number | undefined, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
    this.size = Math.max(1, Math.floor(finite(options.size, defaultWorkerCount())));
    this.timeoutMs = Math.max(1, finite(options.timeoutMs, DEFAULT_COMPUTE_TIMEOUT_MS));
    this.maxQueue = Math.max(0, Math.floor(finite(options.maxQueue, DEFAULT_COMPUTE_QUEUE)));
    this.retryAfterSeconds = Math.max(1, Math.ceil(finite(options.retryAfterSeconds, DEFAULT_RETRY_AFTER_SECONDS)));
    this.workerFile = options.workerFile ?? defaultWorkerFile();
  }

  /** Hilos creados ahora mismo (ocupados o libres). */
  get workers(): number {
    return this.slots.size;
  }

  /** Operaciones en curso ahora mismo (hilos con un trabajo entre manos). */
  get active(): number {
    let busy = 0;
    for (const slot of this.slots) if (slot.task) busy += 1;
    return busy;
  }

  /** Operaciones esperando un hilo libre. */
  get queued(): number {
    return this.queue.length;
  }

  /** Recuentos para las métricas (`GET /metrics`). */
  stats(): ComputeStats {
    return { size: this.size, workers: this.workers, active: this.active, queued: this.queued, completed: this.completed, timeouts: this.timeouts, rejected: this.rejected, crashes: this.crashes };
  }

  /**
   * ¿Puede atender trabajos? (`/readyz`.) No arranca ningún hilo para averiguarlo (costaría unos 70 MB en un servicio que quizá no calcula nada):
   * comprueba que el pool no se cerró, que el archivo del hilo existe y que los últimos hilos no se cayeron todos sin contestar (3 seguidos). Un
   * pool ocupado o con la cola llena sigue vivo: eso es carga, no avería, y lo cuentan las métricas.
   */
  healthy(): boolean {
    if (this.closed || this.crashesInARow >= 3) return false;
    try {
      return existsSync(typeof this.workerFile === 'string' ? this.workerFile : fileURLToPath(this.workerFile));
    } catch {
      return false;
    }
  }

  run(job: ComputeJob, options: ComputeRunOptions = {}): Promise<ComputeOutcome> {
    return new Promise((resolve) => {
      if (this.closed) return resolve(unavailable('El servicio se está deteniendo: reintente en unos segundos.', 'stopping', { 'Retry-After': String(this.retryAfterSeconds) }));
      if (options.signal?.aborted) return resolve(unavailable('La operación se canceló.', 'cancelled'));
      const task: Task = { id: ++this.sequence, job, resolve };
      let slot: Slot | undefined;
      try {
        slot = this.idle.pop() ?? this.spawn();
      } catch (error) {
        return resolve({ kind: 'internal', detail: (error as Error).stack ?? String(error) }); // no se pudo crear el hilo (archivo o ruta inválidos)
      }
      if (slot) return this.start(slot, task);
      if (this.queue.length >= this.maxQueue) {
        this.rejected += 1;
        return resolve(
          unavailable(
            `El servicio está ocupado calculando (${this.size} operaciones en curso y ${this.queue.length} en espera): reintente en unos segundos.`,
            'busy',
            { 'Retry-After': String(this.retryAfterSeconds) },
          ),
        );
      }
      this.queue.push(task);
      const { signal } = options;
      if (signal) {
        // El cliente colgó con la operación en cola: no se calcula para nadie.
        const abandon = (): void => {
          const index = this.queue.indexOf(task);
          if (index >= 0) {
            this.queue.splice(index, 1);
            resolve(unavailable('La operación se canceló.', 'cancelled'));
          }
        };
        signal.addEventListener('abort', abandon, { once: true });
        task.detach = () => signal.removeEventListener('abort', abandon);
      }
    });
  }

  /** Para los hilos y responde 503 a lo que estuviera en curso o en cola. */
  async close(): Promise<void> {
    this.closed = true;
    const stopping = (): ComputeOutcome => unavailable('El servicio se está deteniendo: reintente en unos segundos.', 'stopping', { 'Retry-After': String(this.retryAfterSeconds) });
    for (const task of this.queue.splice(0)) this.settle(task, stopping());
    const ending = [...this.slots].map((slot) => {
      if (slot.task) this.settle(slot.task, stopping());
      return this.retire(slot);
    });
    await Promise.all(ending);
  }

  /** Un hilo nuevo, si cabe en `size`. */
  private spawn(): Slot | undefined {
    if (this.closed || this.slots.size >= this.size) return undefined;
    const worker = newWorker(this.workerFile);
    // Un hilo ocioso no mantiene vivo el proceso; el servidor y el temporizador de cada operación en curso sí.
    worker.unref();
    const slot: Slot = { worker, retired: false };
    worker.on('message', (reply: ComputeReply) => this.reply(slot, reply));
    worker.on('error', (error) => this.crashed(slot, error));
    worker.on('exit', (code) => this.crashed(slot, new Error(`El hilo de cálculo terminó de forma inesperada (código ${code}).`)));
    this.slots.add(slot);
    return slot;
  }

  private start(slot: Slot, task: Task): void {
    slot.task = task;
    task.timer = setTimeout(() => this.expired(slot, task), this.timeoutMs);
    slot.worker.postMessage({ id: task.id, job: task.job } satisfies ComputeRequest);
  }

  /** Cierra la operación (una sola vez) con su resultado y suelta lo que tuviera enganchado. */
  private settle(task: Task, outcome: ComputeOutcome): void {
    if (task.timer) clearTimeout(task.timer);
    task.detach?.();
    task.resolve(outcome);
  }

  private reply(slot: Slot, reply: ComputeReply): void {
    const task = slot.task;
    if (slot.retired || !task || reply?.id !== task.id) return;
    slot.task = undefined;
    this.completed += 1;
    this.crashesInARow = 0;
    this.settle(task, reply.outcome);
    this.release(slot);
  }

  /** El hilo queda libre: atiende la siguiente operación en cola o espera. */
  private release(slot: Slot): void {
    const next = this.queue.shift();
    if (next) {
      next.detach?.();
      this.start(slot, next);
    } else this.idle.push(slot);
  }

  private expired(slot: Slot, task: Task): void {
    if (slot.retired || slot.task !== task) return;
    this.timeouts += 1;
    this.settle(task, unavailable(`La operación superó el tiempo límite de ${this.timeoutMs / 1000} s y se canceló: el documento es demasiado grande o complejo para calcularlo ahora.`, 'timeout'));
    slot.task = undefined;
    void this.retire(slot);
    this.pump();
  }

  /** Un hilo que se cae: la operación que llevaba recibe un error y se le busca relevo a las que esperan. */
  private crashed(slot: Slot, error: Error & { code?: string }): void {
    if (slot.retired) return;
    this.crashes += 1;
    this.crashesInARow += 1;
    const task = slot.task;
    slot.task = undefined;
    void this.retire(slot);
    if (task) {
      this.settle(
        task,
        error.code === 'ERR_WORKER_OUT_OF_MEMORY'
          ? unavailable('La operación agotó la memoria y se canceló: el documento es demasiado grande o complejo para calcularlo ahora.', 'out-of-memory')
          : { kind: 'internal', detail: error.stack ?? String(error) },
      );
    } else process.stderr.write(`aviso: un hilo de cálculo ocioso terminó: ${error.message}\n`);
    this.pump();
  }

  /** Quita el hilo del pool y lo termina (esté en el bucle que esté). */
  private retire(slot: Slot): Promise<unknown> {
    slot.retired = true;
    this.slots.delete(slot);
    const at = this.idle.indexOf(slot);
    if (at >= 0) this.idle.splice(at, 1);
    return slot.worker.terminate().catch(() => undefined);
  }

  /** Reparte las operaciones en cola entre los hilos libres y los que se puedan crear. */
  private pump(): void {
    while (this.queue.length > 0 && !this.closed) {
      let slot: Slot | undefined;
      try {
        slot = this.idle.pop() ?? this.spawn();
      } catch (error) {
        this.settle(this.queue.shift()!, { kind: 'internal', detail: (error as Error).stack ?? String(error) });
        continue;
      }
      if (!slot) return;
      const task = this.queue.shift()!;
      task.detach?.();
      this.start(slot, task);
    }
  }
}
