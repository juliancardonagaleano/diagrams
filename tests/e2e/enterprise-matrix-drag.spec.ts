import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { canvasReady, docShot, selectView } from './canvas-helpers';

interface Relation {
  id: string;
  kind: string;
  sourceId: string;
  targetId: string;
  description?: string;
}
interface Doc {
  capabilities: Array<Record<string, unknown>>;
  relations: Relation[];
}

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/modulos.html?module=enterprise', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('module-canvas')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 20000 });
  await canvasReady(page);
  return errors;
}

/** El ejemplo más una capacidad sin aplicación (hueco), para tener una celda vacía donde soltar; deja la matriz abierta. */
async function openMatrix(page: Page): Promise<string[]> {
  const errors = await open(page);
  const doc = JSON.parse(readFileSync('examples/empresa-arquitectura.json', 'utf8')) as Doc;
  doc.capabilities.push({ id: 'analitica-negocio', name: 'Analítica de negocio', parentId: 'gestion-comercial', importance: 'differentiating', maturity: 1 });
  await page.getByRole('tab', { name: 'Vista SVG' }).click();
  await page.getByLabel('Documento JSON').fill(JSON.stringify(doc, null, 2));
  await page.getByRole('tab', { name: 'Lienzo' }).click();
  await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 20000 });
  await selectView(page, 'matrix');
  return errors;
}

/** El documento tal como está ahora en el editor de JSON (se vuelve al lienzo y se espera a que esté asentado). */
async function documentOf(page: Page): Promise<Doc> {
  await page.getByRole('tab', { name: 'Vista SVG' }).click();
  const doc = JSON.parse(await page.getByLabel('Documento JSON').inputValue()) as Doc;
  await page.getByRole('tab', { name: 'Lienzo' }).click();
  await canvasReady(page);
  return doc;
}

const cell = (capability: string, application: string): string => `node-cell:${capability}|${application}`;
const supports = (doc: Doc, app: string, cap: string): Relation | undefined => doc.relations.find((r) => r.kind === 'supports' && r.sourceId === app && r.targetId === cap);

