// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installFlowMocks } from '../../../modules-app/testing-dom';
import { useDocumentStore } from '../../store/documentStore';
import { Canvas } from './Canvas';

/**
 * Accesibilidad del lienzo del editor clásico (WCAG 2.1.1, 2.4.3 y 4.1.2): nombres de los elementos y de las relaciones, recorrido con las
 * flechas, mover con Mayús más flecha e Intro para abrir la ficha. Con jsdom no hay layout real: se mide la estructura (nombres, foco).
 */
beforeAll(installFlowMocks);

beforeEach(() => {
  window.localStorage.clear();
  useDocumentStore.getState().loadSample();
  useDocumentStore.setState({ layoutBusy: false });
});

const READY = { timeout: 20000 };
const canvas = (): HTMLElement => screen.getByTestId('c4-canvas');
const ready = () => waitFor(() => expect(canvas()).toHaveAttribute('data-layout', 'ready'), READY);
const nodeEl = (id: string): HTMLElement => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
const press = (el: HTMLElement, key: string, init: KeyboardEventInit = {}): void => {
  act(() => {
    fireEvent.keyDown(el, { key, ...init });
  });
};
const mount = () =>
  render(
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>,
  );

describe('lienzo del editor clásico · accesibilidad', () => {
  it('el lienzo se anuncia con la vista, cuántos elementos y relaciones tiene y cómo recorrerlo', async () => {
    mount();
    await ready();
    const nombre = canvas().getAttribute('aria-label') ?? '';
    expect(nombre).toMatch(/^Diagrama /);
    expect(nombre).toMatch(/\d+ elementos y \d+ relaciones/);
    expect(nombre).toContain('flechas');
  }, 60000);

  it('cada elemento es una parada del tabulador con un nombre que dice su tipo, su nombre y con quién se relaciona', async () => {
    mount();
    await ready();
    const cliente = nodeEl('cliente');
    expect(cliente).toHaveAttribute('tabindex', '0');
    const nombre = cliente.getAttribute('aria-label') ?? '';
    expect(nombre).toContain('Persona: Cliente personal');
    expect(nombre).toMatch(/Sale hacia \d+: /);
  }, 60000);

  it('las relaciones llevan un nombre accesible con origen y destino, pero no son paradas del tabulador', async () => {
    mount();
    await ready();
    const relaciones = [...document.querySelectorAll<HTMLElement>('.react-flow__edge')];
    expect(relaciones.length).toBeGreaterThan(0);
    for (const relacion of relaciones) {
      expect(relacion.getAttribute('aria-label')).toMatch(/^Relación.*: de .+ a .+\.$/);
      expect(relacion).not.toHaveAttribute('tabindex', '0');
    }
  }, 60000);

  it('las flechas pasan el foco a un elemento vecino', async () => {
    mount();
    await ready();
    const origen = nodeEl('cliente');
    const destinos = (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'] as const).map((tecla) => {
      origen.focus();
      press(origen, tecla);
      return (document.activeElement as HTMLElement | null)?.dataset.id;
    });
    const alcanzados = destinos.filter((id): id is string => !!id && id !== 'cliente');
    expect(alcanzados.length).toBeGreaterThan(0);
  }, 60000);

  it('Mayús más flecha mueve el elemento un paso de la cuadrícula; sin Mayús no lo mueve', async () => {
    mount();
    await ready();
    const antes = useDocumentStore.getState().doc.views.find((v) => v.id === 'contexto')!.elements.find((e) => e.id === 'cliente')!;
    const origen = nodeEl('cliente');
    origen.focus();
    press(origen, 'ArrowRight', { shiftKey: false });
    const aun = useDocumentStore.getState().doc.views.find((v) => v.id === 'contexto')!.elements.find((e) => e.id === 'cliente')!;
    expect(aun.x).toBe(antes.x);
    press(nodeEl('cliente'), 'ArrowRight', { shiftKey: true });
    const despues = useDocumentStore.getState().doc.views.find((v) => v.id === 'contexto')!.elements.find((e) => e.id === 'cliente')!;
    expect(despues.x).toBe((antes.x ?? 0) + 12);
    expect(despues.y).toBe(antes.y);
  }, 60000);

  it('Intro selecciona el elemento', async () => {
    mount();
    await ready();
    const origen = nodeEl('cliente');
    origen.focus();
    press(origen, 'Enter');
    expect(useDocumentStore.getState().selection).toEqual({ kind: 'element', id: 'cliente' });
  }, 60000);
});
