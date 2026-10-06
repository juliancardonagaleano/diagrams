import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { canvasReady, selectView } from './canvas-helpers';

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/modulos.html?module=platform', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('module-canvas')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 20000 });
  await canvasReady(page);
  return errors;
}

const docText = async (page: Page): Promise<string> => {
  await page.getByRole('tab', { name: 'Vista SVG' }).click();
  const text = await page.getByLabel('Documento JSON').inputValue();
  await page.getByRole('tab', { name: 'Lienzo' }).click();
  return text;
};

test.describe('lienzo de plataforma: infraestructura, metadatos y acciones', () => {
  test('cada recurso lleva su figura y las redes se trazan según su exposición, con insignias de coste y límites', async ({ page }) => {
    const errors = await open(page);
    await selectView(page, 'env:prod');
    await expect(page.locator('[data-testid="node-kafka-prod"][data-shape="pipe"]')).toBeVisible();
    await expect(page.locator('[data-testid="node-lb-prod"][data-shape="diamond"]')).toBeVisible();
    await expect(page.locator('[data-testid="node-pedidos-db-prod"][data-shape="cylinder"]')).toBeVisible();
    await expect(page.locator('[data-testid="node-subred-publica"].cv-group')).toHaveCSS('border-top-style', 'solid');
    await expect(page.locator('[data-testid="node-subred-apps"].cv-group')).toHaveCSS('border-top-style', 'dashed');
    await expect(page.locator('[data-testid="node-subred-datos"].cv-group')).toHaveCSS('border-top-style', 'dotted');
    await expect(page.locator('[data-testid="node-pedidos-db-prod"]')).toContainText('1.240 USD/mes');
    await expect(page.locator('[data-testid="node-i:pedidos-prod"]')).toContainText('SLO 99,95 %');
    await page.screenshot({ path: 'test-results/platform-env-prod.png' });
    expect(errors).toEqual([]);
  });

  test('la vista de costes agrupa por entorno con su total', async ({ page }) => {
    await open(page);
    await selectView(page, 'costs');
    await expect(page.locator('[data-testid="node-c:prod"].cv-group')).toContainText('4.420 USD/mes');
    await expect(page.locator('[data-testid="node-c:dev"].cv-group')).toContainText('660 USD/mes');
    await page.screenshot({ path: 'test-results/platform-costs.png' });
  });

  test('«Escalar réplicas» y «Promover a otro entorno» actúan sobre la selección', async ({ page }) => {
    await open(page);
    await selectView(page, 'env:prod');
    await expect(page.getByTestId('action-scale-replicas')).toBeDisabled();
    await page.locator('[data-testid="node-i:pedidos-prod"]').click();
    await page.getByTestId('action-scale-replicas').click();
    await page.getByTestId('action-prompt').getByRole('textbox').fill('+2');
    await page.getByTestId('action-prompt').getByRole('button', { name: 'Aceptar' }).click();
    await expect(page.locator('[data-testid="node-i:pedidos-prod"]')).toContainText('5 réplicas');
    await selectView(page, 'env:dev');
    await page.locator('[data-testid="node-i:reportes-dev"]').click();
    await page.getByTestId('action-promote-environment').click();
    await expect(page.getByTestId('action-prompt').getByRole('combobox')).toHaveValue('Producción');
    await page.getByTestId('action-prompt').getByRole('button', { name: 'Aceptar' }).click();
    expect(await docText(page)).not.toContain('"version": "0.3.5"');
  });

  test('«Duplicar entorno» crea el entorno nuevo con sus recursos', async ({ page }) => {
    await open(page);
    await selectView(page, 'env:dev');
    await page.locator('[data-testid="node-pedidos-db-dev"]').click();
    await page.getByTestId('action-duplicate-environment').click();
    await expect(page.getByTestId('action-prompt').getByRole('textbox')).toHaveValue('Desarrollo (copia)');
    await page.getByTestId('action-prompt').getByRole('textbox').fill('Pruebas de carga');
    await page.getByTestId('action-prompt').getByRole('button', { name: 'Aceptar' }).click();
    const text = await docText(page);
    expect(text).toContain('"name": "Pruebas de carga"');
    expect(text).toContain('pedidos-db-dev-pruebas-de-carga');
    await expect(page.getByTestId('canvas-view').locator('option', { hasText: 'Pruebas de carga' })).toHaveCount(1);
  });

  test('la vista «Comparar» pone dos entornos lado a lado y marca lo que difiere', async ({ page }) => {
    const errors = await open(page);
    await selectView(page, 'compare:dev:prod');
    await expect(page.locator('[data-testid="node-c:dev"].cv-group')).toContainText('Desarrollo');
    await expect(page.locator('[data-testid="node-c:prod"].cv-group')).toContainText('Producción');
    await expect(page.locator('[data-testid="node-i:pedidos-prod"]')).toContainText('Versión + réplicas');
    await expect(page.locator('[data-testid="node-i:pedidos-dev"]')).toContainText('3.1.0');
    await expect(page.locator('[data-testid="node-lb-prod"]')).toContainText('Solo en Producción');
    // Los recursos de nombre distinto por entorno («Kafka (dev)» y «Kafka (prod)») dicen en su línea cómo se emparejaron.
    await expect(page.getByText('emparejado por nombre normalizado')).toHaveCount(3);
    await page.screenshot({ path: 'test-results/platform-compare.png' });
    expect(errors).toEqual([]);
  });
});

