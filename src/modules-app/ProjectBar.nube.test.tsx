// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryProjectStore, pretty } from '@iark/kernel';
import { createProjectSession } from '../projects/factory';
import { ProjectSession } from '../projects/session';
import { fakeServer, type FakeServer } from '../projects/testing';
import { WorkbenchController, type ModuleSource } from './controller';
import { ProjectBar } from './ProjectBar';
import { FAKE_DOC, fakeModule } from './testing-editor';

/** La barra del proyecto del banco de trabajo con los proyectos en un servidor: indica dónde se guarda y cómo recuperarse de un fallo. */
const URL_ = 'http://localhost:8787';
const DOC = pretty(FAKE_DOC);
const SOURCES: ModuleSource[] = [{ id: 'fake', label: 'Con contratos', load: async () => fakeModule as never, example: async () => DOC }];

async function setup(session: ProjectSession) {
  const project = await session.createProject('Tienda');
  const meta = await session.createDiagram({ module: 'fake', name: 'Pedidos', text: DOC });
  const controller = new WorkbenchController(SOURCES, { renderDelay: 0, projects: session });
  await controller.openDiagram(project.id, meta.id);
  const onManage = vi.fn();
  render(<ProjectBar controller={controller} state={controller.getState()} onManage={onManage} notify={vi.fn()} />);
  return { controller, onManage, project, meta };
}

const remote = async (server: FakeServer, token?: string): Promise<ProjectSession> => {
  const session = createProjectSession({ config: { kind: 'remote', url: URL_, token }, fetch: server.fetch, session: { broadcast: false, pollMs: 0, debounceMs: 10 } });
  await session.init();
  return session;
};
const status = (): HTMLElement => screen.getByTestId('save-status');

