import type { IncomingMessage } from 'node:http';
import { isJson } from '../../cli/httpBody';
import { HttpError } from '../../cli/httpError';
import type { TokenRole } from '../../cli/tokens';

export const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** `localhost:8787` → `localhost`; `[::1]:8787` → `[::1]`. */
export function hostName(host: string | undefined): string {
  return /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec((host ?? '').trim().toLowerCase())?.[1] ?? '';
}

/** ¿La conexión llegó por una dirección de loopback del servidor? (`127.x`, `::1` o su forma IPv4-mapeada). */
export const isLoopbackAddress = (address: string | undefined): boolean => !!address && (address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.'));

/** ¿Puede este `Origin` usar la API de proyectos? Los de `--cors` por su texto exacto, y el propio sitio (mismo host y puerto que `Host`). */
export function projectOriginAllowed(origin: string, host: string | undefined, cors: string[]): boolean {
  if (cors.includes(origin)) return true;
  try {
    return !!host && new URL(origin).host.toLowerCase() === host.trim().toLowerCase();
  } catch {
    return false;
  }
}

/** Sin autenticación: `Host`, `Origin` y `Content-Type`. Con autenticación, solo `Content-Type`. */
export function guard(req: IncomingMessage, cors: string[], authenticated: boolean): void {
  if (!authenticated && isLoopbackAddress(req.socket.localAddress) && !LOOPBACK_HOSTS.has(hostName(req.headers.host))) {
    throw new HttpError(403, 'Host no permitido: este servicio solo atiende en localhost, 127.0.0.1 o [::1] (protección contra «DNS rebinding»).');
  }
  const origin = req.headers.origin;
  if (!authenticated && origin !== undefined && !projectOriginAllowed(origin, req.headers.host, cors)) {
    throw new HttpError(403, `Origen no autorizado «${origin.slice(0, 100)}»: para llamar a esta API desde otro sitio, arranque el servicio con --cors ${origin.slice(0, 100)}.`);
  }
  if (MUTATING.has(req.method ?? '') && !isJson(req)) {
    throw new HttpError(415, 'Las operaciones que modifican proyectos exigen Content-Type: application/json.');
  }
}

/**
 * El rol mínimo que exige una operación. `parts` son los segmentos de la ruta sin `projects`.
 */
export function requiredRole(method: string, parts: string[]): TokenRole {
  if (method === 'GET' || method === 'HEAD') return 'viewer';
  if (method === 'DELETE' && parts.length === 1) return 'admin';
  if (parts[1] === 'members') return 'admin';
  if (method === 'DELETE' && parts[1] === 'diagrams' && parts[3] === 'versions') return 'admin';
  return 'editor';
}
