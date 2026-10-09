import { readFileSync } from 'node:fs';
import { importFiles, importText, ModuleRegistry } from '@iark/kernel';
import { describe, expect, it } from 'vitest';
import { platformModule } from '../module';
import { toMermaid } from '../export/mermaid';
import { toSvg } from '../export/render';
import { analyzePlatform } from '../issues';
import { validatePlatformDocument } from '../schema';
import type { PlatformDocument } from '../types';
import { fromHelm, looksLikeHelmChart, type HelmFile } from './fromHelm';
import { PlatformImportError } from './fromMermaid';
import { looksLikeKubernetes } from './fromKubernetes';
import { looksLikeCloudFormation } from './fromCloudFormation';
import { looksLikeTerraform } from './terraformModel';

const HELM = 'tests/fixtures/importar/helm';
const read = (path: string): string => readFileSync(`${HELM}/${path}`, 'utf8');
const folder = (dir: string, names: string[]): HelmFile[] => names.map((n) => ({ name: `${HELM}/${dir}/${n}`, text: read(`${dir}/${n}`) }));
const tienda = (): HelmFile[] => folder('tienda', ['Chart.yaml', 'values.yaml']);
const legado = (): HelmFile[] => folder('legado', ['Chart.yaml', 'requirements.yaml', 'values.yaml']);
const byId = <T extends { id: string }>(list: T[], id: string): T => {
  const found = list.find((x) => x.id === id);
  if (!found) throw new Error(`No hay «${id}» en ${list.map((x) => x.id).join(', ')}`);
  return found;
};
const deps = (doc: PlatformDocument): string[] => doc.dependencies.map((d) => `${d.kind} ${d.sourceId} ${d.targetId}`);
/** Un chart mínimo con las dependencias y los valores que se den. */
const chart = (extra = '', name = 'demo'): string => `apiVersion: v2\nname: ${name}\nversion: 1.0.0\n${extra}`;
const only = (text: string, name = 'Chart.yaml'): HelmFile[] => [{ name, text }];

