// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANA, BETO, call, cleanupCloud, signIn, startCloud, type Cloud } from '../../tests/helpers/cloud';
import { createProjectSession } from './factory';
import { ProjectsDialog } from './ProjectsDialog';
import type { ProjectSession } from './session';

/**
 * El gestor de proyectos y «Compartir…» contra el servidor de verdad (`createSuiteServer` con cuentas y un GitHub de mentira): el rol de cada
 * proyecto, quién puede compartir, dar acceso, cambiar de rol, quitar, salir y los mensajes de los errores del servidor.
 */
const MODULES = [{ id: 'c4', label: 'C4' }];

async function sessionOf(cloud: Cloud, token: string): Promise<ProjectSession> {
  const session = createProjectSession({ config: { kind: 'remote', url: cloud.base, token }, session: { broadcast: false, pollMs: 0, debounceMs: 10 } });
  await session.init();
  return session;
}

function renderDialog(session: ProjectSession) {
  const props = { onOpen: vi.fn(), onClose: vi.fn(), notify: vi.fn() };
  render(<ProjectsDialog session={session} modules={MODULES} template={async () => '{}'} {...props} />);
  return props;
}

const members = async (cloud: Cloud, token: string, project: string): Promise<Array<{ login: string; role: string; pending: boolean; you?: boolean }>> =>
  (await call(cloud.base, token).get(`/api/projects/${project}/members`)).json();

