import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test as base, type BrowserContext, type Page } from '@playwright/test';
import { openEditor } from './canvas-helpers';
import { startCloudServer, type CloudServer } from './cloud-server';

/**
 * Cambios de los proyectos en tiempo real, entre dos navegadores de verdad (dos contextos, dos personas) contra un `iark serve --tokens` real: lo que una
 * persona guarda le llega a la otra por el canal de eventos (SSE) en segundos, no en los 30 s del sondeo; el aviso «hay una versión más nueva» se anuncia en una
 * región de estado accesible y se carga con el teclado; con trabajo pendiente en este navegador no sale (manda el conflicto de siempre y no se pierde nada);
 * con un servidor sin canal (`--max-streams 0`) todo sigue funcionando como antes; y si el servidor se cae y vuelve, el canal se reconecta solo.
 */
const example = (file: string): string => readFileSync(new URL(`../../examples/${file}`, import.meta.url), 'utf8');

const PEOPLE = [
  { name: 'ana', role: 'editor' as const },
  { name: 'beto', role: 'editor' as const },
  { name: 'root', role: 'admin' as const },
];

const test = base.extend<{ origin: string; server: CloudServer }>({
  origin: async ({ baseURL }, use) => use(new URL(baseURL!).origin),
  server: async ({ origin }, use) => {
    const server = await startCloudServer({ cors: origin, people: PEOPLE });
    try {
      await use(server);
    } finally {
      await server.stop();
    }
  },
});

const saveStatus = (page: Page) => page.getByTestId('save-status');
const editor = (page: Page) => page.getByLabel('Documento JSON');
const region = (page: Page) => page.getByTestId('newer-version-text');
const CLEAN = 'Guardado en «Tienda» · servidor';

async function api(server: CloudServer, token: string, method: string, path: string, body?: unknown): Promise<{ id: string; updatedAt?: string }> {
  const response = await fetch(`${server.url}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.ok, `${method} ${path} → ${response.status}`).toBe(true);
  return response.json();
}

async function seed(server: CloudServer): Promise<{ projectId: string; diagramId: string }> {
  const created = await api(server, server.tokens.root, 'POST', '/api/projects', { name: 'Tienda' });
  const meta = await api(server, server.tokens.root, 'POST', `/api/projects/${created.id}/diagrams`, { module: 'data', name: 'Ventas', text: example('ventas-datos.json') });
  return { projectId: created.id, diagramId: meta.id };
}

/** Los nombres de los diagramas (en disco) de un proyecto: la fuente de verdad. */
function names(server: CloudServer, project: string): string[] {
  const dir = join(server.workspace, project);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.[a-z0-9-]+\.json$/.test(f) && f !== 'project.json')
    .map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')).workspace.name as string);
}

async function preconnect(context: BrowserContext, server: CloudServer, person: 'ana' | 'beto' | 'root'): Promise<void> {
  await context.addInitScript(
    ([url, secret]) => {
      localStorage.setItem('iark.projects.backend', JSON.stringify({ kind: 'remote', url }));
      sessionStorage.setItem(`iark.projects.token:${url}`, secret);
    },
    [server.url, server.tokens[person]] as const,
  );
}

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`/modulos.html?${query}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('project-bar')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('editor-status')).toContainText('Válido', { timeout: 20000 });
  await expect(saveStatus(page)).toHaveText(CLEAN, { timeout: 20000 });
}

async function showEditor(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Vista SVG' }).click();
  await expect(editor(page)).toBeVisible();
}

/** Cambia el nombre del espacio de trabajo desde el editor de texto (lo que dispara el autoguardado). */
async function rename(page: Page, name: string): Promise<void> {
  const doc = JSON.parse(await editor(page).inputValue());
  doc.workspace.name = name;
  await editor(page).fill(JSON.stringify(doc, null, 2));
}

