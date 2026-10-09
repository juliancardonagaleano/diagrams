import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StructuredOptions } from '@iark/kernel';
import { createDefaultRegistry } from './registry';
import { buildProgram } from './main';

// `iark generate --module <otro>` (genericGenerate) no puede llamar a un modelo de verdad: `generateStructured` se sustituye por un
// espía que anota con qué opciones se le llamó. La constante del modelo por defecto se cambia por un valor distinto del real
// para que la prueba demuestre que el valor sale de `DEFAULT_AI_MODEL` y no de un literal repetido en el CLI.
const { SENTINELA, llamadas } = vi.hoisted(() => ({ SENTINELA: 'modelo-de-la-constante', llamadas: [] as Array<{ defaultModel: string; model?: string }> }));

vi.mock('@iark/kernel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@iark/kernel')>();
  return {
    ...actual,
    generateStructured: async (_spec: unknown, options: StructuredOptions<unknown>) => {
      llamadas.push({ defaultModel: options.defaultModel, model: options.model });
      return {
        document: { generado: true },
        model: options.model ?? options.defaultModel,
        provider: 'anthropic',
        attempts: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
        issues: [],
        repaired: false,
        retries: { schema: 0, rules: 0 },
        attemptLog: [{ attempt: 1, trigger: 'initial', outcome: 'valid', inputTokens: 1, outputTokens: 1 }],
        verification: 'passed',
        limits: { maxTokens: 16000, budgetTokens: 200000, maxInputTokens: 100000 },
      };
    },
  };
});
vi.mock('@core/ai/generate', async (importOriginal) => ({ ...(await importOriginal<typeof import('@core/ai/generate')>()), DEFAULT_AI_MODEL: SENTINELA }));

const registry = createDefaultRegistry();
const conIa = registry.list().filter((m) => m.id !== 'c4' && m.ai);

describe('generate --module <otro>: modelo por defecto', () => {
  beforeEach(() => {
    llamadas.length = 0;
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it('la prueba cubre todos los módulos de la suite con IA salvo c4', () => {
    expect(conIa.map((m) => m.id).sort()).toEqual(['data', 'enterprise', 'integration', 'platform', 'security']);
  });

  it('el valor sentinela no coincide con el modelo real (si no, la prueba no probaría nada)', async () => {
    const real = (await vi.importActual<typeof import('@core/ai/generate')>('@core/ai/generate')).DEFAULT_AI_MODEL;
    expect(real).not.toBe(SENTINELA);
  });

  for (const id of ['data', 'enterprise', 'integration', 'platform', 'security']) {
    it(`--module ${id} sin --model usa DEFAULT_AI_MODEL como modelo por defecto`, async () => {
      await buildProgram(registry).parseAsync(['node', 'iark', 'generate', 'Un sistema de ejemplo', '--module', id, '--provider', 'anthropic']);
      expect(llamadas).toEqual([{ defaultModel: SENTINELA, model: undefined }]);
    });
  }

  it('un --model explícito gana, y el modelo por defecto sigue saliendo de la constante', async () => {
    await buildProgram(registry).parseAsync(['node', 'iark', 'generate', 'Un sistema de ejemplo', '--module', 'data', '--model', 'mi-despliegue']);
    expect(llamadas).toEqual([{ defaultModel: SENTINELA, model: 'mi-despliegue' }]);
  });
});
