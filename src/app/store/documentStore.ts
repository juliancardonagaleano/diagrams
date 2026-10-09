import { create, useStore } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';
import { temporal } from 'zundo';
import {
  childViewType,
  createElement,
  createEmptyDocument,
  createRelationship,
  createView,
  findChildView,
  findParentView,
  isValidParentType,
  suggestViewElements,
  typeChangeBlockedReason,
} from '@core/model/factories';
import { sampleDocument } from '@core/model/sample';
import { applyLayoutToView, layoutView, type LayoutOptions } from '@core/layout/elkLayout';
import type { LayoutQuality } from '@core/layout/quality';
import type { LayoutDirection } from '@core/model/types';
import { migratePersistedDocument, migratePersistedState, PERSIST_VERSION } from './persistMigration';

/** true si el id de ruta (relación o `rel@origen->destino`) toca alguno de los elementos movidos. */
function touchesAny(routeId: string, moved: Map<string, unknown>): boolean {
  const at = routeId.indexOf('@');
  if (at >= 0) {
    const [src, tgt] = routeId.slice(at + 1).split('->');
    return moved.has(src) || moved.has(tgt);
  }
  // Relación directa: se resuelve en la vista (la validación de rutas descarta las obsoletas de todos modos).
  return true;
}
import {
  DEFAULT_SIZES,
  VIEW_SCOPE_TYPE,
  type C4Document,
  type C4Element,
  type C4Relationship,
  type C4View,
  type ElementType,
  type LayoutDensity,
  type LayoutDirectionOption,
  type LayoutDistribution,
  type ViewType,
} from '@core/model/types';

export type Selection =
  | { kind: 'element'; id: string }
  | { kind: 'relationship'; id: string }
  | { kind: 'none' };

export type PanelTab = 'elements' | 'relationships' | 'views' | 'ai';
export type Theme = 'light' | 'dark';

export interface UiState {
  theme: Theme;
  showHeader: boolean;
  showSidebar: boolean;
  showIssues: boolean;
  showMinimap: boolean;
  showGrid: boolean;
  sidebarWidth: number;
  sidebarMode: 'structure' | 'json';
  panelTab: PanelTab;
  /** Dirección del autolayout: concreta o 'auto' (C1 ↓, C2/C3 →). */
  direction: LayoutDirectionOption;
  /** Notación del lienzo: 'c4' (cajas de color, convención C4) o 'card' (tarjetas estilo drawdb). */
  nodeStyle: 'c4' | 'card';
  /** Densidad del autolayout. */
  density: LayoutDensity;
  /** Distribución del autolayout: centrada uniforme, ELK o automática. */
  distribution: LayoutDistribution;
}

export interface DocumentState {
  doc: C4Document;
  activeViewId: string | null;
  selection: Selection;
  modified: boolean;
  lastSavedAt: number | null;
  /** Texto de estado inyectado por el anfitrión (modo embebido). */
  statusMessage: string | null;
  readOnly: boolean;
  ui: UiState;
  layoutBusy: boolean;
  /** Calidad del último autolayout ejecutado (cruces, solapes, estrategia, dirección y distribución elegidas). */
  lastLayoutQuality: (LayoutQuality & { viewId: string; direction?: LayoutDirection; distribution?: 'centered' | 'elk' }) | null;
}

export interface DocumentActions {
  setDocument: (doc: C4Document, opts?: { activeViewId?: string; markSaved?: boolean }) => void;
  newDocument: () => void;
  loadSample: () => void;
  mergeDocument: (incoming: C4Document) => void;
  setWorkspaceName: (name: string) => void;
  select: (selection: Selection) => void;
  setActiveView: (viewId: string | null) => void;
  addElement: (type: ElementType, position?: { x: number; y: number }, partial?: Partial<C4Element>) => C4Element;
  updateElement: (id: string, patch: Partial<Omit<C4Element, 'id'>>) => void;
  removeElement: (id: string) => void;
  addRelationship: (sourceId: string, targetId: string, partial?: Partial<C4Relationship>) => C4Relationship | null;
  updateRelationship: (id: string, patch: Partial<Omit<C4Relationship, 'id'>>) => void;
  removeRelationship: (id: string) => void;
  addView: (type: ViewType, scopeId?: string, title?: string) => C4View;
  updateView: (id: string, patch: Partial<Omit<C4View, 'id' | 'elements'>>) => void;
  removeView: (id: string) => void;
  addElementToView: (viewId: string, elementId: string, position?: { x: number; y: number }) => void;
  removeElementFromView: (viewId: string, elementId: string) => void;
  moveElements: (viewId: string, moves: Array<{ id: string; x: number; y: number }>, reparent?: { id: string; parentId: string | undefined }) => void;
  runAutoLayout: (viewId?: string, options?: LayoutOptions) => Promise<void>;
  markSaved: () => void;
  setStatusMessage: (message: string | null, modified?: boolean) => void;
  setReadOnly: (readOnly: boolean) => void;
  setUi: (patch: Partial<UiState>) => void;
  toggleTheme: () => void;
  /** Baja al nivel inferior de un elemento (sistema → C2, contenedor → C3); crea la vista si no existe. */
  drillDown: (elementId: string) => string | null;
  /** Sube al nivel superior de la vista activa (C3 → C2 → C1). */
  drillUp: () => string | null;
}

