/**
 * Un caso de medición del autolayout en Node: `tsx scripts/perf/layoutCase.ts <módulo> <tamaño> <repeticiones> [modo]`.
 * Imprime una línea JSON con los tiempos de cada repetición. Lo lanza `npm run perf layout` en un proceso aparte por caso,
 * para poder cortarlo si ELK tarda minutos (una llamada de ELK es síncrona y no se puede interrumpir desde dentro).
 *
 * Mide, por repetición y en milisegundos: validar el documento con el esquema (`parse`), proyectar la vista (`project`), calcular
 * el autolayout (`layout`: ELK) y construir los nodos y aristas de React Flow (`build`, solo en los módulos con lienzo común).
 * La primera repetición incluye el calentamiento del JIT de V8; por eso se anotan todas.
 */
import { c4Module } from '@iark/domain-c4';
import { layoutView, type LayoutOptions } from '@iark/domain-c4';
import { dataModule } from '@iark/domain-data';
import { enterpriseModule } from '@iark/domain-enterprise';
import { integrationModule } from '@iark/domain-integration';
import { platformModule } from '@iark/domain-platform';
import { securityModule } from '@iark/domain-security';
import type { DomainModule, EditorSpec } from '@iark/kernel';
import { autolayoutGraph } from '../../src/modules-app/canvas/autolayout';
import { buildFlow } from '../../src/modules-app/canvas/flow';
import { generateDocument, type PerfModuleId } from '../../tests/perf/generators';

const MODULES: Record<PerfModuleId, DomainModule<never>> = {
  c4: c4Module as DomainModule<never>,
  integration: integrationModule as DomainModule<never>,
  data: dataModule as DomainModule<never>,
  enterprise: enterpriseModule as DomainModule<never>,
  platform: platformModule as DomainModule<never>,
  security: securityModule as DomainModule<never>,
};

export interface LayoutRun {
  parse: number;
  project?: number;
  layout: number;
  build?: number;
}

export interface LayoutCaseResult {
  module: PerfModuleId;
  size: number;
  mode: string;
  nodes: number;
  edges: number;
  groups: number;
  /** Tamaño del dibujo que dejó el autolayout (solo en los módulos con lienzo común). */
  extent?: { width: number; height: number };
  runs: LayoutRun[];
}

const time = async <T>(fn: () => T | Promise<T>): Promise<[T, number]> => {
  const start = performance.now();
  const value = await fn();
  return [value, performance.now() - start];
};

async function runC4(size: number, runs: number, mode: string): Promise<LayoutCaseResult> {
  const generated = generateDocument('c4', size);
  const results: LayoutRun[] = [];
  let nodes = 0;
  let edges = 0;
  for (let i = 0; i < runs; i++) {
    const [doc, parse] = await time(() => c4Module.schema.parse(generated.document));
    // `smart`: la estrategia por omisión (prueba varias variantes de ELK y se queda con la de mejor calidad);
    // `fast`: una sola pasada de ELK; `interactive`: conserva las posiciones ya calculadas y coloca solo lo nuevo.
    let options: LayoutOptions = { force: true };
    if (mode === 'fast') options = { force: true, fast: true };
    if (mode === 'interactive') {
      const first = await layoutView(doc, generated.viewId!, { force: true, fast: true });
      const view = doc.views.find((v) => v.id === generated.viewId)!;
      const placed = new Map(first.positions.map((p) => [p.id, p]));
      // Todos con su posición salvo el último: así ELK entra en su modo interactivo (conserva lo colocado y coloca lo nuevo).
      view.elements = view.elements.map((el, index) => (index === view.elements.length - 1 ? { id: el.id } : { ...el, ...(placed.get(el.id) ?? {}) }));
      options = {};
    }
    const [result, layout] = await time(() => layoutView(doc, generated.viewId!, options));
    nodes = result.positions.length;
    edges = result.routes.length;
    results.push({ parse, layout });
  }
  return { module: 'c4', size, mode, nodes, edges, groups: 1, runs: results };
}

async function runGraph(moduleId: PerfModuleId, size: number, runs: number, mode: string): Promise<LayoutCaseResult> {
  const generated = generateDocument(moduleId, size);
  const module = MODULES[moduleId];
  const spec = module.editor as unknown as EditorSpec<unknown>;
  const results: LayoutRun[] = [];
  let nodes = 0;
  let edges = 0;
  let groups = 0;
  let extent: { width: number; height: number } | undefined;
  // `normal` / `fast` fuerzan el esfuerzo de ELK; `default` es el que elige el lienzo según el tamaño.
  const effort = mode === 'normal' || mode === 'fast' ? mode : undefined;
  for (let i = 0; i < runs; i++) {
    const [doc, parse] = await time(() => module.schema.parse(generated.document));
    const [graph, project] = await time(() => spec.project(doc, generated.viewId));
    const [layout, ms] = await time(() => autolayoutGraph(spec, doc, graph, generated.viewId, { effort }));
    const [, build] = await time(() => buildFlow(spec, graph, layout, new Map()));
    nodes = graph.nodes.length;
    edges = graph.edges.length;
    groups = layout.groups.length;
    extent = { width: layout.width, height: layout.height };
    results.push({ parse, project, layout: ms, build });
  }
  return { module: moduleId, size, mode, nodes, edges, groups, extent, runs: results };
}

export async function runLayoutCase(moduleId: PerfModuleId, size: number, runs: number, mode: string): Promise<LayoutCaseResult> {
  return moduleId === 'c4' ? runC4(size, runs, mode) : runGraph(moduleId, size, runs, mode);
}

const [moduleId, size, runs, mode] = process.argv.slice(2);
if (moduleId && size) {
  runLayoutCase(moduleId as PerfModuleId, Number(size), Number(runs ?? 3), mode ?? (moduleId === 'c4' ? 'smart' : 'default')).then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exit(0);
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exit(1);
    },
  );
}
