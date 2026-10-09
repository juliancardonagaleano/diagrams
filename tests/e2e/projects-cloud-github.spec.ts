import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test as base, type Browser, type Page } from '@playwright/test';
import { startManagedCloud, type ManagedCloud } from './cloud-server';
import { c4Ready, openEditor } from './canvas-helpers';
import type { FakeProfile } from '../helpers/fakeGithub';

/**
 * «Guardar en la nube» con un servicio gestionado (`iark serve --workspace <carpeta> --accounts <archivo>`) y el inicio de sesión de GitHub,
 * en un navegador de verdad: el CLI real (cada prueba arranca el suyo) con un GitHub de mentira que «acepta» al instante. Se prueba el camino
 * completo: «Iniciar sesión con GitHub» → ida y vuelta por el servidor → la página recargada con la sesión → crear un proyecto y guardar un
 * diagrama → otra persona (otro navegador) no lo ve → cerrar sesión; y lo que ve quien llega a una instancia solo por invitación, quien no
 * acepta en GitHub y el reparto de un proyecto entre dos personas (rol, «Compartir…» y «Salir del proyecto»).
 */
const ANA: FakeProfile = { id: 4101, login: 'ana-dev', name: 'Ana Pérez' };
const BETO: FakeProfile = { id: 4102, login: 'beto-dev', name: 'Beto Ruiz' };
const ROOT: FakeProfile = { id: 4100, login: 'root-admin', name: 'Admin de la instancia' };

const test = base.extend<{ origin: string; start: (options?: { admins?: FakeProfile[]; signup?: 'open' | 'invite'; store?: 'json' | 'sqlite' }) => Promise<ManagedCloud> }>({
  origin: async ({ baseURL }, use) => use(new URL(baseURL!).origin),
  start: async ({ origin }, use) => {
    const started: ManagedCloud[] = [];
    try {
      await use(async (options = {}) => {
        const cloud = await startManagedCloud({ cors: origin, ...options });
        started.push(cloud);
        return cloud;
      });
    } finally {
      await Promise.all(started.map((cloud) => cloud.stop()));
    }
  },
});

const host = (cloud: ManagedCloud): string => new URL(cloud.url).host;
const dialog = (page: Page) => page.getByTestId('projects-dialog');
const storage = (page: Page) => dialog(page).getByTestId('storage-panel');
const saveStatus = (page: Page) => page.getByTestId('save-status');
const editor = (page: Page) => page.getByLabel('Documento JSON');
const BACKEND_KEY = 'iark.projects.backend';

/** Un navegador aparte (otras cookies y otro almacenamiento): otra persona en otro equipo. */
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

/**
 * Escribe la dirección del servidor en «Dónde se guardan» y pulsa «Iniciar sesión con GitHub»: la página sale hacia el servidor, GitHub
 * (de mentira) acepta y vuelve a esta misma página, recargada y ya con la sesión.
 */
async function logIn(page: Page, cloud: ManagedCloud, profile: FakeProfile, remember = true): Promise<void> {
  cloud.signInAs(profile);
  await page.getByRole('button', { name: 'Proyectos…' }).click();
  await expect(dialog(page)).toBeVisible();
  await storage(page).getByRole('button', { name: 'Conectar a un servidor…' }).click();
  await storage(page).getByLabel('Dirección del servidor').fill(cloud.url);
  const keep = storage(page).getByLabel('Mantener la sesión en este equipo');
  await expect(keep).toBeChecked(); // marcada por omisión
  if (!remember) await keep.uncheck();
  await Promise.all([page.waitForEvent('load'), storage(page).getByRole('button', { name: 'Iniciar sesión con GitHub' }).click()]);
  await expect(page.getByTestId('project-bar')).toBeVisible({ timeout: 20000 });
}

/** Lo que el navegador guardó: la configuración del servidor y el token de la sesión, y en qué almacén está cada cosa. */
async function stored(page: Page): Promise<{ local: Record<string, string>; session: Record<string, string> }> {
  return page.evaluate(() => ({ local: Object.fromEntries(Object.entries(localStorage)), session: Object.fromEntries(Object.entries(sessionStorage)) }));
}

const sessionOf = (area: Record<string, string>, cloud: ManagedCloud): string | undefined => area[`iark.projects.token:${cloud.url}`];

