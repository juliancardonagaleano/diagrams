/**
 * Origen del anfitrión de un editor embebido (el lado «iframe» del protocolo `postMessage`).
 *
 * Los eventos del editor llevan el documento entero, y las órdenes del anfitrión lo reemplazan o lo exportan: ni se emite a
 * cualquiera (`postMessage(…, '*')`) ni se obedece a cualquiera. El SDK de anfitrión (`createIarkEmbed`,
 * `createIarkModuleEmbed`) siempre añade `?origin=<su origen>` a la URL del iframe; quien incrusta el editor a mano puede
 * olvidarlo, y entonces solo sirve el origen que el navegador da de forma fiable. Si no hay ninguno, no se habla.
 */

/** Orígenes que declara el navegador para los ancestros del documento (`location.ancestorOrigins`); Firefox no lo implementa. */
type AncestorOrigins = ArrayLike<string> | null | undefined;

export interface HostOriginSources {
  /** Lo que dice `?origin=` en la URL del iframe (lo pone el SDK de anfitrión). */
  declared?: string | null;
  /** `location.ancestorOrigins`: el primero es el del padre inmediato y no depende de ninguna política de Referer. */
  ancestorOrigins?: AncestorOrigins;
  /** `document.referrer`: la URL del padre salvo que su política de Referer lo oculte (o que se haya navegado dentro del iframe). */
  referrer?: string | null;
}

/**
 * `valor` como origen (`https://host.example`), o `undefined` si no es uno utilizable como destino de `postMessage`: vacío,
 * `*`, un origen opaco (`null`: páginas `file:`, iframes `sandbox`) o un texto que no es una URL. Una URL completa se reduce a su origen.
 */
export function parseOrigin(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const { origin } = new URL(value);
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

/** El origen del anfitrión por orden de fiabilidad: el declarado, el de `ancestorOrigins[0]`, el de `document.referrer`; `undefined` si ninguno vale. */
export function resolveHostOrigin(sources: HostOriginSources): string | undefined {
  return parseOrigin(sources.declared) ?? parseOrigin(sources.ancestorOrigins?.[0]) ?? parseOrigin(sources.referrer);
}

/** Las fuentes del origen del anfitrión tal como están ahora en esta ventana (se leen en cada llamada: el navegador puede navegar el iframe). */
export function currentHostOriginSources(): HostOriginSources {
  return {
    declared: new URLSearchParams(window.location.search).get('origin'),
    ancestorOrigins: (window.location as Location & { ancestorOrigins?: AncestorOrigins }).ancestorOrigins,
    referrer: document.referrer,
  };
}
