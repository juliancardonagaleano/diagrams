import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Cuentas de `iark serve` con inicio de sesión de GitHub: las personas que han entrado, sus sesiones y a qué proyectos
 * pertenecen. Un único archivo JSON (`--accounts <archivo>`) que solo escribe el propio servicio:
 *
 *   { "version": 1,
 *     "users":    [{ "id": "u_…", "login": "ana", "githubId": 583231, "name": "Ana", "avatarUrl": "https://…", "siteRole": "member",
 *                    "disabled"?: true, "createdAt": "<ISO>", "lastLoginAt"?: "<ISO>" }],
 *     "sessions": [{ "hash": "<sha256 del token en hex>", "userId": "u_…", "createdAt": "<ISO>", "expiresAt": "<ISO>" }],
 *     "projects": { "<id del proyecto>": [{ "userId": "u_…", "role": "viewer" | "editor" | "admin", "addedAt": "<ISO>" }] } }
 *
 * - El token de una sesión nunca se guarda: solo su hash (sha256), como en el archivo de tokens. Quien lea el archivo no puede usarlas.
 * - Una persona se identifica por su id numérico de GitHub (el nombre de usuario puede cambiar o pasar a otra persona). Una cuenta
 *   «pendiente» (`githubId` ausente) es una invitación por nombre de usuario: la reclama quien entre con ese nombre.
 * - El archivo es la memoria del servicio, no una configuración: se lee entero al arrancar (si está dañado el servicio no arranca, nunca
 *   se abre ni se reemplaza) y no se vuelve a leer, así que no debe editarse con el servicio en marcha. Se escribe de forma atómica
 *   (temporal + `rename`), con modo 0600, y un cambio que no se pudo guardar se deshace en memoria. Solo hay un proceso escritor:
 *   no admite varias réplicas sobre el mismo archivo.
 * Solo usa `node:` (nada de dependencias).
 */

export const SITE_ROLES = ['admin', 'member', 'guest'] as const;
/** `admin` administra la instancia y ve todos los proyectos; `member` puede crear proyectos; `guest` solo entra a los proyectos a los que le invitaron. */
export type SiteRole = (typeof SITE_ROLES)[number];
export const isSiteRole = (value: unknown): value is SiteRole => typeof value === 'string' && (SITE_ROLES as readonly string[]).includes(value);

export const PROJECT_ROLES = ['viewer', 'editor', 'admin'] as const;
/** `viewer` lee; `editor` además guarda y borra diagramas y renombra; `admin` además borra el proyecto y gestiona quién entra. */
export type ProjectRole = (typeof PROJECT_ROLES)[number];
export const isProjectRole = (value: unknown): value is ProjectRole => typeof value === 'string' && (PROJECT_ROLES as readonly string[]).includes(value);

const ROLE_RANK: Record<ProjectRole, number> = { viewer: 0, editor: 1, admin: 2 };
export const projectRoleAllows = (role: ProjectRole, needed: ProjectRole): boolean => ROLE_RANK[role] >= ROLE_RANK[needed];

export const ACCOUNTS_FILE_VERSION = 1;
/** Prefijo de los tokens de sesión (el de los tokens de `iark auth` es `iark_`): el servidor sabe dónde buscar cada uno sin probar los dos. */
export const SESSION_PREFIX = 'iark_s_';

export const MAX_SESSIONS_PER_USER = 20;
export const MAX_MEMBERS_PER_PROJECT = 100;
/** Cuentas pendientes (invitaciones) a la vez: acota lo que una persona con permiso de invitar puede llenar. */
export const MAX_PENDING_USERS = 500;

export interface AccountUser {
  id: string;
  login: string;
  /** Ausente en una cuenta pendiente (invitada por nombre de usuario, todavía sin entrar). */
  githubId?: number;
  name?: string;
  avatarUrl?: string;
  siteRole: SiteRole;
  disabled?: boolean;
  createdAt: string;
  lastLoginAt?: string;
}

