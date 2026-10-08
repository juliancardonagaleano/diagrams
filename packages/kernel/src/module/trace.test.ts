import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_LINK_TYPE, TRACE_LINK_TYPES, isSuggestedLinkType, isValidLinkType, refTypeSchema } from './link-types';
import type { AnyModule } from './operations';
import { buildTraceGraph, countLinkTypes, traceFilterTypes, traceMermaid, traceReach, traceReachReport, traceReport, type TraceGraph } from './trace';
import {
  coverageShortfalls,
  matrixCount,
  matrixTypes,
  parseCoverageRule,
  parseTraceSelector,
  traceCoverage,
  traceCoverageReport,
  traceMatrix,
  traceMatrixReport,
  traceOrphans,
  traceOrphansReport,
} from './trace-analysis';
import { traceSvg } from './trace-svg';
import type { DomainModule } from './types';

interface Item {
  id: string;
  name: string;
  kind: string;
  ref?: string;
  refType?: string;
}
interface Doc {
  items: Item[];
}

/** Un módulo mínimo cuyos elementos son los `items` del documento: lo justo para construir un grafo sin depender de ningún dominio. */
function fake(id: string): AnyModule {
  const module: DomainModule<Doc> = {
    id,
    name: id,
    version: '1.0.0',
    documentVersion: '1.0',
    schema: z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string(), ref: z.string().optional(), refType: z.string().optional() })) }),
    jsonSchema: () => ({}),
    validate: () => [],
    importers: [],
    exporters: [],
    entities: (doc) => doc.items.map(({ id: itemId, name, kind }) => ({ id: itemId, name, kind })),
  };
  return module;
}

const item = (id: string, kind: string, extra: Partial<Item> = {}): Item => ({ id, name: id.toUpperCase(), kind, ...extra });

const security = fake('security');
const platform = fake('platform');
const integration = fake('integration');

/** Una cadena seguridad → plataforma → integración con tipos distintos, un tipo propio y elementos sin enlazar. */
function chain(): TraceGraph {
  return buildTraceGraph([
    {
      module: security,
      source: 'seguridad.json',
      document: {
        items: [
          item('a1', 'asset', { ref: 'urn:iark:platform:s1', refType: 'protects' }),
          item('a2', 'asset', { ref: 'urn:iark:platform:s2' }),
          item('a3', 'asset'),
          item('z1', 'zone'),
        ],
      },
    },
    {
      module: platform,
      source: 'plataforma.json',
      document: {
        items: [
          item('s1', 'service', { ref: 'urn:iark:integration:i1', refType: 'implements' }),
          item('s2', 'service', { ref: 'urn:iark:integration:i1' }),
          item('s3', 'service'),
          item('r1', 'resource', { ref: 'urn:iark:integration:i2', refType: 'mi-tipo' }),
        ],
      },
    },
    { module: integration, source: 'integracion.json', document: { items: [item('i1', 'system'), item('i2', 'system')] } },
  ]);
}

