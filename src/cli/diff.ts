import { execFileSync } from 'node:child_process';
import { basename, dirname, extname, resolve } from 'node:path';
import { InvalidArgumentError, type Command } from 'commander';
import { diffDocuments, formatDiffJson, formatDiffMarkdown, formatDiffText, hasChanges, parseModuleDocument, type DomainModule, type ModuleRegistry } from '@iark/kernel';
import { DocumentValidationError, formatIssues, parseDocument } from '@core/model/schema';
import { DEFAULT_MODULE } from './registry';
import { CliError, extractJson, info, readInput, writeOutput } from './io';

export const DIFF_FORMATS = ['text', 'markdown', 'json'] as const;
const FORMATS = DIFF_FORMATS;
export type DiffFormat = (typeof FORMATS)[number];
type Format = DiffFormat;

export function parseFormat(value: string): Format {
  const v = value.toLowerCase() as Format;
  if (!FORMATS.includes(v)) throw new InvalidArgumentError(`Formato inválido «${value}». Use: ${FORMATS.join(', ')}.`);
  return v;
}

/** Importa una fuente que no es JSON (draw.io, DSL, Mermaid…): lo mismo que hacen `generate --from` e `import`. */
export type ImportSource = (
  registry: ModuleRegistry,
  moduleId: string,
  input: { file?: string; raw: string; format?: string; name?: string; fromFile: boolean },
) => Promise<{ format: string; document: unknown; warnings: string[] }>;

/** Ejecuta `git` y devuelve su salida; si no está instalado, lo dice en español. Cualquier otro fallo (código distinto de 0) lo explica quien llama. */
function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CliError('No se encontró `git` en el PATH: hace falta para --rev.', 2);
    throw error;
  }
}

/** El contenido de `file` en la revisión `rev` de git (`git show <rev>:./<archivo>`), con errores claros. */
export function readAtRevision(file: string, rev: string): string {
  if (rev.startsWith('-')) throw new CliError(`La revisión «${rev}» no es válida.`, 2);
  const absolute = resolve(file);
  const cwd = dirname(absolute);
  try {
    git(cwd, ['rev-parse', '--is-inside-work-tree']);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`«${file}» no está dentro de un repositorio de git: hace falta para --rev.`, 2);
  }
  try {
    git(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`La revisión «${rev}» no existe en este repositorio.`, 2);
  }
  try {
    return git(cwd, ['show', `${rev}:./${basename(absolute)}`]);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`«${file}» no estaba en la revisión «${rev}».`, 2);
  }
}

/** Lee un documento: como en el resto del CLI, pero con código 2 si no se puede leer (el 1 de `--exit-code` significa «hay cambios»). */
function readText(file: string): string {
  try {
    return readInput(file, false);
  } catch (error) {
    if (error instanceof CliError) throw new CliError(error.message, 2);
    throw error;
  }
}

/**
 * Lee un documento a comparar y lo valida con el esquema del módulo: el JSON del módulo (también si viene entre vallas de
 * código) o cualquier fuente que el módulo importe (.drawio, .dsl, .mmd…), como `generate --from`. Un documento inválido
 * termina con código 2, y el mensaje dice cuál de los dos era.
 */
