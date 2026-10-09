import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

/**
 * Análisis de la compilación del sitio (`dist/app`): el tamaño de cada trozo y lo que carga cada página sin pedir nada más
 * (su «carga inicial»: el script de la página y todos los trozos que importa de forma estática). Lo usa `npm run perf chunks`
 * para anotar las cifras y el e2e `tamano-trozos.spec.ts` para fijar un tope por trozo y por página.
 */

export interface ChunkFile {
  /** Nombre dentro de `assets/`. */
  name: string;
  bytes: number;
  gzipBytes: number;
  /** Trozo estático de alguna página (entra en su carga inicial) o bajo demanda (import dinámico, hilo de trabajo…). */
  initialFor: string[];
}

export interface PageLoad {
  html: string;
  /** Archivos JS de la carga inicial de la página, con su tamaño. */
  files: Array<{ name: string; bytes: number }>;
  bytes: number;
  gzipBytes: number;
}

export interface BuildAnalysis {
  dir: string;
  chunks: ChunkFile[];
  pages: PageLoad[];
}

/** Nombre del trozo sin el hash final: `domain-c4-N8I54U48.js` → `domain-c4`. */
export function chunkBaseName(file: string): string {
  return file.replace(/\.js$/, '').replace(/-[A-Za-z0-9_-]{6,10}$/, '');
}

/** Importaciones estáticas de un trozo hacia otros del mismo directorio (`from"./x.js"`, `import"./x.js"`). Las dinámicas (`import("./x.js")`) no cuentan. */
export function staticImports(source: string): string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(/(?:\bfrom|\bimport)\s*["']\.\/([^"'/]+\.js)["']/g)) found.add(m[1]);
  return [...found];
}

/** Trozos que arrastra `entry` de forma estática (él incluido). */
export function staticClosure(entry: string, sources: ReadonlyMap<string, string>): string[] {
  const seen = new Set<string>();
  const walk = (file: string): void => {
    if (seen.has(file) || !sources.has(file)) return;
    seen.add(file);
    for (const dep of staticImports(sources.get(file)!)) walk(dep);
  };
  walk(entry);
  return [...seen];
}

/** Scripts de un HTML de Vite: los `<script type="module" src>` y los `<link rel="modulepreload" href>` que apuntan a `assets/`. */
export function htmlScripts(html: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/(?:src|href)="[^"]*\/assets\/([^"/]+\.js)"/g)) found.add(m[1]);
  return [...found];
}

export function analyzeBuild(dir: string): BuildAnalysis {
  const assets = join(dir, 'assets');
  if (!existsSync(assets)) throw new Error(`No hay compilación en ${dir}: ejecuta npm run build:app antes.`);
  const names = readdirSync(assets).filter((f) => f.endsWith('.js'));
  const sources = new Map(names.map((f) => [f, readFileSync(join(assets, f), 'utf8')]));
  const bytes = new Map(names.map((f) => [f, statSync(join(assets, f)).size]));
  const gzip = new Map(names.map((f) => [f, gzipSync(readFileSync(join(assets, f)), { level: 9 }).length]));

  const pages: PageLoad[] = readdirSync(dir)
    .filter((f) => f.endsWith('.html'))
    .sort()
    .map((html) => {
      const entries = htmlScripts(readFileSync(join(dir, html), 'utf8'));
      const files = [...new Set(entries.flatMap((entry) => staticClosure(entry, sources)))];
      return {
        html,
        files: files.map((name) => ({ name, bytes: bytes.get(name)! })).sort((a, b) => b.bytes - a.bytes),
        bytes: files.reduce((sum, f) => sum + bytes.get(f)!, 0),
        gzipBytes: files.reduce((sum, f) => sum + gzip.get(f)!, 0),
      };
    });

  const chunks = names
    .map((name) => ({ name, bytes: bytes.get(name)!, gzipBytes: gzip.get(name)!, initialFor: pages.filter((p) => p.files.some((f) => f.name === name)).map((p) => p.html) }))
    .sort((a, b) => b.bytes - a.bytes);
  return { dir, chunks, pages };
}

export interface ChunkLimits {
  /** Tope de cada trozo JS (bytes), salvo las excepciones. */
  maxChunkBytes: number;
  /** Trozos que pueden superarlo, por nombre sin hash, cada uno con su propio tope y el motivo. */
  exceptions: Record<string, { maxBytes: number; reason: string }>;
  /** Tope de la carga inicial de cada página (bytes de JS). */
  maxInitialBytes: Record<string, number>;
}

export interface LimitViolation {
  what: string;
  actual: number;
  limit: number;
}

/** Lo que la compilación pasa de los topes. Vacío = dentro de los límites. */
export function checkLimits(analysis: BuildAnalysis, limits: ChunkLimits): LimitViolation[] {
  const violations: LimitViolation[] = [];
  for (const chunk of analysis.chunks) {
    const exception = limits.exceptions[chunkBaseName(chunk.name)];
    const limit = exception?.maxBytes ?? limits.maxChunkBytes;
    if (chunk.bytes > limit) violations.push({ what: `trozo ${chunk.name}`, actual: chunk.bytes, limit });
  }
  for (const page of analysis.pages) {
    const limit = limits.maxInitialBytes[page.html];
    if (limit !== undefined && page.bytes > limit) violations.push({ what: `carga inicial de ${page.html}`, actual: page.bytes, limit });
  }
  return violations;
}

export const kB = (bytes: number): string => `${(bytes / 1000).toFixed(1)} kB`;
