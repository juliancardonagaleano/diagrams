import type { EditResult, EditorAction, EditorGraph, EditorSpec } from '@iark/kernel';

export type Selection = ReadonlySet<string>;

export const NO_SELECTION: Selection = new Set();

/** Lo que React Flow comunica de un cambio de selección (lo demás —posiciones, medidas— no interesa aquí). */
export interface SelectionChange {
  type: string;
  id?: string;
  selected?: boolean;
}

/** Aplica los cambios `select` que notifican `onNodesChange` y `onEdgesChange` sobre la selección controlada. */
export function applySelectionChanges(selection: Selection, changes: readonly SelectionChange[]): Selection {
  let next: Set<string> | undefined;
  for (const change of changes) {
    if (change.type !== 'select' || change.id === undefined || !!change.selected === (next ?? selection).has(change.id)) continue;
    next ??= new Set(selection);
    if (change.selected) next.add(change.id);
    else next.delete(change.id);
  }
  return next ?? selection;
}

export function toggleSelected(selection: Selection, id: string): Selection {
  const next = new Set(selection);
  if (!next.delete(id)) next.add(id);
  return next;
}

/** Los ids seleccionados que existen en el grafo (nodos y luego aristas, en su orden). */
export function resolveSelection(graph: EditorGraph | undefined, selection: Selection): string[] {
  if (!graph || selection.size === 0) return [];
  return [...graph.nodes.map((n) => n.id), ...graph.edges.map((e) => e.id)].filter((id) => selection.has(id));
}

/** Nodos que hay que encuadrar para mostrar un elemento: él mismo si es un nodo, sus dos extremos si es una relación. */
export function focusNodes(graph: EditorGraph, id: string): string[] {
  if (graph.nodes.some((n) => n.id === id)) return [id];
  const edge = graph.edges.find((e) => e.id === id);
  return edge ? [edge.source, edge.target] : [];
}

export interface SelectionItem {
  id: string;
  title: string;
  kind: string;
}

/** Nombre y tipo legibles de cada elemento seleccionado, para el resumen del panel de propiedades. */
export function describeSelection(spec: EditorSpec<unknown>, graph: EditorGraph, ids: readonly string[]): SelectionItem[] {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const edges = new Map(graph.edges.map((e) => [e.id, e]));
  return ids.flatMap((id): SelectionItem[] => {
    const node = nodes.get(id);
    if (node) return [{ id, title: node.label, kind: spec.nodeKinds.find((k) => k.kind === node.kind)?.label ?? node.kind }];
    const edge = edges.get(id);
    if (!edge) return [];
    const ends = `${nodes.get(edge.source)?.label ?? edge.source} → ${nodes.get(edge.target)?.label ?? edge.target}`;
    return [{ id, title: edge.label ? `${edge.label} (${ends})` : ends, kind: spec.edgeKinds.find((k) => k.kind === edge.kind)?.label ?? edge.kind }];
  });
}

/**
 * Borra varios elementos encadenando `spec.remove` sobre el documento que va resultando, de modo que se puedan registrar
 * como una sola edición. Lo que ya cayó con otro elemento (las aristas de un nodo borrado) se salta.
 */
export function removeAll(spec: EditorSpec<unknown>, document: unknown, ids: readonly string[]): EditResult<unknown> {
  let current = document;
  for (const id of ids) {
    if (!spec.read(current, id)) continue;
    const result = spec.remove(current, id);
    if (!result.ok) return result;
    current = result.document;
  }
  return { ok: true, document: current };
}

export interface ActionAvailability {
  enabled: boolean;
  /** Por qué no está disponible, o la ayuda de la acción cuando sí lo está. */
  title: string;
}

const NEEDS_HINT = { none: undefined, one: 'Selecciona un único elemento.', many: 'Selecciona al menos un elemento.' } as const;

/** Si la acción se puede lanzar con esta selección, y el texto de ayuda del botón. */
export function actionAvailability(action: EditorAction<unknown>, document: unknown, ids: readonly string[], readOnly: boolean, viewId?: string): ActionAvailability {
  const help = action.hint ?? action.label;
  if (readOnly) return { enabled: false, title: 'El documento es de solo lectura.' };
  const needs = action.needs === 'one' ? ids.length === 1 : action.needs === 'many' ? ids.length >= 1 : true;
  if (!needs) return { enabled: false, title: NEEDS_HINT[action.needs] ?? help };
  const why = action.disabled?.(document, [...ids], viewId);
  return why ? { enabled: false, title: why } : { enabled: true, title: help };
}
