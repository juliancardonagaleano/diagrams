import { readFileSync } from 'node:fs';
import { buildManifest, carryRefs, ModuleError, ModuleRegistry } from '@iark/kernel';
import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { generatedToPlatform, platformAiSpec, toGenerated } from './ai/generation';
import { platformCommands } from './commands';
import { toDrawio } from './export/drawio';
import { toMermaid } from './export/mermaid';
import { layoutView, toSvg } from './export/render';
import { callCycles, dependencyGraph, deploymentEnvironments, reach, scopeEnvironment } from './graph';
import { fromIntegrationJson } from './import/fromIntegration';
import { fromMermaid, PlatformImportError } from './import/fromMermaid';
import { analyzePlatform } from './issues';
import { platformModule } from './module';
import { formatPlatformIssues, validatePlatformDocument } from './schema';
import { indexElements, type PlatformDocument } from './types';
import { findView, listViews } from './views';

const example = JSON.parse(readFileSync('examples/plataforma-ejemplo.json', 'utf8')) as unknown;
const parse = (input: unknown): PlatformDocument => {
  const r = validatePlatformDocument(input);
  if (!r.ok) throw new Error(formatPlatformIssues(r.issues));
  return r.document;
};
const doc = parse(example);
const messages = (d: PlatformDocument): string[] => analyzePlatform(d).map((i) => i.message);
/** Copia del ejemplo con cambios: `edit` recibe un JSON mutable. */
const changed = (edit: (json: Record<string, Array<Record<string, unknown>>>) => void): PlatformDocument => {
  const json = JSON.parse(JSON.stringify(example)) as Record<string, Array<Record<string, unknown>>>;
  edit(json);
  return parse(json);
};

describe('esquema de plataforma', () => {
  it('acepta el ejemplo y aplica valores por defecto', () => {
    expect(doc.environments).toHaveLength(2);
    expect(doc.resources).toHaveLength(7);
    expect(doc.deployments).toHaveLength(10);
    expect(parse({}).workspace.name).toBe('Arquitectura de plataforma');
    expect(parse({}).deployments).toEqual([]);
    expect(parse({ pipelines: [{ id: 'p', name: 'P', kind: 'ci' }] }).pipelines[0]).toMatchObject({ serviceIds: [], stages: [] });
  });

  it('rechaza ids repetidos entre tipos, redes mal anidadas, recursos en redes de otro entorno y URN inválidas', () => {
    const r = validatePlatformDocument({
      environments: [{ id: 'dev', name: 'Dev' }, { id: 'prod', name: 'Prod' }],
      networks: [
        { id: 'a', name: 'A', environmentId: 'dev', parentId: 'b' },
        { id: 'b', name: 'B', environmentId: 'dev', parentId: 'a' },
        { id: 'c', name: 'C', environmentId: 'dev', parentId: 'c' },
        { id: 'd', name: 'D', environmentId: 'prod', parentId: 'a' },
        { id: 'e', name: 'E', environmentId: 'nada' },
        { id: 'f', name: 'F', environmentId: 'dev', parentId: 'dev' },
        { id: 'g', name: 'G', environmentId: 'dev', parentId: 'fantasma' },
      ],
      resources: [
        { id: 'r1', name: 'R1', kind: 'database', environmentId: 'prod', networkId: 'a', ref: 'no-es-urn' },
        { id: 'r2', name: 'R2', kind: 'cluster', environmentId: 'dev', networkId: 'fantasma' },
      ],
      services: [{ id: 'dev', name: 'Repite el id de un entorno' }],
    });
    expect(r.ok).toBe(false);
    const text = r.ok ? '' : formatPlatformIssues(r.issues);
    for (const fragment of [
      'Id duplicado: "dev" (ya lo usa entorno)',
      'La jerarquía de redes de "a" es circular',
      '"c" no puede ser su propio padre',
      'La red "d" y su padre "a" están en entornos distintos',
      '"e" referencia un entorno inexistente: "nada"',
      'El padre de "f" debe ser una red, pero "dev" es entorno',
      '"g" referencia un padre inexistente',
      'El recurso "r1" y su red "a" están en entornos distintos',
      '"r2" referencia una red inexistente',
      'La referencia de "r1" no es una URN válida',
    ]) {
      expect(text).toContain(fragment);
    }
  });

  it('un servicio solo se despliega en un clúster o una máquina de su mismo entorno', () => {
    const base = {
      environments: [{ id: 'dev', name: 'Dev' }, { id: 'prod', name: 'Prod' }],
      resources: [
        { id: 'k8s', name: 'k8s', kind: 'cluster', environmentId: 'dev' },
        { id: 'db', name: 'db', kind: 'database', environmentId: 'dev' },
      ],
      services: [{ id: 'api', name: 'API' }, { id: 'saas', name: 'SaaS', external: true }],
    };
    const bad = validatePlatformDocument({
      ...base,
      deployments: [
        { id: 'd1', serviceId: 'api', environmentId: 'prod', hostId: 'k8s' },
        { id: 'd2', serviceId: 'api', environmentId: 'dev', hostId: 'db' },
        { id: 'd3', serviceId: 'saas', environmentId: 'dev', hostId: 'k8s' },
        { id: 'd4', serviceId: 'k8s', environmentId: 'dev', hostId: 'k8s' },
        { id: 'd5', serviceId: 'api', environmentId: 'dev', hostId: 'fantasma' },
        { id: 'd6', serviceId: 'api', environmentId: 'dev', hostId: 'k8s' },
        { id: 'd7', serviceId: 'api', environmentId: 'dev', hostId: 'k8s' },
        { id: 'd7', serviceId: 'api', environmentId: 'dev', hostId: 'k8s' },
        { id: 'd8', serviceId: 'api', environmentId: 'nada', hostId: 'k8s' },
      ],
    });
    expect(bad.ok).toBe(false);
    const text = bad.ok ? '' : formatPlatformIssues(bad.issues);
    for (const fragment of [
      'es del entorno "prod" pero su anfitrión "k8s" está en "dev"',
      'es base de datos: un servicio solo se despliega en un clúster o una máquina virtual',
      'El servicio "saas" es externo (de un tercero): no se despliega en la plataforma',
      'debe ser de un servicio, pero "k8s" es recurso',
      'referencia un anfitrión inexistente: "fantasma"',
      'repite otro igual',
      'Id de despliegue duplicado: "d7"',
      '"d8" referencia un entorno inexistente: "nada"',
    ]) {
      expect(text).toContain(fragment);
    }
    const replicas = validatePlatformDocument({
      ...base,
      deployments: [
        { id: 'a', serviceId: 'api', environmentId: 'dev', hostId: 'k8s', replicas: 1.5 },
        { id: 'b', serviceId: 'api', environmentId: 'dev', hostId: 'k8s', replicas: 0 },
      ],
    });
    const replicaText = replicas.ok ? '' : formatPlatformIssues(replicas.issues);
    expect(replicaText).toContain('deployments.0.replicas: Las réplicas deben ser un número entero');
    expect(replicaText).toContain('deployments.1.replicas: Debe haber al menos una réplica');
  });

  it('valida los extremos de las dependencias y las referencias de los pipelines', () => {
    const r = validatePlatformDocument({
      environments: [{ id: 'dev', name: 'Dev' }],
      resources: [{ id: 'db', name: 'db', kind: 'database', environmentId: 'dev' }],
      services: [{ id: 'api', name: 'API' }, { id: 'saas', name: 'SaaS', external: true }],
      dependencies: [
        { id: 'x1', sourceId: 'api', targetId: 'api', kind: 'calls' },
        { id: 'x2', sourceId: 'api', targetId: 'dev', kind: 'calls' },
        { id: 'x3', sourceId: 'fantasma', targetId: 'db', kind: 'data' },
        { id: 'x4', sourceId: 'api', targetId: 'db', kind: 'data' },
        { id: 'x5', sourceId: 'api', targetId: 'db', kind: 'data' },
        { id: 'x4', sourceId: 'api', targetId: 'db', kind: 'calls' },
      ],
      pipelines: [
        { id: 'ci', name: 'CI', kind: 'ci', serviceIds: ['fantasma', 'saas'], provisions: ['db', 'nada'], stages: [{ environmentId: 'dev' }, { environmentId: 'dev' }, { environmentId: 'nada' }] },
      ],
    });
    expect(r.ok).toBe(false);
    const text = r.ok ? '' : formatPlatformIssues(r.issues);
    for (const fragment of [
      'no puede unir un elemento consigo mismo',
      'Una dependencia une servicios o recursos, pero "dev" es entorno',
      'referencia un elemento inexistente: "fantasma"',
      'repite otra igual (data "api" → "db")',
      'Id de dependencia duplicado: "x4"',
      'El pipeline "ci" referencia un servicio inexistente: "fantasma"',
      'El servicio "saas" es externo: ningún pipeline lo construye ni lo despliega',
      'referencia un recurso inexistente: "nada"',
      'Solo un pipeline de infraestructura como código (iac) aprovisiona recursos; "ci" es ci',
      'pasa dos veces por el entorno "dev"',
      'referencia un entorno inexistente: "nada"',
    ]) {
      expect(text).toContain(fragment);
    }
  });
});

