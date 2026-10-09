import type { ElkNode } from 'elkjs/lib/elk-api';

/**
 * Dónde se ejecuta ELK. Un autolayout grande tarda segundos (un grafo de 1000 nodos, unos 13 s; ver docs/rendimiento.md) y ELK es
 * síncrono, así que en el navegador, en el hilo principal, la página se queda congelada todo ese tiempo. Aquí se decide el sitio:
 *
 *  - **Navegador con `Worker`**: un hilo de trabajo (`elkWorker.ts`) con su copia de ELK. Es lo que usan `layoutGraph` y el autolayout
 *    de C4 sin cambiar su API: la entrada y la salida son el mismo grafo JSON de ELK, que viaja por `postMessage`.
 *  - **Sin `Worker`** (Node, jsdom, el hilo de cálculo del servicio, un entorno que no lo permite) **o si el hilo no arranca** (la
 *    política de seguridad del sitio lo bloquea, el archivo no se encuentra): ELK se carga bajo demanda y corre en el hilo actual,
 *    como hasta ahora. Cargarlo bajo demanda saca los 1,4 MB de ELK de la carga inicial de las páginas que no calculan nada.
 *
 * Cancelar (`signal`): un cálculo en cola se descarta; uno en marcha se corta terminando el hilo (ELK no se puede interrumpir desde
 * dentro) y el siguiente arranca otro. En el hilo actual no se puede cortar a medias: la promesa se rechaza al instante y el
 * resultado tardío se ignora.
 */

export interface ElkRequestOptions {
  /** Al abortarse, la promesa se rechaza con un error `AbortError` y el cálculo se descarta o se corta. */
  signal?: AbortSignal;
}

/** Lo que ejecuta un cálculo de ELK. Los entornos pueden sustituirlo con `setElkRunner` (pruebas, anfitriones). */
export type ElkRunner = (graph: ElkNode, options: ElkRequestOptions) => Promise<ElkNode>;

/** Dónde está corriendo ELK ahora: `worker` (hilo de trabajo del navegador), `thread` (el hilo actual) o `custom` (sustituido con `setElkRunner`). */
export type ElkPlace = 'worker' | 'thread' | 'custom';

/** El error con el que se rechaza un cálculo cancelado. */
export function abortError(): Error {
  const error = new Error('El cálculo de la colocación se canceló.');
  error.name = 'AbortError';
  return error;
}

export const isAbortError = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';

/* ---------------------------------------------------------------- en el hilo actual */

interface ElkEngine {
  layout(graph: ElkNode): Promise<ElkNode>;
}

let engine: Promise<ElkEngine> | undefined;

/** ELK en el hilo actual: se importa la primera vez que hace falta y se reutiliza la instancia. */
const loadEngine = (): Promise<ElkEngine> => {
  engine ??= import('elkjs/lib/elk.bundled.js').then((module) => new module.default());
  return engine;
};

/** Ejecuta ELK en el hilo actual. Es el que se usa en Node y la salida de emergencia cuando no hay hilo de trabajo. */
export const runElkInThread: ElkRunner = async (graph, { signal }) => {
  if (signal?.aborted) throw abortError();
  const elk = await loadEngine();
  if (signal?.aborted) throw abortError();
  const layout = elk.layout(graph);
  if (!signal) return layout;
  // El cálculo ya está en marcha y no se puede parar: se deja de esperarlo y se ignora lo que devuelva.
  return new Promise<ElkNode>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    layout.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
};

/* ---------------------------------------------------------------- en un hilo de trabajo */

/** Lo mínimo de un `Worker` que usamos (el tipo del DOM no está disponible en los paquetes de Node). */
export interface ElkWorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** Mensajes entre la página y el hilo de trabajo. */
export interface ElkWorkerRequest {
  id: number;
  graph: ElkNode;
}
export type ElkWorkerResponse = { id: number; ok: true; graph: ElkNode } | { id: number; ok: false; error: { name: string; message: string } };

interface Job {
  id: number;
  graph: ElkNode;
  signal?: AbortSignal;
  resolve(graph: ElkNode): void;
  reject(error: unknown): void;
  onAbort?: () => void;
}

/**
 * Un hilo de trabajo de ELK y su cola: de uno en uno, porque el cálculo es síncrono dentro del hilo y encolar varios no los
 * acelera, pero sí impediría descartar los que ya no hacen falta. `create` arranca el hilo; si lanza o el hilo falla antes de
 * contestar nada, `fallback` calcula el trabajo (y los siguientes) en el hilo actual.
 */
export class ElkWorkerRunner {
  private worker: ElkWorkerLike | undefined;
  private healthy = false;
  private broken = false;
  private current: Job | undefined;
  private readonly queue: Job[] = [];
  private nextId = 1;

