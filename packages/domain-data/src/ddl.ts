import { contractEngine, contractTables } from './contract';
import { canonicalType, keyTypeAdvice, listEngines, parseType, resolveEngine, typeFor, unkeyableType, type EngineDef } from './engines';
import { inheritance } from './inherit';
import { isCatalogKind, type DataAsset, type DataDocument } from './types';

/**
 * Esquema físico de las tablas del modelo en el dialecto de su motor de base de datos: `CREATE TABLE` para los motores SQL y
 * Cassandra, un validador `$jsonSchema` para MongoDB, la petición `CreateTable` de DynamoDB y un esquema Avro para Kafka. El motor
 * de cada tabla es el suyo o el de su base, almacén o lago (`engine`), o el que se fuerza con `options.engine`.
 */

export const DEFAULT_ENGINE = 'postgresql';

export interface DdlColumn {
  name: string;
  type?: string;
  /** El tipo es lógico (`string`, `number`): se traduce al del motor sin avisar. */
  logical?: boolean;
  primaryKey: boolean;
  unique: boolean;
  required: boolean;
  pii: boolean;
  description?: string;
}

export interface DdlTable {
  name: string;
  description?: string;
  columns: DdlColumn[];
}

export interface DdlOptions {
  /** Fuerza el motor de todas las tablas (por defecto, el de cada una). */
  engine?: string;
  /**
   * Solo esta tabla o, si es una base, almacén, lago o fuente, las tablas que contiene. Con un producto de datos, las de los activos de sus
   * puertos de entrada y de salida; con una API de datos, las de los activos que expone; con un glosario, las de los activos con términos
   * suyos enlazados (un producto o una API en esa lista se sustituye, a su vez, por lo que enlaza).
   */
  assetId?: string;
  /** Genera el DDL desde el esquema de este contrato de datos en lugar de las columnas de los activos. */
  contractId?: string;
  /** Esquema (o keyspace, o conjunto de datos) que califica el nombre de las tablas. */
  schema?: string;
  /** `script` (por defecto): el comando del motor; `json`: solo el esquema JSON (MongoDB). */
  format?: 'script' | 'json';
}

export interface DdlResult {
  text: string;
  /** Lo que no se pudo traducir tal cual (tipos que el motor no tiene, tablas sin clave…). */
  warnings: string[];
}

const SIMPLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(
  'all alter and as asc by case check column constraint create current_date default delete desc drop else end foreign from grant group having if in index insert into is join key left like limit not null offset on or order primary references right row rows schema select set table then to trigger union unique update user values view when where with'.split(' '),
);

/** Nombre físico de una tabla a partir del nombre del activo: el mismo si ya es un identificador, o sus palabras unidas con guiones bajos. */
export function physicalName(name: string): string {
  if (SIMPLE.test(name)) return name;
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug ? (/^\d/.test(slug) ? `_${slug}` : slug) : 'tabla';
}

