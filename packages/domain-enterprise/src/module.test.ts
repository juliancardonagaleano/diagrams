import { readFileSync } from 'node:fs';
import { buildManifest, carryRefs, ModuleError, ModuleRegistry } from '@iark/kernel';
import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { enterpriseAiSpec, generatedToEnterprise, toGenerated } from './ai/generation';
import { enterpriseCommands } from './commands';
import { toDrawio } from './export/drawio';
import { toMermaid } from './export/mermaid';
import { layoutCapabilityMap, toSvg } from './export/render';
import { applicationsByCapability, dependencyGraph, ownership, reach, unitTree } from './graph';
import { fromIntegrationJson } from './import/fromIntegration';
import { EnterpriseImportError, fromMermaid } from './import/fromMermaid';
import { analyzeEnterprise } from './issues';
import { enterpriseModule } from './module';
import { formatEnterpriseIssues, validateEnterpriseDocument } from './schema';
import { findView, listViews } from './views';
import { relationBetween, type EnterpriseDocument } from './types';

const example = JSON.parse(readFileSync('examples/empresa-arquitectura.json', 'utf8')) as unknown;
const parse = (input: unknown): EnterpriseDocument => {
  const r = validateEnterpriseDocument(input);
  if (!r.ok) throw new Error(formatEnterpriseIssues(r.issues));
  return r.document;
};
const doc = parse(example);
const TODAY = new Date('2026-06-15T00:00:00Z');
const messages = (d: EnterpriseDocument): string[] => analyzeEnterprise(d, { today: TODAY }).map((i) => i.message);

describe('esquema empresarial', () => {
  it('acepta el ejemplo y aplica valores por defecto', () => {
    expect(doc.capabilities).toHaveLength(16);
    expect(doc.applications).toHaveLength(11);
    expect(parse({}).workspace.name).toBe('Arquitectura empresarial');
    expect(parse({}).relations).toEqual([]);
  });

  it('rechaza ids repetidos entre tipos, jerarquías inválidas, responsables que no son unidades y URN inválidas', () => {
    const bad = {
      units: [{ id: 'u', name: 'U', parentId: 'u2' }, { id: 'u2', name: 'U2', parentId: 'u' }],
      capabilities: [
        { id: 'c', name: 'C', parentId: 'c' },
        { id: 'c1', name: 'C1', parentId: 'c2' },
        { id: 'c2', name: 'C2', parentId: 'c1', ownerId: 'a' },
        { id: 'c3', name: 'C3', parentId: 'u', ownerId: 'fantasma' },
        { id: 'c4', name: 'C4', parentId: 'nada', maturity: 6 },
      ],
      processes: [{ id: 'u', name: 'Repite el id de una unidad' }],
      applications: [{ id: 'a', name: 'A', ref: 'no-es-urn' }],
      technologies: [{ id: 't', name: 'T', endOfLife: '2030/01' }],
    };
    const r = validateEnterpriseDocument(bad);
    expect(r.ok).toBe(false);
    const text = r.ok ? '' : formatEnterpriseIssues(r.issues);
    for (const fragment of [
      'Id duplicado: "u" (ya lo usa unidad)',
      'no puede ser su propio padre',
      'La jerarquía de "c1" es circular',
      'La jerarquía de "u" es circular',
      'debe ser capacidad, pero "u" es unidad',
      'padre inexistente',
      'referencia una unidad inexistente: "fantasma"',
      'debe ser una unidad, pero "a" es aplicación',
      'URN válida',
      'AAAA-MM',
      'Too big',
    ]) {
      expect(text).toContain(fragment);
    }
  });

  it('valida los tipos de relación, los extremos y las repeticiones', () => {
    const base = {
      capabilities: [{ id: 'cap', name: 'Cap' }, { id: 'cap2', name: 'Cap2' }],
      processes: [{ id: 'proc', name: 'Proc' }],
      applications: [{ id: 'app', name: 'App' }, { id: 'app2', name: 'App2' }],
      technologies: [{ id: 'tech', name: 'Tech' }],
    };
    const r = validateEnterpriseDocument({
      ...base,
      relations: [
        { id: 'ok', kind: 'supports', sourceId: 'app', targetId: 'cap' },
        { id: 'dup', kind: 'supports', sourceId: 'app', targetId: 'cap' },
        { id: 'ok', kind: 'runs-on', sourceId: 'app', targetId: 'tech' },
        { id: 'al-reves', kind: 'supports', sourceId: 'cap', targetId: 'app' },
        { id: 'cap-cap', kind: 'depends-on', sourceId: 'cap', targetId: 'cap2' },
        { id: 'app-tech', kind: 'depends-on', sourceId: 'app', targetId: 'tech' },
        { id: 'mismo', kind: 'depends-on', sourceId: 'app', targetId: 'app' },
        { id: 'roto', kind: 'realizes', sourceId: 'proc', targetId: 'nada' },
      ],
    });
    expect(r.ok).toBe(false);
    const text = r.ok ? '' : formatEnterpriseIssues(r.issues);
    for (const fragment of [
      'repite otra igual',
      'Id de relación duplicado: "ok"',
      'La relación "al-reves" (soporta) no puede unir capacidad → aplicación: solo admite aplicación → capacidad o aplicación → proceso',
      'La relación "cap-cap" (depende de) no puede unir capacidad → capacidad',
      'no puede unir aplicación → tecnología: solo admite aplicación → aplicación o tecnología → tecnología',
      'no puede unir un elemento consigo mismo',
      'referencia un elemento inexistente: "nada"',
    ]) {
      expect(text).toContain(fragment);
    }
  });

  it('relationBetween resuelve el tipo de relación en cualquiera de los dos sentidos', () => {
    expect(relationBetween('application', 'capability')).toEqual({ kind: 'supports', reversed: false });
    expect(relationBetween('capability', 'application')).toEqual({ kind: 'supports', reversed: true });
    expect(relationBetween('capability', 'process')).toEqual({ kind: 'realizes', reversed: true });
    expect(relationBetween('application', 'technology')).toEqual({ kind: 'runs-on', reversed: false });
    expect(relationBetween('technology', 'technology')).toEqual({ kind: 'depends-on', reversed: false });
    expect(relationBetween('capability', 'capability')).toBeUndefined();
    expect(relationBetween('technology', 'capability')).toBeUndefined();
  });
});

