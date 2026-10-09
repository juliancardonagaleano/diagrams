import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModuleRegistry, type AiSpec, type DomainModule, type Env } from '@iark/kernel';
import { sampleDocument } from '@core/model/sample';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { formatReport, liveSetupProblem, loadCaseFiles, main, recordedFetch, recordingPath, runEvals, type CaseFile, type EvalCase } from '../scripts/evals';
import { C4_RESPUESTA_BUENA, C4_RESPUESTA_SIN_ALCANCE, simulateChat, withModelEnv } from './helpers/modeloSimulado';

// Los evals de prompts, en su modo offline (respuestas grabadas a mano en evals/recorded/): este archivo los corre dentro de
// `npm test` y comprueba que el ejecutor detecta de verdad lo que debe detectar. Nada de aquí llama a un modelo real ni a la red.

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ALL_MODULES = ['c4', 'data', 'enterprise', 'integration', 'platform', 'security'];

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
afterEach(() => vi.unstubAllGlobals());

/** Un repositorio de evals mínimo en un directorio temporal: los casos de un módulo y sus grabaciones. */
function makeRoot(cases: EvalCase[], recordings: Record<string, unknown>, moduleId = 'c4'): string {
  const root = mkdtempSync(join(tmpdir(), 'iark-evals-'));
  roots.push(root);
  mkdirSync(join(root, 'evals', 'cases'), { recursive: true });
  writeFileSync(join(root, 'evals', 'cases', `${moduleId}.json`), JSON.stringify({ module: moduleId, cases } satisfies CaseFile));
  for (const [id, recording] of Object.entries(recordings)) {
    mkdirSync(join(root, 'evals', 'recorded', moduleId), { recursive: true });
    writeFileSync(recordingPath(root, moduleId, id), JSON.stringify(recording));
  }
  return root;
}

/** La respuesta grabada de «tienda-en-linea»: cumple el esquema y las reglas y no tiene ningún aviso. */
const TIENDA = (JSON.parse(readFileSync(recordingPath(repoRoot, 'c4', 'tienda-en-linea'), 'utf8')) as { responses: Array<{ content: unknown }> }).responses[0].content as typeof C4_RESPUESTA_BUENA;

const buena = (extra: Record<string, unknown> = {}) => ({ case: 'uno', responses: [{ content: C4_RESPUESTA_BUENA }], ...extra });
const caso = (expectation: EvalCase['expect'] = {}, extra: Partial<EvalCase> = {}): EvalCase => ({ id: 'uno', kind: 'generate', instruction: 'Una tienda en línea', expect: expectation, ...extra });
const checkOf = (r: { checks: Array<{ name: string; ok: boolean; detail?: string }> }, name: string) => r.checks.find((c) => c.name === name);

