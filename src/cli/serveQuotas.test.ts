import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bundleToText, createBundle } from '@iark/kernel';
import { Observability } from './observability';
import { FolderProjectStore } from './workspace';
import { ANA, BETO, call, CARLA, cleanupCloud, JSON_TYPE, signIn, startCloud, tracked, type Cloud, type CloudOptions } from '../../tests/helpers/cloud';
import type { AccountStoreKind } from './accounts/store';
import { postgresAvailable, requirePostgresIfCi } from '../../tests/helpers/postgres';

requirePostgresIfCi();
// Con Postgres disponible (o exigido en el CI), las mismas pruebas corren también contra el almacén postgres.
const STORES: AccountStoreKind[] = ['json', 'sqlite', ...(postgresAvailable() ? (['postgres'] as const) : [])];

/**
 * Cuotas de uso de `iark serve --accounts` (ver `accounts/usage.ts`): bytes por persona (documentos + historial de versiones), proyectos por
 * persona y diagramas por proyecto; con topes de la instancia y topes personales fijados por un administrador. El servidor es el de verdad
 * (`createSuiteServer`) con el almacén de cuentas JSON, con SQLite y con Postgres; lo único falso es GitHub.
 *
 * Los documentos son texto cualquiera (un borrador puede no ser válido): `'x'.repeat(n)` pesa justo n bytes. Guardar un documento de n bytes cuesta
 * a lo sumo 2n (el documento y la versión que se anota), por eso los números de estas pruebas van de 2 en 2.
 */

afterEach(cleanupCloud);

const BODY = (size: number, char = 'x'): string => char.repeat(size);

/** Una nube con historial sin coalescencia (cada guardado distinto es una versión) y los topes que se pidan. */
async function quotaCloud(store: AccountStoreKind, options: CloudOptions = {}): Promise<Cloud & { workspace: FolderProjectStore }> {
  const root = mkdtempSync(join(tmpdir(), 'iark-cuotas-'));
  tracked.folders.push(root);
  const workspace = new FolderProjectStore(root, { versions: { coalesceSeconds: 0 } });
  const cloud = await startCloud({ store, signup: 'open', root, ...options, serve: { projects: workspace, usageTtlMs: 0, ...options.serve } });
  return Object.assign(cloud, { workspace });
}

const newProject = async (cloud: Cloud, token: string, name: string): Promise<string> => {
  const res = await call(cloud.base, token).post('/api/projects', { name });
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()).id as string;
};
const newDiagram = (cloud: Cloud, token: string, project: string, name: string, size: number, char = 'x') => call(cloud.base, token).post(`/api/projects/${project}/diagrams`, { module: 'c4', name, text: BODY(size, char) });
const usageOf = async (cloud: Cloud, token: string) => (await (await call(cloud.base, token).get('/api/usage')).json()) as {
  limits: { bytes: number; projects: number; diagramsPerProject: number };
  usage: { bytes: number; documentBytes: number; versionBytes: number; versions: number; projects: number };
  projects: Array<{ id: string; name: string; diagrams: number; documentBytes: number; versionBytes: number; bytes: number }>;
};
const filesIn = (cloud: Cloud, project: string): string[] => readdirSync(join(cloud.root, project)).filter((f) => f.endsWith('.json') && f !== 'project.json').sort();

