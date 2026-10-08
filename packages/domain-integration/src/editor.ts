import {
  REF_TYPE_FIELD,
  uniqueId,
  type EdgeMark,
  type EdgeNotation,
  type EditorAction,
  type EditorEdge,
  type EditorNode,
  type EditorSpec,
  type FieldSpec,
  type NodeNotation,
} from '@iark/kernel';
import { contractAttachments } from './contract-editor';
import { KIND_COLORS, NODE_GLYPHS, NODE_SHAPES, NODE_SIZES, STYLE_LABELS } from './notation';
import { PATTERN_INFO } from './patterns';
import { connectionViolation } from './rules';
import { CRITICALITIES, INTERACTION_STYLES, KIND_LABELS, NODE_KINDS, PARENT_KINDS, PATTERNS, type IntegrationDocument, type IntegrationNode, type Interaction, type InteractionStyle, type NodeKind } from './types';
import { findView } from './views';
import { domainOf, isZoneId, zoneId, zonesOf } from './zones';

const node = (kind: NodeKind): NodeNotation => ({
  kind,
  label: KIND_LABELS[kind],
  glyph: NODE_GLYPHS[kind],
  shape: NODE_SHAPES[kind],
  fill: KIND_COLORS[kind],
  width: NODE_SIZES[kind].width,
  height: NODE_SIZES[kind].height,
});

/** Las zonas por dominio no se añaden desde la paleta: salen de agrupar nodos. */
const ZONE_NOTATION: NodeNotation = { kind: 'domain', label: 'Dominio', glyph: '▭', shape: 'rect', fill: '#64748b', width: 200, height: 100, addable: false };

const NODE_KIND_NOTATION: NodeNotation[] = [...NODE_KINDS.map(node), ZONE_NOTATION];

const EDGE_KIND_NOTATION: EdgeNotation[] = [
  { kind: 'request-response', label: STYLE_LABELS['request-response'], stroke: '#475569', line: 'solid', width: 1.5 },
  { kind: 'async-message', label: STYLE_LABELS['async-message'], stroke: '#475569', line: 'dashed', width: 1.5 },
  { kind: 'event', label: STYLE_LABELS.event, stroke: '#475569', line: 'dashed', width: 2.5 },
  { kind: 'batch', label: STYLE_LABELS.batch, stroke: '#475569', line: 'dashed', width: 1.5 },
  { kind: 'stream', label: STYLE_LABELS.stream, stroke: '#475569', line: 'dashed', width: 2.5 },
];

const options = (values: readonly string[], labels?: Record<string, string>): Array<{ value: string; label: string }> => values.map((value) => ({ value, label: labels?.[value] ?? value }));

const PATTERN_OPTIONS = PATTERNS.map((value) => ({ value, label: PATTERN_INFO[value].label }));

const contractOptions = (doc: IntegrationDocument): Array<{ value: string; label: string }> => doc.contracts.map((c) => ({ value: c.id, label: `${c.name} (${c.format}${c.version ? ` ${c.version}` : ''})` }));

const NODE_FIELDS = (kind: string, doc: IntegrationDocument): FieldSpec[] => {
  if (kind === 'domain') return [{ key: 'name', label: 'Nombre del dominio o equipo', type: 'text' }];
  return [
    { key: 'name', label: 'Nombre', type: 'text' },
    { key: 'description', label: 'Descripción', type: 'longtext' },
    { key: 'technology', label: 'Tecnología', type: 'text' },
    { key: 'owner', label: 'Responsable', type: 'text' },
    { key: 'external', label: 'Externo', type: 'boolean' },
    ...(kind === 'pattern' ? ([{ key: 'pattern', label: 'Patrón', type: 'select', options: PATTERN_OPTIONS }] as FieldSpec[]) : []),
    { key: 'domain', label: 'Dominio o equipo (zona)', type: 'text', hint: 'Los nodos con el mismo valor se dibujan en la misma zona' },
    { key: 'contractId', label: 'Contrato', type: 'select', options: contractOptions(doc), allowEmpty: true, opensAttachment: true },
    { key: 'ref', label: 'Referencia (URN)', type: 'text', hint: 'urn:iark:<módulo>:<id>' },
    REF_TYPE_FIELD,
    { key: 'tags', label: 'Etiquetas', type: 'list' },
  ];
};

