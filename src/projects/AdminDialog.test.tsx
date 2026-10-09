// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminDialog, type AdminDialogProps } from './AdminDialog';
import { createProjectSession } from './factory';
import type { ProjectSession } from './session';
import { fakeServer, type FakePerson, type FakeServer } from './testing';

/**
 * La pantalla de administración de la instancia contra el servidor simulado (`fakeServer` con cuentas): listado, búsqueda y filtros, invitar, cambiar el rol
 * (con borrador), desactivar y reactivar, cancelar invitaciones (con confirmación) y los errores del servidor sin perder lo escrito. Que la pantalla solo
 * aparezca para quien administra la instancia, y todo contra el servidor de verdad, está en `ProjectsDialog.admin.test.tsx`.
 */
const URL_ = 'http://localhost:8787';
const ANA: FakePerson = { id: 'u_ana', login: 'ana', name: 'Ana García', avatarUrl: 'https://avatars.example/u/1', siteRole: 'admin' };
const ME = { id: 'u_ana', login: 'ana', siteRole: 'admin' as const };
const hoursAgo = (h: number): string => new Date(Date.now() - h * 3600_000).toISOString();

interface Setup {
  server: FakeServer;
  session: ProjectSession;
}

/** Ana administra (y figura en `--admins`); Beto es miembro con un proyecto, Carla una invitada desactivada, Diego una invitación pendiente y Élena otra administradora. */
async function setup(options: Parameters<typeof fakeServer>[0] = {}): Promise<Setup> {
  const server = fakeServer({ accounts: true, ...options });
  const token = server.openSession(ANA);
  Object.assign(server.directory[0], { listed: true });
  server.addAccount({ login: 'beto', name: 'Beto Ruiz', siteRole: 'member', lastLoginAt: hoursAgo(3) });
  server.addAccount({ login: 'carla', siteRole: 'guest', disabled: true, lastLoginAt: hoursAgo(24 * 40) });
  server.addAccount({ login: 'diego', siteRole: 'guest', pending: true });
  server.addAccount({ login: 'Elena-Dev', name: 'Élena Núñez', siteRole: 'admin', lastLoginAt: hoursAgo(30) });
  server.share('tienda', 'beto', 'editor');
  const session = createProjectSession({ config: { kind: 'remote', url: URL_, token }, fetch: server.fetch, session: { broadcast: false, pollMs: 0, debounceMs: 10 } });
  await session.init();
  return { server, session };
}

function renderAdmin(session: ProjectSession, extra: Partial<AdminDialogProps> = {}) {
  const props = { onClose: vi.fn(), notify: vi.fn() };
  render(<AdminDialog session={session} me={ME} {...props} {...extra} />);
  return props;
}

const rowOf = (login: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(`[data-testid="admin-row"][data-login="${login}"]`);
  if (!found) throw new Error(`No hay una fila para ${login}`);
  return found;
};
const logins = (): string[] => [...document.querySelectorAll('[data-testid="admin-row"]')].map((row) => row.getAttribute('data-login') ?? '');
const loaded = async (): Promise<HTMLElement> => screen.findByRole('table', { name: 'Cuentas de la instancia' });
const puts = (server: FakeServer): string[] => server.log.filter((entry) => entry.startsWith('PUT '));
const accountOf = (server: FakeServer, login: string) => server.directory.find((a) => a.login === login)!;

