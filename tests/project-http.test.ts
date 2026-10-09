import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpProjectStore, ProjectError } from '@iark/kernel';
import { createDefaultRegistry } from '../src/cli/registry';
import { createSuiteServer } from '../src/cli/serve';
import { createToken, revokeToken, TokenStore, type TokenRole } from '../src/cli/tokens';
import { FolderProjectStore } from '../src/cli/workspace';
import { projectStoreContract } from './helpers/projectStoreContract';
import { projectVersionsContract } from './helpers/projectVersionsContract';

/**
 * El cliente remoto contra el servidor de verdad: el mismo contrato de almacén que cumplen la memoria, IndexedDB y la carpeta,
 * pero pasando por HTTP (`iark serve --workspace` sobre una carpeta temporal).
 */
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface Running {
  base: string;
  root: string;
  server: Server;
  close(): Promise<void>;
}

async function startServer(options: ConstructorParameters<typeof FolderProjectStore>[1] = {}): Promise<Running> {
  const root = mkdtempSync(join(tmpdir(), 'iark-http-'));
  const server = createSuiteServer({ registry: createDefaultRegistry(), version: '1', projects: new FolderProjectStore(root, options) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  };
  return { base, root, server, close };
}

projectStoreContract('HttpProjectStore (servidor real)', async () => {
  const running = await startServer();
  return { store: new HttpProjectStore({ baseUrl: running.base }), cleanup: running.close };
});

// El historial pasa por HTTP: el cliente habla con un servidor de verdad (que guarda en una carpeta) con la política y el reloj de la prueba.
// Quién guarda lo decide el servidor con la identidad de la petición, así que aquí (sin autenticación) no se anota, y el uso lo cuenta el servidor.
projectVersionsContract(
  'HttpProjectStore (servidor real)',
  async ({ policy, clock }) => {
    const running = await startServer({ versions: policy, clock: () => clock.now() });
    return { store: new HttpProjectStore({ baseUrl: running.base }), cleanup: running.close };
  },
  { recordsActor: false, reportsUsage: false },
);

describe('HttpProjectStore contra iark serve', () => {
  it('dos clientes comparten el espacio de trabajo y el segundo ve lo que guardó el primero', async () => {
    const running = await startServer();
    cleanups.push(running.close);
    const one = new HttpProjectStore({ baseUrl: running.base });
    const two = new HttpProjectStore({ baseUrl: `${running.base}/api/projects/` }); // también acepta la dirección completa de la API
    const project = await one.createProject({ name: 'Tienda' });
    const diagram = await one.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text: '{"v":1}' });
    expect((await two.listProjects()).map((p) => [p.name, p.diagrams.length])).toEqual([['Tienda', 1]]);
    expect((await two.getDiagram(project.id, diagram.id))?.text).toBe('{"v":1}');
    // y `ifUpdatedAt` detecta que el otro cliente guardó en medio
    await two.saveDiagram(project.id, { id: diagram.id, text: '{"v":2}', ifUpdatedAt: diagram.updatedAt });
    await expect(one.saveDiagram(project.id, { id: diagram.id, text: '{"v":3}', ifUpdatedAt: diagram.updatedAt })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('whoami reconoce un servidor sin autenticación y se avisa si no ofrece proyectos o no se llega a él', async () => {
    const running = await startServer();
    cleanups.push(running.close);
    expect(await new HttpProjectStore({ baseUrl: running.base }).whoami()).toEqual({ auth: false, name: undefined, role: undefined });

    // un servidor que arrancó sin --workspace no ofrece proyectos
    const bare = createSuiteServer({ registry: createDefaultRegistry(), version: '1' });
    await new Promise<void>((resolve) => bare.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => bare.close(() => resolve())));
    const url = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;
    const bareClient = new HttpProjectStore({ baseUrl: url });
    expect((await bareClient.whoami()).auth).toBe(false); // `whoami` lo responde cualquier servidor de IArk…
    const error = await bareClient.listProjects().catch((e: unknown) => e); // …pero los proyectos solo si hay espacio de trabajo
    expect(error).toBeInstanceOf(ProjectError);
    expect(error).toMatchObject({ code: 'unavailable', message: expect.stringContaining('espacio de trabajo'), info: { status: 404 } });

    // nada escucha en ese puerto
    await running.close();
    cleanups.length = 0;
    const down = await new HttpProjectStore({ baseUrl: running.base, timeoutMs: 2000 }).listProjects().catch((e: unknown) => e);
    expect(down).toMatchObject({ code: 'unavailable', message: expect.stringContaining('No se pudo conectar'), info: { network: true } });
  });

  it('con keepalive, las escrituras pequeñas siguen aunque se cierre la página; lecturas y escrituras grandes no lo piden', async () => {
    const seen: Array<{ method: string; keepalive: boolean | undefined }> = [];
    const spy = (async (_url: unknown, init: RequestInit) => {
      seen.push({ method: init.method ?? 'GET', keepalive: init.keepalive });
      return new Response('{"id":"d1","module":"c4","name":"A","createdAt":"x","updatedAt":"y"}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    const store = new HttpProjectStore({ baseUrl: 'http://x.example', fetch: spy, keepalive: true });
    await store.getProject('p1');
    await store.saveDiagram('p1', { id: 'd1', text: '{"pequeño":true}' });
    await store.saveDiagram('p1', { id: 'd1', text: 'x'.repeat(70_000) });
    expect(seen).toEqual([
      { method: 'GET', keepalive: undefined },
      { method: 'PUT', keepalive: true },
      { method: 'PUT', keepalive: undefined },
    ]);
    // sin la opción, nunca
    seen.length = 0;
    await new HttpProjectStore({ baseUrl: 'http://x.example', fetch: spy }).saveDiagram('p1', { id: 'd1', text: '{}' });
    expect(seen).toEqual([{ method: 'PUT', keepalive: undefined }]);
  });

  it('el detalle del error dice si hubo respuesta (estado HTTP) o no (red), y el token se puede cambiar sin crear otro cliente', async () => {
    let seen: string | null = null;
    const needsToken = (async (_url: unknown, init: RequestInit) => {
      seen = new Headers(init.headers).get('Authorization');
      return seen === 'Bearer bueno'
        ? new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
        : new Response(JSON.stringify({ error: 'Falta un token válido.', code: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    const store = new HttpProjectStore({ baseUrl: 'http://x.example', fetch: needsToken });
    const rejected = await store.listProjects().catch((e: unknown) => e);
    expect(rejected).toMatchObject({ code: 'unauthorized', info: { status: 401 } });
    expect(seen).toBeNull();

    store.setToken(' bueno ');
    expect(await store.listProjects()).toEqual([]);
    expect(seen).toBe('Bearer bueno');
    store.setToken(undefined);
    await expect(store.listProjects()).rejects.toMatchObject({ code: 'unauthorized' });
    expect(seen).toBeNull();
  });
});

/** Un servidor con `--tokens`: un token por rol (`ana` es editor, `vic` viewer, `root` admin) en un archivo temporal. */
async function startAuthServer(): Promise<Running & { tokens: Record<'admin' | 'editor' | 'viewer', string>; tokenFile: string }> {
  const running = await startServer();
  running.server.close();
  const dir = mkdtempSync(join(tmpdir(), 'iark-http-tokens-'));
  const tokenFile = join(dir, 'tokens.json');
  const tokens = {} as Record<TokenRole, string>;
  for (const [name, role] of [['root', 'admin'], ['ana', 'editor'], ['vic', 'viewer']] as const) tokens[role] = createToken(tokenFile, { name, role }).token;
  const server = createSuiteServer({
    registry: createDefaultRegistry(),
    version: '1',
    projects: new FolderProjectStore(running.root),
    tokens: TokenStore.open(tokenFile, () => undefined),
    cors: ['https://app.example'],
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(running.root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  };
  return { base, root: running.root, server, close, tokens, tokenFile };
}

projectStoreContract('HttpProjectStore (servidor con tokens, rol admin)', async () => {
  const running = await startAuthServer();
  return { store: new HttpProjectStore({ baseUrl: running.base, token: running.tokens.admin }), cleanup: running.close };
});

describe('HttpProjectStore contra iark serve --tokens', () => {
  it('whoami dice quién es el token y su rol; sin token o con uno que no existe, el servidor no deja pasar', async () => {
    const running = await startAuthServer();
    cleanups.push(running.close);
    expect(await new HttpProjectStore({ baseUrl: running.base, token: running.tokens.editor }).whoami()).toEqual({ auth: true, name: 'ana', role: 'editor' });
    expect(await new HttpProjectStore({ baseUrl: running.base, token: running.tokens.viewer }).whoami()).toMatchObject({ name: 'vic', role: 'viewer' });
    await expect(new HttpProjectStore({ baseUrl: running.base }).whoami()).rejects.toMatchObject({ code: 'unauthorized', info: { status: 401 } });
    await expect(new HttpProjectStore({ baseUrl: running.base }).listProjects()).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(new HttpProjectStore({ baseUrl: running.base, token: 'iark_que-no-existe' }).listProjects()).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('cada rol llega hasta donde le toca: el 403 es `forbidden`, no «token inválido»', async () => {
    const running = await startAuthServer();
    cleanups.push(running.close);
    const admin = new HttpProjectStore({ baseUrl: running.base, token: running.tokens.admin });
    const editor = new HttpProjectStore({ baseUrl: running.base, token: running.tokens.editor });
    const viewer = new HttpProjectStore({ baseUrl: running.base, token: running.tokens.viewer });
    const project = await editor.createProject({ name: 'Tienda' });
    const diagram = await editor.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text: '{}' });
    await editor.saveDiagram(project.id, { id: diagram.id, text: '{"v":2}', ifUpdatedAt: diagram.updatedAt });
    await editor.renameDiagram(project.id, diagram.id, 'Visión general');
    // el editor no borra proyectos
    await expect(editor.deleteProject(project.id)).rejects.toMatchObject({ code: 'forbidden', info: { status: 403 } });
    // el viewer lee, pero no escribe nada
    expect((await viewer.listProjects()).map((p) => p.name)).toEqual(['Tienda']);
    expect((await viewer.getDiagram(project.id, diagram.id))?.text).toBe('{"v":2}');
    await expect(viewer.createProject({ name: 'Otro' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(viewer.saveDiagram(project.id, { id: diagram.id, text: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(viewer.deleteDiagram(project.id, diagram.id)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await admin.getDiagram(project.id, diagram.id))?.text).toBe('{"v":2}'); // nada de lo anterior llegó al disco
    await admin.deleteProject(project.id);
    expect(await admin.listProjects()).toEqual([]);
  });

  it('revocar un token lo corta en la siguiente petición, sin reiniciar el servidor', async () => {
    const running = await startAuthServer();
    cleanups.push(running.close);
    const editor = new HttpProjectStore({ baseUrl: running.base, token: running.tokens.editor });
    await editor.listProjects();
    revokeToken(running.tokenFile, 'ana');
    await expect(editor.listProjects()).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(new HttpProjectStore({ baseUrl: running.base, token: running.tokens.viewer }).listProjects()).resolves.toEqual([]);
  });

  it('adivinar tokens se frena: tras varios intentos fallidos la dirección recibe 429, que el cliente traduce con la espera', async () => {
    const running = await startAuthServer();
    cleanups.push(running.close);
    const guesser = new HttpProjectStore({ baseUrl: running.base, token: 'iark_adivinando' });
    for (let i = 0; i < 5; i++) await expect(guesser.listProjects()).rejects.toMatchObject({ code: 'unauthorized' });
    const blocked = await guesser.listProjects().catch((e: unknown) => e);
    expect(blocked).toMatchObject({ code: 'unavailable', info: { status: 429 }, message: expect.stringContaining('espere') });
    // y con la dirección frenada ni siquiera un token bueno pasa (si no, el freno serviría de oráculo)
    await expect(new HttpProjectStore({ baseUrl: running.base, token: running.tokens.admin }).listProjects()).rejects.toMatchObject({ info: { status: 429 } });
  });

  it('el preflight de CORS con Authorization se acepta para un origen de --cors y el token nunca viaja en la dirección', async () => {
    const running = await startAuthServer();
    cleanups.push(running.close);
    const preflight = await fetch(`${running.base}/api/projects`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://app.example', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization,content-type' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(preflight.headers.get('access-control-allow-headers')).toMatch(/authorization/i);
    expect(preflight.headers.get('access-control-allow-methods')).toMatch(/PUT/);
    const urls: string[] = [];
    const spy: typeof fetch = (input, init) => {
      urls.push(String(input));
      return fetch(input, init);
    };
    await new HttpProjectStore({ baseUrl: running.base, token: running.tokens.viewer, fetch: spy }).listProjects();
    expect(urls.join(' ')).not.toContain(running.tokens.viewer);
  });
});
