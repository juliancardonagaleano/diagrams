import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
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

const example = readFileSync('examples/datos-catalogo.json', 'utf8');

interface Doc {
  assets: Array<{ id: string; kind: string; inputPorts?: string[]; outputPorts?: string[]; exposes?: string[]; owner?: string; domainId?: string }>;
  terms?: Array<{ id: string; name: string; status?: string; glossaryId?: string; links?: Array<{ assetId: string; column?: string }> }>;
}

/** Abre el módulo de datos con el ejemplo del catálogo (productos, API y glosario) cargado en el editor JSON. */
async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/modules/data?bank=1', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('module-canvas')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 20000 });
  await page.getByRole('tab', { name: 'Vista SVG' }).click();
  await page.getByLabel('Documento JSON').fill(example);
  await expect(page.getByTestId('editor-status')).toContainText('Válido');
  await page.getByRole('tab', { name: 'Lienzo' }).click();
  await canvasReady(page);
  return errors;
}

const readDoc = async (page: Page): Promise<Doc> => {
  await page.getByRole('tab', { name: 'Vista SVG' }).click();
  const text = await page.getByLabel('Documento JSON').inputValue();
  await page.getByRole('tab', { name: 'Lienzo' }).click();
  await canvasReady(page);
  return JSON.parse(text) as Doc;
};

/** Recoloca la vista (los nodos nuevos nacen en el centro, encima de otros) y espera a que se asiente. */
async function autolayout(page: Page): Promise<void> {
  await page.getByTestId('autolayout').click();
  await canvasReady(page);
}

