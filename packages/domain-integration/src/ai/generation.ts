import type { AiSpec } from '@iark/kernel';
import { z } from 'zod';
import { formatIntegrationIssues, validateIntegrationDocument } from '../schema';
import { PATTERN_INFO } from '../patterns';
import { CONTRACT_FORMATS, CRITICALITIES, INTEGRATION_DOCUMENT_VERSION, INTERACTION_STYLES, NODE_KINDS, PATTERNS, type IntegrationDocument } from '../types';

// Lo que produce el modelo: todos los campos presentes (null si no aplican), como exige la salida estructurada.
const nullable = <T extends z.ZodType>(t: T) => t.nullable();

const generatedNode = z.object({
  id: z.string(),
  kind: z.enum(NODE_KINDS),
  name: z.string(),
  description: nullable(z.string()),
  technology: nullable(z.string()),
  owner: nullable(z.string()),
  external: nullable(z.boolean()),
  parentId: nullable(z.string()),
  contractId: nullable(z.string()),
  pattern: nullable(z.enum(PATTERNS)),
  domain: nullable(z.string()),
});

// Sin `content`: el texto de un contrato es demasiado grande para el modelo y se edita a mano.
const generatedContract = z.object({
  id: z.string(),
  name: z.string(),
  format: z.enum(CONTRACT_FORMATS),
  version: nullable(z.string()),
  url: nullable(z.string()),
  description: nullable(z.string()),
});

const generatedInteraction = z.object({
  id: z.string(),
  sourceId: z.string(),
  targetId: z.string(),
  style: z.enum(INTERACTION_STYLES),
  protocol: nullable(z.string()),
  pattern: nullable(z.enum(PATTERNS)),
  contractId: nullable(z.string()),
  description: nullable(z.string()),
  dataObjects: nullable(z.array(z.string())),
  criticality: nullable(z.enum(CRITICALITIES)),
  order: nullable(z.number()),
});

const generatedFlow = z.object({
  id: z.string(),
  name: z.string(),
  description: nullable(z.string()),
  steps: z.array(z.object({ interactionId: z.string(), note: nullable(z.string()) })),
});

export const generatedIntegrationSchema = z.object({
  workspace: z.object({ name: z.string(), description: nullable(z.string()) }),
  nodes: z.array(generatedNode),
  contracts: z.array(generatedContract),
  interactions: z.array(generatedInteraction),
  flows: z.array(generatedFlow),
});

export type GeneratedIntegration = z.infer<typeof generatedIntegrationSchema>;

/** Quita los `null` que exige la salida estructurada: el documento usa campos ausentes. */
function dropNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map(dropNulls) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => [k, dropNulls(v)])) as T;
  }
  return value;
}

export function generatedToIntegration(generated: GeneratedIntegration): { ok: true; document: IntegrationDocument } | { ok: false; issues: string } {
  const result = validateIntegrationDocument({ version: INTEGRATION_DOCUMENT_VERSION, ...dropNulls(generated) });
  return result.ok ? result : { ok: false, issues: formatIntegrationIssues(result.issues) };
}

export function generationJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(generatedIntegrationSchema, { target: 'draft-2020-12' }) as Record<string, unknown>;
}

