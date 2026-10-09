import type { ElkNode } from 'elkjs/lib/elk-api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { abortError, elkPlace, ElkWorkerRunner, isAbortError, layoutElk, nativeElkWorker, runElkInThread, setElkRunner, type ElkRunner, type ElkWorkerLike, type ElkWorkerRequest, type ElkWorkerResponse } from './elk';

/**
 * Dónde corre ELK. Los hilos de trabajo se simulan con un `Worker` de mentira que guarda lo que se le manda y contesta cuando la
 * prueba se lo dice: así se comprueba, sin reloj, que el cálculo se pide al hilo, que se atiende de uno en uno, que cancelar corta
 * el hilo y que, si no hay hilo o no arranca, el cálculo ocurre en el hilo actual.
 */
class FakeWorker implements ElkWorkerLike {
  static all: FakeWorker[] = [];
  posted: ElkWorkerRequest[] = [];
  terminated = false;
  onmessage: ElkWorkerLike['onmessage'] = null;
  onerror: ElkWorkerLike['onerror'] = null;

  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(message: unknown): void {
    this.posted.push(message as ElkWorkerRequest);
  }
  terminate(): void {
    this.terminated = true;
  }
  /** Contesta a la petición `index` con el grafo dado (o con un error). */
  reply(index: number, response: Partial<ElkWorkerResponse> & { graph?: ElkNode }): void {
    const request = this.posted[index];
    this.onmessage?.({ data: { id: request.id, ok: true, graph: response.graph ?? request.graph, ...response } as ElkWorkerResponse });
  }
  fail(): void {
    this.onerror?.(new Event('error'));
  }
}

const graph = (id: string): ElkNode => ({ id, children: [{ id: `${id}-a`, width: 10, height: 10 }] });
const placed = (id: string): ElkNode => ({ ...graph(id), children: [{ id: `${id}-a`, width: 10, height: 10, x: 5, y: 7 }] });

afterEach(() => {
  setElkRunner(undefined);
  vi.unstubAllGlobals();
  FakeWorker.all = [];
});

