import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FolderProjectStore } from '../src/cli/workspace';
import { buildCliBundle, BUNDLE_TIMEOUT, PROCESS_TEST_TIMEOUT, type CliBundle } from './helpers/cliBundle';
import { postgresAvailable, requirePostgresIfCi, startTestPostgres, uniqueSchema, type TestPostgres } from './helpers/postgres';

requirePostgresIfCi();
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT, hookTimeout: BUNDLE_TIMEOUT });

/**
 * `iark serve --workspace-store postgres` y `iark workspace import` como procesos de verdad (el CLI empaquetado, como se publica): la
 * conexión sale solo del entorno, el servicio sobrevive a un reinicio sin disco, el apagado cierra el pool y una carpeta existente se pasa a
 * la base con sus ids, sus fechas y su historial.
 */

const SECRET = 's3cr3t-clave-9f2';

describe.skipIf(!postgresAvailable())('CLI: proyectos en Postgres', () => {
  let bundle: CliBundle;
  let pg: TestPostgres;
  const dirs: string[] = [];
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    [bundle, pg] = await Promise.all([buildCliBundle('workspace-postgres'), startTestPostgres()]);
  });
  afterAll(async () => {
    bundle?.dispose();
    await pg?.stop();
  });
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const tmp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'iark-wspg-'));
    dirs.push(dir);
    return dir;
  };

  /** El entorno del CLI: la base de la prueba (con una clave que no debe aparecer en ninguna salida) en un esquema propio. */
  const envFor = (schema: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    ...process.env,
    IARK_WORKSPACE: undefined,
    IARK_WORKSPACE_STORE: undefined,
    IARK_DATABASE_URL: pg.url.replace('postgres@', `postgres:${SECRET}@`),
    IARK_DATABASE_SCHEMA: schema,
    ...extra,
  });

  /** Corre el CLI hasta que termina. */
  const cli = (args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [bundle.cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
      child.on('exit', (code) => resolve({ code, stdout, stderr }));
    });

  /** Arranca `iark serve` y espera a que escuche. */
  async function serve(args: string[], env: NodeJS.ProcessEnv): Promise<{ url: string; stderr: () => string; stop: () => Promise<number | null> }> {
    const child = spawn(process.execPath, [bundle.cli, 'serve', '--port', '0', ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    children.push(child);
    let stderr = '';
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no arrancó: ${stderr}`)), PROCESS_TEST_TIMEOUT - 10_000);
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        const match = /escuchando en (http:\/\/\S+)/.exec(stderr);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      void exited.then((code) => {
        clearTimeout(timer);
        reject(new Error(`terminó con ${code} antes de escuchar: ${stderr}`));
      });
    });
    return {
      url,
      stderr: () => stderr,
      stop: async () => {
        child.kill('SIGTERM');
        return exited;
      },
    };
  }

  const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('sirve los proyectos desde Postgres, sobrevive a un reinicio y se apaga con limpieza (sin carpeta en disco)', async () => {
    const env = envFor(uniqueSchema());
    const first = await serve(['--workspace-store', 'postgres'], env);
    await vi.waitFor(() => expect(first.stderr()).toMatch(/proyectos: \/api\/projects/)); // el aviso de arranque sale en varias líneas
    expect(first.stderr()).toMatch(/espacio de trabajo: Postgres postgres:\/\/postgres@127\.0\.0\.1:\d+\/postgres, esquema t_/);
    expect(first.stderr()).not.toContain(SECRET);
    expect((await (await fetch(`${first.url}/readyz`)).json()) as unknown).toMatchObject({ status: 'ok', checks: { workspace: 'ok' } });
    const created = await post(`${first.url}/api/projects`, { name: 'Tienda web' });
    expect(created.status).toBe(201);
    const project = (await created.json()) as { id: string };
    const diagram = await post(`${first.url}/api/projects/${project.id}/diagrams`, { module: 'c4', name: 'Contexto', text: '{"b":1,"a":2}' });
    expect(diagram.status).toBe(201);
    expect(await first.stop()).toBe(0); // SIGTERM → cierra el pool → el proceso termina por sí solo

    // otro proceso, la misma base: nada se perdió (con la carpeta efímera de Render se habría perdido todo)
    const second = await serve([], envFor(env.IARK_DATABASE_SCHEMA!, { IARK_WORKSPACE_STORE: 'postgres' })); // por variable de entorno
    const list = (await (await fetch(`${second.url}/api/projects`)).json()) as Array<{ id: string; name: string; diagrams: Array<{ id: string; name: string }> }>;
    expect(list.map((p) => [p.id, p.name, p.diagrams.map((d) => d.name)])).toEqual([[project.id, 'Tienda web', ['Contexto']]]);
    const saved = (await (await fetch(`${second.url}/api/projects/${project.id}/diagrams/${list[0].diagrams[0].id}`)).json()) as { text: string };
    expect(saved.text).toBe('{"b":1,"a":2}'); // el JSON original, byte a byte
    expect(second.stderr()).not.toContain(SECRET);
    expect(await second.stop()).toBe(0);
  });

  it('es un error de uso pedir Postgres con una carpeta, sin la base configurada, con un almacén que no existe o con una base a la que no se llega', async () => {
    const schema = uniqueSchema();
    const folder = tmp();
    const both = await cli(['serve', '--port', '0', '--workspace-store', 'postgres', '--workspace', folder], envFor(schema));
    expect(both.code).toBe(2);
    expect(both.stderr).toMatch(/no se indica una carpeta/);

    const viaEnv = await cli(['serve', '--port', '0', '--workspace-store', 'postgres'], envFor(schema, { IARK_WORKSPACE: folder }));
    expect(viaEnv.code).toBe(2);

    const none = await cli(['serve', '--port', '0', '--workspace-store', 'postgres'], envFor(schema, { IARK_DATABASE_URL: undefined }));
    expect(none.code).toBe(2);
    expect(none.stderr).toMatch(/Falta IARK_DATABASE_URL/);

    const unknown = await cli(['serve', '--port', '0', '--workspace-store', 'sqlite'], envFor(schema));
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toMatch(/--workspace-store debe ser «folder» o «postgres»/);

    // un puerto cerrado: error de entorno (1) que dice a qué servidor y nunca la clave
    const closed = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as { port: number };
        probe.close(() => resolve(port));
      });
    });
    const down = await cli(['serve', '--port', '0', '--workspace-store', 'postgres'], envFor(schema, { IARK_DATABASE_URL: `postgres://postgres:${SECRET}@127.0.0.1:${closed}/postgres` }));
    expect(down.code).toBe(1);
    expect(down.stderr).toMatch(/No se puede usar Postgres \(postgres:\/\/postgres@127\.0\.0\.1:\d+\/postgres\)/);
    for (const out of [down.stderr, down.stdout, both.stderr, none.stderr]) expect(out).not.toContain(SECRET);
  });

  it('la ayuda de serve y la de workspace import describen las opciones', async () => {
    const serveHelp = await cli(['serve', '--help'], envFor(uniqueSchema()));
    expect(serveHelp.stdout).toMatch(/--workspace-store <almacén>[\s\S]*postgres/);
    const importHelp = await cli(['workspace', 'import', '--help'], envFor(uniqueSchema()));
    expect(importHelp.stdout).toMatch(/--from <carpeta>[\s\S]*--replace[\s\S]*--dry-run/);
  });

  it('workspace import pasa una carpeta a Postgres con sus ids, documentos e historial; repetirlo no duplica ni pisa nada', async () => {
    // una carpeta de trabajo de las de siempre, con historial
    const root = join(tmp(), 'espacio');
    const folder = new FolderProjectStore(root, { versions: { coalesceSeconds: 0 } });
    const shop = await folder.createProject({ name: 'Tienda web', description: 'Pedidos' });
    const context = await folder.saveDiagram(shop.id, { module: 'c4', name: 'Contexto', text: '{"v":1,  "z":0}', by: '@ana' });
    await folder.saveDiagram(shop.id, { id: context.id, text: '{"v":2}', by: '@beto' });
    await folder.labelVersion(shop.id, context.id, 1, 'Entrega 1');
    await folder.saveDiagram(shop.id, { module: 'data', name: 'Ventas', text: 'borrador {' });
    const bank = await folder.createProject({ name: 'Banca' });

    const schema = uniqueSchema();
    const env = envFor(schema);
    const dry = await cli(['workspace', 'import', '--from', root, '--dry-run'], { ...env, IARK_DATABASE_URL: undefined }); // sin base: no la toca
    expect(dry.code).toBe(0);
    expect(dry.stderr).toMatch(/se importaría «Tienda web» \(tienda-web\): 2 diagrama\(s\), 3 versión\(es\)/);
    expect(dry.stderr).toMatch(/2 proyecto\(s\) en .*no se tocó la base/);

    const run = await cli(['workspace', 'import', '--from', root], env);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toMatch(/importado «Tienda web» \(tienda-web\): 2 diagrama\(s\), 3 versión\(es\)/);
    expect(run.stderr).toMatch(/2 importado\(s\), 0 ya estaban/);
    expect(run.stderr + run.stdout).not.toContain(SECRET);

    // idempotente: la segunda vez no hace nada
    const again = await cli(['workspace', 'import', '--from', root], env);
    expect(again.code).toBe(0);
    expect(again.stderr).toMatch(/0 importado\(s\), 2 ya estaban/);

    // el servicio lo ve igual que la carpeta: mismos ids, mismos documentos, mismo historial
    const server = await serve(['--workspace-store', 'postgres'], env);
    const api = async <T>(path: string): Promise<T> => (await fetch(`${server.url}${path}`)).json() as Promise<T>;
    const projects = await api<Array<{ id: string; name: string; description?: string; createdAt: string; diagrams: Array<{ id: string; module: string; name: string; updatedAt: string }> }>>('/api/projects');
    expect(projects.map((p) => p.id)).toEqual([bank.id, shop.id]);
    const imported = projects.find((p) => p.id === shop.id)!;
    const original = (await folder.getProject(shop.id))!;
    expect(imported).toMatchObject({ name: 'Tienda web', description: 'Pedidos', createdAt: original.createdAt });
    expect(imported.diagrams).toEqual(original.diagrams);
    expect((await api<{ text: string }>(`/api/projects/${shop.id}/diagrams/${context.id}`)).text).toBe('{"v":2}');
    const versions = await api<Array<{ id: number; label?: string; savedBy?: string }>>(`/api/projects/${shop.id}/diagrams/${context.id}/versions`);
    expect(versions.map((v) => [v.id, v.label, v.savedBy])).toEqual([
      [2, undefined, '@beto'],
      [1, 'Entrega 1', '@ana'],
    ]);
    expect((await api<{ text: string }>(`/api/projects/${shop.id}/diagrams/${context.id}/versions/1`)).text).toBe('{"v":1,  "z":0}');
    expect(await server.stop()).toBe(0);

    // `--replace` vuelve a crear los que ya existen
    const replaced = await cli(['workspace', 'import', '--from', root, '--replace'], env);
    expect(replaced.code).toBe(0);
    expect(replaced.stderr).toMatch(/2 importado\(s\), 0 ya estaban/);
  });

  it('workspace import falla con claridad si la carpeta no existe o la base no está configurada, y la carpeta de origen no se modifica', async () => {
    const missing = await cli(['workspace', 'import', '--from', join(tmp(), 'no-existe')], envFor(uniqueSchema()));
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/no existe o no es una carpeta/);
    const root = join(tmp(), 'espacio');
    await new FolderProjectStore(root).createProject({ name: 'Uno' });
    const noDb = await cli(['workspace', 'import', '--from', root], envFor(uniqueSchema(), { IARK_DATABASE_URL: undefined }));
    expect(noDb.code).toBe(2);
    expect(noDb.stderr).toMatch(/Falta IARK_DATABASE_URL/);
  });
});
