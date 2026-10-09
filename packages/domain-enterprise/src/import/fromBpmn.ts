/**
 * Importador de BPMN 2.0 (XML) para el módulo empresarial. Lee el modelo semántico (`definitions`, en el espacio de nombres
 * `http://www.omg.org/spec/BPMN/20100524/MODEL`, con cualquier prefijo) que escriben Camunda, bpmn.io, Signavio, Bizagi y demás.
 * Es un enfoque como el de ArchiMate: lo que el módulo no puede representar no se descarta en silencio, se resume en los avisos.
 *
 *   BPMN                                                → empresa
 *   --------------------------------------------------------------------------------------------------------------------
 *   `participant` (pool)                                → unidad (externa si no tiene `processRef`: una caja negra)
 *   `lane`                                              → unidad hija del pool (los carriles anidados, hijos de su carril)
 *   `process`                                           → proceso, con el pool como responsable y la asignación unidad → proceso
 *   tarea, subproceso, actividad de llamada             → proceso hijo del proceso o subproceso que lo contiene (`composes`),
 *                                                         con el carril como responsable y la asignación unidad → proceso
 *   `sequenceFlow` entre actividades                    → `triggers` (disparo) de una actividad a la siguiente
 *   `messageFlow`                                       → `flows-to` entre los procesos de sus extremos
 *   actividad de llamada con `calledElement`            → el proceso llamado forma parte de la actividad (`composes`)
 *
 * Los eventos y las compuertas no son procesos y desaparecen, igual que las uniones y los eventos de ArchiMate: la relación que
 * pasa por ellos se sustituye por una relación directa entre las actividades de sus extremos, y los nombres de los eventos, las
 * compuertas y las condiciones de las ramas quedan como descripción de esa relación (`Compuerta exclusiva: ¿Hay stock? → Sí`). El
 * evento de inicio y el de fin con nombre pasan a la descripción de su proceso o subproceso. Un evento límite (`boundaryEvent`)
 * cuelga de la actividad a la que está unido. Un extremo de un flujo de mensaje que es un evento se lleva a las actividades que
 * lo siguen (si recibe) o lo preceden (si envía); un pool de caja negra se convierte en un proceso marcado `caja-negra`.
 *
 * Lo que NO se importa y se resume en los avisos: objetos y almacenes de datos, anotaciones, asociaciones y grupos; las
 * coreografías y conversaciones; las extensiones de herramienta (`extensionElements`, atributos `camunda:`…); las
 * características de bucle y multiinstancia; y el diagrama gráfico (BPMNDI), porque el módulo calcula su propia distribución.
 *
 * Seguridad: solo `fast-xml-parser`, sin red ni disco. Se rechazan las entidades propias (`<!ENTITY>`), el XML mal formado, el texto
 * mayor de 32 MiB, más de 100 niveles de anidamiento o 500.000 elementos, y los modelos con más de 50.000 actividades, eventos y
 * compuertas.
 */
import { pickId, textSizeProblem, Warnings } from '@iark/kernel';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { formatEnterpriseIssues, validateEnterpriseDocument } from '../schema';
import { ENTERPRISE_DOCUMENT_VERSION, type Process, type Relation, type RelationKind, type Unit } from '../types';
import { describeXmlError, rootTag } from './archimateXml';
import { EnterpriseImportError, type EnterpriseImportOptions, type EnterpriseImportResult } from './fromMermaid';

const BPMN_MODEL_NAMESPACE = 'http://www.omg.org/spec/BPMN/20100524/MODEL';
const MAX_XML_DEPTH = 100;
const MAX_XML_ELEMENTS = 500_000;
const MAX_FLOW_NODES = 50_000;
const MAX_RELATIONS = 200_000;
/** Aristas que se recorren por compuertas y eventos como máximo en un modelo (la cota de un grafo denso: quien lo diseñe para tardar, no tarda). */
const MAX_WALK_STEPS = 5_000_000;
/** Etiquetas de eventos y compuertas que se conservan en la descripción de una relación (las últimas del camino). */
const MAX_TRAIL_LABELS = 6;

/** ¿El texto es un modelo BPMN 2.0? Mira solo la etiqueta raíz: `definitions` en el espacio de nombres del modelo de BPMN. */
export function looksLikeBpmn(text: string): boolean {
  const root = rootTag(text);
  return !!root && root.local === 'definitions' && root.attrs.includes(BPMN_MODEL_NAMESPACE);
}

// ───────────── lectura del XML ─────────────

interface XNode {
  /** Nombre local de la etiqueta, sin prefijo de espacio de nombres. */
  tag: string;
  attrs: Record<string, string>;
  kids: XNode[];
  text: string;
}

