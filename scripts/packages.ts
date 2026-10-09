import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';

/**
 * Paquetes publicables (`@iark/kernel` y `@iark/domain-*`).
 *
 *   npm run packages:build   prepara cada paquete en dist-packages/<carpeta>/ (JS ESM + .d.ts + package.json de publicación)
 *   npm run packages:check   los empaqueta (npm pack), los instala en una carpeta temporal limpia y comprueba que funcionan solos
 *
 * Por qué hay un directorio de preparación y no se publica `packages/<x>` directamente: en el repositorio, el `exports` de cada
 * `package.json` apunta a `src/*.ts` (vite, vitest, tsx y los alias de tsconfig consumen el código fuente; empaquetar o compilar
 * antes de cada prueba lo haría inviable). Un paquete publicado necesita `exports` hacia JavaScript compilado, y Node no carga
 * TypeScript. En lugar de una condición de `exports` propia (que vite, vitest y tsx tendrían que conocer, y cuyo fallo solo se vería
 * en una ejecución real) cada `package.json` declara las dos cosas —`exports` para desarrollo y `publishConfig.exports` para
 * producción, como hace pnpm— y este script genera el `package.json` de publicación desde ellas. El desarrollo no cambia en nada.
 * Los `package.json` fuente rechazan `npm publish` y `npm pack` (script `prepack`) para que nadie publique por error el de desarrollo.
 */

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** Dónde se prepara cada paquete publicable (ignorado por git). */
export const STAGE_DIR = join(ROOT, 'dist-packages');

const REPOSITORY_URL = 'git+https://github.com/juliancardonagaleano/iark-diagrams.git';

type Json = Record<string, unknown>;

export interface SourceManifest {
  name: string;
  version: string;
  description?: string;
  private?: boolean;
  type?: string;
  license?: string;
  repository?: { type?: string; url?: string; directory?: string };
  homepage?: string;
  bugs?: { url?: string };
  keywords?: string[];
  files?: string[];
  scripts?: Record<string, string>;
  exports?: Record<string, string>;
  publishConfig?: { access?: string; exports?: Record<string, { types?: string; default?: string }> };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export interface PackageInfo {
  /** Carpeta bajo `packages/` (`kernel`, `domain-c4`…). */
  folder: string;
  /** Ruta absoluta de `packages/<carpeta>`. */
  dir: string;
  manifest: SourceManifest;
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

/** Los paquetes del monorepo: el kernel primero (los demás dependen de él) y el resto por orden alfabético. */
export function loadPackages(root = ROOT): PackageInfo[] {
  const packagesDir = join(root, 'packages');
  return readdirSync(packagesDir)
    .filter((folder) => existsSync(join(packagesDir, folder, 'package.json')))
    .sort((a, b) => (a === 'kernel' ? -1 : b === 'kernel' ? 1 : a.localeCompare(b)))
    .map((folder) => ({ folder, dir: join(packagesDir, folder), manifest: readJson<SourceManifest>(join(packagesDir, folder, 'package.json')) }));
}

export function rootVersion(root = ROOT): string {
  return readJson<{ version: string }>(join(root, 'package.json')).version;
}

/** Entradas de compilación de un paquete: nombre de salida (`index`, `endpoint`) → archivo fuente, según `exports` y `publishConfig.exports`. */
export function packageEntries(pkg: PackageInfo): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const [subpath, source] of Object.entries(pkg.manifest.exports ?? {})) {
    const target = pkg.manifest.publishConfig?.exports?.[subpath]?.default;
    const name = target && /^\.\/dist\/(.+)\.js$/.exec(target)?.[1];
    if (name) entries[name] = join(pkg.dir, source);
  }
  return entries;
}

/**
 * Lo que debe cumplir el `package.json` fuente de un paquete publicable. Devuelve los problemas (vacío si está bien); lo usan
 * `packages:build`, que se niega a preparar un paquete mal declarado, y una prueba.
 */