describe('evals offline del repositorio (lo que corre npm test)', () => {
  it('todos los casos pasan con sus grabaciones, sin entorno de modelo y sin tocar la red', async () => {
    const globalFetch = vi.fn(() => {
      throw new Error('el modo offline no debe usar la red');
    });
    vi.stubGlobal('fetch', globalFetch);
    const report = await withModelEnv(() => runEvals({ mode: 'offline' }), { credentials: false });
    const failing = report.results.filter((r) => r.status !== 'passed').map((r) => `${r.module}/${r.id}: ${r.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`).join('; ')}`);
    expect(failing).toEqual([]);
    expect(report.total.failed).toBe(0);
    expect(report.total.score).toBe(1);
    expect(report.mode).toBe('offline');
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('cubre los seis módulos, los tres tipos de caso y los dos caminos del bucle de corrección', async () => {
    const report = await runEvals({ mode: 'offline' });
    expect(report.modules.map((m) => m.module).sort()).toEqual(ALL_MODULES);
    for (const m of report.modules) expect(m.passed).toBe(m.cases);
    const kinds = new Set(report.results.map((r) => r.kind));
    expect([...kinds].sort()).toEqual(['explain', 'generate', 'review']);
    // Casos que pasan por el bucle: uno corregido por el esquema y otro por las reglas del módulo.
    const files = loadCaseFiles(repoRoot).flatMap((f) => f.cases);
    expect(files.some((c) => (c.expect.loop?.retries?.schema ?? 0) > 0)).toBe(true);
    expect(files.some((c) => (c.expect.loop?.retries?.rules ?? 0) > 0)).toBe(true);
    expect(files.some((c) => c.strict)).toBe(true);
    expect(report.results.filter((r) => r.repaired).length).toBeGreaterThanOrEqual(3);
    // Los tokens offline son estimados, pero no cero.
    expect(report.total.tokens.input).toBeGreaterThan(0);
    expect(report.total.tokens.output).toBeGreaterThan(0);
  });

  it('cada caso tiene su grabación, ninguna grabación está huérfana y todas llevan la huella del prompt', () => {
    const cases = loadCaseFiles(repoRoot);
    expect(cases.length).toBe(ALL_MODULES.length);
    const expected: string[] = [];
    for (const file of cases) {
      const ids = file.cases.map((c) => c.id);
      expect(new Set(ids).size, `ids repetidos en ${file.module}`).toBe(ids.length);
      for (const id of ids) {
        const path = recordingPath(repoRoot, file.module, id);
        expect(existsSync(path), path).toBe(true);
        const recording = JSON.parse(readFileSync(path, 'utf8')) as { case: string; promptSha256?: string; responses: unknown[] };
        expect(recording.case).toBe(id);
        expect(recording.promptSha256, `${file.module}/${id} sin promptSha256`).toMatch(/^[0-9a-f]{64}$/);
        expect(recording.responses.length).toBeGreaterThan(0);
        expected.push(join(file.module, `${id}.json`));
      }
    }
    const onDisk = readdirSync(join(repoRoot, 'evals', 'recorded'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => readdirSync(join(repoRoot, 'evals', 'recorded', d.name)).map((f) => join(d.name, f)));
    expect(onDisk.sort()).toEqual(expected.sort());
  });

  it('las grabaciones no están obsoletas respecto de los prompts (aviso, no fallo: se regeneran con --update-hashes)', async () => {
    const report = await runEvals({ mode: 'offline' });
    const stale = report.results.flatMap((r) => r.warnings.map((w) => `${r.module}/${r.id}: ${w}`));
    // No hace fallar la prueba para que cambiar un prompt no rompa el CI de otro cambio; sí lo deja a la vista si ocurre.
    if (stale.length > 0) console.warn(`Grabaciones de evals obsoletas:\n${stale.join('\n')}`);
    expect(report.results.every((r) => r.status === 'passed')).toBe(true);
  });
});

describe('el ejecutor detecta lo que debe detectar', () => {
  it('un caso correcto pasa y cuenta intentos y tokens estimados', async () => {
    const root = makeRoot([caso({ kinds: { container: 3 }, mentions: ['PostgreSQL'], loop: { attempts: 1, repaired: false, verification: 'passed' } })], { uno: buena() });
    const report = await runEvals({ mode: 'offline', root });
    const [result] = report.results;
    expect(result.status).toBe('passed');
    expect(result.score).toBe(1);
    expect(result.attempts).toBe(1);
    expect(result.tokens.input).toBeGreaterThan(0);
    expect(report.total).toMatchObject({ cases: 1, passed: 1, failed: 0, skipped: 0 });
  });

  it('sin grabación el caso falla y el mensaje dice cuál falta', async () => {
    const root = makeRoot([caso()], {});
    const [result] = (await runEvals({ mode: 'offline', root })).results;
    expect(result.status).toBe('failed');
    expect(checkOf(result, 'grabación')).toMatchObject({ ok: false });
    expect(checkOf(result, 'grabación')!.detail).toContain('evals/recorded/c4/uno.json');
  });

  it('una expectativa incumplida hace fallar el caso y baja la puntuación', async () => {
    const root = makeRoot([caso({ kinds: { container: 9 }, mentions: ['Oracle'], maxWarnings: 0 })], { uno: buena() });
    const [result] = (await runEvals({ mode: 'offline', root })).results;
    expect(result.status).toBe('failed');
    expect(result.score).toBeLessThan(1);
    expect(checkOf(result, 'entidades')).toMatchObject({ ok: false, detail: 'container: 3 de 9' });
    expect(checkOf(result, 'menciones')).toMatchObject({ ok: false, detail: 'no aparece: Oracle' });
    expect(checkOf(result, 'esquema')!.ok).toBe(true);
  });

  it('el tamaño del documento y el número de entidades también se comprueban', async () => {
    const root = makeRoot([caso({ entities: { max: 2 }, maxChars: 100 })], { uno: buena() });
    const [result] = (await runEvals({ mode: 'offline', root })).results;
    expect(checkOf(result, 'tamaño')).toMatchObject({ ok: false });
  });

  it('una respuesta que nunca cumple el esquema agota los reintentos y el caso falla', async () => {
    const root = makeRoot([caso({}, { maxRetries: 2 })], { uno: { case: 'uno', responses: ['no es JSON', 'tampoco', 'ni esta'] } });
    const [result] = (await runEvals({ mode: 'offline', root })).results;
    expect(result.status).toBe('failed');
    expect(checkOf(result, 'generación')!.detail).toContain('tras 3 intentos');
  });

  it('una respuesta que incumple las reglas del módulo y no se corrige hace fallar el caso (verificación)', async () => {
    const root = makeRoot([caso({}, { maxRetries: 1 })], { uno: { case: 'uno', responses: [{ content: C4_RESPUESTA_SIN_ALCANCE }, { content: C4_RESPUESTA_SIN_ALCANCE }] } });
    const [result] = (await runEvals({ mode: 'offline', root })).results;
    expect(result.status).toBe('failed');
    expect(checkOf(result, 'generación')!.detail).toContain('cumpla las reglas del módulo');
  });

  it('una grabación a la que se le acaban las respuestas lo dice', async () => {
    const root = makeRoot([caso({}, { maxRetries: 2 })], { uno: { case: 'uno', responses: ['no es JSON'] } });
    const [result] = (await runEvals({ mode: 'offline', root })).results;
    expect(result.status).toBe('failed');
    expect(checkOf(result, 'generación')!.detail).toContain('la grabación solo tiene 1');
  });

  it('el bucle esperado se compara con el real: intentos, reintentos y verificación', async () => {
    const root = makeRoot([caso({ loop: { attempts: 2, repaired: true, retries: { schema: 1, rules: 0 } } })], { uno: buena() });
    const [result] = (await runEvals({ mode: 'offline', root })).results;
    const loop = checkOf(result, 'bucle')!;
    expect(loop.ok).toBe(false);
    expect(loop.detail).toContain('intentos: 1 en vez de 2');
    expect(loop.detail).toContain('repaired: false en vez de true');
    expect(loop.detail).toContain('reintentos por esquema: 0 en vez de 1');
  });

  it('un caso con strict devuelve también los avisos al modelo (retryOn: warning)', async () => {
    const root = makeRoot([caso({ loop: { attempts: 2, retries: { rules: 1 } } }, { strict: true })], {
      uno: { case: 'uno', responses: [{ content: { ...TIENDA, elements: TIENDA.elements.map((e) => (e.id === 'cliente' ? { ...e, description: null } : e)) } }, { content: TIENDA }] },
    });
    const [result] = (await runEvals({ mode: 'offline', root })).results;
    expect(result.status).toBe('passed');
    expect(result.attempts).toBe(2);
    // Sin strict, el mismo aviso no obliga a reintentar.
    const sinStrict = makeRoot([caso({ loop: { attempts: 1 } })], { uno: { case: 'uno', responses: [{ content: { ...TIENDA, elements: TIENDA.elements.map((e) => (e.id === 'cliente' ? { ...e, description: null } : e)) } }] } });
    expect((await runEvals({ mode: 'offline', root: sinStrict })).results[0].status).toBe('passed');
  });

  it('las expectativas sobre el prompt se comprueban sin necesidad de modelo', async () => {
    const root = makeRoot([caso({ prompt: { systemContains: ['no existe esta frase'], userContains: ['tienda en línea'], maxInputTokens: 10 } })], { uno: buena() });
    const [result] = (await runEvals({ mode: 'offline', root })).results;
    expect(checkOf(result, 'prompt')).toMatchObject({ ok: false });
    expect(checkOf(result, 'prompt')!.detail).toContain('sistema sin «no existe esta frase»');
    expect(checkOf(result, 'prompt-tamaño')).toMatchObject({ ok: false });
  });

  it('un módulo sin ai no puede ser un caso de generate', async () => {
    const root = makeRoot([caso()], { uno: buena() }, 'sinia');
    const registry = new ModuleRegistry().register(moduloFalso('sinia', false));
    const [result] = (await runEvals({ mode: 'offline', root, registry })).results;
    expect(result.status).toBe('failed');
    expect(checkOf(result, 'prompt')!.detail).toContain('no genera con IA');
  });

  it('filtra por módulo y por caso', async () => {
    const report = await runEvals({ mode: 'offline', modules: ['c4'], cases: ['tienda-en-linea', 'explicar-banca'] });
    expect(report.results.map((r) => `${r.module}/${r.id}`)).toEqual(['c4/tienda-en-linea', 'c4/explicar-banca']);
    expect((await runEvals({ mode: 'offline', modules: ['nada'] })).results).toEqual([]);
  });
});

describe('referencias (ref) en refinamientos', () => {
  const sinRefs = z.object({ nombre: z.string(), items: z.array(z.object({ id: z.string(), ref: z.string().optional() })) });
  const generacion = z.object({ nombre: z.string(), items: z.array(z.object({ id: z.string(), ref: z.string().nullable() })) });
  type Doc = z.infer<typeof sinRefs>;
  const ai: AiSpec<Doc> = {
    generationSchema: generacion,
    generationJsonSchema: () => ({ type: 'object' }),
    system: () => 'Generador de la prueba.',
    user: (instruction) => `Genera: ${instruction}`,
    retry: (issues) => `Corrige: ${issues}`,
    toDocument: (g) => {
      const gen = g as z.infer<typeof generacion>;
      return { ok: true, document: { nombre: gen.nombre, items: gen.items.map((i) => ({ id: i.id, ...(i.ref ? { ref: i.ref } : {}) })) } };
    },
  };
  const registry = new ModuleRegistry().register(moduloFalso('falso', true, ai));
  const respuesta = (ref: string | null) => ({ case: 'uno', responses: [{ content: { nombre: 'Demo', items: [{ id: 'a', ref }] } }] });

  it('un ref inventado por el modelo se detecta', async () => {
    const root = makeRoot([caso({}, { instruction: 'x' })], { uno: respuesta('urn:iark:falso:inventado') }, 'falso');
    const [result] = (await runEvals({ mode: 'offline', root, registry })).results;
    expect(result.status).toBe('failed');
    expect(checkOf(result, 'refs')!.detail).toContain('«urn:iark:falso:inventado» en /items#a no viene del documento base');
  });

  it('el ref del documento base se conserva aunque el modelo no lo devuelva', async () => {
    const base = { nombre: 'Demo', items: [{ id: 'a', ref: 'urn:iark:falso:a' }] };
    const root = makeRoot([caso({}, { base, instruction: 'x' })], { uno: respuesta(null) }, 'falso');
    const [result] = (await runEvals({ mode: 'offline', root, registry })).results;
    expect(result.status).toBe('passed');
    expect(checkOf(result, 'refs')).toMatchObject({ ok: true, detail: '1 ref del documento base conservados' });
  });

  it('noInventedRefs: false desactiva la comprobación', async () => {
    const root = makeRoot([caso({ noInventedRefs: false }, { instruction: 'x' })], { uno: respuesta('urn:iark:falso:inventado') }, 'falso');
    const [result] = (await runEvals({ mode: 'offline', root, registry })).results;
    expect(checkOf(result, 'refs')).toBeUndefined();
    expect(result.status).toBe('passed');
  });
});

describe('casos explain y review', () => {
  const texto = '## Resumen\nEl diagrama muestra una tienda con su web y su API.\n\n## Cómo funciona\nLa web llama a la API, que guarda en la base de datos. Todo ocurre dentro del sistema de la tienda.\n\n## Piezas clave\n- La API.';
  const explicar = (expectation: EvalCase['expect'] = {}): EvalCase => ({ id: 'uno', kind: 'explain', document: sampleDocument, expect: expectation });

  it('una explicación con las secciones y menciones esperadas pasa', async () => {
    const root = makeRoot([explicar({ headings: ['Resumen', 'Cómo funciona', 'Piezas clave'], mentions: ['API'], prompt: { userContains: ['"elements"'] } })], { uno: { case: 'uno', responses: [texto] } });
    const [result] = (await runEvals({ mode: 'offline', root })).results;
    expect(result.status).toBe('passed');
    expect(result.attempts).toBeUndefined();
    expect(result.tokens.output).toBeGreaterThan(0);
  });

  it('una respuesta que es JSON, que no tiene la sección pedida o que no menciona lo esperado falla', async () => {
    const json = makeRoot([explicar()], { uno: { case: 'uno', responses: ['{"resumen": "x"}'] } });
    expect(checkOf((await runEvals({ mode: 'offline', root: json })).results[0], 'markdown')).toMatchObject({ ok: false });

    const sinSeccion = makeRoot([explicar({ headings: ['Riesgos'], mentions: ['Kafka'] })], { uno: { case: 'uno', responses: [texto] } });
    const [result] = (await runEvals({ mode: 'offline', root: sinSeccion })).results;
    expect(result.status).toBe('failed');
    expect(checkOf(result, 'secciones')!.detail).toBe('faltan: Riesgos');
    expect(checkOf(result, 'menciones')!.detail).toBe('no menciona: Kafka');
  });

  it('una respuesta vacía, demasiado corta o cortada por el tope de salida falla', async () => {
    const vacia = makeRoot([explicar()], { uno: { case: 'uno', responses: ['   '] } });
    expect(checkOf((await runEvals({ mode: 'offline', root: vacia })).results[0], 'respuesta')).toMatchObject({ ok: false });

    const corta = makeRoot([explicar()], { uno: { case: 'uno', responses: ['## Resumen\nPoco.'] } });
    expect(checkOf((await runEvals({ mode: 'offline', root: corta })).results[0], 'tamaño')).toMatchObject({ ok: false });

    const cortada = makeRoot([explicar()], { uno: { case: 'uno', responses: [{ content: texto, finish_reason: 'length' }] } });
    const [result] = (await runEvals({ mode: 'offline', root: cortada })).results;
    expect(checkOf(result, 'respuesta')).toMatchObject({ ok: false, detail: 'la respuesta se cortó por el tope de salida' });
  });

  it('en review el prompt lleva las incidencias de validate() del módulo', async () => {
    const sinDescripcion = structuredClone(sampleDocument);
    sinDescripcion.model.elements[0].description = '';
    const root = makeRoot([{ id: 'uno', kind: 'review', document: sinDescripcion, expect: { prompt: { userContains: ['Incidencias del validador del módulo (', 'no tiene descripción'] } } }], { uno: { case: 'uno', responses: [texto] } });
    const [result] = (await runEvals({ mode: 'offline', root })).results;
    expect(checkOf(result, 'prompt')).toMatchObject({ ok: true });
  });
});

describe('huella del prompt de las grabaciones', () => {
  it('una huella que no coincide es un aviso y no un fallo; sin huella también avisa', async () => {
    const root = makeRoot([caso(), { ...caso(), id: 'dos' }], { uno: buena({ promptSha256: 'f'.repeat(64) }), dos: { ...buena(), case: 'dos' } });
    const report = await runEvals({ mode: 'offline', root });
    expect(report.results.map((r) => r.status)).toEqual(['passed', 'passed']);
    expect(report.results[0].warnings[0]).toContain('grabación obsoleta');
    expect(report.results[1].warnings[0]).toContain('no tiene la huella del prompt');
    expect(formatReport(report)).toContain('Avisos');
  });

  it('--update-hashes la escribe y deja de avisar', async () => {
    const root = makeRoot([caso()], { uno: buena({ notes: 'a mano' }) });
    await runEvals({ mode: 'offline', root, updateHashes: true });
    const written = JSON.parse(readFileSync(recordingPath(root, 'c4', 'uno'), 'utf8')) as { promptSha256: string; notes: string; responses: unknown[] };
    expect(written.promptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(written.notes).toBe('a mano');
    expect(written.responses).toHaveLength(1);
    expect((await runEvals({ mode: 'offline', root })).results[0].warnings).toEqual([]);
  });
});

describe('informe', () => {
  it('por módulo y por caso, con el detalle de lo que falla y los totales', async () => {
    const root = makeRoot([caso({ kinds: { container: 9 } }), { ...caso(), id: 'dos' }], { uno: buena(), dos: { ...buena(), case: 'dos' } });
    const report = await runEvals({ mode: 'offline', root });
    const text = formatReport(report);
    expect(text).toContain('modo offline (cliente simulado, respuestas grabadas)');
    expect(text).toContain('tokens ESTIMADOS');
    expect(text).toMatch(/c4\s+2\s+1\s+\d+ %/);
    expect(text).toMatch(/TOTAL\s+2\s+1/);
    expect(text).toContain('✗ c4 / uno [generate]');
    expect(text).toContain('✓ c4 / dos [generate]');
    expect(text).toContain('✗ entidades: container: 3 de 9');
    expect(text).not.toContain('✓ esquema');
    expect(text).toContain('1 caso(s) fallan de 2');
    expect(formatReport(report, { verbose: true })).toContain('✓ esquema: cumple el esquema del documento');
  });

  it('un informe sin fallos termina con la frase de «todo en orden»', async () => {
    const text = formatReport(await runEvals({ mode: 'offline', modules: ['data'] }));
    expect(text).toContain('Todo en orden: 1 de 1 caso(s) superados (100 %).');
  });
});

describe('modo live (contra un servicio simulado: no se llama a ningún modelo real)', () => {
  const env: Env = { AI_BASE_URL: 'https://recurso.openai.azure.com/openai/v1', AI_API_KEY: 'clave-de-prueba', AI_MODEL: 'modelo-vivo' };
  const buenaTexto = JSON.stringify(TIENDA);

  it('usa el modelo y los topes configurados, cuenta los tokens que informa el proveedor y no exige la forma exacta del bucle', async () => {
    const modelo = simulateChat([{ content: buenaTexto, usage: { prompt_tokens: 1500, completion_tokens: 400 } }]);
    vi.stubGlobal('fetch', modelo.fetch);
    const report = await runEvals({ mode: 'live', modules: ['c4'], cases: ['tienda-en-linea'], provider: 'openai', env, maxTokens: 777, budgetTokens: 50_000 });
    expect(modelo.calls).toHaveLength(1);
    expect(modelo.calls[0].url).toContain('recurso.openai.azure.com');
    expect(modelo.calls[0].body.model).toBe('modelo-vivo');
    expect(modelo.calls[0].body.max_tokens).toBe(777);
    expect(report).toMatchObject({ mode: 'live', provider: 'openai', model: 'modelo-vivo' });
    const [result] = report.results;
    expect(result.status).toBe('passed');
    expect(result.tokens).toEqual({ input: 1500, output: 400 });
    expect(result.checks.map((c) => c.name)).not.toContain('bucle');
    expect(formatReport(report)).not.toContain('ESTIMADOS');
  });

  it('un modelo que contesta mal hace fallar el caso con el motivo', async () => {
    vi.stubGlobal('fetch', simulateChat(['No puedo ayudarte con eso.']).fetch);
    const report = await runEvals({ mode: 'live', modules: ['c4'], cases: ['tienda-en-linea'], provider: 'openai', env });
    expect(report.results[0].status).toBe('failed');
    expect(report.total.failed).toBe(1);
  });

  it('el presupuesto de la ejecución omite los casos que quedan cuando se agota', async () => {
    const modelo = simulateChat([{ content: buenaTexto, usage: { prompt_tokens: 1500, completion_tokens: 400 } }]);
    vi.stubGlobal('fetch', modelo.fetch);
    const report = await runEvals({ mode: 'live', modules: ['c4'], cases: ['tienda-en-linea', 'banca-reintento-esquema', 'explicar-banca'], provider: 'openai', env, runBudgetTokens: 1000 });
    expect(report.results.map((r) => r.status)).toEqual(['passed', 'skipped', 'skipped']);
    expect(report.total).toMatchObject({ passed: 1, skipped: 2, failed: 0 });
    expect(modelo.calls).toHaveLength(1);
    expect(report.results[1].warnings[0]).toContain('se agotó el presupuesto de la ejecución');
    expect(formatReport(report)).toContain('(2 omitido(s))');
  });
});

describe('liveSetupProblem', () => {
  it('pide las credenciales de la plataforma elegida', () => {
    expect(liveSetupProblem('anthropic', {})).toContain('ANTHROPIC_API_KEY');
    expect(liveSetupProblem('anthropic', { ANTHROPIC_API_KEY: 'k' })).toBeUndefined();
    expect(liveSetupProblem('foundry', { ANTHROPIC_FOUNDRY_API_KEY: 'k' })).toContain('ANTHROPIC_FOUNDRY_MODEL');
    expect(liveSetupProblem('foundry', { ANTHROPIC_FOUNDRY_API_KEY: 'k', ANTHROPIC_FOUNDRY_RESOURCE: 'r', ANTHROPIC_FOUNDRY_MODEL: 'm' })).toBeUndefined();
    expect(liveSetupProblem('openai', { AI_API_KEY: 'k' })).toContain('AI_BASE_URL');
    expect(liveSetupProblem('openai', { AI_API_KEY: 'k', AI_BASE_URL: 'https://x/openai/v1', AI_MODEL: 'm' })).toBeUndefined();
    // «auto» elige según el entorno.
    expect(liveSetupProblem('auto', { AI_BASE_URL: 'https://x/openai/v1' })).toContain('AI_API_KEY');
  });
});

describe('línea de comandos (main)', () => {
  const run = async (argv: string[], env: Env = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(argv, { out: (s) => out.push(s), err: (s) => err.push(s), env });
    return { code, out: out.join(''), err: err.join('') };
  };
  const liveEnv: Env = { AI_BASE_URL: 'https://recurso.openai.azure.com/openai/v1', AI_API_KEY: 'k', AI_MODEL: 'm' };

  it('offline por omisión: informe en stdout y código 0', async () => {
    const r = await run(['--module', 'data']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('modo offline');
    expect(r.out).toContain('data / ventas-lakehouse');
  });

  it('--json escribe el informe completo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iark-evals-json-'));
    roots.push(dir);
    const archivo = join(dir, 'sub', 'informe.json');
    const r = await run(['--module', 'platform', '--json', archivo]);
    expect(r.code).toBe(0);
    const informe = JSON.parse(readFileSync(archivo, 'utf8')) as { mode: string; total: { passed: number; cases: number } };
    expect(informe).toMatchObject({ mode: 'offline', total: { passed: 1, cases: 1 } });
  });

  it('un caso que falla da código 1 y lo dice en el informe', async () => {
    const root = makeRoot([caso({ kinds: { container: 9 } })], { uno: buena() });
    const out: string[] = [];
    const code = await main([], { out: (s) => out.push(s), err: () => {}, env: {}, root });
    expect(code).toBe(1);
    expect(out.join('')).toContain('1 caso(s) fallan de 1');
  });

  it('un uso incorrecto da código 2: sin casos, opción desconocida, modo o tope inválidos', async () => {
    expect((await run(['--module', 'nada'])).code).toBe(2);
    expect((await run(['--module', 'nada'])).err).toContain('No hay casos que ejecutar');
    expect((await run(['--no-existe'])).code).toBe(2);
    expect((await run(['--mode', 'raro'])).err).toContain('--mode debe ser offline o live');
    expect((await run(['--provider', 'raro'])).code).toBe(2);
    const tope = await run(['--max-tokens', 'abc']);
    expect(tope.code).toBe(2);
    expect(tope.err).toContain('--max-tokens debe ser un entero positivo');
  });

  it('--help describe el uso y los dos modos', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('npm run evals:live');
    expect(r.out).toContain('--run-budget-tokens');
  });

  it('live sin credenciales o sin --yes se niega (código 2) sin llamar al modelo', async () => {
    const llamadas = vi.fn();
    vi.stubGlobal('fetch', llamadas);
    const sinClaves = await run(['--mode', 'live', '--yes'], {});
    expect(sinClaves.code).toBe(2);
    expect(sinClaves.err).toContain('ANTHROPIC_API_KEY');
    expect(sinClaves.out).toBe('');
    const sinYes = await run(['--mode', 'live', '--provider', 'openai'], liveEnv);
    expect(sinYes.code).toBe(2);
    expect(sinYes.err).toContain('--yes');
    expect(sinYes.out).toBe('');
    expect(llamadas).not.toHaveBeenCalled();
  });

  it('live con credenciales y --yes corre contra el servicio (simulado aquí) y avisa del progreso por stderr', async () => {
    const modelo = simulateChat([JSON.stringify(TIENDA)]);
    vi.stubGlobal('fetch', modelo.fetch);
    const r = await run(['--mode', 'live', '--provider', 'openai', '--yes', '--module', 'c4', '--case', 'tienda-en-linea', '--max-tokens', '900'], liveEnv);
    expect(r.code).toBe(0);
    expect(r.out).toContain('modo live (openai, m)');
    expect(r.err).toContain('c4 / tienda-en-linea');
    expect(modelo.calls[0].body.max_tokens).toBe(900);
  });
});

/** Un módulo mínimo para probar el ejecutor con otras reglas; con `ai` si `generates`. */
function moduloFalso(id: string, generates: boolean, ai?: AiSpec<{ nombre: string; items: Array<{ id: string; ref?: string }> }>): DomainModule<{ nombre: string; items: Array<{ id: string; ref?: string }> }> {
  type Doc = { nombre: string; items: Array<{ id: string; ref?: string }> };
  return {
    id,
    name: `Módulo ${id}`,
    version: '0.0.1',
    documentVersion: '1.0',
    schema: z.object({ nombre: z.string(), items: z.array(z.object({ id: z.string(), ref: z.string().optional() })) }),
    jsonSchema: () => ({}),
    validate: () => [],
    entities: (doc: Doc) => doc.items.map((i) => ({ id: i.id, name: i.id, kind: 'item' })),
    importers: [],
    exporters: [{ id: 'json', label: 'JSON', extension: '.json', mime: 'application/json', export: (doc: Doc) => JSON.stringify(doc) }],
    ...(generates && ai ? { ai } : {}),
  };
}
