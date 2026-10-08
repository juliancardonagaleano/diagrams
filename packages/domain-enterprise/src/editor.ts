import { REF_TYPE_FIELD, uniqueId, type EdgeNotation, type EditResult, type EditorAction, type EditorGraph, type EditorNode, type EditorSpec, type FieldSpec, type NodeNotation } from '@iark/kernel';
import { capabilityChildren, stageCapabilities, streamStages } from './graph';
import { buildMatrix, cellKey } from './matrix';
import {
  CONTEXT_COLOR,
  EDGE_STYLES,
  ELEMENT_ICONS,
  ELEMENT_SHAPES,
  IMPORTANCE_STROKE,
  KIND_COLORS,
  KIND_STROKES,
  LIFECYCLE_STROKE,
  capabilityLegend,
  capabilityPaint,
  formatCost,
  layoutCapabilityMap,
  layoutRoadmap,
  layoutValueStreams,
  MATRIX_MARKS,
  matrixCellId,
  matrixScene,
  parseMatrixCell,
  supportingApplications,
} from './export/render';
import {
  CRITICALITIES,
  CRITICALITY_LABELS,
  IMPORTANCES,
  IMPORTANCE_LABELS,
  KIND_LABELS,
  LIFECYCLES,
  LIFECYCLE_LABELS,
  MATURITY_MAX,
  MATURITY_MIN,
  RELATION_KINDS,
  RELATION_LABELS,
  RELATION_RULES,
  STRATEGIES,
  STRATEGY_LABELS,
  TECHNOLOGY_KINDS,
  TECHNOLOGY_KIND_LABELS,
  drawnEnds,
  indexElements,
  lifecycleOf,
  type Application,
  type BusinessService,
  type Capability,
  type Element,
  type ElementKind,
  type EnterpriseDocument,
  type Lifecycle,
  type Process,
  type Relation,
  type RelationKind,
  type Technology,
  type Unit,
  type ValueStage,
  type ValueStream,
} from './types';
import { findView, roadmapColumns } from './views';

/**
 * Editor interactivo de arquitectura empresarial. Sigue la notación de capas de ArchiMate: negocio en amarillo
 * (capacidades como recuadros redondeados, procesos como flechas anchas), aplicaciones en azul (cajas) y tecnología en
 * verde (barras), cada una con el icono de su tipo en la esquina. El mapa de capacidades las anida en cuadrícula, las
 * colorea según el criterio elegido y trae su leyenda. Las unidades son la organización: responsables de los elementos
 * (se eligen en sus propiedades) y, si se quiere, ejecutoras de un proceso (relación «asignación»); el paisaje las dibuja
 * todas para poder arrastrar una asignación hacia cualquiera. Los flujos de valor son recuadros con sus etapas como
 * chevrones en cadena y, debajo, las capacidades que las habilitan; un servicio de negocio (píldora) expone procesos y
 * capacidades a los clientes.
 */
const node = (kind: ElementKind, glyph: string, width: number, height: number): NodeNotation => ({
  kind,
  label: KIND_LABELS[kind],
  glyph,
  shape: ELEMENT_SHAPES[kind],
  fill: KIND_COLORS[kind],
  stroke: KIND_STROKES[kind],
  width,
  height,
  icon: ELEMENT_ICONS[kind],
});

/** Las columnas de la hoja de ruta no se añaden desde la paleta: salen de las fechas y el ciclo de vida. */
const PERIOD_NOTATION: NodeNotation = { kind: 'period', label: 'Periodo', glyph: '◷', shape: 'rect', fill: '#64748b', width: 232, height: 100, addable: false };

/** Las celdas y los totales de la matriz capacidad × aplicación se derivan del documento: no se añaden desde la paleta. */
const CELL_NOTATION: NodeNotation = { kind: 'cell', label: 'Celda de la matriz', glyph: '▦', shape: 'rect', fill: '#ffffff', stroke: '#868e96', width: 112, height: 44, addable: false, bare: true };
const TOTAL_NOTATION: NodeNotation = { kind: 'total', label: 'Total', glyph: 'Σ', shape: 'rect', fill: '#f1f3f5', stroke: '#868e96', width: 104, height: 44, addable: false, bare: true };

const NODE_KIND_NOTATION: NodeNotation[] = [
  node('capability', '◆', 210, 78),
  node('process', '➔', 210, 70),
  node('application', '▣', 210, 82),
  node('technology', '▤', 210, 78),
  node('unit', '☻', 190, 64),
  node('stream', '⟫', 210, 70),
  node('stage', '❯', 200, 76),
  node('service', '◖', 210, 70),
  PERIOD_NOTATION,
  CELL_NOTATION,
  TOTAL_NOTATION,
];

const EDGE_KIND_NOTATION: EdgeNotation[] = RELATION_KINDS.map((kind) => {
  const style = EDGE_STYLES[kind];
  return {
    kind,
    label: RELATION_LABELS[kind],
    stroke: style.stroke,
    line: style.dashed ? 'dashed' : 'solid',
    width: style.width ?? 1.5,
    ...(style.tail ? { tail: style.tail } : {}),
    ...(style.head === 'none' ? { arrowEnd: false } : style.head === 'open' ? { head: 'open' as const } : {}),
  };
});

const options = <T extends string>(values: readonly T[], labels: Record<T, string>): Array<{ value: string; label: string }> => values.map((value) => ({ value, label: labels[value] }));
const MATURITY_OPTIONS = Array.from({ length: MATURITY_MAX - MATURITY_MIN + 1 }, (_, i) => String(MATURITY_MIN + i)).map((value) => ({ value, label: `${value}/5` }));

const REF_FIELD: FieldSpec = { key: 'ref', label: 'Referencia (URN)', type: 'text', hint: 'urn:iark:<módulo>:<id>' };
const TAGS_FIELD: FieldSpec = { key: 'tags', label: 'Etiquetas', type: 'list' };
const END_OF_LIFE = /^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/;

