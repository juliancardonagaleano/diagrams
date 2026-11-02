import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { canvasReady, selectView } from './canvas-helpers';

// Pegar en el cuadro de «Importar» un `manifest.json` de dbt de ~128 KB (~5000 líneas) termina en un tiempo razonable.
// Chromium inserta un `insertText` de muchas líneas en un <textarea> línea a línea, con un diseño por cada salto, y el coste
// crece con el cuadrado de las líneas (53 s en este cuadro, 38 s en una página vacía). `fill()` y `keyboard.insertText()` pasan
// por ahí; el pegado real (Ctrl+V) no. El panel aplica de una vez las inserciones de muchas líneas (`useBulkInsert`).
const MANIFEST = readFileSync(new URL('../fixtures/importar/dbt/manifest-tienda.json', import.meta.url), 'utf8');
/** Muy por debajo de los ~50 s de antes y muy por encima de lo medido (~0,1 s), para no depender de la carga de la máquina. */
const LIMIT_MS = 8000;

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/modulos.html?bank=1&module=data', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('module-canvas')).toBeVisible({ timeout: 20000 });
  await canvasReady(page);
  await page.getByRole('tab', { name: 'Importar' }).click();
  return errors;
}

/** Tras poner el texto: se importa (el formato se reconoce por el contenido) y se ve el linaje de dbt. */
async function importAndCheck(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Importar', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByTestId('editor-status')).toContainText('Válido');
  await page.getByRole('tab', { name: 'Lienzo' }).click();
  await canvasReady(page);
  await selectView(page, 'lineage');
  for (const id of ['stg-clientes', 'fct-pedidos', 'panel-ventas']) await expect(page.getByTestId(`node-${id}`)).toBeVisible();
}

test.describe('datos: pegar un manifest de dbt grande en «Importar»', () => {
  test('el pegado real (Ctrl+V) del manifest termina enseguida y se importa', async ({ page }) => {
    const errors = await open(page);
    await page.evaluate((text) => navigator.clipboard.writeText(text), MANIFEST);
    const area = page.getByLabel('Texto a importar');
    await area.click();

    const start = Date.now();
    await page.keyboard.press('Control+V');
    await expect(area).toHaveValue(MANIFEST);
    expect(Date.now() - start).toBeLessThan(LIMIT_MS);
    await importAndCheck(page);
    expect(errors).toEqual([]);
  });

  test('la inserción de texto de golpe (fill) del manifest también termina enseguida y se importa', async ({ page }) => {
    const errors = await open(page);
    const area = page.getByLabel('Texto a importar');

    const start = Date.now();
    await area.fill(MANIFEST);
    await expect(area).toHaveValue(MANIFEST);
    expect(Date.now() - start).toBeLessThan(LIMIT_MS);
    // Pulsar teclas después sigue siendo ágil con el texto grande dentro.
    const typing = Date.now();
    await area.press('End');
    await page.keyboard.type('  ');
    expect(Date.now() - typing).toBeLessThan(LIMIT_MS);
    await importAndCheck(page);
    expect(errors).toEqual([]);
  });

  test('una inserción grande en mitad del texto sustituye la selección y deja el cursor justo detrás', async ({ page }) => {
    await open(page);
    const area = page.getByLabel('Texto a importar');
    await area.fill('PRINCIPIO [SELECCIONADO] FINAL');
    await area.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange('PRINCIPIO '.length, 'PRINCIPIO [SELECCIONADO]'.length));
    const chunk = Array.from({ length: 1500 }, (_, i) => `fila ${i + 1}`).join('\n');
    await page.keyboard.insertText(chunk);
    await expect(area).toHaveValue(`PRINCIPIO ${chunk} FINAL`);
    expect(await area.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([`PRINCIPIO ${chunk}`.length, `PRINCIPIO ${chunk}`.length]);
    // El cursor detrás de lo insertado: lo que se teclea ahora va ahí.
    await page.keyboard.type('!');
    await expect(area).toHaveValue(`PRINCIPIO ${chunk}! FINAL`);
  });
});
