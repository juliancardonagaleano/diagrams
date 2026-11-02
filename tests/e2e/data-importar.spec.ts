import { mkdirSync, readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { canvasReady, selectView } from './canvas-helpers';

/** Si existe, las capturas se dejan también en la carpeta de salidas del proyecto. */
const SHOTS = process.env.DATA_SHOTS_DIR;
const shot = async (page: Page, name: string): Promise<void> => {
  await page.screenshot({ path: `test-results/${name}.png` });
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/${name}.png` });
  }
};

const fixture = (path: string): string => readFileSync(new URL(`../fixtures/importar/${path}`, import.meta.url), 'utf8');
const FIXTURES = new URL('../fixtures/importar/', import.meta.url).pathname;

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/modulos.html?bank=1&module=data', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('module-canvas')).toBeVisible({ timeout: 20000 });
  await canvasReady(page);
  return errors;
}

/** Pega el texto en «Importar» y lo importa; deja el banco de trabajo en el lienzo. */
async function importText(page: Page, text: string): Promise<void> {
  await page.getByRole('tab', { name: 'Importar' }).click();
  await page.getByLabel('Texto a importar').fill(text);
  await page.getByRole('button', { name: 'Importar', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Lienzo' }).click();
  await canvasReady(page);
}

/** Abre un archivo con «Abrir archivo a importar…» (el formato se deduce de la extensión) y lo importa. Es la vía natural para un archivo grande (pegarlo también va bien: ver `importar-pegado-grande.spec.ts`). */
async function importFile(page: Page, path: string): Promise<void> {
  await page.getByRole('tab', { name: 'Importar' }).click();
  await page.locator('input[type="file"]').last().setInputFiles(`${FIXTURES}${path}`);
  await expect(page.getByLabel('Texto a importar')).not.toHaveValue('');
  await page.getByRole('button', { name: 'Importar', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Lienzo' }).click();
  await canvasReady(page);
}

test.describe('datos: importar DDL de SQL y manifest de dbt', () => {
  // Doble resolución: las capturas de los lienzos con decenas de elementos se pueden ampliar sin perder lectura.
  test.use({ deviceScaleFactor: 2 });

  test('un DDL pegado se reconoce por el contenido y se ve en el ERD y en el linaje de las vistas', async ({ page }) => {
    const errors = await open(page);
    await importText(page, fixture('ddl/tienda-postgres.sql'));
    await expect(page.getByTestId('editor-status')).toContainText('Válido');
    expect(await page.getByLabel('Documento JSON').inputValue()).toContain('"tienda-pedidos"');

    await selectView(page, 'erd');
    await expect(page.getByTestId('node-tienda-pedidos')).toBeVisible();
    await expect(page.getByTestId('node-tienda-clientes')).toBeVisible();
    await expect(page.getByTestId('edge-end-tienda-clientes--tienda-pedidos-source')).toHaveAttribute('data-end', 'one');
    await expect(page.getByTestId('edge-end-tienda-clientes--tienda-pedidos-target')).toHaveAttribute('data-end', 'many');
    await expect(page.locator('[data-testid="node-tienda-pedidos"] li[data-emphasis="ref"]').first()).toContainText('FK');
    await expect(page.locator('[data-testid="node-tienda-pedido-lineas"] li[data-emphasis="key"]').first()).toContainText('PK');
    await shot(page, 'importar-ddl-erd');

    await selectView(page, 'lineage');
    await expect(page.getByTestId('node-analitica-ventas-por-cliente')).toBeVisible();
    await shot(page, 'importar-ddl-linaje');
    expect(errors).toEqual([]);
  });

  test('un manifest de dbt se importa y se ve el linaje de staging a marts, con las exposiciones, y sus relaciones en el ERD', async ({ page }) => {
    const errors = await open(page);
    await importFile(page, 'dbt/manifest-tienda.json');
    await expect(page.getByTestId('editor-status')).toContainText('Válido');

    await selectView(page, 'lineage');
    for (const id of ['tienda-clientes', 'stg-clientes', 'int-pedidos-enriquecidos', 'fct-pedidos', 'panel-ventas', 'modelo-fuga', 'paises-csv']) {
      await expect(page.getByTestId(`node-${id}`)).toBeVisible();
    }
    // Datos personales y clasificación declarados en meta, no deducidos.
    await expect(page.getByTestId('node-tienda-clientes')).toContainText('PII');
    await expect(page.getByTestId('node-tienda-productos')).not.toContainText('PII');
    await shot(page, 'importar-dbt-linaje');

    await selectView(page, 'erd');
    await expect(page.getByTestId('node-stg-pedidos')).toBeVisible();
    await expect(page.getByTestId('edge-end-stg-clientes--stg-pedidos-target')).toHaveAttribute('data-end', 'many');
    await shot(page, 'importar-dbt-erd');
    expect(errors).toEqual([]);
  });

  test('un archivo .sql abierto con «Abrir archivo a importar» se importa por su extensión', async ({ page }) => {
    await open(page);
    await importFile(page, 'ddl/tienda-mysql.sql');
    expect(await page.getByLabel('Documento JSON').inputValue()).toContain('"name": "tienda-mysql"');
    await selectView(page, 'erd');
    await expect(page.getByTestId('node-pedidos')).toBeVisible();
  });

  test('los avisos de lo que no se importó se muestran y un DDL roto o un JSON que no es dbt dan un error legible', async ({ page }) => {
    await open(page);
    await page.getByRole('tab', { name: 'Importar' }).click();
    await page.getByLabel('Texto a importar').fill("CREATE TABLE a (x text DEFAULT 'sin cerrar");
    await page.getByRole('button', { name: 'Importar', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('línea 1: una cadena sin cerrar');

    await page.getByLabel('Formato de importación').selectOption('dbt');
    await page.getByLabel('Texto a importar').fill('{"nodes": {}}');
    await page.getByRole('button', { name: 'Importar', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('no parece un manifest de dbt');

    await page.getByLabel('Formato de importación').selectOption('ddl');
    await page.getByLabel('Texto a importar').fill(fixture('ddl/tienda-oracle.sql'));
    await page.getByRole('button', { name: 'Importar', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText(/avisos? de la importación:/)).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'Sin mapear (el modelo de datos no los recoge)' })).toBeVisible();
  });
});
