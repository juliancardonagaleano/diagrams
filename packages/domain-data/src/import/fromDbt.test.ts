import { readFileSync } from 'node:fs';
import { importText, ModuleRegistry } from '@iark/kernel';
import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { toDrawio } from '../export/drawio';
import { toMermaid } from '../export/mermaid';
import { toSvg } from '../export/render';
import { analyzeData } from '../issues';
import { dataModule } from '../module';
import { validateDataDocument } from '../schema';
import type { DataDocument } from '../types';
import { findView, listViews } from '../views';
import { fromDbt, looksLikeDbtManifest } from './fromDbt';
import { DataImportError, fromMermaid } from './fromMermaid';

const text = readFileSync('tests/fixtures/importar/dbt/manifest-tienda.json', 'utf8');
const raw = JSON.parse(text) as Record<string, any>;

const asset = (doc: DataDocument, id: string) => {
  const found = doc.assets.find((a) => a.id === id);
  if (!found) throw new Error(`No hay activo «${id}»: ${doc.assets.map((a) => a.id).join(', ')}`);
  return found;
};
const relation = (doc: DataDocument, source: string, target: string) => doc.relations.find((r) => r.sourceId === source && r.targetId === target);
const columns = (doc: DataDocument, id: string) => Object.fromEntries((asset(doc, id).columns ?? []).map((c) => [c.name, c]));
const flow = (doc: DataDocument) => doc.pipelines.map((p) => `${p.inputs.join('+')}>${p.outputs.join('+')}`);
const warn = (warnings: string[], fragment: string): string | undefined => warnings.find((w) => w.includes(fragment));

// ───────── manifests pequeños, escritos en la propia prueba ─────────
const METADATA = { dbt_schema_version: 'https://schemas.getdbt.com/dbt/manifest/v12.json', dbt_version: '1.8.2', project_name: 'p', adapter_type: 'postgres' };
type Json = Record<string, any>;
const node = (type: string, name: string, extra: Json = {}): [string, Json] => [
  `${type}.p.${name}`,
  { resource_type: type, package_name: 'p', name, schema: 'public', database: 'db', unique_id: `${type}.p.${name}`, config: { materialized: 'table' }, columns: {}, depends_on: { nodes: [] }, ...extra },
];
const model = (name: string, extra: Json = {}) => node('model', name, extra);
const cols = (...names: string[]): Json => Object.fromEntries(names.map((n) => [n, { name: n }]));
const source = (group: string, name: string, extra: Json = {}): [string, Json] => [
  `source.p.${group}.${name}`,
  { resource_type: 'source', package_name: 'p', source_name: group, name, schema: group, database: 'db', unique_id: `source.p.${group}.${name}`, columns: {}, ...extra },
];
const check = (kind: string, attached: string, column: string | undefined, kwargs: Json = {}, extra: Json = {}): [string, Json] => {
  const uid = `test.p.${kind}_${attached.split('.').pop()}_${column ?? 'x'}_${Math.random().toString(16).slice(2, 8)}`;
  return [uid, { resource_type: 'test', package_name: 'p', name: `${kind}_${column}`, unique_id: uid, attached_node: attached, ...(column ? { column_name: column } : {}), test_metadata: { name: kind, kwargs: { column_name: column, ...kwargs } }, config: {}, ...extra }];
};
const manifestOf = (parts: { nodes?: Array<[string, Json]>; sources?: Array<[string, Json]>; exposures?: Array<[string, Json]>; groups?: Array<[string, Json]>; metadata?: Json; extra?: Json } = {}): string =>
  JSON.stringify({
    metadata: { ...METADATA, ...parts.metadata },
    nodes: Object.fromEntries(parts.nodes ?? []),
    sources: Object.fromEntries(parts.sources ?? []),
    exposures: Object.fromEntries(parts.exposures ?? []),
    groups: Object.fromEntries(parts.groups ?? []),
    macros: {},
    ...parts.extra,
  });
const small = (parts: Parameters<typeof manifestOf>[0] = {}) => fromDbt(manifestOf(parts), { name: 'Prueba' });

