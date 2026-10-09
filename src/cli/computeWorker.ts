import { parentPort, workerData } from 'node:worker_threads';
import { executeJob, type ComputeReply, type ComputeRequest, type ComputeWorkerInit } from './compute';
import { createRegistry } from './registry';

/**
 * Hilo de trabajo del `ComputePool` (ver `computePool.ts`): construye su propio registro de módulos y ejecuta de uno en uno
 * los trabajos que le manda el hilo principal. `tsup` lo empaqueta como entrada propia (`dist/cli/compute-worker.js`).
 *
 * El registro lleva los módulos incorporados y los de terceros que el hilo principal le pasa ya resueltos en `workerData`
 * (`ComputeWorkerInit.plugins`): son los mismos que cargó el principal, sin volver a leer ni a interpretar la configuración
 * (que pudo cambiar mientras tanto). El principal ya anotó cada módulo cargado, así que aquí no se repite.
 */

if (!parentPort) throw new Error('computeWorker.ts es el punto de entrada de un hilo de trabajo (worker_threads), no un módulo que se importe.');
const port = parentPort;
const init = (workerData ?? {}) as Partial<ComputeWorkerInit>;
// Se carga mientras llegan los primeros trabajos: cada uno espera a que el registro esté listo.
const registry = createRegistry({ plugins: init.plugins ?? [], log: () => undefined });
registry.catch(() => undefined); // el fallo se informa en cada trabajo (abajo); sin esto, Node lo contaría además como rechazo sin atender

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
  // Si el registro no se pudo construir (un módulo de terceros que ya no carga), cada trabajo lo cuenta como fallo interno.
  void registry
    .then((ready) => executeJob(ready, request.job))
    .catch((error: unknown) => ({ kind: 'internal' as const, detail: `El hilo de cálculo no pudo cargar los módulos: ${(error as Error).stack ?? String(error)}` }))
    .then((outcome) => reply({ id: request.id, outcome }));
});
