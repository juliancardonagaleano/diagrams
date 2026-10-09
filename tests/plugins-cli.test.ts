import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createToken } from '../src/cli/tokens';
import { buildCliBundle, BUNDLE_TIMEOUT, PROCESS_TEST_TIMEOUT, type CliBundle } from './helpers/cliBundle';
import { createPluginProject, type PluginProject } from './helpers/pluginProject';

/**
 * La compuerta de la fase 2: un módulo de terceros sin tocar el repositorio. Se ejecuta el CLI empaquetado de verdad (el mismo
 * `dist/cli/index.js` que se publica, con su hilo de cálculo `compute-worker.js`) con `iark.config.json` y el plugin de ejemplo
 * `examples/plugin-riesgos`, que importa `@iark/kernel` y `zod` de su propia instalación (ver `helpers/pluginProject.ts`).
 */

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT, hookTimeout: BUNDLE_TIMEOUT });

const BUILTIN = ['c4', 'integration', 'data', 'enterprise', 'platform', 'security'];

let bundle: CliBundle;
let project: PluginProject;
beforeAll(async () => {
  [bundle, project] = await Promise.all([buildCliBundle('plugins-cli'), createPluginProject('plugins-cli')]);
});
afterAll(() => {
  bundle?.dispose();
  project?.dispose();
});

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Ejecuta el CLI en `cwd` (por omisión, la carpeta del proyecto) con un entorno limpio de variables de DIAgrams. */
function iark(args: string[], options: { cwd?: string; env?: Record<string, string>; input?: string } = {}): Run {
  const r = spawnSync(process.execPath, [bundle.cli, ...args], {
    cwd: options.cwd ?? project.dir,
    input: options.input,
    encoding: 'utf8',
    env: { ...process.env, IARK_CONFIG: '', IARK_NO_CONFIG: '', IARK_WORKSPACE: '', IARK_TOKENS: '', ...options.env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const idsOf = (stdout: string): string[] => [...stdout.matchAll(/^([a-z][a-z0-9-]*) {2}\S/gm)].map((m) => m[1]);
const example = (file: string): string => join(project.dir, 'plugin-riesgos', file);

let caseCounter = 0;
/** Una carpeta de proyecto con su iark.config.json y archivos de plugin (nombre → código). */
function configured(config: unknown, files: Record<string, string> = {}): string {
  caseCounter += 1;
  const dir = join(project.dir, `caso${caseCounter}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, code] of Object.entries(files)) writeFileSync(join(dir, name), code);
  writeFileSync(join(dir, 'iark.config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return dir;
}

/** Un módulo escrito a mano que no importa nada. */
const literal = (id: string, extra = ''): string =>
  `export default { id: '${id}', name: 'Módulo ${id}', version: '1.0.0', documentVersion: '1.0', schema: { safeParse: (value) => ({ success: true, data: value }) }, jsonSchema: () => ({ type: 'object' }), validate: () => [], importers: [], exporters: []${extra} };`;

describe('iark --config: el módulo de terceros en el CLI', () => {
  it('`iark --config … modules` lista el módulo de ejemplo con su origen y versiones, y lo anota en stderr', () => {
    const r = iark(['--config', project.config, 'modules']);
    expect(r.status).toBe(0);
    expect(idsOf(r.stdout)).toEqual([...BUILTIN, 'risk']);
    expect(r.stdout).toMatch(/^risk {2}Registro de riesgos {2}v1\.0\.0\n {4}importa: csv {2}· {2}exporta: md\n {4}origen: \.\/plugin-riesgos\/index\.mjs {2}· {2}contrato: 1 {2}· {2}documento: 1\.0\n/m);
    expect(r.stdout).toMatch(/^c4 .*\n.*\n {4}origen: incorporado {2}· {2}contrato: 1 {2}· {2}documento: 1\.0$/m);
    expect(r.stderr).toBe('Módulo de terceros cargado: risk ← ./plugin-riesgos/index.mjs (contrato 1, documento 1.0)\n');
  });

  it('`modules --json` publica el módulo de terceros en el manifiesto (con su contrato) y sin ninguna ruta local', () => {
    const manifest = JSON.parse(iark(['--config', project.config, 'modules', '--json']).stdout);
    const risk = manifest.modules.find((m: { id: string }) => m.id === 'risk');
    expect(risk).toMatchObject({ id: 'risk', name: 'Registro de riesgos', contractVersion: 1, documentVersion: '1.0', importFormats: ['csv'], exportFormats: ['md'] });
    expect(JSON.stringify(manifest)).not.toContain(project.dir);
  });

  it('la opción vale antes y después del comando', () => {
    expect(idsOf(iark(['modules', '--config', project.config], { cwd: configured({}) }).stdout)).toContain('risk');
    expect(idsOf(iark(['--config', project.config, 'modules'], { cwd: configured({}) }).stdout)).toContain('risk');
  });

  it('descubrimiento: el iark.config.json del directorio actual se carga solo; --no-config e IARK_NO_CONFIG lo desactivan; IARK_CONFIG lo señala', () => {
    expect(idsOf(iark(['modules']).stdout)).toEqual([...BUILTIN, 'risk']);
    expect(idsOf(iark(['modules', '--no-config']).stdout)).toEqual(BUILTIN);
    expect(iark(['modules', '--no-config']).stderr).toBe('');
    expect(idsOf(iark(['modules'], { env: { IARK_NO_CONFIG: '1' } }).stdout)).toEqual(BUILTIN);
    const elsewhere = configured({ modules: [] });
    expect(idsOf(iark(['modules'], { cwd: elsewhere }).stdout)).toEqual(BUILTIN);
    expect(idsOf(iark(['modules'], { cwd: elsewhere, env: { IARK_CONFIG: project.config } }).stdout)).toEqual([...BUILTIN, 'risk']);
    // NO se sube a los directorios padre: un subdirectorio del proyecto no hereda la configuración
    const sub = join(project.dir, 'sub');
    mkdirSync(sub, { recursive: true });
    expect(idsOf(iark(['modules'], { cwd: sub }).stdout)).toEqual(BUILTIN);
  });

  it('las rutas de la configuración son relativas a su carpeta, no al directorio actual', () => {
    const r = iark(['--config', join(project.dir, 'iark.config.json'), 'modules'], { cwd: configured({ modules: [] }) });
    expect(r.status).toBe(0);
    expect(idsOf(r.stdout)).toContain('risk');
  });

  it('`iark validate --module risk` valida con las reglas del módulo de terceros (avisos y código de salida)', () => {
    const r = iark(['--config', project.config, 'validate', '--module', 'risk', example('riesgos.json')]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('aviso    El riesgo alto «Robo de sesiones de la aplicación web» (16 puntos) no tiene mitigación.');
    expect(r.stdout).toContain('Documento válido (módulo risk). 0 error(es), 2 aviso(s), 0 nota(s).');
    expect(iark(['--config', project.config, 'validate', '--module', 'risk', '--strict', example('riesgos.json')]).status).toBe(3);
  });

  it('un documento que no cumple el esquema del módulo de terceros falla con código 2 y dice qué campo', () => {
    const r = iark(['--config', project.config, 'validate', '--module', 'risk', '--stdin'], { input: JSON.stringify({ risks: [{ id: 'x', title: 't', probability: 9, impact: 1 }] }) });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Documento inválido para el módulo «risk»/);
    expect(r.stderr).toMatch(/risks\.0\.probability/);
  });

  it('`iark convert --module risk --to md` exporta con el exportador del módulo de terceros', () => {
    const r = iark(['--config', project.config, 'convert', '--module', 'risk', example('riesgos.json'), '--to', 'md']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^# Riesgos de la banca en línea\n\n\| Id \| Riesgo \| P \| I \| Puntos \| Estado \| Responsable \|\n/);
    expect(r.stdout).toContain('| mainframe-fin-de-soporte | El sistema bancario central pierde soporte del fabricante | 4 | 5 | 20 (alto) | en mitigación | luis |');
    expect(iark(['--config', project.config, 'convert', '--module', 'risk', example('riesgos.json'), '--to', 'pdf']).status).not.toBe(0);
  });

  it('`iark import --module risk` importa un CSV con el importador del módulo y avisa de las filas inválidas', () => {
    const r = iark(['--config', project.config, 'import', '--module', 'risk', example('riesgos.csv')]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('aviso: Fila 4 omitida: probability');
    expect(r.stderr).toContain('Importado "riesgos" en el módulo risk: 2 elementos, 1 aviso(s).');
    expect(JSON.parse(r.stdout).risks.map((x: { id: string }) => x.id)).toEqual(['robo-de-claves', 'dependencia-sin-mantener']);
  });

  it('`iark risk top` es un comando del módulo de terceros; su ModuleError (de otra copia del kernel) sale como error de uso, no como «inesperado»', () => {
    const r = iark(['--config', project.config, 'risk', 'top', example('riesgos.json'), '-n', '2']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('# Riesgos activos con más puntos (2 de 3)');
    expect(r.stdout).toContain('- mainframe-fin-de-soporte: El sistema bancario central pierde soporte del fabricante (20, alto)');
    const bad = iark(['--config', project.config, 'risk', 'top', '--stdin'], { input: 'no es json' });
    expect(bad.stderr).toMatch(/^La entrada no es JSON válido/m);
    expect(bad.status).toBe(2);
    expect(bad.stderr).not.toMatch(/inesperado/);
  });

  it('`iark trace` enlaza los riesgos con los elementos C4 por URN', () => {
    const r = iark(['--config', project.config, 'trace', `c4=${resolve('examples/banca.json')}`, `risk=${example('riesgos.json')}`]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('2 documentos, 18 elementos, 4 enlaces');
    expect(r.stdout).toContain('- risk:mainframe-fin-de-soporte (El sistema bancario central pierde soporte del fabricante) → c4:mainframe (Sistema bancario central)');
  });

  it('el módulo por omisión sale de `defaultModule`', () => {
    const dir = configured({ modules: ['../plugin-riesgos/index.mjs'], defaultModule: 'risk' });
    const r = iark(['validate', example('riesgos.json')], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Documento válido (módulo risk)');
  });
});

describe('iark --config: lo que no carga termina el comando con código 2 y nombra el especificador', () => {
  it.each([
    ['un archivo que no existe', { modules: ['./falta.mjs'] }, {}, /«\.\/falta\.mjs»: no existe/],
    ['un paquete que no está instalado', { modules: ['@acme/no-instalado'] }, {}, /«@acme\/no-instalado»: no se encontró el paquete/],
    ['un módulo con la forma inválida', { modules: ['./mal.mjs'] }, { 'mal.mjs': "export default { id: 'Mal', name: 'x' };" }, /«\.\/mal\.mjs»: no cumple el contrato DomainModule[\s\S]*«id» debe ser un identificador en minúsculas/],
    ['un módulo escrito para un contrato mayor', { modules: ['./futuro.mjs'] }, { 'futuro.mjs': literal('futuro', ', contractVersion: 2') }, /«\.\/futuro\.mjs»: .*versión 2 del contrato DomainModule/],
    ['el id de un módulo incorporado', { modules: ['./falso.mjs'] }, { 'falso.mjs': literal('security') }, /«\.\/falso\.mjs»: el id «security» ya lo usa un módulo incorporado/],
    ['el id de un comando del CLI', { modules: ['./serve.mjs'] }, { 'serve.mjs': literal('serve') }, /«\.\/serve\.mjs»: el id «serve» es el de un comando del CLI/],
    ['un archivo que lanza al importarse', { modules: ['./explota.mjs'] }, { 'explota.mjs': "throw new Error('fallo de arranque');" }, /«\.\/explota\.mjs»: fallo de arranque/],
    ['una URL que no es file:', { modules: ['https://example.com/x.mjs'] }, {}, /«https:\/\/example\.com\/x\.mjs»: solo se admiten nombres de paquete, rutas y URL file:/],
    ['un JSON inválido', '{ "modules": [', {}, /no es JSON válido/],
    ['una clave desconocida', { modulos: [] }, {}, /Unrecognized key/],
    ['un defaultModule que no existe', { defaultModule: 'nada' }, {}, /«defaultModule» .* es «nada»/],
  ])('%s', (_nombre, config, files, pattern) => {
    const dir = configured(config, files);
    const r = iark(['modules'], { cwd: dir });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(pattern);
    expect(r.stdout).toBe(''); // no se sigue "sin el plugin"
  });

  it('dos módulos con el mismo id: el segundo falla diciendo cuál lo cargó primero', () => {
    const dir = configured({ modules: ['./a.mjs', './b.mjs'] }, { 'a.mjs': literal('repetido'), 'b.mjs': literal('repetido') });
    const r = iark(['modules'], { cwd: dir });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/«\.\/b\.mjs»: el id «repetido» ya lo usa el módulo de terceros cargado desde «\.\/a\.mjs»/);
  });

  it('un --config que no existe es un error, no se ignora', () => {
    const r = iark(['--config', 'no-existe.json', 'modules']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/No existe el archivo de configuración «.*no-existe\.json» \(--config\)/);
  });

  it('--no-config evita incluso una configuración rota', () => {
    const dir = configured('{ roto');
    expect(iark(['modules', '--no-config'], { cwd: dir }).status).toBe(0);
    expect(iark(['modules'], { cwd: dir, env: { IARK_NO_CONFIG: '1' } }).status).toBe(0);
  });
});

describe('la configuración nunca se carga de un proyecto clonado ni de un espacio de trabajo', () => {
  it('con --from-repo sobre la carpeta que tiene el iark.config.json, no se carga (aunque sea el directorio actual) y se avisa', () => {
    // El caso del repositorio ajeno: quien ejecuta está dentro del clon, que trae un iark.config.json con un plugin.
    const r = iark(['generate', 'un sistema', '--from-repo', '.', '--dry-run', '--module', 'risk']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no se carga «.*iark\.config\.json» porque está dentro de una carpeta que se trata como contenido ajeno/);
    expect(r.stderr).toMatch(/No existe el módulo «risk»/);
    expect(r.stderr).not.toContain('Módulo de terceros cargado');
  });

  it('con --workspace sobre esa carpeta tampoco', () => {
    const r = iark(['project', 'list', '--workspace', '.']);
    expect(r.stderr).toMatch(/no se carga «.*iark\.config\.json» porque está dentro de una carpeta que se trata como contenido ajeno/);
    expect(r.stderr).not.toContain('Módulo de terceros cargado');
    const viaEnv = iark(['project', 'list'], { env: { IARK_WORKSPACE: project.dir } });
    expect(viaEnv.stderr).toMatch(/contenido ajeno/);
  });

  it('el aviso no impide cargarla si se señala a mano con --config', () => {
    const r = iark(['--config', project.config, 'project', 'list', '--workspace', '.']);
    expect(r.stderr).toContain('Módulo de terceros cargado: risk');
  });
});

// ───────────── iark serve --config ─────────────

interface Serving {
  base: string;
  stderr: () => string;
  stop: () => Promise<number | null>;
}

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

/** Arranca `iark serve` en un puerto libre y espera a que escuche. */
function serve(args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Promise<Serving> {
  const child = spawn(process.execPath, [bundle.cli, 'serve', '--port', '0', ...args], {
    cwd: options.cwd ?? project.dir,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, IARK_CONFIG: '', IARK_NO_CONFIG: '', IARK_WORKSPACE: '', IARK_TOKENS: '', ...options.env },
  });
  children.push(child);
  let stderr = '';
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  return new Promise((resolve, reject) => {
    let listening = false;
    const timer = setTimeout(() => reject(new Error(`iark serve no arrancó:\n${stderr}`)), PROCESS_TEST_TIMEOUT - 10_000);
    child.once('exit', (code) => {
      if (listening) return;
      clearTimeout(timer);
      reject(new Error(`iark serve terminó con código ${code}:\n${stderr}`));
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      const match = /escuchando en (http:\/\/\S+)/.exec(stderr);
      if (match && !listening) {
        listening = true;
        clearTimeout(timer);
        resolve({ base: match[1], stderr: () => stderr, stop: () => (child.kill('SIGTERM'), exited) });
      }
    });
  });
}

const post = (base: string, path: string, body: string) => fetch(`${base}${path}`, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
const riesgos = (): string => readFileSync(example('riesgos.json'), 'utf8');

describe('iark serve --config: el módulo de terceros en el servicio (y en su hilo de cálculo)', () => {
  it('sirve /api/modules, el manifiesto de federación y la API del módulo, con el cálculo en un hilo de trabajo que carga el mismo plugin', async () => {
    const server = await serve(['--config', project.config, '--workers', '1']);
    expect(server.stderr()).toContain('Módulo de terceros cargado: risk ← ./plugin-riesgos/index.mjs (contrato 1, documento 1.0)');
    // El servidor avisa de que escucha y, justo después, de lo que sirve: se espera a esas líneas en vez de suponerlas ya escritas.
    await vi.waitFor(() => expect(server.stderr()).toMatch(/módulos de terceros \(.*\): risk/));
    await vi.waitFor(() => expect(server.stderr()).toContain('cálculo: hasta 1 hilo(s) de trabajo'));

    const modules = (await (await fetch(`${server.base}/api/modules`)).json()) as Array<{ id: string; contractVersion: number }>;
    expect(modules.map((m) => m.id)).toEqual([...BUILTIN, 'risk']);
    expect(modules.find((m) => m.id === 'risk')!.contractVersion).toBe(1);

    const manifest = (await (await fetch(`${server.base}/.well-known/iark.json`)).json()) as { schema: string; modules: Array<{ id: string; endpoints?: Record<string, string> }> };
    expect(manifest.schema).toBe('iark.manifest/1');
    const entry = manifest.modules.find((m) => m.id === 'risk')!;
    expect(entry).toMatchObject({ id: 'risk', contractVersion: 1, documentVersion: '1.0', importFormats: ['csv'], exportFormats: ['md'] });
    expect(entry.endpoints).toEqual({ api: '../api/risk', schema: '../api/risk/schema' }); // sin editor web: el sitio no trae los módulos de terceros
    expect(JSON.stringify(manifest)).not.toContain(project.dir);

    // Estas operaciones corren en el hilo de trabajo, que construye su propio registro: sin el plugin responderían 404.
    const validated = await post(server.base, '/api/risk/validate', riesgos());
    expect(validated.status).toBe(200);
    const result = (await validated.json()) as { valid: boolean; issues: Array<{ severity: string; message: string }> };
    expect(result.valid).toBe(true);
    expect(result.issues.map((i) => i.message)).toContain('El riesgo alto «Robo de sesiones de la aplicación web» (16 puntos) no tiene mitigación.');

    const exported = await post(server.base, '/api/risk/export?format=md', riesgos());
    expect(exported.status).toBe(200);
    expect(await exported.text()).toMatch(/^# Riesgos de la banca en línea/);

    const imported = await post(server.base, '/api/risk/import?importer=csv', readFileSync(example('riesgos.csv'), 'utf8'));
    expect(imported.status).toBe(200);
    expect(((await imported.json()) as { document: { risks: unknown[] } }).document.risks).toHaveLength(2);

    const ran = await post(server.base, '/api/risk/run/top', JSON.stringify({ input: riesgos(), options: { limit: '1' } }));
    expect(ran.status).toBe(200);
    expect(((await ran.json()) as { output: string }).output).toContain('mainframe-fin-de-soporte');

    // La trazabilidad entre módulos (también en el hilo de trabajo) enlaza los riesgos con los elementos C4 por URN.
    const traced = await post(
      server.base,
      '/api/trace',
      JSON.stringify({
        documents: [
          { module: 'c4', document: JSON.parse(readFileSync(resolve('examples/banca.json'), 'utf8')) },
          { module: 'risk', document: JSON.parse(riesgos()) },
        ],
      }),
    );
    expect(traced.status).toBe(200);
    expect(JSON.stringify(await traced.json())).toContain('urn:iark:risk:mainframe-fin-de-soporte');

    const schema = await fetch(`${server.base}/api/risk/schema`);
    expect(schema.status).toBe(200);
    expect(((await schema.json()) as { properties: Record<string, unknown> }).properties).toHaveProperty('risks');

    // y los incorporados siguen funcionando en el mismo servicio y en el mismo hilo
    const security = await post(server.base, '/api/security/validate', readFileSync('examples/seguridad-ejemplo.json', 'utf8'));
    expect(security.status).toBe(200);
    expect(await server.stop()).toBe(0);
  });

  it('IARK_CONFIG y el iark.config.json del directorio actual funcionan igual que --config; sin ninguno, el módulo no existe (404)', async () => {
    const viaEnv = await serve([], { cwd: configured({ modules: [] }), env: { IARK_CONFIG: project.config } });
    expect(((await (await fetch(`${viaEnv.base}/api/modules`)).json()) as Array<{ id: string }>).map((m) => m.id)).toContain('risk');
    expect((await post(viaEnv.base, '/api/risk/validate', riesgos())).status).toBe(200);
    await viaEnv.stop();

    const viaCwd = await serve([]);
    expect((await post(viaCwd.base, '/api/risk/validate', riesgos())).status).toBe(200);
    await viaCwd.stop();

    const none = await serve(['--no-config']);
    expect((await post(none.base, '/api/risk/validate', riesgos())).status).toBe(404);
    expect(((await (await fetch(`${none.base}/api/modules`)).json()) as unknown[]).length).toBe(6);
    await none.stop();
  });

  it('con --workers 0 (el cálculo en el hilo principal) también funciona', async () => {
    const server = await serve(['--config', project.config, '--workers', '0']);
    expect((await post(server.base, '/api/risk/validate', riesgos())).status).toBe(200);
    await server.stop();
  });

  it('la autenticación y los límites del servicio valen también para el módulo de terceros', async () => {
    const tokens = join(configured({}), 'tokens.json');
    const { token } = createToken(tokens, { name: 'Vic', role: 'viewer' });
    const server = await serve(['--config', project.config, '--tokens', tokens]);
    expect((await post(server.base, '/api/risk/validate', riesgos())).status).toBe(401); // las rutas de cálculo exigen credencial
    const ok = await fetch(`${server.base}/api/risk/validate`, { method: 'POST', body: riesgos(), headers: { Authorization: `Bearer ${token}` } });
    expect(ok.status).toBe(200);
    expect((await fetch(`${server.base}/api/modules`)).status).toBe(200); // público, como siempre
    await server.stop();
  });

  it('con --workspace sobre la carpeta que tiene el iark.config.json, el servicio NO carga el plugin', async () => {
    const server = await serve(['--workspace', '.']);
    expect(server.stderr()).toMatch(/no se carga «.*iark\.config\.json» porque está dentro de una carpeta que se trata como contenido ajeno/);
    expect(((await (await fetch(`${server.base}/api/modules`)).json()) as Array<{ id: string }>).map((m) => m.id)).toEqual(BUILTIN);
    expect((await post(server.base, '/api/risk/validate', riesgos())).status).toBe(404);
    await server.stop();
  });

  it('un plugin que no carga impide arrancar el servicio (código 2) y dice cuál', () => {
    const dir = configured({ modules: ['./falta.mjs'] });
    const r = spawnSync(process.execPath, [bundle.cli, 'serve', '--port', '0'], { cwd: dir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, IARK_CONFIG: '', IARK_NO_CONFIG: '' } });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/«\.\/falta\.mjs»: no existe/);
  });
});