function nodeFields(kind: string, doc: EnterpriseDocument): FieldSpec[] {
  const owner: FieldSpec = { key: 'ownerId', label: 'Unidad responsable', type: 'select', options: doc.units.map((u) => ({ value: u.id, label: u.name })), allowEmpty: true };
  const lifecycle: FieldSpec = { key: 'lifecycle', label: 'Ciclo de vida', type: 'select', options: options(LIFECYCLES, LIFECYCLE_LABELS), allowEmpty: true, hint: 'si no se indica, activa' };
  const common: FieldSpec[] = [
    { key: 'name', label: 'Nombre', type: 'text' },
    { key: 'description', label: 'Descripción', type: 'longtext' },
  ];
  switch (kind) {
    case 'unit':
      return [
        ...common,
        { key: 'parentId', label: 'Unidad padre', type: 'select', options: doc.units.map((u) => ({ value: u.id, label: u.name })), allowEmpty: true },
        { key: 'external', label: 'Externa (tercero)', type: 'boolean' },
      ];
    case 'capability':
      return [
        ...common,
        { key: 'parentId', label: 'Capacidad padre', type: 'select', options: doc.capabilities.map((c) => ({ value: c.id, label: c.name })), allowEmpty: true },
        owner,
        { key: 'importance', label: 'Importancia', type: 'select', options: options(IMPORTANCES, IMPORTANCE_LABELS), allowEmpty: true },
        { key: 'maturity', label: 'Madurez', type: 'select', options: MATURITY_OPTIONS, allowEmpty: true, hint: '1 inicial · 5 optimizada' },
        TAGS_FIELD,
      ];
    case 'process':
      return [...common, owner, TAGS_FIELD];
    case 'application':
      return [
        ...common,
        { key: 'technology', label: 'Tecnología (pila)', type: 'text' },
        { key: 'vendor', label: 'Proveedor', type: 'text' },
        owner,
        lifecycle,
        { key: 'criticality', label: 'Criticidad', type: 'select', options: options(CRITICALITIES, CRITICALITY_LABELS), allowEmpty: true },
        { key: 'strategy', label: 'Estrategia de modernización', type: 'select', options: options(STRATEGIES, STRATEGY_LABELS), allowEmpty: true, hint: 'conservar, migrar, reemplazar o retirar' },
        { key: 'annualCost', label: 'Coste anual', type: 'number', min: 0, step: 1000, hint: 'licencias, soporte y operación' },
        { key: 'users', label: 'Usuarios', type: 'number', min: 0, step: 1 },
        { key: 'endOfLife', label: 'Fin de soporte o retirada', type: 'text', hint: '2027-06 o 2027-06-30' },
        { key: 'external', label: 'Externa (SaaS o de terceros)', type: 'boolean' },
        REF_FIELD,
        REF_TYPE_FIELD,
        TAGS_FIELD,
      ];
    case 'technology':
      return [
        ...common,
        { key: 'kind', label: 'Clase', type: 'select', options: options(TECHNOLOGY_KINDS, TECHNOLOGY_KIND_LABELS), allowEmpty: true, hint: 'si no se indica, plataforma' },
        { key: 'version', label: 'Versión', type: 'text' },
        owner,
        lifecycle,
        { key: 'endOfLife', label: 'Fin de soporte', type: 'text', hint: '2027-06 o 2027-06-30' },
        REF_FIELD,
        REF_TYPE_FIELD,
        TAGS_FIELD,
      ];
    case 'stream':
      return [...common, owner, { key: 'stakeholder', label: 'Quien recibe el valor', type: 'text', hint: 'p. ej. Cliente de la tienda' }, TAGS_FIELD];
    case 'stage':
      return [
        ...common,
        { key: 'streamId', label: 'Flujo de valor', type: 'select', options: doc.valueStreams.map((v) => ({ value: v.id, label: v.name })) },
        { key: 'value', label: 'Valor que aporta', type: 'text', hint: 'p. ej. pedido confirmado' },
        TAGS_FIELD,
      ];
    case 'service':
      return [...common, owner, { key: 'audience', label: 'Clientes a quienes se ofrece', type: 'text', hint: 'p. ej. Clientes particulares' }, TAGS_FIELD];
    case 'cell':
      return [
        { key: 'support', label: 'La aplicación soporta la capacidad', type: 'boolean' },
        { key: 'description', label: 'Criterio (por qué la soporta)', type: 'longtext' },
      ];
    case 'period':
    case 'total':
      return [];
    default:
      return common;
  }
}

const EDGE_FIELDS: FieldSpec[] = [
  { key: 'kind', label: 'Tipo de relación', type: 'select', options: options(RELATION_KINDS, RELATION_LABELS) },
  { key: 'description', label: 'Descripción', type: 'longtext' },
];

const PATCHABLE: Record<ElementKind, string[]> = {
  unit: ['name', 'description', 'parentId', 'external'],
  capability: ['name', 'description', 'parentId', 'ownerId', 'importance', 'maturity', 'tags'],
  process: ['name', 'description', 'ownerId', 'tags'],
  application: ['name', 'description', 'technology', 'vendor', 'ownerId', 'lifecycle', 'criticality', 'strategy', 'annualCost', 'users', 'endOfLife', 'external', 'ref', 'refType', 'tags'],
  technology: ['name', 'description', 'kind', 'version', 'ownerId', 'lifecycle', 'endOfLife', 'ref', 'refType', 'tags'],
  stream: ['name', 'description', 'ownerId', 'stakeholder', 'tags'],
  stage: ['name', 'description', 'streamId', 'value', 'tags'],
  service: ['name', 'description', 'ownerId', 'audience', 'tags'],
};

const NUMERIC = new Set(['maturity', 'annualCost', 'users']);

const clean = (value: unknown): unknown => {
  if (value === '' || value === null || value === false || (Array.isArray(value) && value.length === 0)) return undefined;
  return value;
};

function patchObject<T extends object>(target: T, patch: Record<string, unknown>, allowed: string[]): T {
  const next: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const key of allowed) {
    if (!(key in patch)) continue;
    let value = clean(patch[key]);
    if (NUMERIC.has(key) && value !== undefined) value = Number(value);
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as T;
}

