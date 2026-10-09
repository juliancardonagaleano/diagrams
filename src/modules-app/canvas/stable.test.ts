import { describe, expect, it } from 'vitest';
import type { EditorSpec } from '@iark/kernel';
import { fakeEditor, type FakeDoc } from '../testing-editor';
import { buildFlow } from './flow';
import { decorateEdges, decorateNodes, type EdgeCache, type NodeCache } from './stable';

/**
 * Identidad estable de los objetos que se entregan a React Flow: seleccionar o arrastrar un nodo no debe rehacer los demás, porque
 * React Flow compara por identidad y repinta todo lo que cambia (con cientos de nodos montados, eso es lo que arrastra el lienzo).
 */
const spec = fakeEditor as unknown as EditorSpec<unknown>;

const doc: FakeDoc = {
  nodes: [
    { id: 'zona', kind: 'zone', name: 'Zona' },
    { id: 'a', kind: 'service', name: 'A', zone: 'zona' },
    { id: 'b', kind: 'service', name: 'B', zone: 'zona' },
    { id: 'c', kind: 'queue', name: 'C' },
  ],
  edges: [
    { id: 'a-b', source: 'a', target: 'b', kind: 'sync' },
    { id: 'b-c', source: 'b', target: 'c', kind: 'async', step: 1 },
  ],
  contracts: [],
};
const graph = spec.project(doc);
const pick = (): void => {};

const flow = (moved: ReadonlyMap<string, { x: number; y: number }> = new Map()) => buildFlow(spec, graph, undefined, moved);

describe('decorateNodes', () => {
  it('sin cambios, entrega los mismos objetos aunque buildFlow haya rehecho todos', () => {
    const cache = new Map<string, NodeCache>();
    const first = decorateNodes(flow().nodes, new Set(), undefined, cache);
    const again = decorateNodes(flow().nodes, new Set(), undefined, cache);
    expect(again).toHaveLength(first.length);
    again.forEach((node, i) => expect(node).toBe(first[i]));
  });

  it('al seleccionar un nodo, solo ese cambia de objeto', () => {
    const cache = new Map<string, NodeCache>();
    const before = decorateNodes(flow().nodes, new Set(), undefined, cache);
    const after = decorateNodes(flow().nodes, new Set(['b']), undefined, cache);
    const changed = after.filter((node, i) => node !== before[i]).map((n) => n.id);
    expect(changed).toEqual(['b']);
    expect(after.find((n) => n.id === 'b')!.selected).toBe(true);
    expect(after.filter((n) => n.id !== 'b').every((n) => n.selected === false)).toBe(true);
  });

  it('al mover un nodo, solo ese cambia de objeto y lleva su posición nueva', () => {
    const cache = new Map<string, NodeCache>();
    const before = decorateNodes(flow().nodes, new Set(), undefined, cache);
    const after = decorateNodes(flow(new Map([['c', { x: 900, y: 40 }]])).nodes, new Set(), undefined, cache);
    expect(after.filter((node, i) => node !== before[i]).map((n) => n.id)).toEqual(['c']);
    expect(after.find((n) => n.id === 'c')!.position).toEqual({ x: 900, y: 40 });
  });

  it('la marca de comparación solo toca al nodo marcado y se quita al desaparecer', () => {
    const cache = new Map<string, NodeCache>();
    const plain = decorateNodes(flow().nodes, new Set(), undefined, cache);
    const marked = decorateNodes(flow().nodes, new Set(), new Map([['a', 'modified' as const]]), cache);
    expect(marked.filter((node, i) => node !== plain[i]).map((n) => n.id)).toEqual(['a']);
    expect(marked.find((n) => n.id === 'a')!.data.diff).toBe('modified');
    const cleared = decorateNodes(flow().nodes, new Set(), undefined, cache);
    expect(cleared.find((n) => n.id === 'a')!.data.diff).toBeUndefined();
  });

  it('un nodo que desaparece sale de la caché', () => {
    const cache = new Map<string, NodeCache>();
    decorateNodes(flow().nodes, new Set(), undefined, cache);
    expect(cache.has('c')).toBe(true);
    decorateNodes(flow().nodes.filter((n) => n.id !== 'c'), new Set(), undefined, cache);
    expect(cache.has('c')).toBe(false);
  });
});

describe('decorateEdges', () => {
  it('sin cambios, entrega los mismos objetos; al seleccionar una arista, solo esa cambia', () => {
    const cache = new Map<string, EdgeCache>();
    const first = decorateEdges(flow().edges, new Set(), pick, undefined, cache);
    const again = decorateEdges(flow().edges, new Set(), pick, undefined, cache);
    again.forEach((edge, i) => expect(edge).toBe(first[i]));
    const selected = decorateEdges(flow().edges, new Set(['b-c']), pick, undefined, cache);
    expect(selected.filter((edge, i) => edge !== first[i]).map((e) => e.id)).toEqual(['b-c']);
    expect(selected.find((e) => e.id === 'b-c')!.selected).toBe(true);
  });

  it('cada arista lleva la función de elegir desde la etiqueta; si cambia, se rehacen', () => {
    const cache = new Map<string, EdgeCache>();
    const first = decorateEdges(flow().edges, new Set(), pick, undefined, cache);
    expect(first.every((e) => e.data.onPick === pick)).toBe(true);
    const other = (): void => {};
    const next = decorateEdges(flow().edges, new Set(), other, undefined, cache);
    expect(next.every((e, i) => e !== first[i] && e.data.onPick === other)).toBe(true);
  });

  it('la marca de comparación solo toca a la arista marcada', () => {
    const cache = new Map<string, EdgeCache>();
    const plain = decorateEdges(flow().edges, new Set(), pick, undefined, cache);
    const marked = decorateEdges(flow().edges, new Set(), pick, new Map([['a-b', 'added' as const]]), cache);
    expect(marked.filter((edge, i) => edge !== plain[i]).map((e) => e.id)).toEqual(['a-b']);
    expect(marked.find((e) => e.id === 'a-b')!.data.diff).toBe('added');
  });
});
