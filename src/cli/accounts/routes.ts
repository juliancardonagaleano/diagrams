import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError } from '../httpError';
import { bearerToken, clientAddress, FailureLimiter, type Authenticator } from '../serveAuth';
import { GithubError } from './github';
import type { Accounts, PublicUser } from './service';
import { AccountError, SESSION_PREFIX } from './store';

/**
 * Inicio de sesión con GitHub: las rutas `/api/auth/…` de `iark serve --accounts`.
 *
 *   GET  /api/auth/providers                       público: { providers: [{ id, label }], tokens, signup } (qué formas de entrar ofrece la instancia)
 *   GET  /api/auth/github/login?redirect=&challenge=   lleva a GitHub (302). `redirect`: a dónde volver (el propio sitio o un origen de --cors);
 *                                                      `challenge`: sha256 en base64url de un secreto (`verifier`) que solo conoce quien inicia el inicio de sesión
 *   GET  /api/auth/github/callback?code=&state=    adonde GitHub devuelve a la persona: vuelve a `redirect#iark_code=<código>` (o `#iark_error=<motivo>`)
 *   POST /api/auth/exchange                        cuerpo { code, verifier } → { token, expiresAt, user }: cambia el código por una sesión
 *   POST /api/auth/logout                          con la sesión en `Authorization: Bearer` → la cierra
 *
 * El diseño sigue lo que recomienda OAuth para aplicaciones de navegador:
 *  - `state` (un valor al azar que se guarda en el servidor y también en una cookie `HttpOnly` de ese navegador) liga la vuelta de GitHub
 *    con quien la empezó: nadie puede hacer que otra persona termine un inicio de sesión que él empezó.
 *  - El navegador no recibe la sesión en la URL: recibe un **código de un solo uso** (60 s) en el fragmento (`#…`, que no viaja al servidor
 *    ni queda en registros ni en `Referer`), y lo cambia por la sesión con `POST /api/auth/exchange` demostrando que es quien inició el flujo
 *    (PKCE: manda el `verifier` cuyo sha256 se dio en `challenge`). Un código robado no sirve sin el `verifier`.
 *  - `redirect` solo puede ser el propio sitio o un origen de `--cors` (nunca `*`): no hay redirección abierta.
 *  - El token de GitHub se usa una vez para leer el perfil y se revoca; DIAgrams no conserva acceso a GitHub.
 * La sesión es un token (`iark_s_…`) que se usa como cualquier otro: `Authorization: Bearer`. Nunca va en una cookie, así que no hay CSRF.
 */

const STATE_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 60_000;
const MAX_PENDING = 2000;
const COOKIE = 'iark_oauth';
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9_-]{43,128}$/;

interface PendingLogin {
  redirect: string;
  challenge: string;
  expires: number;
}

interface PendingCode {
  userId: string;
  challenge: string;
  expires: number;
}

/** Un tope de peticiones por dirección y ventana de tiempo (en memoria): las rutas que gastan memoria o llaman a GitHub no se pueden usar sin límite. */
class WindowLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number,
    private readonly maxEntries = 10_000,
  ) {}

  /** Anota una petición y dice si cabe en el tope. */
  allow(address: string): boolean {
    const now = this.now();
    let entry = this.hits.get(address);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.delete(address);
      this.hits.set(address, entry);
      for (const [key, old] of this.hits) {
        if (this.hits.size <= this.maxEntries && old.resetAt > now) break;
        this.hits.delete(key);
      }
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
}

const sha256Base64Url = (value: string): string => createHash('sha256').update(value, 'utf8').digest('base64url');
const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** La cookie de esta petición por su nombre (las cookies no se decodifican: el valor es base64url). */
function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
}