describe('barra del proyecto: indicación del almacén', () => {
  afterEach(() => cleanup());

  it('en este navegador el estado es el de siempre, sin mencionar ningún servidor', async () => {
    const session = new ProjectSession(new MemoryProjectStore(), { broadcast: false, persist: false, debounceMs: 10 });
    await session.init();
    await setup(session);
    expect(status()).toHaveTextContent(/^Guardado en «Tienda»$/);
    expect(screen.queryByTestId('reconnect')).toBeNull();
  });

  it('con un servidor, «Guardado en «X» · servidor»', async () => {
    const session = await remote(fakeServer());
    await setup(session);
    expect(status()).toHaveTextContent(/^Guardado en «Tienda» · servidor$/);
    session.dispose();
  });

  it('un guardado que falla por la red dice «Sin conexión: 1 cambio pendiente», lo guarda en este navegador y «Reintentar ahora» lo envía cuando vuelve la conexión', async () => {
    const server = fakeServer();
    const session = await remote(server);
    const { project, meta } = await setup(session);
    server.down = true;
    session.queueSave('lo último');
    await waitFor(() => expect(status()).toHaveTextContent(/^Sin conexión: 1 cambio pendiente$/));
    expect(status()).toHaveAttribute('data-save', 'offline');
    expect(status()).toHaveAttribute('role', 'status');
    expect(screen.queryByTestId('reconnect')).toBeNull();
    server.down = false;
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar ahora' }));
    await waitFor(() => expect(status()).toHaveTextContent(/^Guardado en «Tienda» · servidor$/));
    expect(screen.queryByTestId('offline-actions')).toBeNull();
    expect((await server.store.getDiagram(project.id, meta.id))?.text).toBe('lo último');
    session.dispose();
  });

  it('un token rechazado al guardar avisa «El servidor no aceptó el token» con «Volver a conectar» (abre el panel), sin «Reintentar» y sin perder el texto', async () => {
    const server = fakeServer({ token: 'viejo' });
    const session = await remote(server, 'viejo');
    const { onManage } = await setup(session);
    server.token = 'nuevo';
    session.queueSave('lo que escribí');
    await waitFor(() => expect(status()).toHaveTextContent('El servidor no aceptó el token'));
    expect(screen.queryByRole('button', { name: 'Reintentar' })).toBeNull();
    expect(session.dirty).toBe(true);
    await userEvent.click(screen.getByTestId('reconnect'));
    expect(onManage).toHaveBeenCalledWith('storage');
    session.dispose();
  });

  it('una sesión de persona que caducó dice «Tu sesión caducó» y ofrece «Iniciar sesión» (no «token»); un rol de lector no manda a cambiar de token', async () => {
    const server = fakeServer({ accounts: true });
    const token = server.openSession({ id: 'u_1', login: 'ana', siteRole: 'member' });
    const session = await remote(server, token);
    const { onManage, project, meta } = await setup(session);
    server.share(project.id, 'ana', 'admin');
    server.sessions.delete(token); // caducó
    session.queueSave('lo que escribí');
    await waitFor(() => expect(status()).toHaveTextContent('Tu sesión caducó'));
    expect(status()).not.toHaveTextContent('token');
    await userEvent.click(screen.getByRole('button', { name: 'Iniciar sesión' }));
    expect(onManage).toHaveBeenCalledWith('storage');
    expect(screen.queryByRole('button', { name: 'Volver a conectar' })).toBeNull();
    expect(session.dirty).toBe(true);
    expect(meta.id).toBeTruthy();
    cleanup();

    // con otra sesión que es lectora del proyecto, el 403 no ofrece «Cambiar de token»
    const reader = server.openSession({ id: 'u_2', login: 'vic', siteRole: 'member' });
    server.share(project.id, 'vic', 'viewer');
    const readerSession = await remote(server, reader);
    await readerSession.openDiagram(project.id, meta.id);
    const controller = new WorkbenchController(SOURCES, { renderDelay: 0, projects: readerSession });
    render(<ProjectBar controller={controller} state={controller.getState()} onManage={vi.fn()} notify={vi.fn()} />);
    readerSession.queueSave('otra cosa');
    await waitFor(() => expect(status()).toHaveTextContent('Sin permiso para guardar en el servidor'));
    expect(screen.queryByRole('button', { name: 'Cambiar de token' })).toBeNull();
    session.dispose();
    readerSession.dispose();
  });

  it('un servidor que no responde al abrir lo dice, y un token rechazado al abrir ofrece volver a conectar', async () => {
    const server = fakeServer({ token: 'secreto' });
    const session = await remote(server); // sin token
    const controller = new WorkbenchController(SOURCES, { renderDelay: 0, projects: session });
    const onManage = vi.fn();
    render(<ProjectBar controller={controller} state={controller.getState()} onManage={onManage} notify={vi.fn()} />);
    expect(status()).toHaveTextContent('El servidor no aceptó el token');
    await userEvent.click(screen.getByRole('button', { name: 'Volver a conectar' }));
    expect(onManage).toHaveBeenCalledWith('storage');
    cleanup();

    server.token = undefined;
    server.down = true;
    const down = await remote(server);
    render(<ProjectBar controller={new WorkbenchController(SOURCES, { projects: down })} state={controller.getState()} onManage={vi.fn()} notify={vi.fn()} />);
    expect(status()).toHaveTextContent('Servidor no disponible');
    expect(screen.queryByRole('button', { name: 'Volver a conectar' })).toBeNull();
    session.dispose();
    down.dispose();
  });

  describe('un conflicto con otra persona', () => {
    async function conflicted() {
      const server = fakeServer();
      const session = await remote(server);
      const ctx = await setup(session);
      await server.store.saveDiagram(ctx.project.id, { id: ctx.meta.id, text: pretty({ ...FAKE_DOC, name: 'de otra persona' }) });
      session.queueSave('mío');
      await waitFor(() => expect(status()).toHaveTextContent('Hay un conflicto que resolver'));
      return { server, session, ...ctx };
    }

    it('se indica con «Hay un conflicto que resolver» y no pisa lo del servidor mientras no se elija', async () => {
      const { server, session, project, meta, controller } = await conflicted();
      expect(status()).toHaveAttribute('data-save', 'conflict');
      expect(screen.getByTestId('resolve-conflict')).toHaveAccessibleName('Resolver el conflicto…');
      expect((await server.store.getDiagram(project.id, meta.id))?.text).toContain('de otra persona');
      await act(async () => controller.dispose());
      session.dispose();
    });

    it('«Quedarme con la mía» pide confirmar y luego sustituye a la del servidor', async () => {
      const { server, session, project, meta, controller } = await conflicted();
      await userEvent.click(screen.getByTestId('resolve-conflict'));
      const dialog = screen.getByRole('dialog', { name: 'Hay un conflicto que resolver' });
      expect(dialog).toHaveFocus();
      await userEvent.click(screen.getByRole('button', { name: 'Quedarme con la mía' }));
      expect(screen.getByTestId('conflict-confirm')).toHaveTextContent('lo que cambió la otra persona se perderá');
      expect((await server.store.getDiagram(project.id, meta.id))?.text).toContain('de otra persona'); // aún no
      await userEvent.click(screen.getByRole('button', { name: 'Sí, quedarme con la mía' }));
      await waitFor(() => expect(status()).toHaveTextContent(/^Guardado en «Tienda» · servidor$/));
      expect((await server.store.getDiagram(project.id, meta.id))?.text).toBe('mío');
      expect(screen.queryByRole('dialog')).toBeNull();
      await act(async () => controller.dispose());
      session.dispose();
    });

    it('«Quedarme con la del servidor» descarta la mía (con confirmación) y deja en pantalla la del servidor', async () => {
      const { server, session, project, meta, controller } = await conflicted();
      await userEvent.click(screen.getByTestId('resolve-conflict'));
      await userEvent.click(screen.getByRole('button', { name: 'Quedarme con la del servidor' }));
      await userEvent.click(screen.getByRole('button', { name: 'Sí, quedarme con la del servidor' }));
      await waitFor(() => expect(status()).toHaveTextContent(/^Guardado en «Tienda» · servidor$/));
      expect((await server.store.getDiagram(project.id, meta.id))?.text).toContain('de otra persona');
      expect(session.unsentCount).toBe(0);
      expect(controller.getState().text).toContain('de otra persona');
      await act(async () => controller.dispose());
      session.dispose();
    });

    it('«Guardar la mía como diagrama nuevo» crea una copia con otro nombre y deja intacta la del servidor', async () => {
      const { server, session, project, meta, controller } = await conflicted();
      await userEvent.click(screen.getByTestId('resolve-conflict'));
      await userEvent.click(screen.getByRole('button', { name: 'Guardar la mía como diagrama nuevo' }));
      const name = screen.getByLabelText('Nombre del diagrama nuevo');
      expect(name).toHaveValue('Pedidos (mi versión)');
      await userEvent.click(screen.getByRole('button', { name: 'Guardar la copia' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      const copy = (await server.store.getProject(project.id))!.diagrams.find((d) => d.name === 'Pedidos (mi versión)');
      expect(copy).toBeDefined();
      expect((await server.store.getDiagram(project.id, copy!.id))?.text).toBe('mío');
      expect((await server.store.getDiagram(project.id, meta.id))?.text).toContain('de otra persona');
      await act(async () => controller.dispose());
      session.dispose();
    });

    it('Escape cierra el cuadro sin decidir nada', async () => {
      const { session, controller } = await conflicted();
      await userEvent.click(screen.getByTestId('resolve-conflict'));
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(status()).toHaveTextContent('Hay un conflicto que resolver');
      expect(screen.getByTestId('resolve-conflict')).toHaveFocus();
      await act(async () => controller.dispose());
      session.dispose();
    });
  });

  it('una lectura en segundo plano que falla no tira la barra: sigue «Guardado» y lo avisa', async () => {
    const server = fakeServer();
    const session = await remote(server);
    await setup(session);
    server.down = true;
    await act(async () => session.refresh({ background: true }));
    expect(status()).toHaveTextContent('Guardado en «Tienda» · servidor (sin conexión con el servidor)');
    expect(screen.getByRole('combobox', { name: 'Proyecto' })).toBeEnabled();
    session.dispose();
  });
});
