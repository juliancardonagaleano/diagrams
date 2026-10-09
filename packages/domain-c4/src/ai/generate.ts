import { GenerationError, generateStructured, type Effort, type StructuredOptions, type StructuredResult } from '@iark/kernel';
import { autoLayoutDocument } from '../layout/elkLayout';
import { c4Module } from '../module';
import type { C4Document, LayoutDensity, LayoutDirectionOption, LayoutDistribution } from '../model/types';
import { c4AiSpec } from './spec';

export { GenerationError };
export type { Effort };

export const DEFAULT_AI_MODEL = 'claude-opus-5';

export interface GenerateOptions extends Omit<StructuredOptions<C4Document>, 'defaultModel'> {
  /** Dirección del autolayout. */
  direction?: LayoutDirectionOption;
  /** Densidad del autolayout. */
  density?: LayoutDensity;
  /** Distribución del autolayout. */
  distribution?: LayoutDistribution;
  /** Desactivar el autolayout posterior (devuelve el modelo sin coordenadas). */
  skipLayout?: boolean;
}

/** Lo de `generateStructured` (intentos, tokens, incidencias de las reglas…) con el documento ya con autolayout. */
export type GenerateResult = StructuredResult<C4Document>;

/**
 * Genera (o refina) un documento C4 a partir de una instrucción con Claude (salida estructurada) o con cualquier
 * modelo de Foundry (JSON validado aquí), lo verifica con las reglas del módulo (reintenta si hay errores; `verify: false` lo
 * desactiva) y aplica autolayout.
 */
export async function generateDocument(options: GenerateOptions): Promise<GenerateResult> {
  const result = await generateStructured(c4AiSpec, { validate: c4Module.validate, ...options, defaultModel: DEFAULT_AI_MODEL });
  const progress = options.onProgress ?? (() => {});
  if (options.skipLayout) return result;
  progress('Aplicando autolayout…');
  const document = await autoLayoutDocument(result.document, { direction: options.direction, density: options.density, distribution: options.distribution, force: true });
  return { ...result, document };
}
