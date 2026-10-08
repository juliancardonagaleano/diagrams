/**
 * Endpoints de un manifiesto de federación: cómo se resuelven y cuáles se aceptan.
 *
 * Un manifiesto lo publica una instancia que puede no ser la nuestra, y sus `endpoints` acaban como `iframe.src` (o como
 * URL de una petición) en el origen de quien lo consume. Un `javascript:` o un `data:` ahí ejecutaría código del manifiesto
 * con acceso al `sessionStorage`/`localStorage` de la instancia (el token de sesión, con «Recordar»). Por eso todo endpoint
 * se resuelve contra la URL del manifiesto y **solo se acepta si queda en `http:` o `https:`**.
 *
 * Este archivo no importa nada (ni siquiera `zod`) a propósito: lo comparten el shell, el SDK de anfitrión
 * (`createIarkModuleEmbed`, `createIarkEmbed`) y el Web Component `<iark-module>`, cuyos bundles no deben crecer por esto.
 */

/** Id del esquema del manifiesto de federación (`manifestSchema` lo exige tal cual). */
export const MANIFEST_SCHEMA_ID = 'iark.manifest/1';

/** Esquemas que puede tener un endpoint una vez resuelto. */
export const ENDPOINT_PROTOCOLS: readonly string[] = ['http:', 'https:'];

/** Un endpoint (o la URL de un editor embebido) que no es una URL `http:`/`https:` utilizable, o un manifiesto que no ofrece lo pedido. */
export class EndpointUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EndpointUrlError';
  }
}

/** Recorta un valor ajeno para ponerlo en un mensaje (un `data:` puede medir megas). */
function shorten(value: string, max = 60): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Resuelve `endpoint` (absoluto o relativo) contra `base` y devuelve la URL absoluta, o lanza `EndpointUrlError` si no es
 * una URL o su esquema no es `http:`/`https:` (`javascript:`, `data:`, `blob:`, `file:`, `vbscript:`…). Se comprueba el
 * esquema **ya resuelto** por el analizador de URL: así no sirven los trucos de mayúsculas, tabuladores o espacios
 * iniciales (`" JaVa\tScript:…"`). `label` dice de dónde viene, para el mensaje (p. ej. `El endpoint «embed» del módulo «data»`).
 */
export function resolveEndpointUrl(endpoint: string, base: string, label = 'El endpoint'): string {
  let url: URL;
  try {
    url = new URL(endpoint, base);
  } catch {
    throw new EndpointUrlError(`${label} «${shorten(endpoint)}» no es una URL válida.`);
  }
  if (!ENDPOINT_PROTOCOLS.includes(url.protocol)) {
    throw new EndpointUrlError(`${label} «${shorten(endpoint)}» usa el esquema «${url.protocol}»: solo se admiten URL http: y https:.`);
  }
  return url.toString();
}

/**
 * URL del editor embebible de un módulo según un manifiesto ya descargado, sin validarlo con `zod` (lo hace el Web
 * Component, que no debe arrastrarlo): comprueba lo imprescindible, busca el módulo y resuelve su `endpoints.embed`
 * contra `manifestUrl` con `resolveEndpointUrl`. Los errores explican qué falta o qué no ofrece la instancia.
 */
export function embedUrlFromManifest(manifest: unknown, manifestUrl: string, moduleId: string): string {
  const json = manifest as { schema?: unknown; modules?: Array<{ id: string; endpoints?: { embed?: string } }> } | null | undefined;
  if (!json || typeof json !== 'object' || json.schema !== MANIFEST_SCHEMA_ID || !Array.isArray(json.modules)) {
    throw new EndpointUrlError(`${manifestUrl} no es un manifiesto ${MANIFEST_SCHEMA_ID}.`);
  }
  const entry = json.modules.find((m) => m && m.id === moduleId);
  if (!entry) throw new EndpointUrlError(`La instancia no ofrece el módulo «${moduleId}». Módulos: ${json.modules.map((m) => m?.id).join(', ')}.`);
  if (typeof entry.endpoints?.embed !== 'string' || !entry.endpoints.embed) throw new EndpointUrlError(`La instancia no publica un editor embebible para «${moduleId}».`);
  return resolveEndpointUrl(entry.endpoints.embed, manifestUrl, `El endpoint «embed» del módulo «${moduleId}»`);
}
