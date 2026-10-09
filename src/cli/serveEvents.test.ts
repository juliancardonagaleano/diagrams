import { mkdirSync, mkdtempSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseProjectEvent, SseParser, type ProjectEvent, type SseMessage } from '@iark/kernel';
import { Observability } from './observability';
import { createDefaultRegistry } from './registry';
import { createSuiteServer, type ServeOptions } from './serve';
import { createToken, revokeToken } from './tokens';
import { FolderProjectStore } from './workspace';
import { ANA, BETO, call, CARLA, cleanupCloud, example, signIn, startCloud, tracked, type Cloud, type CloudOptions } from '../../tests/helpers/cloud';
import { memorySink } from '../../tests/helpers/observability';

/**
 * Cambios en tiempo real (`GET /api/events`): el servidor de verdad (`createSuiteServer`) con un canal abierto por `fetch`, como lo hace el navegador.
 * Se comprueba qué avisos salen y a quién (cada cambio solo llega a quien pertenece al proyecto), que no llevan contenido, la autenticación (también
 * mientras el canal está abierto), los topes, el latido, el cierre ordenado al parar, las mismas protecciones de `Host` y `Origin` de siempre y cómo
 * quedan el registro de accesos y las métricas.
 */

const { folders, servers } = tracked;
const open: Array<() => void> = [];
afterEach(async () => {
  for (const close of open.splice(0)) close();
  await cleanupCloud();
});

/** Un canal abierto: lo que llega, ya interpretado, y cómo cerrarlo. */
interface Stream {
  status: number;
  headers: Headers;
  /** El cuerpo de la respuesta si no fue un canal (un error). */
  body: string;
  messages: SseMessage[];
  /** Todo el texto recibido (con los latidos). */
  raw: string;
  changes(): ProjectEvent[];
  /** Espera un mensaje que cumpla la condición. */
  until(match: (m: SseMessage) => boolean, message?: string): Promise<SseMessage>;
  /** Espera un cambio que cumpla la condición. */
  change(match: (e: ProjectEvent) => boolean): Promise<ProjectEvent>;
  /** Terminó (el servidor lo cerró o se cortó). */
  readonly ended: boolean;
  close(): void;
}

async function openStream(base: string, token?: string, path = '/api/events', headers: Record<string, string> = {}): Promise<Stream> {
  const controller = new AbortController();
  const response = await fetch(`${base}${path}`, { headers: { Accept: 'text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, signal: controller.signal });
  const stream: Stream = {
    status: response.status,
    headers: response.headers,
    body: '',
    messages: [],
    raw: '',
    ended: false,
    changes: () => stream.messages.filter((m) => m.event === 'change').flatMap((m) => parseProjectEvent(m.data) ?? []),
    until: (match, message) => vi.waitFor(() => {
      const found = stream.messages.find(match);
      if (!found) throw new Error(message ?? `no llegó el mensaje esperado; recibido: ${JSON.stringify(stream.messages)}`);
      return found;
    }),
    change: (match) => vi.waitFor(() => {
      const found = stream.changes().find(match);
      if (!found) throw new Error(`no llegó el cambio esperado; recibido: ${JSON.stringify(stream.changes())}`);
      return found;
    }),
    close: () => controller.abort(),
  };
  open.push(stream.close);
  if (!response.ok || !(response.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
    stream.body = await response.text();
    return stream;
  }
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const reader = response.body!.getReader();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        stream.raw += text;
        stream.messages.push(...parser.push(text));
      }
    } catch {
      /* cortado */
    }
    (stream as { ended: boolean }).ended = true;
  })();
  return stream;
}

const fast = { events: { heartbeatMs: 40 } };