describe('grafo', () => {
  it('reach recorre lo que depende de un elemento, de lo que depende o ambos, con el camino seguido', () => {
    const graph = dependencyGraph(doc, 'prod');
    expect(reach(graph, 'kafka-prod', 'dependents').map((s) => `${s.id}<${s.via}@${s.depth}`)).toEqual([
      'pedidos<kafka-prod@1',
      'facturacion<kafka-prod@1',
      'notificaciones<kafka-prod@1',
      'tienda-web<pedidos@2',
      'lb-prod<tienda-web@3',
    ]);
    expect(reach(graph, 'pedidos', 'dependencies').map((s) => s.id)).toEqual(['pedidos-db-prod', 'kafka-prod', 'k8s-prod']);
    expect(reach(graph, 'pedidos', 'both').map((s) => s.id).sort()).toEqual(['k8s-prod', 'kafka-prod', 'lb-prod', 'pedidos-db-prod', 'tienda-web']);
  });

  it('acotado a un entorno solo entra lo que hay en él; sin acotar se mezclan todos', () => {
    const dev = dependencyGraph(doc, 'dev');
    expect(reach(dev, 'pedidos', 'dependencies').map((s) => s.id)).toEqual(['pedidos-db-dev', 'kafka-dev', 'k8s-dev']);
    expect(dev.leanedBy.has('lb-prod')).toBe(false);
    const all = dependencyGraph(doc);
    expect(reach(all, 'pedidos', 'dependencies').map((s) => s.id).sort()).toEqual(['k8s-dev', 'k8s-prod', 'kafka-dev', 'kafka-prod', 'pedidos-db-dev', 'pedidos-db-prod']);
  });

  it('un servicio externo está presente en todos los entornos', () => {
    expect(reach(dependencyGraph(doc, 'dev'), 'facturacion', 'dependencies').map((s) => s.id)).toContain('pasarela-pagos');
  });

  it('el entorno de un elemento: el de un recurso, o el único donde corre un servicio', () => {
    const elements = indexElements(doc);
    expect(scopeEnvironment(doc, elements.get('k8s-prod')!)).toBe('prod');
    expect(scopeEnvironment(doc, elements.get('pedidos')!)).toBeUndefined();
    const soloProd = changed((j) => (j.deployments = j.deployments.filter((d) => d.environmentId === 'prod')));
    expect(scopeEnvironment(soloProd, indexElements(soloProd).get('pedidos')!)).toBe('prod');
    expect(deploymentEnvironments(doc, 'pedidos')).toEqual(['dev', 'prod']);
  });

  it('detecta ciclos de llamadas síncronas entre servicios', () => {
    const cyclic = parse({
      services: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
      dependencies: [
        { id: '1', sourceId: 'a', targetId: 'b', kind: 'calls' },
        { id: '2', sourceId: 'b', targetId: 'c', kind: 'calls' },
        { id: '3', sourceId: 'c', targetId: 'a', kind: 'calls' },
        { id: '4', sourceId: 'a', targetId: 'c', kind: 'messages' },
      ],
    });
    expect(callCycles(cyclic)).toEqual([['a', 'b', 'c']]);
    expect(callCycles(doc)).toEqual([]);
  });
});

