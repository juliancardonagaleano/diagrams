import { readFileSync } from 'node:fs';
import { buildManifest, ModuleError, ModuleRegistry } from '@iark/kernel';
import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { dataAiSpec, generatedToData, toGenerated } from './ai/generation';
import { dataCommands } from './commands';
import { toDrawio } from './export/drawio';
import { toMermaid } from './export/mermaid';
import { toSvg } from './export/render';
import { fromIntegrationJson } from './import/fromIntegration';
import { DataImportError, fromMermaid } from './import/fromMermaid';
import { analyzeData } from './issues';
import { findLineageCycles, traceLineage } from './lineage';
import { dataModule } from './module';
import { formatDataIssues, validateDataDocument } from './schema';
import { exportViews, findView, listViews } from './views';
import type { DataDocument } from './types';

const example = JSON.parse(readFileSync('examples/ventas-datos.json', 'utf8')) as unknown;
const parse = (input: unknown): DataDocument => {
  const r = validateDataDocument(input);
  if (!r.ok) throw new Error(formatDataIssues(r.issues));
  return r.document;
};
const doc = parse(example);
const messages = (d: DataDocument): string[] => analyzeData(d).map((i) => i.message);

describe('esquema de datos', () => {
  it('acepta el ejemplo y aplica valores por defecto', () => {
    expect(doc.assets).toHaveLength(14);
    expect(parse({}).workspace.name).toBe('Arquitectura de datos');
  });

  it('rechaza referencias rotas, jerarquías inválidas, columnas repetidas y URN inválidas', () => {
    const bad = {
      domains: [{ id: 'd', name: 'D' }, { id: 'd', name: 'Repetido' }],
      assets: [
        { id: 'db', kind: 'database', name: 'DB' },
        { id: 'db', kind: 'database', name: 'Repetido' },
        { id: 't', kind: 'table', name: 'T', parentId: 'fantasma', domainId: 'nada', ref: 'no-es-urn' },
        { id: 'r', kind: 'report', name: 'R', parentId: 'db' },
        { id: 'v', kind: 'view', name: 'V', parentId: 'r' },
        { id: 'c', kind: 'table', name: 'C', columns: [{ name: 'a' }, { name: 'a' }] },
      ],
      pipelines: [
        { id: 'p', name: 'P', kind: 'batch', inputs: ['db', 'nada'], outputs: ['db'] },
        { id: 'p', name: 'Vacío', kind: 'batch', inputs: [], outputs: [] },
      ],
      relations: [
        { id: 'x', sourceId: 'db', targetId: 'c', cardinality: '1:N' },
        { id: 'y', sourceId: 'c', targetId: 'c', cardinality: '1:1' },
        { id: 'z', sourceId: 'c', targetId: 'fantasma', cardinality: 'N:M' },
      ],
    };
    const r = validateDataDocument(bad);
    expect(r.ok).toBe(false);
    const text = r.ok ? '' : formatDataIssues(r.issues);
    for (const fragment of [
      'dominio duplicado',
      'activo duplicado',
      'padre inexistente',
      'dominio inexistente',
      'URN válida',
      'no puede tener padre',
      'debe ser de tipo',
      'Columna duplicada',
      'pipeline duplicado',
      'lee un activo inexistente',
      'no puede leer y escribir el mismo activo',
      'al menos una entrada',
      'al menos una salida',
      'solo se relacionan',
      'consigo mismo',
      'activo inexistente',
    ]) {
      expect(text).toContain(fragment);
    }
  });
});

