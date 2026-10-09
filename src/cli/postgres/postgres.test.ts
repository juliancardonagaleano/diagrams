import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTestDatabase, postgresAvailable, requirePostgresIfCi, startTestPostgres, testConfig, uniqueSchema, type TestPostgres } from '../../../tests/helpers/postgres';
import { migrate, currentVersion, type PgMigration } from './migrate';
import { DatabaseError, isUniqueViolation, PostgresDatabase } from './pool';

requirePostgresIfCi();

const LIST: PgMigration[] = [
  { version: 1, name: 'cosas', up: ['create table {schema}.cosas (id integer primary key, valor text not null)'] },
  { version: 2, name: 'indice', up: ['create index cosas_valor on {schema}.cosas (valor)', 'create table {schema}.otra (id integer primary key)'] },
];

describe.skipIf(!postgresAvailable())('Postgres: pool, transacciones y migraciones (contra un servidor real)', () => {
  let server: TestPostgres;
  beforeAll(async () => {
    server = await startTestPostgres();
  }, 120_000);
  afterAll(async () => {
    await server?.stop();
  });

  const withDb = async (fn: (db: PostgresDatabase) => Promise<void>) => {
    const { db, drop } = await openTestDatabase(server.url);
    try {
      await fn(db);
    } finally {
      await drop();
    }
  };

  it('migra desde cero, anota las versiones y no repite lo ya aplicado', () =>
    withDb(async (db) => {
      expect(await currentVersion(db, 'prueba')).toBe(0);
      expect(await migrate(db, 'prueba', LIST)).toEqual({ from: 0, to: 2, applied: 2 });
      expect(await currentVersion(db, 'prueba')).toBe(2);
      expect(await migrate(db, 'prueba', LIST)).toEqual({ from: 2, to: 2, applied: 0 });
      expect(await db.query(`select name from ${db.schemaQuoted}.migraciones order by version`)).toEqual([{ name: 'cosas' }, { name: 'indice' }]);
    }));

  it('una migración que falla no deja nada a medias', () =>
    withDb(async (db) => {
      const bad: PgMigration[] = [{ version: 1, name: 'rota', up: ['create table {schema}.a (id integer)', 'select * from {schema}.no_existe'] }];
      await expect(migrate(db, 'prueba', bad)).rejects.toThrow();
      expect(await currentVersion(db, 'prueba')).toBe(0);
      const left = await db.query(`select to_regclass('${db.schemaQuoted}.a') as t`);
      expect(left[0].t).toBeNull();
    }));

  it('cada almacén lleva su propio número de versión', () =>
    withDb(async (db) => {
      await migrate(db, 'cuentas', LIST);
      await migrate(db, 'proyectos', [{ version: 1, name: 'p', up: ['create table {schema}.p (id integer)'] }]);
      expect(await currentVersion(db, 'cuentas')).toBe(2);
      expect(await currentVersion(db, 'proyectos')).toBe(1);
    }));

  it('rechaza una base con una versión más nueva que la que conoce este IArk', () =>
    withDb(async (db) => {
      await migrate(db, 'prueba', LIST);
      await expect(migrate(db, 'prueba', LIST.slice(0, 1))).rejects.toMatchObject({ name: 'DatabaseError', code: 'incompatible' });
    }));

  it('dos procesos que arrancan a la vez no se pisan: la migración se aplica una sola vez', () =>
    withDb(async (db) => {
      const second = await PostgresDatabase.connect(db.config);
      try {
        const results = await Promise.all([migrate(db, 'prueba', LIST), migrate(second, 'prueba', LIST), migrate(db, 'prueba', LIST)]);
        expect(results.reduce((n, r) => n + r.applied, 0)).toBe(2);
        expect(await currentVersion(db, 'prueba')).toBe(2);
      } finally {
        await second.close();
      }
    }));

  it('endurece el esquema: seguridad por filas en todas las tablas y sin acceso para PUBLIC ni para los roles de Supabase', () =>
    withDb(async (db) => {
      // los roles de Supabase que el servicio no debe usar: uno con permisos amplios sobre el esquema, como por defecto en `public`
      for (const role of ['anon', 'authenticated']) {
        await db.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role} nologin; end if; end $$`);
      }
      await db.query(`create schema ${db.schemaQuoted}`);
      await db.query(`grant usage on schema ${db.schemaQuoted} to anon, authenticated, public`);
      await db.query(`alter default privileges in schema ${db.schemaQuoted} grant all on tables to anon, authenticated`);
      await migrate(db, 'prueba', LIST);
      await db.query(`insert into ${db.schemaQuoted}.cosas values (1, 'secreto')`);

      const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
        'select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relkind = \'r\' order by 1',
        [db.config.schema],
      );
      expect(rls.map((r) => r.relname)).toEqual(['cosas', 'migraciones', 'otra']);
      expect(rls.every((r) => r.relrowsecurity)).toBe(true);

      for (const role of ['anon', 'authenticated']) {
        const privileges = await db.query<{ usage: boolean; sel: boolean }>(
          `select has_schema_privilege($1, $2, 'usage') as usage, has_table_privilege($1, $3, 'select') as sel`,
          [role, db.config.schema, `${db.schemaQuoted}.cosas`],
        );
        expect(privileges[0], role).toEqual({ usage: false, sel: false });
      }
    }));

  it('una transacción confirma todo o nada, y repite sola ante un choque de serialización', () =>
    withDb(async (db) => {
      await migrate(db, 'prueba', LIST);
      const cosas = `${db.schemaQuoted}.cosas`;
      await expect(
        db.transaction(async (tx) => {
          await tx.query(`insert into ${cosas} values (1, 'a')`);
          throw new Error('adrede');
        }),
      ).rejects.toThrow('adrede');
      expect(await db.query(`select * from ${cosas}`)).toEqual([]);

      await db.transaction(async (tx) => {
        await tx.query(`insert into ${cosas} values (1, 'a')`);
      });
      await expect(db.query(`insert into ${cosas} values (1, 'b')`)).rejects.toSatisfy(isUniqueViolation);

      // dos contadores que se leen y escriben a la vez con aislamiento serializable: ninguna actualización se pierde
      await db.query(`insert into ${cosas} values (2, '0')`);
      let attempts = 0;
      const bump = () =>
        db.transaction(
          async (tx) => {
            attempts++;
            const [row] = await tx.query<{ valor: string }>(`select valor from ${cosas} where id = 2`);
            await new Promise((r) => setTimeout(r, 15));
            await tx.query(`update ${cosas} set valor = $1 where id = 2`, [String(Number(row.valor) + 1)]);
          },
          { isolation: 'serializable' },
        );
      await Promise.all(Array.from({ length: 6 }, bump));
      expect(await db.query(`select valor from ${cosas} where id = 2`)).toEqual([{ valor: '6' }]);
      expect(attempts).toBeGreaterThan(6); // hubo choques y se repitieron
    }));

  it('el candado de asesoramiento serializa lo que comparte clave', () =>
    withDb(async (db) => {
      const order: string[] = [];
      const run = (name: string, ms: number) =>
        db.transaction(async (tx) => {
          await tx.lock('misma-clave');
          order.push(`${name}:dentro`);
          await new Promise((r) => setTimeout(r, ms));
          order.push(`${name}:fuera`);
        });
      await Promise.all([run('a', 80), run('b', 0)]);
      // nunca se intercalan
      expect(order[0].split(':')[0]).toBe(order[1].split(':')[0]);
      expect(order[2].split(':')[0]).toBe(order[3].split(':')[0]);
    }));

  it('ping contesta, y un servidor que no está da un error claro sin contraseña', async () => {
    await withDb(async (db) => expect(await db.ping()).toBe(true));
    const dead = testConfig('postgres://postgres:clavesecreta@127.0.0.1:1/postgres', uniqueSchema());
    const error = await PostgresDatabase.connect(dead).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseError);
    expect((error as DatabaseError).code).toBe('unavailable');
    expect((error as Error).message).toMatch(/No se puede usar Postgres \(postgres:\/\/postgres@127\.0\.0\.1:1\/postgres\)/);
    expect((error as Error).message).not.toMatch(/clavesecreta/);
  });

  it('cierra el pool y después no se puede usar', async () => {
    const { db, drop } = await openTestDatabase(server.url);
    await drop();
    await expect(db.query('select 1')).rejects.toThrow();
    expect(await db.ping()).toBe(false);
  });
});

describe.skipIf(!postgresAvailable())('Postgres: pool compartido por proceso', () => {
  let server: TestPostgres;
  beforeAll(async () => {
    server = await startTestPostgres();
  }, 120_000);
  afterAll(async () => {
    await server?.stop();
  });

  it('reutiliza el mismo pool y lo cierra con la última referencia', async () => {
    const { acquireDatabase, releaseDatabase } = await import('./shared');
    const env = { IARK_DATABASE_URL: server.url, IARK_DATABASE_SCHEMA: uniqueSchema() };
    const a = await acquireDatabase(env);
    const b = await acquireDatabase(env);
    expect(b).toBe(a);
    await releaseDatabase();
    expect(await a.ping()).toBe(true); // queda una referencia
    await releaseDatabase();
    expect(await a.ping()).toBe(false); // ya cerrado
    const c = await acquireDatabase(env); // y se puede volver a abrir
    expect(c).not.toBe(a);
    expect(await c.ping()).toBe(true);
    await releaseDatabase();
  });

  it('si la base no contesta no deja un fallo guardado', async () => {
    const { acquireDatabase, releaseDatabase } = await import('./shared');
    await expect(acquireDatabase({ IARK_DATABASE_URL: 'postgres://postgres@127.0.0.1:1/postgres', IARK_DATABASE_SCHEMA: uniqueSchema() })).rejects.toBeInstanceOf(DatabaseError);
    const ok = await acquireDatabase({ IARK_DATABASE_URL: server.url, IARK_DATABASE_SCHEMA: uniqueSchema() });
    expect(await ok.ping()).toBe(true);
    await releaseDatabase();
  });
});
