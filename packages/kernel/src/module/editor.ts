/**
 * Descriptor de edición interactiva de un módulo (`DomainModule.editor`). Lo comparten los cinco diagramadores: cada módulo
 * declara su notación (figuras, colores, tipos de relación), cómo proyectar su documento a un grafo dibujable, qué campos
 * tiene cada tipo y qué operaciones lo modifican; el lienzo, la barra de herramientas, el panel de propiedades, los atajos
 * y el deshacer son comunes y no conocen ningún dominio.
 */

import type { GraphLayout } from '../graph/layout';
import type { ShapeKind } from '../graph/shapes';
import type { EdgeEnd, EdgeMark } from '../graph/svg';

export type { ShapeKind } from '../graph/shapes';
export type { EdgeEnd, EdgeMark } from '../graph/svg';

export type LineKind = 'solid' | 'dashed' | 'dotted';

export interface NodeNotation {
  /** Tipo del módulo (`queue`, `table`…). */
  kind: string;
  label: string;
  /** Carácter o emoji corto para la paleta. */
  glyph: string;
  shape: ShapeKind;
  fill: string;
  stroke?: string;
  width: number;
  height: number;
  /** Si el tipo se ofrece en la paleta (por defecto sí). */
  addable?: boolean;
  /** Se dibuja siempre como zona (aunque no tenga hijos): una celda vacía de una matriz donde se pueden soltar elementos. */
  container?: boolean;
  /** Se dibuja sin la clase del tipo sobre el título ni puntos de conexión (una celda o un total de una matriz): solo el texto, centrado. */
  bare?: boolean;
  /** Icono del tipo en la esquina del nodo: trazados de una caja de 16 × 16 (como `EdgeMark.icon`). */
  icon?: string[];
}

export interface EdgeNotation {
  kind: string;
  label: string;
  /**
   * Si el tipo se ofrece en el selector de relaciones de la barra (por defecto sí). `false` para un tipo derivado que el módulo
   * dibuja pero no se crea a mano (la relación implícita de C4, que sube hasta el ancestro visible).
   */
  addable?: boolean;
  stroke: string;
  line?: LineKind;
  width?: number;
  /** Punta de flecha en el origen (p. ej. petición-respuesta). */
  arrowStart?: boolean;
  arrowEnd?: boolean;
  /** Adorno en el origen de la línea: rombo (composición) o punto (asignación). */
  tail?: 'diamond' | 'dot';
  /** Punta de flecha: `open` es una «V» sin relleno (por defecto, triángulo relleno). */
  head?: 'open';
}

export interface EditorNode {
  id: string;
  kind: string;
  label: string;
  /** Figura propia del nodo, en lugar de la de su tipo (un contenedor C4 que es una base de datos o un navegador). */
  shape?: ShapeKind;
  /** Segunda línea: tecnología, responsable… */
  sublabel?: string;
  /** Nodo contenedor: si también está en el grafo, este se dibuja como grupo. */
  parentId?: string;
  /** Referencia a un elemento de otro módulo (`urn:iark:<módulo>:<id>`): el lienzo la muestra como enlace navegable. */
  ref?: string;
  /** Insignias pequeñas sobre el nodo (patrón, criticidad, clasificación…). */
  badges?: string[];
  /** Borde discontinuo (p. ej. un sistema externo). */
  dashed?: boolean;
  /** Trazo del borde de un nodo que se dibuja como zona (por defecto discontinuo): una red pública, continua; una aislada, punteada. */
  border?: 'solid' | 'dashed' | 'dotted';
  /** Color que sustituye al de la notación (p. ej. clasificación de un dato). */
  fill?: string;
  /** Borde que sustituye al de la notación (p. ej. rojo para un dato restringido). */
  stroke?: string;
  /** Líneas de detalle bajo el título, alineadas a la izquierda (las columnas de una tabla, los atributos de una entidad). */
  lines?: string[];
  /** Énfasis de cada línea de `lines`, por posición: `key` (negrita, p. ej. una clave primaria) o `ref` (acento, p. ej. una clave foránea). */
  lineEmphasis?: Array<'key' | 'ref' | undefined>;
  /** Tamaño que sustituye al de la notación (p. ej. una ficha crece con sus columnas). */
  width?: number;
  height?: number;
  /**
   * Icono propio del nodo (trazados de una caja de 16 × 16), en lugar del de su tipo: p. ej. el servicio de una nube. Con
   * `iconColor` se dibuja como una ficha blanca con ese color de acento que cabalga sobre la esquina del nodo (arriba a la
   * izquierda; arriba a la derecha en una zona).
   */
  icon?: string[];
  iconColor?: string;
}

