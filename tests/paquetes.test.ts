import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPackages, manifestProblems, packageEntries, publishManifest, rootVersion, type PackageInfo } from '../scripts/packages';

/**
 * Los paquetes publicables (`@iark/kernel`, `@iark/domain-*`). Aquí se comprueba, sin compilar nada, que cada `package.json` está bien
 * declarado y que el de publicación se deriva de él. La compilación, el empaquetado y la instalación limpia las hace
 * `npm run packages:check` (más pesado y con red: va en su propio job de CI).
 */

const packages = loadPackages();
const names = new Set(packages.map((pkg) => pkg.manifest.name));
const version = rootVersion();

const clone = (pkg: PackageInfo): PackageInfo => ({ ...pkg, manifest: structuredClone(pkg.manifest) });

describe('paquetes publicables', () => {
  it('son el kernel y los seis dominios, con el kernel primero (los demás dependen de él)', () => {
    expect(packages.map((p) => p.manifest.name)).toEqual([
      '@iark/kernel',
      '@iark/domain-c4',
      '@iark/domain-data',
      '@iark/domain-enterprise',
      '@iark/domain-integration',
      '@iark/domain-platform',
      '@iark/domain-security',
    ]);
  });

  it.each(packages.map((pkg) => [pkg.manifest.name, pkg] as const))('%s está bien declarado para publicarse', (_name, pkg) => {
    expect(manifestProblems(pkg, version, names)).toEqual([]);
  });

  it('todos comparten la versión de la raíz', () => {
    expect(new Set(packages.map((p) => p.manifest.version))).toEqual(new Set([version]));
  });

  it('el desarrollo no cambia: `exports` sigue apuntando a src/*.ts (vite, vitest, tsx y tsc lo consumen así)', () => {
    for (const pkg of packages) {
      for (const target of Object.values(pkg.manifest.exports ?? {})) expect(target, pkg.manifest.name).toMatch(/^\.\/src\/.+\.ts$/);
    }
  });

  it('el package.json de desarrollo rechaza `npm publish` y `npm pack` (prepack falla)', () => {
    for (const pkg of packages) expect(pkg.manifest.scripts?.prepack, pkg.manifest.name).toContain('process.exit(1)');
  });

  it('cada entrada pública se compila: nombre de salida → archivo fuente que existe', () => {
    for (const pkg of packages) {
      const entries = packageEntries(pkg);
      expect(Object.keys(entries).length, pkg.manifest.name).toBe(Object.keys(pkg.manifest.exports ?? {}).length);
      for (const source of Object.values(entries)) expect(() => readFileSync(source, 'utf8'), source).not.toThrow();
    }
  });

  it('el package.json de publicación lleva exports hacia dist, las dependencias @iark/* en la versión real y nada de desarrollo', () => {
    for (const pkg of packages) {
      const published = publishManifest(pkg.manifest, version) as {
        exports: Record<string, { types: string; default: string }>;
        dependencies: Record<string, string>;
        files: string[];
        scripts?: unknown;
        private?: unknown;
        publishConfig: { access: string };
      };
      for (const target of Object.values(published.exports)) {
        expect(target.default, pkg.manifest.name).toMatch(/^\.\/dist\/.+\.js$/);
        expect(target.types, pkg.manifest.name).toMatch(/^\.\/dist\/.+\.d\.ts$/);
      }
      for (const [dep, range] of Object.entries(published.dependencies)) {
        if (dep.startsWith('@iark/')) expect(range, `${pkg.manifest.name} → ${dep}`).toBe(`^${version}`);
      }
      expect(published.scripts).toBeUndefined();
      expect(published.private).toBeUndefined();
      expect(published.files).toEqual(['dist', 'README.md', 'LICENSE']);
      expect(published.publishConfig).toEqual({ access: 'public' });
    }
  });

  it('el kernel no depende de otro paquete del monorepo (es la base) y los dominios solo del kernel', () => {
    for (const pkg of packages) {
      const internal = Object.keys(pkg.manifest.dependencies ?? {}).filter((dep) => dep.startsWith('@iark/'));
      expect(internal, pkg.manifest.name).toEqual(pkg.folder === 'kernel' ? [] : ['@iark/kernel']);
    }
  });
});

