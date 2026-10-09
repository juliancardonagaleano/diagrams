// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpProjectStore } from '@iark/kernel';
import { saveBackend } from './backend';
import { createProjectSession, getProjectSession, resetProjectSession } from './factory';
import { IndexedDbProjectStore } from './indexedDbStore';
import { fakeServer } from './testing';

describe('fábrica de sesiones de proyectos', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    resetProjectSession();
  });
  afterEach(() => {
    resetProjectSession();
    vi.restoreAllMocks();
  });

  it('sin configuración usa IndexedDB de este navegador, con el puntero de siempre', () => {
    const session = createProjectSession({ session: { broadcast: false } });
    expect(session.store).toBeInstanceOf(IndexedDbProjectStore);
    expect(session.backend).toEqual({ kind: 'local' });
    expect(session.remote).toBe(false);
    session.dispose();
  });

  it('con un servidor configurado usa el cliente HTTP con su token, y el puntero y el canal son de ese servidor', async () => {
    const server = fakeServer({ token: 'secreto' });
    saveBackend({ url: 'https://iark.ejemplo.org/', token: 'secreto', label: 'Oficina' });
    const session = createProjectSession({ fetch: server.fetch, session: { broadcast: false, pollMs: 0 } });
    expect(session.store).toBeInstanceOf(HttpProjectStore);
    expect(session.backend).toEqual({ kind: 'remote', url: 'https://iark.ejemplo.org', host: 'iark.ejemplo.org', label: 'Oficina' });
    expect(session.remote).toBe(true);

    await session.init();
    expect(server.log).toEqual(['GET /api/projects', 'GET /api/whoami']); // lo segundo es la identidad que aísla el trabajo sin conexión
    const project = await session.createProject('Tienda');
    // el último abierto va por servidor: el local no se toca
    expect(JSON.parse(localStorage.getItem('iark.projects.last:https://iark.ejemplo.org')!)).toEqual({ projectId: project.id });
    expect(localStorage.getItem('iark.projects.last')).toBeNull();
    session.dispose();
  });

  it('no pide almacenamiento persistente al navegador cuando es un servidor, y sí cuando es local', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    Object.defineProperty(navigator, 'storage', { configurable: true, value: { persist } });
    const server = fakeServer();
    saveBackend({ url: 'http://localhost:8787' });
    const remote = createProjectSession({ fetch: server.fetch, session: { broadcast: false, pollMs: 0 } });
    await remote.init();
    await remote.createProject('En el servidor');
    expect(persist).not.toHaveBeenCalled();
    remote.dispose();

    // el mismo flujo con el almacén de este navegador sí lo pide (se sustituye el almacén por uno en memoria: jsdom no trae IndexedDB)
    const { MemoryProjectStore } = await import('@iark/kernel');
    const { ProjectSession } = await import('./session');
    const local = new ProjectSession(new MemoryProjectStore(), { broadcast: false });
    await local.init();
    await local.createProject('Aquí');
    expect(persist).toHaveBeenCalledTimes(1);
    local.dispose();
    Reflect.deleteProperty(navigator, 'storage');
  });

  it('la sesión compartida es una sola por pestaña hasta que se suelta', () => {
    const one = getProjectSession();
    expect(getProjectSession()).toBe(one);
    resetProjectSession();
    const two = getProjectSession();
    expect(two).not.toBe(one);
    two.dispose();
  });

  it('la configuración se lee al crear la sesión: un cambio de almacén aplica tras recargar, no antes', () => {
    const one = getProjectSession();
    expect(one.remote).toBe(false);
    saveBackend({ url: 'https://iark.ejemplo.org' });
    expect(getProjectSession()).toBe(one); // sigue en el almacén anterior
    resetProjectSession(); // = recargar la página
    const two = getProjectSession();
    expect(two.remote).toBe(true);
    two.dispose();
  });
});
