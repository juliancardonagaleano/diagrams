import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectError } from './errors';
import { EventsConnection, parseProjectEvent, SseParser, type EventsStatus, type ProjectEvent } from './events';
import { HttpProjectStore } from './http';

describe('SseParser', () => {
  it('lee mensajes con event y data, y los comentarios no son mensajes', () => {
    const parser = new SseParser();
    expect(parser.push('retry: 5000\nevent: ready\ndata: {"a":1}\n\n: hb\n\nevent: change\ndata: x\n\n')).toEqual([
      { event: 'ready', data: '{"a":1}' },
      { event: 'change', data: 'x' },
    ]);
  });

  it('junta varias líneas data con un salto, y un mensaje sin event es «message»', () => {
    expect(new SseParser().push('data: uno\ndata: dos\n\n')).toEqual([{ event: 'message', data: 'uno\ndos' }]);
  });

  it('aguanta que el flujo llegue cortado en cualquier punto, también en mitad de un \\r\\n y de un carácter', () => {
    const text = 'event: change\r\ndata: {"n":"añ"}\r\n\r\nevent: change\rdata: 2\r\r: hb\r\n\r\n';
    const whole = new SseParser().push(text);
    expect(whole).toEqual([
      { event: 'change', data: '{"n":"añ"}' },
      { event: 'change', data: '2' },
    ]);
    for (let size = 1; size < text.length; size += 1) {
      const parser = new SseParser();
      const out = [];
      for (let i = 0; i < text.length; i += size) out.push(...parser.push(text.slice(i, i + size)));
      expect(out, `en trozos de ${size}`).toEqual(whole);
    }
  });

  it('ignora el BOM inicial y los campos que no conoce, y un data sin línea en blanco no es mensaje todavía', () => {
    const parser = new SseParser();
    expect(parser.push('﻿id: 7\nfoo: bar\nevent: change\ndata: x\n')).toEqual([]);
    expect(parser.push('\n')).toEqual([{ event: 'change', data: 'x' }]);
  });

  it('avisa de cada línea recibida (también de los latidos) para el vigilante de silencio', () => {
    const activity = vi.fn();
    new SseParser().push(': hb\n\n', activity);
    expect(activity).toHaveBeenCalled();
  });

  it('corta un mensaje que no acaba nunca en vez de agotar la memoria', () => {
    expect(() => new SseParser().push(`data: ${'x'.repeat(300_000)}`)).toThrow(ProjectError);
    const parser = new SseParser();
    expect(() => {
      for (let i = 0; i < 10; i += 1) parser.push(`data: ${'x'.repeat(40_000)}\n`);
    }).toThrow(ProjectError);
  });
});

describe('parseProjectEvent', () => {
  const good = { type: 'diagram.saved', project: 'tienda', diagram: 'ventas', updatedAt: '2026-10-09T07:13:34.603Z', by: '@ana', at: '2026-10-09T07:13:34.609Z' };

  it('lee un aviso completo y uno mínimo', () => {
    expect(parseProjectEvent(JSON.stringify(good))).toEqual(good);
    expect(parseProjectEvent(JSON.stringify({ type: 'project.deleted', project: 'tienda', at: good.at }))).toEqual({ type: 'project.deleted', project: 'tienda', at: good.at });
  });

  it('acepta un tipo que no conoce (sirve para volver a leer la lista) pero no uno que no parece un tipo', () => {
    expect(parseProjectEvent(JSON.stringify({ ...good, type: 'diagram.moved' }))?.type).toBe('diagram.moved');
    for (const type of ['', 'x', 'a.b.c', 'A.b', '<script>', 5, null]) expect(parseProjectEvent(JSON.stringify({ ...good, type })), String(type)).toBeUndefined();
  });

  it('descarta lo que no tiene lo mínimo y los campos con forma rara en vez de pasarlos a la interfaz', () => {
    for (const bad of ['', 'no es json', 'null', '[]', '5', JSON.stringify({ type: 'project.changed' }), JSON.stringify({ ...good, project: '../x' }), JSON.stringify({ ...good, project: 'a'.repeat(200) })]) {
      expect(parseProjectEvent(bad), bad).toBeUndefined();
    }
    const dirty = parseProjectEvent(JSON.stringify({ ...good, diagram: 'con espacio', updatedAt: 'ayer', by: 'x'.repeat(500), at: 'ahora' }))!;
    expect(dirty).toMatchObject({ project: 'tienda' });
    expect(dirty).not.toHaveProperty('diagram');
    expect(dirty).not.toHaveProperty('updatedAt');
    expect(dirty).not.toHaveProperty('by');
    expect(dirty.at).toMatch(/^\d{4}-/); // la marca de tiempo se repone con la hora local
  });
});