describe('grafo de dependencias', () => {
  const graph = dependencyGraph(doc);

  it('las relaciones se leen de quien se apoya a aquello en lo que se apoya', () => {
    expect(graph.leansOn.get('gestion-pedidos')).toEqual(expect.arrayContaining(['erp', 'alta-pedido']));
    expect(graph.leansOn.get('erp')).toEqual(['hana']);
    expect(graph.leansOn.get('kubernetes')).toEqual(['aws']);
  });

  it('reach recorre lo que depende de un elemento, de lo que depende o ambos, con el camino seguido', () => {
    const dependents = reach(graph, 'hana', 'dependents');
    expect(dependents[0]).toEqual({ id: 'erp', depth: 1, via: 'hana' });
    expect(dependents.map((s) => s.id)).toEqual(expect.arrayContaining(['tienda-web', 'ventas-online', 'gestion-inventario', 'cierre-mensual']));
    expect(dependents.find((s) => s.id === 'ventas-online')).toMatchObject({ depth: 3, via: 'tienda-web' });
    expect(reach(graph, 'hana', 'dependencies')).toEqual([]);
    const both = reach(graph, 'erp', 'both').map((s) => s.id);
    expect(both).toContain('hana');
    expect(both).toContain('gestion-pedidos');
    expect(new Set(both).size).toBe(both.length);
    expect(reach(graph, 'tienda-web', 'dependencies').map((s) => s.id)).toEqual(expect.arrayContaining(['erp', 'hana', 'kubernetes', 'aws']));
  });

  it('el responsable de una capacidad se hereda de su capacidad padre', () => {
    const { ownerOf } = ownership(doc);
    expect(ownerOf('ventas-online')).toBe('direccion-comercial');
    expect(ownerOf('gestion-pedidos')).toBe('ventas');
    expect(ownerOf('erp')).toBe('finanzas');
    expect(ownerOf('cadena-suministro')).toBe('operaciones');
    expect(ownerOf('nada')).toBeUndefined();
  });

  it('las aplicaciones de una capacidad incluyen las que soportan un proceso que la realiza, y se pueden acumular en el árbol', () => {
    const direct = applicationsByCapability(doc);
    expect([...direct.get('gestion-pedidos')!].sort()).toEqual(['erp', 'tienda-web']);
    expect(direct.get('gestion-comercial')!.size).toBe(0);
    const rolled = applicationsByCapability(doc, { rollup: true });
    expect([...rolled.get('gestion-comercial')!].sort()).toEqual(['crm', 'erp', 'motor-precios', 'tienda-web']);
  });

  it('unitTree incluye las unidades que cuelgan de una unidad', () => {
    expect([...unitTree(doc, 'direccion-comercial')].sort()).toEqual(['atencion', 'direccion-comercial', 'ventas']);
    expect([...unitTree(doc, 'finanzas')]).toEqual(['finanzas']);
  });
});

