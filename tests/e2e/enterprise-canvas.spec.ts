import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { canvasReady, selectView } from './canvas-helpers';

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/modulos.html?bank=1&module=enterprise', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('module-canvas')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 20000 });
  await canvasReady(page);
  return errors;
}

/** Sustituye el documento por el ejemplo ampliado con las relaciones nuevas y vuelve al lienzo. */
async function loadExtended(page: Page): Promise<void> {
  const doc = JSON.parse(readFileSync('examples/empresa-arquitectura.json', 'utf8')) as {
    processes: Array<Record<string, unknown>>;
    applications: Array<Record<string, unknown>>;
    relations: Array<Record<string, unknown>>;
  };
  doc.processes.push({ id: 'preparacion-pedido', name: 'Preparación de pedido', ownerId: 'logistica' });
  doc.applications.push({ id: 'erp-facturacion', name: 'ERP · módulo de facturación', technology: 'SAP S/4HANA', ownerId: 'finanzas', criticality: 'high', annualCost: 210000, users: 40, strategy: 'keep' });
  for (const a of doc.applications) {
    if (a.id === 'wms-legacy') a.endOfLife = '2027-03';
    if (a.id === 'portal-proveedores') a.endOfLife = '2026-12';
  }
  doc.relations.push(
    { id: 'erp--composes--erp-facturacion', kind: 'composes', sourceId: 'erp', targetId: 'erp-facturacion' },
    { id: 'erp-facturacion--flows-to--facturacion-electronica', kind: 'flows-to', sourceId: 'erp-facturacion', targetId: 'facturacion-electronica', description: 'facturas a emitir' },
    { id: 'alta-pedido--triggers--preparacion-pedido', kind: 'triggers', sourceId: 'alta-pedido', targetId: 'preparacion-pedido' },
    { id: 'preparacion-pedido--realizes--gestion-inventario', kind: 'realizes', sourceId: 'preparacion-pedido', targetId: 'gestion-inventario' },
    { id: 'ventas--assigned-to--alta-pedido', kind: 'assigned-to', sourceId: 'ventas', targetId: 'alta-pedido' },
    { id: 'logistica--assigned-to--preparacion-pedido', kind: 'assigned-to', sourceId: 'logistica', targetId: 'preparacion-pedido' },
  );
  await page.getByRole('tab', { name: 'Vista SVG' }).click();
  await page.getByLabel('Documento JSON').fill(JSON.stringify(doc, null, 2));
  await page.getByRole('tab', { name: 'Lienzo' }).click();
  await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 20000 });
}

const shot = (page: Page, name: string): Promise<Buffer> => page.screenshot({ path: `test-results/empresarial-${name}.png` });

