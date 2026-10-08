import { CONTRACT_VERSION, type DomainModule, type EntityRef, type Exporter, type Importer, type ModuleIssue, type ViewRef } from '@iark/kernel';
import { toSvg } from './export/svg/toSvg';
import { c4AiSpec } from './ai/spec';
import { toDrawio, type DrawioNotation } from './export/drawio/toDrawio';
import type { DrawioLocale } from './export/drawio/styles';
import { toMermaid, type MermaidFormat } from './export/mermaid/toMermaid';
import { fromDrawio } from './import/drawio/fromDrawio';
import { fromMermaid, looksLikeMermaid } from './import/mermaid/fromMermaid';
import { fromStructurizrDsl } from './import/structurizr/fromStructurizrDsl';
import { autoLayoutDocument } from './layout/elkLayout';
import { analyzeDocument } from './model/issues';
import { C4_MIGRATIONS } from './model/migrations';
import { documentJsonSchema, documentSchema } from './model/schema';
import { DOCUMENT_VERSION, type C4Document } from './model/types';

const drawioImporter: Importer<C4Document> = {
  id: 'drawio',
  label: 'draw.io',
  extensions: ['.drawio', '.xml'],
  detect: (text) => text.replace(/^﻿/, '').trimStart().startsWith('<'),
  import: (text, ctx) => fromDrawio(text, { name: ctx.name ?? ctx.fallbackName }),
};

const mermaidImporter: Importer<C4Document> = {
  id: 'mermaid',
  label: 'Mermaid',
  extensions: ['.mmd', '.mermaid', '.md'],
  detect: looksLikeMermaid,
  import: (text, ctx) => fromMermaid(text, { name: ctx.name, fallbackName: ctx.fallbackName }),
};

const dslImporter: Importer<C4Document> = {
  id: 'dsl',
  label: 'Structurizr DSL',
  extensions: ['.dsl'],
  detect: (text) => /\bworkspace\b/.test(text.replace(/^﻿/, '').trimStart()),
  import: (text, ctx) => fromStructurizrDsl(text, { name: ctx.name, fallbackName: ctx.fallbackName, ...(ctx.extra ?? {}) }),
};

const drawioExporter: Exporter<C4Document> = {
  id: 'drawio',
  label: 'draw.io',
  extension: '.drawio',
  mime: 'application/xml',
  async export(document, ctx) {
    const options = (ctx.options ?? {}) as { notation?: DrawioNotation; locale?: DrawioLocale; waypoints?: boolean };
    // toDrawio necesita coordenadas: las vistas sin ellas se colocan con el autolayout.
    const laid = await autoLayoutDocument(document, {});
    return toDrawio(laid, { ...options, viewIds: ctx.viewId ? [ctx.viewId] : undefined });
  },
};

const svgExporter: Exporter<C4Document> = {
  id: 'svg',
  label: 'SVG',
  extension: '.svg',
  mime: 'image/svg+xml',
  export: async (doc, ctx) => toSvg(await autoLayoutDocument(doc), { viewId: ctx.viewId }),
};

const mermaidExporter: Exporter<C4Document> = {
  id: 'mermaid',
  label: 'Mermaid',
  extension: '.mmd',
  mime: 'text/plain',
  export: (document, ctx) => toMermaid(document, { viewId: ctx.viewId, format: (ctx.options?.format as MermaidFormat | undefined) ?? 'c4' }),
};

/**
 * Módulo de arquitectura de soluciones: el modelo C4 (personas, sistemas, contenedores y componentes con sus vistas
 * de contexto, contenedores y componentes). Es la especialidad que ya trae la suite; las demás siguen este mismo contrato.
 */
export const c4Module: DomainModule<C4Document> = {
  id: 'c4',
  name: 'Arquitectura de soluciones (C4)',
  version: '1.0.0',
  description: 'Modelo C4: contexto, contenedores y componentes con autolayout, importación desde draw.io, Structurizr y Mermaid, y generación con IA.',
  contractVersion: CONTRACT_VERSION,
  documentVersion: DOCUMENT_VERSION,
  migrations: C4_MIGRATIONS,
  schema: documentSchema as unknown as DomainModule<C4Document>['schema'],
  jsonSchema: documentJsonSchema,
  validate(document): ModuleIssue[] {
    return analyzeDocument(document).map((issue) => ({ severity: issue.severity, message: issue.message, elementId: issue.elementId }));
  },
  // El orden es el de la detección por contenido: draw.io (XML), Mermaid (cabecera reconocible) y por último el DSL.
  importers: [drawioImporter, mermaidImporter, dslImporter],
  exporters: [drawioExporter, svgExporter, mermaidExporter],
  ai: c4AiSpec,
  entities: (document): EntityRef[] => document.model.elements.map((e) => ({ id: e.id, name: e.name, kind: e.type })),
  views: (document): ViewRef[] => document.views.map((v) => ({ id: v.id, title: v.title ?? v.id })),
  // Comparar versiones: lo que guarda el autolayout (posiciones, tamaños, rutas de aristas y opciones de layout de cada vista) no es
  // contenido. Qué elementos muestra cada vista (`views.elements`, por id) sí lo es.
  diff: { ignore: ['views.elements.x', 'views.elements.y', 'views.elements.width', 'views.elements.height', 'views.edges', 'views.layout'] },
};
