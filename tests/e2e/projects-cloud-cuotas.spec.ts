import { expect, test as base, type Browser, type Page } from '@playwright/test';
import { startManagedCloud, type ManagedCloud } from './cloud-server';
import type { FakeProfile } from '../helpers/fakeGithub';

/**
 * Las cuotas en un navegador de verdad, contra un `iark serve --accounts --max-projects 2` real: una persona ve cuánto usa en el gestor de proyectos, quien
 * administra la instancia ve el uso de cada cuenta y le baja el tope, y al llegar a él la persona recibe el aviso y el servidor rechaza el proyecto de más
 * con el mensaje del servicio (nada se pierde: lo que ya tenía sigue ahí).
 */
const ROOT: FakeProfile = { id: 4300, login: 'root-cuotas', name: 'Admin de la instancia' };
const BETO: FakeProfile = { id: 4301, login: 'beto-cuotas', name: 'Beto Ruiz' };

const test = base.extend<{ origin: string; start: () => Promise<ManagedCloud> }>({
  origin: async ({ baseURL }, use) => use(new URL(baseURL!).origin),
  start: async ({ origin }, use) => {
    const started: ManagedCloud[] = [];
    try {
      await use(async () => {
        const cloud = await startManagedCloud({ cors: origin, signup: 'invite', admins: [ROOT], extraArgs: ['--max-projects', '2'] });
        started.push(cloud);
        return cloud;
      });
    } finally {
      await Promise.all(started.map((cloud) => cloud.stop()));
    }
  },
});

const dialog = (page: Page) => page.getByTestId('projects-dialog');
const storage = (page: Page) => dialog(page).getByTestId('storage-panel');
const admin = (page: Page) => page.getByTestId('admin-dialog');

async function anotherPerson(browser: Browser, origin: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 900 } });
  return context.newPage();
}

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/modulos.html?module=data', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('project-bar')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('editor-status')).toContainText('Válido', { timeout: 20000 });
  return errors;
}

async function logIn(page: Page, cloud: ManagedCloud, profile: FakeProfile): Promise<void> {
  cloud.signInAs(profile);
  await page.getByRole('button', { name: 'Proyectos…' }).click();
  await expect(dialog(page)).toBeVisible();
  await storage(page).getByRole('button', { name: 'Conectar a un servidor…' }).click();
  await storage(page).getByLabel('Dirección del servidor').fill(cloud.url);
  await Promise.all([page.waitForEvent('load'), storage(page).getByRole('button', { name: 'Iniciar sesión con GitHub' }).click()]);
  await expect(page.getByTestId('project-bar')).toBeVisible({ timeout: 20000 });
}

test('la persona ve su cuota, el administrador la baja y el proyecto de más se rechaza con el mensaje del servicio', async ({ page, browser, origin, start }) => {
  test.setTimeout(150_000);
  const cloud = await start();

  // quien administra invita a Beto
  const errors = await open(page);
  await logIn(page, cloud, ROOT);
  await page.getByRole('button', { name: 'Proyectos…' }).click();
  await expect(storage(page).getByTestId('storage-summary')).toContainText(/Admin de la instancia, admin/);
  await dialog(page).getByTestId('admin-open').click();
  const form = admin(page).getByRole('form', { name: 'Invitar a una persona' });
  await form.getByLabel('Usuario de GitHub').fill(BETO.login);
  await form.getByLabel('Rol inicial de la persona invitada').selectOption('member');
  await form.getByRole('button', { name: 'Invitar', exact: true }).click();
  await expect(admin(page).getByTestId('admin-note')).toContainText(`Se invitó a @${BETO.login}`);

  // Beto entra, crea su primer proyecto y ve «1 de 2» proyectos
  const other = await anotherPerson(browser, origin);
  const otherErrors = await open(other);
  await logIn(other, cloud, BETO);
  await other.getByRole('button', { name: 'Proyectos…' }).click();
  await expect(storage(other).getByTestId('storage-summary')).toContainText(/Beto Ruiz, member/);
  await dialog(other).getByLabel('Nuevo proyecto').fill('Tienda');
  await dialog(other).getByRole('button', { name: 'Crear', exact: true }).click();
  const meter = dialog(other).getByTestId('quota-meter');
  await expect(meter).toContainText('Proyectos');
  await expect(meter).toContainText('1 de 2', { timeout: 10000 });
  await expect(dialog(other).getByTestId('quota-warning')).toHaveCount(0); // el 50 %: todavía no avisa

  // el administrador ve el uso de Beto, le deja un solo proyecto y la fila lo dice
  await admin(page).getByRole('button', { name: 'Actualizar' }).click();
  const row = admin(page).locator(`[data-testid="admin-row"][data-login="${BETO.login}"]`);
  await expect(row.getByTestId('admin-usage-projects')).toContainText('1 de 2 proyectos');
  await row.getByRole('button', { name: `Cuota de @${BETO.login}` }).click();
  const quota = admin(page).getByRole('form', { name: `Cuota de @${BETO.login}` });
  await quota.getByLabel(`Tope de proyectos de @${BETO.login}`).selectOption('custom');
  await quota.getByLabel(`Proyectos de @${BETO.login}, en proyectos`).fill('1');
  await quota.getByRole('button', { name: `Guardar cuota de @${BETO.login}` }).click();
  await expect(admin(page).getByTestId('admin-note')).toContainText(`Se guardó la cuota de @${BETO.login}: proyectos 1.`);
  await expect(row.getByTestId('admin-own-quota')).toBeVisible();
  await expect(row.getByTestId('admin-usage-level')).toHaveAttribute('data-level', 'full');
  await expect(row.getByTestId('admin-usage-projects')).toContainText('1 de 1 proyectos');

  // Beto recarga: el medidor avisa que llegó al tope y crear otro proyecto se rechaza con el mensaje del servicio; el que tenía sigue ahí
  await other.reload({ waitUntil: 'domcontentloaded' });
  await expect(other.getByTestId('project-bar')).toBeVisible({ timeout: 20000 });
  await other.getByRole('button', { name: 'Proyectos…' }).click();
  const warning = dialog(other).getByTestId('quota-warning');
  await expect(warning).toContainText('Se alcanzó el tope de los proyectos (1 de 1)', { timeout: 10000 });
  await expect(warning).toHaveAttribute('role', 'status');
  await dialog(other).getByLabel('Nuevo proyecto').fill('Otra');
  await dialog(other).getByRole('button', { name: 'Crear', exact: true }).click();
  await expect(dialog(other).getByTestId('projects-error')).toContainText('Ya tienes 1 proyecto, el máximo que te asignó un administrador (1)');
  await expect(dialog(other).getByRole('navigation', { name: 'Proyectos' })).toContainText('Tienda');
  await expect(dialog(other).getByRole('navigation', { name: 'Proyectos' })).not.toContainText('Otra');

  expect(errors).toEqual([]);
  expect(otherErrors).toEqual([]);
  await other.context().close();
});
