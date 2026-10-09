import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { manifestSchema } from '@iark/kernel';
import { createDefaultRegistry } from './registry';
import { createSuiteServer, type ServeOptions } from './serve';
import { bearerToken, clientAddress, FailureLimiter, isLoopbackHost } from './serveAuth';
import { requiredRole } from './serveProjects';
import { createToken, hashToken, revokeToken, TokenStore, type TokenRole } from './tokens';
import { FolderProjectStore } from './workspace';

const JSON_TYPE = { 'Content-Type': 'application/json' };
const UNAUTHORIZED = { error: expect.any(String), code: 'unauthorized' };

const folders: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ───────────── unidades: el freno, las cabeceras y los hosts ─────────────

describe('FailureLimiter: freno de intentos fallidos por dirección', () => {
  const clock = (start = 1_000_000) => {
    const state = { t: start };
    return { state, now: () => state.t, advance: (ms: number) => void (state.t += ms) };
  };

  it('tolera cuatro fallos, frena al quinto 1 s y duplica el plazo con cada fallo más, hasta un tope', () => {
    const time = clock();
    const limiter = new FailureLimiter({ now: time.now });
    for (let i = 0; i < 4; i++) {
      limiter.fail('1.2.3.4');
      expect(limiter.retryAfter('1.2.3.4')).toBe(0);
    }
    limiter.fail('1.2.3.4'); // el quinto
    expect(limiter.retryAfter('1.2.3.4')).toBe(1);
    time.advance(999);
    expect(limiter.retryAfter('1.2.3.4')).toBe(1);
    time.advance(1);
    expect(limiter.retryAfter('1.2.3.4')).toBe(0);

    // cada fallo después de un freno lo duplica: 2, 4, 8… s
    const waits: number[] = [];
    for (let i = 0; i < 12; i++) {
      limiter.fail('1.2.3.4');
      const wait = limiter.retryAfter('1.2.3.4');
      waits.push(wait);
      time.advance(wait * 1000);
    }
    expect(waits.slice(0, 6)).toEqual([2, 4, 8, 16, 32, 64]);
    expect(Math.max(...waits)).toBe(300); // el tope: 5 min
    expect(waits.slice(-3)).toEqual([300, 300, 300]);
  });

  it('el plazo que queda baja con el tiempo y siempre es un entero de al menos 1 s', () => {
    const time = clock();
    const limiter = new FailureLimiter({ now: time.now, freeAttempts: 1, baseMs: 10_000 });
    limiter.fail('a');
    expect(limiter.retryAfter('a')).toBe(10);
    time.advance(9_500);
    expect(limiter.retryAfter('a')).toBe(1); // faltan 500 ms: se redondea hacia arriba
  });

  it('cada dirección tiene su cuenta', () => {
    const time = clock();
    const limiter = new FailureLimiter({ now: time.now });
    for (let i = 0; i < 5; i++) limiter.fail('1.1.1.1');
    expect(limiter.retryAfter('1.1.1.1')).toBe(1);
    expect(limiter.retryAfter('2.2.2.2')).toBe(0);
    for (let i = 0; i < 4; i++) limiter.fail('2.2.2.2');
    expect(limiter.retryAfter('2.2.2.2')).toBe(0);
  });

  it('una dirección que no falla durante un tiempo se olvida y vuelve a empezar de cero', () => {
    const time = clock();
    const limiter = new FailureLimiter({ now: time.now, forgetAfterMs: 60_000 });
    for (let i = 0; i < 8; i++) limiter.fail('a'); // frenada con un plazo largo
    expect(limiter.retryAfter('a')).toBeGreaterThan(1);
    time.advance(60_001);
    expect(limiter.retryAfter('a')).toBe(0);
    expect(limiter.size).toBe(0);
    for (let i = 0; i < 4; i++) limiter.fail('a'); // cuatro más no bastan: la cuenta empezó de nuevo
    expect(limiter.retryAfter('a')).toBe(0);
    // los fallos dentro del tiempo sí se acumulan: el tiempo se cuenta desde el último
    time.advance(59_000);
    limiter.fail('a');
    expect(limiter.retryAfter('a')).toBe(1);
  });

  it('no recuerda más direcciones que el máximo: descarta primero las olvidables y luego las más antiguas', () => {
    const time = clock();
    const limiter = new FailureLimiter({ now: time.now, maxEntries: 3, forgetAfterMs: 1000 });
    for (const a of ['a', 'b', 'c']) limiter.fail(a);
    expect(limiter.size).toBe(3);
    time.advance(1001); // las tres son olvidables
    limiter.fail('d');
    expect(limiter.size).toBe(1);
    for (const a of ['e', 'f', 'g', 'h']) limiter.fail(a); // sin nada olvidable: sale la más antigua
    expect(limiter.size).toBe(3);
    for (let i = 0; i < 10_000; i++) limiter.fail(`10.0.${i >> 8}.${i & 255}`);
    expect(limiter.size).toBe(3);
  });
});

