import { afterEach, describe, expect, it } from 'vitest';
import { CONTRACT_VERSION } from '@iark/kernel';
import { MODULE_PROTOCOL_VERSION, type ModuleEvent } from '../embed/moduleProtocol';
import { createModuleBridge, type ModuleBridge } from './bridge';
import { newController, example } from './testing';

const securityDoc = JSON.parse(example('seguridad-ejemplo.json'));

function harness(options: { module?: string; changeDelay?: number; configure?: boolean } = {}) {
  const controller = newController();
  const events: ModuleEvent[] = [];
  const dialogs: unknown[] = [];
  const configs: unknown[] = [];
  const bridge: ModuleBridge = createModuleBridge({
    controller,
    post: (event) => events.push(event),
    module: options.module,
    configure: options.configure,
    changeDelay: options.changeDelay ?? 5,
    onDialog: (d) => dialogs.push(d),
    onConfigure: (c) => configs.push(c),
  });
  const send = (action: unknown): Promise<void> => bridge.receive(typeof action === 'string' ? action : JSON.stringify(action));
  const last = <T extends ModuleEvent['event']>(name: T): Extract<ModuleEvent, { event: T }> | undefined => [...events].reverse().find((e): e is Extract<ModuleEvent, { event: T }> => e.event === name);
  return { controller, bridge, events, dialogs, configs, send, last };
}

let active: ModuleBridge | undefined;
afterEach(() => active?.dispose());

