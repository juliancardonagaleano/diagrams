import { mkdirSync, readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { canvasReady } from './canvas-helpers';

// Los avisos de una importación se ven en la pestaña «Importar» venga la importación de donde venga: también tras
// «Abrir archivo…» del encabezado, que importa por `openText` y reemplaza el documento. Duran hasta que se importe otra
// cosa o se edite el documento.
const TF = 'tests/fixtures/importar/terraform';
const K8S = 'tests/fixtures/importar/kubernetes';

/** Si existe, las capturas se dejan también en la carpeta de salidas del proyecto. */
const SHOTS = process.env.AVISOS_SHOTS_DIR;
const shot = async (page: Page, name: string): Promise<void> => {
  await page.screenshot({ path: `test-results/${name}.png` });
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/${name}.png` });
  }
};

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/modulos.html?bank=1&module=platform', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('module-canvas')).toBeVisible({ timeout: 20000 });
  await canvasReady(page);
  return errors;
}

/** «Abrir archivo…» del encabezado (no el «Abrir archivo a importar…» del panel): importa por la extensión o el contenido. */
const openFromHeader = (page: Page, name: string, path: string): Promise<void> =>
  page.locator('.wb-actions input[type="file"]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(readFileSync(path)) });

test.describe('importar: avisos visibles tras «Abrir archivo…»', () => {
  test.use({ deviceScaleFactor: 2 });

  test('un .tf abierto desde el encabezado deja sus avisos en la pestaña Importar, que sigue mostrándolos al volver a ella', async ({ page }) => {
    const errors = await open(page);
    await expect(page.getByRole('tab', { name: 'Importar', exact: true })).toBeVisible();

    await openFromHeader(page, 'tienda-aws.tf', `${TF}/aws-tienda/main.tf`);
    await expect(page.getByText('Importado desde terraform con 5 avisos (se ven en la pestaña Importar)')).toBeVisible();
    // El contador de la pestaña avisa aunque se esté en el lienzo.
    const tab = page.getByRole('tab', { name: 'Importar (5)', exact: true });
    await expect(tab).toBeVisible();

    await tab.click();
    const notes = page.getByTestId('import-warnings');
    await expect(notes).toContainText('5 avisos de la importación:');
    await expect(notes).toContainText('Origen: terraform · tienda-aws.tf');
    await expect(notes).toContainText('aws_xray_group');
    await expect(notes).toContainText('1 red sin dato de exposición');
    await shot(page, 'importar-terraform-abrir-archivo-encabezado-panel-avisos');

    // Al cambiar de pestaña y volver siguen ahí (antes eran estado local del panel y se perdían).
    await page.getByRole('tab', { name: 'Lienzo' }).click();
    await canvasReady(page);
    await expect(page.getByTestId('import-warnings')).toHaveCount(0);
    await tab.click();
    await expect(page.getByTestId('import-warnings')).toContainText('aws_xray_group');
    expect(errors).toEqual([]);
  });

  test('otra importación sustituye los avisos; un documento JSON abierto o una edición los quitan', async ({ page }) => {
    await open(page);
    await openFromHeader(page, 'tienda-aws.tf', `${TF}/aws-tienda/main.tf`);
    await page.getByRole('tab', { name: 'Importar (5)', exact: true }).click();
    await expect(page.getByTestId('import-warnings')).toContainText('aws_xray_group');

    // Otro archivo importado desde el encabezado: los avisos pasan a ser los de este.
    await openFromHeader(page, 'tienda-k8s.yaml', `${K8S}/tienda/manifests.yaml`);
    await expect(page.getByTestId('import-warnings')).toContainText('Origen: kubernetes · tienda-k8s.yaml');
    await expect(page.getByTestId('import-warnings')).toContainText('Certificate (cert-manager.io)');
    await expect(page.getByTestId('import-warnings')).not.toContainText('aws_xray_group');

    // Un JSON que es un documento del módulo se carga tal cual, sin importar: no queda nada de la importación anterior.
    await openFromHeader(page, 'plataforma.json', 'examples/plataforma-ejemplo.json');
    await expect(page.getByTestId('import-warnings')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Importar', exact: true })).toBeVisible();

    // Una edición del documento descarta los avisos (aquí, desde el editor de texto).
    await openFromHeader(page, 'tienda-aws.tf', `${TF}/aws-tienda/main.tf`);
    await expect(page.getByTestId('import-warnings')).toBeVisible();
    const json = page.getByLabel('Documento JSON');
    await json.fill(`${await json.inputValue()}\n`);
    await expect(page.getByTestId('import-warnings')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Importar', exact: true })).toBeVisible();
  });

  test('«Abrir archivo a importar…» de la propia pestaña sigue mostrando sus avisos, también al volver a ella', async ({ page }) => {
    await open(page);
    await page.getByRole('tab', { name: 'Importar' }).click();
    await page.locator('[role="tabpanel"] input[type="file"]').setInputFiles({ name: 'tienda-k8s.yaml', mimeType: 'text/plain', buffer: Buffer.from(readFileSync(`${K8S}/tienda/manifests.yaml`)) });
    await expect(page.getByLabel('Texto a importar')).not.toHaveValue('');
    await page.getByRole('button', { name: 'Importar', exact: true }).click();
    await expect(page.getByTestId('import-warnings')).toContainText('Origen: kubernetes · tienda-k8s.yaml');
    await expect(page.getByRole('tab', { name: 'Importar (5)', exact: true })).toBeVisible();

    await page.getByRole('tab', { name: 'Exportar' }).click();
    await page.getByRole('tab', { name: 'Importar (5)', exact: true }).click();
    await expect(page.getByTestId('import-warnings')).toContainText('Certificate (cert-manager.io)');
  });
});
