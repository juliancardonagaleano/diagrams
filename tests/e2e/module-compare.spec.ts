import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { canvasReady } from './canvas-helpers';

const example = (file: string): Record<string, any> => JSON.parse(readFileSync(new URL(`../../examples/${file}`, import.meta.url), 'utf8'));
const asFile = (name: string, doc: unknown) => ({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });

async function open(page: Page, module: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/modulos.html?module=${module}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('tab', { name: 'Lienzo' })).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 20000 });
  await canvasReady(page);
  return errors;
}

/** Abre otra versión con «Abrir archivo a comparar…» y espera a que se muestre lo que cambió. */
async function compareWith(page: Page, file: ReturnType<typeof asFile>): Promise<void> {
  await page.getByRole('tab', { name: /^Comparar/ }).click();
  await page.getByLabel('Abrir archivo a comparar…').setInputFiles(file);
  await expect(page.getByTestId('compare-summary')).toBeVisible({ timeout: 20000 });
}

test.describe('comparar versiones en el banco de trabajo', () => {
  test('integración: marca lo nuevo, lo modificado y lo quitado, y un clic en un cambio selecciona y encuadra el elemento', async ({ page }) => {
    const errors = await open(page, 'integration');
    await expect(page.locator('[data-diff]')).toHaveCount(0);
    await expect(page.getByTestId('compare-bar')).toHaveCount(0);

    // La versión anterior: la tienda se llamaba de otra forma y había un ERP que ya no está.
    const before = example('pedidos-integracion.json');
    before.nodes.find((n: { id: string }) => n.id === 'tienda-web').name = 'Tienda web (antes)';
    before.nodes.push({ id: 'erp-heredado', kind: 'system', name: 'ERP heredado' });
    await compareWith(page, asFile('pedidos-anterior.json', before));

    await expect(page.getByTestId('compare-summary')).toContainText('1 quitado, 1 modificado (1 campo).');
    await expect(page.getByRole('tab', { name: 'Comparar (2)' })).toBeVisible();
    await expect(page.getByTestId('change-removed-nodes-erp-heredado')).toContainText('ERP heredado');
    await expect(page.getByTestId('change-changed-nodes-tienda-web')).toContainText('name: "Tienda web (antes)" → "Tienda web"');

    await page.getByTestId('change-changed-nodes-tienda-web').getByRole('button').click();
    await expect(page.getByRole('tab', { name: 'Lienzo' })).toHaveAttribute('aria-selected', 'true');
    await canvasReady(page);
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
    await expect(page.locator('.react-flow__node.selected [data-testid="node-tienda-web"]')).toHaveAttribute('data-diff', 'modified');
    await expect(page.getByTestId('diff-tienda-web')).toHaveText('Modificado');
    await expect(page.getByTestId('node-erp-heredado')).toHaveAttribute('data-diff', 'removed');
    await expect(page.getByTestId('diff-erp-heredado')).toHaveText('Quitado');
    await expect(page.locator('[data-testid^="node-"][data-diff="added"]')).toHaveCount(0);
    await expect(page.getByTestId('compare-bar')).toContainText('Comparando con pedidos-anterior.json: 1 quitado, 1 modificado (1 campo).');

    // El resultado sigue al documento: un elemento nuevo se marca en cuanto se añade.
    await page.getByTestId('add-store').click();
    await expect(page.locator('[data-testid^="node-"][data-diff="added"]')).toHaveCount(1);
    await expect(page.locator('.cv-diff[data-diff="added"]')).toHaveText('Nuevo');
    await expect(page.getByTestId('compare-bar')).toContainText('1 añadido, 1 quitado, 1 modificado');

    // «Quitar comparación» devuelve el lienzo al estado normal.
    await page.getByTestId('compare-bar-clear').click();
    await expect(page.getByTestId('compare-bar')).toHaveCount(0);
    await expect(page.locator('[data-diff]')).toHaveCount(0);
    await expect(page.getByTestId('node-erp-heredado')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Comparar' })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('datos: una columna que cambia marca como modificada la tabla de la que cuelga', async ({ page }) => {
    const errors = await open(page, 'data');
    const before = example('ventas-datos.json');
    before.assets.find((a: { id: string }) => a.id === 'crm-clientes').columns.push({ name: 'columna_antigua', type: 'text' });
    await compareWith(page, asFile('catalogo-anterior.json', before));

    await expect(page.getByTestId('compare-summary')).toContainText('1 quitado.');
    await expect(page.getByTestId('change-removed-assets[crm-clientes].columns-columna_antigua')).toContainText('columna_antigua');
    // Lo quitado es una parte de la tabla: la fila no se puede seleccionar, pero la tabla queda marcada como modificada en el lienzo.
    await page.getByRole('tab', { name: 'Lienzo' }).click();
    await canvasReady(page);
    await expect(page.getByTestId('node-crm-clientes')).toHaveAttribute('data-diff', 'modified');
    await expect(page.locator('[data-testid^="node-"][data-diff="modified"]')).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('C4: la maquetación guardada no cuenta como cambio y la lista funciona sobre el JSON', async ({ page }) => {
    const errors = await open(page, 'c4');

    // La misma banca con otras coordenadas, tamaños y rutas: sin cambios.
    const moved = example('banca.json');
    for (const view of moved.views) {
      view.layout = { direction: 'RIGHT', spacing: 99 };
      view.elements.forEach((e: Record<string, number>, i: number) => Object.assign(e, { x: i * 7, y: i * 11, width: 300, height: 140 }));
    }
    await compareWith(page, asFile('banca-reordenada.json', moved));
    await expect(page.getByTestId('compare-summary')).toContainText('Sin cambios.');
    await expect(page.getByRole('tab', { name: 'Comparar (0)' })).toBeVisible();

    // Con contenido distinto: un elemento renombrado, otro que ya no está y una relación quitada.
    const before = example('banca.json');
    before.model.elements.find((e: { id: string }) => e.id === 'cliente').name = 'Cliente de antes';
    before.model.elements.push({ id: 'auditoria', type: 'container', name: 'Auditoría', parentId: 'banca', technology: 'Kafka' });
    await compareWith(page, asFile('banca-anterior.json', before));
    await expect(page.getByTestId('compare-summary')).toContainText('1 quitado, 1 modificado (1 campo).');
    await expect(page.getByTestId('change-changed-model.elements-cliente')).toContainText('name: "Cliente de antes" → "Cliente personal"');
    await expect(page.getByTestId('change-removed-model.elements-auditoria')).toContainText('Auditoría');

    // Un clic en un cambio vuelve al lienzo de C4 (el común), con la barra de la comparación encima y el elemento marcado.
    await page.getByTestId('change-changed-model.elements-cliente').getByRole('button').click();
    await expect(page.getByRole('tab', { name: 'Lienzo' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('compare-bar')).toContainText('Comparando con banca-anterior.json');
    await expect(page.locator('iframe')).toHaveCount(0);
    await canvasReady(page);
    await expect(page.getByTestId('node-cliente')).toHaveAttribute('data-diff', 'modified');
    await page.getByTestId('compare-bar-clear').click();
    await expect(page.getByTestId('compare-bar')).toHaveCount(0);
    await expect(page.locator('[data-diff]')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('un archivo que no sirve se explica en la propia pestaña y no cambia nada', async ({ page }) => {
    await open(page, 'security');
    await page.getByRole('tab', { name: 'Comparar' }).click();
    await page.getByLabel('Abrir archivo a comparar…').setInputFiles({ name: 'roto.json', mimeType: 'application/json', buffer: Buffer.from('{ no es json') });
    await expect(page.getByTestId('compare-error')).toContainText('«roto.json» no es JSON válido');
    await expect(page.getByTestId('compare-summary')).toHaveCount(0);
    await page.getByRole('tab', { name: 'Lienzo' }).click();
    await expect(page.getByTestId('compare-bar')).toHaveCount(0);
  });
});
