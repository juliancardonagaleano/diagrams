import type { DomainModule, EntityRef, Exporter, Importer, ModuleIssue, ViewRef } from '@iark/kernel';
import { CONTRACT_VERSION, looksLikeMermaid } from '@iark/kernel';
import { integrationAiSpec } from './ai/generation';
import { integrationCommands } from './commands';
import { integrationEditor } from './editor';
import { toDrawio } from './export/drawio';
import { toMermaid, type IntegrationMermaidFormat } from './export/mermaid';
import { toSvg } from './export/render';
import { fromAsyncApi, looksLikeAsyncApi } from './import/fromAsyncApi';
import { fromMermaid } from './import/fromMermaid';
import { fromOpenApi, looksLikeOpenApi } from './import/fromOpenApi';
import { analyzeIntegration } from './issues';
import { integrationDocumentSchema, integrationJsonSchema } from './schema';
import { INTEGRATION_DOCUMENT_VERSION, type IntegrationDocument } from './types';
import { listViews } from './views';

const mermaidImporter: Importer<IntegrationDocument> = {
  id: 'mermaid',
  label: 'Mermaid',
  extensions: ['.mmd', '.mermaid', '.md'],
  detect: looksLikeMermaid,
  import: (text, ctx) => fromMermaid(text, { name: ctx.name, fallbackName: ctx.fallbackName }),
};

/** OpenAPI 3.x (y Swagger 2.0), en JSON o YAML. Comparte extensiones con AsyncAPI: el contenido decide cuál es. */
const openApiImporter: Importer<IntegrationDocument> = {
  id: 'openapi',
  label: 'OpenAPI (REST)',
  extensions: ['.json', '.yaml', '.yml'],
  detect: looksLikeOpenApi,
  import: (text, ctx) => fromOpenApi(text, { name: ctx.name, fallbackName: ctx.fallbackName }),
};

/** AsyncAPI 2.x y 3.x, en JSON o YAML. */
const asyncApiImporter: Importer<IntegrationDocument> = {
  id: 'asyncapi',
  label: 'AsyncAPI (eventos)',
  extensions: ['.json', '.yaml', '.yml'],
  detect: looksLikeAsyncApi,
  import: (text, ctx) => fromAsyncApi(text, { name: ctx.name, fallbackName: ctx.fallbackName }),
};

const mermaidExporter: Exporter<IntegrationDocument> = {
  id: 'mermaid',
  label: 'Mermaid',
  extension: '.mmd',
  mime: 'text/plain',
  export: (doc, ctx) => toMermaid(doc, { viewId: ctx.viewId, format: ctx.options?.format as IntegrationMermaidFormat | undefined }),
};

const svgExporter: Exporter<IntegrationDocument> = {
  id: 'svg',
  label: 'SVG',
  extension: '.svg',
  mime: 'image/svg+xml',
  export: (doc, ctx) => toSvg(doc, ctx.viewId),
};

const drawioExporter: Exporter<IntegrationDocument> = {
  id: 'drawio',
  label: 'draw.io',
  extension: '.drawio',
  mime: 'application/xml',
  export: (doc) => toDrawio(doc),
};

/**
 * Módulo de arquitectura de integraciones: sistemas, APIs, servidores MCP, pasarelas, brokers, colas y tópicos, conectores,
 * tareas programadas y usuarios, con las interacciones entre ellos (estilo, protocolo, patrón EIP, contrato, orden) y los
 * flujos que las recorren. Los contratos (OpenAPI, .proto, CloudEvents, MCP) son la metadata de las figuras y se editan
 * dentro. Sus nodos pueden apuntar a elementos de otros módulos por URN (`ref`), p. ej. un contenedor del modelo C4.
 */
export const integrationModule: DomainModule<IntegrationDocument> = {
  id: 'integration',
  name: 'Arquitectura de integraciones',
  version: '0.1.0',
  description: 'Mapa de integración y flujos con notación EIP: sistemas, APIs, MCP, brokers, colas, contratos editables (OpenAPI, .proto, CloudEvents, MCP) y patrones; importa de Mermaid, OpenAPI y AsyncAPI y exporta a Mermaid, SVG y draw.io.',
  contractVersion: CONTRACT_VERSION,
  documentVersion: INTEGRATION_DOCUMENT_VERSION,
  schema: integrationDocumentSchema as unknown as DomainModule<IntegrationDocument>['schema'],
  jsonSchema: integrationJsonSchema,
  validate: (doc): ModuleIssue[] => analyzeIntegration(doc),
  importers: [mermaidImporter, openApiImporter, asyncApiImporter],
  exporters: [mermaidExporter, svgExporter, drawioExporter],
  ai: integrationAiSpec,
  entities: (doc): EntityRef[] => doc.nodes.map((n) => ({ id: n.id, name: n.name, kind: n.kind })),
  views: (doc): ViewRef[] => listViews(doc).map((v) => ({ id: v.id, title: v.title })),
  cliCommands: integrationCommands,
  // Comparar versiones: los pasos de un flujo son una secuencia, así que su orden es contenido.
  diff: { ordered: ['flows.steps'] },
  editor: integrationEditor,
};
