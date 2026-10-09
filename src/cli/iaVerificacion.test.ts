import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { C4_RESPUESTA_BUENA, C4_RESPUESTA_SIN_ALCANCE, runCli, simulateChat, withModelEnv } from '../../tests/helpers/modeloSimulado';
import { makeRepo, removeRepo } from '../../tests/helpers/repoFixture';

// `iark generate` con un modelo simulado (Chat Completions de Foundry): bucle de verificación con `validate()`, topes de tokens y
// `--from-repo` con un prompt excesivo. Todo en el propio proceso: ninguna prueba usa la red ni credenciales reales.

const buena = JSON.stringify(C4_RESPUESTA_BUENA);
const sinAlcance = JSON.stringify(C4_RESPUESTA_SIN_ALCANCE);
const generate = (extra: string[] = []) => ['generate', 'Una tienda en línea', '--provider', 'openai', '--direction', 'DOWN', ...extra];

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'iark-ia-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

describe('iark generate: bucle de verificación con validate()', () => {
  it('devuelve al modelo el error de reglas, escribe el documento corregido e informa de los intentos y del presupuesto', async () => {
    const modelo = simulateChat([{ content: sinAlcance, usage: { prompt_tokens: 900, completion_tokens: 400 } }, { content: buena, usage: { prompt_tokens: 1500, completion_tokens: 410 } }]);
    const json = join(dir, 'tienda.json');
    const r = await withModelEnv(() => runCli(generate(['--json', json]), modelo));
    expect(r.exitCode).toBe(0);
    expect(modelo.calls).toHaveLength(2);
    // El reintento lleva el texto de la incidencia con su gravedad y su vista.
    const correccion = modelo.calls[1].body.messages.at(-1)!;
    expect(correccion.role).toBe('user');
    expect(correccion.content).toMatch(/\[error\] La vista "Contenedores" \(container\) necesita un alcance/);
    expect(r.stderr).toContain('Modelo generado con modelo-simulado (openai) en 2 intento(s)');
    expect(r.stderr).toContain('intento 1 (inicial): incumple las reglas del módulo · 900 tokens de entrada, 400 de salida');
    expect(r.stderr).toContain('intento 2 (corrige las reglas): válido · 1.500 tokens de entrada, 410 de salida');
    expect(r.stderr).toContain('Reintentos: 0 por el esquema, 1 por las reglas del módulo.');
    expect(r.stderr).toContain('Verificación con las reglas del módulo: sin errores');
    expect(r.stderr).toContain('Presupuesto: 3.210 de 200.000 tokens (salida máxima por llamada 16.000; entrada máxima 100.000).');
    const documento = JSON.parse(readFileSync(json, 'utf8'));
    expect(documento.views.every((v: { type: string; scopeId?: string }) => v.type === 'systemContext' || v.scopeId === 'tienda')).toBe(true);
  }, 30_000);

  it('agotados los reintentos sale con código 3 y el informe de incidencias, sin escribir nada, y dice cómo aceptarlo', async () => {
    const modelo = simulateChat([sinAlcance]);
    const json = join(dir, 'rechazado.json');
    const r = await withModelEnv(() => runCli(generate(['--json', json]), modelo));
    expect(r.exitCode).toBe(3);
    expect(modelo.calls).toHaveLength(2);
    expect(r.stderr).toMatch(/Error generando el modelo: El modelo no produjo un documento que cumpla las reglas del módulo tras 2 intentos:\n- \[error\] La vista "Contenedores" \(container\) necesita un alcance/);
    expect(r.stderr).toContain('--allow-invalid');
    expect(r.stderr).toContain('--no-verify');
    expect(existsSync(json)).toBe(false);
  });

  it('--allow-invalid acepta el documento con errores de reglas, lo escribe y lo avisa', async () => {
    const modelo = simulateChat([sinAlcance]);
    const json = join(dir, 'aceptado.json');
    const r = await withModelEnv(() => runCli(generate(['--json', json, '--allow-invalid']), modelo));
    expect(r.exitCode).toBe(0);
    expect(existsSync(json)).toBe(true);
    expect(r.stderr).toContain('AVISO: el documento incumple 1 regla(s) del módulo y se aceptó por --allow-invalid');
    expect(r.stderr).toContain('necesita un alcance');
  });

  it('--no-verify no pasa por validate() ni reintenta, y lo dice', async () => {
    const modelo = simulateChat([sinAlcance]);
    const r = await withModelEnv(() => runCli(generate(['--json', join(dir, 'sin-verificar.json'), '--no-verify']), modelo));
    expect(r.exitCode).toBe(0);
    expect(modelo.calls).toHaveLength(1);
    expect(r.stderr).toContain('Verificación con las reglas del módulo: omitida.');
  });

  it('--retries 0 no da una segunda oportunidad: un error de reglas falla a la primera', async () => {
    const modelo = simulateChat([sinAlcance]);
    const r = await withModelEnv(() => runCli(generate(['--retries', '0']), modelo));
    expect(r.exitCode).toBe(3);
    expect(modelo.calls).toHaveLength(1);
  });

  it('--strict también devuelve al modelo los avisos de validate()', async () => {
    // La buena trae un aviso (la base de datos no tiene descripción): sin --strict pasa a la primera; con --strict, se reintenta.
    const modelo = simulateChat([buena, JSON.stringify({ ...C4_RESPUESTA_BUENA, elements: C4_RESPUESTA_BUENA.elements.map((e) => ({ ...e, description: e.description ?? 'Guarda los pedidos' })) })]);
    const r = await withModelEnv(() => runCli(generate(['--json', join(dir, 'estricto.json'), '--strict']), modelo));
    expect(r.exitCode).toBe(0);
    expect(modelo.calls).toHaveLength(2);
    expect(modelo.calls[1].body.messages.at(-1)!.content).toMatch(/\[warning\] "Base de datos" no tiene descripción/);
  });

  it('con otro módulo (generic) también informa de la verificación y del presupuesto', async () => {
    const vacio = JSON.stringify({ workspace: { name: 'Datos', description: null }, domains: [], assets: [], pipelines: [], relations: [], terms: [] });
    const modelo = simulateChat([vacio]);
    const r = await withModelEnv(() => runCli(['generate', 'Un modelo de datos vacío', '--module', 'data', '--provider', 'openai', '--json', join(dir, 'datos.json')], modelo));
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('Verificación con las reglas del módulo');
    expect(r.stderr).toContain('Presupuesto: 200 de 200.000 tokens');
  });
});