describe('GET /api/events: sin autenticación', () => {
  async function plain(options: Partial<ServeOptions> = {}, workspace = true): Promise<{ base: string; server: Server; root: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'iark-eventos-'));
    folders.push(dir);
    const root = join(dir, 'espacio');
    mkdirSync(root);
    const server = createSuiteServer({ registry: createDefaultRegistry(), version: '1', ...(workspace ? { projects: new FolderProjectStore(root) } : {}), ...options });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, root };
  }

  it('abre un canal text/event-stream con las cabeceras que un proxy necesita para no acumularlo, y avisa con ready', async () => {
    const { base } = await plain(fast);
    const stream = await openStream(base);
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(stream.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(stream.headers.get('x-accel-buffering')).toBe('no');
    expect(stream.headers.get('x-content-type-options')).toBe('nosniff');
    expect(stream.headers.get('x-request-id')).toBeTruthy();
    expect(stream.headers.get('content-encoding')).toBeNull();
    expect(stream.headers.get('content-length')).toBeNull();
    const ready = await stream.until((m) => m.event === 'ready');
    expect(JSON.parse(ready.data)).toEqual({ heartbeatMs: 40 });
  });

  it('sin --workspace, con otro método o con el canal desactivado responde 404 o 405 (nada se queda abierto)', async () => {
    const none = await plain({}, false);
    expect((await fetch(`${none.base}/api/events`)).status).toBe(404);
    const { base } = await plain(fast);
    const post = await fetch(`${base}/api/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET');
    expect((await fetch(`${base}/api/events/otra`)).status).toBe(404);
    expect((await fetch(`${base}/api/events?project=..%2F..`)).status).toBe(400);
    const off = await plain({ events: false });
    const refused = await fetch(`${off.base}/api/events`);
    expect(refused.status).toBe(404);
    expect((await refused.json()).error).toMatch(/max-streams 0/);
    // y el manifiesto lo cuenta: con canal lo anuncia, sin él (o sin proyectos) no
    expect((await (await fetch(`${off.base}/.well-known/iark.json`)).json()).projectsEvents).toBeUndefined();
    expect((await (await fetch(`${none.base}/.well-known/iark.json`)).json()).projectsEvents).toBeUndefined();
    expect((await (await fetch(`${base}/.well-known/iark.json`)).json()).projectsEvents).toBe('../api/events');
  });

  it('avisa de cada cambio, en orden, con identificadores y marcas y sin el documento', async () => {
    const { base } = await plain(fast);
    const stream = await openStream(base);
    await stream.until((m) => m.event === 'ready');
    const api = call(base);

    const project = (await (await api.post('/api/projects', { name: 'Tienda' })).json()) as { id: string; updatedAt: string };
    const diagram = (await (await api.post(`/api/projects/${project.id}/diagrams`, { module: 'data', name: 'Ventas', text: example('ventas-datos.json') })).json()) as { id: string; updatedAt: string };
    // la primera versión se nombra para que no la sustituya el guardado siguiente: así hay a qué volver
    const [first] = (await (await api.get(`/api/projects/${project.id}/diagrams/${diagram.id}/versions`)).json()) as Array<{ id: number }>;
    expect((await api.patch(`/api/projects/${project.id}/diagrams/${diagram.id}/versions/${first.id}`, { label: 'base' })).status).toBe(200);
    const saved = (await (await api.put(`/api/projects/${project.id}/diagrams/${diagram.id}`, { text: example('ventas-datos.json').replace('"Ventas', '"Ventas 2') })).json()) as { updatedAt: string };
    await api.patch(`/api/projects/${project.id}/diagrams/${diagram.id}`, { name: 'Ventas renombrado' });
    await api.patch(`/api/projects/${project.id}`, { name: 'Tienda 2' });
    const restored = await api.post(`/api/projects/${project.id}/diagrams/${diagram.id}/versions/${first.id}/restore`, {});
    expect(restored.status).toBe(200);
    await api.del(`/api/projects/${project.id}/diagrams/${diagram.id}`);
    await api.del(`/api/projects/${project.id}`);

    await stream.change((e) => e.type === 'project.deleted');
    expect(stream.changes().map((e) => `${e.type} ${e.project}${e.diagram ? ` ${e.diagram}` : ''}`)).toEqual([
      `project.created ${project.id}`,
      `diagram.created ${project.id} ${diagram.id}`,
      `diagram.saved ${project.id} ${diagram.id}`,
      `diagram.renamed ${project.id} ${diagram.id}`,
      `project.changed ${project.id}`,
      `diagram.restored ${project.id} ${diagram.id}`,
      `diagram.deleted ${project.id} ${diagram.id}`,
      `project.deleted ${project.id}`,
    ]);
    const changes = stream.changes();
    expect(changes[0].updatedAt).toBe(project.updatedAt);
    expect(changes[1].updatedAt).toBe(diagram.updatedAt);
    expect(changes[2].updatedAt).toBe(saved.updatedAt);
    expect(changes[7].updatedAt).toBeUndefined();
    for (const change of changes) expect(change.at).toMatch(/^\d{4}-\d\d-\d\dT/);
    // sin autenticación no se sabe quién fue, y nada de contenido: ni el documento, ni nombres
    expect(stream.raw).not.toContain('"by"');
    for (const secret of ['Ventas', 'Tienda', 'workspace', '"text"', '"name"']) expect(stream.raw, secret).not.toContain(secret);
  });

  it('una petición que falla o no cambia nada no avisa: ni un conflicto, ni una lectura, ni un rol insuficiente', async () => {
    const { base } = await plain(fast);
    const api = call(base);
    const project = (await (await api.post('/api/projects', { name: 'Tienda' })).json()) as { id: string };
    const diagram = (await (await api.post(`/api/projects/${project.id}/diagrams`, { module: 'data', name: 'Ventas', text: example('ventas-datos.json') })).json()) as { id: string; updatedAt: string };
    const stream = await openStream(base);
    await stream.until((m) => m.event === 'ready');
    expect((await api.put(`/api/projects/${project.id}/diagrams/${diagram.id}`, { text: 'x', ifUpdatedAt: '2000-01-01T00:00:00.000Z' })).status).toBe(409);
    expect((await api.get(`/api/projects/${project.id}/diagrams/${diagram.id}`)).status).toBe(200);
    expect((await api.put(`/api/projects/${project.id}/diagrams/${diagram.id}`, {})).status).toBe(400);
    expect((await api.del('/api/projects/no-existe')).status).toBe(404);
    // un cambio de verdad al final marca que lo anterior ya habría llegado
    await api.patch(`/api/projects/${project.id}`, { name: 'Otra' });
    await stream.change((e) => e.type === 'project.changed');
    expect(stream.changes()).toHaveLength(1);
  });

  it('con ?project= solo avisa de ese proyecto', async () => {
    const { base } = await plain(fast);
    const api = call(base);
    const a = (await (await api.post('/api/projects', { name: 'Uno' })).json()) as { id: string };
    const b = (await (await api.post('/api/projects', { name: 'Dos' })).json()) as { id: string };
    const stream = await openStream(base, undefined, `/api/events?project=${a.id}`);
    await stream.until((m) => m.event === 'ready');
    await api.patch(`/api/projects/${b.id}`, { name: 'Dos bis' });
    await api.patch(`/api/projects/${a.id}`, { name: 'Uno bis' });
    await stream.change((e) => e.type === 'project.changed');
    expect(stream.changes().map((e) => e.project)).toEqual([a.id]);
  });

  it('mantiene la conexión con latidos y los reconoce un lector de eventos (son comentarios)', async () => {
    const { base } = await plain(fast);
    const stream = await openStream(base);
    await vi.waitFor(() => expect((stream.raw.match(/^: hb$/gm) ?? []).length).toBeGreaterThanOrEqual(3));
    expect(stream.messages.map((m) => m.event)).toEqual(['ready']); // los latidos no son mensajes
  });

  it('protege como el resto de /api/projects: Host de otro nombre y Origin ajeno son 403; el propio sitio y los de --cors pasan', async () => {
    const { base } = await plain({ ...fast, cors: ['https://app.ejemplo.org'] });
    const url = new URL(base);
    const get = (headers: Record<string, string>): Promise<number> =>
      new Promise((resolve, reject) => {
        const req = httpRequest({ host: url.hostname, port: url.port, path: '/api/events', headers }, (res) => {
          res.destroy();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
    expect(await get({ Host: 'atacante.example' })).toBe(403);
    expect(await get({ Origin: 'https://atacante.example' })).toBe(403);
    expect(await get({ Origin: 'null' })).toBe(403);
    expect(await get({ Origin: 'https://app.ejemplo.org' })).toBe(200);
    expect(await get({ Origin: `http://${url.host}` })).toBe(200);
    expect(await get({})).toBe(200);
  });

  it('al parar el servidor avisa con bye y cierra los canales (server.close no se queda esperando)', async () => {
    const { base, server } = await plain(fast);
    const stream = await openStream(base);
    await stream.until((m) => m.event === 'ready');
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    const bye = await stream.until((m) => m.event === 'bye');
    expect(JSON.parse(bye.data)).toEqual({ reason: 'shutdown' });
    await closed;
    await vi.waitFor(() => expect(stream.ended).toBe(true));
    // y ya no admite canales nuevos mientras se cierra
  });
});

