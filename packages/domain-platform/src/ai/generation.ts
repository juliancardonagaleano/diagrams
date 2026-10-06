import type { AiSpec } from '@iark/kernel';
import { z } from 'zod';
import { formatPlatformIssues, validatePlatformDocument } from '../schema';
import {
  CRITICALITIES,
  DEPENDENCY_KINDS,
  ENVIRONMENT_KINDS,
  EXPOSURES,
  PIPELINE_KINDS,
  PLATFORM_DOCUMENT_VERSION,
  RESOURCE_KINDS,
  RESOURCE_STATUSES,
  SERVICE_KINDS,
  type PlatformDocument,
} from '../types';

// Lo que produce el modelo: todos los campos presentes (null si no aplican), como exige la salida estructurada.
const nullable = <T extends z.ZodType>(t: T) => t.nullable();

const generatedEnvironment = z.object({
  id: z.string(),
  name: z.string(),
  description: nullable(z.string()),
  kind: nullable(z.enum(ENVIRONMENT_KINDS)),
  provider: nullable(z.string()),
  region: nullable(z.string()),
});

const generatedNetwork = z.object({
  id: z.string(),
  name: z.string(),
  environmentId: z.string(),
  parentId: nullable(z.string()),
  exposure: nullable(z.enum(EXPOSURES)),
  cidr: nullable(z.string()),
  description: nullable(z.string()),
});

const generatedResource = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(RESOURCE_KINDS),
  environmentId: z.string(),
  networkId: nullable(z.string()),
  technology: nullable(z.string()),
  version: nullable(z.string()),
  status: nullable(z.enum(RESOURCE_STATUSES)),
  iac: nullable(z.boolean()),
  owner: nullable(z.string()),
  description: nullable(z.string()),
  monthlyCost: nullable(z.number()),
  region: nullable(z.string()),
  cpuLimit: nullable(z.string()),
  memoryLimit: nullable(z.string()),
  expiresAt: nullable(z.string()),
  counterpartOf: nullable(z.string()),
});

const generatedService = z.object({
  id: z.string(),
  name: z.string(),
  kind: nullable(z.enum(SERVICE_KINDS)),
  description: nullable(z.string()),
  technology: nullable(z.string()),
  owner: nullable(z.string()),
  repo: nullable(z.string()),
  criticality: nullable(z.enum(CRITICALITIES)),
  slo: nullable(z.string()),
  sla: nullable(z.string()),
  external: nullable(z.boolean()),
});

const generatedDeployment = z.object({
  id: z.string(),
  serviceId: z.string(),
  environmentId: z.string(),
  hostId: z.string(),
  replicas: nullable(z.number()),
  version: nullable(z.string()),
  monthlyCost: nullable(z.number()),
  cpuLimit: nullable(z.string()),
  memoryLimit: nullable(z.string()),
});

const generatedDependency = z.object({
  id: z.string(),
  sourceId: z.string(),
  targetId: z.string(),
  kind: z.enum(DEPENDENCY_KINDS),
  protocol: nullable(z.string()),
  description: nullable(z.string()),
});

const generatedPipeline = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(PIPELINE_KINDS),
  tool: nullable(z.string()),
  description: nullable(z.string()),
  owner: nullable(z.string()),
  serviceIds: z.array(z.string()),
  provisions: nullable(z.array(z.string())),
  stages: z.array(z.object({ environmentId: z.string(), approval: nullable(z.boolean()) })),
});

export const generatedPlatformSchema = z.object({
  workspace: z.object({ name: z.string(), description: nullable(z.string()), currency: nullable(z.string()) }),
  environments: z.array(generatedEnvironment),
  networks: z.array(generatedNetwork),
  resources: z.array(generatedResource),
  services: z.array(generatedService),
  deployments: z.array(generatedDeployment),
  dependencies: z.array(generatedDependency),
  pipelines: z.array(generatedPipeline),
});

export type GeneratedPlatform = z.infer<typeof generatedPlatformSchema>;

