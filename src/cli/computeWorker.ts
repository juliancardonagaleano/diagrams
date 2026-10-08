import { parentPort } from 'node:worker_threads';
import { executeJob, type ComputeReply, type ComputeRequest } from './compute';
import { createDefaultRegistry } from './registry';

/**
 * Hilo de trabajo del `ComputePool` (ver `computePool.ts`): construye su propio registro de módulos y ejecuta de uno en uno
 * los trabajos que le manda el hilo principal. `tsup` lo empaqueta como entrada propia (`dist/cli/compute-worker.js`).
 */

if (!parentPort) throw new Error('computeWorker.ts es el punto de entrada de un hilo de trabajo (worker_threads), no un módulo que se importe.');
const port = parentPort;
const registry = createDefaultRegistry();

const reply = (message: ComputeReply): void => {
  try {
    port.postMessage(message);
  } catch (error) {
    // Un resultado que no se puede copiar entre hilos es un fallo del programa, no un motivo para dejar la operación sin respuesta.
    port.postMessage({ id: message.id, outcome: { kind: 'internal', detail: (error as Error).stack ?? String(error) } } satisfies ComputeReply);
  }
};

port.on('message', (request: ComputeRequest) => {
  // `executeJob` no lanza: un fallo del programa vuelve como `internal` con su traza, y el hilo sigue vivo para el siguiente trabajo.
  void executeJob(registry, request.job).then((outcome) => reply({ id: request.id, outcome }));
});
