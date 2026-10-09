import {
  ACCOUNTS_FILE_VERSION,
  AccountError,
  applyQuotaChange,
  generateSessionToken,
  hashSessionToken,
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
  type AccountStore,
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
import { migrate, type PgMigration } from '../postgres/migrate';
import { DatabaseError, sqlState, type PostgresDatabase, type Tx } from '../postgres/pool';
import type { ImportCounts, ImportProvenance } from './sqliteStore';

/**
 * El almacén de cuentas en una base Postgres (`--accounts-store postgres`, con la conexión en `IARK_DATABASE_URL`: ver `docs/postgres.md`): el
 * de las instalaciones sin disco persistente (Render, Fly, Cloud Run…) o con varias réplicas, sobre Supabase, Neon, RDS o uno propio. Cumple
 * el mismo contrato que los demás (`AccountStore`) y la misma batería de pruebas (`tests/helpers/accountStoreContract.ts`).
 *
 * - **Transacciones y topes.** Cada método que escribe es una transacción (`db.transaction`) y empieza tomando UN candado de asesoramiento
 *   (`cuentas:escritura`, de los que duran hasta el fin de la transacción): las escrituras de cuentas y de pertenencia a proyectos se hacen de
 *   una en una, en esta máquina o en cualquier otra que use la misma base, como el `BEGIN IMMEDIATE` de SQLite. Con él, comprobar un tope
 *   (`MAX_MEMBERS_PER_PROJECT`, `MAX_PENDING_USERS`) o la regla de la última persona administradora y escribir son indivisibles: dos peticiones
 *   simultáneas, también de dos procesos, no se saltan el tope. Es un candado sin bloqueo de sesión (`pg_advisory_xact_lock`), así que sirve igual
 *   detrás del pooler de transacción de Supabase. Las cuentas se escriben poco; no hace falta más fino.
 *   Lo único que NO toma ese candado es abrir una sesión (la operación más frecuente: cada inicio de sesión): bloquea solo la fila de su cuenta
 *   (`SELECT … FOR UPDATE`), que es lo que serializa las sesiones de una misma persona (tope `MAX_SESSIONS_PER_USER`) y las ordena respecto a
 *   desactivarla o borrarla. Cerrar una sesión es un solo `DELETE`; las lecturas, una sola sentencia (o una transacción de lectura repetible
 *   para el volcado).
 * - **Solo hashes.** Del token de una sesión se guarda su sha256 y nada más (como en los otros almacenes): quien lea la base no puede usarlas.
 * - **Esquema.** Migraciones numeradas (`MIGRATIONS`, espacio `cuentas` en `iark.migraciones`; ver `postgres/migrate.ts`) en el esquema de IArk, con
 *   seguridad por filas sin políticas y sin permisos para `anon`/`authenticated` (lo hace `migrate`). Los instantes son `timestamptz`; el reloj es
 *   el del proceso (`options.now`), no el de la base, para que las pruebas lo controlen y todos los almacenes midan igual.
 * - **Errores.** Nunca sale un error de `pg` con su consulta o su cadena de conexión: la red o la base caída son `AccountError('unreachable')`
 *   (503 por HTTP), una base más nueva que este IArk es `corrupt`, y un choque que ni el reintento resuelve, `unreachable` también. Cualquier otro
 *   rechazo de la base (un disparador, un permiso) es `unavailable` (500 por HTTP, sin detallar a quien llama).
 */

const NAMESPACE = 'cuentas';
/** El candado de asesoramiento de las escrituras de cuentas y de pertenencia a proyectos. */
const WRITE_LOCK = 'cuentas:escritura';
/** Cuántas sesiones caducadas de cualquier cuenta se limpian de paso al abrir una (el resto de las de esa cuenta siempre se limpian). */
const CLEANUP_BATCH = 200;

// ───────────── el esquema y sus migraciones ─────────────

/**
 * Las migraciones, en orden. **Nunca se edita una ya publicada**: un cambio de esquema es una migración nueva al final. `{schema}` es el
 * esquema de IArk ya entrecomillado. `seq` hace de `rowid` de SQLite: el orden en que se crearon las filas (el que ven `users()` y `snapshot()`).
 */
export const MIGRATIONS: readonly PgMigration[] = [
  {
    version: 1,
    name: 'cuentas: esquema inicial (cuentas, sesiones, pertenencia a proyectos, cuota personal y metadatos)',
    up: [
      `create table {schema}.cuentas_users (
         id            text primary key,
         login         text not null,
         login_key     text not null unique,
         github_id     bigint unique,
         name          text,
         avatar_url    text,
         site_role     text not null check (site_role in ('admin', 'member', 'guest')),
         disabled      boolean not null default false,
         created_at    timestamptz not null,
         last_login_at timestamptz,
         quota_bytes    bigint check (quota_bytes is null or quota_bytes >= 0),
         quota_projects bigint check (quota_projects is null or quota_projects >= 0),
         quota_diagrams bigint check (quota_diagrams is null or quota_diagrams >= 0),
         seq           bigint generated always as identity
       )`,
      'create index cuentas_users_pending on {schema}.cuentas_users (id) where github_id is null',
      `create table {schema}.cuentas_sessions (
         hash       text primary key check (length(hash) = 64),
         user_id    text not null references {schema}.cuentas_users (id) on delete cascade,
         created_at timestamptz not null,
         expires_at timestamptz not null,
         seq        bigint generated always as identity
       )`,
      'create index cuentas_sessions_user on {schema}.cuentas_sessions (user_id, expires_at)',
      'create index cuentas_sessions_expires on {schema}.cuentas_sessions (expires_at)',
      `create table {schema}.cuentas_members (
         project_id text not null,
         user_id    text not null references {schema}.cuentas_users (id) on delete cascade,
         role       text not null check (role in ('viewer', 'editor', 'admin')),
         added_at   timestamptz not null,
         seq        bigint generated always as identity,
         primary key (project_id, user_id)
       )`,
      'create index cuentas_members_user on {schema}.cuentas_members (user_id)',
      `create table {schema}.cuentas_meta (
         key   text primary key,
         value text not null
       )`,
    ],
  },
];

// ───────────── filas ─────────────

interface UserRow {
  id: string;
  login: string;
  github_id: string | null;
  name: string | null;
  avatar_url: string | null;
  site_role: SiteRole;
  disabled: boolean;
  created_at: Date;
  last_login_at: Date | null;
  quota_bytes: string | null;
  quota_projects: string | null;
  quota_diagrams: string | null;
}

const USER_COLUMNS = 'u.id, u.login, u.github_id, u.name, u.avatar_url, u.site_role, u.disabled, u.created_at, u.last_login_at, u.quota_bytes, u.quota_projects, u.quota_diagrams';

const toUser = (r: UserRow): AccountUser => {
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
    createdAt: r.created_at.toISOString(),
    ...(r.last_login_at !== null ? { lastLoginAt: r.last_login_at.toISOString() } : {}),
  };
};

