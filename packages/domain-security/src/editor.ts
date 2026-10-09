import { REF_TYPE_FIELD, uniqueId, type EdgeNotation, type EditResult, type EditorGraph, type EditorNode, type EditorSpec, type FieldSpec, type NodeNotation } from '@iark/kernel';
import { ASSET_COLORS, assetFacts, ASSET_SHAPES, CONTROL_COLOR, CONTROL_SHAPE, FLOW_NODE_COLOR, FLOW_SHAPE, RISK_COLORS, STANDARD_STYLE, THREAT_SHAPE, ZONE_STYLES, buildScene, heatLayout, heatPlacement } from './export/render';
import {
  ASSET_KINDS,
  ASSET_LABELS,
  AUTHENTICATIONS,
  AUTHENTICATION_LABELS,
  CLASSIFICATIONS,
  CLASSIFICATION_LABELS,
  CONTROL_KINDS,
  CONTROL_LABELS,
  CONTROL_STANDARDS,
  CONTROL_STATUSES,
  CONTROL_STATUS_LABELS,
  IMPACTS,
  LIKELIHOODS,
  RATING_LABELS,
  STANDARD_LABELS,
  STATUS_LABELS,
  STRIDE,
  STRIDE_BY_ELEMENT,
  STRIDE_LABELS,
  THREAT_STATUSES,
  TRUST_LABELS,
  TRUST_LEVELS,
  flowName,
  indexElements,
  parseHeatCell,
  trustOf,
  type Asset,
  type AssetKind,
  type Control,
  type Flow,
  type SecurityDocument,

  type Threat,
  type Zone,
} from './types';
import { crossingsById, needsAuthentication, securityActions } from './modeling';
import { findView } from './views';

/**
 * Editor interactivo de seguridad. Su identidad es la del diagrama de flujo de datos clásico del modelado de amenazas:
 * procesos como círculos, almacenes como tubos abiertos, actores como figuras humanas y sistemas externos como cajas
 * discontinuas, dentro de zonas de confianza coloreadas del rojo (no confiable) al verde (restringida). Los flujos
 * distinguen por color si van cifrados. En el modelo de amenazas, cada amenaza es un hexágono coloreado por su riesgo
 * (STRIDE en la insignia) unido a lo que amenaza, y los controles la mitigan en verde.
 */
const asset = (kind: AssetKind, glyph: string, width: number, height: number): NodeNotation => ({ kind, label: ASSET_LABELS[kind], glyph, shape: ASSET_SHAPES[kind], fill: ASSET_COLORS[kind], width, height });

const CELL_SIZE = { width: 280, height: 96 };

const NODE_KIND_NOTATION: NodeNotation[] = [
  asset('actor', '☺', 150, 96),
  asset('external', '▭', 200, 78),
  asset('process', '◯', 170, 96),
  asset('datastore', '⊐', 200, 78),
  asset('identity', 'ID', 190, 84),
  asset('secret', '⚿', 170, 84),
  asset('channel', '⇄', 170, 64),
  { kind: 'zone', label: 'Zona de confianza', glyph: '▦', shape: 'rect', fill: ZONE_STYLES.internal.stroke, width: 260, height: 140 },
  { kind: 'threat', label: 'Amenaza', glyph: '⚠', shape: THREAT_SHAPE, fill: RISK_COLORS.medium, width: 260, height: 84 },
  { kind: 'control', label: 'Control', glyph: '🛡', shape: CONTROL_SHAPE, fill: CONTROL_COLOR, width: 220, height: 78 },
  { kind: 'flow', label: 'Flujo de datos', glyph: '→', shape: FLOW_SHAPE, fill: FLOW_NODE_COLOR, width: 220, height: 70, addable: false },
  // Contenedores de las vistas derivadas: las celdas de la matriz de calor (se les suelta una amenaza) y los catálogos de estándares.
  { kind: 'cell', label: 'Celda de riesgo', glyph: '▦', shape: 'rect', fill: RISK_COLORS.medium, width: CELL_SIZE.width, height: CELL_SIZE.height, addable: false, container: true },
  { kind: 'catalog', label: 'Estándar', glyph: '☰', shape: 'rect', fill: STANDARD_STYLE.stroke, width: 260, height: 140, addable: false, container: true },
];