export interface EditorEdge {
  id: string;
  kind: string;
  source: string;
  target: string;
  label?: string;
  badges?: string[];
  /** Insignias gráficas sobre la línea: el número de paso, el icono de un patrón… (se dibujan antes que la etiqueta). */
  marks?: EdgeMark[];
  /** Remates de pata de gallo en los extremos (modelo entidad-relación); sustituyen a la punta de flecha. */
  ends?: { source?: EdgeEnd; target?: EdgeEnd };
  /** Textos escritos junto a cada extremo de la línea (las multiplicidades `1` y `0..*` de la notación UML). */
  endLabels?: { source?: string; target?: string };
  /** Grosor que sustituye al de la notación (p. ej. criticidad alta). */
  width?: number;
}

/** Leyenda de los colores de una vista (p. ej. el criterio de color de un mapa de capacidades). */
export interface EditorLegend {
  title: string;
  items: Array<{ label: string; color: string }>;
}

export interface EditorGraph {
  nodes: EditorNode[];
  edges: EditorEdge[];
  /** Leyenda que el lienzo dibuja sobre la vista. */
  legend?: EditorLegend;
}

export type FieldSpec =
  | { key: string; label: string; type: 'text' | 'longtext' | 'boolean'; hint?: string }
  | { key: string; label: string; type: 'number'; hint?: string; min?: number; step?: number }
  | {
      key: string;
      label: string;
      type: 'select';
      options: Array<{ value: string; label: string }>;
      hint?: string;
      allowEmpty?: boolean;
      /** El valor es el id de un adjunto (`EditorSpec.attachments`): el panel de propiedades ofrece abrirlo en su editor o crear uno nuevo. */
      opensAttachment?: boolean;
    }
  | { key: string; label: string; type: 'list'; hint?: string };

/**
 * Qué se está editando: un nodo o una relación de cierto tipo. De una relación que existe en el documento el panel de propiedades
 * añade su id y sus extremos, por si los campos dependen de a qué une (las columnas del activo al que apunta un enlace); un módulo que
 * no los necesita no los lee, y quien pide los campos de un tipo sin tener una relación delante (`{ type, kind }`) sigue pudiendo.
 */
export interface EditorTarget {
  type: 'node' | 'edge';
  kind: string;
  /** Solo en una relación: su id en el grafo. */
  id?: string;
  /** Solo en una relación: el elemento del que sale y al que llega. */
  source?: string;
  target?: string;
}

/**
 * Resultado de una operación. `id` es el elemento que queda seleccionado; `view` pide al lienzo que abra esa vista (bajar al
 * detalle de un sistema C4, subir de nivel…). Una operación que solo navega devuelve el mismo `document` que recibió: el lienzo
 * no lo registra como edición (no ensucia el historial de deshacer).
 */
export type EditResult<TDoc> = { ok: true; document: TDoc; id?: string; view?: string } | { ok: false; reason: string };

/**
 * Operación del módulo sobre la selección actual (p. ej. «Agrupar en dominio»). El lienzo las ofrece en su barra de
 * herramientas; `needs` dice cuántos elementos tienen que estar seleccionados para que el botón esté activo.
 */
export interface EditorAction<TDoc> {
  id: string;
  label: string;
  hint?: string;
  /** `none`: no usa la selección; `one`: exactamente un elemento; `many`: uno o más. */
  needs: 'none' | 'one' | 'many';
  /**
   * Si se pide un texto antes de ejecutarla (el nombre del dominio); `suggestions` propone valores ya usados. `viewId` es la vista
   * abierta, por si lo propuesto depende de ella (los elementos del modelo que aún no están en la vista).
   */
  prompt?: { label: string; placeholder?: string; initial?(document: TDoc, ids: string[], viewId?: string): string; suggestions?(document: TDoc, viewId?: string): string[] };
  /** Motivo por el que no se puede ejecutar con esta selección, o `undefined` si se puede. */
  disabled?(document: TDoc, ids: string[], viewId?: string): string | undefined;
  run(document: TDoc, ids: string[], input?: string, viewId?: string): EditResult<TDoc>;
  /**
   * Atajo de teclado cuando no hay otro significado para él: `alt+down` (Alt+↓) la lanza si el elemento seleccionado no enlaza con
   * otro módulo (si enlaza, Alt+↓ sigue el enlace); `alt+up` (Alt+↑), si no hay un diagrama al que volver. Es como C4 baja y sube de nivel.
   */
  shortcut?: 'alt+down' | 'alt+up';
}

