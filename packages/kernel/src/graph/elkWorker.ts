/**
 * Hilo de trabajo del autolayout (lo arranca `elk.ts`). Es el propio motor de ELK: al cargarse en un hilo de trabajo,
 * `elk-worker.min.js` se instala como `onmessage` y atiende los mensajes de ELK (`register`, `layout`) con su copia de los algoritmos,
 * sin tocar la página. `elk.ts` (`nativeElkWorker`) le habla ese protocolo.
 *
 * No lo importa ningún otro archivo: se carga solo por su dirección (`new Worker(new URL('./elkWorker.ts', import.meta.url))`).
 */
import 'elkjs/lib/elk-worker.min.js';
