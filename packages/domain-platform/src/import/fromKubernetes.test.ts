import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toDrawio } from '../export/drawio';
import { toMermaid } from '../export/mermaid';
import { buildScene, toSvg } from '../export/render';
import { analyzePlatform } from '../issues';
import { platformModule } from '../module';
import { formatPlatformIssues, validatePlatformDocument } from '../schema';
import type { PlatformDocument } from '../types';
import { listViews } from '../views';
import { fromKubernetes, looksLikeKubernetes } from './fromKubernetes';
import { PlatformImportError } from './fromMermaid';

const DIR = 'tests/fixtures/importar/kubernetes';
const read = (name: string): string => readFileSync(`${DIR}/${name}`, 'utf8');
const load = (name: string) => fromKubernetes(read(name), { file: `${DIR}/${name}` });
const byId = <T extends { id: string }>(items: T[], id: string): T => {
  const found = items.find((i) => i.id === id);
  if (!found) throw new Error(`No hay «${id}» entre ${items.map((i) => i.id).join(', ')}`);
  return found;
};
const dep = (doc: PlatformDocument, source: string, target: string) => doc.dependencies.find((d) => d.sourceId === source && d.targetId === target);
const deployment = (doc: PlatformDocument, serviceId: string, environmentId?: string) => doc.deployments.find((d) => d.serviceId === serviceId && (environmentId === undefined || d.environmentId === environmentId));

/** Lo que se le pide a todo lo importado: documento válido, gobierno sin errores ni avisos y vistas que se dibujan (incluida la de despliegue de cada entorno). */
async function expectHealthy(doc: PlatformDocument): Promise<void> {
  const valid = validatePlatformDocument(doc);
  expect(valid.ok ? [] : formatPlatformIssues(valid.issues)).toEqual([]);
  expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  expect(analyzePlatform(doc).filter((i) => i.severity !== 'info')).toEqual([]);
  expect(platformModule.validate(doc).filter((i) => i.severity !== 'info')).toEqual([]);
  const views = listViews(doc);
  for (const env of doc.environments) expect(views.map((v) => v.id)).toContain(`env:${env.id}`);
  for (const view of views) {
    expect(toMermaid(doc, { viewId: view.id }).length).toBeGreaterThan(20);
    expect(await toDrawio(doc, view.id)).toContain('<mxfile');
    expect(await toSvg(doc, view.id)).toContain('<svg');
  }
  // Todo lo del entorno está dibujado en su vista: recursos (nodo o grupo) e instancias de servicio.
  for (const env of doc.environments) {
    const scene = buildScene(doc, views.find((v) => v.id === `env:${env.id}`)!);
    for (const r of doc.resources.filter((x) => x.environmentId === env.id)) expect(scene.nodes.has(r.id) || scene.groups.has(r.id)).toBe(true);
    for (const d of doc.deployments.filter((x) => x.environmentId === env.id)) expect(scene.nodes.has(`i:${d.id}`)).toBe(true);
  }
}