describe('importar Helm: el chart «tienda» (Chart.yaml + values.yaml, subcharts de Bitnami)', () => {
  const { document: doc, warnings } = fromHelm(tienda(), { file: `${HELM}/tienda` });

  it('pasa el esquema y el análisis de gobierno no encuentra errores', () => {
    expect(validatePlatformDocument(doc).ok).toBe(true);
    expect(analyzePlatform(doc).filter((i) => i.severity === 'error')).toEqual([]);
    expect(doc.workspace).toEqual({ name: 'tienda', description: 'Tienda en línea con su base de datos, caché y cola de mensajes' });
    expect(doc.pipelines).toEqual([]);
  });

  it('un entorno, el de la carpeta (Helm no dice dónde se despliega), con el proveedor Kubernetes', () => {
    expect(doc.environments).toEqual([{ id: 'tienda', name: 'tienda', description: 'Entorno deducido del nombre de la carpeta o del archivo.', provider: 'kubernetes' }]);
  });

  it('el chart es un servicio con su imagen, responsable, repositorio y etiquetas; los subcharts de código son otro servicio (con su alias)', () => {
    expect(doc.services.map((s) => s.id)).toEqual(['servicio-tienda', 'pasarela']);
    const main = byId(doc.services, 'servicio-tienda');
    expect(main).toMatchObject({ name: 'tienda', owner: 'equipo-tienda', repo: 'https://git.example.com/comercio/tienda', tags: ['helm', 'chart:tienda-0.4.2'] });
    expect(main.description).toBe(
      'Tienda en línea con su base de datos, caché y cola de mensajes · Chart de Helm tienda 0.4.2 (appVersion 2.7.0) · imagen registry.example.com/comercio/tienda-web:2.7.1 · autoescalado 3–10 réplicas',
    );
    expect(byId(doc.services, 'pasarela')).toMatchObject({ name: 'pasarela', tags: ['helm', 'subchart:pagos'] });
    expect(byId(doc.services, 'pasarela').description).toBe('Subchart de Helm «pagos» (alias «pasarela») 1.1.0 · repositorio file://../pagos · imagen registry.example.com/comercio/pagos:1.1.0');
  });

  it('despliegues: en el clúster implícito, con réplicas (autoescalado mínimo o replicaCount), etiqueta de la imagen y límites', () => {
    expect(doc.deployments).toEqual([
      { id: 'servicio-tienda-tienda', serviceId: 'servicio-tienda', environmentId: 'tienda', hostId: 'kubernetes', replicas: 3, version: '2.7.1', cpuLimit: '0.5', memoryLimit: '512 MiB' },
      { id: 'pasarela-tienda', serviceId: 'pasarela', environmentId: 'tienda', hostId: 'kubernetes', replicas: 2, version: '1.1.0' },
    ]);
  });

  it('recursos: el clúster, el ingress, el balanceador y el volumen de values.yaml, y los subcharts que son almacenes conocidos', () => {
    expect(doc.resources.map((r) => [r.id, r.kind, r.technology, r.version ?? null, r.networkId ?? null])).toEqual([
      ['kubernetes', 'cluster', 'Kubernetes', null, null],
      ['tienda-ingress', 'gateway', 'Kubernetes Ingress (nginx)', null, 'entrada-publica'],
      ['tienda-lb', 'load-balancer', 'Kubernetes Service LoadBalancer', null, 'entrada-publica'],
      ['tienda-volumen', 'storage', 'Kubernetes PersistentVolumeClaim', null, null],
      ['postgresql', 'database', 'PostgreSQL', '15.4.0', null],
      ['redis', 'cache', 'Redis', '7.2.3', null],
      ['rabbitmq', 'queue', 'RabbitMQ', null, null],
    ]);
    expect(byId(doc.resources, 'tienda-ingress').description).toBe('Ingress activado en values.yaml · hosts tienda.example.com · con TLS');
    expect(byId(doc.resources, 'tienda-volumen').description).toBe('persistence.enabled en values.yaml · tamaño 20Gi');
    expect(byId(doc.resources, 'redis').description).toBe('Subchart de Helm «redis» 18.x.x · repositorio https://charts.bitnami.com/bitnami · arquitectura standalone');
    expect(doc.networks).toEqual([
      { id: 'entrada-publica', name: 'Entrada pública', environmentId: 'tienda', exposure: 'public', description: 'Red que agrupa lo que el chart expone a Internet (Ingress y Services LoadBalancer).' },
    ]);
  });

  it('dependencias: del ingress y el balanceador al chart; del chart al volumen, las bases de datos, la caché, la cola y la pasarela', () => {
    expect(deps(doc)).toEqual([
      'calls tienda-ingress servicio-tienda',
      'calls tienda-lb servicio-tienda',
      'data servicio-tienda tienda-volumen',
      'data servicio-tienda postgresql',
      'data servicio-tienda redis',
      'messages servicio-tienda rabbitmq',
      'calls servicio-tienda pasarela',
    ]);
    expect(doc.dependencies[0]).toMatchObject({ protocol: 'HTTPS', description: 'ingress.enabled en values.yaml' });
  });

  it('avisa de lo que no entra, con las plantillas sin interpretar en primer lugar', () => {
    expect(warnings).toEqual([
      'Helm (Chart.yaml + values.yaml): las plantillas (templates/, Go templates) no se interpretan, así que no aparece lo que el chart genera sin declararlo en values.yaml (Services, ConfigMaps, jobs, variables de entorno…). Para verlo, renderice el chart y use el importador de Kubernetes: helm template mi-release ./mi-chart | iark import --module platform.',
      'Un chart de Helm no dice en qué entorno se despliega: se crea el entorno «tienda» a partir del nombre de la carpeta o del archivo.',
      'El chart no declara el clúster: se crea «Clúster Kubernetes» para alojar los despliegues.',
      '1 subchart(s) desactivado(s) por su «condition» en values.yaml, que no se importan: kube-prometheus-stack (monitoring.enabled).',
      '1 subchart(s) de biblioteca (common): no despliegan nada y no se importan.',
      'Los subcharts vienen de 4 repositorio(s) (https://charts.bitnami.com/bitnami, oci://registry-1.docker.io/bitnamicharts, file://../pagos, … (1 más)): no se descargan ni se leen (no hay red ni disco), así que solo se usan su nombre, su versión y lo que values.yaml dice de ellos.',
      '3 clave(s) de values.yaml sin interpretar (solo se leen image, replicaCount, resources, autoscaling, ingress, service.type, persistence y las secciones de los subcharts): nodeSelector, tolerations, podAnnotations.',
    ]);
  });

  it('nunca copia una contraseña de values.yaml: ni en el documento ni en los avisos', () => {
    const everything = JSON.stringify({ doc, warnings });
    expect(everything).not.toContain('no-copiar-esta-clave');
    expect(everything).not.toContain('tampoco-esta-otra');
    expect(everything).not.toContain('tienda@example.com');
  });

  it('se ve y se exporta: vistas, SVG sin NaN y Mermaid', async () => {
    for (const view of ['env:tienda', 'impact:postgresql']) {
      const svg = await toSvg(doc, view);
      expect(svg, view).toContain('<svg');
      expect(svg, view).not.toContain('NaN');
    }
    expect(toMermaid(doc, { viewId: 'env:tienda' })).toContain('rabbitmq');
  }, 60_000);

  it('importar dos veces da lo mismo; BOM, CRLF y el orden de los archivos no cambian nada', () => {
    const again = fromHelm(tienda(), { file: `${HELM}/tienda` });
    expect(again.document).toEqual(doc);
    expect(again.warnings).toEqual(warnings);
    const crlf = fromHelm(
      tienda().map((f) => ({ ...f, text: `﻿${f.text.replace(/\n/g, '\r\n')}` })).reverse(),
      { file: `${HELM}/tienda` },
    );
    expect(crlf.document).toEqual(doc);
  });
});