describe('reglas de gobierno', () => {
  it('el ejemplo está limpio', () => {
    expect(analyzeData(doc)).toEqual([]);
  });

  const base = {
    assets: [
      { id: 'a', kind: 'table', name: 'A', owner: 'Yo' },
      { id: 'b', kind: 'table', name: 'B', owner: 'Yo' },
    ],
    pipelines: [{ id: 'p', name: 'A a B', kind: 'batch', inputs: ['a'], outputs: ['b'], schedule: 'diaria' }],
  };

  it('avisa de datos personales sin clasificar o clasificados a la baja, y sin retención', () => {
    const d = parse({ assets: [{ id: 'a', kind: 'table', name: 'A', owner: 'Yo', pii: true }, { id: 'b', kind: 'table', name: 'B', owner: 'Yo', pii: true, classification: 'internal' }] });
    const text = messages(d).join('\n');
    expect(text).toContain('contiene datos personales pero no tiene clasificación');
    expect(text).toContain('está clasificado como interna: como mínimo debería ser confidencial');
    expect(text).toContain('no declara política de retención');
  });

  it('sigue el linaje: sin clasificar o clasificado a la baja aguas abajo, salvo que el pipeline anonimice', () => {
    const risky = (out: object, anonymizes = false) =>
      parse({
        assets: [{ id: 'a', kind: 'table', name: 'A', owner: 'Yo', classification: 'restricted' }, { id: 'b', kind: 'table', name: 'B', owner: 'Yo', ...out }],
        pipelines: [{ ...base.pipelines[0], ...(anonymizes ? { anonymizes: true } : {}) }],
      });
    expect(messages(risky({})).join('\n')).toContain('deriva de Tabla «A» (clasificado como restringida) por el pipeline «A a B» pero no tiene clasificación');
    expect(messages(risky({ classification: 'public' })).join('\n')).toContain('se clasifica como pública pero deriva de Tabla «A»');
    expect(messages(risky({ classification: 'public' }, true))).toEqual([]);
    expect(messages(risky({ classification: 'restricted' }))).toEqual([]);
  });

  it('avisa de activos sin responsable (más grave con datos personales), sin origen, aislados y sin dominio', () => {
    const d = parse({
      domains: [{ id: 'v', name: 'Ventas' }, { id: 'vacio', name: 'Vacío' }],
      assets: [
        { id: 'wh', kind: 'warehouse', name: 'DWH', owner: 'Yo', domainId: 'v' },
        { id: 't', kind: 'table', name: 'Hechos', parentId: 'wh', columns: [{ name: 'x' }] },
        { id: 'pii', kind: 'table', name: 'Clientes', pii: true, classification: 'confidential', retention: '1 año', domainId: 'v' },
        { id: 'rep', kind: 'report', name: 'Panel', owner: 'Yo' },
      ],
    });
    const issues = analyzeData(d);
    const by = (text: string) => issues.find((i) => i.message.includes(text));
    expect(by('«Clientes» no tiene responsable')?.severity).toBe('warning');
    expect(by('Panel» no tiene origen')?.severity).toBe('warning');
    expect(by('«Hechos» no tiene origen')?.severity).toBe('warning');
    expect(by('Hechos» no declara clave primaria')?.severity).toBe('info');
    expect(by('Panel» no participa en ningún pipeline ni relación')).toBeDefined();
    expect(by('Panel» no pertenece a ningún dominio')).toBeDefined();
    expect(by('dominio «Vacío» no tiene activos')).toBeDefined();
    // La tabla hereda el responsable y el dominio de su almacén.
    expect(by('«Hechos» no tiene responsable')).toBeUndefined();
    expect(by('Hechos» no pertenece a ningún dominio')).toBeUndefined();
  });

  it('avisa de pipelines sin frecuencia, ciclos de linaje y relaciones N:M entre tablas', () => {
    const d = parse({
      assets: [
        { id: 'a', kind: 'table', name: 'A', owner: 'Yo', columns: [{ name: 'id', keys: ['pk'] }] },
        { id: 'b', kind: 'table', name: 'B', owner: 'Yo', columns: [{ name: 'id', keys: ['pk'] }] },
      ],
      pipelines: [
        { id: 'ab', name: 'A a B', kind: 'batch', inputs: ['a'], outputs: ['b'] },
        { id: 'ba', name: 'B a A', kind: 'streaming', inputs: ['b'], outputs: ['a'] },
      ],
      relations: [{ id: 'r', sourceId: 'a', targetId: 'b', cardinality: 'N:M' }],
    });
    const text = messages(d).join('\n');
    expect(text).toContain('«A a B» no declara su frecuencia');
    expect(text).not.toContain('«B a A» no declara su frecuencia');
    expect(text).toContain('Linaje circular: A → B → A');
    expect(text).toContain('relación N:M entre «A» y «B» normalmente se resuelve con una tabla intermedia');
  });
});

