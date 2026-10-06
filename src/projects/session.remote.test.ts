// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpProjectStore } from '@iark/kernel';
import { DEFAULT_POLL_MS, ProjectSession } from './session';
import { fakeServer } from './testing';

/**
 * La sesión con un almacén remoto (el cliente HTTP sobre un servidor simulado): el autoguardado, el conflicto entre dos
 * personas, el reintento tras un corte de red, un token que el servidor no acepta y cómo se mantiene al día la lista.
 */
const BASE = 'http://localhost:8787';

async function setup(options: { token?: string; pollMs?: number } = {}) {
  const server = fakeServer({ token: options.token });
  const client = new HttpProjectStore({ baseUrl: BASE, token: options.token, fetch: server.fetch });
  const other = new HttpProjectStore({ baseUrl: BASE, token: options.token, fetch: server.fetch });
  const session = new ProjectSession(client, { debounceMs: 50, broadcast: false, pollMs: options.pollMs ?? DEFAULT_POLL_MS });
  await session.init();
  const project = await session.createProject('Tienda');
  const meta = await session.createDiagram({ module: 'c4', name: 'Contexto', text: 'v0' });
  return { server, client, other, session, project, meta };
}

const hidden = (value: boolean): void => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (value ? 'hidden' : 'visible') });
};

