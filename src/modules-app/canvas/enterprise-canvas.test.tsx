// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorSpec } from '@iark/kernel';
import { enterpriseEditor, enterpriseModule, type EnterpriseDocument } from '@iark/domain-enterprise';
import example from '../../../examples/empresa-arquitectura.json';
import { installFlowMocks, pickNode } from '../testing-dom';
import { DiagramCanvas } from './DiagramCanvas';
import { EditHistory } from './history';

beforeAll(installFlowMocks);
beforeEach(() => window.localStorage.clear());

const spec = enterpriseEditor as unknown as EditorSpec<unknown>;
const base = enterpriseModule.schema.parse(example) as EnterpriseDocument;
// El ejemplo más una composición (rombo), un disparo (flecha abierta) y una asignación (punto).
const doc: EnterpriseDocument = {
  ...base,
  processes: [...base.processes, { id: 'preparacion-pedido', name: 'Preparación de pedido', ownerId: 'logistica' }],
  applications: [...base.applications, { id: 'erp-facturacion', name: 'ERP · facturación', ownerId: 'finanzas' }],
  relations: [
    ...base.relations,
    { id: 'erp--composes--erp-facturacion', kind: 'composes', sourceId: 'erp', targetId: 'erp-facturacion' },
    { id: 'alta-pedido--triggers--preparacion-pedido', kind: 'triggers', sourceId: 'alta-pedido', targetId: 'preparacion-pedido' },
    { id: 'ventas--assigned-to--alta-pedido', kind: 'assigned-to', sourceId: 'ventas', targetId: 'alta-pedido' },
  ],
};
const views = enterpriseModule.views!(doc);

function mount(viewId: string, onView = vi.fn(), options: { readOnly?: boolean } = {}): ReturnType<typeof vi.fn> {
  const onText = vi.fn();
  render(
    <DiagramCanvas moduleId="enterprise" spec={spec} document={doc} text="" viewId={viewId} views={views} onView={onView} readOnly={options.readOnly ?? false} history={new EditHistory()} onText={onText} notify={vi.fn()} />,
  );
  return onText;
}

/** La relación «soporta» de la aplicación a la capacidad en el último texto que el lienzo ha entregado. */
function supportIn(onText: ReturnType<typeof vi.fn>, applicationId: string, capabilityId: string): boolean {
  const text = onText.mock.calls.at(-1)?.[0] as string;
  return (JSON.parse(text) as EnterpriseDocument).relations.some((r) => r.kind === 'supports' && r.sourceId === applicationId && r.targetId === capabilityId);
}

describe('lienzo empresarial', () => {
  it('cada nodo lleva el icono de su tipo en la esquina y el color de su capa', async () => {
    mount('landscape');
    await waitFor(() => expect(screen.getByTestId('node-tienda-web')).toBeInTheDocument(), { timeout: 5000 });
    expect(within(screen.getByTestId('node-tienda-web')).getByTestId('icon-tienda-web')).toBeInTheDocument();
    expect(within(screen.getByTestId('node-kubernetes')).getByTestId('icon-kubernetes')).toBeInTheDocument();
    expect(screen.getByTestId('node-tienda-web').querySelector('path')?.getAttribute('fill')).toBe('#74c0fc');
    expect(screen.getByTestId('node-kubernetes').querySelector('path')?.getAttribute('fill')).toBe('#8ce99a');
  });

  it('la composición y la asignación se dibujan con su adorno de origen y el disparo con la flecha abierta', async () => {
    mount('landscape');
    await waitFor(() => expect(document.querySelector('.react-flow__edge[data-id="erp--composes--erp-facturacion"]')).not.toBeNull(), { timeout: 5000 });
    const tail = (id: string) => document.querySelector(`.react-flow__edge[data-id="${id}"] [data-testid="edge-tail"]`);
    expect(tail('erp--composes--erp-facturacion')?.getAttribute('data-tail')).toBe('diamond');
    expect(tail('ventas--assigned-to--alta-pedido')?.getAttribute('data-tail')).toBe('dot');
    expect(tail('tienda-web--supports--alta-pedido')).toBeNull();
    const path = (id: string) => document.querySelector(`.react-flow__edge[data-id="${id}"] .react-flow__edge-path`) as SVGPathElement;
    expect(path('alta-pedido--triggers--preparacion-pedido').getAttribute('marker-end')).toContain('arrow');
    expect(path('alta-pedido--triggers--preparacion-pedido').getAttribute('marker-end')).not.toContain('arrowclosed');
    expect(path('erp--composes--erp-facturacion').getAttribute('marker-end')).toBeNull();
  });

  it('el mapa de capacidades muestra su leyenda y deja elegir con qué se colorea', async () => {
    const onView = vi.fn();
    mount('capabilities', onView);
    await waitFor(() => expect(screen.getByTestId('node-ventas-online')).toBeInTheDocument(), { timeout: 5000 });
    const legend = screen.getByTestId('canvas-legend');
    expect(legend).toHaveTextContent('Color: madurez');
    expect(legend).toHaveTextContent('sin indicar');
    const select = screen.getByTestId('canvas-variant') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Madurez', 'Importancia', 'Criticidad de las aplicaciones', 'Ciclo de vida de las aplicaciones']);
    // Las variantes no ensucian el selector «Vista».
    const viewSelect = screen.getByTestId('canvas-view') as HTMLSelectElement;
    expect([...viewSelect.options].map((o) => o.value)).toEqual(['capabilities', 'landscape', 'matrix', 'roadmap', ...views.filter((v) => v.id.startsWith('unit:')).map((v) => v.id)]);
    fireEvent.change(select, { target: { value: 'capabilities:criticality' } });
    expect(onView).toHaveBeenCalledWith('capabilities:criticality');
  });

  it('en una variante se muestra su leyenda y el selector sigue sobre ella', async () => {
    mount('capabilities:criticality');
    await waitFor(() => expect(screen.getByTestId('node-ventas-online')).toBeInTheDocument(), { timeout: 5000 });
    expect(screen.getByTestId('canvas-legend')).toHaveTextContent('Color: criticidad de las aplicaciones');
    expect((screen.getByTestId('canvas-variant') as HTMLSelectElement).value).toBe('capabilities:criticality');
    expect((screen.getByTestId('canvas-view') as HTMLSelectElement).value).toBe('capabilities');
  });

  it('las vistas de relaciones no llevan selector de color ni leyenda', async () => {
    mount('landscape');
    await waitFor(() => expect(screen.getByTestId('node-tienda-web')).toBeInTheDocument(), { timeout: 5000 });
    expect(screen.queryByTestId('canvas-variant')).toBeNull();
    expect(screen.queryByTestId('canvas-legend')).toBeNull();
  });
});

