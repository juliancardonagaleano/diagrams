import {
  analyzeText,
  buildTraceGraph,
  DEFAULT_LINK_TYPE,
  parseCoverageRule,
  traceCoverage,
  traceFilterTypes,
  traceMatrix,
  traceOrphans,
  type AnyModule,
  type CoverageResult,
  type CoverageRule,
  type MatrixBy,
  type OrphanFilter,
  type TraceGraph,
  type TraceMatrix,
  type TraceOrphans,
} from '@iark/kernel';
import type { ModuleSource } from '../modules-app/controller';

/** Un documento de un módulo reunido en el tablero de trazabilidad. */
export interface BoardDocument {
  module: AnyModule;
  document: unknown;
  /** De dónde viene (nombre del archivo, «ejemplo» o «pegado»). */
  source: string;
  entities: number;
  /** Errores de esquema no hay (se rechazan al cargar); aquí van los avisos y errores de las reglas del dominio. */
  issues: number;
}

export type LoadResult = { ok: true; entities: number; issues: number } | { ok: false; message: string };

/** Una regla de cobertura mal escrita: en qué línea del texto está y qué le pasa. */
export interface RuleError {
  line: number;
  text: string;
  message: string;
}

export interface CoverageView {
  results: CoverageResult[];
  errors: RuleError[];
}

/**
 * Nivel de color (0 a 4) de una celda de la matriz: 0 sin enlaces y, del 1 al 4, la cuarta parte del máximo en que cae. El color
 * nunca va solo: la celda escribe además su número.
 */
export function heatLevel(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || max <= 0) return 0;
  const ratio = count / max;
  return ratio <= 0.25 ? 1 : ratio <= 0.5 ? 2 : ratio <= 0.75 ? 3 : 4;
}

/**
 * Estado de la vista de trazabilidad: los documentos de varios módulos y el grafo que forman. No toca el DOM. Un documento
 * que no se puede leer no sustituye al que ya había (como en el banco de trabajo): el error se devuelve y todo sigue igual.
 */
export class TraceBoard {
  readonly documents = new Map<string, BoardDocument>();
  /** Tipos de enlace que se miran (vacío = todos). Solo cuentan los que hay en el grafo: ver `activeTypes`. */
  private selectedTypes = new Set<string>();
  /** Las reglas de cobertura, una por línea (`origen -> destino`); las líneas vacías y las que empiezan por `#` se ignoran. */
  coverageText = '';

  constructor(readonly sources: ModuleSource[]) {}

  private source(moduleId: string): ModuleSource {
    const source = this.sources.find((s) => s.id === moduleId);
    if (!source) throw new Error(`Este tablero no ofrece el módulo «${moduleId}». Módulos: ${this.sources.map((s) => s.id).join(', ')}.`);
    return source;
  }

  label(moduleId: string): string {
    return this.sources.find((s) => s.id === moduleId)?.label ?? moduleId;
  }

  /** Interpreta el texto (JSON del módulo), lo valida y lo incorpora. */
  async load(moduleId: string, text: string, origin: string): Promise<LoadResult> {
    const module = await this.source(moduleId).load();
    const analysis = analyzeText(module, text);
    switch (analysis.status) {
      case 'empty':
        return { ok: false, message: 'El documento está vacío.' };
      case 'syntax':
        return { ok: false, message: `No es JSON válido: ${analysis.error}` };
      case 'schema': {
        const shown = analysis.issues.slice(0, 3).map((i) => `${i.path}: ${i.message}`).join('; ');
        const more = analysis.issues.length > 3 ? ` (y ${analysis.issues.length - 3} más)` : '';
        return { ok: false, message: `No cumple el esquema del módulo: ${shown}${more}` };
      }
      case 'ok': {
        const entities = module.entities?.(analysis.document).length ?? 0;
        const issues = analysis.issues.filter((i) => i.severity !== 'info').length;
        this.documents.set(moduleId, { module, document: analysis.document, source: origin, entities, issues });
        return { ok: true, entities, issues };
      }
    }
  }

