import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Resolución del especificador de un módulo de terceros (`iark.config.json` → `modules`) a un archivo que se puede importar:
 *
 *  - `file:///…`: esa ruta.
 *  - `./plugin.mjs`, `../plugin.mjs`, `/ruta/absoluta.mjs`: relativas a la carpeta de la configuración. Si es una carpeta, se
 *    trata como un paquete (su `package.json`: `exports` o `main`).
 *  - `@acme/iark-module-riesgos`, `iark-module-x/sub`: un paquete, buscado en los `node_modules` de la carpeta de la
 *    configuración y de sus padres (como lo hace Node), con las condiciones `node`, `import` y `default`.
 *
 * No se usa `require.resolve` porque no ve las condiciones de ESM (un paquete que solo declara `"import"` no se resolvería), ni
 * `import.meta.resolve(spec, padre)` porque su segundo argumento sigue tras una opción experimental en Node 22. Cualquier otro
 * esquema (`https:`, `data:`, `node:`…) se rechaza: un módulo se instala en la máquina, no se descarga al ejecutarlo.
 */

/** Un módulo de terceros ya resuelto: lo que se importa y cómo lo llamó quien lo configuró. */
export interface ResolvedPlugin {
  /** Tal como figura en `modules` (es lo que se muestra en los mensajes). */
  specifier: string;
  /** URL `file:` del archivo que se importa. */
  url: string;
}

/** Un especificador que no se pudo resolver o cargar. Lleva el especificador para que el mensaje y el código de salida lo nombren. */
export class PluginError extends Error {
  constructor(
    readonly specifier: string,
    detail: string,
  ) {
    super(`No se pudo cargar el módulo de terceros «${specifier}»: ${detail}`);
    this.name = 'PluginError';
  }
}

/** Condiciones de `exports` que aplica Node al importar (`import`) desde Node 22.12 (`module-sync` incluida). `types` no: no es código. */
const CONDITIONS = ['node', 'import', 'module-sync', 'default'];

type Json = unknown;

/** Aplica un objetivo de `exports`: una cadena `./…`, una lista (el primero que sirve) o condiciones anidadas. `undefined` si no hay ninguno. */
function exportsTarget(target: Json, substitution?: string): string | undefined {
  if (typeof target === 'string') return target.startsWith('./') ? (substitution === undefined ? target : target.replaceAll('*', substitution)) : undefined;
  if (Array.isArray(target)) {
    for (const item of target) {
      const found = exportsTarget(item, substitution);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (target && typeof target === 'object') {
    for (const [condition, inner] of Object.entries(target)) {
      if (!CONDITIONS.includes(condition)) continue;
      const found = exportsTarget(inner, substitution);
      if (found !== undefined) return found;
      if (inner === null) return undefined; // `null` corta: ese subcamino está explícitamente sin exportar
    }
  }
  return undefined;
}

/** El archivo que exporta un paquete para `subpath` (`.` o `./x`) según su campo `exports`, o `undefined` si no lo exporta. */
export function resolveExports(exportsField: Json, subpath: string): string | undefined {
  const isMap = exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField) && Object.keys(exportsField).some((key) => key.startsWith('.'));
  const map: Record<string, Json> = isMap ? (exportsField as Record<string, Json>) : { '.': exportsField };
  if (subpath in map && !subpath.includes('*')) return exportsTarget(map[subpath]);
  // Patrones `./carpeta/*`: gana la clave con el prefijo más largo.
  let best: { key: string; match: string } | undefined;
  for (const key of Object.keys(map)) {
    const star = key.indexOf('*');
    if (star < 0) continue;
    const head = key.slice(0, star);
    const tail = key.slice(star + 1);
    if (subpath.startsWith(head) && subpath.endsWith(tail) && subpath.length >= key.length - 1 && (!best || head.length > best.key.indexOf('*'))) {
      best = { key, match: subpath.slice(head.length, subpath.length - tail.length) };
    }
  }
  return best ? exportsTarget(map[best.key], best.match) : undefined;
}

interface PackageJson {
  main?: unknown;
  exports?: unknown;
}

function readPackageJson(dir: string, specifier: string): PackageJson {
  const file = join(dir, 'package.json');
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PackageJson;
  } catch (error) {
    throw new PluginError(specifier, `no se pudo leer ${file}: ${(error as Error).message}`);
  }
}

