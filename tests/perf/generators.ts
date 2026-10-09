/**
 * Generadores deterministas de diagramas grandes, uno por módulo, para medir el rendimiento (`npm run perf`) y para
 * las pruebas estructurales del lienzo con muchos nodos.
 *
 * Cada generador recibe el número de nodos que debe tener la vista que se dibuja (`size`) y una semilla, y devuelve un
 * documento válido del módulo con relaciones y, donde el módulo lo permite, anidado (un sistema con sus APIs, una base de
 * datos con sus tablas, una red con sus subredes…). Mismos argumentos, mismo documento: no usan `Math.random` ni la fecha.
 *
 * `size` es un objetivo, no una garantía exacta: la vista añade zonas o contenedores derivados del documento (los dominios de
 * integración, por ejemplo), así que la prueba de los generadores comprueba que el número real de nodos proyectados queda
 * cerca (`tests/perf/generators.test.ts`) y el script de medición anota el número real que dibujó.
 */

export const PERF_MODULES = ['c4', 'integration', 'data', 'enterprise', 'platform', 'security'] as const;
export type PerfModuleId = (typeof PERF_MODULES)[number];

/** Tamaños con los que se mide por omisión. */
export const PERF_SIZES = [100, 500, 1000, 2000] as const;

export interface PerfDocument {
  moduleId: PerfModuleId;
  /** Vista que dibuja el lienzo y que mide el script (la primera con relaciones de cada módulo). */
  viewId?: string;
  document: unknown;
}

/** Generador pseudoaleatorio mulberry32: pequeño, rápido y con la misma secuencia para la misma semilla. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Elemento al azar de una lista (que no puede estar vacía). */
const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)];

/** Relaciones por elemento: cada uno apunta a `1 + (0 o 1)` anteriores, así que el grafo es conexo y tiene ciclos escasos. */
const fanOut = (random: () => number): number => 1 + (random() < 0.5 ? 1 : 0);

const NAME = (prefix: string, i: number): string => `${prefix} ${String(i).padStart(4, '0')}`;

function integration(size: number, seed: number): PerfDocument {
  const random = seeded(seed);
  const nodes: Array<Record<string, unknown>> = [];
  const interactions: Array<Record<string, unknown>> = [];
  const callable: string[] = [];
  const domains = Math.max(2, Math.round(size / 40));
  // Cada «unidad» añade entre 2 y 4 nodos: un sistema con su API, un broker con sus tópicos, un almacén…
  for (let i = 0; nodes.length < size; i++) {
    const domain = `Dominio ${(i % domains) + 1}`;
    const slot = i % 6;
    if (slot < 3) {
      const id = `sis-${i}`;
      nodes.push({ id, kind: 'system', name: NAME('Sistema', i), technology: 'Java', owner: `Equipo ${i % 9}`, domain });
      nodes.push({ id: `api-${i}`, kind: 'api', name: NAME('API', i), parentId: id });
      callable.push(`api-${i}`);
    } else if (slot === 3) {
      nodes.push({ id: `brk-${i}`, kind: 'broker', name: NAME('Broker', i), technology: 'Kafka', domain });
      for (const t of [0, 1]) {
        nodes.push({ id: `top-${i}-${t}`, kind: 'topic', name: NAME(`Tópico ${t}`, i), parentId: `brk-${i}` });
        callable.push(`top-${i}-${t}`);
      }
    } else if (slot === 4) {
      nodes.push({ id: `db-${i}`, kind: 'store', name: NAME('Almacén', i), technology: 'PostgreSQL', domain });
      callable.push(`db-${i}`);
    } else {
      nodes.push({ id: `con-${i}`, kind: 'connector', name: NAME('Conector', i), technology: 'Camel', domain });
      callable.push(`con-${i}`);
    }
  }
  const styles = ['request-response', 'async-message', 'event', 'batch', 'stream'] as const;
  callable.forEach((source, i) => {
    if (i === 0) return;
    for (let k = 0; k < fanOut(random); k++) {
      const target = callable[Math.floor(random() * i)];
      if (target === source) continue;
      interactions.push({ id: `i-${interactions.length}`, sourceId: source, targetId: target, style: pick(random, styles), protocol: k === 0 ? 'HTTPS' : undefined, description: k === 0 ? 'consulta' : undefined });
    }
  });
  return {
    moduleId: 'integration',
    viewId: 'map',
    document: { version: '1.0', workspace: { name: `Integración de ${size} nodos` }, nodes, contracts: [], interactions, flows: [] },
  };
}