describe('Kubernetes: aplicación web con base de datos (kustomize build)', () => {
  const { document: doc, warnings } = load('tienda/manifests.yaml');

  it('el entorno sale de la etiqueta del Namespace y el nombre del sistema, de la carpeta', () => {
    expect(doc.workspace.name).toBe('tienda');
    expect(doc.environments).toEqual([expect.objectContaining({ id: 'production', name: 'production', kind: 'prod', provider: 'kubernetes' })]);
    expect(doc.environments[0].description).toMatch(/etiqueta de entorno/);
  });

  it('Deployment y CronJob son servicios con su despliegue (réplicas, versión de la imagen, límites)', () => {
    expect(doc.services.map((s) => [s.id, s.kind ?? 'service'])).toEqual([
      ['api', 'service'],
      ['web', 'frontend'],
      ['limpieza-carritos', 'job'],
    ]);
    expect(byId(doc.services, 'api')).toMatchObject({ owner: 'backend', tags: ['kubernetes', 'namespace:tienda'] });
    expect(byId(doc.services, 'api').description).toMatch(/registry\.example\.com\/tienda\/api:2\.4\.1/);
    expect(deployment(doc, 'api')).toMatchObject({ environmentId: 'production', hostId: 'kubernetes', version: '2.4.1', cpuLimit: '0.5', memoryLimit: '512 MiB' });
    expect(deployment(doc, 'web')).toMatchObject({ replicas: 2, version: '2.4.1' });
    expect(deployment(doc, 'limpieza-carritos')?.replicas).toBeUndefined();
    expect(byId(doc.services, 'limpieza-carritos').description).toContain('0 3 * * *');
  });

  it('el HPA fija las réplicas mínimas y deja el rango en la descripción', () => {
    expect(deployment(doc, 'api')?.replicas).toBe(3);
    expect(byId(doc.services, 'api').description).toMatch(/autoescalado 3–12 réplicas \(HPA «api»\)/);
  });

  it('una carga con imagen de almacén conocido es un recurso (base de datos, caché), no un servicio', () => {
    expect(byId(doc.resources, 'postgres')).toMatchObject({ kind: 'database', technology: 'PostgreSQL', version: '15.4' });
    expect(byId(doc.resources, 'redis')).toMatchObject({ kind: 'cache', technology: 'Redis', version: '7.2-alpine' });
    expect(doc.services.map((s) => s.id)).not.toContain('postgres');
  });

  it('PVC, ConfigMap, Secret e Ingress son recursos; el Ingress está en una red pública', () => {
    expect(byId(doc.resources, 'postgres-data')).toMatchObject({ kind: 'storage', technology: 'PersistentVolumeClaim' });
    expect(byId(doc.resources, 'postgres-data').description).toMatch(/50Gi.*gp3/);
    expect(byId(doc.resources, 'web-nginx')).toMatchObject({ kind: 'other', technology: 'ConfigMap' });
    expect(byId(doc.resources, 'db-credentials')).toMatchObject({ kind: 'secret-store' });
    expect(byId(doc.resources, 'kubernetes')).toMatchObject({ kind: 'cluster', name: 'Clúster Kubernetes' });
    expect(byId(doc.resources, 'tienda')).toMatchObject({ kind: 'namespace' });
    expect(byId(doc.resources, 'ingress-tienda')).toMatchObject({ kind: 'gateway', networkId: 'entrada-publica', technology: 'Ingress nginx' });
    expect(byId(doc.resources, 'ingress-tienda').description).toMatch(/tienda\.example\.com.*TLS/);
    expect(doc.networks).toEqual([expect.objectContaining({ id: 'entrada-publica', exposure: 'public' })]);
    // Lo que no está expuesto no cae en la red pública.
    for (const id of ['postgres', 'redis', 'postgres-data', 'db-credentials']) expect(byId(doc.resources, id).networkId).toBeUndefined();
  });

  it('las reglas del Ingress son dependencias hacia los servicios que resuelve por el Service', () => {
    expect(dep(doc, 'ingress-tienda', 'web')).toMatchObject({ kind: 'calls', protocol: 'HTTPS' });
    expect(dep(doc, 'ingress-tienda', 'api')?.description).toMatch(/tienda\.example\.com\/api/);
    expect(dep(doc, 'ingress-tienda', 'tienda-tls')).toMatchObject({ kind: 'data' });
  });

  it('las variables de entorno, los ConfigMap, los argumentos y los volúmenes dan dependencias con su origen', () => {
    expect(dep(doc, 'api', 'postgres')).toMatchObject({ kind: 'data', protocol: 'PostgreSQL' });
    expect(dep(doc, 'api', 'postgres')?.description).toMatch(/variable de entorno DATABASE_URL/i);
    expect(dep(doc, 'api', 'redis')).toMatchObject({ kind: 'data', protocol: 'Redis' });
    expect(dep(doc, 'api', 'redis')?.description).toMatch(/CACHE_URL.*ConfigMap «api-config»/);
    expect(dep(doc, 'web', 'api')).toMatchObject({ kind: 'calls', protocol: 'HTTP' });
    expect(dep(doc, 'web', 'api')?.description).toBe('Archivo default.conf del ConfigMap «web-nginx»');
    expect(dep(doc, 'limpieza-carritos', 'api')?.description).toMatch(/argumento/i);
    expect(dep(doc, 'postgres', 'postgres-data')).toMatchObject({ kind: 'data' });
    expect(dep(doc, 'web', 'web-nginx')).toBeDefined();
    expect(dep(doc, 'api', 'db-credentials')).toBeDefined();
    // Un Service sin consumidor no inventa dependencias.
    expect(dep(doc, 'redis', 'postgres')).toBeUndefined();
    for (const d of doc.dependencies) expect(d.description).toBeTruthy();
    for (const d of doc.dependencies) expect(d.description!.length).toBeLessThanOrEqual(80);
  });

  it('avisa del clúster implícito, de lo que no mapea, de los valores de Secret y de los hosts externos', () => {
    expect(warnings).toHaveLength(5);
    expect(warnings.join('\n')).toMatch(/no declaran el clúster/);
    expect(warnings.join('\n')).toMatch(/1 objeto de un kind sin mapear.*Certificate \(cert-manager\.io\)/);
    expect(warnings.join('\n')).toMatch(/2 objetos de soporte.*ServiceAccount, NetworkPolicy/);
    expect(warnings.join('\n')).toMatch(/2 valores vienen de un Secret y no se lee.*POSTGRES_PASSWORD \(postgres\), DB_PASSWORD \(api\)/);
    expect(warnings.join('\n')).toMatch(/1 host externo.*pagos\.example\.com \(api\)/);
  });

  it('NUNCA copia valores de un Secret (ni data, ni stringData) ni los de claves sensibles', () => {
    const text = read('tienda/manifests.yaml');
    for (const secret of ['UzNjcjN0LWs4cy1kby1ub3QtbGVhayE=', 'K8s-S3cr3t-do-not-leak!', 'YXBwX3VzZXI=', 'LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t']) {
      expect(text).toContain(secret);
      expect(JSON.stringify({ doc, warnings })).not.toContain(secret);
    }
    // Solo el tipo y los nombres de las claves.
    expect(byId(doc.resources, 'db-credentials').description).toBe('Secret · Opaque · namespace tienda · claves: username, password, connection-string');
  });

  it('es válido, pasa el gobierno sin errores ni avisos y se dibuja en la vista de despliegue del entorno', async () => {
    await expectHealthy(doc);
    expect(listViews(doc).map((v) => v.id)).toEqual(['topology', 'env:production']);
  });

  it('importar dos veces el mismo texto da el mismo documento (y el mismo orden de avisos)', () => {
    const again = load('tienda/manifests.yaml');
    expect(again.document).toEqual(doc);
    expect(again.warnings).toEqual(warnings);
  });

  it('el orden de los documentos no cambia lo importado', () => {
    const docs = read('tienda/manifests.yaml').split(/^---$/m).map((d) => d.trim()).filter(Boolean);
    const reordered = fromKubernetes([...docs].reverse().join('\n---\n'), { file: `${DIR}/tienda/manifests.yaml` }).document;
    const sorted = <T extends { id: string }>(items: T[]): T[] => [...items].sort((a, b) => a.id.localeCompare(b.id));
    expect(sorted(reordered.services)).toEqual(sorted(doc.services));
    expect(sorted(reordered.resources)).toEqual(sorted(doc.resources));
    expect(sorted(reordered.dependencies).map((d) => [d.sourceId, d.targetId, d.kind])).toEqual(sorted(doc.dependencies).map((d) => [d.sourceId, d.targetId, d.kind]));
  });
});

