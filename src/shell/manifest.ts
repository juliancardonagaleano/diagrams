import { EndpointUrlError, manifestCompatibilityProblem, manifestSchema, moduleCompatibilityProblem, resolveEndpointUrl, type ModuleManifest } from '@iark/kernel';

/** Un módulo del manifiesto con sus endpoints ya resueltos a URL absolutas. */
export interface ResolvedModule extends ModuleManifest {
  embedUrl?: string;
  schemaUrl?: string;
  apiUrl?: string;
}

/** Un módulo del manifiesto que esta suite no puede usar, y por qué (p. ej. exige un `contractVersion` mayor que el que entiende). */
export interface RejectedModule {
  id: string;
  name: string;
  reason: string;
}

export interface ResolvedManifest {
  manifestUrl: string;
  name: string;
  version: string;
  /** Versión del protocolo `postMessage` de la instancia; «1.0» si el manifiesto no la publica (instancias anteriores). */
  protocol: string;
  /** Los módulos que esta suite puede usar. */
  modules: ResolvedModule[];
  /** Los que no: la instancia los ofrece, pero exigen un contrato de módulo más nuevo que el de esta suite. */
  rejected: RejectedModule[];
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

/**
 * Origen de la instancia a la que apunta `typed` (una URL absoluta o relativa a la página), o `undefined` si no es una URL.
 * El shell lo compara con el de la página para decidir si un manifiesto recibido por `?manifest=` se conecta solo.
 */
export function manifestOrigin(typed: string, pageUrl: string): string | undefined {
  try {
    return new URL(typed, pageUrl).origin;
  } catch {
    return undefined;
  }
}

/**
 * Descubre los módulos que ofrece una instancia de la suite (esta u otra, incluso de otro origen) a partir de su
 * manifiesto `iark.manifest/1`. No necesita conocer el interior de ningún módulo: solo el manifiesto y los endpoints.
 * Los endpoints son relativos al manifiesto y, ya resueltos, solo se aceptan si son `http:` o `https:`: un manifiesto ajeno con
 * `javascript:` o `data:` en un endpoint acabaría como `iframe.src` en el origen de la instancia (acceso a su `sessionStorage`).
 * Basta un endpoint así para rechazar el manifiesto entero: no es un fallo de un módulo, es un manifiesto hostil o roto.
 *
 * Versiones: un manifiesto cuyo esquema es de una versión mayor (`iark.manifest/2`), o cuyo `protocol` tiene una versión mayor
 * distinta de la de esta suite, se rechaza entero con un mensaje claro (no se podría embeber ningún módulo). Un módulo que exige
 * un `contractVersion` mayor que el de esta suite se aparta en `rejected` y los demás siguen disponibles. Sin `protocol` ni
 * `contractVersion` (una instancia anterior) valen «1.0» y 1.
 */
export async function loadManifest(url: string, fetchImpl: typeof fetch = fetch): Promise<ResolvedManifest> {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { accept: 'application/json' } });
  } catch (error) {
    throw new ManifestError(`No se pudo leer el manifiesto en ${url}: ${(error as Error).message}. Si la instancia es de otro origen, debe permitir CORS.`);
  }
  if (!response.ok) throw new ManifestError(`El manifiesto en ${url} respondió ${response.status}.`);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ManifestError(`El manifiesto en ${url} no es JSON válido.`);
  }
  // Antes de validar con el esquema: uno de una versión mayor lo rechazaría con un «schema: Invalid input» poco útil.
  const incompatible = manifestCompatibilityProblem(json, url);
  if (incompatible) throw new ManifestError(incompatible);
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ManifestError(`El manifiesto en ${url} no es un iark.manifest/1 válido (${first.path.join('.') || 'raíz'}: ${first.message}).`);
  }
  const resolve = (module: string, field: 'embed' | 'schema' | 'api', endpoint: string | undefined): string | undefined => {
    if (!endpoint) return undefined;
    try {
      return resolveEndpointUrl(endpoint, url, `El endpoint «${field}» del módulo «${module}»`);
    } catch (error) {
      if (error instanceof EndpointUrlError) throw new ManifestError(`El manifiesto en ${url} no es de fiar: ${error.message}`);
      throw error;
    }
  };
  const rejected: RejectedModule[] = [];
  const modules: ResolvedModule[] = [];
  for (const m of parsed.data.modules) {
    // Los endpoints se resuelven (y se filtran) también en un módulo apartado: un manifiesto con un endpoint hostil se rechaza entero.
    const resolved = {
      ...m,
      embedUrl: resolve(m.id, 'embed', m.endpoints?.embed),
      schemaUrl: resolve(m.id, 'schema', m.endpoints?.schema),
      apiUrl: resolve(m.id, 'api', m.endpoints?.api),
    };
    const reason = moduleCompatibilityProblem(m);
    if (reason) rejected.push({ id: m.id, name: m.name, reason });
    else modules.push(resolved);
  }
  return { manifestUrl: url, name: parsed.data.name, version: parsed.data.version, protocol: parsed.data.protocol ?? '1.0', modules, rejected };
}