/** Sustituye el documento por el ejemplo de nubes (AWS, Azure y un paquete propio de GCP) y vuelve al lienzo. */
async function loadClouds(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Vista SVG' }).click();
  await page.getByLabel('Documento JSON').fill(readFileSync('examples/plataforma-nubes.json', 'utf8'));
  await page.getByRole('tab', { name: 'Lienzo' }).click();
  await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 20000 });
}

const icon = (page: Page, id: string) => page.getByTestId(`node-${id}`).getByTestId(`icon-${id}`);

test.describe('lienzo de plataforma: iconos de proveedores de nube', () => {
  test('cada recurso se dibuja con el icono del servicio de su proveedor, con su color de acento', async ({ page }) => {
    const errors = await open(page);
    await loadClouds(page);
    await selectView(page, 'topology');
    await expect(icon(page, 'rds-pedidos')).toHaveAttribute('data-provider-icon', '#ec7211');
    await expect(icon(page, 'sql-dr')).toHaveAttribute('data-provider-icon', '#0078d4');
    await expect(icon(page, 'sql-analitica')).toHaveAttribute('data-provider-icon', '#1a73e8');
    await page.screenshot({ path: 'test-results/plataforma-iconos-aws-azure.png' });

    await selectView(page, 'env:aws-prod');
    for (const id of ['rds-pedidos', 'cache-prod', 'sqs-pedidos', 's3-facturas', 'secretos-prod', 'alb-prod', 'apigw-prod', 'ecr-prod', 'cdn-prod', 'dns-prod']) await expect(icon(page, id), id).toHaveAttribute('data-provider-icon', '#ec7211');
    // El clúster que aloja servicios y la VPC son zonas: la ficha va en su esquina superior derecha.
    await expect(icon(page, 'eks-prod')).toHaveClass(/cv-cloud-icon-zone/);
    await expect(icon(page, 'vpc-prod')).toHaveClass(/cv-cloud-icon-zone/);
    await expect(page.getByTestId('node-subred-datos').getByTestId('icon-subred-datos')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/plataforma-iconos-entorno-aws.png' });

    await selectView(page, 'env:azure-dr');
    for (const id of ['sql-dr', 'bus-dr', 'kv-dr', 'agw-dr', 'apim-dr', 'func-dr', 'blob-dr']) await expect(icon(page, id), id).toHaveAttribute('data-provider-icon', '#0078d4');
    await page.screenshot({ path: 'test-results/plataforma-iconos-entorno-azure.png' });
    expect(errors).toEqual([]);
  });

  test('el panel de propiedades elige el proveedor y el servicio de su paquete, y el icono cambia en el lienzo', async ({ page }) => {
    await open(page);
    await loadClouds(page);
    await selectView(page, 'env:aws-prod');
    await page.getByTestId('node-s3-facturas').click();
    const inspector = page.getByTestId('inspector');
    await expect(inspector.getByLabel('Proveedor de nube')).toHaveValue('aws');
    await expect(inspector.getByLabel('Servicio de nube').locator('option', { hasText: 'Amazon S3 (sugerido)' })).toHaveCount(1);
    await inspector.getByLabel('Proveedor de nube').selectOption('azure');
    await expect(inspector.getByLabel('Servicio de nube')).toHaveValue('blob-storage');
    await expect(icon(page, 's3-facturas')).toHaveAttribute('data-provider-icon', '#0078d4');
    await inspector.getByLabel('Proveedor de nube').selectOption('');
    await expect(page.getByTestId('node-s3-facturas').getByTestId('icon-s3-facturas')).toHaveCount(0);
    // Sin proveedor tampoco queda servicio en el documento.
    expect(await docText(page)).not.toContain('blob-storage');
  });
});

/** El ejemplo con una base analítica más en producción, que ningún nombre ni tecnología empareja con la de desarrollo. */
async function loadWithAnalytics(page: Page): Promise<void> {
  const doc = JSON.parse(readFileSync('examples/plataforma-ejemplo.json', 'utf8')) as Record<string, Array<Record<string, unknown>>>;
  doc.resources.push({ id: 'analitica-prod', name: 'Almacén analítico', kind: 'database', environmentId: 'prod', technology: 'Redshift', version: '2' });
  await page.getByRole('tab', { name: 'Vista SVG' }).click();
  await page.getByLabel('Documento JSON').fill(JSON.stringify(doc, null, 2));
  await page.getByRole('tab', { name: 'Lienzo' }).click();
  await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 20000 });
}