describe('Kubernetes: kind List de kubectl (con status, uid y resourceVersion)', () => {
  const { document: doc, warnings } = load('tienda-kubectl/get-all.yaml');

  it('aplana la lista e ignora los campos de estado', () => {
    expect(doc.services.map((s) => s.id)).toEqual(['blog']);
    expect(deployment(doc, 'blog')).toMatchObject({ replicas: 2, version: '5.82' });
    expect(byId(doc.resources, 'mysql')).toMatchObject({ kind: 'database', technology: 'MySQL', version: '8.0.36' });
  });

  it('sin etiquetas ni namespaces de entorno, el entorno lleva el nombre de la carpeta y se avisa', () => {
    expect(doc.environments).toEqual([expect.objectContaining({ id: 'tienda-kubectl', name: 'tienda-kubectl', provider: 'kubernetes' })]);
    expect(doc.environments[0].kind).toBeUndefined();
    expect(warnings.join('\n')).toMatch(/No se pudo deducir el entorno.*«tienda-kubectl»/);
  });

  it('un Service LoadBalancer es un balanceador en la red pública y enlaza por su selector', () => {
    expect(byId(doc.resources, 'lb-blog')).toMatchObject({ kind: 'load-balancer', networkId: 'entrada-publica', name: 'blog' });
    expect(dep(doc, 'lb-blog', 'blog')).toMatchObject({ kind: 'calls', protocol: 'HTTP' });
  });

  it('el host de una variable cuyo nombre lo dice (…__host) apunta al Service; una variable que no es un host no', () => {
    expect(dep(doc, 'blog', 'mysql')?.description).toMatch(/database__connection__host/);
    expect(dep(doc, 'blog', 'blog-db')).toBeDefined();
    expect(JSON.stringify(doc)).not.toContain('bGlzdGEtZGUtY29udHJhc2VuYXM');
  });

  it('es válido y se dibuja', async () => {
    await expectHealthy(doc);
  });
});

