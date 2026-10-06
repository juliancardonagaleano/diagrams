import type { ModuleIssue } from '@iark/kernel';
import { callCycles, deploymentEnvironments } from './graph';
import {
  ELEMENT_LABELS,
  RESOURCE_LABELS,
  SENSITIVE_KINDS,
  SERVICE_LABELS,
  STATUS_LABELS,
  exposureOf,
  indexElements,
  isHost,
  serviceKindOf,
  statusOf,
  type Element,
  type PlatformDocument,
  type Resource,
  type ResourceKind,
  type Service,
} from './types';

/** Recursos que guardan o mueven datos: si nadie depende de ellos sobran (o falta declarar quién los usa). */
const DATA_KINDS: ResourceKind[] = ['database', 'cache', 'queue', 'storage'];
/** Recursos transversales: no alojan servicios ni guardan datos, así que solo importan por lo que los une al resto. */
const CROSS_CUTTING_KINDS: ResourceKind[] = ['region', 'namespace', 'certificate', 'monitoring'];
/** Proveedores de nube en los que todo se aprovisiona en una región (en un centro de datos propio no la hay). */
const REGIONAL_PROVIDERS = /\b(aws|amazon|azure|microsoft|gcp|google|oracle|oci|ibm|alibaba|aliyun|digital ?ocean|ovh|scaleway|hetzner|linode|akamai|vultr)\b/i;
/** Recursos que viven en una región (el DNS, un certificado o la monitorización suelen ser globales). */
const REGIONAL_KINDS: ResourceKind[] = ['cluster', 'vm', 'database', 'cache', 'queue', 'storage', 'load-balancer', 'gateway', 'secret-store', 'registry'];
/** Días antes de la caducidad de un certificado en que se avisa (con más urgencia el primero). */
const EXPIRY_WARNING_DAYS = 30;
const EXPIRY_NOTICE_DAYS = 90;

/** Días desde hoy (en UTC) hasta una fecha AAAA-MM-DD: negativos si ya pasó; `undefined` si no es una fecha. */
function daysUntil(date: string, today: Date): number | undefined {
  const time = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(time)) return undefined;
  return Math.round((time - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) / 86_400_000);
}
const daysText = (n: number): string => `${n} ${n === 1 ? 'día' : 'días'}`;

const label = (e: Element): string => {
  if (e.kind === 'resource') return `${RESOURCE_LABELS[(e.item as Resource).kind]} «${e.name}»`;
  if (e.kind === 'service') return `${SERVICE_LABELS[serviceKindOf(e.item as Service)]} «${e.name}»`;
  return `${ELEMENT_LABELS[e.kind]} «${e.name}»`;
};
const inline = (e: Element): string => {
  const text = label(e);
  return `${text[0].toLowerCase()}${text.slice(1)}`;
};
const severe = (s: Service): boolean => s.criticality === 'high' || s.criticality === 'critical';

/**
 * Reglas de gobierno del modelo de plataforma (avisos que no invalidan el documento pero conviene corregir): servicios
 * sin despliegue o sin responsable, dependencias de recursos no aprovisionados o de otro entorno, entornos que no
 * replican lo que tiene otro, datos en redes públicas, puntos únicos de fallo en producción y pipelines que se saltan
 * entornos o aprobaciones. Los recursos transversales (certificados, monitorización, regiones y espacios de nombres) tienen
 * las suyas: certificados caducados o a punto de caducar (`expiresAt`), servicios de producción que ninguna monitorización cubre,
 * recursos sin región donde el proveedor (el del recurso o, si no lo declara, el de su entorno) la exige y recursos sin dependencias. `today` es la fecha con la que se miden las caducidades.
 */
