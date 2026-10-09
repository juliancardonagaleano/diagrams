import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api';
import { layoutElk } from '@iark/kernel';
import { deriveView, type DerivedBoundary, type DerivedNode, type DerivedView } from '../model/viewDerivation';
import {
  BOUNDARY_PADDING,
  type C4Document,
  type C4View,
  type C4ViewEdge,
  type C4ViewElement,
  type LayoutDensity,
  type LayoutDirection,
  type LayoutDirectionOption,
  type LayoutDistribution,
} from '../model/types';
import { viewLevel } from '../model/factories';
import { estimateLabelSize } from './labelMetrics';
import { measureLayout, type EdgeRoute, type LayoutQuality } from './quality';
// Ciclo de importación deliberado con smartLayout (este archivo lo llama y él usa runElkLayout/measureDerived…):
// es seguro porque ninguno de los dos usa al cargarse nada del otro, solo al ejecutar las funciones. Antes se
// resolvía con `await import('./smartLayout')`, pero index.ts ya lo importa de forma estática, así que ese import
// dinámico no separaba nada (aviso INEFFECTIVE_DYNAMIC_IMPORT del build).
import { smartLayout } from './smartLayout';

export interface LayoutOptions {
  /** Dirección concreta o 'auto' (C1 arriba→abajo, C2/C3 izquierda→derecha, con fallback al mejor ajuste). */
  direction?: LayoutDirectionOption;
  spacing?: number;
  layerSpacing?: number;
  /** Densidad: multiplica el espaciado (auto = según relaciones/nodo). */
  density?: LayoutDensity;
  /** Distribución: centrada y uniforme, colocación de ELK, o auto (centrada si sale limpia). */
  distribution?: LayoutDistribution;
  /** Recalcular todo aunque ya haya coordenadas. */
  force?: boolean;
  /** Una sola pasada de ELK (sin probar candidatos ni medir calidad). */
  fast?: boolean;
}

