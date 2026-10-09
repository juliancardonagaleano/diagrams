import { BudgetExceededError, explainPrompts, GenerationError, generateText, type AiProvider, type Env } from '@iark/kernel';
import { generateDocument } from '@core/ai/generate';
import { c4Module } from '@core/module';
import { sampleDocument } from '@core/model/sample';
import { describe, expect, it } from 'vitest';
import { liveSetupProblem } from '../scripts/evals';

// Prueba REAL de la IA. Se SALTA siempre, salvo que se pida expresamente con IARK_LIVE_AI=1 Y haya credenciales de una plataforma
// (anthropic, foundry u openai-compatible). Tener AI_* definidas, por sí solo, NO la activa: llama a un modelo y gasta tokens
// (del orden de 10 000 a 20 000 en total; ver docs/ia.md, «Prueba real»). Cómo ejecutarla:
//
//   IARK_LIVE_AI=1 npx vitest run tests/ai-live.test.ts
//   IARK_LIVE_AI=1 IARK_LIVE_PROVIDER=openai npx vitest run tests/ai-live.test.ts     # forzar la plataforma
//
// Con las variables ausentes, el CI y `npm test` no la ejecutan (se ven como «skipped»).

type LiveProvider = AiProvider | 'auto';
const PROVIDERS: readonly LiveProvider[] = ['auto', 'anthropic', 'foundry', 'openai'];

/** Si la prueba real debe correr con este entorno, y por qué no. */
function liveGate(env: Env): { enabled: boolean; provider: LiveProvider; reason?: string } {
  const requested = env.IARK_LIVE_PROVIDER || 'auto';
  const provider = (PROVIDERS as readonly string[]).includes(requested) ? (requested as LiveProvider) : 'auto';
  if (env.IARK_LIVE_AI !== '1') return { enabled: false, provider, reason: 'falta IARK_LIVE_AI=1 (la prueba real gasta tokens y hay que pedirla expresamente)' };
  if (!(PROVIDERS as readonly string[]).includes(requested)) return { enabled: false, provider, reason: `IARK_LIVE_PROVIDER=${requested} no es una plataforma (auto, anthropic, foundry u openai)` };
  const problem = liveSetupProblem(provider, env);
  return problem ? { enabled: false, provider, reason: problem } : { enabled: true, provider };
}

describe('puerta de la prueba real (siempre se ejecuta, sin llamar a ningún modelo)', () => {
  const claves: Env = { AI_BASE_URL: 'https://recurso.openai.azure.com/openai/v1', AI_API_KEY: 'k', AI_MODEL: 'm' };

  it('sin IARK_LIVE_AI=1 no se activa, aunque haya credenciales', () => {
    expect(liveGate({})).toMatchObject({ enabled: false });
    expect(liveGate(claves)).toMatchObject({ enabled: false });
    expect(liveGate(claves).reason).toContain('IARK_LIVE_AI=1');
  });

  it('con la petición expresa pero sin credenciales tampoco', () => {
    const gate = liveGate({ IARK_LIVE_AI: '1' });
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toContain('ANTHROPIC_API_KEY');
  });

  it('con la petición expresa y credenciales sí, y respeta la plataforma elegida', () => {
    expect(liveGate({ ...claves, IARK_LIVE_AI: '1' })).toEqual({ enabled: true, provider: 'auto' });
    expect(liveGate({ ...claves, IARK_LIVE_AI: '1', IARK_LIVE_PROVIDER: 'openai' })).toEqual({ enabled: true, provider: 'openai' });
    expect(liveGate({ ...claves, IARK_LIVE_AI: '1', IARK_LIVE_PROVIDER: 'foundry' }).enabled).toBe(false);
    expect(liveGate({ ...claves, IARK_LIVE_AI: '1', IARK_LIVE_PROVIDER: 'otra' }).reason).toContain('no es una plataforma');
  });
});

const gate = liveGate(process.env);
if (!gate.enabled && process.env.IARK_LIVE_AI === '1') console.warn(`Prueba real de la IA omitida: ${gate.reason}`);

describe.skipIf(!gate.enabled)(`IA real (${gate.provider}): bucle de verificación, topes y totales de tokens`, () => {
  const instruction = 'Un blog: los lectores leen artículos en una web React que consulta una API Node.js y una base de datos PostgreSQL.';
  const provider = gate.provider;

  it('genera un documento pequeño, lo verifica con validate() y respeta los topes', async () => {
    const budgetTokens = 60_000;
    const result = await generateDocument({ instruction, provider, maxTokens: 8000, budgetTokens, maxRetries: 2, skipLayout: true });

    // El documento cumple el esquema y las reglas del módulo (sin errores de validate()).
    expect(c4Module.schema.safeParse(result.document).success).toBe(true);
    expect(result.document.model.elements.length).toBeGreaterThanOrEqual(3);
    expect(result.verification).toBe('passed');
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);

    // El bucle: el informe por intento termina bien, y cada reintento tiene su motivo.
    expect(result.attemptLog).toHaveLength(result.attempts);
    expect(result.attemptLog.at(-1)?.outcome).toBe('valid');
    expect(result.retries.schema + result.retries.rules).toBe(result.attempts - 1);
    expect(result.repaired).toBe(result.attempts > 1);

    // Los totales son la suma de los intentos y caben en el presupuesto.
    const input = result.attemptLog.reduce((sum, a) => sum + a.inputTokens, 0);
    const output = result.attemptLog.reduce((sum, a) => sum + a.outputTokens, 0);
    expect(result.usage.inputTokens).toBe(input);
    expect(result.usage.outputTokens).toBe(output);
    expect(input).toBeGreaterThan(0);
    expect(output).toBeGreaterThan(0);
    expect(input + output).toBeLessThanOrEqual(budgetTokens);
    expect(result.limits).toMatchObject({ maxTokens: 8000, budgetTokens });
    console.info(`IA real (${result.provider}, ${result.model}): ${result.attempts} intento(s), ${input} tokens de entrada y ${output} de salida.`);
  }, 240_000);

  it('el tope de salida por llamada corta la respuesta y el error explica qué subir', async () => {
    const llamada = generateDocument({ instruction, provider, maxTokens: 256, budgetTokens: 40_000, maxRetries: 0, skipLayout: true });
    await expect(llamada).rejects.toBeInstanceOf(GenerationError);
    await expect(llamada).rejects.toThrow(/--max-tokens/);
  }, 240_000);

  it('un presupuesto que no alcanza se rechaza antes de llamar al modelo, sin gastar nada', async () => {
    const llamada = generateDocument({ instruction, provider, budgetTokens: 300, skipLayout: true });
    await expect(llamada).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(llamada).rejects.toThrow(/No se llamó al modelo \(gastado: 0 tokens\)/);
  }, 60_000);

  it('explain devuelve prosa dentro del tope de salida y cuenta los tokens', async () => {
    const maxTokens = 700;
    const { system, user } = explainPrompts({ module: c4Module, document: sampleDocument, issues: [] });
    const result = await generateText({ system, user, defaultModel: 'claude-opus-5', provider, maxTokens, budgetTokens: 40_000 });
    expect(result.text.trim().length).toBeGreaterThan(0);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeLessThanOrEqual(maxTokens);
    expect(result.limits.maxTokens).toBe(maxTokens);
  }, 240_000);
});
