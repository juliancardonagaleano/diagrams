import { ProjectError, type ProjectErrorCode, type ProjectErrorInfo } from './errors';
import { EventsConnection, type EventsHandlers, type EventsOptions } from './events';
import type { Diagram, DiagramMeta, ProjectRole, ProjectSummary, SaveDiagramInput } from './types';
import { requireVersionId, type DiagramVersion, type RestoredVersion, type RestoreOptions, type VersionedProjectStore, type VersionMeta } from './versions';

/**
 * Almacén de proyectos remoto: habla con la API `/api/projects` de `iark serve --workspace` (la carpeta de trabajo de un
 * servidor propio) y cumple el mismo contrato que los almacenes locales. Es lo que usa el navegador para «guardar en la
 * nube»; solo necesita `fetch`, así que sirve igual en el CLI.
 *
 * Los errores del servidor vuelven como `ProjectError` con el mismo código que daría un almacén local; hay tres más que
 * solo pasan aquí: `unauthorized` (el servidor pide un token, o el token no existe o ya no vale), `forbidden` (reconoce el
 * token, pero su rol no alcanza para esa operación) y `unavailable` (no se llega al servidor, responde con un fallo suyo o
 * no ofrece proyectos).
 *
 * Con cuentas (`iark serve --accounts`, inicio de sesión con GitHub) el mismo cliente sabe además qué formas de entrar ofrece el
 * servidor (`providers`), cambiar el código que devuelve GitHub por una sesión (`exchangeLoginCode`), cerrarla (`logout`) y
 * compartir un proyecto (`listMembers`, `setMember`, `removeMember`). La sesión es un token más: se da en `token`. Quien administra la
 * instancia tiene además las cuentas (`listAccounts`, `setAccount`, `cancelInvitation`, sobre `/api/admin/users`).
 *
 * Códigos del servidor sin equivalente local, traducidos al más cercano (el original queda en `error.info.serverCode`):
 *   `last-admin` (409: no se puede quitar ni degradar al último administrador) → `conflict`: el estado del proyecto lo impide.
 *   `limit` (409 al compartir; 403 al crear más proyectos de los permitidos) → `invalid`: la petición es válida pero no cabe; sobre
 *   todo **no** es `forbidden`, que las pantallas leen como «el token no alcanza» y mandan a cambiar de token.
 *   `invalid-grant` (400 al cambiar un código de inicio de sesión que no vale o caducó) → `invalid`, por su estado.
 *   `self` (409: nadie cambia su propio rol ni se desactiva) y `listed-admin` (409: quien figura en `--admins` no baja de rol ni se desactiva
 *   desde la API) → `conflict`, igual que `last-admin`: el estado de la cuenta lo impide.
 */

export interface HttpProjectStoreOptions {
  /** Dirección del servicio, p. ej. `https://iark.ejemplo.org` o `http://localhost:8787`. Si lleva `/api/projects` al final, se ignora. */
  baseUrl: string;
  /** Token de acceso (`Authorization: Bearer`). Sin él solo se puede usar un servicio abierto. */
  token?: string;
  fetch?: typeof fetch;
  /** Tiempo máximo de cada petición. Por defecto, 20 s. */
  timeoutMs?: number;
  /**
   * Las peticiones que escriben (hasta 60 KB, el máximo que admite `keepalive`) siguen su curso aunque la página se cierre o se
   * recargue: sin esto, un guardado lanzado al ocultar la pestaña se cancela con ella. En el navegador conviene activarlo.
   */
  keepalive?: boolean;
}

/** Un navegador solo deja `keepalive` en peticiones de hasta 64 KB (entre todas las que estén en curso): se queda margen. */
const KEEPALIVE_MAX_BYTES = 60_000;

/** Rol de una persona en la instancia: `admin` (ve y administra todo), `member` (crea y comparte proyectos) o `guest` (solo entra a los que le comparten). */
export type SiteRole = 'admin' | 'member' | 'guest';

/** Lo que el servidor cuenta de una persona con sesión (nunca su id de GitHub). */
export interface PublicUser {
  id: string;
  /** Nombre de usuario de GitHub, sin `@`. */
  login: string;
  name?: string;
  /** Dirección de su foto; quien la muestre debe comprobar que es https. */
  avatarUrl?: string;
  siteRole: SiteRole;
}

/** Quién es el token ante el servidor (`GET /api/whoami`); sin autenticación en el servidor, `auth` es `false`. */
export interface RemoteSession {
  auth: boolean;
  name?: string;
  /** Con un token, su rol para todo el espacio de trabajo; con una sesión de persona, su rol en la instancia (`siteRole`). */
  role?: string;
  /** Solo con una sesión de persona (inicio de sesión con GitHub): quién es. */
  user?: PublicUser;
}

/** Qué formas de entrar ofrece un servidor (`GET /api/auth/providers`, público). */
export interface AuthProviders {
  /** Inicios de sesión con terceros que ofrece (`github`); vacío si solo entra con tokens. */
  providers: Array<{ id: string; label: string }>;
  /** El servidor también acepta tokens de `iark auth`. */
  tokens: boolean;
  /** Quién puede entrar con GitHub: `open` cualquiera, `invite` solo personas invitadas. */
  signup?: 'open' | 'invite';
}

