import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const example = (file: string): string => readFileSync(new URL(`../../examples/${file}`, import.meta.url), 'utf8');

const diagram = (page: Page) => page.locator('[data-testid="diagram-stage"] img');

/**
 * Los módulos con lienzo interactivo (todos los del banco de trabajo) abren en «Lienzo»; estas pruebas miran la vista SVG y el JSON.
 * El módulo se carga bajo demanda y hasta que llega el panel se llama «Diagrama» y no existe «Vista SVG»: se espera a esa pestaña
 * (en vez de mirar una sola vez si ya está, que solo acertaba cuando `networkidle` había dado tiempo a la carga).
 */
async function showSvg(page: Page): Promise<void> {
  const tab = page.getByRole('tab', { name: 'Vista SVG' });
  await expect(tab).toBeVisible({ timeout: 20000 });
  await tab.click();
}

async function open(page: Page, module: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/modulos.html?bank=1&module=${module}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('tablist', { name: 'Paneles' })).toBeVisible({ timeout: 20000 });
  await showSvg(page);
  await expect(diagram(page)).toBeVisible({ timeout: 20000 });
  return errors;
}

test.describe('banco de trabajo de módulos', () => {
  test('abre el ejemplo del módulo, dibuja la vista y cambia entre vistas y vistas de traza', async ({ page }) => {
    const errors = await open(page, 'security');
    await expect(page.getByRole('tab', { name: 'Seguridad' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('editor-status')).toContainText('Válido');
    const first = await diagram(page).getAttribute('data-view');
    expect(first).toBe('dfd');
    // el dibujo es una imagen real (no vacía)
    expect(await diagram(page).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(300);

    await page.getByLabel('Vista').selectOption('threats');
    await expect(diagram(page)).toHaveAttribute('data-view', 'threats');
    await page.getByLabel('Vista').selectOption('blast:pedidos');
    await expect(diagram(page)).toHaveAttribute('data-view', 'blast:pedidos');
    expect(await diagram(page).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 100)).toBe(true);
    expect(errors).toEqual([]);
  });

  for (const [id, label] of [
    ['integration', 'Integración'],
    ['data', 'Datos'],
    ['enterprise', 'Empresarial'],
    ['platform', 'Plataforma'],
    ['security', 'Seguridad'],
  ] as const) {
    test(`la pestaña ${label} carga el módulo bajo demanda con su ejemplo válido`, async ({ page }) => {
      const errors = await open(page, id === 'integration' ? 'data' : 'integration');
      await page.getByRole('tab', { name: label }).click();
      await expect(page.getByRole('tab', { name: label })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('tab', { name: /^(Diagrama|Vista SVG)$/ })).toBeVisible();
      await showSvg(page);
      await expect(page.getByTestId('editor-status')).toContainText('Válido');
      await expect(diagram(page)).toBeVisible();
      expect(await diagram(page).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 100)).toBe(true);
      expect(errors).toEqual([]);
    });
  }

  test('un JSON roto no borra el diagrama, señala el error y se recupera al corregirlo', async ({ page }) => {
    await open(page, 'data');
    const editor = page.getByLabel('Documento JSON');
    const original = await editor.inputValue();
    await editor.fill('{ "version": ');
    await expect(page.getByTestId('editor-status')).toContainText('JSON inválido');
    await expect(page.getByText('se muestra el último dibujo válido')).toBeVisible();
    await expect(diagram(page)).toBeVisible();
    await page.getByRole('tab', { name: /Problemas/ }).click();
    await expect(page.getByText('No es JSON válido')).toBeVisible();
    await editor.fill(original);
    await expect(page.getByTestId('editor-status')).toContainText('Válido');
    await page.getByRole('tab', { name: /^(Diagrama|Vista SVG)$/ }).click();
    await expect(page.getByText('se muestra el último dibujo válido')).toHaveCount(0);
  });

  test('un error de esquema lista la ruta del campo; un aviso de dominio lleva el cursor al elemento', async ({ page }) => {
    await open(page, 'security');
    const editor = page.getByLabel('Documento JSON');
    const doc = JSON.parse(await editor.inputValue());
    // aviso de dominio: los problemas del ejemplo ya tienen elementos
    await page.getByRole('tab', { name: /Problemas/ }).click();
    const reveal = page.getByRole('button', { name: /^ver «/ }).first();
    await expect(reveal).toBeVisible();
    const id = (await reveal.textContent())!.match(/«(.+)»/)![1];
    await reveal.click();
    const selected = await editor.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd));
    expect(selected).toContain(`"id": "${id}"`);

    // error de esquema
    doc.zones[0].trust = 'inventada';
    await editor.fill(JSON.stringify(doc, null, 2));
    await expect(page.getByTestId('editor-status')).toContainText('errores de esquema');
    await expect(page.locator('.wb-path').first()).toContainText('zones.0.trust');
  });

  test('exporta a Mermaid, SVG y draw.io: vista previa, descarga y JSON', async ({ page }) => {
    await open(page, 'platform');
    await page.getByRole('tab', { name: 'Exportar' }).click();
    await page.locator('[data-format="mermaid"]').getByRole('button', { name: 'Ver' }).click();
    await expect(page.getByTestId('export-preview')).toContainText('flowchart');
    await page.locator('[data-format="json"]').getByRole('button', { name: 'Ver' }).click();
    expect(JSON.parse((await page.getByTestId('export-preview').textContent())!).version).toBe('1.0');

    const [svg] = await Promise.all([page.waitForEvent('download'), page.locator('[data-format="svg"]').getByRole('button', { name: /Descargar/ }).click()]);
    expect(svg.suggestedFilename()).toMatch(/\.svg$/);
    const [drawio] = await Promise.all([page.waitForEvent('download'), page.locator('[data-format="drawio"]').getByRole('button', { name: /Descargar/ }).click()]);
    expect(drawio.suggestedFilename()).toMatch(/\.drawio$/);
  });

  test('informes: opciones, salida y errores; las conversiones crean el documento a partir de otro módulo', async ({ page }) => {
    await open(page, 'security');
    await page.getByRole('tab', { name: 'Informes' }).click();

    const risks = page.locator('[data-command="risks"]');
    await risks.locator('summary').click();
    await risks.getByRole('button', { name: 'Generar informe' }).click();
    await expect(risks.getByTestId('command-output')).toContainText('| Riesgo | Amenaza |');
    await risks.getByRole('textbox').first().fill('raro');
    await risks.getByRole('button', { name: 'Generar informe' }).click();
    await expect(risks.getByRole('alert')).toContainText('Estado inválido');

    const convert = page.locator('[data-command="from-integration"]');
    await convert.locator('summary').click();
    await convert.getByRole('button', { name: 'Convertir' }).click();
    await expect(convert.getByRole('alert')).toContainText('Falta la entrada');
    await convert.getByRole('textbox').last().fill(example('pedidos-integracion.json'));
    await convert.getByRole('button', { name: 'Convertir' }).click();
    await expect(convert.getByTestId('command-output')).toContainText('"zones"');
    await convert.getByRole('button', { name: 'Usar como documento' }).click();
    await expect(page.getByTestId('editor-status')).toContainText('Válido');
    expect(await page.getByLabel('Documento JSON').inputValue()).toContain('"zones"');
    expect(await page.getByLabel('Documento JSON').inputValue()).not.toContain('Seguridad de la tienda en línea');
  });

  test('importar Mermaid sustituye el documento y avisa de lo que no encaja', async ({ page }) => {
    await open(page, 'data');
    await page.getByRole('tab', { name: 'Importar' }).click();
    await expect(page.getByTestId('import-mermaid')).toHaveCount(0);
    await page.getByLabel('Texto a importar').fill('flowchart LR\n  crm[(CRM)] --> dwh[(Almacén)]\n  dwh --> panel[Panel de ventas]');
    // Con texto que parece Mermaid aparece la vista previa dibujada antes de importar.
    const preview = page.getByTestId('import-mermaid').getByRole('img', { name: 'Vista previa de Mermaid del texto a importar' });
    await expect(preview).toBeVisible({ timeout: 20000 });
    await expect.poll(() => preview.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0))).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Importar', exact: true }).click();
    await expect(page.getByLabel('Documento JSON')).toHaveValue(/"assets"/);
    expect(await page.getByLabel('Documento JSON').inputValue()).toContain('Almacén');
    await page.getByRole('tab', { name: /^(Diagrama|Vista SVG)$/ }).click();
    await expect(diagram(page)).toBeVisible();

    await page.getByRole('tab', { name: 'Importar' }).click();
    await page.getByLabel('Texto a importar').fill('esto no es Mermaid');
    await page.getByRole('button', { name: 'Importar', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('No se reconoce el formato');
  });

  test('ui=min oculta la marca y las pestañas de módulos pero conserva las acciones', async ({ page }) => {
    await page.goto('/modulos.html?bank=1&module=data&ui=min', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('tablist', { name: 'Paneles' })).toBeVisible({ timeout: 20000 });
    await showSvg(page);
    await expect(diagram(page)).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole('tab', { name: 'Integración' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cargar ejemplo' })).toBeVisible();
  });

  test('el borrador se conserva al recargar y «Cargar ejemplo» lo restaura', async ({ page }) => {
    await open(page, 'integration');
    const editor = page.getByLabel('Documento JSON');
    const doc = JSON.parse(await editor.inputValue());
    doc.workspace.name = 'Mi borrador';
    await editor.fill(JSON.stringify(doc, null, 2));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('tablist', { name: 'Paneles' })).toBeVisible({ timeout: 20000 });
    await showSvg(page);
    await expect(page.getByLabel('Documento JSON')).toHaveValue(/Mi borrador/);
    await page.getByRole('button', { name: 'Cargar ejemplo' }).click();
    await expect(page.getByLabel('Documento JSON')).not.toHaveValue(/Mi borrador/);
  });
});

