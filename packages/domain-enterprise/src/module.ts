import type { DomainModule, EntityRef, Exporter, Importer, ModuleIssue, ViewRef } from '@iark/kernel';
import { CONTRACT_VERSION, looksLikeMermaid } from '@iark/kernel';
import { enterpriseAiSpec } from './ai/generation';
import { enterpriseCommands } from './commands';
import { enterpriseEditor } from './editor';
import { toDrawio } from './export/drawio';
import { toMermaid } from './export/mermaid';
import { toSvg } from './export/render';
import { fromArchimate, looksLikeArchimate } from './import/fromArchimate';
import { fromMermaid, looksLikeMatrixBlock } from './import/fromMermaid';
import { analyzeEnterprise } from './issues';
import { enterpriseDocumentSchema, enterpriseJsonSchema } from './schema';
import { ENTERPRISE_DOCUMENT_VERSION, type EnterpriseDocument } from './types';
import { viewRefs } from './views';

/** Mermaid: un `flowchart` o el `block-beta` de la matriz capacidad × aplicación (que `looksLikeMermaid`, común a la suite, no conoce). */
const mermaidImporter: Importer<EnterpriseDocument> = {
  id: 'mermaid',
  label: 'Mermaid',
  extensions: ['.mmd', '.mermaid', '.md'],
  detect: (text) => looksLikeMermaid(text) || looksLikeMatrixBlock(text),
  import: (text, ctx) => fromMermaid(text, { name: ctx.name, fallbackName: ctx.fallbackName }),
};

/** Modelo de ArchiMate: el formato de intercambio del Open Group (`.xml`) o el nativo de Archi (`.archimate`). */
const archimateImporter: Importer<EnterpriseDocument> = {
  id: 'archimate',
  label: 'ArchiMate',
  extensions: ['.xml', '.archimate'],
  detect: looksLikeArchimate,
  import: (text, ctx) => fromArchimate(text, { name: ctx.name, fallbackName: ctx.fallbackName, lang: typeof ctx.extra?.lang === 'string' ? ctx.extra.lang : undefined }),
};

const mermaidExporter: Exporter<EnterpriseDocument> = {
  id: 'mermaid',
  label: 'Mermaid',
  extension: '.mmd',
  mime: 'text/plain',
  export: (doc, ctx) => toMermaid(doc, { viewId: ctx.viewId }),
};

const svgExporter: Exporter<EnterpriseDocument> = {
  id: 'svg',
  label: 'SVG',
  extension: '.svg',
  mime: 'image/svg+xml',
  export: (doc, ctx) => toSvg(doc, ctx.viewId),
};

const drawioExporter: Exporter<EnterpriseDocument> = {
  id: 'drawio',
  label: 'draw.io',
  extension: '.drawio',
  mime: 'application/xml',
  export: (doc) => toDrawio(doc),
};

/**
 * Módulo de arquitectura empresarial (subconjunto de ArchiMate/TOGAF): unidades, capacidades de negocio, procesos,
 * aplicaciones y tecnología, con su ciclo de vida. Ofrece el mapa de capacidades, el paisaje capacidad → aplicación →
 * tecnología y el análisis de impacto y obsolescencia. Sus aplicaciones y tecnologías pueden apuntar a elementos de otros
 * módulos por URN (`ref`), p. ej. un sistema del mapa de integración.
 */
export const enterpriseModule: DomainModule<EnterpriseDocument> = {
  id: 'enterprise',
  name: 'Arquitectura empresarial',
  version: '0.1.0',
  description: 'Mapa de capacidades, aplicaciones y tecnología con ciclo de vida, impacto y obsolescencia; exporta a Mermaid, SVG y draw.io.',
  contractVersion: CONTRACT_VERSION,
  documentVersion: ENTERPRISE_DOCUMENT_VERSION,
  schema: enterpriseDocumentSchema as unknown as DomainModule<EnterpriseDocument>['schema'],
  jsonSchema: enterpriseJsonSchema,
  validate: (doc): ModuleIssue[] => analyzeEnterprise(doc),
  importers: [mermaidImporter, archimateImporter],
  exporters: [mermaidExporter, svgExporter, drawioExporter],
  ai: enterpriseAiSpec,
  entities: (doc): EntityRef[] => [
    ...doc.units.map((u) => ({ id: u.id, name: u.name, kind: 'unit' })),
    ...doc.capabilities.map((c) => ({ id: c.id, name: c.name, kind: 'capability' })),
    ...doc.processes.map((p) => ({ id: p.id, name: p.name, kind: 'process' })),
    ...doc.applications.map((a) => ({ id: a.id, name: a.name, kind: 'application' })),
    ...doc.technologies.map((t) => ({ id: t.id, name: t.name, kind: 'technology' })),
    ...doc.valueStreams.map((v) => ({ id: v.id, name: v.name, kind: 'stream' })),
    ...doc.valueStages.map((v) => ({ id: v.id, name: v.name, kind: 'stage' })),
    ...doc.businessServices.map((b) => ({ id: b.id, name: b.name, kind: 'service' })),
  ],
  views: (doc): ViewRef[] => viewRefs(doc),
  traceViews: [
    { prefix: 'impact', label: 'Impacto', applies: (e) => e.kind !== 'unit' && e.kind !== 'stream' },
    { prefix: 'depends', label: 'Dependencias', applies: (e) => e.kind !== 'unit' && e.kind !== 'stream' },
    { prefix: 'focus', label: 'Entorno', applies: (e) => e.kind !== 'unit' && e.kind !== 'stream' },
  ],
  cliCommands: enterpriseCommands,
  // Comparar versiones: las etapas de un flujo de valor se dibujan en el orden de la lista, así que su orden es contenido.
  diff: { ordered: ['valueStages'] },
  editor: enterpriseEditor,
};
