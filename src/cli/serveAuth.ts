import type { IncomingMessage } from 'node:http';
import { performance } from 'node:perf_hooks';
import { accountHttpError } from './accounts/errors';
import type { Accounts, PublicUser } from './accounts/service';
import { AccountError, SESSION_PREFIX, type AccountUser, type SiteRole } from './accounts/store';
import { HttpError } from './httpError';
import type { TokenIdentity, TokenStore } from './tokens';

/**
 * Autenticación por token de `iark serve --tokens` (la API de proyectos y `/api/whoami`): la cabecera
 * `Authorization: Bearer <token>`, comprobada contra el archivo de tokens (`tokens.ts`).
 *
 *  - 401 `{ error, code: 'unauthorized' }` + `WWW-Authenticate: Bearer realm="iark"`: sin cabecera, con otro esquema o con un
 *    token que no existe (o que se revocó). El mensaje es el mismo en todos esos casos: no dice si el token existió.
 *  - 429 `{ error, code: 'rate-limited' }` + `Retry-After`: demasiados intentos fallidos desde la misma dirección (ver `FailureLimiter`).
 *  - 503 `{ error, code: 'unavailable' }`: el archivo de tokens no se puede leer o está dañado. Se deniega todo, pero con otro
 *    código que el 401: así un cliente no confunde un servidor mal configurado con un token revocado (y no se lo olvida).
 *
 * Con cuentas (`--accounts`, ver `accounts/`) la cabecera puede traer también una sesión de GitHub (`iark_s_…`): se busca en el almacén
 * de cuentas y quien llama es una persona, con su rol en la instancia, no un token con un rol para toda la carpeta. Lo demás (401, 429, 503)
 * es igual. Un token o una sesión nunca se anota en ningún registro ni se devuelve en ninguna respuesta.
 */

export interface FailureLimiterOptions {
  /** Intentos fallidos que se toleran por dirección antes de frenar: tras el último, los siguientes dan 429 durante un plazo. */
  freeAttempts: number;
  /** Plazo del primer freno (ms); se duplica con cada fallo más. */
  baseMs: number;
  /** Tope del plazo (ms). */
  maxMs: number;
  /** Una dirección que no falla durante este tiempo (ms) se olvida. */
  forgetAfterMs: number;
  /** Direcciones que se recuerdan a la vez (la memoria no crece sin límite): se descartan primero las olvidables y luego las más antiguas. */
  maxEntries: number;
  /** El reloj, en milisegundos (en las pruebas, uno falso). */
  now: () => number;
}

const DEFAULT_LIMITS: FailureLimiterOptions = {
  freeAttempts: 5,
  baseMs: 1000,
  maxMs: 5 * 60_000,
  forgetAfterMs: 15 * 60_000,
  maxEntries: 10_000,
  now: () => performance.now(), // reloj monotónico: un cambio de hora del sistema no alarga ni acorta un freno
};

interface Attempts {
  failures: number;
  blockedUntil: number;
  lastFailure: number;
}

/**
 * Frena los intentos fallidos por dirección remota, en memoria. Con `freeAttempts` (5) fallos seguidos, la dirección queda frenada
 * 1 s, luego 2 s, 4 s… hasta el tope (5 min); mientras dure el freno **todas** sus peticiones a estas rutas reciben 429, también
 * las que traigan un token bueno (si no, el freno serviría de oráculo para seguir adivinando). Un acierto no borra los fallos
 * (se podría intercalar uno propio para no frenarse nunca): se olvidan con el tiempo (`forgetAfterMs`).
 */
export class FailureLimiter {
  private readonly options: FailureLimiterOptions;
  /** Por orden del último fallo (cada fallo reinserta su entrada), así lo más antiguo está primero. */
  private readonly attempts = new Map<string, Attempts>();

  constructor(options: Partial<FailureLimiterOptions> = {}) {
    this.options = { ...DEFAULT_LIMITS, ...options };
  }

  /** Direcciones que se recuerdan ahora mismo. */
  get size(): number {
    return this.attempts.size;
  }

  /** Segundos que faltan para que esta dirección pueda volver a intentarlo (al menos 1), o 0 si no está frenada. */
  retryAfter(address: string): number {
    const entry = this.attempts.get(address);
    if (!entry) return 0;
    const now = this.options.now();
    if (now - entry.lastFailure > this.options.forgetAfterMs) {
      this.attempts.delete(address);
      return 0;
    }
    return entry.blockedUntil > now ? Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000)) : 0;
  }

  /** Anota un intento fallido de esta dirección y, si ya pasó de los tolerados, la frena. */
  fail(address: string): void {
    const { freeAttempts, baseMs, maxMs, forgetAfterMs, maxEntries } = this.options;
    const now = this.options.now();
    const previous = this.attempts.get(address);
    const entry = previous && now - previous.lastFailure <= forgetAfterMs ? previous : { failures: 0, blockedUntil: 0, lastFailure: now };
    entry.failures = Math.min(entry.failures + 1, 1_000_000);
    entry.lastFailure = now;
    if (entry.failures >= freeAttempts) entry.blockedUntil = now + Math.min(maxMs, baseMs * 2 ** Math.min(entry.failures - freeAttempts, 30));
    this.attempts.delete(address);
    this.attempts.set(address, entry);
    for (const [key, old] of this.attempts) {
      if (this.attempts.size <= maxEntries && now - old.lastFailure <= forgetAfterMs) break;
      this.attempts.delete(key);
    }
  }
}