describe('cabeceras y direcciones', () => {
  it('bearerToken saca el token de `Authorization: Bearer …` (el esquema no distingue mayúsculas) y nada más', () => {
    expect(bearerToken('Bearer iark_abc')).toBe('iark_abc');
    expect(bearerToken('bearer   iark_abc  ')).toBe('iark_abc');
    expect(bearerToken('BEARER\tiark_abc')).toBe('iark_abc');
    for (const header of [undefined, '', 'Bearer', 'Bearer ', 'Basic dXNlcjpwYXNz', 'iark_abc', 'Token iark_abc', 'Bearer a b', 'Bearerx iark_abc', 'Bearer\niark_abc']) {
      expect(bearerToken(header), String(header)).toBeUndefined();
    }
  });

  const fakeRequest = (remoteAddress: string | undefined, forwarded?: string | string[]): IncomingMessage =>
    ({ socket: { remoteAddress }, headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded } }) as unknown as IncomingMessage;

  it('la dirección es la de la conexión; con proxy de confianza, la última de X-Forwarded-For (la que añadió el proxy)', () => {
    expect(clientAddress(fakeRequest('203.0.113.7'), false)).toBe('203.0.113.7');
    expect(clientAddress(fakeRequest('::ffff:203.0.113.7'), false)).toBe('203.0.113.7');
    expect(clientAddress(fakeRequest('2001:DB8::1'), false)).toBe('2001:db8::1');
    expect(clientAddress(fakeRequest(undefined), false)).toBe('desconocida');
    // sin proxy de confianza la cabecera no cuenta: cualquiera podría poner la que quisiera
    expect(clientAddress(fakeRequest('203.0.113.7', '1.1.1.1'), false)).toBe('203.0.113.7');
    expect(clientAddress(fakeRequest('172.18.0.2', '198.51.100.9'), true)).toBe('198.51.100.9');
    expect(clientAddress(fakeRequest('172.18.0.2', '6.6.6.6, 198.51.100.9'), true)).toBe('198.51.100.9'); // lo que trajo el cliente va antes
    expect(clientAddress(fakeRequest('172.18.0.2', ['6.6.6.6', '198.51.100.9']), true)).toBe('198.51.100.9');
    expect(clientAddress(fakeRequest('172.18.0.2', '::ffff:198.51.100.9'), true)).toBe('198.51.100.9');
    expect(clientAddress(fakeRequest('172.18.0.2'), true)).toBe('172.18.0.2'); // sin cabecera, la de la conexión
    expect(clientAddress(fakeRequest('172.18.0.2', ' , '), true)).toBe('172.18.0.2');
    expect(clientAddress(fakeRequest('172.18.0.2', 'x'.repeat(500)), true)).toHaveLength(64); // acotada
  });

  it('isLoopbackHost: solo localhost, 127.x.x.x y ::1; 0.0.0.0, :: y cualquier otra dirección o nombre no', () => {
    for (const host of ['127.0.0.1', 'localhost', 'LOCALHOST', '::1', '[::1]', '127.1.2.3', '::ffff:127.0.0.1', ' 127.0.0.1 ']) expect(isLoopbackHost(host), host).toBe(true);
    for (const host of ['0.0.0.0', '::', '[::]', '192.168.1.5', '10.0.0.2', '203.0.113.7', 'example.org', '127.0.0.1.evil.example', 'localhost.evil.example', '', '1270.0.0.1', '::ffff:10.0.0.1']) expect(isLoopbackHost(host), host).toBe(false);
  });

  it('requiredRole: viewer lee, editor escribe, admin borra proyectos y gestiona sus miembros; lo desconocido pide editor', () => {
    const table: Array<[string, string[], TokenRole]> = [
      ['GET', [], 'viewer'],
      ['GET', ['p'], 'viewer'],
      ['GET', ['p', 'bundle'], 'viewer'],
      ['GET', ['p', 'check'], 'viewer'],
      ['GET', ['p', 'diagrams', 'd'], 'viewer'],
      ['GET', ['p', 'members'], 'viewer'], // ver quién pertenece
      ['HEAD', ['p'], 'viewer'],
      ['POST', [], 'editor'], // crear proyecto
      ['POST', ['import'], 'editor'],
      ['PATCH', ['p'], 'editor'], // renombrar proyecto
      ['POST', ['p', 'diagrams'], 'editor'],
      ['PUT', ['p', 'diagrams', 'd'], 'editor'],
      ['PATCH', ['p', 'diagrams', 'd'], 'editor'],
      ['DELETE', ['p', 'diagrams', 'd'], 'editor'],
      ['DELETE', ['p'], 'admin'], // borrar proyecto
      ['DELETE', ['import'], 'admin'], // un proyecto que se llame así
      ['PUT', ['p', 'members', 'ana'], 'admin'], // compartir y dejar de compartir
      ['DELETE', ['p', 'members', 'ana'], 'admin'],
      ['POST', ['p', 'members'], 'admin'],
      ['GET', ['p', 'diagrams', 'd', 'versions'], 'viewer'], // historial de versiones: leer
      ['GET', ['p', 'diagrams', 'd', 'versions', '3'], 'viewer'],
      ['POST', ['p', 'diagrams', 'd', 'versions', '3', 'restore'], 'editor'], // restaurar y nombrar
      ['PATCH', ['p', 'diagrams', 'd', 'versions', '3'], 'editor'],
      ['DELETE', ['p', 'diagrams', 'd', 'versions', '3'], 'admin'], // borrar una nombrada
      ['PUT', ['p', 'diagrams', 'd', 'versions', '3'], 'editor'],
      ['PUT', [], 'editor'], // lo que no existe: nunca un viewer
      ['PUT', ['p'], 'editor'],
      ['DELETE', [], 'editor'],
      ['PROPFIND', ['p'], 'editor'],
    ];
    for (const [method, parts, role] of table) expect(requiredRole(method, parts), `${method} /${parts.join('/')}`).toBe(role);
  });
});

