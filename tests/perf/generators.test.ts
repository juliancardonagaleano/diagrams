import { describe, expect, it } from 'vitest';
import { c4Module } from '@iark/domain-c4';
import { dataModule } from '@iark/domain-data';
import { enterpriseModule } from '@iark/domain-enterprise';
import { integrationModule } from '@iark/domain-integration';
import { platformModule } from '@iark/domain-platform';
import { securityModule } from '@iark/domain-security';
import type { DomainModule, EditorSpec } from '@iark/kernel';
import { generateDocument, PERF_MODULES, PERF_SIZES, seeded, type PerfModuleId } from './generators';

/**
 * Los generadores de diagramas grandes sirven a las medidas de `npm run perf` y a las pruebas del lienzo con muchos nodos: tienen
 * que dar siempre el mismo documento, que el módulo lo acepte y que la vista dibuje un número de nodos cercano al pedido.
 * Aquí se prueban con tamaños pequeños (rápido); el script de medición usa los grandes.
 */
const MODULES: Record<PerfModuleId, DomainModule<never>> = {
  c4: c4Module as DomainModule<never>,
  integration: integrationModule as DomainModule<never>,
  data: dataModule as DomainModule<never>,
  enterprise: enterpriseModule as DomainModule<never>,
  platform: platformModule as DomainModule<never>,
  security: securityModule as DomainModule<never>,
};

/** Módulos cuya vista medida tiene nodos dentro de otros (sistema con su API, base con sus tablas, red con sus recursos…). */
const NESTED: PerfModuleId[] = ['integration', 'data', 'platform', 'security'];

describe('seeded', () => {
  it('repite la misma secuencia con la misma semilla y cambia con otra', () => {
    const a = seeded(7);
    const b = seeded(7);
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect(first.every((n) => n >= 0 && n < 1)).toBe(true);
    expect([seeded(8)(), seeded(8)()]).not.toEqual([first[0], first[1]]);
  });
});

describe('generateDocument', () => {
  it('cubre los seis módulos y los tamaños de la medición', () => {
    expect([...PERF_MODULES].sort()).toEqual(['c4', 'data', 'enterprise', 'integration', 'platform', 'security']);
    expect([...PERF_SIZES]).toEqual([100, 500, 1000, 2000]);
  });

  it.each(PERF_MODULES)('%s: el mismo tamaño y semilla dan el mismo documento; otra semilla, otro', (moduleId) => {
    const a = JSON.stringify(generateDocument(moduleId, 80, 1));
    expect(JSON.stringify(generateDocument(moduleId, 80, 1))).toBe(a);
    expect(JSON.stringify(generateDocument(moduleId, 80, 2))).not.toBe(a);
  });

  it.each(PERF_MODULES.filter((m) => m !== 'c4'))('%s: es un documento válido del módulo y su vista dibuja unos 200 nodos con relaciones', (moduleId) => {
    const generated = generateDocument(moduleId, 200);
    const module = MODULES[moduleId];
    const parsed = module.schema.safeParse(generated.document);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 2))).toBe(true);
    if (!parsed.success) return;
    expect(module.validate(parsed.data).filter((issue) => issue.severity === 'error')).toEqual([]);
    const graph = (module.editor as unknown as EditorSpec<unknown>).project(parsed.data, generated.viewId);
    expect(graph.nodes.length).toBeGreaterThanOrEqual(170);
    expect(graph.nodes.length).toBeLessThanOrEqual(270);
    expect(graph.edges.length).toBeGreaterThan(graph.nodes.length / 3);
    const ids = new Set(graph.nodes.map((n) => n.id));
    expect(ids.size, 'ids de nodo únicos').toBe(graph.nodes.length);
    expect(graph.edges.every((e) => ids.has(e.source) && ids.has(e.target)), 'toda arista une dos nodos dibujados').toBe(true);
    if (NESTED.includes(moduleId)) expect(graph.nodes.some((n) => n.parentId), 'hay nodos anidados').toBe(true);
  });

  it('c4: es un documento válido con un solo límite (el sistema) y tantos elementos en la vista como se piden', () => {
    const generated = generateDocument('c4', 120);
    const parsed = c4Module.schema.safeParse(generated.document);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 2))).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.views).toHaveLength(1);
    expect(parsed.data.views[0].elements).toHaveLength(119); // el sistema es el límite, no un elemento de la vista
    expect(parsed.data.model.relationships.length).toBeGreaterThan(119);
  });
});
