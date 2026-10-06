export * from './types';
export { platformDocumentSchema, platformJsonSchema, validatePlatformDocument, formatPlatformIssues, type PlatformValidation } from './schema';
export { analyzePlatform } from './issues';
export { counterpartsOf, counterpartErrors, dropCounterparts, type Counterparts, type CounterpartError } from './counterparts';
export { dependencyGraph, reach, scoped, scopeEnvironment, deploymentEnvironments, callCycles, type DependencyGraph, type Reach, type ReachStep } from './graph';
export { listViews, findView, traceView, compareView, type PlatformView } from './views';
export {
  compareEnvironments,
  compareReport,
  resolveComparison,
  counterpart,
  summarize,
  compareMatrix,
  matrixReport,
  summarizeMatrix,
  resolveEnvironments,
  comparableEnvironments,
  isAllEnvironments,
  columnLetter,
  MATCH_NOTES,
  type MatchedBy,
  type DiffKind,
  type EnvironmentComparison,
  type EnvironmentMatrix,
  type ServiceDifference,
  type ServiceRow,
  type ServiceCell,
  type ResourceDifference,
  type ResourceRow,
  type ResourceCell,
  type Presence,
} from './compare';
export { toMermaid } from './export/mermaid';
export { toSvg, layoutView, buildScene, SERVICE_COLORS, RESOURCE_COLORS } from './export/render';
export { toDrawio } from './export/drawio';
export { fromMermaid, PlatformImportError, type PlatformImportOptions, type PlatformImportResult } from './import/fromMermaid';
export { fromIntegrationJson } from './import/fromIntegration';
export { platformAiSpec, generatedPlatformSchema, type GeneratedPlatform } from './ai/generation';
export { platformCommands } from './commands';
export { platformEditor, stagesToText, parseStages } from './editor';
export { platformModule } from './module';
export * from './icons';
export { iconIssues } from './icons/issues';