/** Quita los `null` que exige la salida estructurada: el documento usa campos ausentes. */
function dropNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map(dropNulls) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => [k, dropNulls(v)])) as T;
  }
  return value;
}

export function generatedToPlatform(generated: GeneratedPlatform): { ok: true; document: PlatformDocument } | { ok: false; issues: string } {
  const result = validatePlatformDocument({ version: PLATFORM_DOCUMENT_VERSION, ...dropNulls(generated) });
  return result.ok ? result : { ok: false, issues: formatPlatformIssues(result.issues) };
}

export function generationJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(generatedPlatformSchema, { target: 'draft-2020-12' }) as Record<string, unknown>;
}

export function systemPrompt(): string {
  return `Eres un arquitecto de plataforma (DevOps / SRE) experto en infraestructura en la nube, Kubernetes, redes, entornos y entrega continua.
Tu tarea es convertir una descripción en lenguaje natural en un modelo de arquitectura de plataforma estructurado en JSON.
NO produces coordenadas: el diagramador coloca los elementos después. Concéntrate en el modelo.

Entornos ("environments"): dev, test, staging, prod o dr (recuperación ante desastres), con provider y region si se mencionan.
Todo lo que existe físicamente pertenece a un entorno: si la descripción no distingue entornos, crea uno solo de tipo "prod".

Redes ("networks"): pertenecen a un entorno; "parentId" es la red que las contiene (una subred dentro de su VPC, del mismo entorno).
exposure: "public" (accesible desde Internet), "private" (por defecto) o "isolated". cidr solo si se indica.

Recursos ("resources"), siempre de un entorno (y, si procede, de una red de ese mismo entorno):
- "cluster" (Kubernetes, ECS…) y "vm" (máquina virtual) son los ÚNICOS anfitriones donde se despliegan servicios.
- "database", "cache", "queue" (broker o cola), "storage", "load-balancer", "gateway", "dns", "secret-store", "registry", "region" (región o zona de disponibilidad), "namespace" (espacio de nombres), "certificate" (certificado o dominio; con "expiresAt" = fecha de caducidad AAAA-MM-DD si se conoce), "monitoring" (monitorización o SLO), "other".
- status: "planned" (prevista), "provisioned" (por defecto) o "decommissioned". iac = true si se gestiona con Terraform/Pulumi.
- Las bases de datos, cachés, colas y almacenes de secretos van en redes privadas o aisladas, nunca públicas.
- Un recurso por entorno: la misma base de datos en dev y prod son dos recursos con ids distintos.
- "counterpartOf" = id del recurso de OTRO entorno que es el mismo recurso (el equivalente). Ponlo solo cuando el nombre no delate la correspondencia
  (p. ej. «Pedidos DB» en dev y «Aurora de pedidos» en prod); si se llaman igual o solo cambia el sufijo del entorno, déjalo en null. En cada
  entorno solo puede haber un recurso por equivalencia, y el equivalente tiene que existir y ser de otro entorno. Al refinar, conserva los que ya haya.

Servicios ("services"): lo que se construye y ejecuta. kind: "service", "worker", "job" o "frontend". criticality: low, medium,
high, critical. owner = equipo responsable. external = true para servicios de terceros (SaaS), que no se despliegan.

Despliegues ("deployments"): dónde corre cada servicio en cada entorno: serviceId, environmentId y hostId (un cluster o vm
DEL MISMO ENTORNO). replicas (entero >= 1) y version si se conocen. Un servicio que corre en varios entornos tiene un despliegue por entorno.
Los servicios críticos en producción llevan al menos 2 réplicas.

Dependencias ("dependencies"): sourceId depende de targetId (servicios o recursos). kind: "calls" (llamada síncrona), "messages"
(mensajería asíncrona) o "data" (lectura/escritura de datos). Un servicio que en producción usa una base de datos y una cola
debe usar también las de los demás entornos donde corre. Un servicio llama a servicios que corren en sus mismos entornos.

Pipelines ("pipelines"): kind "ci" (construye y prueba), "cd" (despliega), "ci-cd" o "iac" (aprovisiona recursos, en "provisions").
serviceIds = servicios que construye o despliega. stages = entornos por los que promociona, en orden (dev → test → staging → prod);
en prod, approval = true.

Ids únicos en kebab-case ASCII entre entornos, redes, recursos, servicios y pipelines. Responde en el idioma de la instrucción del
usuario (nombres, descripciones). Sé concreto y no inventes elementos que la descripción no justifique.`;
}

