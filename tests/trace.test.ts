import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildTraceGraph, coverageShortfalls, traceCoverage, traceFilterTypes, traceMatrix, traceMermaid, traceOrphans, traceReach, traceReachReport, traceReport, traceSvg, type AnyModule } from '@iark/kernel';
import { c4Module, dataModule, enterpriseModule, integrationModule, platformModule, securityModule } from '../src/modules-app/testing';
import { buildCliBundle, BUNDLE_TIMEOUT, PROCESS_TEST_TIMEOUT, type CliBundle } from './helpers/cliBundle';

// Las pruebas de `iark trace (CLI)` lanzan el CLI como proceso: se empaqueta una vez y se ejecuta con `node` (en vez de
// arrancar `tsx` en cada llamada), con margen de sobra por si la máquina está saturada.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT, hookTimeout: BUNDLE_TIMEOUT });

const doc = (file: string): unknown => JSON.parse(readFileSync(`examples/${file}`, 'utf8'));
const parse = (module: AnyModule, file: string): unknown => module.schema.parse(doc(file));

const inputs = () => [
  { module: securityModule, document: parse(securityModule, 'seguridad-ejemplo.json'), source: 'seguridad.json' },
  { module: platformModule, document: parse(platformModule, 'plataforma-ejemplo.json'), source: 'plataforma.json' },
  { module: integrationModule, document: parse(integrationModule, 'pedidos-integracion.json'), source: 'integracion.json' },
  { module: enterpriseModule, document: parse(enterpriseModule, 'empresa-arquitectura.json') },
  { module: dataModule, document: parse(dataModule, 'ventas-datos.json') },
];