// ───────────── la API con autenticación ─────────────

interface Cloud {
  base: string;
  root: string;
  file: string;
  /** Un token por rol y el de una persona que luego se revoca. */
  tokens: { admin: string; editor: string; viewer: string };
  store: TokenStore;
  /** Lo que el almacén de tokens anotó en su registro. */
  logs: string[];
}

async function startCloud(options: Partial<ServeOptions> = {}): Promise<Cloud> {
  const dir = mkdtempSync(join(tmpdir(), 'iark-cloud-'));
  folders.push(dir);
  const root = join(dir, 'espacio');
  mkdirSync(root);
  const file = join(dir, 'tokens.json');
  const tokens = {
    admin: createToken(file, { name: 'Ana', role: 'admin' }).token,
    editor: createToken(file, { name: 'Eva', role: 'editor' }).token,
    viewer: createToken(file, { name: 'Vic', role: 'viewer' }).token,
  };
  const logs: string[] = [];
  const store = TokenStore.open(file, (line) => void logs.push(line));
  const server = createSuiteServer({ registry: createDefaultRegistry(), version: '1', projects: new FolderProjectStore(root), tokens: store, ...options });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, root, file, tokens, store, logs };
}

const as = (token: string, extra: Record<string, string> = {}): Record<string, string> => ({ Authorization: `Bearer ${token}`, ...extra });

/** Una petición con cuerpo JSON (si lo hay) y el `Content-Type` que exige la API; `headers` añade o pisa cabeceras. */
function call(base: string, token?: string) {
  const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined || method !== 'GET' ? JSON_TYPE : {}), ...(token ? as(token) : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
  return {
    get: (path: string, headers?: Record<string, string>) => send('GET', path, undefined, headers),
    post: (path: string, body?: unknown, headers?: Record<string, string>) => send('POST', path, body ?? {}, headers),
    put: (path: string, body?: unknown, headers?: Record<string, string>) => send('PUT', path, body ?? {}, headers),
    patch: (path: string, body?: unknown, headers?: Record<string, string>) => send('PATCH', path, body ?? {}, headers),
    del: (path: string, headers?: Record<string, string>) => send('DELETE', path, undefined, headers),
  };
}