export function toGenerated(doc: PlatformDocument): GeneratedPlatform {
  const n = <T,>(v: T | undefined): T | null => v ?? null;
  return {
    workspace: { name: doc.workspace.name, description: n(doc.workspace.description), currency: n(doc.workspace.currency) },
    environments: doc.environments.map((e) => ({ id: e.id, name: e.name, description: n(e.description), kind: n(e.kind), provider: n(e.provider), region: n(e.region) })),
    networks: doc.networks.map((x) => ({ id: x.id, name: x.name, environmentId: x.environmentId, parentId: n(x.parentId), exposure: n(x.exposure), cidr: n(x.cidr), description: n(x.description) })),
    resources: doc.resources.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      environmentId: r.environmentId,
      networkId: n(r.networkId),
      technology: n(r.technology),
      version: n(r.version),
      status: n(r.status),
      iac: n(r.iac),
      owner: n(r.owner),
      description: n(r.description),
      monthlyCost: n(r.monthlyCost),
      region: n(r.region),
      cpuLimit: n(r.cpuLimit),
      memoryLimit: n(r.memoryLimit),
      expiresAt: n(r.expiresAt),
      counterpartOf: n(r.counterpartOf),
    })),
    services: doc.services.map((s) => ({
      id: s.id,
      name: s.name,
      kind: n(s.kind),
      description: n(s.description),
      technology: n(s.technology),
      owner: n(s.owner),
      repo: n(s.repo),
      criticality: n(s.criticality),
      slo: n(s.slo),
      sla: n(s.sla),
      external: n(s.external),
    })),
    deployments: doc.deployments.map((d) => ({ id: d.id, serviceId: d.serviceId, environmentId: d.environmentId, hostId: d.hostId, replicas: n(d.replicas), version: n(d.version), monthlyCost: n(d.monthlyCost), cpuLimit: n(d.cpuLimit), memoryLimit: n(d.memoryLimit) })),
    dependencies: doc.dependencies.map((d) => ({ id: d.id, sourceId: d.sourceId, targetId: d.targetId, kind: d.kind, protocol: n(d.protocol), description: n(d.description) })),
    pipelines: doc.pipelines.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      tool: n(p.tool),
      description: n(p.description),
      owner: n(p.owner),
      serviceIds: p.serviceIds,
      provisions: n(p.provisions),
      stages: p.stages.map((s) => ({ environmentId: s.environmentId, approval: n(s.approval) })),
    })),
  };
}

export const platformAiSpec: AiSpec<PlatformDocument> = {
  generationSchema: generatedPlatformSchema,
  generationJsonSchema,
  system: systemPrompt,
  user(instruction, base) {
    if (!base) return `Genera el modelo de arquitectura de plataforma para la siguiente descripción:\n\n${instruction}`;
    return (
      `Este es el modelo de plataforma actual en JSON:\n\n${JSON.stringify(toGenerated(base), null, 2)}\n\n` +
      `Aplica la siguiente instrucción de refinamiento y devuelve el modelo COMPLETO actualizado. Conserva los ids ` +
      `existentes de lo que no cambia y solo añade, modifica o elimina lo que la instrucción requiera:\n\n${instruction}`
    );
  },
  retry: (issues) => `El modelo devuelto no pasó la validación. Corrige estos problemas y devuelve el modelo completo de nuevo:\n${issues}`,
  toDocument: (generated) => generatedToPlatform(generated as GeneratedPlatform),
};
