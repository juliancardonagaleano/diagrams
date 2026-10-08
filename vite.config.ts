import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

/**
 * Ruta base pública. En GitHub Pages la app se sirve bajo `/<repositorio>/`, así que
 * `npm run deploy:pages` fija `BASE_PATH=/<repositorio>/` (p. ej. `/iark-diagrams/`); en local y en hostings
 * que sirven en la raíz (Cloudflare Pages, Netlify, Vercel) se deja `/`.
 */
const base = process.env.BASE_PATH ?? '/';

/**
 * Publica los JSON Schema de los módulos (`schema/`) junto al sitio: el manifiesto de federación
 * (`/.well-known/iark.json`) los anuncia como `endpoints.schema` y sirven de `$schema` para editores y agentes.
 */
function publishSchemas(): Plugin {
  let outDir = 'dist/app';
  return {
    name: 'iark-publish-schemas',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      if (existsSync('schema')) cpSync('schema', resolve(outDir, 'schema'), { recursive: true });
    },
  };
}

export default defineConfig({
  base,
  plugins: [react(), tailwindcss(), publishSchemas()],
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./packages/domain-c4/src', import.meta.url)),
      '@app': fileURLToPath(new URL('./src/app', import.meta.url)),
      '@embed': fileURLToPath(new URL('./src/embed', import.meta.url)),
    },
  },
  build: {
    // OUT_DIR permite compilar a otra carpeta (p. ej. el despliegue a Pages) sin pisar el dist/app que usan preview y E2E.
    outDir: process.env.OUT_DIR ?? 'dist/app',
    emptyOutDir: true,
    // Los únicos trozos por encima de 500 kB son inevitables: `domain-c4` (≈1,7 MB: el módulo C4 más ELK, ≈1,4 MB, y el kernel
    // que comparten todos los módulos), `elk` (la copia 0.9.3 de ELK que trae mermaid, ≈1,5 MB, solo se descarga al usar el
    // layout `elk` de mermaid) y `chunk-*` del parser de mermaid (≈660 kB, también bajo demanda). Partirlos no reduce lo que
    // se descarga (ELK es un único archivo minificado) y el trozo de C4 ya se carga a la vez que el editor. El límite queda
    // en 2000 kB en vez de desactivar el aviso: si un trozo nuevo o el editor (`main`, hoy ≈430 kB) crece hasta 2 MB, avisa.
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        'embed-host': fileURLToPath(new URL('./examples/embed-host.html', import.meta.url)),
        modulos: fileURLToPath(new URL('./modulos.html', import.meta.url)),
        'modules-host': fileURLToPath(new URL('./examples/modules-host.html', import.meta.url)),
        'web-component-host': fileURLToPath(new URL('./examples/web-component-host.html', import.meta.url)),
        suite: fileURLToPath(new URL('./suite.html', import.meta.url)),
        trazabilidad: fileURLToPath(new URL('./trazabilidad.html', import.meta.url)),
      },
      output: {
        // El módulo C4 lo importa el editor principal de forma estática y el banco de trabajo bajo demanda: si quedara
        // dentro del trozo del editor, abrir C4 en el banco ejecutaría (y pintaría) el editor entero. Va en su propio trozo.
        //
        // `zod` va en su propio trozo, junto con `zodJitless` (que desactiva su modo JIT en el navegador): ese trozo no depende de
        // ningún otro, así que se ejecuta entero antes que cualquiera que cree esquemas. Si zod quedara dentro de `domain-c4`
        // (que arrastra sus dependencias), los esquemas de C4 se crearían antes de que corriera `z.config({ jitless: true })` y
        // zod sondearía `new Function('')`, que la CSP de `iark serve` (sin `'unsafe-eval'`) anota como violación.
        codeSplitting: {
          groups: [
            { name: 'zod', test: /node_modules[\\/]zod[\\/]|kernel[\\/]src[\\/]util[\\/]zodJitless/, priority: 2 },
            { name: 'domain-c4', test: /packages[\\/]domain-c4[\\/]/ },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
  },
});