test.describe('widget embebible de módulos', () => {
  test('handshake con capacidades, carga, vistas, exportación, informes y validación desde el anfitrión', async ({ page }) => {
    const hostErrors: string[] = [];
    page.on('pageerror', (e) => hostErrors.push(e.message));
    // Con iframes, `networkidle` a veces no se notifica aunque todo esté cargado y el `goto` agota el tiempo de la prueba: se espera por condiciones observables.
    await page.goto('/examples/modules-host.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('state')?.textContent === 'cargado', null, { timeout: 30000 });

    const frame = page.frames().find((f) => f.url().includes('embed=1'));
    expect(frame, 'el iframe se abrió con ?embed=1').toBeTruthy();
    expect(frame!.url()).toContain('module=security');
    await expect(frame!.getByTestId('module-canvas')).toBeVisible({ timeout: 20000 });
    await expect(frame!.getByRole('button', { name: 'Guardar y salir' })).toHaveCount(1);
    await expect(frame!.getByLabel('Documento JSON')).toHaveValue(/Tienda en línea/);

    // init anunció los módulos disponibles y las capacidades del abierto
    const log = () => page.locator('#log').textContent().then((t) => t ?? '');
    expect(await log()).toMatch(/init.*"modulos":\["c4","integration","data","enterprise","platform","security"\].*"cargados":\["security"\]/);

    const svgLen = await page.evaluate(async () => (await (window as any).embed.export('svg', 'blast:pedidos')).length);
    expect(svgLen).toBeGreaterThan(500);
    const report = await page.evaluate(async () => (await (window as any).embed.run('risks')).output as string);
    expect(report).toContain('Inyección SQL en pedidos');
    const validation = await page.evaluate(async () => await (window as any).embed.validate());
    expect(validation.valid).toBe(true);
    const caps = await page.evaluate(async () => await (window as any).embed.capabilities(['data']));
    expect(caps.modules[0].id).toBe('data');

    await page.click('#btn-view');
    await frame!.getByRole('tab', { name: 'Vista SVG' }).click();
    await expect(frame!.locator('[data-testid="diagram-stage"] img')).toHaveAttribute('data-view', 'blast:pedidos');
    await expect.poll(log).toMatch(/viewChange.*blast:pedidos/);

    // una petición inválida rechaza la promesa con el mensaje del módulo
    const failure = await page.evaluate(async () => (await (window as any).embed.export('pdf').catch((e: Error) => e.message)) as string);
    expect(failure).toMatch(/no exporta a «pdf»/);

    // la persona edita: el anfitrión recibe change con el documento nuevo
    const editor = frame!.getByLabel('Documento JSON');
    const doc = JSON.parse(await editor.inputValue());
    doc.assets.push({ id: 'nuevo', name: 'Activo nuevo', kind: 'process', zoneId: 'interna' });
    await editor.fill(JSON.stringify(doc));
    await expect.poll(log, { timeout: 10000 }).toMatch(/change.*"activos":5/);

    // abrir otro módulo desde Mermaid
    await page.click('#btn-data');
    await expect.poll(log).toMatch(/load.*"module":"data"/);
    await expect(frame!.getByRole('tab', { name: 'Datos' })).toHaveAttribute('aria-selected', 'true');
    await expect(frame!.getByLabel('Documento JSON')).toHaveValue(/Almacén/);

    // guardar y salir desde la interfaz del widget
    await frame!.getByRole('button', { name: 'Guardar y salir' }).click();
    await page.waitForFunction(() => document.getElementById('state')?.textContent === 'salió');
    const after = await log();
    expect(after).toMatch(/save.*"module":"data".*"exit":true/);
    expect(hostErrors).toEqual([]);
  });

  test('ignora los mensajes de un origen no autorizado y contesta con error al JSON roto', async ({ page }) => {
    // Con iframes, `networkidle` a veces no se notifica aunque todo esté cargado y el `goto` agota el tiempo de la prueba: se espera por condiciones observables.
    await page.goto('/examples/modules-host.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('state')?.textContent === 'cargado', null, { timeout: 30000 });

    await page.evaluate(() => {
      const iframe = document.querySelector('iframe')!;
      iframe.contentWindow!.postMessage('{"action": "export", "format":', '*');
    });
    await expect.poll(() => page.locator('#log').textContent()).toMatch(/error/);

    const ignored = await page.evaluate(() => {
      return new Promise<boolean>((resolve) => {
        const iframe = document.querySelector('iframe')!;
        let got = false;
        const l = (e: MessageEvent) => {
          if (e.source === iframe.contentWindow) got = true;
        };
        window.addEventListener('message', l);
        const rogue = document.createElement('iframe');
        rogue.src = iframe.src.replace(/origin=[^&]+/, 'origin=' + encodeURIComponent('https://otro.example'));
        rogue.style.display = 'none';
        document.body.appendChild(rogue);
        setTimeout(() => {
          rogue.contentWindow!.postMessage(JSON.stringify({ action: 'setView', viewId: 'dfd' }), '*');
          setTimeout(() => {
            window.removeEventListener('message', l);
            resolve(!got);
          }, 800);
        }, 2500);
      });
    });
    expect(ignored, 'el banco de trabajo ignora acciones de un origen no autorizado').toBe(true);
  });
});