/** Una sesión recién creada con el código de inicio de sesión. El token es la credencial: no se muestra ni se registra. */
export interface LoginGrant {
  token: string;
  expiresAt: string;
  user: PublicUser;
}

/** Una persona con acceso a un proyecto compartido. */
export interface ProjectMember {
  /** Nombre de usuario de GitHub, sin `@`. */
  login: string;
  name?: string;
  avatarUrl?: string;
  role: ProjectRole;
  /** La invitaron y todavía no ha entrado con su cuenta de GitHub. */
  pending: boolean;
  /** Es quien pregunta. */
  you?: boolean;
}

/** Los topes de uso de una persona (cuotas): `0` es «sin tope». Qué se cuenta y a quién: ver `docs/cuentas-github.md`. */
export interface QuotaLimits {
  /** Bytes en total de los proyectos que posee: los documentos de los diagramas más el historial de versiones. */
  bytes: number;
  /** Proyectos que puede poseer. */
  projects: number;
  /** Diagramas que admite cada uno de sus proyectos. */
  diagramsPerProject: number;
}

/** Lo que ocupa una persona (la suma de los proyectos que posee). */
export interface QuotaUsage {
  bytes: number;
  documentBytes: number;
  versionBytes: number;
  versions: number;
  /** Cuántos proyectos posee. */
  projects: number;
}

/** Lo que ocupa uno de sus proyectos. */
export interface ProjectQuotaUsage {
  id: string;
  name: string;
  diagrams: number;
  documentBytes: number;
  versions: number;
  versionBytes: number;
  bytes: number;
}

/** Cuánto usa quien pregunta y cuánto puede usar (`GET /api/usage`, solo con una sesión de persona en un servicio con cuentas). */
export interface AccountUsage {
  limits: QuotaLimits;
  usage: QuotaUsage;
  /** Los proyectos que posee, del que más ocupa al que menos. */
  projects: ProjectQuotaUsage[];
}

/** Lo que un administrador fija a UNA persona por encima de los topes de la instancia; un campo ausente es «el valor de la instancia», `0`, «sin tope». */
export type PersonalQuota = Partial<QuotaLimits>;

/** Una cuenta de la instancia tal como la ve quien la administra (`GET /api/admin/users`). */
export interface AdminAccount {
  id: string;
  /** Nombre de usuario de GitHub, sin `@`. */
  login: string;
  name?: string;
  avatarUrl?: string;
  /** El rol que tiene ahora en la instancia (si figura en `--admins` es `admin`, aunque la cuenta guarde otro). */
  siteRole: SiteRole;
  /** Un administrador la desactivó: no puede entrar. */
  disabled: boolean;
  /** Es una invitación que nadie ha reclamado todavía: esa persona aún no ha entrado con su cuenta de GitHub. */
  pending: boolean;
  /** Figura en la lista de administradores del servicio (`--admins`): su rol y su acceso los manda esa lista y no se pueden bajar desde aquí. */
  listed: boolean;
  /** Cuándo se creó la cuenta o la invitación (ISO 8601). */
  createdAt: string;
  /** La última vez que entró (ISO 8601); no existe en una invitación pendiente. */
  lastLoginAt?: string;
  /** A cuántos proyectos pertenece. */
  projects: number;
  /** La cuota personal que le fijó un administrador, si la hay. */
  quota?: PersonalQuota;
  /** Los topes que valen para ella ahora (los de la instancia con los suyos por encima). Un servidor anterior a las cuotas no los manda. */
  limits?: QuotaLimits;
  /** Lo que ocupa. Falta en un servidor anterior a las cuotas, en una invitación sin reclamar o si no se pudo medir. */
  usage?: QuotaUsage;
}

/**
 * Lo que un administrador puede cambiar de una cuenta: su rol en la instancia, si está desactivada y su cuota personal. En `quota`, un número fija
 * el tope (`0`, sin tope), `null` lo quita (vuelve al valor de la instancia) y lo que falta no se toca.
 */
export interface AccountChange {
  siteRole?: SiteRole;
  disabled?: boolean;
  quota?: { [K in keyof QuotaLimits]?: number | null };
}

/** Las sesiones de persona que reparte el inicio de sesión de GitHub empiezan así; los tokens de `iark auth` (`iark_…`), no. */
export const SESSION_TOKEN_PREFIX = 'iark_s_';

const API = '/api/projects';
const ADMIN_USERS = '/api/admin/users';
const LOCAL_CODES: ReadonlySet<string> = new Set<ProjectErrorCode>(['not-found', 'exists', 'invalid', 'conflict', 'unsupported']);
const ROLES: ReadonlySet<string> = new Set<ProjectRole>(['viewer', 'editor', 'admin']);
const SITE_ROLES: ReadonlySet<string> = new Set<SiteRole>(['admin', 'member', 'guest']);

