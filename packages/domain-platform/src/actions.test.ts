import { describe, expect, it } from 'vitest';
import example from '../../../examples/plataforma-ejemplo.json';
import { compareEnvironments } from './compare';
import { costsByEnvironment, formatCost } from './costs';
import { parseScale } from './actions';
import { platformEditor } from './editor';
import { platformModule } from './module';
import { buildScene, toSvg } from './export/render';
import { toDrawio } from './export/drawio';
import type { PlatformDocument } from './types';
import { findView, listViews } from './views';

const doc = platformModule.schema.parse(example) as PlatformDocument;
const valid = (d: PlatformDocument): boolean => platformModule.schema.safeParse(d).success;
const action = (id: string) => platformEditor.actions!.find((a) => a.id === id)!;

describe('acciones sobre la selección', () => {
  it('«Promover a otro entorno» propone el siguiente entorno, despliega con la versión y pasa la versión si ya corre allí', () => {
    const promote = action('promote-environment');
    expect(promote.prompt!.initial!(doc, ['i:pedidos-dev'])).toBe('Producción');
    expect(promote.disabled!(doc, ['subred-publica'])).toMatch(/instancias/);
    // Ya corre en producción: solo se promociona la versión (3.1.0), sin crear otro despliegue.
    const same = promote.run(doc, ['i:pedidos-dev'], 'prod');
    if (!same.ok) throw new Error(same.reason);
    expect(same.document.deployments.find((d) => d.id === 'pedidos-prod')).toMatchObject({ version: '3.1.0', replicas: 3 });
    expect(same.document.deployments.length).toBe(doc.deployments.length);
    // Un servicio que solo corre en desarrollo se despliega en el clúster de producción (por nombre de entorno, sin distinguir mayúsculas).
    const onlyDev = { ...doc, deployments: doc.deployments.filter((d) => d.id !== 'reportes-prod') };
    const created = promote.run(onlyDev, ['i:reportes-dev'], 'producción');
    if (!created.ok) throw new Error(created.reason);
    expect(created.document.deployments.find((d) => d.serviceId === 'reportes' && d.environmentId === 'prod')).toMatchObject({ hostId: 'k8s-prod', version: '0.4.0' });
    expect(valid(created.document)).toBe(true);
    // Un clúster seleccionado lleva todo lo que aloja.
    const all = promote.run(doc, ['k8s-dev'], 'prod');
    if (!all.ok) throw new Error(all.reason);
    expect(all.document.deployments.find((d) => d.id === 'tienda-web-prod')?.version).toBe('2.4.0');
    expect(promote.run(doc, ['i:pedidos-prod'], 'prod')).toMatchObject({ ok: false });
    expect(promote.run(doc, ['i:pedidos-dev'], 'qa')).toMatchObject({ ok: false });
    const noHost = { ...doc, resources: doc.resources.filter((r) => r.id !== 'k8s-prod'), deployments: doc.deployments.filter((d) => d.environmentId !== 'prod') };
    expect(promote.run(noHost, ['i:pedidos-dev'], 'prod')).toMatchObject({ ok: false, reason: expect.stringMatching(/no tiene clúster ni máquina/) });
  });

  it('«Promover a otro entorno» re-apunta las dependencias de recursos al equivalente del entorno destino', () => {
    const promote = action('promote-environment');
    const bare = { ...doc, deployments: doc.deployments.filter((d) => d.id !== 'reportes-prod'), dependencies: doc.dependencies.filter((d) => d.id !== 'reportes-db-p') };
    const result = promote.run(bare, ['i:reportes-dev'], 'prod');
    if (!result.ok) throw new Error(result.reason);
    const added = result.document.dependencies.filter((d) => !bare.dependencies.some((x) => x.id === d.id));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ sourceId: 'reportes', targetId: 'pedidos-db-prod', kind: bare.dependencies.find((d) => d.id === 'reportes-db-d')!.kind });
    expect(result.document.dependencies.some((d) => d.id === 'reportes-db-d')).toBe(true);
    expect(valid(result.document)).toBe(true);
    // Promover de nuevo (o con la dependencia ya declarada) no duplica nada.
    const again = promote.run(result.document, ['i:reportes-dev'], 'prod');
    if (!again.ok) throw new Error(again.reason);
    expect(again.document.dependencies).toHaveLength(result.document.dependencies.length);
    // Sin recurso equivalente en el destino no se inventa ninguna dependencia.
    const noDb = { ...bare, resources: bare.resources.filter((r) => r.id !== 'pedidos-db-prod'), dependencies: bare.dependencies.filter((d) => d.targetId !== 'pedidos-db-prod') };
    const none = promote.run(noDb, ['i:reportes-dev'], 'prod');
    if (!none.ok) throw new Error(none.reason);
    expect(none.document.dependencies).toHaveLength(noDb.dependencies.length);
  });

  it('«Promover a otro entorno» re-apunta la dependencia al equivalente declarado (counterpartOf), aunque otro encajara mejor por nombre', () => {
    const promote = action('promote-environment');
    const withAnalytics = {
      ...doc,
      resources: [
        ...doc.resources.map((r) => (r.id === 'pedidos-db-dev' ? { ...r, counterpartOf: 'analitica-prod' } : r)),
        { id: 'analitica-prod', name: 'Almacén analítico', kind: 'database' as const, environmentId: 'prod', technology: 'Redshift' },
      ],
      deployments: doc.deployments.filter((d) => d.id !== 'reportes-prod'),
      dependencies: doc.dependencies.filter((d) => d.id !== 'reportes-db-p'),
    };
    expect(valid(withAnalytics)).toBe(true);
    const result = promote.run(withAnalytics, ['i:reportes-dev'], 'prod');
    if (!result.ok) throw new Error(result.reason);
    const added = result.document.dependencies.filter((d) => !withAnalytics.dependencies.some((x) => x.id === d.id));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ sourceId: 'reportes', targetId: 'analitica-prod' });
    expect(valid(result.document)).toBe(true);
    // También si lo declara el de destino, y un equivalente dado de baja no es destino de nada ni se sustituye por otro.
    const reverse = { ...withAnalytics, resources: withAnalytics.resources.map((r) => (r.id === 'pedidos-db-dev' ? { ...r, counterpartOf: undefined } : r.id === 'analitica-prod' ? { ...r, counterpartOf: 'pedidos-db-dev' } : r)) };
    const viaTarget = promote.run(reverse, ['i:reportes-dev'], 'prod');
    expect(viaTarget.ok && viaTarget.document.dependencies.some((d) => d.sourceId === 'reportes' && d.targetId === 'analitica-prod')).toBe(true);
    const retired = { ...withAnalytics, resources: withAnalytics.resources.map((r) => (r.id === 'analitica-prod' ? { ...r, status: 'decommissioned' as const } : r)) };
    const none = promote.run(retired, ['i:reportes-dev'], 'prod');
    if (!none.ok) throw new Error(none.reason);
    expect(none.document.dependencies).toHaveLength(retired.dependencies.length);
  });

  it('«Duplicar entorno» copia redes, recursos, instancias y las dependencias de los recursos, y añade la etapa a los pipelines', () => {
    const duplicate = action('duplicate-environment');
    expect(duplicate.disabled!(doc, ['tienda-web'])).toMatch(/Selecciona/);
    expect(duplicate.prompt!.initial!(doc, ['k8s-prod'])).toBe('Producción (copia)');
    const result = duplicate.run(doc, ['k8s-prod', 'i:pedidos-prod'], 'Preproducción');
    if (!result.ok) throw new Error(result.reason);
    const copy = result.document;
    const env = copy.environments.find((e) => e.name === 'Preproducción')!;
    expect(env.kind).toBeUndefined();
    expect(copy.resources.filter((r) => r.environmentId === env.id).length).toBe(doc.resources.filter((r) => r.environmentId === 'prod').length);
    expect(copy.networks.filter((n) => n.environmentId === env.id).length).toBe(4);
    const subnet = copy.networks.find((n) => n.environmentId === env.id && n.name === 'Subred pública')!;
    expect(copy.networks.find((n) => n.id === subnet.parentId)?.environmentId).toBe(env.id);
    expect(copy.deployments.filter((d) => d.environmentId === env.id).length).toBe(5);
    const db = copy.resources.find((r) => r.environmentId === env.id && r.kind === 'database')!;
    expect(db.ref).toBeUndefined();
    expect(copy.dependencies.some((d) => d.sourceId === 'pedidos' && d.targetId === db.id)).toBe(true);
    expect(copy.pipelines[0].stages.map((s) => s.environmentId)).toEqual(['dev', 'prod', env.id]);
    expect(copy.pipelines[0].stages[2]).toMatchObject({ approval: true });
    expect(copy.pipelines[1].provisions!.length).toBe(doc.pipelines[1].provisions!.length + 4);
    expect(valid(copy)).toBe(true);
    expect(duplicate.run(doc, ['k8s-prod'], 'Producción')).toMatchObject({ ok: false });
    expect(duplicate.run(doc, ['k8s-prod', 'k8s-dev'], 'X')).toMatchObject({ ok: false });
  });

  it('«Duplicar entorno» declara cada recurso copiado como equivalente (counterpartOf) del original y conserva las equivalencias del original', () => {
    const duplicate = action('duplicate-environment');
    // En producción, la base declara que su equivalente en desarrollo es la de dev (con otro nombre y sin que nada más las empareje).
    const declared = { ...doc, resources: doc.resources.map((r) => (r.id === 'pedidos-db-prod' ? { ...r, name: 'Almacén transaccional', counterpartOf: 'pedidos-db-dev' } : r)) };
    const result = duplicate.run(declared, ['k8s-prod'], 'Preproducción');
    if (!result.ok) throw new Error(result.reason);
    const copy = result.document;
    const env = copy.environments.find((e) => e.name === 'Preproducción')!;
    const copies = copy.resources.filter((r) => r.environmentId === env.id);
    expect(copies.length).toBeGreaterThan(0);
    // Cada copia apunta a su original, no al equivalente que el original tuviera en otro entorno.
    for (const r of copies) expect(declared.resources.find((o) => o.id === r.counterpartOf)).toMatchObject({ environmentId: 'prod' });
    expect(copies.find((r) => r.kind === 'database')?.counterpartOf).toBe('pedidos-db-prod');
    expect(valid(copy)).toBe(true);
    // Comparar la copia con su origen los empareja uno a uno por esa declaración, aunque se renombren.
    const renamed = { ...copy, resources: copy.resources.map((r) => (r.environmentId === env.id && r.kind === 'database' ? { ...r, name: 'Otra cosa', technology: 'MySQL' } : r)) };
    const comparison = compareEnvironments(renamed, 'prod', env.id);
    expect(comparison.resources.find((r) => r.a?.id === 'pedidos-db-prod')).toMatchObject({ b: { name: 'Otra cosa' }, matchedBy: 'declared' });
    // Y la copia sigue siendo equivalente de la base de desarrollo, por transitividad.
    expect(compareEnvironments(renamed, 'dev', env.id).resources.find((r) => r.a?.id === 'pedidos-db-dev')).toMatchObject({ b: { name: 'Otra cosa' }, matchedBy: 'declared' });
  });

  it('«Escalar réplicas» fija, suma, resta o multiplica y nunca baja de una réplica', () => {
    expect(parseScale('+2')).toEqual({ mode: 'add', amount: 2 });
    expect(parseScale('x3')).toEqual({ mode: 'mul', amount: 3 });
    expect(parseScale('mucho')).toBeUndefined();
    const scale = action('scale-replicas');
    const sum = scale.run(doc, ['i:pedidos-prod', 'i:tienda-web-prod'], '+2');
    if (!sum.ok) throw new Error(sum.reason);
    expect(sum.document.deployments.find((d) => d.id === 'pedidos-prod')?.replicas).toBe(5);
    expect(sum.document.deployments.find((d) => d.id === 'tienda-web-prod')?.replicas).toBe(4);
    // Sin réplicas declaradas cuenta como una.
    const fromDefault = scale.run(doc, ['i:reportes-prod'], 'x4');
    expect(fromDefault.ok && fromDefault.document.deployments.find((d) => d.id === 'reportes-prod')?.replicas).toBe(4);
    expect(scale.run(doc, ['i:pedidos-prod'], '-3')).toMatchObject({ ok: false });
    expect(scale.run(doc, ['i:pedidos-prod'], 'muchas')).toMatchObject({ ok: false });
    expect(scale.disabled!(doc, ['subred-datos'])).toMatch(/instancias/);
    const cluster = scale.run(doc, ['k8s-dev'], '2');
    expect(cluster.ok && cluster.document.deployments.filter((d) => d.environmentId === 'dev').every((d) => d.replicas === 2)).toBe(true);
  });

  it('«Puerta de aprobación» pide o quita la aprobación manual de las etapas seleccionadas', () => {
    const gate = action('toggle-approval');
    expect(gate.disabled!(doc, ['k8s-prod'])).toMatch(/etapas/);
    const on = gate.run(doc, ['p:entrega-servicios:s0'], undefined);
    if (!on.ok) throw new Error(on.reason);
    expect(on.document.pipelines[0].stages[0]).toMatchObject({ environmentId: 'dev', approval: true });
    const off = gate.run(on.document, ['p:entrega-servicios:s0', 'p:entrega-servicios:s1'], undefined);
    if (!off.ok) throw new Error(off.reason);
    expect(off.document.pipelines[0].stages.some((s) => s.approval)).toBe(false);
  });
});

