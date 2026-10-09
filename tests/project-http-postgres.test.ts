import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HttpProjectStore } from '@iark/kernel';
import { createDefaultRegistry } from '../src/cli/registry';
import { createSuiteServer } from '../src/cli/serve';
import { PostgresDatabase } from '../src/cli/postgres/pool';
import { PostgresProjectStore, type PostgresProjectStoreOptions } from '../src/cli/postgresProjects';
import { ANA, BETO, call, CARLA, cleanupCloud, signIn, startCloud, type Cloud } from './helpers/cloud';
import { openTestDatabase, postgresAvailable, requirePostgresIfCi, startTestPostgres, type TestPostgres } from './helpers/postgres';
import { projectStoreContract } from './helpers/projectStoreContract';
import { projectVersionsContract } from './helpers/projectVersionsContract';

requirePostgresIfCi();

/**
 * `iark serve` con los proyectos en Postgres, de punta a punta: el cliente remoto contra el servidor de verdad (el mismo contrato que cumplen la
 * carpeta y la memoria, pero pasando por HTTP y por la base), la comprobación de salud, dos réplicas sobre la misma base y las cuotas de
 * `--accounts` midiendo `documentUsage` y `versionUsage` en Postgres. Lo único falso es GitHub.
 */

describe.skipIf(!postgresAvailable())('iark serve con los proyectos en Postgres', () => {
  let pg: TestPostgres;
  beforeAll(async () => {
    pg = await startTestPostgres();
  }, 120_000);
  afterAll(async () => {
    await pg?.stop();
  });

  const closers: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    await cleanupCloud();
    for (const close of closers.splice(0).reverse()) await close();
  });

  /** Un esquema nuevo en la base temporal; devuelve su conexión y se borra al terminar la prueba. */
  async function database() {
    const { db, drop } = await openTestDatabase(pg.url);
    closers.push(drop);
    return db;
  }
  async function store(db: PostgresDatabase, options: PostgresProjectStoreOptions = {}): Promise<PostgresProjectStore> {
    return PostgresProjectStore.open(db, options);
  }
  async function serve(projects: PostgresProjectStore): Promise<{ base: string; server: Server }> {
    const server = createSuiteServer({ registry: createDefaultRegistry(), version: '1', projects });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    );
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
  }

  // El mismo contrato que la carpeta y la memoria, pero con HttpProjectStore → servidor → Postgres.
  projectStoreContract('HttpProjectStore → iark serve → Postgres', async () => {
    const db = await database();
    const { base } = await serve(await store(db));
    return { store: new HttpProjectStore({ baseUrl: base }) };
  });

  projectVersionsContract(
    'HttpProjectStore → iark serve → Postgres',
    async ({ policy, clock }) => {
      const db = await database();
      const { base } = await serve(await store(db, { versions: policy, clock: () => clock.now() }));
      return { store: new HttpProjectStore({ baseUrl: base }) };
    },
    { recordsActor: false, reportsUsage: false },
  );

  describe('salud y réplicas', () => {
    it('/readyz hace un ping a la base como comprobación «workspace»: ok mientras contesta, 503 cuando ya no', async () => {
      const db = await database();
      const connection = await PostgresDatabase.connect(db.config); // la del servicio; `db` queda para borrar el esquema al terminar
      const projects = await store(connection);
      const server = createSuiteServer({ registry: createDefaultRegistry(), version: '1', projects, readyCacheMs: 0 });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      closers.push(() => void server.close());
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const ok = await fetch(`${base}/readyz`);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ status: 'ok', checks: { workspace: 'ok' } });
      // la base deja de contestar (se cierra el pool): el servicio sigue vivo pero ya no está listo
      await connection.close();
      const down = await fetch(`${base}/readyz`);
      expect(down.status).toBe(503);
      expect(await down.json()).toEqual({ status: 'fail', checks: { workspace: 'fail' } });
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      // y la API contesta con un error limpio, sin la dirección de la base
      const failed = await fetch(`${base}/api/projects`);
      expect(failed.status).toBe(500);
      expect(JSON.stringify(await failed.json())).not.toMatch(/postgres|127\.0\.0\.1/i);
    });

    it('dos réplicas del servicio sobre la misma base comparten los proyectos y se detectan los conflictos entre ellas', async () => {
      const db = await database();
      const other = await PostgresDatabase.connect(db.config);
      closers.push(() => other.close());
      const one = await serve(await store(db));
      const two = await serve(await store(other));
      const a = new HttpProjectStore({ baseUrl: one.base });
      const b = new HttpProjectStore({ baseUrl: two.base });
      const project = await a.createProject({ name: 'Tienda' });
      const diagram = await a.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text: '{"v":1}' });
      expect((await b.listProjects()).map((p) => p.name)).toEqual(['Tienda']);
      expect((await b.getDiagram(project.id, diagram.id))?.text).toBe('{"v":1}');
      const results = await Promise.allSettled([
        a.saveDiagram(project.id, { id: diagram.id, text: '{"v":2}', ifUpdatedAt: diagram.updatedAt }),
        b.saveDiagram(project.id, { id: diagram.id, text: '{"v":3}', ifUpdatedAt: diagram.updatedAt }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'conflict' });
    });
  });

  // ───────────── cuotas: lo que mide Postgres ─────────────

  describe('cuotas con --accounts', () => {
    const BODY = (size: number, char = 'x'): string => char.repeat(size);
    const newProject = async (cloud: Cloud, token: string, name: string): Promise<string> => {
      const res = await call(cloud.base, token).post('/api/projects', { name });
      expect(res.status, await res.clone().text()).toBe(201);
      return (await res.json()).id as string;
    };
    const newDiagram = (cloud: Cloud, token: string, project: string, name: string, size: number, char = 'x') => call(cloud.base, token).post(`/api/projects/${project}/diagrams`, { module: 'c4', name, text: BODY(size, char) });
    const usageOf = async (cloud: Cloud, token: string) =>
      (await (await call(cloud.base, token).get('/api/usage')).json()) as {
        limits: { bytes: number; projects: number; diagramsPerProject: number };
        usage: { bytes: number; documentBytes: number; versionBytes: number; versions: number; projects: number };
        projects: Array<{ id: string; name: string; diagrams: number; documentBytes: number; versions: number; versionBytes: number; bytes: number }>;
      };
    /** Una nube con los proyectos en Postgres, historial sin coalescencia y los topes que se pidan. */
    async function pgCloud(options: Parameters<typeof startCloud>[0] = {}): Promise<Cloud> {
      const db = await database();
      return startCloud({ signup: 'open', ...options, serve: { projects: await store(db, { versions: { coalesceSeconds: 0 } }), usageTtlMs: 0, ...options.serve } });
    }

    it('rechaza el diagrama que pasa del tope de diagramas con 409 limit y no guarda nada', async () => {
      const cloud = await pgCloud({ quotas: { diagramsPerProject: 2, bytes: 0 } });
      const beto = await signIn(cloud, BETO);
      const p = await newProject(cloud, beto, 'Tienda');
      expect((await newDiagram(cloud, beto, p, 'Uno', 10)).status).toBe(201);
      expect((await newDiagram(cloud, beto, p, 'Dos', 10)).status).toBe(201);
      const third = await newDiagram(cloud, beto, p, 'Tres', 10);
      expect(third.status).toBe(409);
      expect(await third.json()).toMatchObject({ code: 'limit', quota: 'diagrams', used: 2, limit: 2 });
      const project = (await (await call(cloud.base, beto).get(`/api/projects/${p}`)).json()) as { diagrams: unknown[] };
      expect(project.diagrams).toHaveLength(2);
    });

    it('cuenta documento y versión: con 10 000 bytes caben cinco diagramas de 1000; el sexto se rechaza sin guardar nada, con las cifras', async () => {
      const cloud = await pgCloud({ quotas: { bytes: 10_000, diagramsPerProject: 0 } });
      const beto = await signIn(cloud, BETO);
      const p = await newProject(cloud, beto, 'Tienda');
      for (const name of ['a', 'b', 'c', 'd', 'e']) expect((await newDiagram(cloud, beto, p, name, 1000)).status, name).toBe(201);
      expect(await usageOf(cloud, beto)).toMatchObject({ limits: { bytes: 10_000 }, usage: { bytes: 10_000, documentBytes: 5000, versionBytes: 5000, versions: 5, projects: 1 } });
      const sixth = await newDiagram(cloud, beto, p, 'f', 1000);
      expect(sixth.status).toBe(409);
      expect(await sixth.json()).toMatchObject({ code: 'limit', quota: 'bytes', used: 10_000, limit: 10_000 });
      expect((await usageOf(cloud, beto)).usage).toMatchObject({ bytes: 10_000, versions: 5 }); // no escribió el diagrama ni su versión
    });

    it('guardar encima de lo que ya existe cuenta solo lo que crece; lo que no crece o libera pasa aunque se esté en el tope', async () => {
      const cloud = await pgCloud({ quotas: { bytes: 4000, diagramsPerProject: 0 } });
      const beto = await signIn(cloud, BETO);
      const p = await newProject(cloud, beto, 'Tienda');
      const a = (await (await newDiagram(cloud, beto, p, 'a', 1000)).json()).id as string;
      expect((await newDiagram(cloud, beto, p, 'b', 1000)).status).toBe(201); // 4000 de 4000
      const put = (text: string) => call(cloud.base, beto).put(`/api/projects/${p}/diagrams/${a}`, { text });
      expect((await put(BODY(1000, 'y'))).status).toBe(409);
      expect((await put(BODY(1000))).status).toBe(200); // el mismo contenido: no ocupa nada más
      expect((await put(BODY(400, 'z'))).status).toBe(200); // libera espacio
      expect((await put(BODY(450, 'w'))).status).toBe(409);
      expect((await put(BODY(300, 'w'))).status).toBe(200);
      expect((await usageOf(cloud, beto)).usage.bytes).toBe(4000);
    });

    it('la cuota es de quien posee el proyecto, no de quien guarda; un token de servicio también gasta la del dueño', async () => {
      const cloud = await pgCloud({ quotas: { bytes: 4000, diagramsPerProject: 0 }, tokens: true });
      const beto = await signIn(cloud, BETO);
      const carla = await signIn(cloud, CARLA);
      const p = await newProject(cloud, beto, 'Compartido');
      cloud.accounts.store.setMember(p, cloud.accounts.store.findByLogin('carla')!.id, 'editor');
      expect((await newDiagram(cloud, carla, p, 'a', 1000)).status).toBe(201);
      expect((await newDiagram(cloud, cloud.tokens!.admin, p, 'b', 1000)).status).toBe(201);
      expect((await newDiagram(cloud, carla, p, 'c', 1000)).status).toBe(409);
      expect(await usageOf(cloud, beto)).toMatchObject({ usage: { bytes: 4000, projects: 1 } });
      expect(await usageOf(cloud, carla)).toMatchObject({ usage: { bytes: 0, projects: 0 } });
    });

    it('un proyecto sin dueña (creado con un token de servicio) solo tiene el tope de diagramas, no el de bytes', async () => {
      const cloud = await pgCloud({ quotas: { bytes: 1000, diagramsPerProject: 2 }, tokens: true });
      const admin = cloud.tokens!.admin;
      const p = await newProject(cloud, admin, 'Sin dueña');
      expect((await newDiagram(cloud, admin, p, 'a', 5000)).status).toBe(201);
      expect((await newDiagram(cloud, admin, p, 'b', 5000)).status).toBe(201);
      expect((await newDiagram(cloud, admin, p, 'c', 1)).status).toBe(409);
    });

    it('guardar de ocho en ocho: los guardados simultáneos que no caben todos dejan pasar exactamente los que caben', async () => {
      const cloud = await pgCloud({ quotas: { bytes: 6000, diagramsPerProject: 0 } });
      const beto = await signIn(cloud, BETO);
      const p = await newProject(cloud, beto, 'Carrera');
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => newDiagram(cloud, beto, p, `d${i}`, 1000)));
      expect(results.map((r) => r.status).sort()).toEqual([201, 201, 201, 409, 409, 409, 409, 409]);
      expect((await usageOf(cloud, beto)).usage.bytes).toBe(6000);
    });

    it('/api/usage desglosa documentos y versiones por proyecto, de más a menos, y lo ve quien administra la instancia', async () => {
      const cloud = await pgCloud({ quotas: { bytes: 100_000 } });
      const beto = await signIn(cloud, BETO);
      const small = await newProject(cloud, beto, 'Pequeño');
      const big = await newProject(cloud, beto, 'Grande');
      await newDiagram(cloud, beto, small, 'a', 100);
      const d = (await (await newDiagram(cloud, beto, big, 'b', 1000)).json()).id as string;
      await call(cloud.base, beto).put(`/api/projects/${big}/diagrams/${d}`, { text: BODY(700, 'y') });
      const usage = await usageOf(cloud, beto);
      expect(usage.usage).toEqual({ bytes: 200 + 700 + 1700, documentBytes: 800, versionBytes: 1800, versions: 3, projects: 2 });
      expect(usage.projects).toEqual([
        { id: big, name: 'Grande', diagrams: 1, documentBytes: 700, versions: 2, versionBytes: 1700, bytes: 2400 },
        { id: small, name: 'Pequeño', diagrams: 1, documentBytes: 100, versions: 1, versionBytes: 100, bytes: 200 },
      ]);
      const ana = await signIn(cloud, ANA);
      expect((await call(cloud.base, ana).get('/api/projects')).status).toBe(200);
    });
  });
});