describe('matriz capacidad × aplicación en el lienzo', () => {
  // La matriz del ejemplo tiene cientos de celdas y jsdom no encuadra la cámara: con el recorte de nodos fuera de pantalla solo
  // quedarían montadas las que caen en el rectángulo de 800 × 600 que simulan los mocks. En un navegador el encuadre las muestra todas.
  beforeEach(() => window.history.replaceState({}, '', '/?cull=off'));
  afterEach(() => window.history.replaceState({}, '', '/'));

  const ready = async (): Promise<void> => {
    await waitFor(() => expect(screen.getByTestId('node-cell:ventas-online|tienda-web')).toBeInTheDocument(), { timeout: 20000 });
  };

  it('dibuja cabeceras, celdas y totales como nodos, sin la etiqueta de tipo en celdas ni totales', async () => {
    mount('matrix');
    await ready();
    expect(screen.getByTestId('node-ventas-online')).toHaveTextContent('Ventas online');
    expect(screen.getByTestId('node-tienda-web')).toHaveTextContent('Tienda online');
    expect(screen.getByTestId('node-cell:ventas-online|tienda-web')).toHaveTextContent('●');
    expect(screen.getByTestId('node-cell:ventas-online|tienda-web').querySelector('.cv-kind')).toBeNull();
    // Ni las celdas ni los totales se conectan: solo las cabeceras llevan puntos de conexión.
    expect(screen.getByTestId('node-cell:ventas-online|tienda-web').querySelector('.react-flow__handle')).toBeNull();
    expect(screen.getByTestId('node-total:all').querySelector('.react-flow__handle')).toBeNull();
    expect(screen.getByTestId('node-tienda-web').querySelector('.react-flow__handle')).not.toBeNull();
    expect(screen.getByTestId('node-cell:ventas-online|crm').textContent).toBe('');
    expect(screen.getByTestId('node-total:row:gestion-pedidos')).toHaveTextContent('solapamiento');
    expect(screen.getByTestId('node-total:all')).toHaveTextContent('12/12');
    // Las cabeceras de capacidad y aplicación siguen llevando su tipo.
    expect(screen.getByTestId('node-tienda-web').querySelector('.cv-kind')).not.toBeNull();
    expect(screen.queryByTestId('canvas-variant')).toBeNull();
    // La pista visible dice cómo se edita: doble clic y arrastrar.
    expect(screen.getByTestId('canvas-legend')).toHaveTextContent('Doble clic en una celda: marca o quita el soporte. Arrastra una celda con ● a otra: lo mueve.');
  }, 60000);

  it('«Soporta ⇄» crea la relación en las celdas seleccionadas y está deshabilitada sin celdas', async () => {
    const onText = mount('matrix');
    await ready();
    const action = screen.getByTestId('action-matrix-support');
    expect(action).toBeDisabled();
    await pickNode('tienda-web');
    expect(action).toBeDisabled();
    expect(action).toHaveAttribute('title', 'Selecciona una o varias celdas de la matriz capacidad × aplicación.');
    await pickNode('cell:ventas-online|crm');
    expect(action).toBeEnabled();
    fireEvent.click(action);
    expect(supportIn(onText, 'crm', 'ventas-online')).toBe(true);
  }, 60000);

  it('«Soporta ⇄» quita el soporte directo cuando todas las celdas elegidas ya lo tienen', async () => {
    const onText = mount('matrix');
    await ready();
    await pickNode('cell:ventas-online|tienda-web');
    fireEvent.click(screen.getByTestId('action-matrix-support'));
    expect(supportIn(onText, 'tienda-web', 'ventas-online')).toBe(false);
  }, 60000);

  it('doble clic en una celda alterna la relación; en una cabecera no cambia el documento', async () => {
    const onText = mount('matrix');
    await ready();
    fireEvent.doubleClick(screen.getByTestId('node-cell:ventas-online|crm').closest('.react-flow__node') as HTMLElement);
    expect(supportIn(onText, 'crm', 'ventas-online')).toBe(true);
    const calls = onText.mock.calls.length;
    fireEvent.doubleClick(screen.getByTestId('node-ventas-online').closest('.react-flow__node') as HTMLElement);
    expect(onText.mock.calls.length).toBe(calls);
  }, 60000);

  it('en solo lectura el doble clic no edita', async () => {
    const onText = mount('matrix', vi.fn(), { readOnly: true });
    await ready();
    fireEvent.doubleClick(screen.getByTestId('node-cell:ventas-online|crm').closest('.react-flow__node') as HTMLElement);
    expect(onText).not.toHaveBeenCalled();
  }, 60000);
});