export type DocumentStore = DocumentState & DocumentActions;

const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
export const isEmbedMode = params.get('embed') === '1';

const noopStorage: StateStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const STORAGE_KEY = 'iark-diagrams';
/** Clave anterior al cambio de marca: se lee una vez para no perder el diagrama guardado por el usuario. */
const LEGACY_STORAGE_KEY = 'diagramador-c4model';

const migratingLocalStorage: StateStorage = {
  getItem: (name) => {
    const current = localStorage.getItem(name);
    if (current !== null || name !== STORAGE_KEY) return current;
    return localStorage.getItem(LEGACY_STORAGE_KEY);
  },
  setItem: (name, value) => {
    localStorage.setItem(name, value);
    if (name === STORAGE_KEY) localStorage.removeItem(LEGACY_STORAGE_KEY);
  },
  removeItem: (name) => localStorage.removeItem(name),
};

const defaultUi: UiState = {
  theme: 'light',
  showHeader: true,
  showSidebar: true,
  showIssues: true,
  showMinimap: true,
  showGrid: true,
  sidebarWidth: 420,
  sidebarMode: 'structure',
  panelTab: 'elements',
  direction: 'auto',
  nodeStyle: 'c4',
  density: 'auto',
  distribution: 'auto',
};

function firstViewId(doc: C4Document): string | null {
  return doc.views[0]?.id ?? null;
}

