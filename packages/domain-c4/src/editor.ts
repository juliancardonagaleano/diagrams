import {
  REF_TYPE_FIELD,
  type Box,
  type EdgeNotation,
  type EdgeRoute,
  type EditResult,
  type EditorAction,
  type EditorEdge,
  type EditorGraph,
  type EditorNode,
  type EditorSpec,
  type FieldSpec,
  type GraphLayout,
  type NodeNotation,
  type PortSide,
  type ShapeKind,
} from '@iark/kernel';
import { layoutView } from './layout/elkLayout';
import {
  ancestorIds,
  childViewType,
  createElement,
  createRelationship,
  createView,
  elementMap,
  findChildView,
  findParentView,
  isValidParentType,
  relationshipCreationBlocked,
  suggestViewElements,
  typeChangeBlockedReason,
  viewBreadcrumb,
  viewLevel,
} from './model/factories';
import { analyzeDocument } from './model/issues';
import {
  C4_COLORS,
  C4_EXTERNAL_COLOR,
  DEFAULT_SIZES,
  ELEMENT_TYPE_LABELS,
  PARENT_TYPE,
  VIEW_TYPE_LABELS,
  type C4Document,
  type C4Element,
  type C4Relationship,
  type C4View,
  type ElementShape,
  type ElementType,
  type ViewType,
} from './model/types';
import { deriveView, type DerivedView } from './model/viewDerivation';

/**
 * Edición interactiva de C4 en el lienzo común de la suite (`DomainModule.editor`): las figuras, los tipos de elemento, las
 * relaciones, las vistas por nivel (contexto, contenedores, componentes), el anidado de contenedores en sus límites y las
 * operaciones del modelo. El lienzo, el panel de propiedades, los enlaces entre diagramas, el deshacer y «Comparar» son los
 * comunes; este archivo solo dice qué es C4. El documento no cambia: lo que se edita aquí es el mismo JSON del editor C4 clásico.
 */

const TYPES: readonly ElementType[] = ['person', 'softwareSystem', 'container', 'component'];

/** Etiqueta corta de cada tipo para la barra de herramientas y el título de los nodos. */
const TYPE_LABEL: Record<ElementType, string> = { person: 'Persona', softwareSystem: 'Sistema', container: 'Contenedor', component: 'Componente' };
const TYPE_GLYPH: Record<ElementType, string> = { person: '☺', softwareSystem: '◼', container: '▭', component: '▫' };

const NODE_KINDS: NodeNotation[] = TYPES.map((type) => ({
  kind: type,
  label: TYPE_LABEL[type],
  glyph: TYPE_GLYPH[type],
  shape: type === 'person' ? 'actor' : 'rounded',
  fill: C4_COLORS[type],
  width: DEFAULT_SIZES[type].width,
  height: DEFAULT_SIZES[type].height,
}));

const RELATIONSHIP_STROKE = '#707070';

const EDGE_KINDS: EdgeNotation[] = [
  { kind: 'relationship', label: 'Relación', stroke: RELATIONSHIP_STROKE, line: 'solid', width: 1.5 },
  // La que se dibuja entre ancestros visibles cuando los extremos reales no están en la vista: se deriva, no se crea a mano.
  { kind: 'implied', label: 'Relación implícita', addable: false, stroke: RELATIONSHIP_STROKE, line: 'dashed', width: 1.5 },
];

/** Figura del vocabulario común que mejor equivale a cada forma convencional de C4 (la persona siempre es una figura humana). */
const SHAPE_OF: Record<Exclude<ElementShape, 'default'>, ShapeKind> = { database: 'cylinder', queue: 'pipe', browser: 'card', mobile: 'pill' };
const SHAPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'default', label: 'Predeterminada' },
  { value: 'database', label: 'Base de datos' },
  { value: 'queue', label: 'Cola' },
  { value: 'browser', label: 'Navegador' },
  { value: 'mobile', label: 'Móvil' },
];
const SHAPES = new Set<string>(SHAPE_OPTIONS.map((o) => o.value));

/** Qué tipos de elemento muestra cada tipo de vista: el contexto no baja de los sistemas; los componentes solo se ven al detallar un contenedor. */
const SHOWN_IN: Record<ViewType, readonly ElementType[]> = {
  systemContext: ['person', 'softwareSystem'],
  container: ['person', 'softwareSystem', 'container'],
  component: ['person', 'softwareSystem', 'container', 'component'],
};
const VIEW_LEVEL_LABEL: Record<ViewType, string> = { systemContext: 'contexto', container: 'contenedores', component: 'componentes' };

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
const isType = (value: string): value is ElementType => (TYPES as readonly string[]).includes(value);
const lower = (type: ElementType): string => ELEMENT_TYPE_LABELS[type].toLowerCase();

// ───────────── proyección ─────────────

/** La vista pedida o, sin indicar, la primera; `undefined` si el documento no la tiene (p. ej. al proyectar la versión base de «Comparar»). */
function findView(doc: C4Document, viewId?: string): C4View | undefined {
  return viewId === undefined ? doc.views[0] : doc.views.find((v) => v.id === viewId);
}

