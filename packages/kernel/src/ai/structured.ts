import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { carryRefs } from '../module/refs';
import type { AiSpec, ModuleIssue } from '../module/types';
import { extractJson } from '../util/extractJson';
import { estimateTokens, planCall, resolveTokenLimits, TokenMeter, truncationError, type CallEstimate, type TokenLimitOptions, type TokenLimits } from './budget';
import { createAiClient, credentialsHint, openaiSettings, resolveModel, resolveProvider, type AiProvider } from './client';
import { describeApiError, formatModuleIssues, GenerationError, VerificationError } from './errors';
import { chatCompletion, initialCompatState, type ChatMessage } from './openaiCompat';

export { GenerationError };

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface StructuredOptions<TDoc> extends TokenLimitOptions {
  /** Descripción en lenguaje natural del sistema (o instrucción de refinamiento si hay `base`). */
  instruction: string;
  /** Documento existente a refinar. */
  base?: TDoc;
  /** Modelo por defecto si no se indica otro (ni hay variable de entorno). */
  defaultModel: string;
  /** Cliente de Anthropic (inyectable para pruebas). Por defecto se crea según `provider`. */
  client?: Anthropic;
  /** Plataforma: `anthropic`, `foundry` (Claude), `openai` (cualquier modelo de Foundry) o `auto` (según el entorno). */
  provider?: AiProvider | 'auto';
  /** `fetch` inyectable para pruebas de la plataforma `openai`. */
  fetch?: typeof fetch;
  /** Modelo (en Foundry, el nombre de tu despliegue). */
  model?: string;
  effort?: Effort;
  /** Reintentos si el modelo devuelve un documento inválido (por el esquema o por las reglas del módulo). */
  maxRetries?: number;
  /**
   * Reglas del módulo (`DomainModule.validate`). Con ellas, un documento que ya cumple el esquema pasa además por aquí: si hay
   * incidencias de severidad `error` se le devuelven al modelo para que las corrija (con el mismo número de reintentos que el
   * esquema); las `warning` y `info` no reintentan y se devuelven en `StructuredResult.issues`. Al refinar (`base`), los errores
   * que ya tenía el documento base no cuentan: solo se le piden al modelo los que introduce.
   */
  validate?: (document: TDoc) => ModuleIssue[];
  /** `false` desactiva la verificación con `validate` (`--no-verify`). Por omisión se verifica si hay `validate`. */
  verify?: boolean;
  /**
   * Gravedad que obliga a reintentar: `error` (por omisión) o `warning` (como `validate --strict`: los avisos también cuentan).
   * Hoy solo el módulo C4 emite errores; los demás módulos solo avisos, así que con `error` el bucle de reglas no reintenta en ellos.
   */
  retryOn?: 'error' | 'warning';
  /**
   * Si tras agotar los reintentos el último documento cumple el esquema pero sigue con errores de reglas, devolverlo (con sus
   * incidencias en `issues` y `verification: 'accepted-invalid'`) en lugar de fallar. Por omisión falla con el informe de incidencias.
   */
  allowInvalid?: boolean;
  onProgress?: (message: string) => void;
}

/** Por qué se hizo un intento: el primero es `initial`; los demás corrigen el esquema (`schema`) o las reglas del módulo (`rules`). */
export type AttemptTrigger = 'initial' | 'schema' | 'rules';

/** Cómo terminó un intento: `valid`, o incumplió el esquema (`schema`) o las reglas del módulo (`rules`). */
export type AttemptOutcome = 'valid' | 'schema' | 'rules';

export interface AttemptRecord {
  /** Número de intento, desde 1. */
  attempt: number;
  trigger: AttemptTrigger;
  outcome: AttemptOutcome;
  /** Tokens que cobró el proveedor en este intento. */
  inputTokens: number;
  outputTokens: number;
}

