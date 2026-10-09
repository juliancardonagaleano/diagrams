import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { PluginError, resolveExports, resolvePluginSpecifier } from './resolve';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'iark-resolve-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Crea `ruta` (con sus carpetas) dentro de `root` y devuelve su ruta absoluta. */
function write(path: string, text = ''): string {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
  return full;
}
const url = (path: string): string => pathToFileURL(join(root, path)).href;
const manifest = (name: string, fields: Record<string, unknown>): string => write(`node_modules/${name}/package.json`, JSON.stringify({ name, version: '1.0.0', ...fields }));

/** El mensaje del `PluginError` con el que falla la resolución. */
function failure(specifier: string, baseDir: string): string {
  try {
    resolvePluginSpecifier(specifier, baseDir);
  } catch (error) {
    expect(error).toBeInstanceOf(PluginError);
    expect((error as PluginError).specifier).toBe(specifier);
    return (error as Error).message;
  }
  throw new Error(`«${specifier}» debía fallar`);
}

describe('resolveExports (el campo exports de un paquete, con las condiciones de import de Node)', () => {
  it('una cadena, una lista o condiciones sueltas valen para "."', () => {
    expect(resolveExports('./a.js', '.')).toBe('./a.js');
    expect(resolveExports(['./a.js'], '.')).toBe('./a.js');
    expect(resolveExports({ import: './esm.js', require: './cjs.cjs' }, '.')).toBe('./esm.js');
    expect(resolveExports({ require: './cjs.cjs', default: './d.js' }, '.')).toBe('./d.js');
    expect(resolveExports({ types: './x.d.ts', default: './x.js' }, '.')).toBe('./x.js'); // `types` no es una condición de ejecución
  });

  it('condiciones anidadas, el orden manda y la lista salta lo que no sirve', () => {
    expect(resolveExports({ node: { import: './node.mjs', default: './node.cjs' }, default: './web.js' }, '.')).toBe('./node.mjs');
    expect(resolveExports({ default: './d.js', import: './i.js' }, '.')).toBe('./d.js');
    expect(resolveExports([{ require: './r.cjs' }, './b.js'], '.')).toBe('./b.js');
    expect(resolveExports({ 'module-sync': './sync.mjs', import: './i.mjs' }, '.')).toBe('./sync.mjs');
  });

  it('subrutas exactas y con patrón; la clave de patrón más larga gana', () => {
    const map = { '.': './index.js', './util': { import: './u.mjs' }, './f/*': './f/*.js', './f/privado/*': null, './g/*.js': './g/*.mjs' };
    expect(resolveExports(map, '.')).toBe('./index.js');
    expect(resolveExports(map, './util')).toBe('./u.mjs');
    expect(resolveExports(map, './f/uno')).toBe('./f/uno.js');
    expect(resolveExports(map, './g/dos.js')).toBe('./g/dos.mjs');
    expect(resolveExports(map, './f/privado/x')).toBeUndefined();
    expect(resolveExports(map, './otra')).toBeUndefined();
  });

  it('lo que no tiene objetivo ESM no se resuelve', () => {
    expect(resolveExports({ require: './cjs.cjs' }, '.')).toBeUndefined();
    expect(resolveExports({ import: null, default: './d.js' }, '.')).toBeUndefined();
    expect(resolveExports({ '.': './index.js' }, './nada')).toBeUndefined();
    expect(resolveExports('index.js', '.')).toBeUndefined(); // un objetivo debe empezar por ./
  });
});

describe('resolvePluginSpecifier: rutas', () => {
  it('una ruta relativa se resuelve respecto a la carpeta de la configuración (no al directorio actual)', () => {
    write('proyecto/plugins/mio.mjs', 'export default 1');
    const resolved = resolvePluginSpecifier('./plugins/mio.mjs', join(root, 'proyecto'));
    expect(resolved).toEqual({ specifier: './plugins/mio.mjs', url: url('proyecto/plugins/mio.mjs') });
    write('proyecto/otro.mjs');
    expect(resolvePluginSpecifier('../proyecto/otro.mjs', join(root, 'proyecto')).url).toBe(url('proyecto/otro.mjs'));
  });

  it('una ruta absoluta y una URL file: se admiten tal cual', () => {
    const file = write('abs/plugin.mjs');
    expect(resolvePluginSpecifier(file, '/no/importa').url).toBe(pathToFileURL(file).href);
    expect(resolvePluginSpecifier(pathToFileURL(file).href, '/no/importa').url).toBe(pathToFileURL(file).href);
  });

  it('un enlace simbólico se sigue hasta el archivo real (como hace Node)', () => {
    const real = write('real/plugin.mjs');
    mkdirSync(join(root, 'enlaces'), { recursive: true });
    symlinkSync(real, join(root, 'enlaces/plugin.mjs'));
    expect(resolvePluginSpecifier('./plugin.mjs', join(root, 'enlaces')).url).toBe(pathToFileURL(real).href);
  });

  it('una carpeta se trata como un paquete (exports o main) y sin package.json se rechaza', () => {
    write('local/package.json', JSON.stringify({ exports: { '.': { import: './dist/index.mjs' } } }));
    write('local/dist/index.mjs');
    expect(resolvePluginSpecifier('./local', root).url).toBe(url('local/dist/index.mjs'));
    write('conmain/package.json', JSON.stringify({ main: 'lib/m.js' }));
    write('conmain/lib/m.js');
    expect(resolvePluginSpecifier('./conmain/', root).url).toBe(url('conmain/lib/m.js'));
    mkdirSync(join(root, 'vacia'), { recursive: true });
    expect(failure('./vacia', root)).toMatch(/carpeta sin package\.json/);
  });

  it('una ruta que no existe dice cuál buscó', () => {
    const message = failure('./no-existe.mjs', root);
    expect(message).toContain('«./no-existe.mjs»');
    expect(message).toContain(join(root, 'no-existe.mjs'));
    expect(message).toMatch(/no existe/);
  });

  it('un esquema que no es file: (https, data, node, npm…) se rechaza: un módulo no se descarga al ejecutar', () => {
    for (const specifier of ['https://example.com/plugin.mjs', 'data:text/javascript,export default 1', 'node:fs', 'npm:@acme/x']) {
      expect(failure(specifier, root), specifier).toMatch(/solo se admiten nombres de paquete, rutas y URL file:/);
    }
  });
});

