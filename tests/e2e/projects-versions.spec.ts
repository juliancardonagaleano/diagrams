import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test as base, type Page } from '@playwright/test';
import { c4Ready, openEditor } from './canvas-helpers';
import { startCloudServer, type CloudServer } from './cloud-server';

/**
 * El historial de versiones en un navegador de verdad contra un `iark serve --workspace <carpeta> --tokens <archivo>` real (cada prueba arranca el suyo,
 * sin coalescencia para que cada guardado sea una versión): ver la lista, comparar con el diagrama actual, restaurar (queda como versión NUEVA y el
 * editor recarga lo restaurado), nombrar una versión, lo que cada rol puede hacer, el historial en disco (`.versiones`) y que el cuadro se aguanta en un
 * móvil sin desbordar la página.
 */
const example = (file: string): string => readFileSync(new URL(`../../examples/${file}`, import.meta.url), 'utf8');
const PEOPLE = [
  { name: 'ana', role: 'editor' as const },
  { name: 'vic', role: 'viewer' as const },
  { name: 'root', role: 'admin' as const },
];

const test = base.extend<{ origin: string; server: CloudServer }>({
  origin: async ({ baseURL }, use) => use(new URL(baseURL!).origin),
  server: async ({ origin }, use) => {
    const server = await startCloudServer({ cors: origin, people: PEOPLE, env: { IARK_VERSIONS_COALESCE: '0' } });
    try {
      await use(server);
    } finally {
      await server.stop();
    }
  },
});

const saveStatus = (page: Page) => page.getByTestId('save-status');
const history = (page: Page) => page.getByRole('dialog', { name: 'Historial de versiones' });
const editor = (page: Page) => page.getByLabel('Documento JSON');
const item = (page: Page, version: number) => history(page).locator(`[data-testid="history-item"][data-version="${version}"]`);

async function api(server: CloudServer, token: string, method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${server.url}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.ok, `${method} ${path} → ${response.status}`).toBe(true);
  return response.json();
}

/** El documento de ventas con otro nombre de espacio de trabajo: cada nombre es una versión distinta. */
const named = (name: string): string => JSON.stringify({ ...JSON.parse(example('ventas-datos.json')), workspace: { name } }, null, 2);

/** Un proyecto con el diagrama «Ventas» guardado tres veces (versiones 1 a 3: «Primera», «Segunda», «Tercera»). */
async function seed(server: CloudServer): Promise<{ projectId: string; diagramId: string }> {
  const token = server.tokens.ana;
  const created = await api(server, token, 'POST', '/api/projects', { name: 'Tienda' });
  const meta = await api(server, token, 'POST', `/api/projects/${created.id}/diagrams`, { module: 'data', name: 'Ventas', text: named('Primera') });
  await api(server, token, 'PUT', `/api/projects/${created.id}/diagrams/${meta.id}`, { text: named('Segunda') });
  await api(server, token, 'PUT', `/api/projects/${created.id}/diagrams/${meta.id}`, { text: named('Tercera') });
  return { projectId: created.id, diagramId: meta.id };
}

/** El navegador ya conectado al servidor con ese token y con el diagrama como último abierto, como si lo hubiera abierto desde el gestor. */
async function preconnect(page: Page, server: CloudServer, token: string, last: { projectId: string; diagramId: string }): Promise<void> {
  await page.context().addInitScript(
    ([url, secret, opened]) => {
      localStorage.setItem('iark.projects.backend', JSON.stringify({ kind: 'remote', url }));
      sessionStorage.setItem(`iark.projects.token:${url}`, secret);
      localStorage.setItem(`iark.projects.last:${url}`, opened);
    },
    [server.url, token, JSON.stringify(last)] as const,
  );
}

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/modulos.html?module=data', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('project-bar')).toBeVisible({ timeout: 20000 });
  await expect(saveStatus(page)).toHaveText('Guardado en «Tienda» · servidor', { timeout: 20000 });
  return errors;
}

async function openHistory(page: Page): Promise<void> {
  await page.getByTestId('history-open').click();
  await expect(history(page)).toBeVisible();
  await expect(history(page).getByTestId('history-item').first()).toBeVisible();
}

async function showEditor(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Vista SVG' }).click();
  await expect(editor(page)).toBeVisible();
}

const workspaceName = async (page: Page): Promise<string> => JSON.parse(await editor(page).inputValue()).workspace.name;

/** Los archivos del historial en disco de ese diagrama: `<proyecto>/.versiones/<diagrama>/`. */
function versionsOnDisk(server: CloudServer, project: string): string[] {
  const dir = join(server.workspace, project, '.versiones');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((d) => readdirSync(join(dir, d)).map((f) => `${d}/${f}`)).sort();
}