describe('ElkWorkerRunner: el cálculo se pide al hilo de trabajo', () => {
  const runner = (fallback?: ElkRunner): ElkWorkerRunner => new ElkWorkerRunner(() => new FakeWorker(), fallback);

  it('manda el grafo al hilo y resuelve con lo que contesta', async () => {
    const r = runner();
    const pending = r.run(graph('g1'), {});
    expect(FakeWorker.all).toHaveLength(1);
    expect(FakeWorker.all[0].posted.map((m) => m.graph.id)).toEqual(['g1']);
    FakeWorker.all[0].reply(0, { graph: placed('g1') });
    await expect(pending).resolves.toEqual(placed('g1'));
  });

  it('atiende de uno en uno: el segundo no sale hasta que contesta el primero', async () => {
    const r = runner();
    const first = r.run(graph('g1'), {});
    const second = r.run(graph('g2'), {});
    expect(FakeWorker.all[0].posted).toHaveLength(1);
    FakeWorker.all[0].reply(0, {});
    await first;
    expect(FakeWorker.all[0].posted.map((m) => m.graph.id)).toEqual(['g1', 'g2']);
    FakeWorker.all[0].reply(1, { graph: placed('g2') });
    await expect(second).resolves.toEqual(placed('g2'));
    expect(FakeWorker.all).toHaveLength(1);
  });

  it('un error del hilo rechaza con su nombre y su mensaje, y el hilo sigue sirviendo', async () => {
    const r = runner();
    const bad = r.run(graph('g1'), {});
    FakeWorker.all[0].onmessage?.({ data: { id: FakeWorker.all[0].posted[0].id, ok: false, error: { name: 'UnsupportedGraphException', message: 'no se puede' } } satisfies ElkWorkerResponse });
    await expect(bad).rejects.toMatchObject({ name: 'UnsupportedGraphException', message: 'no se puede' });
    const good = r.run(graph('g2'), {});
    FakeWorker.all[0].reply(1, {});
    await expect(good).resolves.toMatchObject({ id: 'g2' });
  });

  it('una señal ya abortada rechaza sin crear el hilo', async () => {
    const r = runner();
    const controller = new AbortController();
    controller.abort();
    await expect(r.run(graph('g1'), { signal: controller.signal })).rejects.toSatisfy(isAbortError);
    expect(FakeWorker.all).toHaveLength(0);
  });

  it('abortar un cálculo en cola lo descarta sin tocar el hilo ni lo que está en marcha', async () => {
    const r = runner();
    const first = r.run(graph('g1'), {});
    const controller = new AbortController();
    const queued = r.run(graph('g2'), { signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toSatisfy(isAbortError);
    expect(FakeWorker.all[0].terminated).toBe(false);
    FakeWorker.all[0].reply(0, {});
    await first;
    expect(FakeWorker.all[0].posted.map((m) => m.graph.id)).toEqual(['g1']);
  });

  it('abortar el cálculo en marcha termina el hilo y el siguiente trabajo arranca otro', async () => {
    const r = runner();
    const controller = new AbortController();
    const running = r.run(graph('g1'), { signal: controller.signal });
    const next = r.run(graph('g2'), {});
    controller.abort();
    await expect(running).rejects.toSatisfy(isAbortError);
    expect(FakeWorker.all[0].terminated).toBe(true);
    expect(FakeWorker.all).toHaveLength(2);
    expect(FakeWorker.all[1].posted.map((m) => m.graph.id)).toEqual(['g2']);
    // Lo que el hilo terminado contestara tarde se ignora.
    FakeWorker.all[0].onmessage?.({ data: { id: 1, ok: true, graph: placed('g1') } });
    FakeWorker.all[1].reply(0, { graph: placed('g2') });
    await expect(next).resolves.toEqual(placed('g2'));
  });

  it('abortar después de contestado no hace nada', async () => {
    const r = runner();
    const controller = new AbortController();
    const done = r.run(graph('g1'), { signal: controller.signal });
    FakeWorker.all[0].reply(0, {});
    await done;
    controller.abort();
    expect(FakeWorker.all[0].terminated).toBe(false);
  });

  it('dispose termina el hilo y rechaza lo pendiente', async () => {
    const r = runner();
    const running = r.run(graph('g1'), {});
    const queued = r.run(graph('g2'), {});
    r.dispose();
    await expect(running).rejects.toSatisfy(isAbortError);
    await expect(queued).rejects.toSatisfy(isAbortError);
    expect(FakeWorker.all[0].terminated).toBe(true);
  });
});

describe('ElkWorkerRunner: sin hilo de trabajo calcula en el hilo actual', () => {
  it('si crear el hilo lanza, este trabajo y los siguientes van al hilo actual', async () => {
    const fallback = vi.fn<ElkRunner>(async (g) => placed(g.id));
    const r = new ElkWorkerRunner(() => {
      throw new Error('worker-src bloqueado por la política de seguridad');
    }, fallback);
    await expect(r.run(graph('g1'), {})).resolves.toEqual(placed('g1'));
    await expect(r.run(graph('g2'), {})).resolves.toEqual(placed('g2'));
    expect(fallback).toHaveBeenCalledTimes(2);
    expect(r.usesFallback).toBe(true);
  });

  it('si el hilo falla antes de contestar nada (no cargó su script), el trabajo en marcha y los encolados pasan al hilo actual', async () => {
    const fallback = vi.fn<ElkRunner>(async (g) => placed(g.id));
    const r = new ElkWorkerRunner(() => new FakeWorker(), fallback);
    const first = r.run(graph('g1'), {});
    const second = r.run(graph('g2'), {});
    FakeWorker.all[0].fail();
    await expect(first).resolves.toEqual(placed('g1'));
    await expect(second).resolves.toEqual(placed('g2'));
    expect(FakeWorker.all[0].terminated).toBe(true);
    expect(r.usesFallback).toBe(true);
    await expect(r.run(graph('g3'), {})).resolves.toEqual(placed('g3'));
    expect(FakeWorker.all).toHaveLength(1);
  });

  it('si falla después de haber contestado una vez, rechaza ese trabajo y el siguiente arranca otro hilo', async () => {
    const fallback = vi.fn<ElkRunner>(async (g) => placed(g.id));
    const r = new ElkWorkerRunner(() => new FakeWorker(), fallback);
    const ok = r.run(graph('g1'), {});
    FakeWorker.all[0].reply(0, {});
    await ok;
    const broken = r.run(graph('g2'), {});
    FakeWorker.all[0].fail();
    await expect(broken).rejects.toThrow(/falló/);
    expect(r.usesFallback).toBe(false);
    const again = r.run(graph('g3'), {});
    expect(FakeWorker.all).toHaveLength(2);
    FakeWorker.all[1].reply(0, { graph: placed('g3') });
    await expect(again).resolves.toEqual(placed('g3'));
    expect(fallback).not.toHaveBeenCalled();
  });
});

describe('layoutElk: dónde corre', () => {
  const root = (): ElkNode => ({ id: 'root', layoutOptions: { 'elk.algorithm': 'layered' }, children: [{ id: 'a', width: 40, height: 20 }, { id: 'b', width: 40, height: 20 }], edges: [{ id: 'e', sources: ['a'], targets: ['b'] }] });

  it('en Node (sin Worker) corre en el hilo actual y devuelve el grafo colocado', async () => {
    expect(elkPlace()).toBe('thread');
    const laid = await layoutElk(root());
    expect(laid.children?.every((c) => typeof c.x === 'number' && typeof c.y === 'number')).toBe(true);
  });

  it('con Worker en el entorno, el cálculo se pide al hilo de trabajo (con el protocolo de ELK)', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    expect(elkPlace()).toBe('worker');
    const pending = layoutElk(root());
    expect(FakeWorker.all).toHaveLength(1);
    const posted = FakeWorker.all[0].posted as unknown as Array<{ id: number; cmd: string; graph?: ElkNode }>;
    expect(posted.map((m) => m.cmd)).toEqual(['register', 'layout']);
    expect(posted[1].graph?.id).toBe('root');
    FakeWorker.all[0].onmessage?.({ data: { id: posted[1].id, data: placed('root') } });
    await expect(pending).resolves.toEqual(placed('root'));
  });

  it('?elk=thread fuerza el hilo actual aunque haya Worker', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('location', { search: '?module=data&elk=thread' });
    expect(elkPlace()).toBe('thread');
    await layoutElk(root());
    expect(FakeWorker.all).toHaveLength(0);
  });

  it('setElkRunner sustituye el lugar de cálculo y sin argumento vuelve a la elección automática', async () => {
    const custom = vi.fn<ElkRunner>(async (g) => placed(g.id));
    setElkRunner(custom);
    expect(elkPlace()).toBe('custom');
    await expect(layoutElk(graph('g1'))).resolves.toEqual(placed('g1'));
    expect(custom).toHaveBeenCalledTimes(1);
    setElkRunner(undefined);
    expect(elkPlace()).toBe('thread');
  });
});

