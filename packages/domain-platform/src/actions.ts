import { uniqueId, type EditResult } from '@iark/kernel';
import { counterpartsOf, type Counterparts } from './counterparts';
import { ENVIRONMENT_KINDS, indexElements, isHost, statusOf, type Deployment, type Dependency, type Environment, type Network, type PlatformDocument, type Resource } from './types';

/**
 * Operaciones del editor sobre la selección (promover, duplicar un entorno, escalar réplicas, pedir aprobación). Son
 * funciones puras de documento a documento; el editor las conecta con los ids del lienzo.
 */

const ok = (document: PlatformDocument, id?: string): EditResult<PlatformDocument> => ({ ok: true, document, id });
const fail = (reason: string): EditResult<PlatformDocument> => ({ ok: false, reason });

/** El entorno que nombra un texto: por id o por nombre, sin distinguir mayúsculas. */
export function findEnvironment(doc: PlatformDocument, text: string): Environment | undefined {
  const wanted = text.trim().toLowerCase();
  if (!wanted) return undefined;
  return doc.environments.find((e) => e.id.toLowerCase() === wanted) ?? doc.environments.find((e) => e.name.trim().toLowerCase() === wanted);
}

/** El entorno que sigue a otro en el camino a producción (dev → test → staging → prod), para proponerlo como destino de una promoción. */
export function nextEnvironment(doc: PlatformDocument, environmentId: string): Environment | undefined {
  const rank = (e: Environment): number => (e.kind ? ENVIRONMENT_KINDS.indexOf(e.kind) : -1);
  const from = doc.environments.find((e) => e.id === environmentId);
  if (!from || rank(from) < 0) return undefined;
  return doc.environments
    .filter((e) => rank(e) > rank(from) && e.kind !== 'dr')
    .sort((a, b) => rank(a) - rank(b))[0];
}

/** Anfitrión de otro entorno que mejor sustituye a `source`: de su misma clase y, si hay varios, en una red de la misma exposición. */
function hostFor(doc: PlatformDocument, source: Resource | undefined, environmentId: string): Resource | undefined {
  const candidates = doc.resources.filter((r) => r.environmentId === environmentId && isHost(r) && statusOf(r) !== 'decommissioned');
  const exposure = (r: Resource | undefined): string | undefined => doc.networks.find((n) => n.id === r?.networkId)?.exposure ?? (r?.networkId ? 'private' : undefined);
  const wanted = exposure(source);
  return candidates.find((r) => r.kind === source?.kind && exposure(r) === wanted) ?? candidates.find((r) => r.kind === source?.kind) ?? candidates[0];
}

/**
 * Recurso del entorno destino que sustituye a `source`: el que él (o quien lo declara) dice que es su equivalente (`counterpartOf`) y,
 * si no hay, el de su mismo nombre y clase o, si no, el único de su clase (y tecnología, si hay varios). Un equivalente declarado que
 * está dado de baja no se sustituye por otro: no hay equivalente.
 */
function counterpartResource(doc: PlatformDocument, source: Resource, environmentId: string, counterparts: Counterparts): Resource | undefined {
  const declared = counterparts.in(source, environmentId);
  if (declared) return statusOf(declared) === 'decommissioned' ? undefined : declared;
  const candidates = doc.resources.filter((r) => r.environmentId === environmentId && r.kind === source.kind && statusOf(r) !== 'decommissioned');
  const name = source.name.trim().toLowerCase();
  const tech = (source.technology ?? '').trim().toLowerCase();
  const sameTechnology = tech ? candidates.filter((r) => (r.technology ?? '').trim().toLowerCase() === tech) : [];
  return candidates.find((r) => r.name.trim().toLowerCase() === name) ?? (candidates.length === 1 ? candidates[0] : sameTechnology.length === 1 ? sameTechnology[0] : undefined);
}

/**
 * Lleva instancias desplegadas a otro entorno: si el servicio ya corre allí, le pasa la versión; si no, lo despliega en el
 * clúster o la máquina que mejor encaja (con la versión y los límites de la instancia de origen). Las dependencias del
 * servicio de recursos del entorno de origen (su base de datos, su cola) se repiten sobre el recurso equivalente del destino
 * (el que declara `counterpartOf`, el del mismo nombre o el único de su clase); si no hay equivalente, no se inventa ninguna.
 */
