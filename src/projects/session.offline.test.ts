// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpProjectStore } from '@iark/kernel';
import { OfflineQueue, type PendingChange, type QueueBackend } from './offlineQueue';
import { ProjectSession } from './session';
import { fakeServer, type FakePerson, type FakeServer } from './testing';

/**
 * El trabajo sin conexión de la sesión con un servidor simulado: un corte de red deja el cambio guardado en el navegador y se reenvía solo al
 * volver (sin tormentas de peticiones), un servidor que cambió mientras tanto es un conflicto con tres salidas (nada se pisa), las credenciales
 * malas no se reintentan en bucle y lo de una persona no se envía con la credencial de otra.
 */
const BASE = 'http://localhost:8787';

/** Una cola que vive fuera de la sesión (como IndexedDB): sobrevive a cerrar la sesión y la abre otra. */
class TestBackend implements QueueBackend {
  durable = true;
  readonly rows = new Map<string, PendingChange>();
  async list(): Promise<PendingChange[]> {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }
  async put(change: PendingChange): Promise<void> {
    this.rows.set(change.key, { ...change });
  }
  async delete(keys: string[]): Promise<void> {
    for (const key of keys) this.rows.delete(key);
  }
}

const NO_JITTER = { jitter: 0 };

interface Setup {
  server: FakeServer;
  backend: TestBackend;
  client: HttpProjectStore;
  other: HttpProjectStore;
  session: ProjectSession;
  project: { id: string };
  meta: { id: string };
  /** Abre otra sesión sobre la misma cola, como al abrir la app de nuevo. */
  reopen(options?: { token?: string; fetch?: typeof fetch; policy?: Partial<typeof NO_JITTER> }): Promise<ProjectSession>;
}

async function setup(options: { token?: string; backend?: TestBackend; limits?: { maxBytes: number; maxEntries: number } } = {}): Promise<Setup> {
  const server = fakeServer({ token: options.token });
  const backend = options.backend ?? new TestBackend();
  const make = (token: string | undefined, fetchImpl: typeof fetch = server.fetch, policy = NO_JITTER): ProjectSession =>
    new ProjectSession(new HttpProjectStore({ baseUrl: BASE, token, fetch: fetchImpl }), {
      debounceMs: 50,
      broadcast: false,
      pollMs: 0,
      offline: { queue: new OfflineQueue(backend, options.limits), policy, locks: false },
    });
  const client = new HttpProjectStore({ baseUrl: BASE, token: options.token, fetch: server.fetch });
  const other = new HttpProjectStore({ baseUrl: BASE, token: options.token, fetch: server.fetch });
  const session = make(options.token);
  await session.init();
  const project = await session.createProject('Tienda');
  const meta = await session.createDiagram({ module: 'c4', name: 'Contexto', text: 'v0' });
  return {
    server,
    backend,
    client,
    other,
    session,
    project,
    meta,
    async reopen(opts = {}) {
      const next = make(opts.token ?? options.token, opts.fetch);
      await next.init();
      return next;
    },
  };
}

const hidden = (value: boolean): void => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (value ? 'hidden' : 'visible') });
};
const browserOnline = (value: boolean): void => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => value });
};
const tick = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};
const puts = (server: FakeServer): number => server.log.filter((entry) => entry.startsWith('PUT')).length;
const textOf = async (s: Setup, id = s.meta.id): Promise<string | undefined> => (await s.server.store.getDiagram(s.project.id, id))?.text;

/** Escribe `text` y deja pasar la pausa del autoguardado. */
async function edit(session: ProjectSession, text: string): Promise<void> {
  session.queueSave(text);
  await vi.advanceTimersByTimeAsync(60);
}

