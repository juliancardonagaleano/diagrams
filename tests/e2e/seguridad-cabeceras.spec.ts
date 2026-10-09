import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { c4Ready, canvasReady } from './canvas-helpers';

/**
 * Las cabeceras de seguridad de `iark serve` (CSP, frame-ancestors…) con un navegador de verdad. Los demás e2e corren sobre
 * `vite preview`, que no las envía: aquí se arranca el CLI real sobre el sitio compilado (`dist/app`, `npm run build:app`) y se
 * comprueba que la política es **efectiva** (bloquea lo que debe) y **no rompe nada** (ninguna violación ni error de consola en las
 * páginas, el editor C4, el banco, la vista previa de Mermaid, el autolayout de ELK, las cargas embebidas y la federación).
 *
 * Tres instancias, cada una en su puerto libre y con un origen distinto: A (`127.0.0.1`, por omisión) es la anfitriona; B y C se
 * nombran `localhost` para ser otro origen. B autoriza a A a incrustarla (`--frame-ancestors`) y a llamar a su API (`--cors`); C
 * solo autoriza a un tercero.
 */
interface Instance {
  url: string;
  stop(): Promise<void>;
}

async function serve(args: string[]): Promise<Instance & { port: number }> {
  const child: ChildProcess = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/cli/index.ts', 'serve', '--static', 'dist/app', '--port', '0', ...args], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`El servidor no arrancó en 30 s:\n${output}`)), 30_000);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const found = /escuchando en http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (found) {
        clearTimeout(timer);
        resolve(Number(found[1]));
      }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`El servidor terminó (código ${code}) antes de escuchar:\n${output}`));
    });
  });
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    async stop() {
      if (child.exitCode === null) {
        await new Promise<void>((resolve) => {
          child.once('exit', () => resolve());
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 5000).unref();
        });
      }
    },
  };
}

let A: Instance & { port: number };
let B: Instance & { port: number };
let C: Instance & { port: number };
/** Cómo se llega a B y a C desde el navegador: `localhost` es otro origen que `127.0.0.1`. */
const origin = (instance: { port: number }): string => `http://localhost:${instance.port}`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  A = await serve([]);
  B = await serve(['--frame-ancestors', A.url, '--cors', A.url]);
  C = await serve(['--frame-ancestors', 'https://otro.example']);
});
test.afterAll(async () => {
  await Promise.all([A?.stop(), B?.stop(), C?.stop()]);
});

