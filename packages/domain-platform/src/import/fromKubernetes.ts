/**
 * Importador de manifiestos de Kubernetes para el módulo de plataforma. Acepta YAML (o JSON) con uno o varios documentos
 * (`---`), también `kind: List`, de lo que genera `kubectl get -o yaml`, `kustomize build` o `helm template`. Reconoce el
 * formato por `apiVersion` + `kind`.
 *
 * Correspondencia:
 *
 *   manifiesto                                           → elemento del módulo
 *   ---------------------------------------------------------------------------------------------------------------
 *   el conjunto de manifiestos                           → UN entorno (nombre: la etiqueta `environment`/`env`, el único
 *                                                          namespace con nombre de entorno, o el nombre del archivo o
 *                                                          carpeta); si hay dos o más namespaces con nombre de entorno
 *                                                          (`dev`, `staging`, `production`…) cada uno es un entorno.
 *   (implícito)                                          → recurso `cluster` «Clúster Kubernetes» por entorno, anfitrión de
 *                                                          los despliegues (los manifiestos no dicen cuál es: se avisa)
 *   Namespace                                            → recurso `namespace` (solo los que se declaran)
 *   Deployment, StatefulSet                              → servicio + despliegue (réplicas, versión = etiqueta de la imagen,
 *                                                          límites de CPU y memoria sumados de los contenedores)
 *   DaemonSet                                            → servicio `worker` + despliegue (una instancia por nodo)
 *   CronJob, Job                                         → servicio `job` + despliegue
 *   carga cuya imagen es un almacén conocido (postgres,  → recurso `database`, `cache`, `queue` o `storage` en lugar de servicio
 *   mysql, mongo, redis, rabbitmq, kafka, minio…)          (así las dependencias de datos llegan al recurso)
 *   HorizontalPodAutoscaler                              → réplicas del despliegue = `minReplicas`; el rango, en la descripción
 *   Service ClusterIP/NodePort                           → no es un elemento: es el destino de las dependencias; su
 *                                                          `selector` lo enlaza con las cargas que lo implementan
 *   Service LoadBalancer                                 → recurso `load-balancer` en una red pública (privada si es interno)
 *   Service ExternalName                                 → servicio externo (`external`)
 *   Ingress, Gateway (Gateway API)                       → recurso `gateway` en la red pública «Entrada pública»; sus reglas
 *                                                          (o HTTPRoute/GRPCRoute) son dependencias hacia los servicios
 *   PersistentVolumeClaim                                → recurso `storage`; dependencia `data` de quien lo monta
 *   ConfigMap                                            → recurso `other`; dependencia `data` de quien lo usa
 *   Secret                                               → recurso `secret-store`. NUNCA se copian sus valores (`data`,
 *                                                          `stringData`): solo el tipo y los nombres de las claves
 *
 * Dependencias inferidas (cada una con su origen en la descripción): variables de entorno (también las que vienen de un
 * ConfigMap por `configMapKeyRef`/`envFrom`) y argumentos que apuntan a otro Service (`http://svc`, `svc.ns.svc.cluster.local`,
 * `host:puerto`, o un nombre de Service en una variable que lo sugiere, como `DB_HOST`), URL en los ConfigMap que monta el
 * pod (`proxy_pass http://api`), `selector` de Service e Ingress y los volúmenes. El protocolo sale del esquema o del puerto.
 *
 * Lo que NO se mapea y cómo se avisa: kinds sin mapear (CRD, Pod…) y de soporte (ServiceAccount, Role, NetworkPolicy…) agrupados;
 * hosts de variables de entorno que apuntan a un Service que no está en los manifiestos; Services cuyo `selector` no coincide
 * con nada; valores que vienen de un Secret (no se leen); hosts externos (no se importan como dependencias); réplicas 0; el
 * clúster implícito y un entorno por defecto cuando los manifiestos no lo dicen.
 */
import { pickId, textSizeProblem, Warnings } from '@iark/kernel';
import { parseAllDocuments } from 'yaml';
import { formatPlatformIssues, validatePlatformDocument } from '../schema';
import {
  PLATFORM_DOCUMENT_VERSION,
  type Dependency,
  type DependencyKind,
  type Deployment,
  type Environment,
  type Network,
  type PlatformDocument,
  type Resource,
  type ResourceKind,
  type Service,
  type ServiceKind,
} from '../types';
import { countedList, descriptiveName, environmentKindOf, shortList, sourceName, uniqueId, type InfraImportOptions } from './common';
import { PlatformImportError, type PlatformImportResult } from './fromMermaid';

type Json = Record<string, unknown>;

