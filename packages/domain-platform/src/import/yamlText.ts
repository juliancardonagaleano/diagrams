/**
 * Lectura de texto estructurado (YAML o JSON) de los importadores de CloudFormation y Helm, con los topes comunes de la suite:
 * vacío, demasiado grande, mal formado (con línea y columna), demasiado anidado, con demasiados nodos o con una bomba de alias.
 * Solo usa la biblioteca `yaml` con su esquema por defecto: las etiquetas cortas de CloudFormation (`!Ref`, `!Sub`…) no ejecutan
 * nada, se leen como datos y se convierten a su forma larga (`{ Ref: … }`, `{ 'Fn::Sub': … }`).
 */
import { readJsonText, textSizeProblem, treeProblem, withoutBom } from '@iark/kernel';
import { parseDocument, Pair, Scalar, visit, YAMLMap } from 'yaml';
import { PlatformImportError } from './fromMermaid';

export type Json = Record<string, unknown>;

export const rec = (v: unknown): Json | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined);
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** Texto de un valor escalar (cadena no vacía, número o booleano), o `undefined`. */
export const scalarText = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'boolean' ? String(v) : undefined);

/** Nombre de la clave larga de una etiqueta corta de CloudFormation: `!Ref` → `Ref`, `!Sub` → `Fn::Sub`, `!Condition` → `Condition`. */
const longName = (tag: string): string => (tag === 'Ref' || tag === 'Condition' ? tag : `Fn::${tag}`);

/** Un anidamiento enorme agota la pila del analizador YAML: lo recoge como RangeError o como un error de sintaxis con ese texto. */
const isOverflow = (message: string): boolean => /call stack|anidamiento excesivo/i.test(message);

export interface StructuredOptions {
  /** Convierte las etiquetas cortas de CloudFormation en su forma larga. */
  cfnTags?: boolean;
}

/**
 * Lee un texto YAML o JSON (JSON si empieza por `{` o `[`) y devuelve el valor. Lanza `PlatformImportError` con un motivo de una
 * línea si no se puede leer. `label` es cómo se nombra el archivo en los mensajes («La plantilla de CloudFormation»).
 */
export function readStructured(source: string, label: string, options: StructuredOptions = {}): unknown {
  const text = withoutBom(source);
  if (text.trim() === '') throw new PlatformImportError(`${label} está vacío.`);
  const big = textSizeProblem(text, label);
  if (big) throw new PlatformImportError(big);
  if (/^\s*[{[]/.test(text)) {
    const json = readJsonText(text, label);
    if (!json.ok) throw new PlatformImportError(json.message);
    return json.value;
  }
  let value: unknown;
  try {
    const doc = parseDocument(text, { logLevel: 'error' });
    const error = doc.errors[0];
    if (error) {
      if (isOverflow(error.message)) throw new PlatformImportError(`${label} está demasiado anidado para analizarlo.`);
      if (error.code === 'MULTIPLE_DOCS') throw new PlatformImportError(`${label} tiene varios documentos YAML (separados por «---»): se esperaba uno.`);
      const line = error.linePos?.[0];
      const why = error.message.split('\n')[0].replace(/\s+at line \d+, column \d+:?$/, '').replace(/[.:\s]+$/, '');
      throw new PlatformImportError(`${label} no es YAML válido${line ? ` (línea ${line.line}, columna ${line.col})` : ''}: ${why}.`);
    }
    if (options.cfnTags) {
      visit(doc, {
        Node(_key, node) {
          const tag = (node as { tag?: string }).tag;
          if (typeof tag !== 'string' || !tag.startsWith('!') || tag.startsWith('!!')) return undefined;
          (node as { tag?: string }).tag = undefined;
          const wrapped = new YAMLMap();
          wrapped.items.push(new Pair(new Scalar(longName(tag.slice(1))), node));
          return wrapped;
        },
      });
    }
    // Un alias que se multiplica (la «bomba de mil millones de risas») se corta con el límite de alias de la biblioteca.
    value = doc.toJS({ maxAliasCount: 100 });
  } catch (error) {
    if (error instanceof PlatformImportError) throw error;
    if (error instanceof RangeError || (error instanceof Error && isOverflow(error.message))) throw new PlatformImportError(`${label} está demasiado anidado para analizarlo.`);
    if (error instanceof ReferenceError && /alias/i.test(error.message)) throw new PlatformImportError(`${label} usa demasiados alias YAML (posible bomba de expansión): no se importa.`);
    throw new PlatformImportError(`${label} no se pudo leer: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  }
  const deep = treeProblem(value, label);
  if (deep) throw new PlatformImportError(deep);
  return value;
}
