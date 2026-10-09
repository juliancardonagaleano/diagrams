import type { AiSpec } from '@iark/kernel';
import { z } from 'zod';
import { formatDataIssues, participationSchema, validateDataDocument } from '../schema';
import { BUILTIN_ENGINE_IDS } from '../engines';
import { API_PROTOCOLS, ASSET_KINDS, CARDINALITIES, CLASSIFICATIONS, COLUMN_KEYS, DATA_DOCUMENT_VERSION, PIPELINE_KINDS, TERM_STATUSES, type DataDocument } from '../types';

// Lo que produce el modelo: todos los campos presentes (null si no aplican), como exige la salida estructurada.
const nullable = <T extends z.ZodType>(t: T) => t.nullable();

const generatedColumn = z.object({
  name: z.string(),
  type: nullable(z.string()),
  keys: nullable(z.array(z.enum(COLUMN_KEYS))),
  nullable: nullable(z.boolean()),
  pii: nullable(z.boolean()),
  description: nullable(z.string()),
});

const generatedDomain = z.object({
  id: z.string(),
  name: z.string(),
  description: nullable(z.string()),
  owner: nullable(z.string()),
});

const generatedAsset = z.object({
  id: z.string(),
  kind: z.enum(ASSET_KINDS),
  name: z.string(),
  description: nullable(z.string()),
  technology: nullable(z.string()),
  engine: nullable(z.string().describe(`Motor de base de datos: ${BUILTIN_ENGINE_IDS.join(', ')}`)),
  owner: nullable(z.string()),
  steward: nullable(z.string()),
  domainId: nullable(z.string()),
  parentId: nullable(z.string()),
  classification: nullable(z.enum(CLASSIFICATIONS)),
  pii: nullable(z.boolean()),
  retention: nullable(z.string()),
  external: nullable(z.boolean()),
  columns: nullable(z.array(generatedColumn)),
  inputPorts: nullable(z.array(z.string())),
  outputPorts: nullable(z.array(z.string())),
  exposes: nullable(z.array(z.string())),
  freshness: nullable(z.string()),
  sla: nullable(z.string()),
  protocol: nullable(z.enum(API_PROTOCOLS)),
  endpoint: nullable(z.string()),
});

const generatedTerm = z.object({
  id: z.string(),
  name: z.string(),
  definition: nullable(z.string()),
  owner: nullable(z.string()),
  status: nullable(z.enum(TERM_STATUSES)),
  glossaryId: nullable(z.string()),
  synonyms: nullable(z.array(z.string())),
  links: nullable(z.array(z.object({ assetId: z.string(), column: nullable(z.string()) }))),
});

const generatedColumnRef = z.object({ assetId: z.string(), column: z.string() });

const generatedMapping = z.object({
  from: generatedColumnRef,
  to: generatedColumnRef,
  transform: nullable(z.string()),
});

const generatedPipeline = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(PIPELINE_KINDS),
  inputs: z.array(z.string()),
  outputs: z.array(z.string()),
  tool: nullable(z.string()),
  schedule: nullable(z.string()),
  description: nullable(z.string()),
  owner: nullable(z.string()),
  anonymizes: nullable(z.boolean()),
  mappings: nullable(z.array(generatedMapping)),
});

const generatedRelation = z.object({
  id: z.string(),
  sourceId: z.string(),
  targetId: z.string(),
  cardinality: z.enum(CARDINALITIES),
  description: nullable(z.string()),
  sourceMin: nullable(participationSchema),
  targetMin: nullable(participationSchema),
});

export const generatedDataSchema = z.object({
  workspace: z.object({ name: z.string(), description: nullable(z.string()) }),
  domains: z.array(generatedDomain),
  assets: z.array(generatedAsset),
  pipelines: z.array(generatedPipeline),
  relations: z.array(generatedRelation),
  terms: z.array(generatedTerm),
});

export type GeneratedData = z.infer<typeof generatedDataSchema>;

/** Quita los `null` que exige la salida estructurada: el documento usa campos ausentes. */
function dropNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map(dropNulls) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => [k, dropNulls(v)])) as T;
  }
  return value;
}

export function generatedToData(generated: GeneratedData): { ok: true; document: DataDocument } | { ok: false; issues: string } {
  // Sin términos (o sin el campo, en una salida anterior al glosario), el documento no los declara (el campo es opcional).
  const { terms = [], ...rest } = dropNulls(generated);
  const result = validateDataDocument({ version: DATA_DOCUMENT_VERSION, ...rest, ...(terms.length > 0 ? { terms } : {}) });
  return result.ok ? result : { ok: false, issues: formatDataIssues(result.issues) };
}

export function generationJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(generatedDataSchema, { target: 'draft-2020-12' }) as Record<string, unknown>;
}

