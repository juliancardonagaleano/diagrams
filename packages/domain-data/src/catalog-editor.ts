import { uniqueId, type EdgeNotation, type EditResult, type EditorGraph, type EditorTarget, type FieldSpec, type NodeNotation } from '@iark/kernel';
import { ASSET_SHAPES, KIND_COLORS, LINK_STYLES, TERM_FILL, TERM_SHAPE, TERM_STROKE, catalogLine, governanceLine } from './export/render';
import { exposeViolation, glossaryViolation, linkId, linkLabel, listLinks, portViolation, termLinkAt, termLinkViolation, type LinkKind } from './links';
import {
  API_PROTOCOLS,
  API_PROTOCOL_LABELS,
  CATALOG_KINDS,
  KIND_LABELS,
  TERM_LABEL,
  TERM_STATUSES,
  TERM_STATUS_LABELS,
  isCatalogKind,
  type AssetKind,
  type DataAsset,
  type DataDocument,
  type GlossaryTerm,
} from './types';
import type { DataView } from './views';

/**
 * Edición de los tipos del catálogo en el lienzo: el producto de datos, la API de datos, el glosario y sus términos, y las
 * conexiones entre ellos y los activos (puertos de entrada y salida, lo que sirve una API, lo que define un término).
 * `editor.ts` delega aquí; este módulo no sabe nada de pipelines, relaciones ni columnas.
 */

/** Los términos son nodos del lienzo pero no activos: viven en `DataDocument.terms`. */
export const TERM_KIND = 'term';

const LINK_KINDS: readonly LinkKind[] = ['publishes', 'consumes', 'exposes', 'defines'];
const isLinkKind = (kind: string): kind is LinkKind => (LINK_KINDS as readonly string[]).includes(kind);

const catalogAsset = (kind: AssetKind, glyph: string, width: number, height: number): NodeNotation => ({ kind, label: KIND_LABELS[kind], glyph, shape: ASSET_SHAPES[kind], fill: KIND_COLORS[kind], width, height });

/** Notación de los tipos nuevos en la paleta: producto (caja en perspectiva), glosario (lista), API (píldora) y término (ficha clara). */
export const CATALOG_NODE_KINDS: NodeNotation[] = [
  catalogAsset('data-product', '◈', 200, 84),
  catalogAsset('glossary', '≡', 190, 64),
  catalogAsset('data-api', '⇄', 180, 64),
  { kind: TERM_KIND, label: TERM_LABEL, glyph: '¶', shape: TERM_SHAPE, fill: TERM_FILL, stroke: TERM_STROKE, width: 190, height: 78 },
];

/** Relaciones del catálogo: las de producto continuas y en su color, la de una API discontinua y la de un término discontinua con punta abierta. */
export const CATALOG_EDGE_KINDS: EdgeNotation[] = [
  { kind: 'publishes', label: 'Publica (salida de un producto)', stroke: LINK_STYLES.publishes.stroke, line: 'solid', width: 1.5 },
  { kind: 'consumes', label: 'Consume (entrada de un producto)', stroke: LINK_STYLES.consumes.stroke, line: 'solid', width: 1.5 },
  { kind: 'exposes', label: 'Expone (API de datos)', stroke: LINK_STYLES.exposes.stroke, line: 'dashed', width: 1.5 },
  { kind: 'defines', label: 'Define (término del glosario)', stroke: LINK_STYLES.defines.stroke, line: 'dashed', width: 1.5, head: 'open' },
];

const options = (values: readonly string[], labels: Record<string, string>): Array<{ value: string; label: string }> => values.map((value) => ({ value, label: labels[value] ?? value }));
const shorten = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const clean = (value: unknown): unknown => (value === '' || value === null || (Array.isArray(value) && value.length === 0) ? undefined : value);
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
const fail = (reason: string): EditResult<DataDocument> => ({ ok: false, reason });

// ───────────── campos del inspector ─────────────

