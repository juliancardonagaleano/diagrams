import { createHash, randomBytes } from 'node:crypto';

/**
 * El modelo de las cuentas de `iark serve` con inicio de sesión de GitHub y el contrato que cumple cualquier almacén (`AccountStore`):
 * las personas que han entrado, sus sesiones y a qué proyectos pertenecen. Aquí no hay disco ni bases de datos: solo tipos, reglas
 * y las funciones puras que comparten todos los almacenes. Hoy hay dos (`jsonStore.ts`, un archivo para una sola instancia, y
 * `sqliteStore.ts`, una base transaccional que varias instancias pueden compartir) y se eligen con `--accounts-store`
 * (ver `store.ts`). Solo usa `node:` (nada de dependencias).
 *
 * Reglas que valen para todos los almacenes:
 * - El token de una sesión nunca se guarda: solo su hash (sha256), como en el archivo de tokens. Quien lea el almacén no puede usarlas.
 * - Una persona se identifica por su id numérico de GitHub (el nombre de usuario puede cambiar o pasar a otra persona). Una cuenta
 *   «pendiente» (`githubId` ausente) es una invitación por nombre de usuario: la reclama quien entre con ese nombre.
 * - Cada operación es atómica: o se aplica entera o no deja rastro (una invitación creada por `shareProject` no sobrevive a un proyecto lleno).
 */

export const SITE_ROLES = ['admin', 'member', 'guest'] as const;
/** `admin` administra la instancia y ve todos los proyectos; `member` puede crear proyectos; `guest` solo entra a los proyectos a los que le invitaron. */
export type SiteRole = (typeof SITE_ROLES)[number];
export const isSiteRole = (value: unknown): value is SiteRole => typeof value === 'string' && (SITE_ROLES as readonly string[]).includes(value);

export const PROJECT_ROLES = ['viewer', 'editor', 'admin'] as const;
/** `viewer` lee; `editor` además guarda y borra diagramas y renombra; `admin` además borra el proyecto y gestiona quién entra. */
export type ProjectRole = (typeof PROJECT_ROLES)[number];
export const isProjectRole = (value: unknown): value is ProjectRole => typeof value === 'string' && (PROJECT_ROLES as readonly string[]).includes(value);

export const ROLE_RANK: Record<ProjectRole, number> = { viewer: 0, editor: 1, admin: 2 };
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

/**
 * Un volcado completo de las cuentas, con la forma del archivo JSON (`version`, `users`, `sessions`, `projects`). Es el formato del
 * almacén JSON, lo que `AccountStore.snapshot()` devuelve de cualquier almacén y lo que `iark accounts migrate` importa.
 */
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
  /** El cambio dejaría un proyecto sin ninguna persona administradora. */
  | 'last-admin'
  /** La operación no vale para el estado actual de la cuenta (por ejemplo, cancelar la invitación de quien ya entró). */
  | 'conflict'
  /** El archivo o la base existen pero no son un almacén de cuentas válido (o son de una versión más nueva). */
  | 'corrupt'
  /** No se puede leer o escribir (permisos, disco, no es un archivo, base ocupada). */
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

export const newUserId = (): string => `u_${randomBytes(12).toString('base64url')}`;

/** Un token de sesión nuevo: `iark_s_` y 32 bytes aleatorios en base64url (256 bits). */
export const generateSessionToken = (): string => `${SESSION_PREFIX}${randomBytes(32).toString('base64url')}`;

export const hashSessionToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

// ───────────── el contrato de un almacén ─────────────

/** Los almacenes que existen: `json` (un archivo, una sola instancia) y `sqlite` (una base transaccional, varias instancias). */
export const ACCOUNT_STORE_KINDS = ['json', 'sqlite'] as const;
export type AccountStoreKind = (typeof ACCOUNT_STORE_KINDS)[number];
export const isAccountStoreKind = (value: unknown): value is AccountStoreKind => typeof value === 'string' && (ACCOUNT_STORE_KINDS as readonly string[]).includes(value);

export interface AccountStoreOptions {
  /** El reloj (en las pruebas, uno falso). */
  now?: () => Date;
}

/** Un cambio sobre una cuenta (ver `AccountStore.updateUser`). */
export interface UserChange {
  siteRole?: SiteRole;
  disabled?: boolean;
}

/** Los recuentos de `AccountStore.stats()`. */
export interface AccountStats {
  users: number;
  active: number;
  disabled: number;
  pending: number;
  sessions: number;
}

export interface SignInPolicy {
  /** `open`: cualquiera con cuenta de GitHub entra como `member`. `invite`: solo quien ya tiene cuenta (invitada) o es administrador. */
  signup: 'open' | 'invite';
  /** Esa persona figura en la lista de administradores de la instancia (`--admins`). */
  admin: boolean;
}

/**
 * Lo que el servicio necesita de un almacén de cuentas. Todo es síncrono (el almacén JSON vive en memoria y `node:sqlite` es síncrono):
 * un almacén de red (Postgres) obligaría a volver estas operaciones asíncronas (ver «Camino a Postgres» en `docs/cuentas-github.md`).
 *
 * Cada método que escribe es una sola transacción: o se aplica entero o no deja rastro, y los topes (`limit`) y la regla de la última
 * persona administradora (`last-admin`) se comprueban dentro de ella, así que dos peticiones simultáneas no pueden saltárselos. Con el
 * almacén SQLite eso vale también entre procesos distintos sobre la misma base; el JSON solo admite un proceso.
 */
