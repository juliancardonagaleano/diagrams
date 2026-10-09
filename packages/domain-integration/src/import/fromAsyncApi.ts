/**
 * Importador de AsyncAPI (2.x y 3.x) para el módulo de integración. Acepta JSON o YAML y reconoce el formato por el campo raíz
 * `asyncapi`. Como en OpenAPI, nunca sigue un `$ref` a otro archivo o a una URL; los internos se resuelven con control de ciclos.
 *
 *   AsyncAPI                                         → integración
 *   ---------------------------------------------------------------------------------------------------------------
 *   `info` (título, versión, descripción, contacto)  → sistema «título»: la aplicación que describe el contrato
 *   `servers.<nombre>` (url o host, protocolo)       → un nodo `broker` por servidor (tecnología = protocolo)
 *   `channels.<canal>`                               → `topic` (o `queue` si su binding AMQP es `queue` o el protocolo es SQS),
 *                                                      dentro del broker del primer servidor que declara (o del primero)
 *   operación                                        → interacción asíncrona entre el sistema y el canal. Desde el punto de
 *                                                      vista de la aplicación: 3.x `send` y 2.x `subscribe` = la aplicación
 *                                                      PUBLICA (sistema → canal); 3.x `receive` y 2.x `publish` = la aplicación
 *                                                      CONSUME (canal → sistema). Ojo: en 2.x los verbos se escriben desde el
 *                                                      punto de vista del cliente, no de la aplicación
 *   mensajes de la operación                         → `dataObjects` de la interacción (su `name`, `title` o clave)
 *   el documento entero                              → un contrato `asyncapi` con el texto original, enlazado a cada canal
 *                                                      y a cada interacción
 *
 * Lo que NO se importa y cómo se avisa: los `$ref` a otros archivos o URL, rotos o circulares; las operaciones que apuntan a un
 * canal que no existe; `reply` (petición-respuesta de 3.x: solo se importa el mensaje de ida); y, con un aviso agrupado, los
 * `bindings` por protocolo, los `traits` y la seguridad, que siguen completos en el contrato. Los servidores que no declaran
 * dirección se importan igual, sin ella.
 */
import { pickId, Warnings } from '@iark/kernel';
import { formatIntegrationIssues, validateIntegrationDocument } from '../schema';
import { INTEGRATION_DOCUMENT_VERSION, type Contract, type IntegrationNode, type Interaction } from '../types';
import { IntegrationImportError, type IntegrationImportOptions, type IntegrationImportResult } from './fromMermaid';
import { arr, brief, cleanUrl, fillVariables, readSpec, rec, RefResolver, refName, refWarnings, slug, specKind, str, type Json } from './spec';

/** Nombre legible de los protocolos más comunes; los demás se muestran tal cual, en mayúsculas. */
const PROTOCOLS: Record<string, string> = {
  mqtt: 'MQTT',
  mqtts: 'MQTT (TLS)',
  amqp: 'AMQP',
  amqps: 'AMQP (TLS)',
  kafka: 'Kafka',
  'kafka-secure': 'Kafka (TLS)',
  nats: 'NATS',
  stomp: 'STOMP',
  ws: 'WebSocket',
  wss: 'WebSocket (TLS)',
  http: 'HTTP',
  https: 'HTTPS',
  sqs: 'Amazon SQS',
  sns: 'Amazon SNS',
  jms: 'JMS',
  redis: 'Redis',
  googlepubsub: 'Google Pub/Sub',
  pulsar: 'Pulsar',
  solace: 'Solace',
  ibmmq: 'IBM MQ',
  anypointmq: 'Anypoint MQ',
};
const MAX_MESSAGES = 12;
const MAX_CHANNELS = 50_000;

/** ¿El texto es un documento AsyncAPI 2.x o 3.x? Mira solo el campo raíz. */
export function looksLikeAsyncApi(text: string): boolean {
  return specKind(text) === 'asyncapi';
}

interface Broker {
  id: string;
  protocol?: string;
}

