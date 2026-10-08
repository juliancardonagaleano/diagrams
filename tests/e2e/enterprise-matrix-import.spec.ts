import { expect, test, type Page } from '@playwright/test';
import { canvasReady, docShot, selectView } from './canvas-helpers';

const SHOTS = '/mnt/project-files/empresarial';

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/modulos.html?module=enterprise', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('module-canvas')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 20000 });
  await canvasReady(page);
  return errors;
}

/** Las celdas de la matriz con una marca directa (●), por su id: `cell:<capacidad>|<aplicación>`. */
const directCells = (page: Page): Promise<string[]> =>
  page.locator('[data-testid^="node-cell:"]').evaluateAll((nodes) =>
    nodes.filter((n) => n.textContent?.includes('●')).map((n) => (n.getAttribute('data-testid') ?? '').replace('node-cell:', '')),
  );

test.describe('importar la matriz capacidad × aplicación exportada como Mermaid (block-beta)', () => {
  test('lo que exporta la matriz se importa de vuelta: mismas capacidades, aplicaciones y soporte directo, con los avisos de lo que no viaja', async ({ page }) => {
    const errors = await open(page);
    await selectView(page, 'matrix');
    const before = await directCells(page);
    expect(before.length).toBeGreaterThan(10);
    await expect(page.getByTestId('node-gestion-pedidos')).toContainText('Gestión de pedidos');

    // Se exporta la matriz a Mermaid: un diagrama de bloques, no un flowchart.
    await page.getByRole('tab', { name: 'Exportar' }).click();
    await page.locator('[data-format="mermaid"]').getByRole('button', { name: 'Ver' }).click();
    const text = (await page.getByTestId('export-preview').textContent())!;
    expect(text.split('\n')[0]).toBe('block-beta');

    // Y ese mismo texto se importa como archivo: el formato se reconoce por la extensión y el contenido.
    await page.getByRole('tab', { name: 'Importar' }).click();
    await page.getByRole('tabpanel', { name: 'Importar' }).locator('input[type="file"]').setInputFiles({ name: 'matriz.mmd', mimeType: 'text/plain', buffer: Buffer.from(text) });
    await page.getByRole('button', { name: 'Importar', exact: true }).click();
    await expect(page.getByText(/Importado desde mermaid con 3 avisos/)).toBeVisible();
    const panel = page.getByRole('tabpanel', { name: 'Importar' });
    await expect(panel).toContainText('celdas ○ (soporte por un proceso que realiza la capacidad) no se importan como relaciones');
    await expect(panel).toContainText('celdas · (soporte heredado de una capacidad hija) no se importan');
    await expect(panel).toContainText('Solo se importan los nombres, la jerarquía de capacidades y el soporte directo (●)');
    await docShot(page, `${SHOTS}/empresarial-matriz-importar-block-beta-avisos.png`);

    // El documento importado dibuja la misma matriz: los ids salen del nombre, así que cambian, pero no los nombres ni las marcas ●.
    await page.getByRole('tab', { name: 'Lienzo' }).click();
    await selectView(page, 'matrix');
    await expect(page.getByTestId('node-gestion-de-pedidos')).toContainText('Gestión de pedidos');
    await expect(page.getByTestId('node-gestion-pedidos')).toHaveCount(0);
    await expect(page.getByTestId('node-tienda-online')).toContainText('Tienda online');
    const after = await directCells(page);
    expect(after).toHaveLength(before.length);
    // Las celdas ○ (por un proceso) ya no están: el formato no dice qué proceso es.
    await expect(page.getByTestId('node-cell:gestion-de-pedidos|tienda-online')).not.toContainText('○');
    await docShot(page, `${SHOTS}/empresarial-matriz-importar-block-beta-matriz.png`);
    expect(errors).toEqual([]);
  });

  test('un diagrama de bloques que no es una matriz se rechaza con un mensaje, sin tocar el documento', async ({ page }) => {
    const errors = await open(page);
    await page.getByRole('tab', { name: 'Importar' }).click();
    await page.getByRole('tabpanel', { name: 'Importar' }).locator('input[type="file"]').setInputFiles({ name: 'bloques.mmd', mimeType: 'text/plain', buffer: Buffer.from('block-beta\n  columns 3\n  space:1 a["A"] total["Total"]\n  r["R"] c["●"]\n') });
    await page.getByRole('button', { name: 'Importar', exact: true }).click();
    await expect(page.getByRole('tabpanel', { name: 'Importar' })).toContainText('Las 5 entradas del diagrama no forman filas de 3 columnas: la cuadrícula no es rectangular.');
    await expect(page.getByLabel('Documento JSON')).toContainText('Comercio Andino');
    await page.getByRole('tab', { name: 'Lienzo' }).click();
    await expect(page.getByTestId('node-ventas-online')).toBeVisible();
    expect(errors).toEqual([]);
  });
});