describe('Kubernetes: un namespace por entorno', () => {
  const { document: doc, warnings } = load('multi-entorno/entornos.yaml');

  it('cada namespace con nombre de entorno es un entorno, cada uno con su clúster implícito', () => {
    expect(doc.environments.map((e) => [e.id, e.kind])).toEqual([
      ['staging', 'staging'],
      ['production', 'prod'],
    ]);
    expect(doc.resources.filter((r) => r.kind === 'cluster').map((r) => [r.id, r.environmentId])).toEqual([
      ['kubernetes-staging', 'staging'],
      ['kubernetes-production', 'production'],
    ]);
    expect(warnings.join('\n')).toMatch(/un clúster por entorno/);
  });

  it('el mismo servicio en dos entornos es un servicio con un despliegue por entorno', () => {
    expect(doc.services.map((s) => s.id)).toEqual(['catalogo']);
    expect(deployment(doc, 'catalogo', 'staging')).toMatchObject({ replicas: 1, version: '3.1.0-rc2', hostId: 'kubernetes-staging' });
    expect(deployment(doc, 'catalogo', 'production')).toMatchObject({ replicas: 4, version: '3.0.2', hostId: 'kubernetes-production', cpuLimit: '1', memoryLimit: '1 GiB' });
  });

  it('los recursos con el mismo nombre en dos namespaces llevan el namespace en el id', () => {
    expect(doc.resources.filter((r) => r.kind === 'queue').map((r) => [r.id, r.environmentId, r.technology])).toEqual([
      ['rabbitmq-staging', 'staging', 'RabbitMQ'],
      ['rabbitmq-production', 'production', 'RabbitMQ'],
    ]);
    expect(dep(doc, 'catalogo', 'rabbitmq-staging')).toMatchObject({ kind: 'messages', protocol: 'AMQP' });
    expect(dep(doc, 'catalogo', 'rabbitmq-production')).toMatchObject({ kind: 'messages', protocol: 'AMQP' });
  });

  it('es válido, la promoción entre entornos no da avisos y se dibuja', async () => {
    await expectHealthy(doc);
    expect(listViews(doc).map((v) => v.id)).toEqual(expect.arrayContaining(['env:staging', 'env:production']));
  });
});

