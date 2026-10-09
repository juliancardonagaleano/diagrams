import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync, type Stats } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';
import {
  ACCOUNTS_FILE_VERSION,
  AccountError,
  generateSessionToken,
  hashSessionToken,
  applyQuotaChange,
  isProjectRole,
  isSiteRole,
  loginKey,
  MAX_MEMBERS_PER_PROJECT,
  MAX_PENDING_USERS,
  MAX_SESSIONS_PER_USER,
  newUserId,
  parseLogin,
  PROJECT_ROLES,
  ROLE_RANK,
  SITE_ROLES,
  type AccountsFile,
  type AccountStats,
  type SyncAccountStore,
  type AccountStoreOptions,
  type AccountUser,
  type GithubProfile,
  type MemberRecord,
  type ProjectRole,
  type SessionRecord,
  type SignInPolicy,
  type SiteRole,
  type UserChange,
  type UserQuota,
} from './model';

/**
 * El almacén de cuentas en una base SQLite (`--accounts <archivo>` con `--accounts-store sqlite`), con el módulo integrado `node:sqlite`
 * (sin dependencias). Es el almacén transaccional: varias instancias de `iark serve` (o `iark accounts …` a la vez) pueden compartir
 * el mismo archivo sin corromperlo ni pisarse.
 *
 * - **Transacciones.** Toda operación que lee y escribe (entrar, reclamar una invitación, cambiar un rol, desactivar una cuenta y cerrar
 *   sus sesiones, compartir un proyecto, abrir una sesión y podar las viejas…) corre en `BEGIN IMMEDIATE`: toma el candado de escritura
 *   antes de leer, así que la comprobación y el cambio son indivisibles también entre procesos (los topes y la regla de la última persona
 *   administradora no se saltan con dos peticiones a la vez). Si algo falla, `ROLLBACK`: no queda nada a medias. Las lecturas son una sola
 *   sentencia (o una transacción de lectura) y, en WAL, no esperan a quien escribe.
 * - **Durabilidad.** `journal_mode = WAL` (varios lectores y un escritor a la vez) y `synchronous = FULL` (un cambio confirmado sobrevive
 *   a un corte de luz; las cuentas se escriben poco). `busy_timeout` (5 s por omisión) hace esperar a una escritura mientras otro proceso
 *   escribe, en vez de fallar al instante. WAL guarda memoria compartida (`-shm`) junto a la base: las instancias deben ver el mismo disco
 *   **local** (un volumen de Docker, un disco de la máquina), no un sistema de archivos de red (NFS, SMB).
 * - **Esquema versionado.** `PRAGMA user_version` dice qué migraciones numeradas (`MIGRATIONS`) se aplicaron; al abrir se aplican las que
 *   faltan, cada una en su transacción y comprobando la versión dentro de ella (dos procesos que arrancan a la vez no la aplican dos veces).
 *   Una base de una versión más nueva que este IArk no se abre (se negaría a escribir lo que no entiende). `PRAGMA application_id` marca
 *   la base como de IArk: no se abre ni se migra una base ajena.
 * - **Integridad.** Claves foráneas (borrar una cuenta borra sus sesiones y pertenencias), nombre de usuario y id de GitHub únicos,
 *   roles con `CHECK`, tablas `STRICT`. Del token de una sesión solo se guarda su hash.
 * - El archivo se crea con modo 0600 (SQLite da el mismo modo a `-wal` y `-shm`).
 *
 * El módulo `node:sqlite` se carga la primera vez que se abre una base (no al importar este archivo): quien usa el almacén JSON no lo
 * toca, y en Node 22 (donde sigue marcado «experimental») se silencia solo su aviso de arranque.
 */

/** Primera versión de Node 22 en la que `node:sqlite` se puede usar sin la bandera `--experimental-sqlite`. */
export const SQLITE_MIN_NODE = '22.13.0';

/** Las cuatro letras «IArk» como `application_id` de la base. */
export const SQLITE_APPLICATION_ID = 0x4941726b;

const DEFAULT_BUSY_TIMEOUT_MS = 5000;

// ───────────── cargar node:sqlite ─────────────

type SqliteModule = typeof import('node:sqlite');
let loaded: SqliteModule | undefined;

/**
 * Carga `node:sqlite` una vez. Mientras carga, descarta únicamente su `ExperimentalWarning` (cualquier otro aviso sigue su camino) y
 * restaura `process.emitWarning` enseguida. Falla con `AccountError('unavailable')` si esta versión de Node no lo trae sin bandera.
 */
export function loadSqlite(): SqliteModule {
  if (loaded) return loaded;
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]): void => {
    const first = rest[0];
    const type = typeof warning !== 'string' ? warning.name : typeof first === 'string' ? first : (first as { type?: string } | undefined)?.type;
    const text = typeof warning === 'string' ? warning : warning.message;
    if (type === 'ExperimentalWarning' && /sqlite/i.test(text)) return;
    (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    loaded = process.getBuiltinModule('node:sqlite') as SqliteModule | undefined;
  } catch {
    loaded = undefined;
  } finally {
    process.emitWarning = emit;
  }
  if (!loaded) {
    throw new AccountError('unavailable', `El almacén SQLite necesita Node ${SQLITE_MIN_NODE} o superior (esta es la ${process.version}); con la versión actual, use --accounts-store json.`);
  }
  return loaded;
}

// ───────────── el esquema y sus migraciones ─────────────

export interface SqliteMigration {
  /** Número de la migración: consecutivo desde 1. Es el valor de `PRAGMA user_version` una vez aplicada. */
  version: number;
  description: string;
  /** Lo que cambia. Corre dentro de una transacción `BEGIN IMMEDIATE`: no abre ni cierra transacciones propias. */
  up(db: DatabaseSync): void;
}