describe('reglas de gobierno', () => {
  it('el ejemplo no tiene avisos ni notas', () => {
    expect(analyzePlatform(doc)).toEqual([]);
  });

  it('avisa de servicios sin despliegue o sin responsable, y de producción sin pasar por un entorno anterior', () => {
    const text = messages(
      changed((j) => {
        j.deployments = j.deployments.filter((d) => d.serviceId !== 'reportes' && !(d.serviceId === 'notificaciones' && d.environmentId === 'dev'));
        delete j.services[0].owner;
        delete j.services[4].owner;
        j.environments.push({ id: 'vacio', name: 'Vacío' });
        j.services.push({ id: 'nuevo', name: 'Nuevo', criticality: 'critical', owner: 'Equipo X' });
      }),
    );
    expect(text).toContain('Job «Reportes nocturnos» no se despliega en ningún entorno.');
    expect(text).toContain('Servicio «Nuevo» no se despliega en ningún entorno.');
    expect(text).toContain('Frontend «Tienda web» no tiene responsable.');
    expect(text).toContain('Job «Reportes nocturnos» no tiene responsable.');
    expect(text).toContain('Worker «Notificaciones» se despliega en «Producción» sin estar en ningún entorno anterior (Desarrollo).');
    expect(text).toContain('Entorno «Vacío» no tiene recursos ni despliegues.');
    expect(text).toContain('Servicio «Nuevo» no lo construye ni lo despliega ningún pipeline.');
    // la gravedad depende de la criticidad
    const issues = analyzePlatform(changed((j) => j.services.push({ id: 'n1', name: 'N1', criticality: 'critical', owner: 'x' }, { id: 'n2', name: 'N2', criticality: 'low', owner: 'x' })));
    expect(issues.find((i) => i.elementId === 'n1' && i.message.includes('no se despliega'))?.severity).toBe('warning');
    expect(issues.find((i) => i.elementId === 'n2' && i.message.includes('no se despliega'))?.severity).toBe('info');
  });

  it('avisa de despliegues y dependencias sobre recursos previstos o dados de baja', () => {
    const text = messages(
      changed((j) => {
        j.resources.find((r) => r.id === 'k8s-dev')!.status = 'decommissioned';
        j.resources.find((r) => r.id === 'kafka-prod')!.status = 'planned';
      }),
    );
    expect(text).toContain('Frontend «Tienda web» se despliega en clúster «k8s-dev», que está dado de baja.');
    expect(text).toContain('Servicio «Servicio de pedidos» depende de cola o broker «Kafka (prod)», que está previsto.');
    expect(text).toContain('Servicio «Facturación» depende de cola o broker «Kafka (prod)», que está previsto.');
    // un recurso previsto que nadie usa ya no se avisa como «sin uso»
    expect(text.some((m) => m.includes('Kafka (prod)') && m.includes('no lo usa'))).toBe(false);
  });

  it('avisa de dependencias de servicios que no corren en el mismo entorno y de recursos de otro entorno', () => {
    const missing = analyzePlatform(changed((j) => (j.deployments = j.deployments.filter((d) => d.id !== 'pedidos-prod'))));
    expect(missing.find((i) => i.message.includes('no se despliega en «Producción», donde sí corre'))).toMatchObject({
      severity: 'warning',
      elementId: 'tienda-web',
      message: 'Frontend «Tienda web» depende de servicio «Servicio de pedidos», que no se despliega en «Producción», donde sí corre.',
    });
    const lowerEnv = analyzePlatform(changed((j) => (j.deployments = j.deployments.filter((d) => d.id !== 'pedidos-dev'))));
    expect(lowerEnv.find((i) => i.message.includes('«Desarrollo», donde sí corre'))?.severity).toBe('info');

    const crossed = messages(changed((j) => (j.deployments = j.deployments.filter((d) => !(d.serviceId === 'reportes' && d.environmentId === 'dev')))));
    expect(crossed).toContain('Job «Reportes nocturnos» depende de base de datos «Base de pedidos (dev)», que está en «Desarrollo», y no corre allí.');
  });

  it('avisa de los tipos de recurso que un servicio usa en un entorno y no en otro', () => {
    const issues = analyzePlatform(changed((j) => (j.dependencies = j.dependencies.filter((d) => d.id !== 'pedidos-db-p' && d.id !== 'fact-kafka-p'))));
    const parity = issues.filter((i) => i.message.includes('pero allí no usa'));
    expect(parity.map((i) => i.message)).toEqual([
      'Servicio «Servicio de pedidos» se despliega en «Producción» pero allí no usa ningún recurso de tipo base de datos (en «Desarrollo» usa «Base de pedidos (dev)»).',
      'Servicio «Facturación» se despliega en «Producción» pero allí no usa ningún recurso de tipo cola o broker (en «Desarrollo» usa «Kafka (dev)»).',
    ]);
    expect(parity.every((i) => i.severity === 'warning')).toBe(true); // producción
    const dev = analyzePlatform(changed((j) => (j.dependencies = j.dependencies.filter((d) => d.id !== 'pedidos-db-d'))));
    expect(dev.find((i) => i.message.includes('«Desarrollo» pero allí no usa'))?.severity).toBe('info');
  });

  it('avisa de datos en redes públicas, producción sin infraestructura como código y puntos únicos de fallo', () => {
    const text = messages(
      changed((j) => {
        j.resources.find((r) => r.id === 'pedidos-db-prod')!.networkId = 'subred-publica';
        j.resources.find((r) => r.id === 'k8s-prod')!.iac = false;
        j.deployments.find((d) => d.id === 'pedidos-prod')!.replicas = 1;
        j.deployments.find((d) => d.id === 'reportes-prod')!.replicas = 1; // criticidad baja: no se avisa
      }),
    );
    expect(text).toContain('Base de datos «Base de pedidos» está en la red pública «Subred pública»: los datos y los secretos deberían estar en una red privada.');
    expect(text).toContain('Clúster «k8s-prod» está en producción y no se gestiona como código (infraestructura como código).');
    expect(text).toContain('Servicio «Servicio de pedidos» corre en «Producción» con una sola réplica: es un punto único de fallo.');
    expect(text.filter((m) => m.includes('una sola réplica'))).toHaveLength(1);
  });

  it('avisa de anfitriones vacíos y de recursos de datos que nadie usa', () => {
    const text = messages(
      changed((j) => {
        j.resources.push({ id: 'k8s-vacio', name: 'k8s-vacío', kind: 'cluster', environmentId: 'dev' }, { id: 'cache', name: 'Caché', kind: 'cache', environmentId: 'dev' });
      }),
    );
    expect(text).toContain('Clúster «k8s-vacío» no aloja ningún servicio.');
    expect(text).toContain('Caché «Caché» no lo usa ningún servicio.');
  });

  it('avisa de pipelines vacíos, sin aprobación en producción o que se saltan entornos', () => {
    const text = messages(
      changed((j) => {
        j.pipelines.push(
          { id: 'vacio', name: 'Vacío', kind: 'ci', serviceIds: [], stages: [] },
          { id: 'directo', name: 'Directo', kind: 'cd', serviceIds: ['pedidos'], stages: [{ environmentId: 'prod' }] },
        );
        j.pipelines[0].stages = [{ environmentId: 'dev' }, { environmentId: 'prod' }];
        j.deployments = j.deployments.filter((d) => d.id !== 'reportes-prod');
      }),
    );
    expect(text).toContain('Pipeline «Vacío» no construye, despliega ni aprovisiona nada.');
    expect(text).toContain('Pipeline «Entrega de servicios» promociona a «Producción» sin una aprobación manual.');
    expect(text).toContain('Pipeline «Directo» despliega en producción sin pasar antes por otro entorno.');
    expect(text).toContain('Pipeline «Entrega de servicios» promociona job «Reportes nocturnos» a «Producción», pero el servicio no tiene despliegue allí.');
  });

  it('avisa de llamadas circulares', () => {
    const text = messages(changed((j) => j.dependencies.push({ id: 'ciclo', sourceId: 'pedidos', targetId: 'tienda-web', kind: 'calls' })));
    expect(text).toContain('Llamadas síncronas circulares entre servicios: «Tienda web» → «Servicio de pedidos» → «Tienda web».');
  });

  it('un documento sin pipelines no avisa de servicios sin pipeline', () => {
    const text = messages(changed((j) => (j.pipelines = [])));
    expect(text.some((m) => m.includes('ningún pipeline'))).toBe(false);
  });
});

