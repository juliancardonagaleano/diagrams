import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { analyzeBuild, checkLimits, chunkBaseName, kB } from '../../scripts/perf/chunks';
import { CHUNK_LIMITS, ELK_CHUNK } from '../../scripts/perf/limites';

/**
 * Tamaño de la compilación (`dist/app`, la misma que sirve el resto de los e2e). Son bytes de lo que sale del empaquetador, no
 * tiempos: no dependen de la máquina ni del CI. Los topes están en `scripts/perf/limites.ts`, cada excepción con su motivo.
 */
const analysis = analyzeBuild(process.env.OUT_DIR ?? 'dist/app');

test.describe('tamaño de los trozos de la compilación', () => {
  test('ningún trozo pasa de 500 kB, salvo las excepciones justificadas, y cada excepción tiene su propio tope', () => {
    const chunkViolations = checkLimits(analysis, { ...CHUNK_LIMITS, maxInitialBytes: {} });
    expect(
      chunkViolations.map((v) => `${v.what}: ${kB(v.actual)} (tope ${kB(v.limit)})`),
      'trozos por encima de su tope: pártelos (import dinámico o codeSplitting.groups en vite.config.ts) o justifica una excepción en scripts/perf/limites.ts',
    ).toEqual([]);
  });

  test('cada excepción sigue haciendo falta: un trozo que ya cabe en 500 kB debe salir de la lista', () => {
    const big = new Set(analysis.chunks.filter((c) => c.bytes > CHUNK_LIMITS.maxChunkBytes).map((c) => chunkBaseName(c.name)));
    const stale = Object.keys(CHUNK_LIMITS.exceptions).filter((name) => !big.has(name));
    expect(stale, `excepciones de scripts/perf/limites.ts que ya no corresponden a ningún trozo grande (¿cambió el nombre o ya cabe?): ${stale.join(', ')}`).toEqual([]);
  });

  test('la carga inicial de cada página se queda bajo su tope', () => {
    for (const [html, limit] of Object.entries(CHUNK_LIMITS.maxInitialBytes)) {
      const page = analysis.pages.find((p) => p.html === html);
      expect(page, `no hay ${html} en la compilación`).toBeDefined();
      expect(page!.bytes, `${html}: ${kB(page!.bytes)} de JS al abrir (tope ${kB(limit)}):\n${page!.files.map((f) => `  ${f.name} ${kB(f.bytes)}`).join('\n')}`).toBeLessThanOrEqual(limit);
    }
  });

  test('ELK (≈1,4 MB) no está en la carga inicial de ninguna página: solo se descarga al calcular una colocación', () => {
    const eager = analysis.chunks.filter((c) => ELK_CHUNK.test(c.name) && c.initialFor.length > 0).map((c) => `${c.name} en ${c.initialFor.join(', ')}`);
    expect(eager).toEqual([]);
    for (const page of analysis.pages) {
      const heavy = page.files.filter((f) => f.bytes > 1_000_000).map((f) => f.name);
      expect(heavy, `${page.html} descarga al abrir un trozo de más de 1 MB`).toEqual([]);
    }
  });

  test('el hilo de trabajo del autolayout está en la compilación, junto con la salida de emergencia para el hilo principal', () => {
    const names = readdirSync(join(analysis.dir, 'assets'));
    expect(names.some((n) => /^elkWorker-.*\.js$/.test(n)), 'falta assets/elkWorker-*.js: Vite no empaquetó el hilo de trabajo').toBe(true);
    expect(names.some((n) => /^elk-hilo-principal-.*\.js$/.test(n)), 'falta assets/elk-hilo-principal-*.js: ELK para el hilo principal no está en su propio trozo').toBe(true);
  });
});
