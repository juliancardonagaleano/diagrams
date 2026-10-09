/**
 * Documento del módulo de arquitectura empresarial (un subconjunto pequeño de ArchiMate/TOGAF): unidades de la
 * organización, capacidades de negocio (jerárquicas), procesos, aplicaciones y tecnología, unidos por relaciones
 * tipadas. Cada aplicación y cada tecnología tiene un ciclo de vida, y las capacidades, la madurez y la importancia.
 * No guarda coordenadas: los diagramas se calculan al exportar.
 */
export const ENTERPRISE_DOCUMENT_VERSION = '1.0' as const;

/**
 * Tipos de elemento del modelo. Las unidades son la organización: responsables, no se dibujan en las vistas de relaciones.
 * Un flujo de valor (`stream`) es una cadena ordenada de etapas (`stage`) que se dibuja en su propia vista; un servicio de
 * negocio (`service`) es lo que la empresa ofrece a sus clientes apoyándose en procesos y capacidades.
 */
export const ELEMENT_KINDS = ['unit', 'capability', 'process', 'application', 'technology', 'stream', 'stage', 'service'] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];
/** Los que se dibujan en los diagramas. */
export type DrawnKind = 'capability' | 'process' | 'application' | 'technology';
export const DRAWN_KINDS: DrawnKind[] = ['capability', 'process', 'application', 'technology'];

export const LIFECYCLES = ['planned', 'active', 'sunset', 'retired'] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];

/** De menos a más crítica. */
export const CRITICALITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Criticality = (typeof CRITICALITIES)[number];
export const CRITICALITY_RANK: Record<Criticality, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** `differentiating` = da ventaja competitiva; `core` = imprescindible; `supporting` = de apoyo (o commodity). */
export const IMPORTANCES = ['differentiating', 'core', 'supporting'] as const;
export type Importance = (typeof IMPORTANCES)[number];

/** Qué hacer con una aplicación: conservarla, migrarla a otra plataforma, reemplazarla por otra o retirarla (las «4 R» de la modernización). */
export const STRATEGIES = ['keep', 'migrate', 'replace', 'retire'] as const;
export type Strategy = (typeof STRATEGIES)[number];

export const TECHNOLOGY_KINDS = ['platform', 'infrastructure', 'database', 'runtime', 'middleware', 'service'] as const;
export type TechnologyKind = (typeof TECHNOLOGY_KINDS)[number];

/**
 * - `supports`: una aplicación soporta una capacidad o un proceso.
 * - `realizes`: un proceso realiza una capacidad.
 * - `runs-on`: una aplicación se ejecuta sobre una tecnología.
 * - `depends-on`: una aplicación depende de otra, o una tecnología de otra.
 * - `composes`: composición; el todo (origen) se compone de la parte (destino): una aplicación de módulos, un proceso de subprocesos.
 * - `flows-to`: flujo de información o de trabajo de una aplicación a otra o de un proceso a otro.
 * - `assigned-to`: asignación; una unidad (origen) ejecuta un proceso (destino).
 * - `triggers`: disparo; un proceso (origen) pone en marcha a otro (destino).
 * - `enables`: una capacidad (origen) habilita una etapa de un flujo de valor (destino).
 * - `exposes`: un servicio de negocio (origen) expone a sus clientes un proceso o una capacidad (destino).
 */
export const RELATION_KINDS = ['supports', 'realizes', 'runs-on', 'depends-on', 'composes', 'flows-to', 'assigned-to', 'triggers', 'enables', 'exposes'] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

/** Pares (origen, destino) que admite cada tipo de relación. */
export const RELATION_RULES: Record<RelationKind, Array<[ElementKind, ElementKind]>> = {
  supports: [['application', 'capability'], ['application', 'process']],
  realizes: [['process', 'capability']],
  'runs-on': [['application', 'technology']],
  'depends-on': [['application', 'application'], ['technology', 'technology']],
  composes: [['application', 'application'], ['process', 'process'], ['technology', 'technology']],
  'flows-to': [['application', 'application'], ['process', 'process']],
  'assigned-to': [['unit', 'process']],
  triggers: [['process', 'process']],
  enables: [['capability', 'stage']],
  exposes: [['service', 'process'], ['service', 'capability']],
};

export const MATURITY_MIN = 1;
export const MATURITY_MAX = 5;