describe('reglas de gobierno', () => {
  it('el ejemplo no tiene avisos ni notas', () => {
    expect(analyzeEnterprise(doc, { today: TODAY })).toEqual([]);
  });

  it('avisa de capacidades sin aplicación, redundancias, responsables ausentes y procesos huérfanos', () => {
    const d = parse({
      units: [{ id: 'u', name: 'Unidad' }],
      capabilities: [
        { id: 'estrategica', name: 'Estratégica', importance: 'differentiating', maturity: 1, ownerId: 'u' },
        { id: 'apoyo', name: 'De apoyo', ownerId: 'u' },
        { id: 'sin-responsable', name: 'Sin responsable' },
        { id: 'padre', name: 'Padre', ownerId: 'u' },
        { id: 'hija', name: 'Hija', parentId: 'padre' },
        { id: 'duplicada', name: 'Duplicada', ownerId: 'u' },
      ],
      processes: [{ id: 'p', name: 'Proceso suelto' }],
      applications: ['a1', 'a2', 'a3'].map((id) => ({ id, name: id.toUpperCase(), ownerId: 'u', technology: 'x' })),
      relations: ['a1', 'a2', 'a3'].map((id) => ({ id: `r-${id}`, kind: 'supports', sourceId: id, targetId: 'duplicada' })),
    });
    const text = messages(d);
    expect(text).toContain('Capacidad «Estratégica» no está soportada por ninguna aplicación.');
    expect(text).toContain('Capacidad «Estratégica» es diferenciadora y su madurez es baja (1 de 5).');
    expect(text).toContain('Capacidad «De apoyo» no está soportada por ninguna aplicación.');
    expect(text).toContain('Capacidad «Sin responsable» no tiene responsable (unidad).');
    expect(text).toContain('Capacidad «Hija» no está soportada por ninguna aplicación.');
    expect(text.filter((m) => m.includes('«Padre»'))).toEqual([]); // los agrupadores no necesitan aplicación
    expect(text).not.toContain('Capacidad «Hija» no tiene responsable (unidad).'); // lo hereda de «Padre»
    expect(text.some((m) => m.startsWith('Capacidad «Duplicada» está soportada por 3 aplicaciones'))).toBe(true);
    expect(text).toContain('Proceso «Proceso suelto» no realiza ninguna capacidad.');
    expect(text).toContain('Proceso «Proceso suelto» no está soportado por ninguna aplicación.');
    expect(text).toContain('Proceso «Proceso suelto» no tiene responsable (unidad).');
    const severity = (fragment: string) => analyzeEnterprise(d, { today: TODAY }).find((i) => i.message.includes(fragment))!.severity;
    expect(severity('«Estratégica» no está soportada')).toBe('warning');
    expect(severity('«De apoyo» no está soportada')).toBe('info');
  });

  it('avisa de aplicaciones sin responsable, sin uso o sin tecnología', () => {
    const d = parse({
      units: [{ id: 'u', name: 'Unidad' }],
      applications: [
        { id: 'critica', name: 'Crítica', criticality: 'critical', technology: 'x' },
        { id: 'normal', name: 'Normal', technology: 'x' },
        { id: 'sin-tec', name: 'Sin tecnología', ownerId: 'u' },
        { id: 'externa', name: 'SaaS', ownerId: 'u', external: true },
        { id: 'retirada', name: 'Retirada', lifecycle: 'retired' },
      ],
    });
    const found = analyzeEnterprise(d, { today: TODAY });
    const by = (fragment: string) => found.find((i) => i.message.includes(fragment));
    expect(by('«Crítica» no tiene responsable de negocio')?.severity).toBe('warning');
    expect(by('«Normal» no tiene responsable de negocio')?.severity).toBe('info');
    expect(by('«Sin tecnología» no declara en qué tecnología se ejecuta')).toBeDefined();
    expect(by('«SaaS» no declara')).toBeUndefined();
    expect(by('«Retirada»')).toBeUndefined();
    expect(by('«Normal» no soporta ninguna capacidad ni proceso')).toBeDefined();
  });

  it('avisa de retiradas sin sustituto, dependencias de tecnología en retirada y fin de soporte', () => {
    const d = parse({
      units: [{ id: 'u', name: 'U' }],
      capabilities: [{ id: 'cap', name: 'Cap', ownerId: 'u' }, { id: 'cap2', name: 'Cap2', ownerId: 'u' }],
      applications: [
        { id: 'vieja', name: 'Vieja', lifecycle: 'sunset', ownerId: 'u', technology: 'x' },
        { id: 'nueva', name: 'Nueva', lifecycle: 'planned', ownerId: 'u', technology: 'x' },
        { id: 'unica', name: 'Única', lifecycle: 'sunset', ownerId: 'u', technology: 'x' },
        { id: 'muerta', name: 'Muerta', lifecycle: 'retired' },
        { id: 'viva', name: 'Viva', ownerId: 'u' },
        { id: 'alta', name: 'Alta', ownerId: 'u', technology: 'x', criticality: 'critical' },
        { id: 'baja', name: 'Baja', ownerId: 'u', technology: 'x', criticality: 'low' },
      ],
      technologies: [
        { id: 'obsoleta', name: 'Obsoleta', lifecycle: 'sunset' },
        { id: 'vencida', name: 'Vencida', endOfLife: '2025-12' },
        { id: 'pronto', name: 'Pronto', endOfLife: '2027-03-31' },
        { id: 'lejos', name: 'Lejos', endOfLife: '2031-01' },
        { id: 'retirada', name: 'Retirada', lifecycle: 'retired', endOfLife: '2020-01' },
        { id: 'sin-uso', name: 'Sin uso' },
      ],
      relations: [
        { id: '1', kind: 'supports', sourceId: 'vieja', targetId: 'cap' },
        { id: '2', kind: 'supports', sourceId: 'nueva', targetId: 'cap' },
        { id: '3', kind: 'supports', sourceId: 'unica', targetId: 'cap2' },
        { id: '4', kind: 'runs-on', sourceId: 'viva', targetId: 'obsoleta' },
        { id: '5', kind: 'runs-on', sourceId: 'viva', targetId: 'vencida' },
        { id: '6', kind: 'runs-on', sourceId: 'viva', targetId: 'pronto' },
        { id: '7', kind: 'runs-on', sourceId: 'viva', targetId: 'lejos' },
        { id: '8', kind: 'runs-on', sourceId: 'viva', targetId: 'retirada' },
        { id: '9', kind: 'depends-on', sourceId: 'viva', targetId: 'muerta' },
        { id: '10', kind: 'depends-on', sourceId: 'alta', targetId: 'baja' },
      ],
    });
    const text = messages(d);
    expect(text).toContain('Aplicación «Única» está en retirada y es la única que soporta capacidad «Cap2»: falta la aplicación que la sustituya.');
    expect(text.some((m) => m.includes('«Vieja» está en retirada y es la única'))).toBe(false); // «Nueva» la sustituye
    expect(text).toContain('Aplicación «Viva» se ejecuta en tecnología «Obsoleta», que está en retirada.');
    expect(text).toContain('Aplicación «Viva» depende de aplicación «Muerta», que está retirada.');
    expect(text).toContain('Aplicación «Viva» se ejecuta en tecnología «Retirada», que está retirada.');
    expect(text).toContain('Tecnología «Retirada» está retirada pero todavía se apoyan en ella: «Viva».');
    expect(text).toContain('Aplicación «Muerta» está retirada pero todavía se apoyan en ella: «Viva».');
    expect(text).toContain('Tecnología «Vencida» está fuera de soporte desde 2025-12.');
    expect(text).toContain('Tecnología «Pronto» sale de soporte el 2027-03-31.');
    expect(text.filter((m) => m.includes('«Lejos»') && !m.includes('no la usa'))).toEqual([]);
    expect(text).toContain('Tecnología «Sin uso» no la usa ninguna aplicación.');
    expect(text.some((m) => m.includes('«Retirada») está fuera de soporte'))).toBe(false);
    expect(text.find((m) => m.includes('(criticidad crítica) depende de aplicación «Baja»'))).toBeDefined();
    // La fecha de referencia manda: un año antes, «Vencida» todavía no vence.
    const early = analyzeEnterprise(d, { today: new Date('2025-01-01T00:00:00Z') }).map((i) => i.message);
    expect(early).not.toContain('Tecnología «Vencida» está fuera de soporte desde 2025-12.');
    expect(early).toContain('Tecnología «Vencida» sale de soporte el 2025-12.');
  });
});

