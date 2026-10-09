import { extname } from 'node:path';
import { generateStructured, migrateDocument, moduleStandalonePrompt, parseModuleDocument, type DocumentMigrated, type DomainModule, type ModuleRegistry } from '@iark/kernel';
import { DEFAULT_AI_MODEL } from '@core/ai/generate';
import { reportGeneration, tokenLimitOptions, withAiErrors, type RepoHint } from './ai';
import { CliError, extractJson, info, noteMigration, readInput, writeOutput } from './io';

/**
 * Comandos que funcionan con cualquier módulo de la suite a través de su contrato (`DomainModule`): validar, esquema,
 * prompt, generar con IA y convertir. El módulo C4 conserva sus comandos específicos (autolayout con métricas, drawio).
 */

const jsonOut = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Interpreta un texto (JSON, también envuelto en un bloque ```json). */
function parseJsonText(raw: string): unknown {
  try {
    return JSON.parse(extractJson(raw));
  } catch (error) {
    throw new CliError(`La entrada no es JSON válido: ${(error as Error).message}`);
  }
}

function readJson(file: string | undefined, useStdin: boolean): unknown {
  return parseJsonText(readInput(file, useStdin));
}

/** El documento ya parseado (con los problemas de esquema como `CliError` de código 2) y, si venía de una versión anterior, de dónde. */
function parseDocumentJson(module: DomainModule<any>, json: unknown): { document: unknown; migrated?: DocumentMigrated } {
  const parsed = parseModuleDocument(module, json);
  if (!parsed.ok) {
    const issues = parsed.issues.map((i) => `- ${i.path !== '(raíz)' ? `${i.path}: ` : ''}${i.message}`).join('\n');
    throw new CliError(`Documento inválido para el módulo «${module.id}»:\n${issues}`, 2);
  }
  return { document: parsed.document, migrated: parsed.migrated };
}

/**
 * Lee un documento del módulo, lo lleva a la versión actual si venía de una anterior (`DomainModule.migrations`) y lo valida con
 * su esquema. `migrated` dice de qué versión venía, si hubo que migrarlo.
 */
export function readModuleDocumentInfo(module: DomainModule<any>, file: string | undefined, useStdin: boolean): { document: unknown; migrated?: DocumentMigrated } {
  return parseDocumentJson(module, readJson(file, useStdin));
}

/** Como `readModuleDocumentInfo`, avisando por stderr si hubo que migrar el documento. */
export function readModuleDocument(module: DomainModule<any>, file: string | undefined, useStdin: boolean): unknown {
  const { document, migrated } = readModuleDocumentInfo(module, file, useStdin);
  noteMigration(migrated);
  return document;
}

/** Interpreta un texto ya leído como documento del módulo: lo migra si hace falta y lo valida con su esquema, igual que `readModuleDocument`. */
export function parseModuleDocumentText(module: DomainModule<unknown>, raw: string): unknown {
  const { document, migrated } = parseDocumentJson(module, parseJsonText(raw));
  noteMigration(migrated);
  return document;
}

export function genericValidate(module: DomainModule<any>, file: string | undefined, opts: { stdin?: boolean; strict?: boolean }): void {
  const { document, migrated } = readModuleDocumentInfo(module, file, opts.stdin ?? false);
  // En la salida estándar, con el resto del informe: es parte de lo que `validate` cuenta del documento.
  if (migrated) process.stdout.write(`info     Documento migrado de la versión ${migrated.from} a ${migrated.to}; \`iark migrate\` lo reescribe en la nueva.\n`);
  const issues = module.validate(document);
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  for (const i of issues) process.stdout.write(`${i.severity === 'error' ? 'error   ' : i.severity === 'warning' ? 'aviso   ' : 'info    '} ${i.message}\n`);
  process.stdout.write(`Documento válido (módulo ${module.id}). ${errors.length} error(es), ${warnings.length} aviso(s), ${issues.length - errors.length - warnings.length} nota(s).\n`);
  if (errors.length > 0 || (opts.strict && warnings.length > 0)) process.exitCode = 3;
}

/**
 * `iark migrate`: lleva un documento guardado con una versión anterior del formato del módulo a la actual y lo escribe (en
 * `--out` o por la salida estándar). Con `--check` no escribe nada y termina con código 1 si el documento necesita migración
 * (para la integración continua). Un documento de una versión más nueva, o anterior sin migración, termina con código 2.
 */