test.describe('historial de versiones (servidor propio con tokens)', () => {
  test('la lista, los cambios frente al diagrama actual y restaurar: queda como versión nueva y el editor recarga lo restaurado', async ({ page, server }) => {
    test.setTimeout(90_000);
    const ids = await seed(server);
    await preconnect(page, server, server.tokens.ana, ids);
    const errors = await open(page);
    await showEditor(page);
    expect(await workspaceName(page)).toBe('Tercera');

    await openHistory(page);
    await expect(page.getByTestId('history-count')).toContainText('3 versiones');
    await expect(item(page, 3)).toContainText('Actual');
    await expect(item(page, 3)).toContainText('ana'); // quién guardó: el nombre del token
    // por omisión elige la última versión que difiere del actual y resume qué cambió
    await expect(item(page, 2)).toHaveAttribute('aria-current', 'true');
    await expect(page.getByTestId('history-summary')).toContainText('De la versión 2 al diagrama actual');

    await item(page, 1).click();
    await expect(page.getByTestId('history-summary')).toContainText('De la versión 1 al diagrama actual');
    await page.getByRole('button', { name: 'Restaurar esta versión' }).click();
    await expect(page.getByTestId('history-confirm-restore')).toBeVisible();
    await page.getByRole('button', { name: 'Sí, restaurar' }).click();
    await expect(page.getByTestId('history-note')).toContainText('Versión 1 restaurada: quedó guardada como la versión 4');
    await item(page, 4).click();
    await expect(page.getByTestId('history-detail')).toContainText('Restaurada de la versión 1');
    await expect(page.getByTestId('history-count')).toContainText('4 versiones');

    // el servidor tiene lo restaurado, la versión 3 sigue ahí y el editor lo recargó
    const stored = await api(server, server.tokens.ana, 'GET', `/api/projects/${ids.projectId}/diagrams/${ids.diagramId}`);
    expect(JSON.parse(stored.text).workspace.name).toBe('Primera');
    const old = await api(server, server.tokens.vic, 'GET', `/api/projects/${ids.projectId}/diagrams/${ids.diagramId}/versions/3`);
    expect(JSON.parse(old.text).workspace.name).toBe('Tercera');
    await page.keyboard.press('Escape');
    await expect(history(page)).toHaveCount(0);
    await expect(page.getByTestId('history-open')).toBeFocused();
    expect(await workspaceName(page)).toBe('Primera');
    await expect(saveStatus(page)).toHaveText('Guardado en «Tienda» · servidor');
    // y se deshace restaurando la anterior
    await openHistory(page);
    await item(page, 3).click();
    await page.getByRole('button', { name: 'Restaurar esta versión' }).click();
    await page.getByRole('button', { name: 'Sí, restaurar' }).click();
    await expect(page.getByTestId('history-note')).toContainText('quedó guardada como la versión 5');
    await page.keyboard.press('Escape');
    expect(await workspaceName(page)).toBe('Tercera');
    expect(errors).toEqual([]);
  });

  test('nombrar una versión la marca en la lista y en el servidor, y las versiones quedan en .versiones dentro del proyecto', async ({ page, server }) => {
    const ids = await seed(server);
    await preconnect(page, server, server.tokens.ana, ids);
    await open(page);
    await openHistory(page);
    await item(page, 2).click();
    await page.getByRole('button', { name: 'Nombrar versión' }).click();
    await page.getByRole('textbox', { name: 'Nombre de la versión' }).fill('Antes de la auditoría');
    await page.getByRole('button', { name: 'Guardar nombre' }).click();
    await expect(item(page, 2)).toContainText('Antes de la auditoría');
    const list = await api(server, server.tokens.vic, 'GET', `/api/projects/${ids.projectId}/diagrams/${ids.diagramId}/versions`);
    expect(list.find((v: { id: number }) => v.id === 2)).toMatchObject({ label: 'Antes de la auditoría', savedBy: 'ana' });
    expect(versionsOnDisk(server, ids.projectId)).toContain(`${ids.diagramId}/index.json`);
    expect(versionsOnDisk(server, ids.projectId)).toContain(`${ids.diagramId}/000003.json`);
  });

  test('un visor ve el historial pero no restaura ni nombra; borrar una versión con nombre solo lo hace quien administra', async ({ page, server }) => {
    const ids = await seed(server);
    await api(server, server.tokens.ana, 'PATCH', `/api/projects/${ids.projectId}/diagrams/${ids.diagramId}/versions/1`, { label: 'Hito' });
    await preconnect(page, server, server.tokens.vic, ids);
    await open(page);
    await openHistory(page);
    await item(page, 1).click();
    await expect(page.getByRole('button', { name: 'Restaurar esta versión' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Cambiar el nombre' })).toBeDisabled();
    await expect(page.getByTestId('history-hint')).toContainText('no restaurar ni nombrar versiones');
    // el servidor lo rechaza aunque se pida a mano
    const url = `${server.url}/api/projects/${ids.projectId}/diagrams/${ids.diagramId}/versions`;
    const auth = { Authorization: `Bearer ${server.tokens.vic}`, 'Content-Type': 'application/json' };
    expect((await fetch(`${url}/1/restore`, { method: 'POST', headers: auth, body: '{}' })).status).toBe(403);
    expect((await fetch(`${url}/1`, { method: 'PATCH', headers: auth, body: JSON.stringify({ label: 'x' }) })).status).toBe(403);
    // un editor no borra versiones con nombre; quien administra, sí
    const editorAuth = { ...auth, Authorization: `Bearer ${server.tokens.ana}` };
    expect((await fetch(`${url}/1`, { method: 'DELETE', headers: editorAuth })).status).toBe(403);
    expect((await fetch(`${url}/1`, { method: 'DELETE', headers: { ...auth, Authorization: `Bearer ${server.tokens.root}` } })).status).toBe(200);
  });

  test('a 375 px el cuadro cabe en la pantalla y la página no desborda de lado', async ({ page, server }) => {
    const ids = await seed(server);
    await page.setViewportSize({ width: 375, height: 700 });
    await preconnect(page, server, server.tokens.ana, ids);
    await open(page);
    await openHistory(page);
    const m = await page.evaluate(() => {
      const box = document.querySelector('[role="dialog"]')!.getBoundingClientRect();
      const body = document.body;
      return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, body: body.scrollWidth - body.clientWidth, left: box.left, right: box.right, viewport: window.innerWidth };
    });
    expect(m.page).toBeLessThanOrEqual(0);
    expect(m.body).toBeLessThanOrEqual(0);
    expect(m.left).toBeGreaterThanOrEqual(0);
    expect(m.right).toBeLessThanOrEqual(m.viewport);
    await expect(page.getByRole('button', { name: 'Restaurar esta versión' })).toBeVisible();
  });
});

test.describe('historial de versiones en el editor C4 (proyectos de este navegador)', () => {
  test('nombrar la primera versión, seguir editando y restaurarla: el lienzo vuelve a como estaba', async ({ page }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openEditor(page);
    await page.getByText('Archivo', { exact: true }).click();
    await page.getByText('Proyectos…').click();
    const dialog = page.getByTestId('projects-dialog');
    await dialog.getByPlaceholder('Nombre del proyecto').fill('Banca');
    await dialog.getByRole('button', { name: 'Crear', exact: true }).click();
    await dialog.getByRole('button', { name: /Guardar en «Banca»/ }).click();
    await expect(dialog).toHaveCount(0);
    await expect(saveStatus(page)).toHaveText('Guardado en «Banca»');
    const nodes = page.locator('.react-flow__node');
    const before = await nodes.count();

    // la primera versión se nombra (una versión con nombre no se sustituye al coalescer los guardados siguientes)
    await openHistory(page);
    await expect(page.getByTestId('history-count')).toContainText('1 versión');
    await page.getByRole('button', { name: 'Nombrar versión' }).click();
    await page.getByRole('textbox', { name: 'Nombre de la versión' }).fill('Punto de partida');
    await page.getByRole('button', { name: 'Guardar nombre' }).click();
    await expect(item(page, 1)).toContainText('Punto de partida');
    await page.keyboard.press('Escape');
    await expect(history(page)).toHaveCount(0);

    await page.getByRole('button', { name: 'Añadir persona' }).click();
    await expect(nodes).toHaveCount(before + 1);
    await expect(saveStatus(page)).toHaveAttribute('data-save', 'saved', { timeout: 10000 });

    await openHistory(page);
    await expect(page.getByTestId('history-count')).toContainText('2 versiones');
    await item(page, 1).click();
    await page.getByRole('button', { name: 'Restaurar esta versión' }).click();
    await page.getByRole('button', { name: 'Sí, restaurar' }).click();
    await expect(page.getByTestId('history-note')).toContainText('quedó guardada como la versión 3');
    await page.keyboard.press('Escape');
    await expect(nodes).toHaveCount(before);
    await c4Ready(page);
    expect(errors).toEqual([]);
  });
});