export interface AuthApiContext {
  accounts: Accounts | undefined;
  /** Con tokens o cuentas: quien identifica a quien llama (para cerrar sesión). */
  auth: Authenticator | undefined;
  /** Hay un archivo de tokens (`--tokens`): se anuncia en `providers`. */
  tokens: boolean;
  trustProxy: boolean;
  readBody(req: IncomingMessage): Promise<string>;
  send(res: ServerResponse, status: number, body: string | Buffer, headers?: Record<string, string>): void;
  sendJson(res: ServerResponse, status: number, value: unknown, headers?: Record<string, string>): void;
  /** El reloj en milisegundos para los plazos y topes (las pruebas lo adelantan). */
  now?: () => number;
  /** Para la auditoría (`observability/`): una persona completó el inicio de sesión, es decir, cambió su código por una sesión. */
  onLogin?(req: IncomingMessage, user: PublicUser): void;
  /**
   * Para la auditoría: un intento de iniciar sesión que no llegó a sesión. `reason` es un código estable (`access_denied`, `not_invited`,
   * `disabled`, `state-mismatch`, `invalid-grant`, `github_unavailable`, `login_failed`) y `login` el nombre de GitHub, si se llegó a saber.
   */
  onLoginFailed?(req: IncomingMessage, failure: { reason: string; result: 'denied' | 'error'; login?: string }): void;
}

const PAGE = (message: string): string =>
  `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DIAgrams</title>` +
  `<body style="font:16px system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">DIAgrams</h1><p>${message}</p><p><a href="./">Volver a empezar</a></p></body></html>`;