const TERM_FIELDS = (doc: DataDocument): FieldSpec[] => [
  { key: 'name', label: 'Término', type: 'text' },
  { key: 'definition', label: 'Definición', type: 'longtext' },
  { key: 'status', label: 'Estado', type: 'select', options: options(TERM_STATUSES, TERM_STATUS_LABELS), allowEmpty: true, hint: 'Sin estado, un borrador' },
  { key: 'owner', label: 'Responsable', type: 'text' },
  { key: 'glossaryId', label: 'Glosario', type: 'select', options: doc.assets.filter((a) => a.kind === 'glossary').map((a) => ({ value: a.id, label: a.name })), allowEmpty: true },
  { key: 'synonyms', label: 'Sinónimos', type: 'list' },
];

const COLUMN_FIELD: FieldSpec = { key: 'column', label: 'Columna enlazada', type: 'text', hint: 'Vacía: todo el activo. Ej.: email' };

/** El enlace de un término que se edita y el activo al que apunta: por el id de la relación o, sin él, por el extremo que es un activo. */
function linkedAsset(doc: DataDocument, target: EditorTarget): { asset: DataAsset; column?: string } | undefined {
  const at = target.id ? termLinkAt(doc, target.id) : undefined;
  const link = at?.term.links?.[at.index];
  const byId = link ? doc.assets.find((a) => a.id === link.assetId) : undefined;
  if (byId) return { asset: byId, ...(link?.column ? { column: link.column } : {}) };
  const asset = [target.target, target.source].map((id) => doc.assets.find((a) => a.id === id)).find((a) => a !== undefined);
  return asset ? { asset } : undefined;
}

/**
 * Campo de la columna de un enlace «define»: un desplegable con las columnas del activo enlazado y, primero, «todo el activo» (vacío). Una
 * columna ya escrita que el activo no declara se conserva como opción (marcada) para no perderla al abrir el panel. Sin saber a qué activo
 * apunta el enlace, o si ese activo no declara columnas (un informe, un modelo: acepta cualquier nombre), se escribe como texto.
 */
function columnField(doc: DataDocument, target: EditorTarget, values: Record<string, unknown> | undefined): FieldSpec {
  const linked = linkedAsset(doc, target);
  const columns = linked?.asset.columns ?? [];
  if (!linked || columns.length === 0) return COLUMN_FIELD;
  const written = linked.column ?? (typeof values?.column === 'string' ? values.column : '');
  return {
    key: 'column',
    label: COLUMN_FIELD.label,
    type: 'select',
    options: [
      { value: '', label: 'Todo el activo' },
      ...columns.map((c) => ({ value: c.name, label: c.name })),
      ...(written && !columns.some((c) => c.name === written) ? [{ value: written, label: `${written} (el activo no la declara)` }] : []),
    ],
  };
}

/** Campos de cada tipo del catálogo, tomados del formulario común de un activo (`base`) y ampliados con los suyos; `undefined` si no es del catálogo. */
export function catalogFields(target: EditorTarget, doc: DataDocument, base: () => FieldSpec[], values?: Record<string, unknown>): FieldSpec[] | undefined {
  if (target.type === 'edge') return target.kind === 'defines' ? [columnField(doc, target, values)] : isLinkKind(target.kind) ? [] : undefined;
  if (target.kind === TERM_KIND) return TERM_FIELDS(doc);
  if (!(CATALOG_KINDS as readonly string[]).includes(target.kind)) return undefined;
  const common = base();
  const pick = (...keys: string[]): FieldSpec[] => keys.flatMap((key) => common.filter((f) => f.key === key));
  if (target.kind === 'data-product') {
    return [
      ...pick('name', 'description', 'technology', 'owner', 'steward', 'domainId', 'classification', 'pii', 'retention'),
      { key: 'freshness', label: 'Frescura', type: 'text', hint: '24 h · 15 min · tiempo real' },
      { key: 'sla', label: 'SLA', type: 'longtext', hint: '99,5 % de disponibilidad, soporte L-V' },
      ...pick('contractId', 'ref', 'refType', 'tags'),
    ];
  }
  if (target.kind === 'data-api') {
    return [
      ...pick('name', 'description', 'technology', 'owner', 'steward', 'domainId', 'classification', 'pii'),
      { key: 'protocol', label: 'Protocolo', type: 'select', options: options(API_PROTOCOLS, API_PROTOCOL_LABELS), allowEmpty: true },
      { key: 'endpoint', label: 'Dirección', type: 'text', hint: 'https://api.acme.com/ventas/v1' },
      ...pick('contractId', 'ref', 'refType', 'tags'),
    ];
  }
  return pick('name', 'description', 'owner', 'steward', 'domainId', 'ref', 'refType', 'tags');
}