/** Motivo por el que el valor de un campo numérico o de fecha no vale, o `undefined`. */
function invalidValue(patch: Record<string, unknown>): string | undefined {
  for (const key of ['maturity', 'annualCost', 'users']) {
    const raw = clean(patch[key]);
    if (raw === undefined) continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) return `${key === 'annualCost' ? 'El coste anual' : key === 'users' ? 'Los usuarios' : 'La madurez'} tiene que ser un número.`;
    if (key !== 'maturity' && n < 0) return `${key === 'annualCost' ? 'El coste anual' : 'Los usuarios'} no puede ser negativo.`;
    if (key === 'users' && !Number.isInteger(n)) return 'Los usuarios son un número entero.';
  }
  const end = clean(patch.endOfLife);
  if (typeof end === 'string' && !END_OF_LIFE.test(end)) return 'El fin de soporte debe tener la forma AAAA-MM o AAAA-MM-DD.';
  return undefined;
}

/** Orientación real (origen → destino del modelo) de una relación `kind` entre dos elementos, aceptando ambos sentidos del arrastre. */
function orient(kind: RelationKind, source: ElementKind, target: ElementKind): { reversed: boolean } | undefined {
  for (const [from, to] of RELATION_RULES[kind]) {
    if (from === source && to === target) return { reversed: false };
    if (from === target && to === source) return { reversed: true };
  }
  return undefined;
}

const collection = (kind: ElementKind): keyof EnterpriseDocument =>
  ({ unit: 'units', capability: 'capabilities', process: 'processes', application: 'applications', technology: 'technologies', stream: 'valueStreams', stage: 'valueStages', service: 'businessServices' } as const)[kind];

/** Ids de una capacidad y de todas sus descendientes. */
function capabilitySubtree(doc: EnterpriseDocument, id: string): Set<string> {
  const children = capabilityChildren(doc);
  const ids = new Set<string>();
  const walk = (c: string): void => {
    ids.add(c);
    for (const k of children.get(c) ?? []) walk(k.id);
  };
  walk(id);
  return ids;
}

/** Ids de una unidad y de todas las que cuelgan de ella. */
function unitSubtree(doc: EnterpriseDocument, id: string): Set<string> {
  const ids = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const u of doc.units) {
      if (u.parentId && ids.has(u.parentId) && !ids.has(u.id)) {
        ids.add(u.id);
        grew = true;
      }
    }
  }
  return ids;
}

/**
 * Crea una etapa: en el flujo seleccionado (al final) o, si hay una etapa seleccionada, justo detrás de ella; sin
 * selección, en el primer flujo del documento, que se crea («Flujo de valor») si aún no hay ninguno.
 */
function addStage(doc: EnterpriseDocument, id: string, name: string, parentId: string | undefined): EditResult<EnterpriseDocument> {
  const selected = parentId ? indexElements(doc).get(parentId) : undefined;
  const after = selected?.kind === 'stage' ? (selected.item as ValueStage) : undefined;
  let streams = doc.valueStreams;
  let streamId = after?.streamId ?? (selected?.kind === 'stream' ? selected.id : streams[0]?.id);
  if (streamId === undefined) {
    streamId = uniqueId('Flujo de valor', indexElements(doc).keys());
    streams = [...streams, { id: streamId, name: 'Flujo de valor' }];
  }
  const created: ValueStage = { id, name, streamId };
  const stages = [...doc.valueStages];
  const at = after ? stages.findIndex((x) => x.id === after.id) + 1 : stages.reduce((last, x, i) => (x.streamId === streamId ? i + 1 : last), stages.length);
  stages.splice(at, 0, created);
  return { ok: true, id, document: { ...doc, valueStreams: streams, valueStages: stages } };
}

/** Intercambia una etapa con la contigua de su flujo (`-1` hacia el inicio, `1` hacia el final). */
function moveStage(doc: EnterpriseDocument, id: string, direction: -1 | 1): EditResult<EnterpriseDocument> {
  const stage = doc.valueStages.find((x) => x.id === id);
  if (!stage) return { ok: false, reason: 'Selecciona una etapa.' };
  const siblings = doc.valueStages.filter((x) => x.streamId === stage.streamId);
  const neighbour = siblings[siblings.findIndex((x) => x.id === id) + direction];
  if (!neighbour) return { ok: false, reason: direction < 0 ? 'La etapa ya es la primera de su flujo.' : 'La etapa ya es la última de su flujo.' };
  const swap = new Map([[stage.id, neighbour], [neighbour.id, stage]]);
  return { ok: true, id, document: { ...doc, valueStages: doc.valueStages.map((x) => swap.get(x.id) ?? x) } };
}

const relationLabel = (r: Relation): string | undefined => r.description;

/** Segunda línea de un elemento en las vistas de relaciones: lo que lo caracteriza (tecnología, responsable, clase). */
function sublabelOf(e: Element, doc: EnterpriseDocument): string | undefined {
  switch (e.kind) {
    case 'capability': {
      const c = e.item as Capability;
      return [c.importance ? IMPORTANCE_LABELS[c.importance] : undefined, c.maturity ? `madurez ${c.maturity}/5` : undefined].filter(Boolean).join(' · ') || undefined;
    }
    case 'process':
      return doc.units.find((u) => u.id === (e.item as Process).ownerId)?.name;
    case 'application': {
      const a = e.item as Application;
      return a.technology ?? a.vendor;
    }
    case 'technology': {
      const t = e.item as Technology;
      return [TECHNOLOGY_KIND_LABELS[t.kind ?? 'platform'], t.version].filter(Boolean).join(' ');
    }
    case 'unit': {
      const u = e.item as Unit;
      return u.external ? 'externa' : doc.units.find((p) => p.id === u.parentId)?.name;
    }
    case 'stream':
      return (e.item as ValueStream).stakeholder;
    case 'stage':
      return (e.item as ValueStage).value;
    case 'service': {
      const b = e.item as BusinessService;
      return b.audience ?? doc.units.find((u) => u.id === b.ownerId)?.name;
    }
    default:
      return undefined;
  }
}

