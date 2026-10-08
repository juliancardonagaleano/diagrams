import {
  analyzeText,
  buildTraceGraph,
  diffDocuments,
  exportDocument,
  exportFormats,
  importText,
  isValidLinkType,
  parseCoverageRule,
  parseTraceSelector,
  runCommand,
  traceCoverage,
  traceFilterTypes,
  traceMatrix,
  traceMermaid,
  traceOrphans,
  traceReach,
  traceReachReport,
  traceReport,
  traceSvg,
  viewChoices,
  type AnyModule,
  type MatrixBy,
  type ModuleRegistry,
  type TraceDirection,
  type TraceInput,
  type TraceSelector,
} from '@iark/kernel';
import { HttpError } from './httpError';

/**
 * Las operaciones de cálculo de la API de `iark serve` (validar, vistas, exportar, importar, comparar, informes y trazabilidad):
 * las que analizan un documento, dibujan con ELK o recorren grafos y pueden tardar segundos (el README admite ~90 s con 300
 * contenedores). Se describen como datos (`ComputeJob`) y se ejecutan con `executeJob`, que no conoce HTTP ni hilos: lo mismo
 * lo llama el propio proceso (`inlineExecutor`, el valor por omisión de `createSuiteServer` y de las pruebas) que un hilo de
 * trabajo (`computeWorker.ts`, con el `ComputePool` de `computePool.ts`, que es lo que usa `iark serve`). Así el hilo principal
 * solo atiende conexiones, y un cálculo que se cuelga se puede abandonar sin llevarse el servicio por delante.
 *
 * El resultado tampoco es una excepción sino un dato (`ComputeOutcome`), porque tiene que cruzar de un hilo a otro: la misma
 * semántica de errores de siempre (400/404/422 con mensaje limpio para entrada inválida y `ModuleError`; 500 para un fallo del
 * programa, que se anota en stderr) llega al cliente venga de donde venga.
 */

export type ComputeJob =
  | { op: 'validate' | 'views' | 'diff'; module: string; body: string }
  | { op: 'export'; module: string; body: string; format: string; view?: string }
  | { op: 'import'; module: string; body: string; importer?: string; name?: string }
  | { op: 'run'; module: string; command: string; body: string }
  | { op: 'trace'; body: string };

export type ComputeOutcome =
  /** Éxito: lo que se responde con 200. */
  | { kind: 'ok'; contentType: string; body: string; headers?: Record<string, string> }
  /** Un problema de la petición (o del servicio, como 503): lo que `HttpError` lleva al cliente. */
  | { kind: 'http'; status: number; message: string; extra?: Record<string, unknown>; headers?: Record<string, string> }
  /** Un fallo del programa: el cliente solo recibe 500; esto (la traza) se anota en stderr. */
  | { kind: 'internal'; detail: string };

/** Lo que el hilo principal manda a un hilo de trabajo (`id` identifica la operación) y lo que este contesta. */
export interface ComputeRequest {
  id: number;
  job: ComputeJob;
}

export interface ComputeReply {
  id: number;
  outcome: ComputeOutcome;
}

export interface ComputeRunOptions {
  /** Si se aborta antes de empezar (el cliente colgó con la operación en cola), la operación se descarta. */
  signal?: AbortSignal;
}

/** Dónde se ejecutan los trabajos: en este mismo proceso o en un `ComputePool`. `run` nunca rechaza: los fallos son `ComputeOutcome`. */
export interface ComputeExecutor {
  run(job: ComputeJob, options?: ComputeRunOptions): Promise<ComputeOutcome>;
  /** Libera lo que tenga (hilos); lo que esté en curso o en cola se responde con 503. */
  close(): Promise<void>;
}

/** Las acciones de `/api/<módulo>/…` que son cálculo (más `POST /api/trace`). Las demás (capabilities, schema) son lecturas baratas. */
export const COMPUTE_ACTIONS: ReadonlySet<string> = new Set(['validate', 'views', 'export', 'import', 'diff', 'run']);

/** Un `TypeError`/`RangeError`/`ReferenceError` es un fallo del programa; el resto, un problema de la petición. */
const isBug = (error: unknown): boolean => error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError;

const json = (value: unknown): ComputeOutcome => ({ kind: 'ok', contentType: 'application/json; charset=utf-8', body: `${JSON.stringify(value, null, 2)}\n` });