describe('importar Helm: un chart de la versión 1 con requirements.yaml', () => {
  const { document: doc, warnings } = fromHelm(legado(), { file: `${HELM}/legado` });

  it('lee las dependencias de requirements.yaml y el entorno de los valores (env)', () => {
    expect(doc.environments).toEqual([{ id: 'desarrollo', name: 'desarrollo', description: 'Entorno deducido de los valores (environment/env).', kind: 'dev', provider: 'kubernetes' }]);
    expect(doc.resources.map((r) => [r.id, r.kind, r.technology])).toEqual([
      ['kubernetes', 'cluster', 'Kubernetes'],
      ['mariadb', 'database', 'MariaDB'],
      ['memcached', 'cache', 'Memcached'],
    ]);
    expect(deps(doc)).toEqual(['data blog mariadb', 'data blog memcached']);
    expect(doc.deployments).toEqual([{ id: 'blog-desarrollo', serviceId: 'blog', environmentId: 'desarrollo', hostId: 'kubernetes', replicas: 1, version: '5.2.1' }]);
  });

  it('no avisa del entorno (lo dicen los valores) pero sí de las plantillas, el clúster y los repositorios', () => {
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatch(/^Helm \(Chart\.yaml \+ values\.yaml\): las plantillas/);
    expect(warnings[1]).toBe('El chart no declara el clúster: se crea «Clúster Kubernetes» para alojar los despliegues.');
    expect(warnings[2]).toMatch(/^Los subcharts vienen de 1 repositorio\(s\) \(https:\/\/charts\.bitnami\.com\/bitnami\)/);
  });
});

