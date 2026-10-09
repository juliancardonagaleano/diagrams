import type { DomainModule, EntityRef, Exporter, Importer, ModuleIssue, ViewRef } from '@iark/kernel';
import { CONTRACT_VERSION, looksLikeMermaid } from '@iark/kernel';
import { dataAiSpec } from './ai/generation';
import { dataCommands } from './commands';
import { toDdl } from './ddl';
import { toDrawio } from './export/drawio';
import { toMermaid } from './export/mermaid';
import { toSvg } from './export/render';
import { fromDbt, looksLikeDbtManifest } from './import/fromDbt';
import { fromDdl, looksLikeDdl } from './import/fromDdl';
import { fromMermaid } from './import/fromMermaid';
import { fromOpenLineage, looksLikeOpenLineage } from './import/fromOpenLineage';
import { analyzeData } from './issues';
import { dataDocumentSchema, dataJsonSchema } from './schema';
import { DATA_DOCUMENT_VERSION, type DataDocument } from './types';
import { viewRefs } from './views';
import { dataEditor } from './editor';

const mermaidImporter: Importer<DataDocument> = {
  id: 'mermaid',
  label: 'Mermaid',
  extensions: ['.mmd', '.mermaid', '.md'],
  detect: looksLikeMermaid,
  import: (text, ctx) => fromMermaid(text, { name: ctx.name, fallbackName: ctx.fallbackName }),
};

const ddlImporter: Importer<DataDocument> = {
  id: 'ddl',
  label: 'SQL (DDL)',
  extensions: ['.sql', '.ddl'],
  detect: looksLikeDdl,
  import: (text, ctx) => fromDdl(text, { name: ctx.name, fallbackName: ctx.fallbackName }),
};

/** El `manifest.json` de dbt (`target/manifest.json`); cualquier otro JSON se rechaza con el motivo. */
const dbtImporter: Importer<DataDocument> = {
  id: 'dbt',
  label: 'dbt (manifest.json)',
  extensions: ['.json'],
  detect: looksLikeDbtManifest,
  import: (text, ctx) => fromDbt(text, { name: ctx.name, fallbackName: ctx.fallbackName }),
};

/** Eventos de OpenLineage (uno, una lista o NDJSON). Comparte `.json` con dbt: el contenido decide cuál es. */
const openLineageImporter: Importer<DataDocument> = {
  id: 'openlineage',
  label: 'OpenLineage (eventos)',
  extensions: ['.json', '.jsonl', '.ndjson'],
  detect: looksLikeOpenLineage,
  import: (text, ctx) => fromOpenLineage(text, { name: ctx.name, fallbackName: ctx.fallbackName }),
};

const mermaidExporter: Exporter<DataDocument> = {
  id: 'mermaid',
  label: 'Mermaid',
  extension: '.mmd',
  mime: 'text/plain',
  export: (doc, ctx) => toMermaid(doc, { viewId: ctx.viewId }),
};

const svgExporter: Exporter<DataDocument> = {
  id: 'svg',
  label: 'SVG',
  extension: '.svg',
  mime: 'image/svg+xml',
  export: (doc, ctx) => toSvg(doc, ctx.viewId),
};

const drawioExporter: Exporter<DataDocument> = {
  id: 'drawio',
  label: 'draw.io',
  extension: '.drawio',
  mime: 'application/xml',
  export: (doc) => toDrawio(doc),
};

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/** Esquema físico de las tablas, una sección por motor (`options.engine` fuerza uno; `options.schema` califica los nombres). */
const ddlExporter: Exporter<DataDocument> = {
  id: 'ddl',
  label: 'DDL (esquema por motor)',
  extension: '.sql',
  mime: 'text/plain',
  export: (doc, ctx) => toDdl(doc, { engine: text(ctx.options?.engine), schema: text(ctx.options?.schema) }).text,
};

/**
 * Módulo de arquitectura de datos: activos (fuentes, bases, almacenes, lagos, streams, tablas, informes, modelos)
 * agrupados en dominios, el linaje entre ellos por pipelines, el modelo entidad-relación y el gobierno del dato
 * (responsables, clasificación, datos personales, retención). El catálogo suma productos de datos (con puertos de
 * entrada y salida y su SLA), APIs de datos y glosarios de términos de negocio enlazados a columnas y activos. Sus
 * activos pueden apuntar a elementos de otros módulos por URN (`ref`), p. ej. un almacén del mapa de integración.
 */
export const dataModule: DomainModule<DataDocument> = {
  id: 'data',
  name: 'Arquitectura de datos',
  version: '0.1.0',
  description: 'Linaje, modelo entidad-relación (pata de gallo o UML), gobierno del dato y catálogo (productos de datos, APIs y glosario): dominios, pipelines, clasificación, datos personales y contratos por motor de base de datos; importa de Mermaid, DDL de SQL, dbt y OpenLineage y exporta a Mermaid, SVG, draw.io y DDL.',
  contractVersion: CONTRACT_VERSION,
  documentVersion: DATA_DOCUMENT_VERSION,
  schema: dataDocumentSchema as unknown as DomainModule<DataDocument>['schema'],
  jsonSchema: dataJsonSchema,
  validate: (doc): ModuleIssue[] => analyzeData(doc),
  importers: [mermaidImporter, ddlImporter, dbtImporter, openLineageImporter],
  exporters: [mermaidExporter, svgExporter, drawioExporter, ddlExporter],
  ai: dataAiSpec,
  entities: (doc): EntityRef[] => [
    ...doc.domains.map((d) => ({ id: d.id, name: d.name, kind: 'domain' })),
    ...doc.assets.map((a) => ({ id: a.id, name: a.name, kind: a.kind })),
    ...doc.pipelines.map((p) => ({ id: p.id, name: p.name, kind: 'pipeline' })),
    ...(doc.terms ?? []).map((t) => ({ id: t.id, name: t.name, kind: 'term' })),
  ],
  views: (doc): ViewRef[] => viewRefs(doc),
  traceViews: [
    { prefix: 'lineage', label: 'Linaje completo', applies: (e) => e.kind !== 'domain' && e.kind !== 'pipeline' && e.kind !== 'term' },
    { prefix: 'upstream', label: 'Origen (aguas arriba)', applies: (e) => e.kind !== 'domain' && e.kind !== 'pipeline' && e.kind !== 'term' },
    { prefix: 'downstream', label: 'Impacto (aguas abajo)', applies: (e) => e.kind !== 'domain' && e.kind !== 'pipeline' && e.kind !== 'term' },
  ],
  cliCommands: dataCommands,
  editor: dataEditor,
};