describe('vistas', () => {
  it('lista el mapa de capacidades, el paisaje, la matriz capacidad × aplicación y una vista por unidad con contenido', () => {
    const views = listViews(doc);
    expect(views.map((v) => v.id)).toEqual([
      'capabilities',
      'landscape',
      'matrix',
      'roadmap',
      'unit:direccion-comercial',
      'unit:ventas',
      'unit:atencion',
      'unit:operaciones',
      'unit:logistica',
      'unit:finanzas',
      'unit:ti',
      'unit:plataforma',
    ]);
    expect(views[0].elementIds).toHaveLength(16);
    // Los agrupadores sin relaciones no se dibujan en las vistas de relaciones.
    const landscape = views[1];
    expect(landscape.elementIds).not.toContain('gestion-comercial');
    expect(landscape.elementIds).toContain('gestion-pedidos');
    expect(landscape.relationIds).toHaveLength(doc.relations.length);
    expect(listViews(parse({}))).toEqual([]);
  });

  it('la vista de una unidad incluye lo que tiene a su cargo (también por herencia) y el contexto discontinuo', () => {
    const logistica = findView(doc, 'unit:logistica');
    expect(logistica.title).toBe('Unidad - Logística');
    expect(logistica.elementIds).toEqual(expect.arrayContaining(['gestion-inventario', 'distribucion', 'compras', 'wms-legacy', 'wms-nuevo', 'tms', 'portal-proveedores']));
    expect(logistica.contextIds).toEqual(expect.arrayContaining(['erp', 'kubernetes', 'postgres', 'oracle-11g']));
    expect(logistica.elementIds).not.toContain('facturacion');
    const direccion = findView(doc, 'unit:direccion-comercial');
    expect(direccion.elementIds).toEqual(expect.arrayContaining(['ventas-online', 'tienda-web', 'crm', 'alta-pedido']));
  });

  it('impacto, dependencias y entorno de un elemento, por prefijo o por su id', () => {
    const impact = findView(doc, 'impact:hana');
    expect(impact.title).toBe('Impacto de «SAP HANA»');
    expect(impact.elementIds).toEqual(expect.arrayContaining(['hana', 'erp', 'tienda-web', 'ventas-online']));
    expect(impact.elementIds).not.toContain('kubernetes');
    expect(impact.contextIds).toEqual([]);
    const depends = findView(doc, 'depends:tienda-web');
    expect(depends.elementIds).toEqual(expect.arrayContaining(['tienda-web', 'erp', 'hana', 'aws', 'kubernetes', 'pasarela-pagos']));
    expect(depends.elementIds).not.toContain('ventas-online');
    const focus = findView(doc, 'erp');
    expect(focus.id).toBe('focus:erp');
    expect(focus.elementIds).toEqual(expect.arrayContaining(['hana', 'gestion-pedidos', 'tienda-web']));
    expect(findView(doc, 'unit:finanzas').id).toBe('unit:finanzas');
    expect(findView(doc, 'finanzas').id).toBe('unit:finanzas');
    expect(findView(doc).id).toBe('capabilities');
  });

  it('explica las vistas disponibles cuando no existe la pedida', () => {
    expect(() => findView(doc, 'nada')).toThrow(/No existe la vista «nada»\. Vistas disponibles: capabilities, landscape, matrix, roadmap, unit:direccion-comercial.*capabilities:criticality.*impact:<elemento>/);
    expect(() => findView(doc, 'impact:nada')).toThrow(/No existe la vista/);
    expect(() => findView(parse({}))).toThrow(/no tiene vistas/);
  });
});

describe('exportación a Mermaid', () => {
  it('el mapa de capacidades anida cada capacidad con hijas en un subgraph', () => {
    const text = toMermaid(doc, { viewId: 'capabilities' });
    expect(text.startsWith('flowchart TB\n')).toBe(true);
    expect(text).toContain('subgraph gestion_comercial["Gestión comercial"]');
    expect(text).toContain('        ventas_online("Ventas online"):::capability');
    expect(text).toContain('classDef capability fill:#ffec99,stroke:#e0a800,color:#0f172a');
    expect(text.match(/^\s*end$/gm)).toHaveLength(4);
  });

  it('el paisaje dibuja de quien se apoya a aquello en lo que se apoya, con las formas y clases de cada tipo', () => {
    const text = toMermaid(doc, { viewId: 'landscape' });
    expect(text).toContain('gestion_pedidos("Gestión de pedidos"):::capability');
    expect(text).toContain('alta_pedido(["Alta de pedido"]):::process');
    expect(text).toContain('erp["ERP corporativo<br/>SAP S/4HANA"]:::application');
    expect(text).toContain('hana[("SAP HANA<br/>2.0")]:::technology');
    expect(text).toContain('    gestion_pedidos --> erp');
    expect(text).toContain('    gestion_pedidos --> alta_pedido');
    expect(text).toContain('    erp --> hana');
    expect(text).toContain('    tienda_web -.->|"stock y precios por API"| erp');
    expect(text).toContain('    kubernetes -.-> aws');
    expect(text).not.toContain('erp --> gestion_pedidos');
  });

  it('marca el contexto de una vista de unidad', () => {
    const text = toMermaid(doc, { viewId: 'unit:logistica' });
    expect(text).toContain('classDef context stroke-dasharray:5 5');
    expect(text).toMatch(/class .*erp.* context/);
  });

  it('evita las palabras reservadas y los ids con caracteres raros', () => {
    const d = parse({ applications: [{ id: 'end', name: 'Fin' }, { id: '1-a', name: 'Uno' }, { id: 'class', name: 'Clase' }], technologies: [{ id: 't', name: 'T' }], relations: [{ id: 'r', kind: 'runs-on', sourceId: 'end', targetId: 't' }] });
    const text = toMermaid(d, { viewId: 'landscape' });
    expect(text).toContain('end_2["Fin"]:::application');
    expect(text).toContain('_1_a["Uno"]:::application');
    expect(text).toContain('class_2["Clase"]:::application');
    expect(text).toContain('end_2 --> t');
  });
});