describe('linaje', () => {
  it('recorre aguas arriba y aguas abajo en anchura, con el pipeline y la profundidad de cada salto', () => {
    const { upstream, downstream } = traceLineage(doc, 'dwh-dim-cliente');
    expect(upstream.map((s) => [s.assetId, s.depth])).toEqual([
      ['silver-ventas', 1],
      ['bronze-pedidos', 2],
      ['bronze-clientes', 2],
      ['erp-pedidos', 3],
      ['erp-lineas', 3],
      ['crm-clientes', 3],
    ]);
    expect(upstream[0].pipelineId).toBe('carga-dimension');
    expect(downstream.map((s) => s.assetId)).toEqual(['modelo-fuga']);
    expect(traceLineage(doc, 'dwh-dim-cliente', 'upstream').downstream).toEqual([]);
    expect(traceLineage(doc, 'dwh-dim-cliente', 'downstream').upstream).toEqual([]);
  });

  it('puede detenerse en los pipelines que anonimizan', () => {
    expect(traceLineage(doc, 'silver-ventas', 'downstream').downstream.map((s) => s.assetId).sort()).toEqual(['dwh-dim-cliente', 'dwh-fact-ventas', 'modelo-fuga', 'panel-ventas']);
    expect(traceLineage(doc, 'silver-ventas', 'downstream', { stopAtAnonymizing: true }).downstream.map((s) => s.assetId).sort()).toEqual(['dwh-dim-cliente', 'modelo-fuga']);
  });

  it('detecta ciclos', () => {
    expect(findLineageCycles(doc)).toEqual([]);
    const cyclic = parse({
      assets: [{ id: 'a', kind: 'table', name: 'A' }, { id: 'b', kind: 'table', name: 'B' }, { id: 'c', kind: 'table', name: 'C' }],
      pipelines: [
        { id: '1', name: '1', kind: 'batch', inputs: ['a'], outputs: ['b'] },
        { id: '2', name: '2', kind: 'batch', inputs: ['b'], outputs: ['c'] },
        { id: '3', name: '3', kind: 'batch', inputs: ['c'], outputs: ['a'] },
      ],
    });
    expect(findLineageCycles(cyclic)).toEqual([['a', 'b', 'c', 'a']]);
  });
});

describe('vistas', () => {
  it('lista el linaje, el ERD y una vista por dominio', () => {
    expect(listViews(doc).map((v) => v.id)).toEqual(['lineage', 'erd', 'domain:ventas', 'domain:clientes', 'domain:plataforma']);
  });

  it('el ERD dibuja fichas sueltas (sin contenedores) y el linaje no repite lo que solo es entidad', () => {
    const erd = findView(doc, 'erd');
    expect(erd.assetIds).toEqual(['crm-clientes', 'erp-pedidos', 'erp-lineas', 'bronze-clientes', 'bronze-pedidos', 'silver-ventas', 'dwh-dim-cliente', 'dwh-fact-ventas']);
    expect(erd.relationIds).toEqual(['pedido-lineas', 'cliente-ventas']);
    expect(findView(doc, 'lineage').assetIds).toContain('crm');
    const onlyEntities = parse({ assets: [{ id: 'a', kind: 'table', name: 'A' }, { id: 'b', kind: 'table', name: 'B' }], relations: [{ id: 'r', sourceId: 'a', targetId: 'b', cardinality: '1:N' }] });
    expect(listViews(onlyEntities).map((v) => v.id)).toEqual(['erd']);
  });

  it('una vista de dominio muestra los vecinos por pipeline como contexto', () => {
    const v = findView(doc, 'domain:clientes');
    expect(v.assetIds).toEqual(expect.arrayContaining(['crm', 'crm-clientes', 'modelo-fuga', 'bronze-clientes', 'dwh-dim-cliente', 'dwh-fact-ventas', 'lake', 'dwh']));
    expect(v.contextIds).toEqual(expect.arrayContaining(['bronze-clientes', 'dwh-dim-cliente', 'dwh-fact-ventas']));
    expect(v.contextIds).not.toContain('crm-clientes');
    expect(findView(doc, 'clientes').id).toBe('domain:clientes');
  });

  it('el linaje de un activo se pide por su id (con sentido opcional)', () => {
    const both = findView(doc, 'lineage:silver-ventas');
    expect(both.type).toBe('trace');
    expect(both.title).toBe('Linaje de «plata: ventas»');
    expect(both.assetIds).toEqual(expect.arrayContaining(['erp-pedidos', 'crm-clientes', 'dwh-dim-cliente', 'panel-ventas', 'modelo-fuga']));
    const down = findView(doc, 'downstream:silver-ventas');
    expect(down.title).toBe('Impacto de «plata: ventas»');
    expect(down.assetIds).not.toContain('erp-pedidos');
    expect(findView(doc, 'upstream:modelo-fuga').assetIds).toContain('crm-clientes');
    expect(findView(doc, 'silver-ventas').id).toBe('lineage:silver-ventas');
  });

  it('una vista desconocida o un documento sin nada que dibujar dan un mensaje claro', () => {
    expect(() => findView(doc, 'nada')).toThrow(/No existe la vista «nada»\. Vistas disponibles: lineage, erd, .*lineage:<activo>/);
    expect(() => findView(parse({}))).toThrow('El documento no tiene vistas que exportar');
  });
});