describe('gestor de proyectos con cuentas y compartir (servidor de verdad)', () => {
  let cloud: Cloud;
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    cloud = await startCloud();
  });
  afterEach(async () => {
    cleanup();
    await cleanupCloud();
  });

  /** Ana crea «Tienda» con un diagrama y la comparte con Beto con ese rol; Beto entra (la invitación se reclama al entrar). */
  async function shared(role: 'viewer' | 'editor' | 'admin') {
    const ana = await signIn(cloud, ANA);
    const created = await (await call(cloud.base, ana).post('/api/projects', { name: 'Tienda' })).json();
    await call(cloud.base, ana).post(`/api/projects/${created.id}/diagrams`, { module: 'c4', name: 'Contexto', text: '{}' });
    expect((await call(cloud.base, ana).put(`/api/projects/${created.id}/members/beto`, { role })).status).toBe(201);
    const beto = await signIn(cloud, BETO);
    return { ana, beto, project: created.id as string };
  }

  it('cada proyecto trae el rol de quien mira, y quien lo administra ve «Compartir…» y no «Salir del proyecto»', async () => {
    const { ana, project } = await shared('editor');
    renderDialog(await sessionOf(cloud, ana));
    const item = await screen.findByRole('button', { name: /^Tienda/ });
    expect(within(item).getByTestId('project-role')).toHaveTextContent('administrador');
    expect(screen.getByTestId('project-role-detail')).toHaveTextContent('Tu rol: administrador');
    expect(screen.getByTestId('share-project')).toBeInTheDocument();
    expect(screen.queryByTestId('leave-project')).toBeNull();
    expect(project).toBe('tienda');
  });

  it('Compartir…: lista a las personas con su rol, y a quien aún no ha entrado como «pendiente»', async () => {
    const ana = await signIn(cloud, ANA);
    const created = await (await call(cloud.base, ana).post('/api/projects', { name: 'Tienda' })).json();
    await call(cloud.base, ana).put(`/api/projects/${created.id}/members/carla`, { role: 'viewer' }); // invitada: todavía no entró
    renderDialog(await sessionOf(cloud, ana));
    await userEvent.click(await screen.findByTestId('share-project'));
    const dialog = await screen.findByTestId('share-dialog');
    await within(dialog).findByText('@carla');
    const rows = [...dialog.querySelectorAll<HTMLElement>('li[data-login]')];
    expect(rows.map((row) => row.getAttribute('data-login'))).toEqual(['ana', 'carla']); // administradores primero
    expect(rows[0]).toHaveTextContent('tú');
    expect(within(rows[0]).getByLabelText('Rol de @ana')).toHaveValue('admin');
    expect(rows[1]).toHaveAttribute('data-pending', 'true');
    expect(rows[1]).toHaveTextContent('pendiente');
    expect(within(rows[1]).getByLabelText('Rol de @carla')).toHaveValue('viewer');
  });

  it('da acceso por usuario de GitHub (queda pendiente hasta que entre), cambia su rol y lo quita, y el servidor lo refleja', async () => {
    const ana = await signIn(cloud, ANA);
    await call(cloud.base, ana).post('/api/projects', { name: 'Tienda' });
    const { notify } = renderDialog(await sessionOf(cloud, ana));
    await userEvent.click(await screen.findByTestId('share-project'));
    const dialog = await screen.findByTestId('share-dialog');
    await within(dialog).findByText('@ana');

    await userEvent.type(within(dialog).getByLabelText('Usuario de GitHub'), '@Beto');
    await userEvent.selectOptions(within(dialog).getByLabelText('Rol de la persona nueva'), 'viewer');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Dar acceso' }));
    expect(await within(dialog).findByTestId('share-note')).toHaveTextContent('Se dio acceso a @Beto como lector: lo tendrá en cuanto entre al servidor con esa cuenta de GitHub.');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('@Beto'));
    expect(await members(cloud, ana, 'tienda')).toMatchObject([{ login: 'ana', role: 'admin' }, { login: 'Beto', role: 'viewer', pending: true }]);
    const row = (await within(dialog).findByText('@Beto')).closest('li')!;
    expect(row).toHaveAttribute('data-pending', 'true');

    await userEvent.selectOptions(within(row).getByLabelText('Rol de @Beto'), 'editor');
    await waitFor(() => expect(screen.getByTestId('share-note')).toHaveTextContent('@Beto ahora tiene el rol de editor.'));
    expect((await members(cloud, ana, 'tienda')).find((m) => m.login === 'Beto')?.role).toBe('editor');

    await userEvent.click(within(row).getByRole('button', { name: 'Quitar a @Beto' }));
    await userEvent.click(within(row).getByRole('button', { name: 'Sí, quitar' }));
    await waitFor(() => expect(within(dialog).queryByText('@Beto')).toBeNull());
    expect((await members(cloud, ana, 'tienda')).map((m) => m.login)).toEqual(['ana']);
  });

  it('una persona que ya había entrado deja de ser «pendiente» y un usuario mal escrito ni llega al servidor', async () => {
    const { ana } = await shared('viewer'); // Beto ya entró
    renderDialog(await sessionOf(cloud, ana));
    await userEvent.click(await screen.findByTestId('share-project'));
    const dialog = await screen.findByTestId('share-dialog');
    const row = (await within(dialog).findByText('@beto')).closest('li')!;
    expect(row).not.toHaveAttribute('data-pending');
    expect(row).not.toHaveTextContent('pendiente');

    await userEvent.type(within(dialog).getByLabelText('Usuario de GitHub'), 'no válido!');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Dar acceso' }));
    expect(await within(dialog).findByTestId('share-error')).toHaveTextContent('Escribe un nombre de usuario de GitHub válido');
    expect((await members(cloud, ana, 'tienda')).map((m) => m.login)).toEqual(['ana', 'beto']);
  });

  it('el último administrador no se puede degradar ni quitar: el servidor se niega, se explica y el selector vuelve a su valor', async () => {
    const ana = await signIn(cloud, ANA);
    await call(cloud.base, ana).post('/api/projects', { name: 'Tienda' });
    renderDialog(await sessionOf(cloud, ana));
    await userEvent.click(await screen.findByTestId('share-project'));
    const dialog = await screen.findByTestId('share-dialog');
    const select = await within(dialog).findByLabelText('Rol de @ana');
    await userEvent.selectOptions(select, 'editor');
    expect(await within(dialog).findByTestId('share-error')).toHaveTextContent(/se quedaría sin administrador/);
    await waitFor(() => expect(within(dialog).getByLabelText('Rol de @ana')).toHaveValue('admin'));

    const leave = within(dialog).getByRole('button', { name: 'Salir del proyecto «Tienda»' });
    await waitFor(() => expect(leave).toBeEnabled()); // mientras el servidor contesta, los botones esperan
    await userEvent.click(leave);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sí, salir' }));
    expect(await within(dialog).findByTestId('share-error')).toHaveTextContent(/se quedaría sin administrador/);
    expect((await members(cloud, ana, 'tienda')).map((m) => m.login)).toEqual(['ana']);
  });

  it('quien es editor no ve «Compartir…» pero sí «Salir del proyecto»: sale y el proyecto desaparece de su lista', async () => {
    const { beto, ana } = await shared('editor');
    const { notify } = renderDialog(await sessionOf(cloud, beto));
    const item = await screen.findByRole('button', { name: /^Tienda/ });
    expect(within(item).getByTestId('project-role')).toHaveTextContent('editor');
    expect(screen.queryByTestId('share-project')).toBeNull();
    // como editor sí puede cambiar diagramas, pero borrar el proyecto es de administradores
    expect(screen.getByRole('button', { name: 'Borrar Tienda' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Renombrar' })).toBeEnabled();

    await userEvent.click(screen.getByTestId('leave-project'));
    expect(screen.getByRole('alert')).toHaveTextContent('¿Salir de «Tienda»?');
    await userEvent.click(screen.getByRole('button', { name: 'Sí, salir' }));
    expect(await screen.findByTestId('projects-note')).toHaveTextContent('Saliste de «Tienda»');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Saliste'));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Tienda/ })).toBeNull());
    expect((await members(cloud, ana, 'tienda')).map((m) => m.login)).toEqual(['ana']);
  });

  it('un lector ve que el proyecto es de solo lectura y no tiene a mano lo que cambiaría algo', async () => {
    const { beto } = await shared('viewer');
    renderDialog(await sessionOf(cloud, beto));
    await screen.findByRole('button', { name: /^Tienda/ });
    expect(screen.getByTestId('project-role-detail')).toHaveTextContent('Tu rol: lector');
    expect(screen.getByTestId('project-readonly')).toHaveTextContent('Tienes el rol de lector');
    expect(screen.getByRole('button', { name: 'Renombrar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Borrar Tienda' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Renombrar Contexto' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Duplicar Contexto' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Crear y abrir' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Abrir Contexto' })).toBeEnabled(); // leer sí puede
    expect(screen.getByTestId('leave-project')).toBeInTheDocument();
  });

  it('si otra persona le baja el rol de administrador, el cuadro de compartir se cierra solo al releer la lista', async () => {
    const { ana, beto } = await shared('admin');
    const session = await sessionOf(cloud, beto);
    renderDialog(session);
    await userEvent.click(await screen.findByTestId('share-project'));
    await screen.findByTestId('share-dialog');
    expect((await call(cloud.base, ana).put('/api/projects/tienda/members/beto', { role: 'viewer' })).status).toBe(200);
    await session.refresh();
    await waitFor(() => expect(screen.queryByTestId('share-dialog')).toBeNull());
    expect(screen.queryByTestId('share-project')).toBeNull();
  });

  it('Escape cierra primero el cuadro de compartir (no el gestor) y el foco vuelve al botón «Compartir…»', async () => {
    const ana = await signIn(cloud, ANA);
    await call(cloud.base, ana).post('/api/projects', { name: 'Tienda' });
    const { onClose } = renderDialog(await sessionOf(cloud, ana));
    const button = await screen.findByTestId('share-project');
    await userEvent.click(button);
    await screen.findByTestId('share-dialog');
    expect(screen.getByLabelText('Usuario de GitHub')).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('share-dialog')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(button).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
