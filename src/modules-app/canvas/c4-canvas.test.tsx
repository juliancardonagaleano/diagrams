// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pretty, type EditorSpec } from '@iark/kernel';
import { c4Editor, c4Module, type C4Document } from '@iark/domain-c4';
import banca from '../../../examples/banca.json';
import { installFlowMocks, pickNode, pressKey } from '../testing-dom';
import { DiagramCanvas } from './DiagramCanvas';
import { EditHistory } from './history';
import type { LinkTools } from './Inspector';

beforeAll(installFlowMocks);
beforeEach(() => window.localStorage.clear());

const spec = c4Editor as unknown as EditorSpec<unknown>;
const initial = c4Module.schema.parse(banca) as C4Document;

interface Harness {
  history: EditHistory;
  notify: ReturnType<typeof vi.fn>;
  onView: ReturnType<typeof vi.fn>;
  doc(): C4Document;
}

/** El lienzo común con C4, con el documento y la vista abierta guardados como los guarda el banco de trabajo. */
function mount(options: { doc?: C4Document; viewId?: string; links?: LinkTools; onBack?: () => void } = {}): Harness {
  const history = new EditHistory();
  const notify = vi.fn();
  const onView = vi.fn();
  let current = options.doc ?? initial;
  function Host() {
    const [text, setText] = useState(pretty(options.doc ?? initial));
    const [viewId, setViewId] = useState(options.viewId ?? 'contexto');
    const document = JSON.parse(text) as C4Document;
    current = document;
    return (
      <DiagramCanvas
        moduleId="c4"
        spec={spec}
        document={document}
        text={text}
        viewId={viewId}
        views={c4Module.views!(document)}
        onView={(id) => {
          onView(id);
          setViewId(id);
        }}
        readOnly={false}
        history={history}
        onText={setText}
        notify={notify}
        links={options.links}
        onBack={options.onBack}
      />
    );
  }
  render(<Host />);
  return { history, notify, onView, doc: () => current };
}

const ready = async (id: string, view: string): Promise<void> => {
  await waitFor(() => expect(screen.getByTestId('module-canvas')).toHaveAttribute('data-view', view), { timeout: 5000 });
  await waitFor(() => expect(screen.getByTestId(`node-${id}`)).toBeInTheDocument(), { timeout: 5000 });
  await waitFor(() => expect(screen.getByTestId('module-canvas')).toHaveAttribute('data-layout', 'ready'), { timeout: 8000 });
};