describe('vistas', () => {
  it('lista la topología, una vista por entorno con contenido y la entrega continua', () => {
    expect(listViews(doc).map((v) => v.id)).toEqual(['topology', 'env:dev', 'env:prod', 'delivery', 'compare:dev:prod', 'costs']);
    const empty = parse({ environments: [{ id: 'e', name: 'E' }], services: [{ id: 's', name: 'S' }] });
    expect(listViews(empty)).toEqual([]);
    expect(() => findView(empty)).toThrow('El documento no tiene vistas que exportar');
  });

  it('la topología dibuja todos los servicios y los recursos que usan; el entorno, solo lo suyo', () => {
    const topology = findView(doc, 'topology');
    expect(topology.elementIds).toHaveLength(11);
    expect(topology.dependencyIds).toHaveLength(13);
    const prod = findView(doc, 'env:prod');
    expect(prod.elementIds).toEqual(['tienda-web', 'pedidos', 'facturacion', 'notificaciones', 'reportes', 'pasarela-pagos', 'lb-prod', 'k8s-prod', 'kafka-prod', 'pedidos-db-prod']);
    expect(prod.deploymentIds).toHaveLength(5);
    expect(prod.dependencyIds).toHaveLength(8);
    expect(prod.dependencyIds).not.toContain('pedidos-db-d');
    expect(findView(doc, 'env:dev').elementIds).not.toContain('lb-prod');
    expect(findView(doc, 'delivery').pipelineIds).toEqual(['entrega-servicios', 'infraestructura']);
  });

  it('impacto, dependencias y entorno de un elemento, por prefijo o por su id, acotados a su entorno', () => {
    const impact = findView(doc, 'impact:kafka-prod');
    expect(impact).toMatchObject({ type: 'impact', environmentId: 'prod', focusId: 'kafka-prod', title: 'Impacto de «Kafka (prod)» (Producción)' });
    expect(impact.elementIds).toEqual(['tienda-web', 'pedidos', 'facturacion', 'notificaciones', 'lb-prod', 'kafka-prod']);
    const depends = findView(doc, 'depends:pedidos');
    expect(depends.type).toBe('depends');
    expect(depends.environmentId).toBeUndefined(); // corre en dos entornos
    expect(depends.elementIds).toContain('pedidos-db-dev');
    expect(depends.elementIds).toContain('pedidos-db-prod');
    expect(depends.deploymentIds).toEqual(['pedidos-dev', 'pedidos-prod']);
    expect(findView(doc, 'k8s-dev')).toMatchObject({ id: 'focus:k8s-dev', type: 'focus', environmentId: 'dev' });
    expect(findView(doc, 'dev').id).toBe('env:dev');
  });

  it('explica las vistas disponibles cuando no existe la pedida', () => {
    expect(() => findView(doc, 'nada')).toThrow(/No existe la vista «nada»\. Vistas disponibles: topology, env:dev, env:prod, delivery, compare:dev:prod, costs, impact:<elemento>/);
    expect(() => findView(doc, 'impact:entrega-servicios')).toThrow(/No existe el servicio ni el recurso/);
  });
});

describe('exportación a Mermaid', () => {
  it('la vista de un entorno anida entorno, redes y clúster, con las instancias dentro de su anfitrión', () => {
    const text = toMermaid(doc, { viewId: 'env:prod' });
    expect(text.startsWith('flowchart LR\n')).toBe(true);
    const order = ['subgraph env_prod["Entorno: Producción"]', 'subgraph vpc_prod["Red privada: VPC producción (10.10.0.0/16)"]', 'subgraph subred_apps["Red privada: Subred de aplicaciones (10.10.1.0/24)"]', 'subgraph k8s_prod["Clúster: k8s-prod"]'];
    order.forEach((line, i) => {
      expect(text).toContain(line);
      if (i > 0) expect(text.indexOf(line)).toBeGreaterThan(text.indexOf(order[i - 1]));
    });
    expect(text).toContain('pedidos["Servicio de pedidos<br/>Java, Spring Boot<br/>3 réplicas · v3.0.2"]:::service');
    expect(text).toContain('pedidos_db_prod[("Base de pedidos<br/>PostgreSQL · 15")]:::database');
    expect(text).toContain('kafka_prod(["Kafka (prod)<br/>Kafka"]):::queue');
    expect(text).toContain('pasarela_pagos["Pasarela de pagos"]:::external');
    // el servicio externo va fuera del entorno
    expect(text.indexOf('pasarela_pagos[')).toBeGreaterThan(text.lastIndexOf('    end\n'));
    expect(text).toContain('pedidos ==>|"JDBC"| pedidos_db_prod');
    expect(text).toContain('facturacion -.->|"Kafka · Consume PedidoCreado"| kafka_prod');
    expect(text).toContain('tienda_web -->|"REST · Crea el pedido"| pedidos');
    expect(text).toContain('classDef database fill:#d9480f');
  });

  it('la topología y las vistas de impacto son un grafo plano; el estado del recurso va en su clase', () => {
    const topology = toMermaid(doc, { viewId: 'topology' });
    expect(topology).not.toContain('subgraph');
    expect(topology).toContain('pedidos_db_dev[("Base de pedidos (dev)<br/>PostgreSQL · 15<br/>entorno Desarrollo")]:::database');
    const withStatus = changed((j) => (j.resources.find((r) => r.id === 'kafka-dev')!.status = 'planned'));
    const text = toMermaid(withStatus, { viewId: 'env:dev' });
    expect(text).toContain('classDef planned stroke-dasharray:5 5');
    expect(text).toContain('class kafka_dev planned');
    expect(text).not.toContain('previsto');
    const impact = toMermaid(doc, { viewId: 'impact:k8s-prod' });
    expect(impact).toContain('reportes -.-> k8s_prod');
    expect(impact).toContain('notificaciones -.-> k8s_prod');
    expect(impact).toContain('lb_prod -->|"HTTPS · Reparte el tráfico"| tienda_web');
  });

  it('la entrega continua tiene un subgraph por pipeline', () => {
    const text = toMermaid(doc, { viewId: 'delivery' });
    expect(text).toContain('subgraph entrega_servicios["CI/CD: Entrega de servicios (GitLab CI)"]');
    expect(text).toContain('subgraph infraestructura["Infraestructura como código: Infraestructura (Terraform)"]');
    expect(text).toContain('p_entrega_servicios_s1["Producción<br/>aprobación manual<br/>4 con versión distinta de Desarrollo"]:::step');
    expect(text).toContain('tienda_web --> p_entrega_servicios_build');
    expect(text).toContain('p_infraestructura_s1 --> k8s_prod');
  });

  it('evita las palabras reservadas y los ids con caracteres raros', () => {
    const odd = parse({
      environments: [{ id: 'e', name: 'E' }],
      resources: [{ id: 'end', name: 'Fin', kind: 'database', environmentId: 'e' }],
      services: [{ id: '1-api', name: 'API "uno"' }, { id: 'graph', name: 'Graph' }],
      dependencies: [{ id: 'd', sourceId: '1-api', targetId: 'end', kind: 'data' }, { id: 'e2', sourceId: 'graph', targetId: '1-api', kind: 'calls' }],
    });
    const text = toMermaid(odd, { viewId: 'topology' });
    expect(text).toContain('_1_api["API \'uno\'"]:::service');
    expect(text).toContain('end_2[("Fin")]:::database');
    expect(text).toContain('graph_2["Graph"]:::service');
    expect(fromMermaid(text).document.services.map((s) => s.name)).toEqual(["API 'uno'", 'Graph']);
  });
});