export function analyzePlatform(doc: PlatformDocument, today: Date = new Date()): ModuleIssue[] {
  const issues: ModuleIssue[] = [];
  const elements = indexElements(doc);
  const at = (id: string): Element => elements.get(id)!;
  const environments = new Map(doc.environments.map((e) => [e.id, e]));
  const networks = new Map(doc.networks.map((n) => [n.id, n]));
  const resources = new Map(doc.resources.map((r) => [r.id, r]));
  const services = new Map(doc.services.map((s) => [s.id, s]));
  const add = (severity: ModuleIssue['severity'], id: string, message: string): void => void issues.push({ severity, elementId: id, message });
  const envName = (id: string): string => environments.get(id)?.name ?? id;
  const productionLike = (environmentId: string): boolean => {
    const kind = environments.get(environmentId)?.kind;
    return kind === 'prod' || kind === 'dr';
  };
  const gap = (environmentId: string): ModuleIssue['severity'] => (productionLike(environmentId) ? 'warning' : 'info');
  const preProduction = doc.environments.filter((e) => e.kind === 'dev' || e.kind === 'test' || e.kind === 'staging').map((e) => e.id);

  // Entornos donde corre cada servicio y entorno propio de un extremo de dependencia (un recurso es de uno; un servicio, de los suyos).
  const envsOf = (id: string): string[] => (resources.has(id) ? [resources.get(id)!.environmentId] : deploymentEnvironments(doc, id));

  for (const e of doc.environments) {
    if (!doc.resources.some((r) => r.environmentId === e.id) && !doc.deployments.some((d) => d.environmentId === e.id)) {
      add('info', e.id, `Entorno «${e.name}» no tiene recursos ni despliegues.`);
    }
  }

  for (const s of doc.services) {
    const e = at(s.id);
    const envs = deploymentEnvironments(doc, s.id);
    if (!s.external && envs.length === 0) add(severe(s) ? 'warning' : 'info', s.id, `${label(e)} no se despliega en ningún entorno.`);
    if (!s.external && !s.owner) add(severe(s) ? 'warning' : 'info', s.id, `${label(e)} no tiene responsable.`);
    if (preProduction.length > 0) {
      for (const env of envs.filter((x) => environments.get(x)?.kind === 'prod')) {
        if (!envs.some((x) => preProduction.includes(x))) add('info', s.id, `${label(e)} se despliega en «${envName(env)}» sin estar en ningún entorno anterior (${preProduction.map(envName).join(', ')}).`);
      }
    }
  }

  for (const d of doc.deployments) {
    const service = services.get(d.serviceId)!;
    const host = resources.get(d.hostId)!;
    if (statusOf(host) !== 'provisioned') {
      add('warning', service.id, `${label(at(service.id))} se despliega en ${inline(at(host.id))}, que está ${STATUS_LABELS[statusOf(host)]}.`);
    }
    if (d.replicas === 1 && severe(service) && productionLike(d.environmentId)) {
      add('warning', service.id, `${label(at(service.id))} corre en «${envName(d.environmentId)}» con una sola réplica: es un punto único de fallo.`);
    }
  }

  for (const dep of doc.dependencies) {
    const [source, target] = [at(dep.sourceId), at(dep.targetId)];
    const targetResource = resources.get(dep.targetId);
    const sourceResource = resources.get(dep.sourceId);
    if (targetResource && statusOf(targetResource) !== 'provisioned' && (!sourceResource || statusOf(sourceResource) === 'provisioned')) {
      add('warning', source.id, `${label(source)} depende de ${inline(target)}, que está ${STATUS_LABELS[statusOf(targetResource)]}.`);
    }
    const sourceEnvs = envsOf(dep.sourceId);
    if (sourceEnvs.length === 0) continue;
    const targetService = services.get(dep.targetId);
    if (targetService && !targetService.external) {
      // El destino tiene que correr en cada entorno donde corre quien depende de él.
      for (const env of sourceEnvs.filter((x) => !envsOf(dep.targetId).includes(x))) {
        add(gap(env), source.id, `${label(source)} depende de ${inline(target)}, que no se despliega en «${envName(env)}», donde sí corre.`);
      }
    }
    if (targetResource && !sourceEnvs.includes(targetResource.environmentId)) {
      add('warning', source.id, `${label(source)} depende de ${inline(target)}, que está en «${envName(targetResource.environmentId)}», y no corre allí.`);
    }
  }

  // Un servicio que en un entorno usa un tipo de recurso (base de datos, cola…) y en otro no: falta aprovisionarlo o declararlo.
  for (const s of doc.services) {
    const envs = deploymentEnvironments(doc, s.id);
    if (envs.length < 2) continue;
    const used = new Map<string, Map<ResourceKind, string>>(envs.map((env) => [env, new Map()]));
    for (const dep of doc.dependencies.filter((x) => x.sourceId === s.id)) {
      const r = resources.get(dep.targetId);
      if (r && used.has(r.environmentId) && !isHost(r)) used.get(r.environmentId)!.set(r.kind, r.name);
    }
    const everywhere = new Map<ResourceKind, { env: string; name: string }>();
    for (const [env, kinds] of used) for (const [kind, name] of kinds) if (!everywhere.has(kind)) everywhere.set(kind, { env, name });
    for (const env of envs) {
      const missing = [...everywhere].filter(([kind]) => !used.get(env)!.has(kind));
      if (missing.length === 0) continue;
      const list = missing.map(([kind, from]) => `${RESOURCE_LABELS[kind].toLowerCase()} (en «${envName(from.env)}» usa «${from.name}»)`).join(', ');
      add(gap(env), s.id, `${label(at(s.id))} se despliega en «${envName(env)}» pero allí no usa ningún recurso de tipo ${list}.`);
    }
  }

  // Producción con menos réplicas que el entorno anterior en el camino (preproducción): suele ser un descuido del escalado.
  for (const prod of doc.environments.filter((e) => e.kind === 'prod')) {
    const before = doc.environments.filter((e) => e.kind === 'staging' || e.kind === 'test').sort((x, y) => (x.kind === 'staging' ? 0 : 1) - (y.kind === 'staging' ? 0 : 1))[0];
    if (!before) continue;
    for (const s of doc.services) {
      const count = (environmentId: string): number | undefined => {
        const mine = doc.deployments.filter((d) => d.serviceId === s.id && d.environmentId === environmentId);
        return mine.length === 0 ? undefined : mine.reduce((sum, d) => sum + (d.replicas ?? 1), 0);
      };
      const [there, here] = [count(before.id), count(prod.id)];
      if (there !== undefined && here !== undefined && here < there) {
        add('info', s.id, `${label(at(s.id))} corre en «${prod.name}» con menos réplicas (${here}) que en «${before.name}» (${there}).`);
      }
    }
  }

  const inbound = new Set(doc.dependencies.map((d) => d.targetId));
  const related = new Set(doc.dependencies.flatMap((d) => [d.sourceId, d.targetId]));
  for (const r of doc.resources) {
    const e = at(r.id);
    const network = r.networkId ? networks.get(r.networkId) : undefined;
    if (network && SENSITIVE_KINDS.includes(r.kind) && exposureOf(network) === 'public') {
      add('warning', r.id, `${label(e)} está en la red pública «${network.name}»: los datos y los secretos deberían estar en una red privada.`);
    }
    if (r.iac === false && environments.get(r.environmentId)?.kind === 'prod') {
      add('info', r.id, `${label(e)} está en producción y no se gestiona como código (infraestructura como código).`);
    }
    if (isHost(r) && statusOf(r) === 'provisioned' && !doc.deployments.some((d) => d.hostId === r.id)) add('info', r.id, `${label(e)} no aloja ningún servicio.`);
    if (DATA_KINDS.includes(r.kind) && statusOf(r) === 'provisioned' && !inbound.has(r.id)) add('info', r.id, `${label(e)} no lo usa ningún servicio.`);
    if (CROSS_CUTTING_KINDS.includes(r.kind) && statusOf(r) === 'provisioned' && !related.has(r.id)) {
      add('info', r.id, `${label(e)}: no tiene ninguna dependencia, así que no se sabe a qué servicios o recursos afecta.`);
    }
    // Equivalencia declarada con un recurso de otro entorno (counterpartOf): si el extremo no es válido, lo dice la validación del esquema.
    const counterpart = r.counterpartOf === undefined ? undefined : resources.get(r.counterpartOf);
    if (counterpart && counterpart.id !== r.id && counterpart.environmentId !== r.environmentId) {
      if (counterpart.kind !== r.kind && !(isHost(r) && isHost(counterpart))) {
        add('warning', r.id, `${label(e)} se declara equivalente de ${inline(at(counterpart.id))} (counterpartOf), que es de otra clase: ¿es el recurso que corresponde?`);
      }
      const retired = [r, counterpart].filter((x) => statusOf(x) === 'decommissioned');
      if (retired.length > 0) add('info', r.id, `${label(e)} se declara equivalente de ${inline(at(counterpart.id))} (counterpartOf), pero ${retired.map((x) => `«${x.name}»`).join(' y ')} está${retired.length > 1 ? 'n' : ''} dado${retired.length > 1 ? 's' : ''} de baja: la comparación de entornos no cuenta esa equivalencia.`);
    }
    if (r.kind === 'certificate' && statusOf(r) !== 'decommissioned') {
      const left = r.expiresAt ? daysUntil(r.expiresAt, today) : undefined;
      if (left === undefined) {
        if (productionLike(r.environmentId) && !r.expiresAt) add('info', r.id, `${label(e)} está en «${envName(r.environmentId)}» y no tiene fecha de caducidad (expiresAt): sin ella nadie avisa antes de que caduque.`);
      } else if (left < 0) add('warning', r.id, `${label(e)} caducó el ${r.expiresAt} (hace ${daysText(-left)}): renuévalo.`);
      else if (left <= EXPIRY_WARNING_DAYS) add('warning', r.id, `${label(e)} caduca ${left === 0 ? 'hoy' : `el ${r.expiresAt} (en ${daysText(left)})`}: renuévalo antes de que caduque.`);
      else if (left <= EXPIRY_NOTICE_DAYS) add('info', r.id, `${label(e)} caduca el ${r.expiresAt} (en ${daysText(left)}).`);
    }
  }

  // Monitorización: si el documento la modela, los servicios de producción tienen que estar cubiertos por alguna (ellos o el anfitrión donde corren).
  const monitors = doc.resources.filter((r) => r.kind === 'monitoring' && statusOf(r) !== 'decommissioned');
  if (monitors.length > 0) {
    for (const env of doc.environments.filter((x) => x.kind === 'prod')) {
      const here = new Set(monitors.filter((m) => m.environmentId === env.id).map((m) => m.id));
      const watched = new Set(doc.dependencies.flatMap((d) => (here.has(d.sourceId) ? [d.targetId] : here.has(d.targetId) ? [d.sourceId] : [])));
      for (const s of doc.services.filter((x) => !x.external)) {
        const mine = doc.deployments.filter((d) => d.serviceId === s.id && d.environmentId === env.id);
        if (mine.length === 0 || watched.has(s.id) || mine.some((d) => watched.has(d.hostId))) continue;
        // Sin ninguna monitorización en el entorno solo se avisa de lo crítico: el resto sería repetir lo mismo en cada servicio.
        if (here.size === 0 && !severe(s)) continue;
        add(severe(s) ? 'warning' : 'info', s.id, `${label(at(s.id))} corre en «${env.name}» y ${here.size === 0 ? 'allí no hay ningún recurso de monitorización' : 'ningún recurso de monitorización lo cubre, ni a él ni al anfitrión donde corre'}.`);
      }
    }
  }

  // Región: en un proveedor de nube todo recurso está en una; basta que la indique el recurso, su entorno o una región modelada en el entorno.
  // El proveedor es el del recurso (`provider`, que puede ser otro que el del entorno) y, si no lo declara, el del entorno.
  for (const env of doc.environments) {
    if (env.region?.trim()) continue;
    if (doc.resources.some((r) => r.environmentId === env.id && r.kind === 'region' && statusOf(r) !== 'decommissioned')) continue;
    for (const r of doc.resources.filter((x) => x.environmentId === env.id && REGIONAL_KINDS.includes(x.kind) && statusOf(x) !== 'decommissioned' && !x.region?.trim())) {
      const provider = r.provider?.trim() || env.provider;
      if (!provider || !REGIONAL_PROVIDERS.test(provider)) continue;
      add(gap(env.id), r.id, `${label(at(r.id))} está en «${env.name}» (proveedor ${provider}), que exige región, y ni el recurso ni el entorno la indican.`);
    }
  }

  for (const p of doc.pipelines) {
    const e = at(p.id);
    if (p.serviceIds.length === 0 && (p.provisions ?? []).length === 0) add('info', p.id, `${label(e)} no construye, despliega ni aprovisiona nada.`);
    for (const s of p.stages) {
      if (environments.get(s.environmentId)?.kind === 'prod' && !s.approval) {
        add('info', p.id, `${label(e)} promociona a «${envName(s.environmentId)}» sin una aprobación manual.`);
      }
    }
    const first = p.stages[0];
    if ((p.kind === 'cd' || p.kind === 'ci-cd') && first && environments.get(first.environmentId)?.kind === 'prod' && preProduction.length > 0) {
      add('info', p.id, `${label(e)} despliega en producción sin pasar antes por otro entorno.`);
    }
    if (p.kind === 'cd' || p.kind === 'ci-cd') {
      for (const s of p.stages) {
        for (const id of p.serviceIds) {
          if (!envsOf(id).includes(s.environmentId)) {
            add('warning', p.id, `${label(e)} promociona ${inline(at(id))} a «${envName(s.environmentId)}», pero el servicio no tiene despliegue allí.`);
          }
        }
      }
    }
  }
  if (doc.pipelines.length > 0) {
    const covered = new Set(doc.pipelines.flatMap((p) => p.serviceIds));
    for (const s of doc.services.filter((x) => !x.external && !covered.has(x.id))) add('info', s.id, `${label(at(s.id))} no lo construye ni lo despliega ningún pipeline.`);
  }

  for (const cycle of callCycles(doc)) {
    add('info', cycle[0], `Llamadas síncronas circulares entre servicios: ${[...cycle, cycle[0]].map((id) => `«${at(id).name}»`).join(' → ')}.`);
  }
  return issues;
}
