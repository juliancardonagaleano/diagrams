import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { canvasReady, c4Ready } from './canvas-helpers';

/**
 * Auditoría de accesibilidad con axe-core (WCAG 2.2 AA) de las superficies principales, en tema claro y oscuro:
 * el editor clásico (`/`), el banco de trabajo (`modulos.html`, los seis módulos en todas sus pestañas, con el panel de
 * propiedades y el gestor de proyectos abiertos), la suite (`suite.html`, con el banco embebido en su iframe) y la
 * trazabilidad (`trazabilidad.html`). Los menús y diálogos se auditan ABIERTOS.
 *
 * Qué hace falta para que pase: ninguna violación `critical`, `serious` ni `moderate` (las `minor` se registran en el
 * informe pero no bloquean), salvo las EXCLUSIONES NOMINALES de `EXCLUSIONES` (regla + selector + motivo + cuándo se
 * arregla; la lista completa está en `docs/accesibilidad.md`). Nunca se desactiva una regla entera.
 *
 * Modo informe (`A11Y_MODO=informe`): no falla, solo escribe un JSON por superficie en `A11Y_SALIDA`
 * (por omisión `test-results/a11y`) para contar los hallazgos: `npx tsx scripts/accesibilidad-resumen.ts [carpeta]`.
 * Con `A11Y_SIN_EXCLUSIONES=1` ignora las exclusiones (para medir el «antes» o comprobar que siguen haciendo falta).
 *
 * Qué NO sustituye: axe detecta, según su propia documentación, solo una parte de los problemas (alrededor de un tercio
 * de los criterios WCAG se pueden comprobar de forma automática). No sustituye la prueba con un lector de pantalla
 * real ni con teclado a mano: ver la lista de comprobación de `docs/accesibilidad.md`.
 */

type Tema = 'light' | 'dark';
const TEMAS: Tema[] = ['light', 'dark'];
const MODULOS = ['c4', 'integration', 'data', 'enterprise', 'platform', 'security'] as const;

const MODO_INFORME = process.env.A11Y_MODO === 'informe';
const SALIDA = process.env.A11Y_SALIDA ?? 'test-results/a11y';
const BLOQUEANTES = new Set(['critical', 'serious', 'moderate']);

/** Exclusión NOMINAL: una regla en un selector concreto, con el motivo y cuándo se arregla. Nunca una regla entera. */
interface Exclusion {
  regla: string;
  selector: string;
  motivo: string;
  cuando: string;
}
const EXCLUSIONES: Exclusion[] = [];

const SLUG = (texto: string): string =>
  texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

interface Hallazgo {
  superficie: string;
  tema: Tema;
  regla: string;
  impacto: string;
  ayuda: string;
  nodos: number;
  objetivos: string[];
}

/** Espera a que acaben las animaciones de entrada (diálogos, menús, tooltips) para que axe no mida colores intermedios. */
async function asentar(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await page.waitForTimeout(350);
}

/** Analiza la página tal como está ahora (incluidos los iframes) y devuelve/valida los hallazgos. */
async function auditar(page: Page, superficie: string, tema: Tema): Promise<void> {
  await asentar(page);
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']);
  const exclusiones = process.env.A11Y_SIN_EXCLUSIONES ? [] : EXCLUSIONES;
  for (const e of exclusiones) builder = builder.exclude(e.selector);
  const { violations } = await builder.analyze();
  const hallazgos: Hallazgo[] = violations.map((v) => ({
    superficie,
    tema,
    regla: v.id,
    impacto: v.impact ?? 'minor',
    ayuda: v.help,
    nodos: v.nodes.length,
    objetivos: v.nodes.slice(0, 8).map((n) => n.target.join(' >> ')),
  }));
  if (MODO_INFORME) {
    mkdirSync(SALIDA, { recursive: true });
    writeFileSync(join(SALIDA, `${tema}__${SLUG(superficie)}.json`), JSON.stringify(hallazgos, null, 2));
    return;
  }
  // Las exclusiones nominales no pueden ser una regla entera: si algún selector es global, la prueba lo rechaza.
  const bloqueantes = hallazgos.filter((h) => BLOQUEANTES.has(h.impacto));
  expect(
    bloqueantes.map((h) => `${h.impacto} · ${h.regla} (${h.nodos}): ${h.objetivos.slice(0, 3).join(' | ')}`),
    `Violaciones de accesibilidad en «${superficie}» (tema ${tema})`,
  ).toEqual([]);
}

