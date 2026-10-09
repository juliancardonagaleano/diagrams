import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ModuleSource } from '../modules-app/controller';
import { dataModule, enterpriseModule, integrationModule, platformModule, securityModule } from '../modules-app/testing';
import { heatLevel, TraceBoard } from './board';

const file = (name: string) => async () => readFileSync(`examples/${name}`, 'utf8');
const sources: ModuleSource[] = [
  { id: 'integration', label: 'Integración', load: async () => integrationModule, example: file('pedidos-integracion.json') },
  { id: 'data', label: 'Datos', load: async () => dataModule, example: file('ventas-datos.json') },
  { id: 'enterprise', label: 'Empresarial', load: async () => enterpriseModule, example: file('empresa-arquitectura.json') },
  { id: 'platform', label: 'Plataforma', load: async () => platformModule, example: file('plataforma-ejemplo.json') },
  { id: 'security', label: 'Seguridad', load: async () => securityModule, example: file('seguridad-ejemplo.json') },
];

describe('TraceBoard', () => {
  it('carga los ejemplos y forma el grafo transversal', async () => {
    const board = new TraceBoard(sources);
    const results = await board.loadExamples();
    expect(Object.values(results).every((r) => r.ok)).toBe(true);
    const graph = board.graph();
    expect(graph.documents.map((d) => d.module)).toEqual(['integration', 'data', 'enterprise', 'platform', 'security']);
    expect(graph.links).toHaveLength(15);
    expect(graph.problems).toEqual([]);
    expect(board.moduleLabels().security).toBe('Seguridad');
  });

  it('un documento con errores no sustituye al anterior y explica el motivo', async () => {
    const board = new TraceBoard(sources);
    await board.loadExample('security');
    const before = board.documents.get('security')!.document;

    const syntax = await board.load('security', '{ roto', 'pegado');
    expect(syntax).toMatchObject({ ok: false });
    expect(!syntax.ok && syntax.message).toMatch(/No es JSON válido/);

    const schema = await board.load('security', JSON.stringify({ version: '9.9', zones: 3 }), 'pegado');
    expect(!schema.ok && schema.message).toMatch(/No cumple el esquema del módulo/);

    expect(await board.load('security', '   ', 'pegado')).toEqual({ ok: false, message: 'El documento está vacío.' });
    expect(board.documents.get('security')!.document).toBe(before);
  });

  it('un módulo sin su documento deja los enlaces hacia él como «sin resolver» y quitarlo los actualiza', async () => {
    const board = new TraceBoard(sources);
    await board.loadExample('security');
    expect(board.graph().links).toEqual([]);
    expect(board.graph().problems.map((p) => p.reason)).toContain('unresolved');
    await board.loadExample('platform');
    await board.loadExample('integration');
    expect(board.graph().links).toHaveLength(11);
    board.remove('platform');
    expect(board.graph().links).toEqual([]);
    board.clear();
    expect(board.graph().nodes).toEqual([]);
  });

  it('el filtro por tipo de enlace deja ver solo esos enlaces y no oculta las referencias sin resolver', async () => {
    const board = new TraceBoard(sources);
    await board.loadExamples();
    expect(board.linkTypes()).toEqual([
      { type: 'protects', count: 5 },
      { type: 'implements', count: 4 },
      { type: 'realizes', count: 3 },
      { type: 'deploys', count: 2 },
      { type: 'derives', count: 1 },
    ]);
    board.toggleType('implements', true);
    board.toggleType('protects', true);
    expect(board.graph().links).toHaveLength(9);
    expect(board.fullGraph().links).toHaveLength(15);
    expect(board.graph().nodes).toHaveLength(board.fullGraph().nodes.length);
    board.toggleType('protects', false);
    expect(board.graph().links.map((l) => l.type)).toEqual(['implements', 'implements', 'implements', 'implements']);
    board.setTypes([]);
    expect(board.graph().links).toHaveLength(15);

    // un tipo que ya no está en ningún documento no deja el grafo vacío: el filtro lo ignora
    board.setTypes(['derives']);
    expect(board.graph().links).toHaveLength(1);
    board.remove('data');
    expect(board.activeTypes()).toEqual([]);
    expect(board.graph().links).toHaveLength(14);

    const lonely = new TraceBoard(sources);
    await lonely.loadExample('security');
    lonely.setTypes(['protects']);
    expect(lonely.graph().problems.map((p) => p.reason)).toContain('unresolved');
  });

  it('los huérfanos, la matriz y la cobertura se calculan sobre lo que el filtro deja ver', async () => {
    const board = new TraceBoard(sources);
    await board.loadExamples();
    expect(board.orphans({ module: 'security', kind: 'zone' })).toMatchObject({ considered: 4, count: 4 });
    expect(board.matrix('module')).toMatchObject({ total: 15, rows: ['data', 'enterprise', 'platform', 'security'] });
    board.setTypes(['implements']);
    expect(board.matrix('kind').total).toBe(4);
    expect(board.orphans({ module: 'security', kind: 'asset' }).count).toBe(11); // sin los enlaces `protects`, ninguno está enlazado
    board.setTypes([]);
    expect(board.orphans({ module: 'security', kind: 'asset' }).count).toBe(6);
    expect(() => board.orphans({ module: 'nada' })).toThrow(/no está entre los documentos aportados/);
  });

  it('las reglas de cobertura son un texto de una regla por línea; una línea mala no impide medir las demás', async () => {
    const board = new TraceBoard(sources);
    await board.loadExamples();
    expect(board.coverage()).toEqual({ results: [], errors: [] });
    board.coverageText = ['# cada activo de seguridad enlaza con la plataforma', 'security:asset -> platform', '', '   ', 'platform:service → integration', 'sin flecha', 'nada -> platform', 'security:asset -> nada'].join('\n');
    const view = board.coverage();
    expect(view.results.map((r) => [r.rule.text, r.percent])).toEqual([
      ['security:asset -> platform', 45.5],
      ['platform:service -> integration', 66.7],
    ]);
    expect(view.errors.map((e) => [e.line, e.text])).toEqual([
      [6, 'sin flecha'],
      [7, 'nada -> platform'],
      [8, 'security:asset -> nada'],
    ]);
    expect(view.errors[0].message).toMatch(/forma origen -> destino/);
    expect(view.errors[1].message).toMatch(/no existe el módulo «nada»/);
    board.setTypes(['protects']);
    expect(board.coverage().results.map((r) => r.percent)).toEqual([45.5, 0]);
  });

  it('heatLevel reparte el color en cuatro niveles y deja el cero sin color', () => {
    expect([0, 1, 2, 3, 4, 5].map((n) => heatLevel(n, 5))).toEqual([0, 1, 2, 3, 4, 4]);
    expect(heatLevel(0, 0)).toBe(0);
    expect(heatLevel(3, 0)).toBe(0);
    expect([1, 5, 6, 10].map((n) => heatLevel(n, 20))).toEqual([1, 1, 2, 2]);
    expect(heatLevel(20, 20)).toBe(4);
  });

  it('rechaza un módulo que el tablero no ofrece', async () => {
    const board = new TraceBoard(sources);
    await expect(board.load('nada', '{}', 'x')).rejects.toThrow(/no ofrece el módulo «nada»/);
  });
});
