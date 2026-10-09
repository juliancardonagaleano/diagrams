import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildPackage, loadPackages } from '../../scripts/packages';

export interface PluginProject {
  /** Carpeta del proyecto: lleva `node_modules/@iark/kernel`, el módulo de ejemplo en `plugin-riesgos/` y su `iark.config.json`. */
  dir: string;
  /** `iark.config.json` del proyecto: carga `./plugin-riesgos/index.mjs`. */
  config: string;
  /** Borra la carpeta. */
  dispose: () => void;
}

/**
 * Un proyecto como el de quien escribe un módulo de terceros: el plugin de ejemplo (`examples/plugin-riesgos`) junto a un
 * `node_modules/@iark/kernel` REAL, compilado como se publica (JavaScript en `dist`, sin `.d.ts`; es la salida de `packages:build`).
 * Hace falta porque el plugin importa `@iark/kernel` en ejecución y, dentro del repositorio, ese paquete apunta a `src/*.ts`, que
 * Node no carga. `zod` y lo demás se resuelven subiendo hasta el `node_modules` del repositorio, como en cualquier instalación.
 *
 * Va dentro de `node_modules/.cache` (como el empaquetado del CLI, ver `cliBundle.ts`) para que esa resolución encuentre `zod`.
 */
export async function createPluginProject(name: string): Promise<PluginProject> {
  const dir = resolve('node_modules/.cache', `iark-plugin-${name}`);
  const dispose = (): void => rmSync(dir, { recursive: true, force: true });
  dispose();
  mkdirSync(dir, { recursive: true });
  const kernel = loadPackages().find((pkg) => pkg.folder === 'kernel');
  if (!kernel) throw new Error('No se encontró packages/kernel');
  await buildPackage(kernel, { outDir: join(dir, 'node_modules', '@iark', 'kernel'), dts: false });
  cpSync(resolve('examples/plugin-riesgos'), join(dir, 'plugin-riesgos'), { recursive: true });
  const config = join(dir, 'iark.config.json');
  writeFileSync(config, JSON.stringify({ modules: ['./plugin-riesgos/index.mjs'] }));
  return { dir, config, dispose };
}
