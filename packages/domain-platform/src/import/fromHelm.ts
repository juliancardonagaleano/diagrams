/**
 * Importador de charts de Helm para el módulo de plataforma. Hay DOS formas de llegar a Helm y cubren cosas distintas:
 *
 *   1. Esta: el chart sin renderizar, `Chart.yaml` + `values.yaml` (y `requirements.yaml` de los charts de la versión 1). Se
 *      puede dar la carpeta del chart (`iark import mi-chart/ --module platform`), los archivos sueltos o solo `Chart.yaml`.
 *      Cubre lo que esos archivos DECLARAN: el chart como servicio, los subcharts (`dependencies`) y lo que `values.yaml` dice
 *      de ellos. NO interpreta las plantillas (`templates/*.yaml`, que son Go templates): lo que el chart genera y no declara en
 *      `values.yaml` (Services, ConfigMaps, jobs, variables de entorno…) no aparece, y el importador lo avisa siempre.
 *   2. La salida de `helm template`, que ya es Kubernetes y se importa con el importador de Kubernetes:
 *      `helm template mi-release ./mi-chart -f values-prod.yaml | iark import --module platform`. Es la forma completa: ve
 *      lo que el chart genera de verdad con los valores que se le den (también en producción). Nunca se ejecuta Helm ni se
 *      interpretan plantillas aquí.
 *
 * Correspondencia de esta forma:
 *
 *   chart                                                → UN entorno (nombre: `environment`/`env` de los valores, la carpeta
 *                                                          o el nombre del chart, con aviso) + el clúster Kubernetes implícito
 *   el propio chart (no `type: library`)                 → servicio + despliegue en el clúster: imagen de `image` (versión =
 *                                                          etiqueta o `appVersion`), réplicas de `replicaCount`/`autoscaling`,
 *                                                          límites de `resources.limits`; responsable = primer `maintainers`
 *   `dependencies` (subcharts) que son un almacén        → recurso `database`, `cache`, `queue` o `storage` (postgresql, redis,
 *   conocido (postgresql, redis, mysql, kafka…)            rabbitmq, mongodb, kafka, minio…), con la etiqueta de su imagen si
 *                                                          `values.yaml` la da, y una dependencia del chart hacia él
 *   los demás subcharts                                  → servicio + despliegue + dependencia `calls`
 *   `condition: x.enabled` en `false`, o `common`        → no se importa (se avisa): el subchart está desactivado o es una
 *                                                          biblioteca
 *   `ingress.enabled: true`                              → recurso `gateway` en la red pública «Entrada pública» + dependencia
 *   `service.type: LoadBalancer`                         → recurso `load-balancer` en la red pública + dependencia
 *   `persistence.enabled: true`                          → recurso `storage` + dependencia `data`
 *
 * Nunca se descarga un subchart (`repository`, `file://`, `oci://`: ni red ni disco) ni se copia ningún valor que no sea el
 * nombre de una imagen, una etiqueta, un número de réplicas, un límite o el nombre de un host: contraseñas y claves de
 * `values.yaml` no salen de él. Las claves de `values.yaml` que no se interpretan se listan en los avisos.
 */
import { pickId, Warnings, withoutBom } from '@iark/kernel';
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
  type Service,
} from '../types';
import { descriptiveName, environmentKindOf, shortList, uniqueId, type InfraImportOptions } from './common';
import { PlatformImportError, type PlatformImportResult } from './fromMermaid';
import { cpuMillis, DATASTORES, formatCpu, formatMemory, imageParts, memoryBytes } from './fromKubernetes';
import { arr, readStructured, rec, scalarText, type Json } from './yamlText';

/** Un archivo del chart: su nombre (o ruta) y su texto. */
export interface HelmFile {
  name: string;
  text: string;
}

