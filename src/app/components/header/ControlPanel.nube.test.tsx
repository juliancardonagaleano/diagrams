// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleDocument } from '@core/model/sample';
import { saveBackend } from '../../../projects/backend';
import { fakeServer, type FakeServer } from '../../../projects/testing';
import { useDocumentStore } from '../../store/documentStore';
import { resetProjectSession, useProjectBinding } from '../../projects/useProjectBinding';
import { ControlPanel } from './ControlPanel';

/** El encabezado del editor C4 con los proyectos en un servidor: el chip y el estado dicen que es un servidor y cómo recuperarse. */
const URL_ = 'http://localhost:8787';
const doc = (name: string) => JSON.stringify({ ...structuredClone(sampleDocument), workspace: { ...sampleDocument.workspace, name } }, null, 2);

function Host({ onManage }: { onManage: (panel?: 'storage') => void }) {
  const binding = useProjectBinding();
  return (
    <ReactFlowProvider>
      <ControlPanel projects={{ binding, onManage }} />
    </ReactFlowProvider>
  );
}

async function setup(server: FakeServer, options: { remote: boolean; token?: string }) {
  if (options.remote) saveBackend({ url: URL_, token: options.token });
  vi.stubGlobal('fetch', server.fetch);
  const onManage = vi.fn();
  render(<Host onManage={onManage} />);
  return { onManage };
}

