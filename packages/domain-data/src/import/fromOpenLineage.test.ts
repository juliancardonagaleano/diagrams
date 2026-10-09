import { readFileSync } from 'node:fs';
import { ModuleRegistry } from '@iark/kernel';
import { describe, expect, it } from 'vitest';
import { analyzeData } from '../issues';
import { dataModule } from '../module';
import { dataDocumentSchema } from '../schema';
import { DataImportError } from './fromMermaid';
import { fromOpenLineage, looksLikeOpenLineage } from './fromOpenLineage';

const FIXTURES = 'tests/fixtures/importar/openlineage';
const eventos = readFileSync(`${FIXTURES}/eventos-tienda.json`, 'utf8');
const ndjson = readFileSync(`${FIXTURES}/pagos-flink.ndjson`, 'utf8');
const registry = new ModuleRegistry().register(dataModule);

const event = (job: string, inputs: unknown[], outputs: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  eventType: 'COMPLETE',
  eventTime: '2025-01-01T00:00:00Z',
  run: { runId: '00000000-0000-0000-0000-000000000001' },
  job: { namespace: 'ns', name: job },
  inputs,
  outputs,
  producer: 'https://example.invalid/producer',
  schemaURL: 'https://openlineage.io/spec/2-0-2/OpenLineage.json#/$defs/RunEvent',
  ...extra,
});
const ds = (name: string, namespace = 'postgres://db:5432', facets: Record<string, unknown> = {}): Record<string, unknown> => ({ namespace, name, facets });

describe('OpenLineage: detect', () => {
  it('reconoce un evento, una lista y NDJSON; también un JobEvent y con marca de orden de bytes', () => {
    expect(looksLikeOpenLineage(eventos)).toBe(true);
    expect(looksLikeOpenLineage(ndjson)).toBe(true);
    expect(looksLikeOpenLineage(`﻿${eventos}`)).toBe(true);
    expect(looksLikeOpenLineage(JSON.stringify(event('j', [], [])))).toBe(true);
    const jobEvent = { eventTime: '2025-01-01T00:00:00Z', job: { namespace: 'n', name: 'j' }, inputs: [], outputs: [], producer: 'p', schemaURL: 'x#/$defs/JobEvent' };
    expect(looksLikeOpenLineage(JSON.stringify(jobEvent))).toBe(true);
  });

  it('no se confunde con dbt, Threat Dragon, otros JSON ni con documentos de la suite', () => {
    expect(looksLikeOpenLineage(readFileSync('tests/fixtures/importar/dbt/manifest-tienda.json', 'utf8'))).toBe(false);
    expect(looksLikeOpenLineage(readFileSync('tests/fixtures/importar/threat-dragon/tienda-modelo.json', 'utf8'))).toBe(false);
    expect(looksLikeOpenLineage(readFileSync('tests/fixtures/importar/terraform/aws-tienda-dev/plan.json', 'utf8'))).toBe(false);
    expect(looksLikeOpenLineage(readFileSync('examples/ventas-datos.json', 'utf8'))).toBe(false);
    expect(looksLikeOpenLineage('{"eventTime":"x","producer":"p"}')).toBe(false);
    expect(looksLikeOpenLineage('{"eventTime":"x","job":{"name":"j"}}')).toBe(false);
    expect(looksLikeOpenLineage('{"a":1}')).toBe(false);
    expect(looksLikeOpenLineage('[1,2,3]')).toBe(false);
    expect(looksLikeOpenLineage('')).toBe(false);
    expect(looksLikeOpenLineage('flowchart LR\n a --> b')).toBe(false);
    expect(looksLikeOpenLineage('{"eventTime":"x","producer":"p","job":')).toBe(false);
  });

  it('el módulo lo elige frente a dbt por el contenido, y por la extensión si es .ndjson o .jsonl', () => {
    expect(registry.detectImporter('data', 'eventos.json', eventos)?.id).toBe('openlineage');
    expect(registry.detectImporter('data', 'manifest.json', readFileSync('tests/fixtures/importar/dbt/manifest-tienda.json', 'utf8'))?.id).toBe('dbt');
    expect(registry.detectImporter('data', 'pagos.ndjson', ndjson)?.id).toBe('openlineage');
    expect(registry.detectImporter('data', 'pagos.JSONL', 'lo que sea')?.id).toBe('openlineage');
    expect(registry.detectImporter('data', undefined, ndjson)?.id).toBe('openlineage');
    expect(registry.detectImporter('data', 'otro.json', '{"a":1}')?.id).toBe('dbt');
    expect(registry.detectImporter('data', undefined, '{"version":1}')).toBeUndefined();
  });
});

