import { existsSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { applyLayoutToView, autoLayoutDocumentWithQuality, layoutView } from '@core/layout/elkLayout';
import { formatQuality, type LayoutQuality } from '@core/layout/quality';
import { sampleDocument } from '@core/model/sample';
import { toDrawio, DrawioExportError, type DrawioNotation } from '@core/export/drawio/toDrawio';
import { DrawioImportError } from '@core/import/drawio/fromDrawio';
import { DslImportError } from '@core/import/structurizr/fromStructurizrDsl';
import { MermaidImportError } from '@core/import/mermaid/fromMermaid';
import { toMermaid, MermaidExportError, type MermaidFormat } from '@core/export/mermaid/toMermaid';
import { documentJsonSchema, DocumentValidationError, formatIssues, validateDocument } from '@core/model/schema';
import type { LayoutDensity, LayoutDirectionOption, LayoutDistribution } from '@core/model/types';
import { generationJsonSchema } from '@core/ai/generationSchema';
import { standalonePrompt } from '@core/ai/prompt';
import { DEFAULT_AI_MODEL, generateDocument, GenerationError, type Effort } from '@core/ai/generate';
import { analyzeDocument } from '@core/model/issues';
import { buildManifest, contractVersionOf, joinSourceFiles, ModuleError, ProjectError, type ModuleRegistry, UnknownModuleError } from '@iark/kernel';
import { createDefaultRegistry, createRegistry, DEFAULT_MODULE, resolveConfigPlugins } from './registry';
import { CONFIG_FILE_NAME, ConfigError, readConfig, scanGlobalFlags, selectConfig, type LoadedConfig } from './plugins/config';
import { PluginError, type ResolvedPlugin } from './plugins/resolve';
import { ComputePool } from './computePool';
import { addComputeOptions, resolveComputeSettings } from './computeConfig';
import { createSuiteServer } from './serve';
import { addObservabilityOptions, setupObservability } from './observability/options';
import { isLoopbackHost } from './serveAuth';
import { parseFrameAncestors } from './securityHeaders';
import { registerTrace } from './trace';
import { registerDiff } from './diff';
import { registerProject } from './project';
import { registerAuth } from './auth';
import { setupAccounts } from './accounts/setup';
import { TokenError, TokenStore } from './tokens';
import { FolderProjectStore } from './workspace';
import { genericExport, genericGenerate, genericMigrate, genericPrompt, genericSchema, genericValidate, readModuleDocument } from './generic';
import { CliError, dslIncludeOptions, extractJson, fallbackDocumentName, info, readDocument, readInput, writeOutput } from './io';
import { readMultiInput, type MultiInput } from './multiFile';
import { assertRepoFlags, collectRepoExclude, collectRepoInclude, DRY_RUN_HELP, FROM_REPO_HELP, FROM_REPO_PROMPT_HELP, parseRepoBudget, parseRepoRef, prepareRepo, REPO_BUDGET_HELP, REPO_EXCLUDE_HELP, REPO_INCLUDE_HELP, REPO_PRIVACY_HELP, REPO_PROMPT_HELP, REPO_REF_HELP, reportRepoFiles, reportRepoSummary } from './repo';

const CLI_VERSION = '0.1.0';

const DIRECTIONS: LayoutDirectionOption[] = ['auto', 'DOWN', 'RIGHT', 'LEFT', 'UP'];
const DISTRIBUTIONS: LayoutDistribution[] = ['auto', 'centered', 'elk'];
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function parseDirection(value: string): LayoutDirectionOption {
  const v = (value.toLowerCase() === 'auto' ? 'auto' : value.toUpperCase()) as LayoutDirectionOption;
  if (!DIRECTIONS.includes(v)) throw new InvalidArgumentError(`Dirección inválida. Use: ${DIRECTIONS.join(', ')}`);
  return v;
}

function parseDistribution(value: string): LayoutDistribution {
  const v = value.toLowerCase() as LayoutDistribution;
  if (!DISTRIBUTIONS.includes(v)) throw new InvalidArgumentError(`Distribución inválida. Use: ${DISTRIBUTIONS.join(', ')}`);
  return v;
}

function parseEffort(value: string): Effort {
  const v = value.toLowerCase() as Effort;
  if (!EFFORTS.includes(v)) throw new InvalidArgumentError(`Esfuerzo inválido. Use: ${EFFORTS.join(', ')}`);
  return v;
}

const PROVIDERS = ['auto', 'anthropic', 'foundry', 'openai'] as const;

function parseProvider(value: string): (typeof PROVIDERS)[number] {
  const v = value.toLowerCase() as (typeof PROVIDERS)[number];
  if (!PROVIDERS.includes(v)) throw new InvalidArgumentError(`Plataforma inválida. Use: ${PROVIDERS.join(', ')}`);
  return v;
}

const DENSITIES: LayoutDensity[] = ['auto', 'compact', 'spacious'];

function parseDensity(value: string): LayoutDensity {
  const v = value.toLowerCase() as LayoutDensity;
  if (!DENSITIES.includes(v)) throw new InvalidArgumentError(`Densidad inválida. Use: ${DENSITIES.join(', ')}`);
  return v;
}

/**
 * Importa una fuente con un importador del módulo: el indicado con `--format` o, si es `auto`, el que se deduce de la
 * extensión o del contenido. Con `multi` (una carpeta o varios archivos que se leen juntos) usa el importador que ya se
 * eligió al leerlos y le pasa los archivos como los pide `Importer.multiFile`.
 */
async function importSource(
  registry: ModuleRegistry,
  moduleId: string,
  input: { file?: string; raw: string; format?: string; name?: string; fromFile: boolean; multi?: MultiInput },
): Promise<{ format: string; document: any; warnings: string[] }> {
  const module = registry.require(moduleId);
  const ids = module.importers.map((i) => i.id).sort();
  const requested = (input.format ?? 'auto').toLowerCase();
  if (requested !== 'auto' && !ids.includes(requested)) {
    throw new CliError(`Formato inválido «${input.format}». Use: auto, ${ids.join(', ')}.`, 2);
  }
  if (input.multi) {
    const importer = module.importers.find((i) => i.id === input.multi!.importerId)!;
    const joined = joinSourceFiles(input.multi.files);
    const outcome = await importer.import(joined.text, {
      name: input.name,
      fallbackName: fallbackDocumentName(input.multi.base, module.importers.flatMap((i) => i.extensions)),
      file: input.multi.base,
      extra: joined.extra,
    });
    return { format: importer.id, document: outcome.document, warnings: outcome.warnings };
  }
  const importer =
    requested === 'auto'
      ? registry.detectImporter<unknown>(moduleId, input.fromFile ? input.file : undefined, input.raw)
      : module.importers.find((i) => i.id === requested);
  if (!importer) {
    const list = ids.length > 1 ? `${ids.slice(0, -1).join(', ')} o ${ids[ids.length - 1]}` : ids.join(', ');
    throw new CliError(`No se reconoce el formato${input.fromFile ? ` de "${input.file}"` : ' de la entrada'}: use --format ${list}.`, 2);
  }
  const fallbackName = input.fromFile && input.file ? fallbackDocumentName(input.file, module.importers.flatMap((i) => i.extensions)) : undefined;
  const outcome = await importer.import(input.raw, {
    name: input.name,
    fallbackName,
    file: input.fromFile ? input.file : undefined,
    // Solo el DSL de Structurizr lo usa (resolver `!include` sin salir de la carpeta del archivo).
    extra: input.fromFile && input.file ? dslIncludeOptions(input.file) : undefined,
  });
  return { format: importer.id, document: outcome.document, warnings: outcome.warnings };
}

/** Documento base de `generate`/`prompt --from`: un JSON del modelo o cualquier fuente importable (.drawio, .dsl, .mmd). */
async function readBaseDocument(registry: ModuleRegistry, file: string, moduleId = DEFAULT_MODULE): Promise<any> {
  const raw = readInput(file, false);
  if (extname(file).toLowerCase() === '.json' || raw.trimStart().startsWith('{')) {
    return moduleId === DEFAULT_MODULE ? readDocument(file, false) : readModuleDocument(registry.require(moduleId), file, false);
  }
  const imported = await importSource(registry, moduleId, { file, raw, fromFile: true });
  for (const warning of imported.warnings) info(`aviso: ${warning}`);
  info(`Documento base importado de ${imported.format}.`);
  return imported.document;
}

/** Imprime el prompt autocontenido del módulo (sin llamar a ningún modelo): `prompt` y `generate --from-repo --dry-run`. */
async function emitPrompt(registry: ModuleRegistry, moduleId: string, instruction: string, base: any): Promise<void> {
  if (moduleId !== DEFAULT_MODULE) return genericPrompt(registry.require(moduleId), instruction, base);
  process.stdout.write(standalonePrompt(instruction, base));
}

function parseTarget(value: string): 'drawio' | 'mermaid' {
  const v = value.toLowerCase();
  if (v !== 'drawio' && v !== 'mermaid') throw new InvalidArgumentError('Formato de salida inválido. Use: drawio, mermaid');
  return v;
}

function parseMermaidFormat(value: string): MermaidFormat {
  const v = value.toLowerCase();
  if (v !== 'c4' && v !== 'flowchart') throw new InvalidArgumentError('Formato de Mermaid inválido. Use: c4, flowchart');
  return v;
}

function parseNotation(value: string): DrawioNotation {
  const v = value.toLowerCase();
  if (v !== 'c4' && v !== 'card') throw new InvalidArgumentError('Notación inválida. Use: c4, card');
  return v;
}

function parsePositiveNumber(value: string, label: string): number {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError(`${label} debe ser un número positivo.`);
  return n;
}

function parseSpacing(value: string): number {
  return parsePositiveNumber(value, 'La separación');
}

function parseLayerSpacing(value: string): number {
  return parsePositiveNumber(value, 'La separación entre capas');
}

function parseRetries(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError('Los reintentos deben ser un entero ≥ 0.');
  return n;
}

function parsePort(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new InvalidArgumentError('El puerto debe ser un entero entre 0 y 65535.');
  return n;
}

function reportQuality(items: Array<{ viewId: string; quality?: LayoutQuality; direction?: string; distribution?: string }>): void {
  for (const { viewId, quality, direction, distribution } of items) {
    if (!quality) continue;
    const chosen = [direction, distribution === 'centered' ? 'centrado' : distribution === 'elk' ? 'ELK' : undefined].filter(Boolean).join(' ');
    info(`  ${viewId}: ${formatQuality(quality)}${chosen ? ` · ${chosen}` : ''}${quality.strategy ? ` (estrategia ${quality.strategy})` : ''}`);
  }
}

function jsonOut(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Lo que `run` descubre antes de construir el árbol de comandos y que algunos comandos necesitan. */
export interface ProgramSettings {
  /** Módulo que usan por omisión los comandos con `--module` (`defaultModule` de `iark.config.json`); por omisión, c4. */
  defaultModule?: string;
  /** Los módulos de terceros ya resueltos: `iark serve` se los pasa a los hilos de cálculo, que construyen su propio registro. */
  plugins?: ResolvedPlugin[];
}

export function buildProgram(registry: ModuleRegistry = createDefaultRegistry(), settings: ProgramSettings = {}): Command {
  const defaultModule = settings.defaultModule ?? DEFAULT_MODULE;
  const program = new Command();
  program
    .name('iark')
    .description('IArk - DIAgrams: genera modelos con IA, aplica autolayout y exporta a .drawio, sin navegador.')
    .version(CLI_VERSION)
    .configureOutput({ writeErr: (s) => process.stderr.write(s) })
    // La configuración se decide en `run`, antes de construir los comandos (los de un módulo de terceros salen de ella); estas dos
    // opciones solo existen aquí para que commander las acepte (antes o después del comando) y las muestre en la ayuda.
    .option('--config <archivo>', `carga los módulos de terceros de este ${CONFIG_FILE_NAME} (o la variable IARK_CONFIG); por omisión, el ${CONFIG_FILE_NAME} del directorio actual si existe. Cargar un módulo ejecuta su código con los permisos de este proceso`)
    .option('--no-config', `no carga ninguna configuración, ni la del directorio actual ni IARK_CONFIG (o IARK_NO_CONFIG=1)`);

  program
    .command('generate')
    .description('Genera (o refina con --from) un modelo C4 a partir de una instrucción en lenguaje natural usando Claude u otro modelo de Foundry')
    .argument('<instrucción>', 'descripción del sistema o instrucción de refinamiento')
    .option('-o, --out <archivo.drawio>', 'archivo .drawio de salida')
    .option('-j, --json <archivo.json>', 'archivo JSON de salida (documento C4 con coordenadas)')
    .option('-f, --from <archivo>', 'documento existente a refinar: JSON, .drawio, .dsl (Structurizr) o .mmd (Mermaid)')
    .option('-p, --provider <plataforma>', 'plataforma: auto|anthropic (API de Anthropic)|foundry (Claude en Foundry)|openai (cualquier modelo de Foundry / API compatible con OpenAI)', parseProvider, 'auto')
    .option('-m, --model <modelo>', `modelo (por defecto ${DEFAULT_AI_MODEL}; en Foundry, el nombre de tu despliegue o AI_MODEL / ANTHROPIC_FOUNDRY_MODEL)`)
    .option('-e, --effort <nivel>', `esfuerzo de razonamiento (${EFFORTS.join('|')})`, parseEffort)
    .option('-d, --direction <dir>', `dirección del autolayout (${DIRECTIONS.join('|')})`, parseDirection)
    .option('--retries <n>', 'reintentos si el modelo devuelve un documento inválido', parseRetries, 1)
    .option('--locale <es|en>', 'idioma de las etiquetas de tipo en el .drawio', 'es')
    .option('--density <auto|compact|spacious>', 'densidad del autolayout', parseDensity)
    .option('--distribution <auto|centered|elk>', 'distribución del autolayout', parseDistribution)
    .option('--notation <c4|card>', 'notación de las figuras en el .drawio', parseNotation, 'c4')
    .option('--module <id>', 'módulo de la suite (ver `iark modules`); con otro que no sea c4, --out exporta según la extensión (.svg, .mmd, .drawio…)', defaultModule)
    .option('--from-repo <carpeta|url>', FROM_REPO_HELP)
    .option('--repo-ref <rama|etiqueta>', REPO_REF_HELP, parseRepoRef)
    .option('--repo-include <glob>', REPO_INCLUDE_HELP, collectRepoInclude)
    .option('--repo-exclude <glob>', REPO_EXCLUDE_HELP, collectRepoExclude)
    .option('--repo-budget <kb>', REPO_BUDGET_HELP, parseRepoBudget)
    .option('--dry-run', DRY_RUN_HELP, false)
    .addHelpText('after', REPO_PRIVACY_HELP)
    .action(async (instruction: string, opts) => {
      assertRepoFlags(opts);
      const base = opts.from ? await readBaseDocument(registry, opts.from, opts.module) : undefined;
      const repo = await prepareRepo(instruction, opts, opts.module);
      if (repo) {
        instruction = repo.instruction;
        if (opts.dryRun) {
          reportRepoFiles(repo.digest);
          await emitPrompt(registry, opts.module, instruction, base);
          return;
        }
        reportRepoSummary(repo.digest, true);
      }
      if (opts.module !== DEFAULT_MODULE) {
        await genericGenerate(registry.require(opts.module), instruction, { base, provider: opts.provider, model: opts.model, effort: opts.effort, retries: opts.retries, json: opts.json, out: opts.out });
        return;
      }
      const result = await generateDocument({
        instruction,
        base,
        provider: opts.provider,
        model: opts.model,
        effort: opts.effort,
        direction: opts.direction,
        distribution: opts.distribution,
        density: opts.density,
        maxRetries: opts.retries,
        onProgress: info,
      });
      const { document } = result;
      info(
        `Modelo generado con ${result.model} (${result.provider}) en ${result.attempts} intento(s): ${document.model.elements.length} elementos, ` +
          `${document.model.relationships.length} relaciones, ${document.views.length} vistas ` +
          `(${result.usage.inputTokens} tokens de entrada, ${result.usage.outputTokens} de salida).`,
      );
      if (opts.json) {
        writeOutput(opts.json, jsonOut(document));
        info(`JSON escrito en ${opts.json}`);
      }
      if (opts.out) {
        writeOutput(opts.out, toDrawio(document, { locale: opts.locale, notation: opts.notation }));
        info(`Diagrama .drawio escrito en ${opts.out}`);
      }
      if (!opts.json && !opts.out) process.stdout.write(jsonOut(document));
    });

  program
    .command('layout')
    .description('Aplica autolayout (ELK) a un documento C4 en JSON; acepta la salida de cualquier IA por stdin')
    .argument('[archivo.json]', 'documento de entrada (o "-" para stdin)')
    .option('--stdin', 'leer el documento de la entrada estándar')
    .option('-o, --out <archivo.json>', 'archivo de salida (por defecto stdout)')
    .option('-d, --direction <dir>', `dirección (${DIRECTIONS.join('|')})`, parseDirection)
    .option('--spacing <px>', 'separación entre nodos', parseSpacing)
    .option('--layer-spacing <px>', 'separación entre capas', parseLayerSpacing)
    .option('--force', 'recalcular aunque ya haya coordenadas', false)
    .option('--density <auto|compact|spacious>', 'densidad del autolayout', parseDensity)
    .option('--distribution <auto|centered|elk>', 'distribución: centrada y uniforme, colocación de ELK o automática', parseDistribution)
    .option('--fast', 'una sola pasada de ELK (sin probar estrategias ni medir calidad)', false)
    .option('--view <id>', 'solo esta vista')
    .action(async (file: string | undefined, opts) => {
      const doc = readDocument(file, opts.stdin);
      const layoutOpts = {
        direction: opts.direction,
        distribution: opts.distribution,
        spacing: opts.spacing,
        layerSpacing: opts.layerSpacing,
        density: opts.density,
        force: opts.force,
        fast: opts.fast,
      };
      let result;
      if (opts.view) {
        const laid = await layoutView(doc, opts.view, layoutOpts);
        result = { ...doc, views: doc.views.map((v) => (v.id === opts.view ? applyLayoutToView(v, laid) : v)) };
        reportQuality([{ viewId: opts.view, quality: laid.quality, direction: laid.direction, distribution: laid.distribution }]);
      } else {
        const laid = await autoLayoutDocumentWithQuality(doc, layoutOpts);
        result = laid.document;
        reportQuality(laid.qualities);
      }
      writeOutput(opts.out, jsonOut(result));
      if (opts.out) info(`Documento con autolayout escrito en ${opts.out}`);
    });

  program
    .command('convert')
    .description('Convierte un documento C4 en JSON a .drawio (aplica autolayout si faltan coordenadas)')
    .argument('[archivo.json]', 'documento de entrada (o "-" para stdin)')
    .option('--stdin', 'leer el documento de la entrada estándar')
    .option('-o, --out <archivo.drawio>', 'archivo de salida (por defecto stdout)')
    .option('-d, --direction <dir>', `dirección del autolayout (${DIRECTIONS.join('|')})`, parseDirection)
    .option('--force-layout', 'recalcular el layout aunque ya haya coordenadas', false)
    .option('--locale <es|en>', 'idioma de las etiquetas de tipo', 'es')
    .option('--density <auto|compact|spacious>', 'densidad del autolayout', parseDensity)
    .option('--distribution <auto|centered|elk>', 'distribución del autolayout', parseDistribution)
    .option('--fast', 'una sola pasada de ELK al aplicar autolayout', false)
    .option('--notation <c4|card>', 'notación de las figuras: librería C4 de draw.io o tarjetas', parseNotation, 'c4')
    .option('--no-waypoints', 'no incluir los quiebres de ruta del autolayout')
    .option('--view <id...>', 'solo estas vistas')
    .option('--to <formato>', 'formato de salida: drawio|mermaid (c4); con otro módulo, cualquiera de sus exportadores (ver `iark modules`)')
    .option('--module <id>', 'módulo de la suite (ver `iark modules`)', defaultModule)
    .option('--mermaid-format <formato>', 'con --to mermaid: c4|flowchart (módulo c4) o auto|flowchart|sequence (integración)')
    .action(async (file: string | undefined, opts) => {
      if (opts.module !== DEFAULT_MODULE) {
        const module = registry.require(opts.module);
        await genericExport(module, readModuleDocument(module, file, opts.stdin), opts.to, opts.out, opts.view?.[0], { format: opts.mermaidFormat });
        return;
      }
      const target = parseTarget(opts.to ?? 'drawio');
      const doc = readDocument(file, opts.stdin);
      if (target === 'mermaid') {
        writeOutput(opts.out, toMermaid(doc, { viewId: opts.view?.[0], format: parseMermaidFormat(opts.mermaidFormat ?? 'c4') }));
        if (opts.out) info(`Diagrama Mermaid escrito en ${opts.out}`);
        return;
      }
      const laid = await autoLayoutDocumentWithQuality(doc, {
        direction: opts.direction,
        distribution: opts.distribution,
        density: opts.density,
        force: opts.forceLayout,
        fast: opts.fast,
      });
      if (opts.forceLayout || doc.views.some((v) => v.elements.some((e) => e.x === undefined))) reportQuality(laid.qualities);
      const xml = toDrawio(laid.document, { locale: opts.locale, viewIds: opts.view, notation: opts.notation, waypoints: opts.waypoints });
      writeOutput(opts.out, xml);
      if (opts.out) info(`Diagrama .drawio escrito en ${opts.out} (${laid.document.views.length} página(s), notación ${opts.notation})`);
    });

  program
    .command('import')
    .description('Importa un diagrama o un modelo de otro formato y lo convierte en un documento JSON del módulo. En C4: draw.io (.drawio), DSL de Structurizr (.dsl) o Mermaid (.mmd); los demás módulos aceptan además sus propios formatos (ver `iark modules`). El Terraform (--module platform) también se lee de una carpeta (todos sus .tf, sin entrar en subcarpetas) o de varios .tf a la vez')
    .argument('[archivos...]', 'archivo de entrada: .drawio, .dsl, .mmd o el de un formato del módulo (o "-" para stdin). Para Terraform, también una carpeta o varios archivos .tf: se leen juntos, en orden alfabético, y los avisos y errores dicen de qué archivo vienen (los módulos locales no se resuelven)')
    .option('--stdin', 'leer el archivo de la entrada estándar')
    .option('--format <formato>', 'formato de entrada: auto o el id de un importador del módulo (en C4: drawio, dsl, mermaid; los demás, en `iark modules`). auto lo deduce de la extensión o del contenido (en una carpeta o con varios archivos, del formato que se reparte en varios: terraform)', 'auto')
    .option('--module <id>', 'módulo de la suite que importa el documento (ver `iark modules`)', defaultModule)
    .option('-o, --out <archivo.json>', 'archivo de salida (por defecto stdout)')
    .option('--name <nombre>', 'nombre del diagrama (por defecto, el del workspace del DSL, el nombre del archivo o el de la carpeta)')
    .option('--layout', 'aplica autolayout (ELK) a las vistas sin coordenadas (un DSL o Mermaid no las tienen)', false)
    .action(async (inputs: string[], opts) => {
      // Una carpeta o varios archivos de un formato que se reparte en varios (los .tf de Terraform) se leen juntos.
      const multi = opts.stdin ? undefined : readMultiInput(registry.require(opts.module), inputs, opts.format);
      const file = inputs[0];
      if (multi) {
        info(`Leídos ${multi.files.length} archivo(s) para importar juntos: ${joinSourceFiles(multi.files).extra.files.map((f) => f.name).join(', ')}.`);
        if (multi.skipped.length > 0) info(`aviso: ${multi.skipped.length} archivo(s) de la carpeta no se leen (solo se juntan los ${multi.extensions.join(', ')}; el resto de ${multi.importerId} se importa de uno en uno): ${multi.skipped.join(', ')}.`);
      }
      const raw = multi ? '' : readInput(file, opts.stdin);
      const fromFile = !opts.stdin && file !== undefined && file !== '-';
      const imported = await importSource(registry, opts.module, { file, raw, format: opts.format, name: opts.name, fromFile, multi });
      let { document } = imported;
      for (const warning of imported.warnings) info(`aviso: ${warning}`);

      const generic = opts.module !== DEFAULT_MODULE;
      if (opts.layout && !generic) {
        const laid = await autoLayoutDocumentWithQuality(document, {});
        document = laid.document;
        reportQuality(laid.qualities);
      }
      const warned = imported.warnings.length > 0 ? `, ${imported.warnings.length} aviso(s)` : '';
      if (generic) {
        // Los módulos que no son C4 derivan sus vistas del modelo (no guardan coordenadas): --layout no aplica.
        if (opts.layout) info('aviso: --layout solo se aplica al módulo c4; las vistas de este módulo se colocan al exportar.');
        const entities = registry.require(opts.module).entities?.(document).length;
        info(`Importado "${document.workspace?.name ?? opts.name ?? 'sin nombre'}" en el módulo ${opts.module}${entities === undefined ? '' : `: ${entities} elementos`}${warned}.`);
      } else {
        info(
          `Importado "${document.workspace.name}": ${document.model.elements.length} elementos, ${document.model.relationships.length} relaciones, ` +
            `${document.views.length} vistas${warned}.`,
        );
      }
      writeOutput(opts.out, jsonOut(document));
      if (opts.out) info(`Documento ${generic ? `del módulo ${opts.module}` : 'C4'} escrito en ${opts.out}`);
    });

  program
    .command('validate')
    .description('Valida un documento C4 y muestra avisos de calidad del modelo')
    .argument('[archivo.json]', 'documento de entrada (o "-" para stdin)')
    .option('--stdin', 'leer el documento de la entrada estándar')
    .option('--strict', 'fallar también con avisos (warnings)', false)
    .option('--module <id>', 'módulo de la suite (ver `iark modules`)', defaultModule)
    .action((file: string | undefined, opts) => {
      if (opts.module !== DEFAULT_MODULE) return genericValidate(registry.require(opts.module), file, opts);
      const raw = readInput(file, opts.stdin);
      let json: unknown;
      try {
        json = JSON.parse(extractJson(raw));
      } catch (error) {
        throw new CliError(`La entrada no es JSON válido: ${(error as Error).message}`);
      }
      const result = validateDocument(json);
      if (!result.ok) {
        throw new CliError(`Documento inválido:\n${formatIssues(result.issues)}`, 2);
      }
      if (result.migrated) process.stdout.write(`info     Documento migrado de la versión ${result.migrated.from} a ${result.migrated.to}; \`iark migrate\` lo reescribe en la nueva.\n`);
      const issues = analyzeDocument(result.document);
      const errors = issues.filter((i) => i.severity === 'error');
      const warnings = issues.filter((i) => i.severity === 'warning');
      for (const i of errors) process.stdout.write(`error    ${i.message}\n`);
      for (const i of warnings) process.stdout.write(`aviso    ${i.message}\n`);
      process.stdout.write(
        `Documento válido: ${result.document.model.elements.length} elementos, ${result.document.model.relationships.length} relaciones, ${result.document.views.length} vistas. ` +
          `${errors.length} error(es), ${warnings.length} aviso(s).\n`,
      );
      if (errors.length > 0 || (opts.strict && warnings.length > 0)) process.exitCode = 3;
    });

  program
    .command('migrate')
    .description('Lleva un documento guardado con una versión anterior del formato del módulo a la versión actual y lo escribe; con --check no escribe nada y sale con código 1 si necesita migración')
    .argument('[archivo.json]', 'documento de entrada (o "-" para stdin)')
    .option('--stdin', 'leer el documento de la entrada estándar')
    .option('-o, --out <archivo.json>', 'archivo de salida (por defecto stdout)')
    .option('--check', 'no escribe nada: sale con código 1 si el documento necesita migración y con 0 si ya está en la versión actual (para la integración continua)', false)
    .option('--module <id>', 'módulo de la suite (ver `iark modules`)', defaultModule)
    .action((file: string | undefined, opts) => genericMigrate(registry.require(opts.module), file, opts));

  program
    .command('schema')
    .description('Imprime el JSON Schema del documento (o del formato de generación de IA con --generation)')
    .option('--generation', 'esquema del modelo sin coordenadas que produce la IA', false)
    .option('--module <id>', 'módulo de la suite (ver `iark modules`)', defaultModule)
    .action((opts) => {
      if (opts.module !== DEFAULT_MODULE) return genericSchema(registry.require(opts.module), opts.generation);
      process.stdout.write(jsonOut(opts.generation ? generationJsonSchema() : documentJsonSchema()));
    });

  program
    .command('prompt')
    .description('Imprime un prompt autocontenido para generar el modelo con cualquier IA/agente (sin clave de API)')
    .argument('<instrucción>', 'descripción del sistema o instrucción de refinamiento')
    .option('-f, --from <archivo>', 'documento existente a refinar: JSON, .drawio, .dsl (Structurizr) o .mmd (Mermaid)')
    .option('--module <id>', 'módulo de la suite (ver `iark modules`)', defaultModule)
    .option('--from-repo <carpeta|url>', FROM_REPO_PROMPT_HELP)
    .option('--repo-ref <rama|etiqueta>', REPO_REF_HELP, parseRepoRef)
    .option('--repo-include <glob>', REPO_INCLUDE_HELP, collectRepoInclude)
    .option('--repo-exclude <glob>', REPO_EXCLUDE_HELP, collectRepoExclude)
    .option('--repo-budget <kb>', REPO_BUDGET_HELP, parseRepoBudget)
    .addHelpText('after', REPO_PROMPT_HELP)
    .action(async (instruction: string, opts) => {
      assertRepoFlags(opts);
      const base = opts.from ? await readBaseDocument(registry, opts.from, opts.module) : undefined;
      const repo = await prepareRepo(instruction, opts, opts.module);
      if (repo) reportRepoSummary(repo.digest);
      await emitPrompt(registry, opts.module, repo ? repo.instruction : instruction, base);
    });

  program
    .command('example')
    .description('Imprime el documento de ejemplo (banca en línea) para probar los demás comandos')
    .action(() => {
      process.stdout.write(jsonOut(sampleDocument));
    });

  program
    .command('modules')
    .description('Lista los módulos (especialidades) de la suite instalados, con su origen (incorporado o el plugin que los aporta) y sus versiones de contrato y de documento; con --json, su manifiesto de federación')
    .option('--json', 'imprime el manifiesto (`iark.manifest/1`) en JSON', false)
    .action((opts) => {
      if (opts.json) {
        process.stdout.write(jsonOut(buildManifest(registry, { name: 'IArk - DIAgrams', version: CLI_VERSION })));
        return;
      }
      for (const m of registry.list()) {
        process.stdout.write(`${m.id}  ${m.name}  v${m.version}\n`);
        process.stdout.write(`    importa: ${m.importers.map((i) => i.id).join(', ') || '-'}  ·  exporta: ${m.exporters.map((e) => e.id).join(', ') || '-'}\n`);
        process.stdout.write(`    origen: ${registry.originOf(m.id) ?? 'incorporado'}  ·  contrato: ${contractVersionOf(m)}  ·  documento: ${m.documentVersion}\n`);
      }
    });

  const serve = program
    .command('serve')
    .description(
      'Servicio HTTP de la suite: API por módulo (validar, vistas, exportar, importar, informes), manifiesto de federación /.well-known/iark.json y, con --static, el sitio y, con --workspace, la API de proyectos (/api/projects). Con --config (o IARK_CONFIG) sirve también los módulos de terceros de esa configuración',
    )
    .option('-p, --port <n>', 'puerto (0 elige uno libre)', parsePort, 8787)
    .option('--host <host>', 'dirección en la que escucha (en un contenedor, 0.0.0.0)', '127.0.0.1')
    .option('--static <carpeta>', 'sirve también el sitio compilado (p. ej. dist/app), con el editor, el banco de trabajo y el shell', process.env.IARK_STATIC)
    .option('--cors <orígenes>', 'orígenes autorizados a llamar a la API desde un navegador, separados por comas, o * (por defecto, ninguno; o la variable IARK_CORS). Para la API de proyectos hay que nombrar el origen: un * no basta', process.env.IARK_CORS || undefined)
    .option(
      '-w, --workspace <carpeta>',
      'activa la API de proyectos (/api/projects) sobre esta carpeta de trabajo, la misma de `iark project` (o la variable IARK_WORKSPACE; sin ella, esas rutas responden 404). ' +
        'Sin --tokens, quien llegue al puerto puede leer y escribir los proyectos: déjelo en 127.0.0.1 (con otra --host exige --tokens)',
      process.env.IARK_WORKSPACE || undefined,
    )
    .option(
      '-t, --tokens <archivo>',
      'exige un token (`Authorization: Bearer <token>`, con rol viewer, editor o admin) en la API de proyectos, en /api/whoami y en las rutas de cálculo (validar, vistas, exportar, importar, comparar, informes y /api/trace; ver --public-compute); el archivo se administra con `iark auth` y se relee cuando cambia (o la variable IARK_TOKENS). ' +
        'Hace falta para escuchar fuera de loopback con --workspace',
      process.env.IARK_TOKENS || undefined,
    )
    .option('--accounts <archivo>', 'activa el inicio de sesión con GitHub: archivo donde el servicio guarda las cuentas, las sesiones y a qué proyectos pertenece cada persona (o IARK_ACCOUNTS). Pide también --github-client-id, el secreto en IARK_GITHUB_CLIENT_SECRET, --public-url y --workspace', process.env.IARK_ACCOUNTS || undefined)
    .option('--github-client-id <id>', 'Client ID de la OAuth App de GitHub (o IARK_GITHUB_CLIENT_ID); el Client secret va solo en IARK_GITHUB_CLIENT_SECRET o IARK_GITHUB_CLIENT_SECRET_FILE', process.env.IARK_GITHUB_CLIENT_ID || undefined)
    .option('--github-url <url>', 'con GitHub Enterprise Server, su dirección (o IARK_GITHUB_URL); por omisión https://github.com', process.env.IARK_GITHUB_URL || undefined)
    .option('--github-api-url <url>', 'con GitHub Enterprise Server, su API (o IARK_GITHUB_API_URL); por omisión https://api.github.com', process.env.IARK_GITHUB_API_URL || undefined)
    .option('--public-url <url>', 'dirección pública de este servicio, https salvo localhost (o IARK_PUBLIC_URL): la «Authorization callback URL» de la OAuth App es <esta dirección>/api/auth/github/callback', process.env.IARK_PUBLIC_URL || undefined)
    .option('--signup <modo>', '«invite» (por omisión): solo entran las personas invitadas y los administradores; «open»: entra cualquiera con cuenta de GitHub (o IARK_SIGNUP)', process.env.IARK_SIGNUP || undefined)
    .option('--admins <lista>', 'administradores de la instancia, separados por comas: nombres de usuario de GitHub o, mejor, sus identificadores numéricos (o IARK_ADMINS)', process.env.IARK_ADMINS || undefined)
    .option('--session-days <n>', 'días que dura una sesión (o IARK_SESSION_DAYS); por omisión 30', (v: string) => Number(v), process.env.IARK_SESSION_DAYS ? Number(process.env.IARK_SESSION_DAYS) : undefined)
    .option('--max-projects <n>', 'proyectos que puede administrar cada persona (o IARK_MAX_PROJECTS); por omisión 25', (v: string) => Number(v), process.env.IARK_MAX_PROJECTS ? Number(process.env.IARK_MAX_PROJECTS) : undefined)
    .option(
      '--frame-ancestors <orígenes>',
      'orígenes que pueden incrustar por iframe las cargas embebidas (?embed=1), separados por comas, o * (o la variable IARK_FRAME_ANCESTORS). Por omisión *, porque el producto es embebible; si no incrusta desde fuera, fíjelo a los orígenes que necesite. El propio origen siempre puede',
      process.env.IARK_FRAME_ANCESTORS || undefined,
    )
    .option('--trust-proxy', 'hay un proxy de confianza delante (Caddy, nginx…): el freno de intentos fallidos usa la última dirección de X-Forwarded-For en vez de la del proxy (o IARK_TRUST_PROXY=true). No lo active sin proxy', /^(1|true|yes|on)$/i.test(process.env.IARK_TRUST_PROXY ?? ''));
  addObservabilityOptions(serve);
  addComputeOptions(serve).action(async (opts) => {
      if (opts.static && !existsSync(opts.static)) throw new CliError(`La carpeta del sitio «${opts.static}» no existe (¿falta \`npm run build\`?).`);
      if (opts.workspace && existsSync(opts.workspace) && !statSync(opts.workspace).isDirectory()) throw new CliError(`El espacio de trabajo «${opts.workspace}» no es una carpeta.`, 2);
      let frameAncestors: string[];
      try {
        frameAncestors = parseFrameAncestors(opts.frameAncestors);
      } catch (error) {
        throw new CliError((error as Error).message, 2);
      }
      const cors = typeof opts.cors === 'string' ? opts.cors.split(',').map((o: string) => o.trim()).filter(Boolean) : [];
      const projects = opts.workspace ? new FolderProjectStore(opts.workspace) : undefined;
      const accounts = setupAccounts(opts, { workspace: !!projects, cors });
      const loopback = isLoopbackHost(opts.host);
      // Fuera de loopback el servicio habla HTTP: con `--trust-proxy` quien lo opera dice que hay un proxy delante, y el aviso pasa a ser un recordatorio.
      const tlsNote = (why: string): string =>
        opts.trustProxy ? `  detrás de un proxy de confianza (--trust-proxy): el HTTPS lo pone el proxy, compruebe que la dirección pública es https; ${why}` : `aviso: este servicio no habla TLS: ponga delante un proxy con HTTPS (Caddy, nginx…); ${why}`;
      if (projects && !opts.tokens && !accounts && !loopback) {
        throw new CliError(
          `Con un espacio de trabajo, escuchar en ${opts.host} sin autenticación dejaría los proyectos al alcance de quien llegue a ese puerto: el servicio no arranca así. ` +
            'Elija una de las salidas: exija un token con --tokens <archivo> (o IARK_TOKENS; se crea con `iark auth create <nombre> --role admin --tokens <archivo>`), active el inicio de sesión con GitHub (--accounts, ver docs/cuentas-github.md) o escuche solo en loopback con --host 127.0.0.1.',
          2,
        );
      }
      const compute = resolveComputeSettings(opts);
      // Registros y métricas (apagados por omisión): se abren antes de escuchar, para que un archivo que no se puede abrir sea un error de uso y no un servicio a medias.
      const observed = setupObservability(opts, { host: opts.host, trustProxy: !!opts.trustProxy, version: CLI_VERSION });
      // Al arrancar el archivo de tokens debe existir y ser válido (si no, error de uso): después se relee cuando cambia, y un problema deniega todo.
      // Protege la API de proyectos y, también sin espacio de trabajo, las rutas de cálculo.
      const tokens = opts.tokens ? TokenStore.open(opts.tokens) : undefined;
      // El cálculo (ELK, análisis de documentos grandes) corre en hilos aparte, con tiempo límite y cola acotada: ver `computePool.ts`.
      // Cada hilo construye su propio registro: con los mismos módulos de terceros que el principal, o un plugin funcionaría en el CLI y fallaría aquí.
      const pool = compute.workers > 0 ? new ComputePool({ size: compute.workers, timeoutMs: compute.timeoutMs, maxQueue: compute.maxQueue, plugins: settings.plugins }) : undefined;
      const server = createSuiteServer({ registry, version: CLI_VERSION, staticDir: opts.static, cors, projects, tokens, accounts, trustProxy: opts.trustProxy, frameAncestors, compute: pool, publicCompute: compute.publicCompute, observability: observed.observability, metricsToken: observed.metricsToken });
      await new Promise<void>((resolveListening, rejectListening) => {
        server.once('error', rejectListening);
        server.listen(opts.port, opts.host, resolveListening);
      });
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : opts.port;
      info(`IArk - DIAgrams escuchando en http://${opts.host.includes(':') ? `[${opts.host}]` : opts.host}:${port}${opts.static ? ` (sitio: ${opts.static})` : ' (solo API)'}`);
      info(`  manifiesto: /.well-known/iark.json · módulos: /api/modules`);
      for (const line of observed.lines) info(line);
      const thirdParty = registry.ids().filter((id) => registry.originOf(id) !== undefined);
      if (thirdParty.length > 0) info(`  módulos de terceros (se operan por la API y salen en el manifiesto; el sitio web no los trae): ${thirdParty.join(', ')}`);
      if (pool) info(`  cálculo: hasta ${pool.size} hilo(s) de trabajo · tiempo límite ${pool.timeoutMs / 1000} s por operación · cola de ${pool.maxQueue}`);
      else info('aviso: --workers 0: el cálculo corre en el hilo principal, sin tiempo límite ni cola; una exportación grande bloquea el servicio entero.');
      if (tokens || accounts) {
        info(compute.publicCompute ? 'aviso: --public-compute: las rutas de cálculo (validar, exportar, importar, informes, trazas) están abiertas a quien llegue al puerto, aunque haya autenticación.' : '  las rutas de cálculo (validar, exportar, importar, informes, trazas) exigen credencial; /api/modules, capabilities y schema siguen públicos');
      }
      if (projects) {
        info(`  espacio de trabajo: ${projects.root} · proyectos: /api/projects`);
        if (accounts) {
          info(`  inicio de sesión: GitHub (${accounts.github?.clientId}) · callback ${accounts.callbackUrl} · cuentas: ${accounts.store.path} (${accounts.store.userCount}) · entrada: ${accounts.signup === 'open' ? 'abierta' : 'solo por invitación'} · administradores: ${accounts.adminCount}`);
          if (!loopback) info(tlsNote('GitHub solo devuelve a la persona a la dirección pública, y las sesiones viajan por ella.'));
        }
      }
      if (tokens) {
        info(`  autenticación: tokens de ${tokens.path} (${tokens.size}), roles viewer, editor y admin · /api/whoami`);
        if (tokens.size === 0) info('aviso: el archivo no tiene ningún token: cree uno con `iark auth create <nombre> --role admin` (no hace falta reiniciar).');
        if (!loopback) info(tlsNote('si no, los tokens viajan en claro.'));
      }
      // `logrotate` rota los registros y avisa con SIGHUP: se vuelven a abrir los archivos (solo si hay alguno; no existe en Windows).
      if (process.platform !== 'win32' && observed.observability.hasFiles) process.on('SIGHUP', () => observed.observability.reopen());
      await new Promise<void>((resolveClosed) => {
        const stop = (): void => void server.close(() => void (pool?.close() ?? Promise.resolve()).then(() => observed.observability.close()).then(() => resolveClosed()));
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    });

  registerTrace(program, registry);
  registerDiff(program, registry, importSource, defaultModule);
  registerProject(program, registry);
  registerAuth(program);
  registerModuleCommands(program, registry);

  return program;
}

/** Cada módulo con `cliCommands` cuelga sus subcomandos de `iark <módulo> …`: instalar un módulo extiende el CLI. */
function registerModuleCommands(program: Command, registry: ModuleRegistry): void {
  for (const module of registry.list()) {
    if (!module.cliCommands?.length) continue;
    const group = program.command(module.id).description(`${module.name}: comandos del módulo`);
    for (const spec of module.cliCommands) {
      const cmd = group.command(spec.name).description(spec.description);
      for (const arg of spec.args ?? []) cmd.argument(arg.required ? `<${arg.name}>` : `[${arg.name}]`, arg.description);
      for (const opt of spec.options ?? []) cmd.option(opt.flags, opt.description, opt.default as string | boolean | undefined);
      if (spec.input) {
        cmd.argument('[archivo]', `${spec.input.description} (o "-" para stdin)`);
        cmd.option('--stdin', 'leer la entrada estándar', false);
        cmd.option('-o, --out <archivo>', 'archivo de salida (por defecto stdout)');
      }
      cmd.action(async (...actionArgs: unknown[]) => {
        const command = actionArgs[actionArgs.length - 1] as Command;
        const options = command.opts();
        const declared = (spec.args ?? []).length;
        const args = actionArgs.slice(0, declared).map((a) => String(a ?? ''));
        const input = spec.input ? readInput(actionArgs[declared] as string | undefined, Boolean(options.stdin)) : undefined;
        const out = await spec.run({ args, options, input, warn: (message) => void process.stderr.write(message.endsWith('\n') ? message : `${message}\n`) });
        if (out) writeOutput(spec.input ? (options.out as string | undefined) : undefined, out.endsWith('\n') ? out : `${out}\n`);
      });
    }
  }
}

/** Lo que `run` decide antes de construir los comandos: la configuración elegida, los módulos de terceros resueltos y el registro. */
export interface Startup {
  registry: ModuleRegistry;
  settings: ProgramSettings;
  config?: LoadedConfig;
}

/**
 * Decide qué configuración se carga (`--config`, `IARK_CONFIG` o el `iark.config.json` del directorio actual; ver `plugins/config.ts`),
 * carga sus módulos de terceros y construye el registro. Es asíncrono y va ANTES de construir el árbol de comandos, porque los
 * comandos de un módulo (`iark <módulo> …`) salen del registro. Sin configuración es exactamente el registro de siempre.
 */
export async function prepareStartup(argv: readonly string[] = process.argv, options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<Startup> {
  const selection = selectConfig(scanGlobalFlags(argv.slice(2)), options);
  if (selection.kind === 'none') {
    if (selection.note) info(selection.note);
    return { registry: createDefaultRegistry(), settings: {} };
  }
  const config = readConfig(selection.path);
  const plugins = resolveConfigPlugins(config);
  const registry = await createRegistry({ plugins });
  if (config.defaultModule && !registry.has(config.defaultModule)) {
    throw new ConfigError(`«defaultModule» de ${config.path} es «${config.defaultModule}», que no es un módulo incorporado ni uno de los cargados (${registry.ids().join(', ')}).`);
  }
  return { registry, config, settings: { plugins, ...(config.defaultModule ? { defaultModule: config.defaultModule } : {}) } };
}

export async function run(argv = process.argv): Promise<void> {
  try {
    const startup = await prepareStartup(argv);
    const program = buildProgram(startup.registry, startup.settings);
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = error.exitCode;
      return;
    }
    if (error instanceof ConfigError || error instanceof PluginError) {
      // Una configuración o un módulo de terceros que no carga es un error de uso: se dice cuál y no se sigue sin él (código 2).
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof ModuleError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof UnknownModuleError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof ProjectError) {
      // Uso incorrecto (no existe, ya existe, inválido): 2. Alguien cambió el diagrama en medio: 3. El disco no responde: 1.
      process.stderr.write(`${error.message}\n`);
      process.exitCode = error.code === 'unavailable' ? 1 : error.code === 'conflict' ? 3 : 2;
      return;
    }
    if (error instanceof TokenError) {
      // Uso incorrecto (nombre repetido, rol inválido, no existe, archivo dañado): 2. El disco no responde: 1.
      process.stderr.write(`${error.message}\n`);
      process.exitCode = error.code === 'unavailable' ? 1 : 2;
      return;
    }
    if (error instanceof DocumentValidationError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof DrawioImportError) {
      process.stderr.write(`No se pudo importar el .drawio: ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof DslImportError) {
      process.stderr.write(`No se pudo importar el DSL: ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof MermaidImportError) {
      process.stderr.write(`No se pudo importar el diagrama de Mermaid: ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof MermaidExportError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 3;
      return;
    }
    if (error instanceof GenerationError) {
      process.stderr.write(`Error generando el modelo: ${error.message}\n`);
      process.exitCode = 4;
      return;
    }
    if (error instanceof DrawioExportError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 3;
      return;
    }
    if (error && typeof error === 'object' && 'code' in error && String((error as { code: string }).code).startsWith('commander.')) {
      const code = (error as { exitCode?: number }).exitCode ?? 1;
      process.exitCode = code;
      return;
    }
    // Cualquier otro error (p. ej. "la vista X no existe"): mensaje de una línea, nunca el stack crudo.
    process.stderr.write(`Error inesperado: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
