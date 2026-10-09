import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError } from '../httpError';
import { bearerToken, clientAddress, FailureLimiter } from '../serveAuth';
import { hostName, isLoopbackAddress, LOOPBACK_HOSTS } from '../serveProjects';
import type { Metrics } from './metrics';

/**
 * `GET /metrics`: las métricas en el formato de texto de Prometheus. **Desactivado por omisión** (sin `--metrics` la ruta no existe: 404).
 * Activado, no es público:
 *
 *  - Con `--metrics-token` (o `IARK_METRICS_TOKEN`, o el archivo de `IARK_METRICS_TOKEN_FILE`) exige `Authorization: Bearer <token>`: 401 sin
 *    él o con otro (la comparación es en tiempo constante) y, tras varios fallos seguidos desde una dirección, 429 con `Retry-After` (el mismo
 *    freno que protege los tokens de la API). El token es solo para esto: no abre nada más.
 *  - Sin token solo atiende a conexiones de loopback, y si el servicio escucha en loopback comprueba además la cabecera `Host` (contra el «DNS
 *    rebinding»: una página ajena no puede leerlas). El arranque (ver `options.ts`) no deja activar las métricas sin token fuera de loopback ni
 *    detrás de un proxy (`--trust-proxy`): un proxy en la misma máquina las publicaría con una conexión de loopback.
 *
 * No lleva cabeceras de CORS y las respuestas no se cachean. Lo que dice cada métrica está en `docs/observabilidad.md`.
 */

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export interface MetricsEndpointOptions {
  metrics: Metrics;
  /** El token Bearer; sin él, solo loopback. */
  token?: string;
  trustProxy?: boolean;
  /** Ajustes del freno de intentos fallidos (en las pruebas, uno rápido). */
  limiter?: FailureLimiter;
}

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

export type MetricsHandler = (req: IncomingMessage, res: ServerResponse, send: (res: ServerResponse, status: number, body: string, headers?: Record<string, string>) => void) => Promise<void>;

export function createMetricsEndpoint(options: MetricsEndpointOptions): MetricsHandler {
  const expected = options.token === undefined ? undefined : digest(options.token);
  const limiter = options.limiter ?? new FailureLimiter();
  const trustProxy = options.trustProxy ?? false;

  return async (req, res, send) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Este endpoint solo admite GET.', { allow: 'GET, HEAD' });
    if (expected) {
      const address = clientAddress(req, trustProxy);
      const wait = limiter.retryAfter(address);
      if (wait > 0) throw new HttpError(429, `Demasiados intentos fallidos desde esta dirección: espere ${wait} s antes de volver a intentarlo.`, { code: 'rate-limited' }, { 'Retry-After': String(wait) });
      const presented = bearerToken(req.headers.authorization);
      // Se compara siempre (aunque no haya token) para que el tiempo de respuesta no distinga los casos.
      const match = timingSafeEqual(digest(presented ?? ''), expected);
      if (!presented || !match) {
        if (req.headers.authorization !== undefined) limiter.fail(address);
        throw new HttpError(401, 'Hace falta el token de métricas: envíe la cabecera «Authorization: Bearer <token>».', { code: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer realm="iark-metrics"' });
      }
    } else {
      if (!isLoopbackAddress(req.socket.remoteAddress)) throw new HttpError(403, 'Las métricas sin token solo se sirven a conexiones locales: arranque con --metrics-token.', { code: 'forbidden' });
      if (isLoopbackAddress(req.socket.localAddress) && !LOOPBACK_HOSTS.has(hostName(req.headers.host))) {
        throw new HttpError(403, 'Host no permitido: este servicio solo atiende en localhost, 127.0.0.1 o [::1] (protección contra «DNS rebinding»).', { code: 'forbidden' });
      }
    }
    send(res, 200, req.method === 'HEAD' ? '' : await options.metrics.render(), { 'Content-Type': METRICS_CONTENT_TYPE });
  };
}