const EDGE_KIND_NOTATION: EdgeNotation[] = [
  { kind: 'flow', label: 'flujo de datos', stroke: '#64748b', line: 'solid', width: 1.5 },
  { kind: 'flow-encrypted', label: 'flujo cifrado', stroke: '#2b8a3e', line: 'solid', width: 2 },
  { kind: 'flow-plain', label: 'flujo sin cifrar', stroke: '#c92a2a', line: 'dashed', width: 1.5 },
  { kind: 'threat', label: 'amenaza a', stroke: '#c92a2a', line: 'dashed', width: 1.5 },
  { kind: 'mitigates', label: 'mitiga', stroke: CONTROL_COLOR, line: 'solid', width: 1.5 },
];

const flowKindOf = (f: Flow): string => (f.encrypted === true ? 'flow-encrypted' : f.encrypted === false ? 'flow-plain' : 'flow');
const ASSET_KIND_SET = new Set<string>(ASSET_KINDS);
const isFlowKind = (kind: string): boolean => kind === 'flow' || kind === 'flow-encrypted' || kind === 'flow-plain';

const options = <T extends string>(values: readonly T[], labels: Record<T, string>): Array<{ value: string; label: string }> => values.map((value) => ({ value, label: labels[value] }));
const NAME: FieldSpec = { key: 'name', label: 'Nombre', type: 'text' };
const DESCRIPTION: FieldSpec = { key: 'description', label: 'Descripción', type: 'longtext' };
const CLASSIFICATION: FieldSpec = { key: 'classification', label: 'Clasificación de los datos', type: 'select', options: options(CLASSIFICATIONS, CLASSIFICATION_LABELS), allowEmpty: true };
const YES_NO = [
  { value: 'yes', label: 'sí' },
  { value: 'no', label: 'no' },
];

const FLOW_FIELDS: FieldSpec[] = [
  DESCRIPTION,
  { key: 'protocol', label: 'Protocolo', type: 'text' },
  CLASSIFICATION,
  { key: 'encrypted', label: 'Cifrado en tránsito', type: 'select', options: YES_NO, allowEmpty: true, hint: 'vacío = no se sabe' },
  { key: 'authentication', label: 'Autenticación', type: 'select', options: options(AUTHENTICATIONS, AUTHENTICATION_LABELS), allowEmpty: true },
];