describe('importar Helm: casos de estructura', () => {
  it('un Chart.yaml solo basta: el chart y sus subcharts, sin valores', () => {
    const { document: doc, warnings } = fromHelm(only(chart('dependencies:\n  - name: redis\n    version: 18.x.x\n  - name: auth-api\n    version: 1.0.0\n')));
    expect(doc.environments.map((e) => e.name)).toEqual(['demo']);
    expect(doc.services.map((s) => s.id)).toEqual(['servicio-demo', 'auth-api']);
    expect(doc.resources.map((r) => [r.id, r.kind])).toEqual([['kubernetes', 'cluster'], ['redis', 'cache']]);
    expect(deps(doc)).toEqual(['data servicio-demo redis', 'calls servicio-demo auth-api']);
    expect(warnings[1]).toBe('Un chart de Helm no dice en qué entorno se despliega: se crea el entorno «demo» a partir del nombre del chart.');
  });

  it('el nombre de la carpeta o del archivo manda sobre el del chart para el entorno; options.name para el espacio de trabajo', () => {
    const result = fromHelm(only(chart()), { file: '/charts/produccion-eu', name: 'Mi chart' });
    expect(result.document.environments[0]).toMatchObject({ id: 'produccion-eu', name: 'produccion-eu', kind: 'prod' });
    expect(result.document.workspace.name).toBe('Mi chart');
  });

  it('un chart de tipo library no se despliega: no es un servicio y no hay clúster', () => {
    const { document: doc, warnings } = fromHelm(only(chart('type: library\n')));
    expect(doc.services).toEqual([]);
    expect(doc.resources).toEqual([]);
    expect(doc.deployments).toEqual([]);
    expect(warnings).toContain('El chart «demo» es de tipo library: no se despliega, así que no se importa como servicio.');
    expect(validatePlatformDocument(doc).ok).toBe(true);
  });

  it('condition: manda la primera ruta que exista y sea booleana; sin valor se importa; alias y repetidos', () => {
    const files = [
      {
        name: 'Chart.yaml',
        text: chart(
          [
            'dependencies:',
            '  - { name: postgresql, version: 1.0.0, condition: "bd.enabled,postgresql.enabled" }',
            '  - { name: redis, version: 1.0.0, condition: "cache.enabled" }',
            '  - { name: mongodb, version: 1.0.0, alias: documentos }',
            '  - { name: mongodb, version: 1.0.0, alias: documentos }',
            '  - { name: kafka, version: 1.0.0, condition: "kafka.enabled" }',
            '',
          ].join('\n'),
        ),
      },
      { name: 'values.yaml', text: 'bd:\n  enabled: false\npostgresql:\n  enabled: true\nkafka:\n  enabled: "no"\n' },
    ];
    const { document: doc, warnings } = fromHelm(files);
    // postgresql: bd.enabled=false manda; redis: sin valor, se importa; mongodb (alias): una sola vez; kafka: no es booleano, se importa
    expect(doc.resources.map((r) => r.id)).toEqual(['kubernetes', 'redis', 'documentos', 'kafka']);
    expect(warnings.find((w) => w.includes('desactivado'))).toBe('1 subchart(s) desactivado(s) por su «condition» en values.yaml, que no se importan: postgresql (bd.enabled,postgresql.enabled).');
  });

  it('almacenes conocidos con sufijo (postgresql-ha) y subcharts desconocidos; sin etiqueta no hay versión de recurso', () => {
    const { document: doc } = fromHelm(only(chart('dependencies:\n  - { name: postgresql-ha, version: 1.0.0 }\n  - { name: minio, version: 1.0.0 }\n  - { name: harbor, version: 1.0.0 }\n')));
    expect(doc.resources.map((r) => [r.id, r.kind])).toEqual([['kubernetes', 'cluster'], ['postgresql-ha', 'database'], ['minio', 'storage']]);
    expect(doc.services.map((s) => s.id)).toEqual(['servicio-demo', 'harbor']);
    expect(doc.resources.every((r) => r.version === undefined)).toBe(true);
  });

  it('la imagen: cadena, repositorio con etiqueta, solo etiqueta (subchart de Bitnami) y plantillas de Go sin resolver', () => {
    const image = (values: string): PlatformDocument => fromHelm([...only(chart()), { name: 'values.yaml', text: values }]).document;
    expect(image('image: nginx:1.25\n').deployments[0].version).toBe('1.25');
    expect(image('image:\n  repository: app\n  tag: "3"\n').services[0].description).toContain('imagen app:3');
    expect(image('image:\n  tag: "9.9"\n').deployments[0].version).toBe('9.9');
    const unresolved = image('image: "{{ .Values.registry }}/app:1"\n');
    expect(unresolved.services[0].description).not.toContain('imagen');
    expect(unresolved.deployments[0].version).toBeUndefined();
  });

  it('sin etiqueta de imagen, la versión es la appVersion; replicaCount: 0 se avisa y no se pone', () => {
    const { document: doc, warnings } = fromHelm([{ name: 'Chart.yaml', text: chart('appVersion: "4.1"\n') }, { name: 'values.yaml', text: 'replicaCount: 0\n' }]);
    expect(doc.deployments[0]).toEqual({ id: 'servicio-demo-demo', serviceId: 'servicio-demo', environmentId: 'demo', hostId: 'kubernetes', version: '4.1' });
    expect(warnings).toContain('El servicio «demo» tiene 0 réplicas en values.yaml: se importa sin réplicas indicadas.');
  });

  it('ingress sin TLS, sin hosts ni clase: HTTP; con hostname y tls: true: HTTPS', () => {
    const run = (values: string): PlatformDocument => fromHelm([...only(chart()), { name: 'values.yaml', text: values }]).document;
    const plain = run('ingress:\n  enabled: true\n');
    expect(plain.dependencies[0]).toMatchObject({ sourceId: 'demo-ingress', targetId: 'servicio-demo' });
    expect(plain.dependencies[0].protocol).toBe('HTTP');
    expect(byId(plain.resources, 'demo-ingress')).toMatchObject({ technology: 'Kubernetes Ingress', description: 'Ingress activado en values.yaml' });
    const tls = run('ingress:\n  enabled: true\n  hostname: demo.example.com\n  tls: true\n');
    expect(tls.dependencies[0].protocol).toBe('HTTPS');
    expect(byId(tls.resources, 'demo-ingress').description).toBe('Ingress activado en values.yaml · hosts demo.example.com · con TLS');
    expect(run('ingress:\n  enabled: false\nservice:\n  type: ClusterIP\npersistence:\n  enabled: false\n').resources.map((r) => r.id)).toEqual(['kubernetes']);
  });

  it('values-*.yaml adicionales no se aplican y se avisa; un archivo suelto que no es YAML no tumba el chart', () => {
    const files: HelmFile[] = [
      ...tienda(),
      { name: `${HELM}/tienda/values-prod.yaml`, text: 'replicaCount: 9\n' },
      { name: `${HELM}/tienda/plantilla.yaml`, text: 'metadata:\n  name: {{ .Release.Name }}\n  labels: {{- include "x" . | nindent 4 }}\n' },
      { name: `${HELM}/tienda/ci.yaml`, text: 'ci: true\n' },
    ];
    const { document: doc, warnings } = fromHelm(files, { file: `${HELM}/tienda` });
    expect(byId(doc.deployments, 'servicio-tienda-tienda').replicas).toBe(3);
    expect(warnings).toContain(`1 archivo(s) de valores adicionales (${HELM}/tienda/values-prod.yaml) no se aplican: solo se lee values.yaml.`);
    expect(warnings).toContain(`2 archivo(s) que no son parte del chart y no se importan: ${HELM}/tienda/plantilla.yaml, ${HELM}/tienda/ci.yaml.`);
  });

  it('un valor llamado como una propiedad de Object.prototype no se confunde con una sección', () => {
    const files = [
      { name: 'Chart.yaml', text: chart('dependencies:\n  - { name: constructor, version: 1.0.0 }\n  - { name: __proto__, version: 1.0.0 }\n  - { name: toString, version: 1.0.0, condition: "constructor.enabled" }\n') },
      { name: 'values.yaml', text: '__proto__:\n  replicaCount: 7\nconstructor:\n  replicaCount: 5\n' },
    ];
    const { document: doc } = fromHelm(files);
    expect(({} as Record<string, unknown>).replicaCount).toBeUndefined();
    expect(doc.services.map((s) => s.name)).toEqual(['demo', 'constructor', '__proto__', 'toString']);
    expect(doc.deployments.map((d) => d.replicas ?? null)).toEqual([null, 5, 7, null]);
    expect(validatePlatformDocument(doc).ok).toBe(true);
  });

  it('un chart con miles de dependencias se importa sin colgarse y sin pasar de los topes', () => {
    const many = Array.from({ length: 3000 }, (_, i) => `  - { name: sub-${i}, version: 1.0.0, repository: "https://repo.example/${i}" }`).join('\n');
    const started = Date.now();
    const { document: doc, warnings } = fromHelm(only(chart(`dependencies:\n${many}\n`)));
    expect(doc.services).toHaveLength(3001);
    expect(doc.dependencies).toHaveLength(3000);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(warnings.join('\n')).toContain('3000 repositorio(s)');
    expect(validatePlatformDocument(doc).ok).toBe(true);
  }, 30_000);
});