/** `https://x.org/` o `https://x.org/api/projects/` → `https://x.org`. Lanza `invalid` si no es una dirección http(s). */
export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ProjectError('invalid', `«${value.trim().slice(0, 100)}» no es una dirección válida (por ejemplo https://iark.ejemplo.org).`, { reason: 'address-invalid', params: { value: value.trim().slice(0, 100) } });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ProjectError('invalid', 'La dirección del servidor debe empezar por http:// o https://.', { reason: 'address-scheme' });
  if (url.username || url.password) throw new ProjectError('invalid', 'La dirección del servidor no debe llevar usuario ni contraseña: el token se indica aparte.', { reason: 'address-credentials' });
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api\/projects$/, '').replace(/\/api$/, '');
  return `${url.origin}${path}`;
}

interface Payload {
  error?: unknown;
  code?: unknown;
  [key: string]: unknown;
}

/** De qué tope habla un `limit` del servidor (`quota`): el motivo que la interfaz traduce, con lo usado y el tope si el servidor los dio. */
function limitReason(payload: Payload): Pick<ProjectErrorInfo, 'reason' | 'params'> {
  const reason = payload.quota === 'projects' ? 'limit-projects' : payload.quota === 'diagrams' ? 'limit-diagrams' : payload.quota === 'bytes' ? 'limit-bytes' : 'limit';
  const params: Record<string, number> = {};
  if (typeof payload.used === 'number' && Number.isFinite(payload.used)) params.used = payload.used;
  if (typeof payload.limit === 'number' && Number.isFinite(payload.limit)) params.limit = payload.limit;
  // Sin las cifras no se puede escribir la frase de cada tope: se queda con la general.
  return reason !== 'limit' && params.used !== undefined && params.limit !== undefined ? { reason, params } : { reason: 'limit' };
}

/**
 * El error que corresponde a una respuesta que no es 2xx. El `message` es el del servidor si lo mandó (en su idioma) o uno en español del cliente; la interfaz traduce por
 * `info.reason` (el código estable) y no por ese texto.
 */
function errorFromResponse(status: number, payload: Payload, retryAfter: string | null): ProjectError {
  const message = typeof payload.error === 'string' && payload.error ? payload.error : '';
  const code = typeof payload.code === 'string' ? payload.code : undefined;
  const info: ProjectErrorInfo = message ? { status, serverMessage: message } : { status };
  if (code && LOCAL_CODES.has(code)) return new ProjectError(code as ProjectErrorCode, message || `Error ${status}.`, message ? info : { ...info, reason: 'http-error', params: { status } });
  // Antes que el estado: un `limit` llega como 403 al crear proyectos y no es un problema de rol.
  if (code === 'last-admin') return new ProjectError('conflict', message || 'No se puede quitar ni degradar al último administrador del proyecto.', { ...info, serverCode: code, reason: 'last-admin' });
  if (code === 'self' || code === 'listed-admin') return new ProjectError('conflict', message || 'La cuenta no admite ese cambio.', { ...info, serverCode: code, reason: 'account-locked' });
  if (code === 'limit') return new ProjectError('invalid', message || 'Se alcanzó el máximo que permite este servidor.', { ...info, serverCode: code, ...limitReason(payload) });
  if (code === 'invalid-grant') return new ProjectError('invalid', message || 'El código de inicio de sesión no es válido o caducó: vuelve a iniciar sesión.', { ...info, serverCode: code, reason: 'invalid-grant' });
  if (status === 401 || code === 'unauthorized') return new ProjectError('unauthorized', message || 'El servidor pide un token de acceso válido.', { ...info, reason: 'token-required' });
  if (status === 403 || code === 'forbidden') return new ProjectError('forbidden', message || 'Este token no tiene permiso para esa operación.', { ...info, reason: 'token-forbidden' });
  if (status === 429 || code === 'rate-limited') {
    const wait = Number(retryAfter);
    const waits = Number.isFinite(wait) && wait > 0;
    const seconds = Math.ceil(wait);
    return new ProjectError(
      'unavailable',
      message || `Demasiados intentos fallidos${waits ? `: espera ${seconds} s` : ''}.`,
      waits ? { ...info, retryAfterSec: seconds, reason: 'rate-limited-wait', params: { seconds } } : { ...info, reason: 'rate-limited' },
    );
  }
  if (status === 413) return new ProjectError('invalid', message || 'El documento es demasiado grande para el servidor.', { ...info, reason: 'too-large' });
  if (status === 400) return new ProjectError('invalid', message || 'El servidor rechazó la petición.', { ...info, reason: 'bad-request' });
  if (status === 404) return new ProjectError('unavailable', message || 'Ese servidor no ofrece proyectos (¿arrancó sin --workspace, o la dirección no es la de IArk?).', { ...info, reason: 'no-projects-api' });
  return new ProjectError('unavailable', `El servidor respondió ${status}${message ? `: ${message}` : ''}.`, message ? { ...info, reason: 'server-status-detail', params: { status, message } } : { ...info, reason: 'server-status', params: { status } });
}

/** La persona de una respuesta (`user`), o `undefined` si no tiene lo mínimo. Un rol desconocido se lee como el de menos permisos. */
function parseUser(value: unknown): PublicUser | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const user = value as { id?: unknown; login?: unknown; name?: unknown; avatarUrl?: unknown; siteRole?: unknown };
  if (typeof user.id !== 'string' || typeof user.login !== 'string' || !user.login) return undefined;
  return {
    id: user.id,
    login: user.login,
    ...(typeof user.name === 'string' && user.name ? { name: user.name } : {}),
    ...(typeof user.avatarUrl === 'string' && user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
    siteRole: typeof user.siteRole === 'string' && SITE_ROLES.has(user.siteRole) ? (user.siteRole as SiteRole) : 'guest',
  };
}