export const useDocumentStore = create<DocumentStore>()(
  persist(
    temporal(
      (set, get) => {
        const updateDoc = (fn: (doc: C4Document) => C4Document) => {
          set((s) => ({ doc: fn(s.doc), modified: true }));
        };
        const activeView = (): C4View | undefined => {
          const { doc, activeViewId } = get();
          return doc.views.find((v) => v.id === activeViewId);
        };

        return {
          doc: isEmbedMode ? createEmptyDocument() : sampleDocument,
          activeViewId: isEmbedMode ? null : firstViewId(sampleDocument),
          selection: { kind: 'none' },
          modified: false,
          lastSavedAt: null,
          statusMessage: null,
          readOnly: false,
          ui: defaultUi,
          layoutBusy: false,
          lastLayoutQuality: null,

          setDocument: (doc, opts = {}) => {
            const activeViewId = opts.activeViewId && doc.views.some((v) => v.id === opts.activeViewId) ? opts.activeViewId : firstViewId(doc);
            set({ doc, activeViewId, selection: { kind: 'none' }, modified: !opts.markSaved, lastSavedAt: opts.markSaved ? Date.now() : get().lastSavedAt });
          },
          newDocument: () => {
            const doc = createEmptyDocument();
            const view = createView('systemContext', { title: 'Contexto del sistema' });
            doc.views.push(view);
            set({ doc, activeViewId: view.id, selection: { kind: 'none' }, modified: false, lastSavedAt: null });
          },
          loadSample: () => {
            set({ doc: structuredClone(sampleDocument), activeViewId: firstViewId(sampleDocument), selection: { kind: 'none' }, modified: false });
          },
          mergeDocument: (incoming) => {
            updateDoc((doc) => {
              const elIds = new Set(doc.model.elements.map((e) => e.id));
              const relIds = new Set(doc.model.relationships.map((r) => r.id));
              const viewIds = new Set(doc.views.map((v) => v.id));
              const elements = [
                ...doc.model.elements.map((e) => incoming.model.elements.find((i) => i.id === e.id) ?? e),
                ...incoming.model.elements.filter((e) => !elIds.has(e.id)),
              ];
              const relationships = [
                ...doc.model.relationships.map((r) => incoming.model.relationships.find((i) => i.id === r.id) ?? r),
                ...incoming.model.relationships.filter((r) => !relIds.has(r.id)),
              ];
              const views = [
                ...doc.views.map((v) => {
                  const inc = incoming.views.find((i) => i.id === v.id);
                  if (!inc) return v;
                  const existing = new Map(v.elements.map((e) => [e.id, e]));
                  return {
                    ...v,
                    ...inc,
                    elements: inc.elements.map((e) => (existing.get(e.id) && e.x === undefined ? existing.get(e.id)! : e)),
                  };
                }),
                ...incoming.views.filter((v) => !viewIds.has(v.id)),
              ];
              return { ...doc, workspace: { ...doc.workspace, ...incoming.workspace }, model: { elements, relationships }, views };
            });
            if (!get().activeViewId) set({ activeViewId: firstViewId(get().doc) });
          },
          setWorkspaceName: (name) => updateDoc((doc) => ({ ...doc, workspace: { ...doc.workspace, name } })),
          select: (selection) => set({ selection }),
          setActiveView: (viewId) => set({ activeViewId: viewId, selection: { kind: 'none' } }),

          addElement: (type, position, partial = {}) => {
            const { doc } = get();
            const view = activeView();
            const parentId =
              partial.parentId ??
              (view && view.scopeId && ((view.type === 'container' && type === 'container') || (view.type === 'component' && type === 'component'))
                ? view.scopeId
                : undefined);
            const element = createElement(type, { ...partial, parentId }, doc.model.elements.map((e) => e.id));
            updateDoc((d) => ({
              ...d,
              model: { ...d.model, elements: [...d.model.elements, element] },
              views: view
                ? d.views.map((v) =>
                    v.id === view.id
                      ? { ...v, elements: [...v.elements, { id: element.id, ...(position ? { x: position.x, y: position.y, ...DEFAULT_SIZES[type] } : {}) }] }
                      : v,
                  )
                : d.views,
            }));
            set({ selection: { kind: 'element', id: element.id } });
            return element;
          },
          updateElement: (id, patch) =>
            updateDoc((doc) => ({
              ...doc,
              model: {
                ...doc.model,
                elements: doc.model.elements.map((e) => {
                  if (e.id !== id) return e;
                  const next = { ...e, ...patch } as C4Element;
                  // Cambiar de tipo un elemento con hijos o que es alcance de una vista dejaría un
                  // documento inválido: se conserva el tipo anterior (la interfaz ya lo deshabilita).
                  if (patch.type && typeChangeBlockedReason(doc, id, patch.type)) {
                    next.type = e.type;
                    if ('parentId' in patch) next.parentId = e.parentId;
                  }
                  // Invariante: el padre siempre es del tipo que exige el tipo del elemento. Al cambiar
                  // el tipo (o asignar un padre) se descarta un padre incompatible en vez de dejar un
                  // documento que el esquema rechaza al reimportar.
                  if (next.parentId && ('type' in patch || 'parentId' in patch)) {
                    const parent = doc.model.elements.find((x) => x.id === next.parentId);
                    if (!isValidParentType(parent?.type, next.type)) delete next.parentId;
                  }
                  // `name` es obligatorio: un patch vacío/solo espacios se ignora (conserva el
                  // nombre anterior) en vez de dejar el elemento sin nombre.
                  if (typeof patch.name === 'string' && !patch.name.trim()) next.name = e.name;
                  for (const key of Object.keys(next) as Array<keyof C4Element>) {
                    if (key === 'name') continue;
                    if (next[key] === undefined || next[key] === '') delete next[key];
                  }
                  return next;
                }),
              },
            })),
          removeElement: (id) => {
            updateDoc((doc) => {
              const descendants = new Set<string>([id]);
              let changed = true;
              while (changed) {
                changed = false;
                for (const e of doc.model.elements) {
                  if (e.parentId && descendants.has(e.parentId) && !descendants.has(e.id)) {
                    descendants.add(e.id);
                    changed = true;
                  }
                }
              }
              const relationships = doc.model.relationships.filter((r) => !descendants.has(r.sourceId) && !descendants.has(r.targetId));
              const relIds = new Set(relationships.map((r) => r.id));
              // Una ruta guardada en la vista sigue viva si su relación (directa) no se eliminó,
              // o si ninguno de sus extremos (implícita, `rel@origen->destino`) era un descendiente.
              const routeStillValid = (routeId: string): boolean => {
                const at = routeId.indexOf('@');
                if (at >= 0) {
                  const [src, tgt] = routeId.slice(at + 1).split('->');
                  return !descendants.has(src) && !descendants.has(tgt);
                }
                return relIds.has(routeId);
              };
              return {
                ...doc,
                model: { elements: doc.model.elements.filter((e) => !descendants.has(e.id)), relationships },
                views: doc.views
                  .filter((v) => !(v.scopeId && descendants.has(v.scopeId)))
                  .map((v) => ({
                    ...v,
                    elements: v.elements.filter((e) => !descendants.has(e.id)),
                    edges: v.edges?.filter((r) => routeStillValid(r.id)),
                  })),
              };
            });
            const s = get();
            if (s.selection.kind === 'element' && s.selection.id === id) set({ selection: { kind: 'none' } });
            if (s.activeViewId && !s.doc.views.some((v) => v.id === s.activeViewId)) set({ activeViewId: firstViewId(s.doc) });
          },

          addRelationship: (sourceId, targetId, partial = {}) => {
            if (sourceId === targetId) return null;
            const { doc } = get();
            const duplicate = doc.model.relationships.some((r) => r.sourceId === sourceId && r.targetId === targetId);
            if (duplicate) return null;
            const rel = createRelationship(sourceId, targetId, { description: 'Usa', ...partial }, doc.model.relationships.map((r) => r.id));
            updateDoc((d) => ({ ...d, model: { ...d.model, relationships: [...d.model.relationships, rel] } }));
            set({ selection: { kind: 'relationship', id: rel.id } });
            return rel;
          },
          updateRelationship: (id, patch) =>
            updateDoc((doc) => ({
              ...doc,
              model: {
                ...doc.model,
                relationships: doc.model.relationships.map((r) => {
                  if (r.id !== id) return r;
                  const next = { ...r, ...patch } as C4Relationship;
                  // Solo si la edición cambia el par origen→destino: se ignora si dejaría una auto-referencia
                  // o duplicaría otra relación. Editar descripción/tecnología nunca se bloquea, aunque el
                  // documento importado ya tuviera relaciones repetidas entre los mismos elementos.
                  if (next.sourceId !== r.sourceId || next.targetId !== r.targetId) {
                    if (next.sourceId === next.targetId) return r;
                    const duplicate = doc.model.relationships.some((o) => o.id !== id && o.sourceId === next.sourceId && o.targetId === next.targetId);
                    if (duplicate) return r;
                  }
                  for (const key of Object.keys(next) as Array<keyof C4Relationship>) {
                    if (next[key] === undefined || next[key] === '') delete next[key];
                  }
                  return next;
                }),
              },
            })),
          removeRelationship: (id) => {
            updateDoc((doc) => ({
              ...doc,
              model: { ...doc.model, relationships: doc.model.relationships.filter((r) => r.id !== id) },
              // Purga también las rutas guardadas que colgaban de esta relación (directa o implícita).
              views: doc.views.map((v) => ({ ...v, edges: v.edges?.filter((r) => r.id !== id && !r.id.startsWith(`${id}@`)) })),
            }));
            const s = get();
            if (s.selection.kind === 'relationship' && s.selection.id === id) set({ selection: { kind: 'none' } });
          },

          addView: (type, scopeId, title) => {
            const { doc } = get();
            const scope = doc.model.elements.find((e) => e.id === scopeId);
            const validScope = scope && scope.type === VIEW_SCOPE_TYPE[type] ? scope.id : undefined;
            const suggested = suggestViewElements(doc, type, validScope).filter((id) => id !== validScope || type === 'systemContext');
            const view = createView(
              type,
              {
                scopeId: validScope,
                title: title ?? (scope ? `${labelForViewType(type)} - ${scope.name}` : labelForViewType(type)),
                elements: suggested.map((id) => ({ id })),
                layout: get().ui.direction === 'auto' ? undefined : { direction: get().ui.direction as LayoutDirection },
              },
              doc.views.map((v) => v.id),
            );
            updateDoc((d) => ({ ...d, views: [...d.views, view] }));
            set({ activeViewId: view.id, selection: { kind: 'none' } });
            return view;
          },
          updateView: (id, patch) =>
            updateDoc((doc) => ({
              ...doc,
              views: doc.views.map((v) => {
                if (v.id !== id) return v;
                const next = { ...v, ...patch };
                // En contexto el alcance es un nodo más: si se fija (o se cambia) el alcance, entra en la vista.
                const needsScope =
                  next.type === 'systemContext' &&
                  next.scopeId &&
                  !next.elements.some((e) => e.id === next.scopeId) &&
                  doc.model.elements.some((e) => e.id === next.scopeId);
                return needsScope ? { ...next, elements: [...next.elements, { id: next.scopeId! }] } : next;
              }),
            })),
          removeView: (id) => {
            updateDoc((doc) => ({ ...doc, views: doc.views.filter((v) => v.id !== id) }));
            const s = get();
            if (s.activeViewId === id) set({ activeViewId: firstViewId(s.doc) });
          },
          addElementToView: (viewId, elementId, position) =>
            updateDoc((doc) => ({
              ...doc,
              views: doc.views.map((v) => {
                if (v.id !== viewId || v.elements.some((e) => e.id === elementId)) return v;
                const el = doc.model.elements.find((e) => e.id === elementId);
                const geo = position && el ? { x: position.x, y: position.y, ...DEFAULT_SIZES[el.type] } : {};
                return { ...v, elements: [...v.elements, { id: elementId, ...geo }] };
              }),
            })),
          removeElementFromView: (viewId, elementId) =>
            updateDoc((doc) => ({
              ...doc,
              views: doc.views.map((v) => {
                if (v.id !== viewId) return v;
                // El sistema de una vista de contexto no se puede quitar: sin él la vista deja de ser válida.
                if (v.type === 'systemContext' && v.scopeId === elementId) return v;
                return { ...v, elements: v.elements.filter((e) => e.id !== elementId) };
              }),
            })),
          moveElements: (viewId, moves, reparent) => {
            if (moves.length === 0 && !reparent) return;
            const byId = new Map(moves.map((m) => [m.id, m]));
            updateDoc((doc) => ({
              ...doc,
              // Reparentar (adoptar un boundary nuevo, o desvincularse si se sale de todos) se
              // aplica en la misma actualización que el movimiento: así un solo gesto de
              // arrastre queda como un único paso de deshacer, no dos.
              model: reparent
                ? {
                    ...doc.model,
                    elements: doc.model.elements.map((e) => {
                      if (e.id !== reparent.id) return e;
                      const next = { ...e };
                      if (reparent.parentId) next.parentId = reparent.parentId;
                      else delete next.parentId;
                      return next;
                    }),
                  }
                : doc.model,
              views: doc.views.map((v) =>
                v.id === viewId
                  ? {
                      ...v,
                      elements: v.elements.map((e) => {
                        const m = byId.get(e.id);
                        if (!m) return e;
                        const el = doc.model.elements.find((x) => x.id === e.id);
                        const size = el ? DEFAULT_SIZES[el.type] : { width: 240, height: 130 };
                        return { ...e, x: Math.round(m.x), y: Math.round(m.y), width: e.width ?? size.width, height: e.height ?? size.height };
                      }),
                      // Las rutas del autolayout que tocan un elemento movido dejan de ser válidas.
                      edges: v.edges?.filter((r) => !touchesAny(r.id, byId)),
                    }
                  : v,
              ),
            }));
          },

          runAutoLayout: async (viewId, options = {}) => {
            const id = viewId ?? get().activeViewId;
            if (!id) return;
            set({ layoutBusy: true });
            try {
              const direction = options.direction ?? get().ui.direction;
              const density = options.density ?? get().ui.density;
              const distribution = options.distribution ?? get().ui.distribution;
              const result = await layoutView(get().doc, id, { force: true, ...options, direction, density, distribution });
              updateDoc((doc) => ({
                ...doc,
                views: doc.views.map((v) => (v.id === id ? applyLayoutToView({ ...v, layout: { ...v.layout, density } }, result) : v)),
              }));
              set({
                lastLayoutQuality: result.quality ? { viewId: id, ...result.quality, direction: result.direction, distribution: result.distribution } : null,
              });
            } finally {
              set({ layoutBusy: false });
            }
          },

          markSaved: () => set({ modified: false, lastSavedAt: Date.now() }),
          setStatusMessage: (message, modified) => set({ statusMessage: message, ...(modified !== undefined ? { modified } : {}) }),
          setReadOnly: (readOnly) => set({ readOnly }),
          setUi: (patch) => set((s) => ({ ui: { ...s.ui, ...patch } })),
          toggleTheme: () => set((s) => ({ ui: { ...s.ui, theme: s.ui.theme === 'dark' ? 'light' : 'dark' } })),

          drillDown: (elementId) => {
            const { doc } = get();
            const element = doc.model.elements.find((e) => e.id === elementId);
            if (!element) return null;
            const existing = findChildView(doc, elementId);
            if (existing) {
              set({ activeViewId: existing.id, selection: { kind: 'none' } });
              return existing.id;
            }
            const type = childViewType(element);
            if (!type || get().readOnly) return null;
            return get().addView(type, elementId).id;
          },
          drillUp: () => {
            const { doc, activeViewId } = get();
            const view = doc.views.find((v) => v.id === activeViewId);
            if (!view) return null;
            const parent = findParentView(doc, view);
            if (!parent) return null;
            set({ activeViewId: parent.id, selection: view.scopeId ? { kind: 'element', id: view.scopeId } : { kind: 'none' } });
            return parent.id;
          },
        };
      },
      {
        partialize: (state) => ({ doc: state.doc }),
        limit: 100,
        equality: (a, b) => a.doc === b.doc,
      },
    ),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => (isEmbedMode ? noopStorage : migratingLocalStorage)),
      partialize: (state) => ({ doc: state.doc, activeViewId: state.activeViewId, ui: state.ui, lastSavedAt: state.lastSavedAt }),
      // Los ajustes nuevos (p. ej. nodeStyle) conservan su valor por defecto aunque el localStorage sea anterior. El documento
      // pasa siempre por las migraciones del módulo C4 (también si la forma persistida no cambió de versión): un cambio de
      // esquema no deja inservible lo que la persona ya tenía guardado.
      merge: (persisted, current) => {
        const p = (migratePersistedDocument(persisted) ?? {}) as Partial<DocumentState>;
        return { ...current, ...p, ui: { ...current.ui, ...(p.ui ?? {}) } };
      },
      // Política de versiones: ver `persistMigration.ts`. Sube `PERSIST_VERSION` cuando cambie la FORMA de lo persistido
      // (`partialize`) y añade el paso en `migratePersistedState`; sin `migrate`, zustand descartaba lo guardado con otra versión.
      version: PERSIST_VERSION,
      migrate: (persisted, version) => migratePersistedState(persisted, version) as DocumentStore,
    },
  ),
);