describe('trazabilidad entre módulos', () => {
  it('reúne los enlaces por URN de los ejemplos: seguridad → plataforma → integración', () => {
    const graph = buildTraceGraph(inputs());
    expect(graph.problems).toEqual([]);
    expect(graph.links).toHaveLength(15);
    expect(graph.links).toContainEqual({ from: 'urn:iark:security:pedidos', to: 'urn:iark:platform:pedidos', type: 'protects' });
    expect(graph.links).toContainEqual({ from: 'urn:iark:platform:pedidos', to: 'urn:iark:integration:pedidos', type: 'implements' });
    expect(graph.documents.find((d) => d.module === 'security')).toMatchObject({ source: 'seguridad.json' });
    expect(graph.nodes.find((n) => n.urn === 'urn:iark:platform:kafka-prod')).toMatchObject({ name: 'Kafka (prod)', kind: 'resource' });
  });

  it('la cadena de ejemplos declara el tipo de sus enlaces y ninguno cae en el de por omisión ni en un aviso', () => {
    const graph = buildTraceGraph(inputs());
    const byType = (type: string) => graph.links.filter((l) => l.type === type).map((l) => l.from.replace('urn:iark:', '')).sort();
    expect(byType('protects')).toEqual(['security:facturacion', 'security:kafka', 'security:notificaciones', 'security:pedidos', 'security:pedidos-db']);
    expect(byType('implements')).toEqual(['platform:facturacion', 'platform:pasarela-pagos', 'platform:pedidos', 'platform:tienda-web']);
    expect(byType('deploys')).toEqual(['platform:kafka-prod', 'platform:pedidos-db-prod']);
    expect(byType('realizes')).toEqual(['enterprise:facturacion-electronica', 'enterprise:pasarela-pagos', 'enterprise:tienda-web']);
    expect(byType('derives')).toEqual(['data:erp']);
    expect(byType('depends-on')).toEqual([]);
    expect(graph.notices).toEqual([]);
  });

  it('refType se conserva en los seis esquemas junto a ref y se rechaza si no tiene la forma de un tipo', () => {
    const cases: Array<{ module: AnyModule; file: string; edit: (d: any) => Array<Record<string, unknown>> }> = [
      { module: c4Module, file: 'banca.json', edit: (d) => [d.model.elements[0]] },
      { module: dataModule, file: 'ventas-datos.json', edit: (d) => [d.assets[0]] },
      { module: enterpriseModule, file: 'empresa-arquitectura.json', edit: (d) => [d.applications[0], d.technologies[0]] },
      { module: integrationModule, file: 'pedidos-integracion.json', edit: (d) => [d.nodes[0]] },
      { module: platformModule, file: 'plataforma-ejemplo.json', edit: (d) => [d.services[0], d.resources[0]] },
      { module: securityModule, file: 'seguridad-ejemplo.json', edit: (d) => [d.assets[0]] },
    ];
    for (const { module, file, edit } of cases) {
      const typed = structuredClone(doc(file));
      for (const item of edit(typed)) Object.assign(item, { ref: 'urn:iark:c4:x', refType: 'mi-tipo' });
      const parsed = module.schema.safeParse(typed);
      expect(parsed.success, `${module.id}: refType válido`).toBe(true);
      expect(JSON.stringify(parsed.data)).toContain('"refType":"mi-tipo"');

      const broken = structuredClone(doc(file));
      for (const item of edit(broken)) Object.assign(item, { ref: 'urn:iark:c4:x', refType: 'Mal Tipo' });
      const rejected = module.schema.safeParse(broken);
      expect(rejected.success, `${module.id}: refType mal formado`).toBe(false);
      expect(JSON.stringify(rejected.error?.issues.map((i) => i.path))).toContain('refType');
    }
  });

  it('los huérfanos, la matriz y la cobertura de los ejemplos', () => {
    const graph = buildTraceGraph(inputs());
    const security = traceOrphans(graph, { module: 'security', kind: 'asset' });
    expect(security.groups).toHaveLength(1);
    expect(security.groups[0].orphans.map((n) => n.id)).toEqual(['cliente', 'pasarela-pagos', 'proveedor-correo', 'waf-lb', 'tienda-web', 'secretos']);
    // de los sistemas de integración, solo dos no tienen a nadie que los referencie
    const systems = traceOrphans(graph, { module: 'integration', kind: 'system' });
    expect(systems.groups.flatMap((g) => g.orphans.map((n) => n.id))).toEqual(['asistente', 'erp']);
    expect(systems.groups[0].total).toBe(6);

    const matrix = traceMatrix(graph, { by: 'module' });
    expect(matrix.total).toBe(15);
    expect(matrix.cells.map((c) => `${c.from}>${c.to}:${c.count}`)).toEqual(['security>platform:5', 'platform>integration:6', 'enterprise>integration:3', 'data>integration:1']);
    expect(matrix.cells.find((c) => c.from === 'platform')!.types).toEqual({ deploys: 2, implements: 4 });

    const [assets, services] = traceCoverage(graph, ['security:asset -> platform', 'platform:service -> integration']);
    expect(assets).toMatchObject({ total: 11, percent: 45.5 });
    expect(services).toMatchObject({ total: 6, percent: 66.7 });
    expect(services.uncovered.map((n) => n.id)).toEqual(['notificaciones', 'reportes']);
    // solo los enlaces `implements` cubren a los servicios; los `deploys` son de recursos
    expect(traceCoverage(traceFilterTypes(graph, ['deploys']), ['platform:service -> integration'])[0].percent).toBe(0);
    expect(coverageShortfalls([assets, services])).toHaveLength(2);
  });

  it('el Mermaid y el SVG de los ejemplos rotulan el tipo de cada enlace', async () => {
    const graph = buildTraceGraph(inputs());
    const mermaid = traceMermaid(graph);
    for (const type of ['protects', 'implements', 'deploys', 'realizes', 'derives']) expect(mermaid).toContain(`-.->|${type}|`);
    const svg = await traceSvg(graph);
    for (const type of ['protects', 'implements', 'deploys', 'realizes', 'derives']) expect(svg).toContain(`>${type}<`);
  });

  it('el impacto de un elemento atraviesa módulos: quién se apoya en él, y de qué se apoya', () => {
    const graph = buildTraceGraph(inputs());
    const impact = traceReach(graph, 'urn:iark:integration:pedidos', { direction: 'referrers' });
    expect(impact.map((r) => [r.node.urn, r.distance]).sort()).toEqual([
      ['urn:iark:data:erp', 1],
      ['urn:iark:integration:pedidos', 0],
      ['urn:iark:platform:pedidos', 1],
      ['urn:iark:security:pedidos', 2],
    ]);
    const depends = traceReach(graph, 'urn:iark:security:pedidos', { direction: 'refs' });
    expect(depends.map((r) => r.node.urn)).toEqual(['urn:iark:security:pedidos', 'urn:iark:platform:pedidos', 'urn:iark:integration:pedidos']);
    expect(traceReach(graph, 'urn:iark:security:pedidos', { direction: 'refs', depth: 1 })).toHaveLength(2);
    const middle = traceReach(graph, 'urn:iark:platform:pedidos');
    expect(middle.filter((r) => r.direction === 'referrers').map((r) => r.node.module)).toEqual(['security']);
    expect(middle.filter((r) => r.direction === 'refs').map((r) => r.node.module)).toEqual(['integration']);
    expect(() => traceReach(graph, 'urn:iark:platform:nada')).toThrow(/No existe el elemento «urn:iark:platform:nada»/);
  });

  it('distingue las referencias colgantes, las mal formadas y las de módulos sin documento', () => {
    const security = parse(securityModule, 'seguridad-ejemplo.json') as { assets: Array<{ id: string; ref?: string }> };
    const broken = structuredClone(security);
    broken.assets.find((a) => a.id === 'pedidos')!.ref = 'urn:iark:platform:no-existe';
    broken.assets.find((a) => a.id === 'kafka')!.ref = 'esto no es una urn';
    const graph = buildTraceGraph([
      { module: securityModule, document: broken },
      { module: platformModule, document: parse(platformModule, 'plataforma-ejemplo.json') },
    ]);
    expect(graph.problems.map((p) => [p.from, p.reason])).toEqual(
      expect.arrayContaining([
        ['urn:iark:security:pedidos', 'dangling'],
        ['urn:iark:security:kafka', 'invalid'],
      ]),
    );
    const unresolved = buildTraceGraph([{ module: platformModule, document: parse(platformModule, 'plataforma-ejemplo.json') }]);
    expect(unresolved.problems.every((p) => p.reason === 'unresolved' && p.ref.startsWith('urn:iark:integration:'))).toBe(true);
    expect(unresolved.links).toEqual([]);
  });

  it('no admite dos documentos del mismo módulo (las URN colisionarían)', () => {
    const one = { module: securityModule, document: parse(securityModule, 'seguridad-ejemplo.json') };
    expect(() => buildTraceGraph([one, one])).toThrow(/aparece más de una vez/);
    // con `allowRepeatedModules` (los diagramas de un proyecto) se admite, y el id repetido queda como ambiguo
    const repeated = buildTraceGraph([{ ...one, source: 'uno.json' }, { ...one, source: 'dos.json' }], { allowRepeatedModules: true });
    expect(repeated.documents.map((d) => d.source)).toEqual(['uno.json', 'dos.json']);
    expect(repeated.nodes).toHaveLength(buildTraceGraph([one]).nodes.length);
    const ambiguous = repeated.problems.filter((p) => p.reason === 'ambiguous');
    expect(ambiguous.length).toBe(repeated.nodes.length);
    expect(ambiguous[0].message).toMatch(/«dos\.json»[\s\S]*«uno\.json»/);
  });

  it('informes y Mermaid', () => {
    const graph = buildTraceGraph(inputs());
    const report = traceReport(graph);
    expect(report).toContain('5 documentos');
    expect(report).toContain('**security → platform** (5)');
    expect(report).toContain('- platform:pedidos (Servicio de pedidos) → integration:pedidos (Servicio de pedidos)');
    const impact = traceReachReport(traceReach(graph, 'urn:iark:integration:pedidos', { direction: 'referrers' }), 'referrers');
    expect(impact).toContain('security:pedidos (Servicio de pedidos) · asset · a 2 saltos');
    expect(impact).not.toContain('De lo que se apoya');
    expect(impact).toMatch(/Módulos alcanzados: (platform, data|data, platform), security/);

    const mermaid = traceMermaid(graph);
    expect(mermaid.startsWith('flowchart LR')).toBe(true);
    expect(mermaid).toContain('subgraph security["security"]');
    expect((mermaid.match(/-\.->/g) ?? []).length).toBe(15);
    const subset = traceMermaid(graph, new Set(['urn:iark:integration:pedidos', 'urn:iark:platform:pedidos']));
    expect((subset.match(/-\.->/g) ?? []).length).toBe(1);
  });
});