function moduleOf(registry: ModuleRegistry, id: string): AnyModule {
  const module = registry.get(id);
  if (!module) throw new HttpError(404, `No existe el módulo «${id}». Módulos: ${registry.ids().join(', ')}.`);
  return module;
}

/** El cuerpo como documento del módulo: 422 con las incidencias si no lo es. */
function documentOf(module: AnyModule, body: string): unknown {
  const analysis = analyzeText(module, body);
  if (analysis.status === 'ok') return analysis.document;
  if (analysis.status === 'empty') throw new HttpError(400, 'Falta el documento en el cuerpo de la petición.');
  if (analysis.status === 'syntax') throw new HttpError(400, `El cuerpo no es JSON válido: ${analysis.error}`);
  throw new HttpError(422, 'El documento no cumple el esquema del módulo.', { issues: analysis.issues });
}

/** Compara dos versiones de un documento del módulo: cada una, validada con su esquema (422 si no lo cumple, diciendo cuál). */
function compare(module: AnyModule, raw: string): unknown {
  let body: { before?: unknown; after?: unknown } | null;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'El cuerpo debe ser JSON: { "before": {…}, "after": {…} } (las dos versiones del documento del módulo).');
  }
  const side = (name: 'before' | 'after'): unknown => {
    const value = body && typeof body === 'object' ? body[name] : undefined;
    if (value === undefined || value === null) throw new HttpError(400, `Falta "${name}": la ${name === 'before' ? 'versión anterior' : 'versión nueva'} del documento.`);
    try {
      return documentOf(module, typeof value === 'string' ? value : JSON.stringify(value));
    } catch (error) {
      if (error instanceof HttpError) throw new HttpError(error.status, `«${name}»: ${error.message}`, error.extra);
      throw error;
    }
  };
  return diffDocuments(side('before'), side('after'), module.diff);
}

/** `types` del cuerpo de `POST /api/trace`: una lista de tipos de enlace con la forma de un `refType`. */
function traceTypes(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((t) => typeof t !== 'string' || !isValidLinkType(t))) {
    throw new HttpError(400, '"types" debe ser una lista de tipos de enlace (minúsculas, dígitos y guiones, p. ej. ["implements"]).');
  }
  return [...new Set(value as string[])];
}

/** `orphans` del cuerpo: `true` (todos los módulos), `"módulo"`, `"módulo:tipo"` o `{ module, kind? }`. */
function orphanFilter(value: unknown, known: readonly string[]): Partial<TraceSelector> {
  if (value === true) return {};
  let selector: TraceSelector;
  try {
    if (typeof value === 'string') selector = parseTraceSelector(value);
    else if (value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { module?: unknown }).module === 'string') {
      const { module, kind } = value as { module: string; kind?: unknown };
      selector = parseTraceSelector(typeof kind === 'string' && kind ? `${module}:${kind}` : module);
    } else throw new Error('use true, "módulo", "módulo:tipo" o { "module", "kind"? }.');
  } catch (error) {
    throw new HttpError(400, `"orphans": ${(error as Error).message}`);
  }
  if (!known.includes(selector.module)) throw new HttpError(400, `"orphans": no existe el módulo «${selector.module}». Módulos: ${known.join(', ')}.`);
  return selector;
}

/** `coverage` del cuerpo: una lista de reglas «origen -> destino» cuyos módulos conoce la instalación. */
function coverageRules(value: unknown, known: readonly string[]): ReturnType<typeof parseCoverageRule>[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((r) => typeof r !== 'string')) throw new HttpError(400, '"coverage" debe ser una lista de reglas "origen -> destino" (p. ej. ["security:asset -> platform"]).');
  try {
    const rules = (value as string[]).map(parseCoverageRule);
    for (const rule of rules) {
      for (const side of [rule.origin, rule.destination]) if (!known.includes(side.module)) throw new Error(`no existe el módulo «${side.module}» (regla «${rule.text}»). Módulos: ${known.join(', ')}.`);
    }
    return rules;
  } catch (error) {
    throw new HttpError(400, `"coverage": ${(error as Error).message}`);
  }
}

