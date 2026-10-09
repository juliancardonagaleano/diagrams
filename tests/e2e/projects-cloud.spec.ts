import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test as base, type BrowserContext, type Page } from '@playwright/test';
import { c4Ready, openEditor, reloadEditor } from './canvas-helpers';
import { startCloudServer, type CloudServer } from './cloud-server';

/**
 * Guardar en la nube desde el navegador (Chromium real) contra un `iark serve --workspace <carpeta temporal> --cors <origen>`
 * de verdad, que cada prueba arranca y para: conectar desde el gestor, guardar, recargar y recuperar, ver desde una segunda
 * sesión (otro contexto, sin almacenamiento compartido) lo que guardó la primera, el conflicto entre las dos, copiar un
 * proyecto local al servidor, volver a este navegador y los avisos de error (CORS, sin conexión, token rechazado, red caída).
 */
const example = (file: string): string => readFileSync(new URL(`../../examples/${file}`, import.meta.url), 'utf8');

const test = base.extend<{ origin: string; server: CloudServer }>({
  origin: async ({ baseURL }, use) => use(new URL(baseURL!).origin),
  server: async ({ origin }, use) => {
    const server = await startCloudServer({ cors: origin });
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

async function api(server: CloudServer, method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${server.url}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(response.ok, `${method} ${path} → ${response.status}`).toBe(true);
  return response.json();
}

/** Un proyecto con un diagrama de datos ya guardado en el servidor (lo que otra persona habría dejado). */
async function seed(server: CloudServer, project = 'Tienda', diagram = 'Ventas'): Promise<{ projectId: string; diagramId: string }> {
  const created = await api(server, 'POST', '/api/projects', { name: project });
  const meta = await api(server, 'POST', `/api/projects/${created.id}/diagrams`, { module: 'data', name: diagram, text: example('ventas-datos.json') });
  return { projectId: created.id, diagramId: meta.id };
}

/** Deja la configuración del navegador apuntando al servidor, como si ya se hubiera conectado desde el gestor. */
async function preconnect(context: BrowserContext, server: CloudServer, token?: string): Promise<void> {
  await context.addInitScript(
    ([url, secret]) => {
      localStorage.setItem('iark.projects.backend', JSON.stringify({ kind: 'remote', url }));
      if (secret) sessionStorage.setItem(`iark.projects.token:${url}`, secret);
    },
    [server.url, token] as const,
  );
}

async function open(page: Page, query = 'module=data'): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/modulos.html${query ? `?${query}` : ''}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('project-bar')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('editor-status')).toContainText('Válido', { timeout: 20000 });
  return errors;
}

async function showEditor(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Vista SVG' }).click();
  await expect(editor(page)).toBeVisible();
}

/** Abre el gestor, escribe la dirección y conecta (la página se recarga sola). */
async function connect(page: Page, server: CloudServer): Promise<void> {
  await page.getByRole('button', { name: 'Proyectos…' }).click();
  await expect(dialog(page)).toBeVisible();
  await storage(page).getByRole('button', { name: 'Conectar a un servidor…' }).click();
  await storage(page).getByLabel('Dirección del servidor').fill(server.url);
  await storage(page).getByRole('button', { name: 'Probar conexión' }).click();
  await expect(storage(page).getByTestId('storage-test')).toContainText('Conexión correcta');
  await Promise.all([page.waitForEvent('load'), storage(page).getByRole('button', { name: 'Conectar', exact: true }).click()]);
  await expect(page.getByTestId('project-bar')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('editor-status')).toContainText('Válido', { timeout: 20000 });
}

async function createProject(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Proyectos…' }).click();
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByPlaceholder('Nombre del proyecto').fill(name);
  await dialog(page).getByRole('button', { name: 'Crear', exact: true }).click();
  await expect(dialog(page).getByRole('heading', { name })).toBeVisible();
}

/** El diagrama (en disco) del proyecto, leído de la carpeta de trabajo del servidor. */
function onDisk(server: CloudServer, project: string): Array<{ file: string; text: string }> {
  const dir = join(server.workspace, project);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.[a-z0-9-]+\.json$/.test(f) && f !== 'project.json')
    .map((file) => ({ file, text: readFileSync(join(dir, file), 'utf8') }));
}