export interface PositionedElement {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutResult {
  viewId: string;
  positions: PositionedElement[];
  /** Geometría calculada de los boundaries (derivada; no se persiste). */
  boundaries: PositionedElement[];
  /** Rutas ortogonales y posición de etiqueta calculadas por ELK (se persisten en `view.edges`). */
  routes: C4ViewEdge[];
  /** Calidad medida del resultado (cruces, solapes…). */
  quality?: LayoutQuality;
  /** Dirección y distribución efectivamente usadas. */
  direction?: LayoutDirection;
  distribution?: 'centered' | 'elk';
}

export function routesToMap(routes: C4ViewEdge[] | undefined): Map<string, EdgeRoute> {
  const map = new Map<string, EdgeRoute>();
  for (const r of routes ?? []) map.set(r.id, { points: r.points, label: r.label });
  return map;
}

/** Variante de estrategia de ELK que prueba `smartLayout`. */
export interface LayoutVariant {
  name: string;
  nodePlacement?: 'BRANDES_KOEPF' | 'NETWORK_SIMPLEX' | 'LINEAR_SEGMENTS' | 'SIMPLE';
  crossingMinimization?: 'LAYER_SWEEP';
  thoroughness?: number;
  spacingFactor?: number;
  reverseEdges?: boolean;
  /** Sin restricciones de capa C4 (personas primero, externos al final). */
  noLayerConstraints?: boolean;
}

export const DEFAULTS = { direction: 'DOWN' as LayoutDirection, spacing: 70, layerSpacing: 110 };

const DENSITY_FACTOR: Record<Exclude<LayoutDensity, 'auto'>, number> = { compact: 0.8, spacious: 1.3 };

export interface ResolvedLayoutParams {
  /** Dirección preferida (resuelta desde 'auto' según el nivel de la vista). */
  direction: LayoutDirection;
  /** 'auto' permite probar la otra dirección como fallback; 'fixed' no. */
  directionMode: 'auto' | 'fixed';
  distribution: LayoutDistribution;
  spacing: number;
  layerSpacing: number;
  density: LayoutDensity;
}

/** Dirección preferida por nivel: C1 arriba→abajo; C2 y C3 izquierda→derecha. */
export function preferredDirectionFor(view: C4View): LayoutDirection {
  return viewLevel(view) === 'C1' ? 'DOWN' : 'RIGHT';
}

/** Resuelve dirección y espaciado: opciones explícitas > vista > valores por defecto, con ajuste por densidad. */
export function resolveLayoutParams(derived: DerivedView, options: LayoutOptions = {}): ResolvedLayoutParams {
  const { view, nodes, edges } = derived;
  const requested: LayoutDirectionOption = options.direction ?? 'auto';
  const direction = requested === 'auto' ? preferredDirectionFor(view) : requested;
  const distribution = options.distribution ?? view.layout?.distribution ?? 'auto';
  const density = options.density ?? view.layout?.density ?? 'auto';
  const explicitSpacing = options.spacing ?? view.layout?.spacing;
  const explicitLayer = options.layerSpacing ?? view.layout?.layerSpacing;
  // Densidad del grafo: relaciones por nodo. Más relaciones ⇒ más aire para etiquetas y rutas.
  const ratio = nodes.length > 0 ? edges.length / nodes.length : 0;
  const autoFactor = 1 + 0.25 * Math.min(ratio, 3);
  const factor = density === 'auto' ? autoFactor : DENSITY_FACTOR[density] * Math.max(1, autoFactor * 0.85);
  return {
    direction,
    directionMode: requested === 'auto' ? 'auto' : 'fixed',
    distribution: distribution === 'elk' || distribution === 'centered' ? distribution : 'auto',
    spacing: Math.round(explicitSpacing ?? DEFAULTS.spacing * factor),
    layerSpacing: Math.round(explicitLayer ?? DEFAULTS.layerSpacing * factor),
    density,
  };
}

/**
 * Calcula posiciones absolutas para los nodos de una vista usando ELK (algoritmo
 * `layered` con jerarquía incluida). Por defecto prueba varias estrategias y se
 * queda con la de mejor calidad (ver `smartLayout`).
 */
export async function layoutView(doc: C4Document, viewId: string, options: LayoutOptions = {}): Promise<LayoutResult> {
  const derived = deriveView(doc, viewId);
  return layoutDerivedView(derived, options);
}

export async function layoutDerivedView(derived: DerivedView, options: LayoutOptions = {}): Promise<LayoutResult> {
  const { view, nodes, boundaries } = derived;
  const force = options.force ?? false;

  if (nodes.length === 0) return { viewId: view.id, positions: [], boundaries: [], routes: [] };

  const anyPositioned = nodes.some((n) => n.positioned);
  const allPositioned = nodes.every((n) => n.positioned);
  if (allPositioned && !force) {
    const positions = nodes.map((n) => ({ id: n.id, x: n.x!, y: n.y!, width: n.width, height: n.height }));
    const bounds = boundaries.filter((b) => b.x !== undefined).map((b) => ({ id: b.id, x: b.x!, y: b.y!, width: b.width!, height: b.height! }));
    const routes = view.edges ?? [];
    const direction = view.layout?.direction ?? DEFAULTS.direction;
    return { viewId: view.id, positions, boundaries: bounds, routes, direction, quality: measureDerived(derived, positions, bounds, direction, routes) };
  }

  const params = resolveLayoutParams(derived, options);
  const interactive = anyPositioned && !force;
  if (interactive || options.fast) {
    const direction = interactive ? (view.layout?.direction ?? params.direction) : params.direction;
    try {
      const result = await runElkLayout(derived, { ...params, direction }, { name: interactive ? 'interactive' : 'fast' }, interactive);
      result.quality = measureDerived(derived, result.positions, result.boundaries, direction, result.routes);
      return result;
    } catch (error) {
      // El modo interactivo de ELK (conserva las posiciones existentes y coloca las nuevas) lanza
      // UnsupportedGraphException en grafos jerárquicos (C2/C3, con boundaries) cuando solo
      // algunos nodos tienen posición — p. ej. tras añadir un elemento existente a la vista. En vez
      // de propagar el error (que rompía el autolayout y la exportación a .drawio de todo el
      // documento), se recalcula la vista completa con la estrategia normal.
      if (!interactive) throw error;
    }
  }
  return smartLayout(derived, params);
}

export function measureDerived(
  derived: DerivedView,
  positions: PositionedElement[],
  boundaries: PositionedElement[],
  direction?: LayoutDirection,
  routes?: C4ViewEdge[],
): LayoutQuality {
  return measureLayout({
    nodes: positions,
    boundaries,
    direction: direction ?? derived.view.layout?.direction ?? DEFAULTS.direction,
    routes: routesToMap(routes),
    edges: derived.edges.map((e) => ({
      id: e.id,
      sourceId: e.sourceId,
      targetId: e.targetId,
      label: estimateLabelSize(e.relationship.description, e.relationship.technology),
    })),
  });
}

/** Una pasada de ELK con una variante de estrategia. */
export async function runElkLayout(derived: DerivedView, params: ResolvedLayoutParams, variant: LayoutVariant, interactive = false): Promise<LayoutResult> {
  const { view, nodes, boundaries, edges } = derived;
  const spacing = Math.round(params.spacing * (variant.spacingFactor ?? 1));
  // Con etiquetas centradas ELK inserta una "capa" de etiquetas entre dos capas de nodos,
  // así que el espacio entre capas se aplica dos veces: se reparte a la mitad.
  const hasLabels = edges.some((e) => estimateLabelSize(e.relationship.description, e.relationship.technology));
  const layerSpacing = Math.round((params.layerSpacing * (variant.spacingFactor ?? 1)) / (hasLabels ? 2 : 1));

  const rootOptions: Record<string, string> = {
    'elk.algorithm': 'layered',
    'elk.direction': params.direction,
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.json.edgeCoords': 'ROOT',
    'elk.spacing.nodeNode': String(spacing),
    'elk.layered.spacing.nodeNodeBetweenLayers': String(layerSpacing),
    'elk.spacing.edgeNode': '32',
    'elk.spacing.edgeEdge': '22',
    'elk.layered.spacing.edgeNodeBetweenLayers': '32',
    'elk.layered.spacing.edgeEdgeBetweenLayers': '24',
    'elk.spacing.componentComponent': String(spacing),
    'elk.spacing.edgeLabel': '12',
    'elk.spacing.labelNode': '12',
    'elk.edgeLabels.placement': 'CENTER',
    'elk.edgeLabels.inline': 'true',
    'elk.separateConnectedComponents': 'true',
    'elk.layered.nodePlacement.strategy': interactive ? 'INTERACTIVE' : (variant.nodePlacement ?? 'BRANDES_KOEPF'),
    'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
    'elk.layered.crossingMinimization.strategy': interactive ? 'INTERACTIVE' : (variant.crossingMinimization ?? 'LAYER_SWEEP'),
    'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
    'elk.layered.thoroughness': String(variant.thoroughness ?? 40),
    'elk.layered.cycleBreaking.strategy': interactive ? 'INTERACTIVE' : 'GREEDY',
    'elk.layered.considerModelOrder.strategy': interactive ? 'NODES_AND_EDGES' : 'NONE',
    'elk.layered.unnecessaryBendpoints': 'true',
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.padding': '[top=20,left=20,bottom=20,right=20]',
  };

  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const e of edges) {
    outgoing.set(e.sourceId, (outgoing.get(e.sourceId) ?? 0) + 1);
    incoming.set(e.targetId, (incoming.get(e.targetId) ?? 0) + 1);
  }

