// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { abortError, pretty, setElkRunner, type EditorSpec, type ElkRunner } from '@iark/kernel';
import type { ElkNode } from 'elkjs/lib/elk-api';
import type { CanvasCompare } from '../compare';
import { installFlowMocks, pressKey } from '../testing-dom';
import { fakeEditor, type FakeDoc } from '../testing-editor';
import { DiagramCanvas, CULL_FROM_NODES } from './DiagramCanvas';
import { EditHistory } from './history';

/**
 * El lienzo con muchos nodos. Son pruebas ESTRUCTURALES (cuántos nodos se montan en el DOM, a quién se le pide el cálculo, qué
 * estado se muestra mientras calcula): ninguna depende de cuánto tarde nada. El autolayout se sustituye por una cuadrícula
 * instantánea (`setElkRunner`) para no gastar en la prueba los segundos que ELK necesita con mil nodos.
 */
beforeAll(installFlowMocks);
afterAll(() => vi.unstubAllGlobals());

const spec = fakeEditor as unknown as EditorSpec<unknown>;

/**
 * Tamaño del «diagrama grande» de estas pruebas: `BIG_ZONES` zonas de 25 servicios, 20 × 26 = 520 nodos, más de tres veces el umbral del recorte
 * (`CULL_FROM_NODES`). Con mil nodos (40 zonas) cada prueba tardaba más de 20 s solo en montar y encuadrar bajo jsdom, que no tiene el
 * motor de dibujo del navegador, y fallaba por tiempo en un CI cargado sin que nada estuviera roto. Lo que se comprueba aquí es estructural y
 * no depende de pasar de mil; el coste con mil nodos en un navegador real lo mide `npm run perf` (docs/rendimiento.md).
 */
const BIG_ZONES = 20;
const BIG_PER_ZONE = 25;
/** Un servicio del final de la lista: cae fuera de la pantalla inicial. */
const FAR_INDEX = BIG_ZONES * BIG_PER_ZONE - 10;

/** `zones` zonas con `perZone` servicios cada una, unidos en cadena: `zones * (perZone + 1)` nodos y `zones * perZone` aristas. */
function bigDoc(zones: number, perZone: number): FakeDoc {
  const nodes: FakeDoc['nodes'] = [];
  const edges: FakeDoc['edges'] = [];
  for (let z = 0; z < zones; z++) {
    nodes.push({ id: `z${z}`, kind: 'zone', name: `Zona ${z}` });
    for (let i = 0; i < perZone; i++) {
      const id = `n${z * perZone + i}`;
      nodes.push({ id, kind: 'service', name: `Servicio ${z * perZone + i}`, zone: `z${z}` });
      if (z * perZone + i > 0) edges.push({ id: `e${z * perZone + i}`, source: `n${z * perZone + i - 1}`, target: id, kind: 'sync' });
    }
  }
  return { nodes, edges, contracts: [] };
}

/** Un «ELK» instantáneo: pone los hijos de cada grupo en una cuadrícula y da a cada grupo el tamaño de la suya. */
function gridLayout(graph: ElkNode): ElkNode {
  const place = (children: ElkNode[], columns: number, cell: { w: number; h: number }, pad: number): { width: number; height: number } => {
    children.forEach((child, i) => {
      child.x = pad + (i % columns) * cell.w;
      child.y = pad + Math.floor(i / columns) * cell.h;
      if (child.children) {
        const size = place(child.children, 5, { w: 180, h: 80 }, 30);
        child.width = size.width + 30;
        child.height = size.height + 30;
      }
    });
    const rows = Math.ceil(children.length / columns);
    return { width: pad + columns * cell.w, height: pad + rows * cell.h };
  };
  const size = place(graph.children ?? [], 8, { w: 1100, h: 700 }, 20);
  return { ...graph, width: size.width, height: size.height };
}

const instantLayout: ElkRunner = async (graph) => gridLayout(graph);

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  setElkRunner(undefined);
});

interface Mounted {
  rerender(props: Partial<{ doc: FakeDoc; focusId: string; compare: CanvasCompare }>): void;
  unmount(): void;
  follow: ReturnType<typeof vi.fn>;
}

