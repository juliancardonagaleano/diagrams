import { REF_TYPE_FIELD, uniqueId, type EdgeNotation, type EditResult, type EditorAction, type EditorGraph, type EditorNode, type EditorSpec, type FieldSpec, type NodeMark, type NodeNotation } from '@iark/kernel';
import { duplicateEnvironment, findEnvironment, nextEnvironment, promoteDeployments, scaleReplicas, toggleApproval } from './actions';
import { counterpartErrors, counterpartMarks, dropCounterparts } from './counterparts';
import { formatCost } from './costs';
import { drawMatrix, matrixIsDrawn } from './export/matrix';
import { DEPENDENCY_STYLES, EXPOSURE_ZONES, EXTERNAL_COLOR, RESOURCE_COLORS, RESOURCE_SHAPES, SERVICE_COLORS, SERVICE_SHAPES, buildScene } from './export/render';
import { canonicalProvider, iconFields, reconcileIcon } from './icons/editor';
import { subjectOfNetwork, subjectOfResource, subjectOfService } from './icons';
import { dependencyEnvironmentViolation, exposureViolation, hostViolation, placementViolation } from './rules';
import { resourceSchema } from './schema';
import {
  CRITICALITIES,
  CRITICALITY_LABELS,
  DEPENDENCY_KINDS,
  DEPENDENCY_LABELS,
  ENVIRONMENT_KINDS,
  ENVIRONMENT_LABELS,
  EXPOSURES,
  EXPOSURE_LABELS,
  PIPELINE_KINDS,
  PIPELINE_LABELS,
  RESOURCE_KINDS,
  RESOURCE_LABELS,
  RESOURCE_STATUSES,
  SERVICE_KINDS,
  SERVICE_LABELS,
  STATUS_LABELS,
  exposureOf,
  indexElements,
  isHost,
  type Deployment,
  type Environment,
  type Dependency,
  type DependencyKind,
  type Network,
  type Pipeline,
  type PipelineStage,
  type PlatformDocument,
  type Resource,
  type ResourceKind,
  type Service,
  type ServiceKind,
} from './types';
import { findView } from './views';

/**
 * Editor interactivo de la plataforma. Su identidad es la de un diagrama de despliegue: en la vista de un entorno las
 * redes son zonas anidadas (coloreadas por exposición), los clústeres y máquinas son cajas que contienen las instancias de
 * los servicios, y los recursos llevan la figura de su clase (cilindro para datos, píldora para colas, hexágono para las
 * pasarelas…). Arrastrar un servicio a un clúster con «corre en» crea el despliegue; en la entrega continua, un servicio a
 * un pipeline lo añade a los que construye. Los entornos no se dibujan: se eligen en las propiedades.
 */
const STEP_COLOR = '#475569';
const NETWORK_FILLS: Record<string, string> = { public: '#e03131', private: '#1c7ed6', isolated: '#495057' };

const service = (kind: ServiceKind, glyph: string): NodeNotation => ({ kind, label: SERVICE_LABELS[kind], glyph, shape: SERVICE_SHAPES[kind], fill: SERVICE_COLORS[kind], width: 200, height: 78 });
const resource = (kind: ResourceKind, glyph: string, height = 78): NodeNotation => ({ kind, label: RESOURCE_LABELS[kind], glyph, shape: RESOURCE_SHAPES[kind], fill: RESOURCE_COLORS[kind], width: 200, height });

const NODE_KIND_NOTATION: NodeNotation[] = [
  service('service', '▣'),
  service('worker', '⚙'),
  service('job', '⏱'),
  service('frontend', '▭'),
  { kind: 'external', label: 'Servicio externo', glyph: '☁', shape: 'rect', fill: EXTERNAL_COLOR, width: 200, height: 78, addable: false },
  resource('cluster', '⬢'),
  resource('vm', '▥'),
  resource('database', '⛁', 84),
  resource('cache', '⚡', 84),
  resource('storage', '▤', 84),
  resource('queue', '⇒', 64),
  resource('load-balancer', '⇶'),
  resource('gateway', '⇄'),
  resource('dns', '◎'),
  resource('secret-store', '🔒'),
  resource('registry', '▦'),
  resource('region', '◍'),
  resource('namespace', '▧'),
  resource('certificate', '✔'),
  resource('monitoring', '◔'),
  resource('other', '▢'),
  { kind: 'environment', label: 'Entorno', glyph: '◫', shape: 'rect', fill: '#2f9e44', width: 240, height: 120, addable: false },
  { kind: 'network', label: 'Red', glyph: '▦', shape: 'rect', fill: NETWORK_FILLS.private, width: 240, height: 120 },
  { kind: 'pipeline', label: 'Pipeline', glyph: '⛓', shape: 'rect', fill: STEP_COLOR, width: 240, height: 120 },
  { kind: 'step', label: 'Paso', glyph: '·', shape: 'rect', fill: STEP_COLOR, width: 180, height: 70, addable: false },
  { kind: 'instance', label: 'Instancia desplegada', glyph: '▣', shape: 'rect', fill: SERVICE_COLORS.service, width: 200, height: 78, addable: false },
];

const EDGE_KIND_NOTATION: EdgeNotation[] = [
  ...DEPENDENCY_KINDS.map((kind): EdgeNotation => ({ kind, label: DEPENDENCY_LABELS[kind], stroke: DEPENDENCY_STYLES[kind].stroke, line: DEPENDENCY_STYLES[kind].dashed ? 'dashed' : 'solid', width: DEPENDENCY_STYLES[kind].width })),
  { kind: 'runs-on', label: 'corre en (despliegue)', stroke: '#94a3b8', line: 'dashed', width: 1.5 },
  { kind: 'flow', label: 'pasa por (pipeline)', stroke: STEP_COLOR, line: 'solid', width: 1.5 },
];

