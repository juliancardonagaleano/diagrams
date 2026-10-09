import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { manifestSchema, parseBundle } from '@iark/kernel';
import { createDefaultRegistry } from './registry';
import { createSuiteServer, type ServeOptions } from './serve';
import { FolderProjectStore } from './workspace';
import { buildCliBundle, BUNDLE_TIMEOUT, PROCESS_TEST_TIMEOUT, type CliBundle } from '../../tests/helpers/cliBundle';

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT, hookTimeout: BUNDLE_TIMEOUT });

const example = (file: string): string => readFileSync(`examples/${file}`, 'utf8');
const JSON_TYPE = { 'Content-Type': 'application/json' };

const folders: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Running {
  base: string;
  /** La carpeta de trabajo (un hijo de `outside`). */
  root: string;
  /** Una carpeta hermana de la raíz: lo que no debe tocarse nunca. */
  outside: string;
  server: Server;
}

async function start(options: Partial<ServeOptions> = {}, workspace = true): Promise<Running> {
  const outside = mkdtempSync(join(tmpdir(), 'iark-api-'));
  folders.push(outside);
  const root = join(outside, 'espacio');
  mkdirSync(root);
  const server = createSuiteServer({ registry: createDefaultRegistry(), version: '1', ...(workspace ? { projects: new FolderProjectStore(root) } : {}), ...options });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, root, outside, server };
}

