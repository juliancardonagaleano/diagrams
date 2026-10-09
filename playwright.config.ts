import { defineConfig } from '@playwright/test';

/**
 * Pruebas de extremo a extremo. Requiere `npm run build:app` previo; sirve `dist/app` con `vite preview`.
 *
 * Navegador (por orden de prioridad):
 *  1. `CHROMIUM_PATH`, si se indica.
 *  2. En CI (`CI` definido, como en GitHub Actions): el Chromium que gestiona Playwright
 *     (`npx playwright install --with-deps chromium`), el que corresponde a la versión de `@playwright/test`.
 *  3. En local: el Chromium preinstalado del entorno (`/opt/pw-browsers/chromium`), en vez de descargar uno propio.
 *
 * El puerto es configurable con `E2E_PORT` (por defecto 4173), para que varios
 * checkouts o worktrees corran e2e a la vez. Ojo: `reuseExistingServer` reutiliza
 * lo que ya escuche en ese puerto, así que dos checkouts con el MISMO puerto
 * probarían el build (`dist/app`) del primero que arrancó, no el propio. Usa un
 * `E2E_PORT` distinto por checkout, o cierra el servidor ajeno antes de correr.
 */
const PORT = Number(process.env.E2E_PORT ?? 4173);

const executablePath = process.env.CHROMIUM_PATH ?? (process.env.CI ? undefined : '/opt/pw-browsers/chromium');

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // En CI, además del listado, un informe HTML (playwright-report/) que el workflow sube como artefacto si algo falla.
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    // La interfaz sigue el idioma del navegador (`src/i18n`) y Playwright se presenta por omisión como `en-US`: las pruebas buscan los textos en español.
    // Las que prueban el inglés lo piden con `?lang=en` o con `test.use({ locale: 'en-US' })`.
    locale: 'es-ES',
    acceptDownloads: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      args: ['--no-sandbox'],
    },
  },
  webServer: {
    command: `node node_modules/vite/bin/vite.js preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
