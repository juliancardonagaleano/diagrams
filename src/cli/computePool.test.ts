import { afterEach, describe, expect, it } from 'vitest';
import type { ComputeJob, ComputeOutcome } from './compute';
import { ComputePool, defaultWorkerCount, type ComputePoolOptions } from './computePool';

// El hilo de trabajo es uno de mentira (tests/fixtures/compute-stub-worker.mjs) que se cuelga, se cae o tarda a petición: lo que
// se prueba aquí es el pool (reparto, tiempo límite, cola, relevo de hilos), no el cálculo; el cálculo de verdad lo prueba
// serveCompute.test.ts con el hilo empaquetado.
const STUB = new URL('../../tests/fixtures/compute-stub-worker.mjs', import.meta.url);

const job = (body: string): ComputeJob => ({ op: 'validate', module: 'security', body });
const pools: ComputePool[] = [];
function newPool(options: ComputePoolOptions = {}): ComputePool {
  const pool = new ComputePool({ workerFile: STUB, timeoutMs: 10_000, ...options });
  pools.push(pool);
  return pool;
}
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
});

/** El id del hilo que respondió (el eco del hilo de mentira termina en `:<id>`); el hilo principal es el 0. */
function threadOf(outcome: ComputeOutcome): number {
  expect(outcome.kind).toBe('ok');
  return Number((outcome as { body: string }).body.split(':').pop());
}
const http = (outcome: ComputeOutcome) => {
  expect(outcome.kind).toBe('http');
  return outcome as Extract<ComputeOutcome, { kind: 'http' }>;
};

describe('defaultWorkerCount', () => {
  it('dos hilos como mucho, uno menos que las CPU y nunca menos de uno', () => {
    expect([1, 2, 3, 4, 8, 64].map((cpus) => defaultWorkerCount(cpus))).toEqual([1, 1, 2, 2, 2, 2]);
  });
});

describe('ComputePool: reparto', () => {
  it('ejecuta el trabajo en un hilo que no es el principal y reutiliza el mismo hilo', async () => {
    const pool = newPool({ size: 1 });
    expect(pool.workers).toBe(0); // se crean al hacer falta
    const first = await pool.run(job('uno'));
    expect(first).toMatchObject({ kind: 'ok', contentType: 'text/plain; charset=utf-8' });
    expect((first as { body: string }).body).toMatch(/^eco:validate:uno:\d+$/);
    const thread = threadOf(first);
    expect(thread).toBeGreaterThan(0);
    expect(threadOf(await pool.run(job('dos')))).toBe(thread);
    expect(pool.workers).toBe(1);
  });

  it('reparte los trabajos concurrentes entre los hilos que caben y no crea más', async () => {
    const pool = newPool({ size: 2 });
    const results = await Promise.all([pool.run(job('slow:150')), pool.run(job('slow:150')), pool.run(job('slow:150'))]);
    expect(results.map((r) => r.kind)).toEqual(['ok', 'ok', 'ok']);
    expect(pool.workers).toBe(2);
    expect(pool.queued).toBe(0);
  });

  it('devuelve tal cual lo que el cálculo responde, también los errores de la petición y los fallos del programa', async () => {
    const pool = newPool({ size: 1 });
    expect(await pool.run(job('http-error'))).toEqual({ kind: 'http', status: 422, message: 'No vale.', extra: { issues: [{ path: 'a', message: 'b' }] } });
    expect(await pool.run(job('internal'))).toEqual({ kind: 'internal', detail: 'Error: falló el programa\n    at stub' });
    expect(threadOf(await pool.run(job('sigue')))).toBeGreaterThan(0); // el hilo siguió vivo
  });
});

describe('ComputePool: tiempo límite', () => {
  it('termina el hilo que se cuelga, responde 503 y el siguiente trabajo va a un hilo nuevo', async () => {
    const pool = newPool({ size: 1, timeoutMs: 300 });
    const first = threadOf(await pool.run(job('antes')));
    const started = Date.now();
    const hung = http(await pool.run(job('hang')));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(hung.status).toBe(503);
    expect(hung.message).toMatch(/tiempo límite de 0\.3 s/);
    expect(hung.extra).toEqual({ code: 'timeout' });
    expect(pool.workers).toBe(0); // el hilo colgado se terminó
    const after = threadOf(await pool.run(job('despues')));
    expect(after).not.toBe(first); // y lo sustituyó otro
    expect(pool.workers).toBe(1);
  });

  it('el tiempo corre desde que el trabajo llega a un hilo, no mientras espera en la cola', async () => {
    const pool = newPool({ size: 1, timeoutMs: 400 });
    const results = await Promise.all([pool.run(job('slow:250')), pool.run(job('slow:250')), pool.run(job('slow:250'))]);
    expect(results.map((r) => r.kind)).toEqual(['ok', 'ok', 'ok']); // el tercero espera ~500 ms en total y no vence
  });

  it('lo que esperaba en la cola detrás de un hilo colgado se atiende con el hilo de relevo', async () => {
    const pool = newPool({ size: 1, timeoutMs: 300 });
    const [hung, queued] = await Promise.all([pool.run(job('hang')), pool.run(job('espera'))]);
    expect(http(hung).extra).toEqual({ code: 'timeout' });
    expect((queued as { body: string }).body).toMatch(/^eco:validate:espera:/);
  });
});

