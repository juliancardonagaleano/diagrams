// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pretty, type EditorSpec } from '@iark/kernel';
import { installFlowMocks } from '../testing-dom';
import { FAKE_DOC, fakeEditor, type FakeDoc } from '../testing-editor';
import { DiagramCanvas } from './DiagramCanvas';
import { EditHistory } from './history';

/**
 * Accesibilidad del lienzo común (WCAG 2.1.1, 2.4.3, 2.5.7 y 4.1.2): nombres accesibles de los elementos y de las relaciones, recorrido
 * y edición con teclado, lista de elementos como alternativa al dibujo y creación de relaciones sin arrastrar. Con jsdom no hay layout
 * real: lo que se mide aquí es la estructura (nombres, roles, foco, mensajes), no dónde cae cada caja.
 */
beforeAll(installFlowMocks);
beforeEach(() => window.localStorage.clear());

const spec = fakeEditor as unknown as EditorSpec<unknown>;

function mount(options: { readOnly?: boolean } = {}): { doc(): FakeDoc } {
  let current = '';
  function Host() {
    const [text, setText] = useState(pretty(FAKE_DOC));
    current = text;
    return (
      <DiagramCanvas
        moduleId="fake"
        spec={spec}
        document={JSON.parse(text) as unknown}
        text={text}
        views={[]}
        onView={vi.fn()}
        readOnly={options.readOnly ?? false}
        history={new EditHistory()}
        onText={setText}
        notify={vi.fn()}
        onOpenAttachment={vi.fn()}
      />
    );
  }
  render(<Host />);
  return { doc: () => JSON.parse(current) as FakeDoc };
}

const ready = async (): Promise<void> => {
  await waitFor(() => expect(screen.getByTestId('node-api')).toBeInTheDocument());
  await waitFor(() => expect(screen.getByTestId('edge-label-api-cola')).toBeInTheDocument(), { timeout: 5000 });
  // La autodisposición coloca los elementos de forma asíncrona: hasta que no termina, las posiciones cambian solas.
  const posiciones = (): string => [...document.querySelectorAll<HTMLElement>('.react-flow__node')].map((n) => n.style.transform).join('|');
  let anterior = posiciones();
  for (let intento = 0; intento < 30; intento++) {
    await act(async () => new Promise((fin) => setTimeout(fin, 150)));
    const ahora = posiciones();
    if (ahora === anterior) return;
    anterior = ahora;
  }
};

const nodeEl = (id: string): HTMLElement => screen.getByTestId(`node-${id}`).closest('.react-flow__node') as HTMLElement;

/** Pulsa una tecla sobre el elemento que tiene el foco, como la entrega el navegador (la captura del lienzo la atiende antes que React Flow). */
const press = (el: HTMLElement, key: string, init: KeyboardEventInit = {}): void => {
  act(() => {
    fireEvent.keyDown(el, { key, ...init });
  });
};

describe('nombres accesibles', () => {
  it('el lienzo se anuncia con cuántos elementos y relaciones tiene y cómo recorrerlo', async () => {
    mount();
    await ready();
    const lienzo = screen.getByLabelText(/^Lienzo del diagrama: 5 elementos y 2 relaciones/);
    expect(lienzo.getAttribute('aria-label')).toContain('Tabulador');
    expect(lienzo.getAttribute('aria-label')).toContain('Lista');
  });

  it('cada elemento es una parada del tabulador con un nombre que dice su tipo, su nombre y con quién se relaciona', async () => {
    mount();
    await ready();
    const api = nodeEl('api');
    expect(api).toHaveAttribute('tabindex', '0');
    const nombre = api.getAttribute('aria-label') ?? '';
    expect(nombre).toContain('Servicio: API');
    expect(nombre).toContain('Dentro de «Pedidos»');
    expect(nombre).toContain('Sale hacia 1: Cola de pedidos');
    // La zona dice cuántos elementos contiene.
    expect(nodeEl('zona').getAttribute('aria-label')).toContain('Contiene 2 elementos');
  });

  it('explica las teclas en español, no en inglés', async () => {
    mount();
    await ready();
    const descripcion = document.getElementById(nodeEl('api').getAttribute('aria-describedby') ?? '');
    expect(descripcion?.textContent).toContain('Flechas: ir al elemento vecino');
    expect(descripcion?.textContent).not.toMatch(/Press|arrow/i);
  });

  it('las relaciones se pueden elegir en la lista y llevan un nombre que dice de dónde a dónde van', async () => {
    mount();
    await ready();
    fireEvent.click(screen.getByTestId('toggle-list'));
    expect(screen.getByTestId('list-edge-api-cola')).toHaveTextContent('API → Cola de pedidos');
  });
});

