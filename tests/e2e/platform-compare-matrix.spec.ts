import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { canvasReady, selectView } from './canvas-helpers';

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/modules/platform?bank=1', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('module-canvas')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 20000 });
  await canvasReady(page);
  return errors;
}

/**
 * Sustituye el documento por el ejemplo con una preproducción en medio: un servicio que solo corre en preproducción y producción
 * (Auditoría), otro que falta en preproducción (Notificaciones) y un balanceador que solo tienen preproducción y producción.
 */
async function loadThreeEnvironments(page: Page): Promise<void> {
  const doc = JSON.parse(readFileSync('examples/plataforma-ejemplo.json', 'utf8')) as Record<string, Array<Record<string, unknown>>>;
  doc.environments.splice(1, 0, { id: 'stg', name: 'Preproducción', kind: 'staging', provider: 'AWS', region: 'eu-west-1' });
  doc.resources.push(
    { id: 'k8s-stg', name: 'k8s-stg', kind: 'cluster', environmentId: 'stg', technology: 'Kubernetes', version: '1.28' },
    { id: 'pedidos-db-stg', name: 'Base de pedidos (stg)', kind: 'database', environmentId: 'stg', technology: 'PostgreSQL', version: '14' },
    { id: 'kafka-stg', name: 'Kafka (stg)', kind: 'queue', environmentId: 'stg', technology: 'Kafka' },
    { id: 'lb-stg', name: 'Balanceador público', kind: 'load-balancer', environmentId: 'stg', technology: 'AWS ALB' },
  );
  doc.services.push({ id: 'auditoria', name: 'Auditoría', owner: 'Equipo Finanzas' });
  const at = (id: string, serviceId: string, environmentId: string, hostId: string, version: string, replicas?: number): Record<string, unknown> => ({ id, serviceId, environmentId, hostId, version, ...(replicas ? { replicas } : {}) });
  doc.deployments.push(
    at('pedidos-stg', 'pedidos', 'stg', 'k8s-stg', '3.1.0', 2),
    at('tienda-web-stg', 'tienda-web', 'stg', 'k8s-stg', '2.4.0', 1),
    at('facturacion-stg', 'facturacion', 'stg', 'k8s-stg', '1.7.4', 1),
    at('reportes-stg', 'reportes', 'stg', 'k8s-stg', '0.4.0'),
    at('auditoria-stg', 'auditoria', 'stg', 'k8s-stg', '0.1.0', 1),
    at('auditoria-prod', 'auditoria', 'prod', 'k8s-prod', '0.1.0', 2),
  );
  await page.getByRole('tab', { name: 'Vista SVG' }).click();
  await page.getByLabel('Documento JSON').fill(JSON.stringify(doc, null, 2));
  await page.getByRole('tab', { name: 'Lienzo' }).click();
  await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 20000 });
}

const box = async (page: Page, id: string): Promise<{ x: number; y: number; width: number; height: number }> => {
  const b = await page.getByTestId(`node-${id}`).boundingBox();
  if (!b) throw new Error(`El nodo ${id} no está dibujado`);
  return b;
};

test.describe('lienzo de plataforma: comparar tres o más entornos', () => {
  test('el selector lista los pares consecutivos y la matriz de todos los entornos', async ({ page }) => {
    const errors = await open(page);
    await loadThreeEnvironments(page);
    const compare = page.getByTestId('canvas-view').locator('option[value^="compare:"]');
    await expect(compare).toHaveCount(3);
    await expect(compare.nth(0)).toHaveAttribute('value', 'compare:dev:stg');
    await expect(compare.nth(1)).toHaveAttribute('value', 'compare:stg:prod');
    await expect(compare.nth(2)).toHaveAttribute('value', 'compare:all');
    await expect(compare.nth(2)).toHaveText(/Comparación de todos los entornos/);
    expect(errors).toEqual([]);
  });

  test('«todos» es una matriz: una columna por entorno, una fila por servicio o recurso, y lo que difiere de la referencia marcado', async ({ page }) => {
    const errors = await open(page);
    await loadThreeEnvironments(page);
    await selectView(page, 'compare:all');
    await expect(page.locator('[data-testid="node-c:dev"].cv-group')).toContainText('A · Desarrollo (referencia)');
    await expect(page.locator('[data-testid="node-c:stg"].cv-group')).toContainText('B · Preproducción');
    await expect(page.locator('[data-testid="node-c:prod"].cv-group')).toContainText('C · Producción');
    await expect(page.getByTestId('node-i:pedidos-dev')).toContainText('Referencia');
    await expect(page.getByTestId('node-i:pedidos-stg')).toContainText('Réplicas distintas');
    await expect(page.getByTestId('node-i:pedidos-prod')).toContainText('Versión + réplicas');
    await expect(page.getByTestId('node-i:pedidos-prod')).toContainText('v3.0.2 · 3 réplicas');
    await expect(page.getByTestId('node-i:tienda-web-stg')).toContainText('Igual que A');
    await expect(page.getByTestId('node-m:notificaciones:stg')).toContainText('Falta aquí');
    await expect(page.getByTestId('node-i:auditoria-prod')).toContainText('No está en A');
    await expect(page.getByTestId('node-lb-stg')).toContainText('No está en A');
    await expect(page.getByTestId('node-k8s-stg')).toContainText('emparejado por nombre normalizado');
    await expect(page.getByTestId('canvas-legend')).toContainText('Versión distinta');

    // Cuadrícula: el mismo servicio está en la misma fila en las tres columnas, y las columnas van en orden.
    const [dev, stg, prod] = await Promise.all(['i:pedidos-dev', 'i:pedidos-stg', 'i:pedidos-prod'].map((id) => box(page, id)));
    expect(Math.abs(dev.y - stg.y)).toBeLessThan(2);
    expect(Math.abs(stg.y - prod.y)).toBeLessThan(2);
    expect(dev.x).toBeLessThan(stg.x);
    expect(stg.x).toBeLessThan(prod.x);
    expect(Math.abs(dev.width - prod.width)).toBeLessThan(2);
    const gap = await box(page, 'm:notificaciones:stg');
    expect(Math.abs(gap.y - (await box(page, 'i:notificaciones-dev')).y)).toBeLessThan(2);
    await page.screenshot({ path: 'test-results/platform-compare-matrix.png' });
    expect(errors).toEqual([]);
  });

  test('una celda se selecciona y abre las propiedades de su instancia; la comparación de dos entornos sigue como siempre', async ({ page }) => {
    const errors = await open(page);
    await loadThreeEnvironments(page);
    await selectView(page, 'compare:all');
    await page.getByTestId('node-i:pedidos-prod').click();
    await expect(page.getByTestId('inspector').getByLabel('Versión desplegada')).toHaveValue('3.0.2');
    await selectView(page, 'compare:stg:prod');
    await expect(page.locator('[data-testid="node-c:stg"].cv-group')).toContainText('A · Preproducción');
    await expect(page.getByTestId('node-i:pedidos-prod')).toContainText('Versión + réplicas');
    await expect(page.getByText('emparejado por nombre normalizado')).toHaveCount(3);
    expect(errors).toEqual([]);
  });
});