describe('dbt: manifest de la tienda', () => {
  const { document: doc, warnings } = fromDbt(text, { fallbackName: 'manifest-tienda.json' });

  it('valida, pasa por las reglas de gobierno sin errores ni avisos y toma el nombre del proyecto', () => {
    expect(validateDataDocument(doc).ok).toBe(true);
    expect(doc.workspace.name).toBe('tienda_analitica');
    expect(doc.workspace.description).toBe('Importado de un manifest de dbt (dbt 1.8.2 · Snowflake).');
    // Solo hay avisos informativos (dominio, responsable, frecuencia...): nada que reprochar al resultado de importar.
    expect(analyzeData(doc).filter((i) => i.severity !== 'info')).toEqual([]);
    expect(fromDbt(text, { name: 'Mi proyecto', fallbackName: 'x.json' }).document.workspace.name).toBe('Mi proyecto');
    expect(fromDbt(manifestOf({ nodes: [model('a')], metadata: { project_name: undefined } }), { fallbackName: 'manifest.json' }).document.workspace.name).toBe('manifest');
    expect(fromDbt(manifestOf({ nodes: [model('a')], metadata: { project_name: undefined } })).document.workspace.name).toBe('Proyecto dbt');
  });

  it('cada fuente es un contenedor y cada esquema de dbt, un almacén del que cuelgan sus modelos', () => {
    expect(asset(doc, 'tienda')).toMatchObject({ kind: 'source', name: 'tienda', technology: 'fivetran', owner: 'Equipo Datos', description: 'Réplica de la base de datos operacional de la tienda en línea' });
    expect(doc.assets.filter((a) => a.parentId === 'tienda').map((a) => a.name)).toEqual(['clientes', 'lineas_pedido', 'pedidos', 'productos']);
    const warehouses = doc.assets.filter((a) => a.kind === 'warehouse');
    expect(warehouses.map((a) => a.name)).toEqual(['ANALITICA.ANALITICA_STAGING', 'ANALITICA.ANALITICA_SEEDS', 'ANALITICA.ANALITICA_SNAPSHOTS', 'ANALITICA.ANALITICA_MARTS', 'ANALITICA.ANALITICA_INTERMEDIATE']);
    expect(warehouses.every((w) => w.technology === 'Snowflake')).toBe(true);
    expect(asset(doc, 'analitica-analitica-marts').description).toBe('Esquema «ANALITICA_MARTS» de la base «ANALITICA» donde dbt materializa sus modelos.');
    expect(doc.assets.filter((a) => a.parentId === 'analitica-analitica-marts').map((a) => a.name)).toEqual(['dim_clientes', 'dim_productos', 'fct_pedidos', 'fct_ventas_diarias']);
  });

  it('view, ephemeral y materialized_view son vistas; table, incremental, seed y snapshot, tablas; la materialización va en la tecnología', () => {
    const kinds = Object.fromEntries(doc.assets.filter((a) => a.parentId).map((a) => [a.id, `${a.kind}|${a.technology ?? ''}`]));
    expect(kinds).toMatchObject({
      'stg-clientes': 'view|dbt · view',
      'int-pedidos-enriquecidos': 'view|dbt · ephemeral',
      'dim-clientes': 'table|dbt · table',
      'fct-pedidos': 'table|dbt · incremental',
      paises: 'table|dbt · seed',
      'snap-clientes': 'table|dbt · snapshot',
      'tienda-clientes': 'table|',
    });
  });

  it('las columnas documentadas conservan orden, tipo y descripción, y ninguna lleva nulos inventados', () => {
    expect(asset(doc, 'fct-pedidos').columns!.map((c) => c.name)).toEqual(['pedido_id', 'cliente_key', 'estado', 'total', 'unidades', 'creado_en']);
    expect(columns(doc, 'fct-pedidos').total).toEqual({ name: 'total', description: 'Importe en euros' });
    expect(columns(doc, 'stg-pedidos').total).toEqual({ name: 'total', type: 'NUMBER(12,2)', description: expect.any(String) });
    expect(Object.values(columns(doc, 'stg-pedidos')).some((c) => c.nullable !== undefined)).toBe(false);
    expect(asset(doc, 'tienda-clientes').description).toBeDefined();
  });

  it('las pruebas dan claves: unique → uk, unique + not_null → pk (con aviso), relationships → fk; el resto no se interpreta', () => {
    expect(columns(doc, 'stg-clientes').cliente_id.keys).toEqual(['pk']);
    expect(columns(doc, 'stg-clientes').email.keys).toEqual(['uk']);
    expect(columns(doc, 'stg-pedidos').cliente_id.keys).toEqual(['fk']);
    expect(columns(doc, 'stg-lineas-pedido').pedido_id.keys).toEqual(['fk']);
    expect(columns(doc, 'stg-lineas-pedido').linea.keys).toBeUndefined();
    expect(columns(doc, 'tienda-clientes').id.keys).toEqual(['pk']);
    // `fecha` solo es única en un `where`: no es una garantía general.
    expect(columns(doc, 'fct-ventas-diarias').fecha.keys).toBeUndefined();
    expect(warn(warnings, '6 clave(s) primaria(s) deducida(s) de unique + not_null')).toContain('fct_pedidos.pedido_id');
  });

  it('las relaciones salen de las pruebas relationships: el referenciado es el origen y la descripción lleva la opcionalidad', () => {
    expect(doc.relations).toHaveLength(4);
    expect(relation(doc, 'stg-clientes', 'stg-pedidos')).toMatchObject({ cardinality: '1:N', description: 'cliente_id · 1..1 → 0..N' });
    expect(relation(doc, 'stg-pedidos', 'stg-lineas-pedido')).toMatchObject({ cardinality: '1:N', description: 'pedido_id · 1..1 → 0..N' });
    // `producto_id` no tiene prueba not_null: puede faltar.
    expect(relation(doc, 'stg-productos', 'stg-lineas-pedido')).toMatchObject({ cardinality: '1:N', description: 'producto_id · 0..1 → 0..N' });
    expect(relation(doc, 'dim-clientes', 'fct-pedidos')).toMatchObject({ cardinality: '1:N', description: 'cliente_key · 1..1 → 0..N' });
  });

  it('el linaje sale de depends_on: un pipeline por modelo, snapshot y seed, y uno por exposición', () => {
    expect(flow(doc)).toEqual([
      'tienda-clientes>stg-clientes',
      'tienda-lineas-pedido>stg-lineas-pedido',
      'tienda-pedidos>stg-pedidos',
      'tienda-productos>stg-productos',
      'paises-csv>paises',
      'tienda-clientes>snap-clientes',
      'stg-clientes+paises>dim-clientes',
      'stg-productos>dim-productos',
      'stg-pedidos+stg-lineas-pedido+stg-productos>int-pedidos-enriquecidos',
      'int-pedidos-enriquecidos>fct-pedidos',
      'fct-pedidos>fct-ventas-diarias',
      'dim-clientes+fct-pedidos>modelo-fuga',
      'fct-pedidos+fct-ventas-diarias+dim-productos>panel-ventas',
    ]);
    expect(doc.pipelines.find((p) => p.id === 'dbt-fct-pedidos')).toMatchObject({ kind: 'elt', tool: 'dbt', schedule: 'diaria 05:00', name: 'dbt: fct_pedidos' });
    expect(doc.pipelines.find((p) => p.id === 'dbt-snap-clientes')).toMatchObject({ name: 'dbt snapshot: snap_clientes' });
    expect(doc.pipelines.find((p) => p.id === 'dbt-seed-paises')).toMatchObject({ kind: 'batch', tool: 'dbt seed' });
    // dbt no publica el linaje de columnas: no se inventa.
    expect(doc.pipelines.some((p) => p.mappings !== undefined)).toBe(false);
  });

  it('un seed sale de su CSV, que cuelga de una fuente propia', () => {
    expect(asset(doc, 'seeds-de-dbt')).toMatchObject({ kind: 'source', name: 'Seeds de dbt', technology: 'CSV' });
    expect(asset(doc, 'paises-csv')).toMatchObject({ kind: 'file', name: 'paises.csv', parentId: 'seeds-de-dbt', description: 'Seed «paises» (seeds/paises.csv).' });
  });

  it('las exposiciones son informes (o modelos, si son de tipo ml) con sus consumos y su gobierno declarado', () => {
    expect(asset(doc, 'panel-ventas')).toMatchObject({ kind: 'report', name: 'Panel de ventas', technology: 'dashboard', owner: 'Equipo BI', classification: 'internal', tags: ['bi'] });
    expect(asset(doc, 'panel-ventas').description).toContain('Enlace: https://bi.tienda.example/paneles/ventas');
    expect(asset(doc, 'modelo-fuga')).toMatchObject({ kind: 'model', owner: 'Ciencia de datos', classification: 'confidential', pii: true, retention: '2 años' });
    expect(doc.pipelines.find((p) => p.id === 'dbt-exposicion-panel-ventas')).toMatchObject({ kind: 'batch', name: 'Exposición: Panel de ventas' });
  });

  it('el gobierno es solo el declarado: meta, group, tags y propietario del grupo', () => {
    expect(doc.domains).toEqual([
      { id: 'comercial', name: 'comercial' },
      { id: 'catalogo', name: 'catalogo' },
    ]);
    expect(asset(doc, 'fct-pedidos')).toMatchObject({ owner: 'Equipo Comercial', domainId: 'comercial', classification: 'internal', tags: ['marts', 'diario'] });
    expect(asset(doc, 'dim-clientes')).toMatchObject({ domainId: 'comercial', classification: 'confidential', pii: true, retention: '5 años tras la baja' });
    expect(asset(doc, 'dim-productos')).toMatchObject({ domainId: 'catalogo', classification: 'public' });
    expect(asset(doc, 'tienda-clientes')).toMatchObject({ owner: 'Equipo Tienda', classification: 'confidential', pii: true });
    expect(asset(doc, 'tienda-productos').pii).toBeUndefined();
    // Columnas: PII solo donde la columna lo declara (`meta.contains_pii`), no por llamarse «email».
    expect(columns(doc, 'tienda-clientes').email.pii).toBe(true);
    expect(columns(doc, 'tienda-clientes').nombre.pii).toBe(true);
    expect(columns(doc, 'tienda-clientes').pais.pii).toBeUndefined();
    expect(columns(doc, 'snap-clientes').email.pii).toBeUndefined();
  });

  it('clasificación y PII salen únicamente de meta: ningún activo los lleva si el manifest no los declara', () => {
    const declared = new Map<string, { classification?: string; pii?: boolean }>();
    for (const [uid, n] of [...Object.entries(raw.nodes), ...Object.entries(raw.sources), ...Object.entries(raw.exposures)] as Array<[string, any]>) {
      const meta = { ...(n.config?.meta ?? {}), ...(n.meta ?? {}) };
      declared.set(uid, { classification: meta.classification, pii: meta.contains_pii === true ? true : undefined });
    }
    const withClassification = [...declared.values()].filter((d) => d.classification).length;
    const withPii = [...declared.values()].filter((d) => d.pii).length;
    expect(doc.assets.filter((a) => a.classification).length).toBe(withClassification);
    expect(doc.assets.filter((a) => a.pii).length).toBe(withPii);
    // `paises` (seed) no declara nada y no recibe nada; los contenedores tampoco.
    expect(asset(doc, 'paises').classification).toBeUndefined();
    expect(doc.assets.filter((a) => a.kind === 'warehouse').every((a) => a.classification === undefined && a.pii === undefined)).toBe(true);
  });

  it('lo que no es un activo de datos se resume en un aviso con su recuento', () => {
    expect(warn(warnings, 'Sin mapear')).toBe('Sin mapear (no son activos de datos): 1 analysis, 1 operation, 1 metrics, 1 semantic_models, 1 unit_tests, 2 macros del proyecto, 1 nodos deshabilitados.');
    expect(warn(warnings, 'Pruebas que no dan claves')).toBe('Pruebas que no dan claves ni relaciones: 1 accepted_values, 1 singulares, 1 dbt_utils.unique_combination_of_columns, 1 unique con where.');
    expect(warnings).toHaveLength(3);
    // El nodo deshabilitado y las macros ajenas al proyecto no aparecen como activos.
    expect(doc.assets.some((a) => /disabled|dbt_utils|constantes/i.test(a.id))).toBe(false);
  });

  it('el mismo archivo importado dos veces da el mismo documento y avisos', () => {
    const again = fromDbt(text, { fallbackName: 'manifest-tienda.json' });
    expect(again.document).toEqual(doc);
    expect(again.warnings).toEqual(warnings);
  });

  it('no depende del orden de las claves del manifest (nodos, fuentes y exposiciones se leen por nombre)', () => {
    const reversed = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).reverse());
    const shuffled = { ...raw, nodes: reversed(raw.nodes), sources: reversed(raw.sources), exposures: reversed(raw.exposures) };
    const again = fromDbt(JSON.stringify(shuffled), { fallbackName: 'manifest-tienda.json' });
    expect(again.document).toEqual(doc);
    expect(again.warnings).toEqual(warnings);
  });

  it('se ve en el lienzo: el ERD tiene las relaciones y el linaje, los pipelines; y se exporta a Mermaid, SVG y draw.io', async () => {
    const views = listViews(doc);
    expect(views.map((v) => v.id)).toEqual(expect.arrayContaining(['lineage', 'erd']));
    expect(findView(doc, 'erd').relationIds).toHaveLength(4);
    expect(findView(doc, 'erd').assetIds).toEqual(expect.arrayContaining(['stg-pedidos', 'stg-clientes', 'fct-pedidos']));
    expect(findView(doc, 'lineage').pipelineIds).toHaveLength(13);
    const erd = toMermaid(doc, { viewId: 'erd' });
    expect(erd).toContain('erDiagram');
    expect(erd).toMatch(/stg_clientes \|\|--o\{ stg_pedidos : "cliente_id · 1\.\.1 → 0\.\.N"/);
    expect(toMermaid(doc, { viewId: 'lineage' })).toContain('dbt: fct_pedidos');
    expect(await toSvg(doc, 'erd')).toContain('<svg');
    expect(await toSvg(doc, 'lineage')).toContain('<svg');
    const drawio = await toDrawio(doc);
    expect(() => new XMLParser({ ignoreAttributes: false }).parse(drawio)).not.toThrow();
    expect(fromMermaid(erd).document.relations).toHaveLength(4);
  });
});