const local = (name: string): string => name.slice(name.lastIndexOf(':') + 1);
const isTree = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const slug = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
const clean = (s: string | undefined): string | undefined => {
  const t = s?.replace(/\s+/g, ' ').trim();
  return t ? t : undefined;
};
const brief = (s: string, max = 200): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const quoted = (names: string[], max = 4): string => `${names.slice(0, max).map((n) => `«${n}»`).join(', ')}${names.length > max ? ` y ${names.length - max} más` : ''}`;

/**
 * Convierte el árbol que devuelve `fast-xml-parser` con `preserveOrder` (listas de objetos de una sola etiqueta, en el orden del
 * documento) en nodos simples, con un recorrido iterativo. Falla si el documento supera los topes de elementos o de profundidad.
 */
function toNodes(parsed: unknown[]): XNode {
  const root: XNode = { tag: '#root', attrs: {}, kids: [], text: '' };
  const stack: Array<{ items: unknown[]; into: XNode; depth: number }> = [{ items: parsed, into: root, depth: 0 }];
  let elements = 0;
  while (stack.length > 0) {
    const { items, into, depth } = stack.pop()!;
    for (const item of items) {
      if (!isTree(item)) continue;
      for (const key of Object.keys(item)) {
        if (key === ':@') continue;
        if (key === '#text') {
          const piece = String(item[key]);
          into.text = into.text ? `${into.text} ${piece}` : piece;
          continue;
        }
        if (key.startsWith('?') || key.startsWith('!')) continue;
        elements += 1;
        if (elements > MAX_XML_ELEMENTS) throw new EnterpriseImportError(`El XML tiene demasiados elementos (más de ${MAX_XML_ELEMENTS}).`);
        if (depth + 1 > MAX_XML_DEPTH) throw new EnterpriseImportError(`El XML está anidado en más de ${MAX_XML_DEPTH} niveles.`);
        const attrs: Record<string, string> = {};
        const raw = item[':@'];
        if (isTree(raw)) for (const [name, value] of Object.entries(raw)) if (name.startsWith('@_')) attrs[name.slice(2)] = String(value);
        const node: XNode = { tag: local(key), attrs, kids: [], text: '' };
        into.kids.push(node);
        if (Array.isArray(item[key])) stack.push({ items: item[key] as unknown[], into: node, depth: depth + 1 });
      }
    }
  }
  return root;
}

function readXml(source: string): XNode {
  const text = source.replace(/^﻿/, '');
  if (text.trim() === '') throw new EnterpriseImportError('El archivo de BPMN está vacío.');
  const big = textSizeProblem(text, 'El archivo de BPMN');
  if (big) throw new EnterpriseImportError(big);
  if (/<!ENTITY/i.test(text)) throw new EnterpriseImportError('El XML declara entidades propias (<!ENTITY>), que no se admiten en un modelo de BPMN.');
  const valid = XMLValidator.validate(text);
  if (valid !== true) {
    const { msg, line, col } = valid.err;
    throw new EnterpriseImportError(`XML mal formado: ${describeXmlError(msg, line, col)}`);
  }
  let parsed: unknown[];
  try {
    parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, parseAttributeValue: false, trimValues: true, preserveOrder: true }).parse(text) as unknown[];
  } catch (error) {
    if (error instanceof RangeError || (error instanceof Error && /nested/i.test(error.message))) throw new EnterpriseImportError(`El XML está anidado en más de ${MAX_XML_DEPTH} niveles.`);
    throw new EnterpriseImportError(`No se pudo leer el XML: ${error instanceof Error ? error.message : String(error)}`);
  }
  return toNodes(parsed);
}

/** Todos los descendientes con un nombre local, en el orden del documento. */
const kidsNamed = (node: XNode, name: string): XNode[] => node.kids.filter((k) => k.tag === name);
const kidNamed = (node: XNode, name: string): XNode | undefined => node.kids.find((k) => k.tag === name);

// ───────────── tipos de BPMN ─────────────