/** Una petición con las cabeceras exactas (`fetch` no deja cambiar `Host`). */
function raw(base: string, method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: url.hostname, port: url.port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const tree = (root: string): string => JSON.stringify(readdirSync(root, { recursive: true }).sort());

describe('iark serve --tokens: autenticación', () => {
  it('sin token (o con uno que no vale) la API de proyectos y whoami responden 401 con el mismo mensaje, sin decir si el token existió', async () => {
    const { base, root, file, tokens } = await startCloud({ authLimits: { freeAttempts: 1000 } }); // aquí no se prueba el freno
    // un token que existió y se revocó, y uno que nunca existió, se tratan igual
    const { token: revoked } = createToken(file, { name: 'Ex', role: 'admin' });
    revokeToken(file, 'Ex');
    const attempts: Array<[string, Record<string, string>]> = [
      ['sin cabecera', {}],
      ['esquema Basic', { Authorization: `Basic ${Buffer.from('Ana:x').toString('base64')}` }],
      ['sin esquema', { Authorization: tokens.admin }],
      ['Bearer vacío', { Authorization: 'Bearer ' }],
      ['token que nunca existió', as('iark_nunca-existio')],
      ['token revocado', as(revoked)],
      ['un token válido con un carácter de más', as(`${tokens.admin}x`)],
      ['el hash de un token válido', as(hashToken(tokens.admin))],
    ];
    const messages = new Set<string>();
    for (const [label, headers] of attempts) {
      for (const [method, path] of [['GET', '/api/whoami'], ['GET', '/api/projects'], ['POST', '/api/projects'], ['DELETE', '/api/projects/p']]) {
        const res = await raw(base, method, path, { host: new URL(base).host, ...JSON_TYPE, ...headers });
        expect(res.status, `${label}: ${method} ${path}`).toBe(401);
        expect(res.headers['www-authenticate']).toBe('Bearer realm="iark"');
        expect(res.headers['cache-control']).toBe('no-store');
        const body = JSON.parse(res.body);
        expect(body, label).toEqual(UNAUTHORIZED);
        messages.add(body.error);
        for (const token of Object.values(tokens)) expect(res.body).not.toContain(token);
      }
    }
    expect(messages.size).toBe(1);
    expect([...messages][0]).toMatch(/Authorization: Bearer <token>/);
    expect(readdirSync(root)).toEqual([]); // y nada se escribió
  });

  it('con un token válido, whoami dice quién es y con qué rol; sin tokens configurados dice { auth: false } y es público', async () => {
    const { base, tokens } = await startCloud();
    expect(await (await call(base, tokens.admin).get('/api/whoami')).json()).toEqual({ auth: true, name: 'Ana', role: 'admin' });
    expect(await (await call(base, tokens.editor).get('/api/whoami')).json()).toEqual({ auth: true, name: 'Eva', role: 'editor' });
    expect(await (await call(base, tokens.viewer).get('/api/whoami')).json()).toEqual({ auth: true, name: 'Vic', role: 'viewer' });
    // el esquema no distingue mayúsculas
    expect((await call(base).get('/api/whoami', { Authorization: `bearer ${tokens.viewer}` })).status).toBe(200);
    // solo GET
    const post = await call(base, tokens.admin).post('/api/whoami');
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET');

    const open = await startCloud({ tokens: undefined });
    const whoami = await call(open.base).get('/api/whoami');
    expect(whoami.status).toBe(200);
    expect(await whoami.json()).toEqual({ auth: false });
    // y un token cualquiera en la cabecera no cambia nada
    expect(await (await call(open.base).get('/api/whoami', { Authorization: 'Bearer lo-que-sea' })).json()).toEqual({ auth: false });
  });

  it('el manifiesto, los módulos, capabilities y schema siguen siendo públicos; el cálculo (validar…) exige credencial (serveCompute.test.ts)', async () => {
    const { base, tokens } = await startCloud();
    expect((await fetch(`${base}/api/modules`)).status).toBe(200);
    expect((await fetch(`${base}/api/c4/capabilities`)).status).toBe(200);
    expect((await fetch(`${base}/api/c4/schema`)).status).toBe(200);
    expect((await fetch(`${base}/.well-known/iark.json`)).status).toBe(200);
    expect((await call(base).post('/api/c4/validate', '{}')).status).toBe(401);
    expect((await call(base, tokens.viewer).post('/api/c4/validate', '{}')).status).not.toBe(401);
    // `publicCompute` (--public-compute) la deja abierta
    const open = await startCloud({ publicCompute: true });
    expect((await call(open.base).post('/api/c4/validate', '{}')).status).not.toBe(401);
  });

  it('el manifiesto anuncia projectsAuth: bearer con tokens, none sin ellos y nada sin espacio de trabajo', async () => {
    const { base } = await startCloud();
    const manifest = await (await fetch(`${base}/.well-known/iark.json`)).json(); // sin token: el cliente lo lee antes de pedirlo
    expect(manifest).toMatchObject({ projects: '../api/projects', projectsAuth: 'bearer' });
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
    expect(JSON.stringify(manifest)).not.toMatch(/iark_|hash/);

    const open = await startCloud({ tokens: undefined });
    expect(await (await fetch(`${open.base}/.well-known/iark.json`)).json()).toMatchObject({ projects: '../api/projects', projectsAuth: 'none' });

    const none = await startCloud({ projects: undefined });
    const bare = (await (await fetch(`${none.base}/.well-known/iark.json`)).json()) as Record<string, unknown>;
    expect(bare.projects).toBeUndefined();
    expect(bare.projectsAuth).toBeUndefined();
  });

  it('crear y revocar tokens surte efecto al instante, sin reiniciar el servidor', async () => {
    const { base, file, tokens } = await startCloud();
    const { token: nuevo } = createToken(file, { name: 'Nuria', role: 'editor' });
    expect(await (await call(base, nuevo).get('/api/whoami')).json()).toEqual({ auth: true, name: 'Nuria', role: 'editor' });
    revokeToken(file, 'nuria');
    const res = await call(base, nuevo).get('/api/projects');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(UNAUTHORIZED);
    expect((await call(base, tokens.admin).get('/api/projects')).status).toBe(200); // los demás siguen
  });

  it('un archivo de tokens dañado o ilegible cierra el acceso a todos (503, nunca abierto), sin contar como intento fallido, y se recupera al arreglarlo', async () => {
    const { base, file, tokens, logs } = await startCloud();
    const saved = readFileSync(file, 'utf8');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      let step = 0;
      for (const content of ['{ roto', '', JSON.stringify({ version: 1, tokens: [{ name: 'X', role: 'root', hash: 'a'.repeat(64), createdAt: '2026-01-01' }] })]) {
        writeFileSync(file, content);
        utimesSync(file, new Date(), new Date(Date.now() + 10_000 * ++step));
        for (const headers of [as(tokens.admin), as('iark_otro'), {}]) {
          for (const [method, path] of [['GET', '/api/whoami'], ['GET', '/api/projects'], ['DELETE', '/api/projects/p'], ['POST', '/api/projects']]) {
            const res = await raw(base, method, path, { host: new URL(base).host, ...JSON_TYPE, ...headers });
            expect(res.status, `${method} ${path} con ${content.slice(0, 12)}`).toBe(503);
            const body = JSON.parse(res.body);
            expect(body).toEqual({ error: expect.any(String), code: 'unavailable' });
            expect(res.headers['www-authenticate']).toBeUndefined();
            expect(res.body).not.toContain(file); // la ruta del servidor no se cuenta
          }
        }
      }
      expect(logs.some((l) => l.startsWith('error: El archivo de tokens no es válido'))).toBe(true);
      // se arregla (el mismo contenido de antes) y vuelve el acceso; las 36 peticiones de arriba no frenaron a nadie
      writeFileSync(file, saved);
      utimesSync(file, new Date(), new Date(Date.now() + 999_000));
      expect((await call(base, tokens.admin).get('/api/whoami')).status).toBe(200);
      // un archivo que desaparece también cierra el acceso
      rmSync(file);
      expect((await call(base, tokens.admin).get('/api/projects')).status).toBe(503);
    } finally {
      stderr.mockRestore();
    }
  });
});

