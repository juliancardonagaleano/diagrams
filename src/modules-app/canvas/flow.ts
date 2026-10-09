import type { Box, EdgeNotation, EdgeRoute, EditorEdge, EditorGraph, EditorNode, EditorSpec, GraphLayout, NodeNotation, Point, PortSide } from '@iark/kernel';

export const FALLBACK_NODE: NodeNotation = { kind: '?', label: 'Elemento', glyph: '□', shape: 'rect', fill: '#475569', width: 180, height: 72 };
export const FALLBACK_EDGE: EdgeNotation = { kind: '?', label: 'Relación', stroke: '#475569', line: 'solid', width: 1.5 };

/** Asa añadida a un nodo, además de la de entrada a la izquierda y la de salida a la derecha, para las aristas que la colocación de la vista ancla en otro lado. */
export interface ExtraHandle {
  type: 'source' | 'target';
  side: PortSide;
}

/** Al comparar versiones: qué le pasó a un elemento respecto a la versión base (`removed`: ya no está y se dibuja como fantasma). */
export type DiffMark = 'added' | 'modified' | 'removed';

export interface FlowNodeData extends Record<string, unknown> {
  node: EditorNode;
  notation: NodeNotation;
  group: boolean;
  width: number;
  height: number;
  handles?: ExtraHandle[];
  /** Solo al comparar versiones. */
  diff?: DiffMark;
}

export interface FlowNode {
  id: string;
  type: 'notation';
  position: { x: number; y: number };
  data: FlowNodeData;
  parentId?: string;
  /** Medidas conocidas de antemano: React Flow las usa para el minimapa y el encuadre sin esperar a medir el DOM. */
  width: number;
  height: number;
  style: { width: number; height: number };
  zIndex: number;
  selected?: boolean;
  /** Nombre accesible del nodo (tipo, nombre y relaciones): lo calcula el lienzo, no `buildFlow`, porque depende también de la comparación de versiones. */
  ariaLabel?: string;
  /** Los fantasmas de lo quitado al comparar versiones no se arrastran, ni se seleccionan ni se conectan. */
  draggable?: boolean;
  selectable?: boolean;
  connectable?: boolean;
}

export interface FlowEdgeData extends Record<string, unknown> {
  edge: EditorEdge;
  notation: EdgeNotation;
  /** Selección desde la etiqueta de la arista (que se dibuja fuera del SVG de las aristas). */
  onPick?(id: string, additive: boolean): void;
  /** Coordenada del tramo central que fija la colocación de la vista (su `y` si la arista sale por arriba o abajo, su `x` si sale de un lado). */
  bend?: number;
  /**
   * Recorrido completo que fija la colocación de la vista cuando la arista da más de un codo (sube por un pasillo libre, por ejemplo),
   * en coordenadas del lienzo. Solo lo lleva mientras los nodos de sus extremos siguen donde la colocación los dejó (o se han movido juntos).
   */
  route?: Point[];
  /** Solo al comparar versiones: la relación es nueva o cambió. */
  diff?: Exclude<DiffMark, 'removed'>;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  /** Asa de origen y de destino cuando la colocación de la vista ancla la arista en un lado distinto del de las asas por defecto. */
  sourceHandle?: string;
  targetHandle?: string;
  type: 'notation';
  style: { stroke: string; strokeWidth: number; strokeDasharray?: string };
  markerEnd?: { type: 'arrowclosed' | 'arrow'; color: string };
  markerStart?: { type: 'arrowclosed'; color: string };
  data: FlowEdgeData;
  selected?: boolean;
  /** Nombre accesible de la relación (de dónde a dónde va). */
  ariaLabel?: string;
}

const ORIGIN = { x: 0, y: 0 };

type Placed = Pick<FlowNode, 'id' | 'position' | 'parentId'>;

/** Posición absoluta de cada nodo (la de React Flow es relativa al padre en los hijos de un grupo). */
export function absolutePositions(nodes: readonly Placed[]): Map<string, { x: number; y: number }> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const result = new Map<string, { x: number; y: number }>();
  const resolve = (id: string, depth: number): { x: number; y: number } => {
    const known = result.get(id);
    if (known) return known;
    const node = byId.get(id)!;
    const parent = node.parentId && byId.has(node.parentId) && depth < 20 ? resolve(node.parentId, depth + 1) : ORIGIN;
    const at = { x: node.position.x + parent.x, y: node.position.y + parent.y };
    result.set(id, at);
    return at;
  };
  for (const n of nodes) resolve(n.id, 0);
  return result;
}

/**
 * Posiciones absolutas tras un arrastre: `changes` trae las nuevas posiciones (relativas al padre) que notifica React
 * Flow. Los descendientes de un grupo movido lo acompañan.
 */