/** El archivo de entrada de un paquete instalado en `dir` para `subpath`. */
function packageEntry(dir: string, subpath: string, specifier: string): string {
  const pkg = readPackageJson(dir, specifier);
  let relative: string | undefined;
  if (pkg.exports !== undefined && pkg.exports !== null) {
    relative = resolveExports(pkg.exports, subpath);
    if (relative === undefined) {
      throw new PluginError(specifier, `el paquete no exporta ${subpath === '.' ? 'una entrada principal' : `«${subpath}»`} para ESM (revise el campo «exports» de ${join(dir, 'package.json')}; hace falta una condición «import» o «default»).`);
    }
  } else if (subpath === '.') {
    relative = typeof pkg.main === 'string' && pkg.main !== '' ? pkg.main : 'index.js';
  } else {
    relative = subpath;
  }
  const file = resolve(dir, relative);
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new PluginError(specifier, `el paquete apunta a «${file}», que no existe (¿falta compilarlo?).`);
  }
  return file;
}

/** Las carpetas `node_modules` donde Node buscaría un paquete desde `from` (sin las globales de `NODE_PATH`). */
function nodeModulesChain(from: string): string[] {
  const chain: string[] = [];
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (basename(dir) !== 'node_modules') chain.push(join(dir, 'node_modules'));
    if (dirname(dir) === dir) return chain;
  }
}

const PACKAGE_SPECIFIER = /^((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)(\/.*)?$/i;

function resolvePackage(specifier: string, baseDir: string): string {
  const match = PACKAGE_SPECIFIER.exec(specifier);
  if (!match || specifier.includes('\\') || specifier.split('/').some((part) => part === '..' || part === '.')) {
    throw new PluginError(specifier, 'no es un nombre de paquete válido ni una ruta (las rutas empiezan por ./, ../ o /).');
  }
  const name = match[1];
  const subpath = match[2] ? `.${match[2]}` : '.';
  for (const modules of nodeModulesChain(baseDir)) {
    const dir = join(modules, name);
    if (existsSync(join(dir, 'package.json'))) return packageEntry(dir, subpath, specifier);
  }
  throw new PluginError(specifier, `no se encontró el paquete «${name}» en los node_modules de «${baseDir}» ni de sus carpetas padre (instálelo con npm install en esa carpeta).`);
}

/** Resuelve `specifier` (tal como figura en `iark.config.json`) respecto a `baseDir`, la carpeta de la configuración. */
export function resolvePluginSpecifier(specifier: string, baseDir: string): ResolvedPlugin {
  let path: string;
  if (/^file:/i.test(specifier)) {
    try {
      path = fileURLToPath(specifier);
    } catch (error) {
      throw new PluginError(specifier, `la URL file: no es válida (${(error as Error).message}).`);
    }
  } else if (/^[a-z]:[\\/]/i.test(specifier) || isAbsolute(specifier) || /^\.\.?([\\/]|$)/.test(specifier)) {
    path = resolve(baseDir, specifier);
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) {
    throw new PluginError(specifier, 'solo se admiten nombres de paquete, rutas y URL file: (un módulo se instala en la máquina; no se descarga al ejecutar).');
  } else {
    path = resolvePackage(specifier, baseDir);
    return { specifier, url: pathToFileURL(realpathSync(path)).href };
  }
  if (!existsSync(path)) throw new PluginError(specifier, `no existe «${path}».`);
  const real = realpathSync(path);
  const file = statSync(real).isDirectory() ? (existsSync(join(real, 'package.json')) ? packageEntry(real, '.', specifier) : undefined) : real;
  if (!file) throw new PluginError(specifier, `«${path}» es una carpeta sin package.json: indique el archivo del módulo (p. ej. ${specifier.replace(/\/+$/, '')}/index.mjs).`);
  return { specifier, url: pathToFileURL(realpathSync(file)).href };
}