export function promoteDeployments(doc: PlatformDocument, deploymentIds: string[], target: Environment): EditResult<PlatformDocument> {
  const sources = doc.deployments.filter((d) => deploymentIds.includes(d.id));
  if (sources.length === 0) return fail('Selecciona una o varias instancias desplegadas (o su clúster).');
  const movable = sources.filter((d) => d.environmentId !== target.id);
  if (movable.length === 0) return fail(`Lo seleccionado ya está en el entorno «${target.name}».`);
  const services = new Map(doc.services.map((s) => [s.id, s]));
  let deployments = [...doc.deployments];
  let firstId: string | undefined;
  for (const source of movable) {
    const name = services.get(source.serviceId)?.name ?? source.serviceId;
    const existing = deployments.find((d) => d.serviceId === source.serviceId && d.environmentId === target.id);
    if (existing) {
      deployments = deployments.map((d) => (d === existing ? { ...d, ...(source.version !== undefined ? { version: source.version } : {}) } : d));
      firstId ??= existing.id;
      continue;
    }
    const host = hostFor(doc, doc.resources.find((r) => r.id === source.hostId), target.id);
    if (!host) return fail(`El entorno «${target.name}» no tiene clúster ni máquina donde desplegar «${name}»: crea uno primero.`);
    const created: Deployment = {
      id: uniqueId(`${source.serviceId}-${target.id}`, deployments.map((d) => d.id)),
      serviceId: source.serviceId,
      environmentId: target.id,
      hostId: host.id,
      ...(source.version !== undefined ? { version: source.version } : {}),
      ...(source.cpuLimit !== undefined ? { cpuLimit: source.cpuLimit } : {}),
      ...(source.memoryLimit !== undefined ? { memoryLimit: source.memoryLimit } : {}),
    };
    deployments.push(created);
    firstId ??= created.id;
  }
  // Las dependencias de recursos del origen se re-apuntan al entorno destino (sin repetir las que ya existen).
  const dependencyIds = new Set(doc.dependencies.map((d) => d.id));
  const dependencies = [...doc.dependencies];
  const resourcesById = new Map(doc.resources.map((r) => [r.id, r]));
  const counterparts = counterpartsOf(doc);
  for (const source of movable) {
    for (const dep of doc.dependencies.filter((d) => d.sourceId === source.serviceId)) {
      const resource = resourcesById.get(dep.targetId);
      if (!resource || resource.environmentId !== source.environmentId) continue;
      const mirror = counterpartResource(doc, resource, target.id, counterparts);
      if (!mirror || dependencies.some((d) => d.sourceId === dep.sourceId && d.targetId === mirror.id && d.kind === dep.kind)) continue;
      const id = uniqueId(`${dep.sourceId}-${mirror.id}`, dependencyIds);
      dependencyIds.add(id);
      dependencies.push({ ...dep, id, targetId: mirror.id });
    }
  }
  return ok({ ...doc, deployments, dependencies }, firstId ? `i:${firstId}` : undefined);
}

/**
 * Copia un entorno con sus redes, recursos, instancias y las dependencias de sus recursos; los pipelines lo añaden como etapa tras el original.
 * Cada recurso copiado declara como equivalente (`counterpartOf`) al original, así que comparar la copia con su origen los empareja uno a uno
 * aunque luego se renombren, y por transitividad también con los equivalentes que tuviera el original en otros entornos.
 */
