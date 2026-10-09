import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AiSpec } from '../module/types';
import { DEFAULT_BUDGET_TOKENS, DEFAULT_MAX_INPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS, estimateTokens, formatTokens, MIN_OUTPUT_TOKENS, planCall, resolveTokenLimits } from './budget';
import { BudgetExceededError, InputTooLargeError } from './errors';
import { generateStructured, GenerationError } from './structured';

describe('estimateTokens y topes por omisión', () => {
  it('estima por exceso, a 3 caracteres por token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('abcd')).toBe(2);
    expect(estimateTokens('x'.repeat(3000))).toBe(1000);
  });

  it('los valores por omisión son los documentados', () => {
    expect(resolveTokenLimits({}, {})).toEqual({ maxTokens: 16_000, budgetTokens: 200_000, maxInputTokens: 100_000 });
    expect([DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_BUDGET_TOKENS, DEFAULT_MAX_INPUT_TOKENS]).toEqual([16_000, 200_000, 100_000]);
  });

  it('lo explícito gana a la variable de entorno, y esta al valor por omisión', () => {
    const env = { IARK_AI_MAX_TOKENS: '4000', IARK_AI_BUDGET_TOKENS: '50000', IARK_AI_MAX_INPUT_TOKENS: '9000' };
    expect(resolveTokenLimits({}, env)).toEqual({ maxTokens: 4000, budgetTokens: 50_000, maxInputTokens: 9000 });
    expect(resolveTokenLimits({ maxTokens: 123 }, env)).toEqual({ maxTokens: 123, budgetTokens: 50_000, maxInputTokens: 9000 });
  });

  it('rechaza valores que no son enteros positivos, con el nombre de la variable o de la opción', () => {
    expect(() => resolveTokenLimits({}, { IARK_AI_MAX_TOKENS: 'mucho' })).toThrow(/IARK_AI_MAX_TOKENS debe ser un entero positivo/);
    expect(() => resolveTokenLimits({}, { IARK_AI_BUDGET_TOKENS: '0' })).toThrow(/IARK_AI_BUDGET_TOKENS/);
    expect(() => resolveTokenLimits({ budgetTokens: -5 }, {})).toThrow(/--budget-tokens debe ser un entero positivo/);
    expect(() => resolveTokenLimits({ maxInputTokens: 1.5 }, {})).toThrow(GenerationError);
    // Una variable vacía se trata como no definida.
    expect(resolveTokenLimits({}, { IARK_AI_MAX_TOKENS: '  ' }).maxTokens).toBe(16_000);
  });

  it('formatea los miles con punto sin depender de ICU', () => {
    expect([formatTokens(999), formatTokens(16_000), formatTokens(1_234_567)]).toEqual(['999', '16.000', '1.234.567']);
  });
});

