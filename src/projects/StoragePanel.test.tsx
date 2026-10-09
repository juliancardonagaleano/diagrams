// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { IDBFactory } from 'fake-indexeddb';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryProjectStore } from '@iark/kernel';
import { BACKEND_KEY, loadBackend, saveBackend, TOKEN_KEY_PREFIX, type StorageAreas } from './backend';
import { createProjectSession } from './factory';
import { ProjectSession, type SessionOptions } from './session';
import { StoragePanel, type StoragePanelProps } from './StoragePanel';
import { fakeServer, type FakeServer } from './testing';

const URL_ = 'http://localhost:8787';
const DEV = { protocol: 'http:', origin: 'http://localhost:5173' };

const localSession = (): ProjectSession => new ProjectSession(new MemoryProjectStore(), { broadcast: false, persist: false });

/** Una sesión con servidor (por la fábrica, como en la app) sobre un servidor simulado. */
async function remoteSession(server: FakeServer, token?: string, extra: SessionOptions = {}): Promise<ProjectSession> {
  const session = createProjectSession({ config: { kind: 'remote', url: URL_, token }, fetch: server.fetch, session: { broadcast: false, pollMs: 0, debounceMs: 10, ...extra } });
  await session.init();
  return session;
}

function renderPanel(session: ProjectSession, server: FakeServer, extra: Partial<StoragePanelProps> = {}) {
  const reload = vi.fn();
  const onToggle = vi.fn();
  render(<StoragePanel session={session} open onToggle={onToggle} reload={reload} fetch={server.fetch} page={DEV} {...extra} />);
  return { reload, onToggle };
}

const field = (name: string | RegExp): HTMLInputElement => screen.getByLabelText(name) as HTMLInputElement;
async function fill(url: string, token?: string): Promise<void> {
  await userEvent.type(field('Dirección del servidor'), url);
  if (token) await userEvent.type(field('Token de acceso'), token);
}
const test = (): HTMLElement => screen.getByTestId('storage-test');

