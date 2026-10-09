import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test.describe('vista de trazabilidad entre módulos', () => {
  test('carga los ejemplos, dibuja el grafo y lista los enlaces por par de módulos', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/trazabilidad.html', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#summary')).toContainText('sin documentos');
    await expect(page.getByText('Carga los documentos de al menos dos módulos')).toBeVisible();

    await page.getByRole('button', { name: 'Cargar los ejemplos' }).click();
    await expect(page.locator('#summary')).toContainText('6 documentos · 15 enlaces');
    const graph = page.getByRole('img', { name: /Grafo de trazabilidad: 15 enlaces entre \d módulos/ });
    await expect(graph).toBeVisible();
    await expect.poll(() => graph.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(300);

    await page.getByRole('tab', { name: 'Enlaces (15)' }).click();
    await expect(page.getByRole('heading', { name: 'Seguridad → Plataforma (5)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Plataforma → Integración (6)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Empresarial → Integración (3)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Datos → Integración (1)' })).toBeVisible();

    await page.getByRole('tab', { name: 'Sin resolver (0)' }).click();
    await expect(page.getByText('Todas las referencias se resuelven.')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('alcance de un elemento: el impacto atraviesa los módulos y se acota por saltos', async ({ page }) => {
    await page.goto('/trazabilidad.html?examples=1&tab=reach', { waitUntil: 'domcontentloaded' });
    await expect(page.getByLabel('Elemento de partida')).toBeVisible();
    await page.getByLabel('Elemento de partida').selectOption('urn:iark:integration:pedidos');
    await page.getByLabel('Sentido').selectOption('referrers');
    const report = page.locator('.tr-report');
    await expect(report).toContainText('security:pedidos (Servicio de pedidos) · asset · a 2 saltos');
    await expect(report).toContainText('Módulos alcanzados: data, platform, security');

    await page.getByLabel('Saltos máximos').fill('1');
    await page.getByLabel('Saltos máximos').dispatchEvent('change');
    await expect(report).not.toContainText('security:pedidos');
    await expect(report).toContainText('platform:pedidos');
    await expect(page.getByRole('img', { name: /Alcance de Servicio de pedidos \(integration:pedidos\): 2 elementos/ })).toBeVisible();
  });

  test('enlaces tipados: filtro por tipo, matriz con desglose, huérfanos y cobertura sobre los ejemplos', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/trazabilidad.html?examples=1&tab=links', { waitUntil: 'domcontentloaded' });
    const summary = page.locator('#summary');
    await expect(summary).toContainText('6 documentos · 15 enlaces');

    // cada enlace muestra su tipo y el filtro deja ver solo los marcados
    await expect(page.locator('.tr-link-type.typed', { hasText: 'protects' })).toHaveCount(5);
    await page.getByRole('checkbox', { name: 'implements (4)' }).check();
    await expect(summary).toContainText('6 documentos · 4 de 15 enlaces');
    await expect(page.getByRole('heading', { name: 'Plataforma → Integración (4)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Seguridad → Plataforma/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Todos' }).click();
    await expect(summary).toContainText('6 documentos · 15 enlaces');

    // matriz: cabeceras con scope, el número exacto en cada celda y el desglose por tipo
    await page.getByRole('tab', { name: 'Matriz' }).click();
    const matrix = page.getByRole('table', { name: /Enlaces por módulo/ });
    await expect(matrix).toBeVisible();
    await expect(matrix.locator('thead th[scope="col"]').first()).toHaveText('Origen \\ Destino');
    await expect(matrix.locator('tbody th[scope="row"]')).toHaveCount(4);
    const cell = matrix.locator('td[data-count="5"]');
    await expect(cell).toHaveText('5');
    await expect(cell).toHaveAttribute('title', /5 enlaces de Seguridad a Plataforma: protects 5/);
    await expect(page.getByRole('table', { name: 'Desglose por tipo de enlace' })).toBeVisible();
    await page.getByLabel('Cruzar por').selectOption('kind');
    await expect(page.getByRole('table', { name: /Enlaces por tipo de elemento/ })).toBeVisible();

    // huérfanos: las cuatro zonas de seguridad no tienen ningún enlace
    await page.getByRole('tab', { name: 'Huérfanos' }).click();
    await page.locator('#orphans-module').selectOption('security');
    await page.locator('#orphans-kind').selectOption('zone');
    await expect(page.locator('.tr-summary')).toHaveText('4 de 4 elementos no tienen ningún enlace.');
    await expect(page.getByRole('heading', { name: 'Seguridad · zone (4 de 4)' })).toBeVisible();

    // cobertura: dos reglas medidas contra el mínimo (100 % por omisión) y una línea mala que no impide medir las demás
    await page.getByRole('tab', { name: 'Cobertura' }).click();
    await page.getByLabel('Reglas de cobertura').fill('security:asset -> platform\nplatform:service -> integration\nnada -> platform');
    await page.getByRole('button', { name: 'Medir' }).click();
    await expect(page.getByRole('alert')).toContainText('Línea 3');
    const assets = page.locator('tr[data-rule="security:asset -> platform"]');
    await expect(assets).toContainText('45,5 %');
    await expect(assets).toContainText('por debajo del mínimo');
    await expect(page.locator('tr[data-rule="platform:service -> integration"]')).toContainText('66,7 %');
    await expect(page.getByText('SIN cubrir (6)')).toBeVisible();

    await page.getByLabel('Mínimo (%)').fill('40');
    await page.getByRole('button', { name: 'Medir' }).click();
    await expect(assets).toContainText('cumple');
    expect(errors).toEqual([]);
  });

  test('documentos por archivo o pegados: un módulo sin su destino deja la referencia sin resolver y un JSON roto no borra nada', async ({ page }) => {
    await page.goto('/trazabilidad.html', { waitUntil: 'domcontentloaded' });
    const security = page.locator('section[data-module="security"]');
    await security.locator('input[type="file"]').setInputFiles({ name: 'seguridad.json', mimeType: 'application/json', buffer: readFileSync('examples/seguridad-ejemplo.json') });
    await expect(security.locator('.wb-chip')).toContainText('elementos');
    await expect(page.locator('#summary')).toContainText('1 documentos · 0 enlaces · 5 sin resolver');

    await page.getByRole('tab', { name: /Sin resolver/ }).click();
    await expect(page.getByText('módulo sin documento').first()).toBeVisible();

    await security.getByText('Pegar JSON').click();
    await security.getByLabel('JSON de Seguridad').fill('{ roto');
    await security.getByRole('button', { name: 'Aplicar' }).click();
    await expect(security.getByRole('alert')).toContainText('No es JSON válido');
    await expect(security.locator('.wb-chip')).toContainText('elementos'); // el documento anterior sigue

    // añadir la plataforma resuelve los enlaces del nivel siguiente
    const platform = page.locator('section[data-module="platform"]');
    await platform.getByRole('button', { name: 'Ejemplo' }).click();
    await expect(page.locator('#summary')).toContainText('2 documentos · 5 enlaces');

    await page.getByRole('button', { name: 'Vaciar' }).click();
    await expect(page.locator('#summary')).toContainText('sin documentos');
  });

  test('desde el banco de trabajo y el shell se llega a la vista', async ({ page }) => {
    await page.goto('/modulos.html', { waitUntil: 'domcontentloaded' });
    await page.getByRole('link', { name: 'Trazabilidad' }).click();
    await expect(page).toHaveURL(/trazabilidad\.html$/);
    await page.goto('/suite.html', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('link', { name: 'Trazabilidad' })).toHaveAttribute('href', 'trazabilidad.html');
  });
});
