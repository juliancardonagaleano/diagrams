import { expect, test as base, type Browser, type Locator, type Page } from '@playwright/test';
import { startManagedCloud, type ManagedCloud } from './cloud-server';
import { c4Ready, docShot, openEditor } from './canvas-helpers';
import type { FakeProfile } from '../helpers/fakeGithub';

/**
 * La pantalla de administración de la instancia en un navegador de verdad, contra un `iark serve --accounts` real (cada prueba arranca el suyo) y un GitHub
 * de mentira que «acepta» al instante: quien administra entra, invita a alguien por su usuario, le cambia el rol y la persona invitada entra (y ve u oculta la
 * pantalla según su rol); quien es miembro no ve ni el botón; y la pantalla se aguanta en un móvil, en tema oscuro y cuando el servidor dice que no.
 * Las capturas de la documentación van a `/mnt/project-files/proyectos/admin-*.png` si esa carpeta existe.
 */
const ROOT: FakeProfile = { id: 4200, login: 'root-admin', name: 'Admin de la instancia' };
const BETO: FakeProfile = { id: 4201, login: 'beto-dev', name: 'Beto Ruiz' };
const CARLA: FakeProfile = { id: 4202, login: 'carla-dev', name: 'Carla Gil' };
const SHOTS = '/mnt/project-files/proyectos';