describe('importar Helm: entradas que no son un chart utilizable', () => {
  const fail = (files: HelmFile[]): string => {
    try {
      fromHelm(files);
    } catch (error) {
      expect(error).toBeInstanceOf(PlatformImportError);
      return (error as Error).message;
    }
    throw new Error('no falló');
  };

  it('sin archivos, vacío, de otro tipo o con YAML roto: un mensaje claro de una línea', () => {
    expect(fail([])).toBe('No hay ningún archivo de Helm que importar.');
    expect(fail(only(''))).toBe('El archivo «Chart.yaml» está vacío.');
    expect(fail(only('  \n\t'))).toMatch(/está vacío/);
    expect(fail(only('- a\n- b\n'))).toMatch(/no es un Chart\.yaml válido|no es un Chart\.yaml/);
    expect(fail(only('hola'))).toMatch(/no es un Chart\.yaml/);
    expect(fail(only('apiVersion: v2\nname: [sin cerrar\n'))).toMatch(/^El archivo «Chart\.yaml» no es YAML válido \(línea \d+, columna \d+\)/);
    expect(fail(only('a: 1\na: 2\n'))).toMatch(/no es YAML válido/);
    expect(fail(only('a: 1\n---\nb: 2\n'))).toMatch(/varios documentos YAML/);
  });

  it('un Chart.yaml sin nombre o sin versión se dice; un manifiesto de Kubernetes suelto remite a helm template', () => {
    expect(fail(only('apiVersion: v2\nversion: 1.0.0\n'))).toBe('El archivo «Chart.yaml» no es un Chart.yaml válido: le falta «name» (y «version»).');
    expect(fail(only('apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: x\n', 'despliegue.yaml'))).toMatch(/helm template … \| iark import --module platform/);
  });

  it('sin Chart.yaml entre varios archivos, o con dos charts: lo dice', () => {
    expect(fail([{ name: 'values.yaml', text: 'a: 1\n' }, { name: 'otro.yaml', text: 'b: 2\n' }])).toMatch(/^No se encontró un Chart\.yaml entre los archivos \(values\.yaml, otro\.yaml\)/);
    expect(fail([...only(chart(), 'a/Chart.yaml'), ...only(chart('', 'otro'), 'b/Chart.yaml')])).toBe('Hay más de un Chart.yaml (a/Chart.yaml y b/Chart.yaml): se importa un chart cada vez.');
  });

  it('values.yaml que no es un mapa, y más de 200 archivos', () => {
    expect(fail([...only(chart()), { name: 'values.yaml', text: '- 1\n- 2\n' }])).toBe('El archivo «values.yaml» no es un mapa de valores.');
    const many = Array.from({ length: 201 }, (_, i) => ({ name: `f${i}.yaml`, text: 'a: 1\n' }));
    expect(fail(many)).toMatch(/Hay 201 archivos/);
  });

  it('un values.yaml vacío o solo con comentarios no es un error', () => {
    expect(() => fromHelm([...only(chart()), { name: 'values.yaml', text: '# nada\n' }])).not.toThrow();
  });

  it('dependencias que no son una lista de mapas con nombre se avisan sin fallar', () => {
    const { warnings } = fromHelm(only(chart('dependencies:\n  - sin-mapa\n  - { version: 1.0.0 }\n  - { name: ok, version: 1.0.0 }\n')));
    expect(warnings).toContain('1 entrada(s) de «dependencies» sin nombre, que no se importan.');
    expect(fromHelm(only(chart('dependencies: 5\n'))).document.services).toHaveLength(1);
  });

  it('un anidamiento de miles de niveles, una bomba de alias y un texto de más de 32 MiB se rechazan con un error', () => {
    expect(fail([...only(chart()), { name: 'values.yaml', text: `x: ${'['.repeat(20_000)}${']'.repeat(20_000)}\n` }])).toMatch(/anidado|anidamiento/);
    const bomb = ['a: &a [x, x, x, x, x, x, x, x, x]', ...'bcdefghij'.split('').map((k, i) => `${k}: &${k} [${Array.from({ length: 9 }, () => `*${'abcdefghi'[i]}`).join(', ')}]`), 'z: *j'].join('\n');
    expect(fail([...only(chart()), { name: 'values.yaml', text: bomb }])).toMatch(/demasiados alias YAML/);
    expect(fail([...only(chart()), { name: 'values.yaml', text: `x: ${'a'.repeat(33 * 1024 * 1024)}` }])).toMatch(/demasiado grande/);
  });
});