describe('administración de la instancia (pantalla de cuentas)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => cleanup());

  describe('el listado', () => {
    it('es una tabla con sus encabezados, una fila por cuenta, y cuenta el estado de cada una', async () => {
      const { server, session } = await setup();
      renderAdmin(session);
      const table = await loaded();
      expect(screen.getByRole('dialog', { name: 'Administración de la instancia' })).toBeInTheDocument();
      expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Cuenta', 'Rol', 'Estado', 'Último acceso', 'Proyectos', 'Acciones']);
      expect(within(table).getAllByRole('rowheader').map((h) => h.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('@ana'), expect.stringContaining('@beto')]));

      const ana = rowOf('ana');
      expect(ana).toHaveTextContent('@ana');
      expect(ana).toHaveTextContent('tú');
      expect(ana).toHaveTextContent('en --admins');
      expect(ana).toHaveTextContent('Ana García');
      expect(within(ana).getByLabelText('Rol de @ana')).toHaveValue('admin');
      expect(ana.querySelector('img.pj-avatar')).toHaveAttribute('src', 'https://avatars.example/u/1');

      const beto = rowOf('beto');
      expect(within(beto).getByLabelText('Rol de @beto')).toHaveValue('member');
      expect(beto).toHaveTextContent('Activa');
      expect(beto).toHaveTextContent('hace 3 h');
      expect(within(beto).getByText('hace 3 h')).toHaveAttribute('datetime', accountOf(server, 'beto').lastLoginAt);
      expect(within(beto).getAllByRole('cell')[3]).toHaveTextContent('1'); // pertenece a «tienda»

      const carla = rowOf('carla');
      expect(carla).toHaveAttribute('data-disabled', 'true');
      expect(carla).toHaveTextContent('Desactivada');
      expect(carla).toHaveTextContent(new Date(accountOf(server, 'carla').lastLoginAt!).toLocaleDateString('es')); // hace más de un mes: la fecha
      expect(within(carla).getByRole('button', { name: 'Reactivar a @carla' })).toBeEnabled();

      const diego = rowOf('diego');
      expect(diego).toHaveAttribute('data-pending', 'true');
      expect(diego).toHaveTextContent('Invitación pendiente');
      expect(diego).toHaveTextContent('Aún no ha entrado');
      expect(within(diego).getByRole('button', { name: 'Cancelar invitación de @diego' })).toBeEnabled();
      expect(within(diego).queryByRole('button', { name: /^Desactivar/ })).toBeNull(); // quien no ha entrado no tiene qué desactivar: se cancela su invitación

      expect(screen.getByTestId('admin-count')).toHaveTextContent('5 cuentas · 2 administradores · 1 invitación pendiente · 1 desactivada');
    });

    it('por omisión van primero los administradores, luego los miembros y los invitados, y dentro de cada rol por usuario', async () => {
      const { session } = await setup();
      renderAdmin(session);
      await loaded();
      expect(logins()).toEqual(['ana', 'Elena-Dev', 'beto', 'carla', 'diego']);
      const [columnRol] = within(screen.getByRole('table')).getAllByRole('columnheader').filter((h) => h.textContent === 'Rol');
      expect(columnRol).toHaveAttribute('aria-sort', 'ascending');
    });

    it('se ordena por usuario, por último acceso (el más reciente primero; quien no ha entrado, al final) y por proyectos', async () => {
      const { session } = await setup();
      renderAdmin(session);
      await loaded();
      await userEvent.selectOptions(screen.getByLabelText('Ordenar por'), 'login');
      expect(logins()).toEqual(['ana', 'beto', 'carla', 'diego', 'Elena-Dev']);
      await userEvent.selectOptions(screen.getByLabelText('Ordenar por'), 'lastLogin');
      expect(logins().slice(0, 3)).toEqual(['ana', 'beto', 'Elena-Dev']);
      expect(logins().slice(-2)).toEqual(['carla', 'diego']);
      await userEvent.selectOptions(screen.getByLabelText('Ordenar por'), 'projects');
      expect(logins()[0]).toBe('beto');
      expect(within(screen.getByRole('table')).getByRole('columnheader', { name: 'Proyectos' })).toHaveAttribute('aria-sort', 'descending');
    });

    it('busca por usuario o por nombre sin distinguir mayúsculas ni acentos, y avisa de cuántas muestra', async () => {
      const { session } = await setup();
      renderAdmin(session);
      await loaded();
      await userEvent.type(screen.getByLabelText('Buscar'), 'nunez');
      expect(logins()).toEqual(['Elena-Dev']);
      expect(screen.getByTestId('admin-count')).toHaveTextContent('Mostrando 1 de 5 cuentas');
      await userEvent.clear(screen.getByLabelText('Buscar'));
      await userEvent.type(screen.getByLabelText('Buscar'), 'BETO');
      expect(logins()).toEqual(['beto']);
      await userEvent.clear(screen.getByLabelText('Buscar'));
      await userEvent.type(screen.getByLabelText('Buscar'), 'nadie');
      expect(screen.queryByRole('table')).toBeNull();
      expect(screen.getByTestId('admin-empty')).toHaveTextContent('Ninguna cuenta coincide con la búsqueda.');
      await userEvent.click(screen.getByRole('button', { name: 'Quitar filtros' }));
      expect(logins()).toHaveLength(5);
      expect(screen.getByLabelText('Buscar')).toHaveValue('');
    });

    it('filtra por rol, por invitaciones pendientes y por desactivadas', async () => {
      const { session } = await setup();
      renderAdmin(session);
      await loaded();
      const filter = screen.getByLabelText('Mostrar');
      await userEvent.selectOptions(filter, 'pending');
      expect(logins()).toEqual(['diego']);
      await userEvent.selectOptions(filter, 'disabled');
      expect(logins()).toEqual(['carla']);
      await userEvent.selectOptions(filter, 'admin');
      expect(logins()).toEqual(['ana', 'Elena-Dev']);
      await userEvent.selectOptions(filter, 'guest');
      expect(logins()).toEqual(['carla', 'diego']);
      await userEvent.selectOptions(filter, 'all');
      expect(logins()).toHaveLength(5);
    });

    it('«Actualizar» vuelve a leer la lista y muestra lo que cambió en el servidor', async () => {
      const { server, session } = await setup();
      renderAdmin(session);
      await loaded();
      server.addAccount({ login: 'fernanda', siteRole: 'member', lastLoginAt: hoursAgo(1) });
      expect(logins()).not.toContain('fernanda');
      await userEvent.click(screen.getByRole('button', { name: 'Actualizar' }));
      await waitFor(() => expect(logins()).toContain('fernanda'));
    });

    it('una foto que no es https no se carga', async () => {
      const { server, session } = await setup();
      accountOf(server, 'beto').avatarUrl = 'http://inseguro.example/beto.png';
      renderAdmin(session);
      await loaded();
      expect(rowOf('beto').querySelector('img')).toBeNull();
      expect(rowOf('beto').querySelector('.pj-avatar-empty')).toHaveTextContent('B');
    });
  });

  describe('invitar', () => {
    it('crea una invitación con el rol elegido, vacía el campo, deja la cuenta a la vista y devuelve el foco al formulario', async () => {
      const { server, session } = await setup();
      const { notify } = renderAdmin(session);
      await loaded();
      await userEvent.selectOptions(screen.getByLabelText('Mostrar'), 'disabled'); // un filtro que la ocultaría
      await userEvent.type(screen.getByLabelText('Usuario de GitHub'), '  @Fernanda  ');
      await userEvent.selectOptions(screen.getByLabelText('Rol inicial de la persona invitada'), 'guest');
      await userEvent.click(screen.getByRole('button', { name: 'Invitar' }));

      expect(await screen.findByTestId('admin-note')).toHaveTextContent('Se invitó a @Fernanda como invitado: tendrá acceso en cuanto entre con esa cuenta de GitHub.');
      expect(notify).toHaveBeenCalledWith(expect.stringContaining('@Fernanda'));
      expect(accountOf(server, 'Fernanda')).toMatchObject({ pending: true, siteRole: 'guest', disabled: false });
      expect(screen.getByLabelText('Usuario de GitHub')).toHaveValue('');
      expect(screen.getByLabelText('Mostrar')).toHaveValue('all');
      await waitFor(() => expect(screen.getByLabelText('Usuario de GitHub')).toHaveFocus());
      expect(rowOf('Fernanda')).toHaveAttribute('data-pending', 'true');
      expect(within(rowOf('Fernanda')).getByLabelText('Rol de @Fernanda')).toHaveValue('guest');
    });

    it('sin elegir rol invita como miembro, y Intro en el campo también invita', async () => {
      const { server, session } = await setup();
      renderAdmin(session);
      await loaded();
      await userEvent.type(screen.getByLabelText('Usuario de GitHub'), 'gaspar{Enter}');
      await screen.findByText(/Se invitó a @gaspar como miembro/);
      expect(accountOf(server, 'gaspar')).toMatchObject({ pending: true, siteRole: 'member' });
    });

    it('un nombre que no vale ni llega al servidor, y lo escrito se conserva con el error a su lado', async () => {
      const { server, session } = await setup();
      renderAdmin(session);
      await loaded();
      const input = screen.getByLabelText('Usuario de GitHub');
      await userEvent.type(input, 'no válido!');
      await userEvent.click(screen.getByRole('button', { name: 'Invitar' }));
      const error = screen.getByTestId('admin-invite-error');
      expect(error).toHaveTextContent('Escribe un nombre de usuario de GitHub válido');
      expect(input).toHaveValue('no válido!');
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(input).toHaveAccessibleDescription(/Escribe un nombre de usuario de GitHub válido/);
      expect(input).toHaveFocus();
      expect(puts(server)).toEqual([]);
      await userEvent.type(input, 'x'); // al seguir escribiendo el error se retira
      expect(screen.queryByTestId('admin-invite-error')).toBeNull();
    });

    it('un nombre que ya tiene cuenta o invitación no se invita (el servidor cambiaría su rol): lo dice y no lo pide', async () => {
      const { server, session } = await setup();
      renderAdmin(session);
      await loaded();
      await userEvent.type(screen.getByLabelText('Usuario de GitHub'), 'BETO');
      await userEvent.click(screen.getByRole('button', { name: 'Invitar' }));
      expect(screen.getByTestId('admin-invite-error')).toHaveTextContent('@beto ya tiene cuenta en la instancia (miembro). Cambia su rol en la lista.');
      await userEvent.clear(screen.getByLabelText('Usuario de GitHub'));
      await userEvent.type(screen.getByLabelText('Usuario de GitHub'), 'diego');
      await userEvent.click(screen.getByRole('button', { name: 'Invitar' }));
      expect(screen.getByTestId('admin-invite-error')).toHaveTextContent('@diego ya tiene una invitación pendiente (invitado). Cambia su rol en la lista o cancela la invitación.');
      expect(puts(server)).toEqual([]);
      expect(accountOf(server, 'beto').siteRole).toBe('member');
    });

    it('si el servidor dice que ya existía (la lista estaba vieja), no se da por invitada: avisa del rol que quedó', async () => {
      const { server, session } = await setup();
      renderAdmin(session);
      await loaded();
      server.addAccount({ login: 'hugo', siteRole: 'member', lastLoginAt: hoursAgo(1) }); // entró mientras la lista estaba abierta
      await userEvent.type(screen.getByLabelText('Usuario de GitHub'), 'hugo');
      await userEvent.selectOptions(screen.getByLabelText('Rol inicial de la persona invitada'), 'guest');
      await userEvent.click(screen.getByRole('button', { name: 'Invitar' }));
      expect(await screen.findByTestId('admin-note')).toHaveTextContent('@hugo ya tenía cuenta: ahora su rol es invitado.');
    });

    it('el tope de invitaciones sin aceptar (409 limit) se muestra con el mensaje del servidor y no borra lo escrito', async () => {
      const { server, session } = await setup({ maxPending: 1 }); // Diego ya ocupa la única plaza
      renderAdmin(session);
      await loaded();
      const input = screen.getByLabelText('Usuario de GitHub');
      await userEvent.type(input, 'ines');
      await userEvent.click(screen.getByRole('button', { name: 'Invitar' }));
      const error = await screen.findByTestId('admin-invite-error');
      expect(error).toHaveTextContent('No se pudo invitar a @ines.');
      expect(error).toHaveTextContent('Hay 1 invitaciones sin aceptar: hace falta que alguien entre o que un administrador las cancele.');
      expect(input).toHaveValue('ines');
      await waitFor(() => expect(input).toHaveFocus());
      expect(server.directory.some((a) => a.login === 'ines')).toBe(false);
    });
  });

  describe('cambiar el rol', () => {
    it('elegir otro rol solo deja un borrador: no pide nada hasta «Guardar rol», que lo aplica, avisa y devuelve el foco', async () => {
      const { server, session } = await setup();
      const { notify } = renderAdmin(session);
      await loaded();
      const select = within(rowOf('beto')).getByLabelText('Rol de @beto');
      await userEvent.selectOptions(select, 'guest');
      expect(select).toHaveValue('guest');
      expect(puts(server)).toEqual([]);
      expect(accountOf(server, 'beto').siteRole).toBe('member');
      await userEvent.click(within(rowOf('beto')).getByRole('button', { name: 'Guardar rol de @beto' }));
      expect(await screen.findByTestId('admin-note')).toHaveTextContent('@beto ahora es invitado.');
      expect(notify).toHaveBeenCalledWith('@beto ahora es invitado.');
      expect(accountOf(server, 'beto').siteRole).toBe('guest');
      expect(puts(server)).toEqual(['PUT /api/admin/users/beto']);
      await waitFor(() => expect(within(rowOf('beto')).getByLabelText('Rol de @beto')).toHaveFocus());
      expect(within(rowOf('beto')).queryByRole('button', { name: /Guardar rol/ })).toBeNull(); // sin cambios pendientes
      expect(rowOf('beto')).toHaveAttribute('data-role', 'guest');
    });

    it('«Descartar» vuelve al rol que tiene y no pide nada', async () => {
      const { server, session } = await setup();
      renderAdmin(session);
      await loaded();
      const select = within(rowOf('beto')).getByLabelText('Rol de @beto');
      await userEvent.selectOptions(select, 'admin');
      expect(within(rowOf('beto')).getByText(/Podrá ver y cambiar todas las cuentas y todos los proyectos de la instancia/)).toBeInTheDocument(); // hacer administrador avisa de lo que da
      await userEvent.click(within(rowOf('beto')).getByRole('button', { name: 'Descartar el cambio de rol de @beto' }));
      await waitFor(() => expect(select).toHaveValue('member'));
      expect(within(rowOf('beto')).queryByRole('button', { name: /Guardar rol/ })).toBeNull();
      await waitFor(() => expect(select).toHaveFocus());
      expect(puts(server)).toEqual([]);
    });

    it('hacer administrador a otra persona se guarda y la fila pasa al grupo de los administradores', async () => {
      const { server, session } = await setup();
      renderAdmin(session);
      await loaded();
      await userEvent.selectOptions(within(rowOf('beto')).getByLabelText('Rol de @beto'), 'admin');
      await userEvent.click(within(rowOf('beto')).getByRole('button', { name: 'Guardar rol de @beto' }));
      await screen.findByText('@beto ahora es administrador.');
      expect(accountOf(server, 'beto').siteRole).toBe('admin');
      expect(logins()).toEqual(['ana', 'beto', 'Elena-Dev', 'carla', 'diego']);
      await waitFor(() => expect(within(rowOf('beto')).getByLabelText('Rol de @beto')).toHaveFocus()); // el foco sigue a la fila aunque cambie de sitio
    });

    it('cambiar el rol de una invitación pendiente cambia con qué rol entrará', async () => {
      const { server, session } = await setup();
      renderAdmin(session);
      await loaded();
      await userEvent.selectOptions(within(rowOf('diego')).getByLabelText('Rol de @diego'), 'member');
      await userEvent.click(within(rowOf('diego')).getByRole('button', { name: 'Guardar rol de @diego' }));
      await screen.findByText('@diego ahora es miembro.');
      expect(accountOf(server, 'diego')).toMatchObject({ siteRole: 'member', pending: true });
    });

    it('un rol que el servidor rechaza muestra su mensaje, deja el borrador y la lista vuelve a ser la del servidor', async () => {
      const { server, session } = await setup();
      renderAdmin(session);
      await loaded();
      server.inject(/^PUT \/api\/admin\/users\/beto$/, 409, { error: 'El proyecto «tienda» se quedaría sin administrador: nombra antes a otra persona.', code: 'last-admin' });
      await userEvent.selectOptions(within(rowOf('beto')).getByLabelText('Rol de @beto'), 'guest');
      await userEvent.click(within(rowOf('beto')).getByRole('button', { name: 'Guardar rol de @beto' }));
      const error = await screen.findByTestId('admin-error');
      expect(error).toHaveTextContent('No se pudo cambiar el rol de @beto. El proyecto «tienda» se quedaría sin administrador: nombra antes a otra persona.');
      expect(error).toHaveAttribute('role', 'alert');
      expect(accountOf(server, 'beto').siteRole).toBe('member');
      expect(within(rowOf('beto')).getByLabelText('Rol de @beto')).toHaveValue('guest'); // lo elegido no se pierde: se puede reintentar o descartar
      expect(within(rowOf('beto')).getByRole('button', { name: 'Guardar rol de @beto' })).toBeEnabled();
      expect(server.log.filter((entry) => entry === 'GET /api/admin/users').length).toBeGreaterThanOrEqual(2); // y se volvió a leer la lista
    });

    it('tu propia cuenta y las de --admins no tienen controles que el servidor rechazaría, y dicen por qué', async () => {
      const { server, session } = await setup();
      accountOf(server, 'Elena-Dev').listed = true;
      renderAdmin(session);
      await loaded();
      const ana = rowOf('ana');
      expect(within(ana).getByLabelText('Rol de @ana')).toBeDisabled();
      expect(within(ana).getByLabelText('Rol de @ana')).toHaveAccessibleDescription('Es tu cuenta: no puedes cambiar tu propio rol ni desactivarte.');
      expect(within(ana).getByRole('button', { name: 'Desactivar a @ana' })).toBeDisabled();
      const elena = rowOf('Elena-Dev');
      expect(within(elena).getByLabelText('Rol de @Elena-Dev')).toBeDisabled();
      expect(within(elena).getByLabelText('Rol de @Elena-Dev')).toHaveAccessibleDescription('Figura en --admins: su rol y su acceso los manda esa lista.');
      expect(within(elena).getByRole('button', { name: 'Desactivar a @Elena-Dev' })).toBeDisabled();
      expect(within(rowOf('beto')).getByLabelText('Rol de @beto')).toBeEnabled();
    });

    it('si el servidor aun así dice que es de --admins (la lista cambió), explica dónde se cambia', async () => {
      const { server, session } = await setup();
      renderAdmin(session);
      await loaded();
      await userEvent.selectOptions(within(rowOf('Elena-Dev')).getByLabelText('Rol de @Elena-Dev'), 'member');
      accountOf(server, 'Elena-Dev').listed = true; // la lista del servicio cambió mientras la pantalla estaba abierta
      await userEvent.click(within(rowOf('Elena-Dev')).getByRole('button', { name: 'Guardar rol de @Elena-Dev' }));
      const error = await screen.findByTestId('admin-error');
      expect(error).toHaveTextContent('figura en la lista de administradores de la instancia (--admins)');
      expect(error).toHaveTextContent('Para cambiarlo hay que editar la lista --admins (IARK_ADMINS) del servicio.');
      await waitFor(() => expect(within(rowOf('Elena-Dev')).getByLabelText('Rol de @Elena-Dev')).toBeDisabled()); // la lista releída ya no deja tocarlo
    });
  });

  describe('desactivar y reactivar', () => {
    it('pide confirmación (con el foco en «No»), y «No» no cambia nada', async () => {
      const { server, session } = await setup();
      renderAdmin(session);
      await loaded();
      await userEvent.click(within(rowOf('beto')).getByRole('button', { name: 'Desactivar a @beto' }));
      const confirm = within(rowOf('beto')).getByTestId('admin-confirm');
      expect(confirm).toHaveAttribute('role', 'alert');
      expect(confirm).toHaveTextContent('¿Desactivar a @beto? Se cerrarán sus sesiones y no podrá volver a entrar hasta que la reactives.');
      expect(within(confirm).getByRole('button', { name: 'No' })).toHaveFocus();
      await userEvent.click(within(confirm).getByRole('button', { name: 'No' }));
      expect(within(rowOf('beto')).queryByTestId('admin-confirm')).toBeNull();
      await waitFor(() => expect(within(rowOf('beto')).getByRole('button', { name: 'Desactivar a @beto' })).toHaveFocus());
      expect(puts(server)).toEqual([]);
      expect(accountOf(server, 'beto').disabled).toBe(false);
    });

    it('Escape cancela la confirmación sin cerrar la pantalla; otro Escape la cierra', async () => {
      const { session } = await setup();
      const { onClose } = renderAdmin(session);
      await loaded();
      await userEvent.click(within(rowOf('beto')).getByRole('button', { name: 'Desactivar a @beto' }));
      await userEvent.keyboard('{Escape}');
      expect(within(rowOf('beto')).queryByTestId('admin-confirm')).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
      await waitFor(() => expect(within(rowOf('beto')).getByRole('button', { name: 'Desactivar a @beto' })).toHaveFocus());
      await userEvent.keyboard('{Escape}');
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('«Sí, desactivar» desactiva la cuenta, cierra sus sesiones, lo cuenta y deja el foco en «Reactivar»', async () => {
      const { server, session } = await setup();
      const betoToken = server.openSession({ id: 'u_beto', login: 'beto', siteRole: 'member' });
      const { notify } = renderAdmin(session);
      await loaded();
      await userEvent.click(within(rowOf('beto')).getByRole('button', { name: 'Desactivar a @beto' }));
      await userEvent.click(within(rowOf('beto')).getByRole('button', { name: 'Sí, desactivar' }));
      expect(await screen.findByTestId('admin-note')).toHaveTextContent('@beto quedó desactivada: se cerraron sus sesiones y no podrá volver a entrar.');
      expect(notify).toHaveBeenCalled();
      expect(accountOf(server, 'beto').disabled).toBe(true);
      expect(server.sessions.has(betoToken)).toBe(false);
      expect(rowOf('beto')).toHaveAttribute('data-disabled', 'true');
      expect(rowOf('beto')).toHaveTextContent('Desactivada');
      await waitFor(() => expect(within(rowOf('beto')).getByRole('button', { name: 'Reactivar a @beto' })).toHaveFocus());
    });

    it('reactivar no pide confirmación: se puede deshacer en un clic', async () => {
      const { server, session } = await setup();
      renderAdmin(session);
      await loaded();
      await userEvent.click(within(rowOf('carla')).getByRole('button', { name: 'Reactivar a @carla' }));
      expect(await screen.findByTestId('admin-note')).toHaveTextContent('@carla se reactivó: puede volver a entrar.');
      expect(accountOf(server, 'carla').disabled).toBe(false);
      expect(rowOf('carla')).not.toHaveAttribute('data-disabled');
      expect(within(rowOf('carla')).getByRole('button', { name: 'Desactivar a @carla' })).toBeInTheDocument();
    });

    it('un error al desactivar (el servidor cambió de idea) se muestra con su mensaje y la lista se vuelve a leer', async () => {
      const { server, session } = await setup();
      renderAdmin(session);
      await loaded();
      server.inject(/^PUT \/api\/admin\/users\/beto$/, 409, { error: '«beto» figura en la lista de administradores de la instancia (--admins): su rol y su acceso los manda esa lista.', code: 'listed-admin' });
      await userEvent.click(within(rowOf('beto')).getByRole('button', { name: 'Desactivar a @beto' }));
      await userEvent.click(within(rowOf('beto')).getByRole('button', { name: 'Sí, desactivar' }));
      const error = await screen.findByTestId('admin-error');
      expect(error).toHaveTextContent('No se pudo desactivar a @beto.');
      expect(error).toHaveTextContent('IARK_ADMINS');
      expect(within(rowOf('beto')).queryByTestId('admin-confirm')).toBeNull();
      expect(accountOf(server, 'beto').disabled).toBe(false);
    });
  });

  describe('cancelar una invitación', () => {
    it('pide confirmación y, si se confirma, la invitación desaparece (también de los proyectos) y el foco no se pierde', async () => {
      const { server, session } = await setup();
      server.share('tienda', 'diego', 'viewer');
      renderAdmin(session);
      await loaded();
      await userEvent.click(within(rowOf('diego')).getByRole('button', { name: 'Cancelar invitación de @diego' }));
      expect(within(rowOf('diego')).getByTestId('admin-confirm')).toHaveTextContent('¿Cancelar la invitación de @diego? Ya no podrá entrar y se quitará de los proyectos que le hubieran compartido.');
      await userEvent.click(within(rowOf('diego')).getByRole('button', { name: 'No' }));
      expect(server.directory.some((a) => a.login === 'diego')).toBe(true);

      await userEvent.click(within(rowOf('diego')).getByRole('button', { name: 'Cancelar invitación de @diego' }));
      await userEvent.click(within(rowOf('diego')).getByRole('button', { name: 'Sí, cancelar invitación' }));
      expect(await screen.findByTestId('admin-note')).toHaveTextContent('Se canceló la invitación de @diego: ya no puede entrar.');
      expect(server.directory.some((a) => a.login === 'diego')).toBe(false);
      expect(server.members.get('tienda')?.some((m) => m.login === 'diego')).toBe(false);
      expect(logins()).not.toContain('diego');
      await waitFor(() => expect(screen.getByLabelText('Buscar')).toHaveFocus()); // la fila ya no está: el foco pasa a la búsqueda
      expect(screen.getByTestId('admin-count')).toHaveTextContent('4 cuentas · 2 administradores · 0 invitaciones pendientes');
    });

    it('si la persona entró mientras tanto, el servidor lo impide: se muestra su mensaje y la fila ya ofrece desactivar', async () => {
      const { server, session } = await setup();
      renderAdmin(session);
      await loaded();
      await userEvent.click(within(rowOf('diego')).getByRole('button', { name: 'Cancelar invitación de @diego' }));
      Object.assign(accountOf(server, 'diego'), { pending: false, lastLoginAt: hoursAgo(0) }); // Diego entra con su cuenta de GitHub
      await userEvent.click(within(rowOf('diego')).getByRole('button', { name: 'Sí, cancelar invitación' }));
      const error = await screen.findByTestId('admin-error');
      expect(error).toHaveTextContent('No se pudo cancelar la invitación de @diego. Esa persona ya entró: para quitarle el acceso, desactiva su cuenta.');
      await waitFor(() => expect(within(rowOf('diego')).getByRole('button', { name: 'Desactivar a @diego' })).toBeInTheDocument());
      expect(rowOf('diego')).not.toHaveAttribute('data-pending');
    });

    it('si otra persona la canceló antes (404), lo dice y la lista ya no la trae', async () => {
      const { server, session } = await setup();
      renderAdmin(session);
      await loaded();
      await userEvent.click(within(rowOf('diego')).getByRole('button', { name: 'Cancelar invitación de @diego' }));
      server.directory.splice(server.directory.findIndex((a) => a.login === 'diego'), 1);
      await userEvent.click(within(rowOf('diego')).getByRole('button', { name: 'Sí, cancelar invitación' }));
      expect(await screen.findByTestId('admin-error')).toHaveTextContent('No existe la cuenta «diego».');
      await waitFor(() => expect(logins()).not.toContain('diego'));
    });
  });

  describe('cuando el servidor no deja o no responde', () => {
    it('quien no administra la instancia recibe el 403 del servidor y no ve ni una cuenta ni un control', async () => {
      const server = fakeServer({ accounts: true });
      const token = server.openSession({ id: 'u_beto', login: 'beto', siteRole: 'member' });
      server.addAccount({ login: 'secreta', siteRole: 'admin' });
      const session = createProjectSession({ config: { kind: 'remote', url: URL_, token }, fetch: server.fetch, session: { broadcast: false, pollMs: 0 } });
      await session.init();
      renderAdmin(session, { me: { id: 'u_beto', login: 'beto', siteRole: 'member' } });
      const blocked = await screen.findByTestId('admin-blocked');
      expect(blocked).toHaveAttribute('data-code', 'forbidden');
      expect(blocked).toHaveTextContent('Solo quien administra la instancia puede ver y cambiar las cuentas.');
      expect(screen.queryByRole('table')).toBeNull();
      expect(screen.queryByLabelText('Usuario de GitHub')).toBeNull();
      expect(screen.queryByText(/secreta/)).toBeNull();
    });

    it('si le quitan el rol de administrador con la pantalla abierta, el siguiente intento muestra el 403 y retira la lista y los controles', async () => {
      const { server, session } = await setup();
      renderAdmin(session);
      await loaded();
      accountOf(server, 'ana').siteRole = 'member'; // otra persona administradora le quitó el rol
      await userEvent.click(within(rowOf('beto')).getByRole('button', { name: 'Desactivar a @beto' }));
      await userEvent.click(within(rowOf('beto')).getByRole('button', { name: 'Sí, desactivar' }));
      const blocked = await screen.findByTestId('admin-blocked');
      expect(blocked).toHaveTextContent('Solo quien administra la instancia puede ver y cambiar las cuentas.');
      expect(blocked).toHaveTextContent('Puede que tu rol en la instancia haya cambiado');
      expect(screen.queryByRole('table')).toBeNull();
      expect(screen.queryByLabelText('Usuario de GitHub')).toBeNull();
      expect(accountOf(server, 'beto').disabled).toBe(false);
    });

    it('una sesión caducada (401) lo dice y manda a iniciar sesión de nuevo', async () => {
      const { server, session } = await setup();
      renderAdmin(session);
      await loaded();
      server.sessions.clear(); // la sesión se cerró desde otro sitio
      await userEvent.click(screen.getByRole('button', { name: 'Actualizar' }));
      const blocked = await screen.findByTestId('admin-blocked');
      expect(blocked).toHaveAttribute('data-code', 'unauthorized');
      expect(blocked).toHaveTextContent('Tu sesión caducó (o se cerró desde otro sitio): cierra este cuadro e inicia sesión de nuevo en «Dónde se guardan».');
      expect(screen.queryByRole('button', { name: 'Reintentar' })).toBeNull(); // reintentar no la arregla
    });

    it('sin conexión al abrir: lo dice y «Reintentar» carga la lista cuando vuelve', async () => {
      const { server, session } = await setup();
      server.down = true;
      renderAdmin(session);
      const blocked = await screen.findByTestId('admin-blocked');
      expect(blocked).toHaveAttribute('data-code', 'other');
      expect(blocked).toHaveTextContent('No se pudo conectar con http://localhost:8787');
      server.down = false;
      await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
      await loaded();
      expect(screen.queryByTestId('admin-blocked')).toBeNull();
    });

    it('una instancia sin cuentas (404) muestra el mensaje del servidor', async () => {
      const server = fakeServer({ accounts: false, token: 'secreto', role: 'admin' });
      const session = createProjectSession({ config: { kind: 'remote', url: URL_, token: 'secreto' }, fetch: server.fetch, session: { broadcast: false, pollMs: 0 } });
      await session.init();
      renderAdmin(session);
      expect(await screen.findByTestId('admin-blocked')).toHaveTextContent('la administración de cuentas solo existe con --accounts');
    });

    it('si se cae la conexión al guardar, el error lo dice, no se pierde el borrador y «Actualizar» recupera la lista', async () => {
      const { server, session } = await setup();
      renderAdmin(session);
      await loaded();
      await userEvent.selectOptions(within(rowOf('beto')).getByLabelText('Rol de @beto'), 'guest');
      server.down = true;
      await userEvent.click(within(rowOf('beto')).getByRole('button', { name: 'Guardar rol de @beto' }));
      expect(await screen.findByTestId('admin-error')).toHaveTextContent('No se pudo cambiar el rol de @beto. No se pudo conectar con http://localhost:8787');
      expect(screen.getByRole('table')).toBeInTheDocument(); // la última lista leída sigue a la vista
      expect(within(rowOf('beto')).getByLabelText('Rol de @beto')).toHaveValue('guest');
      server.down = false;
      await userEvent.click(within(rowOf('beto')).getByRole('button', { name: 'Guardar rol de @beto' }));
      await screen.findByText('@beto ahora es invitado.');
      expect(screen.queryByTestId('admin-error')).toBeNull();
    });
  });

  describe('teclado y foco', () => {
    it('se abre con el foco dentro y Escape lo cierra; al cerrarse el foco vuelve a quien lo abrió', async () => {
      const { session } = await setup();
      const opener = document.createElement('button');
      document.body.appendChild(opener);
      opener.focus();
      const { onClose } = renderAdmin(session);
      expect(screen.getByRole('dialog')).toHaveFocus();
      await loaded();
      await userEvent.keyboard('{Escape}');
      expect(onClose).toHaveBeenCalledTimes(1);
      cleanup();
      expect(opener).toHaveFocus();
      opener.remove();
    });

    it('el foco se queda dentro del cuadro: Tab desde el último control vuelve al primero y Mayús+Tab al revés', async () => {
      const { session } = await setup();
      renderAdmin(session);
      await loaded();
      // jsdom no calcula `offsetParent`: se simula como lo haría un navegador (todo lo pintado es alcanzable).
      const spy = vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockReturnValue(document.body);
      try {
        const close = screen.getByRole('button', { name: 'Cerrar' });
        const buttons = [...screen.getByRole('dialog').querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)')];
        const last = buttons[buttons.length - 1];
        last.focus();
        await userEvent.tab();
        expect(close).toHaveFocus();
        await userEvent.tab({ shift: true });
        expect(last).toHaveFocus();
      } finally {
        spy.mockRestore();
      }
    });

    it('todos los controles tienen nombre accesible y la lista se anuncia como tabla con su leyenda', async () => {
      const { session } = await setup();
      renderAdmin(session);
      const table = await loaded();
      expect(table.querySelector('caption')).toHaveTextContent('Cuentas de la instancia');
      for (const control of screen.getByRole('dialog').querySelectorAll('button, input, select')) {
        expect(control, control.outerHTML).toHaveAccessibleName();
      }
      expect(screen.getByRole('form', { name: 'Invitar a una persona' })).toBeInTheDocument();
    });
  });
});