const options = <T extends string>(values: readonly T[], labels: Record<T, string>): Array<{ value: string; label: string }> => values.map((value) => ({ value, label: labels[value] }));
const NAME: FieldSpec = { key: 'name', label: 'Nombre', type: 'text' };
const DESCRIPTION: FieldSpec = { key: 'description', label: 'Descripción', type: 'longtext' };
const REF: FieldSpec = { key: 'ref', label: 'Referencia (URN)', type: 'text', hint: 'urn:iark:<módulo>:<id>' };
const TAGS: FieldSpec = { key: 'tags', label: 'Etiquetas', type: 'list' };
const INSTANCE_FIELDS: FieldSpec[] = [
  { key: 'replicas', label: 'Réplicas', type: 'text' },
  { key: 'version', label: 'Versión desplegada', type: 'text' },
];
const COST: FieldSpec = { key: 'monthlyCost', label: 'Coste mensual', type: 'number', min: 0, step: 1, hint: 'En la moneda del espacio de trabajo (USD si no se indica); alimenta la vista de costes' };
const CPU: FieldSpec = { key: 'cpuLimit', label: 'Límite de CPU', type: 'text', hint: 'p. ej. 2 (vCPU) o 500m' };
const MEMORY: FieldSpec = { key: 'memoryLimit', label: 'Límite de memoria', type: 'text', hint: 'p. ej. 4 GiB' };
const EXPIRES: FieldSpec = { key: 'expiresAt', label: 'Caduca el', type: 'text', hint: 'AAAA-MM-DD; con ella el análisis avisa cuando está cerca' };
const DEPLOYMENT_FIELDS: FieldSpec[] = [...INSTANCE_FIELDS, COST, CPU, MEMORY];

/**
 * Selector del equivalente en otro entorno (`counterpartOf`): los recursos de los demás entornos, primero los de la misma clase. La
 * pista recuerda que basta declararlo en uno de los dos y dice quién declara a este como suyo, porque ese enlace no se ve en su propio campo.
 */
function counterpartField(doc: PlatformDocument, values?: Record<string, unknown>): FieldSpec {
  const [id, environmentId, kind] = [values?.id, values?.environmentId, values?.kind];
  const environmentName = (envId: string): string => doc.environments.find((e) => e.id === envId)?.name ?? envId;
  const others = doc.resources.filter((r) => r.id !== id && r.environmentId !== environmentId);
  const declaredBy = typeof id === 'string' ? doc.resources.filter((r) => r.counterpartOf === id) : [];
  return {
    key: 'counterpartOf',
    label: 'Equivalente en otro entorno',
    type: 'select',
    options: [...others.filter((r) => r.kind === kind), ...others.filter((r) => r.kind !== kind)].map((r) => ({ value: r.id, label: `${r.name} (${environmentName(r.environmentId)})` })),
    allowEmpty: true,
    hint: `El mismo recurso en otro entorno: al comparar entornos manda sobre la deducción por nombre. Basta declararlo en uno de los dos.${declaredBy.length > 0 ? ` Lo declaran como suyo: ${declaredBy.map((r) => `${r.name} (${environmentName(r.environmentId)})`).join(', ')}.` : ''}`,
  };
}

function nodeFields(kind: string, doc: PlatformDocument, values?: Record<string, unknown>): FieldSpec[] {
  const environment: FieldSpec = { key: 'environmentId', label: 'Entorno', type: 'select', options: doc.environments.map((e) => ({ value: e.id, label: e.name })) };
  const network = (key: string, label: string): FieldSpec => ({ key, label, type: 'select', options: doc.networks.map((n) => ({ value: n.id, label: `${n.name} (${doc.environments.find((e) => e.id === n.environmentId)?.name ?? n.environmentId})` })), allowEmpty: true });
  if ((SERVICE_KINDS as readonly string[]).includes(kind) || kind === 'external') {
    return [
      NAME,
      DESCRIPTION,
      { key: 'kind', label: 'Clase', type: 'select', options: options(SERVICE_KINDS, SERVICE_LABELS), allowEmpty: true },
      { key: 'technology', label: 'Tecnología', type: 'text' },
      { key: 'owner', label: 'Responsable', type: 'text' },
      { key: 'repo', label: 'Repositorio', type: 'text' },
      { key: 'criticality', label: 'Criticidad', type: 'select', options: options(CRITICALITIES, CRITICALITY_LABELS), allowEmpty: true },
      { key: 'slo', label: 'SLO (objetivo interno)', type: 'text', hint: 'p. ej. 99,9 % de disponibilidad' },
      { key: 'sla', label: 'SLA (compromiso con el cliente)', type: 'text', hint: 'p. ej. 99,5 %' },
      { key: 'external', label: 'Externo (SaaS, no se despliega aquí)', type: 'boolean' },
      ...iconFields(doc, values),
      REF,
      REF_TYPE_FIELD,
      TAGS,
    ];
  }
  if ((RESOURCE_KINDS as readonly string[]).includes(kind)) {
    return [
      NAME,
      DESCRIPTION,
      { key: 'kind', label: 'Clase', type: 'select', options: options(RESOURCE_KINDS, RESOURCE_LABELS) },
      environment,
      network('networkId', 'Red'),
      { key: 'technology', label: 'Tecnología', type: 'text' },
      { key: 'version', label: 'Versión', type: 'text' },
      { key: 'status', label: 'Estado', type: 'select', options: options(RESOURCE_STATUSES, STATUS_LABELS), allowEmpty: true, hint: 'si no se indica, aprovisionado' },
      { key: 'iac', label: 'Gestionado como código (IaC)', type: 'boolean' },
      counterpartField(doc, values),
      { key: 'owner', label: 'Responsable', type: 'text' },
      COST,
      { key: 'region', label: 'Región', type: 'text' },
      ...(kind === 'certificate' ? [EXPIRES] : []),
      CPU,
      MEMORY,
      ...iconFields(doc, values, kind as ResourceKind),
      REF,
      REF_TYPE_FIELD,
      TAGS,
    ];
  }
  switch (kind) {
    case 'network':
      return [NAME, DESCRIPTION, environment, network('parentId', 'Red que la contiene'), { key: 'exposure', label: 'Exposición', type: 'select', options: options(EXPOSURES, EXPOSURE_LABELS), allowEmpty: true, hint: 'si no se indica, privada' }, { key: 'cidr', label: 'CIDR', type: 'text' }, ...iconFields(doc, values, values?.parentId ? undefined : 'network')];
    case 'pipeline':
    case 'step':
      return [
        NAME,
        DESCRIPTION,
        { key: 'kind', label: 'Clase', type: 'select', options: options(PIPELINE_KINDS, PIPELINE_LABELS) },
        { key: 'tool', label: 'Herramienta', type: 'text' },
        { key: 'owner', label: 'Responsable', type: 'text' },
        { key: 'serviceIds', label: 'Servicios que construye o despliega', type: 'list', hint: 'ids de servicio' },
        { key: 'provisions', label: 'Recursos que aprovisiona (IaC)', type: 'list', hint: 'ids de recurso' },
        { key: 'stages', label: 'Entornos por los que promociona', type: 'list', hint: 'ids de entorno en orden; «prod*» pide aprobación manual' },
      ];
    case 'instance':
      return DEPLOYMENT_FIELDS;
    case 'environment':
      return [NAME, DESCRIPTION, { key: 'kind', label: 'Clase', type: 'select', options: options(ENVIRONMENT_KINDS, ENVIRONMENT_LABELS), allowEmpty: true }, { key: 'provider', label: 'Proveedor', type: 'text' }, { key: 'region', label: 'Región', type: 'text' }];
    default:
      return [NAME, DESCRIPTION];
  }
}

