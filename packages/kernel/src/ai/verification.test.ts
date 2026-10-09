import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AiSpec, ModuleIssue } from '../module/types';
import { VerificationError } from './errors';
import { generateStructured, GenerationError } from './structured';

// Bucle de verificación: tras pasar el esquema, el documento pasa por `validate()` del módulo y sus errores se le devuelven al modelo.

interface Doc {
  nombre: string;
  items: string[];
}

const schema = z.object({ nombre: z.string(), items: z.array(z.string()) });

const spec: AiSpec<Doc> = {
  generationSchema: schema,
  generationJsonSchema: () => ({ type: 'object', properties: { nombre: { type: 'string' }, items: { type: 'array', items: { type: 'string' } } }, required: ['nombre', 'items'] }),
  system: () => 'Eres un generador de pruebas.',
  user: (instruction, base) => `Instrucción: ${instruction}${base ? `\nBase: ${base.nombre}` : ''}`,
  retry: (issues) => `Corrige: ${issues}`,
  toDocument: (generated) => ({ ok: true, document: generated as Doc }),
};

/** Regla de ejemplo: error si hay un elemento repetido, aviso si no hay elementos, nota si hay muchos. */
const rules = vi.fn((doc: Doc): ModuleIssue[] => {
  const issues: ModuleIssue[] = [];
  for (const item of doc.items) if (doc.items.indexOf(item) !== doc.items.lastIndexOf(item)) issues.push({ severity: 'error', message: `El elemento «${item}» está repetido`, elementId: item });
  if (doc.items.length === 0) issues.push({ severity: 'warning', message: 'No hay elementos' });
  if (doc.items.length > 3) issues.push({ severity: 'info', message: 'Hay muchos elementos' });
  return issues;
});

const env = { AI_BASE_URL: 'https://r.openai.azure.com/openai/v1/', AI_API_KEY: 'k' };
const reply = (content: string, usage = { prompt_tokens: 10, completion_tokens: 20 }, finish = 'stop') =>
  new Response(JSON.stringify({ model: 'modelo-x', choices: [{ message: { content }, finish_reason: finish }], usage }), { status: 200 });
const json = (doc: unknown) => JSON.stringify(doc);

