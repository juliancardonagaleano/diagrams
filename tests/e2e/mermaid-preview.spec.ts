import { expect, test, type Locator } from '@playwright/test';
import { canvasReady, openEditor } from './canvas-helpers';

/** Ancho natural de la imagen ya decodificada: 0 si el navegador no pudo leer el SVG (imagen rota). */
const naturalWidth = (img: Locator) => img.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0));

test.describe('vista previa renderizada de Mermaid', () => {
  test('editor C4: Archivo ▸ Vista previa de Mermaid dibuja la vista activa y descarga la librería solo entonces', async ({ page }) => {
    const errors: string[] = [];
    const libraryRequests: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => {
      if (/mermaid\.core/.test(r.url())) libraryRequests.push(r.url());
    });
    await openEditor(page);
    expect(libraryRequests).toEqual([]);

    await page.getByText('Archivo', { exact: true }).click();
    await page.getByText('Vista previa de Mermaid…', { exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Vista previa de Mermaid' });
    const c4 = dialog.getByRole('img', { name: 'Vista previa de Mermaid (C4 nativo)' });
    await expect(c4).toBeVisible({ timeout: 20000 });
    await expect.poll(() => naturalWidth(c4)).toBeGreaterThan(0);
    expect(libraryRequests).not.toEqual([]);

    // «Tamaño real» deja el dibujo a su tamaño natural (con desplazamiento) en vez de ajustarlo al ancho del diálogo.
    const shown = await c4.evaluate((el: HTMLImageElement) => el.getBoundingClientRect().width);
    await dialog.getByLabel('Tamaño real').check();
    await expect.poll(() => c4.evaluate((el: HTMLImageElement) => el.getBoundingClientRect().width)).toBeGreaterThan(shown);

    await dialog.getByText('Texto de Mermaid').click();
    await expect(dialog.getByTestId('mermaid-source')).toContainText(/^C4(Context|Container|Component)/);

    await dialog.getByRole('button', { name: 'Diagrama de flujo' }).click();
    const flow = dialog.getByRole('img', { name: 'Vista previa de Mermaid (diagrama de flujo)' });
    await expect(flow).toBeVisible({ timeout: 20000 });
    await expect.poll(() => naturalWidth(flow)).toBeGreaterThan(0);
    await expect(dialog.getByTestId('mermaid-source')).toContainText(/\nflowchart TB/);
    expect(errors).toEqual([]);
  });

  test('banco de trabajo: exportar ▸ Mermaid ▸ Ver dibuja el diagrama junto al texto', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/modulos.html?bank=1&module=platform', { waitUntil: 'domcontentloaded' });
    await canvasReady(page);
    await page.getByRole('tab', { name: 'Exportar' }).click();
    await page.locator('[data-format="json"]').getByRole('button', { name: 'Ver' }).click();
    await expect(page.getByTestId('export-preview')).toBeVisible();
    await expect(page.getByTestId('mermaid-preview')).toHaveCount(0);

    await page.locator('[data-format="mermaid"]').getByRole('button', { name: 'Ver' }).click();
    await expect(page.getByTestId('export-preview')).toContainText('flowchart');
    const drawing = page.getByRole('img', { name: /Vista previa de Mermaid/ });
    await expect(drawing).toBeVisible({ timeout: 20000 });
    await expect.poll(() => naturalWidth(drawing)).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });
});
