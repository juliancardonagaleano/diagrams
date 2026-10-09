import type { ModuleRegistry } from '@iark/kernel';
import { vi } from 'vitest';
import { run } from '../../src/cli/main';

/**
 * Ayudas de las pruebas que ejercitan el CLI de IA sin un modelo real: un servicio compatible con Chat Completions simulado
 * (sustituye a `fetch`), un entorno hermético (sin las credenciales ni los topes que traiga la sesión) y la ejecución del CLI en
 * el propio proceso con su salida capturada. Ninguna llama a la red.
 */

export interface SimulatedReply {
  content: string;
  /** `stop` por omisión; `length` simula una respuesta cortada por el tope de salida. */
  finish?: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export interface SimulatedCall {
  url: string;
  /** Cuerpo de la petición ya interpretado (`model`, `messages`, `max_tokens`…). */
  body: { model: string; max_tokens?: number; messages: Array<{ role: string; content: string }>; response_format?: unknown };
}

/** Un `fetch` que responde con las respuestas dadas, en orden (la última se repite si faltan), y anota cada llamada. */
export function simulateChat(replies: Array<string | SimulatedReply>): { calls: SimulatedCall[]; fetch: typeof fetch } {
  const calls: SimulatedCall[] = [];
  const queue = replies.map((r) => (typeof r === 'string' ? { content: r } : r));
  const answer = async (input: unknown, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) });
    const reply = (queue.length > 1 ? queue.shift() : queue[0]) as SimulatedReply;
    return new Response(
      JSON.stringify({
        model: 'modelo-simulado',
        choices: [{ message: { content: reply.content }, finish_reason: reply.finish ?? 'stop' }],
        usage: reply.usage ?? { prompt_tokens: 120, completion_tokens: 80 },
      }),
      { status: 200 },
    );
  };
  return { calls, fetch: vi.fn(answer) as unknown as typeof fetch };
}

const MODEL_ENV = [
  'AI_BASE_URL',
  'AI_API_KEY',
  'AI_MODEL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_FOUNDRY_MODEL',
  'IARK_AI_MAX_TOKENS',
  'IARK_AI_BUDGET_TOKENS',
  'IARK_AI_MAX_INPUT_TOKENS',
];

/** Ejecuta `fn` con un entorno hermético: sin credenciales ni topes de la sesión, y, con `credentials`, las del servicio simulado. */
export async function withModelEnv<T>(fn: () => Promise<T>, options: { credentials?: boolean; env?: Record<string, string> } = {}): Promise<T> {
  const saved = Object.fromEntries(MODEL_ENV.map((k) => [k, process.env[k]]));
  for (const k of MODEL_ENV) delete process.env[k];
  if (options.credentials !== false) Object.assign(process.env, { AI_BASE_URL: 'https://recurso.openai.azure.com/openai/v1', AI_API_KEY: 'clave-de-prueba', AI_MODEL: 'modelo-prueba' });
  Object.assign(process.env, options.env);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

export interface CliRun {
  stdout: string;
  stderr: string;
  /** Código de salida que dejó `run` (`0` si no tocó `process.exitCode`). */
  exitCode: number;
}

/** Ejecuta `iark <args>` en este proceso (con `fetch` sustituido por `model` y, si se da, otro registro de módulos) y devuelve lo que escribió y su código de salida. */
export async function runCli(args: string[], model?: { fetch: typeof fetch }, registry?: ModuleRegistry): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => (out.push(String(chunk)), true)) as never);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => (err.push(String(chunk)), true)) as never);
  if (model) vi.stubGlobal('fetch', model.fetch);
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    await run(['node', 'iark', ...args], registry);
    return { stdout: out.join(''), stderr: err.join(''), exitCode: Number(process.exitCode ?? 0) };
  } finally {
    process.exitCode = previous;
    stdout.mockRestore();
    stderr.mockRestore();
    if (model) vi.unstubAllGlobals();
  }
}

/** Respuesta C4 sin coordenadas, válida y sin errores de reglas (solo avisos): lo que devolvería un modelo bien. */
export const C4_RESPUESTA_BUENA = {
  workspace: { name: 'Tienda', description: null },
  elements: [
    { id: 'cliente', type: 'person', name: 'Cliente', description: 'Compra en la tienda', technology: null, external: false, parentId: null, shape: null },
    { id: 'tienda', type: 'softwareSystem', name: 'Tienda en línea', description: 'Vende productos', technology: null, external: false, parentId: null, shape: null },
    { id: 'web', type: 'container', name: 'Web', description: 'Interfaz de la tienda', technology: 'React', external: false, parentId: 'tienda', shape: 'browser' },
    { id: 'api', type: 'container', name: 'API', description: 'Reglas de negocio', technology: 'Node.js', external: false, parentId: 'tienda', shape: null },
    { id: 'db', type: 'container', name: 'Base de datos', description: null, technology: 'PostgreSQL', external: false, parentId: 'tienda', shape: 'database' },
  ],
  relationships: [
    { id: 'r1', sourceId: 'cliente', targetId: 'web', description: 'Usa', technology: 'HTTPS' },
    { id: 'r2', sourceId: 'web', targetId: 'api', description: 'Llama a', technology: 'JSON/HTTPS' },
    { id: 'r3', sourceId: 'api', targetId: 'db', description: 'Lee y escribe en', technology: 'SQL' },
  ],
  views: [
    { id: 'ctx', type: 'systemContext', scopeId: 'tienda', title: 'Contexto', elementIds: ['cliente', 'tienda'] },
    { id: 'cont', type: 'container', scopeId: 'tienda', title: 'Contenedores', elementIds: ['cliente', 'web', 'api', 'db'] },
  ],
};

/** La misma respuesta, pero la vista de contenedores no tiene alcance: cumple el esquema, pero `validate()` de C4 la marca como error. */
export const C4_RESPUESTA_SIN_ALCANCE = { ...C4_RESPUESTA_BUENA, views: C4_RESPUESTA_BUENA.views.map((v) => (v.id === 'cont' ? { ...v, scopeId: null } : v)) };
