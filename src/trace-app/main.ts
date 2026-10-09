// Antes que cualquier otro import (se crean esquemas de zod al cargarlos): sin el modo JIT de zod no hay violaciones de la CSP por `new Function`.
import '@iark/kernel/jitless';
import '../modules-app/workbench.css';
import './trace.css';
import {
  coverageShortfalls,
  DEFAULT_LINK_TYPE,
  matrixCount,
  matrixTypes,
  TRACE_LINK_TYPES,
  traceMatrixReport,
  traceMermaid,
  traceReach,
  traceReachReport,
  traceReport,
  traceSvg,
  type CoverageResult,
  type MatrixBy,
  type Reached,
  type TraceDirection,
  type TraceGraph,
  type TraceMatrix,
  type TraceNode,
  type TraceProblemReason,
} from '@iark/kernel';
import { downloadText, readFile, svgDataUrl } from '../modules-app/files';
import { MODULE_SOURCES } from '../modules-app/modules';
import { heatLevel, TraceBoard } from './board';

/**
 * Vista de trazabilidad entre módulos (`trazabilidad.html`): reúne los documentos de varios módulos (ejemplos, archivos o
 * texto pegado), dibuja los enlaces por URN (`ref`) que hay entre ellos, con el tipo de cada uno (`refType`), y calcula qué
 * alcanza un elemento, la matriz de enlaces, los elementos sin enlaces (huérfanos) y la cobertura de unas reglas. Todo ocurre en
 * el navegador con el mismo código del CLI (`iark trace`) y del servicio (`POST /api/trace`).
 */
const params = new URLSearchParams(window.location.search);
const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
document.documentElement.dataset.theme = params.get('theme') ?? (prefersDark ? 'dark' : 'light');

const board = new TraceBoard(MODULE_SOURCES);
const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** Crea un elemento; el texto va siempre como `textContent` (los documentos vienen de fuera). */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  node.append(...children);
  return node;
}

// ───────────── documentos ─────────────

const messages = new Map<string, { error: boolean; text: string }>();

function describe(moduleId: string): { chip: string; kind: 'ok' | 'info' | 'warning' | 'error' } {
  const doc = board.documents.get(moduleId);
  if (!doc) return { chip: 'sin documento', kind: 'info' };
  if (doc.issues > 0) return { chip: `${doc.entities} elementos · ${doc.issues} avisos`, kind: 'warning' };
  return { chip: `${doc.entities} elementos`, kind: 'ok' };
}

async function apply(moduleId: string, text: string, origin: string): Promise<void> {
  const result = await board.load(moduleId, text, origin);
  if (result.ok) messages.set(moduleId, { error: false, text: `Cargado desde ${origin}.` });
  else messages.set(moduleId, { error: true, text: result.message });
  await render();
}

function renderDocuments(): void {
  const host = el('docs');
  host.replaceChildren(
    ...board.sources.map((source) => {
      const { chip, kind } = describe(source.id);
      const message = messages.get(source.id);
      const paste = h('textarea', { 'aria-label': `JSON de ${source.label}`, spellcheck: 'false', placeholder: 'Pega aquí el documento JSON del módulo' });
      const file = h('input', { type: 'file', accept: '.json,application/json', class: 'wb-visually-hidden' });
      file.addEventListener('change', () => {
        const chosen = file.files?.[0];
        file.value = '';
        if (chosen) void readFile(chosen).then((text) => apply(source.id, text, chosen.name));
      });
      return h(
        'section',
        { class: `tr-doc${board.documents.has(source.id) ? ' loaded' : ''}`, 'data-module': source.id },
        h('header', {}, h('strong', {}, source.label), h('span', { class: `wb-chip ${kind}` }, chip)),
        h(
          'div',
          { class: 'tr-doc-actions' },
          source.example ? h('button', { type: 'button', onClick: () => void board.loadExample(source.id).then((r) => { messages.set(source.id, r.ok ? { error: false, text: 'Cargado el ejemplo.' } : { error: true, text: r.message }); return render(); }) }, 'Ejemplo') : '',
          h('label', { class: 'wb-btn' }, 'Abrir archivo…', file),
          h('button', { type: 'button', disabled: !board.documents.has(source.id), onClick: () => { board.remove(source.id); messages.delete(source.id); void render(); } }, 'Quitar'),
        ),
        h(
          'details',
          {},
          h('summary', {}, 'Pegar JSON'),
          paste,
          h('div', { class: 'tr-doc-actions' }, h('button', { type: 'button', onClick: () => void apply(source.id, paste.value, 'pegado') }, 'Aplicar')),
        ),
        message ? h('p', { class: `tr-doc-msg${message.error ? ' error' : ''}`, role: message.error ? 'alert' : 'status' }, message.text) : '',
      );
    }),
  );
}

