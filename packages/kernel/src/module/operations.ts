import { extractJson } from '../util/extractJson';
import type { CommandOption, CommandSpec, DomainModule, EntityRef, ExportContext, ImportContext, Importer, ModuleIssue, SourceFile, ViewRef } from './types';

/**
 * Operaciones sobre un módulo, comunes a todas las superficies (banco de trabajo web, puente `postMessage`, servicio HTTP):
 * todo lo que se hace con un módulo se hace a través del contrato de `DomainModule` (esquema, validación, vistas,
 * exportadores, importadores y comandos), sin conocer la especialidad. Un módulo nuevo aparece en todas sin tocar este archivo.
 */

/** Las superficies operan con cualquier módulo: el tipo del documento solo lo conoce el propio módulo. */
export type AnyModule = DomainModule<any>;

export interface FieldIssue {
  path: string;
  message: string;
}

export type Analysis =
  | { status: 'empty' }
  | { status: 'syntax'; error: string }
  | { status: 'schema'; issues: FieldIssue[] }
  | { status: 'ok'; document: unknown; issues: ModuleIssue[] };

/** Interpreta el texto del editor: JSON → esquema del módulo → reglas semánticas del dominio. */
export function analyzeText(module: AnyModule, text: string): Analysis {
  if (!text.trim()) return { status: 'empty' };
  let json: unknown;
  try {
    json = JSON.parse(extractJson(text));
  } catch (error) {
    return { status: 'syntax', error: (error as Error).message };
  }
  return analyzeValue(module, json);
}

export function analyzeValue(module: AnyModule, value: unknown): Analysis {
  const parsed = module.schema.safeParse(value);
  if (!parsed.success) {
    return { status: 'schema', issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.') || '(raíz)', message: i.message })) };
  }
  try {
    return { status: 'ok', document: parsed.data, issues: module.validate(parsed.data) };
  } catch (error) {
    return { status: 'ok', document: parsed.data, issues: [{ severity: 'error', message: `No se pudo analizar el documento: ${(error as Error).message}` }] };
  }
}

export const pretty = (document: unknown): string => JSON.stringify(document, null, 2);

export function countBySeverity(issues: ModuleIssue[]): Record<ModuleIssue['severity'], number> {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const issue of issues) counts[issue.severity] += 1;
  return counts;
}

// ───────────── vistas ─────────────

export interface TraceChoice {
  prefix: string;
  label: string;
  entities: EntityRef[];
}

export interface ViewChoices {
  views: ViewRef[];
  traces: TraceChoice[];
}

/** Las vistas derivadas del documento y las vistas bajo demanda de sus elementos (`<prefijo>:<id>`). */
export function viewChoices(module: AnyModule, document: unknown): ViewChoices {
  const entities = module.entities?.(document) ?? [];
  return {
    views: module.views?.(document) ?? [],
    traces: (module.traceViews ?? [])
      .map((spec) => ({ prefix: spec.prefix, label: spec.label, entities: entities.filter((e) => spec.applies?.(e) ?? true) }))
      .filter((trace) => trace.entities.length > 0),
  };
}

export function traceViewId(prefix: string, entityId: string): string {
  return `${prefix}:${entityId}`;
}

/** `blast:pedidos` → `{ prefix: 'blast', entityId: 'pedidos' }`; `undefined` si no es una vista de traza. */
export function splitTraceView(viewId: string): { prefix: string; entityId: string } | undefined {
  const at = viewId.indexOf(':');
  return at > 0 ? { prefix: viewId.slice(0, at), entityId: viewId.slice(at + 1) } : undefined;
}

export function isKnownView(choices: ViewChoices, viewId: string): boolean {
  if (choices.views.some((v) => v.id === viewId)) return true;
  const trace = splitTraceView(viewId);
  return !!trace && choices.traces.some((t) => t.prefix === trace.prefix && t.entities.some((e) => e.id === trace.entityId));
}

export function viewTitle(choices: ViewChoices, viewId: string): string {
  const view = choices.views.find((v) => v.id === viewId);
  if (view) return view.title;
  const trace = splitTraceView(viewId);
  const spec = trace && choices.traces.find((t) => t.prefix === trace.prefix);
  const entity = spec?.entities.find((e) => e.id === trace!.entityId);
  return spec && entity ? `${spec.label}: ${entity.name}` : viewId;
}

// ───────────── SVG, exportación e importación ─────────────

export function canRender(module: AnyModule): boolean {
  return module.exporters.some((e) => e.id === 'svg');
}