describe('panel «Dónde se guardan»', () => {
  beforeEach(() => {
    // una base de IndexedDB nueva por prueba: la cola de cambios sin conexión es persistente y no debe pasar de una a otra
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => cleanup());

  describe('con un servidor propuesto en la compilación (VITE_IARK_SERVER)', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('rellena la dirección sin conectar ni cambiar dónde se guarda', () => {
      vi.stubEnv('VITE_IARK_SERVER', 'https://iark-api.onrender.com');
      const server = fakeServer();
      renderPanel(localSession(), server, { page: { protocol: 'https:', origin: 'https://usuario.github.io' } });
      expect(field('Dirección del servidor').value).toBe('https://iark-api.onrender.com');
      expect(screen.getByTestId('storage-summary')).toHaveTextContent('Este navegador'); // sigue guardando aquí hasta que se conecte
      expect(localStorage.getItem(BACKEND_KEY)).toBeNull();
    });

    it('lo guardado de antes manda sobre lo propuesto, y una propuesta inválida se ignora', () => {
      vi.stubEnv('VITE_IARK_SERVER', 'https://iark-api.onrender.com');
      saveBackend({ url: URL_, token: undefined }, { remember: true, active: false }, { local: localStorage, session: sessionStorage });
      const server = fakeServer();
      renderPanel(localSession(), server);
      expect(field('Dirección del servidor').value).toBe(URL_);
      cleanup();
      localStorage.clear();
      vi.stubEnv('VITE_IARK_SERVER', 'http://iark.example.com');
      renderPanel(localSession(), server);
      expect(field('Dirección del servidor').value).toBe('');
    });
  });

  describe('con los proyectos en este navegador', () => {
    it('muestra «Este navegador» y, plegado, solo ofrece conectar a un servidor', () => {
      const server = fakeServer();
      const onToggle = vi.fn();
      render(<StoragePanel session={localSession()} open={false} onToggle={onToggle} fetch={server.fetch} page={DEV} />);
      expect(screen.getByTestId('storage-summary')).toHaveTextContent('Este navegador');
      expect(screen.queryByTestId('storage-status')).toBeNull();
      expect(screen.queryByLabelText('Dirección del servidor')).toBeNull();
      expect(screen.getByRole('button', { name: 'Conectar a un servidor…' })).toHaveAttribute('aria-expanded', 'false');
    });

    it('«Probar conexión» dice quién eres y tu rol; «Conectar» guarda la configuración y recarga la página', async () => {
      const server = fakeServer({ token: 'secreto', name: 'Ana', role: 'editor' });
      await server.store.createProject({ name: 'Tienda' });
      const { reload } = renderPanel(localSession(), server);
      expect(screen.getByRole('button', { name: 'Conectar' })).toBeDisabled(); // sin dirección todavía
      await fill(URL_, 'secreto');
      await userEvent.type(field(/Nombre \(opcional\)/), 'Oficina');
      await userEvent.click(screen.getByRole('button', { name: 'Probar conexión' }));
      expect(await screen.findByTestId('storage-test')).toHaveTextContent('Eres «Ana» (rol editor). Tiene 1 proyecto.');
      expect(reload).not.toHaveBeenCalled();
      expect(localStorage.getItem(BACKEND_KEY)).toBeNull(); // probar no guarda nada

      await userEvent.click(screen.getByRole('button', { name: 'Conectar' }));
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect(JSON.parse(localStorage.getItem(BACKEND_KEY)!)).toEqual({ kind: 'remote', url: URL_, label: 'Oficina' });
      expect(loadBackend()).toMatchObject({ kind: 'remote', token: 'secreto', remembered: false });
    });

    it('el token queda solo en la pestaña salvo que se marque «Recordar en este equipo», y la casilla explica el riesgo', async () => {
      const server = fakeServer({ token: 'secreto' });
      const first = renderPanel(localSession(), server);
      const remember = screen.getByRole('checkbox', { name: 'Recordar en este equipo' });
      expect(remember).not.toBeChecked(); // desmarcada por omisión
      expect(remember).toHaveAccessibleDescription(/cualquier script que se ejecute en este sitio podría leerlo/);
      await fill(URL_, 'secreto');
      await userEvent.click(screen.getByRole('button', { name: 'Conectar' }));
      await waitFor(() => expect(first.reload).toHaveBeenCalled());
      expect(sessionStorage.getItem(`${TOKEN_KEY_PREFIX}${URL_}`)).toBe('secreto');
      expect([...Array(localStorage.length).keys()].map((i) => localStorage.getItem(localStorage.key(i)!)).join('')).not.toContain('secreto');
      cleanup();
      localStorage.clear();
      sessionStorage.clear();

      const second = renderPanel(localSession(), server);
      await fill(URL_, 'secreto');
      await userEvent.click(screen.getByRole('checkbox', { name: 'Recordar en este equipo' }));
      await userEvent.click(screen.getByRole('button', { name: 'Conectar' }));
      await waitFor(() => expect(second.reload).toHaveBeenCalled());
      expect(localStorage.getItem(`${TOKEN_KEY_PREFIX}${URL_}`)).toBe('secreto');
      expect(sessionStorage.length).toBe(0);
      expect(loadBackend()).toMatchObject({ remembered: true });
    });

    it('un token inválido se explica y no conecta ni guarda nada', async () => {
      const server = fakeServer({ token: 'secreto' });
      const { reload } = renderPanel(localSession(), server);
      await fill(URL_, 'equivocado');
      await userEvent.click(screen.getByRole('button', { name: 'Conectar' }));
      expect(await screen.findByTestId('storage-test')).toHaveTextContent('El servidor no aceptó el token');
      expect(test()).toHaveAttribute('data-problem', 'unauthorized');
      expect(reload).not.toHaveBeenCalled();
      expect(localStorage.getItem(BACKEND_KEY)).toBeNull();
      expect(sessionStorage.length).toBe(0);
    });

    it('un servidor sin proyectos (arrancó sin --workspace) lo dice', async () => {
      const server = fakeServer({ noProjects: true });
      renderPanel(localSession(), server);
      await fill(URL_);
      await userEvent.click(screen.getByRole('button', { name: 'Probar conexión' }));
      expect(await screen.findByTestId('storage-test')).toHaveTextContent('no ofrece proyectos');
      expect(test()).toHaveTextContent('--workspace');
    });

    it('sin conexión y CORS rechazado se distinguen, y el aviso de CORS lleva el origen exacto de esta página', async () => {
      const server = fakeServer();
      renderPanel(localSession(), server);
      expect(screen.getByText('--cors http://localhost:5173')).toBeInTheDocument(); // siempre a la vista, antes de probar
      await fill(URL_);
      server.down = true;
      await userEvent.click(screen.getByRole('button', { name: 'Probar conexión' }));
      expect(await screen.findByTestId('storage-test')).toHaveTextContent('No se llega a localhost:8787');

      server.down = false;
      server.corsBlocked = true;
      await userEvent.click(screen.getByRole('button', { name: 'Probar conexión' }));
      await waitFor(() => expect(test()).toHaveAttribute('data-problem', 'cors'));
      expect(test()).toHaveTextContent('Arráncalo con --cors http://localhost:5173');
    });

    it('desde una página https avisa del contenido mixto mientras se escribe la dirección http, y no la deja conectar', async () => {
      const server = fakeServer();
      const { reload } = renderPanel(localSession(), server, { page: { protocol: 'https:', origin: 'https://usuario.github.io' } });
      await userEvent.type(field('Dirección del servidor'), 'http://iark.ejemplo.org');
      expect(screen.getByTestId('storage-mixed')).toHaveTextContent('contenido mixto');
      await userEvent.click(screen.getByRole('button', { name: 'Conectar' }));
      expect(await screen.findByTestId('storage-test')).toHaveAttribute('data-problem', 'mixed-content');
      expect(reload).not.toHaveBeenCalled();
      // al servidor escrito no llegó nada (lo único que se pregunta es si la propia página la sirve una instancia gestionada)
      expect(server.log.filter((entry) => entry !== 'GET /api/auth/providers')).toEqual([]);

      // con https, o con la propia máquina, no hay aviso
      await userEvent.clear(field('Dirección del servidor'));
      await userEvent.type(field('Dirección del servidor'), 'http://localhost:8787');
      expect(screen.queryByTestId('storage-mixed')).toBeNull();
    });

    it('con el almacenamiento del navegador bloqueado no recarga y lo explica', async () => {
      const server = fakeServer();
      const blocked = () => {
        throw new DOMException('bloqueado', 'SecurityError');
      };
      const areas: StorageAreas = { local: { getItem: blocked, setItem: blocked, removeItem: blocked }, session: { getItem: blocked, setItem: blocked, removeItem: blocked } };
      const { reload } = renderPanel(localSession(), server, { areas });
      await fill(URL_);
      await userEvent.click(screen.getByRole('button', { name: 'Conectar' }));
      expect(await screen.findByTestId('storage-problem')).toHaveTextContent('no deja guardar la configuración');
      expect(reload).not.toHaveBeenCalled();
    });

    it('«Olvidar este servidor» aparece solo si hay uno conocido y borra su dirección y su token', async () => {
      saveBackend({ url: URL_, token: 'secreto', label: 'Oficina' }, { active: false });
      const server = fakeServer({ token: 'secreto' });
      renderPanel(localSession(), server);
      expect(field('Dirección del servidor').value).toBe(URL_);
      expect(field(/Nombre \(opcional\)/).value).toBe('Oficina');
      expect(field('Token de acceso')).toHaveValue(''); // el token no se vuelca en el formulario
      expect(field('Token de acceso').placeholder).toMatch(/conserva/);
      await userEvent.click(screen.getByRole('button', { name: 'Olvidar este servidor' }));
      expect(loadBackend()).toEqual({ kind: 'local' });
      expect(sessionStorage.length).toBe(0);
      expect(field('Dirección del servidor')).toHaveValue('');
      expect(screen.queryByRole('button', { name: 'Olvidar este servidor' })).toBeNull();
    });

    it('con un proyecto elegido para copiar, guarda el servidor sin activarlo y avisa para que el gestor copie (sin recargar)', async () => {
      const server = fakeServer({ token: 'secreto' });
      const onCopy = vi.fn();
      const { reload } = renderPanel(localSession(), server, { copyFor: { name: 'Tienda' }, onCopy });
      expect(screen.getByText(/siguen en este navegador: la copia no cambia dónde se guardan/)).toBeInTheDocument();
      await fill(URL_, 'secreto');
      await userEvent.click(screen.getByRole('button', { name: 'Copiar «Tienda» al servidor' }));
      await waitFor(() => expect(onCopy).toHaveBeenCalledTimes(1));
      expect(reload).not.toHaveBeenCalled();
      // el almacén activo sigue siendo este navegador, pero el servidor queda conocido
      expect(loadBackend()).toMatchObject({ kind: 'local', server: { url: URL_, token: 'secreto' } });
    });
  });

  describe('con los proyectos en un servidor', () => {
    it('muestra «Servidor: <host> (<nombre>, <rol>)» y su estado', async () => {
      const server = fakeServer({ token: 'secreto', name: 'Ana', role: 'admin' });
      const session = await remoteSession(server, 'secreto');
      renderPanel(session, server);
      await waitFor(() => expect(screen.getByTestId('storage-summary')).toHaveTextContent('Servidor: localhost:8787 (Ana, admin)'));
      expect(screen.getByTestId('storage-status')).toHaveTextContent('Conectado');
      expect(screen.getByRole('button', { name: 'Volver a este navegador' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Olvidar este servidor' })).toBeNull();
    });

    it('un servidor abierto se muestra como «sin autenticación»', async () => {
      const server = fakeServer();
      renderPanel(await remoteSession(server), server);
      await waitFor(() => expect(screen.getByTestId('storage-summary')).toHaveTextContent('Servidor: localhost:8787 (sin autenticación)'));
    });

    it('«Volver a este navegador» guarda lo pendiente, deja la configuración en local (conservando el servidor) y recarga', async () => {
      const server = fakeServer({ token: 'secreto' });
      saveBackend({ url: URL_, token: 'secreto' });
      const session = await remoteSession(server, 'secreto');
      const project = await session.createProject('Tienda');
      const meta = await session.createDiagram({ module: 'c4', name: 'A', text: 'a0' });
      session.queueSave('a1'); // pendiente: se guarda antes de recargar
      const { reload } = renderPanel(session, server);
      await userEvent.click(screen.getByRole('button', { name: 'Volver a este navegador' }));
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect((await server.store.getDiagram(project.id, meta.id))?.text).toBe('a1');
      expect(loadBackend()).toMatchObject({ kind: 'local', server: { url: URL_, token: 'secreto' } });
    });

    it('un cambio que no pudo enviarse por la red queda guardado en este navegador: volver a él no lo pierde ni pide confirmar', async () => {
      const server = fakeServer();
      saveBackend({ url: URL_ });
      const session = await remoteSession(server);
      await session.createProject('Tienda');
      await session.createDiagram({ module: 'c4', name: 'A', text: 'a0' });
      server.down = true;
      session.queueSave('sin enviar');
      await waitFor(() => expect(session.getState().save).toBe('offline'));
      expect(session.dirty).toBe(false);
      const { reload } = renderPanel(session, server);
      expect(screen.getByTestId('storage-status')).toHaveTextContent('Sin conexión');
      await userEvent.click(screen.getByRole('button', { name: 'Volver a este navegador' }));
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect(screen.queryByTestId('storage-loss')).toBeNull(); // sobrevive a recargar: se enviará al volver a ese servidor
      expect(loadBackend().kind).toBe('local');
    });

    it('si lo pendiente no pudo guardarse ni en este navegador (sin trabajo sin conexión), pide confirmar antes de recargar porque se perdería', async () => {
      const server = fakeServer();
      saveBackend({ url: URL_ });
      const session = await remoteSession(server, undefined, { offline: false });
      await session.createProject('Tienda');
      await session.createDiagram({ module: 'c4', name: 'A', text: 'a0' });
      server.down = true;
      session.queueSave('sin guardar');
      await waitFor(() => expect(session.getState().save).toBe('error'));
      const { reload } = renderPanel(session, server);
      await userEvent.click(screen.getByRole('button', { name: 'Volver a este navegador' }));
      expect(await screen.findByTestId('storage-loss')).toHaveTextContent('se perderán');
      expect(reload).not.toHaveBeenCalled();
      expect(loadBackend()).toMatchObject({ kind: 'remote' });
      await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
      expect(screen.queryByTestId('storage-loss')).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: 'Volver a este navegador' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Seguir y descartarlos' }));
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect(loadBackend().kind).toBe('local');
    });

    it('si el servidor no aceptó el token, lo dice y deja escribir el correcto sin recargar y sin perder el texto pendiente', async () => {
      const server = fakeServer({ token: 'viejo' });
      saveBackend({ url: URL_, token: 'viejo' });
      const session = await remoteSession(server, 'viejo');
      const project = await session.createProject('Tienda');
      const meta = await session.createDiagram({ module: 'c4', name: 'A', text: 'a0' });
      server.token = 'nuevo';
      session.queueSave('lo que escribí');
      await waitFor(() => expect(session.getState().saveErrorCode).toBe('unauthorized'));

      const { reload } = renderPanel(session, server);
      expect(screen.getByTestId('storage-rejected')).toHaveTextContent('El servidor no aceptó el token');
      expect(screen.getByTestId('storage-status')).toHaveTextContent('Token rechazado');
      expect(field('Token de acceso')).toHaveFocus();
      expect(screen.getByRole('button', { name: 'Usar este token' })).toBeInTheDocument(); // misma dirección: solo cambia el token

      await userEvent.type(field('Token de acceso'), 'nuevo');
      await userEvent.click(screen.getByRole('button', { name: 'Usar este token' }));
      expect(await screen.findByTestId('storage-message')).toHaveTextContent('Token actualizado');
      expect(reload).not.toHaveBeenCalled();
      expect((await server.store.getDiagram(project.id, meta.id))?.text).toBe('lo que escribí');
      expect(session.getState()).toMatchObject({ save: 'saved', saveErrorCode: undefined });
      expect(sessionStorage.getItem(`${TOKEN_KEY_PREFIX}${URL_}`)).toBe('nuevo');
      await waitFor(() => expect(screen.getByTestId('storage-status')).toHaveTextContent('Conectado'));
      expect(screen.queryByTestId('storage-rejected')).toBeNull();
    });

    it('con un token de solo lectura lo dice (no es un token rechazado) y el token de editor retoma el guardado', async () => {
      const server = fakeServer({ token: 'lector', role: 'viewer', name: 'Vic' });
      saveBackend({ url: URL_, token: 'lector' });
      const session = await remoteSession(server, 'lector');
      const project = await server.store.createProject({ name: 'Tienda' });
      const meta = await server.store.saveDiagram(project.id, { module: 'c4', name: 'A', text: 'a0' });
      await session.refresh();
      await session.openDiagram(project.id, meta.id);
      session.queueSave('lo que escribió un visor');
      await waitFor(() => expect(session.getState().saveErrorCode).toBe('forbidden'));

      renderPanel(session, server);
      expect(screen.getByTestId('storage-forbidden')).toHaveTextContent('su rol no permite guardar');
      expect(screen.queryByTestId('storage-rejected')).toBeNull();
      expect(screen.getByTestId('storage-status')).toHaveTextContent('Conectado');
      await waitFor(() => expect(screen.getByTestId('storage-summary')).toHaveTextContent('(Vic, viewer)'));

      server.token = 'editor';
      server.role = 'editor';
      server.name = 'Ana';
      await userEvent.type(field('Token de acceso'), 'editor');
      await userEvent.click(screen.getByRole('button', { name: 'Usar este token' }));
      expect(await screen.findByTestId('storage-message')).toHaveTextContent('Token actualizado');
      expect((await server.store.getDiagram(project.id, meta.id))?.text).toBe('lo que escribió un visor');
      await waitFor(() => expect(screen.getByTestId('storage-summary')).toHaveTextContent('(Ana, editor)'));
      expect(screen.queryByTestId('storage-forbidden')).toBeNull();
    });

    it('cambiar a otro servidor sí recarga, y no antes de probar que responde', async () => {
      const server = fakeServer();
      saveBackend({ url: URL_ });
      const session = await remoteSession(server);
      const { reload } = renderPanel(session, server);
      await userEvent.clear(field('Dirección del servidor'));
      await userEvent.type(field('Dirección del servidor'), 'http://localhost:9999');
      await userEvent.click(screen.getByRole('button', { name: 'Conectar' }));
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect(loadBackend()).toMatchObject({ kind: 'remote', url: 'http://localhost:9999' });
    });

    it('la dirección escrita sin tocar la anterior se normaliza (barra final, ruta de la API)', async () => {
      const server = fakeServer();
      const { reload } = renderPanel(localSession(), server);
      await fill('http://localhost:8787/api/projects/');
      await userEvent.click(screen.getByRole('button', { name: 'Conectar' }));
      await waitFor(() => expect(reload).toHaveBeenCalled());
      expect(loadBackend()).toMatchObject({ kind: 'remote', url: 'http://localhost:8787' });
      expect(within(screen.getByTestId('storage-panel')).getByTestId('storage-test')).toHaveTextContent('http://localhost:8787.');
    });
  });
});