describe('tipos de enlace', () => {
  it('el vocabulario sugerido abre con depends-on y cada tipo trae su descripción', () => {
    expect(TRACE_LINK_TYPES[0].id).toBe(DEFAULT_LINK_TYPE);
    expect(TRACE_LINK_TYPES.map((t) => t.id)).toEqual(['depends-on', 'implements', 'deploys', 'protects', 'realizes', 'derives', 'documents']);
    expect(TRACE_LINK_TYPES.every((t) => t.description.length > 10)).toBe(true);
    expect(isSuggestedLinkType('protects')).toBe(true);
    expect(isSuggestedLinkType('mi-tipo')).toBe(false);
  });

  it('un tipo válido es minúsculas, dígitos y guiones empezando por letra; el esquema lo comprueba', () => {
    for (const ok of ['implements', 'mi-tipo', 'v2', 'a']) expect(isValidLinkType(ok), ok).toBe(true);
    for (const bad of ['', 'Implements', '2d', '-x', 'con espacio', 'a_b', 'x'.repeat(41)]) expect(isValidLinkType(bad), bad).toBe(false);
    expect(refTypeSchema.safeParse('deploys').success).toBe(true);
    expect(refTypeSchema.safeParse('Mal Tipo').success).toBe(false);
    expect(refTypeSchema.optional().safeParse(undefined).success).toBe(true);
  });

  it('todo enlace trae su tipo: depends-on cuando el elemento no declara refType', () => {
    const graph = chain();
    const type = (from: string): string => graph.links.find((l) => l.from === `urn:iark:${from}`)!.type;
    expect(type('security:a1')).toBe('protects');
    expect(type('security:a2')).toBe('depends-on');
    expect(type('platform:s1')).toBe('implements');
    expect(graph.links).toHaveLength(5);
    expect(graph.links.every((l) => typeof l.type === 'string' && l.type.length > 0)).toBe(true);
  });

  it('un tipo fuera del vocabulario se acepta como tipo del enlace y deja un aviso informativo, nunca un problema', () => {
    const graph = chain();
    expect(graph.links.find((l) => l.from === 'urn:iark:platform:r1')!.type).toBe('mi-tipo');
    expect(graph.problems).toEqual([]);
    expect(graph.notices).toEqual([expect.objectContaining({ from: 'urn:iark:platform:r1', type: 'mi-tipo', reason: 'unknown-type' })]);
    expect(graph.notices[0].message).toMatch(/«mi-tipo» no está en el vocabulario sugerido/);
  });

  it('un tipo mal formado cuenta como depends-on y avisa; los tipos del vocabulario no avisan', () => {
    const graph = buildTraceGraph([
      { module: security, document: { items: [item('a', 'asset', { ref: 'urn:iark:platform:s', refType: 'Mal Tipo' }), item('b', 'asset', { ref: 'urn:iark:platform:s', refType: 'protects' })] } },
      { module: platform, document: { items: [item('s', 'service')] } },
    ]);
    expect(graph.links.map((l) => [l.from, l.type])).toEqual([
      ['urn:iark:security:a', 'depends-on'],
      ['urn:iark:security:b', 'protects'],
    ]);
    expect(graph.notices).toHaveLength(1);
    expect(graph.notices[0]).toMatchObject({ from: 'urn:iark:security:a', type: 'Mal Tipo', reason: 'invalid-type' });
  });

  it('un refType que no es texto se ignora; sin refType el grafo no trae avisos', () => {
    const graph = buildTraceGraph([
      { module: security, document: { items: [{ ...item('a', 'asset', { ref: 'urn:iark:platform:s' }), refType: 3 }] } },
      { module: platform, document: { items: [item('s', 'service')] } },
    ]);
    expect(graph.links).toEqual([{ from: 'urn:iark:security:a', to: 'urn:iark:platform:s', type: 'depends-on' }]);
    expect(graph.notices).toEqual([]);
  });

  it('el tipo no cambia lo que es una referencia rota: dangling, invalid y unresolved siguen igual', () => {
    const graph = buildTraceGraph([
      {
        module: security,
        document: {
          items: [
            item('a', 'asset', { ref: 'urn:iark:platform:no-existe', refType: 'protects' }),
            item('b', 'asset', { ref: 'nada', refType: 'protects' }),
            item('c', 'asset', { ref: 'urn:iark:integration:x', refType: 'protects' }),
          ],
        },
      },
      { module: platform, document: { items: [] } },
    ]);
    expect(graph.links).toEqual([]);
    expect(graph.problems.map((p) => p.reason)).toEqual(['dangling', 'invalid', 'unresolved']);
  });

  it('filtrar por tipo deja solo esos enlaces y no oculta referencias rotas ni elementos', () => {
    const graph = chain();
    const only = traceFilterTypes(graph, ['implements', 'protects']);
    expect(only.links.map((l) => l.type).sort()).toEqual(['implements', 'protects']);
    expect(only.nodes).toBe(graph.nodes);
    expect(only.problems).toBe(graph.problems);
    expect(traceFilterTypes(graph, [])).toBe(graph);
    expect(traceFilterTypes(graph)).toBe(graph);
    expect(traceFilterTypes(graph, ['no-existe']).links).toEqual([]);
  });
});