describe('lienzo común con C4', () => {
  it('dibuja los contenedores dentro del límite de su sistema, con las figuras de C4 y lo externo discontinuo', async () => {
    mount({ viewId: 'contenedores' });
    await ready('db', 'contenedores');
    expect(screen.getByTestId('node-banca')).toHaveClass('cv-group');
    expect(screen.getByTestId('node-db')).toHaveAttribute('data-shape', 'cylinder');
    expect(screen.getByTestId('node-web-app')).toHaveAttribute('data-shape', 'card');
    expect(screen.getByTestId('node-api')).toHaveAttribute('data-shape', 'rounded');
    expect(screen.getByTestId('node-cliente')).toHaveAttribute('data-shape', 'actor');
    expect(screen.getByTestId('node-mainframe').querySelector('path')?.getAttribute('stroke-dasharray')).toBeTruthy();
    expect(within(screen.getByTestId('node-api')).getByText(/Java/)).toBeInTheDocument();
    // La relación implícita no se ofrece para crear: solo hay un tipo y el selector sobra.
    expect(screen.queryByTestId('edge-kind')).toBeNull();
    for (const kind of ['person', 'softwareSystem', 'container', 'component']) expect(screen.getByTestId(`add-${kind}`)).toBeInTheDocument();
  });

  it('el selector de vista lista los tres niveles y cambia de vista', async () => {
    const harness = mount();
    await ready('banca', 'contexto');
    const select = screen.getByTestId('canvas-view') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['contexto', 'contenedores', 'componentes-api']);
    fireEvent.change(select, { target: { value: 'componentes-api' } });
    await ready('signin', 'componentes-api');
    expect(harness.onView).toHaveBeenCalledWith('componentes-api');
  });

  it('el doble clic sobre un sistema baja a su vista de contenedores, y Subir nivel vuelve, sin ensuciar el historial', async () => {
    const harness = mount();
    await ready('banca', 'contexto');
    expect(screen.getByTestId('action-up')).toBeDisabled();
    fireEvent.doubleClick(screen.getByTestId('node-banca').closest('.react-flow__node') as HTMLElement);
    await ready('db', 'contenedores');
    expect(harness.onView).toHaveBeenLastCalledWith('contenedores');
    expect(harness.history.canUndo).toBe(false);
    expect(screen.getByTestId('action-up')).toBeEnabled();
    fireEvent.click(screen.getByTestId('action-up'));
    await ready('banca', 'contexto');
    expect(harness.history.canUndo).toBe(false);
  });

  it('Alt+↓ baja al detalle del elemento seleccionado y Alt+↑ sube de nivel cuando no hay otro diagrama al que volver', async () => {
    mount({ viewId: 'contenedores' });
    await ready('api', 'contenedores');
    await pickNode('api');
    pressKey('ArrowDown', { altKey: true });
    await ready('signin', 'componentes-api');
    pressKey('ArrowUp', { altKey: true });
    await ready('api', 'contenedores');
    pressKey('ArrowUp', { altKey: true });
    await ready('banca', 'contexto');
  });

  it('la miga C1 › C2 › C3 aparece al bajar de nivel y cada tramo abre su vista', async () => {
    const harness = mount();
    await ready('banca', 'contexto');
    expect(screen.queryByTestId('canvas-breadcrumb')).toBeNull();
    fireEvent.doubleClick(screen.getByTestId('node-banca').closest('.react-flow__node') as HTMLElement);
    await ready('db', 'contenedores');
    const crumbs = screen.getByTestId('canvas-breadcrumb');
    expect(within(crumbs).getAllByRole('button').map((b) => b.textContent)).toEqual(['C1 Contexto del sistema · Sistema de banca en línea', 'C2 Contenedores · Sistema de banca en línea']);
    expect(screen.getByTestId('crumb-contenedores')).toBeDisabled();
    fireEvent.click(screen.getByTestId('crumb-contexto'));
    await ready('banca', 'contexto');
    expect(harness.onView).toHaveBeenLastCalledWith('contexto');
    expect(harness.history.canUndo).toBe(false);
    expect(screen.queryByTestId('canvas-breadcrumb')).toBeNull();
  });

  it('con un enlace a otro módulo, Alt+↓ y el doble clic lo siguen en lugar de bajar de nivel, y Alt+↑ vuelve por la miga si la hay', async () => {
    const follow = vi.fn();
    const onBack = vi.fn();
    const links: LinkTools = { modules: [{ id: 'integration', label: 'Integración' }], entities: async () => [], backlinks: async () => [], follow };
    const doc: C4Document = { ...initial, model: { ...initial.model, elements: initial.model.elements.map((e) => (e.id === 'banca' ? { ...e, ref: 'urn:iark:integration:pedidos' } : e)) } };
    const harness = mount({ doc, links, onBack });
    await ready('banca', 'contexto');
    expect(within(screen.getByTestId('node-banca')).getByTestId('link-banca')).toBeInTheDocument();
    await pickNode('banca');
    pressKey('ArrowDown', { altKey: true });
    expect(follow).toHaveBeenLastCalledWith('urn:iark:integration:pedidos');
    fireEvent.doubleClick(screen.getByTestId('node-banca').closest('.react-flow__node') as HTMLElement);
    expect(follow).toHaveBeenCalledTimes(2);
    expect(harness.onView).not.toHaveBeenCalled();
    pressKey('ArrowUp', { altKey: true });
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(harness.onView).not.toHaveBeenCalled();
  });

  it('añade un contenedor al sistema de la vista, lo registra para deshacer y se deshace', async () => {
    const harness = mount({ viewId: 'contenedores' });
    await ready('db', 'contenedores');
    fireEvent.click(screen.getByTestId('add-container'));
    await waitFor(() => expect(harness.doc().model.elements.length).toBe(initial.model.elements.length + 1));
    const created = harness.doc().model.elements.at(-1)!;
    expect(created).toMatchObject({ type: 'container', parentId: 'banca', name: 'Contenedor nuevo' });
    await waitFor(() => expect(screen.getByTestId(`node-${created.id}`)).toBeInTheDocument());
    expect(harness.history.canUndo).toBe(true);
    // El nuevo elemento queda seleccionado y se edita en el panel de propiedades.
    await waitFor(() => expect(screen.getByLabelText('Nombre')).toHaveValue('Contenedor nuevo'));
    fireEvent.click(screen.getByLabelText('Deshacer'));
    await waitFor(() => expect(harness.doc().model.elements.length).toBe(initial.model.elements.length));
    await waitFor(() => expect(screen.queryByTestId(`node-${created.id}`)).toBeNull());
  });

  it('lo que nace dentro de un límite lo coloca el autolayout; lo que nace suelto, en el centro de la pantalla', async () => {
    mount({ viewId: 'contenedores' });
    await ready('db', 'contenedores');
    const stored = (): string | null => window.localStorage.getItem('iark.canvas.c4.contenedores');
    fireEvent.click(screen.getByTestId('add-container'));
    await waitFor(() => expect(screen.getByTestId('node-contenedor-nuevo')).toBeInTheDocument());
    expect(stored()).toBeNull();
    fireEvent.click(screen.getByTestId('add-person'));
    await waitFor(() => expect(screen.getByTestId('node-persona-nueva')).toBeInTheDocument());
    expect(JSON.parse(stored()!).map(([id]: [string]) => id)).toEqual(['persona-nueva']);
  });

  it('avisa, sin tocar el documento, si la vista no muestra el tipo de elemento que se añade', async () => {
    const harness = mount();
    await ready('banca', 'contexto');
    fireEvent.click(screen.getByTestId('add-container'));
    expect(harness.notify).toHaveBeenCalledWith(expect.stringMatching(/contexto/));
    expect(harness.doc()).toEqual(initial);
    expect(harness.history.canUndo).toBe(false);
  });

  it('el panel de propiedades edita el elemento seleccionado', async () => {
    const harness = mount({ viewId: 'contenedores' });
    await ready('email', 'contenedores');
    await pickNode('email');
    expect(screen.getByLabelText('Nombre')).toHaveValue('Sistema de correo');
    fireEvent.change(screen.getByLabelText('Nombre'), { target: { value: 'Correo corporativo' } });
    fireEvent.blur(screen.getByLabelText('Nombre'));
    await waitFor(() => expect(harness.doc().model.elements.find((e) => e.id === 'email')?.name).toBe('Correo corporativo'));
  });

  it('quitar de la vista deja el elemento en el modelo', async () => {
    const harness = mount({ viewId: 'contenedores' });
    await ready('email', 'contenedores');
    await pickNode('email');
    fireEvent.click(screen.getByTestId('action-remove-from-view'));
    await waitFor(() => expect(screen.queryByTestId('node-email')).toBeNull());
    expect(harness.doc().model.elements.some((e) => e.id === 'email')).toBe(true);
    expect(harness.doc().views.find((v) => v.id === 'contenedores')?.elements.some((e) => e.id === 'email')).toBe(false);
  });

  it('borrar con Supr quita el elemento del modelo con todo lo que cuelga de él', async () => {
    const harness = mount({ viewId: 'contenedores' });
    await ready('db', 'contenedores');
    await pickNode('db');
    pressKey('Delete');
    await waitFor(() => expect(screen.queryByTestId('node-db')).toBeNull());
    expect(harness.doc().model.elements.some((e) => e.id === 'db')).toBe(false);
    expect(harness.doc().model.relationships.some((r) => r.id === 'r11' || r.id === 'r18')).toBe(false);
  });

  it('muestra una marca sobre el elemento con un error de validación', async () => {
    const doc: C4Document = { ...initial, model: { ...initial.model, elements: initial.model.elements.map((e) => (e.id === 'db' ? { ...e, parentId: undefined } : e)) } };
    mount({ doc, viewId: 'contenedores' });
    await ready('db', 'contenedores');
    expect(within(screen.getByTestId('node-db')).getByText('⚠ Sin padre')).toBeInTheDocument();
  });

  it('Autolayout recalcula la colocación aunque la vista guarde posiciones', async () => {
    const guardado: C4Document = {
      ...initial,
      views: initial.views.map((v) => (v.id === 'contexto' ? { ...v, elements: v.elements.map((e, i) => ({ ...e, x: 2000 + 300 * i, y: 50, width: 240, height: 130 })) } : v)),
    };
    mount({ doc: guardado });
    await ready('banca', 'contexto');
    const before = (screen.getByTestId('node-cliente').closest('.react-flow__node') as HTMLElement).style.transform;
    expect(before).toContain('2000');
    await act(async () => fireEvent.click(screen.getByTestId('autolayout')));
    await waitFor(() => expect((screen.getByTestId('node-cliente').closest('.react-flow__node') as HTMLElement).style.transform).not.toContain('2000'), { timeout: 8000 });
  });
});
