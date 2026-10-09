// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpProjectStore, MemoryProjectStore } from '@iark/kernel';
import { DEFAULT_POLL_MS, DEFAULT_SAFETY_POLL_MS, ProjectSession, type SessionOptions } from './session';
import { fakeServer, type FakeServer } from './testing';

/**
 * La sesión con cambios en tiempo real: el canal de eventos (simulado) avisa, la sesión vuelve a leer la lista y marca el diagrama abierto como «hay una versión
 * más nueva» sin tocar nunca lo que la persona tiene pendiente. Sin canal (un servidor anterior, un corte, un proxy) todo sigue como con el sondeo de siempre.
 */
const BASE = 'http://localhost:8787';
const tick = async (ms = 0): Promise<void> => void (await vi.advanceTimersByTimeAsync(ms));

async function setup(options: { token?: string; session?: SessionOptions; supported?: boolean; wrap?: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch } = {}) {
  const server = fakeServer({ token: options.token });
  server.events.supported = options.supported ?? true;
  const fetchFn = options.wrap ? options.wrap(server.fetch) : server.fetch;
  const client = new HttpProjectStore({ baseUrl: BASE, token: options.token, fetch: fetchFn });
  const other = new HttpProjectStore({ baseUrl: BASE, token: options.token, fetch: server.fetch });
  const session = new ProjectSession(client, { debounceMs: 50, broadcast: false, pollMs: DEFAULT_POLL_MS, events: { baseMs: 1000, maxMs: 8000, random: () => 0.5 }, ...options.session });
  await session.init();
  const project = await session.createProject('Tienda');
  const meta = await session.createDiagram({ module: 'c4', name: 'Contexto', text: 'v0' });
  await tick();
  return { server, client, other, session, project, meta };
}

/** Otra persona guarda el diagrama y el servidor lo cuenta por el canal. */
async function saveElsewhere(server: FakeServer, other: HttpProjectStore, projectId: string, diagramId: string, text: string, by = '@beto'): Promise<string> {
  const meta = await other.saveDiagram(projectId, { id: diagramId, text });
  server.events.emit({ type: 'diagram.saved', project: projectId, diagram: diagramId, updatedAt: meta.updatedAt, by });
  return meta.updatedAt;
}

const lists = (server: FakeServer): number => server.log.filter((entry) => entry === 'GET /api/projects').length;

