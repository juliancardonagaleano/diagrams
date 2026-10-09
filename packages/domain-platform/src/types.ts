/**
 * Documento del módulo de arquitectura de plataforma: entornos (dev, staging, producción…), redes, recursos
 * aprovisionados (clústeres, bases de datos, colas…), servicios, dónde se despliega cada servicio, de quién depende y los
 * pipelines de CI/CD que los construyen y promueven. No guarda coordenadas: los diagramas se calculan al exportar.
 */
import type { IconPack } from './icons/types';

export const PLATFORM_DOCUMENT_VERSION = '1.0' as const;

/** De más a menos cercano al desarrollo: el orden en que un servicio debería promocionarse. */
export const ENVIRONMENT_KINDS = ['dev', 'test', 'staging', 'prod', 'dr'] as const;
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];

/** `public` = accesible desde Internet; `private` = solo desde dentro; `isolated` = sin salida ni entrada externas. */
export const EXPOSURES = ['public', 'private', 'isolated'] as const;
export type Exposure = (typeof EXPOSURES)[number];

export const RESOURCE_KINDS = ['cluster', 'vm', 'database', 'cache', 'queue', 'storage', 'load-balancer', 'gateway', 'dns', 'secret-store', 'registry', 'region', 'namespace', 'certificate', 'monitoring', 'other'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
/** Recursos donde se despliegan servicios. */
export const HOST_KINDS: ResourceKind[] = ['cluster', 'vm'];
/** Recursos que guardan datos o secretos: no deberían estar en una red pública. */
export const SENSITIVE_KINDS: ResourceKind[] = ['database', 'cache', 'queue', 'secret-store'];

export const RESOURCE_STATUSES = ['planned', 'provisioned', 'decommissioned'] as const;
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number];

export const SERVICE_KINDS = ['service', 'worker', 'job', 'frontend'] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

/** De menos a más crítica. */
export const CRITICALITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Criticality = (typeof CRITICALITIES)[number];

/** `calls` = llamada síncrona; `messages` = mensajería asíncrona; `data` = lectura o escritura de datos. */
export const DEPENDENCY_KINDS = ['calls', 'messages', 'data'] as const;
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];

/** `ci` construye y prueba; `cd` despliega; `ci-cd` hace ambos; `iac` aprovisiona recursos. */
export const PIPELINE_KINDS = ['ci', 'cd', 'ci-cd', 'iac'] as const;
export type PipelineKind = (typeof PIPELINE_KINDS)[number];

export interface Environment {
  id: string;
  name: string;
  description?: string;
  kind?: EnvironmentKind;
  provider?: string;
  region?: string;
}

export interface Network {
  id: string;
  name: string;
  environmentId: string;
  /** Red que la contiene (una subred dentro de su VPC). */
  parentId?: string;
  /** Si no se indica, `private`. */
  exposure?: Exposure;
  cidr?: string;
  description?: string;
  /** Proveedor de nube y servicio con cuyo icono se dibuja (una VPC de `aws`: `provider: 'aws'`, `service: 'vpc'`). */
  provider?: string;
  service?: string;
}

export interface Resource {
  id: string;
  name: string;
  kind: ResourceKind;
  environmentId: string;
  networkId?: string;
  technology?: string;
  version?: string;
  /** Si no se indica, `provisioned`. */
  status?: ResourceStatus;
  /** Se gestiona como código (Terraform, Pulumi…). Si no se indica, no se sabe. */
  iac?: boolean;
  owner?: string;
  description?: string;
  ref?: string;
  /** Tipo del enlace que declara `ref` (vocabulario abierto; `depends-on` si falta): `implements`, `protects`… */
  refType?: string;
  tags?: string[];
  /** Coste mensual del recurso (en la moneda del espacio de trabajo). */
  monthlyCost?: number;
  /** Fecha de caducidad (AAAA-MM-DD), p. ej. la de un certificado: con ella el análisis avisa cuando está cerca. */
  expiresAt?: string;
  /** Región donde está aprovisionado (si difiere de la del entorno). Los avisos la piden si el proveedor del recurso (`provider`) o, sin él, el de su entorno es una nube. */
  region?: string;
  /** Límite de CPU (vCPU, p. ej. «8») y de memoria (p. ej. «32 GiB»). */
  cpuLimit?: string;
  memoryLimit?: string;
  /**
   * Proveedor de nube (`aws`, `azure`… o el de un paquete propio) y servicio (`rds`, `sql-database`…) con cuyo icono se dibuja el
   * recurso. Si indica el proveedor y no el servicio, se sugiere el que encaje con su clase y su tecnología, si es inequívoco.
   */
  provider?: string;
  service?: string;
  /**
   * Id del recurso de otro entorno que es el equivalente de este («Kafka (dev)» y «Kafka (prod)» son el mismo recurso en dos
   * entornos). Al comparar entornos manda sobre toda deducción por nombre, tecnología o clase. Basta que lo declare uno de los
   * dos y la equivalencia es simétrica y transitiva: dev → staging y staging → prod hacen equivalentes a dev y prod. En cada
   * entorno solo puede haber un recurso (no dado de baja) de cada equivalencia (ver `counterpartErrors`).
   */
  counterpartOf?: string;
}

export interface Service {
  id: string;
  name: string;
  /** Si no se indica, `service`. */
  kind?: ServiceKind;
  description?: string;
  technology?: string;
  owner?: string;
  repo?: string;
  criticality?: Criticality;
  /** Objetivo de nivel de servicio interno (p. ej. «99,9 % disponibilidad») y compromiso con el cliente (p. ej. «99,5 %»). */
  slo?: string;
  sla?: string;
  /** Servicio de un tercero (SaaS): no se despliega en la plataforma. */
  external?: boolean;
  ref?: string;
  /** Tipo del enlace que declara `ref` (vocabulario abierto; `depends-on` si falta): `implements`, `protects`… */
  refType?: string;
  tags?: string[];
  /** Servicio de nube que lo ejecuta o que es (una función en `aws` + `lambda`): como en `Resource`, decide su icono. */
  provider?: string;
  service?: string;
}