test.describe('lienzo empresarial: capas, mapa por criterio y relaciones nuevas', () => {
  test('los nodos llevan el color de su capa y el icono de su tipo', async ({ page }) => {
    const errors = await open(page);
    await selectView(page, 'landscape');
    const app = page.getByTestId('node-tienda-web');
    await expect(app).toBeVisible();
    await expect(app.getByTestId('icon-tienda-web')).toBeVisible();
    await expect(page.getByTestId('node-kubernetes').getByTestId('icon-kubernetes')).toBeVisible();
    await expect(app.locator('path').first()).toHaveAttribute('fill', '#74c0fc');
    await expect(page.getByTestId('node-kubernetes').locator('path').first()).toHaveAttribute('fill', '#8ce99a');
    await shot(page, 'paisaje-capas');
    expect(errors).toEqual([]);
  });

  test('el mapa de capacidades se colora por madurez, importancia, criticidad o ciclo de vida, con leyenda', async ({ page }) => {
    const errors = await open(page);
    const legend = page.getByTestId('canvas-legend');
    await expect(legend).toContainText('Color: madurez');
    await shot(page, 'mapa-madurez');
    for (const [value, title, name] of [
      ['capabilities:importance', 'Color: importancia', 'mapa-importancia'],
      ['capabilities:criticality', 'Color: criticidad de las aplicaciones', 'mapa-criticidad'],
      ['capabilities:lifecycle', 'Color: ciclo de vida de las aplicaciones', 'mapa-ciclo-de-vida'],
    ] as const) {
      await selectView(page, value, 'canvas-variant');
      await expect(legend).toContainText(title);
      await expect(page.getByTestId('node-gestion-inventario')).toBeVisible();
      await shot(page, name);
    }
    // «Vista» sigue siendo el mapa: la variante no aparece como una vista más.
    await expect(page.getByTestId('canvas-view')).toHaveValue('capabilities');
    expect(errors).toEqual([]);
  });

  test('composición, flujo, asignación y disparo se dibujan con su notación', async ({ page }) => {
    const errors = await open(page);
    await loadExtended(page);
    await selectView(page, 'landscape');
    await expect(page.getByTestId('node-ventas')).toHaveAttribute('data-kind', 'unit');
    await expect(page.locator('.react-flow__edge[data-id="erp--composes--erp-facturacion"] [data-tail="diamond"]')).toBeVisible();
    await expect(page.locator('.react-flow__edge[data-id="ventas--assigned-to--alta-pedido"] [data-tail="dot"]')).toBeVisible();
    await expect(page.locator('.react-flow__edge[data-id="alta-pedido--triggers--preparacion-pedido"]')).toBeVisible();
    await page.getByTestId('node-erp-facturacion').click();
    await expect(page.getByTestId('inspector').getByLabel('Estrategia de modernización')).toHaveValue('keep');
    await expect(page.getByTestId('inspector').getByLabel('Coste anual')).toHaveValue('210000');
    await shot(page, 'paisaje-relaciones');
    expect(errors).toEqual([]);
  });

  test('la relación se elige en la barra y el mismo selector ofrece los cuatro tipos nuevos', async ({ page }) => {
    await open(page);
    const kinds = await page.getByTestId('edge-kind').locator('option').allTextContents();
    expect(kinds).toEqual(expect.arrayContaining(['se compone de', 'fluye hacia', 'ejecuta', 'dispara a']));
  });

  test('los metadatos de una aplicación se editan en sus propiedades y llegan al documento', async ({ page }) => {
    await open(page);
    await selectView(page, 'landscape');
    await page.getByTestId('node-crm').click();
    const inspector = page.getByTestId('inspector');
    await inspector.getByLabel('Coste anual').fill('300000');
    await inspector.getByLabel('Usuarios').fill('150');
    await inspector.getByLabel('Estrategia de modernización').selectOption('migrate');
    await expect(page.getByTestId('node-crm')).toContainText('estrategia migrar');
    await expect(page.getByTestId('node-crm')).toContainText('300 k/año');
    await page.getByRole('tab', { name: 'Vista SVG' }).click();
    const text = await page.getByLabel('Documento JSON').inputValue();
    expect(text).toContain('"annualCost": 300000');
    expect(text).toContain('"strategy": "migrate"');
  });

  test('la hoja de ruta del ciclo de vida agrupa en columnas y «Agrupar por unidad» y «Reemplazar aplicación» actúan sobre la selección', async ({ page }) => {
    const errors = await open(page);
    await loadExtended(page);
    await selectView(page, 'roadmap');
    await expect(page.getByTestId('node-roadmap:2027')).toBeVisible();
    await expect(page.getByTestId('node-roadmap:2026')).toBeVisible();
    await expect(page.getByTestId('node-wms-legacy')).toContainText('estrategia reemplazar');
    await expect(page.getByTestId('node-hana')).toContainText('soporte hasta 2034-12');
    await shot(page, 'hoja-de-ruta');

    await selectView(page, 'landscape');
    await page.getByTestId('node-crm').click();
    await page.getByTestId('action-replace-application').click();
    await page.getByTestId('action-prompt').locator('input').fill('CRM nuevo');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('node-crm-nuevo')).toBeVisible();
    await expect(page.getByTestId('node-crm')).toContainText('en retirada');

    await page.getByTestId('node-tms').click();
    await page.getByTestId('node-wms-nuevo').click({ modifiers: ['Control'] });
    await page.getByTestId('action-group-by-unit').click();
    await page.getByTestId('action-prompt').locator('input').fill('Equipo de datos');
    await page.keyboard.press('Enter');
    await page.getByRole('tab', { name: 'Vista SVG' }).click();
    const text = await page.getByLabel('Documento JSON').inputValue();
    expect(text).toContain('"id": "equipo-de-datos"');
    expect(JSON.parse(text).applications.find((a: { id: string }) => a.id === 'tms').ownerId).toBe('equipo-de-datos');
    expect(errors).toEqual([]);
  });
  test('los flujos de valor dibujan las etapas como chevrones en cadena con las capacidades que las habilitan', async ({ page }) => {
    const errors = await open(page);
    await page.getByRole('tab', { name: 'Vista SVG' }).click();
    await page.getByLabel('Documento JSON').fill(readFileSync('examples/empresa-flujo-de-valor.json', 'utf8'));
    await page.getByRole('tab', { name: 'Lienzo' }).click();
    await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 20000 });
    await selectView(page, 'value-stream');
    await expect(page.getByTestId('node-pedir')).toBeVisible();
    const stages = ['descubrir', 'pedir', 'preparar', 'entregar', 'posventa'];
    const boxes = [];
    for (const id of stages) {
      const node = page.getByTestId(`node-${id}`);
      await expect(node).toBeVisible();
      await expect(node).toHaveAttribute('data-kind', 'stage');
      boxes.push((await node.boundingBox())!);
    }
    await expect(page.getByTestId('node-pedir').locator('path').first()).toHaveAttribute('fill', '#ffd43b');
    for (let i = 1; i < boxes.length; i += 1) {
      expect(Math.abs(boxes[i].y - boxes[0].y)).toBeLessThan(2);
      expect(boxes[i].x).toBeGreaterThan(boxes[i - 1].x);
    }
    const cobros = (await page.getByTestId('node-cobros').boundingBox())!;
    expect(cobros.y).toBeGreaterThan(boxes[0].y + boxes[0].height);
    await expect(page.locator('.react-flow__edge[data-id="cobros--enables--pedir"]')).toBeVisible();
    // Cada arista baja de su etapa a su capacidad por el canal que las separa (asa de abajo a asa de arriba): no recorre el borde
    // de la zona ni da rodeos, y las capacidades quedan en el orden de sus etapas.
    await expect(page.getByTestId('node-pedir').locator('.react-flow__handle-bottom')).toHaveCount(1);
    await expect(page.getByTestId('node-cobros').locator('.react-flow__handle-top')).toHaveCount(1);
    const enabling: Array<[string, string]> = [['descubrir', 'ventas-online'], ['descubrir', 'precios-promociones'], ['pedir', 'gestion-pedidos'], ['pedir', 'cobros'], ['preparar', 'gestion-inventario'], ['entregar', 'distribucion'], ['posventa', 'atencion-cliente']];
    const capabilityXs: number[] = [];
    for (const [stage, capability] of enabling) {
      const from = (await page.getByTestId(`node-${stage}`).boundingBox())!;
      const to = (await page.getByTestId(`node-${capability}`).boundingBox())!;
      const route = (await page.locator(`.react-flow__edge[data-id="${capability}--enables--${stage}"] path.react-flow__edge-path`).boundingBox())!;
      expect(route.y, `${stage} → ${capability}`).toBeGreaterThanOrEqual(from.y + from.height - 8);
      expect(route.y + route.height, `${stage} → ${capability}`).toBeLessThanOrEqual(to.y + 8);
      capabilityXs.push(to.x);
    }
    expect(capabilityXs).toEqual([...capabilityXs].sort((a, b) => a - b));
    await shot(page, 'flujo-de-valor');

    // Editar una etapa y añadir otra detrás de ella.
    await page.getByTestId('node-pedir').click();
    await page.getByTestId('inspector').getByLabel('Valor que aporta').fill('pedido pagado');
    await page.getByTestId('inspector').getByLabel('Valor que aporta').blur();
    await expect(page.getByTestId('node-pedir')).toContainText('pedido pagado');
    await page.getByTestId('add-stage').click();
    await page.getByRole('tab', { name: 'Vista SVG' }).click();
    const doc = JSON.parse(await page.getByLabel('Documento JSON').inputValue()) as { valueStages: Array<{ id: string; value?: string }> };
    expect(doc.valueStages.map((x) => x.id).slice(0, 4)).toEqual(['descubrir', 'pedir', 'etapa-nuevo', 'preparar']);
    expect(doc.valueStages.find((x) => x.id === 'pedir')?.value).toBe('pedido pagado');
    expect(errors).toEqual([]);
  });

  test('una capacidad compartida por el primer y el tercer flujo se une por un pasillo libre: ninguna arista pisa un nodo ni un rótulo y, si se mueve una etapa, la arista se traza como siempre', async ({ page }) => {
    const errors = await open(page);
    await page.getByRole('tab', { name: 'Vista SVG' }).click();
    await page.getByLabel('Documento JSON').fill(readFileSync('tests/fixtures/empresa-flujos-compartidos.json', 'utf8'));
    await page.getByRole('tab', { name: 'Lienzo' }).click();
    await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 20000 });
    await selectView(page, 'value-stream');
    const id = 'gestion-clientes--enables--acompanar';
    const line = page.locator(`.react-flow__edge[data-id="${id}"] path.react-flow__edge-path`);
    await expect(line).toBeVisible();
    await expect(page.getByTestId('node-acompanar').locator('.react-flow__handle-top')).toHaveCount(1);
    await expect(page.getByTestId('node-gestion-clientes').locator('.react-flow__handle-bottom')).toHaveCount(1);

    // Recorre cada línea punto a punto y anota los nodos (etapas y capacidades) y los rótulos de recuadro que atraviesa.
    const crossed = (): Promise<string[]> =>
      page.evaluate(() => {
        const rects = [...document.querySelectorAll('[data-testid^="node-"]')]
          .filter((el) => ['stage', 'capability'].includes(el.getAttribute('data-kind') ?? ''))
          .map((el) => ({ name: el.getAttribute('data-testid')!, box: el.getBoundingClientRect() }))
          .concat([...document.querySelectorAll('.cv-group-title')].map((el) => ({ name: `rótulo «${el.textContent}»`, box: el.getBoundingClientRect() })));
        const found = new Set<string>();
        for (const path of document.querySelectorAll<SVGPathElement>('.react-flow__edge path.react-flow__edge-path')) {
          const m = path.getScreenCTM()!;
          const total = path.getTotalLength();
          for (let at = 0; at <= total; at += 2) {
            const p = path.getPointAtLength(at);
            const [x, y] = [m.a * p.x + m.c * p.y + m.e, m.b * p.x + m.d * p.y + m.f];
            for (const { name, box } of rects) if (x > box.left + 2 && x < box.right - 2 && y > box.top + 2 && y < box.bottom - 2) found.add(`${path.closest('.react-flow__edge')?.getAttribute('data-id')} → ${name}`);
          }
        }
        return [...found];
      });
    expect(await crossed()).toEqual([]);

    // Sube por la derecha del segundo flujo, con cuatro giros redondeados, y llega por debajo de la capacidad.
    const d = (await line.getAttribute('d'))!;
    expect(d.match(/Q/g)).toHaveLength(4);
    const [stage, group, capability] = await Promise.all([page.getByTestId('node-acompanar').boundingBox(), page.getByTestId('node-emitir').boundingBox(), page.getByTestId('node-gestion-clientes').boundingBox()]);
    const route = (await line.boundingBox())!;
    expect(route.x + route.width).toBeGreaterThan(group!.x + group!.width);
    expect(route.y).toBeLessThan(capability!.y + capability!.height + 2);
    expect(route.y + route.height).toBeGreaterThan(stage!.y - 30);
    await shot(page, 'flujo-de-valor-rutas');

    // Si se mueve la etapa, la ruta guardada ya no vale y la arista se traza entre sus asas, como las demás.
    const box = (await page.getByTestId('node-acompanar').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 12, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await line.getAttribute('d')) !== d).toBe(true);
    expect(((await line.getAttribute('d')) ?? '').match(/Q/g)?.length ?? 0).toBeLessThan(4);
    await expect(line).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('en el paisaje se puede arrastrar una asignación hacia una unidad que solo era responsable', async ({ page }) => {
    const errors = await open(page);
    await selectView(page, 'landscape');
    await expect(page.getByTestId('node-plataforma')).toHaveAttribute('data-kind', 'unit');
    await page.getByTestId('edge-kind').selectOption('assigned-to');
    const from = (await page.getByTestId('node-alta-pedido').locator('.react-flow__handle.source').boundingBox())!;
    const to = (await page.getByTestId('node-plataforma').locator('.react-flow__handle.target').boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.getByRole('tab', { name: 'Vista SVG' }).click();
    const doc = JSON.parse(await page.getByLabel('Documento JSON').inputValue()) as { relations: Array<{ kind: string; sourceId: string; targetId: string }> };
    expect(doc.relations).toContainEqual(expect.objectContaining({ kind: 'assigned-to', sourceId: 'plataforma', targetId: 'alta-pedido' }));
    expect(errors).toEqual([]);
  });

  test('un documento sin relaciones también tiene paisaje y sus unidades se alcanzan en el lienzo', async ({ page }) => {
    const errors = await open(page);
    const doc = {
      version: '1.0',
      workspace: { name: 'Sin relaciones' },
      units: [{ id: 'direccion', name: 'Dirección' }, { id: 'equipo', name: 'Equipo', parentId: 'direccion' }],
      applications: [{ id: 'crm', name: 'CRM', ownerId: 'equipo' }],
    };
    await page.getByRole('tab', { name: 'Vista SVG' }).click();
    await page.getByLabel('Documento JSON').fill(JSON.stringify(doc, null, 2));
    await page.getByRole('tab', { name: 'Lienzo' }).click();
    await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 20000 });
    await canvasReady(page);
    const views = await page.getByTestId('canvas-view').locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    expect(views).toContain('landscape');
    await selectView(page, 'landscape');
    await expect(page.getByTestId('node-direccion')).toHaveAttribute('data-kind', 'unit');
    await expect(page.getByTestId('node-equipo')).toBeVisible();
    await expect(page.getByTestId('node-crm')).toBeVisible();
    await shot(page, 'paisaje-sin-relaciones');
    expect(errors).toEqual([]);
  });
});