export function movedByDrag(nodes: readonly Placed[], moved: ReadonlyMap<string, { x: number; y: number }>, changes: ReadonlyArray<{ id: string; position: { x: number; y: number } }>): Map<string, { x: number; y: number }> {
  const absolute = absolutePositions(nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, string[]>();
  for (const n of nodes) if (n.parentId) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n.id]);
  const dragged = new Set(changes.map((c) => c.id));
  const next = new Map(moved);
  for (const change of changes) {
    const node = byId.get(change.id);
    const before = absolute.get(change.id);
    if (!node || !before) continue;
    const parent = (node.parentId && absolute.get(node.parentId)) || ORIGIN;
    const after = { x: Math.round(change.position.x + parent.x), y: Math.round(change.position.y + parent.y) };
    next.set(change.id, after);
    const pending = [...(children.get(change.id) ?? [])];
    for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
      const at = absolute.get(id);
      if (dragged.has(id) || !at) continue;
      next.set(id, { x: at.x + after.x - before.x, y: at.y + after.y - before.y });
      pending.push(...(children.get(id) ?? []));
    }
  }
  return next;
}

/**
 * Elemento sobre el que se ha soltado `id`: el más pequeño (que no sea él ni descendiente suyo) que contiene el centro de
 * su caja. Las posiciones son absolutas; `sizes` da el ancho y alto de cada nodo.
 */
export function dropTarget(nodes: readonly Placed[], sizes: ReadonlyMap<string, { width: number; height: number }>, id: string): string | undefined {
  const absolute = absolutePositions(nodes);
  const at = absolute.get(id);
  const size = sizes.get(id);
  if (!at || !size) return undefined;
  const center = { x: at.x + size.width / 2, y: at.y + size.height / 2 };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const inside = (candidate: string): boolean => {
    for (let p = byId.get(candidate)?.parentId, depth = 0; p && depth < 20; p = byId.get(p)?.parentId, depth++) if (p === id) return true;
    return false;
  };
  let best: { id: string; area: number } | undefined;
  for (const n of nodes) {
    const box = absolute.get(n.id);
    const dims = sizes.get(n.id);
    if (n.id === id || !box || !dims || inside(n.id)) continue;
    if (center.x < box.x || center.x > box.x + dims.width || center.y < box.y || center.y > box.y + dims.height) continue;
    const area = dims.width * dims.height;
    if (!best || area < best.area) best = { id: n.id, area };
  }
  return best?.id;
}

/** Punto por el que una ruta sale de un lado de una caja o entra por él: el centro del lado. */
function anchorOf(box: Pick<Box, 'x' | 'y' | 'width' | 'height'>, side: PortSide): Point {
  switch (side) {
    case 'top':
      return { x: box.x + box.width / 2, y: box.y };
    case 'bottom':
      return { x: box.x + box.width / 2, y: box.y + box.height };
    case 'left':
      return { x: box.x, y: box.y + box.height / 2 };
    default:
      return { x: box.x + box.width, y: box.y + box.height / 2 };
  }
}

/**
 * La ruta de una arista con varios codos, si sigue valiendo: los nodos de sus extremos tienen que seguir donde la dejó la colocación
 * (o haberse movido lo mismo, como cuando se arrastra el grupo que los contiene, y entonces la ruta los acompaña). Si no, `undefined` y
 * la arista se traza como siempre entre sus asas.
 */
