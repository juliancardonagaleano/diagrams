import type { GithubOAuth } from './github';
import { AccountStore, isGithubLogin, loginKey, type AccountUser, type GithubProfile, type SiteRole } from './store';

/**
 * Las cuentas de una instancia de `iark serve` con inicio de sesión de GitHub: el almacén (`store.ts`), el cliente de GitHub
 * y las reglas de la instancia (quién entra, quién administra, cuánto dura una sesión). Lo que usan `serveAuth.ts` (identificar
 * a quien llama), `serveProjects.ts` (quién ve y toca cada proyecto) y las rutas de `/api/auth` (`routes.ts`).
 */

export type SignupMode = 'open' | 'invite';

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
  /** Cuántos proyectos puede administrar una persona (los administradores de la instancia no tienen tope). Por omisión, 25. */
  maxProjectsPerUser?: number;
  /** El reloj en milisegundos (en las pruebas, uno falso). */
  now?: () => number;
}

export const DEFAULT_SESSION_DAYS = 30;
export const DEFAULT_MAX_PROJECTS = 25;

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
  readonly maxProjectsPerUser: number;
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
    this.maxProjectsPerUser = options.maxProjectsPerUser ?? DEFAULT_MAX_PROJECTS;
    this.now = options.now ?? ((): number => Date.now());
    const admins = parseAdminList(options.admins);
    this.adminIds = new Set(admins.filter((a) => /^\d+$/.test(a)).map(Number));
    this.adminLogins = new Set(admins.filter((a) => !/^\d+$/.test(a)).map(loginKey));
    this.origins = new Set([...(this.publicUrl ? [new URL(this.publicUrl).origin] : []), ...(options.allowedOrigins ?? []).filter((o) => o !== '*')]);
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