/** Dónde se ejecuta un servicio en un entorno. */
export interface Deployment {
  id: string;
  serviceId: string;
  environmentId: string;
  /** Clúster o máquina virtual (del mismo entorno) donde corre. */
  hostId: string;
  replicas?: number;
  version?: string;
  /** Coste mensual de esta instancia (se suma al de los recursos en la vista de costes) y límites por réplica. */
  monthlyCost?: number;
  cpuLimit?: string;
  memoryLimit?: string;
}

/** De quién depende un servicio o un recurso (el origen depende del destino). */
export interface Dependency {
  id: string;
  sourceId: string;
  targetId: string;
  kind: DependencyKind;
  protocol?: string;
  description?: string;
}

export interface PipelineStage {
  environmentId: string;
  /** Pide una aprobación manual antes de desplegar. */
  approval?: boolean;
}

export interface Pipeline {
  id: string;
  name: string;
  kind: PipelineKind;
  tool?: string;
  description?: string;
  owner?: string;
  /** Servicios que construye y/o despliega. */
  serviceIds: string[];
  /** Recursos que aprovisiona (pipelines `iac`). */
  provisions?: string[];
  /** Entornos por los que promociona, en orden. */
  stages: PipelineStage[];
}

export interface PlatformDocument {
  version: typeof PLATFORM_DOCUMENT_VERSION;
  workspace: {
    name: string;
    description?: string;
    /** Moneda de los costes (código ISO, p. ej. «EUR»); si no se indica, USD. */
    currency?: string;
    /** Paquetes de iconos propios de este documento (un proveedor que no es AWS ni Azure, o los iconos oficiales con licencia): se superponen a los registrados. */
    iconPacks?: IconPack[];
  };
  environments: Environment[];
  networks: Network[];
  resources: Resource[];
  services: Service[];
  deployments: Deployment[];
  dependencies: Dependency[];
  pipelines: Pipeline[];
}

export type ElementKind = 'environment' | 'network' | 'resource' | 'service' | 'pipeline';
export type Item = Environment | Network | Resource | Service | Pipeline;

/** Elemento del documento con su tipo (los ids son únicos entre tipos). */
export interface Element {
  kind: ElementKind;
  id: string;
  name: string;
  item: Item;
}

export const ELEMENT_LABELS: Record<ElementKind, string> = {
  environment: 'Entorno',
  network: 'Red',
  resource: 'Recurso',
  service: 'Servicio',
  pipeline: 'Pipeline',
};

export const ENVIRONMENT_LABELS: Record<EnvironmentKind, string> = {
  dev: 'desarrollo',
  test: 'pruebas',
  staging: 'preproducción',
  prod: 'producción',
  dr: 'recuperación ante desastres',
};

export const EXPOSURE_LABELS: Record<Exposure, string> = { public: 'pública', private: 'privada', isolated: 'aislada' };

export const RESOURCE_LABELS: Record<ResourceKind, string> = {
  cluster: 'Clúster',
  vm: 'Máquina virtual',
  database: 'Base de datos',
  cache: 'Caché',
  queue: 'Cola o broker',
  storage: 'Almacenamiento',
  'load-balancer': 'Balanceador',
  gateway: 'Pasarela',
  dns: 'DNS',
  'secret-store': 'Almacén de secretos',
  registry: 'Registro de imágenes',
  region: 'Región o zona de disponibilidad',
  namespace: 'Espacio de nombres',
  certificate: 'Certificado o dominio',
  monitoring: 'Monitorización o SLO',
  other: 'Otro recurso',
};

export const CRITICALITY_LABELS: Record<Criticality, string> = { low: 'baja', medium: 'media', high: 'alta', critical: 'crítica' };

export const SERVICE_LABELS: Record<ServiceKind, string> = { service: 'Servicio', worker: 'Worker', job: 'Job', frontend: 'Frontend' };

export const STATUS_LABELS: Record<ResourceStatus, string> = { planned: 'previsto', provisioned: 'aprovisionado', decommissioned: 'dado de baja' };

export const DEPENDENCY_LABELS: Record<DependencyKind, string> = { calls: 'llama a', messages: 'envía mensajes a', data: 'usa los datos de' };

export const PIPELINE_LABELS: Record<PipelineKind, string> = { ci: 'CI', cd: 'CD', 'ci-cd': 'CI/CD', iac: 'Infraestructura como código' };

export const currencyOf = (doc: PlatformDocument): string => doc.workspace.currency?.trim() || 'USD';

export const isHost = (r: Resource): boolean => HOST_KINDS.includes(r.kind);
export const statusOf = (r: Resource): ResourceStatus => r.status ?? 'provisioned';
export const exposureOf = (n: Network): Exposure => n.exposure ?? 'private';
export const serviceKindOf = (s: Service): ServiceKind => s.kind ?? 'service';

/** Todos los elementos del documento por id. */
export function indexElements(doc: PlatformDocument): Map<string, Element> {
  const map = new Map<string, Element>();
  const add = (kind: ElementKind, items: Item[]): void => {
    for (const item of items) if (!map.has(item.id)) map.set(item.id, { kind, id: item.id, name: item.name, item });
  };
  add('environment', doc.environments);
  add('network', doc.networks);
  add('resource', doc.resources);
  add('service', doc.services);
  add('pipeline', doc.pipelines);
  return map;
}