function capabilityMap(doc: EnterpriseDocument, viewId: string | undefined): EditorGraph {
  const view = findView(doc, viewId ?? 'capabilities');
  const mode = view.colorBy ?? 'maturity';
  const children = capabilityChildren(doc);
  const apps = supportingApplications(doc);
  return {
    legend: capabilityLegend(mode),
    nodes: doc.capabilities.map((c): EditorNode => {
      const group = children.has(c.id);
      const supporting = apps.get(c.id) ?? [];
      const count = supporting.length;
      const paint = capabilityPaint(c, mode, supporting);
      return {
        id: c.id,
        kind: 'capability',
        label: c.name,
        parentId: c.parentId,
        sublabel: group ? undefined : [c.importance ? IMPORTANCE_LABELS[c.importance] : undefined, count === 0 ? 'sin aplicación' : `${count} ${count === 1 ? 'aplicación' : 'aplicaciones'}`].filter(Boolean).join(' · '),
        badges: !group && paint.value ? [paint.value] : undefined,
        fill: group ? undefined : paint.fill,
        // El título de una capacidad con hijas se dibuja con el color de su borde: un amarillo oscuro que se lea sobre el lienzo.
        stroke: group ? '#a07800' : c.importance ? IMPORTANCE_STROKE[c.importance] : '#868e96',
        dashed: !group && count === 0,
      };
    }),
    edges: [],
  };
}

/** Nodo de un elemento en las vistas de relaciones y en la hoja de ruta. */
function elementNode(e: Element, doc: EnterpriseDocument, context: boolean, parentId?: string): EditorNode {
  const life = lifecycleOf(e.item as { lifecycle?: Lifecycle });
  const app = e.kind === 'application' ? (e.item as Application) : undefined;
  // El coste y los usuarios van junto a la pila (las insignias no caben todas sobre el nodo); la fecha de una aplicación es el título de su columna.
  const facts = app ? [app.annualCost !== undefined ? `${formatCost(app.annualCost)}/año` : undefined, app.users !== undefined ? `${app.users} usuarios` : undefined].filter((x): x is string => !!x) : [];
  const endOfLife = e.kind === 'technology' ? (e.item as Technology).endOfLife : undefined;
  const badges = [
    app?.criticality ? `criticidad ${CRITICALITY_LABELS[app.criticality]}` : undefined,
    life !== 'active' ? LIFECYCLE_LABELS[life] : undefined,
    app?.strategy ? `estrategia ${STRATEGY_LABELS[app.strategy]}` : undefined,
    endOfLife ? `soporte hasta ${endOfLife}` : undefined,
  ].filter((b): b is string => !!b);
  return {
    id: e.id,
    kind: e.kind,
    label: e.name,
    sublabel: [sublabelOf(e, doc), ...facts].filter(Boolean).join(' · ') || undefined,
    parentId,
    ref: (e.item as { ref?: string }).ref,
    badges: badges.length > 0 ? badges : undefined,
    fill: context ? CONTEXT_COLOR : undefined,
    stroke: LIFECYCLE_STROKE[life],
    dashed: context || life === 'retired' || app?.external === true || (e.kind === 'stage' && (stageCapabilities(doc).get(e.id) ?? []).length === 0),
  };
}

/**
 * Flujos de valor: cada flujo es un grupo con sus etapas (chevrones) y, fuera de él, las capacidades que las habilitan.
 * Un flujo sin etapas se dibuja como un nodo suelto.
 */
function valueStreamGraph(doc: EnterpriseDocument): EditorGraph {
  const all = indexElements(doc);
  const view = findView(doc, 'value-stream');
  const stages = streamStages(doc);
  const stageStream = new Map(doc.valueStages.map((x) => [x.id, x.streamId]));
  const shown = new Set(view.relationIds);
  return {
    nodes: view.elementIds.flatMap((id): EditorNode[] => {
      const e = all.get(id);
      if (!e) return [];
      const node = elementNode(e, doc, false, stageStream.get(id));
      return [e.kind === 'stream' && (stages.get(id) ?? []).length > 0 ? { ...node, sublabel: undefined, stroke: '#a07800' } : node];
    }),
    edges: doc.relations
      .filter((r) => shown.has(r.id))
      .map((r) => {
        const { from, to } = drawnEnds(r);
        return { id: r.id, kind: r.kind, source: from, target: to, label: relationLabel(r) };
      }),
  };
}

/** Hoja de ruta: una columna (grupo) por periodo con las aplicaciones y la tecnología que salen o cambian. */
function roadmap(doc: EnterpriseDocument): EditorGraph {
  const all = indexElements(doc);
  const columns = roadmapColumns(doc);
  return {
    nodes: columns.flatMap((c) => [
      { id: c.id, kind: 'period', label: c.title },
      ...c.elementIds.map((id) => elementNode(all.get(id)!, doc, false, c.id)),
    ]),
    edges: [],
  };
}

/**
 * Matriz capacidad × aplicación: las cabeceras son la capacidad y la aplicación reales (se editan como en cualquier vista), las
 * celdas y los totales se derivan del documento. Todo lo coloca `matrixScene` (cuadrícula propia) y el lienzo lo dibuja como nodos.
 */
function matrixGraph(doc: EnterpriseDocument): EditorGraph {
  const { layout, nodes: styles } = matrixScene(doc);
  const apps = new Map(doc.applications.map((a) => [a.id, a]));
  return {
    nodes: layout.nodes.map((box): EditorNode => {
      const s = styles.get(box.id)!;
      return {
        id: box.id,
        kind: s.kind,
        label: s.label,
        sublabel: s.sublabel,
        badges: s.badges,
        ref: s.kind === 'application' ? apps.get(box.id)?.ref : undefined,
        fill: s.fill,
        stroke: s.stroke,
        dashed: s.dashed || undefined,
      };
    }),
    edges: [],
    legend: { title: 'Doble clic en una celda: marca o quita el soporte. Arrastra una celda con ● a otra: lo mueve.', items: [] },
  };
}

