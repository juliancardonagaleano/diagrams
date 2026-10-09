import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeContent, MemoryProjectStore, ProjectError, type ProjectStore, type VersionedProjectStore, type VersionPolicy } from '@iark/kernel';
import { openTestDatabase, postgresAvailable, requirePostgresIfCi, startTestPostgres, testConfig, type TestPostgres } from '../../tests/helpers/postgres';
import { projectStoreContract } from '../../tests/helpers/projectStoreContract';
import { projectVersionsContract, testClock } from '../../tests/helpers/projectVersionsContract';
import { currentVersion } from './postgres/migrate';
import { PostgresDatabase } from './postgres/pool';
import { PostgresProjectStore, type PostgresProjectStoreOptions } from './postgresProjects';
import { isWorkspaceId, MAX_DOCUMENT_BYTES } from './workspace';

requirePostgresIfCi();

const rejects = async (promise: Promise<unknown>, code: string): Promise<ProjectError> => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ProjectError);
  expect((error as ProjectError).code).toBe(code);
  return error as ProjectError;
};

describe.skipIf(!postgresAvailable())('PostgresProjectStore (contra un Postgres de verdad)', () => {
  let server: TestPostgres;
  beforeAll(async () => {
    server = await startTestPostgres();
  }, 120_000);
  afterAll(async () => {
    await server?.stop();
  });

  /** Un almacén en un esquema propio, y otra conexión (`second`) al MISMO esquema: dos «procesos» sobre la misma base. */
  async function open(options: PostgresProjectStoreOptions = {}) {
    const { db, drop } = await openTestDatabase(server.url);
    const store = await PostgresProjectStore.open(db, options);
    const extra: PostgresDatabase[] = [];
    return {
      db,
      store,
      async second(secondOptions: PostgresProjectStoreOptions = options): Promise<PostgresProjectStore> {
        const other = await PostgresDatabase.connect(db.config);
        extra.push(other);
        return PostgresProjectStore.open(other, secondOptions);
      },
      async drop(): Promise<void> {
        for (const other of extra) await other.close();
        await drop();
      },
    };
  }

  const withStore = async (options: PostgresProjectStoreOptions, body: (ctx: Awaited<ReturnType<typeof open>>) => Promise<void>): Promise<void> => {
    const ctx = await open(options);
    try {
      await body(ctx);
    } finally {
      await ctx.drop();
    }
  };

  // ───────────── las mismas baterías de contrato que la carpeta y la memoria ─────────────

  projectStoreContract('Postgres', async () => {
    const ctx = await open();
    return { store: ctx.store, cleanup: ctx.drop };
  });

  projectVersionsContract('Postgres', async ({ policy, clock }) => {
    const ctx = await open({ versions: policy, clock: () => clock.now() });
    return { store: ctx.store, cleanup: ctx.drop };
  });

  // ───────────── esquema y migraciones ─────────────

  describe('migraciones y esquema', () => {
    it('crea las tablas del namespace «proyectos» en la versión 1, con seguridad por filas, y reabrir no repite nada', () =>
      withStore({}, async ({ db, store }) => {
        expect(await currentVersion(db, 'proyectos')).toBe(1);
        const tables = await db.query<{ relname: string; relrowsecurity: boolean }>(
          `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relkind = 'r' order by c.relname`,
          [db.config.schema],
        );
        expect(tables).toEqual([
          { relname: 'diagramas', relrowsecurity: true },
          { relname: 'migraciones', relrowsecurity: true },
          { relname: 'proyectos', relrowsecurity: true },
          { relname: 'versiones', relrowsecurity: true },
        ]);
        await store.createProject({ name: 'Tienda' });
        await PostgresProjectStore.open(db); // otra vez: ya está al día
        expect(await currentVersion(db, 'proyectos')).toBe(1);
        expect((await store.listProjects()).map((p) => p.name)).toEqual(['Tienda']);
      }));

    it('el documento es `text` (no jsonb) y los bytes de las cuotas son una columna calculada por la base', () =>
      withStore({}, async ({ db }) => {
        const columns = await db.query<{ column_name: string; data_type: string; is_generated: string }>(
          `select column_name, data_type, is_generated from information_schema.columns where table_schema = $1 and table_name in ('diagramas', 'versiones') and column_name in ('documento', 'bytes') order by table_name, column_name`,
          [db.config.schema],
        );
        expect(columns).toEqual([
          { column_name: 'bytes', data_type: 'integer', is_generated: 'ALWAYS' },
          { column_name: 'documento', data_type: 'text', is_generated: 'NEVER' },
          { column_name: 'documento', data_type: 'text', is_generated: 'NEVER' },
        ]);
      }));

    it('una base con un esquema de proyectos más nuevo que este IArk no se abre (hay que actualizar IArk, no la base)', () =>
      withStore({}, async ({ db }) => {
        await db.query(`insert into ${db.schemaQuoted}.migraciones (namespace, version, name) values ('proyectos', 2, 'futura')`);
        await expect(PostgresProjectStore.open(db)).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('más nueva') });
      }));

    it('persiste: otra conexión (un reinicio) ve los proyectos, los diagramas, el historial y las fechas tal cual', async () => {
      const ctx = await open({ versions: { coalesceSeconds: 0 } });
      try {
        const project = await ctx.store.createProject({ name: 'Ñandú', description: 'Pedidos' });
        const diagram = await ctx.store.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text: '{"v":1}', by: '@ana' });
        const saved = await ctx.store.saveDiagram(project.id, { id: diagram.id, text: '{"v":2}', by: '@ana' });
        await (ctx.store as VersionedProjectStore).labelVersion(project.id, diagram.id, 1, 'Entrega');
        const before = { projects: await ctx.store.listProjects(), versions: await ctx.store.listVersions(project.id, diagram.id) };
        await ctx.db.close();

        const reopened = await PostgresDatabase.connect(ctx.db.config);
        try {
          const again = await PostgresProjectStore.open(reopened, { versions: { coalesceSeconds: 0 } });
          expect(await again.listProjects()).toEqual(before.projects);
          expect(await again.listVersions(project.id, diagram.id)).toEqual(before.versions);
          expect(await again.getDiagram(project.id, diagram.id)).toMatchObject({ text: '{"v":2}', updatedAt: saved.updatedAt });
          // y se puede seguir guardando donde se quedó: el contador de versiones no empieza de cero
          await again.saveDiagram(project.id, { id: diagram.id, text: '{"v":3}', ifUpdatedAt: saved.updatedAt });
          expect((await again.listVersions(project.id, diagram.id)).map((v) => v.id)).toEqual([3, 2, 1]);
        } finally {
          await reopened.query(`drop schema if exists ${reopened.schemaQuoted} cascade`);
          await reopened.close();
        }
      } catch (error) {
        await ctx.drop().catch(() => undefined);
        throw error;
      }
    });

    it('esquemas distintos de la misma base no se ven entre sí (ni chocan en nombres)', async () => {
      const one = await open();
      const two = await open();
      try {
        expect(one.db.config.schema).not.toBe(two.db.config.schema);
        const a = await one.store.createProject({ name: 'Tienda' });
        await one.store.saveDiagram(a.id, { module: 'c4', name: 'Contexto', text: 'a' });
        expect(await two.store.listProjects()).toEqual([]);
        const b = await two.store.createProject({ name: 'Tienda' }); // el mismo nombre en otro esquema es válido
        expect(b.id).toBe(a.id);
        expect((await one.store.getProject(a.id))!.diagrams).toHaveLength(1);
        expect((await two.store.getProject(b.id))!.diagrams).toHaveLength(0);
      } finally {
        await one.drop();
        await two.drop();
      }
    });
  });

  // ───────────── documentos exactos ─────────────

  describe('documentos', () => {
    it('se guardan tal cual: claves en su orden, claves repetidas, números como se escribieron, espacios, BOM y retornos de carro', () =>
      withStore({ versions: { coalesceSeconds: 0 } }, async ({ store }) => {
        const project = await store.createProject({ name: 'Exactos' });
        const texts = [
          '{"z":1,"a":{"y":2,"b":1.0},"a":3,  "n": 1e3, "big": 12345678901234567890}\n',
          '﻿{"bom":true}\r\n',
          '{ "unicode": "\\u00e9 é 日本 𝄞", "nul": "\\u0000" }',
          'borrador que no es JSON {',
          '',
        ];
        const created = await store.saveDiagram(project.id, { module: 'c4', name: 'D', text: texts[0] });
        for (const text of texts) {
          await store.saveDiagram(project.id, { id: created.id, text });
          const read = (await store.getDiagram(project.id, created.id))!.text;
          expect(read).toBe(text);
          expect(Buffer.from(read, 'utf8').equals(Buffer.from(text, 'utf8'))).toBe(true);
        }
        // el hash del historial es el del texto original, no el de una versión normalizada
        const versions = await (store as VersionedProjectStore).listVersions(project.id, created.id);
        for (const v of versions) expect(v.hash).toBe(describeContent((await (store as VersionedProjectStore).getVersion(project.id, created.id, v.id))!.text).hash);
        expect(versions[0].hash).toBe(describeContent('').hash);
      }));

    it('el tamaño y el hash coinciden con los del núcleo, también con caracteres que UTF-8 no puede representar', () =>
      withStore({ versions: { coalesceSeconds: 0 } }, async ({ store }) => {
        const project = await store.createProject({ name: 'Hash' });
        const odd = 'sustituto suelto \ud800 y otro \udfff, acentos áéí, emoji 😀';
        const created = await store.saveDiagram(project.id, { module: 'c4', name: 'D', text: odd });
        const [version] = await (store as VersionedProjectStore).listVersions(project.id, created.id);
        expect(version).toMatchObject({ size: describeContent(odd).size, hash: describeContent(odd).hash });
      }));

    it('rechaza el carácter NUL (que `text` de Postgres no admite) y lo que pasa del máximo, sin guardar nada', () =>
      withStore({}, async ({ store }) => {
        const project = await store.createProject({ name: 'Límites' });
        const created = await store.saveDiagram(project.id, { module: 'c4', name: 'D', text: 'ok' });
        await rejects(store.saveDiagram(project.id, { id: created.id, text: 'a\u0000b' }), 'invalid');
        await rejects(store.saveDiagram(project.id, { module: 'c4', name: 'Otro', text: '\u0000' }), 'invalid');
        await rejects(store.saveDiagram(project.id, { id: created.id, text: 'x'.repeat(MAX_DOCUMENT_BYTES + 1) }), 'invalid');
        await rejects(store.saveDiagram(project.id, { id: created.id, text: 5 as unknown as string }), 'invalid');
        expect((await store.getDiagram(project.id, created.id))?.text).toBe('ok');
        expect((await store.getProject(project.id))!.diagrams).toHaveLength(1);
      }));

    it('un documento grande (varios megabytes) se guarda, se lee y se cuenta sin alterarse', () =>
      withStore({ versions: { coalesceSeconds: 0 } }, async ({ store }) => {
        const project = await store.createProject({ name: 'Grande' });
        const big = JSON.stringify({ filas: Array.from({ length: 60_000 }, (_, i) => ({ i, texto: `línea ${i} — ñandú` })) });
        expect(Buffer.byteLength(big)).toBeGreaterThan(2 * 1024 * 1024);
        const created = await store.saveDiagram(project.id, { module: 'data', name: 'Enorme', text: big });
        expect((await store.getDiagram(project.id, created.id))?.text).toBe(big);
        expect(await store.documentUsage(project.id)).toEqual({ diagrams: 1, bytes: Buffer.byteLength(big) });
        expect(await store.versionUsage(project.id)).toEqual({ versions: 1, bytes: Buffer.byteLength(big) });
      }));
  });

  // ───────────── ids, nombres y fechas ─────────────

  describe('ids, nombres y fechas', () => {
    it('los ids salen del nombre, son válidos en el espacio de trabajo, no se repiten y no se reutilizan nombres reservados', () =>
      withStore({}, async ({ store }) => {
        const a = await store.createProject({ name: 'Tienda web' });
        const b = await store.createProject({ name: 'Tienda-Web!' }); // otro nombre, el mismo texto base
        const c = await store.createProject({ name: 'con' }); // reservado en Windows: no vale como id de carpeta
        const d = await store.createProject({ name: '✓✓' });
        expect([a.id, b.id, c.id, d.id]).toEqual(['tienda-web', 'tienda-web-2', 'con-2', 'proyecto']);
        for (const id of [a.id, b.id, c.id, d.id]) expect(isWorkspaceId(id)).toBe(true);
        const x = await store.saveDiagram(a.id, { module: 'c4', name: 'Vista general', text: '{}' });
        const y = await store.saveDiagram(a.id, { module: 'c4', name: 'Vista-General!', text: '{}' });
        expect([x.id, y.id]).toEqual(['vista-general', 'vista-general-2']);
        // un id que ya no existe puede volver a salir; el nombre reservado de un diagrama también se salta
        await store.deleteDiagram(a.id, x.id);
        expect((await store.saveDiagram(a.id, { module: 'c4', name: 'aux', text: '{}' })).id).toBe('aux-2');
      }));

    it('un id que no es válido (rutas, separadores) se rechaza al escribir y no existe al leer', () =>
      withStore({}, async ({ store }) => {
        const project = await store.createProject({ name: 'Ids' });
        for (const bad of ['../x', 'a/b', '', ' ', 'a b', '.oculto', 'x'.repeat(200)]) {
          await rejects(store.renameProject(bad, 'Otro'), 'invalid');
          await rejects(store.deleteProject(bad), 'invalid');
          await rejects(store.saveDiagram(bad, { module: 'c4', text: '{}' }), 'invalid');
          await rejects(store.saveDiagram(project.id, { id: bad, text: '{}' }), 'invalid');
          expect(await store.getProject(bad)).toBeUndefined();
          expect(await store.getDiagram(project.id, bad)).toBeUndefined();
        }
        await rejects(store.getDiagram('../x', 'a'), 'not-found');
      }));

    it('los nombres se comparan sin distinguir mayúsculas ni normalización Unicode', () =>
      withStore({}, async ({ store }) => {
        await store.createProject({ name: 'Ñandú' });
        await rejects(store.createProject({ name: 'ñANDÚ' }), 'exists');
        await rejects(store.createProject({ name: 'Ñandú' }), 'exists'); // la misma palabra con tildes combinadas
      }));

    it('updatedAt crece en cada guardado aunque el reloj no avance, y lo que devuelve guardar es lo que se lee', () =>
      withStore({ clock: () => new Date('2030-01-01T00:00:00.000Z') }, async ({ store }) => {
        const project = await store.createProject({ name: 'Reloj parado' });
        const created = await store.saveDiagram(project.id, { module: 'c4', name: 'D', text: '0' });
        let previous = created;
        for (const text of ['1', '2', '3', '4']) {
          const next = await store.saveDiagram(project.id, { id: created.id, text, ifUpdatedAt: previous.updatedAt });
          expect(next.updatedAt > previous.updatedAt).toBe(true);
          expect((await store.getDiagram(project.id, created.id))?.updatedAt).toBe(next.updatedAt);
          expect((await store.getProject(project.id))!.diagrams[0].updatedAt).toBe(next.updatedAt);
          previous = next;
        }
        expect((await store.getProject(project.id))!.updatedAt).toBe(previous.updatedAt); // la del proyecto sigue a la de sus diagramas
      }));

    it('la fecha del proyecto crece al crear, renombrar y borrar diagramas, y renombrar un diagrama no cambia la del diagrama', () =>
      withStore({ clock: () => new Date('2030-01-01T00:00:00.000Z') }, async ({ store }) => {
        const project = await store.createProject({ name: 'Fechas' });
        const seen = [project.updatedAt];
        const a = await store.saveDiagram(project.id, { module: 'c4', name: 'A', text: '1' });
        seen.push((await store.getProject(project.id))!.updatedAt);
        const renamed = await store.renameDiagram(project.id, a.id, 'A2');
        expect(renamed.updatedAt).toBe(a.updatedAt);
        seen.push((await store.getProject(project.id))!.updatedAt);
        await store.deleteDiagram(project.id, a.id);
        seen.push((await store.getProject(project.id))!.updatedAt);
        seen.push((await store.renameProject(project.id, 'Fechas 2')).updatedAt);
        for (let i = 1; i < seen.length; i++) expect(seen[i] > seen[i - 1], `${i}: ${seen.join(' < ')}`).toBe(true);
      }));
  });

  // ───────────── cuotas ─────────────

  describe('uso para las cuotas', () => {
    it('documentUsage y versionUsage cuentan bytes UTF-8 de verdad y siguen a guardar, nombrar, borrar y rotar', () =>
      withStore({ versions: { coalesceSeconds: 0, keepAutomatic: 3, maxVersions: 5 } }, async ({ store }) => {
        const project = await store.createProject({ name: 'Cuotas' });
        expect(await store.documentUsage(project.id)).toEqual({ diagrams: 0, bytes: 0 });
        expect(await store.versionUsage(project.id)).toEqual({ versions: 0, bytes: 0 });
        const a = await store.saveDiagram(project.id, { module: 'c4', name: 'A', text: 'ñandú' }); // 7 bytes
        await store.saveDiagram(project.id, { module: 'data', name: 'B', text: '日本' }); // 6 bytes
        expect(await store.documentUsage(project.id)).toEqual({ diagrams: 2, bytes: 13 });
        expect(await store.versionUsage(project.id)).toEqual({ versions: 2, bytes: 13 });
        for (const text of ['uno', 'dos', 'tres', 'cuatro']) await store.saveDiagram(project.id, { id: a.id, text });
        // A: la rotación deja 3 automáticas (dos, tres, cuatro) + B: 1 → 4 versiones
        expect(await store.documentUsage(project.id)).toEqual({ diagrams: 2, bytes: 6 + 6 });
        expect(await store.versionUsage(project.id)).toEqual({ versions: 4, bytes: 3 + 4 + 6 + 6 });
        await store.deleteDiagram(project.id, a.id);
        expect(await store.documentUsage(project.id)).toEqual({ diagrams: 1, bytes: 6 });
        expect(await store.versionUsage(project.id)).toEqual({ versions: 1, bytes: 6 });
        await rejects(store.documentUsage('no-existe'), 'not-found');
        await rejects(store.versionUsage('no-existe'), 'not-found');
      }));

    it('sin historial (`versions: false`) el almacén lo dice, no guarda versiones y cuenta solo los documentos', () =>
      withStore({ versions: false }, async ({ store }) => {
        expect(store.keepsVersions).toBe(false);
        const project = await store.createProject({ name: 'Sin historial' });
        const d = await store.saveDiagram(project.id, { module: 'c4', name: 'D', text: 'abc' });
        await store.saveDiagram(project.id, { id: d.id, text: 'abcd' });
        const versioned = store as unknown as VersionedProjectStore;
        await rejects(versioned.listVersions(project.id, d.id), 'unsupported');
        await rejects(versioned.getVersion(project.id, d.id, 1), 'unsupported');
        await rejects(versioned.restoreVersion(project.id, d.id, 1), 'unsupported');
        await rejects(store.versionUsage(project.id), 'unsupported');
        expect(await store.documentUsage(project.id)).toEqual({ diagrams: 1, bytes: 4 });
      }));
  });

  // ───────────── una transacción por operación ─────────────

  describe('atomicidad', () => {
    it('si algo falla a mitad de un guardado (al anotar la versión) no cambia el diagrama ni el historial', () =>
      withStore({ versions: { coalesceSeconds: 0 } }, async ({ db, store }) => {
        const project = await store.createProject({ name: 'Atómico' });
        const d = await store.saveDiagram(project.id, { module: 'c4', name: 'D', text: 'bueno' });
        const before = await store.getDiagram(project.id, d.id);
        // un disparador que hace fallar justo la inserción de la versión del documento 'FALLA'
        await db.query(`create function ${db.schemaQuoted}.falla() returns trigger language plpgsql as $$ begin if new.documento = 'FALLA' then raise exception 'fallo provocado'; end if; return new; end $$`);
        await db.query(`create trigger falla before insert on ${db.schemaQuoted}.versiones for each row execute function ${db.schemaQuoted}.falla()`);
        await expect(store.saveDiagram(project.id, { id: d.id, text: 'FALLA' })).rejects.toThrow(/fallo provocado/);
        expect(await store.getDiagram(project.id, d.id)).toEqual(before);
        expect((await store.listVersions(project.id, d.id) as { id: number }[]).map((v) => v.id)).toEqual([1]);
        // lo mismo al crear: no queda el diagrama a medias
        await expect(store.saveDiagram(project.id, { module: 'c4', name: 'Nuevo', text: 'FALLA' })).rejects.toThrow(/fallo provocado/);
        expect((await store.getProject(project.id))!.diagrams.map((x) => x.name)).toEqual(['D']);
        // y el siguiente guardado normal sigue su camino (sin huecos raros en los ids)
        await store.saveDiagram(project.id, { id: d.id, text: 'otro' });
        expect((await store.listVersions(project.id, d.id) as { id: number }[]).map((v) => v.id)).toEqual([2, 1]);
      }));
  });

  // ───────────── concurrencia entre procesos ─────────────

  describe('concurrencia (dos conexiones, como dos procesos)', () => {
    it('guardados simultáneos con la misma marca: uno gana y el resto es conflicto, sin versiones perdidas ni repetidas', () =>
      withStore({ versions: { coalesceSeconds: 0 } }, async (ctx) => {
        const other = await ctx.second();
        const stores = [ctx.store, other];
        const project = await ctx.store.createProject({ name: 'Carrera' });
        const d = await ctx.store.saveDiagram(project.id, { module: 'c4', name: 'D', text: 'inicio' });
        for (let round = 1; round <= 6; round++) {
          const current = (await ctx.store.getDiagram(project.id, d.id))!.updatedAt;
          const attempts = Array.from({ length: 8 }, (_, i) => stores[i % 2].saveDiagram(project.id, { id: d.id, text: `ronda ${round} intento ${i}`, ifUpdatedAt: current, by: `@p${i}` }).then((meta) => ({ ok: true as const, i, meta })));
          const settled = await Promise.allSettled(attempts);
          const winners = settled.filter((s) => s.status === 'fulfilled');
          const losers = settled.filter((s) => s.status === 'rejected');
          expect(winners, `ronda ${round}: ${JSON.stringify(settled.map((s) => s.status))}`).toHaveLength(1);
          for (const l of losers) expect((l as PromiseRejectedResult).reason).toMatchObject({ name: 'ProjectError', code: 'conflict' });
          const winner = (winners[0] as PromiseFulfilledResult<{ i: number }>).value;
          expect((await ctx.store.getDiagram(project.id, d.id))!.text).toBe(`ronda ${round} intento ${winner.i}`);
        }
        // una versión por guardado que ganó, ids consecutivos y ninguna repetida
        const versions = await ctx.store.listVersions(project.id, d.id) as { id: number; savedBy?: string }[];
        expect(versions.map((v) => v.id)).toEqual([7, 6, 5, 4, 3, 2, 1]);
      }));

    it('guardados simultáneos SIN marca no se pierden: todos se aplican, uno tras otro, y cada uno deja su versión', () =>
      withStore({ versions: { coalesceSeconds: 0 } }, async (ctx) => {
        const other = await ctx.second();
        const project = await ctx.store.createProject({ name: 'Todos' });
        const d = await ctx.store.saveDiagram(project.id, { module: 'c4', name: 'D', text: 'inicio' });
        const texts = Array.from({ length: 12 }, (_, i) => `texto ${i}`);
        const metas = await Promise.all(texts.map((text, i) => (i % 2 ? other : ctx.store).saveDiagram(project.id, { id: d.id, text })));
        expect(new Set(metas.map((m) => m.updatedAt)).size).toBe(12); // marcas distintas
        const versions = await ctx.store.listVersions(project.id, d.id);
        expect(versions.map((v) => v.id)).toEqual(Array.from({ length: 13 }, (_, i) => 13 - i));
        expect(new Set(versions.map((v) => v.hash)).size).toBe(13);
        expect(texts).toContain((await ctx.store.getDiagram(project.id, d.id))!.text);
      }));

    it('altas simultáneas de proyectos con el mismo nombre: una sola entra; con nombres distintos del mismo texto base, ids distintos', () =>
      withStore({}, async (ctx) => {
        const other = await ctx.second();
        const same = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => (i % 2 ? other : ctx.store).createProject({ name: i % 3 === 0 ? 'Tienda' : 'TIENDA' })));
        expect(same.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
        for (const s of same.filter((r) => r.status === 'rejected')) expect((s as PromiseRejectedResult).reason).toMatchObject({ code: 'exists' });
        const distinct = await Promise.all(['Banca web', 'banca-web', 'Banca_web', 'BANCA  web!'].map((name, i) => (i % 2 ? other : ctx.store).createProject({ name }).catch((e: unknown) => e)));
        const created = distinct.filter((r): r is Awaited<ReturnType<typeof ctx.store.createProject>> => !(r instanceof Error));
        // 'Banca web' y 'BANCA  web!' se llaman distinto pero comparten la base del id; los ids no se repiten
        expect(new Set(created.map((p) => p.id)).size).toBe(created.length);
        expect(created.length).toBe(4);
        expect(new Set((await ctx.store.listProjects()).map((p) => p.id)).size).toBe(5);
      }));

    it('altas simultáneas de diagramas en un proyecto: ids distintos, y el mismo nombre solo una vez', () =>
      withStore({}, async (ctx) => {
        const other = await ctx.second();
        const project = await ctx.store.createProject({ name: 'Altas' });
        const names = ['Vista general', 'vista-general', 'Vista_general', 'Vista   general!', 'Otra', 'OTRA'];
        const results = await Promise.allSettled(names.map((name, i) => (i % 2 ? other : ctx.store).saveDiagram(project.id, { module: 'c4', name, text: '{}' })));
        const ok = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
        const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
        expect(ok.map((d) => d.name.toLowerCase()).sort()).toEqual(['otra', 'vista general', 'vista general!', 'vista_general', 'vista-general'].sort());
        expect(failed).toHaveLength(1);
        expect(failed[0].reason).toMatchObject({ code: 'exists' });
        expect(new Set(ok.map((d) => d.id)).size).toBe(ok.length);
        expect((await ctx.store.getProject(project.id))!.diagrams).toHaveLength(ok.length);
      }));

    it('guardar diagramas distintos del mismo proyecto a la vez no se bloquea ni se mezcla', () =>
      withStore({ versions: { coalesceSeconds: 0 } }, async (ctx) => {
        const other = await ctx.second();
        const project = await ctx.store.createProject({ name: 'Paralelo' });
        const diagrams = await Promise.all(Array.from({ length: 6 }, (_, i) => ctx.store.saveDiagram(project.id, { module: 'c4', name: `D${i}`, text: `d${i}-0` })));
        await Promise.all(
          diagrams.map(async (d, i) => {
            const store = i % 2 ? other : ctx.store;
            let last = d.updatedAt;
            for (let n = 1; n <= 4; n++) last = (await store.saveDiagram(project.id, { id: d.id, text: `d${i}-${n}`, ifUpdatedAt: last })).updatedAt;
          }),
        );
        for (const [i, d] of diagrams.entries()) {
          expect((await ctx.store.getDiagram(project.id, d.id))!.text).toBe(`d${i}-4`);
          expect((await ctx.store.listVersions(project.id, d.id) as { id: number }[]).map((v) => v.id)).toEqual([5, 4, 3, 2, 1]);
        }
      }));

    it('dos nombrados de versión a la vez no pasan del máximo de versiones con nombre', () =>
      withStore({ versions: { coalesceSeconds: 0, keepAutomatic: 2, maxVersions: 3 } }, async (ctx) => {
        const other = await ctx.second();
        const project = await ctx.store.createProject({ name: 'Nombradas' });
        const d = await ctx.store.saveDiagram(project.id, { module: 'c4', name: 'D', text: 'uno' });
        await ctx.store.saveDiagram(project.id, { id: d.id, text: 'dos' });
        // caben 3 - 2 = 1 con nombre: de dos nombres simultáneos, uno entra y el otro es `limit`
        const settled = await Promise.allSettled([ctx.store.labelVersion(project.id, d.id, 1, 'Primera'), other.labelVersion(project.id, d.id, 2, 'Segunda')]);
        expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
        const rejected = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult;
        expect(rejected.reason).toMatchObject({ code: 'invalid', info: { serverCode: 'limit' } });
        expect((await ctx.store.listVersions(project.id, d.id)).filter((v) => v.label !== undefined)).toHaveLength(1);
      }));

    it('restaurar y guardar a la vez con la misma marca: uno solo gana', () =>
      withStore({ versions: { coalesceSeconds: 0 } }, async (ctx) => {
        const other = await ctx.second();
        const project = await ctx.store.createProject({ name: 'Restaurar' });
        const first = await ctx.store.saveDiagram(project.id, { module: 'c4', name: 'D', text: 'bueno' });
        const second = await ctx.store.saveDiagram(project.id, { id: first.id, text: 'malo' });
        const settled = await Promise.allSettled([
          ctx.store.restoreVersion(project.id, first.id, 1, { ifUpdatedAt: second.updatedAt }),
          other.saveDiagram(project.id, { id: first.id, text: 'otro', ifUpdatedAt: second.updatedAt }),
        ]);
        expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
        expect(((settled.find((s) => s.status === 'rejected') as PromiseRejectedResult).reason as ProjectError).code).toBe('conflict');
        expect(['bueno', 'otro']).toContain((await ctx.store.getDiagram(project.id, first.id))!.text);
      }));

    it('borrar un proyecto mientras se guarda en él: cada guardado o entra o es not-found, y no quedan filas huérfanas', () =>
      withStore({ versions: { coalesceSeconds: 0 } }, async (ctx) => {
        const other = await ctx.second();
        const project = await ctx.store.createProject({ name: 'Efímero' });
        const d = await ctx.store.saveDiagram(project.id, { module: 'c4', name: 'D', text: '0' });
        const settled = await Promise.allSettled([
          ...Array.from({ length: 8 }, (_, i) => other.saveDiagram(project.id, { id: d.id, text: `t${i}` })),
          ctx.store.saveDiagram(project.id, { module: 'c4', name: 'Nuevo', text: 'x' }),
          ctx.store.deleteProject(project.id),
        ]);
        for (const s of settled) if (s.status === 'rejected') expect(s.reason).toMatchObject({ name: 'ProjectError', code: 'not-found' });
        expect(await ctx.store.getProject(project.id)).toBeUndefined();
        for (const table of ['proyectos', 'diagramas', 'versiones']) {
          expect(await ctx.db.query(`select 1 from ${ctx.db.table(table)}`), table).toEqual([]);
        }
      }));
  });

  // ───────────── errores de red ─────────────

  describe('errores de la base', () => {
    it.skipIf(Boolean(process.env.IARK_TEST_DATABASE_URL))('si la base se cae, los errores son `unavailable`, dicen a qué servidor y NUNCA llevan la contraseña', async () => {
      const dedicated = await startTestPostgres();
      const secret = 's3cr3t-clave-9f2';
      const url = dedicated.url.replace('postgres@', `postgres:${secret}@`);
      const db = await PostgresDatabase.connect(testConfig(url), () => undefined);
      let stopped = false;
      try {
        const store = await PostgresProjectStore.open(db);
        const project = await store.createProject({ name: 'Antes de la caída' });
        expect(await store.ping()).toBe(true);
        await dedicated.stop();
        stopped = true;
        const calls: Array<() => Promise<unknown>> = [
          () => store.listProjects(),
          () => store.getProject(project.id),
          () => store.createProject({ name: 'Después' }),
          () => store.saveDiagram(project.id, { module: 'c4', name: 'D', text: '{}' }),
          () => store.documentUsage(project.id),
        ];
        for (const call of calls) {
          const error = (await call().then(
            () => undefined,
            (e: unknown) => e,
          )) as ProjectError;
          expect(error).toBeInstanceOf(ProjectError);
          expect(error.code).toBe('unavailable');
          for (const text of [error.message, String(error.stack), JSON.stringify(error), JSON.stringify(error.info)]) {
            expect(text).not.toContain(secret);
            expect(text).not.toMatch(/postgres:\/\/[^@\s]*:[^@\s]*@/); // ninguna cadena de conexión con usuario Y clave
          }
          expect(error.message).toContain('127.0.0.1'); // pero sí dice a qué servidor
        }
        expect(await store.ping()).toBe(false);
      } finally {
        await db.close().catch(() => undefined);
        if (!stopped) await dedicated.stop();
      }
    }, 60_000);
  });

  // ───────────── la misma semántica que la memoria, guardado a guardado ─────────────

  describe('equivalencia con el almacén de memoria (la referencia del contrato)', () => {
    /** Un generador pseudoaleatorio con semilla: la secuencia es siempre la misma. */
    const random = (seed: number) => () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };

    const run = async (seed: number, policy: Partial<VersionPolicy>) => {
      const clockA = testClock();
      const clockB = testClock();
      const memory = new MemoryProjectStore(() => clockA.now(), { versions: policy });
      const ctx = await open({ versions: policy, clock: () => clockB.now() });
      try {
        const pg = ctx.store;
        const rnd = random(seed);
        const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)];
        const pm = await memory.createProject({ name: 'P' });
        const pp = await pg.createProject({ name: 'P' });
        const dm = await memory.saveDiagram(pm.id, { module: 'c4', name: 'D', text: 't0', by: '@ana' });
        const dp = await pg.saveDiagram(pp.id, { module: 'c4', name: 'D', text: 't0', by: '@ana' });
        const both = async <T>(fn: (store: ProjectStore, p: string, d: string) => Promise<T>) => {
          const outcome = async (store: ProjectStore, p: string, d: string) => fn(store, p, d).then((value) => ({ value }), (error: unknown) => ({ error: error instanceof ProjectError ? `${error.code}:${error.info.reason ?? ''}` : String(error) }));
          const [a, b] = await Promise.all([outcome(memory, pm.id, dm.id), outcome(pg, pp.id, dp.id)]);
          return { a, b };
        };
        // los ids de diagrama los elige cada almacén a su manera (la memoria usa un contador) y las fechas dependen del reloj de cada uno
        const strip = (value: unknown): unknown =>
          JSON.parse(
            JSON.stringify(value, (key, v: unknown) => {
              if (key === 'savedAt' || key === 'createdAt' || key === 'updatedAt') return undefined;
              if (v && typeof v === 'object' && 'module' in v && 'id' in v) return { ...(v as object), id: undefined };
              return v;
            }),
          );
        for (let step = 0; step < 120; step++) {
          const dt = pick([0, 0, 3_000, 20_000, 45_000, 120_000]);
          clockA.advance(dt);
          clockB.advance(dt);
          const versions = ((await memory.listVersions(pm.id, dm.id)) as { id: number }[]).map((v) => v.id);
          const op = pick(['save', 'save', 'save', 'same', 'label', 'delete', 'restore', 'conflict'] as const);
          const text = `t${Math.floor(rnd() * 6)}`;
          const by = pick([undefined, '@ana', '@ana', '@beto']);
          const id = pick([...versions, 99]);
          const label = pick(['A', 'B', 'C', 'D']);
          let result;
          if (op === 'save') result = await both((s, p, d) => s.saveDiagram(p, { id: d, text, by }));
          else if (op === 'same') result = await both(async (s, p, d) => s.saveDiagram(p, { id: d, text: (await s.getDiagram(p, d))!.text, by }));
          else if (op === 'label') result = await both((s, p, d) => (s as VersionedProjectStore).labelVersion(p, d, id, label));
          else if (op === 'delete') result = await both((s, p, d) => (s as VersionedProjectStore).deleteVersion(p, d, id));
          else if (op === 'restore') result = await both((s, p, d) => (s as VersionedProjectStore).restoreVersion(p, d, id, { by }));
          else result = await both((s, p, d) => s.saveDiagram(p, { id: d, text, ifUpdatedAt: '2000-01-01T00:00:00.000Z' }));
          expect(strip(result.b), `paso ${step} (${op})`).toEqual(strip(result.a));
          const [la, lb] = [await memory.listVersions(pm.id, dm.id), await pg.listVersions(pp.id, dp.id)];
          expect(strip(lb), `historial tras el paso ${step} (${op})`).toEqual(strip(la));
          expect((await pg.getDiagram(pp.id, dp.id))!.text).toBe((await memory.getDiagram(pm.id, dm.id))!.text);
        }
        expect(await pg.versionUsage(pp.id)).toEqual(await memory.versionUsage(pm.id));
      } finally {
        await ctx.drop();
      }
    };

    it.each([
      [1, { coalesceSeconds: 30, keepAutomatic: 4, maxVersions: 6 }],
      [2, { coalesceSeconds: 30, keepAutomatic: 3, maxVersions: 5 }],
      [3, { coalesceSeconds: 0, keepAutomatic: 5, maxVersions: 8 }],
      [4, { coalesceSeconds: 120, keepAutomatic: 2, maxVersions: 3 }],
    ] as const)('120 operaciones al azar (semilla %i) dan los mismos resultados y el mismo historial', (seed, policy) => run(seed, policy), 120_000);
  });

  // ───────────── importar con ids ─────────────

  describe('importProject', () => {
    const sample = (overrides: Partial<Parameters<PostgresProjectStore['importProject']>[0]> = {}) => ({
      id: 'Tienda',
      name: 'Tienda web',
      description: 'Pedidos',
      createdAt: '2025-01-02T03:04:05.000Z',
      updatedAt: '2025-06-07T08:09:10.000Z',
      diagrams: [
        {
          id: 'contexto',
          module: 'c4',
          name: 'Contexto',
          text: '{"v":2}',
          createdAt: '2025-01-02T03:04:06.000Z',
          updatedAt: '2025-06-07T08:09:10.000Z',
          versions: [
            { id: 4, savedAt: '2025-06-07T08:09:10.000Z', savedBy: '@ana', size: 7, hash: describeContent('{"v":2}').hash, text: '{"v":2}' },
            { id: 2, savedAt: '2025-03-01T00:00:00.000Z', label: 'Entrega 1', size: 7, hash: describeContent('{"v":1}').hash, text: '{"v":1}' },
          ],
        },
        { id: 'ventas', module: 'data', name: 'ventas', text: 'borrador {', createdAt: '2025-01-03T00:00:00.000Z', updatedAt: '2025-01-03T00:00:00.000Z' },
        { id: 'ventas-2', module: 'data', name: 'VENTAS', text: '{}', createdAt: '2025-01-03T00:00:00.000Z', updatedAt: '2025-01-03T00:00:00.000Z' },
      ],
      ...overrides,
    });

    it('conserva ids, fechas, documentos y el historial con sus ids, y el contador sigue desde el mayor', () =>
      withStore({ versions: { coalesceSeconds: 0 }, clock: () => new Date('2030-01-01T00:00:00.000Z') }, async ({ store }) => {
        const outcome = await store.importProject(sample());
        expect(outcome).toEqual({ status: 'imported', diagrams: 3, versions: 2, renamed: ['ventas-2: «VENTAS» → «VENTAS (2)»'] });
        const project = (await store.getProject('Tienda'))!;
        expect(project).toMatchObject({ id: 'Tienda', name: 'Tienda web', description: 'Pedidos', createdAt: '2025-01-02T03:04:05.000Z', updatedAt: '2025-06-07T08:09:10.000Z' });
        expect(project.diagrams.map((d) => d.id).sort()).toEqual(['contexto', 'ventas', 'ventas-2']);
        expect(await store.getDiagram('Tienda', 'contexto')).toMatchObject({ text: '{"v":2}', createdAt: '2025-01-02T03:04:06.000Z', updatedAt: '2025-06-07T08:09:10.000Z' });
        expect((await store.listVersions('Tienda', 'contexto')).map((v) => [v.id, v.label, v.savedBy])).toEqual([
          [4, undefined, '@ana'],
          [2, 'Entrega 1', undefined],
        ]);
        expect((await store.getVersion('Tienda', 'contexto', 2))?.text).toBe('{"v":1}');
        await store.saveDiagram('Tienda', { id: 'contexto', text: '{"v":3}' });
        expect((await store.listVersions('Tienda', 'contexto')).map((v) => v.id)).toEqual([5, 4, 2]);
        expect(await store.documentUsage('Tienda')).toEqual({ diagrams: 3, bytes: 7 + 10 + 2 });
      }));

    it('no pisa lo que ya existe (mismo id, o mismo nombre con otro id) salvo con `replace`, que lo reemplaza entero', () =>
      withStore({}, async ({ store }) => {
        expect(await store.importProject(sample())).toMatchObject({ status: 'imported' });
        await store.saveDiagram('Tienda', { module: 'c4', name: 'Añadido luego', text: '{}' });
        expect(await store.importProject(sample())).toEqual({ status: 'exists' });
        expect(await store.importProject(sample({ id: 'tienda' }))).toEqual({ status: 'exists' }); // el id se compara sin distinguir mayúsculas
        expect(await store.importProject(sample({ id: 'otra' }))).toEqual({ status: 'name-taken', id: 'Tienda' });
        expect((await store.getProject('Tienda'))!.diagrams).toHaveLength(4); // nada cambió
        expect(await store.importProject(sample(), { replace: true })).toMatchObject({ status: 'imported' });
        expect((await store.getProject('Tienda'))!.diagrams).toHaveLength(3); // el diagrama añadido a mano ya no está: se reemplazó el proyecto
        expect((await store.listProjects()).map((p) => p.id)).toEqual(['Tienda']);
      }));

    it('un proyecto con algo inválido no entra, ni a medias', () =>
      withStore({}, async ({ store }) => {
        const bad = sample();
        bad.diagrams[1] = { ...bad.diagrams[1], text: 'con\u0000nul' };
        await rejects(store.importProject(bad), 'invalid');
        expect(await store.listProjects()).toEqual([]);
        await rejects(store.importProject(sample({ id: '../x' })), 'invalid');
        await rejects(store.importProject(sample({ createdAt: 'ayer' })), 'invalid');
      }));
  });

  it('ping contesta mientras la base está viva', () =>
    withStore({}, async ({ store }) => {
      expect(await store.ping()).toBe(true);
      expect(store.kind).toBe('postgres');
      expect(store.description).toMatch(/^Postgres postgres:\/\/postgres@127\.0\.0\.1:\d+\/postgres, esquema t_/);
    }));
});
