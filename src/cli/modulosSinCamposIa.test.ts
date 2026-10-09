import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModuleRegistry, type AiSpec, type DomainModule, type ModuleIssue } from '@iark/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runCli, simulateChat, withModelEnv } from '../../tests/helpers/modeloSimulado';

// Compatibilidad: un módulo (o un plugin) escrito antes de que `AiSpec` ganara `serialize`, `explainGuide` y `reviewGuide`, e incluso
// uno sin `ai`, tiene que seguir funcionando con `generate`, `explain` y `review`: los campos nuevos son opcionales.

interface Doc {
  nombre: string;
  items: string[];
}

const generationSchema = z.object({ nombre: z.string(), items: z.array(z.string()) });

/** Una `AiSpec` con SOLO los campos que existían antes. */
const specAntigua: AiSpec<Doc> = {
  generationSchema,
  generationJsonSchema: () => ({ type: 'object' }),
  system: () => 'Eres un generador de la prueba.',
  user: (instruction) => `Genera: ${instruction}`,
  retry: (issues) => `Corrige: ${issues}`,
  toDocument: (generated) => ({ ok: true, document: generated as Doc }),
};

function moduloDeTercero(id: string, ai?: AiSpec<Doc>): DomainModule<Doc> {
  return {
    id,
    name: `Módulo ${id}`,
    version: '0.0.1',
    documentVersion: '1.0',
    schema: z.object({ nombre: z.string(), items: z.array(z.string()) }),
    jsonSchema: () => ({}),
    validate: (doc): ModuleIssue[] => (doc.items.length === 0 ? [{ severity: 'error', message: 'No hay elementos', elementId: 'items' }] : []),
    importers: [],
    exporters: [{ id: 'json', label: 'JSON', extension: '.json', mime: 'application/json', export: (doc) => JSON.stringify(doc) }],
    ai,
  };
}

const registry = new ModuleRegistry().register(moduloDeTercero('conia', specAntigua)).register(moduloDeTercero('sinia'));
let dir: string;
let archivo: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'iark-plugin-'));
  archivo = join(dir, 'doc.json');
  writeFileSync(archivo, JSON.stringify({ nombre: 'Demo', items: ['a'] }));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('módulos sin los campos nuevos de AiSpec', () => {
  it('generate: verifica con validate() del módulo y reintenta por sus errores', async () => {
    const modelo = simulateChat([JSON.stringify({ nombre: 'Demo', items: [] }), JSON.stringify({ nombre: 'Demo', items: ['a'] })]);
    const json = join(dir, 'generado.json');
    const r = await withModelEnv(() => runCli(['generate', 'algo', '--module', 'conia', '--provider', 'openai', '--json', json], modelo, registry));
    expect(r.exitCode).toBe(0);
    expect(modelo.calls).toHaveLength(2);
    expect(modelo.calls[1].body.messages.at(-1)!.content).toBe('Corrige: - [error] No hay elementos (elemento «items»)');
    expect(JSON.parse(readFileSync(json, 'utf8'))).toEqual({ nombre: 'Demo', items: ['a'] });
  });

  it('explain y review usan las guías generales y el documento entero', async () => {
    const modelo = simulateChat(['## Resumen\nTexto']);
    const explain = await withModelEnv(() => runCli(['explain', archivo, '--module', 'conia', '--provider', 'openai'], modelo, registry));
    expect(explain.exitCode).toBe(0);
    const [system, user] = modelo.calls[0].body.messages;
    expect(system.content).toContain('Sigue el orden natural de lectura del diagrama');
    expect(user.content).toContain('{"nombre":"Demo","items":["a"]}');

    const review = await withModelEnv(() => runCli(['review', archivo, '--module', 'conia', '--provider', 'openai'], modelo, registry));
    expect(review.exitCode).toBe(0);
    expect(modelo.calls[1].body.messages[0].content).toContain('Comprueba la coherencia entre nombres');
  });

  it('un módulo sin ai tampoco genera, pero sí se puede explicar y revisar', async () => {
    const modelo = simulateChat(['## Resumen\nTexto']);
    const generar = await withModelEnv(() => runCli(['generate', 'algo', '--module', 'sinia', '--provider', 'openai'], modelo, registry));
    expect(generar.exitCode).toBe(2);
    expect(generar.stderr).toContain('no genera con IA');
    expect(modelo.calls).toHaveLength(0);

    const review = await withModelEnv(() => runCli(['review', archivo, '--module', 'sinia', '--provider', 'openai'], modelo, registry));
    expect(review.exitCode).toBe(0);
    expect(modelo.calls[0].body.messages[0].content).toContain('«Módulo sinia» (id «sinia»)');
    expect(existsSync(archivo)).toBe(true);
  });
});