/** Otra persona guarda el diagrama por la API (como lo haría otra pestaña, otro equipo o la CLI), con su token. */
async function saveAs(server: CloudServer, person: 'ana' | 'beto', projectId: string, diagramId: string, name: string): Promise<void> {
  const doc = JSON.parse(example('ventas-datos.json'));
  doc.workspace.name = name;
  await api(server, server.tokens[person], 'PUT', `/api/projects/${projectId}/diagrams/${diagramId}`, { text: JSON.stringify(doc, null, 2) });
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

async function queueRows(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const opening = indexedDB.open('iark-offline');
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
          const db = opening.result;
          if (!db.objectStoreNames.contains('pending')) {
            db.close();
            resolve('[]');
            return;
          }
          const all = db.transaction('pending', 'readonly').objectStore('pending').getAll();
          all.onerror = () => reject(all.error);
          all.onsuccess = () => {
            db.close();
            resolve(JSON.stringify(all.result));
          };
        };
      }),
  );
}

test.describe('cambios en tiempo real entre personas (servidor propio)', () => {
  test('Beto guarda y a Ana le llega el aviso en segundos (no en 30 s); lo carga con el teclado y guarda encima sin conflicto', async ({ page, server, browser }) => {
    const { projectId, diagramId } = await seed(server);
    await preconnect(page.context(), server, 'ana');
    await open(page, `module=data&project=${projectId}&diagram=${diagramId}`);
    await showEditor(page);

    // el canal está en directo y la región de estado está en la página, cortés y vacía, ANTES de que haya nada que anunciar
    await expect(page.getByTestId('project-bar')).toHaveAttribute('data-live', 'live', { timeout: 15000 });
    await expect(region(page)).toHaveAttribute('role', 'status');
    await expect(region(page)).toHaveAttribute('aria-live', 'polite');
    await expect(region(page)).toBeEmpty();
    await expect(page.getByTestId('newer-version-load')).toHaveCount(0);

    const second = await browser.newContext();
    try {
      await preconnect(second, server, 'beto');
      const other = await second.newPage();
      await open(other, `module=data&project=${projectId}&diagram=${diagramId}`);
      await showEditor(other);
      await rename(other, 'Cambio de Beto');
      await expect(saveStatus(other)).toHaveAttribute('data-save', 'saved', { timeout: 15000 });
      const savedAt = Date.now();

      // a Ana le llega por el canal, mucho antes de los 30 s del sondeo
      await expect(region(page)).toContainText('beto guardó una versión más nueva de «', { timeout: 8000 });
      expect(Date.now() - savedAt).toBeLessThan(8000);
      // lo que está escribiendo Ana no se tocó
      expect(JSON.parse(await editor(page).inputValue()).workspace.name).not.toBe('Cambio de Beto');
      await expect(saveStatus(page)).toHaveText(CLEAN);

      // con el teclado: «Cargar la nueva» se alcanza con Tab y se activa con Intro
      const load = page.getByTestId('newer-version-load');
      await expect(load).toHaveAccessibleName('Cargar la nueva');
      await expect(page.getByTestId('newer-version-dismiss')).toHaveAccessibleName('Ignorar el aviso de versión más nueva');
      await load.focus();
      await page.keyboard.press('Enter');
      await expect.poll(async () => JSON.parse(await editor(page).inputValue()).workspace.name).toBe('Cambio de Beto');
      await expect(region(page)).toContainText('Se cargó la versión nueva de «');
      await expect(region(page)).toBeFocused(); // el botón desapareció: el foco no se pierde, pasa a la región que cuenta el resultado
      await expect(page.getByTestId('newer-version-load')).toHaveCount(0);
      await expect(saveStatus(page)).toHaveText(CLEAN);

      // Ana edita y guarda encima de lo cargado: sin conflicto
      await rename(page, 'Cambio de Ana');
      await expect(saveStatus(page)).toHaveAttribute('data-save', 'saved', { timeout: 15000 });
      await expect.poll(() => names(server, projectId)).toEqual(['Cambio de Ana']);

      // y a Beto le llega el aviso de Ana (en el otro sentido)
      await expect(region(other)).toContainText('ana guardó una versión más nueva de «', { timeout: 8000 });
    } finally {
      await second.close();
    }
  });

  test('«Ignorar» quita el aviso sin cargar nada y no vuelve por lo mismo', async ({ page, server }) => {
    const { projectId, diagramId } = await seed(server);
    await preconnect(page.context(), server, 'ana');
    await open(page, `module=data&project=${projectId}&diagram=${diagramId}`);
    await showEditor(page);
    await expect(page.getByTestId('project-bar')).toHaveAttribute('data-live', 'live', { timeout: 15000 });

    await saveAs(server, 'beto', projectId, diagramId, 'Cambio de Beto');
    await expect(region(page)).toContainText('beto guardó una versión más nueva', { timeout: 8000 });
    await page.getByTestId('newer-version-dismiss').click();
    await expect(region(page)).toBeEmpty();
    expect(JSON.parse(await editor(page).inputValue()).workspace.name).not.toBe('Cambio de Beto');

    // otro cambio más nuevo sí vuelve a avisar
    await saveAs(server, 'beto', projectId, diagramId, 'Otro cambio de Beto');
    await expect(region(page)).toContainText('beto guardó una versión más nueva', { timeout: 8000 });
  });

  test('con trabajo pendiente sin conexión NO sale el aviso: manda el conflicto de siempre y no se pierde nada', async ({ page, server, browser }) => {
    const { projectId, diagramId } = await seed(server);
    await preconnect(page.context(), server, 'ana');
    await open(page, `module=data&project=${projectId}&diagram=${diagramId}`);
    await showEditor(page);
    await expect(page.getByTestId('project-bar')).toHaveAttribute('data-live', 'live', { timeout: 15000 });
    // en cuanto el aviso se active alguna vez, se queda anotado (aunque dure un instante)
    await page.evaluate(() => {
      (window as unknown as { __avisos: number }).__avisos = 0;
      const notice = document.querySelector('[data-testid="newer-version"]')!;
      new MutationObserver(() => {
        if (notice.getAttribute('data-active') === 'true') (window as unknown as { __avisos: number }).__avisos += 1;
      }).observe(notice, { attributes: true, attributeFilter: ['data-active'] });
    });

    await page.context().setOffline(true);
    await rename(page, 'Lo de Ana sin red');
    await expect(saveStatus(page)).toHaveText('Sin conexión: 1 cambio pendiente', { timeout: 15000 });

    const second = await browser.newContext();
    try {
      await preconnect(second, server, 'beto');
      const other = await second.newPage();
      await open(other, `module=data&project=${projectId}&diagram=${diagramId}`);
      await showEditor(other);
      await rename(other, 'Lo de Beto');
      await expect(saveStatus(other)).toHaveAttribute('data-save', 'saved', { timeout: 15000 });
    } finally {
      await second.close();
    }
    await expect.poll(() => names(server, projectId)).toEqual(['Lo de Beto']);

    await page.context().setOffline(false);
    await expect(saveStatus(page)).toHaveText('Hay un conflicto que resolver', { timeout: 30000 });
    await expect(page.getByTestId('resolve-conflict')).toBeVisible();
    // ni el aviso salió, ni se pisó lo del servidor, ni se perdió lo de Ana
    expect(await page.evaluate(() => (window as unknown as { __avisos: number }).__avisos)).toBe(0);
    await expect(region(page)).toBeEmpty();
    expect(names(server, projectId)).toEqual(['Lo de Beto']);
    expect(await queueRows(page)).toContain('Lo de Ana sin red');
    expect(JSON.parse(await editor(page).inputValue()).workspace.name).toBe('Lo de Ana sin red');
  });

  test('sin canal de eventos (--max-streams 0) todo sigue como antes: el servidor no lo declara, la sesión lo sabe y el aviso llega con el sondeo al volver el foco', async ({ page, origin }) => {
    const server = await startCloudServer({ cors: origin, people: PEOPLE, env: { IARK_MAX_STREAMS: '0' } });
    try {
      const { projectId, diagramId } = await seed(server);
      const manifest = await (await fetch(`${server.url}/.well-known/iark.json`)).json();
      expect(manifest.projects).toBeTruthy();
      expect(manifest).not.toHaveProperty('projectsEvents');
      const probe = await fetch(`${server.url}/api/events`, { headers: { Authorization: `Bearer ${server.tokens.ana}` } });
      expect(probe.status).toBe(404);

      await preconnect(page.context(), server, 'ana');
      await open(page, `module=data&project=${projectId}&diagram=${diagramId}`);
      await showEditor(page);
      await expect(page.getByTestId('project-bar')).toHaveAttribute('data-live', 'unsupported', { timeout: 15000 });
      await expect(saveStatus(page)).toHaveText(CLEAN);

      await saveAs(server, 'beto', projectId, diagramId, 'Cambio de Beto');
      // sin canal, el sondeo de siempre: al volver el foco a la pestaña se mira al instante
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      // (sin canal el sondeo no sabe quién guardó: el aviso lo dice sin nombre)
      await expect(region(page)).toContainText('Se guardó una versión más nueva de «', { timeout: 15000 });
      await page.getByTestId('newer-version-load').click();
      await expect.poll(async () => JSON.parse(await editor(page).inputValue()).workspace.name).toBe('Cambio de Beto');
    } finally {
      await server.stop();
    }
  });

  test('si el servidor se cae y vuelve, el canal se reconecta solo (con espera creciente) y los cambios siguen llegando', async ({ page, origin }) => {
    test.setTimeout(90_000);
    const server = await startCloudServer({ cors: origin, people: PEOPLE, keepPort: true });
    try {
      const { projectId, diagramId } = await seed(server);
      await preconnect(page.context(), server, 'ana');
      await open(page, `module=data&project=${projectId}&diagram=${diagramId}`);
      await showEditor(page);
      const bar = page.getByTestId('project-bar');
      await expect(bar).toHaveAttribute('data-live', 'live', { timeout: 15000 });

      // se corta de golpe (sin avisar) y vuelve unos segundos después
      const restarting = server.restart({ kill: 'SIGKILL', downMs: 3000 });
      await expect(bar).toHaveAttribute('data-live', 'retrying', { timeout: 15000 });
      await restarting;
      await expect(bar).toHaveAttribute('data-live', 'live', { timeout: 45000 });

      await saveAs(server, 'beto', projectId, diagramId, 'Después de la caída');
      await expect(region(page)).toContainText('beto guardó una versión más nueva', { timeout: 10000 });
    } finally {
      await server.stop();
    }
  });

  test('un token revocado cierra el canal sin bucles y la pestaña lo dice (rechazado), sin perder lo escrito', async ({ page, server }) => {
    const { projectId, diagramId } = await seed(server);
    await preconnect(page.context(), server, 'ana');
    await open(page, `module=data&project=${projectId}&diagram=${diagramId}`);
    await showEditor(page);
    const bar = page.getByTestId('project-bar');
    await expect(bar).toHaveAttribute('data-live', 'live', { timeout: 15000 });
    const attempts: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/events')) attempts.push(request.url());
    });
    server.revoke('ana');
    // el latido vuelve a comprobar la credencial: el servidor cierra con «bye» y la pestaña no insiste
    await expect(bar).toHaveAttribute('data-live', 'rejected', { timeout: 60000 });
    const before = attempts.length;
    await page.waitForTimeout(3000);
    expect(attempts.length).toBe(before);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`accesibilidad del aviso (tema ${theme}): región de estado, teclado, contraste ≥ 4,5:1 y sin desbordar en 390 px`, async ({ page, server }) => {
      const { projectId, diagramId } = await seed(server);
      await page.setViewportSize({ width: 390, height: 800 });
      await preconnect(page.context(), server, 'ana');
      await open(page, `module=data&project=${projectId}&diagram=${diagramId}&theme=${theme}`);
      await showEditor(page);
      await expect(page.getByTestId('project-bar')).toHaveAttribute('data-live', 'live', { timeout: 15000 });
      await saveAs(server, 'beto', projectId, diagramId, 'Cambio de Beto');
      await expect(region(page)).toContainText('beto guardó una versión más nueva', { timeout: 8000 });
      await noHorizontalScroll(page);

      // el aviso y sus botones caben dentro de la pantalla
      const box = await page.getByTestId('newer-version').boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);

      // contraste de cada texto del aviso frente a su fondo efectivo (se compone con lo que haya detrás si es translúcido)
      const ratios = await page.evaluate(() => {
        const parse = (value: string): [number, number, number, number] => {
          const m = /rgba?\(([^)]+)\)/.exec(value);
          if (!m) return [0, 0, 0, 1];
          const parts = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
          return [parts[0], parts[1], parts[2], parts[3] ?? 1];
        };
        const background = (el: Element): [number, number, number] => {
          const layers: Array<[number, number, number, number]> = [];
          for (let node: Element | null = el; node; node = node.parentElement) {
            const color = parse(getComputedStyle(node).backgroundColor);
            if (color[3] > 0) layers.push(color);
            if (color[3] >= 1) break;
          }
          let [r, g, b] = getComputedStyle(document.documentElement).colorScheme.includes('dark') ? [0, 0, 0] : [255, 255, 255];
          for (const [lr, lg, lb, la] of layers.reverse()) [r, g, b] = [lr * la + r * (1 - la), lg * la + g * (1 - la), lb * la + b * (1 - la)];
          return [r, g, b];
        };
        const luminance = ([r, g, b]: number[]): number => {
          const lin = (c: number): number => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
          return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
        };
        const out: Record<string, number> = {};
        for (const id of ['newer-version-text', 'newer-version-load', 'newer-version-dismiss']) {
          const el = document.querySelector(`[data-testid="${id}"]`)!;
          const fg = parse(getComputedStyle(el).color);
          const bg = background(el);
          const l1 = luminance(fg.slice(0, 3));
          const l2 = luminance(bg);
          out[id] = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        }
        return out;
      });
      for (const [id, ratio] of Object.entries(ratios)) expect(ratio, `contraste de ${id}`).toBeGreaterThanOrEqual(4.5);

      // axe sobre la barra del proyecto, si el paquete está instalado (en CI lo está; la prueba general de accesibilidad lo exige)
      const specifier = '@axe-core/playwright';
      const axe = await import(/* @vite-ignore */ specifier).catch(() => undefined);
      if (axe) {
        const results = await new axe.default({ page }).include('[data-testid="project-bar"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
        expect(results.violations.map((v: { id: string; nodes: unknown[] }) => `${v.id} (${v.nodes.length})`)).toEqual([]);
      }

      // teclado: ningún botón del aviso es una trampa; Tab llega a los dos, en orden de lectura
      await page.getByTestId('newer-version-load').focus();
      await page.keyboard.press('Tab');
      await expect(page.getByTestId('newer-version-dismiss')).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(region(page)).toBeEmpty();
    });
  }

  test('editor C4: el aviso sale en el encabezado, con el canal en directo, y se carga', async ({ page, server }) => {
    await preconnect(page.context(), server, 'ana');
    await openEditor(page);
    await page.getByText('Archivo', { exact: true }).click();
    await page.getByText('Proyectos…').click();
    const dialog = page.getByTestId('projects-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByPlaceholder('Nombre del proyecto').fill('Banca');
    await dialog.getByRole('button', { name: 'Crear', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: 'Banca' })).toBeVisible();
    await dialog.getByRole('button', { name: /Guardar en «Banca»/ }).click();
    await expect(dialog).toHaveCount(0);
    await expect(saveStatus(page)).toHaveText('Guardado en «Banca» · servidor');
    await expect(saveStatus(page)).toHaveAttribute('data-live', 'live', { timeout: 15000 });
    await expect(region(page)).toHaveAttribute('role', 'status');
    await expect(region(page)).toBeEmpty();

    // Beto guarda una versión más nueva del mismo diagrama (con un elemento renombrado)
    const project = (await (await fetch(`${server.url}/api/projects/banca`, { headers: { Authorization: `Bearer ${server.tokens.beto}` } })).json()) as { diagrams: Array<{ id: string }> };
    const diagramId = project.diagrams[0].id;
    const current = (await (await fetch(`${server.url}/api/projects/banca/diagrams/${diagramId}`, { headers: { Authorization: `Bearer ${server.tokens.beto}` } })).json()) as { text: string };
    const doc = JSON.parse(current.text);
    const renamed = doc.model.elements.find((element: { kind?: string }) => element.kind === 'person') ?? doc.model.elements[0];
    renamed.name = 'Renombrada por Beto';
    await api(server, server.tokens.beto, 'PUT', `/api/projects/banca/diagrams/${diagramId}`, { text: JSON.stringify(doc) });

    await expect(region(page)).toContainText('beto guardó una versión más nueva de «', { timeout: 8000 });
    await page.getByTestId('newer-version-load').click();
    await expect(region(page)).toContainText('Se cargó la versión nueva', { timeout: 10000 });
    await expect(page.locator('.react-flow__node').filter({ hasText: 'Renombrada por Beto' })).toHaveCount(1, { timeout: 10000 });
  });
});
