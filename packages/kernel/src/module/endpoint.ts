/**
 * Endpoints de un manifiesto de federación: cómo se resuelven y cuáles se aceptan.
 *
 * Un manifiesto lo publica una instancia que puede no ser la nuestra, y sus `endpoints` acaban como `iframe.src` (o como
 * URL de una petición) en el origen de quien lo consume. Un `javascript:` o un `data:` ahí ejecutaría código del manifiesto
 * con acceso al `sessionStorage`/`localStorage` de la instancia (el token de sesión, con «Recordar»). Por eso todo endpoint
 * se resuelve contra la URL del manifiesto y **solo se acepta si queda en `http:` o `https:`**.
 *
 * Este archivo no importa `zod` ni nada pesado a propósito (solo `contract.ts` y `protocol.ts`, que son lógica pura sin dependencias):
 * lo comparten el shell, el SDK de anfitrión (`createIarkModuleEmbed`, `createIarkEmbed`) y el Web Component `<iark-module>`,
 * cuyos bundles no deben crecer por esto.
 */
import { CONTRACT_VERSION, isContractCompatible } from './contract';
import { EMBED_PROTOCOL_VERSION, negotiateProtocol } from './protocol';

/** Id del esquema del manifiesto de federación (`manifestSchema` lo exige tal cual). */
export const MANIFEST_SCHEMA_ID = 'iark.manifest/1';

/** Versión del esquema del manifiesto que esta suite entiende: el número de `MANIFEST_SCHEMA_ID`. */
export const MANIFEST_SCHEMA_VERSION = 1;

/** El número de un id de esquema de manifiesto `iark.manifest/<n>`; `undefined` si no tiene esa forma. */
export function manifestSchemaVersion(id: unknown): number | undefined {
  const match = typeof id === 'string' ? /^iark\.manifest\/(\d+)$/.exec(id) : null;
  return match ? Number(match[1]) : undefined;
}

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
 * Por qué no se puede usar un manifiesto (sin validarlo con `zod`), o `undefined` si se puede: su esquema es de una versión
 * MAYOR que la que esta suite entiende (`iark.manifest/2`), o su `protocol` (versión del protocolo `postMessage` de la
 * instancia; si lo omite, 1.0) tiene una versión mayor distinta de `EMBED_PROTOCOL_VERSION`. `source` dice de dónde viene
 * (la URL del manifiesto), para el mensaje. Una diferencia de menor no es un problema: lo desconocido se ignora.
 */
export function manifestCompatibilityProblem(manifest: unknown, source: string): string | undefined {
  if (!manifest || typeof manifest !== 'object') return undefined;
  const json = manifest as { schema?: unknown; protocol?: unknown };
  const version = manifestSchemaVersion(json.schema);
  if (version !== undefined && version > MANIFEST_SCHEMA_VERSION) {
    return `El manifiesto en ${source} es de una versión más nueva del formato (${String(json.schema)}); esta suite entiende ${MANIFEST_SCHEMA_ID}. Actualiza DIAgrams para usar esa instancia.`;
  }
  const remote = json.protocol === undefined || typeof json.protocol === 'string' ? (json.protocol as string | undefined) : JSON.stringify(json.protocol);
  const protocol = negotiateProtocol(EMBED_PROTOCOL_VERSION, remote);
  if (protocol.ok) return undefined;
  if (protocol.reason === 'invalid') return `El manifiesto en ${source} declara un protocolo embebido ilegible (${shorten(protocol.remote)}); esta suite habla la versión ${protocol.local}.`;
  const newer = Number.parseInt(protocol.remote, 10) > Number.parseInt(protocol.local, 10);
  return `La instancia en ${source} habla el protocolo embebido ${protocol.remote} y esta suite el ${protocol.local}: la versión mayor es distinta y no pueden entenderse. Actualiza ${newer ? 'esta suite (DIAgrams)' : 'la instancia'}.`;
}

/**
 * Por qué no se puede usar un módulo de un manifiesto, o `undefined` si se puede: exige un `contractVersion` del contrato
 * `DomainModule` mayor que el `CONTRACT_VERSION` de esta suite (o inválido). Omitido vale 1, como en los manifiestos antiguos.
 */
export function moduleCompatibilityProblem(module: { id: string; contractVersion?: unknown }): string | undefined {
  const declared = module.contractVersion;
  if (declared === undefined) return undefined;
  if (typeof declared !== 'number' || !Number.isInteger(declared) || declared < 1) return `El módulo «${module.id}» declara un contractVersion inválido (${shorten(JSON.stringify(declared) ?? String(declared))}).`;
  if (isContractCompatible(declared)) return undefined;
  return `El módulo «${module.id}» exige la versión ${declared} del contrato de módulos y esta suite entiende hasta la ${CONTRACT_VERSION}: actualiza DIAgrams para usarlo.`;
}

/**
 * URL del editor embebible de un módulo según un manifiesto ya descargado, sin validarlo con `zod` (lo hace el Web
 * Component, que no debe arrastrarlo): comprueba lo imprescindible, busca el módulo y resuelve su `endpoints.embed`
 * contra `manifestUrl` con `resolveEndpointUrl`. Los errores explican qué falta o qué no ofrece la instancia.
 */
export function embedUrlFromManifest(manifest: unknown, manifestUrl: string, moduleId: string): string {
  const json = manifest as { schema?: unknown; modules?: Array<{ id: string; contractVersion?: unknown; endpoints?: { embed?: string } }> } | null | undefined;
  // Un manifiesto de una versión del formato (o del protocolo) que no entendemos se explica antes que «no es un manifiesto».
  const incompatible = manifestCompatibilityProblem(json, manifestUrl);
  if (incompatible) throw new EndpointUrlError(incompatible);
  if (!json || typeof json !== 'object' || json.schema !== MANIFEST_SCHEMA_ID || !Array.isArray(json.modules)) {
    throw new EndpointUrlError(`${manifestUrl} no es un manifiesto ${MANIFEST_SCHEMA_ID}.`);
  }
  const entry = json.modules.find((m) => m && m.id === moduleId);
  if (!entry) throw new EndpointUrlError(`La instancia no ofrece el módulo «${moduleId}». Módulos: ${json.modules.map((m) => m?.id).join(', ')}.`);
  const unusable = moduleCompatibilityProblem(entry);
  if (unusable) throw new EndpointUrlError(unusable);
  if (typeof entry.endpoints?.embed !== 'string' || !entry.endpoints.embed) throw new EndpointUrlError(`La instancia no publica un editor embebible para «${moduleId}».`);
  return resolveEndpointUrl(entry.endpoints.embed, manifestUrl, `El endpoint «embed» del módulo «${moduleId}»`);
}
