import { DEFAULT_LINK_TYPE, isSuggestedLinkType, isValidLinkType } from './link-types';
import type { AnyModule } from './operations';
import { formatUrn, parseUrn } from './urn';

/**
 * Trazabilidad entre módulos: los elementos de un documento apuntan a los de otro con una referencia URN
 * (`ref: "urn:iark:platform:pedidos"`), sin que ningún módulo conozca el código del otro. Aquí se reúnen los documentos
 * de varios módulos y se construye el grafo transversal: qué enlaces hay, cuáles apuntan a algo que no existe y qué se ve
 * afectado a un lado y otro de un elemento (p. ej. qué activos de seguridad y qué datos dependen de un servicio).
 */

export interface TraceInput {
  module: AnyModule;
  document: unknown;
  /** De dónde viene (nombre del archivo), para los mensajes. */
  source?: string;
}

export interface TraceNode {
  urn: string;
  module: string;
  id: string;
  name: string;
  kind: string;
}

/** `from` apunta a `to` con su `ref`. El `type` es el `refType` que declaró (siempre presente: `depends-on` si no declaró ninguno). */
export interface TraceLink {
  from: string;
  to: string;
  type: string;
}

export type TraceProblemReason = 'dangling' | 'unresolved' | 'invalid' | 'ambiguous';

export interface TraceProblem {
  from: string;
  ref: string;
  reason: TraceProblemReason;
  message: string;
}

/**
 * Algo que no rompe el grafo pero conviene saber, a diferencia de un `TraceProblem`: nunca hace fallar `--strict`.
 * `unknown-type`: el `refType` está fuera del vocabulario sugerido (`TRACE_LINK_TYPES`) y se acepta tal cual.
 * `invalid-type`: el `refType` no tiene la forma de un tipo (`[a-z][a-z0-9-]*`); el enlace cuenta como `depends-on`.
 */
export interface TraceNotice {
  from: string;
  ref: string;
  /** Lo que el elemento declaró en `refType`. */
  type: string;
  reason: 'unknown-type' | 'invalid-type';
  message: string;
}

export interface TraceGraph {
  documents: Array<{ module: string; source?: string; entities: number }>;
  nodes: TraceNode[];
  /** Enlaces con los dos extremos conocidos. */
  links: TraceLink[];
  /** Referencias que no se pudieron resolver: URN mal formada, elemento inexistente, o módulo sin documento aportado. */
  problems: TraceProblem[];
  /** Avisos informativos (tipos de enlace fuera del vocabulario sugerido…); no son errores. */
  notices: TraceNotice[];
}

interface CollectedRef {
  id: string;
  ref: string;
  /** El `refType` tal como lo declara el elemento (ausente si no lo declara o no es un texto). */
  refType?: string;
}

/** Referencias `{ id, ref, refType? }` de cualquier objeto del documento (los `ref` de los elementos de cada módulo). */
function collectRefs(value: unknown, out: CollectedRef[] = []): CollectedRef[] {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, out);
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.id === 'string' && typeof record.ref === 'string') {
      out.push({ id: record.id, ref: record.ref, ...(typeof record.refType === 'string' ? { refType: record.refType } : {}) });
    }
    for (const child of Object.values(record)) collectRefs(child, out);
  }
  return out;
}

export interface TraceOptions {
  /**
   * Admite varios documentos del mismo módulo (los diagramas de un proyecto). La URN no dice en qué documento está un
   * elemento, así que `urn:iark:<módulo>:<id>` se resuelve en todo el conjunto; si dos documentos definen el mismo id, la URN
   * apunta al primero y el otro queda como problema `ambiguous`. Sin esta opción, repetir un módulo es un error.
   */
  allowRepeatedModules?: boolean;
}

