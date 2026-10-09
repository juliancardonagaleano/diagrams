import { readFileSync, readSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import type { IncludeResolver } from '@core/import/structurizr/fromStructurizrDsl';
import { DocumentValidationError, validateDocument } from '@core/model/schema';
import { extractJson } from '@iark/kernel';
import type { C4Document } from '@core/model/types';

export { extractJson };

/**
 * Lee la entrada estándar completa. `readFileSync(0)` lanza `EAGAIN` cuando stdin es un pipe no bloqueante cuyo
 * productor aún no ha escrito (p. ej. `iark import x.drawio | iark layout --stdin`, donde el primer
 * comando tarda en arrancar), así que se lee por bloques y, si no hay datos todavía, se espera y se reintenta.
 */
function readStdin(): string {
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(64 * 1024);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let bytes: number;
    try {
      bytes = readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EAGAIN') {
        Atomics.wait(pause, 0, 0, 25);
        continue;
      }
      if (code === 'EOF') break; // Windows: fin de la entrada
      throw error;
    }
    if (bytes === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, bytes)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function readInput(file: string | undefined, useStdin: boolean): string {
  if (useStdin || file === '-' || !file) {
    if (process.stdin.isTTY && !useStdin && !file) {
      throw new CliError('Indique un archivo de entrada o use --stdin.');
    }
    return readStdin();
  }
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    throw new CliError(`No se pudo leer "${file}": ${(error as Error).message}`);
  }
}

/**
 * Soporte de `!include` para importar un DSL desde un archivo: las rutas se resuelven respecto al archivo que
 * las incluye y solo se leen archivos que estén dentro del directorio del archivo de entrada (siguiendo enlaces
 * simbólicos), de modo que un DSL de origen desconocido no pueda leer nada fuera de su carpeta.
 */
export function dslIncludeOptions(entryFile: string): { file: string; resolveInclude: IncludeResolver } {
  const entry = realpathSync(resolve(entryFile));
  const root = dirname(entry);
  return {
    file: entry,
    resolveInclude: (target, fromFile) => {
      try {
        const file = realpathSync(resolve(fromFile ? dirname(fromFile) : root, target));
        const inside = relative(root, file);
        if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return undefined;
        return { file, text: readFileSync(file, 'utf8') };
      } catch {
        return undefined; // no existe, es un directorio o no se puede leer
      }
    },
  };
}

export function readDocument(file: string | undefined, useStdin: boolean): C4Document {
  const raw = readInput(file, useStdin);
  let json: unknown;
  try {
    json = JSON.parse(extractJson(raw));
  } catch (error) {
    throw new CliError(`La entrada no es JSON válido: ${(error as Error).message}`);
  }
  const result = validateDocument(json);
  if (!result.ok) throw new DocumentValidationError(result.issues);
  // Un documento de una versión anterior se migra al leerlo (`C4_MIGRATIONS`); se dice, para que nadie se sorprenda con lo que escribe `layout` o `convert`.
  noteMigration(result.migrated);
  return result.document;
}

/** Dice por stderr (no ensucia la salida) que el documento venía de una versión anterior del formato y se migró al leerlo. */
export function noteMigration(migrated: { from: string; to: string } | undefined): void {
  if (migrated) info(`Documento migrado de la versión ${migrated.from} a ${migrated.to}; \`iark migrate\` lo reescribe en la nueva.`);
}

export function writeOutput(file: string | undefined, content: string): void {
  if (!file || file === '-') {
    process.stdout.write(content);
    return;
  }
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  } catch (error) {
    throw new CliError(`No se pudo escribir "${file}": ${(error as Error).message}`);
  }
}

export class CliError extends Error {
  constructor(message: string, public readonly exitCode = 1) {
    super(message);
    this.name = 'CliError';
  }
}

/** Extensiones que se quitan siempre del nombre del archivo para nombrar el documento (las de los formatos de C4). */
const COMMON_EXTENSIONS = ['.drawio', '.xml', '.dsl', '.txt', '.mmd', '.mermaid', '.md'];

/**
 * Nombre de reserva de un documento importado: el del archivo sin la extensión de un formato conocido. Se quitan las de
 * draw.io, Structurizr y Mermaid y las que declaran los importadores del módulo (también las dobles, como `.tf.json`);
 * cualquier otra se deja (un `banca.v2` sigue llamándose `banca.v2`).
 */
export function fallbackDocumentName(file: string, importerExtensions: string[] = []): string {
  const name = basename(file);
  const lower = name.toLowerCase();
  const longest = [...COMMON_EXTENSIONS, ...importerExtensions.map((e) => e.toLowerCase())]
    .filter((ext) => lower.endsWith(ext) && lower.length > ext.length)
    .sort((a, b) => b.length - a.length)[0];
  return longest ? name.slice(0, name.length - longest.length) : name;
}

export function info(message: string): void {
  process.stderr.write(`${message}\n`);
}