export interface SessionRecord {
  hash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export interface MemberRecord {
  userId: string;
  role: ProjectRole;
  addedAt: string;
}

export interface AccountsFile {
  version: typeof ACCOUNTS_FILE_VERSION;
  users: AccountUser[];
  sessions: SessionRecord[];
  projects: Record<string, MemberRecord[]>;
}

/** Lo que cuenta GitHub de una persona (ver `GithubOAuth.profileFromCode`). */
export interface GithubProfile {
  id: number;
  login: string;
  name?: string;
  avatarUrl?: string;
}

export type AccountErrorCode =
  /** Nombre de usuario, rol o dato que no se pueden aceptar. */
  | 'invalid'
  /** No existe la cuenta, la sesión o el proyecto. */
  | 'not-found'
  /** La instancia es solo por invitación y esa persona no está invitada. */
  | 'not-invited'
  /** Un administrador desactivó la cuenta. */
  | 'disabled'
  /** Se llegó a un tope (miembros de un proyecto, invitaciones pendientes). */
  | 'limit'
  /** El archivo existe pero no es un archivo de cuentas válido. */
  | 'corrupt'
  /** No se puede leer o escribir (permisos, disco, no es un archivo). */
  | 'unavailable';

export class AccountError extends Error {
  constructor(
    readonly code: AccountErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AccountError';
  }
}

// ───────────── nombres, ids y tokens ─────────────

/**
 * Un nombre de usuario de GitHub: letras y dígitos con guiones sueltos, hasta 39 caracteres (las apps acaban en `[bot]`: no entran
 * como personas). Se admite también `_`, que usan las cuentas gestionadas de GitHub Enterprise.
 */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9_]|-(?=[A-Za-z0-9_])){0,38}$/;

export const isGithubLogin = (value: unknown): value is string => typeof value === 'string' && LOGIN.test(value);

/** El nombre de usuario como clave de comparación: GitHub no distingue mayúsculas. */
export const loginKey = (login: string): string => login.toLowerCase();

export function parseLogin(value: unknown): string {
  const login = typeof value === 'string' ? value.trim().replace(/^@/, '') : '';
  if (!isGithubLogin(login)) throw new AccountError('invalid', `«${String(value ?? '').slice(0, 60)}» no es un nombre de usuario de GitHub (letras, números y guiones, hasta 39 caracteres).`);
  return login;
}

const newUserId = (): string => `u_${randomBytes(12).toString('base64url')}`;

/** Un token de sesión nuevo: `iark_s_` y 32 bytes aleatorios en base64url (256 bits). */
export const generateSessionToken = (): string => `${SESSION_PREFIX}${randomBytes(32).toString('base64url')}`;

export const hashSessionToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

// ───────────── el archivo ─────────────

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const corrupt = (reason: string): AccountError => new AccountError('corrupt', `El archivo de cuentas no es válido (${reason}).`);
const HASH = /^[0-9a-f]{64}$/;
const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;
const isIso = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const optionalText = (value: unknown, at: string, what: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw corrupt(`${at}: «${what}» debe ser un texto`);
  return value;
};

