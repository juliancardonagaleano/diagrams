import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ComputePool } from '../src/cli/computePool';
import { Observability } from '../src/cli/observability';
import type { Actor } from '../src/cli/observability/audit';
import { FileSink, type LogSink } from '../src/cli/observability/sink';
import { createToken } from '../src/cli/tokens';
import { FolderProjectStore } from '../src/cli/workspace';
import { ANA, BETO, call, cleanupCloud, signIn, startCloud, tracked, type Cloud, type CloudOptions } from './helpers/cloud';
import { challengeOf, newVerifier, type FakeProfile } from './helpers/fakeGithub';
import { loginWithGithub } from './helpers/githubLogin';
import { memorySink, type AccessRow, type AuditRow, type MemorySink } from './helpers/observability';

/**
 * Observabilidad de `iark serve` de punta a punta: el servidor de verdad (`createSuiteServer`, con cuentas de GitHub y tokens; lo único falso es
 * GitHub) con registros en memoria. Comprueba el `X-Request-Id`, el registro de accesos, que cada acción auditada deja su fila (también las
 * denegadas), `/healthz`, `/readyz` y `/metrics`, que nada sensible llega nunca a un registro y que activarlos no cambia lo que se responde.
 */

const METRICS_TOKEN = 'm3tr1cas-token-0123456789abcdef';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DANI: FakeProfile = { id: 404, login: 'dani' };

interface Watched extends Cloud {
  access: MemorySink;
  audit: MemorySink;
  obs: Observability;
  warnings: string[];
}

const extraClosers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  await cleanupCloud();
  for (const close of extraClosers.splice(0)) await close();
});

/** Un servidor con los dos registros en memoria y las métricas encendidas. */
async function watched(options: CloudOptions & { metrics?: boolean } = {}): Promise<Watched> {
  const access = memorySink();
  const audit = memorySink();
  const warnings: string[] = [];
  const { metrics = true, serve, ...rest } = options;
  const obs = new Observability({ accessSink: access, auditSink: audit, metrics, version: 'prueba', warn: (message) => warnings.push(message) });
  extraClosers.push(() => obs.close());
  const cloud = await startCloud({ tokens: true, signup: 'invite', ...rest, serve: { observability: obs, metricsToken: METRICS_TOKEN, readyCacheMs: 0, ...serve } });
  return { ...cloud, access, audit, obs, warnings };
}

/** Los restos de la sonda de `/readyz` que haya en una carpeta (no debe quedar ninguno). */
const readdirNames = (dir: string): string[] => readdirSync(dir).filter((name) => name.startsWith('.iark-ready-'));

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Las líneas nuevas de un registro: espera a que lleguen `count` y un poco más, por si sobra alguna. */
async function rows<T>(sink: MemorySink, count: number): Promise<T[]> {
  const until = Date.now() + 3000;
  while (sink.lines.length < count && Date.now() < until) await wait(2);
  await wait(15);
  return sink.take<T>();
}

const who = (actor: Actor): string => (actor.kind === 'user' ? actor.login : actor.kind === 'token' ? `token:${actor.name}` : 'anónimo');
const brief = (row: AuditRow) => ({
  action: row.action,
  result: row.result,
  status: row.status,
  ...(row.code ? { code: row.code } : {}),
  who: who(row.actor),
  ...(row.target ? { target: row.target } : {}),
  ...(row.change ? { change: row.change } : {}),
});

/** Las filas de auditoría que dejó una respuesta; comprueba que llevan su `X-Request-Id` y una fecha ISO. */
async function audited(w: Watched, response: Response, count = 1): Promise<ReturnType<typeof brief>[]> {
  const found = await rows<AuditRow>(w.audit, count);
  for (const row of found) {
    expect(row.requestId).toBe(response.headers.get('x-request-id'));
    expect(new Date(row.ts).toISOString()).toBe(row.ts);
    expect(row.type).toBe('audit');
  }
  return found.map(brief);
}

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** Una petición con `node:http` (para métodos, rutas y cabeceras que `fetch` no deja mandar). */
function raw(base: string, options: { method?: string; path: string; headers?: Record<string, string> }): Promise<RawResponse> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: url.hostname, port: url.port, method: options.method ?? 'GET', path: options.path, headers: options.headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Bytes tal cual por un socket (para cabeceras con bytes que `node:http` no deja escribir). Devuelve lo que contestó el servidor. */
function socketExchange(base: string, bytes: Buffer): Promise<string> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) }, () => socket.write(bytes));
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
    socket.on('error', reject);
  });
}

interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** Las muestras de un texto de Prometheus; falla si alguna línea no tiene la forma del formato. */
function parseMetrics(text: string): Sample[] {
  const samples: Sample[] = [];
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('# HELP ') || line.startsWith('# TYPE ')) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (\S+)$/.exec(line);
    if (!match) throw new Error(`línea de métricas inválida: ${line}`);
    const labels: Record<string, string> = {};
    for (const label of (match[2] ?? '').matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) labels[label[1]] = label[2];
    samples.push({ name: match[1], labels, value: Number(match[3]) });
  }
  return samples;
}

