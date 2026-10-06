import { HttpProjectStore, normalizeBaseUrl, ProjectError, type AuthProviders, type PublicUser } from '@iark/kernel';
import { hostOf } from './backend';

/**
 * «Probar la conexión» con un servidor de proyectos: dice quién eres y qué rol tienes, o por qué no se puede, en lenguaje claro.
 * Un navegador no distingue «el servidor está caído» de «el servidor rechazó el origen por CORS» (en ambos casos `fetch` falla
 * sin más): por eso, tras un fallo de red, se prueba una petición `no-cors` (opaca, pero que no exige permiso del servidor);
 * si esa llega, el servidor está y lo que falla es el permiso de origen.
 */

export type ConnectionProblem =
  | 'invalid-url'
  | 'mixed-content'
  | 'unreachable'
  | 'cors'
  | 'no-projects'
  | 'unauthorized'
  | 'forbidden'
  | 'rate-limited'
  | 'server';

export type ConnectionResult =
  | { ok: true; url: string; auth: boolean; name?: string; role?: string; /** Con una sesión de persona (inicio de sesión de GitHub): quién es. */ user?: PublicUser; projects: number }
  | {
      ok: false;
      problem: ConnectionProblem;
      /** Qué pasa y qué hacer, en una o dos frases. */
      message: string;
      /** Lo que respondió el servidor, si respondió. */
      detail?: string;
    };

export interface PageInfo {
  /** `https:` o `http:` de la página. */
  protocol: string;
  /** `https://usuario.github.io`: es lo que hay que dar a `--cors`. */
  origin: string;
}

export interface ConnectionOptions {
  fetch?: typeof fetch;
  page?: PageInfo;
  timeoutMs?: number;
}

export const currentPage = (): PageInfo => ({ protocol: window.location.protocol, origin: window.location.origin });

const isLoopback = (hostname: string): boolean => hostname === 'localhost' || hostname.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/.test(hostname) || hostname === '[::1]';

/** ¿El navegador bloquearía esa dirección por contenido mixto? (`https:` pidiendo `http:` que no sea la propia máquina). */
export function isMixedContent(url: string, page: PageInfo = currentPage()): boolean {
  try {
    const target = new URL(url);
    return page.protocol === 'https:' && target.protocol === 'http:' && !isLoopback(target.hostname);
  } catch {
    return false;
  }
}

/** Aviso para mostrar mientras se escribe la dirección (no es un error: todavía no se ha probado nada). */
export function mixedContentWarning(url: string, page: PageInfo = currentPage()): string | undefined {
  if (!isMixedContent(url, page)) return undefined;
  return 'Esta página se abrió por https y esa dirección es http: el navegador bloqueará las peticiones (contenido mixto). Pon el servidor detrás de un proxy con https, o abre IArk por http.';
}

/** La orden con la que arrancar el servidor para que acepte a esta página. */
export const corsHint = (origin: string): string => `iark serve --workspace <carpeta> --cors ${origin}`;

async function respondsWithoutCors(base: string, doFetch: typeof fetch, timeoutMs: number): Promise<boolean> {
  try {
    await doFetch(`${base}/api/whoami`, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

async function explain(error: unknown, base: string, options: Required<Pick<ConnectionOptions, 'timeoutMs'>> & ConnectionOptions, page: PageInfo): Promise<ConnectionResult> {
  if (!(error instanceof ProjectError)) return { ok: false, problem: 'server', message: 'Falló algo inesperado al hablar con el servidor.', detail: (error as Error)?.message };
  const host = hostOf(base);
  const status = error.info.status;
  if (error.code === 'invalid' && status === undefined) return { ok: false, problem: 'invalid-url', message: error.message };
  if (error.code === 'forbidden') return { ok: false, problem: 'forbidden', message: 'El servidor reconoce el token, pero no te da permiso para esto.', detail: error.message };
  if (error.code === 'unauthorized') return { ok: false, problem: 'unauthorized', message: 'El servidor no aceptó el token: falta o no es válido.', detail: error.message };
  if (error.info.network) {
    const crossOrigin = new URL(base).origin !== page.origin;
    if (crossOrigin && (await respondsWithoutCors(base, options.fetch ?? ((...args) => fetch(...args)), options.timeoutMs))) {
      return {
        ok: false,
        problem: 'cors',
        message: `El servidor responde, pero el navegador no deja leer su respuesta porque no autoriza a esta página (${page.origin}). Arráncalo con --cors ${page.origin}.`,
      };
    }
    return { ok: false, problem: 'unreachable', message: `No se llega a ${host}: comprueba que el servidor está en marcha, que la dirección y el puerto son los correctos y que hay conexión.`, detail: error.message };
  }
  if (status === 429) return { ok: false, problem: 'rate-limited', message: 'Demasiados intentos fallidos: espera un momento y vuelve a probar.', detail: error.message };
  if (status === 404) return { ok: false, problem: 'no-projects', message: 'Ese servidor no ofrece proyectos: arráncalo con --workspace <carpeta> (o comprueba que la dirección es la de IArk).', detail: error.message };
  return { ok: false, problem: 'server', message: 'El servidor respondió con un error.', detail: error.message };
}

/** Comprueba la dirección y el token: quién es el token (`whoami`) y que el servidor ofrece proyectos. Nunca lanza. */
export async function testConnection(input: { url: string; token?: string }, options: ConnectionOptions = {}): Promise<ConnectionResult> {
  const page = options.page ?? currentPage();
  const timeoutMs = options.timeoutMs ?? 10_000;
  let base: string;
  try {
    base = normalizeBaseUrl(input.url);
  } catch (error) {
    return { ok: false, problem: 'invalid-url', message: (error as Error).message };
  }
  if (isMixedContent(base, page)) {
    return { ok: false, problem: 'mixed-content', message: mixedContentWarning(base, page)! };
  }
  const client = new HttpProjectStore({ baseUrl: base, token: input.token, fetch: options.fetch, timeoutMs });
  try {
    const who = await client.whoami();
    const projects = await client.listProjects();
    return { ok: true, url: base, auth: who.auth, name: who.name, role: who.role, ...(who.user ? { user: who.user } : {}), projects: projects.length };
  } catch (error) {
    return explain(error, base, { ...options, timeoutMs }, page);
  }
}

/**
 * Qué formas de entrar ofrece un servidor (`GET /api/auth/providers`, pública), o `undefined` si no se pudo saber (sin red, no es IArk, o la
 * dirección es http desde una página https). Un servidor anterior a las cuentas no ofrece ninguna. Nunca lanza: es una pista para elegir qué
 * mostrar, y si falla se muestra lo de siempre (dirección y token).
 */
export async function loadProviders(url: string, options: ConnectionOptions = {}): Promise<AuthProviders | undefined> {
  const page = options.page ?? currentPage();
  let base: string;
  try {
    base = normalizeBaseUrl(url);
  } catch {
    return undefined;
  }
  if (isMixedContent(base, page)) return undefined;
  try {
    return await new HttpProjectStore({ baseUrl: base, fetch: options.fetch, timeoutMs: options.timeoutMs ?? 6000 }).providers();
  } catch {
    return undefined;
  }
}