describe('exportadores', () => {
  it('Mermaid: el linaje sale como flowchart con un pipeline por grupo de entradas y salidas', () => {
    const text = toMermaid(doc);
    expect(text).toMatch(/^flowchart LR/);
    expect(text).toContain('subgraph lake["Data lake: Lakehouse de ventas"]');
    expect(text).toContain('erp_pedidos & erp_lineas -->|"Ingesta del ERP [batch]"| bronze_pedidos');
    expect(text).toContain('crm_clientes ==>|"Ingesta del CRM [cdc]"| bronze_clientes');
  });

  it('Mermaid: el ERD sale como erDiagram con columnas, claves, PII y cardinalidad', () => {
    const text = toMermaid(doc, { viewId: 'erd' });
    expect(text).toMatch(/^---\ntitle: Modelo entidad-relación - Plataforma de datos de ventas\n---\nerDiagram/);
    expect(text).toContain('bigint pedido_id PK, FK');
    expect(text).toContain('text nombre "PII"');
    // El pedido lleva al menos una línea (`targetMin: 1`): `|{` en lugar del `o{` por defecto de «varios».
    expect(text).toContain('erp_pedidos ||--|{ erp_lineas : "contiene"');
    expect(text).toContain('dwh_dim_cliente ||--o{ dwh_fact_ventas : "compra"');
    expect(text).not.toContain('crm["CRM"]');
  });

  it('Mermaid: las vistas de contexto marcan sus activos de contexto', () => {
    expect(toMermaid(doc, { viewId: 'domain:clientes' })).toMatch(/classDef context stroke-dasharray:5 5\n\s+class .*bronze_clientes.* context/);
  });

  it('SVG: dibuja cada vista con su título y escapa el texto', async () => {
    const svg = await toSvg(doc);
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain('Linaje de datos - Plataforma de datos de ventas');
    expect(svg).toContain('Carga de hechos (seudonimiza)');
    expect(svg).not.toMatch(/<script|href=|@import/);
    const erd = await toSvg(doc, 'erd');
    expect(erd).toContain('PK,FK pedido_id: bigint');
    const tricky = parse({ assets: [{ id: 'a', kind: 'table', name: 'A & <B> "x"' }] });
    expect(await toSvg(tricky)).toContain('A &amp; &lt;B&gt; &quot;x&quot;');
  });

  it('draw.io: una página por vista, con aristas que apuntan a celdas existentes', async () => {
    const xml = await toDrawio(doc);
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml);
    const pages = [].concat(parsed.mxfile.diagram);
    expect(pages).toHaveLength(exportViews(doc).length);
    for (const page of pages as Array<{ mxGraphModel: { root: { mxCell: Array<Record<string, string>> } } }>) {
      const cells = page.mxGraphModel.root.mxCell;
      const ids = new Set(cells.map((c) => c['@_id']));
      for (const c of cells.filter((x) => x['@_edge'])) {
        expect(ids.has(c['@_source'])).toBe(true);
        expect(ids.has(c['@_target'])).toBe(true);
      }
    }
  });
});