/** Interpreta el contenido del archivo. Estricto a propósito: ante la menor duda lo rechaza entero y el servicio no arranca. Los motivos nunca citan el contenido. */
export function parseAccountsFile(text: string): AccountsFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw corrupt('no es un JSON válido');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw corrupt('la raíz debe ser un objeto');
  const { version, users, sessions, projects } = value as Record<string, unknown>;
  if (version !== ACCOUNTS_FILE_VERSION) throw corrupt(`versión no admitida; se esperaba ${ACCOUNTS_FILE_VERSION}`);
  if (!Array.isArray(users)) throw corrupt('falta la lista "users"');
  if (!Array.isArray(sessions)) throw corrupt('falta la lista "sessions"');
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) throw corrupt('falta el objeto "projects"');

  const ids = new Set<string>();
  const githubIds = new Set<number>();
  const logins = new Set<string>();
  const parsedUsers = users.map((entry: unknown, index): AccountUser => {
    const at = `users[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw corrupt(`${at} debe ser un objeto`);
    const { id, login, githubId, name, avatarUrl, siteRole, disabled, createdAt, lastLoginAt } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !id) throw corrupt(`${at}: falta "id"`);
    if (typeof login !== 'string' || !login.trim()) throw corrupt(`${at}: falta "login"`);
    if (githubId !== undefined && (typeof githubId !== 'number' || !Number.isSafeInteger(githubId) || githubId <= 0)) throw corrupt(`${at}: "githubId" debe ser un entero positivo`);
    if (!isSiteRole(siteRole)) throw corrupt(`${at}: "siteRole" debe ser ${SITE_ROLES.join(', ')}`);
    if (disabled !== undefined && typeof disabled !== 'boolean') throw corrupt(`${at}: "disabled" debe ser verdadero o falso`);
    if (!isIso(createdAt)) throw corrupt(`${at}: "createdAt" debe ser una fecha ISO 8601`);
    if (lastLoginAt !== undefined && !isIso(lastLoginAt)) throw corrupt(`${at}: "lastLoginAt" debe ser una fecha ISO 8601`);
    if (ids.has(id)) throw corrupt(`${at}: id repetido`);
    if (githubId !== undefined && githubIds.has(githubId)) throw corrupt(`${at}: githubId repetido`);
    if (logins.has(loginKey(login))) throw corrupt(`${at}: login repetido`);
    ids.add(id);
    if (githubId !== undefined) githubIds.add(githubId);
    logins.add(loginKey(login));
    return {
      id,
      login,
      ...(githubId !== undefined ? { githubId } : {}),
      ...(optionalText(name, at, 'name') !== undefined ? { name: name as string } : {}),
      ...(optionalText(avatarUrl, at, 'avatarUrl') !== undefined ? { avatarUrl: avatarUrl as string } : {}),
      siteRole,
      ...(disabled ? { disabled: true } : {}),
      createdAt,
      ...(lastLoginAt !== undefined ? { lastLoginAt } : {}),
    };
  });

  const hashes = new Set<string>();
  const parsedSessions = sessions.map((entry: unknown, index): SessionRecord => {
    const at = `sessions[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw corrupt(`${at} debe ser un objeto`);
    const { hash, userId, createdAt, expiresAt } = entry as Record<string, unknown>;
    if (typeof hash !== 'string' || !HASH.test(hash)) throw corrupt(`${at}: "hash" debe ser un sha256 en hexadecimal minúscula`);
    if (typeof userId !== 'string' || !ids.has(userId)) throw corrupt(`${at}: "userId" no es el de ninguna cuenta`);
    if (!isIso(createdAt) || !isIso(expiresAt)) throw corrupt(`${at}: las fechas deben ser ISO 8601`);
    if (hashes.has(hash)) throw corrupt(`${at}: hash repetido`);
    hashes.add(hash);
    return { hash, userId, createdAt, expiresAt };
  });

  const parsedProjects: Record<string, MemberRecord[]> = Object.create(null);
  for (const [projectId, list] of Object.entries(projects as Record<string, unknown>)) {
    const at = `projects.${projectId.slice(0, 60)}`;
    if (!Array.isArray(list)) throw corrupt(`${at} debe ser una lista`);
    const members = new Set<string>();
    parsedProjects[projectId] = list.map((entry: unknown, index): MemberRecord => {
      const where = `${at}[${index}]`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw corrupt(`${where} debe ser un objeto`);
      const { userId, role, addedAt } = entry as Record<string, unknown>;
      if (typeof userId !== 'string' || !ids.has(userId)) throw corrupt(`${where}: "userId" no es el de ninguna cuenta`);
      if (!isProjectRole(role)) throw corrupt(`${where}: "role" debe ser ${PROJECT_ROLES.join(', ')}`);
      if (!isIso(addedAt)) throw corrupt(`${where}: "addedAt" debe ser una fecha ISO 8601`);
      if (members.has(userId)) throw corrupt(`${where}: miembro repetido`);
      members.add(userId);
      return { userId, role, addedAt };
    });
  }
  return { version: ACCOUNTS_FILE_VERSION, users: parsedUsers, sessions: parsedSessions, projects: parsedProjects };
}

function readFileText(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    if (errno(error) === 'ENOENT') return undefined;
    throw new AccountError('unavailable', `No se pudo leer el archivo de cuentas «${path}» (${errno(error) ?? (error as Error).message}).`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new AccountError('unavailable', `«${path}» no es un archivo (¿una carpeta? Con Docker, montar un archivo que no existía crea una carpeta con ese nombre).`);
    if (stat.size > MAX_FILE_BYTES) throw corrupt(`pasa de ${MAX_FILE_BYTES} bytes`);
    return readFileSync(fd, 'utf8');
  } catch (error) {
    if (error instanceof AccountError) throw error;
    throw new AccountError('unavailable', `No se pudo leer el archivo de cuentas «${path}» (${errno(error) ?? (error as Error).message}).`);
  } finally {
    closeSync(fd);
  }
}