// ───────────── proyección al lienzo ─────────────

/**
 * Completa el grafo de una vista con el catálogo: el detalle y los avisos de los productos, APIs y glosarios, los términos
 * (dentro de su glosario) y las flechas de puertos, exposiciones y enlaces. Recibe lo que ya dibujó el editor y devuelve el grafo final.
 */
export function projectCatalog(doc: DataDocument, view: DataView, graph: EditorGraph): EditorGraph {
  const assets = new Map(doc.assets.map((a) => [a.id, a]));
  const termCount = (glossaryId: string): number => (doc.terms ?? []).filter((t) => t.glossaryId === glossaryId).length;

  const nodes: EditorGraph['nodes'] = graph.nodes.map((n) => {
    const a = assets.get(n.id);
    if (!a || !isCatalogKind(a.kind)) return n;
    const badges = [...(n.badges ?? []), ...(a.kind === 'data-api' && !a.contractId ? ['⚠ sin contrato'] : [])];
    return { ...n, sublabel: [catalogLine(a, termCount(a.id)), a.technology, governanceLine(a)].filter(Boolean).join(' · ') || undefined, badges: badges.length ? badges : undefined };
  });

  const shown = new Set(view.assetIds);
  for (const t of (doc.terms ?? []).filter((x) => view.termIds.includes(x.id))) {
    const status = t.status ?? 'draft';
    const unlinked = (t.links ?? []).length === 0 && status !== 'deprecated';
    nodes.push({
      id: t.id,
      kind: TERM_KIND,
      label: t.name,
      sublabel: shorten(t.definition ?? '', 64) || undefined,
      parentId: t.glossaryId !== undefined && shown.has(t.glossaryId) && assets.get(t.glossaryId)?.kind === 'glossary' ? t.glossaryId : undefined,
      badges: [TERM_STATUS_LABELS[status], ...(unlinked ? ['⚠ sin enlace'] : [])],
    });
  }

  const present = new Set(nodes.map((n) => n.id));
  const edges: EditorGraph['edges'] = [...graph.edges];
  for (const l of listLinks(doc).filter((x) => view.linkIds.includes(x.id))) {
    if (present.has(l.source) && present.has(l.target)) edges.push({ id: l.id, kind: l.kind, source: l.source, target: l.target, label: linkLabel(l) });
  }
  return { ...graph, nodes, edges };
}

// ───────────── lectura ─────────────

/** Valores de un término o de un enlace del catálogo (el resto de elementos los lee el editor); `undefined` si `id` no es ninguno de los dos. */
export function readCatalog(doc: DataDocument, id: string): { type: 'node' | 'edge'; kind: string; values: Record<string, unknown> } | undefined {
  const term = (doc.terms ?? []).find((t) => t.id === id);
  if (term) return { type: 'node', kind: TERM_KIND, values: { ...term } };
  const link = listLinks(doc).find((l) => l.id === id);
  return link ? { type: 'edge', kind: link.kind, values: { column: link.column ?? '' } } : undefined;
}

// ───────────── alta de nodos ─────────────

/** Crea un término (los demás tipos del catálogo se crean como cualquier activo); `undefined` si `kind` no es un término. */
export function addCatalogNode(doc: DataDocument, kind: string, name: string, parentId?: string): EditResult<DataDocument> | undefined {
  if (kind !== TERM_KIND) return undefined;
  const parent = parentId ? doc.assets.find((a) => a.id === parentId) : undefined;
  const sibling = parentId ? (doc.terms ?? []).find((t) => t.id === parentId) : undefined;
  const glossaries = doc.assets.filter((a) => a.kind === 'glossary');
  // El glosario elegido, el del término elegido o, si solo hay uno, ese.
  const glossary = parent?.kind === 'glossary' ? parent : sibling?.glossaryId ? glossaries.find((g) => g.id === sibling.glossaryId) : glossaries.length === 1 ? glossaries[0] : undefined;
  const id = uniqueId(name, [...doc.assets.map((a) => a.id), ...doc.pipelines.map((p) => p.id), ...doc.domains.map((d) => d.id), ...(doc.contracts ?? []).map((c) => c.id), ...(doc.terms ?? []).map((t) => t.id)]);
  const created: GlossaryTerm = { id, name, ...(glossary ? { glossaryId: glossary.id } : {}) };
  return { ok: true, id, document: { ...doc, terms: [...(doc.terms ?? []), created] } };
}

