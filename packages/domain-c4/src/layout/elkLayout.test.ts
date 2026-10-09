import { describe, expect, it } from 'vitest';
import { isAbortError } from '@iark/kernel';
import { sampleDocument } from '../model/sample';
import { deriveView } from '../model/viewDerivation';
import { toDrawio } from '../export/drawio/toDrawio';
import { autoLayoutDocument, layoutView } from './elkLayout';

function overlaps(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe('layoutView: cancelar con una señal', () => {
  it('con la señal ya abortada rechaza con AbortError: no se cae a la cuadrícula de reserva', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(layoutView(sampleDocument, 'contenedores', { force: true, signal: controller.signal })).rejects.toSatisfy(isAbortError);
    await expect(layoutView(sampleDocument, 'contenedores', { force: true, fast: true, signal: controller.signal })).rejects.toSatisfy(isAbortError);
  });

  it('abortar a mitad de la estrategia inteligente corta el cálculo (no sigue con los demás candidatos)', async () => {
    const controller = new AbortController();
    const pending = layoutView(sampleDocument, 'contenedores', { force: true, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toSatisfy(isAbortError);
  });

  it('sin señal calcula como siempre', async () => {
    const r = await layoutView(sampleDocument, 'contexto', { force: true });
    expect(r.positions).toHaveLength(4);
  });
});

describe('layoutView (ELK)', () => {
  it('posiciona todos los nodos de la vista de contexto sin solapes', async () => {
    const r = await layoutView(sampleDocument, 'contexto');
    expect(r.positions).toHaveLength(4);
    for (let i = 0; i < r.positions.length; i++) {
      for (let j = i + 1; j < r.positions.length; j++) {
        expect(overlaps(r.positions[i], r.positions[j])).toBe(false);
      }
    }
  });

  it('mantiene los contenedores dentro del boundary del sistema', async () => {
    const r = await layoutView(sampleDocument, 'contenedores');
    const banca = r.boundaries.find((b) => b.id === 'banca');
    expect(banca).toBeDefined();
    for (const id of ['api', 'db', 'spa', 'web-app', 'mobile-app']) {
      const p = r.positions.find((x) => x.id === id)!;
      expect(p.x).toBeGreaterThanOrEqual(banca!.x);
      expect(p.y).toBeGreaterThanOrEqual(banca!.y);
      expect(p.x + p.width).toBeLessThanOrEqual(banca!.x + banca!.width);
      expect(p.y + p.height).toBeLessThanOrEqual(banca!.y + banca!.height);
    }
    const cliente = r.positions.find((x) => x.id === 'cliente')!;
    expect(overlaps(cliente, banca!)).toBe(false);
  });

  it('respeta la dirección RIGHT (las capas avanzan en x)', async () => {
    const r = await layoutView(sampleDocument, 'contexto', { direction: 'RIGHT' });
    const cliente = r.positions.find((x) => x.id === 'cliente')!;
    const banca = r.positions.find((x) => x.id === 'banca')!;
    expect(banca.x).toBeGreaterThan(cliente.x);
  });

  it('autoLayoutDocument rellena x/y en todas las vistas y es idempotente sin force', async () => {
    const laid = await autoLayoutDocument(sampleDocument);
    for (const v of laid.views) {
      for (const ve of v.elements) {
        expect(ve.x).toBeTypeOf('number');
        expect(ve.y).toBeTypeOf('number');
      }
    }
    const again = await autoLayoutDocument(laid);
    expect(again.views).toEqual(laid.views);
    // La geometría del boundary derivada tras el layout envuelve a los hijos.
    const d = deriveView(laid, 'contenedores');
    expect(d.boundaries[0].width).toBeGreaterThan(240);
  });

  describe('vistas jerárquicas con elementos posicionados y otros sin posición', () => {
    // El modo interactivo de ELK lanza UnsupportedGraphException en C2/C3 (con boundaries) cuando solo
    // algunos nodos tienen posición; antes eso rompía el autolayout y la exportación a .drawio.
    type Mutate = (doc: typeof sampleDocument) => void;
    const cases: Array<[string, string, Mutate]> = [
      ['C2: añadir una persona existente sin posición', 'contenedores', (d) => {
        d.model.elements.push({ id: 'x', type: 'person', name: 'X' });
        d.views.find((v) => v.id === 'contenedores')!.elements.push({ id: 'x' });
      }],
      ['C2: añadir un contenedor nuevo dentro del boundary', 'contenedores', (d) => {
        d.model.elements.push({ id: 'x', type: 'container', name: 'X', parentId: 'banca' });
        d.views.find((v) => v.id === 'contenedores')!.elements.push({ id: 'x' });
      }],
      ['C2: quitar la posición a un solo contenedor', 'contenedores', (d) => {
        const e = d.views.find((v) => v.id === 'contenedores')!.elements.find((x) => x.id === 'db')!;
        delete e.x;
        delete e.y;
      }],
      ['C3: añadir un componente nuevo sin posición', 'componentes-api', (d) => {
        d.model.elements.push({ id: 'x', type: 'component', name: 'X', parentId: 'api' });
        d.views.find((v) => v.id === 'componentes-api')!.elements.push({ id: 'x' });
      }],
    ];

    for (const [label, viewId, mutate] of cases) {
      it(`${label}: el layout se completa, posiciona todo sin solapes y la exportación funciona`, async () => {
        const laid = await autoLayoutDocument(structuredClone(sampleDocument));
        mutate(laid);
        const again = await autoLayoutDocument(laid);
        const view = again.views.find((v) => v.id === viewId)!;
        expect(view.elements.every((e) => e.x !== undefined && e.y !== undefined)).toBe(true);
        const boxes = view.elements.map((e) => ({ x: e.x!, y: e.y!, width: e.width ?? 240, height: e.height ?? 130 }));
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i], boxes[j])).toBe(false);
        expect(() => toDrawio(again)).not.toThrow();
      });
    }
  });
});