export function manifestProblems(pkg: PackageInfo, version: string, names: ReadonlySet<string>): string[] {
  const { manifest } = pkg;
  const problems: string[] = [];
  const need = (ok: boolean, message: string): void => {
    if (!ok) problems.push(`${manifest.name}: ${message}`);
  };
  need(/^@iark\/[a-z0-9-]+$/.test(manifest.name), 'el nombre debe ser @iark/<nombre>');
  need(manifest.version === version, `la versión es ${manifest.version} y la de la raíz ${version}: los paquetes comparten versión`);
  need(manifest.private !== true, 'no debe ser private');
  need(manifest.license === 'MIT', 'license debe ser MIT');
  need(manifest.type === 'module', 'type debe ser module');
  need(typeof manifest.description === 'string' && manifest.description !== '', 'falta description');
  need(manifest.repository?.url === REPOSITORY_URL && manifest.repository.directory === `packages/${pkg.folder}`, `repository debe apuntar a ${REPOSITORY_URL} con directory packages/${pkg.folder}`);
  need(manifest.publishConfig?.access === 'public', 'publishConfig.access debe ser public (un paquete con ámbito es privado por omisión)');
  need((manifest.files ?? []).includes('dist'), 'files debe incluir dist');
  need(typeof manifest.scripts?.prepack === 'string', 'falta el script prepack que rechaza publicar el package.json de desarrollo');
  const dev = Object.keys(manifest.exports ?? {});
  need(dev.length > 0, 'falta exports (desarrollo)');
  for (const subpath of dev) {
    need(/^\.\/src\/.+\.ts$/.test(manifest.exports![subpath]), `exports[${subpath}] (desarrollo) debe apuntar a un .ts de src`);
    const prod = manifest.publishConfig?.exports?.[subpath];
    need(!!prod && /^\.\/dist\/.+\.d\.ts$/.test(prod.types ?? '') && /^\.\/dist\/.+\.js$/.test(prod.default ?? ''), `publishConfig.exports[${subpath}] debe declarar types (./dist/….d.ts) y default (./dist/….js)`);
  }
  for (const subpath of Object.keys(manifest.publishConfig?.exports ?? {})) need(dev.includes(subpath), `publishConfig.exports[${subpath}] no existe en exports`);
  for (const dep of Object.keys(manifest.dependencies ?? {})) {
    if (dep.startsWith('@iark/')) need(names.has(dep), `depende de ${dep}, que no es un paquete del monorepo`);
  }
  return problems;
}

/** El `package.json` que se publica: el fuente con `exports` de producción, sin lo de desarrollo y con las dependencias `@iark/*` en la versión real (no `*`). */
export function publishManifest(manifest: SourceManifest, version: string): Json {
  const dependencies = Object.fromEntries(Object.entries(manifest.dependencies ?? {}).map(([name, range]) => [name, name.startsWith('@iark/') ? `^${version}` : range]));
  return {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    license: manifest.license,
    repository: manifest.repository,
    homepage: manifest.homepage,
    bugs: manifest.bugs,
    keywords: manifest.keywords,
    type: manifest.type,
    exports: manifest.publishConfig?.exports,
    files: ['dist', 'README.md', 'LICENSE'],
    dependencies,
    ...(manifest.peerDependencies ? { peerDependencies: manifest.peerDependencies } : {}),
    publishConfig: { access: manifest.publishConfig?.access },
  };
}

