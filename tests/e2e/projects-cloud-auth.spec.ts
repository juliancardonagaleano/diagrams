import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test as base, type Page } from '@playwright/test';
import { startCloudServer, type CloudServer } from './cloud-server';

/**
 * «Guardar en la nube» con un servidor de varias personas (`iark serve --workspace <carpeta> --tokens <archivo>`): cada persona
 * tiene su token y su rol (visor, editor, administrador). Pruebas contra el CLI real que cada prueba arranca y para: conectar con
 * token desde el gestor (y dónde queda guardado el token), probar la conexión sin token o con uno inválido, un visor que no puede
 * guardar (y cambia a un token de editor sin perder lo escrito) y un token revocado a media sesión.
 */
const example = (file: string): string => readFileSync(new URL(`../../examples/${file}`, import.meta.url), 'utf8');

const PEOPLE = [
  { name: 'ana', role: 'editor' as const },
  { name: 'beto', role: 'editor' as const },
  { name: 'vic', role: 'viewer' as const },
  { name: 'root', role: 'admin' as const },
];

const test = base.extend<{ origin: string; server: CloudServer }>({
  origin: async ({ baseURL }, use) => use(new URL(baseURL!).origin),
  server: async ({ origin }, use) => {
    const server = await startCloudServer({ cors: origin, people: PEOPLE });
    try {
      await use(server);
    } finally {
      await server.stop();
    }
  },
});

const host = (server: CloudServer): string => new URL(server.url).host;
const dialog = (page: Page) => page.getByTestId('projects-dialog');
const saveStatus = (page: Page) => page.getByTestId('save-status');
const storage = (page: Page) => dialog(page).getByTestId('storage-panel');
const editor = (page: Page) => page.getByLabel('Documento JSON');

async function api(server: CloudServer, token: string, method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${server.url}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.ok, `${method} ${path} → ${response.status}`).toBe(true);
  return response.json();
}

/** Un proyecto con un diagrama de datos ya guardado en el servidor (lo que otra persona habría dejado). */
async function seed(server: CloudServer): Promise<{ projectId: string; diagramId: string }> {
  const created = await api(server, server.tokens.root, 'POST', '/api/projects', { name: 'Tienda' });
  const meta = await api(server, server.tokens.root, 'POST', `/api/projects/${created.id}/diagrams`, { module: 'data', name: 'Ventas', text: example('ventas-datos.json') });
  return { projectId: created.id, diagramId: meta.id };
}

/** La configuración del navegador apunta al servidor con ese token en esta pestaña, como si ya se hubiera conectado desde el gestor. */
async function preconnect(page: Page, server: CloudServer, token: string): Promise<void> {
  await page.context().addInitScript(
    ([url, secret]) => {
      localStorage.setItem('iark.projects.backend', JSON.stringify({ kind: 'remote', url }));
      sessionStorage.setItem(`iark.projects.token:${url}`, secret);
    },
    [server.url, token] as const,
  );
}

async function open(page: Page, query = 'module=data'): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/modulos.html?bank=1${query ? `&${query}` : ''}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('project-bar')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('editor-status')).toContainText('Válido', { timeout: 20000 });
  return errors;
}

async function showEditor(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Vista SVG' }).click();
  await expect(editor(page)).toBeVisible();
}

/** Abre el gestor y deja el formulario de conexión con la dirección y el token escritos. */
async function fillConnection(page: Page, server: CloudServer, token?: string): Promise<void> {
  await page.getByRole('button', { name: 'Proyectos…' }).click();
  await expect(dialog(page)).toBeVisible();
  await storage(page).getByRole('button', { name: 'Conectar a un servidor…' }).click();
  await storage(page).getByLabel('Dirección del servidor').fill(server.url);
  if (token !== undefined) await storage(page).getByLabel('Token de acceso').fill(token);
}

/** Cambia el nombre del espacio de trabajo en el documento (con el editor de texto visible). */
async function edit(page: Page, name: string): Promise<void> {
  const doc = JSON.parse(await editor(page).inputValue());
  doc.workspace.name = name;
  await editor(page).fill(JSON.stringify(doc, null, 2));
}

