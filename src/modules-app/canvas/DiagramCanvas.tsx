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
import { isAbortError, pretty, type EditResult, type EditorSpec, type GraphLayout } from '@iark/kernel';
import './canvas.css';
import { ActionPrompt } from './ActionPrompt';
import { autolayoutGraph } from './autolayout';
import { anunciarSeleccion, describirNodo, describirRelacion, indexarRelaciones } from '../a11y/etiquetas';
import { duracion } from '../a11y/movimiento';
import { desplazar, direccionDe, ETIQUETAS_LIENZO, vecinoEnDireccion, type Caja, type Direccion } from '../a11y/teclado';
import type { CanvasCompare } from '../compare';
import { absolutePositions, buildFlow, dropTarget, ghostNodes, movedByDrag, removedNodes, structureKey, type DiffMark, type FlowEdge, type FlowNode } from './flow';
import type { EditHistory } from './history';
import { ConnectForm } from './ConnectForm';
import { ElementList } from './ElementList';
import { Inspector, type LinkTools } from './Inspector';
import { NotationEdge } from './NotationEdge';
import { NotationNode } from './NotationNode';
import { actionAvailability, applySelectionChanges, describeSelection, focusNodes, NO_SELECTION, removeAll, resolveSelection, toggleSelected, type Selection } from './selection';
import { ShapeSvg } from './shapes';
import { CANVAS_SHORTCUTS, matchShortcut } from './shortcuts';
import { decorateEdges, decorateNodes, type EdgeCache, type NodeCache } from './stable';

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

/**
 * A partir de cuántos nodos el lienzo solo monta los que caen en pantalla (`onlyRenderVisibleElements`). Por debajo, montarlos todos
 * es lo más barato y deja cada nodo en el DOM (lectores de pantalla, tabulador); por encima, cada nodo cuesta decenas de elementos
 * del DOM y el lienzo se arrastra (ver docs/rendimiento.md). La selección, la comparación y los enlaces no dependen del DOM, así
 * que siguen funcionando con los nodos fuera de pantalla.
 */
export const CULL_FROM_NODES = 150;

/**
 * `?cull=on` / `?cull=off` en la dirección fuerzan el recorte con cualquier tamaño (diagnóstico y comparación en docs/rendimiento.md;
 * las pruebas con jsdom que necesitan todos los nodos en el DOM, como la matriz de cientos de celdas, lo apagan). Sin él, decide el tamaño.
 */
export function cullSetting(search: string = typeof window === 'undefined' ? '' : window.location.search): 'auto' | 'on' | 'off' {
  const value = new URLSearchParams(search).get('cull');
  return value === 'on' || value === 'off' ? value : 'auto';
}

/** Cuánto tarda un cálculo antes de que el lienzo avise de que está calculando (evita el parpadeo en los diagramas pequeños). */
const BUSY_AFTER_MS = 400;

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

/** Paso, en píxeles del lienzo, de Mayús + flecha al mover un elemento con el teclado. */
const PASO_TECLADO = 10;

/** Cajas absolutas de los nodos, para la navegación con flechas. */
function boxesOf(nodes: readonly FlowNode[]): Caja[] {
  const absolute = absolutePositions(nodes);
  return nodes.flatMap((n) => {
    const at = absolute.get(n.id);
    return at ? [{ id: n.id, x: at.x, y: at.y, width: n.width, height: n.height }] : [];
  });
}