/** El instante en la forma canónica (`toISOString()`), la misma que guardan los otros almacenes. */
const canonicalIso = (value: string): string => new Date(Date.parse(value)).toISOString();

const count = (rows: Array<{ n: string }>): number => Number(rows[0]?.n ?? 0);

export interface PostgresStoreOptions extends AccountStoreOptions {
  /**
   * Qué hacer al cerrar el almacén con la conexión que se le dio: normalmente `releaseDatabase` (el pool es de todo el proceso y lo comparten
   * los almacenes de cuentas y de proyectos: se cierra con la última referencia). Sin él, el almacén no cierra nada. Se llama una sola vez,
   * también si `open` falla.
   */
  release?: () => void | Promise<void>;
}

export class PostgresAccountStore implements AccountStore {
  readonly kind = 'postgres' as const;
  /** `postgres://usuario@host:puerto/base` (sin contraseña) y el esquema. */
  readonly path: string;
  private readonly now: () => Date;
  private readonly users_: string;
  private readonly sessions_: string;
  private readonly members_: string;
  private readonly meta_: string;
  private closed = false;

  private constructor(
    private readonly db: PostgresDatabase,
    private readonly options: PostgresStoreOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.path = `${db.config.description} (esquema ${db.config.schema})`;
    this.users_ = db.table('cuentas_users');
    this.sessions_ = db.table('cuentas_sessions');
    this.members_ = db.table('cuentas_members');
    this.meta_ = db.table('cuentas_meta');
  }

  /**
   * Lleva el esquema de las cuentas a la última versión en esa base y devuelve el almacén. Falla con `AccountError` si la base no responde
   * (`unreachable`) o es de una versión más nueva de IArk (`corrupt`): así un servicio mal configurado no arranca. Si falla, suelta la conexión
   * (`options.release`); si no, la suelta `close()`.
   */
  static async open(db: PostgresDatabase, options: PostgresStoreOptions = {}): Promise<PostgresAccountStore> {
    const store = new PostgresAccountStore(db, options);
    try {
      await migrate(db, NAMESPACE, MIGRATIONS);
    } catch (error) {
      await store.close().catch(() => undefined);
      throw store.fail(error);
    }
    return store;
  }

  // ───── utilidades de acceso ─────

