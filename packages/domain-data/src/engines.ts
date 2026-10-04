/**
 * Registro de motores de base de datos. Cada motor describe su catálogo de tipos de columna (para validar `columns[].type` y los
 * `physicalType` de un contrato de datos y sugerir el tipo que sí existe) y cómo se escribe su esquema (DDL). Los motores
 * incluidos cubren los más usados; `registerEngine` añade o sustituye uno sin tocar el resto del módulo.
 */

/** Idea de tipo a la que se reducen los de todos los motores: sirve para proponer el equivalente y para generar DDL. */
export const TYPE_CONCEPTS = ['string', 'text', 'smallint', 'integer', 'bigint', 'decimal', 'float', 'double', 'boolean', 'date', 'time', 'timestamp', 'timestamptz', 'uuid', 'json', 'binary'] as const;
export type TypeConcept = (typeof TYPE_CONCEPTS)[number];

export type EngineFamily = 'sql' | 'document' | 'wide-column' | 'key-value' | 'stream';
/** Forma del esquema que genera `toDdl`: `CREATE TABLE` de SQL o CQL, validador de MongoDB, `CreateTable` de DynamoDB o esquema Avro. */
export type DdlStyle = 'sql' | 'cql' | 'mongodb' | 'dynamodb' | 'avro';

export interface EngineDef {
  /** Identificador en minúsculas: el que se escribe en `engine` (`postgresql`, `mongodb`…). */
  id: string;
  label: string;
  family: EngineFamily;
  ddl: DdlStyle;
  /** Otros nombres con que se le conoce (`postgres`, `pg`): se aceptan en `engine` y en el `type` del servidor de un contrato. */
  aliases?: readonly string[];
  /** Nombre del motor en `servers[].type` de Open Data Contract cuando no es su id (`postgres`). */
  serverType?: string;
  /** Catálogo de tipos de columna, sin parámetros (`varchar`, no `varchar(255)`). */
  types: readonly string[];
  /** Tipo con el que se escribe cada concepto en este motor (puede llevar parámetros: `varchar(255)`). */
  concepts: Readonly<Record<TypeConcept, string>>;
  /** Parámetros que se añaden a un tipo escrito sin ellos porque sin ellos no significa lo que se quiere (`varchar` sin longitud en MySQL; `numeric` es `(10,0)`). */
  defaultParams?: Readonly<Record<string, string>>;
  /** Acepta cualquier nombre de tipo (SQLite): uno fuera del catálogo es una nota, no un aviso. */
  lenient?: boolean;
  /**
   * Solo SQL: comillas de los identificadores, cláusula tras la clave primaria y cierre de la tabla; `unique: false` si no admite `UNIQUE`;
   * `noKeyTypes`: tipos que el motor rechaza como clave, primaria o única (en MySQL, `text`, `blob` y `json`, que piden una longitud de
   * prefijo): el DDL no los cambia, pero se avisa. Un nombre sin parámetros (`text`) vale con cualquiera; con parámetros (`varchar(max)`
   * en SQL Server) solo con esa forma, así que `varchar(255)` sigue sirviendo de clave.
   */
  sql?: { quote: readonly [string, string]; pkSuffix?: string; unique?: boolean; tableSuffix?: string; noKeyTypes?: readonly string[] };
}

const list = (text: string): string[] => text.split('|');
const concepts = (...types: string[]): Record<TypeConcept, string> => Object.fromEntries(TYPE_CONCEPTS.map((c, i) => [c, types[i]])) as Record<TypeConcept, string>;
// Orden de los conceptos:         string, text, smallint, integer, bigint, decimal, float, double, boolean, date, time, timestamp, timestamptz, uuid, json, binary