describe('GET /api/events: topes por persona', () => {
  it('rechaza con 429 y Retry-After el canal que pasa del tope de la persona; al cerrar uno cabe otro; el tope de una no afecta a otra', async () => {
    const cloud = await startCloud({ tokens: true, serve: { events: { heartbeatMs: 40, maxPerPerson: 2 } } });
    const lola = createToken(cloud.tokens!.file, { name: 'lola', role: 'viewer' }).token;
    const admin = cloud.tokens!.admin;
    const first = await openStream(cloud.base, admin);
    const second = await openStream(cloud.base, admin);
    await Promise.all([first.until((m) => m.event === 'ready'), second.until((m) => m.event === 'ready')]);
    const third = await openStream(cloud.base, admin);
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toBe('30');
    expect(JSON.parse(third.body)).toMatchObject({ code: 'limit' });
    expect(third.body).not.toContain(admin);
    // otra persona (otro nombre de token) tiene el suyo
    const other = await openStream(cloud.base, lola);
    expect(other.status).toBe(200);
    // al cerrarse uno, cabe otro
    first.close();
    await vi.waitFor(async () => expect((await openStream(cloud.base, admin)).status).toBe(200));
  });

  it('el tope global también se aplica, y cada rechazo y cada canal abierto se cuentan', async () => {
    const obs = new Observability({ metrics: true, version: 'prueba' });
    const cloud = await startCloud({ tokens: true, serve: { observability: obs, metricsToken: 'm3tr1cas-token-0123456789abcdef', events: { heartbeatMs: 40, maxPerPerson: 5, maxTotal: 2 } } });
    const a = await openStream(cloud.base, cloud.tokens!.admin);
    const b = await openStream(cloud.base, cloud.tokens!.admin);
    await Promise.all([a.until((m) => m.event === 'ready'), b.until((m) => m.event === 'ready')]);
    expect((await openStream(cloud.base, cloud.tokens!.admin)).status).toBe(429);
    const metrics = await (await fetch(`${cloud.base}/metrics`, { headers: { Authorization: 'Bearer m3tr1cas-token-0123456789abcdef' } })).text();
    expect(metrics).toMatch(/^iark_event_streams 2$/m);
    expect(metrics).toMatch(/^iark_event_streams_rejected_total 1$/m);
    // abrir canales no cuenta como peticiones en curso (un canal abierto no es una petición «colgada»)
    expect(metrics).toMatch(/^iark_http_requests_in_flight 1$/m); // solo la lectura de las métricas
    // y ni su duración (horas) es latencia: al cerrarse cuentan como peticiones, pero solo el 429 (una petición normal) entra en el histograma
    a.close();
    b.close();
    const cerradas = async (): Promise<string> => (await fetch(`${cloud.base}/metrics`, { headers: { Authorization: 'Bearer m3tr1cas-token-0123456789abcdef' } })).text();
    await vi.waitFor(async () => expect(await cerradas()).toMatch(/iark_http_requests_total\{method="GET",route="\/api\/events",status_class="2xx"\} 2/));
    const after = await cerradas();
    expect(after).toMatch(/iark_http_request_duration_seconds_count\{route="\/api\/events"\} 1/);
    expect(after).toMatch(/^iark_event_streams 0$/m);
    await obs.close();
  });
});

