import { z } from 'zod';

/**
 * Desactiva el modo «JIT» de zod en el navegador. Al crear cada esquema, zod comprueba si puede compilar validadores con
 * `new Function('')`; con una CSP sin `'unsafe-eval'` (la que envía `iark serve`) esa comprobación falla y zod lo maneja bien, pero
 * el navegador la anota como violación (`securitypolicyviolation`) y como error de consola, y ese ruido tapa las violaciones de
 * verdad. Sin JIT el resultado es el mismo y no se nota la diferencia (validar `examples/banca.json` tarda ≈0,2 ms con y sin JIT).
 *
 * Tiene que ejecutarse **antes de crear ningún esquema**: cada página de la app lo importa como primera línea
 * (`import '@iark/kernel/jitless'`) y `vite.config.ts` pone zod y este archivo en un mismo trozo (`zod`) que no depende de ningún
 * otro: si zod quedara dentro del trozo de un módulo, sus esquemas se crearían antes de que corriera esta línea. En Node (CLI,
 * servicio) no hace nada: allí no hay CSP y el JIT sigue como siempre.
 */
// `globalThis` y no `window`: el kernel también se compila sin los tipos del DOM (CLI, servicio).
if (typeof (globalThis as { window?: unknown }).window !== 'undefined') z.config({ jitless: true });