describe('alcance con tipos', () => {
  it('traceReach con types solo atraviesa los enlaces de esos tipos', () => {
    const graph = chain();
    const all = traceReach(graph, 'urn:iark:integration:i1', { direction: 'referrers' }).map((r) => r.node.id).sort();
    expect(all).toEqual(['a1', 'a2', 'i1', 's1', 's2']);
    const impl = traceReach(graph, 'urn:iark:integration:i1', { direction: 'referrers', types: ['implements'] });
    expect(impl.map((r) => r.node.id)).toEqual(['i1', 's1']);
    expect(impl[1].via).toEqual({ from: 'urn:iark:platform:s1', to: 'urn:iark:integration:i1', type: 'implements' });
    // los tipos se combinan: s1 (implements) y luego a1 (protects) por el segundo salto
    const both = traceReach(graph, 'urn:iark:integration:i1', { direction: 'referrers', types: ['implements', 'protects'] });
    expect(both.map((r) => r.node.id).sort()).toEqual(['a1', 'i1', 's1']);
    expect(traceReach(graph, 'urn:iark:integration:i1', { types: ['no-existe'] }).map((r) => r.node.id)).toEqual(['i1']);
    expect(traceReach(graph, 'urn:iark:integration:i1', { types: [] })).toHaveLength(all.length);
  });

  it('el informe del alcance nombra el tipo del enlace salvo el de por omisión', () => {
    const graph = chain();
    const text = traceReachReport(traceReach(graph, 'urn:iark:integration:i1', { direction: 'referrers' }), 'referrers');
    expect(text).toMatch(/platform:s1 \(S1\) · service · enlace implements/);
    expect(text).toMatch(/platform:s2 \(S2\) · service\n/);
    expect(text).toMatch(/security:a1 \(A1\) · asset · a 2 saltos · enlace protects/);
  });
});

describe('informes con tipos', () => {
  it('el informe suma los tipos y los pone junto al enlace; los avisos van aparte', () => {
    const report = traceReport(chain());
    expect(report).toContain('Por tipo: depends-on 2, implements 1, mi-tipo 1, protects 1.');
    expect(report).toContain('- security:a1 (A1) → platform:s1 (S1) · protects');
    expect(report).toContain('- security:a2 (A2) → platform:s2 (S2)\n');
    expect(report).toContain('### Avisos');
    expect(report).toMatch(/platform:r1 \(R1\): el tipo de enlace «mi-tipo» no está/);
  });

  it('sin refType el informe y el Mermaid quedan como antes de los tipos', () => {
    const graph = buildTraceGraph([
      { module: security, document: { items: [item('a', 'asset', { ref: 'urn:iark:platform:s' })] } },
      { module: platform, document: { items: [item('s', 'service')] } },
    ]);
    const report = traceReport(graph);
    expect(report).not.toContain('Por tipo');
    expect(report).not.toContain('Avisos');
    expect(report.endsWith('- security:a (A) → platform:s (S)')).toBe(true);
    expect(traceMermaid(graph)).toContain('n0 -.-> n1');
  });

  it('el Mermaid rotula las aristas con su tipo, menos depends-on', () => {
    const mermaid = traceMermaid(chain());
    expect(mermaid).toContain('-.->|protects|');
    expect(mermaid).toContain('-.->|implements|');
    expect(mermaid).toContain('-.->|mi-tipo|');
    expect((mermaid.match(/-\.->/g) ?? []).length).toBe(5);
    expect((mermaid.match(/-\.-> n/g) ?? []).length).toBe(2); // las dos depends-on, sin etiqueta
  });

  it('el SVG rotula las aristas con su tipo, menos depends-on', async () => {
    const svg = await traceSvg(chain());
    expect((svg.match(/marker-end="url\(#arrow\)"/g) ?? []).length).toBe(5);
    for (const type of ['protects', 'implements', 'mi-tipo']) expect(svg).toContain(`>${type}<`);
    expect(svg).not.toContain('>depends-on<');
  });

  it('countLinkTypes ordena por frecuencia y luego por nombre', () => {
    expect(countLinkTypes(chain().links)).toEqual([
      ['depends-on', 2],
      ['implements', 1],
      ['mi-tipo', 1],
      ['protects', 1],
    ]);
  });
});