interface Channel {
  key: string;
  node: IntegrationNode;
  raw: Json;
  broker?: Broker;
}

interface Op {
  key: string;
  /** `true` si la aplicación publica en el canal; `false` si lo consume. */
  publishes: boolean;
  channel: string;
  raw: Json;
}

const protocolLabel = (protocol: string | undefined, version?: string): string | undefined => {
  if (!protocol) return undefined;
  const label = PROTOCOLS[protocol.toLowerCase()] ?? protocol.toUpperCase();
  return version ? `${label} ${version}` : label;
};

/** Nombres de los mensajes que nombra `node` (un mensaje, una referencia o un `oneOf`/`anyOf` de ellos). */
function messageNames(resolver: RefResolver, node: unknown, depth = 0): string[] {
  if (depth > 4) return [];
  const direct = rec(node);
  if (!direct) return [];
  const alternatives = arr(direct.oneOf).length > 0 ? arr(direct.oneOf) : arr(direct.anyOf);
  if (alternatives.length > 0) return alternatives.flatMap((alt) => messageNames(resolver, alt, depth + 1));
  const target = rec(resolver.resolve(direct));
  if (!target) return [];
  const fromRef = typeof direct.$ref === 'string' ? refName(direct.$ref) : undefined;
  const name = str(target.name) ?? str(target.title) ?? str(target.messageId) ?? fromRef;
  return name ? [name] : [];
}

/**
 * Importa un AsyncAPI como documento de integración (ver la cabecera de este archivo para el mapeo). Lanza
 * `IntegrationImportError` con un motivo de una línea si el texto no es un AsyncAPI utilizable.
 */