export function systemPrompt(): string {
  const patterns = PATTERNS.map((p) => `  - ${p}: ${PATTERN_INFO[p].label}`).join('\n');
  return `Eres un arquitecto de integraciones experto en integración de aplicaciones, APIs, mensajería y patrones de
integración empresarial (EIP). Tu tarea es convertir una descripción en lenguaje natural en un modelo de integración
estructurado en JSON. NO produces coordenadas: el diagramador coloca los nodos después. Concéntrate en el modelo.

Nodos (kind):
- "system": aplicación o sistema (interno, o externo si es de terceros: external = true).
- "api": interfaz expuesta por un sistema; su parentId es el id del sistema que la expone.
- "mcp": servidor MCP (Model Context Protocol) que un sistema expone para que agentes de IA usen sus herramientas,
  recursos y prompts; su parentId es el id del sistema que lo expone.
- "gateway": pasarela de APIs, ESB o proxy de integración. También puede alojar colas y tópicos.
- "broker": plataforma de mensajería (Kafka, RabbitMQ, Service Bus…).
- "queue" / "topic": cola punto a punto / tópico de publicación-suscripción. Su parentId es el id del
  broker O de la pasarela que los aloja.
- "store": base de datos, almacén de ficheros o bucket que forma parte de la integración.
- "connector": conector o adaptador que adapta un sistema o un almacén a un canal (Kafka Connect, captura de cambios,
  adaptador de ficheros…); va entre el sistema o almacén y la cola o el tópico.
- "scheduler": tarea programada (cron, planificador de lotes). Solo es origen: dispara interacciones.
- "user": usuario final o persona. Solo es origen: inicia peticiones.
- "pattern": nodo de patrón EIP (enrutador, traductor, agregador…), un intermediario entre un origen y un destino. Su
  campo "pattern" es obligatorio; ningún otro tipo de nodo lleva "pattern".
- Solo queue y topic (de un broker o una pasarela), api y mcp (de un sistema) pueden tener parentId; los demás lo dejan
  en null. Ids únicos en kebab-case ASCII.
- owner: equipo o persona responsable, si se menciona.
- domain: zona (equipo o dominio, p. ej. "Ventas") en la que se dibuja el nodo, solo si la descripción menciona equipos
  o dominios. Los nodos del mismo dominio llevan exactamente el mismo texto; los que tienen parentId siguen a su padre,
  así que déjalo en null en ellos.
- contractId: id del contrato que describe el nodo (la OpenAPI de una API, el JSON de un servidor MCP, el evento de un
  tópico).

Patrones (campo "pattern" de un nodo "pattern" o de una interacción):
${patterns}

Interacciones (siempre origen → destino, quien inicia la comunicación es el origen):
- style: "request-response" (llamada síncrona), "async-message" (mensaje por cola), "event" (evento publicado),
  "batch" (carga por lotes o ficheros), "stream" (flujo continuo).
- protocol: REST, gRPC, SOAP, AMQP, Kafka, SFTP, JDBC… si es evidente; null en otro caso.
- pattern: solo si la descripción lo implica. En una interacción marca el patrón sobre la línea (circuit-breaker,
  retry, wire-tap…); si el patrón es un paso con identidad propia que recibe y reenvía (un enrutador, un traductor, un
  agregador), modélalo como nodo "pattern" y no lo repitas en la interacción.
- Un almacén nunca es origen: solo recibe lecturas y escrituras de quien lo usa. Una tarea programada y un usuario final
  solo son origen.
- Un productor publica EN la cola o tópico (origen = productor, destino = cola/tópico) y un consumidor lee DE ella
  (origen = cola/tópico, destino = consumidor). No enlaces productor y consumidor directamente a través de un broker ni
  conectes un canal con otro directamente: entre dos canales va un conector, un patrón o un sistema.
- order: lugar en la secuencia (1, 2, 3…) cuando la descripción narra pasos ordenados; null en otro caso.
- contractId: id del contrato (OpenAPI, AsyncAPI, Avro, Protobuf, CloudEvents, MCP…) si se mencionan; declara el
  contrato en "contracts" con su formato y versión, sin su contenido.
- criticality según el impacto de negocio si se indica. Nunca crees interacciones de un nodo consigo mismo.

Flujos: cuando la descripción narre un proceso paso a paso (p. ej. "un pedido…"), crea un flujo con sus pasos, cada uno
apuntando a una interacción existente y en el orden en que ocurren.

Responde en el idioma de la instrucción del usuario (nombres, descripciones). Sé concreto y no inventes nodos que la
descripción no justifique.`;
}

export function toGenerated(doc: IntegrationDocument): GeneratedIntegration {
  const n = <T,>(v: T | undefined): T | null => v ?? null;
  return {
    workspace: { name: doc.workspace.name, description: n(doc.workspace.description) },
    nodes: doc.nodes.map((x) => ({ id: x.id, kind: x.kind, name: x.name, description: n(x.description), technology: n(x.technology), owner: n(x.owner), external: n(x.external), parentId: n(x.parentId), contractId: n(x.contractId), pattern: n(x.pattern), domain: n(x.domain) })),
    contracts: doc.contracts.map((c) => ({ id: c.id, name: c.name, format: c.format, version: n(c.version), url: n(c.url), description: n(c.description) })),
    interactions: doc.interactions.map((i) => ({
      id: i.id,
      sourceId: i.sourceId,
      targetId: i.targetId,
      style: i.style,
      protocol: n(i.protocol),
      pattern: n(i.pattern),
      contractId: n(i.contractId),
      description: n(i.description),
      dataObjects: n(i.dataObjects),
      criticality: n(i.criticality),
      order: n(i.order),
    })),
    flows: doc.flows.map((f) => ({ id: f.id, name: f.name, description: n(f.description), steps: f.steps.map((s) => ({ interactionId: s.interactionId, note: n(s.note) })) })),
  };
}