describe('importación de Mermaid', () => {
  it('ida y vuelta del ERD: tablas, columnas, claves, PII y cardinalidad', () => {
    const { document, warnings } = fromMermaid(toMermaid(doc, { viewId: 'erd' }));
    expect(warnings).toEqual([]);
    expect(document.workspace.name).toBe('Modelo entidad-relación - Plataforma de datos de ventas');
    expect(document.assets.map((a) => a.id)).toEqual(['crm-clientes', 'erp-pedidos', 'erp-lineas', 'bronze-clientes', 'bronze-pedidos', 'silver-ventas', 'dwh-dim-cliente', 'dwh-fact-ventas']);
    const lineas = document.assets.find((a) => a.id === 'erp-lineas')!;
    expect(lineas.name).toBe('líneas de pedido');
    expect(lineas.columns?.[0]).toEqual({ name: 'pedido_id', type: 'bigint', keys: ['pk', 'fk'] });
    expect(document.assets.find((a) => a.id === 'dwh-dim-cliente')!.columns?.[1]).toEqual({ name: 'nombre', type: 'text', pii: true });
    expect(document.relations.map((r) => [r.sourceId, r.targetId, r.cardinality, r.description])).toEqual([
      ['erp-pedidos', 'erp-lineas', '1:N', 'contiene'],
      ['dwh-dim-cliente', 'dwh-fact-ventas', '1:N', 'compra'],
    ]);
  });

  it('un erDiagram escrito a mano: cardinalidades, entidades sueltas y recursividad', () => {
    const { document, warnings } = fromMermaid(`erDiagram
      CLIENTE ||--o{ PEDIDO : realiza
      PEDIDO }o--o{ PRODUCTO : incluye
      PRODUCTO }|--|| CATEGORIA : "pertenece a"
      EMPLEADO ||--|| EMPLEADO : jefe
      HUERFANA`);
    expect(document.relations.map((r) => r.cardinality)).toEqual(['1:N', 'N:M', 'N:1']);
    expect(document.assets.map((a) => a.id)).toContain('huerfana');
    expect(warnings.join('\n')).toContain('relaciones recursivas');
  });

  it('ida y vuelta del linaje: contenedores con su tipo, pipelines con entradas, salidas y tipo', () => {
    const { document, warnings } = fromMermaid(toMermaid(doc));
    expect(warnings).toEqual([]);
    const by = (id: string) => document.assets.find((a) => a.id === id)!;
    expect(by('lake')).toMatchObject({ kind: 'lake', name: 'Lakehouse de ventas' });
    expect(by('dwh')).toMatchObject({ kind: 'warehouse', name: 'DWH corporativo' });
    expect(by('crm')).toMatchObject({ kind: 'source', name: 'CRM' });
    expect(by('bronze-clientes')).toMatchObject({ kind: 'table', parentId: 'lake' });
    expect(by('panel-ventas')).toMatchObject({ name: 'Panel de ventas', technology: 'Power BI' });
    expect(document.pipelines).toHaveLength(doc.pipelines.length);
    const erp = document.pipelines.find((p) => p.name === 'Ingesta del ERP')!;
    expect(erp).toMatchObject({ kind: 'batch', inputs: ['erp-pedidos', 'erp-lineas'], outputs: ['bronze-pedidos'] });
    expect(document.pipelines.find((p) => p.name === 'Ingesta del CRM')!.kind).toBe('cdc');
  });

  it('un flowchart escrito a mano: formas, estilos de línea, etiquetas con tipo y subgraph sin tipo', () => {
    const { document, warnings } = fromMermaid(`flowchart LR
      subgraph Plataforma
        raw[(Base cruda)]
      end
      app[Aplicación] -.->|eventos| bus([Bus de eventos])
      bus ==> raw
      raw -->|Carga [elt]| mart[Mart]
      raw --> raw2
      raw2 --> raw2`);
    const by = (id: string) => document.assets.find((a) => a.id === id)!;
    expect(by('bus').kind).toBe('stream');
    expect(by('raw').kind).toBe('database');
    expect(by('plataforma').kind).toBe('database');
    expect(document.pipelines.map((p) => [p.name, p.kind])).toEqual([
      ['eventos', 'streaming'],
      ['Bus de eventos → Base cruda', 'cdc'],
      ['Carga', 'elt'],
      ['Base cruda → raw2', 'batch'],
    ]);
    expect(warnings.join('\n')).toContain('se importa como base de datos');
    expect(warnings.join('\n')).toContain('no se puede importar');
  });

  it('rechaza lo que no es un flowchart o un erDiagram y lo vacío, con errores de módulo', () => {
    expect(() => fromMermaid('sequenceDiagram\n A->>B: hola')).toThrow(/no se puede importar como datos/);
    expect(() => fromMermaid('pie title x\n "a": 1')).toThrow(/No se reconoce el tipo de diagrama/);
    expect(() => fromMermaid('   ')).toThrow(DataImportError);
    expect(() => fromMermaid('flowchart LR\n')).toThrow(/ningún activo/);
    try {
      fromMermaid('');
    } catch (e) {
      expect(e).toBeInstanceOf(ModuleError);
    }
  });
});