  /** Un error de la base como `AccountError` (sin la consulta ni la cadena de conexión); lo demás sube tal cual. */
  private fail(error: unknown): unknown {
    if (error instanceof AccountError) return error;
    if (error instanceof DatabaseError) {
      return new AccountError(error.code === 'incompatible' ? 'corrupt' : 'unreachable', error.message);
    }
    const state = sqlState(error);
    // Un choque que el candado no evitó (otro proceso con otra versión de IArk, una restricción de unicidad): se cuenta, no se esconde.
    if (state === '23505') return new AccountError('conflict', 'Otra petición cambió lo mismo a la vez: vuelva a intentarlo.');
    if (state === '23503') return new AccountError('not-found', 'No existe esa cuenta.');
    // Cualquier otro fallo de la base (un disparador, un disco lleno, un permiso): es del servicio, no de quien llama; por HTTP, un 500 que no lo detalla.
    if (state) return new AccountError('unavailable', `La base de cuentas rechazó la operación (${state}): ${(error as Error).message}`);
    return error;
  }

  /** Una lectura de una sola sentencia. */
  private async read<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw this.fail(error);
    }
  }

  /** Una escritura: una transacción que empieza tomando el candado de escritura. Si choca con otra se repite entera (`fn` no tiene efectos fuera de la base). */
  private async write<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.read(() =>
      this.db.transaction(async (tx) => {
        await tx.lock(WRITE_LOCK);
        return fn(tx);
      }),
    );
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private async userRow(q: Pick<Tx, 'query'>, where: string, params: readonly unknown[], lock = ''): Promise<AccountUser | undefined> {
    const rows = await q.query<UserRow>(`select ${USER_COLUMNS} from ${this.users_} u where ${where}${lock}`, params);
    return rows[0] ? toUser(rows[0]) : undefined;
  }

  // ───── personas ─────

  async userCount(): Promise<number> {
    return this.read(async () => count(await this.db.query<{ n: string }>(`select count(*) as n from ${this.users_}`)));
  }

  async stats(): Promise<AccountStats> {
    return this.read(async () => {
      // Una sola sentencia: los recuentos salen de la misma foto de la base.
      const [row] = await this.db.query<{ users: string; disabled: string; pending: string; sessions: string }>(
        `select count(*) as users,
                count(*) filter (where disabled) as disabled,
                count(*) filter (where not disabled and github_id is null) as pending,
                (select count(*) from ${this.sessions_} where expires_at > $1) as sessions
           from ${this.users_}`,
        [this.iso()],
      );
      const users = Number(row.users);
      const disabled = Number(row.disabled);
      const pending = Number(row.pending);
      return { users, active: users - disabled - pending, disabled, pending, sessions: Number(row.sessions) };
    });
  }

  async readable(): Promise<boolean> {
    if (this.closed) return false;
    try {
      // Una lectura de verdad del esquema (no solo un `select 1`): comprueba que la conexión, los permisos y las tablas responden.
      await this.db.query(`select 1 from ${this.users_} limit 1`);
      await this.db.query(`select 1 from ${this.meta_} limit 1`);
      return true;
    } catch {
      return false;
    }
  }

  async users(): Promise<AccountUser[]> {
    return this.read(async () => (await this.db.query<UserRow>(`select ${USER_COLUMNS} from ${this.users_} u order by u.seq`)).map(toUser));
  }

  async findUser(id: string): Promise<AccountUser | undefined> {
    return this.read(() => this.userRow(this.db, 'u.id = $1', [id]));
  }

  async findByLogin(login: string): Promise<AccountUser | undefined> {
    return this.read(() => this.userRow(this.db, 'u.login_key = $1', [loginKey(login)]));
  }

  async signIn(profile: GithubProfile, policy: SignInPolicy): Promise<AccountUser> {
    return this.write(async (tx) => {
      const key = loginKey(profile.login);
      const known = await this.userRow(tx, 'u.github_id = $1', [profile.id]);
      const pending = await this.userRow(tx, 'u.github_id is null and u.login_key = $1 and u.id <> $2', [key, known?.id ?? '']);
      const user = known ?? pending;
      if (!user && policy.signup !== 'open' && !policy.admin) {
        throw new AccountError('not-invited', 'Esta instancia es solo por invitación: pide a quien la administra que te invite con tu nombre de usuario de GitHub.');
      }
      if (user?.disabled) throw new AccountError('disabled', 'Un administrador desactivó esta cuenta.');
      // Una persona conocida que entra con el nombre al que habían invitado hereda lo invitado, y la invitación desaparece.
      if (known && pending) await this.mergePending(tx, pending.id, known.id);
      // El nombre de usuario que dejó otra persona (cambió de nombre en GitHub) ya no es suyo: se aparta para que no haya dos con el mismo.
      const others = await tx.query<{ id: string; login: string; github_id: string | null }>(`select id, login, github_id from ${this.users_} where login_key = $1 and id <> $2 order by seq`, [key, user?.id ?? '']);
      for (const other of others) {
        const apart = `${other.login}~${other.github_id ?? other.id}`;
        await tx.query(`update ${this.users_} set login = $1, login_key = $2 where id = $3`, [apart, loginKey(apart), other.id]);
      }
      const now = this.iso();
      // Entrar por figurar en la lista de administradores no guarda el rol `admin` en la cuenta: lo da la lista (`Accounts.siteRoleOf`).
      const id = user?.id ?? newUserId();
      if (!user) await tx.query(`insert into ${this.users_} (id, login, login_key, site_role, created_at) values ($1, $2, $3, 'member', $4)`, [id, profile.login, key, now]);
      await tx.query(`update ${this.users_} set github_id = $1, login = $2, login_key = $3, name = $4, avatar_url = $5, last_login_at = $6 where id = $7`, [profile.id, profile.login, key, profile.name || null, profile.avatarUrl || null, now, id]);
      return (await this.userRow(tx, 'u.id = $1', [id]))!;
    });
  }

  /** Pasa lo invitado a una cuenta pendiente a la cuenta de quien ya entró (el rol mayor de los dos) y borra la invitación. Solo con el candado de escritura. */
  private async mergePending(tx: Tx, pendingId: string, intoId: string): Promise<void> {
    const invited = await tx.query<{ project_id: string; role: ProjectRole }>(`select project_id, role from ${this.members_} where user_id = $1 order by seq`, [pendingId]);
    for (const m of invited) {
      const [own] = await tx.query<{ role: ProjectRole }>(`select role from ${this.members_} where project_id = $1 and user_id = $2`, [m.project_id, intoId]);
      if (!own) await tx.query(`update ${this.members_} set user_id = $1 where project_id = $2 and user_id = $3`, [intoId, m.project_id, pendingId]);
      else {
        if (ROLE_RANK[m.role] > ROLE_RANK[own.role]) await tx.query(`update ${this.members_} set role = $1 where project_id = $2 and user_id = $3`, [m.role, m.project_id, intoId]);
        await tx.query(`delete from ${this.members_} where project_id = $1 and user_id = $2`, [m.project_id, pendingId]);
      }
    }
    await tx.query(`delete from ${this.users_} where id = $1`, [pendingId]);
  }

  private async insertInvitation(tx: Tx, login: string, siteRole: SiteRole): Promise<AccountUser> {
    const [pending] = await tx.query<{ n: string }>(`select count(*) as n from ${this.users_} where github_id is null`);
    if (Number(pending.n) >= MAX_PENDING_USERS) {
      throw new AccountError('limit', `Hay ${MAX_PENDING_USERS} invitaciones sin aceptar: hace falta que alguien entre o que un administrador las cancele.`);
    }
    const id = newUserId();
    await tx.query(`insert into ${this.users_} (id, login, login_key, site_role, created_at) values ($1, $2, $3, $4, $5)`, [id, login, loginKey(login), siteRole, this.iso()]);
    return (await this.userRow(tx, 'u.id = $1', [id]))!;
  }

  async invite(loginInput: string, siteRole: SiteRole = 'guest'): Promise<AccountUser> {
    const login = parseLogin(loginInput);
    if (!isSiteRole(siteRole)) throw new AccountError('invalid', `Rol inválido: use ${SITE_ROLES.join(', ')}.`);
    return this.write(async (tx) => (await this.userRow(tx, 'u.login_key = $1', [loginKey(login)])) ?? this.insertInvitation(tx, login, siteRole));
  }

  /** Aplica a una cuenta (ya bloqueada) un cambio de rol de la instancia, de activación (desactivarla cierra todas sus sesiones) o de cuota. Solo dentro de `write`. */
  private async applyUserChange(tx: Tx, user: AccountUser, change: UserChange): Promise<void> {
    if (change.siteRole !== undefined) {
      if (!isSiteRole(change.siteRole)) throw new AccountError('invalid', `Rol inválido: use ${SITE_ROLES.join(', ')}.`);
      await tx.query(`update ${this.users_} set site_role = $1 where id = $2`, [change.siteRole, user.id]);
    }
    if (change.disabled !== undefined) {
      await tx.query(`update ${this.users_} set disabled = $1 where id = $2`, [change.disabled, user.id]);
      if (change.disabled) await tx.query(`delete from ${this.sessions_} where user_id = $1`, [user.id]);
    }
    if (change.quota !== undefined) {
      const quota = applyQuotaChange(user.quota, change.quota);
      await tx.query(`update ${this.users_} set quota_bytes = $1, quota_projects = $2, quota_diagrams = $3 where id = $4`, [quota?.bytes ?? null, quota?.projects ?? null, quota?.diagramsPerProject ?? null, user.id]);
    }
  }

  async updateUser(id: string, change: UserChange): Promise<AccountUser> {
    return this.write(async (tx) => {
      // La fila de la cuenta se bloquea: una sesión que se esté abriendo a la vez espera a que esto termine (y si se desactiva, se cierra con las demás).
      const user = await this.userRow(tx, 'u.id = $1', [id], ' for update');
      if (!user) throw new AccountError('not-found', 'No existe esa cuenta.');
      await this.applyUserChange(tx, user, change);
      return (await this.userRow(tx, 'u.id = $1', [id]))!;
    });
  }

  async upsertUser(loginInput: string, change: UserChange): Promise<{ user: AccountUser; created: boolean }> {
    const login = parseLogin(loginInput);
    return this.write(async (tx) => {
      const existing = await this.userRow(tx, 'u.login_key = $1', [loginKey(login)], ' for update');
      const user = existing ?? (await this.insertInvitation(tx, login, 'member'));
      await this.applyUserChange(tx, user, change);
      return { user: (await this.userRow(tx, 'u.id = $1', [user.id]))!, created: !existing };
    });
  }

  async removePending(userId: string): Promise<void> {
    await this.write(async (tx) => {
      const user = await this.userRow(tx, 'u.id = $1', [userId], ' for update');
      if (!user) throw new AccountError('not-found', 'No existe esa cuenta.');
      if (user.githubId !== undefined) throw new AccountError('conflict', 'Esa persona ya entró: para quitarle el acceso, desactiva su cuenta.');
      await tx.query(`delete from ${this.users_} where id = $1`, [userId]); // sus pertenencias y sesiones caen con ella (on delete cascade)
    });
  }

  // ───── sesiones ─────

  async createSession(userId: string, ttlMs: number): Promise<{ token: string; expiresAt: string }> {
    return this.read(() =>
      this.db.transaction(async (tx) => {
        // Sin el candado de escritura (cada inicio de sesión pasa por aquí): la fila de la cuenta basta para que las sesiones de una misma persona
        // vayan de una en una —el tope de `MAX_SESSIONS_PER_USER` no se salta con dos a la vez— y se ordenen respecto a desactivarla o borrarla.
        const [owner] = await tx.query<{ id: string }>(`select id from ${this.users_} where id = $1 for update`, [userId]);
        if (!owner) throw new AccountError('not-found', 'No existe esa cuenta.');
        const now = this.now();
        // Las caducadas de esta cuenta, siempre; las de las demás, de paso y por tandas, sin esperar a quien las esté tocando.
        await tx.query(`delete from ${this.sessions_} where user_id = $1 and expires_at <= $2`, [userId, now.toISOString()]);
        await tx.query(
          `delete from ${this.sessions_} where hash in (select hash from ${this.sessions_} where expires_at <= $1 order by expires_at limit ${CLEANUP_BATCH} for update skip locked)`,
          [now.toISOString()],
        );
        // Con demasiadas abiertas se cierran las más antiguas (las más cercanas a caducar).
        const own = await tx.query<{ hash: string }>(`select hash from ${this.sessions_} where user_id = $1 order by expires_at, seq`, [userId]);
        const stale = own.slice(0, Math.max(0, own.length - (MAX_SESSIONS_PER_USER - 1))).map((s) => s.hash);
        if (stale.length > 0) await tx.query(`delete from ${this.sessions_} where hash = any($1::text[])`, [stale]);
        const token = generateSessionToken();
        const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
        await tx.query(`insert into ${this.sessions_} (hash, user_id, created_at, expires_at) values ($1, $2, $3, $4)`, [hashSessionToken(token), userId, now.toISOString(), expiresAt]);
        return { token, expiresAt };
      }),
    );
  }

  async lookupSession(token: string): Promise<AccountUser | undefined> {
    return this.read(async () => {
      const rows = await this.db.query<UserRow>(
        `select ${USER_COLUMNS} from ${this.sessions_} s join ${this.users_} u on u.id = s.user_id where s.hash = $1 and s.expires_at > $2 and not u.disabled`,
        [hashSessionToken(token), this.iso()],
      );
      return rows[0] ? toUser(rows[0]) : undefined;
    });
  }

  async revokeSession(token: string): Promise<boolean> {
    return this.read(async () => (await this.db.query(`delete from ${this.sessions_} where hash = $1 returning hash`, [hashSessionToken(token)])).length > 0);
  }

  async sessionCount(userId: string): Promise<number> {
    return this.read(async () => count(await this.db.query<{ n: string }>(`select count(*) as n from ${this.sessions_} where user_id = $1 and expires_at > $2`, [userId, this.iso()])));
  }

  // ───── pertenencia a proyectos ─────

  async roleOf(userId: string, projectId: string): Promise<ProjectRole | undefined> {
    return this.read(async () => (await this.db.query<{ role: ProjectRole }>(`select role from ${this.members_} where project_id = $1 and user_id = $2`, [projectId, userId]))[0]?.role);
  }

  async rolesOf(userId: string): Promise<Map<string, ProjectRole>> {
    return this.read(async () => new Map((await this.db.query<{ project_id: string; role: ProjectRole }>(`select project_id, role from ${this.members_} where user_id = $1 order by seq`, [userId])).map((row) => [row.project_id, row.role])));
  }

  async membersOf(projectId: string): Promise<Array<{ user: AccountUser; role: ProjectRole; addedAt: string }>> {
    return this.read(async () =>
      (await this.db.query<UserRow & { member_role: ProjectRole; member_added_at: Date }>(
        `select ${USER_COLUMNS}, m.role as member_role, m.added_at as member_added_at from ${this.members_} m join ${this.users_} u on u.id = m.user_id where m.project_id = $1 order by m.seq`,
        [projectId],
      ))
        .map((row) => ({ user: toUser(row), role: row.member_role, addedAt: row.member_added_at.toISOString() }))
        .sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role] || a.user.login.localeCompare(b.user.login, undefined, { sensitivity: 'base' })),
    );
  }

  async adminCount(userId: string): Promise<number> {
    return this.read(async () => count(await this.db.query<{ n: string }>(`select count(*) as n from ${this.members_} where user_id = $1 and role = 'admin'`, [userId])));
  }

  async registerProject(projectId: string, ownerId: string): Promise<void> {
    await this.write(async (tx) => {
      if ((await tx.query(`select 1 from ${this.users_} where id = $1`, [ownerId])).length === 0) throw new AccountError('not-found', 'No existe esa cuenta.');
      await tx.query(`delete from ${this.members_} where project_id = $1`, [projectId]);
      await tx.query(`insert into ${this.members_} (project_id, user_id, role, added_at) values ($1, $2, 'admin', $3)`, [projectId, ownerId, this.iso()]);
    });
  }

  /** Un proyecto no se queda sin quien lo administre: quitar o bajar de rol a su única persona administradora falla con `last-admin`. Solo con el candado de escritura. */
  private async assertKeepsAdmin(tx: Tx, projectId: string, currentRole: ProjectRole, nextRole: ProjectRole | undefined): Promise<void> {
    if (currentRole !== 'admin' || nextRole === 'admin') return;
    // `for update` sobre las filas de administración del proyecto: aunque otro proceso escribiera sin el candado, no podría quitar a la otra a la vez.
    const admins = await tx.query(`select user_id from ${this.members_} where project_id = $1 and role = 'admin' for update`, [projectId]);
    if (admins.length === 1) throw new AccountError('last-admin', 'El proyecto se quedaría sin administrador: nombra antes a otra persona administradora.');
  }

  /** Añade a alguien al proyecto o le cambia el rol; devuelve si es nuevo. Solo con el candado de escritura. */
  private async putMember(tx: Tx, projectId: string, userId: string, role: ProjectRole): Promise<boolean> {
    const [found] = await tx.query<{ role: ProjectRole }>(`select role from ${this.members_} where project_id = $1 and user_id = $2`, [projectId, userId]);
    if (found) {
      await this.assertKeepsAdmin(tx, projectId, found.role, role);
      await tx.query(`update ${this.members_} set role = $1 where project_id = $2 and user_id = $3`, [role, projectId, userId]);
      return false;
    }
    const [members] = await tx.query<{ n: string }>(`select count(*) as n from ${this.members_} where project_id = $1`, [projectId]);
    if (Number(members.n) >= MAX_MEMBERS_PER_PROJECT) throw new AccountError('limit', `Un proyecto admite hasta ${MAX_MEMBERS_PER_PROJECT} personas.`);
    await tx.query(`insert into ${this.members_} (project_id, user_id, role, added_at) values ($1, $2, $3, $4)`, [projectId, userId, role, this.iso()]);
    return true;
  }

  async setMember(projectId: string, userId: string, role: ProjectRole): Promise<void> {
    await this.write(async (tx) => {
      if ((await tx.query(`select 1 from ${this.users_} where id = $1`, [userId])).length === 0) throw new AccountError('not-found', 'No existe esa cuenta.');
      if (!isProjectRole(role)) throw new AccountError('invalid', `Rol inválido: use ${PROJECT_ROLES.join(', ')}.`);
      await this.putMember(tx, projectId, userId, role);
    });
  }

  async shareProject(projectId: string, loginInput: string, role: ProjectRole, newUserSiteRole: SiteRole): Promise<{ user: AccountUser; added: boolean; invited: boolean }> {
    const login = parseLogin(loginInput);
    if (!isProjectRole(role)) throw new AccountError('invalid', `Rol inválido: use ${PROJECT_ROLES.join(', ')}.`);
    if (!isSiteRole(newUserSiteRole)) throw new AccountError('invalid', `Rol inválido: use ${SITE_ROLES.join(', ')}.`);
    return this.write(async (tx) => {
      const existing = await this.userRow(tx, 'u.login_key = $1', [loginKey(login)]);
      const user = existing ?? (await this.insertInvitation(tx, login, newUserSiteRole));
      const added = await this.putMember(tx, projectId, user.id, role);
      return { user, added, invited: !existing };
    });
  }

  async removeMember(projectId: string, userId: string): Promise<boolean> {
    return this.write(async (tx) => {
      const [found] = await tx.query<{ role: ProjectRole }>(`select role from ${this.members_} where project_id = $1 and user_id = $2`, [projectId, userId]);
      if (!found) return false;
      await this.assertKeepsAdmin(tx, projectId, found.role, undefined);
      await tx.query(`delete from ${this.members_} where project_id = $1 and user_id = $2`, [projectId, userId]);
      await this.pruneInvitation(tx, userId);
      return true;
    });
  }

  async dropProject(projectId: string): Promise<void> {
    await this.write(async (tx) => {
      const former = await tx.query<{ user_id: string }>(`select user_id from ${this.members_} where project_id = $1 order by seq`, [projectId]);
      if (former.length === 0) return;
      await tx.query(`delete from ${this.members_} where project_id = $1`, [projectId]);
      for (const member of former) await this.pruneInvitation(tx, member.user_id);
    });
  }

  /** Cancela la invitación de invitado (cuenta pendiente con rol `guest`) que se quedó sin ningún proyecto. Solo con el candado de escritura. */
  private async pruneInvitation(tx: Tx, userId: string): Promise<void> {
    await tx.query(`delete from ${this.users_} u where u.id = $1 and u.github_id is null and u.site_role = 'guest' and not exists (select 1 from ${this.members_} m where m.user_id = u.id)`, [userId]);
  }

  async membershipCounts(): Promise<Map<string, number>> {
    return this.read(async () => new Map((await this.db.query<{ user_id: string; n: string }>(`select user_id, count(*) as n from ${this.members_} group by user_id`)).map((row) => [row.user_id, Number(row.n)])));
  }

  // ───── mantenimiento ─────

  async snapshot(): Promise<AccountsFile> {
    // Una transacción de lectura repetible: las tres tablas se leen de la misma foto aunque otro proceso escriba en medio.
    return this.read(() =>
      this.db.transaction(
        async (tx) => {
          const users = (await tx.query<UserRow>(`select ${USER_COLUMNS} from ${this.users_} u order by u.seq`)).map(toUser);
          const sessions = (await tx.query<{ hash: string; user_id: string; created_at: Date; expires_at: Date }>(`select hash, user_id, created_at, expires_at from ${this.sessions_} order by seq`)).map(
            (row): SessionRecord => ({ hash: row.hash, userId: row.user_id, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString() }),
          );
          const projects: Record<string, MemberRecord[]> = Object.create(null);
          for (const row of await tx.query<{ project_id: string; user_id: string; role: ProjectRole; added_at: Date }>(`select project_id, user_id, role, added_at from ${this.members_} order by seq`)) {
            (projects[row.project_id] ??= []).push({ userId: row.user_id, role: row.role, addedAt: row.added_at.toISOString() });
          }
          return { version: ACCOUNTS_FILE_VERSION, users, sessions, projects };
        },
        { isolation: 'repeatable read' },
      ),
    );
  }

  /** Un metadato de la base (`cuentas_meta`), o `undefined`. */
  async meta(key: string): Promise<string | undefined> {
    return this.read(async () => (await this.db.query<{ value: string }>(`select value from ${this.meta_} where key = $1`, [key]))[0]?.value);
  }

  /** ¿No hay ni cuentas, ni sesiones, ni pertenencias? (Una base recién creada, el único destino válido de una importación.) */
  async isEmpty(): Promise<boolean> {
    return this.read(async () => count(await this.db.query<{ n: string }>(`select (select count(*) from ${this.users_}) + (select count(*) from ${this.sessions_}) + (select count(*) from ${this.members_}) as n`)) === 0);
  }

  /**
   * Mete en una base vacía todo lo de un volcado (el JSON de cuentas ya validado, o el de una base SQLite), en una sola transacción: o entra
   * entero o no entra nada, y antes de confirmar comprueba que lo guardado cuadra con lo recibido. Con `provenance` anota de dónde salió. Falla con
   * `conflict` si la base ya tiene cuentas. Los instantes se guardan en su forma canónica. Cada tabla entra con una sola sentencia (`unnest`): importar
   * miles de filas a una base remota no cuesta miles de viajes.
   */
  async importSnapshot(file: AccountsFile, provenance?: ImportProvenance): Promise<ImportCounts> {
    return this.write(async (tx) => {
      const [existing] = await tx.query<{ n: string }>(`select (select count(*) from ${this.users_}) + (select count(*) from ${this.sessions_}) + (select count(*) from ${this.members_}) as n`);
      if (Number(existing.n) !== 0) throw new AccountError('conflict', 'La base de cuentas ya tiene datos: una importación no se mezcla con ellos.');
      const users = file.users;
      if (users.length > 0) {
        await tx.query(
          `insert into ${this.users_} (id, login, login_key, github_id, name, avatar_url, site_role, disabled, created_at, last_login_at, quota_bytes, quota_projects, quota_diagrams)
           select id, login, login_key, github_id, name, avatar_url, site_role, disabled, created_at, last_login_at, quota_bytes, quota_projects, quota_diagrams
             from unnest($1::text[], $2::text[], $3::text[], $4::bigint[], $5::text[], $6::text[], $7::text[], $8::boolean[], $9::timestamptz[], $10::timestamptz[], $11::bigint[], $12::bigint[], $13::bigint[])
                  with ordinality as t(id, login, login_key, github_id, name, avatar_url, site_role, disabled, created_at, last_login_at, quota_bytes, quota_projects, quota_diagrams, ord)
            order by ord`,
          [
            users.map((u) => u.id),
            users.map((u) => u.login),
            users.map((u) => loginKey(u.login)),
            users.map((u) => u.githubId ?? null),
            users.map((u) => u.name ?? null),
            users.map((u) => u.avatarUrl ?? null),
            users.map((u) => u.siteRole),
            users.map((u) => !!u.disabled),
            users.map((u) => canonicalIso(u.createdAt)),
            users.map((u) => (u.lastLoginAt !== undefined ? canonicalIso(u.lastLoginAt) : null)),
            users.map((u) => u.quota?.bytes ?? null),
            users.map((u) => u.quota?.projects ?? null),
            users.map((u) => u.quota?.diagramsPerProject ?? null),
          ],
        );
      }
      const sessions = file.sessions;
      if (sessions.length > 0) {
        await tx.query(
          `insert into ${this.sessions_} (hash, user_id, created_at, expires_at)
           select hash, user_id, created_at, expires_at from unnest($1::text[], $2::text[], $3::timestamptz[], $4::timestamptz[]) with ordinality as t(hash, user_id, created_at, expires_at, ord) order by ord`,
          [sessions.map((s) => s.hash), sessions.map((s) => s.userId), sessions.map((s) => canonicalIso(s.createdAt)), sessions.map((s) => canonicalIso(s.expiresAt))],
        );
      }
      const members = Object.entries(file.projects).flatMap(([projectId, list]) => list.map((m) => ({ projectId, ...m })));
      if (members.length > 0) {
        await tx.query(
          `insert into ${this.members_} (project_id, user_id, role, added_at)
           select project_id, user_id, role, added_at from unnest($1::text[], $2::text[], $3::text[], $4::timestamptz[]) with ordinality as t(project_id, user_id, role, added_at, ord) order by ord`,
          [members.map((m) => m.projectId), members.map((m) => m.userId), members.map((m) => m.role), members.map((m) => canonicalIso(m.addedAt))],
        );
      }
      const [stored] = await tx.query<{ users: string; sessions: string; memberships: string; projects: string }>(
        `select (select count(*) from ${this.users_}) as users, (select count(*) from ${this.sessions_}) as sessions, (select count(*) from ${this.members_}) as memberships, (select count(distinct project_id) from ${this.members_}) as projects`,
      );
      const counts: ImportCounts = { users: Number(stored.users), sessions: Number(stored.sessions), memberships: Number(stored.memberships), projects: Number(stored.projects) };
      const projects = Object.values(file.projects).filter((list) => list.length > 0).length;
      if (counts.users !== users.length || counts.sessions !== sessions.length || counts.memberships !== members.length || counts.projects !== projects) {
        throw new AccountError('corrupt', 'La importación no cuadra con el archivo de origen (se deshace: la base queda como estaba).');
      }
      if (provenance) {
        await tx.query(
          `insert into ${this.meta_} (key, value) values ('imported_json_sha256', $1), ('imported_json_source', $2), ('imported_json_at', $3)
           on conflict (key) do update set value = excluded.value`,
          [provenance.sha256, provenance.source, provenance.at],
        );
      }
      return counts;
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.options.release?.();
  }
}