// ───────────── la conexión ─────────────

/** Un servidor de eventos simulado: cada llamada a `fetch` recibe la siguiente respuesta preparada. */
function scripted() {
  const encoder = new TextEncoder();
  const calls: Array<{ url: string; headers: Record<string, string>; signal: AbortSignal | undefined }> = [];
  const queue: Array<(call: (typeof calls)[number]) => Response | Promise<Response> | Error> = [];
  const channels: ReadableStreamDefaultController<Uint8Array>[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call = { url: String(input), headers: Object.fromEntries(new Headers(init.headers).entries()), signal: init.signal ?? undefined };
    calls.push(call);
    const next = queue.shift();
    if (!next) throw new TypeError('Failed to fetch');
    const out = await next(call);
    if (out instanceof Error) throw out;
    return out;
  }) as typeof fetch;
  /** Una respuesta de flujo abierto; el controlador queda en `channels` para empujar texto o cortar. */
  const stream = (initial = 'event: ready\ndata: {"heartbeatMs":1000}\n\n') => (call: { signal: AbortSignal | undefined }): Response => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        channels.push(controller);
        if (initial) controller.enqueue(encoder.encode(initial));
        call.signal?.addEventListener('abort', () => {
          try {
            controller.error(call.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
          } catch {
            /* cerrado */
          }
        });
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
  };
  const push = (text: string): void => channels[channels.length - 1].enqueue(encoder.encode(text));
  const cut = (): void => channels[channels.length - 1].error(new TypeError('network error'));
  const change = (e: Partial<ProjectEvent> = {}): string => `event: change\ndata: ${JSON.stringify({ type: 'diagram.saved', project: 'tienda', diagram: 'ventas', at: '2026-10-09T07:13:34.609Z', ...e })}\n\n`;
  return { fetch: fetchFn, calls, queue, stream, push, cut, change, channels };
}