describe('GET /api/events: con tokens', () => {
  it('sin token o con uno que no existe responde 401 como el resto de la API (y sin decir cuál de las dos fue)', async () => {
    const cloud = await startCloud({ tokens: true, serve: fast });
    const none = await openStream(cloud.base);
    expect(none.status).toBe(401);
    expect(JSON.parse(none.body)).toMatchObject({ code: 'unauthorized' });
    expect(none.headers.get('www-authenticate')).toBe('Bearer realm="iark"');
    const bad = await openStream(cloud.base, 'iark_noexiste');
    expect(bad.status).toBe(401);
    expect(bad.body).toBe(none.body);
    // el token en la dirección no vale: solo la cabecera
    expect((await fetch(`${cloud.base}/api/events?token=${cloud.tokens!.admin}`)).status).toBe(401);
  });

  it('un token de solo lectura recibe los cambios de todos los proyectos con el nombre del token de quien los hizo', async () => {
    const cloud = await startCloud({ tokens: true, serve: fast });
    const viewer = createToken(cloud.tokens!.file, { name: 'lectora', role: 'viewer' }).token;
    const editor = createToken(cloud.tokens!.file, { name: 'editora', role: 'editor' }).token;
    const stream = await openStream(cloud.base, viewer);
    await stream.until((m) => m.event === 'ready');
    const created = (await (await call(cloud.base, editor).post('/api/projects', { name: 'Tienda' })).json()) as { id: string };
    const change = await stream.change((e) => e.type === 'project.created');
    expect(change).toMatchObject({ project: created.id, by: 'editora' });
    expect(stream.raw).not.toContain(viewer);
    expect(stream.raw).not.toContain(editor);
  });

  it('si se revoca el token con el canal abierto, el siguiente latido lo cierra con bye', async () => {
    const cloud = await startCloud({ tokens: true, serve: fast });
    const token = createToken(cloud.tokens!.file, { name: 'temporal', role: 'viewer' }).token;
    const stream = await openStream(cloud.base, token);
    await stream.until((m) => m.event === 'ready');
    revokeToken(cloud.tokens!.file, 'temporal');
    const bye = await stream.until((m) => m.event === 'bye');
    expect(JSON.parse(bye.data)).toEqual({ reason: 'unauthorized' });
    await vi.waitFor(() => expect(stream.ended).toBe(true));
    // y ya no abre otro
    expect((await openStream(cloud.base, token)).status).toBe(401);
  });

  it('un fallo pasajero al volver a comprobar (el freno de intentos fallidos de la dirección) no echa a quien ya estaba conectado', async () => {
    const cloud = await startCloud({ tokens: true, serve: { ...fast, authLimits: { freeAttempts: 2 } } });
    const stream = await openStream(cloud.base, cloud.tokens!.admin);
    await stream.until((m) => m.event === 'ready');
    // alguien desde la misma dirección falla hasta quedar frenada: el canal abierto sigue
    for (let i = 0; i < 4; i += 1) await fetch(`${cloud.base}/api/whoami`, { headers: { Authorization: 'Bearer malo' } });
    const before = stream.raw.length;
    await vi.waitFor(() => expect(stream.raw.length).toBeGreaterThan(before + 10), { timeout: 2000 });
    expect(stream.messages.some((m) => m.event === 'bye')).toBe(false);
    expect(stream.ended).toBe(false);
  });
});

