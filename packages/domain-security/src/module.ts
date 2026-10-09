import type { DomainModule, EntityRef, Exporter, Importer, ModuleIssue, ViewRef } from '@iark/kernel';
import { CONTRACT_VERSION, looksLikeMermaid } from '@iark/kernel';
import { securityAiSpec } from './ai/generation';
import { securityCommands } from './commands';
import { securityEditor } from './editor';
import { toDrawio } from './export/drawio';
import { toMermaid } from './export/mermaid';
import { toSvg } from './export/render';
import { fromMermaid } from './import/fromMermaid';
import { analyzeSecurity } from './issues';
import { securityDocumentSchema, securityJsonSchema } from './schema';
import { SECURITY_DOCUMENT_VERSION, type SecurityDocument } from './types';
import { viewRefs } from './views';

const mermaidImporter: Importer<SecurityDocument> = {
  id: 'mermaid',
  label: 'Mermaid',
  extensions: ['.mmd', '.mermaid', '.md'],
  detect: looksLikeMermaid,
  import: (text, ctx) => fromMermaid(text, { name: ctx.name, fallbackName: ctx.fallbackName }),
};

const mermaidExporter: Exporter<SecurityDocument> = {
  id: 'mermaid',
  label: 'Mermaid',
  extension: '.mmd',
  mime: 'text/plain',
  export: (doc, ctx) => toMermaid(doc, { viewId: ctx.viewId }),
};

const svgExporter: Exporter<SecurityDocument> = {
  id: 'svg',
  label: 'SVG',
  extension: '.svg',
  mime: 'image/svg+xml',
  export: (doc, ctx) => toSvg(doc, ctx.viewId),
};

const drawioExporter: Exporter<SecurityDocument> = {
  id: 'drawio',
  label: 'draw.io',
  extension: '.drawio',
  mime: 'application/xml',
  export: (doc) => toDrawio(doc),
};

/**
 * Módulo de arquitectura de seguridad: zonas de confianza anidadas, activos (actores, sistemas externos, procesos y almacenes
 * de datos), flujos de datos que cruzan fronteras, amenazas clasificadas con STRIDE y los controles que las mitigan. Ofrece
 * el diagrama de flujo de datos con sus fronteras, el modelo de amenazas, el alcance de un activo comprometido, el registro
 * de riesgos, la cobertura STRIDE y la superficie de ataque. Sus activos pueden apuntar a elementos de otros módulos por URN
 * (`ref`), p. ej. un servicio de la plataforma o un sistema del mapa de integración.
 */
export const securityModule: DomainModule<SecurityDocument> = {
  id: 'security',
  name: 'Arquitectura de seguridad',
  version: '0.1.0',
  description: 'Zonas de confianza, activos, flujos de datos, amenazas STRIDE y controles, con diagrama de flujo de datos, modelo de amenazas, riesgos y superficie de ataque; exporta a Mermaid, SVG y draw.io.',
  contractVersion: CONTRACT_VERSION,
  documentVersion: SECURITY_DOCUMENT_VERSION,
  schema: securityDocumentSchema as unknown as DomainModule<SecurityDocument>['schema'],
  jsonSchema: securityJsonSchema,
  validate: (doc): ModuleIssue[] => analyzeSecurity(doc),
  importers: [mermaidImporter],
  exporters: [mermaidExporter, svgExporter, drawioExporter],
  ai: securityAiSpec,
  entities: (doc): EntityRef[] => [
    ...doc.zones.map((z) => ({ id: z.id, name: z.name, kind: 'zone' })),
    ...doc.assets.map((a) => ({ id: a.id, name: a.name, kind: 'asset' })),
    ...doc.threats.map((t) => ({ id: t.id, name: t.title, kind: 'threat' })),
    ...doc.controls.map((c) => ({ id: c.id, name: c.name, kind: 'control' })),
  ],
  views: (doc): ViewRef[] => viewRefs(doc),
  traceViews: [
    { prefix: 'blast', label: 'Alcance si se compromete', applies: (e) => e.kind === 'asset' },
    { prefix: 'exposure', label: 'Quién llega hasta él', applies: (e) => e.kind === 'asset' },
    { prefix: 'focus', label: 'Contexto', applies: (e) => e.kind === 'asset' },
  ],
  cliCommands: securityCommands,
  editor: securityEditor,
};
