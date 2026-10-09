import { extname } from 'node:path';
import { generateStructured, moduleStandalonePrompt, type DomainModule, type ModuleRegistry } from '@iark/kernel';
import { DEFAULT_AI_MODEL } from '@core/ai/generate';
import { reportGeneration, tokenLimitOptions, withAiErrors, type RepoHint } from './ai';
import { CliError, extractJson, info, readInput, writeOutput } from './io';

/**
 * Comandos que funcionan con cualquier módulo de la suite a través de su contrato (`DomainModule`): validar, esquema,
 * prompt, generar con IA y convertir. El módulo C4 conserva sus comandos específicos (autolayout con métricas, drawio).
 */

const jsonOut = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Interpreta un texto ya leído (JSON, también envuelto en un bloque ```json) como documento del módulo y lo valida con su esquema. */
export function parseModuleDocumentText(module: DomainModule<any>, raw: string): unknown {
  let json: unknown;
  try {
    json = JSON.parse(extractJson(raw));
  } catch (error) {
    throw new CliError(`La entrada no es JSON válido: ${(error as Error).message}`);
  }
  const parsed = module.schema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `- ${i.path.join('.') ? `${i.path.join('.')}: ` : ''}${i.message}`).join('\n');
    throw new CliError(`Documento inválido para el módulo «${module.id}»:\n${issues}`, 2);
  }
  return parsed.data;
}

/** Lee y valida un documento del módulo con su esquema. */
export function readModuleDocument(module: DomainModule<any>, file: string | undefined, useStdin: boolean): unknown {
  return parseModuleDocumentText(module, readInput(file, useStdin));
}

export function genericValidate(module: DomainModule<any>, file: string | undefined, opts: { stdin?: boolean; strict?: boolean }): void {
  const document = readModuleDocument(module, file, opts.stdin ?? false);
  const issues = module.validate(document);
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  for (const i of issues) process.stdout.write(`${i.severity === 'error' ? 'error   ' : i.severity === 'warning' ? 'aviso   ' : 'info    '} ${i.message}\n`);
  process.stdout.write(`Documento válido (módulo ${module.id}). ${errors.length} error(es), ${warnings.length} aviso(s), ${issues.length - errors.length - warnings.length} nota(s).\n`);
  if (errors.length > 0 || (opts.strict && warnings.length > 0)) process.exitCode = 3;
}

export function genericSchema(module: DomainModule<any>, generation: boolean): void {
  if (generation) {
    if (!module.ai) throw new CliError(`El módulo «${module.id}» no genera con IA.`, 2);
    process.stdout.write(jsonOut(module.ai.generationJsonSchema()));
  } else process.stdout.write(jsonOut(module.jsonSchema()));
}

/** El prompt autocontenido del módulo (el que imprime `prompt`), para escribirlo o para estimar su tamaño. */
export function genericPromptText(module: DomainModule<any>, instruction: string, base: unknown): string {
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