const metricsOf = async (w: Cloud, token = METRICS_TOKEN): Promise<string> => {
  const res = await fetch(`${w.base}/metrics`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return res.text();
};
const sample = (samples: Sample[], name: string, labels: Record<string, string> = {}): number | undefined =>
  samples.find((s) => s.name === name && Object.entries(labels).every(([key, value]) => s.labels[key] === value))?.value;

// ───────────── X-Request-Id ─────────────

describe('X-Request-Id', () => {
  it('cada respuesta lo lleva (también las de error y las de salud), nuevo y distinto en cada petición, aunque no haya ningún registro', async () => {
    const cloud = await startCloud({ tokens: true });
    const ids = new Set<string>();
    for (const [path, status] of [['/healthz', 200], ['/api/modules', 200], ['/api/projects', 401], ['/no/existe', 404], ['/readyz', 200]] as const) {
      const res = await fetch(`${cloud.base}${path}`);
      expect(res.status, path).toBe(status);
      const id = res.headers.get('x-request-id') ?? '';
      expect(id, path).toMatch(UUID);
      ids.add(id);
    }
    expect(ids.size).toBe(5);
  });

  it('acepta el que manda quien llama si es razonable (hasta 64 caracteres seguros), lo devuelve y es el mismo de las dos líneas de registro', async () => {
    const w = await watched();
    const ana = await signIn(w, ANA);
    await rows(w.access, 3);
    await rows(w.audit, 1);
    const id = 'req-2025.10:abc_DEF-123';
    const res = await call(w.base, ana).post('/api/projects', { name: 'Tienda' }, { 'X-Request-Id': id });
    expect(res.status).toBe(201);
    expect(res.headers.get('x-request-id')).toBe(id);
    const [access] = await rows<AccessRow>(w.access, 1);
    expect(access.requestId).toBe(id);
    expect(w.audit.records<AuditRow>().at(-1)?.requestId).toBe(id);
    const longest = 'a'.repeat(64);
    expect((await fetch(`${w.base}/healthz`, { headers: { 'X-Request-Id': longest } })).headers.get('x-request-id')).toBe(longest);
  });

  it('descarta el que no es seguro (largo, con espacios, comillas, rutas, un solo carácter raro, bytes de salto de línea de otros lectores) y pone uno propio', async () => {
    const w = await watched();
    for (const bad of ['a'.repeat(65), 'con espacio', 'comilla"', '../../etc/passwd', '<script>', '{"type":"audit"}', '-empieza-con-guion', 'ñandú', '']) {
      const res = await fetch(`${w.base}/api/modules`, { headers: { 'X-Request-Id': bad } });
      expect(res.headers.get('x-request-id'), JSON.stringify(bad)).toMatch(UUID);
    }
    // bytes que Node lee como U+0085 (NEL), un salto de línea para algunos lectores de registros: con `fetch` no se pueden mandar
    const reply = await socketExchange(w.base, Buffer.from('GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nX-Request-Id: ab\x85cd\r\n\r\n', 'latin1'));
    expect(/x-request-id: ([^\r\n]+)/i.exec(reply)?.[1]).toMatch(UUID);
    // varias cabeceras iguales: se toma como no válido
    const twice = await socketExchange(w.base, Buffer.from('GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nX-Request-Id: uno\r\nX-Request-Id: dos\r\n\r\n', 'latin1'));
    expect(/x-request-id: ([^\r\n]+)/i.exec(twice)?.[1]).toMatch(UUID);
  });
});

// ───────────── registro de accesos ─────────────

describe('registro de accesos', () => {
  it('una línea JSON por petición con los campos acordados y nada más; bytes es el tamaño del cuerpo y quién llama sale por id y usuario', async () => {
    const w = await watched({ signup: 'open' });
    const beto = await signIn(w, BETO);
    w.access.take();
    await call(w.base, beto).post('/api/projects', { name: 'Tienda' });
    w.access.take();
    const res = await call(w.base, beto).get('/api/projects/tienda');
    const body = Buffer.from(await res.arrayBuffer());
    const [row] = await rows<AccessRow>(w.access, 1);
    expect(Object.keys(row).sort()).toEqual(['actor', 'bytes', 'durationMs', 'method', 'remote', 'requestId', 'route', 'status', 'ts', 'type']);
    expect(row).toMatchObject({ type: 'access', method: 'GET', route: '/api/projects/:project', status: 200, remote: '127.0.0.1', requestId: res.headers.get('x-request-id'), bytes: body.length });
    expect(row.actor).toEqual({ kind: 'user', id: expect.stringMatching(/^u_/), login: 'beto', role: 'member' });
    expect(new Date(row.ts).toISOString()).toBe(row.ts);
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
    expect(row.durationMs).toBeLessThan(5000);
    // sin credenciales no hay `actor`
    await fetch(`${w.base}/api/modules`);
    const [anonymous] = await rows<AccessRow>(w.access, 1);
    expect(anonymous).not.toHaveProperty('actor');
    expect(anonymous).toMatchObject({ method: 'GET', route: '/api/modules', status: 200 });
  });

  it('solo lleva la plantilla de la ruta: ni identificadores, ni query string, ni credenciales, ni cookies, ni cuerpos', async () => {
    const w = await watched({ signup: 'open' });
    const beto = await signIn(w, BETO);
    const created = await call(w.base, beto).post('/api/projects', { name: 'Tienda secreta' });
    const project = (await created.json()) as { id: string };
    const diagram = (await (await call(w.base, beto).post(`/api/projects/${project.id}/diagrams`, { module: 'data', text: '{"contenido":"CONTENIDO-SECRETO"}' })).json()) as { id: string };
    w.access.take();
    const paths = [
      `/api/projects/${project.id}?access_token=SECRETO1&code=SECRETO2&state=SECRETO3&verifier=SECRETO4`,
      `/api/projects/${project.id}/diagrams/${diagram.id}`,
      `/api/projects/${project.id}/members/beto`,
      '/api/auth/github/callback?code=SECRETO5&state=SECRETO6',
      '/api/c4/validate?token=SECRETO7',
    ];
    for (const path of paths) await call(w.base, beto).get(path, { Cookie: 'iark_state=SECRETO8', 'X-Api-Key': 'SECRETO9' });
    const logged = await rows<AccessRow>(w.access, paths.length);
    expect(logged.map((r) => r.route)).toEqual(['/api/projects/:project', '/api/projects/:project/diagrams/:diagram', '/api/projects/:project/members/:login', '/api/auth/github/callback', '/api/:module/validate']);
    const text = w.access.history.join('\n');
    for (const secret of [...Array.from({ length: 9 }, (_, i) => `SECRETO${i + 1}`), beto, 'CONTENIDO-SECRETO', 'Tienda secreta', project.id, diagram.id, 'Bearer', 'Authorization', 'Cookie']) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it('la dirección remota es la de la conexión; con --trust-proxy, la última de X-Forwarded-For (la que añadió el proxy), y sin él la cabecera no cuenta', async () => {
    const plain = await watched();
    await fetch(`${plain.base}/api/modules`, { headers: { 'X-Forwarded-For': '203.0.113.9' } });
    expect((await rows<AccessRow>(plain.access, 1))[0].remote).toBe('127.0.0.1');
    const proxied = await watched({ serve: { trustProxy: true } });
    await fetch(`${proxied.base}/api/modules`, { headers: { 'X-Forwarded-For': '198.51.100.7, 203.0.113.9' } });
    expect((await rows<AccessRow>(proxied.access, 1))[0].remote).toBe('203.0.113.9');
  });

  it('nada de lo que manda quien llama fabrica líneas, campos ni filas: rutas con saltos de línea, comillas y U+2028, métodos raros', async () => {
    const w = await watched();
    const hostile = [
      '/api/projects/a%0A%7B%22type%22%3A%22audit%22%2C%22action%22%3A%22project.delete%22%7D',
      '/api/projects/x%0D%0Ay%E2%80%A8z%E2%80%A9w%C2%85v',
      '/%22%7D%0A%7B%22ts%22%3A1',
      '/api/c4/ru%00n/%27%22',
      '/api/admin/users/%E0%A4%A',
    ];
    for (const path of hostile) await raw(w.base, { path });
    await raw(w.base, { method: 'PURGE', path: '/api/modules' });
    await raw(w.base, { method: 'GET', path: '/api/modules', headers: { 'User-Agent': 'evil\\"}\\n{"type":"audit"}', Referer: 'https://x.example/?a=1' } });
    const logged = await rows<AccessRow>(w.access, hostile.length + 2);
    expect(logged).toHaveLength(hostile.length + 2);
    for (const line of w.access.history) {
      expect(line).not.toMatch(/[\n\r\u0085\u2028\u2029]/);
      expect(line).not.toContain('audit');
      expect(line).not.toContain('evil');
    }
    expect(logged.every((r) => r.type === 'access')).toBe(true);
    expect(logged.some((r) => r.method === 'PURGE')).toBe(true);
    expect(await rows(w.audit, 0)).toEqual([]);
  });

  it('una petición que el cliente abandona a medias queda con 499 y aborted', async () => {
    const w = await watched({ serve: { publicCompute: true } }); // sin pedir credencial, la petición espera su cuerpo
    const url = new URL(w.base);
    await new Promise<void>((resolve) => {
      const socket = createConnection({ host: url.hostname, port: Number(url.port) }, () => {
        socket.write('POST /api/c4/validate HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"a"');
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 30);
      });
    });
    const [row] = await rows<AccessRow>(w.access, 1);
    expect(row).toMatchObject({ method: 'POST', route: '/api/:module/validate', status: 499, aborted: true });
  });

  it('los chequeos de salud que salen bien no llenan el registro (a diario serían miles); los que fallan, sí', async () => {
    const w = await watched();
    for (let i = 0; i < 5; i++) await fetch(`${w.base}/healthz`);
    await fetch(`${w.base}/readyz`);
    await fetch(`${w.base}/metrics`, { headers: { Authorization: `Bearer ${METRICS_TOKEN}` } });
    expect(await rows(w.access, 0)).toEqual([]);
    await fetch(`${w.base}/metrics`); // sin token: 401
    expect((await rows<AccessRow>(w.access, 1)).map((r) => [r.route, r.status])).toEqual([['/metrics', 401]]);
  });
});

// ───────────── auditoría ─────────────

describe('auditoría: cada acción deja su fila', () => {
  it('las que salen bien: quién, qué y sobre qué, con el X-Request-Id de la respuesta y sin contenido', async () => {
    const w = await watched();
    const as = (token: string) => call(w.base, token);
    const ana = await signIn(w, ANA);
    expect((await rows<AuditRow>(w.audit, 1)).map(brief)).toEqual([{ action: 'auth.login', result: 'ok', status: 200, who: 'ana' }]);

    // la administradora invita a dos personas y a una tercera que luego borra
    const invites: Array<[string, string]> = [['beto', 'member'], ['dani', 'member'], ['erika', 'guest']];
    for (const [login, siteRole] of invites) {
      const res = await as(ana).put(`/api/admin/users/${login}`, { siteRole });
      expect(res.status).toBe(201);
      expect(await audited(w, res)).toEqual([{ action: 'user.invite', result: 'ok', status: 201, who: 'ana', target: { login }, change: { siteRole } }]);
    }
    const beto = await signIn(w, BETO);
    await rows(w.audit, 1);
    const dani = await signIn(w, DANI);
    await rows(w.audit, 1);

    // proyectos y diagramas
    let res = await as(beto).post('/api/projects', { name: 'Tienda' });
    expect(res.status).toBe(201);
    expect(await audited(w, res)).toEqual([{ action: 'project.create', result: 'ok', status: 201, who: 'beto', target: { project: 'tienda' } }]);
    res = await as(beto).post('/api/projects/tienda/diagrams', { module: 'data', name: 'Contexto', text: '{"contenido":"CONTENIDO-SECRETO"}' });
    const diagram = ((await res.json()) as { id: string }).id;
    expect(await audited(w, res)).toEqual([{ action: 'diagram.create', result: 'ok', status: 201, who: 'beto', target: { project: 'tienda', diagram } }]);
    res = await as(beto).put(`/api/projects/tienda/diagrams/${diagram}`, { text: '{"v":2}' });
    expect(await audited(w, res)).toEqual([{ action: 'diagram.save', result: 'ok', status: 200, who: 'beto', target: { project: 'tienda', diagram } }]);
    res = await as(beto).patch(`/api/projects/tienda/diagrams/${diagram}`, { name: 'Otro nombre' });
    expect(await audited(w, res)).toEqual([{ action: 'diagram.rename', result: 'ok', status: 200, who: 'beto', target: { project: 'tienda', diagram } }]);
    res = await as(beto).get('/api/projects/tienda/bundle');
    const bundle = await res.text();
    expect(await audited(w, res)).toEqual([{ action: 'project.export', result: 'ok', status: 200, who: 'beto', target: { project: 'tienda' } }]);
    res = await as(beto).post('/api/projects/import?name=Importado', bundle);
    expect(res.status).toBe(201);
    expect(await audited(w, res)).toEqual([{ action: 'project.import', result: 'ok', status: 201, who: 'beto', target: { project: 'importado' } }]);
    res = await as(beto).patch('/api/projects/importado', { name: 'Nombre nuevo' });
    expect(await audited(w, res)).toEqual([{ action: 'project.rename', result: 'ok', status: 200, who: 'beto', target: { project: 'importado' } }]);
    res = await as(beto).del('/api/projects/importado');
    expect(await audited(w, res)).toEqual([{ action: 'project.delete', result: 'ok', status: 200, who: 'beto', target: { project: 'importado' } }]);

    // compartir: alta, cambio de rol y baja (el cambio se deduce de la respuesta y del cuerpo)
    res = await as(beto).put('/api/projects/tienda/members/dani', { role: 'viewer' });
    expect(res.status).toBe(201);
    expect(await audited(w, res)).toEqual([{ action: 'member.add', result: 'ok', status: 201, who: 'beto', target: { project: 'tienda', login: 'dani' }, change: { role: 'viewer' } }]);
    res = await as(beto).put('/api/projects/tienda/members/DANI', { role: 'editor' });
    expect(res.status).toBe(200);
    expect(await audited(w, res)).toEqual([{ action: 'member.role', result: 'ok', status: 200, who: 'beto', target: { project: 'tienda', login: 'DANI' }, change: { role: 'editor' } }]);
    res = await as(beto).put('/api/projects/tienda/members/dani', { role: 'viewer' });
    await audited(w, res);
    res = await as(beto).del('/api/projects/tienda/members/dani');
    expect(await audited(w, res)).toEqual([{ action: 'member.remove', result: 'ok', status: 200, who: 'beto', target: { project: 'tienda', login: 'dani' } }]);
    res = await as(beto).del(`/api/projects/tienda/diagrams/${diagram}`);
    expect(await audited(w, res)).toEqual([{ action: 'diagram.delete', result: 'ok', status: 200, who: 'beto', target: { project: 'tienda', diagram } }]);

    // administración de cuentas: rol, desactivar y reactivar (una petición con dos cambios deja dos filas)
    res = await as(ana).put('/api/admin/users/beto', { siteRole: 'guest' });
    expect(await audited(w, res)).toEqual([{ action: 'user.role', result: 'ok', status: 200, who: 'ana', target: { login: 'beto' }, change: { siteRole: 'guest' } }]);
    res = await as(ana).put('/api/admin/users/beto', { siteRole: 'member', disabled: true });
    expect(await audited(w, res, 2)).toEqual([
      { action: 'user.role', result: 'ok', status: 200, who: 'ana', target: { login: 'beto' }, change: { siteRole: 'member' } },
      { action: 'user.disable', result: 'ok', status: 200, who: 'ana', target: { login: 'beto' }, change: { disabled: true } },
    ]);
    const blocked = await loginWithGithub(w.base, w.fake, BETO);
    expect(blocked.fragment.get('iark_error')).toBe('disabled');
    expect((await rows<AuditRow>(w.audit, 1)).map(brief)).toEqual([{ action: 'auth.login-failed', result: 'denied', status: 302, code: 'disabled', who: 'anónimo', target: { login: 'beto' } }]);
    res = await as(ana).put('/api/admin/users/beto', { disabled: false });
    expect(await audited(w, res)).toEqual([{ action: 'user.enable', result: 'ok', status: 200, who: 'ana', target: { login: 'beto' }, change: { disabled: false } }]);
    res = await as(ana).del('/api/admin/users/erika');
    expect(await audited(w, res)).toEqual([{ action: 'user.remove', result: 'ok', status: 200, who: 'ana', target: { login: 'erika' } }]);
    res = await as(ana).del('/api/admin/users/fantasma');
    expect(res.status).toBe(404);
    expect(await audited(w, res)).toEqual([{ action: 'user.remove', result: 'error', status: 404, code: 'not-found', who: 'ana', target: { login: 'fantasma' } }]);

    // un token de servicio es un actor con su nombre, no una persona
    const service = await as(w.tokens!.admin).post('/api/projects', { name: 'Servicio' });
    expect(service.status).toBe(201);
    const [token] = await rows<AuditRow>(w.audit, 1);
    expect(token.actor).toEqual({ kind: 'token', name: 'servicio', role: 'admin' });
    expect(token).toMatchObject({ action: 'project.create', result: 'ok', requestId: service.headers.get('x-request-id') });
    res = await as(w.tokens!.admin).get('/api/projects/nada/bundle');
    expect(await audited(w, res)).toEqual([{ action: 'project.export', result: 'error', status: 404, code: 'not-found', who: 'token:servicio', target: { project: 'nada' } }]);

    // cerrar sesión
    res = await as(dani).post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(await audited(w, res)).toEqual([{ action: 'auth.logout', result: 'ok', status: 200, who: 'dani' }]);

    // nada de esto llevó contenido, nombres de proyecto ni credenciales
    const text = w.audit.history.join('\n');
    for (const secret of [ana, beto, dani, w.tokens!.admin, 'CONTENIDO-SECRETO', 'Tienda', 'Otro nombre', 'Nombre nuevo', 'Importado', 'Bearer', '127.0.0.1', 'iark_s_', 'gho_']) expect(text, secret).not.toContain(secret);
    // y cada fila es una línea de JSON
    expect(w.audit.history.every((line) => !/[\n\r\u2028\u2029]/.test(line) && JSON.parse(line).type === 'audit')).toBe(true);
  });

  it('también los intentos denegados o fallidos dejan fila: sin credencial, con una falsa, con rol corto, sin pertenecer al proyecto, y los inicios de sesión que no llegan a sesión', async () => {
    const w = await watched();
    const as = (token?: string) => call(w.base, token);
    const ana = await signIn(w, ANA);
    await as(ana).put('/api/admin/users/beto', { siteRole: 'member' });
    await as(ana).put('/api/admin/users/dani', { siteRole: 'member' });
    const beto = await signIn(w, BETO);
    const dani = await signIn(w, DANI);
    await as(beto).post('/api/projects', { name: 'Tienda' });
    await as(beto).post('/api/projects/tienda/diagrams', { module: 'data', name: 'Uno', text: '{}' });
    await rows(w.audit, 7);

    // 401: ni cabecera ni token válido
    let res = await as().post('/api/projects', { name: 'Anónimo' });
    expect(res.status).toBe(401);
    expect(await audited(w, res)).toEqual([{ action: 'project.create', result: 'denied', status: 401, code: 'unauthorized', who: 'anónimo' }]);
    res = await as('iark_token-inventado').post('/api/projects', { name: 'Falso' });
    expect(res.status).toBe(401);
    expect(await audited(w, res)).toEqual([{ action: 'project.create', result: 'denied', status: 401, code: 'unauthorized', who: 'anónimo' }]);
    res = await as('iark_token-inventado').get('/api/whoami');
    expect(await audited(w, res)).toEqual([{ action: 'auth.denied', result: 'denied', status: 401, code: 'unauthorized', who: 'anónimo' }]);
    res = await as().post('/api/c4/validate', '{}');
    expect(await audited(w, res)).toEqual([{ action: 'compute.denied', result: 'denied', status: 401, code: 'unauthorized', who: 'anónimo' }]);
    // leer sin credencial no es un cambio ni un abuso: queda en el registro de accesos y en las métricas, no en la auditoría
    res = await as().get('/api/projects');
    expect(res.status).toBe(401);
    expect(await rows(w.audit, 0)).toEqual([]);

    // 403: un token de solo lectura intentando cambiar, y personas con un rol que no alcanza
    const viewer = createToken(w.tokens!.file, { name: 'lector', role: 'viewer' }).token;
    res = await as(viewer).post('/api/projects', { name: 'Lector' });
    expect(res.status).toBe(403);
    expect(await audited(w, res)).toEqual([{ action: 'project.create', result: 'denied', status: 403, code: 'forbidden', who: 'token:lector' }]);
    res = await as(viewer).del('/api/projects/tienda');
    expect(await audited(w, res)).toEqual([{ action: 'project.delete', result: 'denied', status: 403, code: 'forbidden', who: 'token:lector', target: { project: 'tienda' } }]);
    res = await as(beto).put('/api/projects/tienda/members/dani', { role: 'viewer' });
    await audited(w, res);
    res = await as(dani).post('/api/projects/tienda/diagrams', { module: 'data', text: '{}' });
    expect(res.status).toBe(403);
    expect(await audited(w, res)).toEqual([{ action: 'diagram.create', result: 'denied', status: 403, code: 'forbidden', who: 'dani', target: { project: 'tienda' } }]);
    res = await as(dani).put('/api/admin/users/otra', { siteRole: 'member' });
    expect(res.status).toBe(403);
    expect(await audited(w, res)).toEqual([{ action: 'user.set', result: 'denied', status: 403, code: 'forbidden', who: 'dani', target: { login: 'otra' } }]);
    res = await as(dani).put('/api/projects/tienda/members/dani', { role: 'admin' });
    expect(res.status).toBe(403);
    expect(await audited(w, res)).toEqual([{ action: 'member.set', result: 'denied', status: 403, code: 'forbidden', who: 'dani', target: { project: 'tienda', login: 'dani' } }]);

    // 404 que es denegación: quien no pertenece al proyecto no se entera de si existe
    res = await as(beto).post('/api/projects', { name: 'Secreto de beto' });
    await audited(w, res);
    res = await as(dani).get('/api/projects/secreto-de-beto/bundle');
    expect(res.status).toBe(404);
    expect(await audited(w, res)).toEqual([{ action: 'project.export', result: 'denied', status: 404, code: 'not-found', who: 'dani', target: { project: 'secreto-de-beto' } }]);
    res = await as(dani).del('/api/projects/secreto-de-beto');
    expect(await audited(w, res)).toEqual([{ action: 'project.delete', result: 'denied', status: 404, code: 'not-found', who: 'dani', target: { project: 'secreto-de-beto' } }]);

    // 400 (datos inválidos) es un error, no una denegación
    res = await as(beto).put('/api/projects/tienda/members/dani', { role: 'dios' });
    expect(res.status).toBe(400);
    expect(await audited(w, res)).toEqual([{ action: 'member.set', result: 'error', status: 400, code: expect.any(String), who: 'beto', target: { project: 'tienda', login: 'dani' } }]);

    // inicios de sesión que no llegan a sesión
    const attempt = async (login: () => Promise<unknown>): Promise<ReturnType<typeof brief>[]> => {
      await login();
      return (await rows<AuditRow>(w.audit, 1)).map(brief);
    };
    expect(
      await attempt(async () => {
        const verifier = newVerifier();
        const start = await fetch(`${w.base}/api/auth/github/login?${new URLSearchParams({ challenge: challengeOf(verifier) })}`, { redirect: 'manual' });
        const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0];
        w.fake.deny(); // la persona no acepta en GitHub
        const authorize = await fetch(start.headers.get('location')!, { redirect: 'manual' });
        await fetch(`${w.base}/api/auth/github/callback${new URL(authorize.headers.get('location')!).search}`, { redirect: 'manual', headers: { Cookie: cookie } });
      }),
    ).toEqual([{ action: 'auth.login-failed', result: 'denied', status: 302, code: 'access_denied', who: 'anónimo' }]);
    expect(await attempt(() => loginWithGithub(w.base, w.fake, ANA, { withoutCookie: true }))).toEqual([{ action: 'auth.login-failed', result: 'denied', status: 400, code: 'state-mismatch', who: 'anónimo' }]);
    expect(await attempt(() => loginWithGithub(w.base, w.fake, { id: 909, login: 'intruso' }))).toEqual([{ action: 'auth.login-failed', result: 'denied', status: 302, code: 'not_invited', who: 'anónimo', target: { login: 'intruso' } }]);
    expect(await attempt(() => fetch(`${w.base}/api/auth/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'inventado', verifier: newVerifier() }) }))).toEqual([
      { action: 'auth.login-failed', result: 'denied', status: 400, code: 'invalid-grant', who: 'anónimo' },
    ]);
    w.fake.failNext('token', 500);
    expect(await attempt(() => loginWithGithub(w.base, w.fake, ANA))).toEqual([{ action: 'auth.login-failed', result: 'error', status: 302, code: 'github_unavailable', who: 'anónimo' }]);

    // en ningún registro (ni el de accesos) hay credenciales, códigos, verificadores ni cookies
    const text = [...w.audit.history, ...w.access.history].join('\n');
    for (const secret of [ana, beto, dani, viewer, w.tokens!.admin, 'iark-token-inventado', 'iark_token-inventado', 'inventado', 'gho_', 'iark_code', 'iark_state', 'verifier', 'Secreto de beto']) expect(text, secret).not.toContain(secret);
  });

  it('las 429 del freno de intentos no dejan fila de auditoría (ya son una métrica) y las demás sí', async () => {
    const w = await watched();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await call(w.base, 'iark_token-inventado').post('/api/projects', { name: 'x' })).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
    const logged = await rows<AuditRow>(w.audit, 5);
    expect(logged).toHaveLength(5);
    expect(logged.every((r) => r.action === 'project.create' && r.status === 401)).toBe(true);
    const samples = parseMetrics(await metricsOf(w));
    expect(sample(samples, 'iark_http_rate_limited_total')).toBe(2);
    expect(sample(samples, 'iark_auth_failures_total', { reason: 'invalid' })).toBe(5);
    expect(sample(samples, 'iark_auth_failures_total', { reason: 'rate_limited' })).toBe(2);
    expect(sample(samples, 'iark_http_requests_total', { method: 'POST', route: '/api/projects', status_class: '4xx' })).toBe(7);
  });

  it('sin --audit-log no se escribe nada, pero las filas se siguen contando en las métricas', async () => {
    const access = memorySink();
    const obs = new Observability({ accessSink: access, metrics: true, version: 'prueba' });
    extraClosers.push(() => obs.close());
    const cloud = await startCloud({ tokens: true, serve: { observability: obs, metricsToken: METRICS_TOKEN } });
    await call(cloud.base, cloud.tokens!.admin).post('/api/projects', { name: 'Tienda' });
    const samples = parseMetrics(await metricsOf(cloud));
    expect(sample(samples, 'iark_audit_events_total', { action: 'project.create', result: 'ok' })).toBe(1);
    expect(sample(samples, 'iark_log_lines_total', { log: 'access', outcome: 'written' })).toBeGreaterThanOrEqual(1);
    expect(samples.some((s) => s.labels.log === 'audit')).toBe(false);
  });
});

// ───────────── salud ─────────────

describe('/healthz y /readyz', () => {
  it('/healthz responde 200 {"status":"ok"} sin autenticación y sin detalles, aunque haya tokens y cuentas, y aunque /readyz falle', async () => {
    const w = await watched();
    const root = mkdtempSync(join(tmpdir(), 'iark-obs-'));
    tracked.folders.push(root);
    writeFileSync(join(root, 'un-archivo'), 'no es una carpeta');
    const broken = await watched({ serve: { projects: new FolderProjectStore(join(root, 'un-archivo')) } });
    for (const cloud of [w, broken]) {
      const res = await fetch(`${cloud.base}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('content-type')).toMatch(/^application\/json/);
      expect(res.headers.get('x-request-id')).toMatch(UUID);
    }
    expect((await fetch(`${broken.base}/readyz`)).status).toBe(503);
    const head = await raw(w.base, { method: 'HEAD', path: '/healthz' });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    const post = await raw(w.base, { method: 'POST', path: '/healthz' });
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe('GET, HEAD');
  });

  it('/readyz responde 200 con el estado de cada comprobación (solo ok o fail, sin rutas ni secretos) y deja la carpeta sin restos', async () => {
    const w = await watched();
    const res = await fetch(`${w.base}/readyz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', checks: { workspace: 'ok', tokens: 'ok', accounts: 'ok' } });
    expect(readdirNames(w.root)).toEqual([]);
    // sin nada que comprobar (ni espacio de trabajo, ni tokens, ni cuentas), solo responde que está viva
    const bare = await startCloud({ signup: 'open' });
    expect((await fetch(`${bare.base}/readyz`)).status).toBe(200);
  });

  it('/readyz da 503 y nombra la comprobación que falla cuando la carpeta de trabajo no se puede usar, el archivo de tokens se daña o el de cuentas desaparece', async () => {
    const root = mkdtempSync(join(tmpdir(), 'iark-obs-'));
    tracked.folders.push(root);
    const file = join(root, 'espacio');
    writeFileSync(file, 'esto es un archivo, no una carpeta'); // como root los permisos no frenan: un archivo en lugar de la carpeta sí
    const w = await watched({ serve: { projects: new FolderProjectStore(file) } });
    let res = await fetch(`${w.base}/readyz`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; checks: Record<string, string> };
    expect(body).toEqual({ status: 'fail', checks: { workspace: 'fail', tokens: 'ok', accounts: 'ok' } });
    expect(JSON.stringify(body)).not.toContain(root);
    // los chequeos fallidos sí dejan línea en el registro de accesos
    expect((await rows<AccessRow>(w.access, 1)).map((r) => [r.route, r.status])).toEqual([['/readyz', 503]]);

    writeFileSync(w.tokens!.file, '{esto no es JSON');
    res = await fetch(`${w.base}/readyz`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { checks: Record<string, string> }).checks).toMatchObject({ tokens: 'fail', accounts: 'ok' });

    rmSync(w.file);
    res = await fetch(`${w.base}/readyz`);
    expect(((await res.json()) as { checks: Record<string, string> }).checks).toMatchObject({ accounts: 'fail' });
    // lo avisó por stderr una vez por cambio, con el nombre de la comprobación y sin rutas
    expect(w.warnings.filter((m) => m.includes('«workspace»'))).toHaveLength(1);
    expect(w.warnings.join('\n')).not.toContain(root);
  });

  it('/readyz comprueba el pool de cálculo (un archivo de hilo que no existe es 503) y cachea el resultado unos segundos', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iark-obs-'));
    tracked.folders.push(dir);
    const good = new ComputePool({ size: 1 });
    const bad = new ComputePool({ size: 1, workerFile: join(dir, 'no-existe.mjs') });
    extraClosers.push(() => good.close(), () => bad.close());
    const ok = await watched({ serve: { compute: good } });
    expect(await (await fetch(`${ok.base}/readyz`)).json()).toMatchObject({ status: 'ok', checks: { compute: 'ok' } });
    const ko = await watched({ serve: { compute: bad } });
    const res = await fetch(`${ko.base}/readyz`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: 'fail', checks: { compute: 'fail', workspace: 'ok' } });

    // con caché, un cambio no se ve hasta que pase el plazo (y varias peticiones comparten una sola ronda)
    const root = mkdtempSync(join(tmpdir(), 'iark-obs-'));
    tracked.folders.push(root);
    const cached = await watched({ serve: { readyCacheMs: 60_000, projects: new FolderProjectStore(join(root, 'sub')) } });
    expect((await fetch(`${cached.base}/readyz`)).status).toBe(200);
    writeFileSync(join(root, 'sub'), 'ahora es un archivo');
    expect((await fetch(`${cached.base}/readyz`)).status).toBe(200);
  });
});

// ───────────── métricas ─────────────

describe('/metrics', () => {
  it('apagado por omisión: 404, tenga o no el servicio un Observability', async () => {
    const plain = await startCloud({ tokens: true });
    expect((await fetch(`${plain.base}/metrics`)).status).toBe(404);
    const without = await watched({ metrics: false });
    const res = await fetch(`${without.base}/metrics`, { headers: { Authorization: `Bearer ${METRICS_TOKEN}` } });
    expect(res.status).toBe(404);
  });

  it('con token exige Bearer: 401 sin él o con otro (con WWW-Authenticate), 200 con el bueno, 405 con otro método y 429 tras varios fallos', async () => {
    const w = await watched();
    let res = await fetch(`${w.base}/metrics`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="iark-metrics"');
    expect(await res.json()).toMatchObject({ code: 'unauthorized' });
    // el token de la API no abre las métricas, ni el de las métricas la API
    expect((await fetch(`${w.base}/metrics`, { headers: { Authorization: `Bearer ${w.tokens!.admin}` } })).status).toBe(401);
    expect((await call(w.base, METRICS_TOKEN).get('/api/projects')).status).toBe(401);
    res = await fetch(`${w.base}/metrics`, { headers: { Authorization: `Bearer ${METRICS_TOKEN}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect((await raw(w.base, { method: 'POST', path: '/metrics', headers: { Authorization: `Bearer ${METRICS_TOKEN}` } })).status).toBe(405);
    expect((await raw(w.base, { method: 'HEAD', path: '/metrics', headers: { Authorization: `Bearer ${METRICS_TOKEN}` } })).status).toBe(200);
    for (let i = 0; i < 4; i++) await fetch(`${w.base}/metrics`, { headers: { Authorization: 'Bearer equivocado' } });
    res = await fetch(`${w.base}/metrics`, { headers: { Authorization: `Bearer ${METRICS_TOKEN}` } });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  });

  it('sin token solo atiende a conexiones de loopback con un Host de loopback (contra el DNS rebinding)', async () => {
    const w = await watched({ serve: { metricsToken: undefined } });
    expect((await fetch(`${w.base}/metrics`)).status).toBe(200);
    const hostile = await raw(w.base, { path: '/metrics', headers: { Host: 'evil.example' } });
    expect(hostile.status).toBe(403);
    expect(hostile.body).not.toContain('iark_http_requests_total');
  });

  it('el texto es el formato de Prometheus y trae los contadores y las medidas acordadas', async () => {
    const w = await watched({ signup: 'open' });
    const beto = await signIn(w, BETO);
    await call(w.base, beto).post('/api/projects', { name: 'Tienda' });
    await call(w.base, beto).get('/api/projects/tienda');
    await call(w.base, beto).get('/api/projects/nada/members');
    await fetch(`${w.base}/api/modules`);
    const text = await metricsOf(w);
    const samples = parseMetrics(text);
    expect(text.endsWith('\n')).toBe(true);
    expect(sample(samples, 'iark_http_requests_total', { method: 'POST', route: '/api/projects', status_class: '2xx' })).toBe(1);
    expect(sample(samples, 'iark_http_requests_total', { method: 'GET', route: '/api/projects/:project', status_class: '2xx' })).toBe(1);
    expect(sample(samples, 'iark_http_requests_total', { method: 'GET', route: '/api/projects/:project/members', status_class: '4xx' })).toBe(1);
    expect(sample(samples, 'iark_http_request_duration_seconds_count', { route: '/api/modules' })).toBe(1);
    expect(samples.some((s) => s.name === 'iark_http_request_duration_seconds_bucket' && s.labels.le === '+Inf')).toBe(true);
    for (const name of ['process_resident_memory_bytes', 'process_uptime_seconds', 'process_cpu_seconds_total', 'nodejs_eventloop_lag_seconds', 'nodejs_eventloop_lag_p99_seconds', 'iark_http_requests_in_flight']) {
      expect(sample(samples, name), name).toBeGreaterThanOrEqual(0);
    }
    expect(sample(samples, 'process_resident_memory_bytes')).toBeGreaterThan(1_000_000);
    expect(sample(samples, 'iark_build_info', { version: 'prueba' })).toBe(1);
    // recuentos de cuentas y sesiones (solo números), y de tokens
    expect(sample(samples, 'iark_accounts', { state: 'active' })).toBe(1);
    expect(sample(samples, 'iark_sessions_active')).toBe(1);
    expect(sample(samples, 'iark_tokens')).toBe(1);
    expect(sample(samples, 'iark_tokens_file_ok')).toBe(1);
    expect(sample(samples, 'iark_audit_events_total', { action: 'auth.login', result: 'ok' })).toBe(1);
  });

  it('las métricas del pool de cálculo cuentan lo completado, lo rechazado por cola llena y lo que pasó del tiempo', async () => {
    const stub = new URL('./fixtures/compute-stub-worker.mjs', import.meta.url);
    const pool = new ComputePool({ workerFile: stub, size: 1, maxQueue: 0, timeoutMs: 400 });
    extraClosers.push(() => pool.close());
    const w = await watched({ serve: { compute: pool } });
    const post = (body: string) => fetch(`${w.base}/api/security/validate`, { method: 'POST', headers: { Authorization: `Bearer ${w.tokens!.admin}` }, body });
    expect((await post('hola')).status).toBe(200);
    const running = post('slow:200');
    await wait(60);
    expect((await post('otra')).status).toBe(503);
    expect((await running).status).toBe(200);
    expect((await post('hang')).status).toBe(503);
    const samples = parseMetrics(await metricsOf(w));
    expect(sample(samples, 'iark_compute_completed_total')).toBeGreaterThanOrEqual(2);
    expect(sample(samples, 'iark_compute_rejected_total')).toBe(1);
    expect(sample(samples, 'iark_compute_timeouts_total')).toBe(1);
    expect(sample(samples, 'iark_compute_workers_max')).toBe(1);
    expect(sample(samples, 'iark_compute_queued')).toBe(0);
    expect(sample(samples, 'iark_compute_active')).toBe(0);
  });

  it('ninguna etiqueta lleva personas, proyectos, direcciones ni tokens, y ningún secreto llega al texto', async () => {
    const w = await watched();
    const ana = await signIn(w, ANA);
    await call(w.base, ana).put('/api/admin/users/beto', { siteRole: 'member' });
    const beto = await signIn(w, BETO);
    const verified = await loginWithGithub(w.base, w.fake, ANA);
    await call(w.base, beto).post('/api/projects', { name: 'Tienda secreta' });
    await call(w.base, beto).post('/api/projects/tienda-secreta/diagrams', { module: 'data', text: '{"contenido":"CONTENIDO-SECRETO"}' });
    await call(w.base, beto).get('/api/projects/tienda-secreta/members/ana?token=SECRETO');
    await call(w.base, 'iark_token-inventado').get('/api/whoami', { 'X-Forwarded-For': '203.0.113.50' });
    await loginWithGithub(w.base, w.fake, { id: 909, login: 'intruso' });
    const text = await metricsOf(w);
    const samples = parseMetrics(text);
    const labelNames = new Set(samples.flatMap((s) => Object.keys(s.labels)));
    expect([...labelNames].sort()).toEqual(['action', 'le', 'log', 'method', 'outcome', 'reason', 'result', 'route', 'state', 'status_class', 'version']);
    for (const secret of [ana, beto, verified.token!, verified.verifier, w.tokens!.admin, METRICS_TOKEN, 'tienda-secreta', 'Tienda secreta', 'CONTENIDO-SECRETO', 'SECRETO', 'intruso', 'iark_token-inventado', '127.0.0.1', '203.0.113.50']) {
      expect(text, secret).not.toContain(secret);
    }
    expect(text).not.toMatch(/\b(ana|beto|dani|carla)\b/);
    for (const s of samples.filter((s) => s.labels.route)) expect(s.labels.route, s.labels.route).toMatch(/^\/[A-Za-z0-9/:*._-]*$/);
  });

  it('la cardinalidad no depende de lo que escriba quien llama: miles de rutas y métodos distintos dan unas pocas series', async () => {
    const w = await watched();
    for (let i = 0; i < 150; i++) {
      await raw(w.base, { path: `/api/projects/proyecto-${i}/diagrams/d${i}?q=${i}` });
      await raw(w.base, { path: `/api/modulo${i}/accion${i}/${i}` });
      await raw(w.base, { path: `/ruta/${i}/de/archivo.js` });
    }
    for (const method of ['PURGE', 'BREW', 'X-INVENTADO']) await raw(w.base, { method, path: '/api/modules' });
    const samples = parseMetrics(await metricsOf(w));
    const series = samples.filter((s) => s.name === 'iark_http_requests_total');
    expect(series.length).toBeLessThan(15);
    expect(new Set(series.map((s) => s.labels.route))).toEqual(new Set(['/api/projects/:project/diagrams/:diagram', '/api/:module/*', '/*', '/api/modules']));
    expect(new Set(series.map((s) => s.labels.method))).toEqual(new Set(['GET', 'OTHER']));
    expect(samples.length).toBeLessThan(250);
  });

  it('sin tokens ni pool de cálculo no salen sus familias de métricas', async () => {
    const obs = new Observability({ metrics: true, version: 'prueba' });
    extraClosers.push(() => obs.close());
    const cloud = await startCloud({ serve: { observability: obs, projects: undefined } });
    const samples = parseMetrics(await (await fetch(`${cloud.base}/metrics`)).text());
    expect(samples.some((s) => s.name === 'iark_tokens')).toBe(false);
    expect(samples.some((s) => s.name === 'iark_compute_workers')).toBe(false);
    expect(sample(samples, 'iark_accounts', { state: 'active' })).toBe(0);
  });
});

// ───────────── activar los registros no cambia las respuestas ─────────────

describe('activar la observabilidad no cambia lo que se responde', () => {
  interface Seen {
    status: number;
    headers: Record<string, string>;
    body: string;
  }

  async function script(base: string, token: string): Promise<Seen[]> {
    const seen: Seen[] = [];
    const dynamic: string[] = [];
    const normalize = (text: string): string => dynamic.reduce((t, value) => t.split(value).join('<id>'), text).replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, '<ts>');
    const note = async (res: Response): Promise<Response> => {
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        if (!['date', 'x-request-id', 'content-length'].includes(key)) headers[key] = normalize(value);
      });
      seen.push({ status: res.status, headers, body: normalize(await res.clone().text()) });
      return res;
    };
    const api = call(base, token);
    await note(await api.get('/api/whoami'));
    await note(await api.post('/api/projects', { name: 'Tienda' }));
    const diagram = (await (await note(await api.post('/api/projects/tienda/diagrams', { module: 'data', name: 'Uno', text: '{"a":1}' }))).clone().json()) as { id: string };
    dynamic.push(diagram.id);
    await note(await api.get('/api/projects'));
    await note(await api.get(`/api/projects/tienda/diagrams/${diagram.id}`));
    await note(await api.put(`/api/projects/tienda/diagrams/${diagram.id}`, { text: '{"a":2}' }));
    await note(await api.patch('/api/projects/tienda', { name: 'Tienda 2' }));
    await note(await api.get('/api/projects/tienda/bundle'));
    await note(await api.get('/api/projects/nada'));
    await note(await api.post('/api/projects', {}));
    await note(await fetch(`${base}/api/projects`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: 'x' }));
    await note(await call(base).get('/api/projects'));
    await note(await call(base, 'iark_token-inventado').post('/api/projects', { name: 'Falso' }));
    await note(await call(base).post('/api/c4/validate', '{}'));
    await note(await api.get('/api/modules'));
    await note(await api.get('/api/c4/capabilities'));
    await note(await api.get('/.well-known/iark.json'));
    await note(await api.get('/no/existe'));
    await note(await api.get('/healthz'));
    await note(await api.del(`/api/projects/tienda/diagrams/${diagram.id}`));
    await note(await api.del('/api/projects/tienda'));
    return seen;
  }

  it('el mismo guion contra un servidor sin registros y otro con accesos, auditoría y métricas da las mismas respuestas (salvo X-Request-Id)', async () => {
    const quiet = await startCloud({ tokens: true });
    const loud = await watched();
    const a = await script(quiet.base, quiet.tokens!.admin);
    const b = await script(loud.base, loud.tokens!.admin);
    expect(b).toEqual(a);
    expect(a.length).toBeGreaterThan(18);
    expect(a.map((s) => s.status)).toEqual(expect.arrayContaining([200, 201, 400, 401, 404, 415]));
    // y el servidor ruidoso sí escribió: una línea de acceso por petición (menos /healthz), y filas de auditoría
    expect((await rows<AccessRow>(loud.access, a.length - 1)).length).toBe(a.length - 1);
    expect((await rows<AuditRow>(loud.audit, 1)).length).toBeGreaterThan(5);
  });
});