const ENGINES: EngineDef[] = [
  {
    id: 'postgresql',
    label: 'PostgreSQL',
    family: 'sql',
    ddl: 'sql',
    aliases: ['postgres', 'pg', 'psql'],
    serverType: 'postgres',
    types: list(
      'smallint|integer|int|int2|int4|int8|bigint|smallserial|serial|serial2|serial4|serial8|bigserial|decimal|numeric|real|float|float4|float8|double precision|money|boolean|bool|char|character|bpchar|varchar|character varying|text|citext|name|bytea|date|time|time without time zone|time with time zone|timetz|timestamp|timestamp without time zone|timestamp with time zone|timestamptz|interval|uuid|json|jsonb|xml|inet|cidr|macaddr|macaddr8|bit|bit varying|varbit|tsvector|tsquery|point|line|lseg|box|path|polygon|circle|hstore|ltree|oid|int4range|int8range|numrange|daterange|tsrange|tstzrange',
    ),
    concepts: concepts('varchar(255)', 'text', 'smallint', 'integer', 'bigint', 'numeric(18,2)', 'real', 'double precision', 'boolean', 'date', 'time', 'timestamp', 'timestamptz', 'uuid', 'jsonb', 'bytea'),
    // Sin clase de operadores btree por defecto, que una clave necesita: `json` (`jsonb` sí la tiene), `xml` y los tipos geométricos.
    sql: { quote: ['"', '"'], noKeyTypes: list('json|xml|point|line|lseg|box|path|polygon|circle') },
  },
  {
    id: 'mysql',
    label: 'MySQL',
    family: 'sql',
    ddl: 'sql',
    aliases: ['mariadb'],
    types: list(
      'tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|dec|fixed|float|double|double precision|real|bit|bool|boolean|char|varchar|tinytext|text|mediumtext|longtext|binary|varbinary|tinyblob|blob|mediumblob|longblob|enum|set|date|datetime|timestamp|time|year|json|geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection',
    ),
    concepts: concepts('varchar(255)', 'text', 'smallint', 'int', 'bigint', 'decimal(18,2)', 'float', 'double', 'boolean', 'date', 'time', 'datetime', 'timestamp', 'char(36)', 'json', 'blob'),
    defaultParams: { varchar: '(255)', varbinary: '(255)', decimal: '(18,2)', numeric: '(18,2)', dec: '(18,2)', fixed: '(18,2)' },
    sql: { quote: ['`', '`'], noKeyTypes: list('tinytext|text|mediumtext|longtext|tinyblob|blob|mediumblob|longblob|json') },
  },
  {
    id: 'sqlserver',
    label: 'SQL Server',
    family: 'sql',
    ddl: 'sql',
    aliases: ['mssql', 'sql-server', 'azure-sql'],
    types: list(
      'bigint|int|smallint|tinyint|bit|decimal|numeric|money|smallmoney|float|real|date|datetime|datetime2|datetimeoffset|smalldatetime|time|char|varchar|text|nchar|nvarchar|ntext|binary|varbinary|image|uniqueidentifier|xml|sql_variant|hierarchyid|geography|geometry|rowversion|timestamp|json',
    ),
    concepts: concepts('nvarchar(255)', 'nvarchar(max)', 'smallint', 'int', 'bigint', 'decimal(18,2)', 'real', 'float', 'bit', 'date', 'time', 'datetime2', 'datetimeoffset', 'uniqueidentifier', 'nvarchar(max)', 'varbinary(max)'),
    defaultParams: { varchar: '(255)', nvarchar: '(255)', varbinary: '(255)', decimal: '(18,2)', numeric: '(18,2)', dec: '(18,2)' },
    // Los tipos de objeto grande no entran en un índice: `text`, `ntext`, `image`, `xml` y los `(max)` (`varchar(255)` sí).
    sql: { quote: ['[', ']'], noKeyTypes: list('text|ntext|image|xml|varchar(max)|nvarchar(max)|varbinary(max)') },
  },
  {
    id: 'oracle',
    label: 'Oracle',
    family: 'sql',
    ddl: 'sql',
    types: list(
      'number|float|binary_float|binary_double|integer|int|smallint|decimal|numeric|dec|real|double precision|char|varchar2|varchar|nchar|nvarchar2|long|clob|nclob|blob|bfile|raw|long raw|date|timestamp|timestamp with time zone|timestamp with local time zone|interval year to month|interval day to second|rowid|urowid|xmltype|json|boolean|sdo_geometry',
    ),
    concepts: concepts('varchar2(255)', 'clob', 'number(5)', 'number(10)', 'number(19)', 'number(18,2)', 'binary_float', 'binary_double', 'number(1)', 'date', 'varchar2(15)', 'timestamp', 'timestamp with time zone', 'raw(16)', 'json', 'blob'),
    defaultParams: { varchar2: '(255)', nvarchar2: '(255)', raw: '(255)', decimal: '(18,2)', numeric: '(18,2)', dec: '(18,2)' },
    // ORA-02329: ni los LOB ni `long` y `long raw` pueden ser clave primaria o única.
    sql: { quote: ['"', '"'], noKeyTypes: list('clob|nclob|blob|long|long raw') },
  },
  {
    id: 'sqlite',
    label: 'SQLite',
    family: 'sql',
    ddl: 'sql',
    aliases: ['sqlite3'],
    lenient: true,
    types: list(
      'integer|int|tinyint|smallint|mediumint|bigint|int2|int8|unsigned big int|real|double|double precision|float|numeric|decimal|boolean|date|datetime|timestamp|time|text|char|character|varchar|varying character|nchar|native character|nvarchar|clob|blob|json',
    ),
    concepts: concepts('text', 'text', 'smallint', 'integer', 'bigint', 'numeric', 'real', 'real', 'boolean', 'date', 'time', 'datetime', 'datetime', 'text', 'json', 'blob'),
    sql: { quote: ['"', '"'] },
  },
  {
    id: 'bigquery',
    label: 'BigQuery',
    family: 'sql',
    ddl: 'sql',
    aliases: ['bq'],
    types: list(
      'int64|int|smallint|integer|bigint|tinyint|byteint|numeric|decimal|bignumeric|bigdecimal|float64|bool|boolean|string|bytes|date|datetime|time|timestamp|geography|json|interval|array|struct|range',
    ),
    concepts: concepts('string', 'string', 'int64', 'int64', 'int64', 'numeric', 'float64', 'float64', 'bool', 'date', 'time', 'datetime', 'timestamp', 'string', 'json', 'bytes'),
    sql: { quote: ['`', '`'], pkSuffix: ' NOT ENFORCED', unique: false },
  },
  {
    id: 'snowflake',
    label: 'Snowflake',
    family: 'sql',
    ddl: 'sql',
    types: list(
      'number|decimal|dec|numeric|int|integer|bigint|smallint|tinyint|byteint|float|float4|float8|double|double precision|real|varchar|char|character|string|text|binary|varbinary|boolean|date|datetime|time|timestamp|timestamp_ltz|timestamp_ntz|timestamp_tz|variant|object|array|geography|geometry|vector',
    ),
    concepts: concepts('varchar', 'varchar', 'smallint', 'integer', 'bigint', 'number(18,2)', 'float', 'float', 'boolean', 'date', 'time', 'timestamp_ntz', 'timestamp_tz', 'varchar(36)', 'variant', 'binary'),
    defaultParams: { decimal: '(18,2)', numeric: '(18,2)', dec: '(18,2)' },
    sql: { quote: ['"', '"'] },
  },
  {
    id: 'redshift',
    label: 'Amazon Redshift',
    family: 'sql',
    ddl: 'sql',
    types: list(
      'smallint|int2|integer|int|int4|bigint|int8|decimal|numeric|real|float4|double precision|float8|float|boolean|bool|char|character|nchar|bpchar|varchar|character varying|nvarchar|text|date|time|timetz|time without time zone|time with time zone|timestamp|timestamptz|timestamp without time zone|timestamp with time zone|interval year to month|interval day to second|geometry|geography|hllsketch|super|varbyte|varbinary|binary varying',
    ),
    concepts: concepts('varchar(255)', 'varchar(65535)', 'smallint', 'integer', 'bigint', 'decimal(18,2)', 'real', 'double precision', 'boolean', 'date', 'time', 'timestamp', 'timestamptz', 'char(36)', 'super', 'varbyte'),
    defaultParams: { decimal: '(18,2)', numeric: '(18,2)' },
    sql: { quote: ['"', '"'] },
  },
  {
    id: 'databricks',
    label: 'Databricks',
    family: 'sql',
    ddl: 'sql',
    aliases: ['spark', 'delta'],
    types: list(
      'tinyint|byte|smallint|short|int|integer|bigint|long|float|real|double|decimal|dec|numeric|boolean|string|varchar|char|binary|date|timestamp|timestamp_ntz|interval|array|map|struct|variant|void|object',
    ),
    concepts: concepts('string', 'string', 'smallint', 'int', 'bigint', 'decimal(18,2)', 'float', 'double', 'boolean', 'date', 'string', 'timestamp_ntz', 'timestamp', 'string', 'string', 'binary'),
    defaultParams: { decimal: '(18,2)', numeric: '(18,2)', dec: '(18,2)' },
    sql: { quote: ['`', '`'], unique: false, tableSuffix: ' USING DELTA' },
  },
  {
    id: 'mongodb',
    label: 'MongoDB',
    family: 'document',
    ddl: 'mongodb',
    aliases: ['mongo'],
    types: list(
      'string|int|long|double|decimal|decimal128|number|bool|boolean|date|timestamp|objectId|binData|object|array|null|regex|javascript|javascriptWithScope|symbol|dbPointer|undefined|minKey|maxKey',
    ),
    concepts: concepts('string', 'string', 'int', 'int', 'long', 'decimal', 'double', 'double', 'bool', 'date', 'string', 'date', 'date', 'binData', 'object', 'binData'),
  },
  {
    id: 'cassandra',
    label: 'Apache Cassandra',
    family: 'wide-column',
    ddl: 'cql',
    aliases: ['scylla', 'scylladb'],
    types: list(
      'ascii|bigint|blob|boolean|counter|date|decimal|double|duration|float|inet|int|smallint|text|time|timestamp|timeuuid|tinyint|uuid|varchar|varint|list|set|map|frozen|tuple',
    ),
    concepts: concepts('text', 'text', 'smallint', 'int', 'bigint', 'decimal', 'float', 'double', 'boolean', 'date', 'time', 'timestamp', 'timestamp', 'uuid', 'text', 'blob'),
  },
  {
    id: 'dynamodb',
    label: 'Amazon DynamoDB',
    family: 'key-value',
    ddl: 'dynamodb',
    aliases: ['dynamo'],
    types: list('S|N|B|BOOL|NULL|M|L|SS|NS|BS|string|number|binary|boolean|map|list'),
    concepts: concepts('S', 'S', 'N', 'N', 'N', 'N', 'N', 'N', 'BOOL', 'S', 'S', 'S', 'S', 'S', 'M', 'B'),
  },
  {
    id: 'kafka',
    label: 'Apache Kafka',
    family: 'stream',
    ddl: 'avro',
    aliases: ['redpanda', 'confluent'],
    types: list(
      'null|boolean|int|long|float|double|bytes|string|record|enum|array|map|union|fixed|date|time-millis|time-micros|timestamp-millis|timestamp-micros|local-timestamp-millis|local-timestamp-micros|uuid|decimal|duration',
    ),
    concepts: concepts('string', 'string', 'int', 'int', 'long', 'decimal', 'float', 'double', 'boolean', 'date', 'time-millis', 'timestamp-millis', 'timestamp-millis', 'uuid', 'string', 'bytes'),
  },
];