describe('ComputePool: cola acotada', () => {
  it('con todos los hilos ocupados y la cola llena responde 503 con Retry-After al instante', async () => {
    const pool = newPool({ size: 1, maxQueue: 1, retryAfterSeconds: 7 });
    const running = pool.run(job('slow:300'));
    const waiting = pool.run(job('espera'));
    expect(pool.queued).toBe(1);
    const started = Date.now();
    const rejected = http(await pool.run(job('de más')));
    expect(Date.now() - started).toBeLessThan(200);
    expect(rejected.status).toBe(503);
    expect(rejected.headers).toEqual({ 'Retry-After': '7' });
    expect(rejected.extra).toEqual({ code: 'busy' });
    expect(rejected.message).toMatch(/ocupado/);
    expect(pool.queued).toBe(1); // lo rechazado no ocupó sitio
    // lo que sí entró se atiende por orden
    expect((await running).kind).toBe('ok');
    expect((await waiting).kind).toBe('ok');
    expect(pool.queued).toBe(0);
  });

  it('un tope que no es un número usable (NaN, Infinity) cae en el de por omisión: nunca queda sin tope', () => {
    const pool = newPool({ size: Number.NaN, maxQueue: Number.NaN, timeoutMs: Number.POSITIVE_INFINITY });
    expect([pool.size, pool.maxQueue, pool.timeoutMs]).toEqual([defaultWorkerCount(), 16, 30_000]);
  });

  it('sin cola (maxQueue 0) rechaza en cuanto no queda un hilo libre', async () => {
    const pool = newPool({ size: 1, maxQueue: 0 });
    const running = pool.run(job('slow:200'));
    expect(http(await pool.run(job('otro'))).status).toBe(503);
    expect((await running).kind).toBe('ok');
  });

  it('una operación en cola cuyo cliente se fue se descarta sin calcularla', async () => {
    const pool = newPool({ size: 1, maxQueue: 4 });
    const running = pool.run(job('slow:250'));
    const gone = new AbortController();
    const abandoned = pool.run(job('nadie lo espera'), { signal: gone.signal });
    expect(pool.queued).toBe(1);
    gone.abort();
    expect(http(await abandoned).extra).toEqual({ code: 'cancelled' });
    expect(pool.queued).toBe(0);
    expect((await running).kind).toBe('ok');
    // ya abortada de antemano ni siquiera entra
    expect(http(await pool.run(job('x'), { signal: gone.signal })).extra).toEqual({ code: 'cancelled' });
  });
});

describe('ComputePool: hilos que se caen y cierre', () => {
  it('un hilo que se cae devuelve un fallo del programa con su traza y se sustituye', async () => {
    const pool = newPool({ size: 1 });
    const first = threadOf(await pool.run(job('antes')));
    const crashed = await pool.run(job('crash'));
    expect(crashed.kind).toBe('internal');
    expect((crashed as { detail: string }).detail).toContain('boom');
    expect(threadOf(await pool.run(job('despues')))).not.toBe(first);
  });

  it('un archivo de hilo que no existe no deja la operación sin respuesta: es un fallo del programa', async () => {
    const pool = newPool({ size: 1, workerFile: new URL('./no-existe-el-hilo.mjs', import.meta.url) });
    const outcome = await pool.run(job('x'));
    expect(outcome.kind).toBe('internal');
    expect((outcome as { detail: string }).detail).toMatch(/no-existe-el-hilo|ERR_MODULE_NOT_FOUND/);
  });

  it('al cerrar responde 503 a lo que estaba en curso y en cola, y a lo que llegue después', async () => {
    const pool = newPool({ size: 1, maxQueue: 2 });
    const running = pool.run(job('hang'));
    const queued = pool.run(job('espera'));
    await new Promise((resolve) => setTimeout(resolve, 100)); // que el hilo reciba el trabajo
    await pool.close();
    expect(http(await running).extra).toEqual({ code: 'stopping' });
    expect(http(await queued).extra).toEqual({ code: 'stopping' });
    expect(http(await pool.run(job('tarde'))).status).toBe(503);
    expect(pool.workers).toBe(0);
  });
});