const EDGE_FIELDS: Record<string, FieldSpec[]> = {
  dependency: [
    { key: 'kind', label: 'Tipo', type: 'select', options: options(DEPENDENCY_KINDS, DEPENDENCY_LABELS) },
    { key: 'protocol', label: 'Protocolo', type: 'text' },
    DESCRIPTION,
  ],
  'runs-on': DEPLOYMENT_FIELDS,
  flow: [],
};

const clean = (value: unknown): unknown => (value === '' || value === null || value === false || (Array.isArray(value) && value.length === 0) ? undefined : value);

function patchObject<T extends object>(target: T, patch: Record<string, unknown>, allowed: string[]): T {
  const next: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const key of allowed) {
    if (!(key in patch)) continue;
    let value = clean(patch[key]);
    if ((key === 'replicas' || key === 'monthlyCost') && value !== undefined) value = Number(value);
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as T;
}

const stagesToText = (stages: PipelineStage[]): string[] => stages.map((s) => `${s.environmentId}${s.approval ? '*' : ''}`);
const parseStages = (text: unknown): PipelineStage[] =>
  (Array.isArray(text) ? (text as unknown[]).map(String) : []).map((t) => t.trim()).filter(Boolean).map((t) => (t.endsWith('*') ? { environmentId: t.slice(0, -1).trim(), approval: true } : { environmentId: t }));

/** Qué representa un id del lienzo: el elemento, una instancia de despliegue, un paso de pipeline o una flecha. */
type Target =
  | { type: 'element'; id: string }
  | { type: 'instance'; deploymentId: string }
  | { type: 'pipeline'; pipelineId: string; step?: string }
  | { type: 'dependency'; dependencyId: string }
  | { type: 'runs-on'; deploymentId: string }
  | { type: 'flow'; pipelineId: string; direction: 'in' | 'out'; elementId: string }
  | { type: 'flow-step'; pipelineId: string }
  | { type: 'cost-group'; environmentId: string };

function resolve(doc: PlatformDocument, id: string): Target | undefined {
  if (id.startsWith('i:')) return doc.deployments.some((d) => d.id === id.slice(2)) ? { type: 'instance', deploymentId: id.slice(2) } : undefined;
  if (id.startsWith('x:')) return doc.deployments.some((d) => d.id === id.slice(2)) ? { type: 'runs-on', deploymentId: id.slice(2) } : undefined;
  if (id.startsWith('c:')) return doc.environments.some((x) => x.id === id.slice(2)) ? { type: 'cost-group', environmentId: id.slice(2) } : undefined;
  if (id.startsWith('d:')) {
    const dependencyId = doc.dependencies.map((d) => d.id).find((did) => id === `d:${did}` || id.startsWith(`d:${did}:`));
    return dependencyId ? { type: 'dependency', dependencyId } : undefined;
  }
  if (id.startsWith('p:')) {
    const pipelineId = doc.pipelines.map((p) => p.id).find((pid) => id === `p:${pid}` || id.startsWith(`p:${pid}:`));
    if (!pipelineId) return undefined;
    const rest = id.slice(`p:${pipelineId}`.length + 1);
    if (rest === '') return { type: 'pipeline', pipelineId };
    if (rest.startsWith('in:')) return { type: 'flow', pipelineId, direction: 'in', elementId: rest.slice(3) };
    if (rest.startsWith('out:')) return { type: 'flow', pipelineId, direction: 'out', elementId: rest.slice(4) };
    if (/^e\d+$/.test(rest)) return { type: 'flow-step', pipelineId };
    return { type: 'pipeline', pipelineId, step: rest };
  }
  return indexElements(doc).has(id) ? { type: 'element', id } : undefined;
}

/** Servicio o recurso que hay detrás de un nodo del lienzo (una instancia es su servicio). */
function elementBehind(doc: PlatformDocument, nodeId: string): { kind: 'service' | 'resource'; id: string } | undefined {
  const target = resolve(doc, nodeId);
  if (target?.type === 'instance') return { kind: 'service', id: doc.deployments.find((d) => d.id === target.deploymentId)!.serviceId };
  if (target?.type === 'element') {
    const e = indexElements(doc).get(target.id)!;
    if (e.kind === 'service' || e.kind === 'resource') return { kind: e.kind, id: e.id };
  }
  return undefined;
}

const widthFor = (lines: string[], min: number): number => Math.min(300, Math.max(min, Math.ceil(Math.max(...lines.map((l, i) => l.length * (i === 0 ? 7.2 : 6.2))) + 32)));

/** Entorno en el que crear algo: el del contenedor elegido, el de la vista abierta o el primero del documento. */
function environmentFor(doc: PlatformDocument, parentId?: string, viewId?: string): string | undefined {
  const parent = parentId ? indexElements(doc).get(parentId) : undefined;
  if (parent && (parent.kind === 'network' || parent.kind === 'resource')) return (parent.item as { environmentId: string }).environmentId;
  if (viewId) {
    try {
      const env = findView(doc, viewId).environmentId;
      if (env) return env;
    } catch {
      /* vista desconocida: se sigue con el primer entorno */
    }
  }
  return doc.environments[0]?.id;
}

/** Instancias desplegadas que hay tras unos ids del lienzo: una instancia, su flecha «corre en» o un anfitrión con todo lo que aloja. */
function deploymentsBehind(doc: PlatformDocument, ids: string[]): Deployment[] {
  const found = new Map<string, Deployment>();
  for (const id of ids) {
    const target = resolve(doc, id);
    if (target?.type === 'instance' || target?.type === 'runs-on') {
      const d = doc.deployments.find((x) => x.id === target.deploymentId);
      if (d) found.set(d.id, d);
    } else if (target?.type === 'element') {
      for (const d of doc.deployments.filter((x) => x.hostId === target.id)) found.set(d.id, d);
    }
  }
  return [...found.values()];
}

