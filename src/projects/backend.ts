import { normalizeBaseUrl } from '@iark/kernel';
import { t } from '../i18n';

/**
 * Dónde guardan sus proyectos las pantallas de la app web: en este navegador (IndexedDB) o en un servidor propio
 * (`iark serve --workspace`). La elección vale para todo el sitio (banco de trabajo y editor C4) y vive en el navegador:
 *
 * - La dirección y el nombre del servidor, en `localStorage` (`iark.projects.backend`): no son secretos.
 * - El **token** (la única credencial) en `sessionStorage` (solo esta pestaña, hasta cerrarla) y solo en `localStorage` si la
 *   persona pide «Recordar en este equipo». Cada token se guarda junto a la dirección del servidor a la que pertenece y solo
 *   se lee para esa dirección: nunca viaja a otro servidor.
 *
 * Todo acceso a un almacén va en try/catch: en una ventana privada o con los datos del sitio bloqueados lanza, y la app debe
 * seguir funcionando (con los proyectos en este navegador y sin recordar nada).
 */

export interface RemoteServer {
  /** Dirección del servicio, ya normalizada (`https://iark.ejemplo.org`). */
  url: string;
  /** Token de acceso; sin él solo sirve un servidor abierto. */
  token?: string;
  /** Nombre con el que la persona reconoce el servidor (opcional). */
  label?: string;
  /** Solo al leer: el token está en `localStorage` («Recordar en este equipo»), no solo en esta pestaña. */
  remembered?: boolean;
}

/**
 * `local`: proyectos en este navegador. `remote`: en un servidor. Con `local` puede venir `server`: el último servidor usado
 * (sin estar activo), que se conserva para volver a conectar y para copiar proyectos hacia él.
 */
export type BackendConfig = { kind: 'local'; server?: RemoteServer } | ({ kind: 'remote' } & RemoteServer);

export const BACKEND_KEY = 'iark.projects.backend';
export const TOKEN_KEY_PREFIX = 'iark.projects.token:';
/** El puntero «último abierto» del almacén local conserva su clave de siempre; cada servidor tiene la suya. */
export const LAST_KEY = 'iark.projects.last';

export interface StorageAreas {
  local?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  session?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}

/** Los almacenes del navegador que estén disponibles (acceder a la propiedad ya puede lanzar). */
export function browserAreas(): StorageAreas {
  const areas: StorageAreas = {};
  try {
    areas.local = window.localStorage;
  } catch {
    /* bloqueado */
  }
  try {
    areas.session = window.sessionStorage;
  } catch {
    /* bloqueado */
  }
  return areas;
}

const read = (area: StorageAreas['local'], key: string): string | null => {
  try {
    return area?.getItem(key) ?? null;
  } catch {
    return null;
  }
};
const write = (area: StorageAreas['local'], key: string, value: string): boolean => {
  if (!area) return false;
  try {
    area.setItem(key, value);
    return true;
  } catch {
    return false;
  }
};
const remove = (area: StorageAreas['local'], key: string): void => {
  try {
    area?.removeItem(key);
  } catch {
    /* nada que quitar */
  }
};

const tokenKey = (url: string): string => `${TOKEN_KEY_PREFIX}${url}`;

/** Un host sin esquema ni camino, para mostrarlo (`localhost:8787`). */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** El token de ese servidor (la pestaña manda sobre lo recordado) y dónde estaba. */
function readToken(url: string, areas: StorageAreas): { token: string; remembered: boolean } | undefined {
  const fromSession = read(areas.session, tokenKey(url));
  if (fromSession) return { token: fromSession, remembered: false };
  const fromLocal = read(areas.local, tokenKey(url));
  return fromLocal ? { token: fromLocal, remembered: true } : undefined;
}

