import { readFileSync } from 'node:fs';
import { buildManifest, importText, looksLikeMermaid, ModuleError, ModuleRegistry } from '@iark/kernel';
import { describe, expect, it } from 'vitest';
import { toMermaid } from '../export/mermaid';
import { toSvg } from '../export/render';
import { analyzeEnterprise } from '../issues';
import { enterpriseModule } from '../module';
import { validateEnterpriseDocument } from '../schema';
import { RELATION_RULES, indexElements, type EnterpriseDocument } from '../types';
import { listViews } from '../views';
import { looksLikeArchimate } from './archimateXml';
import { fromBpmn, looksLikeBpmn } from './fromBpmn';
import { EnterpriseImportError, fromMermaid } from './fromMermaid';

const fixture = (name: string): string => readFileSync(`tests/fixtures/importar/bpmn/${name}`, 'utf8');
const archimateFixture = readFileSync('tests/fixtures/importar/archimate/comercio-andino.xml', 'utf8');

const NS = 'http://www.omg.org/spec/BPMN/20100524/MODEL';
/** Un modelo mínimo: lo que se pase va dentro de `definitions`, con el espacio de nombres de BPMN por defecto. */
const bpmn = (body: string, attrs = ''): string => `<?xml version="1.0" encoding="UTF-8"?>\n<definitions xmlns="${NS}" ${attrs}>${body}</definitions>`;
/** Un proceso con las actividades y flujos que se den; `tasks` son pares id → nombre y `flows` pares origen → destino. */
const process = (tasks: Array<[string, string?]>, flows: Array<[string, string]> = [], extra = ''): string =>
  `<process id="P">${tasks.map(([id, name]) => `<task id="${id}"${name !== undefined ? ` name="${name}"` : ''}/>`).join('')}${extra}${flows.map(([a, b], i) => `<sequenceFlow id="F${i}" sourceRef="${a}" targetRef="${b}"/>`).join('')}</process>`;
const triples = (doc: EnterpriseDocument): string[] => doc.relations.map((r) => `${r.kind} ${r.sourceId} ${r.targetId}`);
const rel = (doc: EnterpriseDocument, kind: string, source: string, target: string) => doc.relations.find((r) => r.kind === kind && r.sourceId === source && r.targetId === target);
const byId = <T extends { id: string }>(list: T[], id: string): T => {
  const found = list.find((x) => x.id === id);
  if (!found) throw new Error(`No hay «${id}» en ${list.map((x) => x.id).join(', ')}`);
  return found;
};

