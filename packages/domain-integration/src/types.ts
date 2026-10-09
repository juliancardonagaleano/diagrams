/**
 * Documento del módulo de integraciones: un grafo de nodos (sistemas, APIs, servidores MCP, pasarelas, brokers, colas,
 * tópicos, almacenes, conectores, tareas programadas, usuarios y nodos de patrón EIP) unidos por interacciones con estilo,
 * protocolo, patrón, contrato y orden, más flujos (secuencias ordenadas de interacciones). Los contratos (OpenAPI, .proto,
 * CloudEvents, MCP…) llevan su contenido y son la metadata de las figuras. No guarda coordenadas: los diagramas se calculan
 * al exportar.
 */
export const INTEGRATION_DOCUMENT_VERSION = '1.0' as const;

export const NODE_KINDS = ['system', 'api', 'gateway', 'broker', 'queue', 'topic', 'store', 'connector', 'scheduler', 'user', 'mcp', 'pattern'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const INTERACTION_STYLES = ['request-response', 'async-message', 'event', 'batch', 'stream'] as const;
export type InteractionStyle = (typeof INTERACTION_STYLES)[number];

/** Patrones de integración empresarial (EIP) y de resiliencia más habituales. */
export const PATTERNS = [
  'content-based-router',
  'message-translator',
  'splitter',
  'aggregator',
  'filter',
  'enricher',
  'publish-subscribe',
  'polling-consumer',
  'idempotent-receiver',
  'dead-letter-channel',
  'saga',
  'circuit-breaker',
  'wire-tap',
  'claim-check',
  'scatter-gather',
  'resequencer',
  'transactional-outbox',
  'retry',
] as const;
export type IntegrationPattern = (typeof PATTERNS)[number];

/**
 * `protobuf` es el `.proto` de gRPC; `cloudevents` es un evento en estructura CloudEvents 1.0 (JSON); `mcp` es el JSON de un
 * servidor MCP (herramientas, recursos y prompts).
 */
export const CONTRACT_FORMATS = ['openapi', 'asyncapi', 'graphql', 'protobuf', 'avro', 'json-schema', 'wsdl', 'cloudevents', 'mcp', 'other'] as const;
export type ContractFormat = (typeof CONTRACT_FORMATS)[number];

export const CRITICALITIES = ['low', 'medium', 'high'] as const;
export type Criticality = (typeof CRITICALITIES)[number];

export interface IntegrationNode {
  id: string;
  kind: NodeKind;
  name: string;
  description?: string;
  technology?: string;
  owner?: string;
  external?: boolean;
  /** Nodo que lo contiene: una cola o tópico dentro de su broker, una API dentro de su sistema. */
  parentId?: string;
  /** Referencia a un elemento de otro módulo (`urn:iark:c4:tienda`). */
  ref?: string;
  /** Tipo del enlace que declara `ref` (vocabulario abierto; `depends-on` si falta): `implements`, `protects`… */
  refType?: string;
  tags?: string[];
  /** Contrato que describe este nodo (la OpenAPI de una API, el JSON de un servidor MCP, el evento de un tópico…). */
  contractId?: string;
  /** Solo en nodos `pattern`: el patrón EIP que aplica. */
  pattern?: IntegrationPattern;
  /**
   * Zona (equipo o dominio) en la que se dibuja. Los nodos con el mismo valor comparten zona; un nodo con padre sigue a su
   * padre.
   */
  domain?: string;
}

export interface Contract {
  id: string;
  name: string;
  format: ContractFormat;
  version?: string;
  url?: string;
  description?: string;
  /** Texto del contrato (el JSON de CloudEvents o MCP, el `.proto`, la OpenAPI…). Se edita en la pestaña Contratos. */
  content?: string;
}

export interface Interaction {
  id: string;
  sourceId: string;
  targetId: string;
  style: InteractionStyle;
  protocol?: string;
  pattern?: IntegrationPattern;
  contractId?: string;
  description?: string;
  dataObjects?: string[];
  criticality?: Criticality;
  /**
   * Lugar en la secuencia. Cada vista numera (1, 2, 3…) las interacciones que lo tienen, por orden creciente; el valor en
   * sí solo ordena, así que se puede dejar hueco (10, 20, 30). En un flujo manda el orden de sus pasos.
   */
  order?: number;
}

export interface FlowStep {
  interactionId: string;
  note?: string;
}

export interface Flow {
  id: string;
  name: string;
  description?: string;
  steps: FlowStep[];
}

export interface IntegrationDocument {
  version: typeof INTEGRATION_DOCUMENT_VERSION;
  workspace: { name: string; description?: string };
  nodes: IntegrationNode[];
  contracts: Contract[];
  interactions: Interaction[];
  flows: Flow[];
}

/** Tipos de nodo que pueden ser padre de cada tipo: solo un broker o una pasarela contiene colas y tópicos. */
export const PARENT_KINDS: Partial<Record<NodeKind, NodeKind[]>> = {
  queue: ['broker', 'gateway'],
  topic: ['broker', 'gateway'],
  api: ['system'],
  mcp: ['system'],
};

export const KIND_LABELS: Record<NodeKind, string> = {
  system: 'Sistema',
  api: 'API',
  gateway: 'Pasarela',
  broker: 'Broker',
  queue: 'Cola',
  topic: 'Tópico',
  store: 'Almacén',
  connector: 'Conector',
  scheduler: 'Tarea programada',
  user: 'Usuario final',
  mcp: 'Servidor MCP',
  pattern: 'Patrón',
};

/** Nodos que existen para transportar mensajes: una cola o un tópico. */
export const CHANNEL_KINDS: readonly NodeKind[] = ['queue', 'topic'];