const isJson = (req: IncomingMessage): boolean => (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() === 'application/json';

/** El manejador de `/api/auth/…`. `parts` son los segmentos de la ruta ya decodificados, sin `auth`. */
export function createAuthApi(ctx: AuthApiContext): (req: IncomingMessage, res: ServerResponse, url: URL, parts: string[]) => Promise<void> {
  const accounts = ctx.accounts;
  const now = ctx.now ?? (() => performance.now());
  const wall = ctx.now ?? ((): number => Date.now());
  const logins = new Map<string, PendingLogin>();
  const codes = new Map<string, PendingCode>();
  const flows = new WindowLimiter(120, 10 * 60_000, now);
  const exchanges = new FailureLimiter({ ...(ctx.now ? { now: ctx.now } : {}) });
  const secure = accounts?.publicUrl?.startsWith('https:') ?? false;

  /** Descarta lo caducado y, si aun así no cabe, lo más antiguo (la memoria no crece sin límite). */
  function trim<T extends { expires: number }>(map: Map<string, T>): void {
    const t = wall();
    for (const [key, value] of map) {
      if (map.size < MAX_PENDING && value.expires > t) break;
      map.delete(key);
    }
  }

  const methodOnly = (req: IncomingMessage, allowed: 'GET' | 'POST'): void => {
    if (req.method !== allowed) throw new HttpError(405, `Este endpoint solo admite ${allowed}.`, { allow: allowed });
  };

  const cookieHeader = (value: string, maxAge: number): string => `${COOKIE}=${value}; Max-Age=${maxAge}; Path=${accounts?.publicUrl ? new URL(accounts.publicUrl).pathname.replace(/\/+$/, '') : ''}/api/auth/github; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

  const redirectTo = (res: ServerResponse, location: string, headers: Record<string, string> = {}): void => ctx.send(res, 302, '', { Location: location, ...headers });

  /** Vuelve al sitio de la persona con un fragmento `#iark_code=…` o `#iark_error=…` (el fragmento no llega a ningún servidor). */
  const back = (res: ServerResponse, redirect: string, fragment: Record<string, string>): void => {
    const target = new URL(redirect);
    target.hash = new URLSearchParams(fragment).toString();
    redirectTo(res, target.toString(), { 'Set-Cookie': cookieHeader('', 0), 'Referrer-Policy': 'no-referrer' });
  };

  function login(req: IncomingMessage, res: ServerResponse, url: URL): void {
    methodOnly(req, 'GET');
    const github = accounts?.github;
    if (!accounts || !github || !accounts.callbackUrl) throw new HttpError(404, 'Esta instancia no tiene inicio de sesión con GitHub.');
    if (!flows.allow(clientAddress(req, ctx.trustProxy))) throw new HttpError(429, 'Demasiados intentos de iniciar sesión desde esta dirección: espere unos minutos.', { code: 'rate-limited' }, { 'Retry-After': '600' });
    const challenge = url.searchParams.get('challenge') ?? '';
    if (!CHALLENGE.test(challenge)) throw new HttpError(400, 'Falta "challenge": el sha256 en base64url (43 caracteres) de un secreto que solo conoce quien inicia el inicio de sesión.');
    let redirect: URL;
    try {
      redirect = new URL(url.searchParams.get('redirect') ?? `${accounts.publicUrl}/`);
    } catch {
      throw new HttpError(400, '"redirect" no es una dirección válida.');
    }
    if (!accounts.redirectAllowed(redirect)) {
      throw new HttpError(400, 'Esa dirección de vuelta no está autorizada: solo puede ser este mismo sitio o un origen que se nombró con --cors.');
    }
    redirect.hash = '';
    trim(logins);
    const state = randomBytes(24).toString('base64url');
    logins.set(state, { redirect: redirect.toString(), challenge, expires: wall() + STATE_TTL_MS });
    redirectTo(res, github.authorizeUrl({ redirectUri: accounts.callbackUrl, state }), { 'Set-Cookie': cookieHeader(state, STATE_TTL_MS / 1000) });
  }

  async function callback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    methodOnly(req, 'GET');
    const github = accounts?.github;
    if (!accounts || !github || !accounts.callbackUrl) throw new HttpError(404, 'Esta instancia no tiene inicio de sesión con GitHub.');
    const address = clientAddress(req, ctx.trustProxy);
    if (!flows.allow(address)) throw new HttpError(429, 'Demasiados intentos de iniciar sesión desde esta dirección: espere unos minutos.', { code: 'rate-limited' }, { 'Retry-After': '600' });
    // Lo primero es saber que esta vuelta es de un inicio de sesión de este navegador. Se consume ya: un `state` solo vale una vez.
    const state = url.searchParams.get('state') ?? '';
    const pending = logins.get(state);
    logins.delete(state);
    const bound = cookie(req, COOKIE);
    if (!pending || pending.expires <= wall() || !bound || !sameText(bound, state)) {
      ctx.onLoginFailed?.(req, { reason: 'state-mismatch', result: 'denied' });
      return ctx.send(res, 400, PAGE('El inicio de sesión caducó o no se empezó desde este navegador. Vuelve a empezar desde DIAgrams.'), { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': cookieHeader('', 0) });
    }
    const fail = (reason: string, result: 'denied' | 'error' = 'denied', login?: string): void => {
      ctx.onLoginFailed?.(req, { reason, result, login });
      back(res, pending.redirect, { iark_error: reason });
    };
    if (url.searchParams.get('error')) return fail('access_denied'); // la persona no aceptó en GitHub
    const code = url.searchParams.get('code');
    if (!code || code.length > 512) return fail('login_failed', 'error');
    let profile: Awaited<ReturnType<typeof github.profileFromCode>> | undefined;
    let user;
    try {
      profile = await github.profileFromCode(code, accounts.callbackUrl);
      user = accounts.store.signIn(profile, { signup: accounts.signup, admin: accounts.isAdminProfile(profile) });
    } catch (error) {
      if (error instanceof AccountError && error.code === 'not-invited') return fail('not_invited', 'denied', profile?.login);
      if (error instanceof AccountError && error.code === 'disabled') return fail('disabled', 'denied', profile?.login);
      if (error instanceof GithubError) {
        // Para quien opera el servicio (un Client secret equivocado es el error más común): el motivo, nunca el código ni el secreto.
        process.stderr.write(`inicio de sesión: GitHub no lo aceptó (${error.code}): ${error.message}\n`);
        return error.code === 'unavailable' ? fail('github_unavailable', 'error') : fail('login_failed', 'error');
      }
      process.stderr.write(`error al iniciar sesión: ${(error as Error).message}\n`);
      return fail('login_failed', 'error', profile?.login);
    }
    trim(codes);
    const issued = randomBytes(32).toString('base64url');
    codes.set(sha256Hex(issued), { userId: user.id, challenge: pending.challenge, expires: wall() + CODE_TTL_MS });
    back(res, pending.redirect, { iark_code: issued });
  }

  async function exchange(req: IncomingMessage, res: ServerResponse): Promise<void> {
    methodOnly(req, 'POST');
    if (!accounts?.github) throw new HttpError(404, 'Esta instancia no tiene inicio de sesión con GitHub.');
    if (!isJson(req)) throw new HttpError(415, 'Esta operación exige Content-Type: application/json.');
    const address = clientAddress(req, ctx.trustProxy);
    const wait = exchanges.retryAfter(address);
    if (wait > 0) throw new HttpError(429, `Demasiados intentos fallidos desde esta dirección: espere ${wait} s antes de volver a intentarlo.`, { code: 'rate-limited' }, { 'Retry-After': String(wait) });
    let body: { code?: unknown; verifier?: unknown };
    try {
      body = JSON.parse(await ctx.readBody(req));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, 'El cuerpo debe ser JSON: { "code": "…", "verifier": "…" }.');
    }
    const invalid = (): HttpError => {
      exchanges.fail(address);
      ctx.onLoginFailed?.(req, { reason: 'invalid-grant', result: 'denied' });
      return new HttpError(400, 'El código de inicio de sesión no es válido o caducó: vuelve a iniciar sesión.', { code: 'invalid-grant' });
    };
    if (!body || typeof body.code !== 'string' || typeof body.verifier !== 'string' || body.code.length > 512 || !VERIFIER.test(body.verifier)) throw invalid();
    // El código se gasta en el primer intento, acierte o no el `verifier`: no se puede probar uno tras otro.
    const key = sha256Hex(body.code);
    const found = codes.get(key);
    codes.delete(key);
    if (!found || found.expires <= wall() || !sameText(sha256Base64Url(body.verifier), found.challenge)) throw invalid();
    const user = accounts.store.findUser(found.userId);
    if (!user || user.disabled) throw invalid();
    const session = accounts.store.createSession(user.id, accounts.sessionTtlMs);
    ctx.onLogin?.(req, accounts.publicUser(user));
    ctx.sendJson(res, 200, { token: session.token, expiresAt: session.expiresAt, user: accounts.publicUser(user) });
  }

  function logout(req: IncomingMessage, res: ServerResponse): void {
    methodOnly(req, 'POST');
    if (!ctx.auth) throw new HttpError(404, 'Esta instancia no tiene autenticación.');
    ctx.auth.identify(req); // 401, 429 o 503 si no hay una sesión que valga
    const token = bearerToken(req.headers.authorization);
    if (!accounts || !token?.startsWith(SESSION_PREFIX)) throw new HttpError(400, 'Este token no es una sesión: no se puede cerrar así (para revocarlo, `iark auth revoke`).', { code: 'not-a-session' });
    accounts.store.revokeSession(token);
    ctx.sendJson(res, 200, { loggedOut: true });
  }

  return async (req, res, url, parts) => {
    const [first, second] = parts;
    if (first === 'providers' && parts.length === 1) {
      methodOnly(req, 'GET');
      return ctx.sendJson(res, 200, { providers: accounts?.github ? [{ id: 'github', label: 'GitHub' }] : [], tokens: ctx.tokens, ...(accounts ? { signup: accounts.signup } : {}) });
    }
    if (first === 'github' && second === 'login' && parts.length === 2) return login(req, res, url);
    if (first === 'github' && second === 'callback' && parts.length === 2) return callback(req, res, url);
    if (first === 'exchange' && parts.length === 1) return exchange(req, res);
    if (first === 'logout' && parts.length === 1) return logout(req, res);
    throw new HttpError(404, 'Ruta de autenticación desconocida. Ver /api/auth/providers.');
  };
}
