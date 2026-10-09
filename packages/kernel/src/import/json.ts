import { textSizeProblem, treeProblem } from './limits';

/** Objeto JSON (un mapa de claves a valores): lo que los importadores leen de un archivo que no controlan. */
export type JsonRecord = Record<string, unknown>;

/** El valor, si es un objeto (no una lista ni `null`). */
export const asRecord = (value: unknown): JsonRecord | undefined => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : undefined);
/** El valor, si es una lista; si no, una lista vacía. */
export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
/** El texto recortado, si es una cadena con algo escrito. */
export const asString = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);

/** Resultado de leer un texto JSON: el valor, o el motivo (una frase en español) por el que no se puede importar. */
export type JsonRead = { ok: true; value: unknown } | { ok: false; message: string };

/** `(línea L, columna C)` del desplazamiento que cita el mensaje de `JSON.parse`, si lo cita (depende de la versión de Node). */
function whereOf(text: string, error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : '';
  const position = /position (\d+)/.exec(message);
  if (!position) return undefined;
  const offset = Math.min(Number(position[1]), text.length);
  let line = 1;
  let last = -1;
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) {
    line += 1;
    last = i;
  }
  return `línea ${line}, columna ${offset - last}`;
}

/** Quita la marca de orden de bytes del principio. */
export const withoutBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/**
 * Lee un texto JSON con los topes comunes de los importadores: vacío, demasiado grande, no válido (con línea y columna cuando se
 * conocen), demasiado anidado (el analizador de V8 puede agotar la pila) o con demasiados nodos. Nunca lanza. `label` es cómo se
 * nombra el archivo en los mensajes («El archivo de Threat Dragon»).
 */
export function readJsonText(source: string, label: string): JsonRead {
  const text = withoutBom(source);
  if (text.trim() === '') return { ok: false, message: `${label} está vacío.` };
  const big = textSizeProblem(text, label);
  if (big) return { ok: false, message: big };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof RangeError) return { ok: false, message: `${label} está demasiado anidado para analizarlo.` };
    const where = whereOf(text, error);
    const truncated = error instanceof Error && /end of JSON input/i.test(error.message);
    return { ok: false, message: `${label} no es JSON válido${where ? ` (${where})` : ''}${truncated ? ': el texto termina antes de tiempo (¿archivo truncado?)' : ''}.` };
  }
  const deep = treeProblem(value, label);
  return deep ? { ok: false, message: deep } : { ok: true, value };
}
