import { BudgetExceededError, GenerationError, InputTooLargeError, type SpentTokens } from './errors';

/**
 * Topes de coste de las llamadas al modelo. Se miden en TOKENS, no en dinero: los precios cambian por proveedor, modelo y
 * contrato, y una tabla de precios aquí envejecería mal. Quien quiera dinero multiplica los totales que informa el resultado
 * por la tarifa de su contrato.
 */

/** Salida máxima por llamada. Es el valor que el código fijaba antes de que fuera configurable. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;
/**
 * Tope TOTAL (entrada + salida, sumado en todos los reintentos) por omisión. Cubre con holgura una generación normal con un
 * reintento (un prompt de ~30 000 tokens más 16 000 de salida, dos veces, son ~92 000) sin dejar que un bucle de correcciones sobre un
 * documento enorme gaste sin límite.
 */
export const DEFAULT_BUDGET_TOKENS = 200_000;
/**
 * Entrada máxima de UNA llamada, estimada antes de enviarla. El resumen de `--from-repo` (60 KB por omisión) ronda los 20 000
 * tokens, así que 100 000 deja sitio de sobra a las instrucciones, al esquema y a un documento base grande, y frena un prompt
 * enorme antes de pagarlo.
 */
export const DEFAULT_MAX_INPUT_TOKENS = 100_000;
/** Una llamada con menos salida disponible que esto no puede producir un documento: se corta antes de hacerla. */
export const MIN_OUTPUT_TOKENS = 256;
/**
 * Caracteres por token de la estimación previa. Es deliberadamente bajo (el texto en español y el JSON dan entre 3 y 4
 * caracteres por token con el tokenizador de Claude): la estimación sobrestima un poco y prefiere rechazar una petición dudosa a
 * dejar pasar una enorme. No es un tokenizador; los totales que se informan son siempre los que devuelve el proveedor.
 */
export const CHARS_PER_TOKEN = 3;

/** Estimación (por exceso) de los tokens de un texto, sin tokenizador. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface TokenLimitOptions {
  /** Tokens de SALIDA máximos por llamada. Por omisión, `IARK_AI_MAX_TOKENS` o 16 000. */
  maxTokens?: number;
  /** Tope TOTAL de entrada + salida en todos los intentos. Por omisión, `IARK_AI_BUDGET_TOKENS` o 200 000. */
  budgetTokens?: number;
  /** Entrada máxima de una llamada (estimada antes de enviarla). Por omisión, `IARK_AI_MAX_INPUT_TOKENS` o 100 000. */
  maxInputTokens?: number;
}

export interface TokenLimits {
  maxTokens: number;
  budgetTokens: number;
  maxInputTokens: number;
}

type Env = Record<string, string | undefined>;

function positiveInteger(value: unknown, label: string): number {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) throw new GenerationError(`${label} debe ser un entero positivo (se recibió «${String(value)}»).`);
  return n;
}

/** Resuelve los topes: lo indicado explícitamente, si no la variable de entorno y, si no, el valor por omisión. */
export function resolveTokenLimits(options: TokenLimitOptions = {}, env: Env = process.env): TokenLimits {
  const pick = (explicit: number | undefined, label: string, variable: string, fallback: number): number => {
    if (explicit !== undefined) return positiveInteger(explicit, label);
    const fromEnv = env[variable];
    return fromEnv !== undefined && fromEnv.trim() !== '' ? positiveInteger(fromEnv, variable) : fallback;
  };
  return {
    maxTokens: pick(options.maxTokens, '--max-tokens', 'IARK_AI_MAX_TOKENS', DEFAULT_MAX_OUTPUT_TOKENS),
    budgetTokens: pick(options.budgetTokens, '--budget-tokens', 'IARK_AI_BUDGET_TOKENS', DEFAULT_BUDGET_TOKENS),
    maxInputTokens: pick(options.maxInputTokens, '--max-input-tokens', 'IARK_AI_MAX_INPUT_TOKENS', DEFAULT_MAX_INPUT_TOKENS),
  };
}

/** Acumula los tokens que informa el proveedor en cada llamada. */
export class TokenMeter {
  inputTokens = 0;
  outputTokens = 0;

  add(inputTokens: number, outputTokens: number): void {
    this.inputTokens += inputTokens;
    this.outputTokens += outputTokens;
  }

  get totalTokens(): number {
    return this.inputTokens + this.outputTokens;
  }