describe('iark serve --tokens: roles', () => {
  /** Un servidor con el proyecto `p` y el diagrama `d`, creados por el admin. */
  async function withProject(options: Partial<ServeOptions> = {}) {
    const cloud = await startCloud(options);
    const admin = call(cloud.base, cloud.tokens.admin);
    expect((await admin.post('/api/projects', { name: 'P' })).status).toBe(201);
    expect((await admin.post('/api/projects/p/diagrams', { module: 'c4', name: 'D', text: '{}' })).status).toBe(201);
    return cloud;
  }

  it('viewer solo lee: cada escritura recibe 403 { error, code: "forbidden" } y no toca el disco', async () => {
    const { base, root, tokens } = await withProject();
    const api = call(base, tokens.viewer);
    const before = tree(root);

    for (const path of ['/api/projects', '/api/projects/p', '/api/projects/p/diagrams/d', '/api/projects/p/bundle', '/api/projects/p/check', '/api/whoami']) {
      expect((await api.get(path)).status, path).toBe(200);
    }
    const writes: Array<[string, Response]> = [
      ['crear proyecto', await api.post('/api/projects', { name: 'Nuevo' })],
      ['renombrar proyecto', await api.patch('/api/projects/p', { name: 'Otro' })],
      ['borrar proyecto', await api.del('/api/projects/p')],
      ['importar', await api.post('/api/projects/import', '{}')],
      ['crear diagrama', await api.post('/api/projects/p/diagrams', { module: 'c4', name: 'N', text: '{}' })],
      ['guardar diagrama', await api.put('/api/projects/p/diagrams/d', { text: '{"x":1}' })],
      ['renombrar diagrama', await api.patch('/api/projects/p/diagrams/d', { name: 'Otro' })],
      ['borrar diagrama', await api.del('/api/projects/p/diagrams/d')],
    ];
    for (const [label, res] of writes) {
      expect(res.status, label).toBe(403);
      expect(res.headers.get('www-authenticate'), label).toBeNull();
      expect(await res.json(), label).toEqual({ error: 'El rol «viewer» no permite esta operación (hace falta «' + (label === 'borrar proyecto' ? 'admin' : 'editor') + '»).', code: 'forbidden' });
    }
    expect(tree(root)).toBe(before);
  });

  it('el rol se comprueba antes que el cuerpo, la ruta y el tipo de contenido: un viewer no sondea ni con peticiones torcidas', async () => {
    const { base, root, tokens } = await withProject();
    const before = tree(root);
    const viewer = call(base, tokens.viewer);
    expect((await viewer.del('/api/projects/no-existe')).status).toBe(403); // y no 404
    expect((await viewer.post('/api/projects', '{ roto')).status).toBe(403); // y no 400
    expect((await viewer.post('/api/projects/nada/diagrams', { module: 'c4', text: '{}' })).status).toBe(403);
    expect((await viewer.put('/api/projects')).status).toBe(403); // ni 405
    expect((await viewer.patch('/api/projects/p/bundle', { name: 'x' })).status).toBe(403);
    expect((await viewer.del('/api/projects/..%2fx')).status).toBe(403);
    const noType = await raw(base, 'POST', '/api/projects', { host: new URL(base).host, ...as(tokens.viewer) }, '{}');
    expect(noType.status).toBe(403); // y no 415
    expect(tree(root)).toBe(before);
    // el editor, en cambio, recibe 403 solo en lo que es de admin
    const editor = call(base, tokens.editor);
    expect((await editor.del('/api/projects/no-existe')).status).toBe(403);
    expect((await editor.del('/api/projects/import')).status).toBe(403); // un proyecto que se llamara `import`: también de admin
    expect((await call(base, tokens.admin).del('/api/projects/import')).status).toBe(404);
    expect((await editor.put('/api/projects')).status).toBe(405); // lo que ya era un error de método, lo sigue siendo
    expect((await editor.post('/api/projects', '{ roto')).status).toBe(400);
  });

  it('editor escribe diagramas, crea y renombra proyectos e importa, pero no borra proyectos', async () => {
    const { base, root, tokens } = await withProject();
    const api = call(base, tokens.editor);
    const created = await api.post('/api/projects', { name: 'De Eva' });
    expect(created.status).toBe(201);
    expect((await api.patch('/api/projects/de-eva', { name: 'De Eva (renombrado)' })).status).toBe(200);
    expect((await api.post('/api/projects/de-eva/diagrams', { module: 'c4', name: 'N', text: '{}' })).status).toBe(201);
    expect((await api.put('/api/projects/de-eva/diagrams/n', { text: '{"x":1}' })).status).toBe(200);
    expect((await api.patch('/api/projects/de-eva/diagrams/n', { name: 'Renombrado' })).status).toBe(200);
    const bundle = await (await api.get('/api/projects/de-eva/bundle')).text();
    expect((await api.post('/api/projects/import', bundle)).status).toBe(201);
    expect((await api.del('/api/projects/de-eva/diagrams/n')).status).toBe(200);
    const before = tree(root);
    const refused = await api.del('/api/projects/de-eva');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'El rol «editor» no permite esta operación (hace falta «admin»).', code: 'forbidden' });
    expect(tree(root)).toBe(before);
  });

  it('admin puede todo, también borrar proyectos', async () => {
    const { base, root, tokens } = await withProject();
    const api = call(base, tokens.admin);
    expect((await api.post('/api/projects', { name: 'Otro' })).status).toBe(201);
    expect((await api.del('/api/projects/otro')).status).toBe(200);
    expect((await api.del('/api/projects/p/diagrams/d')).status).toBe(200);
    expect((await api.del('/api/projects/p')).status).toBe(200);
    expect(readdirSync(root)).toEqual([]);
  });
});