test.describe('proyectos en la nube (servidor propio)', () => {
  test('conectar desde el gestor, guardar un diagrama, recargar y recuperarlo, y el archivo queda en la carpeta del servidor', async ({ page, server }) => {
    const errors = await open(page);
    await expect(saveStatus(page)).toHaveText('');
    await connect(page, server);

    // tras recargar, el gestor dice que el almacén es el servidor
    await page.getByRole('button', { name: 'Proyectos…' }).click();
    await expect(storage(page).getByTestId('storage-summary')).toContainText(`Servidor: ${host(server)}`);
    await expect(storage(page).getByTestId('storage-status')).toHaveText('Conectado');
    await expect(dialog(page).getByTestId('projects-foot')).toContainText(`Los proyectos se guardan en el servidor ${host(server)}`);

    await dialog(page).getByPlaceholder('Nombre del proyecto').fill('Nube');
    await dialog(page).getByRole('button', { name: 'Crear', exact: true }).click();
    await expect(dialog(page).getByRole('heading', { name: 'Nube' })).toBeVisible();
    await dialog(page).getByRole('button', { name: /Guardar en «Nube»/ }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(saveStatus(page)).toHaveText('Guardado en «Nube» · servidor');

    await showEditor(page);
    const doc = JSON.parse(await editor(page).inputValue());
    doc.workspace.name = 'Ventas en la nube';
    await editor(page).fill(JSON.stringify(doc, null, 2));
    await expect(saveStatus(page)).toHaveAttribute('data-save', 'saved', { timeout: 15000 });

    // está en la carpeta del servidor, no en el navegador
    await expect.poll(() => onDisk(server, 'nube').map((d) => JSON.parse(d.text).workspace?.name)).toEqual(['Ventas en la nube']);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('project-bar')).toBeVisible({ timeout: 20000 });
    await expect(saveStatus(page)).toHaveText('Guardado en «Nube» · servidor', { timeout: 20000 });
    await showEditor(page);
    expect(JSON.parse(await editor(page).inputValue()).workspace.name).toBe('Ventas en la nube');
    expect(errors).toEqual([]);

    // el token no se necesita aquí, y la configuración no guarda nada secreto en localStorage
    const stored = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
    expect(stored).toContain(server.url);
  });

  test('una segunda sesión (otro contexto, sin almacenamiento compartido) ve lo que guardó la primera y la lista se refresca al volver el foco', async ({ page, browser, server }) => {
    const { projectId, diagramId } = await seed(server);
    await open(page, `module=data`);
    await connect(page, server);

    const second: BrowserContext = await browser.newContext();
    try {
      const other = await second.newPage();
      await open(other, 'module=data');
      await connect(other, server);
      await other.getByRole('button', { name: 'Proyectos…' }).click();
      await expect(dialog(other).getByRole('navigation', { name: 'Proyectos' })).toContainText('Tienda');
      await dialog(other).getByRole('button', { name: /^Tienda/ }).click();
      await dialog(other).getByRole('button', { name: 'Abrir Ventas' }).click();
      await expect(dialog(other)).toHaveCount(0);
      await expect(saveStatus(other)).toHaveText('Guardado en «Tienda» · servidor');

      // la primera sesión no recibe avisos: ve lo nuevo al abrir el gestor y al volver el foco a la ventana
      await page.getByRole('button', { name: 'Proyectos…' }).click();
      await expect(dialog(page).getByRole('navigation', { name: 'Proyectos' })).toContainText('Tienda');
      await api(server, 'POST', '/api/projects', { name: 'De otro equipo' });
      await expect(dialog(page).getByRole('navigation', { name: 'Proyectos' })).not.toContainText('De otro equipo');
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(dialog(page).getByRole('navigation', { name: 'Proyectos' })).toContainText('De otro equipo');

      // y lo que edita la segunda sesión se ve al abrir ese diagrama desde la primera
      await showEditor(other);
      const doc = JSON.parse(await editor(other).inputValue());
      doc.workspace.name = 'Editado desde la otra sesión';
      await editor(other).fill(JSON.stringify(doc, null, 2));
      await expect(saveStatus(other)).toHaveAttribute('data-save', 'saved', { timeout: 15000 });
      await dialog(page).getByRole('button', { name: /^Tienda/ }).click();
      await dialog(page).getByRole('button', { name: 'Abrir Ventas' }).click();
      await expect(saveStatus(page)).toHaveText('Guardado en «Tienda» · servidor', { timeout: 15000 });
      await showEditor(page);
      await expect.poll(async () => JSON.parse(await editor(page).inputValue()).workspace.name).toBe('Editado desde la otra sesión');
      expect(onDisk(server, projectId).map((d) => d.file)).toEqual([`${diagramId}.data.json`]);
    } finally {
      await second.close();
    }
  });

  test('dos sesiones editando el mismo diagrama: la segunda avisa del conflicto y deja elegir', async ({ page, browser, server }) => {
    const { projectId, diagramId } = await seed(server);
    await preconnect(page.context(), server);
    await open(page, `project=${projectId}&diagram=${diagramId}`);
    await expect(saveStatus(page)).toHaveText('Guardado en «Tienda» · servidor', { timeout: 20000 });
    await showEditor(page);

    const second = await browser.newContext();
    try {
      await preconnect(second, server);
      const other = await second.newPage();
      await open(other, `project=${projectId}&diagram=${diagramId}`);
      await expect(saveStatus(other)).toHaveText('Guardado en «Tienda» · servidor', { timeout: 20000 });
      await showEditor(other);
      const doc = JSON.parse(await editor(other).inputValue());
      doc.workspace.name = 'Desde la otra sesión';
      await editor(other).fill(JSON.stringify(doc, null, 2));
      await expect(saveStatus(other)).toHaveAttribute('data-save', 'saved', { timeout: 15000 });

      const mine = JSON.parse(await editor(page).inputValue());
      mine.workspace.name = 'Desde la primera';
      await editor(page).fill(JSON.stringify(mine, null, 2));
      await expect(saveStatus(page)).toHaveText('Hay un conflicto que resolver', { timeout: 15000 });
      await page.getByTestId('resolve-conflict').click();
      await page.getByRole('button', { name: 'Quedarme con la del servidor' }).click();
      await page.getByRole('button', { name: 'Sí, quedarme con la del servidor' }).click();
      await expect(page.getByTestId('conflict-dialog')).toHaveCount(0);
      expect(JSON.parse(await editor(page).inputValue()).workspace.name).toBe('Desde la otra sesión');
      await expect(saveStatus(page)).toHaveText('Guardado en «Tienda» · servidor');

      // y quedarse con la propia versión la conserva en el servidor
      doc.workspace.name = 'Otra vez la otra';
      await editor(other).fill(JSON.stringify(doc, null, 2));
      await expect(saveStatus(other)).toHaveAttribute('data-save', 'saved', { timeout: 15000 });
      mine.workspace.name = 'Gana la primera';
      await editor(page).fill(JSON.stringify(mine, null, 2));
      await expect(saveStatus(page)).toHaveText('Hay un conflicto que resolver', { timeout: 15000 });
      await page.getByTestId('resolve-conflict').click();
      await page.getByRole('button', { name: 'Quedarme con la mía' }).click();
      await page.getByRole('button', { name: 'Sí, quedarme con la mía' }).click();
      await expect(saveStatus(page)).toHaveText('Guardado en «Tienda» · servidor', { timeout: 15000 });
      await expect.poll(() => JSON.parse(onDisk(server, projectId)[0].text).workspace.name).toBe('Gana la primera');
    } finally {
      await second.close();
    }
  });

  test('copiar un proyecto local al servidor sin cambiar de almacén, sin pisar nada, y volver a este navegador', async ({ page, server }) => {
    await open(page, 'module=data');
    await createProject(page, 'Local');
    await dialog(page).getByRole('button', { name: /Guardar en «Local»/ }).click();
    await expect(saveStatus(page)).toHaveText('Guardado en «Local»');
    const localName = await (async () => {
      await showEditor(page);
      return JSON.parse(await editor(page).inputValue()).workspace.name as string;
    })();

    // sin servidor conocido, «Copiar a un servidor…» lleva al formulario de conexión
    await page.getByRole('button', { name: 'Proyectos…' }).click();
    await expect(dialog(page).getByTestId('projects-foot')).toContainText('Los proyectos se guardan en este navegador');
    await dialog(page).getByRole('button', { name: 'Copiar a un servidor…' }).click();
    await storage(page).getByLabel('Dirección del servidor').fill(server.url);
    await storage(page).getByRole('button', { name: 'Copiar «Local» al servidor' }).click();
    await expect(dialog(page).getByTestId('projects-note')).toHaveText(`Copiado como «Local» en el servidor ${host(server)}.`);
    await expect.poll(() => onDisk(server, 'local').map((d) => JSON.parse(d.text).workspace?.name)).toEqual([localName]);

    // ya con el servidor conocido copia directamente, y no pisa
    await dialog(page).getByRole('button', { name: `Copiar al servidor (${host(server)})` }).click();
    await expect(dialog(page).getByTestId('projects-note')).toHaveText(`Copiado como «Local (2)» en el servidor ${host(server)}: ya había uno llamado «Local».`);
    expect(readdirSync(server.workspace).sort()).toEqual(['local', 'local-2']);
    // este navegador sigue siendo el almacén activo
    await expect(storage(page).getByTestId('storage-summary')).toHaveText('Este navegador');
    await page.keyboard.press('Escape'); // pliega el panel
    await page.keyboard.press('Escape'); // cierra el gestor
    await expect(dialog(page)).toHaveCount(0);
    await expect(saveStatus(page)).toHaveText('Guardado en «Local»');

    // conectar y usar el servidor: allí están las dos copias y este navegador queda aparte
    await page.getByRole('button', { name: 'Proyectos…' }).click();
    await storage(page).getByRole('button', { name: 'Conectar a un servidor…' }).click();
    await expect(storage(page).getByLabel('Dirección del servidor')).toHaveValue(server.url); // el servidor ya es conocido
    await Promise.all([page.waitForEvent('load'), storage(page).getByRole('button', { name: 'Conectar', exact: true }).click()]);
    await expect(page.getByTestId('project-bar')).toBeVisible({ timeout: 20000 });
    await page.getByRole('button', { name: 'Proyectos…' }).click();
    await expect(storage(page).getByTestId('storage-summary')).toContainText(`Servidor: ${host(server)}`);
    await expect(dialog(page).getByRole('navigation', { name: 'Proyectos' })).toContainText('Local (2)');

    // volver a este navegador: el proyecto local sigue ahí y el servidor no se toca
    await storage(page).getByRole('button', { name: 'Cambiar…' }).click();
    await Promise.all([page.waitForEvent('load'), storage(page).getByRole('button', { name: 'Volver a este navegador' }).click()]);
    await expect(page.getByTestId('project-bar')).toBeVisible({ timeout: 20000 });
    await page.getByRole('button', { name: 'Proyectos…' }).click();
    await expect(storage(page).getByTestId('storage-summary')).toHaveText('Este navegador');
    await expect(dialog(page).getByRole('navigation', { name: 'Proyectos' })).toContainText('Local');
    await expect(dialog(page).getByRole('navigation', { name: 'Proyectos' })).not.toContainText('Local (2)');
    await expect(dialog(page).getByTestId('projects-foot')).toContainText('Los proyectos se guardan en este navegador');
    expect(readdirSync(server.workspace).sort()).toEqual(['local', 'local-2']);
  });

  test('copiar del servidor a este navegador', async ({ page, server }) => {
    await seed(server, 'Compartido', 'Ventas');
    await preconnect(page.context(), server);
    await open(page, 'module=data');
    await page.getByRole('button', { name: 'Proyectos…' }).click();
    await dialog(page).getByRole('button', { name: /^Compartido/ }).click();
    await dialog(page).getByRole('button', { name: 'Copiar a este navegador' }).click();
    await expect(dialog(page).getByTestId('projects-note')).toHaveText('Copiado como «Compartido» en este navegador.');
    // se ve (con su diagrama) al volver a este navegador
    await storage(page).getByRole('button', { name: 'Cambiar…' }).click();
    await Promise.all([page.waitForEvent('load'), storage(page).getByRole('button', { name: 'Volver a este navegador' }).click()]);
    await expect(page.getByTestId('project-bar')).toBeVisible({ timeout: 20000 });
    await page.getByRole('button', { name: 'Proyectos…' }).click();
    await dialog(page).getByRole('button', { name: /^Compartido/ }).click();
    await expect(dialog(page).getByTestId('project-diagram')).toContainText('Ventas');
  });

  test('avisos al conectar: CORS rechazado (con el origen exacto), servidor apagado y dirección que no es de IArk', async ({ page, origin }) => {
    await open(page, 'module=data');
    await page.getByRole('button', { name: 'Proyectos…' }).click();
    await storage(page).getByRole('button', { name: 'Conectar a un servidor…' }).click();

    // un servidor que arrancó sin --cors: el navegador bloquea la respuesta, y el aviso lo dice con el origen de esta página
    const closed = await startCloudServer();
    try {
      await storage(page).getByLabel('Dirección del servidor').fill(closed.url);
      await storage(page).getByRole('button', { name: 'Probar conexión' }).click();
      const result = storage(page).getByTestId('storage-test');
      await expect(result).toHaveAttribute('data-problem', 'cors', { timeout: 20000 });
      await expect(result).toContainText(`--cors ${origin}`);
    } finally {
      await closed.stop();
    }

    // el mismo servidor ya apagado: no se llega
    await storage(page).getByRole('button', { name: 'Probar conexión' }).click();
    await expect(storage(page).getByTestId('storage-test')).toHaveAttribute('data-problem', 'unreachable', { timeout: 20000 });
    expect(await page.evaluate(() => localStorage.getItem('iark.projects.backend'))).toBeNull(); // probar no guarda nada

    // la propia página sirve HTML, no la API de IArk
    await storage(page).getByLabel('Dirección del servidor').fill(origin);
    await storage(page).getByRole('button', { name: 'Probar conexión' }).click();
    await expect(storage(page).getByTestId('storage-test')).toHaveAttribute('data-problem', /no-projects|server/, { timeout: 20000 });
  });

  test('un token rechazado al guardar avisa, conserva el texto y «Volver a conectar» lo retoma sin recargar', async ({ page, server, origin }) => {
    const { projectId, diagramId } = await seed(server);
    await preconnect(page.context(), server);
    await open(page, `project=${projectId}&diagram=${diagramId}`);
    await expect(saveStatus(page)).toHaveText('Guardado en «Tienda» · servidor', { timeout: 20000 });
    await showEditor(page);

    // el servidor deja de aceptar el token (se simula en el navegador: el servidor de la prueba no tiene autenticación)
    let rejecting = true;
    await page.route(`${server.url}/api/projects/*/diagrams/*`, async (route) => {
      if (rejecting && route.request().method() === 'PUT') {
        await route.fulfill({ status: 401, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': origin }, body: JSON.stringify({ error: 'Falta un token válido.', code: 'unauthorized' }) });
      } else await route.continue();
    });
    const doc = JSON.parse(await editor(page).inputValue());
    doc.workspace.name = 'Lo que escribí sin token';
    await editor(page).fill(JSON.stringify(doc, null, 2));
    await expect(saveStatus(page)).toContainText('El servidor no aceptó el token', { timeout: 15000 });
    await expect(page.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
    expect(JSON.parse(await editor(page).inputValue()).workspace.name).toBe('Lo que escribí sin token'); // el texto sigue ahí
    expect(onDisk(server, projectId).map((d) => JSON.parse(d.text).workspace.name)).not.toContain('Lo que escribí sin token');

    rejecting = false;
    await page.getByTestId('reconnect').click();
    await expect(storage(page).getByTestId('storage-rejected')).toBeVisible();
    await storage(page).getByRole('button', { name: 'Usar este token' }).click();
    await expect(storage(page).getByTestId('storage-message')).toContainText('Token actualizado');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(saveStatus(page)).toHaveText('Guardado en «Tienda» · servidor', { timeout: 15000 });
    await expect.poll(() => JSON.parse(onDisk(server, projectId)[0].text).workspace.name).toBe('Lo que escribí sin token');
  });

  test('un corte de red al guardar queda «Sin conexión» y se envía solo al volver la conexión', async ({ page, server }) => {
    const { projectId, diagramId } = await seed(server);
    await preconnect(page.context(), server);
    await open(page, `project=${projectId}&diagram=${diagramId}`);
    await expect(saveStatus(page)).toHaveText('Guardado en «Tienda» · servidor', { timeout: 20000 });
    await showEditor(page);

    await page.route(`${server.url}/api/projects/**`, (route) => route.abort('connectionrefused'));
    const doc = JSON.parse(await editor(page).inputValue());
    doc.workspace.name = 'Escrito sin red';
    await editor(page).fill(JSON.stringify(doc, null, 2));
    await expect(saveStatus(page)).toHaveText('Sin conexión: 1 cambio pendiente', { timeout: 15000 });
    await expect(page.getByRole('button', { name: 'Reintentar ahora' })).toBeVisible();

    // vuelve la red: el aviso `online` del navegador reintenta solo
    await page.unroute(`${server.url}/api/projects/**`);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(saveStatus(page)).toHaveText('Guardado en «Tienda» · servidor', { timeout: 15000 });
    await expect.poll(() => JSON.parse(onDisk(server, projectId)[0].text).workspace.name).toBe('Escrito sin red');
  });

  test('al cerrar la pestaña con cambios sin guardar el navegador avisa (beforeunload) y lo escrito llega al servidor (pagehide + keepalive)', async ({ page, server }) => {
    const { projectId, diagramId } = await seed(server);
    await preconnect(page.context(), server);
    await open(page, `project=${projectId}&diagram=${diagramId}`);
    await expect(saveStatus(page)).toHaveText('Guardado en «Tienda» · servidor', { timeout: 20000 });
    await showEditor(page);
    const doc = JSON.parse(await editor(page).inputValue());
    doc.workspace.name = 'Escrito justo antes de cerrar';
    await editor(page).fill(JSON.stringify(doc, null, 2));
    await expect(saveStatus(page)).toHaveAttribute('data-save', 'pending'); // aún dentro de la pausa del autoguardado

    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.type());
      void d.accept();
    });
    await page.goto('about:blank');
    expect(dialogs).toEqual(['beforeunload']);
    await expect.poll(() => JSON.parse(onDisk(server, projectId)[0].text).workspace.name, { timeout: 10000 }).toBe('Escrito justo antes de cerrar');
  });

  test('editor C4: guardar en el servidor, el chip lo indica y se recupera tras recargar', async ({ page, server }) => {
    await preconnect(page.context(), server);
    await openEditor(page);
    const chip = page.getByTestId('project-chip');
    await expect(chip).toHaveText('Sin proyecto · servidor');
    await page.getByText('Archivo', { exact: true }).click();
    await page.getByText('Proyectos…').click();
    await expect(dialog(page)).toBeVisible();
    await expect(storage(page).getByTestId('storage-summary')).toContainText(`Servidor: ${host(server)}`);
    await dialog(page).getByPlaceholder('Nombre del proyecto').fill('Banca');
    await dialog(page).getByRole('button', { name: 'Crear', exact: true }).click();
    await expect(dialog(page).getByRole('heading', { name: 'Banca' })).toBeVisible();
    await dialog(page).getByRole('button', { name: /Guardar en «Banca»/ }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(chip).toContainText('Proyecto: Banca ›');
    await expect(chip).toContainText('· servidor');
    await expect(saveStatus(page)).toHaveText('Guardado en «Banca» · servidor');

    await page.getByRole('button', { name: 'Añadir persona' }).click();
    await expect(page.locator('.react-flow__node')).toHaveCount(5);
    await expect(saveStatus(page)).toHaveAttribute('data-save', 'saved', { timeout: 15000 });
    await expect.poll(() => JSON.parse(onDisk(server, 'banca')[0].text).model.elements.length).toBe(14);

    await reloadEditor(page);
    await expect(chip).toContainText('Proyecto: Banca ›', { timeout: 20000 });
    await expect(saveStatus(page)).toHaveText('Guardado en «Banca» · servidor');
    await c4Ready(page);
    await expect(page.locator('.react-flow__node')).toHaveCount(5);
  });
});
