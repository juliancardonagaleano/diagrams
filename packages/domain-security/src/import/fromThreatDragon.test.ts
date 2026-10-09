import { readFileSync } from 'node:fs';
import { ModuleRegistry } from '@iark/kernel';
import { describe, expect, it } from 'vitest';
import { analyzeSecurity } from '../issues';
import { securityModule } from '../module';
import { securityDocumentSchema } from '../schema';
import { fromThreatDragon, looksLikeThreatDragon } from './fromThreatDragon';
import { SecurityImportError } from './fromMermaid';

const text = readFileSync('tests/fixtures/importar/threat-dragon/tienda-modelo.json', 'utf8');
const registry = new ModuleRegistry().register(securityModule);

/** Un modelo mínimo de Threat Dragon con las celdas que se pasen. */
const model = (cells: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ summary: { title: 'Mínimo' }, detail: { diagrams: [{ id: 0, title: 'Principal', diagramType: 'STRIDE', cells, ...extra }] } });
const actor = (id: string, name: string, x = 10, y = 10, data: Record<string, unknown> = {}) => ({ shape: 'actor', id, position: { x, y }, size: { width: 20, height: 20 }, data: { type: 'tm.Actor', name, ...data } });
const process = (id: string, name: string, x = 10, y = 10, data: Record<string, unknown> = {}) => ({ shape: 'process', id, position: { x, y }, size: { width: 20, height: 20 }, data: { type: 'tm.Process', name, ...data } });
const store = (id: string, name: string, x = 10, y = 10, data: Record<string, unknown> = {}) => ({ shape: 'store', id, position: { x, y }, size: { width: 20, height: 20 }, data: { type: 'tm.Store', name, ...data } });
const box = (id: string, name: string, x: number, y: number, w: number, h: number) => ({ shape: 'trust-boundary-box', id, position: { x, y }, size: { width: w, height: h }, data: { type: 'tm.BoundaryBox', name, isTrustBoundary: true } });
const flow = (id: string, from: unknown, to: unknown, data: Record<string, unknown> = {}) => ({ shape: 'flow', id, source: from, target: to, data: { type: 'tm.Flow', name: 'Flujo', ...data } });
const ref = (cell: string) => ({ cell });

describe('Threat Dragon: detect', () => {
  it('reconoce el modelo v2 y el v1 por su estructura, también con marca de orden de bytes', () => {
    expect(looksLikeThreatDragon(text)).toBe(true);
    expect(looksLikeThreatDragon(`﻿${text}`)).toBe(true);
    expect(looksLikeThreatDragon('{"summary":{"title":"x"},"detail":{"diagrams":[{"diagramJson":{"cells":[]}}]}}')).toBe(true);
  });

  it('no se confunde con otros JSON ni con documentos de la suite', () => {
    expect(looksLikeThreatDragon('{"summary":{"title":"x"}}')).toBe(false);
    expect(looksLikeThreatDragon('{"summary":"x","detail":{"diagrams":[]}}')).toBe(false);
    expect(looksLikeThreatDragon('{"detail":{"diagrams":[]}}')).toBe(false);
    expect(looksLikeThreatDragon('{"a":1}')).toBe(false);
    expect(looksLikeThreatDragon('[1,2]')).toBe(false);
    expect(looksLikeThreatDragon('')).toBe(false);
    expect(looksLikeThreatDragon('flowchart LR\n a --> b')).toBe(false);
    expect(looksLikeThreatDragon('{"summary":{},"detail":{"diagrams":')).toBe(false);
    expect(looksLikeThreatDragon(readFileSync('examples/seguridad-ejemplo.json', 'utf8'))).toBe(false);
    expect(looksLikeThreatDragon(readFileSync('tests/fixtures/importar/dbt/manifest-tienda.json', 'utf8'))).toBe(false);
    expect(looksLikeThreatDragon(readFileSync('tests/fixtures/importar/terraform/aws-tienda-dev/plan.json', 'utf8'))).toBe(false);
  });

  it('el módulo lo elige para un .json y un texto sin nombre, y Mermaid sigue siendo Mermaid', () => {
    expect(registry.detectImporter('security', 'modelo.json', text)?.id).toBe('threat-dragon');
    expect(registry.detectImporter('security', undefined, text)?.id).toBe('threat-dragon');
    expect(registry.detectImporter('security', 'dfd.mmd', 'flowchart LR\n a --> b')?.id).toBe('mermaid');
    expect(registry.detectImporter('security', undefined, '{"version":1}')).toBeUndefined();
  });
});

