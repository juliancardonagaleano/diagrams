import { describe, expect, it } from 'vitest';
import example from '../../../examples/plataforma-ejemplo.json';
import { platformEditor } from './editor';
import { platformModule } from './module';
import type { PlatformDocument } from './types';

const doc = platformModule.schema.parse(example) as PlatformDocument;
const valid = (d: PlatformDocument): boolean => platformModule.schema.safeParse(d).success;

describe('editor de plataforma', () => {
  it('la vista de un entorno anida redes, anfitriones e instancias, con la red coloreada por exposición', () => {
    const g = platformEditor.project(doc, 'env:prod');
    expect(g.nodes.find((n) => n.id === 'subred-publica')).toMatchObject({ kind: 'network', parentId: 'vpc-prod', fill: '#e03131' });
    expect(g.nodes.find((n) => n.id === 'k8s-prod')).toMatchObject({ kind: 'cluster', parentId: 'subred-apps' });
    expect(g.nodes.find((n) => n.id === 'i:pedidos-prod')).toMatchObject({ kind: 'service', parentId: 'k8s-prod', label: 'Servicio de pedidos' });
    expect(g.nodes.find((n) => n.id === 'pedidos-db-prod')).toMatchObject({ kind: 'database', ref: 'urn:iark:integration:pedidos-db' });
    expect(g.nodes.find((n) => n.id === 'pasarela-pagos')).toMatchObject({ kind: 'external', dashed: true });
  });

  it('la topología es plana y la entrega dibuja cada pipeline como zona con sus pasos', () => {
    const topo = platformEditor.project(doc, 'topology');
    expect(topo.nodes.every((n) => n.parentId === undefined)).toBe(true);
    expect(topo.edges.find((e) => e.id === 'd:web-pedidos')).toMatchObject({ kind: 'calls', source: 'tienda-web', target: 'pedidos' });
    const delivery = platformEditor.project(doc, 'delivery');
    expect(delivery.nodes.find((n) => n.id === 'p:infraestructura')).toMatchObject({ kind: 'pipeline' });
    expect(delivery.nodes.filter((n) => n.parentId === 'p:entrega-servicios' && n.kind === 'step').length).toBe(3);
    expect(delivery.edges.some((e) => e.id === 'p:infraestructura:out:k8s-prod')).toBe(true);
  });

  it('«corre en» crea un despliegue en el entorno del anfitrión y las dependencias se crean entre lo que hay detrás de cada nodo', () => {
    expect(platformEditor.canConnect!(doc, 'runs-on', 'reportes', 'pedidos-db-prod')).toMatch(/clúster o máquina/);
    expect(platformEditor.canConnect!(doc, 'runs-on', 'pasarela-pagos', 'k8s-prod')).toMatch(/externo/);
    const dev = platformEditor.addNode(doc, 'cluster', 'Clúster batch', undefined, 'env:dev');
    if (!dev.ok) throw new Error(dev.reason);
    expect(dev.document.resources.find((r) => r.id === dev.id)).toMatchObject({ kind: 'cluster', environmentId: 'dev' });
    const deployed = platformEditor.addEdge(dev.document, 'runs-on', 'reportes', dev.id!);
    if (!deployed.ok) throw new Error(deployed.reason);
    expect(deployed.document.deployments.find((d) => d.serviceId === 'reportes' && d.hostId === dev.id)).toMatchObject({ environmentId: 'dev' });
    expect(valid(deployed.document)).toBe(true);
    // Desde la instancia de un servicio en la vista de entorno se depende del servicio real.
    const dep = platformEditor.addEdge(deployed.document, 'messages', 'i:reportes-prod', 'kafka-prod');
    if (!dep.ok) throw new Error(dep.reason);
    expect(dep.document.dependencies[dep.document.dependencies.length - 1]).toMatchObject({ sourceId: 'reportes', targetId: 'kafka-prod', kind: 'messages' });
    expect(platformEditor.canConnect!(dep.document, 'messages', 'reportes', 'kafka-prod')).toMatch(/ya existe/);
    expect(valid(dep.document)).toBe(true);
  });

  it('un servicio añadido en la vista de un entorno nace desplegado en el anfitrión elegido; borrarlo arrastra despliegues, dependencias y pipelines', () => {
    const added = platformEditor.addNode(doc, 'worker', 'Conciliador', 'k8s-prod', 'env:prod');
    if (!added.ok) throw new Error(added.reason);
    expect(added.document.services.find((s) => s.id === added.id)).toMatchObject({ kind: 'worker' });
    expect(added.document.deployments.find((d) => d.serviceId === added.id)).toMatchObject({ hostId: 'k8s-prod', environmentId: 'prod' });
    const flow = platformEditor.addEdge(added.document, 'flow', added.id!, 'p:entrega-servicios:build');
    if (!flow.ok) throw new Error(flow.reason);
    expect(flow.document.pipelines[0].serviceIds).toContain(added.id);
    expect(valid(flow.document)).toBe(true);
    const removed = platformEditor.remove(flow.document, added.id!);
    if (!removed.ok) throw new Error(removed.reason);
    expect(removed.document.deployments.some((d) => d.serviceId === added.id)).toBe(false);
    expect(removed.document.pipelines[0].serviceIds).not.toContain(added.id);
    expect(valid(removed.document)).toBe(true);
  });

  it('las propiedades editan un recurso con validación de red y entorno, una instancia con réplicas numéricas y un pipeline con sus etapas como texto', () => {
    expect(platformEditor.update(doc, 'k8s-prod', { networkId: 'vpc-dev' })).toMatchObject({ ok: false });
    const res = platformEditor.update(doc, 'k8s-prod', { status: 'decommissioned', iac: false, version: '1.30' });
    if (!res.ok) throw new Error(res.reason);
    expect(res.document.resources.find((r) => r.id === 'k8s-prod')).toMatchObject({ status: 'decommissioned', version: '1.30' });
    expect(res.document.resources.find((r) => r.id === 'k8s-prod')?.iac).toBeUndefined();
    const inst = platformEditor.update(doc, 'i:pedidos-prod', { replicas: '5' });
    expect(inst.ok && inst.document.deployments.find((d) => d.id === 'pedidos-prod')?.replicas).toBe(5);
    expect(platformEditor.update(doc, 'x:pedidos-prod', { replicas: 'muchas' })).toMatchObject({ ok: false });
    expect(platformEditor.read(doc, 'p:entrega-servicios:s1')?.values.stages).toEqual(['dev', 'prod*']);
    const pipe = platformEditor.update(doc, 'p:entrega-servicios', { stages: ['prod*'] });
    if (!pipe.ok) throw new Error(pipe.reason);
    expect(pipe.document.pipelines[0].stages).toEqual([{ environmentId: 'prod', approval: true }]);
    expect(platformEditor.update(doc, 'p:entrega-servicios', { stages: ['qa'] })).toMatchObject({ ok: false });
    expect(valid(pipe.document)).toBe(true);
    // Quitar una red sube sus recursos a la red que la contenía.
    const net = platformEditor.remove(doc, 'subred-datos');
    expect(net.ok && net.document.resources.find((r) => r.id === 'pedidos-db-prod')?.networkId).toBe('vpc-prod');
    expect(net.ok && valid(net.document)).toBe(true);
  });

  describe('equivalente en otro entorno (counterpartOf)', () => {
    const select = (id: string, values?: Record<string, unknown>) => {
      const node = platformEditor.read(doc, id)!;
      return platformEditor.fields({ type: 'node', kind: node.kind, id }, doc, values ?? node.values).find((f) => f.key === 'counterpartOf')!;
    };

    it('el recurso ofrece un selector con los recursos de los demás entornos, los de su clase primero, y no el propio entorno', () => {
      const field = select('kafka-dev');
      expect(field).toMatchObject({ label: 'Equivalente en otro entorno', type: 'select', allowEmpty: true });
      if (field.type !== 'select') throw new Error('no es un selector');
      const values = field.options.map((o) => o.value);
      expect(values).not.toContain('kafka-dev');
      expect(values.some((v) => doc.resources.find((r) => r.id === v)?.environmentId === 'dev')).toBe(false);
      expect(field.options[0]).toEqual({ value: 'kafka-prod', label: 'Kafka (prod) (Producción)' });
      // Un servicio o una red no lo tienen.
      expect(platformEditor.fields({ type: 'node', kind: 'service' }, doc, {}).some((f) => f.key === 'counterpartOf')).toBe(false);
    });

    it('elegir un equivalente lo guarda y vaciarlo lo quita; la pista dice quién declara a este recurso como suyo', () => {
      const set = platformEditor.update(doc, 'pedidos-db-dev', { counterpartOf: 'kafka-prod' });
      if (!set.ok) throw new Error(set.reason);
      expect(set.document.resources.find((r) => r.id === 'pedidos-db-dev')?.counterpartOf).toBe('kafka-prod');
      expect(valid(set.document)).toBe(true);
      const cleared = platformEditor.update(set.document, 'pedidos-db-dev', { counterpartOf: '' });
      if (!cleared.ok) throw new Error(cleared.reason);
      expect(cleared.document.resources.find((r) => r.id === 'pedidos-db-dev')).not.toHaveProperty('counterpartOf');
      const declared = { ...doc, resources: doc.resources.map((r) => (r.id === 'kafka-prod' ? { ...r, counterpartOf: 'kafka-dev' } : r)) };
      const node = platformEditor.read(declared, 'kafka-dev')!;
      const hint = platformEditor.fields({ type: 'node', kind: node.kind, id: 'kafka-dev' }, declared, node.values).find((f) => f.key === 'counterpartOf')!.hint;
      expect(hint).toContain('Lo declaran como suyo: Kafka (prod) (Producción).');
    });

    it('rechaza un equivalente que no existe, que es del mismo entorno o que haría ambigua la equivalencia, pero tolera lo que ya estaba mal', () => {
      expect(platformEditor.update(doc, 'kafka-dev', { counterpartOf: 'fantasma' })).toMatchObject({ ok: false, reason: expect.stringMatching(/inexistente/) });
      expect(platformEditor.update(doc, 'kafka-dev', { counterpartOf: 'k8s-dev' })).toMatchObject({ ok: false, reason: expect.stringMatching(/mismo entorno/) });
      expect(platformEditor.update(doc, 'kafka-dev', { counterpartOf: 'kafka-dev' })).toMatchObject({ ok: false });
      // Dos recursos de desarrollo no pueden ser a la vez el equivalente de la misma cola de producción.
      const first = platformEditor.update(doc, 'kafka-dev', { counterpartOf: 'kafka-prod' });
      if (!first.ok) throw new Error(first.reason);
      expect(platformEditor.update(first.document, 'pedidos-db-dev', { counterpartOf: 'kafka-prod' })).toMatchObject({ ok: false, reason: expect.stringMatching(/ambigua/) });
      // Mover un recurso al entorno de su equivalente también rompe la equivalencia.
      expect(platformEditor.update(first.document, 'kafka-dev', { environmentId: 'prod', networkId: '' })).toMatchObject({ ok: false, reason: expect.stringMatching(/mismo entorno/) });
      // Un documento que ya incumple una regla sigue pudiendo editarse en lo demás.
      const broken = { ...doc, resources: doc.resources.map((r) => (r.id === 'kafka-dev' ? { ...r, counterpartOf: 'fantasma' } : r)) };
      expect(platformEditor.update(broken, 'kafka-dev', { description: 'cola de pruebas' })).toMatchObject({ ok: true });
    });

    it('quitar un recurso arrastra su equivalencia: el que lo declaraba pasa a declarar al siguiente de la cadena', () => {
      const chain = {
        ...doc,
        environments: [...doc.environments, { id: 'stg', name: 'Preproducción', kind: 'staging' as const }],
        resources: [
          ...doc.resources.map((r) => (r.id === 'kafka-prod' ? { ...r, counterpartOf: 'kafka-stg' } : r)),
          { id: 'kafka-stg', name: 'Mensajería', kind: 'queue' as const, environmentId: 'stg', counterpartOf: 'kafka-dev' },
        ],
      };
      expect(valid(chain)).toBe(true);
      const middle = platformEditor.remove(chain, 'kafka-stg');
      if (!middle.ok) throw new Error(middle.reason);
      expect(middle.document.resources.find((r) => r.id === 'kafka-prod')?.counterpartOf).toBe('kafka-dev');
      expect(valid(middle.document)).toBe(true);
      // Quitar el entorno entero hace lo mismo.
      const environment = platformEditor.remove(chain, 'stg');
      if (!environment.ok) throw new Error(environment.reason);
      expect(environment.document.resources.find((r) => r.id === 'kafka-prod')?.counterpartOf).toBe('kafka-dev');
      expect(valid(environment.document)).toBe(true);
      // Quitar un extremo deja al que lo declaraba sin enlace en vez de apuntar a la nada.
      const end = platformEditor.remove(chain, 'kafka-dev');
      if (!end.ok) throw new Error(end.reason);
      expect(end.document.resources.find((r) => r.id === 'kafka-stg')).not.toHaveProperty('counterpartOf');
      expect(valid(end.document)).toBe(true);
    });
  });
});