/** Entorno único al que pertenece una selección (un recurso, una red, una instancia o el grupo de costes de un entorno), o un motivo si no hay uno. */
function environmentOfSelection(doc: PlatformDocument, ids: string[]): { environment?: Environment; reason?: string } {
  const found = new Set<string>();
  for (const id of ids) {
    const target = resolve(doc, id);
    if (target?.type === 'cost-group') found.add(target.environmentId);
    else if (target?.type === 'instance' || target?.type === 'runs-on') found.add(doc.deployments.find((d) => d.id === target.deploymentId)!.environmentId);
    else if (target?.type === 'element') {
      const e = indexElements(doc).get(target.id)!;
      if (e.kind === 'resource' || e.kind === 'network') found.add((e.item as { environmentId: string }).environmentId);
      else if (e.kind === 'environment') found.add(e.id);
    }
  }
  if (found.size === 0) return { reason: 'Selecciona un recurso, una red o una instancia del entorno que quieres duplicar.' };
  if (found.size > 1) return { reason: 'La selección mezcla varios entornos: elige elementos de uno solo.' };
  const environment = doc.environments.find((e) => e.id === [...found][0]);
  return environment ? { environment } : { reason: 'No se encuentra el entorno.' };
}

/** Insignias de un recurso, una instancia o un servicio: coste, región, límites y objetivos de servicio. */
function metadataBadges(doc: PlatformDocument, nodeId: string, includeCost: boolean): string[] {
  const target = resolve(doc, nodeId);
  const limits = (x: { cpuLimit?: string; memoryLimit?: string }): string[] => {
    const text = [x.cpuLimit ? `CPU ${x.cpuLimit}` : '', x.memoryLimit ? `mem ${x.memoryLimit}` : ''].filter(Boolean).join(' · ');
    return text ? [text] : [];
  };
  const objectives = (s: { slo?: string; sla?: string } | undefined): string[] => {
    const text = [s?.slo ? `SLO ${s.slo}` : '', s?.sla ? `SLA ${s.sla}` : ''].filter(Boolean).join(' · ');
    return text ? [text] : [];
  };
  const cost = (x: { monthlyCost?: number }): string[] => (includeCost && x.monthlyCost !== undefined ? [formatCost(x.monthlyCost, doc)] : []);
  if (target?.type === 'instance') {
    const d = doc.deployments.find((x) => x.id === target.deploymentId)!;
    const s = doc.services.find((x) => x.id === d.serviceId);
    return [...objectives(s), ...limits(d), ...cost(d)];
  }
  if (target?.type === 'element') {
    const r = doc.resources.find((x) => x.id === target.id);
    if (r) return [...cost(r), ...(r.region ? [`región ${r.region}`] : []), ...(r.expiresAt ? [`caduca ${r.expiresAt}`] : []), ...limits(r)];
    const s = doc.services.find((x) => x.id === target.id);
    if (s) return objectives(s);
  }
  return [];
}

/** La instancia desplegada que representa un id del lienzo, si lo es. */
function instanceOf(doc: PlatformDocument, nodeId: string): Deployment | undefined {
  const target = resolve(doc, nodeId);
  return target?.type === 'instance' ? doc.deployments.find((d) => d.id === target.deploymentId) : undefined;
}

const ok = (document: PlatformDocument, id?: string): EditResult<PlatformDocument> => ({ ok: true, document, id });
const fail = (reason: string): EditResult<PlatformDocument> => ({ ok: false, reason });

const NO_INSTANCES = 'Selecciona una o varias instancias desplegadas (o un clúster o máquina con servicios).';

/** Etapas de despliegue de pipeline (`p:<pipeline>:s<n>`) que hay en una selección, por pipeline. */
function stagesIn(doc: PlatformDocument, ids: string[]): Map<string, number[]> {
  const found = new Map<string, number[]>();
  for (const id of ids) {
    const target = resolve(doc, id);
    const index = target?.type === 'pipeline' && target.step ? /^s(\d+)$/.exec(target.step)?.[1] : undefined;
    if (target?.type === 'pipeline' && index !== undefined) found.set(target.pipelineId, [...(found.get(target.pipelineId) ?? []), Number(index)]);
  }
  return found;
}

const environmentNames = (doc: PlatformDocument): string[] => doc.environments.map((e) => e.name);

/** Operaciones sobre la selección del lienzo (la barra las muestra tras los botones de edición). */
const ACTIONS: Array<EditorAction<PlatformDocument>> = [
  {
    id: 'promote-environment',
    label: 'Promover a otro entorno…',
    hint: 'Despliega las instancias seleccionadas (o todas las de un clúster) en otro entorno, con su versión; si ya corren allí, solo les pasa la versión',
    needs: 'many',
    prompt: {
      label: 'Entorno de destino',
      placeholder: 'Producción',
      initial: (doc, ids) => {
        const first = deploymentsBehind(doc, ids)[0];
        return (first && nextEnvironment(doc, first.environmentId)?.name) || '';
      },
      suggestions: environmentNames,
    },
    disabled: (doc, ids) => (deploymentsBehind(doc, ids).length === 0 ? NO_INSTANCES : doc.environments.length < 2 ? 'El documento solo tiene un entorno.' : undefined),
    run(doc, ids, input) {
      const target = findEnvironment(doc, input ?? '');
      if (!target) return fail(`No existe el entorno «${input ?? ''}». Entornos: ${environmentNames(doc).join(', ')}.`);
      return promoteDeployments(doc, deploymentsBehind(doc, ids).map((d) => d.id), target);
    },
  },
  {
    id: 'duplicate-environment',
    label: 'Duplicar entorno…',
    hint: 'Copia el entorno de la selección (redes, recursos, instancias y las dependencias de sus recursos) con un nombre nuevo; los pipelines lo añaden como etapa',
    needs: 'many',
    prompt: {
      label: 'Nombre del entorno nuevo',
      placeholder: 'Preproducción 2',
      initial: (doc, ids) => {
        const { environment } = environmentOfSelection(doc, ids);
        return environment ? `${environment.name} (copia)` : '';
      },
    },
    disabled: (doc, ids) => environmentOfSelection(doc, ids).reason,
    run(doc, ids, input) {
      const { environment, reason } = environmentOfSelection(doc, ids);
      return environment ? duplicateEnvironment(doc, environment.id, input ?? '') : fail(reason ?? 'Selecciona un elemento del entorno.');
    },
  },
  {
    id: 'scale-replicas',
    label: 'Escalar réplicas…',
    hint: 'Cambia las réplicas de las instancias seleccionadas: un número (5), una suma o resta (+2, -1) o un factor (x2)',
    needs: 'many',
    prompt: { label: 'Réplicas (5, +2, -1, x2)', placeholder: '+2' },
    disabled: (doc, ids) => (deploymentsBehind(doc, ids).length === 0 ? NO_INSTANCES : undefined),
    run: (doc, ids, input) => scaleReplicas(doc, deploymentsBehind(doc, ids).map((d) => d.id), input),
  },
  {
    id: 'toggle-approval',
    label: 'Puerta de aprobación',
    hint: 'Pide (o quita) la aprobación manual antes de desplegar en las etapas de pipeline seleccionadas',
    needs: 'many',
    disabled: (doc, ids) => (stagesIn(doc, ids).size === 0 ? 'Selecciona una o varias etapas de despliegue de un pipeline.' : undefined),
    run(doc, ids) {
      let next = doc;
      for (const [pipelineId, stages] of stagesIn(doc, ids)) {
        const result = toggleApproval(next, pipelineId, stages);
        if (!result.ok) return result;
        next = result.document;
      }
      return ok(next);
    },
  },
];

