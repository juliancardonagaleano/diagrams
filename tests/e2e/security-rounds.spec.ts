import { expect, test, type Page } from '@playwright/test';
import { canvasReady, docShot, selectView } from './canvas-helpers';

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/modulos.html?module=security', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('module-canvas')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 20000 });
  await canvasReady(page);
  return errors;
}

test.describe('lienzo de seguridad: fronteras, sugerencias y protección', () => {
  test('las zonas se dibujan sin borde de frontera ni marcador en los flujos que cruzan', async ({ page }) => {
    const errors = await open(page);
    await expect(page.locator('[data-testid="node-internet"].cv-group')).not.toContainText('frontera de confianza');
    await expect(page.locator('[data-testid="node-internet"].cv-group')).not.toHaveCSS('border-top-color', 'rgb(201, 42, 42)');
    await expect(page.getByTestId('edge-mark-cliente-navega-0')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('la paleta añade identidad, secreto y canal de confianza con su figura propia', async ({ page }) => {
    const errors = await open(page);
    for (const kind of ['identity', 'secret', 'channel']) await page.getByTestId(`add-${kind}`).click();
    await expect(page.locator('[data-kind="identity"][data-shape="card"]')).toHaveCount(1);
    await expect(page.locator('[data-kind="secret"][data-shape="diamond"]')).toHaveCount(1);
    await expect(page.locator('[data-kind="channel"][data-shape="chevron"]')).toHaveCount(1);
    await docShot(page, '/mnt/project-files/seguridad/tipos-de-activo.png');
    expect(errors).toEqual([]);
  });

  test('sugerir amenazas propone STRIDE por cruce y se puede aceptar o descartar', async ({ page }) => {
    await open(page);
    await selectView(page, 'threats');
    const before = await page.locator('.react-flow__node').count();
    await page.getByTestId('action-suggest-threats').click();
    await expect.poll(() => page.locator('.react-flow__node').count()).toBeGreaterThan(before);
    await docShot(page, '/mnt/project-files/seguridad/ronda-sugerir-amenazas.png');
    await expect(page.getByTestId('action-accept-suggestion')).toBeDisabled();
  });

  test('proteger flujo se ofrece solo con un flujo seleccionado', async ({ page }) => {
    await open(page);
    await expect(page.getByTestId('action-protect-flow')).toBeDisabled();
    await expect(page.getByTestId('action-mitigate-threat')).toBeDisabled();
  });
});

const box = async (page: Page, id: string) => (await page.getByTestId(`node-${id}`).boundingBox())!;

test.describe('lienzo de seguridad: matriz de calor, estándares y superficie de ataque', () => {
  test('la matriz de calor 3×4 coloca cada amenaza en su celda y arrastrarla a otra cambia su probabilidad e impacto', async ({ page }) => {
    const errors = await open(page);
    await selectView(page, 'heatmap');
    await expect(page.locator('.cv-group[data-kind="cell"]')).toHaveCount(12);
    const inside = async (threat: string, cell: string): Promise<boolean> => {
      const [t, c] = [await box(page, threat), await box(page, cell)];
      return t.x >= c.x && t.y >= c.y && t.x + t.width <= c.x + c.width && t.y + t.height <= c.y + c.height;
    };
    await expect.poll(() => inside('idor-pedidos', 'cell:medium:high')).toBe(true);
    await docShot(page, '/mnt/project-files/seguridad/matriz-de-calor.png');

    // Arrastrar «IDOR» a la celda de probabilidad baja × impacto bajo.
    const from = await box(page, 'idor-pedidos');
    const to = await box(page, 'cell:low:low');
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect.poll(() => inside('idor-pedidos', 'cell:low:low')).toBe(true);
    await page.getByTestId('node-idor-pedidos').click();
    const inspector = page.getByTestId('inspector');
    await expect(inspector.getByLabel('Probabilidad')).toHaveValue('low');
    await expect(inspector.getByLabel('Impacto')).toHaveValue('low');
    await docShot(page, '/mnt/project-files/seguridad/matriz-de-calor-arrastre.png');
    expect(errors).toEqual([]);
  });

  test('la variante residual baja de celda las amenazas con controles implementados y no se arrastra', async ({ page }) => {
    await open(page);
    await selectView(page, 'heatmap');
    await selectView(page, 'heatmap:residual', 'canvas-variant');
    await expect(page.getByTestId('node-inyeccion-sql')).toContainText('residual');
    await expect.poll(async () => (await box(page, 'inyeccion-sql')).y).toBeGreaterThan((await box(page, 'cell:medium:high')).y);
    await docShot(page, '/mnt/project-files/seguridad/matriz-de-calor-residual.png');
  });

  test('la cobertura de estándares aparece al asignar un estándar a un control y marca lo que no cubre', async ({ page }) => {
    const errors = await open(page);
    await selectView(page, 'threats');
    await page.getByTestId('node-tls-borde').click();
    await page.getByTestId('inspector').getByLabel('Estándar').selectOption('asvs');
    await page.getByTestId('node-cifrado-reposo').click();
    await page.getByTestId('inspector').getByLabel('Estándar').selectOption('nist-800-53');
    await selectView(page, 'standards');
    await expect(page.locator('.cv-group[data-kind="catalog"]')).toHaveCount(2);
    await expect(page.getByTestId('node-correo-en-claro')).toContainText('sin cobertura');
    await expect(page.getByTestId('node-interceptacion')).toContainText('cubierta');
    await docShot(page, '/mnt/project-files/seguridad/cobertura-de-estandares.png');
    expect(errors).toEqual([]);
  });

  test('la superficie de ataque marca los activos expuestos y el radio de alcance', async ({ page }) => {
    const errors = await open(page);
    await selectView(page, 'surface');
    await expect(page.getByTestId('node-waf-lb')).toContainText('expuesto');
    await expect(page.getByTestId('node-pedidos')).toContainText('saltos');
    await docShot(page, '/mnt/project-files/seguridad/superficie-de-ataque.png');
    expect(errors).toEqual([]);
  });
});
