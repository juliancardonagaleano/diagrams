import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDefaultRegistry } from './registry';
import { createSuiteServer } from './serve';

// Decisión: el servicio HTTP (`iark serve`) NO llama a modelos. La generación, `explain` y `review` viven solo en el CLI. Para
// exponerlas haría falta antes una credencial obligatoria, una cuota por persona y un tope de presupuesto (ver docs/servicio.md,
// «Por qué no hay IA en el servicio»). Estas pruebas fijan que no hay ninguna ruta que lo haga por descuido.
const registry = createDefaultRegistry();
const MODULES = registry.list().map((m) => m.id);
const AI_ACTIONS = ['generate', 'explain', 'review', 'prompt', 'ask', 'chat', 'ai'];

describe('iark serve no expone IA', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createSuiteServer({ registry, version: '1' });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => void server.close());

  const post = (path: string, body: unknown = {}) => fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body) });

  it('hay módulos con IA en el CLI (la prueba tiene sentido)', () => {
    expect(MODULES.length).toBe(6);
    expect(registry.list().filter((m) => m.ai).length).toBe(6);
  });

  it('ninguna acción de IA existe por módulo: 404 que enumera solo las acciones de cálculo', async () => {
    for (const id of MODULES) {
      for (const action of AI_ACTIONS) {
        const res = await post(`/api/${id}/${action}`, { instruction: 'Una tienda' });
        expect(res.status, `${id}/${action}`).toBe(404);
        const { error } = (await res.json()) as { error: string };
        expect(error).toContain('Use capabilities, schema, validate, views, export, import, diff o run');
      }
    }
  });

  it('tampoco por run/<comando>: generate, explain y review no son comandos de módulo', async () => {
    for (const id of MODULES) {
      for (const command of ['generate', 'explain', 'review']) {
        const res = await post(`/api/${id}/run/${command}`, { input: '{}' });
        expect(res.status, `${id}/run/${command}`).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
      }
    }
  });

  it('el manifiesto y las capacidades no anuncian ninguna ruta de IA', async () => {
    const manifest = JSON.stringify(await (await fetch(`${base}/.well-known/iark.json`)).json());
    expect(manifest).not.toMatch(/generate|explain|review/i);
    for (const id of MODULES) {
      const capabilities = JSON.stringify(await (await fetch(`${base}/api/${id}/capabilities`)).json());
      expect(capabilities, id).not.toMatch(/"(generate|explain|review)"/);
    }
  });

  it('lo único relacionado con la IA es el JSON Schema de su salida, que es un dato y no llama a nadie', async () => {
    const res = await fetch(`${base}/api/c4/schema?kind=generation`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { type: string }).type).toBe('object');
  });

  it('la documentación del servicio dice lo mismo y lo que habría que exigir para cambiarlo', () => {
    const servicio = readFileSync('docs/servicio.md', 'utf8');
    expect(servicio).toContain('Por qué no hay IA en el servicio');
    for (const requisito of ['credencial', 'cuota por persona', 'tope de presupuesto']) expect(servicio.toLowerCase()).toContain(requisito);
  });
});
