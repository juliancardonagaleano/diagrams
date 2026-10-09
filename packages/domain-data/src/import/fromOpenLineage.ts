/**
 * Importador de eventos de OpenLineage (el estándar abierto de linaje: Airflow, Spark, Flink, dbt y otros lo emiten) para el módulo
 * de datos. Acepta un evento (JSON), una lista de eventos (JSON) o un evento por línea (NDJSON, `.jsonl`), que es como los
 * guardan Marquez y los transportes a archivo.
 *
 *   OpenLineage                                         → datos
 *   -------------------------------------------------------------------------------------------------------------------
 *   `job` (namespace + name)                            → pipeline (uno por job; sus ejecuciones se unen)
 *   `inputs` / `outputs` de sus eventos                 → entradas y salidas del pipeline (activos)
 *   `namespace` de un dataset                           → su contenedor: base de datos (postgres, mysql…), almacén (snowflake,
 *                                                         bigquery…), lago (s3, gs, hdfs, abfs…) o fuente (el resto); un topic de
 *                                                         Kafka o similar es un `stream` suelto
 *   `name` de un dataset                                → tabla (o archivo en un lago) con ese nombre, dentro de su contenedor
 *   facet `schema`                                      → columnas (nombre, tipo, descripción)
 *   facet `columnLineage`                               → mapeos columna → columna del pipeline (la transformación va en `transform`)
 *   facets `documentation`, `ownership`, `storage`      → descripción, responsable y tecnología del activo o del pipeline
 *   `jobType` y `processing_engine`                     → tipo (streaming, ELT, por lotes) y herramienta del pipeline
 *
 * Qué decide el importador y se avisa: los eventos FAIL y ABORT no cuentan para el linaje; un job sin entradas o sin salidas no
 * puede ser un pipeline (el módulo exige al menos una de cada) y no se importa, aunque sus datasets sí; un dataset que un job lee y
 * escribe se quita de sus entradas; los mapeos de columna cuyo origen no es una entrada del job se descartan; y los facets sin
 * correspondencia (consultas SQL, estadísticas, calidad…) se enumeran en un solo aviso. El motor de base de datos no se deduce del
 * namespace (los tipos de columna de OpenLineage mezclan el vocabulario del motor y el de Spark): se lee como tecnología.
 */
import { asArray, asRecord, asString, pickId, readJsonText, textSizeProblem, Warnings, withoutBom, type JsonRecord } from '@iark/kernel';
import { formatDataIssues, validateDataDocument } from '../schema';
import { DATA_DOCUMENT_VERSION, type AssetKind, type Column, type ColumnMapping, type DataAsset, type Pipeline, type PipelineKind } from '../types';
import { slugify } from './common';
import { DataImportError, type DataImportOptions, type DataImportResult } from './fromMermaid';

const LABEL = 'El archivo de OpenLineage';
const MAX_EVENTS = 500_000;
const MAX_DATASETS = 100_000;

type Placement = 'database' | 'warehouse' | 'lake' | 'stream' | 'source';
interface Platform {
  label: string;
  placement: Placement;
}

