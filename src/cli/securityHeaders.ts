import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Cabeceras de seguridad de `iark serve`. La función central (`securityHeaders`) es pura: dado qué se responde (una página HTML u
 * otra cosa), si la carga es embebida y si la petición llegó por https, devuelve las cabeceras; `applySecurityHeaders` solo las
 * pone en la respuesta antes de que el resto del servicio escriba la suya (que gana si repite una, como la CSP del SVG exportado).
 *
 * Qué se envía y por qué:
 *  - Todas las respuestas: `X-Content-Type-Options: nosniff` (el servicio ya lo ponía) y, solo si la petición llegó por https,
 *    `Strict-Transport-Security`. Las respuestas de la API JSON no llevan más: no son documentos.
 *  - Las páginas HTML, además: `Referrer-Policy: no-referrer`, `Permissions-Policy` (cámara, micrófono, geolocalización… vacíos),
 *    una `Content-Security-Policy` y `X-Frame-Options` para navegadores antiguos.
 *
 * La CSP (`contentSecurityPolicy`) es conservadora pero deja funcionar la federación:
 *  - `script-src 'self'`: el HTML que genera Vite no trae scripts en línea; nada de `'unsafe-inline'` ni `'unsafe-eval'` ahí.
 *  - `style-src 'self' 'unsafe-inline'`: React y Semi UI ponen estilos en línea (atributos `style`); el riesgo es mucho menor que en scripts.
 *  - `img-src 'self' data: blob:`, `font-src 'self' data:`: lo que usa la app (vistas previas SVG como `blob:`/`data:`, rasterizado a PNG).
 *  - `connect-src` y `frame-src` admiten `https:` y `http://localhost:*` (y `127.0.0.1`), además del propio origen: la gracia de la
 *    suite es hablar con OTRAS instancias (manifiesto `/.well-known/iark.json`, API de proyectos, editores embebidos), y no se sabe
 *    cuáles hasta que alguien las conecta. Es el único hueco que se deja abierto a propósito; un despliegue cerrado puede acotarlo
 *    con un proxy que reescriba la cabecera. `http:` en abierto no se admite: solo el bucle local (contexto seguro) para desarrollar.
 *  - `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`: cierran los vectores clásicos de inyección que no necesitan scripts.
 *  - `frame-ancestors`: ver abajo.
 *
 * Quién puede incrustar la página (`frame-ancestors`): las páginas normales solo la propia instancia (`'self'`). Las cargas
 * embebidas (`?embed=1` en la consulta de una de las dos páginas que tienen modo embebido, el editor y el banco de módulos: lo que
 * añaden `createIarkEmbed`, `createIarkModuleEmbed` y `<iark-module>`) salen de `IARK_FRAME_ANCESTORS` / `--frame-ancestors`,
 * **por omisión `*`** porque el producto se vende como embebible desde cualquier aplicación. Quien no incruste desde fuera debería
 * fijarla a los orígenes que necesite. Una lista concreta lleva siempre además `'self'`: el banco de módulos incrusta el editor C4
 * y los ancestros se comprueban todos, no solo el padre inmediato. Añadir `?embed=1` a otra página (la suite, la trazabilidad…) no
 * abre su incrustación: sin ese límite cualquiera podría enmarcar cualquier página de la instancia con un enlace (clickjacking).
 */

/** `max-age` de HSTS: 180 días, sin `includeSubDomains` ni `preload` (decisiones difíciles de deshacer, para quien opera el dominio). */
export const HSTS = 'max-age=15552000';

/** Lo que se permite incrustar por omisión en las cargas embebidas. */
export const DEFAULT_FRAME_ANCESTORS: readonly string[] = ['*'];

/** Destinos de red que se admiten además del propio origen: cualquier https y el bucle local por http (desarrollo y federación local). */
const NETWORK_SOURCES = ["'self'", 'https:', 'http://localhost:*', 'http://127.0.0.1:*'];

const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()';

/**
 * Una fuente de `frame-ancestors` aceptable: `*`, `'self'`, `'none'`, un esquema (`https:`) o un origen/host con comodín opcional
 * (`https://app.example`, `https://*.example.com`, `http://localhost:5173`). Nada de espacios, `;` o `,`: el valor viene de una
 * variable de entorno y acaba dentro de una cabecera, así que no debe poder añadir directivas.
 */
const ANCESTOR_SOURCE = /^(?:\*|'self'|'none'|[a-z][a-z0-9+.-]*:|(?:[a-z][a-z0-9+.-]*:\/\/)?(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::(?:\d{1,5}|\*))?)$/i;

/**
 * La lista de `IARK_FRAME_ANCESTORS` / `--frame-ancestors`: orígenes separados por comas o espacios. Vacía = la de por omisión (`*`).
 * Lanza un `Error` con el elemento inválido.
 */
export function parseFrameAncestors(value: string | undefined): string[] {
  const items = (value ?? '').split(/[\s,]+/).filter(Boolean);
  if (items.length === 0) return [...DEFAULT_FRAME_ANCESTORS];
  for (const item of items) {
    if (!ANCESTOR_SOURCE.test(item)) throw new Error(`«${item}» no es un origen válido para frame-ancestors (use * o una lista de orígenes como https://app.example, separados por comas).`);
  }
  return items;
}