describe('EventsConnection', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function connect(server: ReturnType<typeof scripted>, options: ConstructorParameters<typeof EventsConnection>[2] = {}, token: string | null = 'secreto') {
    const events: ProjectEvent[] = [];
    const statuses: EventsStatus[] = [];
    let current: string | undefined = token ?? undefined;
    const connection = new EventsConnection({ baseUrl: 'https://iark.example', token: () => current, fetch: server.fetch }, { onEvent: (e) => events.push(e), onStatus: (s) => statuses.push(s) }, { random: () => 0.5, ...options });
    return { connection, events, statuses, states: () => statuses.map((s) => s.state), setToken: (t: string | undefined) => (current = t) };
  }
  const tick = async (ms = 0): Promise<void> => void (await vi.advanceTimersByTimeAsync(ms));

  it('abre el canal con la cabecera Authorization (nunca el token en la dirección), pasa a «en directo» con ready y entrega los avisos', async () => {
    const server = scripted();
    server.queue.push(server.stream());
    const { connection, events, states } = connect(server, { project: 'tienda' });
    connection.start();
    await tick();
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0].url).toBe('https://iark.example/api/events?project=tienda');
    expect(server.calls[0].headers.authorization).toBe('Bearer secreto');
    expect(server.calls[0].headers.accept).toBe('text/event-stream');
    expect(server.calls[0].url).not.toContain('secreto');
    expect(states()).toEqual(['connecting', 'live']);
    server.push(server.change({ updatedAt: '2026-10-09T07:13:34.603Z', by: '@ana' }));
    server.push(`: hb\n\n${server.change({ type: 'diagram.deleted' })}`);
    await tick();
    expect(events.map((e) => e.type)).toEqual(['diagram.saved', 'diagram.deleted']);
    expect(events[0]).toMatchObject({ project: 'tienda', diagram: 'ventas', by: '@ana' });
    connection.stop();
  });

  it('sin token no envía Authorization, y un aviso mal formado se descarta sin tumbar la conexión', async () => {
    const server = scripted();
    server.queue.push(server.stream());
    const { connection, events, states } = connect(server, {}, null);
    connection.start();
    await tick();
    expect(server.calls[0].headers.authorization).toBeUndefined();
    server.push('event: change\ndata: {no es json\n\n');
    server.push(server.change());
    await tick();
    expect(events).toHaveLength(1);
    expect(states().at(-1)).toBe('live');
    connection.stop();
  });

  it('un manejador que falla no corta el canal', async () => {
    const server = scripted();
    server.queue.push(server.stream());
    const seen: string[] = [];
    const connection = new EventsConnection({ baseUrl: 'https://iark.example', token: () => undefined, fetch: server.fetch }, { onEvent: (e) => { seen.push(e.type); throw new Error('mal'); } });
    connection.start();
    await tick();
    server.push(server.change());
    server.push(server.change({ type: 'diagram.created' }));
    await tick();
    expect(seen).toEqual(['diagram.saved', 'diagram.created']);
    connection.stop();
  });

  it('si el servidor corta, reconecta con espera exponencial (1 s, 2 s, 4 s…) y sin pasarse del tope; el estado cuenta cuánto falta', async () => {
    const server = scripted();
    for (let i = 0; i < 4; i += 1) server.queue.push(() => new TypeError('Failed to fetch'));
    const { connection, statuses } = connect(server, { baseMs: 1000, maxMs: 5000 });
    connection.start();
    await tick();
    expect(server.calls).toHaveLength(1);
    expect(statuses.at(-1)).toMatchObject({ state: 'retrying', retryInMs: 1000 });
    await tick(999);
    expect(server.calls).toHaveLength(1);
    await tick(1);
    expect(server.calls).toHaveLength(2);
    expect(statuses.at(-1)).toMatchObject({ state: 'retrying', retryInMs: 2000 });
    await tick(2000);
    expect(statuses.at(-1)).toMatchObject({ retryInMs: 4000 });
    await tick(4000);
    expect(statuses.at(-1)).toMatchObject({ retryInMs: 5000 }); // el tope
    expect(statuses.at(-1)!.error).toBeInstanceOf(ProjectError);
    expect(statuses.at(-1)!.error!.info.network).toBe(true);
    connection.stop();
  });

  it('el azar reparte las reconexiones (±25 %) para que no vuelvan todas a la vez', async () => {
    const delays = new Set<number>();
    for (const random of [0, 0.5, 1]) {
      const server = scripted();
      const { connection, statuses } = connect(server, { baseMs: 1000, random: () => random });
      connection.start();
      await tick();
      delays.add(statuses.at(-1)!.retryInMs!);
      connection.stop();
    }
    expect([...delays].sort((a, b) => a - b)).toEqual([750, 1000, 1250]);
  });

  it('tras una conexión estable la espera vuelve a empezar; tras una que cae enseguida, sigue creciendo', async () => {
    const server = scripted();
    const calm = 'event: ready\ndata: {"heartbeatMs":60000}\n\n';
    server.queue.push(server.stream(calm), server.stream(calm), server.stream(calm), () => new TypeError('Failed to fetch'));
    const { connection, statuses } = connect(server, { baseMs: 1000, maxMs: 60_000 });
    connection.start();
    await tick();
    server.cut(); // cae al instante: no cuenta como estable
    await tick();
    expect(statuses.at(-1)).toMatchObject({ state: 'retrying', retryInMs: 1000 });
    await tick(1000);
    await tick(10_000); // esta se mantiene 10 s
    server.cut();
    await tick();
    expect(statuses.at(-1)).toMatchObject({ state: 'retrying', retryInMs: 1000 }); // vuelve a empezar
    connection.stop();
  });

  it('un 404, un 501 o un 200 que no es un flujo (la página de un servidor anterior) es «sin soporte»: no reintenta nunca', async () => {
    for (const make of [
      () => new Response('{"error":"no existe"}', { status: 404 }),
      () => new Response('', { status: 501 }),
      () => new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
      () => new Response('x', { status: 400 }),
    ]) {
      const server = scripted();
      server.queue.push(make);
      const { connection, statuses } = connect(server);
      connection.start();
      await tick();
      await tick(10 * 60_000);
      expect(server.calls, String(make)).toHaveLength(1);
      expect(statuses.at(-1)).toMatchObject({ state: 'unsupported' });
      expect(statuses.at(-1)!.error!.code).toBe('unsupported');
    }
  });

  it('un 401 o un 403 es «rechazado»: no reintenta (cada intento sumaría un fallo de autenticación) hasta que llega un token nuevo', async () => {
    const server = scripted();
    server.queue.push(() => new Response('{"code":"unauthorized"}', { status: 401 }), server.stream());
    const { connection, statuses, setToken } = connect(server);
    connection.start();
    await tick();
    await tick(10 * 60_000);
    expect(server.calls).toHaveLength(1);
    expect(statuses.at(-1)).toMatchObject({ state: 'rejected' });
    expect(statuses.at(-1)!.error!.code).toBe('unauthorized');
    setToken('nuevo');
    connection.kick();
    await tick();
    expect(server.calls).toHaveLength(2);
    expect(server.calls[1].headers.authorization).toBe('Bearer nuevo');
    expect(statuses.at(-1)).toMatchObject({ state: 'live' });
    connection.stop();
  });

  it('un 403 también es rechazado, con su propio código', async () => {
    const server = scripted();
    server.queue.push(() => new Response('', { status: 403 }));
    const { connection, statuses } = connect(server);
    connection.start();
    await tick();
    expect(statuses.at(-1)).toMatchObject({ state: 'rejected' });
    expect(statuses.at(-1)!.error!.code).toBe('forbidden');
  });

  it('un 429 espera lo que diga Retry-After (nunca menos que la espera propia) y un 5xx reintenta', async () => {
    const server = scripted();
    server.queue.push(() => new Response('', { status: 429, headers: { 'Retry-After': '30' } }), () => new Response('', { status: 503 }), server.stream());
    const { connection, statuses } = connect(server, { baseMs: 1000 });
    connection.start();
    await tick();
    expect(statuses.at(-1)).toMatchObject({ state: 'retrying', retryInMs: 30_000 });
    await tick(29_999);
    expect(server.calls).toHaveLength(1);
    await tick(1);
    expect(server.calls).toHaveLength(2);
    expect(statuses.at(-1)).toMatchObject({ state: 'retrying' }); // el 503
    await tick(2000);
    expect(statuses.at(-1)).toMatchObject({ state: 'live' });
    connection.stop();
  });

  it('da por muerta una conexión que calla más de tres latidos y reconecta', async () => {
    const server = scripted();
    server.queue.push(server.stream('event: ready\ndata: {"heartbeatMs":10000}\n\n'), server.stream());
    const { connection, statuses } = connect(server, { baseMs: 1000 });
    connection.start();
    await tick();
    expect(statuses.at(-1)).toMatchObject({ state: 'live' });
    // los latidos mantienen viva la conexión…
    for (let i = 0; i < 5; i += 1) {
      await tick(20_000);
      server.push(': hb\n\n');
    }
    expect(server.calls).toHaveLength(1);
    // …y 30 s de silencio la matan
    await tick(30_000);
    expect(statuses.at(-1)).toMatchObject({ state: 'retrying' });
    expect(statuses.at(-1)!.error!.message).toMatch(/latidos/);
    await tick(1500);
    expect(server.calls).toHaveLength(2);
    connection.stop();
  });

  it('bye «unauthorized» deja el canal rechazado sin reintentar; bye «shutdown» reconecta', async () => {
    const server = scripted();
    server.queue.push(server.stream(), server.stream(), server.stream());
    const { connection, statuses } = connect(server, { baseMs: 1000 });
    connection.start();
    await tick();
    server.push('event: bye\ndata: {"reason":"shutdown"}\n\n');
    server.channels[0].close();
    await tick();
    expect(statuses.at(-1)).toMatchObject({ state: 'retrying' });
    await tick(1000);
    expect(server.calls).toHaveLength(2);
    server.push('event: bye\ndata: {"reason":"unauthorized"}\n\n');
    await tick();
    await tick(10 * 60_000);
    expect(server.calls).toHaveLength(2);
    expect(statuses.at(-1)).toMatchObject({ state: 'rejected' });
  });

  it('stop corta la conexión, cancela los reintentos y no vuelve a llamar al manejador', async () => {
    const server = scripted();
    server.queue.push(server.stream());
    const { connection, events, statuses } = connect(server);
    connection.start();
    await tick();
    const signal = server.calls[0].signal!;
    connection.stop();
    expect(signal.aborted).toBe(true);
    await tick(10 * 60_000);
    expect(server.calls).toHaveLength(1);
    expect(statuses.at(-1)).toMatchObject({ state: 'stopped' });
    expect(events).toEqual([]);

    // y parar durante la espera de un reintento también lo cancela
    const other = scripted();
    const second = connect(other);
    second.connection.start();
    await tick();
    expect(second.statuses.at(-1)).toMatchObject({ state: 'retrying' });
    second.connection.stop();
    await tick(10 * 60_000);
    expect(other.calls).toHaveLength(1);
  });

  it('un servidor que tarda en responder al abrir se da por caído a los 20 s', async () => {
    const hang = scripted();
    hang.queue.push(({ signal }) => new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason))) as unknown as Response);
    const { connection, statuses } = connect(hang);
    connection.start();
    await tick(19_999);
    expect(statuses.at(-1)).toMatchObject({ state: 'connecting' });
    await tick(1);
    expect(statuses.at(-1)).toMatchObject({ state: 'retrying' });
    expect(statuses.at(-1)!.error!.message).toMatch(/no respondió/);
    connection.stop();
  });

  it('kick vuelve a conectar ya, con la espera mínima, aunque estuviera esperando un reintento largo', async () => {
    const server = scripted();
    server.queue.push(() => new TypeError('x'), () => new TypeError('x'), () => new TypeError('x'), server.stream());
    const { connection, statuses } = connect(server, { baseMs: 1000 });
    connection.start();
    await tick();
    await tick(1000);
    await tick(2000);
    expect(statuses.at(-1)).toMatchObject({ state: 'retrying', retryInMs: 4000 });
    connection.kick();
    await tick();
    expect(statuses.at(-1)).toMatchObject({ state: 'live' });
    connection.stop();
  });
});

