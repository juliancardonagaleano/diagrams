/**
 * Documento del módulo de datos: activos de datos (fuentes, bases, almacenes, lagos, flujos, tablas, informes, modelos)
 * agrupados en dominios, los pipelines que los transforman (linaje) y las relaciones entre entidades (modelo
 * entidad-relación). Incluye gobierno: responsable, clasificación, datos personales y retención. Además del dato en
 * sí, el catálogo: productos de datos (con puertos de entrada y salida y su SLA), APIs de datos y glosarios de términos
 * de negocio enlazados a columnas y activos. No guarda coordenadas: los diagramas se calculan al exportar.
 */
export const DATA_DOCUMENT_VERSION = '1.0' as const;

export const ASSET_KINDS = ['source', 'database', 'warehouse', 'lake', 'stream', 'table', 'view', 'file', 'report', 'model', 'data-product', 'glossary', 'data-api'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/**
 * Tipos del catálogo, que describen cómo se ofrece y se entiende el dato más que el dato en sí: el producto de datos y la
 * API de datos se conectan por puertos a otros activos; el glosario agrupa términos de negocio.
 */
export const CATALOG_KINDS = ['data-product', 'glossary', 'data-api'] as const satisfies readonly AssetKind[];

/** Protocolos con los que una API de datos sirve sus activos. */
export const API_PROTOCOLS = ['rest', 'graphql', 'grpc', 'odata', 'sql', 'events'] as const;
export type ApiProtocol = (typeof API_PROTOCOLS)[number];

/** Estado de un término del glosario. Sin estado, un término es un borrador. */
export const TERM_STATUSES = ['draft', 'approved', 'deprecated'] as const;
export type TermStatus = (typeof TERM_STATUSES)[number];

/** De menos a más sensible. */
export const CLASSIFICATIONS = ['public', 'internal', 'confidential', 'restricted'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];
export const CLASSIFICATION_RANK: Record<Classification, number> = { public: 0, internal: 1, confidential: 2, restricted: 3 };

export const PIPELINE_KINDS = ['batch', 'elt', 'cdc', 'streaming', 'replication', 'api', 'manual'] as const;
export type PipelineKind = (typeof PIPELINE_KINDS)[number];

/** `1:N` = un origen se relaciona con varios destinos. */
export const CARDINALITIES = ['1:1', '1:N', 'N:1', 'N:M'] as const;
export type Cardinality = (typeof CARDINALITIES)[number];

export const COLUMN_KEYS = ['pk', 'fk', 'uk'] as const;
export type ColumnKey = (typeof COLUMN_KEYS)[number];

export interface Column {
  name: string;
  type?: string;
  keys?: ColumnKey[];
  nullable?: boolean;
  /** Contiene datos personales. */
  pii?: boolean;
  description?: string;
}

/** Formatos de contrato de datos: por ahora solo Open Data Contract (YAML). */
export const CONTRACT_FORMATS = ['odcs'] as const;
export type ContractFormat = (typeof CONTRACT_FORMATS)[number];

/** Contrato de datos de un activo (estilo Open Data Contract Standard): texto YAML que se edita y valida como adjunto. */
export interface DataContract {
  id: string;
  name: string;
  format: ContractFormat;
  version?: string;
  description?: string;
  url?: string;
  /** Contenido del contrato (el YAML). */
  content?: string;
}

export interface Domain {
  id: string;
  name: string;
  description?: string;
  owner?: string;
}

export interface DataAsset {
  id: string;
  kind: AssetKind;
  name: string;
  description?: string;
  technology?: string;
  /**
   * Motor de base de datos (`postgresql`, `mongodb`, `snowflake`…; ver el registro de `engines.ts`). Lo hereda lo que cuelga del
   * activo: una tabla usa el motor de su base, almacén o lago.
   */
  engine?: string;
  /** Responsable del dato (quien responde por él). */
  owner?: string;
  /** Custodio del día a día (calidad, catálogo). */
  steward?: string;
  domainId?: string;
  /** Activo que lo contiene: una tabla dentro de su base de datos, un archivo dentro de su lago. */
  parentId?: string;
  classification?: Classification;
  /** Contiene datos personales (además de lo que declaren sus columnas). */
  pii?: boolean;
  /** Cuánto tiempo se conserva (`7 años`). */
  retention?: string;
  external?: boolean;
  /** Referencia a un elemento de otro módulo (`urn:iark:integration:pedidos-db`). */
  ref?: string;
  /** Tipo del enlace que declara `ref` (vocabulario abierto; `depends-on` si falta): `implements`, `protects`… */
  refType?: string;
  tags?: string[];
  columns?: Column[];
  /** Contrato de datos del activo (`DataDocument.contracts`). */
  contractId?: string;
  /** Producto de datos: activos que consume (puertos de entrada). */
  inputPorts?: string[];
  /** Producto de datos: activos que publica (puertos de salida). */
  outputPorts?: string[];
  /** API de datos: activos que sirve. */
  exposes?: string[];
  /** Producto de datos: cada cuánto se actualiza o qué antigüedad máxima tienen sus datos (`24 h`, `15 min`). */
  freshness?: string;
  /** Producto de datos: nivel de servicio comprometido (`99,5 % de disponibilidad, soporte L-V`). */
  sla?: string;
  /** API de datos: protocolo con el que se consume. */
  protocol?: ApiProtocol;
  /** API de datos: dirección o identificador del servicio (`https://api.acme.com/ventas/v1`). */
  endpoint?: string;
}

/** Un activo (y, si se indica, una de sus columnas) al que se enlaza un término del glosario. */
export interface TermLink {
  assetId: string;
  column?: string;
}

/** Término de negocio de un glosario: lo que significa y dónde se materializa en los datos. */
export interface GlossaryTerm {
  id: string;
  name: string;
  definition?: string;
  /** Quien responde por la definición. */
  owner?: string;
  status?: TermStatus;
  /** Glosario (activo de tipo `glossary`) al que pertenece. */
  glossaryId?: string;
  synonyms?: string[];
  /** Activos y columnas que implementan el término. */
  links?: TermLink[];
}

/** Una columna de un activo (`assetId` + nombre de la columna). */
export interface ColumnRef {
  assetId: string;
  column: string;
}

/** Linaje a nivel de columna: la columna `from` (de una entrada del pipeline) alimenta la columna `to` (de una salida). */
export interface ColumnMapping {
  from: ColumnRef;
  to: ColumnRef;
  /** Cómo se obtiene (`copia`, `sha256(valor)`, `suma por mes`). */
  transform?: string;
}

export interface Pipeline {
  id: string;
  name: string;
  kind: PipelineKind;
  /** Activos que lee. */
  inputs: string[];
  /** Activos que escribe. */
  outputs: string[];
  tool?: string;
  /** Frecuencia (`diaria 02:00`, `cada 5 min`). */
  schedule?: string;
  description?: string;
  owner?: string;
  /** Anonimiza o enmascara los datos personales: sus salidas pueden tener una clasificación menor que sus entradas. */
  anonymizes?: boolean;
  /** Mapeos columna origen → columna destino (opcional): linaje a nivel de columna. */
  mappings?: ColumnMapping[];
}

/** Mínimo de cada extremo de una relación: `0` = opcional (puede no haber ninguno), `1` = obligatorio (al menos uno). */
export const PARTICIPATIONS = [0, 1] as const;
export type Participation = (typeof PARTICIPATIONS)[number];

export interface Relation {
  id: string;
  sourceId: string;
  targetId: string;
  cardinality: Cardinality;
  description?: string;
  /**
   * Opcionalidad del origen: cuántos orígenes, como mínimo, tiene cada destino. Sin indicar, `1` si la cardinalidad dice que es uno
   * (`1:N`: `1`) y `0` si dice varios (`N:1`: `0..*`). Con `0` en un extremo de uno, `0..1`; con `1` en uno de varios, `1..*`.
   */
  sourceMin?: Participation;
  /** Opcionalidad del destino: cuántos destinos, como mínimo, tiene cada origen (mismos valores por defecto que `sourceMin`). */
  targetMin?: Participation;
}

export interface DataDocument {
  version: typeof DATA_DOCUMENT_VERSION;
  workspace: { name: string; description?: string };
  domains: Domain[];
  assets: DataAsset[];
  pipelines: Pipeline[];
  relations: Relation[];
  /** Contratos de datos (adjuntos con editor propio); se asocian a los activos con `contractId`. */
  contracts?: DataContract[];
  /** Términos de negocio de los glosarios (activos de tipo `glossary`), enlazados a activos y columnas. */
  terms?: GlossaryTerm[];
}

/** Tipos que pueden contener a cada tipo de activo. */
export const PARENT_KINDS: Partial<Record<AssetKind, AssetKind[]>> = {
  table: ['database', 'warehouse', 'lake', 'source'],
  view: ['database', 'warehouse', 'lake'],
  file: ['lake', 'source'],
};

/** Activos que pueden declarar un motor de base de datos (los de dentro lo heredan). */
export const ENGINE_KINDS: AssetKind[] = ['source', 'database', 'warehouse', 'lake', 'stream'];

/** Activos que describen una entidad (tienen columnas y pueden relacionarse en el modelo entidad-relación). */
export const ENTITY_KINDS: AssetKind[] = ['table', 'view', 'file', 'stream'];

export const KIND_LABELS: Record<AssetKind, string> = {
  source: 'Fuente',
  database: 'Base de datos',
  warehouse: 'Almacén de datos',
  lake: 'Data lake',
  stream: 'Stream',
  table: 'Tabla',
  view: 'Vista',
  file: 'Archivo',
  report: 'Informe',
  model: 'Modelo',
  'data-product': 'Producto de datos',
  glossary: 'Glosario',
  'data-api': 'API de datos',
};

export const TERM_LABEL = 'Término';

export const TERM_STATUS_LABELS: Record<TermStatus, string> = { draft: 'borrador', approved: 'aprobado', deprecated: 'obsoleto' };

export const API_PROTOCOL_LABELS: Record<ApiProtocol, string> = { rest: 'REST', graphql: 'GraphQL', grpc: 'gRPC', odata: 'OData', sql: 'SQL (JDBC/ODBC)', events: 'Eventos (AsyncAPI)' };

/** ¿El activo es de un tipo del catálogo (producto, glosario o API de datos)? */
export const isCatalogKind = (kind: AssetKind): boolean => (CATALOG_KINDS as readonly string[]).includes(kind);

export const PIPELINE_LABELS: Record<PipelineKind, string> = {
  batch: 'ETL por lotes',
  elt: 'ELT',
  cdc: 'CDC',
  streaming: 'Streaming',
  replication: 'Replicación',
  api: 'Extracción por API',
  manual: 'Manual',
};

export const CLASSIFICATION_LABELS: Record<Classification, string> = {
  public: 'pública',
  internal: 'interna',
  confidential: 'confidencial',
  restricted: 'restringida',
};

/** ¿El activo contiene datos personales, por su marca o por alguna de sus columnas? */
export function hasPii(asset: DataAsset): boolean {
  return asset.pii === true || (asset.columns ?? []).some((c) => c.pii === true);
}