function labelForViewType(type: ViewType): string {
  return type === 'systemContext' ? 'Contexto' : type === 'container' ? 'Contenedores' : 'Componentes';
}

// Cuántas secciones tienen ahora mismo el historial en pausa (ver `pauseHistory`).
let historyPauses = 0;

/**
 * Pausa el historial de deshacer (lo que se cambie mientras tanto no es un paso) y devuelve la función que levanta esa pausa.
 * Las pausas se anidan: `temporal.pause()`/`resume()` de zundo son un interruptor, así que una sección que terminara antes que
 * otra (el autolayout inicial de una vista, que es asíncrono, y la exportación a .drawio, que guarda las posiciones de las
 * vistas sin abrir) reanudaría el historial a mitad de la otra y su cambio llegaría después como un paso de deshacer. Aquí el
 * historial solo se reanuda cuando se han levantado todas las pausas; levantar dos veces la misma no cuenta dos.
 */
export function pauseHistory(): () => void {
  historyPauses++;
  useDocumentStore.temporal.getState().pause();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    historyPauses--;
    if (historyPauses === 0) useDocumentStore.temporal.getState().resume();
  };
}

export const useTemporalStore = <T,>(selector: (state: ReturnType<typeof useDocumentStore.temporal.getState>) => T): T =>
  useStore(useDocumentStore.temporal, selector);

export function elementById(doc: C4Document, id: string): C4Element | undefined {
  return doc.model.elements.find((e) => e.id === id);
}