describe('Threat Dragon: mapeo de la tienda', () => {
  const { document: doc, warnings } = fromThreatDragon(text);

  it('el título, el responsable y el revisor van a la descripción del espacio de trabajo', () => {
    expect(doc.workspace).toEqual({
      name: 'Tienda en línea',
      description: 'Modelo de amenazas del flujo de compra y de la privacidad del perfil. Responsable del modelo: Equipo de Seguridad. Revisor: Lucía Prado.',
    });
  });

  it('cada frontera es una zona; la anidada es hija y restringida; lo de fuera, «Exterior» no confiable', () => {
    expect(doc.zones.map((z) => [z.id, z.trust, z.parentId])).toEqual([
      ['flujo-de-compra-red-corporativa', 'internal', undefined],
      ['flujo-de-compra-zona-de-datos', 'restricted', 'flujo-de-compra-red-corporativa'],
      ['flujo-de-compra-exterior', 'untrusted', undefined],
      ['privacidad-del-perfil-servicios-de-perfil', 'internal', undefined],
      ['privacidad-del-perfil-exterior', 'untrusted', undefined],
    ]);
    expect(doc.zones[0].name).toBe('Flujo de compra · Red corporativa');
  });

  it('actores, procesos y almacenes son activos, colocados en la zona más pequeña que los contiene', () => {
    expect(doc.assets.map((a) => [a.id, a.kind, a.zoneId])).toEqual([
      ['cliente', 'actor', 'flujo-de-compra-exterior'],
      ['pasarela-de-pagos', 'actor', 'flujo-de-compra-exterior'],
      ['api-de-pedidos', 'process', 'flujo-de-compra-red-corporativa'],
      ['worker-de-facturacion', 'process', 'flujo-de-compra-red-corporativa'],
      ['base-de-pedidos', 'datastore', 'flujo-de-compra-zona-de-datos'],
      ['registro-de-auditoria', 'datastore', 'flujo-de-compra-zona-de-datos'],
      ['cliente-2', 'actor', 'privacidad-del-perfil-exterior'],
      ['perfil-del-cliente', 'process', 'privacidad-del-perfil-servicios-de-perfil'],
      ['datos-personales', 'datastore', 'privacidad-del-perfil-servicios-de-perfil'],
    ]);
  });

  it('las propiedades de Threat Dragon pasan a los campos del activo', () => {
    const asset = (id: string) => doc.assets.find((a) => a.id === id)!;
    expect(asset('api-de-pedidos')).toMatchObject({ technology: 'Aplicación web', classification: 'restricted' });
    expect(asset('api-de-pedidos').description).toBe('Recibe los pedidos y coordina el cobro · Maneja pagos con tarjeta · Nivel de privilegio: Usuario del sistema');
    expect(asset('base-de-pedidos')).toMatchObject({ classification: 'restricted', encryptedAtRest: false });
    expect(asset('registro-de-auditoria')).toMatchObject({ encryptedAtRest: true });
    expect(asset('registro-de-auditoria').description).toBe('Registro inmutable de las operaciones · Es un registro · Está firmado');
    expect(asset('worker-de-facturacion')).toMatchObject({ tags: ['fuera-de-alcance'] });
    expect(asset('worker-de-facturacion').description).toContain('Fuera de alcance: Lo analiza el equipo de facturación');
    expect(asset('cliente').encryptedAtRest).toBeUndefined();
  });

  it('los flujos llevan protocolo y cifrado; el bidireccional son dos; el sin nombre queda sin descripción', () => {
    expect(doc.flows.map((f) => [f.sourceId, f.targetId, f.description, f.protocol, f.encrypted])).toEqual([
      ['cliente', 'api-de-pedidos', 'Pedido (red pública)', 'HTTPS', true],
      ['api-de-pedidos', 'base-de-pedidos', 'Consulta de pedidos', 'TCP', false],
      ['base-de-pedidos', 'api-de-pedidos', 'Consulta de pedidos', 'TCP', false],
      ['api-de-pedidos', 'pasarela-de-pagos', 'Cobro (red pública)', 'HTTPS', true],
      ['api-de-pedidos', 'registro-de-auditoria', 'Traza', 'TCP', true],
      ['worker-de-facturacion', 'base-de-pedidos', 'Factura pendiente', 'TCP', false],
      ['cliente', 'worker-de-facturacion', undefined, undefined, false],
      ['cliente-2', 'perfil-del-cliente', 'Edición del perfil (red pública)', 'HTTPS', true],
      ['perfil-del-cliente', 'datos-personales', 'Perfil', 'TCP', true],
    ]);
  });

  it('las amenazas llevan categoría STRIDE, estado e impacto; las de LINDDUN y CIA se llevan a STRIDE y recuerdan su origen', () => {
    const threat = (id: string) => doc.threats.find((t) => t.id === id)!;
    expect(doc.threats).toHaveLength(14);
    expect(threat('api-de-pedidos--suplantacion-del-cliente-ante-la-api')).toMatchObject({ category: 'spoofing', status: 'open', impact: 'high', targetId: 'api-de-pedidos' });
    expect(threat('api-de-pedidos--manipulacion-de-importes')).toMatchObject({ category: 'tampering', status: 'mitigated', impact: 'medium' });
    expect(threat('api-de-pedidos--elevacion-de-privilegios-por-rol')).toMatchObject({ category: 'elevation-of-privilege', status: 'accepted', impact: 'low' });
    expect(threat('api-de-pedidos--elevacion-de-privilegios-por-rol').controlIds).toBeUndefined();
    expect(threat('api-de-pedidos--elevacion-de-privilegios-por-rol').description).toContain('Motivo: La API no expone ninguna operación de administración.');
    expect(threat('perfil-del-cliente--vinculacion-de-identidades')).toMatchObject({ category: 'information-disclosure' });
    expect(threat('perfil-del-cliente--vinculacion-de-identidades').description).toContain('Categoría original: Linkability (LINDDUN)');
    expect(threat('perfil-del-cliente--falta-de-prueba-de-consentimiento').category).toBe('repudiation');
    expect(threat('datos-personales--integridad-de-los-datos-del-perfil').category).toBe('tampering');
    expect(threat('datos-personales--riesgo-de-privacidad-no-clasificado')).toMatchObject({ category: 'tampering' });
  });

  it('una amenaza sobre un flujo apunta al flujo, y los textos de relleno de Threat Dragon se ignoran', () => {
    expect(doc.threats.find((t) => t.title === 'Interceptación en la red pública')).toMatchObject({ targetId: 'cliente--api-de-pedidos', category: 'information-disclosure', status: 'mitigated' });
    const filler = doc.threats.find((t) => t.title === 'New STRIDE threat')!;
    expect(filler.description).toBeUndefined();
    expect(filler.controlIds).toBeUndefined();
    expect(filler.impact).toBeUndefined();
  });

  it('cada texto de mitigación distinto es un control, con el tipo deducido; dos amenazas con el mismo texto lo comparten', () => {
    const shared = doc.controls.filter((c) => c.name.startsWith('Cifrar en reposo'));
    expect(shared).toHaveLength(1);
    expect(doc.threats.filter((t) => t.controlIds?.includes(shared[0].id)).map((t) => t.targetId)).toEqual(['base-de-pedidos', 'registro-de-auditoria']);
    const kindOf = (start: string) => doc.controls.find((c) => c.name.startsWith(start))!.kind;
    expect(kindOf('Cifrar en reposo')).toBe('encryption');
    expect(kindOf('TLS 1.2')).toBe('encryption');
    expect(kindOf('Tokens de corta')).toBe('authentication');
    expect(kindOf('Validar el importe')).toBe('validation');
    expect(kindOf('Limitar la tasa')).toBe('rate-limit');
    expect(kindOf('Registrar cada pedido')).toBe('logging');
    expect(kindOf('Separar los identificadores')).toBe('other');
    expect(doc.controls).toHaveLength(11);
  });

  it('el control está implementado si la amenaza está mitigada y prevista si sigue abierta', () => {
    const statusOf = (start: string) => doc.controls.find((c) => c.name.startsWith(start))!.status;
    expect(statusOf('TLS 1.2')).toBe('implemented');
    expect(statusOf('Validar el importe')).toBe('implemented');
    expect(statusOf('Tokens de corta')).toBe('planned');
    expect(statusOf('Cifrar en reposo')).toBe('planned');
  });

  it('avisa de lo que decidió, de lo que no importa y de nada más', () => {
    expect(warnings).toHaveLength(9);
    expect(warnings[0]).toMatch(/^El modelo tiene 2 diagramas: se unen en un solo documento/);
    expect(warnings[1]).toMatch(/no dice qué lado de una frontera es más confiable/);
    expect(warnings).toContain('3 elemento(s) quedan fuera de toda frontera: se colocan en la zona «Exterior».');
    expect(warnings.find((w) => w.includes('de curva'))).toContain('Borde de la nube');
    expect(warnings).toContain('1 nota(s) de texto no se importan.');
    expect(warnings).toContain('1 flujo(s) no se importan: 1 sin origen o destino conectado.');
    expect(warnings.find((w) => w.startsWith('Amenazas de otros modelos'))).toBe(
      'Amenazas de otros modelos (LINDDUN: 3, CIA: 1, CIADIE: 1) se llevaron a la categoría STRIDE más cercana; la categoría original queda en la descripción.',
    );
    expect(warnings).toContain('1 amenaza(s) con categoría sin equivalente STRIDE (Distributed) se importan como manipulación.');
    expect(warnings.some((w) => w.startsWith('Threat Dragon solo da la severidad'))).toBe(true);
  });

  it('pasa el esquema del módulo y el análisis no da errores', () => {
    expect(securityDocumentSchema.safeParse(doc).success).toBe(true);
    const issues = analyzeSecurity(doc);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(issues.some((i) => i.message.includes('«Base de pedidos» guarda datos restringidos sin cifrar'))).toBe(true);
    expect(issues.some((i) => i.message.includes('sigue abierta con riesgo alto'))).toBe(true);
  });

  it('importar dos veces da el mismo documento', () => {
    expect(fromThreatDragon(text)).toEqual({ document: doc, warnings });
  });

  it('el nombre explícito manda sobre el título del modelo', () => {
    expect(fromThreatDragon(text, { name: 'Otro nombre' }).document.workspace.name).toBe('Otro nombre');
    expect(fromThreatDragon(model([actor('a', 'A')]).replace('"title":"Mínimo"', '"title":""'), { fallbackName: 'archivo' }).document.workspace.name).toBe('archivo');
  });
});