const rec = (v: unknown): Json | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
const unique = <T>(items: T[]): T[] => [...new Set(items)];
const strMap = (v: unknown): Record<string, string> => Object.fromEntries(Object.entries(rec(v) ?? {}).filter(([, x]) => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean').map(([k, x]) => [k, String(x)]));

interface Obj {
  kind: string;
  apiVersion: string;
  group: string;
  name: string;
  ns: string;
  raw: Json;
}

interface Workload {
  obj: Obj;
  labels: Record<string, string>;
  containers: Json[];
  initContainers: Json[];
  volumes: Json[];
  hasPorts: boolean;
}

/** Lo que representa una carga, un Service de Kubernetes o un Ingress en el documento. */
interface Target {
  type: 'service' | 'resource';
  id: string;
  /** Clase del recurso (`database`…), si lo es. */
  resource?: ResourceKind;
  external?: boolean;
}

interface Found {
  host: string;
  port?: number;
  scheme?: string;
  /** De dónde sale: `la variable DATABASE_URL`. */
  origin: string;
}

const WORKLOADS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Job']);
const SUPPORT_KINDS = new Set([
  'ServiceAccount', 'Role', 'RoleBinding', 'ClusterRole', 'ClusterRoleBinding', 'NetworkPolicy', 'PodDisruptionBudget', 'ResourceQuota', 'LimitRange', 'StorageClass', 'PersistentVolume',
  'IngressClass', 'PriorityClass', 'Endpoints', 'EndpointSlice', 'Event', 'Lease', 'ValidatingWebhookConfiguration', 'MutatingWebhookConfiguration', 'APIService', 'CustomResourceDefinition',
  'RuntimeClass', 'GatewayClass', 'Kustomization',
]);
/** Los kinds que se dibujan y viven en un namespace (un Namespace o un ClusterRole no cuentan para repartir los ids). */
const NAMESPACED = new Set([...WORKLOADS, 'Service', 'ConfigMap', 'Secret', 'PersistentVolumeClaim', 'Ingress', 'Gateway']);
const ROUTES = new Set(['HTTPRoute', 'GRPCRoute', 'TCPRoute', 'TLSRoute']);
const SYSTEM_NAMESPACES = new Set(['kube-system', 'kube-public', 'kube-node-lease']);
const ENV_LABEL = /^(?:app\.kubernetes\.io\/)?(?:environment|env|stage)$/;
const OWNER_LABEL = /^(?:owner|team|app\.kubernetes\.io\/(?:owner|team))$/;
/** Variables cuyo valor es un host: por la última palabra del nombre (`DB_HOST`, `redisHost`, `BROKER_URL`) o, si es una sola, por lo que nombra (`REDIS`). */
const HOST_LAST = /^(?:host|hosts|hostname|url|uri|addr|address|endpoint|endpoints|server|dsn|broker|brokers|service|svc|upstream|backend|target)$/;
const HOST_ALONE = /^(?:db|database|redis|cache|queue|kafka|amqp|rabbitmq|mongo|mongodb|postgres|postgresql|mysql|memcached|elasticsearch|nats)$/;
const LOCAL_HOSTS = /^(?:localhost|127(?:\.\d+){3}|0\.0\.0\.0|::1)$/;

function looksLikeHostVariable(name: string): boolean {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const last = words[words.length - 1];
  return last !== undefined && (HOST_LAST.test(last) || (words.length === 1 && HOST_ALONE.test(last)));
}

/** Almacenes de datos que se reconocen por el nombre de su imagen: el recurso que son y su nombre comercial. */
export const DATASTORES: Record<string, { kind: ResourceKind; technology: string }> = {
  postgres: { kind: 'database', technology: 'PostgreSQL' },
  postgresql: { kind: 'database', technology: 'PostgreSQL' },
  postgis: { kind: 'database', technology: 'PostGIS' },
  timescaledb: { kind: 'database', technology: 'TimescaleDB' },
  mysql: { kind: 'database', technology: 'MySQL' },
  mariadb: { kind: 'database', technology: 'MariaDB' },
  mongo: { kind: 'database', technology: 'MongoDB' },
  mongodb: { kind: 'database', technology: 'MongoDB' },
  cassandra: { kind: 'database', technology: 'Cassandra' },
  cockroach: { kind: 'database', technology: 'CockroachDB' },
  clickhouse: { kind: 'database', technology: 'ClickHouse' },
  'clickhouse-server': { kind: 'database', technology: 'ClickHouse' },
  couchdb: { kind: 'database', technology: 'CouchDB' },
  elasticsearch: { kind: 'database', technology: 'Elasticsearch' },
  opensearch: { kind: 'database', technology: 'OpenSearch' },
  influxdb: { kind: 'database', technology: 'InfluxDB' },
  neo4j: { kind: 'database', technology: 'Neo4j' },
  redis: { kind: 'cache', technology: 'Redis' },
  valkey: { kind: 'cache', technology: 'Valkey' },
  memcached: { kind: 'cache', technology: 'Memcached' },
  keydb: { kind: 'cache', technology: 'KeyDB' },
  dragonfly: { kind: 'cache', technology: 'Dragonfly' },
  rabbitmq: { kind: 'queue', technology: 'RabbitMQ' },
  kafka: { kind: 'queue', technology: 'Apache Kafka' },
  nats: { kind: 'queue', technology: 'NATS' },
  activemq: { kind: 'queue', technology: 'ActiveMQ' },
  pulsar: { kind: 'queue', technology: 'Apache Pulsar' },
  redpanda: { kind: 'queue', technology: 'Redpanda' },
  minio: { kind: 'storage', technology: 'MinIO' },
};

const SCHEMES: Record<string, string> = {
  http: 'HTTP', https: 'HTTPS', grpc: 'gRPC', grpcs: 'gRPC', postgres: 'PostgreSQL', postgresql: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', mongodb: 'MongoDB', 'mongodb+srv': 'MongoDB',
  redis: 'Redis', rediss: 'Redis', amqp: 'AMQP', amqps: 'AMQP', kafka: 'Kafka', nats: 'NATS', ws: 'WebSocket', wss: 'WebSocket', tcp: 'TCP', smtp: 'SMTP', ldap: 'LDAP',
};
const PORTS: Record<number, string> = { 80: 'HTTP', 443: 'HTTPS', 3306: 'MySQL', 5432: 'PostgreSQL', 5672: 'AMQP', 6379: 'Redis', 9092: 'Kafka', 27017: 'MongoDB', 4222: 'NATS', 8080: 'HTTP', 8443: 'HTTPS', 9200: 'HTTP' };

// ───────────── cantidades de Kubernetes ─────────────

export function cpuMillis(q: unknown): number | undefined {
  const m = /^(\d+(?:\.\d+)?)(m)?$/.exec(String(q ?? '').trim());
  return m ? Number(m[1]) * (m[2] ? 1 : 1000) : undefined;
}

const BYTES: Record<string, number> = { '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 };

export function memoryBytes(q: unknown): number | undefined {
  const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(String(q ?? '').trim());
  return m ? Number(m[1]) * BYTES[m[2] ?? ''] : undefined;
}

export const formatCpu = (millis: number): string => String(Math.round(millis) / 1000);

export function formatMemory(bytes: number): string {
  const mib = bytes / 1024 ** 2;
  if (mib >= 1024 && Number.isInteger(mib / 1024)) return `${mib / 1024} GiB`;
  return Number.isInteger(mib) ? `${mib} MiB` : `${Math.round(mib * 10) / 10} MiB`;
}

/** Nombre de la imagen sin registro, organización ni etiqueta (`bitnami/postgresql:15` → `postgresql`) y su etiqueta. */
export function imageParts(image: string | undefined): { base?: string; tag?: string } {
  if (!image) return {};
  const noDigest = image.split('@')[0];
  const last = noDigest.slice(noDigest.lastIndexOf('/') + 1);
  const [base, tag] = last.split(':');
  return { base: base?.toLowerCase() || undefined, ...(tag ? { tag } : {}) };
}

// ───────────── lectura ─────────────

/** Si el texto tiene `{{ … }}`, lo más probable es una plantilla de Helm sin renderizar. */
const helmHint = (input: string): string => (/\{\{/.test(input) ? ' ¿Es una plantilla de Helm sin renderizar? Usa `helm template` o `kustomize build` primero.' : '');

function readObjects(source: string, warnings: Warnings): Obj[] {
  const input = source.replace(/^﻿/, '');
  if (input.trim() === '') throw new PlatformImportError('El archivo de Kubernetes está vacío.');
  const big = textSizeProblem(input, 'El archivo de Kubernetes');
  if (big) throw new PlatformImportError(big);
  let docs: ReturnType<typeof parseAllDocuments>;
  try {
    docs = parseAllDocuments(input, { logLevel: 'error' });
  } catch (error) {
    // Un anidamiento enorme agota la pila del analizador YAML.
    if (error instanceof RangeError) throw new PlatformImportError('El archivo de Kubernetes está demasiado anidado para analizarlo.');
    throw error;
  }
  const objects: Obj[] = [];
  let index = 0;
  const push = (value: unknown, origin: string): void => {
    const raw = rec(value);
    if (!raw) {
      if (value !== null && value !== undefined) warnings.add(`${origin} no es un objeto de Kubernetes; se omite.`);
      return;
    }
    const kind = text(raw.kind);
    const apiVersion = text(raw.apiVersion);
    if (!kind || !apiVersion) {
      warnings.add(`${origin} no tiene apiVersion y kind; se omite.`);
      return;
    }
    const metadata = rec(raw.metadata) ?? {};
    if (kind === 'List' || (kind.endsWith('List') && Array.isArray(raw.items))) {
      arr(raw.items).forEach((item, i) => push(item, `${origin}, elemento ${i + 1} de la lista`));
      return;
    }
    const name = text(metadata.name);
    if (!name) {
      if (rec(raw.metadata)?.generateName === undefined) warnings.add(`${origin} (${kind}) no tiene metadata.name; se omite.`);
      else warnings.add(`${origin} (${kind}) usa generateName, no un nombre fijo; se omite.`);
      return;
    }
    objects.push({ kind, apiVersion, group: apiVersion.includes('/') ? apiVersion.split('/')[0] : '', name, ns: text(metadata.namespace) ?? 'default', raw });
  };
  for (const doc of docs) {
    index += 1;
    if (doc.errors.length > 0) {
      const e = doc.errors[0];
      const line = e.linePos?.[0]?.line;
      const why = e.message.split('\n')[0].replace(/\s+at line \d+, column \d+:?$/, '').replace(/[.:]$/, '');
      throw new PlatformImportError(`El YAML de Kubernetes no es válido${line ? ` (línea ${line})` : ''}: ${why}.${helmHint(input)}`);
    }
    let value: unknown;
    try {
      value = doc.toJS({ maxAliasCount: 200 });
    } catch (error) {
      // Una bomba de alias (cada alias multiplica al anterior) o un anidamiento que agota la pila.
      if (error instanceof RangeError) throw new PlatformImportError('El archivo de Kubernetes está demasiado anidado para analizarlo.');
      if (error instanceof ReferenceError) throw new PlatformImportError(`El documento ${index} de Kubernetes usa demasiados alias YAML (posible bomba de expansión): no se importa.`);
      throw error;
    }
    push(value, `El documento ${index}`);
  }
  return objects;
}

/** ¿Parece un manifiesto de Kubernetes? `apiVersion` y `kind` en el primer nivel (YAML o JSON). */
export function looksLikeKubernetes(source: string): boolean {
  const t = source.replace(/^﻿/, '');
  if (t.trimStart().startsWith('{')) {
    try {
      const json = rec(JSON.parse(t));
      return !!json && typeof json.apiVersion === 'string' && typeof json.kind === 'string' && !('terraform_version' in json);
    } catch {
      return false;
    }
  }
  return /^apiVersion:[ \t]*\S+/m.test(t) && /^kind:[ \t]*\S+/m.test(t);
}

// ───────────── constructor ─────────────

class KubernetesBuilder {
  private readonly taken = new Set<string>();
  private readonly workloads: Workload[] = [];
  private readonly services = new Map<string, Obj>(); // `ns/nombre` → Service de Kubernetes
  private readonly configMaps = new Map<string, Obj>();
  private readonly secrets = new Map<string, Obj>();
  private readonly pvcs = new Map<string, Obj>();
  private readonly hpas = new Map<string, Obj>(); // `ns/Kind/nombre` → HPA
  private readonly targets = new Map<string, Target>(); // `ns/Kind/nombre` o `ns/Service/nombre` → elemento
  private readonly environments: Environment[] = [];
  private readonly networks: Network[] = [];
  private readonly resources: Resource[] = [];
  private readonly serviceList: Service[] = [];
  private readonly deployments: Deployment[] = [];
  private readonly dependencies: Dependency[] = [];
  private readonly signatures = new Set<string>();
  private readonly dependencyIds = new Set<string>();
  private readonly envByNamespace = new Map<string, string>();
  private defaultEnvironment: string | undefined;
  private readonly clusters = new Map<string, Resource>();
  private readonly publicNetworks = new Map<string, Network>();
  private readonly secretRefs: string[] = [];
  private readonly unresolved: string[] = [];
  private readonly externalHosts = new Map<string, string>();
  private readonly byName = new Map<string, Service>();
  private readonly namespacesOf = new Map<string, Set<string>>(); // nombre → namespaces donde aparece (para ids)
  private readonly unmapped: string[] = [];
  private readonly support: string[] = [];
  private readonly objects: Obj[];

  constructor(
    objects: Obj[],
    private readonly options: InfraImportOptions,
    private readonly warnings: Warnings,
  ) {
    this.objects = objects;
  }

  /** Nombre que da el origen de los manifiestos (el chart de Helm que los generó, o el archivo o la carpeta) y de dónde sale. */
  private origin(): { name: string; reason: string } | undefined {
    if (this.options.chart) return { name: this.options.chart, reason: `del chart de Helm «${this.options.chart}»` };
    const name = sourceName(this.options);
    return name ? { name, reason: 'del nombre del archivo' } : undefined;
  }

  private key(ns: string, name: string): string {
    return `${ns}/${name}`;
  }

  build(): PlatformImportResult {
    this.classify();
    if (this.workloads.length === 0 && ![...this.targets.values()].some(Boolean) && this.objects.filter((o) => ['Ingress', 'PersistentVolumeClaim', 'Secret', 'ConfigMap', 'Namespace'].includes(o.kind)).length === 0) {
      throw new PlatformImportError('Los manifiestos no definen ninguna carga de trabajo ni recurso que se pueda importar (Deployment, StatefulSet, DaemonSet, CronJob, Job, Ingress, PersistentVolumeClaim…).');
    }
    this.createEnvironments();
    this.createNamespaces();
    this.createWorkloads();
    this.createStorage();
    this.createServices();
    this.createIngresses();
    this.createRoutes();
    this.inferDependencies();
    this.reportWarnings();

    const result = validatePlatformDocument({
      version: PLATFORM_DOCUMENT_VERSION,
      workspace: { name: this.options.name?.trim() || this.origin()?.name || 'Arquitectura de plataforma' },
      environments: this.environments,
      networks: this.networks,
      resources: this.resources,
      services: this.serviceList,
      deployments: this.deployments,
      dependencies: this.dependencies,
      pipelines: [],
    });
    if (!result.ok) throw new PlatformImportError(`No se pudo construir un documento válido a partir de Kubernetes:\n${formatPlatformIssues(result.issues)}`);
    return { document: result.document as PlatformDocument, warnings: this.warnings.result() };
  }

  // ───────────── clasificación ─────────────

  /** Base del id de un elemento: su nombre, o `nombre-namespace` si el mismo nombre existe en más de un namespace. */
  private idBase(name: string, ns: string): string {
    return (this.namespacesOf.get(name)?.size ?? 0) > 1 ? `${name}-${ns}` : name;
  }

  private classify(): void {
    for (const obj of this.objects.filter((o) => NAMESPACED.has(o.kind))) {
      const seen = this.namespacesOf.get(obj.name) ?? new Set<string>();
      seen.add(obj.ns);
      this.namespacesOf.set(obj.name, seen);
    }
    for (const obj of this.objects) {
      const k = this.key(obj.ns, obj.name);
      if (WORKLOADS.has(obj.kind) && ['apps', 'batch', 'extensions'].includes(obj.group)) this.workloads.push(this.readWorkload(obj));
      else if (obj.kind === 'Service' && obj.apiVersion === 'v1') this.services.set(k, obj);
      else if (obj.kind === 'ConfigMap' && obj.apiVersion === 'v1') this.configMaps.set(k, obj);
      else if (obj.kind === 'Secret' && obj.apiVersion === 'v1') this.secrets.set(k, obj);
      else if (obj.kind === 'PersistentVolumeClaim' && obj.apiVersion === 'v1') this.pvcs.set(k, obj);
      else if (obj.kind === 'HorizontalPodAutoscaler' && obj.group === 'autoscaling') {
        const ref = rec(rec(obj.raw.spec)?.scaleTargetRef);
        if (ref && text(ref.kind) && text(ref.name)) this.hpas.set(`${obj.ns}/${text(ref.kind)}/${text(ref.name)}`, obj);
      } else if (obj.kind === 'Namespace' && obj.apiVersion === 'v1') continue;
      else if (obj.kind === 'Ingress' && ['networking.k8s.io', 'extensions'].includes(obj.group)) continue;
      else if (obj.kind === 'Gateway' && obj.group === 'gateway.networking.k8s.io') continue;
      else if (ROUTES.has(obj.kind) && obj.group === 'gateway.networking.k8s.io') continue;
      else if (SUPPORT_KINDS.has(obj.kind)) this.support.push(obj.kind);
      else this.unmapped.push(obj.group ? `${obj.kind} (${obj.group})` : obj.kind);
    }
  }

  private readWorkload(obj: Obj): Workload {
    const spec = rec(obj.raw.spec) ?? {};
    const template = obj.kind === 'CronJob' ? rec(rec(rec(spec.jobTemplate)?.spec)?.template) : rec(spec.template);
    const pod = rec(template?.spec) ?? {};
    const containers = arr(pod.containers).map(rec).filter((c): c is Json => !!c);
    return {
      obj,
      labels: strMap(rec(template?.metadata)?.labels),
      containers,
      initContainers: arr(pod.initContainers).map(rec).filter((c): c is Json => !!c),
      volumes: arr(pod.volumes).map(rec).filter((v): v is Json => !!v),
      hasPorts: containers.some((c) => arr(c.ports).length > 0),
    };
  }

  // ───────────── entornos ─────────────

  private labelEnvironments(): string[] {
    const found: string[] = [];
    const take = (labels: unknown): void => {
      for (const [k, v] of Object.entries(strMap(labels))) if (ENV_LABEL.test(k) && v.trim() !== '') found.push(v.trim());
    };
    for (const o of this.objects.filter((x) => x.kind === 'Namespace')) take(rec(o.raw.metadata)?.labels);
    for (const w of this.workloads) take(rec(w.obj.raw.metadata)?.labels);
    return found;
  }

  private createEnvironments(): void {
    const namespaces = unique([...this.workloads.map((w) => w.obj.ns), ...this.objects.filter((o) => ['Ingress', 'Service', 'PersistentVolumeClaim', 'Secret', 'ConfigMap'].includes(o.kind)).map((o) => o.ns), ...this.objects.filter((o) => o.kind === 'Namespace').map((o) => o.name)]).filter(
      (n) => !SYSTEM_NAMESPACES.has(n),
    );
    const envLike = namespaces.filter((n) => environmentKindOf(n) !== undefined);
    if (envLike.length >= 2) {
      for (const ns of envLike) this.envByNamespace.set(ns, this.newEnvironment(ns, `del namespace «${ns}»`));
      return;
    }
    const counts = new Map<string, number>();
    for (const v of this.labelEnvironments()) counts.set(v, (counts.get(v) ?? 0) + 1);
    const ranked = [...counts].sort((a, b) => b[1] - a[1]);
    if (ranked.length > 1) this.warnings.add(`Las etiquetas de entorno tienen valores distintos (${ranked.map(([v, n]) => `${v} ×${n}`).join(', ')}): se usa «${ranked[0][0]}» para todo.`);
    let name: string;
    let reason: string;
    if (ranked.length > 0) [name, reason] = [ranked[0][0], 'de la etiqueta de entorno'];
    else if (envLike.length === 1) [name, reason] = [envLike[0], `del namespace «${envLike[0]}»`];
    else {
      const origin = this.origin();
      [name, reason] = [origin?.name ?? 'Entorno principal', origin?.reason ?? 'del valor por defecto'];
      this.warnings.add(`No se pudo deducir el entorno de las etiquetas ni de los namespaces: se crea el entorno «${name}» a partir ${reason}.`);
    }
    this.defaultEnvironment = this.newEnvironment(name, reason);
  }

  private newEnvironment(name: string, reason: string): string {
    const kind = environmentKindOf(name);
    const id = uniqueId(name, 'entorno', this.taken);
    this.environments.push({ id, name, description: `Entorno deducido ${reason}.`, ...(kind ? { kind } : {}), provider: 'kubernetes' });
    return id;
  }

  private environmentOf(ns: string): string {
    const known = this.envByNamespace.get(ns);
    if (known) return known;
    if (!this.defaultEnvironment) {
      const origin = this.origin();
      const source = origin?.name ?? 'Entorno principal';
      this.defaultEnvironment = this.newEnvironment(source, origin?.reason ?? 'del nombre del archivo');
      this.warnings.add(`Hay varios entornos por namespace y «${ns}» no es uno de ellos: se crea el entorno «${source}» para lo que no tiene namespace de entorno.`);
    }
    return this.defaultEnvironment;
  }

  /** Clúster (implícito) del entorno donde se despliega. */
  private clusterOf(environmentId: string): Resource {
    const found = this.clusters.get(environmentId);
    if (found) return found;
    const multi = this.environments.length > 1;
    const name = multi ? `Clúster Kubernetes (${this.environments.find((e) => e.id === environmentId)!.name})` : 'Clúster Kubernetes';
    const res: Resource = {
      id: uniqueId(multi ? `kubernetes-${environmentId}` : 'kubernetes', 'cluster', this.taken),
      name,
      kind: 'cluster',
      environmentId,
      technology: 'Kubernetes',
      description: 'Clúster implícito: los manifiestos no dicen en cuál se despliegan.',
    };
    this.clusters.set(environmentId, res);
    this.resources.push(res);
    return res;
  }

  private publicNetwork(environmentId: string): Network {
    const found = this.publicNetworks.get(environmentId);
    if (found) return found;
    const net: Network = { id: uniqueId(this.environments.length > 1 ? `entrada-publica-${environmentId}` : 'entrada-publica', 'red', this.taken), name: 'Entrada pública', environmentId, exposure: 'public', description: 'Red que agrupa lo que se expone a Internet (Ingress, Gateway y Services LoadBalancer).' };
    this.publicNetworks.set(environmentId, net);
    this.networks.push(net);
    return net;
  }

  // ───────────── elementos ─────────────

  private createNamespaces(): void {
    for (const o of this.objects.filter((x) => x.kind === 'Namespace' && x.apiVersion === 'v1')) {
      if (SYSTEM_NAMESPACES.has(o.name)) continue;
      const labels = strMap(rec(o.raw.metadata)?.labels);
      const res: Resource = {
        id: uniqueId(o.name, 'namespace', this.taken),
        name: o.name,
        kind: 'namespace',
        environmentId: this.environmentOf(o.name),
        technology: 'Kubernetes',
        description: ['Espacio de nombres de Kubernetes', Object.keys(labels).length > 0 ? `etiquetas: ${shortList(Object.entries(labels).map(([k, v]) => `${k}=${v}`), 4)}` : undefined].filter(Boolean).join(' · '),
      };
      this.resources.push(res);
      this.targets.set(`namespace/${o.name}`, { type: 'resource', id: res.id, resource: 'namespace' });
    }
  }

  private primaryContainer(w: Workload): Json | undefined {
    return w.containers.find((c) => text(c.name) === w.obj.name) ?? w.containers[0];
  }

  private serviceKindOf(w: Workload, selected: boolean): ServiceKind {
    const labels = { ...w.labels, ...strMap(rec(w.obj.raw.metadata)?.labels) };
    const role = [labels['app.kubernetes.io/component'], labels.tier, labels.component, labels.role].filter(Boolean).map((x) => x.toLowerCase());
    if (w.obj.kind === 'CronJob' || w.obj.kind === 'Job') return 'job';
    if (w.obj.kind === 'DaemonSet') return 'worker';
    if (role.some((r) => ['frontend', 'web', 'ui', 'front-end'].includes(r))) return 'frontend';
    if (role.some((r) => ['worker', 'consumer', 'queue-worker'].includes(r))) return 'worker';
    return w.hasPorts || selected ? 'service' : 'worker';
  }

  private selectedBy(w: Workload): boolean {
    return [...this.services.values()].some((s) => s.ns === w.obj.ns && this.matches(s, w));
  }

  private matches(service: Obj, w: Workload): boolean {
    const selector = strMap(rec(service.raw.spec)?.selector);
    const entries = Object.entries(selector);
    return entries.length > 0 && w.obj.ns === service.ns && entries.every(([k, v]) => w.labels[k] === v);
  }

  private limits(w: Workload): { cpu?: string; memory?: string } {
    let cpu = 0;
    let memory = 0;
    let hasCpu = false;
    let hasMemory = false;
    for (const c of w.containers) {
      const limits = rec(rec(c.resources)?.limits);
      const m = cpuMillis(limits?.cpu);
      const b = memoryBytes(limits?.memory);
      if (m !== undefined) [cpu, hasCpu] = [cpu + m, true];
      if (b !== undefined) [memory, hasMemory] = [memory + b, true];
    }
    return { ...(hasCpu ? { cpu: formatCpu(cpu) } : {}), ...(hasMemory ? { memory: formatMemory(memory) } : {}) };
  }

  private owner(w: Workload): string | undefined {
    const labels = { ...strMap(rec(w.obj.raw.metadata)?.labels), ...w.labels };
    const key = Object.keys(labels).find((k) => OWNER_LABEL.test(k));
    return key ? labels[key] : text(strMap(rec(w.obj.raw.metadata)?.annotations).owner);
  }

  private createWorkloads(): void {
    for (const w of this.workloads) {
      const { obj } = w;
      const environmentId = this.environmentOf(obj.ns);
      const primary = this.primaryContainer(w);
      const image = text(primary?.image);
      const { base, tag } = imageParts(image);
      const datastore = base && DATASTORES[base] && (obj.kind === 'Deployment' || obj.kind === 'StatefulSet') ? DATASTORES[base] : undefined;
      const spec = rec(obj.raw.spec) ?? {};
      const hpa = this.hpas.get(`${obj.ns}/${obj.kind}/${obj.name}`);
      const hpaSpec = rec(hpa?.raw.spec);
      const min = num(hpaSpec?.minReplicas) ?? 1;
      const max = num(hpaSpec?.maxReplicas);
      const declared = obj.kind === 'Deployment' || obj.kind === 'StatefulSet' ? (num(spec.replicas) ?? 1) : undefined;
      const replicas = hpa ? min : declared;
      if (replicas === 0) this.warnings.add(`${obj.kind} «${obj.name}» tiene replicas: 0: se importa sin réplicas indicadas.`);
      const autoscaling = hpa ? `autoescalado ${min}${max !== undefined ? `–${max}` : ''} réplicas (HPA «${hpa.name}»)` : undefined;
      const schedule = obj.kind === 'CronJob' ? text(spec.schedule) : undefined;

      if (datastore) {
        const res: Resource = {
          id: uniqueId(this.idBase(obj.name, obj.ns), datastore.kind, this.taken),
          name: obj.name,
          kind: datastore.kind,
          environmentId,
          technology: datastore.technology,
          ...(tag ? { version: tag } : {}),
          description: [`${obj.kind} en el namespace ${obj.ns}`, image ? `imagen ${image}` : undefined, replicas && replicas > 1 ? `${replicas} réplicas` : undefined, autoscaling].filter(Boolean).join(' · '),
        };
        this.resources.push(res);
        this.targets.set(this.key(obj.ns, `${obj.kind}/${obj.name}`), { type: 'resource', id: res.id, resource: datastore.kind });
        continue;
      }

      const owner = this.owner(w);
      const sameEnvironment = this.byName.get(`${environmentId}|${obj.name}`);
      const shared = this.byName.get(obj.name);
      let svc: Service;
      if (shared && !sameEnvironment && (shared.kind ?? 'service') === this.serviceKindOf(w, this.selectedBy(w))) {
        // El mismo servicio en otro entorno: un solo servicio con un despliegue por entorno.
        svc = shared;
      } else {
        const clash = this.byName.has(obj.name);
        svc = {
          id: uniqueId(clash ? `${obj.name}-${obj.ns}` : obj.name, obj.kind.toLowerCase(), this.taken),
          name: clash ? `${obj.ns}/${obj.name}` : obj.name,
          kind: this.serviceKindOf(w, this.selectedBy(w)),
          ...(owner ? { owner } : {}),
          description: [obj.kind === 'CronJob' && schedule ? `CronJob (${schedule})` : obj.kind, image ? `imagen ${image}` : undefined, `namespace ${obj.ns}`, autoscaling].filter(Boolean).join(' · '),
          tags: ['kubernetes', `namespace:${obj.ns}`],
        };
        if (svc.kind === 'service') delete svc.kind;
        this.serviceList.push(svc);
        if (!clash) this.byName.set(obj.name, svc);
        this.byName.set(`${environmentId}|${obj.name}`, svc);
      }
      this.targets.set(this.key(obj.ns, `${obj.kind}/${obj.name}`), { type: 'service', id: svc.id });
      const limits = this.limits(w);
      const cluster = this.clusterOf(environmentId);
      this.deployments.push({
        id: pickId(`${svc.id}-${environmentId}`, new Set(this.deployments.map((d) => d.id))),
        serviceId: svc.id,
        environmentId,
        hostId: cluster.id,
        ...(replicas !== undefined && replicas >= 1 ? { replicas } : {}),
        ...(tag && !tag.startsWith('sha256') ? { version: tag } : {}),
        ...(limits.cpu ? { cpuLimit: limits.cpu } : {}),
        ...(limits.memory ? { memoryLimit: limits.memory } : {}),
      });
    }
    if (this.clusters.size > 0) {
      this.warnings.add(`Los manifiestos no declaran el clúster: se crea ${this.clusters.size === 1 ? '«Clúster Kubernetes»' : `un clúster por entorno (${shortList([...this.clusters.values()].map((c) => c.name))})`} para alojar los despliegues.`);
    }
  }

  /** Cargas que implementa un Service de Kubernetes (por su `selector`). */
  private workloadsOf(service: Obj): Workload[] {
    return this.workloads.filter((w) => this.matches(service, w));
  }

  private targetOfWorkload(w: Workload): Target | undefined {
    return this.targets.get(this.key(w.obj.ns, `${w.obj.kind}/${w.obj.name}`));
  }

  /** Elementos a los que apunta un Service de Kubernetes: sus cargas (por selector) o él mismo si es un ExternalName. */
  private resolveService(ns: string, name: string): { targets: Target[]; found: boolean } {
    const service = this.services.get(this.key(ns, name));
    if (!service) return { targets: [], found: false };
    const own = this.targets.get(this.key(ns, `Service/${name}`));
    if (own?.external) return { targets: [own], found: true };
    const targets = this.workloadsOf(service).map((w) => this.targetOfWorkload(w)).filter((t): t is Target => !!t);
    return { targets, found: true };
  }

  private isInternal(annotations: Record<string, string>): boolean {
    return Object.entries(annotations).some(([k, v]) => (/internal/i.test(k) && v.toLowerCase() === 'true') || (/scheme$/i.test(k) && v.toLowerCase() === 'internal') || (/load-balancer-type$/i.test(k) && v.toLowerCase() === 'internal'));
  }

  private createServices(): void {
    for (const service of this.services.values()) {
      const spec = rec(service.raw.spec) ?? {};
      const type = text(spec.type) ?? 'ClusterIP';
      const environmentId = this.environmentOf(service.ns);
      const annotations = strMap(rec(service.raw.metadata)?.annotations);
      if (type === 'ExternalName') {
        const host = text(spec.externalName) ?? '';
        const svc: Service = { id: uniqueId(this.idBase(service.name, service.ns), 'externo', this.taken), name: service.name, external: true, description: `Service ExternalName hacia ${host || '(sin definir)'} · namespace ${service.ns}`, tags: ['kubernetes', `namespace:${service.ns}`] };
        this.serviceList.push(svc);
        this.targets.set(this.key(service.ns, `Service/${service.name}`), { type: 'service', id: svc.id, external: true });
        continue;
      }
      const targets = this.workloadsOf(service);
      if (Object.keys(strMap(spec.selector)).length > 0 && targets.length === 0) {
        this.warnings.add(`El Service «${service.name}» (namespace ${service.ns}) no selecciona ninguna carga de los manifiestos (selector ${Object.entries(strMap(spec.selector)).map(([k, v]) => `${k}=${v}`).join(', ')}): no se pueden resolver las dependencias que apuntan a él.`);
      }
      if (type !== 'LoadBalancer') continue;
      const ports = arr(spec.ports).map(rec).map((p) => num(p?.port)).filter((p): p is number => p !== undefined);
      const internal = this.isInternal(annotations);
      const res: Resource = {
        id: uniqueId(this.idBase(service.name, service.ns), 'lb', this.taken),
        name: service.name,
        kind: 'load-balancer',
        environmentId,
        ...(internal ? {} : { networkId: this.publicNetwork(environmentId).id }),
        technology: 'Kubernetes Service (LoadBalancer)',
        description: [`Service LoadBalancer${internal ? ' interno' : ''}`, `namespace ${service.ns}`, ports.length > 0 ? `puertos ${ports.join(', ')}` : undefined].filter(Boolean).join(' · '),
      };
      this.resources.push(res);
      this.targets.set(this.key(service.ns, `LoadBalancer/${service.name}`), { type: 'resource', id: res.id, resource: 'load-balancer' });
      const protocol = ports.length > 0 ? this.protocolFor(undefined, ports[0]) : undefined;
      for (const w of targets) this.addDependency({ type: 'resource', id: res.id }, this.targetOfWorkload(w), `Selector del Service «${service.name}»`, protocol);
    }
  }

  private createIngresses(): void {
    for (const ingress of this.objects.filter((o) => o.kind === 'Ingress' && ['networking.k8s.io', 'extensions'].includes(o.group))) {
      const spec = rec(ingress.raw.spec) ?? {};
      const annotations = strMap(rec(ingress.raw.metadata)?.annotations);
      const className = text(spec.ingressClassName) ?? annotations['kubernetes.io/ingress.class'];
      const environmentId = this.environmentOf(ingress.ns);
      const hosts = unique(arr(spec.rules).map((r) => text(rec(r)?.host)).filter((h): h is string => !!h));
      const tlsHosts = new Set(arr(spec.tls).flatMap((t) => arr(rec(t)?.hosts)).map(String));
      const tls = arr(spec.tls).length > 0;
      const internal = this.isInternal(annotations);
      const res: Resource = {
        id: uniqueId(this.idBase(ingress.name, ingress.ns), 'ingress', this.taken),
        name: ingress.name,
        kind: 'gateway',
        environmentId,
        ...(internal ? {} : { networkId: this.publicNetwork(environmentId).id }),
        technology: className ? `Ingress ${className}` : 'Kubernetes Ingress',
        description: [`Ingress en el namespace ${ingress.ns}`, hosts.length > 0 ? `hosts ${shortList(hosts, 4)}` : undefined, tls ? 'con TLS' : undefined].filter(Boolean).join(' · '),
      };
      this.resources.push(res);
      this.targets.set(this.key(ingress.ns, `Ingress/${ingress.name}`), { type: 'resource', id: res.id, resource: 'gateway' });
      const source: Target = { type: 'resource', id: res.id, resource: 'gateway' };
      const backends: Array<{ service: string; host?: string; path?: string }> = [];
      const collect = (backend: unknown, host?: string, path?: string): void => {
        const b = rec(backend);
        const name = text(rec(b?.service)?.name) ?? text(b?.serviceName);
        if (name) backends.push({ service: name, host, path });
      };
      collect(spec.defaultBackend ?? spec.backend);
      for (const rule of arr(spec.rules).map(rec)) for (const p of arr(rec(rule?.http)?.paths).map(rec)) collect(p?.backend, text(rule?.host), text(p?.path));
      for (const b of backends) {
        const where = [b.host, b.path].filter(Boolean).join('');
        const secure = b.host ? tlsHosts.has(b.host) || (tls && tlsHosts.size === 0) : tls;
        const { targets, found } = this.resolveService(ingress.ns, b.service);
        if (!found) this.unresolved.push(`el Ingress «${ingress.name}» apunta al Service «${b.service}», que no está en los manifiestos`);
        else if (targets.length === 0) this.warnings.add(`El Ingress «${ingress.name}» apunta al Service «${b.service}», que no selecciona ninguna carga de los manifiestos.`);
        for (const t of targets) this.addDependency(source, t, `Regla del Ingress «${ingress.name}»${where ? `: ${where}` : ''}`, secure ? 'HTTPS' : 'HTTP');
      }
      for (const t of arr(spec.tls).map(rec)) {
        const secret = text(t?.secretName);
        if (secret) this.useSecret(source, ingress.ns, secret, `Certificado TLS del Ingress «${ingress.name}»`);
      }
    }

    for (const gateway of this.objects.filter((o) => o.kind === 'Gateway' && o.group === 'gateway.networking.k8s.io')) {
      const spec = rec(gateway.raw.spec) ?? {};
      const environmentId = this.environmentOf(gateway.ns);
      const listeners = arr(spec.listeners).map(rec);
      const hosts = unique(listeners.map((l) => text(l?.hostname)).filter((h): h is string => !!h));
      const res: Resource = {
        id: uniqueId(this.idBase(gateway.name, gateway.ns), 'gateway', this.taken),
        name: gateway.name,
        kind: 'gateway',
        environmentId,
        networkId: this.publicNetwork(environmentId).id,
        technology: text(spec.gatewayClassName) ? `Gateway API ${text(spec.gatewayClassName)}` : 'Kubernetes Gateway API',
        description: [`Gateway en el namespace ${gateway.ns}`, hosts.length > 0 ? `hosts ${shortList(hosts, 4)}` : undefined, listeners.length > 0 ? `${listeners.length} listener${listeners.length === 1 ? '' : 's'}` : undefined].filter(Boolean).join(' · '),
      };
      this.resources.push(res);
      this.targets.set(this.key(gateway.ns, `Gateway/${gateway.name}`), { type: 'resource', id: res.id, resource: 'gateway' });
    }
  }

  /** HTTPRoute, GRPCRoute…: del Gateway al que se asocian hacia los Services de sus backends. */
  private createRoutes(): void {
    for (const route of this.objects.filter((o) => ROUTES.has(o.kind) && o.group === 'gateway.networking.k8s.io')) {
      const spec = rec(route.raw.spec) ?? {};
      const parents = arr(spec.parentRefs).map(rec).map((p) => this.targets.get(this.key(text(p?.namespace) ?? route.ns, `Gateway/${text(p?.name)}`))).filter((t): t is Target => !!t);
      if (parents.length === 0) {
        this.warnings.add(`${route.kind} «${route.name}» no se asocia a ningún Gateway de los manifiestos: se omite.`);
        continue;
      }
      const hostnames = arr(spec.hostnames).map(String);
      const protocol = route.kind === 'GRPCRoute' ? 'gRPC' : route.kind === 'HTTPRoute' ? 'HTTP' : undefined;
      for (const rule of arr(spec.rules).map(rec)) {
        const paths = unique(arr(rule?.matches).map((m) => text(rec(rec(m)?.path)?.value)).filter((x): x is string => !!x));
        const where = [hostnames.length > 0 ? shortList(hostnames, 3) : undefined, paths.length > 0 ? paths.join(', ') : undefined].filter(Boolean).join(' · ');
        for (const ref of arr(rule?.backendRefs).map(rec)) {
          const name = text(ref?.name);
          if (!name || (text(ref?.kind) ?? 'Service') !== 'Service') continue;
          const ns = text(ref?.namespace) ?? route.ns;
          const { targets, found } = this.resolveService(ns, name);
          if (!found) this.unresolved.push(`${route.kind} «${route.name}» apunta al Service «${name}», que no está en los manifiestos`);
          for (const t of targets) for (const p of parents) this.addDependency(p, t, `${route.kind} «${route.name}»${where ? `: ${where}` : ''}`, protocol);
        }
      }
    }
  }

  private createStorage(): void {
    for (const pvc of this.pvcs.values()) {
      const spec = rec(pvc.raw.spec) ?? {};
      const size = text(rec(rec(spec.resources)?.requests)?.storage);
      const res: Resource = {
        id: uniqueId(this.idBase(pvc.name, pvc.ns), 'pvc', this.taken),
        name: pvc.name,
        kind: 'storage',
        environmentId: this.environmentOf(pvc.ns),
        technology: 'PersistentVolumeClaim',
        description: ['PersistentVolumeClaim', `namespace ${pvc.ns}`, size, text(spec.storageClassName) ? `clase ${text(spec.storageClassName)}` : undefined, arr(spec.accessModes).length > 0 ? arr(spec.accessModes).join(', ') : undefined].filter(Boolean).join(' · '),
      };
      this.resources.push(res);
      this.targets.set(this.key(pvc.ns, `PersistentVolumeClaim/${pvc.name}`), { type: 'resource', id: res.id, resource: 'storage' });
    }
    for (const cm of this.configMaps.values()) {
      const keys = Object.keys(rec(cm.raw.data) ?? {}).length + Object.keys(rec(cm.raw.binaryData) ?? {}).length;
      const res: Resource = {
        id: uniqueId(this.idBase(cm.name, cm.ns), 'configmap', this.taken),
        name: cm.name,
        kind: 'other',
        environmentId: this.environmentOf(cm.ns),
        technology: 'ConfigMap',
        description: `ConfigMap · namespace ${cm.ns} · ${keys} clave${keys === 1 ? '' : 's'}`,
      };
      this.resources.push(res);
      this.targets.set(this.key(cm.ns, `ConfigMap/${cm.name}`), { type: 'resource', id: res.id, resource: 'other' });
    }
    for (const secret of this.secrets.values()) {
      // Solo el tipo y los nombres de las claves: los valores (`data`, `stringData`) no se leen nunca.
      const keys = [...Object.keys(rec(secret.raw.data) ?? {}), ...Object.keys(rec(secret.raw.stringData) ?? {})];
      const res: Resource = {
        id: uniqueId(this.idBase(secret.name, secret.ns), 'secret', this.taken),
        name: secret.name,
        kind: 'secret-store',
        environmentId: this.environmentOf(secret.ns),
        technology: 'Kubernetes Secret',
        description: ['Secret', text(secret.raw.type) ?? 'Opaque', `namespace ${secret.ns}`, keys.length > 0 ? `claves: ${shortList(unique(keys), 6)}` : undefined].filter(Boolean).join(' · '),
      };
      this.resources.push(res);
      this.targets.set(this.key(secret.ns, `Secret/${secret.name}`), { type: 'resource', id: res.id, resource: 'secret-store' });
    }
  }

  // ───────────── dependencias ─────────────

  private dependencyKind(target: Target): DependencyKind {
    if (target.type === 'service') return 'calls';
    if (target.resource === 'queue') return 'messages';
    if (target.resource === 'database' || target.resource === 'cache' || target.resource === 'storage' || target.resource === 'other') return 'data';
    return 'calls';
  }

  private addDependency(source: Target | undefined, target: Target | undefined, description: string, protocol?: string, kind?: DependencyKind): void {
    if (!source || !target || source.id === target.id) return;
    const k = kind ?? this.dependencyKind(target);
    const signature = `${k}|${source.id}|${target.id}`;
    if (this.signatures.has(signature)) return;
    this.signatures.add(signature);
    this.dependencies.push({ id: pickId(`${source.id}--${target.id}`, this.dependencyIds), sourceId: source.id, targetId: target.id, kind: k, ...(protocol ? { protocol } : {}), description });
  }

  private useSecret(source: Target | undefined, ns: string, name: string, description: string): void {
    this.addDependency(source, this.targets.get(this.key(ns, `Secret/${name}`)), description, undefined, 'data');
  }

  private protocolFor(scheme: string | undefined, port: number | undefined): string | undefined {
    if (scheme && SCHEMES[scheme.toLowerCase()]) return SCHEMES[scheme.toLowerCase()];
    if (port !== undefined) return PORTS[port] ?? `TCP/${port}`;
    return scheme?.toUpperCase();
  }

  /** Hosts, puertos y esquemas que menciona un texto: URL completas siempre; `host:puerto` y nombres sueltos solo en una variable que lo sugiere. */
  private scan(value: string, name: string | undefined, whole: boolean): Array<Omit<Found, 'origin'>> {
    const found: Array<Omit<Found, 'origin'>> = [];
    const urls = /([a-z][a-z0-9+.-]*):\/\/(?:[^\s@/:]+(?::[^\s@/]*)?@)?([A-Za-z0-9._-]+)(?::(\d{1,5}))?/gi;
    for (const m of value.matchAll(urls)) if (!LOCAL_HOSTS.test(m[2])) found.push({ host: m[2].toLowerCase(), ...(m[3] ? { port: Number(m[3]) } : {}), scheme: m[1].toLowerCase() });
    if (found.length > 0 || !whole) return found;
    const trimmed = value.trim();
    const hostPort = /^([A-Za-z0-9][A-Za-z0-9._-]*):(\d{1,5})$/.exec(trimmed);
    if (hostPort) return LOCAL_HOSTS.test(hostPort[1]) ? [] : [{ host: hostPort[1].toLowerCase(), port: Number(hostPort[2]) }];
    if (name && looksLikeHostVariable(name) && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)*$/.test(trimmed) && trimmed.length <= 253 && !LOCAL_HOSTS.test(trimmed)) return [{ host: trimmed.toLowerCase() }];
    return [];
  }

  /** Servicio de Kubernetes al que apunta un host: `svc`, `svc.ns`, `svc.ns.svc`, `svc.ns.svc.cluster.local`, `pod-0.svc.ns.svc…`. */
  private resolveHost(host: string, ns: string): { ns: string; name: string } | { internal: boolean } {
    const parts = host.split('.');
    const svcAt = parts.indexOf('svc');
    if (svcAt >= 1) {
      const before = parts.slice(0, svcAt);
      if (before.length >= 2) return { ns: before[before.length - 1], name: before[before.length - 2] };
      return { ns, name: before[0] };
    }
    if (parts.length === 1) return { ns, name: parts[0] };
    if (parts.length === 2 && [...this.services.keys()].some((k) => k === `${parts[1]}/${parts[0]}`)) return { ns: parts[1], name: parts[0] };
    return { internal: false };
  }

  private reference(source: Target | undefined, w: Workload, found: Found): void {
    const resolved = this.resolveHost(found.host, w.obj.ns);
    if (!('name' in resolved)) {
      if (!this.externalHosts.has(found.host)) this.externalHosts.set(found.host, w.obj.name);
      return;
    }
    const { targets, found: exists } = this.resolveService(resolved.ns, resolved.name);
    const own = this.targetOfWorkload(w);
    if (!exists) {
      // Un nombre que no es de ningún Service: solo es un aviso si parece interno (`.svc`) o lo sugiere la variable.
      if (found.host.includes('.svc') || !found.host.includes('.') ) this.unresolved.push(`«${w.obj.name}» apunta a «${found.host}» (${found.origin}), que no es un Service de los manifiestos`);
      else if (!this.externalHosts.has(found.host)) this.externalHosts.set(found.host, w.obj.name);
      return;
    }
    for (const t of targets) {
      if (own && t.id === own.id) continue;
      this.addDependency(source, t, `${found.origin[0].toUpperCase()}${found.origin.slice(1)}`, this.protocolFor(found.scheme, found.port));
    }
  }

  private configMapValues(ns: string, name: string): Array<[string, string]> {
    const cm = this.configMaps.get(this.key(ns, name));
    return Object.entries(rec(cm?.raw.data) ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string');
  }

  private inferDependencies(): void {
    for (const w of this.workloads) {
      const source = this.targetOfWorkload(w);
      if (!source) continue;
      const { ns } = w.obj;
      const useConfigMap = (name: string, why: string): void => this.addDependency(source, this.targets.get(this.key(ns, `ConfigMap/${name}`)), why, undefined, 'data');

      for (const c of [...w.initContainers, ...w.containers]) {
        const cname = text(c.name) ?? 'contenedor';
        for (const e of arr(c.env).map(rec)) {
          const name = text(e?.name);
          if (!name) continue;
          const direct = typeof e?.value === 'string' ? e.value : undefined;
          if (direct !== undefined) for (const f of this.scan(direct, name, true)) this.reference(source, w, { ...f, origin: `variable de entorno ${name}` });
          const from = rec(e?.valueFrom);
          const cm = rec(from?.configMapKeyRef);
          const secret = rec(from?.secretKeyRef);
          if (cm && text(cm.name)) {
            useConfigMap(text(cm.name)!, `Variable de entorno ${name}`);
            const value = this.configMapValues(ns, text(cm.name)!).find(([k]) => k === text(cm.key))?.[1];
            if (value !== undefined) for (const f of this.scan(value, name, true)) this.reference(source, w, { ...f, origin: `variable de entorno ${name}, del ConfigMap «${text(cm.name)}»` });
          }
          if (secret && text(secret.name)) {
            this.useSecret(source, ns, text(secret.name)!, `Variable de entorno ${name}`);
            this.secretRefs.push(`${name} (${w.obj.name})`);
          }
        }
        for (const from of arr(c.envFrom).map(rec)) {
          const cm = text(rec(from?.configMapRef)?.name);
          const secret = text(rec(from?.secretRef)?.name);
          if (cm) {
            useConfigMap(cm, `envFrom del contenedor ${cname}`);
            for (const [k, v] of this.configMapValues(ns, cm)) for (const f of this.scan(v, k, true)) this.reference(source, w, { ...f, origin: `variable ${k} del ConfigMap «${cm}»` });
          }
          if (secret) {
            this.useSecret(source, ns, secret, `envFrom del contenedor ${cname}`);
            this.secretRefs.push(`envFrom ${secret} (${w.obj.name})`);
          }
        }
        for (const arg of [...arr(c.args), ...arr(c.command)]) if (typeof arg === 'string') for (const f of this.scan(arg, undefined, false)) this.reference(source, w, { ...f, origin: `argumento del contenedor ${cname}` });
      }
      for (const v of w.volumes) {
        const claim = text(rec(v.persistentVolumeClaim)?.claimName);
        const cm = text(rec(v.configMap)?.name);
        const secret = text(rec(v.secret)?.secretName);
        if (claim) this.addDependency(source, this.targets.get(this.key(ns, `PersistentVolumeClaim/${claim}`)), `Volumen ${text(v.name) ?? claim}`, undefined, 'data');
        if (cm) {
          useConfigMap(cm, `Volumen ${text(v.name) ?? cm}`);
          for (const [k, content] of this.configMapValues(ns, cm)) for (const f of this.scan(content, undefined, false)) this.reference(source, w, { ...f, origin: `archivo ${k} del ConfigMap «${cm}»` });
        }
        if (secret) this.useSecret(source, ns, secret, `Volumen ${text(v.name) ?? secret}`);
      }
    }
  }

  // ───────────── avisos ─────────────

  private reportWarnings(): void {
    const n = (count: number, one: string, many: string): string => (count === 1 ? one : many.replace('{n}', String(count)));
    if (this.unmapped.length > 0) this.warnings.add(`${n(this.unmapped.length, '1 objeto de un kind sin mapear, que no se importa', '{n} objetos de kinds sin mapear, que no se importan')}: ${countedList(this.unmapped)}.`);
    if (this.support.length > 0) this.warnings.add(`${n(this.support.length, '1 objeto de soporte que no se dibuja', '{n} objetos de soporte que no se dibujan')} (permisos, políticas de red, clases…): ${countedList(this.support)}.`);
    if (this.unresolved.length > 0) this.warnings.add(`No se pudo resolver ${n(unique(this.unresolved).length, '1 referencia', '{n} referencias')}: ${shortList(unique(this.unresolved), 6)}.`);
    if (this.secretRefs.length > 0) {
      this.warnings.add(`${n(this.secretRefs.length, '1 valor viene de un Secret', '{n} valores vienen de un Secret')} y no se lee (los Secrets nunca se abren): si apuntan a otro servicio, esa dependencia no se infiere (${shortList(unique(this.secretRefs), 6)}).`);
    }
    if (this.externalHosts.size > 0) {
      this.warnings.add(`${n(this.externalHosts.size, '1 host externo', '{n} hosts externos')} mencionado en variables de entorno o argumentos, que no se importa como dependencia: ${shortList([...this.externalHosts].map(([h, from]) => `${h} (${from})`), 6)}.`);
    }
  }
}

/**
 * Chart de Helm que generó los manifiestos (la salida de `helm template`): el de la etiqueta `helm.sh/chart` (`tienda-0.4.2` →
 * `tienda`) o, si no la hay, el del comentario `# Source: tienda/templates/…` que Helm escribe antes de cada manifiesto.
 */
function helmChartOf(objects: Obj[], source: string): string | undefined {
  for (const o of objects) {
    const label = strMap(rec(o.raw.metadata)?.labels)['helm.sh/chart'];
    if (label) return /^(.+?)-v?\d+(?:\.\d+){0,2}(?:[-+].*)?$/.exec(label)?.[1] ?? label;
  }
  return /^# Source: ([^/\s]+)\//m.exec(source)?.[1];
}

/** Importa manifiestos de Kubernetes (YAML o JSON, multi-documento) como documento de plataforma. */
export function fromKubernetes(source: string, options: InfraImportOptions = {}): PlatformImportResult {
  const warnings = new Warnings();
  const objects = readObjects(source, warnings);
  if (objects.length === 0) {
    const why = warnings.result().slice(0, 3).join(' ');
    throw new PlatformImportError(`El archivo no contiene ningún objeto de Kubernetes (se esperaba YAML con apiVersion y kind).${why ? ` ${why}` : ''}${helmHint(source)}`);
  }
  // La salida de `helm template` por la entrada estándar no tiene nombre de archivo: la nombra el chart.
  const chart = options.chart ?? (descriptiveName(options) ? undefined : helmChartOf(objects, source));
  return new KubernetesBuilder(objects, chart ? { ...options, chart } : options, warnings).build();
}