// ───────────── relaciones ─────────────

type End = { type: 'asset'; asset: DataAsset } | { type: 'term'; term: GlossaryTerm } | { type: 'pipeline' } | undefined;
const endOf = (doc: DataDocument, id: string): End => {
  const asset = doc.assets.find((a) => a.id === id);
  if (asset) return { type: 'asset', asset };
  const term = (doc.terms ?? []).find((t) => t.id === id);
  if (term) return { type: 'term', term };
  return id.startsWith('pipeline:') ? { type: 'pipeline' } : undefined;
};
const name = (a: DataAsset): string => `${KIND_LABELS[a.kind].toLowerCase()} «${a.name}»`;

/** Lo que une una relación del catálogo: el activo y el producto, la API o el término que lo recibe, ya orientados. */
interface Resolved {
  link: LinkKind;
  /** El producto, la API o el término. */
  owner: DataAsset | GlossaryTerm;
  asset: DataAsset;
}

function resolve(doc: DataDocument, kind: LinkKind, sourceId: string, targetId: string): Resolved | string {
  const [s, t] = [endOf(doc, sourceId), endOf(doc, targetId)];
  if (!s || !t) return 'El origen o el destino no existe.';
  if (s.type === 'pipeline' || t.type === 'pipeline') return 'Un pipeline no se conecta con productos, APIs ni términos: pasa por un activo.';
  if (kind === 'defines') {
    const [term, asset] = s.type === 'term' ? [s, t] : [t, s];
    if (term.type !== 'term' || asset.type !== 'asset') return 'Un término del glosario se enlaza con un activo de datos.';
    return { link: kind, owner: term.term, asset: asset.asset };
  }
  if (s.type === 'term' || t.type === 'term') return 'Un término del glosario solo se enlaza con «Define».';
  if (kind === 'publishes') return s.asset.kind === 'data-product' ? { link: kind, owner: s.asset, asset: t.asset } : `«Publica» sale de un producto de datos, no de ${name(s.asset)}.`;
  if (kind === 'consumes') return t.asset.kind === 'data-product' ? { link: kind, owner: t.asset, asset: s.asset } : `«Consume» llega a un producto de datos, no a ${name(t.asset)}.`;
  // «Expone» une una API con lo que sirve, en cualquier sentido.
  if (s.asset.kind === 'data-api') return { link: kind, owner: s.asset, asset: t.asset };
  if (t.asset.kind === 'data-api') return { link: kind, owner: t.asset, asset: s.asset };
  return `«Expone» une una API de datos con un activo, no ${name(s.asset)} con ${name(t.asset)}.`;
}