describe('huérfanos', () => {
  it('lista los elementos sin enlaces entrantes ni salientes, por módulo y tipo de elemento', () => {
    const orphans = traceOrphans(chain());
    expect(orphans.considered).toBe(10);
    expect(orphans.count).toBe(3);
    expect(orphans.groups.map((g) => [g.module, g.kind, g.total, g.orphans.map((n) => n.id)])).toEqual([
      ['security', 'asset', 3, ['a3']],
      ['security', 'zone', 1, ['z1']],
      ['platform', 'service', 3, ['s3']],
    ]);
  });

  it('un elemento que solo recibe enlaces no es huérfano', () => {
    const ids = traceOrphans(chain()).groups.flatMap((g) => g.orphans.map((n) => n.id));
    expect(ids).not.toContain('i1');
    expect(ids).not.toContain('s1');
  });

  it('filtra por módulo y por módulo y tipo', () => {
    const graph = chain();
    const platformOnly = traceOrphans(graph, { module: 'platform' });
    expect(platformOnly.considered).toBe(4);
    expect(platformOnly.groups.map((g) => g.module)).toEqual(['platform']);
    const zones = traceOrphans(graph, { module: 'security', kind: 'zone' });
    expect(zones).toMatchObject({ considered: 1, count: 1 });
    expect(traceOrphans(graph, { module: 'security', kind: 'asset' }).groups[0].orphans.map((n) => n.id)).toEqual(['a3']);
    expect(traceOrphans(graph, { module: 'integration' })).toMatchObject({ considered: 2, count: 0, groups: [] });
    expect(traceOrphans(graph, { module: 'security', kind: 'no-hay' })).toMatchObject({ considered: 0, count: 0 });
  });

  it('un módulo que no se aportó es un error; un enlace sin resolver no cuenta como enlace', () => {
    expect(() => traceOrphans(chain(), { module: 'data' })).toThrow(/«data» no está entre los documentos aportados \(security, platform, integration\)/);
    const alone = buildTraceGraph([{ module: security, document: { items: [item('a', 'asset', { ref: 'urn:iark:platform:s' })] } }]);
    expect(alone.problems).toHaveLength(1);
    expect(traceOrphans(alone).count).toBe(1);
  });

  it('el informe agrupa y cuenta; sin huérfanos lo dice', () => {
    const text = traceOrphansReport(traceOrphans(chain()));
    expect(text).toContain('Huérfanos: 3 de 10 elementos no tienen ningún enlace.');
    expect(text).toContain('**security · asset** (1 de 3)');
    expect(text).toContain('- a3 (A3)');
    expect(traceOrphansReport(traceOrphans(chain(), { module: 'integration' }))).toContain('Todos los elementos examinados están enlazados.');
    expect(traceOrphansReport(traceOrphans(chain(), { module: 'security', kind: 'zone' }))).toContain('Huérfanos en security:zone: 1 de 1');
  });
});