function data(size: number, seed: number): PerfDocument {
  const random = seeded(seed);
  const domains = Math.max(2, Math.round(size / 60));
  const domainList = Array.from({ length: domains }, (_, d) => ({ id: `dom-${d}`, name: `Dominio ${d + 1}`, owner: `Equipo ${d}` }));
  const assets: Array<Record<string, unknown>> = [];
  const pipelines: Array<Record<string, unknown>> = [];
  let nodeCount = 0;
  const tables: string[] = [];
  // Cada unidad: una base de datos con tres tablas, un pipeline y una tabla de salida en el almacén (el pipeline también es un nodo): 6 nodos.
  for (let i = 0; nodeCount < size; i++) {
    const domainId = `dom-${i % domains}`;
    const db = `db-${i}`;
    assets.push({ id: db, kind: 'database', name: NAME('Base', i), technology: 'PostgreSQL', engine: 'postgresql', domainId, owner: `Equipo ${i % 9}` });
    const inputs: string[] = [];
    for (let t = 0; t < 3; t++) {
      const id = `${db}-t${t}`;
      assets.push({ id, kind: 'table', name: NAME(`tabla ${t}`, i), parentId: db, columns: [{ name: 'id', type: 'bigint', keys: ['pk'] }, { name: 'valor', type: 'text' }] });
      inputs.push(id);
    }
    const out = `wh-${i}`;
    assets.push({ id: out, kind: 'table', name: NAME('hecho', i), domainId, columns: [{ name: 'id', type: 'bigint', keys: ['pk'] }] });
    const previous = tables.length > 0 && random() < 0.7 ? [pick(random, tables)] : [];
    pipelines.push({ id: `pl-${i}`, name: NAME('Carga', i), kind: 'batch', inputs: [...inputs, ...previous], outputs: [out], tool: 'Airflow', schedule: 'diaria' });
    tables.push(out);
    nodeCount += 6;
  }
  return {
    moduleId: 'data',
    viewId: 'lineage',
    document: { version: '1.0', workspace: { name: `Datos de ${size} nodos` }, domains: domainList, assets, pipelines, relations: [] },
  };
}

function enterprise(size: number, seed: number): PerfDocument {
  const random = seeded(seed);
  const units: Array<Record<string, unknown>> = [];
  const applications: Array<Record<string, unknown>> = [];
  const technologies: Array<Record<string, unknown>> = [];
  const processes: Array<Record<string, unknown>> = [];
  const capabilities: Array<Record<string, unknown>> = [];
  const relations: Array<Record<string, unknown>> = [];
  const add = (kind: string, sourceId: string, targetId: string): void => {
    relations.push({ id: `r-${relations.length}`, kind, sourceId, targetId });
  };
  const unitCount = Math.max(2, Math.round(size / 50));
  for (let u = 0; u < unitCount; u++) units.push({ id: `u-${u}`, name: NAME('Unidad', u) });
  // Cada paso añade una capacidad, un proceso, dos aplicaciones y una tecnología (5 nodos del paisaje, más las capacidades del mapa).
  for (let i = 0; applications.length + technologies.length + processes.length + capabilities.length < size; i++) {
    const owner = `u-${i % unitCount}`;
    capabilities.push({ id: `cap-${i}`, name: NAME('Capacidad', i), ownerId: owner, importance: 'core', maturity: 1 + (i % 5) });
    processes.push({ id: `proc-${i}`, name: NAME('Proceso', i), ownerId: owner });
    for (const a of [0, 1]) applications.push({ id: `app-${i}-${a}`, name: NAME(`Aplicación ${a}`, i), ownerId: owner, lifecycle: 'active', criticality: 'medium' });
    technologies.push({ id: `tec-${i}`, name: NAME('Tecnología', i), kind: 'platform', ownerId: owner });
    add('realizes', `proc-${i}`, `cap-${i}`);
    add('supports', `app-${i}-0`, `cap-${i}`);
    add('supports', `app-${i}-1`, `proc-${i}`);
    add('runs-on', `app-${i}-0`, `tec-${i}`);
    if (i > 0) {
      add('depends-on', `app-${i}-0`, `app-${Math.floor(random() * i)}-1`);
      add('flows-to', `app-${i}-1`, `app-${Math.floor(random() * i)}-0`);
    }
  }
  return {
    moduleId: 'enterprise',
    viewId: 'landscape',
    document: {
      version: '1.0',
      workspace: { name: `Empresa de ${size} nodos` },
      units,
      capabilities,
      processes,
      applications,
      technologies,
      valueStreams: [],
      valueStages: [],
      businessServices: [],
      relations,
    },
  };
}