describe('desde un mapa de integración', () => {
  const integration = {
    workspace: { name: 'Pedidos' },
    nodes: [
      { id: 'web', kind: 'system', name: 'Web' },
      { id: 'pedidos-db', kind: 'store', name: 'Base de pedidos', technology: 'PostgreSQL', owner: 'Equipo Pedidos' },
      { id: 'kafka', kind: 'broker', name: 'Kafka' },
      { id: 'pedido-creado', kind: 'topic', name: 'pedido-creado', parentId: 'kafka' },
    ],
  };

  it('pasa almacenes y colas/tópicos a activos con referencia URN', () => {
    const { document, warnings } = fromIntegrationJson(integration);
    expect(document.workspace.name).toBe('Datos - Pedidos');
    expect(document.assets).toEqual([
      { id: 'pedidos-db', kind: 'database', name: 'Base de pedidos', technology: 'PostgreSQL', owner: 'Equipo Pedidos', ref: 'urn:iark:integration:pedidos-db' },
      { id: 'pedido-creado', kind: 'stream', name: 'pedido-creado', ref: 'urn:iark:integration:pedido-creado' },
    ]);
    expect(warnings.join('\n')).toContain('Se omitieron 2 nodo(s)');
    expect(() => fromIntegrationJson({ nodes: [{ id: 'a', kind: 'system', name: 'A' }] })).toThrow(/no tiene almacenes/);
    expect(() => fromIntegrationJson({})).toThrow(/falta "nodes"/);
  });
});

describe('generación con IA', () => {
  it('quita los null de la salida estructurada y valida el documento', () => {
    const generated = toGenerated(doc);
    const result = generatedToData(generated);
    expect(result.ok).toBe(true);
    // la especificación de IA no incluye `ref`: los recupera `carryRefs` al refinar (ver el kernel)
    if (result.ok) expect(result.document).toEqual({ ...doc, assets: doc.assets.map(({ ref: _ref, refType: _refType, ...asset }) => asset) });
    const broken = { ...generated, pipelines: [{ ...generated.pipelines[0], inputs: ['fantasma'] }] };
    const failed = generatedToData(broken);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.issues).toContain('lee un activo inexistente');
  });

  it('el prompt describe el dominio y el usuario incluye el modelo base al refinar', () => {
    expect(dataAiSpec.system()).toContain('arquitecto de datos');
    expect(dataAiSpec.system()).toContain('anonymizes = true');
    expect(dataAiSpec.user('Una tienda')).toContain('Una tienda');
    const refine = dataAiSpec.user('Añade un informe', doc);
    expect(refine).toContain('"id": "dwh-dim-cliente"');
    expect(refine).toContain('Añade un informe');
    const schema = dataAiSpec.generationJsonSchema() as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(['workspace', 'domains', 'assets', 'pipelines', 'relations', 'terms']);
  });
});

