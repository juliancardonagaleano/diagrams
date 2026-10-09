/**
 * Evals de prompts: mide si lo que los módulos le piden a un modelo (y lo que este contesta) sigue siendo bueno.
 *
 *   npm run evals                     # offline: respuestas GRABADAS en evals/recorded/, sin red ni claves (lo corre `npm test`)
 *   npm run evals:live                # live: el modelo real configurado (cuesta tokens; ver docs/ia.md)
 *   npm run evals -- --module c4 --case tienda-en-linea --verbose
 *
 * Cada caso (evals/cases/<módulo>.json) es una instrucción en lenguaje natural más expectativas comprobables: pasa el esquema,
 * `validate()` sin errores, entidades y tipos requeridos presentes, ningún `ref` inventado y tamaño razonable. Los casos de
 * `explain` y `review` comprueban la estructura del Markdown. En modo offline el «modelo» es un cliente simulado que sirve, en
 * orden, las respuestas del caso (incluidas algunas que fallan el esquema o `validate()` para ejercitar el bucle de corrección),
 * así que el resultado es determinista: una regresión del esquema, del bucle o de un prompt rompe el CI.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  estimateTokens,
  explainPrompts,
  formatTokens,
  generateStructured,
  generateText,
  GenerationError,
  openaiSettings,
  parseUrn,
  resolveModel,
  resolveProvider,
  reviewPrompts,
  type AiProvider,
  type DomainModule,
  type Env,
  type ModuleIssue,
  type ModuleRegistry,
} from '@iark/kernel';
import { DEFAULT_AI_MODEL } from '@core/ai/generate';
import { createDefaultRegistry } from '../src/cli/registry';

export type EvalMode = 'offline' | 'live';
export type EvalKind = 'generate' | 'explain' | 'review';

export interface EvalExpect {
  /** Mínimo de entidades por tipo (`module.entities(doc)`), p. ej. `{ "container": 3 }`. */
  kinds?: Record<string, number>;
  /** Textos que deben aparecer (sin distinguir mayúsculas) en el documento generado o en la respuesta en Markdown. */
  mentions?: string[];
  /** Cantidad total de entidades; por omisión de 1 a 300. */
  entities?: { min?: number; max?: number };
  /** Tamaño máximo del documento serializado (generate) en caracteres; por omisión 150 000. */
  maxChars?: number;
  /** Máximo de avisos de `validate()` en el documento generado. Sin indicar, no se comprueba. */
  maxWarnings?: number;
  /** Ningún `ref` (URN) que no venga del documento base, ni uno perdido. Por omisión se comprueba. */
  noInventedRefs?: boolean;
  /** Solo offline (con un modelo real el número de intentos varía): cómo debe haber ido el bucle de corrección. */
  loop?: { attempts?: number; repaired?: boolean; retries?: { schema?: number; rules?: number }; verification?: 'passed' | 'accepted-invalid' };
  /** Sobre el prompt tal como se le envía al modelo (no necesita modelo). */
  prompt?: { systemContains?: string[]; userContains?: string[]; maxInputTokens?: number };
  /** Encabezados Markdown que debe tener la respuesta (explain y review). */
  headings?: string[];
  /** Longitud de la respuesta en caracteres (explain y review); por omisión de 200 a 12 000. */
  chars?: { min?: number; max?: number };
}

export interface EvalCase {
  id: string;
  kind: EvalKind;
  /** Instrucción en lenguaje natural (generate). */
  instruction?: string;
  /** Documento base a refinar (generate): un objeto en línea o la ruta de un JSON relativa a la raíz del repositorio. */
  base?: unknown;
  /** Documento a explicar o revisar: un objeto en línea o la ruta de un JSON relativa a la raíz del repositorio. */
  document?: unknown;
  /** Los avisos de `validate()` también se devuelven al modelo (como `--strict`). */
  strict?: boolean;
  maxRetries?: number;
  lang?: 'es' | 'en';
  expect: EvalExpect;
  /** Para quien lea el caso: qué ejercita. */
  notes?: string;
}

export interface CaseFile {
  module: string;
  cases: EvalCase[];
}

/**
 * Una respuesta grabada del modelo: el texto tal cual (para una respuesta en Markdown o una que no es JSON) o, si es un objeto, su
 * `content` (el JSON que el modelo habría escrito, que se serializa al servirlo) y, opcionalmente, el `finish_reason` (`length` simula
 * una respuesta cortada por el tope de salida).
 */