  const elkNodeFor = (n: DerivedNode): ElkNode => {
    const layoutOptions: Record<string, string> = {};
    if (interactive && n.positioned) layoutOptions['elk.position'] = `(${n.x},${n.y})`;
    if (!interactive && !variant.noLayerConstraints && !n.boundaryId) {
      // Convenciones C4: personas al principio del flujo, sistemas externos "sumidero" al final.
      if (n.element.type === 'person' && !incoming.get(n.id)) layoutOptions['elk.layered.layering.layerConstraint'] = 'FIRST';
      else if (n.element.external && !outgoing.get(n.id) && incoming.get(n.id)) layoutOptions['elk.layered.layering.layerConstraint'] = 'LAST';
    }
    return {
      id: n.id,
      width: n.width,
      height: n.height,
      ...(interactive && n.positioned ? { x: n.x, y: n.y } : {}),
      layoutOptions: Object.keys(layoutOptions).length ? layoutOptions : undefined,
    };
  };

  const boundaryById = new Map(boundaries.map((b) => [b.id, b]));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const build = (b: DerivedBoundary): ElkNode => {
    const crowded = b.children.length > 4;
    const inner = Math.round(spacing * (crowded ? 1.2 : 1));
    return {
      id: b.id,
      layoutOptions: {
        'elk.padding': `[top=${BOUNDARY_PADDING.top},left=${BOUNDARY_PADDING.left},bottom=${BOUNDARY_PADDING.bottom + 8},right=${BOUNDARY_PADDING.right}]`,
        'elk.nodeSize.constraints': 'MINIMUM_SIZE',
        'elk.nodeSize.minimum': '(200, 120)',
        'elk.spacing.nodeNode': String(inner),
        'elk.layered.spacing.nodeNodeBetweenLayers': String(Math.round(layerSpacing * (crowded ? 1.1 : 1))),
      },
      children: b.children.map((cid) => (nodeById.has(cid) ? elkNodeFor(nodeById.get(cid)!) : build(boundaryById.get(cid)!))),
    };
  };