/** Arrastra de la salida de un nodo a la entrada de otro con el tipo de relación elegido. */
async function connect(page: Page, kind: string, from: string, to: string): Promise<void> {
  await page.getByTestId('edge-kind').selectOption(kind);
  const a = (await page.getByTestId(`node-${from}`).locator('.react-flow__handle.source').boundingBox())!;
  const b = (await page.getByTestId(`node-${to}`).locator('.react-flow__handle.target').boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
}

test.describe('datos: producto de datos, API de datos y glosario', () => {
  test('la paleta ofrece los tipos nuevos, cada uno con su figura', async ({ page }) => {
    const errors = await open(page);
    for (const kind of ['data-product', 'glossary', 'data-api', 'term']) await expect(page.getByTestId(`add-${kind}`)).toBeVisible();
    await page.getByTestId('edge-kind').selectOption('publishes');
    await expect(page.getByTestId('edge-kind').locator('option')).toContainText(['Publica (salida de un producto)', 'Consume (entrada de un producto)', 'Expone (API de datos)', 'Define (término del glosario)']);
    expect(errors).toEqual([]);
  });

  test('el mapa de productos dibuja puertos de entrada y salida, la API y el SLA', async ({ page }) => {
    const errors = await open(page);
    await selectView(page, 'products');
    const product = page.getByTestId('node-ventas-360');
    await expect(product).toHaveAttribute('data-shape', 'cube');
    await expect(product).toContainText('frescura 24 h');
    await expect(product).toContainText('confidencial');
    await expect(page.getByTestId('node-api-ventas')).toHaveAttribute('data-shape', 'pill');
    await expect(page.getByTestId('node-api-ventas')).toContainText('REST');
    await expect(page.getByTestId('edge-label-consumes:silver-ventas>ventas-360')).toHaveText('entrada');
    await expect(page.getByTestId('edge-label-publishes:ventas-360>dwh-fact-ventas')).toHaveText('salida');
    await expect(page.getByTestId('edge-label-exposes:dwh-fact-ventas>api-ventas')).toHaveText('expuesto en');
    await shot(page, 'mapa-de-productos');
    // El inspector de un producto pide su dueño, su frescura y su SLA.
    await product.click();
    await expect(page.getByTestId('inspector').getByLabel('Frescura')).toHaveValue('24 h');
    await expect(page.getByTestId('inspector').getByLabel('SLA')).toContainText('99,5');
    await shot(page, 'tipos-nuevos');
    expect(errors).toEqual([]);
  });

  test('el glosario agrupa sus términos, que se enlazan a activos y columnas', async ({ page }) => {
    const errors = await open(page);
    await selectView(page, 'glossary');
    await expect(page.locator('.cv-group[data-kind="glossary"]')).toContainText('Glosario: Ventas y clientes');
    for (const term of ['cliente', 'venta', 'ingresos', 'fuga']) await expect(page.getByTestId(`node-${term}`)).toBeVisible();
    await expect(page.getByTestId('node-fuga')).toContainText('borrador');
    await expect(page.getByTestId('node-cliente')).toContainText('aprobado');
    await expect(page.getByTestId('edge-label-defines:ingresos>dwh-fact-ventas')).toHaveText('importe');
    await expect(page.getByTestId('edge-label-defines:ingresos>panel-ventas')).toHaveText('define');
    await shot(page, 'glosario-de-negocio');
    expect(errors).toEqual([]);
  });

  test('«Publica» y «Consume» crean los puertos de un producto y una relación inválida se explica', async ({ page }) => {
    const errors = await open(page);
    await selectView(page, 'products');
    await page.getByTestId('add-data-product').click();
    await expect(page.getByTestId('node-producto-de-datos-nuevo')).toBeVisible();
    await autolayout(page);

    await connect(page, 'publishes', 'producto-de-datos-nuevo', 'dwh-dim-cliente');
    await connect(page, 'consumes', 'silver-ventas', 'producto-de-datos-nuevo');
    await expect(page.getByTestId('edge-label-publishes:producto-de-datos-nuevo>dwh-dim-cliente')).toBeVisible();
    await expect(page.getByTestId('edge-label-consumes:silver-ventas>producto-de-datos-nuevo')).toBeVisible();
    const created = (await readDoc(page)).assets.find((a) => a.id === 'producto-de-datos-nuevo');
    expect(created).toMatchObject({ kind: 'data-product', outputPorts: ['dwh-dim-cliente'], inputPorts: ['silver-ventas'] });

    // Un activo no puede ser entrada y salida del mismo producto, ni una tabla exponer a otra.
    await connect(page, 'publishes', 'producto-de-datos-nuevo', 'silver-ventas');
    await expect(page.locator('.wb-toast')).toContainText('ya consume');
    await expect(page.locator('.wb-toast')).toHaveCount(0, { timeout: 8000 });
    await connect(page, 'exposes', 'silver-ventas', 'dwh-dim-cliente');
    await expect(page.locator('.wb-toast')).toContainText('«Expone» une una API de datos con un activo');
    expect(errors).toEqual([]);
  });

  test('un término nuevo nace dentro del glosario, se enlaza a un activo y se fija su columna en el inspector', async ({ page }) => {
    const errors = await open(page);
    await selectView(page, 'glossary');
    await page.locator('.cv-group[data-kind="glossary"] .cv-group-title').click();
    await page.getByTestId('add-term').click();
    const created = page.getByTestId('node-termino-nuevo');
    await expect(created).toContainText('sin enlace');
    expect((await readDoc(page)).terms?.find((t) => t.id === 'termino-nuevo')?.glossaryId).toBe('glosario-ventas');
    await autolayout(page);

    await connect(page, 'defines', 'termino-nuevo', 'erp-pedidos');
    // La relación recién creada queda seleccionada: su inspector pide la columna.
    await expect(page.getByTestId('edge-label-defines:termino-nuevo>erp-pedidos')).toHaveText('define');
    // La columna se elige entre las del activo enlazado (no se escribe), con «Todo el activo» como valor vacío.
    const column = page.getByTestId('inspector').getByLabel('Columna enlazada');
    await expect(column).toHaveValue('');
    await expect(column.locator('option')).toHaveText(['Todo el activo', 'id', 'cliente_id', 'fecha', 'total']);
    await column.selectOption('total');
    await expect(page.getByTestId('edge-label-defines:termino-nuevo>erp-pedidos')).toHaveText('total');
    const term = (await readDoc(page)).terms?.find((t) => t.id === 'termino-nuevo');
    expect(term?.links).toEqual([{ assetId: 'erp-pedidos', column: 'total' }]);
    await shot(page, 'termino-enlazado-a-columna');

    // El desplegable abierto (un `select` nativo no sale en una captura: se muestra como lista) y vuelta a «Todo el activo».
    await page.getByTestId('edge-label-defines:termino-nuevo>erp-pedidos').dispatchEvent('click');
    await expect(column).toHaveValue('total');
    await column.evaluate((el) => el.setAttribute('size', '5'));
    await shot(page, 'enlace-termino-columna-desplegable');
    await column.evaluate((el) => el.removeAttribute('size'));
    await column.selectOption('');
    await expect(page.getByTestId('edge-label-defines:termino-nuevo>erp-pedidos')).toHaveText('define');
    expect((await readDoc(page)).terms?.find((t) => t.id === 'termino-nuevo')?.links).toEqual([{ assetId: 'erp-pedidos' }]);

    // Estado del término desde su inspector.
    await page.getByTestId('node-fuga').click();
    await page.getByTestId('inspector').getByLabel('Estado').selectOption('approved');
    await expect(page.getByTestId('node-fuga')).toContainText('aprobado');
    expect(errors).toEqual([]);
  });

  test('«Agrupar en producto» crea un producto con los activos seleccionados y «Enlazar término» une términos y activos', async ({ page }) => {
    const errors = await open(page);
    await page.getByTestId('node-dwh-dim-cliente').click();
    await page.getByTestId('node-silver-ventas').click({ modifiers: ['Control'] });
    await page.getByTestId('action-group-product').click();
    await page.getByTestId('action-prompt').getByRole('combobox').fill('Clientes y ventas');
    await page.getByTestId('action-prompt').getByRole('button', { name: 'Aceptar' }).click();
    const product = (await readDoc(page)).assets.find((a) => a.id === 'clientes-y-ventas');
    expect(product).toMatchObject({ kind: 'data-product', outputPorts: ['silver-ventas', 'dwh-dim-cliente'], domainId: 'plataforma' });

    await selectView(page, 'glossary');
    await page.getByTestId('node-fuga').click();
    await page.getByTestId('node-dwh-dim-cliente').click({ modifiers: ['Control'] });
    await page.getByTestId('action-link-term').click();
    expect((await readDoc(page)).terms?.find((t) => t.id === 'fuga')?.links).toContainEqual({ assetId: 'dwh-dim-cliente' });
    expect(errors).toEqual([]);
  });

  test('borrar un activo quita sus puertos, y borrar el glosario, sus términos', async ({ page }) => {
    await open(page);
    await selectView(page, 'products');
    await page.getByTestId('node-silver-ventas').click();
    await page.keyboard.press('Delete');
    await expect(page.getByTestId('node-silver-ventas')).toHaveCount(0);
    const doc = await readDoc(page);
    expect(doc.assets.find((a) => a.id === 'ventas-360')?.inputPorts).toBeUndefined();

    await selectView(page, 'glossary');
    await page.locator('.cv-group[data-kind="glossary"] .cv-group-title').click();
    await page.keyboard.press('Delete');
    await expect(page.getByTestId('node-cliente')).toHaveCount(0);
    expect((await readDoc(page)).terms).toEqual([]);
  });
});