describe('dibujo del grafo de trazabilidad (SVG)', () => {
  it('dibuja un recuadro por módulo y una flecha por enlace, y con un alcance solo ese subgrafo', async () => {
    const graph = buildTraceGraph(inputs());
    const svg = await traceSvg(graph, { title: 'Trazabilidad', moduleLabels: { security: 'Seguridad' } });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('Trazabilidad');
    expect(svg).toContain('>Seguridad<');
    expect((svg.match(/marker-end="url\(#arrow\)"/g) ?? []).length).toBe(15);

    const reached = traceReach(graph, 'urn:iark:integration:pedidos', { direction: 'referrers' });
    const subset = await traceSvg(graph, { reached });
    expect((subset.match(/marker-end="url\(#arrow\)"/g) ?? []).length).toBe(3);
    // Punto de partida, quien se apoya en él (naranja) y ningún nodo ajeno al alcance.
    expect(subset).toContain('stroke="#0f172a"');
    expect(subset).toContain('stroke="#f59e0b"');
    expect(subset).not.toContain('Facturación');
  });

  it('sin enlaces devuelve un SVG con el aviso y escapa el texto de los documentos', async () => {
    const one = buildTraceGraph([{ module: securityModule, document: parse(securityModule, 'seguridad-ejemplo.json') }]);
    // El módulo de seguridad enlaza con plataforma, que no se aportó: no hay enlaces resolubles.
    expect(await traceSvg(one)).toContain('No hay enlaces entre los documentos aportados.');

    const graph = buildTraceGraph(inputs());
    graph.nodes[0] = { ...graph.nodes[0], name: '<img src=x onerror=alert(1)>' };
    const link = graph.links[0];
    const target = graph.nodes.findIndex((n) => n.urn === link.from);
    graph.nodes[target] = { ...graph.nodes[target], name: '<script>x</script> & "co"' };
    const svg = await traceSvg(graph);
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('<img');
  });
});

