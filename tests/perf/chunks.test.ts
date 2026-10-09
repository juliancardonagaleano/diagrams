import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeBuild, checkLimits, chunkBaseName, htmlScripts, staticClosure, staticImports, type ChunkLimits } from '../../scripts/perf/chunks';

/**
 * El análisis de la compilación (`scripts/perf/chunks.ts`) que fija el tamaño de los trozos: aquí se prueba con una compilación
 * de mentira (la forma que deja Vite: `assets/<nombre>-<hash>.js`, importaciones estáticas con `from"./x.js"` y dinámicas con
 * `import("./x.js")`), para que la comprobación sobre `dist/app` real (`tests/e2e/tamano-trozos.spec.ts`) no dependa de adivinar.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeBuild(files: Record<string, string | number>, pages: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'iark-chunks-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'assets'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, 'assets', name), typeof content === 'number' ? `/*${'x'.repeat(content)}*/` : content);
  for (const [name, scripts] of Object.entries(pages)) {
    writeFileSync(join(dir, name), `<!doctype html><html><head><script type="module" crossorigin src="/assets/${scripts}"></script></head><body></body></html>`);
  }
  return dir;
}

describe('lectura de los trozos', () => {
  it('chunkBaseName quita el hash final de Vite', () => {
    expect(chunkBaseName('domain-c4-N8I54U48.js')).toBe('domain-c4');
    expect(chunkBaseName('elk-276RUBZZ-DWITELAW.js')).toBe('elk-276RUBZZ');
    expect(chunkBaseName('zod-C3StKava.js')).toBe('zod');
    expect(chunkBaseName('main-Bdh1fDza.js')).toBe('main');
  });

  it('staticImports ve las importaciones estáticas y no las dinámicas', () => {
    const code = 'import{a as e}from"./uno-AAAA1111.js";import"./dos-BBBB2222.js";export*from"./tres-CCCC3333.js";const x=()=>import("./lazy-DDDD4444.js");';
    expect(staticImports(code).sort()).toEqual(['dos-BBBB2222.js', 'tres-CCCC3333.js', 'uno-AAAA1111.js']);
  });

  it('htmlScripts recoge el script de la página y los modulepreload', () => {
    const html = '<script type="module" src="/repo/assets/main-AAAA1111.js"></script><link rel="modulepreload" href="/repo/assets/zod-BBBB2222.js"><link rel="stylesheet" href="/repo/assets/main-CCCC3333.css">';
    expect(htmlScripts(html).sort()).toEqual(['main-AAAA1111.js', 'zod-BBBB2222.js']);
  });

  it('staticClosure sigue las importaciones estáticas, sin repetir y sin salir de lo que existe', () => {
    const sources = new Map([
      ['a.js', 'import{x}from"./b.js";import("./lazy.js")'],
      ['b.js', 'import"./a.js";import"./c.js"'],
      ['c.js', 'import"./no-existe.js"'],
      ['lazy.js', ''],
    ]);
    expect(staticClosure('a.js', sources).sort()).toEqual(['a.js', 'b.js', 'c.js']);
  });
});

describe('analyzeBuild y checkLimits', () => {
  const build = (): string =>
    fakeBuild(
      {
        'main-AAAA1111.js': 'import{z}from"./vendor-BBBB2222.js";const m=()=>import("./lazy-CCCC3333.js");' + '/*x*/'.repeat(10),
        'vendor-BBBB2222.js': 3000,
        'lazy-CCCC3333.js': 9000,
        'suite-DDDD4444.js': 'import"./vendor-BBBB2222.js";',
      },
      { 'index.html': 'main-AAAA1111.js', 'suite.html': 'suite-DDDD4444.js' },
    );

  it('mide cada trozo y la carga inicial de cada página (lo estático, no lo perezoso)', () => {
    const analysis = analyzeBuild(build());
    const byName = new Map(analysis.chunks.map((c) => [chunkBaseName(c.name), c]));
    expect(byName.get('lazy')!.initialFor).toEqual([]);
    expect(byName.get('vendor')!.initialFor.sort()).toEqual(['index.html', 'suite.html']);
    expect(byName.get('main')!.initialFor).toEqual(['index.html']);
    const index = analysis.pages.find((p) => p.html === 'index.html')!;
    expect(index.files.map((f) => chunkBaseName(f.name)).sort()).toEqual(['main', 'vendor']);
    expect(index.bytes).toBe(byName.get('main')!.bytes + byName.get('vendor')!.bytes);
    expect(analysis.chunks[0].name).toBe('lazy-CCCC3333.js'); // ordenados de mayor a menor
    expect(byName.get('vendor')!.gzipBytes).toBeLessThan(byName.get('vendor')!.bytes);
  });

  const limits: ChunkLimits = { maxChunkBytes: 5000, exceptions: {}, maxInitialBytes: { 'index.html': 4000 } };

  it('señala el trozo que pasa del tope y la página que pasa de su carga inicial', () => {
    const violations = checkLimits(analyzeBuild(build()), limits);
    expect(violations.map((v) => v.what)).toEqual(['trozo lazy-CCCC3333.js']);
    const tighter = checkLimits(analyzeBuild(build()), { ...limits, maxInitialBytes: { 'index.html': 1000 } });
    expect(tighter.map((v) => v.what).sort()).toEqual(['carga inicial de index.html', 'trozo lazy-CCCC3333.js']);
  });

  it('una excepción con su propio tope deja pasar al trozo, pero solo hasta ese tope', () => {
    const exception = (maxBytes: number): ChunkLimits => ({ ...limits, exceptions: { lazy: { maxBytes, reason: 'prueba' } } });
    expect(checkLimits(analyzeBuild(build()), exception(10000))).toEqual([]);
    expect(checkLimits(analyzeBuild(build()), exception(8000)).map((v) => v.what)).toEqual(['trozo lazy-CCCC3333.js']);
  });

  it('sin compilación avisa de cómo generarla', () => {
    expect(() => analyzeBuild(join(tmpdir(), 'iark-no-existe-jamas'))).toThrow(/npm run build:app/);
  });
});
