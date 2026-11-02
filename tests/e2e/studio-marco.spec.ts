import { expect, test } from '@playwright/test';

/**
 * El marco del editor clásico sobre el lienzo común (`/?studio=1` y `/?editor=1`).
 * Comprueba el taladro de C4, la exportación a draw.io y la pestaña de IA.
 */
test('C4 en el marco clásico: lienzo, miga, draw.io e IA', async ({ page }) => {
  await page.goto('/?studio=1&module=c4', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('module-canvas')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('studio-export-drawio')).toBeVisible();
  await page.getByRole('tab', { name: 'IA' }).click();
  await expect(page.getByRole('button', { name: 'Copiar prompt para IA' })).toBeVisible();
  await page.getByRole('tab', { name: /Elementos/ }).click();
  await expect(page.getByTestId('studio-crumbs')).toBeVisible();
});

test('el editor clásico de la dirección principal abre el mismo marco', async ({ page }) => {
  await page.goto('/?editor=1', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('module-canvas')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('studio-export-drawio')).toBeVisible();
});