function mount(doc: FakeDoc, extra: { spec?: EditorSpec<unknown>; focusId?: string; compare?: CanvasCompare } = {}): Mounted {
  const history = new EditHistory();
  const follow = vi.fn();
  const element = (current: { doc: FakeDoc; focusId?: string; compare?: CanvasCompare }) => (
    <DiagramCanvas
      moduleId="fake"
      spec={extra.spec ?? spec}
      document={current.doc}
      text={pretty(current.doc)}
      views={[]}
      onView={vi.fn()}
      readOnly={false}
      history={history}
      onText={vi.fn()}
      notify={vi.fn()}
      focusId={current.focusId}
      compare={current.compare}
      links={{ modules: [], entities: async () => [], backlinks: async () => [], follow }}
    />
  );
  const state = { doc, focusId: extra.focusId, compare: extra.compare };
  const view = render(element(state));
  return {
    rerender: (props) => view.rerender(element({ ...state, ...props })),
    unmount: view.unmount,
    follow,
  };
}

const mountedNodes = (): number => document.querySelectorAll('.react-flow__node').length;
const settled = async (): Promise<void> => {
  await waitFor(() => expect(screen.getByTestId('module-canvas')).toHaveAttribute('data-layout', 'ready'), { timeout: 20000 });
};

describe('con muchos nodos solo se montan los que caen en pantalla', () => {
  it('con 500 servicios el DOM no lleva los 500: React Flow monta solo los visibles', async () => {
    setElkRunner(instantLayout);
    const doc = bigDoc(BIG_ZONES, BIG_PER_ZONE);
    expect(doc.nodes).toHaveLength(BIG_ZONES * (BIG_PER_ZONE + 1));
    mount(doc);
    await settled();
    expect(screen.getByTestId('module-canvas')).toHaveAttribute('data-culling', 'on');
    const mounted = mountedNodes();
    expect(mounted).toBeGreaterThan(0);
    expect(mounted, `se montaron ${mounted} de ${doc.nodes.length}`).toBeLessThan(doc.nodes.length / 4);
  });

  it(`por debajo de ${CULL_FROM_NODES} nodos se montan todos y el recorte está apagado`, async () => {
    setElkRunner(instantLayout);
    const doc = bigDoc(4, 20);
    expect(doc.nodes.length).toBeLessThan(CULL_FROM_NODES);
    mount(doc);
    await settled();
    expect(screen.getByTestId('module-canvas')).toHaveAttribute('data-culling', 'off');
    expect(mountedNodes()).toBe(doc.nodes.length);
  });

  it('el borde: con exactamente el umbral de nodos ya recorta', async () => {
    setElkRunner(instantLayout);
    mount(bigDoc(1, CULL_FROM_NODES - 1));
    await settled();
    expect(screen.getByTestId('module-canvas')).toHaveAttribute('data-culling', 'on');
  });
});

