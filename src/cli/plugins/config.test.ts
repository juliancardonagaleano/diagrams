import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CONFIG_FILE_NAME, ConfigError, iarkConfigJsonSchema, iarkConfigSchema, readConfig, scanGlobalFlags, selectConfig } from './config';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'iark-config-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function write(path: string, text: string): string {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
  return full;
}
const config = (path: string, body: unknown = { modules: [] }): string => write(path, JSON.stringify(body));

describe('readConfig', () => {
  it('lee los módulos y el módulo por omisión, y guarda la carpeta del archivo (respecto a ella se resuelve todo)', () => {
    const path = config('a/iark.config.json', { $schema: '../x.json', modules: ['@acme/iark-module-riesgos', './plugins/mio.mjs'], defaultModule: 'security' });
    expect(readConfig(path)).toEqual({ path, dir: dirname(path), modules: ['@acme/iark-module-riesgos', './plugins/mio.mjs'], defaultModule: 'security' });
  });

  it('modules es opcional (vale una lista vacía) y se tolera el BOM de algunos editores', () => {
    expect(readConfig(config('b/iark.config.json', {})).modules).toEqual([]);
    expect(readConfig(write('b/bom.json', `﻿{"modules":["./x.mjs"]}`)).modules).toEqual(['./x.mjs']);
  });

  it('un JSON inválido dice cuál archivo y por qué', () => {
    const path = write('c/iark.config.json', '{ "modules": [');
    expect(() => readConfig(path)).toThrow(ConfigError);
    expect(() => readConfig(path)).toThrow(new RegExp(`«${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}» no es JSON válido`));
  });

  it.each([
    ['una clave desconocida (un error de escritura se avisa, no se ignora)', { modulos: [] }, /Unrecognized key/],
    ['modules que no es una lista', { modules: './x.mjs' }, /modules: .*array/i],
    ['un especificador vacío', { modules: [''] }, /modules\.0/],
    ['un especificador que no es texto', { modules: [3] }, /modules\.0/],
    ['un defaultModule inválido', { defaultModule: 'Riesgos' }, /defaultModule/],
    ['la raíz que no es un objeto', [], /no es válido/],
  ])('rechaza %s', (_nombre, body, pattern) => {
    const path = config(`d/${Math.random().toString(36).slice(2)}.json`, body);
    expect(() => readConfig(path)).toThrow(ConfigError);
    expect(() => readConfig(path)).toThrow(pattern);
  });

  it('un archivo que no se puede leer dice cuál', () => {
    expect(() => readConfig(join(root, 'no-existe.json'))).toThrow(/No se pudo leer el archivo de configuración/);
  });
});

describe('scanGlobalFlags', () => {
  it('lee --config, --no-config, --workspace/-w y --from-repo, en las dos formas (separado o con =) y en cualquier posición', () => {
    expect(scanGlobalFlags(['--config', 'a.json', 'serve'])).toMatchObject({ config: 'a.json', noConfig: false });
    expect(scanGlobalFlags(['serve', '--config=b.json', '--port', '0'])).toMatchObject({ config: 'b.json' });
    expect(scanGlobalFlags(['modules', '--no-config'])).toEqual({ noConfig: true, workspace: [], fromRepo: [] });
    expect(scanGlobalFlags(['serve', '-w', 'w1', '--workspace', 'w2', '--workspace=w3'])).toMatchObject({ workspace: ['w1', 'w2', 'w3'] });
    expect(scanGlobalFlags(['generate', 'algo', '--from-repo', '../repo', '--from-repo=https://github.com/a/b'])).toMatchObject({ fromRepo: ['../repo', 'https://github.com/a/b'] });
  });

  it('lo que sigue a `--` ya no son opciones, y una opción sin valor no inventa uno', () => {
    expect(scanGlobalFlags(['validate', '--', '--config', 'x.json', '--no-config'])).toEqual({ noConfig: false, workspace: [], fromRepo: [] });
    expect(scanGlobalFlags(['modules', '--config'])).toEqual({ noConfig: false, workspace: [], fromRepo: [] });
    expect(scanGlobalFlags(['modules', '--config='])).toEqual({ noConfig: false, workspace: [], fromRepo: [] });
  });
});