export function fromAsyncApi(source: string, options: IntegrationImportOptions = {}): IntegrationImportResult {
  const { root, text } = readSpec(source, 'AsyncAPI');
  const version = str(root.asyncapi);
  if (!version) {
    const other = str(root.openapi) ? ' Es un contrato OpenAPI: impórtalo con el formato «openapi».' : '';
    throw new IntegrationImportError(`El documento no declara «asyncapi» (p. ej. "3.0.0"), así que no es un AsyncAPI.${other}`);
  }
  if (!/^[23]\./.test(version)) throw new IntegrationImportError(`La versión «asyncapi: ${version}» no se admite: se importa AsyncAPI 2.x y 3.x.`);
  const v3 = version.startsWith('3');
  const warnings = new Warnings();
  const resolver = new RefResolver(root);

  const info = rec(root.info);
  const title = str(info?.title);
  if (!title) warnings.add('El AsyncAPI no declara «info.title»: el sistema toma el nombre del archivo.');
  const name = options.name?.trim() || title || options.fallbackName?.trim() || 'Eventos';
  const taken = new Set<string>();
  const systemId = pickId(slug(title ?? name) || 'aplicacion', taken);
  const apiVersion = str(info?.version);
  const owner = str(rec(info?.contact)?.name);
  const nodes: IntegrationNode[] = [];

  // ───────────── servidores → brokers ─────────────
  const brokers = new Map<string, Broker>();
  const serverEntries = Object.entries(rec(root.servers) ?? {});
  let bindings = 0;
  let traits = 0;
  let security = 0;
  for (const [key, raw] of serverEntries) {
    const server = rec(resolver.resolve(raw));
    if (!server) continue;
    const protocol = str(server.protocol);
    const address = v3 ? [str(server.host), str(server.pathname)].filter(Boolean).join('') : str(server.url);
    const where = address ? cleanUrl(fillVariables(address, server.variables)) : undefined;
    const id = pickId(slug(key) || 'broker', taken);
    brokers.set(key, { id, protocol: protocol?.toLowerCase() });
    if (server.bindings !== undefined) bindings += 1;
    if (arr(server.security).length > 0) security += 1;
    nodes.push({
      id,
      kind: 'broker',
      name: key,
      description: [brief(str(server.description)), where ? (where.includes('://') || !protocol ? where : `${protocol}://${where}`) : undefined].filter(Boolean).join(' · '),
      technology: protocolLabel(protocol, str(server.protocolVersion)) ?? 'Broker',
    });
  }
  const defaultBroker = brokers.size > 0 ? [...brokers.values()][0] : undefined;

  // ───────────── canales → temas o colas ─────────────
  const rawChannels = Object.entries(rec(root.channels) ?? {});
  if (rawChannels.length === 0) throw new IntegrationImportError('El AsyncAPI no declara ningún canal en «channels», así que no hay nada que importar.');
  if (rawChannels.length > MAX_CHANNELS) throw new IntegrationImportError(`El AsyncAPI tiene más de ${MAX_CHANNELS} canales: demasiado grande para importarlo.`);
  const contractId = pickId(`${systemId}-asyncapi`, new Set());
  const channels = new Map<string, Channel>();
  let unrestricted = 0;
  for (const [key, raw] of rawChannels) {
    const channel = rec(resolver.resolve(raw));
    if (!channel) continue;
    const address = v3 ? (str(channel.address) ?? key) : key;
    const requested = arr(channel.servers)
      .map((s) => (typeof rec(s)?.$ref === 'string' ? refName(rec(s)!.$ref as string) : str(s)))
      .filter((s): s is string => !!s);
    const restricted = requested.map((s) => brokers.get(s)).filter((b): b is Broker => !!b);
    const broker = restricted[0] ?? defaultBroker;
    if (restricted.length === 0 && brokers.size > 1) unrestricted += 1;
    const queue = str(rec(rec(channel.bindings)?.amqp)?.is) === 'queue' || broker?.protocol === 'sqs';
    if (channel.bindings !== undefined) bindings += 1;
    const alsoIn = restricted.slice(1).length > 0 ? `También en: ${restricted.slice(1).map((b) => b.id).join(', ')}` : undefined;
    const node: IntegrationNode = {
      id: pickId(slug(address) || slug(key) || 'canal', taken),
      kind: queue ? 'queue' : 'topic',
      name: address,
      description: [brief(str(channel.summary) ?? str(channel.description)), v3 && address !== key ? `Canal «${key}»` : undefined, alsoIn].filter(Boolean).join(' · '),
      ...(broker ? { parentId: broker.id } : {}),
      contractId,
    };
    channels.set(key, { key, node, raw: channel, ...(broker ? { broker } : {}) });
    nodes.push(node);
  }
  if (unrestricted > 0) warnings.add(`${unrestricted} canal(es) no dicen en qué servidor están y hay ${brokers.size} servidores: se colocan en el primero («${[...brokers.keys()][0]}»).`);

  // ───────────── operaciones → interacciones ─────────────
  const ops: Op[] = [];
  let withoutChannel = 0;
  if (v3) {
    for (const [key, raw] of Object.entries(rec(root.operations) ?? {})) {
      const op = rec(resolver.resolve(raw));
      const ref = rec(op?.channel);
      const channel = typeof ref?.$ref === 'string' ? refName(ref.$ref) : undefined;
      const action = str(op?.action);
      if (!op || !channel || !channels.has(channel) || (action !== 'send' && action !== 'receive')) {
        withoutChannel += 1;
        continue;
      }
      ops.push({ key, publishes: action === 'send', channel, raw: op });
    }
  } else {
    for (const [key, channel] of channels) {
      // En 2.x los verbos van desde el punto de vista del cliente: «subscribe» es lo que la aplicación publica y «publish», lo que consume.
      for (const verb of ['publish', 'subscribe'] as const) {
        const op = rec(resolver.resolve(channel.raw[verb]));
        if (op) ops.push({ key: str(op.operationId) ?? `${verb} ${key}`, publishes: verb === 'subscribe', channel: key, raw: op });
      }
    }
  }
  if (withoutChannel > 0) warnings.add(`${withoutChannel} operación(es) apuntan a un canal que no existe o no declaran «action» válida (send o receive): se omiten.`);

  const interactions: Interaction[] = [];
  const interactionIds = new Set<string>();
  let replies = 0;
  for (const op of ops) {
    const channel = channels.get(op.channel)!;
    if (op.raw.reply !== undefined) replies += 1;
    if (op.raw.bindings !== undefined) bindings += 1;
    if (arr(op.raw.traits).length > 0) traits += 1;
    if (arr(op.raw.security).length > 0) security += 1;
    const names = v3
      ? arr(op.raw.messages).length > 0
        ? arr(op.raw.messages).flatMap((m) => messageNames(resolver, m))
        : Object.values(rec(channel.raw.messages) ?? {}).flatMap((m) => messageNames(resolver, m))
      : messageNames(resolver, op.raw.message);
    const messages = [...new Set(names)].slice(0, MAX_MESSAGES);
    const detail = brief(str(op.raw.summary) ?? str(op.raw.title) ?? str(op.raw.description), 160);
    const [sourceId, targetId] = op.publishes ? [systemId, channel.node.id] : [channel.node.id, systemId];
    interactions.push({
      id: pickId(`${sourceId}--${targetId}`, interactionIds),
      sourceId,
      targetId,
      style: 'async-message',
      ...(protocolLabel(channel.broker?.protocol) ? { protocol: protocolLabel(channel.broker?.protocol) } : {}),
      contractId,
      description: [op.key, detail].filter(Boolean).join(': '),
      ...(messages.length > 0 ? { dataObjects: messages } : {}),
    });
  }
  const publishes = new Set(interactions.filter((i) => i.sourceId === systemId).map((i) => i.targetId));
  const consumes = new Set(interactions.filter((i) => i.targetId === systemId).map((i) => i.sourceId));
  const oneSided = [...channels.values()].filter((c) => publishes.has(c.node.id) !== consumes.has(c.node.id)).length;
  if (oneSided > 0) warnings.add(`AsyncAPI describe solo a esta aplicación: quien consume lo que publica y quien publica lo que consume (${oneSided} canal(es)) no está en el contrato, así que la validación del módulo avisará de canales sin productor o sin consumidor.`);
  if (interactions.length === 0) warnings.add('El AsyncAPI no declara operaciones (send/receive o publish/subscribe): se importan los canales, pero no se sabe si la aplicación publica o consume en cada uno.');
  if (replies > 0) warnings.add(`${replies} operación(es) declaran «reply» (petición-respuesta): solo se importa el mensaje de ida.`);
  const detail = [bindings > 0 ? `bindings (${bindings})` : undefined, traits > 0 ? `traits (${traits})` : undefined, security > 0 ? `seguridad (${security})` : undefined].filter(Boolean);
  if (detail.length > 0) warnings.add(`No se importa el detalle por protocolo de servidores, canales y operaciones, que sigue completo en el contrato: ${detail.join(', ')}.`);
  for (const w of refWarnings(resolver.report())) warnings.add(w);

  nodes.unshift({
    id: systemId,
    kind: 'system',
    name: title ?? name,
    description: [brief(str(info?.description), 300), apiVersion ? `Versión ${apiVersion}` : undefined].filter(Boolean).join(' · '),
    technology: `AsyncAPI ${version}`,
    ...(owner ? { owner } : {}),
    tags: ['asyncapi'],
  });
  const contract: Contract = {
    id: contractId,
    name: `${title ?? name} (AsyncAPI ${version})`,
    format: 'asyncapi',
    ...(apiVersion ? { version: apiVersion } : {}),
    ...(brief(str(info?.description), 300) ? { description: brief(str(info?.description), 300) } : {}),
    content: text,
  };
  const result = validateIntegrationDocument({ version: INTEGRATION_DOCUMENT_VERSION, workspace: { name }, nodes, contracts: [contract], interactions, flows: [] });
  if (!result.ok) throw new IntegrationImportError(`No se pudo construir un documento válido a partir de AsyncAPI:\n${formatIntegrationIssues(result.issues)}`);
  return { document: result.document, warnings: warnings.result() };
}