/**
 * Las migraciones, en orden. **Nunca se edita una ya publicada**: un cambio de esquema es una migración nueva al final. Las tablas son
 * `STRICT`; los instantes son texto ISO 8601 en UTC con milisegundos (`toISOString()`), que ordenado como texto ordena en el tiempo.
 */
export const MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    description: 'esquema inicial: cuentas, sesiones, pertenencia a proyectos y metadatos',
    up(db) {
      db.exec(`
        CREATE TABLE users (
          id            TEXT NOT NULL PRIMARY KEY,
          login         TEXT NOT NULL,
          login_key     TEXT NOT NULL UNIQUE,
          github_id     INTEGER UNIQUE,
          name          TEXT,
          avatar_url    TEXT,
          site_role     TEXT NOT NULL CHECK (site_role IN ('admin', 'member', 'guest')),
          disabled      INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
          created_at    TEXT NOT NULL,
          last_login_at TEXT
        ) STRICT;
        CREATE INDEX users_pending ON users (id) WHERE github_id IS NULL;

        CREATE TABLE sessions (
          hash       TEXT NOT NULL PRIMARY KEY CHECK (length(hash) = 64),
          user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX sessions_user ON sessions (user_id, expires_at);
        CREATE INDEX sessions_expires ON sessions (expires_at);

        CREATE TABLE members (
          project_id TEXT NOT NULL,
          user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
          role       TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'admin')),
          added_at   TEXT NOT NULL,
          PRIMARY KEY (project_id, user_id)
        ) STRICT;
        CREATE INDEX members_user ON members (user_id);

        CREATE TABLE meta (
          key   TEXT NOT NULL PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT;

        PRAGMA application_id = ${SQLITE_APPLICATION_ID};
      `);
    },
  },
  {
    version: 2,
    description: 'cuota personal por cuenta (bytes, proyectos y diagramas por proyecto; NULL = el valor de la instancia, 0 = sin tope)',
    up(db) {
      db.exec(`
        ALTER TABLE users ADD COLUMN quota_bytes    INTEGER CHECK (quota_bytes IS NULL OR quota_bytes >= 0);
        ALTER TABLE users ADD COLUMN quota_projects INTEGER CHECK (quota_projects IS NULL OR quota_projects >= 0);
        ALTER TABLE users ADD COLUMN quota_diagrams INTEGER CHECK (quota_diagrams IS NULL OR quota_diagrams >= 0);
      `);
    },
  },
];

const latestVersion = (migrations: readonly SqliteMigration[]): number => migrations[migrations.length - 1]?.version ?? 0;

type Row = Record<string, SQLOutputValue>;

const userVersion = (db: DatabaseSync): number => Number((db.prepare('PRAGMA user_version').get() as Row).user_version);
const applicationId = (db: DatabaseSync): number => Number((db.prepare('PRAGMA application_id').get() as Row).application_id);

function rollback(db: DatabaseSync): void {
  try {
    if (db.isTransaction) db.exec('ROLLBACK');
  } catch {
    // la conexión ya no tiene transacción (SQLite la cerró al fallar)
  }
}

const tooNew = (path: string, found: number, supported: number): AccountError =>
  new AccountError('corrupt', `La base de cuentas «${path}» es de una versión más nueva de IArk (esquema ${found}; esta versión entiende hasta el ${supported}). Actualice IArk en vez de abrirla con una versión vieja.`);

const foreign = (path: string): AccountError => new AccountError('corrupt', `«${path}» es una base SQLite, pero no de cuentas de IArk: no se abre ni se toca.`);

/**
 * Comprueba, sin escribir nada, que la base es una base de cuentas de IArk que esta versión entiende, y devuelve su versión de esquema
 * (0 si está recién creada y vacía). Una base ajena o de una versión más nueva no se abre ni se toca.
 */
function assertOurs(db: DatabaseSync, path: string, latest: number): number {
  const version = userVersion(db);
  if (version > latest) throw tooNew(path, version, latest);
  if (version === 0) {
    const tables = Number((db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get() as Row).n);
    if (tables > 0 || applicationId(db) !== 0) throw foreign(path);
  } else if (applicationId(db) !== SQLITE_APPLICATION_ID) throw foreign(path);
  return version;
}

/**
 * Lleva el esquema a la última versión. Cada migración corre en su propia `BEGIN IMMEDIATE` y la versión se lee ya dentro de ella: si
 * otro proceso migró mientras esperábamos el candado, aquí no queda nada por hacer.
 */
function migrate(db: DatabaseSync, migrations: readonly SqliteMigration[], path: string): void {
  const latest = latestVersion(migrations);
  // Lo normal: la base ya está al día. Se comprueba sin candado de escritura, para que arrancar no espere a quien está escribiendo.
  if (assertOurs(db, path, latest) === latest && latest > 0) return;
  for (;;) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = assertOurs(db, path, latest);
      if (current === latest) {
        db.exec('COMMIT');
        return;
      }
      const next = migrations.find((m) => m.version === current + 1);
      if (!next) throw new Error(`Falta la migración ${current + 1} del esquema de las cuentas.`);
      next.up(db);
      db.exec(`PRAGMA user_version = ${next.version}`);
      db.exec('COMMIT');
    } catch (error) {
      rollback(db);
      throw error;
    }
  }
}

// ───────────── errores ─────────────

const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;
const sqliteCode = (error: unknown): number | undefined => {
  const code = (error as { errcode?: unknown } | undefined)?.errcode;
  return typeof code === 'number' ? code & 0xff : undefined;
};
const sqliteText = (error: unknown): string => (error as { errstr?: string } | undefined)?.errstr ?? (error as Error).message;
const isSqliteError = (error: unknown): boolean => (error as { code?: unknown } | undefined)?.code === 'ERR_SQLITE_ERROR';