describe('OpenLineage: mapeo de los eventos de la tienda', () => {
  const { document: doc, warnings } = fromOpenLineage(eventos, { fallbackName: 'eventos-tienda.json' });

  it('el nombre sale del archivo y la descripción cuenta lo importado', () => {
    expect(doc.workspace).toEqual({ name: 'eventos-tienda', description: 'Importado de 6 evento(s) de OpenLineage: 4 pipeline(s) y 7 dataset(s).' });
  });

  it('el namespace da el contenedor (base, almacén, lago) y el dataset, una tabla o un archivo dentro de él; Kafka es un stream suelto', () => {
    expect(doc.assets.map((a) => [a.id, a.kind, a.parentId])).toEqual([
      ['postgres-pedidos-db-interno-5432', 'database', undefined],
      ['ventas-public-pedidos', 'table', 'postgres-pedidos-db-interno-5432'],
      ['ventas-public-clientes', 'table', 'postgres-pedidos-db-interno-5432'],
      ['s3-lago-tienda', 'lake', undefined],
      ['raw-pedidos', 'file', 's3-lago-tienda'],
      ['raw-clientes', 'file', 's3-lago-tienda'],
      ['snowflake-acme-analitica', 'warehouse', undefined],
      ['analitica-ventas-pedidos-diarios', 'table', 'snowflake-acme-analitica'],
      ['ventas-resumen', 'stream', undefined],
      ['raw-politicas', 'file', 's3-lago-tienda'],
    ]);
    const asset = (id: string) => doc.assets.find((a) => a.id === id)!;
    expect(asset('postgres-pedidos-db-interno-5432')).toMatchObject({ name: 'pedidos-db', technology: 'PostgreSQL', description: 'Namespace de OpenLineage «postgres://pedidos-db.interno:5432».' });
    expect(asset('snowflake-acme-analitica')).toMatchObject({ name: 'snowflake://acme-analitica', technology: 'Snowflake' });
    expect(asset('ventas-resumen')).toMatchObject({ technology: 'Apache Kafka', name: 'ventas.resumen' });
    expect(asset('raw-pedidos')).toMatchObject({ technology: 'delta · parquet', name: '/raw/pedidos/' });
    expect(asset('ventas-public-pedidos')).toMatchObject({ owner: 'team:pedidos', description: 'Pedidos confirmados de la tienda' });
    expect(asset('analitica-ventas-pedidos-diarios').owner).toBe('team:analitica');
  });

  it('el facet schema da las columnas, y el linaje de columnas añade las que faltaban sin duplicar', () => {
    const columns = (id: string) => doc.assets.find((a) => a.id === id)!.columns?.map((c) => [c.name, c.type]);
    expect(columns('ventas-public-pedidos')).toEqual([['id', 'bigint'], ['cliente_id', 'bigint'], ['importe', 'numeric(12,2)'], ['creado_en', 'timestamp']]);
    expect(doc.assets.find((a) => a.id === 'ventas-public-pedidos')!.columns![0].description).toBe('Identificador del pedido');
    expect(columns('analitica-ventas-pedidos-diarios')).toEqual([['cliente_id', 'NUMBER(38,0)'], ['dia', 'DATE'], ['total', 'NUMBER(14,2)'], ['email_hash', 'VARCHAR']]);
    expect(columns('postgres-pedidos-db-interno-5432')).toBeUndefined();
  });

  it('cada job es un pipeline con su tipo, herramienta, responsable y entradas y salidas', () => {
    expect(doc.pipelines.map((p) => [p.id, p.kind, p.tool, p.owner, p.inputs, p.outputs])).toEqual([
      ['etl-diario-ingesta-pedidos', 'batch', 'Apache Airflow', 'team:plataforma-datos', ['ventas-public-pedidos', 'ventas-public-clientes'], ['raw-pedidos', 'raw-clientes']],
      ['transformar-ventas', 'batch', 'Apache Spark 3.5.1', 'team:analitica', ['raw-pedidos', 'raw-clientes'], ['analitica-ventas-pedidos-diarios']],
      ['publicar-resumen', 'streaming', 'Apache Flink', undefined, ['analitica-ventas-pedidos-diarios'], ['ventas-resumen']],
      ['compactar-pedidos', 'batch', 'Apache Spark 3.5.1', 'team:analitica', ['raw-politicas'], ['raw-pedidos']],
    ]);
    expect(doc.pipelines[0].description).toBe('Copia cada noche los pedidos y los clientes al lago de datos · Dentro de «etl_diario» · Job de «airflow://prod»');
  });

  it('los eventos START y COMPLETE del mismo job se unen y los mapeos de columna llevan su transformación', () => {
    const mappings = (id: string) => doc.pipelines.find((p) => p.id === id)!.mappings!.map((m) => `${m.from.assetId}.${m.from.column} -> ${m.to.assetId}.${m.to.column} [${m.transform ?? ''}]`);
    expect(mappings('etl-diario-ingesta-pedidos')).toHaveLength(7);
    expect(mappings('etl-diario-ingesta-pedidos')).toContain('ventas-public-clientes.email -> raw-clientes.email_hash [sha256(email)]');
    expect(mappings('transformar-ventas')).toEqual([
      'raw-pedidos.cliente_id -> analitica-ventas-pedidos-diarios.cliente_id [copia]',
      "raw-pedidos.creado_en -> analitica-ventas-pedidos-diarios.dia [date_trunc('day', creado_en)]",
      'raw-pedidos.importe -> analitica-ventas-pedidos-diarios.total [sum(importe)]',
      'raw-clientes.email_hash -> analitica-ventas-pedidos-diarios.email_hash [copia]',
    ]);
  });

  it('el enmascaramiento declarado marca el pipeline como anonimizador', () => {
    expect(doc.pipelines.find((p) => p.id === 'etl-diario-ingesta-pedidos')!.anonymizes).toBe(true);
    expect(doc.pipelines.find((p) => p.id === 'transformar-ventas')!.anonymizes).toBeUndefined();
  });

  it('avisa de lo descartado y de nada más', () => {
    expect(warnings).toEqual([
      '1 evento(s) FAIL o ABORT no cuentan para el linaje: una ejecución fallida no da linaje fiable.',
      '1 job(s) solo tienen ejecuciones fallidas o abortadas y no se importan: «etl_diario.limpiar_temporales».',
      '1 evento(s) de dataset (DatasetEvent, sin «job») no se importan: solo aportan datasets cuando un job los lee o escribe.',
      '1 job(s) no se importan como pipeline porque necesitan al menos una entrada y una salida: auditar.revisar_pedidos (no escribe ningún dataset). Sus datasets sí se importan como activos.',
      '1 job(s) leen y escriben el mismo dataset («compactar_pedidos»): se quita de sus entradas, porque un pipeline no puede leer y escribir el mismo activo.',
      '1 mapeo(s) de columna se descartan porque su origen no es una entrada del job o su destino no es una de sus salidas (p. ej. linaje indirecto de otro namespace).',
      'Facets sin correspondencia en el modelo, que no se importan: nominalTime (ejecución) ×2, sql (job) ×2.',
    ]);
  });

  it('un dataset que solo aparece en el linaje de una columna no se crea', () => {
    expect(doc.assets.some((a) => a.name === '/raw/serie/' || a.name === 's3://otro-lago')).toBe(false);
  });

  it('pasa el esquema del módulo y el análisis no da errores', () => {
    expect(dataDocumentSchema.safeParse(doc).success).toBe(true);
    expect(analyzeData(doc).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('importar dos veces da lo mismo', () => {
    expect(fromOpenLineage(eventos, { fallbackName: 'eventos-tienda.json' })).toEqual({ document: doc, warnings });
  });
});

describe('OpenLineage: NDJSON y eventos sueltos', () => {
  it('un evento por línea: START y RUNNING del mismo job dan un pipeline en streaming', () => {
    const { document, warnings } = fromOpenLineage(ndjson);
    expect(document.assets.map((a) => [a.id, a.kind, a.technology])).toEqual([
      ['pagos-confirmados', 'stream', 'Apache Kafka'],
      ['postgres-pedidos-db-interno-5432', 'database', 'PostgreSQL'],
      ['tesoreria-public-pagos', 'table', undefined],
    ]);
    expect(document.pipelines).toHaveLength(1);
    expect(document.pipelines[0]).toMatchObject({ id: 'cargar-pagos', kind: 'streaming', tool: 'Apache Flink', inputs: ['pagos-confirmados'], outputs: ['tesoreria-public-pagos'] });
    expect(document.pipelines[0].mappings).toHaveLength(2);
    expect(warnings).toEqual([]);
    expect(document.workspace.name).toBe('Linaje de OpenLineage');
  });

  it('el NDJSON admite líneas en blanco y finales de línea de Windows', () => {
    const text = ndjson.trimEnd().split('\n').join('\r\n\r\n');
    expect(fromOpenLineage(text).document.pipelines).toHaveLength(1);
  });

  it('un evento suelto (objeto) y un JobEvent sin eventType se importan', () => {
    const single = fromOpenLineage(JSON.stringify(event('cargar', [ds('a.t1')], [ds('a.t2')])));
    expect(single.document.pipelines.map((p) => [p.id, p.inputs, p.outputs])).toEqual([['cargar', ['a-t1'], ['a-t2']]]);
    const jobEvent = { eventTime: '2025-01-01T00:00:00Z', job: { namespace: 'n', name: 'copiar' }, inputs: [ds('x')], outputs: [ds('y')], producer: 'p', schemaURL: 'JobEvent' };
    expect(fromOpenLineage(JSON.stringify(jobEvent)).document.pipelines).toHaveLength(1);
  });

  it('el nombre explícito manda sobre el del archivo', () => {
    expect(fromOpenLineage(ndjson, { name: 'Pagos', fallbackName: 'pagos.ndjson' }).document.workspace.name).toBe('Pagos');
    expect(fromOpenLineage(ndjson, { fallbackName: 'pagos.ndjson' }).document.workspace.name).toBe('pagos');
  });
});

describe('OpenLineage: casos pequeños', () => {
  it('dos datasets con el mismo nombre en namespaces distintos reciben ids distintos', () => {
    const { document } = fromOpenLineage(JSON.stringify(event('copiar', [ds('ventas.pedidos', 'postgres://a:5432')], [ds('ventas.pedidos', 'mysql://b:3306')])));
    const tables = document.assets.filter((a) => a.kind === 'table');
    expect(tables.map((t) => t.name)).toEqual(['ventas.pedidos', 'ventas.pedidos']);
    expect(new Set(tables.map((t) => t.id)).size).toBe(2);
    expect(document.assets.filter((a) => a.kind === 'database').map((a) => a.technology)).toEqual(['PostgreSQL', 'MySQL']);
  });

  it('un namespace desconocido es una fuente y se avisa; jdbc: y arn:aws:glue se reconocen', () => {
    const { document, warnings } = fromOpenLineage(JSON.stringify(event('mover', [ds('t', 'miformato://x')], [ds('u', 'jdbc:mysql://h:3306/db')])));
    expect(document.assets.map((a) => [a.kind, a.technology])).toEqual([['source', undefined], ['table', undefined], ['database', 'MySQL'], ['table', undefined]]);
    expect(warnings).toContain('1 namespace(s) con un esquema no reconocido («miformato») se importan como fuente.');
    const glue = fromOpenLineage(JSON.stringify(event('m', [ds('t', 'arn:aws:glue:eu-west-1:123456789012')], [ds('u', 'bigquery')]))).document;
    expect(glue.assets.filter((a) => a.kind === 'warehouse').map((a) => a.technology)).toEqual(['AWS Glue', 'BigQuery']);
  });

  it('un job con varias ejecuciones de entradas distintas las une y avisa', () => {
    const text = JSON.stringify([event('cargar', [ds('a')], [ds('b')]), event('cargar', [ds('c')], [ds('b')])]);
    const { document, warnings } = fromOpenLineage(text);
    expect(document.pipelines).toHaveLength(1);
    expect(document.pipelines[0].inputs).toHaveLength(2);
    expect(warnings).toContain('1 job(s) cambiaron de entradas o salidas entre ejecuciones («cargar»): se unen todas en un solo pipeline.');
  });

  it('jobs con el mismo nombre en namespaces distintos son pipelines distintos con ids únicos', () => {
    const a = event('tarea', [ds('x')], [ds('y')]);
    const b = event('tarea', [ds('y')], [ds('z')], { job: { namespace: 'otro', name: 'tarea' } });
    const { document } = fromOpenLineage(JSON.stringify([a, b]));
    expect(document.pipelines.map((p) => p.id)).toEqual(['tarea', 'tarea-2']);
  });

  it('los campos anidados, el linaje a nivel de dataset y los facets sin mapear se cuentan', () => {
    const out = ds('o', 'postgres://db:5432', {
      schema: { fields: [{ name: 'dir', type: 'struct', fields: [{ name: 'calle', type: 'string' }] }] },
      columnLineage: { fields: {}, dataset: [{ namespace: 'postgres://db:5432', name: 'i', field: 'x' }] },
      dataQualityMetrics: { rowCount: 3 },
    });
    const { warnings } = fromOpenLineage(JSON.stringify(event('j', [ds('i')], [out], { run: { runId: 'r', facets: { errorMessage: {}, _meta: {} } } })));
    expect(warnings).toContain('1 columna(s) con campos anidados (struct): se importa la columna, no sus campos.');
    expect(warnings).toContain('1 dataset(s) traen linaje indirecto a nivel de dataset («columnLineage.dataset»): no se importa.');
    expect(warnings.find((w) => w.startsWith('Facets'))).toBe('Facets sin correspondencia en el modelo, que no se importan: dataQualityMetrics (dataset) ×1, errorMessage (ejecución) ×1.');
  });

  it('el linaje de una columna a un destino que no existe en el esquema añade la columna al activo', () => {
    const out = ds('o', 'postgres://db:5432', { columnLineage: { fields: { total: { inputFields: [{ namespace: 'postgres://db:5432', name: 'i', field: 'importe', transformations: [{ type: 'DIRECT', subtype: 'AGGREGATION', description: 'sum(importe)' }] }] } } } });
    const { document } = fromOpenLineage(JSON.stringify(event('j', [ds('i')], [out])));
    expect(document.assets.find((a) => a.name === 'o')!.columns).toEqual([{ name: 'total' }]);
    expect(document.assets.find((a) => a.name === 'i')!.columns).toEqual([{ name: 'importe' }]);
    expect(document.pipelines[0].mappings).toEqual([{ from: { assetId: 'i', column: 'importe' }, to: { assetId: 'o', column: 'total' }, transform: 'sum(importe)' }]);
  });

  it('un dataset sin namespace o nombre se ignora y se cuenta; no rompe el resto', () => {
    const { document, warnings } = fromOpenLineage(JSON.stringify(event('j', [ds('i'), { name: 'sin-namespace' }, null, 3], [ds('o')])));
    expect(document.pipelines[0].inputs).toEqual(['i']);
    expect(warnings).toContain('3 dataset(s) sin «namespace» o «name» se ignoran.');
  });
});

describe('OpenLineage: entradas patológicas', () => {
  const fails = (text: string, message: RegExp): void => {
    expect(() => fromOpenLineage(text)).toThrow(DataImportError);
    expect(() => fromOpenLineage(text)).toThrow(message);
  };

  it('vacío, en blanco, una lista vacía o un valor que no es un evento dan un motivo claro', () => {
    fails('', /vacío/);
    fails('   \n', /vacío/);
    fails('[]', /no contiene eventos de OpenLineage/);
    fails('{}', /no contiene eventos de OpenLineage/);
    fails('"hola"', /no contiene eventos de OpenLineage/);
    fails('42', /no contiene eventos de OpenLineage/);
    fails('null', /no contiene eventos de OpenLineage/);
    fails('[1, "a", null, [2]]', /no contiene eventos de OpenLineage/);
    fails('{"a":1,"b":{"c":2}}', /no contiene eventos de OpenLineage/);
  });

  it('JSON truncado o NDJSON con una línea rota señalan el problema', () => {
    fails(eventos.slice(0, 3000), /no es JSON válido/);
    fails('{"eventTime":"x","producer":"p","job":{"name":"j"},"inputs":[', /termina antes de tiempo/);
    const lines = ndjson.trimEnd().split('\n');
    fails([lines[0], '{"roto":', lines[1]].join('\n'), /no es JSON ni NDJSON válido: La línea 2 no es JSON válido/);
    fails('esto no es JSON\n{"a":1}', /no es JSON válido/);
  });

  it('solo ejecuciones fallidas, solo eventos de dataset o solo jobs sin entradas o salidas dan un motivo claro', () => {
    fails(JSON.stringify([{ ...event('j', [ds('a')], [ds('b')]), eventType: 'FAIL' }, { ...event('k', [ds('a')], [ds('b')]), eventType: 'ABORT' }]), /Los 2 evento\(s\) de OpenLineage son FAIL o ABORT/);
    fails(JSON.stringify([{ eventTime: 'x', dataset: ds('d'), producer: 'p' }]), /solo tiene eventos de dataset/);
    fails(JSON.stringify([event('solo-lee', [ds('a')], [])]), /Ningún job tiene a la vez entradas y salidas.*solo-lee \(no escribe ningún dataset\)/);
    fails(JSON.stringify([event('solo-escribe', [], [ds('a')])]), /solo-escribe \(no lee ningún dataset\)/);
    fails(JSON.stringify([event('en-sitio', [ds('a')], [ds('a')])]), /en-sitio \(solo lee lo que escribe\)/);
  });

  it('registros que no son eventos entre los eventos se ignoran y se cuentan', () => {
    const { warnings } = fromOpenLineage(JSON.stringify([event('j', [ds('a')], [ds('b')]), 'basura', 7, { hola: 1 }]));
    expect(warnings).toContain('3 registro(s) no son eventos de OpenLineage y se ignoran.');
  });

  it('un anidamiento enorme se rechaza sin agotar la pila', () => {
    fails(`${'['.repeat(100_000)}${']'.repeat(100_000)}`, /anidado/);
    fails(`{"eventTime":"x","producer":"p","job":{"name":"j"},"x":${'{"a":'.repeat(5_000)}1${'}'.repeat(5_000)}}`, /anidado en más de/);
  });

  it('un texto de más de 32 MiB se rechaza sin analizarlo', () => {
    fails(`[{"x":"${'a'.repeat(33 * 1024 * 1024)}"}]`, /demasiado grande/);
  });

  it('diez mil jobs, con sus datasets y mapeos de columna, se importan en tiempo razonable', () => {
    const many = Array.from({ length: 10_000 }, (_, i) =>
      event(`tarea-${i}`, [ds(`entrada-${i}`)], [ds(`salida-${i}`, 'postgres://db:5432', { columnLineage: { fields: { c: { inputFields: [{ namespace: 'postgres://db:5432', name: `entrada-${i}`, field: 'c' }] } } } })]),
    );
    const started = Date.now();
    const { document } = fromOpenLineage(JSON.stringify(many));
    expect(document.pipelines).toHaveLength(10_000);
    expect(document.assets.filter((a) => a.kind === 'table')).toHaveLength(20_000);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('diez mil eventos de un mismo job con un mismo nombre de dataset no se vuelven cuadráticos', () => {
    const same = Array.from({ length: 10_000 }, () => event('unico', [ds('e')], [ds('s')]));
    const started = Date.now();
    const { document } = fromOpenLineage(JSON.stringify(same));
    expect(document.pipelines).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
