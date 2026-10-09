// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryProjectStore } from '@iark/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANA, BETO, CARLA, call, cleanupCloud, signIn, startCloud, type Cloud } from '../../tests/helpers/cloud';
import { loginWithGithub } from '../../tests/helpers/githubLogin';
import { createProjectSession } from './factory';
import { ProjectsDialog } from './ProjectsDialog';
import { ProjectSession } from './session';

/**
 * La pantalla de administración de la instancia desde el gestor de proyectos, contra el servidor de verdad (`createSuiteServer` con cuentas y un GitHub de
 * mentira): solo la ve quien tiene `siteRole: 'admin'` (a los demás no les llega ni el botón ni una sola petición a `/api/admin`), y lo que se hace en ella
 * —invitar, cambiar el rol, desactivar y reactivar, cancelar una invitación— lo nota el servidor y las personas afectadas al entrar.
 */
const MODULES = [{ id: 'c4', label: 'C4' }];
const DIEGO = { id: 404, login: 'diego' };

/** Lo que pide un cliente al servidor: cada petición (método y ruta) y cuántas siguen en curso (para no dejar una a medias al apagar el servidor). */
interface Traffic {
  requests: string[];
  open: number;
}

async function sessionOf(cloud: Cloud, token: string, traffic: Traffic = { requests: [], open: 0 }): Promise<ProjectSession> {
  const record: typeof fetch = async (input, init) => {
    traffic.requests.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`);
    traffic.open += 1;
    try {
      const response = await fetch(input, init);
      await response.clone().text(); // la petición termina de verdad cuando se leyó el cuerpo
      return response;
    } finally {
      traffic.open -= 1;
    }
  };
  const session = createProjectSession({
    config: { kind: 'remote', url: cloud.base, token },
    fetch: record,
    // sin canal de eventos: este cliente lee cada cuerpo hasta el final, y un canal abierto no termina
    session: { broadcast: false, pollMs: 0, debounceMs: 10, events: false },
  });
  await session.init();
  return session;
}

function renderDialog(session: ProjectSession) {
  const props = { onOpen: vi.fn(), onClose: vi.fn(), notify: vi.fn() };
  render(<ProjectsDialog session={session} modules={MODULES} template={async () => '{}'} {...props} />);
  return props;
}

const admin = (): HTMLElement => screen.getByTestId('admin-dialog');
const rowOf = (login: string): HTMLElement => within(admin()).getAllByTestId('admin-row').find((row) => row.getAttribute('data-login') === login)!;
const users = async (cloud: Cloud, token: string): Promise<Array<Record<string, unknown>>> => (await call(cloud.base, token).get('/api/admin/users')).json();
const whoami = async (cloud: Cloud, token: string): Promise<{ user?: { siteRole: string } }> => (await call(cloud.base, token).get('/api/whoami')).json();

/** Abre el gestor como esa persona y, con él, la pantalla de administración. */
async function openAdmin(cloud: Cloud, token: string): Promise<void> {
  renderDialog(await sessionOf(cloud, token));
  await userEvent.click(await screen.findByTestId('admin-open'));
  await within(await screen.findByTestId('admin-dialog')).findByRole('table', { name: 'Cuentas de la instancia' });
}

describe('administración de la instancia desde el gestor (servidor de verdad)', () => {
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

  describe('quien la ve', () => {
    it('una persona administradora ve «Administrar cuentas…» junto a «Cambiar…» y la pantalla lista las cuentas del servicio', async () => {
      const ana = await signIn(cloud, ANA);
      renderDialog(await sessionOf(cloud, ana));
      const button = await screen.findByTestId('admin-open');
      expect(button).toHaveAccessibleName('Administrar cuentas…');
      expect(button.nextElementSibling).toHaveTextContent('Cambiar…');
      expect(screen.queryByTestId('admin-dialog')).toBeNull(); // no se abre sola
      await userEvent.click(button);
      const dialog = await screen.findByTestId('admin-dialog');
      await within(dialog).findByRole('table', { name: 'Cuentas de la instancia' });
      expect(within(dialog).getByRole('heading', { name: 'Administración de la instancia' })).toBeInTheDocument();
      expect(dialog).toHaveTextContent('Entraste como @ana');
      const row = rowOf('ana');
      expect(row).toHaveTextContent('tú');
      expect(row).toHaveTextContent('en --admins');
      expect(row).toHaveTextContent('Ana Pérez');
      expect(within(row).getByLabelText('Rol de @ana')).toHaveValue('admin');
      expect(within(row).getByLabelText('Rol de @ana')).toBeDisabled(); // su propio rol no se cambia desde aquí
      expect(within(dialog).getByTestId('admin-count')).toHaveTextContent('1 cuenta');
    });

    it('al cerrarla, el foco vuelve al botón que la abrió', async () => {
      const ana = await signIn(cloud, ANA);
      await openAdmin(cloud, ana);
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByTestId('admin-dialog')).toBeNull());
      expect(screen.getByTestId('projects-dialog')).toBeInTheDocument(); // el gestor sigue abierto
      expect(screen.getByTestId('admin-open')).toHaveFocus();
    });

    it('un miembro, un invitado, un token de servicio y este navegador no ven botón alguno, ni el gestor pide nada de /api/admin', async () => {
      const ana = await signIn(cloud, ANA);
      expect((await call(cloud.base, ana).put('/api/admin/users/carla', { siteRole: 'guest' })).status).toBe(201);
      expect((await call(cloud.base, ana).put('/api/admin/users/beto', { siteRole: 'member' })).status).toBe(201);
      const beto = await signIn(cloud, BETO);
      const carla = await signIn(cloud, CARLA);
      const withTokens = await startCloud({ tokens: true });
      const cases: Array<{ who: string; session: (traffic: Traffic) => Promise<ProjectSession>; waits: RegExp }> = [
        { who: 'miembro', waits: /\(beto, member\)/, session: (traffic) => sessionOf(cloud, beto, traffic) },
        { who: 'invitado', waits: /\(carla, guest\)/, session: (traffic) => sessionOf(cloud, carla, traffic) },
        { who: 'token con rol admin', waits: /\(servicio, admin\)/, session: (traffic) => sessionOf(withTokens, withTokens.tokens!.admin, traffic) },
      ];
      for (const item of cases) {
        const traffic: Traffic = { requests: [], open: 0 };
        const { unmount } = render(<ProjectsDialog session={await item.session(traffic)} modules={MODULES} onOpen={vi.fn()} onClose={vi.fn()} />);
        // el panel ya sabe quién es (la ficha dice su rol): si la pantalla fuera a ofrecerse, ya estaría
        await waitFor(() => expect(screen.getByTestId('storage-summary')).toHaveTextContent(item.waits), { timeout: 4000 });
        expect(screen.queryByTestId('admin-open'), item.who).toBeNull();
        expect(screen.queryByRole('button', { name: /Administrar cuentas/ }), item.who).toBeNull();
        expect(document.body.innerHTML, item.who).not.toMatch(/admin-open|pj-admin|Administración de la instancia|Administrar cuentas/);
        await waitFor(() => expect(traffic.open).toBe(0));
        expect(traffic.requests.filter((request) => request.includes('/api/admin')), item.who).toEqual([]);
        unmount();
      }
      const session = new ProjectSession(new MemoryProjectStore(), { broadcast: false, persist: false });
      await session.init();
      renderDialog(session);
      expect(screen.getByTestId('storage-summary')).toHaveTextContent('Este navegador');
      expect(screen.queryByTestId('admin-open')).toBeNull();
    });

    it('una sesión caducada ya no ofrece la pantalla', async () => {
      const ana = await signIn(cloud, ANA);
      const session = await sessionOf(cloud, ana);
      renderDialog(session);
      await screen.findByTestId('admin-open');
      expect((await call(cloud.base, ana).post('/api/auth/logout')).status).toBeLessThan(300);
      await session.refresh(); // el gestor se entera al releer la lista
      await waitFor(() => expect(screen.queryByTestId('admin-open')).toBeNull());
    });
  });

  describe('lo que se hace en ella', () => {
    it('invitar a alguien por su usuario: el servidor la guarda pendiente y esa persona puede entrar a una instancia solo por invitación', async () => {
      const ana = await signIn(cloud, ANA);
      // antes de invitarla, Carla no entra
      expect((await loginWithGithub(cloud.base, cloud.fake, CARLA)).fragment.get('iark_error')).toBe('not_invited');

      await openAdmin(cloud, ana);
      const dialog = admin();
      await userEvent.type(within(dialog).getByLabelText('Usuario de GitHub'), '@Carla');
      await userEvent.selectOptions(within(dialog).getByLabelText('Rol inicial de la persona invitada'), 'guest');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Invitar' }));
      expect(await within(dialog).findByTestId('admin-note')).toHaveTextContent('Se invitó a @Carla como invitado');
      expect(await users(cloud, ana)).toEqual(expect.arrayContaining([expect.objectContaining({ login: 'Carla', pending: true, siteRole: 'guest', disabled: false })]));
      expect(rowOf('Carla')).toHaveAttribute('data-pending', 'true');

      // ahora sí entra, con el rol de la invitación, y la lista (al actualizar) la muestra activa y con su último acceso
      const carla = await signIn(cloud, CARLA);
      expect((await whoami(cloud, carla)).user?.siteRole).toBe('guest');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Actualizar' }));
      await waitFor(() => expect(rowOf('carla')).not.toHaveAttribute('data-pending'));
      expect(rowOf('carla')).toHaveTextContent('Activa');
      expect(rowOf('carla')).toHaveTextContent('hace un momento');
      expect(within(rowOf('carla')).getByLabelText('Rol de @carla')).toHaveValue('guest');
    });

    it('cambiar el rol: lo nota el servidor y la persona lo tiene en su siguiente petición; hacerla administradora le da la pantalla', async () => {
      const ana = await signIn(cloud, ANA);
      await call(cloud.base, ana).put('/api/admin/users/beto', { siteRole: 'guest' });
      const beto = await signIn(cloud, BETO);
      expect((await call(cloud.base, beto).post('/api/projects', { name: 'Mío' })).status).toBe(403); // un invitado no crea proyectos

      await openAdmin(cloud, ana);
      await userEvent.selectOptions(within(rowOf('beto')).getByLabelText('Rol de @beto'), 'member');
      await userEvent.click(within(rowOf('beto')).getByRole('button', { name: 'Guardar rol de @beto' }));
      await within(admin()).findByText('@beto ahora es miembro.');
      expect((await whoami(cloud, beto)).user?.siteRole).toBe('member');
      expect((await call(cloud.base, beto).post('/api/projects', { name: 'Mío' })).status).toBe(201);

      await userEvent.selectOptions(within(rowOf('beto')).getByLabelText('Rol de @beto'), 'admin');
      await userEvent.click(within(rowOf('beto')).getByRole('button', { name: 'Guardar rol de @beto' }));
      await within(admin()).findByText('@beto ahora es administrador.');
      expect((await whoami(cloud, beto)).user?.siteRole).toBe('admin');
      expect((await call(cloud.base, beto).get('/api/admin/users')).status).toBe(200);
    });

    it('desactivar cierra sus sesiones y le impide volver a entrar hasta que se reactiva', async () => {
      const ana = await signIn(cloud, ANA);
      await call(cloud.base, ana).put('/api/admin/users/beto', { siteRole: 'member' });
      const beto = await signIn(cloud, BETO);
      expect((await call(cloud.base, beto).get('/api/projects')).status).toBe(200);

      await openAdmin(cloud, ana);
      await userEvent.click(within(rowOf('beto')).getByRole('button', { name: 'Desactivar a @beto' }));
      await userEvent.click(within(rowOf('beto')).getByRole('button', { name: 'Sí, desactivar' }));
      await within(admin()).findByText(/@beto quedó desactivada/);
      expect((await call(cloud.base, beto).get('/api/projects')).status).toBe(401); // su sesión se cerró
      expect((await loginWithGithub(cloud.base, cloud.fake, BETO)).fragment.get('iark_error')).toBe('disabled');
      expect(rowOf('beto')).toHaveTextContent('Desactivada');

      await userEvent.click(within(rowOf('beto')).getByRole('button', { name: 'Reactivar a @beto' }));
      await within(admin()).findByText(/@beto se reactivó/);
      expect((await signIn(cloud, BETO)).startsWith('iark_s_')).toBe(true);
    });

    it('cancelar una invitación: esa persona ya no puede entrar', async () => {
      const ana = await signIn(cloud, ANA);
      await call(cloud.base, ana).put('/api/admin/users/diego', { siteRole: 'member' });
      await openAdmin(cloud, ana);
      await userEvent.click(within(rowOf('diego')).getByRole('button', { name: 'Cancelar invitación de @diego' }));
      await userEvent.click(within(rowOf('diego')).getByRole('button', { name: 'Sí, cancelar invitación' }));
      await within(admin()).findByText('Se canceló la invitación de @diego: ya no puede entrar.');
      expect((await users(cloud, ana)).map((u) => u.login)).toEqual(['ana']);
      expect((await loginWithGithub(cloud.base, cloud.fake, DIEGO)).fragment.get('iark_error')).toBe('not_invited');
    });

    it('si la persona entró antes de confirmar, el servidor impide cancelar (409) y la pantalla lo dice y ofrece desactivar', async () => {
      const ana = await signIn(cloud, ANA);
      await call(cloud.base, ana).put('/api/admin/users/carla', { siteRole: 'member' });
      await openAdmin(cloud, ana);
      await userEvent.click(within(rowOf('carla')).getByRole('button', { name: 'Cancelar invitación de @carla' }));
      await signIn(cloud, CARLA); // entra con la invitación mientras se pide confirmar
      await userEvent.click(within(rowOf('carla')).getByRole('button', { name: 'Sí, cancelar invitación' }));
      expect(await within(admin()).findByTestId('admin-error')).toHaveTextContent('Esa persona ya entró: para quitarle el acceso, desactiva su cuenta.');
      await waitFor(() => expect(within(rowOf('carla')).getByRole('button', { name: 'Desactivar a @carla' })).toBeEnabled());
    });

    it('el servidor impide lo que la pantalla no ofrece: una cuenta de --admins no baja de rol (409 listed-admin) ni quien llama cambia el suyo (409 self)', async () => {
      const ana = await signIn(cloud, ANA);
      const second = await call(cloud.base, ana).put('/api/admin/users/carla', { siteRole: 'admin' });
      expect(second.status).toBe(201);
      const carla = await signIn(cloud, CARLA);
      expect(await (await call(cloud.base, carla).put('/api/admin/users/carla', { disabled: true })).json()).toMatchObject({ code: 'self' });
      const listed = await call(cloud.base, carla).put('/api/admin/users/ana', { siteRole: 'member' });
      expect(listed.status).toBe(409);
      expect(await listed.json()).toMatchObject({ code: 'listed-admin' });

      // en la pantalla de Carla, la cuenta de Ana (de --admins) y la suya salen sin controles
      await openAdmin(cloud, carla);
      expect(within(rowOf('ana')).getByLabelText('Rol de @ana')).toBeDisabled();
      expect(within(rowOf('ana')).getByRole('button', { name: 'Desactivar a @ana' })).toBeDisabled();
      expect(within(rowOf('carla')).getByLabelText('Rol de @carla')).toBeDisabled();
      expect(within(rowOf('carla')).getByRole('button', { name: 'Desactivar a @carla' })).toBeDisabled();
    });

    it('si le quitan el rol de administrador con la pantalla abierta, al actualizar recibe el 403 y la lista desaparece', async () => {
      const ana = await signIn(cloud, ANA);
      await call(cloud.base, ana).put('/api/admin/users/carla', { siteRole: 'admin' });
      const carla = await signIn(cloud, CARLA);
      await openAdmin(cloud, carla);
      expect(rowOf('carla')).toBeInTheDocument();

      expect((await call(cloud.base, ana).put('/api/admin/users/carla', { siteRole: 'member' })).status).toBe(200);
      await userEvent.click(within(admin()).getByRole('button', { name: 'Actualizar' }));
      const blocked = await within(admin()).findByTestId('admin-blocked');
      expect(blocked).toHaveAttribute('data-code', 'forbidden');
      expect(blocked).toHaveTextContent('Solo quien administra la instancia puede ver y cambiar las cuentas.');
      expect(within(admin()).queryByRole('table')).toBeNull();
      expect(within(admin()).queryByLabelText('Usuario de GitHub')).toBeNull();
    });
  });
});
