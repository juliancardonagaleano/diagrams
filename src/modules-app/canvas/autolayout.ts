import { layoutGraph, type EditorGraph, type EditorSpec, type GraphLayout } from '@iark/kernel';
import { layoutLabelText } from './flow';

/** Marca de User Timing de cada autolayout: se ve en el panel «Rendimiento» del navegador y la lee `npm run perf`. */
export const AUTOLAYOUT_MEASURE = 'iark:autolayout';

export interface AutolayoutOptions {
  /** Al abortarse, el cálculo se descarta o se corta y la promesa se rechaza con un `AbortError`. */
  signal?: AbortSignal;
  /** Fuerza el esfuerzo del cálculo; por omisión depende del tamaño (`effortFor`). */
  effort?: 'normal' | 'fast';
  /** Lo pide el botón Autolayout: recalcular aunque el documento ya guarde posiciones (ver `EditorSpec.layout`). */
  fresh?: boolean;
}

/** Desde cuántos nodos el autolayout pasa al modo rápido de ELK. Por debajo, la colocación es la de siempre. Ver docs/rendimiento.md. */
export const FAST_LAYOUT_FROM_NODES = 600;

export const effortFor = (nodeCount: number): 'normal' | 'fast' => (nodeCount >= FAST_LAYOUT_FROM_NODES ? 'fast' : 'normal');

/**
 * Colocación automática del grafo de una vista: la propia del módulo si la declara (`spec.layout`: una matriz, un flujo de valor) y,
 * si no o si no tiene nada que decir, el autolayout por capas del núcleo con los tamaños que dicta la notación. Es lo que el lienzo
 * pide cuando cambia la estructura; vive aquí, sin React, para que el script de medición (`npm run perf`) calcule exactamente lo mismo.
 *
 * El cálculo corre en un hilo de trabajo del navegador (ver `layoutElk` en el núcleo) y se puede cancelar con `options.signal`.
 */
export async function autolayoutGraph(spec: EditorSpec<unknown>, document: unknown | undefined, graph: EditorGraph, viewId: string | undefined, options: AutolayoutOptions = {}): Promise<GraphLayout> {
  const start = performance.now();
  try {
    const own = spec.layout && document !== undefined ? await spec.layout(document, viewId, { ...(options.fresh ? { fresh: true } : {}), ...(options.signal ? { signal: options.signal } : {}) }) : undefined;
    if (own) return own;
    const kinds = new Map(spec.nodeKinds.map((k) => [k.kind, k]));
    const parents = new Set(graph.nodes.filter((n) => n.parentId).map((n) => n.parentId as string));
    return await layoutGraph(
      graph.nodes.filter((n) => !parents.has(n.id)).map((n) => ({ id: n.id, width: n.width ?? kinds.get(n.kind)?.width ?? 180, height: n.height ?? kinds.get(n.kind)?.height ?? 72, groupId: n.parentId })),
      graph.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, label: layoutLabelText(e) })),
      graph.nodes.filter((n) => parents.has(n.id)).map((n) => ({ id: n.id, groupId: n.parentId })),
      { direction: 'RIGHT', effort: options.effort ?? effortFor(graph.nodes.length), signal: options.signal },
    );
  } finally {
    try {
      performance.measure(AUTOLAYOUT_MEASURE, { start, end: performance.now(), detail: { nodes: graph.nodes.length, edges: graph.edges.length } });
    } catch {
      /* sin User Timing (un entorno de pruebas muy antiguo): la medida es solo un apoyo */
    }
  }
}
