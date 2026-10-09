// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANA, BETO, call, cleanupCloud, signIn, startCloud, tracked, type Cloud, type CloudOptions } from '../../tests/helpers/cloud';
import { FolderProjectStore } from '../cli/workspace';
import { createProjectSession } from './factory';
import { ProjectsDialog } from './ProjectsDialog';
import type { ProjectSession } from './session';

/**
 * Las cuotas en la interfaz, contra el servidor de verdad (`createSuiteServer` con cuentas y un GitHub de mentira): el gestor de proyectos enseña cuánto
 * usa la persona y avisa al acercarse al tope; la pantalla de administración enseña el uso de cada cuenta y deja cambiar su cuota. Los números los mide
 * el servidor (`accounts/usage.ts`); aquí se comprueba que lo que se ve es lo que dice.
 */
const MODULES = [{ id: 'c4', label: 'C4' }];

async function quotaCloud(options: CloudOptions = {}): Promise<Cloud> {
  const root = mkdtempSync(join(tmpdir(), 'iark-cuotas-ui-'));
  tracked.folders.push(root);
  const workspace = new FolderProjectStore(root, { versions: { coalesceSeconds: 0 } });
  return startCloud({ signup: 'open', root, ...options, serve: { projects: workspace, usageTtlMs: 0, ...options.serve } });
}