/** Registra violaciones de la CSP y errores de consola/página de la página y de todos sus marcos. */
function watch(page: Page): { violations(): Promise<string[]>; problems: string[] } {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // Chromium cuenta como error de consola la carga de un recurso que falla (p. ej. /favicon.ico, que el sitio no publica): no es de la CSP.
    if (m.type() === 'error' && !/favicon|Failed to load resource: the server responded with a status of 404/.test(m.text())) problems.push(`console.error: ${m.text()}`);
  });
  void page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ← ${e.blockedURI || e.sample} (${e.sourceFile}:${e.lineNumber}:${e.columnNumber}) ${e.sample}`));
  });
  return {
    problems,
    async violations() {
      const all: string[] = [];
      for (const frame of page.frames()) all.push(...((await frame.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []).catch(() => [])) as string[]));
      return all;
    },
  };
}

test.describe('las páginas con la CSP puesta', () => {
  test('las respuestas HTML llevan la CSP y las demás no', async ({ request }) => {
    const page = await request.get(`${A.url}/modulos.html?module=data`);
    expect(page.headers()['content-security-policy']).toContain("script-src 'self'");
    expect(page.headers()['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(page.headers()['referrer-policy']).toBe('no-referrer');
    const embed = await request.get(`${A.url}/modulos.html?embed=1&module=data`);
    expect(embed.headers()['content-security-policy']).toContain('frame-ancestors *');
    expect((await request.get(`${A.url}/api/modules`)).headers()['content-security-policy']).toBeUndefined();
    // El HTML que compila Vite no trae scripts en línea: por eso `script-src 'self'` basta, sin hashes ni 'unsafe-inline'.
    for (const path of ['/', '/modulos.html', '/suite.html', '/trazabilidad.html']) expect(await (await request.get(`${A.url}${path}`)).text(), path).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
  });

  test('la política es efectiva: un script en línea no se ejecuta y queda anotada su violación', async ({ page }) => {
    const w = watch(page);
    await page.goto(`${A.url}/trazabilidad.html`, { waitUntil: 'domcontentloaded' });
    // (Un `eval` no sirve de prueba: lo que se evalúa por el protocolo de Playwright no pasa por la CSP de la página.)
    const ran = await page.evaluate(() => {
      const script = document.createElement('script');
      script.textContent = 'window.__enLinea = true';
      document.head.append(script);
      return (window as unknown as { __enLinea?: boolean }).__enLinea === true;
    });
    expect(ran).toBe(false);
    await expect.poll(async () => (await w.violations()).some((v) => v.startsWith('script-src'))).toBe(true);
  });

  test('editor C4: dibuja, edita, autolayout de ELK y vista previa de Mermaid, sin violaciones', async ({ page }) => {
    const w = watch(page);
    await page.goto(`${A.url}/`, { waitUntil: 'domcontentloaded' });
    await c4Ready(page);
    await expect(page.locator('.react-flow__node')).toHaveCount(4);
    await page.getByRole('button', { name: 'Añadir persona' }).click();
    await expect(page.locator('.react-flow__node')).toHaveCount(5);
    await page.getByRole('button', { name: 'Autolayout', exact: true }).click();
    await c4Ready(page);
    expect((await page.getByTestId('layout-quality').textContent()) ?? '').toMatch(/0 cruces/);
    // Exportar `.drawio`: la descarga se hace con un enlace `blob:`.
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exportar .drawio' }).click()]);
    expect(download.suggestedFilename()).toMatch(/\.drawio$/);

    await page.getByText('Archivo', { exact: true }).click();
    await page.getByText('Vista previa de Mermaid…', { exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Vista previa de Mermaid' });
    const preview = dialog.getByRole('img', { name: 'Vista previa de Mermaid (C4 nativo)' });
    await expect(preview).toBeVisible({ timeout: 20000 });
    await expect.poll(() => preview.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0))).toBeGreaterThan(0);

    expect(await w.violations(), 'sin violaciones de la CSP').toEqual([]);
    expect(w.problems, 'sin errores de consola ni de página').toEqual([]);
  });

  test('banco de módulos: lienzo, autolayout y vista previa de Mermaid, sin violaciones', async ({ page }) => {
    const w = watch(page);
    await page.goto(`${A.url}/modulos.html?module=platform`, { waitUntil: 'domcontentloaded' });
    await canvasReady(page);
    await page.getByRole('tab', { name: 'Exportar' }).click();
    await page.locator('[data-format="mermaid"]').getByRole('button', { name: 'Ver' }).click();
    const drawing = page.getByRole('img', { name: /Vista previa de Mermaid/ });
    await expect(drawing).toBeVisible({ timeout: 20000 });
    await expect.poll(() => drawing.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0))).toBeGreaterThan(0);
    await page.goto(`${A.url}/modulos.html?module=data`, { waitUntil: 'domcontentloaded' });
    await canvasReady(page);
    expect(await w.violations()).toEqual([]);
    expect(w.problems).toEqual([]);
  });

  test('el autolayout corre en un hilo de trabajo con la CSP puesta (worker-src cae en script-src «self»), sin violaciones y sin caer al hilo principal', async ({ page }) => {
    const w = watch(page);
    const workers: string[] = [];
    const downloads: string[] = [];
    page.on('worker', (worker) => workers.push(worker.url()));
    page.on('response', (response) => downloads.push(response.url()));
    await page.goto(`${A.url}/modulos.html?module=platform`, { waitUntil: 'domcontentloaded' });
    await canvasReady(page);
    await expect.poll(() => workers.some((url) => /\/assets\/elkWorker-[^/]+\.js$/.test(url))).toBe(true);
    // Si la política hubiera bloqueado el hilo, el cálculo habría pasado a la salida de emergencia, que se descarga aparte.
    expect(downloads.filter((url) => /elk-hilo-principal/.test(url))).toEqual([]);
    expect(await w.violations(), 'sin violaciones de la CSP').toEqual([]);
    expect(w.problems, 'sin errores de consola ni de página').toEqual([]);
  });

  test('suite y trazabilidad: el shell descubre los módulos, monta un banco y el editor C4 embebidos', async ({ page }) => {
    const w = watch(page);
    await page.goto(`${A.url}/suite.html`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('status')).toContainText('6 módulos');
    await expect(page.locator('#info')).toContainText('Informes'); // el handshake `capabilities` llegó desde el iframe
    await page.getByRole('navigation', { name: 'Módulos' }).getByRole('button', { name: /Arquitectura de soluciones \(C4\)/ }).click();
    const c4 = () => page.frames().find((f) => f.url().includes('embed=1') && !f.url().includes('module='));
    await expect.poll(c4).toBeTruthy();
    await c4Ready(c4()!);

    await page.goto(`${A.url}/trazabilidad.html`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).not.toBeEmpty();
    expect(await w.violations()).toEqual([]);
    expect(w.problems).toEqual([]);
  });

  test('cargas embebidas con el SDK: editor C4, banco de módulos y Web Component', async ({ page }) => {
    const w = watch(page);
    await page.goto(`${A.url}/examples/embed-host.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('state')?.textContent === 'cargado', null, { timeout: 20000 });
    const editor = page.frames().find((f) => f.url().includes('embed=1'))!;
    await expect(editor.locator('.react-flow__node')).toHaveCount(3);
    await c4Ready(editor);
    expect(await page.evaluate(async () => ((await (window as any).embed.export('svg')) as string).startsWith('<svg'))).toBe(true);
    // El PNG: el SVG se dibuja en un <img> blob: y se rasteriza en un lienzo.
    expect(await page.evaluate(async () => ((await (window as any).embed.export('png')) as string).startsWith('data:image/png'))).toBe(true);

    await page.goto(`${A.url}/examples/modules-host.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('state')?.textContent === 'cargado', null, { timeout: 30000 });
    const bench = page.frames().find((f) => f.url().includes('module=security'))!;
    await expect(bench.getByTestId('module-canvas')).toBeVisible({ timeout: 20000 });

    await page.goto(`${A.url}/examples/web-component-host.html`, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => page.frames().some((f) => f.url().includes('module=security') && f.url().includes('embed=1')), { timeout: 20000 }).toBe(true);
    await expect.poll(() => page.frames().some((f) => f.url().includes('module=data') && f.url().includes('embed=1')), { timeout: 20000 }).toBe(true);
    await expect(page.locator('#log')).toContainText('w1 iark-load', { timeout: 20000 });

    expect(await w.violations(), 'sin violaciones de la CSP').toEqual([]);
    expect(w.problems, 'sin errores de consola ni de página').toEqual([]);
  });
});

test.describe('frame-ancestors', () => {
  /**
   * Inserta un iframe en la página y dice si el navegador se negó a mostrarlo. Cuando `frame-ancestors` lo veta, Chromium deja el
   * marco en una página de error (`chrome-error://…`) o sin URL, según la versión, y anota «Refused to frame …» en la consola; esa
   * anotación no llega en todas las versiones (en el Chromium que instala el CI no llegaba, y la espera caducaba). Por eso el veto
   * se decide por cualquiera de las dos señales: la anotación, o que el iframe terminó de cargar (`load` se dispara también con la
   * página de error) y su marco NO está en la URL pedida. Un marco mostrado es el que llega a la URL pedida.
   */
  async function frameInto(page: Page, src: string): Promise<{ url: string; refused: boolean }> {
    let refusal = '';
    const onConsole = (message: ConsoleMessage): void => {
      if (/Refused to frame/.test(message.text())) refusal = message.text();
    };
    page.on('console', onConsole);
    try {
      const iframe = await page.evaluateHandle((target) => {
        const element = document.createElement('iframe');
        element.addEventListener('load', () => (element.dataset.loaded = 'true'));
        element.src = target;
        element.dataset.probe = 'true';
        document.body.append(element);
        return element;
      }, src);
      const probe = iframe.asElement()!;
      /** `null` mientras el navegador no ha decidido; si no, lo que quedó dentro del iframe. */
      const verdict = async (): Promise<{ url: string; refused: boolean } | null> => {
        const url = (await probe.contentFrame())?.url() ?? '';
        if (refusal !== '') return { url: '', refused: true };
        if (url === src) return { url, refused: false };
        const loaded = await probe.evaluate((element) => (element as HTMLIFrameElement).dataset.loaded === 'true');
        return loaded ? { url: '', refused: true } : null;
      };
      await expect.poll(async () => (await verdict()) !== null, { timeout: 20000 }).toBe(true);
      return (await verdict())!;
    } finally {
      page.off('console', onConsole);
    }
  }

  test('una carga embebida se puede incrustar desde otro origen si la lista lo permite, y no si no', async ({ page }) => {
    const w = watch(page);
    await page.goto(`${A.url}/trazabilidad.html`, { waitUntil: 'domcontentloaded' });
    const allowed = await frameInto(page, `${origin(B)}/modulos.html?embed=1&module=data&origin=${encodeURIComponent(A.url)}`);
    expect(allowed.refused, 'B autoriza a A: se muestra').toBe(false);
    const probe = page.frames().find((f) => f.url().startsWith(`${origin(B)}/modulos.html`))!;
    // Sin documento cargado el banco muestra el aviso de «documento no válido»: basta ver que arrancó (la pestaña del módulo).
    await expect(probe.getByRole('tab', { name: 'Datos', selected: true })).toBeVisible({ timeout: 20000 });
    expect(await w.violations(), 'sin violaciones de la CSP').toEqual([]);

    const denied = await frameInto(page, `${origin(C)}/modulos.html?embed=1&module=data&origin=${encodeURIComponent(A.url)}`);
    expect(denied.refused, 'C solo autoriza a otro.example: el navegador se niega a mostrarla').toBe(true);
  });

  test('una página normal (sin ?embed=1) no se puede incrustar desde otro origen aunque la instancia sea de las que autorizan a A', async ({ page }) => {
    await page.goto(`${A.url}/trazabilidad.html`, { waitUntil: 'domcontentloaded' });
    const refused = await frameInto(page, `${origin(B)}/suite.html`);
    expect(refused.refused).toBe(true);
    // Ni añadiendo ?embed=1: solo el editor y el banco tienen modo embebido, y de lo contrario un enlace bastaría para enmarcar cualquier página.
    const withEmbed = await frameInto(page, `${origin(B)}/suite.html?embed=1`);
    expect(withEmbed.refused).toBe(true);
  });

  test('el banco incrustado desde otro origen sigue pudiendo incrustar el editor C4: los ancestros se comprueban todos, y el propio origen va siempre en la lista', async ({ page }) => {
    const w = watch(page);
    await page.goto(`${A.url}/trazabilidad.html`, { waitUntil: 'domcontentloaded' });
    // El banco abre C4 en su propio lienzo, sin iframe. Un anfitrión que quiera el editor clásico lo anida dentro del banco, así que la
    // cadena de ancestros sigue siendo editor (B) → banco (B) → página anfitriona (A): `--frame-ancestors` de B solo nombra a A; B entra por `'self'`.
    const bench = await frameInto(page, `${origin(B)}/modulos.html?embed=1&module=c4&origin=${encodeURIComponent(A.url)}`);
    expect(bench.refused).toBe(false);
    const benchFrame = page.frames().find((f) => f.url().startsWith(`${origin(B)}/modulos.html`))!;
    // Embebido y sin documento cargado, el banco avisa de que no hay documento válido: basta ver que arrancó (la pestaña del módulo).
    await expect(benchFrame.getByRole('tab', { name: 'C4', selected: true })).toBeVisible({ timeout: 20000 });
    expect(await benchFrame.locator('iframe').count(), 'C4 ya no se incrusta en el banco').toBe(0);
    await benchFrame.evaluate((src) => {
      const element = document.createElement('iframe');
      element.src = src;
      element.dataset.testid = 'editor-anidado';
      element.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;background:#fff';
      document.body.append(element);
    }, `${origin(B)}/?embed=1&proto=json&origin=${encodeURIComponent(origin(B))}&ui=min`);
    const nested = () => page.frames().find((f) => f.parentFrame() !== null && f.parentFrame() !== page.mainFrame() && f.url().startsWith(`${origin(B)}/?embed=1`));
    await expect.poll(nested, { timeout: 20000 }).toBeTruthy();
    await c4Ready(nested()!); // el editor C4 anidado (el marco es pequeño: se comprueba que el lienzo está colocado, no que se vea entero)
    expect(await w.violations()).toEqual([]);
  });
});

test.describe('federación con la CSP puesta', () => {
  test('el shell de A se conecta al manifiesto de B (otro origen): connect-src y frame-src lo permiten', async ({ page }) => {
    const w = watch(page);
    await page.goto(`${A.url}/suite.html?manifest=${encodeURIComponent(`${origin(B)}/.well-known/iark.json`)}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('status')).toContainText('pendiente de confirmar'); // otro origen: no se conecta solo
    await page.getByRole('button', { name: 'Conectar' }).click();
    await expect(page.getByRole('status')).toContainText('6 módulos', { timeout: 20000 });
    await expect.poll(() => page.frames().some((f) => f.url().startsWith(`${origin(B)}/modulos.html`) && f.url().includes('embed=1')), { timeout: 20000 }).toBe(true);
    await expect(page.locator('#info')).toContainText('Informes', { timeout: 20000 }); // el handshake entre A y el iframe de B funciona
    expect(await w.violations(), 'sin violaciones de la CSP').toEqual([]);
    expect(w.problems).toEqual([]);
  });
});