describe('runElkInThread', () => {
  it('rechaza al instante con AbortError si la señal ya estaba abortada', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runElkInThread(graph('g1'), { signal: controller.signal })).rejects.toSatisfy(isAbortError);
  });

  it('abortar mientras calcula rechaza al momento y se ignora el resultado tardío', async () => {
    const controller = new AbortController();
    const pending = runElkInThread({ id: 'root', children: [{ id: 'a', width: 10, height: 10 }] }, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toSatisfy(isAbortError);
  });

  it('abortError es un Error con nombre AbortError', () => {
    const error = abortError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AbortError');
    expect(isAbortError(error)).toBe(true);
    expect(isAbortError(new Error('otro'))).toBe(false);
  });
});

describe('nativeElkWorker: el protocolo propio de ELK detrás del nuestro', () => {
  /** Un hilo de ELK de mentira: guarda lo que recibe y contesta como `elk-worker.min.js` (`{ id, data }` o `{ id, error }`). */
  class NativeWorker implements ElkWorkerLike {
    posted: Array<Record<string, unknown>> = [];
    terminated = false;
    onmessage: ElkWorkerLike['onmessage'] = null;
    onerror: ElkWorkerLike['onerror'] = null;
    postMessage(message: unknown): void {
      this.posted.push(message as Record<string, unknown>);
    }
    terminate(): void {
      this.terminated = true;
    }
    answer(reply: unknown): void {
      this.onmessage?.({ data: reply });
    }
  }

  it('registra los algoritmos al arrancar y manda el cálculo con la orden «layout»', () => {
    const native = new NativeWorker();
    const worker = nativeElkWorker(native);
    expect(native.posted[0]).toMatchObject({ id: 0, cmd: 'register' });
    expect(native.posted[0].algorithms).toContain('layered');
    worker.postMessage({ id: 7, graph: graph('g1') } satisfies ElkWorkerRequest);
    expect(native.posted[1]).toMatchObject({ id: 7, cmd: 'layout', graph: graph('g1') });
  });

  it('traduce la respuesta con datos, ignora la del registro y traduce los errores', () => {
    const native = new NativeWorker();
    const worker = nativeElkWorker(native);
    const received: ElkWorkerResponse[] = [];
    worker.onmessage = (event) => received.push(event.data as ElkWorkerResponse);
    native.answer({ id: 0 });
    native.answer({ id: 7, data: placed('g1') });
    native.answer({ id: 8, error: { name: 'UnsupportedConfigurationException', message: 'no se puede' } });
    native.answer({ id: 9, error: 'texto suelto' });
    expect(received).toEqual([
      { id: 7, ok: true, graph: placed('g1') },
      { id: 8, ok: false, error: { name: 'UnsupportedConfigurationException', message: 'no se puede' } },
      { id: 9, ok: false, error: { name: 'Error', message: 'texto suelto' } },
    ]);
  });

  it('terminate y onerror pasan al hilo real', () => {
    const native = new NativeWorker();
    const worker = nativeElkWorker(native);
    const onerror = vi.fn();
    worker.onerror = onerror;
    expect(native.onerror).toBe(onerror);
    worker.terminate();
    expect(native.terminated).toBe(true);
  });
});