const centre = async (page: Page, testId: string): Promise<{ x: number; y: number }> => {
  const box = (await page.getByTestId(testId).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

/** Arrastra un nodo hasta el centro de otro con el ratón; `beforeDrop` se ejecuta con el botón aún pulsado (para fotografiar el arrastre). */
async function drag(page: Page, from: string, to: string, beforeDrop?: () => Promise<unknown>): Promise<void> {
  const [a, b] = [await centre(page, from), await centre(page, to)];
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  // Con pasos cortos, como una mano: React Flow coloca el nodo con un evento de retraso, y las celdas de la matriz son pequeñas.
  await page.mouse.move(b.x, b.y, { steps: Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 6) });
  // Como una persona: al llegar, el lienzo tiene tiempo de pintar la última posición antes de que se suelte el botón.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await beforeDrop?.();
  await page.mouse.up();
}

const SHOTS = '/mnt/project-files/empresarial';
const toast = (page: Page) => page.locator('.wb-toast');

test.describe('lienzo empresarial: arrastrar celdas de la matriz capacidad × aplicación', () => {
  test('arrastrar una celda ● a otra mueve la relación «soporta», se guarda y es un solo paso de Deshacer y de Rehacer', async ({ page }) => {
    const errors = await openMatrix(page);
    const before = await documentOf(page);
    const original = supports(before, 'tienda-web', 'ventas-online')!;
    expect(original).toBeDefined();
    await expect(page.getByTestId(cell('ventas-online', 'tienda-web'))).toContainText('●');
    await expect(page.getByTestId('node-total:row:analitica-negocio')).toContainText('hueco');
    await expect(page.getByTestId('canvas-legend')).toContainText('Arrastra una celda con ● a otra');

    // Misma columna: la relación de «Tienda web» pasa de «Ventas online» a «Analítica de negocio».
    await drag(page, cell('ventas-online', 'tienda-web'), cell('analitica-negocio', 'tienda-web'), () => docShot(page, `${SHOTS}/empresarial-matriz-arrastrar-durante.png`));
    await expect(page.getByTestId(cell('analitica-negocio', 'tienda-web'))).toContainText('●');
    await expect(page.getByTestId(cell('ventas-online', 'tienda-web'))).not.toContainText('●');
    await expect(page.getByTestId('node-total:row:analitica-negocio')).not.toContainText('hueco');
    await expect(page.getByTestId('node-total:row:ventas-online')).toContainText('hueco');
    // Queda seleccionada la celda de destino: sus propiedades dicen que soporta.
    await expect(page.getByTestId('inspector').getByLabel('La aplicación soporta la capacidad')).toBeChecked();
    await docShot(page, `${SHOTS}/empresarial-matriz-arrastrar-despues.png`);

    const after = await documentOf(page);
    expect(after.relations).toHaveLength(before.relations.length);
    expect(supports(after, 'tienda-web', 'ventas-online')).toBeUndefined();
    expect(supports(after, 'tienda-web', 'analitica-negocio')).toMatchObject({ kind: 'supports', id: 'tienda-web-supports-analitica-negocio' });
    expect(after.relations.map((r) => r.id)).toEqual(before.relations.map((r) => (r.id === original.id ? 'tienda-web-supports-analitica-negocio' : r.id)));

    // Un solo paso: Deshacer devuelve el documento exacto de antes y Rehacer lo vuelve a mover.
    await page.getByRole('button', { name: 'Deshacer' }).click();
    expect(await documentOf(page)).toEqual(before);
    await expect(page.getByTestId(cell('ventas-online', 'tienda-web'))).toContainText('●');
    await page.getByRole('button', { name: 'Rehacer' }).click();
    expect(await documentOf(page)).toEqual(after);

    // Y se guarda como cualquier otro cambio: sobrevive a recargar.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await canvasReady(page);
    expect(await documentOf(page)).toEqual(after);
    expect(errors).toEqual([]);
  });

  test('en diagonal cambia la aplicación y la capacidad y la relación conserva su criterio', async ({ page }) => {
    const errors = await openMatrix(page);
    await page.getByTestId(cell('gestion-pedidos', 'erp')).click();
    const criterion = page.getByTestId('inspector').getByLabel('Criterio (por qué la soporta)');
    await criterion.fill('canal de venta asistida');
    await criterion.blur();
    await expect(criterion).toHaveValue('canal de venta asistida');
    const before = await documentOf(page);
    expect(supports(before, 'erp', 'gestion-pedidos')?.description).toBe('canal de venta asistida');

    await drag(page, cell('gestion-pedidos', 'erp'), cell('analitica-negocio', 'crm'));
    await expect(page.getByTestId(cell('analitica-negocio', 'crm'))).toContainText('●');
    await expect(page.getByTestId(cell('gestion-pedidos', 'erp'))).not.toContainText('●');
    const after = await documentOf(page);
    expect(supports(after, 'erp', 'gestion-pedidos')).toBeUndefined();
    expect(supports(after, 'crm', 'analitica-negocio')).toMatchObject({ description: 'canal de venta asistida' });
    expect(after.relations).toHaveLength(before.relations.length);

    await page.getByRole('button', { name: 'Deshacer' }).click();
    expect(await documentOf(page)).toEqual(before);
    expect(errors).toEqual([]);
  });

  test('lo que no se puede mover se avisa, la celda vuelve a su sitio y el documento no cambia', async ({ page }) => {
    const errors = await openMatrix(page);
    const before = await documentOf(page);
    const home = await centre(page, cell('gestion-pedidos', 'erp'));

    // La pareja de destino ya tiene la relación: no se duplica.
    await drag(page, cell('gestion-pedidos', 'erp'), cell('cobros', 'erp'));
    await expect(toast(page)).toContainText('«ERP corporativo» ya soporta «Cobros y pagos» (●)');
    await docShot(page, `${SHOTS}/empresarial-matriz-arrastrar-duplicada.png`);
    await expect.poll(async () => (await centre(page, cell('gestion-pedidos', 'erp'))).y).toBeCloseTo(home.y, 0);
    expect(await documentOf(page)).toEqual(before);

    // Una celda derivada (○: soporta por un proceso) no se arrastra.
    await expect(page.getByTestId(cell('gestion-pedidos', 'tienda-web'))).toContainText('○');
    await drag(page, cell('gestion-pedidos', 'tienda-web'), cell('analitica-negocio', 'tienda-web'));
    await expect(toast(page)).toContainText('por un proceso (○)');
    expect(await documentOf(page)).toEqual(before);

    // Ni una heredada (·)...
    await expect(page.getByTestId(cell('gestion-comercial', 'tienda-web'))).toContainText('·');
    await drag(page, cell('gestion-comercial', 'tienda-web'), cell('analitica-negocio', 'tienda-web'));
    await expect(toast(page)).toContainText('heredado de una capacidad hija (·)');
    expect(await documentOf(page)).toEqual(before);

    // ...ni se suelta una celda sobre algo que no es una celda.
    await drag(page, cell('gestion-pedidos', 'erp'), 'node-tienda-web');
    await expect(toast(page)).toContainText('otra celda de la matriz');
    expect(await documentOf(page)).toEqual(before);

    // Y una celda con marca directa sí se mueve, también en la misma fila (cambia la aplicación).
    await drag(page, cell('gestion-pedidos', 'erp'), cell('gestion-pedidos', 'wms-nuevo'));
    await expect(page.getByTestId(cell('gestion-pedidos', 'wms-nuevo'))).toContainText('●');
    expect(supports(await documentOf(page), 'wms-nuevo', 'gestion-pedidos')).toBeDefined();
    expect(errors).toEqual([]);
  });
});