describe('iark serve --tokens: freno de intentos fallidos', () => {
  const clock = () => {
    const state = { t: 5_000_000 };
    return { state, limits: { now: () => state.t } };
  };

  it('tras cinco intentos fallidos desde la misma dirección responde 429 con Retry-After, también a un token bueno', async () => {
    const time = clock();
    const { base, tokens } = await startCloud({ authLimits: time.limits });
    const bad = (path = '/api/projects') => raw(base, 'GET', path, { host: new URL(base).host, ...as('iark_adivinando') });
    for (let i = 0; i < 5; i++) expect((await bad()).status).toBe(401);

    const blocked = await bad();
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBe('1');
    expect(JSON.parse(blocked.body)).toEqual({ error: expect.stringMatching(/Demasiados intentos fallidos.*espere 1 s/), code: 'rate-limited' });
    expect(blocked.headers['www-authenticate']).toBeUndefined();
    // con el freno puesto no se evalúa nada (ni un token bueno, ni sin cabecera, ni whoami): no sirve de oráculo
    for (const headers of [as(tokens.admin), as('iark_otro'), {}]) {
      for (const path of ['/api/projects', '/api/whoami']) {
        const res = await raw(base, 'GET', path, { host: new URL(base).host, ...headers });
        expect(res.status).toBe(429);
        expect(JSON.parse(res.body).code).toBe('rate-limited');
      }
    }
    // lo que no es de estas rutas no se ve afectado
    expect((await fetch(`${base}/api/modules`)).status).toBe(200);
    expect((await fetch(`${base}/.well-known/iark.json`)).status).toBe(200);

    // pasado el plazo vuelve a poder entrar; un fallo más duplica el plazo
    time.state.t += 1000;
    expect((await call(base, tokens.admin).get('/api/whoami')).status).toBe(200);
    expect((await bad()).status).toBe(401);
    const second = await bad();
    expect(second.status).toBe(429);
    expect(second.headers['retry-after']).toBe('2');
    time.state.t += 2000;
    expect((await call(base, tokens.viewer).get('/api/projects')).status).toBe(200);
  });

  it('las peticiones sin cabecera no cuentan como intentos fallidos: no adivinan nada', async () => {
    const { base, tokens } = await startCloud();
    for (let i = 0; i < 25; i++) expect((await call(base).get('/api/projects')).status).toBe(401);
    expect((await call(base, tokens.admin).get('/api/projects')).status).toBe(200);
  });

  it('el freno es por dirección: con --trust-proxy se distingue a cada cliente por X-Forwarded-For (la última), y sin él se ignora la cabecera', async () => {
    const time = clock();
    const proxied = await startCloud({ authLimits: time.limits, trustProxy: true });
    const via = (xff: string, token: string) => call(proxied.base).get('/api/whoami', { ...as(token), 'X-Forwarded-For': xff });
    for (let i = 0; i < 5; i++) expect((await via('198.51.100.1', 'iark_mal')).status).toBe(401);
    expect((await via('198.51.100.1', proxied.tokens.admin)).status).toBe(429);
    expect((await via('198.51.100.2', proxied.tokens.admin)).status).toBe(200); // otro cliente, tras el mismo proxy
    // lo que el cliente ponga delante no importa: cuenta la última, la del proxy
    expect((await via('203.0.113.50, 198.51.100.1', proxied.tokens.admin)).status).toBe(429);
    expect((await via('198.51.100.1, 198.51.100.3', proxied.tokens.admin)).status).toBe(200);

    const direct = await startCloud({ authLimits: time.limits });
    const spoof = (xff: string, token: string) => call(direct.base).get('/api/whoami', { ...as(token), 'X-Forwarded-For': xff });
    for (let i = 0; i < 5; i++) expect((await spoof(`198.51.100.${i}`, 'iark_mal')).status).toBe(401);
    expect((await spoof('198.51.100.99', direct.tokens.admin)).status).toBe(429); // cambiar la cabecera no evita el freno
  });

  it('la respuesta 429 lleva las cabeceras de CORS y deja leer Retry-After al navegador', async () => {
    const time = clock();
    const { base } = await startCloud({ authLimits: time.limits, cors: ['https://app.example'] });
    const app = { Origin: 'https://app.example' };
    for (let i = 0; i < 5; i++) await call(base).get('/api/projects', { ...as('iark_mal'), ...app });
    const res = await call(base).get('/api/projects', { ...as('iark_mal'), ...app });
    expect(res.status).toBe(429);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(res.headers.get('access-control-expose-headers')).toMatch(/Retry-After/);
  });
});