describe('dbt: pruebas y restricciones', () => {
  it('unique y not_null sobre dos columnas distintas no dan clave primaria (no se sabe cuál lo es): quedan como únicas', () => {
    const r = small({
      nodes: [model('t', { columns: cols('a', 'b') }), check('unique', 'model.p.t', 'a'), check('unique', 'model.p.t', 'b'), check('not_null', 'model.p.t', 'a'), check('not_null', 'model.p.t', 'b')],
    });
    expect(r.document.assets.find((a) => a.id === 't')!.columns).toEqual([
      { name: 'a', keys: ['uk'] },
      { name: 'b', keys: ['uk'] },
    ]);
    expect(warn(r.warnings, 'deducida')).toBeUndefined();
  });

  it('unique solo da uk y not_null solo no da ninguna clave', () => {
    const r = small({ nodes: [model('t', { columns: cols('a', 'b') }), check('unique', 'model.p.t', 'a'), check('not_null', 'model.p.t', 'b')] });
    expect(r.document.assets.find((a) => a.id === 't')!.columns).toEqual([{ name: 'a', keys: ['uk'] }, { name: 'b' }]);
  });

  it('una prueba sobre una columna que el modelo no documenta no inventa la columna', () => {
    const r = small({ nodes: [model('t', { columns: cols('a') }), check('unique', 'model.p.t', 'zzz'), check('not_null', 'model.p.t', 'zzz')] });
    expect(r.document.assets.find((a) => a.id === 't')!.columns).toEqual([{ name: 'a' }]);
    expect(warn(r.warnings, 'deducida')).toBeDefined();
  });

  it('las pruebas con where (en la configuración o en los argumentos) no cuentan', () => {
    const r = small({
      nodes: [
        model('t', { columns: cols('a', 'b') }),
        check('unique', 'model.p.t', 'a', {}, { config: { where: 'activo' } }),
        check('unique', 'model.p.t', 'b', { where: 'activo' }),
        check('not_null', 'model.p.t', 'b'),
      ],
    });
    expect(r.document.assets.find((a) => a.id === 't')!.columns).toEqual([{ name: 'a' }, { name: 'b' }]);
    expect(warn(r.warnings, 'Pruebas que no dan claves')).toBe('Pruebas que no dan claves ni relaciones: 2 unique con where.');
  });

  it('relationships: 1:N si el hijo no es único, 1:1 si lo es, y 0..1 cuando no hay not_null', () => {
    const r = small({
      nodes: [
        model('dim', { columns: cols('id') }),
        model('fct', { columns: cols('dim_id', 'otro_id') }),
        model('perfil', { columns: cols('dim_id') }),
        check('relationships', 'model.p.fct', 'dim_id', { to: "ref('dim')", field: 'id' }),
        check('not_null', 'model.p.fct', 'dim_id'),
        check('relationships', 'model.p.fct', 'otro_id', { to: "ref('dim')", field: 'id' }),
        check('relationships', 'model.p.perfil', 'dim_id', { to: "ref('dim')", field: 'id' }),
        check('unique', 'model.p.perfil', 'dim_id'),
        check('not_null', 'model.p.perfil', 'dim_id'),
      ],
    });
    expect(r.document.relations.map((x) => `${x.sourceId}>${x.targetId} ${x.cardinality} ${x.description}`)).toEqual([
      'dim>fct 1:N dim_id · 1..1 → 0..N',
      'dim>fct 1:N otro_id · 0..1 → 0..N',
      'dim>perfil 1:1 dim_id · 1..1 → 0..1',
    ]);
    expect(r.document.assets.find((a) => a.id === 'fct')!.columns!.map((c) => c.keys)).toEqual([['fk'], ['fk']]);
    expect(r.document.assets.find((a) => a.id === 'perfil')!.columns![0].keys).toEqual(['pk', 'fk']);
    // La clave primaria deducida del perfil se avisa.
    expect(warn(r.warnings, 'perfil.dim_id')).toBeDefined();
  });

  it('relationships hacia un source() y con los argumentos del paquete (`ref("paquete", "modelo")`)', () => {
    const r = small({
      sources: [source('crm', 'cuentas', { columns: cols('id') })],
      nodes: [model('t', { columns: cols('cuenta_id', 'otra') }), model('u', { columns: cols('x') }), check('relationships', 'model.p.t', 'cuenta_id', { to: "source('crm', 'cuentas')" }), check('relationships', 'model.p.t', 'otra', { to: "ref('p', 'u')" })],
    });
    expect(r.document.relations.map((x) => `${x.sourceId}>${x.targetId}`)).toEqual(['crm-cuentas>t', 'u>t']);
  });

  it('relationships hacia algo que no está en el manifest avisa y no crea la relación', () => {
    const r = small({ nodes: [model('t', { columns: cols('x') }), check('relationships', 'model.p.t', 'x', { to: "ref('fantasma')" })] });
    expect(r.document.relations).toEqual([]);
    expect(warn(r.warnings, 'apunta a un modelo que no está en el manifest')).toBeDefined();
    expect(r.document.assets.find((a) => a.id === 't')!.columns![0].keys).toBeUndefined();
  });

  it('una relación de un modelo consigo mismo no se puede representar: avisa y solo marca la columna', () => {
    const r = small({ nodes: [model('t', { columns: cols('id', 'padre_id') }), check('relationships', 'model.p.t', 'padre_id', { to: "ref('t')", field: 'id' })] });
    expect(r.document.relations).toEqual([]);
    expect(warn(r.warnings, 't.padre_id apunta a su propia tabla')).toBeDefined();
    expect(r.document.assets.find((a) => a.id === 't')!.columns![1].keys).toEqual(['fk']);
  });

  it('las restricciones declaradas (constraints) valen sin deducir: pk compuesta, unique, foreign_key y not_null', () => {
    const r = small({
      nodes: [
        model('dim', { columns: cols('id') }),
        model('t', {
          columns: {
            a: { name: 'a', data_type: 'int', constraints: [{ type: 'not_null' }] },
            b: { name: 'b', constraints: [{ type: 'unique' }] },
            c: { name: 'c', constraints: [{ type: 'foreign_key', to: "ref('dim')", to_columns: ['id'] }] },
            d: { name: 'd' },
          },
          constraints: [{ type: 'primary_key', columns: ['a', 'd'] }],
        }),
      ],
    });
    expect(r.document.assets.find((a) => a.id === 't')!.columns).toEqual([
      { name: 'a', type: 'int', keys: ['pk'] },
      { name: 'b', keys: ['uk'] },
      { name: 'c', keys: ['fk'] },
      { name: 'd', keys: ['pk'] },
    ]);
    expect(r.document.relations).toEqual([{ id: 'dim--t', sourceId: 'dim', targetId: 't', cardinality: '1:N', description: 'c · 0..1 → 0..N' }]);
    expect(warn(r.warnings, 'deducida')).toBeUndefined();
  });

  it('una clave primaria declarada manda sobre lo que digan las pruebas', () => {
    const r = small({
      nodes: [model('t', { columns: { a: { name: 'a', constraints: [{ type: 'primary_key' }] }, b: { name: 'b' } } }), check('unique', 'model.p.t', 'b'), check('not_null', 'model.p.t', 'b')],
    });
    expect(r.document.assets.find((a) => a.id === 't')!.columns!.map((c) => c.keys)).toEqual([['pk'], ['uk']]);
  });

  it('pruebas de otros tipos y singulares se resumen, no se interpretan', () => {
    const r = small({
      nodes: [
        model('t', { columns: cols('a') }),
        check('accepted_values', 'model.p.t', 'a', { values: ['x'] }),
        check('accepted_values', 'model.p.t', 'a', { values: ['y'] }),
        check('expect_column_values_to_be_unique', 'model.p.t', 'a', {}, { test_metadata: { name: 'expect_column_values_to_be_unique', namespace: 'dbt_expectations', kwargs: {} } }),
        ['test.p.singular', { resource_type: 'test', name: 'singular', unique_id: 'test.p.singular', config: {} }],
      ],
    });
    expect(r.document.assets.find((a) => a.id === 't')!.columns).toEqual([{ name: 'a' }]);
    expect(warn(r.warnings, 'Pruebas que no dan claves')).toBe('Pruebas que no dan claves ni relaciones: 2 accepted_values, 1 dbt_expectations.expect_column_values_to_be_unique, 1 singulares.');
  });

  it('una prueba deshabilitada no cuenta', () => {
    const r = small({ nodes: [model('t', { columns: cols('a') }), check('unique', 'model.p.t', 'a', {}, { config: { enabled: false } })] });
    expect(r.document.assets.find((a) => a.id === 't')!.columns).toEqual([{ name: 'a' }]);
  });

  it('modelos de paquetes distintos con el mismo nombre se distinguen por el paquete de la prueba', () => {
    const other = model('dim', { package_name: 'otro', unique_id: 'model.otro.dim', columns: cols('id_otro') });
    other[0] = 'model.otro.dim';
    const r = small({
      nodes: [other, model('dim', { columns: cols('id_p') }), model('t', { columns: cols('d') }), check('relationships', 'model.p.t', 'd', { to: "ref('dim')" })],
    });
    expect(r.document.assets.filter((a) => a.name === 'dim')).toHaveLength(2);
    expect(r.document.relations).toHaveLength(1);
    // Gana el `dim` del mismo paquete que la prueba.
    expect(r.document.assets.find((a) => a.id === r.document.relations[0].sourceId)!.columns![0].name).toBe('id_p');
    expect(new Set(r.document.assets.map((a) => a.id)).size).toBe(r.document.assets.length);
  });
});