describe('importar BPMN: colaboración de pedidos (pools, carriles anidados, compuertas, subproceso y llamada)', () => {
  const { document: doc, warnings } = fromBpmn(fixture('pedidos-colaboracion.bpmn'), { fallbackName: 'pedidos.bpmn' });

  it('pasa el esquema y cada relación respeta RELATION_RULES', () => {
    expect(validateEnterpriseDocument(doc).ok).toBe(true);
    const elements = indexElements(doc);
    for (const r of doc.relations) {
      const source = elements.get(r.sourceId)!;
      const target = elements.get(r.targetId)!;
      expect(RELATION_RULES[r.kind].some(([a, b]) => a === source.kind && b === target.kind), `${r.kind} ${source.kind} → ${target.kind}`).toBe(true);
      expect(r.sourceId).not.toBe(r.targetId);
    }
    expect(new Set(doc.relations.map((r) => `${r.kind}|${r.sourceId}|${r.targetId}`)).size).toBe(doc.relations.length);
    expect(analyzeEnterprise(doc).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('el nombre del espacio de trabajo sale del modelo, y la descripción cuenta lo que se leyó', () => {
    expect(doc.workspace.name).toBe('Proceso de pedidos');
    expect(doc.workspace.description).toBe('Importado de un modelo BPMN 2.0: 3 proceso(s), 4 participante(s) y 12 actividad(es).');
  });

  it('pools y carriles: cada pool es una unidad, los carriles cuelgan de ella y los anidados de su carril', () => {
    expect(doc.units.map((u) => u.id)).toEqual(['tienda-en-linea', 'cliente', 'pasarela-de-pagos', 'transportista', 'ventas', 'almacen', 'finanzas', 'expediciones']);
    expect(byId(doc.units, 'ventas').parentId).toBe('tienda-en-linea');
    expect(byId(doc.units, 'almacen').parentId).toBe('tienda-en-linea');
    expect(byId(doc.units, 'expediciones').parentId).toBe('almacen');
    expect(byId(doc.units, 'tienda-en-linea').parentId).toBeUndefined();
  });

  it('un pool sin proceso es una caja negra: unidad externa y un proceso marcado que recibe y envía mensajes', () => {
    for (const id of ['pasarela-de-pagos', 'transportista']) expect(byId(doc.units, id)).toMatchObject({ external: true, description: 'Participante sin proceso detallado (caja negra).' });
    expect(byId(doc.units, 'cliente').external).toBeUndefined();
    expect(byId(doc.processes, 'pasarela-de-pagos-2')).toMatchObject({ ownerId: 'pasarela-de-pagos', tags: ['bpmn', 'caja-negra'] });
    expect(rel(doc, 'assigned-to', 'pasarela-de-pagos', 'pasarela-de-pagos-2')).toBeDefined();
    expect(rel(doc, 'flows-to', 'cobrar-pedido', 'pasarela-de-pagos-2')?.description).toBe('Solicitud de cobro');
    expect(rel(doc, 'flows-to', 'pasarela-de-pagos-2', 'cobrar-pedido')?.description).toBe('Resultado del cobro');
    expect(rel(doc, 'flows-to', 'preparar-envio', 'transportista-2')?.description).toBe('Bulto para entregar');
  });

  it('procesos: el de cada pool con el pool como responsable, el suelto sin él, con la documentación y el inicio y fin', () => {
    expect(byId(doc.processes, 'gestion-de-pedidos')).toMatchObject({
      ownerId: 'tienda-en-linea',
      tags: ['bpmn', 'proceso-bpmn'],
      description: 'Desde que entra un pedido hasta que se entrega y se factura. · Inicio: Pedido recibido. Fin: Pedido cancelado, Pedido completado',
    });
    expect(byId(doc.processes, 'compra-del-cliente').ownerId).toBe('cliente');
    expect(byId(doc.processes, 'facturacion').ownerId).toBeUndefined();
    expect(rel(doc, 'assigned-to', 'tienda-en-linea', 'gestion-de-pedidos')).toBeDefined();
    expect(rel(doc, 'assigned-to', 'cliente', 'compra-del-cliente')).toBeDefined();
  });

  it('actividades: proceso hijo de su proceso o subproceso, con el carril como responsable y su tipo de BPMN en las etiquetas', () => {
    expect(byId(doc.processes, 'validar-pedido')).toMatchObject({ ownerId: 'ventas', tags: ['bpmn', 'tarea-de-usuario'], description: 'Comprueba los datos del cliente y la dirección de entrega.' });
    expect(byId(doc.processes, 'reservar-stock')).toMatchObject({ ownerId: 'almacen', tags: ['bpmn', 'tarea-de-servicio'] });
    expect(byId(doc.processes, 'avisar-de-falta-de-stock').tags).toEqual(['bpmn', 'tarea-de-envio']);
    expect(byId(doc.processes, 'embalar-los-articulos').tags).toEqual(['bpmn', 'tarea-manual']);
    expect(byId(doc.processes, 'calcular-los-impuestos').tags).toEqual(['bpmn', 'tarea-de-reglas']);
    expect(byId(doc.processes, 'generar-la-factura-en-pdf').tags).toEqual(['bpmn', 'tarea-de-script']);
    expect(byId(doc.processes, 'realizar-el-pedido').tags).toEqual(['bpmn', 'tarea']);
    // el carril anidado manda sobre el carril padre
    expect(byId(doc.processes, 'preparar-envio').ownerId).toBe('expediciones');
    // una actividad sin carril propio hereda el del subproceso que la contiene
    expect(byId(doc.processes, 'embalar-los-articulos').ownerId).toBe('expediciones');
    expect(rel(doc, 'assigned-to', 'ventas', 'validar-pedido')).toBeDefined();
    // en un proceso sin carriles ni pool, la actividad no tiene responsable
    expect(byId(doc.processes, 'calcular-los-impuestos').ownerId).toBeUndefined();
    expect(triples(doc)).toEqual(expect.arrayContaining(['composes gestion-de-pedidos validar-pedido', 'composes preparar-envio embalar-los-articulos', 'composes preparar-envio etiquetar-el-bulto', 'composes facturacion calcular-los-impuestos']));
    expect(rel(doc, 'composes', 'gestion-de-pedidos', 'embalar-los-articulos')).toBeUndefined();
  });

  it('el subproceso guarda su inicio y su fin, y la actividad de llamada, el proceso que llama', () => {
    expect(byId(doc.processes, 'preparar-envio').description).toBe('Prepara el bulto y le pone la etiqueta del transportista. · Inicio: Hay que preparar el bulto. Fin: Bulto listo');
    expect(byId(doc.processes, 'emitir-factura')).toMatchObject({ tags: ['bpmn', 'actividad-de-llamada'], description: 'Llama al proceso «Process_Facturacion»' });
    expect(rel(doc, 'composes', 'emitir-factura', 'facturacion')).toBeDefined();
  });

  it('secuencia: las compuertas y los eventos desaparecen y su nombre queda en la relación entre actividades', () => {
    expect(rel(doc, 'triggers', 'validar-pedido', 'reservar-stock')?.description).toBe('Compuerta exclusiva: ¿Hay stock? → Sí');
    expect(rel(doc, 'triggers', 'validar-pedido', 'avisar-de-falta-de-stock')?.description).toBe('Compuerta exclusiva: ¿Hay stock? → No');
    expect(rel(doc, 'triggers', 'reservar-stock', 'cobrar-pedido')?.description).toBe('Compuerta paralela: Cobrar y preparar a la vez');
    expect(rel(doc, 'triggers', 'reservar-stock', 'preparar-envio')?.description).toBe('Compuerta paralela: Cobrar y preparar a la vez');
    expect(rel(doc, 'triggers', 'cobrar-pedido', 'emitir-factura')?.description).toBe('Compuerta paralela');
    expect(rel(doc, 'triggers', 'preparar-envio', 'emitir-factura')).toBeDefined();
    expect(rel(doc, 'triggers', 'embalar-los-articulos', 'etiquetar-el-bulto')).toBeDefined();
    expect(rel(doc, 'triggers', 'calcular-los-impuestos', 'generar-la-factura-en-pdf')).toBeDefined();
    // ninguna compuerta ni evento llegó a ser un proceso
    expect(doc.processes.map((p) => p.name)).not.toEqual(expect.arrayContaining(['¿Hay stock?', 'Pedido recibido', 'Cobrar y preparar a la vez']));
    expect(doc.processes).toHaveLength(17);
  });

  it('un evento límite cuelga de su actividad: su disparo sale de ella con el evento en la descripción', () => {
    expect(rel(doc, 'triggers', 'cobrar-pedido', 'revisar-el-cobro-a-mano')?.description).toBe('Evento límite de temporizador: Cobro sin respuesta');
    expect(rel(doc, 'triggers', 'revisar-el-cobro-a-mano', 'emitir-factura')).toBeDefined();
  });

  it('flujos de mensaje: entre actividades, hacia un evento (a la actividad que lo sigue o lo precede) y hacia un pool', () => {
    // el mensaje que arranca el proceso de la tienda llega a la primera tarea que sigue al evento de inicio
    expect(rel(doc, 'flows-to', 'realizar-el-pedido', 'validar-pedido')?.description).toBe('Pedido');
    // el fin de la tienda envía la confirmación al evento de espera del cliente, que no tiene actividad detrás: va a su proceso
    expect(rel(doc, 'flows-to', 'emitir-factura', 'compra-del-cliente')?.description).toBe('Confirmación del pedido');
    expect(doc.relations.filter((r) => r.kind === 'flows-to')).toHaveLength(5);
  });

  it('avisa de todo lo que no entra, con cuentas', () => {
    expect(warnings).toHaveLength(7);
    expect(warnings[0]).toBe('2 participante(s) sin proceso detallado («Pasarela de pagos», «Transportista») se importan como unidad externa con un proceso marcado «caja-negra», para poder recibir y enviar mensajes.');
    expect(warnings[1]).toContain('11 evento(s) y 3 compuerta(s) no son procesos');
    expect(warnings[2]).toBe('1 flujo(s) de secuencia o evento(s) límite apuntan a un elemento que no existe y se ignoran.');
    expect(warnings[3]).toBe('1 flujo(s) de mensaje apuntan a un elemento que no existe o que no tiene actividades, y se ignoran.');
    expect(warnings[4]).toBe('Sin correspondencia en el módulo, no se importan: 1 anotación(es), 1 asociación(es), 1 actividad(es) multiinstancia, 1 objeto(s) de datos, 1 referencia(s) a objetos de datos, 1 almacén(es) de datos, 1 grupo(s).');
    expect(warnings[5]).toBe('Extensiones de herramienta no importadas: 1 bloque(s) «extensionElements» y atributos de «camunda:».');
    expect(warnings[6]).toBe('1 diagrama(s) gráfico(s) (BPMNDI) no se importan: el módulo calcula su propia distribución.');
  });

  it('se ve en el lienzo y se exporta: vistas, SVG sin NaN y un Mermaid que vuelve a importarse', async () => {
    const views = listViews(doc);
    expect(views.map((v) => v.id)).toEqual(expect.arrayContaining(['landscape', 'unit:tienda-en-linea']));
    for (const id of ['landscape', 'unit:tienda-en-linea', 'focus:validar-pedido']) {
      const svg = await toSvg(doc, id);
      expect(svg, id).toContain('<svg');
      expect(svg, id).not.toContain('NaN');
    }
    const mmd = toMermaid(doc, { viewId: 'landscape' });
    expect(mmd.length).toBeGreaterThan(100);
    expect(mmd).toContain('Validar pedido');
    expect(fromMermaid(mmd).document.processes.map((p) => p.id)).toEqual(expect.arrayContaining(['validar-pedido', 'cobrar-pedido']));
  }, 60_000);

  it('importar dos veces el mismo archivo da el mismo documento y los mismos avisos; BOM y saltos de línea no cambian nada', () => {
    const text = fixture('pedidos-colaboracion.bpmn');
    const again = fromBpmn(text, { fallbackName: 'pedidos.bpmn' });
    expect(again.document).toEqual(doc);
    expect(again.warnings).toEqual(warnings);
    const crlf = fromBpmn(`﻿${text.replace(/\n/g, '\r\n')}`, { fallbackName: 'pedidos.bpmn' });
    expect(crlf.document).toEqual(doc);
    expect(crlf.warnings).toEqual(warnings);
  });
});

describe('importar BPMN: solicitud de vacaciones (sin prefijo, un solo proceso con carriles y compuerta inclusiva)', () => {
  const { document: doc, warnings } = fromBpmn(fixture('solicitud-vacaciones.bpmn'), { fallbackName: 'solicitud-vacaciones.bpmn' });

  it('los carriles son unidades sueltas (no hay pool) y cada tarea cuelga del proceso con su carril como responsable', () => {
    expect(validateEnterpriseDocument(doc).ok).toBe(true);
    expect(doc.workspace.name).toBe('solicitud-vacaciones');
    expect(doc.units).toEqual([{ id: 'empleado', name: 'Empleado' }, { id: 'responsable-de-equipo', name: 'Responsable de equipo' }, { id: 'recursos-humanos', name: 'Recursos humanos' }]);
    expect(doc.processes.map((p) => [p.id, p.ownerId ?? null])).toEqual([
      ['solicitud-de-vacaciones', null],
      ['solicitar-vacaciones', 'empleado'],
      ['revisar-la-solicitud', 'responsable-de-equipo'],
      ['registrar-la-ausencia-en-el-calendario', 'recursos-humanos'],
      ['notificar-el-rechazo', 'responsable-de-equipo'],
    ]);
    expect(byId(doc.processes, 'solicitud-de-vacaciones').description).toBe('Inicio: Quiere descansar. Fin: Vacaciones concedidas, Solicitud rechazada');
  });

  it('la compuerta inclusiva y las condiciones de las ramas quedan en la descripción del disparo', () => {
    expect(triples(doc).filter((t) => t.startsWith('triggers'))).toEqual([
      'triggers solicitar-vacaciones revisar-la-solicitud',
      'triggers revisar-la-solicitud notificar-el-rechazo',
      'triggers revisar-la-solicitud registrar-la-ausencia-en-el-calendario',
    ]);
    expect(rel(doc, 'triggers', 'revisar-la-solicitud', 'registrar-la-ausencia-en-el-calendario')?.description).toBe('Compuerta inclusiva: ¿Se aprueba? → Sí');
    expect(warnings).toEqual(['3 evento(s) y 1 compuerta(s) no son procesos: las relaciones que pasan por ellos se unen directamente entre actividades y sus nombres y las condiciones de las ramas quedan en la descripción de la relación.']);
  });
});

describe('importar BPMN: casos de estructura', () => {
  it('un proceso sin pool ni carriles: tareas sin responsable, y nombres repetidos o ausentes con ids distintos', () => {
    const { document: doc } = fromBpmn(bpmn(process([['a', 'Revisar'], ['b', 'Revisar'], ['c'], ['d']], [['a', 'b'], ['b', 'c'], ['c', 'd']])));
    expect(doc.units).toEqual([]);
    expect(doc.processes.map((p) => p.name)).toEqual(['Proceso P', 'Revisar', 'Revisar', 'Tarea sin nombre', 'Tarea sin nombre']);
    expect(new Set(doc.processes.map((p) => p.id)).size).toBe(5);
    expect(doc.processes.every((p) => p.ownerId === undefined)).toBe(true);
    expect(triples(doc).filter((t) => t.startsWith('triggers'))).toHaveLength(3);
  });

  it('el nombre del modelo, el que se pida o el del archivo (sin extensión), por ese orden', () => {
    const body = process([['a', 'Hacer']]);
    expect(fromBpmn(bpmn(body, 'name="Mi modelo"')).document.workspace.name).toBe('Mi modelo');
    expect(fromBpmn(bpmn(body, 'name="Mi modelo"'), { name: 'Explícito' }).document.workspace.name).toBe('Explícito');
    expect(fromBpmn(bpmn(body), { fallbackName: 'compras.bpmn' }).document.workspace.name).toBe('compras');
    expect(fromBpmn(bpmn(body), { fallbackName: 'export.xml' }).document.workspace.name).toBe('export');
    expect(fromBpmn(bpmn(body)).document.workspace.name).toBe('Procesos BPMN');
  });

  it('un bucle de una tarea hacia sí misma se avisa; un ciclo que pasa por compuertas no cuelga ni repite', () => {
    const loop = fromBpmn(bpmn(process([['a', 'Intentar'], ['b', 'Confirmar']], [['a', 'a'], ['a', 'b']])));
    expect(loop.warnings.join('\n')).toContain('1 bucle(s) de una actividad hacia sí misma no se importan');
    expect(triples(loop.document).filter((t) => t.startsWith('triggers'))).toEqual(['triggers intentar confirmar']);
    const cycle = fromBpmn(
      bpmn(process([['a', 'Pedir'], ['b', 'Entregar']], [['a', 'g1'], ['g1', 'g2'], ['g2', 'g1'], ['g2', 'b'], ['g1', 'b']], '<exclusiveGateway id="g1"/><exclusiveGateway id="g2" name="Otra vez"/>')),
    );
    expect(triples(cycle.document).filter((t) => t.startsWith('triggers'))).toEqual(['triggers pedir entregar']);
  });

  it('subprocesos anidados: cada uno cuelga del que lo contiene', () => {
    const body = `<process id="P"><subProcess id="s1" name="Exterior"><subProcess id="s2" name="Interior"><task id="t" name="Hoja"/></subProcess></subProcess></process>`;
    const { document: doc } = fromBpmn(bpmn(body));
    expect(triples(doc)).toEqual(['composes proceso-p exterior', 'composes exterior interior', 'composes interior hoja']);
    expect(byId(doc.processes, 'exterior').tags).toEqual(['bpmn', 'subproceso']);
  });

  it('una actividad de llamada a un proceso que no está, o al propio, queda sin relación y se avisa', () => {
    const body = `<process id="P"><callActivity id="c1" name="Fuera" calledElement="Otro"/><callActivity id="c2" name="Recursiva" calledElement="P"/></process>`;
    const { document: doc, warnings } = fromBpmn(bpmn(body));
    expect(triples(doc)).toEqual(['composes proceso-p fuera', 'composes proceso-p recursiva']);
    expect(byId(doc.processes, 'fuera').description).toBe('Llama al proceso «Otro»');
    expect(warnings.join('\n')).toContain('2 actividad(es) de llamada llaman a un proceso que no está en el archivo o a su propio proceso');
  });

  it('un nodo citado por un carril que no existe no rompe nada, y un carril sin nombre recibe uno', () => {
    const lanes = `<laneSet id="ls"><lane id="l1"><flowNodeRef>a</flowNodeRef><flowNodeRef>fantasma</flowNodeRef></lane></laneSet>`;
    const { document: doc } = fromBpmn(bpmn(process([['a', 'Hacer']], [], lanes)));
    expect(doc.units).toHaveLength(1);
    expect(doc.units[0].name).toMatch(/^Carril /);
    expect(byId(doc.processes, 'hacer').ownerId).toBe(doc.units[0].id);
  });

  it('un pool cuyo proceso no existe es una caja negra; dos pools con el mismo nombre dan ids distintos', () => {
    const body = `<collaboration id="c"><participant id="p1" name="Banco" processRef="NoExiste"/><participant id="p2" name="Banco"/></collaboration>${process([['a', 'Hacer']])}`;
    const { document: doc, warnings } = fromBpmn(bpmn(body));
    expect(doc.units.map((u) => [u.id, u.external === true])).toEqual([['banco', true], ['banco-2', true]]);
    expect(warnings).toEqual([]);
  });

  it('coreografías, conversaciones y bucles: se cuentan en un solo aviso', () => {
    const body = `<collaboration id="c"><conversation id="cv"/><conversationLink id="cl" sourceRef="a" targetRef="b"/></collaboration><choreography id="ch"/>${process([['a', 'Hacer']], [], '<standardLoopCharacteristics/>')}`;
    const { warnings } = fromBpmn(bpmn(body));
    expect(warnings).toEqual(['Sin correspondencia en el módulo, no se importan: 1 conversación(es), 1 enlace(s) de conversación, 1 coreografía(s), 1 bucle(s) estándar.']);
  });

  it('un mensaje cuyo origen o destino no existe se ignora con aviso, y lo demás se importa', () => {
    const body = `<collaboration id="c"><messageFlow id="m1" sourceRef="a" targetRef="nada"/><messageFlow id="m2" sourceRef="a" targetRef="b"/></collaboration>${process([['a', 'Pedir'], ['b', 'Servir']])}`;
    const { document: doc, warnings } = fromBpmn(bpmn(body));
    expect(triples(doc).filter((t) => t.startsWith('flows-to'))).toEqual(['flows-to pedir servir']);
    expect(warnings).toEqual(['1 flujo(s) de mensaje apuntan a un elemento que no existe o que no tiene actividades, y se ignoran.']);
  });

  it('un modelo con prefijo distinto y atributos de otra herramienta se lee igual y cuenta las extensiones', () => {
    const text = `<m:definitions xmlns:m="${NS}" xmlns:x="urn:otra"><m:process id="P" x:rol="a"><m:task id="t" name="Hacer" x:peso="3"><m:extensionElements><x:dato/></m:extensionElements></m:task></m:process></m:definitions>`;
    const { document: doc, warnings } = fromBpmn(text);
    expect(doc.processes.map((p) => p.name)).toEqual(['Proceso P', 'Hacer']);
    expect(warnings).toEqual(['Extensiones de herramienta no importadas: 1 bloque(s) «extensionElements» y atributos de «x:».']);
  });

  it('un proceso sin actividades da un documento válido y un aviso', () => {
    const { document: doc, warnings } = fromBpmn(bpmn('<collaboration id="c"><participant id="p" name="Solo pool" processRef="P"/></collaboration><process id="P" name="Vacío"/>'));
    expect(validateEnterpriseDocument(doc).ok).toBe(true);
    expect(doc.units.map((u) => u.name)).toEqual(['Solo pool']);
    expect(warnings).toEqual(['El BPMN no define actividades, eventos ni compuertas: solo se importan los participantes, los carriles y los procesos.']);
  });
});

describe('importar BPMN: entradas que no son un BPMN utilizable', () => {
  it('vacío, sin XML o sin cerrar: error de una línea, de la clase del módulo', () => {
    const run = () => fromBpmn('');
    expect(run).toThrow(EnterpriseImportError);
    expect(run).toThrow(ModuleError);
    expect(run).toThrow('El archivo de BPMN está vacío.');
    expect(() => fromBpmn('  \n ')).toThrow(/está vacío/);
    expect(() => fromBpmn('flowchart LR\n a --> b')).toThrow(/XML mal formado|raíz/);
    expect(() => fromBpmn('{"definitions":{}}')).toThrow(EnterpriseImportError);
    expect(() => fromBpmn(`<definitions xmlns="${NS}"><process id="P">`)).toThrow(/^XML mal formado: el documento termina con etiquetas sin cerrar/);
    expect(() => fromBpmn(bpmn('<process id="P"></task>'))).toThrow(/XML mal formado: se esperaba «<\/process>»/);
    expect(() => fromBpmn(bpmn('<process id="P"/>').slice(0, 120))).toThrow(/XML mal formado/);
  });

  it('otra raíz, sin procesos o sin nada que importar', () => {
    expect(() => fromBpmn('<?xml version="1.0"?>\n<mxfile><diagram/></mxfile>')).toThrow(/La raíz del XML es «mxfile»: un modelo BPMN 2.0 empieza por «definitions»/);
    expect(() => fromBpmn(bpmn(''))).toThrow(/no define ningún proceso/);
    expect(() => fromBpmn(bpmn('<collaboration id="c"><participant id="p" name="X"/></collaboration>'))).toThrow(/no define ningún proceso/);
    expect(() => fromBpmn(bpmn('<process id="P"/>'))).toThrow(/no tiene actividades, eventos ni participantes/);
  });

  it('no admite entidades propias (expansión de entidades), ni siquiera con un DOCTYPE', () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY a "x">]>\n<definitions xmlns="${NS}"><process id="P" name="&a;"><task id="t"/></process></definitions>`;
    expect(() => fromBpmn(bomb)).toThrow(/declara entidades propias/);
    const xxe = `<?xml version="1.0"?><!DOCTYPE d [<!ENTITY secreto SYSTEM "file:///etc/passwd">]>\n<definitions xmlns="${NS}"><process id="P" name="&secreto;"/></definitions>`;
    expect(() => fromBpmn(xxe)).toThrow(/declara entidades propias/);
  });

  it('un texto de más de 32 MiB se rechaza antes de analizarlo', () => {
    const big = `<definitions xmlns="${NS}">${' '.repeat(33 * 1024 * 1024)}</definitions>`;
    expect(() => fromBpmn(big)).toThrow(/demasiado grande/);
  });

  it('un anidamiento de cientos de niveles se rechaza con un error, sin agotar la pila', () => {
    const deep = bpmn(`<process id="P">${'<subProcess id="s">'.repeat(400)}<task id="t"/>${'</subProcess>'.repeat(400)}</process>`);
    expect(() => fromBpmn(deep)).toThrow(EnterpriseImportError);
    expect(() => fromBpmn(deep)).toThrow(/anidado en más de 100 niveles|anidado/);
    const abyss = bpmn(`<process id="P">${'<a>'.repeat(50_000)}${'</a>'.repeat(50_000)}</process>`);
    expect(() => fromBpmn(abyss)).toThrow(EnterpriseImportError);
  });

  it('subprocesos anidados 90 niveles caben', () => {
    const ok = bpmn(`<process id="P">${'<subProcess id="s">'.repeat(90)}<task id="t" name="Hoja"/>${'</subProcess>'.repeat(90)}</process>`);
    const { document: doc } = fromBpmn(ok);
    expect(validateEnterpriseDocument(doc).ok).toBe(true);
    expect(doc.processes.some((p) => p.name === 'Hoja')).toBe(true);
  }, 30_000);

  it('10.000 tareas encadenadas se importan deprisa y dan un documento válido', () => {
    const n = 10_000;
    const tasks: Array<[string, string]> = Array.from({ length: n }, (_, i) => [`t${i}`, `Tarea ${i}`]);
    const flows: Array<[string, string]> = Array.from({ length: n - 1 }, (_, i) => [`t${i}`, `t${i + 1}`]);
    const started = Date.now();
    const { document: doc } = fromBpmn(bpmn(process(tasks, flows)));
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(doc.processes).toHaveLength(n + 1);
    expect(doc.relations.filter((r) => r.kind === 'triggers')).toHaveLength(n - 1);
    expect(validateEnterpriseDocument(doc).ok).toBe(true);
  }, 60_000);

  it('más de 50.000 elementos de flujo se rechaza con un error claro', () => {
    const tasks: Array<[string]> = Array.from({ length: 50_001 }, (_, i) => [`t${i}`]);
    expect(() => fromBpmn(bpmn(process(tasks)))).toThrow(/más de 50000 actividades, eventos y compuertas/);
  }, 60_000);

  it('un grafo de compuertas denso no se recorre sin fin: se corta con un aviso y termina', () => {
    const gates = 400;
    const tasks: Array<[string]> = Array.from({ length: 1500 }, (_, i) => [`t${i}`]);
    const flows: Array<[string, string]> = [];
    for (let i = 0; i < gates; i += 1) for (let j = 0; j < gates; j += 1) if (i !== j) flows.push([`g${i}`, `g${j}`]);
    for (const [id] of tasks) flows.push([id, 'g0'], ['g1', id]);
    const gateways = Array.from({ length: gates }, (_, i) => `<parallelGateway id="g${i}"/>`).join('');
    const started = Date.now();
    const { document: doc, warnings } = fromBpmn(bpmn(process(tasks, flows, gateways)));
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(validateEnterpriseDocument(doc).ok).toBe(true);
    expect(warnings.join('\n')).toContain('tantas compuertas y eventos encadenados');
  }, 60_000);

  it('una cadena larga de compuertas deja pocas etiquetas en la descripción, no miles', () => {
    const gates = 300;
    const flows: Array<[string, string]> = [['a', 'g0']];
    for (let i = 0; i < gates - 1; i += 1) flows.push([`g${i}`, `g${i + 1}`]);
    flows.push([`g${gates - 1}`, 'b']);
    const gateways = Array.from({ length: gates }, (_, i) => `<exclusiveGateway id="g${i}" name="Paso ${i}"/>`).join('');
    const { document: doc } = fromBpmn(bpmn(process([['a', 'Origen'], ['b', 'Destino']], flows, gateways)));
    const description = rel(doc, 'triggers', 'origen', 'destino')?.description ?? '';
    expect(description.startsWith('… → ')).toBe(true);
    expect(description.endsWith('Paso 299')).toBe(true);
    expect(description.length).toBeLessThanOrEqual(200);
  });
});

describe('importar BPMN: detección del formato', () => {
  it('reconoce BPMN con prefijo, con espacio de nombres por defecto, con prólogo, comentarios y BOM', () => {
    expect(looksLikeBpmn(fixture('pedidos-colaboracion.bpmn'))).toBe(true);
    expect(looksLikeBpmn(fixture('solicitud-vacaciones.bpmn'))).toBe(true);
    expect(looksLikeBpmn(`﻿<?xml version="1.0"?>\n<!-- c -->\n<definitions xmlns="${NS}"/>`)).toBe(true);
    expect(looksLikeBpmn(`<bpmn2:definitions xmlns:bpmn2="${NS}"/>`)).toBe(true);
  });

  it('no confunde con ArchiMate, Mermaid, JSON, otros XML ni un «definitions» sin el espacio de nombres de BPMN', () => {
    for (const text of [
      archimateFixture,
      'flowchart LR\n  a --> b',
      '{"definitions":{}}',
      '<mxfile><diagram/></mxfile>',
      '<definitions><process id="P"/></definitions>',
      '<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"/>',
      '<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"/>',
      `<?xml version="1.0"?><model xmlns="${NS}"/>`,
      '',
      'texto cualquiera',
      '<!-- sin cerrar',
    ]) {
      expect(looksLikeBpmn(text), text.slice(0, 60)).toBe(false);
    }
    expect(looksLikeMermaid(fixture('pedidos-colaboracion.bpmn'))).toBe(false);
    expect(looksLikeArchimate(fixture('pedidos-colaboracion.bpmn'))).toBe(false);
  });

  it('el módulo lo ofrece junto a Mermaid y ArchiMate; `.xml` lo decide el contenido y `.bpmn` es suyo', async () => {
    expect(enterpriseModule.importers.map((i) => i.id)).toEqual(['mermaid', 'archimate', 'bpmn']);
    const importer = enterpriseModule.importers.find((i) => i.id === 'bpmn')!;
    expect(importer.extensions).toEqual(['.bpmn', '.xml']);
    expect(importer.detect!(fixture('solicitud-vacaciones.bpmn'))).toBe(true);
    expect(importer.detect!(archimateFixture)).toBe(false);
    const registry = new ModuleRegistry().register(enterpriseModule);
    expect(registry.detectImporter('enterprise', 'pedidos.bpmn', fixture('pedidos-colaboracion.bpmn'))?.id).toBe('bpmn');
    expect(registry.detectImporter('enterprise', 'export.xml', fixture('pedidos-colaboracion.bpmn'))?.id).toBe('bpmn');
    expect(registry.detectImporter('enterprise', 'export.xml', archimateFixture)?.id).toBe('archimate');
    expect(registry.detectImporter('enterprise', undefined, fixture('solicitud-vacaciones.bpmn'))?.id).toBe('bpmn');
    expect(registry.detectImporter('enterprise', 'mapa.mmd', 'flowchart LR\n a --> b')?.id).toBe('mermaid');
    // un `.xml` que ninguno reconoce va al primero que lo declara (ArchiMate), que explica por qué no lo lee; sin extensión no hay a quién ofrecérselo
    expect(registry.detectImporter('enterprise', 'otro.xml', '<mxfile/>')?.id).toBe('archimate');
    expect(registry.detectImporter('enterprise', undefined, '<mxfile/>')).toBeUndefined();
    const manifest = buildManifest(registry, { name: 'Prueba', version: '0.0.0' });
    expect(manifest.modules[0]).toMatchObject({ id: 'enterprise', importFormats: ['mermaid', 'archimate', 'bpmn'] });
    // la misma ruta que usan el CLI y el banco de trabajo
    const imported = await importText(enterpriseModule, fixture('solicitud-vacaciones.bpmn'), undefined, { fallbackName: 'solicitud-vacaciones.bpmn' });
    expect(imported.importer).toBe('bpmn');
    expect((imported.document as EnterpriseDocument).processes).toHaveLength(5);
    const named = await importText(enterpriseModule, fixture('solicitud-vacaciones.bpmn'), 'bpmn', { name: 'RR. HH.' });
    expect((named.document as EnterpriseDocument).workspace.name).toBe('RR. HH.');
    await expect(importText(enterpriseModule, '<definitions', 'bpmn')).rejects.toThrow(/XML mal formado/);
  });
});