function platform(size: number, seed: number): PerfDocument {
  const random = seeded(seed);
  const services: Array<Record<string, unknown>> = [];
  const resources: Array<Record<string, unknown>> = [];
  const networks: Array<Record<string, unknown>> = [];
  const deployments: Array<Record<string, unknown>> = [];
  const dependencies: Array<Record<string, unknown>> = [];
  const hosts: string[] = [];
  const declared = new Set<string>();
  const clusterCount = Math.max(2, Math.round(size / 80));
  networks.push({ id: 'vpc', name: 'VPC', environmentId: 'prod', exposure: 'private', cidr: '10.0.0.0/16' });
  for (let c = 0; c < clusterCount; c++) {
    networks.push({ id: `net-${c}`, name: NAME('Subred', c), environmentId: 'prod', parentId: 'vpc', exposure: 'private', cidr: `10.0.${c % 250}.0/24` });
    resources.push({ id: `k8s-${c}`, name: NAME('Clúster', c), kind: 'cluster', environmentId: 'prod', networkId: `net-${c}`, technology: 'Kubernetes' });
    hosts.push(`k8s-${c}`);
  }
  // Cada servicio con su despliegue en un clúster; cada cuatro, una base de datos en la red de su clúster.
  const target = Math.round(size / 1.28);
  for (let i = 0; services.length < target; i++) {
    const id = `svc-${i}`;
    services.push({ id, name: NAME('Servicio', i), kind: 'service', technology: 'Java', owner: `Equipo ${i % 9}`, criticality: 'medium' });
    deployments.push({ id: `dep-${i}`, serviceId: id, environmentId: 'prod', hostId: hosts[i % hosts.length], replicas: 2 });
    if (i % 4 === 0) {
      resources.push({ id: `db-${i}`, name: NAME('Base', i), kind: 'database', environmentId: 'prod', networkId: `net-${i % clusterCount}`, technology: 'PostgreSQL' });
    }
    if (i > 0) {
      for (let k = 0; k < fanOut(random); k++) {
        const target = random() < 0.2 && i >= 4 ? `db-${Math.floor(random() * (i / 4)) * 4}` : `svc-${Math.floor(random() * i)}`;
        // El esquema rechaza dos dependencias iguales (mismo tipo, origen y destino).
        if (target === id || declared.has(`${id}>${target}`)) continue;
        declared.add(`${id}>${target}`);
        dependencies.push({ id: `dp-${dependencies.length}`, sourceId: id, targetId: target, kind: target.startsWith('db-') ? 'data' : 'calls', protocol: 'HTTPS' });
      }
    }
  }
  return {
    moduleId: 'platform',
    viewId: 'env:prod',
    document: {
      version: '1.0',
      workspace: { name: `Plataforma de ${size} nodos` },
      environments: [{ id: 'prod', name: 'Producción', kind: 'prod', provider: 'AWS', region: 'eu-west-1' }],
      networks,
      resources,
      services,
      deployments,
      dependencies,
      pipelines: [],
    },
  };
}

