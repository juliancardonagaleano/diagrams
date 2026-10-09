import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { buildProgram, prepareStartup } from './main';
import { ConfigError } from './plugins/config';
import { PluginError } from './plugins/resolve';
import { createDefaultRegistry, createRegistry, RESERVED_COMMAND_NAMES, resolveConfigPlugins } from './registry';
import { readConfig } from './plugins/config';
import { suiteManifest } from './suiteManifest';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'iark-registro-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const BUILTIN = ['c4', 'integration', 'data', 'enterprise', 'platform', 'security'];

/** Un módulo escrito a mano que no importa nada (carga desde cualquier carpeta). */
const moduleSource = (id: string, extra = ''): string =>
  `export default { id: '${id}', name: 'Módulo ${id}', version: '2.0.0', documentVersion: '1.0', schema: { safeParse: (value) => ({ success: true, data: value }) }, jsonSchema: () => ({ type: 'object' }), validate: () => [], importers: [], exporters: []${extra} };`;

let counter = 0;
/** Una carpeta de proyecto con su iark.config.json y los plugins (`nombre → código`) que referencia. */
function project(files: Record<string, string>, config: unknown): string {
  counter += 1;
  const dir = join(root, `proyecto${counter}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, code] of Object.entries(files)) writeFileSync(join(dir, name), code);
  writeFileSync(join(dir, 'iark.config.json'), JSON.stringify(config));
  return dir;
}

function captureStderr(): string[] {
  const lines: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => (lines.push(String(chunk)), true)) as never);
  return lines;
}

describe('createRegistry', () => {
  it('sin configuración es exactamente el registro de siempre', async () => {
    const registry = await createRegistry();
    expect(registry.ids()).toEqual(BUILTIN);
    expect(registry.ids()).toEqual(createDefaultRegistry().ids());
    for (const id of BUILTIN) expect(registry.originOf(id)).toBeUndefined();
  });

  it('añade los módulos de la configuración tras los incorporados, con su origen, y anota cada uno', async () => {
    const dir = project({ 'a.mjs': moduleSource('uno'), 'b.mjs': moduleSource('dos') }, { modules: ['./a.mjs', './b.mjs'] });
    const lines = captureStderr();
    const registry = await createRegistry({ config: readConfig(join(dir, 'iark.config.json')) });
    expect(registry.ids()).toEqual([...BUILTIN, 'uno', 'dos']);
    expect(registry.originOf('uno')).toBe('./a.mjs');
    expect(registry.originOf('dos')).toBe('./b.mjs');
    expect(registry.originOf('c4')).toBeUndefined();
    expect(lines).toEqual(['Módulo de terceros cargado: uno ← ./a.mjs (contrato 1, documento 1.0)\n', 'Módulo de terceros cargado: dos ← ./b.mjs (contrato 1, documento 1.0)\n']);
  });

  it('el registro de plugins ya resueltos (el de los hilos de cálculo) es el mismo y puede callar la anotación', async () => {
    const dir = project({ 'a.mjs': moduleSource('uno') }, { modules: ['./a.mjs'] });
    const plugins = resolveConfigPlugins(readConfig(join(dir, 'iark.config.json')));
    const lines = captureStderr();
    const registry = await createRegistry({ plugins, log: () => undefined });
    expect(registry.ids()).toEqual([...BUILTIN, 'uno']);
    expect(lines).toEqual([]);
  });

  it('el id de un plugin no puede coincidir con el de un módulo incorporado: error, no sustitución', async () => {
    const dir = project({ 'falso.mjs': moduleSource('security') }, { modules: ['./falso.mjs'] });
    const error = await createRegistry({ config: readConfig(join(dir, 'iark.config.json')), log: () => undefined }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(PluginError);
    expect((error as PluginError).specifier).toBe('./falso.mjs');
    expect((error as Error).message).toMatch(/«\.\/falso\.mjs»: el id «security» ya lo usa un módulo incorporado: un módulo de terceros no puede sustituir a otro/);
  });

  it('ni con el de otro plugin (se dice cuál lo cargó primero)', async () => {
    const dir = project({ 'a.mjs': moduleSource('repetido'), 'b.mjs': moduleSource('repetido') }, { modules: ['./a.mjs', './b.mjs'] });
    const error = await createRegistry({ config: readConfig(join(dir, 'iark.config.json')), log: () => undefined }).catch((e: Error) => e);
    expect((error as PluginError).specifier).toBe('./b.mjs');
    expect((error as Error).message).toMatch(/el id «repetido» ya lo usa el módulo de terceros cargado desde «\.\/a\.mjs»/);
  });

  it('ni con el de un comando del CLI (su grupo de comandos taparía al comando)', async () => {
    const dir = project({ 'serve.mjs': moduleSource('serve') }, { modules: ['./serve.mjs'] });
    const error = await createRegistry({ config: readConfig(join(dir, 'iark.config.json')), log: () => undefined }).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/el id «serve» es el de un comando del CLI \(iark serve\)/);
  });

  it('un plugin que no existe falla con su especificador antes de ejecutar ninguno (se resuelven todos primero)', async () => {
    const dir = project({ 'a.mjs': moduleSource('uno') }, { modules: ['./a.mjs', '@acme/no-esta'] });
    const lines = captureStderr();
    const error = await createRegistry({ config: readConfig(join(dir, 'iark.config.json')) }).catch((e: Error) => e);
    expect((error as PluginError).specifier).toBe('@acme/no-esta');
    expect(lines).toEqual([]); // ni siquiera el bueno llegó a importarse: no se ejecuta código de una configuración a medias
  });

  it('los comandos del CLI reservados cubren todos los comandos de primer nivel que no son grupos de un módulo', () => {
    const registry = createDefaultRegistry();
    const groups = new Set(registry.list().filter((m) => m.cliCommands?.length).map((m) => m.id));
    const topLevel = buildProgram(registry).commands.map((c) => c.name()).filter((name) => !groups.has(name));
    for (const name of topLevel) expect(RESERVED_COMMAND_NAMES, `«${name}» es un comando del CLI y falta en RESERVED_COMMAND_NAMES`).toContain(name);
  });
});

describe('prepareStartup: la configuración se decide antes de construir los comandos', () => {
  const argv = (...args: string[]): string[] => ['node', 'iark', ...args];

  it('con un iark.config.json en el directorio actual carga sus módulos y deja los resueltos para los hilos de cálculo', async () => {
    const dir = project({ 'a.mjs': moduleSource('uno') }, { modules: ['./a.mjs'] });
    captureStderr();
    const startup = await prepareStartup(argv('modules'), { env: {}, cwd: dir });
    expect(startup.registry.ids()).toEqual([...BUILTIN, 'uno']);
    expect(startup.settings.plugins).toEqual([{ specifier: './a.mjs', url: expect.stringMatching(/^file:\/\/.*\/a\.mjs$/) }]);
    expect(startup.settings.defaultModule).toBeUndefined();
    expect(startup.config?.path).toBe(join(dir, 'iark.config.json'));
  });

  it('sin configuración (o con --no-config / IARK_NO_CONFIG) devuelve los seis incorporados y no resuelve nada', async () => {
    const dir = project({ 'a.mjs': moduleSource('uno') }, { modules: ['./a.mjs'] });
    for (const [args, env] of [[['modules', '--no-config'], {}], [['modules'], { IARK_NO_CONFIG: '1' }]] as const) {
      const startup = await prepareStartup(argv(...args), { env, cwd: dir });
      expect(startup.registry.ids()).toEqual(BUILTIN);
      expect(startup.settings).toEqual({});
      expect(startup.config).toBeUndefined();
    }
    const empty = join(root, 'sin-config');
    mkdirSync(empty, { recursive: true });
    expect((await prepareStartup(argv('modules'), { env: {}, cwd: empty })).registry.ids()).toEqual(BUILTIN);
  });

  it('las rutas del plugin son relativas a la carpeta de la configuración, no al directorio actual', async () => {
    const dir = project({ 'a.mjs': moduleSource('uno') }, { modules: ['./a.mjs'] });
    const elsewhere = join(root, 'otro-sitio');
    mkdirSync(elsewhere, { recursive: true });
    captureStderr();
    const startup = await prepareStartup(argv('--config', join(dir, 'iark.config.json'), 'modules'), { env: {}, cwd: elsewhere });
    expect(startup.registry.has('uno')).toBe(true);
  });

  it('la configuración de un directorio que esta ejecución trata como ajeno (--workspace, --from-repo) NO se carga', async () => {
    const dir = project({ 'a.mjs': moduleSource('uno') }, { modules: ['./a.mjs'] });
    for (const args of [['serve', '--workspace', '.'], ['serve', '-w', dir], ['generate', 'algo', '--from-repo', '.', '--dry-run']]) {
      const lines = captureStderr();
      const startup = await prepareStartup(argv(...args), { env: {}, cwd: dir });
      expect(startup.registry.ids(), args.join(' ')).toEqual(BUILTIN);
      expect(lines.join(''), args.join(' ')).toMatch(/no se carga «.*iark\.config\.json» porque está dentro de una carpeta que se trata como contenido ajeno/);
      vi.restoreAllMocks();
    }
  });

  it('el módulo por omisión sale de la configuración, y si no existe es un error de configuración', async () => {
    const good = project({ 'a.mjs': moduleSource('uno') }, { modules: ['./a.mjs'], defaultModule: 'uno' });
    captureStderr();
    expect((await prepareStartup(argv('validate'), { env: {}, cwd: good })).settings.defaultModule).toBe('uno');
    const builtin = project({}, { defaultModule: 'security' });
    expect((await prepareStartup(argv('validate'), { env: {}, cwd: builtin })).settings.defaultModule).toBe('security');
    const bad = project({}, { defaultModule: 'no-existe' });
    await expect(prepareStartup(argv('validate'), { env: {}, cwd: bad })).rejects.toThrow(ConfigError);
    await expect(prepareStartup(argv('validate'), { env: {}, cwd: bad })).rejects.toThrow(/«defaultModule» .* es «no-existe», que no es un módulo incorporado ni uno de los cargados/);
  });

  it('un JSON inválido o un plugin roto terminan con un error que lo nombra (nunca se ignoran)', async () => {
    const broken = join(root, 'roto');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'iark.config.json'), '{ "modules": [');
    await expect(prepareStartup(argv('modules'), { env: {}, cwd: broken })).rejects.toThrow(/no es JSON válido/);
    const missing = project({}, { modules: ['./falta.mjs'] });
    await expect(prepareStartup(argv('modules'), { env: {}, cwd: missing })).rejects.toThrow(/«\.\/falta\.mjs»/);
  });
});

describe('los módulos de terceros en las superficies', () => {
  it('`iark modules` lista cada módulo con su origen, el contrato y la versión del documento', async () => {
    const dir = project({ 'a.mjs': moduleSource('uno') }, { modules: ['./a.mjs'] });
    captureStderr();
    const startup = await prepareStartup(['node', 'iark', 'modules'], { env: {}, cwd: dir });
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => (out.push(String(chunk)), true)) as never);
    await buildProgram(startup.registry, startup.settings).parseAsync(['node', 'iark', 'modules']);
    const text = out.join('');
    expect(text).toMatch(/^c4 {2}Arquitectura de soluciones \(C4\) {2}v[\d.]+\n {4}importa: drawio, mermaid, dsl {2}· {2}exporta: drawio, svg, mermaid\n {4}origen: incorporado {2}· {2}contrato: 1 {2}· {2}documento: 1\.0\n/);
    expect(text).toMatch(/^uno {2}Módulo uno {2}v2\.0\.0\n {4}importa: - {2}· {2}exporta: -\n {4}origen: \.\/a\.mjs {2}· {2}contrato: 1 {2}· {2}documento: 1\.0\n/m);
  });

  it('--module usa el módulo por omisión de la configuración, y la ayuda de las opciones globales lo documenta', () => {
    const program = buildProgram(createDefaultRegistry(), { defaultModule: 'security' });
    for (const name of ['generate', 'convert', 'import', 'validate', 'migrate', 'schema', 'prompt', 'diff']) {
      const option = program.commands.find((c) => c.name() === name)!.options.find((o) => o.long === '--module')!;
      expect(option.defaultValue, name).toBe('security');
    }
    const plain = buildProgram(createDefaultRegistry());
    expect(plain.commands.find((c) => c.name() === 'validate')!.options.find((o) => o.long === '--module')!.defaultValue).toBe('c4');
    expect(program.options.map((o) => o.long)).toEqual(expect.arrayContaining(['--config', '--no-config']));
  });

  it('un módulo de terceros sale en el manifiesto con su API, sin editor ni esquema estático del sitio (que no lo trae)', async () => {
    const dir = project({ 'a.mjs': moduleSource('uno') }, { modules: ['./a.mjs'] });
    captureStderr();
    const { registry } = await prepareStartup(['node', 'iark'], { env: {}, cwd: dir });
    const withSite = suiteManifest(registry, { version: '1', api: '../api', site: true });
    const uno = withSite.modules.find((m) => m.id === 'uno')!;
    expect(uno).toMatchObject({ id: 'uno', contractVersion: 1, documentVersion: '1.0', endpoints: { api: '../api/uno', schema: '../api/uno/schema' } });
    expect(uno.endpoints).not.toHaveProperty('embed');
    // los incorporados siguen igual
    expect(withSite.modules.find((m) => m.id === 'security')!.endpoints).toMatchObject({ embed: '../modulos.html?module=security', schema: '../schema/security-document.schema.json', api: '../api/security' });
    expect(suiteManifest(registry, { version: '1', api: '../api', site: false }).modules.find((m) => m.id === 'uno')!.endpoints).toEqual({ api: '../api/uno', schema: '../api/uno/schema' });
  });

  it('el módulo de ejemplo del repositorio entra en el registro con su origen y sus comandos cuelgan de `iark risk`', async () => {
    captureStderr();
    const registry = await createRegistry({ config: readConfig(resolve('examples/plugin-riesgos/iark.config.json')) });
    expect(registry.originOf('risk')).toBe('./index.mjs');
    const program = buildProgram(registry);
    const group = program.commands.find((c) => c.name() === 'risk')!;
    expect(group.commands.map((c) => c.name())).toEqual(['top']);
  });
});