describe('importación desde Mermaid', () => {
  it('ida y vuelta de un entorno: redes, anfitrión, despliegues, recursos y dependencias', () => {
    const { document: back, warnings } = fromMermaid(toMermaid(doc, { viewId: 'env:prod' }), { name: 'Copia' });
    expect(warnings).toEqual([]);
    expect(back.workspace.name).toBe('Copia');
    expect(back.environments).toEqual([{ id: 'prod', name: 'Producción', kind: 'prod' }]);
    expect(back.networks).toEqual([
      { id: 'vpc-prod', name: 'VPC producción', environmentId: 'prod', exposure: 'private', cidr: '10.10.0.0/16' },
      { id: 'subred-publica', name: 'Subred pública', environmentId: 'prod', parentId: 'vpc-prod', exposure: 'public', cidr: '10.10.0.0/24' },
      { id: 'subred-apps', name: 'Subred de aplicaciones', environmentId: 'prod', parentId: 'vpc-prod', exposure: 'private', cidr: '10.10.1.0/24' },
      { id: 'subred-datos', name: 'Subred de datos', environmentId: 'prod', parentId: 'vpc-prod', exposure: 'isolated', cidr: '10.10.2.0/24' },
    ]);
    expect(back.resources.map((r) => [r.id, r.kind, r.networkId])).toEqual([
      ['lb-prod', 'load-balancer', 'subred-publica'],
      ['k8s-prod', 'cluster', 'subred-apps'],
      ['kafka-prod', 'queue', 'subred-apps'],
      ['pedidos-db-prod', 'database', 'subred-datos'],
    ]);
    expect(back.resources.find((r) => r.id === 'pedidos-db-prod')).toMatchObject({ technology: 'PostgreSQL', version: '15' });
    expect(back.services.map((s) => [s.id, s.kind, s.external])).toEqual([
      ['tienda-web', 'frontend', undefined],
      ['pedidos', undefined, undefined],
      ['facturacion', undefined, undefined],
      ['notificaciones', 'worker', undefined],
      ['reportes', 'job', undefined],
      ['pasarela-pagos', undefined, true],
    ]);
    expect(back.deployments.map((d) => [d.serviceId, d.hostId, d.replicas, d.version])).toEqual([
      ['tienda-web', 'k8s-prod', 2, '2.3.1'],
      ['pedidos', 'k8s-prod', 3, '3.0.2'],
      ['facturacion', 'k8s-prod', 2, '1.7.4'],
      ['notificaciones', 'k8s-prod', 1, '0.9.0'],
      ['reportes', 'k8s-prod', undefined, '0.3.5'],
    ]);
    expect(back.services.find((s) => s.id === 'pedidos')!.technology).toBe('Java, Spring Boot');
    expect(back.dependencies).toHaveLength(8);
    expect(back.dependencies.find((d) => d.sourceId === 'facturacion' && d.targetId === 'kafka-prod')).toMatchObject({ kind: 'messages', protocol: 'Kafka', description: 'Consume PedidoCreado' });
    expect(back.dependencies.find((d) => d.sourceId === 'pedidos' && d.targetId === 'pedidos-db-prod')).toMatchObject({ kind: 'data', description: 'JDBC' });
  });

  it('ida y vuelta de la topología: criticidad, servicios externos y el entorno de cada recurso', () => {
    const { document: back, warnings } = fromMermaid(toMermaid(doc, { viewId: 'topology' }));
    expect(warnings).toEqual([]);
    expect(back.environments.map((e) => [e.id, e.kind])).toEqual([['desarrollo', 'dev'], ['produccion', 'prod']]);
    expect(back.resources.map((r) => [r.id, r.environmentId])).toEqual([
      ['pedidos-db-dev', 'desarrollo'],
      ['kafka-dev', 'desarrollo'],
      ['lb-prod', 'produccion'],
      ['kafka-prod', 'produccion'],
      ['pedidos-db-prod', 'produccion'],
    ]);
    expect(back.services.map((s) => s.criticality)).toEqual(['high', 'critical', 'high', 'medium', 'low', 'high']);
    expect(back.dependencies).toHaveLength(13);
    expect(back.deployments).toEqual([]);
  });

  it('un flowchart escrito a mano: clases en español, formas, servicios repetidos en varios entornos y avisos', () => {
    const { document: d, warnings } = fromMermaid(`---
title: A mano
---
flowchart LR
  subgraph dev["Entorno: Desarrollo"]
    subgraph red1["Red privada: Interna"]
      subgraph c1["Clúster: cl-dev"]
        api1["API<br/>Go 2 réplicas · v1.2"]
        suelto["Suelto"]
      end
      bd1[("Base<br/>MySQL")]
    end
  end
  subgraph prod["Entorno: Producción"]
    subgraph c2["Máquina virtual: vm-prod"]
      api2["API"]
    end
    cola1(["Cola"])
    cache1["Caché"]:::cache
  end
  subgraph raro["Otra cosa"]
    ext["SaaS"]:::externo
  end
  api1 --> bd1
  api2 -.->|"AMQP · Encola"| cola1
  api1 ==> ext
  api2 --> api1
  api1 --> api1
  api1 --> red1
  class cola1 dadodebaja
  c1 --> bd1
`);
    expect(d.workspace.name).toBe('A mano');
    expect(d.environments.map((e) => [e.id, e.kind])).toEqual([['dev', 'dev'], ['prod', 'prod']]);
    expect(d.networks).toEqual([{ id: 'red1', name: 'Interna', environmentId: 'dev', exposure: 'private' }]);
    expect(d.resources.map((r) => [r.id, r.kind, r.environmentId, r.networkId, r.status])).toEqual([
      ['c1', 'cluster', 'dev', 'red1', undefined],
      ['bd1', 'database', 'dev', 'red1', undefined],
      ['c2', 'vm', 'prod', undefined, undefined],
      ['cola1', 'queue', 'prod', undefined, 'decommissioned'],
      ['cache1', 'cache', 'prod', undefined, undefined],
    ]);
    // «API» en dos entornos es un solo servicio con dos despliegues
    expect(d.services.map((s) => [s.id, s.name, s.technology, s.external])).toEqual([
      ['api1', 'API', 'Go', undefined],
      ['suelto', 'Suelto', undefined, undefined],
      ['ext', 'SaaS', undefined, true],
    ]);
    expect(d.deployments.map((x) => [x.serviceId, x.hostId, x.environmentId, x.replicas, x.version])).toEqual([
      ['api1', 'c1', 'dev', 2, '1.2'],
      ['suelto', 'c1', 'dev', undefined, undefined],
      ['api1', 'c2', 'prod', undefined, undefined],
    ]);
    expect(d.dependencies.map((x) => [x.sourceId, x.targetId, x.kind, x.protocol, x.description])).toEqual([
      ['api1', 'bd1', 'calls', undefined, undefined],
      ['api1', 'cola1', 'messages', 'AMQP', 'Encola'],
      ['api1', 'ext', 'data', undefined, undefined],
      ['c1', 'bd1', 'calls', undefined, undefined],
    ]);
    expect(warnings).toEqual(
      expect.arrayContaining([
        'El subgraph «Otra cosa» no es un entorno, una red ni un clúster: se ignora y sus nodos se importan sin agrupar.',
        expect.stringMatching(/^línea \d+: la arista api1 → red1 no se puede importar; se omite\.$/),
      ]),
    );
    expect(warnings.some((w) => w.includes('depende de sí mismo'))).toBe(true);
  });

  it('crea un entorno por defecto cuando el diagrama no declara ninguno, y avisa de servicios sin anfitrión', () => {
    const { document: d, warnings } = fromMermaid('flowchart LR\n  a[Web] --> b[(Datos)]\n  subgraph r["Red pública: DMZ"]\n    s["Servicio"]\n  end');
    expect(d.environments).toEqual([{ id: 'produccion', name: 'Producción', kind: 'prod' }]);
    expect(d.resources).toEqual([{ id: 'b', name: 'Datos', kind: 'database', environmentId: 'produccion' }]);
    expect(d.networks).toEqual([{ id: 'r', name: 'DMZ', environmentId: 'produccion', exposure: 'public' }]);
    expect(d.deployments).toEqual([]);
    expect(warnings.filter((w) => w.includes('se crea el entorno «Producción»'))).toHaveLength(1);
    expect(warnings).toContain('«Servicio» está en un entorno o una red pero no dentro de un clúster o una máquina virtual: se importa sin despliegue.');
  });

  it('ignora los pasos de la vista de entrega continua', () => {
    const { document: d, warnings } = fromMermaid(toMermaid(doc, { viewId: 'delivery' }));
    expect(d.pipelines).toEqual([]);
    expect(d.services.map((s) => s.id)).toEqual(['tienda-web', 'pedidos', 'facturacion', 'notificaciones', 'reportes']);
    expect(warnings.some((w) => w.includes('paso(s) de pipeline'))).toBe(true);
    expect(warnings.some((w) => w.includes('no se puede importar'))).toBe(false);
  });

  it('rechaza lo que no es un flowchart y lo vacío, con errores de módulo', () => {
    expect(() => fromMermaid('')).toThrow(PlatformImportError);
    expect(() => fromMermaid('sequenceDiagram\n A->>B: hola')).toThrow(/no se puede importar como plataforma/);
    expect(() => fromMermaid('pie\n "a": 1')).toThrow(/No se reconoce el tipo de diagrama/);
    expect(() => fromMermaid('flowchart LR\n')).toThrow(ModuleError);
    expect(() => fromMermaid('flowchart LR\n subgraph e["Entorno: X"]\n end')).toThrow(/ningún servicio ni recurso/);
  });

  it('usa el nombre indicado, el título del frontmatter o el de reserva', () => {
    expect(fromMermaid('flowchart LR\n a --> b', { fallbackName: 'archivo' }).document.workspace.name).toBe('archivo');
    expect(fromMermaid('---\ntitle: Título\n---\nflowchart LR\n a --> b', { name: 'Mío' }).document.workspace.name).toBe('Mío');
    expect(fromMermaid('---\ntitle: Título\n---\nflowchart LR\n a --> b').document.workspace.name).toBe('Título');
  });
});