describe('puente postMessage de módulos', () => {
  it('handshake: init anuncia el módulo de la URL y las capacidades de la instancia', async () => {
    const h = harness({ module: 'data', configure: true });
    active = h.bridge;
    await h.bridge.start();
    expect(h.events[0]).toEqual({ event: 'configure' });
    const init = h.last('init')!;
    expect(init.version).toBe('1.0');
    expect(init.module).toBe('data');
    expect(init.capabilities.available).toEqual(['integration', 'data', 'enterprise', 'platform', 'security']);
    expect(init.capabilities.modules.map((m) => m.id)).toEqual(['data']);
    expect(init.capabilities.modules[0].exportFormats.map((f) => f.id)).toContain('svg');
    expect(init.capabilities.modules[0].commands.map((c) => c.name)).toContain('lineage');
  });

  it('sin módulo en la URL, init lista lo disponible y load elige el módulo', async () => {
    const h = harness();
    active = h.bridge;
    await h.bridge.start();
    expect(h.last('init')!.module).toBeUndefined();
    expect(h.last('init')!.capabilities.modules).toEqual([]);
    await h.send({ action: 'load', module: 'security', document: securityDoc });
    const load = h.last('load')!;
    expect(load.module).toBe('security');
    expect(load.viewId).toBeTruthy();
    expect((load.document as { zones: unknown[] }).zones).toHaveLength(4);
    expect(load.issues.some((i) => i.severity === 'warning')).toBe(true);
  });

  it('load acepta el documento como texto JSON y sin documento abre en blanco', async () => {
    const h = harness({ module: 'security' });
    active = h.bridge;
    await h.bridge.start();
    await h.send({ action: 'load', document: JSON.stringify(securityDoc) });
    expect(h.last('load')!.document).toBeTruthy();
    await h.send({ action: 'load' });
    expect(h.last('load')!.document).toBeNull();
    expect(h.controller.getState().text).toBe('');
  });

  it('load con un documento inválido responde error con las incidencias y no cambia lo abierto', async () => {
    const h = harness({ module: 'security' });
    active = h.bridge;
    await h.bridge.start();
    await h.send({ action: 'load', document: securityDoc });
    const before = h.controller.getState().text;
    await h.send({ action: 'load', document: { version: '9.9', zones: 3 } });
    const error = h.last('error')!;
    expect(error.message).toMatch(/Documento inválido/);
    expect(error.issues?.length).toBeGreaterThan(0);
    expect(h.controller.getState().text).toBe(before);
  });

  it('load con importer convierte el texto (Mermaid) y devuelve los avisos', async () => {
    const h = harness({ module: 'security' });
    active = h.bridge;
    await h.bridge.start();
    await h.send({ action: 'load', document: securityDoc });
    await h.send({ action: 'export', format: 'mermaid', viewId: 'dfd', requestId: 'm1' });
    const mermaid = h.last('export')!.data;
    await h.send({ action: 'load', importer: 'mermaid', document: mermaid });
    const load = h.last('load')!;
    expect((load.document as { assets: unknown[] }).assets.length).toBeGreaterThan(5);
    expect(Array.isArray(load.warnings)).toBe(true);
    await h.send({ action: 'load', importer: 'mermaid', document: { no: 'texto' } });
    expect(h.last('error')!.message).toMatch(/debe ser el texto/);
  });

  it('export devuelve el formato pedido con el requestId para correlacionar', async () => {
    const h = harness({ module: 'security' });
    active = h.bridge;
    await h.bridge.start();
    await h.send({ action: 'load', document: securityDoc });
    await h.send({ action: 'export', format: 'svg', viewId: 'blast:pedidos', requestId: 'x-1' });
    const exported = h.last('export')!;
    expect(exported).toMatchObject({ module: 'security', format: 'svg', mime: 'image/svg+xml', extension: '.svg', viewId: 'blast:pedidos', requestId: 'x-1' });
    expect(exported.data.startsWith('<svg')).toBe(true);
    await h.send({ action: 'export', format: 'json', requestId: 'x-2' });
    expect(JSON.parse(h.last('export')!.data).workspace.name).toBe('Seguridad de la tienda en línea');
    await h.send({ action: 'export', format: 'pdf', requestId: 'x-3' });
    expect(h.last('error')).toMatchObject({ requestId: 'x-3' });
  });

  it('validate informa de validez, incidencias de esquema y reglas del dominio', async () => {
    const h = harness({ module: 'security' });
    active = h.bridge;
    await h.bridge.start();
    await h.send({ action: 'load', document: securityDoc });
    await h.send({ action: 'validate', requestId: 'v1' });
    expect(h.last('issues')).toMatchObject({ valid: true, requestId: 'v1', schemaIssues: [] });
    expect(h.last('issues')!.issues.length).toBeGreaterThan(0);
    h.controller.setText('{ "version": ');
    await h.send({ action: 'validate' });
    expect(h.last('issues')!.valid).toBe(false);
    expect(h.last('issues')!.schemaIssues[0].message).toBeTruthy();
  });

  it('run ejecuta informes y conversiones del módulo', async () => {
    const h = harness({ module: 'security' });
    active = h.bridge;
    await h.bridge.start();
    await h.send({ action: 'load', document: securityDoc });
    await h.send({ action: 'run', command: 'risks', options: { status: 'open' }, requestId: 'r1' });
    const report = h.last('result')!;
    expect(report).toMatchObject({ module: 'security', command: 'risks', kind: 'report', requestId: 'r1' });
    expect(report.output).toContain('| Riesgo |');
    await h.send({ action: 'run', command: 'from-integration', input: JSON.parse(example('pedidos-integracion.json')) });
    expect(h.last('result')!.kind).toBe('convert');
    expect(JSON.parse(h.last('result')!.output).zones).toBeDefined();
    await h.send({ action: 'run', command: 'nada', requestId: 'r2' });
    expect(h.last('error')).toMatchObject({ requestId: 'r2' });
  });

  it('capabilities bajo demanda, de todos los módulos o de los pedidos', async () => {
    const h = harness();
    active = h.bridge;
    await h.send({ action: 'capabilities', requestId: 'c1' });
    expect(h.last('capabilities')!.capabilities.modules).toHaveLength(5);
    expect(h.last('capabilities')!.requestId).toBe('c1');
    await h.send({ action: 'capabilities', modules: ['platform'] });
    expect(h.last('capabilities')!.capabilities.modules.map((m) => m.id)).toEqual(['platform']);
  });

  it('setView cambia la vista, emite viewChange y rechaza las inexistentes', async () => {
    const h = harness({ module: 'security' });
    active = h.bridge;
    await h.bridge.start();
    await h.send({ action: 'load', document: securityDoc });
    await h.send({ action: 'setView', viewId: 'exposure:pedidos-db' });
    expect(h.last('viewChange')).toMatchObject({ module: 'security', viewId: 'exposure:pedidos-db' });
    await h.send({ action: 'setView', viewId: 'nada' });
    expect(h.last('error')!.message).toMatch(/no existe/);
  });

  it('las ediciones emiten change (y autosave si se pidió) una sola vez tras la pausa', async () => {
    const h = harness({ module: 'security', changeDelay: 10 });
    active = h.bridge;
    await h.bridge.start();
    await h.send({ action: 'load', document: securityDoc, autosave: true });
    expect(h.events.some((e) => e.event === 'change')).toBe(false); // cargar no es cambiar
    const edited = { ...securityDoc, workspace: { name: 'Editado' } };
    h.controller.setText(JSON.stringify(edited));
    h.controller.setText(JSON.stringify({ ...edited, workspace: { name: 'Editado dos veces' } }));
    await new Promise((r) => setTimeout(r, 60));
    const changes = h.events.filter((e) => e.event === 'change');
    expect(changes).toHaveLength(1);
    expect((changes[0] as { document: { workspace: { name: string } } }).document.workspace.name).toBe('Editado dos veces');
    expect(h.events.filter((e) => e.event === 'autosave')).toHaveLength(1);
    // un texto inválido no emite nada
    h.controller.setText('{ roto');
    await new Promise((r) => setTimeout(r, 40));
    expect(h.events.filter((e) => e.event === 'change')).toHaveLength(1);
  });

  it('save entrega el documento y limpia el estado; con exit también emite exit', async () => {
    const h = harness({ module: 'security' });
    active = h.bridge;
    await h.bridge.start();
    await h.send({ action: 'load', document: securityDoc });
    h.controller.setText(JSON.stringify({ ...securityDoc, workspace: { name: 'X' } }));
    expect(h.controller.getState().modified).toBe(true);
    await h.send({ action: 'exit' });
    expect(h.last('exit')).toEqual({ event: 'exit', modified: true });
    await h.send({ action: 'save', exit: true });
    expect(h.last('save')).toMatchObject({ module: 'security', exit: true });
    expect(h.controller.getState().modified).toBe(false);
    expect(h.last('exit')).toEqual({ event: 'exit', modified: false });
    h.controller.setText('{ roto');
    await h.send({ action: 'save' });
    expect(h.last('error')!.message).toMatch(/no es válido/);
  });

  it('status, dialog y configure llegan a la interfaz', async () => {
    const h = harness({ module: 'security' });
    active = h.bridge;
    await h.bridge.start();
    await h.send({ action: 'status', message: 'Guardando…', modified: true });
    expect(h.controller.getState()).toMatchObject({ status: 'Guardando…', modified: true });
    await h.send({ action: 'dialog', title: 'Aviso', message: 'Hola' });
    expect(h.dialogs).toEqual([{ title: 'Aviso', message: 'Hola', button: undefined }]);
    await h.send({ action: 'configure', theme: 'dark', ui: 'min' });
    expect(h.configs).toEqual([{ theme: 'dark', ui: 'min' }]);
  });

  it('un mensaje mal formado dirigido al protocolo recibe error; el ruido ajeno se ignora', async () => {
    const h = harness({ module: 'security' });
    active = h.bridge;
    await h.bridge.start();
    const count = h.events.length;
    await h.send('{"action": "export", "format":');
    expect(h.events).toHaveLength(count + 1);
    expect(h.last('error')!.message).toMatch(/JSON válido/);
    await h.send({ action: 'inventada' });
    expect(h.last('error')!.message).toBeTruthy();
    const before = h.events.length;
    await h.send('hola');
    await h.bridge.receive(42);
    await h.bridge.receive(null);
    expect(h.events).toHaveLength(before);
  });

  it('load sin módulo (ni en la URL ni en la acción) explica qué falta', async () => {
    const h = harness();
    active = h.bridge;
    await h.send({ action: 'load', document: securityDoc });
    expect(h.last('error')!.message).toMatch(/Indica el módulo/);
  });
});

