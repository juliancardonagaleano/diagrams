import { ProjectError, type ProjectErrorCode, type ProjectErrorInfo } from './errors';
import type { Diagram, DiagramMeta, ProjectRole, ProjectStore, ProjectSummary, SaveDiagramInput } from './types';

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
}

/** Lo que un administrador puede cambiar de una cuenta: su rol en la instancia y si está desactivada. */
export interface AccountChange {
  siteRole?: SiteRole;
  disabled?: boolean;
}

/** Las sesiones de persona que reparte el inicio de sesión de GitHub empiezan así; los tokens de `iark auth` (`iark_…`), no. */
export const SESSION_TOKEN_PREFIX = 'iark_s_';

const API = '/api/projects';
const ADMIN_USERS = '/api/admin/users';
const LOCAL_CODES: ReadonlySet<string> = new Set<ProjectErrorCode>(['not-found', 'exists', 'invalid', 'conflict']);
const ROLES: ReadonlySet<string> = new Set<ProjectRole>(['viewer', 'editor', 'admin']);
const SITE_ROLES: ReadonlySet<string> = new Set<SiteRole>(['admin', 'member', 'guest']);

/** `https://x.org/` o `https://x.org/api/projects/` → `https://x.org`. Lanza `invalid` si no es una dirección http(s). */
export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ProjectError('invalid', `«${value.trim().slice(0, 100)}» no es una dirección válida (por ejemplo https://iark.ejemplo.org).`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ProjectError('invalid', 'La dirección del servidor debe empezar por http:// o https://.');
  if (url.username || url.password) throw new ProjectError('invalid', 'La dirección del servidor no debe llevar usuario ni contraseña: el token se indica aparte.');
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api\/projects$/, '').replace(/\/api$/, '');
  return `${url.origin}${path}`;
}

interface Payload {
  error?: unknown;
  code?: unknown;
  [key: string]: unknown;
}

/** El error que corresponde a una respuesta que no es 2xx. */
function errorFromResponse(status: number, payload: Payload, retryAfter: string | null): ProjectError {
  const message = typeof payload.error === 'string' && payload.error ? payload.error : '';
  const code = typeof payload.code === 'string' ? payload.code : undefined;
  const info: ProjectErrorInfo = { status };
  if (code && LOCAL_CODES.has(code)) return new ProjectError(code as ProjectErrorCode, message || `Error ${status}.`, info);
  // Antes que el estado: un `limit` llega como 403 al crear proyectos y no es un problema de rol.
  if (code === 'last-admin') return new ProjectError('conflict', message || 'No se puede quitar ni degradar al último administrador del proyecto.', { ...info, serverCode: code });
  if (code === 'self' || code === 'listed-admin') return new ProjectError('conflict', message || 'La cuenta no admite ese cambio.', { ...info, serverCode: code });
  if (code === 'limit') return new ProjectError('invalid', message || 'Se alcanzó el máximo que permite este servidor.', { ...info, serverCode: code });
  if (code === 'invalid-grant') return new ProjectError('invalid', message || 'El código de inicio de sesión no es válido o caducó: vuelve a iniciar sesión.', { ...info, serverCode: code });
  if (status === 401 || code === 'unauthorized') return new ProjectError('unauthorized', message || 'El servidor pide un token de acceso válido.', info);
  if (status === 403 || code === 'forbidden') return new ProjectError('forbidden', message || 'Este token no tiene permiso para esa operación.', info);
  if (status === 429 || code === 'rate-limited') {
    const wait = Number(retryAfter);
    return new ProjectError('unavailable', message || `Demasiados intentos fallidos${Number.isFinite(wait) && wait > 0 ? `: espera ${Math.ceil(wait)} s` : ''}.`, info);
  }
  if (status === 413) return new ProjectError('invalid', message || 'El documento es demasiado grande para el servidor.', info);
  if (status === 400) return new ProjectError('invalid', message || 'El servidor rechazó la petición.', info);
  if (status === 404) return new ProjectError('unavailable', message || 'Ese servidor no ofrece proyectos (¿arrancó sin --workspace, o la dirección no es la de IArk?).', info);
  return new ProjectError('unavailable', `El servidor respondió ${status}${message ? `: ${message}` : ''}.`, info);
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
  };
}

/** Un nombre de usuario de GitHub como se escribe a mano (`@octocat`, con espacios) → `octocat`. Lanza `invalid` si queda vacío. */
function cleanLogin(value: string): string {
  const login = value.trim().replace(/^@/, '');
  if (!login) throw new ProjectError('invalid', 'Falta el nombre de usuario de GitHub.');
  return login;
}

export class HttpProjectStore implements ProjectStore {
  readonly kind = 'http';
  /** La dirección del servicio, ya normalizada. */
  readonly baseUrl: string;
  private token: string | undefined;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly keepalive: boolean;

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
    this.token = token?.trim() || undefined;
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
    if (typeof found.token !== 'string' || !found.token || !user) throw new ProjectError('unavailable', `${this.baseUrl} no respondió como un servidor de IArk con inicio de sesión (falta la sesión en la respuesta).`);
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
    if (!member) throw new ProjectError('unavailable', `${this.baseUrl} respondió algo que no es un miembro del proyecto.`);
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
    const body: AccountChange = { ...(change.siteRole !== undefined ? { siteRole: change.siteRole } : {}), ...(change.disabled !== undefined ? { disabled: change.disabled } : {}) };
    const { status, payload } = await this.exchange('PUT', `${ADMIN_USERS}/${encodeURIComponent(name)}`, body);
    const account = parseAccount(payload);
    if (!account) throw new ProjectError('unavailable', `${this.baseUrl} respondió algo que no es una cuenta.`);
    return { account, created: status === 201 };
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
      if (!current) throw new ProjectError('not-found', `No existe el diagrama «${input.id}» en el proyecto «${projectId}».`);
      if (current.module !== input.module) throw new ProjectError('invalid', `Un diagrama no cambia de módulo (es «${current.module}», no «${input.module}»).`);
    }
    return (await this.request('PUT', `${project}/${encodeURIComponent(input.id)}`, { text: input.text, ifUpdatedAt: input.ifUpdatedAt })) as DiagramMeta;
  }

  async renameDiagram(projectId: string, diagramId: string, name: string): Promise<DiagramMeta> {
    return (await this.request('PATCH', `${API}/${encodeURIComponent(projectId)}/diagrams/${encodeURIComponent(diagramId)}`, { name })) as DiagramMeta;
  }

  async deleteDiagram(projectId: string, diagramId: string): Promise<void> {
    await this.request('DELETE', `${API}/${encodeURIComponent(projectId)}/diagrams/${encodeURIComponent(diagramId)}`);
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
      throw new ProjectError('unavailable', `No se pudo conectar con ${this.baseUrl}: ${reason}.`, { network: true });
    }
    const raw = await response.text().catch(() => '');
    let payload: unknown = {};
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        // una respuesta que no es JSON (una página de error de un proxy, por ejemplo) no se puede interpretar
        if (response.ok) throw new ProjectError('unavailable', `${this.baseUrl} no respondió como un servidor de IArk (la respuesta no es JSON).`, { status: response.status });
      }
    }
    if (!response.ok) throw errorFromResponse(response.status, payload && typeof payload === 'object' ? (payload as Payload) : {}, response.headers.get('Retry-After'));
    return { status: response.status, payload };
  }
}
