// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryProjectStore, ProjectError } from '@iark/kernel';
import { BACKEND_KEY, loadBackend, saveBackend, TOKEN_KEY_PREFIX } from './backend';
import { createProjectSession } from './factory';
import { getLoginNotice, setLoginNotice } from './login';
import { ProjectSession } from './session';
import { StoragePanel, type StoragePanelProps } from './StoragePanel';
import { fakeServer, type FakePerson, type FakeServer } from './testing';

/** El panel «Dónde se guardan» con un servidor que ofrece iniciar sesión con GitHub: el botón, la ficha, cerrar sesión, la caducidad y el aviso al volver. */
const URL_ = 'http://localhost:8787';
const DEV = { protocol: 'http:', origin: 'http://localhost:5173' };
const ANA: FakePerson = { id: 'u_1', login: 'ana', name: 'Ana García', avatarUrl: 'https://avatars.example/u/1', siteRole: 'member' };

const localSession = (): ProjectSession => new ProjectSession(new MemoryProjectStore(), { broadcast: false, persist: false });

async function remoteSession(server: FakeServer, token?: string, label?: string): Promise<ProjectSession> {
  const session = createProjectSession({ config: { kind: 'remote', url: URL_, token, ...(label ? { label } : {}) }, fetch: server.fetch, session: { broadcast: false, pollMs: 0, debounceMs: 10 } });
  await session.init();
  return session;
}

function renderPanel(session: ProjectSession, server: FakeServer, extra: Partial<StoragePanelProps> = {}) {
  const reload = vi.fn();
  const startLogin = vi.fn(async (..._args: Parameters<NonNullable<StoragePanelProps['startLogin']>>) => 'https://destino.example/login');
  render(<StoragePanel session={session} open onToggle={vi.fn()} reload={reload} fetch={server.fetch} page={DEV} detect={false} startLogin={startLogin} {...extra} />);
  return { reload, startLogin };
}

const field = (name: string | RegExp): HTMLInputElement => screen.getByLabelText(name) as HTMLInputElement;
const githubButton = (): HTMLElement => screen.getByRole('button', { name: 'Iniciar sesión con GitHub' });
const findGithubButton = (): Promise<HTMLElement> => screen.findByRole('button', { name: 'Iniciar sesión con GitHub' });