describe('importar Helm: detección del formato', () => {
  it('reconoce un Chart.yaml de la versión 1 o 2 y nada más', () => {
    expect(looksLikeHelmChart(read('tienda/Chart.yaml'))).toBe(true);
    expect(looksLikeHelmChart(read('legado/Chart.yaml'))).toBe(true);
    expect(looksLikeHelmChart(`﻿${read('tienda/Chart.yaml').replace(/\n/g, '\r\n')}`)).toBe(true);
    for (const text of [
      read('tienda/values.yaml'),
      read('legado/requirements.yaml'),
      read('tienda-renderizado.yaml'),
      'apiVersion: apps/v1\nkind: Deployment\nname: x\nversion: 1\n',
      'apiVersion: v1\nkind: Service\nname: x\nversion: 1\n',
      'apiVersion: v3\nname: x\nversion: 1.0.0\n',
      'name: x\nversion: 1.0.0\n',
      'apiVersion: v2\nversion: 1.0.0\n',
      '{"apiVersion":"v2","name":"x","version":"1.0.0"}',
      '',
      'hola',
    ]) {
      expect(looksLikeHelmChart(text), text.slice(0, 50)).toBe(false);
    }
    expect(looksLikeHelmChart(readFileSync('tests/fixtures/importar/cloudformation/tienda-aws.yaml', 'utf8'))).toBe(false);
  });

  it('un manifiesto de Kubernetes, una plantilla de CloudFormation y Terraform no se toman por Helm, ni al revés', () => {
    expect(looksLikeKubernetes(read('tienda/Chart.yaml'))).toBe(false);
    expect(looksLikeKubernetes(read('tienda-renderizado.yaml'))).toBe(true);
    expect(looksLikeCloudFormation(read('tienda/Chart.yaml'))).toBe(false);
    expect(looksLikeTerraform(read('tienda/Chart.yaml'))).toBe(false);
  });

  it('el módulo elige Helm para Chart.yaml, Kubernetes para lo renderizado y CloudFormation para sus plantillas, con la misma extensión', async () => {
    const registry = new ModuleRegistry().register(platformModule);
    const pick = (file: string | undefined, text: string): string | undefined => registry.detectImporter<PlatformDocument>('platform', file, text)?.id;
    expect(pick('Chart.yaml', read('tienda/Chart.yaml'))).toBe('helm');
    expect(pick('Chart.yml', read('legado/Chart.yaml'))).toBe('helm');
    expect(pick(undefined, read('tienda/Chart.yaml'))).toBe('helm');
    expect(pick('render.yaml', read('tienda-renderizado.yaml'))).toBe('kubernetes');
    expect(pick('plantilla.yaml', readFileSync('tests/fixtures/importar/cloudformation/tienda-aws.yaml', 'utf8'))).toBe('cloudformation');
    // la misma ruta que usan el CLI y el banco de trabajo
    const imported = await importText(platformModule, read('tienda/Chart.yaml'), undefined, { file: `${HELM}/tienda/Chart.yaml` });
    expect(imported.importer).toBe('helm');
    expect((imported.document as PlatformDocument).services[0].name).toBe('tienda');
    await expect(importText(platformModule, 'apiVersion: v2\nname: [x\n', 'helm')).rejects.toThrow(/no es YAML válido/);
  });
});

