import { HttpProjectStore, normalizeBaseUrl, ProjectError, SESSION_TOKEN_PREFIX, type AuthProviders, type PublicUser } from '@iark/kernel';
import { t, tAny, type MessageKey } from '../i18n';
import { projectErrorText } from '../i18n/errores';
import { browserAreas, hostOf, loadBackend, saveBackend, type StorageAreas } from './backend';

/**
 * Inicio de sesión con GitHub desde el navegador (sin React: lo usan el panel «Dónde se guardan» y los dos puntos de entrada de la app).
 *
 *  1. `startGithubLogin`: genera un secreto (`verifier`, PKCE), lo guarda con el servidor en `sessionStorage` (solo esta pestaña) y lleva a la
 *     persona —navegación de página completa— a `<servidor>/api/auth/github/login`, que la manda a GitHub y la devuelve a esta misma página
 *     con `#iark_code=<código de un solo uso>` (o `#iark_error=<motivo>`).
 *  2. `completeGithubLogin` se ejecuta **al arrancar la página, antes de crear la sesión de proyectos**: lee ese fragmento, lo borra de la
 *     dirección al momento (que el código no se quede en el historial), lo cambia por una sesión con el `verifier` guardado y deja el servidor
 *     como almacén activo. Si algo falla, deja un aviso que la persona entienda (`getLoginNotice`).
 *
 * El código por sí solo no sirve (hace falta el `verifier`, que nunca sale de esta pestaña salvo hacia el servidor que se eligió) y el servidor lo
 * gasta en el primer intento. Ni el `verifier` ni la sesión se escriben en ningún mensaje, aviso ni registro.
 */

/** Dónde se anota, en `sessionStorage`, un inicio de sesión en curso. */
export const PENDING_KEY = 'iark.login.pending';
/** Lo que se tolera entre salir hacia GitHub y volver (el `state` del servidor también caduca a los 10 minutos). */
export const PENDING_MAX_AGE_MS = 10 * 60_000;
/** Una sesión de persona (`iark_s_…`), no un token de `iark auth`. */
export const isSessionToken = (token: string | undefined): boolean => token?.startsWith(SESSION_TOKEN_PREFIX) === true;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Todo lo que toca el navegador, para poder sustituirlo en las pruebas. Lo que no se da se toma de `window`. */
export interface LoginEnv {
  crypto?: { getRandomValues<T extends ArrayBufferView>(array: T): T; subtle?: { digest(algorithm: string, data: BufferSource): Promise<ArrayBuffer> } };
  fetch?: typeof fetch;
  /** `sessionStorage`: donde espera el inicio de sesión en curso. */
  session?: StorageLike;
  /** La página actual (solo se lee `href`, con el fragmento si lo hay). */
  location?: { href: string };
  history?: Pick<History, 'replaceState' | 'state'>;
  /** Lleva a la persona a otra página (por omisión, `location.assign`). */
  navigate?(url: string): void;
  now?(): number;
  /** Dónde se guarda la sesión obtenida (el mismo almacén que el resto de la configuración). */
  areas?: StorageAreas;
}

interface Pending {
  url: string;
  verifier: string;
  remember: boolean;
  startedAt: number;
  /** El nombre que la persona le puso al servidor al escribirlo (no es secreto). */
  label?: string;
}

const base64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

function sessionArea(env: LoginEnv): StorageLike | undefined {
  if (env.session) return env.session;
  try {
    return window.sessionStorage;
  } catch {
    return undefined; // acceder a la propiedad ya puede lanzar con los datos del sitio bloqueados
  }
}