function parseMember(value: unknown): ProjectMember | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const member = value as { login?: unknown; name?: unknown; avatarUrl?: unknown; role?: unknown; pending?: unknown; you?: unknown };
  if (typeof member.login !== 'string' || !member.login) return undefined;
  return {
    login: member.login,
    ...(typeof member.name === 'string' && member.name ? { name: member.name } : {}),
    ...(typeof member.avatarUrl === 'string' && member.avatarUrl ? { avatarUrl: member.avatarUrl } : {}),
    role: typeof member.role === 'string' && ROLES.has(member.role) ? (member.role as ProjectRole) : 'viewer',
    pending: member.pending === true,
    ...(member.you === true ? { you: true } : {}),
  };
}

/** Una cuenta de la respuesta de administración, o `undefined` si no tiene lo mínimo. Un rol desconocido se lee como el de menos permisos. */
function parseAccount(value: unknown): AdminAccount | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const account = value as Record<string, unknown>;
  if (typeof account.id !== 'string' || typeof account.login !== 'string' || !account.login) return undefined;
  const personal = account.quota && typeof account.quota === 'object' ? (account.quota as Record<string, unknown>) : {};
  const quota: PersonalQuota = {
    ...(count(personal.bytes) !== undefined ? { bytes: count(personal.bytes) } : {}),
    ...(count(personal.projects) !== undefined ? { projects: count(personal.projects) } : {}),
    ...(count(personal.diagramsPerProject) !== undefined ? { diagramsPerProject: count(personal.diagramsPerProject) } : {}),
  };
  const limits = parseLimits(account.limits);
  const usage = parseQuotaUsage(account.usage);
  return {
    id: account.id,
    login: account.login,
    ...(typeof account.name === 'string' && account.name ? { name: account.name } : {}),
    ...(typeof account.avatarUrl === 'string' && account.avatarUrl ? { avatarUrl: account.avatarUrl } : {}),
    siteRole: typeof account.siteRole === 'string' && SITE_ROLES.has(account.siteRole) ? (account.siteRole as SiteRole) : 'guest',
    disabled: account.disabled === true,
    pending: account.pending === true,
    listed: account.listed === true,
    createdAt: typeof account.createdAt === 'string' ? account.createdAt : '',
    ...(typeof account.lastLoginAt === 'string' && account.lastLoginAt ? { lastLoginAt: account.lastLoginAt } : {}),
    projects: typeof account.projects === 'number' && Number.isFinite(account.projects) ? Math.max(0, Math.trunc(account.projects)) : 0,
    ...(quota && Object.keys(quota).length > 0 ? { quota } : {}),
    ...(limits ? { limits } : {}),
    ...(usage ? { usage } : {}),
  };
}

/** Un número de cuota válido (entero de 0 en adelante), o `undefined`. */
const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined);

/** Los topes de una respuesta, o `undefined` si no vienen los tres. */
function parseLimits(value: unknown): QuotaLimits | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { bytes, projects, diagramsPerProject } = value as Record<string, unknown>;
  const b = count(bytes);
  const p = count(projects);
  const d = count(diagramsPerProject);
  return b !== undefined && p !== undefined && d !== undefined ? { bytes: b, projects: p, diagramsPerProject: d } : undefined;
}

function parseQuotaUsage(value: unknown): QuotaUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const u = value as Record<string, unknown>;
  const bytes = count(u.bytes);
  const projects = count(u.projects);
  if (bytes === undefined || projects === undefined) return undefined;
  return { bytes, documentBytes: count(u.documentBytes) ?? 0, versionBytes: count(u.versionBytes) ?? 0, versions: count(u.versions) ?? 0, projects };
}

function parseProjectQuotaUsage(value: unknown): ProjectQuotaUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const p = value as Record<string, unknown>;
  const bytes = count(p.bytes);
  if (typeof p.id !== 'string' || typeof p.name !== 'string' || bytes === undefined) return undefined;
  return { id: p.id, name: p.name, diagrams: count(p.diagrams) ?? 0, documentBytes: count(p.documentBytes) ?? 0, versions: count(p.versions) ?? 0, versionBytes: count(p.versionBytes) ?? 0, bytes };
}

/** Una versión de la respuesta del servidor, o `undefined` si no tiene lo mínimo del contrato. */
function parseVersion(value: unknown): VersionMeta | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const id = v.id;
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || typeof v.savedAt !== 'string' || typeof v.hash !== 'string') return undefined;
  const size = typeof v.size === 'number' && Number.isFinite(v.size) ? Math.max(0, Math.trunc(v.size)) : 0;
  return {
    id,
    savedAt: v.savedAt,
    ...(typeof v.savedBy === 'string' && v.savedBy ? { savedBy: v.savedBy } : {}),
    ...(typeof v.label === 'string' && v.label ? { label: v.label } : {}),
    size,
    hash: v.hash,
    ...(typeof v.restoredFrom === 'number' && Number.isInteger(v.restoredFrom) ? { restoredFrom: v.restoredFrom } : {}),
  };
}

