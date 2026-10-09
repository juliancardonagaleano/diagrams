import type { DiffMark, FlowEdge, FlowNode } from './flow';

/** Marca de comparación de un elemento del documento actual (los quitados se dibujan aparte, como fantasmas). */
type Applied = Exclude<DiffMark, 'removed'>;

/**
 * Identidad estable de los nodos y aristas que se entregan a React Flow. `buildFlow` rehace todos los objetos en cada llamada (al
 * arrastrar un nodo, al cambiar la selección…); React Flow compara por identidad, así que un objeto nuevo por elemento obliga a
 * repintar todos los que están montados. Con cientos de nodos eso es lo que hace que el lienzo se arrastre: aquí se conserva el
 * objeto anterior de cada elemento mientras no haya cambiado nada que lo afecte, y solo los que sí cambian se entregan nuevos.
 */

const samePoint = (a: { x: number; y: number }, b: { x: number; y: number }): boolean => a.x === b.x && a.y === b.y;

function sameHandles(a: FlowNode['data']['handles'], b: FlowNode['data']['handles']): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((h, i) => h.type === b[i].type && h.side === b[i].side);
}

/** ¿Dibuja `built` exactamente lo mismo que `previous`? (Sin mirar la selección ni la marca de comparación, que se añaden después.) */
export function sameNode(previous: FlowNode, built: FlowNode): boolean {
  const a = previous.data;
  const b = built.data;
  return (
    previous.id === built.id &&
    previous.parentId === built.parentId &&
    previous.zIndex === built.zIndex &&
    previous.width === built.width &&
    previous.height === built.height &&
    samePoint(previous.position, built.position) &&
    a.node === b.node &&
    a.notation === b.notation &&
    a.group === b.group &&
    a.width === b.width &&
    a.height === b.height &&
    sameHandles(a.handles, b.handles)
  );
}

function sameRoute(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((p: { x: number; y: number }, i: number) => samePoint(p, b[i] as { x: number; y: number }));
}

/** ¿Dibuja `built` exactamente lo mismo que `previous`? (Sin mirar la selección, la función de elegir ni la marca de comparación.) */
export function sameEdge(previous: FlowEdge, built: FlowEdge): boolean {
  return (
    previous.id === built.id &&
    previous.source === built.source &&
    previous.target === built.target &&
    previous.sourceHandle === built.sourceHandle &&
    previous.targetHandle === built.targetHandle &&
    previous.style.stroke === built.style.stroke &&
    previous.style.strokeWidth === built.style.strokeWidth &&
    previous.style.strokeDasharray === built.style.strokeDasharray &&
    previous.markerEnd?.type === built.markerEnd?.type &&
    previous.markerEnd?.color === built.markerEnd?.color &&
    previous.markerStart?.color === built.markerStart?.color &&
    previous.data.edge === built.data.edge &&
    previous.data.notation === built.data.notation &&
    previous.data.bend === built.data.bend &&
    sameRoute(previous.data.route, built.data.route)
  );
}

/**
 * El nombre accesible (`ariaLabel`) de un elemento. `key` identifica lo que el nombre consulta además del propio elemento (el índice
 * de relaciones del grafo): mientras no cambie, el nombre de un elemento que no cambió tampoco, y su objeto se conserva.
 */
export interface Labels<T> {
  key: unknown;
  of(item: T, diff: Applied | undefined): string;
}

/** Lo que ya se entregó de cada nodo: el objeto de `buildFlow` del que salió, lo que se le añadió y el resultado. */
export interface NodeCache {
  base: FlowNode;
  selected: boolean;
  diff: Applied | undefined;
  labels: unknown;
  out: FlowNode;
}

/**
 * Los nodos de React Flow a partir de los de `buildFlow`, con su selección y su marca de comparación. Un nodo que dibuja lo mismo
 * que la vez anterior (misma posición, mismo tamaño, mismos datos, misma selección, misma marca) conserva su objeto. `cache` se
 * actualiza con lo que se entrega.
 */
export function decorateNodes(built: readonly FlowNode[], selected: ReadonlySet<string>, marks: ReadonlyMap<string, Applied> | undefined, cache: Map<string, NodeCache>, labels?: Labels<FlowNode>): FlowNode[] {
  const kept = new Map<string, NodeCache>();
  const out = built.map((node) => {
    const isSelected = selected.has(node.id);
    const diff = marks?.get(node.id);
    const previous = cache.get(node.id);
    if (previous && previous.selected === isSelected && previous.diff === diff && previous.labels === labels?.key && sameNode(previous.base, node)) {
      kept.set(node.id, previous);
      return previous.out;
    }
    const decorated: FlowNode = { ...node, selected: isSelected, ...(labels ? { ariaLabel: labels.of(node, diff) } : {}), ...(diff ? { data: { ...node.data, diff } } : {}) };
    kept.set(node.id, { base: node, selected: isSelected, diff, labels: labels?.key, out: decorated });
    return decorated;
  });
  cache.clear();
  for (const [id, entry] of kept) cache.set(id, entry);
  return out;
}

export interface EdgeCache {
  base: FlowEdge;
  selected: boolean;
  diff: Applied | undefined;
  pick: unknown;
  labels: unknown;
  out: FlowEdge;
}

/** Igual que `decorateNodes`, para las aristas: añade la selección, la función de elegir desde la etiqueta, la marca de comparación y el nombre accesible. */
export function decorateEdges(
  built: readonly FlowEdge[],
  selected: ReadonlySet<string>,
  pick: (id: string, additive: boolean) => void,
  marks: ReadonlyMap<string, Applied> | undefined,
  cache: Map<string, EdgeCache>,
  labels?: Labels<FlowEdge>,
): FlowEdge[] {
  const kept = new Map<string, EdgeCache>();
  const out = built.map((edge) => {
    const isSelected = selected.has(edge.id);
    const diff = marks?.get(edge.id);
    const previous = cache.get(edge.id);
    if (previous && previous.selected === isSelected && previous.diff === diff && previous.pick === pick && previous.labels === labels?.key && sameEdge(previous.base, edge)) {
      kept.set(edge.id, previous);
      return previous.out;
    }
    const decorated: FlowEdge = { ...edge, selected: isSelected, ...(labels ? { ariaLabel: labels.of(edge, diff) } : {}), data: { ...edge.data, onPick: pick, ...(diff ? { diff } : {}) } };
    kept.set(edge.id, { base: edge, selected: isSelected, diff, pick, labels: labels?.key, out: decorated });
    return decorated;
  });
  cache.clear();
  for (const [id, entry] of kept) cache.set(id, entry);
  return out;
}