/** Relación `supports` directa de una aplicación a una capacidad, si la hay. */
const directSupport = (doc: EnterpriseDocument, capabilityId: string, applicationId: string): Relation | undefined =>
  doc.relations.find((r) => r.kind === 'supports' && r.sourceId === applicationId && r.targetId === capabilityId);

/** Marca o desmarca el soporte directo de una celda; `support` es lo que debe quedar. */
function setSupport(doc: EnterpriseDocument, cell: { capabilityId: string; applicationId: string }, support: boolean): EditResult<EnterpriseDocument> {
  const existing = directSupport(doc, cell.capabilityId, cell.applicationId);
  if (support === (existing !== undefined)) return { ok: true, document: doc };
  if (existing) return { ok: true, document: { ...doc, relations: doc.relations.filter((r) => r.id !== existing.id) } };
  return enterpriseEditor.addEdge(doc, 'supports', cell.applicationId, cell.capabilityId);
}

/**
 * Mueve el soporte directo de la celda `from` a la pareja de la celda `to` (arrastrar una celda ● y soltarla en otra): la relación
 * `supports` cambia de aplicación (misma fila), de capacidad (misma columna) o de ambas (en diagonal) y conserva el resto de sus campos,
 * su posición en el documento y, si su id era el que se genera solo (`web-supports-online`), se renombra con la pareja nueva.
 */
function moveSupport(doc: EnterpriseDocument, from: { capabilityId: string; applicationId: string }, to: { capabilityId: string; applicationId: string }): EditResult<EnterpriseDocument> {
  const name = (id: string): string => indexElements(doc).get(id)?.name ?? id;
  const relation = directSupport(doc, from.capabilityId, from.applicationId);
  if (!relation) {
    const cell = buildMatrix(doc).cells.get(cellKey(from.capabilityId, from.applicationId));
    if (!cell) return { ok: false, reason: 'La celda está vacía: no hay soporte que mover. Arrastra una celda con marca directa (●).' };
    const how = cell.support === 'process' ? `por un proceso (${MATRIX_MARKS.process})` : `heredado de una capacidad hija (${MATRIX_MARKS.inherited})`;
    return { ok: false, reason: `«${name(from.applicationId)}» soporta «${name(from.capabilityId)}» ${how}: solo se arrastran las celdas con marca directa (${MATRIX_MARKS.direct}); las demás se derivan de otras relaciones.` };
  }
  if (directSupport(doc, to.capabilityId, to.applicationId)) {
    return { ok: false, reason: `«${name(to.applicationId)}» ya soporta «${name(to.capabilityId)}» (${MATRIX_MARKS.direct}): no se mueve para no duplicar la relación. Quita antes una de las dos.` };
  }
  const why = enterpriseEditor.canConnect?.(doc, 'supports', to.applicationId, to.capabilityId);
  if (why) return { ok: false, reason: why };
  // Un id que se generó solo (`web--supports--online` de los importadores, `web-supports-online` del editor; con o sin sufijo numérico) se rehace con la pareja nueva; uno puesto a mano se respeta.
  const pair = `${relation.sourceId}--supports--${relation.targetId}`;
  const generated = [pair, uniqueId(pair, [])].some((base) => relation.id.startsWith(base) && /^(-\d+)?$/.test(relation.id.slice(base.length)));
  const id = generated ? uniqueId(`${to.applicationId}--supports--${to.capabilityId}`, doc.relations.filter((r) => r.id !== relation.id).map((r) => r.id)) : relation.id;
  return {
    ok: true,
    id: matrixCellId(to.capabilityId, to.applicationId),
    document: { ...doc, relations: doc.relations.map((r) => (r.id === relation.id ? { ...r, id, sourceId: to.applicationId, targetId: to.capabilityId } : r)) },
  };
}

/** Celdas de la matriz entre los ids dados. */
const cellsOf = (doc: EnterpriseDocument, ids: readonly string[]): Array<{ id: string; capabilityId: string; applicationId: string }> =>
  ids.flatMap((id) => {
    const cell = parseMatrixCell(doc, id);
    return cell ? [{ id, ...cell }] : [];
  });

// --- Acciones ---------------------------------------------------------------------------------------------------------

const trimmed = (value: string | undefined): string => (value ?? '').trim();

/** Elementos con responsable (no unidades ni columnas) entre los ids dados. */
const ownable = (doc: EnterpriseDocument, ids: string[]): Element[] => {
  const all = indexElements(doc);
  return ids.flatMap((id) => {
    const e = all.get(id);
    return e && e.kind !== 'unit' && e.kind !== 'stage' ? [e] : [];
  });
};

const setOwner = (doc: EnterpriseDocument, ids: Set<string>, ownerId: string): EnterpriseDocument => {
  const apply = <T extends { id: string }>(items: T[]): T[] => items.map((x) => (ids.has(x.id) ? { ...x, ownerId } : x));
  return { ...doc, capabilities: apply(doc.capabilities), processes: apply(doc.processes), applications: apply(doc.applications), technologies: apply(doc.technologies), valueStreams: apply(doc.valueStreams), businessServices: apply(doc.businessServices) };
};

const stageMover = (direction: -1 | 1): Pick<EditorAction<EnterpriseDocument>, 'needs' | 'disabled' | 'run'> => ({
  needs: 'one',
  disabled: (doc, ids) => {
    const stage = doc.valueStages.find((x) => x.id === ids[0]);
    if (!stage) return 'Selecciona una etapa.';
    const siblings = doc.valueStages.filter((x) => x.streamId === stage.streamId);
    const i = siblings.findIndex((x) => x.id === stage.id);
    return (direction < 0 ? i === 0 : i === siblings.length - 1) ? (direction < 0 ? 'La etapa ya es la primera de su flujo.' : 'La etapa ya es la última de su flujo.') : undefined;
  },
  run: (doc, ids) => moveStage(doc, ids[0], direction),
});

