/**
 * API pública del núcleo (sin DOM): válida en navegador y Node.
 *
 *   import { generateDocument, autoLayoutDocument, toDrawio, validateDocument } from 'iark-diagrams/core';
 */
export * from './model/types';
export {
  documentSchema,
  elementSchema,
  relationshipSchema,
  viewSchema,
  validateDocument,
  parseDocument,
  formatIssues,
  documentJsonSchema,
  DocumentValidationError,
  type ValidationIssue,
  type ValidationResult,
} from './model/schema';
export { C4_MIGRATIONS } from './model/migrations';
export * from './model/factories';
export { sampleDocument } from './model/sample';
export { deriveView, viewBounds, type DerivedView, type DerivedNode, type DerivedBoundary, type DerivedEdge } from './model/viewDerivation';
export {
  layoutView,
  layoutDerivedView,
  autoLayoutView,
  autoLayoutDocument,
  autoLayoutDocumentWithQuality,
  applyLayoutToView,
  resolveLayoutParams,
  runElkLayout,
  measureDerived,
  type LayoutOptions,
  type LayoutResult,
  type LayoutVariant,
  type PositionedElement,
} from './layout/elkLayout';
export { smartLayout, buildCandidates, runCandidate, BASE_VARIANTS, RESCUE_VARIANTS, type LayoutCandidate } from './layout/smartLayout';
export { distributeCentered, type DistributeParams, type DistributedLayout } from './layout/distribute';
export { routeEdges, type RouterInput } from './layout/router';
export { preferredDirectionFor, boundariesFromPositions, type ResolvedLayoutParams } from './layout/elkLayout';
export { measureLayout, formatQuality, scoreQuality, type LayoutQuality } from './layout/quality';
export { computeEdgeAnchors, routeEdge, labelPosition, pathFromPoints, chooseSide, type Rect, type Anchor, type EdgeAnchors, type Side, type Point } from './layout/edgeAnchors';
export { estimateLabelSize, type LabelSize } from './layout/labelMetrics';
export { toDrawio, DrawioExportError, type DrawioOptions, type DrawioNotation } from './export/drawio/toDrawio';
export { toSvg, SvgExportError, type SvgOptions } from './export/svg/toSvg';
export type { DrawioLocale } from './export/drawio/styles';
export { fromDrawio, DrawioImportError, type DrawioImportOptions, type DrawioImportResult } from './import/drawio/fromDrawio';
export { fromStructurizrDsl, DslImportError, type DslImportOptions, type DslImportResult, type IncludeResolver } from './import/structurizr/fromStructurizrDsl';
export { toMermaid, MermaidExportError, type MermaidOptions, type MermaidFormat } from './export/mermaid/toMermaid';
export { fromMermaid, looksLikeMermaid, MermaidImportError, MERMAID_DIAGRAM_KINDS, type MermaidImportOptions, type MermaidImportResult } from './import/mermaid/fromMermaid';
export {
  generatedDocumentSchema,
  generatedToDocument,
  documentToGenerated,
  generationJsonSchema,
  type GeneratedDocument,
} from './ai/generationSchema';
export { systemPrompt, userPrompt, standalonePrompt } from './ai/prompt';
export { createAiClient, resolveModel, resolveProvider, extractJson, type AiProvider } from '@iark/kernel';
export { generateDocument, GenerationError, DEFAULT_AI_MODEL, type GenerateOptions, type GenerateResult, type Effort } from './ai/generate';
export { analyzeDocument, type DocumentIssue } from './model/issues';
export { c4Module } from './module';
export { c4Editor } from './editor';