describe.each(['json', 'sqlite'] as const)('GET /api/events: con cuentas de GitHub (almacén %s)', (store) => {
  async function people(options: CloudOptions = {}): Promise<{ cloud: Cloud; ana: string; beto: string; carla: string }> {
    const cloud = await startCloud({ store, signup: 'open', serve: fast, ...options });
    return { cloud, ana: await signIn(cloud, ANA), beto: await signIn(cloud, BETO), carla: await signIn(cloud, CARLA) };
  }

  it('cada persona solo recibe los cambios de los proyectos a los que pertenece, con @usuario de quien los hizo; la administradora de la instancia los ve todos', async () => {
    const { cloud, ana, beto, carla } = await people();
    const [sAna, sBeto, sCarla] = await Promise.all([openStream(cloud.base, ana), openStream(cloud.base, beto), openStream(cloud.base, carla)]);
    await Promise.all([sAna, sBeto, sCarla].map((s) => s.until((m) => m.event === 'ready')));

    const tienda = (await (await call(cloud.base, beto).post('/api/projects', { name: 'Tienda' })).json()) as { id: string };
    const diagram = (await (await call(cloud.base, beto).post(`/api/projects/${tienda.id}/diagrams`, { module: 'data', name: 'Ventas', text: example('ventas-datos.json') })).json()) as { id: string };
    // Carla crea el suyo: es la señal de que lo anterior ya habría llegado a su canal
    const suyo = (await (await call(cloud.base, carla).post('/api/projects', { name: 'Suyo' })).json()) as { id: string };
    await sCarla.change((e) => e.type === 'project.created' && e.project === suyo.id);
    await sAna.change((e) => e.type === 'project.created' && e.project === suyo.id);

    expect(sBeto.changes().map((e) => `${e.type} ${e.project}`)).toEqual([`project.created ${tienda.id}`, `diagram.created ${tienda.id}`]);
    expect(sBeto.changes()[1]).toMatchObject({ diagram: diagram.id, by: '@beto' });
    expect(sCarla.changes().map((e) => e.project)).toEqual([suyo.id]); // lo de Beto no le llega: no pertenece
    expect(sAna.changes().map((e) => e.project)).toEqual([tienda.id, tienda.id, suyo.id]); // administra la instancia: ve todo
    expect(sCarla.raw).not.toContain(tienda.id);
    expect(sCarla.raw).not.toContain('Tienda');
  });

  it('compartir y dejar de compartir: quien entra recibe lo nuevo; a quien se le quita le llega el aviso del cambio y nada más', async () => {
    const { cloud, beto, carla } = await people();
    const tienda = (await (await call(cloud.base, beto).post('/api/projects', { name: 'Tienda' })).json()) as { id: string };
    const sCarla = await openStream(cloud.base, carla);
    await sCarla.until((m) => m.event === 'ready');

    expect((await call(cloud.base, beto).put(`/api/projects/${tienda.id}/members/carla`, { role: 'viewer' })).status).toBe(201);
    await sCarla.change((e) => e.type === 'project.changed' && e.project === tienda.id);
    await call(cloud.base, beto).post(`/api/projects/${tienda.id}/diagrams`, { module: 'data', name: 'Ventas', text: example('ventas-datos.json') });
    await sCarla.change((e) => e.type === 'diagram.created');

    expect((await call(cloud.base, beto).del(`/api/projects/${tienda.id}/members/carla`)).status).toBe(200);
    await vi.waitFor(() => expect(sCarla.changes().filter((e) => e.type === 'project.changed')).toHaveLength(2)); // el aviso de que se le quitó
    const seen = sCarla.changes().length;
    await call(cloud.base, beto).patch(`/api/projects/${tienda.id}`, { name: 'Tienda 2' });
    const suyo = (await (await call(cloud.base, carla).post('/api/projects', { name: 'Suyo' })).json()) as { id: string };
    await sCarla.change((e) => e.project === suyo.id);
    expect(sCarla.changes().slice(seen).map((e) => e.project)).toEqual([suyo.id]);
  });

  it('al borrar un proyecto llega el aviso a quienes pertenecían a él (ya no pertenecen cuando se publica)', async () => {
    const { cloud, beto, carla } = await people();
    const tienda = (await (await call(cloud.base, beto).post('/api/projects', { name: 'Tienda' })).json()) as { id: string };
    await call(cloud.base, beto).put(`/api/projects/${tienda.id}/members/carla`, { role: 'editor' });
    const sCarla = await openStream(cloud.base, carla);
    await sCarla.until((m) => m.event === 'ready');
    await call(cloud.base, beto).del(`/api/projects/${tienda.id}`);
    await sCarla.change((e) => e.type === 'project.deleted' && e.project === tienda.id);
  });

  it('?project= de un proyecto ajeno es 404 como el resto de la API; sin sesión, 401; una sesión cerrada con el canal abierto lo cierra al siguiente latido', async () => {
    const { cloud, beto, carla } = await people();
    const tienda = (await (await call(cloud.base, beto).post('/api/projects', { name: 'Tienda' })).json()) as { id: string };
    const ajeno = await openStream(cloud.base, carla, `/api/events?project=${tienda.id}`);
    expect(ajeno.status).toBe(404);
    expect((await openStream(cloud.base, carla, '/api/events?project=no-existe')).status).toBe(404); // indistinguible de uno que no existe
    expect((await openStream(cloud.base)).status).toBe(401);
    const propio = await openStream(cloud.base, beto, `/api/events?project=${tienda.id}`);
    expect(propio.status).toBe(200);
    await propio.until((m) => m.event === 'ready');

    expect((await call(cloud.base, beto).post('/api/auth/logout')).status).toBe(200);
    const bye = await propio.until((m) => m.event === 'bye');
    expect(JSON.parse(bye.data)).toEqual({ reason: 'unauthorized' });
  });

  it('el tope de canales es por persona (cuenta), no por sesión ni por dirección', async () => {
    const { cloud, beto, carla } = await people({ serve: { events: { heartbeatMs: 40, maxPerPerson: 1 } } });
    const a = await openStream(cloud.base, beto);
    expect(a.status).toBe(200);
    expect((await openStream(cloud.base, beto)).status).toBe(429);
    expect((await openStream(cloud.base, carla)).status).toBe(200);
  });
});

