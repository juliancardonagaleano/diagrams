import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sampleDocument } from '@core/model/sample';
import { runCli, simulateChat, withModelEnv } from '../../tests/helpers/modeloSimulado';

// `iark explain` y `iark review` con un modelo simulado: el prompt que se arma sobre `AiSpec`, la salida en Markdown, las
// incidencias de `validate()` como contexto de la revisión y los topes de tokens. Ninguna llamada usa la red.

const EXPLICACION = '## Resumen\nLa banca en línea deja a los clientes ver saldos y pagar.\n\n## Cómo funciona\nLa app web llama a la API.';
const REVISION = '## Resumen\nModelo razonable.\n\n## Incidencias del validador\nSin incidencias.\n\n## Riesgos\n- La API es un punto único de fallo.';
const banca = 'examples/banca.json';
const seguridad = 'examples/seguridad-ejemplo.json';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'iark-comentario-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const prompts = (modelo: ReturnType<typeof simulateChat>) => {
  const [system, user] = modelo.calls[0].body.messages;
  return { system: system.content, user: user.content };
};

describe('iark explain', () => {
  it('narra el diagrama en Markdown por stdout, con el prompt montado sobre el módulo, sin coordenadas y con el uso por stderr', async () => {
    const modelo = simulateChat([{ content: EXPLICACION, usage: { prompt_tokens: 2100, completion_tokens: 160 } }]);
    const r = await withModelEnv(() => runCli(['explain', banca, '--provider', 'openai'], modelo));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(`${EXPLICACION}\n`);
    expect(modelo.calls).toHaveLength(1);
    const { system, user } = prompts(modelo);
    expect(system).toContain('«## Resumen»');
    expect(system).toContain('módulo «Arquitectura de soluciones (C4)» (id «c4»');
    // La guía propia del módulo C4 y la proyección sin coordenadas.
    expect(system).toContain('Narra de lo general a lo particular');
    expect(user).toContain('"elements"');
    expect(user).not.toMatch(/"x":|"y":|"width"/);
    // Sin response_format: es texto, no salida estructurada.
    expect(modelo.calls[0].body.response_format).toBeUndefined();
    expect(r.stderr).toContain('Respuesta de modelo-simulado (openai): 2.100 tokens de entrada, 160 de salida.');
    expect(r.stderr).toContain('Presupuesto: 2.260 de 200.000 tokens');
    expect(r.stderr).not.toContain('validador');
  });

  it('--out escribe el Markdown en un archivo y deja stdout vacío; --lang en cambia el idioma pedido', async () => {
    const modelo = simulateChat([EXPLICACION]);
    const out = join(dir, 'explicacion.md');
    const r = await withModelEnv(() => runCli(['explain', banca, '--provider', 'openai', '--out', out, '--lang', 'en'], modelo));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
    expect(readFileSync(out, 'utf8')).toBe(`${EXPLICACION}\n`);
    expect(prompts(modelo).system).toContain('Write the whole answer in English.');
    expect(r.stderr).toContain(`Explicación escrita en ${out}`);
  });

  it('funciona con cualquier módulo (--module): usa su guía y su proyección', async () => {
    const modelo = simulateChat([EXPLICACION]);
    const r = await withModelEnv(() => runCli(['explain', seguridad, '--module', 'security', '--provider', 'openai'], modelo));
    expect(r.exitCode).toBe(0);
    const { system, user } = prompts(modelo);
    expect(system).toContain('(id «security»');
    expect(system).toContain('zonas de confianza');
    expect(user).toContain('"zones"');
  });

  it('un archivo que incumple el esquema del módulo se rechaza, sin llamar al modelo', async () => {
    const modelo = simulateChat([EXPLICACION]);
    const roto = join(dir, 'roto.json');
    writeFileSync(roto, JSON.stringify({ version: '1.0', workspace: { name: 'x' }, zones: 5 }));
    const r = await withModelEnv(() => runCli(['explain', roto, '--module', 'security', '--provider', 'openai'], modelo));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('Documento inválido para el módulo «security»');
    expect(modelo.calls).toHaveLength(0);
  });

  it('un módulo que no existe se rechaza', async () => {
    const r = await withModelEnv(() => runCli(['explain', banca, '--module', 'nada']));
    expect(r.exitCode).toBe(2);
  });

  it('acepta una fuente importable, no solo JSON (Mermaid)', async () => {
    const modelo = simulateChat([EXPLICACION]);
    const r = await withModelEnv(() => runCli(['explain', 'examples/banca.mmd', '--provider', 'openai'], modelo));
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('Diagrama importado de mermaid.');
    expect(prompts(modelo).user).toContain('"elements"');
  });

  it('una respuesta cortada por --max-tokens se entrega parcial con el aviso, no como error', async () => {
    const modelo = simulateChat([{ content: '## Resumen\nEmpieza y se', finish: 'length', usage: { prompt_tokens: 900, completion_tokens: 50 } }]);
    const r = await withModelEnv(() => runCli(['explain', banca, '--provider', 'openai', '--max-tokens', '50'], modelo));
    expect(r.exitCode).toBe(0);
    expect(modelo.calls[0].body.max_tokens).toBe(50);
    expect(r.stdout).toContain('Empieza y se');
    expect(r.stderr).toContain('AVISO: la respuesta se cortó por el tope de salida');
  });

  it('respeta los topes: entrada demasiado grande (2) y presupuesto insuficiente (4), antes de llamar', async () => {
    const modelo = simulateChat([EXPLICACION]);
    const grande = await withModelEnv(() => runCli(['explain', banca, '--provider', 'openai', '--max-input-tokens', '300'], modelo));
    expect(grande.exitCode).toBe(2);
    expect(grande.stderr).toContain('supera el máximo permitido de 300');
    const corto = await withModelEnv(() => runCli(['explain', banca, '--provider', 'openai', '--budget-tokens', '300'], modelo));
    expect(corto.exitCode).toBe(4);
    expect(modelo.calls).toHaveLength(0);
  });

  it('sin credenciales da el mensaje de qué definir (código 4) y no escribe nada', async () => {
    const out = join(dir, 'sin-credenciales.md');
    const r = await withModelEnv(() => runCli(['explain', banca, '--provider', 'openai', '--out', out]), { credentials: false });
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain('AI_API_KEY');
    expect(existsSync(out)).toBe(false);
  });

  it('una respuesta vacía es un error, no un archivo vacío', async () => {
    const r = await withModelEnv(() => runCli(['explain', banca, '--provider', 'openai'], simulateChat(['   '])));
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain('El modelo no devolvió texto.');
  });
});