const EDGE_FIELDS = (doc: IntegrationDocument): FieldSpec[] => [
  { key: 'style', label: 'Estilo', type: 'select', options: options(INTERACTION_STYLES, STYLE_LABELS) },
  { key: 'order', label: 'Orden en la secuencia', type: 'number', min: 1, step: 1, hint: 'Numera la línea en cada vista; deja huecos (10, 20, 30) para insertar después' },
  { key: 'description', label: 'Descripción', type: 'longtext' },
  { key: 'protocol', label: 'Protocolo', type: 'text' },
  { key: 'pattern', label: 'Patrón', type: 'select', options: PATTERN_OPTIONS, allowEmpty: true },
  { key: 'contractId', label: 'Contrato', type: 'select', options: contractOptions(doc), allowEmpty: true, opensAttachment: true },
  { key: 'criticality', label: 'Criticidad', type: 'select', options: options(CRITICALITIES), allowEmpty: true },
  { key: 'dataObjects', label: 'Datos que viajan', type: 'list' },
];

const NODE_PATCH_KEYS = ['name', 'description', 'technology', 'owner', 'external', 'ref', 'refType', 'tags', 'domain', 'contractId', 'pattern'];
const EDGE_PATCH_KEYS = ['style', 'order', 'description', 'protocol', 'pattern', 'contractId', 'criticality', 'dataObjects'];

const clean = (value: unknown): unknown => {
  if (value === '' || value === null || (Array.isArray(value) && value.length === 0)) return undefined;
  return value;
};

const patchObject = <T extends object>(target: T, patch: Record<string, unknown>, allowed: string[]): T => {
  const next: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const key of allowed) {
    if (!(key in patch)) continue;
    const value = clean(patch[key]);
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as T;
};

const trimmed = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** Raíz de la jerarquía de un nodo: un hijo (una API dentro de su sistema) se agrupa con su padre. */
function rootOf(doc: IntegrationDocument, id: string): IntegrationNode | undefined {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  let current = byId.get(id);
  for (let guard = 0; current?.parentId && byId.has(current.parentId) && guard < 20; guard++) current = byId.get(current.parentId);
  return current;
}

/** Nodos de primer nivel de la selección; una zona seleccionada aporta sus miembros. */
function selectedRoots(doc: IntegrationDocument, ids: string[]): IntegrationNode[] {
  const zones = zonesOf(doc.nodes);
  const roots = new Map<string, IntegrationNode>();
  for (const id of ids) {
    const members = isZoneId(id) ? (zones.find((z) => z.id === id)?.nodeIds ?? []) : [id];
    for (const member of members) {
      const root = rootOf(doc, member);
      if (root) roots.set(root.id, root);
    }
  }
  return [...roots.values()];
}

const withDomain = (doc: IntegrationDocument, ids: Set<string>, domain: string | undefined): IntegrationDocument => ({
  ...doc,
  nodes: doc.nodes.map((n) => {
    if (!ids.has(n.id)) return n;
    const { domain: _old, ...rest } = n;
    return domain ? { ...rest, domain } : rest;
  }),
});

const usedDomains = (doc: IntegrationDocument): string[] => [...new Set(doc.nodes.flatMap((n) => [n.domain?.trim(), n.owner?.trim()]).filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, 'es'));

const NOT_A_PATTERN_NODE = 'Selecciona un nodo de patrón.';