export const platformEditor: EditorSpec<PlatformDocument> = {
  nodeKinds: NODE_KIND_NOTATION,
  edgeKinds: EDGE_KIND_NOTATION,
  defaultEdgeKind: 'calls',

  project(doc, viewId): EditorGraph {
    const view = findView(doc, viewId);
    // La comparación de varios entornos es una matriz: su escena, su leyenda y su colocación vienen de `drawMatrix`.
    const matrix = matrixIsDrawn(view) ? drawMatrix(doc, view) : undefined;
    const scene = matrix?.scene ?? buildScene(doc, view);
    const all = indexElements(doc);
    // El equivalente declarado en otro entorno se marca en el recurso; la comparación ya empareja los dos lados y no necesita la marca.
    const twins = view.type === 'compare' ? new Map<string, NodeMark[]>() : counterpartMarks(doc);
    const networks = new Map(doc.networks.map((n) => [n.id, n]));
    const kinds = new Map(NODE_KIND_NOTATION.map((k) => [k.kind, k]));
    const nodes: EditorNode[] = [];
    for (const [id, g] of scene.groups) {
      const element = all.get(g.elementId);
      const network = networks.get(g.elementId);
      const kind = network ? 'network' : element?.kind === 'pipeline' ? 'pipeline' : element?.kind === 'environment' ? 'environment' : ((element?.item as Resource | undefined)?.kind ?? 'other');
      // El lienzo antepone la clase al título del grupo, así que el título lleva solo el nombre y lo que lo caracteriza.
      const label = network
        ? `${network.name} · ${EXPOSURE_LABELS[exposureOf(network)]}${network.cidr ? ` (${network.cidr})` : ''}`
        : element?.kind === 'pipeline'
          ? `${element.name} · ${PIPELINE_LABELS[(element.item as Pipeline).kind]}${(element.item as Pipeline).tool ? ` (${(element.item as Pipeline).tool})` : ''}`
          : element?.kind === 'environment'
            ? g.label
            : [element?.name ?? g.label, ...metadataBadges(doc, g.elementId, true)].join(' · ');
      nodes.push({
        id,
        kind,
        label,
        parentId: g.groupId,
        ref: (element?.item as { ref?: string } | undefined)?.ref,
        ...(twins.has(g.elementId) ? { marks: twins.get(g.elementId) } : {}),
        fill: network ? NETWORK_FILLS[exposureOf(network)] : undefined,
        ...(network ? { border: EXPOSURE_ZONES[exposureOf(network)].border } : {}),
        ...(g.icon ? { icon: g.icon.paths, iconColor: g.icon.color } : {}),
      });
    }
    for (const [id, n] of scene.nodes) {
      const [label = id, ...rest] = n.lines;
      const notation = kinds.get(n.cls) ?? kinds.get('other')!;
      const shownAsInstance = id.startsWith('i:');
      nodes.push({
        id,
        kind: n.cls,
        label,
        sublabel: rest[0],
        badges: [...(n.diff && n.badge ? [n.badge] : []), ...rest.slice(1).filter(Boolean), ...(matrix ? [] : metadataBadges(doc, id, view.type !== 'costs'))],
        parentId: n.groupId,
        ref: shownAsInstance ? undefined : (n.elementId ? (all.get(n.elementId)?.item as { ref?: string } | undefined)?.ref : undefined),
        ...(!shownAsInstance && n.elementId && twins.has(n.elementId) ? { marks: twins.get(n.elementId) } : {}),
        fill: n.fill,
        stroke: n.stroke === '#0f172a55' ? undefined : n.stroke,
        dashed: n.dashed,
        width: widthFor(n.lines, notation.width),
        ...(n.icon && n.iconColor ? { icon: n.icon, iconColor: n.iconColor } : {}),
      });
    }
    return {
      nodes,
      edges: [...scene.edges].map(([id, e]) => ({ id, kind: e.kind, source: e.source, target: e.target, label: e.label })),
      ...(matrix ? { legend: matrix.legend } : {}),
    };
  },

  fields(target, doc, values) {
    if (target.type === 'node') return nodeFields(target.kind, doc, values);
    return EDGE_FIELDS[(DEPENDENCY_KINDS as readonly string[]).includes(target.kind) ? 'dependency' : target.kind] ?? [];
  },

  read(doc, id) {
    const target = resolve(doc, id);
    if (!target) return undefined;
    switch (target.type) {
      case 'element': {
        const e = indexElements(doc).get(target.id)!;
        if (e.kind === 'service') return { type: 'node', kind: (e.item as Service).external ? 'external' : ((e.item as Service).kind ?? 'service'), values: canonicalProvider(doc, { ...(e.item as Service) }) };
        if (e.kind === 'resource') return { type: 'node', kind: (e.item as Resource).kind, values: canonicalProvider(doc, { ...(e.item as Resource) }) };
        if (e.kind === 'pipeline') return { type: 'node', kind: 'pipeline', values: { ...e.item, stages: stagesToText((e.item as Pipeline).stages) } };
        return { type: 'node', kind: e.kind, values: e.kind === 'network' ? canonicalProvider(doc, { ...(e.item as Network) }) : { ...e.item } };
      }
      case 'pipeline': {
        const p = doc.pipelines.find((x) => x.id === target.pipelineId)!;
        return { type: 'node', kind: 'pipeline', values: { ...p, stages: stagesToText(p.stages) } };
      }
      case 'instance':
      case 'runs-on': {
        const d = doc.deployments.find((x) => x.id === target.deploymentId)!;
        return { type: target.type === 'instance' ? 'node' : 'edge', kind: target.type === 'instance' ? 'instance' : 'runs-on', values: { ...d, replicas: d.replicas === undefined ? '' : String(d.replicas) } };
      }
      case 'dependency': {
        const d = doc.dependencies.find((x) => x.id === target.dependencyId)!;
        return { type: 'edge', kind: d.kind, values: { ...d } };
      }
      case 'cost-group': {
        const env = doc.environments.find((x) => x.id === target.environmentId)!;
        return { type: 'node', kind: 'environment', values: { ...env } };
      }
      default:
        return { type: 'edge', kind: 'flow', values: {} };
    }
  },

  addNode(doc, kind, name, parentId, viewId) {
    const taken = [...indexElements(doc).keys()];
    const parent = parentId ? resolve(doc, parentId) : undefined;
    const parentElement = parent?.type === 'element' ? indexElements(doc).get(parent.id) : undefined;
    if ((SERVICE_KINDS as readonly string[]).includes(kind)) {
      const id = uniqueId(name, taken);
      const created: Service = { id, name, ...(kind !== 'service' ? { kind: kind as ServiceKind } : {}) };
      let deployments = doc.deployments;
      // En la vista de un entorno el servicio nace desplegado: en el anfitrión elegido o, si no, en el primero del entorno.
      const environmentId = viewId ? environmentFor(doc, undefined, viewId) : undefined;
      const view = viewId ? findView(doc, viewId) : undefined;
      if (view?.type === 'environment' && environmentId) {
        const chosen = parentElement?.kind === 'resource' && isHost(parentElement.item as Resource) && (parentElement.item as Resource).environmentId === environmentId ? (parentElement.item as Resource) : undefined;
        const host = chosen ?? doc.resources.find((r) => r.environmentId === environmentId && isHost(r));
        if (host) deployments = [...deployments, { id: uniqueId(`${id}-${environmentId}`, deployments.map((d) => d.id)), serviceId: id, environmentId, hostId: host.id }];
      }
      return ok({ ...doc, services: [...doc.services, created], deployments }, id);
    }
    if ((RESOURCE_KINDS as readonly string[]).includes(kind)) {
      const environmentId = environmentFor(doc, parentId, viewId);
      if (!environmentId) return fail('Añade primero un entorno al documento (pestaña JSON): todo recurso pertenece a uno.');
      const id = uniqueId(name, taken);
      const networkId = parentElement?.kind === 'network' ? parentElement.id : parentElement?.kind === 'resource' ? (parentElement.item as Resource).networkId : undefined;
      const misplaced = placementViolation(doc, kind as ResourceKind, networkId);
      if (misplaced) return fail(misplaced);
      const created: Resource = { id, name, kind: kind as ResourceKind, environmentId, ...(networkId ? { networkId } : {}) };
      return ok({ ...doc, resources: [...doc.resources, created] }, id);
    }
    if (kind === 'network') {
      const environmentId = environmentFor(doc, parentId, viewId);
      if (!environmentId) return fail('Añade primero un entorno al documento (pestaña JSON): toda red pertenece a uno.');
      const id = uniqueId(name, taken);
      const created: Network = { id, name, environmentId, ...(parentElement?.kind === 'network' ? { parentId: parentElement.id } : {}) };
      return ok({ ...doc, networks: [...doc.networks, created] }, id);
    }
    if (kind === 'pipeline') {
      const id = uniqueId(name, taken);
      const created: Pipeline = { id, name, kind: 'ci-cd', serviceIds: [], stages: doc.environments.map((e) => ({ environmentId: e.id, ...(e.kind === 'prod' ? { approval: true } : {}) })) };
      return ok({ ...doc, pipelines: [...doc.pipelines, created] }, `p:${id}`);
    }
    return fail(`Tipo de elemento desconocido: ${kind}`);
  },

  addEdge(doc, kind, sourceId, targetId) {
    const reason = platformEditor.canConnect?.(doc, kind, sourceId, targetId);
    if (reason) return fail(reason);
    const source = elementBehind(doc, sourceId);
    const target = elementBehind(doc, targetId);
    if ((DEPENDENCY_KINDS as readonly string[]).includes(kind)) {
      const id = uniqueId(`${source!.id}-${target!.id}`, doc.dependencies.map((d) => d.id));
      const created: Dependency = { id, sourceId: source!.id, targetId: target!.id, kind: kind as DependencyKind };
      return ok({ ...doc, dependencies: [...doc.dependencies, created] }, `d:${id}`);
    }
    if (kind === 'runs-on') {
      const host = doc.resources.find((r) => r.id === target!.id)!;
      const id = uniqueId(`${source!.id}-${host.environmentId}`, doc.deployments.map((d) => d.id));
      const created: Deployment = { id, serviceId: source!.id, environmentId: host.environmentId, hostId: host.id };
      return ok({ ...doc, deployments: [...doc.deployments, created] }, `x:${id}`);
    }
    // flow: servicio → pipeline (lo construye) o pipeline → recurso (lo aprovisiona)
    const from = resolve(doc, sourceId);
    const to = resolve(doc, targetId);
    const pipelineId = from?.type === 'pipeline' ? from.pipelineId : to?.type === 'pipeline' ? to.pipelineId : undefined;
    const pipelines = doc.pipelines.map((p) => {
      if (p.id !== pipelineId) return p;
      if (to?.type === 'pipeline') return { ...p, serviceIds: [...p.serviceIds, source!.id] };
      return { ...p, provisions: [...(p.provisions ?? []), target!.id] };
    });
    return ok({ ...doc, pipelines }, to?.type === 'pipeline' ? `p:${pipelineId}:in:${source!.id}` : `p:${pipelineId}:out:${target!.id}`);
  },

  update(doc, id, patch) {
    const target = resolve(doc, id);
    if (!target) return fail(`No existe «${id}».`);
    if (typeof patch.name === 'string' && patch.name.trim() === '') return fail('El nombre no puede estar vacío.');
    const all = indexElements(doc);
    switch (target.type) {
      case 'element': {
        const e = all.get(target.id)!;
        if (e.kind === 'service') {
          const patched = reconcileIcon(doc, patchObject(e.item as Service, patch, ['name', 'description', 'kind', 'technology', 'owner', 'repo', 'criticality', 'slo', 'sla', 'external', 'ref', 'refType', 'tags', 'provider', 'service']), patch, subjectOfService);
          if (!patched.ok) return fail(patched.reason);
          return ok({ ...doc, services: doc.services.map((s) => (s.id === e.id ? patched.value : s)) }, id);
        }
        if (e.kind === 'resource') {
          const current = e.item as Resource;
          const patched = reconcileIcon(doc, patchObject(current, patch, ['name', 'description', 'kind', 'environmentId', 'networkId', 'technology', 'version', 'status', 'iac', 'owner', 'ref', 'refType', 'tags', 'monthlyCost', 'region', 'cpuLimit', 'memoryLimit', 'expiresAt', 'provider', 'service', 'counterpartOf']), patch, subjectOfResource);
          if (!patched.ok) return fail(patched.reason);
          const next = patched.value;
          if (next.expiresAt !== undefined && !resourceSchema.shape.expiresAt.safeParse(next.expiresAt).success) return fail('La fecha de caducidad debe tener la forma AAAA-MM-DD (p. ej. 2026-12-31).');
          if (next.monthlyCost !== undefined && (!Number.isFinite(next.monthlyCost) || next.monthlyCost < 0)) return fail('El coste mensual es un número igual o mayor que cero.');
          // Solo se comprueba lo que cambia: un documento que ya incumple la regla sigue editándose.
          const misplaced = next.kind !== current.kind || next.networkId !== current.networkId ? placementViolation(doc, next.kind, next.networkId) : undefined;
          if (misplaced) return fail(misplaced);
          const network = next.networkId ? doc.networks.find((n) => n.id === next.networkId) : undefined;
          if (next.networkId && !network) return fail(`No existe la red «${next.networkId}».`);
          if (network && network.environmentId !== next.environmentId) return fail(`La red «${network.name}» es del entorno «${network.environmentId}», no de «${next.environmentId}».`);
          if (!doc.environments.some((x) => x.id === next.environmentId)) return fail(`No existe el entorno «${next.environmentId}».`);
          const updated = { ...doc, resources: doc.resources.map((r) => (r.id === e.id ? next : r)) };
          // Cambiar el equivalente o el entorno no puede dejar una equivalencia rota o ambigua; solo se avisa de lo que el cambio introduce.
          if (next.counterpartOf !== current.counterpartOf || next.environmentId !== current.environmentId) {
            const known = new Set(counterpartErrors(doc).map((x) => x.message));
            const introduced = counterpartErrors(updated).find((x) => !known.has(x.message));
            if (introduced) return fail(introduced.message);
          }
          return ok(updated, id);
        }
        if (e.kind === 'network') {
          const patchedNetwork = reconcileIcon(doc, patchObject(e.item as Network, patch, ['name', 'description', 'environmentId', 'parentId', 'exposure', 'cidr', 'provider', 'service']), patch, subjectOfNetwork);
          if (!patchedNetwork.ok) return fail(patchedNetwork.reason);
          const next = patchedNetwork.value;
          if (next.parentId === next.id) return fail('Una red no puede contenerse a sí misma.');
          const exposed = next.exposure !== (e.item as Network).exposure ? exposureViolation(doc, e.id, next.exposure) : undefined;
          if (exposed) return fail(exposed);
          const parent = next.parentId ? doc.networks.find((n) => n.id === next.parentId) : undefined;
          if (next.parentId && !parent) return fail(`No existe la red «${next.parentId}».`);
          if (parent && parent.environmentId !== next.environmentId) return fail('La red y la que la contiene deben ser del mismo entorno.');
          return ok({ ...doc, networks: doc.networks.map((n) => (n.id === e.id ? next : n)) }, id);
        }
        if (e.kind === 'pipeline') return updatePipeline(doc, e.id, patch, id);
        return ok({ ...doc, environments: doc.environments.map((x) => (x.id === e.id ? patchObject(x, patch, ['name', 'description', 'kind', 'provider', 'region']) : x)) }, id);
      }
      case 'pipeline':
        return updatePipeline(doc, target.pipelineId, patch, id);
      case 'instance':
      case 'runs-on': {
        if (typeof patch.replicas === 'string' && patch.replicas !== '' && !/^\d+$/.test(patch.replicas.trim())) return fail('Las réplicas son un número entero.');
        const next = doc.deployments.map((d) => (d.id === target.deploymentId ? patchObject(d, patch, ['replicas', 'version', 'monthlyCost', 'cpuLimit', 'memoryLimit']) : d));
        const cost = next.find((d) => d.id === target.deploymentId)!.monthlyCost;
        if (cost !== undefined && (!Number.isFinite(cost) || cost < 0)) return fail('El coste mensual es un número igual o mayor que cero.');
        return ok({ ...doc, deployments: next }, id);
      }
      case 'dependency': {
        const next = doc.dependencies.map((d) => (d.id === target.dependencyId ? patchObject(d, patch, ['kind', 'protocol', 'description']) : d));
        const edited = next.find((d) => d.id === target.dependencyId)!;
        if (!(DEPENDENCY_KINDS as readonly string[]).includes(edited.kind)) return fail(`Tipo de dependencia desconocido: ${String(edited.kind)}`);
        return ok({ ...doc, dependencies: next }, id);
      }
      case 'cost-group':
        return ok({ ...doc, environments: doc.environments.map((x) => (x.id === target.environmentId ? patchObject(x, patch, ['name', 'description', 'kind', 'provider', 'region']) : x)) }, id);
      default:
        return fail('El flujo de un pipeline se edita en el propio pipeline.');
    }
  },

  remove(doc, id) {
    const target = resolve(doc, id);
    if (!target) return fail(`No existe «${id}».`);
    switch (target.type) {
      case 'element':
        return ok(removeElement(doc, target.id));
      case 'pipeline':
        return ok({ ...doc, pipelines: doc.pipelines.filter((p) => p.id !== target.pipelineId) });
      case 'instance':
      case 'runs-on':
        return ok({ ...doc, deployments: doc.deployments.filter((d) => d.id !== target.deploymentId) });
      case 'dependency':
        return ok({ ...doc, dependencies: doc.dependencies.filter((d) => d.id !== target.dependencyId) });
      case 'flow':
        return ok({
          ...doc,
          pipelines: doc.pipelines.map((p) =>
            p.id !== target.pipelineId ? p : target.direction === 'in' ? { ...p, serviceIds: p.serviceIds.filter((s) => s !== target.elementId) } : { ...p, provisions: (p.provisions ?? []).filter((r) => r !== target.elementId) },
          ),
        });
      case 'cost-group':
        return fail('Un entorno no se quita desde la vista de costes: bórralo en la pestaña JSON.');
      default:
        return fail('Los pasos de un pipeline se quitan editando sus entornos.');
    }
  },

  /** Solo la matriz de comparación de varios entornos tiene colocación propia (una cuadrícula); las demás vistas, el autolayout por capas. */
  layout(doc, viewId) {
    const view = findView(doc, viewId);
    return matrixIsDrawn(view) ? drawMatrix(doc, view).layout : undefined;
  },

  canConnect(doc, kind, sourceId, targetId) {
    if (sourceId === targetId) return 'Un elemento no puede unirse consigo mismo.';
    const source = elementBehind(doc, sourceId);
    const target = elementBehind(doc, targetId);
    if ((DEPENDENCY_KINDS as readonly string[]).includes(kind)) {
      if (!source || !target) return 'Una dependencia une servicios o recursos.';
      if (source.id === target.id) return 'Un elemento no puede depender de sí mismo.';
      if (doc.dependencies.some((d) => d.kind === kind && d.sourceId === source.id && d.targetId === target.id)) return 'Esa dependencia ya existe.';
      return dependencyEnvironmentViolation(doc, source.id, target.id, instanceOf(doc, sourceId), instanceOf(doc, targetId));
    }
    if (kind === 'runs-on') {
      if (source?.kind !== 'service') return '«corre en» va de un servicio al clúster o máquina donde se despliega.';
      const s = doc.services.find((x) => x.id === source.id)!;
      if (s.external) return 'Un servicio externo no se despliega en la plataforma.';
      const host = target?.kind === 'resource' ? doc.resources.find((r) => r.id === target.id) : undefined;
      const misplaced = hostViolation(host, instanceOf(doc, sourceId));
      if (misplaced) return misplaced;
      if (doc.deployments.some((d) => d.serviceId === s.id && d.hostId === host!.id)) return 'Ese servicio ya corre en ese anfitrión.';
      return undefined;
    }
    if (kind === 'flow') {
      const from = resolve(doc, sourceId);
      const to = resolve(doc, targetId);
      if (source?.kind === 'service' && to?.type === 'pipeline') {
        const p = doc.pipelines.find((x) => x.id === to.pipelineId)!;
        if (doc.services.find((s) => s.id === source.id)?.external) return 'Ningún pipeline construye un servicio externo.';
        return p.serviceIds.includes(source.id) ? 'Ese pipeline ya construye ese servicio.' : undefined;
      }
      if (from?.type === 'pipeline' && target?.kind === 'resource') {
        const p = doc.pipelines.find((x) => x.id === from.pipelineId)!;
        if (p.kind !== 'iac') return 'Solo un pipeline de infraestructura como código aprovisiona recursos.';
        return (p.provisions ?? []).includes(target.id) ? 'Ese pipeline ya aprovisiona ese recurso.' : undefined;
      }
      return '«pasa por» va de un servicio a un pipeline (lo construye) o de un pipeline IaC a un recurso (lo aprovisiona).';
    }
    return `Tipo de relación desconocido: ${kind}`;
  },

  actions: ACTIONS,
};

