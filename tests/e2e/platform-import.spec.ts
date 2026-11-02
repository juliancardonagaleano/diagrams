import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { canvasReady, selectView } from './canvas-helpers';

// Importar infraestructura real (Terraform, Kubernetes) en el banco de trabajo de plataforma y verla en el lienzo: la
// pestaña «Importar» deja el documento en el editor y la vista de despliegue de cada entorno lo dibuja.
const TF = 'tests/fixtures/importar/terraform';
const K8S = 'tests/fixtures/importar/kubernetes';

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/modulos.html?bank=1&module=platform', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('module-canvas')).toBeVisible({ timeout: 20000 });
  await canvasReady(page);
  return errors;
}

/** Elige un archivo en «Abrir archivo a importar…» (con el nombre indicado) y lo importa con el formato que se deduce. */
async function importFile(page: Page, name: string, path: string): Promise<void> {
  await page.getByRole('tab', { name: 'Importar' }).click();
  await page.getByLabel('Formato de importación').selectOption('');
  await page.locator('[role="tabpanel"] input[type="file"]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(readFileSync(path)) });
  await expect(page.getByLabel('Texto a importar')).not.toHaveValue('');
  await page.getByRole('button', { name: 'Importar', exact: true }).click();
}

test.describe('plataforma: importar Terraform y Kubernetes', () => {
  test('el formato de importación ofrece Mermaid, Terraform y Kubernetes', async ({ page }) => {
    await open(page);
    await page.getByRole('tab', { name: 'Importar' }).click();
    const options = await page.getByLabel('Formato de importación').locator('option').allTextContents();
    expect(options.join('|')).toContain('Terraform (.tf, .tf.json, .tfstate)');
    expect(options.join('|')).toContain('Kubernetes (.yaml, .yml)');
    expect(options.join('|')).toContain('Mermaid');
  });

  test('un .tf de AWS (VPC, EKS, RDS, SQS, ALB) se importa con sus avisos y se ve en la vista de despliegue del entorno', async ({ page }) => {
    const errors = await open(page);
    await importFile(page, 'tienda-aws.tf', `${TF}/aws-tienda/main.tf`);
    await expect(page.getByText(/Importado desde terraform con 5 avisos/)).toBeVisible();
    const notes = page.getByText(/avisos? de la importación:/).locator('..');
    await expect(notes).toContainText('aws_xray_group');
    await expect(notes).toContainText('1 red sin dato de exposición');

    await page.getByRole('tab', { name: 'Lienzo' }).click();
    await canvasReady(page);
    // Sin servicios solo hay la vista de despliegue del entorno (no hay selector de vistas): es la que se abre.
    await canvasReady(page, 'env:production');
    await expect(page.getByTestId('canvas-view')).toHaveCount(0);
    // Las redes se trazan según su exposición (pública continua, privada discontinua) y cada recurso lleva su figura.
    await expect(page.locator('[data-testid="node-public-a"].cv-group')).toHaveCSS('border-top-style', 'solid');
    await expect(page.locator('[data-testid="node-data-a"].cv-group')).toHaveCSS('border-top-style', 'dashed');
    await expect(page.locator('[data-testid="node-orders"][data-shape="cylinder"]')).toBeVisible();
    await expect(page.locator('[data-testid="node-orders"]')).toContainText('PostgreSQL');
    await expect(page.locator('[data-testid="node-public"][data-shape="diamond"]')).toBeVisible();
    await expect(page.locator('[data-testid="node-eks-cluster-main"]')).toBeVisible();
    await expect(page.locator('[data-testid="node-sqs-queue-orders"]')).toBeVisible();
    await page.screenshot({ path: 'test-results/platform-import-terraform.png' });
    expect(errors).toEqual([]);
  });

  test('un estado (.tfstate) también se importa y no deja la contraseña en el documento', async ({ page }) => {
    await open(page);
    await importFile(page, 'tienda-staging.tfstate', `${TF}/aws-tienda-staging/terraform.tfstate`);
    await expect(page.getByText(/Importado desde terraform/)).toBeVisible();
    await page.getByRole('tab', { name: 'Vista SVG' }).click();
    const text = await page.getByLabel('Documento JSON').inputValue();
    expect(text).toContain('"id": "staging"');
    expect(text).not.toContain('S3cr3t-p4ss');
    await page.getByRole('tab', { name: 'Lienzo' }).click();
    await canvasReady(page, 'env:staging');
    await expect(page.locator('[data-testid="node-orders"][data-shape="cylinder"]')).toBeVisible();
  });

  test('manifiestos de Kubernetes: servicios con réplicas sobre el clúster, almacenes como recursos y la puerta pública', async ({ page }) => {
    const errors = await open(page);
    await importFile(page, 'tienda-k8s.yaml', `${K8S}/tienda/manifests.yaml`);
    await expect(page.getByText(/Importado desde kubernetes con 5 avisos/)).toBeVisible();
    await expect(page.getByText(/avisos? de la importación:/).locator('..')).toContainText('Certificate (cert-manager.io)');

    await page.getByRole('tab', { name: 'Lienzo' }).click();
    await canvasReady(page);
    await selectView(page, 'env:production');
    await expect(page.locator('[data-testid="node-i:api-production"]')).toContainText('3 réplicas');
    await expect(page.locator('[data-testid="node-i:api-production"]')).toContainText('v2.4.1');
    await expect(page.locator('[data-testid="node-i:web-production"]')).toContainText('2 réplicas');
    await expect(page.locator('[data-testid="node-kubernetes"].cv-group')).toBeVisible();
    await expect(page.locator('[data-testid="node-postgres"][data-shape="cylinder"]')).toBeVisible();
    await expect(page.locator('[data-testid="node-redis"]')).toBeVisible();
    await expect(page.locator('[data-testid="node-ingress-tienda"]')).toBeVisible();
    await expect(page.locator('[data-testid="node-entrada-publica"].cv-group')).toHaveCSS('border-top-style', 'solid');
    await page.screenshot({ path: 'test-results/platform-import-kubernetes.png' });

    // La topología muestra las dependencias entre servicios y recursos.
    await selectView(page, 'topology');
    await expect(page.locator('[data-testid="node-api"]')).toBeVisible();
    await expect(page.locator('[data-testid="node-postgres"]')).toBeVisible();
    expect(await page.locator('.react-flow__edge').count()).toBeGreaterThan(5);
    expect(errors).toEqual([]);
  });

  test('un Terraform roto explica el error con la línea y no toca el documento actual', async ({ page }) => {
    await open(page);
    const before = await page.locator('.react-flow__node').count();
    await page.getByRole('tab', { name: 'Importar' }).click();
    await page.getByLabel('Texto a importar').fill('resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16\n}\n');
    await page.getByLabel('Formato de importación').selectOption('terraform');
    await page.getByRole('button', { name: 'Importar', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('El HCL de Terraform no es válido (línea 2): cadena sin cerrar');
    await page.getByRole('tab', { name: 'Lienzo' }).click();
    await canvasReady(page);
    expect(await page.locator('.react-flow__node').count()).toBe(before);
  });
});
