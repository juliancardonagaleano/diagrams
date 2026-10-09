import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountStoreContract, ana, beto, INVITE, OPEN } from '../../../tests/helpers/accountStoreContract';
import { loadSqlite, MIGRATIONS, SQLITE_APPLICATION_ID, SqliteAccountStore, type SqliteMigration } from './sqliteStore';
import { AccountError, asAsync, hashSessionToken, MAX_PENDING_USERS } from './store';

accountStoreContract('sqlite', { fileName: 'cuentas.db', open: (path, options) => asAsync(SqliteAccountStore.open(path, options)) });

const folders: string[] = [];
const stores: SqliteAccountStore[] = [];
const raws: DatabaseSync[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const raw of raws.splice(0)) if (raw.isOpen) raw.close();
  for (const store of stores.splice(0)) store.close();
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'iark-sqlite-'));
  folders.push(dir);
  return dir;
};
const open = (path: string, options: Parameters<typeof SqliteAccountStore.open>[1] = {}): SqliteAccountStore => {
  const store = SqliteAccountStore.open(path, options);
  stores.push(store);
  return store;
};
/** Una conexión cruda a la misma base, para mirar por dentro o provocar bloqueos y fallos. */
const raw = (path: string): DatabaseSync => {
  const db = new (loadSqlite().DatabaseSync)(path);
  db.exec('PRAGMA busy_timeout = 2000');
  raws.push(db);
  return db;
};
const pragma = (db: DatabaseSync, name: string): unknown => Object.values(db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[0];
const expectCode = (code: string) => expect.objectContaining({ code });

describe('SqliteAccountStore: el archivo y sus ajustes', () => {
  it('se crea con modo 0600 (la carpeta, 0700) y deja el diario WAL y la memoria compartida con el mismo modo', () => {
    const path = join(tmp(), 'datos', 'cuentas.db');
    const store = open(path);
    expect(store.kind).toBe('sqlite');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
    store.signIn(ana, OPEN);
    for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
      expect(existsSync(sidecar), sidecar).toBe(true);
      expect(statSync(sidecar).mode & 0o777, sidecar).toBe(0o600);
    }
  });

  it('usa WAL, claves foráneas, la versión del esquema y la marca de IArk', () => {
    const path = join(tmp(), 'cuentas.db');
    const store = open(path);
    const db = raw(path);
    expect(pragma(db, 'journal_mode')).toBe('wal');
    // los ajustes de la conexión del propio almacén (no los de la cruda de arriba): durabilidad plena y claves foráneas
    expect(store.info()).toMatchObject({ journalMode: 'wal', synchronous: 'full', foreignKeys: true });
    expect(pragma(db, 'user_version')).toBe(MIGRATIONS.length);
    expect(pragma(db, 'application_id')).toBe(SQLITE_APPLICATION_ID);
    expect(pragma(db, 'integrity_check')).toBe('ok');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables).toEqual(['members', 'meta', 'sessions', 'users']);
    // las claves foráneas valen: borrar una cuenta arrastra sus sesiones y pertenencias
    const user = store.signIn(ana, OPEN);
    store.registerProject('p', user.id);
    store.createSession(user.id, 60_000);
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    expect(store.snapshot()).toMatchObject({ users: [], sessions: [], projects: {} });
  });

  it('del token de una sesión no queda rastro en la base ni en su diario', () => {
    const path = join(tmp(), 'cuentas.db');
    const store = open(path);
    const { token } = store.createSession(store.signIn(ana, OPEN).id, 60_000);
    for (const file of [path, `${path}-wal`]) expect(readFileSync(file).includes(Buffer.from(token)), file).toBe(false);
    expect(readFileSync(`${path}-wal`).includes(Buffer.from('ana'))).toBe(true); // el diario sí lleva lo escrito: la prueba mira donde toca
  });

  it('cancelar una invitación (o quitar de su último proyecto a un invitado) no deja pertenencias huérfanas: las claves foráneas valen para el propio almacén', () => {
    const path = join(tmp(), 'cuentas.db');
    const store = open(path);
    const owner = store.signIn(ana, OPEN);
    store.registerProject('p', owner.id);
    const guest = store.shareProject('p', 'nuevo', 'viewer', 'guest').user;
    const count = (sql: string): unknown => (raw(path).prepare(sql).get() as { n: number }).n;
    expect(count('SELECT count(*) AS n FROM members')).toBe(2);
    store.removePending(guest.id);
    expect(count('SELECT count(*) AS n FROM members')).toBe(1);
    expect(count('SELECT count(*) AS n FROM members m WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = m.user_id)')).toBe(0);
  });

  it('el esquema impide lo que el servicio nunca haría: roles inventados, nombres repetidos, hashes mal formados', () => {
    const path = join(tmp(), 'cuentas.db');
    const store = open(path);
    const user = store.signIn(ana, OPEN);
    const db = raw(path);
    const run = (sql: string, ...params: Array<string | number | null>) => () => db.prepare(sql).run(...params);
    expect(run("INSERT INTO users (id, login, login_key, site_role, created_at) VALUES ('u_x', 'x', 'x', 'rey', 'ahora')")).toThrowError(/CHECK/);
    expect(run("INSERT INTO users (id, login, login_key, site_role, created_at) VALUES ('u_y', 'ANA', 'ana', 'member', 'ahora')")).toThrowError(/UNIQUE/);
    expect(run("INSERT INTO users (id, login, login_key, github_id, site_role, created_at) VALUES ('u_z', 'z', 'z', 101, 'member', 'ahora')")).toThrowError(/UNIQUE/);
    expect(run("INSERT INTO sessions (hash, user_id, created_at, expires_at) VALUES ('corto', ?, 'a', 'b')", user.id)).toThrowError(/CHECK/);
    expect(run("INSERT INTO members (project_id, user_id, role, added_at) VALUES ('p', 'u_nadie', 'admin', 'a')")).toThrowError(/FOREIGN KEY/);
    expect(store.userCount).toBe(1);
  });
});