/** Actividades que pasan a ser un proceso del módulo, con la etiqueta que recuerda su tipo de BPMN. */
const ACTIVITIES: Record<string, string> = {
  task: 'tarea',
  userTask: 'tarea-de-usuario',
  serviceTask: 'tarea-de-servicio',
  manualTask: 'tarea-manual',
  scriptTask: 'tarea-de-script',
  businessRuleTask: 'tarea-de-reglas',
  sendTask: 'tarea-de-envio',
  receiveTask: 'tarea-de-recepcion',
  callActivity: 'actividad-de-llamada',
  subProcess: 'subproceso',
  transaction: 'transaccion',
  adHocSubProcess: 'subproceso-ad-hoc',
};
const ACTIVITY_WORDS: Record<string, string> = {
  task: 'Tarea',
  userTask: 'Tarea de usuario',
  serviceTask: 'Tarea de servicio',
  manualTask: 'Tarea manual',
  scriptTask: 'Tarea de script',
  businessRuleTask: 'Tarea de reglas de negocio',
  sendTask: 'Tarea de envío',
  receiveTask: 'Tarea de recepción',
  callActivity: 'Actividad de llamada',
  subProcess: 'Subproceso',
  transaction: 'Transacción',
  adHocSubProcess: 'Subproceso ad hoc',
};
const CONTAINERS = new Set(['subProcess', 'transaction', 'adHocSubProcess']);
const EVENT_WORDS: Record<string, string> = {
  startEvent: 'Inicio',
  endEvent: 'Fin',
  intermediateCatchEvent: 'Espera',
  intermediateThrowEvent: 'Envío',
  boundaryEvent: 'Evento límite',
  implicitThrowEvent: 'Evento',
};
const DEFINITION_WORDS: Record<string, string> = {
  messageEventDefinition: 'mensaje',
  timerEventDefinition: 'temporizador',
  signalEventDefinition: 'señal',
  errorEventDefinition: 'error',
  escalationEventDefinition: 'escalado',
  conditionalEventDefinition: 'condición',
  linkEventDefinition: 'enlace',
  compensateEventDefinition: 'compensación',
  cancelEventDefinition: 'cancelación',
  terminateEventDefinition: 'terminación',
};
const GATEWAY_WORDS: Record<string, string> = {
  exclusiveGateway: 'exclusiva',
  inclusiveGateway: 'inclusiva',
  parallelGateway: 'paralela',
  eventBasedGateway: 'basada en eventos',
  complexGateway: 'compleja',
};
/** Elementos de proceso que se resumen en un aviso, con el nombre con que se cuentan. */
const SKIPPED_ELEMENTS: Record<string, string> = {
  dataObject: 'objeto(s) de datos',
  dataObjectReference: 'referencia(s) a objetos de datos',
  dataStoreReference: 'almacén(es) de datos',
  textAnnotation: 'anotación(es)',
  association: 'asociación(es)',
  group: 'grupo(s)',
  conversation: 'conversación(es)',
  callConversation: 'conversación(es) de llamada',
  subConversation: 'subconversación(es)',
  conversationLink: 'enlace(s) de conversación',
  choreography: 'coreografía(s)',
  subChoreography: 'subcoreografía(s)',
  choreographyTask: 'tarea(s) de coreografía',
  callChoreography: 'coreografía(s) de llamada',
  multiInstanceLoopCharacteristics: 'actividad(es) multiinstancia',
  standardLoopCharacteristics: 'bucle(s) estándar',
  ioSpecification: 'especificación(es) de entrada y salida',
  dataInputAssociation: 'asociación(es) de datos de entrada',
  dataOutputAssociation: 'asociación(es) de datos de salida',
  property: 'propiedad(es) de proceso',
  artifact: 'artefacto(s)',
};

interface FlowNode {
  id: string;
  tag: string;
  kind: 'activity' | 'event' | 'gateway';
  name?: string;
  documentation?: string;
  /** Proceso o subproceso (por su id de BPMN) que lo contiene. */
  container: string;
  calledElement?: string;
  attachedTo?: string;
  /** Texto con que su nombre pasa a la descripción de una relación (solo eventos y compuertas). */
  label: string;
}

interface Edge {
  to: string;
  label?: string;
}

interface Lane {
  id: string;
  name?: string;
  parent?: string;
  refs: string[];
}

interface BpmnProcess {
  id: string;
  name?: string;
  documentation?: string;
  lanes: Lane[];
}

function eventLabel(tag: string, node: XNode): string {
  const definition = node.kids.map((k) => DEFINITION_WORDS[k.tag]).find(Boolean);
  const name = clean(node.attrs.name);
  return `${EVENT_WORDS[tag] ?? 'Evento'}${definition ? ` de ${definition}` : ''}${name ? `: ${name}` : ''}`;
}

/**
 * Importa un modelo BPMN 2.0 como documento empresarial (ver la cabecera de este archivo para el mapeo). Lanza
 * `EnterpriseImportError` con un motivo de una línea si el texto no es un BPMN utilizable.
 */