describe('iark review', () => {
  it('pasa al modelo las incidencias de validate() como contexto y devuelve el Markdown', async () => {
    // Un documento C4 con avisos: elementos sin descripción.
    const doc = join(dir, 'revisable.json');
    const modelo = simulateChat([REVISION]);
    const sinDescripcion = structuredClone(sampleDocument);
    sinDescripcion.model.elements[0].description = '';
    writeFileSync(doc, JSON.stringify(sinDescripcion));
    const r = await withModelEnv(() => runCli(['review', doc, '--provider', 'openai'], modelo));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(`${REVISION}\n`);
    const { system, user } = prompts(modelo);
    expect(system).toContain('Eres un revisor de arquitectura');
    expect(system).toContain('Mira: elementos sin descripción o sin tecnología');
    expect(user).toMatch(/Incidencias del validador del módulo \(\d+\):\n- \[warning\] ".*" no tiene descripción \(elemento «/);
    expect(r.stderr).toMatch(/El validador del módulo «c4» encontró 0 error\(es\), \d+ aviso\(s\) y 0 nota\(s\); se le pasan al modelo\./);
    expect(r.stderr).toContain('Respuesta de modelo-simulado (openai)');
  });

  it('con otro módulo usa su guía de revisión y sus incidencias', async () => {
    const modelo = simulateChat([REVISION]);
    const r = await withModelEnv(() => runCli(['review', 'examples/pedidos-integracion.json', '--module', 'integration', '--provider', 'openai', '--lang', 'en'], modelo));
    expect(r.exitCode).toBe(0);
    const { system, user } = prompts(modelo);
    expect(system).toContain('cadenas de llamadas síncronas');
    expect(system).toContain('Write the whole answer in English.');
    expect(user).toContain('Incidencias del validador del módulo (');
    expect(user).toContain('"nodes"');
  });

  it('--out escribe el archivo y comparte los topes de explain', async () => {
    const modelo = simulateChat([REVISION]);
    const out = join(dir, 'revision.md');
    const r = await withModelEnv(() => runCli(['review', banca, '--provider', 'openai', '--out', out, '--max-tokens', '900'], modelo));
    expect(r.exitCode).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(`${REVISION}\n`);
    expect(modelo.calls[0].body.max_tokens).toBe(900);
    expect(r.stderr).toContain(`Revisión escrita en ${out}`);
  });
});
