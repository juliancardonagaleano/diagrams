import {
  Background,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { layoutGraph, pretty, type EditResult, type EditorSpec, type GraphLayout } from '@iark/kernel';
import './canvas.css';
import { ActionPrompt } from './ActionPrompt';
import type { CanvasCompare } from '../compare';
import { absolutePositions, buildFlow, dropTarget, ghostNodes, layoutLabelText, movedByDrag, removedNodes, structureKey, type FlowEdge, type FlowNode } from './flow';
import type { EditHistory } from './history';
import { Inspector, type LinkTools } from './Inspector';
import { NotationEdge } from './NotationEdge';
import { NotationNode } from './NotationNode';
import { actionAvailability, applySelectionChanges, describeSelection, focusNodes, NO_SELECTION, removeAll, resolveSelection, toggleSelected, type Selection } from './selection';
import { ShapeSvg } from './shapes';
import { CANVAS_SHORTCUTS, matchShortcut } from './shortcuts';

export interface DiagramCanvasProps {
  moduleId: string;
  spec: EditorSpec<unknown>;
  /** Documento válido actual; sin él el lienzo avisa en vez de dibujar. */
  document: unknown | undefined;
  text: string;
  viewId?: string;
  views: Array<{ id: string; title: string; variantOf?: string; variantLabel?: string; variantsLabel?: string }>;
  onView(id: string): void;
  readOnly: boolean;
  history: EditHistory;
  onText(text: string): void;
  notify(message: string): void;
  /** Elemento que hay que seleccionar y encuadrar (al llegar desde otro diagrama). */
  focusId?: string;
  links?: LinkTools;
  /** Hay un diagrama al que volver (Alt+↑). */
  onBack?(): void;
  /** Avisa de qué elemento está seleccionado (para la miga de pan al seguir un enlace); `undefined` si no hay uno solo. */
  onSelect?(id: string | undefined): void;
  /** Abre un adjunto del módulo (un contrato) en su pestaña. */
  onOpenAttachment?(id: string): void;
  /** Comparando con otra versión: marca los elementos nuevos y modificados y dibuja como fantasmas los que se quitaron. Sin él, el lienzo es el de siempre. */
  compare?: CanvasCompare;
}

/** Sin cajas calculadas: `buildFlow` coloca cada elemento en su cuadrícula de reserva. */
const EMPTY_LAYOUT: GraphLayout = { nodes: [], groups: [], edges: [], width: 0, height: 0 };

const nodeTypes = { notation: NotationNode };
const edgeTypes = { notation: NotationEdge };

const positionsKey = (moduleId: string, viewId: string | undefined): string => `iark.canvas.${moduleId}.${viewId ?? ''}`;
const readPositions = (key: string): Map<string, { x: number; y: number }> => {
  try {
    const raw = window.localStorage.getItem(key);
    return new Map(raw ? (JSON.parse(raw) as Array<[string, { x: number; y: number }]>) : []);
  } catch {
    return new Map();
  }
};
const writePositions = (key: string, positions: Map<string, { x: number; y: number }>): void => {
  try {
    window.localStorage.setItem(key, JSON.stringify([...positions]));
  } catch {
    /* sin almacenamiento: las posiciones solo duran la sesión */
  }
};

function CanvasInner({ moduleId, spec, document, text, viewId, views, onView, readOnly, history, onText, notify, focusId, links, onBack, onSelect, onOpenAttachment, compare }: DiagramCanvasProps) {
  const flow = useReactFlow();
  const key = positionsKey(moduleId, viewId);
  const [moved, setMoved] = useState(() => readPositions(key));
  const [layout, setLayout] = useState<GraphLayout | undefined>();
  const [selection, setSelection] = useState<Selection>(NO_SELECTION);
  const [prompting, setPrompting] = useState<{ id: string; initial: string } | undefined>();
  // Los tipos derivados (`addable: false`, p. ej. la relación implícita de C4) se dibujan pero no se ofrecen para crear relaciones.
  const addableEdges = useMemo(() => spec.edgeKinds.filter((k) => k.addable !== false), [spec]);
  const [edgeKind, setEdgeKind] = useState(spec.defaultEdgeKind ?? addableEdges[0]?.kind ?? spec.edgeKinds[0]?.kind ?? '');
  const [showKeys, setShowKeys] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const boxSelecting = useRef(false);

  const graph = useMemo(() => (document === undefined ? undefined : spec.project(document, viewId)), [spec, document, viewId]);

  // Las variantes de una vista (la misma vista coloreada por otro criterio) no van en «Vista»: tienen su propio selector.
  const current = views.find((v) => v.id === (viewId ?? views[0]?.id));
  const baseViewId = current?.variantOf ?? current?.id ?? '';
  const mainViews = views.filter((v) => !v.variantOf);
  const variants = baseViewId ? views.filter((v) => v.id === baseViewId || v.variantOf === baseViewId) : [];
  const variantsLabel = variants.find((v) => v.variantsLabel)?.variantsLabel ?? 'Colorear por';
  const signature = graph ? structureKey(graph) : '';

  const selectedIds = useMemo(() => resolveSelection(graph, selection), [graph, selection]);
  const selectionKey = selectedIds.join('\u0000');
  const single = selectedIds.length === 1 ? selectedIds[0] : undefined;
  useEffect(() => {
    onSelect?.(single);
  }, [single, onSelect]);
  useEffect(() => {
    setSelection((current) => (resolveSelection(graph, current).length === current.size ? current : new Set(resolveSelection(graph, current))));
  }, [graph]);
  useEffect(() => {
    setPrompting(undefined);
  }, [selectionKey, key]);

  // Qué estructura (módulo + vista + grafo) tiene ya su autolayout aplicado, y para qué vista terminó el primer encuadre.
  // Se comparan al renderizar, no en un efecto, así que en cuanto la estructura cambia el lienzo deja de estar «asentado».
  // Al cambiar de módulo o de vista se encuadra el dibujo una vez que ELK lo haya colocado; después la cámara no se toca.
  const [laidFor, setLaidFor] = useState('');
  const [fittedFor, setFittedFor] = useState('');
  // Estructura cuyo autolayout falló (ELK rechazó o la colocación propia del módulo lanzó): se avisa y el lienzo se asienta igual.
  const [failedFor, setFailedFor] = useState('');
  const layoutKey = `${key}\u0000${signature}`;
  const layoutKeyRef = useRef(layoutKey);
  layoutKeyRef.current = layoutKey;
  const keyRef = useRef(key);
  keyRef.current = key;
  // Vista (módulo + vista) a la que pertenece el `layout` guardado: solo se conserva tras un fallo si sigue siendo la misma vista.
  const layoutOwner = useRef('');
  const settled = laidFor === layoutKey && fittedFor === key;
  useEffect(() => {
    setMoved(readPositions(key));
    setSelection(NO_SELECTION);
    setFittedFor('');
  }, [key]);

  // El autolayout solo se recalcula cuando cambia la estructura, no al editar un texto de propiedades.
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const documentRef = useRef(document);
  documentRef.current = document;
  const layoutSeq = useRef(0);
  const relayout = useCallback(async (fresh = false) => {
    const g = graphRef.current;
    if (!g) return;
    const seq = ++layoutSeq.current;
    const wanted = layoutKeyRef.current;
    const forKey = keyRef.current;
    const apply = (result: GraphLayout): void => {
      if (seq !== layoutSeq.current) return;
      layoutOwner.current = forKey;
      setLayout(result);
      setFailedFor('');
      setLaidFor(wanted);
    };
    // Si la colocación falla no se deja el lienzo colgado en «pending»: se conserva el dibujo que ya hubiera de esta misma
    // vista (o, sin él, el de reserva de `buildFlow`: cuadrícula, con las posiciones arrastradas a mano por encima), se da la
    // estructura por colocada y se avisa. Un fallo de un autolayout que ya no es el último (otra vista, otra estructura) se ignora.
    const fail = (): void => {
      if (seq !== layoutSeq.current) return;
      const keep = layoutOwner.current === forKey;
      setLayout((previous) => (keep && previous ? previous : EMPTY_LAYOUT));
      layoutOwner.current = forKey;
      setFailedFor(wanted);
      setLaidFor(wanted);
    };
    try {
      const own = spec.layout && documentRef.current !== undefined ? await spec.layout(documentRef.current, viewId, fresh ? { fresh: true } : undefined) : undefined;
      if (own) return apply(own);
      const kinds = new Map(spec.nodeKinds.map((k) => [k.kind, k]));
      const parents = new Set(g.nodes.filter((n) => n.parentId).map((n) => n.parentId as string));
      const result = await layoutGraph(
        g.nodes.filter((n) => !parents.has(n.id)).map((n) => ({ id: n.id, width: n.width ?? kinds.get(n.kind)?.width ?? 180, height: n.height ?? kinds.get(n.kind)?.height ?? 72, groupId: n.parentId })),
        g.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, label: layoutLabelText(e) })),
        g.nodes.filter((n) => parents.has(n.id)).map((n) => ({ id: n.id, groupId: n.parentId })),
        { direction: 'RIGHT' },
      );
      apply(result);
    } catch {
      fail();
    }
  }, [spec, viewId]);
  useEffect(() => {
    void relayout();
  }, [signature, relayout]);
  // Al desmontar, un autolayout en vuelo (ELK tarda) deja de ser el último: su respuesta tardía no toca el estado de un lienzo que ya no está.
  useEffect(
    () => () => {
      layoutSeq.current++;
    },
    [],
  );

  const built = useMemo(() => (graph ? buildFlow(spec, graph, layout, moved) : { nodes: [] as FlowNode[], edges: [] as FlowEdge[] }), [spec, graph, layout, moved]);
  const builtRef = useRef(built);
  builtRef.current = built;

  const pick = useCallback((id: string, additive: boolean) => setSelection((current) => (additive ? toggleSelected(current, id) : new Set([id]))), []);
  // Al comparar versiones, las marcas van en los datos de cada nodo y arista, y lo quitado se añade como fantasmas bajo el dibujo.
  const marks = compare?.marks;
  const ghosts = useMemo(() => (compare && graph && compare.removed.size > 0 ? removedNodes(spec, compare.base, viewId, compare.removed, graph) : []), [compare, graph, spec, viewId]);
  const nodes = useMemo(() => {
    const placed = built.nodes.map((n) => {
      const diff = marks?.get(n.id);
      return { ...n, selected: selection.has(n.id), ...(diff ? { data: { ...n.data, diff } } : {}) };
    });
    return ghosts.length > 0 ? [...placed, ...ghostNodes(spec, ghosts, built.nodes)] : placed;
  }, [built.nodes, selection, marks, ghosts, spec]);
  const edges = useMemo(
    () => built.edges.map((e) => ({ ...e, selected: selection.has(e.id), data: { ...e.data, onPick: pick, ...(marks?.get(e.id) ? { diff: marks.get(e.id) } : {}) } })),
    [built.edges, selection, pick, marks],
  );

  // La cámara cuenta como asentada al acabar la animación o, si React Flow la interrumpe sin avisar, poco después. Ese plazo de
  // reserva es un temporizador que sobrevive al lienzo: si éste se desmonta con un encuadre en curso, el plazo (o el final tardío
  // de la animación) no debe tocar el estado de un componente que ya no existe —en pruebas, tras destruirse jsdom, lanzaba
  // «window is not defined» sin captura—. Al desmontar se cancelan los plazos pendientes y se ignoran los finales tardíos.
  const mounted = useRef(true);
  const settleTimers = useRef(new Set<number>());
  useEffect(() => {
    mounted.current = true;
    const timers = settleTimers.current;
    return () => {
      mounted.current = false;
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
    };
  }, []);
  const settleCamera = useCallback((fit: Promise<unknown>, duration: number, forKey: string): void => {
    const timers = settleTimers.current;
    let timer = 0;
    const deadline = new Promise((resolve) => {
      timer = window.setTimeout(resolve, duration + 300);
      timers.add(timer);
    });
    const done = (): void => {
      if (!mounted.current) return; // el desmontaje ya canceló el plazo: no se toca `window` ni el estado
      window.clearTimeout(timer);
      timers.delete(timer);
      setFittedFor(forKey);
    };
    void Promise.race([fit, deadline]).then(done, done);
  }, []);

  // Se encuadra cuando el autolayout aplicado es el de la estructura que se está viendo y la vista aún no se encuadró. Esa
  // condición se lee del estado y no de una marca mutable: un encuadre programado para la vista anterior se cancela al cambiar
  // de vista (`key` está en las dependencias) y un autolayout ajeno (el de la vista anterior, que sigue en `layout` hasta que
  // llega el nuevo) nunca se encuadra como si fuera el de la vista actual.
  const layoutReady = layout !== undefined && laidFor === layoutKey;
  useEffect(() => {
    if (!layoutReady || fittedFor === key) return;
    const timer = window.setTimeout(() => {
      // El retardo deja que React Flow mida los nodos nuevos; si antes cambia el autolayout o la vista, este efecto se cancela y el siguiente encuadra.
      const targets = focusId && graph ? focusNodes(graph, focusId) : [];
      if (focusId && targets.length > 0) {
        setSelection(new Set([focusId]));
        settleCamera(flow.fitView({ nodes: targets.map((id) => ({ id })), padding: 1.2, duration: 250, maxZoom: 1 }), 250, key);
      } else settleCamera(flow.fitView({ padding: 0.15, duration: 200, maxZoom: 1 }), 200, key);
    }, 60);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutReady, layout, key, fittedFor, flow]);

  // Foco pedido cuando la vista ya está colocada (p. ej. desde «Referenciado por» dentro del mismo módulo).
  useEffect(() => {
    const targets = focusId && graph ? focusNodes(graph, focusId) : [];
    if (!focusId || !layout || targets.length === 0) return;
    setSelection(new Set([focusId]));
    const timer = window.setTimeout(() => void flow.fitView({ nodes: targets.map((id) => ({ id })), padding: 1.2, duration: 250, maxZoom: 1 }), 60);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);

  const follow = useCallback(
    (id: string | undefined): void => {
      const ref = id ? graph?.nodes.find((n) => n.id === id)?.ref : undefined;
      if (!ref) return notify('El elemento seleccionado no enlaza con ningún otro módulo.');
      if (!links) return notify('Este banco de trabajo no puede seguir enlaces.');
      links.follow(ref);
    },
    [graph, links, notify],
  );

  // Una operación que solo navega (bajar al detalle de un sistema, subir de nivel) devuelve el mismo documento: no es una edición y no
  // entra en el historial de deshacer. Si pide abrir otra vista (`view`), se abre tras aplicar el documento, que ya la contiene.
  const commit = useCallback(
    (result: EditResult<unknown>): string | undefined => {
      if (!result.ok) {
        notify(result.reason);
        return undefined;
      }
      if (result.document !== document) {
        history.record(text);
        onText(pretty(result.document));
      }
      if (result.view && result.view !== viewId) onView(result.view);
      return result.id;
    },
    [document, history, notify, onText, onView, text, viewId],
  );

  const addNode = (kind: string): void => {
    if (readOnly || document === undefined) return;
    const label = spec.nodeKinds.find((k) => k.kind === kind)?.label ?? kind;
    const parentNode = single ? graph?.nodes.find((n) => n.id === single) : undefined;
    const id = commit(spec.addNode(document, kind, `${label} nuevo`, parentNode?.id, viewId));
    if (!id) return;
    const rect = wrapper.current?.getBoundingClientRect();
    const center = flow.screenToFlowPosition({ x: (rect?.left ?? 0) + (rect?.width ?? 400) / 2 + Math.random() * 60 - 30, y: (rect?.top ?? 0) + (rect?.height ?? 300) / 2 + Math.random() * 60 - 30 });
    const next = new Map(moved).set(id, { x: Math.round(center.x - 90), y: Math.round(center.y - 36) });
    setMoved(next);
    writePositions(key, next);
    setSelection(new Set([id]));
  };

  const onConnect = (c: Connection): void => {
    if (readOnly || document === undefined || !c.source || !c.target) return;
    const why = spec.canConnect?.(document, edgeKind, c.source, c.target, viewId);
    if (why) return notify(why);
    const id = commit(spec.addEdge(document, edgeKind, c.source, c.target));
    if (id) setSelection(new Set([id]));
  };

  const remove = useCallback(
    (ids: readonly string[]): void => {
      if (readOnly || document === undefined || ids.length === 0) return;
      const result = removeAll(spec, document, ids);
      if (!result.ok) return notify(result.reason);
      commit(result);
      setSelection(NO_SELECTION);
    },
    [commit, document, notify, readOnly, spec],
  );

  const patch = (id: string, values: Record<string, unknown>): void => {
    if (document !== undefined) commit(spec.update(document, id, values));
  };

  const selectedItems = useMemo(() => (graph && selectedIds.length > 1 ? describeSelection(spec, graph, selectedIds) : undefined), [spec, graph, selectedIds]);

  const actions = spec.actions ?? [];
  const availability = useMemo(() => (document === undefined ? [] : actions.map((a) => actionAvailability(a, document, selectedIds, readOnly, viewId))), [actions, document, selectedIds, readOnly, viewId]);
  const runAction = (action: (typeof actions)[number], input?: string): void => {
    setPrompting(undefined);
    if (!readOnly && document !== undefined) commit(action.run(document, selectedIds, input, viewId));
  };
  const startAction = (action: (typeof actions)[number]): void => {
    if (!action.prompt) return runAction(action);
    setPrompting({ id: action.id, initial: document === undefined ? '' : (action.prompt.initial?.(document, selectedIds, viewId) ?? '') });
  };
  const prompted = actions.find((a) => a.id === prompting?.id);
  // Alt+↓ y Alt+↑ sin otro significado (no hay enlace que seguir ni diagrama al que volver) lanzan la acción del módulo que los reclama
  // (`shortcut`): así C4 baja y sube de nivel. Se guarda en una referencia para que el oyente del teclado no dependa de cada render.
  const shortcutRef = useRef<(key: 'alt+down' | 'alt+up') => boolean>(() => false);
  shortcutRef.current = (key) => {
    const i = actions.findIndex((a) => a.shortcut === key);
    if (i < 0 || !availability[i]?.enabled) return false;
    startAction(actions[i]);
    return true;
  };

  const undo = useCallback(() => {
    const previous = history.undo(text);
    if (previous !== undefined) onText(previous);
  }, [history, onText, text]);
  const redo = useCallback(() => {
    const next = history.redo(text);
    if (next !== undefined) onText(next);
  }, [history, onText, text]);
  const autoLayout = useCallback(() => {
    setMoved(new Map());
    writePositions(key, new Map());
    setLaidFor('');
    setFailedFor('');
    setFittedFor('');
    // Al llegar el nuevo autolayout, el efecto de encuadre recoloca la cámara (la vista vuelve a estar sin encuadrar).
    void relayout(true);
  }, [key, relayout]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      const action = matchShortcut(e, typing);
      if (!action) return;
      e.preventDefault();
      if (action === 'undo') undo();
      else if (action === 'redo') redo();
      else if (action === 'delete') remove(selectedIds);
      else if (action === 'layout') autoLayout();
      else if (action === 'fit') void flow.fitView({ padding: 0.15, duration: 250 });
      else if (action === 'deselect') setSelection(NO_SELECTION);
      else if (action === 'follow') {
        const linked = !!single && !!graph?.nodes.find((n) => n.id === single)?.ref;
        if (linked || !shortcutRef.current('alt+down')) follow(single);
      } else if (action === 'back') {
        if (onBack) onBack();
        else shortcutRef.current('alt+up');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [autoLayout, flow, follow, graph, onBack, redo, remove, selectedIds, single, undo]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setSelection((current) => applySelectionChanges(current, changes));
    const dragged = changes.flatMap((c) => (c.type === 'position' && c.position ? [{ id: c.id, position: c.position }] : []));
    if (dragged.length > 0) setMoved((current) => movedByDrag(builtRef.current.nodes, current, dragged));
  }, []);
  // El recuadro de React Flow selecciona también las relaciones de lo que encierra; aquí solo cuentan los elementos.
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    if (!boxSelecting.current) setSelection((current) => applySelectionChanges(current, changes));
  }, []);

  const startBox = (): void => {
    boxSelecting.current = true;
    const end = new AbortController();
    const stop = (): void => {
      boxSelecting.current = false;
      end.abort();
    };
    window.addEventListener('pointerup', stop, { signal: end.signal });
    window.addEventListener('pointercancel', stop, { signal: end.signal });
  };

  const onDragStop = (_event?: unknown, dragged?: { id: string }): void => {
    if (dragged && !readOnly && document !== undefined && spec.drop) {
      const nodes = builtRef.current.nodes;
      const target = dropTarget(nodes, new Map(nodes.map((n) => [n.id, { width: n.width, height: n.height }])), dragged.id);
      const result = target ? spec.drop(document, dragged.id, target, viewId) : undefined;
      if (result) {
        // Con efecto (o rechazado), la vista se recoloca: se sueltan las posiciones fijadas a mano.
        setMoved(new Map());
        writePositions(key, new Map());
        // Queda seleccionado el elemento que devuelve el módulo: el arrastrado o, si el efecto fue moverlo a otro sitio (una celda de la matriz), el destino.
        const id = commit(result);
        if (id) setSelection(new Set([id]));
        return;
      }
    }
    const next = new Map([...absolutePositions(builtRef.current.nodes)].map(([id, at]) => [id, { x: Math.round(at.x), y: Math.round(at.y) }] as const));
    setMoved(next);
    writePositions(key, next);
  };

  if (document === undefined) {
    return (
      <div className="cv-empty" role="status">
        El documento no es válido: corrígelo en la pestaña JSON para volver a editarlo en el lienzo.
      </div>
    );
  }

  return (
    <div className="cv-root" ref={wrapper} data-testid="module-canvas" data-view={viewId ?? ''} data-layout={settled ? 'ready' : 'pending'}>
      <div className="cv-toolbar" role="toolbar" aria-label="Herramientas del lienzo">
        {mainViews.length > 1 && (
          <>
            <label className="cv-edge-kind">
              Vista
              <select value={baseViewId} onChange={(e) => onView(e.target.value)} data-testid="canvas-view">
                {mainViews.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.title}
                  </option>
                ))}
              </select>
            </label>
            <span className="cv-sep" />
          </>
        )}
        {variants.length > 1 && (
          <>
            <label className="cv-edge-kind">
              {variantsLabel}
              <select value={current?.id ?? ''} onChange={(e) => onView(e.target.value)} data-testid="canvas-variant">
                {variants.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.variantLabel ?? v.title}
                  </option>
                ))}
              </select>
            </label>
            <span className="cv-sep" />
          </>
        )}
        <div className="cv-group-tools" aria-label="Añadir">
          {spec.nodeKinds
            .filter((k) => k.addable !== false)
            .map((k) => (
              <button key={k.kind} type="button" className="cv-tool" disabled={readOnly} title={`Añadir ${k.label.toLowerCase()}${single ? ' (dentro del contenedor seleccionado si encaja)' : ''}`} onClick={() => addNode(k.kind)} data-testid={`add-${k.kind}`}>
                <span className="cv-tool-shape" aria-hidden="true">
                  <ShapeSvg shape={k.shape} width={28} height={18} fill={k.fill} stroke={k.stroke} />
                </span>
                {k.label}
              </button>
            ))}
        </div>
        <span className="cv-sep" />
        {addableEdges.length > 1 && (
          <>
            <label className="cv-edge-kind">
              Relación
              <select value={edgeKind} onChange={(e) => setEdgeKind(e.target.value)} data-testid="edge-kind">
                {addableEdges.map((k) => (
                  <option key={k.kind} value={k.kind}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            <span className="cv-sep" />
          </>
        )}
        <button type="button" className="cv-tool" onClick={undo} disabled={!history.canUndo || readOnly} title="Deshacer (Ctrl+Z)" aria-label="Deshacer">
          ↶
        </button>
        <button type="button" className="cv-tool" onClick={redo} disabled={!history.canRedo || readOnly} title="Rehacer (Ctrl+Y)" aria-label="Rehacer">
          ↷
        </button>
        <button type="button" className="cv-tool" onClick={autoLayout} title="Autolayout (Ctrl+L)" data-testid="autolayout">
          Autolayout
        </button>
        <button type="button" className="cv-tool" onClick={() => void flow.fitView({ padding: 0.15, duration: 250 })} title="Ajustar a la ventana (0)">
          Ajustar
        </button>
        <button type="button" className="cv-tool" disabled={readOnly || selectedIds.length === 0} onClick={() => remove(selectedIds)} title="Borrar (Supr)" aria-label="Borrar selección">
          🗑
        </button>
        {actions.length > 0 && (
          <>
            <span className="cv-sep" />
            <div className="cv-group-tools" role="group" aria-label="Acciones sobre la selección">
              {actions.map((a, i) => (
                <button key={a.id} type="button" className="cv-tool" disabled={!availability[i]?.enabled} title={availability[i]?.title ?? a.label} aria-pressed={prompting?.id === a.id || undefined} onClick={() => startAction(a)} data-testid={`action-${a.id}`}>
                  {a.label}
                </button>
              ))}
            </div>
            <span className="cv-sep" />
          </>
        )}
        <button type="button" className="cv-tool" onClick={() => setShowKeys((s) => !s)} aria-pressed={showKeys} title="Atajos de teclado" aria-label="Atajos de teclado">
          ⌨
        </button>
      </div>

      {failedFor === layoutKey && (
        <div className="cv-notice" role="status" data-testid="canvas-layout-error">
          No se pudo calcular la colocación automática de este diagrama: los elementos se muestran en una colocación provisional. Puedes moverlos a mano o pulsar Autolayout para reintentarlo.
        </div>
      )}

      {prompted && prompting && <ActionPrompt key={prompted.id} action={prompted} document={document} viewId={viewId} initial={prompting.initial} onSubmit={(value) => runAction(prompted, value)} onCancel={() => setPrompting(undefined)} />}

      {showKeys && (
        <dl className="cv-keys" data-testid="shortcuts">
          {CANVAS_SHORTCUTS.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="cv-body">
        <div className="cv-flow">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            elementsSelectable
            multiSelectionKeyCode={['Control', 'Meta']}
            onSelectionStart={startBox}
            onNodeClick={(e, n) => {
              if (!e.ctrlKey && !e.metaKey && !e.shiftKey) setSelection((current) => (current.size > 1 && current.has(n.id) ? new Set([n.id]) : current));
            }}
            onNodeDoubleClick={(_, n) => {
              const edit = !readOnly && document !== undefined ? spec.activate?.(document, n.id, viewId) : undefined;
              if (edit) commit(edit);
              else follow(n.id);
            }}
            onPaneClick={() => setSelection(NO_SELECTION)}
            onConnect={onConnect}
            onNodeDragStop={(event, node) => onDragStop(event, node)}
            onSelectionDragStop={() => onDragStop()}
            deleteKeyCode={null}
            minZoom={0.1}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} />
            {graph?.legend && (
              <Panel position="top-left" className="cv-legend" data-testid="canvas-legend">
                <strong>{graph.legend.title}</strong>
                <ul>
                  {graph.legend.items.map((item) => (
                    <li key={item.label}>
                      <span className="cv-legend-swatch" style={{ background: item.color }} />
                      {item.label}
                    </li>
                  ))}
                </ul>
              </Panel>
            )}
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor={(n) => ((n.data as FlowNode['data']).node.fill ?? (n.data as FlowNode['data']).notation.fill)} />
          </ReactFlow>
        </div>
        <Inspector
          spec={spec}
          document={document}
          id={single ?? ''}
          selection={selectedItems}
          readOnly={readOnly}
          graph={graph}
          moduleId={moduleId}
          links={links}
          onPatch={patch}
          onRemove={(id) => remove([id])}
          onRemoveSelection={() => remove(selectedIds)}
          onPick={(id) => setSelection(new Set([id]))}
          onCommit={commit}
          onOpenAttachment={onOpenAttachment}
        />
      </div>
    </div>
  );
}

/** Lienzo interactivo común a todos los módulos que declaran `editor`. */
export function DiagramCanvas(props: DiagramCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
