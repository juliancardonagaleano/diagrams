import { test, expect } from '@playwright/test';
import { c4Ready } from './canvas-helpers';

test('protocolo embebido: handshake, export, setView, autosave, guardar y salir, origen no autorizado', async ({ page }) => {
  const hostErrors: string[] = [];
  page.on('pageerror', (e) => hostErrors.push(e.message));
  // Con iframes, `networkidle` a veces no se notifica aunque todo esté cargado y el `goto` agota el tiempo de la prueba: se espera por condiciones observables.
  await page.goto('/examples/embed-host.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('state')?.textContent === 'cargado', null, { timeout: 20000 });

  const frame = page.frames().find((f) => f.url().includes('embed=1'));
  expect(frame, 'el iframe se abrió con ?embed=1').toBeTruthy();
  await expect(frame!.locator('.react-flow__node')).toHaveCount(3);
  await c4Ready(frame!); // el documento llega sin coordenadas: el editor embebido lo coloca y lo encuadra
  await expect(frame!.getByRole('button', { name: 'Guardar y salir' })).toHaveCount(1);

  const xmlLen = await page.evaluate(async () => (await (window as any).embed.export('drawio')).length);
  expect(xmlLen).toBeGreaterThan(500);

  // SVG y PNG de la vista activa: el SVG lleva las figuras C4 (persona como actor) y el PNG es una imagen con píxeles.
  const svg = await page.evaluate(async () => (await (window as any).embed.export('svg')) as string);
  expect(svg.startsWith('<svg')).toBe(true);
  expect(svg).toContain('PERSONA');
  const png = await page.evaluate(async () => (await (window as any).embed.export('png')) as string);
  expect(png.startsWith('data:image/png;base64,')).toBe(true);
  expect(png.length).toBeGreaterThan(2000);

  // setView desde el anfitrión → evento viewChange.
  await page.evaluate(() => (window as any).embed.setView('cont'));
  await expect.poll(async () => (await page.locator('#log').textContent()) ?? '').toMatch(/viewChange.*"level":"C2"/);
  await c4Ready(frame!, 'cont');

  // Con `autosave` activo, un cambio llega al anfitrión como evento `autosave` (el editor agrupa los cambios y lo emite 500 ms después del
  // último): se espera al evento con el documento ya cambiado, no al tiempo. «Fusionar elemento» envía el modelo de partida más una cola
  // (6 → 7 elementos); una edición hecha en el editor añade otro (→ 8).
  await page.click('#btn-merge');
  await expect
    .poll(async () => (await page.locator('#log').textContent()) ?? '', { timeout: 15000 })
    .toMatch(/autosave\s+\{"elementos":7\}/);
  expect((await page.locator('#log').textContent()) ?? '', 'el fragmento de «Fusionar elemento» es válido: el editor no responde con un evento error').not.toMatch(/\berror\b/);

  await frame!.getByRole('button', { name: 'Añadir persona' }).click();
  await expect
    .poll(async () => (await page.locator('#log').textContent()) ?? '', { timeout: 15000 })
    .toMatch(/autosave\s+\{"elementos":8\}/);

  await frame!.getByRole('button', { name: 'Guardar y salir' }).click();
  await page.waitForFunction(() => document.getElementById('state')?.textContent === 'salió');
  const logAfter = (await page.locator('#log').textContent()) ?? '';
  expect(logAfter).toMatch(/save.*"exit":true/);
  expect(logAfter).toMatch(/exit/);

  // Mensaje desde un origen no permitido: se ignora.
  const ignored = await page.evaluate(() => {
    return new Promise<boolean>((resolve, reject) => {
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
      // Antes de enviar nada hay que saber que el editor del iframe intruso ya escucha mensajes; si no, el aviso se pierde y la
      // prueba pasaría sin comprobar nada. Se espera a que ponga `theme-mode` en el <body> (App.tsx): ese efecto está declarado
      // después del que registra la escucha del puente embebido, así que cuando existe la escucha ya está registrada.
      const started = Date.now();
      const whenListening = () => {
        if (rogue.contentDocument?.body?.hasAttribute('theme-mode')) {
          rogue.contentWindow!.postMessage(JSON.stringify({ action: 'setView', viewId: 'ctx' }), '*');
          // Margen de ausencia: que algo NO llegue solo se puede acotar dejando pasar un tiempo, no hay condición que esperar.
          setTimeout(() => {
            window.removeEventListener('message', l);
            resolve(!got);
          }, 800);
        } else if (Date.now() - started > 20000) {
          reject(new Error('el iframe con origen no autorizado no llegó a arrancar'));
        } else {
          setTimeout(whenListening, 25);
        }
      };
      whenListening();
    });
  });
  expect(ignored, 'la app ignora acciones de un origen no autorizado (no responde con error ni eventos)').toBe(true);

  expect(hostErrors, `sin errores de página en el anfitrión (${hostErrors.join(' | ').slice(0, 200)})`).toHaveLength(0);
});

test('un mensaje del anfitrión con JSON roto produce un evento de error, no un silencio', async ({ page }) => {
  // Con iframes, `networkidle` a veces no se notifica aunque todo esté cargado y el `goto` agota el tiempo de la prueba: se espera por condiciones observables.
  await page.goto('/examples/embed-host.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('state')?.textContent === 'cargado', null, { timeout: 20000 });

  await page.evaluate(() => {
    const iframe = document.querySelector('iframe')!;
    // JSON con la forma que espera el protocolo (empieza por "{") pero sintácticamente inválido:
    // antes del fix se descartaba en silencio porque el anfitrión envía JSON como string.
    iframe.contentWindow!.postMessage('{"action": "export", "format":', '*');
  });
  await expect.poll(async () => (await page.locator('#log').textContent()) ?? '').toMatch(/error/);
});

test.describe('editor C4 incrustado a mano, sin ?origin=', () => {
  test('usa el origen del padre que da el navegador: emite `init` a ese origen y responde a sus órdenes', async ({ page }) => {
    await page.goto('/examples/embed-host.html', { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(
      () =>
        new Promise<{ initOrigin: string; exported: string }>((resolve, reject) => {
          const iframe = document.createElement('iframe');
          // Sin `origin`: el SDK lo añade siempre, quien incrusta a mano puede olvidarlo.
          iframe.src = '/?embed=1&proto=json';
          document.body.appendChild(iframe);
          let initOrigin = '';
          const timer = setTimeout(() => reject(new Error('el editor sin ?origin= no emitió init/export')), 20000);
          window.addEventListener('message', (e) => {
            if (e.source !== iframe.contentWindow || typeof e.data !== 'string') return;
            const msg = JSON.parse(e.data) as { event: string; data?: string };
            if (msg.event === 'init') {
              initOrigin = e.origin;
              iframe.contentWindow!.postMessage(JSON.stringify({ action: 'export', format: 'json', requestId: 'r1' }), location.origin);
            } else if (msg.event === 'export') {
              clearTimeout(timer);
              resolve({ initOrigin, exported: msg.data ?? '' });
            }
          });
        }),
    );
    expect(result.initOrigin).toBe(new URL(page.url()).origin);
    expect(JSON.parse(result.exported).workspace).toBeTruthy();
  });

  test('negocia la versión del protocolo: el init la lleva y un load de otra versión mayor recibe un error incompatible-protocol', async ({ page }) => {
    await page.goto('/examples/embed-host.html', { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(
      () =>
        new Promise<{ initVersion: string; error: { code?: string; message: string } }>((resolve, reject) => {
          const iframe = document.createElement('iframe');
          iframe.src = '/?embed=1&proto=json';
          document.body.appendChild(iframe);
          let initVersion = '';
          const timer = setTimeout(() => reject(new Error('el editor no respondió al load de otra versión del protocolo')), 20000);
          window.addEventListener('message', (e) => {
            if (e.source !== iframe.contentWindow || typeof e.data !== 'string') return;
            const msg = JSON.parse(e.data) as { event: string; version?: string; code?: string; message: string };
            if (msg.event === 'init') {
              initVersion = msg.version ?? '';
              iframe.contentWindow!.postMessage(JSON.stringify({ action: 'load', version: '2.0' }), location.origin);
            } else if (msg.event === 'error') {
              clearTimeout(timer);
              resolve({ initVersion, error: { code: msg.code, message: msg.message } });
            }
          });
        }),
    );
    expect(result.initVersion).toMatch(/^\d+\.\d+$/);
    expect(result.error.code).toBe('incompatible-protocol');
    expect(result.error.message).toMatch(/incompatible.*2\.0/s);
  });

  // El caso «sin origen fiable» (padre de origen opaco: iframe con sandbox, about:blank) no se pudo probar aquí: con un padre así el
  // Chromium de la prueba no llega a cargar el iframe de localhost (queda en chrome-error://) y, con sandbox, el editor hereda además el
  // origen opaco. Lo cubren las pruebas de useEmbedBridge.origin.test.tsx con las fuentes del navegador simuladas.
});
