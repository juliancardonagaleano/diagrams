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
 * (por omisión `a11y-informe`; no va dentro de `test-results`, que Playwright vacía en cada ejecución) para contar los hallazgos: `npx tsx scripts/accesibilidad-resumen.ts [carpeta]`.
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
const SALIDA = process.env.A11Y_SALIDA ?? 'a11y-informe';
const BLOQUEANTES = new Set(['critical', 'serious', 'moderate']);

/** Exclusión NOMINAL: una regla en un selector concreto, con el motivo y cuándo se arregla. Nunca una regla entera. */
interface Exclusion {
  regla: string;
  selector: string;
  motivo: string;
  cuando: string;
}
const EXCLUSIONES: Exclusion[] = [
  {
    regla: 'region',
    selector: '.semi-portal',
    motivo:
      'Semi UI monta los menús desplegables y los diálogos en un portal al final del <body>, fuera de los landmarks de la página. Es una regla de buenas prácticas (no un criterio WCAG A/AA); el diálogo es role="dialog" con nombre y aria-modal, y el menú es role="menu" junto a su disparador.',
    cuando: 'Al sustituir el menú y los diálogos de Semi UI por componentes propios, o si Semi permite montar el portal dentro de un landmark.',
  },
  {
    regla: 'heading-order',
    selector: '#semi-modal-title',
    motivo:
      'Semi UI pinta el título de todo diálogo como <h5> (no se puede cambiar el nivel); en el editor clásico el diálogo se abre sobre una página cuyo último encabezado es el <h1>, y axe pide que el nivel no salte. Es una regla de buenas prácticas (no un criterio WCAG A/AA); el diálogo está rotulado por ese título con aria-labelledby.',
    cuando: 'Al sustituir los diálogos de Semi UI por componentes propios con el nivel de título configurable.',
  },
];

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
  const builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']);
  const exclusiones = process.env.A11Y_SIN_EXCLUSIONES ? [] : EXCLUSIONES;
  const resultado = await builder.analyze();
  const { incomplete } = resultado;
  // Una exclusión descarta SOLO los nodos de esa regla cuyo selector coincide (no se excluye el selector para todas las reglas, como haría `exclude`).
  const violations = resultado.violations
    .map((v) => ({ ...v, nodes: v.nodes.filter((n) => !exclusiones.some((e) => e.regla === v.id && n.target.some((t) => t === e.selector || (typeof t === 'string' && t.startsWith(`${e.selector}:`))))) }))
    .filter((v) => v.nodes.length > 0);
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
    // `incomplete` son los casos que axe no pudo decidir y pide revisar a mano (p. ej. un fondo tapado por otro elemento): no cuentan como violaciones.
    const revision = incomplete.map((v) => ({ regla: v.id, nodos: v.nodes.length }));
    writeFileSync(join(SALIDA, `${tema}__${SLUG(superficie)}.json`), JSON.stringify({ hallazgos, revision }, null, 2));
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
        await page.getByRole('tab', { name: /^Versiones/ }).click();
        await page.getByLabel('Abrir archivo a comparar…').setInputFiles({ name: 'antes.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
        await expect(page.getByTestId('compare-summary')).toBeVisible({ timeout: TIMEOUT_ARRANQUE });
        await auditar(page, 'Banco integration · Versiones con diferencias', tema);
        await page.getByRole('tab', { name: 'Lienzo' }).click();
        await canvasReady(page);
        await auditar(page, 'Banco integration · Lienzo comparando', tema);
      });

      test('plataforma: lienzo con la marca del equivalente en otro entorno', async ({ page }) => {
        test.setTimeout(90_000);
        await abrirBanco(page, 'platform', tema);
        await page.getByTestId('canvas-view').selectOption('env:dev');
        await canvasReady(page, 'env:dev');
        // «Duplicar entorno» declara cada copia equivalente de su original: el lienzo marca los recursos con «≈ entorno».
        await page.locator('[data-testid="node-pedidos-db-dev"]').click();
        await page.getByTestId('action-duplicate-environment').click();
        await page.getByTestId('action-prompt').getByRole('textbox').fill('Pruebas de carga');
        await page.getByTestId('action-prompt').getByRole('button', { name: 'Aceptar' }).click();
        await page.getByTestId('canvas-view').selectOption('env:dev');
        await canvasReady(page, 'env:dev');
        await expect(page.getByTestId('marks-pedidos-db-dev')).toBeVisible();
        await auditar(page, 'Banco platform · Lienzo con equivalentes', tema);
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

/**
 * Reflujo (WCAG 1.4.10) y zoom: con la ventana a 640 px de ancho (200 % de zoom sobre 1280 px) y a 320 px (400 %) la página no se desplaza en
 * horizontal. El diagrama en sí queda exento (necesita un plano de dos dimensiones), pero el resto de la interfaz debe caber.
 */
test.describe('reflujo con zoom', () => {
  const PAGINAS: Array<[string, string]> = [
    ['editor clásico', '/?theme=light'],
    ['banco de trabajo', '/modulos.html?module=c4&theme=light'],
    ['suite', '/suite.html?theme=light'],
    ['trazabilidad', '/trazabilidad.html?examples=1&theme=light'],
  ];
  for (const ancho of [640, 320]) {
    for (const [nombre, url] of PAGINAS) {
      test(`${nombre} a ${ancho} px no se desplaza en horizontal`, async ({ page }) => {
        await page.setViewportSize({ width: ancho, height: ancho === 640 ? 512 : 640 });
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('h1').first()).toBeAttached({ timeout: TIMEOUT_ARRANQUE });
        await page.waitForTimeout(1500);
        const { scroll, client } = await page.evaluate(() => ({ scroll: document.scrollingElement?.scrollWidth ?? 0, client: document.scrollingElement?.clientWidth ?? 0 }));
        expect(scroll, `scrollWidth ${scroll} > clientWidth ${client}`).toBeLessThanOrEqual(client);
      });
    }
  }
});