export type AttachmentLanguage = 'json' | 'yaml' | 'proto' | 'graphql' | 'xml' | 'text';

export interface AttachmentFormat {
  id: string;
  label: string;
  language: AttachmentLanguage;
  /** Extensión de archivo al descargarlo (`.proto`, `.json`…). */
  extension: string;
  description?: string;
}

export interface AttachmentDiagnostic {
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** Línea y columna (desde 1) si se conocen. */
  line?: number;
  column?: number;
}

export type AttachmentTextResult = { ok: true; text: string } | { ok: false; reason: string };

export interface AttachmentInfo {
  id: string;
  name: string;
  format: string;
  version?: string;
  /** Cuántos elementos del documento lo usan. */
  uses: number;
}

export interface AttachmentDetail extends AttachmentInfo {
  description?: string;
  url?: string;
  /** Contenido editable. */
  text: string;
  /** Elementos del documento que lo usan (nodos y relaciones), para saltar a ellos. */
  usedBy: Array<{ id: string; name: string; kind: string }>;
}

/** Conversión de un adjunto a otro formato o forma (p. ej. JSON ↔ YAML); sustituye el texto. */
export interface AttachmentTransform {
  id: string;
  label: string;
  /** Formatos a los que se ofrece; si falta, a todos. */
  formats?: string[];
  run(text: string, context: { name: string; format: string }): AttachmentTextResult;
}

/**
 * Documentos de texto con editor propio que cuelgan del documento del módulo y se asocian a sus elementos: los contratos
 * de una integración (OpenAPI, .proto, CloudEvents, MCP…). El banco de trabajo los lista en una pestaña, valida y formatea
 * su contenido y deja crear uno desde el panel de propiedades de un elemento; no sabe de qué dominio son.
 */
export interface AttachmentSpec<TDoc> {
  /** Título de la pestaña en plural y nombre en singular («Contratos» / «contrato»). */
  label: string;
  singular: string;
  formats: AttachmentFormat[];
  list(document: TDoc): AttachmentInfo[];
  read(document: TDoc, id: string): AttachmentDetail | undefined;
  /** Problemas del contenido para ese formato (sintaxis y reglas del formato). `context` dice de qué adjunto del documento es el texto, por si la validación depende de lo que lo usa (el motor de la base de datos). */
  check(format: string, text: string, context?: { document: TDoc; id: string }): AttachmentDiagnostic[];
  /** Reescribe el contenido en su forma canónica; falla si el texto no se puede interpretar. */
  reformat(format: string, text: string, context: { name: string }): AttachmentTextResult;
  /** Contenido inicial de un adjunto nuevo. */
  template(format: string, name: string): string;
  /** Resumen legible del contenido (operaciones, mensajes, herramientas…). */
  summary?(format: string, text: string): string[];
  transforms?: AttachmentTransform[];
  /**
   * Valores que se pueden insertar en el texto (los tipos de columna del motor de la base de datos): el panel los ofrece bajo el
   * editor y la elegida se escribe en el cursor. `title` los nombra («Tipos de PostgreSQL»).
   */
  suggestions?(document: TDoc, id: string, text: string): { title: string; items: string[] } | undefined;
  add(document: TDoc, format: string, name: string): EditResult<TDoc>;
  update(document: TDoc, id: string, patch: { name?: string; format?: string; version?: string; description?: string; url?: string; text?: string }): EditResult<TDoc>;
  remove(document: TDoc, id: string): EditResult<TDoc>;
  /** Crea un adjunto del formato que mejor encaja con el elemento `targetId` y se lo asigna; `id` es el del adjunto nuevo. */
  createFor?(document: TDoc, targetId: string): EditResult<TDoc>;
  /** Formato recomendado para un elemento (para ofrecer «Nuevo contrato (OpenAPI)»). */
  suggestFormat?(document: TDoc, targetId: string): string | undefined;
}