describe('GET /api/events: registro de accesos y auditoría', () => {
  it('deja una línea al cerrarse el canal (con stream, cuántos avisos y bytes, quién y desde dónde), nunca el token ni la dirección con filtros, y ninguna fila de auditoría', async () => {
    const access = memorySink();
    const audit = memorySink();
    const obs = new Observability({ accessSink: access, auditSink: audit, version: 'prueba' });
    const cloud = await startCloud({ tokens: true, serve: { observability: obs, events: { heartbeatMs: 40 } } });
    const token = cloud.tokens!.admin;
    const stream = await openStream(cloud.base, token, '/api/events?project=tienda');
    await stream.until((m) => m.event === 'ready');
    // mientras está abierto no hay línea: se escribe al terminar
    expect(access.records().filter((r) => (r as { route: string }).route === '/api/events')).toEqual([]);
    const created = (await (await call(cloud.base, token).post('/api/projects', { name: 'Tienda' })).json()) as { id: string };
    expect(created.id).toBe('tienda');
    await call(cloud.base, token).patch('/api/projects/tienda', { name: 'Tienda 2' });
    await stream.change((e) => e.type === 'project.changed');
    stream.close();
    await vi.waitFor(() => expect(access.records().some((r) => (r as { route: string }).route === '/api/events')).toBe(true));
    const row = access.records<{ route: string; status: number; stream?: boolean; events?: number; bytes: number; actor?: { kind: string; name: string }; aborted?: boolean }>().find((r) => r.route === '/api/events')!;
    expect(row).toMatchObject({ status: 200, stream: true, events: 2, actor: { kind: 'token', name: 'servicio', role: 'admin' }, aborted: true });
    expect(row.bytes).toBeGreaterThan(100);
    // nada sensible: ni el token, ni el filtro (la consulta no se registra), y la auditoría no tiene filas de lectura
    for (const line of [...access.history, ...audit.history]) {
      expect(line).not.toContain(token);
      expect(line).not.toContain('project=');
    }
    expect(audit.records().filter((r) => /event|stream/.test((r as { action: string }).action))).toEqual([]);
    await obs.close();
  });

  it('un 401 o un 429 al abrir el canal quedan como cualquier otra petición: línea de acceso y, el 401, fila auth.denied', async () => {
    const access = memorySink();
    const audit = memorySink();
    const obs = new Observability({ accessSink: access, auditSink: audit, version: 'prueba' });
    const cloud = await startCloud({ tokens: true, serve: { observability: obs, events: { heartbeatMs: 40, maxPerPerson: 1 } } });
    expect((await openStream(cloud.base, 'iark_mal')).status).toBe(401);
    const first = await openStream(cloud.base, cloud.tokens!.admin);
    await first.until((m) => m.event === 'ready');
    expect((await openStream(cloud.base, cloud.tokens!.admin)).status).toBe(429);
    await vi.waitFor(() => expect(access.records().filter((r) => (r as { route: string }).route === '/api/events')).toHaveLength(2));
    expect(access.records<{ status: number; stream?: boolean }>().map((r) => [r.status, r.stream ?? false])).toEqual([[401, false], [429, false]]);
    expect(audit.records<{ action: string; result: string; code?: string }>()).toEqual([expect.objectContaining({ action: 'auth.denied', result: 'denied', code: 'unauthorized' })]);
    await obs.close();
  });
});