export function buildTraceGraph(inputs: TraceInput[], options: TraceOptions = {}): TraceGraph {
  const seen = new Set<string>();
  const nodes = new Map<string, TraceNode>();
  const owner = new Map<string, string>();
  const documents: TraceGraph['documents'] = [];
  const problems: TraceProblem[] = [];
  for (const { module, document, source } of inputs) {
    if (seen.has(module.id) && !options.allowRepeatedModules) throw new Error(`El módulo «${module.id}» aparece más de una vez: la trazabilidad usa un documento por módulo.`);
    seen.add(module.id);
    const entities = module.entities?.(document) ?? [];
    documents.push({ module: module.id, source, entities: entities.length });
    for (const e of entities) {
      const urn = formatUrn(module.id, e.id);
      if (nodes.has(urn)) {
        const first = owner.get(urn);
        if (first !== (source ?? module.id)) {
          problems.push({
            from: urn,
            ref: urn,
            reason: 'ambiguous',
            message: `«${e.id}» también está definido en ${source ? `«${source}»` : 'otro documento'}: la URN apunta al de ${first ? `«${first}»` : 'el primero'}.`,
          });
        }
        continue;
      }
      nodes.set(urn, { urn, module: module.id, id: e.id, name: e.name, kind: e.kind });
      owner.set(urn, source ?? module.id);
    }
  }

  const links: TraceLink[] = [];
  const notices: TraceNotice[] = [];
  const linked = new Set<string>();
  const noticed = new Set<string>();
  for (const { module, document } of inputs) {
    for (const { id, ref, refType } of collectRefs(document)) {
      const from = formatUrn(module.id, id);
      if (!nodes.has(from)) continue; // solo los elementos referenciables por URN participan
      const type = linkTypeOf(refType, from, ref, notices, noticed);
      const target = parseUrn(ref);
      if (!target) {
        problems.push({ from, ref, reason: 'invalid', message: `«${ref}» no es una URN válida (urn:iark:<módulo>:<id>).` });
      } else if (!seen.has(target.module)) {
        problems.push({ from, ref, reason: 'unresolved', message: `apunta al módulo «${target.module}», del que no se aportó ningún documento.` });
      } else if (!nodes.has(ref)) {
        problems.push({ from, ref, reason: 'dangling', message: `apunta a «${target.id}», que no existe en el documento del módulo «${target.module}».` });
      } else if (!linked.has(`${from} ${ref}`)) {
        linked.add(`${from} ${ref}`);
        links.push({ from, to: ref, type });
      }
    }
  }
  return { documents, nodes: [...nodes.values()], links, problems, notices };
}

/**
 * El tipo de un enlace: el `refType` declarado, o `depends-on` si falta. Un tipo con forma inválida cuenta como `depends-on`
 * y uno válido pero fuera del vocabulario sugerido se respeta; los dos dejan un aviso (uno por elemento y tipo).
 */
function linkTypeOf(declared: string | undefined, from: string, ref: string, notices: TraceNotice[], noticed: Set<string>): string {
  if (declared === undefined) return DEFAULT_LINK_TYPE;
  const valid = isValidLinkType(declared);
  if (!valid || !isSuggestedLinkType(declared)) {
    const key = `${from} ${declared}`;
    if (!noticed.has(key)) {
      noticed.add(key);
      notices.push(
        valid
          ? { from, ref, type: declared, reason: 'unknown-type', message: `el tipo de enlace «${declared}» no está en el vocabulario sugerido; se acepta tal cual.` }
          : { from, ref, type: declared, reason: 'invalid-type', message: `el tipo de enlace «${declared}» no tiene la forma [a-z][a-z0-9-]*; el enlace cuenta como «${DEFAULT_LINK_TYPE}».` },
      );
    }
  }
  return valid ? declared : DEFAULT_LINK_TYPE;
}

/**
 * El mismo grafo con solo los enlaces de esos tipos (la vista que piden `--type` y el campo `types` de `POST /api/trace`). Los
 * elementos, las referencias sin resolver y los avisos no se tocan: filtrar no oculta un enlace roto ni relaja `--strict`. Sin
 * tipos (lista vacía o ausente) devuelve el mismo grafo.
 */
export function traceFilterTypes(graph: TraceGraph, types?: readonly string[]): TraceGraph {
  if (!types || types.length === 0) return graph;
  const wanted = new Set(types);
  return { ...graph, links: graph.links.filter((l) => wanted.has(l.type)) };
}

export type TraceDirection = 'refs' | 'referrers' | 'both';