test.describe('lienzo empresarial: matriz capacidad × aplicación', () => {
  /** El ejemplo más una capacidad sin aplicación (hueco), para ver el aviso. */
  async function loadWithGap(page: Page): Promise<void> {
    const doc = JSON.parse(readFileSync('examples/empresa-arquitectura.json', 'utf8')) as { capabilities: Array<Record<string, unknown>> };
    doc.capabilities.push({ id: 'analitica-negocio', name: 'Analítica de negocio', parentId: 'gestion-comercial', importance: 'differentiating', maturity: 1 });
    await page.getByRole('tab', { name: 'Vista SVG' }).click();
    await page.getByLabel('Documento JSON').fill(JSON.stringify(doc, null, 2));
    await page.getByRole('tab', { name: 'Lienzo' }).click();
    await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 20000 });
  }

  const relationsOf = async (page: Page): Promise<Array<{ kind: string; sourceId: string; targetId: string }>> => {
    await page.getByRole('tab', { name: 'Vista SVG' }).click();
    const doc = JSON.parse(await page.getByLabel('Documento JSON').inputValue()) as { relations: Array<{ kind: string; sourceId: string; targetId: string }> };
    await page.getByRole('tab', { name: 'Lienzo' }).click();
    await canvasReady(page);
    return doc.relations;
  };
  const supports = (rels: Array<{ kind: string; sourceId: string; targetId: string }>, app: string, cap: string): boolean => rels.some((r) => r.kind === 'supports' && r.sourceId === app && r.targetId === cap);

  test('la matriz dibuja las capacidades en filas, las aplicaciones en columnas, los totales y los avisos de hueco y solapamiento', async ({ page }) => {
    const errors = await open(page);
    await loadWithGap(page);
    await expect(page.getByTestId('canvas-view').locator('option[value="matrix"]')).toHaveCount(1);
    await selectView(page, 'matrix');
    await expect(page.getByTestId('node-ventas-online')).toContainText('Ventas online');
    await expect(page.getByTestId('node-tienda-web')).toContainText('crit.');
    await expect(page.getByTestId('node-cell:ventas-online|tienda-web')).toContainText('●');
    await expect(page.getByTestId('node-cell:gestion-pedidos|tienda-web')).toContainText('○');
    await expect(page.getByTestId('node-cell:gestion-comercial|tienda-web')).toContainText('·');
    await expect(page.getByTestId('node-total:row:analitica-negocio')).toContainText('hueco');
    await expect(page.getByTestId('node-total:row:gestion-pedidos')).toContainText('solapamiento');
    await expect(page.getByTestId('node-total:row:gestion-inventario')).toContainText('transición');
    await expect(page.getByTestId('node-total:all')).toContainText('12/13');
    await expect(page.getByTestId('node-total:all')).toContainText('cubiertas');
    await shot(page, 'matriz');
    expect(errors).toEqual([]);
  });

  test('«Soporta ⇄» y el doble clic crean y quitan la relación «soporta» de la celda, y el inspector la edita', async ({ page }) => {
    const errors = await open(page);
    await loadWithGap(page);
    await selectView(page, 'matrix');
    const action = page.getByTestId('action-matrix-support');
    await expect(action).toBeDisabled();

    // Una celda vacía: se marca con la acción.
    await page.getByTestId('node-cell:analitica-negocio|crm').click();
    await expect(action).toBeEnabled();
    await expect(page.getByTestId('inspector').getByLabel('La aplicación soporta la capacidad')).not.toBeChecked();
    await action.click();
    await expect(page.getByTestId('node-cell:analitica-negocio|crm')).toContainText('●');
    await expect(page.getByTestId('node-total:row:analitica-negocio')).not.toContainText('hueco');
    expect(supports(await relationsOf(page), 'crm', 'analitica-negocio')).toBe(true);

    // Se quita con el doble clic.
    await page.getByTestId('node-cell:analitica-negocio|crm').dblclick();
    await expect(page.getByTestId('node-cell:analitica-negocio|crm')).not.toContainText('●');
    await expect(page.getByTestId('node-total:row:analitica-negocio')).toContainText('hueco');
    expect(supports(await relationsOf(page), 'crm', 'analitica-negocio')).toBe(false);

    // Y el criterio de la convivencia se escribe en las propiedades de la celda.
    await page.getByTestId('node-cell:gestion-pedidos|erp').click();
    const inspector = page.getByTestId('inspector');
    await expect(inspector.getByLabel('La aplicación soporta la capacidad')).toBeChecked();
    await inspector.getByLabel('Criterio (por qué la soporta)').fill('canal de venta asistida');
    await inspector.getByLabel('Criterio (por qué la soporta)').blur();
    await expect(inspector.getByLabel('Criterio (por qué la soporta)')).toHaveValue('canal de venta asistida');
    await expect(page.getByTestId('node-total:row:gestion-pedidos')).toContainText('con criterio');
    await inspector.getByLabel('La aplicación soporta la capacidad').uncheck();
    await expect(page.getByTestId('node-cell:gestion-pedidos|erp')).not.toContainText('●');
    expect(supports(await relationsOf(page), 'erp', 'gestion-pedidos')).toBe(false);
    expect(errors).toEqual([]);
  });
});