describe('Kubernetes: Gateway API, DaemonSet, ExternalName y un Service sin carga', () => {
  const { document: doc, warnings } = load('malla-gateway/gateway.yaml');

  it('el Gateway es una puerta pública y el HTTPRoute, sus dependencias hacia los Services de los backends', () => {
    expect(byId(doc.resources, 'publica')).toMatchObject({ kind: 'gateway', networkId: 'entrada-publica', technology: 'Gateway API istio' });
    expect(dep(doc, 'publica', 'pedidos')).toMatchObject({ kind: 'calls', protocol: 'HTTP' });
    expect(dep(doc, 'publica', 'pedidos')?.description).toMatch(/HTTPRoute «pedidos».*api\.example\.org.*\/pedidos/);
    expect(dep(doc, 'publica', 'facturas')?.description).toMatch(/\/facturas/);
  });

  it('un DaemonSet es un worker y un Service ExternalName, un servicio externo al que se llega por su nombre', () => {
    expect(byId(doc.services, 'recolector-logs')).toMatchObject({ kind: 'worker' });
    expect(byId(doc.services, 'pasarela-pagos')).toMatchObject({ external: true });
    expect(byId(doc.services, 'pasarela-pagos').description).toContain('pagos.proveedor.example.net');
    expect(deployment(doc, 'pasarela-pagos')).toBeUndefined();
    expect(dep(doc, 'pedidos', 'pasarela-pagos')).toMatchObject({ kind: 'calls', protocol: 'HTTP' });
    expect(dep(doc, 'pedidos', 'facturas')).toBeDefined();
  });

  it('avisa del Service que no selecciona nada y de los hosts externos, y no los importa como dependencias', () => {
    expect(warnings.join('\n')).toMatch(/Service «huerfano».*no selecciona ninguna carga.*app=no-existe/);
    expect(warnings.join('\n')).toMatch(/s3\.eu-west-1\.amazonaws\.com \(facturas\)/);
    expect(doc.dependencies.some((d) => d.targetId.includes('amazonaws'))).toBe(false);
  });

  it('es válido y se dibuja', async () => {
    await expectHealthy(doc);
  });
});