describe('módulo', () => {
  it('cumple el contrato y se puede registrar junto a otros módulos', () => {
    const registry = new ModuleRegistry().register(dataModule);
    expect(registry.require('data')).toBe(dataModule);
    expect(dataModule.exporters.map((e) => e.id)).toEqual(['mermaid', 'svg', 'drawio', 'ddl']);
    expect(dataModule.importers.map((i) => i.id)).toEqual(['mermaid', 'ddl', 'dbt']);
    const manifest = buildManifest(registry, { name: 'Prueba', version: '0.0.0' });
    expect(manifest.modules[0]).toMatchObject({ id: 'data', importFormats: ['mermaid', 'ddl', 'dbt'], exportFormats: ['mermaid', 'svg', 'drawio', 'ddl'] });
    expect(dataModule.entities!(doc).map((e) => e.kind)).toEqual(expect.arrayContaining(['domain', 'warehouse', 'report', 'pipeline']));
    expect(dataModule.validate(doc)).toEqual([]);
    expect((dataModule.jsonSchema() as { type: string }).type).toBe('object');
    expect(dataModule.importers[0].detect!('erDiagram\n A ||--o{ B : x')).toBe(true);
  });
});

describe('comandos', () => {
  const run = (name: string, args: string[], input: unknown, options: Record<string, unknown> = {}) =>
    dataCommands.find((c) => c.name === name)!.run({ args, options, input: typeof input === 'string' ? input : JSON.stringify(input) }) as string;

  it('lineage muestra el origen y el impacto con los responsables a avisar', () => {
    const text = run('lineage', ['silver-ventas'], example);
    expect(text).toContain('Linaje de «plata: ventas» (Tabla)');
    expect(text).toContain('Aguas arriba (de dónde vienen sus datos): 5 activo(s)');
    expect(text).toContain('  - bronce: pedidos (Tabla) · pipeline «Limpieza y unión» [elt]');
    expect(text).toContain('    - pedidos (Tabla) · pipeline «Ingesta del ERP» [batch]');
    expect(text).toContain('Aguas abajo (se ve afectado si cambia): 4 activo(s)');
    expect(text).toContain('Responsables a avisar: Equipo Plataforma, Ciencia de datos, Equipo BI');
    const up = run('lineage', ['silver-ventas'], example, { direction: 'upstream' });
    expect(up).not.toContain('Aguas abajo');
    expect(() => run('lineage', ['nada'], example)).toThrow(/No existe el activo «nada»/);
    expect(() => run('lineage', ['silver-ventas'], example, { direction: 'lateral' })).toThrow(/Sentido inválido/);
  });

  it('catalog y pii emiten tablas Markdown', () => {
    const catalog = run('catalog', [], example);
    expect(catalog).toContain('| Activo | Tipo | Contenedor | Dominio | Responsable | Clasificación | Datos personales | Lo escriben |');
    expect(catalog).toContain('| dim_cliente | Tabla | DWH corporativo | Plataforma de datos | Equipo Plataforma | confidencial | Sí | Carga de dimensión de clientes |');
    const pii = run('pii', [], example);
    expect(pii).toContain('| clientes | Tabla | confidencial | 5 años tras la baja | Equipo CRM | nombre, email |');
    expect(pii).toContain('- plata: ventas → dim_cliente, Modelo de fuga de clientes');
    expect(pii).not.toContain('fact_ventas');
    expect(run('pii', [], { assets: [{ id: 'a', kind: 'table', name: 'A' }] })).toBe('No hay activos con datos personales.');
  });

  it('las entradas inválidas terminan en errores de módulo', () => {
    expect(() => run('catalog', [], 'no es json')).toThrow(ModuleError);
    expect(() => run('catalog', [], { assets: [{ id: 'a', kind: 'raro', name: 'A' }] })).toThrow(/Documento de datos inválido/);
    expect(() => dataCommands[0].run({ args: ['a'], options: {} })).toThrow(/Falta la entrada/);
  });
});
