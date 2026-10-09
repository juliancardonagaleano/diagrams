import type Anthropic from '@anthropic-ai/sdk';
import { estimateTokens, planCall, resolveTokenLimits, type TokenLimitOptions, type TokenLimits } from './budget';
import { createAiClient, credentialsHint, openaiSettings, resolveModel, resolveProvider, type AiProvider, type Env } from './client';
import { describeApiError, GenerationError } from './errors';
import { chatCompletion, type CompatState } from './openaiCompat';
import type { Effort } from './structured';

export interface TextOptions extends TokenLimitOptions {
  /** Instrucciones del sistema. */
  system: string;
  /** Mensaje del usuario. */
  user: string;
  defaultModel: string;
  client?: Anthropic;
  provider?: AiProvider | 'auto';
  fetch?: typeof fetch;
  model?: string;
  /** Entorno del que se leen las credenciales, el modelo y los topes. Por omisión `process.env`. */
  env?: Env;
  effort?: Effort;
  onProgress?: (message: string) => void;
}

export interface TextResult {
  text: string;
  model: string;
  provider: AiProvider;
  /** La respuesta se cortó por el tope de salida (o por lo que quedaba del presupuesto): el texto es parcial. */
  truncated: boolean;
  usage: { inputTokens: number; outputTokens: number };
  limits: TokenLimits;
}

/**
 * Una respuesta en prosa (Markdown) a un prompt, sin salida estructurada: lo usan `explain` y `review`. Comparte con
 * `generateStructured` la elección de plataforma y modelo, el tope de salida por llamada, el presupuesto total y el rechazo
 * previo de una entrada demasiado grande, pero es UNA llamada, sin reintentos: una respuesta cortada se devuelve como parcial
 * (`truncated`) y no como error, porque media explicación sigue sirviendo.
 */
export async function generateText(options: TextOptions): Promise<TextResult> {
  const provider = resolveProvider(options.provider ?? (options.client ? 'anthropic' : undefined), options.env);
  const model = resolveModel(provider, options.model, options.defaultModel, options.env);
  const progress = options.onProgress ?? (() => {});
  const limits = resolveTokenLimits(options, options.env);

  const fixedTokens = estimateTokens(options.system);
  const userTokens = estimateTokens(options.user);
  const callMaxTokens = planCall(limits, { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, { tokens: fixedTokens + userTokens, parts: { fixedTokens, userTokens } }, 0);
  progress(`Consultando a ${model}…`);

  try {
    if (provider === 'openai') {
      const { baseURL, apiKey } = openaiSettings(options.env);
      if (!baseURL || !apiKey) throw new GenerationError(credentialsHint('openai'));
      // Texto libre: sin `response_format`.
      const state: CompatState = { format: 'none', tokenParam: 'max_tokens' };
      const result = await chatCompletion({
        baseURL,
        apiKey,
        model,
        messages: [
          { role: 'system', content: options.system },
          { role: 'user', content: options.user },
        ],
        maxTokens: callMaxTokens,
        state,
        fetch: options.fetch,
      });
      return { text: result.text, model: result.model, provider, truncated: result.finishReason === 'length', usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens }, limits };
    }
    const client = options.client ?? (await createAiClient(provider, options.env));
    const response = await client.beta.messages.create({
      model,
      max_tokens: callMaxTokens,
      // Los fallbacks del servidor solo existen en la API de Anthropic, no en Foundry.
      ...(provider === 'anthropic' ? { betas: ['server-side-fallback-2026-07-01' as const], fallbacks: 'default' as const } : {}),
      system: options.system,
      messages: [{ role: 'user', content: options.user }],
      ...(options.effort ? { output_config: { effort: options.effort } } : {}),
    });
    if (response.stop_reason === 'refusal') throw new GenerationError('El modelo rechazó la solicitud (stop_reason: refusal).');
    const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    return {
      text,
      model: response.model,
      provider,
      truncated: response.stop_reason === 'max_tokens',
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      limits,
    };
  } catch (error) {
    if (error instanceof GenerationError) throw error;
    throw new GenerationError(describeApiError(error, provider), error);
  }
}