describe('sesión con un almacén remoto', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: false }));
  afterEach(() => {
    vi.useRealTimers();
    hidden(false);
  });

  it('se reconoce como remota por su almacén y guarda solo tras una pausa, con una petición por guardado', async () => {
    const { server, session, project, meta } = await setup();
    expect(session.remote).toBe(true);
    expect(session.backend).toEqual({ kind: 'remote', url: BASE, host: 'localhost:8787' });
    server.log.length = 0;
    session.queueSave('v1');
    session.queueSave('v2');
    expect(session.getState().save).toBe('pending');
    expect(server.log).toEqual([]);
    await vi.advanceTimersByTimeAsync(60);
    // un PUT con el último texto y luego se relee la lista (para la marca de modificación)
    expect(server.log).toEqual([`PUT /api/projects/${project.id}/diagrams/${meta.id}`, 'GET /api/projects']);
    expect((await server.store.getDiagram(project.id, meta.id))?.text).toBe('v2');
    expect(session.getState()).toMatchObject({ save: 'saved', saveError: undefined, saveErrorCode: undefined });
    expect(session.dirty).toBe(false);
    session.dispose();
  });

  it('si otra persona guardó el mismo diagrama, avisa del conflicto y se resuelve igual que entre pestañas', async () => {
    const { server, other, session, project, meta } = await setup();
    await other.saveDiagram(project.id, { id: meta.id, text: 'de la otra persona' });

    session.queueSave('mío');
    await vi.advanceTimersByTimeAsync(60);
    expect(session.getState()).toMatchObject({ save: 'conflict', saveErrorCode: 'conflict' });
    expect((await server.store.getDiagram(project.id, meta.id))?.text).toBe('de la otra persona');
    expect(session.dirty).toBe(true);

    await session.resolveConflict('overwrite');
    await vi.advanceTimersByTimeAsync(0);
    expect((await server.store.getDiagram(project.id, meta.id))?.text).toBe('mío');
    expect(session.getState().save).toBe('saved');

    await other.saveDiagram(project.id, { id: meta.id, text: 'otra vez de la otra' });
    session.queueSave('segundo intento');
    await vi.advanceTimersByTimeAsync(60);
    expect(session.getState().save).toBe('conflict');
    expect((await session.resolveConflict('reload'))?.text).toBe('otra vez de la otra');
    expect(session.getState().save).toBe('idle');
    expect(session.dirty).toBe(false);
    session.dispose();
  });

  describe('un corte de red al guardar', () => {
    it('deja el estado de error con el texto pendiente y se puede reintentar a mano', async () => {
      const { server, session, project, meta } = await setup();
      server.down = true;
      session.queueSave('v1');
      await vi.advanceTimersByTimeAsync(60);
      expect(session.getState()).toMatchObject({ save: 'error', saveErrorCode: 'unavailable' });
      expect(session.getState().saveError).toMatch(/No se pudo conectar con http:\/\/localhost:8787/);
      expect(session.dirty).toBe(true);
      // la lista que se veía sigue ahí, y el almacén sigue «disponible»
      expect(session.getState().available).toBe(true);

      server.down = false;
      await session.retry();
      expect(session.getState().save).toBe('saved');
      expect((await server.store.getDiagram(project.id, meta.id))?.text).toBe('v1');
      session.dispose();
    });

    it('reintenta solo al volver la conexión (online) y al volver el foco, pero con la ventana oculta espera', async () => {
      const { server, session, project, meta } = await setup();
      server.down = true;
      session.queueSave('v1');
      await vi.advanceTimersByTimeAsync(60);
      expect(session.getState().save).toBe('error');

      // sigue sin red: el aviso `online` no consigue nada, pero tampoco rompe nada
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(0);
      expect(session.getState().save).toBe('error');

      // ventana oculta: el foco no cuenta
      server.down = false;
      hidden(true);
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
      expect(session.getState().save).toBe('error');

      hidden(false);
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(0);
      expect(session.getState().save).toBe('saved');
      expect((await server.store.getDiagram(project.id, meta.id))?.text).toBe('v1');

      // y con `online`
      server.down = true;
      session.queueSave('v2');
      await vi.advanceTimersByTimeAsync(60);
      expect(session.getState().save).toBe('error');
      server.down = false;
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(0);
      expect(session.getState().save).toBe('saved');
      expect((await server.store.getDiagram(project.id, meta.id))?.text).toBe('v2');
      session.dispose();
    });

    it('lo que no es de la red (el contenido, un conflicto) no se reintenta solo', async () => {
      const { server, session, other, project, meta } = await setup();
      await other.saveDiagram(project.id, { id: meta.id, text: 'otra' });
      session.queueSave('mío');
      await vi.advanceTimersByTimeAsync(60);
      expect(session.getState().save).toBe('conflict');
      server.log.length = 0;
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(0);
      expect(server.log.filter((entry) => entry.startsWith('PUT'))).toEqual([]);
      session.dispose();
    });
  });

  describe('un token que el servidor no acepta', () => {
    it('deja el aviso unauthorized sin perder el texto, no lo reintenta solo y se retoma al dar el token bueno sin recargar', async () => {
      const { server, session, project, meta } = await setup({ token: 'viejo' });
      server.token = 'nuevo'; // el servidor cambió sus tokens
      session.queueSave('lo que escribí');
      await vi.advanceTimersByTimeAsync(60);
      expect(session.getState()).toMatchObject({ save: 'error', saveErrorCode: 'unauthorized' });
      expect(session.dirty).toBe(true);
      expect((await server.store.getDiagram(project.id, meta.id))?.text).toBe('v0');

      // el foco o la red no lo arreglan: no se reintenta solo
      server.log.length = 0;
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(0);
      expect(server.log.filter((entry) => entry.startsWith('PUT'))).toEqual([]);

      // tampoco `flush` (antes de cambiar de almacén o iniciar sesión): volver a llamar con una credencial que no vale solo suma fallos contra el servidor
      await session.flush();
      expect(server.log.filter((entry) => entry.startsWith('PUT'))).toEqual([]);
      expect(session.dirty).toBe(true);

      await session.useToken('nuevo');
      expect(session.getState()).toMatchObject({ save: 'saved', saveError: undefined, saveErrorCode: undefined, available: true });
      expect((await server.store.getDiagram(project.id, meta.id))?.text).toBe('lo que escribí');
      expect(session.dirty).toBe(false);
      session.dispose();
    });

    it('con un token de solo lectura el guardado deja el aviso forbidden sin perder el texto, y un token de editor lo retoma sin recargar', async () => {
      const { server, session, project, meta } = await setup({ token: 'lector' });
      server.role = 'viewer';
      session.queueSave('lo que escribí');
      await vi.advanceTimersByTimeAsync(60);
      expect(session.getState()).toMatchObject({ save: 'error', saveErrorCode: 'forbidden' });
      expect(session.dirty).toBe(true);
      expect((await server.store.getDiagram(project.id, meta.id))?.text).toBe('v0');

      server.role = 'editor'; // otra persona (o el administrador) le sube el rol, o se cambia a otro token
      await session.useToken('lector');
      expect(session.getState()).toMatchObject({ save: 'saved', saveErrorCode: undefined });
      expect((await server.store.getDiagram(project.id, meta.id))?.text).toBe('lo que escribí');
      session.dispose();
    });

    it('al abrir sin token en un servidor que lo pide, el almacén queda no disponible con el código unauthorized, y useToken lo recupera', async () => {
      const server = fakeServer({ token: 'secreto' });
      await server.store.createProject({ name: 'Ya existía' });
      const client = new HttpProjectStore({ baseUrl: BASE, fetch: server.fetch });
      const session = new ProjectSession(client, { broadcast: false, pollMs: 0 });
      await session.init();
      expect(session.getState()).toMatchObject({ ready: true, available: false, errorCode: 'unauthorized', projects: [] });
      await session.useToken('secreto');
      expect(session.getState()).toMatchObject({ available: true, errorCode: undefined });
      expect(session.getState().projects.map((p) => p.name)).toEqual(['Ya existía']);
      session.dispose();
    });
  });

  describe('mantener la lista al día (no hay aviso entre equipos)', () => {
    const lists = (log: string[]): number => log.filter((entry) => entry === 'GET /api/projects').length;

    it('con el gestor cerrado y sin diagrama abierto no lee nada por su cuenta', async () => {
      const server = fakeServer();
      const session = new ProjectSession(new HttpProjectStore({ baseUrl: BASE, fetch: server.fetch }), { broadcast: false });
      await session.init();
      server.log.length = 0;
      await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS * 3);
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(0);
      expect(server.log).toEqual([]);
      session.dispose();
    });

    it('con el gestor abierto (watch) lee al abrir, cada 30 s y al volver el foco, y deja de hacerlo al cerrarlo', async () => {
      const server = fakeServer();
      const session = new ProjectSession(new HttpProjectStore({ baseUrl: BASE, fetch: server.fetch }), { broadcast: false });
      await session.init();
      server.log.length = 0;
      const stop = session.watch();
      await vi.advanceTimersByTimeAsync(0);
      expect(lists(server.log)).toBe(1);

      // otra persona crea un proyecto: aparece en el siguiente sondeo
      await server.store.createProject({ name: 'De otro equipo' });
      await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS + 10);
      expect(lists(server.log)).toBe(2);
      expect(session.getState().projects.map((p) => p.name)).toEqual(['De otro equipo']);

      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(0);
      expect(lists(server.log)).toBe(3);

      // con la ventana oculta no se sondea
      hidden(true);
      await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS * 2);
      expect(lists(server.log)).toBe(3);
      hidden(false);

      stop();
      stop(); // soltar dos veces no resta de más
      await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS * 2);
      expect(lists(server.log)).toBe(3);
      session.dispose();
    });

    it('con un diagrama abierto sigue sondeando aunque el gestor esté cerrado (la barra y los enlaces dependen de la lista)', async () => {
      const { server, session, other, project } = await setup();
      server.log.length = 0;
      await other.createProject({ name: 'Otro' });
      await other.saveDiagram(project.id, { module: 'data', name: 'Nuevo de otro', text: '{}' });
      await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS + 10);
      expect(lists(server.log)).toBe(1);
      expect(session.getState().projects.map((p) => p.name).sort()).toEqual(['Otro', 'Tienda']);
      expect(session.project?.diagrams.map((d) => d.name)).toContain('Nuevo de otro');
      session.dispose();
    });

    it('si el servidor rechaza el token, deja de sondear (insistir solo suma intentos fallidos) hasta que se dé uno nuevo', async () => {
      const { server, session } = await setup({ token: 'bueno' });
      const stop = session.watch();
      await vi.advanceTimersByTimeAsync(0);
      server.token = 'otro'; // el servidor cambió sus tokens
      await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS + 10);
      expect(session.getState()).toMatchObject({ available: true, syncErrorCode: 'unauthorized' });
      server.log.length = 0;
      await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS * 3);
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(0);
      expect(server.log).toEqual([]);

      await session.useToken('otro');
      expect(session.getState()).toMatchObject({ syncError: undefined, syncErrorCode: undefined });
      server.log.length = 0;
      await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS + 10);
      expect(lists(server.log)).toBe(1);
      stop();
      session.dispose();
    });

    it('un corte de red en una lectura en segundo plano no desactiva la pantalla: avisa y se recupera solo', async () => {
      const { server, session } = await setup();
      const stop = session.watch();
      await vi.advanceTimersByTimeAsync(0);
      server.down = true;
      await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS + 10);
      expect(session.getState()).toMatchObject({ available: true, syncErrorCode: 'unavailable' });
      expect(session.getState().syncError).toMatch(/No se pudo conectar/);
      expect(session.getState().projects).toHaveLength(1); // conserva la última lista que pudo leer
      server.down = false;
      await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS + 10);
      expect(session.getState()).toMatchObject({ available: true, syncError: undefined, syncErrorCode: undefined });
      stop();
      session.dispose();
    });

    it('si otra persona borra el diagrama que se está editando, deja de guardar en él y lo pendiente se descarta (el texto sigue en el editor)', async () => {
      const { session, other, project, meta } = await setup();
      session.queueSave('editando');
      await other.deleteDiagram(project.id, meta.id);
      await session.refresh({ background: true });
      expect(session.getState()).toMatchObject({ projectId: project.id, diagramId: undefined, save: 'idle' });
      expect(session.attached).toBe(false);
      expect(session.dirty).toBe(false);
      session.dispose();
    });

    it('dispose quita los avisos de la ventana y el temporizador', async () => {
      const server = fakeServer();
      const session = new ProjectSession(new HttpProjectStore({ baseUrl: BASE, fetch: server.fetch }), { broadcast: false });
      await session.init();
      session.watch();
      session.dispose();
      server.log.length = 0;
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS * 2);
      expect(server.log).toEqual([]);
    });
  });
});
