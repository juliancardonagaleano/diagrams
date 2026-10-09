import { existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Command } from 'commander';
import {
  analyzeText,
  bundleFileName,
  bundleToText,
  checkProject,
  cleanName,
  createBundle,
  duplicateDiagram,
  extractJson,
  findDiagram,
  findProject,
  importBundle,
  isVersioned,
  parseBundle,
  parseVersionId,
  ProjectError,
  projectTrace,
  sameName,
  snapshotProject,
  type Analysis,
  type AnyModule,
  type DiagramCheck,
  type DiagramMeta,
  type ModuleRegistry,
  type ProjectSummary,
  type VersionedProjectStore,
  type VersionMeta,
} from '@iark/kernel';
import { compareTexts, DIFF_FORMATS, parseFormat, type DiffFormat, type ImportSource } from './diff';
import { CliError, info, readInput, writeOutput } from './io';
import { addTraceViewOptions, buildTraceOutput, emitTrace, type TraceViewOptions } from './trace';
import { FolderProjectStore } from './workspace';

/** Carpeta de trabajo por omisión (relativa al directorio actual). */
const DEFAULT_WORKSPACE = './iark-workspace';
const WORKSPACE_HELP = `carpeta de trabajo con los proyectos (o la variable IARK_WORKSPACE; por defecto ${DEFAULT_WORKSPACE})`;
const GENERATOR = 'IArk - DIAgrams';

interface WorkspaceOptions {
  workspace?: string;
}

/** La carpeta de trabajo indicada con `--workspace`, con `IARK_WORKSPACE` o, si no, la de por omisión. */
const workspaceFolder = (opts: WorkspaceOptions): string => opts.workspace || process.env.IARK_WORKSPACE || DEFAULT_WORKSPACE;
const openStore = (opts: WorkspaceOptions): FolderProjectStore => new FolderProjectStore(workspaceFolder(opts));

const write = (text: string): void => void process.stdout.write(text);
const writeLine = (text: string): void => write(`${text}\n`);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
/** `2026-10-03T12:34:56.789Z` → `2026-10-03 12:34Z` (UTC). */
const when = (isoDate: string): string => `${isoDate.slice(0, 10)} ${isoDate.slice(11, 16)}Z`;
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const columns = (rows: string[][]): string[] => {
  const widths = rows.length ? rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length))) : [];
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]))).join('  '));
};

/** Como `readInput`, pero un archivo ilegible es un error de uso (código 2): el 1 queda para los fallos inesperados. */
function readText(file: string): string {
  try {
    return readInput(file, false);
  } catch (error) {
    if (error instanceof CliError) throw new CliError(error.message, 2);
    throw error;
  }
}

function requireYes(yes: boolean | undefined, what: string): void {
  if (!yes) throw new CliError(`${what} No se puede deshacer y el comando no pide confirmación: repítalo con --yes para confirmarlo.`, 2);
}