describe('Kubernetes: casos pequeños', () => {
  const deploymentYaml = (name: string, extra = '', ns = 'default') => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  namespace: ${ns}
spec:
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
    spec:
      containers:
        - name: ${name}
          image: ${name}:1.0
${extra}`;

  it('un Deployment suelto: servicio + despliegue en un clúster implícito y entorno por defecto con aviso', () => {
    const r = fromKubernetes(deploymentYaml('web'), { file: 'k8s/tienda-qa/all.yaml' });
    expect(r.document.workspace.name).toBe('tienda-qa');
    expect(r.document.environments).toEqual([expect.objectContaining({ id: 'tienda-qa', kind: 'test' })]);
    expect(r.document.services.map((s) => s.id)).toEqual(['web']);
    expect(r.document.deployments).toEqual([expect.objectContaining({ serviceId: 'web', hostId: 'kubernetes', replicas: 1, version: '1.0' })]);
    expect(r.warnings).toHaveLength(2);
  });

  it('replicas: 0 se importa sin réplicas y se avisa', () => {
    const r = fromKubernetes(deploymentYaml('web').replace('spec:\n  selector', 'spec:\n  replicas: 0\n  selector'));
    expect(r.document.deployments[0].replicas).toBeUndefined();
    expect(r.warnings.join('\n')).toMatch(/replicas: 0/);
    expect(validatePlatformDocument(r.document).ok).toBe(true);
  });

  it('una variable que apunta a un Service que no está en los manifiestos se avisa, no se inventa', () => {
    const r = fromKubernetes(deploymentYaml('api', '          env:\n            - name: DB_HOST\n              value: postgres.datos.svc.cluster.local\n            - name: LOG_LEVEL\n              value: debug\n'));
    expect(r.document.dependencies).toEqual([]);
    expect(r.warnings.join('\n')).toMatch(/No se pudo resolver 1 referencia.*postgres\.datos\.svc\.cluster\.local/);
  });

  it('localhost y las variables que no son hosts no generan dependencias ni avisos', () => {
    const r = fromKubernetes(deploymentYaml('api', '          env:\n            - name: DB_HOST\n              value: localhost\n            - name: MODE\n              value: worker\n            - name: PORT\n              value: "8080"\n'));
    expect(r.document.dependencies).toEqual([]);
    expect(r.warnings.join('\n')).not.toMatch(/referencia/);
  });

  it('acepta JSON (kubectl get -o json) y varios documentos en un mismo texto', () => {
    const json = JSON.stringify({
      apiVersion: 'v1',
      kind: 'List',
      items: [
        { apiVersion: 'apps/v1', kind: 'StatefulSet', metadata: { name: 'kafka', namespace: 'prod' }, spec: { replicas: 3, template: { spec: { containers: [{ name: 'kafka', image: 'bitnami/kafka:3.6' }] } } } },
        { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'ingesta', namespace: 'prod' }, spec: { template: { spec: { containers: [{ name: 'ingesta', image: 'ingesta:2', env: [{ name: 'KAFKA_BROKERS', value: 'kafka:9092' }] }] } } } },
        { apiVersion: 'v1', kind: 'Service', metadata: { name: 'kafka', namespace: 'prod' }, spec: { selector: { app: 'kafka' }, ports: [{ port: 9092 }] } },
      ],
    });
    expect(looksLikeKubernetes(json)).toBe(true);
    const r = fromKubernetes(json, { name: 'Ingesta' });
    expect(r.document.workspace.name).toBe('Ingesta');
    expect(byId(r.document.resources, 'kafka')).toMatchObject({ kind: 'queue', technology: 'Apache Kafka', version: '3.6' });
    expect(r.document.environments[0]).toMatchObject({ name: 'prod', kind: 'prod' });
  });

  it('un Service que se resuelve por selector y por nombre da la dependencia con el protocolo del puerto', () => {
    const yaml = `${deploymentYaml('front', '          env:\n            - name: API_URL\n              value: http://back:8080\n')}---
${deploymentYaml('back').replace('image: back:1.0', 'image: back:1.0\n          ports:\n            - containerPort: 8080')}---
apiVersion: v1
kind: Service
metadata:
  name: back
spec:
  selector:
    app: back
  ports:
    - port: 8080
`;
    const r = fromKubernetes(yaml);
    expect(dep(r.document, 'front', 'back')).toMatchObject({ kind: 'calls', protocol: 'HTTP' });
  });

  it('los kinds de soporte y los desconocidos se agrupan en un solo aviso cada uno', () => {
    const yaml = `${deploymentYaml('web')}---
apiVersion: v1
kind: ServiceAccount
metadata: { name: a }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: r }
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata: { name: m }
---
apiVersion: v1
kind: Pod
metadata: { name: p }
`;
    const r = fromKubernetes(yaml);
    const warnings = r.warnings.join('\n');
    expect(warnings).toMatch(/2 objetos de kinds sin mapear.*ServiceMonitor \(monitoring\.coreos\.com\), Pod/);
    expect(warnings).toMatch(/2 objetos de soporte.*ServiceAccount, Role/);
  });

  it('un documento sin metadata.name o sin kind se omite con aviso y el resto se importa', () => {
    const r = fromKubernetes(`${deploymentYaml('web')}---
apiVersion: v1
kind: ConfigMap
metadata: {}
---
foo: bar
---
# solo un comentario
`);
    expect(r.document.services.map((s) => s.id)).toEqual(['web']);
    expect(r.warnings.join('\n')).toMatch(/documento 2.*ConfigMap.*no tiene metadata\.name/);
    expect(r.warnings.join('\n')).toMatch(/documento 3.*no tiene apiVersion y kind/);
  });

  it('nunca desborda el tope de avisos con cientos de referencias sin resolver', () => {
    const envs = Array.from({ length: 200 }, (_, i) => `            - name: SVC_${i}_URL\n              value: http://nada-${i}.svc.cluster.local\n`).join('');
    const r = fromKubernetes(deploymentYaml('api', `          env:\n${envs}`));
    expect(r.warnings.length).toBeLessThanOrEqual(51);
    expect(validatePlatformDocument(r.document).ok).toBe(true);
  });
});

