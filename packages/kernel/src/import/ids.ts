/** Longitud máxima de un id del documento (la impone el esquema). */
export const MAX_ID_LENGTH = 120;

/**
 * Por cada conjunto de ids usados, el siguiente sufijo que se probó para cada base. Sin esto, diez mil elementos con el mismo
 * nombre («Process») recorrerían `base-2`, `base-3`… desde el principio cada vez (cuadrático). La caché no cambia el resultado:
 * un id solo se añade al conjunto, nunca se quita, así que lo que se saltó seguía ocupado. Con ids reservados (que pueden
 * variar de una llamada a otra) no se usa.
 */
const nextSuffix = new WeakMap<Set<string>, Map<string, number>>();

/**
 * Primer id libre a partir de `base` (`base`, `base-2`, `base-3`…), evitando también los `reserved`, y lo marca
 * como usado en `taken`. Compartido por los importadores para que los ids generados sean siempre únicos.
 */
export function pickId(base: string, taken: Set<string>, reserved: Set<string> = new Set()): string {
  const root = base.slice(0, MAX_ID_LENGTH - 6) || 'item';
  if (!taken.has(root) && !reserved.has(root)) {
    taken.add(root);
    return root;
  }
  const cached = reserved.size === 0;
  let counters = nextSuffix.get(taken);
  if (cached && !counters) nextSuffix.set(taken, (counters = new Map()));
  let i = (cached ? counters!.get(root) : undefined) ?? 2;
  let candidate = `${root}-${i}`;
  while (taken.has(candidate) || reserved.has(candidate)) {
    i += 1;
    candidate = `${root}-${i}`;
  }
  if (cached) counters!.set(root, i + 1);
  taken.add(candidate);
  return candidate;
}