/** Por qué no se puede enlazar (`string`), `{}` si se puede, o `undefined` si la relación no es del catálogo ni toca un término. */
export function catalogConnection(doc: DataDocument, kind: string, sourceId: string, targetId: string): { reason?: string } | undefined {
  if (!isLinkKind(kind)) {
    const term = [sourceId, targetId].some((id) => (doc.terms ?? []).some((t) => t.id === id));
    return term ? { reason: 'Un término del glosario no participa en pipelines ni en relaciones entre entidades: enlázalo a un activo con «Define».' } : undefined;
  }
  if (sourceId === targetId) return { reason: 'Un elemento no puede conectarse consigo mismo.' };
  const r = resolve(doc, kind, sourceId, targetId);
  if (typeof r === 'string') return { reason: r };
  const { owner, asset } = r;
  if (r.link === 'defines') {
    const term = owner as GlossaryTerm;
    const why = termLinkViolation(asset);
    if (why) return { reason: why };
    if ((term.links ?? []).some((l) => l.assetId === asset.id && l.column === undefined)) return { reason: `El término «${term.name}» ya está enlazado a ${name(asset)}: indica una columna en el enlace existente para enlazar también otra.` };
    return {};
  }
  const holder = owner as DataAsset;
  const why = r.link === 'exposes' ? exposeViolation(holder, asset) : portViolation(holder, asset);
  if (why) return { reason: why };
  if (r.link === 'exposes' && holder.exposes?.includes(asset.id)) return { reason: `${name(holder)} ya expone ${name(asset)}.` };
  if (r.link === 'publishes') {
    if (holder.outputPorts?.includes(asset.id)) return { reason: `${name(holder)} ya publica ${name(asset)}.` };
    if (holder.inputPorts?.includes(asset.id)) return { reason: `${name(holder)} ya consume ${name(asset)}: un activo no puede ser entrada y salida del mismo producto.` };
  }
  if (r.link === 'consumes') {
    if (holder.inputPorts?.includes(asset.id)) return { reason: `${name(holder)} ya consume ${name(asset)}.` };
    if (holder.outputPorts?.includes(asset.id)) return { reason: `${name(holder)} ya publica ${name(asset)}: un activo no puede ser entrada y salida del mismo producto.` };
  }
  return {};
}

/** Crea el puerto, la exposición o el enlace de un término; `undefined` si `kind` no es una relación del catálogo. */
export function addCatalogEdge(doc: DataDocument, kind: string, sourceId: string, targetId: string): EditResult<DataDocument> | undefined {
  if (!isLinkKind(kind)) return undefined;
  const check = catalogConnection(doc, kind, sourceId, targetId);
  if (check?.reason) return fail(check.reason);
  const r = resolve(doc, kind, sourceId, targetId) as Resolved;
  const { owner, asset } = r;
  const append = (list: string[] | undefined, id: string): string[] => [...(list ?? []), id];
  if (r.link === 'defines') {
    const term = owner as GlossaryTerm;
    const nth = (term.links ?? []).filter((l) => l.assetId === asset.id).length + 1;
    const next = { ...term, links: [...(term.links ?? []), { assetId: asset.id }] };
    return { ok: true, id: linkId('defines', term.id, asset.id, nth), document: { ...doc, terms: (doc.terms ?? []).map((t) => (t.id === term.id ? next : t)) } };
  }
  const holder = owner as DataAsset;
  const patch: Partial<DataAsset> = r.link === 'exposes' ? { exposes: append(holder.exposes, asset.id) } : r.link === 'publishes' ? { outputPorts: append(holder.outputPorts, asset.id) } : { inputPorts: append(holder.inputPorts, asset.id) };
  const id = r.link === 'publishes' ? linkId('publishes', holder.id, asset.id) : linkId(r.link, asset.id, holder.id);
  return { ok: true, id, document: { ...doc, assets: doc.assets.map((a) => (a.id === holder.id ? { ...a, ...patch } : a)) } };
}

// ───────────── edición ─────────────

const ASSET_FIELDS = ['name', 'description', 'technology', 'owner', 'steward', 'domainId', 'classification', 'pii', 'retention', 'ref', 'refType', 'tags', 'contractId', 'freshness', 'sla', 'protocol', 'endpoint'];