describe('metadatos y costes', () => {
  it('suma el coste mensual por entorno y lo formatea con la moneda del espacio de trabajo', () => {
    const costs = costsByEnvironment(doc);
    expect(costs.map((c) => [c.environmentId, c.total])).toEqual([
      ['dev', 660],
      ['prod', 4420],
    ]);
    expect(formatCost(1850.5, doc)).toBe('1.850,5 USD/mes');
    expect(formatCost(90, { ...doc, workspace: { ...doc.workspace, currency: 'EUR' } })).toBe('90 EUR/mes');
  });

  it('la vista de costes agrupa recursos e instancias por entorno con su total y solo existe si hay costes', () => {
    expect(listViews(doc).map((v) => v.id)).toContain('costs');
    expect(listViews({ ...doc, resources: doc.resources.map(({ monthlyCost: _c, ...r }) => r), deployments: doc.deployments.map(({ monthlyCost: _c, ...d }) => d) }).map((v) => v.id)).not.toContain('costs');
    const scene = buildScene(doc, findView(doc, 'costs'));
    expect(scene.groups.get('c:prod')?.label).toBe('Producción · 4.420 USD/mes');
    expect(scene.nodes.get('k8s-prod')).toMatchObject({ groupId: 'c:prod' });
    expect(scene.nodes.get('k8s-prod')?.lines.join('|')).toContain('1.850 USD/mes (42 %)');
    expect(scene.nodes.get('i:pedidos-prod')?.groupId).toBe('c:prod');
    const graph = platformEditor.project(doc, 'costs');
    expect(graph.nodes.find((n) => n.id === 'c:prod')).toMatchObject({ kind: 'environment' });
    // Editar el grupo edita el entorno; borrarlo no lo borra.
    expect(platformEditor.update(doc, 'c:prod', { region: 'eu-south-1' })).toMatchObject({ ok: true });
    expect(platformEditor.remove(doc, 'c:prod')).toMatchObject({ ok: false });
  });

  it('el lienzo muestra insignias de coste, región, límites y SLO, y valida el coste', () => {
    const prod = platformEditor.project(doc, 'env:prod');
    expect(prod.nodes.find((n) => n.id === 'pedidos-db-prod')?.badges).toEqual(expect.arrayContaining(['1.240 USD/mes', 'CPU 16 · mem 128 GiB']));
    expect(prod.nodes.find((n) => n.id === 'i:pedidos-prod')?.badges).toEqual(expect.arrayContaining(['SLO 99,95 % · SLA 99,9 %', 'CPU 2 · mem 4 GiB', '310 USD/mes']));
    expect(prod.nodes.find((n) => n.id === 'k8s-prod')?.label).toContain('1.850 USD/mes');
    expect(platformEditor.update(doc, 'lb-prod', { monthlyCost: '-5' })).toMatchObject({ ok: false });
    const set = platformEditor.update(doc, 'lb-prod', { monthlyCost: '75.5', region: 'eu-west-3' });
    expect(set.ok && set.document.resources.find((r) => r.id === 'lb-prod')).toMatchObject({ monthlyCost: 75.5, region: 'eu-west-3' });
    expect(platformEditor.fields({ type: 'node', kind: 'database' }, doc).map((f) => f.key)).toEqual(expect.arrayContaining(['monthlyCost', 'region', 'cpuLimit', 'memoryLimit']));
    expect(platformEditor.fields({ type: 'node', kind: 'service' }, doc).map((f) => f.key)).toEqual(expect.arrayContaining(['slo', 'sla']));
  });
});