/** `::ffff:203.0.113.7` → `203.0.113.7`; el resto, en minúsculas y acotado. */
const normalizeAddress = (address: string): string => address.trim().toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '').slice(0, 64);

/**
 * La dirección con la que se frena a quien llama: la de la conexión o, con `trustProxy` (hay un proxy de confianza delante, que
 * es quien conecta), la última de `X-Forwarded-For`, que es la que añadió ese proxy. Sin proxy delante, `trustProxy` no debe
 * estar activo: cualquiera podría poner la cabecera y cambiar de dirección a voluntad.
 */
export function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const last = (Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? '')).split(',').map((a) => a.trim()).filter(Boolean).pop();
    if (last) return normalizeAddress(last);
  }
  return normalizeAddress(req.socket.remoteAddress ?? 'desconocida');
}

/** El token de una cabecera `Authorization: Bearer <token>` (el esquema no distingue mayúsculas), o `undefined`. */
export function bearerToken(header: string | undefined): string | undefined {
  return /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header ?? '')?.[1];
}

const unauthorized = (): HttpError =>
  new HttpError(401, 'Hace falta un token válido: envíe la cabecera «Authorization: Bearer <token>».', { code: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer realm="iark"' });

const rateLimited = (seconds: number): HttpError =>
  new HttpError(429, `Demasiados intentos fallidos desde esta dirección: espere ${seconds} s antes de volver a intentarlo.`, { code: 'rate-limited' }, { 'Retry-After': String(seconds) });

const unavailable = (): HttpError =>
  new HttpError(503, 'El servicio no puede comprobar los tokens ahora mismo (el archivo de tokens no está disponible). Avise a quien lo administra.', { code: 'unavailable' });

/** Quién llama: un token de `iark auth` (un rol para toda la carpeta de trabajo) o una persona con sesión de GitHub (su rol en cada proyecto lo da su pertenencia). */
export type Identity =
  | ({ kind: 'token' } & TokenIdentity)
  | { kind: 'user'; user: PublicUser; siteRole: SiteRole; /** El token de la sesión, para cerrarla. */ session: string };

export interface Authenticator {
  /** Quién llama: el dueño del token o de la sesión de la petición, o rechaza con el `HttpError` 401, 429 o 503 (el almacén de cuentas no responde). */
  identify(req: IncomingMessage): Promise<Identity>;
}

export interface AuthenticatorOptions {
  tokens?: TokenStore;
  accounts?: Accounts;
  /** Identifica a quien llama por `X-Forwarded-For` (ver `clientAddress`). */
  trustProxy?: boolean;
  limits?: Partial<FailureLimiterOptions>;
}

/** La cuenta de una sesión. Si el almacén no responde (la base de la red está caída) es un 503/500 de verdad, no un «sesión inválida» que cuente como intento fallido. */
async function lookupSession(accounts: Accounts, token: string): Promise<AccountUser | undefined> {
  try {
    return await accounts.store.lookupSession(token);
  } catch (error) {
    throw error instanceof AccountError ? accountHttpError(error) : error;
  }
}

export function createAuthenticator(options: AuthenticatorOptions): Authenticator {
  const limiter = new FailureLimiter(options.limits);
  return {
    async identify(req) {
      const address = clientAddress(req, options.trustProxy ?? false);
      const wait = limiter.retryAfter(address);
      if (wait > 0) throw rateLimited(wait);
      const header = req.headers.authorization;
      const token = bearerToken(header);
      if (options.accounts && token?.startsWith(SESSION_PREFIX)) {
        const user = await lookupSession(options.accounts, token);
        if (user) return { kind: 'user', user: options.accounts.publicUser(user), siteRole: options.accounts.siteRoleOf(user), session: token };
      } else if (options.tokens) {
        const found = options.tokens.lookup(token);
        if (found.status === 'unavailable') throw unavailable();
        if (found.status === 'ok') return { kind: 'token', name: found.name, role: found.role };
      }
      // Solo cuenta como intento fallido el que presentó credenciales: una petición sin cabecera no adivina nada.
      if (header !== undefined) limiter.fail(address);
      throw unauthorized();
    },
  };
}

/** ¿Es una dirección de loopback? (`localhost`, `127.x.x.x`, `::1` y su forma IPv4-mapeada); `0.0.0.0`, `::` y cualquier otra dirección o nombre, no. */
export function isLoopbackHost(host: string): boolean {
  const name = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return name === 'localhost' || name === '::1' || /^127(\.\d{1,3}){3}$/.test(name) || /^::ffff:127(\.\d{1,3}){3}$/.test(name);
}
