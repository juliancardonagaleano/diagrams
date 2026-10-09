import type { GithubOAuth } from './github';
import { isGithubLogin, loginKey, type AccountStore, type AccountUser, type GithubProfile, type SiteRole } from './store';

/**
 * Las cuentas de una instancia de `iark serve` con inicio de sesión de GitHub: el almacén (`store.ts`), el cliente de GitHub
 * y las reglas de la instancia (quién entra, quién administra, cuánto dura una sesión). Lo que usan `serveAuth.ts` (identificar
 * a quien llama), `serveProjects.ts` (quién ve y toca cada proyecto) y las rutas de `/api/auth` (`routes.ts`).
 */

export type SignupMode = 'open' | 'invite';

/**
 * Los topes de uso de la instancia (cuotas). `0` es «sin tope». Valen para cada persona con rol `member` o `guest`; los administradores de la
 * instancia no tienen tope salvo que se les fije uno a mano (`UserQuota`). Qué se cuenta y cómo se aplica: ver `usage.ts`.
 */
export interface QuotaLimits {
  /** Bytes en total de los proyectos que posee una persona: los documentos de sus diagramas más el historial de versiones. */
  bytes: number;
  /** Proyectos que puede poseer (la persona administradora más antigua de un proyecto lo posee: normalmente, quien lo creó). */
  projects: number;
  /** Diagramas que admite cada proyecto. */
  diagramsPerProject: number;
}

export const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
export const DEFAULT_MAX_PROJECTS = 25;
export const DEFAULT_MAX_DIAGRAMS = 200;
/** Los topes por omisión: razonables para una instancia pequeña y siempre desactivables con `0`. */
export const DEFAULT_QUOTAS: Readonly<QuotaLimits> = { bytes: DEFAULT_MAX_BYTES, projects: DEFAULT_MAX_PROJECTS, diagramsPerProject: DEFAULT_MAX_DIAGRAMS };

/** Lo que se cuenta de una persona hacia fuera: nunca el id de GitHub ni las fechas. */
export interface PublicUser {
  id: string;
  login: string;
  name?: string;
  avatarUrl?: string;
  siteRole: SiteRole;
}

export interface AccountsOptions {
  store: AccountStore;
  /** Sin él no hay inicio de sesión (las rutas de `/api/auth/github` responden 404). */
  github?: GithubOAuth;
  /** La dirección pública de la instancia (`https://iark.ejemplo.org`), sin barra final: de ahí sale la «callback URL» de la OAuth App y el sitio al que se vuelve por omisión. */
  publicUrl?: string;
  /** `invite` (por omisión): solo entran las personas invitadas y los administradores. `open`: entra cualquiera con cuenta de GitHub. */
  signup?: SignupMode;
  /** Administradores de la instancia: nombres de usuario de GitHub o, más seguro, sus identificadores numéricos (el nombre puede cambiar de manos). */
  admins?: string[];
  /** Duración de una sesión en milisegundos. Por omisión, 30 días. */
  sessionTtlMs?: number;
  /** Orígenes (además del de `publicUrl`) a los que se puede devolver a la persona tras entrar: los de `--cors`, nombrados, nunca `*`. */
  allowedOrigins?: string[];
  /** Cuántos proyectos puede poseer una persona (los administradores de la instancia no tienen tope). Por omisión, 25; `0`, sin tope. Atajo de `quotas.projects`. */
  maxProjectsPerUser?: number;
  /** Los topes de uso de la instancia (ver `QuotaLimits`); los que falten valen `DEFAULT_QUOTAS`. */
  quotas?: Partial<QuotaLimits>;
  /** El reloj en milisegundos (en las pruebas, uno falso). */
  now?: () => number;
}

export const DEFAULT_SESSION_DAYS = 30;

const definedOnly = <T extends object>(value: T | undefined): Partial<T> => Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;

/** Una lista de administradores: nombres de usuario (sin distinguir mayúsculas) o identificadores numéricos de GitHub. */
export function parseAdminList(value: string | string[] | undefined): string[] {
  const entries = (Array.isArray(value) ? value : (value ?? '').split(','))
    .map((entry) => entry.trim().replace(/^@/, ''))
    .filter(Boolean);
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) && !isGithubLogin(entry)) throw new Error(`«${String(entry).slice(0, 60)}» no es un nombre de usuario de GitHub ni un identificador numérico.`);
  }
  return entries;
}