/** Plataformas por el esquema del namespace (`postgres://…`), o el namespace entero cuando no lleva esquema (`bigquery`, `file`). */
const PLATFORMS: Record<string, Platform> = {
  postgres: { label: 'PostgreSQL', placement: 'database' },
  postgresql: { label: 'PostgreSQL', placement: 'database' },
  mysql: { label: 'MySQL', placement: 'database' },
  mariadb: { label: 'MariaDB', placement: 'database' },
  mssql: { label: 'SQL Server', placement: 'database' },
  sqlserver: { label: 'SQL Server', placement: 'database' },
  oracle: { label: 'Oracle', placement: 'database' },
  sqlite: { label: 'SQLite', placement: 'database' },
  mongodb: { label: 'MongoDB', placement: 'database' },
  cassandra: { label: 'Cassandra', placement: 'database' },
  dynamodb: { label: 'Amazon DynamoDB', placement: 'database' },
  snowflake: { label: 'Snowflake', placement: 'warehouse' },
  bigquery: { label: 'BigQuery', placement: 'warehouse' },
  redshift: { label: 'Amazon Redshift', placement: 'warehouse' },
  databricks: { label: 'Databricks', placement: 'warehouse' },
  trino: { label: 'Trino', placement: 'warehouse' },
  presto: { label: 'Presto', placement: 'warehouse' },
  hive: { label: 'Hive', placement: 'warehouse' },
  awsathena: { label: 'Amazon Athena', placement: 'warehouse' },
  athena: { label: 'Amazon Athena', placement: 'warehouse' },
  glue: { label: 'AWS Glue', placement: 'warehouse' },
  teradata: { label: 'Teradata', placement: 'warehouse' },
  vertica: { label: 'Vertica', placement: 'warehouse' },
  clickhouse: { label: 'ClickHouse', placement: 'warehouse' },
  synapse: { label: 'Azure Synapse', placement: 'warehouse' },
  s3: { label: 'Amazon S3', placement: 'lake' },
  s3a: { label: 'Amazon S3', placement: 'lake' },
  s3n: { label: 'Amazon S3', placement: 'lake' },
  gs: { label: 'Google Cloud Storage', placement: 'lake' },
  gcs: { label: 'Google Cloud Storage', placement: 'lake' },
  hdfs: { label: 'HDFS', placement: 'lake' },
  abfs: { label: 'Azure Data Lake Storage', placement: 'lake' },
  abfss: { label: 'Azure Data Lake Storage', placement: 'lake' },
  wasb: { label: 'Azure Blob Storage', placement: 'lake' },
  wasbs: { label: 'Azure Blob Storage', placement: 'lake' },
  adl: { label: 'Azure Data Lake Storage', placement: 'lake' },
  dbfs: { label: 'DBFS', placement: 'lake' },
  oss: { label: 'Alibaba OSS', placement: 'lake' },
  file: { label: 'Sistema de archivos', placement: 'lake' },
  kafka: { label: 'Apache Kafka', placement: 'stream' },
  pulsar: { label: 'Apache Pulsar', placement: 'stream' },
  kinesis: { label: 'Amazon Kinesis', placement: 'stream' },
  eventhubs: { label: 'Azure Event Hubs', placement: 'stream' },
  pubsub: { label: 'Google Pub/Sub', placement: 'stream' },
  rabbitmq: { label: 'RabbitMQ', placement: 'stream' },
};

/** Herramientas por el nombre con que los integradores se identifican. */
const TOOLS: Record<string, string> = {
  spark: 'Apache Spark',
  airflow: 'Apache Airflow',
  dbt: 'dbt',
  flink: 'Apache Flink',
  trino: 'Trino',
  hive: 'Apache Hive',
  beam: 'Apache Beam',
  dagster: 'Dagster',
  prefect: 'Prefect',
  great_expectations: 'Great Expectations',
  'great-expectations': 'Great Expectations',
  sql: 'SQL',
  dbtcloud: 'dbt Cloud',
  databricks: 'Databricks',
};

const TRANSFORMS: Record<string, string> = {
  IDENTITY: 'copia',
  TRANSFORMATION: 'transformación',
  AGGREGATION: 'agregación',
  FILTER: 'filtro',
  JOIN: 'unión',
  GROUP_BY: 'agrupación',
  SORT: 'orden',
  WINDOW: 'ventana',
  CONDITIONAL: 'condición',
};

/** Facets que el importador lee; el resto de los que traen los eventos se resume en un aviso. */
const USED_FACETS = {
  run: new Set(['parent', 'processing_engine']),
  job: new Set(['documentation', 'ownership', 'jobType']),
  dataset: new Set(['schema', 'documentation', 'ownership', 'storage', 'dataSource', 'columnLineage']),
};

const brief = (s: string, max = 300): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const owners = (facet: JsonRecord | undefined): string | undefined => asString(asRecord(asArray(facet?.owners)[0])?.name);
const shortList = (items: string[], max = 5): string => {
  const unique = [...new Set(items)];
  return unique.length <= max ? unique.map((s) => `«${s}»`).join(', ') : `${unique.slice(0, max).map((s) => `«${s}»`).join(', ')}… (+${unique.length - max})`;
};
const toolLabel = (name: string | undefined, version?: string): string | undefined => {
  if (!name) return undefined;
  const label = TOOLS[name.toLowerCase()] ?? name;
  return version ? `${label} ${version}` : label;
};

