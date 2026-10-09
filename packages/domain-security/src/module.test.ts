import { readFileSync } from 'node:fs';
import { buildManifest, ModuleError, ModuleRegistry } from '@iark/kernel';
import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { generatedToSecurity, securityAiSpec, toGenerated } from './ai/generation';
import { securityCommands } from './commands';
import { toDrawio } from './export/drawio';
import { toMermaid } from './export/mermaid';
import { layoutView, toSvg } from './export/render';
import { attackPaths, crossings, entryPoints, flowGraph, reach, zoneChain } from './graph';
import { fromIntegrationJson } from './import/fromIntegration';
import { fromMermaid, SecurityImportError } from './import/fromMermaid';
import { fromPlatformJson } from './import/fromPlatform';
import { applicableCategories, analyzeSecurity } from './issues';
import { securityModule } from './module';
import { formatSecurityIssues, validateSecurityDocument } from './schema';
import { RATING_LABELS, indexElements, residualOf, riskOf, type SecurityDocument } from './types';
import { findView, listViews, traceView } from './views';

const example = JSON.parse(readFileSync('examples/seguridad-ejemplo.json', 'utf8')) as unknown;
const parse = (input: unknown): SecurityDocument => {
  const r = validateSecurityDocument(input);
  if (!r.ok) throw new Error(formatSecurityIssues(r.issues));
  return r.document;
};
const doc = parse(example);
const messages = (d: SecurityDocument): string[] => analyzeSecurity(d).map((i) => i.message);
/** Copia del ejemplo con cambios: `edit` recibe un JSON mutable. */
const changed = (edit: (json: Record<string, Array<Record<string, unknown>>>) => void): SecurityDocument => {
  const json = JSON.parse(JSON.stringify(example)) as Record<string, Array<Record<string, unknown>>>;
  edit(json);
  return parse(json);
};
const byId = (json: Record<string, Array<Record<string, unknown>>>, key: string, id: string): Record<string, unknown> => json[key].find((x) => x.id === id)!;

describe('esquema de seguridad', () => {
  it('acepta el ejemplo y aplica valores por defecto', () => {
    expect(doc.zones).toHaveLength(4);
    expect(doc.assets).toHaveLength(11);
    expect(doc.flows).toHaveLength(10);
    expect(doc.threats).toHaveLength(10);
    expect(doc.controls).toHaveLength(12);
    expect(parse({}).workspace.name).toBe('Arquitectura de seguridad');
    expect(parse({}).flows).toEqual([]);
  });

  it('rechaza ids repetidos entre tipos, zonas mal anidadas, activos sin zona y URN inválidas', () => {
    const r = validateSecurityDocument({
      zones: [
        { id: 'a', name: 'A', parentId: 'b' },
        { id: 'b', name: 'B', parentId: 'a' },
        { id: 'c', name: 'C', parentId: 'c' },
        { id: 'd', name: 'D', parentId: 'nada' },
        { id: 'e', name: 'E', parentId: 'x1' },
      ],
      assets: [
        { id: 'x1', name: 'X1', kind: 'process', zoneId: 'nada' },
        { id: 'x2', name: 'X2', kind: 'process', zoneId: 'x1', ref: 'no-es-urn' },
        { id: 'x3', name: 'X3', kind: 'process', zoneId: 'a', encryptedAtRest: true },
        { id: 'a', name: 'Repite el id de una zona', kind: 'actor', zoneId: 'a' },
      ],
    });
    expect(r.ok).toBe(false);
    const text = r.ok ? '' : formatSecurityIssues(r.issues);
    for (const fragment of [
      'Id duplicado: "a" (ya lo usa zona)',
      'La jerarquía de zonas de "a" es circular',
      '"c" no puede ser su propio padre',
      '"d" referencia un padre inexistente: "nada"',
      'El padre de "e" debe ser una zona, pero "x1" es activo',
      '"x1" referencia una zona inexistente: "nada"',
      'La zona de "x2" debe ser una zona, pero "x1" es activo',
      'La referencia de "x2" no es una URN válida',
      '"x3" no es un almacén de datos',
    ]) {
      expect(text).toContain(fragment);
    }
  });

  it('valida los extremos de los flujos, el objetivo de las amenazas y los controles que citan', () => {
    const base = {
      zones: [{ id: 'z', name: 'Z' }],
      assets: [
        { id: 'a', name: 'A', kind: 'process', zoneId: 'z' },
        { id: 'b', name: 'B', kind: 'datastore', zoneId: 'z' },
      ],
      controls: [{ id: 'c', name: 'C', kind: 'other' }],
    };
    const r = validateSecurityDocument({
      ...base,
      flows: [
        { id: 'f1', sourceId: 'a', targetId: 'b', protocol: 'SQL' },
        { id: 'f2', sourceId: 'a', targetId: 'b', protocol: 'SQL' },
        { id: 'f3', sourceId: 'a', targetId: 'a' },
        { id: 'f4', sourceId: 'z', targetId: 'b' },
        { id: 'f5', sourceId: 'a', targetId: 'nada' },
      ],
      threats: [
        { id: 't1', title: 'T1', category: 'tampering', targetId: 'z' },
        { id: 't2', title: 'T2', category: 'tampering', targetId: 'nada' },
        { id: 't3', title: 'T3', category: 'tampering', targetId: 'f1', controlIds: ['c', 'c', 'a', 'nada'] },
      ],
    });
    expect(r.ok).toBe(false);
    const text = r.ok ? '' : formatSecurityIssues(r.issues);
    for (const fragment of [
      'El flujo "f2" repite otro igual ("a" → "b")',
      'El flujo "f3" no puede unir un activo consigo mismo',
      'Un flujo une activos, pero "z" es zona',
      'El flujo "f5" referencia un activo inexistente: "nada"',
      'Una amenaza recae sobre un activo o un flujo, pero "z" es zona',
      'La amenaza "t2" apunta a un elemento inexistente: "nada"',
      'La amenaza "t3" repite el control "c"',
      'la mitiga un control, pero "a" es activo',
      'La amenaza "t3" referencia un control inexistente: "nada"',
    ]) {
      expect(text).toContain(fragment);
    }
    // Dos flujos entre los mismos activos son válidos si difieren en protocolo o descripción.
    expect(validateSecurityDocument({ ...base, flows: [{ id: 'f1', sourceId: 'a', targetId: 'b', protocol: 'SQL' }, { id: 'f2', sourceId: 'a', targetId: 'b', protocol: 'HTTPS' }] }).ok).toBe(true);
  });

  it('el riesgo es probabilidad por impacto, con valores medios por defecto', () => {
    const t = (likelihood?: string, impact?: string) => riskOf({ id: 't', title: 'T', category: 'tampering', targetId: 'a', likelihood, impact } as never);
    expect(t()).toEqual({ score: 4, rating: 'medium' });
    expect(t('low', 'low')).toEqual({ score: 1, rating: 'low' });
    expect(t('high', 'low')).toEqual({ score: 3, rating: 'medium' });
    expect(t('medium', 'high')).toEqual({ score: 6, rating: 'high' });
    expect(t('low', 'critical')).toEqual({ score: 4, rating: 'medium' });
    expect(t('medium', 'critical')).toEqual({ score: 8, rating: 'critical' });
    expect(t('high', 'critical')).toEqual({ score: 12, rating: 'critical' });
  });
});