describe('panel «Dónde se guardan» con inicio de sesión de GitHub', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    setLoginNotice(undefined);
  });
  afterEach(() => cleanup());

  describe('antes de entrar', () => {
    it('al escribir la dirección de un servidor que ofrece GitHub, el botón es el camino principal y el token queda en un plegable', async () => {
      const server = fakeServer({ accounts: true });
      renderPanel(localSession(), server);
      expect(screen.queryByRole('button', { name: 'Iniciar sesión con GitHub' })).toBeNull(); // sin dirección no se sabe qué ofrece
      await userEvent.type(field('Dirección del servidor'), URL_);
      const button = await findGithubButton();
      expect(button).toHaveClass('pj-primary');
      expect(server.log).toContain('GET /api/auth/providers');
      // el token ya no está a la vista: se pliega en «Usar un token»
      expect(screen.getByText('Usar un token')).toBeInTheDocument();
      expect(field('Token de acceso')).not.toBeVisible();
      await userEvent.click(screen.getByText('Usar un token'));
      expect(field('Token de acceso')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Conectar con un token' })).not.toHaveClass('pj-primary');
      // la casilla de GitHub está marcada por omisión y avisa de dónde se guarda
      const keep = screen.getByRole('checkbox', { name: 'Mantener la sesión en este equipo' });
      expect(keep).toBeChecked();
      expect(keep).toHaveAccessibleDescription(/se guarda en este navegador/);
      expect(keep).toHaveAccessibleDescription(/caduca sola/);
      expect(screen.getByTestId('storage-invite-only')).toHaveTextContent('solo por invitación');
    });

    it('el botón inicia sesión en la dirección escrita, con «mantener la sesión» y el nombre; sin marcarla, solo en esta pestaña', async () => {
      const server = fakeServer({ accounts: true });
      const { startLogin, reload } = renderPanel(localSession(), server);
      await userEvent.type(field('Dirección del servidor'), `${URL_}/`);
      await userEvent.type(field(/Nombre \(opcional\)/), 'Oficina');
      await userEvent.click(await findGithubButton());
      await waitFor(() => expect(startLogin).toHaveBeenCalledTimes(1));
      expect(startLogin).toHaveBeenCalledWith({ server: URL_, remember: true, label: 'Oficina' });
      expect(reload).not.toHaveBeenCalled(); // quien navega es el inicio de sesión
      expect(loadBackend()).toEqual({ kind: 'local' }); // y no se guarda nada hasta volver con la sesión

      await userEvent.click(screen.getByRole('checkbox', { name: 'Mantener la sesión en este equipo' }));
      await userEvent.click(githubButton());
      await waitFor(() => expect(startLogin).toHaveBeenCalledTimes(2));
      expect(startLogin).toHaveBeenLastCalledWith({ server: URL_, remember: false, label: 'Oficina' });
    });

    it('Intro en la dirección inicia sesión (no «conecta sin token»), y «Probar conexión» no espera a la pausa para ofrecer GitHub', async () => {
      const server = fakeServer({ accounts: true });
      const { startLogin } = renderPanel(localSession(), server);
      await userEvent.type(field('Dirección del servidor'), `${URL_}{Enter}`); // Intro antes de que el panel sepa que hay GitHub: prueba, no navega
      expect(startLogin).not.toHaveBeenCalled();
      await findGithubButton();
      await userEvent.type(field('Dirección del servidor'), '{Enter}');
      await waitFor(() => expect(startLogin).toHaveBeenCalledTimes(1));
    });

    it('«Probar conexión» con un servidor que pide sesión lo dice con las palabras de la sesión, no «el token no es válido»', async () => {
      const server = fakeServer({ accounts: true });
      renderPanel(localSession(), server);
      await userEvent.type(field('Dirección del servidor'), URL_);
      await userEvent.click(screen.getByRole('button', { name: 'Probar conexión' }));
      expect(await screen.findByTestId('storage-test')).toHaveTextContent('Este servidor pide iniciar sesión: pulsa «Iniciar sesión con GitHub»');
      expect(screen.getByTestId('storage-test')).toHaveAttribute('data-problem', 'unauthorized');
      await findGithubButton();
    });

    it('un servidor autoalojado con --tokens (sin GitHub) se ve y funciona exactamente como antes', async () => {
      const server = fakeServer({ token: 'secreto', name: 'Ana', role: 'editor' });
      const { reload } = renderPanel(localSession(), server);
      await userEvent.type(field('Dirección del servidor'), URL_);
      await waitFor(() => expect(server.log).toContain('GET /api/auth/providers')); // se preguntó y no ofrece nada (404 de un servidor anterior)
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.queryByRole('button', { name: 'Iniciar sesión con GitHub' })).toBeNull();
      expect(screen.queryByText('Usar un token')).toBeNull();
      expect(field('Token de acceso')).toBeVisible();
      expect(screen.getByRole('checkbox', { name: 'Recordar en este equipo' })).not.toBeChecked();
      expect(screen.queryByRole('checkbox', { name: 'Mantener la sesión en este equipo' })).toBeNull();
      await userEvent.type(field('Token de acceso'), 'secreto');
      await userEvent.click(screen.getByRole('button', { name: 'Conectar' }));
      await waitFor(() => expect(reload).toHaveBeenCalled());
      expect(loadBackend()).toMatchObject({ kind: 'remote', url: URL_, token: 'secreto' });
    });

    it('con GitHub ofrecido, un token también conecta (plegable «Usar un token»)', async () => {
      const server = fakeServer({ accounts: true, token: 'servicio', name: 'ci', role: 'editor' });
      const { reload, startLogin } = renderPanel(localSession(), server);
      await userEvent.type(field('Dirección del servidor'), URL_);
      await findGithubButton();
      await userEvent.click(screen.getByText('Usar un token'));
      await userEvent.type(field('Token de acceso'), 'servicio');
      await userEvent.click(screen.getByRole('button', { name: 'Conectar con un token' }));
      await waitFor(() => expect(reload).toHaveBeenCalled());
      expect(startLogin).not.toHaveBeenCalled();
      expect(loadBackend()).toMatchObject({ kind: 'remote', url: URL_, token: 'servicio' });
    });

    it('si el servidor ofrece GitHub pero no se puede empezar (sin criptografía, datos bloqueados), lo explica', async () => {
      const server = fakeServer({ accounts: true });
      const failing = vi.fn(async () => {
        throw new ProjectError('unavailable', 'Este navegador no ofrece criptografía a esta página (hace falta https, o localhost).');
      });
      renderPanel(localSession(), server, { startLogin: failing });
      await userEvent.type(field('Dirección del servidor'), URL_);
      await userEvent.click(await findGithubButton());
      expect(await screen.findByTestId('storage-problem')).toHaveTextContent('hace falta https');
    });

    it('si esta página la sirve una instancia gestionada, propone su dirección ya escrita (sin pisar lo que la persona ya escribió)', async () => {
      const server = fakeServer({ accounts: true });
      const providers = { providers: [{ id: 'github', label: 'GitHub' }], tokens: false, signup: 'open' as const };
      const detect = vi.fn(async () => ({ url: 'https://iark.ejemplo.org', providers }));
      renderPanel(localSession(), server, { detect });
      await waitFor(() => expect(field('Dirección del servidor').value).toBe('https://iark.ejemplo.org'));
      expect(screen.getByTestId('storage-managed')).toHaveTextContent('Esta página la sirve la instancia iark.ejemplo.org');
      expect(githubButton()).toBeInTheDocument(); // ya no hace falta preguntar: el sitio dijo qué ofrece
      expect(detect).toHaveBeenCalledTimes(1);
      cleanup();

      // la detección tarda y la persona ya empezó a escribir: lo suyo manda
      let answer: (found: { url: string; providers: typeof providers }) => void = () => undefined;
      const late = vi.fn(() => new Promise<{ url: string; providers: typeof providers }>((resolve) => (answer = resolve)));
      renderPanel(localSession(), server, { detect: late });
      await userEvent.type(field('Dirección del servidor'), URL_);
      await waitFor(() => expect(late).toHaveBeenCalled());
      answer({ url: 'https://iark.ejemplo.org', providers });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(field('Dirección del servidor').value).toBe(URL_);
    });

    it('con un servidor ya conocido no propone otra dirección, y en un sitio que no es una instancia (404) no pasa nada', async () => {
      saveBackend({ url: URL_ }, { active: false });
      const server = fakeServer();
      const detect = vi.fn(async () => undefined);
      renderPanel(localSession(), server, { detect });
      expect(field('Dirección del servidor').value).toBe(URL_);
      expect(detect).not.toHaveBeenCalled();
      cleanup();
      localStorage.clear();
      // el de verdad (por omisión) con el fetch de un servidor sin cuentas: 404, se ignora sin ruido
      render(<StoragePanel session={localSession()} open onToggle={vi.fn()} fetch={server.fetch} page={DEV} />);
      await waitFor(() => expect(server.log).toContain('GET /api/auth/providers'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(field('Dirección del servidor').value).toBe('');
      expect(screen.queryByTestId('storage-managed')).toBeNull();
    });
  });

  describe('al volver sin poder entrar', () => {
    it('muestra el aviso entendible, deja escrita la dirección del servidor y se puede descartar', async () => {
      const server = fakeServer({ accounts: true });
      setLoginNotice({ kind: 'error', reason: 'not_invited', message: 'Esta instancia es solo por invitación: pide a quien la administra que te invite con tu usuario de GitHub.', url: URL_ });
      renderPanel(localSession(), server);
      const notice = screen.getByTestId('storage-login-notice');
      expect(notice).toHaveTextContent('Esta instancia es solo por invitación');
      expect(notice).toHaveAttribute('data-reason', 'not_invited');
      expect(field('Dirección del servidor').value).toBe(URL_);
      await findGithubButton(); // y puede volver a intentarlo (o entrar con otra cuenta)
      await userEvent.click(screen.getByRole('button', { name: 'Descartar aviso' }));
      expect(screen.queryByTestId('storage-login-notice')).toBeNull();
      expect(getLoginNotice()).toBeUndefined();
    });

    it('volver a iniciar sesión borra el aviso', async () => {
      const server = fakeServer({ accounts: true });
      setLoginNotice({ kind: 'error', reason: 'access_denied', message: 'No aceptaste.', url: URL_ });
      const { startLogin } = renderPanel(localSession(), server);
      await userEvent.click(await findGithubButton());
      await waitFor(() => expect(startLogin).toHaveBeenCalled());
      expect(getLoginNotice()).toBeUndefined();
    });
  });

  describe('con una sesión de persona', () => {
    async function signedIn(extra: Partial<FakePerson> = {}) {
      const server = fakeServer({ accounts: true });
      const token = server.openSession({ ...ANA, ...extra });
      saveBackend({ url: URL_, token, label: 'Oficina' }, { remember: true });
      const session = await remoteSession(server, token, 'Oficina');
      return { server, session, token };
    }

    it('muestra la ficha (foto https, usuario, nombre y rol en la instancia) y no ofrece iniciar sesión otra vez', async () => {
      const { server, session } = await signedIn();
      renderPanel(session, server);
      const card = await screen.findByTestId('storage-account');
      expect(card).toHaveTextContent('@ana');
      expect(card).toHaveTextContent('Ana García');
      expect(card).toHaveTextContent('Rol en la instancia: miembro');
      expect(card.querySelector('img')).toHaveAttribute('src', 'https://avatars.example/u/1');
      expect(card.querySelector('img')).toHaveAttribute('referrerpolicy', 'no-referrer');
      expect(screen.getByRole('button', { name: 'Cerrar sesión' })).toBeInTheDocument();
      expect(screen.getByTestId('storage-summary')).toHaveTextContent('Servidor: localhost:8787 «Oficina» (Ana García, member)');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.queryByRole('button', { name: 'Iniciar sesión con GitHub' })).toBeNull();
    });

    it('una foto que no es https no se carga, y un administrador de la instancia se ve como tal', async () => {
      const { server, session } = await signedIn({ avatarUrl: 'http://inseguro.example/a.png', siteRole: 'admin' });
      renderPanel(session, server);
      const card = await screen.findByTestId('storage-account');
      expect(card.querySelector('img')).toBeNull();
      expect(card).toHaveTextContent('administrador de la instancia');
    });

    it('«Cerrar sesión» la cierra en el servidor, olvida el token (de la pestaña y del equipo), conserva la dirección y recarga en este navegador', async () => {
      const { server, session, token } = await signedIn();
      const { reload } = renderPanel(session, server);
      await userEvent.click(await screen.findByRole('button', { name: 'Cerrar sesión' }));
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect(server.sessions.has(token)).toBe(false); // ya no vale ni copiada
      expect(server.log).toContain('POST /api/auth/logout');
      expect(localStorage.getItem(`${TOKEN_KEY_PREFIX}${URL_}`)).toBeNull();
      expect(sessionStorage.getItem(`${TOKEN_KEY_PREFIX}${URL_}`)).toBeNull();
      expect(JSON.parse(localStorage.getItem(BACKEND_KEY)!)).toEqual({ kind: 'local', url: URL_, label: 'Oficina' });
      expect(loadBackend()).toEqual({ kind: 'local', server: { url: URL_, label: 'Oficina' } });
    });

    it('si el servidor no responde, no da la sesión por cerrada hasta que la persona lo decida', async () => {
      const { server, session, token } = await signedIn();
      const { reload } = renderPanel(session, server);
      await screen.findByTestId('storage-account');
      server.down = true;
      await userEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
      expect(await screen.findByTestId('storage-logout-issue')).toHaveTextContent('seguirá abierta en el servidor hasta que caduque');
      expect(reload).not.toHaveBeenCalled();
      expect(localStorage.getItem(`${TOKEN_KEY_PREFIX}${URL_}`)).toBe(token); // todavía es suya
      await userEvent.click(screen.getByRole('button', { name: 'Cerrar aquí de todos modos' }));
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect(localStorage.getItem(`${TOKEN_KEY_PREFIX}${URL_}`)).toBeNull();
      expect(loadBackend().kind).toBe('local');
    });

    it('antes de cerrar guarda lo pendiente y, si no pudo, pide confirmar porque la recarga lo perdería', async () => {
      const { server, session } = await signedIn();
      const project = await session.createProject('Tienda');
      expect(project.name).toBe('Tienda');
      await session.createDiagram({ module: 'c4', name: 'A', text: 'a0' });
      const { reload } = renderPanel(session, server);
      await screen.findByTestId('storage-account');
      server.down = true; // el guardado pendiente no puede salir
      session.queueSave('a1');
      await waitFor(() => expect(session.getState().save).toBe('error'));
      await userEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
      expect(await screen.findByTestId('storage-loss')).toHaveTextContent('se perderán');
      expect(reload).not.toHaveBeenCalled();
      server.down = false;
      await userEvent.click(screen.getByRole('button', { name: 'Seguir y descartarlos' }));
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect(server.sessions.size).toBe(0);
    });
  });

  describe('cuando la sesión caduca', () => {
    it('dice «Tu sesión caducó» (no «token rechazado») y ofrece volver a iniciar sesión', async () => {
      const server = fakeServer({ accounts: true });
      const token = server.openSession(ANA);
      saveBackend({ url: URL_, token }, { remember: true });
      const session = await remoteSession(server, token);
      renderPanel(session, server);
      await screen.findByTestId('storage-account');
      server.sessions.delete(token); // caducó (o se cerró en otro sitio)
      await session.refresh();
      const expired = await screen.findByTestId('storage-expired');
      expect(expired).toHaveTextContent('Tu sesión caducó');
      expect(screen.queryByTestId('storage-rejected')).toBeNull();
      expect(screen.getByTestId('storage-status')).toHaveTextContent('Sesión caducada');
      expect(screen.queryByTestId('storage-account')).toBeNull();
      await findGithubButton();
      expect(screen.getByTestId('storage-expired')).toHaveTextContent('Pulsa «Iniciar sesión con GitHub»');
    });

    it('con lo pendiente sin guardar, avisa de que salir a GitHub lo perdería y pide confirmarlo; sin nada pendiente va directo', async () => {
      const server = fakeServer({ accounts: true });
      const token = server.openSession(ANA);
      saveBackend({ url: URL_, token }, { remember: true });
      const session = await remoteSession(server, token);
      await session.createProject('Tienda');
      await session.createDiagram({ module: 'c4', name: 'A', text: 'a0' });
      const { startLogin } = renderPanel(session, server);
      await screen.findByTestId('storage-account');
      server.sessions.delete(token);
      session.queueSave('lo que escribí después de caducar');
      await waitFor(() => expect(session.getState().saveErrorCode).toBe('unauthorized'));
      expect(await screen.findByTestId('storage-expired')).toHaveTextContent('Lo que escribiste desde entonces no se ha guardado');
      await userEvent.click(await findGithubButton());
      expect(await screen.findByTestId('storage-loss')).toHaveTextContent('se perderán');
      expect(startLogin).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
      await userEvent.click(githubButton());
      await userEvent.click(await screen.findByRole('button', { name: 'Seguir y descartarlos' }));
      await waitFor(() => expect(startLogin).toHaveBeenCalledTimes(1));
      expect(startLogin).toHaveBeenCalledWith({ server: URL_, remember: true, label: '' });
    });

    it('con un token de iark auth rechazado sigue siendo «El servidor no aceptó el token»', async () => {
      const server = fakeServer({ token: 'nuevo' });
      saveBackend({ url: URL_, token: 'viejo' });
      const session = await remoteSession(server, 'viejo');
      renderPanel(session, server);
      expect(screen.getByTestId('storage-rejected')).toHaveTextContent('El servidor no aceptó el token');
      expect(screen.queryByTestId('storage-expired')).toBeNull();
      expect(screen.getByTestId('storage-status')).toHaveTextContent('Token rechazado');
    });
  });

  describe('permisos en un proyecto (sesión de persona)', () => {
    it('un lector que intenta guardar no ve «cambia de token»: se le dice que pida el rol de editor', async () => {
      const server = fakeServer({ accounts: true });
      const token = server.openSession(ANA);
      saveBackend({ url: URL_, token }, { remember: true });
      const project = await server.store.createProject({ name: 'Tienda' });
      const meta = await server.store.saveDiagram(project.id, { module: 'c4', name: 'A', text: 'a0' });
      server.share(project.id, ANA, 'viewer');
      const session = await remoteSession(server, token);
      await session.openDiagram(project.id, meta.id);
      session.queueSave('lo que escribió un lector');
      await waitFor(() => expect(session.getState().saveErrorCode).toBe('forbidden'));
      renderPanel(session, server);
      expect(await screen.findByTestId('storage-forbidden')).toHaveTextContent('No tienes permiso para guardar en este proyecto (tu rol es «lector»)');
      expect(screen.getByTestId('storage-forbidden')).not.toHaveTextContent('token');
    });
  });
});
