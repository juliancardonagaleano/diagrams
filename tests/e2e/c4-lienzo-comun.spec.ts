import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { canvasReady, selectView } from './canvas-helpers';

/**
 * C4 en el lienzo común de la suite (`modulos.html?module=c4`): el mismo lienzo que los demás módulos, con las figuras, los niveles
 * y las operaciones de C4. El editor C4 clásico (`index.html`) sigue teniendo sus propias pruebas.
 */

const banca = (): Record<string, any> => JSON.parse(readFileSync(new URL('../../examples/banca.json', import.meta.url), 'utf8'));
const asFile = (name: string, doc: unknown) => ({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/modulos.html?module=c4', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('module-canvas')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 20000 });
  await canvasReady(page, 'contexto');
  return errors;
}

/** El documento C4 tal como está en la pestaña JSON (y de vuelta al lienzo). */
async function readDoc(page: Page): Promise<Record<string, any>> {
  await page.getByRole('tab', { name: 'Vista SVG' }).click();
  const text = await page.getByLabel('Documento JSON').inputValue();
  await page.getByRole('tab', { name: 'Lienzo' }).click();
  await canvasReady(page);
  return JSON.parse(text);
}

/** Arrastra de la salida de un nodo a la entrada de otro: crea una relación. */
async function connect(page: Page, from: string, to: string): Promise<void> {
  const a = (await page.getByTestId(`node-${from}`).locator('.react-flow__handle.source').first().boundingBox())!;
  const b = (await page.getByTestId(`node-${to}`).locator('.react-flow__handle.target').first().boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
}

/** Caja de un nodo en pantalla. */
const boxOf = async (page: Page, id: string) => (await page.getByTestId(`node-${id}`).boundingBox())!;

test.describe('C4 en el lienzo común', () => {
  test('se abre en el lienzo del banco, por niveles, con las figuras de C4 y sin editor incrustado', async ({ page }) => {
    const errors = await open(page);
    await expect(page.locator('iframe')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Lienzo' })).toHaveAttribute('aria-selected', 'true');
    // Un sistema es una caja en el contexto; en la vista de contenedores es el límite que rodea a los suyos.
    await expect(page.getByTestId('node-banca')).not.toHaveClass(/cv-group/);
    await expect(page.getByTestId('node-cliente')).toHaveAttribute('data-shape', 'actor');
    await expect(page.getByTestId('node-mainframe')).toBeVisible();
    await expect(page.getByTestId('canvas-view').locator('option')).toHaveCount(3);
    await selectView(page, 'contenedores');
    await expect(page.getByTestId('node-banca')).toHaveClass(/cv-group/);
    await expect(page.getByTestId('node-db')).toHaveAttribute('data-shape', 'cylinder');
    await expect(page.getByTestId('node-web-app')).toHaveAttribute('data-shape', 'card');
    await expect(page.getByTestId('node-mobile-app')).toHaveAttribute('data-shape', 'pill');
    await expect(page.getByTestId('node-api')).toContainText('[Java y Spring MVC]');
    // Los contenedores quedan dentro del límite de su sistema.
    const group = await boxOf(page, 'banca');
    for (const id of ['web-app', 'spa', 'mobile-app', 'api', 'db']) {
      const box = await boxOf(page, id);
      expect(box.x, id).toBeGreaterThanOrEqual(group.x - 1);
      expect(box.y, id).toBeGreaterThanOrEqual(group.y - 1);
      expect(box.x + box.width, id).toBeLessThanOrEqual(group.x + group.width + 1);
      expect(box.y + box.height, id).toBeLessThanOrEqual(group.y + group.height + 1);
    }
    await selectView(page, 'componentes-api');
    await expect(page.getByTestId('node-api')).toHaveClass(/cv-group/);
    await expect(page.getByTestId('node-signin')).toBeVisible();
    // Las relaciones tienen su etiqueta; las de la tecnología llevan corchetes.
    await expect(page.getByTestId('edge-label-r14')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('doble clic, Detallar y Alt+↓ bajan de nivel; Subir nivel y Alt+↑ suben; ninguno ensucia el deshacer', async ({ page }) => {
    const errors = await open(page);
    await expect(page.getByTestId('action-up')).toBeDisabled();
    await page.locator('[data-testid="node-banca"]').dblclick();
    await canvasReady(page, 'contenedores');
    await expect(page.getByTestId('node-db')).toBeVisible();
    await page.getByTestId('action-up').click();
    await canvasReady(page, 'contexto');
    // Alt+↓ con el sistema seleccionado, sin enlace: baja al detalle.
    await page.getByTestId('node-banca').click();
    await page.keyboard.press('Alt+ArrowDown');
    await canvasReady(page, 'contenedores');
    await page.getByTestId('node-api').click();
    await page.getByTestId('action-detail').click();
    await canvasReady(page, 'componentes-api');
    await expect(page.getByTestId('action-detail')).toBeDisabled();
    // La miga C1 › C2 › C3 muestra el camino y cada tramo abre su vista.
    await expect(page.getByTestId('canvas-breadcrumb').getByRole('button')).toHaveText(['C1 Contexto del sistema · Sistema de banca en línea', 'C2 Contenedores · Sistema de banca en línea', 'C3 Componentes · Aplicación API']);
    await page.getByTestId('crumb-contenedores').click();
    await canvasReady(page, 'contenedores');
    await page.getByTestId('node-api').click();
    await page.getByTestId('action-detail').click();
    await canvasReady(page, 'componentes-api');
    await page.keyboard.press('Alt+ArrowUp');
    await canvasReady(page, 'contenedores');
    await page.keyboard.press('Alt+ArrowUp');
    await canvasReady(page, 'contexto');
    await expect(page.getByTestId('canvas-breadcrumb')).toHaveCount(0);
    // Navegar no es editar: no hay nada que deshacer ni el documento ha cambiado.
    await expect(page.getByRole('button', { name: 'Deshacer' })).toBeDisabled();
    expect((await readDoc(page)).views).toEqual(banca().views);
    expect(errors).toEqual([]);
  });

  test('Detallar crea la vista de un sistema nuevo con su alcance y lo que se añade en ella cuelga del sistema', async ({ page }) => {
    const errors = await open(page);
    await page.getByTestId('add-softwareSystem').click();
    await expect(page.getByTestId('inspector').getByLabel('Nombre')).toHaveValue('Sistema nuevo');
    await page.getByTestId('action-detail').click();
    await canvasReady(page, 'container-sistema-nuevo');
    await expect(page.getByTestId('canvas-view').locator('option')).toHaveCount(4);
    await expect(page.getByTestId('canvas-view')).toHaveValue('container-sistema-nuevo');
    // Sin selección, un contenedor nuevo toma como padre el sistema de la vista y se dibuja dentro de su límite.
    await page.getByTestId('add-container').click();
    await expect(page.getByTestId('node-sistema-nuevo')).toHaveClass(/cv-group/);
    await canvasReady(page);
    const group = await boxOf(page, 'sistema-nuevo');
    const child = await boxOf(page, 'contenedor-nuevo');
    expect(child.x).toBeGreaterThanOrEqual(group.x - 1);
    expect(child.y).toBeGreaterThanOrEqual(group.y - 1);
    expect(child.x + child.width).toBeLessThanOrEqual(group.x + group.width + 1);
    expect(child.y + child.height).toBeLessThanOrEqual(group.y + group.height + 1);
    const doc = await readDoc(page);
    expect(doc.model.elements.find((e: { id: string }) => e.id === 'contenedor-nuevo')).toMatchObject({ type: 'container', parentId: 'sistema-nuevo' });
    expect(doc.views.find((v: { id: string }) => v.id === 'container-sistema-nuevo')).toMatchObject({ type: 'container', scopeId: 'sistema-nuevo' });
    // El documento sigue siendo válido y el lienzo no sube un error nuevo: solo avisos de calidad (sin descripción, sin relaciones…).
    await expect(page.getByTestId('editor-status')).toContainText('Válido');
    await expect(page.getByTestId('editor-status')).toContainText('0 errores');
    // Subir nivel vuelve a la vista que muestra el sistema.
    await page.getByTestId('action-up').click();
    await canvasReady(page, 'contexto');
    expect(errors).toEqual([]);
  });

  test('alta de elementos y relaciones, edición, borrado y deshacer, con el documento siempre válido', async ({ page }) => {
    const errors = await open(page);
    const before = banca();
    await page.getByTestId('add-person').click();
    const inspector = page.getByTestId('inspector');
    await expect(inspector.getByLabel('Nombre')).toHaveValue('Persona nueva');
    await inspector.getByLabel('Nombre').fill('Auditor');
    await inspector.getByLabel('Nombre').blur();
    await expect(page.getByTestId('node-persona-nueva')).toContainText('Auditor');
    await page.getByTestId('autolayout').click();
    await canvasReady(page);
    // Una relación se crea arrastrando de un elemento a otro y nace con la descripción «Usa».
    await connect(page, 'persona-nueva', 'banca');
    await expect(page.locator('[data-testid^="edge-label-persona-nueva--banca"]')).toContainText('Usa');
    let doc = await readDoc(page);
    expect(doc.model.relationships.find((r: { sourceId: string; targetId: string }) => r.sourceId === 'persona-nueva' && r.targetId === 'banca')).toMatchObject({ description: 'Usa' });
    // La misma relación otra vez no se repite.
    await connect(page, 'persona-nueva', 'banca');
    await expect(page.getByRole('status').filter({ hasText: 'Ya existe una relación' })).toBeVisible();
    expect((await readDoc(page)).model.relationships).toHaveLength(before.model.relationships.length + 1);
    // Editar la relación desde sus propiedades.
    await page.locator('[data-testid^="edge-label-persona-nueva--banca"]').click();
    await inspector.getByLabel('Descripción').fill('Revisa');
    await inspector.getByLabel('Descripción').blur();
    await expect(page.locator('[data-testid^="edge-label-persona-nueva--banca"]')).toContainText('Revisa');
    // Deshacer: la descripción, la relación, el nombre y, por fin, la persona; rehacer la devuelve.
    await page.keyboard.press('Control+z');
    await expect(page.locator('[data-testid^="edge-label-persona-nueva--banca"]')).toContainText('Usa');
    await page.keyboard.press('Control+z');
    await expect(page.locator('[data-testid^="edge-label-persona-nueva--banca"]')).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('node-persona-nueva')).toContainText('Persona nueva');
    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('node-persona-nueva')).toHaveCount(0);
    expect((await readDoc(page))).toEqual(before);
    await page.keyboard.press('Control+y');
    await expect(page.getByTestId('node-persona-nueva')).toBeVisible();
    // Supr borra el elemento y sus relaciones de una vez.
    await page.getByTestId('node-persona-nueva').click();
    await page.keyboard.press('Delete');
    await expect(page.getByTestId('node-persona-nueva')).toHaveCount(0);
    doc = await readDoc(page);
    expect(doc.model.elements.some((e: { id: string }) => e.id === 'persona-nueva')).toBe(false);
    await expect(page.getByTestId('editor-status')).toContainText('Válido');
    expect(errors).toEqual([]);
  });

  test('un contenedor se anida en otro sistema soltándolo sobre él, y se deshace de un paso', async ({ page }) => {
    const errors = await open(page);
    await selectView(page, 'contenedores');
    await page.getByTestId('add-softwareSystem').click();
    await expect(page.getByTestId('inspector').getByLabel('Nombre')).toHaveValue('Sistema nuevo');
    await page.getByTestId('autolayout').click();
    await canvasReady(page);
    // Arrastrar `db` al centro del sistema nuevo.
    const db = await boxOf(page, 'db');
    const target = await boxOf(page, 'sistema-nuevo');
    await page.mouse.move(db.x + db.width / 2, db.y + db.height / 2);
    await page.mouse.down();
    // El primer movimiento solo empieza el arrastre: se hace pequeño para que el resto lleve el centro del contenedor a donde se quiere.
    await page.mouse.move(db.x + db.width / 2 + 6, db.y + db.height / 2 + 6);
    await page.mouse.move(target.x + target.width / 2 + 6, target.y + target.height / 2 + 6, { steps: 15 });
    await page.mouse.up();
    await canvasReady(page);
    await expect(page.getByTestId('node-sistema-nuevo')).toHaveClass(/cv-group/);
    expect((await readDoc(page)).model.elements.find((e: { id: string }) => e.id === 'db')).toMatchObject({ parentId: 'sistema-nuevo' });
    await page.keyboard.press('Control+z');
    await canvasReady(page);
    await expect(page.getByTestId('node-sistema-nuevo')).not.toHaveClass(/cv-group/);
    expect((await readDoc(page)).model.elements.find((e: { id: string }) => e.id === 'db')).toMatchObject({ parentId: 'banca' });
    expect(errors).toEqual([]);
  });

  test('las propiedades cambian figura, color y padre, y la validación en vivo marca lo que el módulo da por error', async ({ page }) => {
    const errors = await open(page);
    await selectView(page, 'contenedores');
    await page.getByTestId('node-api').click();
    const inspector = page.getByTestId('inspector');
    await inspector.getByLabel('Figura').selectOption('queue');
    await expect(page.getByTestId('node-api')).toHaveAttribute('data-shape', 'pipe');
    await inspector.getByLabel('Color').fill('rojo');
    await inspector.getByLabel('Color').blur();
    await expect(page.getByRole('status').filter({ hasText: '#RRGGBB' })).toBeVisible();
    await inspector.getByLabel('Color').fill('#b91c1c');
    await inspector.getByLabel('Color').blur();
    await expect(page.getByTestId('node-api').locator('path').first()).toHaveAttribute('fill', '#b91c1c');
    // Un cambio de tipo que dejaría hijos huérfanos se rechaza con su motivo.
    await inspector.getByLabel('Tipo', { exact: true }).selectOption('person');
    await expect(page.getByRole('status').filter({ hasText: 'No se puede cambiar' })).toBeVisible();
    // Quitar el padre desde el JSON hace que el lienzo marque al contenedor y el estado cuente el error.
    await page.getByRole('tab', { name: 'Vista SVG' }).click();
    const editor = page.getByLabel('Documento JSON');
    const doc = JSON.parse(await editor.inputValue());
    delete doc.model.elements.find((e: { id: string }) => e.id === 'db').parentId;
    await editor.fill(JSON.stringify(doc, null, 2));
    await page.getByRole('tab', { name: 'Lienzo' }).click();
    await canvasReady(page);
    await expect(page.getByTestId('node-db')).toContainText('⚠ Sin padre');
    await expect(page.getByTestId('editor-status')).toContainText('1 errores');
    expect(errors).toEqual([]);
  });

  test('un elemento se enlaza a otro módulo desde sus propiedades: Alt+↓ (o el doble clic) lo sigue y Alt+↑ vuelve', async ({ page }) => {
    const errors = await open(page);
    await page.getByTestId('node-banca').click();
    const picker = page.getByTestId('ref-picker');
    await expect(picker).toContainText('Sin enlace');
    await picker.getByLabel('Módulo enlazado').selectOption('integration');
    await picker.getByLabel('Elemento enlazado').selectOption({ index: 1 });
    await expect(picker.locator('small')).toContainText('urn:iark:integration:');
    const urn = (await picker.locator('small').innerText()).split(' ')[0];
    const target = urn.replace('urn:iark:integration:', '');
    await expect(page.getByTestId('link-banca')).toBeVisible();
    expect((await readDoc(page)).model.elements.find((e: { id: string }) => e.id === 'banca')).toMatchObject({ ref: urn });
    // Con enlace, Alt+↓ lo sigue en lugar de bajar de nivel.
    await page.getByTestId('node-banca').click();
    await page.keyboard.press('Alt+ArrowDown');
    await expect(page.getByRole('tab', { name: 'Integración' })).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
    await expect(page.locator(`[data-testid="node-${target}"][data-selected]`)).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('trail')).toContainText('C4 · banca');
    // Alt+↑ vuelve a C4, a la vista y al elemento de donde se salió.
    await page.keyboard.press('Alt+ArrowUp');
    await expect(page.getByRole('tab', { name: 'C4' })).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
    await expect(page.getByTestId('trail')).toHaveCount(0);
    await expect(page.locator('[data-testid="node-banca"][data-selected]')).toBeVisible();
    await canvasReady(page, 'contexto');
    // El doble clic en un elemento enlazado también lo sigue.
    await page.locator('[data-testid="node-banca"]').dblclick();
    await expect(page.getByRole('tab', { name: 'Integración' })).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
    await page.getByTestId('trail-back').click();
    await expect(page.getByRole('tab', { name: 'C4' })).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
    expect(errors).toEqual([]);
  });

  test('Comparar marca en C4 lo nuevo, lo modificado y lo quitado, también como fantasma, y se quita de un clic', async ({ page }) => {
    const errors = await open(page);
    // La versión anterior: `cliente` se llamaba de otra forma, no existía el sistema de correo (ni sus relaciones) y había un contenedor de auditoría.
    const before = banca();
    before.model.elements = before.model.elements.filter((e: { id: string }) => e.id !== 'email');
    before.model.relationships = before.model.relationships.filter((r: { sourceId: string; targetId: string }) => r.sourceId !== 'email' && r.targetId !== 'email');
    before.model.elements.find((e: { id: string }) => e.id === 'cliente').name = 'Cliente de antes';
    before.model.elements.push({ id: 'auditoria', type: 'container', name: 'Auditoría', parentId: 'banca', technology: 'Kafka' });
    for (const view of before.views) {
      view.elements = view.elements.filter((e: { id: string }) => e.id !== 'email');
      if (view.id === 'contenedores') view.elements.push({ id: 'auditoria' });
    }
    await page.getByRole('tab', { name: /^Comparar/ }).click();
    await page.getByLabel('Abrir archivo a comparar…').setInputFiles(asFile('banca-anterior.json', before));
    await expect(page.getByTestId('compare-summary')).toBeVisible({ timeout: 20000 });
    await page.getByRole('tab', { name: 'Lienzo' }).click();
    await selectView(page, 'contenedores');
    await expect(page.getByTestId('compare-bar')).toContainText('Comparando con banca-anterior.json');
    await expect(page.getByTestId('compare-bar').locator('.wb-compare-legend')).toBeVisible();
    await expect(page.getByTestId('node-email')).toHaveAttribute('data-diff', 'added');
    await expect(page.getByTestId('node-cliente')).toHaveAttribute('data-diff', 'modified');
    await expect(page.getByTestId('node-auditoria')).toHaveAttribute('data-diff', 'removed');
    // La relación nueva (de la API al correo) lleva su halo.
    await expect(page.getByTestId('edge-diff-r13')).toBeAttached();
    // Lo que no cambió no se marca.
    await expect(page.getByTestId('node-db')).not.toHaveAttribute('data-diff', /./);
    await page.screenshot({ path: 'test-results/c4-comparar.png' });
    await page.getByTestId('compare-bar-clear').click();
    await expect(page.getByTestId('compare-bar')).toHaveCount(0);
    await expect(page.locator('[data-diff]')).toHaveCount(0);
    await expect(page.getByTestId('node-auditoria')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('lo que se edita queda en el borrador del banco y sobrevive a recargar la página', async ({ page }) => {
    await open(page);
    await selectView(page, 'contenedores');
    await page.getByTestId('add-container').click();
    await expect(page.getByTestId('node-contenedor-nuevo')).toBeVisible();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('module-canvas')).toBeVisible({ timeout: 20000 });
    await selectView(page, 'contenedores');
    await expect(page.getByTestId('node-contenedor-nuevo')).toBeVisible();
    await expect(page.getByTestId('node-banca')).toHaveClass(/cv-group/);
  });
});
