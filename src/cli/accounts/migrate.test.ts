import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeImport, importAccounts } from './migrate';
import { loadSqlite, MIGRATIONS } from './sqliteStore';
import { OPEN, INVITE, realJson } from '../../../tests/helpers/realAccounts';
import { JsonAccountStore, SqliteAccountStore, type AccountsFile } from './store';

const folders: string[] = [];
const stores: SqliteAccountStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'iark-migrar-'));
  folders.push(dir);
  return dir;
};
const openSqlite = (path: string, now?: () => Date): SqliteAccountStore => {
  const store = SqliteAccountStore.open(path, now ? { now } : {});
  stores.push(store);
  return store;
};
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('iark accounts migrate: del JSON de verdad a SQLite', () => {
  it('no se pierde nada: cuentas, invitaciones, sesiones (los tokens siguen valiendo) y pertenencias, idénticas al JSON', async () => {
    const dir = tmp();
    const { file, snapshot, sessions, now } = realJson(dir);
    const before = readFileSync(file);
    const target = openSqlite(join(dir, 'cuentas.db'), now);

    const report = await importAccounts(target, file, { now });
    expect(report.status).toBe('imported');
    expect(report.counts).toEqual({ users: 7, sessions: 3, memberships: 6, projects: 2 });
    expect(target.snapshot()).toEqual(snapshot);

    // las sesiones siguen valiendo con el mismo token (solo se guardó su hash)
    expect(target.lookupSession(sessions.ana)?.login).toBe('ana~583231');
    expect(target.lookupSession(sessions.betoOtra)?.login).toBe('Beto');
    expect(target.lookupSession(sessions.beto)).toBeUndefined(); // esta caducó
    // las invitaciones siguen pendientes y las reclama quien entre con ese nombre, con sus proyectos
    expect(target.users().filter((u) => u.githubId === undefined).map((u) => `${u.login}:${u.siteRole}`).sort()).toEqual(['carla:guest', 'eva:member', 'fede:guest']);
    const carla = target.signIn({ id: 505, login: 'Carla' }, INVITE);
    expect(target.roleOf(carla.id, 'tienda')).toBe('viewer');
    // la cuenta desactivada sigue desactivada
    expect(() => target.signIn({ id: 303, login: 'dani' }, OPEN)).toThrowError(expect.objectContaining({ code: 'disabled' }));
    // la pertenencia a proyectos
    expect(target.membersOf('tienda').map((m) => `${m.user.login}:${m.role}`)).toEqual(['ana~583231:admin', 'Beto:editor', 'Carla:viewer']);

    // el JSON original no se tocó, y hay una copia de seguridad idéntica con modo 0600
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(report.backup).toMatch(/cuentas\.json\.bak-\d{8}T\d{9}Z$/);
    expect(readFileSync(report.backup!).equals(before)).toBe(true);
    expect(statSync(report.backup!).mode & 0o777).toBe(0o600);
    // y la base anota de dónde salió
    expect(target.meta('imported_json_sha256')).toBe(sha(file));
    expect(target.info().importedFrom).toMatchObject({ sha256: sha(file), source: file });
    expect(describeImport(report)).toMatch(/Cuentas importadas de .*7 cuentas, 3 sesiones y 6 pertenencias a 2 proyectos.*El origen no se ha tocado/);
  });

  it('es idempotente: repetirla con el mismo JSON no hace nada (ni otra copia), aunque la base ya haya avanzado', async () => {
    const dir = tmp();
    const { file } = realJson(dir);
    const target = openSqlite(join(dir, 'cuentas.db'));
    expect((await importAccounts(target, file)).status).toBe('imported');
    const backups = readdirSync(dir).filter((f) => f.includes('.bak-'));
    expect(backups).toHaveLength(1);

    // la base sigue su vida: una sesión nueva, un cambio de rol
    const ana = target.findByLogin('ana~583231')!;
    const fresh = target.createSession(ana.id, 60_000);
    target.setMember('tienda', target.findByLogin('beto')!.id, 'viewer');
    const advanced = target.snapshot();

    const again = await importAccounts(target, file);
    expect(again.status).toBe('already-imported');
    expect(readdirSync(dir).filter((f) => f.includes('.bak-'))).toEqual(backups);
    expect(target.snapshot()).toEqual(advanced); // no pisó lo nuevo con el JSON viejo
    expect(target.lookupSession(fresh.token)?.id).toBe(ana.id);

    // y también tras cerrar y volver a abrir (el arranque de un servicio)
    target.close();
    expect((await importAccounts(openSqlite(join(dir, 'cuentas.db')), file)).status).toBe('already-imported');
  });

  it('no mezcla: una base que ya tiene otras cuentas, o salió de otro JSON, se deja como está', async () => {
    const dir = tmp();
    const { file } = realJson(dir);
    const used = openSqlite(join(dir, 'usada.db'));
    used.signIn({ id: 1, login: 'zoe' }, OPEN);
    const before = used.snapshot();
    const report = await importAccounts(used, file);
    expect(report.status).toBe('target-not-empty');
    expect(used.snapshot()).toEqual(before);
    expect(readdirSync(dir).filter((f) => f.includes('.bak-'))).toEqual([]); // y no se hizo copia de lo que no se importó
    expect(describeImport(report)).toMatch(/ya tiene cuentas.*borre el archivo de la base/);

    // importada de un JSON y luego otro JSON distinto
    const target = openSqlite(join(dir, 'cuentas.db'));
    await importAccounts(target, file);
    const other = join(dir, 'otro.json');
    JsonAccountStore.open(other).signIn({ id: 9, login: 'otro' }, OPEN);
    expect((await importAccounts(target, other)).status).toBe('target-not-empty');
    expect(target.users().map((u) => u.login)).not.toContain('otro');
  });

  it('un simulacro cuenta lo que importaría sin escribir nada: ni copia, ni base nueva', async () => {
    const dir = tmp();
    const { file, counts } = realJson(dir);
    const dry = await importAccounts(undefined, file, { dryRun: true });
    expect(dry).toMatchObject({ status: 'dry-run', counts: { users: counts.users, sessions: counts.sessions, memberships: 6, projects: 2 } });
    expect(describeImport(dry)).toMatch(/Simulacro.*No se ha escrito nada/);
    expect(readdirSync(dir)).toEqual(['cuentas.json']);

    const target = openSqlite(join(dir, 'cuentas.db'));
    expect((await importAccounts(target, file, { dryRun: true })).status).toBe('dry-run');
    expect(target.isEmpty()).toBe(true);
    expect(readdirSync(dir).filter((f) => f.includes('.bak-'))).toEqual([]);
    await expect(importAccounts(undefined, file)).rejects.toThrowError(/sin base de destino solo se puede simular/);
  });

  it('sin archivo de origen no hay nada que importar (una instalación nueva); sin copia de seguridad si se pide', async () => {
    const dir = tmp();
    const target = openSqlite(join(dir, 'cuentas.db'));
    expect(await importAccounts(target, join(dir, 'no-existe.json'))).toEqual({ status: 'no-source', source: join(dir, 'no-existe.json') });
    const { file } = realJson(dir);
    expect(await importAccounts(target, file, { backup: false })).toMatchObject({ status: 'imported' });
    expect(readdirSync(dir).filter((f) => f.includes('.bak-'))).toEqual([]);
  });

  it('un JSON dañado no se importa a medias: error claro, la base vacía y sin copia', async () => {
    const dir = tmp();
    const file = join(dir, 'cuentas.json');
    writeFileSync(file, '{"version":1,"users":[{"id":"u1"}],"sessions":[],"projects":{}}');
    const target = openSqlite(join(dir, 'cuentas.db'));
    await expect(importAccounts(target, file)).rejects.toThrowError(expect.objectContaining({ code: 'corrupt' }));
    expect(target.isEmpty()).toBe(true);
    expect(readdirSync(dir).filter((f) => f.includes('.bak-'))).toEqual([]);
  });

  it('si la importación falla a mitad, la base queda vacía y se puede repetir', async () => {
    const dir = tmp();
    const { file, snapshot } = realJson(dir);
    const path = join(dir, 'cuentas.db');
    const target = openSqlite(path);
    const db = new (loadSqlite().DatabaseSync)(path);
    db.exec("CREATE TRIGGER sin_pertenencias BEFORE INSERT ON members BEGIN SELECT RAISE(ABORT, 'fallo inyectado'); END");
    await expect(importAccounts(target, file)).rejects.toThrowError(expect.objectContaining({ code: 'unavailable' }));
    expect(target.isEmpty()).toBe(true); // ni las cuentas ni las sesiones que ya habían entrado
    expect(target.meta('imported_json_sha256')).toBeUndefined();
    db.exec('DROP TRIGGER sin_pertenencias');
    db.close();
    expect((await importAccounts(target, file)).status).toBe('imported');
    expect(target.snapshot()).toEqual(snapshot);
  });

  it('si lo guardado no cuadra con el archivo, se deshace: la comprobación antes de confirmar muerde', async () => {
    const dir = tmp();
    const { file } = realJson(dir);
    const path = join(dir, 'cuentas.db');
    const target = openSqlite(path);
    const db = new (loadSqlite().DatabaseSync)(path);
    // un disparador que se traga las sesiones importadas: la transacción no falla, pero lo guardado ya no cuadra
    db.exec('CREATE TRIGGER se_traga_sesiones BEFORE INSERT ON sessions BEGIN SELECT RAISE(IGNORE); END');
    await expect(importAccounts(target, file)).rejects.toThrowError(expect.objectContaining({ code: 'corrupt', message: expect.stringMatching(/no cuadra/) }));
    expect(target.isEmpty()).toBe(true);
    db.close();
  });

  it('dos servicios que arrancan a la vez con la importación puesta: uno importa y el otro ve que ya está hecho', async () => {
    const dir = tmp();
    const { file, snapshot } = realJson(dir);
    const path = join(dir, 'cuentas.db');
    const first = openSqlite(path);
    const second = openSqlite(path);
    // la segunda comprobó «sin importar y vacía» justo antes de que la primera importara; su transacción ya ve la base llena
    vi.spyOn(second, 'meta').mockReturnValueOnce(undefined);
    vi.spyOn(second, 'isEmpty').mockReturnValueOnce(true);
    expect((await importAccounts(first, file)).status).toBe('imported');
    expect((await importAccounts(second, file)).status).toBe('already-imported'); // y reconoce que salió de este mismo archivo
    expect(first.snapshot()).toEqual(snapshot);
  });

  it('los instantes se guardan en su forma canónica; los proyectos sin personas no se importan', async () => {
    const dir = tmp();
    const file = join(dir, 'a-mano.json');
    const file1: AccountsFile = {
      version: 1,
      users: [{ id: 'u_1', login: 'ana', githubId: 7, siteRole: 'admin', quota: { bytes: 2048, diagramsPerProject: 0 }, createdAt: '2026-01-01T00:00:00Z', lastLoginAt: '2026-01-02T01:00:00+01:00' }],
      sessions: [{ hash: 'a'.repeat(64), userId: 'u_1', createdAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' }],
      projects: { p: [{ userId: 'u_1', role: 'admin', addedAt: '2026-01-01T00:00:00Z' }], vacio: [] },
    };
    writeFileSync(file, JSON.stringify(file1));
    const target = openSqlite(join(dir, 'cuentas.db'));
    const report = await importAccounts(target, file);
    expect(report.counts).toEqual({ users: 1, sessions: 1, memberships: 1, projects: 1 });
    const dump = target.snapshot();
    expect(dump.users[0]).toMatchObject({ createdAt: '2026-01-01T00:00:00.000Z', lastLoginAt: '2026-01-02T00:00:00.000Z', siteRole: 'admin', quota: { bytes: 2048, diagramsPerProject: 0 } }); // la cuota personal viaja con la cuenta
    expect(dump.sessions[0]).toMatchObject({ createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' });
    expect(Object.keys(dump.projects)).toEqual(['p']);
    expect(existsSync(file)).toBe(true);
  });
});

describe('SqliteAccountStore: copia de seguridad, comprobación e información', () => {
  it('backupTo hace una copia coherente de la base viva (con el diario WAL sin volcar), con modo 0600, que se abre y no sobrescribe', async () => {
    const dir = tmp();
    const live = openSqlite(join(dir, 'cuentas.db'));
    const user = live.signIn({ id: 1, login: 'ana' }, OPEN);
    live.registerProject('tienda', user.id);
    const { token } = live.createSession(user.id, 60_000);
    expect(existsSync(join(dir, 'cuentas.db-wal'))).toBe(true);

    const copy = join(dir, 'copias', 'cuentas-2026-10-09.db');
    live.backupTo(copy);
    expect(statSync(copy).mode & 0o777).toBe(0o600);
    expect(SqliteAccountStore.checkFile(copy)).toEqual(['ok']);
    live.createSession(user.id, 60_000); // lo posterior a la copia no está en ella
    const restored = openSqlite(copy);
    expect(restored.lookupSession(token)?.login).toBe('ana');
    expect(restored.roleOf(user.id, 'tienda')).toBe('admin');
    expect(restored.sessionCount(user.id)).toBe(1);
    expect(restored.info().schemaVersion).toBe(restored.info().latestSchemaVersion);
    expect(() => live.backupTo(copy)).toThrowError(expect.objectContaining({ code: 'conflict', message: expect.stringMatching(/ya existe/) }));
  });

  it('checkFile dice que está sano sin escribir en el archivo, y avisa de lo que no es una base', async () => {
    const dir = tmp();
    const path = join(dir, 'cuentas.db');
    openSqlite(path).close();
    const before = readFileSync(path);
    expect(SqliteAccountStore.checkFile(path)).toEqual(['ok']);
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(() => SqliteAccountStore.checkFile(join(dir, 'no-esta.db'))).toThrowError(expect.objectContaining({ code: 'not-found' }));
    writeFileSync(join(dir, 'basura.db'), 'nada');
    expect(() => SqliteAccountStore.checkFile(join(dir, 'basura.db'))).toThrowError(expect.objectContaining({ code: 'corrupt' }));
  });

  it('info cuenta lo que hay', async () => {
    const dir = tmp();
    const store = openSqlite(join(dir, 'cuentas.db'));
    const ana = store.signIn({ id: 1, login: 'ana' }, OPEN);
    store.registerProject('p', ana.id);
    store.shareProject('p', 'carla', 'viewer', 'guest');
    store.updateUser(store.signIn({ id: 2, login: 'beto' }, OPEN).id, { disabled: true });
    store.createSession(ana.id, 60_000);
    expect(store.info()).toMatchObject({ schemaVersion: MIGRATIONS.length, latestSchemaVersion: MIGRATIONS.length, journalMode: 'wal', synchronous: 'full', foreignKeys: true, users: 3, pending: 1, disabled: 1, sessions: 1, activeSessions: 1, memberships: 2, projects: 1 });
    expect(store.info().importedFrom).toBeUndefined();
  });
});