// ───────────── filtro por tipo de enlace ─────────────

const typeInfo = (type: string): string => TRACE_LINK_TYPES.find((t) => t.id === type)?.description ?? 'Tipo de enlace fuera del vocabulario sugerido.';

/** Casillas de los tipos de enlace que hay en los documentos; marcadas, el resto de vistas solo miran esos enlaces. */
function renderTypes(full: TraceGraph): void {
  const host = el('types');
  const types = board.linkTypes(full);
  host.hidden = types.length === 0;
  if (types.length === 0) return void host.replaceChildren();
  const active = new Set(board.activeTypes(full));
  host.replaceChildren(
    h(
      'fieldset',
      { class: 'tr-types-set' },
      h('legend', {}, 'Tipo de enlace'),
      ...types.map(({ type, count }) => {
        const box = h('input', { type: 'checkbox', value: type, checked: active.has(type), 'aria-label': `${type} (${count})` });
        box.addEventListener('change', () => {
          board.toggleType(type, box.checked);
          void render();
        });
        return h('label', { class: 'tr-type', title: typeInfo(type) }, box, h('span', {}, `${type} `), h('small', {}, `(${count})`));
      }),
      h('button', { type: 'button', disabled: active.size === 0, onClick: () => { board.setTypes([]); void render(); } }, 'Todos'),
    ),
    h('p', { class: 'tr-types-note' }, active.size === 0 ? 'Se ven todos los enlaces. Marca tipos para mirar solo esos; las referencias sin resolver se muestran siempre.' : `Solo se ven los enlaces de ${[...active].join(', ')}.`),
  );
}

// ───────────── pestañas ─────────────

type TabId = 'graph' | 'links' | 'problems' | 'reach' | 'matrix' | 'orphans' | 'coverage';
const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'graph', label: 'Grafo' },
  { id: 'links', label: 'Enlaces' },
  { id: 'problems', label: 'Sin resolver' },
  { id: 'reach', label: 'Alcance' },
  { id: 'matrix', label: 'Matriz' },
  { id: 'orphans', label: 'Huérfanos' },
  { id: 'coverage', label: 'Cobertura' },
];
let tab: TabId = (params.get('tab') as TabId | null) && TABS.some((t) => t.id === params.get('tab')) ? (params.get('tab') as TabId) : 'graph';

const panels = new Map<TabId, HTMLElement>(TABS.map((t) => [t.id, h('section', { class: 'tr-panel', role: 'tabpanel', id: `panel-${t.id}`, 'aria-labelledby': `tab-${t.id}` })]));
el('panels').append(...panels.values());

function renderTabs(counts: Partial<Record<TabId, number>>): void {
  el('tabs').replaceChildren(
    ...TABS.map((t) =>
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          id: `tab-${t.id}`,
          'aria-selected': String(tab === t.id),
          'aria-controls': `panel-${t.id}`,
          onClick: () => {
            tab = t.id;
            void render();
          },
        },
        counts[t.id] === undefined ? t.label : `${t.label} (${counts[t.id]})`,
      ),
    ),
  );
  for (const [id, panel] of panels) panel.hidden = id !== tab;
}