export function duplicateEnvironment(doc: PlatformDocument, environmentId: string, name: string): EditResult<PlatformDocument> {
  const source = doc.environments.find((e) => e.id === environmentId);
  if (!source) return fail(`No existe el entorno «${environmentId}».`);
  const label = name.trim();
  if (!label) return fail('Indica el nombre del entorno nuevo.');
  if (doc.environments.some((e) => e.name.trim().toLowerCase() === label.toLowerCase())) return fail(`Ya existe un entorno llamado «${label}».`);
  const taken = new Set(indexElements(doc).keys());
  const fresh = (base: string): string => {
    const id = uniqueId(base, taken);
    taken.add(id);
    return id;
  };
  const newId = fresh(label);
  const suffix = newId;
  const networkIds = new Map<string, string>();
  const resourceIds = new Map<string, string>();
  const environmentNetworks = doc.networks.filter((n) => n.environmentId === environmentId);
  const environmentResources = doc.resources.filter((r) => r.environmentId === environmentId);
  for (const n of environmentNetworks) networkIds.set(n.id, fresh(`${n.id}-${suffix}`));
  for (const r of environmentResources) resourceIds.set(r.id, fresh(`${r.id}-${suffix}`));

  const environment: Environment = { id: newId, name: label, description: `Copia del entorno «${source.name}»`, ...(source.provider ? { provider: source.provider } : {}), ...(source.region ? { region: source.region } : {}) };
  const networks: Network[] = environmentNetworks.map((n) => {
    const { parentId: _parent, ...rest } = n;
    return { ...rest, id: networkIds.get(n.id)!, environmentId: newId, ...(n.parentId ? { parentId: networkIds.get(n.parentId)! } : {}) };
  });
  const resources: Resource[] = environmentResources.map((r) => {
    const { networkId: _network, ref: _ref, counterpartOf: _counterpart, ...rest } = r;
    return { ...rest, id: resourceIds.get(r.id)!, environmentId: newId, ...(r.networkId ? { networkId: networkIds.get(r.networkId)! } : {}), counterpartOf: r.id };
  });
  const deploymentIds = new Set(doc.deployments.map((d) => d.id));
  const deployments: Deployment[] = doc.deployments
    .filter((d) => d.environmentId === environmentId && resourceIds.has(d.hostId))
    .map((d) => {
      const id = uniqueId(`${d.serviceId}-${newId}`, deploymentIds);
      deploymentIds.add(id);
      return { ...d, id, environmentId: newId, hostId: resourceIds.get(d.hostId)! };
    });
  // Las dependencias de los recursos copiados (un servicio que usa la base, un recurso que depende de otro) se repiten sobre las copias.
  const dependencyIds = new Set(doc.dependencies.map((d) => d.id));
  const dependencies: Dependency[] = doc.dependencies
    .filter((d) => resourceIds.has(d.sourceId) || resourceIds.has(d.targetId))
    .filter((d) => [d.sourceId, d.targetId].every((id) => resourceIds.has(id) || !doc.resources.some((r) => r.id === id)))
    .map((d) => {
      const id = uniqueId(`${d.id}-${newId}`, dependencyIds);
      dependencyIds.add(id);
      return { ...d, id, sourceId: resourceIds.get(d.sourceId) ?? d.sourceId, targetId: resourceIds.get(d.targetId) ?? d.targetId };
    });
  const pipelines = doc.pipelines.map((p) => {
    const at = p.stages.findIndex((s) => s.environmentId === environmentId);
    const provisioned = (p.provisions ?? []).filter((id) => resourceIds.has(id)).map((id) => resourceIds.get(id)!);
    if (at < 0 && provisioned.length === 0) return p;
    const stages = at < 0 ? p.stages : [...p.stages.slice(0, at + 1), { ...p.stages[at], environmentId: newId }, ...p.stages.slice(at + 1)];
    return { ...p, stages, ...(p.provisions && provisioned.length > 0 ? { provisions: [...p.provisions, ...provisioned] } : {}) };
  });
  return ok(
    {
      ...doc,
      environments: [...doc.environments, environment],
      networks: [...doc.networks, ...networks],
      resources: [...doc.resources, ...resources],
      deployments: [...doc.deployments, ...deployments],
      dependencies: [...doc.dependencies, ...dependencies],
      pipelines,
    },
    resources[0]?.id,
  );
}

/** Lo que pide el texto de «Escalar réplicas»: `5` (fijar), `+2` o `-1` (sumar o restar) y `x2` (multiplicar). */
export function parseScale(text: string | undefined): { mode: 'set' | 'add' | 'mul'; amount: number } | undefined {
  const m = /^\s*([+\-x×*])?\s*(\d+)\s*$/i.exec(text ?? '');
  if (!m) return undefined;
  const amount = Number(m[2]);
  if (!m[1]) return { mode: 'set', amount };
  if (m[1] === '+') return { mode: 'add', amount };
  if (m[1] === '-') return { mode: 'add', amount: -amount };
  return { mode: 'mul', amount };
}

export function scaleReplicas(doc: PlatformDocument, deploymentIds: string[], text: string | undefined): EditResult<PlatformDocument> {
  const scale = parseScale(text);
  if (!scale) return fail('Indica las réplicas: un número (5), una suma o resta (+2, -1) o un factor (x2).');
  const selected = doc.deployments.filter((d) => deploymentIds.includes(d.id));
  if (selected.length === 0) return fail('Selecciona una o varias instancias desplegadas (o su clúster).');
  const next = (d: Deployment): number => {
    const current = d.replicas ?? 1;
    return scale.mode === 'set' ? scale.amount : scale.mode === 'add' ? current + scale.amount : current * scale.amount;
  };
  if (selected.some((d) => next(d) < 1)) return fail('Tiene que quedar al menos una réplica.');
  return ok({ ...doc, deployments: doc.deployments.map((d) => (selected.includes(d) ? { ...d, replicas: next(d) } : d)) });
}

/** Activa o quita la puerta de aprobación manual de las etapas indicadas de un pipeline (si alguna no la tiene, todas pasan a tenerla). */
export function toggleApproval(doc: PlatformDocument, pipelineId: string, stageIndexes: number[]): EditResult<PlatformDocument> {
  const pipeline = doc.pipelines.find((p) => p.id === pipelineId);
  if (!pipeline) return fail(`No existe el pipeline «${pipelineId}».`);
  const indexes = stageIndexes.filter((i) => i >= 0 && i < pipeline.stages.length);
  if (indexes.length === 0) return fail('Selecciona una etapa de despliegue de un pipeline.');
  const enable = indexes.some((i) => !pipeline.stages[i].approval);
  const stages = pipeline.stages.map((s, i) => {
    if (!indexes.includes(i)) return s;
    const { approval: _approval, ...rest } = s;
    return enable ? { ...rest, approval: true } : rest;
  });
  return ok({ ...doc, pipelines: doc.pipelines.map((p) => (p.id === pipelineId ? { ...p, stages } : p)) });
}
