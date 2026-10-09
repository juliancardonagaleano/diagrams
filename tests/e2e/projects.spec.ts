import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * Proyectos en el banco de trabajo (IndexedDB real del navegador): crear, guardar, autoguardado, reabrir tras recargar,
 * enlaces entre los diagramas del proyecto, exportar e importar, y dos pestañas editando lo mismo.
 */
const example = (file: string): string => readFileSync(new URL(`../../examples/${file}`, import.meta.url), 'utf8');

async function open(page: Page, query = 'module=data'): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/modulos.html${query ? `?${query}` : ''}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('project-bar')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('editor-status')).toContainText('Válido', { timeout: 20000 });
  return errors;
}

const dialog = (page: Page) => page.getByTestId('projects-dialog');

async function createProject(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Proyectos…' }).click();
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByPlaceholder('Nombre del proyecto').fill(name);
  await dialog(page).getByRole('button', { name: 'Crear', exact: true }).click();
  await expect(dialog(page).getByRole('heading', { name })).toBeVisible();
}

/** Añade un diagrama de `module` con su ejemplo y lo abre (cierra el diálogo). */
async function addDiagram(page: Page, module: string, name: string): Promise<void> {
  const form = dialog(page).getByRole('form', { name: 'Nuevo diagrama' });
  await form.getByLabel('Módulo del diagrama nuevo').selectOption(module);
  await form.getByLabel('Nombre del diagrama nuevo').fill(name);
  await form.getByRole('button', { name: 'Crear y abrir' }).click();
  await expect(dialog(page)).toHaveCount(0);
}

/** El JSON solo se ve fuera del lienzo: se pasa a «Vista SVG» (que no oculta el editor) antes de teclear. */
const editor = (page: Page) => page.getByLabel('Documento JSON');
async function showEditor(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Vista SVG' }).click();
  await expect(editor(page)).toBeVisible();
}
const saveStatus = (page: Page) => page.getByTestId('save-status');