/** Trazabilidad entre módulos: reúne los documentos aportados y sigue sus referencias URN. */
async function trace(registry: ModuleRegistry, raw: string): Promise<unknown> {
  let body: { documents?: unknown; from?: unknown; direction?: unknown; depth?: unknown; types?: unknown; orphans?: unknown; matrix?: unknown; coverage?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'El cuerpo debe ser JSON: { "documents": [{ "module": "…", "document": {…} }], "from"?: "urn:iark:…", "types"?: ["implements"], "orphans"?: true, "matrix"?: "module", "coverage"?: ["security:asset -> platform"] }.');
  }
  if (!body || typeof body !== 'object') throw new HttpError(400, 'El cuerpo debe ser un objeto JSON.');
  if (!Array.isArray(body.documents) || body.documents.length === 0) throw new HttpError(400, 'Falta "documents": la lista de documentos { module, document } a reunir.');
  const inputs: TraceInput[] = body.documents.map((entry: { module?: unknown; document?: unknown; source?: unknown }, index: number) => {
    if (!entry || typeof entry.module !== 'string') throw new HttpError(400, `documents[${index}] necesita "module".`);
    const module = moduleOf(registry, entry.module);
    const document = documentOf(module, typeof entry.document === 'string' ? entry.document : JSON.stringify(entry.document ?? null));
    return { module, document, source: typeof entry.source === 'string' ? entry.source : undefined };
  });
  const direction = (body.direction ?? 'both') as TraceDirection;
  if (!['refs', 'referrers', 'both'].includes(direction)) throw new HttpError(400, 'direction debe ser refs, referrers o both.');
  // Los campos nuevos son opcionales: sin ellos la respuesta es la de siempre (con el `type` de cada enlace y `notices` en el grafo).
  const types = traceTypes(body.types);
  const known = registry.ids();
  const rules = coverageRules(body.coverage, known);
  const matrixBy = body.matrix === undefined || body.matrix === null || body.matrix === false ? undefined : body.matrix === true ? 'module' : body.matrix;
  if (matrixBy !== undefined && matrixBy !== 'module' && matrixBy !== 'kind') throw new HttpError(400, '"matrix" debe ser "module" o "kind".');
  const filter = body.orphans === undefined || body.orphans === null || body.orphans === false ? undefined : orphanFilter(body.orphans, known);

  try {
    // `types` restringe los enlaces que se miran (grafo, alcance, informes, huérfanos, matriz y cobertura), no las referencias sin resolver.
    const graph = traceFilterTypes(buildTraceGraph(inputs), types);
    const reached = typeof body.from === 'string' ? traceReach(graph, body.from, { direction, depth: typeof body.depth === 'number' ? body.depth : undefined }) : undefined;
    return {
      graph,
      ...(types.length > 0 ? { types } : {}),
      ...(reached ? { from: reached[0].node.urn, reached } : {}),
      ...(filter ? { orphans: traceOrphans(graph, filter) } : {}),
      ...(matrixBy ? { matrix: traceMatrix(graph, { by: matrixBy as MatrixBy }) } : {}),
      ...(rules ? { coverage: traceCoverage(graph, rules) } : {}),
      report: reached ? traceReachReport(reached, direction) : traceReport(graph),
      mermaid: traceMermaid(graph, reached ? new Set(reached.map((r) => r.node.urn)) : undefined),
      svg: await traceSvg(graph, { reached }),
    };
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
}

/** Las opciones de un informe vienen de un cliente: texto o booleano (un número se toma como el texto que commander habría entregado). */
function commandOptions(value: unknown): Record<string, string | boolean> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const options: Record<string, string | boolean> = {};
  for (const [key, option] of Object.entries(value)) {
    if (option === null || option === undefined) continue;
    if (typeof option === 'string' || typeof option === 'boolean') options[key] = option;
    else if (typeof option === 'number') options[key] = String(option);
    else throw new HttpError(400, `La opción «${key}» debe ser un texto, un número o un booleano.`);
  }
  return options;
}