const GENERATED_KEYS = {
  nodes: new Set(Object.keys(generatedNode.shape)),
  contracts: new Set(Object.keys(generatedContract.shape)),
  interactions: new Set(Object.keys(generatedInteraction.shape)),
  flows: new Set(Object.keys(generatedFlow.shape)),
};

/**
 * Al refinar con IA, devuelve `generated` con lo que el modelo no produce (el texto de los contratos, las etiquetas y
 * las URN de los nodos…) tomado de `base` para los ids que siguen existiendo. Lo que el modelo sí produce manda siempre.
 */
export function carryIntegration(base: IntegrationDocument, generated: IntegrationDocument): IntegrationDocument {
  const carry = <T extends { id: string }>(collection: keyof typeof GENERATED_KEYS, before: T[], after: T[]): T[] => {
    const previous = new Map(before.map((item) => [item.id, item]));
    return after.map((item) => {
      const kept = Object.entries(previous.get(item.id) ?? {}).filter(([key]) => !GENERATED_KEYS[collection].has(key) && (item as Record<string, unknown>)[key] === undefined);
      return kept.length > 0 ? { ...item, ...Object.fromEntries(kept) } : item;
    });
  };
  return {
    ...generated,
    nodes: carry('nodes', base.nodes, generated.nodes),
    contracts: carry('contracts', base.contracts, generated.contracts),
    interactions: carry('interactions', base.interactions, generated.interactions),
    flows: carry('flows', base.flows, generated.flows),
  };
}

export const integrationAiSpec: AiSpec<IntegrationDocument> = {
  generationSchema: generatedIntegrationSchema,
  generationJsonSchema,
  system: systemPrompt,
  user(instruction, base) {
    if (!base) return `Genera el modelo de integración para la siguiente descripción:\n\n${instruction}`;
    return (
      `Este es el modelo de integración actual en JSON:\n\n${JSON.stringify(toGenerated(base), null, 2)}\n\n` +
      `Aplica la siguiente instrucción de refinamiento y devuelve el modelo COMPLETO actualizado. Conserva los ids ` +
      `existentes de lo que no cambia y solo añade, modifica o elimina lo que la instrucción requiera. El contenido de los ` +
      `contratos no va en el modelo y se conserva solo para los ids que sigas usando:\n\n${instruction}`
    );
  },
  retry: (issues) => `El modelo devuelto no pasó la validación. Corrige estos problemas y devuelve el modelo completo de nuevo:\n${issues}`,
  toDocument: (generated) => generatedToIntegration(generated as GeneratedIntegration),
  carry: carryIntegration,
  // Para `iark explain` y `iark review`: la proyección compacta del documento y qué destacar y qué mirar en este módulo.
  serialize: toGenerated,
  explainGuide:
    'Cuenta quién inicia cada comunicación, con qué estilo (llamada síncrona, mensaje por cola, evento, lote o flujo continuo) y por qué canal (cola, tópico, pasarela); si hay flujos declarados, narra sus pasos en orden; menciona los contratos (OpenAPI, AsyncAPI, Avro…) de las interfaces y quién es responsable de cada nodo.',
  reviewGuide:
    'Mira: cadenas de llamadas síncronas (A llama a B que llama a C) sin patrón de resiliencia (reintento, circuit breaker, cola de mensajes fallidos); colas o tópicos sin productor o sin consumidor; productor y consumidor enlazados directamente sin canal; APIs sin contrato, o contratos sin versión; interacciones sin protocolo ni criticidad; dependencias circulares entre sistemas; datos sensibles que viajan sin que conste autenticación o cifrado; flujos cuyos pasos no cuadran con las interacciones declaradas; nodos aislados.',
};
