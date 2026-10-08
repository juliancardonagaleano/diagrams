import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, resolve } from 'node:path';
import { build, type Options } from 'tsup';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import configs from '../tsup.config';

// El paquete publicado y la imagen Docker solo instalan `dependencies` (`npm prune --omit=dev`), y las librerías del
// frontend (react, Semi UI, xyflow, zustand…) viven en `devDependencies` porque Vite las empaqueta en `dist/app`. Esta
// prueba construye con tsup las salidas publicadas (núcleo, CLI y su hilo de trabajo, y los dos bundles de embebido) y comprueba con el
// metafile de esbuild que cada import externo que queda en ellas es una dependencia de ejecución declarada. Si una
// entrada empieza a importar algo que solo está en `devDependencies`, el binario o el subpath fallarían al instalar el
// paquete (o tsup lo incrustaría en el bundle sin avisar).
describe('dependencias de ejecución del paquete publicado', () => {
  const outDir = resolve('node_modules/.cache/iark-runtime-deps-test');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  const builtins = new Set(builtinModules);
  const packageOf = (specifier: string): string => specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
  const isBuiltin = (specifier: string): boolean => specifier.startsWith('node:') || builtins.has(specifier.split('/')[0]);

  /** Imports externos de cada salida construida: `archivo → paquetes`. */
  const externals = new Map<string, Set<string>>();
  /** Paquetes de `node_modules` que tsup incrusta en cada salida: `archivo → paquetes`. */
  const bundled = new Map<string, Set<string>>();

  beforeAll(async () => {
    rmSync(outDir, { recursive: true, force: true });
    for (const [i, config] of (configs as Options[]).entries()) {
      // Cada configuración a su carpeta: varias comparten `outDir` y sus metafiles se pisarían.
      const dir = join(outDir, String(i));
      await build({ ...config, config: false, outDir: dir, dts: false, sourcemap: false, metafile: true, silent: true });
      for (const file of readdirSync(dir).filter((f) => /^metafile-.*\.json$/.test(f))) {
        const meta = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
          outputs: Record<string, { imports: { path: string; external?: boolean }[]; inputs: Record<string, unknown> }>;
        };
        for (const [output, { imports, inputs }] of Object.entries(meta.outputs)) {
          if (!/\.(js|mjs|cjs)$/.test(output)) continue;
          const found = externals.get(output) ?? new Set<string>();
          for (const imp of imports) if (imp.external && !isBuiltin(imp.path)) found.add(packageOf(imp.path));
          externals.set(output, found);
          const inside = bundled.get(output) ?? new Set<string>();
          for (const input of Object.keys(inputs)) {
            const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
            if (match) inside.add(match[1]);
          }
          bundled.set(output, inside);
        }
      }
    }
  }, 120_000);

  afterAll(() => rmSync(outDir, { recursive: true, force: true }));

  it('construye las salidas publicadas (núcleo, CLI con su hilo de trabajo del cálculo, y los dos bundles de embebido)', () => {
    const outputs = [...externals.keys()].map((o) => o.replace(/^.*node_modules\/\.cache\/iark-runtime-deps-test\/\d+\//, ''));
    for (const expected of ['core/index.js', 'cli/index.js', 'cli/compute-worker.js', 'embed/iark-embed.js', 'embed/iark-module-element.js']) {
      expect(outputs, `falta ${expected}`).toContain(expected);
    }
  });

  it('cada import externo del núcleo y el CLI está en `dependencies`', () => {
    const declared = new Set(Object.keys(pkg.dependencies));
    for (const [output, found] of externals) {
      for (const dep of found) expect(declared.has(dep), `${output} importa «${dep}», que no está en dependencies`).toBe(true);
    }
  });

  it('los bundles de embebido son autónomos (no importan nada)', () => {
    for (const [output, found] of externals) {
      if (output.includes('/embed/')) expect([...found], `${output} no debe depender de paquetes`).toEqual([]);
    }
  });

  it('el frontend no está en `dependencies` ni lo importa ninguna salida', () => {
    const frontend = ['react', 'react-dom', '@xyflow/react', 'zustand', 'zundo', '@douyinfe/semi-ui', '@douyinfe/semi-icons', 'mermaid'];
    for (const name of frontend) {
      expect(pkg.dependencies[name], `${name} debe ser devDependency`).toBeUndefined();
      expect(pkg.devDependencies[name], `${name} debe estar declarada`).toBeDefined();
    }
    for (const [output, found] of externals) for (const name of frontend) expect(found.has(name), `${output} importa ${name}`).toBe(false);
    // tsup solo externaliza `dependencies`: un import de una devDependency se incrustaría en la salida sin fallar.
    for (const [output, inside] of bundled) for (const name of frontend) expect(inside.has(name), `${output} incrusta ${name}`).toBe(false);
  });
});