test.describe('lienzo de plataforma: equivalente en otro entorno (counterpartOf)', () => {
  test('elegir el equivalente en las propiedades manda sobre la deducción al comparar entornos, y la comparación lo explica', async ({ page }) => {
    const errors = await open(page);
    await loadWithAnalytics(page);
    await selectView(page, 'env:dev');
    await page.getByTestId('node-pedidos-db-dev').click();
    const inspector = page.getByTestId('inspector');
    const field = inspector.getByLabel('Equivalente en otro entorno');
    // Solo ofrece recursos de los demás entornos, primero los de su clase (bases de datos).
    await expect(field.locator('option[value="analitica-prod"]')).toHaveText('Almacén analítico (Producción)');
    await expect(field.locator('option[value="k8s-dev"]')).toHaveCount(0);
    await field.selectOption('analitica-prod');
    expect(await docText(page)).toContain('"counterpartOf": "analitica-prod"');

    await selectView(page, 'compare:dev:prod');
    // La base de desarrollo se empareja con la analítica porque lo declara; la «Base de pedidos» de producción queda sin pareja.
    await expect(page.getByText('emparejado por equivalencia declarada')).toHaveCount(1);
    await expect(page.getByText('emparejado por nombre normalizado')).toHaveCount(2);
    await expect(page.locator('[data-testid="node-pedidos-db-prod"]')).toContainText('Solo en Producción');
    await expect(page.locator('[data-testid="node-analitica-prod"]')).toContainText('Versión distinta');
    await page.screenshot({ path: 'test-results/plataforma-equivalente-declarado.png' });

    // En el recurso de producción, la pista dice quién lo declara como suyo; vaciar el campo deshace el emparejado.
    await selectView(page, 'env:prod');
    await page.getByTestId('node-analitica-prod').click();
    await expect(inspector.getByLabel('Equivalente en otro entorno')).toHaveAttribute('title', /Lo declaran como suyo: Base de pedidos \(dev\) \(Desarrollo\)\./);
    await selectView(page, 'env:dev');
    await page.getByTestId('node-pedidos-db-dev').click();
    await field.selectOption('');
    await selectView(page, 'compare:dev:prod');
    await expect(page.getByText('emparejado por equivalencia declarada')).toHaveCount(0);
    await expect(page.getByText('emparejado por nombre normalizado')).toHaveCount(3);
    expect(errors).toEqual([]);
  });

  test('«Duplicar entorno» declara las copias como equivalentes de sus originales', async ({ page }) => {
    await open(page);
    await selectView(page, 'env:dev');
    await page.locator('[data-testid="node-pedidos-db-dev"]').click();
    await page.getByTestId('action-duplicate-environment').click();
    await page.getByTestId('action-prompt').getByRole('textbox').fill('Pruebas de carga');
    await page.getByTestId('action-prompt').getByRole('button', { name: 'Aceptar' }).click();
    const text = await docText(page);
    expect(text).toContain('"counterpartOf": "pedidos-db-dev"');
    await selectView(page, 'env:pruebas-de-carga');
    await page.getByTestId('node-pedidos-db-dev-pruebas-de-carga').click();
    await expect(page.getByTestId('inspector').getByLabel('Equivalente en otro entorno')).toHaveValue('pedidos-db-dev');
  });
});
