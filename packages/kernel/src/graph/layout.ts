import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api';
import { layoutElk } from './elk';

/**
 * Autolayout genérico (ELK `layered`) para los módulos que dibujan un grafo de nodos y aristas con agrupaciones
 * opcionales. Es una sola pasada, sin las estrategias de rescate del módulo C4: suficiente para mapas de integración,
 * linaje de datos o topologías de plataforma. El cálculo corre donde decide `layoutElk` (un hilo de trabajo en el navegador,
 * el hilo actual en Node) y se puede cancelar con `signal`.
 */
export type GraphDirection = 'RIGHT' | 'DOWN' | 'LEFT' | 'UP';

export interface GraphNodeInput {
  id: string;
  width: number;
  height: number;
  /** Grupo que lo contiene (otro id de `groups`). */
  groupId?: string;
}

export interface GraphGroupInput {
  id: string;
  /** Grupo padre, si se anidan. */
  groupId?: string;
}

export interface GraphEdgeInput {
  id: string;
  source: string;
  target: string;
  /** Texto de la etiqueta, para reservarle sitio (no se dibuja aquí). */
  label?: string;
}

export interface GraphLayoutOptions {
  direction?: GraphDirection;
  /** Separación entre nodos de una misma capa (px). */
  spacing?: number;
  /** Separación entre capas (px). */
  layerSpacing?: number;
  /**
   * Cuánto se esfuerza el cálculo. `normal` (por omisión) es el de siempre. `fast` rebaja el cuidado de ELK en minimizar cruces
   * (colocación algo menos limpia, mucho más rápida en grafos de cientos de nodos); el lienzo lo usa solo con diagramas muy grandes.
   */
  effort?: 'normal' | 'fast';
  /** Al abortarse, el cálculo se descarta o se corta y la promesa se rechaza con un `AbortError` (ver `isAbortError`). */
  signal?: AbortSignal;
}

export interface Box {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Lado de un nodo por el que sale o entra una arista. */
export type PortSide = 'top' | 'right' | 'bottom' | 'left';

export interface EdgeRoute {
  id: string;
  /**
   * Recorrido completo, del origen al destino. El SVG y draw.io lo pintan tal cual; el lienzo, cuando la ruta trae más de un
   * codo (más de cuatro puntos) y los nodos siguen donde la dejó la colocación, también (si se mueven, la arista se traza como siempre).
   */
  points: Point[];
  /** Centro de la etiqueta, si tiene. */
  label?: Point;
  /**
   * Lado del nodo de origen por el que sale la ruta y del de destino por el que llega, cuando la colocación propia de una
   * vista lo decide (p. ej. los flujos de valor, que bajan de la etapa a la capacidad). El lienzo ancla ahí la arista en
   * lugar de usar las asas laterales; el autolayout por capas no lo rellena.
   */
  sides?: { source: PortSide; target: PortSide };
}

export interface GraphLayout {
  nodes: Box[];
  groups: Box[];
  edges: EdgeRoute[];
  width: number;
  height: number;
}

/** Opciones de ELK del modo `fast`: un solo barrido de minimización de cruces, sin el ajuste voraz posterior. */
const FAST_OPTIONS: Record<string, string> = {
  'elk.layered.thoroughness': '1',
  'elk.layered.crossingMinimization.greedySwitch.type': 'OFF',
};

/** Tamaño aproximado de una etiqueta de arista (ELK necesita reservar el hueco). */
export function estimateLabel(text: string): { width: number; height: number } {
  return { width: Math.min(220, Math.max(24, text.length * 6.6 + 12)), height: 18 };
}

const GROUP_PADDING = '[top=44,left=24,bottom=24,right=24]';

export async function layoutGraph(nodes: GraphNodeInput[], edges: GraphEdgeInput[], groups: GraphGroupInput[] = [], options: GraphLayoutOptions = {}): Promise<GraphLayout> {
  const spacing = options.spacing ?? 48;
  const hasLabels = edges.some((e) => e.label);
  // Con etiquetas centradas ELK inserta una capa de etiquetas entre dos capas de nodos: el espacio se reparte.
  const layerSpacing = Math.round((options.layerSpacing ?? 110) / (hasLabels ? 2 : 1));

  const elkNodes = new Map<string, ElkNode>();
  for (const g of groups) {
    elkNodes.set(g.id, { id: g.id, children: [], layoutOptions: { 'elk.padding': GROUP_PADDING, 'elk.nodeSize.constraints': 'MINIMUM_SIZE' } });
  }
  for (const n of nodes) elkNodes.set(n.id, { id: n.id, width: n.width, height: n.height });

  const root: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': options.direction ?? 'RIGHT',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.json.edgeCoords': 'ROOT',
      'elk.spacing.nodeNode': String(spacing),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(layerSpacing),
      'elk.spacing.edgeNode': '28',
      'elk.spacing.edgeEdge': '20',
      'elk.spacing.edgeLabel': '10',
      'elk.edgeLabels.placement': 'CENTER',
      'elk.edgeLabels.inline': 'true',
      'elk.separateConnectedComponents': 'true',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.padding': '[top=20,left=20,bottom=20,right=20]',
      ...(options.effort === 'fast' ? FAST_OPTIONS : {}),
    },
    children: [],
    edges: edges.map(
      (e): ElkExtendedEdge => ({
        id: e.id,
        sources: [e.source],
        targets: [e.target],
        ...(e.label ? { labels: [{ text: e.label, ...estimateLabel(e.label), layoutOptions: { 'elk.edgeLabels.inline': 'true', 'elk.edgeLabels.placement': 'CENTER' } }] } : {}),
      }),
    ),
  };
  const attach = (id: string, parentId: string | undefined): void => {
    const node = elkNodes.get(id)!;
    const parent = parentId ? elkNodes.get(parentId) : undefined;
    (parent?.children ?? root.children!).push(node);
  };
  for (const g of groups) attach(g.id, g.groupId);
  for (const n of nodes) attach(n.id, n.groupId);

  const laid = await layoutElk(root, { signal: options.signal });

  const nodeBoxes: Box[] = [];
  const groupBoxes: Box[] = [];
  const groupIds = new Set(groups.map((g) => g.id));
  const walk = (node: ElkNode, offX: number, offY: number): void => {
    for (const child of node.children ?? []) {
      const x = offX + (child.x ?? 0);
      const y = offY + (child.y ?? 0);
      const box = { id: child.id, x, y, width: child.width ?? 0, height: child.height ?? 0 };
      (groupIds.has(child.id) ? groupBoxes : nodeBoxes).push(box);
      walk(child, x, y);
    }
  };
  walk(laid, 0, 0);

  const routes: EdgeRoute[] = [];
  const collectEdges = (node: ElkNode): void => {
    for (const e of (node.edges ?? []) as ElkExtendedEdge[]) {
      const section = e.sections?.[0];
      if (!section) continue;
      const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map((p) => ({ x: p.x, y: p.y }));
      const label = e.labels?.[0];
      routes.push({ id: e.id, points, ...(label && label.x !== undefined ? { label: { x: label.x + (label.width ?? 0) / 2, y: label.y! + (label.height ?? 0) / 2 } } : {}) });
    }
    for (const child of node.children ?? []) collectEdges(child);
  };
  collectEdges(laid);

  return { nodes: nodeBoxes, groups: groupBoxes, edges: routes, width: laid.width ?? 0, height: laid.height ?? 0 };
}