const TIMEOUT_ARRANQUE = 20000;

async function abrirEditor(page: Page, tema: Tema): Promise<void> {
  await page.goto(`/?theme=${tema}`, { waitUntil: 'domcontentloaded' });
  await c4Ready(page);
}

async function abrirBanco(page: Page, modulo: string, tema: Tema): Promise<void> {
  await page.goto(`/modulos.html?module=${modulo}&theme=${tema}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('tab', { name: 'Lienzo' })).toBeVisible({ timeout: TIMEOUT_ARRANQUE });
  await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: TIMEOUT_ARRANQUE });
  await canvasReady(page);
}

for (const tema of TEMAS) {
  test.describe(`accesibilidad (axe, WCAG 2.2 AA) · tema ${tema}`, () => {
    test.describe('editor clásico', () => {
      test('vista inicial con el panel lateral', async ({ page }) => {
        await abrirEditor(page, tema);
        await auditar(page, 'Editor clásico · vista inicial', tema);
      });

      for (const menu of ['Archivo', 'Editar', 'Ver', 'Ajustes', 'Ayuda']) {
        test(`menú ${menu} abierto`, async ({ page }) => {
          await abrirEditor(page, tema);
          await page.getByText(menu, { exact: true }).first().click();
          await expect(page.getByRole('menu').or(page.locator('.semi-dropdown-menu')).first()).toBeVisible();
          await auditar(page, `Editor clásico · menú ${menu}`, tema);
        });
      }

      for (const pestana of [/^Relaciones/, /^Vistas/, /^IA/]) {
        test(`pestaña lateral ${pestana.source}`, async ({ page }) => {
          await abrirEditor(page, tema);
          await page.getByRole('tab', { name: pestana }).click();
          await auditar(page, `Editor clásico · pestaña ${pestana.source}`, tema);
        });
      }

      test('modo JSON del panel lateral', async ({ page }) => {
        await abrirEditor(page, tema);
        await page.getByTitle('JSON', { exact: true }).click();
        await auditar(page, 'Editor clásico · panel JSON', tema);
      });

      test('un elemento seleccionado y su ficha', async ({ page }) => {
        await abrirEditor(page, tema);
        await page.locator('.react-flow__node').first().click();
        await auditar(page, 'Editor clásico · elemento seleccionado', tema);
      });

      test('diálogos: atajos, acerca de, vista previa de Mermaid y proyectos', async ({ page }) => {
        await abrirEditor(page, tema);
        await page.getByText('Ayuda', { exact: true }).first().click();
        await page.getByText('Atajos de teclado', { exact: true }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await auditar(page, 'Editor clásico · diálogo de atajos', tema);
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);

        await page.getByText('Ayuda', { exact: true }).first().click();
        await page.getByText('Acerca del diagramador', { exact: true }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await auditar(page, 'Editor clásico · diálogo acerca de', tema);
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);

        await page.getByText('Archivo', { exact: true }).first().click();
        await page.getByText('Vista previa de Mermaid…', { exact: true }).click();
        await expect(page.getByRole('dialog', { name: 'Vista previa de Mermaid' })).toBeVisible();
        await expect(page.getByRole('img', { name: /Vista previa de Mermaid/ })).toBeVisible({ timeout: TIMEOUT_ARRANQUE });
        await auditar(page, 'Editor clásico · diálogo vista previa de Mermaid', tema);
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);

        await page.getByText('Archivo', { exact: true }).first().click();
        await page.getByText('Proyectos…', { exact: true }).click();
        await expect(page.getByTestId('projects-dialog')).toBeVisible();
        await auditar(page, 'Editor clásico · gestor de proyectos', tema);
      });
    });

    test.describe('banco de trabajo', () => {
      for (const modulo of MODULOS) {
        test(`${modulo}: todas las pestañas`, async ({ page }) => {
          test.setTimeout(120_000);
          await abrirBanco(page, modulo, tema);
          await auditar(page, `Banco ${modulo} · Lienzo`, tema);

          // Un nodo seleccionado abre el panel de propiedades.
          await page.locator('.react-flow__node:not(.parent)').first().click();
          await auditar(page, `Banco ${modulo} · Lienzo con propiedades`, tema);

          const pestanas = await page.getByRole('tablist', { name: 'Paneles' }).getByRole('tab').allInnerTexts();
          for (const nombre of pestanas) {
            if (nombre === 'Lienzo') continue;
            await page.getByRole('tablist', { name: 'Paneles' }).getByRole('tab', { name: nombre, exact: true }).click();
            await auditar(page, `Banco ${modulo} · ${nombre.replace(/\s*\(\d+\)$/, '')}`, tema);
          }
        });
      }

      test('c4: el módulo de C4 tiene su propio lienzo y vistas (selector de vista y nivel)', async ({ page }) => {
        await abrirBanco(page, 'c4', tema);
        await expect(page.getByTestId('canvas-view')).toBeVisible();
        await auditar(page, 'Banco c4 · selector de vista', tema);
      });

      test('comparar con otra versión: lienzo marcado y lista de cambios', async ({ page }) => {
        test.setTimeout(90_000);
        await abrirBanco(page, 'integration', tema);
        // La versión base se fabrica a partir del propio documento: tenía un nodo que ya no está y otro con otro nombre.
        await page.getByRole('tab', { name: 'Vista SVG' }).click();
        const texto = await page.getByLabel('Documento JSON').inputValue();
        const doc = JSON.parse(texto) as { nodes: Array<{ id: string; name: string }> };
        doc.nodes.push({ id: 'erp-heredado', name: 'ERP heredado', kind: 'system' } as never);
        doc.nodes[0]!.name += ' (antes)';
        await page.getByRole('tab', { name: /^Comparar/ }).click();
        await page.getByLabel('Abrir archivo a comparar…').setInputFiles({ name: 'antes.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
        await expect(page.getByTestId('compare-summary')).toBeVisible({ timeout: TIMEOUT_ARRANQUE });
        await auditar(page, 'Banco integration · Comparar con diferencias', tema);
        await page.getByRole('tab', { name: 'Lienzo' }).click();
        await canvasReady(page);
        await auditar(page, 'Banco integration · Lienzo comparando', tema);
      });

      test('importar: aviso de resultado', async ({ page }) => {
        await abrirBanco(page, 'integration', tema);
        await page.getByRole('tab', { name: /^Importar/ }).click();
        await auditar(page, 'Banco integration · Importar', tema);
      });

      test('gestor de proyectos abierto', async ({ page }) => {
        await abrirBanco(page, 'data', tema);
        await page.getByRole('button', { name: 'Proyectos…' }).click();
        await expect(page.getByTestId('projects-dialog')).toBeVisible();
        await auditar(page, 'Banco · gestor de proyectos', tema);
      });

      test('atajos del lienzo', async ({ page }) => {
        await abrirBanco(page, 'integration', tema);
        await page.getByRole('button', { name: 'Atajos de teclado' }).click();
        await auditar(page, 'Banco · atajos del lienzo', tema);
      });
    });

    test.describe('suite y trazabilidad', () => {
      test('suite con un módulo embebido', async ({ page }) => {
        test.setTimeout(90_000);
        await page.goto(`/suite.html?theme=${tema}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('status').first()).toContainText('6 módulos', { timeout: TIMEOUT_ARRANQUE });
        await expect.poll(() => page.frames().some((f) => f.url().includes('embed=1')), { timeout: TIMEOUT_ARRANQUE }).toBe(true);
        const marco = page.frameLocator('iframe');
        await expect(marco.getByRole('tab', { name: 'Lienzo' })).toBeVisible({ timeout: TIMEOUT_ARRANQUE });
        await auditar(page, 'Suite', tema);
      });

      test('trazabilidad sin documentos', async ({ page }) => {
        await page.goto(`/trazabilidad.html?theme=${tema}`, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#summary')).toContainText('sin documentos');
        await auditar(page, 'Trazabilidad · vacía', tema);
      });

      for (const pestana of [/^Grafo/, /^Enlaces/, /^Sin resolver/, /^Alcance/, /^Matriz/, /^Huérfanos/, /^Cobertura/]) {
        test(`trazabilidad con ejemplos · ${pestana.source}`, async ({ page }) => {
          await page.goto(`/trazabilidad.html?examples=1&theme=${tema}`, { waitUntil: 'domcontentloaded' });
          await expect(page.locator('#summary')).toContainText('6 documentos', { timeout: TIMEOUT_ARRANQUE });
          const pestanaEl = page.getByRole('tab', { name: pestana });
          if (await pestanaEl.count()) await pestanaEl.first().click();
          await auditar(page, `Trazabilidad · ${pestana.source}`, tema);
        });
      }
    });
  });
}