/** Una petición con cuerpo JSON (si lo hay) y el `Content-Type` que exige la API; `headers` pisa lo que haga falta. */
function call(base: string) {
  const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method, headers: { ...(body !== undefined || method !== 'GET' ? JSON_TYPE : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
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

describe('iark serve: API de proyectos', () => {
  it('sin --workspace, todas las rutas de proyectos responden 404 y el manifiesto no anuncia proyectos', async () => {
    const { base } = await start({}, false);
    const api = call(base);
    for (const res of [await api.get('/api/projects'), await api.post('/api/projects', { name: 'X' }), await api.get('/api/projects/x'), await api.put('/api/projects/x/diagrams/y', { text: '' }), await api.del('/api/projects/x')]) {
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe('Este servicio no tiene espacio de trabajo (use --workspace <carpeta>)');
    }
    const manifest = await (await fetch(`${base}/.well-known/iark.json`)).json();
    expect(manifest.projects).toBeUndefined();
  });

  it('con espacio de trabajo, el manifiesto anuncia la API de proyectos (y sigue cumpliendo iark.manifest/1)', async () => {
    const { base } = await start();
    const manifest = await (await fetch(`${base}/.well-known/iark.json`)).json();
    expect(manifest.projects).toBe('../api/projects');
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('recorre el ciclo completo: crear, listar, renombrar, guardar, comprobar, exportar, importar y borrar', async () => {
    const { base, root } = await start();
    const api = call(base);
    expect(await (await api.get('/api/projects')).json()).toEqual([]);

    const created = await api.post('/api/projects', { name: 'Tienda web', description: 'Pedidos y pagos' });
    expect(created.status).toBe(201);
    expect(created.headers.get('location')).toBe('/api/projects/tienda-web');
    expect(await created.json()).toMatchObject({ id: 'tienda-web', name: 'Tienda web', description: 'Pedidos y pagos', diagrams: [] });
    const duplicate = await api.post('/api/projects', { name: 'TIENDA WEB' });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: 'exists' });

    const securityText = example('seguridad-ejemplo.json');
    const added = await api.post('/api/projects/tienda-web/diagrams', { module: 'security', name: 'Amenazas', text: securityText });
    expect(added.status).toBe(201);
    const meta = await added.json();
    expect(meta).toMatchObject({ id: 'amenazas', module: 'security', name: 'Amenazas' });
    expect(added.headers.get('location')).toBe('/api/projects/tienda-web/diagrams/amenazas');
    await api.post('/api/projects/tienda-web/diagrams', { module: 'platform', name: 'Despliegue', text: example('plataforma-ejemplo.json') });
    await api.post('/api/projects/tienda-web/diagrams', { module: 'integration', name: 'Pedidos', text: example('pedidos-integracion.json') });
    expect(readdirSync(join(root, 'tienda-web')).sort()).toEqual(['.versiones', 'amenazas.security.json', 'despliegue.platform.json', 'pedidos.integration.json', 'project.json']); // y el historial de versiones, oculto

    // la lista trae los diagramas pero no sus documentos
    const listed = await (await api.get('/api/projects')).json();
    expect(listed).toHaveLength(1);
    expect(listed[0].diagrams.map((d: { name: string }) => d.name)).toEqual(['Amenazas', 'Despliegue', 'Pedidos']);
    expect(JSON.stringify(listed)).not.toContain('"text"');
    expect(await (await api.get('/api/projects/tienda-web')).json()).toMatchObject({ id: 'tienda-web', name: 'Tienda web' });

    // leer un diagrama devuelve su documento tal cual
    const diagram = await (await api.get('/api/projects/tienda-web/diagrams/amenazas')).json();
    expect(diagram).toMatchObject({ id: 'amenazas', module: 'security', name: 'Amenazas', text: securityText });

    // guardar: con la marca vigente sí; con una vieja, conflicto
    const saved = await api.put('/api/projects/tienda-web/diagrams/amenazas', { text: securityText.replace('Seguridad de la tienda', 'Seguridad de la tienda web'), ifUpdatedAt: diagram.updatedAt });
    expect(saved.status).toBe(200);
    const savedMeta = await saved.json();
    expect(savedMeta.updatedAt > diagram.updatedAt).toBe(true);
    const stale = await api.put('/api/projects/tienda-web/diagrams/amenazas', { text: '{}', ifUpdatedAt: diagram.updatedAt });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'conflict', error: expect.stringContaining('cambió') });
    expect((await (await api.get('/api/projects/tienda-web/diagrams/amenazas')).json()).text).toContain('Seguridad de la tienda web');
    // sin `ifUpdatedAt` se guarda sin más
    expect((await api.put('/api/projects/tienda-web/diagrams/amenazas', { text: securityText })).status).toBe(200);

    // renombrar
    const renamedDiagram = await api.patch('/api/projects/tienda-web/diagrams/pedidos', { name: 'Integración de pedidos' });
    expect(await renamedDiagram.json()).toMatchObject({ id: 'pedidos', name: 'Integración de pedidos' });
    expect((await api.patch('/api/projects/tienda-web/diagrams/pedidos', { name: 'amenazas' })).status).toBe(409);
    const renamed = await api.patch('/api/projects/tienda-web', { name: 'Tienda en línea' });
    expect(await renamed.json()).toMatchObject({ id: 'tienda-web', name: 'Tienda en línea' });

    // comprobar el proyecto
    const check = await (await api.get('/api/projects/tienda-web/check')).json();
    expect(check.project).toEqual({ id: 'tienda-web', name: 'Tienda en línea' });
    expect(check.ok).toBe(true);
    expect(check.diagrams.map((d: { status: string }) => d.status)).toEqual(['ok', 'ok', 'ok']);
    expect(check.graph.links.length).toBeGreaterThan(5);

    // el archivo único y volver a importarlo
    const bundle = await api.get('/api/projects/tienda-web/bundle');
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get('content-disposition')).toBe('attachment; filename="tienda-en-linea.iark-project.json"');
    expect(bundle.headers.get('content-type')).toContain('application/json');
    const bundleText = await bundle.text();
    expect(parseBundle(bundleText).diagrams.map((d) => d.name)).toEqual(['Amenazas', 'Despliegue', 'Integración de pedidos']);
    const imported = await api.post('/api/projects/import', bundleText);
    expect(imported.status).toBe(201);
    expect(await imported.json()).toMatchObject({ project: { id: 'tienda-en-linea-2', name: 'Tienda en línea (2)' }, renamedFrom: 'Tienda en línea', diagrams: 3 });
    const named = await api.post('/api/projects/import?name=Otra%20copia', bundleText);
    expect((await named.json()).project).toMatchObject({ id: 'otra-copia', name: 'Otra copia' });
    expect((await api.post('/api/projects/import', '{"format":"otra-cosa"}')).status).toBe(400);
    expect((await api.post('/api/projects/import', 'no es json')).status).toBe(400);

    // borrar
    expect(await (await api.del('/api/projects/tienda-web/diagrams/despliegue')).json()).toEqual({ deleted: 'despliegue' });
    expect((await api.get('/api/projects/tienda-web/diagrams/despliegue')).status).toBe(404);
    expect(await (await api.del('/api/projects/otra-copia')).json()).toEqual({ deleted: 'otra-copia' });
    expect((await api.get('/api/projects/otra-copia')).status).toBe(404);
    expect((await api.del('/api/projects/otra-copia')).status).toBe(404);
    expect(readdirSync(root).sort()).toEqual(['tienda-web', 'tienda-en-linea-2'].sort());
  });

  it('la comprobación (GET .../check) marca como no válido un proyecto con una referencia rota', async () => {
    const { base } = await start();
    const api = call(base);
    await api.post('/api/projects', { name: 'P' });
    await api.post('/api/projects/p/diagrams', { module: 'platform', name: 'Despliegue', text: example('plataforma-ejemplo.json').replace('"urn:iark:integration:pedidos"', '"urn:iark:integration:no-existe"') });
    await api.post('/api/projects/p/diagrams', { module: 'integration', name: 'Pedidos', text: example('pedidos-integracion.json') });
    const check = await (await api.get('/api/projects/p/check')).json();
    expect(check.ok).toBe(false);
    expect(check.brokenRefs).toBeGreaterThan(0);
    expect(check.graph.problems.some((p: { reason: string }) => p.reason === 'dangling')).toBe(true);
  });

  it('valida el cuerpo: JSON roto, no objeto, campos que no son texto, módulo inválido', async () => {
    const { base } = await start();
    const api = call(base);
    await api.post('/api/projects', { name: 'P' });
    const bad = async (res: Response, status = 400) => {
      expect(res.status).toBe(status);
      return (await res.json()) as { error: string; code?: string };
    };
    expect((await bad(await api.post('/api/projects', '{ roto'))).error).toMatch(/JSON/);
    expect((await bad(await api.post('/api/projects', '[]'))).error).toMatch(/objeto/);
    expect((await bad(await api.post('/api/projects', 'null'))).error).toMatch(/objeto/);
    expect((await bad(await api.post('/api/projects', {}))).error).toMatch(/Falta "name"/);
    expect((await bad(await api.post('/api/projects', { name: 42 }))).error).toMatch(/"name" debe ser un texto/);
    expect((await bad(await api.post('/api/projects', { name: 'X', description: 5 }))).error).toMatch(/"description" debe ser un texto/);
    expect((await bad(await api.post('/api/projects', { name: '   ' }))).code).toBe('invalid');
    expect((await bad(await api.post('/api/projects/p/diagrams', { module: 'c4', text: 7 }))).error).toMatch(/"text" debe ser un texto/);
    expect((await bad(await api.post('/api/projects/p/diagrams', { name: 'D', text: '{}' }))).error).toMatch(/Falta "module"/);
    expect((await bad(await api.post('/api/projects/p/diagrams', { module: '../x', name: 'D', text: '{}' }))).code).toBe('invalid');
    await api.post('/api/projects/p/diagrams', { module: 'c4', name: 'D', text: '{}' });
    expect((await bad(await api.put('/api/projects/p/diagrams/d', {}))).error).toMatch(/Falta "text"/);
    expect((await bad(await api.put('/api/projects/p/diagrams/d', { text: 5 }))).error).toMatch(/"text" debe ser un texto/);
    expect((await bad(await api.put('/api/projects/p/diagrams/d', { text: '{}', ifUpdatedAt: 5 }))).error).toMatch(/"ifUpdatedAt" debe ser un texto/);
    expect((await bad(await api.patch('/api/projects/p', {}))).error).toMatch(/Falta "name"/);
    // PUT solo guarda un diagrama que existe
    expect((await bad(await api.put('/api/projects/p/diagrams/nada', { text: '{}' }), 404)).code).toBe('not-found');
    expect((await bad(await api.get('/api/projects/nada'), 404)).code).toBe('not-found');
    expect((await bad(await api.get('/api/projects/p/diagrams/nada'), 404)).code).toBe('not-found');
    expect((await bad(await api.post('/api/projects/nada/diagrams', { module: 'c4', text: '{}' }), 404)).code).toBe('not-found');
    expect((await bad(await api.get('/api/projects/p/otra-cosa'), 404)).error).toMatch(/desconocida/);
    expect((await bad(await api.get('/api/projects/p/diagrams/d/mas'), 404)).error).toMatch(/desconocida/);
  });

  it('responde 405 con Allow al método equivocado', async () => {
    const { base } = await start();
    const api = call(base);
    await api.post('/api/projects', { name: 'P' });
    await api.post('/api/projects/p/diagrams', { module: 'c4', name: 'D', text: '{}' });
    const cases: Array<[Response, string]> = [
      [await api.put('/api/projects'), 'GET, POST'],
      [await api.put('/api/projects/p'), 'GET, PATCH, DELETE'],
      [await api.post('/api/projects/p/bundle'), 'GET'],
      [await api.del('/api/projects/p/check'), 'GET'],
      [await api.get('/api/projects/p/diagrams'), 'POST'],
      [await api.post('/api/projects/p/diagrams/d'), 'GET, PUT, PATCH, DELETE'],
    ];
    for (const [res, allow] of cases) {
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe(allow);
    }
  });

  it('un cuerpo que pasa del máximo se rechaza con 413 y no se guarda nada', async () => {
    const { base, root } = await start({ maxBodyBytes: 1000 });
    const api = call(base);
    await api.post('/api/projects', { name: 'P' });
    const res = await api.post('/api/projects/p/diagrams', { module: 'c4', name: 'Enorme', text: 'x'.repeat(3000) });
    expect(res.status).toBe(413);
    expect(res.headers.get('connection')).toBe('close');
    expect(readdirSync(join(root, 'p'))).toEqual(['project.json']);
    const put = await api.put('/api/projects/p/diagrams/enorme', { text: 'y'.repeat(3000) });
    expect(put.status).toBe(413);
    expect(readdirSync(join(root, 'p'))).toEqual(['project.json']);
    // y un cuerpo normal sigue pasando por el mismo servidor
    expect((await api.post('/api/projects/p/diagrams', { module: 'c4', name: 'Pequeño', text: '{}' })).status).toBe(201);
  });
});