describe('puente postMessage de módulos: versionado', () => {
  it('init lleva la versión del protocolo y la versión del contrato de cada módulo anunciado', async () => {
    const h = harness({ module: 'data' });
    active = h.bridge;
    await h.bridge.start();
    expect(h.last('init')!.version).toBe(MODULE_PROTOCOL_VERSION);
    expect(h.last('init')!.capabilities.modules[0].contractVersion).toBe(CONTRACT_VERSION);
  });

  it('un load de un anfitrión con otra versión MAYOR del protocolo se rechaza con el código incompatible-protocol y no abre nada', async () => {
    const h = harness({ module: 'security' });
    active = h.bridge;
    await h.bridge.start();
    const count = h.events.length;
    await h.send({ action: 'load', version: '2.0', document: securityDoc });
    expect(h.events).toHaveLength(count + 1);
    expect(h.last('error')).toMatchObject({ code: 'incompatible-protocol', message: expect.stringMatching(/incompatible.*1\.0.*2\.0/s) });
    expect(h.events.some((e) => e.event === 'load')).toBe(false);
    expect(h.controller.getState().text).toBe('');
  });

  it('mientras esté rechazado ninguna orden se aplica (el error lleva su requestId), salvo exit; un load compatible lo reanuda', async () => {
    const h = harness({ module: 'security' });
    active = h.bridge;
    await h.bridge.start();
    await h.send({ action: 'load', version: '2.0', document: securityDoc });
    await h.send({ action: 'export', format: 'json', requestId: 'x-1' });
    expect(h.last('error')).toMatchObject({ code: 'incompatible-protocol', requestId: 'x-1' });
    expect(h.events.some((e) => e.event === 'export')).toBe(false);
    await h.send({ action: 'exit' });
    expect(h.last('exit')).toEqual({ event: 'exit', modified: false });

    await h.send({ action: 'load', version: '1.0', document: securityDoc });
    expect(h.last('load')).toMatchObject({ module: 'security' });
    await h.send({ action: 'export', format: 'json', requestId: 'x-2' });
    expect(h.last('export')).toMatchObject({ requestId: 'x-2' });
  });

  it.each([['una versión menor distinta (1.7)', '1.7'], ['sin versión (un SDK antiguo = 1.0)', undefined]])('un load con %s se acepta', async (_nombre, version) => {
    const h = harness({ module: 'security' });
    active = h.bridge;
    await h.bridge.start();
    await h.send({ action: 'load', ...(version ? { version } : {}), document: securityDoc });
    expect(h.last('load')).toMatchObject({ module: 'security' });
    expect(h.events.some((e) => e.event === 'error')).toBe(false);
  });

  it('un documento de una versión MÁS NUEVA del formato se rechaza con el mensaje claro y no cambia lo abierto', async () => {
    const h = harness({ module: 'security' });
    active = h.bridge;
    await h.bridge.start();
    await h.send({ action: 'load', document: securityDoc });
    const before = h.controller.getState().text;
    await h.send({ action: 'load', document: { ...securityDoc, version: '7.0' } });
    expect(h.last('error')!.message).toMatch(/versión más nueva \(7\.0\).*Actualiza DIAgrams/s);
    expect(h.controller.getState().text).toBe(before);
  });
});
