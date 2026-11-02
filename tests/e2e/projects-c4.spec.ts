import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { c4Ready, openEditor, reloadEditor } from './canvas-helpers';

/**
 * Proyectos en el editor C4 (index.html, IndexedDB real del navegador): guardar el diagrama que se edita en un proyecto,
 * autoguardado, reabrirlo tras recargar, abrir un diagrama de otro módulo (lleva al banco de trabajo), el aviso de
 * reemplazo y el conflicto entre dos pestañas.
 */
const dialog = (page: Page) => page.getByTestId('projects-dialog');
const chip = (page: Page) => page.getByTestId('project-chip');
const saveStatus = (page: Page) => page.getByTestId('save-status');

async function openProjects(page: Page): Promise<void> {
  await page.getByText('Archivo', { exact: true }).click();
  await page.getByText('Proyectos…').click();
  await expect(dialog(page)).toBeVisible();
}

async function createProject(page: Page, name: string): Promise<void> {
  await openProjects(page);
  await dialog(page).getByPlaceholder('Nombre del proyecto').fill(name);
  await dialog(page).getByRole('button', { name: 'Crear', exact: true }).click();
  await expect(dialog(page).getByRole('heading', { name })).toBeVisible();
}

/** Guarda el documento que se está editando como diagrama del proyecto abierto en el gestor y lo deja abierto. */
async function saveCurrent(page: Page, project: string): Promise<void> {
  await dialog(page).getByRole('button', { name: new RegExp(`Guardar en «${project}»`) }).click();
  await expect(dialog(page)).toHaveCount(0);
}

const addPerson = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Añadir persona' }).click();
};

/** Los elementos del diagrama que quedó guardado en el proyecto, leídos del archivo de exportación. */
async function savedElementCount(page: Page): Promise<number> {
  await openProjects(page);
  const download = page.waitForEvent('download');
  await dialog(page).getByRole('button', { name: 'Exportar' }).click();
  const bundle = JSON.parse(readFileSync((await (await download).path())!, 'utf8'));
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  return bundle.diagrams[0].document.model.elements.length;
}

test.describe('proyectos en el editor C4', () => {
  test('guardar el diagrama en un proyecto, editar con autoguardado y recuperarlo tras recargar', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openEditor(page);
    await expect(chip(page)).toHaveText('Sin proyecto');
    await createProject(page, 'Banca');
    await saveCurrent(page, 'Banca');
    await expect(chip(page)).toContainText('Proyecto: Banca ›');
    await expect(saveStatus(page)).toHaveText('Guardado en «Banca»');
    expect(await savedElementCount(page)).toBe(13);

    await addPerson(page);
    await expect(page.locator('.react-flow__node')).toHaveCount(5);
    await expect(saveStatus(page)).toHaveAttribute('data-save', 'saved', { timeout: 10000 });
    expect(await savedElementCount(page)).toBe(14);

    await reloadEditor(page);
    await expect(chip(page)).toContainText('Proyecto: Banca ›', { timeout: 20000 });
    await expect(saveStatus(page)).toHaveText('Guardado en «Banca»');
    expect(errors).toEqual([]);
  });

  test('abrir un diagrama de otro módulo desde el gestor lleva al banco de trabajo con ese diagrama', async ({ page }) => {
    await openEditor(page);
    await createProject(page, 'Banca');
    const form = dialog(page).getByRole('form', { name: 'Nuevo diagrama' });
    await form.getByLabel('Módulo del diagrama nuevo').selectOption('data');
    await form.getByLabel('Nombre del diagrama nuevo').fill('Clientes');
    await form.getByRole('button', { name: 'Crear y abrir' }).click();
    await expect(page).toHaveURL(/modulos\.html\?project=.+&diagram=.+/, { timeout: 20000 });
    await expect(page.getByRole('button', { name: 'Datos', exact: true })).toHaveAttribute('aria-current', 'true', { timeout: 20000 });
    await expect(page.getByRole('combobox', { name: 'Diagrama' })).toContainText('Clientes', { timeout: 20000 });
    await expect(page.getByTestId('save-status')).toHaveText('Guardado en «Banca»');
  });

  test('con un diagrama de proyecto abierto, cargar otro documento avisa de que lo reemplaza; dejar de guardar lo suelta', async ({ page }) => {
    await openEditor(page);
    await createProject(page, 'Banca');
    await saveCurrent(page, 'Banca');
    await page.getByText('Archivo', { exact: true }).click();
    await page.getByText('Nuevo diagrama').click();
    const confirm = page.getByRole('dialog');
    await expect(confirm).toContainText('Reemplazar el diagrama del proyecto');
    await expect(confirm).toContainText('se guarda solo');
    await confirm.locator('button', { hasText: 'Cancelar' }).click();
    await expect(confirm).toBeHidden();
    await expect(page.locator('.react-flow__node')).toHaveCount(4);

    await page.getByText('Archivo', { exact: true }).click();
    await page.getByText('Dejar de guardar en el proyecto').click();
    await expect(chip(page)).toHaveText('Proyecto: Banca');
    await page.getByText('Archivo', { exact: true }).click();
    await expect(page.getByText('Guardar en el proyecto «Banca»')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('dos pestañas editando el mismo diagrama: la segunda avisa del conflicto y deja elegir', async ({ page, context }) => {
    await openEditor(page);
    await createProject(page, 'Banca');
    await saveCurrent(page, 'Banca');
    await expect(saveStatus(page)).toHaveText('Guardado en «Banca»');

    const other = await context.newPage();
    await openEditor(other);
    await expect(saveStatus(other)).toHaveText('Guardado en «Banca»', { timeout: 20000 });
    await addPerson(other);
    await expect(other.locator('.react-flow__node')).toHaveCount(5);
    await expect(saveStatus(other)).toHaveAttribute('data-save', 'saved', { timeout: 10000 });

    await addPerson(page);
    await addPerson(page);
    await expect(page.getByTestId('save-conflict')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Cargar la otra' }).click();
    await expect(page.getByTestId('save-conflict')).toHaveCount(0);
    await c4Ready(page);
    await expect(page.locator('.react-flow__node')).toHaveCount(5);
    await expect(saveStatus(page)).toHaveText('Guardado en «Banca»');

    // quedarse con la propia versión también funciona
    await addPerson(other);
    await expect(saveStatus(other)).toHaveAttribute('data-save', 'saved', { timeout: 10000 });
    await addPerson(page);
    await addPerson(page);
    await expect(page.getByTestId('save-conflict')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Quedarme con mi versión' }).click();
    await expect(saveStatus(page)).toHaveText('Guardado en «Banca»', { timeout: 10000 });
    expect(await savedElementCount(page)).toBe(16);
  });
});
