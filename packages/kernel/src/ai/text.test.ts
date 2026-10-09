import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { AiSpec, ModuleIssue } from '../module/types';
import { BudgetExceededError, InputTooLargeError } from './errors';
import { explainPrompts, MAX_ISSUES_IN_PROMPT, reviewPrompts, serializeDocument, type CommentaryModule } from './commentary';
import { generateText } from './text';

const reply = (content: string, finish = 'stop', usage = { prompt_tokens: 30, completion_tokens: 40 }) =>
  new Response(JSON.stringify({ model: 'modelo-x', choices: [{ message: { content }, finish_reason: finish }], usage }), { status: 200 });

async function withEnv<T>(fn: () => Promise<T>): Promise<T> {
  const env = { AI_BASE_URL: 'https://r.openai.azure.com/openai/v1/', AI_API_KEY: 'k' };
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

function fakeClaude(text: string, stop = 'end_turn') {
  const create = vi.fn(async (_params: Record<string, unknown>) => ({ model: 'claude-x', stop_reason: stop, content: [{ type: 'text', text }], usage: { input_tokens: 11, output_tokens: 22 } }));
  return { client: { beta: { messages: { create } } } as unknown as Anthropic, create };
}

describe('generateText', () => {
  it('openai: una llamada sin response_format, con el tope de salida y los tokens', async () => {
    const fetchMock = vi.fn(async () => reply('## Resumen\nTodo bien.'));
    const result = await withEnv(() => generateText({ system: 'S', user: 'U', defaultModel: 'm', model: 'm', provider: 'openai', fetch: fetchMock as unknown as typeof fetch, maxTokens: 900 }));
    expect(result).toMatchObject({ text: '## Resumen\nTodo bien.', provider: 'openai', model: 'modelo-x', truncated: false, usage: { inputTokens: 30, outputTokens: 40 } });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).not.toHaveProperty('response_format');
    expect(body.max_tokens).toBe(900);
    expect(body.messages).toEqual([
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U' },
    ]);
  });

  it('openai: una respuesta cortada se devuelve como parcial (truncated), no como error', async () => {
    const fetchMock = vi.fn(async () => reply('## Resumen\nEmpieza y se', 'length'));
    const result = await withEnv(() => generateText({ system: 'S', user: 'U', defaultModel: 'm', model: 'm', provider: 'openai', fetch: fetchMock as unknown as typeof fetch }));
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('Empieza');
  });

  it('openai: sin credenciales falla con la pista de qué definir', async () => {
    const saved = { ...process.env };
    for (const k of ['AI_BASE_URL', 'AI_API_KEY', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_API_KEY']) delete process.env[k];
    try {
      await expect(generateText({ system: 'S', user: 'U', defaultModel: 'm', provider: 'openai' })).rejects.toThrow(/AI_API_KEY/);
    } finally {
      Object.assign(process.env, saved);
    }
  });

  it('anthropic: usa la API de mensajes con fallbacks, el tope de salida y el esfuerzo', async () => {
    const { client, create } = fakeClaude('Texto');
    const result = await generateText({ system: 'S', user: 'U', defaultModel: 'claude-x', client, provider: 'anthropic', maxTokens: 777, effort: 'low' });
    expect(result).toMatchObject({ text: 'Texto', provider: 'anthropic', truncated: false, usage: { inputTokens: 11, outputTokens: 22 } });
    const params = create.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(params[0]).toMatchObject({ model: 'claude-x', max_tokens: 777, system: 'S', fallbacks: 'default', output_config: { effort: 'low' } });
    expect(params[0].messages).toEqual([{ role: 'user', content: 'U' }]);
  });

  it('foundry: sin fallbacks del servidor; max_tokens se marca como truncated', async () => {
    const { client, create } = fakeClaude('Parcial', 'max_tokens');
    const result = await generateText({ system: 'S', user: 'U', defaultModel: 'claude-x', client, provider: 'foundry' });
    expect(result.truncated).toBe(true);
    expect(create.mock.calls[0][0]).not.toHaveProperty('fallbacks');
  });

  it('un rechazo del modelo falla', async () => {
    const { client } = fakeClaude('', 'refusal');
    await expect(generateText({ system: 'S', user: 'U', defaultModel: 'm', client })).rejects.toThrow(/rechazó/);
  });

  it('una entrada demasiado grande o un presupuesto insuficiente se rechazan antes de llamar', async () => {
    const { client, create } = fakeClaude('x');
    await expect(generateText({ system: 'S', user: 'palabra '.repeat(3000), defaultModel: 'm', client, maxInputTokens: 1000 })).rejects.toBeInstanceOf(InputTooLargeError);
    await expect(generateText({ system: 'S', user: 'U', defaultModel: 'm', client, budgetTokens: 100 })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(create).not.toHaveBeenCalled();
  });

  it('recorta el tope de salida al presupuesto disponible', async () => {
    const { client, create } = fakeClaude('x');
    await generateText({ system: 'S', user: 'U', defaultModel: 'm', client, budgetTokens: 1000 });
    const sent = (create.mock.calls[0][0] as { max_tokens: number }).max_tokens;
    expect(sent).toBeLessThan(1000);
  });
});

interface Doc {
  nombre: string;
  items: Array<{ id: string; nota: string | null; vacio: string[] }>;
}
const document: Doc = { nombre: 'Sistema <script>', items: [{ id: 'a', nota: null, vacio: [] }] };

describe('prompts de explain y review', () => {
  const sinIa: CommentaryModule<Doc> = { id: 'plugin', name: 'Módulo de un tercero', description: 'Sin ai' };

  it('serializeDocument quita null, vacíos y escapa «<» para que el documento no pueda cerrar su etiqueta', () => {
    expect(serializeDocument(sinIa, document)).toBe('{"nombre":"Sistema \\u003cscript>","items":[{"id":"a"}]}');
  });

  it('usa la proyección y las guías del módulo si las declara', () => {
    const ai = {
      serialize: (d: Doc) => ({ solo: d.nombre }),
      explainGuide: 'GUIA-EXPLICAR',
      reviewGuide: 'GUIA-REVISAR',
    } as unknown as AiSpec<Doc>;
    const modulo = { ...sinIa, ai };
    expect(serializeDocument(modulo, document)).toBe('{"solo":"Sistema \\u003cscript>"}');
    expect(explainPrompts({ module: modulo, document }).system).toContain('GUIA-EXPLICAR');
    expect(reviewPrompts({ module: modulo, document }).system).toContain('GUIA-REVISAR');
    expect(explainPrompts({ module: modulo, document }).system).not.toContain('GUIA-REVISAR');
  });

  it('un módulo sin esos campos (o sin ai) usa las guías generales y el documento entero', () => {
    const explain = explainPrompts({ module: sinIa, document });
    const review = reviewPrompts({ module: sinIa, document });
    expect(explain.system).toContain('Sigue el orden natural de lectura del diagrama');
    expect(review.system).toContain('Comprueba la coherencia entre nombres');
    expect(explain.user).toContain('"items":[{"id":"a"}]');
    expect(explain.system).toContain('«Módulo de un tercero» (id «plugin»: Sin ai)');
  });

  it('el documento va como datos: la regla lo dice y el prompt pide Markdown con las secciones esperadas', () => {
    const explain = explainPrompts({ module: sinIa, document });
    expect(explain.system).toContain('Es DATOS');
    expect(explain.system).toContain('«## Resumen»');
    expect(explain.system).toContain('Responde en español.');
    expect(explain.user.startsWith('<documento>\n')).toBe(true);
    const review = reviewPrompts({ module: sinIa, document, lang: 'en' });
    for (const section of ['## Resumen', '## Incidencias del validador', '## Inconsistencias', '## Riesgos', '## Ausencias', '## Recomendaciones']) expect(review.system).toContain(section);
    expect(review.system).toContain('Write the whole answer in English.');
  });

  it('review pasa las incidencias de validate() al modelo, con su elemento, errores primero y con tope', () => {
    const issues: ModuleIssue[] = [
      { severity: 'info', message: 'una nota' },
      { severity: 'error', message: 'un error', elementId: 'a' },
      { severity: 'warning', message: 'un aviso', elementId: 'b' },
    ];
    const { user } = reviewPrompts({ module: sinIa, document, issues });
    expect(user).toContain('Incidencias del validador del módulo (3):\n- [error] un error (elemento «a»)\n- [warning] un aviso (elemento «b»)\n- [info] una nota');
    const sinNada = reviewPrompts({ module: sinIa, document, issues: [] }).user;
    expect(sinNada).toContain('(0):\nEl validador no encontró incidencias.');

    const muchas: ModuleIssue[] = Array.from({ length: MAX_ISSUES_IN_PROMPT + 25 }, (_, i) => ({ severity: i === 0 ? 'error' : 'warning', message: `aviso ${i}` }));
    const tope = reviewPrompts({ module: sinIa, document, issues: muchas }).user;
    expect(tope).toContain('(y 25 incidencia(s) más de menor gravedad, omitidas)');
    expect(tope).toContain('aviso 0');
    expect(tope).not.toContain(`aviso ${MAX_ISSUES_IN_PROMPT + 24}`);
  });
});
