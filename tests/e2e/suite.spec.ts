import { expect, test } from '@playwright/test';

test.describe('shell de la suite (federación por manifiesto)', () => {
  test('descubre los módulos del manifiesto, monta el que se elige y muestra sus capacidades', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // Con iframes, `networkidle` a veces no se notifica aunque todo esté cargado y el `goto` agota el tiempo de la prueba: se espera por condiciones observables.
    await page.goto('/suite.html', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('status')).toContainText('6 módulos');
    const nav = page.getByRole('navigation', { name: 'Módulos' });
    await expect(nav.getByRole('button')).toHaveCount(6);
    await expect(nav.getByRole('button', { name: /Arquitectura de seguridad/ })).toBeVisible();

    // abre el primer módulo que no es C4 y el banco de trabajo se incrusta con el protocolo de módulos
    const frameFor = (fragment: string) => page.frames().find((f) => f.url().includes(fragment));
    await expect.poll(() => frameFor('module=integration')?.url()).toContain('embed=1');
    await expect(page.locator('#info')).toContainText('Arquitectura de integraciones');
    await expect(page.locator('#info')).toContainText('Informes'); // llega con el handshake capabilities
    await expect(page.locator('#log')).toContainText('init');

    await nav.getByRole('button', { name: /Arquitectura de seguridad/ }).click();
    await expect.poll(() => frameFor('module=security')?.url()).toBeTruthy();
    await expect(page.locator('#info')).toContainText('Conversiones');
    await expect(page.locator('#info')).toContainText('from-integration');
    expect(await page.locator('iframe').count()).toBe(1);

    // C4 habla su propio protocolo: se monta el editor, sin parámetro de módulo
    await nav.getByRole('button', { name: /Arquitectura de soluciones \(C4\)/ }).click();
    await expect.poll(() => page.frames().some((f) => f.url().includes('embed=1') && !f.url().includes('module='))).toBe(true);
    const c4 = page.frames().find((f) => f.url().includes('embed=1') && !f.url().includes('module='))!;
    await c4.waitForSelector('.react-flow', { timeout: 20000 });
    expect(errors).toEqual([]);
  });

  test('una instancia distinta: solo aparece lo que su manifiesto declara', async ({ page }) => {
    await page.route('**/otra/.well-known/iark.json', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          schema: 'iark.manifest/1',
          name: 'Instancia de datos',
          version: '9.9.9',
          modules: [{ id: 'data', name: 'Solo datos', version: '1.0.0', documentVersion: '1.0', importFormats: ['mermaid'], exportFormats: ['svg'], endpoints: { embed: '../../modulos.html?module=data' } }],
        }),
      }),
    );
    await page.goto('/suite.html?manifest=' + encodeURIComponent('/otra/.well-known/iark.json'), { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('status')).toContainText('Instancia de datos v9.9.9 · 1 módulos');
    await expect(page.getByRole('navigation', { name: 'Módulos' }).getByRole('button')).toHaveCount(1);
    await expect.poll(() => page.frames().some((f) => f.url().includes('module=data'))).toBe(true);
  });

  test('un manifiesto de OTRO origen recibido por enlace no se conecta solo: pide confirmar con «Conectar»', async ({ page, baseURL }) => {
    const asked: string[] = [];
    // Otra instancia (otro origen): el navegador no sale a la red, la prueba responde por ella. Cada petición que le llegue queda anotada.
    await page.route('https://otra.example/**', (route) => {
      asked.push(route.request().url());
      return route.fulfill({
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({
          schema: 'iark.manifest/1',
          name: 'Instancia ajena',
          version: '3.1.4',
          modules: [{ id: 'data', name: 'Datos ajenos', version: '1.0.0', documentVersion: '1.0', importFormats: [], exportFormats: ['svg'], endpoints: { embed: `${baseURL}/modulos.html?module=data` } }],
        }),
      });
    });
    await page.goto('/suite.html?manifest=' + encodeURIComponent('https://otra.example/.well-known/iark.json'), { waitUntil: 'domcontentloaded' });

    // El campo queda relleno, hay un aviso que nombra el origen y no se ha contactado con la instancia ni montado nada
    await expect(page.getByLabel('Manifiesto de la instancia')).toHaveValue('https://otra.example/.well-known/iark.json');
    await expect(page.getByRole('alert')).toContainText('https://otra.example');
    await expect(page.getByRole('alert')).toContainText('Conectar');
    await expect(page.getByRole('status')).toContainText('pendiente de confirmar');
    await expect(page.getByRole('navigation', { name: 'Módulos' }).getByRole('button')).toHaveCount(0);
    await expect(page.locator('iframe')).toHaveCount(0);
    await page.waitForTimeout(500); // que algo NO ocurra solo se puede acotar dejando pasar un tiempo
    expect(asked, 'no se pidió el manifiesto ajeno antes de confirmar').toEqual([]);

    await page.getByRole('button', { name: 'Conectar' }).click();
    await expect(page.getByRole('status')).toContainText('Instancia ajena v3.1.4 · 1 módulos');
    await expect(page.getByRole('alert')).toHaveCount(0); // el aviso se retira al conectar
    expect(asked).toEqual(['https://otra.example/.well-known/iark.json']);
    await expect.poll(() => page.frames().some((f) => f.url().includes('module=data') && f.url().includes('embed=1'))).toBe(true);
  });

  test('el manifiesto por omisión y los del mismo origen siguen conectándose solos', async ({ page }) => {
    await page.route('**/hermana/.well-known/iark.json', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ schema: 'iark.manifest/1', name: 'Instancia hermana', version: '1.0.0', modules: [] }),
      }),
    );
    await page.goto('/suite.html?manifest=' + encodeURIComponent('/hermana/.well-known/iark.json'), { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('status')).toContainText('Instancia hermana v1.0.0 · 0 módulos');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('un manifiesto con un endpoint javascript: o data: se rechaza y no ejecuta nada', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    for (const [carpeta, embed] of [
      ['js', 'javascript:window.top.__hackeado=true'],
      ['datos', 'data:text/html,<script>window.top.__hackeado=true</script>'],
    ]) {
      await page.route(`**/${carpeta}/.well-known/iark.json`, (route) =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            schema: 'iark.manifest/1',
            name: 'Hostil',
            version: '1.0.0',
            modules: [{ id: 'data', name: 'Datos', version: '1.0.0', documentVersion: '1.0', importFormats: [], exportFormats: [], endpoints: { embed } }],
          }),
        }),
      );
      await page.goto(`/suite.html?manifest=${encodeURIComponent(`/${carpeta}/.well-known/iark.json`)}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('alert')).toContainText('solo se admiten URL http: y https:');
      await expect(page.getByRole('status')).toContainText('sin conexión');
      await expect(page.locator('iframe')).toHaveCount(0);
      await expect(page.getByRole('navigation', { name: 'Módulos' }).getByRole('button')).toHaveCount(0);
      expect(await page.evaluate(() => (window as unknown as { __hackeado?: boolean }).__hackeado)).toBeUndefined();
    }
    expect(errors).toEqual([]);
  });

  test('un manifiesto que no existe o no es válido se explica sin romper la página', async ({ page }) => {
    await page.goto('/suite.html?manifest=' + encodeURIComponent('/no-existe.json'), { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('alert')).toContainText('respondió 404');
    await page.route('**/roto.json', (route) => route.fulfill({ contentType: 'application/json', body: '{"schema":"otro"}' }));
    await page.getByLabel('Manifiesto de la instancia').fill('/roto.json');
    await page.getByRole('button', { name: 'Conectar' }).click();
    await expect(page.getByRole('alert')).toContainText('no es un iark.manifest/1 válido');
    await expect(page.getByRole('status')).toContainText('sin conexión');
  });

  test('un módulo remoto que exige un contractVersion mayor se aparta con un aviso y los demás siguen disponibles', async ({ page }) => {
    await page.route('**/futuro/.well-known/iark.json', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          schema: 'iark.manifest/1',
          name: 'Instancia del futuro',
          version: '9.0.0',
          protocol: '1.7', // una diferencia de menor se acepta
          modules: [
            { id: 'data', name: 'Datos', version: '1.0.0', contractVersion: 1, documentVersion: '1.0', importFormats: [], exportFormats: [], endpoints: { embed: '../../modulos.html?module=data' } },
            { id: 'security', name: 'Seguridad nueva', version: '2.0.0', contractVersion: 99, documentVersion: '2.0', importFormats: [], exportFormats: [], endpoints: { embed: '../../modulos.html?module=security' } },
          ],
        }),
      }),
    );
    await page.goto('/suite.html?manifest=' + encodeURIComponent('/futuro/.well-known/iark.json'), { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('status')).toContainText('Instancia del futuro v9.0.0 · 1 módulos (1 no compatible)');
    await expect(page.getByRole('alert')).toContainText('«security» exige la versión 99 del contrato de módulos');
    await expect(page.getByRole('navigation', { name: 'Módulos' }).getByRole('button')).toHaveCount(1);
    await expect.poll(() => page.frames().some((f) => f.url().includes('module=data') && f.url().includes('embed=1'))).toBe(true);
    expect(page.frames().some((f) => f.url().includes('module=security'))).toBe(false);
  });

  test('un manifiesto de un esquema o de un protocolo de versión mayor se rechaza entero con un mensaje claro', async ({ page }) => {
    for (const [carpeta, cambio, mensaje] of [
      ['esquema2', { schema: 'iark.manifest/2' }, 'versión más nueva del formato'],
      ['protocolo2', { protocol: '2.0' }, 'habla el protocolo embebido 2.0'],
    ] as const) {
      await page.route(`**/${carpeta}/.well-known/iark.json`, (route) =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ schema: 'iark.manifest/1', name: 'Instancia nueva', version: '2.0.0', modules: [], ...cambio }),
        }),
      );
      await page.goto('/suite.html?manifest=' + encodeURIComponent(`/${carpeta}/.well-known/iark.json`), { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('alert')).toContainText(mensaje);
      await expect(page.getByRole('status')).toContainText('sin conexión');
      await expect(page.locator('iframe')).toHaveCount(0);
    }
  });

  test('el sitio publica el manifiesto y los JSON Schema anunciados', async ({ request }) => {
    const manifest = await (await request.get('/.well-known/iark.json')).json();
    expect(manifest.schema).toBe('iark.manifest/1');
    for (const m of manifest.modules) {
      const schema = await request.get(`/${m.endpoints.schema.replace('../', '')}`);
      expect(schema.ok(), m.endpoints.schema).toBe(true);
      expect((await schema.json()).$id).toContain(`${m.id}-document.schema.json`);
    }
  });
});

test.describe('Web Component <iark-module>', () => {
  test('dos widgets sin JavaScript de integración: URL directa con documento por propiedad, y descubierto por manifiesto', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // Con iframes, `networkidle` a veces no se notifica aunque todo esté cargado y el `goto` agota el tiempo de la prueba: se espera por condiciones observables.
    await page.goto('/examples/web-component-host.html', { waitUntil: 'domcontentloaded' });
    const frameOf = (module: string) => page.frames().find((f) => f.url().includes('embed=1') && f.url().includes(`module=${module}`));
    await expect.poll(() => frameOf('security')?.url(), { timeout: 20000 }).toBeTruthy();
    await expect.poll(() => frameOf('data')?.url(), { timeout: 20000 }).toBeTruthy();

    // widget 1: el documento asignado a la propiedad llegó al banco de trabajo del iframe
    const security = frameOf('security')!;
    await expect(security.getByLabel('Documento JSON')).toHaveValue(/Fuerza bruta contra la API/, { timeout: 20000 });
    await expect(security.getByTestId('module-canvas')).toBeVisible({ timeout: 20000 });
    await expect(security.getByRole('tab', { name: 'Integración' })).toHaveCount(0); // ui="min"
    await expect(page.locator('#log')).toContainText('w1 iark-load');

    // widget 2: el editor se descubrió en el manifiesto; abre en blanco y carga su ejemplo
    const data = frameOf('data')!;
    await data.getByRole('button', { name: 'Cargar ejemplo' }).click();
    await expect(data.getByTestId('editor-status')).toContainText('Válido');
    await expect(page.locator('#log')).toContainText('w2 iark-init');

    // métodos del elemento y atributos reactivos
    await page.click('#btn-risks');
    await expect(page.locator('#log')).toContainText('informe risks');
    await page.click('#btn-view');
    await security.getByRole('tab', { name: 'Vista SVG' }).click();
    await expect(security.locator('[data-testid="diagram-stage"] img')).toHaveAttribute('data-view', 'threats');
    await page.click('#btn-theme');
    await expect.poll(() => security.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    expect(errors).toEqual([]);
  });
});
