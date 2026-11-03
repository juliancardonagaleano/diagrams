import { expect, test, type Page } from '@playwright/test';
import { canvasReady, selectView } from './canvas-helpers';

async function open(page: Page, module = 'integration'): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/modules/${module}?bank=1`, { waitUntil: 'domcontentloaded' });
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

test.describe('lienzo interactivo de módulos', () => {
  test('integración se abre en el lienzo con figuras propias por tipo', async ({ page }) => {
    const errors = await open(page);
    await expect(page.getByRole('tab', { name: 'Lienzo' })).toHaveAttribute('aria-selected', 'true');
    for (const shape of ['cylinder', 'fan', 'hexagon', 'chevron', 'actor', 'clock', 'diamond', 'card']) {
      await expect(page.locator(`[data-shape="${shape}"]`).first(), shape).toBeVisible();
    }
    await page.screenshot({ path: 'test-results/canvas-integration.png' });
    expect(errors).toEqual([]);
  });

  test('añadir un nodo desde la barra lo escribe en el documento y se deshace con Ctrl+Z / Ctrl+Y', async ({ page }) => {
    await open(page);
    const before = await page.locator('.react-flow__node').count();
    await page.getByTestId('add-store').click();
    await expect(page.locator('.react-flow__node')).toHaveCount(before + 1);
    expect(await docText(page)).toContain('Almacén nuevo');
    await page.keyboard.press('Control+z');
    await expect(page.locator('.react-flow__node')).toHaveCount(before);
    await page.keyboard.press('Control+y');
    await expect(page.locator('.react-flow__node')).toHaveCount(before + 1);
  });

  test('seleccionar un nodo abre sus propiedades, editarlas cambia el documento y Supr lo borra', async ({ page }) => {
    await open(page);
    await page.getByTestId('add-system').click();
    const inspector = page.getByTestId('inspector');
    await expect(inspector).toBeVisible();
    const name = inspector.getByLabel('Nombre');
    await name.fill('Nómina Z');
    await name.blur();
    await expect(page.locator('.react-flow__node', { hasText: 'Nómina Z' })).toBeVisible();
    await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } });
    await page.locator('.react-flow__node', { hasText: 'Nómina Z' }).click();
    await page.keyboard.press('Delete');
    await expect(page.locator('.react-flow__node', { hasText: 'Nómina Z' })).toHaveCount(0);
    expect(await docText(page)).not.toContain('Nómina Z');
  });

  test('los atajos se listan y Ctrl+L recoloca la vista', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Atajos de teclado' }).click();
    await expect(page.getByTestId('shortcuts')).toContainText('Ctrl/⌘ + L');
    await page.keyboard.press('Control+l');
    await expect(page.locator('.react-flow__node').first()).toBeVisible();
  });

  test('un documento roto avisa en el lienzo y las demás pestañas siguen ahí', async ({ page }) => {
    await open(page);
    await page.getByRole('tab', { name: 'Vista SVG' }).click();
    await page.getByLabel('Documento JSON').fill('{ "version": ');
    await page.getByRole('tab', { name: 'Lienzo' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'no es válido' })).toBeVisible();
  });

  test('el mapa numera las interacciones por su orden y un flujo, por la posición de sus pasos', async ({ page }) => {
    await open(page);
    await expect(page.locator('.cv-mark-num')).toHaveCount(6);
    await selectView(page, 'flow:crear-pedido');
    await expect(page.locator('.cv-mark-num')).toHaveText(['1', '2', '3', '4', '5', '6']);
  });
});

test.describe('integración: notación EIP, zonas, contratos', () => {
  test('los patrones salen como icono sobre la línea y las zonas envuelven a sus nodos', async ({ page }) => {
    const errors = await open(page);
    const icon = page.getByTestId('edge-mark-fact-pagos-1');
    await expect(icon).toBeVisible();
    await expect(icon).toHaveAttribute('aria-label', 'Cortacircuitos');
    await expect(page.locator('[data-testid="node-domain:pedidos"].cv-group')).toBeVisible();
    await expect(page.locator('[data-testid="node-domain:finanzas"].cv-group')).toBeVisible();
    await expect(page.getByTestId('node-pedidos-api')).toContainText('openapi 2.1.0');
    await page.screenshot({ path: 'test-results/canvas-integration-eip.png' });
    expect(errors).toEqual([]);
  });

  test('la vista de un sistema muestra solo a él y a sus vecinos', async ({ page }) => {
    await open(page);
    await selectView(page, 'system:pedidos');
    await expect(page.getByTestId('node-pedidos-mcp')).toBeVisible();
    await expect(page.getByTestId('node-asistente')).toBeVisible();
    await expect(page.getByTestId('node-erp')).toHaveCount(0);
    await expect(page.getByTestId('node-pasarela-pagos')).toHaveCount(0);
  });

  test('seleccionar varios nodos y «Agrupar en dominio» crea la zona, y se deshace de un paso', async ({ page }) => {
    await open(page);
    await expect(page.getByTestId('action-group-domain')).toBeDisabled();
    await page.getByTestId('node-cliente').click();
    await page.getByTestId('node-tienda-web').click({ modifiers: ['Control'] });
    await expect(page.getByTestId('inspector')).toContainText('2 elementos seleccionados');
    await page.getByTestId('action-group-domain').click();
    await page.getByTestId('action-prompt').getByRole('combobox').fill('Canales');
    await page.getByTestId('action-prompt').getByRole('button', { name: 'Aceptar' }).click();
    await expect(page.locator('[data-testid="node-domain:canales"].cv-group')).toBeVisible();
    expect(await docText(page)).toContain('"domain": "Canales"');
    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('node-domain:canales')).toHaveCount(0);
    expect(await docText(page)).not.toContain('"domain": "Canales"');
  });

  test('un patrón se puede pasar de insignia a nodo intermedio y volver', async ({ page }) => {
    await open(page);
    const nodes = await page.locator('.react-flow__node').count();
    // La línea de la relación pasa por encima de su etiqueta (su zona de clic es una trazo invisible de 20 px) y Playwright
    // rechaza el clic sin `force`; con él cae sobre ese trazo y React Flow selecciona la misma relación. Es seguro porque
    // `open` espera a que el dibujo esté asentado: con `force` Playwright no espera a que el elemento deje de moverse.
    await page.getByTestId('edge-label-fact-pagos').click({ force: true });
    await expect(page.getByTestId('action-expand-pattern')).toBeEnabled();
    await page.getByTestId('action-expand-pattern').click();
    await expect(page.locator('.react-flow__node')).toHaveCount(nodes + 1);
    // El nodo nuevo aparece en una posición provisional y ELK lo recoloca: hasta entonces un clic caería donde ya no está.
    await canvasReady(page);
    await expect(page.locator('[data-shape="diamond"]')).toHaveCount(2);
    await expect(page.getByTestId('edge-mark-fact-pagos-1')).toHaveCount(0);
    await page.getByTestId('node-cortacircuitos').click();
    await page.getByTestId('action-collapse-pattern').click();
    await expect(page.locator('.react-flow__node')).toHaveCount(nodes);
    await canvasReady(page);
    await expect(page.getByTestId('edge-mark-fact-pagos-1')).toBeVisible();
  });

  test('desde una figura se abre su contrato, el editor lo valida y el formateador CloudEvents envuelve un payload', async ({ page }) => {
    await open(page);
    await page.getByTestId('node-facturacion-api').click();
    await page.getByTestId('attachment-open').click();
    await expect(page.getByRole('tab', { name: 'Contratos' })).toHaveAttribute('aria-selected', 'true');
    const text = page.getByTestId('attachment-text');
    await expect(text).toHaveValue(/service FacturacionService/);
    await expect(page.getByTestId('attachment-summary')).toContainText('FacturacionService.ConsultarFactura');

    await page.getByTestId('attachment-pedido-creado-ce').click();
    await text.fill('{"pedidoId":"1042","total":19.9}');
    await text.blur();
    await page.getByTestId('attachment-format').click();
    await expect(text).toHaveValue(/"specversion": "1\.0"/);
    await expect(text).toHaveValue(/"data": \{\n    "pedidoId": "1042"/);
    await expect(page.getByTestId('attachment-diagnostics')).not.toContainText('specversion');
    await page.getByRole('tab', { name: 'Vista SVG' }).click();
    expect(await page.getByLabel('Documento JSON').inputValue()).toContain('\\"specversion\\": \\"1.0\\"');
  });

  test('un diagnóstico de un contrato roto lleva a su línea y «Nuevo contrato» crea uno con el formato que encaja', async ({ page }) => {
    await open(page);
    await page.getByTestId('add-mcp').click();
    await page.getByTestId('attachment-new').click();
    await expect(page.getByRole('tab', { name: 'Contratos' })).toHaveAttribute('aria-selected', 'true');
    const text = page.getByTestId('attachment-text');
    await expect(text).toHaveValue(/"tools"/);
    await text.fill('{ "name": "x", "tools": [ { "name": "hola" } ] }');
    await text.blur();
    await expect(page.getByTestId('attachment-diagnostics')).toContainText('inputSchema');
  });
});

test.describe('selección y arrastre', () => {
  test('arrastrar un nodo lo mueve', async ({ page }) => {
    await open(page, 'security');
    const node = page.getByTestId('node-cliente');
    const before = (await node.boundingBox())!;
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 + 70, before.y + before.height / 2 + 50, { steps: 8 });
    await page.mouse.up();
    const after = (await node.boundingBox())!;
    expect(Math.round(after.x - before.x)).toBeGreaterThan(40);
    expect(Math.round(after.y - before.y)).toBeGreaterThan(30);
  });

  test('Ctrl + clic suma elementos, el panel los resume y Supr los borra con un solo paso de deshacer', async ({ page }) => {
    await open(page, 'security');
    const before = await page.locator('.react-flow__node').count();
    await page.getByTestId('node-cliente').click();
    await expect(page.getByTestId('inspector').getByLabel('Nombre')).toBeVisible();
    await page.getByTestId('node-pedidos-db').click({ modifiers: ['Control'] });
    const inspector = page.getByTestId('inspector');
    await expect(inspector).toContainText('2 elementos seleccionados');
    await expect(inspector.getByTestId('selection-list').getByRole('listitem')).toHaveCount(2);
    await page.keyboard.press('Delete');
    await expect(page.locator('.react-flow__node')).not.toHaveCount(before);
    expect(await docText(page)).not.toContain('"id": "pedidos-db"');
    await page.keyboard.press('Control+z');
    await expect(page.locator('.react-flow__node')).toHaveCount(before);
    expect(await docText(page)).toContain('"id": "pedidos-db"');
    await expect(page.getByRole('button', { name: 'Deshacer' })).toBeDisabled();
  });

  test('Mayús + arrastrar selecciona los elementos de un recuadro y Ctrl + clic quita uno', async ({ page }) => {
    await open(page, 'security');
    const a = (await page.getByTestId('node-cliente').boundingBox())!;
    const b = (await page.getByTestId('node-pedidos-db').boundingBox())!;
    const pane = (await page.locator('.react-flow__pane').boundingBox())!;
    const left = Math.min(a.x, b.x) - 12;
    const top = Math.min(a.y, b.y) - 12;
    const right = Math.max(a.x + a.width, b.x + b.width) + 12;
    const bottom = Math.max(a.y + a.height, b.y + b.height) + 12;
    expect(left).toBeGreaterThan(pane.x);
    await page.keyboard.down('Shift');
    await page.mouse.move(left, top);
    await page.mouse.down();
    await page.mouse.move(right, bottom, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    const inspector = page.getByTestId('inspector');
    await expect(inspector.getByTestId('selection-list')).toContainText('Cliente');
    const count = await inspector.getByTestId('selection-list').getByRole('listitem').count();
    await page.getByTestId('node-cliente').click({ modifiers: ['Control'] });
    await expect(inspector.getByTestId('selection-list').getByRole('listitem')).toHaveCount(count - 1);
  });
});

test.describe('lienzo empresarial', () => {
  test('el mapa de capacidades se abre anidado con su propia cuadrícula y el paisaje con figuras por capa', async ({ page }) => {
    const errors = await open(page, 'enterprise');
    await expect(page.locator('[data-testid="node-gestion-comercial"].cv-group')).toBeVisible();
    await expect(page.locator('[data-testid="node-ventas-online"][data-kind="capability"]')).toBeVisible();
    await page.screenshot({ path: 'test-results/canvas-enterprise-capabilities.png' });
    await selectView(page, 'landscape');
    await expect(page.locator('[data-shape="bar"]').first()).toBeVisible();
    await expect(page.locator('[data-shape="chevron"]').first()).toBeVisible();
    await expect(page.locator('.react-flow__edge').first()).toBeVisible();
    await page.screenshot({ path: 'test-results/canvas-enterprise-landscape.png' });
    expect(errors).toEqual([]);
  });

  test('una capacidad nueva entra en el mapa y su madurez se elige en las propiedades', async ({ page }) => {
    await open(page, 'enterprise');
    await page.getByTestId('add-capability').click();
    const inspector = page.getByTestId('inspector');
    await inspector.getByLabel('Madurez').selectOption('5');
    await expect(page.locator('.react-flow__node', { hasText: 'madurez 5/5' }).first()).toBeVisible();
    expect(await docText(page)).toContain('"maturity": 5');
  });
});

test.describe('lienzo de plataforma', () => {
  test('la vista del entorno anida redes y clústeres con las instancias dentro, y la topología usa figuras por clase de recurso', async ({ page }) => {
    const errors = await open(page, 'platform');
    await selectView(page, 'env:prod');
    await expect(page.locator('[data-testid="node-vpc-prod"].cv-group')).toBeVisible();
    await expect(page.locator('[data-testid="node-k8s-prod"].cv-group')).toBeVisible();
    await expect(page.locator('[data-testid="node-i:pedidos-prod"]')).toBeVisible();
    await expect(page.locator('[data-shape="cylinder"]').first()).toBeVisible();
    await page.screenshot({ path: 'test-results/canvas-platform-prod.png' });
    await selectView(page, 'delivery');
    await expect(page.locator('[data-testid="node-p:infraestructura"].cv-group')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('un servicio añadido en un entorno aparece dentro del clúster y se edita como instancia', async ({ page }) => {
    await open(page, 'platform');
    await selectView(page, 'env:prod');
    await page.locator('[data-testid="node-k8s-prod"] .cv-group-title').click();
    await page.getByTestId('add-worker').click();
    const instance = page.locator('.react-flow__node', { hasText: 'Worker nuevo' });
    await expect(instance).toBeVisible();
    await instance.click();
    await page.getByTestId('inspector').getByLabel('Réplicas').fill('3');
    await page.getByTestId('inspector').getByLabel('Réplicas').blur();
    expect(await docText(page)).toContain('"replicas": 3');
  });
});

test.describe('lienzo de seguridad', () => {
  test('el DFD dibuja procesos como círculos y almacenes como tubos dentro de zonas de confianza, y el modelo de amenazas usa hexágonos', async ({ page }) => {
    const errors = await open(page, 'security');
    await expect(page.locator('[data-testid="node-interna"].cv-group')).toBeVisible();
    await expect(page.locator('[data-testid="node-pedidos"][data-shape="circle"]')).toBeVisible();
    await expect(page.locator('[data-testid="node-pedidos-db"][data-shape="pipe"]')).toBeVisible();
    await expect(page.locator('[data-testid="node-cliente"][data-shape="actor"]')).toBeVisible();
    await page.screenshot({ path: 'test-results/canvas-security-dfd.png' });
    await selectView(page, 'threats');
    await expect(page.locator('[data-testid="node-exfiltracion-db"][data-shape="hexagon"]')).toBeVisible();
    await page.screenshot({ path: 'test-results/canvas-security-threats.png' });
    expect(errors).toEqual([]);
  });

  test('una amenaza añadida con un activo seleccionado recae sobre él y su categoría STRIDE se elige en las propiedades', async ({ page }) => {
    await open(page, 'security');
    await selectView(page, 'threats');
    await page.locator('[data-testid="node-pedidos-db"]').click();
    await page.getByTestId('add-threat').click();
    const inspector = page.getByTestId('inspector');
    await expect(inspector.getByLabel('Recae sobre')).toHaveValue('pedidos-db');
    await inspector.getByLabel('Categoría STRIDE').selectOption('information-disclosure');
    expect(await docText(page)).toContain('"category": "information-disclosure"');
  });
});