function serverFrom(raw: unknown, areas: StorageAreas): RemoteServer | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { url, label } = raw as { url?: unknown; label?: unknown };
  if (typeof url !== 'string') return undefined;
  let normalized: string;
  try {
    normalized = normalizeBaseUrl(url);
  } catch {
    return undefined;
  }
  const found = readToken(normalized, areas);
  return { url: normalized, ...(typeof label === 'string' && label.trim() ? { label: label.trim() } : {}), ...(found ? { token: found.token, remembered: found.remembered } : {}) };
}

/** La configuración guardada; sin ella (o si no se puede leer o está dañada), los proyectos van en este navegador. */
export function loadBackend(areas: StorageAreas = browserAreas()): BackendConfig {
  const raw = read(areas.local, BACKEND_KEY);
  if (!raw) return { kind: 'local' };
  let parsed: { kind?: unknown } | null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'local' };
  }
  const server = serverFrom(parsed, areas);
  if (parsed?.kind === 'remote' && server) return { kind: 'remote', ...server };
  return server ? { kind: 'local', server } : { kind: 'local' };
}

export interface SaveBackendResult {
  saved: boolean;
  /** Dónde quedó el token (`none` si no había o no se pudo guardar). */
  tokenIn: 'session' | 'local' | 'none';
  /** Por qué no se guardó, en lenguaje claro. */
  problem?: string;
}

/**
 * Guarda el servidor y lo deja activo (`active: false` solo lo recuerda, sin cambiar de almacén). `token` en `undefined`
 * conserva el que ya hubiera para esa dirección; con `remember` el token va a `localStorage` y, si no, solo a `sessionStorage`.
 */
export function saveBackend(server: { url: string; token?: string; label?: string }, options: { remember?: boolean; active?: boolean } = {}, areas: StorageAreas = browserAreas()): SaveBackendResult {
  const url = normalizeBaseUrl(server.url);
  const remember = options.remember === true;
  const token = (server.token ?? readToken(url, areas)?.token ?? '').trim();
  let tokenIn: SaveBackendResult['tokenIn'] = 'none';
  if (token) {
    const target = remember ? areas.local : areas.session;
    if (!write(target, tokenKey(url), token)) {
      return { saved: false, tokenIn: 'none', problem: remember ? t('backend.noTokenDevice') : t('backend.noTokenTab') };
    }
    remove(remember ? areas.session : areas.local, tokenKey(url));
    tokenIn = remember ? 'local' : 'session';
  } else {
    remove(areas.session, tokenKey(url));
    remove(areas.local, tokenKey(url));
  }
  const label = server.label?.trim();
  const config = { kind: options.active === false ? 'local' : 'remote', url, ...(label ? { label } : {}) };
  if (!write(areas.local, BACKEND_KEY, JSON.stringify(config))) {
    return { saved: false, tokenIn: 'none', problem: t('backend.noConfig') };
  }
  return { saved: true, tokenIn };
}

/** Vuelve a guardar los proyectos en este navegador. Conserva el servidor (y su token) para volver a conectar o copiar hacia él. */
export function chooseLocalBackend(areas: StorageAreas = browserAreas()): boolean {
  const current = loadBackend(areas);
  const server = current.kind === 'remote' ? current : current.server;
  if (!server) {
    remove(areas.local, BACKEND_KEY);
    return true;
  }
  return write(areas.local, BACKEND_KEY, JSON.stringify({ kind: 'local', url: server.url, ...(server.label ? { label: server.label } : {}) }));
}

/** Olvida el servidor: su dirección y su token, de esta pestaña y de este equipo. */
export function forgetBackend(areas: StorageAreas = browserAreas()): void {
  const current = loadBackend(areas);
  const server = current.kind === 'remote' ? current : current.server;
  if (server) {
    remove(areas.session, tokenKey(server.url));
    remove(areas.local, tokenKey(server.url));
  }
  remove(areas.local, BACKEND_KEY);
}

/** Clave del puntero «último abierto» de ese almacén: los ids de un servidor y los del navegador no se parecen, así que no se mezclan. */
export function pointerKey(config: BackendConfig): string {
  return config.kind === 'remote' ? `${LAST_KEY}:${config.url}` : LAST_KEY;
}
