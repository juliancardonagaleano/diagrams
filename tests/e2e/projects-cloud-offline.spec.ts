import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test as base, type BrowserContext, type Page } from '@playwright/test';
import { openEditor } from './canvas-helpers';
import { startCloudServer, type CloudServer } from './cloud-server';

/**
 * Trabajo sin conexión con los proyectos en un servidor: contra un `iark serve --tokens` de verdad (que cada prueba arranca y para) y Chromium
 * real, con `context.setOffline(true)` para cortar la red de la pestaña. Se comprueba que lo escrito sin red queda en este navegador, se avisa
 * («Sin conexión: N cambios pendientes»), sobrevive a recargar y llega solo al servidor al volver la conexión; que si otra persona cambió el diagrama
 * mientras tanto no se pisa nada y hay tres salidas (la del servidor, la mía, la mía como diagrama nuevo); que un token rechazado no se
 * reintenta en bucle; y que la cola de este navegador no guarda el token.
 */
const example = (file: string): string => readFileSync(new URL(`../../examples/${file}`, import.meta.url), 'utf8');

const PEOPLE = [
  { name: 'ana', role: 'editor' as const },
  { name: 'beto', role: 'editor' as const },
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

const saveStatus = (page: Page) => page.getByTestId('save-status');
const editor = (page: Page) => page.getByLabel('Documento JSON');
const dialog = (page: Page) => page.getByTestId('projects-dialog');
const CLEAN = 'Guardado en «Tienda» · servidor';

async function api(server: CloudServer, token: string, method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${server.url}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.ok, `${method} ${path} → ${response.status}`).toBe(true);
  return response.json();
}

async function seed(server: CloudServer): Promise<{ projectId: string; diagramId: string }> {
  const created = await api(server, server.tokens.root, 'POST', '/api/projects', { name: 'Tienda' });
  const meta = await api(server, server.tokens.root, 'POST', `/api/projects/${created.id}/diagrams`, { module: 'data', name: 'Ventas', text: example('ventas-datos.json') });
  return { projectId: created.id, diagramId: meta.id };
}

/** Los diagramas (en disco) de un proyecto, leídos de la carpeta de trabajo del servidor: la fuente de verdad. */
function onDisk(server: CloudServer, project: string): Array<{ file: string; text: string }> {
  const dir = join(server.workspace, project);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.[a-z0-9-]+\.json$/.test(f) && f !== 'project.json')
    .map((file) => ({ file, text: readFileSync(join(dir, file), 'utf8') }));
}
const names = (server: CloudServer, project: string): string[] => onDisk(server, project).map((d) => JSON.parse(d.text).workspace.name as string);