/** Etiqueta corta de un error de `analyzeDocument` para marcarlo sobre el elemento (el detalle está en la pestaña Problemas). */
const ERROR_BADGE: Array<[RegExp, string]> = [
  [/no tiene padre asignado/, 'Sin padre'],
  [/padre de tipo incorrecto/, 'Padre incorrecto'],
  [/no incluye su alcance/, 'Fuera de su vista'],
];

/** Los errores del modelo (los de `validate()`) vistos sobre cada elemento: la validación en vivo del lienzo. */
function errorBadges(doc: C4Document): Map<string, string[]> {
  const badges = new Map<string, string[]>();
  for (const issue of analyzeDocument(doc)) {
    if (issue.severity !== 'error' || !issue.elementId) continue;
    const label = `⚠ ${ERROR_BADGE.find(([pattern]) => pattern.test(issue.message))?.[1] ?? 'Error'}`;
    const list = badges.get(issue.elementId) ?? [];
    if (!list.includes(label)) badges.set(issue.elementId, [...list, label]);
  }
  return badges;
}

/** Marca de un elemento que tiene una vista de nivel inferior (como el ⤵ del editor principal). */
const DRILL_BADGE = '⤵ Detalle';

function toNode(el: C4Element, boundaryId: string | undefined, badges: ReadonlyMap<string, string[]>, drill = false): EditorNode {
  const technology = el.technology?.trim();
  const shape = el.type !== 'person' && el.shape && el.shape !== 'default' ? SHAPE_OF[el.shape] : undefined;
  const fill = el.color ?? (el.external ? C4_EXTERNAL_COLOR : undefined);
  const marks = drill ? [...(badges.get(el.id) ?? []), DRILL_BADGE] : badges.get(el.id);
  return {
    id: el.id,
    kind: el.type,
    label: el.name,
    ...(technology ? { sublabel: `[${technology}]` } : {}),
    ...(boundaryId ? { parentId: boundaryId } : {}),
    ...(el.ref ? { ref: el.ref } : {}),
    ...(el.external ? { dashed: true } : {}),
    ...(fill ? { fill } : {}),
    ...(shape ? { shape } : {}),
    ...(marks ? { badges: marks } : {}),
  };
}

/** Texto de una relación sobre la línea: su descripción y, entre corchetes, la tecnología. */
function relationshipLabel(rel: C4Relationship): string | undefined {
  const technology = rel.technology?.trim();
  const text = [rel.description?.trim(), technology ? `[${technology}]` : undefined].filter(Boolean).join(' ');
  return text || undefined;
}

function project(doc: C4Document, viewId?: string): EditorGraph {
  const view = findView(doc, viewId);
  if (!view) return { nodes: [], edges: [] };
  const derived = deriveView(doc, view.id);
  const badges = errorBadges(doc);
  // El doble clic baja de nivel si el elemento tiene vista de detalle y no está enlazado a otro módulo (entonces sigue el enlace).
  const nodes = [
    ...derived.boundaries.map((b) => toNode(b.element, b.boundaryId, badges)),
    ...derived.nodes.map((n) => toNode(n.element, n.boundaryId, badges, !n.element.ref && findChildView(doc, n.element.id) !== undefined)),
  ];
  const edges = derived.edges.map((e): EditorEdge => {
    const label = relationshipLabel(e.relationship);
    return { id: e.id, kind: e.implied ? 'implied' : 'relationship', source: e.sourceId, target: e.targetId, ...(label ? { label } : {}) };
  });
  return { nodes, edges };
}

// ───────────── colocación ─────────────

type Rect = Pick<Box, 'x' | 'y' | 'width' | 'height'>;

const overlaps = (a0: number, a1: number, b0: number, b1: number): boolean => a0 < b1 && b0 < a1;

/**
 * Por qué lados de las cajas va una relación: de lado a lado entre elementos de la misma fila, de arriba abajo entre los de la misma
 * columna y, en diagonal, según el sentido en que la vista se lee (los contextos bajan; los contenedores y componentes van de izquierda a derecha).
 */
function sidesBetween(from: Rect, to: Rect, vertical: boolean): { source: PortSide; target: PortSide } {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  const sameRow = overlaps(from.y, from.y + from.height, to.y, to.y + to.height);
  const sameColumn = overlaps(from.x, from.x + from.width, to.x, to.x + to.width);
  const useVertical = sameRow && !sameColumn ? false : sameColumn && !sameRow ? true : vertical;
  if (useVertical) return dy >= 0 ? { source: 'bottom', target: 'top' } : { source: 'top', target: 'bottom' };
  return dx >= 0 ? { source: 'right', target: 'left' } : { source: 'left', target: 'right' };
}

function anchorOf(box: Rect, side: PortSide): { x: number; y: number } {
  switch (side) {
    case 'top':
      return { x: box.x + box.width / 2, y: box.y };
    case 'bottom':
      return { x: box.x + box.width / 2, y: box.y + box.height };
    case 'left':
      return { x: box.x, y: box.y + box.height / 2 };
    default:
      return { x: box.x + box.width, y: box.y + box.height / 2 };
  }
}