/** `passed`: sin errores de reglas; `skipped`: no se verificó (sin `validate` o con `verify: false`); `accepted-invalid`: se aceptó con errores por `allowInvalid`. */
export type VerificationStatus = 'passed' | 'skipped' | 'accepted-invalid';

export interface StructuredResult<TDoc> {
  document: TDoc;
  model: string;
  provider: AiProvider;
  attempts: number;
  /** Totales de todos los intentos. */
  usage: { inputTokens: number; outputTokens: number };
  /** Incidencias de `validate()` sobre el documento devuelto: avisos y notas y, solo con `accepted-invalid`, también los errores. Vacío si no se verificó. */
  issues: ModuleIssue[];
  /** Hizo falta al menos un reintento de corrección. */
  repaired: boolean;
  /** Reintentos desglosados por motivo: el modelo incumplió el esquema o las reglas del módulo. */
  retries: { schema: number; rules: number };
  /** Cada intento, con su motivo, su resultado y sus tokens. */
  attemptLog: AttemptRecord[];
  verification: VerificationStatus;
  /** Topes con los que se ejecutó (por llamada, total y de entrada). */
  limits: TokenLimits;
}

/** Un turno de la conversación con el modelo: lo generado (o por qué no se pudo leer). */
interface TurnResult {
  generated: unknown | null;
  /** Por qué no hay `generated` (JSON ilegible o que incumple el esquema); se le devuelve al modelo para que lo corrija. */
  problem?: string;
  /** La respuesta se cortó por `max_tokens`: no hay documento que corregir, se informa del tope. */
  truncated?: boolean;
  servedModel: string;
  inputTokens: number;
  outputTokens: number;
}

interface Conversation {
  /** Hace la llamada con `maxTokens` de salida como máximo. */
  ask(maxTokens: number): Promise<TurnResult>;
  /** Añade un mensaje del usuario (la corrección tras un intento inválido). */
  feedback(text: string): void;
  /** Tamaño estimado de lo que se enviaría en la siguiente llamada (instrucciones, esquema y mensajes), para decidir ANTES de enviar. */
  estimate(): CallEstimate;
}

const contentText = (content: string | unknown[]): string => (typeof content === 'string' ? content : JSON.stringify(content));