function readPending(area: StorageLike | undefined): Pending | undefined {
  try {
    const raw = area?.getItem(PENDING_KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<Pending> | null;
    if (!value || typeof value.url !== 'string' || typeof value.verifier !== 'string' || typeof value.startedAt !== 'number') return undefined;
    return { url: value.url, verifier: value.verifier, remember: value.remember === true, startedAt: value.startedAt, ...(typeof value.label === 'string' && value.label.trim() ? { label: value.label.trim() } : {}) };
  } catch {
    return undefined;
  }
}

function dropPending(area: StorageLike | undefined): void {
  try {
    area?.removeItem(PENDING_KEY);
  } catch {
    /* nada que quitar */
  }
}

// ───────────── el aviso que ve la persona al volver ─────────────

/** Lo que pasó al volver de GitHub, para decírselo a la persona: `ok` (entró) o `error` (no pudo entrar y por qué, en lenguaje claro). */
export interface LoginNotice {
  kind: 'ok' | 'error';
  message: string;
  /** Con `error`, el motivo (`not_invited`, `expired`…): estable para las pruebas; el texto es para la persona. */
  reason?: string;
  /** Con `error`, el servidor al que se intentaba entrar (para dejarlo escrito al volver a intentarlo). */
  url?: string;
}

let notice: LoginNotice | undefined;
const noticeListeners = new Set<() => void>();

export const getLoginNotice = (): LoginNotice | undefined => notice;
export const subscribeLoginNotice = (listener: () => void): (() => void) => {
  noticeListeners.add(listener);
  return () => noticeListeners.delete(listener);
};
export function setLoginNotice(next: LoginNotice | undefined): void {
  notice = next;
  for (const listener of noticeListeners) listener();
}

/** Qué le pasa a la persona según el motivo con que el servidor la devolvió (`#iark_error=`). Un motivo desconocido no se repite: es el genérico. */
const SERVER_REASONS: Record<string, MessageKey> = {
  access_denied: 'login.reason.access_denied',
  not_invited: 'login.reason.not_invited',
  disabled: 'login.reason.disabled',
  github_unavailable: 'login.reason.github_unavailable',
  login_failed: 'login.reason.login_failed',
};

export function loginErrorMessage(reason: string): string {
  return tAny(Object.hasOwn(SERVER_REASONS, reason) ? SERVER_REASONS[reason] : SERVER_REASONS.login_failed);
}

// ───────────── 1. salir hacia GitHub ─────────────

/** Un secreto de 43 caracteres base64url (256 bits) y su `challenge`: el sha256 en base64url (PKCE S256). */
export async function createPkcePair(env: LoginEnv = {}): Promise<{ verifier: string; challenge: string }> {
  const cryptoApi = env.crypto ?? (typeof crypto === 'undefined' ? undefined : crypto);
  if (!cryptoApi?.getRandomValues || !cryptoApi.subtle) {
    throw new ProjectError('unavailable', 'Este navegador no ofrece criptografía a esta página (hace falta https, o localhost): ábrela por https para iniciar sesión con GitHub.', { reason: 'login-no-crypto' });
  }
  const verifier = base64Url(cryptoApi.getRandomValues(new Uint8Array(32)));
  const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

/**
 * Empieza el inicio de sesión: anota `{ url, verifier, remember, startedAt }` en `sessionStorage` y lleva a la persona a
 * `<servidor>/api/auth/github/login`, pidiendo volver a esta misma página (sin fragmento). Devuelve esa dirección (la página se recarga).
 * `remember`: dónde dejar la sesión al volver, como el token: `true` en este equipo (`localStorage`), `false` solo en esta pestaña.
 */
export async function startGithubLogin(input: { server: string; remember: boolean; label?: string }, env: LoginEnv = {}): Promise<string> {
  const server = normalizeBaseUrl(input.server);
  const area = sessionArea(env);
  if (!area) throw new ProjectError('unavailable', 'El navegador no deja guardar datos de esta pestaña (¿datos del sitio bloqueados?): sin ellos no se puede terminar el inicio de sesión al volver de GitHub.', { reason: 'login-no-storage' });
  const { verifier, challenge } = await createPkcePair(env);
  const here = new URL((env.location ?? window.location).href);
  here.hash = '';
  const label = input.label?.trim();
  const pending: Pending = { url: server, verifier, remember: input.remember, startedAt: (env.now ?? Date.now)(), ...(label ? { label } : {}) };
  try {
    area.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    throw new ProjectError('unavailable', 'El navegador no deja guardar datos de esta pestaña (¿datos del sitio bloqueados?): sin ellos no se puede terminar el inicio de sesión al volver de GitHub.', { reason: 'login-no-storage' });
  }
  const target = `${server}/api/auth/github/login?${new URLSearchParams({ redirect: here.toString(), challenge })}`;
  (env.navigate ?? ((url: string) => window.location.assign(url)))(target);
  return target;
}

// ───────────── 2. volver de GitHub ─────────────

export type LoginOutcome =
  | { status: 'none' }
  | { status: 'ok'; url: string; user: PublicUser; expiresAt: string; remember: boolean; message: string }
  | { status: 'error'; reason: string; message: string; url?: string };

/** Quita `iark_code` e `iark_error` del fragmento de la dirección (y solo eso) sin recargar ni añadir una entrada al historial. */
function scrubFragment(env: LoginEnv, fragment: URLSearchParams): void {
  fragment.delete('iark_code');
  fragment.delete('iark_error');
  const href = new URL((env.location ?? window.location).href);
  const rest = fragment.toString();
  const clean = `${href.pathname}${href.search}${rest ? `#${rest}` : ''}`;
  try {
    (env.history ?? window.history).replaceState((env.history ?? window.history).state, '', clean);
  } catch {
    /* sin historial (un iframe de un sitio ajeno, una prueba): el código ya no se usará dos veces, el servidor lo gasta */
  }
}

const failed = (reason: string, message: string, url?: string): LoginOutcome => {
  setLoginNotice({ kind: 'error', message, reason, ...(url ? { url } : {}) });
  return { status: 'error', reason, message, ...(url ? { url } : {}) };
};

/**
 * Termina el inicio de sesión si la página acaba de volver de GitHub (`#iark_code=…` o `#iark_error=…`); si no, no hace nada.
 * Debe correr antes de crear la sesión de proyectos: deja la sesión guardada y el servidor activo, y la sesión de proyectos que se cree
 * después ya arranca con ellos. Nunca lanza: lo que falle queda como `error` y como aviso (`getLoginNotice`).
 */
export async function completeGithubLogin(env: LoginEnv = {}): Promise<LoginOutcome> {
  const area = sessionArea(env);
  const now = (env.now ?? Date.now)();
  let hash: string;
  try {
    hash = new URL((env.location ?? window.location).href).hash;
  } catch {
    return { status: 'none' };
  }
  const fragment = new URLSearchParams(hash.replace(/^#/, ''));
  const code = fragment.get('iark_code');
  const reason = fragment.get('iark_error');
  const pending = readPending(area);
  if (code === null && reason === null) {
    // Un inicio de sesión que se quedó a medias (la persona no volvió) no debe dejar el `verifier` en la pestaña.
    if (pending && now - pending.startedAt > PENDING_MAX_AGE_MS) dropPending(area);
    return { status: 'none' };
  }
  // Primero se borra todo rastro: ni el código en la dirección ni el `verifier` guardado valen una segunda vez, salga bien o mal lo demás.
  scrubFragment(env, fragment);
  dropPending(area);

  if (reason !== null) return failed(Object.hasOwn(SERVER_REASONS, reason) ? reason : 'login_failed', loginErrorMessage(reason), pending?.url);
  if (!pending || !code) {
    return failed('stale', t('login.stale'));
  }
  if (now - pending.startedAt > PENDING_MAX_AGE_MS || pending.startedAt > now + 60_000) {
    return failed('expired', t('login.expired'), pending.url);
  }
  let server: string;
  try {
    server = normalizeBaseUrl(pending.url);
  } catch {
    return failed('stale', t('login.badAddress'));
  }

  // El código solo se entrega al servidor que se eligió al empezar (el de `pending`), nunca a una dirección que venga en la URL.
  const store = new HttpProjectStore({ baseUrl: server, fetch: env.fetch });
  let grant;
  try {
    grant = await store.exchangeLoginCode({ code, verifier: pending.verifier });
  } catch (error) {
    if (error instanceof ProjectError) {
      if (error.info.status === 429) return failed('rate_limited', t('login.rateLimited'), server);
      if (error.info.network) return failed('unreachable', t('login.unreachable', { host: hostOf(server), detail: projectErrorText(error) }), server);
      if (error.code === 'invalid') return failed('invalid_grant', t('login.invalidGrant'), server);
      return failed('server', t('login.serverFailed', { detail: projectErrorText(error) }), server);
    }
    return failed('server', t('login.unexpected'), server);
  }

  const areas = env.areas ?? browserAreas();
  const known = loadBackend(areas);
  const current = known.kind === 'remote' ? known : known.server;
  const label = pending.label ?? (current?.url === server ? current.label : undefined); // el nombre que se le puso a ese servidor se conserva
  const saved = saveBackend({ url: server, token: grant.token, ...(label ? { label } : {}) }, { remember: pending.remember, active: true }, areas);
  if (!saved.saved) {
    // Sin dónde guardarla la sesión no serviría de nada: se cierra en el servidor para no dejarla abierta sin dueña.
    store.setToken(grant.token);
    await store.logout().catch(() => undefined);
    return failed('storage', saved.problem ? t('login.noStorage', { problem: saved.problem }) : t('login.noStorageBare'), server);
  }
  const who = grant.user.name ?? grant.user.login;
  const message = t('login.ok', { who, login: grant.user.login, host: hostOf(server) });
  setLoginNotice({ kind: 'ok', message });
  return { status: 'ok', url: server, user: grant.user, expiresAt: grant.expiresAt, remember: pending.remember, message };
}

// ───────────── instancia gestionada de la que viene esta página ─────────────

/** Una dirección de servidor que ofrece iniciar sesión con GitHub y lo que ofrece. */
export interface ManagedServer {
  url: string;
  providers: AuthProviders;
}

/**
 * Si esta página la sirve una instancia gestionada (la carpeta de la página tiene `api/auth/providers` y responde con GitHub), su dirección.
 * En el sitio de GitHub Pages o en un servidor de desarrollo esa ruta no existe (404, o una página que no es JSON) y no hay nada que proponer.
 * Nunca lanza.
 */
export async function detectManagedServer(env: Pick<LoginEnv, 'fetch' | 'location'> & { timeoutMs?: number } = {}): Promise<ManagedServer | undefined> {
  try {
    const folder = new URL('./', (env.location ?? window.location).href);
    if (folder.protocol !== 'http:' && folder.protocol !== 'https:') return undefined; // file://, about:blank…
    const url = normalizeBaseUrl(folder.href);
    const providers = await new HttpProjectStore({ baseUrl: url, fetch: env.fetch, timeoutMs: env.timeoutMs ?? 4000 }).providers();
    return providers.providers.some((p) => p.id === 'github') ? { url, providers } : undefined;
  } catch {
    return undefined;
  }
}