export type RecordedResponse = string | { content: unknown; finish_reason?: string };

export interface Recording {
  case: string;
  /** Cómo se obtuvo; para quien mantenga las grabaciones. */
  notes?: string;
  /** Huella del prompt de sistema (y del de usuario si no incluye un documento) con el que se grabó: si cambia, la grabación está obsoleta. */
  promptSha256?: string;
  responses: RecordedResponse[];
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface CaseResult {
  module: string;
  id: string;
  kind: EvalKind;
  /** `skipped`: no se ejecutó (el presupuesto de la ejecución live se agotó). */
  status: 'passed' | 'failed' | 'skipped';
  /** Fracción de comprobaciones superadas, de 0 a 1. */
  score: number;
  checks: CheckResult[];
  attempts?: number;
  repaired?: boolean;
  tokens: { input: number; output: number };
  warnings: string[];
}

export interface ModuleSummary {
  module: string;
  cases: number;
  passed: number;
  failed: number;
  skipped: number;
  /** Media de las puntuaciones de sus casos ejecutados. */
  score: number;
  tokens: { input: number; output: number };
}

export interface EvalReport {
  mode: EvalMode;
  /** Modelo y plataforma: los reales en live; `grabado` (cliente simulado) en offline. */
  model: string;
  provider: string;
  results: CaseResult[];
  modules: ModuleSummary[];
  total: ModuleSummary;
}

export interface RunOptions {
  mode?: EvalMode;
  /** Raíz del repositorio (donde está `evals/`). Por omisión, la de este script. */
  root?: string;
  registry?: ModuleRegistry;
  /** Solo estos módulos / solo estos casos. */
  modules?: string[];
  cases?: string[];
  /** Offline: reescribe la huella del prompt en las grabaciones en lugar de avisar de que están obsoletas. */
  updateHashes?: boolean;
  // Solo live:
  provider?: AiProvider | 'auto';
  model?: string;
  env?: Env;
  /** Tope de salida por llamada y presupuesto TOTAL por caso (ver `StructuredOptions`). */
  maxTokens?: number;
  budgetTokens?: number;
  /** Tope de tokens de TODA la ejecución live: al agotarse, los casos que quedan se omiten. */
  runBudgetTokens?: number;
  onProgress?: (message: string) => void;
}

/** Presupuesto por omisión de toda una ejecución live (el conjunto de casos incluido gasta bastante menos; ver docs/ia.md). */
export const DEFAULT_RUN_BUDGET_TOKENS = 600_000;

const defaultRoot = (): string => resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------------------------------------------------
// Carga de casos y grabaciones
// ---------------------------------------------------------------------------------------------------------------------

export function loadCaseFiles(root: string = defaultRoot()): CaseFile[] {
  const dir = join(root, 'evals', 'cases');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as CaseFile);
}

export function recordingPath(root: string, module: string, id: string): string {
  return join(root, 'evals', 'recorded', module, `${id}.json`);
}

function loadRecording(root: string, module: string, id: string): Recording | undefined {
  const file = recordingPath(root, module, id);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Recording) : undefined;
}

/** Un documento en línea o la ruta (relativa a la raíz) de un JSON. */
function resolveDocument(root: string, value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(readFileSync(join(root, value), 'utf8')) : value;
}

// ---------------------------------------------------------------------------------------------------------------------
// El «modelo» offline: un servicio compatible con Chat Completions que sirve las respuestas grabadas
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Un `fetch` que responde, en orden, con las respuestas grabadas. El uso de tokens es una ESTIMACIÓN (la misma heurística que
 * los topes): las grabaciones están escritas a mano y no hay un proveedor que las haya contado.
 */
export function recordedFetch(responses: RecordedResponse[]): { fetch: typeof fetch; served: () => number } {
  let next = 0;
  const answer = async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const response = responses[next];
    if (response === undefined) throw new Error(`Se pidió la respuesta ${next + 1}, pero la grabación solo tiene ${responses.length}.`);
    next += 1;
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ content: string }> };
    const content = typeof response === 'string' ? response : typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    const finish = typeof response === 'string' ? 'stop' : (response.finish_reason ?? 'stop');
    return new Response(
      JSON.stringify({
        model: 'grabado',
        choices: [{ message: { content }, finish_reason: finish }],
        usage: { prompt_tokens: estimateTokens((body.messages ?? []).map((m) => m.content).join('\n')), completion_tokens: estimateTokens(content) },
      }),
      { status: 200 },
    );
  };
  return { fetch: answer as typeof fetch, served: () => next };
}