describe.each<AccountStoreKind>(STORES)('cuotas con el almacén de cuentas %s', (store) => {
  describe('diagramas por proyecto', () => {
    it('rechaza el diagrama que pasa del tope con 409 limit y no escribe nada; guardar uno que ya existe, borrar y volver a crear siguen valiendo', async () => {
      const cloud = await quotaCloud(store, { quotas: { diagramsPerProject: 2, bytes: 0 } });
      const beto = await signIn(cloud, BETO);
      const p = await newProject(cloud, beto, 'Tienda');
      expect((await newDiagram(cloud, beto, p, 'Uno', 10)).status).toBe(201);
      const two = await newDiagram(cloud, beto, p, 'Dos', 10);
      expect(two.status).toBe(201);
      const third = await newDiagram(cloud, beto, p, 'Tres', 10);
      expect(third.status).toBe(409);
      expect(await third.json()).toMatchObject({ code: 'limit', quota: 'diagrams', used: 2, limit: 2, error: expect.stringContaining('máximo por proyecto (2)') });
      expect(filesIn(cloud, p)).toEqual(['dos.c4.json', 'uno.c4.json']);
      // lo que ya existe se sigue guardando
      const twoId = (await two.json()).id as string;
      expect((await call(cloud.base, beto).put(`/api/projects/${p}/diagrams/${twoId}`, { text: BODY(20) })).status).toBe(200);
      // al borrar uno vuelve a caber
      expect((await call(cloud.base, beto).del(`/api/projects/${p}/diagrams/${twoId}`)).status).toBe(200);
      expect((await newDiagram(cloud, beto, p, 'Tres', 10)).status).toBe(201);
    });

    it('el tope es por proyecto, no por persona: otro proyecto de la misma persona tiene su propio hueco', async () => {
      const cloud = await quotaCloud(store, { quotas: { diagramsPerProject: 1, bytes: 0 } });
      const beto = await signIn(cloud, BETO);
      const a = await newProject(cloud, beto, 'A');
      const b = await newProject(cloud, beto, 'B');
      expect((await newDiagram(cloud, beto, a, 'x', 1)).status).toBe(201);
      expect((await newDiagram(cloud, beto, a, 'y', 1)).status).toBe(409);
      expect((await newDiagram(cloud, beto, b, 'x', 1)).status).toBe(201);
    });
  });

  describe('bytes por persona', () => {
    it('cuenta documento y versión: con 10 000 bytes caben cinco diagramas de 1000; el sexto se rechaza sin tocar el disco, con el mensaje y las cifras', async () => {
      const cloud = await quotaCloud(store, { quotas: { bytes: 10_000, diagramsPerProject: 0 } });
      const beto = await signIn(cloud, BETO);
      const p = await newProject(cloud, beto, 'Tienda');
      for (const name of ['a', 'b', 'c', 'd', 'e']) expect((await newDiagram(cloud, beto, p, name, 1000)).status, name).toBe(201);
      expect(await usageOf(cloud, beto)).toMatchObject({ limits: { bytes: 10_000 }, usage: { bytes: 10_000, documentBytes: 5000, versionBytes: 5000, versions: 5, projects: 1 } });

      const sixth = await newDiagram(cloud, beto, p, 'f', 1000);
      expect(sixth.status).toBe(409);
      const body = await sixth.json();
      expect(body).toMatchObject({ code: 'limit', quota: 'bytes', used: 10_000, limit: 10_000 });
      expect(body.error).toMatch(/tu cuota de espacio es de 9,8 KB/);
      expect(body.error).toMatch(/Borra diagramas, proyectos o versiones con nombre/);
      expect(filesIn(cloud, p)).toHaveLength(5); // no escribió nada: ni el diagrama ni su historial
      expect(readdirSync(join(cloud.root, p, '.versiones'))).toHaveLength(5);
    });

    it('guardar encima de lo que ya existe cuenta solo lo que crece; un guardado que no crece, o que libera espacio, pasa aunque se esté en el tope', async () => {
      const cloud = await quotaCloud(store, { quotas: { bytes: 4000, diagramsPerProject: 0 } });
      const beto = await signIn(cloud, BETO);
      const p = await newProject(cloud, beto, 'Tienda');
      const created = await newDiagram(cloud, beto, p, 'a', 1000);
      const a = (await created.json()).id as string;
      expect((await newDiagram(cloud, beto, p, 'b', 1000)).status).toBe(201); // 4000 de 4000
      const put = (text: string) => call(cloud.base, beto).put(`/api/projects/${p}/diagrams/${a}`, { text });

      expect((await put(BODY(1000, 'y'))).status).toBe(409); // otra versión de 1000: no cabe
      expect((await put(BODY(1500))).status).toBe(409); // crecer tampoco
      expect((await put(BODY(1000))).status).toBe(200); // lo mismo que ya hay: no ocupa nada más
      expect((await put(BODY(400, 'z'))).status).toBe(200); // 2×400 − 1000 < 0: libera espacio (ahora se usan 3800)
      expect((await put(BODY(450, 'w'))).status).toBe(409); // 2×450 − 400 = 500: 4300 no cabe
      expect((await put(BODY(300, 'w'))).status).toBe(200); // 2×300 − 400 = 200: justo 4000
      expect((await usageOf(cloud, beto)).usage.bytes).toBe(4000);
    });

    it('restaurar y borrar versiones o diagramas nunca se rechaza por la cuota, aunque la persona esté por encima del tope; después hay que liberar espacio para volver a escribir', async () => {
      const cloud = await quotaCloud(store, { quotas: { bytes: 20_000, diagramsPerProject: 0 } });
      const beto = await signIn(cloud, BETO);
      const p = await newProject(cloud, beto, 'Tienda');
      const a = (await (await newDiagram(cloud, beto, p, 'a', 1000, 'a')).json()).id as string;
      expect((await call(cloud.base, beto).put(`/api/projects/${p}/diagrams/${a}`, { text: BODY(1000, 'b') })).status).toBe(200);
      const filler: string[] = [];
      for (const name of ['b', 'c', 'd', 'e', 'f', 'g']) filler.push((await (await newDiagram(cloud, beto, p, name, 1000)).json()).id as string);
      const used = (await usageOf(cloud, beto)).usage.bytes;
      expect(used).toBe(3000 + 6 * 2000); // 15 000
      // un diagrama que llena hasta el borde
      expect((await newDiagram(cloud, beto, p, 'h', 2500)).status).toBe(201); // +5000 = 20 000
      expect((await newDiagram(cloud, beto, p, 'i', 1)).status).toBe(409);

      // restaurar la versión 1 añade una versión más (1000): se pasa del tope y aun así se permite
      const restored = await call(cloud.base, beto).post(`/api/projects/${p}/diagrams/${a}/versions/1/restore`);
      expect(restored.status).toBe(200);
      expect((await restored.json()).unchanged).toBe(false);
      expect((await usageOf(cloud, beto)).usage.bytes).toBe(21_000);
      // nombrar y borrar una versión con nombre tampoco se rechaza, y sigue sin caber nada nuevo
      expect((await call(cloud.base, beto).patch(`/api/projects/${p}/diagrams/${a}/versions/2`, { label: 'la b' })).status).toBe(200);
      expect((await call(cloud.base, beto).del(`/api/projects/${p}/diagrams/${a}/versions/2`)).status).toBe(200);
      expect((await usageOf(cloud, beto)).usage.bytes).toBe(20_000);
      expect((await newDiagram(cloud, beto, p, 'j', 1)).status).toBe(409);
      // borrar un diagrama libera 2000 y vuelve a haber sitio
      expect((await call(cloud.base, beto).del(`/api/projects/${p}/diagrams/${filler[0]}`)).status).toBe(200);
      expect((await usageOf(cloud, beto)).usage.bytes).toBe(18_000);
      expect((await newDiagram(cloud, beto, p, 'j', 900)).status).toBe(201);
      // y borrar un proyecto entero libera todo lo suyo
      const other = await newProject(cloud, beto, 'Otro');
      expect((await newDiagram(cloud, beto, other, 'k', 150)).status).toBe(409); // 2×150 sobre 19 800 no cabe
      expect((await call(cloud.base, beto).del(`/api/projects/${p}`)).status).toBe(200);
      expect((await usageOf(cloud, beto)).usage).toMatchObject({ bytes: 0, projects: 1 });
      expect((await newDiagram(cloud, beto, other, 'k', 100)).status).toBe(201);
    });

    it('la cuota es de quien posee el proyecto, no de quien guarda: una editora gasta el espacio del dueño y su propia cuota queda intacta', async () => {
      const cloud = await quotaCloud(store, { quotas: { bytes: 4000, diagramsPerProject: 0 } });
      const beto = await signIn(cloud, BETO);
      const carla = await signIn(cloud, CARLA);
      const p = await newProject(cloud, beto, 'Compartido');
      await cloud.accounts.store.setMember(p, (await cloud.accounts.store.findByLogin('carla'))!.id, 'editor');
      expect((await newDiagram(cloud, carla, p, 'a', 1000)).status).toBe(201);
      expect((await newDiagram(cloud, carla, p, 'b', 1000)).status).toBe(201);
      const refused = await newDiagram(cloud, carla, p, 'c', 1000);
      expect(refused.status).toBe(409);
      expect((await refused.json()).error).toMatch(/la persona que posee el proyecto/);
      expect(await usageOf(cloud, beto)).toMatchObject({ usage: { bytes: 4000, projects: 1 } });
      expect(await usageOf(cloud, carla)).toMatchObject({ usage: { bytes: 0, projects: 0 } });
      // y Carla, en un proyecto suyo, tiene todo su espacio
      const hers = await newProject(cloud, carla, 'Suyo');
      expect((await newDiagram(cloud, carla, hers, 'a', 1000)).status).toBe(201);
      // el dueño ve el mensaje en primera persona
      expect((await (await newDiagram(cloud, beto, p, 'c', 1000)).json()).error).toMatch(/tu cuota de espacio/);
    });

    it('quien administra la instancia no tiene tope por omisión; con 0 se quita el tope a todos', async () => {
      const cloud = await quotaCloud(store, { quotas: { bytes: 1000, diagramsPerProject: 1 } });
      const ana = await signIn(cloud, ANA);
      const p = await newProject(cloud, ana, 'Sin tope');
      expect((await newDiagram(cloud, ana, p, 'a', 5000)).status).toBe(201);
      expect((await newDiagram(cloud, ana, p, 'b', 5000)).status).toBe(201);

      const open = await quotaCloud(store, { quotas: { bytes: 0, projects: 0, diagramsPerProject: 0 } });
      const beto = await signIn(open, BETO);
      for (let i = 0; i < 30; i++) await newProject(open, beto, `P${i}`); // más que los 25 de siempre
      const q = await newProject(open, beto, 'Grande');
      for (let i = 0; i < 3; i++) expect((await newDiagram(open, beto, q, `d${i}`, 50_000)).status).toBe(201);
      expect((await usageOf(open, beto)).limits).toEqual({ bytes: 0, projects: 0, diagramsPerProject: 0 });
    });

    it('guardar de dos en dos: ocho guardados a la vez que no caben todos dejan pasar exactamente los que caben', async () => {
      const cloud = await quotaCloud(store, { quotas: { bytes: 6000, diagramsPerProject: 0 } });
      const beto = await signIn(cloud, BETO);
      const p = await newProject(cloud, beto, 'Carrera');
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => newDiagram(cloud, beto, p, `d${i}`, 1000)));
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 201, 201, 409, 409, 409, 409, 409]);
      expect(filesIn(cloud, p)).toHaveLength(3);
      expect((await usageOf(cloud, beto)).usage.bytes).toBe(6000);
    });

    it('un guardado de un token de servicio en un proyecto con dueño también gasta la cuota del dueño', async () => {
      const cloud = await quotaCloud(store, { quotas: { bytes: 2000, diagramsPerProject: 0 }, tokens: true });
      const beto = await signIn(cloud, BETO);
      const p = await newProject(cloud, beto, 'Tienda');
      expect((await newDiagram(cloud, cloud.tokens!.admin, p, 'a', 1000)).status).toBe(201);
      expect((await newDiagram(cloud, cloud.tokens!.admin, p, 'b', 1)).status).toBe(409);
      // el token no tiene cuenta ni cuota propias
      const own = await call(cloud.base, cloud.tokens!.admin).get('/api/usage');
      expect(own.status).toBe(404);
    });
  });

  describe('proyectos por persona', () => {
    it('el tope se cuenta por proyectos que se poseen, no por los que se comparten; borrar uno devuelve el hueco', async () => {
      const cloud = await quotaCloud(store, { quotas: { projects: 2 } });
      const ana = await signIn(cloud, ANA);
      const beto = await signIn(cloud, BETO);
      const carla = await signIn(cloud, CARLA);
      const betoId = (await cloud.accounts.store.findByLogin('beto'))!.id;
      const mine = await newProject(cloud, carla, 'Mio');
      await cloud.accounts.store.setMember(mine, betoId, 'admin'); // administrar el de otra persona no cuenta
      const a = await newProject(cloud, beto, 'Uno');
      await newProject(cloud, beto, 'Dos');
      const third = await call(cloud.base, beto).post('/api/projects', { name: 'Tres' });
      expect(third.status).toBe(409);
      expect(await third.json()).toMatchObject({ code: 'limit', quota: 'projects', used: 2, limit: 2 });
      expect((await call(cloud.base, beto).del(`/api/projects/${a}`)).status).toBe(200);
      await newProject(cloud, beto, 'Tres');
      // los administradores de la instancia no tienen tope
      for (const name of ['A', 'B', 'C']) await newProject(cloud, ana, name);
    });

    it('importar un proyecto cuenta como crear uno, y sus diagramas y bytes deben caber', async () => {
      const cloud = await quotaCloud(store, { quotas: { projects: 1, diagramsPerProject: 2, bytes: 5000 } });
      const beto = await signIn(cloud, BETO);
      const bundle = (diagrams: number, size: number): string =>
        bundleToText(
          createBundle({
            id: 'x',
            name: 'Importado',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            diagrams: Array.from({ length: diagrams }, (_, i) => ({ id: `d${i}`, module: 'data', name: `D${i}`, text: BODY(size), createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' })),
          }),
        );
      const upload = (text: string) => fetch(`${cloud.base}/api/projects/import`, { method: 'POST', headers: { ...JSON_TYPE, Authorization: `Bearer ${beto}` }, body: text });
      const tooMany = await upload(bundle(3, 10));
      expect(tooMany.status).toBe(409);
      expect(await tooMany.json()).toMatchObject({ code: 'limit', quota: 'diagrams', used: 3, limit: 2 });
      const tooBig = await upload(bundle(2, 1500)); // 2 × 1500 × 2 = 6000 > 5000
      expect(tooBig.status).toBe(409);
      expect(await tooBig.json()).toMatchObject({ code: 'limit', quota: 'bytes', limit: 5000 });
      expect(readdirSync(cloud.root)).toEqual([]); // ninguno dejó un proyecto a medias
      expect((await upload(bundle(2, 1000))).status).toBe(201);
      // y ahora ya tiene su proyecto: no cabe otro
      const again = await upload(bundle(1, 10));
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ quota: 'projects' });
    });
  });

  describe('la cuota personal que fija un administrador', () => {
    it('sube o baja los topes de una persona, se ve en la lista de cuentas con su uso, se quita con null y 0 es sin tope', async () => {
      const cloud = await quotaCloud(store, { quotas: { bytes: 4000, projects: 1, diagramsPerProject: 1 } });
      const ana = await signIn(cloud, ANA);
      const beto = await signIn(cloud, BETO);
      const p = await newProject(cloud, beto, 'Tienda');
      expect((await newDiagram(cloud, beto, p, 'a', 1000)).status).toBe(201);
      expect((await newDiagram(cloud, beto, p, 'b', 1000)).status).toBe(409); // 1 diagrama por proyecto
      expect((await call(cloud.base, beto).post('/api/projects', { name: 'Otro' })).status).toBe(409);

      const set = await call(cloud.base, ana).put('/api/admin/users/beto', { quota: { diagramsPerProject: 5, projects: 3, bytes: 100_000 } });
      expect(set.status).toBe(200);
      expect(await set.json()).toMatchObject({ login: 'beto', quota: { diagramsPerProject: 5, projects: 3, bytes: 100_000 }, limits: { diagramsPerProject: 5, projects: 3, bytes: 100_000 } });
      expect((await newDiagram(cloud, beto, p, 'b', 1000)).status).toBe(201);
      expect((await call(cloud.base, beto).post('/api/projects', { name: 'Otro' })).status).toBe(201);
      expect((await cloud.accounts.store.findByLogin('beto'))?.quota).toEqual({ diagramsPerProject: 5, projects: 3, bytes: 100_000 });

      const list = (await (await call(cloud.base, ana).get('/api/admin/users')).json()) as Array<Record<string, unknown>>;
      expect(list.find((u) => u.login === 'beto')).toMatchObject({ quota: { bytes: 100_000 }, limits: { bytes: 100_000 }, usage: { bytes: 4000, documentBytes: 2000, versionBytes: 2000, versions: 2, projects: 2 } });
      expect(list.find((u) => u.login === 'ana')).toMatchObject({ limits: { bytes: 0, projects: 0, diagramsPerProject: 0 } }); // administra la instancia: sin tope
      expect(list.find((u) => u.login === 'ana')).not.toHaveProperty('quota');

      // null vuelve al valor de la instancia (solo ese campo); 0 es sin tope
      const back = await call(cloud.base, ana).put('/api/admin/users/beto', { quota: { bytes: null, diagramsPerProject: 0 } });
      expect(await back.json()).toMatchObject({ quota: { projects: 3, diagramsPerProject: 0 }, limits: { bytes: 4000, projects: 3, diagramsPerProject: 0 } });
      expect((await newDiagram(cloud, beto, p, 'c', 1000)).status).toBe(409); // otra vez los 4000 de la instancia
      expect((await call(cloud.base, ana).put('/api/admin/users/beto', { quota: { projects: null, diagramsPerProject: null } })).status).toBe(200);
      expect((await cloud.accounts.store.findByLogin('beto'))?.quota).toBeUndefined();
    });

    it('si le bajan el tope por debajo de lo que ya usa, no pierde nada: lo que tiene se queda, puede ver, borrar y guardar lo que libera, pero no crecer', async () => {
      const cloud = await quotaCloud(store, { quotas: { bytes: 100_000, diagramsPerProject: 0 } });
      const ana = await signIn(cloud, ANA);
      const beto = await signIn(cloud, BETO);
      const p = await newProject(cloud, beto, 'Tienda');
      const ids: string[] = [];
      for (const name of ['a', 'b', 'c', 'd']) ids.push((await (await newDiagram(cloud, beto, p, name, 1000)).json()).id as string); // 8000
      await call(cloud.base, ana).put('/api/admin/users/beto', { quota: { bytes: 5000 } });
      expect((await usageOf(cloud, beto))).toMatchObject({ limits: { bytes: 5000 }, usage: { bytes: 8000 } }); // por encima, y nada se tocó
      expect(filesIn(cloud, p)).toHaveLength(4);
      expect((await call(cloud.base, beto).get(`/api/projects/${p}/diagrams/${ids[0]}`)).status).toBe(200);
      expect((await newDiagram(cloud, beto, p, 'e', 1)).status).toBe(409);
      const put = (id: string, text: string) => call(cloud.base, beto).put(`/api/projects/${p}/diagrams/${id}`, { text });
      expect((await put(ids[0], BODY(1100, 'y'))).status).toBe(409); // crecer, no
      expect((await put(ids[0], BODY(100, 'y'))).status).toBe(200); // liberar, sí, aunque siga por encima: 8000 − 800
      expect((await usageOf(cloud, beto)).usage.bytes).toBe(7200);
      expect((await call(cloud.base, beto).del(`/api/projects/${p}/diagrams/${ids[1]}`)).status).toBe(200);
      expect((await call(cloud.base, beto).del(`/api/projects/${p}/diagrams/${ids[2]}`)).status).toBe(200);
      expect((await usageOf(cloud, beto)).usage.bytes).toBe(3200);
      expect((await newDiagram(cloud, beto, p, 'e', 800)).status).toBe(201); // otra vez cabe: 3200 + 1600 = 4800
    });

    it('a una persona con un tope personal bajo se le rechaza aunque la instancia sea generosa; tocar solo la cuota no cambia su rol ni su estado', async () => {
      const cloud = await quotaCloud(store, { quotas: { bytes: 1_000_000 } });
      const ana = await signIn(cloud, ANA);
      const beto = await signIn(cloud, BETO);
      await call(cloud.base, ana).put('/api/admin/users/beto', { quota: { bytes: 2000 } });
      const p = await newProject(cloud, beto, 'Tienda');
      expect((await newDiagram(cloud, beto, p, 'a', 1000)).status).toBe(201);
      expect((await newDiagram(cloud, beto, p, 'b', 1000)).status).toBe(409);
      expect(await cloud.accounts.store.findByLogin('beto')).toMatchObject({ siteRole: 'member' });
      expect((await cloud.accounts.store.findByLogin('beto'))?.disabled).toBeUndefined();
      expect((await usageOf(cloud, beto)).limits.bytes).toBe(2000);
    });

    it('un administrador puede fijar la cuota a una invitación que nadie ha reclamado, y la hereda quien entre', async () => {
      const cloud = await quotaCloud(store, { quotas: { projects: 1 } });
      const ana = await signIn(cloud, ANA);
      const invited = await call(cloud.base, ana).put('/api/admin/users/carla', { siteRole: 'member', quota: { projects: 4 } });
      expect(invited.status).toBe(201);
      expect(await invited.json()).toMatchObject({ pending: true, quota: { projects: 4 }, limits: { projects: 4 } });
      const carla = await signIn(cloud, CARLA);
      for (const name of ['A', 'B', 'C', 'D']) await newProject(cloud, carla, name);
      expect((await call(cloud.base, carla).post('/api/projects', { name: 'E' })).status).toBe(409);
      expect((await cloud.accounts.store.snapshot()).users.find((u) => u.login === 'carla')?.quota).toEqual({ projects: 4 });
    });

    it('solo quien administra la instancia la cambia; lo inválido se rechaza con 400 sin cambiar nada', async () => {
      const cloud = await quotaCloud(store);
      const ana = await signIn(cloud, ANA);
      const beto = await signIn(cloud, BETO);
      expect((await call(cloud.base, beto).put('/api/admin/users/beto', { quota: { bytes: 0 } })).status).toBe(403);
      expect((await cloud.accounts.store.findByLogin('beto'))?.quota).toBeUndefined();
      for (const quota of [{ bytes: -1 }, { bytes: 1.5 }, { bytes: '10' }, { bytes: 9e99 }, { discos: 2 }, [], 'mucho', null]) {
        const res = await call(cloud.base, ana).put('/api/admin/users/beto', { quota });
        expect(res.status, JSON.stringify(quota)).toBe(400);
        expect(await res.json()).toMatchObject({ code: 'invalid' });
      }
      expect((await cloud.accounts.store.findByLogin('beto'))?.quota).toBeUndefined();
      // no crea la invitación de una cuenta nueva si la cuota no vale
      expect((await call(cloud.base, ana).put('/api/admin/users/dani', { quota: { bytes: -1 } })).status).toBe(400);
      expect(await cloud.accounts.store.findByLogin('dani')).toBeUndefined();
    });
  });

  describe('GET /api/usage', () => {
    it('cuenta documento y versiones por proyecto, de más a menos, solo los proyectos que posee, y pide una sesión', async () => {
      const cloud = await quotaCloud(store, { quotas: { bytes: 100_000 } });
      const beto = await signIn(cloud, BETO);
      const carla = await signIn(cloud, CARLA);
      expect((await fetch(`${cloud.base}/api/usage`)).status).toBe(401);
      expect((await call(cloud.base, beto).post('/api/usage', {})).status).toBe(405);
      expect(await usageOf(cloud, beto)).toEqual({ limits: { bytes: 100_000, projects: 25, diagramsPerProject: 200 }, usage: { bytes: 0, documentBytes: 0, versionBytes: 0, versions: 0, projects: 0 }, projects: [] });

      const small = await newProject(cloud, beto, 'Pequeño');
      const big = await newProject(cloud, beto, 'Grande');
      await newDiagram(cloud, beto, small, 'a', 100);
      const d = (await (await newDiagram(cloud, beto, big, 'b', 1000)).json()).id as string;
      await call(cloud.base, beto).put(`/api/projects/${big}/diagrams/${d}`, { text: BODY(700, 'y') });
      await cloud.accounts.store.setMember(small, (await cloud.accounts.store.findByLogin('carla'))!.id, 'admin'); // administrar el de otra persona no suma a Carla

      const usage = await usageOf(cloud, beto);
      expect(usage.usage).toEqual({ bytes: 200 + 700 + 1700, documentBytes: 800, versionBytes: 1800, versions: 3, projects: 2 });
      expect(usage.projects).toEqual([
        { id: big, name: 'Grande', diagrams: 1, documentBytes: 700, versions: 2, versionBytes: 1700, bytes: 2400 },
        { id: small, name: 'Pequeño', diagrams: 1, documentBytes: 100, versions: 1, versionBytes: 100, bytes: 200 },
      ]);
      expect((await usageOf(cloud, carla)).usage.projects).toBe(0);
    });

    it('lo que ocupan los documentos y el historial sale del disco: un diagrama copiado a mano a la carpeta se cuenta, y .versiones también', async () => {
      const cloud = await quotaCloud(store, { quotas: { bytes: 100_000 } });
      const beto = await signIn(cloud, BETO);
      const p = await newProject(cloud, beto, 'Tienda');
      await newDiagram(cloud, beto, p, 'a', 1000);
      writeFileSync(join(cloud.root, p, 'a-mano.c4.json'), BODY(300));
      const usage = await usageOf(cloud, beto);
      expect(usage.usage).toMatchObject({ documentBytes: 1300, versionBytes: 1000, bytes: 2300 });
      expect(readFileSync(join(cloud.root, p, 'a-mano.c4.json'), 'utf8')).toHaveLength(300);
    });
  });

  describe('la lista de cuentas usa una medida guardada', () => {
    it('con la caché larga, cada cambio hecho por la API invalida la medida de su proyecto: la lista de cuentas no se queda atrás', async () => {
      const cloud = await quotaCloud(store, { quotas: { bytes: 0 }, serve: { usageTtlMs: 600_000 } });
      const ana = await signIn(cloud, ANA);
      const beto = await signIn(cloud, BETO);
      const p = await newProject(cloud, beto, 'Tienda');
      const bytesOfBeto = async (): Promise<number> => ((await (await call(cloud.base, ana).get('/api/admin/users')).json()) as Array<{ login: string; usage?: { bytes: number } }>).find((u) => u.login === 'beto')!.usage!.bytes;
      expect(await bytesOfBeto()).toBe(0);
      const a = (await (await newDiagram(cloud, beto, p, 'a', 1000)).json()).id as string;
      expect(await bytesOfBeto()).toBe(2000);
      await call(cloud.base, beto).put(`/api/projects/${p}/diagrams/${a}`, { text: BODY(800, 'y') });
      expect(await bytesOfBeto()).toBe(800 + 1000 + 800); // el documento pesa 800 y el historial guarda 1000 y 800
      await call(cloud.base, beto).del(`/api/projects/${p}/diagrams/${a}`);
      expect(await bytesOfBeto()).toBe(0);
      // lo que cambia fuera de la API (a mano en la carpeta) se nota cuando caduca la medida, no antes
      writeFileSync(join(cloud.root, p, 'a-mano.c4.json'), BODY(300));
      expect(await bytesOfBeto()).toBe(0);
      expect((await usageOf(cloud, beto)).usage.bytes).toBe(300); // /api/usage mide siempre de nuevo
    });
  });

  describe('/metrics', () => {
    it('cuenta los rechazos por tipo de tope y publica los topes de la instancia, sin ninguna etiqueta por persona', async () => {
      const obs = new Observability({ metrics: true, version: 'prueba' });
      const token = 'x'.repeat(24);
      const cloud = await quotaCloud(store, { quotas: { bytes: 1000, projects: 1, diagramsPerProject: 1 }, serve: { observability: obs, metricsToken: token } });
      const beto = await signIn(cloud, BETO);
      const p = await newProject(cloud, beto, 'Tienda');
      await call(cloud.base, beto).post('/api/projects', { name: 'Otro' }); // projects
      await newDiagram(cloud, beto, p, 'a', 100);
      await newDiagram(cloud, beto, p, 'b', 100); // diagrams
      await newDiagram(cloud, beto, p, 'c', 100); // diagrams
      const d = (await (await call(cloud.base, beto).get(`/api/projects/${p}`)).json()).diagrams[0].id as string;
      await call(cloud.base, beto).put(`/api/projects/${p}/diagrams/${d}`, { text: BODY(5000) }); // bytes
      const text = await (await fetch(`${cloud.base}/metrics`, { headers: { Authorization: `Bearer ${token}` } })).text();
      expect(text).toContain('iark_quota_rejections_total{kind="bytes"} 1');
      expect(text).toContain('iark_quota_rejections_total{kind="projects"} 1');
      expect(text).toContain('iark_quota_rejections_total{kind="diagrams"} 2');
      expect(text).toContain('iark_quota_limit{kind="bytes"} 1000');
      for (const line of text.split('\n').filter((l) => l.startsWith('iark_quota'))) expect(line, line).not.toMatch(/beto|ana|carla|u_[A-Za-z0-9_-]{16}|login|user/i);
    });
  });
});

describe('cuotas: sin cuentas', () => {
  it('sin cuentas no hay cuotas: un servicio con solo --workspace no rechaza nada', async () => {
    const { createSuiteServer } = await import('./serve');
    const { createDefaultRegistry } = await import('./registry');
    const root = mkdtempSync(join(tmpdir(), 'iark-sin-cuotas-'));
    mkdirSync(root, { recursive: true });
    tracked.folders.push(root);
    const server = createSuiteServer({ registry: createDefaultRegistry(), version: '1', projects: new FolderProjectStore(root) });
    tracked.servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const p = (await (await call(base).post('/api/projects', { name: 'Libre' })).json()).id as string;
    for (let i = 0; i < 30; i++) expect((await call(base).post(`/api/projects/${p}/diagrams`, { module: 'c4', name: `d${i}`, text: BODY(2000) })).status).toBe(201);
    expect((await fetch(`${base}/api/usage`)).status).toBe(404);
    rmSync(root, { recursive: true, force: true });
  });
});