export interface EditorSpec<TDoc> {
  nodeKinds: NodeNotation[];
  edgeKinds: EdgeNotation[];
  /** Tipo de relación que se crea al arrastrar de un nodo a otro sin elegir (por defecto, el primero de `edgeKinds`). */
  defaultEdgeKind?: string;
  /** Grafo de la vista `viewId` (si no se indica, la primera). */
  project(document: TDoc, viewId?: string): EditorGraph;
  /** Campos editables de un tipo. `values` son los del elemento que se edita, por si las opciones de un campo dependen de otro (el servicio, del proveedor). */
  fields(target: EditorTarget, document: TDoc, values?: Record<string, unknown>): FieldSpec[];
  /** Valores actuales de un nodo o relación, para el formulario. */
  read(document: TDoc, id: string): { type: 'node' | 'edge'; kind: string; values: Record<string, unknown> } | undefined;
  /** `parentId` es el contenedor seleccionado (si encaja); `viewId`, la vista abierta (p. ej. para crear el recurso en el entorno que se está viendo). */
  addNode(document: TDoc, kind: string, name: string, parentId?: string, viewId?: string): EditResult<TDoc>;
  addEdge(document: TDoc, kind: string, sourceId: string, targetId: string): EditResult<TDoc>;
  update(document: TDoc, id: string, patch: Record<string, unknown>): EditResult<TDoc>;
  /** Borra un nodo o relación y lo que dependa de él. */
  remove(document: TDoc, id: string): EditResult<TDoc>;
  /** Explica por qué no se puede unir ese origen con ese destino con ese tipo de relación en la vista `viewId`; `undefined` si se puede. */
  canConnect?(document: TDoc, kind: string, sourceId: string, targetId: string, viewId?: string): string | undefined;
  /**
   * Colocación propia de una vista (p. ej. la cuadrícula anidada de un mapa de capacidades). Si devuelve `undefined`, el
   * lienzo aplica el autolayout común por capas. `options.fresh` lo pide el botón Autolayout: recalcular la colocación
   * aunque el documento ya guarde posiciones (C4 las guarda en cada vista y, sin él, las respeta).
   */
  layout?(document: TDoc, viewId?: string, options?: { fresh?: boolean }): GraphLayout | undefined | Promise<GraphLayout | undefined>;
  /**
   * Camino de vistas que lleva hasta `viewId`, de la más general a la abierta (C4: «C1 Contexto › C2 Contenedores › C3
   * Componentes»). Si tiene más de una, el lienzo la muestra sobre el diagrama y cada tramo abre su vista. Sin él, o con una
   * sola, no se muestra nada.
   */
  breadcrumb?(document: TDoc, viewId?: string): Array<{ id: string; label: string }>;
  /**
   * Doble clic sobre el nodo `id`: operación propia del módulo (p. ej. marcar o desmarcar una celda de una matriz). `undefined`
   * si no significa nada: entonces el doble clic sigue el enlace del elemento, si lo tiene.
   */
  activate?(document: TDoc, id: string, viewId?: string): EditResult<TDoc> | undefined;
  /**
   * Soltar el nodo `id` sobre `targetId` (el elemento más pequeño que contiene su centro; nunca él mismo ni un descendiente):
   * p. ej. arrastrar una amenaza a otra celda de la matriz de calor cambia su probabilidad e impacto. `undefined` si soltarlo
   * ahí no significa nada (el nodo se queda donde se dejó); un fallo se avisa y el nodo vuelve a su sitio. Si tiene efecto, el
   * lienzo descarta las posiciones fijadas a mano para que la vista se recoloque y selecciona el `id` del resultado (el nodo
   * arrastrado o, si lo que se arrastró pasa a otro sitio, como una celda de la matriz capacidad × aplicación, el destino).
   */
  drop?(document: TDoc, id: string, targetId: string, viewId?: string): EditResult<TDoc> | undefined;
  /** Operaciones sobre la selección (la barra del lienzo las muestra tras los botones de edición). */
  actions?: Array<EditorAction<TDoc>>;
  /** Documentos de texto asociados a los elementos, con su propio editor (los contratos de una integración). */
  attachments?: AttachmentSpec<TDoc>;
}

/** Id nuevo y único con la forma `base`, `base-2`, `base-3`… */
export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const slug =
    base
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'nuevo';
  if (!used.has(slug)) return slug;
  for (let n = 2; ; n++) if (!used.has(`${slug}-${n}`)) return `${slug}-${n}`;
}