export async function renderSvg(module: AnyModule, document: unknown, viewId?: string): Promise<string> {
  const exporter = module.exporters.find((e) => e.id === 'svg');
  if (!exporter) throw new Error(`El módulo «${module.name}» no ofrece vista de diagrama.`);
  return exporter.export(document, { viewId });
}

export interface ExportedFile {
  format: string;
  data: string;
  mime: string;
  extension: string;
}

export interface ExportFormatInfo {
  id: string;
  label: string;
  extension: string;
  mime: string;
}

/** `json` (el documento tal cual) siempre está; el resto son los exportadores del módulo. */
export function exportFormats(module: AnyModule): ExportFormatInfo[] {
  return [
    { id: 'json', label: 'JSON', extension: '.json', mime: 'application/json' },
    ...module.exporters.map((e) => ({ id: e.id, label: e.label, extension: e.extension, mime: e.mime })),
  ];
}

export async function exportDocument(module: AnyModule, document: unknown, format: string, context: ExportContext = {}): Promise<ExportedFile> {
  if (format === 'json') return { format, data: pretty(document), mime: 'application/json', extension: '.json' };
  const exporter = module.exporters.find((e) => e.id === format);
  if (!exporter) {
    const available = exportFormats(module).map((f) => f.id).join(', ');
    throw new Error(`El módulo «${module.id}» no exporta a «${format}». Formatos: ${available}.`);
  }
  return { format, data: await exporter.export(document, context), mime: exporter.mime, extension: exporter.extension };
}

export interface ImportResult {
  document: unknown;
  warnings: string[];
  importer: string;
}

/** Importa texto de otro formato; sin `importerId` se reconoce por el contenido. */
export async function importText(module: AnyModule, text: string, importerId?: string, context: ImportContext = {}): Promise<ImportResult> {
  const importer = importerId ? module.importers.find((i) => i.id === importerId) : module.importers.find((i) => i.detect?.(text));
  if (!importer) {
    const known = module.importers.map((i) => i.id).join(', ') || 'ninguno';
    throw new Error(importerId ? `El módulo «${module.id}» no importa «${importerId}». Formatos: ${known}.` : `No se reconoce el formato del texto. Formatos que importa «${module.id}»: ${known}.`);
  }
  const outcome = await importer.import(text, context);
  return { document: outcome.document, warnings: outcome.warnings, importer: importer.id };
}

// ───────────── importar varios archivos ─────────────

const extensionOf = (name: string): string => /\.[^./\\]+$/.exec(name.toLowerCase())?.[0] ?? '';

