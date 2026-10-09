import { expect, test, type Page } from '@playwright/test';
import { canvasReady } from './canvas-helpers';

async function open(page: Page, module: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/modulos.html?module=${module}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 20000 });
  await canvasReady(page);
  return errors;
}

test.describe('enlaces entre diagramas (URN) y pestaña C4', () => {
  test('doble clic en un elemento enlazado abre el módulo destino con el elemento seleccionado, y Alt+↑ vuelve', async ({ page }) => {
    const errors = await open(page, 'data');
    await expect(page.getByTestId('link-erp')).toBeVisible();
    await page.locator('[data-testid="node-erp"] .cv-group-title').dblclick();
    await expect(page.getByRole('tab', { name: 'Integración' })).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
    await expect(page.locator('[data-testid="node-pedidos"][data-selected]')).toBeVisible();
    await expect(page.getByTestId('trail')).toContainText('Datos · erp');
    await expect(page.getByTestId('backlinks')).toContainText('Datos: ERP de pedidos');
    await expect(page.getByTestId('backlinks')).toContainText('Plataforma: Servicio de pedidos');
    await page.keyboard.press('Alt+ArrowUp');
    await expect(page.getByRole('tab', { name: 'Datos' })).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
    await expect(page.getByTestId('trail')).toHaveCount(0);
    await expect(page.locator('[data-testid="node-erp"][data-selected]')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('el enlace se elige por módulo y elemento desde las propiedades y «Referenciado por» lleva de vuelta', async ({ page }) => {
    await open(page, 'integration');
    await page.locator('[data-testid="node-tienda-web"]').click();
    const picker = page.getByTestId('ref-picker');
    await expect(picker).toContainText('Sin enlace');
    await picker.getByLabel('Módulo enlazado').selectOption('c4');
    await picker.getByLabel('Elemento enlazado').selectOption({ index: 1 });
    await expect(picker.locator('small')).toContainText('urn:iark:c4:');
    const target = (await picker.locator('small').innerText()).split(' ')[0].replace('urn:iark:c4:', '');
    await expect(page.getByTestId('link-tienda-web')).toBeVisible();
    await picker.getByTestId('follow-ref').click();
    await expect(page.getByRole('tab', { name: 'C4' })).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
    // C4 se abre en el mismo lienzo que los demás módulos, con el elemento enlazado seleccionado (en la vista que lo dibuja).
    await expect(page.locator(`[data-testid="node-${target}"][data-selected]`)).toBeVisible({ timeout: 15000 });
    await expect(page.locator('iframe')).toHaveCount(0);
    await expect(page.getByTestId('trail')).toContainText('Integración · tienda-web');
    await page.getByTestId('trail-back').click();
    await expect(page.getByRole('tab', { name: 'Integración' })).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
  });

  test('C4 se edita en el banco con el lienzo común y su documento se sincroniza con la pestaña JSON', async ({ page }) => {
    const errors = await open(page, 'c4');
    await expect(page.getByRole('tab', { name: 'C4' })).toHaveAttribute('aria-selected', 'true');
    // el lienzo está en el propio banco de trabajo, sin editor incrustado
    await expect(page.locator('iframe')).toHaveCount(0);
    await expect(page.getByTestId('node-banca')).toBeVisible();
    // C4 también exporta SVG con las figuras del lienzo, así que la pestaña se llama «Vista SVG» y dibuja la vista activa.
    await page.getByRole('tab', { name: 'Vista SVG' }).click();
    await expect(page.getByTestId('editor-status')).toContainText('Válido');
    await expect(page.getByTestId('diagram-stage').locator('img')).toBeVisible({ timeout: 20000 });
    const editor = page.getByLabel('Documento JSON');
    const doc = JSON.parse(await editor.inputValue());
    doc.model.elements.find((e: { id: string }) => e.id === 'cliente').name = 'Cliente renombrado';
    await editor.fill(JSON.stringify(doc, null, 2));
    await page.getByRole('tab', { name: 'Lienzo' }).click();
    await canvasReady(page);
    await expect(page.getByTestId('node-cliente')).toContainText('Cliente renombrado');
    expect(errors).toEqual([]);
  });
});