/** El entorno con el que corre el modelo simulado: credenciales ficticias de un servicio compatible con OpenAI que nunca se contacta. */
const OFFLINE_ENV: Env = { AI_BASE_URL: 'https://evals.invalid/openai/v1', AI_API_KEY: 'sin-clave-offline' };

// ---------------------------------------------------------------------------------------------------------------------
// Comprobaciones
// ---------------------------------------------------------------------------------------------------------------------

const check = (name: string, ok: boolean, detail?: string): CheckResult => ({ name, ok, ...(detail ? { detail } : {}) });

/** Recorre el documento y reúne los `ref` (URN) con la clave de su elemento (ruta de colecciones + `id`). */
function collectRefs(value: unknown): Map<string, string> {
  const refs = new Map<string, string>();
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, path);
    } else if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      if (typeof record.ref === 'string') refs.set(`${path}#${String(record.id ?? '')}`, record.ref);
      for (const [key, child] of Object.entries(record)) walk(child, `${path}/${key}`);
    }
  };
  walk(value, '');
  return refs;
}

/** Los ids de los elementos del documento por clave (misma convención que `collectRefs`). */
function collectKeys(value: unknown): Set<string> {
  const keys = new Set<string>();
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, path);
    } else if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      if (typeof record.id === 'string') keys.add(`${path}#${record.id}`);
      for (const [key, child] of Object.entries(record)) walk(child, `${path}/${key}`);
    }
  };
  walk(value, '');
  return keys;
}

function refChecks(base: unknown, document: unknown): CheckResult {
  const baseRefs = collectRefs(base);
  const outRefs = collectRefs(document);
  const known = new Set(baseRefs.values());
  const invented = [...outRefs.entries()].filter(([, ref]) => !known.has(ref) || parseUrn(ref) === null);
  const outKeys = collectKeys(document);
  const lost = [...baseRefs.entries()].filter(([key]) => outKeys.has(key) && !outRefs.has(key));
  const problems = [
    ...invented.map(([key, ref]) => `«${ref}» en ${key} no viene del documento base`),
    ...lost.map(([key, ref]) => `se perdió «${ref}» de ${key}`),
  ];
  return check('refs', problems.length === 0, problems.slice(0, 3).join('; ') || (baseRefs.size > 0 ? `${baseRefs.size} ref del documento base conservados` : 'sin refs'));
}

const issueLine = (i: ModuleIssue): string => `${i.severity}: ${i.message}${i.elementId ? ` («${i.elementId}»)` : ''}`;

function promptChecks(expect: EvalExpect['prompt'], system: string, user: string): CheckResult[] {
  if (!expect) return [];
  const results: CheckResult[] = [];
  const missingSystem = (expect.systemContains ?? []).filter((s) => !system.includes(s));
  const missingUser = (expect.userContains ?? []).filter((s) => !user.includes(s));
  if (expect.systemContains?.length || expect.userContains?.length) {
    const missing = [...missingSystem.map((s) => `sistema sin «${s}»`), ...missingUser.map((s) => `usuario sin «${s}»`)];
    results.push(check('prompt', missing.length === 0, missing.join('; ') || 'contiene lo esperado'));
  }
  if (expect.maxInputTokens !== undefined) {
    const tokens = estimateTokens(`${system}\n${user}`);
    results.push(check('prompt-tamaño', tokens <= expect.maxInputTokens, `~${formatTokens(tokens)} tokens estimados (máximo ${formatTokens(expect.maxInputTokens)})`));
  }
  return results;
}

