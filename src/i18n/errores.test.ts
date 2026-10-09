import { afterEach, describe, expect, it } from 'vitest';
import { HttpProjectStore, MemoryProjectStore, ProjectError } from '@iark/kernel';
import { CODE_KEYS, REASON_KEYS, projectErrorText } from './errores';
import { CATALOGS, resetLang, setLang } from './index';

/**
 * La traducción de los errores del cliente: se hace por el motivo (`info.reason`) o el código que ya trae el error, nunca leyendo el texto en español.
 * Estas pruebas pasan por el cliente HTTP real con un `fetch` simulado, para que lo que se comprueba sea lo que de verdad produce el núcleo.
 */

function storeAnswering(status: number, body: unknown, headers: Record<string, string> = {}): HttpProjectStore {
  const fetchSimulado = (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })) as typeof fetch;
  return new HttpProjectStore({ baseUrl: 'https://iark.example', token: 't', fetch: fetchSimulado });
}

async function failure(promise: Promise<unknown>): Promise<ProjectError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProjectError) return error;
    throw error;
  }
  throw new Error('se esperaba un error');
}

afterEach(() => resetLang());

describe('projectErrorText: por motivo y por código', () => {
  it('un 403 sin texto se traduce por su motivo, en cada idioma', async () => {
    const error = await failure(storeAnswering(403, {}).listProjects());
    expect(error.info.reason).toBe('token-forbidden');
    setLang('es', { persist: false });
    expect(projectErrorText(error)).toBe('Este token no tiene permiso para esa operación.');
    setLang('en', { persist: false });
    expect(projectErrorText(error)).toBe('This token is not allowed to do that.');
  });

  it('un 429 con Retry-After lleva los segundos como parámetro', async () => {
    const error = await failure(storeAnswering(429, {}, { 'Retry-After': '7' }).listProjects());
    expect(error.info.reason).toBe('rate-limited-wait');
    setLang('en', { persist: false });
    expect(projectErrorText(error)).toBe('Too many failed attempts: wait 7 s.');
  });

  it('un tope de espacio del servidor: en español sale su texto; en inglés, la frase propia con las cifras ya escritas como tamaños', async () => {
    const body = { error: 'No hay espacio (texto del servidor).', code: 'limit', quota: 'bytes', used: 2048, limit: 1024 };
    const error = await failure(storeAnswering(403, body).createProject({ name: 'X' }));
    expect(error.info.reason).toBe('limit-bytes');
    setLang('es', { persist: false });
    expect(projectErrorText(error)).toBe('No hay espacio (texto del servidor).');
    setLang('en', { persist: false });
    const text = projectErrorText(error);
    expect(text).toContain('the quota is 1 KB and 2 KB are already in use');
    expect(text).not.toContain('servidor');
  });

  it('un error del servidor sin motivo conocido: en inglés dice qué significa el código y añade lo que dijo el servidor', async () => {
    const error = await failure(storeAnswering(409, { code: 'exists', error: 'Ya existe un proyecto llamado «A».' }).createProject({ name: 'A' }));
    setLang('es', { persist: false });
    expect(projectErrorText(error)).toBe('Ya existe un proyecto llamado «A».');
    setLang('en', { persist: false });
    expect(projectErrorText(error)).toBe('It already exists. (the server says: Ya existe un proyecto llamado «A».)');
  });

  it('un error del propio cliente (sin servidor) se traduce con sus parámetros', async () => {
    const store = new MemoryProjectStore();
    await store.createProject({ name: 'Uno' });
    const error = await failure(store.createProject({ name: 'uno' }));
    expect(error.info.reason).toBe('project-exists');
    setLang('es', { persist: false });
    expect(projectErrorText(error)).toBe('Ya existe un proyecto llamado «uno».');
    setLang('en', { persist: false });
    expect(projectErrorText(error)).toMatch(/uno/);
    expect(projectErrorText(error)).not.toMatch(/Ya existe/);
  });

  it('lo que no es un ProjectError se muestra tal cual', () => {
    expect(projectErrorText(new Error('boom'))).toBe('boom');
    expect(projectErrorText('texto')).toBe('texto');
  });
});

describe('las tablas de motivos y códigos', () => {
  it('todas apuntan a una clave que existe en los dos idiomas', () => {
    for (const key of [...Object.values(REASON_KEYS), ...Object.values(CODE_KEYS)]) {
      expect(CATALOGS.es[key], `es: ${key}`).toBeTruthy();
      expect(CATALOGS.en[key], `en: ${key}`).toBeTruthy();
    }
  });
});