describe('SVG y draw.io', () => {
  it('el entorno anida las redes y el clúster alrededor de sus contenidos, sin solapar nodos', async () => {
    const { layout } = await layoutView(doc, 'env:prod');
    const box = (id: string) => [...layout.nodes, ...layout.groups].find((b) => b.id === id)!;
    const inside = (a: { x: number; y: number; width: number; height: number }, g: { x: number; y: number; width: number; height: number }) =>
      a.x >= g.x && a.y >= g.y && a.x + a.width <= g.x + g.width && a.y + a.height <= g.y + g.height;
    expect(layout.groups.map((g) => g.id).sort()).toEqual(['k8s-prod', 'subred-apps', 'subred-datos', 'subred-publica', 'vpc-prod']);
    expect(layout.nodes).toHaveLength(9);
    expect(inside(box('k8s-prod'), box('subred-apps'))).toBe(true);
    expect(inside(box('subred-apps'), box('vpc-prod'))).toBe(true);
    expect(inside(box('i:pedidos-prod'), box('k8s-prod'))).toBe(true);
    expect(inside(box('pedidos-db-prod'), box('subred-datos'))).toBe(true);
    expect(inside(box('pasarela-pagos'), box('vpc-prod'))).toBe(false); // el servicio externo queda fuera
    for (let i = 0; i < layout.nodes.length; i += 1) {
      for (const b of layout.nodes.slice(i + 1)) {
        const a = layout.nodes[i];
        expect(a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height).toBe(false);
      }
    }
    expect(layout.edges).toHaveLength(8);
  });

  it('dibuja cada vista con el texto, los colores y los estilos de cada tipo', async () => {
    const svg = await toSvg(doc, 'env:prod');
    for (const text of ['Entorno Producción', 'Red pública: Subred pública', 'Clúster: k8s-prod', '3 réplicas · v3.0.2', 'BASE DE DATOS', 'COLA O BROKER', 'SERVICIO EXTERNO', 'Kafka · Publica PedidoCreado']) {
      expect(svg).toContain(text);
    }
    expect(svg).toContain('#d9480f'); // base de datos
    expect(svg).toContain('stroke-dasharray="6 4"'); // mensajes y servicio externo
    expect(svg).not.toMatch(/<script|href=|@import/);
    // si el título completo de una red no cabe, se recorta el CIDR
    expect(svg).not.toContain('10.10.2.0/24');
    const topology = await toSvg(doc, 'topology');
    expect(topology).toContain('entorno Desarrollo');
    expect(topology).toContain('criticidad crítica');
    const delivery = await toSvg(doc, 'delivery');
    for (const text of ['CI/CD: Entrega de servicios (GitLab CI)', 'Construir y probar', 'aprobación manual', 'Planificar y aplicar']) expect(delivery).toContain(text);
    expect(await toSvg(doc, 'impact:kafka-prod')).toContain('Impacto de «Kafka (prod)» (Producción)');
    expect(await toSvg(doc, 'focus:pedidos')).toContain('Entorno de «Servicio de pedidos»');
  });

  it('un recurso previsto se dibuja discontinuo y uno dado de baja, con borde rojo', async () => {
    const withStatus = changed((j) => {
      j.resources.find((r) => r.id === 'kafka-dev')!.status = 'planned';
      j.resources.find((r) => r.id === 'pedidos-db-dev')!.status = 'decommissioned';
    });
    const { nodes } = await layoutView(withStatus, 'env:dev');
    expect(nodes.get('kafka-dev')).toMatchObject({ dashed: true, status: 'planned' });
    expect(nodes.get('kafka-dev')!.lines).toContain('previsto');
    expect(nodes.get('pedidos-db-dev')).toMatchObject({ stroke: '#c92a2a', status: 'decommissioned' });
  });

  it('draw.io tiene una página por vista, con sus nodos, grupos y aristas', async () => {
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(await toDrawio(doc));
    const pages = ([] as Array<Record<string, unknown>>).concat(parsed.mxfile.diagram);
    expect(pages.map((p) => p['@_id'])).toEqual(listViews(doc).map((v) => v.id));
    const cells = (i: number) => ([] as Array<Record<string, string>>).concat(parsed.mxfile.diagram[i].mxGraphModel.root.mxCell);
    const prod = cells(2);
    expect(prod.filter((c) => c['@_edge']).length).toBe(8);
    expect(prod.filter((c) => c['@_vertex']).length).toBe(14); // 9 nodos + 5 grupos
    expect(prod.find((c) => c['@_id'] === 'n-vpc-prod')!['@_value']).toBe('Red privada: VPC producción (10.10.0.0/16)');
    const database = prod.find((c) => c['@_id'] === 'n-pedidos-db-prod')!;
    expect(database['@_style']).toContain('shape=cylinder3');
    expect(database['@_value']).toContain('<b>Base de pedidos</b>');
    expect(cells(0).filter((c) => c['@_edge']).length).toBe(13);
  });
});