describe('importar Helm: la carpeta del chart y la salida de helm template', () => {
  it('importFiles lee la carpeta del chart como un solo chart (Chart.yaml, values.yaml y requirements.yaml juntos, sin importar el orden)', async () => {
    const forward = await importFiles(platformModule, tienda(), undefined, { file: `${HELM}/tienda` });
    const reversed = await importFiles(platformModule, [...tienda()].reverse(), undefined, { file: `${HELM}/tienda` });
    expect(forward.importer).toBe('helm');
    expect(reversed.document).toEqual(forward.document);
    expect(forward.document).toEqual(fromHelm(tienda(), { file: `${HELM}/tienda` }).document);
    const old = await importFiles(platformModule, legado(), 'helm', { file: `${HELM}/legado` });
    expect(deps(old.document as PlatformDocument)).toEqual(['data blog mariadb', 'data blog memcached']);
  });

  it('un Chart.yaml solo, como carpeta de un archivo, también funciona', async () => {
    const one = await importFiles(platformModule, [{ name: 'Chart.yaml', text: read('legado/Chart.yaml') }], undefined, { fallbackName: 'Chart.yaml' });
    expect(one.importer).toBe('helm');
    expect((one.document as PlatformDocument).services.map((s) => s.id)).toEqual(['servicio-blog']);
  });

  it('la salida de helm template es Kubernetes: el importador de Kubernetes la lee entera, con el chart como nombre y sin leer el Secret', async () => {
    const rendered = read('tienda-renderizado.yaml');
    const result = await importText(platformModule, rendered, undefined, {});
    expect(result.importer).toBe('kubernetes');
    const doc = result.document as PlatformDocument;
    expect(doc.workspace.name).toBe('tienda');
    expect(doc.environments[0]).toMatchObject({ name: 'tienda', description: 'Entorno deducido del chart de Helm «tienda».' });
    expect(doc.resources.map((r) => `${r.id}:${r.kind}`)).toEqual(['kubernetes:cluster', 'tienda-postgresql:database', 'tienda-redis-master:cache', 'tienda-datos:storage', 'secret-tienda-postgresql:secret-store', 'ingress-tienda:gateway']);
    expect(JSON.stringify(result)).not.toContain('no-copiar-esta-clave');
    expect(validatePlatformDocument(doc).ok).toBe(true);
    // con un nombre de archivo descriptivo manda el archivo, como siempre
    const named = await importText(platformModule, rendered, undefined, { fallbackName: 'tienda-renderizado.yaml' });
    expect((named.document as PlatformDocument).workspace.name).toBe('tienda-renderizado');
  });
});
