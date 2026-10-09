import { parseUrn, refTypeSchema } from '@iark/kernel';
import { z } from 'zod';
import { counterpartErrors } from './counterparts';
import { iconPackSchema } from './icons/schema';
import {
  CRITICALITIES,
  DEPENDENCY_KINDS,
  ELEMENT_LABELS,
  ENVIRONMENT_KINDS,
  EXPOSURES,
  PIPELINE_KINDS,
  PLATFORM_DOCUMENT_VERSION,
  RESOURCE_KINDS,
  RESOURCE_LABELS,
  RESOURCE_STATUSES,
  SERVICE_KINDS,
  indexElements,
  isHost,
  type ElementKind,
  type PlatformDocument,
  type Resource,
} from './types';

const idSchema = z.string().min(1, 'El id no puede estar vacío').max(120);
const nameSchema = z.string().min(1, 'El nombre no puede estar vacío');

export const environmentSchema = z.object({
  id: idSchema,
  name: nameSchema,
  description: z.string().optional(),
  kind: z.enum(ENVIRONMENT_KINDS).optional(),
  provider: z.string().optional(),
  region: z.string().optional(),
});

export const networkSchema = z.object({
  id: idSchema,
  name: nameSchema,
  environmentId: idSchema,
  parentId: idSchema.optional(),
  exposure: z.enum(EXPOSURES).optional(),
  cidr: z.string().optional(),
  description: z.string().optional(),
  provider: z.string().optional(),
  service: z.string().optional(),
});

export const resourceSchema = z.object({
  id: idSchema,
  name: nameSchema,
  kind: z.enum(RESOURCE_KINDS),
  environmentId: idSchema,
  networkId: idSchema.optional(),
  technology: z.string().optional(),
  version: z.string().optional(),
  status: z.enum(RESOURCE_STATUSES).optional(),
  iac: z.boolean().optional(),
  owner: z.string().optional(),
  description: z.string().optional(),
  ref: z.string().optional(),
  refType: refTypeSchema.optional(),
  tags: z.array(z.string()).optional(),
  monthlyCost: z.number().min(0, 'El coste mensual no puede ser negativo').optional(),
  expiresAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha de caducidad debe tener la forma AAAA-MM-DD')
    .refine((text) => !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) && new Date(`${text}T00:00:00Z`).toISOString().startsWith(text), 'La fecha de caducidad no existe')
    .optional(),
  region: z.string().optional(),
  cpuLimit: z.string().optional(),
  memoryLimit: z.string().optional(),
  provider: z.string().optional(),
  service: z.string().optional(),
  counterpartOf: idSchema.optional(),
});

export const serviceSchema = z.object({
  id: idSchema,
  name: nameSchema,
  kind: z.enum(SERVICE_KINDS).optional(),
  description: z.string().optional(),
  technology: z.string().optional(),
  owner: z.string().optional(),
  repo: z.string().optional(),
  criticality: z.enum(CRITICALITIES).optional(),
  slo: z.string().optional(),
  sla: z.string().optional(),
  external: z.boolean().optional(),
  ref: z.string().optional(),
  refType: refTypeSchema.optional(),
  tags: z.array(z.string()).optional(),
  provider: z.string().optional(),
  service: z.string().optional(),
});

export const deploymentSchema = z.object({
  id: idSchema,
  serviceId: idSchema,
  environmentId: idSchema,
  hostId: idSchema,
  replicas: z.number().int('Las réplicas deben ser un número entero').min(1, 'Debe haber al menos una réplica').optional(),
  version: z.string().optional(),
  monthlyCost: z.number().min(0, 'El coste mensual no puede ser negativo').optional(),
  cpuLimit: z.string().optional(),
  memoryLimit: z.string().optional(),
});

export const dependencySchema = z.object({
  id: idSchema,
  sourceId: idSchema,
  targetId: idSchema,
  kind: z.enum(DEPENDENCY_KINDS),
  protocol: z.string().optional(),
  description: z.string().optional(),
});

export const pipelineStageSchema = z.object({ environmentId: idSchema, approval: z.boolean().optional() });

export const pipelineSchema = z.object({
  id: idSchema,
  name: nameSchema,
  kind: z.enum(PIPELINE_KINDS),
  tool: z.string().optional(),
  description: z.string().optional(),
  owner: z.string().optional(),
  serviceIds: z.array(idSchema).default([]),
  provisions: z.array(idSchema).optional(),
  stages: z.array(pipelineStageSchema).default([]),
});