const SYNCHRONOUS_NAMES = ['off', 'normal', 'full', 'extra'];

const SQLITE_HEADER = 'SQLite format 3\u0000';
const JSON_HINT = (path: string): string =>
  `«${path}» parece el archivo JSON de cuentas, no una base SQLite. Para pasarlo a SQLite use \`iark accounts migrate --from ${path} --accounts <base.db>\`; para seguir con JSON, --accounts-store json.`;

/** El error de abrir o preparar la base, con el motivo en español y sin citar su contenido. */
function openError(path: string, error: unknown, head?: string): AccountError {
  const code = sqliteCode(error);
  if (code === 26 || code === 11) {
    if (head?.trimStart().startsWith('{')) return new AccountError('corrupt', JSON_HINT(path));
    return new AccountError('corrupt', `«${path}» no es una base de cuentas válida (${sqliteText(error)}).`);
  }
  if (code === 5 || code === 6) return new AccountError('unavailable', `La base de cuentas «${path}» está bloqueada por otro proceso: ${sqliteText(error)}.`);
  return new AccountError('unavailable', `No se pudo abrir la base de cuentas «${path}» (${errno(error) ?? sqliteText(error)}).`);
}

/** Comprueba el archivo antes de abrirlo; lo crea (modo 0600, carpeta 0700) si no existe y se pide. Devuelve sus primeros bytes. */
function prepareFile(path: string, create: boolean): string {
  let stat: Stats | undefined;
  try {
    stat = statSync(path);
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw new AccountError('unavailable', `No se pudo leer la base de cuentas «${path}» (${errno(error) ?? (error as Error).message}).`);
  }
  if (stat && !stat.isFile()) throw new AccountError('unavailable', `«${path}» no es un archivo (¿una carpeta? Con Docker, montar un archivo que no existía crea una carpeta con ese nombre).`);
  if (!stat) {
    if (!create) throw new AccountError('not-found', `No existe la base de cuentas «${path}».`);
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      closeSync(openSync(path, 'a', 0o600));
    } catch (error) {
      throw new AccountError('unavailable', `No se pudo crear la base de cuentas «${path}» (${errno(error) ?? (error as Error).message}).`);
    }
    return '';
  }
  if (stat.size === 0) return '';
  let head = '';
  try {
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(16);
      readSync(fd, buffer, 0, 16, 0);
      head = buffer.toString('latin1');
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    throw new AccountError('unavailable', `No se pudo leer la base de cuentas «${path}» (${errno(error) ?? (error as Error).message}).`);
  }
  if (!head.startsWith(SQLITE_HEADER)) {
    throw new AccountError('corrupt', head.trimStart().startsWith('{') ? JSON_HINT(path) : `«${path}» no es una base SQLite.`);
  }
  return head;
}

// ───────────── filas ─────────────

interface UserRow {
  id: string;
  login: string;
  github_id: number | null;
  name: string | null;
  avatar_url: string | null;
  site_role: SiteRole;
  disabled: number;
  created_at: string;
  last_login_at: string | null;
  quota_bytes: number | null;
  quota_projects: number | null;
  quota_diagrams: number | null;
}

const USER_COLUMNS = 'u.id, u.login, u.github_id, u.name, u.avatar_url, u.site_role, u.disabled, u.created_at, u.last_login_at, u.quota_bytes, u.quota_projects, u.quota_diagrams';

const toUser = (row: Row): AccountUser => {
  const r = row as unknown as UserRow;
  const quota: UserQuota = {
    ...(r.quota_bytes !== null ? { bytes: Number(r.quota_bytes) } : {}),
    ...(r.quota_projects !== null ? { projects: Number(r.quota_projects) } : {}),
    ...(r.quota_diagrams !== null ? { diagramsPerProject: Number(r.quota_diagrams) } : {}),
  };
  return {
    id: r.id,
    login: r.login,
    ...(r.github_id !== null ? { githubId: Number(r.github_id) } : {}),
    ...(r.name !== null ? { name: r.name } : {}),
    ...(r.avatar_url !== null ? { avatarUrl: r.avatar_url } : {}),
    siteRole: r.site_role,
    ...(r.disabled ? { disabled: true } : {}),
    ...(Object.keys(quota).length > 0 ? { quota } : {}),
    createdAt: r.created_at,
    ...(r.last_login_at !== null ? { lastLoginAt: r.last_login_at } : {}),
  };
};

/** El instante en la forma canónica de la base (`toISOString()`): así el orden alfabético es el cronológico. */
const canonicalIso = (value: string): string => new Date(Date.parse(value)).toISOString();

const text = (value: SQLOutputValue | undefined): string => String(value);

export interface SqliteStoreOptions extends AccountStoreOptions {
  /** Cuánto espera una escritura si otro proceso tiene la base bloqueada, en milisegundos (5000 por omisión). */
  busyTimeoutMs?: number;
  /** No crear la base si no existe: los comandos de mantenimiento no deben inventar una vacía por un error al escribir la ruta. */
  mustExist?: boolean;
  /** Las migraciones del esquema. Solo para las pruebas (simular una versión futura o antigua); por omisión, `MIGRATIONS`. */
  migrations?: readonly SqliteMigration[];
}

/** Lo que `importSnapshot` metió en la base. */
export interface ImportCounts {
  users: number;
  sessions: number;
  memberships: number;
  projects: number;
}

/** De dónde salió lo importado (se guarda en la tabla `meta`, para que importar el mismo archivo otra vez no haga nada). */
export interface ImportProvenance {
  sha256: string;
  source: string;
  at: string;
}