  snapshot(): SpentTokens {
    return { inputTokens: this.inputTokens, outputTokens: this.outputTokens, totalTokens: this.totalTokens };
  }
}

export interface CallEstimate {
  /** Entrada estimada de la llamada. */
  tokens: number;
  /** De dónde sale: instrucciones y esquema (fijo) frente al mensaje del usuario. */
  parts: { fixedTokens: number; userTokens: number };
}

/** Miles con punto (16.000), sin depender de los datos de idioma de ICU, que cambian entre compilaciones de Node. */
export const formatTokens = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/**
 * Decide, ANTES de llamar, cuánta salida se le permite a la llamada o la rechaza: por entrada demasiado grande (no se gasta
 * nada) o porque el presupuesto restante no alcanza ni para la entrada más una salida mínima. Devuelve `max_tokens` para la
 * llamada: el tope por llamada, recortado a lo que queda del presupuesto total para no pasarse de él.
 */
export function planCall(limits: TokenLimits, spent: SpentTokens, estimate: CallEstimate, attemptsMade: number): number {
  if (estimate.tokens > limits.maxInputTokens) {
    const where = attemptsMade === 0 ? 'El prompt' : `El reintento ${attemptsMade} (la conversación crece con cada intento)`;
    throw new InputTooLargeError(
      `${where} estimado en ~${formatTokens(estimate.tokens)} tokens de entrada supera el máximo permitido de ${formatTokens(limits.maxInputTokens)} (--max-input-tokens, o IARK_AI_MAX_INPUT_TOKENS). ` +
        `Se compone de ~${formatTokens(estimate.parts.fixedTokens)} de instrucciones y esquema (fijos) y ~${formatTokens(estimate.parts.userTokens)} del mensaje del usuario ` +
        `(la instrucción, el documento base o el repositorio). No se llamó al modelo en este intento; gastado hasta ahora: ${formatTokens(spent.totalTokens)} tokens.`,
      estimate.tokens,
      limits.maxInputTokens,
      estimate.parts,
    );
  }
  const available = limits.budgetTokens - spent.totalTokens - estimate.tokens;
  if (available < MIN_OUTPUT_TOKENS) {
    const detail =
      attemptsMade === 0
        ? `no alcanza ni para la entrada estimada de la primera llamada (~${formatTokens(estimate.tokens)} tokens) más una salida mínima de ${MIN_OUTPUT_TOKENS}. No se llamó al modelo (gastado: 0 tokens)`
        : `se agotó tras ${attemptsMade} intento(s): gastados ${formatTokens(spent.totalTokens)} tokens (${formatTokens(spent.inputTokens)} de entrada y ${formatTokens(spent.outputTokens)} de salida) ` +
          `y el siguiente reintento necesitaría ~${formatTokens(estimate.tokens)} de entrada más una salida mínima. Se detiene sin reintentar`;
    throw new BudgetExceededError(`El presupuesto de ${formatTokens(limits.budgetTokens)} tokens (--budget-tokens, o IARK_AI_BUDGET_TOKENS) ${detail}.`, spent, limits.budgetTokens);
  }
  return Math.min(limits.maxTokens, available);
}

/**
 * Error cuando la respuesta se corta por `max_tokens`. Si el límite de la llamada era el recorte por presupuesto, lo que se agotó
 * es el presupuesto; si era el tope por llamada, es ese tope.
 */
export function truncationError(limits: TokenLimits, callMaxTokens: number, spent: SpentTokens): GenerationError {
  if (callMaxTokens < limits.maxTokens) {
    return new BudgetExceededError(
      `El presupuesto de ${formatTokens(limits.budgetTokens)} tokens (--budget-tokens) se agotó durante la respuesta, que quedó cortada (límite de tokens de esa llamada: ${formatTokens(callMaxTokens)}). ` +
        `Gastado: ${formatTokens(spent.totalTokens)} tokens (${formatTokens(spent.inputTokens)} de entrada y ${formatTokens(spent.outputTokens)} de salida).`,
      spent,
      limits.budgetTokens,
    );
  }
  return new GenerationError(
    `La respuesta excedió el límite de tokens de salida (${formatTokens(callMaxTokens)}, --max-tokens, o IARK_AI_MAX_TOKENS); simplifique la descripción, divida el sistema o suba el límite. ` +
      `Gastado: ${formatTokens(spent.totalTokens)} tokens.`,
  );
}