test.describe('proyectos en el banco de trabajo', () => {
  test('guardar el documento en un proyecto, editar con autoguardado y recuperarlo tras recargar la página', async ({ page }) => {
    const errors = await open(page);
    await expect(saveStatus(page)).toHaveText('');
    await createProject(page, 'Tienda');
    // el documento que ya se estaba editando se guarda como diagrama del proyecto
    await dialog(page).getByRole('button', { name: /Guardar en «Tienda»/ }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(saveStatus(page)).toHaveText('Guardado en «Tienda»');
    await expect(page.getByRole('combobox', { name: 'Diagrama' })).toHaveValue(/.+/);

    await showEditor(page);
    const doc = JSON.parse(await editor(page).inputValue());
    doc.workspace.name = 'Ventas v2';
    await editor(page).fill(JSON.stringify(doc, null, 2));
    await expect(saveStatus(page)).toHaveAttribute('data-save', 'saved', { timeout: 10000 });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('project-bar')).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole('combobox', { name: 'Proyecto' })).toHaveValue(/.+/);
    await expect(saveStatus(page)).toHaveText('Guardado en «Tienda»', { timeout: 20000 });
    await showEditor(page);
    expect(JSON.parse(await editor(page).inputValue()).workspace.name).toBe('Ventas v2');
    expect(errors).toEqual([]);
  });

  test('cambiar de módulo con un proyecto abierto va al diagrama de ese módulo; sin ninguno queda un borrador que se puede guardar', async ({ page }) => {
    await open(page, 'module=integration');
    await createProject(page, 'Tienda');
    await addDiagram(page, 'integration', 'Pedidos');
    await page.getByRole('button', { name: 'Proyectos…' }).click();
    await addDiagram(page, 'data', 'Ventas');
    await expect(page.getByRole('tab', { name: 'Datos' })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: 'Integración' }).click();
    await expect(page.getByRole('combobox', { name: 'Diagrama' })).toContainText('Pedidos');
    await expect(saveStatus(page)).toHaveText('Guardado en «Tienda»');

    await page.getByRole('tab', { name: 'Seguridad' }).click();
    await expect(saveStatus(page)).toHaveText('Borrador: aún no está en el proyecto', { timeout: 15000 });
    await page.getByTestId('save-to-project').click();
    await expect(saveStatus(page)).toHaveText('Guardado en «Tienda»');
    await page.getByRole('button', { name: 'Proyectos…' }).click();
    await expect(dialog(page).getByTestId('project-diagram')).toHaveCount(3);
  });

  test('un enlace entre diagramas del proyecto abre el diagrama que contiene el elemento, y Alt+↑ vuelve al anterior', async ({ page }) => {
    const errors = await open(page, 'module=data');
    await createProject(page, 'Tienda');
    await addDiagram(page, 'data', 'Ventas');
    await page.getByRole('button', { name: 'Proyectos…' }).click();
    await addDiagram(page, 'integration', 'Pedidos');
    await page.getByRole('tab', { name: 'Datos' }).click();
    await expect(page.getByTestId('link-erp')).toBeVisible({ timeout: 20000 });
    await page.locator('[data-testid="node-erp"] .cv-group-title').dblclick();
    await expect(page.getByRole('tab', { name: 'Integración' })).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
    await expect(page.getByRole('combobox', { name: 'Diagrama' })).toContainText('Pedidos');
    await expect(page.locator('[data-testid="node-pedidos"][data-selected]')).toBeVisible();
    await expect(page.getByTestId('trail')).toContainText('Datos · erp');
    await page.keyboard.press('Alt+ArrowUp');
    await expect(page.getByRole('tab', { name: 'Datos' })).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
    await expect(page.locator('[data-testid="node-erp"][data-selected]')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('exportar un proyecto a un archivo y volver a importarlo crea otro proyecto con lo mismo', async ({ page }) => {
    await open(page, 'module=security');
    await createProject(page, 'Tienda');
    await addDiagram(page, 'security', 'Amenazas');
    await page.getByRole('button', { name: 'Proyectos…' }).click();
    const download = page.waitForEvent('download');
    await dialog(page).getByRole('button', { name: 'Exportar' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('tienda.iark-project.json');
    const path = await file.path();
    const bundle = JSON.parse(readFileSync(path, 'utf8'));
    expect(bundle).toMatchObject({ format: 'iark.project', version: 1, project: { name: 'Tienda' } });
    expect(bundle.diagrams).toHaveLength(1);
    expect(bundle.diagrams[0]).toMatchObject({ module: 'security', name: 'Amenazas' });
    expect(bundle.diagrams[0].document.workspace.name).toBe(JSON.parse(example('seguridad-ejemplo.json')).workspace.name);

    await dialog(page).getByLabel('Importar proyecto desde un archivo').setInputFiles(path);
    await expect(dialog(page).getByRole('heading', { name: 'Tienda (2)' })).toBeVisible();
    await expect(dialog(page).getByTestId('project-diagram')).toContainText('Amenazas');
    await expect(dialog(page).getByRole('navigation', { name: 'Proyectos' })).toContainText('Tienda (2)');

    // un archivo que no es un proyecto se rechaza con el motivo
    await dialog(page).getByLabel('Importar proyecto desde un archivo').setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from(example('seguridad-ejemplo.json')) });
    await expect(dialog(page).getByTestId('projects-error')).toContainText('No es un proyecto de DIAgrams');
  });

  test('renombrar, duplicar y borrar diagramas y proyectos desde el gestor', async ({ page }) => {
    await open(page, 'module=data');
    await createProject(page, 'Tienda');
    await addDiagram(page, 'data', 'Ventas');
    await page.getByRole('button', { name: 'Proyectos…' }).click();
    await dialog(page).getByRole('button', { name: 'Duplicar Ventas' }).click();
    await expect(dialog(page).getByTestId('project-diagram')).toHaveCount(2);
    await expect(dialog(page)).toContainText('Ventas (copia)');
    await dialog(page).getByRole('button', { name: 'Renombrar Ventas (copia)' }).click();
    await dialog(page).getByLabel('Nuevo nombre de Ventas (copia)').fill('Ventas');
    await dialog(page).getByRole('button', { name: 'Guardar', exact: true }).click();
    await expect(dialog(page).getByTestId('projects-error')).toContainText('Ya hay un diagrama llamado «Ventas»');
    await dialog(page).getByLabel('Nuevo nombre de Ventas (copia)').fill('Ventas 2025');
    await dialog(page).getByRole('button', { name: 'Guardar', exact: true }).click();
    await expect(dialog(page)).toContainText('Ventas 2025');
    await dialog(page).getByRole('button', { name: 'Borrar Ventas 2025' }).click();
    await dialog(page).getByRole('button', { name: 'Sí, borrar' }).click();
    await expect(dialog(page).getByTestId('project-diagram')).toHaveCount(1);
    // borrar el proyecto pide confirmación y no deja nada
    await dialog(page).getByRole('button', { name: 'Borrar Tienda' }).click();
    await expect(dialog(page).getByRole('alert')).toContainText('No se puede deshacer');
    await dialog(page).getByRole('button', { name: 'Sí, borrar' }).click();
    await expect(dialog(page)).toContainText('Aún no hay proyectos');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(saveStatus(page)).toHaveText('');
  });

  test('dos pestañas editando el mismo diagrama: la segunda avisa del conflicto y deja elegir', async ({ page, context }) => {
    await open(page, 'module=data');
    await createProject(page, 'Tienda');
    await dialog(page).getByRole('button', { name: /Guardar en «Tienda»/ }).click();
    await expect(saveStatus(page)).toHaveText('Guardado en «Tienda»');

    await showEditor(page);
    const other = await context.newPage();
    await open(other, ''); // reabre lo último que se estaba editando
    await expect(saveStatus(other)).toHaveText('Guardado en «Tienda»', { timeout: 20000 });
    await showEditor(other);
    const doc = JSON.parse(await editor(other).inputValue());
    doc.workspace.name = 'Desde la otra pestaña';
    await editor(other).fill(JSON.stringify(doc, null, 2));
    await expect(saveStatus(other)).toHaveAttribute('data-save', 'saved', { timeout: 10000 });

    const mine = JSON.parse(await editor(page).inputValue());
    mine.workspace.name = 'Desde la primera';
    await editor(page).fill(JSON.stringify(mine, null, 2));
    await expect(page.getByTestId('save-conflict')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Cargar la otra' }).click();
    await expect(page.getByTestId('save-conflict')).toHaveCount(0);
    expect(JSON.parse(await editor(page).inputValue()).workspace.name).toBe('Desde la otra pestaña');
    await expect(saveStatus(page)).toHaveText('Guardado en «Tienda»');

    // y quedarse con la propia versión también funciona
    mine.workspace.name = 'Gana la primera';
    await editor(other).fill(JSON.stringify({ ...doc, workspace: { ...doc.workspace, name: 'Otra vez la otra' } }, null, 2));
    await expect(saveStatus(other)).toHaveAttribute('data-save', 'saved', { timeout: 10000 });
    await editor(page).fill(JSON.stringify(mine, null, 2));
    await expect(page.getByTestId('save-conflict')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Quedarme con mi versión' }).click();
    await expect(saveStatus(page)).toHaveText('Guardado en «Tienda»', { timeout: 10000 });
    await other.reload({ waitUntil: 'domcontentloaded' });
    await expect(saveStatus(other)).toHaveText('Guardado en «Tienda»', { timeout: 20000 });
    await showEditor(other);
    expect(JSON.parse(await editor(other).inputValue()).workspace.name).toBe('Gana la primera');
  });

  test('reemplazar un diagrama guardado con «Cargar ejemplo» avisa y se puede deshacer', async ({ page }) => {
    await open(page, 'module=data');
    await createProject(page, 'Tienda');
    await dialog(page).getByRole('button', { name: /Guardar en «Tienda»/ }).click();
    await showEditor(page);
    const doc = JSON.parse(await editor(page).inputValue());
    doc.workspace.name = 'Mi trabajo';
    const mine = JSON.stringify(doc, null, 2);
    await editor(page).fill(mine);
    await expect(saveStatus(page)).toHaveAttribute('data-save', 'saved', { timeout: 10000 });
    await page.getByRole('button', { name: 'Cargar ejemplo' }).click();
    await expect(page.getByTestId('replaced-note')).toContainText('Se reemplazó el contenido');
    expect(JSON.parse(await editor(page).inputValue()).workspace.name).not.toBe('Mi trabajo');
    await page.getByTestId('undo-replace').click();
    expect(await editor(page).inputValue()).toBe(mine);
    await expect(page.getByTestId('replaced-note')).toHaveCount(0);
  });
});