describe('desde un mapa de integración', () => {
  const integration = JSON.parse(readFileSync('examples/pedidos-integracion.json', 'utf8')) as unknown;

  it('pasa sistemas a servicios y almacenes, pasarelas y brokers a recursos, con sus dependencias', () => {
    const { document: d, warnings } = fromIntegrationJson(integration);
    expect(d.workspace.name).toBe('Plataforma - Pedidos en línea');
    expect(d.environments).toEqual([{ id: 'prod', name: 'Producción', kind: 'prod' }]);
    expect(d.services.map((s) => [s.id, s.owner, s.external, s.ref])).toEqual([
      ['tienda-web', 'Equipo Web', undefined, 'urn:iark:integration:tienda-web'],
      ['pedidos', 'Equipo Pedidos', undefined, 'urn:iark:integration:pedidos'],
      ['facturacion', 'Equipo Finanzas', undefined, 'urn:iark:integration:facturacion'],
      ['pasarela-pagos', undefined, true, 'urn:iark:integration:pasarela-pagos'],
      ['asistente', undefined, true, 'urn:iark:integration:asistente'],
      ['erp', undefined, true, 'urn:iark:integration:erp'],
    ]);
    expect(d.resources.map((r) => [r.id, r.kind, r.technology])).toEqual([
      ['gateway', 'gateway', 'Kong'],
      ['kafka', 'queue', undefined],
      ['pedidos-db', 'database', 'PostgreSQL'],
    ]);
    // el tópico se funde en Kafka; el que consume depende del broker; la pasarela depende de los servicios a los que encamina
    expect(d.dependencies.map((x) => `${x.sourceId} -${x.kind}-> ${x.targetId}`)).toEqual([
      'tienda-web -calls-> gateway',
      'gateway -calls-> pedidos',
      'pedidos -data-> pedidos-db',
      'pedidos -messages-> kafka',
      'facturacion -messages-> kafka',
      'facturacion -calls-> pasarela-pagos',
      'asistente -calls-> pedidos',
      'pedidos -calls-> facturacion',
    ]);
    expect(warnings[0]).toContain('se funden');
    expect(warnings.at(-1)).toContain('No se crean redes, anfitriones ni despliegues');
    expect(d.deployments).toEqual([]);
  });

  it('rechaza lo que no es un documento de integración', () => {
    expect(() => fromIntegrationJson({})).toThrow(PlatformImportError);
    expect(() => fromIntegrationJson({ nodes: [{ id: 'a', kind: 'store', name: 'A' }] })).toThrow(/no tiene sistemas/);
    expect(fromIntegrationJson({ nodes: [{ id: 'prod', kind: 'system', name: 'Sistema' }] }, { name: 'Mío' }).document.environments[0].id).toBe('prod-2');
  });
});

describe('generación con IA', () => {
  it('quita los null de la salida estructurada y valida el documento', () => {
    const generated = toGenerated(doc);
    const result = generatedToPlatform(generated);
    expect(result.ok).toBe(true);
    // La generación no incluye los `ref` (enlaces por URN a otros módulos): al refinar se recuperan del documento base.
    if (result.ok) expect(carryRefs(doc, result.document)).toEqual(doc);
    const broken = { ...generated, deployments: [{ ...generated.deployments[0], hostId: 'pedidos-db-prod' }] };
    const failed = generatedToPlatform(broken);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.issues).toContain('solo se despliega en un clúster o una máquina virtual');
  });

  it('conserva el equivalente en otro entorno (counterpartOf) al refinar y rechaza el que no existe o es del mismo entorno', () => {
    const declared = { ...doc, resources: doc.resources.map((r) => (r.id === 'pedidos-db-prod' ? { ...r, name: 'Almacén transaccional', counterpartOf: 'pedidos-db-dev' } : r)) };
    expect(platformModule.schema.safeParse(declared).success).toBe(true);
    const generated = toGenerated(declared);
    expect(generated.resources.find((r) => r.id === 'pedidos-db-prod')?.counterpartOf).toBe('pedidos-db-dev');
    // Los recursos sin equivalente declarado llevan null (la salida estructurada exige todos los campos) y vuelven a quedar sin el campo.
    expect(generated.resources.find((r) => r.id === 'kafka-prod')?.counterpartOf).toBeNull();
    const back = generatedToPlatform(generated);
    expect(back.ok && back.document.resources.find((r) => r.id === 'pedidos-db-prod')?.counterpartOf).toBe('pedidos-db-dev');
    expect(back.ok && back.document.resources.find((r) => r.id === 'kafka-prod')).not.toHaveProperty('counterpartOf');
    const missing = generatedToPlatform({ ...generated, resources: generated.resources.map((r) => (r.id === 'pedidos-db-prod' ? { ...r, counterpartOf: 'no-existe' } : r)) });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.issues).toContain('referencia un recurso equivalente inexistente: "no-existe"');
    const sameEnvironment = generatedToPlatform({ ...generated, resources: generated.resources.map((r) => (r.id === 'pedidos-db-prod' ? { ...r, counterpartOf: 'kafka-prod' } : r)) });
    expect(sameEnvironment.ok).toBe(false);
    if (!sameEnvironment.ok) expect(sameEnvironment.issues).toContain('están en el mismo entorno');
    const schema = platformAiSpec.generationJsonSchema() as { properties: { resources: { items: { properties: Record<string, unknown>; required: string[] } } } };
    expect(schema.properties.resources.items.properties).toHaveProperty('counterpartOf');
    expect(schema.properties.resources.items.required).toContain('counterpartOf');
  });

  it('el prompt describe el dominio y el usuario incluye el modelo base al refinar', () => {
    expect(platformAiSpec.system()).toContain('counterpartOf');
    expect(platformAiSpec.system()).toContain('arquitecto de plataforma');
    expect(platformAiSpec.system()).toContain('los ÚNICOS anfitriones');
    expect(platformAiSpec.user('Una tienda')).toContain('Una tienda');
    const refine = platformAiSpec.user('Añade un caché', doc);
    expect(refine).toContain('"id": "pedidos-db-prod"');
    expect(refine).toContain('Añade un caché');
    const schema = platformAiSpec.generationJsonSchema() as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(['workspace', 'environments', 'networks', 'resources', 'services', 'deployments', 'dependencies', 'pipelines']);
  });
});

