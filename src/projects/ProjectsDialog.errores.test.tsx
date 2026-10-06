// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectSession } from './factory';
import { ProjectsDialog } from './ProjectsDialog';
import type { ProjectSession } from './session';
import { fakeServer, type FakePerson, type FakeServer } from './testing';

/**
 * Los errores de las cuentas se explican con lo que pasó y no mandan a «cambiar de token» cuando no es eso: un tope de proyectos o de personas,
 * una cuenta que no puede crear proyectos, un rol que no alcanza para compartir y un proyecto que ya no existe. (Contra el servidor simulado,
 * que responde con los mismos códigos que el de verdad; los casos felices están en `ProjectsDialog.compartir.test.tsx`, con el de verdad.)
 */
const URL_ = 'http://localhost:8787';
const ANA: FakePerson = { id: 'u_1', login: 'ana', name: 'Ana', siteRole: 'member' };

async function sessionOf(server: FakeServer, person: FakePerson): Promise<ProjectSession> {
  const token = server.openSession(person);
  const session = createProjectSession({ config: { kind: 'remote', url: URL_, token }, fetch: server.fetch, session: { broadcast: false, pollMs: 0, debounceMs: 10 } });
  await session.init();
  return session;
}

function renderDialog(session: ProjectSession, server: FakeServer) {
  render(<ProjectsDialog session={session} modules={[{ id: 'c4', label: 'C4' }]} onOpen={vi.fn()} onClose={vi.fn()} notify={vi.fn()} storage={{ fetch: server.fetch, detect: false }} />);
}

const create = async (name: string): Promise<void> => {
  await userEvent.type(screen.getByPlaceholderText('Nombre del proyecto'), name);
  await userEvent.click(screen.getByRole('button', { name: 'Crear' }));
};

describe('errores de cuentas en el gestor de proyectos', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => cleanup());

  it('el tope de proyectos por persona se explica y no manda a cambiar de token (no es un problema de credencial)', async () => {
    const server = fakeServer({ accounts: true, maxProjects: 1 });
    renderDialog(await sessionOf(server, ANA), server);
    await create('Primero');
    await screen.findByRole('button', { name: /^Primero/ });
    await create('Segundo');
    expect(await screen.findByTestId('projects-error')).toHaveTextContent('Ya administras 1 proyectos, el máximo por persona en esta instancia.');
    expect(screen.queryByRole('form', { name: 'Conectar a un servidor' })).toBeNull();
  });

  it('una cuenta de invitada (no crea proyectos) recibe el 403 como lo que es, sin abrir «Dónde se guardan»', async () => {
    const server = fakeServer({ accounts: true });
    renderDialog(await sessionOf(server, { ...ANA, siteRole: 'guest' }), server);
    await create('Mío');
    expect(await screen.findByTestId('projects-error')).toHaveTextContent('Tu cuenta no puede crear proyectos en esta instancia.');
    expect(screen.queryByRole('form', { name: 'Conectar a un servidor' })).toBeNull();
  });

  it('con un token de iark auth, en cambio, un 403 sigue llevando al formulario para escribir otro token', async () => {
    const server = fakeServer({ token: 'lector', role: 'viewer' });
    const session = createProjectSession({ config: { kind: 'remote', url: URL_, token: 'lector' }, fetch: server.fetch, session: { broadcast: false, pollMs: 0, debounceMs: 10 } });
    await session.init();
    renderDialog(session, server);
    await create('Tienda');
    expect(await screen.findByTestId('projects-error')).toHaveTextContent('Este token es de solo lectura');
    expect(screen.getByRole('form', { name: 'Conectar a un servidor' })).toBeInTheDocument();
  });

  it('un token de sesión que ya no vale sí abre el panel para volver a iniciar sesión', async () => {
    const server = fakeServer({ accounts: true });
    const session = await sessionOf(server, ANA);
    renderDialog(session, server);
    server.sessions.clear(); // caducó
    await create('Tienda');
    expect(await screen.findByTestId('projects-error')).toHaveTextContent('Falta un token válido');
    expect(screen.getByRole('form', { name: 'Conectar a un servidor' })).toBeInTheDocument();
    expect(await screen.findByTestId('storage-expired')).toHaveTextContent('Tu sesión caducó');
  });

  describe('Compartir…', () => {
    async function open(server: FakeServer, role: 'admin' | 'editor' = 'admin') {
      const project = await server.store.createProject({ name: 'Tienda' });
      const session = await sessionOf(server, ANA);
      server.share(project.id, ANA, role);
      await session.refresh();
      renderDialog(session, server);
      return { session, project };
    }

    it('el tope de personas por proyecto se explica y la lista no cambia', async () => {
      const server = fakeServer({ accounts: true, maxMembers: 1 });
      await open(server);
      await userEvent.click(await screen.findByTestId('share-project'));
      const dialog = await screen.findByTestId('share-dialog');
      await within(dialog).findByText('@ana');
      await userEvent.type(within(dialog).getByLabelText('Usuario de GitHub'), 'beto');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Dar acceso' }));
      expect(await within(dialog).findByTestId('share-error')).toHaveTextContent('Un proyecto admite hasta 1 personas.');
      expect(within(dialog).queryByText('@beto')).toBeNull();
    });

    it('si el servidor dice que ya no es administradora, lo explica (y el cuadro se cierra al releer la lista)', async () => {
      const server = fakeServer({ accounts: true });
      const { session, project } = await open(server);
      await userEvent.click(await screen.findByTestId('share-project'));
      const dialog = await screen.findByTestId('share-dialog');
      await within(dialog).findByText('@ana');
      server.share(project.id, ANA, 'editor'); // otra persona le bajó el rol
      await userEvent.type(within(dialog).getByLabelText('Usuario de GitHub'), 'beto');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Dar acceso' }));
      expect(await within(dialog).findByTestId('share-error')).toHaveTextContent('Solo quien administra el proyecto puede cambiar quién tiene acceso.');
      await session.refresh();
      await waitFor(() => expect(screen.queryByTestId('share-dialog')).toBeNull());
    });

    it('si el proyecto ya no existe para ella, la lista de miembros lo dice', async () => {
      const server = fakeServer({ accounts: true });
      const { project } = await open(server);
      await userEvent.click(await screen.findByTestId('share-project'));
      const dialog = await screen.findByTestId('share-dialog');
      await within(dialog).findByText('@ana');
      server.members.delete(project.id); // la sacaron del proyecto
      await userEvent.type(within(dialog).getByLabelText('Usuario de GitHub'), 'beto');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Dar acceso' }));
      expect(await within(dialog).findByTestId('share-error')).toHaveTextContent('Puede que el proyecto ya no exista o que ya no tengas acceso a él.');
    });

    it('«Compartir…» no existe con un token de iark auth ni en este navegador', async () => {
      const server = fakeServer({ token: 'admin', role: 'admin' });
      await server.store.createProject({ name: 'Tienda' });
      const session = createProjectSession({ config: { kind: 'remote', url: URL_, token: 'admin' }, fetch: server.fetch, session: { broadcast: false, pollMs: 0, debounceMs: 10 } });
      await session.init();
      renderDialog(session, server);
      await screen.findByRole('button', { name: /^Tienda/ });
      expect(screen.queryByTestId('share-project')).toBeNull();
      expect(screen.queryByTestId('leave-project')).toBeNull();
      expect(screen.queryByTestId('project-role-detail')).toBeNull(); // sin `role` en la respuesta no hay nada que mostrar
    });
  });
});