/** ¿Parece un `Chart.yaml`? `apiVersion` v1 o v2, `name` y `version`, y sin `kind` (que lo haría un manifiesto de Kubernetes). */
export function looksLikeHelmChart(source: string): boolean {
  const t = withoutBom(source);
  if (/^\s*[{[]/.test(t)) return false;
  return /^apiVersion[ \t]*:[ \t]*["']?v[12]["']?[ \t]*(?:#.*)?$/m.test(t) && /^name[ \t]*:[ \t]*\S+/m.test(t) && /^version[ \t]*:[ \t]*\S+/m.test(t) && !/^kind[ \t]*:/m.test(t);
}

const baseOf = (name: string): string => (name.split(/[\\/]+/).filter(Boolean).pop() ?? name).toLowerCase();
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
/** Valor en una ruta con puntos (`postgresql.enabled`), solo por claves propias. */
function dig(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const key of path.split('.')) {
    const r = rec(current);
    if (!r || !Object.hasOwn(r, key)) return undefined;
    current = r[key];
  }
  return current;
}
const own = (r: Json, key: string): unknown => (Object.hasOwn(r, key) ? r[key] : undefined);
const isChartLike = (v: unknown): v is Json => {
  const r = rec(v);
  return !!r && typeof r.name === 'string' && (typeof r.version === 'string' || typeof r.version === 'number' || typeof r.apiVersion === 'string');
};

/** Imagen de una sección de valores: `image: nginx:1.25` o `image: { registry, repository, tag }`. */
function imageOf(value: unknown): { text?: string; tag?: string } {
  if (typeof value === 'string' && value.trim() !== '' && !value.includes('{{')) return { text: value.trim(), tag: imageParts(value.trim()).tag };
  const r = rec(value);
  if (!r) return {};
  const repository = scalarText(r.repository) ?? scalarText(r.name);
  const tag = scalarText(r.tag);
  const clean = tag && !tag.includes('{{') ? tag : undefined;
  // Un subchart de Bitnami solo suele cambiar la etiqueta (`image: { tag: "15.4.0" }`): sin repositorio hay etiqueta pero no imagen.
  if (!repository || repository.includes('{{')) return clean ? { tag: clean } : {};
  const registry = scalarText(r.registry);
  return { text: `${registry && !registry.includes('{{') ? `${registry}/` : ''}${repository}${clean ? `:${clean}` : ''}`, ...(clean ? { tag: clean } : {}) };
}

/** Nombre de almacén conocido de un subchart (`postgresql-ha` → `postgresql`). */
function datastoreOf(name: string): (typeof DATASTORES)[string] | undefined {
  const key = name.toLowerCase().replace(/-(?:ha|cluster|sharded|operator)$/, '');
  return Object.hasOwn(DATASTORES, key) ? DATASTORES[key] : undefined;
}

class HelmBuilder {
  private readonly warnings = new Warnings();
  private readonly taken = new Set<string>();
  private readonly resources: Resource[] = [];
  private readonly services: Service[] = [];
  private readonly deployments: Deployment[] = [];
  private readonly dependencies: Dependency[] = [];
  private readonly networks: Network[] = [];
  private environmentId = '';
  private cluster: Resource | undefined;
  private publicNet: Network | undefined;
  private readonly interpreted = new Set(['image', 'replicaCount', 'replicas', 'resources', 'autoscaling', 'ingress', 'service', 'persistence', 'environment', 'env', 'stage', 'global']);

  constructor(
    private readonly chart: Json,
    private readonly deps: Json[],
    private readonly values: Json,
    private readonly notes: { overlays: string[]; ignored: string[] },
    private readonly options: InfraImportOptions,
  ) {}

  private ensureCluster(): Resource {
    if (this.cluster) return this.cluster;
    this.cluster = {
      id: uniqueId('kubernetes', 'cluster', this.taken),
      name: 'Clúster Kubernetes',
      kind: 'cluster',
      environmentId: this.environmentId,
      technology: 'Kubernetes',
      description: 'Clúster implícito: el chart no dice en cuál se despliega.',
    };
    this.resources.push(this.cluster);
    this.warnings.add('El chart no declara el clúster: se crea «Clúster Kubernetes» para alojar los despliegues.');
    return this.cluster;
  }

  private ensurePublicNetwork(): Network {
    if (this.publicNet) return this.publicNet;
    this.publicNet = { id: uniqueId('entrada-publica', 'red', this.taken), name: 'Entrada pública', environmentId: this.environmentId, exposure: 'public', description: 'Red que agrupa lo que el chart expone a Internet (Ingress y Services LoadBalancer).' };
    this.networks.push(this.publicNet);
    return this.publicNet;
  }

  private deploy(service: Service, section: Json, image: { tag?: string }, appVersion?: string): void {
    const host = this.ensureCluster();
    const autoscaling = rec(section.autoscaling);
    const autoscaled = autoscaling?.enabled === true;
    const replicas = autoscaled ? (num(autoscaling.minReplicas) ?? 1) : (num(section.replicaCount) ?? num(section.replicas));
    const limits = rec(rec(section.resources)?.limits);
    const cpu = cpuMillis(limits?.cpu);
    const memory = memoryBytes(limits?.memory);
    const version = image.tag ?? appVersion;
    if (replicas === 0) this.warnings.add(`El servicio «${service.name}» tiene 0 réplicas en values.yaml: se importa sin réplicas indicadas.`);
    this.deployments.push({
      id: pickId(`${service.id}-${this.environmentId}`, new Set(this.deployments.map((d) => d.id))),
      serviceId: service.id,
      environmentId: this.environmentId,
      hostId: host.id,
      ...(replicas !== undefined && Number.isInteger(replicas) && replicas >= 1 ? { replicas } : {}),
      ...(version ? { version } : {}),
      ...(cpu !== undefined ? { cpuLimit: formatCpu(cpu) } : {}),
      ...(memory !== undefined ? { memoryLimit: formatMemory(memory) } : {}),
    });
  }

  private depend(sourceId: string, target: { resourceKind?: string; id: string }, description: string, protocol?: string): void {
    const kind: DependencyKind = target.resourceKind === 'queue' ? 'messages' : target.resourceKind && ['database', 'cache', 'storage'].includes(target.resourceKind) ? 'data' : 'calls';
    this.dependencies.push({ id: pickId(`${sourceId}--${target.id}`, new Set(this.dependencies.map((d) => d.id))), sourceId, targetId: target.id, kind, ...(protocol ? { protocol } : {}), description });
  }

  /** ¿Está activado el subchart? Manda la primera ruta de `condition` que exista en los valores y sea un booleano. */
  private enabled(dep: Json): boolean {
    const condition = scalarText(dep.condition);
    if (!condition) return true;
    for (const path of condition.split(',').map((p) => p.trim()).filter(Boolean)) {
      this.interpreted.add(path.split('.')[0]);
      const v = dig(this.values, path);
      if (typeof v === 'boolean') return v;
    }
    return true;
  }

  build(): PlatformImportResult {
    const { chart, values } = this;
    const chartName = scalarText(chart.name)!;
    const chartVersion = scalarText(chart.version);
    const appVersion = scalarText(chart.appVersion);
    const isLibrary = chart.type === 'library';

    // Lo primero que debe saber quien lee los avisos: las plantillas no se interpretan.
    this.warnings.add(
      'Helm (Chart.yaml + values.yaml): las plantillas (templates/, Go templates) no se interpretan, así que no aparece lo que el chart genera sin declararlo en values.yaml (Services, ConfigMaps, jobs, variables de entorno…). Para verlo, renderice el chart y use el importador de Kubernetes: helm template mi-release ./mi-chart | iark import --module platform.',
    );

    // Entorno
    const global = rec(values.global);
    const fromValues = [values.environment, values.env, values.stage, global?.environment, global?.env].map(scalarText).find(Boolean);
    const origin = descriptiveName(this.options);
    const envName = fromValues ?? origin ?? chartName;
    const reason = fromValues ? 'de los valores (environment/env)' : origin ? 'del nombre de la carpeta o del archivo' : 'del nombre del chart';
    if (!fromValues) this.warnings.add(`Un chart de Helm no dice en qué entorno se despliega: se crea el entorno «${envName}» a partir ${reason}.`);
    this.environmentId = uniqueId(envName, 'entorno', this.taken);
    const kind = environmentKindOf(envName);
    const environment: Environment = { id: this.environmentId, name: envName, description: `Entorno deducido ${reason}.`, ...(kind ? { kind } : {}), provider: 'kubernetes' };

    // El propio chart
    let main: Service | undefined;
    if (isLibrary) {
      this.warnings.add(`El chart «${chartName}» es de tipo library: no se despliega, así que no se importa como servicio.`);
    } else {
      const image = imageOf(values.image);
      const autoscaling = rec(values.autoscaling);
      const maintainer = arr(chart.maintainers).map((m) => (typeof m === 'string' ? m : scalarText(rec(m)?.name))).find(Boolean);
      const source = arr(chart.sources).find((s): s is string => typeof s === 'string' && /^https?:\/\//.test(s));
      const min = autoscaling?.enabled === true ? (num(autoscaling.minReplicas) ?? 1) : undefined;
      const max = autoscaling?.enabled === true ? num(autoscaling.maxReplicas) : undefined;
      main = {
        id: uniqueId(chartName, 'servicio', this.taken),
        name: chartName,
        ...(maintainer ? { owner: maintainer } : {}),
        ...(source ? { repo: source } : {}),
        description: [scalarText(chart.description), `Chart de Helm ${chartName}${chartVersion ? ` ${chartVersion}` : ''}${appVersion ? ` (appVersion ${appVersion})` : ''}`, image.text ? `imagen ${image.text}` : undefined, min !== undefined ? `autoescalado ${min}${max !== undefined ? `–${max}` : ''} réplicas` : undefined]
          .filter(Boolean)
          .join(' · '),
        tags: ['helm', `chart:${chartName}${chartVersion ? `-${chartVersion}` : ''}`],
      };
      this.services.push(main);
      this.deploy(main, values, image, appVersion);
      this.exposure(main);
    }

    // Subcharts
    const disabled: string[] = [];
    const libraries: string[] = [];
    const malformed: number[] = [];
    const repositories = new Set<string>();
    const names = new Set<string>();
    for (const dep of this.deps) {
      const name = scalarText(dep.name);
      if (!name) {
        malformed.push(1);
        continue;
      }
      const alias = scalarText(dep.alias) ?? name;
      if (names.has(alias)) continue;
      names.add(alias);
      this.interpreted.add(alias);
      const version = scalarText(dep.version);
      const repository = scalarText(dep.repository);
      if (repository) repositories.add(repository);
      if (!this.enabled(dep)) {
        disabled.push(`${alias} (${scalarText(dep.condition)})`);
        continue;
      }
      if (name === 'common' || name === 'library') {
        libraries.push(name);
        continue;
      }
      const section = rec(own(values, alias)) ?? {};
      const image = imageOf(section.image);
      const label = `Subchart de Helm «${name}»${alias !== name ? ` (alias «${alias}»)` : ''}${version ? ` ${version}` : ''}`;
      const datastore = datastoreOf(name);
      const architecture = scalarText(section.architecture);
      const note = `${label}${repository ? ` · repositorio ${repository}` : ''}`;
      if (datastore) {
        const res: Resource = {
          id: uniqueId(alias, datastore.kind, this.taken),
          name: alias,
          kind: datastore.kind,
          environmentId: this.environmentId,
          technology: datastore.technology,
          ...(image.tag ? { version: image.tag } : {}),
          description: [note, image.text ? `imagen ${image.text}` : undefined, architecture ? `arquitectura ${architecture}` : undefined].filter(Boolean).join(' · '),
        };
        this.resources.push(res);
        if (main) this.depend(main.id, { resourceKind: datastore.kind, id: res.id }, label);
      } else {
        const svc: Service = { id: uniqueId(alias, 'servicio', this.taken), name: alias, description: [note, image.text ? `imagen ${image.text}` : undefined].filter(Boolean).join(' · '), tags: ['helm', `subchart:${name}`] };
        this.services.push(svc);
        this.deploy(svc, section, image);
        if (main) this.depend(main.id, { id: svc.id }, label);
      }
    }

    if (disabled.length > 0) this.warnings.add(`${disabled.length} subchart(s) desactivado(s) por su «condition» en values.yaml, que no se importan: ${shortList(disabled)}.`);
    if (libraries.length > 0) this.warnings.add(`${libraries.length} subchart(s) de biblioteca (${shortList(libraries)}): no despliegan nada y no se importan.`);
    if (malformed.length > 0) this.warnings.add(`${malformed.length} entrada(s) de «dependencies» sin nombre, que no se importan.`);
    if (repositories.size > 0) this.warnings.add(`Los subcharts vienen de ${repositories.size} repositorio(s) (${shortList([...repositories], 3)}): no se descargan ni se leen (no hay red ni disco), así que solo se usan su nombre, su versión y lo que values.yaml dice de ellos.`);
    if (this.notes.overlays.length > 0) this.warnings.add(`${this.notes.overlays.length} archivo(s) de valores adicionales (${shortList(this.notes.overlays)}) no se aplican: solo se lee values.yaml.`);
    if (this.notes.ignored.length > 0) this.warnings.add(`${this.notes.ignored.length} archivo(s) que no son parte del chart y no se importan: ${shortList(this.notes.ignored)}.`);
    const extra = Object.keys(values).filter((k) => !this.interpreted.has(k));
    if (extra.length > 0) this.warnings.add(`${extra.length} clave(s) de values.yaml sin interpretar (solo se leen image, replicaCount, resources, autoscaling, ingress, service.type, persistence y las secciones de los subcharts): ${shortList(extra, 10)}.`);

    const result = validatePlatformDocument({
      version: PLATFORM_DOCUMENT_VERSION,
      workspace: { name: this.options.name?.trim() || chartName, ...(scalarText(chart.description) ? { description: scalarText(chart.description)!.replace(/\s+/g, ' ') } : {}) },
      environments: [environment],
      networks: this.networks,
      resources: this.resources,
      services: this.services,
      deployments: this.deployments,
      dependencies: this.dependencies,
      pipelines: [],
    });
    if (!result.ok) throw new PlatformImportError(`No se pudo construir un documento válido a partir del chart de Helm:\n${formatPlatformIssues(result.issues)}`);
    return { document: result.document as PlatformDocument, warnings: this.warnings.result() };
  }

  /** Lo que el chart expone o guarda según sus valores: Ingress, Service LoadBalancer y volúmenes persistentes. */
  private exposure(main: Service): void {
    const { values } = this;
    const ingress = rec(values.ingress);
    if (ingress?.enabled === true) {
      const hosts = [...arr(ingress.hosts).map((h) => (typeof h === 'string' ? h : scalarText(rec(h)?.host))), scalarText(ingress.hostname), scalarText(ingress.host)].filter((h): h is string => !!h && !h.includes('{{'));
      const className = scalarText(ingress.className) ?? scalarText(ingress.ingressClassName);
      const tls = ingress.tls === true || (Array.isArray(ingress.tls) && ingress.tls.length > 0);
      const gateway: Resource = {
        id: uniqueId(`${main.name}-ingress`, 'gateway', this.taken),
        name: `${main.name} (ingress)`,
        kind: 'gateway',
        environmentId: this.environmentId,
        networkId: this.ensurePublicNetwork().id,
        technology: `Kubernetes Ingress${className ? ` (${className})` : ''}`,
        description: ['Ingress activado en values.yaml', hosts.length > 0 ? `hosts ${shortList([...new Set(hosts)], 4)}` : undefined, tls ? 'con TLS' : undefined].filter(Boolean).join(' · '),
      };
      this.resources.push(gateway);
      this.depend(gateway.id, { id: main.id }, 'ingress.enabled en values.yaml', tls ? 'HTTPS' : 'HTTP');
    }
    if (scalarText(rec(values.service)?.type) === 'LoadBalancer') {
      const balancer: Resource = {
        id: uniqueId(`${main.name}-lb`, 'load-balancer', this.taken),
        name: `${main.name} (LoadBalancer)`,
        kind: 'load-balancer',
        environmentId: this.environmentId,
        networkId: this.ensurePublicNetwork().id,
        technology: 'Kubernetes Service LoadBalancer',
        description: 'service.type: LoadBalancer en values.yaml',
      };
      this.resources.push(balancer);
      this.depend(balancer.id, { id: main.id }, 'service.type: LoadBalancer en values.yaml');
    }
    const persistence = rec(values.persistence);
    if (persistence?.enabled === true) {
      const size = scalarText(persistence.size);
      const volume: Resource = {
        id: uniqueId(`${main.name}-volumen`, 'storage', this.taken),
        name: `${main.name} (volumen)`,
        kind: 'storage',
        environmentId: this.environmentId,
        technology: 'Kubernetes PersistentVolumeClaim',
        description: ['persistence.enabled en values.yaml', size && !size.includes('{{') ? `tamaño ${size}` : undefined].filter(Boolean).join(' · '),
      };
      this.resources.push(volume);
      this.depend(main.id, { resourceKind: 'storage', id: volume.id }, 'persistence.enabled en values.yaml');
    }
  }
}

const MAX_FILES = 200;

/**
 * Importa un chart de Helm sin renderizar: `Chart.yaml` (obligatorio), `values.yaml` y `requirements.yaml` si los hay. `files` son
 * los archivos del chart (una carpeta o varios archivos sueltos); con un solo archivo basta `Chart.yaml`.
 */
export function fromHelm(files: HelmFile[], options: InfraImportOptions = {}): PlatformImportResult {
  if (files.length === 0) throw new PlatformImportError('No hay ningún archivo de Helm que importar.');
  if (files.length > MAX_FILES) throw new PlatformImportError(`Hay ${files.length} archivos: un chart de Helm se importa con su Chart.yaml y su values.yaml, no con más de ${MAX_FILES} archivos.`);
  const label = (f: HelmFile): string => `El archivo «${f.name || 'Chart.yaml'}»`;
  let chart: Json | undefined;
  let chartFile: HelmFile | undefined;
  let requirements: Json[] = [];
  let values: Json | undefined;
  const overlays: string[] = [];
  const ignored: string[] = [];
  for (const file of files) {
    const base = baseOf(file.name);
    if (/^values[-._].+\.ya?ml$/.test(base)) {
      overlays.push(file.name);
      continue;
    }
    const role = /^chart\.ya?ml$/.test(base) ? 'chart' : /^requirements\.ya?ml$/.test(base) ? 'requirements' : /^values\.ya?ml$/.test(base) ? 'values' : undefined;
    let parsed: unknown;
    try {
      parsed = readStructured(file.text, label(file));
    } catch (error) {
      // Un archivo suelto de la carpeta que no es YAML (una plantilla con llaves de Go, por ejemplo) no tumba el chart: se avisa.
      if (role === undefined && files.length > 1 && error instanceof PlatformImportError) {
        ignored.push(file.name);
        continue;
      }
      if (error instanceof PlatformImportError && /varios documentos YAML/.test(error.message)) {
        throw new PlatformImportError(`${label(file)} tiene varios documentos YAML (separados por «---»): parece la salida de helm template, que ya es Kubernetes y se importa con el importador de Kubernetes: helm template … | iark import --module platform.`);
      }
      throw error;
    }
    if (role === 'values') {
      if (parsed !== null && !rec(parsed)) throw new PlatformImportError(`${label(file)} no es un mapa de valores.`);
      values = rec(parsed) ?? {};
    } else if (role === 'requirements' || (role === undefined && !isChartLike(parsed) && Array.isArray(rec(parsed)?.dependencies))) {
      requirements = arr(rec(parsed)?.dependencies).map(rec).filter((d): d is Json => !!d);
    } else if (isChartLike(parsed)) {
      if (chart) throw new PlatformImportError(`Hay más de un Chart.yaml (${chartFile!.name} y ${file.name}): se importa un chart cada vez.`);
      chart = parsed;
      chartFile = file;
    } else if (role === 'chart' || files.length === 1) {
      throw new PlatformImportError(
        role === 'chart'
          ? `${label(file)} no es un Chart.yaml válido: le falta «name» (y «version»).`
          : `${label(file)} no es un Chart.yaml (sin «name» y «version»). Para manifiestos de Kubernetes ya renderizados use el importador de Kubernetes: helm template … | iark import --module platform.`,
      );
    } else ignored.push(file.name);
  }
  if (!chart) {
    throw new PlatformImportError(
      `No se encontró un Chart.yaml entre los archivos (${files.map((f) => f.name).join(', ')}): Helm se importa desde la carpeta del chart (Chart.yaml + values.yaml). Para manifiestos de Kubernetes repartidos en varios archivos, júntelos en uno o use helm template … | iark import --module platform.`,
    );
  }
  const deps = [...arr(chart.dependencies).map(rec), ...requirements].filter((d): d is Json => !!d);
  return new HelmBuilder(chart, deps, values ?? {}, { overlays, ignored }, options).build();
}
