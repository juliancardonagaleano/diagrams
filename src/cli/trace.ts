import { InvalidArgumentError, type Command } from 'commander';
import {
  buildTraceGraph,
  coverageShortfalls,
  formatUrn,
  isValidLinkType,
  parseCoverageRule,
  parseTraceSelector,
  parseUrn,
  traceCoverage,
  traceCoverageReport,
  traceFilterTypes,
  traceMatrix,
  traceMatrixReport,
  traceMermaid,
  traceOrphans,
  traceOrphansReport,
  traceReach,
  traceReachReport,
  traceReport,
  traceSvg,
  type CoverageResult,
  type MatrixBy,
  type ModuleRegistry,
  type TraceDirection,
  type TraceGraph,
  type TraceInput,
  type TraceMatrix,
  type TraceOrphans,
  type TraceSelector,
} from '@iark/kernel';
import { readModuleDocument, requireModule } from './generic';
import { CliError, info, writeOutput } from './io';

const DIRECTIONS: TraceDirection[] = ['refs', 'referrers', 'both'];
const FORMATS = ['markdown', 'mermaid', 'svg', 'json'] as const;
const MATRIX_BY: MatrixBy[] = ['module', 'kind'];
export type TraceFormat = (typeof FORMATS)[number];
type Format = TraceFormat;

function parseDirection(value: string): TraceDirection {
  if (!DIRECTIONS.includes(value as TraceDirection)) throw new InvalidArgumentError(`Sentido inválido «${value}». Use: ${DIRECTIONS.join(', ')}.`);
  return value as TraceDirection;
}
function parseFormat(value: string): Format {
  if (!FORMATS.includes(value as Format)) throw new InvalidArgumentError(`Formato inválido «${value}». Use: ${FORMATS.join(', ')}.`);
  return value as Format;
}
function parseDepth(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('La profundidad debe ser un entero ≥ 1.');
  return n;
}
function parseLinkType(value: string, previous: string[] = []): string[] {
  if (!isValidLinkType(value)) throw new InvalidArgumentError(`Tipo de enlace inválido «${value}»: use minúsculas, dígitos y guiones, empezando por una letra (p. ej. implements).`);
  return previous.includes(value) ? previous : [...previous, value];
}
function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}
function parsePercent(value: string): number {
  const n = Number(value.replace(',', '.'));
  if (value.trim() === '' || !Number.isFinite(n) || n < 0 || n > 100) throw new InvalidArgumentError(`El mínimo de cobertura debe ser un número de 0 a 100, no «${value}».`);
  return n;
}

/** `security:pedidos` o `urn:iark:security:pedidos` → la URN completa. */
function toUrn(value: string): string {
  if (parseUrn(value)) return value;
  const at = value.indexOf(':');
  if (at <= 0) throw new CliError(`«${value}» no es una URN. Use urn:iark:<módulo>:<id> o <módulo>:<id>.`, 2);
  try {
    return formatUrn(value.slice(0, at), value.slice(at + 1));
  } catch (error) {
    throw new CliError((error as Error).message, 2);
  }
}

/**
 * Las opciones de salida que comparten `iark trace` y `iark project trace`: de dónde partir, hasta dónde llegar, en qué formato,
 * qué enlaces mirar (`--type`), los informes de huérfanos, matriz y cobertura, y cuándo fallar (`--strict`).
 */
export function addTraceViewOptions(command: Command): Command {
  return command
    .option('--from <urn>', 'elemento de partida: urn:iark:<módulo>:<id> o <módulo>:<id>')
    .option('--direction <sentido>', `con --from: ${DIRECTIONS.join(' | ')} (refs = de qué se apoya; referrers = quién se apoya en él)`, parseDirection, 'both')
    .option('--depth <n>', 'con --from: saltos máximos', parseDepth)
    .option('--format <formato>', `salida: ${FORMATS.join(' | ')}`, parseFormat, 'markdown')
    .option('--type <tipo>', 'mira solo los enlaces de este tipo (el refType: depends-on, implements, deploys, protects, realizes, derives, documents u otro); repetible', parseLinkType)
    .option('--orphans [módulo[:tipo]]', 'añade los elementos sin ningún enlace, agrupados por módulo y tipo de elemento (sin valor, los de todos los módulos); ponga los documentos antes de esta opción')
    .option('--matrix [por]', `añade la matriz de enlaces origen × destino con el desglose por tipo de enlace: ${MATRIX_BY.join(' | ')} (sin valor, module); ponga los documentos antes de esta opción`)
    .option('--coverage <regla>', 'regla de cobertura «origen -> destino» (cada lado, un módulo o módulo:tipo): cada elemento del origen debe enlazar con algo del destino; repetible', collect)
    .option('--min-coverage <n>', 'con --coverage: porcentaje mínimo (0-100) que debe alcanzar cada regla; por debajo termina con código 3 (con --strict, 100 por omisión)', parsePercent)
    .option('--strict', 'termina con código 3 con referencias mal formadas, a elementos que no existen o ambiguas, y con una cobertura por debajo del mínimo; no cuenta las de módulos sin documento', false)
    .option('--strict-unresolved', 'como --strict, y además cuenta las referencias a módulos de los que no se aportó documento', false);
}

