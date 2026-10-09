import { readFileSync } from 'node:fs';
import { buildManifest, importText, looksLikeMermaid, ModuleError, ModuleRegistry } from '@iark/kernel';
import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { toDrawio } from '../export/drawio';
import { toMermaid } from '../export/mermaid';
import { toSvg } from '../export/render';
import { reach, dependencyGraph } from '../graph';
import { analyzeEnterprise } from '../issues';
import { enterpriseModule } from '../module';
import { validateEnterpriseDocument } from '../schema';
import { RELATION_RULES, indexElements, type EnterpriseDocument } from '../types';
import { listViews, viewRefs } from '../views';
import { archimateFormat, looksLikeArchimate } from './archimateXml';
import { fromArchimate } from './fromArchimate';
import { EnterpriseImportError, fromMermaid } from './fromMermaid';

const fixture = (name: string): string => readFileSync(`tests/fixtures/importar/archimate/${name}`, 'utf8');
const TODAY = new Date('2026-10-02T00:00:00Z');

const NS = 'xmlns="http://www.opengroup.org/xsd/archimate/3.0/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';
interface El {
  id: string;
  type: string;
  name?: string;
  doc?: string;
  props?: Record<string, string>;
}
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
/** Modelo mínimo en el formato de intercambio: elementos, relaciones (`tipo`, origen, destino, nombre) y las propiedades que se usen. */
function model(elements: El[], relations: Array<[string, string, string, string?]> = [], head = ''): string {
  const keys = [...new Set(elements.flatMap((e) => Object.keys(e.props ?? {})))];
  const defs = keys.map((k, i) => `<propertyDefinition identifier="pd${i}" type="string"><name>${esc(k)}</name></propertyDefinition>`).join('');
  const els = elements
    .map((e) => {
      const props = Object.entries(e.props ?? {})
        .map(([k, v]) => `<property propertyDefinitionRef="pd${keys.indexOf(k)}"><value>${esc(v)}</value></property>`)
        .join('');
      return `<element identifier="${e.id}" xsi:type="${e.type}">${e.name !== undefined ? `<name>${esc(e.name)}</name>` : ''}${e.doc ? `<documentation>${esc(e.doc)}</documentation>` : ''}${props ? `<properties>${props}</properties>` : ''}</element>`;
    })
    .join('\n');
  const rels = relations.map(([type, s, t, name], i) => `<relationship identifier="rel${i}" source="${s}" target="${t}" xsi:type="${type}">${name ? `<name>${esc(name)}</name>` : ''}</relationship>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<model ${NS} identifier="m">${head}<elements>${els}</elements><relationships>${rels}</relationships>${defs ? `<propertyDefinitions>${defs}</propertyDefinitions>` : ''}</model>`;
}
const run = (elements: El[], relations: Array<[string, string, string, string?]> = [], head = '') => fromArchimate(model(elements, relations, head));
const byId = <T extends { id: string }>(list: T[], id: string): T => {
  const found = list.find((x) => x.id === id);
  if (!found) throw new Error(`No hay «${id}» en ${list.map((x) => x.id).join(', ')}`);
  return found;
};
const rel = (doc: EnterpriseDocument, kind: string, source: string, target: string) => doc.relations.find((r) => r.kind === kind && r.sourceId === source && r.targetId === target);
const triples = (doc: EnterpriseDocument): string[] => doc.relations.map((r) => `${r.kind} ${r.sourceId} ${r.targetId}`);

describe('importar ArchiMate: el modelo de Comercio Andino (formato de intercambio, español e inglés mezclados)', () => {
  const { document: doc, warnings } = fromArchimate(fixture('comercio-andino.xml'));

  it('pasa el esquema y cada relación respeta RELATION_RULES', () => {
    expect(validateEnterpriseDocument(doc).ok).toBe(true);
    const elements = indexElements(doc);
    for (const r of doc.relations) {
      const [s, t] = [elements.get(r.sourceId)!, elements.get(r.targetId)!];
      expect(RELATION_RULES[r.kind].some(([a, b]) => a === s.kind && b === t.kind), `${r.kind} ${s.kind} → ${t.kind}`).toBe(true);
    }
    expect(doc.units).toHaveLength(11);
    expect(doc.capabilities).toHaveLength(16);
    expect(doc.processes).toHaveLength(6);
    expect(doc.applications).toHaveLength(14);
    expect(doc.technologies).toHaveLength(10);
    expect(doc.valueStreams).toHaveLength(2);
    expect(doc.valueStages).toHaveLength(5);
    expect(doc.businessServices).toHaveLength(2);
    expect(doc.relations).toHaveLength(61);
  });

  it('toma el nombre y la descripción del modelo en el idioma preferido (español por defecto) y admite otro', () => {
    expect(doc.workspace).toEqual({ name: 'Comercio Andino - arquitectura empresarial', description: expect.stringContaining('tienda online y almacenes propios') });
    const english = fromArchimate(fixture('comercio-andino.xml'), { lang: 'en' }).document;
    expect(english.workspace.name).toBe('Comercio Andino - enterprise architecture');
    expect(byId(english.units, 'customer').name).toBe('Customer'); // el id sale del nombre elegido: con otro idioma, otros ids
  });

  it('los ids salen del nombre y no chocan entre tipos (la unidad y la capacidad «Atención al cliente»)', () => {
    expect(byId(doc.units, 'atencion-al-cliente').name).toBe('Atención al cliente');
    expect(byId(doc.capabilities, 'atencion-al-cliente-2').name).toBe('Atención al cliente');
    expect(byId(doc.capabilities, 'compras-proveedores').name).toBe('Compras & proveedores');
    expect(byId(doc.technologies, 'tienda-web-1-8-2').name).toBe('tienda-web:1.8.2');
  });

  it('jerarquías: unidades por composición, capacidades por composición o agregación; una colaboración no es un nivel', () => {
    expect(byId(doc.units, 'ventas').parentId).toBe('direccion-comercial');
    expect(byId(doc.units, 'equipo-plataforma').parentId).toBe('tecnologia-ti');
    expect(byId(doc.units, 'tecnologia-ti').parentId).toBeUndefined();
    expect(byId(doc.units, 'comite-de-transformacion-digital').parentId).toBeUndefined();
    expect(byId(doc.capabilities, 'ventas-online').parentId).toBe('gestion-comercial');
    expect(byId(doc.capabilities, 'contabilidad').parentId).toBe('gestion-financiera'); // una agregación
    expect(byId(doc.capabilities, 'fidelizacion').parentId).toBe('experiencia-del-cliente'); // composición y agregación repetidas: un solo padre
    expect(byId(doc.capabilities, 'gestion-comercial').parentId).toBeUndefined();
  });

  it('aplicaciones: propiedades en español e inglés, importes, fechas, estrategia y ciclo de vida', () => {
    expect(byId(doc.applications, 'tienda-online')).toEqual({
      id: 'tienda-online',
      name: 'Tienda online',
      technology: 'React + Node.js',
      ownerId: 'ventas',
      criticality: 'critical',
      annualCost: 180000,
      users: 25000,
      strategy: 'keep',
      ref: 'urn:iark:integration:tienda-web',
    });
    expect(byId(doc.applications, 'erp-corporativo')).toMatchObject({ technology: 'SAP S/4HANA', vendor: 'SAP', ownerId: 'finanzas', criticality: 'critical', annualCost: 1200000, users: 450, strategy: 'keep' });
    expect(byId(doc.applications, 'crm')).toMatchObject({ vendor: 'Salesforce', external: true, criticality: 'high', annualCost: 240000, users: 120, ownerId: 'ventas' });
    expect(byId(doc.applications, 'wms-heredado')).toMatchObject({ lifecycle: 'sunset', strategy: 'replace', endOfLife: '2027-03-31', criticality: 'high', annualCost: 90000, ownerId: 'logistica' });
    expect(byId(doc.applications, 'wms-nuevo')).toMatchObject({ lifecycle: 'planned', annualCost: 150000 });
    expect(byId(doc.applications, 'gestion-de-transporte')).toMatchObject({ annualCost: 48000, users: 35, external: true });
    expect(byId(doc.applications, 'portal-de-proveedores')).toMatchObject({ strategy: 'migrate', endOfLife: '2026-12' });
    expect(byId(doc.applications, 'contact-center').ownerId).toBe('atencion-al-cliente'); // la unidad, no la capacidad del mismo nombre
    expect(byId(doc.applications, 'contact-center').strategy).toBeUndefined(); // «Pendiente de decidir» no es una estrategia
    expect(byId(doc.applications, 'api-de-pedidos').tags).toEqual(['ApplicationService']);
    expect(byId(doc.applications, 'catalogo-de-productos').tags).toEqual(['DataObject']);
    expect(byId(doc.applications, 'suite-de-comercio-electronico').tags).toEqual(['ApplicationCollaboration']);
  });

  it('capacidades: importancia y madurez con sus formas de escribirse; el responsable por propiedad o por asignación', () => {
    expect(byId(doc.capabilities, 'gestion-comercial')).toMatchObject({ importance: 'core', ownerId: 'direccion-comercial' });
    expect(byId(doc.capabilities, 'ventas-online')).toMatchObject({ importance: 'differentiating', maturity: 4 });
    expect(byId(doc.capabilities, 'gestion-de-pedidos')).toMatchObject({ importance: 'core', maturity: 4 }); // «Nivel 4»
    expect(byId(doc.capabilities, 'precios-y-promociones')).toMatchObject({ importance: 'differentiating', maturity: 3 }); // «Defined»
    expect(byId(doc.capabilities, 'distribucion-y-entrega')).toMatchObject({ maturity: 2, ownerId: 'logistica' }); // «2/5» y la asignación de Logística
    expect(byId(doc.capabilities, 'compras-proveedores')).toMatchObject({ importance: 'supporting', maturity: 3 }); // «Soporte»
    expect(byId(doc.capabilities, 'contabilidad')).toMatchObject({ importance: 'supporting', maturity: 5 }); // «Optimizado»
  });

  it('tecnología: tipo por tipo de ArchiMate y por nombre, versión, fin de soporte y ciclo de vida', () => {
    const kind = (id: string) => byId(doc.technologies, id).kind;
    expect([kind('aws-sa-east-1'), kind('terminal-de-almacen'), kind('kubernetes-1-29'), kind('postgresql-16'), kind('sap-hana-2-0'), kind('apache-kafka-3-6'), kind('servicio-de-colas-gestionado'), kind('tienda-web-1-8-2')]).toEqual([
      'infrastructure',
      'infrastructure',
      'platform',
      'database',
      'database',
      'middleware',
      'service',
      'platform',
    ]);
    expect(byId(doc.technologies, 'kubernetes-1-29').version).toBe('1.29');
    expect(byId(doc.technologies, 'sap-hana-2-0')).toMatchObject({ endOfLife: '2034-12', ownerId: 'tecnologia-ti' });
    expect(byId(doc.technologies, 'oracle-database-11g')).toMatchObject({ lifecycle: 'sunset', endOfLife: '2020-12' });
    expect(byId(doc.technologies, 'cpd-bogota')).toMatchObject({ lifecycle: 'sunset', endOfLife: '2027-12' }); // un año solo es a final de año
    expect(byId(doc.technologies, 'terminal-de-almacen').tags).toEqual(['Device']);
    expect(byId(doc.technologies, 'tienda-web-1-8-2').tags).toEqual(['Artifact']);
    expect(byId(doc.technologies, 'aws-sa-east-1').ownerId).toBe('equipo-plataforma'); // una asignación de unidad a nodo
  });

  it('procesos y servicios de negocio: funciones e interacciones llevan su tipo; la audiencia, de la propiedad o de a quién sirven', () => {
    expect(byId(doc.processes, 'gestion-de-catalogo').tags).toEqual(['BusinessFunction']);
    expect(byId(doc.processes, 'atencion-de-reclamaciones').tags).toEqual(['BusinessInteraction']);
    expect(byId(doc.processes, 'alta-de-pedido').tags).toBeUndefined();
    expect(byId(doc.processes, 'alta-de-pedido').ownerId).toBe('ventas'); // quien tiene la asignación
    expect(byId(doc.businessServices, 'venta-online').audience).toBe('Clientes particulares');
    expect(byId(doc.businessServices, 'entrega-a-domicilio').audience).toBe('Cliente');
    expect(byId(doc.units, 'cliente').external).toBe(true);
  });

  it('flujos de valor: las etapas siguen el orden de sus flujos, no el del archivo; un flujo suelto recibe una etapa', () => {
    expect(doc.valueStages.filter((s) => s.streamId === 'del-pedido-a-la-entrega').map((s) => s.id)).toEqual(['descubrir-producto', 'comprar', 'preparar-el-pedido', 'entregar-al-cliente']);
    expect(byId(doc.valueStreams, 'del-pedido-a-la-entrega')).toMatchObject({ stakeholder: 'Cliente', description: expect.stringContaining('hasta que lo recibe') });
    expect(byId(doc.valueStages, 'descubrir-producto').description).toBe('El cliente encuentra lo que busca.');
    expect(byId(doc.valueStages, 'atencion-posventa-etapa')).toMatchObject({ name: 'Atención posventa', streamId: 'atencion-posventa' });
    expect(triples(doc).filter((t) => t.startsWith('enables'))).toEqual([
      'enables ventas-online descubrir-producto',
      'enables ventas-online comprar',
      'enables gestion-de-pedidos comprar',
      'enables gestion-de-inventario preparar-el-pedido',
      'enables distribucion-y-entrega entregar-al-cliente',
      'enables atencion-al-cliente-2 atencion-posventa-etapa',
    ]);
  });

  it('relaciones: cada tipo de ArchiMate llega a su relación del módulo, con el sentido que corresponde', () => {
    const expected = [
      'assigned-to ventas alta-de-pedido', // Assignment
      'realizes alta-de-pedido gestion-de-pedidos', // Realization, a través de una unión And
      'realizes alta-de-pedido ventas-online',
      'exposes venta-online alta-de-pedido', // Realization proceso → servicio, del servicio al proceso
      'supports tienda-online ventas-online', // Realization app → capacidad
      'supports erp-corporativo alta-de-pedido', // Serving app → proceso
      'flows-to tienda-online erp-corporativo', // Flow
      'flows-to wms-heredado gestion-de-transporte', // Triggering entre aplicaciones
      'triggers alta-de-pedido preparacion-de-pedido', // Triggering a través de un evento
      'composes suite-de-comercio-electronico tienda-online', // Aggregation
      'depends-on tienda-online catalogo-de-productos', // Access
      'depends-on crm api-de-pedidos', // Serving servicio → componente: el servido depende
      'depends-on api-de-pedidos tienda-online', // Realization componente → servicio: lo realizado depende
      'runs-on tienda-online tienda-web-1-8-2', // Realization artefacto → aplicación
      'runs-on erp-corporativo sap-hana-2-0', // Serving tecnología → aplicación
      'composes aws-sa-east-1 kubernetes-1-29', // Composition
      'depends-on tienda-web-1-8-2 aws-sa-east-1', // Assignment nodo → artefacto: lo desplegado depende del nodo
      'realizes gestion-de-catalogo precios-y-promociones', // Association proceso — capacidad
      'flows-to gestion-de-catalogo alta-de-pedido', // Serving proceso → proceso
    ];
    for (const t of expected) expect(triples(doc), t).toContain(t);
    expect(rel(doc, 'triggers', 'alta-de-pedido', 'preparacion-de-pedido')?.description).toBe('Pedido recibido');
    expect(rel(doc, 'flows-to', 'tienda-online', 'erp-corporativo')?.description).toBe('pedidos confirmados');
    // lo que no tiene equivalente no se inventa
    expect(doc.relations.filter((r) => [r.sourceId, r.targetId].includes('cliente'))).toEqual([]); // un actor externo no entra en ninguna relación del módulo
    expect(rel(doc, 'depends-on', 'tienda-online', 'crm')).toBeUndefined();
  });

  it('resume en los avisos todo lo que no se importa o se convierte', () => {
    const text = warnings.join('\n');
    for (const fragment of [
      '4 elementos de motivación sin equivalente en el módulo, no se importan (Driver, Goal, Requirement, Stakeholder)',
      '2 elementos de estrategia sin equivalente en el módulo, no se importan (CourseOfAction, Resource): «Plataforma de datos de clientes»',
      '2 elementos de implementación y migración',
      '«Interfaz REST de la tienda»',
      '«Red corporativa»',
      '1 unión (And/Or) y 1 evento no se importan como elemento',
      '1 flujo de valor sin etapas («Atención posventa»)',
      '8 relaciones omitidas porque un extremo no se importa: elementos de aplicación (1), elementos de tecnología (1), elementos de motivación (4), elementos de implementación y migración (2)',
      '3 relaciones Aggregation (colaboración de negocio → unidad) sin equivalente',
      '1 relación Serving (aplicación → unidad) sin equivalente',
      '1 relación Association (aplicación → aplicación) sin equivalente',
      '1 relación Flow (tecnología → tecnología) sin equivalente',
      '1 relación Triggering (aplicación → aplicación) se importa como «fluye hacia»',
      '2 relaciones Access (aplicación → aplicación) se importan como «depende de»',
      '2 relaciones Assignment (unidad → capacidad) se importan como responsable',
      '1 relación Association (proceso → capacidad) se importa como «realiza»',
      '1 relación omitida por repetir otra igual tras la conversión',
      'Propiedades sin equivalente en el módulo, no se importan: «Centro de coste» (1), «Estado» (1), «Jira project» (1), «Owner» (1), «Owner email» (1)',
      '1 valor de propiedad no se entiende y se omite: «Estrategia» = «Pendiente de decidir» en «Contact center»',
      '2 vistas (diagramas) no se importan: el módulo deriva las suyas del modelo («Mapa de capacidades», «Paisaje de aplicaciones»)',
    ]) {
      expect(text, fragment).toContain(fragment);
    }
    expect(warnings.length).toBeLessThan(40);
  });

  it('pasa por las reglas de gobierno sin errores y solo con avisos que son ciertos', () => {
    const issues = analyzeEnterprise(doc, { today: TODAY });
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(issues.filter((i) => i.severity === 'warning').map((i) => i.message)).toEqual([
      'Capacidad «Fidelización» no está soportada por ninguna aplicación.',
      'Tecnología «Oracle Database 11g» está fuera de soporte desde 2020-12.',
    ]);
    // lo que se dice del ERP: lo soporta todo lo que se declaró y corre sobre HANA, no queda sin responsable
    expect(issues.filter((i) => i.elementId === 'erp-corporativo')).toEqual([]);
  });

  it('se ve en el lienzo: mapa de capacidades, flujos de valor, paisaje, hoja de ruta, unidades e impacto', async () => {
    const views = listViews(doc);
    expect(views.map((v) => v.id)).toEqual(expect.arrayContaining(['capabilities', 'value-stream', 'landscape', 'roadmap', 'unit:ventas', 'unit:logistica']));
    expect(viewRefs(doc).map((v) => v.id)).toEqual(expect.arrayContaining(['capabilities', 'capabilities:criticality', 'capabilities:lifecycle', 'impact:hana'].filter((id) => !id.startsWith('impact'))));
    const roadmap = views.find((v) => v.id === 'roadmap')!;
    expect(roadmap.elementIds).toEqual(expect.arrayContaining(['wms-heredado', 'portal-de-proveedores', 'oracle-database-11g', 'cpd-bogota', 'wms-nuevo']));
    for (const id of ['capabilities', 'capabilities:criticality', 'value-stream', 'roadmap', 'impact:sap-hana-2-0', 'depends:tienda-online', 'unit:finanzas']) {
      const svg = await toSvg(doc, id);
      expect(svg, id).toContain('<svg');
      expect(svg, id).not.toContain('NaN');
    }
    expect(await toSvg(doc, 'capabilities')).toContain('Gestión de pedidos');
    expect(await toSvg(doc, 'value-stream')).toContain('Preparar el pedido');
    // el impacto de HANA llega al ERP y, por él, a lo que soporta
    const graph = dependencyGraph(doc);
    const impacted = reach(graph, 'sap-hana-2-0', 'dependents').map((s) => s.id);
    expect(impacted).toEqual(expect.arrayContaining(['erp-corporativo', 'alta-de-pedido', 'facturacion', 'contabilidad', 'gestion-de-pedidos']));
    expect(impacted).not.toContain('crm');
  }, 60_000);

  it('se exporta a Mermaid, SVG y draw.io, y el Mermaid vuelve a importarse', async () => {
    for (const view of ['capabilities', 'landscape', 'value-stream']) {
      const mmd = toMermaid(doc, { viewId: view });
      expect(mmd.length).toBeGreaterThan(50);
    }
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(await toDrawio(doc));
    expect(parsed.mxfile.diagram.length).toBeGreaterThanOrEqual(4);
    const back = fromMermaid(toMermaid(doc, { viewId: 'landscape' })).document;
    expect(back.applications.map((a) => a.id)).toEqual(expect.arrayContaining(['tienda-online', 'erp-corporativo']));
    expect(await toSvg(doc, 'landscape')).toContain('ERP corporativo');
  }, 60_000);

  it('importar dos veces el mismo archivo da el mismo documento y los mismos avisos; BOM y saltos de línea no cambian nada', () => {
    const text = fixture('comercio-andino.xml');
    const again = fromArchimate(text);
    expect(again.document).toEqual(doc);
    expect(again.warnings).toEqual(warnings);
    const crlf = fromArchimate(`﻿${text.replace(/\n/g, '\r\n')}`);
    expect(crlf.document).toEqual(doc);
    expect(crlf.warnings).toEqual(warnings);
  });
});

describe('importar ArchiMate: modelo en inglés, sin xml:lang', () => {
  const { document: doc, warnings } = fromArchimate(fixture('bizbank-en.xml'));

  it('lee nombres sin idioma, propiedades en inglés y valores de cada formato', () => {
    expect(doc.workspace).toEqual({ name: 'BizBank - retail banking architecture', description: 'Capabilities, applications and technology behind the retail bank.' });
    expect(byId(doc.units, 'cards-payments').name).toBe('Cards & Payments');
    expect(byId(doc.units, 'retail-banking')).toMatchObject({ name: 'Retail Banking' });
    expect(byId(doc.units, 'cards-payments').parentId).toBe('retail-banking');
    expect(byId(doc.capabilities, 'customer-onboarding')).toMatchObject({ importance: 'differentiating', maturity: 2, ownerId: 'retail-banking' });
    expect(byId(doc.capabilities, 'kyc-aml-screening')).toMatchObject({ parentId: 'customer-onboarding', importance: 'core', maturity: 3, ownerId: 'risk-compliance' }); // «3 of 5»
    expect(byId(doc.capabilities, 'payments-processing')).toMatchObject({ importance: 'core', maturity: 4 });
    expect(byId(doc.capabilities, 'card-issuing')).toMatchObject({ importance: 'supporting', maturity: 2 }); // «Commodity», «Managed»
    expect(byId(doc.applications, 'mobile-banking-app')).toMatchObject({ annualCost: 1200000, users: 1250000, strategy: 'keep', criticality: 'critical', ownerId: 'retail-banking' });
    expect(byId(doc.applications, 'mobile-banking-app').lifecycle).toBe('active'); // «Production»
    expect(byId(doc.applications, 'core-banking')).toMatchObject({ vendor: 'Temenos', annualCost: 4500000, users: 3200, strategy: 'retire', endOfLife: '2028-06-30', lifecycle: 'sunset', criticality: 'critical', ownerId: 'it-operations' });
    expect(byId(doc.applications, 'core-banking-next-gen').lifecycle).toBe('planned');
    expect(byId(doc.applications, 'screening-engine')).toMatchObject({ vendor: 'Fenergo', external: true, criticality: 'high' }); // «SaaS»
    expect(byId(doc.technologies, 'ibm-db2-luw-11-5')).toMatchObject({ kind: 'database', endOfLife: '2027-04' }); // «Apr 2027»
    expect(byId(doc.technologies, 'amazon-eks').kind).toBe('platform');
    expect(byId(doc.businessServices, 'online-account-opening').audience).toBe('Retail customers');
  });

  it('relaciones: el ERP-equivalente corre en su base de datos, el servicio de colas lo ofrece un nodo y no inventa la sustitución', () => {
    for (const t of [
      'supports mobile-banking-app customer-onboarding',
      'supports core-banking payments-processing',
      'supports core-banking-next-gen payments-processing',
      'runs-on core-banking ibm-db2-luw-11-5',
      'runs-on mobile-banking-app amazon-eks',
      'runs-on card-management managed-message-queue',
      'depends-on ibm-db2-luw-11-5 primary-data-center',
      'composes aws-eu-west-1 managed-message-queue',
      'flows-to mobile-banking-app core-banking',
      'flows-to core-banking card-management',
      'triggers open-account screen-applicant',
      'flows-to screen-applicant clear-payment',
      'exposes online-account-opening open-account',
    ]) {
      expect(triples(doc), t).toContain(t);
    }
    expect(rel(doc, 'triggers', 'open-account', 'screen-applicant')?.description).toBe('applicant data');
    expect(warnings.join('\n')).toContain('1 relación Association (aplicación → aplicación) sin equivalente en el módulo, omitida: «Core banking» → «Core banking (next gen)»');
    expect(warnings.join('\n')).toContain('2 relaciones Assignment (tecnología → tecnología) se importan como «depende de»');
  });

  it('el módulo lo gobierna sin errores ni avisos espurios, y el fin de soporte vencido sí avisa', () => {
    const issues = analyzeEnterprise(doc, { today: TODAY });
    expect(issues.filter((i) => i.severity !== 'info')).toEqual([]); // la retirada de «Core banking» tiene su sustituta
    expect(issues.map((i) => i.message)).toContain('Tecnología «IBM Db2 LUW 11.5» sale de soporte el 2027-04.');
    const later = analyzeEnterprise(doc, { today: new Date('2028-09-01T00:00:00Z') }).filter((i) => i.severity === 'warning');
    expect(later.map((i) => i.message)).toEqual(['Tecnología «IBM Db2 LUW 11.5» está fuera de soporte desde 2027-04.']);
  });
});

describe('importar ArchiMate: el formato nativo de Archi (.archimate)', () => {
  const { document: doc, warnings } = fromArchimate(fixture('tienda-archi.archimate'));

  it('recorre las carpetas, lee nombres y propiedades de atributos y resuelve uniones y eventos', () => {
    expect(doc.workspace).toEqual({ name: 'Tienda de barrio', description: 'Modelo de una tienda de barrio con TPV y caja.' });
    expect(doc.units.map((u) => u.id)).toEqual(['tendero', 'clientela']);
    expect(byId(doc.units, 'clientela').external).toBe(true);
    expect(byId(doc.capabilities, 'venta-al-publico')).toMatchObject({ importance: 'differentiating', maturity: 3, description: 'Vender en mostrador y por encargo.' });
    expect(byId(doc.capabilities, 'cobro')).toMatchObject({ parentId: 'venta-al-publico', importance: 'core', maturity: 4 });
    expect(byId(doc.processes, 'cobrar-en-caja')).toMatchObject({ description: 'Cobro con tarjeta o efectivo.', ownerId: 'tendero' });
    expect(byId(doc.applications, 'tpv')).toMatchObject({ annualCost: 1800, users: 3, criticality: 'high', endOfLife: '2028-01', ownerId: 'tendero' });
    expect(byId(doc.applications, 'hoja-de-existencias')).toMatchObject({ strategy: 'migrate', lifecycle: 'sunset' });
    expect(byId(doc.technologies, 'sqlite').kind).toBe('database');
    expect(byId(doc.valueStreams, 'de-la-visita-a-la-compra').stakeholder).toBe('Clientela');
    expect(doc.valueStages.map((s) => s.id)).toEqual(['entrar', 'pagar']);
    for (const t of [
      'triggers cobrar-en-caja reponer-estantes', // a través del evento «Cliente en caja»
      'depends-on hoja-de-existencias inventario',
      'flows-to tpv hoja-de-existencias',
      'runs-on tpv sqlite',
      'runs-on tpv tpv-apk',
      'exposes venta-en-tienda cobrar-en-caja',
      'enables venta-al-publico entrar',
      'enables cobro pagar',
    ]) {
      expect(triples(doc), t).toContain(t);
    }
    expect(rel(doc, 'triggers', 'cobrar-en-caja', 'reponer-estantes')?.description).toBe('Cliente en caja');
    expect(rel(doc, 'flows-to', 'tpv', 'hoja-de-existencias')?.description).toBe('ventas del día');
  });

  it('avisa de lo que no se importa y de las vistas (diagramas y bocetos)', () => {
    const text = warnings.join('\n');
    expect(text).toContain('«Cobrar sin colas»');
    expect(text).toContain('«Local comercial»');
    expect(text).toContain('2 vistas (diagramas) no se importan: el módulo deriva las suyas del modelo («Vista general», «Boceto del local»)');
    expect(text).toContain('Propiedades sin equivalente en el módulo, no se importan: «Autor» (1)');
    expect(validateEnterpriseDocument(doc).ok).toBe(true);
  });
});

describe('importar ArchiMate: lo que no se sabe mapear', () => {
  const { document: doc, warnings } = fromArchimate(fixture('sin-mapear.xml'));
  const text = warnings.join('\n');

  it('importa lo que sí encaja y el documento valida', () => {
    expect(validateEnterpriseDocument(doc).ok).toBe(true);
    expect(doc.capabilities.map((c) => c.id)).toEqual(['atencion-omnicanal', 'canal-movil', 'canal-web', 'capacidad-circular-a', 'capacidad-circular-b']);
    expect(doc.processes.map((p) => p.name)).toEqual(['Abrir cuenta', 'Sin nombre (p-sin-nombre)', 'Cerrar cuenta']);
    expect(byId(doc.capabilities, 'canal-movil').name).toBe('Canal móvil'); // el salto de línea del nombre se colapsa
    expect(byId(doc.capabilities, 'atencion-omnicanal')).toEqual({ id: 'atencion-omnicanal', name: 'Atención omnicanal', maturity: 3 }); // la copia con el mismo identificador no se importa
    expect(byId(doc.capabilities, 'canal-movil').maturity).toBeUndefined(); // 9 no es una madurez
    expect(byId(doc.applications, 'chatbot')).toEqual({ id: 'chatbot', name: 'Chatbot', ownerId: 'canal-digital' });
    expect(doc.units).toEqual([{ id: 'canal-digital', name: 'Canal Digital' }]);
    expect(byId(doc.businessServices, 'apertura-digital').audience).toBe('Junta directiva');
  });

  it('resume por categorías los elementos sin equivalente', () => {
    for (const fragment of [
      '9 elementos de motivación sin equivalente en el módulo, no se importan (Assessment, Constraint, Driver, Goal, Outcome, Principle, Requirement, Stakeholder, Value)',
      '2 elementos de estrategia sin equivalente en el módulo, no se importan (CourseOfAction, Resource): «Equipo de datos», «Consolidar canales»',
      '4 elementos de implementación y migración sin equivalente en el módulo, no se importan (Deliverable, Gap, Plateau, WorkPackage)',
      '2 elementos de negocio sin equivalente en el módulo, no se importan (BusinessObject, Product)',
      '2 elementos de aplicación sin equivalente en el módulo, no se importan (ApplicationFunction, ApplicationInterface)',
      '1 elemento de tecnología sin equivalente en el módulo, no se importa (TechnologyFunction)',
      '1 elemento de la capa física sin equivalente en el módulo, no se importa (Equipment)',
      '2 elementos de otro tipo sin equivalente en el módulo, no se importan (Grouping, Location)',
      '1 elemento de un tipo desconocido sin equivalente en el módulo, no se importa (TipoDelFuturo): «Algo que aún no existe»',
      '1 vista (diagrama) no se importa: el módulo deriva las suyas del modelo («Vista de canales»)',
    ]) {
      expect(text, fragment).toContain(fragment);
    }
  });

  it('avisa de elementos sin nombre, identificadores repetidos, uniones y eventos', () => {
    expect(text).toContain('1 elemento sin nombre: se importa como «Sin nombre (identificador)»');
    expect(text).toContain('1 identificador repetido en el archivo: se conserva la primera definición');
    expect(text).toContain('1 unión (And/Or) y 1 evento no se importan como elemento');
    expect(text).toContain('3 relaciones omitidas por entrar o salir de una unión o un evento sin continuación compatible');
    // la unión Or sí se resolvió; el evento dio su nombre al disparo
    expect(triples(doc)).toEqual(expect.arrayContaining(['realizes abrir-cuenta atencion-omnicanal', 'realizes abrir-cuenta canal-movil', 'triggers abrir-cuenta cerrar-cuenta']));
    expect(rel(doc, 'triggers', 'abrir-cuenta', 'cerrar-cuenta')?.description).toBe('Cuenta abierta');
  });

  it('avisa de las relaciones que se pierden, de las que se convierten y de las jerarquías imposibles', () => {
    for (const fragment of [
      '2 relaciones omitidas porque un extremo no se importa: elementos de motivación (2)',
      '1 relación omitida por unir una relación con otro elemento',
      '1 relación omitida por apuntar a un identificador que no existe en el modelo',
      '1 relación Specialization (capacidad → capacidad) sin equivalente en el módulo, omitida',
      '1 relación Association (capacidad → capacidad) sin equivalente en el módulo, omitida',
      '1 relación Flow (flujo de valor → flujo de valor) sin equivalente en el módulo, omitida: «Cierre de cuenta» → «Ciclo de vida del cliente»',
      '1 relación Serving (capacidad → flujo de valor) se importa como «habilita a»',
      '1 jerarquía circular omitida: «Capacidad circular A» y «Capacidad circular B» (capacidades)',
    ]) {
      expect(text, fragment).toContain(fragment);
    }
    expect(byId(doc.capabilities, 'capacidad-circular-b').parentId).toBe('capacidad-circular-a');
    expect(byId(doc.capabilities, 'capacidad-circular-a').parentId).toBeUndefined();
  });

  it('flujos de valor: una cadena de sueltos son etapas de un flujo nuevo, las subetapas se aplanan y el aislado recibe una etapa', () => {
    expect(doc.valueStreams.map((s) => s.name)).toEqual(['Flujo de valor: Captación → Fidelización', 'Ciclo de vida del cliente', 'Cierre de cuenta']);
    expect(doc.valueStages.map((s) => `${s.streamId}/${s.id}`)).toEqual([
      'flujo-de-valor-captacion-fidelizacion/captacion',
      'flujo-de-valor-captacion-fidelizacion/activacion',
      'flujo-de-valor-captacion-fidelizacion/fidelizacion',
      'ciclo-de-vida-del-cliente/verificar-identidad',
      'ciclo-de-vida-del-cliente/firmar-contrato',
      'ciclo-de-vida-del-cliente/uso-diario',
      'cierre-de-cuenta/cierre-de-cuenta-etapa',
    ]);
    expect(byId(doc.valueStreams, 'ciclo-de-vida-del-cliente').stakeholder).toBe('Junta directiva');
    expect(triples(doc).filter((t) => t.startsWith('enables'))).toEqual(['enables canal-web verificar-identidad', 'enables canal-web firmar-contrato', 'enables canal-web uso-diario']);
    expect(text).toContain('1 cadena de flujos de valor sueltos unidos por flujo o disparo');
    expect(text).toContain('Etapas con subetapas aplanadas (solo se conservan las subetapas): «Incorporación»');
    expect(text).toContain('1 flujo de valor sin etapas («Cierre de cuenta»): recibe una etapa con su mismo nombre');
  });

  it('enumera propiedades sin equivalente y valores que no se entienden, sin descartarlos en silencio', () => {
    expect(text).toContain('Propiedades sin equivalente en el módulo, no se importan: «Autor» (1), «Estado» (1), «Madurez» (1), «Prioridad» (1)');
    expect(text).toContain('5 valores de propiedad no se entienden y se omiten: «Madurez» = «9» en «Canal móvil»');
    expect(text).toContain('«Coste anual» = «-5» en «Chatbot»');
    expect(text).toContain('«Fin de soporte» = «pronto» en «Chatbot»');
    expect(text).toContain('1 unidad creada a partir de la propiedad de responsable (el modelo no tiene un actor con ese nombre): «Canal Digital»');
  });

  it('un modelo en que nada se puede importar es un error claro', () => {
    const only = model([{ id: 'g', type: 'Goal', name: 'Crecer' }, { id: 'r', type: 'Resource', name: 'Equipo' }]);
    expect(() => fromArchimate(only)).toThrow(EnterpriseImportError);
    expect(() => fromArchimate(only)).toThrow(/Ningún elemento del modelo de ArchiMate se puede importar: los 2 que tiene/);
    expect(() => fromArchimate(model([]))).toThrow(/no contiene elementos/);
  });
});

describe('importar ArchiMate: errores de entrada', () => {
  it('XML roto: dice qué falla y dónde', () => {
    const run = () => fromArchimate(fixture('xml-roto.xml'));
    expect(run).toThrow(EnterpriseImportError);
    expect(run).toThrow(ModuleError);
    expect(run).toThrow(/^XML mal formado: se esperaba «<\/elements>» \(abierta en la línea 8, columna 3\) y se encontró «<\/model>» \(línea 20, columna 1\)\.$/);
    expect(() => fromArchimate('<model xmlns="http://www.opengroup.org/xsd/archimate/3.0/"><elements></model>')).toThrow(/XML mal formado: se esperaba «<\/elements>»/);
    expect(() => fromArchimate('<model xmlns="http://www.opengroup.org/xsd/archimate/3.0/"><elements>')).toThrow(/^XML mal formado: el documento termina con etiquetas sin cerrar \(«<model>», «<elements>»\)\.$/);
    expect(() => fromArchimate('<model a="1" a="2"></model>')).toThrow(/el atributo «a» está repetido/);
    expect(() => fromArchimate('<model xmlns="http://www.opengroup.org/xsd/archimate/3.0/">')).toThrow(/^XML mal formado: la etiqueta «<model>» no se cierra \(línea 1, columna 1\)\.$/);
  });

  it('entradas que no son un modelo de ArchiMate', () => {
    expect(() => fromArchimate('')).toThrow(/está vacío/);
    expect(() => fromArchimate('  \n ')).toThrow(/está vacío/);
    expect(() => fromArchimate('<?xml version="1.0"?>\n<mxfile><diagram/></mxfile>')).toThrow(/La raíz del XML es «mxfile»: un modelo de ArchiMate empieza por «model»/);
    expect(() => fromArchimate('<model><elements/></model>')).toThrow(/La raíz «model» no declara el espacio de nombres de ArchiMate/);
    expect(() => fromArchimate('<model xmlns="urn:otro"><elements/></model>')).toThrow(/no declara el espacio de nombres de ArchiMate/);
    expect(() => fromArchimate('flowchart LR\n a --> b')).toThrow(/XML mal formado|raíz/);
    expect(() => fromArchimate('{"version":"1.0"}')).toThrow(EnterpriseImportError);
  });

  it('no admite entidades propias (expansión de entidades)', () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY a "x">]>\n<model ${NS}><name>&a;</name></model>`;
    expect(() => fromArchimate(bomb)).toThrow(/declara entidades propias/);
  });

  it('un nombre de tipo como constructor o __proto__ no confunde al importador', () => {
    const { document: doc, warnings } = run(
      [
        { id: 'a', type: 'constructor', name: 'Raro' },
        { id: 'b', type: '__proto__', name: 'Más raro' },
        { id: 'c', type: 'Capability', name: 'Capacidad' },
      ],
      [['constructor', 'a', 'c'], ['__proto__', 'c', 'c']],
    );
    expect(doc.capabilities.map((c) => c.id)).toEqual(['capacidad']);
    expect(warnings.join('\n')).toContain('2 elementos de un tipo desconocido');
  });
});

describe('importar ArchiMate: detección del formato', () => {
  it('reconoce el formato de intercambio y el nativo de Archi, con prólogo, comentarios y BOM', () => {
    expect(looksLikeArchimate(fixture('comercio-andino.xml'))).toBe(true);
    expect(archimateFormat(fixture('comercio-andino.xml'))).toBe('exchange');
    expect(archimateFormat(fixture('tienda-archi.archimate'))).toBe('archi');
    expect(looksLikeArchimate(`﻿<?xml version="1.0"?>\n<!-- c -->\n<!DOCTYPE model>\n<model ${NS}/>`)).toBe(true);
    expect(looksLikeArchimate(`<archimate:model xmlns:archimate="http://www.opengroup.org/xsd/archimate/3.0/"/>`)).toBe(true);
    expect(looksLikeArchimate(`<m:model xmlns:m="http://www.opengroup.org/xsd/archimate/3.0/" name="x"></m:model>`)).toBe(true);
  });

  it('no confunde con Mermaid, JSON, otros XML ni un <model> sin el espacio de nombres', () => {
    for (const text of [
      'flowchart LR\n  a --> b',
      '{"version":"1.0","model":{}}',
      '<mxfile><diagram/></mxfile>',
      '<model><elements/></model>',
      '<model xmlns="http://example.com/otro"/>',
      '<?xml version="1.0"?><project xmlns="http://www.opengroup.org/xsd/archimate/3.0/"/>',
      '',
      'texto cualquiera',
      '<!-- sin cerrar',
    ]) {
      expect(looksLikeArchimate(text), text).toBe(false);
    }
    expect(looksLikeMermaid(fixture('comercio-andino.xml'))).toBe(false);
  });

  it('el módulo lo ofrece junto a Mermaid y lo elige por la extensión o por el contenido', async () => {
    expect(enterpriseModule.importers.map((i) => i.id)).toEqual(['mermaid', 'archimate', 'bpmn']);
    const archimate = enterpriseModule.importers.find((i) => i.id === 'archimate')!;
    expect(archimate.extensions).toEqual(['.xml', '.archimate']);
    expect(archimate.detect!(fixture('bizbank-en.xml'))).toBe(true);
    expect(enterpriseModule.importers[0].detect!(fixture('bizbank-en.xml'))).toBe(false);
    expect(archimate.detect!('flowchart LR\n a --> b')).toBe(false);
    const registry = new ModuleRegistry().register(enterpriseModule);
    expect(registry.detectImporter('enterprise', 'modelo.archimate', fixture('tienda-archi.archimate'))?.id).toBe('archimate');
    expect(registry.detectImporter('enterprise', 'export.xml', fixture('bizbank-en.xml'))?.id).toBe('archimate');
    expect(registry.detectImporter('enterprise', undefined, fixture('bizbank-en.xml'))?.id).toBe('archimate');
    expect(registry.detectImporter('enterprise', 'mapa.mmd', 'flowchart LR\n a --> b')?.id).toBe('mermaid');
    expect(registry.detectImporter('enterprise', undefined, '<mxfile/>')).toBeUndefined();
    const manifest = buildManifest(registry, { name: 'Prueba', version: '0.0.0' });
    expect(manifest.modules[0]).toMatchObject({ id: 'enterprise', importFormats: ['mermaid', 'archimate', 'bpmn'] });
    // la misma ruta que usan el CLI y el banco de trabajo
    const imported = await importText(enterpriseModule, fixture('bizbank-en.xml'));
    expect(imported.importer).toBe('archimate');
    expect((imported.document as EnterpriseDocument).capabilities).toHaveLength(4);
    const named = await importText(enterpriseModule, fixture('bizbank-en.xml'), 'archimate', { name: 'Mi banco' });
    expect((named.document as EnterpriseDocument).workspace.name).toBe('Mi banco');
    await expect(importText(enterpriseModule, fixture('xml-roto.xml'), 'archimate')).rejects.toThrow(/XML mal formado/);
  });

  it('el nombre sale de la opción, del modelo o del archivo (sin su extensión), y el idioma de extra.lang', () => {
    const noName = model([{ id: 'c', type: 'Capability', name: 'Capacidad' }]);
    expect(fromArchimate(noName).document.workspace.name).toBe('Arquitectura empresarial');
    expect(fromArchimate(noName, { fallbackName: 'mi-modelo.archimate' }).document.workspace.name).toBe('mi-modelo');
    expect(fromArchimate(noName, { fallbackName: 'export.xml' }).document.workspace.name).toBe('export');
    expect(fromArchimate(noName, { fallbackName: 'mi-modelo', name: 'Explícito' }).document.workspace.name).toBe('Explícito');
    const importer = enterpriseModule.importers.find((i) => i.id === 'archimate')!;
    const named = importer.import(fixture('comercio-andino.xml'), { extra: { lang: 'en' } }) as { document: EnterpriseDocument };
    expect(named.document.workspace.name).toBe('Comercio Andino - enterprise architecture');
  });
});

describe('importar ArchiMate: casos de estructura', () => {
  it('los ids salen del nombre y no cambian con los identificadores del archivo ni con el orden de las relaciones', () => {
    const elements = (ids: string[]): El[] => [
      { id: ids[0], type: 'Capability', name: 'Pedidos' },
      { id: ids[1], type: 'BusinessProcess', name: 'Pedidos' },
      { id: ids[2], type: 'ApplicationComponent', name: 'Pedidos' },
    ];
    const a = run(elements(['a', 'b', 'c']), [['Realization', 'b', 'a'], ['Serving', 'c', 'b']]).document;
    const b = run(elements(['id-1', 'id-2', 'id-3']), [['Serving', 'id-3', 'id-2'], ['Realization', 'id-2', 'id-1']]).document;
    expect([a.capabilities[0].id, a.processes[0].id, a.applications[0].id]).toEqual(['pedidos', 'pedidos-2', 'pedidos-3']);
    expect(b.capabilities.map((c) => c.id)).toEqual(['pedidos']);
    expect(new Set(triples(a))).toEqual(new Set(['realizes pedidos-2 pedidos', 'supports pedidos-3 pedidos-2']));
    expect(new Set(triples(b))).toEqual(new Set(triples(a)));
  });

  it('un nombre sin letras ni cifras da un id válido y los acentos desaparecen del id', () => {
    const { document: doc } = run([{ id: 'a', type: 'Capability', name: '¿¿??' }, { id: 'b', type: 'Capability', name: 'Gestión ÁÉÍÓÚ ñandú' }]);
    expect(doc.capabilities.map((c) => c.id)).toEqual(['capability', 'gestion-aeiou-nandu']);
  });

  it('varios padres: se conserva el primero y se avisa; un ciclo de unidades se omite', () => {
    const { document: doc, warnings } = run(
      [
        { id: 'p1', type: 'BusinessActor', name: 'Dirección A' },
        { id: 'p2', type: 'BusinessActor', name: 'Dirección B' },
        { id: 'h', type: 'BusinessActor', name: 'Equipo' },
        { id: 'x', type: 'BusinessActor', name: 'X' },
        { id: 'y', type: 'BusinessActor', name: 'Y' },
      ],
      [['Composition', 'p1', 'h'], ['Aggregation', 'p2', 'h'], ['Composition', 'x', 'y'], ['Composition', 'y', 'x']],
    );
    expect(byId(doc.units, 'equipo').parentId).toBe('direccion-a');
    expect(byId(doc.units, 'y').parentId).toBe('x');
    expect(byId(doc.units, 'x').parentId).toBeUndefined();
    expect(warnings).toContain('«Equipo» tiene varios padres («Dirección A», «Dirección B»): se conserva «Dirección A».');
    expect(warnings.join('\n')).toContain('1 jerarquía circular omitida: «X» y «Y» (unidades)');
  });

  it('uniones y eventos: la unión abre en abanico, solo con el mismo tipo; un evento solo sigue disparos y flujos', () => {
    const { document: doc, warnings } = run(
      [
        { id: 'a', type: 'BusinessProcess', name: 'A' },
        { id: 'b', type: 'BusinessProcess', name: 'B' },
        { id: 'c', type: 'BusinessProcess', name: 'C' },
        { id: 'd', type: 'BusinessProcess', name: 'D' },
        { id: 'j1', type: 'AndJunction' },
        { id: 'j2', type: 'OrJunction' },
        { id: 'e', type: 'BusinessEvent', name: 'Algo ocurre' },
      ],
      [
        ['Triggering', 'a', 'j1'],
        ['Triggering', 'j1', 'b'],
        ['Triggering', 'j1', 'c'],
        ['Flow', 'j1', 'd'], // un Flow tras un Triggering: no se sigue desde «a»
        ['Flow', 'b', 'j2'], // uniones encadenadas: b → j2 → j1 → d son todas Flow
        ['Flow', 'j2', 'j1'],
        ['Flow', 'c', 'e'],
        ['Triggering', 'e', 'd'], // evento: Flow y Triggering se siguen entre sí
      ],
    );
    expect(new Set(triples(doc))).toEqual(new Set(['triggers a b', 'triggers a c', 'flows-to b d', 'flows-to c d']));
    expect(rel(doc, 'flows-to', 'c', 'd')?.description).toBe('Algo ocurre');
    expect(doc.relations.filter((r) => r.sourceId === 'a')).toHaveLength(2);
    expect(warnings.join('\n')).toContain('2 uniones');
    expect(warnings.join('\n')).toContain('1 evento');
  });

  it('una unión que cierra un círculo no cuelga el importador', () => {
    const { document: doc } = run(
      [
        { id: 'a', type: 'BusinessProcess', name: 'A' },
        { id: 'b', type: 'BusinessProcess', name: 'B' },
        { id: 'j1', type: 'AndJunction' },
        { id: 'j2', type: 'AndJunction' },
      ],
      [['Flow', 'a', 'j1'], ['Flow', 'j1', 'j2'], ['Flow', 'j2', 'j1'], ['Flow', 'j2', 'b']],
    );
    expect(triples(doc)).toEqual(['flows-to a b']);
  });

  it('una relación que vuelve a su origen tras sustituir una unión se omite y se cuenta', () => {
    const { document: doc, warnings } = run(
      [{ id: 'a', type: 'BusinessProcess', name: 'A' }, { id: 'j', type: 'AndJunction' }],
      [['Flow', 'a', 'j'], ['Flow', 'j', 'a']],
    );
    expect(doc.relations).toEqual([]);
    expect(warnings.join('\n')).toContain('1 relación omitida por unir un elemento consigo mismo');
  });

  it('asociaciones: toman la relación que admiten los tipos de sus extremos, en cualquier sentido; entre el mismo tipo no se importan', () => {
    const { document: doc } = run(
      [
        { id: 'app', type: 'ApplicationComponent', name: 'App' },
        { id: 'cap', type: 'Capability', name: 'Cap' },
        { id: 'proc', type: 'BusinessProcess', name: 'Proc' },
        { id: 'node', type: 'Node', name: 'Nodo' },
        { id: 'svc', type: 'BusinessService', name: 'Servicio' },
        { id: 'unit', type: 'BusinessActor', name: 'Unidad' },
        { id: 'app2', type: 'ApplicationComponent', name: 'App 2' },
      ],
      [
        ['Association', 'cap', 'app'],
        ['Association', 'proc', 'app'],
        ['Association', 'node', 'app'],
        ['Association', 'svc', 'cap'],
        ['Association', 'proc', 'unit'],
        ['Association', 'app', 'app2'],
        ['Association', 'unit', 'node'],
      ],
    );
    expect(new Set(triples(doc))).toEqual(
      new Set(['supports app cap', 'supports app proc', 'runs-on app nodo', 'exposes servicio cap', 'assigned-to unidad proc']),
    );
  });

  it('el responsable: la propiedad manda sobre la asignación; si no existe la unidad, se crea una sola vez', () => {
    const { document: doc, warnings } = run(
      [
        { id: 'u1', type: 'BusinessActor', name: 'Ventas' },
        { id: 'u2', type: 'BusinessRole', name: 'Soporte' },
        { id: 'p', type: 'BusinessProcess', name: 'Proceso', props: { Responsable: 'Soporte' } },
        { id: 'a', type: 'ApplicationComponent', name: 'App', props: { owner: 'ventas' } },
        { id: 'b', type: 'ApplicationComponent', name: 'App B', props: { Propietario: 'Equipo Nuevo' } },
        { id: 'c', type: 'ApplicationComponent', name: 'App C', props: { Propietario: ' equipo  nuevo ' } },
        { id: 't', type: 'Node', name: 'Nodo' },
      ],
      [['Assignment', 'u1', 'p'], ['Assignment', 'u1', 'a'], ['Assignment', 'u2', 't'], ['Assignment', 'u1', 't']],
    );
    expect(byId(doc.processes, 'proceso').ownerId).toBe('soporte');
    expect(rel(doc, 'assigned-to', 'ventas', 'proceso')).toBeDefined();
    expect(byId(doc.applications, 'app').ownerId).toBe('ventas');
    expect(byId(doc.applications, 'app-b').ownerId).toBe('equipo-nuevo');
    expect(byId(doc.applications, 'app-c').ownerId).toBe('equipo-nuevo');
    expect(byId(doc.technologies, 'nodo').ownerId).toBe('soporte'); // la primera asignación
    expect(doc.units.map((u) => u.id)).toEqual(['ventas', 'soporte', 'equipo-nuevo']);
    expect(warnings.join('\n')).toContain('1 unidad creada a partir de la propiedad de responsable (el modelo no tiene un actor con ese nombre): «Equipo Nuevo»');
  });

  it('propiedades: la primera con valor válido manda, las vacías se ignoran y un campo ajeno al tipo se enumera', () => {
    const { document: doc, warnings } = run([
      { id: 'a', type: 'ApplicationComponent', name: 'App', props: { 'Coste anual': '', 'annual cost': '12.000 €', Users: '40' } },
      { id: 'n', type: 'Node', name: 'Nodo', props: { 'Coste anual': '5', 'Fin de soporte': '2029', Tipo: 'servidor', Version: '3' } },
      { id: 'c', type: 'Capability', name: 'Cap', props: { Madurez: 'alta', Estado: 'En producción' } },
    ]);
    expect(byId(doc.applications, 'app')).toMatchObject({ annualCost: 12000, users: 40 });
    expect(byId(doc.technologies, 'nodo')).toMatchObject({ endOfLife: '2029-12', kind: 'infrastructure', version: '3' });
    expect(warnings.join('\n')).toContain('Propiedades sin equivalente en el módulo, no se importan: «Coste anual» (1), «Estado» (1)');
    expect(warnings.join('\n')).toContain('«Madurez» = «alta» en «Cap»');
  });

  it('flujos de valor: composición, orden por flujo/disparo y ciclos entre ellos', () => {
    const streams = [
      { id: 's', type: 'ValueStream', name: 'Flujo' },
      { id: 'c', type: 'ValueStream', name: 'C' },
      { id: 'a', type: 'ValueStream', name: 'A' },
      { id: 'b', type: 'ValueStream', name: 'B' },
    ];
    const { document: doc } = run(streams, [
      ['Composition', 's', 'c'], ['Composition', 's', 'a'], ['Composition', 's', 'b'],
      ['Flow', 'a', 'b'], ['Triggering', 'b', 'c'],
    ]);
    expect(doc.valueStages.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(doc.valueStreams.map((s) => s.id)).toEqual(['flujo']);
    // un ciclo de flujos no cuelga y conserva todas las etapas
    const cyc = run(streams, [['Composition', 's', 'a'], ['Composition', 's', 'b'], ['Flow', 'a', 'b'], ['Flow', 'b', 'a']]).document;
    expect(cyc.valueStages.map((s) => s.id).sort()).toEqual(['a', 'b', 'c-etapa']); // «C», sin relaciones, es un flujo con una etapa
    // un flujo con dos padres conserva el primero y avisa de la relación sobrante
    const two = run(streams, [['Composition', 's', 'a'], ['Composition', 'c', 'a']]);
    expect(two.document.valueStages.map((s) => `${s.streamId}/${s.id}`)).toContain('flujo/a');
    expect(two.warnings.join('\n')).toContain('1 relación Composition (flujo de valor → flujo de valor) sin equivalente en el módulo, omitida');
  });

  it('un flujo con etapas y las relaciones de una capacidad: servir, realizar o asociar habilita las etapas; el destinatario sale de a quién sirve', () => {
    const { document: doc } = run(
      [
        { id: 'cap', type: 'Capability', name: 'Capacidad' },
        { id: 'cap2', type: 'Capability', name: 'Otra' },
        { id: 'who', type: 'BusinessRole', name: 'Cliente final' },
        { id: 'sh', type: 'Stakeholder', name: 'Accionista' },
        { id: 'u', type: 'BusinessActor', name: 'Dirección' },
        { id: 's', type: 'ValueStream', name: 'Flujo' },
        { id: 'a', type: 'ValueStream', name: 'Etapa A', props: { Valor: 'pedido confirmado' } },
        { id: 'b', type: 'ValueStream', name: 'Etapa B' },
      ],
      [
        ['Composition', 's', 'a'], ['Composition', 's', 'b'],
        ['Serving', 'cap', 'a'], ['Realization', 'cap', 'b'], ['Association', 'a', 'cap2'],
        ['Serving', 's', 'who'], ['Serving', 'b', 'sh'], ['Assignment', 'u', 's'],
      ],
    );
    expect(triples(doc)).toEqual(['enables capacidad etapa-a', 'enables capacidad etapa-b', 'enables otra etapa-a']);
    expect(doc.valueStreams[0]).toMatchObject({ stakeholder: 'Cliente final, Accionista', ownerId: 'direccion' });
    expect(byId(doc.valueStages, 'etapa-a').value).toBe('pedido confirmado');
  });

  it('una capacidad que sirve a un flujo con varias etapas las habilita todas y lo avisa', () => {
    const { document: doc, warnings } = run(
      [
        { id: 'cap', type: 'Capability', name: 'Capacidad' },
        { id: 's', type: 'ValueStream', name: 'Flujo' },
        { id: 'a', type: 'ValueStream', name: 'A' },
        { id: 'b', type: 'ValueStream', name: 'B' },
      ],
      [['Composition', 's', 'a'], ['Composition', 's', 'b'], ['Serving', 'cap', 's']],
    );
    expect(triples(doc)).toEqual(['enables capacidad a', 'enables capacidad b']);
    expect(warnings.join('\n')).toContain('la capacidad que sirve a un flujo habilita todas sus etapas');
  });

  it('las relaciones a elementos que no se importan, a identificadores que no existen o a otras relaciones se cuentan', () => {
    const { warnings } = run(
      [{ id: 'a', type: 'Capability', name: 'A' }, { id: 'g', type: 'Goal', name: 'G' }],
      [['Realization', 'a', 'g'], ['Serving', 'a', 'fantasma'], ['Association', 'rel1', 'a'], ['Association', 'a', 'a']],
    );
    const text = warnings.join('\n');
    expect(text).toContain('1 relación omitida porque un extremo no se importa: elementos de motivación (1)');
    expect(text).toContain('1 relación omitida por apuntar a un identificador que no existe');
    expect(text).toContain('1 relación omitida por unir una relación con otro elemento');
  });

  it('el idioma: el preferido, luego el sin idioma, luego el inglés y luego el primero; también para propiedades y regiones', () => {
    const xml = (names: string): string => `<model ${NS}><elements><element identifier="a" xsi:type="Capability">${names}</element></elements></model>`;
    const name = (names: string, lang?: string): string => fromArchimate(xml(names), { lang }).document.capabilities[0].name;
    const names = '<name xml:lang="fr">Pommes</name><name>Sin idioma</name><name xml:lang="en-US">Apples</name><name xml:lang="es-CO">Manzanas</name>';
    expect(name(names)).toBe('Manzanas'); // es-CO vale como español
    expect(name(names, 'en')).toBe('Apples');
    expect(name(names, 'fr')).toBe('Pommes');
    expect(name(names, 'de')).toBe('Sin idioma');
    expect(name('<name xml:lang="fr">Pommes</name><name xml:lang="en">Apples</name>', 'de')).toBe('Apples');
    expect(name('<name xml:lang="fr">Pommes</name><name xml:lang="it">Mele</name>', 'de')).toBe('Pommes');
    expect(name('<name>Uno</name>')).toBe('Uno'); // un solo nombre sin atributos: el parser lo da como texto, no como arreglo
    expect(name('<name xml:lang="en">Solo uno</name>')).toBe('Solo uno'); // un solo nombre con atributos: un objeto
  });

  it('un prefijo de espacio de nombres en las etiquetas y otro en xsi:type no importan', () => {
    const xml = `<a:model xmlns:a="http://www.opengroup.org/xsd/archimate/3.0/" xmlns:t="http://www.w3.org/2001/XMLSchema-instance"><a:name>Con prefijo</a:name><a:elements><a:element identifier="x" t:type="Capability"><a:name>Cap</a:name></a:element></a:elements></a:model>`;
    const { document: doc } = fromArchimate(xml);
    expect(doc.workspace.name).toBe('Con prefijo');
    expect(doc.capabilities.map((c) => c.id)).toEqual(['cap']);
  });

  it('elementos y relaciones sin lo imprescindible (identificador o tipo) se ignoran sin romper', () => {
    const xml = `<model ${NS}><elements><element xsi:type="Capability"><name>Sin id</name></element><element identifier="x"><name>Sin tipo</name></element><element identifier="ok" xsi:type="Capability"><name>Bien</name></element></elements><relationships><relationship source="ok" target="ok" xsi:type="Serving"/></relationships></model>`;
    expect(fromArchimate(xml).document.capabilities.map((c) => c.name)).toEqual(['Bien']);
  });

  it('un modelo grande se importa deprisa y sin repetir ids', () => {
    const elements: El[] = [];
    const relations: Array<[string, string, string]> = [];
    for (let i = 0; i < 400; i += 1) {
      elements.push({ id: `c${i}`, type: 'Capability', name: `Capacidad ${i % 50}` }, { id: `a${i}`, type: 'ApplicationComponent', name: `App ${i}`, props: { 'Coste anual': `${i}.000` } });
      relations.push(['Realization', `a${i}`, `c${i}`]);
      if (i > 0) relations.push(['Composition', `c${i - 1}`, `c${i}`]);
    }
    const t0 = Date.now();
    const { document: doc } = run(elements, relations);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(new Set(doc.capabilities.map((c) => c.id)).size).toBe(400);
    expect(doc.relations.filter((r) => r.kind === 'supports')).toHaveLength(400);
    expect(doc.capabilities[399].parentId).toBe(doc.capabilities[398].id);
  });
});
