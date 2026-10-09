import { Command, InvalidArgumentError } from 'commander';
import {
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  formatTokens,
  InputTooLargeError,
  VerificationError,
  type AttemptRecord,
  type Effort,
  type StructuredResult,
  type TextResult,
  type TokenLimitOptions,
  type TokenLimits,
} from '@iark/kernel';
import { CliError, info } from './io';

/**
 * Lo que comparten los comandos que llaman a un modelo (`generate`, `explain`, `review`): las opciones de plataforma, modelo y
 * tope de tokens, su validación, el informe de uso y la traducción de los errores de IA a un mensaje con la salida que tienen.
 */

export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function parseEffort(value: string): Effort {
  const v = value.toLowerCase() as Effort;
  if (!EFFORTS.includes(v)) throw new InvalidArgumentError(`Esfuerzo inválido. Use: ${EFFORTS.join(', ')}`);
  return v;
}

export const PROVIDERS = ['auto', 'anthropic', 'foundry', 'openai'] as const;

export function parseProvider(value: string): (typeof PROVIDERS)[number] {
  const v = value.toLowerCase() as (typeof PROVIDERS)[number];
  if (!PROVIDERS.includes(v)) throw new InvalidArgumentError(`Plataforma inválida. Use: ${PROVIDERS.join(', ')}`);
  return v;
}

/** Entero positivo de una opción de tokens (`--max-tokens 8000`). */
export function parseTokenCount(flag: string): (value: string) => number {
  return (value) => {
    const n = Number(value.trim());
    if (!Number.isInteger(n) || n <= 0) throw new InvalidArgumentError(`${flag} debe ser un entero positivo (tokens).`);
    return n;
  };
}

/** Las opciones de plataforma y modelo de los comandos que llaman a un modelo. */
export function addModelOptions(command: Command, defaultModel: string): Command {
  return command
    .option('-p, --provider <plataforma>', 'plataforma: auto|anthropic (API de Anthropic)|foundry (Claude en Foundry)|openai (cualquier modelo de Foundry / API compatible con OpenAI)', parseProvider, 'auto')
    .option('-m, --model <modelo>', `modelo (por defecto ${defaultModel}; en Foundry, el nombre de tu despliegue o AI_MODEL / ANTHROPIC_FOUNDRY_MODEL)`)
    .option('-e, --effort <nivel>', `esfuerzo de razonamiento (${EFFORTS.join('|')})`, parseEffort);
}

/** Los topes de coste en tokens (sin precios): salida por llamada, total y entrada. */
export function addBudgetOptions(command: Command): Command {
  return command
    .option(
      '--max-tokens <n>',
      `tope de tokens de SALIDA por llamada al modelo (por defecto ${formatTokens(DEFAULT_MAX_OUTPUT_TOKENS)}; o la variable IARK_AI_MAX_TOKENS)`,
      parseTokenCount('--max-tokens'),
    )
    .option(
      '--budget-tokens <n>',
      `tope TOTAL de tokens (entrada + salida) sumado en todos los reintentos (por defecto ${formatTokens(DEFAULT_BUDGET_TOKENS)}; o IARK_AI_BUDGET_TOKENS): al agotarse se detiene con un error que informa lo gastado`,
      parseTokenCount('--budget-tokens'),
    )
    .option(
      '--max-input-tokens <n>',
      `rechaza, antes de llamar, un prompt cuya entrada estimada supere este tamaño en tokens (por defecto ${formatTokens(DEFAULT_MAX_INPUT_TOKENS)}; o IARK_AI_MAX_INPUT_TOKENS); con --from-repo, dice qué recortar`,
      parseTokenCount('--max-input-tokens'),
    );
}

/** Las opciones de tokens tal como las lee commander, en la forma que espera el kernel. */
export function tokenLimitOptions(opts: { maxTokens?: number; budgetTokens?: number; maxInputTokens?: number }): TokenLimitOptions {
  return { maxTokens: opts.maxTokens, budgetTokens: opts.budgetTokens, maxInputTokens: opts.maxInputTokens };
}

const triggerLabel: Record<AttemptRecord['trigger'], string> = { initial: 'inicial', schema: 'corrige el esquema', rules: 'corrige las reglas' };
const outcomeLabel: Record<AttemptRecord['outcome'], string> = { valid: 'válido', schema: 'incumple el esquema', rules: 'incumple las reglas del módulo' };
const severityLabel = { error: 'error   ', warning: 'aviso   ', info: 'info    ' } as const;

/** Línea de presupuesto: lo gastado frente al tope total y los topes por llamada. */
export function budgetLine(spent: number, limits: TokenLimits): string {
  return `Presupuesto: ${formatTokens(spent)} de ${formatTokens(limits.budgetTokens)} tokens (salida máxima por llamada ${formatTokens(limits.maxTokens)}; entrada máxima ${formatTokens(limits.maxInputTokens)}).`;
}