export interface TraceViewOptions {
  from?: string;
  direction: TraceDirection;
  depth?: number;
  format: TraceFormat;
  type?: string[];
  orphans?: string | true;
  matrix?: string | true;
  coverage?: string[];
  minCoverage?: number;
  strict?: boolean;
  strictUnresolved?: boolean;
}

/** Lo que produce una traza: el texto de la salida, avisos para stderr y los motivos por los que `--strict`/`--min-coverage` fallan. */
export interface TraceOutput {
  text: string;
  warnings: string[];
  failures: string[];
}

const usage = (message: string): CliError => new CliError(message, 2);

/** Un valor opcional de `--orphans` o `--matrix` que parece un documento (`módulo=archivo`): commander lo tomó por el valor de la opción. */
function swallowedDocument(option: string, value: string): CliError | undefined {
  return value.includes('=') ? usage(`«${option}» toma un módulo o módulo:tipo, y «${value}» parece un documento: ponga los documentos antes de la opción o escriba «${option} módulo».`) : undefined;
}

function orphanFilter(value: string, known: readonly string[]): Partial<TraceSelector> {
  const swallowed = swallowedDocument('--orphans', value);
  if (swallowed) throw swallowed;
  let selector: TraceSelector;
  try {
    selector = parseTraceSelector(value);
  } catch (error) {
    throw usage(`--orphans: ${(error as Error).message}`);
  }
  if (!known.includes(selector.module)) throw usage(`--orphans: no existe el módulo «${selector.module}». Módulos: ${known.join(', ')}.`);
  return selector;
}

function matrixBy(value: string): MatrixBy {
  const swallowed = swallowedDocument('--matrix', value);
  if (swallowed) throw swallowed;
  if (!MATRIX_BY.includes(value as MatrixBy)) throw usage(`--matrix: «${value}» no es válido. Use: ${MATRIX_BY.join(', ')}.`);
  return value as MatrixBy;
}

/**
 * Construye la salida de una traza ya armada: informe Markdown, Mermaid, SVG o JSON, con el alcance de `--from` si se pidió, y los
 * informes de `--orphans`, `--matrix` y `--coverage` (en Markdown y JSON). `--type` restringe los enlaces que se miran en todo
 * ello, pero no las referencias sin resolver: `--strict` mira siempre el grafo entero. `extra` añade campos al JSON (el proyecto,
 * quién define cada URN…). Un argumento que no existe es un error de uso (código 2). `modules` son los ids que conoce la instalación,
 * para distinguir una errata (módulo desconocido) de un módulo conocido del que no se aportó documento.
 */