/** `1234` → `1,2 kB`; los tamaños de un documento. */
const sizeOf = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1).replace('.', ',')} kB` : `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`);

const diagramLines = (project: ProjectSummary): string[] =>
  columns(project.diagrams.map((d) => [d.id, d.module, d.name, when(d.updatedAt)]));

// ───────────── add: qué módulo es y qué se guarda ─────────────

/** Los campos de primer nivel que quedan al interpretar el documento con el esquema (los que el módulo no conoce se descartan). */
const topLevelKeys = (value: unknown): string[] => (value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : []);

/**
 * El módulo de un documento que se añade: el indicado con `--module`; si no, el del nombre del archivo (`x.<módulo>.json`);
 * y si tampoco, el único cuyo esquema lo acepta sin descartar ninguno de sus campos de primer nivel (casi todos los esquemas
 * aceptan casi cualquier objeto, pero solo el propio módulo conoce todos sus campos). Con ninguno o varios, error de uso.
 */
function chooseModule(registry: ModuleRegistry, requested: string | undefined, file: string, raw: string): AnyModule {
  if (requested !== undefined) return registry.require(requested);
  const named = file === '-' ? undefined : /^.+\.([a-z][a-z0-9-]*)\.json$/.exec(basename(file))?.[1];
  if (named && registry.has(named)) return registry.require(named);

  const ids = registry.ids().join(', ');
  const hint = `Indique --module <id> (módulos: ${ids}) o nombre el archivo <nombre>.<módulo>.json.`;
  if (!raw.trim()) throw new CliError(`El documento está vacío. ${hint}`, 2);
  const all = registry.list().map((module) => ({ module, analysis: analyzeText(module, raw) }));
  const first = all[0]?.analysis;
  if (first?.status === 'syntax') throw new CliError(`El documento no es JSON válido: ${first.error}`, 2);
  const accepting = all.filter((c) => c.analysis.status === 'ok');
  const complete = accepting.filter((c) => {
    const kept = new Set(topLevelKeys((c.analysis as Extract<Analysis, { status: 'ok' }>).document));
    return topLevelKeys(JSON.parse(extractJson(raw))).every((key) => kept.has(key));
  });
  if (complete.length === 1) return complete[0].module;
  if (complete.length > 1) throw new CliError(`No se pudo deducir el módulo: el documento encaja con ${complete.map((c) => c.module.id).join(', ')}. ${hint}`, 2);
  if (accepting.length > 0) throw new CliError(`No se pudo deducir el módulo: ${accepting.map((c) => c.module.id).join(', ')} lo aceptan, pero ninguno reconoce todos sus campos. ${hint}`, 2);
  throw new CliError(`Ningún módulo de esta instalación acepta el documento (${ids}). ${hint}`, 2);
}

/** Por qué un documento no es válido para el módulo, listando los errores de esquema. */
function describeFailure(module: AnyModule, analysis: Exclude<Analysis, { status: 'ok' }>): string {
  if (analysis.status === 'empty') return 'El documento está vacío.';
  if (analysis.status === 'syntax') return `El documento no es JSON válido: ${analysis.error}`;
  const shown = analysis.issues.slice(0, 15).map((i) => `- ${i.path}: ${i.message}`);
  const more = analysis.issues.length - shown.length;
  return `El documento no cumple el esquema del módulo «${module.id}» (${plural(analysis.issues.length, 'error', 'errores')}):\n${shown.join('\n')}${more > 0 ? `\n… y ${more} más` : ''}\nUse --force para guardarlo como borrador.`;
}

/** El texto que se guarda: el del archivo tal cual; si venía entre vallas de código (salida de una IA), solo el JSON. */
function storedText(raw: string, analysis: Analysis): string {
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    return analysis.status === 'ok' ? extractJson(raw) : raw;
  }
}

/** Nombre por omisión de un diagrama: el del archivo sin `.json` ni el sufijo `.<módulo>`. */
function defaultName(file: string, moduleId: string): string {
  if (file === '-') return 'Sin título';
  let name = basename(file).replace(/\.json$/i, '');
  if (name.endsWith(`.${moduleId}`)) name = name.slice(0, -(moduleId.length + 1));
  return name.trim() ? cleanName(name, 'del diagrama') : 'Sin título';
}

// ───────────── check ─────────────

const STATUS_LABEL: Record<DiagramCheck['status'], string> = { ok: 'ok', empty: 'vacío', syntax: 'no es JSON', schema: 'esquema', 'unknown-module': 'sin módulo' };
const PROBLEM_LABEL = { dangling: 'rota', invalid: 'mal formada', ambiguous: 'ambigua', unresolved: 'sin resolver' } as const;

function checkLine(d: DiagramCheck): string[] {
  const detail = d.status === 'ok' ? `${plural(d.errors, 'error', 'errores')}, ${plural(d.warnings, 'aviso', 'avisos')}, ${plural(d.infos, 'nota', 'notas')}` : (d.detail ?? '');
  return [STATUS_LABEL[d.status], d.module, d.name, detail];
}

// ───────────── historial de versiones ─────────────

/**
 * El almacén con historial, o un error de uso que dice por qué no lo hay: el historial está desactivado (`IARK_VERSIONS=off`). Los comandos de
 * versiones lo piden antes de nada para no fingir que hay historial donde no se guarda.
 */
function versioned(store: FolderProjectStore): VersionedProjectStore {
  if (!isVersioned(store)) throw new CliError('El historial de versiones está desactivado en este espacio de trabajo (IARK_VERSIONS=off). Quite la variable para guardar y consultar versiones.', 2);
  return store;
}

/** El número de versión de un argumento (`7`, o `#7`), o un error de uso. */
function versionArgument(raw: string): number {
  const id = parseVersionId(raw.replace(/^#/, ''));
  if (id === undefined) throw new CliError(`«${raw}» no es un número de versión (un entero positivo, como el que muestra \`iark project history\`).`, 2);
  return id;
}

/** Una versión que puede ser `actual` (el documento tal como está ahora). */
const CURRENT = /^(actual|current)$/i;

const versionLine = (v: VersionMeta): string[] => [
  `#${v.id}`,
  when(v.savedAt),
  v.savedBy ?? '-',
  v.label ? `«${v.label}»` : '',
  `${sizeOf(v.size)}${v.restoredFrom !== undefined ? ` (restaurada de la #${v.restoredFrom})` : ''}`,
];

// ───────────── registro de los comandos ─────────────

/**
 * `iark project …`: proyectos guardados en una carpeta de trabajo (ver `FolderProjectStore`). Agrupan diagramas de cualquier
 * módulo de la suite; se pueden comprobar, trazar entre sí y llevar a un solo archivo. Los nombres de proyecto y de diagrama
 * se aceptan por id o por nombre.
 */
export function registerProject(program: Command, registry: ModuleRegistry): void {
  const project = program
    .command('project')
    .description(
      `Proyectos: guarda y agrupa diagramas de cualquier módulo en una carpeta de trabajo (${DEFAULT_WORKSPACE}, o --workspace / IARK_WORKSPACE). ` +
        'Cada proyecto es un directorio y cada diagrama un <nombre>.<módulo>.json dentro de él. Los proyectos y los diagramas se indican por id o por nombre',
    );
  const sub = (name: string) => project.command(name).option('-w, --workspace <carpeta>', WORKSPACE_HELP);

  sub('list')
    .description('Lista los proyectos del espacio de trabajo con sus diagramas (módulo, nombre y fecha)')
    .option('--json', 'salida en JSON', false)
    .action(async (opts: WorkspaceOptions & { json: boolean }) => {
      const store = openStore(opts);
      const projects = await store.listProjects();
      if (opts.json) return write(json(projects));
      if (projects.length === 0) return writeLine(`No hay proyectos en «${store.root}». Cree uno con: iark project create <nombre>`);
      for (const p of projects) {
        writeLine(`${p.name} (${p.id}) · ${plural(p.diagrams.length, 'diagrama', 'diagramas')} · ${when(p.updatedAt)}`);
        for (const line of diagramLines(p)) writeLine(`    ${line}`);
      }
    });

  sub('create')
    .description('Crea un proyecto (un directorio nuevo en el espacio de trabajo)')
    .argument('<nombre>', 'nombre del proyecto; el id (nombre del directorio) sale de él: minúsculas, sin tildes ni símbolos')
    .option('--description <texto>', 'descripción del proyecto')
    .action(async (name: string, opts: WorkspaceOptions & { description?: string }) => {
      const store = openStore(opts);
      const created = await store.createProject({ name, description: opts.description });
      writeLine(`Proyecto «${created.name}» creado (id ${created.id}) en ${join(store.root, created.id)}`);
    });

  sub('rename')
    .description('Cambia el nombre de un proyecto (el directorio y el id no cambian)')
    .argument('<proyecto>', 'id o nombre')
    .argument('<nuevo-nombre>', 'nombre nuevo')
    .action(async (ref: string, name: string, opts: WorkspaceOptions) => {
      const store = openStore(opts);
      const found = await findProject(store, ref);
      const renamed = await store.renameProject(found.id, name);
      writeLine(`Proyecto «${found.name}» renombrado a «${renamed.name}» (el id sigue siendo ${renamed.id}).`);
    });

  sub('delete')
    .description('Borra un proyecto: elimina su directorio entero con todos sus diagramas')
    .argument('<proyecto>', 'id o nombre')
    .option('--yes', 'confirma el borrado (sin él, el comando no hace nada)', false)
    .action(async (ref: string, opts: WorkspaceOptions & { yes: boolean }) => {
      const store = openStore(opts);
      const found = await findProject(store, ref);
      requireYes(opts.yes, `Borrar el proyecto «${found.name}» elimina su directorio entero (${join(store.root, found.id)}) con ${plural(found.diagrams.length, 'diagrama', 'diagramas')} y todo lo demás que contenga.`);
      await store.deleteProject(found.id);
      writeLine(`Proyecto «${found.name}» borrado.`);
    });

  sub('show')
    .description('Muestra un proyecto y sus diagramas')
    .argument('<proyecto>', 'id o nombre')
    .option('--json', 'salida en JSON', false)
    .action(async (ref: string, opts: WorkspaceOptions & { json: boolean }) => {
      const store = openStore(opts);
      const found = await findProject(store, ref);
      if (opts.json) return write(json(found));
      writeLine(`${found.name} (${found.id})`);
      if (found.description) writeLine(found.description);
      writeLine(`Carpeta: ${join(store.root, found.id)}`);
      writeLine(`Creado: ${when(found.createdAt)} · actualizado: ${when(found.updatedAt)}`);
      writeLine(found.diagrams.length === 0 ? 'Sin diagramas. Añada uno con: iark project add <proyecto> <archivo>' : `Diagramas (${found.diagrams.length}):`);
      for (const line of diagramLines(found)) writeLine(`  ${line}`);
    });

  sub('add')
    .description(
      'Añade un diagrama (el documento JSON de un módulo) a un proyecto. El módulo se deduce del nombre del archivo (<nombre>.<módulo>.json) o de su contenido; con --module se valida contra su esquema',
    )
    .argument('<proyecto>', 'id o nombre')
    .argument('<archivo>', 'documento JSON del módulo (o "-" para la entrada estándar)')
    .option('--module <id>', 'módulo del diagrama (ver `iark modules`); si no se indica, se deduce')
    .option('--name <nombre>', 'nombre del diagrama (por omisión, el del archivo)')
    .option('--force', 'guarda el documento como borrador aunque no cumpla el esquema del módulo', false)
    .option('--update', 'si ya hay un diagrama con ese nombre (del mismo módulo) lo reemplaza, conservando su id y su nombre', false)
    .action(async (ref: string, file: string, opts: WorkspaceOptions & { module?: string; name?: string; force: boolean; update: boolean }) => {
      const store = openStore(opts);
      const found = await findProject(store, ref);
      const raw = readText(file);
      const module = chooseModule(registry, opts.module, file, raw);
      const analysis = analyzeText(module, raw);
      if (analysis.status !== 'ok') {
        if (!opts.force) throw new CliError(describeFailure(module, analysis), 2);
        info(`aviso: se guarda como borrador; no cumple el esquema del módulo «${module.id}».`);
      }
      const text = storedText(raw, analysis);
      const name = opts.name !== undefined ? cleanName(opts.name, 'del diagrama') : defaultName(file, module.id);
      const existing = found.diagrams.find((d) => sameName(d.name, name));
      let saved: DiagramMeta;
      if (existing && opts.update) {
        if (existing.module !== module.id) throw new ProjectError('invalid', `El diagrama «${existing.name}» es del módulo «${existing.module}»: un diagrama no cambia de módulo (use otro --name).`);
        saved = await store.saveDiagram(found.id, { id: existing.id, text });
      } else {
        if (existing) throw new ProjectError('exists', `Ya hay un diagrama llamado «${existing.name}» en el proyecto «${found.name}». Use --update para reemplazarlo o --name para darle otro nombre.`);
        saved = await store.saveDiagram(found.id, { module: module.id, name, text });
      }
      writeLine(`${existing ? 'Actualizado' : 'Añadido'} «${saved.name}» (módulo ${saved.module}, id ${saved.id}) en el proyecto «${found.name}».`);
    });

  sub('get')
    .description('Imprime el documento de un diagrama (o lo escribe en un archivo con -o)')
    .argument('<proyecto>', 'id o nombre')
    .argument('<diagrama>', 'id o nombre')
    .option('-o, --out <archivo>', 'archivo de salida (por defecto stdout)')
    .action(async (ref: string, diagramRef: string, opts: WorkspaceOptions & { out?: string }) => {
      const store = openStore(opts);
      const found = await findProject(store, ref);
      const meta = findDiagram(found, diagramRef);
      const diagram = await store.getDiagram(found.id, meta.id);
      if (!diagram) throw new ProjectError('not-found', `No existe el diagrama «${diagramRef}» en el proyecto «${found.name}».`);
      // a la terminal siempre con salto de línea final; a un archivo, el documento tal cual
      writeOutput(opts.out, opts.out && opts.out !== '-' ? diagram.text : diagram.text.endsWith('\n') ? diagram.text : `${diagram.text}\n`);
      if (opts.out && opts.out !== '-') info(`Diagrama «${diagram.name}» escrito en ${opts.out}`);
    });

  sub('rename-diagram')
    .description('Cambia el nombre de un diagrama (el archivo y el id no cambian)')
    .argument('<proyecto>', 'id o nombre')
    .argument('<diagrama>', 'id o nombre')
    .argument('<nuevo-nombre>', 'nombre nuevo')
    .action(async (ref: string, diagramRef: string, name: string, opts: WorkspaceOptions) => {
      const store = openStore(opts);
      const found = await findProject(store, ref);
      const meta = findDiagram(found, diagramRef);
      const renamed = await store.renameDiagram(found.id, meta.id, name);
      writeLine(`Diagrama «${meta.name}» renombrado a «${renamed.name}» (el id sigue siendo ${renamed.id}).`);
    });

  sub('remove')
    .description('Quita un diagrama de un proyecto: borra su archivo')
    .argument('<proyecto>', 'id o nombre')
    .argument('<diagrama>', 'id o nombre')
    .option('--yes', 'confirma el borrado (sin él, el comando no hace nada)', false)
    .action(async (ref: string, diagramRef: string, opts: WorkspaceOptions & { yes: boolean }) => {
      const store = openStore(opts);
      const found = await findProject(store, ref);
      const meta = findDiagram(found, diagramRef);
      requireYes(opts.yes, `Quitar el diagrama «${meta.name}» del proyecto «${found.name}» borra su archivo (${join(store.root, found.id, `${meta.id}.${meta.module}.json`)}).`);
      await store.deleteDiagram(found.id, meta.id);
      writeLine(`Diagrama «${meta.name}» quitado del proyecto «${found.name}».`);
    });

  sub('copy')
    .description('Copia un diagrama, en el mismo proyecto o en otro (con --to)')
    .argument('<proyecto>', 'id o nombre del proyecto de origen')
    .argument('<diagrama>', 'id o nombre')
    .option('--to <proyecto>', 'proyecto de destino (por omisión, el mismo)')
    .option('--name <nombre>', 'nombre de la copia (por omisión, «<nombre> (copia)»)')
    .action(async (ref: string, diagramRef: string, opts: WorkspaceOptions & { to?: string; name?: string }) => {
      const store = openStore(opts);
      const found = await findProject(store, ref);
      const meta = findDiagram(found, diagramRef);
      const target = opts.to !== undefined ? await findProject(store, opts.to) : found;
      const copy = await duplicateDiagram(store, found.id, meta.id, { toProjectId: target.id, name: opts.name });
      writeLine(`Diagrama «${meta.name}» copiado como «${copy.name}» (id ${copy.id}) en el proyecto «${target.name}».`);
    });

  // ───────────── historial de versiones ─────────────

  sub('history')
    .description('Historial de versiones de un diagrama: cada guardado deja una versión (la más reciente primero), con su fecha, quién la guardó y el nombre que se le haya dado')
    .argument('<proyecto>', 'id o nombre')
    .argument('<diagrama>', 'id o nombre')
    .option('--json', 'salida en JSON', false)
    .action(async (ref: string, diagramRef: string, opts: WorkspaceOptions & { json: boolean }) => {
      const store = openStore(opts);
      const found = await findProject(store, ref);
      const meta = findDiagram(found, diagramRef);
      const versions = await versioned(store).listVersions(found.id, meta.id);
      if (opts.json) return write(json(versions));
      if (versions.length === 0) return writeLine(`«${meta.name}» todavía no tiene versiones guardadas.`);
      writeLine(`Historial de «${meta.name}» (${meta.id}) en el proyecto «${found.name}»: ${plural(versions.length, 'versión', 'versiones')}`);
      for (const line of columns(versions.map(versionLine))) writeLine(`  ${line}`);
    });

  sub('restore')
    .description(
      'Restaura una versión de un diagrama: su contenido pasa a ser el actual y se guarda como una versión NUEVA. Nada del historial se borra, así que se puede deshacer restaurando la versión que había antes',
    )
    .argument('<proyecto>', 'id o nombre')
    .argument('<diagrama>', 'id o nombre')
    .argument('<versión>', 'número de la versión (ver `iark project history`)')
    .action(async (ref: string, diagramRef: string, versionRef: string, opts: WorkspaceOptions) => {
      const store = openStore(opts);
      const found = await findProject(store, ref);
      const meta = findDiagram(found, diagramRef);
      const id = versionArgument(versionRef);
      const result = await versioned(store).restoreVersion(found.id, meta.id, id);
      writeLine(
        result.unchanged
          ? `«${meta.name}» ya tenía el contenido de la versión #${id}: no se guardó nada.`
          : `Versión #${id} de «${meta.name}» restaurada: quedó guardada como la versión #${result.version.id} (el historial anterior sigue intacto).`,
      );
    });

  sub('label')
    .description('Pone un nombre a una versión (p. ej. «Entrega 1»): una versión con nombre no se sustituye ni se descarta sola al rotar el historial')
    .argument('<proyecto>', 'id o nombre')
    .argument('<diagrama>', 'id o nombre')
    .argument('<versión>', 'número de la versión')
    .argument('<nombre>', 'nombre de la versión')
    .action(async (ref: string, diagramRef: string, versionRef: string, label: string, opts: WorkspaceOptions) => {
      const store = openStore(opts);
      const found = await findProject(store, ref);
      const meta = findDiagram(found, diagramRef);
      const named = await versioned(store).labelVersion(found.id, meta.id, versionArgument(versionRef), label);
      writeLine(`Versión #${named.id} de «${meta.name}» nombrada «${named.label}».`);
    });

  sub('delete-version')
    .description('Borra una versión CON nombre del historial (las que no tienen nombre se descartan solas al rotar)')
    .argument('<proyecto>', 'id o nombre')
    .argument('<diagrama>', 'id o nombre')
    .argument('<versión>', 'número de la versión')
    .option('--yes', 'confirma el borrado (sin él, el comando no hace nada)', false)
    .action(async (ref: string, diagramRef: string, versionRef: string, opts: WorkspaceOptions & { yes: boolean }) => {
      const store = openStore(opts);
      const found = await findProject(store, ref);
      const meta = findDiagram(found, diagramRef);
      const id = versionArgument(versionRef);
      const history = versioned(store);
      requireYes(opts.yes, `Borrar la versión #${id} de «${meta.name}» la quita del historial para siempre.`);
      await history.deleteVersion(found.id, meta.id, id);
      writeLine(`Versión #${id} de «${meta.name}» borrada.`);
    });

  sub('diff')
    .description(
      'Compara dos versiones de un diagrama con el mismo motor y la misma salida que `iark diff`. Con una sola versión, la compara con el contenido actual del diagrama (qué cambió desde entonces); ' +
        'con dos, de la primera a la segunda. En lugar de un número vale `actual` (el contenido de ahora)',
    )
    .argument('<proyecto>', 'id o nombre')
    .argument('<diagrama>', 'id o nombre')
    .argument('<antes>', 'número de la versión anterior (o `actual`)')
    .argument('[después]', 'número de la versión nueva (por omisión, `actual`)')
    .option('--format <formato>', `salida: ${DIFF_FORMATS.join(' | ')} (markdown sirve para pegar en una PR o un changelog)`, parseFormat, 'text')
    .option('--exit-code', 'termina con código 1 si hay cambios (como `git diff --exit-code`); sin la opción, 0 aunque los haya', false)
    .option('-o, --out <archivo>', 'archivo de salida (por defecto stdout)')
    .action(async (ref: string, diagramRef: string, beforeRef: string, afterRef: string | undefined, opts: WorkspaceOptions & { format: DiffFormat; exitCode: boolean; out?: string }) => {
      const store = openStore(opts);
      const found = await findProject(store, ref);
      const meta = findDiagram(found, diagramRef);
      const history = versioned(store);
      const side = async (reference: string) => {
        const file = `${meta.id}.${meta.module}.json`;
        if (CURRENT.test(reference)) {
          const current = await store.getDiagram(found.id, meta.id);
          if (!current) throw new ProjectError('not-found', `No existe el diagrama «${diagramRef}» en el proyecto «${found.name}».`);
          return { raw: current.text, file, origin: `${meta.name}, actual` };
        }
        const id = versionArgument(reference);
        const version = await history.getVersion(found.id, meta.id, id);
        if (!version) throw new ProjectError('not-found', `«${meta.name}» no tiene la versión #${id} (¿se descartó al rotar el historial? Mire \`iark project history\`).`);
        return { raw: version.text, file, origin: `${meta.name}, versión #${id}${version.label ? ` «${version.label}»` : ''}` };
      };
      const [before, after] = [await side(beforeRef), await side(afterRef ?? 'actual')];
      // una versión guardada es JSON del módulo (o un borrador que no lo es, y entonces lo dirá el motor): no se importa de otras fuentes
      const noImport: ImportSource = async () => {
        throw new CliError('Una versión de un diagrama es un documento JSON del módulo: no se puede importar de otra fuente.', 2);
      };
      const { text, changed } = await compareTexts(registry, registry.require(meta.module), before, after, opts.format, noImport);
      writeOutput(opts.out, text);
      if (opts.exitCode && changed) process.exitCode = 1;
    });

  sub('export')
    .description(`Exporta un proyecto entero a un solo archivo (*.iark-project.json, formato iark.project/1): para llevarlo a otro equipo, a la web o guardarlo en git`)
    .argument('<proyecto>', 'id o nombre')
    .option('-o, --out <archivo>', 'archivo de salida; si es una carpeta, se llama <proyecto>.iark-project.json (por omisión, stdout)')
    .action(async (ref: string, opts: WorkspaceOptions & { out?: string }) => {
      const store = openStore(opts);
      const found = await findProject(store, ref);
      const text = bundleToText(createBundle(await snapshotProject(store, found.id), { generator: GENERATOR }));
      if (!opts.out || opts.out === '-') return write(text);
      const isFolder = /[\\/]$/.test(opts.out) || (existsSync(opts.out) && statSync(opts.out).isDirectory());
      const target = isFolder ? join(opts.out, bundleFileName(found.name)) : opts.out;
      writeOutput(target, text);
      info(`Proyecto «${found.name}» (${plural(found.diagrams.length, 'diagrama', 'diagramas')}) exportado a ${target}`);
    });

  sub('import')
    .description('Importa un proyecto desde su archivo único (*.iark-project.json): crea uno nuevo, nunca pisa uno existente')
    .argument('<archivo>', 'archivo del proyecto (o "-" para la entrada estándar)')
    .option('--name <nombre>', 'nombre del proyecto (por omisión, el que trae el archivo)')
    .action(async (file: string, opts: WorkspaceOptions & { name?: string }) => {
      const store = openStore(opts);
      const result = await importBundle(store, parseBundle(readText(file)), { name: opts.name });
      writeLine(`Proyecto «${result.project.name}» importado (id ${result.project.id}, ${plural(result.diagrams, 'diagrama', 'diagramas')}).`);
      if (result.renamedFrom) info(`Ya había un proyecto llamado «${result.renamedFrom}»: este se llama «${result.project.name}». Use --name para elegir otro nombre.`);
    });

  sub('check')
    .description(
      'Comprueba un proyecto: cada diagrama contra el esquema y las reglas de su módulo, y las referencias URN (`ref`) entre los diagramas. Termina con código 3 si hay diagramas inválidos, errores de reglas o referencias rotas o ambiguas',
    )
    .argument('<proyecto>', 'id o nombre')
    .option('--strict', 'falla también (código 3) con avisos de los módulos o referencias sin resolver', false)
    .option('--json', 'salida en JSON', false)
    .action(async (ref: string, opts: WorkspaceOptions & { strict: boolean; json: boolean }) => {
      const store = openStore(opts);
      const found = await findProject(store, ref);
      const check = checkProject(await snapshotProject(store, found.id), registry);
      const unresolved = check.graph.problems.filter((p) => p.reason === 'unresolved');
      const ruleErrors = check.diagrams.reduce((n, d) => n + d.errors, 0);
      const warnings = check.diagrams.reduce((n, d) => n + d.warnings, 0);
      const reasons: string[] = [];
      if (check.diagrams.some((d) => d.status !== 'ok')) reasons.push(plural(check.diagrams.filter((d) => d.status !== 'ok').length, 'diagrama inválido', 'diagramas inválidos'));
      if (ruleErrors > 0) reasons.push(plural(ruleErrors, 'error de reglas', 'errores de reglas'));
      if (check.brokenRefs > 0) reasons.push(plural(check.brokenRefs, 'referencia rota o ambigua', 'referencias rotas o ambiguas'));
      if (opts.strict && warnings > 0) reasons.push(plural(warnings, 'aviso', 'avisos'));
      if (opts.strict && unresolved.length > 0) reasons.push(plural(unresolved.length, 'referencia sin resolver', 'referencias sin resolver'));
      const passed = reasons.length === 0;

      if (opts.json) {
        write(json({ ...check, passed, strict: opts.strict, unresolvedRefs: unresolved.length }));
      } else {
        writeLine(`Proyecto «${check.project.name}» (${check.project.id}): ${plural(check.diagrams.length, 'diagrama', 'diagramas')}`);
        for (const line of columns(check.diagrams.map(checkLine))) writeLine(`  ${line}`);
        writeLine(`Referencias entre diagramas: ${plural(check.graph.links.length, 'enlace', 'enlaces')}, ${check.brokenRefs} rotas o ambiguas, ${unresolved.length} sin resolver`);
        for (const p of check.graph.problems) writeLine(`  ${PROBLEM_LABEL[p.reason]}: ${p.from} → ${p.message}`);
        writeLine(passed ? 'Comprobación correcta.' : 'La comprobación falló.');
      }
      if (!passed) {
        info(`El proyecto «${check.project.name}» no pasa la comprobación: ${reasons.join(', ')}.`);
        process.exitCode = 3;
      }
    });

  addTraceViewOptions(
    sub('trace')
      .description('Trazabilidad dentro de un proyecto: enlaces tipados por URN entre sus diagramas (de módulos distintos o del mismo), referencias sin resolver, huérfanos, matriz, cobertura y, con --from, qué alcanza un elemento')
      .argument('<proyecto>', 'id o nombre'),
  )
    .option('-o, --out <archivo>', 'archivo de salida (por omisión, stdout)')
    .action(async (ref: string, opts: WorkspaceOptions & TraceViewOptions & { out?: string }) => {
      const store = openStore(opts);
      const found = await findProject(store, ref);
      if (found.diagrams.length === 0) throw new CliError(`El proyecto «${found.name}» no tiene diagramas que trazar.`, 2);
      const trace = projectTrace(await snapshotProject(store, found.id), registry);
      for (const skipped of trace.skipped) info(`aviso: se omite el diagrama «${skipped.name}» (${skipped.module}): ${skipped.detail}`);
      const owners = Object.fromEntries([...trace.owners].map(([urn, diagrams]) => [urn, diagrams.map((d) => ({ id: d.id, name: d.name, module: d.module }))]));
      emitTrace(opts.out, await buildTraceOutput(trace.graph, opts, registry.ids(), { project: { id: found.id, name: found.name }, owners, skipped: trace.skipped }));
    });
}