describe('iark generate: topes de tokens', () => {
  it('--max-tokens fija la salida máxima por llamada y IARK_AI_MAX_TOKENS la fija si no se indica', async () => {
    const modelo = simulateChat([buena]);
    await withModelEnv(() => runCli(generate(['--json', join(dir, 'a.json'), '--max-tokens', '777']), modelo));
    expect(modelo.calls[0].body.max_tokens).toBe(777);
    const porEntorno = simulateChat([buena]);
    await withModelEnv(() => runCli(generate(['--json', join(dir, 'b.json')]), porEntorno), { env: { IARK_AI_MAX_TOKENS: '555' } });
    expect(porEntorno.calls[0].body.max_tokens).toBe(555);
    const porOmision = simulateChat([buena]);
    await withModelEnv(() => runCli(generate(['--json', join(dir, 'c.json')]), porOmision));
    expect(porOmision.calls[0].body.max_tokens).toBe(16_000);
  });

  it('una respuesta cortada por --max-tokens falla (código 4) diciendo cuál era el tope', async () => {
    const modelo = simulateChat([{ content: '{"workspace"', finish: 'length', usage: { prompt_tokens: 300, completion_tokens: 777 } }]);
    const r = await withModelEnv(() => runCli(generate(['--max-tokens', '777']), modelo));
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toMatch(/Error generando el modelo: La respuesta excedió el límite de tokens de salida \(777, --max-tokens.*Gastado: 1\.077 tokens/);
  });

  it('--budget-tokens: al agotarse entre reintentos se detiene (código 4) e informa lo gastado, sin llamar de más', async () => {
    const modelo = simulateChat([{ content: sinAlcance, usage: { prompt_tokens: 6000, completion_tokens: 1000 } }]);
    const r = await withModelEnv(() => runCli(generate(['--budget-tokens', '9000', '--retries', '5']), modelo));
    expect(r.exitCode).toBe(4);
    expect(modelo.calls).toHaveLength(1);
    expect(r.stderr).toMatch(/El presupuesto de 9\.000 tokens \(--budget-tokens.*se agotó tras 1 intento\(s\): gastados 7\.000 tokens \(6\.000 de entrada y 1\.000 de salida\)/);
  });

  it('--budget-tokens menor que la entrada estimada se rechaza antes de llamar', async () => {
    const modelo = simulateChat([buena]);
    const r = await withModelEnv(() => runCli(generate(['--budget-tokens', '300']), modelo));
    expect(r.exitCode).toBe(4);
    expect(modelo.calls).toHaveLength(0);
    expect(r.stderr).toContain('no alcanza ni para la entrada estimada de la primera llamada');
  });

  it('--max-input-tokens rechaza un prompt demasiado grande antes de llamar (código 2) y dice qué hacer', async () => {
    const modelo = simulateChat([buena]);
    const r = await withModelEnv(() => runCli(generate(['--max-input-tokens', '500']), modelo));
    expect(r.exitCode).toBe(2);
    expect(modelo.calls).toHaveLength(0);
    expect(r.stderr).toMatch(/supera el máximo permitido de 500 \(--max-input-tokens/);
    expect(r.stderr).toContain('Acorte la instrucción');
    expect(r.stderr).not.toContain('--repo-budget');
  });

  it('valida las opciones de tokens al leerlas', async () => {
    for (const flag of ['--max-tokens', '--budget-tokens', '--max-input-tokens']) {
      const r = await withModelEnv(() => runCli(generate([flag, 'muchos'])));
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain(`${flag} debe ser un entero positivo`);
    }
  });
});

describe('iark generate --from-repo: prompt excesivo', () => {
  let repo: string;
  beforeAll(() => {
    // Un README enorme y un servicio pequeño: el resumen supera cualquier máximo de entrada bajo.
    const lineas = Array.from({ length: 400 }, (_, i) => `Línea ${i}: el servicio ${i} usa la cola ${i} y la base de datos ${i} de la tienda.`);
    repo = makeRepo({ 'README.md': `# Tienda\n${lineas.join('\n')}`, 'servicio/README.md': '# Servicio\nPequeño', 'package.json': '{"name":"tienda"}' });
  });
  afterAll(() => removeRepo(repo));

  it('se rechaza antes de llamar al modelo y el error dice qué recortar del repositorio', async () => {
    const modelo = simulateChat([buena]);
    const r = await withModelEnv(() => runCli(generate(['--from-repo', repo, '--max-input-tokens', '3500']), modelo));
    expect(r.exitCode).toBe(2);
    expect(modelo.calls).toHaveLength(0);
    expect(r.stderr).toMatch(/supera el máximo permitido de 3\.500/);
    expect(r.stderr).toContain('Qué recortar');
    expect(r.stderr).toContain('--repo-budget (hoy 60 KB');
    expect(r.stderr).toContain('--repo-include');
    expect(r.stderr).toContain('--repo-exclude');
    expect(r.stderr).toContain('--dry-run');
  });

  it('con --repo-budget el error cita el valor aplicado, y un resumen más pequeño sí pasa', async () => {
    const modelo = simulateChat([buena]);
    const apretado = await withModelEnv(() => runCli(generate(['--from-repo', repo, '--repo-budget', '8', '--max-input-tokens', '3000']), modelo));
    expect(apretado.stderr).toContain('--repo-budget (hoy 8 KB');
    const pequeno = await withModelEnv(() => runCli(generate(['--from-repo', repo, '--repo-budget', '1', '--repo-include', 'servicio/', '--max-input-tokens', '9000', '--json', join(dir, 'repo.json')]), modelo));
    expect(pequeno.exitCode).toBe(0);
    expect(modelo.calls).toHaveLength(1);
  }, 30_000);

  it('--dry-run enseña el tamaño estimado del prompt frente al máximo, sin llamar al modelo', async () => {
    const modelo = simulateChat([buena]);
    const r = await withModelEnv(() => runCli(generate(['--from-repo', repo, '--dry-run', '--max-input-tokens', '3500']), modelo));
    expect(r.exitCode).toBe(0);
    expect(modelo.calls).toHaveLength(0);
    expect(r.stderr).toMatch(/Tamaño estimado del prompt: ~[\d.]+ tokens de entrada \(máximo 3\.500, --max-input-tokens\)\. SUPERA el máximo/);
    const ok = await withModelEnv(() => runCli(generate(['--from-repo', repo, '--dry-run']), modelo));
    expect(ok.stderr).toMatch(/Tamaño estimado del prompt: ~[\d.]+ tokens de entrada \(máximo 100\.000, --max-input-tokens\)\.$/m);
  });

  it('iark prompt --from-repo también informa del tamaño estimado por stderr', async () => {
    const r = await withModelEnv(() => runCli(['prompt', 'Dibuja la arquitectura', '--from-repo', repo]), undefined);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('Tamaño estimado del prompt');
    expect(r.stdout).not.toContain('Tamaño estimado');
  });
});