describe('sesión con cambios en tiempo real', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: false }));
  afterEach(() => vi.useRealTimers());

  describe('el canal', () => {
    it('se abre al iniciar con un servidor que lo ofrece, pasa a «en directo» y se cierra al soltar la sesión', async () => {
      const { server, session } = await setup();
      expect(server.events.attempts).toBe(1);
      expect(server.events.open).toBe(1);
      expect(session.getState().eventsState).toBe('live');
      session.dispose();
      expect(server.events.open).toBe(0);
    });

    it('con un servidor que no lo ofrece (404) se intenta una vez y sigue el sondeo de siempre, sin aviso de error', async () => {
      const { server, session } = await setup({ supported: false });
      expect(server.events.attempts).toBe(1);
      expect(session.getState()).toMatchObject({ eventsState: 'unsupported', available: true, syncError: undefined });
      await tick(10 * 60_000);
      expect(server.events.attempts).toBe(1); // no insiste
      const before = lists(server);
      await tick(DEFAULT_POLL_MS * 2 + 10);
      expect(lists(server) - before).toBe(2); // y el sondeo cada 30 s, como antes
      session.dispose();
    });

    it('no se abre con events: false, con un almacén de este navegador ni cuando el servidor ya rechazó el token (insistir suma intentos fallidos)', async () => {
      const off = await setup({ session: { events: false } });
      expect(off.server.events.attempts).toBe(0);
      expect(off.session.getState().eventsState).toBeUndefined();
      off.session.dispose();

      const local = new ProjectSession(new MemoryProjectStore(), { broadcast: false, persist: false });
      await local.init();
      expect(local.getState().eventsState).toBeUndefined();
      expect(local.getState().newer).toBeUndefined();
      local.dispose();

      const locked = fakeServer({ token: 'secreto' });
      locked.events.supported = true;
      const session = new ProjectSession(new HttpProjectStore({ baseUrl: BASE, token: 'malo', fetch: locked.fetch }), { broadcast: false, pollMs: 0 });
      await session.init();
      expect(session.getState()).toMatchObject({ available: false, errorCode: 'unauthorized' });
      expect(locked.events.attempts).toBe(0);
      // con el token bueno, se abre
      await session.useToken('secreto');
      expect(locked.events.attempts).toBe(1);
      expect(session.getState().eventsState).toBe('live');
      session.dispose();
    });

    it('en directo, el sondeo se espacia a una red de seguridad de varios minutos; si el canal cae, vuelve a cada 30 s', async () => {
      const { server, session } = await setup();
      let before = lists(server);
      await tick(DEFAULT_POLL_MS * 4);
      expect(lists(server) - before).toBe(0);
      await tick(DEFAULT_SAFETY_POLL_MS);
      expect(lists(server) - before).toBeGreaterThanOrEqual(1);
      expect(lists(server) - before).toBeLessThanOrEqual(2);

      server.events.supported = false; // y cuando reconecte ya no hay canal
      server.events.drop();
      await tick(1000);
      expect(session.getState().eventsState).toBe('unsupported');
      before = lists(server);
      await tick(DEFAULT_POLL_MS * 2 + 10);
      expect(lists(server) - before).toBe(2);
      session.dispose();
    });

    it('si el canal se corta, reconecta con espera exponencial y al volver lee la lista: lo que pasó mientras tanto aparece', async () => {
      const { server, session, other, project, meta } = await setup();
      server.events.drop();
      await tick();
      expect(session.getState().eventsState).toBe('retrying');
      // mientras no hay canal, otra persona guarda; nadie avisa
      const updatedAt = (await other.saveDiagram(project.id, { id: meta.id, text: 'de beto' })).updatedAt;
      expect(session.getState().newer).toBeUndefined();
      await tick(999);
      expect(server.events.attempts).toBe(1);
      await tick(1);
      expect(server.events.attempts).toBe(2); // 1 s
      expect(session.getState().eventsState).toBe('live');
      await tick(2000);
      expect(session.getState().newer).toEqual({ updatedAt });
      session.dispose();
    });

    it('con un corte que se repite la espera crece (1 s, 2 s, 4 s…) hasta el tope', async () => {
      const { server, session } = await setup();
      server.down = true;
      server.events.drop();
      server.log.length = 0;
      await tick(40_000);
      const tries = server.log.filter((entry) => entry === 'GET /api/events').length;
      // con el tope de 8 s caben 1 + 2 + 4 y luego uno cada 8 s (unos 7 en 40 s); sin crecimiento serían 40
      expect(tries).toBeGreaterThanOrEqual(5);
      expect(tries).toBeLessThanOrEqual(8);
      server.down = false;
      await tick(9000);
      expect(session.getState().eventsState).toBe('live');
      session.dispose();
    });
  });

  describe('la conexión', () => {
    it('una conexión que calla más de tres latidos se da por muerta y se reconecta, leyendo la lista', async () => {
      const { server, session } = await setup();
      server.events.heartbeatMs = 2000; // silencio tolerado: tres latidos (6 s)
      server.events.drop();
      await tick(1000); // reconecta, ya con el latido de 2 s
      expect(server.events.attempts).toBe(2);
      const before = lists(server);
      await tick(5900);
      expect(server.events.attempts).toBe(2);
      server.events.heartbeat();
      await tick(5900);
      expect(server.events.attempts).toBe(2); // el latido la mantuvo
      await tick(200);
      expect(session.getState().eventsState).toBe('retrying');
      await tick(1500);
      expect(server.events.attempts).toBe(3);
      expect(lists(server)).toBeGreaterThan(before);
      session.dispose();
    });
  });

  describe('«hay una versión más nueva»', () => {
    it('un guardado ajeno avisado por el canal marca el diagrama abierto con la marca y quién, y cargarla deja guardar encima sin conflicto', async () => {
      const { server, session, other, project, meta } = await setup();
      const updatedAt = await saveElsewhere(server, other, project.id, meta.id, 'de beto');
      await tick(100);
      expect(session.getState().newer).toEqual({ updatedAt, by: '@beto' });
      expect(session.getState().save).toBe('saved'); // no es un conflicto: no hay nada pendiente aquí

      const loaded = await session.loadNewer();
      expect(loaded?.text).toBe('de beto');
      expect(session.getState().newer).toBeUndefined();
      session.queueSave('de beto y mío');
      await tick(60);
      expect(session.getState().save).toBe('saved');
      expect((await server.store.getDiagram(project.id, meta.id))?.text).toBe('de beto y mío');
      session.dispose();
    });

    it('un aviso con quien lo hizo desconocido (un servidor sin autenticación) marca igual, sin autor', async () => {
      const { server, session, other, project, meta } = await setup();
      const updated = await other.saveDiagram(project.id, { id: meta.id, text: 'ajeno' });
      server.events.emit({ type: 'diagram.saved', project: project.id, diagram: meta.id, updatedAt: updated.updatedAt });
      await tick(100);
      expect(session.getState().newer).toEqual({ updatedAt: updated.updatedAt });
      session.dispose();
    });

    it('sin canal también se detecta, con el sondeo de 30 s (y sin saber quién)', async () => {
      const { session, other, project, meta } = await setup({ supported: false });
      const updatedAt = (await other.saveDiagram(project.id, { id: meta.id, text: 'de beto' })).updatedAt;
      await tick(DEFAULT_POLL_MS + 10);
      expect(session.getState().newer).toEqual({ updatedAt });
      session.dispose();
    });

    it('los avisos seguidos se atienden con una sola lectura de la lista', async () => {
      const { server, session, other, project, meta } = await setup();
      const before = lists(server);
      for (let i = 0; i < 5; i += 1) await saveElsewhere(server, other, project.id, meta.id, `v${i + 1}`);
      await tick(200);
      expect(lists(server) - before).toBe(1);
      expect(session.getState().newer?.updatedAt).toBeDefined();
      session.dispose();
    });

    it('lo propio no cuenta: guardar aquí, y el aviso de ese mismo guardado, no marcan nada (aunque el aviso llegue antes que la respuesta)', async () => {
      const { server, session, project, meta } = await setup({
        wrap: (real) => async (input, init) => {
          const response = await real(input, init);
          if ((init?.method ?? 'GET') === 'PUT') {
            // el servidor ya guardó y avisó, y la respuesta tarda: el aviso gana la carrera
            const saved = (await response.clone().json()) as { id: string; updatedAt: string };
            server.events.emit({ type: 'diagram.saved', project: project.id, diagram: saved.id, updatedAt: saved.updatedAt, by: '@yo' });
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
          return response;
        },
      });
      session.queueSave('mío');
      await tick(60);
      expect(session.getState().save).toBe('saving');
      await tick(150); // el aviso llegó y se leyó la lista mientras la respuesta seguía en camino
      expect(session.getState().newer).toBeUndefined();
      await tick(300);
      expect(session.getState()).toMatchObject({ save: 'saved' });
      await tick(300);
      expect(session.getState().newer).toBeUndefined();
      expect((await server.store.getDiagram(project.id, meta.id))?.text).toBe('mío');
      session.dispose();
    });

    it('con cambios propios sin guardar no se avisa, y cargar la nueva se niega sin perder nada: manda el conflicto de siempre', async () => {
      const { server, session, other, project, meta } = await setup({ session: { debounceMs: 5000 } });
      session.queueSave('lo que estoy escribiendo');
      await saveElsewhere(server, other, project.id, meta.id, 'de beto');
      await tick(200);
      expect(session.getState().newer).toBeUndefined();
      await expect(session.loadNewer()).rejects.toMatchObject({ code: 'conflict' });
      expect(session.dirty).toBe(true);

      await session.flush(); // al guardar, el conflicto de siempre
      expect(session.getState()).toMatchObject({ save: 'conflict', saveErrorCode: 'conflict' });
      expect((await server.store.getDiagram(project.id, meta.id))?.text).toBe('de beto'); // nada pisado
      expect(session.getState().newer).toBeUndefined();
      expect((await session.resolveConflict('overwrite')) ?? 'ok').toBe('ok');
      session.dispose();
    });

    it('con un cambio guardado en el navegador sin conexión (la cola) tampoco avisa ni carga: no se pierde lo pendiente', async () => {
      const { server, session, other, project, meta } = await setup();
      server.down = true;
      session.queueSave('sin red');
      await tick(60);
      expect(session.getState().save).toBe('offline');
      server.down = false;
      await saveElsewhere(server, other, project.id, meta.id, 'de beto');
      await tick(100);
      expect(session.getState().newer).toBeUndefined();
      await expect(session.loadNewer()).rejects.toMatchObject({ code: 'conflict' });
      // al volver la red, la cola envía y el servidor la detecta como conflicto en lugar de pisar
      await tick(30_000);
      expect(session.getState().offline?.conflicts).toBe(1);
      expect((await server.store.getDiagram(project.id, meta.id))?.text).toBe('de beto');
      session.dispose();
    });

    it('ignorar el aviso lo quita hasta que haya otra versión aún más nueva; las de otros diagramas no se mezclan', async () => {
      const { server, session, other, project, meta } = await setup();
      await saveElsewhere(server, other, project.id, meta.id, 'v1');
      await tick(100);
      expect(session.getState().newer).toBeDefined();
      session.dismissNewer();
      expect(session.getState().newer).toBeUndefined();
      await tick(DEFAULT_POLL_MS + 10); // otra lectura de la lista con la misma versión: sigue sin avisar
      expect(session.getState().newer).toBeUndefined();
      const second = await saveElsewhere(server, other, project.id, meta.id, 'v2');
      await tick(100);
      expect(session.getState().newer).toEqual({ updatedAt: second, by: '@beto' });
      session.dispose();
    });

    it('ante un cambio de otra persona que borra el diagrama abierto, la sesión lo suelta como antes (y lo escrito queda en el editor)', async () => {
      const { server, session, other, project, meta } = await setup();
      await other.deleteDiagram(project.id, meta.id);
      server.events.emit({ type: 'diagram.deleted', project: project.id, diagram: meta.id, by: '@beto' });
      await tick(100);
      expect(session.getState().diagramId).toBeUndefined();
      expect(session.getState().newer).toBeUndefined();
      session.dispose();
    });

    it('un aviso de un proyecto que se acaba de crear o cambiar refresca la lista sin más (y se ve el proyecto nuevo)', async () => {
      const { server, session, other } = await setup();
      const created = await other.createProject({ name: 'Nuevo' });
      server.events.emit({ type: 'project.created', project: created.id, updatedAt: created.updatedAt, by: '@beto' });
      await tick(100);
      expect(session.getState().projects.map((p) => p.name).sort()).toEqual(['Nuevo', 'Tienda']);
      session.dispose();
    });

    it('cambiar de diagrama o de proyecto olvida el aviso del anterior', async () => {
      const { server, session, other, project, meta } = await setup();
      const second = await session.createDiagram({ module: 'c4', name: 'Otro', text: 'o0' });
      await session.openDiagram(project.id, meta.id);
      await saveElsewhere(server, other, project.id, meta.id, 'de beto');
      await tick(100);
      expect(session.getState().newer).toBeDefined();
      await session.openDiagram(project.id, second.id);
      expect(session.getState().newer).toBeUndefined();
      await session.openDiagram(project.id, meta.id); // lo abre ya con lo último: nada más nuevo
      expect(session.getState().newer).toBeUndefined();
      session.dispose();
    });
  });

  describe('la credencial', () => {
    it('si el servidor cierra el canal porque el token ya no vale, la pantalla lo cuenta (unauthorized) y un token nuevo reabre el canal sin recargar', async () => {
      const { server, session } = await setup({ token: 'viejo' });
      server.token = 'nuevo';
      server.events.bye('unauthorized');
      await tick(100);
      expect(session.getState().eventsState).toBe('rejected');
      expect(session.getState()).toMatchObject({ syncErrorCode: 'unauthorized' }); // la lectura de la lista dio 401 y la pantalla ofrece volver a conectar
      const attempts = server.events.attempts;
      await tick(10 * 60_000);
      expect(server.events.attempts).toBe(attempts); // y no insiste

      await session.useToken('nuevo');
      await tick();
      expect(server.events.attempts).toBe(attempts + 1);
      expect(session.getState().eventsState).toBe('live');
      session.dispose();
    });

    it('un 401 al abrir el canal con el servidor ya en marcha deja «rechazado» sin reintentos', async () => {
      const { server, session } = await setup({ token: 'viejo' });
      server.token = 'nuevo';
      server.events.drop(); // y al reconectar, el token ya no vale
      await tick(1000);
      expect(session.getState().eventsState).toBe('rejected');
      await tick(10 * 60_000);
      expect(server.events.attempts).toBe(2);
      session.dispose();
    });
  });
});
