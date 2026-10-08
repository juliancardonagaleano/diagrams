import { EndpointUrlError, manifestSchema, resolveEndpointUrl, type ModuleManifest } from '@iark/kernel';

/** Un módulo del manifiesto con sus endpoints ya resueltos a URL absolutas. */
export interface ResolvedModule extends ModuleManifest {
  embedUrl?: string;
  schemaUrl?: string;
  apiUrl?: string;
}

export interface ResolvedManifest {
  manifestUrl: string;
  name: string;
  version: string;
  modules: ResolvedModule[];
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
  return {
    manifestUrl: url,
    name: parsed.data.name,
    version: parsed.data.version,
    modules: parsed.data.modules.map((m) => ({
      ...m,
      embedUrl: resolve(m.id, 'embed', m.endpoints?.embed),
      schemaUrl: resolve(m.id, 'schema', m.endpoints?.schema),
      apiUrl: resolve(m.id, 'api', m.endpoints?.api),
    })),
  };
}
