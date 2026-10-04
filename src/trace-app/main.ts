import '../modules-app/workbench.css';
import './trace.css';
import { traceMermaid, traceReach, traceReachReport, traceReport, traceSvg, type Reached, type TraceDirection, type TraceGraph, type TraceNode, type TraceProblemReason } from '@iark/kernel';
import { downloadText, readFile, svgDataUrl } from '../modules-app/files';
import { MODULE_SOURCES } from '../modules-app/modules';
import { TraceBoard } from './board';

/**
 * Vista de trazabilidad entre módulos (`trazabilidad.html`): reúne los documentos de varios módulos (ejemplos, archivos o
 * texto pegado), dibuja los enlaces por URN (`ref`) que hay entre ellos y calcula qué alcanza un elemento. Todo ocurre en
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

// ───────────── pestañas ─────────────

type TabId = 'graph' | 'links' | 'problems' | 'reach';
const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'graph', label: 'Grafo' },
  { id: 'links', label: 'Enlaces' },
  { id: 'problems', label: 'Sin resolver' },
  { id: 'reach', label: 'Alcance' },
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
  const pairs = new Map<string, Array<[TraceNode, TraceNode]>>();
  for (const link of graph.links) {
    const from = byUrn.get(link.from)!;
    const to = byUrn.get(link.to)!;
    const key = `${board.label(from.module)} → ${board.label(to.module)}`;
    pairs.set(key, [...(pairs.get(key) ?? []), [from, to]]);
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
          h('thead', {}, h('tr', {}, h('th', {}, 'Se apoya'), h('th', {}, 'En'))),
          h('tbody', {}, ...rows.map(([from, to]) => h('tr', {}, h('td', {}, from.name, ' ', h('small', {}, `${from.module}:${from.id} · ${from.kind}`)), h('td', {}, to.name, ' ', h('small', {}, `${to.module}:${to.id} · ${to.kind}`))))),
        ),
      ),
    ),
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
      h('thead', {}, h('tr', {}, h('th', {}, 'Elemento'), h('th', {}, 'Referencia'), h('th', {}, 'Motivo'))),
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

// ───────────── vista ─────────────

let renderToken = 0;
async function render(): Promise<void> {
  const token = ++renderToken;
  renderDocuments();
  let graph: TraceGraph;
  try {
    graph = board.graph();
  } catch (error) {
    for (const panel of panels.values()) panel.replaceChildren(h('p', { class: 'wb-note', role: 'alert' }, (error as Error).message));
    return;
  }
  el('summary').textContent = graph.documents.length === 0 ? 'sin documentos' : `${graph.documents.length} documentos · ${graph.links.length} enlaces${graph.problems.length ? ` · ${graph.problems.length} sin resolver` : ''}`;
  renderTabs({ links: graph.links.length, problems: graph.problems.length });
  renderLinks(graph);
  renderProblems(graph);
  // Solo se dibuja lo que se ve: el layout (ELK) es lo más caro.
  if (tab === 'graph') await renderGraph(graph);
  else if (tab === 'reach') await renderReach(graph);
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
