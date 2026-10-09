import { describe, expect, it, vi } from 'vitest';
import type { EditorSpec } from '@iark/kernel';
import { FAKE_DOC, fakeEditor, type FakeDoc } from '../testing-editor';
import { actionAvailability, applySelectionChanges, describeSelection, focusNodes, NO_SELECTION, removeAll, resolveSelection, toggleSelected } from './selection';

const spec = fakeEditor as unknown as EditorSpec<unknown>;
const graph = fakeEditor.project(FAKE_DOC);
const action = (id: string) => fakeEditor.actions!.find((a) => a.id === id)! as never;

describe('selección controlada', () => {
  it('aplica solo los cambios de selección de React Flow y mantiene la identidad si no cambia nada', () => {
    const a = applySelectionChanges(NO_SELECTION, [
      { type: 'select', id: 'api', selected: true },
      { type: 'position', id: 'api' },
      { type: 'select', id: 'cola', selected: true },
      { type: 'dimensions', id: 'cola' },
    ]);
    expect([...a]).toEqual(['api', 'cola']);
    expect(applySelectionChanges(a, [{ type: 'select', id: 'api', selected: true }])).toBe(a);
    expect([...applySelectionChanges(a, [{ type: 'select', id: 'api', selected: false }])]).toEqual(['cola']);
    expect(applySelectionChanges(NO_SELECTION, [{ type: 'select', id: 'x', selected: false }])).toBe(NO_SELECTION);
  });

  it('un mismo lote puede seleccionar y deseleccionar el mismo elemento', () => {
    const next = applySelectionChanges(NO_SELECTION, [
      { type: 'select', id: 'api', selected: true },
      { type: 'select', id: 'api', selected: false },
    ]);
    expect(next.size).toBe(0);
  });

  it('alterna un elemento sin modificar la selección anterior', () => {
    const one = new Set(['api']);
    expect([...toggleSelected(one, 'cola')]).toEqual(['api', 'cola']);
    expect([...toggleSelected(one, 'api')]).toEqual([]);
    expect([...one]).toEqual(['api']);
  });

  it('solo cuentan los ids que existen en el grafo, nodos primero y aristas después', () => {
    const ids = resolveSelection(graph, new Set(['cola-worker', 'fantasma', 'worker', 'api']));
    expect(ids).toEqual(['api', 'worker', 'cola-worker']);
    expect(resolveSelection(undefined, new Set(['api']))).toEqual([]);
    expect(resolveSelection(graph, NO_SELECTION)).toEqual([]);
  });

  it('describe cada elemento con su nombre y el tipo de la notación; las relaciones, con sus extremos', () => {
    expect(describeSelection(spec, graph, ['api', 'api-cola', 'fantasma'])).toEqual([
      { id: 'api', title: 'API', kind: 'Servicio' },
      { id: 'api-cola', title: 'API → Cola de pedidos', kind: 'Asíncrona' },
    ]);
  });

  it('encuadra un nodo por sí mismo y una relación por sus dos extremos', () => {
    expect(focusNodes(graph, 'api')).toEqual(['api']);
    expect(focusNodes(graph, 'cola-worker')).toEqual(['cola', 'worker']);
    expect(focusNodes(graph, 'nada')).toEqual([]);
  });
});

describe('borrado encadenado', () => {
  it('aplica spec.remove sobre el documento resultante y salta lo que cayó con otro elemento', () => {
    const result = removeAll(spec, FAKE_DOC, ['api', 'api-cola', 'worker']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = result.document as FakeDoc;
    expect(doc.nodes.map((n) => n.id)).toEqual(['zona', 'cola', 'libre']);
    expect(doc.edges).toEqual([]);
  });

  it('si un borrado falla no devuelve un documento a medias', () => {
    const failing = { ...fakeEditor, remove: (doc: FakeDoc, id: string) => (id === 'cola' ? { ok: false as const, reason: 'La cola está protegida.' } : fakeEditor.remove(doc, id)) };
    const result = removeAll(failing as unknown as EditorSpec<unknown>, FAKE_DOC, ['api', 'cola', 'worker']);
    expect(result).toEqual({ ok: false, reason: 'La cola está protegida.' });
  });

  it('con una selección vacía devuelve el documento tal cual', () => {
    expect(removeAll(spec, FAKE_DOC, [])).toEqual({ ok: true, document: FAKE_DOC });
  });
});

describe('disponibilidad de las acciones', () => {
  it('«none» siempre, «one» con exactamente uno y «many» con uno o más', () => {
    expect(actionAvailability(action('renumber'), FAKE_DOC, [], false).enabled).toBe(true);
    expect(actionAvailability(action('inspect'), FAKE_DOC, [], false)).toEqual({ enabled: false, title: 'Selecciona un único elemento.' });
    expect(actionAvailability(action('inspect'), FAKE_DOC, ['api', 'worker'], false).enabled).toBe(false);
    expect(actionAvailability(action('inspect'), FAKE_DOC, ['api'], false).enabled).toBe(true);
    expect(actionAvailability(action('group'), FAKE_DOC, [], false)).toEqual({ enabled: false, title: 'Selecciona al menos un elemento.' });
    expect(actionAvailability(action('group'), FAKE_DOC, ['api', 'worker'], false)).toEqual({ enabled: true, title: 'Mete los servicios seleccionados en una zona' });
  });

  it('disabled() del módulo pone el motivo en el título', () => {
    expect(actionAvailability(action('inspect'), FAKE_DOC, ['cola'], false)).toEqual({ enabled: false, title: 'Las colas no se revisan.' });
  });

  it('en solo lectura ninguna está disponible', () => {
    expect(actionAvailability(action('renumber'), FAKE_DOC, [], true).enabled).toBe(false);
  });

  it('pasa al disabled() del módulo la vista abierta (una acción de C4 depende de la vista en que se está)', () => {
    const disabled = vi.fn((_doc: unknown, _ids: string[], viewId?: string) => (viewId === 'contexto' ? 'No aquí.' : undefined));
    const porVista = { id: 'up', label: 'Subir nivel', needs: 'none', disabled, run: () => ({ ok: false, reason: 'no' }) } as never;
    expect(actionAvailability(porVista, FAKE_DOC, [], false, 'contexto')).toEqual({ enabled: false, title: 'No aquí.' });
    expect(actionAvailability(porVista, FAKE_DOC, [], false, 'contenedores').enabled).toBe(true);
    expect(disabled).toHaveBeenLastCalledWith(FAKE_DOC, [], 'contenedores');
    // Sin vista, los módulos que no la usan siguen recibiendo lo de siempre.
    expect(actionAvailability(action('inspect'), FAKE_DOC, ['api'], false).enabled).toBe(true);
  });
});