async function preconnect(context: BrowserContext, server: CloudServer, person: 'ana' | 'beto' | 'root'): Promise<void> {
  await context.addInitScript(
    ([url, secret]) => {
      localStorage.setItem('iark.projects.backend', JSON.stringify({ kind: 'remote', url }));
      sessionStorage.setItem(`iark.projects.token:${url}`, secret);
    },
    [server.url, server.tokens[person]] as const,
  );
}

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`/modulos.html?${query}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('project-bar')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('editor-status')).toContainText('Válido', { timeout: 20000 });
  await expect(saveStatus(page)).toHaveText(CLEAN, { timeout: 20000 });
}

async function showEditor(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Vista SVG' }).click();
  await expect(editor(page)).toBeVisible();
}

/** Cambia el nombre del espacio de trabajo desde el editor de texto (lo que dispara el autoguardado). */
async function rename(page: Page, name: string): Promise<void> {
  const doc = JSON.parse(await editor(page).inputValue());
  doc.workspace.name = name;
  await editor(page).fill(JSON.stringify(doc, null, 2));
}

/** Ni la página ni la barra se desbordan en horizontal. */
async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

/** Las filas de la cola de este navegador, como texto (para comprobar qué guarda). */
async function queueRows(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const opening = indexedDB.open('iark-offline');
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
          const db = opening.result;
          if (!db.objectStoreNames.contains('pending')) {
            db.close();
            resolve('[]');
            return;
          }
          const all = db.transaction('pending', 'readonly').objectStore('pending').getAll();
          all.onerror = () => reject(all.error);
          all.onsuccess = () => {
            db.close();
            resolve(JSON.stringify(all.result));
          };
        };
      }),
  );
}

test.describe('trabajo sin conexión (servidor propio)', () => {
  test('lo escrito sin red se avisa, queda en este navegador y llega solo al servidor al volver la conexión', async ({ page, server }) => {
    const { projectId, diagramId } = await seed(server);
    await preconnect(page.context(), server, 'ana');
    await open(page, `module=data&project=${projectId}&diagram=${diagramId}`);
    await showEditor(page);

    await page.context().setOffline(true);
    await rename(page, 'Escrito sin red');
    await expect(saveStatus(page)).toHaveText('Sin conexión: 1 cambio pendiente', { timeout: 15000 });
    await expect(saveStatus(page)).toHaveAttribute('role', 'status');
    await expect(saveStatus(page)).toHaveAttribute('data-save', 'offline');
    await expect(page.getByRole('button', { name: 'Reintentar ahora' })).toBeVisible();
    expect(names(server, projectId)).not.toContain('Escrito sin red'); // todavía no llegó

    // otro cambio sobre el mismo diagrama sigue siendo UN solo pendiente (se guarda solo el último estado)
    await rename(page, 'Escrito sin red, dos');
    await expect(saveStatus(page)).toHaveText('Sin conexión: 1 cambio pendiente');

    await page.context().setOffline(false);
    await expect(saveStatus(page)).toHaveText(CLEAN, { timeout: 30000 });
    await expect.poll(() => names(server, projectId)).toEqual(['Escrito sin red, dos']);
    await expect(page.getByRole('button', { name: 'Reintentar ahora' })).toHaveCount(0);
    expect(await queueRows(page)).toBe('[]'); // enviado: no queda nada en la cola
  });

  test('lo pendiente sobrevive a recargar la página y se envía solo al volver a abrir con conexión; la cola no guarda el token', async ({ page, server }) => {
    const { projectId, diagramId } = await seed(server);
    await preconnect(page.context(), server, 'ana');
    await open(page, `module=data&project=${projectId}&diagram=${diagramId}`);
    await showEditor(page);

    // el servidor deja de contestar (solo a esta pestaña): así la página puede recargarse
    await page.route(`${server.url}/api/**`, (route) => route.abort('connectionrefused'));
    await rename(page, 'Escrito antes de recargar');
    await expect(saveStatus(page)).toHaveText('Sin conexión: 1 cambio pendiente', { timeout: 15000 });
    const rows = await queueRows(page);
    expect(JSON.parse(rows)).toHaveLength(1);
    expect(rows).toContain('Escrito antes de recargar');
    expect(rows).not.toContain(server.tokens.ana); // el token nunca va a la cola

    // recargar no pide confirmar (no se pierde nada) y, sin red, sigue diciendo que hay un cambio pendiente
    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.type());
      void d.dismiss();
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    expect(dialogs).toEqual([]);
    await expect(page.getByTestId('project-bar')).toBeVisible({ timeout: 20000 });
    await expect(saveStatus(page)).toContainText('Sin conexión: 1 cambio pendiente', { timeout: 20000 });
    expect(names(server, projectId)).not.toContain('Escrito antes de recargar');

    // vuelve el servidor: se envía solo, sin tocar nada
    await page.unroute(`${server.url}/api/**`);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => names(server, projectId), { timeout: 30000 }).toEqual(['Escrito antes de recargar']);
    await expect.poll(() => queueRows(page)).toBe('[]');
    // (abrir un proyecto necesita al servidor: la página que arrancó sin él no lo reabre sola; al recargar con conexión, sí)
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(saveStatus(page)).toHaveText(CLEAN, { timeout: 20000 });
    await showEditor(page);
    expect(JSON.parse(await editor(page).inputValue()).workspace.name).toBe('Escrito antes de recargar');
  });

  test('en una pantalla estrecha (≤700 px) el indicador cabe, la página no se desborda y el estado se anuncia como «status»', async ({ page, server }) => {
    const { projectId, diagramId } = await seed(server);
    await page.setViewportSize({ width: 390, height: 800 });
    await preconnect(page.context(), server, 'ana');
    await open(page, `module=data&project=${projectId}&diagram=${diagramId}`);
    await showEditor(page);
    await noHorizontalScroll(page);
    const before = await page.getByTestId('project-bar').boundingBox();

    await page.context().setOffline(true);
    await rename(page, 'Sin red en móvil');
    await expect(saveStatus(page)).toHaveText('Sin conexión: 1 cambio pendiente', { timeout: 15000 });
    await expect(page.getByRole('button', { name: 'Reintentar ahora' })).toBeVisible();
    await noHorizontalScroll(page);
    const after = await page.getByTestId('project-bar').boundingBox();
    expect(after!.width).toBeLessThanOrEqual(390);
    expect(after!.x).toBeGreaterThanOrEqual(0);
    expect(before!.x + before!.width).toBeLessThanOrEqual(390);

    // el botón se maneja con el teclado
    await page.getByRole('button', { name: 'Reintentar ahora' }).focus();
    await expect(page.getByRole('button', { name: 'Reintentar ahora' })).toBeFocused();
    await page.context().setOffline(false);
    await page.keyboard.press('Enter');
    await expect(saveStatus(page)).toHaveText(CLEAN, { timeout: 30000 });
    await noHorizontalScroll(page);
  });

  test('un token que el servidor rechaza no se reintenta en bucle: ni foco, ni red, ni tiempo', async ({ page, server }) => {
    const { projectId, diagramId } = await seed(server);
    await preconnect(page.context(), server, 'ana');
    await open(page, `module=data&project=${projectId}&diagram=${diagramId}`);
    await showEditor(page);

    const puts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PUT') puts.push(request.url());
    });
    server.revoke('ana');
    await rename(page, 'Con el token revocado');
    await expect(saveStatus(page)).toContainText('El servidor no aceptó el token', { timeout: 15000 });
    expect(puts).toHaveLength(1);

    for (let i = 0; i < 4; i += 1) {
      await page.evaluate(() => {
        window.dispatchEvent(new Event('online'));
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForTimeout(700);
    }
    expect(puts).toHaveLength(1); // ni uno más: cada 401 cuenta para el freno del servidor
    expect(names(server, projectId)).not.toContain('Con el token revocado');
    expect(await queueRows(page)).toContain('Con el token revocado'); // y lo escrito no se perdió
  });

  test.describe('si otra persona cambió el diagrama mientras no había conexión', () => {
    /** Ana edita sin red; Beto (otra sesión) guarda el mismo diagrama; Ana recupera la red y ve el conflicto, sin que se haya pisado nada. */
    async function conflict(page: Page, server: CloudServer, browser: import('@playwright/test').Browser): Promise<{ projectId: string; diagramId: string }> {
      const { projectId, diagramId } = await seed(server);
      await preconnect(page.context(), server, 'ana');
      await open(page, `module=data&project=${projectId}&diagram=${diagramId}`);
      await showEditor(page);
      await page.context().setOffline(true);
      await rename(page, 'Lo de Ana sin red');
      await expect(saveStatus(page)).toHaveText('Sin conexión: 1 cambio pendiente', { timeout: 15000 });

      const second = await browser.newContext();
      try {
        await preconnect(second, server, 'beto');
        const other = await second.newPage();
        await open(other, `module=data&project=${projectId}&diagram=${diagramId}`);
        await showEditor(other);
        await rename(other, 'Lo de Beto');
        await expect(saveStatus(other)).toHaveAttribute('data-save', 'saved', { timeout: 15000 });
      } finally {
        await second.close();
      }
      await expect.poll(() => names(server, projectId)).toEqual(['Lo de Beto']);

      await page.context().setOffline(false);
      await expect(saveStatus(page)).toHaveText('Hay un conflicto que resolver', { timeout: 30000 });
      await expect(saveStatus(page)).toHaveAttribute('data-save', 'conflict');
      expect(names(server, projectId)).toEqual(['Lo de Beto']); // no se pisó nada
      return { projectId, diagramId };
    }

    test('«Guardar la mía como diagrama nuevo» crea la copia y deja la del servidor como estaba', async ({ page, server, browser }) => {
      const { projectId } = await conflict(page, server, browser);
      await page.getByTestId('resolve-conflict').click();
      await expect(page.getByTestId('conflict-dialog')).toBeVisible();
      await page.getByRole('button', { name: 'Guardar la mía como diagrama nuevo' }).click();
      await expect(page.getByLabel('Nombre del diagrama nuevo')).toHaveValue('Ventas (mi versión)');
      await page.getByLabel('Nombre del diagrama nuevo').fill('Ventas de Ana');
      await page.getByRole('button', { name: 'Guardar la copia' }).click();
      await expect(page.getByTestId('conflict-dialog')).toHaveCount(0);
      await expect.poll(() => names(server, projectId).sort()).toEqual(['Lo de Ana sin red', 'Lo de Beto']);
      expect(onDisk(server, projectId)).toHaveLength(2);
      expect(await queueRows(page)).toBe('[]');
    });

    test('«Quedarme con la mía» pide confirmar (cancelar no pisa nada) y luego sustituye a la del servidor', async ({ page, server, browser }) => {
      const { projectId } = await conflict(page, server, browser);
      await page.getByTestId('resolve-conflict').click();
      await expect(page.getByTestId('conflict-dialog')).toBeFocused();
      await page.getByRole('button', { name: 'Quedarme con la mía' }).click();
      await expect(page.getByTestId('conflict-confirm')).toContainText('lo que cambió la otra persona se perderá');
      await page.getByTestId('conflict-confirm').getByRole('button', { name: 'Cancelar' }).click();
      expect(names(server, projectId)).toEqual(['Lo de Beto']);
      await page.getByRole('button', { name: 'Quedarme con la mía' }).click();
      await page.getByRole('button', { name: 'Sí, quedarme con la mía' }).click();
      await expect(saveStatus(page)).toHaveText(CLEAN, { timeout: 20000 });
      await expect.poll(() => names(server, projectId)).toEqual(['Lo de Ana sin red']);
    });

    test('«Quedarme con la del servidor» descarta la mía (con confirmación) y deja la del servidor en el editor', async ({ page, server, browser }) => {
      const { projectId } = await conflict(page, server, browser);
      await page.getByTestId('resolve-conflict').click();
      await page.getByRole('button', { name: 'Quedarme con la del servidor' }).click();
      await page.getByRole('button', { name: 'Sí, quedarme con la del servidor' }).click();
      await expect(saveStatus(page)).toHaveText(CLEAN, { timeout: 20000 });
      expect(JSON.parse(await editor(page).inputValue()).workspace.name).toBe('Lo de Beto');
      expect(names(server, projectId)).toEqual(['Lo de Beto']);
      expect(await queueRows(page)).toBe('[]');
    });

    test('con una pantalla estrecha el cuadro del conflicto cabe y se cierra con Escape devolviendo el foco', async ({ page, server, browser }) => {
      await page.setViewportSize({ width: 390, height: 800 });
      await conflict(page, server, browser);
      await noHorizontalScroll(page);
      const opener = page.getByTestId('resolve-conflict');
      await opener.click();
      const box = await page.locator('.pj-conflict').boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
      await noHorizontalScroll(page);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('conflict-dialog')).toHaveCount(0);
      await expect(opener).toBeFocused();
      await expect(saveStatus(page)).toHaveText('Hay un conflicto que resolver');
    });
  });

  test('editor C4: lo escrito sin red se avisa en el encabezado y llega solo al volver la conexión', async ({ page, server }) => {
    await preconnect(page.context(), server, 'ana');
    await openEditor(page);
    await page.getByText('Archivo', { exact: true }).click();
    await page.getByText('Proyectos…').click();
    await expect(dialog(page)).toBeVisible();
    await dialog(page).getByPlaceholder('Nombre del proyecto').fill('Banca');
    await dialog(page).getByRole('button', { name: 'Crear', exact: true }).click();
    await expect(dialog(page).getByRole('heading', { name: 'Banca' })).toBeVisible();
    await dialog(page).getByRole('button', { name: /Guardar en «Banca»/ }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(saveStatus(page)).toHaveText('Guardado en «Banca» · servidor');

    await page.context().setOffline(true);
    await page.getByRole('button', { name: 'Añadir persona' }).click();
    await expect(page.locator('.react-flow__node')).toHaveCount(5);
    await expect(saveStatus(page)).toHaveText('Sin conexión: 1 cambio pendiente', { timeout: 15000 });
    await expect(saveStatus(page)).toHaveAttribute('role', 'status');
    await expect(page.getByRole('button', { name: 'Reintentar ahora' })).toBeVisible();
    expect(JSON.parse(onDisk(server, 'banca')[0].text).model.elements.length).toBe(13);
    // en una pantalla estrecha (≤700 px) el indicador y el botón caben sin desbordar la página
    await page.setViewportSize({ width: 600, height: 800 });
    await noHorizontalScroll(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.context().setOffline(false);
    await expect(saveStatus(page)).toHaveText('Guardado en «Banca» · servidor', { timeout: 30000 });
    await expect.poll(() => JSON.parse(onDisk(server, 'banca')[0].text).model.elements.length).toBe(14);
  });
});