describe('SqliteAccountStore: migraciones del esquema', () => {
  const NEXT = MIGRATIONS.length + 1;
  const v2: SqliteMigration = {
    version: NEXT,
    description: 'una nota por cuenta',
    up(db) {
      db.exec("ALTER TABLE users ADD COLUMN note TEXT; UPDATE users SET note = 'migrada'");
    },
  };

  it('una base de una versión anterior se migra al abrir, sin perder datos, y no se repite', () => {
    const path = join(tmp(), 'cuentas.db');
    const old = open(path);
    const user = old.signIn(ana, OPEN);
    old.registerProject('tienda', user.id);
    const { token } = old.createSession(user.id, 3600_000);
    old.close();

    const up = vi.fn(v2.up);
    const migrated = open(path, { migrations: [...MIGRATIONS, { ...v2, up }] });
    expect(up).toHaveBeenCalledTimes(1);
    expect(migrated.lookupSession(token)?.login).toBe('ana');
    expect(migrated.roleOf(user.id, 'tienda')).toBe('admin');
    const db = raw(path);
    expect(pragma(db, 'user_version')).toBe(NEXT);
    expect((db.prepare('SELECT note FROM users').get() as { note: string }).note).toBe('migrada');
    migrated.close();

    open(path, { migrations: [...MIGRATIONS, { ...v2, up }] }); // ya al día: no vuelve a correr
    expect(up).toHaveBeenCalledTimes(1);
  });

  it('una base del esquema 1 (anterior a las cuotas) se migra al 2 sin perder nada: las cuentas no tienen cuota y se les puede fijar una', () => {
    const path = join(tmp(), 'cuentas.db');
    // La base tal como la dejó la versión anterior de IArk: solo la migración 1, con una cuenta, una sesión y un proyecto.
    const legacy = raw(path);
    legacy.exec('PRAGMA journal_mode = WAL');
    MIGRATIONS[0]!.up(legacy);
    legacy.exec('PRAGMA user_version = 1');
    legacy.exec("INSERT INTO users (id, login, login_key, github_id, site_role, created_at) VALUES ('u_viejo', 'ana', 'ana', 101, 'member', '2026-01-01T00:00:00.000Z')");
    legacy.prepare('INSERT INTO sessions (hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(hashSessionToken('iark_s_viejo'), 'u_viejo', '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
    legacy.exec("INSERT INTO members (project_id, user_id, role, added_at) VALUES ('tienda', 'u_viejo', 'admin', '2026-01-01T00:00:00.000Z')");
    legacy.close();

    const migrated = open(path);
    const db = raw(path);
    expect(pragma(db, 'user_version')).toBe(2);
    expect(migrated.lookupSession('iark_s_viejo')).toMatchObject({ id: 'u_viejo', login: 'ana', githubId: 101 });
    expect(migrated.findUser('u_viejo')?.quota).toBeUndefined();
    expect(migrated.roleOf('u_viejo', 'tienda')).toBe('admin');
    expect(migrated.updateUser('u_viejo', { quota: { bytes: 4096 } }).quota).toEqual({ bytes: 4096 });
    // las columnas son NULL (el valor de la instancia) donde no se fijó nada, y la base no admite un tope negativo
    expect(db.prepare('SELECT quota_bytes, quota_projects, quota_diagrams FROM users').get()).toMatchObject({ quota_bytes: 4096, quota_projects: null, quota_diagrams: null });
    expect(() => db.exec('UPDATE users SET quota_projects = -1')).toThrowError(/CHECK/);
  });

  it('una migración que falla se deshace entera: la versión y el esquema quedan como estaban', () => {
    const path = join(tmp(), 'cuentas.db');
    open(path).close();
    const broken: SqliteMigration = {
      version: NEXT,
      description: 'se rompe a la mitad',
      up(db) {
        db.exec('CREATE TABLE a_medias (x TEXT)');
        throw new Error('fallo a propósito');
      },
    };
    expect(() => open(path, { migrations: [...MIGRATIONS, broken] })).toThrowError('fallo a propósito');
    const db = raw(path);
    expect(pragma(db, 'user_version')).toBe(MIGRATIONS.length);
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'a_medias'").get()).toMatchObject({ n: 0 });
    open(path); // y la base sigue sirviendo
  });

  it('una base de una versión más nueva no se abre ni se toca', () => {
    const path = join(tmp(), 'cuentas.db');
    open(path, { migrations: [...MIGRATIONS, v2] }).close();
    const before = readFileSync(path);
    expect(() => SqliteAccountStore.open(path)).toThrowError(expect.objectContaining({ code: 'corrupt', message: expect.stringMatching(new RegExp(`versión más nueva.*esquema ${NEXT}.*hasta el ${MIGRATIONS.length}`, 's')) }));
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('una base SQLite que no es de cuentas de IArk no se abre, no se migra ni se le cambia el modo del diario', () => {
    const path = join(tmp(), 'ajena.db');
    const other = raw(path);
    other.exec("CREATE TABLE notas (texto TEXT); INSERT INTO notas VALUES ('hola')");
    expect(() => SqliteAccountStore.open(path)).toThrowError(expectCode('corrupt'));
    expect(other.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'users'").get()).toMatchObject({ n: 0 });
    expect(pragma(other, 'journal_mode')).toBe('delete'); // ni siquiera lo pasó a WAL

    const marked = join(tmp(), 'marcada.db');
    const db = raw(marked);
    db.exec('PRAGMA application_id = 12345; PRAGMA user_version = 1');
    expect(() => SqliteAccountStore.open(marked)).toThrowError(expect.objectContaining({ code: 'corrupt', message: expect.stringMatching(/no de cuentas de IArk/) }));
  });

  it('las migraciones se numeran 1, 2, 3… sin huecos', () => {
    const path = join(tmp(), 'cuentas.db');
    expect(() => SqliteAccountStore.open(path, { migrations: [{ ...v2, version: 2 }] })).toThrowError(/deben numerarse 1, 2, 3/);
    expect(existsSync(path)).toBe(false);
  });

  it('abrir una base al día no pide el candado de escritura: arranca aunque otro proceso esté escribiendo', () => {
    const path = join(tmp(), 'cuentas.db');
    open(path).close();
    const writer = raw(path);
    writer.exec('BEGIN IMMEDIATE');
    const started = Date.now();
    const store = open(path, { busyTimeoutMs: 5000 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(store.users()).toEqual([]); // y lee mientras el otro escribe (WAL)
    writer.exec('ROLLBACK');
  });
});

describe('SqliteAccountStore: transacciones y rollback', () => {
  it('si algo falla a mitad de compartir un proyecto, no queda ni la invitación: todo o nada', () => {
    const path = join(tmp(), 'cuentas.db');
    const store = open(path);
    const owner = store.signIn(ana, OPEN);
    store.registerProject('p', owner.id);
    const db = raw(path);
    db.exec("CREATE TRIGGER falla_al_compartir BEFORE INSERT ON members WHEN NEW.role = 'viewer' BEGIN SELECT RAISE(ABORT, 'fallo inyectado'); END");
    let error: unknown;
    try {
      store.shareProject('p', 'carla', 'viewer', 'guest');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AccountError);
    expect(error).toMatchObject({ code: 'unavailable' });
    expect((error as Error).message).not.toMatch(/INSERT|SELECT|members/); // sin la consulta
    expect(store.findByLogin('carla')).toBeUndefined();
    expect(store.userCount).toBe(1);
    expect(store.membersOf('p')).toHaveLength(1);
    // la conexión sigue sana: al quitar el fallo, la misma operación sale
    db.exec('DROP TRIGGER falla_al_compartir');
    expect(store.shareProject('p', 'carla', 'viewer', 'guest')).toMatchObject({ added: true, invited: true });
  });

  it('abrir una sesión es una transacción: si no se puede guardar la nueva tampoco se podan las caducadas', () => {
    let now = Date.parse('2026-10-01T00:00:00Z');
    const path = join(tmp(), 'cuentas.db');
    const store = open(path, { now: () => new Date(now) });
    const user = store.signIn(ana, OPEN);
    store.createSession(user.id, 1000);
    now += 5000;
    const db = raw(path);
    db.exec("CREATE TRIGGER sin_sesiones BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'fallo inyectado'); END");
    expect(() => store.createSession(user.id, 3600_000)).toThrowError(expectCode('unavailable'));
    expect(store.snapshot().sessions).toHaveLength(1); // la caducada sigue ahí: el DELETE se deshizo
    db.exec('DROP TRIGGER sin_sesiones');
    store.createSession(user.id, 3600_000);
    expect(store.snapshot().sessions).toHaveLength(1); // ahora sí: la caducada se podó y entró la nueva
    expect(store.sessionCount(user.id)).toBe(1);
  });

  it('desactivar una cuenta y cerrar sus sesiones es una sola operación: si falla, la cuenta sigue activa y con sus sesiones', () => {
    const path = join(tmp(), 'cuentas.db');
    const store = open(path);
    const user = store.signIn(ana, OPEN);
    const { token } = store.createSession(user.id, 60_000);
    const db = raw(path);
    db.exec("CREATE TRIGGER no_borrar_sesiones BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'fallo inyectado'); END");
    expect(() => store.updateUser(user.id, { disabled: true })).toThrowError(expectCode('unavailable'));
    expect(store.findUser(user.id)?.disabled).toBeUndefined();
    expect(store.lookupSession(token)?.login).toBe('ana');
  });

  it('un error de la propia aplicación dentro de la transacción (una regla, un tope) también la deshace', () => {
    const path = join(tmp(), 'cuentas.db');
    const store = open(path);
    const owner = store.signIn(ana, OPEN);
    store.registerProject('p', owner.id);
    store.shareProject('p', 'beto', 'editor', 'guest');
    expect(() => store.shareProject('p', 'ana', 'viewer', 'guest')).toThrowError(expectCode('last-admin'));
    expect(store.roleOf(owner.id, 'p')).toBe('admin');
    expect(store.removeMember('p', store.findByLogin('beto')!.id)).toBe(true); // y la conexión no se quedó con una transacción abierta
  });
});

describe('SqliteAccountStore: dos conexiones a la misma base', () => {
  it('lo que hace una lo ve la otra al instante: sesiones, cierres de sesión, desactivaciones y proyectos', () => {
    const path = join(tmp(), 'cuentas.db');
    const a = open(path);
    const b = open(path);
    const user = a.signIn(ana, OPEN);
    const { token } = a.createSession(user.id, 60_000);
    expect(b.lookupSession(token)?.login).toBe('ana'); // una réplica reconoce la sesión que abrió otra
    a.registerProject('tienda', user.id);
    expect(b.roleOf(user.id, 'tienda')).toBe('admin');
    b.updateUser(user.id, { disabled: true });
    expect(a.lookupSession(token)).toBeUndefined();
    b.updateUser(user.id, { disabled: false });
    const fresh = b.createSession(user.id, 60_000);
    expect(a.revokeSession(fresh.token)).toBe(true);
    expect(b.lookupSession(fresh.token)).toBeUndefined();
    expect(b.revokeSession(fresh.token)).toBe(false); // ya la cerró la otra
  });

  it('una sesión no vale si su cuenta está desactivada, aunque la fila de la sesión siga en la base (no depende de que alguien las cierre)', () => {
    const path = join(tmp(), 'cuentas.db');
    const store = open(path);
    const user = store.signIn(ana, OPEN);
    const { token } = store.createSession(user.id, 60_000);
    raw(path).prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(user.id); // por otra vía que no cierra sesiones
    expect(store.sessionCount(user.id)).toBe(1);
    expect(store.lookupSession(token)).toBeUndefined();
  });

  it('los topes valen entre conexiones: dos réplicas llenando invitaciones no pasan del máximo', () => {
    const path = join(tmp(), 'cuentas.db');
    const a = open(path);
    const b = open(path);
    let accepted = 0;
    for (let i = 0; i < MAX_PENDING_USERS + 20; i++) {
      try {
        (i % 2 === 0 ? a : b).invite(`persona${i}`);
        accepted++;
      } catch (error) {
        expect(error).toMatchObject({ code: 'limit' });
      }
    }
    expect(accepted).toBe(MAX_PENDING_USERS);
    expect(a.userCount).toBe(MAX_PENDING_USERS);
    expect(b.userCount).toBe(MAX_PENDING_USERS);
  });

  it('la misma persona entrando por dos réplicas es una sola cuenta, y una invitación solo la reclama una vez', () => {
    const path = join(tmp(), 'cuentas.db');
    const a = open(path);
    const b = open(path);
    const first = a.signIn(ana, OPEN);
    const second = b.signIn(ana, OPEN);
    expect(second.id).toBe(first.id);
    expect(a.userCount).toBe(1);
    const invited = a.invite('beto', 'guest');
    const claimedByB = b.signIn(beto, INVITE);
    const again = a.signIn(beto, INVITE);
    expect(claimedByB.id).toBe(invited.id);
    expect(again.id).toBe(invited.id);
    expect(a.users().map((u) => u.login)).toEqual(['ana', 'Beto']);
  });

  it('una escritura espera a que otro proceso suelte el candado y, si no lo suelta, falla con un error claro sin dañar nada', () => {
    const path = join(tmp(), 'cuentas.db');
    const store = open(path, { busyTimeoutMs: 100 });
    const user = store.signIn(ana, OPEN);
    const holder = raw(path);
    holder.exec('BEGIN IMMEDIATE');
    holder.prepare("UPDATE users SET site_role = 'guest'").run();
    // mientras tanto, las lecturas siguen (WAL) y ven lo último confirmado
    expect(store.findUser(user.id)?.siteRole).toBe('member');
    expect(store.lookupSession('iark_s_nada')).toBeUndefined();
    const started = Date.now();
    expect(() => store.createSession(user.id, 60_000)).toThrowError(expect.objectContaining({ code: 'unavailable', message: expect.stringMatching(/ocupada/) }));
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(Date.now() - started).toBeLessThan(5000);
    holder.exec('ROLLBACK');
    expect(store.createSession(user.id, 60_000).token).toMatch(/^iark_s_/);
    expect(store.findUser(user.id)?.siteRole).toBe('member'); // lo que el otro no confirmó no existe
  });
});

describe('SqliteAccountStore: reinicio y abrir lo que no es', () => {
  it('lo confirmado está en disco aunque nadie cierre nada, y la base queda sana', () => {
    const path = join(tmp(), 'cuentas.db');
    const first = open(path);
    const user = first.signIn(ana, OPEN);
    const { token } = first.createSession(user.id, 60_000);
    // otra conexión (otro proceso, tras un reinicio) ve lo confirmado, que está en el diario WAL
    const second = open(path);
    expect(second.lookupSession(token)?.login).toBe('ana');
    expect(second.integrityCheck()).toEqual(['ok']);
  });

  it('con una carpeta en lugar del archivo, avisa de lo que pasa con Docker', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'cuentas.db'));
    expect(() => SqliteAccountStore.open(join(dir, 'cuentas.db'))).toThrowError(/no es un archivo.*Docker/s);
  });

  it('si el archivo es el JSON de cuentas, lo dice y propone migrarlo; el archivo no se toca', () => {
    const file = join(tmp(), 'cuentas.json');
    const json = '{ "version": 1, "users": [], "sessions": [], "projects": {} }\n';
    writeFileSync(file, json);
    expect(() => SqliteAccountStore.open(file)).toThrowError(expect.objectContaining({ code: 'corrupt', message: expect.stringMatching(/JSON de cuentas.*iark accounts migrate.*--accounts-store json/s) }));
    expect(readFileSync(file, 'utf8')).toBe(json);
    expect(existsSync(`${file}-wal`)).toBe(false);
  });

  it('un archivo cualquiera tampoco se abre ni se reemplaza', () => {
    const file = join(tmp(), 'basura.db');
    writeFileSync(file, 'esto no es una base de datos de nada');
    expect(() => SqliteAccountStore.open(file)).toThrowError(expect.objectContaining({ code: 'corrupt', message: expect.stringMatching(/no es una base SQLite/) }));
    expect(readFileSync(file, 'utf8')).toBe('esto no es una base de datos de nada');
  });

  it('con mustExist no inventa una base vacía por un error de ruta', () => {
    const file = join(tmp(), 'no-esta.db');
    expect(() => SqliteAccountStore.open(file, { mustExist: true })).toThrowError(expectCode('not-found'));
    expect(existsSync(file)).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)('sin permiso para leer la base o para crear una en la carpeta, el error es claro (no una excepción de SQLite)', () => {
    const dir = tmp();
    const file = join(dir, 'cuentas.db');
    open(file).close();
    chmodSync(file, 0o000);
    expect(() => SqliteAccountStore.open(file)).toThrowError(expectCode('unavailable'));
    chmodSync(file, 0o600);
    chmodSync(dir, 0o500);
    expect(() => SqliteAccountStore.open(join(dir, 'otra.db'))).toThrowError(/No se pudo crear/);
    chmodSync(dir, 0o700);
  });
});

describe('loadSqlite: node:sqlite sin avisos de más', () => {
  it('silencia solo el ExperimentalWarning de SQLite mientras carga, deja pasar los demás y restaura process.emitWarning', async () => {
    const real = loadSqlite();
    vi.resetModules();
    const passed: unknown[][] = [];
    const spy = vi.spyOn(process, 'emitWarning').mockImplementation(((...args: unknown[]) => void passed.push(args)) as typeof process.emitWarning);
    vi.spyOn(process, 'getBuiltinModule').mockImplementation(((id: string) => {
      process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
      process.emitWarning('otra cosa que sí debe verse', 'DeprecationWarning');
      return id === 'node:sqlite' ? real : undefined;
    }) as typeof process.getBuiltinModule);
    const fresh = await import('./sqliteStore');
    expect(fresh.loadSqlite()).toBe(real);
    expect(passed).toEqual([['otra cosa que sí debe verse', 'DeprecationWarning']]);
    expect(process.emitWarning).toBe(spy); // restaurado
    expect(fresh.loadSqlite()).toBe(real); // y la segunda vez ni lo intenta
    expect(passed).toHaveLength(1);
  });

  it('si esta versión de Node no trae node:sqlite sin bandera, el error dice qué versión hace falta y la salida', async () => {
    vi.resetModules();
    vi.spyOn(process, 'getBuiltinModule').mockImplementation((() => undefined) as typeof process.getBuiltinModule);
    const fresh = await import('./sqliteStore');
    expect(() => fresh.loadSqlite()).toThrowError(expect.objectContaining({ code: 'unavailable', message: expect.stringMatching(/Node 22\.13\.0 o superior.*--accounts-store json/s) }));
    expect(() => fresh.SqliteAccountStore.open(join(tmp(), 'x.db'))).toThrowError(/Node 22\.13\.0/);
  });
});