// ───────────── un registro que falla no tumba el servicio ─────────────

describe('un registro que falla no tumba el servicio', () => {
  const throwing = (): LogSink => ({
    write() {
      throw new Error('el disco explotó');
    },
    reopen() {},
    async close() {},
    stats: { written: 0, dropped: 0, errors: 0 },
    target: 'roto',
  });

  it('un destino que lanza al escribir no cambia ninguna respuesta; se avisa una sola vez', async () => {
    const warnings: string[] = [];
    const obs = new Observability({ accessSink: throwing(), auditSink: throwing(), metrics: true, version: 'prueba', warn: (m) => warnings.push(m) });
    extraClosers.push(() => obs.close());
    const cloud = await startCloud({ tokens: true, serve: { observability: obs, metricsToken: METRICS_TOKEN } });
    for (let i = 0; i < 4; i++) {
      const res = await call(cloud.base, cloud.tokens!.admin).post('/api/projects', { name: `Proyecto ${i}` });
      expect(res.status).toBe(201);
      expect(res.headers.get('x-request-id')).toMatch(UUID);
    }
    expect((await fetch(`${cloud.base}/healthz`)).status).toBe(200);
    expect(warnings).toHaveLength(1);
    // aun con los dos destinos rotos, las métricas siguieron contando
    const samples = parseMetrics(await metricsOf(cloud));
    expect(sample(samples, 'iark_http_requests_total', { method: 'POST', route: '/api/projects', status_class: '2xx' })).toBe(4);
    expect(sample(samples, 'iark_audit_events_total', { action: 'project.create', result: 'ok' })).toBe(4);
  });

  it.skipIf(!existsSync('/dev/full'))('un archivo de auditoría que no se puede escribir (disco lleno): el servicio sigue, avisa una vez y manda las filas a la salida de emergencia', async () => {
    const warnings: string[] = [];
    const emergency: string[] = [];
    const modeBefore = statSync('/dev/full').mode;
    const sink = new FileSink('/dev/full', { label: 'registro de auditoría', sync: true, retryMs: 600_000, warn: (m) => warnings.push(m), fallback: (line) => emergency.push(line) });
    sink.open();
    expect(statSync('/dev/full').mode).toBe(modeBefore); // un dispositivo no es nuestro: no se le cambia el modo
    const obs = new Observability({ auditSink: sink, metrics: true, version: 'prueba', warn: (m) => warnings.push(m) });
    extraClosers.push(() => obs.close());
    const cloud = await startCloud({ tokens: true, serve: { observability: obs, metricsToken: METRICS_TOKEN } });
    const admin = call(cloud.base, cloud.tokens!.admin);
    for (const name of ['Uno', 'Dos', 'Tres']) expect((await admin.post('/api/projects', { name })).status).toBe(201);
    expect(warnings.filter((m) => m.includes('no se puede escribir'))).toHaveLength(1);
    expect(warnings.join('\n')).toContain('van a stderr');
    expect(emergency.map((l) => (JSON.parse(l) as AuditRow).action)).toEqual(['project.create', 'project.create', 'project.create']);
    const samples = parseMetrics(await metricsOf(cloud));
    expect(sample(samples, 'iark_log_errors_total', { log: 'audit' })).toBe(1);
    expect(sample(samples, 'iark_log_lines_total', { log: 'audit', outcome: 'dropped' })).toBe(3);
    expect(sample(samples, 'iark_log_lines_total', { log: 'audit', outcome: 'written' })).toBe(0);
    expect(sample(samples, 'iark_audit_events_total', { action: 'project.create', result: 'ok' })).toBe(3);
  });
});