export async function loadDocument(registry: ModuleRegistry, module: DomainModule<any>, text: { raw: string; file: string; origin: string; which: string }, importSource: ImportSource): Promise<unknown> {
  const { raw, file, origin, which } = text;
  let json: unknown;
  if (extname(file).toLowerCase() === '.json' || /^(\{|```json)/i.test(raw.trimStart())) {
    try {
      json = JSON.parse(extractJson(raw));
    } catch (error) {
      throw new CliError(`${which} (${origin}) no es JSON válido: ${(error as Error).message}`, 2);
    }
  } else {
    const imported = await importSource(registry, module.id, { file, raw, fromFile: file !== '-' });
    for (const warning of imported.warnings) info(`aviso (${origin}): ${warning}`);
    json = imported.document;
  }
  if (module.id === DEFAULT_MODULE) {
    try {
      return parseDocument(json);
    } catch (error) {
      if (error instanceof DocumentValidationError) throw new CliError(`${which} (${origin}) no es un documento C4 válido:\n${formatIssues(error.issues)}`, 2);
      throw error;
    }
  }
  // Un documento de una versión anterior se migra antes de compararlo: así «antes» y «después» se comparan en la misma versión.
  const parsed = parseModuleDocument(module, json);
  if (!parsed.ok) {
    const issues = parsed.issues.map((i) => `- ${i.path !== '(raíz)' ? `${i.path}: ` : ''}${i.message}`).join('\n');
    throw new CliError(`${which} (${origin}) no es un documento válido para el módulo «${module.id}»:\n${issues}`, 2);
  }
  if (parsed.migrated) info(`aviso (${origin}): documento migrado de la versión ${parsed.migrated.from} a ${parsed.migrated.to} antes de compararlo.`);
  return parsed.document;
}

/** Una de las dos mitades de una comparación: el texto, el nombre con que se identifica el formato y cómo se llama en los mensajes. */
export interface DiffSide {
  raw: string;
  file: string;
  origin: string;
}

/**
 * Compara dos textos de un mismo módulo y devuelve la salida ya formateada (la misma de `iark diff`) y si hay cambios. Lo usan `iark diff` y
 * la comparación de versiones de un diagrama (`iark project diff`), para que las dos digan lo mismo con el mismo formato.
 */
export async function compareTexts(registry: ModuleRegistry, module: DomainModule<any>, before: DiffSide, after: DiffSide, format: Format, importSource: ImportSource): Promise<{ text: string; changed: boolean }> {
  const [documentBefore, documentAfter] = [
    await loadDocument(registry, module, { ...before, which: 'La versión anterior' }, importSource),
    await loadDocument(registry, module, { ...after, which: 'La versión nueva' }, importSource),
  ];
  const diff = diffDocuments(documentBefore, documentAfter, module.diff);
  const text =
    format === 'json'
      ? formatDiffJson(diff)
      : format === 'markdown'
        ? formatDiffMarkdown(diff, { subtitle: `\`${before.origin}\` → \`${after.origin}\`` })
        : formatDiffText(diff, { subtitle: `${before.origin} → ${after.origin}` });
  return { text, changed: hasChanges(diff) };
}

/**
 * `iark diff <antes> [<después>]`: qué cambió entre dos versiones de un diagrama, de cualquier módulo de la suite. Es una
 * operación transversal sobre el documento (como `trace`), por eso cuelga del CLI y no de `cliCommands`.
 */
export function registerDiff(program: Command, registry: ModuleRegistry, importSource: ImportSource, defaultModule: string = DEFAULT_MODULE): void {
  program
    .command('diff')
    .description(
      'Compara dos versiones de un diagrama y muestra qué se añadió, quitó y modificó (con sus campos antes → después). Con dos archivos los compara entre sí; con uno solo y --rev, ' +
        'compara su versión en esa revisión de git con la copia de trabajo. No cuenta como cambio la maquetación guardada (coordenadas, tamaños y rutas de las vistas) ni el orden de las listas',
    )
    .argument('<antes>', 'versión anterior: JSON del módulo o cualquier fuente que importe (o "-" para stdin); con --rev, el archivo a comparar')
    .argument('[después]', 'versión nueva (sin --rev es obligatoria)')
    .option('--rev <revisión>', 'compara <antes> tal como estaba en esta revisión de git (rama, etiqueta o commit: HEAD, main, v1.2, 3f2a1bc) con su copia de trabajo')
    .option('--module <id>', 'módulo de la suite (ver `iark modules`)', defaultModule)
    .option('--format <formato>', `salida: ${FORMATS.join(' | ')} (markdown sirve para pegar en una PR o un changelog)`, parseFormat, 'text')
    .option('--exit-code', 'termina con código 1 si hay cambios (como `git diff --exit-code`); sin la opción, 0 aunque los haya', false)
    .option('-o, --out <archivo>', 'archivo de salida (por defecto stdout)')
    .action(async (beforeFile: string, afterFile: string | undefined, opts: { rev?: string; module: string; format: Format; exitCode: boolean; out?: string }) => {
      const module = registry.require(opts.module);
      let before: { raw: string; file: string; origin: string };
      let after: { raw: string; file: string; origin: string };
      if (opts.rev !== undefined) {
        if (afterFile !== undefined) throw new CliError('Con --rev se compara un solo archivo (su versión en esa revisión contra la copia de trabajo): quite el segundo.', 2);
        if (beforeFile === '-') throw new CliError('Con --rev hace falta la ruta del archivo (no "-").', 2);
        after = { raw: readText(beforeFile), file: beforeFile, origin: `${beforeFile}, copia de trabajo` };
        before = { raw: readAtRevision(beforeFile, opts.rev), file: beforeFile, origin: `${beforeFile} @ ${opts.rev}` };
      } else {
        if (afterFile === undefined) throw new CliError('Indique los dos documentos a comparar, o un archivo con --rev <revisión>.', 2);
        if (beforeFile === '-' && afterFile === '-') throw new CliError('Solo uno de los dos documentos puede venir de la entrada estándar.', 2);
        before = { raw: readText(beforeFile), file: beforeFile, origin: beforeFile === '-' ? 'entrada estándar' : beforeFile };
        after = { raw: readText(afterFile), file: afterFile, origin: afterFile === '-' ? 'entrada estándar' : afterFile };
      }
      const { text, changed } = await compareTexts(registry, module, before, after, opts.format, importSource);
      writeOutput(opts.out, text);
      if (opts.exitCode && changed) process.exitCode = 1;
    });
}