describe('iark trace (CLI)', () => {
  let bundle: CliBundle;
  beforeAll(async () => {
    bundle = await buildCliBundle('trace');
  });
  afterAll(() => bundle?.dispose());

  const run = (args: string[]) => spawnSync(process.execPath, [bundle.cli, 'trace', ...args], { encoding: 'utf8' });
  const docs = ['security=examples/seguridad-ejemplo.json', 'platform=examples/plataforma-ejemplo.json', 'integration=examples/pedidos-integracion.json'];

  it('informe general, impacto con --from y salida JSON/Mermaid', () => {
    const general = run(docs);
    expect(general.status).toBe(0);
    expect(general.stdout).toContain('3 documentos');
    const impact = run([...docs, '--from', 'integration:pedidos', '--direction', 'referrers']);
    expect(impact.stdout).toContain('security:pedidos (Servicio de pedidos)');
    const json = JSON.parse(run([...docs, '--from', 'urn:iark:platform:pedidos', '--format', 'json']).stdout);
    expect(json.from).toBe('urn:iark:platform:pedidos');
    expect(json.reached).toHaveLength(3);
    expect(run([...docs, '--format', 'mermaid']).stdout.startsWith('flowchart LR')).toBe(true);
    const svg = run([...docs, '--from', 'integration:pedidos', '--format', 'svg']);
    expect(svg.status).toBe(0);
    expect(svg.stdout.startsWith('<svg')).toBe(true);
  });

  it('los enlaces salen con su tipo: en el informe, el JSON, el Mermaid y el SVG', async () => {
    const report = run(docs).stdout;
    expect(report).toContain('Por tipo: protects 5, implements 4, deploys 2.');
    expect(report).toContain('- security:pedidos (Servicio de pedidos) → platform:pedidos (Servicio de pedidos) · protects');
    const json = JSON.parse(run([...docs, '--format', 'json']).stdout);
    expect(json.graph.links).toHaveLength(11);
    expect(json.graph.links.every((l: { type: string }) => typeof l.type === 'string')).toBe(true);
    expect(json.graph.notices).toEqual([]);
    expect(run([...docs, '--format', 'mermaid']).stdout).toContain('-.->|implements|');
    expect(run([...docs, '--format', 'svg']).stdout).toContain('>protects<');
  });

  it('--type mira solo los enlaces de ese tipo (repetible) y avisa si ninguno lo tiene', () => {
    const implemented = run([...docs, '--type', 'implements', '--format', 'json']);
    const json = JSON.parse(implemented.stdout);
    expect(json.types).toEqual(['implements']);
    expect(json.graph.links.map((l: { type: string }) => l.type)).toEqual(['implements', 'implements', 'implements', 'implements']);
    const two = JSON.parse(run([...docs, '--type', 'implements', '--type', 'protects', '--type', 'implements', '--format', 'json']).stdout);
    expect(two.types).toEqual(['implements', 'protects']);
    expect(two.graph.links).toHaveLength(9);
    // el alcance solo atraviesa los enlaces del tipo pedido
    const reach = run([...docs, '--from', 'integration:pedidos', '--direction', 'referrers', '--type', 'implements']).stdout;
    expect(reach).toContain('platform:pedidos');
    expect(reach).not.toContain('security:pedidos');
    expect(run([...docs, '--type', 'implements', '--format', 'mermaid']).stdout.match(/-\.->/g)).toHaveLength(4);
    const none = run([...docs, '--type', 'derives']);
    expect(none.status).toBe(0);
    expect(none.stderr).toMatch(/aviso: ningún enlace es del tipo «derives»/);
    expect(none.stdout).toContain('No hay enlaces entre los documentos aportados.');
    expect(run([...docs, '--type', 'Mal Tipo']).stderr).toMatch(/Tipo de enlace inválido/);
  });

  it('--orphans lista los elementos sin enlaces, de todos los módulos o de un módulo[:tipo]', () => {
    const all = run([...docs, '--orphans']);
    expect(all.status).toBe(0);
    expect(all.stdout).toContain('### Huérfanos');
    expect(all.stdout).toContain('**security · asset** (6 de 11)');
    expect(all.stdout).toContain('**platform · service** (1 de 6)');
    const zones = run([...docs, '--orphans', 'security:zone']);
    expect(zones.stdout).toContain('Huérfanos en security:zone: 4 de 4');
    expect(zones.stdout).not.toContain('platform · service');
    const json = JSON.parse(run([...docs, '--orphans', 'platform', '--format', 'json']).stdout);
    expect(json.orphans.filter).toEqual({ module: 'platform' });
    expect(json.orphans.groups.every((g: { module: string }) => g.module === 'platform')).toBe(true);
    // un módulo desconocido, uno que no se aportó y un valor que es en realidad un documento son errores de uso
    expect(run([...docs, '--orphans', 'nada']).status).toBe(2);
    expect(run([...docs, '--orphans', 'nada']).stderr).toMatch(/no existe el módulo «nada»/);
    const absent = run([...docs, '--orphans', 'data']);
    expect(absent.status).toBe(2);
    expect(absent.stderr).toMatch(/«data» no está entre los documentos aportados/);
    const swallowed = run(['--orphans', ...docs]);
    expect(swallowed.status).toBe(2);
    expect(swallowed.stderr).toMatch(/parece un documento/);
  });

  it('--matrix da la matriz de enlaces por módulo o por tipo de elemento, con el desglose por tipo de enlace', () => {
    const byModule = run([...docs, '--matrix']).stdout;
    expect(byModule).toContain('### Matriz');
    expect(byModule).toContain('| Origen \\ Destino | platform | integration | Total |');
    expect(byModule).toContain('| security | 5 | 0 | 5 |');
    expect(byModule).toContain('| platform | 0 | 6 | 6 |');
    expect(byModule).toContain('Desglose por tipo de enlace:');
    const byKind = JSON.parse(run([...docs, '--matrix', 'kind', '--format', 'json']).stdout).matrix;
    expect(byKind.by).toBe('kind');
    expect(byKind.rows).toContain('security:asset');
    expect(byKind.total).toBe(11);
    expect(run([...docs, '--matrix', 'raro']).status).toBe(2);
    expect(run([...docs, '--matrix', 'raro']).stderr).toMatch(/--matrix: «raro» no es válido/);
  });

  it('--coverage mide reglas origen -> destino; --min-coverage hace fallar (3) por debajo y no por una regla no aplicable', () => {
    const report = run([...docs, '--coverage', 'security:asset -> platform', '--coverage', 'platform:service -> integration']);
    expect(report.status).toBe(0); // sin --min-coverage ni --strict la cobertura solo se informa
    expect(report.stdout).toContain('| `security:asset -> platform` | 5 | 11 | 45,5 % |');
    expect(report.stdout).toContain('**SIN cubrir** · `platform:service -> integration` (2)');
    const json = JSON.parse(run([...docs, '--coverage', 'platform:service -> integration', '--format', 'json']).stdout);
    expect(json.coverage[0]).toMatchObject({ applicable: true, total: 6, percent: 66.7 });
    expect(json.coverage[0].covered).toHaveLength(4);

    const below = run([...docs, '--coverage', 'platform:service -> integration', '--min-coverage', '90']);
    expect(below.status).toBe(3);
    expect(below.stderr).toMatch(/Cobertura de «platform:service -> integration»: 66,7 %, por debajo del mínimo \(90 %\)/);
    expect(run([...docs, '--coverage', 'platform:service -> integration', '--min-coverage', '66']).status).toBe(0);
    expect(run([...docs, '--coverage', 'platform:service -> integration', '--min-coverage', '66,7']).status).toBe(3); // 2/3 no llega a 66,7

    // una regla sin elementos de origen no es aplicable: se avisa, no se da por buena ni por mala
    const na = run([...docs, '--coverage', 'security:inventado -> platform', '--min-coverage', '100']);
    expect(na.status).toBe(0);
    expect(na.stdout).toContain('no aplicable');
    expect(na.stderr).toMatch(/aviso: la regla «security:inventado -> platform» no es aplicable: no hay elementos de tipo «inventado» en «security» \(tipos presentes: asset, control, threat, zone\)/);

    // errores de uso
    expect(run([...docs, '--min-coverage', '80']).stderr).toMatch(/--min-coverage necesita al menos una regla/);
    expect(run([...docs, '--coverage', 'security:asset', '--min-coverage', '80']).stderr).toMatch(/forma origen -> destino/);
    expect(run([...docs, '--coverage', 'nada -> platform']).status).toBe(2);
    expect(run([...docs, '--coverage', 'security -> platform', '--min-coverage', '101']).stderr).toMatch(/de 0 a 100/);
  });

  it('--strict falla con referencias dangling y con la cobertura por debajo del 100 %; --strict-unresolved cuenta también los módulos sin documento', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iark-trace-strict-'));
    try {
      const broken = structuredClone(doc('seguridad-ejemplo.json')) as { assets: Array<{ id: string; ref?: string }> };
      broken.assets.find((a) => a.id === 'pedidos')!.ref = 'urn:iark:platform:no-existe';
      const file = join(dir, 'seguridad-rota.json');
      writeFileSync(file, JSON.stringify(broken));
      const withBroken = [`security=${file}`, 'platform=examples/plataforma-ejemplo.json', 'integration=examples/pedidos-integracion.json'];
      expect(run(withBroken).status).toBe(0);
      const strict = run([...withBroken, '--strict']);
      expect(strict.status).toBe(3);
      expect(strict.stderr).toMatch(/1 referencia\(s\) sin resolver/);
      // la referencia rota también cuenta con --type: filtrar no relaja --strict
      expect(run([...withBroken, '--type', 'implements', '--strict']).status).toBe(3);

      // las de un módulo sin documento solo cuentan con --strict-unresolved
      const alone = ['security=examples/seguridad-ejemplo.json'];
      expect(run([...alone, '--strict']).status).toBe(0);
      const unresolved = run([...alone, '--strict-unresolved']);
      expect(unresolved.status).toBe(3);
      expect(unresolved.stderr).toMatch(/5 referencia\(s\) sin resolver/);

      // con --strict, la cobertura mínima es 100 % por omisión
      const rule = ['--coverage', 'platform:service -> integration'];
      expect(run([...docs, ...rule]).status).toBe(0);
      const coverage = run([...docs, ...rule, '--strict']);
      expect(coverage.status).toBe(3);
      expect(coverage.stderr).toMatch(/por debajo del mínimo \(100 %\)/);
      expect(run([...docs, ...rule, '--strict', '--min-coverage', '60']).status).toBe(0);
      expect(run([...docs, '--coverage', 'security:asset -> platform', '--coverage', 'security:zone -> platform', '--strict']).status).toBe(3);
      // sin reglas, --strict sobre una traza limpia pasa
      expect(run([...docs, '--strict']).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--strict falla (código 3) con referencias rotas pero no con las de módulos sin documento; los errores de uso salen con código 2', () => {
    expect(run(['security=examples/seguridad-ejemplo.json', '--strict']).status).toBe(0);
    expect(run(['nada']).stderr).toMatch(/módulo=archivo/);
    expect(run(['nada=examples/banca.json']).status).not.toBe(0);
    expect(run([...docs, '--from', 'platform:inexistente']).stderr).toMatch(/No existe el elemento/);
    expect(run([...docs, '--from', 'sin-formato']).stderr).toMatch(/no es una URN/);
    expect(run([...docs, '--direction', 'lados']).stderr).toMatch(/Sentido inválido/);
    expect(run(['security=examples/seguridad-ejemplo.json', 'security=examples/seguridad-ejemplo.json']).stderr).toMatch(/aparece más de una vez/);
  });
});