/** Un nombre de usuario de GitHub como se escribe a mano (`@octocat`, con espacios) → `octocat`. Lanza `invalid` si queda vacío. */
function cleanLogin(value: string): string {
  const login = value.trim().replace(/^@/, '');
  if (!login) throw new ProjectError('invalid', 'Falta el nombre de usuario de GitHub.', { reason: 'login-missing' });
  return login;
}

export class HttpProjectStore implements VersionedProjectStore {
  readonly kind = 'http';
  /**
   * Un servidor de esta versión guarda el historial de cada diagrama. Uno anterior no tiene las rutas: sus llamadas fallan con `unsupported`
   * (y la interfaz, que ya se había ofrecido, lo cuenta en lugar de romper). El servidor decide además quién puede qué (roles).
   */
  readonly keepsVersions = true as const;
  /** La dirección del servicio, ya normalizada. */
  readonly baseUrl: string;
  private token: string | undefined;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly keepalive: boolean;
  /** Las conexiones al canal de eventos que se abrieron con `watchEvents` y siguen vivas (el token nuevo las reconecta). */
  private readonly watchers = new Set<EventsConnection>();

  constructor(options: HttpProjectStoreOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.token = options.token?.trim() || undefined;
    this.doFetch = options.fetch ?? ((...args) => fetch(...args));
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.keepalive = options.keepalive === true;
  }

  /** Con qué se identifica este cliente: una sesión de persona (inicio de sesión de GitHub), un token de `iark auth` o nada. */
  get credential(): 'session' | 'token' | 'none' {
    return !this.token ? 'none' : this.token.startsWith(SESSION_TOKEN_PREFIX) ? 'session' : 'token';
  }

  /** Cambia el token de las peticiones siguientes (para reconectar sin recargar la página ni perder lo pendiente). */
  setToken(token: string | undefined): void {
    const next = token?.trim() || undefined;
    const changed = next !== this.token;
    this.token = next;
    // Un canal de eventos abierto con la credencial anterior (o parado por no valer) se reconecta con la nueva.
    if (changed) for (const watcher of this.watchers) watcher.kick();
  }

  /**
   * Se suscribe a los cambios en tiempo real del servidor (`GET /api/events`, ver `events.ts`): avisos de qué cambió, nunca documentos. Se reconecta sola con espera
   * exponencial; si el servidor no ofrece el canal el estado queda en `unsupported` y quien lo usa sigue sondeando. Devuelve cómo cerrarla.
   * Los demás almacenes no tienen este método: quien lo usa comprueba `typeof store.watchEvents`.
   */
  watchEvents(handlers: EventsHandlers, options: EventsOptions = {}): { stop(): void; readonly state: EventsConnection['current'] } {
    const connection = new EventsConnection({ baseUrl: this.baseUrl, token: () => this.token, fetch: this.doFetch }, handlers, options);
    this.watchers.add(connection);
    connection.start();
    return {
      stop: () => {
        connection.stop();
        this.watchers.delete(connection);
      },
      get state() {
        return connection.current;
      },
    };
  }

  /** Quién es este token ante el servidor, o `{ auth: false }` si el servidor no pide autenticación. Sirve para «probar la conexión». */
  async whoami(): Promise<RemoteSession> {
    try {
      const found = (await this.request('GET', '/api/whoami')) as Payload;
      const user = parseUser(found.user);
      return { auth: found.auth === true, name: typeof found.name === 'string' ? found.name : undefined, role: typeof found.role === 'string' ? found.role : undefined, ...(user ? { user } : {}) };
    } catch (error) {
      // Un servidor anterior a la autenticación no tiene `/api/whoami` (404): basta con que ofrezca proyectos sin pedir token.
      if (!(error instanceof ProjectError) || error.code !== 'unavailable' || error.info.network) throw error;
      await this.listProjects();
      return { auth: false };
    }
  }

  // ───────────── cuentas: inicio de sesión de GitHub ─────────────

  /**
   * Qué formas de entrar ofrece el servidor (pública: no lleva el token). Un servidor anterior a las cuentas no tiene la ruta (404):
   * no ofrece ningún inicio de sesión, y no se sabe si acepta tokens, así que se supone que sí. Los demás fallos (red, no es IArk) lanzan.
   */
  async providers(): Promise<AuthProviders> {
    let found: Payload;
    try {
      found = (await this.request('GET', '/api/auth/providers', undefined, { anonymous: true })) as Payload;
    } catch (error) {
      if (error instanceof ProjectError && error.code === 'unavailable' && error.info.status === 404) return { providers: [], tokens: true };
      throw error;
    }
    const providers = Array.isArray(found.providers)
      ? found.providers.flatMap((entry: unknown) => {
          const { id, label } = (entry && typeof entry === 'object' ? entry : {}) as { id?: unknown; label?: unknown };
          return typeof id === 'string' && id ? [{ id, label: typeof label === 'string' && label ? label : id }] : [];
        })
      : [];
    return { providers, tokens: found.tokens !== false, ...(found.signup === 'open' || found.signup === 'invite' ? { signup: found.signup } : {}) };
  }