describe('HttpProjectStore.watchEvents', () => {
  it('abre el canal con el token del almacén y lo reconecta con el nuevo cuando cambia (setToken)', async () => {
    vi.useFakeTimers();
    try {
      const server = scripted();
      server.queue.push(server.stream(), server.stream(), server.stream());
      const store = new HttpProjectStore({ baseUrl: 'https://iark.example/', token: 'uno', fetch: server.fetch });
      const watch = store.watchEvents({ onEvent: () => undefined });
      await vi.advanceTimersByTimeAsync(0);
      expect(server.calls[0].headers.authorization).toBe('Bearer uno');
      store.setToken('uno'); // el mismo: no reconecta
      await vi.advanceTimersByTimeAsync(0);
      expect(server.calls).toHaveLength(1);
      store.setToken('dos');
      await vi.advanceTimersByTimeAsync(0);
      expect(server.calls).toHaveLength(2);
      expect(server.calls[1].headers.authorization).toBe('Bearer dos');
      expect(server.calls[0].signal!.aborted).toBe(true);
      watch.stop();
      expect(server.calls[1].signal!.aborted).toBe(true);
      store.setToken('tres'); // cerrado: ya no hay nada que reconectar
      await vi.advanceTimersByTimeAsync(0);
      expect(server.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
