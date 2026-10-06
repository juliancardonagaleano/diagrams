import { isGithubLogin, type GithubProfile } from './store';

/**
 * Cliente de la OAuth App de GitHub (el flujo web de «Sign in with GitHub»), sin dependencias: `fetch`.
 *
 *  1. `authorizeUrl` lleva a la persona a GitHub para que acepte (sin permisos: no se pide ningún scope, así que GitHub solo da
 *     acceso a su información pública, que es todo lo que hace falta para saber quién es).
 *  2. GitHub vuelve con un `code`; `profileFromCode` lo cambia por un token de GitHub, lee `GET /user` y **olvida el token**: se
 *     revoca enseguida, no se guarda ni se registra. Después del inicio de sesión, IArk no tiene acceso a nada de GitHub.
 *
 * `baseUrl` y `apiUrl` son los de github.com por omisión; con GitHub Enterprise Server se apuntan a su servidor
 * (`https://git.empresa.com` y `https://git.empresa.com/api/v3`), y las pruebas los apuntan a un GitHub de mentira.
 */

export type GithubErrorCode =
  /** La persona no aceptó, o GitHub rechazó el `code` (caducado, ya usado o de otra aplicación). */
  | 'rejected'
  /** No se llega a GitHub, tardó demasiado o respondió con un error suyo. */
  | 'unavailable'
  /** GitHub respondió, pero no con un perfil que se pueda aceptar. */
  | 'bad-profile';

export class GithubError extends Error {
  constructor(
    readonly code: GithubErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GithubError';
  }
}

export interface GithubOptions {
  clientId: string;
  clientSecret: string;
  /** Por omisión `https://github.com`. */
  baseUrl?: string;
  /** Por omisión `https://api.github.com`. */
  apiUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const trimSlash = (url: string): string => url.replace(/\/+$/, '');

/** Un texto del perfil, para mostrar: sin caracteres de control y acotado. */
function shown(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : undefined;
}

/** Solo una foto servida por https: va a un `<img src>` del navegador. */
function avatar(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 400) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** El perfil que devuelve `GET /user`, validado: un `id` y un `login` que valgan, y el resto opcional. */
export function parseGithubProfile(value: unknown): GithubProfile {
  if (!value || typeof value !== 'object') throw new GithubError('bad-profile', 'GitHub no devolvió un perfil.');
  const { id, login, name, avatar_url: avatarUrl, type } = value as Record<string, unknown>;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new GithubError('bad-profile', 'El perfil de GitHub no trae un identificador válido.');
  if (!isGithubLogin(login)) throw new GithubError('bad-profile', 'El perfil de GitHub no trae un nombre de usuario válido.');
  if (type !== undefined && type !== 'User') throw new GithubError('bad-profile', 'Solo pueden entrar personas, no organizaciones ni aplicaciones.');
  const profileName = shown(name, 120);
  const profileAvatar = avatar(avatarUrl);
  return { id, login, ...(profileName ? { name: profileName } : {}), ...(profileAvatar ? { avatarUrl: profileAvatar } : {}) };
}

export class GithubOAuth {
  readonly clientId: string;
  private readonly clientSecret: string;
  private readonly baseUrl: string;
  private readonly apiUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: GithubOptions) {
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.baseUrl = trimSlash(options.baseUrl ?? 'https://github.com');
    this.apiUrl = trimSlash(options.apiUrl ?? 'https://api.github.com');
    this.doFetch = options.fetch ?? ((...args) => fetch(...args));
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** La dirección de GitHub a la que se manda a la persona. `redirectUri` debe ser la «Authorization callback URL» de la OAuth App. */
  authorizeUrl(params: { redirectUri: string; state: string }): string {
    const url = new URL(`${this.baseUrl}/login/oauth/authorize`);
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set('state', params.state);
    url.searchParams.set('allow_signup', 'true');
    return url.toString();
  }

  private async call(url: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await this.doFetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error', cache: 'no-store' } as RequestInit);
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new GithubError('unavailable', timedOut ? 'GitHub no respondió a tiempo.' : 'No se pudo hablar con GitHub.');
    }
    const raw = await response.text().catch(() => '');
    let body: unknown = {};
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = {};
      }
    }
    return { status: response.status, body };
  }

  /** Cambia el `code` por el perfil de la persona. El token de GitHub no sale de esta función. */
  async profileFromCode(code: string, redirectUri: string): Promise<GithubProfile> {
    const exchanged = await this.call(`${this.baseUrl}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'iark-diagrams' },
      body: JSON.stringify({ client_id: this.clientId, client_secret: this.clientSecret, code, redirect_uri: redirectUri }),
    });
    const payload = (exchanged.body && typeof exchanged.body === 'object' ? exchanged.body : {}) as Record<string, unknown>;
    if (exchanged.status >= 500) throw new GithubError('unavailable', 'GitHub respondió con un error suyo.');
    const token = payload.access_token;
    if (typeof token !== 'string' || !token) {
      // GitHub responde 200 con `{ error: 'bad_verification_code' }` y similares: de la persona (o del código), no del servicio.
      if (typeof payload.error === 'string' && payload.error !== 'temporarily_unavailable') throw new GithubError('rejected', 'GitHub no aceptó el código de inicio de sesión (puede haber caducado).');
      throw new GithubError('unavailable', 'GitHub no entregó un token.');
    }
    try {
      const found = await this.call(`${this.apiUrl}/user`, {
        method: 'GET',
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'iark-diagrams', 'X-GitHub-Api-Version': '2022-11-28' },
      });
      if (found.status === 401 || found.status === 403) throw new GithubError('rejected', 'GitHub no dejó leer el perfil.');
      if (found.status < 200 || found.status >= 300) throw new GithubError('unavailable', 'GitHub respondió con un error al leer el perfil.');
      return parseGithubProfile(found.body);
    } finally {
      void this.revoke(token);
    }
  }

  /** Revoca el token de GitHub (el acceso de IArk acaba aquí). Mejor esfuerzo: un fallo no cambia nada para la persona. */
  private async revoke(token: string): Promise<void> {
    try {
      await this.call(`${this.apiUrl}/applications/${encodeURIComponent(this.clientId)}/token`, {
        method: 'DELETE',
        headers: {
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'iark-diagrams',
          Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
        },
        body: JSON.stringify({ access_token: token }),
      });
    } catch {
      // nada que hacer: el token caduca solo si la persona revoca la aplicación o nunca se vuelve a usar
    }
  }
}