describe('selectConfig: descubrimiento', () => {
  const flags = (extra: Partial<ReturnType<typeof scanGlobalFlags>> = {}) => ({ noConfig: false, workspace: [], fromRepo: [], ...extra });

  it('sin nada que lo indique, no hay configuración', () => {
    const cwd = join(root, 'vacio');
    mkdirSync(cwd, { recursive: true });
    expect(selectConfig(flags(), { env: {}, cwd })).toEqual({ kind: 'none' });
  });

  it('el iark.config.json del directorio actual se usa, pero NO se busca en los directorios padre', () => {
    config('proyecto/iark.config.json');
    mkdirSync(join(root, 'proyecto/sub'), { recursive: true });
    expect(selectConfig(flags(), { env: {}, cwd: join(root, 'proyecto') })).toEqual({ kind: 'file', path: join(root, 'proyecto', CONFIG_FILE_NAME), via: 'directorio actual' });
    expect(selectConfig(flags(), { env: {}, cwd: join(root, 'proyecto/sub') })).toEqual({ kind: 'none' });
  });

  it('--config manda sobre IARK_CONFIG y sobre el archivo del directorio actual; las rutas relativas lo son al directorio actual', () => {
    config('d1/iark.config.json');
    config('d1/otra.json');
    config('d1/env.json');
    const cwd = join(root, 'd1');
    expect(selectConfig(flags({ config: 'otra.json' }), { env: { IARK_CONFIG: 'env.json' }, cwd })).toEqual({ kind: 'file', path: join(cwd, 'otra.json'), via: '--config' });
    expect(selectConfig(flags(), { env: { IARK_CONFIG: 'env.json' }, cwd })).toEqual({ kind: 'file', path: join(cwd, 'env.json'), via: 'IARK_CONFIG' });
    expect(selectConfig(flags(), { env: { IARK_CONFIG: '' }, cwd })).toMatchObject({ via: 'directorio actual' }); // una variable vacía no cuenta
    expect(selectConfig(flags({ config: join(cwd, 'otra.json') }), { env: {}, cwd: root })).toMatchObject({ path: join(cwd, 'otra.json') });
  });

  it('un --config o IARK_CONFIG que no existe es un error (no se ignora en silencio); una carpeta tampoco vale', () => {
    const cwd = join(root, 'd2');
    mkdirSync(cwd, { recursive: true });
    expect(() => selectConfig(flags({ config: 'falta.json' }), { env: {}, cwd })).toThrow(/No existe el archivo de configuración «.*falta\.json» \(--config\)/);
    expect(() => selectConfig(flags(), { env: { IARK_CONFIG: 'falta.json' }, cwd })).toThrow(/\(IARK_CONFIG\)/);
    expect(() => selectConfig(flags({ config: '.' }), { env: {}, cwd })).toThrow(/es una carpeta/);
  });

  it('--no-config e IARK_NO_CONFIG lo desactivan todo, incluso lo explícito; --config con --no-config es una contradicción', () => {
    config('d3/iark.config.json');
    config('d3/otra.json');
    const cwd = join(root, 'd3');
    expect(selectConfig(flags({ noConfig: true }), { env: {}, cwd })).toEqual({ kind: 'none' });
    expect(selectConfig(flags({ noConfig: true }), { env: { IARK_CONFIG: 'otra.json' }, cwd })).toEqual({ kind: 'none' });
    for (const value of ['1', 'true', 'yes', 'on', 'TRUE']) expect(selectConfig(flags(), { env: { IARK_NO_CONFIG: value }, cwd }), value).toMatchObject({ kind: 'none' });
    expect(selectConfig(flags(), { env: { IARK_NO_CONFIG: '0' }, cwd })).toMatchObject({ kind: 'file' });
    // el cerrojo de entorno no se salta con --config, pero se avisa de que se ignora
    const locked = selectConfig(flags({ config: 'otra.json' }), { env: { IARK_NO_CONFIG: '1' }, cwd });
    expect(locked).toMatchObject({ kind: 'none', note: expect.stringMatching(/se ignora --config porque IARK_NO_CONFIG está activo/) });
    expect(() => selectConfig(flags({ noConfig: true, config: 'otra.json' }), { env: {}, cwd })).toThrow(/--config y --no-config se contradicen/);
  });
});