describe('matriz', () => {
  it('cuenta los enlaces por par de módulos, con totales y el desglose por tipo de enlace', () => {
    const matrix = traceMatrix(chain(), { by: 'module' });
    expect(matrix.rows).toEqual(['security', 'platform']);
    expect(matrix.columns).toEqual(['platform', 'integration']);
    expect(matrix.total).toBe(5);
    expect(matrixCount(matrix, 'security', 'platform')).toBe(2);
    expect(matrixCount(matrix, 'platform', 'integration')).toBe(3);
    expect(matrixCount(matrix, 'security', 'integration')).toBe(0);
    expect(matrix.cells.find((c) => c.from === 'security')!.types).toEqual({ protects: 1, 'depends-on': 1 });
    expect(matrix.cells.find((c) => c.from === 'platform')!.types).toEqual({ implements: 1, 'depends-on': 1, 'mi-tipo': 1 });
    expect(matrix.rowTotals).toEqual({ security: 2, platform: 3 });
    expect(matrix.columnTotals).toEqual({ platform: 2, integration: 3 });
    expect(matrix.types).toEqual({ protects: 1, 'depends-on': 2, implements: 1, 'mi-tipo': 1 });
    expect(matrixTypes(matrix)).toEqual(['depends-on', 'implements', 'mi-tipo', 'protects']);
  });

  it('por tipo de elemento cruza módulo:tipo', () => {
    const matrix = traceMatrix(chain(), { by: 'kind' });
    expect(matrix.rows).toEqual(['security:asset', 'platform:resource', 'platform:service']);
    expect(matrix.columns).toEqual(['platform:service', 'integration:system']);
    expect(matrixCount(matrix, 'security:asset', 'platform:service')).toBe(2);
    expect(matrixCount(matrix, 'platform:service', 'integration:system')).toBe(2);
    expect(matrixCount(matrix, 'platform:resource', 'integration:system')).toBe(1);
    expect(matrix.cells.reduce((n, c) => n + c.count, 0)).toBe(matrix.total);
  });

  it('un grafo sin enlaces da una matriz vacía y su informe lo dice', () => {
    const matrix = traceMatrix(buildTraceGraph([{ module: security, document: { items: [item('a', 'asset')] } }]), { by: 'module' });
    expect(matrix).toMatchObject({ rows: [], columns: [], cells: [], total: 0, types: {} });
    expect(traceMatrixReport(matrix)).toContain('No hay enlaces entre los documentos aportados.');
  });

  it('el informe es una tabla con totales y, con varios tipos, el desglose por tipo', () => {
    const text = traceMatrixReport(traceMatrix(chain(), { by: 'module' }));
    expect(text).toContain('Matriz de trazabilidad por módulo: 5 enlaces.');
    expect(text).toContain('| Origen \\ Destino | platform | integration | Total |');
    expect(text).toContain('| security | 2 | 0 | 2 |');
    expect(text).toContain('| platform | 0 | 3 | 3 |');
    expect(text).toContain('| **Total** | 2 | 3 | 5 |');
    expect(text).toContain('Desglose por tipo de enlace:');
    expect(text).toContain('| Origen → Destino | depends-on | implements | mi-tipo | protects | Total |');
    expect(text).toContain('| security → platform | 1 | 0 | 0 | 1 | 2 |');
    expect(traceMatrixReport(traceMatrix(chain(), { by: 'kind' }))).toContain('por tipo de elemento');
  });

  it('con un solo tipo de enlace el informe no repite el desglose', () => {
    const graph = traceFilterTypes(chain(), ['implements']);
    expect(traceMatrixReport(traceMatrix(graph, { by: 'module' }))).not.toContain('Desglose');
  });
});