const registry = new Map<string, EngineDef>();
const names = new Map<string, EngineDef>();
const catalogs = new WeakMap<EngineDef, Map<string, string>>();

const key = (name: string): string => name.trim().toLowerCase().replace(/[\s_]+/g, '-');

function index(): void {
  names.clear();
  for (const engine of registry.values()) for (const name of [engine.id, engine.serverType, ...(engine.aliases ?? [])]) if (name) names.set(key(name), engine);
}

/** Añade un motor al registro, o sustituye el que tenga el mismo `id`. */
export function registerEngine(engine: EngineDef): void {
  const id = engine.id.trim().toLowerCase();
  if (!id) throw new Error('Un motor necesita un id.');
  registry.set(id, { ...engine, id });
  index();
}

for (const engine of ENGINES) registry.set(engine.id, engine);
index();

/** Ids de los motores que trae el módulo (el registro puede tener más). */
export const BUILTIN_ENGINE_IDS: readonly string[] = ENGINES.map((e) => e.id);

/** Motores registrados, los incluidos primero. */
export function listEngines(): EngineDef[] {
  return [...registry.values()];
}

/** Motor por su id, un alias (`postgres`) o el `type` de un servidor de contrato; `undefined` si no está registrado. */
export function resolveEngine(name: string | undefined): EngineDef | undefined {
  return name && name.trim() ? names.get(key(name)) : undefined;
}