const nodeLabel = (n: TraceNode): string => `${n.name} (${n.module}:${n.id})`;
const empty = (text: string): HTMLElement => h('p', { class: 'wb-empty' }, text);
const typeChip = (type: string): HTMLElement => h('span', { class: `tr-link-type${type === DEFAULT_LINK_TYPE ? '' : ' typed'}`, title: typeInfo(type) }, type);

const LEGEND: Array<[string, string]> = [
  ['#0f172a', 'punto de partida'],
  ['#f59e0b', 'se apoya en él'],
  ['#22c55e', 'de lo que se apoya'],
];

let fullSize = false;

async function renderGraph(graph: TraceGraph): Promise<void> {
  const panel = panels.get('graph')!;
  if (graph.documents.length === 0) return void panel.replaceChildren(empty('Carga los documentos de al menos dos módulos, o pulsa «Cargar los ejemplos», para ver los enlaces entre ellos.'));
  const svg = await traceSvg(graph, { title: 'Trazabilidad entre módulos', moduleLabels: board.moduleLabels() });
  const canvas = h('div', { class: `tr-canvas${fullSize ? ' actual' : ''}` }, h('img', { src: svgDataUrl(svg), alt: `Grafo de trazabilidad: ${graph.links.length} enlaces entre ${graph.documents.length} módulos` }));
  const size = h('button', { type: 'button', onClick: () => { fullSize = !fullSize; canvas.classList.toggle('actual', fullSize); size.textContent = fullSize ? 'Ajustar al ancho' : 'Tamaño real'; } }, fullSize ? 'Ajustar al ancho' : 'Tamaño real');
  panel.replaceChildren(
    h(
      'div',
      { class: 'tr-toolbar' },
      size,
      h('button', { type: 'button', onClick: () => downloadText('trazabilidad.svg', svg, 'image/svg+xml') }, 'Descargar SVG'),
      h('button', { type: 'button', onClick: () => downloadText('trazabilidad.mmd', `${traceMermaid(graph)}\n`, 'text/plain') }, 'Descargar Mermaid'),
      h('button', { type: 'button', onClick: () => downloadText('trazabilidad.md', `${traceReport(graph)}\n`, 'text/markdown') }, 'Descargar informe'),
    ),
    canvas,
  );
}

function renderLinks(graph: TraceGraph): void {
  const panel = panels.get('links')!;
  if (graph.links.length === 0) return void panel.replaceChildren(empty(graph.documents.length === 0 ? 'Todavía no hay documentos.' : 'No hay enlaces resolubles entre los documentos aportados.'));
  const byUrn = new Map(graph.nodes.map((n) => [n.urn, n]));
  const pairs = new Map<string, Array<[TraceNode, TraceNode, string]>>();
  for (const link of graph.links) {
    const from = byUrn.get(link.from)!;
    const to = byUrn.get(link.to)!;
    const key = `${board.label(from.module)} → ${board.label(to.module)}`;
    pairs.set(key, [...(pairs.get(key) ?? []), [from, to, link.type]]);
  }
  panel.replaceChildren(
    ...[...pairs].sort(([a], [b]) => a.localeCompare(b)).map(([pair, rows]) =>
      h(
        'div',
        { class: 'tr-pair' },
        h('h3', {}, `${pair} (${rows.length})`),
        h(
          'table',
          { class: 'tr-table' },
          h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Se apoya'), h('th', { scope: 'col' }, 'En'), h('th', { scope: 'col' }, 'Tipo'))),
          h('tbody', {}, ...rows.map(([from, to, type]) => h('tr', {}, h('td', {}, from.name, ' ', h('small', {}, `${from.module}:${from.id} · ${from.kind}`)), h('td', {}, to.name, ' ', h('small', {}, `${to.module}:${to.id} · ${to.kind}`)), h('td', {}, typeChip(type))))),
        ),
      ),
    ),
    ...(graph.notices.length === 0
      ? []
      : [
          h(
            'div',
            { class: 'tr-pair' },
            h('h3', {}, `Avisos (${graph.notices.length})`),
            h('ul', { class: 'tr-notices' }, ...graph.notices.map((n) => h('li', {}, nodeLabel(byUrn.get(n.from)!), ': ', n.message))),
          ),
        ]),
  );
}