describe('figuras de infraestructura y zonas por exposición', () => {
  it('cada recurso lleva su figura en lienzo y SVG y las redes se colorean y trazan según su exposición', async () => {
    const shapes = Object.fromEntries(platformEditor.nodeKinds.map((k) => [k.kind, k.shape]));
    expect(shapes).toMatchObject({ cluster: 'cube', vm: 'monitor', database: 'cylinder', queue: 'pipe', 'load-balancer': 'diamond', gateway: 'chevron' });
    const graph = platformEditor.project(doc, 'env:prod');
    expect(graph.nodes.find((n) => n.id === 'subred-publica')).toMatchObject({ fill: '#e03131', border: 'solid' });
    expect(graph.nodes.find((n) => n.id === 'subred-apps')).toMatchObject({ border: 'dashed' });
    expect(graph.nodes.find((n) => n.id === 'subred-datos')).toMatchObject({ border: 'dotted' });
    const svg = await toSvg(doc, 'env:prod');
    expect(svg).toContain('stroke="#e03131" stroke-width="2"');
    expect(svg).toContain('stroke="#495057" stroke-width="2" stroke-dasharray="2 4"');
    const drawio = await toDrawio(doc);
    expect(drawio).toContain('strokeColor=#e03131');
    expect(drawio).toContain('dashPattern=1 4');
    expect(drawio).toContain('shape=cylinder3');
    expect(drawio).toContain('rhombus');
  });

  it('la etapa de entrega indica cuántos servicios llevan otra versión que en la etapa anterior', () => {
    const scene = buildScene(doc, findView(doc, 'delivery'));
    expect(scene.nodes.get('p:entrega-servicios:s1')?.lines).toEqual(['Producción', 'aprobación manual', '4 con versión distinta de Desarrollo']);
    expect(scene.nodes.get('p:entrega-servicios:s0')?.lines).toEqual(['Desarrollo']);
  });
});