function nodeFields(kind: string, doc: SecurityDocument): FieldSpec[] {
  const zones: FieldSpec = { key: 'zoneId', label: 'Zona de confianza', type: 'select', options: doc.zones.map((z) => ({ value: z.id, label: `${z.name} (${TRUST_LABELS[trustOf(z)]})` })) };
  if ((ASSET_KINDS as readonly string[]).includes(kind)) {
    return [
      NAME,
      DESCRIPTION,
      { key: 'kind', label: 'Clase', type: 'select', options: options(ASSET_KINDS, ASSET_LABELS) },
      zones,
      { key: 'technology', label: 'Tecnología', type: 'text' },
      { key: 'owner', label: 'Responsable', type: 'text' },
      CLASSIFICATION,
      ...(kind === 'datastore' || kind === 'secret' ? [{ key: 'encryptedAtRest', label: 'Cifrado en reposo', type: 'select', options: YES_NO, allowEmpty: true, hint: 'vacío = no se sabe' } as FieldSpec] : []),
      ...(kind === 'identity' || kind === 'channel' ? [{ key: 'authentication', label: 'Autenticación', type: 'select', options: options(AUTHENTICATIONS, AUTHENTICATION_LABELS), allowEmpty: true, hint: 'vacío = no se sabe' } as FieldSpec] : []),
      ...(kind === 'secret' ? [{ key: 'rotation', label: 'Rotación periódica', type: 'select', options: YES_NO, allowEmpty: true, hint: 'vacío = no se sabe' } as FieldSpec] : []),
      ...(kind === 'channel' ? [{ key: 'encrypted', label: 'Cifra el tráfico', type: 'select', options: YES_NO, allowEmpty: true, hint: 'vacío = no se sabe' } as FieldSpec] : []),
      { key: 'ref', label: 'Referencia (URN)', type: 'text', hint: 'urn:iark:<módulo>:<id>' },
      REF_TYPE_FIELD,
      { key: 'tags', label: 'Etiquetas', type: 'list' },
    ];
  }
  switch (kind) {
    case 'zone':
      return [
        NAME,
        DESCRIPTION,
        { key: 'trust', label: 'Nivel de confianza', type: 'select', options: options(TRUST_LEVELS, TRUST_LABELS), allowEmpty: true, hint: 'si no se indica, interna' },
        { key: 'parentId', label: 'Zona que la contiene', type: 'select', options: doc.zones.map((z) => ({ value: z.id, label: z.name })), allowEmpty: true },
      ];
    case 'threat':
      return [
        { key: 'title', label: 'Título', type: 'text' },
        DESCRIPTION,
        { key: 'category', label: 'Categoría STRIDE', type: 'select', options: options(STRIDE, STRIDE_LABELS) },
        {
          key: 'targetId',
          label: 'Recae sobre',
          type: 'select',
          options: [...doc.assets.map((a) => ({ value: a.id, label: `${a.name} (${ASSET_LABELS[a.kind].toLowerCase()})` })), ...doc.flows.map((f) => ({ value: f.id, label: `${flowName(doc, f)} (flujo)` }))],
        },
        { key: 'likelihood', label: 'Probabilidad', type: 'select', options: LIKELIHOODS.map((v) => ({ value: v, label: RATING_LABELS[v] })), allowEmpty: true, hint: 'si no se indica, media' },
        { key: 'impact', label: 'Impacto', type: 'select', options: options(IMPACTS, RATING_LABELS), allowEmpty: true, hint: 'si no se indica, medio' },
        { key: 'status', label: 'Estado', type: 'select', options: options(THREAT_STATUSES, STATUS_LABELS), allowEmpty: true, hint: 'si no se indica, abierta' },
        { key: 'controlIds', label: 'Controles que la mitigan', type: 'list', hint: 'ids de control; también arrastrando un control hasta la amenaza' },
      ];
    case 'control':
      return [
        NAME,
        DESCRIPTION,
        { key: 'kind', label: 'Clase', type: 'select', options: options(CONTROL_KINDS, CONTROL_LABELS) },
        { key: 'status', label: 'Estado', type: 'select', options: options(CONTROL_STATUSES, CONTROL_STATUS_LABELS), allowEmpty: true, hint: 'si no se indica, implementada' },
        { key: 'owner', label: 'Responsable', type: 'text' },
        { key: 'standard', label: 'Estándar', type: 'select', options: options(CONTROL_STANDARDS, STANDARD_LABELS), allowEmpty: true, hint: 'opcional: para la cobertura por estándar' },
      ];
    default:
      return isFlowKind(kind) ? FLOW_FIELDS : [NAME, DESCRIPTION];
  }
}

const clean = (value: unknown): unknown => (value === '' || value === null || (Array.isArray(value) && value.length === 0) ? undefined : value);
const YES_NO_KEYS = new Set(['encrypted', 'encryptedAtRest', 'rotation']);

function patchObject<T extends object>(target: T, patch: Record<string, unknown>, allowed: string[]): T {
  const next: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const key of allowed) {
    if (!(key in patch)) continue;
    let value = clean(patch[key]);
    if (YES_NO_KEYS.has(key) && value !== undefined) value = value === 'yes' || value === true;
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as T;
}

const yesNo = (value: boolean | undefined): string => (value === undefined ? '' : value ? 'yes' : 'no');

const widthFor = (lines: string[], min: number, max = 300): number => Math.min(max, Math.max(min, Math.ceil(Math.max(...lines.map((l, i) => l.length * (i === 0 ? 7.2 : 6.2))) + 32)));

/** Ids de una zona y de todas las que cuelgan de ella. */
function zoneSubtree(doc: SecurityDocument, id: string): Set<string> {
  const ids = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const z of doc.zones) {
      if (z.parentId && ids.has(z.parentId) && !ids.has(z.id)) {
        ids.add(z.id);
        grew = true;
      }
    }
  }
  return ids;
}

const ok = (document: SecurityDocument, id?: string): EditResult<SecurityDocument> => ({ ok: true, document, id });
const fail = (reason: string): EditResult<SecurityDocument> => ({ ok: false, reason });

/** Quita activos (y con ellos sus flujos y las amenazas que recaen sobre ellos o sobre esos flujos). */
function withoutAssets(doc: SecurityDocument, gone: Set<string>): SecurityDocument {
  const flows = doc.flows.filter((f) => !gone.has(f.sourceId) && !gone.has(f.targetId));
  const goneFlows = new Set(doc.flows.filter((f) => !flows.includes(f)).map((f) => f.id));
  return {
    ...doc,
    assets: doc.assets.filter((a) => !gone.has(a.id)),
    flows,
    threats: doc.threats.filter((t) => !gone.has(t.targetId) && !goneFlows.has(t.targetId)),
  };
}