describe('Threat Dragon: casos pequeños', () => {
  it('sin fronteras, todo va a una zona interna con el título del diagrama y se avisa', () => {
    const { document, warnings } = fromThreatDragon(model([actor('a', 'Usuario'), process('p', 'Servicio', 100, 100), flow('f', ref('a'), ref('p'), { name: 'Petición', protocol: 'HTTPS' })]));
    expect(document.zones).toEqual([{ id: 'principal', name: 'Principal', trust: 'internal' }]);
    expect(document.assets.every((a) => a.zoneId === 'principal')).toBe(true);
    expect(document.flows).toHaveLength(1);
    expect(warnings.some((w) => w.includes('no dibuja fronteras de confianza'))).toBe(true);
  });

  it('el nombre de la frontera manda sobre el anidamiento: DMZ, Internet y restringida', () => {
    const cells = [box('b1', 'DMZ', 0, 0, 100, 100), box('b2', 'Internet pública', 200, 0, 100, 100), box('b3', 'Zona PCI', 400, 0, 100, 100), box('b4', 'Interna', 600, 0, 100, 100), actor('a', 'A', 10, 10)];
    const { document } = fromThreatDragon(model(cells));
    expect(document.zones.map((z) => [z.name, z.trust])).toEqual([
      ['DMZ', 'dmz'],
      ['Internet pública', 'untrusted'],
      ['Zona PCI', 'restricted'],
      ['Interna', 'internal'],
    ]);
  });

  it('un elemento va a la frontera más pequeña que contiene su centro y una frontera dentro de otra es su hija', () => {
    const cells = [box('grande', 'Grande', 0, 0, 1000, 1000), box('media', 'Media', 100, 100, 500, 500), box('chica', 'Chica', 150, 150, 100, 100), process('p', 'P', 160, 160), process('q', 'Q', 400, 400), process('r', 'R', 900, 900)];
    const { document } = fromThreatDragon(model(cells));
    expect(document.zones.map((z) => [z.id, z.parentId, z.trust])).toEqual([
      ['grande', undefined, 'internal'],
      ['media', 'grande', 'restricted'],
      ['chica', 'media', 'restricted'],
    ]);
    expect(Object.fromEntries(document.assets.map((a) => [a.id, a.zoneId]))).toEqual({ p: 'chica', q: 'media', r: 'grande' });
  });

  it('un flujo sin origen o destino, hacia una frontera o de un elemento a sí mismo no se importa y se cuenta', () => {
    const cells = [
      actor('a', 'A'),
      process('p', 'P'),
      box('b', 'Frontera', 0, 0, 5, 5),
      flow('f1', ref('a'), { x: 4, y: 4 }),
      flow('f2', ref('a'), ref('b')),
      flow('f3', ref('p'), ref('p')),
      flow('f4', ref('a'), ref('fantasma')),
      flow('f5', ref('a'), ref('p')),
    ];
    const { document, warnings } = fromThreatDragon(model(cells));
    expect(document.flows).toHaveLength(1);
    expect(warnings).toContain('4 flujo(s) no se importan: 1 sin origen o destino conectado, 2 hacia algo que no es un actor, proceso ni almacén, 1 de un elemento consigo mismo.');
  });

  it('dos flujos iguales entre los mismos elementos no chocan con el esquema', () => {
    const cells = [actor('a', 'A'), process('p', 'P'), flow('f1', ref('a'), ref('p'), { name: 'Datos', protocol: 'HTTPS' }), flow('f2', ref('a'), ref('p'), { name: 'Datos', protocol: 'HTTPS' }), flow('f3', ref('a'), ref('p'), { name: 'Flow' }), flow('f4', ref('a'), ref('p'), { name: 'Flow' })];
    const { document } = fromThreatDragon(model(cells));
    expect(document.flows.map((f) => f.description)).toEqual(['Datos', 'Datos (2)', undefined, 'Flujo 2']);
    expect(new Set(document.flows.map((f) => f.id)).size).toBe(4);
  });

  it('elementos con el mismo nombre reciben ids distintos; sin nombre usan el tipo', () => {
    const { document } = fromThreatDragon(model([process('p1', 'Servicio'), process('p2', 'Servicio'), process('p3', ''), store('s', '')]));
    expect(document.assets.map((a) => [a.id, a.name])).toEqual([
      ['servicio', 'Servicio'],
      ['servicio-2', 'Servicio'],
      ['proceso', 'Proceso'],
      ['almacen-de-datos', 'Almacén de datos'],
    ]);
  });

  it('las amenazas se asignan por su estado, severidad y categoría, con valores desconocidos controlados', () => {
    const threats = [
      { title: 'A', type: 'Spoofing', status: 'Open', severity: 'Critical' },
      { title: 'B', type: 'Tampering', status: 'Mitigated', severity: 'TBD', mitigation: 'Validar la entrada' },
      { title: 'C', type: 'Repudiation', status: 'N/A', severity: 'Low', mitigation: 'No aplica aquí' },
      { title: 'D', type: 'Rareza', status: 'Pendiente', severity: 'Alto', score: '7.5' },
      { type: 'Denial of service' },
      { title: 'F', type: 'Spoofing de identidad', modelType: 'PLOT4ai' },
    ];
    const { document, warnings } = fromThreatDragon(model([process('p', 'P', 10, 10, { threats })]));
    expect(document.threats.map((t) => [t.title, t.category, t.status, t.impact])).toEqual([
      ['A', 'spoofing', 'open', 'critical'],
      ['B', 'tampering', 'mitigated', undefined],
      ['C', 'repudiation', 'accepted', 'low'],
      ['D', 'tampering', 'open', 'high'],
      ['Denial of service en P', 'denial-of-service', 'open', undefined],
      ['F', 'spoofing', 'open', undefined],
    ]);
    expect(document.threats[3].description).toBe('Puntuación: 7.5 · Categoría original: Rareza');
    expect(document.threats[2].description).toBe('Motivo: No aplica aquí');
    expect(document.controls).toHaveLength(1);
    expect(warnings).toContain('1 amenaza(s) con un estado desconocido se importan como abiertas.');
    expect(warnings).toContain('1 amenaza(s) con categoría sin equivalente STRIDE (Rareza) se importan como manipulación.');
  });

  it('una amenaza mitigada sin texto de mitigación se importa mitigada y el análisis del módulo lo señala', () => {
    const { document } = fromThreatDragon(model([process('p', 'P', 10, 10, { threats: [{ title: 'A', type: 'Spoofing', status: 'Mitigated', severity: 'High' }] })]));
    expect(document.threats[0].controlIds).toBeUndefined();
    expect(analyzeSecurity(document).some((i) => i.message.includes('figura como mitigada pero no tiene ningún control'))).toBe(true);
  });

  it('un diagrama v1 mezclado con uno v2 avisa; solo v1 falla con el motivo', () => {
    const mixed = JSON.stringify({ summary: { title: 'M' }, detail: { diagrams: [{ title: 'Viejo', diagramJson: { cells: [] } }, { title: 'Nuevo', cells: [actor('a', 'A')] }] } });
    const { document, warnings } = fromThreatDragon(mixed);
    expect(document.assets).toHaveLength(1);
    expect(warnings[0]).toMatch(/^1 diagrama\(s\) están en el formato antiguo v1/);
    expect(() => fromThreatDragon('{"summary":{},"detail":{"diagrams":[{"title":"V","diagramJson":{"cells":[]}}]}}')).toThrow(/formato antiguo de Threat Dragon \(v1/);
  });
});

describe('Threat Dragon: entradas patológicas', () => {
  const fails = (input: string, message: RegExp): void => {
    expect(() => fromThreatDragon(input)).toThrow(SecurityImportError);
    expect(() => fromThreatDragon(input)).toThrow(message);
  };

  it('vacío, en blanco, no JSON o truncado dan un motivo claro', () => {
    fails('', /vacío/);
    fails('  \n ', /vacío/);
    fails('flowchart LR\n a --> b', /no es JSON válido/);
    fails(text.slice(0, 5000), /no es JSON válido/);
    fails('{"summary":{"title":"x"},"detail":{"diagrams":[', /termina antes de tiempo/);
  });

  it('un JSON que no es un modelo da un motivo claro', () => {
    fails('[]', /no es un modelo de Threat Dragon/);
    fails('"hola"', /no es un modelo de Threat Dragon/);
    fails('null', /no es un modelo de Threat Dragon/);
    fails('{"a":1}', /no es un modelo de Threat Dragon/);
    fails('{"summary":{},"detail":{"diagrams":"x"}}', /no es un modelo de Threat Dragon/);
    fails('{"summary":{},"detail":{"diagrams":[]}}', /ningún diagrama/);
    fails('{"summary":{},"detail":{"diagrams":[{"title":"V","cells":[]}]}}', /no tiene actores, procesos ni almacenes/);
    fails('{"summary":{},"detail":{"diagrams":[{"title":"V"}]}}', /Ningún diagrama del modelo tiene «cells»/);
    fails(model([{ shape: 'flow', id: 'x', data: {} }, null, 3, 'texto', []]), /no tiene actores/);
  });

  it('un anidamiento enorme se rechaza sin agotar la pila', () => {
    fails(`{"summary":{},"detail":{"diagrams":${'['.repeat(100_000)}${']'.repeat(100_000)}}}`, /anidado/);
    fails(`{"summary":{},"detail":{"diagrams":[{"cells":[{"data":${'{"a":'.repeat(5_000)}1${'}'.repeat(5_000)}}]}]}}`, /anidado en más de/);
  });

  it('un texto de más de 32 MiB se rechaza sin analizarlo', () => {
    fails(`{"summary":{},"detail":{"diagrams":[],"x":"${'a'.repeat(33 * 1024 * 1024)}"}}`, /demasiado grande/);
  });

  it('más celdas que el tope, o demasiadas fronteras, se rechazan con el motivo', () => {
    const many = Array.from({ length: 50_001 }, (_, i) => ({ shape: 'process', id: `p${i}` }));
    fails(model(many), /50001 elementos/);
    const boxes = Array.from({ length: 1_001 }, (_, i) => box(`b${i}`, `B${i}`, i, 0, 1, 1));
    fails(model(boxes), /más de 1000 fronteras/);
  });

  it('diez mil elementos, flujos y amenazas se importan en tiempo razonable', () => {
    const processes = Array.from({ length: 10_000 }, (_, i) => process(`p${i}`, 'Servicio', i % 100, Math.floor(i / 100), { threats: [{ title: 'Amenaza', type: 'Spoofing', status: 'Open', severity: 'Low', mitigation: `Control ${i % 50}` }] }));
    const flows = Array.from({ length: 9_999 }, (_, i) => flow(`f${i}`, ref(`p${i}`), ref(`p${i + 1}`), { name: 'Datos', protocol: 'HTTPS' }));
    const started = Date.now();
    const { document } = fromThreatDragon(model([box('b', 'Todo', 0, 0, 200, 200), ...processes, ...flows]));
    expect(document.assets).toHaveLength(10_000);
    expect(document.flows).toHaveLength(9_999);
    expect(document.threats).toHaveLength(10_000);
    expect(document.controls).toHaveLength(50);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('celdas con tipos inesperados (números, listas, nulos) se ignoran sin fallar', () => {
    const { document, warnings } = fromThreatDragon(
      model([
        actor('a', 'A'),
        { shape: 'process', id: 5, position: 'aquí', size: [1], data: { name: 7, threats: 'no' } },
        { shape: 'store', data: null },
        { shape: 'forma-nueva', data: { type: 'tm.Otro' } },
        flow('f', ref('a'), { cell: 5 }, { protocol: 3, isEncrypted: 'sí' }),
      ]),
    );
    expect(document.assets).toHaveLength(3);
    expect(document.flows).toHaveLength(1);
    expect(warnings.some((w) => w.includes('tipo desconocido') && w.includes('forma-nueva'))).toBe(true);
    expect(warnings.some((w) => w.includes('no traen posición'))).toBe(true);
  });
});