function security(size: number, seed: number): PerfDocument {
  const random = seeded(seed);
  const zones: Array<Record<string, unknown>> = [{ id: 'internet', name: 'Internet', trust: 'untrusted' }, { id: 'interna', name: 'Red interna', trust: 'internal' }];
  const assets: Array<Record<string, unknown>> = [];
  const flows: Array<Record<string, unknown>> = [];
  const zoneCount = Math.max(2, Math.round(size / 40));
  for (let z = 0; z < zoneCount; z++) zones.push({ id: `z-${z}`, name: NAME('Zona', z), trust: z % 3 === 0 ? 'restricted' : 'internal', parentId: 'interna' });
  const kinds = ['process', 'process', 'process', 'datastore', 'external'] as const;
  for (let i = 0; assets.length < size; i++) {
    const kind = kinds[i % kinds.length];
    assets.push({ id: `a-${i}`, name: NAME(kind === 'datastore' ? 'Almacén' : kind === 'external' ? 'Externo' : 'Proceso', i), kind, zoneId: kind === 'external' ? 'internet' : `z-${i % zoneCount}`, classification: 'internal' });
    if (i > 0) {
      for (let k = 0; k < fanOut(random); k++) {
        const target = Math.floor(random() * i);
        flows.push({ id: `f-${flows.length}`, sourceId: `a-${i}`, targetId: `a-${target}`, protocol: 'HTTPS', description: k === 0 ? 'datos' : undefined, encrypted: true });
      }
    }
  }
  return {
    moduleId: 'security',
    viewId: 'dfd',
    document: { version: '1.0', workspace: { name: `Seguridad de ${size} nodos` }, zones, assets, flows, threats: [], controls: [] },
  };
}

function c4(size: number, seed: number): PerfDocument {
  const random = seeded(seed);
  const elements: Array<Record<string, unknown>> = [
    { id: 'cliente', type: 'person', name: 'Cliente' },
    { id: 'sistema', type: 'softwareSystem', name: 'Sistema', description: 'El sistema que se describe' },
    { id: 'externo', type: 'softwareSystem', name: 'Sistema externo', external: true },
  ];
  const relationships: Array<Record<string, unknown>> = [];
  const containers: string[] = [];
  // La vista de contenedores dibuja el sistema como un límite con todos sus contenedores dentro (un nivel de anidado).
  for (let i = 0; containers.length < size - 3; i++) {
    const id = `c-${i}`;
    elements.push({ id, type: 'container', name: NAME('Contenedor', i), technology: 'Java', description: 'Servicio de la plataforma', parentId: 'sistema' });
    containers.push(id);
    if (i === 0) relationships.push({ id: 'r-cliente', sourceId: 'cliente', targetId: id, description: 'Usa' });
    else {
      for (let k = 0; k < fanOut(random); k++) {
        const target = containers[Math.floor(random() * i)];
        relationships.push({ id: `r-${relationships.length}`, sourceId: id, targetId: target, description: k === 0 ? 'Llama a' : undefined, technology: k === 0 ? 'HTTPS' : undefined });
      }
    }
  }
  relationships.push({ id: 'r-externo', sourceId: containers[containers.length - 1], targetId: 'externo', description: 'Envía datos' });
  return {
    moduleId: 'c4',
    viewId: 'contenedores',
    document: {
      version: '1.0',
      workspace: { name: `C4 de ${size} nodos` },
      model: { elements, relationships },
      views: [
        {
          id: 'contenedores',
          type: 'container',
          scopeId: 'sistema',
          title: 'Contenedores',
          elements: [{ id: 'cliente' }, { id: 'externo' }, ...containers.map((id) => ({ id }))],
          layout: { direction: 'DOWN' },
        },
      ],
    },
  };
}

const GENERATORS: Record<PerfModuleId, (size: number, seed: number) => PerfDocument> = { c4, integration, data, enterprise, platform, security };

/** Documento válido de `moduleId` cuya vista `viewId` dibuja unos `size` nodos. Determinista: mismos argumentos, mismo documento. */
export function generateDocument(moduleId: PerfModuleId, size: number, seed = 1): PerfDocument {
  return GENERATORS[moduleId](size, seed);
}
