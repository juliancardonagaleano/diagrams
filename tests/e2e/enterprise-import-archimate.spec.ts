import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { canvasReady, selectView } from './canvas-helpers';

const FIXTURES = 'tests/fixtures/importar/archimate';
/** Las capturas van a `test-results` salvo que `E2E_SHOTS` indique otra carpeta. */
const SHOTS = process.env.E2E_SHOTS ?? 'test-results';
const shot = (page: Page, name: string): Promise<Buffer> => page.screenshot({ path: `${SHOTS}/${name}.png` });

// Un lienzo grande y con más densidad de píxeles: el paisaje del modelo de ejemplo tiene 66 elementos y se lee mejor al ampliar la captura.
test.use({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 });

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/modulos.html?bank=1&module=enterprise', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('module-canvas')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 20000 });
  await canvasReady(page);
  return errors;
}

/** Abre el archivo con el selector de «Importar» (el formato se reconoce por la extensión o el contenido). */
async function importFile(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  await page.getByRole('tab', { name: 'Importar' }).click();
  await page.getByRole('tabpanel', { name: 'Importar' }).locator('input[type="file"]').setInputFiles(file);
  await page.getByRole('button', { name: 'Importar', exact: true }).click();
}

const decode = (src: string | null): string => decodeURIComponent((src ?? '').replace(/^data:image\/svg\+xml;charset=utf-8,/, ''));

test.describe('importar ArchiMate en el módulo empresarial', () => {
  test('un modelo del formato de intercambio se ve en el mapa de capacidades, el paisaje y el impacto', async ({ page }) => {
    const errors = await open(page);
    await importFile(page, `${FIXTURES}/comercio-andino.xml`);

    // El editor recibe el documento y el panel resume lo que no se pudo traer.
    await expect(page.getByText(/Importado desde archimate con \d+ avisos/)).toBeVisible();
    const panel = page.getByRole('tabpanel', { name: 'Importar' });
    await expect(panel).toContainText('4 elementos de motivación sin equivalente en el módulo, no se importan (Driver, Goal, Requirement, Stakeholder)');
    await expect(panel).toContainText('2 vistas (diagramas) no se importan');
    await expect(panel).toContainText('Propiedades sin equivalente en el módulo, no se importan');
    await shot(page, 'empresarial-importar-archimate-avisos');

    // Mapa de capacidades: las 16 capacidades con su jerarquía.
    await page.getByRole('tab', { name: 'Lienzo' }).click();
    await selectView(page, 'capabilities');
    for (const id of ['gestion-comercial', 'ventas-online', 'gestion-de-inventario', 'distribucion-y-entrega', 'fidelizacion']) {
      await expect(page.getByTestId(`node-${id}`)).toBeVisible();
    }
    await expect(page.getByTestId('node-ventas-online')).toContainText('Ventas online');
    await expect(page.getByTestId('canvas-legend')).toContainText('Color: madurez');
    await shot(page, 'empresarial-importar-archimate-mapa-de-capacidades');

    // Paisaje de aplicaciones: aplicaciones con su coste y estrategia, tecnologías y unidades.
    await selectView(page, 'landscape');
    await expect(page.getByTestId('node-tienda-online')).toBeVisible();
    await expect(page.getByTestId('node-tienda-online')).toContainText('estrategia conservar');
    await expect(page.getByTestId('node-wms-heredado')).toContainText('estrategia reemplazar');
    await expect(page.getByTestId('node-sap-hana-2-0')).toContainText('soporte hasta 2034-12');
    await expect(page.getByTestId('node-ventas')).toHaveAttribute('data-kind', 'unit');
    await shot(page, 'empresarial-importar-archimate-paisaje-de-aplicaciones');

    // Lo importado se edita como cualquier otro documento: el inspector lee el coste que venía en la propiedad «Coste anual».
    await page.getByTestId('node-erp-corporativo').click();
    await expect(page.getByTestId('inspector').getByLabel('Coste anual')).toHaveValue('1200000');
    await expect(page.getByTestId('inspector').getByLabel('Estrategia de modernización')).toHaveValue('keep');

    // Impacto de una tecnología: lo que se apoya en SAP HANA (el ERP y lo que este sostiene).
    await page.getByRole('tab', { name: 'Vista SVG' }).click();
    await page.getByLabel('Vista', { exact: true }).selectOption('impact:sap-hana-2-0');
    const image = page.getByTestId('diagram-stage').getByRole('img');
    await expect(image).toHaveAttribute('data-view', 'impact:sap-hana-2-0', { timeout: 20000 });
    await expect.poll(async () => decode(await image.getAttribute('src')), { timeout: 20000 }).toContain('ERP corporativo');
    const svg = decode(await image.getAttribute('src'));
    expect(svg).toContain('SAP HANA 2.0');
    expect(svg).toContain('Facturación');
    await shot(page, 'empresarial-importar-archimate-impacto-de-sap-hana');

    expect(errors).toEqual([]);
  });

  test('un modelo nativo de Archi (.archimate) se reconoce por la extensión y sus uniones y eventos se resuelven', async ({ page }) => {
    const errors = await open(page);
    await importFile(page, `${FIXTURES}/tienda-archi.archimate`);
    await expect(page.getByText(/Importado desde archimate con \d+ avisos/)).toBeVisible();
    await expect(page.getByRole('tabpanel', { name: 'Importar' })).toContainText('1 evento no se importa como elemento: sus relaciones se sustituyen por relaciones directas entre sus extremos');

    await page.getByRole('tab', { name: 'Lienzo' }).click();
    await selectView(page, 'landscape');
    await expect(page.getByTestId('node-tpv')).toBeVisible();
    await expect(page.getByTestId('node-tpv')).toContainText('2 k/año · 3 usuarios');
    await expect(page.getByTestId('node-hoja-de-existencias')).toContainText('estrategia migrar');
    await expect(page.getByTestId('node-tablet-de-caja')).toBeVisible();
    await selectView(page, 'value-stream');
    await expect(page.getByTestId('node-entrar')).toBeVisible();
    await expect(page.getByTestId('node-pagar')).toBeVisible();
    await shot(page, 'empresarial-importar-archimate-formato-de-archi');
    expect(errors).toEqual([]);
  });

  test('un XML roto o que no es ArchiMate se rechaza con un mensaje claro y no toca el documento', async ({ page }) => {
    const errors = await open(page);
    await page.getByRole('tab', { name: 'Vista SVG' }).click();
    const before = await page.getByLabel('Documento JSON').inputValue();

    await importFile(page, { name: 'roto.xml', mimeType: 'application/xml', buffer: readFileSync(`${FIXTURES}/xml-roto.xml`) });
    await expect(page.getByRole('alert')).toContainText('XML mal formado: se esperaba «</elements>» (abierta en la línea 8, columna 3) y se encontró «</model>» (línea 20, columna 1).');

    // Un XML de otro formato (sin nombre de archivo que oriente) no lo reclama ArchiMate; si se fuerza, dice por qué no vale.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await canvasReady(page);
    await page.getByRole('tab', { name: 'Importar' }).click();
    await page.getByLabel('Texto a importar').fill('<?xml version="1.0"?><mxfile><diagram/></mxfile>');
    await page.getByRole('button', { name: 'Importar', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('No se reconoce el formato');
    await page.getByLabel('Formato de importación').selectOption('archimate');
    await page.getByRole('button', { name: 'Importar', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('La raíz del XML es «mxfile»');

    await page.getByRole('tab', { name: 'Vista SVG' }).click();
    expect(await page.getByLabel('Documento JSON').inputValue()).toBe(before);
    expect(errors).toEqual([]);
  });
});