export function routeInPlace(route: EdgeRoute, source: Pick<Box, 'x' | 'y' | 'width' | 'height'>, target: Pick<Box, 'x' | 'y' | 'width' | 'height'>): Point[] | undefined {
  if (!route.sides || route.points.length < 2) return undefined;
  const [from, to] = [anchorOf(source, route.sides.source), anchorOf(target, route.sides.target)];
  const [first, last] = [route.points[0], route.points[route.points.length - 1]];
  const [dx, dy] = [from.x - first.x, from.y - first.y];
  if (Math.abs(dx - (to.x - last.x)) > 1 || Math.abs(dy - (to.y - last.y)) > 1) return undefined;
  return route.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

/**
 * La ruta de la colocación anclada a los extremos reales de la arista (los de las asas, que no caen exactamente en el borde de
 * los nodos): el primer y el último tramo siguen siendo rectos, así que el punto vecino de cada extremo se alinea con él.
 */
export function followRoute(points: readonly Point[], source: Point, target: Point): Point[] {
  const out = points.map((p) => ({ ...p }));
  const last = out.length - 1;
  if (last < 1) return out;
  out[0] = { ...source };
  out[last] = { ...target };
  if (last >= 2) {
    if (points[0].x === points[1].x) out[1].x = source.x;
    else out[1].y = source.y;
    if (points[last].x === points[last - 1].x) out[last - 1].x = target.x;
    else out[last - 1].y = target.y;
  }
  return out;
}

const notationOf = (spec: EditorSpec<unknown>, kind: string): NodeNotation => spec.nodeKinds.find((k) => k.kind === kind) ?? FALLBACK_NODE;
const edgeNotationOf = (spec: EditorSpec<unknown>, kind: string): EdgeNotation => spec.edgeKinds.find((k) => k.kind === kind) ?? FALLBACK_EDGE;

const DASH: Record<string, string | undefined> = { solid: undefined, dashed: '6 4', dotted: '2 4' };

const MARK_SLOT = 22;
const CHAR_WIDTH = 6.6;

/** Texto de la etiqueta de una arista: su nombre seguido de las insignias de texto entre «». */
export function edgeLabelText(edge: EditorEdge): string {
  return [edge.label, ...(edge.badges ?? []).map((b) => `«${b}»`)].filter(Boolean).join(' ');
}

/** Texto con el que se reserva el hueco de la etiqueta en el autolayout: el de la etiqueta y espacio para sus insignias gráficas. */
export function layoutLabelText(edge: EditorEdge): string {
  const room = '\u00a0'.repeat(Math.ceil(((edge.marks?.length ?? 0) * MARK_SLOT) / CHAR_WIDTH));
  const text = edgeLabelText(edge);
  return room ? `${room}${text}` : text;
}

/** Firma de la estructura del grafo: cambia cuando hay nodos, aristas o padres nuevos (no cuando solo cambia un texto). */
export function structureKey(graph: EditorGraph): string {
  return JSON.stringify([graph.nodes.map((n) => [n.id, n.parentId ?? '', n.label, n.sublabel ?? '']), graph.edges.map((e) => [e.id, e.source, e.target, e.label ?? ''])]);
}

/**
 * Convierte el grafo del módulo en nodos y aristas de React Flow. `layout` da las posiciones absolutas calculadas;
 * `moved` las que la persona ha arrastrado (tienen prioridad). Los nodos con hijos visibles son grupos: sus hijos llevan
 * `parentId` y posición relativa, y los padres van antes que los hijos, como exige React Flow.
 */
export function buildFlow(
  spec: EditorSpec<unknown>,
  graph: EditorGraph,
  layout: GraphLayout | undefined,
  moved: ReadonlyMap<string, { x: number; y: number }> = new Map(),
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const parents = new Set(graph.nodes.filter((n) => n.parentId && byId.has(n.parentId)).map((n) => n.parentId as string));
  const boxes = new Map<string, Box>([...(layout?.nodes ?? []), ...(layout?.groups ?? [])].map((b) => [b.id, b]));

  const absolute = new Map<string, { x: number; y: number; width: number; height: number }>();
  graph.nodes.forEach((n, i) => {
    const notation = notationOf(spec, n.kind);
    const box = boxes.get(n.id);
    const fallback = { x: (i % 4) * 240, y: Math.floor(i / 4) * 140 };
    const at = moved.get(n.id) ?? (box ? { x: box.x, y: box.y } : fallback);
    absolute.set(n.id, { ...at, width: box?.width ?? n.width ?? notation.width, height: box?.height ?? n.height ?? notation.height });
  });

  const depth = (id: string): number => {
    let d = 0;
    for (let p = byId.get(id)?.parentId; p && byId.has(p) && d < 20; p = byId.get(p)?.parentId) d++;
    return d;
  };

  // Cada grupo queda por encima del que lo contiene y todos los elementos por encima de cualquier grupo.
  const leafZ = Math.max(0, ...graph.nodes.filter((n) => parents.has(n.id)).map((n) => depth(n.id))) + 1;

  // Aristas que la colocación de la vista ancla en un lado (arriba o abajo de las etapas, por ejemplo): sus nodos llevan el asa.
  const anchors = new Map((layout?.edges ?? []).flatMap((r) => (r.sides ? [[r.id, r] as const] : [])));
  const extra = new Map<string, ExtraHandle[]>();
  const need = (id: string, handle: ExtraHandle): void => {
    const list = extra.get(id) ?? [];
    if (!list.some((h) => h.type === handle.type && h.side === handle.side)) extra.set(id, [...list, handle]);
  };
  for (const e of graph.edges) {
    const sides = byId.has(e.source) && byId.has(e.target) ? anchors.get(e.id)?.sides : undefined;
    if (!sides) continue;
    if (sides.source !== 'right') need(e.source, { type: 'source', side: sides.source });
    if (sides.target !== 'left') need(e.target, { type: 'target', side: sides.target });
  }

  const nodes: FlowNode[] = [...graph.nodes]
    .sort((a, b) => depth(a.id) - depth(b.id))
    .map((n) => {
      const notation = notationOf(spec, n.kind);
      const abs = absolute.get(n.id)!;
      const parent = n.parentId && byId.has(n.parentId) ? absolute.get(n.parentId) : undefined;
      const group = parents.has(n.id) || notation.container === true;
      return {
        id: n.id,
        type: 'notation',
        position: parent ? { x: abs.x - parent.x, y: abs.y - parent.y } : { x: abs.x, y: abs.y },
        ...(parent ? { parentId: n.parentId } : {}),
        data: { node: n, notation, group, width: abs.width, height: abs.height, ...(extra.has(n.id) ? { handles: extra.get(n.id) } : {}) },
        width: abs.width,
        height: abs.height,
        style: { width: abs.width, height: abs.height },
        zIndex: group ? depth(n.id) : leafZ,
      };
    });

  const edges: FlowEdge[] = graph.edges
    .filter((e) => byId.has(e.source) && byId.has(e.target))
    .map((e) => {
      const notation = edgeNotationOf(spec, e.kind);
      const width = e.width ?? notation.width ?? 1.5;
      const route = anchors.get(e.id);
      const sides = route?.sides;
      const vertical = sides?.source === 'top' || sides?.source === 'bottom';
      // Con un solo codo (cuatro puntos) la vista solo fija dónde gira; con más de uno, el lienzo pinta la ruta entera mientras valga.
      const several = route && route.points.length > 4 ? routeInPlace(route, absolute.get(e.source)!, absolute.get(e.target)!) : undefined;
      const bend = route && route.points.length === 4 ? route.points[1][vertical ? 'y' : 'x'] : undefined;
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        ...(sides && sides.source !== 'right' ? { sourceHandle: sides.source } : {}),
        ...(sides && sides.target !== 'left' ? { targetHandle: sides.target } : {}),
        type: 'notation',
        style: { stroke: notation.stroke, strokeWidth: width, strokeDasharray: DASH[notation.line ?? 'solid'] },
        ...(notation.arrowEnd === false ? {} : { markerEnd: { type: notation.head === 'open' ? ('arrow' as const) : ('arrowclosed' as const), color: notation.stroke } }),
        ...(notation.arrowStart ? { markerStart: { type: 'arrowclosed' as const, color: notation.stroke } } : {}),
        data: { edge: e, notation, ...(bend !== undefined ? { bend } : {}), ...(several ? { route: several } : {}) },
      };
    });

  return { nodes, edges };
}