describe('selectConfig: nunca se carga de un proyecto clonado ni de un espacio de trabajo', () => {
  const flags = (extra: Partial<ReturnType<typeof scanGlobalFlags>> = {}) => ({ noConfig: false, workspace: [], fromRepo: [], ...extra });

  it.each([
    ['--workspace con la carpeta actual', { workspace: ['.'] }, {}],
    ['--workspace con un padre de la carpeta actual', { workspace: ['..'] }, {}],
    ['IARK_WORKSPACE con la carpeta actual', {}, { IARK_WORKSPACE: '.' }],
    ['--from-repo con la carpeta actual', { fromRepo: ['.'] }, {}],
    ['--from-repo con la ruta absoluta de la carpeta', { fromRepo: [join(root, 'repo-ajeno', 'app')] }, {}],
  ])('el iark.config.json del directorio actual no se carga con %s, y se dice por qué', (_nombre, extra, env) => {
    config('repo-ajeno/app/iark.config.json', { modules: ['./malicioso.mjs'] });
    const selection = selectConfig(flags(extra), { env, cwd: join(root, 'repo-ajeno/app') });
    expect(selection.kind).toBe('none');
    expect(selection).toMatchObject({ note: expect.stringMatching(/no se carga «.*iark\.config\.json» porque está dentro de una carpeta que se trata como contenido ajeno .*Si es suyo, indíquelo con --config/) });
  });

  it('una carpeta de trabajo o un repositorio que no contiene la configuración no la impide', () => {
    config('ok/iark.config.json');
    mkdirSync(join(root, 'ok/proyectos'), { recursive: true });
    const cwd = join(root, 'ok');
    expect(selectConfig(flags({ workspace: ['./proyectos'] }), { env: {}, cwd })).toMatchObject({ kind: 'file' });
    expect(selectConfig(flags({ fromRepo: ['https://github.com/a/b'] }), { env: {}, cwd })).toMatchObject({ kind: 'file' });
    expect(selectConfig(flags(), { env: { IARK_WORKSPACE: join(root, 'otra-parte') }, cwd })).toMatchObject({ kind: 'file' });
  });

  it('una configuración explícita (--config o IARK_CONFIG) sí se carga aunque esté dentro: la persona la señaló a mano', () => {
    const path = config('explicita/iark.config.json');
    const cwd = join(root, 'explicita');
    expect(selectConfig(flags({ workspace: ['.'], config: path }), { env: {}, cwd })).toMatchObject({ kind: 'file', via: '--config' });
    expect(selectConfig(flags({ workspace: ['.'] }), { env: { IARK_CONFIG: path }, cwd })).toMatchObject({ kind: 'file', via: 'IARK_CONFIG' });
  });
});

describe('el esquema de la configuración', () => {
  it('schema/iark-config.schema.json está al día (regenerar con `npm run schema`)', () => {
    expect(JSON.parse(readFileSync('schema/iark-config.schema.json', 'utf8'))).toEqual(JSON.parse(JSON.stringify(iarkConfigJsonSchema())));
  });

  it('describe los tres campos, no admite otros y no exige ninguno', () => {
    const schema = iarkConfigJsonSchema() as { $id: string; properties: Record<string, unknown>; additionalProperties?: boolean; required?: string[] };
    expect(schema.$id).toBe('https://github.com/juliancardonagaleano/iark-diagrams/schema/iark-config.schema.json');
    expect(Object.keys(schema.properties).sort()).toEqual(['$schema', 'defaultModule', 'modules']);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required ?? []).toEqual([]);
  });

  it('la configuración del módulo de ejemplo la cumple', () => {
    expect(iarkConfigSchema.safeParse(JSON.parse(readFileSync('examples/plugin-riesgos/iark.config.json', 'utf8'))).success).toBe(true);
  });

  it('`npm run schema` (scripts/generate-schema.ts) lo escribe junto a los demás', () => {
    expect(readFileSync('scripts/generate-schema.ts', 'utf8')).toMatch(/schema\/iark-config\.schema\.json/);
  });
});