describe('resolvePluginSpecifier: paquetes', () => {
  it('un paquete con exports de solo "import" (que require.resolve no vería) se resuelve', () => {
    manifest('@acme/solo-esm', { type: 'module', exports: { '.': { types: './index.d.ts', import: './dist/index.js' } } });
    write('node_modules/@acme/solo-esm/dist/index.js');
    expect(resolvePluginSpecifier('@acme/solo-esm', root).url).toBe(url('node_modules/@acme/solo-esm/dist/index.js'));
  });

  it('sin exports usa main y, si no hay, index.js; un subpath sin exports es la ruta dentro del paquete', () => {
    manifest('con-main', { main: './principal.mjs' });
    write('node_modules/con-main/principal.mjs');
    write('node_modules/con-main/extra/mas.mjs');
    manifest('sin-main', {});
    write('node_modules/sin-main/index.js');
    expect(resolvePluginSpecifier('con-main', root).url).toBe(url('node_modules/con-main/principal.mjs'));
    expect(resolvePluginSpecifier('con-main/extra/mas.mjs', root).url).toBe(url('node_modules/con-main/extra/mas.mjs'));
    expect(resolvePluginSpecifier('sin-main', root).url).toBe(url('node_modules/sin-main/index.js'));
  });

  it('un subpath con exports solo se resuelve si el paquete lo exporta', () => {
    manifest('con-subpath', { exports: { '.': './a.mjs', './b': './dentro/b.mjs' } });
    write('node_modules/con-subpath/a.mjs');
    write('node_modules/con-subpath/dentro/b.mjs');
    expect(resolvePluginSpecifier('con-subpath/b', root).url).toBe(url('node_modules/con-subpath/dentro/b.mjs'));
    expect(failure('con-subpath/privado', root)).toMatch(/no exporta «\.\/privado»/);
  });

  it('busca en los node_modules de la carpeta de la configuración y en los de sus padres, y manda el más cercano', () => {
    manifest('compartido', { main: 'raiz.mjs' });
    write('node_modules/compartido/raiz.mjs');
    write('app/node_modules/compartido/package.json', JSON.stringify({ main: 'cercano.mjs' }));
    write('app/node_modules/compartido/cercano.mjs');
    expect(resolvePluginSpecifier('compartido', join(root, 'app/config')).url).toBe(url('app/node_modules/compartido/cercano.mjs'));
    expect(resolvePluginSpecifier('compartido', join(root, 'otra')).url).toBe(url('node_modules/compartido/raiz.mjs'));
  });

  it('un paquete que no está instalado dice dónde se buscó y cómo arreglarlo', () => {
    const message = failure('@acme/no-instalado', join(root, 'app'));
    expect(message).toContain('«@acme/no-instalado»');
    expect(message).toMatch(/no se encontró el paquete «@acme\/no-instalado»/);
    expect(message).toMatch(/npm install/);
  });

  it('un paquete sin entrada ESM, o cuyo archivo no existe (¿sin compilar?), se rechaza con el motivo', () => {
    manifest('solo-cjs', { exports: { require: './c.cjs' } });
    expect(failure('solo-cjs', root)).toMatch(/no exporta una entrada principal para ESM/);
    manifest('sin-compilar', { exports: './dist/index.js' });
    expect(failure('sin-compilar', root)).toMatch(/que no existe \(¿falta compilarlo\?\)/);
    write('node_modules/roto/package.json', '{ no es json');
    expect(failure('roto', root)).toMatch(/no se pudo leer/);
  });

  it('un nombre que no es de paquete ni una ruta se rechaza', () => {
    expect(failure('nombre con espacios', root)).toMatch(/no es un nombre de paquete válido/);
    expect(failure('paquete/../fuera', root)).toMatch(/no es un nombre de paquete válido/);
  });
});