/** Nodos de la versión base que ya no están en el documento actual, tal como los dibuja esta vista (los quitados que la vista de la versión base mostraba). */
export function removedNodes(spec: EditorSpec<unknown>, base: unknown, viewId: string | undefined, removed: ReadonlySet<string>, current: EditorGraph): EditorNode[] {
  try {
    const here = new Set(current.nodes.map((n) => n.id));
    return spec.project(base, viewId).nodes.filter((n) => removed.has(n.id) && !here.has(n.id));
  } catch {
    return []; // la vista no existe en la versión base, o el módulo no sabe proyectarla: no hay fantasmas
  }
}

const GHOST_COLUMNS = 5;
const GHOST_GAP = 30;

/**
 * Los elementos quitados al comparar versiones, como fantasmas discontinuos en una fila (o varias) bajo el dibujo: no tienen sitio en
 * la colocación del documento actual, que no los contiene. No se arrastran, ni se seleccionan ni se conectan.
 */
export function ghostNodes(spec: EditorSpec<unknown>, ghosts: readonly EditorNode[], placed: readonly FlowNode[]): FlowNode[] {
  if (ghosts.length === 0) return [];
  const absolute = absolutePositions(placed);
  const boxes = placed.map((n) => ({ ...(absolute.get(n.id) ?? ORIGIN), height: n.height }));
  const left = boxes.length > 0 ? Math.min(...boxes.map((b) => b.x)) : 0;
  const bottom = boxes.length > 0 ? Math.max(...boxes.map((b) => b.y + b.height)) : 0;
  const sized = ghosts.map((n) => {
    const notation = notationOf(spec, n.kind);
    return { node: n, notation, width: n.width ?? notation.width, height: n.height ?? notation.height };
  });
  const stepX = Math.max(...sized.map((g) => g.width)) + GHOST_GAP;
  const stepY = Math.max(...sized.map((g) => g.height)) + GHOST_GAP;
  return sized.map(({ node, notation, width, height }, i) => ({
    id: `ghost:${node.id}`,
    type: 'notation' as const,
    position: { x: left + (i % GHOST_COLUMNS) * stepX, y: bottom + 70 + Math.floor(i / GHOST_COLUMNS) * stepY },
    data: { node: { ...node, parentId: undefined, dashed: true }, notation, group: false, width, height, diff: 'removed' as const },
    width,
    height,
    style: { width, height },
    zIndex: 1,
    draggable: false,
    selectable: false,
    connectable: false,
  }));
}
