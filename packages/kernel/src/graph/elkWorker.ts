import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkWorkerRequest, ElkWorkerResponse } from './elk';

/**
 * Hilo de trabajo del autolayout (lo arranca `elk.ts`): recibe un grafo de ELK, lo coloca con su propia copia de ELK y devuelve el
 * mismo grafo con las coordenadas. Atiende de una en una las peticiones que llegan; quien las manda ya las encola.
 *
 * No lo importa ningún otro archivo: se carga solo por su dirección (`new Worker(new URL('./elkWorker.ts', import.meta.url))`).
 */
interface WorkerScope {
  onmessage: ((event: { data: ElkWorkerRequest }) => void) | null;
  postMessage(message: ElkWorkerResponse): void;
}

const scope = globalThis as unknown as WorkerScope;
const elk = new ELK();

scope.onmessage = (event) => {
  const { id, graph } = event.data;
  elk.layout(graph).then(
    (result) => scope.postMessage({ id, ok: true, graph: result }),
    (error: unknown) => scope.postMessage({ id, ok: false, error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) } }),
  );
};