export const securityEditor: EditorSpec<SecurityDocument> = {
  nodeKinds: NODE_KIND_NOTATION,
  edgeKinds: EDGE_KIND_NOTATION,
  defaultEdgeKind: 'flow',
  actions: securityActions,

  project(doc, viewId): EditorGraph {
    const view = findView(doc, viewId);
    const scene = buildScene(doc, view);
    const all = indexElements(doc);
    const flows = new Map(doc.flows.map((f) => [f.id, f]));
    const kinds = new Map(NODE_KIND_NOTATION.map((k) => [k.kind, k]));
    const nodes: EditorNode[] = [];
    for (const [id, g] of scene.groups) {
      if (g.kind === 'cell' || g.kind === 'catalog') {
        nodes.push({ id, kind: g.kind, label: g.label, parentId: g.groupId, fill: g.style?.stroke, border: 'solid' });
        continue;
      }
      // El lienzo antepone la clase («Zona de confianza: …»), así que el título lleva el nombre y el nivel.
      const label = `${all.get(g.elementId)?.name ?? g.short} · ${TRUST_LABELS[g.trust]}`;
      nodes.push({ id, kind: 'zone', label, parentId: g.groupId, fill: ZONE_STYLES[g.trust].stroke });
    }
    for (const [id, n] of scene.nodes) {
      const [label = id, ...rest] = n.lines;
      const notation = kinds.get(n.cls) ?? kinds.get('process')!;
      const item = all.get(n.elementId)?.item;
      const facts = ASSET_KIND_SET.has(n.cls) && item ? assetFacts(item as Asset) : [];
      const extra = facts.length > 0 ? facts : n.cls === 'threat' && (item as Threat).suggested ? ['sugerida'] : n.cls === 'control' && (item as Control).standard ? [STANDARD_LABELS[(item as Control).standard!]] : [];
      const badges = [...rest.slice(1), ...(n.note ? [n.note] : []), ...extra].filter(Boolean);
      nodes.push({
        id,
        kind: n.cls,
        label,
        sublabel: n.cls === 'threat' ? `${STRIDE_LABELS[(all.get(n.elementId)?.item as Threat).category]} · ${rest[0] ?? ''}` : rest[0],
        badges: badges.length > 0 ? badges : undefined,
        parentId: n.groupId,
        ref: (all.get(n.elementId)?.item as { ref?: string } | undefined)?.ref,
        fill: n.fill,
        stroke: n.stroke === '#0f172a55' ? undefined : n.stroke,
        dashed: n.dashed || (n.cls === 'threat' && (item as Threat).suggested === true) || undefined,
        width: widthFor(n.lines, notation.width, n.cls === 'threat' || n.cls === 'control' ? 400 : 300),
      });
    }
    return {
      nodes,
      edges: [...scene.edges].map(([id, e]) => ({
        id,
        kind: e.kind === 'flow' ? flowKindOf(flows.get(id)!) : e.kind,
        source: e.source,
        target: e.target,
        label: e.label,
        width: e.kind === 'flow' ? e.width : undefined,
      })),
    };
  },

  layout(doc, viewId) {
    const view = findView(doc, viewId);
    return view.type === 'heatmap' ? heatLayout(doc, view) : undefined;
  },

  drop(doc, id, targetId, viewId) {
    const view = findView(doc, viewId);
    const threat = doc.threats.find((t) => t.id === id);
    if (view.type !== 'heatmap' || !threat) return undefined;
    // Se suelta sobre una celda o sobre otra amenaza (la de su celda).
    const other = doc.threats.find((t) => t.id === targetId);
    const cell = parseHeatCell(targetId) ?? (other ? heatPlacement(doc, other, view.mode ?? 'inherent') : undefined);
    if (!cell) return undefined;
    const from = heatPlacement(doc, threat, view.mode ?? 'inherent');
    if (from.likelihood === cell.likelihood && from.impact === cell.impact) return undefined;
    if (view.mode === 'residual') return fail('El riesgo residual se calcula con los controles implementados y no se arrastra: cambia la probabilidad y el impacto en la matriz inherente (o añade controles).');
    return ok({ ...doc, threats: doc.threats.map((t) => (t.id === id ? { ...t, likelihood: cell.likelihood, impact: cell.impact } : t)) }, id);
  },

  fields(target, doc) {
    if (target.kind === 'cell' || target.kind === 'catalog') return [];
    if (isFlowKind(target.kind)) return FLOW_FIELDS;
    if (target.type === 'edge') return [];
    return nodeFields(target.kind, doc);
  },

  read(doc, id) {
    const e = indexElements(doc).get(id);
    if (e) {
      switch (e.kind) {
        case 'asset':
          return { type: 'node', kind: (e.item as Asset).kind, values: { ...e.item, encryptedAtRest: yesNo((e.item as Asset).encryptedAtRest), rotation: yesNo((e.item as Asset).rotation), encrypted: yesNo((e.item as Asset).encrypted) } };
        case 'flow':
          return { type: 'edge', kind: flowKindOf(e.item as Flow), values: { ...e.item, encrypted: yesNo((e.item as Flow).encrypted) } };
        default:
          return { type: 'node', kind: e.kind, values: { ...e.item } };
      }
    }
    if (parseHeatCell(id) || id.startsWith('std:')) return { type: 'node', kind: id.startsWith('std:') ? 'catalog' : 'cell', values: {} };
    if (id.startsWith('t:')) return doc.threats.some((t) => t.id === id.slice(2)) ? { type: 'edge', kind: 'threat', values: {} } : undefined;
    if (id.startsWith('m:')) return { type: 'edge', kind: 'mitigates', values: {} };
    return undefined;
  },

  addNode(doc, kind, name, parentId) {
    const all = indexElements(doc);
    const taken = [...all.keys()];
    const parent = parentId ? all.get(parentId) : undefined;
    if ((ASSET_KINDS as readonly string[]).includes(kind)) {
      const zoneId = parent?.kind === 'zone' ? parent.id : parent?.kind === 'asset' ? (parent.item as Asset).zoneId : doc.zones[0]?.id;
      if (!zoneId) return fail('Añade primero una zona de confianza: todo activo está dentro de una.');
      const id = uniqueId(name, taken);
      const created: Asset = { id, name, kind: kind as AssetKind, zoneId };
      return ok({ ...doc, assets: [...doc.assets, created] }, id);
    }
    switch (kind) {
      case 'zone': {
        const id = uniqueId(name, taken);
        const created: Zone = { id, name, ...(parent?.kind === 'zone' ? { parentId: parent.id } : {}) };
        return ok({ ...doc, zones: [...doc.zones, created] }, id);
      }
      case 'threat': {
        const target = parent && (parent.kind === 'asset' || parent.kind === 'flow') ? parent : doc.assets[0] ? all.get(doc.assets[0].id) : undefined;
        if (!target) return fail('Una amenaza recae sobre un activo o un flujo: añade uno primero (o selecciónalo antes de añadir la amenaza).');
        const applicable = STRIDE_BY_ELEMENT[target.kind === 'flow' ? 'flow' : (target.item as Asset).kind];
        const id = uniqueId(name, taken);
        const created: Threat = { id, title: name, category: applicable[0], targetId: target.id };
        return ok({ ...doc, threats: [...doc.threats, created] }, id);
      }
      case 'control': {
        const id = uniqueId(name, taken);
        const created: Control = { id, name, kind: 'other' };
        return ok({ ...doc, controls: [...doc.controls, created] }, id);
      }
      default:
        return fail(`Tipo de elemento desconocido: ${kind}`);
    }
  },

  addEdge(doc, kind, sourceId, targetId) {
    const reason = securityEditor.canConnect?.(doc, kind, sourceId, targetId);
    if (reason) return fail(reason);
    const all = indexElements(doc);
    if (isFlowKind(kind)) {
      const id = uniqueId(`${sourceId}-a-${targetId}`, all.keys());
      const created: Flow = { id, sourceId, targetId, ...(kind === 'flow-encrypted' ? { encrypted: true } : kind === 'flow-plain' ? { encrypted: false } : {}) };
      const next = { ...doc, flows: [...doc.flows, created] };
      // Un flujo hacia una zona más confiable nace autenticado (token); se puede cambiar, pero no dejar sin autenticación.
      if (needsAuthentication(crossingsById(next).get(id))) created.authentication = 'token';
      return ok(next, id);
    }
    if (kind === 'threat') {
      const [threatId, target] = all.get(sourceId)?.kind === 'threat' ? [sourceId, targetId] : [targetId, sourceId];
      return ok({ ...doc, threats: doc.threats.map((t) => (t.id === threatId ? { ...t, targetId: target } : t)) }, `t:${threatId}`);
    }
    const [controlId, threatId] = all.get(sourceId)?.kind === 'control' ? [sourceId, targetId] : [targetId, sourceId];
    return ok({ ...doc, threats: doc.threats.map((t) => (t.id === threatId ? { ...t, controlIds: [...(t.controlIds ?? []), controlId] } : t)) }, `m:${controlId}:${threatId}`);
  },

  update(doc, id, patch) {
    const all = indexElements(doc);
    const e = all.get(id);
    if (!e) return fail(`No existe «${id}».`);
    if ((typeof patch.name === 'string' && patch.name.trim() === '') || (typeof patch.title === 'string' && patch.title.trim() === '')) return fail('El nombre no puede estar vacío.');
    switch (e.kind) {
      case 'asset': {
        const next = patchObject(e.item as Asset, patch, ['name', 'description', 'kind', 'zoneId', 'technology', 'owner', 'classification', 'encryptedAtRest', 'authentication', 'rotation', 'encrypted', 'ref', 'refType', 'tags']);
        if (all.get(next.zoneId)?.kind !== 'zone') return fail(`No existe la zona «${next.zoneId}».`);
        if (next.kind !== 'datastore' && next.kind !== 'secret') delete next.encryptedAtRest;
        if (next.kind !== 'identity' && next.kind !== 'channel') delete next.authentication;
        if (next.kind !== 'secret') delete next.rotation;
        if (next.kind !== 'channel') delete next.encrypted;
        return ok({ ...doc, assets: doc.assets.map((a) => (a.id === id ? next : a)) }, id);
      }
      case 'zone': {
        const next = patchObject(e.item as Zone, patch, ['name', 'description', 'trust', 'parentId']);
        if (next.parentId && all.get(next.parentId)?.kind !== 'zone') return fail(`No existe la zona «${next.parentId}».`);
        if (next.parentId && zoneSubtree(doc, id).has(next.parentId)) return fail('Una zona no puede estar dentro de sí misma ni de una de sus zonas hijas.');
        return ok({ ...doc, zones: doc.zones.map((z) => (z.id === id ? next : z)) }, id);
      }
      case 'flow': {
        const next = patchObject(e.item as Flow, patch, ['description', 'protocol', 'classification', 'encrypted', 'authentication']);
        if (next.authentication === 'none' && (e.item as Flow).authentication !== 'none' && needsAuthentication(crossingsById(doc).get(id))) return fail('Un flujo que entra en una zona más confiable debe autenticar a quien lo envía.');
        return ok({ ...doc, flows: doc.flows.map((f) => (f.id === id ? next : f)) }, id);
      }
      case 'threat': {
        const next = patchObject(e.item as Threat, patch, ['title', 'description', 'category', 'targetId', 'likelihood', 'impact', 'status', 'controlIds']);
        const target = all.get(next.targetId);
        if (!target || (target.kind !== 'asset' && target.kind !== 'flow')) return fail('Una amenaza recae sobre un activo o un flujo.');
        if (!(STRIDE as readonly string[]).includes(next.category)) return fail(`Categoría STRIDE desconocida: ${String(next.category)}`);
        const missing = (next.controlIds ?? []).find((c) => all.get(c)?.kind !== 'control');
        if (missing) return fail(`No existe el control «${missing}».`);
        return ok({ ...doc, threats: doc.threats.map((t) => (t.id === id ? next : t)) }, id);
      }
      default:
        return ok({ ...doc, controls: doc.controls.map((c) => (c.id === id ? patchObject(c, patch, ['name', 'description', 'kind', 'status', 'owner', 'standard']) : c)) }, id);
    }
  },

  remove(doc, id) {
    const all = indexElements(doc);
    const e = all.get(id);
    if (e) {
      switch (e.kind) {
        case 'asset':
          return ok(withoutAssets(doc, new Set([id])));
        case 'zone': {
          const zones = zoneSubtree(doc, id);
          const assets = new Set(doc.assets.filter((a) => zones.has(a.zoneId)).map((a) => a.id));
          return ok({ ...withoutAssets(doc, assets), zones: doc.zones.filter((z) => !zones.has(z.id)) });
        }
        case 'flow':
          return ok({ ...doc, flows: doc.flows.filter((f) => f.id !== id), threats: doc.threats.filter((t) => t.targetId !== id) });
        case 'threat':
          return ok({ ...doc, threats: doc.threats.filter((t) => t.id !== id) });
        default:
          return ok({ ...doc, controls: doc.controls.filter((c) => c.id !== id), threats: doc.threats.map((t) => (t.controlIds ? { ...t, controlIds: t.controlIds.filter((c) => c !== id) } : t)) });
      }
    }
    if (parseHeatCell(id) || id.startsWith('std:')) return fail('Las celdas de la matriz y los catálogos de estándares se derivan del documento: no se borran.');
    if (id.startsWith('t:')) return fail('Una amenaza siempre recae sobre algo: borra la amenaza o cambia sobre qué recae en sus propiedades.');
    if (id.startsWith('m:')) {
      const [, controlId, threatId] = id.split(':');
      return ok({ ...doc, threats: doc.threats.map((t) => (t.id === threatId ? { ...t, controlIds: (t.controlIds ?? []).filter((c) => c !== controlId) } : t)) });
    }
    return fail(`No existe «${id}».`);
  },

  canConnect(doc, kind, sourceId, targetId) {
    if (sourceId === targetId) return 'Un elemento no puede unirse consigo mismo.';
    const all = indexElements(doc);
    const s = all.get(sourceId);
    const t = all.get(targetId);
    if (!s || !t) return 'El origen o el destino no existe.';
    if (isFlowKind(kind)) {
      if (s.kind !== 'asset' || t.kind !== 'asset') return 'Un flujo de datos une dos activos.';
      if (doc.flows.some((f) => f.sourceId === sourceId && f.targetId === targetId)) return 'Ese flujo ya existe.';
      const outside = (a: Asset): boolean => a.kind === 'actor' || a.kind === 'external';
      const [from, to] = [s.item as Asset, t.item as Asset];
      if ((outside(from) && to.kind === 'datastore') || (from.kind === 'datastore' && outside(to))) return 'Un actor o sistema externo no habla directamente con un almacén de datos: pasa por un proceso.';
      // Un secreto lo leen (o lo guardan) procesos e identidades; un canal une cualquier activo que no sea un secreto.
      if ((from.kind === 'secret' && to.kind !== 'process' && to.kind !== 'identity') || (to.kind === 'secret' && from.kind !== 'process' && from.kind !== 'identity')) {
        return 'Un secreto solo lo leen o lo guardan procesos e identidades: conéctalo con un proceso o un proveedor de identidad.';
      }
      if (from.kind === 'channel' && to.kind === 'channel') return 'Un canal de confianza no se une con otro canal: pon el canal entre dos zonas, con un flujo a cada lado.';
      return undefined;
    }
    if (kind === 'threat') {
      const [threat, target] = s.kind === 'threat' ? [s, t] : [t, s];
      if (threat.kind !== 'threat' || (target.kind !== 'asset' && target.kind !== 'flow')) return '«amenaza a» une una amenaza con el activo o flujo sobre el que recae.';
      if ((threat.item as Threat).targetId === target.id) return 'La amenaza ya recae sobre ese elemento.';
      const applicable = STRIDE_BY_ELEMENT[target.kind === 'flow' ? 'flow' : (target.item as Asset).kind];
      if (!applicable.includes((threat.item as Threat).category)) {
        return `«${STRIDE_LABELS[(threat.item as Threat).category]}» no aplica a ${target.kind === 'flow' ? 'un flujo' : `un ${ASSET_LABELS[(target.item as Asset).kind].toLowerCase()}`}; cambia la categoría de la amenaza primero.`;
      }
      return undefined;
    }
    if (kind === 'mitigates') {
      const [control, threat] = s.kind === 'control' ? [s, t] : [t, s];
      if (control.kind !== 'control' || threat.kind !== 'threat') return '«mitiga» une un control con la amenaza que mitiga.';
      if ((threat.item as Threat).controlIds?.includes(control.id)) return 'Ese control ya mitiga esa amenaza.';
      return undefined;
    }
    return `Tipo de relación desconocido: ${kind}`;
  },
};