describe('teclado sobre el lienzo', () => {
  it('las flechas pasan el foco al elemento vecino', async () => {
    mount();
    await ready();
    const api = nodeEl('api');
    api.focus();
    // «api» envía a «cola»: en alguna de las cuatro direcciones el vecino más cercano es «cola».
    const destinos = (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'] as const).map((tecla) => {
      api.focus();
      press(api, tecla);
      return (document.activeElement as HTMLElement | null)?.dataset.id;
    });
    expect(destinos.filter(Boolean).length).toBeGreaterThan(0);
    expect(destinos).toContain('cola');
  });

  it('Intro selecciona el elemento y lleva el foco a sus propiedades', async () => {
    mount();
    await ready();
    const api = nodeEl('api');
    api.focus();
    press(api, 'Enter');
    await waitFor(() => expect(screen.getByLabelText('Nombre')).toHaveValue('API'));
    await waitFor(() => expect(document.activeElement?.closest('.cv-inspector')).not.toBeNull());
    expect(screen.getByTestId('canvas-live')).toHaveTextContent('Seleccionado');
  });

  it('Escape en las propiedades devuelve el foco al elemento sin soltar la selección', async () => {
    mount();
    await ready();
    const api = nodeEl('api');
    api.focus();
    press(api, 'Enter');
    await waitFor(() => expect(document.activeElement?.closest('.cv-inspector')).not.toBeNull());
    // La pulsación sale del campo enfocado y sube hasta la ventana, donde escuchan los atajos.
    press(document.activeElement as HTMLElement, 'Escape');
    await waitFor(() => expect(document.activeElement).toBe(nodeEl('api')));
    expect(screen.getByLabelText('Nombre')).toHaveValue('API');
  });

  it('Mayús más flecha mueve el elemento y lo anuncia; sin Mayús no lo mueve', async () => {
    mount();
    await ready();
    const libre = nodeEl('libre');
    libre.focus();
    const antes = libre.style.transform;
    press(libre, 'ArrowRight');
    expect(nodeEl('libre').style.transform).toBe(antes);
    press(libre, 'ArrowRight', { shiftKey: true });
    await waitFor(() => expect(nodeEl('libre').style.transform).not.toBe(antes));
    expect(screen.getByTestId('canvas-live')).toHaveTextContent('Servicio libre movido a la derecha');
  });

  it('en un diagrama de solo lectura Mayús más flecha no mueve y lo explica', async () => {
    mount({ readOnly: true });
    await ready();
    const libre = nodeEl('libre');
    libre.focus();
    const antes = libre.style.transform;
    press(libre, 'ArrowRight', { shiftKey: true });
    expect(nodeEl('libre').style.transform).toBe(antes);
    expect(screen.getByTestId('canvas-live')).toHaveTextContent('solo lectura');
  });

  it('Supr sobre un elemento enfocado lo borra aunque no esté seleccionado, y el foco no se pierde en el <body>', async () => {
    const harness = mount();
    await ready();
    const libre = nodeEl('libre');
    libre.focus();
    press(libre, 'Delete');
    await waitFor(() => expect(harness.doc().nodes.map((n) => n.id)).not.toContain('libre'));
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  });
});

describe('alternativas al dibujo', () => {
  it('la lista recoge todos los elementos, agrupados, y cada uno selecciona y enfoca su elemento', async () => {
    mount();
    await ready();
    const toggle = screen.getByTestId('toggle-list');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const lista = screen.getByTestId('element-list');
    expect(within(lista).getAllByRole('listitem').length).toBeGreaterThanOrEqual(7);
    expect(within(lista).getByRole('heading', { name: /Elementos \(5\) y relaciones \(2\)/ })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('list-node-worker'));
    await waitFor(() => expect(screen.getByLabelText('Nombre')).toHaveValue('Worker'));
  });

  it('un elemento se conecta con otro sin arrastrar, desde el formulario de propiedades', async () => {
    const harness = mount();
    await ready();
    const worker = nodeEl('worker');
    worker.focus();
    press(worker, 'Enter');
    const form = await screen.findByTestId('connect-form');
    expect(form).toHaveAccessibleName('Crear una relación desde aquí');
    const destino = within(form).getByLabelText('Hacia');
    expect(within(form).getByTestId('connect-create')).toBeDisabled();
    fireEvent.change(destino, { target: { value: 'libre' } });
    fireEvent.click(within(form).getByTestId('connect-create'));
    await waitFor(() => expect(harness.doc().edges.some((e) => e.source === 'worker' && e.target === 'libre')).toBe(true));
  });
});
