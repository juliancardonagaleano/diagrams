import { ELEMENT_LABELS, indexElements, statusOf, type PlatformDocument, type Resource } from './types';

/**
 * Equivalencias declaradas entre recursos de entornos distintos (`Resource.counterpartOf`). Basta que lo declare uno de los dos y la
 * equivalencia es simétrica y transitiva: si staging dice que su base es la de desarrollo y producción dice que la suya es la de
 * staging, las tres son el mismo recurso en tres entornos. Es lo que la comparación de entornos usa antes de deducir nada por
 * nombre, tecnología o clase (`pairResources`), y lo que promover un servicio usa para re-apuntar sus dependencias.
 *
 * Solo cuentan los enlaces bien formados (a un recurso que existe y es de otro entorno); los demás los denuncia `counterpartErrors`.
 */
export interface Counterparts {
  /** Cada equivalencia (dos o más recursos), con sus recursos en el orden del documento. */
  groups: Resource[][];
  /** Los demás recursos de la equivalencia de `resource`; vacío si ni él declara ni nadie declara el suyo. */
  mates: (resource: Resource) => Resource[];
  /** El recurso de `environmentId` que es equivalente de `resource` (uno no dado de baja, si hay varios), si lo hay. */
  in: (resource: Resource, environmentId: string) => Resource | undefined;
  /** ¿Son el mismo recurso en dos entornos, por declaración? */
  same: (a: Resource, b: Resource) => boolean;
}

export function counterpartsOf(doc: PlatformDocument): Counterparts {
  const byId = new Map(doc.resources.map((r) => [r.id, r]));
  const order = new Map(doc.resources.map((r, i) => [r.id, i]));
  const classes = new Map<string, Resource[]>();
  for (const r of doc.resources) {
    const target = r.counterpartOf === undefined ? undefined : byId.get(r.counterpartOf);
    if (!target || target.id === r.id || target.environmentId === r.environmentId) continue;
    const [mine, theirs] = [classes.get(r.id) ?? [r], classes.get(target.id) ?? [target]];
    if (mine === theirs) continue;
    const merged = [...mine, ...theirs].sort((x, y) => order.get(x.id)! - order.get(y.id)!);
    for (const m of merged) classes.set(m.id, merged);
  }
  const mates = (resource: Resource): Resource[] => (classes.get(resource.id) ?? []).filter((m) => m.id !== resource.id);
  return {
    groups: [...new Set(classes.values())],
    mates,
    in: (resource, environmentId) => {
      const here = mates(resource).filter((m) => m.environmentId === environmentId);
      return here.find((m) => statusOf(m) !== 'decommissioned') ?? here[0];
    },
    same: (a, b) => mates(a).some((m) => m.id === b.id),
  };
}

export interface CounterpartError {
  /** El recurso al que se le achaca (el que lo declara, o uno de los que chocan). */
  resourceId: string;
  message: string;
}

/**
 * Lo que impide leer `counterpartOf` sin dudar: un equivalente que no existe, que no es un recurso, que es el propio recurso o
 * que está en su mismo entorno (el equivalente lo es *en otro entorno*), y una equivalencia con dos recursos vivos (no dados de
 * baja) en un mismo entorno, que haría ambiguo con cuál se empareja el de otro entorno. La validación del documento lo rechaza.
 */
export function counterpartErrors(doc: PlatformDocument): CounterpartError[] {
  const errors: CounterpartError[] = [];
  const elements = indexElements(doc);
  const resources = new Map(doc.resources.map((r) => [r.id, r]));
  const environmentName = (id: string): string => doc.environments.find((e) => e.id === id)?.name ?? id;
  for (const r of doc.resources) {
    if (r.counterpartOf === undefined) continue;
    const target = resources.get(r.counterpartOf);
    if (r.counterpartOf === r.id) errors.push({ resourceId: r.id, message: `"${r.id}" no puede ser su propio equivalente (counterpartOf)` });
    else if (!target) {
      const other = elements.get(r.counterpartOf);
      errors.push({
        resourceId: r.id,
        message: other ? `El equivalente de "${r.id}" debe ser un recurso, pero "${other.id}" es ${ELEMENT_LABELS[other.kind].toLowerCase()}` : `"${r.id}" referencia un recurso equivalente inexistente: "${r.counterpartOf}"`,
      });
    } else if (target.environmentId === r.environmentId) {
      errors.push({ resourceId: r.id, message: `El recurso "${r.id}" y su equivalente "${target.id}" están en el mismo entorno ("${r.environmentId}"): el equivalente es el recurso de otro entorno` });
    }
  }
  for (const group of counterpartsOf(doc).groups) {
    const live = group.filter((m) => statusOf(m) !== 'decommissioned');
    for (const environmentId of new Set(live.map((m) => m.environmentId))) {
      const crowded = live.filter((m) => m.environmentId === environmentId);
      if (crowded.length < 2) continue;
      // Entre los que chocan siempre hay uno que lo declara (una equivalencia es un árbol de enlaces con un solo extremo sin declarar).
      const declaring = crowded.filter((m) => m.counterpartOf !== undefined);
      const mate = group.find((m) => m.environmentId !== environmentId);
      errors.push({
        resourceId: (declaring[declaring.length - 1] ?? crowded[crowded.length - 1]).id,
        message: `Equivalencia ambigua: ${crowded.map((m) => `"${m.id}"`).join(' y ')} son del entorno "${environmentName(environmentId)}" y resultan equivalentes ${mate ? `de "${mate.id}" ` : ''}(counterpartOf, directa o por transitividad): en cada entorno solo puede haber un recurso por equivalencia`,
      });
    }
  }
  return errors;
}

/** El recurso que queda al seguir la cadena de `counterpartOf` que empieza en `id` a través de los que se quitan. */
function survivor(id: string | undefined, byId: ReadonlyMap<string, Resource>, gone: ReadonlySet<string>): Resource | undefined {
  const seen = new Set<string>();
  while (id !== undefined && gone.has(id) && !seen.has(id)) {
    seen.add(id);
    id = byId.get(id)?.counterpartOf;
  }
  return id === undefined || gone.has(id) ? undefined : byId.get(id);
}

/**
 * Los recursos que quedan al quitar `gone`. Los que declaraban como equivalente uno de los que se van pasan a declarar el que él
 * tuviera (si queda y es de otro entorno que ellos), para no cortar la cadena dev → staging → prod por el medio; si no, lo pierden.
 */
export function dropCounterparts(resources: Resource[], gone: ReadonlySet<string>): Resource[] {
  const byId = new Map(resources.map((r) => [r.id, r]));
  return resources
    .filter((r) => !gone.has(r.id))
    .map((r) => {
      if (r.counterpartOf === undefined || !gone.has(r.counterpartOf)) return r;
      const target = survivor(r.counterpartOf, byId, gone);
      const { counterpartOf: _dropped, ...rest } = r;
      return target && target.id !== r.id && target.environmentId !== r.environmentId ? { ...rest, counterpartOf: target.id } : rest;
    });
}