function updatePipeline(doc: PlatformDocument, pipelineId: string, patch: Record<string, unknown>, id: string): EditResult<PlatformDocument> {
  const p = doc.pipelines.find((x) => x.id === pipelineId)!;
  const next = patchObject(p, patch, ['name', 'description', 'kind', 'tool', 'owner', 'serviceIds', 'provisions']);
  if (!('serviceIds' in next) || !Array.isArray(next.serviceIds)) next.serviceIds = [];
  if ('stages' in patch) next.stages = parseStages(patch.stages);
  const missingService = next.serviceIds.find((s) => !doc.services.some((x) => x.id === s));
  if (missingService) return fail(`No existe el servicio «${missingService}».`);
  const missingResource = (next.provisions ?? []).find((r) => !doc.resources.some((x) => x.id === r));
  if (missingResource) return fail(`No existe el recurso «${missingResource}».`);
  const missingEnv = next.stages.find((s) => !doc.environments.some((e) => e.id === s.environmentId));
  if (missingEnv) return fail(`No existe el entorno «${missingEnv.environmentId}».`);
  if (next.provisions && next.provisions.length > 0 && next.kind !== 'iac') return fail('Solo un pipeline de infraestructura como código (iac) aprovisiona recursos.');
  return ok({ ...doc, pipelines: doc.pipelines.map((x) => (x.id === pipelineId ? next : x)) }, id);
}

