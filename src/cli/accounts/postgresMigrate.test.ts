import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { INVITE, OPEN, realJson } from '../../../tests/helpers/realAccounts';
import { postgresAvailable, requirePostgresIfCi, startTestPostgres, testConfig, uniqueSchema, type TestPostgres } from '../../../tests/helpers/postgres';
import { PostgresDatabase } from '../postgres/pool';
import { describeImport, importAccounts } from './migrate';
import { PostgresAccountStore } from './postgresStore';
import { setupAccounts } from './setup';
import { JsonAccountStore, SqliteAccountStore } from './store';

requirePostgresIfCi();

// La importación de un JSON o de una base SQLite a Postgres (`iark accounts migrate --accounts-store postgres`, `--accounts-import` al arrancar), con
// las mismas garantías que a SQLite (`migrate.test.ts`): no se pierde nada, es idempotente, no mezcla y si falla se deshace.
describe.skipIf(!postgresAvailable())('importar cuentas a Postgres', () => {
  let server: TestPostgres;
  const schemas: string[] = [];
  const folders: string[] = [];
  const stores: Array<{ close(): void | Promise<void> }> = [];
  beforeAll(async () => {
    server = await startTestPostgres();
  }, 120_000);
  afterAll(async () => {
    if (server) {
      const admin = await PostgresDatabase.connect(testConfig(server.url));
      try {
        for (const schema of schemas) await admin.query(`drop schema if exists "${schema}" cascade`);
      } finally {
        await admin.close();
      }
    }
    await server?.stop();
  });
  afterEach(async () => {
    for (const store of stores.splice(0)) await store.close();
    for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const tmp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'iark-migrar-pg-'));
    folders.push(dir);
    return dir;
  };
  async function openPostgres(options: { now?: () => Date; schema?: string } = {}): Promise<{ store: PostgresAccountStore; db: PostgresDatabase; schema: string }> {
    const schema = options.schema ?? uniqueSchema();
    if (!schemas.includes(schema)) schemas.push(schema);
    const db = await PostgresDatabase.connect(testConfig(server.url, schema));
    const store = await PostgresAccountStore.open(db, { ...(options.now ? { now: options.now } : {}), release: () => db.close() });
    stores.push(store);
    return { store, db, schema };
  }

  it('no se pierde nada: cuentas, invitaciones, sesiones (los tokens siguen valiendo) y pertenencias, idénticas al JSON', async () => {
    const dir = tmp();
    const { file, snapshot, sessions, now } = realJson(dir);
    const before = readFileSync(file);
    const { store } = await openPostgres({ now });

    const report = await importAccounts(store, file, { now });
    expect(report.status).toBe('imported');
    expect(report.counts).toEqual({ users: 7, sessions: 3, memberships: 6, projects: 2 });
    expect(await store.snapshot()).toEqual(snapshot);

    // las sesiones siguen valiendo con el mismo token (solo se guardó su hash)
    expect((await store.lookupSession(sessions.ana))?.login).toBe('ana~583231');
    expect((await store.lookupSession(sessions.betoOtra))?.login).toBe('Beto');
    expect(await store.lookupSession(sessions.beto)).toBeUndefined(); // esta caducó
    // las invitaciones siguen pendientes y las reclama quien entre con ese nombre, con sus proyectos
    expect((await store.users()).filter((u) => u.githubId === undefined).map((u) => `${u.login}:${u.siteRole}`).sort()).toEqual(['carla:guest', 'eva:member', 'fede:guest']);
    const carla = await store.signIn({ id: 505, login: 'Carla' }, INVITE);
    expect(await store.roleOf(carla.id, 'tienda')).toBe('viewer');
    // la cuenta desactivada sigue desactivada
    await expect(store.signIn({ id: 303, login: 'dani' }, OPEN)).rejects.toMatchObject({ code: 'disabled' });
    expect((await store.membersOf('tienda')).map((m) => `${m.user.login}:${m.role}`)).toEqual(['ana~583231:admin', 'Beto:editor', 'Carla:viewer']);

    // el origen no se tocó, y hay una copia de seguridad idéntica con modo 0600
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(report.backup).toMatch(/cuentas\.json\.bak-\d{8}T\d{9}Z$/);
    expect(readFileSync(report.backup!).equals(before)).toBe(true);
    expect(statSync(report.backup!).mode & 0o777).toBe(0o600);
    // y la base anota de dónde salió
    expect(await store.meta('imported_json_sha256')).toBe(report.sha256);
    expect(describeImport(report, 'postgres')).toMatch(/Cuentas importadas de .*7 cuentas, 3 sesiones y 6 pertenencias a 2 proyectos.*El origen no se ha tocado/);
  });

  it('desde una base SQLite: las cuentas llegan idénticas, y el origen SQLite no se toca', async () => {
    const dir = tmp();
    const { file, snapshot, sessions, now } = realJson(dir);
    const sqlite = SqliteAccountStore.open(join(dir, 'cuentas.db'), { now });
    stores.push(sqlite);
    expect((await importAccounts(sqlite, file, { now, backup: false })).status).toBe('imported');
    sqlite.close();
    stores.pop();
    const { store } = await openPostgres({ now });
    const report = await importAccounts(store, join(dir, 'cuentas.db'), { now });
    expect(report.status).toBe('imported');
    expect(await store.snapshot()).toEqual(snapshot);
    expect((await store.lookupSession(sessions.betoOtra))?.login).toBe('Beto');
    expect(readdirSync(dir).filter((f) => f.startsWith('cuentas.db.bak-'))).toHaveLength(1);
  });

  it('es idempotente: repetirla con el mismo origen no hace nada (ni otra copia), aunque la base ya haya avanzado, también tras reiniciar', async () => {
    const dir = tmp();
    const { file } = realJson(dir);
    const { store, schema } = await openPostgres();
    expect((await importAccounts(store, file)).status).toBe('imported');
    const backups = readdirSync(dir).filter((f) => f.includes('.bak-'));
    expect(backups).toHaveLength(1);

    // la base sigue su vida: una sesión nueva, un cambio de rol
    const ana = (await store.findByLogin('ana~583231'))!;
    const fresh = await store.createSession(ana.id, 60_000);
    await store.setMember('tienda', (await store.findByLogin('beto'))!.id, 'viewer');
    const advanced = await store.snapshot();

    expect((await importAccounts(store, file)).status).toBe('already-imported');
    expect(readdirSync(dir).filter((f) => f.includes('.bak-'))).toEqual(backups);
    expect(await store.snapshot()).toEqual(advanced); // no pisó lo nuevo con el JSON viejo
    expect((await store.lookupSession(fresh.token))?.id).toBe(ana.id);

    await store.close();
    const again = await openPostgres({ schema });
    expect((await importAccounts(again.store, file)).status).toBe('already-imported');
  });

  it('no mezcla: una base que ya tiene otras cuentas, o salió de otro JSON, se deja como está', async () => {
    const dir = tmp();
    const { file } = realJson(dir);
    const used = (await openPostgres()).store;
    await used.signIn({ id: 1, login: 'zoe' }, OPEN);
    const before = await used.snapshot();
    const report = await importAccounts(used, file);
    expect(report.status).toBe('target-not-empty');
    expect(await used.snapshot()).toEqual(before);
    expect(readdirSync(dir).filter((f) => f.includes('.bak-'))).toEqual([]); // y no se hizo copia de lo que no se importó
    expect(describeImport(report, 'postgres')).toMatch(/ya tiene cuentas/);

    // importada de un JSON y luego otro JSON distinto
    const target = (await openPostgres()).store;
    await importAccounts(target, file);
    const other = join(dir, 'otro.json');
    JsonAccountStore.open(other).signIn({ id: 9, login: 'otro' }, OPEN);
    expect((await importAccounts(target, other)).status).toBe('target-not-empty');
    expect((await target.users()).map((u) => u.login)).not.toContain('otro');
  });

  it('un simulacro cuenta lo que importaría sin escribir nada: ni copia, ni filas', async () => {
    const dir = tmp();
    const { file, counts } = realJson(dir);
    const { store } = await openPostgres();
    const dry = await importAccounts(store, file, { dryRun: true });
    expect(dry).toMatchObject({ status: 'dry-run', counts: { users: counts.users, sessions: counts.sessions, memberships: 6, projects: 2 } });
    expect(await store.isEmpty()).toBe(true);
    expect(readdirSync(dir).filter((f) => f.includes('.bak-'))).toEqual([]);
  });

  it('un JSON dañado no se importa a medias: error claro, la base vacía y sin copia', async () => {
    const dir = tmp();
    const file = join(dir, 'cuentas.json');
    writeFileSync(file, '{"version":1,"users":[{"id":"u1"}],"sessions":[],"projects":{}}');
    const { store } = await openPostgres();
    await expect(importAccounts(store, file)).rejects.toMatchObject({ code: 'corrupt' });
    expect(await store.isEmpty()).toBe(true);
    expect(readdirSync(dir).filter((f) => f.includes('.bak-'))).toEqual([]);
  });

  it('si la importación falla a mitad, la base queda vacía y se puede repetir', async () => {
    const dir = tmp();
    const { file, snapshot } = realJson(dir);
    const { store, db } = await openPostgres();
    // un disparador que rechaza las pertenencias: las cuentas y las sesiones ya habían entrado en la transacción
    await db.query(`create function ${db.schemaQuoted}.falla() returns trigger language plpgsql as $$ begin raise exception 'fallo inyectado'; end $$`);
    await db.query(`create trigger sin_pertenencias before insert on ${db.table('cuentas_members')} for each row execute function ${db.schemaQuoted}.falla()`);
    await expect(importAccounts(store, file)).rejects.toMatchObject({ code: 'unavailable' });
    expect(await store.isEmpty()).toBe(true);
    expect(await store.meta('imported_json_sha256')).toBeUndefined();
    await db.query(`drop trigger sin_pertenencias on ${db.table('cuentas_members')}`);
    expect((await importAccounts(store, file)).status).toBe('imported');
    expect(await store.snapshot()).toEqual(snapshot);
  });

  it('si lo guardado no cuadra con el archivo, se deshace: la comprobación antes de confirmar muerde', async () => {
    const dir = tmp();
    const { file } = realJson(dir);
    const { store, db } = await openPostgres();
    // una regla que se traga las sesiones importadas: la transacción no falla, pero lo guardado ya no cuadra
    await db.query(`create rule se_traga_sesiones as on insert to ${db.table('cuentas_sessions')} do instead nothing`);
    await expect(importAccounts(store, file)).rejects.toMatchObject({ code: 'corrupt', message: expect.stringMatching(/no cuadra/) });
    expect(await store.isEmpty()).toBe(true);
  });

  it('dos servicios que arrancan a la vez con la importación puesta: uno importa y el otro ve que ya está hecho', async () => {
    const dir = tmp();
    const { file, snapshot } = realJson(dir);
    const first = await openPostgres();
    const second = await openPostgres({ schema: first.schema });
    // los dos comprueban «sin importar y vacía» a la vez y compiten por la transacción de importación
    const reports = await Promise.all([importAccounts(first.store, file, { backup: false }), importAccounts(second.store, file, { backup: false })]);
    expect(reports.map((r) => r.status).sort()).toEqual(['already-imported', 'imported']);
    expect(await first.store.snapshot()).toEqual(snapshot);
  });

  it('si la base se llena entre la comprobación y la transacción (otro servicio con otras cuentas), la transacción lo ve y no mezcla', async () => {
    const dir = tmp();
    const { file } = realJson(dir);
    const { store } = await openPostgres();
    await store.signIn({ id: 1, login: 'zoe' }, OPEN);
    const before = await store.snapshot();
    // la comprobación previa vio «vacía y sin importar» (como la de quien llegó un instante antes de que zoe entrara)
    vi.spyOn(store, 'meta').mockResolvedValueOnce(undefined);
    vi.spyOn(store, 'isEmpty').mockResolvedValueOnce(true);
    expect((await importAccounts(store, file, { backup: false })).status).toBe('target-not-empty');
    expect(await store.snapshot()).toEqual(before);
  });

  it('importar un lote grande es una sola transacción con pocas sentencias (no un viaje por fila)', async () => {
    const dir = tmp();
    const file = join(dir, 'grande.json');
    const users = Array.from({ length: 3000 }, (_, i) => ({ id: `u_${i}`, login: `persona${i}`, githubId: 10_000 + i, siteRole: 'member', createdAt: '2026-01-01T00:00:00.000Z' }));
    const sessions = users.slice(0, 1500).map((u, i) => ({ hash: i.toString(16).padStart(64, '0'), userId: u.id, createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' }));
    const projects = Object.fromEntries(Array.from({ length: 300 }, (_, p) => [`p${p}`, users.slice(p * 10, p * 10 + 10).map((u, i) => ({ userId: u.id, role: i === 0 ? 'admin' : 'viewer', addedAt: '2026-01-01T00:00:00.000Z' }))]));
    writeFileSync(file, JSON.stringify({ version: 1, users, sessions, projects }));
    const { store, db } = await openPostgres();
    const started = Date.now();
    const report = await importAccounts(store, file, { backup: false });
    expect(report.counts).toEqual({ users: 3000, sessions: 1500, memberships: 3000, projects: 300 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(Number((await db.query<{ n: string }>(`select count(*) as n from ${db.table('cuentas_users')}`))[0]!.n)).toBe(3000);
    expect(existsSync(file)).toBe(true);
  });

  describe('iark serve --accounts-store postgres --accounts-import', () => {
    const secret = { IARK_GITHUB_CLIENT_SECRET: 'secreto' };
    const options = (extra: Record<string, unknown> = {}) => ({ accountsStore: 'postgres', githubClientId: 'abc', publicUrl: 'https://iark.example.org', admins: '583231', ...extra });

    it('arranca con la conexión del entorno, importa el JSON si la base está vacía, lo cuenta una vez y no repite', async () => {
      const dir = tmp();
      const { file } = realJson(dir);
      const schema = uniqueSchema();
      schemas.push(schema);
      const env = { ...secret, IARK_DATABASE_URL: server.url, IARK_DATABASE_SCHEMA: schema, IARK_DATABASE_POOL: '2' };
      const lines: string[] = [];
      const context = { workspace: true, cors: [], env, log: (line: string) => lines.push(line) };
      const first = (await setupAccounts(options({ accountsImport: file }), context))!;
      expect(first.store.kind).toBe('postgres');
      expect((await first.store.findByLogin('beto'))?.login).toBe('Beto');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/Cuentas importadas de .*7 cuentas, 3 sesiones y 6 pertenencias a 2 proyectos.*Copia de seguridad del origen/);
      await first.store.close();
      // otra vez: ya está importada, no dice nada ni cambia nada
      const second = (await setupAccounts(options({ accountsImport: file }), context))!;
      expect(lines).toHaveLength(1);
      expect(await second.store.userCount()).toBe(7);
      await second.store.close();
    });

    it('con --accounts avisa de que no se usa, y sin la conexión del entorno no arranca ni la acepta de otro sitio', async () => {
      const dir = tmp();
      const lines: string[] = [];
      const schema = uniqueSchema();
      schemas.push(schema);
      const env = { ...secret, IARK_DATABASE_URL: server.url, IARK_DATABASE_SCHEMA: schema, IARK_DATABASE_POOL: '2' };
      const accounts = (await setupAccounts(options({ accounts: join(dir, 'sobra.json') }), { workspace: true, cors: [], env, log: (line) => lines.push(line) }))!;
      expect(lines.join('\n')).toMatch(/--accounts .* no se usa con --accounts-store postgres/);
      expect(existsSync(join(dir, 'sobra.json'))).toBe(false);
      await accounts.store.close();
      await expect(setupAccounts(options(), { workspace: true, cors: [], env: secret })).rejects.toThrowError(/IARK_DATABASE_URL/);
    });
  });
});