/** Lo que el modelo devolvió como texto, interpretado como JSON y comprobado contra el esquema del módulo. */
function readGenerated<TDoc>(spec: AiSpec<TDoc>, text: string | undefined): { generated: unknown } | { problem: string } {
  if (text === undefined || text.trim() === '') return { problem: 'La respuesta no contiene texto. Devuelve solo el objeto JSON.' };
  let json: unknown;
  try {
    json = JSON.parse(extractJson(text));
  } catch {
    return { problem: 'La respuesta no es un JSON válido. Devuelve solo el objeto JSON.' };
  }
  const parsed = spec.generationSchema.safeParse(json);
  if (!parsed.success) return { problem: parsed.error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`).join('\n') };
  return { generated: parsed.data };
}

/** Conversación con Claude (API de Anthropic o Claude en Foundry) usando salida estructurada. */
function claudeConversation<TDoc>(
  client: Anthropic,
  provider: 'anthropic' | 'foundry',
  model: string,
  spec: AiSpec<TDoc>,
  options: StructuredOptions<TDoc>,
): Conversation {
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [{ role: 'user', content: spec.user(options.instruction, options.base) }];
  const system = spec.system();
  const schemaText = JSON.stringify(spec.generationJsonSchema());
  // El SDK, con su `parse` por omisión, LANZA si la respuesta se corta o no cumple el esquema y se pierden el texto y los
  // tokens: no habría reintento ni informe de coste. Se le da un `parse` que devuelve el texto tal cual y el esquema se
  // comprueba aquí (`readGenerated`), igual que con los modelos de Foundry.
  const zodFormat = betaZodOutputFormat(spec.generationSchema as never);
  const format = { type: zodFormat.type, schema: zodFormat.schema, parse: (content: string): string => content };
  return {
    async ask(maxTokens) {
      const response = await client.beta.messages.parse({
        model,
        max_tokens: maxTokens,
        // Los fallbacks del servidor solo existen en la API de Anthropic, no en Foundry.
        ...(provider === 'anthropic' ? { betas: ['server-side-fallback-2026-07-01' as const], fallbacks: 'default' as const } : {}),
        system,
        messages,
        output_config: {
          format,
          ...(options.effort ? { effort: options.effort } : {}),
        },
      });
      const usage = { servedModel: response.model, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
      if (response.stop_reason === 'refusal') throw new GenerationError('El modelo rechazó la solicitud (stop_reason: refusal).');
      if (response.stop_reason === 'max_tokens') return { generated: null, truncated: true, ...usage };
      messages.push({ role: 'assistant', content: response.content.filter((b) => b.type === 'text' || b.type === 'thinking') });
      const output = response.parsed_output as unknown;
      // Un cliente que ya devuelve el objeto interpretado (p. ej. uno simulado) se acepta tal cual, pero se comprueba igual.
      const text =
        typeof output === 'string'
          ? output
          : output !== null && typeof output === 'object'
            ? JSON.stringify(output)
            : response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      const read = readGenerated(spec, text);
      return 'generated' in read ? { generated: read.generated, ...usage } : { generated: null, problem: read.problem, ...usage };
    },
    feedback: (text) => void messages.push({ role: 'user', content: text }),
    estimate() {
      const fixed = estimateTokens(system + schemaText);
      const user = estimateTokens(messages.map((m) => contentText(m.content as string | unknown[])).join('\n'));
      return { tokens: fixed + user, parts: { fixedTokens: fixed, userTokens: user } };
    },
  };
}

/**
 * Conversación con cualquier modelo de Foundry (u otro servicio compatible con Chat Completions). No todos los modelos
 * garantizan el esquema, así que el JSON Schema va también en el prompt y la respuesta se valida aquí con zod.
 */
function openaiConversation<TDoc>(model: string, spec: AiSpec<TDoc>, options: StructuredOptions<TDoc>): Conversation {
  const { baseURL, apiKey } = openaiSettings();
  if (!baseURL || !apiKey) throw new GenerationError(credentialsHint('openai'));
  const schema = spec.generationJsonSchema();
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        `${spec.system()}\n\nResponde ÚNICAMENTE con un objeto JSON (sin comentarios ni texto adicional) que cumpla este JSON Schema; ` +
        `usa null en los campos opcionales sin valor:\n${JSON.stringify(schema)}`,
    },
    { role: 'user', content: spec.user(options.instruction, options.base) },
  ];
  const state = initialCompatState();
  return {
    async ask(maxTokens) {
      const result = await chatCompletion({ baseURL, apiKey, model, messages, jsonSchema: schema as Record<string, unknown>, maxTokens, state, fetch: options.fetch });
      const usage = { servedModel: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
      if (result.finishReason === 'length') return { generated: null, truncated: true, ...usage };
      messages.push({ role: 'assistant', content: result.text });
      const read = readGenerated(spec, result.text);
      return 'generated' in read ? { generated: read.generated, ...usage } : { generated: null, problem: read.problem, ...usage };
    },
    feedback: (text) => void messages.push({ role: 'user', content: text }),
    estimate() {
      const fixed = estimateTokens(messages[0].content);
      const user = estimateTokens(messages.slice(1).map((m) => m.content).join('\n'));
      return { tokens: fixed + user, parts: { fixedTokens: fixed, userTokens: user } };
    },
  };
}

/** Clave estable de una incidencia, para reconocer las que ya tenía el documento base. */
const issueKey = (i: ModuleIssue): string => `${i.severity}|${i.elementId ?? ''}|${i.message}`;

/**
 * Genera (o refina) un documento de cualquier módulo a partir de una instrucción, con Claude (salida estructurada) o
 * con cualquier modelo de Foundry (JSON validado aquí). El módulo aporta el esquema, los prompts y la conversión
 * a documento (`AiSpec`) y, para verificar, sus reglas (`validate`); aquí se gestionan el proveedor, el bucle de corrección
 * (esquema y reglas), los topes de tokens y el uso.
 *
 * Bucle: cada intento se comprueba contra el esquema y la conversión del módulo; si pasa y hay `validate`, también contra sus
 * reglas. Lo que falle se le devuelve al modelo (con el texto de las incidencias y el elemento al que se refieren) hasta agotar
 * `maxRetries`. Antes de CADA llamada se estima la entrada y se recorta la salida a lo que queda del presupuesto total.
 */
export async function generateStructured<TDoc>(spec: AiSpec<TDoc>, options: StructuredOptions<TDoc>): Promise<StructuredResult<TDoc>> {
  // Un cliente de Anthropic inyectado implica el protocolo de Anthropic, sea cual sea el entorno.
  const provider = resolveProvider(options.provider ?? (options.client ? 'anthropic' : undefined));
  const model = resolveModel(provider, options.model, options.defaultModel);
  const maxRetries = options.maxRetries ?? 1;
  const progress = options.onProgress ?? (() => {});
  const limits = resolveTokenLimits(options);
  const verifying = options.verify !== false && options.validate !== undefined;

  /** Las reglas del módulo, con sus fallos convertidos en `GenerationError` (un módulo defectuoso no debe verse como un error inesperado). */
  const runValidate = (document: TDoc): ModuleIssue[] => {
    try {
      return options.validate!(document);
    } catch (error) {
      throw new GenerationError(`Las reglas del módulo fallaron al validar el documento: ${error instanceof Error ? error.message : String(error)}`, error);
    }
  };
  /** Las incidencias que obligan a corregir: los errores y, con `retryOn: 'warning'`, también los avisos. */
  const isBlocking = (i: ModuleIssue): boolean => i.severity === 'error' || (options.retryOn === 'warning' && i.severity === 'warning');
  // Al refinar, lo que el documento base ya tenía no es culpa del modelo y no bloquea.
  const preexisting = new Set(verifying && options.base !== undefined ? runValidate(options.base).filter(isBlocking).map(issueKey) : []);

  let conversation: Conversation;
  try {
    conversation =
      provider === 'openai'
        ? openaiConversation(model, spec, options)
        : claudeConversation(options.client ?? (await createAiClient(provider)), provider, model, spec, options);
  } catch (error) {
    if (error instanceof GenerationError) throw error;
    throw new GenerationError(describeApiError(error, provider), error);
  }

  const meter = new TokenMeter();
  const attemptLog: AttemptRecord[] = [];
  let attempts = 0;
  // En un objeto y no en `let` sueltos: se modifican desde funciones internas y TypeScript no lo vería al leerlos en el bucle.
  const flow: { trigger: AttemptTrigger; nextEstimate?: CallEstimate } = { trigger: 'initial' };
  let lastFailure: { kind: 'schema'; text: string } | { kind: 'rules'; text: string; issues: ModuleIssue[] } | undefined;
  /** El último documento que cumplió el esquema, con sus incidencias: lo que `allowInvalid` acepta si se agotan los reintentos. */
  let candidate: { document: TDoc; issues: ModuleIssue[] } | undefined;
  let servedModel = model;

  const finish = (document: TDoc, issues: ModuleIssue[], verification: VerificationStatus): StructuredResult<TDoc> => ({
    document,
    model: servedModel,
    provider,
    attempts,
    usage: { inputTokens: meter.inputTokens, outputTokens: meter.outputTokens },
    issues,
    repaired: attempts > 1,
    retries: { schema: attemptLog.filter((a) => a.trigger === 'schema').length, rules: attemptLog.filter((a) => a.trigger === 'rules').length },
    attemptLog,
    verification,
    limits,
  });

  while (attempts <= maxRetries) {
    // Se decide ANTES de llamar: entrada demasiado grande o presupuesto insuficiente no gastan nada. En un reintento la entrada
    // es lo que cobró la llamada anterior más la respuesta del modelo y la corrección que se le acaba de añadir.
    const callMaxTokens = planCall(limits, meter.snapshot(), flow.nextEstimate ?? conversation.estimate(), attempts);
    attempts += 1;
    const trigger = flow.trigger;
    progress(attempts === 1 ? `Consultando a ${model}…` : `Reintento ${attempts - 1}: corrigiendo ${trigger === 'rules' ? 'las reglas del módulo' : 'el esquema'}…`);

    const turn = await conversation.ask(callMaxTokens).catch((error: unknown): never => {
      if (error instanceof GenerationError) throw error;
      throw new GenerationError(describeApiError(error, provider), error);
    });
    meter.add(turn.inputTokens, turn.outputTokens);
    servedModel = turn.servedModel;
    const record = (outcome: AttemptOutcome): void => void attemptLog.push({ attempt: attempts, trigger, outcome, inputTokens: turn.inputTokens, outputTokens: turn.outputTokens });
    /** Devuelve al modelo lo que falló y prepara la estimación del siguiente intento. */
    const correct = (kind: 'schema' | 'rules', issues: string): void => {
      const message = spec.retry(issues);
      conversation.feedback(message);
      const estimate = conversation.estimate();
      flow.nextEstimate = turn.inputTokens > 0 ? { tokens: turn.inputTokens + turn.outputTokens + estimateTokens(message), parts: estimate.parts } : estimate;
      flow.trigger = kind;
    };

    if (turn.truncated) {
      record('schema');
      throw truncationError(limits, callMaxTokens, meter.snapshot());
    }
    if (!turn.generated) {
      record('schema');
      const text = turn.problem ?? 'La respuesta del modelo no pudo interpretarse.';
      lastFailure = { kind: 'schema', text };
      correct('schema', text);
      continue;
    }
    const result = spec.toDocument(turn.generated);
    if (!result.ok) {
      record('schema');
      lastFailure = { kind: 'schema', text: result.issues };
      correct('schema', result.issues);
      continue;
    }
    // Al refinar, los enlaces por URN (`ref`) del documento base sobreviven: el modelo no los conoce.
    const referenced = options.base === undefined ? result.document : carryRefs(options.base, result.document);
    const document = options.base !== undefined && spec.carry ? spec.carry(options.base, referenced) : referenced;

    if (!verifying) {
      record('valid');
      progress('Modelo válido.');
      return finish(document, [], 'skipped');
    }
    const issues = runValidate(document);
    const blocking = issues.filter((i) => isBlocking(i) && !preexisting.has(issueKey(i)));
    if (blocking.length === 0) {
      record('valid');
      progress(issues.length > 0 ? `Modelo válido (${issues.length} incidencia(s) sin errores).` : 'Modelo válido.');
      return finish(document, issues, 'passed');
    }
    record('rules');
    candidate = { document, issues };
    const text = formatModuleIssues(blocking);
    lastFailure = { kind: 'rules', text, issues };
    progress(`El modelo incumple ${blocking.length} regla(s) del módulo.`);
    correct('rules', text);
  }

  if (options.allowInvalid && candidate) {
    progress('Se acepta el documento con errores de reglas (allowInvalid).');
    return finish(candidate.document, candidate.issues, 'accepted-invalid');
  }
  if (lastFailure?.kind === 'rules') {
    throw new VerificationError(
      `El modelo no produjo un documento que cumpla las reglas del módulo tras ${attempts} intentos:\n${lastFailure.text}`,
      lastFailure.issues,
      attempts,
    );
  }
  throw new GenerationError(`El modelo no produjo un documento válido tras ${attempts} intentos:\n${lastFailure?.text ?? ''}`);
}