  /**
   * Cambia el código de un solo uso con el que el servidor devolvió a la persona (`#iark_code=`) por una sesión, demostrando con el
   * `verifier` que es quien empezó el inicio de sesión (PKCE). Un código no vale una segunda vez, acierte o no el `verifier`.
   * `invalid` (`serverCode: 'invalid-grant'`) si no vale o caducó; `unavailable` con el 429 si hay demasiados intentos fallidos.
   */
  async exchangeLoginCode(input: { code: string; verifier: string }): Promise<LoginGrant> {
    const found = (await this.request('POST', '/api/auth/exchange', { code: input.code, verifier: input.verifier }, { anonymous: true })) as Payload;
    const user = parseUser(found.user);
    if (typeof found.token !== 'string' || !found.token || !user) throw new ProjectError('unavailable', `${this.baseUrl} no respondió como un servidor de IArk con inicio de sesión (falta la sesión en la respuesta).`, { reason: 'server-no-session', params: { url: this.baseUrl } });
    return { token: found.token, expiresAt: typeof found.expiresAt === 'string' ? found.expiresAt : '', user };
  }

  /** Cierra la sesión que se está usando (`Authorization`): el servidor la invalida, así que no vale ni copiada. Con un token de `iark auth` falla (`invalid`): no es una sesión. */
  async logout(): Promise<void> {
    await this.request('POST', '/api/auth/logout');
  }

  // ───────────── cuentas: compartir un proyecto ─────────────

  /** Quién tiene acceso al proyecto y con qué rol (cualquiera que lo vea puede pedirlo). */
  async listMembers(projectId: string): Promise<ProjectMember[]> {
    const found = await this.request('GET', `${API}/${encodeURIComponent(projectId)}/members`);
    return (Array.isArray(found) ? found : []).flatMap((entry: unknown) => {
      const member = parseMember(entry);
      return member ? [member] : [];
    });
  }

  /**
   * Da acceso a una persona por su nombre de usuario de GitHub (si todavía no ha entrado, queda `pending` hasta que lo haga) o
   * le cambia el rol. Solo un administrador del proyecto. `conflict` (`last-admin`) si dejaría al proyecto sin administrador;
   * `invalid` (`limit`) si el servidor no admite más.
   */
  async setMember(projectId: string, login: string, role: ProjectRole): Promise<ProjectMember> {
    const name = cleanLogin(login);
    const member = parseMember(await this.request('PUT', `${API}/${encodeURIComponent(projectId)}/members/${encodeURIComponent(name)}`, { role }));
    if (!member) throw new ProjectError('unavailable', `${this.baseUrl} respondió algo que no es un miembro del proyecto.`, { reason: 'server-no-member', params: { url: this.baseUrl } });
    return member;
  }

  /** Quita el acceso de una persona (un administrador del proyecto) o, si es ella misma, sale del proyecto. `conflict` (`last-admin`) con el último administrador. */
  async removeMember(projectId: string, login: string): Promise<void> {
    await this.request('DELETE', `${API}/${encodeURIComponent(projectId)}/members/${encodeURIComponent(cleanLogin(login))}`);
  }

  // ───────────── cuentas: administrar la instancia ─────────────

  /**
   * Las cuentas de la instancia (con sus invitaciones sin reclamar), por nombre de usuario. Solo quien administra la instancia (una persona con rol
   * `admin` o un token de `--tokens` con rol `admin`): a los demás el servidor responde `forbidden`; sin cuentas (`--accounts`), `unavailable` (404).
   */
  async listAccounts(): Promise<AdminAccount[]> {
    const found = await this.request('GET', ADMIN_USERS);
    return (Array.isArray(found) ? found : []).flatMap((entry: unknown) => {
      const account = parseAccount(entry);
      return account ? [account] : [];
    });
  }

  /**
   * Cambia el rol de la instancia de una cuenta o la desactiva y reactiva (desactivarla cierra sus sesiones). Con un nombre de usuario que **no
   * existe** el servidor crea una invitación (rol `member` si no se dice otro) y `created` es `true`: es la forma de invitar a la instancia sin
   * compartir un proyecto. `conflict` (`serverCode`: `self`) con la propia cuenta y (`listed-admin`) con quien figura en `--admins`;
   * `invalid` (`limit`) si ya hay el máximo de invitaciones sin reclamar.
   */
  async setAccount(login: string, change: AccountChange): Promise<{ account: AdminAccount; created: boolean }> {
    const name = cleanLogin(login);
    const body: AccountChange = {
      ...(change.siteRole !== undefined ? { siteRole: change.siteRole } : {}),
      ...(change.disabled !== undefined ? { disabled: change.disabled } : {}),
      ...(change.quota !== undefined ? { quota: change.quota } : {}),
    };
    const { status, payload } = await this.exchange('PUT', `${ADMIN_USERS}/${encodeURIComponent(name)}`, body);
    const account = parseAccount(payload);
    if (!account) throw new ProjectError('unavailable', `${this.baseUrl} respondió algo que no es una cuenta.`, { reason: 'server-no-account', params: { url: this.baseUrl } });
    return { account, created: status === 201 };
  }