/** Edita un término, un enlace de un término (su columna) o un activo del catálogo; `undefined` si `id` es otro elemento. */
export function updateCatalog(doc: DataDocument, id: string, patch: Record<string, unknown>): EditResult<DataDocument> | undefined {
  const term = (doc.terms ?? []).find((t) => t.id === id);
  if (term) {
    if (typeof patch.name === 'string' && !patch.name.trim()) return fail('El nombre no puede estar vacío.');
    const status = clean(patch.status);
    if ('status' in patch && status !== undefined && !(TERM_STATUSES as readonly string[]).includes(status as string)) return fail(`Estado de término desconocido: ${String(status)}`);
    const glossary = clean(patch.glossaryId);
    if ('glossaryId' in patch && glossary !== undefined) {
      const found = doc.assets.find((a) => a.id === glossary);
      if (!found) return fail(`No existe el glosario «${String(glossary)}».`);
      const why = glossaryViolation(found);
      if (why) return fail(why);
    }
    const next = patchObject(term, patch, ['name', 'definition', 'owner', 'status', 'glossaryId', 'synonyms']);
    return { ok: true, id, document: { ...doc, terms: (doc.terms ?? []).map((t) => (t.id === id ? next : t)) } };
  }

  const at = termLinkAt(doc, id);
  if (at) {
    const column = typeof patch.column === 'string' ? patch.column.trim() : undefined;
    const link = at.term.links![at.index];
    const asset = doc.assets.find((a) => a.id === link.assetId);
    if (column && asset && (asset.columns?.length ?? 0) > 0 && !asset.columns!.some((c) => c.name === column)) {
      return fail(`${name(asset)} no tiene la columna «${column}». Columnas: ${asset.columns!.map((c) => c.name).join(', ')}.`);
    }
    if ((at.term.links ?? []).some((l, i) => i !== at.index && l.assetId === link.assetId && (l.column ?? '') === (column ?? ''))) return fail(`El término «${at.term.name}» ya está enlazado a ese activo${column ? ` y esa columna` : ''}.`);
    const { column: _previous, ...rest } = link;
    const links = at.term.links!.map((l, i) => (i === at.index ? { ...rest, ...(column ? { column } : {}) } : l));
    return { ok: true, id, document: { ...doc, terms: (doc.terms ?? []).map((t) => (t.id === at.term.id ? { ...t, links } : t)) } };
  }

  const asset = doc.assets.find((a) => a.id === id);
  if (asset && isCatalogKind(asset.kind)) {
    if (typeof patch.name === 'string' && !patch.name.trim()) return fail('El nombre no puede estar vacío.');
    if ('contractId' in patch && clean(patch.contractId) !== undefined && !(doc.contracts ?? []).some((c) => c.id === patch.contractId)) return fail(`No existe el contrato «${String(patch.contractId)}».`);
    if ('protocol' in patch && clean(patch.protocol) !== undefined && !(API_PROTOCOLS as readonly string[]).includes(patch.protocol as string)) return fail(`Protocolo desconocido: ${String(patch.protocol)}`);
    return { ok: true, id, document: { ...doc, assets: doc.assets.map((a) => (a.id === id ? patchObject(a, patch, ASSET_FIELDS) : a)) } };
  }
  return undefined;
}

// ───────────── baja ─────────────

/** Borra un término o una flecha del catálogo (un puerto, una exposición, un enlace); `undefined` si `id` es otro elemento. */
export function removeCatalog(doc: DataDocument, id: string): EditResult<DataDocument> | undefined {
  if ((doc.terms ?? []).some((t) => t.id === id)) return { ok: true, document: { ...doc, terms: (doc.terms ?? []).filter((t) => t.id !== id) } };

  const at = termLinkAt(doc, id);
  if (at) {
    const links = at.term.links!.filter((_, i) => i !== at.index);
    const { links: _links, ...rest } = at.term;
    const next: GlossaryTerm = links.length > 0 ? { ...rest, links } : rest;
    return { ok: true, document: { ...doc, terms: (doc.terms ?? []).map((t) => (t.id === at.term.id ? next : t)) } };
  }

  const link = listLinks(doc).find((l) => l.id === id);
  if (!link) return undefined;
  const [holderId, field, assetId] = link.kind === 'publishes' ? [link.source, 'outputPorts', link.target] : link.kind === 'consumes' ? [link.target, 'inputPorts', link.source] : [link.target, 'exposes', link.source];
  return {
    ok: true,
    document: {
      ...doc,
      assets: doc.assets.map((a) => {
        if (a.id !== holderId) return a;
        const { [field as 'outputPorts' | 'inputPorts' | 'exposes']: list, ...rest } = a;
        const kept = (list ?? []).filter((x) => x !== assetId);
        return kept.length > 0 ? { ...rest, [field]: kept } : rest;
      }),
    },
  };
}