function textChecks(expect: EvalExpect, text: string, truncated: boolean): CheckResult[] {
  const results: CheckResult[] = [];
  results.push(check('respuesta', text.trim().length > 0 && !truncated, truncated ? 'la respuesta se cortó por el tope de salida' : text.trim() ? 'hay texto' : 'respuesta vacía'));
  results.push(check('markdown', !/^\s*[{[]/.test(text), 'es prosa en Markdown, no JSON'));
  if (expect.headings?.length) {
    const missing = expect.headings.filter((h) => !new RegExp(`^#{1,4}\\s*${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'im').test(text));
    results.push(check('secciones', missing.length === 0, missing.length ? `faltan: ${missing.join(', ')}` : `${expect.headings.length} secciones`));
  }
  if (expect.mentions?.length) {
    const missing = expect.mentions.filter((m) => !text.toLowerCase().includes(m.toLowerCase()));
    results.push(check('menciones', missing.length === 0, missing.length ? `no menciona: ${missing.join(', ')}` : `${expect.mentions.length} menciones`));
  }
  const min = expect.chars?.min ?? 200;
  const max = expect.chars?.max ?? 12_000;
  results.push(check('tamaño', text.length >= min && text.length <= max, `${formatTokens(text.length)} caracteres (entre ${formatTokens(min)} y ${formatTokens(max)})`));
  return results;
}

function documentChecks(module: DomainModule<unknown>, testCase: EvalCase, base: unknown, document: unknown): CheckResult[] {
  const expect = testCase.expect;
  const results: CheckResult[] = [];
  const parsed = module.schema.safeParse(document);
  results.push(check('esquema', parsed.success, parsed.success ? 'cumple el esquema del documento' : parsed.error.issues.slice(0, 2).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')));

  const issues = module.validate(document);
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  results.push(check('reglas', errors.length === 0, errors.length ? errors.slice(0, 3).map(issueLine).join('; ') : `sin errores (${warnings.length} aviso(s), ${issues.length - warnings.length} nota(s))`));
  if (expect.maxWarnings !== undefined) results.push(check('avisos', warnings.length <= expect.maxWarnings, `${warnings.length} aviso(s) (máximo ${expect.maxWarnings})`));

  const entities = module.entities?.(document) ?? [];
  const counts = new Map<string, number>();
  for (const e of entities) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  if (expect.kinds) {
    const short = Object.entries(expect.kinds).filter(([kind, min]) => (counts.get(kind) ?? 0) < min);
    results.push(check('entidades', short.length === 0, short.length ? short.map(([kind, min]) => `${kind}: ${counts.get(kind) ?? 0} de ${min}`).join('; ') : Object.entries(expect.kinds).map(([k, n]) => `${k} ≥ ${n}`).join(', ')));
  }
  const text = JSON.stringify(document);
  if (expect.mentions?.length) {
    const missing = expect.mentions.filter((m) => !text.toLowerCase().includes(m.toLowerCase()));
    results.push(check('menciones', missing.length === 0, missing.length ? `no aparece: ${missing.join(', ')}` : `${expect.mentions.length} menciones`));
  }
  const min = expect.entities?.min ?? 1;
  const max = expect.entities?.max ?? 300;
  const maxChars = expect.maxChars ?? 150_000;
  results.push(check('tamaño', entities.length >= min && entities.length <= max && text.length <= maxChars, `${entities.length} entidades (entre ${min} y ${max}), ${formatTokens(text.length)} caracteres (máximo ${formatTokens(maxChars)})`));
  if (expect.noInventedRefs !== false) results.push(refChecks(base, document));
  return results;
}

// ---------------------------------------------------------------------------------------------------------------------
// Ejecución
// ---------------------------------------------------------------------------------------------------------------------

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

interface BuiltPrompts {
  system: string;
  user: string;
  /** Lo que se hashea: el prompt de sistema y, si el de usuario no incluye un documento ajeno, también ese. */
  fingerprint: string;
}

function buildPrompts(module: DomainModule<unknown>, testCase: EvalCase, root: string): BuiltPrompts {
  if (testCase.kind === 'generate') {
    if (!module.ai) throw new Error(`El módulo «${module.id}» no genera con IA.`);
    const base = testCase.base === undefined ? undefined : resolveDocument(root, testCase.base);
    const system = module.ai.system();
    const user = module.ai.user(testCase.instruction ?? '', base);
    return { system, user, fingerprint: hash(base === undefined ? `${system}\n---\n${user}` : system) };
  }
  const document = resolveDocument(root, testCase.document);
  const issues = testCase.kind === 'review' ? module.validate(document) : [];
  const { system, user } = (testCase.kind === 'explain' ? explainPrompts : reviewPrompts)({ module, document, issues, lang: testCase.lang });
  return { system, user, fingerprint: hash(system) };
}

interface LiveConfig {
  provider: AiProvider | 'auto';
  model?: string;
  env: Env;
  maxTokens?: number;
  budgetTokens?: number;
}

async function runCase(module: DomainModule<unknown>, testCase: EvalCase, options: { root: string; mode: EvalMode; live?: LiveConfig; updateHashes?: boolean }): Promise<CaseResult> {
  const { root, mode } = options;
  const warnings: string[] = [];
  const result: CaseResult = { module: module.id, id: testCase.id, kind: testCase.kind, status: 'failed', score: 0, checks: [], tokens: { input: 0, output: 0 }, warnings };
  const finish = (): CaseResult => {
    result.score = result.checks.length === 0 ? 0 : result.checks.filter((c) => c.ok).length / result.checks.length;
    result.status = result.checks.length > 0 && result.checks.every((c) => c.ok) ? 'passed' : 'failed';
    return result;
  };

  let prompts: BuiltPrompts;
  try {
    prompts = buildPrompts(module, testCase, root);
  } catch (error) {
    result.checks.push(check('prompt', false, `no se pudo montar el prompt: ${(error as Error).message}`));
    return finish();
  }
  result.checks.push(...promptChecks(testCase.expect.prompt, prompts.system, prompts.user));

  // Modo offline: la grabación del caso.
  let recording: Recording | undefined;
  let offlineClient: ReturnType<typeof recordedFetch> | undefined;
  if (mode === 'offline') {
    recording = loadRecording(root, module.id, testCase.id);
    if (!recording || recording.responses.length === 0) {
      result.checks.push(check('grabación', false, `falta evals/recorded/${module.id}/${testCase.id}.json (o no tiene respuestas)`));
      return finish();
    }
    if (options.updateHashes) {
      const file = recordingPath(root, module.id, testCase.id);
      // La huella va entre las notas y las respuestas, para que el archivo se lea en el orden en que se explica.
      const { case: name, notes, responses } = recording;
      writeFileSync(file, `${JSON.stringify({ case: name, ...(notes ? { notes } : {}), promptSha256: prompts.fingerprint, responses }, null, 2)}\n`);
    } else if (recording.promptSha256 !== prompts.fingerprint) {
      warnings.push(
        recording.promptSha256
          ? 'grabación obsoleta: el prompt cambió desde que se grabó; repite `npm run evals:live` y, si todo sigue bien, `npm run evals -- --update-hashes`'
          : 'la grabación no tiene la huella del prompt (`promptSha256`); `npm run evals -- --update-hashes` la escribe',
      );
    }
    offlineClient = recordedFetch(recording.responses);
  }

  const common = mode === 'offline'
    ? { provider: 'openai' as const, model: 'grabado', env: OFFLINE_ENV, fetch: offlineClient!.fetch }
    : { provider: options.live!.provider, model: options.live!.model, env: options.live!.env };
  const limits = mode === 'live' ? { maxTokens: options.live!.maxTokens, budgetTokens: options.live!.budgetTokens } : {};

  if (testCase.kind === 'generate') {
    const base = testCase.base === undefined ? undefined : resolveDocument(root, testCase.base);
    try {
      const generated = await generateStructured(module.ai!, {
        instruction: testCase.instruction ?? '',
        base,
        defaultModel: DEFAULT_AI_MODEL,
        ...common,
        ...limits,
        maxRetries: testCase.maxRetries ?? 2,
        validate: module.validate,
        retryOn: testCase.strict ? 'warning' : 'error',
      });
      result.attempts = generated.attempts;
      result.repaired = generated.repaired;
      result.tokens = { input: generated.usage.inputTokens, output: generated.usage.outputTokens };
      result.checks.push(check('generación', true, `${generated.attempts} intento(s) con ${generated.model}`));
      result.checks.push(...documentChecks(module, testCase, base, generated.document));
      const loop = testCase.expect.loop;
      if (mode === 'offline' && loop) {
        const problems: string[] = [];
        if (loop.attempts !== undefined && generated.attempts !== loop.attempts) problems.push(`intentos: ${generated.attempts} en vez de ${loop.attempts}`);
        if (loop.repaired !== undefined && generated.repaired !== loop.repaired) problems.push(`repaired: ${generated.repaired} en vez de ${loop.repaired}`);
        if (loop.retries?.schema !== undefined && generated.retries.schema !== loop.retries.schema) problems.push(`reintentos por esquema: ${generated.retries.schema} en vez de ${loop.retries.schema}`);
        if (loop.retries?.rules !== undefined && generated.retries.rules !== loop.retries.rules) problems.push(`reintentos por reglas: ${generated.retries.rules} en vez de ${loop.retries.rules}`);
        if (loop.verification !== undefined && generated.verification !== loop.verification) problems.push(`verificación: ${generated.verification} en vez de ${loop.verification}`);
        result.checks.push(check('bucle', problems.length === 0, problems.join('; ') || `${generated.attempts} intento(s): ${generated.retries.schema} por esquema, ${generated.retries.rules} por reglas`));
      }
    } catch (error) {
      result.checks.push(check('generación', false, error instanceof GenerationError || error instanceof Error ? error.message.split('\n').slice(0, 3).join(' | ') : String(error)));
    }
    return finish();
  }

  // explain / review
  try {
    const answer = await generateText({ system: prompts.system, user: prompts.user, defaultModel: DEFAULT_AI_MODEL, ...common, ...limits });
    result.tokens = { input: answer.usage.inputTokens, output: answer.usage.outputTokens };
    result.checks.push(...textChecks(testCase.expect, answer.text, answer.truncated));
  } catch (error) {
    result.checks.push(check('respuesta', false, error instanceof Error ? error.message.split('\n')[0] : String(error)));
  }
  return finish();
}

const emptySummary = (module: string): ModuleSummary => ({ module, cases: 0, passed: 0, failed: 0, skipped: 0, score: 0, tokens: { input: 0, output: 0 } });

function summarize(module: string, results: CaseResult[]): ModuleSummary {
  const summary = emptySummary(module);
  const executed = results.filter((r) => r.status !== 'skipped');
  for (const r of results) {
    summary.cases += 1;
    summary[r.status] += 1;
    summary.tokens.input += r.tokens.input;
    summary.tokens.output += r.tokens.output;
  }
  summary.score = executed.length === 0 ? 0 : executed.reduce((sum, r) => sum + r.score, 0) / executed.length;
  return summary;
}

export async function runEvals(options: RunOptions = {}): Promise<EvalReport> {
  const mode = options.mode ?? 'offline';
  const root = options.root ?? defaultRoot();
  const registry = options.registry ?? createDefaultRegistry();
  const progress = options.onProgress ?? (() => {});
  const files = loadCaseFiles(root).filter((f) => !options.modules?.length || options.modules.includes(f.module));

  const live: LiveConfig | undefined =
    mode === 'live'
      ? { provider: options.provider ?? 'auto', model: options.model, env: options.env ?? process.env, maxTokens: options.maxTokens, budgetTokens: options.budgetTokens }
      : undefined;
  const runBudget = options.runBudgetTokens ?? DEFAULT_RUN_BUDGET_TOKENS;
  let spent = 0;

  const results: CaseResult[] = [];
  for (const file of files) {
    const module = registry.require(file.module) as DomainModule<unknown>;
    for (const testCase of file.cases) {
      if (options.cases?.length && !options.cases.includes(testCase.id)) continue;
      if (mode === 'live' && spent >= runBudget) {
        results.push({ module: module.id, id: testCase.id, kind: testCase.kind, status: 'skipped', score: 0, checks: [], tokens: { input: 0, output: 0 }, warnings: [`omitido: se agotó el presupuesto de la ejecución (${formatTokens(runBudget)} tokens)`] });
        continue;
      }
      progress(`${module.id} / ${testCase.id}…`);
      const result = await runCase(module, testCase, { root, mode, live, updateHashes: options.updateHashes });
      spent += result.tokens.input + result.tokens.output;
      results.push(result);
    }
  }

  const moduleIds = [...new Set(results.map((r) => r.module))];
  const modules = moduleIds.map((id) => summarize(id, results.filter((r) => r.module === id)));
  const resolved = live ? resolveProvider(live.provider, live.env) : undefined;
  const provider = resolved ?? 'cliente simulado';
  const model = resolved ? resolveModel(resolved, live!.model, DEFAULT_AI_MODEL, live!.env) : 'respuestas grabadas';
  return { mode, model, provider, results, modules, total: summarize('TOTAL', results) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Informe
// ---------------------------------------------------------------------------------------------------------------------

const pct = (n: number): string => `${Math.round(n * 100)} %`;
const pad = (s: string, n: number): string => s.padEnd(n);

/** El informe en texto: puntuación por módulo y por caso, con el detalle de lo que falla y los avisos. */
export function formatReport(report: EvalReport, options: { verbose?: boolean } = {}): string {
  const lines: string[] = [];
  const offline = report.mode === 'offline';
  lines.push(`Evals de prompts · modo ${report.mode} (${report.provider}, ${report.model})${offline ? ' · tokens ESTIMADOS (heurística, no un proveedor)' : ''}`);
  lines.push('');
  lines.push(`${pad('Módulo', 13)}${pad('Casos', 7)}${pad('Superados', 11)}${pad('Puntuación', 12)}Tokens (entrada / salida)`);
  for (const m of [...report.modules, report.total]) {
    const extra = m.skipped > 0 ? ` (${m.skipped} omitido(s))` : '';
    lines.push(`${pad(m.module, 13)}${pad(String(m.cases), 7)}${pad(String(m.passed), 11)}${pad(pct(m.score), 12)}${formatTokens(m.tokens.input)} / ${formatTokens(m.tokens.output)}${extra}`);
  }
  lines.push('');
  lines.push('Casos');
  for (const r of report.results) {
    const mark = r.status === 'passed' ? '✓' : r.status === 'failed' ? '✗' : '–';
    const detail = r.status === 'skipped' ? 'omitido' : `${pct(r.score)}${r.attempts !== undefined ? ` · ${r.attempts} intento(s)${r.repaired ? ' (corregido)' : ''}` : ''} · ${formatTokens(r.tokens.input)} / ${formatTokens(r.tokens.output)} tokens`;
    lines.push(`  ${mark} ${r.module} / ${r.id} [${r.kind}] ${detail}`);
    for (const c of r.checks) {
      if (c.ok && !options.verbose) continue;
      lines.push(`      ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? `: ${c.detail}` : ''}`);
    }
  }
  const warnings = report.results.flatMap((r) => r.warnings.map((w) => `  - ${r.module} / ${r.id}: ${w}`));
  if (warnings.length > 0) {
    lines.push('');
    lines.push('Avisos');
    lines.push(...warnings);
  }
  lines.push('');
  const failed = report.total.failed;
  lines.push(failed === 0 ? `Todo en orden: ${report.total.passed} de ${report.total.cases} caso(s) superados (${pct(report.total.score)}).` : `${failed} caso(s) fallan de ${report.total.cases} (${pct(report.total.score)}).`);
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Línea de comandos
// ---------------------------------------------------------------------------------------------------------------------

const HELP = `Uso: npm run evals -- [opciones]      (offline)   ·   npm run evals:live -- [opciones]   (modelo real)

  --mode offline|live        offline (por omisión): respuestas grabadas; live: el modelo real configurado (cuesta tokens)
  --module <ids>             solo estos módulos, separados por comas
  --case <ids>               solo estos casos, separados por comas
  --verbose                  muestra también las comprobaciones superadas
  --json <archivo>           escribe además el informe completo en JSON
  --update-hashes            (offline) reescribe la huella del prompt en las grabaciones
Solo live:
  --provider <p>             auto (por omisión) | anthropic | foundry | openai
  --model <m>                modelo (o el despliegue, en Foundry)
  --max-tokens <n>           tope de salida por llamada
  --budget-tokens <n>        presupuesto total de tokens POR CASO (reintentos incluidos)
  --run-budget-tokens <n>    presupuesto de TODA la ejecución (por omisión ${DEFAULT_RUN_BUDGET_TOKENS}); al agotarse, los casos que quedan se omiten
  --yes                      no pedir confirmación implícita: en live es obligatorio (confirma que sabes que gasta tokens)
Salida: 0 si todos los casos ejecutados pasan; 1 si alguno falla; 2 si el uso es incorrecto.
`;

function positive(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${label} debe ser un entero positivo.`);
  return n;
}

/** Lo que falta para correr en live, o `undefined` si hay credenciales para el proveedor elegido. */
export function liveSetupProblem(provider: AiProvider | 'auto', env: Env): string | undefined {
  const resolved = resolveProvider(provider, env);
  if (resolved === 'anthropic') return env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN ? undefined : 'Falta ANTHROPIC_API_KEY (o ANTHROPIC_AUTH_TOKEN) para la API de Anthropic.';
  if (resolved === 'foundry') {
    return env.ANTHROPIC_FOUNDRY_API_KEY && (env.ANTHROPIC_FOUNDRY_BASE_URL || env.ANTHROPIC_FOUNDRY_RESOURCE) && env.ANTHROPIC_FOUNDRY_MODEL
      ? undefined
      : 'Faltan variables de Claude en Foundry: ANTHROPIC_FOUNDRY_API_KEY, ANTHROPIC_FOUNDRY_BASE_URL (o ANTHROPIC_FOUNDRY_RESOURCE) y ANTHROPIC_FOUNDRY_MODEL.';
  }
  const { baseURL, apiKey, model } = openaiSettings(env);
  return baseURL && apiKey && model ? undefined : 'Faltan variables del endpoint compatible con OpenAI: AI_API_KEY, AI_BASE_URL y AI_MODEL (o las ANTHROPIC_FOUNDRY_*).';
}

export interface MainIo {
  out: (s: string) => void;
  err: (s: string) => void;
  /** Entorno del que se leen las credenciales (solo en live). */
  env: Env;
  /** Solo para las pruebas: otra raíz de evals y otro registro de módulos. */
  root?: string;
  registry?: ModuleRegistry;
}

/** Punto de entrada de la línea de comandos; devuelve el código de salida. */
export async function main(argv: string[] = process.argv.slice(2), io: MainIo = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s), env: process.env }): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        mode: { type: 'string' },
        module: { type: 'string' },
        case: { type: 'string' },
        verbose: { type: 'boolean' },
        json: { type: 'string' },
        'update-hashes': { type: 'boolean' },
        provider: { type: 'string' },
        model: { type: 'string' },
        'max-tokens': { type: 'string' },
        'budget-tokens': { type: 'string' },
        'run-budget-tokens': { type: 'string' },
        yes: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    io.err(`${(error as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (values.help) {
    io.out(HELP);
    return 0;
  }
  const mode = (values.mode ?? 'offline') as string;
  if (mode !== 'offline' && mode !== 'live') {
    io.err(`--mode debe ser offline o live (se recibió «${mode}»).\n`);
    return 2;
  }
  const provider = (values.provider ?? 'auto') as AiProvider | 'auto';
  if (!['auto', 'anthropic', 'foundry', 'openai'].includes(provider)) {
    io.err('--provider debe ser auto, anthropic, foundry u openai.\n');
    return 2;
  }
  let maxTokens, budgetTokens, runBudgetTokens;
  try {
    maxTokens = positive(values['max-tokens'], '--max-tokens');
    budgetTokens = positive(values['budget-tokens'], '--budget-tokens');
    runBudgetTokens = positive(values['run-budget-tokens'], '--run-budget-tokens');
  } catch (error) {
    io.err(`${(error as Error).message}\n`);
    return 2;
  }
  if (mode === 'live') {
    const problem = liveSetupProblem(provider, io.env);
    if (problem) {
      io.err(`${problem}\nLos evals live llaman a un modelo real; las claves van en el entorno, nunca en el repositorio. Mira docs/ia.md («Evals»).\n`);
      return 2;
    }
    if (!values.yes) {
      io.err('Los evals live gastan tokens de tu cuenta (ver docs/ia.md para el orden de magnitud). Repite con --yes para confirmar.\n');
      return 2;
    }
  }
  const report = await runEvals({
    mode,
    root: io.root,
    registry: io.registry,
    modules: values.module?.split(',').map((s) => s.trim()).filter(Boolean),
    cases: values.case?.split(',').map((s) => s.trim()).filter(Boolean),
    updateHashes: values['update-hashes'],
    provider,
    model: values.model,
    env: io.env,
    maxTokens,
    budgetTokens,
    runBudgetTokens,
    onProgress: mode === 'live' ? (m) => io.err(`${m}\n`) : undefined,
  });
  io.out(formatReport(report, { verbose: values.verbose }));
  if (values.json) {
    mkdirSync(dirname(resolve(values.json)), { recursive: true });
    writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (report.results.length === 0) {
    io.err('No hay casos que ejecutar (revisa --module y --case, y que exista evals/cases/).\n');
    return 2;
  }
  return report.total.failed > 0 ? 1 : 0;
}

// Solo se ejecuta como script (`tsx scripts/evals.ts`), no al importarlo desde las pruebas.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => void (process.exitCode = code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