describe('manifestProblems detecta un paquete mal declarado', () => {
  const kernel = packages[0];

  it('versión distinta de la raíz', () => {
    const pkg = clone(kernel);
    pkg.manifest.version = '9.9.9';
    expect(manifestProblems(pkg, version, names).join('\n')).toMatch(/comparten versión/);
  });

  it('private, sin licencia o sin acceso público', () => {
    const pkg = clone(kernel);
    pkg.manifest.private = true;
    delete pkg.manifest.license;
    delete pkg.manifest.publishConfig!.access;
    const text = manifestProblems(pkg, version, names).join('\n');
    expect(text).toMatch(/no debe ser private/);
    expect(text).toMatch(/license debe ser MIT/);
    expect(text).toMatch(/publishConfig\.access debe ser public/);
  });

  it('sin el rechazo de publicar el package.json de desarrollo', () => {
    const pkg = clone(kernel);
    delete pkg.manifest.scripts;
    expect(manifestProblems(pkg, version, names).join('\n')).toMatch(/prepack/);
  });

  it('una entrada de desarrollo sin su equivalente de publicación, y al revés', () => {
    const pkg = clone(kernel);
    pkg.manifest.exports = { ...pkg.manifest.exports, './nuevo': './src/nuevo.ts' };
    pkg.manifest.publishConfig!.exports = { ...pkg.manifest.publishConfig!.exports, './otro': { types: './dist/otro.d.ts', default: './dist/otro.js' } };
    const text = manifestProblems(pkg, version, names).join('\n');
    expect(text).toMatch(/publishConfig\.exports\[\.\/nuevo\] debe declarar types/);
    expect(text).toMatch(/publishConfig\.exports\[\.\/otro\] no existe en exports/);
  });

  it('un exports de desarrollo que no apunta a src/*.ts', () => {
    const pkg = clone(kernel);
    pkg.manifest.exports = { '.': './dist/index.js' };
    expect(manifestProblems(pkg, version, names).join('\n')).toMatch(/debe apuntar a un \.ts de src/);
  });

  it('una dependencia @iark/* que no es del monorepo', () => {
    const pkg = clone(packages[1]);
    pkg.manifest.dependencies = { ...pkg.manifest.dependencies, '@iark/fantasma': '*' };
    expect(manifestProblems(pkg, version, names).join('\n')).toMatch(/@iark\/fantasma, que no es un paquete del monorepo/);
  });
});

describe('flujos de CI de los paquetes', () => {
  const read = (path: string): string => readFileSync(resolve(path), 'utf8');

  it('la publicación en npm es solo manual (workflow_dispatch) y por omisión es una simulación', () => {
    const release = read('.github/workflows/release-packages.yml');
    const triggers = /^on:\n([\s\S]*?)\n\S/m.exec(release)?.[1] ?? '';
    expect(triggers).toMatch(/^ {2}workflow_dispatch:/m);
    expect(triggers).not.toMatch(/^ {2}(push|pull_request|pull_request_target|release|schedule|workflow_run):/m);
    expect(release).toMatch(/dry-run:[\s\S]*?default: true/);
    expect(release).toContain('npm publish "$dir" --dry-run');
    expect(release).toMatch(/--provenance --access public/);
  });

  it('el job `packages` es informativo: no está en el `needs` de `publish`', () => {
    const deploy = read('.github/workflows/deploy-pages.yml');
    expect(deploy).toMatch(/^ {2}packages:/m);
    expect(deploy).toMatch(/^ {4}needs: \[build, test\]$/m);
    expect(deploy).not.toMatch(/needs:.*packages/);
  });
});