export interface Unit {
  id: string;
  name: string;
  description?: string;
  /** Unidad que la contiene (un equipo dentro de su dirección). */
  parentId?: string;
  external?: boolean;
}

export interface Capability {
  id: string;
  name: string;
  description?: string;
  /** Capacidad de la que forma parte: el mapa de capacidades es un árbol. */
  parentId?: string;
  /** Unidad responsable. Si no la declara, la hereda de su capacidad padre. */
  ownerId?: string;
  importance?: Importance;
  /** De 1 (inicial) a 5 (optimizada). */
  maturity?: number;
  tags?: string[];
}

export interface Process {
  id: string;
  name: string;
  description?: string;
  ownerId?: string;
  tags?: string[];
}

export interface Application {
  id: string;
  name: string;
  description?: string;
  /** Pila o producto (`SAP S/4HANA`, `Java + PostgreSQL`). La infraestructura sobre la que corre se modela con `runs-on`. */
  technology?: string;
  vendor?: string;
  /** Responsable de negocio. */
  ownerId?: string;
  /** Si no se indica, `active`. */
  lifecycle?: Lifecycle;
  criticality?: Criticality;
  /** Producto o servicio de un tercero (SaaS). */
  external?: boolean;
  /** Coste anual (licencias, soporte y operación), en la moneda del espacio de trabajo. */
  annualCost?: number;
  /** Personas que la usan. */
  users?: number;
  /** Qué se piensa hacer con ella (modernización). */
  strategy?: Strategy;
  /** Fin de soporte o retirada prevista (`2027-06` o `2027-06-30`); alimenta la hoja de ruta del ciclo de vida. */
  endOfLife?: string;
  /** Referencia a un elemento de otro módulo (`urn:iark:c4:tienda`). */
  ref?: string;
  /** Tipo del enlace que declara `ref` (vocabulario abierto; `depends-on` si falta): `implements`, `protects`… */
  refType?: string;
  tags?: string[];
}

export interface Technology {
  id: string;
  name: string;
  description?: string;
  /** Si no se indica, `platform`. */
  kind?: TechnologyKind;
  version?: string;
  ownerId?: string;
  /** Si no se indica, `active`. */
  lifecycle?: Lifecycle;
  /** Fin de soporte del fabricante (`2027-06` o `2027-06-30`). */
  endOfLife?: string;
  ref?: string;
  /** Tipo del enlace que declara `ref` (vocabulario abierto; `depends-on` si falta): `implements`, `protects`… */
  refType?: string;
  tags?: string[];
}

/** Cadena de valor de principio a fin, vista desde quien recibe el valor; sus etapas (`ValueStage`) van en el orden del documento. */
export interface ValueStream {
  id: string;
  name: string;
  description?: string;
  ownerId?: string;
  /** Quien recibe el valor (`Cliente de la tienda`). */
  stakeholder?: string;
  tags?: string[];
}

/** Etapa de un flujo de valor. Las capacidades que la habilitan se declaran con la relación `enables`. */
export interface ValueStage {
  id: string;
  name: string;
  description?: string;
  /** Flujo al que pertenece; el orden de las etapas de un flujo es el de este arreglo. */
  streamId: string;
  /** Valor que aporta la etapa (`pedido confirmado`). */
  value?: string;
  tags?: string[];
}

/** Servicio de negocio: lo que se ofrece a clientes; expone procesos y capacidades (relación `exposes`). */
export interface BusinessService {
  id: string;
  name: string;
  description?: string;
  ownerId?: string;
  /** A quién se ofrece (`Clientes particulares`). */
  audience?: string;
  tags?: string[];
}

export interface Relation {
  id: string;
  kind: RelationKind;
  sourceId: string;
  targetId: string;
  description?: string;
}

export interface EnterpriseDocument {
  version: typeof ENTERPRISE_DOCUMENT_VERSION;
  workspace: { name: string; description?: string };
  units: Unit[];
  capabilities: Capability[];
  processes: Process[];
  applications: Application[];
  technologies: Technology[];
  /** Opcionales (se completan con `[]`): flujos de valor, sus etapas y servicios de negocio. */
  valueStreams: ValueStream[];
  valueStages: ValueStage[];
  businessServices: BusinessService[];
  relations: Relation[];
}

export type Item = Unit | Capability | Process | Application | Technology | ValueStream | ValueStage | BusinessService;

/** Elemento del documento con su tipo. */
export interface Element {
  kind: ElementKind;
  id: string;
  name: string;
  item: Item;
}