  const topLevel: ElkNode[] = [...boundaries.filter((b) => !b.boundaryId).map(build), ...nodes.filter((n) => !n.boundaryId).map(elkNodeFor)];

  const orderedEdges = variant.reverseEdges ? [...edges].reverse() : edges;
  const elkEdges: ElkExtendedEdge[] = orderedEdges.map((e) => {
    const label = estimateLabelSize(e.relationship.description, e.relationship.technology);
    return {
      id: e.id,
      sources: [e.sourceId],
      targets: [e.targetId],
      ...(label
        ? {
            labels: [
              {
                text: e.relationship.description ?? e.relationship.technology ?? '',
                width: label.width,
                height: label.height,
                layoutOptions: { 'elk.edgeLabels.inline': 'true', 'elk.edgeLabels.placement': 'CENTER' },
              },
            ],
          }
        : {}),
    };
  });

  const graph: ElkNode = { id: 'root', layoutOptions: rootOptions, children: topLevel, edges: elkEdges };
  // ELK corre donde decide el núcleo: un hilo de trabajo en el navegador (la página no se congela), el hilo actual en Node.
  const result = await layoutElk(graph);

  const positions: PositionedElement[] = [];
  const boundaryPositions: PositionedElement[] = [];
  const walk = (node: ElkNode, offsetX: number, offsetY: number) => {
    for (const child of node.children ?? []) {
      const x = offsetX + (child.x ?? 0);
      const y = offsetY + (child.y ?? 0);
      const item = { id: child.id, x: Math.round(x), y: Math.round(y), width: child.width ?? 0, height: child.height ?? 0 };
      if (boundaryById.has(child.id)) {
        boundaryPositions.push(item);
        walk(child, x, y);
      } else {
        positions.push(item);
      }
    }
  };
  walk(result, 0, 0);

  const routes: C4ViewEdge[] = [];
  for (const e of result.edges ?? []) {
    const section = (e as ElkExtendedEdge).sections?.[0];
    if (!section) continue;
    const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
    const lbl = (e as ElkExtendedEdge).labels?.[0];
    const label = lbl && lbl.x !== undefined && lbl.y !== undefined ? { x: Math.round(lbl.x + (lbl.width ?? 0) / 2), y: Math.round(lbl.y + (lbl.height ?? 0) / 2) } : undefined;
    routes.push(label ? { id: e.id, points, label } : { id: e.id, points });
  }

