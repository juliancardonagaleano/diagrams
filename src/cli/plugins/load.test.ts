import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CONTRACT_VERSION } from '@iark/kernel';
import { loadModulePlugin } from './load';
import { PluginError } from './resolve';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'iark-load-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Un módulo escrito a mano, sin importar nada (así carga desde cualquier carpeta): `fields` se vuelca como código dentro del literal. */
const moduleLiteral = (fields = ''): string =>
  `{ id: 'externo', name: 'Externo', version: '1.0.0', documentVersion: '1.0', schema: { safeParse: (value) => ({ success: true, data: value }) }, jsonSchema: () => ({ type: 'object' }), validate: () => [], importers: [], exporters: []${fields ? `, ${fields}` : ''} }`;

let counter = 0;
/** Escribe un plugin en una carpeta nueva (el cargador importa por URL: un archivo reescrito se volvería a servir de la caché) y devuelve su especificador. */
function plugin(source: string, name = 'plugin.mjs'): { specifier: string; baseDir: string } {
  counter += 1;
  const baseDir = join(root, `p${counter}`);
  mkdirSync(dirname(join(baseDir, name)), { recursive: true });
  writeFileSync(join(baseDir, name), source);
  return { specifier: `./${name}`, baseDir };
}

async function failure(specifier: string, baseDir: string): Promise<string> {
  try {
    await loadModulePlugin(specifier, { baseDir });
  } catch (error) {
    expect(error).toBeInstanceOf(PluginError);
    expect((error as PluginError).specifier).toBe(specifier);
    return (error as Error).message;
  }
  throw new Error(`«${specifier}» debía fallar`);
}

describe('loadModulePlugin', () => {
  it('carga un módulo exportado como valor', async () => {
    const { specifier, baseDir } = plugin(`export default ${moduleLiteral()};`);
    const loaded = await loadModulePlugin(specifier, { baseDir });
    expect(loaded.module.id).toBe('externo');
    expect(loaded.specifier).toBe('./plugin.mjs');
    expect(loaded.url).toMatch(/^file:\/\/.*\/plugin\.mjs$/);
  });

  it('carga un módulo que exporta una fábrica, síncrona o asíncrona', async () => {
    const sync = plugin(`export default () => (${moduleLiteral()});`);
    expect((await loadModulePlugin(sync.specifier, sync)).module.id).toBe('externo');
    const asynchronous = plugin(`export default async () => { await new Promise((r) => setTimeout(r, 1)); return ${moduleLiteral("id: 'tardio'")}; };`);
    expect((await loadModulePlugin(asynchronous.specifier, asynchronous)).module.id).toBe('tardio');
  });

  it('un CommonJS compilado (exports.default = módulo) también carga', async () => {
    const cjs = plugin(`Object.defineProperty(exports, '__esModule', { value: true }); exports.default = ${moduleLiteral()};`, 'plugin.cjs');
    expect((await loadModulePlugin(cjs.specifier, cjs)).module.id).toBe('externo');
  });

  it('carga desde un paquete instalado en los node_modules de la carpeta de la configuración', async () => {
    const dir = join(root, 'proyecto');
    mkdirSync(join(dir, 'node_modules/@acme/iark-externo'), { recursive: true });
    writeFileSync(join(dir, 'node_modules/@acme/iark-externo/package.json'), JSON.stringify({ name: '@acme/iark-externo', type: 'module', exports: { import: './index.mjs' } }));
    writeFileSync(join(dir, 'node_modules/@acme/iark-externo/index.mjs'), `export default ${moduleLiteral("id: 'desde-paquete'")};`);
    const loaded = await loadModulePlugin('@acme/iark-externo', { baseDir: dir });
    expect(loaded.module.id).toBe('desde-paquete');
    expect(loaded.specifier).toBe('@acme/iark-externo');
  });

  it('carga el módulo de ejemplo del repositorio (que importa @iark/kernel y zod) y es un módulo completo', async () => {
    const loaded = await loadModulePlugin('./index.mjs', { baseDir: resolve('examples/plugin-riesgos') });
    expect(loaded.module).toMatchObject({ id: 'risk', contractVersion: CONTRACT_VERSION, documentVersion: '1.0' });
    expect(loaded.module.exporters.map((e) => e.id)).toEqual(['md']);
    expect(loaded.module.importers.map((i) => i.id)).toEqual(['csv']);
  });

  it('un módulo escrito para un contrato mayor que el del anfitrión no carga, y el mensaje nombra el plugin', async () => {
    const { specifier, baseDir } = plugin(`export default ${moduleLiteral(`contractVersion: ${CONTRACT_VERSION + 1}`)};`);
    const message = await failure(specifier, baseDir);
    expect(message).toContain('No se pudo cargar el módulo de terceros «./plugin.mjs»');
    expect(message).toMatch(/versión 2 del contrato DomainModule y este DIAgrams implementa la 1/);
  });

  it('un módulo con la forma inválida lista todo lo que falla', async () => {
    const { specifier, baseDir } = plugin(`export default { id: 'Mal Id', name: 'X', version: '1', documentVersion: '1.0', schema: {}, jsonSchema: () => ({}), importers: [], exporters: [] };`);
    const message = await failure(specifier, baseDir);
    expect(message).toMatch(/no cumple el contrato DomainModule/);
    expect(message).toMatch(/«id» debe ser un identificador en minúsculas/);
    expect(message).toMatch(/«schema» debe ser un esquema de zod/);
    expect(message).toMatch(/falta «validate»/);
  });

  it('sin export default, o con un default que no es un módulo, se explica qué debe exportar', async () => {
    const none = plugin('export const algo = 1;');
    expect(await failure(none.specifier, none.baseDir)).toMatch(/no exporta nada por defecto: debe ser `export default defineModule/);
    const number = plugin('export default 42;');
    expect(await failure(number.specifier, number.baseDir)).toMatch(/no es un módulo \(es number\)/);
  });

  it('una fábrica que lanza, o un archivo que lanza al importarse, se cuentan con el especificador', async () => {
    const factory = plugin(`export default () => { throw new Error('sin configuración'); };`);
    expect(await failure(factory.specifier, factory.baseDir)).toMatch(/falló al construirlo: sin configuración/);
    const top = plugin(`throw new Error('explotó al importar');`);
    expect(await failure(top.specifier, top.baseDir)).toMatch(/explotó al importar/);
    const syntax = plugin('export default {{');
    expect(await failure(syntax.specifier, syntax.baseDir)).toContain('«./plugin.mjs»');
  });

  it('una dependencia que falta (el plugin importa un paquete que no está instalado) sugiere instalarla', async () => {
    const { specifier, baseDir } = plugin(`import algo from 'paquete-que-no-existe-iark'; export default algo;`);
    const message = await failure(specifier, baseDir);
    expect(message).toMatch(/paquete-que-no-existe-iark/);
    expect(message).toMatch(/instálela junto a él con npm install: @iark\/kernel y zod van como peerDependencies/);
  });

  it('una ruta o un paquete que no existen fallan nombrando el especificador', async () => {
    expect(await failure('./nada.mjs', root)).toMatch(/«\.\/nada\.mjs»: no existe/);
    expect(await failure('@acme/nada', root)).toMatch(/«@acme\/nada»: no se encontró el paquete/);
  });
});