describe('grafo', () => {
  it('reach recorre hacia dónde van los datos, de dónde vienen o ambos, con el camino seguido', () => {
    const graph = flowGraph(doc);
    const down = reach(graph, 'pedidos', 'downstream');
    expect(down.map((s) => s.id)).toEqual(['pedidos-db', 'secretos', 'kafka', 'facturacion', 'notificaciones', 'pasarela-pagos', 'proveedor-correo']);
    expect(down.find((s) => s.id === 'pasarela-pagos')).toEqual({ id: 'pasarela-pagos', depth: 3, via: 'facturacion' });
    const up = reach(graph, 'pedidos-db', 'upstream');
    expect(up.map((s) => s.id)).toEqual(['pedidos', 'tienda-web', 'waf-lb', 'cliente']);
    expect(reach(graph, 'pedidos', 'both').map((s) => s.id)).toEqual([...down.map((s) => s.id), ...['tienda-web', 'waf-lb', 'cliente']]);
    expect(reach(graph, 'cliente', 'upstream')).toEqual([]);
  });

  it('las zonas se anidan y un flujo entre zonas distintas cruza una frontera', () => {
    expect(zoneChain(doc, 'datos').map((z) => z.id)).toEqual(['datos', 'interna']);
    expect(zoneChain(doc, 'nada')).toEqual([]);
    const list = crossings(doc);
    expect(list.map((c) => `${c.flow.id}:${c.direction}:${c.gap}`)).toEqual([
      'cliente-navega:ingress:1',
      'borde-a-web:ingress:1',
      'pedidos-a-db:ingress:1',
      'pedidos-a-secretos:ingress:1',
      'facturacion-a-pagos:egress:2',
      'notificaciones-a-correo:egress:2',
    ]);
    // Dos zonas internas distintas: cruce lateral.
    const lateral = changed((j) => {
      j.zones.push({ id: 'otra', name: 'Otra', trust: 'internal' });
      byId(j, 'assets', 'notificaciones').zoneId = 'otra';
    });
    expect(crossings(lateral).find((c) => c.flow.id === 'kafka-a-notificaciones')).toMatchObject({ direction: 'lateral', gap: 0 });
  });

  it('la superficie de ataque son los flujos que entran desde zonas no confiables, y los caminos llegan a lo que interesa proteger', () => {
    expect(entryPoints(doc).map((c) => c.flow.id)).toEqual(['cliente-navega']);
    const paths = attackPaths(doc);
    expect(paths.map((p) => p.targetId)).toEqual(['tienda-web', 'pedidos', 'facturacion', 'kafka', 'pedidos-db', 'secretos']);
    expect(paths.find((p) => p.targetId === 'pedidos-db')).toEqual({
      sourceId: 'cliente',
      targetId: 'pedidos-db',
      assetIds: ['cliente', 'waf-lb', 'tienda-web', 'pedidos', 'pedidos-db'],
      flowIds: ['cliente-navega', 'borde-a-web', 'web-a-pedidos', 'pedidos-a-db'],
      boundaries: 3,
    });
    // Un atajo del cliente a la base de pedidos acorta el camino.
    const shortcut = changed((j) => j.flows.push({ id: 'atajo', sourceId: 'cliente', targetId: 'pedidos-db' }));
    expect(attackPaths(shortcut).find((p) => p.targetId === 'pedidos-db')).toMatchObject({ flowIds: ['atajo'], boundaries: 1 });
    // Sin ninguna zona no confiable no hay caminos.
    expect(attackPaths(changed((j) => (byId(j, 'zones', 'internet').trust = 'dmz')))).toEqual([]);
  });
});