  return { viewId: view.id, positions, boundaries: boundaryPositions, routes, direction: params.direction, distribution: 'elk' };
}

/** Geometría de los boundaries (bbox de sus hijos + padding) para unas posiciones dadas. */
export function boundariesFromPositions(derived: DerivedView, positions: PositionedElement[]): PositionedElement[] {
  const byId = new Map(positions.map((p) => [p.id, p]));
  const result = new Map<string, PositionedElement>();
  const depth = (b: DerivedBoundary): number => (b.boundaryId ? 1 + depth(derived.boundaries.find((x) => x.id === b.boundaryId)!) : 0);
  for (const b of [...derived.boundaries].sort((a, c) => depth(c) - depth(a))) {
    const rects = b.children.map((cid) => byId.get(cid) ?? result.get(cid)).filter((r): r is PositionedElement => !!r);
    if (rects.length === 0) continue;
    const minX = Math.min(...rects.map((r) => r.x));
    const minY = Math.min(...rects.map((r) => r.y));
    const maxX = Math.max(...rects.map((r) => r.x + r.width));
    const maxY = Math.max(...rects.map((r) => r.y + r.height));
    result.set(b.id, {
      id: b.id,
      x: minX - BOUNDARY_PADDING.left,
      y: minY - BOUNDARY_PADDING.top,
      width: maxX - minX + BOUNDARY_PADDING.left + BOUNDARY_PADDING.right,
      height: maxY - minY + BOUNDARY_PADDING.top + BOUNDARY_PADDING.bottom,
    });
  }
  return [...result.values()];
}

/** Devuelve una copia de la vista con las posiciones, rutas y opciones de layout aplicadas. */
export function applyLayoutToView(view: C4View, result: LayoutResult): C4View {
  const byId = new Map(result.positions.map((p) => [p.id, p]));
  const elements: C4ViewElement[] = view.elements.map((ve) => {
    const p = byId.get(ve.id);
    return p ? { ...ve, x: p.x, y: p.y, width: p.width, height: p.height } : ve;
  });
  const next: C4View = { ...view, elements };
  if (result.routes.length > 0) next.edges = result.routes;
  else delete next.edges;
  if (result.direction || result.distribution) {
    next.layout = { ...view.layout, ...(result.direction ? { direction: result.direction } : {}), ...(result.distribution ? { distribution: result.distribution } : {}) };
  }
  return next;
}

/** Aplica autolayout a una vista y devuelve un documento nuevo (inmutable). */
export async function autoLayoutView(doc: C4Document, viewId: string, options: LayoutOptions = {}): Promise<C4Document> {
  const result = await layoutView(doc, viewId, options);
  return {
    ...doc,
    views: doc.views.map((v) => (v.id === viewId ? applyLayoutToView(v, result) : v)),
  };
}

/** Aplica autolayout a todas las vistas del documento (solo a las que lo necesitan, salvo `force`). */
export async function autoLayoutDocument(doc: C4Document, options: LayoutOptions = {}): Promise<C4Document> {
  let current = doc;
  for (const view of doc.views) {
    current = await autoLayoutView(current, view.id, options);
  }
  return current;
}

/** Igual que `autoLayoutDocument` pero devuelve también la calidad por vista. */
export async function autoLayoutDocumentWithQuality(
  doc: C4Document,
  options: LayoutOptions = {},
): Promise<{ document: C4Document; qualities: Array<{ viewId: string; quality?: LayoutQuality; direction?: LayoutDirection; distribution?: 'centered' | 'elk' }> }> {
  let current = doc;
  const qualities: Array<{ viewId: string; quality?: LayoutQuality; direction?: LayoutDirection; distribution?: 'centered' | 'elk' }> = [];
  for (const view of doc.views) {
    const result = await layoutView(current, view.id, options);
    qualities.push({ viewId: view.id, quality: result.quality, direction: result.direction, distribution: result.distribution });
    current = { ...current, views: current.views.map((v) => (v.id === view.id ? applyLayoutToView(v, result) : v)) };
  }
  return { document: current, qualities };
}