describe('cobertura', () => {
  it('lee las reglas origen -> destino con módulo o módulo:tipo, con -> o →', () => {
    expect(parseCoverageRule('security:asset -> platform')).toEqual({
      text: 'security:asset -> platform',
      origin: { module: 'security', kind: 'asset' },
      destination: { module: 'platform' },
    });
    expect(parseCoverageRule('platform:service→integration:system').text).toBe('platform:service -> integration:system');
    expect(parseCoverageRule(' data-x  ->  c4 ')).toMatchObject({ origin: { module: 'data-x' }, destination: { module: 'c4' } });
    expect(parseTraceSelector('security')).toEqual({ module: 'security' });
    for (const bad of ['security', 'a -> ', '-> b', 'Security -> platform', 'a:b:c -> d', 'a -> b -> c']) {
      expect(() => parseCoverageRule(bad), bad).toThrow(/regla de cobertura/);
    }
    expect(() => parseTraceSelector('MAL')).toThrow(/no es un módulo ni un módulo:tipo/);
  });

  it('mide el porcentaje y lista los cubiertos y los SIN cubrir', () => {
    const [result] = traceCoverage(chain(), ['security:asset -> platform']);
    expect(result).toMatchObject({ applicable: true, total: 3, percent: 66.7 });
    expect(result.covered.map((n) => n.id)).toEqual(['a1', 'a2']);
    expect(result.uncovered.map((n) => n.id)).toEqual(['a3']);
    expect(result.note).toBeUndefined();
  });

  it('un origen sin elementos no es aplicable: ni 100 % ni 0 %, y la nota lo explica', () => {
    const graph = chain();
    const [byKind, byModule, noDestination] = traceCoverage(graph, ['security:control -> platform', 'data -> platform', 'security:asset -> data']);
    expect(byKind).toMatchObject({ applicable: false, total: 0, percent: null, covered: [], uncovered: [] });
    expect(byKind.note).toMatch(/no hay elementos de tipo «control» en «security» \(tipos presentes: asset, zone\).*no es aplicable/);
    expect(byModule).toMatchObject({ applicable: false, percent: null });
    expect(byModule.note).toMatch(/módulo de origen «data» no está entre los documentos aportados/);
    // un destino ausente no hace la regla inaplicable: nada puede cubrir el origen
    expect(noDestination).toMatchObject({ applicable: true, total: 3, percent: 0 });
    expect(noDestination.note).toMatch(/módulo de destino «data» no está entre los documentos aportados/);
  });

  it('el tipo del destino cuenta, la dirección importa y un elemento no se cubre a sí mismo', () => {
    const graph = chain();
    expect(traceCoverage(graph, ['platform:service -> integration:system'])[0]).toMatchObject({ total: 3, percent: 66.7 });
    expect(traceCoverage(graph, ['platform:service -> security'])[0]).toMatchObject({ total: 3, percent: 0 }); // los enlaces van de seguridad a plataforma, no al revés
    expect(traceCoverage(graph, ['integration -> platform'])[0]).toMatchObject({ total: 2, percent: 0 });
    const selfLinked = buildTraceGraph([{ module: security, document: { items: [item('a', 'asset', { ref: 'urn:iark:security:a' })] } }]);
    expect(traceCoverage(selfLinked, ['security -> security'])[0]).toMatchObject({ total: 1, percent: 0 });
  });

  it('con un grafo filtrado por tipo solo cuentan los enlaces de ese tipo', () => {
    const graph = chain();
    expect(traceCoverage(graph, ['security:asset -> platform'])[0].percent).toBe(66.7);
    expect(traceCoverage(traceFilterTypes(graph, ['protects']), ['security:asset -> platform'])[0]).toMatchObject({ percent: 33.3, covered: [expect.objectContaining({ id: 'a1' })] });
  });

  it('los mínimos comparan sin redondear y las reglas no aplicables nunca incumplen', () => {
    const results = traceCoverage(chain(), ['security:asset -> platform', 'security:zone -> platform', 'security:control -> platform', 'platform:service -> integration']);
    expect(coverageShortfalls(results).map((r) => r.rule.text)).toEqual(['security:asset -> platform', 'security:zone -> platform', 'platform:service -> integration']);
    expect(coverageShortfalls(results, 66.6).map((r) => r.rule.text)).toEqual(['security:zone -> platform']);
    expect(coverageShortfalls(results, 66.7).map((r) => r.rule.text)).toContain('security:asset -> platform'); // 2/3 = 66,666… < 66,7
    expect(coverageShortfalls(results, 0)).toEqual([]);
    // 1999/2000 se redondea a 100 pero no llega al 100 %
    const big = buildTraceGraph([
      { module: security, document: { items: Array.from({ length: 2000 }, (_, i) => item(`a${i}`, 'asset', i === 0 ? {} : { ref: 'urn:iark:platform:s' })) } },
      { module: platform, document: { items: [item('s', 'service')] } },
    ]);
    const [almost] = traceCoverage(big, ['security:asset -> platform']);
    expect(almost.percent).toBe(100);
    expect(coverageShortfalls([almost])).toHaveLength(1);
  });

  it('el informe da el porcentaje por regla, lista lo SIN cubrir y avisa de las no aplicables', () => {
    const results = traceCoverage(chain(), ['security:asset -> platform', 'security:control -> platform']);
    const text = traceCoverageReport(results, { min: 100 });
    expect(text).toContain('Cobertura de trazabilidad: 2 reglas.');
    expect(text).toContain('| `security:asset -> platform` | 2 | 3 | 66,7 % |');
    expect(text).toContain('| `security:control -> platform` | — | 0 | no aplicable |');
    expect(text).toContain('**SIN cubrir** · `security:asset -> platform` (1)');
    expect(text).toContain('- security:a3 (A3) · asset');
    expect(text).toContain('Por debajo del mínimo (100 %): `security:asset -> platform`.');
    expect(traceCoverageReport([], {})).toContain('No se pidió ninguna regla');
  });
});