describe('reglas de gobierno', () => {
  it('el ejemplo tiene los avisos que se esperan y ningún error', () => {
    const issues = analyzeSecurity(doc);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    const warnings = issues.filter((i) => i.severity === 'warning').map((i) => i.message);
    expect(warnings).toEqual([
      'Flujo «Cobro del pedido» envía datos confidenciales al sistema externo «Pasarela de pagos».',
      'Flujo «Confirmación del pedido» cruza la frontera de «Red interna» a «Internet» sin cifrar.',
      'Amenaza «Robo de credenciales de clientes (credential stuffing)» sigue abierta con riesgo crítico (9) sobre actor «Cliente».',
      'Amenaza «Robo de credenciales de clientes (credential stuffing)» mantiene riesgo residual alto (6) pese a 1 control implementado: refuerza los controles o acepta el riesgo.',
      'Amenaza «Acceso a pedidos de otros clientes (IDOR)» sigue abierta con riesgo alto (6) sobre proceso «Servicio de pedidos».',
      'Amenaza «Publicación de mensajes falsos en el bus de eventos» sigue abierta con riesgo alto (6) sobre proceso «Bus de eventos».',
      'Proceso «Tienda web» es un activo a proteger y está a un salto de un activo expuesto a una zona no confiable.',
    ]);
    expect(issues.filter((i) => i.severity === 'info')).toHaveLength(13);
    expect(issues.every((i) => indexElements(doc).has(i.elementId!))).toBe(true);
  });

  it('avisa de fronteras cruzadas sin cifrar y de entradas sin autenticar o que saltan una zona', () => {
    const unknown = changed((j) => delete byId(j, 'flows', 'notificaciones-a-correo').encrypted);
    expect(messages(unknown)).toContain('Flujo «Confirmación del pedido» cruza la frontera de «Red interna» a «Internet» y no se sabe si va cifrado.');
    // Entre zonas internas y con datos poco sensibles solo es una nota.
    const lateral = changed((j) => {
      j.zones.push({ id: 'otra', name: 'Otra', trust: 'internal' });
      byId(j, 'assets', 'notificaciones').zoneId = 'otra';
      delete byId(j, 'flows', 'kafka-a-notificaciones').encrypted;
    });
    const note = analyzeSecurity(lateral).find((i) => i.message.includes('cruza la frontera de «Red interna» a «Otra»'))!;
    expect(note.severity).toBe('info');
    const open = changed((j) => (byId(j, 'flows', 'cliente-navega').authentication = 'none'));
    expect(messages(open)).toContain('Flujo «Navegación y compra» entra a la zona DMZ «Perímetro» sin autenticación.');
    const unspecified = changed((j) => delete byId(j, 'flows', 'cliente-navega').authentication);
    expect(messages(unspecified)).toContain('Flujo «Navegación y compra» entra a «Perímetro» desde «Internet» y no se indica cómo se autentica.');
    const skip = changed((j) => j.flows.push({ id: 'directo', sourceId: 'cliente', targetId: 'tienda-web', encrypted: true, authentication: 'token' }));
    expect(messages(skip)).toContain('Flujo «Cliente → Tienda web» salta de la zona no confiable «Internet» a la interna «Red interna» sin pasar por una zona intermedia.');
  });

  it('avisa de datos sensibles sin cifrar en reposo o en zonas poco confiables', () => {
    const plain = changed((j) => (byId(j, 'assets', 'pedidos-db').encryptedAtRest = false));
    expect(messages(plain)).toContain('Almacén de datos «Base de pedidos» guarda datos confidenciales sin cifrar en reposo.');
    const unknown = changed((j) => delete byId(j, 'assets', 'pedidos-db').encryptedAtRest);
    expect(messages(unknown)).toContain('Almacén de datos «Base de pedidos» guarda datos confidenciales y no se sabe si están cifrados en reposo.');
    const exposed = changed((j) => (byId(j, 'assets', 'pedidos-db').zoneId = 'perimetro'));
    expect(messages(exposed)).toContain('Almacén de datos «Base de pedidos» guarda datos confidenciales en la zona DMZ «Perímetro»: deberían estar en una zona interna o restringida.');
    const owner = changed((j) => delete byId(j, 'assets', 'pedidos-db').owner);
    expect(messages(owner)).toContain('Almacén de datos «Base de pedidos» trata datos confidenciales y no tiene responsable.');
  });

  it('avisa de datos que salen a terceros, de un almacén que entrega a un actor y de clasificaciones incoherentes', () => {
    const toActor = changed((j) => j.flows.push({ id: 'db-a-cliente', sourceId: 'pedidos-db', targetId: 'cliente', encrypted: true, authentication: 'token' }));
    expect(messages(toActor)).toContain('Flujo «Base de pedidos → Cliente» entrega datos confidenciales de un almacén directamente a un actor.');
    const inconsistent = changed((j) => (byId(j, 'assets', 'notificaciones').classification = 'public'));
    expect(messages(inconsistent)).toContain('Proceso «Notificaciones» declara datos públicos, pero intercambia datos internos.');
  });

  it('avisa de amenazas mal cerradas, que no aplican o de riesgo alto aceptado', () => {
    const noControls = changed((j) => delete byId(j, 'threats', 'interceptacion').controlIds);
    expect(messages(noControls)).toContain('Amenaza «Interceptación del tráfico del cliente» figura como mitigada pero no tiene ningún control asociado.');
    const planned = changed((j) => (byId(j, 'threats', 'interceptacion').controlIds = ['mfa']));
    expect(messages(planned)).toContain('Amenaza «Interceptación del tráfico del cliente» figura como mitigada pero sus controles están solo previstos.');
    const accepted = changed((j) => (byId(j, 'threats', 'robo-credenciales').status = 'accepted'));
    expect(messages(accepted)).toContain('Amenaza «Robo de credenciales de clientes (credential stuffing)» tiene riesgo crítico y está aceptada sin mitigar.');
    const misplaced = changed((j) => (byId(j, 'threats', 'robo-credenciales').category = 'tampering'));
    expect(messages(misplaced)).toContain('Amenaza «Robo de credenciales de clientes (credential stuffing)»: manipulación no suele aplicarse a actor «Cliente».');
    expect(messages(doc)).toContain('Amenaza «Robo de credenciales de clientes (credential stuffing)» sigue abierta pese a tener controles implementados: revisa si ya está mitigada.');
    expect(applicableCategories(indexElements(doc).get('cliente')!)).toEqual(['spoofing', 'repudiation']);
    expect(applicableCategories(indexElements(doc).get('pedidos')!)).toHaveLength(6);
    expect(applicableCategories(indexElements(doc).get('cliente-navega')!)).toEqual(['tampering', 'information-disclosure', 'denial-of-service']);
    expect(applicableCategories(indexElements(doc).get('internet')!)).toEqual([]);
  });

  it('avisa de controles sin uso, zonas vacías, activos aislados y elementos sin amenazas analizadas', () => {
    const extra = changed((j) => {
      j.controls.push({ id: 'sin-uso', name: 'Sin uso', kind: 'backup' });
      j.zones.push({ id: 'vacia', name: 'Vacía' });
      j.assets.push({ id: 'suelto', name: 'Suelto', kind: 'process', zoneId: 'interna', classification: 'restricted' });
    });
    const text = messages(extra);
    expect(text).toContain('Control «Sin uso» no mitiga ninguna amenaza.');
    expect(text).toContain('Zona «Vacía» no contiene ningún activo.');
    expect(text).toContain('Proceso «Suelto» no intercambia datos con ningún otro activo.');
    expect(text).toContain('Proceso «Suelto» trata datos restringidos y no tiene amenazas analizadas.');
    expect(text).toContain('Proceso «Suelto» trata datos restringidos y no tiene responsable.');
    // Sin ninguna amenaza no se avisa de lo que falta por analizar.
    expect(messages(changed((j) => (j.threats = []))).filter((m) => m.includes('no tiene amenazas analizadas'))).toEqual([]);
  });
});