  constructor(
    private readonly create: () => ElkWorkerLike,
    private readonly fallback: ElkRunner = runElkInThread,
  ) {}

  /** ¿Se abandonó el hilo de trabajo y todo corre ya en el hilo actual? */
  get usesFallback(): boolean {
    return this.broken;
  }

  run: ElkRunner = (graph, { signal } = {}) => {
    if (this.broken) return this.fallback(graph, { signal });
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise<ElkNode>((resolve, reject) => {
      const job: Job = { id: this.nextId++, graph, signal, resolve, reject };
      if (signal) {
        job.onAbort = () => this.abort(job);
        signal.addEventListener('abort', job.onAbort, { once: true });
      }
      this.queue.push(job);
      this.pump();
    });
  };

  /** Termina el hilo de trabajo (si lo hay) y rechaza lo pendiente. El siguiente cálculo arranca otro. */
  dispose(): void {
    const pending = [this.current, ...this.queue].filter((job): job is Job => job !== undefined);
    this.current = undefined;
    this.queue.length = 0;
    this.stopWorker();
    for (const job of pending) this.settle(job, () => job.reject(abortError()));
  }

  private pump(): void {
    if (this.current || this.queue.length === 0) return;
    const job = this.queue.shift()!;
    const worker = this.ensureWorker();
    if (!worker) {
      // No hay hilo de trabajo (no se pudo crear): este trabajo y los que vengan corren en el hilo actual.
      void this.runInFallback(job);
      this.drainToFallback();
      return;
    }
    this.current = job;
    try {
      worker.postMessage({ id: job.id, graph: job.graph } satisfies ElkWorkerRequest);
    } catch (error) {
      // El grafo no se pudo clonar (algo que no es JSON): es un error de quien llama, no del hilo.
      this.current = undefined;
      this.settle(job, () => job.reject(error));
      this.pump();
    }
  }

  private ensureWorker(): ElkWorkerLike | undefined {
    if (this.worker) return this.worker;
    if (this.broken) return undefined;
    try {
      const worker = this.create();
      worker.onmessage = (event) => this.onMessage(event.data as ElkWorkerResponse);
      worker.onerror = () => this.onFailure();
      this.worker = worker;
      return worker;
    } catch {
      this.giveUp();
      return undefined;
    }
  }

  private onMessage(message: ElkWorkerResponse): void {
    const job = this.current;
    if (!job || job.id !== message.id) return;
    this.healthy = true;
    this.current = undefined;
    this.settle(job, () => {
      if (message.ok) job.resolve(message.graph);
      else {
        const error = new Error(message.error.message);
        error.name = message.error.name;
        job.reject(error);
      }
    });
    this.pump();
  }

  /** El hilo falló (no cargó su script, o lanzó sin atrapar). Si nunca llegó a contestar, se abandona y se pasa al hilo actual. */
  private onFailure(): void {
    const job = this.current;
    this.current = undefined;
    this.stopWorker();
    if (!this.healthy) {
      this.giveUp();
      if (job) void this.runInFallback(job);
      this.drainToFallback();
      return;
    }
    if (job) this.settle(job, () => job.reject(new Error('El hilo de trabajo del autolayout falló.')));
    this.pump();
  }

  private abort(job: Job): void {
    const queued = this.queue.indexOf(job);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      this.settle(job, () => job.reject(abortError()));
      return;
    }
    if (this.current !== job) return;
    // Está calculándose: la única forma de pararlo es terminar el hilo. El siguiente trabajo arranca uno nuevo.
    this.current = undefined;
    this.stopWorker();
    this.settle(job, () => job.reject(abortError()));
    this.pump();
  }

  private giveUp(): void {
    this.broken = true;
  }

  private drainToFallback(): void {
    for (const job of this.queue.splice(0)) void this.runInFallback(job);
  }

  private async runInFallback(job: Job): Promise<void> {
    try {
      const graph = await this.fallback(job.graph, { signal: job.signal });
      this.settle(job, () => job.resolve(graph));
    } catch (error) {
      this.settle(job, () => job.reject(error));
    }
  }

  private stopWorker(): void {
    const worker = this.worker;
    this.worker = undefined;
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
  }

  /** Cierra un trabajo una sola vez: quita su oyente de aborto y ejecuta `done`. */
  private settle(job: Job, done: () => void): void {
    if (job.signal && job.onAbort) job.signal.removeEventListener('abort', job.onAbort);
    job.onAbort = undefined;
    done();
  }
}

/* ---------------------------------------------------------------- elección del lugar */

// Declarado aquí porque estos paquetes se compilan también sin la librería DOM; en el navegador es el `Worker` de siempre.
declare const Worker: new (url: URL, options?: { type?: 'module' | 'classic'; name?: string }) => ElkWorkerLike;