describe('módulo', () => {
  it('cumple el contrato y se puede registrar junto a otros módulos', () => {
    const registry = new ModuleRegistry().register(platformModule);
    expect(registry.require('platform')).toBe(platformModule);
    expect(platformModule.exporters.map((e) => e.id)).toEqual(['mermaid', 'svg', 'drawio']);
    expect(platformModule.importers.map((i) => i.id)).toEqual(['mermaid', 'terraform', 'kubernetes', 'cloudformation']);
    const manifest = buildManifest(registry, { name: 'Prueba', version: '0.0.0' });
    expect(manifest.modules[0]).toMatchObject({ id: 'platform', importFormats: ['mermaid', 'terraform', 'kubernetes', 'cloudformation'], exportFormats: ['mermaid', 'svg', 'drawio'] });
    expect(platformModule.entities!(doc).map((e) => e.kind)).toEqual(expect.arrayContaining(['environment', 'network', 'resource', 'service', 'pipeline']));
    expect(platformModule.validate(doc)).toEqual([]);
    expect((platformModule.jsonSchema() as { type: string }).type).toBe('object');
    expect(platformModule.importers[0].detect!('flowchart LR\n a --> b')).toBe(true);
    expect(platformModule.cliCommands!.map((c) => c.name)).toEqual(['deployments', 'compare', 'impact', 'from-integration', 'icons']);
  });
});

describe('comandos', () => {
  const run = (name: string, args: string[], input: unknown, options: Record<string, unknown> = {}) =>
    platformCommands.find((c) => c.name === name)!.run({ args, options, input: typeof input === 'string' ? input : JSON.stringify(input) }) as string;

  it('deployments muestra dónde corre cada servicio en cada entorno y avisa de lo que no se despliega y de las versiones distintas', () => {
    const text = run('deployments', [], example);
    expect(text).toContain('| Servicio | Criticidad | Desarrollo | Producción |');
    expect(text).toContain('| Servicio de pedidos | crítica | k8s-dev ×1 v3.1.0 | k8s-prod ×3 v3.0.2 |');
    expect(text).toContain('| Reportes nocturnos | baja | k8s-dev v0.4.0 | k8s-prod v0.3.5 |');
    expect(text).not.toContain('Pasarela de pagos');
    expect(text).toContain('Todos los servicios se despliegan en algún entorno.');
    expect(text).toContain('Versiones distintas entre entornos: Tienda web (Desarrollo: v2.4.0; Producción: v2.3.1)');
    expect(text).not.toContain('Notificaciones (Desarrollo');
    const gaps = run('deployments', [], { environments: [{ id: 'e', name: 'E' }], services: [{ id: 'a', name: 'A' }] });
    expect(gaps).toContain('| A | — | — |');
    expect(gaps).toContain('Sin despliegue en ningún entorno: A');
    expect(run('deployments', [], {})).toBe('El documento no define servicios propios.');
  });

  it('impact muestra lo que depende de un elemento como un árbol, y los responsables a avisar', () => {
    const text = run('impact', ['kafka-prod'], example);
    expect(text).toContain('Impacto de «Kafka (prod)» (Cola o broker) en el entorno «Producción»');
    expect(text).toContain('Dependen de él (se ven afectados si cae o cambia): 5 elemento(s)');
    expect(text).toContain('- Servicio de pedidos (Servicio) · Equipo Pedidos · criticidad crítica\n  - Tienda web (Frontend) · Equipo Web · criticidad alta\n    - Balanceador público (Balanceador) · Plataforma');
    expect(text).toContain('Responsables a avisar: Plataforma, Equipo Pedidos, Equipo Finanzas, Equipo Web');
    const host = run('impact', ['k8s-dev'], example);
    expect(host).toContain('Dependen de él (se ven afectados si cae o cambia): 5 elemento(s)');
    expect(host).not.toContain('Balanceador');
    const both = run('impact', ['pedidos'], example, { direction: 'both', env: 'prod' });
    expect(both).toContain('Depende de (lo que necesita para funcionar): 3 elemento(s)');
    expect(both).toContain('- k8s-prod (Clúster) · Plataforma');
    const mixed = run('impact', ['pedidos'], example, { direction: 'dependencies' });
    expect(mixed).not.toContain('en el entorno');
    expect(mixed).toContain('6 elemento(s)');
    expect(mixed).not.toContain('Responsables a avisar');
    expect(run('impact', ['tienda-web'], example, { env: 'dev' })).toContain('Dependen de él (se ven afectados si cae o cambia): ninguno');
    expect(() => run('impact', ['nada'], example)).toThrow(/No existe el servicio ni el recurso «nada»/);
    expect(() => run('impact', ['prod'], example)).toThrow(/No existe el servicio ni el recurso «prod»/);
    expect(() => run('impact', ['pedidos'], example, { direction: 'lateral' })).toThrow(/Sentido inválido/);
    expect(() => run('impact', ['pedidos'], example, { env: 'qa' })).toThrow(/No existe el entorno «qa»/);
  });

  it('las entradas inválidas terminan en errores de módulo', () => {
    expect(() => run('deployments', [], 'no es json')).toThrow(ModuleError);
    expect(() => run('deployments', [], { resources: [{ id: 'r', name: 'R', kind: 'rara', environmentId: 'e' }] })).toThrow(/Documento de plataforma inválido/);
    expect(() => platformCommands[0].run({ args: [], options: {} })).toThrow(/Falta la entrada/);
  });
});