describe('vistas', () => {
  it('lista los flujos de datos y el modelo de amenazas, según lo que tenga el documento', () => {
    expect(listViews(doc).map((v) => v.id)).toEqual(['dfd', 'threats', 'heatmap', 'surface']);
    expect(listViews(changed((j) => (j.threats = []))).map((v) => v.id)).toEqual(['dfd', 'surface']);
    expect(listViews(parse({}))).toEqual([]);
    expect(findView(doc).id).toBe('dfd');
    expect(() => findView(parse({}))).toThrow(/no tiene vistas/);
  });

  it('el modelo de amenazas reúne amenazas, lo que amenazan y sus controles', () => {
    const v = findView(doc, 'threats');
    expect(v.threatIds).toHaveLength(10);
    expect(v.assetIds).toEqual(['cliente', 'waf-lb', 'pedidos', 'kafka', 'pedidos-db', 'secretos']);
    expect(v.flowIds).toEqual(['cliente-navega', 'notificaciones-a-correo']);
    expect(v.controlIds).toHaveLength(12);
  });

  it('alcance, exposición y contexto de un activo, por prefijo o por su id', () => {
    const blast = findView(doc, 'blast:pedidos');
    expect(blast).toMatchObject({ type: 'blast', focusId: 'pedidos', title: 'Alcance si se compromete «Servicio de pedidos»' });
    expect(blast.assetIds).toEqual(['pasarela-pagos', 'proveedor-correo', 'pedidos', 'facturacion', 'notificaciones', 'kafka', 'pedidos-db', 'secretos']);
    expect(blast.flowIds).toEqual(['pedidos-a-db', 'pedidos-a-secretos', 'pedidos-a-kafka', 'kafka-a-facturacion', 'kafka-a-notificaciones', 'facturacion-a-pagos', 'notificaciones-a-correo']);
    expect(findView(doc, 'exposure:pedidos-db').assetIds).toEqual(['cliente', 'waf-lb', 'tienda-web', 'pedidos', 'pedidos-db']);
    expect(findView(doc, 'kafka')).toMatchObject({ id: 'focus:kafka', type: 'focus' });
    expect(traceView(doc, 'kafka', 'focus').assetIds).toContain('cliente');
    expect(() => findView(doc, 'blast:nada')).toThrow(/No existe la vista «blast:nada»\. Vistas disponibles: dfd, threats, heatmap, surface, heatmap:residual, blast:<activo>/);
    expect(() => traceView(doc, 'interna')).toThrow(/No existe el activo/);
  });
});

describe('exportación a Mermaid', () => {
  it('los flujos de datos anidan las zonas y llevan el tipo de cada activo en su clase', () => {
    const text = toMermaid(doc);
    expect(text.startsWith('flowchart LR\n')).toBe(true);
    expect(text).toContain('subgraph internet["Zona no confiable: Internet"]');
    expect(text).toContain('subgraph perimetro["Zona DMZ: Perímetro"]');
    expect(text).toContain('        subgraph datos["Zona restringida: Zona de datos"]');
    expect(text).toContain('cliente(["Cliente"]):::actor');
    expect(text).toContain('pasarela_pagos["Pasarela de pagos"]:::external');
    expect(text).toContain('waf_lb("Balanceador y WAF<br/>AWS ALB + WAF<br/>datos internos"):::process');
    expect(text).toContain('pedidos_db[("Base de pedidos<br/>PostgreSQL 15<br/>datos confidenciales<br/>cifrado en reposo")]:::datastore');
    // el cifrado va en la flecha: gruesa = cifrado, punteada = sin cifrar
    expect(text).toContain('cliente ==>|"HTTPS · Navegación y compra · datos internos · autenticación token"| waf_lb');
    expect(text).toContain('notificaciones -.->|"SMTP · Confirmación del pedido · datos internos · autenticación contraseña"| proveedor_correo');
    expect(text).toContain('classDef datastore fill:#d9480f');
    expect(text).toContain('linkStyle 9 stroke:#c92a2a');
    const unknown = toMermaid(changed((j) => delete byId(j, 'flows', 'borde-a-web').encrypted));
    expect(unknown).toContain('waf_lb -->|"HTTPS · autenticación mTLS"| tienda_web');
  });

  it('el modelo de amenazas dibuja amenazas, controles y los flujos amenazados', () => {
    const text = toMermaid(doc, { viewId: 'threats' });
    expect(text).toContain('robo_credenciales["Robo de credenciales de clientes (credential stuffing)<br/>riesgo crítico (9) · abierta"]:::threat');
    expect(text).toContain('style robo_credenciales fill:#c92a2a');
    expect(text).toContain('mfa["Autenticación multifactor para clientes<br/>prevista"]:::control');
    expect(text).toContain('notificaciones_a_correo(["Confirmación del pedido<br/>SMTP"]):::flow');
    expect(text).toContain('robo_credenciales -.-> cliente');
    expect(text).toContain('limitacion_tasa -->|"mitiga"| robo_credenciales');
  });

  it('evita las palabras reservadas y los ids con caracteres raros', () => {
    const odd = parse({
      zones: [{ id: 'end', name: 'Fin' }],
      assets: [
        { id: 'graph', name: 'Grafo', kind: 'process', zoneId: 'end' },
        { id: '1-api', name: 'API', kind: 'process', zoneId: 'end' },
        { id: 'a.b', name: 'Punto', kind: 'process', zoneId: 'end' },
      ],
      flows: [{ id: 'f', sourceId: 'graph', targetId: '1-api' }],
    });
    const text = toMermaid(odd);
    expect(text).toContain('subgraph end_2["Zona interna: Fin"]');
    expect(text).toContain('graph_2("Grafo"):::process');
    expect(text).toContain('_1_api("API"):::process');
    expect(text).toContain('a_b("Punto"):::process');
    expect(fromMermaid(text).document.assets.map((a) => a.name)).toEqual(['Grafo', 'API', 'Punto']);
  });
});