describe('iark serve: seguridad de la API de proyectos', () => {
  it('rechaza con 403 las peticiones de un origen ajeno (lectura y escritura) y no toca el disco', async () => {
    const { base, root } = await start();
    const api = call(base);
    await api.post('/api/projects', { name: 'P' });
    const before = JSON.stringify(readdirSync(join(root, 'p')));
    const evil = { Origin: 'https://evil.example' };
    for (const res of [
      await api.get('/api/projects', evil),
      await api.get('/api/projects/p/bundle', evil),
      await api.post('/api/projects', { name: 'Robado' }, evil),
      await api.post('/api/projects/p/diagrams', { module: 'c4', name: 'D', text: '{}' }, evil),
      await api.put('/api/projects/p/diagrams/x', { text: '{}' }, evil),
      await api.patch('/api/projects/p', { name: 'Robado' }, evil),
      await api.del('/api/projects/p', evil),
      await api.post('/api/projects/import', '{}', evil),
    ]) {
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/Origen no autorizado/);
    }
    // `Origin: null` (una página en un iframe sandbox o un archivo local) tampoco, y un puerto distinto es otro origen
    expect((await api.post('/api/projects', { name: 'Robado' }, { Origin: 'null' })).status).toBe(403);
    const port = new URL(base).port;
    expect((await api.post('/api/projects', { name: 'Robado' }, { Origin: `http://127.0.0.1:${Number(port) + 1}` })).status).toBe(403);
    expect((await api.post('/api/projects', { name: 'Robado' }, { Origin: 'http://localhost' })).status).toBe(403);
    expect(JSON.stringify(readdirSync(join(root, 'p')))).toBe(before);
    expect(readdirSync(root)).toEqual(['p']);
    // el propio sitio (su Origin tiene el mismo host y puerto que Host) sí puede
    expect((await api.post('/api/projects', { name: 'Propio' }, { Origin: base })).status).toBe(201);
  });

  it('un `*` en --cors no abre la API de proyectos; un origen nombrado sí (con preflight que anuncia PUT, PATCH y DELETE)', async () => {
    const wildcard = await start({ cors: ['*'] });
    const wild = call(wildcard.base);
    expect((await wild.post('/api/projects', { name: 'X' }, { Origin: 'https://cualquiera.example' })).status).toBe(403);
    expect((await wild.get('/api/modules', { Origin: 'https://cualquiera.example' })).headers.get('access-control-allow-origin')).toBe('*'); // lo que ya había
    const wildPreflight = await fetch(`${wildcard.base}/api/projects`, { method: 'OPTIONS', headers: { Origin: 'https://cualquiera.example', 'Access-Control-Request-Method': 'PUT' } });
    expect(wildPreflight.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');

    const { base } = await start({ cors: ['https://app.example'] });
    const api = call(base);
    const app = { Origin: 'https://app.example' };
    const created = await api.post('/api/projects', { name: 'Desde la app' }, app);
    expect(created.status).toBe(201);
    expect(created.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(created.headers.get('vary')).toBe('Origin');
    const preflight = await fetch(`${base}/api/projects/desde-la-app`, { method: 'OPTIONS', headers: { ...app, 'Access-Control-Request-Method': 'DELETE', 'Access-Control-Request-Headers': 'content-type' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toBe('GET, POST, PUT, PATCH, DELETE, OPTIONS');
    expect(preflight.headers.get('access-control-allow-headers')).toBe('Content-Type');
    // otro origen sigue fuera, y su preflight no anuncia nada
    expect((await api.get('/api/projects', { Origin: 'https://otra.example' })).status).toBe(403);
    const otherPreflight = await fetch(`${base}/api/projects/desde-la-app`, { method: 'OPTIONS', headers: { Origin: 'https://otra.example', 'Access-Control-Request-Method': 'DELETE' } });
    expect(otherPreflight.headers.get('access-control-allow-origin')).toBeNull();
    expect(otherPreflight.headers.get('access-control-allow-methods')).toBeNull();
  });

  it('las operaciones que modifican exigen Content-Type: application/json (un formulario o un fetch no-cors no pueden hacerlas)', async () => {
    const { base, root } = await start();
    const api = call(base);
    await api.post('/api/projects', { name: 'P' });
    const attempts: Array<[string, string, Record<string, string>, string | undefined]> = [
      ['POST', '/api/projects', { 'Content-Type': 'text/plain' }, '{"name":"Colado"}'],
      ['POST', '/api/projects', { 'Content-Type': 'application/x-www-form-urlencoded' }, 'name=Colado'],
      ['POST', '/api/projects', { 'Content-Type': 'multipart/form-data; boundary=x' }, '--x--'],
      ['POST', '/api/projects', {}, '{"name":"Colado"}'],
      ['POST', '/api/projects', { 'Content-Type': 'application/jsonx' }, '{"name":"Colado"}'],
      ['POST', '/api/projects/p/diagrams', { 'Content-Type': 'text/plain;charset=UTF-8' }, '{"module":"c4","name":"Colado","text":"{}"}'],
      ['PUT', '/api/projects/p/diagrams/x', { 'Content-Type': 'text/plain' }, '{"text":"{}"}'],
      ['PATCH', '/api/projects/p', { 'Content-Type': 'text/plain' }, '{"name":"Colado"}'],
      ['DELETE', '/api/projects/p', {}, undefined],
      ['POST', '/api/projects/import', { 'Content-Type': 'text/plain' }, '{}'],
    ];
    for (const [method, path, headers, body] of attempts) {
      const res = await raw(base, method, path, { host: new URL(base).host, ...headers, ...(body ? { 'Content-Length': String(Buffer.byteLength(body)) } : {}) }, body);
      expect(res.status, `${method} ${path} ${JSON.stringify(headers)}`).toBe(415);
      expect(JSON.parse(res.body).error).toMatch(/Content-Type: application\/json/);
    }
    expect(readdirSync(root)).toEqual(['p']);
    expect(readdirSync(join(root, 'p'))).toEqual(['project.json']);
    // con los parámetros habituales del tipo JSON sí se acepta, y las lecturas no necesitan tipo
    expect((await api.post('/api/projects', { name: 'Con charset' }, { 'Content-Type': 'application/json; charset=utf-8' })).status).toBe(201);
    expect((await raw(base, 'GET', '/api/projects', { host: new URL(base).host })).status).toBe(200);
  });

  it('con el servidor en loopback, una cabecera Host que no es localhost, 127.0.0.1 o [::1] se rechaza con 403 (DNS rebinding)', async () => {
    const { base, root } = await start();
    const port = new URL(base).port;
    const get = (host: string | undefined, path = '/api/projects') => raw(base, 'GET', path, host === undefined ? {} : { host });
    for (const host of ['evil.example', `evil.example:${port}`, 'localhost.evil.example', `127.0.0.1.evil.example:${port}`, '192.168.1.5', '0.0.0.0', 'localhost@evil.example', `evil.example:${port}/x`]) {
      const res = await get(host);
      expect(res.status, `Host: ${host}`).toBe(403);
      expect(JSON.parse(res.body).error).toMatch(/Host no permitido/);
    }
    for (const host of ['localhost', `localhost:${port}`, '127.0.0.1', `127.0.0.1:${port}`, '[::1]', `[::1]:${port}`, `LOCALHOST:${port}`]) {
      expect((await get(host)).status, `Host: ${host}`).toBe(200);
    }
    // también las escrituras, y también con un Origin que coincide con el Host falso (justo lo que haría la página atacante)
    const body = '{"name":"Robado"}';
    const attack = await raw(base, 'POST', '/api/projects', { host: `evil.example:${port}`, origin: `http://evil.example:${port}`, 'content-type': 'application/json', 'content-length': String(body.length) }, body);
    expect(attack.status).toBe(403);
    expect(readdirSync(root)).toEqual([]);
    // las demás rutas de la API no cambian de comportamiento
    expect((await get('evil.example', '/api/modules')).status).toBe(200);
  });

  it('un id con `..`, separadores o codificado nunca llega al disco (400 o 404)', async () => {
    const { base, root, outside } = await start();
    const api = call(base);
    await api.post('/api/projects', { name: 'P' });
    await api.post('/api/projects/p/diagrams', { module: 'c4', name: 'D', text: '{}' });
    writeFileSync(join(outside, 'x.c4.json'), 'fuera');
    mkdirSync(join(outside, 'otro'));
    const before = JSON.stringify([readdirSync(outside).sort(), readdirSync(root).sort(), readdirSync(join(root, 'p')).sort()]);

    // Los segmentos `..` y `%2e%2e` los resuelve el propio servidor al interpretar la URL (como cualquier cliente): `/api/projects/..`
    // es `/api/`, y no hay forma de salir de `/api`. Donde ocupan el lugar de un id de proyecto, dan 404; como id de diagrama,
    // `/api/projects/p/diagrams/..` es `/api/projects/p`, una ruta legítima, así que ahí solo se prueban los ids que quedan como id.
    const dots = ['..', '%2e%2e', '%2E%2E'];
    const ids = ['..%2fx', '%2e%2e%2fx', '%2e%2e%2f%2e%2e%2fotro', '..%5cx', '%2e%2e%5cx', 'a%2fb', '%2fetc%2fpasswd', '.hidden', 'con', '%00', '%zz', 'a%00b', 'x'.repeat(200), '%E2%80%AE', '%C3%A9'];
    const requests = (id: string, atDiagram: boolean): Array<[string, string, unknown]> => [
      ['GET', `/api/projects/${id}`, undefined],
      ['PATCH', `/api/projects/${id}`, { name: 'Robado' }],
      ['DELETE', `/api/projects/${id}`, undefined],
      ['GET', `/api/projects/${id}/bundle`, undefined],
      ['GET', `/api/projects/${id}/check`, undefined],
      ['POST', `/api/projects/${id}/diagrams`, { module: 'c4', name: 'X', text: '{}' }],
      ['PUT', `/api/projects/${id}/diagrams/d`, { text: 'pisado' }],
      ...(atDiagram
        ? ([
            ['GET', `/api/projects/p/diagrams/${id}`, undefined],
            ['PUT', `/api/projects/p/diagrams/${id}`, { text: 'pisado' }],
            ['PATCH', `/api/projects/p/diagrams/${id}`, { name: 'Robado' }],
            ['DELETE', `/api/projects/p/diagrams/${id}`, undefined],
          ] as Array<[string, string, unknown]>)
        : []),
    ];
    for (const [id, atDiagram] of [...dots.map((d) => [d, false] as const), ...ids.map((d) => [d, true] as const)]) {
      for (const [method, path, body] of requests(id, atDiagram)) {
        const res = await raw(base, method, path, { host: new URL(base).host, ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) }, body === undefined ? undefined : JSON.stringify(body));
        expect([400, 404], `${method} ${path} → ${res.status}`).toContain(res.status);
      }
    }
    expect(JSON.stringify([readdirSync(outside).sort(), readdirSync(root).sort(), readdirSync(join(root, 'p')).sort()])).toBe(before);
    expect((await api.get('/api/projects/p')).status).toBe(200); // ni el proyecto ni el diagrama sufrieron nada
    expect((await (await api.get('/api/projects/p/diagrams/d')).json()).text).toBe('{}');

    // un nombre (no un id) con `..` solo da un id seguro dentro de la raíz
    const created = await api.post('/api/projects', { name: '../../fuera' });
    expect((await created.json()).id).toBe('fuera');
    expect(readdirSync(root).sort()).toEqual(['fuera', 'p']);
    expect(JSON.stringify([readdirSync(outside).sort(), readdirSync(join(root, 'p')).sort()])).toBe(JSON.stringify([['espacio', 'otro', 'x.c4.json'], ['.versiones', 'd.c4.json', 'project.json']]));
    expect(readFileSync(join(outside, 'x.c4.json'), 'utf8')).toBe('fuera');
  });

  it('un error del almacén no cuenta la ruta del disco: responde 500 con su código', async () => {
    const { base, root } = await start();
    rmSync(root, { recursive: true });
    writeFileSync(root, 'ahora soy un archivo'); // la raíz deja de ser una carpeta
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const res = await call(base).get('/api/projects');
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body).toMatchObject({ code: 'unavailable' });
      expect(JSON.stringify(body)).not.toContain(root);
    } finally {
      stderr.mockRestore();
    }
  });
});

describe('iark serve --workspace (comando)', () => {
  let bundle: CliBundle;
  beforeAll(async () => {
    bundle = await buildCliBundle('serve-projects');
  });
  afterAll(() => bundle?.dispose());

  /** Arranca `iark serve` en un puerto libre y devuelve la URL, lo que escribió en stderr y cómo pararlo. */
  async function serve(args: string[], env: Record<string, string> = {}): Promise<{ url: string; stderr: () => string; stop: () => Promise<number | null> }> {
    const child = spawn(process.execPath, [bundle.cli, 'serve', '--port', '0', ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, IARK_WORKSPACE: '', ...env } });
    let stderr = '';
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`no arrancó: ${stderr}`));
      }, PROCESS_TEST_TIMEOUT - 10_000);
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        const match = /escuchando en (http:\/\/\S+)/.exec(stderr);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
    });
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
    return {
      url,
      stderr: () => stderr,
      stop: () => {
        child.kill('SIGTERM');
        return exited;
      },
    };
  }

  it('--workspace activa la API de proyectos sobre la carpeta y la crea al primer proyecto', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iark-serve-ws-'));
    folders.push(dir);
    const workspace = join(dir, 'nuevo', 'espacio');
    const running = await serve(['--workspace', workspace]);
    try {
      await vi.waitFor(() => expect(running.stderr()).toContain('proyectos: /api/projects'));
      expect(running.stderr()).toContain(`espacio de trabajo: ${workspace}`);
      const api = call(running.url);
      expect(await (await api.get('/api/projects')).json()).toEqual([]);
      expect((await api.post('/api/projects', { name: 'Desde HTTP' })).status).toBe(201);
      expect(readdirSync(workspace)).toEqual(['desde-http']);
      expect((await (await fetch(`${running.url}/.well-known/iark.json`)).json()).projects).toBe('../api/projects');
    } finally {
      expect(await running.stop()).toBe(0);
    }
  });

  it('IARK_WORKSPACE hace lo mismo; sin ninguna de las dos, las rutas de proyectos responden 404', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iark-serve-env-'));
    folders.push(dir);
    const withEnv = await serve([], { IARK_WORKSPACE: dir });
    try {
      expect((await call(withEnv.url).get('/api/projects')).status).toBe(200);
    } finally {
      await withEnv.stop();
    }
    const without = await serve([]);
    try {
      expect((await call(without.url).get('/api/projects')).status).toBe(404);
      expect(without.stderr()).not.toContain('espacio de trabajo');
    } finally {
      await without.stop();
    }
  });

  it('una carpeta de trabajo que es un archivo es un error de uso', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iark-serve-bad-'));
    folders.push(dir);
    writeFileSync(join(dir, 'archivo'), 'x');
    const code = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [bundle.cli, 'serve', '--port', '0', '--workspace', join(dir, 'archivo')], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
      child.on('exit', (exit) => resolve({ code: exit, stderr }));
    });
    expect(code.code).toBe(2);
    expect(code.stderr).toMatch(/no es una carpeta/);
  });
});