describe('iark serve --tokens: CORS y comprobaciones de navegador', () => {
  it('el preflight con Authorization funciona y anuncia todos los métodos, para los orígenes nombrados y también para `*`', async () => {
    for (const cors of [['*'], ['https://app.example']]) {
      const { base } = await startCloud({ cors });
      const origin = cors[0] === '*' ? 'https://cualquiera.example' : 'https://app.example';
      const preflight = await fetch(`${base}/api/projects/p/diagrams/d`, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'DELETE', 'Access-Control-Request-Headers': 'authorization,content-type' },
      });
      expect(preflight.status, cors[0]).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe(cors[0] === '*' ? '*' : origin);
      expect(preflight.headers.get('access-control-allow-methods')).toBe('GET, POST, PUT, PATCH, DELETE, OPTIONS');
      expect(preflight.headers.get('access-control-allow-headers')).toBe('Content-Type, Authorization');
      expect(preflight.headers.get('access-control-expose-headers')).toBe('Retry-After, Content-Disposition, Location');
      expect(preflight.headers.get('access-control-allow-credentials')).toBeNull(); // no se envían cookies
      expect(preflight.headers.get('access-control-max-age')).toBe('600');
      // el preflight no lleva credenciales: no las pide
      const whoami = await fetch(`${base}/api/whoami`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
      expect(whoami.status).toBe(204);
      expect(whoami.headers.get('access-control-allow-headers')).toBe('Content-Type, Authorization');
    }
  });

  it('las peticiones con token desde un origen de --cors (o `*`) funcionan y las respuestas llevan las cabeceras de CORS, también los errores', async () => {
    const named = await startCloud({ cors: ['https://app.example'] });
    const app = { Origin: 'https://app.example' };
    const ok = await call(named.base, named.tokens.editor).post('/api/projects', { name: 'Desde la app' }, app);
    expect(ok.status).toBe(201);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(ok.headers.get('vary')).toBe('Origin');
    for (const [res, status] of [
      [await call(named.base).get('/api/projects', app), 401],
      [await call(named.base, named.tokens.viewer).del('/api/projects/desde-la-app', app), 403],
    ] as const) {
      expect(res.status).toBe(status);
      expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example');
    }
    // un origen que no está en la lista no recibe cabeceras de CORS (el navegador no dejaría leer la respuesta)
    const other = await call(named.base, named.tokens.viewer).get('/api/projects', { Origin: 'https://otra.example' });
    expect(other.status).toBe(200);
    expect(other.headers.get('access-control-allow-origin')).toBeNull();

    const wild = await startCloud({ cors: ['*'] });
    const any = await call(wild.base, wild.tokens.admin).post('/api/projects', { name: 'Desde cualquier sitio' }, { Origin: 'https://cualquiera.example' });
    expect(any.status).toBe(201);
    expect(any.headers.get('access-control-allow-origin')).toBe('*');
    // y sin token ese mismo sitio no hace nada
    expect((await call(wild.base).post('/api/projects', { name: 'Robado' }, { Origin: 'https://cualquiera.example' })).status).toBe(401);
    expect(readdirSync(wild.root)).toEqual(['desde-cualquier-sitio']);
  });

  it('solo las rutas con credencial (proyectos, whoami y el cálculo) cambian de CORS: el resto de la API anuncia lo de siempre', async () => {
    const { base } = await startCloud({ cors: ['*'] });
    const preflight = await fetch(`${base}/api/c4/capabilities`, { method: 'OPTIONS', headers: { Origin: 'https://x.example', 'Access-Control-Request-Method': 'GET' } });
    expect(preflight.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
    expect(preflight.headers.get('access-control-allow-headers')).toBe('Content-Type');
    expect(preflight.headers.get('access-control-expose-headers')).toBeNull();
    // el cálculo exige token: su preflight tiene que anunciar `Authorization` (si no, el navegador no lo deja pasar)
    const compute = await fetch(`${base}/api/c4/validate`, { method: 'OPTIONS', headers: { Origin: 'https://x.example', 'Access-Control-Request-Method': 'POST' } });
    expect(compute.headers.get('access-control-allow-headers')).toBe('Content-Type, Authorization');
    expect(compute.headers.get('access-control-expose-headers')).toContain('Retry-After');
    // y con --public-compute vuelve a lo de siempre
    const open = await startCloud({ cors: ['*'], publicCompute: true });
    const publicPreflight = await fetch(`${open.base}/api/c4/validate`, { method: 'OPTIONS', headers: { Origin: 'https://x.example', 'Access-Control-Request-Method': 'POST' } });
    expect(publicPreflight.headers.get('access-control-allow-headers')).toBe('Content-Type');
  });

  it('con tokens ya no se comprueban Host ni Origin en estas rutas (el token es una cabecera, no una credencial ambiental), pero sí Content-Type: application/json', async () => {
    const { base, root, tokens } = await startCloud();
    const host = new URL(base).host;
    // otro nombre de host (DNS rebinding) y otro origen: con token, pasan
    for (const headers of [{ host: 'evil.example' }, { host: 'nube.ejemplo.org', origin: 'https://evil.example' }, { host, origin: 'null' }, { host: '192.168.1.5' }] as Array<Record<string, string>>) {
      const res = await raw(base, 'GET', '/api/projects', { ...as(tokens.viewer), ...headers });
      expect(res.status, JSON.stringify(headers)).toBe(200);
    }
    const body = '{"name":"Desde otro host"}';
    const created = await raw(base, 'POST', '/api/projects', { host: 'evil.example', origin: 'https://evil.example', ...as(tokens.editor), ...JSON_TYPE, 'content-length': String(Buffer.byteLength(body)) }, body);
    expect(created.status).toBe(201);
    // sin token siguen sin pasar, pero con 401 (no con 403 de Host u Origin)
    expect((await raw(base, 'GET', '/api/projects', { host: 'evil.example', origin: 'https://evil.example' })).status).toBe(401);
    // Content-Type: sigue exigido en POST, PUT, PATCH y DELETE
    const before = tree(root);
    for (const [method, path] of [['POST', '/api/projects'], ['PUT', '/api/projects/desde-otro-host/diagrams/x'], ['PATCH', '/api/projects/desde-otro-host'], ['DELETE', '/api/projects/desde-otro-host'], ['POST', '/api/projects/import']]) {
      const res = await raw(base, method, path, { host, origin: 'https://evil.example', ...as(tokens.admin), 'content-type': 'text/plain', 'content-length': '2' }, '{}');
      expect(res.status, `${method} ${path}`).toBe(415);
      expect(JSON.parse(res.body).error).toMatch(/Content-Type: application\/json/);
    }
    expect((await raw(base, 'DELETE', '/api/projects/desde-otro-host', { host, ...as(tokens.admin) })).status).toBe(415);
    expect(tree(root)).toBe(before);
  });

  it('sin --tokens nada cambia: ni se pide token, ni se ignoran Host y Origin, ni se anuncia Authorization en CORS', async () => {
    const { base, root } = await startCloud({ tokens: undefined, cors: ['*', 'https://app.example'] });
    const api = call(base);
    expect((await api.post('/api/projects', { name: 'Libre' })).status).toBe(201); // sin cabecera Authorization
    expect((await api.get('/api/projects', { Authorization: 'Bearer cualquier-cosa' })).status).toBe(200); // y una que sobre, se ignora
    // el Host y el Origin se siguen comprobando
    expect((await raw(base, 'GET', '/api/projects', { host: 'evil.example' })).status).toBe(403);
    expect((await api.get('/api/projects', { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await api.post('/api/projects', { name: 'Robado' }, { Origin: 'https://cualquiera.example' })).status).toBe(403);
    expect(readdirSync(root)).toEqual(['libre']);
    // y el CORS es el de siempre: hay que nombrar el origen para las escrituras, y no se anuncia Authorization
    const wildOnly = await startCloud({ tokens: undefined, cors: ['*'] });
    const wild = await fetch(`${wildOnly.base}/api/projects`, { method: 'OPTIONS', headers: { Origin: 'https://x.example', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization' } });
    expect(wild.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
    expect(wild.headers.get('access-control-allow-headers')).toBe('Content-Type');
    expect(wild.headers.get('access-control-expose-headers')).toBeNull();
    const named = await fetch(`${base}/api/projects/libre`, { method: 'OPTIONS', headers: { Origin: 'https://app.example', 'Access-Control-Request-Method': 'DELETE' } });
    expect(named.headers.get('access-control-allow-headers')).toBe('Content-Type');
  });
});

describe('iark serve --tokens: los tokens nunca salen', () => {
  it('ni en las respuestas ni en lo que se escribe en stderr, ni con peticiones válidas, inválidas, prohibidas, frenadas o con el archivo roto', async () => {
    const time = { t: 9_000_000 };
    const { base, file, tokens, logs } = await startCloud({ authLimits: { freeAttempts: 3, now: () => time.t } });
    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const guess = 'iark_token-que-probe-y-no-existe';
    const secrets = [...Object.values(tokens), ...Object.values(tokens).map(hashToken), guess];
    const seen: string[] = [];
    const record = async (pending: Promise<Response>) => {
      const res = await pending;
      seen.push(`${res.status} ${[...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n')}\n${await res.text()}`);
      return res.status;
    };
    try {
      const admin = call(base, tokens.admin);
      expect(await record(admin.post('/api/projects', { name: 'P' }))).toBe(201);
      expect(await record(admin.get('/api/projects'))).toBe(200);
      expect(await record(admin.get('/api/whoami'))).toBe(200);
      expect(await record(call(base, tokens.viewer).del('/api/projects/p'))).toBe(403);
      for (let i = 0; i < 3; i++) expect(await record(call(base).get('/api/projects', as(guess)))).toBe(401);
      expect(await record(call(base).get('/api/projects', as(guess)))).toBe(429);
      expect(await record(admin.get('/api/projects'))).toBe(429); // incluso con un token bueno
      time.t += 60_000;
      expect(await record(fetch(`${base}/.well-known/iark.json`))).toBe(200);
      writeFileSync(file, `{ ${tokens.admin}`); // un archivo roto que contiene un token
      utimesSync(file, new Date(), new Date(Date.now() + 77_000));
      expect(await record(admin.get('/api/whoami', { 'X-Forwarded-For': tokens.viewer }))).toBe(503);
    } finally {
      stderr.mockRestore();
    }
    expect(logs.some((line) => line.startsWith('error:'))).toBe(true); // se registró el problema del archivo…
    const everything = [...seen, ...written, ...logs].join('\n');
    for (const secret of secrets) {
      expect(everything).not.toContain(secret); // …pero sin ningún token ni hash
      expect(everything).not.toContain(secret.replace(/^iark_/, '')); // ni sin el prefijo
    }
  });
});
