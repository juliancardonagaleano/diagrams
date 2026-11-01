import { formatUrn, viewChoices, type AnyModule, type ElementLink } from '@iark/kernel';
import type { Backlink } from './links';

/** Un sitio al que se puede ir desde el elemento seleccionado. */
export type Destination =
  | { kind: 'view'; id: string; label: string }
  | { kind: 'detail'; id: string; label: string }
  | { kind: 'link'; id: string; label: string; urn: string; viewId?: string };

/** Enlaces de un elemento: el `ref` principal y cada entrada de `links`. */
export function readElementLinks(document: unknown, id: string): ElementLink[] {
  const record = findRecord(document, id);
  if (!record) return [];
  const out: ElementLink[] = [];
  if (typeof record.ref === 'string' && record.ref) out.push({ ref: record.ref, ...(typeof record.refType === 'string' ? { refType: record.refType } : {}) });
  if (Array.isArray(record.links)) {
    for (const link of record.links) {
      if (!link || typeof link !== 'object') continue;
      const item = link as ElementLink;
      if (typeof item.ref !== 'string' || !item.ref) continue;
      if (out.some((have) => have.ref === item.ref)) continue;
      out.push({ ref: item.ref, ...(item.refType ? { refType: item.refType } : {}), ...(item.view ? { view: item.view } : {}) });
    }
  }
  return out;
}

/** El objeto con ese id que declara enlaces. Una vista puede repetir el id solo como miembro, sin `ref`. */
function findRecord(value: unknown, id: string): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (record.id === id) {
      const linked = typeof record.ref === 'string' || Array.isArray(record.links);
      if (!found || linked) found = record;
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return found;
}

interface StoredView {
  id?: string;
  title?: string;
  scopeId?: string;
  elements?: Array<{ id?: string }>;
}

/** Vistas del mismo documento en las que el elemento es el alcance o está dibujado, salvo la abierta. */
export function sameDocumentViews(document: unknown, elementId: string, currentViewId?: string): Array<{ id: string; title: string }> {
  const views = (document as { views?: StoredView[] } | null)?.views;
  if (!Array.isArray(views)) return [];
  const out: Array<{ id: string; title: string }> = [];
  for (const view of views) {
    if (typeof view.id !== 'string' || view.id === currentViewId) continue;
    const scoped = view.scopeId === elementId;
    const drawn = view.elements?.some((element) => element.id === elementId) ?? false;
    if (!scoped && !drawn) continue;
    out.push({ id: view.id, title: view.title?.trim() || view.id });
  }
  return out;
}

export interface AssembleInput {
  views: Array<{ id: string; title: string }>;
  /** La acción «Detallar» se puede ejecutar (crea la vista hija si no existe). */
  detail?: { label: string };
  links: ElementLink[];
  backlinks?: Backlink[];
  /** Otras apariciones declaradas en un sujeto del proyecto. */
  appearances?: Array<{ module: string; elementId: string; viewId?: string; label: string }>;
}

/** Junta los destinos sin repetir la misma vista ni la misma URN. */
export function assembleDestinations(input: AssembleInput): Destination[] {
  const destinations: Destination[] = [];
  const viewIds = new Set<string>();
  const urns = new Set<string>();
  for (const view of input.views) {
    if (viewIds.has(view.id)) continue;
    viewIds.add(view.id);
    destinations.push({ kind: 'view', id: `view:${view.id}`, label: view.title });
  }
  if (input.detail && !destinations.some((d) => d.kind === 'view')) {
    destinations.push({ kind: 'detail', id: 'detail', label: input.detail.label });
  }
  for (const link of input.links) {
    if (urns.has(link.ref)) continue;
    urns.add(link.ref);
    const type = link.refType ? ` · ${link.refType}` : '';
    destinations.push({ kind: 'link', id: `link:${link.ref}`, label: `${link.ref}${type}`, urn: link.ref, ...(link.view ? { viewId: link.view } : {}) });
  }
  for (const back of input.backlinks ?? []) {
    if (urns.has(back.urn)) continue;
    urns.add(back.urn);
    destinations.push({ kind: 'link', id: `back:${back.urn}`, label: `${back.name} · ${back.type}`, urn: back.urn });
  }
  for (const appearance of input.appearances ?? []) {
    const urn = formatUrn(appearance.module, appearance.elementId);
    if (urns.has(urn)) continue;
    urns.add(urn);
    destinations.push({ kind: 'link', id: `subject:${urn}`, label: appearance.label, urn, ...(appearance.viewId ? { viewId: appearance.viewId } : {}) });
  }
  return destinations;
}

/**
 * La vista más ajustada del documento que dibuja el elemento. Una vista cuyo alcance es el elemento gana (el C3 de un
 * contenedor). Si no, la que lo dibuja con menos nodos (el entorno, antes que la topología).
 */
export function focusedView(module: AnyModule, document: unknown, elementId: string): string | undefined {
  const stored = (document as { views?: StoredView[] } | null)?.views;
  const scoped = stored?.find((view) => view.scopeId === elementId && typeof view.id === 'string');
  if (scoped?.id) return scoped.id;
  const editor = module.editor;
  if (!editor) {
    const drawn = stored?.find((view) => view.elements?.some((element) => element.id === elementId) && typeof view.id === 'string');
    return drawn?.id;
  }
  let best: { id: string; count: number } | undefined;
  for (const view of viewChoices(module, document).views) {
    let graph;
    try {
      graph = editor.project(document, view.id);
    } catch {
      continue;
    }
    if (!graph.nodes.some((node) => node.id === elementId)) continue;
    if (!best || graph.nodes.length < best.count) best = { id: view.id, count: graph.nodes.length };
  }
  return best?.id;
}