describe('Kubernetes: reconocimiento del formato', () => {
  it('detecta YAML de uno o varios documentos y JSON por apiVersion y kind', () => {
    expect(looksLikeKubernetes(read('tienda/manifests.yaml'))).toBe(true);
    expect(looksLikeKubernetes(read('tienda-kubectl/get-all.yaml'))).toBe(true);
    expect(looksLikeKubernetes('---\napiVersion: v1\nkind: Namespace\nmetadata:\n  name: x\n')).toBe(true);
    expect(looksLikeKubernetes('{"apiVersion":"v1","kind":"Namespace","metadata":{"name":"x"}}')).toBe(true);
  });

  it('no confunde Mermaid, Terraform, JSON ajeno ni otro YAML con Kubernetes', () => {
    expect(looksLikeKubernetes('flowchart LR\n  a --> b\n')).toBe(false);
    expect(looksLikeKubernetes(readFileSync('tests/fixtures/importar/terraform/aws-tienda/main.tf', 'utf8'))).toBe(false);
    expect(looksLikeKubernetes(readFileSync('tests/fixtures/importar/terraform/aws-tienda-dev/plan.json', 'utf8'))).toBe(false);
    expect(looksLikeKubernetes(readFileSync('examples/plataforma-ejemplo.json', 'utf8'))).toBe(false);
    expect(looksLikeKubernetes('name: ci\non: push\njobs: {}\n')).toBe(false);
    expect(looksLikeKubernetes('{"a": 1}')).toBe(false);
    expect(looksLikeKubernetes('')).toBe(false);
  });
});

