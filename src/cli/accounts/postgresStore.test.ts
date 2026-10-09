import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { accountStoreContract } from '../../../tests/helpers/accountStoreContract';
import { postgresAvailable, requirePostgresIfCi, startTestPostgres, testConfig, uniqueSchema, type TestPostgres } from '../../../tests/helpers/postgres';
import { PostgresDatabase } from '../postgres/pool';
import { accountHttpError } from './errors';
import { MAX_MEMBERS_PER_PROJECT, MAX_PENDING_USERS, MAX_SESSIONS_PER_USER, SESSION_PREFIX, AccountError } from './model';
import { PostgresAccountStore } from './postgresStore';

requirePostgresIfCi();

// El contrato de `AccountStore` (el mismo que cumplen JSON y SQLite) contra un Postgres de verdad. La ruta que genera el contrato identifica el esquema de
// prueba: volver a abrir la misma ruta es volver a las mismas tablas (un reinicio del servicio).
describe.skipIf(!postgresAvailable())('PostgresAccountStore', () => {
  let server: TestPostgres;
  const schemas = new Map<string, string>();
  beforeAll(async () => {
    server = await startTestPostgres();
  }, 120_000);
  afterAll(async () => {
    if (server) {
      const admin = await PostgresDatabase.connect(testConfig(server.url));
      try {
        for (const schema of schemas.values()) await admin.query(`drop schema if exists "${schema}" cascade`);
      } finally {
        await admin.close();
      }
    }
    await server?.stop();
  });

  accountStoreContract('postgres', {
    fileName: 'cuentas',
    open: async (path, options) => {
      const schema = schemas.get(path) ?? uniqueSchema();
      schemas.set(path, schema);
      const db = await PostgresDatabase.connect(testConfig(server.url, schema));
      return PostgresAccountStore.open(db, { ...options, release: () => db.close() });
    },
  });

  // ───── lo propio de Postgres: varias conexiones a la vez, el candado, lo que se guarda y los fallos de la base ─────
  describe('varias conexiones sobre las mismas tablas', () => {
    const OPEN = { signup: 'open', admin: false } as const;
    const open: PostgresAccountStore[] = [];
    const dbs: PostgresDatabase[] = [];
    afterEach(async () => {
      for (const store of open.splice(0)) await store.close().catch(() => undefined);
      dbs.length = 0;
    });
    /** `count` almacenes, cada uno con su propio pool (su propia conexión a la base), sobre un esquema nuevo que comparten. */
    async function shared(count: number): Promise<{ stores: PostgresAccountStore[]; db: PostgresDatabase; schema: string }> {
      const schema = uniqueSchema();
      schemas.set(schema, schema);
      const stores: PostgresAccountStore[] = [];
      for (let i = 0; i < count; i++) {
        const db = await PostgresDatabase.connect(testConfig(server.url, schema, { IARK_DATABASE_POOL: '4' }));
        dbs.push(db);
        const store = await PostgresAccountStore.open(db, { release: () => db.close() });
        stores.push(store);
        open.push(store);
      }
      return { stores, db: dbs[0]!, schema };
    }
    const codes = (results: PromiseSettledResult<unknown>[]): string[] => results.map((r) => (r.status === 'fulfilled' ? 'ok' : r.reason instanceof AccountError ? r.reason.code : `inesperado: ${String(r.reason)}`)).sort();
    const n = async (db: PostgresDatabase, sql: string): Promise<number> => Number((await db.query<{ n: string }>(sql))[0]?.n);

    it('el tope de miembros de un proyecto lo disputan seis conexiones por la última plaza: entra una y las demás reciben «limit»', async () => {
      const { stores, db } = await shared(6);
      const [first] = stores;
      const ana = await first.signIn({ id: 1, login: 'ana' }, OPEN);
      await first.registerProject('tienda', ana.id);
      // 98 más por SQL (con ana, 99 de 100): rellenar de una en una por el almacén sería lo mismo, más lento
      await db.query(`insert into ${db.table('cuentas_users')} (id, login, login_key, site_role, created_at, github_id) select 'u_r' || g, 'relleno' || g, 'relleno' || g, 'member', now(), 1000 + g from generate_series(1, ${MAX_MEMBERS_PER_PROJECT - 2}) g`);
      await db.query(`insert into ${db.table('cuentas_members')} (project_id, user_id, role, added_at) select 'tienda', 'u_r' || g, 'viewer', now() from generate_series(1, ${MAX_MEMBERS_PER_PROJECT - 2}) g`);
      expect(await n(db, `select count(*) as n from ${db.table('cuentas_members')} where project_id = 'tienda'`)).toBe(MAX_MEMBERS_PER_PROJECT - 1);

      const results = await Promise.allSettled(stores.map((store, i) => store.shareProject('tienda', `nueva${i}`, 'viewer', 'guest')));
      expect(codes(results)).toEqual(['limit', 'limit', 'limit', 'limit', 'limit', 'ok']);
      expect(await n(db, `select count(*) as n from ${db.table('cuentas_members')} where project_id = 'tienda'`)).toBe(MAX_MEMBERS_PER_PROJECT);
    });

    it('el tope de invitaciones sin aceptar lo disputan seis conexiones por las últimas plazas: ni una más', async () => {
      const { stores, db } = await shared(6);
      await db.query(`insert into ${db.table('cuentas_users')} (id, login, login_key, site_role, created_at) select 'u_p' || g, 'pend' || g, 'pend' || g, 'guest', now() from generate_series(1, ${MAX_PENDING_USERS - 3}) g`);
      const results = await Promise.allSettled(stores.map((store, i) => store.invite(`otra${i}`, 'guest')));
      expect(codes(results)).toEqual(['limit', 'limit', 'limit', 'ok', 'ok', 'ok']);
      expect(await n(db, `select count(*) as n from ${db.table('cuentas_users')} where github_id is null`)).toBe(MAX_PENDING_USERS);
    });

    it('el tope de sesiones de una cuenta se respeta con seis conexiones abriéndolas a la vez', async () => {
      const { stores, db } = await shared(6);
      const ana = await stores[0]!.signIn({ id: 1, login: 'ana' }, OPEN);
      const results = await Promise.allSettled(stores.flatMap((store) => Array.from({ length: 10 }, () => store.createSession(ana.id, 3600_000))));
      expect(codes(results)).toEqual(Array(60).fill('ok'));
      expect(await n(db, `select count(*) as n from ${db.table('cuentas_sessions')} where user_id = '${ana.id}'`)).toBe(MAX_SESSIONS_PER_USER);
      expect(await stores[3]!.sessionCount(ana.id)).toBe(MAX_SESSIONS_PER_USER);
    });

    it('nunca se queda un proyecto sin administración: dos conexiones degradan a la vez a las dos únicas administradoras, de las tres maneras', async () => {
      const { stores } = await shared(2);
      const [a, b] = stores as [PostgresAccountStore, PostgresAccountStore];
      const ana = await a.signIn({ id: 1, login: 'ana' }, OPEN);
      const beto = await a.signIn({ id: 2, login: 'beto' }, OPEN);
      const ways: Array<[string, (store: PostgresAccountStore, project: string, who: string, other: string) => Promise<unknown>]> = [
        ['bajar de rol', (store, project, who) => store.setMember(project, who, 'viewer')],
        ['quitarla', (store, project, who) => store.removeMember(project, who)],
        ['compartir bajándola', (store, project, _who, _other) => store.shareProject(project, _who === ana.id ? 'ana' : 'beto', 'viewer', 'member')],
      ];
      for (const [label, way] of ways) {
        for (let round = 0; round < 15; round++) {
          const project = `p-${label}-${round}`;
          await a.registerProject(project, ana.id);
          await a.setMember(project, beto.id, 'admin');
          const results = await Promise.allSettled([way(a, project, ana.id, beto.id), way(b, project, beto.id, ana.id)]);
          expect(codes(results), `${label}, ronda ${round}`).toEqual(['last-admin', 'ok']);
          const admins = (await a.membersOf(project)).filter((m) => m.role === 'admin');
          expect(admins, `${label}, ronda ${round}`).toHaveLength(1);
        }
      }
    });

    it('la misma persona que entra a la vez por seis conexiones es una sola cuenta, y una invitación repetida a la vez es una sola invitación', async () => {
      const { stores, db } = await shared(6);
      const logins = await Promise.all(stores.map((store) => store.signIn({ id: 77, login: 'ana', name: 'Ana' }, OPEN)));
      expect(new Set(logins.map((u) => u.id)).size).toBe(1);
      expect(await n(db, `select count(*) as n from ${db.table('cuentas_users')}`)).toBe(1);

      const invited = await Promise.all(stores.map((store) => store.invite('Carla', 'guest')));
      expect(new Set(invited.map((u) => u.id)).size).toBe(1);
      // y quien entra con ese nombre mientras otra conexión vuelve a invitarlo, se queda con la cuenta de siempre
      const [entered] = await Promise.all([stores[0]!.signIn({ id: 303, login: 'carla' }, OPEN), stores[1]!.invite('carla', 'member'), stores[2]!.invite('CARLA', 'guest')]);
      expect(entered.id).toBe(invited[0]!.id);
      expect(await n(db, `select count(*) as n from ${db.table('cuentas_users')} where login_key = 'carla'`)).toBe(1);
    });

    it('registrar un proyecto reemplaza a sus miembros en una sola transacción: una lectura concurrente nunca lo ve vacío ni a medias', async () => {
      const { stores } = await shared(3);
      const ana = await stores[0]!.signIn({ id: 1, login: 'ana' }, OPEN);
      const beto = await stores[0]!.signIn({ id: 2, login: 'beto' }, OPEN);
      await stores[0]!.registerProject('p', ana.id);
      let stop = false;
      const seen = new Set<number>();
      const reader = (async () => {
        while (!stop) seen.add((await stores[2]!.membersOf('p')).length);
      })();
      for (let i = 0; i < 40; i++) await Promise.all([stores[0]!.registerProject('p', beto.id), stores[1]!.registerProject('p', ana.id)]);
      stop = true;
      await reader;
      expect([...seen]).toEqual([1]);
    });
  });

  describe('el candado de escritura', () => {
    it('una escritura espera mientras otra conexión tiene el candado «cuentas:escritura», y las lecturas no esperan', async () => {
      const schema = uniqueSchema();
      schemas.set(schema, schema);
      const db = await PostgresDatabase.connect(testConfig(server.url, schema));
      const store = await PostgresAccountStore.open(db, { release: () => db.close() });
      const holder = await PostgresDatabase.connect(testConfig(server.url, schema));
      const ana = await store.signIn({ id: 1, login: 'ana' }, { signup: 'open', admin: false });
      const { token } = await store.createSession(ana.id, 3600_000);
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const hasLock = new Promise<void>((resolve) => (locked = resolve));
      const holding = holder.transaction(async (tx) => {
        await tx.lock('cuentas:escritura');
        locked();
        await held;
      });
      try {
        await hasLock;
        let written = false;
        const write = store.invite('beto', 'guest').then(() => (written = true));
        // lecturas: pasan por delante del candado
        expect((await store.lookupSession(token))?.login).toBe('ana');
        expect(await store.userCount()).toBe(1);
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(written, 'la escritura no debe terminar mientras otra conexión tiene el candado').toBe(false);
        release();
        await write;
        expect(written).toBe(true);
        expect(await store.userCount()).toBe(2);
      } finally {
        release();
        await holding;
        await holder.close();
        await store.close();
      }
    });
  });

  describe('lo que se guarda', () => {
    it('de la sesión solo se guarda el hash: el token no está en ninguna tabla, ni en claro ni en el volcado', async () => {
      const schema = uniqueSchema();
      schemas.set(schema, schema);
      const db = await PostgresDatabase.connect(testConfig(server.url, schema));
      const store = await PostgresAccountStore.open(db, { release: () => db.close() });
      try {
        const ana = await store.signIn({ id: 1, login: 'ana' }, { signup: 'open', admin: false });
        const { token } = await store.createSession(ana.id, 3600_000);
        expect(token.startsWith(SESSION_PREFIX)).toBe(true);
        const rows = await db.query<{ hash: string }>(`select hash from ${db.table('cuentas_sessions')}`);
        expect(rows).toEqual([{ hash: createHash('sha256').update(token, 'utf8').digest('hex') }]);
        // ninguna tabla de las cuentas contiene el token, ni en la forma en que Postgres vuelca la fila entera
        for (const table of ['cuentas_users', 'cuentas_sessions', 'cuentas_members', 'cuentas_meta']) {
          const dump = await db.query<{ row: string }>(`select t::text as row from ${db.table(table)} t`);
          expect(dump.map((r) => r.row).join('\n'), table).not.toContain(token);
          expect(dump.map((r) => r.row).join('\n'), table).not.toContain(SESSION_PREFIX);
        }
        expect(JSON.stringify(await store.snapshot())).not.toContain(token);
        // y un hash robado no sirve de token (se vuelve a hashear al buscar)
        expect(await store.lookupSession(rows[0]!.hash)).toBeUndefined();
      } finally {
        await store.close();
      }
    });

    it('el esquema queda cerrado: seguridad por filas activada y sin políticas ni permisos para public en las cuatro tablas', async () => {
      const schema = uniqueSchema();
      schemas.set(schema, schema);
      const db = await PostgresDatabase.connect(testConfig(server.url, schema));
      const store = await PostgresAccountStore.open(db, { release: () => db.close() });
      try {
        const tables = await db.query<{ relname: string; rls: boolean }>(
          `select c.relname, c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relkind = 'r' and c.relname like 'cuentas\\_%' order by 1`,
          [schema],
        );
        expect(tables).toEqual([
          { relname: 'cuentas_members', rls: true },
          { relname: 'cuentas_meta', rls: true },
          { relname: 'cuentas_sessions', rls: true },
          { relname: 'cuentas_users', rls: true },
        ]);
        expect(await db.query(`select 1 from pg_policies where schemaname = $1`, [schema])).toEqual([]);
        const publicGrants = await db.query(`select 1 from information_schema.role_table_grants where table_schema = $1 and grantee = 'PUBLIC'`, [schema]);
        expect(publicGrants).toEqual([]);
      } finally {
        await store.close();
      }
    });
  });

  describe('cuando la base falla', () => {
    it('sin llegar a la base, el error no lleva la contraseña ni la cadena de conexión, y por HTTP es un 503 genérico con Retry-After', async () => {
      const secret = 'Cl4ve-secreta-ñ';
      const config = testConfig(`postgres://iark:${encodeURIComponent(secret)}@127.0.0.1:1/iark`, uniqueSchema(), { IARK_DATABASE_SSL: 'off' });
      const error = await PostgresDatabase.connect(config).catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      for (const text of [(error as Error).message, String((error as Error).stack ?? '').split('\n')[0]]) {
        expect(text).not.toContain(secret);
        expect(text).not.toContain(encodeURIComponent(secret));
        expect(text).not.toMatch(/postgres(?:ql)?:\/\/[^\s…]*:[^\s…]*@/);
      }
      // y el almacén lo cuenta como «unreachable», que por HTTP es un 503 que no dice nada de la base
      const schema = uniqueSchema();
      schemas.set(schema, schema);
      const db = await PostgresDatabase.connect(testConfig(server.url, schema));
      const store = await PostgresAccountStore.open(db, { release: () => undefined });
      await db.close();
      const failure = await store.invite('ana', 'guest').catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(AccountError);
      expect((failure as AccountError).code).toBe('unreachable');
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const http = accountHttpError(failure as AccountError);
      stderr.mockRestore();
      expect(http.status).toBe(503);
      expect(http.headers).toMatchObject({ 'Retry-After': '5' });
      expect(JSON.stringify([http.message, http.extra])).not.toMatch(/postgres|127\.0\.0\.1|esquema|pool/i);
    });
  });

});