/** El valor de `frame-ancestors` de una carga embebida: `*` tal cual, y si no la lista concreta más `'self'`. */
function embedAncestors(ancestors: readonly string[]): string {
  if (ancestors.includes('*')) return '*';
  const list = ancestors.filter((a) => a !== "'self'" && a !== "'none'");
  // `'none'` solo (nadie puede incrustar la carga embebida, ni siquiera el banco: el propio origen sigue pudiendo).
  return ["'self'", ...list].join(' ');
}

export interface CspOptions {
  /** Es una carga embebida (`?embed=1`). */
  embed?: boolean;
  /** Orígenes autorizados a incrustar las cargas embebidas. Por omisión, cualquiera. */
  frameAncestors?: readonly string[];
}

/** La `Content-Security-Policy` de las páginas HTML (ver la explicación de cada directiva arriba). */
export function contentSecurityPolicy({ embed = false, frameAncestors = DEFAULT_FRAME_ANCESTORS }: CspOptions = {}): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${NETWORK_SOURCES.join(' ')}`,
    `frame-src ${NETWORK_SOURCES.join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${embed ? embedAncestors(frameAncestors) : "'self'"}`,
  ].join('; ');
}

export interface SecurityHeadersInput extends CspOptions {
  /** `document`: una página HTML. `resource`: cualquier otra respuesta (JSON de la API, scripts, estilos, imágenes…). */
  kind: 'document' | 'resource';
  /** La petición llegó por https (directamente o, con proxy de confianza, según `X-Forwarded-Proto`). */
  secure?: boolean;
}

/** Las cabeceras de seguridad que corresponden a una respuesta. Pura: sin leer la petición ni escribir la respuesta. */
export function securityHeaders({ kind, secure = false, ...csp }: SecurityHeadersInput): Record<string, string> {
  const headers: Record<string, string> = { 'X-Content-Type-Options': 'nosniff' };
  if (secure) headers['Strict-Transport-Security'] = HSTS;
  if (kind === 'resource') return headers;
  headers['Referrer-Policy'] = 'no-referrer';
  headers['Permissions-Policy'] = PERMISSIONS_POLICY;
  headers['Content-Security-Policy'] = contentSecurityPolicy(csp);
  // Para navegadores sin `frame-ancestors`: solo en las páginas normales (una carga embebida debe poder incrustarse).
  if (!csp.embed) headers['X-Frame-Options'] = 'SAMEORIGIN';
  return headers;
}

/** ¿Llegó la petición por https? Sin proxy de confianza solo cuenta una conexión TLS propia; con él, la última `X-Forwarded-Proto` (la que añadió ese proxy). */
export function isSecureRequest(req: IncomingMessage, trustProxy: boolean): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true;
  if (!trustProxy) return false;
  const forwarded = req.headers['x-forwarded-proto'];
  const last = (Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? '')).split(',').map((p) => p.trim().toLowerCase()).filter(Boolean).pop();
  return last === 'https';
}

/** Las únicas páginas con modo embebido: el editor C4 (`/`) y el banco de módulos. El resto de páginas no se incrustan desde fuera. */
const EMBEDDABLE_PAGES: readonly string[] = ['/', '/index.html', '/modulos.html'];

/** ¿Tiene esta ruta modo embebido (`?embed=1`)? */
export function isEmbeddablePage(pathname: string): boolean {
  return EMBEDDABLE_PAGES.includes(pathname);
}

/** ¿Es la ruta de una página HTML (`/`, `/algo/` o `*.html`)? El resto del sitio (assets, JSON, esquemas) y la API no son documentos. */
export function isDocumentPath(pathname: string): boolean {
  return pathname.endsWith('/') || pathname.toLowerCase().endsWith('.html');
}

export interface SecurityHeadersSettings {
  /** Hay un proxy de confianza delante (`--trust-proxy`): su `X-Forwarded-Proto` dice si la petición era https. */
  trustProxy?: boolean;
  /** Orígenes autorizados a incrustar las cargas embebidas (`--frame-ancestors`). Por omisión, `*`. */
  frameAncestors?: readonly string[];
}

/**
 * Pone en `res` las cabeceras de seguridad que corresponden a `req`. Se llama una vez por petición, antes de responder: lo que el
 * servicio escriba después con `writeHead` (p. ej. la CSP restrictiva del SVG exportado) prevalece sobre estas.
 */
export function applySecurityHeaders(req: IncomingMessage, res: ServerResponse, settings: SecurityHeadersSettings = {}): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const headers = securityHeaders({
    kind: isDocumentPath(url.pathname) && !url.pathname.startsWith('/api/') ? 'document' : 'resource',
    embed: url.searchParams.get('embed') === '1' && isEmbeddablePage(url.pathname),
    frameAncestors: settings.frameAncestors,
    secure: isSecureRequest(req, settings.trustProxy ?? false),
  });
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
}
