import type { ChunkLimits } from './chunks';

/**
 * Topes de tamaño de la compilación (`dist/app`), que fija `tests/e2e/tamano-trozos.spec.ts` y recuerda `npm run perf chunks`.
 * No miden tiempo: son bytes de lo que sale del empaquetador, así que no dependen de la máquina. Si un trozo nuevo pasa de
 * 500 kB, la prueba falla y obliga a partirlo (importación dinámica, `codeSplitting.groups` en vite.config.ts) o a añadirlo aquí
 * con un motivo. Los números de abajo salen de docs/rendimiento.md (compilación del 2026-10-09) con un margen de crecimiento.
 */
export const CHUNK_LIMITS: ChunkLimits = {
  /** Vite avisa a partir de 500 kB; es también el tope de todo trozo que no esté en `exceptions`. */
  maxChunkBytes: 500_000,
  exceptions: {
    elkWorker: { maxBytes: 1_500_000, reason: 'ELK 0.12 (un único archivo minificado de ≈1,43 MB, no se puede partir) en el hilo de trabajo del autolayout; solo se descarga al calcular una colocación' },
    'elk-hilo-principal': { maxBytes: 1_500_000, reason: 'ELK 0.12 para el hilo principal, la salida de emergencia cuando el navegador no da `Worker`; no se descarga si el hilo de trabajo funciona' },
    'elk-276RUBZZ': { maxBytes: 1_550_000, reason: 'la copia 0.9.3 de ELK que trae mermaid para su layout `elk`; solo se descarga al previsualizar un diagrama mermaid con ese layout (si mermaid cambia de versión, cambia el nombre)' },
    'chunk-FOHPRMQF': { maxBytes: 700_000, reason: 'el analizador de mermaid (≈660 kB); solo se descarga al previsualizar un diagrama mermaid (si mermaid cambia de versión, cambia el nombre)' },
  },
  /**
   * Carga inicial de JS por página (lo que arranca antes de pintar). Antes de sacar ELK del trozo de C4: 2705, 2379, 1795 y 1805 kB.
   * Medida del 2026-10-09 (tras #124, la internacionalización, y con los diálogos de proyectos en carga perezosa,
   * `src/projects/lazy.tsx`): 1513, 1190, 609 y 515 kB. Sube sobre la medida anterior (1309, 985, 388 y 397 kB) por dos motivos:
   * `domain-c4` creció de ≈255 a ≈393 kB con el lienzo común del editor C4 (#116; lo cargan las cuatro páginas) y el trozo `lang`
   * (≈102 kB: los dos catálogos, es y en, de `src/i18n`) se carga entero en las páginas que usan textos traducidos. Los topes
   * dejan un 3 % de margen sobre lo medido. Para bajarlos: cargar el catálogo `en` solo cuando se pide (≈50 kB) y partir
   * `domain-c4` entre lo que usan las páginas sin editor y lo que solo usa el editor.
   */
  maxInitialBytes: {
    'index.html': 1_560_000,
    'modulos.html': 1_230_000,
    'suite.html': 630_000,
    'trazabilidad.html': 530_000,
  },
};

/** Los trozos de ELK no se descargan al abrir ninguna página: solo cuando hay que calcular una colocación. */
export const ELK_CHUNK = /^elk/;