export function systemPrompt(): string {
  return `Eres un arquitecto de datos experto en plataformas de datos, modelado de datos, linaje y gobierno del dato.
Tu tarea es convertir una descripción en lenguaje natural en un modelo de arquitectura de datos estructurado en JSON.
NO produces coordenadas: el diagramador coloca los elementos después. Concéntrate en el modelo.

Activos (kind):
- "source": sistema origen de los datos (aplicación, SaaS, API externa). "external" = true si es de terceros.
- "database": base de datos operacional. "warehouse": almacén de datos analítico. "lake": data lake o lakehouse.
- "stream": tópico o flujo de eventos.
- "table", "view", "file": conjuntos de datos concretos. Su parentId es el id de la base, almacén o lago que los contiene
  (una "table" también puede estar en una "source"; un "file", en un "lake" o una "source"; una "view", en database,
  warehouse o lake). Los demás tipos dejan parentId en null.
- "report": informe o cuadro de mando. "model": modelo de aprendizaje automático o modelo semántico.
- "data-product": producto de datos (data mesh): agrupa y ofrece datos como un servicio con dueño. Sus puertos son
  activos ya declarados: "inputPorts" (lo que consume: fuentes, tablas, otros productos) y "outputPorts" (lo que publica:
  tablas, vistas, archivos, informes, APIs). Un activo no es entrada y salida del mismo producto. "owner" es su dueño;
  "freshness" la frescura o antigüedad máxima de sus datos ("24 h", "15 min") y "sla" el nivel de servicio comprometido.
- "data-api": API de datos. "exposes" lista los activos que sirve (tablas, vistas, productos…); "protocol" es "rest",
  "graphql", "grpc", "odata", "sql" o "events"; "endpoint", la dirección del servicio si se conoce.
- "glossary": glosario de negocio. No participa en pipelines ni relaciones: sus términos van en "terms".
- Los puertos, "exposes", "freshness", "sla", "protocol" y "endpoint" solo aplican a "data-product" (puertos, frescura,
  SLA) y "data-api" (exposes, protocol, endpoint); en el resto de activos déjalos en null.
- Ids únicos en kebab-case ASCII. owner = responsable del dato y steward = custodio, solo si se mencionan.
- Agrupa por dominios ("domains", p. ej. Ventas, Clientes) cuando la descripción hable de áreas de negocio y asigna
  domainId a los activos de nivel superior.

Motor (engine, solo si la descripción nombra la tecnología): en la base, almacén, lago, fuente o stream, uno de ${BUILTIN_ENGINE_IDS.map((id) => `"${id}"`).join(', ')}; las tablas lo heredan de su contenedor, así que no se repite en ellas. Usa
para cada columna un tipo que ese motor tenga (en PostgreSQL "varchar", "uuid"; en Snowflake "varchar", "number"; en MongoDB "string", "objectId").

Gobierno: classification ("public", "internal", "confidential", "restricted") según la sensibilidad indicada. Marca
pii = true (a nivel de activo o de columna) cuando haya datos personales; un activo con datos personales es como mínimo
"confidential". Añade retention si se menciona un plazo de conservación.

Glosario ("terms"): cada término de negocio tiene id único en kebab-case (distinto del de cualquier activo), name, definition (una frase), owner (quien responde
por la definición), status ("draft", "approved" o "deprecated"), glossaryId (id de un activo "glossary") y synonyms. "links"
enlaza el término con los activos (assetId) y, si procede, la columna (column; null = todo el activo) donde se materializa:
usa columnas que existan en "columns" de ese activo. Un término sin enlaces es un término sin implementar: enlázalo siempre que
la descripción diga dónde vive. Si no hay glosario, deja "terms" vacío.

Pipelines (linaje): cada pipeline lee uno o más activos (inputs) y escribe uno o más (outputs), nunca el mismo en ambos.
- kind: "batch" (ETL por lotes), "elt", "cdc" (captura de cambios), "streaming", "replication", "api" (extracción por
  API) o "manual". tool: la herramienta (Airflow, dbt, Debezium…). schedule: la frecuencia si se conoce.
- Una capa que deriva de otra (bronce → plata → oro) son pipelines encadenados. Un informe o modelo debe tener un
  pipeline que lo escriba. Si un pipeline anonimiza o enmascara datos personales, anonymizes = true.
- Linaje de columnas (opcional, solo si la descripción dice de qué columna sale cada una): "mappings" lista, por pipeline,
  {from: {assetId, column}, to: {assetId, column}, transform}. from.assetId debe ser una de las entradas del pipeline y
  to.assetId una de sus salidas; las columnas deben existir en "columns" de esos activos (un informe o modelo sin columnas
  admite cualquier nombre de indicador). transform describe el cálculo ("copia", "suma por mes", "sha256"); null si no se sabe.
  Si no hay detalle de columnas, deja mappings en null.

Modelo entidad-relación: si la descripción detalla entidades, dales columns (name, type, keys "pk"/"fk"/"uk") y une las
tablas con "relations": cardinality "1:N" significa que una fila del origen se relaciona con varias del destino. Las
relaciones solo unen tablas, vistas, archivos o streams y nunca un activo consigo mismo. Opcionalidad (solo si se
menciona): sourceMin / targetMin = 0 (opcional) o 1 (obligatorio) en cada extremo; por defecto el extremo de "uno" es
obligatorio (1) y el de "varios" opcional (0..*), de modo que "1:N" es 1 en el origen y 0..* en el destino; con
targetMin = 1 es 1..* y con sourceMin = 0 es 0..1. Si no se dice nada, deja ambos en null.

Responde en el idioma de la instrucción del usuario (nombres, descripciones). Sé concreto y no inventes activos que la
descripción no justifique.`;
}