/**
 * Informa por stderr de lo que pasó al generar: los intentos con su motivo y sus tokens (si hubo más de uno), el desglose de
 * reintentos, lo que dijo la verificación y el presupuesto. La línea de resumen («Modelo generado con…») la escribe quien llama.
 */
export function reportGeneration(result: StructuredResult<unknown>): void {
  if (result.attempts > 1) {
    for (const a of result.attemptLog) {
      info(`  intento ${a.attempt} (${triggerLabel[a.trigger]}): ${outcomeLabel[a.outcome]} · ${formatTokens(a.inputTokens)} tokens de entrada, ${formatTokens(a.outputTokens)} de salida`);
    }
    info(`  Reintentos: ${result.retries.schema} por el esquema, ${result.retries.rules} por las reglas del módulo.`);
  }
  const errors = result.issues.filter((i) => i.severity === 'error');
  const rest = result.issues.length - errors.length;
  if (result.verification === 'skipped') info('  Verificación con las reglas del módulo: omitida.');
  else if (result.verification === 'accepted-invalid') {
    info(`  AVISO: el documento incumple ${errors.length} regla(s) del módulo y se aceptó por --allow-invalid:`);
    for (const i of errors) info(`    ${severityLabel[i.severity]} ${i.message}`);
  } else info(`  Verificación con las reglas del módulo: sin errores${rest > 0 ? ` (${rest} aviso(s) o nota(s) en el documento; compruébalo con \`iark validate\`)` : ''}.`);
  info(`  ${budgetLine(result.usage.inputTokens + result.usage.outputTokens, result.limits)}`);
}

/** Informa del uso de un comando de una sola llamada (`explain`, `review`). */
export function reportText(result: TextResult): void {
  info(`Respuesta de ${result.model} (${result.provider}): ${formatTokens(result.usage.inputTokens)} tokens de entrada, ${formatTokens(result.usage.outputTokens)} de salida.`);
  info(`  ${budgetLine(result.usage.inputTokens + result.usage.outputTokens, result.limits)}`);
  if (result.truncated) info('AVISO: la respuesta se cortó por el tope de salida y está incompleta; suba --max-tokens (o --budget-tokens) para obtenerla entera.');
}

export interface RepoHint {
  /** `--repo-budget` en KB, tal como se aplicó (el valor por omisión si no se indicó). */
  budgetKb: number;
}

/** Qué recortar cuando el prompt es demasiado grande y viene de un repositorio. */
function repoCutHint(repo: RepoHint): string {
  return (
    `\nQué recortar (el resumen del repositorio es lo que más pesa):\n` +
    `  - baje --repo-budget (hoy ${repo.budgetKb} KB; más pequeño = menos archivos y más recortados),\n` +
    `  - limite el contenido con --repo-include <glob> (p. ej. la carpeta de un servicio) o quite lo que sobre con --repo-exclude <glob>,\n` +
    `  - o apunte --from-repo a la subcarpeta que le interesa en lugar de la raíz de un monorepo.\n` +
    `  Con --dry-run ve el prompt y su tamaño estimado sin llamar al modelo; si de verdad necesita ese tamaño, suba --max-input-tokens.`
  );
}

/**
 * Convierte los errores de IA con salida propia en un `CliError` que dice qué hacer, con el código de salida de cada uno: entrada
 * demasiado grande → 2 (uso), documento que incumple las reglas → 3 (como `validate`). El resto (`GenerationError`) se queda como
 * está y el CLI lo informa con el código 4.
 */
export function explainAiError(error: unknown, repo?: RepoHint): unknown {
  if (error instanceof InputTooLargeError) {
    const extra = repo
      ? repoCutHint(repo)
      : '\nAcorte la instrucción, use un documento base (--from) más pequeño, o suba --max-input-tokens si de verdad necesita ese tamaño.';
    return new CliError(`Error generando el modelo: ${error.message}${extra}`, 2);
  }
  if (error instanceof VerificationError) {
    return new CliError(
      `Error generando el modelo: ${error.message}\n` +
        'Use --allow-invalid para aceptar el último documento tal cual (queda avisado con sus errores), --retries <n> para dar más intentos al modelo, o --no-verify para omitir la verificación con las reglas del módulo.',
      3,
    );
  }
  return error;
}

/** Ejecuta `fn` traduciendo los errores de IA (ver `explainAiError`). */
export async function withAiErrors<T>(fn: () => Promise<T>, repo?: RepoHint): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw explainAiError(error, repo);
  }
}