describe('trabajo sin conexión', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
  afterEach(() => {
    vi.useRealTimers();
    hidden(false);
    browserOnline(true);
  });

  describe('un corte de red al guardar', () => {
    it('guarda el cambio en el navegador, lo dice («offline») y deja de ser un riesgo al cerrar la pestaña', async () => {
      const s = await setup();
      s.server.down = true;
      await edit(s.session, 'v1');
      expect(s.session.getState()).toMatchObject({ save: 'offline', saveErrorCode: 'unavailable', available: true });
      expect(s.session.getState().offline).toMatchObject({ waiting: 1, authBlocked: 0, conflicts: 0, durable: true });
      expect(s.session.getState().offline?.entries).toMatchObject([{ diagramId: s.meta.id, name: 'Contexto', status: 'retry' }]);
      // está en la cola (IndexedDB en el navegador de verdad), con su marca del servidor y sin ninguna credencial
      expect([...s.backend.rows.values()]).toMatchObject([{ text: 'v1', baseUpdatedAt: expect.any(String), status: 'retry' }]);
      expect(s.session.dirty).toBe(false);
      s.session.dispose();
    });

    it('con una cola que no es duradera (ventana privada) sigue avisando al cerrar la pestaña', async () => {
      const backend = new TestBackend();
      backend.durable = false;
      const s = await setup({ backend });
      s.server.down = true;
      await edit(s.session, 'v1');
      expect(s.session.getState().save).toBe('offline');
      expect(s.session.getState().offline?.durable).toBe(false);
      expect(s.session.dirty).toBe(true);
      s.session.dispose();
    });

    it('al volver la red (online) se envía lo último, con la marca del servidor, y el estado vuelve a «guardado»', async () => {
      const s = await setup();
      s.server.down = true;
      await edit(s.session, 'v1');
      await edit(s.session, 'v2');
      await edit(s.session, 'v3');
      expect(s.session.getState().offline?.waiting).toBe(1); // un solo estado por diagrama, no una cola de ediciones

      s.server.down = false;
      s.server.log.length = 0;
      window.dispatchEvent(new Event('online'));
      await tick();
      expect(await textOf(s)).toBe('v3');
      expect(s.session.getState()).toMatchObject({ save: 'saved', saveError: undefined, saveErrorCode: undefined });
      expect(s.session.getState().offline).toMatchObject({ waiting: 0, conflicts: 0 });
      expect(s.backend.rows.size).toBe(0);
      expect(s.session.dirty).toBe(false);
      // un solo PUT (quién es la credencial ya se averiguó al abrir) y la lectura de la lista
      expect(s.server.log).toEqual([`PUT /api/projects/${s.project.id}/diagrams/${s.meta.id}`, 'GET /api/projects']);
      s.session.dispose();
    });

    it('siguiendo sin red no se llama al servidor con cada pausa del autoguardado: lo último se anota y espera su turno', async () => {
      const s = await setup();
      s.server.down = true;
      await edit(s.session, 'v1');
      const before = s.server.log.length;
      for (const text of ['a', 'b', 'c', 'd', 'e']) await edit(s.session, text);
      expect(s.server.log.length).toBe(before);
      expect(s.session.getState().save).toBe('offline');
      expect([...s.backend.rows.values()][0].text).toBe('e');
      s.session.dispose();
    });

    it('el navegador sin conexión (navigator.onLine) ni siquiera intenta la petición', async () => {
      const s = await setup();
      browserOnline(false);
      s.server.log.length = 0;
      await edit(s.session, 'sin red');
      expect(s.server.log).toEqual([]);
      expect(s.session.getState()).toMatchObject({ save: 'offline' });
      expect(s.session.getState().offline?.waiting).toBe(1);

      browserOnline(true);
      window.dispatchEvent(new Event('online'));
      await tick();
      expect(await textOf(s)).toBe('sin red');
      expect(s.session.getState().save).toBe('saved');
      s.session.dispose();
    });

    it('un servidor que responde 503 o una página de otro (portal cautivo) también se espera, no se descarta', async () => {
      const s = await setup();
      s.server.inject(/^PUT /, 503, { error: 'mantenimiento' });
      await edit(s.session, 'v1');
      expect(s.session.getState().save).toBe('offline');
      await vi.advanceTimersByTimeAsync(2000);
      expect(await textOf(s)).toBe('v1');
      expect(s.session.getState().save).toBe('saved');
      s.session.dispose();
    });
  });

  describe('reintentos sin tormentas', () => {
    it('la espera crece al doble (2, 4, 8, 16, 32 s) y se queda en 60 s mientras siga sin red', async () => {
      const s = await setup();
      s.server.down = true;
      const times: number[] = [];
      let seen = puts(s.server);
      const start = Date.now();
      s.session.queueSave('v1');
      // se avanza de 50 en 50 ms anotando cuándo sale cada petición
      for (let elapsed = 0; elapsed < 300_000; elapsed += 50) {
        await vi.advanceTimersByTimeAsync(50);
        if (puts(s.server) > seen) {
          times.push(Date.now() - start);
          seen = puts(s.server);
        }
      }
      const gaps = times.slice(1).map((t, n) => t - times[n]);
      expect(gaps.slice(0, 8)).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
      expect(s.session.getState().offline?.nextRetryAt).toBeGreaterThan(Date.now());
      s.session.dispose();
    });

    it('al volver la red la espera se acaba: online reintenta en el acto y, enviado, no queda nada programado', async () => {
      const s = await setup();
      s.server.down = true;
      await edit(s.session, 'v1');
      await vi.advanceTimersByTimeAsync(2100); // un reintento fallido más: ahora toca esperar 4 s
      s.server.down = false;
      window.dispatchEvent(new Event('online'));
      await tick();
      expect(await textOf(s)).toBe('v1');
      expect(s.session.getState().offline?.nextRetryAt).toBeUndefined();
      s.server.log.length = 0;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(puts(s.server)).toBe(0); // sin nada pendiente no hay más intentos
      s.session.dispose();
    });

    it('el foco reintenta, pero no más de una vez cada 5 s, y con la ventana oculta no cuenta', async () => {
      const s = await setup();
      s.server.down = true;
      const start = Date.now();
      s.session.queueSave('v1');
      // intentos a los 50 ms, 2 s, 6 s y 14 s; el próximo, a los 30 s
      await vi.advanceTimersByTimeAsync(7000);
      expect(puts(s.server)).toBeGreaterThanOrEqual(3);

      hidden(true);
      s.server.log.length = 0;
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(100);
      expect(puts(s.server)).toBe(0); // oculta: nada

      hidden(false);
      await vi.advanceTimersByTimeAsync(start + 12_000 - Date.now()); // pasaron más de 5 s desde el intento de los 6 s
      s.server.log.length = 0;
      for (let n = 0; n < 6; n += 1) {
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
      }
      await vi.advanceTimersByTimeAsync(100);
      expect(puts(s.server)).toBe(1); // seis cambios de foco seguidos = un solo intento

      s.server.down = false;
      s.server.log.length = 0;
      window.dispatchEvent(new Event('focus')); // hace menos de 5 s del último intento
      await vi.advanceTimersByTimeAsync(100);
      expect(puts(s.server)).toBe(0);
      await vi.advanceTimersByTimeAsync(5000);
      window.dispatchEvent(new Event('focus'));
      await tick();
      expect(await textOf(s)).toBe('v1');
      s.session.dispose();
    });

    it('varias señales a la vez (online, foco, manual) comparten un solo envío por diagrama', async () => {
      const s = await setup();
      s.server.down = true;
      await edit(s.session, 'v1');
      s.server.down = false;
      s.server.log.length = 0;
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('focus'));
      void s.session.retryNow();
      void s.session.retryNow();
      await tick();
      expect(puts(s.server)).toBe(1);
      expect(await textOf(s)).toBe('v1');
      s.session.dispose();
    });

    /** Tres diagramas con trabajo pendiente: cada uno se abre con red y se edita sin ella. */
    async function threePending(s: Setup): Promise<string[]> {
      const second = await s.client.saveDiagram(s.project.id, { module: 'c4', name: 'Pagos', text: 'p0' });
      const third = await s.client.saveDiagram(s.project.id, { module: 'c4', name: 'Envíos', text: 'e0' });
      await s.session.refresh();
      const ids = [s.meta.id, second.id, third.id];
      for (const [n, id] of ids.entries()) {
        await s.session.openDiagram(s.project.id, id);
        s.server.down = true;
        await edit(s.session, ['c1', 'p1', 'e1'][n]);
        s.server.down = false;
      }
      expect(s.session.getState().offline?.waiting).toBe(3);
      return ids;
    }

    it('varios diagramas pendientes se envían de uno en uno, nunca a la vez', async () => {
      const s = await setup();
      const ids = await threePending(s);
      let running = 0;
      let most = 0;
      const base = s.server.fetch;
      const counting = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method !== 'PUT') return base(input, init);
        running += 1;
        most = Math.max(most, running);
        try {
          return await base(input, init);
        } finally {
          running -= 1;
        }
      }) as typeof fetch;
      s.session.dispose();
      const next = await s.reopen({ fetch: counting });
      await tick();
      expect(most).toBe(1);
      expect(await Promise.all(ids.map((id) => textOf(s, id)))).toEqual(['c1', 'p1', 'e1']);
      expect(s.backend.rows.size).toBe(0);
      next.dispose();
    });

    it('si la red sigue caída se prueba con un solo diagrama por ronda: los demás fallarían igual', async () => {
      const s = await setup();
      await threePending(s);
      s.server.down = true;
      s.server.log.length = 0;
      await s.session.retryNow();
      expect(puts(s.server)).toBe(1);
      expect(s.session.getState().offline?.waiting).toBe(3);
      s.session.dispose();
    });

    it('al abrir con la red caída ni siquiera se manda un diagrama: la comprobación de quién eres falla antes y se espera', async () => {
      const s = await setup();
      await threePending(s);
      s.session.dispose();
      s.server.down = true;
      s.server.log.length = 0;
      const next = await s.reopen();
      await tick();
      expect(puts(s.server)).toBe(0);
      expect(s.server.log.filter((entry) => entry === 'GET /api/whoami')).toHaveLength(1); // la lectura de la lista y la ronda comparten una petición
      expect(next.getState().offline?.waiting).toBe(3);
      next.dispose();
    });

    it('un 429 del servidor se respeta: no se vuelve a intentar antes de lo que pidió, aunque la espera normal fuera menor', async () => {
      const s = await setup();
      s.server.inject(/^PUT /, 429, { error: 'Demasiados intentos fallidos', code: 'rate-limited' }, 1, { 'Retry-After': '120' });
      await edit(s.session, 'v1');
      expect(s.session.getState().save).toBe('offline');
      s.server.log.length = 0;
      await vi.advanceTimersByTimeAsync(119_000);
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(100);
      expect(puts(s.server)).toBe(0);
      await vi.advanceTimersByTimeAsync(1500);
      expect(await textOf(s)).toBe('v1');
      s.session.dispose();
    });

    it('un 429 sin «Retry-After» espera como mínimo 60 s', async () => {
      const s = await setup();
      s.server.inject(/^PUT /, 429, { error: 'Demasiados intentos fallidos' });
      await edit(s.session, 'v1');
      s.server.log.length = 0;
      await vi.advanceTimersByTimeAsync(59_000);
      expect(puts(s.server)).toBe(0);
      await vi.advanceTimersByTimeAsync(2000);
      expect(await textOf(s)).toBe('v1');
      s.session.dispose();
    });
  });

  describe('abrir la app de nuevo', () => {
    it('lo pendiente sobrevive a cerrar la pestaña: al abrir otra sesión se envía solo', async () => {
      const s = await setup();
      s.server.down = true;
      await edit(s.session, 'escrito sin red');
      s.session.dispose(); // se cierra la pestaña
      expect(await textOf(s)).toBe('v0');

      s.server.down = false;
      const next = await s.reopen();
      await tick();
      expect(await textOf(s)).toBe('escrito sin red');
      expect(next.getState().offline).toMatchObject({ waiting: 0, conflicts: 0 });
      expect(s.backend.rows.size).toBe(0);
      next.dispose();
    });

    it('si al abrir sigue sin red, espera (con su espera exponencial) y lo envía cuando vuelve, sin que la persona haga nada', async () => {
      const s = await setup();
      s.server.down = true;
      await edit(s.session, 'escrito sin red');
      s.session.dispose();

      const next = await s.reopen();
      await tick();
      expect(next.getState()).toMatchObject({ available: false, offline: { waiting: 1 } }); // no se pudo leer la lista, pero el pendiente se ve
      s.server.down = false;
      await vi.advanceTimersByTimeAsync(2100);
      expect(await textOf(s)).toBe('escrito sin red');
      expect(next.getState().offline?.waiting).toBe(0);
      next.dispose();
    });

    it('abrir un diagrama con trabajo pendiente carga ese trabajo (no la versión del servidor) y sigue esperando enviarse sobre la marca en la que se escribió', async () => {
      const s = await setup();
      s.server.down = true;
      await edit(s.session, 'mi trabajo');
      s.session.dispose();
      s.server.down = false;
      s.server.inject(/^PUT /, 503, { error: 'caído' }, 5); // el reenvío del arranque aún no puede

      const next = await s.reopen();
      await tick();
      expect(next.getState().offline?.waiting).toBe(1);
      const opened = await next.openDiagram(s.project.id, s.meta.id);
      expect(opened.text).toBe('mi trabajo');
      expect(next.getState().save).toBe('offline');
      expect(next.dirty).toBe(false);
      next.dispose();
    });
  });

  describe('si el servidor cambió mientras no había conexión', () => {
    async function conflicted(): Promise<Setup> {
      const s = await setup();
      s.server.down = true;
      await edit(s.session, 'lo mío sin conexión');
      await s.server.store.saveDiagram(s.project.id, { id: s.meta.id, text: 'lo de la otra persona' });
      s.server.down = false;
      window.dispatchEvent(new Event('online'));
      await tick();
      return s;
    }

    it('no se pisa nada: lo de la otra persona queda, lo mío se conserva como pendiente en conflicto', async () => {
      const s = await conflicted();
      expect(await textOf(s)).toBe('lo de la otra persona');
      expect(s.session.getState()).toMatchObject({ save: 'conflict', saveErrorCode: 'conflict' });
      expect(s.session.getState().offline).toMatchObject({ waiting: 0, conflicts: 1 });
      expect(s.session.getState().offline?.entries[0]).toMatchObject({ status: 'conflict', problem: 'changed', name: 'Contexto' });
      expect([...s.backend.rows.values()][0]).toMatchObject({ text: 'lo mío sin conexión', status: 'conflict' });
      expect(s.session.dirty).toBe(false);
      // y no se vuelve a intentar solo
      s.server.log.length = 0;
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(puts(s.server)).toBe(0);
      s.session.dispose();
    });

    it('seguir escribiendo con el conflicto abierto actualiza lo mío, sin enviar y sin que el estado cambie', async () => {
      const s = await conflicted();
      s.server.log.length = 0;
      await edit(s.session, 'lo mío, otra vez');
      expect(puts(s.server)).toBe(0);
      expect(s.session.getState().save).toBe('conflict');
      expect([...s.backend.rows.values()][0]).toMatchObject({ text: 'lo mío, otra vez', status: 'conflict' });
      s.session.dispose();
    });

    it('«Quedarme con la del servidor» descarta lo mío y devuelve la versión del servidor para cargarla', async () => {
      const s = await conflicted();
      const loaded = await s.session.resolveConflict('reload');
      expect(loaded?.text).toBe('lo de la otra persona');
      expect(s.session.getState()).toMatchObject({ save: 'idle', saveErrorCode: undefined });
      expect(s.session.getState().offline).toMatchObject({ conflicts: 0, waiting: 0 });
      expect(s.backend.rows.size).toBe(0);
      expect(await textOf(s)).toBe('lo de la otra persona');
      // y sigue guardando sobre la marca nueva, sin conflicto
      await edit(s.session, 'después');
      expect(await textOf(s)).toBe('después');
      s.session.dispose();
    });

    it('«Quedarme con la mía» la envía sobre lo que hay ahora en el servidor', async () => {
      const s = await conflicted();
      await s.session.resolveConflict('overwrite');
      await tick();
      expect(await textOf(s)).toBe('lo mío sin conexión');
      expect(s.session.getState()).toMatchObject({ save: 'saved', saveErrorCode: undefined });
      expect(s.backend.rows.size).toBe(0);
      s.session.dispose();
    });

    it('«Quedarme con la mía» no pisa un cambio que llegó mientras se decidía: vuelve a ser conflicto', async () => {
      const s = await conflicted();
      const store = s.session.store as HttpProjectStore;
      const original = store.saveDiagram.bind(store);
      let first = true;
      store.saveDiagram = async (projectId, input) => {
        if (first && input.id) {
          first = false;
          // otra persona guarda justo antes de que salga lo mío
          await s.server.store.saveDiagram(s.project.id, { id: s.meta.id, text: 'otra vez la otra' });
        }
        return original(projectId, input);
      };
      await s.session.resolveConflict('overwrite');
      await tick();
      expect(await textOf(s)).toBe('otra vez la otra');
      expect(s.session.getState()).toMatchObject({ save: 'conflict' });
      expect(s.backend.rows.size).toBe(1);
      s.session.dispose();
    });

    it('«Guardar la mía como diagrama nuevo» crea una copia con otro nombre, deja el original como está y sigue guardando en la copia', async () => {
      const s = await conflicted();
      await s.session.resolveConflict('copy');
      const names = (await s.server.store.getProject(s.project.id))?.diagrams.map((d) => d.name).sort();
      expect(names).toEqual(['Contexto', 'Contexto (mi versión)']);
      expect(await textOf(s)).toBe('lo de la otra persona');
      const copy = (await s.server.store.getProject(s.project.id))!.diagrams.find((d) => d.name === 'Contexto (mi versión)')!;
      expect(await textOf(s, copy.id)).toBe('lo mío sin conexión');
      expect(s.session.getState()).toMatchObject({ diagramId: copy.id, save: 'saved' });
      expect(s.session.getState().offline).toMatchObject({ conflicts: 0 });
      expect(s.backend.rows.size).toBe(0);
      await edit(s.session, 'sigo en la copia');
      expect(await textOf(s, copy.id)).toBe('sigo en la copia');
      s.session.dispose();
    });

    it('con el nombre elegido por la persona, y si ya existe uno igual se numera', async () => {
      const s = await conflicted();
      await s.client.saveDiagram(s.project.id, { module: 'c4', name: 'Contexto (mi versión)', text: 'ya existía' });
      await s.session.refresh();
      await s.session.resolveConflict('copy');
      const names = (await s.server.store.getProject(s.project.id))?.diagrams.map((d) => d.name).sort();
      expect(names).toEqual(['Contexto', 'Contexto (mi versión 2)', 'Contexto (mi versión)']);

      const t = await conflicted();
      await t.session.resolveConflict('copy', { name: 'Plan B' });
      expect((await t.server.store.getProject(t.project.id))?.diagrams.map((d) => d.name).sort()).toEqual(['Contexto', 'Plan B']);
      s.session.dispose();
      t.session.dispose();
    });

    it('sin red no se puede decidir (hace falta leer el servidor) y entonces no se pierde nada de lo mío', async () => {
      const s = await conflicted();
      s.server.down = true;
      await expect(s.session.resolveConflict('reload')).rejects.toThrow(/No se pudo conectar/);
      await expect(s.session.resolveConflict('overwrite')).rejects.toThrow(/No se pudo conectar/);
      expect(s.backend.rows.size).toBe(1);
      expect(s.session.getState().save).toBe('conflict');
      s.session.dispose();
    });

    it('el conflicto de un diagrama que no está abierto se resuelve por su clave, sin tocar el que se está editando', async () => {
      const s = await setup();
      const second = await s.client.saveDiagram(s.project.id, { module: 'c4', name: 'Pagos', text: 'p0' });
      await s.session.refresh();
      await s.session.openDiagram(s.project.id, second.id);
      s.server.down = true;
      await edit(s.session, 'mi pagos');
      await s.server.store.saveDiagram(s.project.id, { id: second.id, text: 'pagos de otra' });
      s.server.down = false;
      await s.session.openDiagram(s.project.id, s.meta.id); // se pasa a otro diagrama mientras el primero sigue pendiente
      window.dispatchEvent(new Event('online'));
      await tick();
      expect(s.session.getState().offline).toMatchObject({ conflicts: 1 });
      expect(s.session.getState().save).toBe('idle'); // el abierto no tiene conflicto
      const key = s.session.getState().offline!.entries[0].key;
      await s.session.resolveConflict('copy', { key });
      expect((await s.server.store.getProject(s.project.id))?.diagrams.map((d) => d.name).sort()).toEqual(['Contexto', 'Pagos', 'Pagos (mi versión)']);
      expect(s.session.getState().diagramId).toBe(s.meta.id); // no cambia el diagrama abierto
      expect(s.session.getState().offline?.conflicts).toBe(0);
      s.session.dispose();
    });

    it('si alguien borró el diagrama, lo mío se conserva («gone») y se puede guardar como diagrama nuevo', async () => {
      const s = await setup();
      s.server.down = true;
      await edit(s.session, 'lo mío');
      await s.server.store.deleteDiagram(s.project.id, s.meta.id);
      s.server.down = false;
      window.dispatchEvent(new Event('online'));
      await tick();
      expect(s.session.getState().offline?.entries[0]).toMatchObject({ status: 'conflict', problem: 'gone' });
      await s.session.resolveConflict('overwrite'); // «la mía» de un diagrama que ya no existe = crearlo de nuevo
      const diagrams = (await s.server.store.getProject(s.project.id))!.diagrams;
      expect(diagrams.map((d) => d.name)).toEqual(['Contexto (mi versión)']);
      expect(await textOf(s, diagrams[0].id)).toBe('lo mío');
      s.session.dispose();
    });
  });

  describe('credenciales: no se reintenta en bucle', () => {
    it('un token que el servidor ya no acepta (401): el cambio espera en la cola, ni el foco ni la red ni el tiempo lo reintentan y un token nuevo lo retoma', async () => {
      const s = await setup({ token: 'viejo' });
      s.server.token = 'nuevo';
      await edit(s.session, 'lo que escribí');
      expect(s.session.getState()).toMatchObject({ save: 'error', saveErrorCode: 'unauthorized' });
      expect(s.session.getState().offline).toMatchObject({ authBlocked: 1, waiting: 0 });
      expect(s.session.dirty).toBe(false); // está guardado en el navegador

      s.server.log.length = 0;
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
      await s.session.flush();
      await s.session.retryNow();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(s.server.log).toEqual([]); // ni un solo intento más (cada 401 cuenta para el freno de la dirección)

      await s.session.useToken('nuevo');
      expect(await textOf(s)).toBe('lo que escribí');
      expect(s.session.getState()).toMatchObject({ save: 'saved', saveErrorCode: undefined });
      expect(s.session.getState().offline).toMatchObject({ authBlocked: 0 });
      s.session.dispose();
    });

    it('un rol que no alcanza (403): tampoco se reintenta solo, y con un rol de editor se envía sin perder nada', async () => {
      const s = await setup({ token: 'lector' });
      s.server.role = 'viewer';
      await edit(s.session, 'lo que escribió un lector');
      expect(s.session.getState()).toMatchObject({ save: 'error', saveErrorCode: 'forbidden' });
      expect(s.session.getState().offline?.authBlocked).toBe(1);

      s.server.log.length = 0;
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(puts(s.server)).toBe(0);

      s.server.role = 'editor';
      await s.session.useToken('lector');
      expect(await textOf(s)).toBe('lo que escribió un lector');
      expect(s.session.getState().save).toBe('saved');
      s.session.dispose();
    });

    it('al abrir la app con una credencial que el servidor ya rechaza, lo pendiente no se envía ni se insiste (solo la lectura de la lista)', async () => {
      const s = await setup({ token: 'bueno' });
      s.server.down = true;
      await edit(s.session, 'sin red');
      s.session.dispose();
      s.server.down = false;
      s.server.token = 'otro'; // el servidor cambió sus tokens mientras tanto

      s.server.log.length = 0;
      const next = await s.reopen();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(s.server.log).toEqual(['GET /api/projects']); // un solo 401, el de la lista; ni whoami ni PUT
      expect(next.getState()).toMatchObject({ available: false, errorCode: 'unauthorized' });
      expect(next.getState().offline?.waiting).toBe(1);

      await next.useToken('otro');
      expect(await textOf(s)).toBe('sin red');
      next.dispose();
    });

    it('si la comprobación de quién eres (whoami) da 401 no se envía nada, la interfaz ofrece volver a entrar y no se reintenta hasta tener credenciales', async () => {
      const s = await setup({ token: 'bueno' });
      s.server.down = true;
      await edit(s.session, 'sin red');
      s.session.dispose();
      s.server.down = false;
      s.server.inject(/\/api\/whoami$/, 401, { error: 'Falta un token válido.', code: 'unauthorized' }, 1);
      s.server.log.length = 0;
      const next = await s.reopen();
      await tick();
      expect(s.server.log.filter((entry) => entry.startsWith('PUT'))).toEqual([]);
      expect(next.getState()).toMatchObject({ syncErrorCode: 'unauthorized' });
      s.server.log.length = 0;
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(s.server.log).toEqual([]);
      await next.useToken('bueno');
      expect(await textOf(s)).toBe('sin red');
      next.dispose();
    });
  });

  describe('identidad: lo de una persona no se envía con la credencial de otra', () => {
    const ana: FakePerson = { id: 'u_ana', login: 'ana' };
    const beto: FakePerson = { id: 'u_beto', login: 'beto' };

    async function twoPeople() {
      const server = fakeServer({ accounts: true });
      const project = await server.store.createProject({ name: 'Tienda' });
      const diagram = await server.store.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text: 'v0' });
      server.share(project.id, ana, 'editor');
      server.share(project.id, beto, 'editor');
      const anaToken = server.openSession(ana);
      const betoToken = server.openSession(beto);
      const backend = new TestBackend();
      const open = async (token: string): Promise<ProjectSession> => {
        const session = new ProjectSession(new HttpProjectStore({ baseUrl: BASE, token, fetch: server.fetch }), {
          debounceMs: 50,
          broadcast: false,
          pollMs: 0,
          offline: { queue: new OfflineQueue(backend), policy: NO_JITTER, locks: false },
        });
        await session.init();
        await tick(); // quién es la credencial se averigua en segundo plano
        return session;
      };
      return { server, project, diagram, backend, open, anaToken, betoToken };
    }

    it('lo que escribió Ana sin red no lo envía Beto con su sesión: se conserva aparte y vuelve a enviarse cuando Ana entra', async () => {
      const t = await twoPeople();
      const anaSession = await t.open(t.anaToken);
      await anaSession.openDiagram(t.project.id, t.diagram.id);
      t.server.down = true;
      await edit(anaSession, 'trabajo de ana');
      anaSession.dispose();
      expect([...t.backend.rows.values()][0].owner).toBe('u:u_ana');
      t.server.down = false;

      t.server.log.length = 0;
      const betoSession = await t.open(t.betoToken);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(puts(t.server)).toBe(0); // nada se envió con la credencial de Beto
      expect(betoSession.getState().offline).toMatchObject({ waiting: 0, foreign: 1, conflicts: 0 });
      expect((await t.server.store.getDiagram(t.project.id, t.diagram.id))?.text).toBe('v0');
      betoSession.dispose();

      const anaAgain = await t.open(t.anaToken);
      await tick();
      expect((await t.server.store.getDiagram(t.project.id, t.diagram.id))?.text).toBe('trabajo de ana');
      expect(anaAgain.getState().offline).toMatchObject({ waiting: 0, foreign: 0 });
      expect(t.backend.rows.size).toBe(0);
      anaAgain.dispose();
    });

    it('lo de la otra persona se puede descartar a mano, y ninguna fila de la cola lleva el token', async () => {
      const t = await twoPeople();
      const anaSession = await t.open(t.anaToken);
      await anaSession.openDiagram(t.project.id, t.diagram.id);
      t.server.down = true;
      await edit(anaSession, 'trabajo de ana');
      anaSession.dispose();
      t.server.down = false;
      expect(JSON.stringify([...t.backend.rows.values()])).not.toContain(t.anaToken);
      expect(JSON.stringify([...t.backend.rows.values()])).not.toContain('iark_s_');

      const betoSession = await t.open(t.betoToken);
      expect(betoSession.getState().offline?.foreign).toBe(1);
      await betoSession.discardOthersQueued();
      expect(betoSession.getState().offline?.foreign).toBe(0);
      expect(t.backend.rows.size).toBe(0);
      betoSession.dispose();
    });

    it('lo de otra persona caduca al mes si nadie lo reclama; lo de la propia no caduca nunca', async () => {
      const t = await twoPeople();
      const anaSession = await t.open(t.anaToken);
      await anaSession.openDiagram(t.project.id, t.diagram.id);
      t.server.down = true;
      await edit(anaSession, 'trabajo de ana');
      anaSession.dispose();
      t.server.down = false;
      await vi.advanceTimersByTimeAsync(31 * 24 * 3600 * 1000);

      const betoSession = await t.open(t.betoToken);
      expect(t.backend.rows.size).toBe(0);
      betoSession.dispose();

      // lo de la propia persona sigue ahí pasado el mes
      const anaOffline = await t.open(t.anaToken);
      await anaOffline.openDiagram(t.project.id, t.diagram.id);
      t.server.down = true;
      await edit(anaOffline, 'otra vez');
      anaOffline.dispose();
      await vi.advanceTimersByTimeAsync(40 * 24 * 3600 * 1000);
      t.server.down = false;
      const back = await t.open(t.anaToken);
      await tick();
      expect((await t.server.store.getDiagram(t.project.id, t.diagram.id))?.text).toBe('otra vez');
      back.dispose();
    });

    it('cambiar de token en la misma pestaña (de lector a editor) lleva lo escrito a la persona nueva: se envía con su rol y no queda huérfano', async () => {
      const t = await twoPeople();
      const vic: FakePerson = { id: 'u_vic', login: 'vic' };
      t.server.share(t.project.id, vic, 'viewer');
      const vicToken = t.server.openSession(vic);
      const session = await t.open(vicToken);
      await session.openDiagram(t.project.id, t.diagram.id);
      await edit(session, 'lo que escribió un lector');
      expect(session.getState()).toMatchObject({ save: 'error', saveErrorCode: 'forbidden' });
      expect([...t.backend.rows.values()][0].owner).toBe('u:u_vic');

      await session.useToken(t.anaToken);
      await tick();
      expect((await t.server.store.getDiagram(t.project.id, t.diagram.id))?.text).toBe('lo que escribió un lector');
      expect(session.getState().offline).toMatchObject({ waiting: 0, authBlocked: 0, foreign: 0 });
      expect(t.backend.rows.size).toBe(0);
      session.dispose();
    });

    it('un cambio de token no reclama lo que escribió otra persona en otra sesión: sigue siendo suyo y no se envía con la credencial nueva', async () => {
      const t = await twoPeople();
      const carla: FakePerson = { id: 'u_carla', login: 'carla' };
      t.server.share(t.project.id, carla, 'editor');
      const carlaToken = t.server.openSession(carla);
      const anaSession = await t.open(t.anaToken);
      await anaSession.openDiagram(t.project.id, t.diagram.id);
      t.server.down = true;
      await edit(anaSession, 'trabajo de ana');
      anaSession.dispose();
      t.server.down = false;

      const betoSession = await t.open(t.betoToken);
      expect(betoSession.getState().offline).toMatchObject({ foreign: 1 });
      t.server.log.length = 0;
      await betoSession.useToken(carlaToken);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(puts(t.server)).toBe(0);
      expect((await t.server.store.getDiagram(t.project.id, t.diagram.id))?.text).toBe('v0');
      expect(betoSession.getState().offline).toMatchObject({ waiting: 0, foreign: 1 });
      expect([...t.backend.rows.values()][0].owner).toBe('u:u_ana');
      betoSession.dispose();
    });

    it('al cerrar sesión se descartan los pendientes de esa persona (descartarlos se confirma en la interfaz)', async () => {
      const t = await twoPeople();
      const anaSession = await t.open(t.anaToken);
      await anaSession.openDiagram(t.project.id, t.diagram.id);
      t.server.down = true;
      await edit(anaSession, 'trabajo de ana');
      expect(anaSession.unsentCount).toBe(1);
      await anaSession.discardQueued();
      expect(anaSession.unsentCount).toBe(0);
      expect(t.backend.rows.size).toBe(0);
      anaSession.dispose();
    });
  });

  describe('el tope', () => {
    it('si lo último no cabe en la cola avisa claro, el texto sigue en memoria (y avisa al cerrar la pestaña) y se envía al volver la red con «Reintentar»', async () => {
      const s = await setup({ limits: { maxBytes: 20, maxEntries: 5 } });
      s.server.down = true;
      await edit(s.session, 'x'.repeat(200));
      expect(s.session.getState().save).toBe('error');
      expect(s.session.getState().offline?.full).toMatch(/tope de cambios sin conexión/);
      expect(s.backend.rows.size).toBe(0);
      expect(s.session.dirty).toBe(true);

      s.server.down = false;
      await s.session.retry();
      expect(await textOf(s)).toBe('x'.repeat(200));
      expect(s.session.getState().save).toBe('saved');
      expect(s.session.dirty).toBe(false);
      s.session.dispose();
    });

    it('un cambio pequeño que sí cabe borra el aviso del tope', async () => {
      const s = await setup({ limits: { maxBytes: 20, maxEntries: 5 } });
      s.server.down = true;
      await edit(s.session, 'x'.repeat(200));
      expect(s.session.getState().offline?.full).toBeDefined();
      await edit(s.session, 'corto');
      expect(s.session.getState().offline?.full).toBeUndefined();
      expect(s.session.getState().save).toBe('offline');
      s.session.dispose();
    });
  });

  describe('lo que no cambia', () => {
    it('con los proyectos en este navegador no hay cola ni estado «offline»', async () => {
      const { MemoryProjectStore } = await import('@iark/kernel');
      const session = new ProjectSession(new MemoryProjectStore(), { broadcast: false, persist: false, debounceMs: 50 });
      await session.init();
      expect(session.getState().offline).toBeUndefined();
      expect(session.unsentCount).toBe(0);
      session.dispose();
    });

    it('un contenido que el servidor rechaza (400) sigue siendo un error con «Reintentar»: no es algo que se arregle esperando', async () => {
      const s = await setup();
      s.server.inject(/^PUT /, 400, { error: 'Documento inválido', code: 'invalid' });
      await edit(s.session, 'v1');
      expect(s.session.getState()).toMatchObject({ save: 'error', saveErrorCode: 'invalid' });
      expect(s.session.getState().offline?.waiting).toBe(0);
      expect(s.backend.rows.size).toBe(0);
      s.session.dispose();
    });

    it('con el trabajo sin conexión desactivado, un corte de red es el error de siempre', async () => {
      const server = fakeServer();
      const session = new ProjectSession(new HttpProjectStore({ baseUrl: BASE, fetch: server.fetch }), { debounceMs: 50, broadcast: false, pollMs: 0, offline: false });
      await session.init();
      await session.createProject('Tienda');
      await session.createDiagram({ module: 'c4', name: 'Contexto', text: 'v0' });
      server.down = true;
      await edit(session, 'v1');
      expect(session.getState()).toMatchObject({ save: 'error', saveErrorCode: 'unavailable' });
      expect(session.getState().offline).toBeUndefined();
      session.dispose();
    });
  });
});