export function toGenerated(doc: DataDocument): GeneratedData {
  const n = <T,>(v: T | undefined): T | null => v ?? null;
  return {
    workspace: { name: doc.workspace.name, description: n(doc.workspace.description) },
    domains: doc.domains.map((d) => ({ id: d.id, name: d.name, description: n(d.description), owner: n(d.owner) })),
    assets: doc.assets.map((a) => ({
      id: a.id,
      kind: a.kind,
      name: a.name,
      description: n(a.description),
      technology: n(a.technology),
      engine: n(a.engine),
      owner: n(a.owner),
      steward: n(a.steward),
      domainId: n(a.domainId),
      parentId: n(a.parentId),
      classification: n(a.classification),
      pii: n(a.pii),
      retention: n(a.retention),
      external: n(a.external),
      columns: a.columns ? a.columns.map((c) => ({ name: c.name, type: n(c.type), keys: n(c.keys), nullable: n(c.nullable), pii: n(c.pii), description: n(c.description) })) : null,
      inputPorts: n(a.inputPorts),
      outputPorts: n(a.outputPorts),
      exposes: n(a.exposes),
      freshness: n(a.freshness),
      sla: n(a.sla),
      protocol: n(a.protocol),
      endpoint: n(a.endpoint),
    })),
    pipelines: doc.pipelines.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      inputs: p.inputs,
      outputs: p.outputs,
      tool: n(p.tool),
      schedule: n(p.schedule),
      description: n(p.description),
      owner: n(p.owner),
      anonymizes: n(p.anonymizes),
      mappings: p.mappings ? p.mappings.map((m) => ({ from: { ...m.from }, to: { ...m.to }, transform: n(m.transform) })) : null,
    })),
    relations: doc.relations.map((r) => ({ id: r.id, sourceId: r.sourceId, targetId: r.targetId, cardinality: r.cardinality, description: n(r.description), sourceMin: n(r.sourceMin), targetMin: n(r.targetMin) })),
    terms: (doc.terms ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      definition: n(t.definition),
      owner: n(t.owner),
      status: n(t.status),
      glossaryId: n(t.glossaryId),
      synonyms: n(t.synonyms),
      links: t.links ? t.links.map((l) => ({ assetId: l.assetId, column: n(l.column) })) : null,
    })),
  };
}

export const dataAiSpec: AiSpec<DataDocument> = {
  generationSchema: generatedDataSchema,
  generationJsonSchema,
  system: systemPrompt,
  user(instruction, base) {
    if (!base) return `Genera el modelo de arquitectura de datos para la siguiente descripción:\n\n${instruction}`;
    return (
      `Este es el modelo de datos actual en JSON:\n\n${JSON.stringify(toGenerated(base), null, 2)}\n\n` +
      `Aplica la siguiente instrucción de refinamiento y devuelve el modelo COMPLETO actualizado. Conserva los ids ` +
      `existentes de lo que no cambia y solo añade, modifica o elimina lo que la instrucción requiera:\n\n${instruction}`
    );
  },
  retry: (issues) => `El modelo devuelto no pasó la validación. Corrige estos problemas y devuelve el modelo completo de nuevo:\n${issues}`,
  toDocument: (generated) => generatedToData(generated as GeneratedData),
  // Para `iark explain` y `iark review`: la proyección compacta del documento y qué destacar y qué mirar en este módulo.
  serialize: toGenerated,
  explainGuide:
    'Cuenta de dónde nacen los datos (fuentes), por qué pipelines pasan y dónde terminan (almacenes, informes, modelos, APIs); explica las tablas y sus relaciones si hay modelo entidad-relación; di quién es dueño de cada activo y su clasificación o si contiene datos personales, y las definiciones del glosario si las hay.',
  reviewGuide:
    'Mira: activos sin dueño o sin custodio; datos personales (pii) o clasificación confidencial sin control visible en el destino; informes o modelos sin un pipeline que los alimente; pipelines con entradas o salidas que no existen en el linaje; tablas sin clave primaria o relaciones sin cardinalidad; la misma información duplicada en varios activos sin una fuente de verdad; productos de datos sin frescura ni SLA; APIs de datos que exponen activos sensibles; términos del glosario sin definición, sin responsable o sin enlazar a ningún activo.',
};