export interface Reached {
  node: TraceNode;
  /** Saltos desde el elemento de partida (0 para él mismo). */
  distance: number;
  /** Enlace por el que se llegó (ausente en el de partida). */
  via?: TraceLink;
  /** `refs`: se llegó siguiendo lo que referencia; `referrers`: siguiendo quién lo referencia. */
  direction?: 'refs' | 'referrers';
}

export interface TraceReachOptions {
  direction?: TraceDirection;
  /** Saltos máximos (sin límite por omisión). */
  depth?: number;
  /** Solo se siguen los enlaces de estos tipos (todos por omisión). El elemento de partida se incluye siempre. */
  types?: readonly string[];
}

/**
 * Lo que alcanza un elemento entre módulos. `refs` sigue sus referencias (de qué se apoya), `referrers` a quienes lo
 * referencian (quién se apoya en él: el impacto de tocarlo) y `both` las dos, cada una sin mezclarse con la otra. Con `types`
 * solo se atraviesan los enlaces de esos tipos.
 */
export function traceReach(graph: TraceGraph, urn: string, options: TraceReachOptions = {}): Reached[] {
  const start = graph.nodes.find((n) => n.urn === urn);
  if (!start) {
    const sample = graph.nodes.slice(0, 5).map((n) => n.urn).join(', ');
    throw new Error(`No existe el elemento «${urn}» en los documentos aportados${sample ? ` (p. ej. ${sample})` : ''}.`);
  }
  const direction = options.direction ?? 'both';
  const depth = options.depth ?? Infinity;
  const allowed = options.types && options.types.length > 0 ? new Set(options.types) : undefined;
  const byUrn = new Map(graph.nodes.map((n) => [n.urn, n]));
  const result: Reached[] = [{ node: start, distance: 0 }];
  for (const dir of ['refs', 'referrers'] as const) {
    if (direction !== 'both' && direction !== dir) continue;
    const visited = new Set([urn]);
    let frontier = [urn];
    for (let distance = 1; distance <= depth && frontier.length > 0; distance++) {
      const next: string[] = [];
      for (const current of frontier) {
        for (const link of graph.links) {
          const [here, there] = dir === 'refs' ? [link.from, link.to] : [link.to, link.from];
          if (here !== current || visited.has(there) || (allowed && !allowed.has(link.type))) continue;
          visited.add(there);
          next.push(there);
          result.push({ node: byUrn.get(there)!, distance, via: link, direction: dir });
        }
      }
      frontier = next;
    }
  }
  return result;
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const label = (n: TraceNode): string => `${n.module}:${n.id} (${n.name})`;
/** El tipo de un enlace en un informe: solo si no es el de por omisión, para que un informe sin `refType` quede igual que siempre. */
const typeSuffix = (type: string): string => (type === DEFAULT_LINK_TYPE ? '' : ` · ${type}`);

/** Enlaces por tipo, de más a menos y luego por nombre. */
export function countLinkTypes(links: readonly TraceLink[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const l of links) counts.set(l.type, (counts.get(l.type) ?? 0) + 1);
  return [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
}

/** Informe en Markdown: documentos, enlaces por par de módulos y referencias sin resolver. */
export function traceReport(graph: TraceGraph): string {
  const byUrn = new Map(graph.nodes.map((n) => [n.urn, n]));
  const out = [`Trazabilidad entre módulos: ${graph.documents.length} documentos, ${graph.nodes.length} elementos, ${graph.links.length} enlaces.`, ''];
  out.push('| Módulo | Archivo | Elementos | Enlaces salientes | Enlaces entrantes |', '|---|---|--:|--:|--:|');
  for (const d of graph.documents) {
    const outgoing = graph.links.filter((l) => byUrn.get(l.from)!.module === d.module).length;
    const incoming = graph.links.filter((l) => byUrn.get(l.to)!.module === d.module).length;
    out.push(`| ${d.module} | ${cell(d.source ?? '—')} | ${d.entities} | ${outgoing} | ${incoming} |`);
  }
  if (graph.links.length > 0) {
    out.push('', '### Enlaces', '');
    // Solo si algún enlace declara tipo: un informe de documentos sin `refType` queda igual que siempre.
    if (graph.links.some((l) => l.type !== DEFAULT_LINK_TYPE)) out.push(`Por tipo: ${countLinkTypes(graph.links).map(([type, n]) => `${type} ${n}`).join(', ')}.`, '');
    const pairs = new Map<string, TraceLink[]>();
    for (const link of graph.links) {
      const key = `${byUrn.get(link.from)!.module} → ${byUrn.get(link.to)!.module}`;
      pairs.set(key, [...(pairs.get(key) ?? []), link]);
    }
    for (const [pair, links] of [...pairs].sort(([a], [b]) => a.localeCompare(b))) {
      out.push(`**${pair}** (${links.length})`);
      for (const l of links) out.push(`- ${label(byUrn.get(l.from)!)} → ${label(byUrn.get(l.to)!)}${typeSuffix(l.type)}`);
      out.push('');
    }
  } else {
    out.push('', 'No hay enlaces entre los documentos aportados.');
  }
  if (graph.problems.length > 0) {
    out.push('', '### Referencias sin resolver', '');
    for (const p of graph.problems) out.push(`- ${label(byUrn.get(p.from)!)}: ${p.message}`);
  }
  if (graph.notices.length > 0) {
    out.push('', '### Avisos', '');
    for (const n of graph.notices) out.push(`- ${label(byUrn.get(n.from)!)}: ${n.message}`);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

/** Informe Markdown de lo que alcanza un elemento (su impacto y sus dependencias entre módulos). */
export function traceReachReport(reached: Reached[], direction: TraceDirection = 'both'): string {
  const out = [`Trazabilidad de ${label(reached[0].node)}`, ''];
  const sections: Array<['referrers' | 'refs', string]> = [
    ['referrers', 'Se apoyan en él (el impacto de tocarlo)'],
    ['refs', 'De lo que se apoya'],
  ];
  for (const [dir, title] of sections) {
    if (direction !== 'both' && direction !== dir) continue;
    const items = reached.filter((r) => r.direction === dir).sort((a, b) => a.distance - b.distance || a.node.urn.localeCompare(b.node.urn));
    out.push(`**${title}** (${items.length})`);
    if (items.length === 0) out.push('- ninguno');
    for (const r of items) out.push(`${'  '.repeat(r.distance - 1)}- ${label(r.node)} · ${r.node.kind}${r.via && r.via.type !== DEFAULT_LINK_TYPE ? ` · enlace ${r.via.type}` : ''}${r.distance > 1 ? ` · a ${r.distance} saltos` : ''}`);
    out.push('');
  }
  const modules = [...new Set(reached.slice(1).map((r) => r.node.module))];
  out.push(`Módulos alcanzados: ${modules.join(', ') || 'ninguno'}`);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

const mermaidText = (s: string): string => s.replace(/"/g, "'").replace(/[\r\n]+/g, ' ');

/** Mermaid `flowchart` con un `subgraph` por módulo; con `only`, solo esos elementos y los enlaces entre ellos. */
export function traceMermaid(graph: TraceGraph, only?: Set<string>): string {
  const linkFilter = (l: TraceLink): boolean => !only || (only.has(l.from) && only.has(l.to));
  const visible = new Set<string>(only ?? graph.links.flatMap((l) => [l.from, l.to]));
  if (only) for (const l of graph.links) if (linkFilter(l)) visible.add(l.from), visible.add(l.to);
  const nodes = graph.nodes.filter((n) => visible.has(n.urn));
  const ids = new Map(nodes.map((n, i) => [n.urn, `n${i}`]));
  const lines = ['flowchart LR'];
  for (const module of [...new Set(nodes.map((n) => n.module))]) {
    lines.push(`  subgraph ${module.replace(/[^a-z0-9]/g, '_')}["${mermaidText(module)}"]`);
    for (const n of nodes.filter((x) => x.module === module)) lines.push(`    ${ids.get(n.urn)}["${mermaidText(n.name)}<br/>${mermaidText(n.kind)}"]`);
    lines.push('  end');
  }
  // La etiqueta lleva el tipo del enlace; el de por omisión (`depends-on`) no se rotula, así un grafo sin `refType` queda como siempre.
  for (const l of graph.links.filter(linkFilter)) lines.push(`  ${ids.get(l.from)} -.->${l.type === DEFAULT_LINK_TYPE ? '' : `|${mermaidText(l.type)}|`} ${ids.get(l.to)}`);
  return lines.join('\n');
}