// ───────────── tipos ─────────────

export interface ParsedType {
  /** Nombre del tipo en minúsculas, sin longitud ni precisión (`character varying`, `list`). */
  base: string;
  /** Tipos entre `<…>` (`list<text>`, `map<text, int>`, `struct<a int64>`). */
  inner: string[];
  /** Es una lista (`text[]`). */
  array: boolean;
}

function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '<' || c === '(') depth += 1;
    else if (c === '>' || c === ')') depth -= 1;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(from, i).trim());
      from = i + 1;
    }
  }
  parts.push(text.slice(from).trim());
  return parts.filter(Boolean);
}

/** Descompone el texto de un tipo de columna: quita parámetros (`varchar(255)`), modificadores (`unsigned`) y sufijos de lista (`[]`). */
export function parseType(text: string): ParsedType {
  let t = text.trim().toLowerCase().replace(/\s+/g, ' ');
  let array = false;
  while (/\[\d*\]$/.test(t)) {
    t = t.replace(/\s*\[\d*\]$/, '');
    array = true;
  }
  const open = t.indexOf('<');
  if (open > 0 && t.endsWith('>')) return { base: t.slice(0, open).trim(), inner: splitTop(t.slice(open + 1, -1)), array };
  t = t
    .replace(/\([^)]*\)/g, '')
    .replace(/\b(unsigned|signed|zerofill)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { base: t, inner: [], array };
}

