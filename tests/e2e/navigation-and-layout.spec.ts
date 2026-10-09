import { test, expect } from '@playwright/test';
import { c4Ready, openEditor } from './canvas-helpers';

test('autolayout, direcciones y navegación C1 → C2 → C3', async ({ page }) => {
  await openEditor(page);

  // Autolayout en C1: 0 cruces, 0 solapes, dirección ↓ centrada por defecto.
  await page.getByRole('button', { name: 'Autolayout', exact: true }).click();
  await c4Ready(page);
  const positions = await page.$$eval('.react-flow__node', (els) => els.map((e) => (e as HTMLElement).style.transform));
  expect(new Set(positions).size, 'autolayout deja posiciones distintas para todos los nodos').toBe(positions.length);
  const qualityText = (await page.getByTestId('layout-quality').textContent()) ?? '';
  expect(qualityText).toMatch(/0 cruces/);
  expect(qualityText).toMatch(/0 solapes/);
  expect(qualityText).toMatch(/↓/);
  expect(qualityText).toMatch(/centrado/);
  const overlaps = await page.evaluate(() => {
    const labels = [...document.querySelectorAll('.c4-edge-label')].map((l) => l.getBoundingClientRect());
    const shapes = [...document.querySelectorAll('.react-flow__node')].map((n) => n.getBoundingClientRect());
    const hit = (a: DOMRect, b: DOMRect) => a.left < b.right - 2 && b.left < a.right - 2 && a.top < b.bottom - 2 && b.top < a.bottom - 2;
    return labels.filter((l) => shapes.some((s) => hit(l, s))).length;
  });
  expect(overlaps, 'ninguna etiqueta de relación pisa un nodo').toBe(0);

  // Navegación C1 → C2 con doble clic en el sistema.
  await page.locator('.react-flow__node', { hasText: 'Sistema de banca en línea' }).dblclick();
  await c4Ready(page, 'contenedores');
  await expect(page.locator('.c4-boundary')).toHaveCount(1);

  // C2 por defecto: izquierda→derecha (el boundary es más ancho que alto).
  await page.getByRole('button', { name: 'Autolayout', exact: true }).click();
  await c4Ready(page);
  const boundaryBox = await page.locator('.c4-boundary').boundingBox();
  expect(boundaryBox).not.toBeNull();
  expect(boundaryBox!.width, `C2 se distribuye izquierda→derecha (${Math.round(boundaryBox!.width)}×${Math.round(boundaryBox!.height)})`).toBeGreaterThan(boundaryBox!.height);
  const q2 = (await page.getByTestId('layout-quality').textContent()) ?? '';
  expect(q2).toMatch(/→/);
  expect(q2).toMatch(/0 cruces/);

  // Forzar derecha→izquierda desde el desplegable.
  await page.getByRole('button', { name: 'Dirección y distribución del autolayout' }).click();
  await page.getByText('Derecha → izquierda').click();
  await page.keyboard.press('Escape');
  // El menú debe haberse cerrado del todo: si no, el clic siguiente en su botón alterna el menú que aún se cierra y no lo reabre.
  await expect(page.getByText('Derecha → izquierda')).toBeHidden();
  await c4Ready(page);
  const q3 = (await page.getByTestId('layout-quality').textContent()) ?? '';
  expect(q3).toMatch(/←/);
  const clienteBox = await page.locator('.react-flow__node', { hasText: 'Cliente personal' }).boundingBox();
  const dbBox = await page.locator('.react-flow__node', { hasText: 'Base de datos' }).boundingBox();
  expect(clienteBox).not.toBeNull();
  expect(dbBox).not.toBeNull();
  expect(clienteBox!.x, 'en derecha→izquierda la persona queda a la derecha del flujo').toBeGreaterThan(dbBox!.x);

  // Volver a la dirección automática.
  await page.getByRole('button', { name: 'Dirección y distribución del autolayout' }).click();
  await page.getByText('Automática (C1 ↓, C2/C3 →)').click();
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  await expect(page.getByText('Automática (C1 ↓, C2/C3 →)')).toBeHidden();
  await c4Ready(page);
  await expect(page.locator('.c4-breadcrumb')).toHaveAttribute('data-level', 'C2');
  await expect(page.locator('.c4-shape.shape-database')).toHaveCount(1);
  await expect(page.locator('.c4-shape.shape-browser')).toHaveCount(1);

  // Las aristas que salen de un nodo nacen en puntos distintos (rutas del autolayout / puertos virtuales).
  const starts = await page.$$eval('.react-flow__edge path.react-flow__edge-path', (paths) =>
    paths.map((p) => (p.getAttribute('d') ?? '').split('L')[0].trim()),
  );
  expect(new Set(starts).size, `todas las aristas nacen en puntos distintos (${starts.length})`).toBe(starts.length);

  // C2 → C3 con doble clic en la API y vuelta con "Subir nivel".
  await page.locator('.react-flow__node', { hasText: 'Aplicación API' }).dblclick();
  await c4Ready(page, 'componentes-api');
  await expect(page.locator('.c4-breadcrumb')).toHaveAttribute('data-level', 'C3');
  await page.getByRole('button', { name: 'Subir nivel' }).click();
  await c4Ready(page, 'contenedores');
  await expect(page.locator('.c4-breadcrumb')).toHaveAttribute('data-level', 'C2');
});

test('volver a añadir a una vista C2 un elemento (botón del ojo) recoloca la vista y la exportación sigue funcionando', async ({ page }) => {
  // Antes: la vista quedaba con nodos posicionados y uno sin posición, ELK (modo interactivo) lanzaba
  // UnsupportedGraphException en vistas con boundary, el autolayout fallaba y "Exportar .drawio" también.
  await openEditor(page);
  await page.locator('.react-flow__node', { hasText: 'Sistema de banca en línea' }).dblclick();
  await c4Ready(page, 'contenedores');
  await expect(page.locator('.c4-breadcrumb')).toHaveAttribute('data-level', 'C2');
  const before = await page.locator('.react-flow__node').count();

  const eye = page.locator('.c4-card[data-element-id="db"] .c4-card-header').getByRole('button', { name: /de la vista activa$|a la vista activa$/ });
  await eye.click(); // quitar "Base de datos" de la vista
  await expect(page.locator('.react-flow__node')).toHaveCount(before - 1);
  await eye.click(); // volver a añadirla, sin posición: la vista se recoloca y se encuadra de nuevo
  await c4Ready(page);
  await expect(page.locator('.react-flow__node')).toHaveCount(before);
  await expect(page.locator('.react-flow__node', { hasText: 'Base de datos' })).toHaveCount(1);

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exportar .drawio' }).click()]);
  const xml = await (await import('node:fs/promises')).readFile((await download.path())!, 'utf8');
  expect(xml.startsWith('<mxfile')).toBe(true);
  expect((xml.match(/<diagram /g) || []).length).toBe(3);
});