/** La colocación de C4 (guardada en la vista o calculada con ELK) en la forma que dibuja el lienzo común. */
async function layout(doc: C4Document, viewId?: string, options?: { fresh?: boolean }): Promise<GraphLayout | undefined> {
  const view = findView(doc, viewId);
  if (!view) return undefined;
  const derived: DerivedView = deriveView(doc, view.id);
  // Sin elementos que colocar (solo el límite vacío del alcance), el autolayout común basta.
  if (derived.nodes.length === 0) return undefined;
  const result = await layoutView(doc, view.id, { force: options?.fresh === true });
  const nodes: Box[] = result.positions.map(({ id, x, y, width, height }) => ({ id, x, y, width, height }));
  const groups: Box[] = result.boundaries.map(({ id, x, y, width, height }) => ({ id, x, y, width, height }));
  const boxes = new Map([...nodes, ...groups].map((b) => [b.id, b]));
  const vertical = (result.direction ?? 'DOWN') === 'DOWN' || result.direction === 'UP';
  const edges = derived.edges.flatMap((e): EdgeRoute[] => {
    const [from, to] = [boxes.get(e.sourceId), boxes.get(e.targetId)];
    if (!from || !to) return [];
    const sides = sidesBetween(from, to, vertical);
    return [{ id: e.id, points: [anchorOf(from, sides.source), anchorOf(to, sides.target)], sides }];
  });
  const all = [...nodes, ...groups];
  return {
    nodes,
    groups,
    edges,
    width: Math.max(0, ...all.map((b) => b.x + b.width)),
    height: Math.max(0, ...all.map((b) => b.y + b.height)),
  };
}

// ───────────── lectura y campos ─────────────

/** Id de la relación real que hay detrás de una relación implícita (`rel@origen->destino`). */
function impliedBase(doc: C4Document, id: string): C4Relationship | undefined {
  const at = id.indexOf('@');
  return at > 0 ? doc.model.relationships.find((r) => r.id === id.slice(0, at)) : undefined;
}

type Found = { type: 'node'; element: C4Element } | { type: 'edge'; relationship: C4Relationship; implied: boolean };

function find(doc: C4Document, id: string): Found | undefined {
  const element = doc.model.elements.find((e) => e.id === id);
  if (element) return { type: 'node', element };
  const relationship = doc.model.relationships.find((r) => r.id === id);
  if (relationship) return { type: 'edge', relationship, implied: false };
  const base = impliedBase(doc, id);
  return base ? { type: 'edge', relationship: base, implied: true } : undefined;
}

const REF_FIELD: FieldSpec = { key: 'ref', label: 'Referencia (URN)', type: 'text', hint: 'urn:iark:<módulo>:<id>' };
const TAGS_FIELD: FieldSpec = { key: 'tags', label: 'Etiquetas', type: 'list' };

const RELATIONSHIP_FIELDS: FieldSpec[] = [
  { key: 'description', label: 'Descripción', type: 'longtext', hint: 'p. ej. Consulta saldos' },
  { key: 'technology', label: 'Tecnología', type: 'text', hint: 'p. ej. HTTPS/JSON' },
  TAGS_FIELD,
];

function nodeFields(type: ElementType, doc: C4Document, values?: Record<string, unknown>): FieldSpec[] {
  const required = PARENT_TYPE[type];
  const parents = required ? doc.model.elements.filter((e) => e.type === required).map((e) => ({ value: e.id, label: e.name })) : [];
  return [
    { key: 'type', label: 'Tipo', type: 'select', options: TYPES.map((t) => ({ value: t, label: ELEMENT_TYPE_LABELS[t] })) },
    { key: 'name', label: 'Nombre', type: 'text' },
    { key: 'description', label: 'Descripción', type: 'longtext' },
    // Un sistema o una persona importados pueden traer tecnología: no se oculta si ya la tienen.
    ...(type === 'container' || type === 'component' || values?.technology ? ([{ key: 'technology', label: 'Tecnología', type: 'text', hint: 'p. ej. Spring Boot, PostgreSQL' }] as FieldSpec[]) : []),
    ...(required ? ([{ key: 'parentId', label: `${ELEMENT_TYPE_LABELS[required]} al que pertenece`, type: 'select', options: parents, allowEmpty: !values?.parentId }] as FieldSpec[]) : []),
    ...(type === 'person' ? [] : ([{ key: 'shape', label: 'Figura', type: 'select', options: SHAPE_OPTIONS }] as FieldSpec[])),
    { key: 'external', label: 'Externo (fuera de lo que se construye)', type: 'boolean' },
    { key: 'color', label: 'Color', type: 'text', hint: '#RRGGBB; sustituye al color C4 del tipo' },
    TAGS_FIELD,
    REF_FIELD,
    REF_TYPE_FIELD,
  ];
}

// ───────────── edición del modelo ─────────────

/** Ids ya usados por elementos y relaciones: comparten espacio en el lienzo, donde una selección no distingue unos de otras. */
const takenIds = (doc: C4Document): string[] => [...doc.model.elements.map((e) => e.id), ...doc.model.relationships.map((r) => r.id)];