describe('importación desde Mermaid', () => {
  it('ida y vuelta del paisaje: tipos, relaciones, sentido y descripciones', () => {
    const { document, warnings } = fromMermaid(toMermaid(doc, { viewId: 'landscape' }));
    expect(warnings).toEqual([]);
    const original = new Map([...doc.capabilities, ...doc.processes, ...doc.applications, ...doc.technologies].map((x) => [x.id, x]));
    const imported = [...document.capabilities, ...document.processes, ...document.applications, ...document.technologies];
    expect(imported.map((x) => x.id).sort()).toEqual([...original.keys()].filter((id) => !['gestion-comercial', 'cadena-suministro', 'gestion-financiera', 'experiencia-cliente'].includes(id)).sort());
    expect(document.applications.find((a) => a.id === 'erp')).toMatchObject({ name: 'ERP corporativo', technology: 'SAP S/4HANA' });
    expect(document.technologies.find((t) => t.id === 'hana')).toMatchObject({ name: 'SAP HANA', version: '2.0' });
    const signature = (r: { kind: string; sourceId: string; targetId: string; description?: string }) => `${r.kind}|${r.sourceId}|${r.targetId}|${r.description ?? ''}`;
    expect(document.relations.map(signature).sort()).toEqual(doc.relations.map(signature).sort());
  });

  it('ida y vuelta del mapa de capacidades: la jerarquía se conserva', () => {
    const { document, warnings } = fromMermaid(toMermaid(doc, { viewId: 'capabilities' }));
    expect(warnings).toEqual([]);
    expect(document.capabilities.map((c) => [c.id, c.parentId])).toEqual(doc.capabilities.map((c) => [c.id, c.parentId]));
    expect(document.capabilities.find((c) => c.id === 'gestion-pedidos')).toMatchObject({ name: 'Gestión de pedidos', parentId: 'gestion-comercial' });
  });

  it('un flowchart escrito a mano: capas, clases en español, formas, flechas en cualquier sentido y avisos', () => {
    const { document, warnings } = fromMermaid(`flowchart LR
      subgraph Capacidades
        pedidos[Gestión de pedidos]
      end
      subgraph Aplicaciones
        erp[ERP<br/>SAP]
        web[Web]
      end
      subgraph Tecnología
        k8s[Kubernetes<br/>1.29]
      end
      cierre([Cierre mensual])
      db[(Base de datos)]
      cli[Cliente]:::proceso
      pedidos --> erp
      web -->|API| erp
      erp --> k8s
      k8s --> erp
      cierre --> pedidos
      erp --> db
      db --> k8s
      pedidos --> pedidos
      pedidos --> k8s
      pedidos --> web & erp
      cli --> pedidos
      class web aplicacion
      erp <--> web`);
    const by = (id: string) => [...document.capabilities, ...document.processes, ...document.applications, ...document.technologies].find((x) => x.id === id)!;
    expect(document.capabilities.map((c) => c.id)).toEqual(['pedidos']);
    expect(document.applications.map((a) => a.id)).toEqual(['erp', 'web']);
    expect(by('erp')).toMatchObject({ technology: 'SAP' });
    expect(document.processes.map((p) => p.id).sort()).toEqual(['cierre', 'cli']);
    expect(document.technologies.map((t) => t.id).sort()).toEqual(['db', 'k8s']);
    expect(by('k8s')).toMatchObject({ version: '1.29' });
    const rel = (kind: string, s: string, t: string) => document.relations.find((r) => r.kind === kind && r.sourceId === s && r.targetId === t);
    expect(rel('supports', 'erp', 'pedidos')).toBeDefined(); // capacidad → aplicación se lee como «la soporta»
    expect(rel('supports', 'web', 'pedidos')).toBeDefined();
    expect(rel('depends-on', 'web', 'erp')).toMatchObject({ description: 'API' });
    expect(rel('runs-on', 'erp', 'k8s')).toBeDefined();
    expect(rel('runs-on', 'erp', 'db')).toBeDefined();
    expect(rel('realizes', 'cierre', 'pedidos')).toBeDefined();
    expect(rel('realizes', 'cli', 'pedidos')).toBeDefined();
    // Sin duplicados aunque se escriba la misma relación en los dos sentidos.
    expect(document.relations.filter((r) => r.kind === 'runs-on' && r.targetId === 'k8s')).toHaveLength(1);
    expect(warnings).toEqual(['línea 23: «Gestión de pedidos» → «Kubernetes» une capacidad con tecnología, que no se relacionan; se omite.']);
  });

  it('un subgraph que no es una capa es una capacidad; lo que no es una capacidad dentro de él se importa sin padre', () => {
    const { document, warnings } = fromMermaid(`flowchart TB
      subgraph Ventas
        subgraph Online
          tienda[Tienda]
        end
        crm[(CRM)]
        pedidos
      end
      pedidos --> pedidos2[Otra]`);
    expect(document.capabilities.map((c) => [c.id, c.parentId])).toEqual([['ventas', undefined], ['online', 'ventas'], ['tienda', 'online'], ['pedidos', 'ventas']]);
    expect(document.technologies.map((t) => [t.id, t.name])).toEqual([['crm', 'CRM']]);
    expect(warnings.join('\n')).toContain('«CRM» está dentro del grupo «Ventas» pero es tecnología');
    expect(warnings).toHaveLength(1);
  });

  it('rechaza lo que no es un flowchart y lo vacío, con errores de módulo', () => {
    expect(() => fromMermaid('erDiagram\n A ||--o{ B : x')).toThrow(/no se puede importar como arquitectura empresarial/);
    expect(() => fromMermaid('pie title x\n "a": 1')).toThrow(/No se reconoce el tipo de diagrama/);
    expect(() => fromMermaid('   ')).toThrow(EnterpriseImportError);
    expect(() => fromMermaid('flowchart LR\n')).toThrow(/ningún elemento/);
    expect(new EnterpriseImportError('x')).toBeInstanceOf(ModuleError);
  });

  it('usa el nombre indicado, el título del frontmatter o el de reserva', () => {
    const src = '---\ntitle: Mi empresa\n---\nflowchart LR\n a[A]';
    expect(fromMermaid(src).document.workspace.name).toBe('Mi empresa');
    expect(fromMermaid(src, { name: 'Otro' }).document.workspace.name).toBe('Otro');
    expect(fromMermaid('flowchart LR\n a[A]', { fallbackName: 'archivo' }).document.workspace.name).toBe('archivo');
    expect(fromMermaid('flowchart LR\n a[A]').document.workspace.name).toBe('Arquitectura empresarial');
  });
});