/** Por qué un nodo de patrón no se puede plegar en la insignia de una interacción, o `undefined` si se puede. */
function collapseBlocker(doc: IntegrationDocument, id: string | undefined): string | undefined {
  const target = doc.nodes.find((n) => n.id === id);
  if (target?.kind !== 'pattern') return NOT_A_PATTERN_NODE;
  const incoming = doc.interactions.filter((i) => i.targetId === target.id);
  const outgoing = doc.interactions.filter((i) => i.sourceId === target.id);
  if (incoming.length !== 1 || outgoing.length !== 1) return 'El nodo de patrón necesita exactamente una interacción de entrada y una de salida.';
  const source = doc.nodes.find((n) => n.id === incoming[0].sourceId);
  const destination = doc.nodes.find((n) => n.id === outgoing[0].targetId);
  const broken = source && destination ? connectionViolation(source, destination, incoming[0].style) : undefined;
  return broken ? `Unir directamente origen y destino incumpliría las reglas de conexión: ${broken.message}` : undefined;
}

const ACTIONS: Array<EditorAction<IntegrationDocument>> = [
  {
    id: 'group-domain',
    label: 'Agrupar en dominio…',
    hint: 'Dibuja los nodos seleccionados dentro de una zona de un equipo o dominio',
    needs: 'many',
    prompt: {
      label: 'Nombre del dominio o equipo',
      placeholder: 'Pedidos',
      initial: (doc, ids) => {
        const byId = new Map(doc.nodes.map((n) => [n.id, n]));
        const counts = new Map<string, number>();
        for (const root of selectedRoots(doc, ids)) {
          const name = domainOf(root, byId) ?? root.owner?.trim();
          if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
      },
      suggestions: usedDomains,
    },
    disabled: (doc, ids) => (selectedRoots(doc, ids).length === 0 ? 'Selecciona uno o varios nodos.' : undefined),
    run(doc, ids, input) {
      const name = trimmed(input);
      if (!name) return { ok: false, reason: 'Indica el nombre del dominio o del equipo.' };
      const roots = selectedRoots(doc, ids);
      if (roots.length === 0) return { ok: false, reason: 'Selecciona uno o varios nodos.' };
      return { ok: true, document: withDomain(doc, new Set(roots.map((n) => n.id)), name), id: zoneId(name) };
    },
  },
  {
    id: 'ungroup-domain',
    label: 'Sacar del dominio',
    hint: 'Quita los nodos seleccionados (o toda la zona seleccionada) de su dominio',
    needs: 'many',
    disabled: (doc, ids) => (selectedRoots(doc, ids).some((n) => n.domain) ? undefined : 'Ningún nodo seleccionado está en un dominio.'),
    run(doc, ids) {
      const roots = selectedRoots(doc, ids).filter((n) => n.domain);
      if (roots.length === 0) return { ok: false, reason: 'Ningún nodo seleccionado está en un dominio.' };
      return { ok: true, document: withDomain(doc, new Set(roots.map((n) => n.id)), undefined) };
    },
  },
  {
    id: 'group-by-owner',
    label: 'Agrupar por responsable',
    hint: 'Crea una zona por equipo con los nodos que tienen responsable y aún no están en ningún dominio',
    needs: 'none',
    disabled: (doc) => (doc.nodes.some((n) => !n.parentId && !n.domain && n.owner?.trim()) ? undefined : 'Ningún nodo tiene responsable y está sin dominio.'),
    run(doc) {
      const candidates = doc.nodes.filter((n) => !n.parentId && !n.domain && n.owner?.trim());
      if (candidates.length === 0) return { ok: false, reason: 'Ningún nodo tiene responsable y está sin dominio.' };
      return { ok: true, document: { ...doc, nodes: doc.nodes.map((n) => (candidates.includes(n) ? { ...n, domain: n.owner!.trim() } : n)) } };
    },
  },
  {
    id: 'expand-pattern',
    label: 'Patrón → nodo',
    hint: 'Sustituye la insignia del patrón de una interacción por un nodo de patrón intermedio, al estilo de los libros de EIP',
    needs: 'one',
    disabled: (doc, ids) => (doc.interactions.some((i) => i.id === ids[0] && i.pattern) ? undefined : 'Selecciona una interacción que tenga patrón.'),
    run(doc, ids) {
      const it = doc.interactions.find((i) => i.id === ids[0]);
      if (!it?.pattern) return { ok: false, reason: 'Selecciona una interacción que tenga patrón.' };
      const info = PATTERN_INFO[it.pattern];
      const nodeId = uniqueId(info.label, doc.nodes.map((n) => n.id));
      const secondId = uniqueId(`${nodeId}-${it.targetId}`, doc.interactions.map((i) => i.id));
      const { pattern: _pattern, ...base } = it;
      const first: Interaction = { ...base, targetId: nodeId };
      const second: Interaction = {
        id: secondId,
        sourceId: nodeId,
        targetId: it.targetId,
        style: it.style,
        ...(it.protocol ? { protocol: it.protocol } : {}),
        ...(it.contractId ? { contractId: it.contractId } : {}),
        ...(it.criticality ? { criticality: it.criticality } : {}),
        ...(it.order !== undefined ? { order: it.order + 0.5 } : {}),
      };
      return {
        ok: true,
        id: nodeId,
        document: {
          ...doc,
          nodes: [...doc.nodes, { id: nodeId, kind: 'pattern', name: info.label, pattern: it.pattern }],
          interactions: doc.interactions.flatMap((i) => (i.id === it.id ? [first, second] : [i])),
          flows: doc.flows.map((f) => ({ ...f, steps: f.steps.flatMap((s) => (s.interactionId === it.id ? [s, { interactionId: secondId }] : [s])) })),
        },
      };
    },
  },
  {
    id: 'collapse-pattern',
    label: 'Nodo → insignia de patrón',
    hint: 'Convierte un nodo de patrón con una entrada y una salida en la insignia del patrón sobre una sola interacción',
    needs: 'one',
    disabled: (doc, ids) => collapseBlocker(doc, ids[0]),
    run(doc, ids) {
      const why = collapseBlocker(doc, ids[0]);
      const target = doc.nodes.find((n) => n.id === ids[0]);
      if (why || !target) return { ok: false, reason: why ?? NOT_A_PATTERN_NODE };
      const incoming = doc.interactions.find((i) => i.targetId === target.id)!;
      const outgoing = doc.interactions.find((i) => i.sourceId === target.id)!;
      const protocol = incoming.protocol ?? outgoing.protocol;
      const contractId = incoming.contractId ?? outgoing.contractId;
      const description = incoming.description ?? outgoing.description;
      const merged: Interaction = {
        ...incoming,
        targetId: outgoing.targetId,
        ...(target.pattern ? { pattern: target.pattern } : {}),
        ...(protocol ? { protocol } : {}),
        ...(contractId ? { contractId } : {}),
        ...(description ? { description } : {}),
      };
      return {
        ok: true,
        id: merged.id,
        document: {
          ...doc,
          nodes: doc.nodes.filter((n) => n.id !== target.id),
          interactions: doc.interactions.filter((i) => i.id !== outgoing.id).map((i) => (i.id === incoming.id ? merged : i)),
          flows: doc.flows.map((f) => ({ ...f, steps: f.steps.filter((s) => s.interactionId !== outgoing.id) })),
        },
      };
    },
  },
];

const contractBadge = (doc: IntegrationDocument, id: string | undefined): string[] | undefined => {
  const contract = id ? doc.contracts.find((c) => c.id === id) : undefined;
  return contract ? [`${contract.format}${contract.version ? ` ${contract.version}` : ''}`] : undefined;
};

export const integrationEditor: EditorSpec<IntegrationDocument> = {
  nodeKinds: NODE_KIND_NOTATION,
  edgeKinds: EDGE_KIND_NOTATION,
  defaultEdgeKind: 'request-response',

  project(doc, viewId) {
    const view = findView(doc, viewId);
    const shown = new Set(view.nodeIds);
    const zones = zonesOf(doc.nodes, shown);
    const zoneOf = new Map(zones.flatMap((z) => z.nodeIds.map((id) => [id, z.id] as const)));
    const nodes: EditorNode[] = [
      ...zones.map((z) => ({ id: z.id, kind: 'domain', label: z.name, fill: z.stroke, stroke: z.stroke })),
      ...doc.nodes
        .filter((n) => shown.has(n.id))
        .map((n) => ({
          id: n.id,
          kind: n.kind,
          label: n.name,
          sublabel: n.kind === 'pattern' && n.pattern ? PATTERN_INFO[n.pattern].label : n.technology,
          parentId: n.parentId && shown.has(n.parentId) ? n.parentId : zoneOf.get(n.id),
          ref: n.ref,
          badges: contractBadge(doc, n.contractId),
          dashed: n.external,
          fill: n.external ? '#6b6b6b' : undefined,
        })),
    ];
    const edges: EditorEdge[] = view.interactions.map(({ interaction: it, step }) => {
      const marks: EdgeMark[] = [];
      if (step !== undefined) marks.push({ text: String(step), title: `Paso ${step}` });
      if (it.pattern) marks.push({ icon: PATTERN_INFO[it.pattern].icon, title: PATTERN_INFO[it.pattern].label });
      return {
        id: it.id,
        kind: it.style,
        source: it.sourceId,
        target: it.targetId,
        label: [it.description, it.protocol ? `[${it.protocol}]` : undefined].filter(Boolean).join(' ') || undefined,
        marks: marks.length > 0 ? marks : undefined,
        width: it.criticality === 'high' ? 2.25 : undefined,
      };
    });
    return { nodes, edges };
  },

  fields: (target, doc) => (target.type === 'node' ? NODE_FIELDS(target.kind, doc) : EDGE_FIELDS(doc)),

  read(doc, id) {
    const n = doc.nodes.find((x) => x.id === id);
    if (n) return { type: 'node', kind: n.kind, values: { ...n } };
    const it = doc.interactions.find((x) => x.id === id);
    if (it) return { type: 'edge', kind: it.style, values: { ...it } };
    const zone = isZoneId(id) ? zonesOf(doc.nodes).find((z) => z.id === id) : undefined;
    if (zone) return { type: 'node', kind: 'domain', values: { name: zone.name } };
    return undefined;
  },

  addNode(doc, kind, name, parentId) {
    if (!(NODE_KINDS as readonly string[]).includes(kind)) return { ok: false, reason: `Tipo de nodo desconocido: ${kind}` };
    const k = kind as NodeKind;
    const zone = parentId && isZoneId(parentId) ? zonesOf(doc.nodes).find((z) => z.id === parentId) : undefined;
    const parent = parentId && !zone ? doc.nodes.find((n) => n.id === parentId) : undefined;
    const id = uniqueId(name, doc.nodes.map((n) => n.id));
    const created: IntegrationNode = {
      id,
      kind: k,
      name,
      ...(k === 'pattern' ? { pattern: PATTERNS[0] } : {}),
      ...(parent && PARENT_KINDS[k]?.includes(parent.kind) ? { parentId: parent.id } : {}),
      ...(zone ? { domain: zone.name } : {}),
    };
    return { ok: true, id, document: { ...doc, nodes: [...doc.nodes, created] } };
  },

  addEdge(doc, kind, sourceId, targetId) {
    const reason = integrationEditor.canConnect?.(doc, kind, sourceId, targetId);
    if (reason) return { ok: false, reason };
    const id = uniqueId(`${sourceId}-${targetId}`, doc.interactions.map((i) => i.id));
    return { ok: true, id, document: { ...doc, interactions: [...doc.interactions, { id, sourceId, targetId, style: kind as InteractionStyle }] } };
  },

  update(doc, id, patch) {
    const n = doc.nodes.find((x) => x.id === id);
    if (n) {
      if (typeof patch.name === 'string' && patch.name.trim() === '') return { ok: false, reason: 'El nombre no puede estar vacío.' };
      if (n.kind === 'pattern' && 'pattern' in patch && !clean(patch.pattern)) return { ok: false, reason: 'Un nodo de patrón necesita indicar qué patrón aplica.' };
      const allowed = n.kind === 'pattern' ? NODE_PATCH_KEYS : NODE_PATCH_KEYS.filter((k) => k !== 'pattern');
      return { ok: true, id, document: { ...doc, nodes: doc.nodes.map((x) => (x.id === id ? patchObject(x, patch, allowed) : x)) } };
    }
    const it = doc.interactions.find((x) => x.id === id);
    if (it) {
      let values = patch;
      if ('order' in patch) {
        const raw = clean(patch.order);
        const order = raw === undefined ? undefined : Number(raw);
        if (order !== undefined && !Number.isFinite(order)) return { ok: false, reason: 'El orden tiene que ser un número.' };
        values = { ...patch, order };
      }
      if (typeof values.style === 'string' && values.style !== it.style) {
        const reason = integrationEditor.canConnect?.(doc, values.style, it.sourceId, it.targetId);
        if (reason) return { ok: false, reason };
      }
      return { ok: true, id, document: { ...doc, interactions: doc.interactions.map((x) => (x.id === id ? patchObject(x, values, EDGE_PATCH_KEYS) : x)) } };
    }
    const zone = isZoneId(id) ? zonesOf(doc.nodes).find((z) => z.id === id) : undefined;
    if (zone) {
      const name = trimmed(patch.name);
      if (!name) return { ok: false, reason: 'El nombre no puede estar vacío.' };
      const members = new Set(doc.nodes.filter((x) => x.domain && zoneId(x.domain.trim()) === id).map((x) => x.id));
      return { ok: true, id: zoneId(name), document: withDomain(doc, members, name) };
    }
    return { ok: false, reason: `No existe «${id}».` };
  },

  remove(doc, id) {
    if (doc.nodes.some((n) => n.id === id)) {
      const gone = new Set([id, ...doc.nodes.filter((n) => n.parentId === id).map((n) => n.id)]);
      const interactions = doc.interactions.filter((i) => !gone.has(i.sourceId) && !gone.has(i.targetId));
      const kept = new Set(interactions.map((i) => i.id));
      return {
        ok: true,
        document: {
          ...doc,
          nodes: doc.nodes.filter((n) => !gone.has(n.id)),
          interactions,
          flows: doc.flows.map((f) => ({ ...f, steps: f.steps.filter((s) => kept.has(s.interactionId)) })),
        },
      };
    }
    if (doc.interactions.some((i) => i.id === id)) {
      return { ok: true, document: { ...doc, interactions: doc.interactions.filter((i) => i.id !== id), flows: doc.flows.map((f) => ({ ...f, steps: f.steps.filter((s) => s.interactionId !== id) })) } };
    }
    if (isZoneId(id) && zonesOf(doc.nodes).some((z) => z.id === id)) {
      const members = new Set(doc.nodes.filter((n) => n.domain && zoneId(n.domain.trim()) === id).map((n) => n.id));
      return { ok: true, document: withDomain(doc, members, undefined) };
    }
    return { ok: false, reason: `No existe «${id}».` };
  },

  canConnect(doc, kind, sourceId, targetId) {
    if (isZoneId(sourceId) || isZoneId(targetId)) return 'Una zona agrupa nodos: no se une con interacciones.';
    if (sourceId === targetId) return 'Una interacción no puede unir un nodo consigo mismo.';
    const source = doc.nodes.find((n) => n.id === sourceId);
    const target = doc.nodes.find((n) => n.id === targetId);
    if (!source || !target) return 'El origen o el destino no existe.';
    if (!(INTERACTION_STYLES as readonly string[]).includes(kind)) return `Estilo desconocido: ${kind}`;
    return connectionViolation(source, target, kind as InteractionStyle)?.message;
  },

  actions: ACTIONS,
  attachments: contractAttachments,
};