async function withEnv<T>(fn: () => Promise<T>): Promise<T> {
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

const run = (replies: Response[], options: Partial<Parameters<typeof generateStructured<Doc>>[1]> = {}) => {
  const fetchMock = vi.fn(async () => replies.shift() ?? reply('{}'));
  const promise = withEnv(() => generateStructured(spec, { instruction: 'x', defaultModel: 'm', provider: 'openai', model: 'm', validate: rules, fetch: fetchMock as unknown as typeof fetch, ...options }));
  return { fetchMock, promise };
};
const bodyOf = (fetchMock: ReturnType<typeof vi.fn>, call: number) => JSON.parse((fetchMock.mock.calls[call] as unknown as [string, RequestInit])[1].body as string);

describe('generateStructured: verificación con validate()', () => {
  it('un documento que pasa el esquema y las reglas no reintenta y devuelve avisos y notas', async () => {
    const { fetchMock, promise } = run([reply(json({ nombre: 'a', items: [] }))]);
    const result = await promise;
    expect(result.attempts).toBe(1);
    expect(result.repaired).toBe(false);
    expect(result.verification).toBe('passed');
    expect(result.retries).toEqual({ schema: 0, rules: 0 });
    expect(result.issues).toEqual([{ severity: 'warning', message: 'No hay elementos' }]);
    expect(result.attemptLog).toEqual([{ attempt: 1, trigger: 'initial', outcome: 'valid', inputTokens: 10, outputTokens: 20 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('los avisos y las notas no reintentan, pero se devuelven en issues', async () => {
    const { fetchMock, promise } = run([reply(json({ nombre: 'a', items: ['1', '2', '3', '4'] }))]);
    const result = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.issues).toEqual([{ severity: 'info', message: 'Hay muchos elementos' }]);
  });

  it('los errores de reglas se devuelven al modelo con su texto y su elemento, y el reintento los corrige', async () => {
    const { fetchMock, promise } = run([reply(json({ nombre: 'a', items: ['x', 'x'] })), reply(json({ nombre: 'a', items: ['x', 'y'] }))]);
    const result = await promise;
    expect(result.attempts).toBe(2);
    expect(result.repaired).toBe(true);
    expect(result.retries).toEqual({ schema: 0, rules: 1 });
    expect(result.document.items).toEqual(['x', 'y']);
    const feedback = bodyOf(fetchMock, 1).messages.at(-1) as { role: string; content: string };
    expect(feedback.role).toBe('user');
    expect(feedback.content).toBe('Corrige: - [error] El elemento «x» está repetido (elemento «x»)\n- [error] El elemento «x» está repetido (elemento «x»)');
    // Los tokens se suman y se desglosan por intento, con el motivo de cada uno.
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 40 });
    expect(result.attemptLog.map((a) => [a.attempt, a.trigger, a.outcome])).toEqual([
      [1, 'initial', 'rules'],
      [2, 'rules', 'valid'],
    ]);
  });

  it('desglosa los reintentos por esquema y por reglas', async () => {
    const { promise } = run([reply('no es json'), reply(json({ nombre: 'a', items: ['x', 'x'] })), reply(json({ nombre: 'a', items: ['x'] }))], { maxRetries: 3 });
    const result = await promise;
    expect(result.attempts).toBe(3);
    expect(result.retries).toEqual({ schema: 1, rules: 1 });
    expect(result.attemptLog.map((a) => `${a.trigger}>${a.outcome}`)).toEqual(['initial>schema', 'schema>rules', 'rules>valid']);
  });

  it('tras agotar los reintentos falla con el informe de incidencias (VerificationError)', async () => {
    const { fetchMock, promise } = run([reply(json({ nombre: 'a', items: ['x', 'x'] })), reply(json({ nombre: 'a', items: ['y', 'y'] }))]);
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VerificationError);
    expect(error).toBeInstanceOf(GenerationError);
    const failure = error as VerificationError;
    expect(failure.message).toMatch(/no produjo un documento que cumpla las reglas del módulo tras 2 intentos:\n- \[error\] El elemento «y» está repetido/);
    expect(failure.issues.map((i) => i.elementId)).toEqual(['y', 'y']);
    expect(failure.attempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('allowInvalid acepta el último documento con errores de reglas, marcado, con sus errores en issues', async () => {
    const { promise } = run([reply(json({ nombre: 'a', items: ['x', 'x'] })), reply(json({ nombre: 'a', items: ['y', 'y'] }))], { allowInvalid: true });
    const result = await promise;
    expect(result.verification).toBe('accepted-invalid');
    expect(result.document.items).toEqual(['y', 'y']);
    expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(2);
    expect(result.attempts).toBe(2);
    expect(result.repaired).toBe(true);
  });

  it('allowInvalid no salva a un documento que nunca cumplió el esquema', async () => {
    const { promise } = run([reply('no es json'), reply('{"nombre":1}')], { allowInvalid: true });
    await expect(promise).rejects.toThrow(/no produjo un documento válido tras 2 intentos/);
  });

  it('allowInvalid devuelve el último documento que cumplió el esquema aunque el siguiente intento lo incumpla', async () => {
    const { promise } = run([reply(json({ nombre: 'a', items: ['x', 'x'] })), reply('no es json')], { allowInvalid: true });
    const result = await promise;
    expect(result.document.items).toEqual(['x', 'x']);
    expect(result.verification).toBe('accepted-invalid');
  });

  it('verify: false (--no-verify) no llama a validate ni reintenta por reglas', async () => {
    rules.mockClear();
    const { fetchMock, promise } = run([reply(json({ nombre: 'a', items: ['x', 'x'] }))], { verify: false });
    const result = await promise;
    expect(rules).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ verification: 'skipped', issues: [], repaired: false });
  });

  it('sin validate (un módulo o plugin que no lo aporta) se comporta como antes', async () => {
    const fetchMock = vi.fn(async () => reply(json({ nombre: 'a', items: ['x', 'x'] })));
    const result = await withEnv(() => generateStructured(spec, { instruction: 'x', defaultModel: 'm', provider: 'openai', fetch: fetchMock as unknown as typeof fetch }));
    expect(result.verification).toBe('skipped');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('al refinar, los errores que ya tenía el documento base no bloquean; solo los nuevos', async () => {
    const base: Doc = { nombre: 'base', items: ['z', 'z'] };
    // El modelo conserva el error heredado (z repetido) y no añade ninguno: se acepta, y el error heredado sigue visible en issues.
    const { fetchMock, promise } = run([reply(json({ nombre: 'base', items: ['z', 'z', 'n'] }))], { base });
    const result = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.verification).toBe('passed');
    expect(result.issues.map((i) => i.severity)).toEqual(['error', 'error']);

    // Si introduce un error nuevo, sí se le pide corregirlo.
    const second = run([reply(json({ nombre: 'base', items: ['z', 'z', 'n', 'n'] })), reply(json({ nombre: 'base', items: ['z', 'z', 'n'] }))], { base });
    const refined = await second.promise;
    expect(refined.attempts).toBe(2);
    expect(bodyOf(second.fetchMock, 1).messages.at(-1).content).toContain('«n»');
  });

  it('con retryOn: warning (--strict) los avisos también obligan a corregir', async () => {
    const { fetchMock, promise } = run([reply(json({ nombre: 'a', items: [] })), reply(json({ nombre: 'a', items: ['x'] }))], { retryOn: 'warning' });
    const result = await promise;
    expect(result.attempts).toBe(2);
    expect(result.retries).toEqual({ schema: 0, rules: 1 });
    expect(bodyOf(fetchMock, 1).messages.at(-1).content).toBe('Corrige: - [warning] No hay elementos');
    // Y agotados los reintentos, un aviso sin corregir hace fallar igual que un error.
    const failing = run([reply(json({ nombre: 'a', items: [] })), reply(json({ nombre: 'a', items: [] }))], { retryOn: 'warning' });
    await expect(failing.promise).rejects.toBeInstanceOf(VerificationError);
  });

  it('un validate que lanza se informa como GenerationError, no como error inesperado', async () => {
    const { promise } = run([reply(json({ nombre: 'a', items: [] }))], {
      validate: () => {
        throw new Error('regla rota');
      },
    });
    await expect(promise).rejects.toThrow(/Las reglas del módulo fallaron al validar el documento: regla rota/);
  });

  it('informa del progreso de cada corrección', async () => {
    const progress: string[] = [];
    const { promise } = run([reply(json({ nombre: 'a', items: ['x', 'x'] })), reply(json({ nombre: 'a', items: ['x'] }))], { onProgress: (m) => progress.push(m) });
    await promise;
    expect(progress).toEqual(['Consultando a m…', 'El modelo incumple 2 regla(s) del módulo.', 'Reintento 1: corrigiendo las reglas del módulo…', 'Modelo válido.']);
  });
});

// El mismo bucle con Claude (API de Anthropic y Foundry): el SDK real LANZA si la respuesta se corta o no cumple el esquema (se
// pierden el texto y los tokens), así que el cliente recibe un `parse` que devuelve el texto y el esquema se comprueba aquí.
function fakeClaude(texts: Array<{ text: string; stop?: string; usage?: { input_tokens: number; output_tokens: number } }>) {
  /** Los mensajes tal como iban en cada llamada (el cliente real los serializa al enviar; el código sigue añadiendo después). */
  const sent: Array<Array<{ role: string; content: unknown }>> = [];
  const create = vi.fn(async (params: { messages: Array<{ role: string; content: unknown }>; output_config: { format: { parse: (content: string) => unknown } } }) => {
    sent.push(JSON.parse(JSON.stringify(params.messages)));
    const next = texts.shift() ?? { text: '{}' };
    return {
      model: 'claude-x',
      stop_reason: next.stop ?? 'end_turn',
      // Lo que haría el SDK: pasar el texto por el `parse` del formato que se le dio.
      parsed_output: params.output_config.format.parse(next.text),
      content: [{ type: 'text', text: next.text }],
      usage: next.usage ?? { input_tokens: 100, output_tokens: 200 },
    };
  });
  return { client: { beta: { messages: { parse: create } } } as unknown as Anthropic, parse: create, sent };
}

describe.each(['anthropic', 'foundry'] as const)('generateStructured con Claude (%s): bucle de verificación', (provider) => {
  it('reintenta por reglas con la corrección como último mensaje de usuario', async () => {
    const { client, sent } = fakeClaude([{ text: json({ nombre: 'a', items: ['x', 'x'] }) }, { text: json({ nombre: 'a', items: ['x'] }) }]);
    const result = await generateStructured(spec, { instruction: 'x', defaultModel: 'm', client, provider, validate: rules });
    expect(result.attempts).toBe(2);
    expect(result.retries).toEqual({ schema: 0, rules: 1 });
    expect(result.provider).toBe(provider);
    const second = sent[1];
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(String(second[2].content)).toContain('El elemento «x» está repetido');
  });

  it('una respuesta que incumple el esquema se reintenta (antes el SDK lanzaba y se perdía el intento)', async () => {
    const { client } = fakeClaude([{ text: json({ nombre: 'a' }) }, { text: json({ nombre: 'a', items: [] }) }]);
    const result = await generateStructured(spec, { instruction: 'x', defaultModel: 'm', client, provider });
    expect(result.attempts).toBe(2);
    expect(result.retries).toEqual({ schema: 1, rules: 0 });
  });

  it('una respuesta cortada por max_tokens falla con el tope, no con un error del SDK', async () => {
    const { client } = fakeClaude([{ text: '{"nombre":"a","ite', stop: 'max_tokens' }]);
    await expect(generateStructured(spec, { instruction: 'x', defaultModel: 'm', client, provider })).rejects.toThrow(/límite de tokens de salida \(16\.000, --max-tokens/);
  });

  it('pasa el tope de salida configurado como max_tokens', async () => {
    const { client, parse } = fakeClaude([{ text: json({ nombre: 'a', items: [] }) }]);
    await generateStructured(spec, { instruction: 'x', defaultModel: 'm', client, provider, maxTokens: 1234 });
    expect((parse.mock.calls[0][0] as unknown as { max_tokens: number }).max_tokens).toBe(1234);
  });
});