describe('SVG y draw.io', () => {
  it('el mapa de capacidades es una cuadrícula anidada sin solapes: color por madurez y aviso de las que no tienen aplicación', async () => {
    const layout = layoutCapabilityMap(doc);
    expect(layout.groups.map((g) => g.id).sort()).toEqual(['cadena-suministro', 'experiencia-cliente', 'gestion-comercial', 'gestion-financiera']);
    expect(layout.nodes).toHaveLength(12);
    const inside = (n: { x: number; y: number; width: number; height: number }, g: { x: number; y: number; width: number; height: number }) =>
      n.x >= g.x && n.y >= g.y && n.x + n.width <= g.x + g.width && n.y + n.height <= g.y + g.height;
    const group = layout.groups.find((g) => g.id === 'gestion-comercial')!;
    for (const id of ['ventas-online', 'gestion-pedidos', 'gestion-clientes', 'precios-promociones']) expect(inside(layout.nodes.find((n) => n.id === id)!, group)).toBe(true);
    for (let i = 0; i < layout.nodes.length; i += 1) {
      for (const b of layout.nodes.slice(i + 1)) {
        const a = layout.nodes[i];
        expect(a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height).toBe(false);
      }
    }
    const svg = await toSvg(doc, 'capabilities');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('Mapa de capacidades');
    expect(svg).toContain('>Gestión de pedidos</text>');
    expect(svg).toContain('2 aplicaciones');
    expect(svg).toContain('1 aplicación<');
    expect(svg).toContain('#d8f5a2'); // madurez 4
    expect(svg).toContain('#fff3bf'); // madurez 3
    const bare = parse({ capabilities: [{ id: 'a', name: 'A' }] });
    expect(await toSvg(bare, 'capabilities')).toContain('sin aplicación');
    expect(await toSvg(bare, 'capabilities')).toContain('#e9ecef');
  });

  it('el paisaje pone las capas de izquierda a derecha y marca el ciclo de vida', async () => {
    const svg = await toSvg(doc, 'landscape');
    for (const text of ['CAPACIDAD', 'PROCESO', 'APLICACIÓN', 'TECNOLOGÍA', 'SAP S/4HANA', 'en retirada', 'soporte hasta 2034-12', 'stock y precios por API']) expect(svg).toContain(text);
    expect(svg).toContain('#e8590c'); // borde de lo que está en retirada
    expect(svg).not.toMatch(/<script|href=|@import/);
  });

  it('las vistas de una unidad y de impacto también se dibujan', async () => {
    expect(await toSvg(doc, 'unit:logistica')).toContain('Unidad - Logística');
    expect(await toSvg(doc, 'impact:hana')).toContain('Impacto de «SAP HANA»');
  });

  it('draw.io tiene una página por vista, con sus nodos y aristas', async () => {
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(await toDrawio(doc));
    const pages = ([] as Array<Record<string, unknown>>).concat(parsed.mxfile.diagram);
    expect(pages).toHaveLength(listViews(doc).length);
    expect(pages.map((p) => p['@_id'])).toEqual(listViews(doc).map((v) => v.id));
    const cells = (i: number) => ([] as Array<Record<string, string>>).concat(parsed.mxfile.diagram[i].mxGraphModel.root.mxCell);
    const capabilities = cells(0);
    const isIcon = (c: Record<string, string>): boolean => c['@_id'].startsWith('i-');
    expect(capabilities.filter((c) => c['@_vertex'] && !isIcon(c)).length).toBe(16);
    expect(capabilities.filter(isIcon).length).toBe(12); // un icono de tipo por capacidad hoja
    expect(capabilities.some((c) => c['@_edge'])).toBe(false);
    const landscape = cells(1);
    expect(landscape.filter((c) => c['@_edge']).length).toBe(doc.relations.length);
    expect(landscape.filter((c) => c['@_vertex' as string] && !isIcon(c)).length).toBe(listViews(doc)[1].elementIds.length);
    expect(landscape.filter(isIcon).length).toBe(listViews(doc)[1].elementIds.length);
  });
});

