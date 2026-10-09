export * from './module/types';
export * from './module/editor';
export { ModuleRegistry, UnknownModuleError } from './module/registry';
export * from './module/operations';
export * from './module/trace';
export * from './module/trace-svg';
export { carryRefs } from './module/refs';
export { ModuleError } from './module/errors';
export { formatUrn, parseUrn, type ParsedUrn } from './module/urn';
export { embedUrlFromManifest, ENDPOINT_PROTOCOLS, EndpointUrlError, resolveEndpointUrl } from './module/endpoint';
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
export {
  generateStructured,
  type AttemptOutcome,
  type AttemptRecord,
  type AttemptTrigger,
  type Effort,
  type StructuredOptions,
  type StructuredResult,
  type VerificationStatus,
} from './ai/structured';
export { BudgetExceededError, describeApiError, formatModuleIssues, GenerationError, InputTooLargeError, VerificationError, type SpentTokens } from './ai/errors';
export {
  CHARS_PER_TOKEN,
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  estimateTokens,
  formatTokens,
  MIN_OUTPUT_TOKENS,
  resolveTokenLimits,
  type TokenLimitOptions,
  type TokenLimits,
} from './ai/budget';
export { generateText, type TextOptions, type TextResult } from './ai/text';
export { explainPrompts, MAX_ISSUES_IN_PROMPT, reviewPrompts, serializeDocument, type CommentaryInput, type CommentaryKind, type CommentaryLang, type CommentaryModule, type CommentaryPrompts } from './ai/commentary';
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