/** `POST /api/<módulo>/run/<comando>`: el cuerpo es `{ input?, args?, options? }`. Siempre en remoto: no abre archivos del servidor (ver `CommandOption.local`). */
async function runModuleCommand(module: AnyModule, command: string, raw: string): Promise<unknown> {
  let envelope: { input?: unknown; args?: unknown; options?: unknown } = {};
  if (raw.trim()) {
    try {
      envelope = JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'El cuerpo debe ser JSON: { "input": …, "args": […], "options": {…} }.');
    }
  }
  if (!envelope || typeof envelope !== 'object') throw new HttpError(400, 'El cuerpo debe ser JSON: { "input": …, "args": […], "options": {…} }.');
  const input = envelope.input === undefined ? undefined : typeof envelope.input === 'string' ? envelope.input : JSON.stringify(envelope.input);
  const args = Array.isArray(envelope.args) ? envelope.args.map(String) : undefined;
  const result = await runCommand(module, command, { input, args, options: commandOptions(envelope.options) }, { remote: true }).catch((error) => {
    throw isBug(error) ? error : new HttpError(400, (error as Error).message);
  });
  return { module: module.id, ...result };
}

async function handle(registry: ModuleRegistry, job: ComputeJob): Promise<ComputeOutcome> {
  if (job.op === 'trace') return json(await trace(registry, job.body));
  const module = moduleOf(registry, job.module);
  switch (job.op) {
    case 'validate': {
      const analysis = analyzeText(module, job.body);
      if (analysis.status === 'empty') throw new HttpError(400, 'Falta el documento en el cuerpo de la petición.');
      return json({
        module: module.id,
        valid: analysis.status === 'ok',
        schemaIssues: analysis.status === 'syntax' ? [{ path: '(raíz)', message: analysis.error }] : analysis.status === 'schema' ? analysis.issues : [],
        issues: analysis.status === 'ok' ? analysis.issues : [],
      });
    }
    case 'views':
      return json(viewChoices(module, documentOf(module, job.body)));
    case 'export': {
      const document = documentOf(module, job.body);
      const file = await exportDocument(module, document, job.format, { viewId: job.view }).catch((error) => {
        throw isBug(error) ? error : new HttpError(400, (error as Error).message, { formats: exportFormats(module).map((f) => f.id) });
      });
      return {
        kind: 'ok',
        contentType: `${file.mime}; charset=utf-8`,
        body: file.data,
        ...(file.format === 'svg' ? { headers: { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" } } : {}),
      };
    }
    case 'import': {
      if (!job.body.trim()) throw new HttpError(400, 'Falta el texto a importar en el cuerpo de la petición.');
      const result = await importText(module, job.body, job.importer, { name: job.name }).catch((error) => {
        throw isBug(error) ? error : new HttpError(400, (error as Error).message);
      });
      return json(result);
    }
    case 'diff':
      return json(compare(module, job.body));
    case 'run':
      return json(await runModuleCommand(module, job.command, job.body));
  }
}

/** Ejecuta un trabajo con el registro dado. Nunca lanza: un `HttpError` es un `http`; cualquier otra cosa, un `internal`. */
export async function executeJob(registry: ModuleRegistry, job: ComputeJob): Promise<ComputeOutcome> {
  try {
    return await handle(registry, job);
  } catch (error) {
    if (error instanceof HttpError) return { kind: 'http', status: error.status, message: error.message, ...(Object.keys(error.extra).length > 0 ? { extra: error.extra } : {}), ...(Object.keys(error.headers).length > 0 ? { headers: error.headers } : {}) };
    return { kind: 'internal', detail: (error as Error)?.stack ?? String(error) };
  }
}

/** Ejecuta los trabajos en el propio hilo (sin tope ni tiempo límite): el valor por omisión de `createSuiteServer`. */
export function inlineExecutor(registry: ModuleRegistry): ComputeExecutor {
  return { run: (job) => executeJob(registry, job), close: async () => {} };
}

/** Un fallo del programa en un trabajo: su traza (la del hilo de trabajo, si se ejecutó allí) es la que se anota. */
export class ComputeFailure extends Error {
  constructor(detail: string) {
    super(detail.split('\n')[0]);
    this.stack = detail;
  }
}

/** El resultado de un trabajo en el idioma del servidor: el éxito, o la excepción (`HttpError` o `ComputeFailure`) que lo responde. */
export function unwrapOutcome(outcome: ComputeOutcome): Extract<ComputeOutcome, { kind: 'ok' }> {
  if (outcome.kind === 'ok') return outcome;
  if (outcome.kind === 'http') throw new HttpError(outcome.status, outcome.message, outcome.extra ?? {}, outcome.headers ?? {});
  throw new ComputeFailure(outcome.detail);
}