const ACTIONS: Array<EditorAction<EnterpriseDocument>> = [
  { id: 'stage-earlier', label: 'Etapa ◂', hint: 'Adelanta la etapa seleccionada una posición en su flujo de valor', ...stageMover(-1) },
  { id: 'stage-later', label: 'Etapa ▸', hint: 'Atrasa la etapa seleccionada una posición en su flujo de valor', ...stageMover(1) },
  {
    id: 'group-by-unit',
    label: 'Agrupar por unidad…',
    hint: 'Pone a una unidad (la crea si no existe) como responsable de los elementos seleccionados: pasan a su vista «Unidad»',
    needs: 'many',
    prompt: {
      label: 'Unidad responsable',
      placeholder: 'Logística',
      initial: (doc, ids) => {
        const counts = new Map<string, number>();
        for (const e of ownable(doc, ids)) {
          const owner = (e.item as { ownerId?: string }).ownerId;
          const name = doc.units.find((u) => u.id === owner)?.name;
          if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
      },
      suggestions: (doc) => doc.units.map((u) => u.name),
    },
    disabled: (doc, ids) => (ownable(doc, ids).length === 0 ? 'Selecciona capacidades, procesos, aplicaciones o tecnología.' : undefined),
    run(doc, ids, input) {
      const name = trimmed(input);
      if (!name) return { ok: false, reason: 'Indica la unidad responsable.' };
      const targets = ownable(doc, ids);
      if (targets.length === 0) return { ok: false, reason: 'Selecciona capacidades, procesos, aplicaciones o tecnología.' };
      const existing = doc.units.find((u) => u.id === name || u.name.toLowerCase() === name.toLowerCase());
      const unit: Unit = existing ?? { id: uniqueId(name, indexElements(doc).keys()), name };
      const next = { ...doc, units: existing ? doc.units : [...doc.units, unit] };
      return { ok: true, id: unit.id, document: setOwner(next, new Set(targets.map((e) => e.id)), unit.id) };
    },
  },
  {
    id: 'replace-application',
    label: 'Reemplazar aplicación…',
    hint: 'Crea la aplicación que sustituye a la seleccionada: hereda lo que soporta, pasa a «prevista» y la antigua queda «en retirada»',
    needs: 'one',
    prompt: { label: 'Nombre de la aplicación nueva', placeholder: 'WMS nuevo' },
    disabled: (doc, ids) => {
      const app = doc.applications.find((a) => a.id === ids[0]);
      if (!app) return 'Selecciona una aplicación.';
      return lifecycleOf(app) === 'retired' ? 'La aplicación ya está retirada.' : undefined;
    },
    run(doc, ids, input) {
      const old = doc.applications.find((a) => a.id === ids[0]);
      if (!old) return { ok: false, reason: 'Selecciona una aplicación.' };
      const name = trimmed(input);
      if (!name) return { ok: false, reason: 'Indica el nombre de la aplicación nueva.' };
      const all = indexElements(doc);
      const id = uniqueId(name, all.keys());
      const created: Application = {
        id,
        name,
        lifecycle: 'planned',
        ...(old.ownerId ? { ownerId: old.ownerId } : {}),
        ...(old.criticality ? { criticality: old.criticality } : {}),
        ...(old.users !== undefined ? { users: old.users } : {}),
      };
      const taken = new Set(doc.relations.map((r) => r.id));
      const inherited: Relation[] = doc.relations
        .filter((r) => r.kind === 'supports' && r.sourceId === old.id)
        .map((r) => {
          const rid = uniqueId(`${id}--supports--${r.targetId}`, taken);
          taken.add(rid);
          return { id: rid, kind: 'supports', sourceId: id, targetId: r.targetId };
        });
      return {
        ok: true,
        id,
        document: {
          ...doc,
          applications: [...doc.applications.map((a) => (a.id === old.id ? { ...a, ...(lifecycleOf(a) === 'active' ? { lifecycle: 'sunset' as const } : {}), strategy: 'replace' as const } : a)), created],
          relations: [...doc.relations, ...inherited],
        },
      };
    },
  },
  {
    id: 'matrix-support',
    label: 'Soporta ⇄',
    hint: 'Marca o quita el soporte (la relación «soporta») de las celdas seleccionadas de la matriz: si alguna no lo tiene, lo crea en todas; si todas lo tienen, lo quita (también con doble clic en la celda). Para moverlo, arrastra una celda con marca directa (●) a otra: la relación pasa a la aplicación y la capacidad de la celda destino',
    needs: 'many',
    disabled: (doc, ids) => (cellsOf(doc, ids).length === 0 ? 'Selecciona una o varias celdas de la matriz capacidad × aplicación.' : undefined),
    run(doc, ids) {
      const cells = cellsOf(doc, ids);
      if (cells.length === 0) return { ok: false, reason: 'Selecciona una o varias celdas de la matriz capacidad × aplicación.' };
      const want = cells.some((c) => directSupport(doc, c.capabilityId, c.applicationId) === undefined);
      let next = doc;
      for (const c of cells) {
        const result = setSupport(next, c, want);
        if (!result.ok) return result;
        next = result.document;
      }
      return { ok: true, id: cells[0].id, document: next };
    },
  },
];

export const enterpriseEditor: EditorSpec<EnterpriseDocument> = {
  nodeKinds: NODE_KIND_NOTATION,
  edgeKinds: EDGE_KIND_NOTATION,
  defaultEdgeKind: 'supports',
  actions: ACTIONS,

  project(doc, viewId) {
    const view = findView(doc, viewId);
    if (view.type === 'capabilities') return capabilityMap(doc, view.id);
    if (view.type === 'roadmap') return roadmap(doc);
    if (view.type === 'value-stream') return valueStreamGraph(doc);
    if (view.type === 'matrix') return matrixGraph(doc);
    const all = indexElements(doc);
    const context = new Set(view.contextIds);
    const nodes = view.elementIds.flatMap((id): EditorNode[] => {
      const e = all.get(id);
      return e ? [elementNode(e, doc, context.has(e.id))] : [];
    });
    // El paisaje del lienzo dibuja todas las unidades (el SVG, solo las que participan): así se puede arrastrar una asignación hacia cualquiera.
    if (view.type === 'landscape') {
      const present = new Set(nodes.map((n) => n.id));
      for (const u of doc.units) if (!present.has(u.id)) nodes.push(elementNode(all.get(u.id)!, doc, false));
    }
    const shown = new Set(view.relationIds);
    return {
      nodes,
      edges: doc.relations
        .filter((r) => shown.has(r.id))
        .map((r) => {
          const { from, to } = drawnEnds(r);
          return { id: r.id, kind: r.kind, source: from, target: to, label: relationLabel(r) };
        }),
    };
  },

  layout(doc, viewId) {
    const view = findView(doc, viewId);
    if (view.type === 'capabilities') return layoutCapabilityMap(doc);
    if (view.type === 'value-stream') return layoutValueStreams(doc).layout;
    if (view.type === 'matrix') return matrixScene(doc).layout;
    return view.type === 'roadmap' ? layoutRoadmap(doc).layout : undefined;
  },

  activate(doc, id) {
    const cell = parseMatrixCell(doc, id);
    return cell ? setSupport(doc, cell, directSupport(doc, cell.capabilityId, cell.applicationId) === undefined) : undefined;
  },

  /**
   * Matriz: arrastrar una celda con marca directa (●) y soltarla en otra mueve su relación `supports` a la pareja de la celda destino.
   * Soltar una celda sin soporte directo o sobre algo que no es una celda se rechaza con un aviso; fuera de la matriz, o con otro nodo
   * arrastrado (una cabecera, un total), no significa nada y el nodo se queda donde se dejó.
   */
  drop(doc, id, targetId, viewId) {
    const from = viewId === 'matrix' ? parseMatrixCell(doc, id) : undefined;
    if (!from) return undefined;
    const to = parseMatrixCell(doc, targetId);
    if (!to) return { ok: false, reason: 'Suelta la celda sobre otra celda de la matriz para mover su soporte.' };
    if (from.capabilityId === to.capabilityId && from.applicationId === to.applicationId) return undefined;
    return moveSupport(doc, from, to);
  },

  fields: (target, doc) => (target.type === 'node' ? nodeFields(target.kind, doc) : EDGE_FIELDS),

  read(doc, id) {
    const e = indexElements(doc).get(id);
    if (e) {
      const values: Record<string, unknown> = { ...e.item };
      if (typeof values.maturity === 'number') values.maturity = String(values.maturity);
      return { type: 'node', kind: e.kind, values };
    }
    const r = doc.relations.find((x) => x.id === id);
    if (r) return { type: 'edge', kind: r.kind, values: { ...r } };
    const column = id.startsWith('roadmap:') ? roadmapColumns(doc).find((c) => c.id === id) : undefined;
    if (column) return { type: 'node', kind: 'period', values: { name: column.title } };
    const cell = parseMatrixCell(doc, id);
    if (cell) {
      const relation = directSupport(doc, cell.capabilityId, cell.applicationId);
      return { type: 'node', kind: 'cell', values: { ...(relation ? { support: true } : {}), description: relation?.description ?? '' } };
    }
    if (id.startsWith('total:') && matrixScene(doc).nodes.has(id)) return { type: 'node', kind: 'total', values: {} };
    return undefined;
  },

  addNode(doc, kind, name, parentId) {
    const drawn: readonly string[] = ['capability', 'process', 'application', 'technology', 'unit', 'stream', 'stage', 'service'];
    if (!drawn.includes(kind)) return { ok: false, reason: `Tipo de elemento desconocido: ${kind}` };
    const k = kind as ElementKind;
    const id = uniqueId(name, indexElements(doc).keys());
    if (k === 'stage') return addStage(doc, id, name, parentId);
    const key = collection(k);
    const parentList = k === 'unit' ? doc.units : k === 'capability' ? doc.capabilities : [];
    const parent = parentId ? parentList.find((c) => c.id === parentId) : undefined;
    const created = { id, name, ...(parent ? { parentId: parent.id } : {}) };
    return { ok: true, id, document: { ...doc, [key]: [...(doc[key] as unknown[]), created] } };
  },

  addEdge(doc, kind, sourceId, targetId) {
    const reason = enterpriseEditor.canConnect?.(doc, kind, sourceId, targetId);
    if (reason) return { ok: false, reason };
    const all = indexElements(doc);
    const k = kind as RelationKind;
    const { reversed } = orient(k, all.get(sourceId)!.kind, all.get(targetId)!.kind)!;
    const [from, to] = reversed ? [targetId, sourceId] : [sourceId, targetId];
    const id = uniqueId(`${from}--${k}--${to}`, doc.relations.map((r) => r.id));
    return { ok: true, id, document: { ...doc, relations: [...doc.relations, { id, kind: k, sourceId: from, targetId: to }] } };
  },

  update(doc, id, patch) {
    const cell = parseMatrixCell(doc, id);
    if (cell) {
      let next = doc;
      if ('support' in patch) {
        const result = setSupport(next, cell, patch.support === true);
        if (!result.ok) return result;
        next = result.document;
      }
      if ('description' in patch) {
        const relation = directSupport(next, cell.capabilityId, cell.applicationId);
        const description = typeof patch.description === 'string' ? patch.description.trim() : '';
        if (!relation) return description ? { ok: false, reason: 'Marca primero que la aplicación soporta la capacidad: el criterio es la descripción de esa relación.' } : { ok: true, id, document: next };
        next = { ...next, relations: next.relations.map((r) => (r.id === relation.id ? patchObject(r, { description }, ['description']) : r)) };
      }
      return { ok: true, id, document: next };
    }
    const all = indexElements(doc);
    const e = all.get(id);
    if (e) {
      if (typeof patch.name === 'string' && patch.name.trim() === '') return { ok: false, reason: 'El nombre no puede estar vacío.' };
      const invalid = invalidValue(patch);
      if (invalid) return { ok: false, reason: invalid };
      if (typeof patch.ownerId === 'string' && patch.ownerId !== '' && all.get(patch.ownerId)?.kind !== 'unit') return { ok: false, reason: 'El responsable debe ser una unidad.' };
      if (e.kind === 'capability' && typeof patch.parentId === 'string' && patch.parentId !== '') {
        if (all.get(patch.parentId)?.kind !== 'capability') return { ok: false, reason: 'La capacidad padre debe ser otra capacidad.' };
        if (capabilitySubtree(doc, id).has(patch.parentId)) return { ok: false, reason: 'Una capacidad no puede colgar de sí misma ni de una de sus hijas.' };
      }
      if (e.kind === 'stage' && 'streamId' in patch && all.get(String(patch.streamId))?.kind !== 'stream') return { ok: false, reason: 'El flujo de valor de una etapa debe ser un flujo de valor.' };
      if (e.kind === 'unit' && typeof patch.parentId === 'string' && patch.parentId !== '') {
        if (all.get(patch.parentId)?.kind !== 'unit') return { ok: false, reason: 'La unidad padre debe ser otra unidad.' };
        if (unitSubtree(doc, id).has(patch.parentId)) return { ok: false, reason: 'Una unidad no puede colgar de sí misma ni de una de sus subunidades.' };
      }
      const key = collection(e.kind);
      return { ok: true, id, document: { ...doc, [key]: (doc[key] as Array<{ id: string }>).map((x) => (x.id === id ? patchObject(x, patch, PATCHABLE[e.kind]) : x)) } };
    }
    const r = doc.relations.find((x) => x.id === id);
    if (r) {
      const next = patchObject(r, patch, ['kind', 'description']);
      if (!(RELATION_KINDS as readonly string[]).includes(next.kind)) return { ok: false, reason: `Tipo de relación desconocido: ${String(next.kind)}` };
      if (next.kind !== r.kind && !orient(next.kind, all.get(r.sourceId)!.kind, all.get(r.targetId)!.kind)) {
        return { ok: false, reason: `«${RELATION_LABELS[next.kind]}» no admite ${KIND_LABELS[all.get(r.sourceId)!.kind].toLowerCase()} → ${KIND_LABELS[all.get(r.targetId)!.kind].toLowerCase()}.` };
      }
      const oriented = next.kind !== r.kind && orient(next.kind, all.get(r.sourceId)!.kind, all.get(r.targetId)!.kind)!.reversed ? { ...next, sourceId: r.targetId, targetId: r.sourceId } : next;
      return { ok: true, id, document: { ...doc, relations: doc.relations.map((x) => (x.id === id ? oriented : x)) } };
    }
    return { ok: false, reason: `No existe «${id}».` };
  },

  remove(doc, id) {
    const cell = parseMatrixCell(doc, id);
    if (cell) {
      const relation = directSupport(doc, cell.capabilityId, cell.applicationId);
      if (!relation) return { ok: false, reason: 'La celda no tiene una relación «soporta» directa que quitar: si la aplicación soporta la capacidad por un proceso, se quita en el paisaje.' };
      return { ok: true, document: { ...doc, relations: doc.relations.filter((r) => r.id !== relation.id) } };
    }
    if (id.startsWith('total:') && matrixScene(doc).nodes.has(id)) return { ok: false, reason: 'Los totales y la clave de colores se derivan de la matriz: no se borran.' };
    const e = indexElements(doc).get(id);
    if (e) {
      const gone = e.kind === 'capability' ? capabilitySubtree(doc, id) : e.kind === 'stream' ? new Set([id, ...doc.valueStages.filter((x) => x.streamId === id).map((x) => x.id)]) : new Set([id]);
      const strip = <T extends { id: string; ownerId?: string }>(items: T[]): T[] => items.filter((x) => !gone.has(x.id)).map((x) => (x.ownerId && gone.has(x.ownerId) ? withoutOwner(x) : x));
      const withoutOwner = <T extends { ownerId?: string }>(x: T): T => {
        const { ownerId: _gone, ...rest } = x;
        return rest as T;
      };
      return {
        ok: true,
        document: {
          ...doc,
          units: doc.units.filter((u) => !gone.has(u.id)).map((u) => (u.parentId && gone.has(u.parentId) ? (({ parentId: _p, ...rest }) => rest)(u) : u)),
          capabilities: strip(doc.capabilities),
          processes: strip(doc.processes),
          applications: strip(doc.applications),
          technologies: strip(doc.technologies),
          valueStreams: strip(doc.valueStreams),
          valueStages: doc.valueStages.filter((x) => !gone.has(x.id)),
          businessServices: strip(doc.businessServices),
          relations: doc.relations.filter((r) => !gone.has(r.sourceId) && !gone.has(r.targetId)),
        },
      };
    }
    if (doc.relations.some((r) => r.id === id)) return { ok: true, document: { ...doc, relations: doc.relations.filter((r) => r.id !== id) } };
    return { ok: false, reason: `No existe «${id}».` };
  },

  canConnect(doc, kind, sourceId, targetId) {
    if (!(RELATION_KINDS as readonly string[]).includes(kind)) return `Tipo de relación desconocido: ${kind}`;
    if (sourceId === targetId) return 'Una relación no puede unir un elemento consigo mismo.';
    const all = indexElements(doc);
    const s = all.get(sourceId);
    const t = all.get(targetId);
    if (!s || !t) return 'El origen o el destino no existe.';
    if (!orient(kind as RelationKind, s.kind, t.kind)) {
      const admitted = RELATION_RULES[kind as RelationKind].map(([a, b]) => `${KIND_LABELS[a].toLowerCase()} → ${KIND_LABELS[b].toLowerCase()}`).join(', ');
      return `«${RELATION_LABELS[kind as RelationKind]}» une ${admitted}; no ${KIND_LABELS[s.kind].toLowerCase()} con ${KIND_LABELS[t.kind].toLowerCase()}.`;
    }
    const k = kind as RelationKind;
    const { reversed } = orient(k, s.kind, t.kind)!;
    const [from, to] = reversed ? [targetId, sourceId] : [sourceId, targetId];
    if (doc.relations.some((r) => r.kind === k && r.sourceId === from && r.targetId === to)) return 'Esa relación ya existe.';
    return undefined;
  },
};
