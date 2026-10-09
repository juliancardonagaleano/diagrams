import Anthropic from '@anthropic-ai/sdk';
import type { ModuleIssue } from '../module/types';
import { credentialsHint, type AiProvider } from './client';
import { HttpError } from './openaiCompat';

/** Tokens gastados hasta el momento del error (suma de todas las llamadas ya hechas). */
export interface SpentTokens {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export class GenerationError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'GenerationError';
  }
}

/** El tope total de tokens (`budgetTokens`) no alcanza para la siguiente llamada, o se agotó durante la respuesta. */
export class BudgetExceededError extends GenerationError {
  constructor(
    message: string,
    public readonly spent: SpentTokens,
    public readonly budgetTokens: number,
  ) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

/** El prompt estimado supera `maxInputTokens`: se rechaza ANTES de llamar al modelo (no se gasta nada). */
export class InputTooLargeError extends GenerationError {
  constructor(
    message: string,
    public readonly estimatedTokens: number,
    public readonly maxInputTokens: number,
    /** De dónde sale el tamaño: instrucciones y esquema (fijo) frente al mensaje del usuario (instrucción, documento base, repositorio). */
    public readonly parts: { fixedTokens: number; userTokens: number },
  ) {
    super(message);
    this.name = 'InputTooLargeError';
  }
}

/** El modelo devolvió documentos que cumplen el esquema pero incumplen las reglas del módulo (`validate()`) en todos los intentos. */
export class VerificationError extends GenerationError {
  constructor(
    message: string,
    /** Las incidencias del último intento (con las de severidad `error` que impiden aceptarlo). */
    public readonly issues: ModuleIssue[],
    public readonly attempts: number,
  ) {
    super(message);
    this.name = 'VerificationError';
  }
}

/** Incidencias en el formato con el que se le devuelven al modelo y con el que se informa: una por línea, con su gravedad y su elemento. */
export function formatModuleIssues(issues: ModuleIssue[]): string {
  return issues.map((i) => `- [${i.severity}] ${i.message}${i.elementId ? ` (elemento «${i.elementId}»)` : ''}`).join('\n');
}

/** Traduce un error del proveedor (HTTP, SDK de Anthropic, red) a un mensaje claro en español. */
export function describeApiError(error: unknown, provider: AiProvider): string {
  if (error instanceof HttpError) {
    if (error.status === 401 || error.status === 403) return credentialsHint(provider);
    if (error.status === 429) return 'Límite de tasa alcanzado. Inténtelo de nuevo en unos segundos.';
    return `Error de la API (${error.status}): ${error.body.slice(0, 300)}`;
  }
  if (provider === 'openai' && error instanceof Error && error.name !== 'Error') return `No se pudo conectar con la API: ${error.message}`;
  if (error instanceof Anthropic.AuthenticationError) {
    return credentialsHint(provider);
  }
  if (error instanceof Anthropic.RateLimitError) return 'Límite de tasa alcanzado. Inténtelo de nuevo en unos segundos.';
  if (error instanceof Anthropic.BadRequestError) return `Solicitud rechazada por la API: ${error.message}`;
  if (error instanceof Anthropic.APIConnectionError) return `No se pudo conectar con la API: ${error.message}`;
  if (error instanceof Anthropic.APIError) return `Error de la API (${error.status}): ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
