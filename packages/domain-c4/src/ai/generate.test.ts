import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { generateDocument, GenerationError } from './generate';
import type { GeneratedDocument } from './generationSchema';
import { standalonePrompt } from './prompt';

const good: GeneratedDocument = {
  workspace: { name: 'Tienda', description: null },
  elements: [
    { id: 'cliente', type: 'person', name: 'Cliente', description: 'Compra', technology: null, external: false, parentId: null, shape: null },
    { id: 'tienda', type: 'softwareSystem', name: 'Tienda en línea', description: 'Vende', technology: null, external: false, parentId: null, shape: null },
    { id: 'web', type: 'container', name: 'Web', description: null, technology: 'React', external: false, parentId: 'tienda', shape: 'browser' },
    { id: 'api', type: 'container', name: 'API', description: null, technology: 'Node.js', external: false, parentId: 'tienda', shape: null },
    { id: 'db', type: 'container', name: 'BD', description: null, technology: 'PostgreSQL', external: false, parentId: 'tienda', shape: 'database' },
    { id: 'pagos', type: 'softwareSystem', name: 'Pasarela de pagos', description: null, technology: null, external: true, parentId: null, shape: null },
  ],
  relationships: [
    { id: 'r1', sourceId: 'cliente', targetId: 'web', description: 'Usa', technology: 'HTTPS' },
    { id: 'r2', sourceId: 'web', targetId: 'api', description: 'Llama', technology: 'JSON/HTTPS' },
    { id: 'r3', sourceId: 'api', targetId: 'db', description: 'Lee y escribe', technology: 'SQL' },
    { id: 'r4', sourceId: 'api', targetId: 'pagos', description: 'Cobra con', technology: 'HTTPS' },
  ],
  views: [
    { id: 'ctx', type: 'systemContext', scopeId: 'tienda', title: 'Contexto', elementIds: ['cliente', 'tienda', 'pagos'] },
    { id: 'cont', type: 'container', scopeId: 'tienda', title: 'Contenedores', elementIds: ['cliente', 'web', 'api', 'db', 'pagos', 'tienda'] },
  ],
};

const bad: GeneratedDocument = {
  ...good,
  relationships: [...good.relationships, { id: 'rx', sourceId: 'api', targetId: 'nope', description: null, technology: null }],
};

function fakeClient(outputs: Array<GeneratedDocument | null>, stopReason = 'end_turn'): Anthropic {
  const parse = vi.fn(async () => {
    const parsed = outputs.shift() ?? null;
    return {
      model: 'claude-opus-5',
      stop_reason: stopReason,
      parsed_output: parsed,
      content: [{ type: 'text', text: JSON.stringify(parsed) }],
      usage: { input_tokens: 100, output_tokens: 200 },
    };
  });
  return { beta: { messages: { parse } } } as unknown as Anthropic;
}

