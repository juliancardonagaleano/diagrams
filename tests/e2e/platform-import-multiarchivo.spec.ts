import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { canvasReady } from './canvas-helpers';

// Terraform repartido en varios .tf: «Abrir archivo a importar…» del panel Importar admite selección múltiple cuando todos son
// del mismo formato (.tf); se juntan en orden alfabético y se importan como un solo stack (el de la carpeta de la prueba del CLI).
const FOLDER = 'tests/fixtures/importar/terraform/aws-tienda-multiarchivo';
const tfFiles = readdirSync(FOLDER)
  .filter((n) => n.endsWith('.tf'))
  .sort();
const upload = (names: string[]) => names.map((name) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(readFileSync(`${FOLDER}/${name}`)) }));

/** Si existe, las capturas se dejan también en la carpeta de salidas del proyecto. */
const SHOTS = process.env.TERRAFORM_SHOTS_DIR;
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
  await page.goto('/modulos.html?module=platform', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('module-canvas')).toBeVisible({ timeout: 20000 });
  await canvasReady(page);
  await page.getByRole('tab', { name: 'Importar' }).click();
  return errors;
}

test.describe('plataforma: importar varios .tf a la vez', () => {
  test.use({ deviceScaleFactor: 2 });

  test('varios .tf se juntan en orden alfabético y se importan como un solo stack, con sus avisos y su lienzo', async ({ page }) => {
    const errors = await open(page);
    // Se eligen en desorden: el resultado no depende del orden.
    await page.locator('[role="tabpanel"] input[type="file"]').setInputFiles(upload([...tfFiles].reverse()));
    await expect(page.getByTestId('import-files')).toContainText(`${tfFiles.length} archivos se importan juntos (en orden alfabético): ${tfFiles.join(', ')}.`);
    await expect(page.getByLabel('Texto a importar')).not.toHaveValue('');

    await page.getByRole('button', { name: 'Importar', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText(/Importado desde terraform con 5 avisos/)).toBeVisible();
    const notes = page.getByText(/avisos? de la importación:/).locator('..');
    await expect(notes).toContainText('aws_xray_group');
    await expect(notes).toContainText('1 red sin dato de exposición');
    await expect(notes).toContainText('module.observabilidad');
    await shot(page, 'importar-terraform-multiarchivo-panel');

    await page.getByRole('tab', { name: 'Lienzo' }).click();
    await canvasReady(page, 'env:production');
    // Las referencias entre archivos se resuelven: las redes, la base de datos (datos.tf), la cola, el clúster (computo.tf) y el balanceador (entrada.tf).
    await expect(page.locator('[data-testid="node-public-a"].cv-group')).toHaveCSS('border-top-style', 'solid');
    await expect(page.locator('[data-testid="node-data-a"].cv-group')).toHaveCSS('border-top-style', 'dashed');
    await expect(page.locator('[data-testid="node-orders"][data-shape="cylinder"]')).toContainText('PostgreSQL');
    await expect(page.locator('[data-testid="node-public"][data-shape="diamond"]')).toBeVisible();
    await expect(page.locator('[data-testid="node-eks-cluster-main"]')).toBeVisible();
    await expect(page.locator('[data-testid="node-sqs-queue-orders"]')).toBeVisible();
    await shot(page, 'importar-terraform-multiarchivo-lienzo-despliegue');
    expect(errors).toEqual([]);
  });

  test('es el mismo stack que importar los mismos textos concatenados en un solo cuadro', async ({ page }) => {
    await open(page);
    await page.locator('[role="tabpanel"] input[type="file"]').setInputFiles(upload(tfFiles));
    const joined = await page.getByLabel('Texto a importar').inputValue();
    await page.getByRole('button', { name: 'Importar', exact: true }).click();
    await expect(page.getByText(/Importado desde terraform/)).toBeVisible();
    const withFiles = await page.getByLabel('Documento JSON').inputValue();

    // Lo mismo, pero pegando el texto concatenado a mano (sin el detalle por archivo): el documento es idéntico.
    await page.getByLabel('Texto a importar').fill(`${joined} `);
    await page.getByLabel('Formato de importación').selectOption('terraform');
    await page.getByRole('button', { name: 'Importar', exact: true }).click();
    await expect.poll(async () => (await page.getByLabel('Documento JSON').inputValue()) === withFiles).toBe(true);
  });

  test('con archivos de distinto formato avisa y no toca el documento; un solo .tf sigue importándose como siempre', async ({ page }) => {
    await open(page);
    const before = await page.getByLabel('Documento JSON').inputValue();
    await page.locator('[role="tabpanel"] input[type="file"]').setInputFiles([
      ...upload(['red.tf']),
      { name: 'tienda.yaml', mimeType: 'text/plain', buffer: Buffer.from(readFileSync('tests/fixtures/importar/kubernetes/tienda/manifests.yaml')) },
    ]);
    await expect(page.getByRole('alert')).toContainText('Los archivos (red.tf, tienda.yaml) no son todos del mismo formato: solo se leen juntos los .tf o los .yaml, .yml.');
    await expect(page.getByTestId('import-files')).toHaveCount(0);
    await expect(page.getByLabel('Texto a importar')).toHaveValue('');
    expect(await page.getByLabel('Documento JSON').inputValue()).toBe(before);

    await page.locator('[role="tabpanel"] input[type="file"]').setInputFiles(upload(['datos.tf']));
    await expect(page.getByLabel('Texto a importar')).not.toHaveValue('');
    await expect(page.getByTestId('import-files')).toHaveCount(0);
  });
});