describe('importación desde Mermaid', () => {
  it('ida y vuelta de los flujos de datos: zonas, activos y flujos con todos sus atributos', () => {
    const { document: back, warnings } = fromMermaid(toMermaid(doc), { name: 'Ida y vuelta' });
    expect(warnings).toEqual([]);
    expect(back.workspace.name).toBe('Ida y vuelta');
    expect(back.zones).toEqual(doc.zones.map((z) => ({ id: z.id, name: z.name, trust: z.trust, ...(z.parentId ? { parentId: z.parentId } : {}) })));
    const strip = (a: (typeof doc.assets)[number]) => ({ id: a.id, name: a.name, kind: a.kind, zoneId: a.zoneId, technology: a.technology, classification: a.classification, encryptedAtRest: a.encryptedAtRest });
    const clean = <T extends object>(o: T): T => JSON.parse(JSON.stringify(o));
    const sortBy = <T,>(list: T[], key: (x: T) => string): T[] => [...list].sort((a, b) => key(a).localeCompare(key(b)));
    expect(sortBy(back.assets.map((a) => clean(strip(a))), (a) => a.id)).toEqual(sortBy(doc.assets.map((a) => clean(strip(a))), (a) => a.id));
    const flow = (f: (typeof doc.flows)[number]) => clean({ sourceId: f.sourceId, targetId: f.targetId, protocol: f.protocol, description: f.description, classification: f.classification, encrypted: f.encrypted, authentication: f.authentication });
    const pair = (f: { sourceId: string; targetId: string }): string => `${f.sourceId}>${f.targetId}`;
    expect(sortBy(back.flows.map(flow), pair)).toEqual(sortBy(doc.flows.map(flow), pair));
  });

  it('un flujo sin cifrado conocido queda con la flecha continua, y una etiqueta con solo texto es la descripción', () => {
    const { document: back } = fromMermaid('flowchart LR\n  subgraph z["Zona interna: Z"]\n    a["A"]:::process\n    b["B"]:::process\n    c["C"]:::process\n  end\n  a --> b\n  a -->|"Consulta de precios"| c\n  b -->|"gRPC"| c');
    expect(back.flows.map((f) => [f.sourceId, f.targetId, f.protocol, f.description, f.encrypted])).toEqual([
      ['a', 'b', undefined, undefined, undefined],
      ['a', 'c', undefined, 'Consulta de precios', undefined],
      ['b', 'c', 'gRPC', undefined, undefined],
    ]);
  });

  it('un flowchart escrito a mano: clases en español, formas, zonas sin prefijo y nodos fuera de una zona, con avisos', () => {
    const { document: back, warnings } = fromMermaid(
      [
        'flowchart TD',
        '  usuario(["Usuario"]):::usuario',
        '  subgraph red["Red de servidores"]',
        '    api("API Gateway<br/>Kong"):::proceso',
        '    db[("Clientes<br/>datos restringidos<br/>sin cifrar en reposo")]',
        '  end',
        '  subgraph zona-dmz["Zona DMZ: Borde"]',
        '    proxy["Proxy"]',
        '  end',
        '  suelto["Suelto"]:::servicio',
        '  proveedor["Proveedor"]:::externo',
        '  usuario --> proxy',
        '  proxy ==> api',
        '  api -.-> db',
        '  api --> fantasma',
        '  api --> api',
      ].join('\n'),
    );
    const zone = (id: string) => back.zones.find((z) => z.id === id)!;
    expect(zone('red')).toMatchObject({ name: 'Red de servidores', trust: 'internal' });
    expect(zone('zona-dmz')).toMatchObject({ name: 'Borde', trust: 'dmz' });
    expect(zone('sin-zona').name).toBe('Sin zona asignada');
    const asset = (id: string) => back.assets.find((a) => a.id === id)!;
    expect(asset('usuario')).toMatchObject({ kind: 'actor', zoneId: 'sin-zona' });
    expect(asset('api')).toMatchObject({ kind: 'process', name: 'API Gateway', technology: 'Kong', zoneId: 'red' });
    expect(asset('db')).toMatchObject({ kind: 'datastore', classification: 'restricted', encryptedAtRest: false }); // por su forma
    expect(asset('proxy')).toMatchObject({ kind: 'process', zoneId: 'zona-dmz' });
    expect(asset('proveedor').kind).toBe('external');
    expect(asset('fantasma')).toMatchObject({ kind: 'process', zoneId: 'sin-zona' }); // un alias sin declarar es un activo más
    expect(back.flows.map((f) => `${f.sourceId}>${f.targetId}:${f.encrypted}`)).toEqual(['usuario>proxy:undefined', 'proxy>api:true', 'api>db:false', 'api>fantasma:undefined']);
    expect(warnings.join('\n')).toContain('El subgraph «Red de servidores» no indica su nivel de confianza');
    expect(warnings.join('\n')).toContain('«Usuario» no está dentro de ninguna zona');
    expect(warnings.join('\n')).toContain('«api» envía datos a sí mismo');
  });

  it('ignora los nodos del modelo de amenazas', () => {
    const { document: back, warnings } = fromMermaid(toMermaid(doc, { viewId: 'threats' }).replace('flowchart LR', 'flowchart LR\n  subgraph z["Zona interna: Z"]\n    extra["Extra"]:::process\n  end'));
    // los activos amenazados se importan (sin zona); las amenazas, los controles y los flujos, no
    expect(back.assets.map((a) => a.id)).toEqual(['extra', 'cliente', 'waf-lb', 'pedidos', 'kafka', 'pedidos-db', 'secretos']);
    expect(back.threats).toEqual([]);
    expect(back.flows).toEqual([]);
    expect(warnings.join('\n')).toContain('Se ignoraron 24 nodo(s) del modelo de amenazas');
    expect(warnings.join('\n')).not.toContain('no se puede importar');
  });

  it('rechaza lo que no es un flowchart y lo vacío, con errores de módulo', () => {
    expect(() => fromMermaid('')).toThrow(SecurityImportError);
    expect(() => fromMermaid('sequenceDiagram\n  A->>B: hola')).toThrow(/no se puede importar como seguridad/);
    expect(() => fromMermaid('pastel\n  a')).toThrow(/No se reconoce el tipo de diagrama/);
    expect(() => fromMermaid('flowchart LR\n  subgraph z["Zona interna: Z"]\n  end')).toThrow(/no define ningún activo/);
    expect(new SecurityImportError('x')).toBeInstanceOf(ModuleError);
  });

  it('usa el nombre indicado, el título del frontmatter o el de reserva', () => {
    const src = 'flowchart LR\n  a["A"]';
    expect(fromMermaid(src, { name: ' Mío ' }).document.workspace.name).toBe('Mío');
    expect(fromMermaid(`---\ntitle: Con título\n---\n${src}`).document.workspace.name).toBe('Con título');
    expect(fromMermaid(src, { fallbackName: 'archivo' }).document.workspace.name).toBe('archivo');
    expect(fromMermaid(src).document.workspace.name).toBe('Arquitectura de seguridad');
  });
});