/** Los nombres de los diagramas que hay en disco, en la carpeta de trabajo del servidor (los proyectos viven cada uno en su carpeta). */
function onDisk(cloud: ManagedCloud): string[] {
  if (!existsSync(cloud.workspace)) return [];
  const names: string[] = [];
  for (const entry of readdirSync(cloud.workspace, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of readdirSync(join(cloud.workspace, entry.name))) {
      if (/\.[a-z0-9-]+\.json$/.test(file) && file !== 'project.json') names.push(JSON.parse(readFileSync(join(cloud.workspace, entry.name, file), 'utf8')).workspace?.name as string);
    }
  }
  return names;
}

async function projectsOf(cloud: ManagedCloud, token: string): Promise<Array<{ id: string; name: string; role?: string }>> {
  const response = await fetch(`${cloud.url}/api/projects`, { headers: { Authorization: `Bearer ${token}` } });
  expect(response.status, 'GET /api/projects').toBe(200);
  const body = (await response.json()) as unknown;
  return (Array.isArray(body) ? body : (body as { projects: unknown[] }).projects) as Array<{ id: string; name: string; role?: string }>;
}

async function createProject(page: Page, name: string): Promise<void> {
  await dialog(page).getByPlaceholder('Nombre del proyecto').fill(name);
  await dialog(page).getByRole('button', { name: 'Crear', exact: true }).click();
  await expect(dialog(page).getByRole('heading', { name })).toBeVisible();
}

/** Cambia el nombre del espacio de trabajo en el documento (con el editor de texto visible). */
async function edit(page: Page, name: string): Promise<void> {
  const doc = JSON.parse(await editor(page).inputValue());
  doc.workspace.name = name;
  await editor(page).fill(JSON.stringify(doc, null, 2));
}