export function genericMigrate(module: DomainModule<any>, file: string | undefined, opts: { stdin?: boolean; out?: string; check?: boolean }): void {
  const json = readJson(file, opts.stdin ?? false);
  const migration = migrateDocument(module, json);
  if (migration.status === 'unsupported') throw new CliError(migration.message, 2);
  // Se valida siempre (también con --check): un documento migrado que el esquema rechaza es un problema que el comando debe decir.
  const { document } = parseDocumentJson(module, json);
  if (migration.status !== 'migrated') {
    info(`El documento ya está en la versión ${module.documentVersion} del módulo «${module.id}»: no necesita migración.`);
    if (!opts.check) writeOutput(opts.out, jsonOut(document));
    return;
  }
  info(`Documento del módulo «${module.id}»: versión ${migration.from} → ${migration.to}.`);
  for (const step of migration.steps) info(`  ${step.from} → ${step.to}${step.description ? `: ${step.description}` : ''}`);
  if (opts.check) {
    info('Necesita migración: ejecuta `iark migrate` para reescribirlo en la versión actual.');
    process.exitCode = 1;
    return;
  }
  writeOutput(opts.out, jsonOut(document));
  if (opts.out) info(`Documento migrado escrito en ${opts.out}`);
}

export function genericSchema(module: DomainModule<any>, generation: boolean): void {
  if (generation) {
    if (!module.ai) throw new CliError(`El módulo «${module.id}» no genera con IA.`, 2);
    process.stdout.write(jsonOut(module.ai.generationJsonSchema()));
  } else process.stdout.write(jsonOut(module.jsonSchema()));
}

/** El prompt autocontenido del módulo (el que imprime `prompt`), para escribirlo o para estimar su tamaño. */
export function genericPromptText(module: DomainModule<unknown>, instruction: string, base: unknown): string {
  if (!module.ai) throw new CliError(`El módulo «${module.id}» no genera con IA.`, 2);
  return moduleStandalonePrompt(module.ai, instruction, base);
}

export function genericPrompt(module: DomainModule<any>, instruction: string, base: unknown): void {
  process.stdout.write(genericPromptText(module, instruction, base));
}

/** Exporta un documento con el exportador del módulo indicado por id (o por extensión del archivo de salida). */
export async function genericExport(module: DomainModule<any>, document: unknown, to: string | undefined, out: string | undefined, viewId: string | undefined, options?: Record<string, unknown>): Promise<void> {
  const ext = out ? extname(out).toLowerCase() : '';
  if (module.exporters.length === 0) throw new CliError(`El módulo «${module.id}» no tiene exportadores.`, 2);
  const exporter = to ? module.exporters.find((e) => e.id === to) : module.exporters.find((e) => e.extension === ext) ?? module.exporters[0];
  if (!exporter) {
    throw new CliError(`Formato de salida inválido «${to}» para el módulo «${module.id}». Use: ${module.exporters.map((e) => e.id).join(', ')}.`, 2);
  }
  const text = await exporter.export(document, { viewId, options });
  writeOutput(out, text.endsWith('\n') ? text : `${text}\n`);
  if (out) info(`Exportado a ${exporter.label} en ${out}`);
}

export async function genericGenerate(
  module: DomainModule<any>,
  instruction: string,
  opts: {
    base?: unknown;
    provider?: string;
    model?: string;
    effort?: string;
    retries: number;
    json?: string;
    out?: string;
    viewId?: string;
    maxTokens?: number;
    budgetTokens?: number;
    maxInputTokens?: number;
    /** `false` (`--no-verify`): no pasar el resultado por `validate()` del módulo. */
    verify?: boolean;
    /** `--allow-invalid`: aceptar un documento con errores de reglas tras agotar los reintentos. */
    allowInvalid?: boolean;
    /** `--strict`: los avisos de `validate()` también se devuelven al modelo. */
    strict?: boolean;
    /** Con `--from-repo`: para que un prompt demasiado grande diga qué recortar. */
    repo?: RepoHint;
  },
): Promise<void> {
  if (!module.ai) throw new CliError(`El módulo «${module.id}» no genera con IA.`, 2);
  const ai = module.ai;
  const result = await withAiErrors(
    () =>
      generateStructured(ai, {
        instruction,
        base: opts.base,
        defaultModel: DEFAULT_AI_MODEL,
        provider: opts.provider as never,
        model: opts.model,
        effort: opts.effort as never,
        maxRetries: opts.retries,
        ...tokenLimitOptions(opts),
        validate: module.validate,
        verify: opts.verify,
        allowInvalid: opts.allowInvalid,
        retryOn: opts.strict ? 'warning' : 'error',
        onProgress: info,
      }),
    opts.repo,
  );
  const document = ai.finish ? await ai.finish(result.document) : result.document;
  info(`Modelo generado con ${result.model} (${result.provider}) en ${result.attempts} intento(s) (${result.usage.inputTokens} tokens de entrada, ${result.usage.outputTokens} de salida).`);
  reportGeneration(result);
  if (opts.json) {
    writeOutput(opts.json, jsonOut(document));
    info(`JSON escrito en ${opts.json}`);
  }
  if (opts.out) await genericExport(module, document, undefined, opts.out, opts.viewId);
  if (!opts.json && !opts.out) process.stdout.write(jsonOut(document));
}

export function requireModule(registry: ModuleRegistry, id: string): DomainModule<any> {
  return registry.require(id);
}