  // ───────────── cuotas ─────────────

  /**
   * Cuánto usa quien pregunta y cuánto puede usar (`GET /api/usage`). `undefined` si el servidor no tiene cuotas por persona (anterior a ellas, sin
   * cuentas, o la credencial es un token de servicio): no es un fallo, simplemente no hay nada que mostrar. Los demás fallos (red, sesión caducada) lanzan.
   */
  async usage(): Promise<AccountUsage | undefined> {
    let found: Payload;
    try {
      found = (await this.request('GET', '/api/usage')) as Payload;
    } catch (error) {
      if (error instanceof ProjectError && error.info.status === 404) return undefined;
      throw error;
    }
    const limits = parseLimits(found.limits);
    const usage = parseQuotaUsage(found.usage);
    if (!limits || !usage) return undefined;
    const projects = (Array.isArray(found.projects) ? found.projects : []).flatMap((entry: unknown) => {
      const project = parseProjectQuotaUsage(entry);
      return project ? [project] : [];
    });
    return { limits, usage, projects };
  }

  /** Cancela la invitación de quien todavía no ha entrado. Con quien ya entró el servidor responde `conflict`: se le quita el acceso desactivando su cuenta. */
  async cancelInvitation(login: string): Promise<void> {
    await this.request('DELETE', `${ADMIN_USERS}/${encodeURIComponent(cleanLogin(login))}`);
  }

  async listProjects(): Promise<ProjectSummary[]> {
    return (await this.request('GET', API)) as ProjectSummary[];
  }

  async getProject(id: string): Promise<ProjectSummary | undefined> {
    return this.read(() => this.request('GET', `${API}/${encodeURIComponent(id)}`)) as Promise<ProjectSummary | undefined>;
  }

  async createProject(input: { name: string; description?: string }): Promise<ProjectSummary> {
    return (await this.request('POST', API, { name: input.name, description: input.description })) as ProjectSummary;
  }

  async renameProject(id: string, name: string): Promise<ProjectSummary> {
    return (await this.request('PATCH', `${API}/${encodeURIComponent(id)}`, { name })) as ProjectSummary;
  }

  async deleteProject(id: string): Promise<void> {
    await this.request('DELETE', `${API}/${encodeURIComponent(id)}`);
  }

  async getDiagram(projectId: string, diagramId: string): Promise<Diagram | undefined> {
    return this.read(() => this.request('GET', `${API}/${encodeURIComponent(projectId)}/diagrams/${encodeURIComponent(diagramId)}`)) as Promise<Diagram | undefined>;
  }

  async saveDiagram(projectId: string, input: SaveDiagramInput): Promise<DiagramMeta> {
    const project = `${API}/${encodeURIComponent(projectId)}/diagrams`;
    if (input.id === undefined) {
      return (await this.request('POST', project, { module: input.module, name: input.name, text: input.text })) as DiagramMeta;
    }
    // Un diagrama no cambia de módulo: el servidor lo ignora al actualizar, así que se comprueba aquí (solo si alguien lo pide).
    if (input.module !== undefined) {
      const current = await this.getDiagram(projectId, input.id);
      if (!current) throw new ProjectError('not-found', `No existe el diagrama «${input.id}» en el proyecto «${projectId}».`, { reason: 'diagram-missing-in', params: { diagram: input.id, project: projectId } });
      if (current.module !== input.module) throw new ProjectError('invalid', `Un diagrama no cambia de módulo (es «${current.module}», no «${input.module}»).`, { reason: 'diagram-module-fixed', params: { module: current.module } });
    }
    return (await this.request('PUT', `${project}/${encodeURIComponent(input.id)}`, { text: input.text, ifUpdatedAt: input.ifUpdatedAt })) as DiagramMeta;
  }

  async renameDiagram(projectId: string, diagramId: string, name: string): Promise<DiagramMeta> {
    return (await this.request('PATCH', `${API}/${encodeURIComponent(projectId)}/diagrams/${encodeURIComponent(diagramId)}`, { name })) as DiagramMeta;
  }

  async deleteDiagram(projectId: string, diagramId: string): Promise<void> {
    await this.request('DELETE', `${API}/${encodeURIComponent(projectId)}/diagrams/${encodeURIComponent(diagramId)}`);
  }

  // ───────────── historial de versiones ─────────────

  private versionsPath(projectId: string, diagramId: string, rest = ''): string {
    return `${API}/${encodeURIComponent(projectId)}/diagrams/${encodeURIComponent(diagramId)}/versions${rest}`;
  }

  /** Como `request`, pero un 404 sin `code` (la ruta no existe: un servidor anterior al historial) se cuenta como lo que es. */
  private async versionsRequest(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
    try {
      return await this.request(method, path, body);
    } catch (error) {
      if (error instanceof ProjectError && error.code === 'unavailable' && error.info.status === 404 && !error.info.network) {
        throw new ProjectError('unsupported', 'Este servidor no guarda historial de versiones (¿es de una versión anterior de IArk?).', { ...error.info, reason: 'server-versions-unsupported' });
      }
      throw error;
    }
  }