export const KIND_LABELS: Record<ElementKind, string> = {
  unit: 'Unidad',
  capability: 'Capacidad',
  process: 'Proceso',
  application: 'Aplicación',
  technology: 'Tecnología',
  stream: 'Flujo de valor',
  stage: 'Etapa',
  service: 'Servicio de negocio',
};

export const LIFECYCLE_LABELS: Record<Lifecycle, string> = {
  planned: 'prevista',
  active: 'activa',
  sunset: 'en retirada',
  retired: 'retirada',
};

export const CRITICALITY_LABELS: Record<Criticality, string> = {
  low: 'baja',
  medium: 'media',
  high: 'alta',
  critical: 'crítica',
};

export const IMPORTANCE_LABELS: Record<Importance, string> = {
  differentiating: 'diferenciadora',
  core: 'esencial',
  supporting: 'de apoyo',
};

export const TECHNOLOGY_KIND_LABELS: Record<TechnologyKind, string> = {
  platform: 'Plataforma',
  infrastructure: 'Infraestructura',
  database: 'Base de datos',
  runtime: 'Entorno de ejecución',
  middleware: 'Middleware',
  service: 'Servicio',
};

export const STRATEGY_LABELS: Record<Strategy, string> = {
  keep: 'conservar',
  migrate: 'migrar',
  replace: 'reemplazar',
  retire: 'retirar',
};

export const RELATION_LABELS: Record<RelationKind, string> = {
  supports: 'soporta',
  realizes: 'realiza',
  'runs-on': 'se ejecuta en',
  'depends-on': 'depende de',
  composes: 'se compone de',
  'flows-to': 'fluye hacia',
  'assigned-to': 'ejecuta',
  triggers: 'dispara a',
  enables: 'habilita a',
  exposes: 'expone',
};

export const lifecycleOf = (x: { lifecycle?: Lifecycle }): Lifecycle => x.lifecycle ?? 'active';

/** Todos los elementos del documento por id (los ids son únicos entre tipos). */
export function indexElements(doc: EnterpriseDocument): Map<string, Element> {
  const map = new Map<string, Element>();
  const add = (kind: ElementKind, items: Item[]): void => {
    for (const item of items) if (!map.has(item.id)) map.set(item.id, { kind, id: item.id, name: item.name, item });
  };
  add('unit', doc.units);
  add('capability', doc.capabilities);
  add('process', doc.processes);
  add('application', doc.applications);
  add('technology', doc.technologies);
  add('stream', doc.valueStreams);
  add('stage', doc.valueStages);
  add('service', doc.businessServices);
  return map;
}

/** Tipo de relación que une dos tipos de elemento, si lo hay (en cualquiera de los dos sentidos). */
export function relationBetween(a: ElementKind, b: ElementKind): { kind: RelationKind; reversed: boolean } | undefined {
  // Solo los tipos estructurales: una flecha entre dos elementos del mismo tipo sigue significando «depende de» al importar.
  for (const kind of [...RELATION_KINDS.slice(0, 4), 'enables', 'exposes'] as const) {
    for (const [from, to] of RELATION_RULES[kind]) {
      if (from === a && to === b) return { kind, reversed: false };
      if (from === b && to === a) return { kind, reversed: true };
    }
  }
  return undefined;
}

/**
 * Sentido en que se dibuja una relación: de quien se apoya a aquello en lo que se apoya (capacidad → aplicación que la
 * soporta → tecnología en la que corre). Coincide con la dirección de la dependencia, salvo `supports` y `realizes`,
 * que en el modelo van de la aplicación (o el proceso) a lo que soportan, y `enables` (la capacidad habilita a la etapa, que se apoya en ella).
 */
export function drawnEnds(r: Relation): { from: string; to: string } {
  return r.kind === 'supports' || r.kind === 'realizes' || r.kind === 'enables' ? { from: r.targetId, to: r.sourceId } : { from: r.sourceId, to: r.targetId };
}

/**
 * Extremos de una relación como dependencia (de quien depende a aquello de lo que depende), para el análisis de impacto.
 * Como `drawnEnds`, salvo el flujo y el disparo: quien recibe depende de quien envía o dispara.
 */
export function dependencyEnds(r: Relation): { from: string; to: string } {
  return r.kind === 'flows-to' || r.kind === 'triggers' ? { from: r.targetId, to: r.sourceId } : drawnEnds(r);
}