describe('dbt: gobierno, materializaciones y nodos', () => {
  const one = (extra: Json) => small({ nodes: [model('t', { columns: cols('email'), ...extra })] }).document.assets.find((a) => a.id === 't')!;

  it('sin meta no hay propietario, dominio, clasificación ni PII, aunque la columna se llame email o el modelo tenga la etiqueta «pii»', () => {
    const a = one({ tags: ['pii', 'confidential'], config: { materialized: 'table', tags: ['pii', 'confidential'] } });
    expect(a.classification).toBeUndefined();
    expect(a.pii).toBeUndefined();
    expect(a.owner).toBeUndefined();
    expect(a.domainId).toBeUndefined();
    expect(a.tags).toEqual(['pii', 'confidential']);
    expect(a.columns).toEqual([{ name: 'email' }]);
    const r = small({ nodes: [model('t', { columns: cols('email') })] });
    expect(r.document.domains).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('meta (del nodo o de config.meta) declara responsable, custodio, dominio, clasificación, PII y retención', () => {
    const a = one({ meta: { owner: 'Ana', steward: 'Luis', domain: 'Ventas', classification: 'restricted', contains_pii: true, retention: '3 años' } });
    expect(a).toMatchObject({ owner: 'Ana', steward: 'Luis', domainId: 'ventas', classification: 'restricted', pii: true, retention: '3 años' });
    const b = one({ config: { materialized: 'table', meta: { classification: 'confidencial', pii: 'true', owner: { name: 'Equipo X' } } } });
    expect(b).toMatchObject({ classification: 'confidential', pii: true, owner: 'Equipo X' });
    const c = one({ meta: { contains_pii: false, classification: 'public' } });
    expect(c.pii).toBeUndefined();
    expect(c.classification).toBe('public');
  });

  it('una clasificación que no existe se ignora con un aviso, sin adivinar la más parecida', () => {
    const r = small({ nodes: [model('t', { meta: { classification: 'secreto' } })] });
    expect(r.document.assets.find((a) => a.id === 't')!.classification).toBeUndefined();
    expect(warn(r.warnings, 'meta.classification «secreto» no es una clasificación')).toContain('El modelo «t»');
  });

  it('el group da el dominio y, si el grupo tiene propietario, el responsable; meta.domain y meta.owner mandan sobre él', () => {
    const groups: Array<[string, Json]> = [['group.p.finanzas', { name: 'finanzas', owner: { name: 'Equipo Finanzas', email: 'f@x.example' } }]];
    const r = small({ groups, nodes: [model('a', { group: 'finanzas' }), model('b', { group: 'finanzas', meta: { domain: 'Contabilidad', owner: 'Marta' } }), model('c')] });
    const [a, b, c] = ['a', 'b', 'c'].map((id) => r.document.assets.find((x) => x.id === id)!);
    expect(a).toMatchObject({ owner: 'Equipo Finanzas', domainId: 'finanzas' });
    expect(b).toMatchObject({ owner: 'Marta', domainId: 'contabilidad' });
    expect(c.domainId).toBeUndefined();
    expect(r.document.domains).toEqual([
      { id: 'finanzas', name: 'finanzas', owner: 'Equipo Finanzas' },
      { id: 'contabilidad', name: 'Contabilidad' },
    ]);
  });

  it('el propietario del contenedor es el de sus hijos solo si todos coinciden', () => {
    const same = small({ nodes: [model('a', { meta: { owner: 'Ana' } }), model('b', { meta: { owner: 'Ana' } })] });
    expect(same.document.assets.find((a) => a.kind === 'warehouse')!.owner).toBe('Ana');
    const mixed = small({ nodes: [model('a', { meta: { owner: 'Ana' } }), model('b', { meta: { owner: 'Luis' } })] });
    expect(mixed.document.assets.find((a) => a.kind === 'warehouse')!.owner).toBeUndefined();
    const partial = small({ nodes: [model('a', { meta: { owner: 'Ana' } }), model('b')] });
    expect(partial.document.assets.find((a) => a.kind === 'warehouse')!.owner).toBeUndefined();
  });

  it('materialized_view es una vista etiquetada como materializada; un modelo sin materialización es una vista', () => {
    const r = small({ nodes: [model('mv', { config: { materialized: 'materialized_view' } }), model('v', { config: {} }), model('i', { config: { materialized: 'incremental' } })] });
    const get = (id: string) => r.document.assets.find((a) => a.id === id)!;
    expect(get('mv')).toMatchObject({ kind: 'view', technology: 'dbt · materialized_view', tags: ['materializada'] });
    expect(get('v')).toMatchObject({ kind: 'view', technology: 'dbt · view' });
    expect(get('i')).toMatchObject({ kind: 'table', technology: 'dbt · incremental' });
  });

  it('las versiones de un modelo son activos distintos (`modelo v2`)', () => {
    const r = small({ nodes: [model('clientes', { version: 1 }), ['model.p.clientes.v2', { ...model('clientes', { version: 2 })[1], unique_id: 'model.p.clientes.v2' }]] });
    expect(r.document.assets.filter((a) => a.parentId).map((a) => a.name).sort()).toEqual(['clientes v1', 'clientes v2']);
    expect(new Set(r.document.assets.map((a) => a.id)).size).toBe(r.document.assets.length);
  });

  it('un modelo sin dependencias no tiene pipeline: la única queja de las reglas es que no tiene origen, y es cierta', () => {
    const r = small({ nodes: [model('t', { columns: cols('a') })] });
    expect(r.document.pipelines).toEqual([]);
    expect(validateDataDocument(r.document).ok).toBe(true);
    expect(analyzeData(r.document).filter((i) => i.severity !== 'info').map((i) => `${i.severity} ${i.message}`)).toEqual(['warning Tabla «t» no tiene origen: ningún pipeline lo escribe.']);
  });

  it('las dependencias que no están en el manifest se avisan y no rompen el linaje; las pruebas y los macros no cuentan', () => {
    const r = small({ nodes: [model('t', { depends_on: { nodes: ['model.p.fantasma', 'model.otro.lejano', 'test.p.x', 'seed.p.nada'] } }), model('u', { depends_on: { nodes: ['model.p.t', 'model.p.t', 'model.p.u'] } })] });
    expect(flow(r.document)).toEqual(['t>u']);
    expect(warn(r.warnings, '3 dependencia(s) apuntan a nodos que no están en el manifest')).toContain('model.p.fantasma');
  });

  it('los nodos deshabilitados (enabled: false y la sección disabled) se cuentan, no se importan', () => {
    const r = small({
      nodes: [model('t'), model('off', { config: { enabled: false } })],
      sources: [source('s', 'viva'), source('s', 'muerta', { config: { enabled: false } })],
      extra: { disabled: { 'model.p.x': [{}] } },
    });
    expect(r.document.assets.filter((a) => a.parentId).map((a) => a.id).sort()).toEqual(['s-viva', 't']);
    expect(warn(r.warnings, 'Sin mapear')).toBe('Sin mapear (no son activos de datos): 3 nodos deshabilitados.');
  });

  it('los tipos de nodo que no son activos de datos se resumen en un aviso (analysis, operation, macros del proyecto, métricas...)', () => {
    const r = small({
      nodes: [model('t'), node('analysis', 'a1'), node('analysis', 'a2'), node('sql_operation', 'op'), node('rpc', 'rpc1')],
      extra: { macros: { 'macro.p.m': { package_name: 'p' }, 'macro.dbt.otra': { package_name: 'dbt' } }, metrics: { 'metric.p.m': {} }, saved_queries: { 'saved_query.p.q': {} } },
    });
    expect(r.document.assets.filter((a) => a.parentId).map((a) => a.id)).toEqual(['t']);
    expect(warn(r.warnings, 'Sin mapear')).toBe('Sin mapear (no son activos de datos): 2 analysis, 2 operation, 1 metrics, 1 saved_queries, 1 macros del proyecto.');
  });

  it('exposiciones: sin dependencias se importan sin pipeline y con aviso; una deshabilitada se omite', () => {
    const exposure = (name: string, extra: Json): [string, Json] => [`exposure.p.${name}`, { resource_type: 'exposure', name, unique_id: `exposure.p.${name}`, type: 'dashboard', owner: { name: 'BI' }, depends_on: { nodes: [] }, ...extra }];
    const r = small({
      nodes: [model('t')],
      exposures: [exposure('huerfana', {}), exposure('con_origen', { depends_on: { nodes: ['model.p.t'] }, label: 'Con origen' }), exposure('apagada', { config: { enabled: false } })],
    });
    expect(r.document.assets.filter((a) => a.kind === 'report').map((a) => a.id)).toEqual(['con-origen', 'huerfana']);
    expect(flow(r.document)).toEqual(['t>con-origen']);
    expect(warn(r.warnings, 'La exposición «huerfana» no depende de ningún modelo')).toBeDefined();
    expect(analyzeData(r.document).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('las fuentes de un mismo grupo comparten contenedor y los ids no chocan con los de modelos homónimos', () => {
    const r = small({ sources: [source('raw', 'pedidos'), source('raw', 'clientes', { source_description: 'Volcado diario', loader: 'airbyte' })], nodes: [model('raw'), model('pedidos'), model('p')] });
    const ids = r.document.assets.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(r.document.assets.filter((a) => a.parentId === 'raw-2' || a.parentId === 'raw').map((a) => a.name).sort()).toEqual(expect.arrayContaining(['clientes', 'pedidos']));
    expect(r.document.assets.find((a) => a.kind === 'source')).toMatchObject({ technology: 'airbyte' });
  });

  it('una fuente cuyas columnas no están documentadas es un activo sin columnas', () => {
    const r = small({ sources: [source('raw', 'x')] });
    expect(r.document.assets.find((a) => a.id === 'raw-x')!.columns).toBeUndefined();
  });

  it('un seed sin ruta usa el nombre del CSV por defecto', () => {
    const r = small({ nodes: [node('seed', 'monedas', { config: { materialized: 'seed' } })] });
    expect(r.document.assets.find((a) => a.kind === 'file')).toMatchObject({ name: 'monedas.csv', description: 'Seed «monedas» (seeds/monedas.csv).' });
    expect(flow(r.document)).toEqual(['monedas-csv>monedas']);
  });

  it('un manifest sin adaptador no inventa la tecnología del almacén', () => {
    const r = small({ nodes: [model('t')], metadata: { adapter_type: undefined } });
    expect(r.document.assets.find((a) => a.kind === 'warehouse')!.technology).toBeUndefined();
    expect(r.document.workspace.description).toBe('Importado de un manifest de dbt (dbt 1.8.2).');
    const other = small({ nodes: [model('t')], metadata: { adapter_type: 'raro' } });
    expect(other.document.assets.find((a) => a.kind === 'warehouse')!.technology).toBe('raro');
  });

  it('un nodo sin base de datos ni esquema cuelga de «Almacén dbt»', () => {
    const r = small({ nodes: [model('t', { schema: undefined, database: undefined })] });
    expect(r.document.assets.find((a) => a.kind === 'warehouse')).toMatchObject({ name: 'Almacén dbt' });
  });

  it('las dependencias cíclicas no cuelgan el importador', () => {
    const r = small({ nodes: [model('a', { depends_on: { nodes: ['model.p.b'] } }), model('b', { depends_on: { nodes: ['model.p.a'] } })] });
    expect(flow(r.document).sort()).toEqual(['a>b', 'b>a']);
    expect(validateDataDocument(r.document).ok).toBe(true);
  });
});

describe('dbt: entradas rotas y detección', () => {
  const fails = (input: string, fragment: string | RegExp) => {
    expect(() => fromDbt(input)).toThrow(DataImportError);
    expect(() => fromDbt(input)).toThrow(fragment);
  };

  it('rechaza con un mensaje claro lo que no es un manifest', () => {
    fails('', 'está vacío');
    fails('  \n ', 'está vacío');
    fails('esto no es json', 'no es JSON válido');
    fails(text.slice(0, 5000), 'no es JSON válido');
    fails('[1, 2]', 'no es un manifest de dbt');
    fails('null', 'no es un manifest de dbt');
    fails('42', 'no es un manifest de dbt');
    fails('{"version": 1, "assets": []}', 'no parece un manifest de dbt');
    fails('{"nodes": {}}', 'no parece un manifest de dbt');
  });

  it('distingue los otros artefactos de dbt (catalog, run_results, sources) y dice cuál hay que importar', () => {
    fails(JSON.stringify({ metadata: { dbt_schema_version: 'https://schemas.getdbt.com/dbt/catalog/v1.json' }, nodes: {}, sources: {} }), /artefacto de dbt «catalog».*manifest\.json/);
    fails(JSON.stringify({ metadata: { dbt_schema_version: 'https://schemas.getdbt.com/dbt/run-results/v5.json' }, results: [] }), 'artefacto de dbt «run-results»');
  });

  it('un manifest sin modelos, seeds, snapshots ni fuentes no tiene nada que importar', () => {
    fails(manifestOf(), 'no tiene models, seeds, snapshots ni sources');
    fails(manifestOf({ nodes: [node('analysis', 'a'), check('unique', 'model.p.x', 'a')] }), 'no tiene models');
    fails(manifestOf({ nodes: [model('off', { config: { enabled: false } })] }), 'no tiene models');
  });

  it('un manifest con solo fuentes se importa', () => {
    const r = small({ sources: [source('raw', 'a')] });
    expect(r.document.assets.map((a) => a.id)).toEqual(['raw', 'raw-a']);
    expect(r.document.pipelines).toEqual([]);
  });

  it('tolera nodos, columnas y pruebas mal formados sin lanzar', () => {
    const r = fromDbt(
      JSON.stringify({
        metadata: METADATA,
        nodes: {
          'model.p.a': { resource_type: 'model', name: 'a', schema: 's', columns: { x: null, y: 5, z: { name: 'z', constraints: 'no', description: 7 } }, depends_on: 'raro', tags: 'x', meta: 'raro', config: 'raro' },
          'model.p.b': 'no es un objeto',
          'test.p.t': { resource_type: 'test', test_metadata: { name: 'unique', kwargs: 'raro' }, attached_node: 'model.p.a' },
          'model.p.c': { resource_type: 'model', name: 'c', schema: 's', constraints: [null, 3, { type: 'primary_key', columns: 'raro' }, { type: 'foreign_key' }] },
        },
        sources: { 'source.p.s.x': { name: 'x' }, 'source.p.s.y': [] },
        exposures: { 'exposure.p.e': { resource_type: 'exposure', name: 'e', depends_on: { nodes: [1, null, 'model.p.a'] }, owner: 'raro' } },
      }),
    );
    expect(validateDataDocument(r.document).ok).toBe(true);
    expect(r.document.assets.find((a) => a.id === 'a')!.columns).toEqual([{ name: 'z' }]);
  });

  it('un archivo sin nombres usa el identificador del nodo', () => {
    const r = fromDbt(JSON.stringify({ metadata: METADATA, nodes: { 'model.p.sin_nombre': { resource_type: 'model', schema: 's' } }, sources: {} }));
    expect(r.document.assets.find((a) => a.parentId)).toMatchObject({ name: 'model.p.sin_nombre' });
  });

  it('detect: reconoce el manifest por metadata.dbt_schema_version o por nodes + sources/child_map, y nada más', () => {
    expect(looksLikeDbtManifest(text)).toBe(true);
    expect(looksLikeDbtManifest(JSON.stringify({ metadata: { dbt_schema_version: 'https://schemas.getdbt.com/dbt/manifest/v12.json' } }))).toBe(true);
    expect(looksLikeDbtManifest(JSON.stringify({ nodes: {}, sources: {} }))).toBe(true);
    expect(looksLikeDbtManifest(JSON.stringify({ nodes: {}, child_map: {} }))).toBe(true);
    // Un `catalog.json` también lo marca dbt: lo reconoce el detector y el importador explica qué hay que importar.
    expect(looksLikeDbtManifest(JSON.stringify({ metadata: { dbt_schema_version: 'https://schemas.getdbt.com/dbt/catalog/v1.json' } }))).toBe(true);
    expect(looksLikeDbtManifest(JSON.stringify({ nodes: {} }))).toBe(false);
    expect(looksLikeDbtManifest(JSON.stringify({ metadata: { dbt_schema_version: 3 }, nodes: [] }))).toBe(false);
    // Otros JSON del proyecto: un documento de datos, uno de integración (con `nodes` en array), uno de C4 y un array.
    expect(looksLikeDbtManifest(JSON.stringify({ version: 1, workspace: { name: 'x' }, domains: [], assets: [], pipelines: [], relations: [] }))).toBe(false);
    expect(looksLikeDbtManifest(JSON.stringify({ version: 1, workspace: { name: 'x' }, nodes: [{ id: 'a' }], edges: [] }))).toBe(false);
    expect(looksLikeDbtManifest(JSON.stringify({ version: 1, elements: [], relationships: [] }))).toBe(false);
    expect(looksLikeDbtManifest('[]')).toBe(false);
    expect(looksLikeDbtManifest('')).toBe(false);
    expect(looksLikeDbtManifest('{ roto')).toBe(false);
    expect(looksLikeDbtManifest('erDiagram\n A ||--o{ B : x')).toBe(false);
    expect(looksLikeDbtManifest('CREATE TABLE t (id int);')).toBe(false);
  });

  it('el módulo registra el importador `dbt` para .json y lo elige por contenido, sin pisar al resto de JSON', async () => {
    const registry = new ModuleRegistry().register(dataModule);
    expect(dataModule.importers.map((i) => i.id)).toEqual(['mermaid', 'ddl', 'dbt', 'openlineage']);
    const dbt = dataModule.importers.find((i) => i.id === 'dbt')!;
    expect(dbt).toMatchObject({ label: 'dbt (manifest.json)', extensions: ['.json'] });
    expect(registry.detectImporter('data', 'manifest.json', text)?.id).toBe('dbt');
    expect(registry.detectImporter('data', undefined, text)?.id).toBe('dbt');
    expect(registry.detectImporter('data', undefined, '{"version":1}')).toBeUndefined();
    const done = await importText(dataModule, text, undefined, { fallbackName: 'manifest.json' });
    expect(done.importer).toBe('dbt');
    expect((done.document as DataDocument).assets.length).toBeGreaterThan(20);
    await expect(importText(dataModule, 'texto cualquiera', 'dbt')).rejects.toThrow(DataImportError);
    await expect(importText(dataModule, '{"version":1}')).rejects.toThrow('No se reconoce el formato');
  });
});

describe('dbt: robustez ante manifests dañados y muy grandes', () => {
  it('un manifest truncado o mutilado, o se importa como documento válido o se rechaza con DataImportError (nunca otra excepción)', () => {
    let seed = 20260929;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    let imported = 0;
    let rejected = 0;
    for (let n = 0; n < 400; n += 1) {
      const pos = Math.floor(rnd() * text.length);
      const kind = Math.floor(rnd() * 3);
      let mutated: string;
      if (kind === 0) mutated = text.slice(0, pos);
      else if (kind === 1) mutated = text.slice(0, pos) + text.slice(pos + 1 + Math.floor(rnd() * 60));
      else {
        // Cambia un valor por otro tipo de JSON: el manifest sigue siendo JSON, pero con la forma rota.
        const tree = JSON.parse(text) as Json;
        const keys = Object.keys(tree.nodes);
        const victim = tree.nodes[keys[Math.floor(rnd() * keys.length)]] as Json;
        const fields = Object.keys(victim);
        victim[fields[Math.floor(rnd() * fields.length)]] = [null, 7, 'x', [], {}, true][Math.floor(rnd() * 6)];
        mutated = JSON.stringify(tree);
      }
      try {
        expect(validateDataDocument(fromDbt(mutated).document).ok).toBe(true);
        imported += 1;
      } catch (error) {
        if (!(error instanceof DataImportError)) throw error;
        rejected += 1;
      }
    }
    expect(imported).toBeGreaterThan(100);
    expect(rejected).toBeGreaterThan(0);
  });

  it('una cadena de miles de modelos, también en el orden más desfavorable, no agota la pila', () => {
    const chain = (n: number, reverse: boolean) =>
      manifestOf({
        nodes: Array.from({ length: n }, (_, i) => {
          const next = reverse ? i + 1 : i - 1;
          return model(`m${String(i).padStart(5, '0')}`, { depends_on: { nodes: next >= 0 && next < n ? [`model.p.m${String(next).padStart(5, '0')}`] : [] } });
        }),
      });
    for (const reverse of [false, true]) {
      const r = fromDbt(chain(6000, reverse));
      expect(r.document.pipelines).toHaveLength(5999);
      expect(r.document.assets.filter((a) => a.kind === 'table')).toHaveLength(6000);
      // Los activos salen por capas: lo primero que se lee, antes de lo que se construye con ello.
      const order = r.document.assets.filter((a) => a.kind === 'table').map((a) => a.name);
      expect(order[0]).toBe(reverse ? 'm05999' : 'm00000');
    }
  });
});