const test = base.extend<{ origin: string; start: () => Promise<ManagedCloud> }>({
  origin: async ({ baseURL }, use) => use(new URL(baseURL!).origin),
  start: async ({ origin }, use) => {
    const started: ManagedCloud[] = [];
    try {
      await use(async () => {
        const cloud = await startManagedCloud({ cors: origin, signup: 'invite', admins: [ROOT] });
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
const row = (page: Page, login: string): Locator => admin(page).locator(`[data-testid="admin-row"][data-login="${login}"]`);

/** Un navegador aparte (otras cookies y otro almacenamiento): otra persona en otro equipo. */
async function anotherPerson(browser: Browser, origin: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 900 } });
  return context.newPage();
}

async function open(page: Page, query = ''): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/modulos.html?module=data${query}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('project-bar')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('editor-status')).toContainText('Válido', { timeout: 20000 });
  return errors;
}

/** Escribe la dirección del servidor en «Dónde se guardan» y entra con GitHub: la página sale hacia el servidor y vuelve ya con la sesión. */
async function logIn(page: Page, cloud: ManagedCloud, profile: FakeProfile): Promise<void> {
  cloud.signInAs(profile);
  await page.getByRole('button', { name: 'Proyectos…' }).click();
  await expect(dialog(page)).toBeVisible();
  await storage(page).getByRole('button', { name: 'Conectar a un servidor…' }).click();
  await storage(page).getByLabel('Dirección del servidor').fill(cloud.url);
  await Promise.all([page.waitForEvent('load'), storage(page).getByRole('button', { name: 'Iniciar sesión con GitHub' }).click()]);
  await expect(page.getByTestId('project-bar')).toBeVisible({ timeout: 20000 });
}

/** Abre el gestor de una página que ya tiene sesión y espera a saber quién es: ahí es cuando el panel decide si ofrece la administración. */
async function openProjects(page: Page, who: RegExp): Promise<void> {
  await page.getByRole('button', { name: 'Proyectos…' }).click();
  await expect(storage(page).getByTestId('storage-status')).toHaveText('Conectado');
  await expect(storage(page).getByTestId('storage-summary')).toContainText(who);
}

async function openAdmin(page: Page): Promise<void> {
  await dialog(page).getByTestId('admin-open').click();
  await expect(admin(page)).toBeVisible();
  await expect(admin(page).getByRole('table', { name: 'Cuentas de la instancia' })).toBeVisible();
}

async function invite(page: Page, login: string, role: 'admin' | 'member' | 'guest'): Promise<void> {
  const form = admin(page).getByRole('form', { name: 'Invitar a una persona' });
  await form.getByLabel('Usuario de GitHub').fill(login);
  await form.getByLabel('Rol inicial de la persona invitada').selectOption(role);
  await form.getByRole('button', { name: 'Invitar', exact: true }).click();
  await expect(admin(page).getByTestId('admin-note')).toContainText(`Se invitó a @${login}`);
}

async function changeRole(page: Page, login: string, role: 'admin' | 'member' | 'guest'): Promise<void> {
  await row(page, login).getByLabel(`Rol de @${login}`).selectOption(role);
  await row(page, login).getByRole('button', { name: `Guardar rol de @${login}` }).click();
  await expect(row(page, login)).toHaveAttribute('data-role', role);
}

test.describe('administración de la instancia', () => {
  test('quien administra invita, cambia el rol y la persona invitada entra; un miembro no ve la pantalla', async ({ page, browser, origin, start }) => {
    test.setTimeout(120_000);
    const cloud = await start();
    const errors = await open(page);
    await logIn(page, cloud, ROOT);
    await openProjects(page, /Admin de la instancia, admin/);

    // el botón está junto a «Cambiar…» y la pantalla no se abre sola
    await expect(dialog(page).getByTestId('admin-open')).toHaveText('Administrar cuentas…');
    await expect(admin(page)).toHaveCount(0);
    await docShot(page, `${SHOTS}/admin-entrada.png`);
    await openAdmin(page);
    const self = row(page, 'root-admin');
    await expect(self).toContainText('tú');
    await expect(self).toContainText('en --admins');
    await expect(self.getByLabel('Rol de @root-admin')).toBeDisabled(); // ni su rol ni su cuenta se tocan desde aquí
    await expect(self.getByRole('button', { name: 'Desactivar a @root-admin' })).toBeDisabled();

    // invita a Beto como miembro (no puede entrar a una instancia solo por invitación si no se le invita)
    const form = admin(page).getByRole('form', { name: 'Invitar a una persona' });
    await form.getByLabel('Usuario de GitHub').fill('@beto-dev');
    await form.getByLabel('Rol inicial de la persona invitada').selectOption('member');
    await docShot(page, `${SHOTS}/admin-invitar.png`);
    await form.getByRole('button', { name: 'Invitar', exact: true }).click();
    await expect(admin(page).getByTestId('admin-note')).toContainText('Se invitó a @beto-dev como miembro');
    await expect(row(page, 'beto-dev')).toHaveAttribute('data-pending', 'true');
    await expect(form.getByLabel('Usuario de GitHub')).toBeFocused();

    // Beto entra con su cuenta de GitHub (otro navegador): tiene el rol de la invitación y no ve nada de administración
    const other = await anotherPerson(browser, origin);
    const otherErrors = await open(other);
    await logIn(other, cloud, BETO);
    await openProjects(other, /Beto Ruiz, member/);
    await expect(dialog(other).getByTestId('admin-open')).toHaveCount(0);
    await expect(other.getByText('Administrar cuentas')).toHaveCount(0);
    await storage(other).getByRole('button', { name: 'Cambiar…' }).click();
    await expect(storage(other).getByTestId('storage-account')).toContainText('Rol en la instancia: miembro');
    expect(await other.content()).not.toMatch(/admin-open|Administrar cuentas|Administración de la instancia/);
    await docShot(other, `${SHOTS}/admin-miembro.png`);

    // la lista de quien administra lo nota al actualizar: ya no es una invitación
    await admin(page).getByRole('button', { name: 'Actualizar' }).click();
    await expect(row(page, 'beto-dev')).not.toHaveAttribute('data-pending', 'true');
    await expect(row(page, 'beto-dev')).toContainText('Activa');
    await expect(row(page, 'beto-dev')).toContainText('hace un momento');

    // lo hace administrador: el cambio no se aplica hasta «Guardar rol» y avisa de lo que da
    await row(page, 'beto-dev').getByLabel('Rol de @beto-dev').selectOption('admin');
    await expect(row(page, 'beto-dev')).toContainText('Podrá ver y cambiar todas las cuentas');
    await expect(row(page, 'beto-dev')).toHaveAttribute('data-role', 'member');
    await row(page, 'beto-dev').getByRole('button', { name: 'Guardar rol de @beto-dev' }).click();
    await expect(admin(page).getByTestId('admin-note')).toContainText('@beto-dev ahora es administrador.');
    await expect(row(page, 'beto-dev')).toHaveAttribute('data-role', 'admin');
    await expect(row(page, 'beto-dev').getByLabel('Rol de @beto-dev')).toBeFocused();
    await docShot(page, `${SHOTS}/admin-lista.png`);

    // Beto recarga y ahora sí ve «Administrar cuentas…»; su pantalla muestra la cuenta de root-admin sin controles (figura en --admins)
    await other.reload({ waitUntil: 'domcontentloaded' });
    await expect(other.getByTestId('project-bar')).toBeVisible({ timeout: 20000 });
    await openProjects(other, /Beto Ruiz, admin/);
    await openAdmin(other);
    await expect(row(other, 'beto-dev')).toContainText('tú');
    await expect(row(other, 'root-admin').getByLabel('Rol de @root-admin')).toBeDisabled();
    await expect(row(other, 'root-admin')).toContainText('en --admins');

    // y al volver a ser invitado, la pantalla desaparece para él
    await changeRole(page, 'beto-dev', 'guest');
    await other.reload({ waitUntil: 'domcontentloaded' });
    await expect(other.getByTestId('project-bar')).toBeVisible({ timeout: 20000 });
    await openProjects(other, /Beto Ruiz, guest/);
    await expect(dialog(other).getByTestId('admin-open')).toHaveCount(0);

    expect(errors).toEqual([]);
    expect(otherErrors).toEqual([]);
    await other.context().close();
  });

  test('desactivar y cancelar piden confirmación; una invitación que ya se reclamó no se puede cancelar y la pantalla lo dice', async ({ page, browser, origin, start }) => {
    test.setTimeout(120_000);
    const cloud = await start();
    const errors = await open(page);
    await logIn(page, cloud, ROOT);
    await openProjects(page, /Admin de la instancia, admin/);
    await openAdmin(page);
    await invite(page, 'beto-dev', 'member');
    await invite(page, 'carla-dev', 'guest');

    // «No» no cambia nada
    await row(page, 'beto-dev').getByRole('button', { name: 'Cancelar invitación de @beto-dev' }).click();
    const confirm = row(page, 'beto-dev').getByTestId('admin-confirm');
    await expect(confirm).toContainText('¿Cancelar la invitación de @beto-dev?');
    await expect(confirm.getByRole('button', { name: 'No' })).toBeFocused(); // el foco cae en lo menos destructivo
    await docShot(page, `${SHOTS}/admin-confirmar.png`);
    await page.keyboard.press('Escape'); // Escape cancela la confirmación, no cierra la pantalla
    await expect(confirm).toHaveCount(0);
    await expect(admin(page)).toBeVisible();
    await expect(row(page, 'beto-dev').getByRole('button', { name: 'Cancelar invitación de @beto-dev' })).toBeFocused();

    // Carla entra mientras tanto: su fila (que no se ha actualizado) sigue diciendo «pendiente»
    const other = await anotherPerson(browser, origin);
    await open(other);
    await logIn(other, cloud, CARLA);
    await openProjects(other, /Carla Gil, guest/);
    await row(page, 'carla-dev').getByRole('button', { name: 'Cancelar invitación de @carla-dev' }).click();
    await row(page, 'carla-dev').getByRole('button', { name: 'Sí, cancelar invitación' }).click();
    const error = admin(page).getByTestId('admin-error');
    await expect(error).toContainText('No se pudo cancelar la invitación de @carla-dev. Esa persona ya entró: para quitarle el acceso, desactiva su cuenta.');
    await expect(error).toHaveAttribute('role', 'alert');
    await expect(row(page, 'carla-dev')).not.toHaveAttribute('data-pending', 'true'); // la lista se releyó: ahora ofrece desactivar
    await docShot(page, `${SHOTS}/admin-error.png`);

    // desactivarla sí: pide confirmación, cierra su sesión y no le deja volver a entrar
    await row(page, 'carla-dev').getByRole('button', { name: 'Desactivar a @carla-dev' }).click();
    await expect(row(page, 'carla-dev').getByTestId('admin-confirm')).toContainText('Se cerrarán sus sesiones');
    await row(page, 'carla-dev').getByRole('button', { name: 'Sí, desactivar' }).click();
    await expect(admin(page).getByTestId('admin-note')).toContainText('@carla-dev quedó desactivada');
    await expect(row(page, 'carla-dev')).toHaveAttribute('data-disabled', 'true');
    await expect(row(page, 'carla-dev').getByRole('button', { name: 'Reactivar a @carla-dev' })).toBeFocused();
    await other.reload({ waitUntil: 'domcontentloaded' });
    await expect(other.getByTestId('project-bar')).toBeVisible({ timeout: 20000 });
    await other.getByRole('button', { name: 'Proyectos…' }).click();
    await expect(storage(other).getByTestId('storage-status')).toHaveText('Sesión caducada'); // su sesión se cerró en el servidor

    // reactivarla no pide nada y Carla vuelve a entrar
    await row(page, 'carla-dev').getByRole('button', { name: 'Reactivar a @carla-dev' }).click();
    await expect(admin(page).getByTestId('admin-note')).toContainText('@carla-dev se reactivó');
    await expect(row(page, 'carla-dev')).not.toHaveAttribute('data-disabled', 'true');

    // cancelar la invitación de Beto, ahora sí: ya no figura y no puede entrar
    await row(page, 'beto-dev').getByRole('button', { name: 'Cancelar invitación de @beto-dev' }).click();
    await row(page, 'beto-dev').getByRole('button', { name: 'Sí, cancelar invitación' }).click();
    await expect(admin(page).getByTestId('admin-note')).toContainText('Se canceló la invitación de @beto-dev');
    await expect(row(page, 'beto-dev')).toHaveCount(0);
    await other.context().close();

    const third = await anotherPerson(browser, origin);
    await open(third);
    await logIn(third, cloud, BETO);
    await expect(dialog(third).getByTestId('storage-login-notice')).toHaveAttribute('data-reason', 'not_invited', { timeout: 20000 });
    await expect(dialog(third).getByTestId('storage-login-notice')).toContainText('Esta instancia es solo por invitación');
    await third.context().close();
    expect(errors).toEqual([]);
  });

  test('en un móvil cada cuenta es una tarjeta sin desplazamiento lateral, y en tema oscuro se lee igual', async ({ page, start }) => {
    test.setTimeout(90_000);
    const cloud = await start();
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = await open(page, '&theme=light');
    await logIn(page, cloud, ROOT);
    await openProjects(page, /Admin de la instancia, admin/);
    await openAdmin(page);
    await invite(page, 'beto-dev', 'member');
    await invite(page, 'carla-dev', 'guest');
    await row(page, 'beto-dev').getByLabel('Rol de @beto-dev').selectOption('admin'); // con un borrador pendiente la fila es la más ancha

    const overflow = await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>('[data-testid="admin-dialog"] .pj-admin-body')!;
      const dialogBox = document.querySelector<HTMLElement>('[data-testid="admin-dialog"]')!.getBoundingClientRect();
      return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, body: body.scrollWidth - body.clientWidth, dialogRight: dialogBox.right, viewport: window.innerWidth };
    });
    expect(overflow.page).toBeLessThanOrEqual(0);
    expect(overflow.body).toBeLessThanOrEqual(0);
    expect(overflow.dialogRight).toBeLessThanOrEqual(overflow.viewport);
    await expect(row(page, 'beto-dev').getByRole('button', { name: 'Guardar rol de @beto-dev' })).toBeVisible();
    await expect(row(page, 'beto-dev').locator('td[data-label="Estado"]')).toBeVisible(); // la etiqueta de cada dato viene de su columna
    await docShot(page, `${SHOTS}/admin-movil.png`);

    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });
    await expect(admin(page)).toBeVisible();
    const colors = await page.evaluate(() => {
      const box = document.querySelector<HTMLElement>('[data-testid="admin-dialog"]')!;
      return { background: getComputedStyle(box).backgroundColor, color: getComputedStyle(box).color };
    });
    expect(colors.background).toBe('rgb(26, 29, 35)'); // --wb-surface del tema oscuro
    expect(colors.color).not.toBe(colors.background);
    await docShot(page, `${SHOTS}/admin-oscuro.png`);
    expect(errors).toEqual([]);
  });

  test('el editor C4 también la ofrece a quien administra, con los colores de su tema', async ({ page, start }) => {
    test.setTimeout(90_000);
    const cloud = await start();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openEditor(page);
    cloud.signInAs(ROOT);
    await page.getByText('Archivo', { exact: true }).click();
    await page.getByText('Proyectos…').click();
    await storage(page).getByRole('button', { name: 'Conectar a un servidor…' }).click();
    await storage(page).getByLabel('Dirección del servidor').fill(cloud.url);
    await Promise.all([page.waitForEvent('load'), storage(page).getByRole('button', { name: 'Iniciar sesión con GitHub' }).click()]);
    await c4Ready(page);

    await page.getByText('Archivo', { exact: true }).click();
    await page.getByText('Proyectos…').click();
    await expect(storage(page).getByTestId('storage-summary')).toContainText('Admin de la instancia, admin');
    await openAdmin(page);
    await expect(row(page, 'root-admin')).toContainText('en --admins');
    const paint = await page.evaluate(() => {
      const box = document.querySelector<HTMLElement>('[data-testid="admin-dialog"]')!;
      return { background: getComputedStyle(box).backgroundColor, color: getComputedStyle(box).color };
    });
    expect(paint.background).not.toBe('rgba(0, 0, 0, 0)'); // el fondo sale de las variables del tema del editor, no queda transparente
    expect(paint.color).not.toBe(paint.background);
    await docShot(page, `${SHOTS}/admin-c4.png`);

    await page.keyboard.press('Escape'); // cierra la administración y deja el gestor abierto
    await expect(admin(page)).toHaveCount(0);
    await expect(dialog(page)).toBeVisible();
    expect(errors).toEqual([]);
  });
});
