// Un hilo de trabajo de mentira para las pruebas del `ComputePool` (src/cli/computePool.test.ts, src/cli/serveCompute.test.ts):
// habla el mismo protocolo que src/cli/computeWorker.ts ({ id, job } → { id, outcome }), pero lo que hace depende del cuerpo del
// trabajo, para provocar a propósito lo que un cálculo real hace sin avisar:
//
//   hang        bucle ocupado que no termina nunca (un ELK desbocado): solo se arregla terminando el hilo
//   crash       una excepción no capturada: el hilo se cae
//   slow:<ms>   responde pasado ese tiempo (sin bloquear el hilo)
//   http-error  un problema de la petición (HttpError 422)
//   internal    un fallo del programa (500)
//   otro texto  responde `eco:<op>:<cuerpo>:<id del hilo>` (el hilo principal es el 0)
import { parentPort, threadId } from 'node:worker_threads';

parentPort.on('message', ({ id, job }) => {
  const reply = (outcome) => parentPort.postMessage({ id, outcome });
  const body = job.body ?? '';
  if (body === 'hang') for (;;);
  if (body === 'crash') throw new Error('boom: el hilo se cayó');
  if (body.startsWith('slow:')) return void setTimeout(() => reply({ kind: 'ok', contentType: 'text/plain; charset=utf-8', body: `lento:${body}` }), Number(body.slice(5)));
  if (body === 'http-error') return reply({ kind: 'http', status: 422, message: 'No vale.', extra: { issues: [{ path: 'a', message: 'b' }] } });
  if (body === 'internal') return reply({ kind: 'internal', detail: 'Error: falló el programa\n    at stub' });
  reply({ kind: 'ok', contentType: 'text/plain; charset=utf-8', body: `eco:${job.op}:${body}:${threadId}` });
});