// Un `Record` completo: si el núcleo añade un motivo nuevo, `tsc` obliga a darle texto aquí (el chip «Motivo» no puede salir vacío).
const REASONS: Record<TraceProblemReason, string> = { dangling: 'no existe', unresolved: 'módulo sin documento', invalid: 'URN inválida', ambiguous: 'definido en varios documentos' };
const REASON_TONE: Record<TraceProblemReason, 'info' | 'warning' | 'error'> = { dangling: 'error', unresolved: 'info', invalid: 'error', ambiguous: 'warning' };

function renderProblems(graph: TraceGraph): void {
  const panel = panels.get('problems')!;
  if (graph.problems.length === 0) return void panel.replaceChildren(empty(graph.documents.length === 0 ? 'Todavía no hay documentos.' : 'Todas las referencias se resuelven.'));
  const byUrn = new Map(graph.nodes.map((n) => [n.urn, n]));
  panel.replaceChildren(
    h(
      'table',
      { class: 'tr-table' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Elemento'), h('th', { scope: 'col' }, 'Referencia'), h('th', { scope: 'col' }, 'Motivo'))),
      h('tbody', {}, ...graph.problems.map((p) => h('tr', {}, h('td', {}, nodeLabel(byUrn.get(p.from)!)), h('td', {}, h('code', {}, p.ref)), h('td', {}, h('span', { class: `wb-chip ${REASON_TONE[p.reason]}` }, REASONS[p.reason]), ' ', h('small', {}, p.message))))),
    ),
  );
}

let selected = '';
let direction: TraceDirection = 'both';
let depth = '';
let reachToken = 0;

async function renderReach(graph: TraceGraph): Promise<void> {
  const panel = panels.get('reach')!;
  const linked = new Set(graph.links.flatMap((l) => [l.from, l.to]));
  const nodes = graph.nodes.filter((n) => linked.has(n.urn));
  if (nodes.length === 0) return void panel.replaceChildren(empty('Para calcular un alcance hacen falta elementos enlazados: carga los documentos de dos módulos que se referencien.'));
  if (!nodes.some((n) => n.urn === selected)) selected = nodes[0].urn;

  const select = h('select', { id: 'reach-from', 'aria-label': 'Elemento de partida' });
  for (const module of board.sources) {
    const group = nodes.filter((n) => n.module === module.id);
    if (group.length === 0) continue;
    select.append(h('optgroup', { label: module.label }, ...group.map((n) => h('option', { value: n.urn, selected: n.urn === selected }, `${n.name} (${n.id})`))));
  }
  const dir = h('select', { id: 'reach-direction', 'aria-label': 'Sentido' },
    h('option', { value: 'both', selected: direction === 'both' }, 'Los dos sentidos'),
    h('option', { value: 'referrers', selected: direction === 'referrers' }, 'Quién se apoya en él (impacto)'),
    h('option', { value: 'refs', selected: direction === 'refs' }, 'De qué se apoya'),
  );
  const limit = h('input', { id: 'reach-depth', type: 'number', min: '1', placeholder: 'sin límite', value: depth, 'aria-label': 'Saltos máximos' });
  const result = h('div', {});
  const update = (): void => {
    selected = select.value;
    direction = dir.value as TraceDirection;
    depth = limit.value;
    void showReach();
  };
  for (const control of [select, dir, limit]) control.addEventListener('change', update);

  async function showReach(): Promise<void> {
    const token = ++reachToken;
    const n = Number.parseInt(depth, 10);
    let reached: Reached[];
    try {
      reached = traceReach(graph, selected, { direction, depth: Number.isInteger(n) && n >= 1 ? n : undefined });
    } catch (error) {
      result.replaceChildren(h('p', { class: 'wb-note', role: 'alert' }, (error as Error).message));
      return;
    }
    const svg = await traceSvg(graph, { reached, moduleLabels: board.moduleLabels() });
    if (token !== reachToken) return;
    result.replaceChildren(
      h('div', { class: 'tr-canvas' }, h('img', { src: svgDataUrl(svg), alt: `Alcance de ${nodeLabel(reached[0].node)}: ${reached.length - 1} elementos` })),
      h('p', { class: 'tr-legend' }, ...LEGEND.map(([color, text]) => h('span', {}, h('i', { style: `border-color:${color}` }), text))),
      h('pre', { class: 'tr-report' }, traceReachReport(reached, direction).replace(/\*\*/g, '')),
    );
  }

  panel.replaceChildren(
    h('div', { class: 'tr-toolbar' }, h('label', {}, 'Elemento', select), h('label', {}, 'Sentido', dir), h('label', {}, 'Saltos', limit)),
    result,
  );
  await showReach();
}

// ───────────── matriz ─────────────

let matrixBy: MatrixBy = 'module';

/** `security` → «Seguridad»; `security:asset` → «Seguridad · asset». */
function axisLabel(key: string): string {
  const at = key.indexOf(':');
  return at < 0 ? board.label(key) : `${board.label(key.slice(0, at))} · ${key.slice(at + 1)}`;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const typeCounts = (types: Record<string, number>): string => Object.entries(types).map(([type, n]) => `${type} ${n}`).join(', ');

/** Tabla origen × destino con totales; el color de cada celda es el calor (proporción del máximo) y el número, el recuento exacto. */
function matrixTable(matrix: TraceMatrix): HTMLElement {
  const max = Math.max(0, ...matrix.cells.map((c) => c.count));
  const by = matrix.by === 'kind' ? 'tipo de elemento' : 'módulo';
  return h(
    'table',
    { class: 'tr-table tr-matrix', 'data-by': matrix.by },
    h('caption', {}, `Enlaces por ${by}: cada fila es el origen del enlace y cada columna su destino`),
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Origen \\ Destino'), ...matrix.columns.map((c) => h('th', { scope: 'col' }, axisLabel(c))), h('th', { scope: 'col' }, 'Total'))),
    h(
      'tbody',
      {},
      ...matrix.rows.map((row) =>
        h(
          'tr',
          {},
          h('th', { scope: 'row' }, axisLabel(row)),
          ...matrix.columns.map((column) => {
            const count = matrixCount(matrix, row, column);
            const cell = matrix.cells.find((c) => c.from === row && c.to === column);
            const title = cell ? `${plural(count, 'enlace', 'enlaces')} de ${axisLabel(row)} a ${axisLabel(column)}: ${typeCounts(cell.types)}` : `Sin enlaces de ${axisLabel(row)} a ${axisLabel(column)}`;
            return h('td', { class: `tr-heat heat-${heatLevel(count, max)}`, title, 'data-count': String(count) }, String(count));
          }),
          h('td', { class: 'tr-total' }, String(matrix.rowTotals[row])),
        ),
      ),
    ),
    h('tfoot', {}, h('tr', {}, h('th', { scope: 'row' }, 'Total'), ...matrix.columns.map((c) => h('td', { class: 'tr-total' }, String(matrix.columnTotals[c]))), h('td', { class: 'tr-total' }, String(matrix.total)))),
  );
}

/** Para cada par origen → destino, cuántos enlaces hay de cada tipo de enlace. */
function matrixBreakdown(matrix: TraceMatrix): HTMLElement {
  const types = matrixTypes(matrix);
  return h(
    'table',
    { class: 'tr-table tr-breakdown' },
    h('caption', {}, 'Desglose por tipo de enlace'),
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Origen → Destino'), ...types.map((t) => h('th', { scope: 'col' }, t)), h('th', { scope: 'col' }, 'Total'))),
    h(
      'tbody',
      {},
      ...matrix.cells.map((c) => h('tr', {}, h('th', { scope: 'row' }, `${axisLabel(c.from)} → ${axisLabel(c.to)}`), ...types.map((t) => h('td', {}, String(c.types[t] ?? 0))), h('td', { class: 'tr-total' }, String(c.count)))),
    ),
    h('tfoot', {}, h('tr', {}, h('th', { scope: 'row' }, 'Total'), ...types.map((t) => h('td', { class: 'tr-total' }, String(matrix.types[t]))), h('td', { class: 'tr-total' }, String(matrix.total)))),
  );
}

function renderMatrix(graph: TraceGraph): void {
  const panel = panels.get('matrix')!;
  if (graph.documents.length === 0) return void panel.replaceChildren(empty('Todavía no hay documentos.'));
  const by = h('select', { id: 'matrix-by', 'aria-label': 'Cruzar por' }, h('option', { value: 'module', selected: matrixBy === 'module' }, 'Módulo'), h('option', { value: 'kind', selected: matrixBy === 'kind' }, 'Tipo de elemento'));
  by.addEventListener('change', () => {
    matrixBy = by.value as MatrixBy;
    void render();
  });
  const matrix = board.matrix(matrixBy);
  const toolbar = h(
    'div',
    { class: 'tr-toolbar' },
    h('label', {}, 'Cruzar por', by),
    h('button', { type: 'button', disabled: matrix.total === 0, onClick: () => downloadText('trazabilidad-matriz.md', `${traceMatrixReport(matrix)}\n`, 'text/markdown') }, 'Descargar Markdown'),
  );
  if (matrix.total === 0) return void panel.replaceChildren(toolbar, empty('No hay enlaces entre los documentos aportados: la matriz está vacía.'));
  const max = Math.max(...matrix.cells.map((c) => c.count));
  panel.replaceChildren(
    toolbar,
    h('p', { class: 'tr-note' }, `${plural(matrix.total, 'enlace', 'enlaces')} (${typeCounts(matrix.types)}). El número de cada celda es el recuento exacto; su color, la proporción respecto del máximo (${max}).`),
    h('div', { class: 'tr-scroll' }, matrixTable(matrix)),
    h('p', { class: 'tr-legend tr-heat-legend' }, 'Proporción del máximo:', ...[1, 2, 3, 4].map((level) => h('span', {}, h('b', { class: `tr-swatch tr-heat heat-${level}` }, ['hasta ¼', 'hasta ½', 'hasta ¾', 'más de ¾'][level - 1])))),
    ...(matrixTypes(matrix).length > 1 ? [h('div', { class: 'tr-scroll' }, matrixBreakdown(matrix))] : []),
  );
}

// ───────────── huérfanos ─────────────

let orphanModule = '';
let orphanKind = '';

function renderOrphans(graph: TraceGraph): void {
  const panel = panels.get('orphans')!;
  if (graph.documents.length === 0) return void panel.replaceChildren(empty('Todavía no hay documentos.'));
  const modules = board.sources.filter((s) => graph.documents.some((d) => d.module === s.id));
  if (!modules.some((m) => m.id === orphanModule)) {
    orphanModule = '';
    orphanKind = '';
  }
  const kinds = [...new Set(graph.nodes.filter((n) => n.module === orphanModule).map((n) => n.kind))].sort();
  if (!kinds.includes(orphanKind)) orphanKind = '';
  const module = h('select', { id: 'orphans-module', 'aria-label': 'Módulo' }, h('option', { value: '', selected: orphanModule === '' }, 'Todos los módulos'), ...modules.map((m) => h('option', { value: m.id, selected: m.id === orphanModule }, m.label)));
  const kind = h('select', { id: 'orphans-kind', 'aria-label': 'Tipo de elemento', disabled: orphanModule === '' }, h('option', { value: '', selected: orphanKind === '' }, 'Todos los tipos'), ...kinds.map((k) => h('option', { value: k, selected: k === orphanKind }, k)));
  module.addEventListener('change', () => {
    orphanModule = module.value;
    orphanKind = '';
    void render();
  });
  kind.addEventListener('change', () => {
    orphanKind = kind.value;
    void render();
  });
  const result = board.orphans({ ...(orphanModule ? { module: orphanModule } : {}), ...(orphanKind ? { kind: orphanKind } : {}) });
  panel.replaceChildren(
    h('div', { class: 'tr-toolbar' }, h('label', {}, 'Módulo', module), h('label', {}, 'Tipo de elemento', kind)),
    h('p', { class: 'tr-note' }, 'Un elemento sin enlaces no es un error: no todo tiene por qué estar enlazado. Cuentan solo los enlaces resueltos y, si hay un filtro por tipo de enlace, los de esos tipos.'),
    h('p', { class: 'tr-summary', role: 'status' }, result.considered === 0 ? 'No hay elementos que examinar.' : `${result.count} de ${plural(result.considered, 'elemento', 'elementos')} no tienen ningún enlace.`),
    ...result.groups.map((g) =>
      h(
        'section',
        { class: 'tr-orphan-group' },
        h('h3', {}, `${board.label(g.module)} · ${g.kind} (${g.orphans.length} de ${g.total})`),
        h('ul', {}, ...g.orphans.map((n) => h('li', {}, n.name, ' ', h('small', {}, n.id)))),
      ),
    ),
  );
}

// ───────────── cobertura ─────────────

let minCoverage = '100';
const EXAMPLE_RULES = ['security:asset -> platform', 'platform:service -> integration', 'enterprise:application -> integration'].join('\n');

function percentText(r: CoverageResult): string {
  return r.percent === null ? 'no aplicable' : `${String(r.percent).replace('.', ',')} %`;
}

function renderCoverage(): void {
  const panel = panels.get('coverage')!;
  const rules = h('textarea', { id: 'coverage-rules', 'aria-label': 'Reglas de cobertura', rows: '4', spellcheck: 'false', placeholder: 'security:asset -> platform\nplatform:service -> integration' });
  rules.value = board.coverageText;
  const min = h('input', { id: 'coverage-min', type: 'number', min: '0', max: '100', step: 'any', value: minCoverage, 'aria-label': 'Mínimo (%)' });
  const measure = (): void => {
    board.coverageText = rules.value;
    minCoverage = min.value;
    void render();
  };
  const view = board.coverage();
  const threshold = min.value === '' || !Number.isFinite(Number(min.value)) ? 100 : Math.min(100, Math.max(0, Number(min.value)));
  const short = new Set(coverageShortfalls(view.results, threshold));

  panel.replaceChildren(
    h(
      'div',
      { class: 'tr-coverage-form' },
      h('label', { for: 'coverage-rules' }, 'Reglas «origen -> destino», una por línea (cada lado, un módulo o módulo:tipo; # para comentar)'),
      rules,
      h(
        'div',
        { class: 'tr-toolbar' },
        h('button', { type: 'button', class: 'primary', onClick: measure }, 'Medir'),
        h('button', { type: 'button', onClick: () => { rules.value = EXAMPLE_RULES; measure(); } }, 'Reglas de ejemplo'),
        h('label', {}, 'Mínimo (%)', min),
      ),
      h('p', { class: 'tr-note' }, 'Un elemento del origen está cubierto si tiene un enlace saliente hacia algún elemento del destino (la dirección importa). Una regla sin elementos de origen no es aplicable.'),
    ),
    ...(view.errors.length === 0 ? [] : [h('ul', { class: 'tr-rule-errors', role: 'alert' }, ...view.errors.map((e) => h('li', {}, `Línea ${e.line} («${e.text}»): ${e.message}`)))]),
    ...(view.results.length === 0
      ? [empty(view.errors.length === 0 ? 'Escribe una o más reglas y pulsa «Medir».' : 'Ninguna regla se pudo leer.')]
      : [
          h(
            'table',
            { class: 'tr-table tr-coverage' },
            h('caption', {}, `Cobertura de ${plural(view.results.length, 'regla', 'reglas')} (mínimo ${String(threshold).replace('.', ',')} %)`),
            h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Regla'), h('th', { scope: 'col' }, 'Cubiertos'), h('th', { scope: 'col' }, 'Total'), h('th', { scope: 'col' }, 'Cobertura'), h('th', { scope: 'col' }, 'Estado'))),
            h(
              'tbody',
              {},
              ...view.results.map((r) =>
                h(
                  'tr',
                  { 'data-rule': r.rule.text },
                  h('th', { scope: 'row' }, h('code', {}, r.rule.text)),
                  h('td', {}, r.applicable ? String(r.covered.length) : '—'),
                  h('td', {}, String(r.total)),
                  h('td', {}, r.percent === null ? '—' : h('meter', { min: '0', max: '100', value: String(r.percent), 'aria-label': `${r.rule.text}: ${percentText(r)}` }), ' ', percentText(r)),
                  h('td', {}, r.applicable ? h('span', { class: `wb-chip ${short.has(r) ? 'error' : 'ok'}` }, short.has(r) ? 'por debajo del mínimo' : 'cumple') : h('span', { class: 'wb-chip info' }, 'no aplicable')),
                ),
              ),
            ),
          ),
          ...view.results.map((r) =>
            h(
              'section',
              { class: 'tr-coverage-detail' },
              h('h3', {}, h('code', {}, r.rule.text)),
              ...(r.note ? [h('p', { class: 'tr-note' }, r.note)] : []),
              ...(r.applicable
                ? [
                    h('details', { open: r.uncovered.length > 0 }, h('summary', {}, `SIN cubrir (${r.uncovered.length})`), h('ul', {}, ...r.uncovered.map((n) => h('li', {}, nodeLabel(n), ' ', h('small', {}, n.kind))))),
                    h('details', {}, h('summary', {}, `Cubiertos (${r.covered.length})`), h('ul', {}, ...r.covered.map((n) => h('li', {}, nodeLabel(n), ' ', h('small', {}, n.kind))))),
                  ]
                : []),
            ),
          ),
        ]),
  );
}

// ───────────── vista ─────────────

let renderToken = 0;
async function render(): Promise<void> {
  const token = ++renderToken;
  renderDocuments();
  let full: TraceGraph;
  let graph: TraceGraph;
  try {
    full = board.fullGraph();
    graph = board.graph();
  } catch (error) {
    for (const panel of panels.values()) panel.replaceChildren(h('p', { class: 'wb-note', role: 'alert' }, (error as Error).message));
    el('types').hidden = true;
    return;
  }
  const links = graph.links.length === full.links.length ? `${graph.links.length} enlaces` : `${graph.links.length} de ${full.links.length} enlaces`;
  el('summary').textContent = graph.documents.length === 0 ? 'sin documentos' : `${graph.documents.length} documentos · ${links}${graph.problems.length ? ` · ${graph.problems.length} sin resolver` : ''}`;
  renderTypes(full);
  renderTabs({ links: graph.links.length, problems: graph.problems.length });
  renderLinks(graph);
  renderProblems(graph);
  // Solo se dibuja lo que se ve: el layout (ELK) es lo más caro.
  if (tab === 'graph') await renderGraph(graph);
  else if (tab === 'reach') await renderReach(graph);
  else if (tab === 'matrix') renderMatrix(graph);
  else if (tab === 'orphans') renderOrphans(graph);
  else if (tab === 'coverage') renderCoverage();
  if (token !== renderToken) return;
}

el('load-examples').addEventListener('click', () => {
  void board.loadExamples().then((results) => {
    for (const [id, r] of Object.entries(results)) messages.set(id, r.ok ? { error: false, text: 'Cargado el ejemplo.' } : { error: true, text: r.message });
    return render();
  });
});
el('clear-all').addEventListener('click', () => {
  board.clear();
  messages.clear();
  void render();
});

void render().then(() => {
  if (params.get('examples') === '1') el('load-examples').click();
});