/** Esquema estructural + reglas de integridad (ids únicos, redes sin ciclos, despliegues en hosts del mismo entorno, referencias). */
export const platformDocumentSchema = z
  .object({
    version: z.literal(PLATFORM_DOCUMENT_VERSION).default(PLATFORM_DOCUMENT_VERSION),
    workspace: z
      .object({ name: z.string().default('Arquitectura de plataforma'), description: z.string().optional(), currency: z.string().optional(), iconPacks: z.array(iconPackSchema).optional() })
      .default({ name: 'Arquitectura de plataforma' }),
    environments: z.array(environmentSchema).default([]),
    networks: z.array(networkSchema).default([]),
    resources: z.array(resourceSchema).default([]),
    services: z.array(serviceSchema).default([]),
    deployments: z.array(deploymentSchema).default([]),
    dependencies: z.array(dependencySchema).default([]),
    pipelines: z.array(pipelineSchema).default([]),
  })
  .superRefine((input, ctx) => {
    const doc = input as unknown as PlatformDocument;
    const issue = (path: Array<string | number>, message: string): void => void ctx.addIssue({ code: 'custom', path, message });
    const kindName = (k: ElementKind): string => ELEMENT_LABELS[k].toLowerCase();

    // Los ids de entornos, redes, recursos, servicios y pipelines son únicos entre todos ellos: las dependencias apuntan a cualquiera.
    const seen = new Map<string, ElementKind>();
    const collections: Array<[ElementKind, keyof PlatformDocument, Array<{ id: string }>]> = [
      ['environment', 'environments', doc.environments],
      ['network', 'networks', doc.networks],
      ['resource', 'resources', doc.resources],
      ['service', 'services', doc.services],
      ['pipeline', 'pipelines', doc.pipelines],
    ];
    for (const [kind, key, items] of collections) {
      items.forEach((item, i) => {
        const previous = seen.get(item.id);
        if (previous) issue([key, i, 'id'], `Id duplicado: "${item.id}" (ya lo usa ${kindName(previous)})`);
        else seen.set(item.id, kind);
      });
    }
    const packIds = new Set<string>();
    (doc.workspace.iconPacks ?? []).forEach((p, i) => {
      if (packIds.has(p.id)) issue(['workspace', 'iconPacks', i, 'id'], `Id de paquete de iconos duplicado: "${p.id}"`);
      packIds.add(p.id);
    });
    const elements = indexElements(doc);
    const environments = new Set(doc.environments.map((e) => e.id));
    const networks = new Map(doc.networks.map((n) => [n.id, n]));
    const resources = new Map<string, Resource>(doc.resources.map((r) => [r.id, r]));
    const services = new Map(doc.services.map((s) => [s.id, s]));

    const checkEnvironment = (key: string, i: number, owner: string, environmentId: string): boolean => {
      if (environments.has(environmentId)) return true;
      issue([key, i, 'environmentId'], `"${owner}" referencia un entorno inexistente: "${environmentId}"`);
      return false;
    };

    doc.networks.forEach((n, i) => {
      checkEnvironment('networks', i, n.id, n.environmentId);
      if (n.parentId === undefined) return;
      if (n.parentId === n.id) return issue(['networks', i, 'parentId'], `"${n.id}" no puede ser su propio padre`);
      const parent = networks.get(n.parentId);
      if (!parent) {
        const other = elements.get(n.parentId);
        return issue(
          ['networks', i, 'parentId'],
          other ? `El padre de "${n.id}" debe ser una red, pero "${other.id}" es ${kindName(other.kind)}` : `"${n.id}" referencia un padre inexistente: "${n.parentId}"`,
        );
      }
      if (parent.environmentId !== n.environmentId) return issue(['networks', i, 'parentId'], `La red "${n.id}" y su padre "${parent.id}" están en entornos distintos`);
      const visited = new Set([n.id]);
      for (let p: string | undefined = n.parentId; p !== undefined; p = networks.get(p)?.parentId) {
        if (visited.has(p)) return issue(['networks', i, 'parentId'], `La jerarquía de redes de "${n.id}" es circular`);
        visited.add(p);
      }
    });

    doc.resources.forEach((r, i) => {
      checkEnvironment('resources', i, r.id, r.environmentId);
      if (r.networkId !== undefined) {
        const network = networks.get(r.networkId);
        if (!network) issue(['resources', i, 'networkId'], `"${r.id}" referencia una red inexistente: "${r.networkId}"`);
        else if (network.environmentId !== r.environmentId) issue(['resources', i, 'networkId'], `El recurso "${r.id}" y su red "${network.id}" están en entornos distintos`);
      }
    });

    // `counterpartOf`: el equivalente de otro entorno tiene que existir, ser un recurso de otro entorno y no repetirse en su entorno.
    for (const e of counterpartErrors(doc)) issue(['resources', doc.resources.findIndex((r) => r.id === e.resourceId), 'counterpartOf'], e.message);

    for (const [key, items] of [['resources', doc.resources], ['services', doc.services]] as const) {
      items.forEach((x, i) => {
        if (x.ref !== undefined && !parseUrn(x.ref)) issue([key, i, 'ref'], `La referencia de "${x.id}" no es una URN válida (urn:iark:<módulo>:<id>): "${x.ref}"`);
      });
    }

    const deploymentIds = new Set<string>();
    const placements = new Set<string>();
    doc.deployments.forEach((d, i) => {
      if (deploymentIds.has(d.id)) issue(['deployments', i, 'id'], `Id de despliegue duplicado: "${d.id}"`);
      deploymentIds.add(d.id);
      const service = services.get(d.serviceId);
      if (!service) {
        const other = elements.get(d.serviceId);
        issue(['deployments', i, 'serviceId'], other ? `El despliegue "${d.id}" debe ser de un servicio, pero "${other.id}" es ${kindName(other.kind)}` : `El despliegue "${d.id}" referencia un servicio inexistente: "${d.serviceId}"`);
      } else if (service.external) {
        issue(['deployments', i, 'serviceId'], `El servicio "${service.id}" es externo (de un tercero): no se despliega en la plataforma`);
      }
      const environmentOk = checkEnvironment('deployments', i, d.id, d.environmentId);
      const host = resources.get(d.hostId);
      if (!host) {
        const other = elements.get(d.hostId);
        issue(['deployments', i, 'hostId'], other ? `El anfitrión del despliegue "${d.id}" debe ser un recurso, pero "${other.id}" es ${kindName(other.kind)}` : `El despliegue "${d.id}" referencia un anfitrión inexistente: "${d.hostId}"`);
      } else if (!isHost(host)) {
        issue(['deployments', i, 'hostId'], `El anfitrión "${host.id}" de "${d.id}" es ${RESOURCE_LABELS[host.kind].toLowerCase()}: un servicio solo se despliega en un clúster o una máquina virtual`);
      } else if (environmentOk && host.environmentId !== d.environmentId) {
        issue(['deployments', i, 'hostId'], `El despliegue "${d.id}" es del entorno "${d.environmentId}" pero su anfitrión "${host.id}" está en "${host.environmentId}"`);
      }
      const placement = `${d.serviceId}|${d.environmentId}|${d.hostId}`;
      if (placements.has(placement)) issue(['deployments', i, 'hostId'], `El despliegue "${d.id}" repite otro igual (servicio "${d.serviceId}" en "${d.hostId}")`);
      placements.add(placement);
    });

    const dependencyIds = new Set<string>();
    const signatures = new Set<string>();
    doc.dependencies.forEach((d, i) => {
      if (dependencyIds.has(d.id)) issue(['dependencies', i, 'id'], `Id de dependencia duplicado: "${d.id}"`);
      dependencyIds.add(d.id);
      const [source, target] = [elements.get(d.sourceId), elements.get(d.targetId)];
      for (const [field, id, e] of [['sourceId', d.sourceId, source], ['targetId', d.targetId, target]] as const) {
        if (!e) issue(['dependencies', i, field], `La dependencia "${d.id}" referencia un elemento inexistente: "${id}"`);
        else if (e.kind !== 'service' && e.kind !== 'resource') issue(['dependencies', i, field], `Una dependencia une servicios o recursos, pero "${e.id}" es ${kindName(e.kind)}`);
      }
      if (!source || !target) return;
      if (d.sourceId === d.targetId) return issue(['dependencies', i, 'targetId'], `La dependencia "${d.id}" no puede unir un elemento consigo mismo`);
      const signature = `${d.kind}|${d.sourceId}|${d.targetId}`;
      if (signatures.has(signature)) issue(['dependencies', i, 'targetId'], `La dependencia "${d.id}" repite otra igual (${d.kind} "${d.sourceId}" → "${d.targetId}")`);
      signatures.add(signature);
    });

    doc.pipelines.forEach((p, i) => {
      p.serviceIds.forEach((id, j) => {
        if (!services.has(id)) issue(['pipelines', i, 'serviceIds', j], `El pipeline "${p.id}" referencia un servicio inexistente: "${id}"`);
        else if (services.get(id)!.external) issue(['pipelines', i, 'serviceIds', j], `El servicio "${id}" es externo: ningún pipeline lo construye ni lo despliega`);
      });
      (p.provisions ?? []).forEach((id, j) => {
        if (!resources.has(id)) issue(['pipelines', i, 'provisions', j], `El pipeline "${p.id}" referencia un recurso inexistente: "${id}"`);
      });
      if (p.provisions && p.provisions.length > 0 && p.kind !== 'iac') issue(['pipelines', i, 'provisions'], `Solo un pipeline de infraestructura como código (iac) aprovisiona recursos; "${p.id}" es ${p.kind}`);
      const stageEnvironments = new Set<string>();
      p.stages.forEach((s, j) => {
        if (!environments.has(s.environmentId)) issue(['pipelines', i, 'stages', j, 'environmentId'], `El pipeline "${p.id}" referencia un entorno inexistente: "${s.environmentId}"`);
        else if (stageEnvironments.has(s.environmentId)) issue(['pipelines', i, 'stages', j, 'environmentId'], `El pipeline "${p.id}" pasa dos veces por el entorno "${s.environmentId}"`);
        stageEnvironments.add(s.environmentId);
      });
    });
  });

export type PlatformValidation = { ok: true; document: PlatformDocument } | { ok: false; issues: Array<{ path: string; message: string }> };

export function validatePlatformDocument(input: unknown): PlatformValidation {
  const result = platformDocumentSchema.safeParse(input);
  if (result.success) return { ok: true, document: result.data as PlatformDocument };
  return { ok: false, issues: result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })) };
}

export function formatPlatformIssues(issues: Array<{ path: string; message: string }>): string {
  return issues.map((i) => `- ${i.path ? `${i.path}: ` : ''}${i.message}`).join('\n');
}

export function platformJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(platformDocumentSchema, { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>;
}