/** El diagrama (en disco) del proyecto, leído de la carpeta de trabajo del servidor. */
function onDisk(server: CloudServer, project: string): string[] {
  const dir = join(server.workspace, project);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.[a-z0-9-]+\.json$/.test(f) && f !== 'project.json')
    .map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')).workspace?.name as string);
}

test.describe('proyectos en la nube con varias personas (tokens y roles)', () => {
  test('conectar con un token de editor: dice quién eres, guarda en la carpeta del servidor y el token solo vive en la pestaña', async ({ page, server }) => {
    const errors = await open(page);
    await fillConnection(page, server, server.tokens.ana);
    await storage(page).getByRole('button', { name: 'Probar conexión' }).click();
    await expect(storage(page).getByTestId('storage-test')).toContainText('Eres «ana» (rol editor)');
    await Promise.all([page.waitForEvent('load'), storage(page).getByRole('button', { name: 'Conectar', exact: true }).click()]);
    await expect(page.getByTestId('project-bar')).toBeVisible({ timeout: 20000 });

    await page.getByRole('button', { name: 'Proyectos…' }).click();
    await expect(storage(page).getByTestId('storage-summary')).toContainText(`Servidor: ${host(server)} (ana, editor)`);
    await expect(storage(page).getByTestId('storage-status')).toHaveText('Conectado');
    await dialog(page).getByPlaceholder('Nombre del proyecto').fill('Nube');
    await dialog(page).getByRole('button', { name: 'Crear', exact: true }).click();
    await expect(dialog(page).getByRole('heading', { name: 'Nube' })).toBeVisible();
    await dialog(page).getByRole('button', { name: /Guardar en «Nube»/ }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(saveStatus(page)).toHaveText('Guardado en «Nube» · servidor');

    await showEditor(page);
    await edit(page, 'Con token');
    await expect(saveStatus(page)).toHaveAttribute('data-save', 'saved', { timeout: 15000 });
    await expect.poll(() => onDisk(server, 'nube')).toEqual(['Con token']);

    // sin «Recordar en este equipo» el token queda solo en esta pestaña (sessionStorage), nunca en localStorage
    const stored = await page.evaluate(() => ({ local: JSON.stringify(Object.entries(localStorage)), session: JSON.stringify(Object.entries(sessionStorage)) }));
    expect(stored.local).toContain(server.url);
    expect(stored.local).not.toContain(server.tokens.ana);
    expect(stored.session).toContain(server.tokens.ana);

    // y sobrevive a recargar la pestaña
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(saveStatus(page)).toHaveText('Guardado en «Nube» · servidor', { timeout: 20000 });
    expect(errors).toEqual([]);
  });

  test('«Recordar en este equipo» guarda el token en localStorage y otra pestaña lo usa', async ({ page, server }) => {
    await open(page);
    await fillConnection(page, server, server.tokens.ana);
    await storage(page).getByLabel('Recordar en este equipo').check();
    await Promise.all([page.waitForEvent('load'), storage(page).getByRole('button', { name: 'Conectar', exact: true }).click()]);
    await expect(page.getByTestId('project-bar')).toBeVisible({ timeout: 20000 });
    expect(await page.evaluate(() => JSON.stringify(Object.entries(localStorage)))).toContain(server.tokens.ana);

    const other = await page.context().newPage(); // otra pestaña del mismo navegador: sessionStorage vacío
    await open(other);
    await other.getByRole('button', { name: 'Proyectos…' }).click();
    await expect(storage(other).getByTestId('storage-summary')).toContainText('(ana, editor)');
  });

  test('probar la conexión sin token o con uno inválido lo dice claro y no guarda nada', async ({ page, server }) => {
    await open(page);
    await fillConnection(page, server);
    const result = storage(page).getByTestId('storage-test');
    await storage(page).getByRole('button', { name: 'Probar conexión' }).click();
    await expect(result).toHaveAttribute('data-problem', 'unauthorized', { timeout: 20000 });
    await expect(result).toContainText('no aceptó el token');

    await storage(page).getByLabel('Token de acceso').fill('iark_no_existe');
    await storage(page).getByRole('button', { name: 'Probar conexión' }).click();
    await expect(result).toHaveAttribute('data-problem', 'unauthorized', { timeout: 20000 });
    expect(await page.evaluate(() => localStorage.getItem('iark.projects.backend'))).toBeNull(); // probar no guarda nada

    // «Conectar» con un token inválido tampoco cambia de almacén
    await storage(page).getByRole('button', { name: 'Conectar', exact: true }).click();
    await expect(result).toHaveAttribute('data-problem', 'unauthorized');
    expect(await page.evaluate(() => localStorage.getItem('iark.projects.backend'))).toBeNull();

    // con uno válido, sí
    await storage(page).getByLabel('Token de acceso').fill(server.tokens.vic);
    await storage(page).getByRole('button', { name: 'Probar conexión' }).click();
    await expect(storage(page).getByTestId('storage-test')).toContainText('Eres «vic» (rol viewer)');
  });

  test('un visor ve los proyectos pero no puede guardar: avisa, conserva el texto y al cambiar a un token de editor se guarda', async ({ page, server }) => {
    const { projectId, diagramId } = await seed(server);
    await preconnect(page, server, server.tokens.vic);
    await open(page, `project=${projectId}&diagram=${diagramId}`);
    await expect(saveStatus(page)).toHaveText('Guardado en «Tienda» · servidor', { timeout: 20000 });
    await showEditor(page);

    await edit(page, 'Lo que escribió un visor');
    await expect(saveStatus(page)).toContainText('Sin permiso para guardar en el servidor', { timeout: 15000 });
    await expect(saveStatus(page)).toContainText('El rol «viewer» no permite esta operación');
    await expect(page.getByTestId('reconnect')).toHaveText('Cambiar de token');
    expect(JSON.parse(await editor(page).inputValue()).workspace.name).toBe('Lo que escribió un visor'); // el texto sigue ahí
    expect(onDisk(server, projectId)).not.toContain('Lo que escribió un visor');

    await page.getByTestId('reconnect').click();
    await expect(storage(page).getByTestId('storage-forbidden')).toContainText('«viewer»');
    await expect(storage(page).getByTestId('storage-rejected')).toHaveCount(0); // no es un token rechazado
    await storage(page).getByLabel('Token de acceso').fill(server.tokens.ana);
    await storage(page).getByRole('button', { name: 'Usar este token' }).click();
    await expect(storage(page).getByTestId('storage-message')).toContainText('Token actualizado');
    await expect(storage(page).getByTestId('storage-summary')).toContainText('(ana, editor)');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(saveStatus(page)).toHaveText('Guardado en «Tienda» · servidor', { timeout: 15000 });
    await expect.poll(() => onDisk(server, projectId)).toEqual(['Lo que escribió un visor']);
  });

  test('un token revocado a media sesión: el guardado avisa, conserva el texto y un token nuevo lo retoma sin recargar', async ({ page, server }) => {
    const { projectId, diagramId } = await seed(server);
    await preconnect(page, server, server.tokens.ana);
    await open(page, `project=${projectId}&diagram=${diagramId}`);
    await expect(saveStatus(page)).toHaveText('Guardado en «Tienda» · servidor', { timeout: 20000 });
    await showEditor(page);

    server.revoke('ana');
    await edit(page, 'Escrito con el token revocado');
    await expect(saveStatus(page)).toContainText('El servidor no aceptó el token', { timeout: 15000 });
    await expect(page.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
    expect(JSON.parse(await editor(page).inputValue()).workspace.name).toBe('Escrito con el token revocado');
    expect(onDisk(server, projectId)).not.toContain('Escrito con el token revocado');

    await page.getByTestId('reconnect').click();
    await expect(storage(page).getByTestId('storage-rejected')).toBeVisible();
    await expect(storage(page).getByTestId('storage-status')).toHaveText('Token rechazado');
    await storage(page).getByLabel('Token de acceso').fill(server.tokens.beto);
    await storage(page).getByRole('button', { name: 'Usar este token' }).click();
    await expect(storage(page).getByTestId('storage-message')).toContainText('Token actualizado');
    await expect(storage(page).getByTestId('storage-summary')).toContainText('(beto, editor)');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(saveStatus(page)).toHaveText('Guardado en «Tienda» · servidor', { timeout: 15000 });
    await expect.poll(() => onDisk(server, projectId)).toEqual(['Escrito con el token revocado']);
  });
});