const withElements = (doc: C4Document, elements: C4Element[]): C4Document => ({ ...doc, model: { ...doc.model, elements } });
const withViews = (doc: C4Document, views: C4View[]): C4Document => ({ ...doc, views });

/** Pone o quita (si está vacío) un texto opcional. */
function setText(target: Record<string, unknown>, key: string, value: unknown): void {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text) target[key] = text;
  else delete target[key];
}

function setTags(target: Record<string, unknown>, value: unknown): void {
  const tags = Array.isArray(value) ? value.map((t) => String(t).trim()).filter(Boolean) : [];
  if (tags.length > 0) target.tags = [...new Set(tags)];
  else delete target.tags;
}

const has = (patch: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(patch, key);

/** Un padre de este tipo para un elemento nuevo: el seleccionado (o su ancestro), el alcance de la vista o el único que haya. */
function pickParent(doc: C4Document, required: ElementType, selectedId: string | undefined, view: C4View | undefined): string | undefined {
  const elements = elementMap(doc);
  for (const start of [selectedId, view?.scopeId]) {
    if (!start || !elements.has(start)) continue;
    for (const id of [start, ...ancestorIds(start, elements)]) if (elements.get(id)?.type === required) return id;
  }
  const only = doc.model.elements.filter((e) => e.type === required);
  return only.length === 1 ? only[0].id : undefined;
}

function addNode(doc: C4Document, kind: string, name: string, selectedId?: string, viewId?: string): EditResult<C4Document> {
  if (!isType(kind)) return fail(`«${kind}» no es un tipo de elemento C4.`);
  const view = findView(doc, viewId);
  if (view && !SHOWN_IN[view.type].includes(kind)) {
    return fail(`Una vista de ${VIEW_LEVEL_LABEL[view.type]} no muestra elementos de tipo ${lower(kind)}: baja al detalle del elemento al que pertenece (Alt+↓) y añádelo allí.`);
  }
  const required = PARENT_TYPE[kind];
  const parentId = required ? pickParent(doc, required, selectedId, view) : undefined;
  if (required && !parentId) return fail(`Un ${lower(kind)} pertenece a un ${lower(required)}: selecciona uno o crea primero el ${lower(required)}.`);
  const label = name.trim() || `${TYPE_LABEL[kind]} nuevo`;
  const element = createElement(kind, { name: kind === 'person' && label === 'Persona nuevo' ? 'Persona nueva' : label, ...(parentId ? { parentId } : {}) }, takenIds(doc));
  const shown = view && !view.elements.some((e) => e.id === element.id);
  return {
    ok: true,
    id: element.id,
    document: {
      ...withElements(doc, [...doc.model.elements, element]),
      views: shown ? doc.views.map((v) => (v.id === view.id ? { ...v, elements: [...v.elements, { id: element.id }] } : v)) : doc.views,
    },
  };
}

function addEdge(doc: C4Document, kind: string, sourceId: string, targetId: string): EditResult<C4Document> {
  if (kind !== 'relationship') return fail('Una relación implícita se deriva de las demás: no se crea a mano.');
  const elements = elementMap(doc);
  if (!elements.has(sourceId) || !elements.has(targetId)) return fail('El origen o el destino de la relación no existen.');
  const blocked = connectionBlocked(doc, sourceId, targetId);
  if (blocked) return fail(blocked);
  const rel = createRelationship(sourceId, targetId, { description: 'Usa' }, takenIds(doc));
  return { ok: true, id: rel.id, document: { ...doc, model: { ...doc.model, relationships: [...doc.model.relationships, rel] } } };
}

function connectionBlocked(doc: C4Document, sourceId: string, targetId: string): string | undefined {
  const blocked = relationshipCreationBlocked(doc.model.relationships, sourceId, targetId);
  if (blocked === 'self') return 'Una relación une dos elementos distintos.';
  if (blocked === 'duplicate') return 'Ya existe una relación entre esos dos elementos (edítala en lugar de repetirla).';
  return undefined;
}

function updateElement(doc: C4Document, element: C4Element, patch: Record<string, unknown>): EditResult<C4Document> {
  const next: Record<string, unknown> = { ...element };
  const typed = next as unknown as C4Element;
  if (has(patch, 'type')) {
    const type = String(patch.type);
    if (!isType(type)) return fail(`«${type}» no es un tipo de elemento C4.`);
    const blocked = typeChangeBlockedReason(doc, element.id, type);
    if (blocked) return fail(`No se puede cambiar «${element.name}» a ${lower(type)}: ${blocked}.`);
    typed.type = type;
  }
  if (has(patch, 'name')) {
    const name = typeof patch.name === 'string' ? patch.name.trim() : '';
    if (!name) return fail('El nombre no puede quedar vacío.');
    typed.name = name;
  }
  if (has(patch, 'parentId')) {
    const wanted = typeof patch.parentId === 'string' ? patch.parentId : '';
    const required = PARENT_TYPE[typed.type];
    if (!wanted) {
      if (required) return fail(`Un ${lower(typed.type)} tiene que pertenecer a un ${lower(required)}.`);
      delete next.parentId;
    } else {
      const parent = doc.model.elements.find((e) => e.id === wanted);
      if (!parent) return fail(`El elemento «${wanted}» no existe.`);
      if (!isValidParentType(parent.type, typed.type)) return fail(required ? `Un ${lower(typed.type)} solo puede pertenecer a un ${lower(required)}.` : `Un ${lower(typed.type)} no pertenece a ningún otro elemento.`);
      typed.parentId = wanted;
    }
  } else if (has(patch, 'type') && typed.parentId) {
    // Al cambiar de tipo, un padre que ya no encaja se suelta (el documento sigue siendo válido; la validación avisa de que falta).
    const parent = doc.model.elements.find((e) => e.id === typed.parentId);
    if (!isValidParentType(parent?.type, typed.type)) delete next.parentId;
  }
  for (const key of ['description', 'technology']) if (has(patch, key)) setText(next, key, patch[key]);
  if (has(patch, 'tags')) setTags(next, patch.tags);
  if (has(patch, 'external')) {
    if (patch.external === true) typed.external = true;
    else delete next.external;
  }
  if (has(patch, 'shape')) {
    const shape = typeof patch.shape === 'string' ? patch.shape : '';
    if (shape && !SHAPES.has(shape)) return fail(`«${shape}» no es una figura conocida.`);
    if (!shape || shape === 'default') delete next.shape;
    else typed.shape = shape as ElementShape;
  }
  if (has(patch, 'color')) {
    const color = typeof patch.color === 'string' ? patch.color.trim() : '';
    if (color && !HEX_COLOR.test(color)) return fail('El color tiene que ser un valor hexadecimal #RRGGBB.');
    setText(next, 'color', color);
  }
  if (has(patch, 'ref')) {
    setText(next, 'ref', patch.ref);
    if (!next.ref) delete next.refType;
  }
  if (has(patch, 'refType')) setText(next, 'refType', next.ref ? patch.refType : '');
  return { ok: true, id: element.id, document: withElements(doc, doc.model.elements.map((e) => (e.id === element.id ? typed : e))) };
}

function updateRelationship(doc: C4Document, relationship: C4Relationship, patch: Record<string, unknown>): EditResult<C4Document> {
  const next: Record<string, unknown> = { ...relationship };
  for (const key of ['description', 'technology']) if (has(patch, key)) setText(next, key, patch[key]);
  if (has(patch, 'tags')) setTags(next, patch.tags);
  const rel = next as unknown as C4Relationship;
  return { ok: true, id: relationship.id, document: { ...doc, model: { ...doc.model, relationships: doc.model.relationships.map((r) => (r.id === relationship.id ? rel : r)) } } };
}

/** ¿Una ruta guardada en una vista (`rel` o `rel@origen->destino`) toca alguno de estos elementos o relaciones? */
function routeTouches(doc: C4Document, routeId: string, elementIds: ReadonlySet<string>, relationshipIds: ReadonlySet<string>): boolean {
  const at = routeId.indexOf('@');
  if (at < 0) {
    const rel = doc.model.relationships.find((r) => r.id === routeId);
    return relationshipIds.has(routeId) || (!!rel && (elementIds.has(rel.sourceId) || elementIds.has(rel.targetId)));
  }
  const [source, target] = routeId.slice(at + 1).split('->');
  return relationshipIds.has(routeId.slice(0, at)) || elementIds.has(source) || elementIds.has(target);
}

/** Las rutas guardadas de una vista salvo las que tocan lo indicado; sin ninguna, la vista pierde el campo (se recalculan al vuelo). */
function withoutRoutes(doc: C4Document, view: C4View, elementIds: ReadonlySet<string>, relationshipIds: ReadonlySet<string> = new Set()): C4View {
  if (!view.edges) return view;
  const { edges, ...rest } = view;
  const kept = edges.filter((r) => !routeTouches(doc, r.id, elementIds, relationshipIds));
  return kept.length > 0 ? { ...rest, edges: kept } : rest;
}

function removeElement(doc: C4Document, id: string): EditResult<C4Document> {
  const removed = new Set<string>([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const e of doc.model.elements) {
      if (e.parentId && removed.has(e.parentId) && !removed.has(e.id)) {
        removed.add(e.id);
        grew = true;
      }
    }
  }
  const relationships = doc.model.relationships.filter((r) => !removed.has(r.sourceId) && !removed.has(r.targetId));
  const gone = new Set(doc.model.relationships.filter((r) => !relationships.includes(r)).map((r) => r.id));
  return {
    ok: true,
    document: {
      ...doc,
      model: { elements: doc.model.elements.filter((e) => !removed.has(e.id)), relationships },
      // Las vistas que trataban de lo borrado desaparecen con ello; en las demás, el elemento deja de mostrarse.
      views: doc.views
        .filter((v) => !(v.scopeId && removed.has(v.scopeId)))
        .map((v) => withoutRoutes(doc, { ...v, elements: v.elements.filter((e) => !removed.has(e.id)) }, removed, gone)),
    },
  };
}

function removeRelationship(doc: C4Document, id: string): EditResult<C4Document> {
  const ids = new Set([id]);
  return {
    ok: true,
    document: {
      ...doc,
      model: { ...doc.model, relationships: doc.model.relationships.filter((r) => r.id !== id) },
      views: doc.views.map((v) => withoutRoutes(doc, v, new Set(), ids)),
    },
  };
}

// ───────────── anidar, bajar y subir de nivel ─────────────

/**
 * Soltar un elemento sobre otro. Si el destino puede ser su padre (un contenedor sobre un sistema, un componente sobre un
 * contenedor), pasa a pertenecerle: queda dentro de su límite. Su posición guardada en las vistas se descarta para que se coloque
 * en su sitio nuevo. En cualquier otro caso soltar no significa nada y el elemento se queda donde se dejó.
 */
function drop(doc: C4Document, id: string, targetId: string): EditResult<C4Document> | undefined {
  const [element, target] = [doc.model.elements.find((e) => e.id === id), doc.model.elements.find((e) => e.id === targetId)];
  if (!element || !target || !isValidParentType(target.type, element.type) || element.parentId === target.id) return undefined;
  const moved = new Set([id]);
  return {
    ok: true,
    id,
    document: {
      ...withElements(doc, doc.model.elements.map((e) => (e.id === id ? { ...e, parentId: target.id } : e))),
      views: doc.views.map((v) =>
        withoutRoutes(doc, { ...v, elements: v.elements.map((ve) => (ve.id === id ? { id } : ve)) }, moved),
      ),
    },
  };
}

const VIEW_TITLE: Record<ViewType, string> = { systemContext: 'Contexto', container: 'Contenedores', component: 'Componentes' };

/** La vista de detalle de un sistema o contenedor: la que ya existe o una nueva con lo que le corresponde según C4. */
function detail(doc: C4Document, id: string): EditResult<C4Document> {
  const element = doc.model.elements.find((e) => e.id === id);
  const type = element ? childViewType(element) : null;
  if (!element || !type) return fail('Solo un sistema o un contenedor tiene una vista de detalle.');
  const existing = findChildView(doc, id);
  if (existing) return { ok: true, document: doc, view: existing.id };
  const elements = suggestViewElements(doc, type, id).filter((x) => x !== id);
  const view = createView(type, { scopeId: id, title: `${VIEW_TITLE[type]} - ${element.name}`, elements: elements.map((x) => ({ id: x })) }, doc.views.map((v) => v.id));
  return { ok: true, document: withViews(doc, [...doc.views, view]), view: view.id };
}

function activate(doc: C4Document, id: string): EditResult<C4Document> | undefined {
  const element = doc.model.elements.find((e) => e.id === id);
  // Con enlace a otro módulo, el doble clic lo sigue (como en los demás módulos); sin él, baja al detalle si lo hay.
  if (!element || element.ref || !childViewType(element)) return undefined;
  return detail(doc, id);
}

// ───────────── acciones sobre la vista ─────────────

const viewNeeded = 'No hay ninguna vista abierta.';

const viewOf = (doc: C4Document, viewId?: string): C4View | undefined => findView(doc, viewId);

/** Elementos del modelo a los que corresponde un texto: su nombre (sin distinguir mayúsculas) o su id. */
function matchElements(doc: C4Document, text: string): C4Element[] {
  const wanted = text.trim().toLowerCase();
  if (!wanted) return [];
  const byId = doc.model.elements.filter((e) => e.id.toLowerCase() === wanted);
  return byId.length > 0 ? byId : doc.model.elements.filter((e) => e.name.trim().toLowerCase() === wanted);
}

const ACTIONS: Array<EditorAction<C4Document>> = [
  {
    id: 'detail',
    label: 'Detallar',
    hint: 'Abrir la vista de detalle del sistema o contenedor seleccionado (la crea si no existe) · Alt+↓ · doble clic',
    needs: 'one',
    shortcut: 'alt+down',
    disabled(doc, ids) {
      const element = doc.model.elements.find((e) => e.id === ids[0]);
      return element && childViewType(element) ? undefined : 'Selecciona un sistema o un contenedor: son los que se detallan.';
    },
    run: (doc, ids) => detail(doc, ids[0]),
  },
  {
    id: 'up',
    label: 'Subir nivel',
    hint: 'Abrir la vista del nivel superior (de componentes a contenedores, de contenedores a contexto) · Alt+↑',
    needs: 'none',
    shortcut: 'alt+up',
    disabled(doc, _ids, viewId) {
      const view = viewOf(doc, viewId);
      return view && findParentView(doc, view) ? undefined : 'Esta vista no tiene un nivel superior.';
    },
    run(doc, _ids, _input, viewId) {
      const view = viewOf(doc, viewId);
      const parent = view ? findParentView(doc, view) : undefined;
      return parent ? { ok: true, document: doc, view: parent.id } : fail('Esta vista no tiene un nivel superior.');
    },
  },
  {
    id: 'show-in-view',
    label: 'Mostrar en la vista…',
    hint: 'Añadir a la vista un elemento que ya existe en el modelo',
    needs: 'none',
    prompt: {
      label: 'Elemento del modelo (nombre o id)',
      placeholder: 'p. ej. Sistema de correo',
      suggestions(doc, viewId) {
        const shown = new Set(viewOf(doc, viewId)?.elements.map((e) => e.id));
        return doc.model.elements.filter((e) => !shown.has(e.id)).map((e) => e.name);
      },
    },
    disabled: (doc, _ids, viewId) => (viewOf(doc, viewId) ? undefined : viewNeeded),
    run(doc, _ids, input, viewId) {
      const view = viewOf(doc, viewId);
      if (!view) return fail(viewNeeded);
      const found = matchElements(doc, input ?? '');
      if (found.length === 0) return fail(`No hay ningún elemento llamado «${input ?? ''}» en el modelo.`);
      if (found.length > 1) return fail(`Hay ${found.length} elementos llamados «${input}»: usa su id (${found.map((e) => e.id).join(', ')}).`);
      const [element] = found;
      if (view.elements.some((e) => e.id === element.id) || view.scopeId === element.id) return fail(`«${element.name}» ya está en la vista.`);
      if (!SHOWN_IN[view.type].includes(element.type)) return fail(`Una vista de ${VIEW_LEVEL_LABEL[view.type]} no muestra elementos de tipo ${lower(element.type)}.`);
      return { ok: true, id: element.id, document: withViews(doc, doc.views.map((v) => (v.id === view.id ? { ...v, elements: [...v.elements, { id: element.id }] } : v))) };
    },
  },
  {
    id: 'remove-from-view',
    label: 'Quitar de la vista',
    hint: 'Dejar de mostrar lo seleccionado en esta vista sin borrarlo del modelo',
    needs: 'many',
    disabled(doc, ids, viewId) {
      const view = viewOf(doc, viewId);
      if (!view) return viewNeeded;
      const missing = ids.find((id) => !view.elements.some((e) => e.id === id));
      if (missing) return view.scopeId === missing ? 'El alcance de la vista no se puede quitar de ella.' : `«${doc.model.elements.find((e) => e.id === missing)?.name ?? missing}» no está en la lista de la vista.`;
      const scope = view.type === 'systemContext' ? ids.find((id) => id === view.scopeId) : undefined;
      return scope ? 'El sistema de una vista de contexto no se puede quitar: sin él la vista deja de ser válida.' : undefined;
    },
    run(doc, ids, _input, viewId) {
      const view = viewOf(doc, viewId);
      if (!view) return fail(viewNeeded);
      const quitar = new Set(ids);
      return { ok: true, document: withViews(doc, doc.views.map((v) => (v.id === view.id ? { ...v, elements: v.elements.filter((e) => !quitar.has(e.id)) } : v))) };
    },
  },
  {
    id: 'complete-view',
    label: 'Completar vista',
    hint: 'Añadir a la vista lo que le corresponde según C4: los contenedores o componentes de su alcance y lo que se relaciona con ellos',
    needs: 'none',
    disabled(doc, _ids, viewId) {
      const view = viewOf(doc, viewId);
      if (!view) return viewNeeded;
      return missingFrom(doc, view).length > 0 ? undefined : 'La vista ya muestra todo lo que le corresponde.';
    },
    run(doc, _ids, _input, viewId) {
      const view = viewOf(doc, viewId);
      if (!view) return fail(viewNeeded);
      const missing = missingFrom(doc, view);
      if (missing.length === 0) return fail('La vista ya muestra todo lo que le corresponde.');
      return { ok: true, document: withViews(doc, doc.views.map((v) => (v.id === view.id ? { ...v, elements: [...v.elements, ...missing.map((id) => ({ id }))] } : v))) };
    },
  },
  {
    id: 'new-view',
    label: 'Nueva vista…',
    hint: 'Crear una vista de contexto (del sistema seleccionado, si hay uno). Las de contenedores y componentes se crean al detallar',
    needs: 'none',
    prompt: {
      label: 'Título de la vista',
      initial(doc, ids) {
        const scope = ids.length === 1 ? doc.model.elements.find((e) => e.id === ids[0] && e.type === 'softwareSystem') : undefined;
        return scope ? `${VIEW_TITLE.systemContext} - ${scope.name}` : VIEW_TITLE.systemContext;
      },
    },
    run(doc, ids, input) {
      const scope = ids.length === 1 ? doc.model.elements.find((e) => e.id === ids[0] && e.type === 'softwareSystem') : undefined;
      const title = (input ?? '').trim() || VIEW_TITLE.systemContext;
      const elements = suggestViewElements(doc, 'systemContext', scope?.id);
      const view = createView('systemContext', { ...(scope ? { scopeId: scope.id } : {}), title, elements: elements.map((id) => ({ id })) }, doc.views.map((v) => v.id));
      return { ok: true, document: withViews(doc, [...doc.views, view]), view: view.id };
    },
  },
  {
    id: 'rename-view',
    label: 'Renombrar vista…',
    hint: 'Cambiar el título de la vista abierta',
    needs: 'none',
    prompt: { label: 'Título de la vista', initial: (doc, _ids, viewId) => viewOf(doc, viewId)?.title ?? '' },
    disabled: (doc, _ids, viewId) => (viewOf(doc, viewId) ? undefined : viewNeeded),
    run(doc, _ids, input, viewId) {
      const view = viewOf(doc, viewId);
      const title = (input ?? '').trim();
      if (!view) return fail(viewNeeded);
      if (!title) return fail('El título de la vista no puede quedar vacío.');
      return { ok: true, document: withViews(doc, doc.views.map((v) => (v.id === view.id ? { ...v, title } : v))) };
    },
  },
  {
    id: 'delete-view',
    label: 'Eliminar vista',
    hint: 'Borrar la vista abierta (los elementos y relaciones del modelo se conservan)',
    needs: 'none',
    disabled: (doc, _ids, viewId) => (viewOf(doc, viewId) ? undefined : viewNeeded),
    run(doc, _ids, _input, viewId) {
      const view = viewOf(doc, viewId);
      if (!view) return fail(viewNeeded);
      const views = doc.views.filter((v) => v.id !== view.id);
      return { ok: true, document: withViews(doc, views), ...(views[0] ? { view: views[0].id } : {}) };
    },
  },
];

/** Lo que C4 manda mostrar en una vista y aún no está en ella (su alcance se dibuja siempre como límite, aparte). */
function missingFrom(doc: C4Document, view: C4View): string[] {
  const shown = new Set(view.elements.map((e) => e.id));
  return suggestViewElements(doc, view.type, view.scopeId).filter((id) => !shown.has(id) && (view.type === 'systemContext' || id !== view.scopeId));
}

/** Camino C1 › C2 › C3 hasta la vista abierta, con el mismo rótulo que el editor principal («C2 Contenedores · Sistema»). */
function breadcrumb(doc: C4Document, viewId?: string): Array<{ id: string; label: string }> {
  if (!viewId) return [];
  return viewBreadcrumb(doc, viewId).map((v) => {
    const scope = v.scopeId ? doc.model.elements.find((e) => e.id === v.scopeId)?.name : undefined;
    return { id: v.id, label: `${viewLevel(v)} ${VIEW_TYPE_LABELS[v.type]}${scope ? ` · ${scope}` : ''}` };
  });
}

// ───────────── el descriptor ─────────────

export const c4Editor: EditorSpec<C4Document> = {
  nodeKinds: NODE_KINDS,
  edgeKinds: EDGE_KINDS,
  defaultEdgeKind: 'relationship',
  project,
  fields(target, doc, values) {
    return target.type === 'node' ? nodeFields(isType(target.kind) ? target.kind : 'softwareSystem', doc, values) : RELATIONSHIP_FIELDS;
  },
  read(doc, id) {
    const found = find(doc, id);
    if (!found) return undefined;
    if (found.type === 'node') {
      const e = found.element;
      return {
        type: 'node',
        kind: e.type,
        values: {
          type: e.type,
          name: e.name,
          description: e.description,
          technology: e.technology,
          parentId: e.parentId,
          shape: e.shape ?? 'default',
          external: e.external,
          color: e.color,
          tags: e.tags,
          ref: e.ref,
          refType: e.refType,
        },
      };
    }
    const r = found.relationship;
    return { type: 'edge', kind: found.implied ? 'implied' : 'relationship', values: { description: r.description, technology: r.technology, tags: r.tags } };
  },
  addNode,
  addEdge,
  update(doc, id, patch) {
    const found = find(doc, id);
    if (!found) return fail(`«${id}» no existe en el documento.`);
    return found.type === 'node' ? updateElement(doc, found.element, patch) : updateRelationship(doc, found.relationship, patch);
  },
  remove(doc, id) {
    const found = find(doc, id);
    if (!found) return fail(`«${id}» no existe en el documento.`);
    if (found.type === 'edge' && found.implied) {
      const source = doc.model.elements.find((e) => e.id === found.relationship.sourceId)?.name ?? found.relationship.sourceId;
      const target = doc.model.elements.find((e) => e.id === found.relationship.targetId)?.name ?? found.relationship.targetId;
      return fail(`Es una relación implícita de «${source} → ${target}»: se borra la relación original, en una vista donde se vea.`);
    }
    return found.type === 'node' ? removeElement(doc, id) : removeRelationship(doc, id);
  },
  canConnect(doc, kind, sourceId, targetId, viewId) {
    if (kind !== 'relationship') return 'Una relación implícita se deriva de las demás: no se crea a mano.';
    const blocked = connectionBlocked(doc, sourceId, targetId);
    if (blocked) return blocked;
    // Un límite (el sistema o contenedor que rodea a sus hijos) no es un extremo que la vista dibuje: la relación no se vería.
    const view = findView(doc, viewId);
    if (!view) return undefined;
    const derived = deriveView(doc, view.id);
    const isBoundary = (id: string): boolean => derived.boundaries.some((b) => b.id === id);
    if (isBoundary(sourceId) || isBoundary(targetId)) return 'Un límite no se conecta: une los elementos de su interior (las relaciones con él se dibujan en la vista del nivel superior).';
    return undefined;
  },
  layout,
  breadcrumb,
  activate: (doc, id) => activate(doc, id),
  drop: (doc, id, targetId) => drop(doc, id, targetId),
  actions: ACTIONS,
};
