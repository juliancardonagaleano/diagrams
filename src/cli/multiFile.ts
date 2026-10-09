import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { multiFileImporter, type AnyModule, type SourceFile } from '@iark/kernel';
import { CliError } from './io';

/** Una importación de varios archivos ya leída: el importador que los junta, los archivos y la ruta con la que se nombra el documento. */
export interface MultiInput {
  importerId: string;
  /** Archivos leídos. El nombre es el que verá quien lea un aviso: el de cada archivo en una carpeta, la ruta indicada en una lista. */
  files: SourceFile[];
  /** Carpeta (absoluta) de la que se lee o en la que están los archivos: de ella sale el nombre del documento, como el de un archivo suelto. */
  base: string;
  /** Extensiones de los archivos que se juntan (`.tf`). */
  extensions: string[];
  /** Archivos de la carpeta del mismo formato que no se leen (p. ej. `.tf.json`, `.tfstate`), para avisarlo. */
  skipped: string[];
}

const hasExtension = (name: string, extensions: string[]): boolean => {
  const lower = name.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
};

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const readText = (path: string): string => {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new CliError(`No se pudo leer "${path}": ${(error as Error).message}`);
  }
};

/**
 * Entradas de `iark import` que se leen juntas: una carpeta (los archivos del formato que contiene, sin entrar en las
 * subcarpetas) o varios archivos. Devuelve `undefined` si no es el caso (un archivo suelto o la entrada estándar), y entonces
 * la importación es la de siempre. El importador es el pedido con `--format` o, con `auto`, el del módulo que se reparte en
 * varios archivos (`Importer.multiFile`) y encaja con lo que hay. Los archivos se ordenan después por nombre (`joinSourceFiles`).
 */
export function readMultiInput(module: AnyModule, inputs: string[], format: string): MultiInput | undefined {
  if (inputs.length === 0 || (inputs.length === 1 && inputs[0] === '-')) return undefined;
  if (inputs.includes('-')) throw new CliError('«-» (la entrada estándar) no se puede combinar con otros archivos.', 2);
  const directories = inputs.filter((i) => !isFile(i) && isDirectory(i));
  if (inputs.length === 1 && directories.length === 0) return undefined;
  if (directories.length > 0 && inputs.length > 1) throw new CliError('Indique una carpeta o varios archivos, no las dos cosas a la vez.', 2);

  const joinable = module.importers.filter((i) => i.multiFile);
  if (joinable.length === 0) {
    throw new CliError(`El módulo «${module.id}» no importa carpetas ni varios archivos a la vez: indique un solo archivo.`, 2);
  }
  const requested = format.toLowerCase();
  const wanted = requested === 'auto' ? undefined : module.importers.find((i) => i.id === requested);
  if (requested !== 'auto' && !wanted) {
    throw new CliError(`Formato inválido «${format}». Use: auto, ${module.importers.map((i) => i.id).sort().join(', ')}.`, 2);
  }
  if (wanted && !wanted.multiFile) {
    throw new CliError(`El formato «${wanted.id}» no se puede leer repartido en varios archivos ni desde una carpeta: indique un solo archivo (los formatos que sí: ${joinable.map((i) => i.id).join(', ')}).`, 2);
  }

  if (directories.length > 0) {
    const dir = directories[0];
    let names: string[];
    try {
      names = readdirSync(dir)
        .filter((n) => isFile(join(dir, n)))
        .sort();
    } catch (error) {
      throw new CliError(`No se pudo leer la carpeta "${dir}": ${(error as Error).message}`);
    }
    const matching = (i: (typeof joinable)[number]): string[] => names.filter((n) => hasExtension(n, i.multiFile!.extensions));
    const candidates = (wanted ? [wanted] : joinable).filter((i) => matching(i).length > 0);
    if (candidates.length === 0) {
      const listed = (wanted ? [wanted] : joinable).map((i) => i.multiFile!.extensions.join(', ')).join(' o ');
      throw new CliError(`La carpeta "${dir}" no tiene ningún archivo que se pueda importar junto con otros (${listed}).`, 2);
    }
    if (candidates.length > 1) {
      throw new CliError(`La carpeta "${dir}" tiene archivos de varios formatos (${candidates.map((i) => i.id).join(', ')}): indique cuál con --format.`, 2);
    }
    const importer = candidates[0];
    const read = matching(importer);
    const skipped = names.filter((n) => !read.includes(n) && hasExtension(n, importer.extensions));
    return { importerId: importer.id, files: read.map((n) => ({ name: n, text: readText(join(dir, n)) })), base: resolve(dir), extensions: importer.multiFile!.extensions, skipped };
  }

  // Varios archivos: todos del mismo formato (el pedido o el que encaja con las extensiones).
  for (const input of inputs) if (!isFile(input)) throw new CliError(`No se pudo leer "${input}": no existe o no es un archivo.`);
  const importer = multiFileImporter(module, inputs, wanted?.id);
  if (!importer) {
    const exts = (wanted ? [wanted] : joinable).map((i) => i.multiFile!.extensions.join(', ')).join(' o los ');
    throw new CliError(`Los archivos no son todos del mismo formato: solo se leen juntos los ${exts}.`, 2);
  }
  const files = inputs.map((path) => ({ name: path, text: readText(path) }));
  return { importerId: importer.id, files, base: resolve(dirname([...inputs].sort()[0])), extensions: importer.multiFile!.extensions, skipped: [] };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