/** Orden estable de los archivos de una importación: por nombre sin distinguir mayúsculas y, si empatan, por el nombre tal cual. */
function byName(a: SourceFile, b: SourceFile): number {
  const x = a.name.toLowerCase();
  const y = b.name.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Prepara varios archivos para un importador `multiFile`: los ordena por nombre (el resultado no depende del orden en que se
 * eligieron), concatena sus textos con un salto de línea entre uno y otro (`text`, el que recibe `import` y el que sirve para
 * reconocer el formato) y deja el detalle por archivo en `extra.files`.
 */
export function joinSourceFiles(files: SourceFile[]): { text: string; extra: { files: SourceFile[] } } {
  const sorted = [...files].sort(byName);
  return { text: sorted.map((f) => f.text).join('\n'), extra: { files: sorted } };
}

/** Los `files` de `context.extra` de un importador `multiFile`, si vienen bien formados. */
export function sourceFilesOf(extra: Record<string, unknown> | undefined): SourceFile[] | undefined {
  const files = extra?.files;
  if (!Array.isArray(files) || files.length === 0) return undefined;
  return files.every((f) => f && typeof f.name === 'string' && typeof f.text === 'string') ? (files as SourceFile[]) : undefined;
}

/**
 * Importador que lee juntos los archivos `names`: el pedido con `importerId` o, sin pedirlo, el que declara `multiFile` con la
 * extensión de todos. `undefined` si no hay ninguno. Con `importerId` los nombres también deben ser de sus extensiones.
 */
export function multiFileImporter<TDoc>(module: DomainModule<TDoc>, names: string[], importerId?: string): Importer<TDoc> | undefined {
  const candidates = module.importers.filter((i) => i.multiFile && (importerId === undefined || i.id === importerId));
  return candidates.find((i) => names.every((n) => i.multiFile!.extensions.includes(extensionOf(n))));
}

/** Por qué no se pueden leer juntos los archivos `names` con ese importador (o con ninguno), dicho a quien los eligió. */
export function whyNotMultiFile(module: AnyModule, names: string[], importerId?: string): string {
  const joinable = module.importers.filter((i) => i.multiFile);
  if (importerId !== undefined && !module.importers.some((i) => i.id === importerId)) {
    return `El módulo «${module.id}» no importa «${importerId}». Formatos: ${module.importers.map((i) => i.id).join(', ') || 'ninguno'}.`;
  }
  if (importerId !== undefined && !joinable.some((i) => i.id === importerId)) return `El formato «${importerId}» no se puede leer repartido en varios archivos: importa uno solo.`;
  if (joinable.length === 0) return `El módulo «${module.id}» no importa varios archivos a la vez: importa uno solo.`;
  // Un grupo de extensiones por formato: «.tf o los .yaml, .yml» deja claro que se juntan los de un mismo formato, no unos con otros.
  const groups = (importerId === undefined ? joinable : joinable.filter((i) => i.id === importerId)).map((i) => i.multiFile!.extensions.join(', '));
  return `Los archivos (${names.join(', ')}) no son todos del mismo formato: solo se leen juntos los ${groups.join(' o los ')}.`;
}

/**
 * Importa varios archivos como uno solo con un importador `multiFile` (p. ej. los `.tf` de una carpeta). Con un solo archivo
 * es una importación normal. Falla con un mensaje claro (`whyNotMultiFile`) si los archivos no son todos del mismo formato o
 * si el formato no se puede repartir en varios archivos.
 */
export async function importFiles(module: AnyModule, files: SourceFile[], importerId?: string, context: ImportContext = {}): Promise<ImportResult> {
  if (files.length === 0) throw new Error('No hay ningún archivo que importar.');
  const names = files.map((f) => f.name);
  const importer = multiFileImporter(module, names, importerId);
  if (!importer) throw new Error(whyNotMultiFile(module, names, importerId));
  const joined = joinSourceFiles(files);
  return importText(module, joined.text, importer.id, { ...context, extra: { ...context.extra, ...joined.extra } });
}

// ───────────── comandos (informes y conversiones) ─────────────

export interface OptionInfo {
  /** Clave en `options` (camelCase, como la entrega commander). */
  key: string;
  flags: string;
  takesValue: boolean;
  description: string;
  default?: string | boolean;
  /** Lee o escribe en la máquina que ejecuta el comando (ver `CommandOption.local`): las superficies remotas no deben ofrecerla. */
  local?: boolean;
}

export interface CommandInfo {
  name: string;
  description: string;
  kind: 'report' | 'convert';
  /** Si el comando lee un documento (el del editor, o el de otro módulo si es una conversión). */
  needsInput: boolean;
  inputDescription?: string;
  args: NonNullable<CommandSpec['args']>;
  options: OptionInfo[];
}

const camel = (name: string): string => name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** El nombre largo de una opción (`-o, --out <archivo>` → `out`). */
function longName(option: CommandOption): string {
  const long = /--([a-z0-9][a-z0-9-]*)/i.exec(option.flags);
  if (!long) throw new Error(`Opción de comando sin nombre largo: «${option.flags}».`);
  return long[1];
}

export function optionInfo(option: CommandOption): OptionInfo {
  return {
    key: camel(longName(option)),
    flags: option.flags,
    takesValue: /[<[][^>\]]+[>\]]/.test(option.flags),
    description: option.description,
    default: option.default,
    ...(option.local ? { local: true } : {}),
  };
}

export function commandInfos(module: AnyModule): CommandInfo[] {
  return (module.cliCommands ?? []).map((spec) => ({
    name: spec.name,
    description: spec.description,
    kind: spec.kind ?? 'report',
    needsInput: !!spec.input,
    inputDescription: spec.input?.description,
    args: spec.args ?? [],
    options: (spec.options ?? []).map(optionInfo),
  }));
}

export interface CommandRun {
  args?: string[];
  /** Valores por clave; las vacías se ignoran. */
  options?: Record<string, string | boolean | undefined>;
  input?: string;
}

export interface CommandOutput {
  command: string;
  kind: 'report' | 'convert';
  output: string;
  warnings: string[];
}

/** Desde dónde se ejecuta el comando. */
export interface CommandRunContext {
  /**
   * Lo ejecuta el servicio HTTP en nombre de un cliente que no es dueño de la máquina: los argumentos y las opciones marcados
   * `local` (ver `CommandOption.local`) se rechazan sin llegar a ejecutar nada. Por omisión (CLI local, banco de trabajo), no.
   */
  remote?: boolean;
}