describe('planCall', () => {
  const limits = { maxTokens: 1000, budgetTokens: 5000, maxInputTokens: 2000 };
  const zero = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const estimate = (tokens: number) => ({ tokens, parts: { fixedTokens: 100, userTokens: tokens - 100 } });

  it('devuelve el tope por llamada cuando el presupuesto sobra', () => {
    expect(planCall(limits, zero, estimate(500), 0)).toBe(1000);
  });

  it('recorta la salida a lo que queda del presupuesto total', () => {
    expect(planCall(limits, { inputTokens: 2000, outputTokens: 1500, totalTokens: 3500 }, estimate(800), 1)).toBe(700);
  });

  it('rechaza una entrada que supera el máximo, diciendo de dónde sale su tamaño', () => {
    const error = (() => {
      try {
        planCall(limits, zero, estimate(2500), 0);
      } catch (e) {
        return e as InputTooLargeError;
      }
    })();
    expect(error).toBeInstanceOf(InputTooLargeError);
    expect(error?.message).toMatch(/~2\.500 tokens de entrada supera el máximo permitido de 2\.000 \(--max-input-tokens/);
    expect(error?.message).toMatch(/~100 de instrucciones y esquema \(fijos\) y ~2\.400 del mensaje del usuario/);
    expect(error?.message).toMatch(/No se llamó al modelo/);
    expect(error?.estimatedTokens).toBe(2500);
  });

  it('un presupuesto que no alcanza ni para la primera llamada se rechaza sin gastar nada', () => {
    const tight = { ...limits, budgetTokens: 600 };
    expect(() => planCall(tight, zero, estimate(500), 0)).toThrow(BudgetExceededError);
    expect(() => planCall(tight, zero, estimate(500), 0)).toThrow(/no alcanza ni para la entrada estimada de la primera llamada \(~500 tokens\).*gastado: 0 tokens/);
  });

  it('un reintento sin presupuesto informa de lo gastado', () => {
    const spent = { inputTokens: 3000, outputTokens: 1800, totalTokens: 4800 };
    const error = (() => {
      try {
        planCall(limits, spent, estimate(300), 2);
      } catch (e) {
        return e as BudgetExceededError;
      }
    })();
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(error?.message).toMatch(/se agotó tras 2 intento\(s\): gastados 4\.800 tokens \(3\.000 de entrada y 1\.800 de salida\)/);
    expect(error?.spent).toEqual(spent);
    expect(error?.budgetTokens).toBe(5000);
  });

  it('exige una salida mínima útil', () => {
    expect(() => planCall({ ...limits, budgetTokens: 1000 }, zero, estimate(1000 - MIN_OUTPUT_TOKENS + 1), 0)).toThrow(BudgetExceededError);
    expect(planCall({ ...limits, budgetTokens: 1000 }, zero, estimate(1000 - MIN_OUTPUT_TOKENS), 0)).toBe(MIN_OUTPUT_TOKENS);
  });
});

// Los topes aplicados de punta a punta con un proveedor simulado (Foundry compatible con OpenAI y Claude).
const spec: AiSpec<{ nombre: string }> = {
  generationSchema: z.object({ nombre: z.string() }),
  generationJsonSchema: () => ({ type: 'object', properties: { nombre: { type: 'string' } }, required: ['nombre'] }),
  system: () => 'Eres un generador de pruebas.',
  user: (instruction) => `Instrucción: ${instruction}`,
  retry: (issues) => `Corrige: ${issues}`,
  toDocument: (generated) => {
    const g = generated as { nombre: string };
    return g.nombre.trim() ? { ok: true, document: g } : { ok: false, issues: 'nombre vacío' };
  },
};

const reply = (content: string, usage: { prompt_tokens: number; completion_tokens: number }, finish = 'stop') =>
  new Response(JSON.stringify({ model: 'modelo-x', choices: [{ message: { content }, finish_reason: finish }], usage }), { status: 200 });

async function withEnv<T>(fn: () => Promise<T>, extra: Record<string, string> = {}): Promise<T> {
  const env = { AI_BASE_URL: 'https://r.openai.azure.com/openai/v1/', AI_API_KEY: 'k', ...extra };
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}
const sentBody = (fetchMock: ReturnType<typeof vi.fn>, call: number) => JSON.parse((fetchMock.mock.calls[call] as unknown as [string, RequestInit])[1].body as string);
const options = (fetchMock: ReturnType<typeof vi.fn>) => ({ instruction: 'x', defaultModel: 'm', model: 'm', provider: 'openai' as const, fetch: fetchMock as unknown as typeof fetch });

describe('generateStructured: topes de tokens', () => {
  it('envía el tope de salida por llamada (por omisión 16 000; configurable por opción y por IARK_AI_MAX_TOKENS)', async () => {
    const fetchMock = vi.fn(async () => reply('{"nombre":"a"}', { prompt_tokens: 5, completion_tokens: 7 }));
    const normal = await withEnv(() => generateStructured(spec, options(fetchMock)));
    expect(sentBody(fetchMock, 0).max_tokens).toBe(16_000);
    expect(normal.limits).toEqual({ maxTokens: 16_000, budgetTokens: 200_000, maxInputTokens: 100_000 });
    await withEnv(() => generateStructured(spec, { ...options(fetchMock), maxTokens: 2048 }));
    expect(sentBody(fetchMock, 1).max_tokens).toBe(2048);
    await withEnv(() => generateStructured(spec, options(fetchMock)), { IARK_AI_MAX_TOKENS: '3000' });
    expect(sentBody(fetchMock, 2).max_tokens).toBe(3000);
  });

  it('una respuesta cortada por el tope por llamada falla diciendo cuál fue el tope y lo gastado', async () => {
    const fetchMock = vi.fn(async () => reply('{"nombre"', { prompt_tokens: 40, completion_tokens: 500 }, 'length'));
    const error = await withEnv(() => generateStructured(spec, { ...options(fetchMock), maxTokens: 500 })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GenerationError);
    expect(error).not.toBeInstanceOf(BudgetExceededError);
    expect((error as Error).message).toMatch(/límite de tokens de salida \(500, --max-tokens, o IARK_AI_MAX_TOKENS\).*Gastado: 540 tokens/);
  });

  it('el presupuesto total se agota entre intentos: se detiene con un error que informa lo gastado y no hace la llamada', async () => {
    // Cada intento cobra 300 + 50; con 600 de presupuesto el reintento (≈350 de entrada + salida mínima) ya no cabe.
    const fetchMock = vi.fn(async () => reply('{"nombre":" "}', { prompt_tokens: 300, completion_tokens: 50 }));
    const error = await withEnv(() => generateStructured(spec, { ...options(fetchMock), budgetTokens: 700, maxRetries: 5 })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetExceededError);
    const failure = error as BudgetExceededError;
    expect(failure.spent).toEqual({ inputTokens: 300, outputTokens: 50, totalTokens: 350 });
    expect(failure.budgetTokens).toBe(700);
    expect(failure.message).toMatch(/presupuesto de 700 tokens.*se agotó tras 1 intento\(s\): gastados 350 tokens \(300 de entrada y 50 de salida\)/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('recorta max_tokens a lo que queda del presupuesto para no pasarse', async () => {
    const fetchMock = vi.fn(async () => reply('{"nombre":"a"}', { prompt_tokens: 10, completion_tokens: 10 }));
    await withEnv(() => generateStructured(spec, { ...options(fetchMock), budgetTokens: 1500 }));
    const sent = sentBody(fetchMock, 0).max_tokens as number;
    expect(sent).toBeLessThan(1500);
    expect(sent).toBeGreaterThanOrEqual(MIN_OUTPUT_TOKENS);
  });

  it('si el recorte por presupuesto corta la respuesta, lo que se agotó es el presupuesto', async () => {
    const fetchMock = vi.fn(async () => reply('{"nombre"', { prompt_tokens: 100, completion_tokens: 900 }, 'length'));
    const error = await withEnv(() => generateStructured(spec, { ...options(fetchMock), budgetTokens: 1500 })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect((error as Error).message).toMatch(/se agotó durante la respuesta/);
  });

  it('un presupuesto menor que la entrada estimada se rechaza antes de llamar', async () => {
    const fetchMock = vi.fn(async () => reply('{"nombre":"a"}', { prompt_tokens: 1, completion_tokens: 1 }));
    const error = await withEnv(() => generateStructured(spec, { ...options(fetchMock), budgetTokens: 100 })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect((error as Error).message).toMatch(/no alcanza ni para la entrada estimada de la primera llamada/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('una entrada que supera --max-input-tokens se rechaza antes de llamar, sin gastar nada', async () => {
    const fetchMock = vi.fn(async () => reply('{"nombre":"a"}', { prompt_tokens: 1, completion_tokens: 1 }));
    const error = await withEnv(() => generateStructured(spec, { ...options(fetchMock), instruction: 'palabra '.repeat(4000), maxInputTokens: 5000 })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InputTooLargeError);
    expect((error as InputTooLargeError).parts.userTokens).toBeGreaterThan(5000 - (error as InputTooLargeError).parts.fixedTokens);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('el reintento también comprueba la entrada, que crece con la conversación', async () => {
    // La primera entrada cabe (el uso informado es de 4 000 tokens), pero con la respuesta y la corrección ya no cabe en 4 100.
    const fetchMock = vi.fn(async () => reply('{"nombre":" "}', { prompt_tokens: 4000, completion_tokens: 300 }));
    const error = await withEnv(() => generateStructured(spec, { ...options(fetchMock), maxInputTokens: 4100, maxRetries: 3 })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InputTooLargeError);
    expect((error as Error).message).toMatch(/El reintento 1 \(la conversación crece con cada intento\)/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('el resultado trae los topes y el uso por intento, que suma los totales', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply('{"nombre":" "}', { prompt_tokens: 120, completion_tokens: 30 }))
      .mockResolvedValueOnce(reply('{"nombre":"ok"}', { prompt_tokens: 190, completion_tokens: 40 }));
    const result = await withEnv(() => generateStructured(spec, { ...options(fetchMock), budgetTokens: 10_000 }));
    expect(result.attemptLog.map((a) => [a.inputTokens, a.outputTokens])).toEqual([
      [120, 30],
      [190, 40],
    ]);
    expect(result.usage).toEqual({ inputTokens: 310, outputTokens: 70 });
    expect(result.limits.budgetTokens).toBe(10_000);
  });

  it('un valor inválido en las opciones falla antes de llamar', async () => {
    const fetchMock = vi.fn();
    await expect(withEnv(() => generateStructured(spec, { ...options(fetchMock), maxTokens: 0 }))).rejects.toThrow(/--max-tokens debe ser un entero positivo/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('generateStructured con Claude: los topes llegan a la API', () => {
  it('max_tokens de la llamada es el recortado por el presupuesto', async () => {
    const parse = vi.fn(async (params: { output_config: { format: { parse: (c: string) => unknown } } }) => ({
      model: 'claude-x',
      stop_reason: 'end_turn',
      parsed_output: params.output_config.format.parse('{"nombre":"a"}'),
      content: [{ type: 'text', text: '{"nombre":"a"}' }],
      usage: { input_tokens: 10, output_tokens: 10 },
    }));
    const client = { beta: { messages: { parse } } } as unknown as Anthropic;
    await generateStructured(spec, { instruction: 'x', defaultModel: 'm', client, budgetTokens: 1500 });
    const sent = (parse.mock.calls[0][0] as unknown as { max_tokens: number }).max_tokens;
    expect(sent).toBeLessThan(1500);
    expect(sent).toBeGreaterThanOrEqual(MIN_OUTPUT_TOKENS);
    await generateStructured(spec, { instruction: 'x', defaultModel: 'm', client });
    expect((parse.mock.calls[1][0] as unknown as { max_tokens: number }).max_tokens).toBe(16_000);
  });
});