/** La dirección pública, normalizada: http(s), sin usuario, sin parámetros ni fragmento y sin barra final. Lanza `Error` con el motivo. */
export function normalizePublicUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`«${value.trim().slice(0, 100)}» no es una dirección válida (por ejemplo https://iark.ejemplo.org).`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('La dirección pública debe empezar por http:// o https://.');
  if (url.username || url.password) throw new Error('La dirección pública no debe llevar usuario ni contraseña.');
  if (url.search || url.hash) throw new Error('La dirección pública no debe llevar parámetros ni fragmento.');
  const loopback = url.hostname === 'localhost' || /^127(\.\d{1,3}){3}$/.test(url.hostname) || url.hostname === '[::1]';
  if (url.protocol === 'http:' && !loopback) throw new Error('La dirección pública debe ser https (solo localhost puede ser http): GitHub devuelve a la persona a esa dirección y la sesión viaja por ella.');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export class Accounts {
  readonly store: AccountStore;
  readonly github: GithubOAuth | undefined;
  readonly publicUrl: string | undefined;
  readonly signup: SignupMode;
  readonly sessionTtlMs: number;
  /** Los topes de uso de la instancia. */
  readonly quotas: QuotaLimits;
  readonly now: () => number;
  private readonly adminLogins: Set<string>;
  private readonly adminIds: Set<number>;
  private readonly origins: Set<string>;

  constructor(options: AccountsOptions) {
    this.store = options.store;
    this.github = options.github;
    this.publicUrl = options.publicUrl ? normalizePublicUrl(options.publicUrl) : undefined;
    this.signup = options.signup ?? 'invite';
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_DAYS * 24 * 3600 * 1000;
    this.quotas = { ...DEFAULT_QUOTAS, ...definedOnly(options.quotas), ...(options.maxProjectsPerUser !== undefined ? { projects: options.maxProjectsPerUser } : {}) };
    this.now = options.now ?? ((): number => Date.now());
    const admins = parseAdminList(options.admins);
    this.adminIds = new Set(admins.filter((a) => /^\d+$/.test(a)).map(Number));
    this.adminLogins = new Set(admins.filter((a) => !/^\d+$/.test(a)).map(loginKey));
    this.origins = new Set([...(this.publicUrl ? [new URL(this.publicUrl).origin] : []), ...(options.allowedOrigins ?? []).filter((o) => o !== '*')]);
  }

  /** Cuántos proyectos puede poseer cada persona por omisión (`0`, sin tope). */
  get maxProjectsPerUser(): number {
    return this.quotas.projects;
  }

  /**
   * Los topes que valen para una persona: los de la instancia, con lo que un administrador le fijó a ella (`AccountUser.quota`) por encima. Los
   * administradores de la instancia no tienen tope por omisión. `0` es «sin tope».
   */
  limitsFor(user: AccountUser): QuotaLimits {
    const base: QuotaLimits = this.siteRoleOf(user) === 'admin' ? { bytes: 0, projects: 0, diagramsPerProject: 0 } : this.quotas;
    return { bytes: user.quota?.bytes ?? base.bytes, projects: user.quota?.projects ?? base.projects, diagramsPerProject: user.quota?.diagramsPerProject ?? base.diagramsPerProject };
  }

  /**
   * Quién posee un proyecto a efectos de las cuotas: su persona administradora más antigua (la que lo creó, mientras siga siendo administradora).
   * Un proyecto sin ninguna persona (el que se copió a mano a la carpeta) no lo posee nadie.
   */
  ownerOf(projectId: string): AccountUser | undefined {
    const admins = this.store.membersOf(projectId).filter((m) => m.role === 'admin');
    admins.sort((a, b) => (a.addedAt < b.addedAt ? -1 : a.addedAt > b.addedAt ? 1 : a.user.id < b.user.id ? -1 : 1));
    return admins[0]?.user;
  }

  /** Los proyectos que posee una persona (ver `ownerOf`). */
  ownedProjects(userId: string): string[] {
    const owned: string[] = [];
    for (const [projectId, role] of this.store.rolesOf(userId)) {
      if (role === 'admin' && this.ownerOf(projectId)?.id === userId) owned.push(projectId);
    }
    return owned.sort();
  }

  /** Cuántos administradores hay en la lista de la instancia. */
  get adminCount(): number {
    return this.adminIds.size + this.adminLogins.size;
  }

  /** ¿La lista de administradores incluye a esta persona (por id de GitHub o por nombre de usuario)? */
  isAdminProfile(profile: Pick<GithubProfile, 'id' | 'login'>): boolean {
    return this.adminIds.has(profile.id) || this.adminLogins.has(loginKey(profile.login));
  }

  /**
   * ¿Esta cuenta figura en la lista de administradores de la instancia (`--admins`)? Su rol no se puede cambiar desde la API: lo manda
   * la lista. Una cuenta pendiente también cuenta si su nombre está en la lista (cuando entre, será administradora).
   */
  isListedAdmin(user: Pick<AccountUser, 'githubId' | 'login'>): boolean {
    return (user.githubId !== undefined && this.adminIds.has(user.githubId)) || this.adminLogins.has(loginKey(user.login));
  }

  /** El rol que tiene ahora una cuenta en la instancia: si está en la lista de administradores es `admin`, aunque su cuenta guarde otro. */
  siteRoleOf(user: AccountUser): SiteRole {
    if (user.githubId !== undefined && this.adminIds.has(user.githubId)) return 'admin';
    if (user.githubId !== undefined && this.adminLogins.has(loginKey(user.login))) return 'admin';
    return user.siteRole;
  }

  publicUser(user: AccountUser): PublicUser {
    return { id: user.id, login: user.login, ...(user.name ? { name: user.name } : {}), ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}), siteRole: this.siteRoleOf(user) };
  }

  /** ¿Se puede devolver a la persona a esta dirección tras entrar? Solo al propio sitio o a un origen que se nombró en `--cors`. */
  redirectAllowed(redirect: URL): boolean {
    return (redirect.protocol === 'https:' || redirect.protocol === 'http:') && !redirect.username && !redirect.password && this.origins.has(redirect.origin);
  }

  /** La dirección a la que GitHub devuelve a la persona (la «Authorization callback URL» de la OAuth App). */
  get callbackUrl(): string | undefined {
    return this.publicUrl ? `${this.publicUrl}/api/auth/github/callback` : undefined;
  }
}