/** Lo que se le dice a quien pide una opción local a un servicio remoto: no depende de lo que pidió (existe o no el archivo, qué ruta). */
const remoteRefusal = (what: string): string =>
  `${what} solo está disponible en el CLI local: lee o escribe en el sistema de archivos de la máquina que ejecuta el comando, y el servicio no lo hace a petición de un cliente remoto.`;

export async function runCommand(module: AnyModule, name: string, run: CommandRun, context: CommandRunContext = {}): Promise<CommandOutput> {
  const spec = module.cliCommands?.find((c) => c.name === name);
  if (!spec) {
    const known = (module.cliCommands ?? []).map((c) => c.name).join(', ') || 'ninguno';
    throw new Error(`El módulo «${module.id}» no tiene el comando «${name}». Comandos: ${known}.`);
  }
  const provided = (value: unknown): boolean => value !== undefined && value !== '' && value !== false;
  if (context.remote) {
    // Antes que cualquier otra comprobación y sin tocar nada: la respuesta es la misma exista o no lo que se pide.
    for (const option of spec.options ?? []) {
      if (option.local && provided(run.options?.[optionInfo(option).key])) throw new Error(remoteRefusal(`La opción «--${longName(option)}» de «${name}»`));
    }
    for (const [index, arg] of (spec.args ?? []).entries()) {
      if (arg.local && provided(run.args?.[index]?.trim())) throw new Error(remoteRefusal(`El argumento «${arg.name}» de «${name}»`));
    }
  }
  const args = run.args ?? [];
  for (const [index, arg] of (spec.args ?? []).entries()) {
    if (arg.required && !args[index]?.trim()) throw new Error(`Falta el argumento «${arg.name}» (${arg.description}).`);
  }
  const options: Record<string, unknown> = {};
  for (const declared of spec.options ?? []) {
    const option = optionInfo(declared);
    const value = run.options?.[option.key];
    if (provided(value)) options[option.key] = value;
    // Un valor por omisión tampoco rellena una opción local en remoto: sería una ruta que nadie pidió.
    else if (option.default !== undefined && !(context.remote && declared.local)) options[option.key] = option.default;
  }
  if (spec.input && !run.input?.trim()) throw new Error(`Falta la entrada: ${spec.input.description}.`);
  const warnings: string[] = [];
  const result = await spec.run({ args: args.map((a) => a.trim()), options, input: run.input, warn: (m) => warnings.push(m.replace(/\n+$/, '')) });
  return { command: name, kind: spec.kind ?? 'report', output: result ?? '', warnings };
}

// ───────────── capacidades (handshake del protocolo embebido) ─────────────

export interface ModuleCapabilities {
  id: string;
  name: string;
  version: string;
  description?: string;
  documentVersion: string;
  /** El banco de trabajo dibuja las vistas del módulo (tiene exportador `svg`). */
  render: boolean;
  importFormats: Array<{ id: string; label: string; extensions: string[] }>;
  exportFormats: ExportFormatInfo[];
  traceViews: Array<{ prefix: string; label: string }>;
  commands: Array<{ name: string; description: string; kind: 'report' | 'convert'; needsInput: boolean; args: string[]; options: string[] }>;
  ai: boolean;
}

export function moduleCapabilities(module: AnyModule): ModuleCapabilities {
  return {
    id: module.id,
    name: module.name,
    version: module.version,
    ...(module.description ? { description: module.description } : {}),
    documentVersion: module.documentVersion,
    render: canRender(module),
    importFormats: module.importers.map((i) => ({ id: i.id, label: i.label, extensions: i.extensions })),
    exportFormats: exportFormats(module),
    traceViews: (module.traceViews ?? []).map((t) => ({ prefix: t.prefix, label: t.label })),
    commands: commandInfos(module).map((c) => ({
      name: c.name,
      description: c.description,
      kind: c.kind,
      needsInput: c.needsInput,
      args: c.args.map((a) => a.name),
      options: c.options.map((o) => o.key),
    })),
    ai: !!module.ai,
  };
}

/**
 * Posición del primer `"id": "<id>"` del texto: para llevar el cursor del editor al elemento al que se refiere un
 * problema.
 */
export function locateId(text: string, id: string): { index: number; length: number } | undefined {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`"id"\\s*:\\s*"${escaped}"`).exec(text);
  return match ? { index: match.index, length: match[0].length } : undefined;
}
