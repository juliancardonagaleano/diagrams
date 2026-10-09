import { layoutGraph, renderGraphSvg } from '../graph';
import { DEFAULT_LINK_TYPE } from './link-types';
import type { Reached, TraceGraph } from './trace';

/**
 * Dibujo del grafo de trazabilidad: un recuadro por módulo, un nodo por elemento y una flecha discontinua por cada enlace
 * (`ref`), de quien se apoya hacia aquello en lo que se apoya. La flecha lleva como etiqueta el tipo del enlace (`refType`), salvo
 * el de por omisión (`depends-on`), que no se rotula. Con `reached` (lo que alcanza un elemento) se dibuja solo
 * ese subgrafo y se distingue el punto de partida, lo que se apoya en él y aquello de lo que se apoya.
 */

/** Colores por módulo: fondos oscuros con texto blanco (contraste ≥ 4,5:1). */
const MODULE_COLORS: Record<string, string> = {
  c4: '#175e7a',
  integration: '#1d4ed8',
  data: '#0f766e',
  enterprise: '#6d28d9',
  platform: '#b45309',
  security: '#be123c',
};
const FALLBACK_COLOR = '#475569';

const NODE_WIDTH = 190;
const NODE_HEIGHT = 56;

export interface TraceSvgOptions {
  /** Lo que alcanza un elemento: dibuja solo ese subgrafo. Sin él se dibujan los elementos que participan en algún enlace. */
  reached?: Reached[];
  title?: string;
  /** Nombre legible de cada módulo (por defecto, su id). */
  moduleLabels?: Record<string, string>;
}

const escapeXml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function emptySvg(message: string): string {
  const text = escapeXml(message);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 90" width="520" height="90" font-family="Inter, Arial, sans-serif" font-size="13"><rect width="520" height="90" fill="#ffffff"/><text x="260" y="50" text-anchor="middle" fill="#475569">${text}</text></svg>\n`;
}

export async function traceSvg(graph: TraceGraph, options: TraceSvgOptions = {}): Promise<string> {
  const reachedByUrn = new Map((options.reached ?? []).map((r) => [r.node.urn, r]));
  const only = options.reached ? new Set(reachedByUrn.keys()) : undefined;

  const links = graph.links.filter((l) => !only || (only.has(l.from) && only.has(l.to)));
  const visible = new Set<string>(only ?? []);
  for (const l of links) visible.add(l.from).add(l.to);
  const nodes = graph.nodes.filter((n) => visible.has(n.urn));
  if (nodes.length === 0) return emptySvg('No hay enlaces entre los documentos aportados.');

  const modules = [...new Set(nodes.map((n) => n.module))];
  const ids = new Map(nodes.map((n, i) => [n.urn, `n${i}`]));
  const byId = new Map(nodes.map((n) => [ids.get(n.urn)!, n]));
  const layout = await layoutGraph(
    nodes.map((n) => ({ id: ids.get(n.urn)!, width: NODE_WIDTH, height: NODE_HEIGHT, groupId: `g:${n.module}` })),
    links.map((l, i) => ({ id: `e${i}`, source: ids.get(l.from)!, target: ids.get(l.to)!, ...(l.type !== DEFAULT_LINK_TYPE ? { label: l.type } : {}) })),
    modules.map((m) => ({ id: `g:${m}` })),
    { direction: 'RIGHT' },
  );

  const start = options.reached?.[0]?.node.urn;
  return renderGraphSvg(layout, {
    title: options.title,
    node(id) {
      const node = byId.get(id)!;
      const role = reachedByUrn.get(node.urn);
      const base = MODULE_COLORS[node.module] ?? FALLBACK_COLOR;
      const isStart = node.urn === start;
      return {
        fill: base,
        // El borde marca el papel en el alcance: el punto de partida en oscuro, quien se apoya en él en naranja y de quien depende en verde.
        stroke: isStart ? '#0f172a' : role?.direction === 'referrers' ? '#f59e0b' : role?.direction === 'refs' ? '#22c55e' : base,
        badge: node.kind,
        lines: [node.name, node.id],
        shape: 'rect',
      };
    },
    edge(id) {
      const type = links[Number(id.slice(1))]?.type;
      return { stroke: '#64748b', dashed: true, ...(type && type !== DEFAULT_LINK_TYPE ? { label: type } : {}) };
    },
    group(id) {
      const module = id.slice(2);
      const color = MODULE_COLORS[module] ?? FALLBACK_COLOR;
      return { label: options.moduleLabels?.[module] ?? module, fill: `${color}14`, stroke: color };
    },
  });
}