  async loadExample(moduleId: string): Promise<LoadResult> {
    const example = this.source(moduleId).example;
    if (!example) return { ok: false, message: 'Este módulo no trae ejemplo.' };
    return this.load(moduleId, await example(), 'ejemplo');
  }

  /** Carga el ejemplo de cada módulo que lo tenga. */
  async loadExamples(): Promise<Record<string, LoadResult>> {
    const results: Record<string, LoadResult> = {};
    for (const source of this.sources) results[source.id] = await this.loadExample(source.id);
    return results;
  }

  remove(moduleId: string): void {
    this.documents.delete(moduleId);
  }

  clear(): void {
    this.documents.clear();
  }

  /** El grafo de los documentos reunidos, en el orden de los módulos del tablero, con todos sus enlaces. */
  fullGraph(): TraceGraph {
    const order = this.sources.map((s) => s.id);
    const inputs = [...this.documents.entries()]
      .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
      .map(([, d]) => ({ module: d.module, document: d.document, source: d.source }));
    return buildTraceGraph(inputs);
  }

  /** Los tipos de enlace que hay en el grafo, con cuántos enlaces tiene cada uno (el de por omisión primero, luego por frecuencia). */
  linkTypes(graph: TraceGraph = this.fullGraph()): Array<{ type: string; count: number }> {
    const counts = new Map<string, number>();
    for (const l of graph.links) counts.set(l.type, (counts.get(l.type) ?? 0) + 1);
    return [...counts]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => Number(b.type === DEFAULT_LINK_TYPE) - Number(a.type === DEFAULT_LINK_TYPE) || b.count - a.count || a.type.localeCompare(b.type));
  }

  /** Los tipos filtrados que de verdad hay en el grafo: si se quitó el documento que los traía, el filtro deja de ocultarlo todo. */
  activeTypes(graph: TraceGraph = this.fullGraph()): string[] {
    const present = new Set(graph.links.map((l) => l.type));
    return [...this.selectedTypes].filter((t) => present.has(t));
  }

  setTypes(types: Iterable<string>): void {
    this.selectedTypes = new Set(types);
  }

  /** Marca o desmarca un tipo de enlace del filtro. */
  toggleType(type: string, on: boolean): void {
    if (on) this.selectedTypes.add(type);
    else this.selectedTypes.delete(type);
  }

  /** El grafo que se ve: el completo, o solo con los enlaces de los tipos elegidos. Las referencias sin resolver no se filtran. */
  graph(): TraceGraph {
    const full = this.fullGraph();
    return traceFilterTypes(full, this.activeTypes(full));
  }

  /** Elementos sin enlaces, de todos los módulos o de un módulo (y tipo de elemento). */
  orphans(filter: OrphanFilter = {}): TraceOrphans {
    return traceOrphans(this.graph(), filter);
  }

  matrix(by: MatrixBy): TraceMatrix {
    return traceMatrix(this.graph(), { by });
  }

  /** Mide las reglas del texto; una línea mal escrita no impide medir las demás, y se devuelve con su motivo. */
  coverage(): CoverageView {
    const errors: RuleError[] = [];
    const rules: CoverageRule[] = [];
    const known = this.sources.map((s) => s.id);
    this.coverageText.split(/\r?\n/).forEach((raw, index) => {
      const text = raw.trim();
      if (!text || text.startsWith('#')) return;
      try {
        const rule = parseCoverageRule(text);
        const unknown = [rule.origin, rule.destination].find((side) => !known.includes(side.module));
        if (unknown) throw new Error(`no existe el módulo «${unknown.module}». Módulos: ${known.join(', ')}.`);
        rules.push(rule);
      } catch (error) {
        errors.push({ line: index + 1, text, message: (error as Error).message });
      }
    });
    return { results: traceCoverage(this.graph(), rules), errors };
  }

  moduleLabels(): Record<string, string> {
    return Object.fromEntries(this.sources.map((s) => [s.id, s.label]));
  }
}