/** Concepto al que se reduce un tipo (de cualquier motor): `varchar2` y `text` son texto, `int8` y `long` enteros largos… */
export function conceptOf(text: string): TypeConcept {
  const { base, array } = parseType(text);
  if (array) return 'json';
  if (/^(uuid|uniqueidentifier|guid|timeuuid)$/.test(base)) return 'uuid';
  if (/^(bool|boolean|bit)$/.test(base)) return 'boolean';
  if (/^(tinyint|smallint|int2|short|byteint|smallserial|serial2)$/.test(base)) return 'smallint';
  if (/^(bigint|int8|int64|long|bigserial|serial8|bigint unsigned)$/.test(base)) return 'bigint';
  if (/^(int|integer|int4|mediumint|serial|serial4|int32|varint|counter)$/.test(base)) return 'integer';
  if (/^(decimal|numeric|dec|number|money|smallmoney|bignumeric|bigdecimal|fixed|decimal128)$/.test(base)) return 'decimal';
  if (/^(real|float4|binary_float|float32)$/.test(base)) return 'float';
  if (/^(float|float8|float64|double|double precision|binary_double)$/.test(base)) return 'double';
  if (/^date$/.test(base)) return 'date';
  if (/^(time|timetz|time without time zone|time with time zone|time-millis|time-micros)$/.test(base)) return 'time';
  if (/(^|\s)(with time zone|with local time zone)$|^(timestamptz|datetimeoffset|timestamp_tz|timestamp_ltz)$/.test(base)) return 'timestamptz';
  if (/^(timestamp|datetime|datetime2|smalldatetime|timestamp_ntz|timestamp without time zone|timestamp-millis|timestamp-micros|local-timestamp-millis|local-timestamp-micros)$/.test(base)) return 'timestamp';
  if (/^(json|jsonb|variant|object|struct|map|super|document|xml|hstore|array|list|set)$/.test(base)) return 'json';
  if (/^(bytea|blob|tinyblob|mediumblob|longblob|binary|varbinary|bytes|image|raw|long raw|bindata|varbyte|binary varying|bfile)$/.test(base)) return 'binary';
  if (/^(text|clob|nclob|ntext|longtext|mediumtext|tinytext|citext)$/.test(base)) return 'text';
  return 'string';
}

const catalogOf = (engine: EngineDef): Map<string, string> => {
  let catalog = catalogs.get(engine);
  if (!catalog) {
    catalog = new Map(engine.types.map((t) => [t.toLowerCase(), t]));
    catalogs.set(engine, catalog);
  }
  return catalog;
};

/** Tipos de la forma `list<text>` cuyo contenido también se valida. */
const WRAPPERS = new Set(['list', 'set', 'map', 'frozen', 'tuple', 'array', 'struct', 'range']);

export type TypeCheck = { ok: true } | { ok: false; /** El nombre que el motor no tiene. */ unknown: string };

/** ¿Existe el tipo en el catálogo del motor? Con tipos anidados (`list<text>`), también los de dentro. */
export function checkType(engine: EngineDef, text: string): TypeCheck {
  const { base, inner } = parseType(text);
  if (!base) return { ok: true };
  if (!catalogOf(engine).has(base)) return { ok: false, unknown: base };
  if (WRAPPERS.has(base)) {
    for (const part of inner) {
      // `struct<nombre tipo, …>`: el tipo es lo que sigue al nombre del campo.
      const type = base === 'struct' ? part.replace(/^\S+\s+/, '') : part;
      const result = checkType(engine, type);
      if (!result.ok) return result;
    }
  }
  return { ok: true };
}