/** Lo que el hilo de trabajo de ELK (`elk-worker.min.js`) entiende y contesta: su protocolo propio, el mismo que usa `elkjs/lib/elk-api`. */
interface NativeElkMessage {
  id: number;
  cmd: 'register' | 'layout';
  algorithms?: string[];
  graph?: ElkNode;
  layoutOptions?: Record<string, string>;
  options?: { logging: boolean; measureExecutionTime: boolean };
}
interface NativeElkReply {
  id: number;
  data?: ElkNode;
  error?: unknown;
}

/** Los algoritmos que ELK registra por omisión (los mismos que `new ELK()`); `layered` es el que usamos. */
const ELK_ALGORITHMS = ['layered', 'stress', 'mrtree', 'radial', 'force', 'disco', 'sporeOverlap', 'sporeCompaction', 'rectpacking'];

const errorFrom = (error: unknown): { name: string; message: string } => {
  if (error && typeof error === 'object') {
    const { name, message } = error as { name?: unknown; message?: unknown };
    return { name: typeof name === 'string' ? name : 'Error', message: typeof message === 'string' ? message : String(error) };
  }
  return { name: 'Error', message: String(error) };
};

/**
 * Habla el protocolo propio de ELK con un `Worker` que ejecuta `elk-worker.min.js` y lo presenta con el nuestro (`ElkWorkerRequest` /
 * `ElkWorkerResponse`). El motor registra los algoritmos al arrancar, antes del primer cálculo (los mensajes llegan en orden).
 */
export function nativeElkWorker(native: ElkWorkerLike): ElkWorkerLike {
  let listener: ElkWorkerLike['onmessage'] = null;
  native.onmessage = (event) => {
    const reply = event.data as NativeElkReply;
    if (reply.id === 0) return; // la respuesta al registro de algoritmos
    if (reply.error !== undefined) listener?.({ data: { id: reply.id, ok: false, error: errorFrom(reply.error) } satisfies ElkWorkerResponse });
    else listener?.({ data: { id: reply.id, ok: true, graph: reply.data as ElkNode } satisfies ElkWorkerResponse });
  };
  native.postMessage({ id: 0, cmd: 'register', algorithms: ELK_ALGORITHMS } satisfies NativeElkMessage);
  return {
    postMessage: (message) => {
      const { id, graph } = message as ElkWorkerRequest;
      native.postMessage({ id, cmd: 'layout', graph, layoutOptions: {}, options: { logging: false, measureExecutionTime: false } } satisfies NativeElkMessage);
    },
    terminate: () => native.terminate(),
    get onmessage() {
      return listener;
    },
    set onmessage(handler) {
      listener = handler;
    },
    get onerror() {
      return native.onerror;
    },
    set onerror(handler) {
      native.onerror = handler;
    },
  };
}

/** Crea el hilo de trabajo de ELK. La forma `new Worker(new URL(…, import.meta.url))` es la que Vite reconoce para empaquetarlo aparte. */
function createBrowserWorker(): ElkWorkerLike {
  return nativeElkWorker(new Worker(new URL('./elkWorker.ts', import.meta.url), { type: 'module', name: 'iark-elk' }));
}

/** `?elk=thread` en la dirección fuerza el hilo principal (diagnóstico y comparación: ver docs/rendimiento.md). */
function threadForced(): boolean {
  try {
    const location = (globalThis as { location?: { search?: string } }).location;
    return new URLSearchParams(location?.search ?? '').get('elk') === 'thread';
  } catch {
    return false;
  }
}

let custom: ElkRunner | undefined;
let workerRunner: ElkWorkerRunner | undefined;

/** Sustituye el lugar donde corre ELK (pruebas y anfitriones que traen el suyo). Sin argumento, vuelve a la elección automática. */
export function setElkRunner(runner: ElkRunner | undefined): void {
  custom = runner;
  workerRunner?.dispose();
  workerRunner = undefined;
}

function chooseRunner(): ElkRunner {
  if (custom) return custom;
  if (typeof Worker === 'undefined' || threadForced()) return runElkInThread;
  workerRunner ??= new ElkWorkerRunner(createBrowserWorker);
  return workerRunner.run;
}

/** Dónde correría un cálculo ahora mismo. */
export function elkPlace(): ElkPlace {
  if (custom) return 'custom';
  if (typeof Worker === 'undefined' || threadForced() || workerRunner?.usesFallback) return 'thread';
  return 'worker';
}

/** Calcula la colocación de un grafo de ELK donde corresponda (hilo de trabajo del navegador o el hilo actual). Mismo grafo de entrada y de salida que `ELK.layout`. */
export function layoutElk(graph: ElkNode, options: ElkRequestOptions = {}): Promise<ElkNode> {
  return chooseRunner()(graph, options);
}