function CanvasInner({ moduleId, spec, document, text, viewId, views, onView, readOnly, history, onText, notify, focusId, links, onBack, onSelect, onOpenAttachment, compare }: DiagramCanvasProps) {
  const reactFlow = useReactFlow();
  // Con «reducir movimiento» (WCAG 2.3.3) los encuadres de la cámara no se animan.
  const flow = useMemo(() => ({ ...reactFlow, fitView: (options?: Parameters<typeof reactFlow.fitView>[0]) => reactFlow.fitView(options ? { ...options, duration: duracion(options.duration ?? 0) } : options) }), [reactFlow]);
  const key = positionsKey(moduleId, viewId);
  const [moved, setMoved] = useState(() => readPositions(key));
  const [layout, setLayout] = useState<GraphLayout | undefined>();
  const [selection, setSelection] = useState<Selection>(NO_SELECTION);
  const [prompting, setPrompting] = useState<{ id: string; initial: string } | undefined>();
  // Los tipos derivados (`addable: false`, p. ej. la relación implícita de C4) se dibujan pero no se ofrecen para crear relaciones.
  const addableEdges = useMemo(() => spec.edgeKinds.filter((k) => k.addable !== false), [spec]);
  const [edgeKind, setEdgeKind] = useState(spec.defaultEdgeKind ?? addableEdges[0]?.kind ?? spec.edgeKinds[0]?.kind ?? '');
  const [showKeys, setShowKeys] = useState(false);
  const [showList, setShowList] = useState(false);
  /** Texto de la región `aria-live`: qué quedó seleccionado, qué se movió. */
  const [announcement, setAnnouncement] = useState('');
  const wrapper = useRef<HTMLDivElement>(null);
  const boxSelecting = useRef(false);

  const graph = useMemo(() => (document === undefined ? undefined : spec.project(document, viewId)), [spec, document, viewId]);

  // Las variantes de una vista (la misma vista coloreada por otro criterio) no van en «Vista»: tienen su propio selector.
  const current = views.find((v) => v.id === (viewId ?? views[0]?.id));
  const baseViewId = current?.variantOf ?? current?.id ?? '';
  const mainViews = views.filter((v) => !v.variantOf);
  const variants = baseViewId ? views.filter((v) => v.id === baseViewId || v.variantOf === baseViewId) : [];
  const variantsLabel = variants.find((v) => v.variantsLabel)?.variantsLabel ?? 'Colorear por';
  const signature = useMemo(() => (graph ? structureKey(graph) : ''), [graph]);

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
  // Estructura cuyo cálculo canceló la persona con «Cancelar»: se avisa y el lienzo se asienta con la colocación provisional.
  const [cancelledFor, setCancelledFor] = useState('');
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
  // El cálculo en marcha: se aborta al lanzar otro (lo que ya no hace falta no compite por el hilo de trabajo), al cancelar y al desmontar.
  const layoutAbort = useRef<AbortController | undefined>(undefined);
  const relayout = useCallback(async (fresh = false) => {
    const g = graphRef.current;
    if (!g) return;
    const seq = ++layoutSeq.current;
    layoutAbort.current?.abort();
    const abort = new AbortController();
    layoutAbort.current = abort;
    const wanted = layoutKeyRef.current;
    const forKey = keyRef.current;
    const apply = (result: GraphLayout): void => {
      if (seq !== layoutSeq.current) return;
      layoutOwner.current = forKey;
      setLayout(result);
      setFailedFor('');
      setCancelledFor('');
      setLaidFor(wanted);
    };
    // Si la colocación falla o se cancela no se deja el lienzo colgado en «pending»: se conserva el dibujo que ya hubiera de esta misma
    // vista (o, sin él, el de reserva de `buildFlow`: cuadrícula, con las posiciones arrastradas a mano por encima), se da la
    // estructura por colocada y se avisa. Un fallo de un autolayout que ya no es el último (otra vista, otra estructura) se ignora.
    const settleWithoutLayout = (): void => {
      const keep = layoutOwner.current === forKey;
      setLayout((previous) => (keep && previous ? previous : EMPTY_LAYOUT));
      layoutOwner.current = forKey;
      setLaidFor(wanted);
    };
    try {
      apply(await autolayoutGraph(spec, documentRef.current, g, viewId, { signal: abort.signal, fresh }));
    } catch (error) {
      if (seq !== layoutSeq.current) return;
      settleWithoutLayout();
      // Abortado y todavía el último: lo canceló la persona (los abortos por un cálculo nuevo o por desmontar ya no son el último).
      if (isAbortError(error)) {
        setCancelledFor(wanted);
        setFailedFor('');
      } else {
        setFailedFor(wanted);
        setCancelledFor('');
      }
    }
  }, [spec, viewId]);
  useEffect(() => {
    void relayout();
  }, [signature, relayout]);
  // Al desmontar, un autolayout en vuelo (ELK tarda) deja de ser el último y se corta: su respuesta tardía no toca el estado de un lienzo que ya no está.
  useEffect(
    () => () => {
      layoutSeq.current++;
      layoutAbort.current?.abort();
    },
    [],
  );
  const cancelLayout = useCallback(() => layoutAbort.current?.abort(), []);

  // El estado «calculando»: se muestra si el cálculo pasa de BUSY_AFTER_MS, para no parpadear en los diagramas pequeños.
  const calculating = laidFor !== layoutKey && document !== undefined;
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!calculating) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), BUSY_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [calculating, layoutKey]);

  const built = useMemo(() => (graph ? buildFlow(spec, graph, layout, moved) : { nodes: [] as FlowNode[], edges: [] as FlowEdge[] }), [spec, graph, layout, moved]);
  const builtRef = useRef(built);
  builtRef.current = built;

  const pick = useCallback((id: string, additive: boolean) => setSelection((current) => (additive ? toggleSelected(current, id) : new Set([id]))), []);
  // Al comparar versiones, las marcas van en los datos de cada nodo y arista, y lo quitado se añade como fantasmas bajo el dibujo.
  const marks = compare?.marks;
  const ghosts = useMemo(() => (compare && graph && compare.removed.size > 0 ? removedNodes(spec, compare.base, viewId, compare.removed, graph) : []), [compare, graph, spec, viewId]);
  // Nombres accesibles (WCAG 4.1.2): tipo, nombre y relaciones de cada nodo; de dónde a dónde va cada relación.
  const relations = useMemo(() => (graph ? indexarRelaciones(graph) : undefined), [graph]);
  const nodeLabels = useMemo(() => (relations ? { key: relations, of: (n: FlowNode, diff: DiffMark | undefined) => describirNodo(n.data.node, n.data.notation, relations, diff) } : undefined), [relations]);
  const edgeLabels = useMemo(() => (relations ? { key: relations, of: (e: FlowEdge, diff: DiffMark | undefined) => describirRelacion(e.data.edge, e.data.notation, relations, diff as 'added' | 'modified' | undefined) } : undefined), [relations]);
  // Los objetos que se entregan a React Flow conservan su identidad mientras no cambie lo que dibujan (ver `stable.ts`): seleccionar
  // un nodo o arrastrar otro solo repinta esos, no los cientos que hay montados.
  const nodeCache = useRef(new Map<string, NodeCache>());
  const edgeCache = useRef(new Map<string, EdgeCache>());
  const nodes = useMemo(() => {
    const placed = decorateNodes(built.nodes, selection, marks, nodeCache.current, nodeLabels);
    if (ghosts.length === 0) return placed;
    return [...placed, ...ghostNodes(spec, ghosts, built.nodes).map((g) => ({ ...g, ...(relations ? { ariaLabel: describirNodo(g.data.node, g.data.notation, relations, 'removed') } : {}) }))];
  }, [built.nodes, selection, marks, ghosts, spec, relations, nodeLabels]);
  const edges = useMemo(() => decorateEdges(built.edges, selection, pick, marks, edgeCache.current, edgeLabels), [built.edges, selection, pick, marks, edgeLabels]);
  const cullChoice = useMemo(() => cullSetting(), []);
  const cull = cullChoice === 'auto' ? nodes.length >= CULL_FROM_NODES : cullChoice === 'on';

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
    const result = spec.addNode(document, kind, `${label} nuevo`, parentNode?.id, viewId);
    const id = commit(result);
    if (!id) return;
    // Un nodo que nace dentro de una zona (un contenedor C4 en el límite de su sistema) no se coloca a mano en el centro de la
    // pantalla, donde quedaría fuera de ella: lo coloca el autolayout dentro de su zona.
    const inGroup = result.ok && !!spec.project(result.document, viewId).nodes.find((n) => n.id === id)?.parentId;
    if (!inGroup) {
      const rect = wrapper.current?.getBoundingClientRect();
      const center = flow.screenToFlowPosition({ x: (rect?.left ?? 0) + (rect?.width ?? 400) / 2 + Math.random() * 60 - 30, y: (rect?.top ?? 0) + (rect?.height ?? 300) / 2 + Math.random() * 60 - 30 });
      const next = new Map(moved).set(id, { x: Math.round(center.x - 90), y: Math.round(center.y - 36) });
      setMoved(next);
      writePositions(key, next);
    }
    setSelection(new Set([id]));
  };

  const onConnect = (c: Connection): void => {
    if (readOnly || document === undefined || !c.source || !c.target) return;
    const why = spec.canConnect?.(document, edgeKind, c.source, c.target, viewId);
    if (why) return notify(why);
    const id = commit(spec.addEdge(document, edgeKind, c.source, c.target));
    if (id) setSelection(new Set([id]));
  };

  /**
   * Pasa el foco del teclado a un elemento (nodo o relación). Si el lienzo no lo dibuja porque está fuera de la pantalla, primero lleva la
   * vista hasta él y espera a que se dibuje: el foco debe poder llegar a todos los elementos, también a los que no se ven.
   */
  const focusElement = useCallback(
    (id: string): void => {
      const find = (): HTMLElement | undefined => [...(wrapper.current?.querySelectorAll<HTMLElement>('.react-flow__node, .react-flow__edge') ?? [])].find((el) => el.dataset.id === id);
      const now = find();
      if (now) return now.focus();
      const current = graphRef.current;
      const targets = current ? focusNodes(current, id) : [];
      if (targets.length > 0) void flow.fitView({ nodes: targets.map((t) => ({ id: t })), padding: 1.2, duration: 0, maxZoom: 1 });
      let tries = 0;
      const timer = window.setInterval(() => {
        const el = find();
        if (el || ++tries > 20 || !mounted.current) {
          window.clearInterval(timer);
          settleTimers.current.delete(timer);
          el?.focus();
        }
      }, 50);
      settleTimers.current.add(timer);
    },
    [flow],
  );

  // Dónde se queda el foco cuando el elemento enfocado desaparece (WCAG 2.4.3): en un vecino que siga ahí, o en la barra de herramientas.
  const refocusAfter = useCallback(
    (removed: readonly string[]): void => {
      const boxes = boxesOf(builtRef.current.nodes).filter((b) => !removed.includes(b.id));
      const from = boxesOf(builtRef.current.nodes).find((b) => removed.includes(b.id));
      let next: string | undefined;
      if (from) for (const d of ['right', 'left', 'down', 'up'] as const) next ??= vecinoEnDireccion([from, ...boxes], from.id, d);
      next ??= boxes[0]?.id;
      window.setTimeout(() => {
        if (!mounted.current) return;
        const active = window.document.activeElement;
        if (active && active !== window.document.body && wrapper.current?.contains(active) && !(active as HTMLButtonElement).disabled) return;
        if (next) focusElement(next);
        else wrapper.current?.querySelector<HTMLElement>('.cv-toolbar button:not(:disabled), .cv-toolbar select')?.focus();
      }, 80);
    },
    [focusElement],
  );
  const remove = useCallback(
    (ids: readonly string[]): void => {
      if (readOnly || document === undefined || ids.length === 0) return;
      const result = removeAll(spec, document, ids);
      if (!result.ok) return notify(result.reason);
      commit(result);
      setSelection(NO_SELECTION);
      setAnnouncement(ids.length === 1 ? 'Elemento borrado.' : `${ids.length} elementos borrados.`);
      refocusAfter(ids);
    },
    [commit, document, notify, readOnly, refocusAfter, spec],
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
    setCancelledFor('');
    setFittedFor('');
    // Al llegar el nuevo autolayout, el efecto de encuadre recoloca la cámara (la vista vuelve a estar sin encuadrar).
    void relayout(true);
  }, [key, relayout]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      // Escape en el panel de propiedades devuelve el foco al elemento que se estaba editando (sin soltar la selección).
      if (e.key === 'Escape' && single && target instanceof Element && target.closest('.cv-inspector')) {
        e.preventDefault();
        focusElement(single);
        return;
      }
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
  }, [autoLayout, flow, focusElement, follow, graph, onBack, redo, remove, selectedIds, single, undo]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setSelection((current) => applySelectionChanges(current, changes));
    const dragged = changes.flatMap((c) => (c.type === 'position' && c.position ? [{ id: c.id, position: c.position }] : []));
    if (dragged.length > 0) setMoved((current) => movedByDrag(builtRef.current.nodes, current, dragged));
  }, []);
  // El recuadro de React Flow selecciona también las relaciones de lo que encierra; aquí solo cuentan los elementos.
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    if (!boxSelecting.current) setSelection((current) => applySelectionChanges(current, changes));
  }, []);

  // Cada cambio de la selección se anuncia (región aria-live): quien no ve el dibujo no sabe, si no, qué quedó seleccionado.
  const announcedFor = useRef('');
  useEffect(() => {
    if (!graph || announcedFor.current === selectionKey) return;
    const first = announcedFor.current === '';
    announcedFor.current = selectionKey;
    if (first && selectedIds.length === 0) return;
    setAnnouncement(anunciarSeleccion(describeSelection(spec, graph, selectedIds).map((s) => `${s.kind} ${s.title}`)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey]);

  const focusInspector = (): void => {
    const field = wrapper.current?.querySelector<HTMLElement>('.cv-inspector input:not([disabled]), .cv-inspector select:not([disabled]), .cv-inspector textarea:not([disabled]), .cv-inspector button:not([disabled])');
    (field ?? wrapper.current?.querySelector<HTMLElement>('.cv-inspector'))?.focus();
  };

  const moveFromKeyboard = (id: string, direction: Direccion): void => {
    if (readOnly) return setAnnouncement('Este diagrama es de solo lectura: no se pueden mover los elementos.');
    const ids = selection.has(id) ? [...selection].filter((s) => builtRef.current.nodes.some((n) => n.id === s)) : [id];
    const changes = ids.flatMap((moving) => {
      const node = builtRef.current.nodes.find((n) => n.id === moving);
      return node ? [{ id: moving, position: desplazar(node.position, direction, PASO_TECLADO) }] : [];
    });
    if (changes.length === 0) return;
    const next = movedByDrag(builtRef.current.nodes, moved, changes);
    setMoved(next);
    writePositions(key, next);
    const names = ids.map((moving) => graph?.nodes.find((n) => n.id === moving)?.label ?? moving);
    setAnnouncement(`${names.length === 1 ? names[0] : `${names.length} elementos`} movido ${{ left: 'a la izquierda', right: 'a la derecha', up: 'arriba', down: 'abajo' }[direction]}.`);
  };

  /**
   * Teclado sobre un nodo o una relación enfocados (WCAG 2.1.1): flechas para ir al vecino, Mayús + flechas para moverlo, Intro o F2 para
   * abrir sus propiedades y Supr para borrarlo aunque no esté seleccionado. Se atiende en la fase de captura para que React Flow no
   * mueva el nodo con las flechas sin más, y solo cuando el foco está en el propio elemento (no en un campo de su interior).
   */
  const onFlowKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const holder = (e.target as HTMLElement).closest<HTMLElement>('.react-flow__node, .react-flow__edge');
    if (!holder || holder !== e.target || e.ctrlKey || e.metaKey || e.altKey) return;
    const id = holder.dataset.id;
    if (!id || id.startsWith('ghost:')) return;
    const handled = (): void => {
      e.preventDefault();
      e.stopPropagation();
    };
    const isNode = holder.classList.contains('react-flow__node');
    const direction = direccionDe(e.key);
    if (direction && isNode) {
      handled();
      if (e.shiftKey) moveFromKeyboard(id, direction);
      else {
        const next = vecinoEnDireccion(boxesOf(builtRef.current.nodes), id, direction);
        if (next) focusElement(next);
      }
    } else if (!e.shiftKey && (e.key === 'Enter' || e.key === 'F2')) {
      handled();
      setSelection(new Set([id]));
      window.setTimeout(focusInspector, 0);
    } else if (!e.shiftKey && (e.key === 'Delete' || e.key === 'Backspace') && !selection.has(id)) {
      handled();
      remove([id]);
    }
  };

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

  const crumbs = spec.breadcrumb?.(document, viewId) ?? [];

  return (
    <div className="cv-root" ref={wrapper} data-testid="module-canvas" data-view={viewId ?? ''} data-layout={settled ? 'ready' : 'pending'} data-culling={cull ? 'on' : 'off'}>
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
        <div className="cv-group-tools" role="group" aria-label="Añadir">
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
        <button type="button" className="cv-tool" onClick={() => setShowList((v) => !v)} aria-expanded={showList} aria-controls="cv-element-list" title="Lista de los elementos y relaciones del diagrama, para recorrerlos con teclado o lector de pantalla" data-testid="toggle-list">
          Lista
        </button>
        <button type="button" className="cv-tool" onClick={() => setShowKeys((s) => !s)} aria-pressed={showKeys} title="Atajos de teclado" aria-label="Atajos de teclado">
          ⌨
        </button>
      </div>

      <div className="wb-visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-testid="canvas-live">
        {announcement}
      </div>

      {showList && graph && (
        <div id="cv-element-list">
          <ElementList
            spec={spec}
            graph={graph}
            selected={selection}
            onGo={(id) => {
              setSelection(new Set([id]));
              focusElement(id);
            }}
            onClose={() => {
              setShowList(false);
              window.setTimeout(() => wrapper.current?.querySelector<HTMLElement>('[data-testid="toggle-list"]')?.focus(), 0);
            }}
          />
        </div>
      )}

      {crumbs.length > 1 && (
        <nav className="cv-crumbs" aria-label="Niveles del diagrama" data-testid="canvas-breadcrumb">
          {crumbs.map((c, i) => {
            const current = i === crumbs.length - 1;
            return (
              <span key={c.id} className="cv-crumb-item">
                {i > 0 && <span className="cv-crumb-sep" aria-hidden="true">›</span>}
                <button type="button" className={current ? 'cv-crumb is-current' : 'cv-crumb'} aria-current={current ? 'page' : undefined} disabled={current} onClick={() => onView(c.id)} data-testid={`crumb-${c.id}`}>
                  {c.label}
                </button>
              </span>
            );
          })}
        </nav>
      )}

      {failedFor === layoutKey && (
        <div className="cv-notice" role="status" data-testid="canvas-layout-error">
          No se pudo calcular la colocación automática de este diagrama: los elementos se muestran en una colocación provisional. Puedes moverlos a mano o pulsar Autolayout para reintentarlo.
        </div>
      )}

      {cancelledFor === layoutKey && (
        <div className="cv-notice" role="status" data-testid="canvas-layout-cancelled">
          Se canceló el cálculo de la colocación automática: los elementos se muestran en una colocación provisional. Pulsa Autolayout para calcularla de nuevo.
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
        <div className="cv-flow" onKeyDownCapture={onFlowKeyDown}>
          {calculating && slow && (
            <div className="cv-busy" role="status" aria-live="polite" data-testid="canvas-busy">
              <span className="cv-busy-spinner" aria-hidden="true" />
              <span>Calculando la colocación de {nodes.length} elementos…</span>
              <button type="button" className="cv-tool" onClick={cancelLayout} data-testid="canvas-busy-cancel">
                Cancelar
              </button>
            </div>
          )}
          <ReactFlow
            aria-label={`Lienzo del diagrama: ${graph?.nodes.length ?? 0} elementos y ${graph?.edges.length ?? 0} relaciones. Tabulador para recorrer los elementos, flechas para ir al vecino, Intro para abrir las propiedades. Hay una lista de todos los elementos en el botón «Lista».`}
            ariaLabelConfig={ETIQUETAS_LIENZO}
            // Las relaciones no son paradas del tabulador (había que pasar por todas antes de llegar a los elementos): se eligen en la lista o con el ratón.
            edgesFocusable={false}
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
            onlyRenderVisibleElements={cull}
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
        >
          {!readOnly && single && graph && graph.nodes.some((n) => n.id === single) && addableEdges.length > 0 && (
            <ConnectForm spec={spec} graph={graph} source={single} kinds={addableEdges} kind={edgeKind} onKind={setEdgeKind} onConnect={(source, target) => onConnect({ source, target, sourceHandle: null, targetHandle: null })} />
          )}
        </Inspector>
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