describe('encabezado del editor C4 con proyectos', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    resetProjectSession();
    useDocumentStore.getState().newDocument();
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, onchange: null, dispatchEvent: () => false }));
  });
  afterEach(() => {
    cleanup();
    resetProjectSession();
    vi.unstubAllGlobals();
  });

  it('con un servidor, el chip y el estado dicen «· servidor» una vez abierto un diagrama', async () => {
    const server = fakeServer();
    const project = await server.store.createProject({ name: 'Banca' });
    const meta = await server.store.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text: doc('Banca A') });
    await setup(server, { remote: true });
    expect(await screen.findByTestId('project-chip')).toHaveTextContent('Sin proyecto · servidor');
    // el último abierto es de ese servidor: se reabre solo
    localStorage.setItem(`iark.projects.last:${URL_}`, JSON.stringify({ projectId: project.id, diagramId: meta.id }));
    cleanup();
    resetProjectSession();
    await setup(server, { remote: true });
    await waitFor(() => expect(screen.getByTestId('project-chip')).toHaveTextContent('Proyecto: Banca › Contexto · servidor'));
    await waitFor(() => expect(screen.getByTestId('save-status')).toHaveTextContent('Guardado en «Banca» · servidor'));
  });

  it('en este navegador no menciona ningún servidor', async () => {
    await setup(fakeServer(), { remote: false });
    expect(await screen.findByTestId('project-chip')).toHaveTextContent(/^Sin proyecto$/);
  });

  it('un token rechazado al guardar avisa y ofrece «Volver a conectar», que abre el panel de conexión', async () => {
    const server = fakeServer({ token: 'viejo' });
    const project = await server.store.createProject({ name: 'Banca' });
    const meta = await server.store.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text: doc('Banca A') });
    localStorage.setItem(`iark.projects.last:${URL_}`, JSON.stringify({ projectId: project.id, diagramId: meta.id }));
    const { onManage } = await setup(server, { remote: true, token: 'viejo' });
    await waitFor(() => expect(screen.getByTestId('save-status')).toHaveTextContent('Guardado en «Banca» · servidor'));
    server.token = 'nuevo';
    act(() => useDocumentStore.getState().setWorkspaceName('Banca B'));
    await waitFor(() => expect(screen.getByTestId('save-status')).toHaveTextContent('El servidor no aceptó el token'), { timeout: 5000 });
    expect(screen.queryByTestId('retry-save')).toBeNull();
    await userEvent.click(screen.getByTestId('reconnect'));
    expect(onManage).toHaveBeenCalledWith('storage');
  });

  it('una sesión de persona que caducó dice «Tu sesión caducó» y ofrece «Iniciar sesión», que abre el panel de conexión', async () => {
    const server = fakeServer({ accounts: true });
    const token = server.openSession({ id: 'u_1', login: 'ana', siteRole: 'member' });
    const project = await server.store.createProject({ name: 'Banca' });
    const meta = await server.store.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text: doc('Banca A') });
    server.share(project.id, 'ana', 'admin');
    localStorage.setItem(`iark.projects.last:${URL_}`, JSON.stringify({ projectId: project.id, diagramId: meta.id }));
    const { onManage } = await setup(server, { remote: true, token });
    await waitFor(() => expect(screen.getByTestId('save-status')).toHaveTextContent('Guardado en «Banca» · servidor'));
    server.sessions.delete(token); // caducó
    act(() => useDocumentStore.getState().setWorkspaceName('Banca B'));
    await waitFor(() => expect(screen.getByTestId('save-status')).toHaveTextContent('Tu sesión caducó'), { timeout: 5000 });
    expect(screen.getByTestId('save-status')).not.toHaveTextContent('token');
    const button = screen.getByTestId('reconnect');
    expect(button).toHaveTextContent('Iniciar sesión');
    await userEvent.click(button);
    expect(onManage).toHaveBeenCalledWith('storage');
  });

  it('un corte de red al guardar dice «Sin conexión: 1 cambio pendiente», y al volver la conexión se guarda', async () => {
    const server = fakeServer();
    const project = await server.store.createProject({ name: 'Banca' });
    const meta = await server.store.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text: doc('Banca A') });
    localStorage.setItem(`iark.projects.last:${URL_}`, JSON.stringify({ projectId: project.id, diagramId: meta.id }));
    await setup(server, { remote: true });
    await waitFor(() => expect(screen.getByTestId('save-status')).toHaveTextContent('Guardado en «Banca» · servidor'));
    server.down = true;
    act(() => useDocumentStore.getState().setWorkspaceName('Banca B'));
    await waitFor(() => expect(screen.getByTestId('save-status')).toHaveTextContent('Sin conexión: 1 cambio pendiente'), { timeout: 5000 });
    expect(screen.getByTestId('save-status')).toHaveAttribute('role', 'status');
    expect(screen.getByTestId('save-status')).toHaveAttribute('data-save', 'offline');
    server.down = false;
    await userEvent.click(screen.getByTestId('retry-now'));
    await waitFor(() => expect(screen.getByTestId('save-status')).toHaveTextContent('Guardado en «Banca» · servidor'));
    expect(JSON.parse((await server.store.getDiagram(project.id, meta.id))!.text).workspace.name).toBe('Banca B');
  });

  describe('un conflicto con otra persona', () => {
    async function conflicted() {
      const server = fakeServer();
      const project = await server.store.createProject({ name: 'Banca' });
      const meta = await server.store.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text: doc('Banca A') });
      localStorage.setItem(`iark.projects.last:${URL_}`, JSON.stringify({ projectId: project.id, diagramId: meta.id }));
      await setup(server, { remote: true });
      await waitFor(() => expect(screen.getByTestId('save-status')).toHaveTextContent('Guardado en «Banca» · servidor'));
      await server.store.saveDiagram(project.id, { id: meta.id, text: doc('Banca de otra persona') });
      act(() => useDocumentStore.getState().setWorkspaceName('Banca mía'));
      await waitFor(() => expect(screen.getByTestId('save-status')).toHaveTextContent('Hay un conflicto que resolver'), { timeout: 5000 });
      const nameOnServer = async (): Promise<string> => JSON.parse((await server.store.getDiagram(project.id, meta.id))!.text).workspace.name;
      return { server, project, meta, nameOnServer };
    }

    it('se indica y se resuelve con «Quedarme con la mía» tras confirmar', async () => {
      const { nameOnServer } = await conflicted();
      expect(await nameOnServer()).toBe('Banca de otra persona'); // no se pisa mientras no se elija
      await userEvent.click(screen.getByTestId('resolve-conflict'));
      await userEvent.click(screen.getByRole('button', { name: 'Quedarme con la mía' }));
      expect(screen.getByTestId('conflict-confirm')).toBeInTheDocument();
      expect(await nameOnServer()).toBe('Banca de otra persona'); // sigue sin pisarse hasta confirmar
      await userEvent.click(screen.getByRole('button', { name: 'Sí, quedarme con la mía' }));
      await waitFor(() => expect(screen.getByTestId('save-status')).toHaveTextContent('Guardado en «Banca» · servidor'));
      expect(await nameOnServer()).toBe('Banca mía');
    });

    it('«Quedarme con la del servidor» carga la del servidor en el editor y descarta la mía', async () => {
      const { nameOnServer } = await conflicted();
      await userEvent.click(screen.getByTestId('resolve-conflict'));
      await userEvent.click(screen.getByRole('button', { name: 'Quedarme con la del servidor' }));
      await userEvent.click(screen.getByRole('button', { name: 'Sí, quedarme con la del servidor' }));
      await waitFor(() => expect(screen.getByTestId('save-status')).toHaveTextContent('Guardado en «Banca» · servidor'));
      expect(useDocumentStore.getState().doc.workspace.name).toBe('Banca de otra persona');
      expect(await nameOnServer()).toBe('Banca de otra persona');
    });

    it('«Guardar la mía como diagrama nuevo» deja la del servidor intacta y crea la copia', async () => {
      const { server, project, nameOnServer } = await conflicted();
      await userEvent.click(screen.getByTestId('resolve-conflict'));
      await userEvent.click(screen.getByRole('button', { name: 'Guardar la mía como diagrama nuevo' }));
      await userEvent.click(screen.getByRole('button', { name: 'Guardar la copia' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      const copy = (await server.store.getProject(project.id))!.diagrams.find((d) => d.name === 'Contexto (mi versión)');
      expect(copy).toBeDefined();
      expect(JSON.parse((await server.store.getDiagram(project.id, copy!.id))!.text).workspace.name).toBe('Banca mía');
      expect(await nameOnServer()).toBe('Banca de otra persona');
    });
  });
});