/** Escribe de forma atómica (a un temporal del mismo directorio y `rename`: quien lo lea nunca ve la mitad) y con modo 0600. */
function writeFileAtomic(path: string, file: AccountsFile): void {
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  let fd: number | undefined;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    fd = openSync(tmp, 'wx', 0o600);
    writeSync(fd, `${JSON.stringify(file, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ya estaba cerrado
      }
    }
    rmSync(tmp, { force: true });
    throw new AccountError('unavailable', `No se pudo escribir el archivo de cuentas «${path}» (${errno(error) ?? (error as Error).message}).`);
  }
}

// ───────────── el almacén ─────────────

export interface AccountStoreOptions {
  /** El reloj (en las pruebas, uno falso). */
  now?: () => Date;
}

export interface SignInPolicy {
  /** `open`: cualquiera con cuenta de GitHub entra como `member`. `invite`: solo quien ya tiene cuenta (invitada) o es administrador. */
  signup: 'open' | 'invite';
  /** Esa persona figura en la lista de administradores de la instancia (`--admins`). */
  admin: boolean;
}

export class AccountStore {
  private state: AccountsFile;
  private sessionsByHash = new Map<string, SessionRecord>();
  private usersById = new Map<string, AccountUser>();
  private readonly now: () => Date;

  private constructor(
    readonly path: string,
    state: AccountsFile,
    options: AccountStoreOptions,
  ) {
    this.state = state;
    this.now = options.now ?? (() => new Date());
    this.reindex();
  }

  /**
   * Abre el archivo (o lo crea vacío si no existe, que también comprueba que se puede escribir). Falla con `AccountError` si está
   * dañado o no se puede usar: así un servicio mal configurado no arranca en vez de olvidar a todo el mundo.
   */
  static open(path: string, options: AccountStoreOptions = {}): AccountStore {
    const text = readFileText(path);
    if (text === undefined) {
      const empty: AccountsFile = { version: ACCOUNTS_FILE_VERSION, users: [], sessions: [], projects: Object.create(null) };
      writeFileAtomic(path, empty);
      return new AccountStore(path, empty, options);
    }
    return new AccountStore(path, parseAccountsFile(text), options);
  }

  private reindex(): void {
    this.sessionsByHash = new Map(this.state.sessions.map((s) => [s.hash, s]));
    this.usersById = new Map(this.state.users.map((u) => [u.id, u]));
  }

  /** Aplica un cambio y lo guarda; si no se puede guardar, el cambio se deshace y el error sube (nunca queda en memoria algo que el disco no tiene). */
  private commit<T>(change: () => T): T {
    const before = JSON.stringify(this.state);
    try {
      const result = change();
      writeFileAtomic(this.path, this.state);
      this.reindex();
      return result;
    } catch (error) {
      this.state = parseAccountsFile(before);
      this.reindex();
      throw error;
    }
  }

  // ───── personas ─────

  get userCount(): number {
    return this.state.users.length;
  }

  users(): AccountUser[] {
    return this.state.users.map((u) => ({ ...u }));
  }

  findUser(id: string): AccountUser | undefined {
    const found = this.usersById.get(id);
    return found ? { ...found } : undefined;
  }

  findByLogin(login: string): AccountUser | undefined {
    const key = loginKey(login);
    const found = this.state.users.find((u) => loginKey(u.login) === key);
    return found ? { ...found } : undefined;
  }

  /**
   * Una persona entra con su perfil de GitHub. Se la reconoce por su id de GitHub; si no, por una invitación pendiente a su nombre
   * de usuario (que así queda reclamada); si no, solo entra si la instancia está abierta o es administradora. Actualiza su nombre
   * de usuario, nombre y foto. Falla con `not-invited` o `disabled`.
   */
  signIn(profile: GithubProfile, policy: SignInPolicy): AccountUser {
    return this.commit(() => {
      let user = this.state.users.find((u) => u.githubId === profile.id);
      const pending = this.state.users.find((u) => u !== user && u.githubId === undefined && loginKey(u.login) === loginKey(profile.login));
      if (user && pending) this.mergePending(pending, user);
      else if (!user && pending) user = pending;
      if (!user) {
        if (policy.signup !== 'open' && !policy.admin) {
          throw new AccountError('not-invited', 'Esta instancia es solo por invitación: pide a quien la administra que te invite con tu nombre de usuario de GitHub.');
        }
        // Entrar por figurar en la lista de administradores no guarda el rol `admin` en la cuenta: lo da la lista (`Accounts.siteRoleOf`), así que quitar a alguien de ella le quita el rol.
        user = { id: newUserId(), login: profile.login, siteRole: 'member', createdAt: this.now().toISOString() };
        this.state.users.push(user);
      }
      if (user.disabled) throw new AccountError('disabled', 'Un administrador desactivó esta cuenta.');
      // El nombre de usuario que dejó otra persona (cambió de nombre en GitHub) ya no es suyo: se aparta para que no haya dos con el mismo.
      for (const other of this.state.users) {
        if (other !== user && loginKey(other.login) === loginKey(profile.login)) other.login = `${other.login}~${other.githubId ?? other.id}`;
      }
      user.githubId = profile.id;
      user.login = profile.login;
      if (profile.name) user.name = profile.name;
      else delete user.name;
      if (profile.avatarUrl) user.avatarUrl = profile.avatarUrl;
      else delete user.avatarUrl;
      user.lastLoginAt = this.now().toISOString();
      return { ...user };
    });
  }

  /** Una persona ya conocida entra con el nombre de usuario al que habían invitado: lo invitado pasa a su cuenta y la invitación desaparece. */
  private mergePending(pending: AccountUser, into: AccountUser): void {
    for (const [projectId, members] of Object.entries(this.state.projects)) {
      const invited = members.find((m) => m.userId === pending.id);
      if (!invited) continue;
      const own = members.find((m) => m.userId === into.id);
      if (!own) invited.userId = into.id;
      else {
        if (ROLE_RANK[invited.role] > ROLE_RANK[own.role]) own.role = invited.role;
        this.state.projects[projectId] = members.filter((m) => m !== invited);
      }
    }
    this.state.users = this.state.users.filter((u) => u !== pending);
  }

  /**
   * Una cuenta pendiente: invita a ese nombre de usuario sin que haya entrado todavía (o actualiza su rol si ya existe). Entra con
   * ese rol cuando se identifique con GitHub.
   */
  invite(loginInput: string, siteRole: SiteRole = 'guest'): AccountUser {
    const login = parseLogin(loginInput);
    return this.commit(() => {
      const existing = this.state.users.find((u) => loginKey(u.login) === loginKey(login));
      if (existing) return { ...existing };
      if (this.state.users.filter((u) => u.githubId === undefined).length >= MAX_PENDING_USERS) {
        throw new AccountError('limit', `Hay ${MAX_PENDING_USERS} invitaciones sin aceptar: hace falta que alguien entre o que un administrador las limpie.`);
      }
      const user: AccountUser = { id: newUserId(), login, siteRole, createdAt: this.now().toISOString() };
      this.state.users.push(user);
      return { ...user };
    });
  }

  /** Cambia el rol de la instancia o activa o desactiva una cuenta (desactivarla cierra todas sus sesiones). */
  updateUser(id: string, change: { siteRole?: SiteRole; disabled?: boolean }): AccountUser {
    return this.commit(() => {
      const user = this.usersById.get(id);
      if (!user) throw new AccountError('not-found', 'No existe esa cuenta.');
      if (change.siteRole !== undefined) {
        if (!isSiteRole(change.siteRole)) throw new AccountError('invalid', `Rol inválido: use ${SITE_ROLES.join(', ')}.`);
        user.siteRole = change.siteRole;
      }
      if (change.disabled !== undefined) {
        if (change.disabled) {
          user.disabled = true;
          this.state.sessions = this.state.sessions.filter((s) => s.userId !== id);
        } else delete user.disabled;
      }
      return { ...user };
    });
  }

  // ───── sesiones ─────

  /** Abre una sesión: devuelve el token (la única vez que se conoce; en el archivo solo queda su hash). */
  createSession(userId: string, ttlMs: number): { token: string; expiresAt: string } {
    return this.commit(() => {
      const user = this.usersById.get(userId);
      if (!user) throw new AccountError('not-found', 'No existe esa cuenta.');
      const now = this.now();
      this.state.sessions = this.state.sessions.filter((s) => Date.parse(s.expiresAt) > now.getTime());
      const own = this.state.sessions.filter((s) => s.userId === userId);
      // Con demasiadas abiertas se cierran las más antiguas (las más cercanas a caducar).
      for (const old of own.sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt)).slice(0, Math.max(0, own.length - (MAX_SESSIONS_PER_USER - 1)))) {
        this.state.sessions = this.state.sessions.filter((s) => s !== old);
      }
      const token = generateSessionToken();
      const record: SessionRecord = { hash: hashSessionToken(token), userId, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttlMs).toISOString() };
      this.state.sessions.push(record);
      return { token, expiresAt: record.expiresAt };
    });
  }

  /** La cuenta dueña de ese token de sesión, si la sesión sigue vigente y la cuenta no está desactivada. */
  lookupSession(token: string): AccountUser | undefined {
    const session = this.sessionsByHash.get(hashSessionToken(token));
    if (!session || Date.parse(session.expiresAt) <= this.now().getTime()) return undefined;
    const user = this.usersById.get(session.userId);
    return user && !user.disabled ? { ...user } : undefined;
  }

  /** Cierra la sesión de ese token (no falla si ya no existía). */
  revokeSession(token: string): boolean {
    const hash = hashSessionToken(token);
    if (!this.sessionsByHash.has(hash)) return false;
    this.commit(() => {
      this.state.sessions = this.state.sessions.filter((s) => s.hash !== hash);
    });
    return true;
  }

  /** Sesiones abiertas de una cuenta (sin contar las caducadas). */
  sessionCount(userId: string): number {
    const now = this.now().getTime();
    return this.state.sessions.filter((s) => s.userId === userId && Date.parse(s.expiresAt) > now).length;
  }

  // ───── pertenencia a proyectos ─────

  /** El rol de una persona en un proyecto, o `undefined` si no pertenece a él. */
  roleOf(userId: string, projectId: string): ProjectRole | undefined {
    return this.state.projects[projectId]?.find((m) => m.userId === userId)?.role;
  }

  /** Los proyectos a los que pertenece una persona, con su rol. */
  rolesOf(userId: string): Map<string, ProjectRole> {
    const roles = new Map<string, ProjectRole>();
    for (const [projectId, members] of Object.entries(this.state.projects)) {
      const found = members.find((m) => m.userId === userId);
      if (found) roles.set(projectId, found.role);
    }
    return roles;
  }

  /** Quién pertenece al proyecto y con qué rol (los administradores primero, luego por nombre de usuario). */
  membersOf(projectId: string): Array<{ user: AccountUser; role: ProjectRole; addedAt: string }> {
    const found: Array<{ user: AccountUser; role: ProjectRole; addedAt: string }> = [];
    for (const member of this.state.projects[projectId] ?? []) {
      const user = this.usersById.get(member.userId);
      if (user) found.push({ user: { ...user }, role: member.role, addedAt: member.addedAt });
    }
    return found.sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role] || a.user.login.localeCompare(b.user.login, undefined, { sensitivity: 'base' }));
  }

  /** Cuántos proyectos administra esa persona (para el tope de proyectos por persona). */
  adminCount(userId: string): number {
    return [...this.rolesOf(userId).values()].filter((role) => role === 'admin').length;
  }

  /**
   * Registra un proyecto recién creado con una persona como administradora. Reemplaza lo que hubiera con ese id: es de un proyecto
   * anterior que ya no existe (borrado a mano de la carpeta), y no debe heredar sus miembros.
   */
  registerProject(projectId: string, ownerId: string): void {
    this.commit(() => {
      if (!this.usersById.has(ownerId)) throw new AccountError('not-found', 'No existe esa cuenta.');
      this.state.projects[projectId] = [{ userId: ownerId, role: 'admin', addedAt: this.now().toISOString() }];
    });
  }

  /** Añade a alguien al proyecto o cambia su rol. */
  setMember(projectId: string, userId: string, role: ProjectRole): void {
    this.commit(() => {
      if (!this.usersById.has(userId)) throw new AccountError('not-found', 'No existe esa cuenta.');
      if (!isProjectRole(role)) throw new AccountError('invalid', `Rol inválido: use ${PROJECT_ROLES.join(', ')}.`);
      const members = (this.state.projects[projectId] ??= []);
      const found = members.find((m) => m.userId === userId);
      if (found) found.role = role;
      else {
        if (members.length >= MAX_MEMBERS_PER_PROJECT) throw new AccountError('limit', `Un proyecto admite hasta ${MAX_MEMBERS_PER_PROJECT} personas.`);
        members.push({ userId, role, addedAt: this.now().toISOString() });
      }
    });
  }

  /** Quita a alguien del proyecto. Devuelve si pertenecía. */
  removeMember(projectId: string, userId: string): boolean {
    const members = this.state.projects[projectId];
    if (!members?.some((m) => m.userId === userId)) return false;
    this.commit(() => {
      this.state.projects[projectId] = members.filter((m) => m.userId !== userId);
    });
    return true;
  }

  /** El proyecto ya no existe: se olvidan sus miembros. */
  dropProject(projectId: string): void {
    if (!this.state.projects[projectId]) return;
    this.commit(() => {
      delete this.state.projects[projectId];
    });
  }
}