describe('el cálculo de la colocación se pide fuera del lienzo y se puede cortar', () => {
  /** Un motor que no contesta hasta que se aborta, para ver qué muestra el lienzo mientras calcula. */
  function hangingRunner(): { runner: ElkRunner; signals: AbortSignal[]; graphs: ElkNode[] } {
    const signals: AbortSignal[] = [];
    const graphs: ElkNode[] = [];
    const runner: ElkRunner = (graph, { signal }) =>
      new Promise<ElkNode>((_resolve, reject) => {
        graphs.push(graph);
        if (signal) {
          signals.push(signal);
          signal.addEventListener('abort', () => reject(abortError()), { once: true });
        }
      });
    return { runner, signals, graphs };
  }

  it('el lienzo pide el grafo al motor de cálculo, una sola vez y con una señal para cancelarlo', async () => {
    const calls: Array<{ graph: ElkNode; signal: AbortSignal | undefined }> = [];
    setElkRunner(async (graph, { signal }) => {
      calls.push({ graph, signal });
      return gridLayout(graph);
    });
    mount(bigDoc(10, 10));
    await settled();
    expect(calls).toHaveLength(1);
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(calls[0].graph.children).toHaveLength(10); // las diez zonas, con sus servicios dentro
    expect(calls[0].graph.edges).toHaveLength(99);
  });

  it('mientras calcula avisa «Calculando…» con un botón Cancelar; al acabar el aviso desaparece', async () => {
    let finish: (() => void) | undefined;
    setElkRunner(
      (graph) =>
        new Promise<ElkNode>((resolve) => {
          finish = () => resolve(gridLayout(graph));
        }),
    );
    mount(bigDoc(6, 10));
    expect(screen.getByTestId('module-canvas')).toHaveAttribute('data-layout', 'pending');
    // No avisa al instante (evita el parpadeo con diagramas pequeños)…
    expect(screen.queryByTestId('canvas-busy')).toBeNull();
    // …pero sí si tarda.
    const busy = await screen.findByTestId('canvas-busy', undefined, { timeout: 3000 });
    expect(busy).toHaveTextContent('Calculando la colocación de 66 elementos');
    expect(screen.getByTestId('canvas-busy-cancel')).toBeEnabled();
    await act(async () => finish?.());
    await settled();
    expect(screen.queryByTestId('canvas-busy')).toBeNull();
  });

  it('Cancelar corta el cálculo, deja el dibujo provisional y avisa; Autolayout lo reintenta', async () => {
    const { runner, signals } = hangingRunner();
    setElkRunner(runner);
    mount(bigDoc(6, 10));
    fireEvent.click(await screen.findByTestId('canvas-busy-cancel', undefined, { timeout: 3000 }));
    expect(signals[0].aborted).toBe(true);
    expect(await screen.findByTestId('canvas-layout-cancelled')).toHaveTextContent('Se canceló el cálculo');
    expect(screen.queryByTestId('canvas-busy')).toBeNull();
    await settled();
    expect(mountedNodes()).toBeGreaterThan(0); // la colocación de reserva (cuadrícula) se dibuja

    setElkRunner(instantLayout);
    fireEvent.click(screen.getByTestId('autolayout'));
    await waitFor(() => expect(screen.queryByTestId('canvas-layout-cancelled')).toBeNull());
    await settled();
  });

  it('un cálculo nuevo (la estructura cambió) corta el anterior: no compiten por el motor', async () => {
    const { runner, signals, graphs } = hangingRunner();
    setElkRunner(runner);
    const doc = bigDoc(3, 5);
    const view = mount(doc);
    await waitFor(() => expect(graphs).toHaveLength(1));
    view.rerender({ doc: { ...doc, nodes: [...doc.nodes, { id: 'nuevo', kind: 'service', name: 'Nuevo' }] } });
    await waitFor(() => expect(graphs).toHaveLength(2));
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });

  it('desmontar el lienzo corta el cálculo en marcha', async () => {
    const { runner, signals } = hangingRunner();
    setElkRunner(runner);
    const view = mount(bigDoc(3, 5));
    await waitFor(() => expect(signals).toHaveLength(1));
    view.unmount();
    expect(signals[0].aborted).toBe(true);
  });

  it('editar solo un texto de propiedades no pide otro cálculo', async () => {
    const run = vi.fn(instantLayout);
    setElkRunner(run);
    const doc = bigDoc(3, 5);
    const view = mount(doc);
    await settled();
    expect(run).toHaveBeenCalledTimes(1);
    view.rerender({ doc: { ...doc, nodes: doc.nodes.map((n) => (n.id === 'n3' ? { ...n, retries: 5 } : n)) } });
    await act(async () => {});
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('la selección, la comparación y los enlaces siguen con nodos fuera de pantalla', () => {
  const doc = bigDoc(BIG_ZONES, BIG_PER_ZONE);
  const far = `n${FAR_INDEX}`;

  it('un elemento lejano se selecciona por su id (foco) aunque no estuviera montado', async () => {
    setElkRunner(instantLayout);
    const view = mount(doc);
    await settled();
    expect(document.querySelector(`[data-testid="node-${far}"]`)).toBeNull();
    view.rerender({ focusId: far });
    await waitFor(() => expect(screen.getByLabelText('Nombre')).toHaveValue(`Servicio ${FAR_INDEX}`));
    await waitFor(() => expect(screen.getByTestId(`node-${far}`)).toBeInTheDocument());
  });

  it('la marca de comparación de un nodo lejano está en sus datos: aparece cuando entra en pantalla', async () => {
    setElkRunner(instantLayout);
    const compare: CanvasCompare = { marks: new Map([[far, 'modified' as const]]), removed: new Set(), base: doc };
    const view = mount(doc, { compare });
    await settled();
    expect(screen.queryByTestId(`diff-${far}`)).toBeNull();
    view.rerender({ focusId: far });
    expect(await screen.findByTestId(`diff-${far}`)).toHaveTextContent('Modificado');
  });

  it('seguir un enlace (Alt+↓) funciona con el nodo seleccionado fuera de pantalla', async () => {
    setElkRunner(instantLayout);
    const linked: EditorSpec<unknown> = {
      ...spec,
      project: (document, viewId) => {
        const graph = spec.project(document, viewId);
        return { ...graph, nodes: graph.nodes.map((n) => (n.id === far ? { ...n, ref: 'urn:iark:otro:destino' } : n)) };
      },
    };
    const view = mount(doc, { spec: linked, focusId: far });
    await settled();
    await waitFor(() => expect(screen.getByLabelText('Nombre')).toHaveValue(`Servicio ${FAR_INDEX}`));
    pressKey('ArrowDown', { altKey: true });
    expect(view.follow).toHaveBeenCalledWith('urn:iark:otro:destino');
  });
});