test.describe('proyectos en la nube con inicio de sesión de GitHub', () => {
  test('iniciar sesión, crear un proyecto y guardar un diagrama; otra persona no lo ve; cerrar sesión', async ({ page, browser, origin, start }) => {
    const cloud = await start({ signup: 'open' });
    const errors = await open(page);
    await logIn(page, cloud, ANA);

    // vuelta de GitHub: se confirma, no queda el código en la dirección y la ficha dice quién eres
    await expect(page.locator('.wb-toast')).toContainText(`Sesión iniciada como Ana Pérez (@ana-dev) en ${host(cloud)}`);
    expect(new URL(page.url()).hash).toBe('');
    expect(page.url()).not.toContain('iark_code');
    await page.getByRole('button', { name: 'Proyectos…' }).click();
    await expect(storage(page).getByTestId('storage-summary')).toContainText(`Servidor: ${host(cloud)}`);
    await expect(storage(page).getByTestId('storage-status')).toHaveText('Conectado');
    await storage(page).getByRole('button', { name: 'Cambiar…' }).click();
    await expect(storage(page).getByTestId('storage-account-login')).toHaveText('@ana-dev');
    await expect(storage(page).getByTestId('storage-account')).toContainText('Ana Pérez');
    await expect(storage(page).getByRole('button', { name: 'Iniciar sesión con GitHub' })).toHaveCount(0); // ya hay sesión

    // por omisión la sesión se mantiene en este equipo: el token (iark_s_…) está en localStorage y no en sessionStorage
    const before = await stored(page);
    expect(JSON.parse(before.local[BACKEND_KEY])).toMatchObject({ kind: 'remote', url: cloud.url });
    const token = sessionOf(before.local, cloud)!;
    expect(token).toMatch(/^iark_s_/);
    expect(sessionOf(before.session, cloud)).toBeUndefined();

    // crea un proyecto y guarda en él el documento actual
    await createProject(page, 'Nube');
    await expect(dialog(page).getByTestId('project-role-detail')).toHaveText('Tu rol: administrador'); // quien lo crea lo administra
    await dialog(page).getByRole('button', { name: /Guardar en «Nube»/ }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(saveStatus(page)).toHaveText('Guardado en «Nube» · servidor');
    await page.getByRole('tab', { name: 'Vista SVG' }).click();
    await edit(page, 'Hecho por Ana');
    await expect(saveStatus(page)).toHaveAttribute('data-save', 'saved', { timeout: 15000 });
    await expect.poll(() => onDisk(cloud)).toEqual(['Hecho por Ana']);
    expect((await projectsOf(cloud, token)).map((p) => [p.name, p.role])).toEqual([['Nube', 'admin']]);

    // otra persona, en otro navegador, entra con su cuenta y no ve nada de lo de Ana
    const other = await anotherPerson(browser, origin);
    await open(other);
    await logIn(other, cloud, BETO);
    await other.getByRole('button', { name: 'Proyectos…' }).click();
    await expect(dialog(other).getByText('Aún no hay proyectos')).toBeVisible();
    await expect(dialog(other).getByText('Nube')).toHaveCount(0);
    const betoToken = sessionOf((await stored(other)).local, cloud)!;
    expect(betoToken).toMatch(/^iark_s_/);
    expect(betoToken).not.toBe(token);
    expect(await projectsOf(cloud, betoToken)).toEqual([]);
    const foreign = await fetch(`${cloud.url}/api/projects/${(await projectsOf(cloud, token))[0].id}`, { headers: { Authorization: `Bearer ${betoToken}` } });
    expect(foreign.status).toBe(404); // el proyecto de otra persona ni siquiera se confirma que exista
    await other.context().close();

    // Ana cierra sesión: el navegador olvida el token y el servidor deja de aceptarlo aunque alguien lo hubiera copiado
    await page.getByRole('button', { name: 'Proyectos…' }).click();
    await storage(page).getByRole('button', { name: 'Cambiar…' }).click();
    await Promise.all([page.waitForEvent('load'), storage(page).getByTestId('storage-logout').click()]); // la página se recarga ya sin la sesión
    await expect(page.getByTestId('project-bar')).toBeVisible({ timeout: 20000 });
    await page.getByRole('button', { name: 'Proyectos…' }).click();
    await expect(storage(page).getByTestId('storage-summary')).toHaveText('Este navegador');
    await expect(storage(page).getByTestId('storage-account')).toHaveCount(0);
    const after = await stored(page);
    expect(JSON.parse(after.local[BACKEND_KEY])).toEqual({ kind: 'local', url: cloud.url }); // vuelve a «Este navegador» y solo recuerda la dirección (no es secreta)
    expect(sessionOf(after.local, cloud)).toBeUndefined();
    expect(sessionOf(after.session, cloud)).toBeUndefined();
    const old = await fetch(`${cloud.url}/api/projects`, { headers: { Authorization: `Bearer ${token}` } });
    expect(old.status).toBe(401);
    expect(cloud.github.revoked).toHaveLength(2); // el token de GitHub se revocó en cada inicio de sesión: IArk no conserva acceso
    expect(errors).toEqual([]);
  });

  test('con las cuentas en SQLite (--accounts-store sqlite): iniciar sesión, crear y guardar un proyecto, y tras reiniciar el servicio la misma sesión sigue vigente con todo', async ({ page, start }) => {
    const cloud = await start({ signup: 'open', store: 'sqlite' });
    expect(cloud.accounts).toMatch(/cuentas\.db$/);
    const errors = await open(page);
    await logIn(page, cloud, ANA);
    await expect(page.locator('.wb-toast')).toContainText('Sesión iniciada como Ana Pérez (@ana-dev)');
    const token = sessionOf((await stored(page)).local, cloud)!;
    expect(token).toMatch(/^iark_s_/);

    await page.getByRole('button', { name: 'Proyectos…' }).click();
    await createProject(page, 'En SQLite');
    await dialog(page).getByRole('button', { name: /Guardar en «En SQLite»/ }).click();
    await expect(dialog(page)).toHaveCount(0);
    await page.getByRole('tab', { name: 'Vista SVG' }).click();
    await edit(page, 'Guardado con SQLite');
    await expect(saveStatus(page)).toHaveAttribute('data-save', 'saved', { timeout: 15000 });
    await expect.poll(() => onDisk(cloud)).toEqual(['Guardado con SQLite']);

    // las cuentas están en una base con modo 0600 (y del token de sesión solo se guardó su hash)
    expect(statSync(cloud.accounts).mode & 0o777).toBe(0o600);
    expect(existsSync(cloud.accounts.replace(/\.db$/, '.json'))).toBe(false);
    await expect.poll(() => readFileSync(cloud.accounts).includes(Buffer.from(token))).toBe(false);

    // el servicio se reinicia: la sesión de la página (su token) sigue valiendo y el proyecto sigue siendo de Ana, como administradora
    await cloud.restart();
    expect((await projectsOf(cloud, token)).map((p) => [p.name, p.role])).toEqual([['En SQLite', 'admin']]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('project-bar')).toBeVisible({ timeout: 20000 });
    await page.getByRole('button', { name: 'Proyectos…' }).click();
    await expect(storage(page).getByTestId('storage-status')).toHaveText('Conectado');
    await expect(dialog(page).getByRole('heading', { name: 'En SQLite' })).toBeVisible();
    expect(errors).toEqual([]);

    // una persona que no entró nunca no se cuela por el reinicio: sin sesión, 401
    expect((await fetch(`${cloud.url}/api/projects`, { headers: { Authorization: 'Bearer iark_s_inventado' } })).status).toBe(401);
  });

  test('una sesión cerrada desde otro sitio: el guardado avisa, conserva el texto y «Iniciar sesión» la retoma sin perder lo ya guardado', async ({ page, start }) => {
    const cloud = await start({ signup: 'open' });
    const errors = await open(page);
    await logIn(page, cloud, ANA);
    await page.getByRole('button', { name: 'Proyectos…' }).click();
    await createProject(page, 'Caduca');
    await dialog(page).getByRole('button', { name: /Guardar en «Caduca»/ }).click();
    await expect(dialog(page)).toHaveCount(0);
    await page.getByRole('tab', { name: 'Vista SVG' }).click();
    await edit(page, 'Antes de caducar');
    await expect(saveStatus(page)).toHaveAttribute('data-save', 'saved', { timeout: 15000 });
    await expect.poll(() => onDisk(cloud)).toEqual(['Antes de caducar']);

    // la sesión deja de valer (se cerró desde otro equipo, o caducó): lo que se escribe después no se puede guardar, pero no se pierde de la pantalla
    const token = sessionOf((await stored(page)).local, cloud)!;
    expect((await fetch(`${cloud.url}/api/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status).toBeLessThan(300);
    await edit(page, 'Escrito sin sesión');
    await expect(saveStatus(page)).toContainText('Tu sesión caducó', { timeout: 15000 });
    await expect(page.getByTestId('reconnect')).toHaveText('Iniciar sesión'); // no «Cambiar de token»: aquí no hay token que cambiar
    expect(JSON.parse(await editor(page).inputValue()).workspace.name).toBe('Escrito sin sesión');
    expect(onDisk(cloud)).toEqual(['Antes de caducar']);

    // volver a entrar recarga la página: como lo escrito no se puede guardar, antes pregunta (y «Cancelar» lo conserva)
    cloud.signInAs(ANA);
    await page.getByTestId('reconnect').click();
    await expect(storage(page).getByTestId('storage-expired')).toContainText('Tu sesión caducó');
    await expect(storage(page).getByTestId('storage-status')).toHaveText('Sesión caducada');
    await storage(page).getByRole('button', { name: 'Iniciar sesión con GitHub' }).click();
    await expect(storage(page).getByTestId('storage-loss')).toBeVisible();
    await storage(page).getByTestId('storage-loss').getByRole('button', { name: 'Cancelar' }).click();
    await expect(storage(page).getByTestId('storage-loss')).toHaveCount(0);
    expect(JSON.parse(await editor(page).inputValue()).workspace.name).toBe('Escrito sin sesión');

    await storage(page).getByRole('button', { name: 'Iniciar sesión con GitHub' }).click();
    await Promise.all([page.waitForEvent('load'), storage(page).getByTestId('storage-loss').getByRole('button', { name: 'Seguir y descartarlos' }).click()]);
    await expect(page.locator('.wb-toast')).toContainText('Sesión iniciada como Ana Pérez (@ana-dev)');
    await page.getByRole('button', { name: 'Proyectos…' }).click();
    await expect(storage(page).getByTestId('storage-status')).toHaveText('Conectado');
    await expect(dialog(page).getByRole('button', { name: /^Caduca/ })).toBeVisible(); // la misma cuenta: los mismos proyectos
    expect(onDisk(cloud)).toEqual(['Antes de caducar']);
    expect(errors).toEqual([]);
  });

  test('el editor C4 también termina el inicio de sesión al arrancar: avisa, guarda un proyecto en el servidor y cierra sesión', async ({ page, start }) => {
    const cloud = await start({ signup: 'open' });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openEditor(page);
    cloud.signInAs(ANA);
    await page.getByText('Archivo', { exact: true }).click();
    await page.getByText('Proyectos…').click();
    await expect(dialog(page)).toBeVisible();
    await storage(page).getByRole('button', { name: 'Conectar a un servidor…' }).click();
    await storage(page).getByLabel('Dirección del servidor').fill(cloud.url);
    await Promise.all([page.waitForEvent('load'), storage(page).getByRole('button', { name: 'Iniciar sesión con GitHub' }).click()]);
    await c4Ready(page);
    await expect(page.getByText(`Sesión iniciada como Ana Pérez (@ana-dev) en ${host(cloud)}`)).toBeVisible();
    expect(new URL(page.url()).hash).toBe('');

    await page.getByText('Archivo', { exact: true }).click();
    await page.getByText('Proyectos…').click();
    await createProject(page, 'Banca C4');
    await expect(dialog(page).getByTestId('project-role-detail')).toHaveText('Tu rol: administrador');
    await dialog(page).getByRole('button', { name: /Guardar en «Banca C4»/ }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(saveStatus(page)).toContainText('Guardado en «Banca C4»');
    await expect.poll(() => onDisk(cloud).length).toBe(1);

    await page.getByText('Archivo', { exact: true }).click();
    await page.getByText('Proyectos…').click();
    await storage(page).getByRole('button', { name: 'Cambiar…' }).click();
    await expect(storage(page).getByTestId('storage-account-login')).toHaveText('@ana-dev');
    await Promise.all([page.waitForEvent('load'), storage(page).getByTestId('storage-logout').click()]);
    await c4Ready(page);
    await page.getByText('Archivo', { exact: true }).click();
    await page.getByText('Proyectos…').click();
    await expect(storage(page).getByTestId('storage-summary')).toHaveText('Este navegador');
    expect(errors).toEqual([]);
  });

  test('sin «Mantener la sesión en este equipo» el token solo vive en la pestaña y sobrevive a recargar', async ({ page, start }) => {
    const cloud = await start({ signup: 'open' });
    await open(page);
    await logIn(page, cloud, ANA, false);
    const first = await stored(page);
    expect(sessionOf(first.session, cloud)).toMatch(/^iark_s_/);
    expect(sessionOf(first.local, cloud)).toBeUndefined();

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('project-bar')).toBeVisible({ timeout: 20000 });
    await page.getByRole('button', { name: 'Proyectos…' }).click();
    await expect(storage(page).getByTestId('storage-summary')).toContainText(`Servidor: ${host(cloud)}`);
    await expect(storage(page).getByTestId('storage-status')).toHaveText('Conectado');
  });

  test('una instancia solo por invitación: quien no está invitado lo ve claro; quien no acepta en GitHub, también; y puede volver a intentarlo', async ({ page, start }) => {
    const cloud = await start({ signup: 'invite', admins: [ROOT] });
    await open(page);
    await logIn(page, cloud, BETO);

    // el aviso se queda en «Dónde se guardan» (abierto solo) hasta que se descarta, y no se guardó ningún servidor ni sesión
    const notice = dialog(page).getByTestId('storage-login-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute('data-reason', 'not_invited');
    await expect(notice).toContainText('Esta instancia es solo por invitación');
    await expect(storage(page).getByTestId('storage-summary')).toHaveText('Este navegador');
    const none = await stored(page);
    expect(none.local[BACKEND_KEY]).toBeUndefined();
    expect(Object.keys(none.local).filter((key) => key.startsWith('iark.projects.token:'))).toEqual([]);
    expect(new URL(page.url()).hash).toBe('');

    // alguien que no acepta en GitHub
    await notice.getByRole('button', { name: 'Descartar aviso' }).click();
    await expect(notice).toHaveCount(0);
    cloud.github.deny();
    await storage(page).getByLabel('Dirección del servidor').fill(cloud.url);
    await expect(storage(page).getByTestId('storage-invite-only')).toBeVisible(); // la instancia lo anuncia antes de intentarlo
    await Promise.all([page.waitForEvent('load'), storage(page).getByRole('button', { name: 'Iniciar sesión con GitHub' }).click()]);
    await expect(dialog(page).getByTestId('storage-login-notice')).toHaveAttribute('data-reason', 'access_denied', { timeout: 20000 });
    await expect(dialog(page).getByTestId('storage-login-notice')).toContainText('No aceptaste el acceso');

    // y quien administra la instancia entra sin problema (reintento desde el mismo panel)
    cloud.signInAs(ROOT);
    await storage(page).getByLabel('Dirección del servidor').fill(cloud.url);
    await Promise.all([page.waitForEvent('load'), storage(page).getByRole('button', { name: 'Iniciar sesión con GitHub' }).click()]);
    await expect(page.locator('.wb-toast')).toContainText('Sesión iniciada como Admin de la instancia (@root-admin)');
    await page.getByRole('button', { name: 'Proyectos…' }).click();
    await storage(page).getByRole('button', { name: 'Cambiar…' }).click();
    await expect(storage(page).getByTestId('storage-account')).toContainText('Rol en la instancia: administrador de la instancia');
  });

  test('compartir un proyecto: la persona invitada lo tiene al entrar con su cuenta, con su rol, y puede salir de él', async ({ page, browser, origin, start }) => {
    const cloud = await start({ signup: 'invite', admins: [ROOT] });
    await open(page);
    await logIn(page, cloud, ROOT);
    await page.getByRole('button', { name: 'Proyectos…' }).click();
    await createProject(page, 'Compartido');

    // quien administra el proyecto da acceso a alguien que todavía no ha entrado: queda pendiente (y así puede entrar a una instancia por invitación)
    await dialog(page).getByTestId('share-project').click();
    const share = page.getByTestId('share-dialog');
    await expect(share.locator('li[data-login="root-admin"]')).toContainText('tú');
    await share.getByLabel('Usuario de GitHub').fill('@Beto-Dev');
    await share.getByLabel('Rol de la persona nueva').selectOption('editor');
    await share.getByRole('button', { name: 'Dar acceso' }).click();
    await expect(share.getByTestId('share-note')).toContainText('lo tendrá en cuanto entre');
    await expect(share.locator('li[data-login="Beto-Dev"]')).toHaveAttribute('data-pending', 'true'); // mientras está pendiente se muestra como se escribió
    await share.getByRole('button', { name: 'Cerrar' }).click();
    await expect(share).toHaveCount(0);

    // Beto entra con su cuenta de GitHub: ve el proyecto con el rol de editor, sin «Compartir…»
    const other = await anotherPerson(browser, origin);
    await open(other);
    await logIn(other, cloud, BETO);
    await other.getByRole('button', { name: 'Proyectos…' }).click();
    await dialog(other).getByRole('button', { name: /^Compartido/ }).click();
    await expect(dialog(other).getByTestId('project-role-detail')).toHaveText('Tu rol: editor');
    await expect(dialog(other).getByTestId('share-project')).toHaveCount(0);
    await expect(dialog(other).getByTestId('leave-project')).toBeVisible();

    // quien administra ve que ya no está pendiente (la cuenta de GitHub es la misma aunque se escribiera con otras mayúsculas) y le cambia el rol a lector
    await dialog(page).getByTestId('share-project').click();
    await expect(share.locator('li[data-login="beto-dev"]')).toBeVisible();
    await expect(share.locator('li[data-login="beto-dev"]')).not.toHaveAttribute('data-pending', 'true');
    await expect(share.locator('li[data-login="Beto-Dev"]')).toHaveCount(0);
    await share.getByLabel('Rol de @beto-dev').selectOption('viewer');
    await expect(share.getByTestId('share-note')).toContainText('@beto-dev ahora tiene el rol de lector');
    await expect(share.locator('li[data-login="beto-dev"]')).toHaveAttribute('data-role', 'viewer');
    await share.getByRole('button', { name: 'Cerrar' }).click();

    // Beto recarga: ahora es lector, no puede cambiar nada y se va del proyecto por su cuenta
    await other.reload({ waitUntil: 'domcontentloaded' });
    await expect(other.getByTestId('project-bar')).toBeVisible({ timeout: 20000 });
    await other.getByRole('button', { name: 'Proyectos…' }).click();
    await dialog(other).getByRole('button', { name: /^Compartido/ }).click();
    await expect(dialog(other).getByTestId('project-role-detail')).toHaveText('Tu rol: lector');
    await expect(dialog(other).getByTestId('project-readonly')).toBeVisible();
    await dialog(other).getByTestId('leave-project').click();
    await dialog(other).getByRole('button', { name: 'Sí, salir' }).click();
    await expect(dialog(other).getByText('Aún no hay proyectos')).toBeVisible();
    const betoToken = sessionOf((await stored(other)).local, cloud)!;
    expect(await projectsOf(cloud, betoToken)).toEqual([]);
    await other.context().close();

    // el proyecto sigue siendo de quien lo administra, ahora sin Beto
    await dialog(page).getByTestId('share-project').click();
    await expect(share.locator('li[data-login="root-admin"]')).toBeVisible();
    await expect(share.locator('li[data-login="beto-dev"]')).toHaveCount(0);
  });
});