export interface AccountStore {
  readonly kind: AccountStoreKind;
  /** Dónde vive: la ruta del archivo (JSON) o de la base (SQLite). */
  readonly path: string;
  /** Cuántas cuentas hay (personas que entraron e invitaciones). */
  readonly userCount: number;
  /**
   * Solo recuentos, para las métricas (`/metrics`): cuántas cuentas hay (activas, desactivadas, pendientes de entrar) y cuántas sesiones
   * vigentes. Nunca datos de las personas. Una cuenta desactivada cuenta como desactivada aunque aún no hubiera entrado.
   */
  stats(): AccountStats;
  /**
   * ¿Se puede leer el almacén ahora mismo? Es la lectura de verdad que hace la comprobación `accounts` de `/readyz`: el JSON vive en
   * memoria (lo que puede fallar es el archivo, y eso lo mira `/readyz` aparte), así que responde que sí; SQLite hace una consulta a la
   * base. No lanza: devuelve `false`.
   */
  readable(): boolean;

  // ───── personas ─────
  users(): AccountUser[];
  findUser(id: string): AccountUser | undefined;
  findByLogin(login: string): AccountUser | undefined;
  /**
   * Una persona entra con su perfil de GitHub. Se la reconoce por su id de GitHub; si no, por una invitación pendiente a su nombre
   * de usuario (que así queda reclamada); si no, solo entra si la instancia está abierta o es administradora. Actualiza su nombre
   * de usuario, nombre y foto. Falla con `not-invited` o `disabled`.
   */
  signIn(profile: GithubProfile, policy: SignInPolicy): AccountUser;
  /**
   * Una cuenta pendiente: invita a ese nombre de usuario sin que haya entrado todavía. Si la cuenta ya existe, la devuelve tal cual
   * (no cambia su rol). Entra con ese rol cuando se identifique con GitHub.
   */
  invite(login: string, siteRole?: SiteRole): AccountUser;
  /** Cambia el rol de la instancia o activa o desactiva una cuenta (desactivarla cierra todas sus sesiones). */
  updateUser(id: string, change: UserChange): AccountUser;
  /**
   * Lo que hace un administrador sobre un nombre de usuario: si la cuenta existe, le aplica el cambio; si no, crea una invitación
   * (cuenta pendiente) con ese rol —`member` por omisión— que reclamará quien entre con ese nombre. Todo en una sola transacción.
   */
  upsertUser(login: string, change: UserChange): { user: AccountUser; created: boolean };
  /** Cancela la invitación de alguien que todavía no ha entrado (con sus pertenencias a proyectos). Quien ya entró no se borra: se desactiva. */
  removePending(userId: string): void;

  // ───── sesiones ─────
  /** Abre una sesión: devuelve el token (la única vez que se conoce; en el almacén solo queda su hash). */
  createSession(userId: string, ttlMs: number): { token: string; expiresAt: string };
  /** La cuenta dueña de ese token de sesión, si la sesión sigue vigente y la cuenta no está desactivada. */
  lookupSession(token: string): AccountUser | undefined;
  /** Cierra la sesión de ese token. Devuelve si existía. */
  revokeSession(token: string): boolean;
  /** Sesiones abiertas de una cuenta (sin contar las caducadas). */
  sessionCount(userId: string): number;

  // ───── pertenencia a proyectos ─────
  roleOf(userId: string, projectId: string): ProjectRole | undefined;
  /** Los proyectos a los que pertenece una persona, con su rol. */
  rolesOf(userId: string): Map<string, ProjectRole>;
  /** Quién pertenece al proyecto y con qué rol (los administradores primero, luego por nombre de usuario). */
  membersOf(projectId: string): Array<{ user: AccountUser; role: ProjectRole; addedAt: string }>;
  /** Cuántos proyectos administra esa persona (para el tope de proyectos por persona). */
  adminCount(userId: string): number;
  /**
   * Registra un proyecto recién creado con una persona como administradora. Reemplaza lo que hubiera con ese id: es de un proyecto
   * anterior que ya no existe (borrado a mano de la carpeta), y no debe heredar sus miembros.
   */
  registerProject(projectId: string, ownerId: string): void;
  /** Añade a alguien al proyecto o cambia su rol. Falla con `last-admin` si bajara de rol a la única persona administradora. */
  setMember(projectId: string, userId: string, role: ProjectRole): void;
  /**
   * Comparte un proyecto con un nombre de usuario de GitHub: si esa persona no tiene cuenta, se crea una invitación (cuenta pendiente
   * con `newUserSiteRole`) que reclamará al entrar; luego se la añade con el rol o se le cambia. Una sola transacción: si el proyecto
   * está lleno o el cambio dejaría al proyecto sin administrador, tampoco queda la invitación.
   */
  shareProject(projectId: string, login: string, role: ProjectRole, newUserSiteRole: SiteRole): { user: AccountUser; added: boolean; invited: boolean };
  /**
   * Quita a alguien del proyecto. Devuelve si pertenecía. Falla con `last-admin` si era la única persona administradora. Si era una
   * invitación de invitado que no ha entrado y ya no le queda ningún proyecto, la invitación se cancela: quitarla del proyecto
   * también le quita la entrada a la instancia.
   */
  removeMember(projectId: string, userId: string): boolean;
  /** El proyecto ya no existe: se olvidan sus miembros (y las invitaciones de invitado que solo estaban en él). */
  dropProject(projectId: string): void;
  /** A cuántos proyectos pertenece cada cuenta (por id de cuenta). */
  membershipCounts(): Map<string, number>;

  // ───── mantenimiento ─────
  /** Un volcado completo y coherente de lo que hay (para migrar, comparar y copiar). Incluye los hashes de las sesiones, nunca sus tokens. */
  snapshot(): AccountsFile;
  /** Libera lo que tenga abierto (la conexión a la base). Después de cerrarlo no se puede usar. */
  close(): void;
}
