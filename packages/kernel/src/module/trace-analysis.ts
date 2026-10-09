import { DEFAULT_LINK_TYPE } from './link-types';
import type { TraceGraph, TraceNode } from './trace';

/**
 * Análisis del grafo de trazabilidad más allá de sus enlaces: qué elementos quedan sin enlazar (huérfanos), cuántos enlaces hay
 * entre cada par de módulos o de tipos de elemento (matriz) y si lo que debe estar enlazado lo está (cobertura). Todo es puro:
 * recibe un `TraceGraph` y devuelve datos, y cada informe en Markdown se construye a partir de esos datos. Para mirar solo
 * ciertos tipos de enlace se filtra antes el grafo con `traceFilterTypes`.
 */

/** Un lado de un filtro o de una regla: un módulo entero (`security`) o uno de sus tipos de elemento (`security:asset`). */
export interface TraceSelector {
  module: string;
  /** El `kind` de los elementos del módulo (`asset`, `service`…); ausente = todos. */
  kind?: string;
}

const SELECTOR = /^([a-z][a-z0-9-]*)(?::([^\s:>→]+))?$/;

const selectorText = (s: TraceSelector): string => (s.kind ? `${s.module}:${s.kind}` : s.module);

/** `módulo` o `módulo:tipo` → `{ module, kind? }`. */
export function parseTraceSelector(text: string): TraceSelector {
  const m = SELECTOR.exec(text.trim());
  if (!m) throw new Error(`«${text}» no es un módulo ni un módulo:tipo de elemento (p. ej. security o security:asset).`);
  return { module: m[1], ...(m[2] ? { kind: m[2] } : {}) };
}

const matches = (n: TraceNode, s: TraceSelector): boolean => n.module === s.module && (s.kind === undefined || n.kind === s.kind);

/** Posición de cada módulo en el orden en que se aportaron los documentos (los que no están, al final), para ordenar las salidas. */
function moduleOrder(graph: TraceGraph): (module: string) => number {
  const order = new Map<string, number>();
  for (const d of graph.documents) if (!order.has(d.module)) order.set(d.module, order.size);
  return (module) => order.get(module) ?? order.size;
}