export function fromBpmn(source: string, options: EnterpriseImportOptions = {}): EnterpriseImportResult {
  const tree = readXml(source);
  const definitions = tree.kids.find((k) => k.tag !== '#root');
  if (!definitions) throw new EnterpriseImportError('El XML no tiene elemento raíz.');
  if (definitions.tag !== 'definitions') {
    throw new EnterpriseImportError(`La raíz del XML es «${definitions.tag}»: un modelo BPMN 2.0 empieza por «definitions» en el espacio de nombres ${BPMN_MODEL_NAMESPACE}.`);
  }
  const warnings = new Warnings();
  const skipped = new Map<string, number>();
  const skip = (tag: string, count = 1): void => void skipped.set(tag, (skipped.get(tag) ?? 0) + count);
  const foreign = new Set<string>();
  let extensions = 0;
  let diagrams = 0;

  // ───────────── participantes y flujos de mensaje ─────────────
  interface Participant {
    id: string;
    name?: string;
    processRef?: string;
  }
  const participants: Participant[] = [];
  const participantById = new Map<string, Participant>();
  const messageFlows: Array<{ id: string; name?: string; source?: string; target?: string }> = [];
  const bpmnProcesses: BpmnProcess[] = [];
  const nodes = new Map<string, FlowNode>();
  const order: FlowNode[] = [];
  const out = new Map<string, Edge[]>();
  const into = new Map<string, Edge[]>();
  const containerInfo = new Map<string, { starts: string[]; ends: string[] }>();
  const sequenceFlows: Array<{ source?: string; target?: string; label?: string }> = [];
  const boundaries: Array<{ id: string; host: string }> = [];
  let anonymous = 0;

  const countForeign = (node: XNode): void => {
    for (const name of Object.keys(node.attrs)) {
      const prefix = name.includes(':') ? name.slice(0, name.indexOf(':')) : undefined;
      if (prefix && prefix !== 'xmlns' && prefix !== 'xsi' && prefix !== 'xml') foreign.add(prefix);
    }
    if (node.tag === 'extensionElements') extensions += 1;
  };

  // Recorrido iterativo del modelo (un subproceso anidado muy hondo no debe agotar la pila).
  const walk: Array<{ node: XNode; container: string }> = [];
  for (const top of definitions.kids) {
    countForeign(top);
    switch (top.tag) {
      case 'collaboration':
        for (const k of top.kids) {
          countForeign(k);
          if (k.tag === 'participant' && k.attrs.id) {
            const participant: Participant = { id: k.attrs.id, name: clean(k.attrs.name), processRef: k.attrs.processRef };
            participants.push(participant);
            participantById.set(participant.id, participant);
          }
          else if (k.tag === 'messageFlow') messageFlows.push({ id: k.attrs.id ?? `mensaje-${messageFlows.length + 1}`, name: clean(k.attrs.name), source: k.attrs.sourceRef, target: k.attrs.targetRef });
          else if (SKIPPED_ELEMENTS[k.tag]) skip(k.tag);
        }
        break;
      case 'process': {
        const id = top.attrs.id ?? `proceso-${(anonymous += 1)}`;
        const process: BpmnProcess = { id, name: clean(top.attrs.name), documentation: clean(kidNamed(top, 'documentation')?.text), lanes: [] };
        bpmnProcesses.push(process);
        containerInfo.set(id, { starts: [], ends: [] });
        // Carriles: `laneSet` → `lane` → `childLaneSet` → `lane`…
        const laneStack: Array<{ node: XNode; parent?: string }> = kidsNamed(top, 'laneSet').map((node) => ({ node }));
        while (laneStack.length > 0) {
          const { node, parent } = laneStack.pop()!;
          for (const lane of kidsNamed(node, 'lane')) {
            const laneId = lane.attrs.id ?? `carril-${process.lanes.length + 1}`;
            process.lanes.push({ id: laneId, name: clean(lane.attrs.name), ...(parent ? { parent } : {}), refs: kidsNamed(lane, 'flowNodeRef').map((r) => r.text.trim()).filter(Boolean) });
            for (const child of kidsNamed(lane, 'childLaneSet')) laneStack.push({ node: child, parent: laneId });
          }
        }
        walk.push({ node: top, container: id });
        break;
      }
      case 'BPMNDiagram':
        diagrams += 1;
        break;
      default:
        if (SKIPPED_ELEMENTS[top.tag]) skip(top.tag);
    }
  }
  // Elementos de flujo de cada proceso y subproceso, en el orden del documento (la pila se vacía por el final, de ahí el `reverse`).
  walk.reverse();
  let flowNodeCount = 0;
  while (walk.length > 0) {
    const { node, container } = walk.pop()!;
    const nested: Array<{ node: XNode; container: string }> = [];
    for (const k of node.kids) {
      countForeign(k);
      const id = k.attrs.id;
      if (ACTIVITIES[k.tag] || EVENT_WORDS[k.tag] || GATEWAY_WORDS[k.tag]) {
        flowNodeCount += 1;
        if (flowNodeCount > MAX_FLOW_NODES) throw new EnterpriseImportError(`El BPMN tiene más de ${MAX_FLOW_NODES} actividades, eventos y compuertas: demasiado grande para importarlo.`);
        const nodeId = id ?? `${k.tag}-${(anonymous += 1)}`;
        const kind = ACTIVITIES[k.tag] ? 'activity' : EVENT_WORDS[k.tag] ? 'event' : 'gateway';
        const name = clean(k.attrs.name);
        const flow: FlowNode = {
          id: nodeId,
          tag: k.tag,
          kind,
          ...(name ? { name } : {}),
          ...(clean(kidNamed(k, 'documentation')?.text) ? { documentation: clean(kidNamed(k, 'documentation')?.text) } : {}),
          container,
          ...(k.attrs.calledElement ? { calledElement: k.attrs.calledElement } : {}),
          ...(k.tag === 'boundaryEvent' && k.attrs.attachedToRef ? { attachedTo: k.attrs.attachedToRef } : {}),
          label: kind === 'event' ? eventLabel(k.tag, k) : kind === 'gateway' ? `Compuerta ${GATEWAY_WORDS[k.tag]}${name ? `: ${name}` : ''}` : (name ?? ''),
        };
        nodes.set(nodeId, flow);
        order.push(flow);
        if (flow.attachedTo) boundaries.push({ id: nodeId, host: flow.attachedTo });
        const info = containerInfo.get(container);
        if (info && name && k.tag === 'startEvent') info.starts.push(name);
        if (info && name && k.tag === 'endEvent') info.ends.push(name);
        for (const inner of k.kids) {
          countForeign(inner);
          if (SKIPPED_ELEMENTS[inner.tag]) skip(inner.tag);
        }
        if (CONTAINERS.has(k.tag)) {
          containerInfo.set(nodeId, { starts: [], ends: [] });
          nested.push({ node: k, container: nodeId });
        }
      } else if (k.tag === 'sequenceFlow') {
        const condition = clean(kidNamed(k, 'conditionExpression')?.text);
        const label = clean(k.attrs.name) ?? (condition ? brief(condition, 60) : undefined);
        sequenceFlows.push({ source: k.attrs.sourceRef, target: k.attrs.targetRef, ...(label ? { label } : {}) });
      } else if (SKIPPED_ELEMENTS[k.tag]) skip(k.tag);
    }
    // Se apilan al revés para que salgan en el orden del documento.
    for (let i = nested.length - 1; i >= 0; i -= 1) walk.push(nested[i]);
  }

  if (bpmnProcesses.length === 0) throw new EnterpriseImportError('El BPMN no define ningún proceso («process»): no hay nada que importar.');
  if (nodes.size === 0 && participants.length === 0) throw new EnterpriseImportError('El BPMN no tiene actividades, eventos ni participantes: no hay nada que importar.');

  // ───────────── grafo de secuencia (con los eventos límite colgando de su actividad) ─────────────
  let dangling = 0;
  const link = (source: string | undefined, target: string | undefined, label?: string): void => {
    if (!source || !target || !nodes.has(source) || !nodes.has(target)) {
      dangling += 1;
      return;
    }
    (out.get(source) ?? out.set(source, []).get(source)!).push({ to: target, ...(label ? { label } : {}) });
    (into.get(target) ?? into.set(target, []).get(target)!).push({ to: source, ...(label ? { label } : {}) });
  };
  for (const f of sequenceFlows) link(f.source, f.target, f.label);
  for (const b of boundaries) link(b.host, b.id);

  // ───────────── unidades: pools y carriles ─────────────
  const taken = new Set<string>();
  const units: Unit[] = [];
  const unitOfParticipant = new Map<string, string>();
  const participantOfProcess = new Map<string, Participant>();
  const bpmnProcessById = new Map(bpmnProcesses.map((p) => [p.id, p]));
  for (const p of participants) {
    const called = p.processRef ? bpmnProcessById.get(p.processRef) : undefined;
    const hasProcess = !!called;
    const name = p.name ?? called?.name ?? p.id;
    const id = pickId(slug(name) || 'participante', taken);
    units.push({ id, name, ...(hasProcess ? {} : { external: true, description: 'Participante sin proceso detallado (caja negra).' }) });
    unitOfParticipant.set(p.id, id);
    if (hasProcess && p.processRef && !participantOfProcess.has(p.processRef)) participantOfProcess.set(p.processRef, p);
  }
  const unitOfLane = new Map<string, string>();
  const laneOfNode = new Map<string, string>();
  for (const process of bpmnProcesses) {
    const owner = participantOfProcess.get(process.id);
    for (const lane of process.lanes) {
      const parentUnit = lane.parent ? unitOfLane.get(lane.parent) : owner ? unitOfParticipant.get(owner.id) : undefined;
      const name = lane.name ?? `Carril ${units.length + 1}`;
      const id = pickId(slug(name) || 'carril', taken);
      units.push({ id, name, ...(parentUnit ? { parentId: parentUnit } : {}) });
      unitOfLane.set(lane.id, id);
    }
    // Un nodo en un carril anidado lo dice también el carril padre: manda el más hondo (los carriles vienen padre antes que hijos).
    for (const lane of process.lanes) for (const ref of lane.refs) laneOfNode.set(ref, lane.id);
  }

  // ───────────── procesos: los de BPMN y una actividad cada uno ─────────────
  const processes: Process[] = [];
  const relations: Relation[] = [];
  const relationKeys = new Set<string>();
  const relationIds = new Set<string>();
  const entityOf = new Map<string, string>();
  let relationOverflow = false;
  const relate = (kind: RelationKind, sourceId: string, targetId: string, description?: string): void => {
    if (sourceId === targetId) return;
    const key = `${kind}|${sourceId}|${targetId}`;
    if (relationKeys.has(key)) return;
    if (relations.length >= MAX_RELATIONS) {
      relationOverflow = true;
      return;
    }
    relationKeys.add(key);
    relations.push({ id: pickId(`${kind}-${sourceId}-${targetId}`, relationIds), kind, sourceId, targetId, ...(description ? { description: brief(description) } : {}) });
  };
  const startsAndEnds = (container: string): string | undefined => {
    const info = containerInfo.get(container);
    if (!info) return undefined;
    const parts = [info.starts.length > 0 ? `Inicio: ${info.starts.join(', ')}` : undefined, info.ends.length > 0 ? `Fin: ${info.ends.join(', ')}` : undefined].filter(Boolean);
    return parts.length > 0 ? parts.join('. ') : undefined;
  };
  const laneUnitOf = (node: FlowNode): string | undefined => {
    // Sin carril propio, hereda el del subproceso que lo contiene.
    for (let id: string | undefined = node.id, hops = 0; id !== undefined && hops < MAX_XML_DEPTH; hops += 1) {
      const lane = laneOfNode.get(id);
      if (lane) return unitOfLane.get(lane);
      id = nodes.get(id)?.container;
    }
    return undefined;
  };
  const processUnit = new Map<string, string | undefined>();

  for (const process of bpmnProcesses) {
    const owner = participantOfProcess.get(process.id);
    const ownerUnit = owner ? unitOfParticipant.get(owner.id) : undefined;
    const name = process.name ?? owner?.name ?? `Proceso ${process.id}`;
    const id = pickId(slug(name) || 'proceso', taken);
    const description = [process.documentation, startsAndEnds(process.id)].filter(Boolean).join(' · ');
    processes.push({ id, name, ...(description ? { description: brief(description, 600) } : {}), ...(ownerUnit ? { ownerId: ownerUnit } : {}), tags: ['bpmn', 'proceso-bpmn'] });
    entityOf.set(process.id, id);
    processUnit.set(process.id, ownerUnit);
    if (ownerUnit) relate('assigned-to', ownerUnit, id);
  }
  // Las actividades, en el orden del documento: el contenedor de cada una ya tiene su proceso.
  for (const node of order) {
    if (node.kind !== 'activity') continue;
    const word = ACTIVITY_WORDS[node.tag];
    const name = node.name ?? `${word} sin nombre`;
    const lane = laneUnitOf(node);
    const unit = lane ?? processUnit.get(rootContainerOf(node, nodes) ?? '');
    const id = pickId(slug(name) || slug(word), taken);
    const extra = [node.documentation, node.calledElement ? `Llama al proceso «${node.calledElement}»` : undefined, CONTAINERS.has(node.tag) ? startsAndEnds(node.id) : undefined].filter(Boolean).join(' · ');
    processes.push({ id, name, ...(extra ? { description: brief(extra, 600) } : {}), ...(unit ? { ownerId: unit } : {}), tags: ['bpmn', ACTIVITIES[node.tag]] });
    entityOf.set(node.id, id);
    if (lane) relate('assigned-to', lane, id);
  }
  for (const node of order) {
    if (node.kind !== 'activity') continue;
    const self = entityOf.get(node.id)!;
    const parent = entityOf.get(node.container);
    if (parent) relate('composes', parent, self);
  }
  const collapsedKinds = { events: order.filter((n) => n.kind === 'event').length, gateways: order.filter((n) => n.kind === 'gateway').length };

  // ───────────── secuencia: de una actividad a las siguientes, atravesando eventos y compuertas ─────────────
  interface Trail {
    label: string;
    prev?: Trail;
  }
  const trailLabels = (trail: Trail | undefined): string[] => {
    const labels: string[] = [];
    let t = trail;
    for (; t && labels.length < MAX_TRAIL_LABELS; t = t.prev) labels.push(t.label);
    if (t) labels.push('…');
    return labels.reverse();
  };
  let steps = 0;
  /**
   * Actividades a las que se llega desde `start` por la secuencia (hacia delante o hacia atrás) pasando solo por eventos y
   * compuertas, con las etiquetas del camino. Cada nodo se visita una vez por llamada: un ciclo no lo repite.
   */
  const reach = (start: string, edgeLabel: string | undefined, graph: Map<string, Edge[]>): Array<{ id: string; labels: string[] }> => {
    const found: Array<{ id: string; labels: string[] }> = [];
    const visited = new Set<string>();
    const pending: Array<{ id: string; trail?: Trail }> = [{ id: start, trail: edgeLabel ? { label: edgeLabel } : undefined }];
    while (pending.length > 0) {
      const { id, trail } = pending.pop()!;
      const node = nodes.get(id);
      if (!node || visited.has(id)) continue;
      visited.add(id);
      if (node.kind === 'activity') {
        found.push({ id, labels: trailLabels(trail) });
        continue;
      }
      const edges = graph.get(id) ?? [];
      steps += edges.length + 1;
      if (steps > MAX_WALK_STEPS) break;
      const here: Trail = { label: node.label, ...(trail ? { prev: trail } : {}) };
      for (const edge of edges) pending.push({ id: edge.to, trail: edge.label ? { label: edge.label, prev: here } : here });
    }
    return found;
  };
  let selfLoops = 0;
  for (const node of order) {
    if (node.kind !== 'activity') continue;
    const source = entityOf.get(node.id)!;
    for (const edge of out.get(node.id) ?? []) {
      if (steps > MAX_WALK_STEPS) break;
      for (const hit of reach(edge.to, edge.label, out)) {
        const target = entityOf.get(hit.id)!;
        if (target === source) selfLoops += 1;
        else relate('triggers', source, target, hit.labels.length > 0 ? hit.labels.join(' → ') : undefined);
      }
    }
  }
  if (steps > MAX_WALK_STEPS) warnings.add('El modelo tiene tantas compuertas y eventos encadenados que no se recorrieron todos: faltarán algunas relaciones de disparo.');

  // ───────────── flujos de mensaje ─────────────
  const blackBoxes = new Map<string, string>();
  const processOfNode = (id: string): string | undefined => entityOf.get(rootContainerOf(nodes.get(id), nodes) ?? '');
  const blackBox = (p: Participant): string => {
    let id = blackBoxes.get(p.id);
    if (!id) {
      const name = p.name ?? p.id;
      id = pickId(slug(name) || 'caja-negra', taken);
      const unit = unitOfParticipant.get(p.id);
      processes.push({ id, name, description: 'Proceso del participante externo, que el modelo no detalla (caja negra).', ...(unit ? { ownerId: unit } : {}), tags: ['bpmn', 'caja-negra'] });
      if (unit) relate('assigned-to', unit, id);
      blackBoxes.set(p.id, id);
    }
    return id;
  };
  const endpoints = (ref: string | undefined, graph: Map<string, Edge[]>): Array<{ id: string; labels: string[] }> => {
    if (!ref) return [];
    const participant = participantById.get(ref);
    if (participant) {
      const process = participant.processRef ? entityOf.get(participant.processRef) : undefined;
      return [{ id: process ?? blackBox(participant), labels: [] }];
    }
    const node = nodes.get(ref);
    if (!node) return [];
    if (node.kind === 'activity') return [{ id: entityOf.get(ref)!, labels: [] }];
    // Un evento o una compuerta: las actividades que lo siguen o lo preceden; si no hay, el proceso que lo contiene.
    const hits = reach(ref, undefined, graph).map((h) => ({ id: entityOf.get(h.id)!, labels: [] as string[] }));
    if (hits.length > 0) return hits;
    const container = processOfNode(ref) ?? entityOf.get(node.container);
    return container ? [{ id: container, labels: [] }] : [];
  };
  let brokenMessages = 0;
  for (const m of messageFlows) {
    const sources = endpoints(m.source, into);
    const targets = endpoints(m.target, out);
    if (sources.length === 0 || targets.length === 0) {
      brokenMessages += 1;
      continue;
    }
    for (const s of sources) for (const t of targets) relate('flows-to', s.id, t.id, m.name);
  }

  // ───────────── actividades de llamada ─────────────
  let unresolvedCalls = 0;
  for (const node of order) {
    if (node.tag !== 'callActivity' || !node.calledElement) continue;
    const called = bpmnProcessById.has(node.calledElement) ? entityOf.get(node.calledElement) : undefined;
    const self = entityOf.get(node.id)!;
    if (!called) unresolvedCalls += 1;
    else if (called === processOfNode(node.id)) unresolvedCalls += 1;
    else relate('composes', self, called);
  }

  // ───────────── avisos ─────────────
  if (blackBoxes.size > 0) warnings.add(`${blackBoxes.size} participante(s) sin proceso detallado (${quoted([...blackBoxes.keys()].map((k) => participantById.get(k)?.name ?? k))}) se importan como unidad externa con un proceso marcado «caja-negra», para poder recibir y enviar mensajes.`);
  if (collapsedKinds.events + collapsedKinds.gateways > 0) {
    warnings.add(`${collapsedKinds.events} evento(s) y ${collapsedKinds.gateways} compuerta(s) no son procesos: las relaciones que pasan por ellos se unen directamente entre actividades y sus nombres y las condiciones de las ramas quedan en la descripción de la relación.`);
  }
  if (dangling > 0) warnings.add(`${dangling} flujo(s) de secuencia o evento(s) límite apuntan a un elemento que no existe y se ignoran.`);
  if (brokenMessages > 0) warnings.add(`${brokenMessages} flujo(s) de mensaje apuntan a un elemento que no existe o que no tiene actividades, y se ignoran.`);
  if (selfLoops > 0) warnings.add(`${selfLoops} bucle(s) de una actividad hacia sí misma no se importan: el módulo no admite una relación de un proceso consigo mismo.`);
  if (unresolvedCalls > 0) warnings.add(`${unresolvedCalls} actividad(es) de llamada llaman a un proceso que no está en el archivo o a su propio proceso: queda el nombre en su descripción, sin relación.`);
  if (skipped.size > 0) warnings.add(`Sin correspondencia en el módulo, no se importan: ${[...skipped].map(([tag, n]) => `${n} ${SKIPPED_ELEMENTS[tag] ?? tag}`).join(', ')}.`);
  if (extensions > 0 || foreign.size > 0) {
    warnings.add(`Extensiones de herramienta no importadas: ${extensions} bloque(s) «extensionElements»${foreign.size > 0 ? ` y atributos de ${[...foreign].sort().map((p) => `«${p}:»`).join(', ')}` : ''}.`);
  }
  if (diagrams > 0) warnings.add(`${diagrams} diagrama(s) gráfico(s) (BPMNDI) no se importan: el módulo calcula su propia distribución.`);
  if (relationOverflow) warnings.add(`Se alcanzó el máximo de ${MAX_RELATIONS} relaciones: se omiten las demás.`);
  if (nodes.size === 0) warnings.add('El BPMN no define actividades, eventos ni compuertas: solo se importan los participantes, los carriles y los procesos.');

  const definitionsName = clean(definitions.attrs.name);
  const name = options.name?.trim() || definitionsName || options.fallbackName?.trim().replace(/\.(?:bpmn|xml)$/i, '') || 'Procesos BPMN';
  const result = validateEnterpriseDocument({
    version: ENTERPRISE_DOCUMENT_VERSION,
    workspace: { name, description: `Importado de un modelo BPMN 2.0: ${bpmnProcesses.length} proceso(s), ${participants.length} participante(s) y ${order.filter((n) => n.kind === 'activity').length} actividad(es).` },
    units,
    capabilities: [],
    processes,
    applications: [],
    technologies: [],
    valueStreams: [],
    valueStages: [],
    businessServices: [],
    relations,
  });
  if (!result.ok) throw new EnterpriseImportError(`No se pudo construir un documento válido a partir de BPMN:\n${formatEnterpriseIssues(result.issues)}`);
  return { document: result.document, warnings: warnings.result() };
}

/** El proceso de BPMN (el de más arriba) en el que está un nodo, subiendo por los subprocesos que lo contienen. */
function rootContainerOf(node: FlowNode | undefined, nodes: Map<string, FlowNode>): string | undefined {
  let current = node;
  for (let hops = 0; current && hops < MAX_XML_DEPTH; hops += 1) {
    const parent = nodes.get(current.container);
    if (!parent) return current.container;
    current = parent;
  }
  return current?.container;
}