describe('SVG y draw.io', () => {
  it('cada zona rodea a sus activos y las anidadas quedan dentro de su padre, sin solapar nodos', async () => {
    const { layout } = await layoutView(doc, 'dfd');
    const box = (id: string) => [...layout.nodes, ...layout.groups].find((b) => b.id === id)!;
    const inside = (a: { x: number; y: number; width: number; height: number }, g: { x: number; y: number; width: number; height: number }) =>
      a.x >= g.x && a.y >= g.y && a.x + a.width <= g.x + g.width && a.y + a.height <= g.y + g.height;
    expect(layout.groups.map((g) => g.id).sort()).toEqual(['datos', 'interna', 'internet', 'perimetro']);
    expect(layout.nodes).toHaveLength(11);
    expect(inside(box('datos'), box('interna'))).toBe(true);
    expect(inside(box('pedidos-db'), box('datos'))).toBe(true);
    expect(inside(box('pedidos'), box('interna'))).toBe(true);
    expect(inside(box('pedidos'), box('datos'))).toBe(false);
    expect(inside(box('cliente'), box('internet'))).toBe(true);
    for (let i = 0; i < layout.nodes.length; i += 1) {
      for (const b of layout.nodes.slice(i + 1)) {
        const a = layout.nodes[i];
        expect(a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height).toBe(false);
      }
    }
    expect(layout.edges).toHaveLength(10);
  });

  it('dibuja cada vista con el texto y los colores de cada tipo, zona y estado de cifrado', async () => {
    const svg = await toSvg(doc, 'dfd');
    for (const text of ['Zona no confiable: Internet', 'Zona restringida: Zona de datos', 'ALMACÉN DE DATOS', 'SISTEMA EXTERNO', 'ACTOR', 'datos confidenciales', 'cifrado en reposo', '1 amenaza abierta', 'HTTPS · Navegación y compra']) {
      expect(svg).toContain(text);
    }
    expect(svg).toContain('fill="#fff5f5"'); // zona no confiable
    expect(svg).toContain('fill="#ebfbee"'); // zona restringida
    expect(svg).toContain('stroke="#c92a2a"'); // el flujo sin cifrar
    expect(svg).toContain('stroke="#2b8a3e"'); // los cifrados
    expect(svg).not.toMatch(/<script|href=|@import/);
    const threats = await toSvg(doc, 'threats');
    for (const text of ['AMENAZA · SUPLANTACIÓN', 'riesgo crítico (9) · abierta', 'mitiga', 'CIFRADO', 'FLUJO DE DATOS']) expect(threats).toContain(text);
    expect(threats).not.toContain('amenaza abierta'); // las amenazas ya son nodos: no se repite el contador
    expect(await toSvg(doc, 'blast:pedidos')).toContain('Alcance si se compromete «Servicio de pedidos»');
    expect(await toSvg(doc, 'exposure:pedidos-db')).toContain('Quién llega a «Base de pedidos»');
  });

  it('el activo de partida de una traza se resalta y los que tienen amenazas graves abiertas, en rojo', async () => {
    const { nodes } = await layoutView(doc, 'focus:pedidos');
    expect(nodes.get('pedidos')!.stroke).toBe('#f59f00');
    expect(nodes.get('cliente')!.stroke).toBe('#e03131');
    expect(nodes.get('pedidos-db')!.stroke).not.toBe('#e03131');
  });

  it('draw.io tiene una página por vista, con sus nodos, zonas y flechas', async () => {
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(await toDrawio(doc));
    const pages = ([] as Array<Record<string, unknown>>).concat(parsed.mxfile.diagram);
    expect(pages.map((p) => p['@_id'])).toEqual(['dfd', 'threats', 'heatmap', 'surface']);
    const cells = (i: number) => ([] as Array<Record<string, string>>).concat(parsed.mxfile.diagram[i].mxGraphModel.root.mxCell);
    const dfd = cells(0);
    expect(dfd.filter((c) => c['@_edge']).length).toBe(10);
    expect(dfd.filter((c) => c['@_vertex']).length).toBe(15); // 11 activos + 4 zonas
    const zone = dfd.find((c) => c['@_id'] === 'n-internet')!;
    expect(zone['@_value']).toBe('Zona no confiable: Internet');
    expect(zone['@_style']).toContain('fillColor=#fff5f5');
    const database = dfd.find((c) => c['@_id'] === 'n-pedidos-db')!;
    expect(database['@_style']).toContain('shape=cylinder3');
    expect(database['@_value']).toContain('<b>Base de pedidos</b>');
    expect(cells(1).filter((c) => c['@_edge']).length).toBe(10 + 14); // amenazas → objetivo y controles → amenaza
  });
});

describe('desde un mapa de integración', () => {
  const integ = JSON.parse(readFileSync('examples/pedidos-integracion.json', 'utf8')) as unknown;

  it('pasa sistemas a procesos, almacenes a almacenes de datos y las interacciones a flujos, con zonas propuestas', () => {
    const { document: out, warnings } = fromIntegrationJson(integ);
    expect(out.workspace.name).toBe('Seguridad - Pedidos en línea');
    expect(out.zones.map((z) => [z.id, z.trust])).toEqual([
      ['red-interna', 'internal'],
      ['perimetro', 'dmz'],
      ['externo', 'untrusted'],
    ]);
    const asset = (id: string) => out.assets.find((a) => a.id === id)!;
    expect(asset('gateway')).toMatchObject({ kind: 'process', zoneId: 'perimetro', ref: 'urn:iark:integration:gateway' });
    expect(asset('pedidos-db')).toMatchObject({ kind: 'datastore', zoneId: 'red-interna' });
    expect(asset('pasarela-pagos')).toMatchObject({ kind: 'external', zoneId: 'externo' });
    expect(asset('cliente')).toMatchObject({ kind: 'actor', zoneId: 'externo', ref: 'urn:iark:integration:cliente' });
    expect(out.assets).toHaveLength(10);
    expect(out.flows).toHaveLength(9);
    expect(warnings.join('\n')).toContain('se funden en el sistema o el broker');
    expect(warnings.join('\n')).toContain('Las zonas de confianza se proponen por heurística');
    expect(validateSecurityDocument(out).ok).toBe(true);
    // El cifrado se deduce del protocolo cuando es explícito.
    const secure = fromIntegrationJson({ nodes: [{ id: 'a', kind: 'system', name: 'A' }, { id: 'b', kind: 'system', name: 'B' }], interactions: [{ sourceId: 'a', targetId: 'b', protocol: 'HTTPS' }, { sourceId: 'b', targetId: 'a', protocol: 'HTTP' }, { sourceId: 'a', targetId: 'b', protocol: 'gRPC' }] });
    expect(secure.document.flows.map((f) => f.encrypted)).toEqual([true, false, undefined]);
  });

  it('rechaza lo que no es un documento de integración', () => {
    expect(() => fromIntegrationJson({})).toThrow(SecurityImportError);
    expect(() => fromIntegrationJson({ nodes: [{ id: 'a', kind: 'api', name: 'A' }] })).toThrow(/no tiene sistemas/);
  });
});