/** El tipo con las mayúsculas del catálogo del motor (`objectid` → `objectId`); el mismo texto si no está. */
export function canonicalType(engine: EngineDef, type: string): string {
  return catalogOf(engine).get(parseType(type).base) ?? type;
}

export function isKnownType(engine: EngineDef, text: string): boolean {
  return checkType(engine, text).ok;
}

/** Distancia de edición entre dos nombres de tipo (para proponer el que se quiso escribir). */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

/**
 * Tipos del motor que podrían ser el que se quiso escribir: el equivalente del concepto del tipo dado (`varchar2` → `varchar(255)`
 * en PostgreSQL) y los del catálogo de nombre parecido.
 */
export function suggestTypes(engine: EngineDef, text: string, limit = 4): string[] {
  const { base } = parseType(text);
  const found: string[] = [engine.concepts[conceptOf(text)]];
  const ranked = engine.types
    .map((t) => ({ t, d: distance(base, t.toLowerCase()) }))
    .filter(({ t, d }) => d <= Math.max(2, Math.floor(base.length / 3)) || (base.length >= 3 && (t.toLowerCase().includes(base) || base.includes(t.toLowerCase()))))
    .sort((x, y) => x.d - y.d || x.t.length - y.t.length);
  for (const { t } of ranked) if (!found.some((f) => parseType(f).base === t.toLowerCase())) found.push(t);
  return found.slice(0, limit);
}

/** Tipo de columna tal como lo escribe el motor para `type`: el mismo si existe (con los parámetros que necesita si va sin ellos) o el equivalente de su concepto. */
export function typeFor(engine: EngineDef, type: string | undefined): { type: string; replaced: boolean } {
  if (!type?.trim()) return { type: engine.concepts.string, replaced: false };
  const { base } = parseType(type);
  if (isKnownType(engine, type)) {
    const params = engine.defaultParams?.[base];
    return { type: params && !type.includes('(') ? `${type.trim()}${params}` : type.trim(), replaced: false };
  }
  return { type: engine.concepts[conceptOf(type)], replaced: true };
}

/** El texto de un tipo en forma canónica, con sus parámetros (`VARCHAR( MAX )` → `varchar(max)`): para compararlo con un tipo declarado con ellos. */
const withParams = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s*\(\s*/g, '(').replace(/\s*,\s*/g, ',').replace(/\s*\)/g, ')');

/**
 * Tipo con que el motor escribiría `type` si el motor no lo admite como clave primaria (`text` en MySQL, `clob` en Oracle, `varchar(max)` en
 * SQL Server); `undefined` si sirve de clave o no se sabe. Con `kind: 'uk'` se pregunta por una clave única, que el DDL solo escribe si el
 * motor admite `UNIQUE`: lo que el motor no admite como clave primaria tampoco lo admite como única.
 */
export function unkeyableType(engine: EngineDef, type: string | undefined, kind: 'pk' | 'uk' = 'pk'): string | undefined {
  const banned = engine.sql?.noKeyTypes;
  if (!banned || !type?.trim() || (kind === 'uk' && engine.sql?.unique === false)) return undefined;
  const written = typeFor(engine, type).type;
  const base = parseType(written).base;
  const full = withParams(written);
  return banned.some((b) => [base, full].includes(withParams(b))) ? written : undefined;
}

/**
 * Cómo arreglar una clave de un tipo que el motor no admite: un tipo de texto con longitud (`varchar(n)`, `varchar2(n)`) o, si la clave
 * es binaria (`blob`, `varbinary(max)`, `long raw`), el binario acotado del motor (`varbinary(n)`, `raw(n)`); en ambos casos, una clave sustituta.
 */
export function keyTypeAdvice(engine: EngineDef, type?: string): string {
  if (type && conceptOf(type) === 'binary') {
    const bounded = ['varbinary', 'raw', 'binary'].find((t) => engine.types.includes(t));
    return bounded ? `Usa ${bounded}(n) o una clave sustituta.` : 'Usa una clave sustituta.';
  }
  return `Usa ${parseType(engine.concepts.string).base}(n) o una clave sustituta.`;
}