describe('Kubernetes: la salida de helm template (el chart da nombre a lo importado)', () => {
  const rendered = readFileSync('tests/fixtures/importar/helm/tienda-renderizado.yaml', 'utf8');

  it('sin un nombre de archivo que diga algo (entrada estándar), el chart de la etiqueta helm.sh/chart nombra el espacio de trabajo y el entorno', () => {
    const { document: doc, warnings } = fromKubernetes(rendered);
    expect(doc.workspace.name).toBe('tienda');
    expect(doc.environments).toEqual([{ id: 'tienda', name: 'tienda', description: 'Entorno deducido del chart de Helm «tienda».', provider: 'kubernetes' }]);
    expect(warnings[0]).toBe('No se pudo deducir el entorno de las etiquetas ni de los namespaces: se crea el entorno «tienda» a partir del chart de Helm «tienda».');
  });

  it('un nombre de archivo descriptivo manda sobre el chart; uno genérico (rendered.yaml, stdin, helm) no', () => {
    expect(fromKubernetes(rendered, { file: '/tmp/tienda-renderizado.yaml' }).document.workspace.name).toBe('tienda-renderizado');
    expect(fromKubernetes(rendered, { fallbackName: 'tienda-renderizado.yaml' }).document.workspace.name).toBe('tienda-renderizado');
    for (const file of ['rendered.yaml', 'stdin', 'helm.yaml', '/charts/manifests/all.yaml']) {
      expect(fromKubernetes(rendered, { file }).document.workspace.name, file).toBe('tienda');
    }
  });

  it('options.chart manda sobre lo deducido de los manifiestos; options.name sobre todo', () => {
    expect(fromKubernetes(rendered, { chart: 'mi-chart' }).document.workspace.name).toBe('mi-chart');
    expect(fromKubernetes(rendered, { chart: 'mi-chart', name: 'Mi tienda' }).document.workspace.name).toBe('Mi tienda');
  });

  it('sin la etiqueta, el comentario «# Source:» que escribe Helm da el chart; una etiqueta con versión se recorta', () => {
    const sinEtiqueta = rendered.replace(/^ {4}helm\.sh\/chart: .*\n/gm, '');
    expect(sinEtiqueta).not.toContain('helm.sh/chart');
    expect(fromKubernetes(sinEtiqueta).document.workspace.name).toBe('tienda');
    const sinNada = sinEtiqueta.replace(/^# Source: .*\n/gm, '');
    expect(fromKubernetes(sinNada).document.workspace.name).toBe('Arquitectura de plataforma');
    const versiones: Array<[string, string]> = [['tienda-0.4.2', 'tienda'], ['mi-app-v1.2', 'mi-app'], ['web-2.0.0-rc.1', 'web'], ['sin-version', 'sin-version']];
    for (const [label, name] of versiones) {
      const text = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: x\n  labels:\n    helm.sh/chart: ${label}\nspec:\n  template:\n    spec:\n      containers:\n        - name: c\n          image: i:1\n`;
      expect(fromKubernetes(text).document.workspace.name, label).toBe(name);
    }
  });

  it('el Secret del chart no se lee y sus valores no salen; el resto del chart se importa entero', () => {
    const { document: doc, warnings } = fromKubernetes(rendered);
    expect(JSON.stringify({ doc, warnings })).not.toContain('no-copiar-esta-clave');
    expect(doc.services.map((s) => s.id)).toEqual(['deployment-tienda']);
    expect(doc.resources.map((r) => r.id)).toEqual(['kubernetes', 'tienda-postgresql', 'tienda-redis-master', 'tienda-datos', 'secret-tienda-postgresql', 'ingress-tienda']);
    expect(validatePlatformDocument(doc).ok).toBe(true);
  });
});

describe('Kubernetes: entradas rotas', () => {
  const fails = (text: string, message: RegExp): void => {
    expect(() => fromKubernetes(text)).toThrow(PlatformImportError);
    expect(() => fromKubernetes(text)).toThrow(message);
  };

  it('vacío o sin ningún objeto de Kubernetes', () => {
    fails('', /está vacío/);
    fails('   \n\n', /está vacío/);
    fails('# solo comentarios\n', /no contiene ningún objeto de Kubernetes/);
    fails('foo: bar\nbaz: 1\n', /no contiene ningún objeto de Kubernetes/);
    fails('hola mundo', /no contiene ningún objeto de Kubernetes/);
  });

  it('YAML roto dice la línea', () => {
    fails('apiVersion: v1\nkind: Namespace\nmetadata:\n\tname: x\n', /no es válido \(línea 4\): .*[Tt]ab/);
    fails('apiVersion: v1\nkind: Namespace\nmetadata:\n  name: [x\n', /no es válido \(línea \d+\): [^:]+\.$/);
    fails('apiVersion: apps/v1\nkind: Deployment\n  metadata:\n name: x\n', /no es válido \(línea \d+\)/);
  });

  it('una plantilla de Helm sin renderizar se explica', () => {
    fails('apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {{ .Release.Name }}\n', /no tiene metadata\.name.*plantilla de Helm.*helm template/);
    fails('apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: x\n  labels: {{ include "x" . }}: y\n  bad: [\n', /plantilla de Helm.*helm template/);
  });

  it('manifiestos sin nada que dibujar explican por qué', () => {
    fails('apiVersion: v1\nkind: ServiceAccount\nmetadata:\n  name: a\n', /no definen ninguna carga de trabajo ni recurso/);
    fails('apiVersion: v1\nkind: Service\nmetadata:\n  name: a\nspec:\n  selector:\n    app: a\n', /no definen ninguna carga de trabajo ni recurso/);
  });

  it('un texto de más de 32 MiB, un anidamiento de miles de niveles y una bomba de alias se rechazan con un error', () => {
    fails(`apiVersion: v1\nkind: Namespace\nmetadata:\n  name: x\n  annotations:\n    a: ${'x'.repeat(33 * 1024 * 1024)}\n`, /demasiado grande/);
    fails(`apiVersion: v1\nkind: Namespace\nmetadata:\n  name: x\n  labels: ${'['.repeat(20_000)}${']'.repeat(20_000)}\n`, /demasiado anidado|no es válido/);
    const bomb = ['a: &a [x, x, x, x, x, x, x, x, x]', ...'bcdefghij'.split('').map((k, i) => `${k}: &${k} [${Array.from({ length: 9 }, () => `*${'abcdefghi'[i]}`).join(', ')}]`), 'apiVersion: v1', 'kind: Namespace', 'metadata:', '  name: x', '  annotations: *j'].join('\n');
    fails(bomb, /demasiados alias YAML|demasiado anidado/);
  });

  it('no desborda con un documento enorme', () => {
    const doc = Array.from({ length: 300 }, (_, i) => `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: svc-${i}\nspec:\n  template:\n    spec:\n      containers:\n        - name: c\n          image: img:${i}\n`).join('---\n');
    const r = fromKubernetes(doc);
    expect(r.document.services).toHaveLength(300);
    expect(r.document.deployments).toHaveLength(300);
    expect(validatePlatformDocument(r.document).ok).toBe(true);
  });
});