describe('generateDocument', () => {
  it('convierte la salida estructurada en un documento con autolayout', async () => {
    const client = fakeClient([good]);
    const r = await generateDocument({ instruction: 'Una tienda en línea', client });
    expect(r.attempts).toBe(1);
    expect(r.document.model.elements).toHaveLength(6);
    expect(r.document.views).toHaveLength(2);
    // El scope no se incluye como elemento de su propia vista de contenedores.
    const cont = r.document.views.find((v) => v.id === 'cont')!;
    expect(cont.elements.map((e) => e.id)).not.toContain('tienda');
    // ...pero en la vista de contexto el sistema sí es un nodo y se conserva.
    const ctx = r.document.views.find((v) => v.id === 'ctx')!;
    expect(ctx.elements.map((e) => e.id).sort()).toEqual(['cliente', 'pagos', 'tienda']);
    // Autolayout aplicado
    for (const v of r.document.views) for (const e of v.elements) expect(e.x).toBeTypeOf('number');
    expect(r.usage.inputTokens).toBe(100);
  });

  it('reintenta si la vista de contexto omite su propio sistema', async () => {
    const sinSistema: GeneratedDocument = {
      ...good,
      views: good.views.map((v) => (v.id === 'ctx' ? { ...v, elementIds: ['cliente', 'pagos'] } : v)),
    };
    const client = fakeClient([sinSistema, good]);
    const r = await generateDocument({ instruction: 'Una tienda', client, skipLayout: true });
    expect(r.attempts).toBe(2);
    const parse = (client.beta.messages.parse as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const secondMessages = (parse[1][0] as { messages: Array<{ role: string; content: unknown }> }).messages;
    expect(String(secondMessages[2].content)).toMatch(/debe incluir su alcance "tienda"/);
    expect(r.document.views.find((v) => v.id === 'ctx')!.elements.map((e) => e.id)).toContain('tienda');
  });

  it('reintenta con los errores de validación y luego acepta', async () => {
    const client = fakeClient([bad, good]);
    const r = await generateDocument({ instruction: 'Una tienda', client, skipLayout: true });
    expect(r.attempts).toBe(2);
    const parse = (client.beta.messages.parse as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const secondMessages = (parse[1][0] as { messages: Array<{ role: string; content: unknown }> }).messages;
    expect(secondMessages.length).toBeGreaterThanOrEqual(3);
    expect(secondMessages[2].role).toBe('user');
    expect(String(secondMessages[2].content)).toMatch(/destino inexistente/);
  });

  it('falla tras agotar los reintentos', async () => {
    const client = fakeClient([bad, bad]);
    await expect(generateDocument({ instruction: 'x', client, maxRetries: 1 })).rejects.toThrow(GenerationError);
  });

  it('informa de un rechazo', async () => {
    const client = fakeClient([good], 'refusal');
    await expect(generateDocument({ instruction: 'x', client })).rejects.toThrow(/rechazó/);
  });

  it('usa el modelo por defecto y salida estructurada', async () => {
    const client = fakeClient([good]);
    await generateDocument({ instruction: 'x', client, provider: 'anthropic', skipLayout: true, effort: 'high' });
    const params = (client.beta.messages.parse as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(params.model).toBe('claude-opus-5');
    expect(params.fallbacks).toBe('default');
    expect((params.output_config as Record<string, unknown>).effort).toBe('high');
    expect((params.output_config as { format: { type: string } }).format.type).toBe('json_schema');
  });

  it('en Foundry no envía fallbacks ni betas del servidor y usa el despliegue indicado', async () => {
    const client = fakeClient([good]);
    const r = await generateDocument({ instruction: 'x', client, provider: 'foundry', model: 'mi-despliegue', skipLayout: true });
    const params = (client.beta.messages.parse as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(params.model).toBe('mi-despliegue');
    expect(params).not.toHaveProperty('fallbacks');
    expect(params).not.toHaveProperty('betas');
    expect((params.output_config as { format: { type: string } }).format.type).toBe('json_schema');
    expect(r.provider).toBe('foundry');
  });
});

describe('generateDocument: verificación con las reglas del módulo C4 (validate)', () => {
  // Cumple el esquema y la conversión, pero la vista de contenedores no tiene alcance: es un error de `validate()` (analyzeDocument).
  const sinAlcance: GeneratedDocument = { ...good, views: good.views.map((v) => (v.id === 'cont' ? { ...v, scopeId: null } : v)) };
  const parseCalls = (client: Anthropic) => (client.beta.messages.parse as unknown as ReturnType<typeof vi.fn>).mock.calls;

  it('un error de reglas se devuelve al modelo con su texto y el reintento lo corrige', async () => {
    const client = fakeClient([sinAlcance, good]);
    const r = await generateDocument({ instruction: 'Una tienda', client, skipLayout: true });
    expect(r.attempts).toBe(2);
    expect(r.repaired).toBe(true);
    expect(r.retries).toEqual({ schema: 0, rules: 1 });
    expect(r.verification).toBe('passed');
    const second = (parseCalls(client)[1][0] as { messages: Array<{ role: string; content: unknown }> }).messages;
    expect(String(second[2].content)).toMatch(/\[error\] La vista "Contenedores" \(container\) necesita un alcance/);
    // Los avisos (elementos sin descripción, por ejemplo) no reintentan: salen en issues.
    expect(r.issues.length).toBeGreaterThan(0);
    expect(r.issues.every((i) => i.severity !== 'error')).toBe(true);
  });

  it('tras agotar los reintentos falla con el informe, y --allow-invalid lo acepta marcado', async () => {
    await expect(generateDocument({ instruction: 'x', client: fakeClient([sinAlcance, sinAlcance]), skipLayout: true })).rejects.toThrow(/no produjo un documento que cumpla las reglas del módulo tras 2 intentos:\n- \[error\] La vista "Contenedores"/);
    const r = await generateDocument({ instruction: 'x', client: fakeClient([sinAlcance, sinAlcance]), skipLayout: true, allowInvalid: true });
    expect(r.verification).toBe('accepted-invalid');
    expect(r.issues.some((i) => i.severity === 'error')).toBe(true);
  });

  it('verify: false (--no-verify) acepta el documento sin pasar por las reglas', async () => {
    const client = fakeClient([sinAlcance]);
    const r = await generateDocument({ instruction: 'x', client, skipLayout: true, verify: false });
    expect(r.attempts).toBe(1);
    expect(r.verification).toBe('skipped');
    expect(r.issues).toEqual([]);
  });

  it('un documento correcto no reintenta y devuelve el desglose de intentos con sus tokens', async () => {
    const r = await generateDocument({ instruction: 'x', client: fakeClient([good]), skipLayout: true });
    expect(r.repaired).toBe(false);
    expect(r.attemptLog).toEqual([{ attempt: 1, trigger: 'initial', outcome: 'valid', inputTokens: 100, outputTokens: 200 }]);
  });
});

describe('generateDocument con un modelo de Foundry compatible con OpenAI', () => {
  const ALL = ['AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_MODEL'];
  const env: Record<string, string> = { AI_BASE_URL: 'https://r.openai.azure.com/openai/v1', AI_API_KEY: 'k', AI_MODEL: 'DeepSeek-V4-Pro' };
  // Entorno hermético: solo las variables indicadas, sin las que traiga la sesión.
  const withEnv = async <T>(fn: () => Promise<T>, vars: Record<string, string> = env): Promise<T> => {
    const saved = Object.fromEntries(ALL.map((k) => [k, process.env[k]]));
    for (const k of ALL) delete process.env[k];
    Object.assign(process.env, vars);
    try {
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
  const answer = (content: string) =>
    new Response(JSON.stringify({ model: 'DeepSeek-V4-Pro', choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 80 } }), { status: 200 });

  it('genera el documento aunque el modelo envuelva el JSON en texto y razonamiento', async () => {
    const fetchMock = vi.fn(async () => answer(`<think>voy a pensar</think>Aquí está:\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\``));
    const r = await withEnv(() => generateDocument({ instruction: 'Una tienda', provider: 'openai', fetch: fetchMock as unknown as typeof fetch }));
    expect(r.provider).toBe('openai');
    expect(r.model).toBe('DeepSeek-V4-Pro');
    expect(r.document.model.elements).toHaveLength(6);
    expect(r.usage).toEqual({ inputTokens: 50, outputTokens: 80 });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.model).toBe('DeepSeek-V4-Pro');
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('JSON Schema');
  });

  it('reintenta cuando el JSON es ilegible o incumple el esquema y luego acepta', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(answer('esto no es JSON'))
      .mockResolvedValueOnce(answer(JSON.stringify({ workspace: { name: 'x' } })))
      .mockResolvedValueOnce(answer(JSON.stringify(good)));
    const r = await withEnv(() => generateDocument({ instruction: 'x', provider: 'openai', maxRetries: 2, skipLayout: true, fetch: fetchMock as unknown as typeof fetch }));
    expect(r.attempts).toBe(3);
    const third = JSON.parse((fetchMock.mock.calls[2] as unknown as [string, RequestInit])[1].body as string);
    expect(third.messages.at(-1).content).toContain('validación');
  });

  it('sin credenciales da un mensaje claro y con 401 también', async () => {
    await expect(withEnv(() => generateDocument({ instruction: 'x', provider: 'openai', model: 'm' }), {})).rejects.toThrow(/AI_API_KEY/);
    const fetchMock = vi.fn(async () => new Response('denied', { status: 401 }));
    await expect(withEnv(() => generateDocument({ instruction: 'x', provider: 'openai', fetch: fetchMock as unknown as typeof fetch }))).rejects.toThrow(/Credenciales/);
  });

  it('informa si la respuesta se corta por límite de tokens', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{' }, finish_reason: 'length' }] }), { status: 200 }));
    await expect(withEnv(() => generateDocument({ instruction: 'x', provider: 'openai', fetch: fetchMock as unknown as typeof fetch }))).rejects.toThrow(/límite de tokens/);
  });
});

describe('standalonePrompt', () => {
  it('incluye reglas, esquema e instrucción', () => {
    const p = standalonePrompt('Un sistema de reservas');
    expect(p).toContain('modelo C4');
    expect(p).toContain('"$schema"');
    expect(p).toContain('Un sistema de reservas');
  });
});
