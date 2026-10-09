import { expect, test, type Page } from '@playwright/test';
import { generateDocument } from '../perf/generators';

/**
 * El lienzo con un diagrama grande en un navegador de verdad. NO mide cuánto tarda nada (el CI es lento y variable): comprueba
 * que el autolayout corre en un hilo de trabajo, que mientras calcula la página sigue respondiendo (el hilo principal no se bloquea
 * más de un umbral muy holgado) y avisa «Calculando…» con un botón para cancelar, y que con el diagrama ya colocado solo se montan
 * en el DOM los nodos que caen en pantalla. Las cifras (antes y después) están en docs/rendimiento.md y salen de `npm run perf`.
 */
const SIZE = 500;
/** Cuánto puede quedarse sin responder el hilo principal. Con ELK en él, 500 nodos lo bloquean varios segundos; con el hilo de trabajo, menos de uno. */
const MAX_BLOCK_MS = 4000;

interface Probe {
  maxGap: number;
}

async function openLarge(page: Page): Promise<{ workers: string[]; downloads: string[]; nodes: number }> {
  const generated = generateDocument('integration', SIZE);
  const workers: string[] = [];
  const downloads: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  page.on('response', (response) => downloads.push(response.url()));
  await page.addInitScript(
    ({ key, text }) => {
      window.localStorage.setItem(key, text);
      // Pulso de 50 ms: el mayor hueco entre dos pulsos es lo que estuvo bloqueado el hilo principal.
      const probe: Probe = { maxGap: 0 };
      (window as unknown as { __probe: Probe }).__probe = probe;
      let last = performance.now();
      setInterval(() => {
        const now = performance.now();
        probe.maxGap = Math.max(probe.maxGap, now - last);
        last = now;
      }, 50);
    },
    { key: 'iark.workbench.integration', text: JSON.stringify(generated.document) },
  );
  await page.goto('/modulos.html?module=integration', { waitUntil: 'domcontentloaded' });
  return { workers, downloads, nodes: (generated.document as { nodes: unknown[] }).nodes.length };
}

const maxGap = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { __probe: Probe }).__probe.maxGap);

test.describe('lienzo con un diagrama grande', () => {
  test('el autolayout corre en un hilo de trabajo, avisa «Calculando…» y la página sigue respondiendo', async ({ page }) => {
    test.setTimeout(150_000);
    const { workers, downloads } = await openLarge(page);
    const busy = page.getByTestId('canvas-busy');
    await expect(busy).toBeVisible({ timeout: 30_000 });
    await expect(busy).toContainText('Calculando la colocación');
    // Mientras calcula, la interfaz responde: el botón de atajos abre su panel enseguida.
    await page.getByRole('button', { name: 'Atajos de teclado' }).click();
    await expect(page.getByTestId('shortcuts')).toBeVisible({ timeout: 3000 });
    await expect(page.getByTestId('module-canvas')).toHaveAttribute('data-layout', 'ready', { timeout: 120_000 });
    await expect(busy).toBeHidden();
    expect(workers.length, 'el cálculo se hizo en un hilo de trabajo').toBeGreaterThan(0);
    expect(workers[0]).toMatch(/\/assets\/elkWorker-/);
    // El hilo de trabajo arrancó bien: la salida de emergencia (ELK en el hilo principal) no se llegó a descargar.
    expect(downloads.filter((url) => /elk-hilo-principal/.test(url))).toEqual([]);
    const gap = await maxGap(page);
    expect(gap, `el hilo principal estuvo ${gap.toFixed(0)} ms sin responder`).toBeLessThan(MAX_BLOCK_MS);
  });

  test('se puede cancelar el cálculo: queda la colocación provisional, se avisa y Autolayout lo reintenta', async ({ page }) => {
    test.setTimeout(150_000);
    await openLarge(page);
    await page.getByTestId('canvas-busy-cancel').click({ timeout: 30_000 });
    await expect(page.getByTestId('canvas-layout-cancelled')).toBeVisible();
    await expect(page.getByTestId('canvas-busy')).toBeHidden();
    await expect(page.getByTestId('module-canvas')).toHaveAttribute('data-layout', 'ready', { timeout: 20_000 });
    await expect(page.locator('.react-flow__node').first()).toBeVisible();
    await page.getByTestId('autolayout').click();
    await expect(page.getByTestId('canvas-layout-cancelled')).toBeHidden();
    await expect(page.getByTestId('canvas-busy')).toBeVisible({ timeout: 30_000 });
  });

  test('con el diagrama colocado, al acercar la vista solo se montan los nodos que caen en pantalla, y se puede seleccionar', async ({ page }) => {
    test.setTimeout(150_000);
    const { nodes } = await openLarge(page);
    const canvas = page.getByTestId('module-canvas');
    await expect(canvas).toHaveAttribute('data-layout', 'ready', { timeout: 120_000 });
    await expect(canvas).toHaveAttribute('data-culling', 'on');
    const zoomIn = page.locator('.react-flow__controls-zoomin');
    for (let i = 0; i < 9; i++) await zoomIn.click();
    await expect.poll(() => page.locator('.react-flow__node').count(), { timeout: 10_000 }).toBeLessThan(nodes / 2);
    const mounted = await page.locator('.react-flow__node').count();
    expect(mounted).toBeGreaterThan(0);
    // Un nodo visible se selecciona y abre sus propiedades.
    const node = page.locator('.cv-node').first();
    await node.click();
    await expect(node).toHaveAttribute('data-selected', 'true');
    await expect(page.getByTestId('inspector')).toBeVisible();
  });
});