function readmeFor(manifest: SourceManifest): string {
  return [
    `# ${manifest.name}`,
    '',
    manifest.description ?? '',
    '',
    'Parte de [DIAgrams](https://github.com/juliancardonagaleano/iark-diagrams): arquitectura como datos (C4, integración, datos, empresarial, plataforma y seguridad) con documentos JSON versionables, autolayout, exportación y CLI.',
    '',
    '```bash',
    `npm install ${manifest.name}`,
    '```',
    '',
    'Es un paquete ESM (`import`) con tipos incluidos. Escribir un módulo propio y cargarlo en el CLI sin tocar el repositorio: [docs/plugins.md](https://github.com/juliancardonagaleano/iark-diagrams/blob/master/docs/plugins.md).',
    '',
  ].join('\n');
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface BuildOptions {
  /** Dónde se deja el paquete preparado. Por omisión, `dist-packages/<carpeta>`. */
  outDir?: string;
  /** Genera también los `.d.ts` (lento: el compilador de TypeScript recorre el paquete). Por omisión sí. */
  dts?: boolean;
}

/** Compila un paquete (JS ESM y, si se pide, `.d.ts`) y escribe su `package.json` de publicación, README y LICENSE en `outDir`. */
export async function buildPackage(pkg: PackageInfo, options: BuildOptions = {}): Promise<string> {
  const outDir = options.outDir ?? join(STAGE_DIR, pkg.folder);
  const version = rootVersion();
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  // Lo que el paquete declara como dependencia (incluidos los `@iark/*`) se queda como `import` externo: no se incrusta.
  const declared = [...Object.keys(pkg.manifest.dependencies ?? {}), ...Object.keys(pkg.manifest.peerDependencies ?? {})];
  await build({
    config: false,
    entry: packageEntries(pkg),
    outDir: join(outDir, 'dist'),
    format: ['esm'],
    dts: options.dts ?? true,
    sourcemap: false,
    splitting: true,
    clean: true,
    platform: 'neutral',
    target: 'es2022',
    tsconfig: join(ROOT, 'tsconfig.node.json'),
    external: declared.map((name) => new RegExp(`^${escapeRegExp(name)}(/|$)`)),
    silent: true,
  });
  writeFileSync(join(outDir, 'package.json'), `${JSON.stringify(publishManifest(pkg.manifest, version), null, 2)}\n`);
  writeFileSync(join(outDir, 'README.md'), readmeFor(pkg.manifest));
  copyFileSync(join(ROOT, 'LICENSE'), join(outDir, 'LICENSE'));
  return outDir;
}

/** Comprueba la declaración de todos los paquetes y prepara cada uno en `dist-packages/`. */
export async function buildAll(options: { dts?: boolean } = {}): Promise<string[]> {
  const packages = loadPackages();
  const names = new Set(packages.map((p) => p.manifest.name));
  const problems = packages.flatMap((pkg) => manifestProblems(pkg, rootVersion(), names));
  if (problems.length > 0) throw new Error(`Los paquetes no están listos para publicarse:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  rmSync(STAGE_DIR, { recursive: true, force: true });
  const dirs: string[] = [];
  for (const pkg of packages) {
    console.log(`Preparando ${pkg.manifest.name}…`);
    dirs.push(await buildPackage(pkg, options));
  }
  return dirs;
}

// ───────────── packages:check ─────────────

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  try {
    return execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' && command === npm });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message: string };
    throw new Error(`Falló «${[command === process.execPath ? 'node' : command, ...args].join(' ')}» en ${cwd}:\n${failure.stdout ?? ''}${failure.stderr ?? failure.message}`);
  }
}

/** Qué debe exportar cada paquete instalado (comprobación de humo de `import`). */
export const EXPECTED_EXPORTS: Record<string, string[]> = {
  '@iark/kernel': ['ModuleRegistry', 'defineModule', 'assertModuleShape', 'CONTRACT_VERSION', 'buildManifest', 'ModuleError'],
  '@iark/kernel/protocol': ['EMBED_PROTOCOL_VERSION', 'negotiateProtocol'],
  '@iark/kernel/endpoint': ['resolveEndpointUrl'],
  '@iark/domain-c4': ['c4Module'],
  '@iark/domain-integration': ['integrationModule'],
  '@iark/domain-data': ['dataModule'],
  '@iark/domain-enterprise': ['enterpriseModule'],
  '@iark/domain-platform': ['platformModule'],
  '@iark/domain-security': ['securityModule'],
};

async function importCheck(consumer: string): Promise<void> {
  const lines = Object.entries(EXPECTED_EXPORTS).map(
    ([specifier, names]) => `{ const m = await import(${JSON.stringify(specifier)}); for (const name of ${JSON.stringify(names)}) if (!(name in m)) throw new Error('${specifier} no exporta ' + name); }`,
  );
  // Todos los módulos juntos en un registro: cada uno cumple el contrato y comparten la MISMA copia del kernel (no hay copias incrustadas).
  lines.push(
    `const { ModuleRegistry, CONTRACT_VERSION } = await import('@iark/kernel');`,
    `const registry = new ModuleRegistry();`,
    ...Object.entries({ '@iark/domain-c4': 'c4Module', '@iark/domain-integration': 'integrationModule', '@iark/domain-data': 'dataModule', '@iark/domain-enterprise': 'enterpriseModule', '@iark/domain-platform': 'platformModule', '@iark/domain-security': 'securityModule' }).map(
      ([specifier, name]) => `registry.register((await import('${specifier}')).${name});`,
    ),
    `if (registry.ids().length !== 6) throw new Error('faltan módulos en el registro');`,
    `for (const module of registry.list()) if (module.contractVersion !== CONTRACT_VERSION) throw new Error('contrato distinto en ' + module.id);`,
    `console.log(registry.ids().join(','));`,
  );
  const output = run(process.execPath, ['--input-type=module', '-e', lines.join('\n')], consumer);
  console.log(`  import de los ${Object.keys(EXPECTED_EXPORTS).length} puntos de entrada y registro con los 6 módulos: ${output.trim()}`);
}

function typesCheck(consumer: string): void {
  mkdirSync(join(consumer, 'tipos'), { recursive: true });
  writeFileSync(
    join(consumer, 'tipos', 'uso.ts'),
    [
      `import { ModuleRegistry, defineModule, type DomainModule } from '@iark/kernel';`,
      `import { negotiateProtocol } from '@iark/kernel/protocol';`,
      `import { c4Module } from '@iark/domain-c4';`,
      `import { integrationModule } from '@iark/domain-integration';`,
      `import { dataModule } from '@iark/domain-data';`,
      `import { enterpriseModule } from '@iark/domain-enterprise';`,
      `import { platformModule } from '@iark/domain-platform';`,
      `import { securityModule } from '@iark/domain-security';`,
      `import { z } from 'zod';`,
      ``,
      `const schema = z.object({ n: z.number() });`,
      `const propio: DomainModule<{ n: number }> = defineModule({ id: 'propio', name: 'Propio', version: '1.0.0', documentVersion: '1.0', schema, jsonSchema: () => ({}), validate: () => [], importers: [], exporters: [] });`,
      `export const registry: ModuleRegistry = new ModuleRegistry().register(c4Module).register(integrationModule).register(dataModule).register(enterpriseModule).register(platformModule).register(securityModule).register(propio);`,
      `export const protocolo: ReturnType<typeof negotiateProtocol> = negotiateProtocol('1.0', '1.0');`,
      ``,
    ].join('\n'),
  );
  writeFileSync(
    join(consumer, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', lib: ['ES2022'], strict: true, noEmit: true, types: [], skipLibCheck: true }, include: ['tipos/uso.ts'] }, null, 2),
  );
  run(process.execPath, [join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', join(consumer, 'tsconfig.json')], consumer);
  console.log('  los tipos (.d.ts) de los 7 paquetes resuelven y un módulo propio con defineModule compila (TypeScript, NodeNext)');
}

/** Arranca `iark serve` con la configuración y comprueba la API del módulo de terceros (el cálculo corre en un hilo de trabajo que carga el mismo plugin). */
async function serveCheck(cli: string, config: string, consumer: string): Promise<void> {
  const child = spawn(process.execPath, [cli, 'serve', '--config', config, '--port', '0'], { cwd: consumer, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  try {
    const base = await new Promise<string>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`iark serve no arrancó en 60 s:\n${stderr}`)), 60_000);
      child.once('exit', (code) => fail(new Error(`iark serve terminó con código ${code}:\n${stderr}`)));
      child.stderr!.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        const match = /escuchando en (http:\/\/\S+)/.exec(stderr);
        if (match) (clearTimeout(timer), done(match[1]));
      });
    });
    const modules = (await (await fetch(`${base}/api/modules`)).json()) as Array<{ id: string }>;
    if (!modules.some((m) => m.id === 'risk')) throw new Error(`/api/modules no lista «risk»: ${JSON.stringify(modules.map((m) => m.id))}`);
    const document = readFileSync(join(consumer, 'plugin-riesgos', 'riesgos.json'), 'utf8');
    const response = await fetch(`${base}/api/risk/validate`, { method: 'POST', body: document });
    const result = (await response.json()) as { valid?: boolean };
    if (response.status !== 200 || result.valid !== true) throw new Error(`POST /api/risk/validate respondió ${response.status}: ${JSON.stringify(result)}`);
    console.log('  iark serve --config sirve /api/modules y POST /api/risk/validate (en un hilo de trabajo) con el plugin');
  } finally {
    child.kill('SIGTERM');
    await exited;
  }
}

/**
 * Empaqueta los siete paquetes y la raíz (`npm pack`), los instala en una carpeta temporal limpia (solo los tarballs y lo que estos
 * declaran como dependencias: nada del repositorio) y comprueba que se pueden importar, que sus tipos resuelven y que el módulo de
 * terceros de ejemplo carga con `iark --config` y se sirve con `iark serve --config`.
 */
export async function checkPackages(options: { keep?: boolean } = {}): Promise<void> {
  console.log('Compilando la raíz (dist/cli, el CLI que se instalará)…');
  run(npm, ['run', 'build:lib'], ROOT);
  const dirs = await buildAll();
  const work = mkdtempSync(join(tmpdir(), 'iark-packages-'));
  try {
    const tarballs = join(work, 'tarballs');
    const consumer = join(work, 'consumer');
    mkdirSync(tarballs, { recursive: true });
    mkdirSync(consumer, { recursive: true });
    console.log('Empaquetando (npm pack)…');
    const packed: string[] = [];
    for (const dir of [...dirs, ROOT]) {
      const [info] = JSON.parse(run(npm, ['pack', dir, '--pack-destination', tarballs, '--json', '--ignore-scripts'], work)) as Array<{ filename: string; files: Array<{ path: string }> }>;
      packed.push(join(tarballs, info.filename));
      if (dir !== ROOT && !info.files.some((f) => f.path === 'dist/index.js')) throw new Error(`${info.filename} no trae dist/index.js`);
      if (dir !== ROOT && info.files.some((f) => f.path.startsWith('src/'))) throw new Error(`${info.filename} trae código fuente (src/)`);
    }
    console.log(`  ${packed.length} tarballs: ${packed.map((p) => relative(tarballs, p)).join(', ')}`);

    console.log('Instalando en una carpeta limpia…');
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'consumidor-de-prueba', private: true, type: 'module' }, null, 2));
    run(npm, ['install', '--no-audit', '--no-fund', '--loglevel=error', '--prefer-offline', ...packed, 'zod@^4.3.3'], consumer);

    console.log('Comprobando…');
    await importCheck(consumer);
    typesCheck(consumer);

    // El módulo de ejemplo se copia SIN su node_modules: resuelve @iark/kernel y zod desde lo instalado en el consumidor.
    cpSync(join(ROOT, 'examples', 'plugin-riesgos'), join(consumer, 'plugin-riesgos'), { recursive: true, filter: (source) => !source.includes('node_modules') });
    const cli = join(consumer, 'node_modules', 'iark-diagrams', 'dist', 'cli', 'index.js');
    const config = join(consumer, 'plugin-riesgos', 'iark.config.json');
    const iark = (...args: string[]): string => run(process.execPath, [cli, '--config', config, ...args], join(consumer, 'plugin-riesgos'));
    const modules = iark('modules');
    if (!/^risk {2}Registro de riesgos {2}v1\.0\.0$/m.test(modules) || !modules.includes('origen: ./index.mjs')) throw new Error(`iark modules no lista el plugin:\n${modules}`);
    const markdown = iark('convert', '--module', 'risk', 'riesgos.json', '--to', 'md');
    if (!markdown.includes('# Riesgos de la banca en línea')) throw new Error(`la exportación a Markdown del plugin no es la esperada:\n${markdown}`);
    if (!iark('validate', '--module', 'risk', 'riesgos.json').includes('Documento válido (módulo risk)')) throw new Error('iark validate --module risk no valida el documento de ejemplo');
    console.log('  iark --config carga el módulo de ejemplo (con @iark/kernel y zod de los tarballs) y valida y exporta con él');
    await serveCheck(cli, config, consumer);
    console.log('\nLos paquetes se instalan y funcionan sin el repositorio.');
  } finally {
    if (options.keep) console.log(`\n(se conserva ${work})`);
    else rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...flags] = process.argv.slice(2);
  const main = async (): Promise<void> => {
    if (command === 'build') {
      const dirs = await buildAll();
      console.log(`\nPreparados ${dirs.length} paquetes en ${relative(ROOT, STAGE_DIR)}/ (se publican con \`npm publish ./dist-packages/<carpeta>\`; ver .github/workflows/release-packages.yml).`);
    } else if (command === 'check') {
      await checkPackages({ keep: flags.includes('--keep') });
    } else {
      throw new Error('Uso: tsx scripts/packages.ts build | check [--keep]');
    }
  };
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