function requireModule(graph: TraceGraph, module: string, role: string): void {
  if (graph.documents.some((d) => d.module === module)) return;
  const known = [...new Set(graph.documents.map((d) => d.module))];
  throw new Error(`${role} «${module}» no está entre los documentos aportados${known.length ? ` (${known.join(', ')})` : ''}.`);
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const label = (n: TraceNode): string => `${n.module}:${n.id} (${n.name})`;

// ───────────── huérfanos ─────────────

/** Los elementos que cuenta un análisis de huérfanos: todos, los de un módulo o los de un módulo y tipo. */
export type OrphanFilter = Partial<TraceSelector>;

export interface OrphanGroup {
  module: string;
  kind: string;
  /** Elementos de este módulo y tipo (con o sin enlaces), para dar la proporción. */
  total: number;
  orphans: TraceNode[];
}

export interface TraceOrphans {
  filter: OrphanFilter;
  /** Elementos examinados (los que cumplen el filtro). */
  considered: number;
  /** Cuántos no tienen ningún enlace, ni entrante ni saliente. */
  count: number;
  /** Solo los grupos (módulo y tipo de elemento) que tienen algún huérfano, en el orden de los documentos. */
  groups: OrphanGroup[];
}

/**
 * Elementos sin enlaces entrantes ni salientes, agrupados por módulo y por tipo de elemento. Es una consulta opcional: no todo
 * elemento tiene por qué estar enlazado. Solo cuentan los enlaces resueltos del grafo: un elemento cuyo único `ref` apunta a algo
 * que no existe (o a un módulo sin documento) sigue siendo huérfano, y además aparece entre las referencias sin resolver. Con un
 * módulo que no se aportó lanza un error (casi seguro una errata).
 */
export function traceOrphans(graph: TraceGraph, filter: OrphanFilter = {}): TraceOrphans {
  if (filter.module) requireModule(graph, filter.module, 'El módulo');
  const linked = new Set<string>();
  for (const l of graph.links) linked.add(l.from).add(l.to);
  const order = moduleOrder(graph);
  const groups = new Map<string, OrphanGroup>();
  let considered = 0;
  for (const n of graph.nodes) {
    if ((filter.module && n.module !== filter.module) || (filter.kind && n.kind !== filter.kind)) continue;
    considered++;
    const key = `${n.module}\u0000${n.kind}`;
    const group = groups.get(key) ?? { module: n.module, kind: n.kind, total: 0, orphans: [] };
    group.total++;
    if (!linked.has(n.urn)) group.orphans.push(n);
    groups.set(key, group);
  }
  const withOrphans = [...groups.values()].filter((g) => g.orphans.length > 0).sort((a, b) => order(a.module) - order(b.module) || a.kind.localeCompare(b.kind));
  return { filter, considered, count: withOrphans.reduce((n, g) => n + g.orphans.length, 0), groups: withOrphans };
}

/** Informe en Markdown de los huérfanos, por módulo y tipo de elemento. */
export function traceOrphansReport(result: TraceOrphans): string {
  const scope = result.filter.module ? ` en ${selectorText({ module: result.filter.module, kind: result.filter.kind })}` : '';
  const out = [`Huérfanos${scope}: ${result.count} de ${result.considered} elementos no tienen ningún enlace.`, ''];
  if (result.count === 0) {
    out.push(result.considered === 0 ? 'No hay elementos que examinar.' : 'Todos los elementos examinados están enlazados.');
  }
  for (const g of result.groups) {
    out.push(`**${g.module} · ${g.kind}** (${g.orphans.length} de ${g.total})`);
    for (const n of g.orphans) out.push(`- ${n.id} (${n.name})`);
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

// ───────────── matriz ─────────────

/** Qué se cruza: los módulos (`security`) o los tipos de elemento de cada módulo (`security:asset`). */
export type MatrixBy = 'module' | 'kind';

export interface MatrixCell {
  /** Fila (origen) y columna (destino): un módulo o `módulo:tipo`, según `by`. */
  from: string;
  to: string;
  /** Enlaces del origen al destino (siempre ≥ 1: las celdas vacías no se guardan). */
  count: number;
  /** Desglose por tipo de enlace (`type`). */
  types: Record<string, number>;
}

export interface TraceMatrix {
  by: MatrixBy;
  /** Orígenes (filas) y destinos (columnas) con al menos un enlace, en el orden de los documentos. */
  rows: string[];
  columns: string[];
  cells: MatrixCell[];
  rowTotals: Record<string, number>;
  columnTotals: Record<string, number>;
  /** Todos los enlaces del grafo. */
  total: number;
  /** Los mismos enlaces, por tipo de enlace. */
  types: Record<string, number>;
}

/** Recuento de enlaces origen × destino, por módulo o por tipo de elemento, con totales y desglose por tipo de enlace. */
export function traceMatrix(graph: TraceGraph, options: { by: MatrixBy }): TraceMatrix {
  const byUrn = new Map(graph.nodes.map((n) => [n.urn, n]));
  const name = (n: TraceNode): string => (options.by === 'kind' ? `${n.module}:${n.kind}` : n.module);
  const order = moduleOrder(graph);
  const sorter = (a: string, b: string): number => order(a.split(':')[0]) - order(b.split(':')[0]) || a.localeCompare(b);

  const cells = new Map<string, MatrixCell>();
  const rowTotals: Record<string, number> = {};
  const columnTotals: Record<string, number> = {};
  const types: Record<string, number> = {};
  for (const link of graph.links) {
    const from = name(byUrn.get(link.from)!);
    const to = name(byUrn.get(link.to)!);
    const key = `${from}\u0000${to}`;
    const entry = cells.get(key) ?? { from, to, count: 0, types: {} };
    entry.count++;
    entry.types[link.type] = (entry.types[link.type] ?? 0) + 1;
    cells.set(key, entry);
    rowTotals[from] = (rowTotals[from] ?? 0) + 1;
    columnTotals[to] = (columnTotals[to] ?? 0) + 1;
    types[link.type] = (types[link.type] ?? 0) + 1;
  }
  const rows = Object.keys(rowTotals).sort(sorter);
  const columns = Object.keys(columnTotals).sort(sorter);
  const sortedCells = [...cells.values()].sort((a, b) => sorter(a.from, b.from) || sorter(a.to, b.to));
  return { by: options.by, rows, columns, cells: sortedCells, rowTotals, columnTotals, total: graph.links.length, types };
}

/** El recuento de una celda (0 si no hay enlaces de esa fila a esa columna). */
export function matrixCount(matrix: TraceMatrix, from: string, to: string): number {
  return matrix.cells.find((c) => c.from === from && c.to === to)?.count ?? 0;
}

/** Los tipos de enlace presentes en la matriz: los de por omisión primero y los demás por frecuencia. */
export function matrixTypes(matrix: TraceMatrix): string[] {
  return Object.entries(matrix.types)
    .sort(([a, x], [b, y]) => Number(b === DEFAULT_LINK_TYPE) - Number(a === DEFAULT_LINK_TYPE) || y - x || a.localeCompare(b))
    .map(([type]) => type);
}

/**
 * Informe en Markdown: la tabla origen × destino con totales y, si hay más de un tipo de enlace, otra con el desglose por tipo
 * de cada par.
 */
export function traceMatrixReport(matrix: TraceMatrix): string {
  const what = matrix.by === 'kind' ? 'tipo de elemento' : 'módulo';
  const out = [`Matriz de trazabilidad por ${what}: ${matrix.total} enlaces.`, ''];
  if (matrix.total === 0) {
    out.push('No hay enlaces entre los documentos aportados.');
    return out.join('\n');
  }
  out.push(`| Origen \\ Destino | ${matrix.columns.map(cell).join(' | ')} | Total |`, `|---|${matrix.columns.map(() => '--:|').join('')}--:|`);
  for (const row of matrix.rows) out.push(`| ${cell(row)} | ${matrix.columns.map((c) => matrixCount(matrix, row, c)).join(' | ')} | ${matrix.rowTotals[row]} |`);
  out.push(`| **Total** | ${matrix.columns.map((c) => matrix.columnTotals[c]).join(' | ')} | ${matrix.total} |`);
  const types = matrixTypes(matrix);
  if (types.length > 1) {
    out.push('', 'Desglose por tipo de enlace:', '', `| Origen → Destino | ${types.map(cell).join(' | ')} | Total |`, `|---|${types.map(() => '--:|').join('')}--:|`);
    for (const c of matrix.cells) out.push(`| ${cell(c.from)} → ${cell(c.to)} | ${types.map((t) => c.types[t] ?? 0).join(' | ')} | ${c.count} |`);
    out.push(`| **Total** | ${types.map((t) => matrix.types[t]).join(' | ')} | ${matrix.total} |`);
  }
  return out.join('\n');
}

// ───────────── cobertura ─────────────

/** Una regla de cobertura `origen -> destino`: cada elemento del origen debe enlazar con algún elemento del destino. */
export interface CoverageRule {
  /** La regla escrita de forma normalizada (`security:asset -> platform`). */
  text: string;
  origin: TraceSelector;
  destination: TraceSelector;
}

const RULE = /^\s*(\S+?)\s*(?:->|→)\s*(\S+?)\s*$/;

/** `security:asset -> platform` → la regla. Cada lado es `módulo` o `módulo:tipo`; admite `→` en lugar de `->`. */
export function parseCoverageRule(text: string): CoverageRule {
  const m = RULE.exec(text);
  if (!m) throw new Error(`La regla de cobertura «${text}» no tiene la forma origen -> destino (cada lado, un módulo o módulo:tipo; p. ej. security:asset -> platform).`);
  let origin: TraceSelector;
  let destination: TraceSelector;
  try {
    origin = parseTraceSelector(m[1]);
    destination = parseTraceSelector(m[2]);
  } catch (error) {
    throw new Error(`La regla de cobertura «${text}» no es válida: ${(error as Error).message}`);
  }
  return { text: `${selectorText(origin)} -> ${selectorText(destination)}`, origin, destination };
}

export interface CoverageResult {
  rule: CoverageRule;
  /**
   * ¿Tiene sentido medirla? Es `false` cuando el origen no selecciona ningún elemento: no hay nada que cubrir, así que ni es un
   * 100 % ni un 0 %, y `percent` queda en `null`. Una regla no aplicable nunca incumple un mínimo (ver `coverageShortfalls`).
   */
  applicable: boolean;
  /** Elementos del origen. */
  total: number;
  covered: TraceNode[];
  uncovered: TraceNode[];
  /** `cubiertos / total × 100` con un decimal, o `null` si no es aplicable. */
  percent: number | null;
  /** Una explicación cuando algo merece decirse (regla no aplicable, módulo de destino ausente…). */
  note?: string;
}

/**
 * Mide reglas de cobertura. El origen son los elementos del lado izquierdo; uno está **cubierto** si tiene un enlace saliente
 * hacia algún elemento del lado derecho (distinto de él mismo): la dirección importa, `a -> b` no mira los enlaces de `b` hacia
 * `a`. El porcentaje es cubiertos / total. Si el origen no tiene elementos la regla es no aplicable (`applicable: false`,
 * `percent: null`) en lugar de un 100 % vacuo. Los enlaces que se consideran son los del grafo recibido: filtrado con
 * `traceFilterTypes`, solo cuentan los del tipo pedido.
 */
export function traceCoverage(graph: TraceGraph, rules: ReadonlyArray<string | CoverageRule>): CoverageResult[] {
  const parsed = rules.map((r) => (typeof r === 'string' ? parseCoverageRule(r) : r));
  const known = new Set(graph.documents.map((d) => d.module));
  return parsed.map((rule) => {
    const origin = graph.nodes.filter((n) => matches(n, rule.origin));
    const notes: string[] = [];
    if (!known.has(rule.destination.module)) notes.push(`el módulo de destino «${rule.destination.module}» no está entre los documentos aportados`);
    else if (rule.destination.kind && !graph.nodes.some((n) => matches(n, rule.destination))) notes.push(`no hay elementos de tipo «${rule.destination.kind}» en «${rule.destination.module}»`);
    if (origin.length === 0) {
      if (!known.has(rule.origin.module)) notes.unshift(`el módulo de origen «${rule.origin.module}» no está entre los documentos aportados`);
      else {
        const kinds = [...new Set(graph.nodes.filter((n) => n.module === rule.origin.module).map((n) => n.kind))].sort();
        notes.unshift(
          rule.origin.kind && kinds.length > 0
            ? `no hay elementos de tipo «${rule.origin.kind}» en «${rule.origin.module}» (tipos presentes: ${kinds.join(', ')})`
            : `no hay elementos de origen en «${rule.origin.module}»`,
        );
      }
      return { rule, applicable: false, total: 0, covered: [], uncovered: [], percent: null, note: `${notes.join('; ')}: la regla no es aplicable.` };
    }
    const byUrn = new Map(graph.nodes.map((n) => [n.urn, n]));
    const reaches = new Set<string>();
    for (const l of graph.links) {
      const to = byUrn.get(l.to);
      if (l.from !== l.to && to && matches(to, rule.destination)) reaches.add(l.from);
    }
    const covered = origin.filter((n) => reaches.has(n.urn));
    const uncovered = origin.filter((n) => !reaches.has(n.urn));
    return {
      rule,
      applicable: true,
      total: origin.length,
      covered,
      uncovered,
      percent: Math.round((covered.length / origin.length) * 1000) / 10,
      ...(notes.length > 0 ? { note: `${notes.join('; ')}.` } : {}),
    };
  });
}

/**
 * Las reglas aplicables que no llegan al mínimo (un porcentaje de 0 a 100; 100 por omisión). Compara cubiertos y total sin
 * redondear, así que 99,96 % no pasa por 100. Las no aplicables no cuentan: no hay nada que cubrir.
 */
export function coverageShortfalls(results: readonly CoverageResult[], min = 100): CoverageResult[] {
  return results.filter((r) => r.applicable && r.covered.length * 100 < min * r.total);
}

const percentText = (r: CoverageResult): string => (r.percent === null ? 'no aplicable' : `${String(r.percent).replace('.', ',')} %`);

/** Informe en Markdown: una fila por regla y, de cada una, los elementos SIN cubrir. */
export function traceCoverageReport(results: readonly CoverageResult[], options: { min?: number } = {}): string {
  const out = [`Cobertura de trazabilidad: ${results.length} ${results.length === 1 ? 'regla' : 'reglas'}.`, ''];
  if (results.length === 0) {
    out.push('No se pidió ninguna regla (origen -> destino).');
    return out.join('\n');
  }
  out.push('| Regla | Cubiertos | Total | Cobertura |', '|---|--:|--:|--:|');
  for (const r of results) out.push(`| \`${cell(r.rule.text)}\` | ${r.applicable ? r.covered.length : '—'} | ${r.total} | ${percentText(r)} |`);
  const short = options.min === undefined ? [] : coverageShortfalls(results, options.min);
  for (const r of results) {
    if (r.note) out.push('', `\`${r.rule.text}\`: ${r.note}`);
    if (r.uncovered.length > 0) {
      out.push('', `**SIN cubrir** · \`${r.rule.text}\` (${r.uncovered.length})`);
      for (const n of r.uncovered) out.push(`- ${label(n)} · ${n.kind}`);
    }
  }
  if (options.min !== undefined) {
    out.push('', short.length === 0 ? `Todas las reglas aplicables alcanzan el mínimo (${options.min} %).` : `Por debajo del mínimo (${options.min} %): ${short.map((r) => `\`${r.rule.text}\``).join(', ')}.`);
  }
  return out.join('\n');
}