  async listVersions(projectId: string, diagramId: string): Promise<VersionMeta[]> {
    const found = await this.versionsRequest('GET', this.versionsPath(projectId, diagramId));
    return (Array.isArray(found) ? found : []).flatMap((entry: unknown) => {
      const version = parseVersion(entry);
      return version ? [version] : [];
    });
  }

  async getVersion(projectId: string, diagramId: string, versionId: number): Promise<DiagramVersion | undefined> {
    const id = requireVersionId(versionId); // antes de `read`, que se tragaría el `invalid`
    const found = (await this.read(() => this.versionsRequest('GET', this.versionsPath(projectId, diagramId, `/${id}`)))) as Record<string, unknown> | undefined;
    const version = parseVersion(found);
    if (!found || !version || typeof found.text !== 'string') return undefined;
    return { ...version, text: found.text };
  }

  async restoreVersion(projectId: string, diagramId: string, versionId: number, options: RestoreOptions = {}): Promise<RestoredVersion> {
    // `by` no se envía: quién restaura lo decide el servidor con la identidad de la petición, no el cliente.
    const found = (await this.versionsRequest('POST', this.versionsPath(projectId, diagramId, `/${requireVersionId(versionId)}/restore`), { ifUpdatedAt: options.ifUpdatedAt })) as Record<string, unknown>;
    const version = parseVersion(found.version);
    if (!version || !found.diagram || typeof found.diagram !== 'object') throw new ProjectError('unavailable', `${this.baseUrl} respondió algo que no es una restauración.`, { reason: 'server-no-restore', params: { url: this.baseUrl } });
    return { diagram: found.diagram as DiagramMeta, version, unchanged: found.unchanged === true };
  }

  async labelVersion(projectId: string, diagramId: string, versionId: number, label: string): Promise<VersionMeta> {
    const version = parseVersion(await this.versionsRequest('PATCH', this.versionsPath(projectId, diagramId, `/${requireVersionId(versionId)}`), { label }));
    if (!version) throw new ProjectError('unavailable', `${this.baseUrl} respondió algo que no es una versión.`, { reason: 'server-no-version', params: { url: this.baseUrl } });
    return version;
  }

  async deleteVersion(projectId: string, diagramId: string, versionId: number): Promise<void> {
    await this.versionsRequest('DELETE', this.versionsPath(projectId, diagramId, `/${requireVersionId(versionId)}`));
  }

  /** Una lectura por id: lo que no existe (o un id que el servidor no acepta) es `undefined`, como en los almacenes locales. */
  private async read(get: () => Promise<unknown>): Promise<unknown> {
    try {
      return await get();
    } catch (error) {
      if (error instanceof ProjectError && (error.code === 'not-found' || error.code === 'invalid')) return undefined;
      throw error;
    }
  }

  /** `anonymous`: una ruta pública (providers, exchange) a la que no hace falta —ni conviene— mandar el token. */
  private async request(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, options: { anonymous?: boolean } = {}): Promise<unknown> {
    return (await this.exchange(method, path, body, options)).payload;
  }

  /** Como `request`, pero devuelve también el estado de la respuesta (201 «creado» frente a 200 «cambiado» importa al invitar). */
  private async exchange(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, options: { anonymous?: boolean } = {}): Promise<{ status: number; payload: unknown }> {
    // El servidor exige `Content-Type: application/json` en todo lo que modifica (también DELETE, con el cuerpo vacío).
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (this.token && !options.anonymous) headers.Authorization = `Bearer ${this.token}`;
    let response: Response;
    const payloadText = body === undefined ? undefined : JSON.stringify(body);
    try {
      response = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: payloadText,
        // Al cerrar la pestaña, un guardado en curso no debe cancelarse con ella (solo escrituras pequeñas: límite del navegador).
        ...(this.keepalive && method !== 'GET' && new TextEncoder().encode(payloadText ?? '').length <= KEEPALIVE_MAX_BYTES ? { keepalive: true } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
        // Nada de cookies ni credenciales del navegador (el token es la única credencial) y nada de respuestas guardadas en caché.
        credentials: 'omit',
        cache: 'no-store',
      } as RequestInit);
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      const reason = timedOut ? `no respondió en ${Math.round(this.timeoutMs / 1000)} s` : error instanceof Error ? error.message : String(error);
      throw new ProjectError(
        'unavailable',
        `No se pudo conectar con ${this.baseUrl}: ${reason}.`,
        timedOut
          ? { network: true, reason: 'server-timeout', params: { url: this.baseUrl, seconds: Math.round(this.timeoutMs / 1000) } }
          : { network: true, reason: 'server-unreachable', params: { url: this.baseUrl, detail: reason } },
      );
    }
    const raw = await response.text().catch(() => '');
    let payload: unknown = {};
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        // una respuesta que no es JSON (una página de error de un proxy, por ejemplo) no se puede interpretar
        if (response.ok) throw new ProjectError('unavailable', `${this.baseUrl} no respondió como un servidor de IArk (la respuesta no es JSON).`, { status: response.status, reason: 'server-not-json', params: { url: this.baseUrl } });
      }
    }
    if (!response.ok) throw errorFromResponse(response.status, payload && typeof payload === 'object' ? (payload as Payload) : {}, response.headers.get('Retry-After'));
    return { status: response.status, payload };
  }
}