describe('desde un mapa de integración', () => {
  const integration = JSON.parse(readFileSync('examples/pedidos-integracion.json', 'utf8')) as { nodes: Array<{ id: string; kind: string; name: string }>; interactions: Array<{ sourceId: string; targetId: string; style: string }> };

  it('pasa sistemas a aplicaciones y almacenes a bases de datos, con sus dependencias y unidades', () => {
    const { document, warnings } = fromIntegrationJson(integration);
    expect(document.workspace.name).toMatch(/^Empresa - /);
    const systems = integration.nodes.filter((n) => n.kind === 'system');
    const stores = integration.nodes.filter((n) => n.kind === 'store');
    expect(document.applications.map((a) => a.id)).toEqual(systems.map((n) => n.id));
    expect(document.technologies.map((t) => [t.id, t.kind])).toEqual(stores.map((n) => [n.id, 'database']));
    expect(document.applications.every((a) => a.ref === `urn:iark:integration:${a.id}`)).toBe(true);
    expect(document.relations.every((r) => r.kind === 'depends-on' || r.kind === 'runs-on')).toBe(true);
    expect(document.relations.length).toBeGreaterThan(0);
    for (const r of document.relations.filter((x) => x.kind === 'runs-on')) expect(stores.map((s) => s.id)).toContain(r.targetId);
    expect(warnings.join('\n')).toContain('No se crean capacidades ni procesos');
    expect(validateEnterpriseDocument(document).ok).toBe(true);
  });

  it('los responsables (texto) pasan a unidades y las llamadas a una API cuentan como llamadas a su sistema', () => {
    const { document } = fromIntegrationJson({
      workspace: { name: 'X' },
      nodes: [
        { id: 'a', kind: 'system', name: 'A', owner: 'Equipo A' },
        { id: 'b', kind: 'system', name: 'B', owner: 'Equipo A', external: true },
        { id: 'b-api', kind: 'api', name: 'API de B', parentId: 'b' },
        { id: 'db', kind: 'store', name: 'DB', technology: 'PostgreSQL' },
      ],
      interactions: [
        { sourceId: 'a', targetId: 'b-api', style: 'request-response', description: 'consulta' },
        { sourceId: 'a', targetId: 'b', style: 'request-response' },
        { sourceId: 'a', targetId: 'db', style: 'batch' },
        { sourceId: 'b', targetId: 'a', style: 'event' },
      ],
    }, { name: 'Mi empresa' });
    expect(document.workspace.name).toBe('Mi empresa');
    expect(document.units).toEqual([{ id: 'equipo-a', name: 'Equipo A' }]);
    expect(document.applications).toMatchObject([{ id: 'a', ownerId: 'equipo-a' }, { id: 'b', ownerId: 'equipo-a', external: true }]);
    expect(document.technologies[0]).toMatchObject({ id: 'db', version: 'PostgreSQL' });
    expect(document.relations.map((r) => [r.kind, r.sourceId, r.targetId, r.description])).toEqual([
      ['depends-on', 'a', 'b', 'consulta'],
      ['runs-on', 'a', 'db', undefined],
    ]);
    expect(() => fromIntegrationJson({ nodes: [{ id: 'k', kind: 'broker', name: 'K' }] })).toThrow(/no tiene sistemas/);
    expect(() => fromIntegrationJson({})).toThrow(/falta "nodes"/);
  });
});

describe('generación con IA', () => {
  it('quita los null de la salida estructurada y valida el documento', () => {
    const generated = toGenerated(doc);
    const result = generatedToEnterprise(generated);
    expect(result.ok).toBe(true);
    // La generación no incluye los `ref` (enlaces por URN a otros módulos): al refinar se recuperan del documento base.
    if (result.ok) expect(carryRefs(doc, result.document)).toEqual(doc);
    const broken = { ...generated, relations: [{ ...generated.relations[0], targetId: 'fantasma' }] };
    const failed = generatedToEnterprise(broken);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.issues).toContain('referencia un elemento inexistente');
  });

  it('el prompt describe el dominio y el usuario incluye el modelo base al refinar', () => {
    expect(enterpriseAiSpec.system()).toContain('arquitecto empresarial');
    expect(enterpriseAiSpec.system()).toContain('"supports": aplicación → capacidad');
    expect(enterpriseAiSpec.user('Un banco')).toContain('Un banco');
    const refine = enterpriseAiSpec.user('Añade un CRM', doc);
    expect(refine).toContain('"id": "gestion-pedidos"');
    expect(refine).toContain('Añade un CRM');
    const schema = enterpriseAiSpec.generationJsonSchema() as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(['workspace', 'units', 'capabilities', 'processes', 'applications', 'technologies', 'valueStreams', 'valueStages', 'businessServices', 'relations']);
  });
});