async function sessionOf(cloud: Cloud, token: string, requests: string[] = []): Promise<ProjectSession> {
  const record: typeof fetch = async (input, init) => {
    requests.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`);
    return fetch(input, init);
  };
  const session = createProjectSession({ config: { kind: 'remote', url: cloud.base, token }, fetch: record, session: { broadcast: false, pollMs: 0, debounceMs: 10 } });
  await session.init();
  return session;
}

const usageOf = async (cloud: Cloud, token: string) => (await (await call(cloud.base, token).get('/api/usage')).json()) as { usage: { bytes: number } };
const setQuota = async (cloud: Cloud, admin: string, login: string, quota: Record<string, number | null>) => {
  const res = await call(cloud.base, admin).put(`/api/admin/users/${login}`, { quota });
  expect(res.status, await res.clone().text()).toBeLessThan(300);
};
const users = async (cloud: Cloud, token: string): Promise<Array<{ login: string; quota?: Record<string, number>; usage?: { bytes: number } }>> => (await call(cloud.base, token).get('/api/admin/users')).json();

/** Beto (miembro) con un proyecto de un diagrama de 500 bytes. */
async function betoWithProject(cloud: Cloud, size = 500): Promise<{ beto: string; project: string }> {
  const beto = await signIn(cloud, BETO);
  const created = await call(cloud.base, beto).post('/api/projects', { name: 'Tienda' });
  const project = (await created.json()).id as string;
  expect((await call(cloud.base, beto).post(`/api/projects/${project}/diagrams`, { module: 'c4', name: 'Uno', text: 'x'.repeat(size) })).status).toBe(201);
  return { beto, project };
}

function renderDialog(session: ProjectSession) {
  const props = { onOpen: vi.fn(), onClose: vi.fn(), notify: vi.fn() };
  render(<ProjectsDialog session={session} modules={MODULES} template={async () => '{}'} {...props} />);
  return props;
}

describe('cuotas en la interfaz (servidor de verdad)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(async () => {
    cleanup();
    await cleanupCloud();
  });

  describe('el gestor de proyectos', () => {
    it('enseña el espacio, los proyectos y los diagramas del proyecto elegido frente a los topes, sin avisar mientras sobra', async () => {
      const cloud = await quotaCloud({ quotas: { bytes: 100_000, projects: 5, diagramsPerProject: 10 } });
      const { beto } = await betoWithProject(cloud);
      renderDialog(await sessionOf(cloud, beto));
      const meter = await screen.findByTestId('quota-meter', {}, { timeout: 4000 });
      expect(within(meter).getByText('Espacio')).toBeInTheDocument();
      expect(meter).toHaveTextContent(/\d+ B de 97,7 KB/);
      expect(meter).toHaveTextContent('1 de 5');
      expect(within(meter).getByText('Diagramas de «Tienda»')).toBeInTheDocument();
      expect(meter).toHaveTextContent('1 de 10');
      expect(within(meter).getByRole('progressbar', { name: /Proyectos: 20 % del tope/ })).toBeInTheDocument();
      expect(screen.queryByTestId('quota-warning')).toBeNull();
      expect(meter).toHaveAttribute('data-level', 'ok');
    });

    it('avisa al pasar del 80 % del espacio (role=status) y, al llegar al tope, lo dice como error', async () => {
      const cloud = await quotaCloud();
      const ana = await signIn(cloud, ANA);
      const { beto } = await betoWithProject(cloud);
      const used = (await usageOf(cloud, beto)).usage.bytes;
      expect(used).toBeGreaterThan(0);
      await setQuota(cloud, ana, 'beto', { bytes: Math.ceil(used / 0.9) });
      renderDialog(await sessionOf(cloud, beto));
      const warning = await screen.findByTestId('quota-warning', {}, { timeout: 4000 });
      expect(warning).toHaveAttribute('role', 'status');
      expect(warning).toHaveAttribute('data-level', 'near');
      expect(warning).toHaveTextContent(/Te acercas al tope del espacio/);
      expect(screen.getByTestId('quota-meter')).toHaveAttribute('data-level', 'near');
      cleanup();

      await setQuota(cloud, ana, 'beto', { bytes: used });
      renderDialog(await sessionOf(cloud, beto));
      const full = await screen.findByTestId('quota-warning', {}, { timeout: 4000 });
      expect(full).toHaveAttribute('data-level', 'full');
      expect(full).toHaveTextContent(/Se alcanzó el tope del espacio/);
      expect(full).toHaveClass('pj-error');
    });

    it('se actualiza cuando cambia la lista de proyectos: al crear el segundo diagrama sube la cuenta y avisa del tope de diagramas', async () => {
      const cloud = await quotaCloud({ quotas: { bytes: 0, projects: 0, diagramsPerProject: 2 } });
      const { beto, project } = await betoWithProject(cloud, 10);
      const session = await sessionOf(cloud, beto);
      renderDialog(session);
      const meter = await screen.findByTestId('quota-meter', {}, { timeout: 4000 });
      expect(meter).toHaveTextContent('1 de 2'); // el 50 %: aún no se avisa
      expect(screen.queryByTestId('quota-warning')).toBeNull();
      await session.createDiagram({ module: 'c4', name: 'Dos', text: 'x' }, project);
      await waitFor(() => expect(screen.getByTestId('quota-meter')).toHaveTextContent('2 de 2'), { timeout: 4000 });
      expect(screen.getByTestId('quota-warning')).toHaveAttribute('data-level', 'full');
      expect(screen.getByTestId('quota-warning')).toHaveTextContent(/Se alcanzó el tope de los diagramas \(2 de 2\)/);
    });

    it('el tope de diagramas solo se enseña en un proyecto que posee quien mira: en uno compartido por otra persona no sale', async () => {
      const cloud = await quotaCloud({ quotas: { bytes: 0, projects: 0, diagramsPerProject: 5 } });
      const ana = await signIn(cloud, ANA);
      const { beto } = await betoWithProject(cloud, 10);
      const made = await call(cloud.base, ana).post('/api/projects', { name: 'Ajeno' });
      const ajeno = (await made.json()).id as string;
      expect((await call(cloud.base, ana).put(`/api/projects/${ajeno}/members/beto`, { role: 'editor' })).status).toBeLessThan(300);
      renderDialog(await sessionOf(cloud, beto));
      const meter = await screen.findByTestId('quota-meter', {}, { timeout: 4000 });
      const list = within(screen.getByRole('navigation', { name: 'Proyectos' }));
      await userEvent.click(await list.findByRole('button', { name: /Tienda/ }));
      await waitFor(() => expect(within(meter).getByText('Diagramas de «Tienda»')).toBeInTheDocument());
      await userEvent.click(list.getByRole('button', { name: /Ajeno/ }));
      await waitFor(() => expect(within(meter).queryByText(/Diagramas de/)).toBeNull());
    });

    it('no aparece sin topes, con este navegador ni con un token, y en esos casos ni siquiera pregunta por /api/usage', async () => {
      const unlimited = await quotaCloud({ quotas: { bytes: 0, projects: 0, diagramsPerProject: 0 } });
      const { beto } = await betoWithProject(unlimited);
      const requests: string[] = [];
      renderDialog(await sessionOf(unlimited, beto, requests));
      await waitFor(() => expect(requests).toContain('GET /api/usage'), { timeout: 4000 });
      await waitFor(() => expect(screen.getByTestId('storage-summary')).toHaveTextContent(/\(beto, member\)/));
      expect(screen.queryByTestId('quota-meter')).toBeNull();
      cleanup();

      const withTokens = await quotaCloud({ tokens: true, quotas: { bytes: 1000 } });
      const tokenRequests: string[] = [];
      renderDialog(await sessionOf(withTokens, withTokens.tokens!.admin, tokenRequests));
      await waitFor(() => expect(screen.getByTestId('storage-summary')).toHaveTextContent(/\(servicio, admin\)/));
      expect(screen.queryByTestId('quota-meter')).toBeNull();
      expect(tokenRequests.filter((r) => r.includes('/api/usage'))).toEqual([]);
    });
  });

  describe('la pantalla de administración', () => {
    async function openAdmin(cloud: Cloud, ana: string): Promise<HTMLElement> {
      renderDialog(await sessionOf(cloud, ana));
      await userEvent.click(await screen.findByTestId('admin-open'));
      const dialog = await screen.findByTestId('admin-dialog');
      await within(dialog).findByRole('table', { name: 'Cuentas de la instancia' });
      return dialog;
    }
    const rowOf = (login: string): HTMLElement => within(screen.getByTestId('admin-dialog')).getAllByTestId('admin-row').find((row) => row.getAttribute('data-login') === login)!;

    it('enseña lo que ocupa cada cuenta frente a sus topes y marca a quien está cerca; ordenar por espacio pone primero a quien más usa', async () => {
      const cloud = await quotaCloud({ quotas: { bytes: 1_048_576, projects: 5, diagramsPerProject: 0 } });
      const ana = await signIn(cloud, ANA);
      const { beto } = await betoWithProject(cloud, 1000);
      const used = (await usageOf(cloud, beto)).usage.bytes;
      await setQuota(cloud, ana, 'beto', { bytes: Math.ceil(used / 0.85) });
      await call(cloud.base, ana).put('/api/admin/users/carla', { siteRole: 'member' });
      await openAdmin(cloud, ana);

      const row = rowOf('beto');
      expect(within(row).getByTestId('admin-usage')).toHaveTextContent(/KB de/);
      expect(within(row).getByTestId('admin-usage-projects')).toHaveTextContent('1 de 5 proyectos');
      expect(within(row).getByTestId('admin-own-quota')).toHaveTextContent('cuota propia');
      expect(within(row).getByTestId('admin-usage-level')).toHaveTextContent('Cerca del tope');
      expect(within(rowOf('ana')).getByTestId('admin-usage')).toHaveTextContent('(sin tope)'); // quien administra la instancia no tiene tope
      expect(within(rowOf('carla')).queryByTestId('admin-own-quota')).toBeNull();

      await userEvent.selectOptions(screen.getByLabelText('Ordenar por'), 'usage');
      const order = within(screen.getByTestId('admin-dialog')).getAllByTestId('admin-row').map((r) => r.getAttribute('data-login'));
      expect(order[0]).toBe('beto');
    });

    it('edita la cuota de una cuenta: valor de la instancia, sin tope u otro valor; lo guarda el servidor y la fila lo refleja', async () => {
      const cloud = await quotaCloud({ quotas: { bytes: 100_000, projects: 5, diagramsPerProject: 10 } });
      const ana = await signIn(cloud, ANA);
      await betoWithProject(cloud);
      await openAdmin(cloud, ana);

      await userEvent.click(within(rowOf('beto')).getByRole('button', { name: 'Cuota de @beto' }));
      const form = await screen.findByRole('form', { name: 'Cuota de @beto' });
      await userEvent.selectOptions(within(form).getByLabelText('Tope de espacio de @beto'), 'custom');
      const mb = within(form).getByLabelText('Espacio de @beto, en MB');
      await userEvent.clear(mb);
      await userEvent.type(mb, '2');
      await userEvent.selectOptions(within(form).getByLabelText('Tope de proyectos de @beto'), 'none');
      await userEvent.click(within(form).getByRole('button', { name: 'Guardar cuota de @beto' }));

      await waitFor(() => expect(screen.getByTestId('admin-note')).toHaveTextContent('Se guardó la cuota de @beto: espacio 2 MB, proyectos sin tope.'));
      expect((await users(cloud, ana)).find((u) => u.login === 'beto')?.quota).toEqual({ bytes: 2 * 1024 * 1024, projects: 0 });
      await waitFor(() => expect(screen.queryByTestId('admin-quota-row')).toBeNull());
      await waitFor(() => expect(within(rowOf('beto')).getByTestId('admin-usage')).toHaveTextContent('de 2 MB'));
      await waitFor(() => expect(within(rowOf('beto')).getByTestId('admin-usage-projects')).toHaveTextContent('1 proyecto propio'));
      await waitFor(() => expect(within(rowOf('beto')).getByRole('button', { name: 'Cuota de @beto' })).toHaveFocus());

      // volver al valor de la instancia lo quita
      await userEvent.click(within(rowOf('beto')).getByRole('button', { name: 'Cuota de @beto' }));
      const again = await screen.findByRole('form', { name: 'Cuota de @beto' });
      expect(within(again).getByLabelText('Tope de espacio de @beto')).toHaveValue('custom');
      expect(within(again).getByLabelText('Espacio de @beto, en MB')).toHaveValue(2);
      expect(within(again).getByLabelText('Tope de proyectos de @beto')).toHaveValue('none');
      await userEvent.selectOptions(within(again).getByLabelText('Tope de espacio de @beto'), 'instance');
      await userEvent.selectOptions(within(again).getByLabelText('Tope de proyectos de @beto'), 'instance');
      await userEvent.click(within(again).getByRole('button', { name: 'Guardar cuota de @beto' }));
      await waitFor(() => expect(screen.getByTestId('admin-note')).toHaveTextContent('@beto vuelve a los topes de la instancia.'));
      expect((await users(cloud, ana)).find((u) => u.login === 'beto')?.quota).toBeUndefined();
      await waitFor(() => expect(within(rowOf('beto')).queryByTestId('admin-own-quota')).toBeNull());
    });

    it('un número que no vale se explica en la pantalla y no llega al servidor; Escape y Cancelar cierran el editor sin cambiar nada', async () => {
      const cloud = await quotaCloud({ quotas: { bytes: 100_000 } });
      const ana = await signIn(cloud, ANA);
      await betoWithProject(cloud);
      const requests: string[] = [];
      renderDialog(await sessionOf(cloud, ana, requests));
      await userEvent.click(await screen.findByTestId('admin-open'));
      await within(await screen.findByTestId('admin-dialog')).findByRole('table', { name: 'Cuentas de la instancia' });

      await userEvent.click(within(rowOf('beto')).getByRole('button', { name: 'Cuota de @beto' }));
      const form = await screen.findByRole('form', { name: 'Cuota de @beto' });
      await userEvent.selectOptions(within(form).getByLabelText('Tope de proyectos de @beto'), 'custom');
      const projects = within(form).getByLabelText('Proyectos de @beto, en proyectos');
      await userEvent.clear(projects);
      await userEvent.type(projects, '2.5');
      await userEvent.click(within(form).getByRole('button', { name: 'Guardar cuota de @beto' }));
      expect(await screen.findByTestId('admin-quota-error')).toHaveTextContent('Escribe un número mayor que cero para los proyectos');
      expect(requests.filter((r) => r.startsWith('PUT '))).toEqual([]);

      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByTestId('admin-quota-row')).toBeNull());
      expect(screen.getByTestId('admin-dialog')).toBeInTheDocument(); // Escape cerró el editor, no la pantalla
      expect(within(rowOf('beto')).getByRole('button', { name: 'Cuota de @beto' })).toHaveFocus();

      await userEvent.click(within(rowOf('beto')).getByRole('button', { name: 'Cuota de @beto' }));
      await userEvent.click(within(await screen.findByRole('form', { name: 'Cuota de @beto' })).getByRole('button', { name: 'Cancelar el cambio de cuota de @beto' }));
      expect(screen.queryByTestId('admin-quota-row')).toBeNull();
      expect((await users(cloud, ana)).find((u) => u.login === 'beto')?.quota).toBeUndefined();
    });
  });
});
