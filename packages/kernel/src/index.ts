export * from './module/types';
export * from './module/editor';
export { ModuleRegistry, UnknownModuleError } from './module/registry';
export * from './module/operations';
export * from './module/link-types';
export * from './module/contract';
export * from './module/plugin';
export * from './module/migrate';
export * from './module/protocol';
export { compareMajorMinor, parseMajorMinor, type MajorMinor } from './module/version';
export * from './module/trace';
export * from './module/trace-analysis';
export * from './module/trace-svg';
export { carryRefs } from './module/refs';
export { ModuleError } from './module/errors';
export { formatUrn, parseUrn, type ParsedUrn } from './module/urn';
export {
  embedUrlFromManifest,
  ENDPOINT_PROTOCOLS,
  EndpointUrlError,
  MANIFEST_SCHEMA_VERSION,
  manifestCompatibilityProblem,
  manifestSchemaVersion,
  moduleCompatibilityProblem,
  resolveEndpointUrl,
} from './module/endpoint';
export {
  buildManifest,
  manifestSchema,
  moduleManifestSchema,
  MANIFEST_SCHEMA_ID,
  PROJECTS_AUTH,
  type ManifestOptions,
  type ModuleManifest,
  type ProjectsAuth,
  type SuiteManifest,
} from './module/manifest';

export { extractJson } from './util/extractJson';
export { MAX_ID_LENGTH, pickId } from './import/ids';
export { Warnings } from './import/warnings';
export { standalonePrompt as moduleStandalonePrompt } from './ai/standalone';
export { generateStructured, GenerationError, type Effort, type StructuredOptions, type StructuredResult } from './ai/structured';
export { createAiClient, credentialsHint, openaiSettings, resolveModel, resolveProvider, type AiProvider, type Env } from './ai/client';
export {
  chatCompletion,
  HttpError,
  initialCompatState,
  stripReasoning,
  type ChatCompletionOptions,
  type ChatCompletionResult,
  type ChatMessage,
  type CompatState,
  type ResponseFormatMode,
} from './ai/openaiCompat';

export * from './mermaid';
export * from './graph';

// Versionado: comparar dos versiones de un documento de cualquier módulo.
export * from './diff';

// Proyectos: guardar los diagramas agrupados, en un archivo único y con referencias entre ellos.
export * from './project';