export interface SqliteInfo {
  path: string;
  schemaVersion: number;
  latestSchemaVersion: number;
  journalMode: string;
  /** `PRAGMA synchronous` de esta conexión: `full` (lo que usa el almacén), `normal`, `off` o `extra`. */
  synchronous: string;
  /** Si esta conexión hace cumplir las claves foráneas (sí: borrar una cuenta arrastra sus sesiones y pertenencias). */
  foreignKeys: boolean;
  sizeBytes: number;
  users: number;
  pending: number;
  disabled: number;
  sessions: number;
  activeSessions: number;
  memberships: number;
  projects: number;
  importedFrom?: ImportProvenance;
}

export class SqliteAccountStore implements SyncAccountStore {
  readonly kind = 'sqlite' as const;
  private readonly now: () => Date;
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;

  private constructor(
    readonly path: string,
    private readonly db: DatabaseSync,
    options: SqliteStoreOptions,
    private readonly latest: number,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Abre la base (o la crea vacía si no existe, salvo con `mustExist`) y lleva su esquema a la última versión. Falla con `AccountError`
   * si no es una base de cuentas, es de una versión más nueva o no se puede usar: así un servicio mal configurado no arranca.
   */
  static open(path: string, options: SqliteStoreOptions = {}): SqliteAccountStore {
    const migrations = options.migrations ?? MIGRATIONS;
    migrations.forEach((m, index) => {
      if (m.version !== index + 1) throw new Error(`Las migraciones del esquema de las cuentas deben numerarse 1, 2, 3…: la ${index + 1} es la ${m.version}.`);
    });
    const { DatabaseSync } = loadSqlite();
    const head = prepareFile(path, !options.mustExist);
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(path);
    } catch (error) {
      throw openError(path, error, head);
    }
    try {
      db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS))}`);
      assertOurs(db, path, latestVersion(migrations)); // antes de tocar nada, ni siquiera el modo del diario de una base ajena
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = FULL');
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('PRAGMA temp_store = MEMORY');
      migrate(db, migrations, path);
    } catch (error) {
      try {
        db.close();
      } catch {
        // ya estaba cerrada
      }
      if (error instanceof AccountError) throw error;
      if (isSqliteError(error)) throw openError(path, error, head);
      throw error;
    }
    return new SqliteAccountStore(path, db, options, latestVersion(migrations));
  }

  // ───── utilidades de acceso ─────

  private stmt(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.stmt(sql).get(...params);
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.stmt(sql).all(...params);
  }

  private run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.stmt(sql).run(...params).changes);
  }

  private count(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.get(sql, ...params)?.n ?? 0);
  }

  /** Un error de SQLite como `AccountError` (sin la consulta ni los datos); lo demás sube tal cual. */
  private fail(error: unknown): unknown {
    if (error instanceof AccountError || !isSqliteError(error)) return error;
    const code = sqliteCode(error);
    if (code === 5 || code === 6) return new AccountError('unavailable', `La base de cuentas está ocupada: otro proceso la tuvo bloqueada más de lo que se espera (${sqliteText(error)}).`);
    if (code === 11 || code === 26) return new AccountError('corrupt', `La base de cuentas «${this.path}» está dañada (${sqliteText(error)}).`);
    return new AccountError('unavailable', `No se pudo usar la base de cuentas «${this.path}» (${sqliteText(error)}).`);
  }

  /** Una lectura de una sola sentencia (o varias que no necesitan verse a la vez). */
  private read<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      throw this.fail(error);
    }
  }

  /** Una lectura coherente de varias sentencias: ven la base como estaba al empezar aunque otro proceso escriba en medio. */
  private snapshotRead<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    try {
      this.db.exec('BEGIN');
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
        rollback(this.db);
      }
    } catch (error) {
      throw this.fail(error);
    }
  }

  /**
   * Una escritura: `BEGIN IMMEDIATE` (el candado de escritura antes de leer nada), la operación y `COMMIT`; si lanza, `ROLLBACK` y el
   * error sube. Anidada dentro de otra transacción de esta conexión, solo ejecuta la operación.
   */
  private write<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    try {
      this.db.exec('BEGIN IMMEDIATE');
    } catch (error) {
      throw this.fail(error);
    }
    this.depth++;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      rollback(this.db);
      throw this.fail(error);
    } finally {
      this.depth--;
    }
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private userRow(where: string, ...params: SQLInputValue[]): AccountUser | undefined {
    const row = this.get(`SELECT ${USER_COLUMNS} FROM users u WHERE ${where}`, ...params);
    return row ? toUser(row) : undefined;
  }

  // ───── personas ─────

  get userCount(): number {
    return this.read(() => this.count('SELECT count(*) AS n FROM users'));
  }

  stats(): AccountStats {
    return this.snapshotRead(() => {
      const row = this.get(
        "SELECT count(*) AS users, coalesce(sum(disabled = 1), 0) AS disabled, coalesce(sum(disabled = 0 AND github_id IS NULL), 0) AS pending FROM users",
      ) as Row;
      const users = Number(row.users);
      const disabled = Number(row.disabled);
      const pending = Number(row.pending);
      return { users, active: users - disabled - pending, disabled, pending, sessions: this.count('SELECT count(*) AS n FROM sessions WHERE expires_at > ?', this.iso()) };
    });
  }

  readable(): boolean {
    try {
      // Una lectura de verdad de la base (no del archivo): comprueba que la conexión y el esquema responden.
      this.get('SELECT 1 AS n FROM meta LIMIT 1');
      this.get('SELECT 1 AS n FROM users LIMIT 1');
      return this.db.isOpen;
    } catch {
      return false;
    }
  }

  users(): AccountUser[] {
    return this.read(() => this.all(`SELECT ${USER_COLUMNS} FROM users u ORDER BY u.rowid`).map(toUser));
  }

  findUser(id: string): AccountUser | undefined {
    return this.read(() => this.userRow('u.id = ?', id));
  }

  findByLogin(login: string): AccountUser | undefined {
    return this.read(() => this.userRow('u.login_key = ?', loginKey(login)));
  }

  signIn(profile: GithubProfile, policy: SignInPolicy): AccountUser {
    return this.write(() => {
      const key = loginKey(profile.login);
      const known = this.userRow('u.github_id = ?', profile.id);
      const pending = this.userRow('u.github_id IS NULL AND u.login_key = ? AND u.id <> ?', key, known?.id ?? '');
      const user = known ?? pending;
      if (!user && policy.signup !== 'open' && !policy.admin) {
        throw new AccountError('not-invited', 'Esta instancia es solo por invitación: pide a quien la administra que te invite con tu nombre de usuario de GitHub.');
      }
      if (user?.disabled) throw new AccountError('disabled', 'Un administrador desactivó esta cuenta.');
      // Una persona conocida que entra con el nombre al que habían invitado hereda lo invitado, y la invitación desaparece.
      if (known && pending) this.mergePending(pending.id, known.id);
      // El nombre de usuario que dejó otra persona (cambió de nombre en GitHub) ya no es suyo: se aparta para que no haya dos con el mismo.
      for (const other of this.all('SELECT id, login, github_id FROM users WHERE login_key = ? AND id <> ?', key, user?.id ?? '')) {
        const apart = `${text(other.login)}~${other.github_id ?? text(other.id)}`;
        this.run('UPDATE users SET login = ?, login_key = ? WHERE id = ?', apart, loginKey(apart), text(other.id));
      }
      const now = this.iso();
      // Entrar por figurar en la lista de administradores no guarda el rol `admin` en la cuenta: lo da la lista (`Accounts.siteRoleOf`).
      const id = user?.id ?? newUserId();
      if (!user) this.run("INSERT INTO users (id, login, login_key, site_role, created_at) VALUES (?, ?, ?, 'member', ?)", id, profile.login, key, now);
      this.run('UPDATE users SET github_id = ?, login = ?, login_key = ?, name = ?, avatar_url = ?, last_login_at = ? WHERE id = ?', profile.id, profile.login, key, profile.name || null, profile.avatarUrl || null, now, id);
      return this.userRow('u.id = ?', id)!;
    });
  }

  /** Pasa lo invitado a una cuenta pendiente a la cuenta de quien ya entró (el rol mayor de los dos) y borra la invitación. Solo dentro de `write`. */
  private mergePending(pendingId: string, intoId: string): void {
    for (const invited of this.all('SELECT project_id, role FROM members WHERE user_id = ?', pendingId)) {
      const projectId = text(invited.project_id);
      const own = this.get('SELECT role FROM members WHERE project_id = ? AND user_id = ?', projectId, intoId);
      if (!own) this.run('UPDATE members SET user_id = ? WHERE project_id = ? AND user_id = ?', intoId, projectId, pendingId);
      else {
        if (ROLE_RANK[text(invited.role) as ProjectRole] > ROLE_RANK[text(own.role) as ProjectRole]) this.run('UPDATE members SET role = ? WHERE project_id = ? AND user_id = ?', text(invited.role), projectId, intoId);
        this.run('DELETE FROM members WHERE project_id = ? AND user_id = ?', projectId, pendingId);
      }
    }
    this.run('DELETE FROM users WHERE id = ?', pendingId);
  }

  private assertRoomForInvitation(): void {
    if (this.count('SELECT count(*) AS n FROM users WHERE github_id IS NULL') >= MAX_PENDING_USERS) {
      throw new AccountError('limit', `Hay ${MAX_PENDING_USERS} invitaciones sin aceptar: hace falta que alguien entre o que un administrador las cancele.`);
    }
  }

  private insertInvitation(login: string, siteRole: SiteRole): AccountUser {
    this.assertRoomForInvitation();
    const id = newUserId();
    this.run('INSERT INTO users (id, login, login_key, site_role, created_at) VALUES (?, ?, ?, ?, ?)', id, login, loginKey(login), siteRole, this.iso());
    return this.userRow('u.id = ?', id)!;
  }

  invite(loginInput: string, siteRole: SiteRole = 'guest'): AccountUser {
    const login = parseLogin(loginInput);
    if (!isSiteRole(siteRole)) throw new AccountError('invalid', `Rol inválido: use ${SITE_ROLES.join(', ')}.`);
    return this.write(() => this.userRow('u.login_key = ?', loginKey(login)) ?? this.insertInvitation(login, siteRole));
  }

  /** Aplica a una cuenta un cambio de rol de la instancia o de activación (desactivarla cierra todas sus sesiones). Solo dentro de `write`. */
  private applyUserChange(userId: string, change: UserChange): void {
    if (change.siteRole !== undefined) {
      if (!isSiteRole(change.siteRole)) throw new AccountError('invalid', `Rol inválido: use ${SITE_ROLES.join(', ')}.`);
      this.run('UPDATE users SET site_role = ? WHERE id = ?', change.siteRole, userId);
    }
    if (change.disabled !== undefined) {
      this.run('UPDATE users SET disabled = ? WHERE id = ?', change.disabled ? 1 : 0, userId);
      if (change.disabled) this.run('DELETE FROM sessions WHERE user_id = ?', userId);
    }
    if (change.quota !== undefined) {
      const quota = applyQuotaChange(this.userRow('u.id = ?', userId)?.quota, change.quota);
      this.run('UPDATE users SET quota_bytes = ?, quota_projects = ?, quota_diagrams = ? WHERE id = ?', quota?.bytes ?? null, quota?.projects ?? null, quota?.diagramsPerProject ?? null, userId);
    }
  }

  updateUser(id: string, change: UserChange): AccountUser {
    return this.write(() => {
      if (!this.userRow('u.id = ?', id)) throw new AccountError('not-found', 'No existe esa cuenta.');
      this.applyUserChange(id, change);
      return this.userRow('u.id = ?', id)!;
    });
  }

  upsertUser(loginInput: string, change: UserChange): { user: AccountUser; created: boolean } {
    const login = parseLogin(loginInput);
    return this.write(() => {
      const existing = this.userRow('u.login_key = ?', loginKey(login));
      const user = existing ?? this.insertInvitation(login, 'member');
      this.applyUserChange(user.id, change);
      return { user: this.userRow('u.id = ?', user.id)!, created: !existing };
    });
  }

  removePending(userId: string): void {
    this.write(() => {
      const user = this.userRow('u.id = ?', userId);
      if (!user) throw new AccountError('not-found', 'No existe esa cuenta.');
      if (user.githubId !== undefined) throw new AccountError('conflict', 'Esa persona ya entró: para quitarle el acceso, desactiva su cuenta.');
      this.run('DELETE FROM users WHERE id = ?', userId); // sus pertenencias y sesiones caen con ella (ON DELETE CASCADE)
    });
  }

  // ───── sesiones ─────

  createSession(userId: string, ttlMs: number): { token: string; expiresAt: string } {
    return this.write(() => {
      if (!this.get('SELECT 1 AS n FROM users WHERE id = ?', userId)) throw new AccountError('not-found', 'No existe esa cuenta.');
      const now = this.now();
      this.run('DELETE FROM sessions WHERE expires_at <= ?', now.toISOString());
      // Con demasiadas abiertas se cierran las más antiguas (las más cercanas a caducar).
      const own = this.all('SELECT hash FROM sessions WHERE user_id = ? ORDER BY expires_at, rowid', userId);
      for (const old of own.slice(0, Math.max(0, own.length - (MAX_SESSIONS_PER_USER - 1)))) this.run('DELETE FROM sessions WHERE hash = ?', text(old.hash));
      const token = generateSessionToken();
      const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
      this.run('INSERT INTO sessions (hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', hashSessionToken(token), userId, now.toISOString(), expiresAt);
      return { token, expiresAt };
    });
  }

  lookupSession(token: string): AccountUser | undefined {
    return this.read(() => {
      const row = this.get(`SELECT ${USER_COLUMNS} FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.hash = ? AND s.expires_at > ? AND u.disabled = 0`, hashSessionToken(token), this.iso());
      return row ? toUser(row) : undefined;
    });
  }

  revokeSession(token: string): boolean {
    return this.write(() => this.run('DELETE FROM sessions WHERE hash = ?', hashSessionToken(token)) > 0);
  }

  sessionCount(userId: string): number {
    return this.read(() => this.count('SELECT count(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?', userId, this.iso()));
  }

  // ───── pertenencia a proyectos ─────

  roleOf(userId: string, projectId: string): ProjectRole | undefined {
    return this.read(() => {
      const row = this.get('SELECT role FROM members WHERE project_id = ? AND user_id = ?', projectId, userId);
      return row ? (text(row.role) as ProjectRole) : undefined;
    });
  }

  rolesOf(userId: string): Map<string, ProjectRole> {
    return this.read(() => new Map(this.all('SELECT project_id, role FROM members WHERE user_id = ? ORDER BY rowid', userId).map((row) => [text(row.project_id), text(row.role) as ProjectRole])));
  }

  membersOf(projectId: string): Array<{ user: AccountUser; role: ProjectRole; addedAt: string }> {
    return this.read(() =>
      this.all(`SELECT ${USER_COLUMNS}, m.role AS member_role, m.added_at AS member_added_at FROM members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY m.rowid`, projectId)
        .map((row) => ({ user: toUser(row), role: text(row.member_role) as ProjectRole, addedAt: text(row.member_added_at) }))
        .sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role] || a.user.login.localeCompare(b.user.login, undefined, { sensitivity: 'base' })),
    );
  }

  adminCount(userId: string): number {
    return this.read(() => this.count("SELECT count(*) AS n FROM members WHERE user_id = ? AND role = 'admin'", userId));
  }

  registerProject(projectId: string, ownerId: string): void {
    this.write(() => {
      if (!this.get('SELECT 1 AS n FROM users WHERE id = ?', ownerId)) throw new AccountError('not-found', 'No existe esa cuenta.');
      this.run('DELETE FROM members WHERE project_id = ?', projectId);
      this.run("INSERT INTO members (project_id, user_id, role, added_at) VALUES (?, ?, 'admin', ?)", projectId, ownerId, this.iso());
    });
  }

  /** Un proyecto no se queda sin quien lo administre: quitar o bajar de rol a su única persona administradora falla con `last-admin`. Solo dentro de `write`. */
  private assertKeepsAdmin(projectId: string, currentRole: ProjectRole, nextRole: ProjectRole | undefined): void {
    if (currentRole === 'admin' && nextRole !== 'admin' && this.count("SELECT count(*) AS n FROM members WHERE project_id = ? AND role = 'admin'", projectId) === 1) {
      throw new AccountError('last-admin', 'El proyecto se quedaría sin administrador: nombra antes a otra persona administradora.');
    }
  }

  /** Añade a alguien al proyecto o le cambia el rol; devuelve si es nuevo. Solo dentro de `write`. */
  private putMember(projectId: string, userId: string, role: ProjectRole): boolean {
    const found = this.get('SELECT role FROM members WHERE project_id = ? AND user_id = ?', projectId, userId);
    if (found) {
      this.assertKeepsAdmin(projectId, text(found.role) as ProjectRole, role);
      this.run('UPDATE members SET role = ? WHERE project_id = ? AND user_id = ?', role, projectId, userId);
      return false;
    }
    if (this.count('SELECT count(*) AS n FROM members WHERE project_id = ?', projectId) >= MAX_MEMBERS_PER_PROJECT) {
      throw new AccountError('limit', `Un proyecto admite hasta ${MAX_MEMBERS_PER_PROJECT} personas.`);
    }
    this.run('INSERT INTO members (project_id, user_id, role, added_at) VALUES (?, ?, ?, ?)', projectId, userId, role, this.iso());
    return true;
  }

  setMember(projectId: string, userId: string, role: ProjectRole): void {
    this.write(() => {
      if (!this.get('SELECT 1 AS n FROM users WHERE id = ?', userId)) throw new AccountError('not-found', 'No existe esa cuenta.');
      if (!isProjectRole(role)) throw new AccountError('invalid', `Rol inválido: use ${PROJECT_ROLES.join(', ')}.`);
      this.putMember(projectId, userId, role);
    });
  }

  shareProject(projectId: string, loginInput: string, role: ProjectRole, newUserSiteRole: SiteRole): { user: AccountUser; added: boolean; invited: boolean } {
    const login = parseLogin(loginInput);
    if (!isProjectRole(role)) throw new AccountError('invalid', `Rol inválido: use ${PROJECT_ROLES.join(', ')}.`);
    if (!isSiteRole(newUserSiteRole)) throw new AccountError('invalid', `Rol inválido: use ${SITE_ROLES.join(', ')}.`);
    return this.write(() => {
      const existing = this.userRow('u.login_key = ?', loginKey(login));
      const user = existing ?? this.insertInvitation(login, newUserSiteRole);
      const added = this.putMember(projectId, user.id, role);
      return { user, added, invited: !existing };
    });
  }

  removeMember(projectId: string, userId: string): boolean {
    return this.write(() => {
      const found = this.get('SELECT role FROM members WHERE project_id = ? AND user_id = ?', projectId, userId);
      if (!found) return false;
      this.assertKeepsAdmin(projectId, text(found.role) as ProjectRole, undefined);
      this.run('DELETE FROM members WHERE project_id = ? AND user_id = ?', projectId, userId);
      this.pruneInvitation(userId);
      return true;
    });
  }

  dropProject(projectId: string): void {
    this.write(() => {
      const former = this.all('SELECT user_id FROM members WHERE project_id = ?', projectId);
      if (former.length === 0) return;
      this.run('DELETE FROM members WHERE project_id = ?', projectId);
      for (const member of former) this.pruneInvitation(text(member.user_id));
    });
  }

  /** Cancela la invitación de invitado (cuenta pendiente con rol `guest`) que se quedó sin ningún proyecto. Solo dentro de `write`. */
  private pruneInvitation(userId: string): void {
    this.run("DELETE FROM users WHERE id = ? AND github_id IS NULL AND site_role = 'guest' AND NOT EXISTS (SELECT 1 FROM members WHERE user_id = users.id)", userId);
  }

  membershipCounts(): Map<string, number> {
    return this.read(() => new Map(this.all('SELECT user_id, count(*) AS n FROM members GROUP BY user_id').map((row) => [text(row.user_id), Number(row.n)])));
  }

  // ───── mantenimiento ─────

  snapshot(): AccountsFile {
    return this.snapshotRead(() => {
      const projects: Record<string, MemberRecord[]> = Object.create(null);
      for (const row of this.all('SELECT project_id, user_id, role, added_at FROM members ORDER BY rowid')) {
        (projects[text(row.project_id)] ??= []).push({ userId: text(row.user_id), role: text(row.role) as ProjectRole, addedAt: text(row.added_at) });
      }
      const sessions = this.all('SELECT hash, user_id, created_at, expires_at FROM sessions ORDER BY rowid').map(
        (row): SessionRecord => ({ hash: text(row.hash), userId: text(row.user_id), createdAt: text(row.created_at), expiresAt: text(row.expires_at) }),
      );
      return { version: ACCOUNTS_FILE_VERSION, users: this.all(`SELECT ${USER_COLUMNS} FROM users u ORDER BY u.rowid`).map(toUser), sessions, projects };
    });
  }

  /** Un metadato de la base (`meta`), o `undefined`. */
  meta(key: string): string | undefined {
    return this.read(() => {
      const row = this.get('SELECT value FROM meta WHERE key = ?', key);
      return row ? text(row.value) : undefined;
    });
  }

  /** ¿No hay ni cuentas, ni sesiones, ni pertenencias? (Una base recién creada, el único destino válido de una importación.) */
  isEmpty(): boolean {
    return this.read(() => this.count('SELECT (SELECT count(*) FROM users) + (SELECT count(*) FROM sessions) + (SELECT count(*) FROM members) AS n') === 0);
  }

  /**
   * Mete en una base vacía todo lo de un volcado (el JSON de cuentas ya validado), en una sola transacción: o entra entero o no entra
   * nada, y antes de confirmar comprueba que lo guardado cuadra con lo recibido. Con `provenance` anota de dónde salió. Falla con
   * `conflict` si la base ya tiene cuentas. Los instantes se guardan en su forma canónica.
   */
  importSnapshot(file: AccountsFile, provenance?: ImportProvenance): ImportCounts {
    return this.write(() => {
      if (!this.isEmpty()) throw new AccountError('conflict', 'La base de cuentas ya tiene datos: una importación no se mezcla con ellos.');
      for (const u of file.users) {
        this.run(
          'INSERT INTO users (id, login, login_key, github_id, name, avatar_url, site_role, disabled, created_at, last_login_at, quota_bytes, quota_projects, quota_diagrams) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          u.id, u.login, loginKey(u.login), u.githubId ?? null, u.name ?? null, u.avatarUrl ?? null, u.siteRole, u.disabled ? 1 : 0, canonicalIso(u.createdAt), u.lastLoginAt !== undefined ? canonicalIso(u.lastLoginAt) : null,
          u.quota?.bytes ?? null, u.quota?.projects ?? null, u.quota?.diagramsPerProject ?? null,
        );
      }
      for (const s of file.sessions) this.run('INSERT INTO sessions (hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', s.hash, s.userId, canonicalIso(s.createdAt), canonicalIso(s.expiresAt));
      let memberships = 0;
      let projects = 0;
      for (const [projectId, members] of Object.entries(file.projects)) {
        if (members.length > 0) projects++;
        for (const m of members) {
          this.run('INSERT INTO members (project_id, user_id, role, added_at) VALUES (?, ?, ?, ?)', projectId, m.userId, m.role, canonicalIso(m.addedAt));
          memberships++;
        }
      }
      const counts: ImportCounts = {
        users: this.count('SELECT count(*) AS n FROM users'),
        sessions: this.count('SELECT count(*) AS n FROM sessions'),
        memberships: this.count('SELECT count(*) AS n FROM members'),
        projects: this.count('SELECT count(DISTINCT project_id) AS n FROM members'),
      };
      if (counts.users !== file.users.length || counts.sessions !== file.sessions.length || counts.memberships !== memberships || counts.projects !== projects) {
        throw new AccountError('corrupt', 'La importación no cuadra con el archivo de origen (se deshace: la base queda como estaba).');
      }
      if (provenance) {
        this.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('imported_json_sha256', ?), ('imported_json_source', ?), ('imported_json_at', ?)", provenance.sha256, provenance.source, provenance.at);
      }
      return counts;
    });
  }

  /**
   * `PRAGMA integrity_check` sobre un archivo de base sin escribir en él (se abre solo para leer): `['ok']` si está sano. Sirve para
   * comprobar una copia de seguridad sin tocarla.
   */
  static checkFile(path: string): string[] {
    const { DatabaseSync } = loadSqlite();
    prepareFile(path, false);
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      return (db.prepare('PRAGMA integrity_check').all() as Row[]).map((row) => text(row.integrity_check));
    } catch (error) {
      throw openError(path, error);
    } finally {
      db?.close();
    }
  }

  /** Un resumen de la base (para `iark accounts info`). */
  info(): SqliteInfo {
    return this.snapshotRead(() => {
      const sha = this.get("SELECT value FROM meta WHERE key = 'imported_json_sha256'");
      const source = this.get("SELECT value FROM meta WHERE key = 'imported_json_source'");
      const at = this.get("SELECT value FROM meta WHERE key = 'imported_json_at'");
      return {
        path: this.path,
        schemaVersion: userVersion(this.db),
        latestSchemaVersion: this.latest,
        journalMode: text((this.get('PRAGMA journal_mode') as Row).journal_mode),
        synchronous: SYNCHRONOUS_NAMES[Number((this.get('PRAGMA synchronous') as Row).synchronous)] ?? 'desconocido',
        foreignKeys: Number((this.get('PRAGMA foreign_keys') as Row).foreign_keys) === 1,
        sizeBytes: statSync(this.path).size,
        users: this.count('SELECT count(*) AS n FROM users'),
        pending: this.count('SELECT count(*) AS n FROM users WHERE github_id IS NULL'),
        disabled: this.count('SELECT count(*) AS n FROM users WHERE disabled = 1'),
        sessions: this.count('SELECT count(*) AS n FROM sessions'),
        activeSessions: this.count('SELECT count(*) AS n FROM sessions WHERE expires_at > ?', this.iso()),
        memberships: this.count('SELECT count(*) AS n FROM members'),
        projects: this.count('SELECT count(DISTINCT project_id) AS n FROM members'),
        ...(sha && source && at ? { importedFrom: { sha256: text(sha.value), source: text(source.value), at: text(at.value) } } : {}),
      };
    });
  }

  /** `PRAGMA integrity_check`: `['ok']` si la base está sana, o una línea por problema. */
  integrityCheck(): string[] {
    return this.read(() => this.all('PRAGMA integrity_check').map((row) => text(row.integrity_check)));
  }

  /**
   * Una copia coherente de la base viva (`VACUUM INTO`: no hace falta parar el servicio ni copiar `-wal` a mano), con modo 0600. No
   * sobrescribe: si el destino existe, falla con `conflict`.
   */
  backupTo(destination: string): void {
    if (existsSync(destination)) throw new AccountError('conflict', `«${destination}» ya existe: elija otro nombre (una copia de seguridad no se sobrescribe).`);
    try {
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new AccountError('unavailable', `No se pudo crear la carpeta de la copia «${dirname(destination)}» (${errno(error) ?? (error as Error).message}).`);
    }
    this.read(() => void this.stmt('VACUUM INTO ?').run(destination));
    try {
      chmodSync(destination, 0o600);
    } catch (error) {
      throw new AccountError('unavailable', `La copia se hizo pero no se pudo restringir su modo «${destination}» (${errno(error) ?? (error as Error).message}).`);
    }
  }

  close(): void {
    if (!this.db.isOpen) return;
    this.statements.clear();
    this.db.close();
  }
}