/** El esquema del namespace (`postgres://host:5432` → `postgres`; `bigquery` → `bigquery`; `jdbc:mysql://…` → `mysql`). */
function platformOf(namespace: string): { key: string; platform?: Platform } {
  const trimmed = namespace.trim().toLowerCase().replace(/^jdbc:/, '');
  if (trimmed.startsWith('arn:aws:glue')) return { key: 'glue', platform: PLATFORMS.glue };
  const key = /^([a-z][a-z0-9+.-]*):/.exec(trimmed)?.[1] ?? trimmed;
  return { key, platform: Object.hasOwn(PLATFORMS, key) ? PLATFORMS[key] : undefined };
}

const isEvent = (r: JsonRecord): boolean => typeof r.eventTime === 'string' && typeof r.producer === 'string' && (typeof asRecord(r.job)?.name === 'string' || typeof asRecord(r.dataset)?.name === 'string');

/** ¿El texto son eventos de OpenLineage (uno, una lista o NDJSON)? Un `eventTime`, un `producer` y un `job` o `dataset` con nombre. */
export function looksLikeOpenLineage(text: string): boolean {
  const source = withoutBom(text).trimStart();
  if (!/^[{[]/.test(source) || source.length > 80_000_000) return false;
  if (!source.includes('"eventTime"') || !source.includes('"producer"')) return false;
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    try {
      const end = source.indexOf('\n');
      value = JSON.parse(end === -1 ? source : source.slice(0, end));
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) return value.slice(0, 5).some((v) => asRecord(v) !== undefined && isEvent(asRecord(v)!));
  const record = asRecord(value);
  return !!record && isEvent(record);
}

/** Los registros del archivo: la lista, el objeto o, si no es un JSON entero, un objeto por línea. */
function readRecords(source: string): unknown[] {
  const text = withoutBom(source);
  const whole = readJsonText(text, LABEL);
  if (whole.ok) return Array.isArray(whole.value) ? whole.value : [whole.value];
  // Un evento por línea (NDJSON): solo si la primera línea es ya un JSON completo; si no, el error es el del archivo entero.
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first === -1 || !/no es JSON válido/.test(whole.message) || !readJsonText(lines[first], 'La línea').ok) throw new DataImportError(whole.message);
  const records: unknown[] = [];
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    const read = readJsonText(line, `La línea ${i + 1}`);
    if (!read.ok) throw new DataImportError(`${LABEL} no es JSON ni NDJSON válido: ${read.message}`);
    records.push(read.value);
    if (records.length > MAX_EVENTS) throw new DataImportError(`${LABEL} tiene más de ${MAX_EVENTS} eventos: demasiado grande para importarlo.`);
  });
  return records;
}

interface Dataset {
  key: string;
  namespace: string;
  name: string;
  columns: Map<string, Column>;
  description?: string;
  owner?: string;
  technology?: string;
  sourceName?: string;
  asset?: DataAsset;
}

interface Lineage {
  out: string;
  column: string;
  from: string;
  field: string;
  transform?: string;
  masking: boolean;
}

interface Job {
  key: string;
  namespace: string;
  name: string;
  inputs: Set<string>;
  outputs: Set<string>;
  lineage: Map<string, Lineage>;
  signatures: Set<string>;
  description?: string;
  owner?: string;
  processingType?: string;
  integration?: string;
  engine?: string;
  producer?: string;
  parent?: string;
}

/**
 * Importa eventos de OpenLineage como documento de datos (ver la cabecera de este archivo para el mapeo). Lanza
 * `DataImportError` con un motivo de una línea si el texto no contiene eventos utilizables.
 */