export async function buildTraceOutput(graph: TraceGraph, opts: TraceViewOptions, modules: readonly string[], extra: Record<string, unknown> = {}): Promise<TraceOutput> {
  const warnings: string[] = [];
  const failures: string[] = [];
  const strict = !!(opts.strict || opts.strictUnresolved);
  if (opts.minCoverage !== undefined && !(opts.coverage?.length ?? 0)) throw usage('--min-coverage necesita al menos una regla --coverage "origen -> destino".');

  const types = opts.type ?? [];
  const view = traceFilterTypes(graph, types);
  for (const type of types) if (!graph.links.some((l) => l.type === type)) warnings.push(`ningún enlace es del tipo «${type}».`);

  let reached;
  if (opts.from) {
    try {
      reached = traceReach(view, toUrn(opts.from), { direction: opts.direction, depth: opts.depth });
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw usage((error as Error).message);
    }
  }

  let orphans: TraceOrphans | undefined;
  if (opts.orphans !== undefined) {
    const filter = opts.orphans === true ? {} : orphanFilter(opts.orphans, modules);
    try {
      orphans = traceOrphans(view, filter);
    } catch (error) {
      throw usage(`--orphans: ${(error as Error).message}`);
    }
  }
  const matrix: TraceMatrix | undefined = opts.matrix === undefined ? undefined : traceMatrix(view, { by: opts.matrix === true ? 'module' : matrixBy(opts.matrix) });

  let coverage: CoverageResult[] | undefined;
  if (opts.coverage?.length) {
    try {
      const rules = opts.coverage.map(parseCoverageRule);
      for (const rule of rules) {
        for (const side of [rule.origin, rule.destination]) {
          if (!modules.includes(side.module)) throw new Error(`no existe el módulo «${side.module}» (regla «${rule.text}»). Módulos: ${modules.join(', ')}.`);
        }
      }
      coverage = traceCoverage(view, rules);
    } catch (error) {
      throw usage(`--coverage: ${(error as Error).message}`);
    }
    for (const r of coverage) if (!r.applicable) warnings.push(`la regla «${r.rule.text}» no es aplicable: ${r.note}`);
  }

  // `--strict` y `--min-coverage` miran siempre el grafo entero en cuanto a referencias; la cobertura, la vista filtrada por tipo.
  const broken = graph.problems.filter((p) => opts.strictUnresolved || p.reason !== 'unresolved');
  if (strict && broken.length > 0) failures.push(`${broken.length} referencia(s) sin resolver.`);
  const minimum = opts.minCoverage ?? (strict ? 100 : undefined);
  if (coverage && minimum !== undefined) {
    for (const r of coverageShortfalls(coverage, minimum)) failures.push(`Cobertura de «${r.rule.text}»: ${String(r.percent).replace('.', ',')} %, por debajo del mínimo (${String(minimum).replace('.', ',')} %).`);
  }

  const sections = opts.format === 'markdown' || opts.format === 'json';
  if (!sections && (orphans || matrix || coverage)) warnings.push(`con --format ${opts.format} no se imprimen los informes de --orphans, --matrix ni --coverage (la cobertura sí se evalúa para --strict y --min-coverage); use markdown o json.`);

  if (opts.format === 'json') {
    const body = {
      ...extra,
      graph: view,
      ...(types.length > 0 ? { types } : {}),
      ...(reached ? { from: reached[0].node.urn, reached } : {}),
      ...(orphans ? { orphans } : {}),
      ...(matrix ? { matrix } : {}),
      ...(coverage ? { coverage } : {}),
    };
    return { text: `${JSON.stringify(body, null, 2)}\n`, warnings, failures };
  }
  if (opts.format === 'svg') return { text: await traceSvg(view, { reached }), warnings, failures };
  if (opts.format === 'mermaid') return { text: `${traceMermaid(view, reached ? new Set(reached.map((r) => r.node.urn)) : undefined)}\n`, warnings, failures };

  const parts = [reached ? traceReachReport(reached, opts.direction) : traceReport(view)];
  if (orphans) parts.push(`### Huérfanos\n\n${traceOrphansReport(orphans)}`);
  if (matrix) parts.push(`### Matriz\n\n${traceMatrixReport(matrix)}`);
  if (coverage) parts.push(`### Cobertura\n\n${traceCoverageReport(coverage, { min: minimum })}`);
  return { text: `${parts.join('\n\n')}\n`, warnings, failures };
}

/** Escribe la salida y, si `--strict` o `--min-coverage` fallaron, deja el código de salida en 3. */
export function emitTrace(out: string | undefined, output: TraceOutput): void {
  writeOutput(out, output.text);
  for (const warning of output.warnings) info(`aviso: ${warning}`);
  if (output.failures.length > 0) {
    for (const failure of output.failures) info(failure);
    process.exitCode = 3;
  }
}

/**
 * `iark trace módulo=archivo…`: reúne los documentos de varios módulos y sigue las referencias URN (`ref`) entre ellos.
 * Es la vista transversal de la suite: no pertenece a ningún módulo, por eso cuelga del CLI y no de `cliCommands`.
 */
export function registerTrace(program: Command, registry: ModuleRegistry): void {
  const command = program
    .command('trace')
    .description('Trazabilidad entre módulos: enlaces tipados por URN (`ref`, `refType`) entre los documentos aportados, referencias sin resolver, huérfanos, matriz, cobertura y, con --from, qué alcanza un elemento')
    .argument('<documentos...>', 'documentos como módulo=archivo, uno por módulo (p. ej. security=seguridad.json platform=plataforma.json)');
  addTraceViewOptions(command)
    .option('-o, --out <archivo>', 'archivo de salida (por defecto stdout)')
    .action(async (specs: string[], opts: TraceViewOptions & { out?: string }) => {
      const inputs: TraceInput[] = specs.map((spec) => {
        const eq = spec.indexOf('=');
        if (eq <= 0) throw new CliError(`«${spec}» no tiene la forma módulo=archivo (módulos: ${registry.ids().join(', ')}).`, 2);
        const module = requireModule(registry, spec.slice(0, eq));
        const file = spec.slice(eq + 1);
        return { module, document: readModuleDocument(module, file, false), source: file };
      });
      let graph;
      try {
        graph = buildTraceGraph(inputs);
      } catch (error) {
        throw new CliError((error as Error).message, 2);
      }
      emitTrace(opts.out, await buildTraceOutput(graph, opts, registry.ids()));
    });
}