/** Quita un servicio, recurso, red, pipeline o entorno y todo lo que lo referencia. */
function removeElement(doc: PlatformDocument, id: string): PlatformDocument {
  const e = indexElements(doc).get(id)!;
  switch (e.kind) {
    case 'service':
      return {
        ...doc,
        services: doc.services.filter((s) => s.id !== id),
        deployments: doc.deployments.filter((d) => d.serviceId !== id),
        dependencies: doc.dependencies.filter((d) => d.sourceId !== id && d.targetId !== id),
        pipelines: doc.pipelines.map((p) => ({ ...p, serviceIds: p.serviceIds.filter((s) => s !== id) })),
      };
    case 'resource':
      return {
        ...doc,
        resources: dropCounterparts(doc.resources, new Set([id])),
        deployments: doc.deployments.filter((d) => d.hostId !== id),
        dependencies: doc.dependencies.filter((d) => d.sourceId !== id && d.targetId !== id),
        pipelines: doc.pipelines.map((p) => (p.provisions ? { ...p, provisions: p.provisions.filter((r) => r !== id) } : p)),
      };
    case 'network': {
      const parent = (e.item as Network).parentId;
      return {
        ...doc,
        networks: doc.networks.filter((n) => n.id !== id).map((n) => (n.parentId === id ? (parent ? { ...n, parentId: parent } : (({ parentId: _p, ...rest }) => rest)(n)) : n)),
        resources: doc.resources.map((r) => (r.networkId === id ? (parent ? { ...r, networkId: parent } : (({ networkId: _n, ...rest }) => rest)(r)) : r)),
      };
    }
    case 'pipeline':
      return { ...doc, pipelines: doc.pipelines.filter((p) => p.id !== id) };
    default: {
      const gone = new Set([...doc.resources.filter((r) => r.environmentId === id).map((r) => r.id)]);
      return {
        ...doc,
        environments: doc.environments.filter((x) => x.id !== id),
        networks: doc.networks.filter((n) => n.environmentId !== id),
        resources: dropCounterparts(doc.resources, gone),
        deployments: doc.deployments.filter((d) => d.environmentId !== id),
        dependencies: doc.dependencies.filter((d) => !gone.has(d.sourceId) && !gone.has(d.targetId)),
        pipelines: doc.pipelines.map((p) => ({ ...p, stages: p.stages.filter((s) => s.environmentId !== id), ...(p.provisions ? { provisions: p.provisions.filter((r) => !gone.has(r)) } : {}) })),
      };
    }
  }
}

export { stagesToText, parseStages };