export function fromOpenLineage(source: string, options: DataImportOptions = {}): DataImportResult {
  const big = textSizeProblem(withoutBom(source), LABEL);
  if (big) throw new DataImportError(big);
  const records = readRecords(source);
  if (records.length > MAX_EVENTS) throw new DataImportError(`${LABEL} tiene más de ${MAX_EVENTS} eventos: demasiado grande para importarlo.`);

  const warnings = new Warnings();
  const datasets = new Map<string, Dataset>();
  const jobs = new Map<string, Job>();
  const failedJobs = new Map<string, string>();
  const ignoredFacets = new Map<string, number>();
  const noteFacets = (facets: unknown, used: Set<string>, level: string): void => {
    for (const name of Object.keys(asRecord(facets) ?? {})) if (!name.startsWith('_') && !used.has(name)) ignoredFacets.set(`${name} (${level})`, (ignoredFacets.get(`${name} (${level})`) ?? 0) + 1);
  };
  let notEvents = 0;
  let datasetEvents = 0;
  let failedEvents = 0;
  let accepted = 0;
  let unnamedDatasets = 0;
  let nestedFields = 0;
  let datasetLevelLineage = 0;

  const datasetFor = (ref: unknown): Dataset | undefined => {
    const r = asRecord(ref);
    const namespace = asString(r?.namespace);
    const name = asString(r?.name);
    if (!r || !namespace || !name) {
      unnamedDatasets += 1;
      return undefined;
    }
    const key = `${namespace}\u0000${name}`;
    let d = datasets.get(key);
    if (!d) {
      if (datasets.size >= MAX_DATASETS) throw new DataImportError(`${LABEL} tiene más de ${MAX_DATASETS} datasets: demasiado grande para importarlo.`);
      d = { key, namespace, name, columns: new Map() };
      datasets.set(key, d);
    }
    return d;
  };

  /** Lee los facets de un dataset (de un evento aceptado) y los suma a lo que ya se sabía de él. */
  const readDataset = (d: Dataset, facets: JsonRecord | undefined): void => {
    for (const field of asArray(asRecord(facets?.schema)?.fields)) {
      const f = asRecord(field);
      const name = asString(f?.name);
      if (!f || !name) continue;
      if (asArray(f.fields).length > 0) nestedFields += 1;
      const type = asString(f.type);
      const description = asString(f.description);
      const current = d.columns.get(name);
      d.columns.set(name, { name, ...(type ?? current?.type ? { type: type ?? current!.type } : {}), ...(description ?? current?.description ? { description: description ?? current!.description } : {}) });
    }
    d.description ??= asString(asRecord(facets?.documentation)?.description);
    d.owner ??= owners(asRecord(facets?.ownership));
    const storage = asRecord(facets?.storage);
    d.technology ??= [asString(storage?.storageLayer), asString(storage?.fileFormat)].filter(Boolean).join(' · ') || undefined;
    d.sourceName ??= asString(asRecord(facets?.dataSource)?.name);
  };

  for (const record of records) {
    const event = asRecord(record);
    if (!event) {
      notEvents += 1;
      continue;
    }
    const job = asRecord(event.job);
    const jobName = asString(job?.name);
    if (!job || !jobName) {
      if (asRecord(event.dataset)) datasetEvents += 1;
      else notEvents += 1;
      continue;
    }
    const jobNamespace = asString(job.namespace) ?? 'default';
    const key = `${jobNamespace}\u0000${jobName}`;
    const type = asString(event.eventType)?.toUpperCase();
    if (type === 'FAIL' || type === 'ABORT') {
      failedEvents += 1;
      failedJobs.set(key, jobName);
      continue;
    }
    accepted += 1;
    let j = jobs.get(key);
    if (!j) {
      j = { key, namespace: jobNamespace, name: jobName, inputs: new Set(), outputs: new Set(), lineage: new Map(), signatures: new Set() };
      jobs.set(key, j);
    }
    const jobFacets = asRecord(job.facets);
    const runFacets = asRecord(asRecord(event.run)?.facets);
    noteFacets(jobFacets, USED_FACETS.job, 'job');
    noteFacets(runFacets, USED_FACETS.run, 'ejecución');
    j.description ??= asString(asRecord(jobFacets?.documentation)?.description);
    j.owner ??= owners(asRecord(jobFacets?.ownership));
    const jobType = asRecord(jobFacets?.jobType);
    j.processingType ??= asString(jobType?.processingType)?.toUpperCase();
    j.integration ??= asString(jobType?.integration);
    const engine = asRecord(runFacets?.processing_engine);
    j.engine ??= toolLabel(asString(engine?.name), asString(engine?.version));
    j.producer ??= asString(event.producer);
    const parent = asRecord(runFacets?.parent);
    j.parent ??= asString(asRecord(parent?.job)?.name);

    const inputs: string[] = [];
    const outputs: string[] = [];
    for (const ref of asArray(event.inputs)) {
      const d = datasetFor(ref);
      if (!d) continue;
      noteFacets(asRecord(ref)?.facets, USED_FACETS.dataset, 'dataset');
      noteFacets(asRecord(ref)?.inputFacets, new Set(), 'entrada');
      readDataset(d, asRecord(asRecord(ref)?.facets));
      j.inputs.add(d.key);
      inputs.push(d.key);
    }
    for (const ref of asArray(event.outputs)) {
      const d = datasetFor(ref);
      if (!d) continue;
      const facets = asRecord(asRecord(ref)?.facets);
      noteFacets(facets, USED_FACETS.dataset, 'dataset');
      noteFacets(asRecord(ref)?.outputFacets, new Set(), 'salida');
      readDataset(d, facets);
      j.outputs.add(d.key);
      outputs.push(d.key);
      const lineage = asRecord(asRecord(facets?.columnLineage)?.fields) ?? {};
      if (asArray(asRecord(facets?.columnLineage)?.dataset).length > 0) datasetLevelLineage += 1;
      for (const [column, raw] of Object.entries(lineage)) {
        const field = asRecord(raw);
        for (const input of asArray(field?.inputFields)) {
          const i = asRecord(input);
          // Solo se cita: un dataset que el job no lee no se crea por aparecer en el linaje de una columna.
          const fromNamespace = asString(i?.namespace);
          const fromName = asString(i?.name);
          const inputField = asString(i?.field);
          if (!fromNamespace || !fromName || !inputField) continue;
          const from = { key: `${fromNamespace}\u0000${fromName}` };
          const transformations = asArray(i?.transformations).map(asRecord).filter((t): t is JsonRecord => !!t);
          const first = transformations[0];
          const subtype = asString(first?.subtype)?.toUpperCase();
          const label = subtype ? TRANSFORMS[subtype] : undefined;
          const indirect = asString(first?.type)?.toUpperCase() === 'INDIRECT';
          const transform = asString(first?.description) ?? asString(field?.transformationDescription) ?? (label ? (indirect ? `${label} (indirecto)` : label) : undefined);
          const id = `${d.key}\u0001${column}\u0001${from.key}\u0001${inputField}`;
          const known = j.lineage.get(id);
          const masking = transformations.some((t) => t.masking === true) || known?.masking === true;
          j.lineage.set(id, { out: d.key, column, from: from.key, field: inputField, ...((transform ?? known?.transform) ? { transform: transform ?? known!.transform } : {}), masking });
        }
      }
    }
    if (inputs.length > 0 && outputs.length > 0) j.signatures.add(`${[...new Set(inputs)].sort().join('|')}→${[...new Set(outputs)].sort().join('|')}`);
  }

  if (accepted === 0) {
    throw new DataImportError(
      failedEvents > 0
        ? `Los ${failedEvents} evento(s) de OpenLineage son FAIL o ABORT: una ejecución fallida no da linaje, así que no hay nada que importar.`
        : datasetEvents > 0
          ? 'El archivo solo tiene eventos de dataset (sin «job»): no hay linaje que importar.'
          : 'El archivo no contiene eventos de OpenLineage: se esperaba un evento con «eventTime», «producer» y «job» (o una lista o un evento por línea).',
    );
  }

  // ───────────── activos: contenedores, tablas, archivos y streams ─────────────
  const ids = new Set<string>();
  const assets: DataAsset[] = [];
  const containers = new Map<string, DataAsset>();
  const unknownPlatforms: string[] = [];
  const containerFor = (d: Dataset): DataAsset | undefined => {
    const { key, platform } = platformOf(d.namespace);
    if (platform?.placement === 'stream') return undefined;
    let c = containers.get(d.namespace);
    if (!c) {
      if (!platform) unknownPlatforms.push(key);
      const kind: AssetKind = platform ? platform.placement : 'source';
      c = {
        id: pickId(slugify(d.namespace) || 'fuente', ids),
        kind,
        name: d.sourceName ?? d.namespace,
        description: `Namespace de OpenLineage «${d.namespace}».`,
        ...(platform ? { technology: platform.label } : {}),
      };
      containers.set(d.namespace, c);
      assets.push(c);
    }
    return c;
  };
  for (const d of datasets.values()) {
    const { platform } = platformOf(d.namespace);
    const kind: AssetKind = platform?.placement === 'stream' ? 'stream' : platform?.placement === 'lake' ? 'file' : 'table';
    const parent = containerFor(d);
    // El nombre del dataset suele bastar como id; si otro namespace ya lo usa, se antepone el del contenedor.
    const base = slugify(d.name) || 'dataset';
    const id = ids.has(base) ? pickId(slugify(`${parent?.name ?? d.namespace}-${d.name}`) || base, ids) : pickId(base, ids);
    const technology = d.technology ?? (kind === 'stream' ? platform?.label : undefined);
    d.asset = {
      id,
      kind,
      name: d.name,
      ...(d.description ? { description: d.description } : {}),
      ...(technology ? { technology } : {}),
      ...(d.owner ? { owner: d.owner } : {}),
      ...(parent ? { parentId: parent.id } : {}),
      ...(kind === 'stream' ? { description: [d.description, `Namespace de OpenLineage «${d.namespace}».`].filter(Boolean).join(' ') } : {}),
    };
    assets.push(d.asset);
  }

  // ───────────── jobs → pipelines ─────────────
  const pipelineIds = new Set<string>();
  const reserved = new Set(assets.map((a) => a.id));
  const pipelines: Pipeline[] = [];
  const selfLoops: string[] = [];
  const skippedJobs: string[] = [];
  const changing: string[] = [];
  let droppedMappings = 0;
  for (const job of jobs.values()) {
    const inputs = [...job.inputs].filter((k) => !job.outputs.has(k));
    if (inputs.length < job.inputs.size) selfLoops.push(job.name);
    const outputs = [...job.outputs];
    if (inputs.length === 0 || outputs.length === 0) {
      skippedJobs.push(`${job.name} (${outputs.length === 0 ? 'no escribe ningún dataset' : inputs.length === 0 && job.inputs.size > 0 ? 'solo lee lo que escribe' : 'no lee ningún dataset'})`);
      continue;
    }
    if (job.signatures.size > 1) changing.push(job.name);
    const inputSet = new Set(inputs);
    const mappings: ColumnMapping[] = [];
    const seen = new Set<string>();
    let masking = false;
    const addColumn = (dataset: Dataset, name: string): void => {
      if (!dataset.columns.has(name)) {
        dataset.columns.set(name, { name });
      }
    };
    for (const l of job.lineage.values()) {
      if (!job.outputs.has(l.out) || !inputSet.has(l.from)) {
        droppedMappings += 1;
        continue;
      }
      const [from, to] = [datasets.get(l.from)!, datasets.get(l.out)!];
      const mapKey = `${l.from}\u0001${l.field}\u0001${l.out}\u0001${l.column}`;
      if (seen.has(mapKey)) continue;
      seen.add(mapKey);
      addColumn(from, l.field);
      addColumn(to, l.column);
      masking ||= l.masking;
      mappings.push({ from: { assetId: from.asset!.id, column: l.field }, to: { assetId: to.asset!.id, column: l.column }, ...(l.transform ? { transform: l.transform } : {}) });
    }
    const tool = job.engine ?? toolLabel(job.integration) ?? toolLabel(/\/integration\/([a-z0-9_-]+)/i.exec(job.producer ?? '')?.[1]);
    const kind: PipelineKind = job.processingType === 'STREAMING' ? 'streaming' : job.integration?.toLowerCase() === 'dbt' ? 'elt' : 'batch';
    const description = [job.description, job.parent ? `Dentro de «${job.parent}»` : undefined, `Job de «${job.namespace}»`].filter(Boolean).join(' · ');
    pipelines.push({
      id: pickId(slugify(job.name) || 'pipeline', pipelineIds, reserved),
      name: job.name,
      kind,
      inputs: inputs.map((k) => datasets.get(k)!.asset!.id),
      outputs: outputs.map((k) => datasets.get(k)!.asset!.id),
      ...(tool ? { tool } : {}),
      ...(description ? { description: brief(description) } : {}),
      ...(job.owner ? { owner: job.owner } : {}),
      ...(masking ? { anonymizes: true } : {}),
      ...(mappings.length > 0 ? { mappings } : {}),
    });
  }
  if (pipelines.length === 0) {
    throw new DataImportError(`Ningún job tiene a la vez entradas y salidas, y un pipeline necesita al menos una de cada: ${skippedJobs.slice(0, 5).join('; ')}.`);
  }
  // Las columnas que solo aparecían en el linaje se añaden al activo (los mapeos exigen que existan).
  for (const d of datasets.values()) if (d.columns.size > 0) d.asset!.columns = [...d.columns.values()];

  // ───────────── avisos ─────────────
  if (failedEvents > 0) warnings.add(`${failedEvents} evento(s) FAIL o ABORT no cuentan para el linaje: una ejecución fallida no da linaje fiable.`);
  const failedOnly = [...failedJobs].filter(([key]) => !jobs.has(key)).map(([, name]) => name);
  if (failedOnly.length > 0) warnings.add(`${failedOnly.length} job(s) solo tienen ejecuciones fallidas o abortadas y no se importan: ${shortList(failedOnly)}.`);
  if (datasetEvents > 0) warnings.add(`${datasetEvents} evento(s) de dataset (DatasetEvent, sin «job») no se importan: solo aportan datasets cuando un job los lee o escribe.`);
  if (notEvents > 0) warnings.add(`${notEvents} registro(s) no son eventos de OpenLineage y se ignoran.`);
  if (unnamedDatasets > 0) warnings.add(`${unnamedDatasets} dataset(s) sin «namespace» o «name» se ignoran.`);
  if (skippedJobs.length > 0) warnings.add(`${skippedJobs.length} job(s) no se importan como pipeline porque necesitan al menos una entrada y una salida: ${skippedJobs.slice(0, 5).join('; ')}${skippedJobs.length > 5 ? `… (+${skippedJobs.length - 5})` : ''}. Sus datasets sí se importan como activos.`);
  if (selfLoops.length > 0) warnings.add(`${selfLoops.length} job(s) leen y escriben el mismo dataset (${shortList(selfLoops)}): se quita de sus entradas, porque un pipeline no puede leer y escribir el mismo activo.`);
  if (changing.length > 0) warnings.add(`${changing.length} job(s) cambiaron de entradas o salidas entre ejecuciones (${shortList(changing)}): se unen todas en un solo pipeline.`);
  if (droppedMappings > 0) warnings.add(`${droppedMappings} mapeo(s) de columna se descartan porque su origen no es una entrada del job o su destino no es una de sus salidas (p. ej. linaje indirecto de otro namespace).`);
  if (datasetLevelLineage > 0) warnings.add(`${datasetLevelLineage} dataset(s) traen linaje indirecto a nivel de dataset («columnLineage.dataset»): no se importa.`);
  if (nestedFields > 0) warnings.add(`${nestedFields} columna(s) con campos anidados (struct): se importa la columna, no sus campos.`);
  if (unknownPlatforms.length > 0) warnings.add(`${new Set(unknownPlatforms).size} namespace(s) con un esquema no reconocido (${shortList(unknownPlatforms)}) se importan como fuente.`);
  if (ignoredFacets.size > 0) {
    const listed = [...ignoredFacets].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    warnings.add(`Facets sin correspondencia en el modelo, que no se importan: ${listed.slice(0, 8).map(([name, n]) => `${name} ×${n}`).join(', ')}${listed.length > 8 ? `… (+${listed.length - 8})` : ''}.`);
  }

  const name = options.name?.trim() || options.fallbackName?.trim().replace(/\.(?:json|jsonl|ndjson)$/i, '') || 'Linaje de OpenLineage';
  const result = validateDataDocument({
    version: DATA_DOCUMENT_VERSION,
    workspace: { name, description: `Importado de ${accepted} evento(s) de OpenLineage: ${pipelines.length} pipeline(s) y ${datasets.size} dataset(s).` },
    domains: [],
    assets,
    pipelines,
    relations: [],
  });
  if (!result.ok) throw new DataImportError(`No se pudo construir un documento válido a partir de OpenLineage:\n${formatDataIssues(result.issues)}`);
  return { document: result.document, warnings: warnings.result() };
}