describe('desde un documento de plataforma', () => {
  const platform = JSON.parse(readFileSync('examples/plataforma-ejemplo.json', 'utf8')) as unknown;

  it('las redes son zonas según su exposición, los servicios van a la red de su anfitrión y las dependencias son flujos', () => {
    const { document: out, warnings } = fromPlatformJson(platform);
    expect(out.workspace.name).toBe('Seguridad - Plataforma de pedidos en línea (Producción)');
    expect(out.zones.map((z) => [z.id, z.trust, z.parentId])).toEqual([
      ['vpc-prod', 'internal', undefined],
      ['subred-publica', 'dmz', 'vpc-prod'],
      ['subred-apps', 'internal', 'vpc-prod'],
      ['subred-datos', 'restricted', 'vpc-prod'],
      ['internet', 'untrusted', undefined],
    ]);
    const asset = (id: string) => out.assets.find((a) => a.id === id)!;
    expect(asset('pedidos')).toMatchObject({ kind: 'process', zoneId: 'subred-apps', owner: 'Equipo Pedidos', ref: 'urn:iark:platform:pedidos' });
    expect(asset('pedidos-db-prod')).toMatchObject({ kind: 'datastore', zoneId: 'subred-datos' });
    expect(asset('lb-prod')).toMatchObject({ kind: 'process', zoneId: 'subred-publica' });
    expect(asset('pasarela-pagos')).toMatchObject({ kind: 'external', zoneId: 'internet' });
    expect(asset('usuarios-internet')).toMatchObject({ kind: 'actor', zoneId: 'internet' });
    expect(out.assets.map((a) => a.id)).not.toContain('k8s-prod'); // los anfitriones no son activos
    expect(out.assets.map((a) => a.id)).not.toContain('pedidos-db-dev'); // ni lo de otros entornos
    expect(out.flows).toHaveLength(9);
    expect(out.flows[0]).toMatchObject({ sourceId: 'usuarios-internet', targetId: 'lb-prod', protocol: 'HTTPS', encrypted: true });
    expect(warnings.join('\n')).toContain('Se toma el entorno «Producción»');
    expect(warnings.join('\n')).toContain('Se añade el actor «Usuarios de Internet»');
    expect(analyzeSecurity(out).filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('elige el entorno con --env y rechaza los que no existen', () => {
    const dev = fromPlatformJson(platform, { env: 'dev', name: 'Seguridad de dev' });
    expect(dev.document.workspace.name).toBe('Seguridad de dev');
    expect(dev.document.zones.map((z) => z.id)).toEqual(['vpc-dev', 'internet']);
    expect(dev.document.assets.map((a) => a.id)).not.toContain('usuarios-internet'); // no hay red pública
    expect(() => fromPlatformJson(platform, { env: 'qa' })).toThrow(/No existe el entorno «qa»/);
    expect(() => fromPlatformJson({})).toThrow(SecurityImportError);
    expect(() => fromPlatformJson({ services: [] })).toThrow(/no define entornos/);
    expect(() => fromPlatformJson({ environments: [{ id: 'e', name: 'E' }], services: [{ id: 's', name: 'S' }] })).toThrow(/no tiene servicios desplegados/);
  });
});

describe('generación con IA', () => {
  it('quita los null de la salida estructurada y valida el documento', () => {
    const generated = toGenerated(doc);
    const result = generatedToSecurity(generated);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.document).toEqual({ ...doc, assets: doc.assets.map(({ ref: _ref, tags: _tags, ...a }) => a) });
    const broken = { ...generated, threats: [{ ...generated.threats[0], targetId: 'interna' }] };
    const failed = generatedToSecurity(broken);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.issues).toContain('Una amenaza recae sobre un activo o un flujo');
  });

  it('el prompt describe el dominio y el usuario incluye el modelo base al refinar', () => {
    expect(securityAiSpec.system()).toContain('arquitecto de seguridad');
    expect(securityAiSpec.system()).toContain('STRIDE por elemento');
    expect(securityAiSpec.user('Una tienda')).toContain('Una tienda');
    const refine = securityAiSpec.user('Añade un WAF', doc);
    expect(refine).toContain('"id": "pedidos-db"');
    expect(refine).toContain('Añade un WAF');
    const schema = securityAiSpec.generationJsonSchema() as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(['workspace', 'zones', 'assets', 'flows', 'threats', 'controls']);
  });
});

describe('módulo', () => {
  it('cumple el contrato y se puede registrar junto a otros módulos', () => {
    const registry = new ModuleRegistry().register(securityModule);
    expect(registry.require('security')).toBe(securityModule);
    expect(securityModule.exporters.map((e) => e.id)).toEqual(['mermaid', 'svg', 'drawio']);
    expect(securityModule.importers.map((i) => i.id)).toEqual(['mermaid', 'threat-dragon']);
    const manifest = buildManifest(registry, { name: 'Prueba', version: '0.0.0' });
    expect(manifest.modules[0]).toMatchObject({ id: 'security', importFormats: ['mermaid', 'threat-dragon'], exportFormats: ['mermaid', 'svg', 'drawio'] });
    expect(securityModule.entities!(doc).map((e) => e.kind)).toEqual(expect.arrayContaining(['zone', 'asset', 'threat', 'control']));
    expect(securityModule.validate(doc).filter((i) => i.severity === 'warning')).toHaveLength(7);
    expect((securityModule.jsonSchema() as { type: string }).type).toBe('object');
    expect(securityModule.importers[0].detect!('flowchart LR\n a --> b')).toBe(true);
    expect(securityModule.cliCommands!.map((c) => c.name)).toEqual(['risks', 'heatmap', 'stride', 'standards', 'exposure', 'from-integration', 'from-platform']);
  });
});

describe('comandos', () => {
  const run = (name: string, args: string[], input: unknown, options: Record<string, unknown> = {}) =>
    securityCommands.find((c) => c.name === name)!.run({ args, options, input: typeof input === 'string' ? input : JSON.stringify(input) }) as string;

  it('risks ordena las amenazas por riesgo, con su estado y sus controles, y resume las abiertas', () => {
    const text = run('risks', [], example);
    const rows = text.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Riesgo'));
    expect(rows).toHaveLength(10);
    expect(rows[0]).toBe('| crítico (9) | Robo de credenciales de clientes (credential stuffing) | Suplantación | Cliente | abierta | Autenticación multifactor para clientes (prevista); Limitación de intentos y de tasa en el balanceador | alto (6) ↓ |');
    expect(rows[rows.length - 1]).toContain('| bajo (2) | El cliente niega haber hecho un pedido |');
    expect(rows.find((r) => r.includes('Correos con datos'))).toContain('| abierta | — |');
    expect(text).toContain('Amenazas: 10 · abiertas: 4 · mitigadas: 5 · aceptadas: 1');
    expect(text).toContain('Abiertas por riesgo: 1 crítico, 2 alto, 1 medio, 0 bajo');
    const open = run('risks', [], example, { status: 'open' }).split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Riesgo'));
    expect(open).toHaveLength(4);
    expect(run('risks', [], {})).toBe('El documento no define amenazas.');
    expect(() => run('risks', [], example, { status: 'cerrada' })).toThrow(/Estado inválido «cerrada»/);
  });

  it('risks añade el riesgo residual tras los controles implementados y resume las abiertas por él', () => {
    const text = run('risks', [], example);
    expect(text).toContain('| Riesgo | Amenaza | STRIDE | Sobre | Estado | Controles | Residual |');
    const rows = text.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Riesgo'));
    const row = (title: string) => rows.find((r) => r.includes(title))!;
    // Un control implementado baja la probabilidad; dos, también el impacto: la marca ↓ indica que baja.
    expect(row('credential stuffing')).toMatch(/\| alto \(6\) ↓ \|$/);
    expect(row('Inyección SQL')).toMatch(/\| crítico \(8\) \|.*\| medio \(3\) ↓ \|$/);
    // Un control solo previsto, o ninguno, no cambia el riesgo residual.
    expect(row('(IDOR)')).toMatch(/\| alto \(6\) \|$/);
    expect(row('Correos con datos')).toMatch(/\| medio \(4\) \|$/);
    // Es el mismo cálculo que usan la matriz de calor y el lienzo (`residualOf`).
    for (const t of doc.threats) {
      const residual = residualOf(doc, t);
      const line = row(t.title);
      expect(line.endsWith(`| ${RATING_LABELS[residual.rating]} (${residual.score})${residual.reduced ? ' ↓' : ''} |`)).toBe(true);
    }
    expect(text).toContain('Abiertas por riesgo: 1 crítico, 2 alto, 1 medio, 0 bajo');
    expect(text).toContain('Abiertas por riesgo residual: 0 crítico, 2 alto, 2 medio, 0 bajo');
    expect(text).toContain('los controles previstos no cuentan');
    // El filtro por estado no cambia el resumen de las abiertas.
    expect(run('risks', [], example, { status: 'mitigated' })).toContain('Abiertas por riesgo residual: 0 crítico, 2 alto, 2 medio, 0 bajo');
  });

  it('stride cruza cada activo y flujo con las categorías que le aplican y las que ya están analizadas', () => {
    const text = run('stride', [], example);
    expect(text).toContain('| Elemento | Tipo | S | T | R | I | D | E |');
    expect(text).toContain('| Cliente | Actor | ●1 | — | ○ | — | — | — |');
    expect(text).toContain('| Servicio de pedidos | Proceso | ○ | ✓1 | ✓1 | ○ | ○ | ●1 |');
    expect(text).toContain('| Base de pedidos | Almacén de datos | — | ○ | ○ | ✓1 | ○ | — |');
    expect(text).toContain('| Confirmación del pedido | Flujo | — | ○ | — | ●1 | ○ | — |');
    expect(text).toContain('Analizadas: 10 · Sin analizar: 70');
    const full = run('stride', [], { zones: [{ id: 'z', name: 'Z' }], assets: [{ id: 'a', name: 'A', kind: 'actor', zoneId: 'z' }], threats: [{ id: 't1', title: 'T', category: 'spoofing', targetId: 'a', status: 'mitigated' }, { id: 't2', title: 'T', category: 'repudiation', targetId: 'a' }] }, { gaps: true });
    expect(full).not.toContain('| A |');
    expect(full).toContain('Sin analizar: 0');
    expect(run('stride', [], {})).toBe('El documento no define activos ni flujos.');
  });

  it('exposure lista los puntos de entrada y los caminos hasta lo que interesa proteger, con los tramos débiles', () => {
    const text = run('exposure', [], example);
    expect(text).toContain('Puntos de entrada desde zonas no confiables: 1');
    expect(text).toContain('- Cliente → Balanceador y WAF (HTTPS · cifrado · autenticación token); de «Internet» a la zona DMZ «Perímetro»');
    expect(text).toContain('Caminos hasta los activos que interesa proteger: 6');
    expect(text).toContain('- Base de pedidos (datos confidenciales): Cliente → Balanceador y WAF → Tienda web → Servicio de pedidos → Base de pedidos · 4 flujo(s), 3 frontera(s)');
    expect(text).not.toContain('    · ');
    const weak = run('exposure', [], JSON.stringify({ ...(example as object), flows: (doc.flows.map((f) => (f.id === 'web-a-pedidos' ? { ...f, encrypted: false, authentication: 'none' } : f))) }));
    expect(weak).toContain('    · Tienda web → Servicio de pedidos: sin cifrar, sin autenticación');
    expect(run('exposure', [], {})).toContain('Puntos de entrada desde zonas no confiables: ninguno');
  });

  it('from-integration y from-platform devuelven el documento como JSON', () => {
    const integ = readFileSync('examples/pedidos-integracion.json', 'utf8');
    const out = JSON.parse(run('from-integration', [], integ, { name: 'Desde integración' })) as SecurityDocument;
    expect(out.workspace.name).toBe('Desde integración');
    expect(out.assets).toHaveLength(10);
    const fromPlatform = JSON.parse(run('from-platform', [], readFileSync('examples/plataforma-ejemplo.json', 'utf8'), { env: 'dev' })) as SecurityDocument;
    expect(fromPlatform.zones.map((z) => z.id)).toEqual(['vpc-dev', 'internet']);
  });

  it('las entradas inválidas terminan en errores de módulo', () => {
    expect(() => run('risks', [], 'no es json')).toThrow(ModuleError);
    expect(() => run('risks', [], { assets: [{ id: 'a', name: 'A', kind: 'rara', zoneId: 'z' }] })).toThrow(/Documento de seguridad inválido/);
    expect(() => run('from-integration', [], '{"a":1}')).toThrow(/falta "nodes"/);
    expect(() => securityCommands[0].run({ args: [], options: {} })).toThrow(/Falta la entrada/);
  });
});