describe('módulo', () => {
  it('cumple el contrato y se puede registrar junto a otros módulos', () => {
    const registry = new ModuleRegistry().register(enterpriseModule);
    expect(registry.require('enterprise')).toBe(enterpriseModule);
    expect(enterpriseModule.exporters.map((e) => e.id)).toEqual(['mermaid', 'svg', 'drawio']);
    expect(enterpriseModule.importers.map((i) => i.id)).toEqual(['mermaid', 'archimate', 'bpmn']);
    const manifest = buildManifest(registry, { name: 'Prueba', version: '0.0.0' });
    expect(manifest.modules[0]).toMatchObject({ id: 'enterprise', importFormats: ['mermaid', 'archimate', 'bpmn'], exportFormats: ['mermaid', 'svg', 'drawio'] });
    expect(enterpriseModule.entities!(doc).map((e) => e.kind)).toEqual(expect.arrayContaining(['unit', 'capability', 'process', 'application', 'technology']));
    expect(enterpriseModule.validate(doc)).toEqual([]);
    expect((enterpriseModule.jsonSchema() as { type: string }).type).toBe('object');
    expect(enterpriseModule.importers[0].detect!('flowchart LR\n a --> b')).toBe(true);
    expect(enterpriseModule.cliCommands!.map((c) => c.name)).toEqual(['coverage', 'impact', 'lifecycle', 'matrix', 'from-integration']);
  });
});

describe('comandos', () => {
  const run = (name: string, args: string[], input: unknown, options: Record<string, unknown> = {}) =>
    enterpriseCommands.find((c) => c.name === name)!.run({ args, options, input: typeof input === 'string' ? input : JSON.stringify(input) }) as string;

  it('coverage lista las capacidades con sus aplicaciones y marca las que no tienen ninguna', () => {
    const text = run('coverage', [], example);
    expect(text).toContain('| Capacidad | Importancia | Madurez | Responsable | Aplicaciones | Estado |');
    expect(text).toContain('| Gestión comercial › Gestión de pedidos | esencial | 4/5 | Ventas | ERP corporativo; Tienda online | — |');
    expect(text).toContain('| Cadena de suministro › Gestión de inventario | esencial | 3/5 | Logística | WMS heredado (en retirada); WMS nuevo (prevista) | — |');
    expect(text).toContain('Cobertura: 12 de 12 capacidad(es) hoja tienen al menos una aplicación.');
    const gaps = run('coverage', [], { capabilities: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', parentId: 'a' }] });
    expect(gaps).toContain('| A › B | — | — | — | — | Sin cobertura |');
    expect(gaps).toContain('Cobertura: 0 de 1');
    expect(run('coverage', [], {})).toBe('El documento no define capacidades.');
  });

  it('impact muestra lo que se apoya en un elemento como un árbol, y los responsables a avisar', () => {
    const text = run('impact', ['hana'], example);
    expect(text).toContain('Impacto de «SAP HANA» (Tecnología)');
    expect(text).toContain('Se apoyan en él (se ven afectados si cambia o se retira): 12 elemento(s)');
    expect(text).toContain('- ERP corporativo (Aplicación) · Finanzas\n  - Alta de pedido (Proceso) · Ventas');
    expect(text).toContain('  - Tienda online (Aplicación) · Ventas\n    - Ventas online (Capacidad) · Dirección Comercial');
    expect(text).toContain('Responsables a avisar: Tecnología (TI), Finanzas, Ventas, Logística, Dirección Comercial');
    const both = run('impact', ['erp'], example, { direction: 'both' });
    expect(both).toContain('Se apoya en (de qué depende): 1 elemento(s)\n- SAP HANA (Tecnología) · Tecnología (TI)');
    const down = run('impact', ['tienda-web'], example, { direction: 'dependencies' });
    expect(down).not.toContain('Se apoyan en él');
    expect(down).not.toContain('Responsables a avisar');
    expect(run('impact', ['gestion-pedidos'], example)).toContain('Se apoyan en él (se ven afectados si cambia o se retira): ninguno');
    expect(() => run('impact', ['nada'], example)).toThrow(/No existe el elemento «nada»/);
    expect(() => run('impact', ['ventas'], example)).toThrow(/No existe el elemento «ventas»/); // una unidad no se dibuja
    expect(() => run('impact', ['erp'], example, { direction: 'lateral' })).toThrow(/Sentido inválido/);
  });

  it('lifecycle lista lo que está en retirada o tiene fin de soporte, con las capacidades afectadas', () => {
    const text = run('lifecycle', [], example, { today: '2026-06-15' });
    const rows = text.split('\n').slice(2);
    expect(rows[0]).toBe('| Oracle Database | Tecnología | en retirada | — | WMS heredado | Gestión de inventario |');
    expect(rows[1]).toBe('| WMS heredado | Aplicación | en retirada | — | Gestión de inventario | Gestión de inventario |');
    expect(rows[2]).toMatch(/^\| SAP HANA \| Tecnología \| activa \| 2034-12 \| ERP corporativo \| Gestión de pedidos; /);
    expect(rows).toHaveLength(3);
    const overdue = run('lifecycle', [], { technologies: [{ id: 't', name: 'T', endOfLife: '2025-12' }, { id: 'r', name: 'R', lifecycle: 'retired', endOfLife: '2020-01' }] }, { today: '2026-06-15' });
    expect(overdue).toContain('| T | Tecnología | activa | 2025-12 (vencido) | — | — |');
    expect(overdue).toContain('| R | Tecnología | retirada | 2020-01 | — | — |');
    expect(run('lifecycle', [], { applications: [{ id: 'a', name: 'A' }] })).toBe('No hay elementos en retirada ni con fin de soporte declarado.');
    expect(() => run('lifecycle', [], example, { today: 'ayer' })).toThrow(/Fecha inválida/);
  });

  it('las entradas inválidas terminan en errores de módulo', () => {
    expect(() => run('coverage', [], 'no es json')).toThrow(ModuleError);
    expect(() => run('coverage', [], { applications: [{ id: 'a', name: 'A', criticality: 'rara' }] })).toThrow(/Documento empresarial inválido/);
    expect(() => enterpriseCommands[0].run({ args: [], options: {} })).toThrow(/Falta la entrada/);
  });
});