function quote(engine: EngineDef, name: string): string {
  if (SIMPLE.test(name) && !RESERVED.has(name.toLowerCase())) return name;
  const [open, close] = engine.sql?.quote ?? ['"', '"'];
  return `${open}${name.split(close).join(close + close)}${close}`;
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
const note = (c: DdlColumn): string => [c.description && oneLine(c.description), c.pii ? 'PII' : ''].filter(Boolean).join(' · ');

interface Built {
  /** Comando del motor. */
  script: string;
  /** Esquema JSON, si el motor lo tiene (MongoDB, DynamoDB, Kafka). */
  json?: unknown;
}

/** Tipo del motor para una columna, avisando de lo que se sustituye. */
function columnType(engine: EngineDef, table: DdlTable, column: DdlColumn, warnings: string[]): string {
  const { type, replaced } = typeFor(engine, column.type);
  if (!column.type) warnings.push(`«${table.name}.${column.name}» no declara tipo: se usa ${type} (${engine.label}).`);
  else if (replaced && !column.logical) warnings.push(`El tipo «${column.type}» de «${table.name}.${column.name}» no existe en ${engine.label}: se usa «${type}».`);
  return type;
}

/** Aviso de una clave primaria o única cuyo tipo el motor no admite como clave (una línea, para poder ir en un comentario SQL). */
function keyNotice(engine: EngineDef, table: DdlTable, column: DdlColumn, kind: 'pk' | 'uk'): string[] {
  const type = unkeyableType(engine, column.type, kind);
  return type ? [oneLine(`La clave ${kind === 'pk' ? 'primaria' : 'única'} «${table.name}.${column.name}» es de tipo «${type}», que ${engine.label} no admite como clave: su CREATE TABLE falla. ${keyTypeAdvice(engine, type)}`)] : [];
}

function sqlTable(engine: EngineDef, table: DdlTable, schema: string | undefined, warnings: string[], cql = false): string {
  const sql = engine.sql;
  const name = schema ? `${quote(engine, schema)}.${quote(engine, physicalName(table.name))}` : quote(engine, physicalName(table.name));
  const keys = table.columns.filter((c) => c.primaryKey);
  const rows = table.columns.map((c) => {
    const type = columnType(engine, table, c, warnings);
    const nullability = !cql && (c.required || c.primaryKey) ? ' NOT NULL' : '';
    const unique = !cql && c.unique && !c.primaryKey && sql?.unique !== false ? ' UNIQUE' : '';
    return { text: `${quote(engine, c.name)} ${type}${nullability}${unique}`, comment: note(c) };
  });
  if (keys.length > 0) {
    const names = keys.map((c) => quote(engine, c.name));
    // CQL: la primera columna de la clave es la de partición y las demás ordenan dentro de ella.
    rows.push({ text: cql ? `PRIMARY KEY ((${names[0]})${names.slice(1).map((n) => `, ${n}`).join('')})` : `PRIMARY KEY (${names.join(', ')})${sql?.pkSuffix ?? ''}`, comment: '' });
  } else if (cql) {
    warnings.push(`«${table.name}» no declara clave primaria y Cassandra la exige: se usa «${table.columns[0].name}».`);
    rows.push({ text: `PRIMARY KEY ((${quote(engine, table.columns[0].name)}))`, comment: '' });
  }
  if (!cql && sql?.unique === false && table.columns.some((c) => c.unique && !c.primaryKey)) warnings.push(`${engine.label} no admite UNIQUE: se omite en «${table.name}».`);
  // El DDL no se toca (el tipo es el que el modelo declara): lo que el motor rechazará se avisa, y el aviso viaja en el propio esquema.
  const uniques = table.columns.filter((c) => c.unique && !c.primaryKey);
  const notices = cql ? [] : [...keys.flatMap((c) => keyNotice(engine, table, c, 'pk')), ...uniques.flatMap((c) => keyNotice(engine, table, c, 'uk'))];
  warnings.push(...notices);
  const body = rows.map((r, i) => `    ${r.text}${i < rows.length - 1 ? ',' : ''}${r.comment ? ` -- ${r.comment}` : ''}`).join('\n');
  return `${notices.map((n) => `-- AVISO: ${n}\n`).join('')}CREATE TABLE ${name} (\n${body}\n)${sql?.tableSuffix ?? ''};`;
}

const BSON_ALIASES: Record<string, string> = { boolean: 'bool', decimal128: 'decimal' };

function mongoTable(engine: EngineDef, table: DdlTable, warnings: string[]): Built {
  const properties: Record<string, unknown> = {};
  for (const c of table.columns) {
    const type = canonicalType(engine, columnType(engine, table, c, warnings));
    const description = [c.description && oneLine(c.description), c.pii ? 'PII' : ''].filter(Boolean).join(' · ');
    properties[c.name] = { bsonType: BSON_ALIASES[type.toLowerCase()] ?? type, ...(description ? { description } : {}) };
  }
  const required = table.columns.filter((c) => c.required || c.primaryKey).map((c) => c.name);
  const jsonSchema = { bsonType: 'object', ...(required.length ? { required } : {}), properties };
  const collection = physicalName(table.name);
  const lines = [`db.createCollection(${JSON.stringify(collection)}, ${JSON.stringify({ validator: { $jsonSchema: jsonSchema } }, null, 2)});`];
  const keys = table.columns.filter((c) => c.primaryKey).map((c) => c.name);
  const index = (fields: string[]): string => `db.getCollection(${JSON.stringify(collection)}).createIndex({ ${fields.map((f) => `${JSON.stringify(f)}: 1`).join(', ')} }, { unique: true });`;
  if (keys.length > 0) lines.push(index(keys));
  for (const c of table.columns) if (c.unique && !c.primaryKey) lines.push(index([c.name]));
  return { script: lines.join('\n'), json: { collection, validator: { $jsonSchema: jsonSchema } } };
}

const DYNAMO_KEY_TYPES: Record<string, string> = { s: 'S', string: 'S', n: 'N', number: 'N', b: 'B', binary: 'B' };

function dynamoTable(engine: EngineDef, table: DdlTable, warnings: string[]): Built {
  let keys = table.columns.filter((c) => c.primaryKey);
  if (keys.length === 0) {
    warnings.push(`«${table.name}» no declara clave primaria y DynamoDB la exige: se usa «${table.columns[0].name}» como clave de partición.`);
    keys = [table.columns[0]];
  }
  if (keys.length > 2) warnings.push(`DynamoDB admite como mucho dos atributos de clave: de «${table.name}» solo se usan «${keys[0].name}» y «${keys[1].name}».`);
  const used = keys.slice(0, 2);
  const definitions = used.map((c) => {
    const type = columnType(engine, table, c, warnings);
    const key = DYNAMO_KEY_TYPES[type.toLowerCase()];
    if (!key) warnings.push(`La clave «${c.name}» de «${table.name}» es de tipo «${type}»: una clave de DynamoDB es S, N o B; se usa S.`);
    return { AttributeName: c.name, AttributeType: key ?? 'S' };
  });
  if (table.columns.length > used.length) warnings.push(`DynamoDB no tiene esquema: de «${table.name}» solo se declaran los atributos de clave.`);
  const request = {
    TableName: physicalName(table.name),
    AttributeDefinitions: definitions,
    KeySchema: used.map((c, i) => ({ AttributeName: c.name, KeyType: i === 0 ? 'HASH' : 'RANGE' })),
    BillingMode: 'PAY_PER_REQUEST',
  };
  return { script: JSON.stringify(request, null, 2), json: request };
}

/** Tipo Avro (con su tipo lógico) de un tipo de Kafka. */
function avroType(type: string): unknown {
  switch (type.toLowerCase()) {
    case 'date':
      return { type: 'int', logicalType: 'date' };
    case 'time-millis':
      return { type: 'int', logicalType: 'time-millis' };
    case 'time-micros':
      return { type: 'long', logicalType: 'time-micros' };
    case 'timestamp-millis':
    case 'timestamp-micros':
    case 'local-timestamp-millis':
    case 'local-timestamp-micros':
      return { type: 'long', logicalType: type.toLowerCase() };
    case 'uuid':
      return { type: 'string', logicalType: 'uuid' };
    case 'decimal':
      return { type: 'bytes', logicalType: 'decimal', precision: 18, scale: 2 };
    default:
      return parseType(type).base;
  }
}

function avroTable(engine: EngineDef, table: DdlTable, warnings: string[]): Built {
  const fields = table.columns.map((c) => {
    const type = avroType(columnType(engine, table, c, warnings));
    const optional = !(c.required || c.primaryKey);
    return { name: c.name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1'), type: optional ? ['null', type] : type, ...(optional ? { default: null } : {}), ...(note(c) ? { doc: note(c) } : {}) };
  });
  const record = { type: 'record', name: physicalName(table.name).replace(/[^A-Za-z0-9_]/g, '_'), ...(table.description ? { doc: oneLine(table.description) } : {}), fields };
  return { script: JSON.stringify(record, null, 2), json: record };
}

/** DDL de una tabla en el dialecto del motor. */
export function tableDdl(table: DdlTable, engine: EngineDef, options: { schema?: string } = {}): Built & { warnings: string[] } {
  const warnings: string[] = [];
  if (table.columns.length === 0) return { script: '', warnings: [`«${table.name}» no declara columnas: no se genera su esquema.`] };
  let built: Built;
  switch (engine.ddl) {
    case 'sql':
      built = { script: sqlTable(engine, table, options.schema, warnings) };
      break;
    case 'cql':
      built = { script: sqlTable(engine, table, options.schema, warnings, true) };
      break;
    case 'mongodb':
      built = mongoTable(engine, table, warnings);
      break;
    case 'dynamodb':
      built = dynamoTable(engine, table, warnings);
      break;
    default:
      built = avroTable(engine, table, warnings);
  }
  return { ...built, warnings };
}

function assetTable(a: DataAsset): DdlTable {
  return {
    name: a.name,
    ...(a.description ? { description: a.description } : {}),
    columns: (a.columns ?? []).map((c) => ({
      name: c.name,
      ...(c.type ? { type: c.type } : {}),
      primaryKey: c.keys?.includes('pk') ?? false,
      unique: c.keys?.includes('uk') ?? false,
      required: c.keys?.includes('pk') ? true : !c.nullable,
      pii: c.pii === true,
      ...(c.description ? { description: c.description } : {}),
    })),
  };
}

interface Item {
  table: DdlTable;
  engine: EngineDef;
  /** De dónde sale (la base que lo contiene, el contrato). */
  origin?: string;
}

const COMMENT: Record<EngineDef['ddl'], string | undefined> = { sql: '--', cql: '--', mongodb: '//', dynamodb: undefined, avro: undefined };

const engineIds = (): string => listEngines().map((e) => e.id).join(', ');

/** El motor que se fuerza con `--engine`; falla si no está en el registro. */
function forcedEngine(name: string | undefined): EngineDef | undefined {
  if (!name) return undefined;
  const engine = resolveEngine(name);
  if (!engine) throw new Error(`Motor desconocido «${name}». Motores: ${engineIds()}.`);
  return engine;
}

/**
 * Activos cuyas tablas entran en el esquema de un producto de datos, una API de datos o un glosario: los de los puertos de entrada y de
 * salida del producto, los que expone la API y los enlazados desde los términos del glosario. Un producto o una API que aparece en esa
 * lista (una API publicada como salida, un término enlazado a un producto) no tiene tablas propias y se sustituye por lo que él enlaza;
 * cada uno se recorre una sola vez, así que un ciclo no cuelga. Un id que no es un activo del documento se omite.
 */
function catalogTargets(doc: DataDocument, root: DataAsset, byId: Map<string, DataAsset>): DataAsset[] {
  const seen = new Set<string>();
  const found: DataAsset[] = [];
  const direct = (a: DataAsset): string[] => {
    if (a.kind === 'glossary') return (doc.terms ?? []).filter((t) => t.glossaryId === a.id).flatMap((t) => (t.links ?? []).map((l) => l.assetId));
    return a.kind === 'data-product' ? [...(a.inputPorts ?? []), ...(a.outputPorts ?? [])] : (a.exposes ?? []);
  };
  const visit = (a: DataAsset): void => {
    if (seen.has(a.id)) return;
    seen.add(a.id);
    if (!isCatalogKind(a.kind)) return void found.push(a);
    for (const id of direct(a)) {
      const next = byId.get(id);
      if (next) visit(next);
    }
  };
  visit(root);
  return found;
}

/** Qué no llega a tener tablas con columnas, según el tipo de activo que se pidió, para el aviso de un esquema vacío. */
const EMPTY_SCOPE: Record<'data-product' | 'data-api' | 'glossary', string> = {
  'data-product': 'ninguno de los activos de sus puertos de entrada y de salida',
  'data-api': 'ninguno de los activos que expone',
  glossary: 'ninguno de los activos enlazados desde sus términos',
};

function collect(doc: DataDocument, options: DdlOptions, warnings: string[]): Item[] {
  const forced = forcedEngine(options.engine);
  const fallback = resolveEngine(DEFAULT_ENGINE)!;

  if (options.contractId) {
    const contract = (doc.contracts ?? []).find((c) => c.id === options.contractId);
    if (!contract) throw new Error(`No existe el contrato «${options.contractId}». Contratos: ${(doc.contracts ?? []).map((c) => c.id).join(', ') || 'ninguno'}.`);
    const content = contract.content ?? '';
    const user = doc.assets.find((a) => a.contractId === contract.id);
    const declared = user ? resolveEngine(inheritance(doc).engineOf(user.id)) : undefined;
    const engine = forced ?? contractEngine(content) ?? declared;
    if (!engine) warnings.push(`El contrato «${contract.name}» no declara su servidor (servers[].type) ni lo usa un activo con motor: se usa ${fallback.label}.`);
    const tables = contractTables(content);
    if (tables.length === 0) warnings.push(`El contrato «${contract.name}» no tiene tablas en su «schema».`);
    return tables.map((t) => ({ table: t, engine: engine ?? fallback, origin: `contrato «${contract.name}»` }));
  }

  const { engineOf } = inheritance(doc);
  const byId = new Map(doc.assets.map((a) => [a.id, a]));
  const within = (a: DataAsset, rootId: string): boolean => {
    for (let p: DataAsset | undefined = a, depth = 0; p && depth < 20; p = p.parentId ? byId.get(p.parentId) : undefined, depth += 1) if (p.id === rootId) return true;
    return false;
  };
  let assets: DataAsset[];
  if (options.assetId) {
    const root = byId.get(options.assetId);
    if (!root) throw new Error(`No existe el activo «${options.assetId}». Activos: ${doc.assets.map((a) => a.id).join(', ')}.`);
    if (isCatalogKind(root.kind)) {
      // Un producto, una API o un glosario no tienen tablas propias: las de los activos que enlazan.
      const roots = catalogTargets(doc, root, byId);
      assets = doc.assets.filter((a) => !isCatalogKind(a.kind) && roots.some((r) => within(a, r.id)) && (a.columns?.length ?? 0) > 0);
      if (assets.length === 0) warnings.push(`«${root.name}» no tiene tablas con columnas: ${EMPTY_SCOPE[root.kind as keyof typeof EMPTY_SCOPE]} las tiene.`);
    } else {
      assets = doc.assets.filter((a) => within(a, root.id) && (a.columns?.length ?? 0) > 0);
      if (assets.length === 0) warnings.push(`«${root.name}» no contiene tablas con columnas.`);
    }
  } else {
    // Una tabla, y un stream si su motor es de streaming; las vistas no tienen esquema propio.
    assets = doc.assets.filter((a) => (a.columns?.length ?? 0) > 0 && (a.kind === 'table' || (a.kind === 'stream' && resolveEngine(engineOf(a.id))?.family === 'stream')));
  }
  assets = assets.filter((a) => {
    if (a.kind !== 'view') return true;
    warnings.push(`«${a.name}» es una vista: su DDL depende de la consulta que la define y no se genera.`);
    return false;
  });

  const undeclared: string[] = [];
  const items = assets.map((a): Item => {
    const raw = engineOf(a.id);
    const declared = resolveEngine(raw);
    if (raw && !declared && !forced) warnings.push(`El motor «${raw}» de «${a.name}» no está en el registro (${engineIds()}): se usa ${fallback.label}.`);
    if (!raw && !forced) undeclared.push(a.name);
    const host = a.parentId ? byId.get(a.parentId) : undefined;
    return { table: assetTable(a), engine: forced ?? declared ?? fallback, ...(host ? { origin: host.name } : {}) };
  });
  if (undeclared.length > 0) warnings.push(`Sin motor declarado (engine) en ${undeclared.map((n) => `«${n}»`).join(', ')}: se usa ${fallback.label}.`);
  return items;
}

/**
 * Genera el esquema físico de las tablas del documento: una sección por motor, cada tabla en su dialecto. Falla si el motor o el
 * activo pedidos no existen; lo demás (tipos que el motor no tiene, tablas sin clave) se devuelve como avisos.
 */
export function toDdl(doc: DataDocument, options: DdlOptions = {}): DdlResult {
  const warnings: string[] = [];
  const items = collect(doc, options, warnings);
  const groups = new Map<string, Item[]>();
  for (const item of items) groups.set(item.engine.id, [...(groups.get(item.engine.id) ?? []), item]);
  const sections: string[] = [];

  for (const group of groups.values()) {
    const engine = group[0].engine;
    const built = group.map((item) => ({ item, ...tableDdl(item.table, engine, { schema: options.schema }) }));
    for (const b of built) warnings.push(...b.warnings);
    const ready = built.filter((b) => b.script);
    if (ready.length === 0) continue;
    const prefix = COMMENT[engine.ddl];
    const head = groups.size > 1 && prefix ? [`${prefix} ${engine.label}`] : [];
    if (options.format === 'json' && engine.ddl === 'mongodb') {
      sections.push(JSON.stringify(Object.fromEntries(ready.map((b) => [(b.json as { collection: string }).collection, (b.json as { validator: unknown }).validator])), null, 2));
    } else if (!prefix) {
      // Esquemas JSON (DynamoDB, Kafka): uno, o una lista si son varios.
      sections.push(JSON.stringify(ready.length === 1 ? ready[0].json : ready.map((b) => b.json), null, 2));
    } else {
      sections.push([...head, ...ready.map((b) => `${prefix} ${b.item.table.name}${b.item.origin ? ` · ${b.item.origin}` : ''}\n${b.script}`)].join('\n\n'));
    }
  }
  return { text: sections.length > 0 ? `${sections.join('\n\n')}\n` : '', warnings: [...new Set(warnings)] };
}
