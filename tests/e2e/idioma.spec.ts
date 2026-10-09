import { expect, test, type Page } from '@playwright/test';

/**
 * Idioma de la interfaz (es / en): el selector del banco, del editor C4 y de la suite, el gestor de proyectos en inglés, lo que se recuerda y cómo manda
 * `?lang=` sobre todo lo demás. El resto de las pruebas e2e corren en español (`locale: 'es-ES'` en `playwright.config.ts`).
 */

async function openBank(page: Page, query: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/modulos.html?${query}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('project-bar')).toBeVisible({ timeout: 20000 });
  return errors;
}

test.describe('idioma de la interfaz', () => {
  test('banco de trabajo: el selector pasa a inglés, el gestor de proyectos sale en inglés y la elección se recuerda al recargar', async ({ page }) => {
    const errors = await openBank(page, 'module=data');
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    const select = page.getByRole('combobox', { name: 'Idioma' });
    await expect(select).toHaveValue('es');
    await expect(page.getByRole('button', { name: 'Proyectos…' })).toBeVisible();

    await select.selectOption('en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('combobox', { name: 'Language' })).toHaveValue('en');
    await expect(page.getByRole('button', { name: 'Projects…' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Load example' })).toBeVisible();

    // el gestor de proyectos
    await page.getByRole('button', { name: 'Projects…' }).click();
    const dialog = page.getByTestId('projects-dialog');
    await expect(dialog.getByRole('heading', { name: 'Projects' })).toBeVisible();
    await dialog.getByPlaceholder('Project name').fill('Shop');
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: 'Shop' })).toBeVisible();
    await expect(dialog.getByRole('form', { name: 'New diagram' })).toBeVisible();
    await page.keyboard.press('Escape');

    // recargar conserva la elección (localStorage) aunque el navegador hable español
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('project-bar')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('button', { name: 'Projects…' })).toBeVisible();

    // y volver a Español lo deja todo como estaba
    await page.getByRole('combobox', { name: 'Language' }).selectOption('es');
    await expect(page.getByRole('button', { name: 'Proyectos…' })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('?lang= manda sobre lo recordado y sobre el navegador', async ({ page }) => {
    await openBank(page, 'module=data&lang=en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('button', { name: 'Projects…' })).toBeVisible();
    // cambiar con el selector mantiene ?lang= al día: recargar no lo deshace
    await page.getByRole('combobox', { name: 'Language' }).selectOption('es');
    await expect(page).toHaveURL(/lang=es/);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('button', { name: 'Proyectos…' })).toBeVisible();
  });

  test('editor C4: el selector está en el encabezado y cambia los menús', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const header = page.getByRole('banner');
    await expect(header.getByRole('button', { name: 'Archivo' })).toBeVisible({ timeout: 20000 });
    await header.getByRole('combobox', { name: 'Idioma' }).selectOption('en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    for (const name of ['File', 'Edit', 'View', 'Settings', 'Help']) await expect(header.getByRole('button', { name })).toBeVisible();
    await header.getByRole('button', { name: 'File' }).click();
    await expect(page.getByText('Import Structurizr DSL…')).toBeVisible();
  });

  test('un navegador en inglés abre la interfaz en inglés sin tocar nada', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'en-US' });
    const page = await context.newPage();
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('banner').getByRole('button', { name: 'File' })).toBeVisible({ timeout: 20000 });
    await context.close();
  });

  test('suite: tiene selector, traduce su estado y abre los módulos en el idioma elegido', async ({ page }) => {
    await page.goto('/suite.html?lang=en', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('status')).toContainText('6 modules');
    await expect(page.getByRole('navigation', { name: 'Modules' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Language' })).toHaveValue('en');
    // el módulo que se abre recibe el idioma por la dirección del iframe
    await expect.poll(() => page.frames().find((f) => f.url().includes('embed=1'))?.url() ?? '').toContain('lang=en');
    await page.getByRole('combobox', { name: 'Language' }).selectOption('es');
    await expect(page.getByRole('status')).toContainText('6 módulos');
    await expect.poll(() => page.frames().find((f) => f.url().includes('embed=1'))?.url() ?? '').toContain('lang=es');
  });
});
