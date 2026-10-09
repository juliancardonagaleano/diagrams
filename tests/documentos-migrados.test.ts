import { afterEach, describe, expect, it } from 'vitest';
import { checkProject, MemoryProjectStore, ModuleRegistry, projectTrace, snapshotProject, type AnyModule } from '@iark/kernel';
import { executeJob } from '../src/cli/compute';
import { createModuleBridge, type ModuleBridge } from '../src/modules-app/bridge';
import { readComparable } from '../src/modules-app/compare';
import { WorkbenchController } from '../src/modules-app/controller';
import type { ModuleEvent } from '../src/embed/moduleProtocol';
import { DOC_V10, DOC_V11, DOC_V20, moduloMigrable } from './helpers/moduloMigrable';

/**
 * Los consumidores que leen un documento a través de `analyzeText`/`analyzeValue` heredan la migración sin tocarlos: proyectos
 * guardados, borradores del banco de trabajo, el puente `postMessage`, la comparación y el servicio HTTP. Aquí se comprueba con
 * un módulo cuyo formato ya cambió (1.0 → 1.1 → 2.0): un documento guardado en 1.0 se abre en todos.
 */
const registry = new ModuleRegistry().register(moduloMigrable);
const module = moduloMigrable as AnyModule;
const texto = (value: unknown): string => JSON.stringify(value);

describe('proyectos guardados con documentos antiguos', () => {
  async function proyecto(...textos: Array<[string, string]>) {
    const store = new MemoryProjectStore();
    const project = await store.createProject({ name: 'Antiguo' });
    for (const [name, text] of textos) await store.saveDiagram(project.id, { module: 'prueba', name, text });
    return snapshotProject(store, project.id);
  }

  it('checkProject da por bueno un diagrama guardado en 1.0 y cuenta la nota de migración como informativa', async () => {
    const snapshot = await proyecto(['Pedidos', texto(DOC_V10)]);
    const check = checkProject(snapshot, registry);
    expect(check.ok).toBe(true);
    expect(check.diagrams).toMatchObject([{ status: 'ok', errors: 0, warnings: 0, infos: 1 }]);
  });

  it('el diagrama antiguo entra en la trazabilidad del proyecto con el documento ya migrado', async () => {
    const snapshot = await proyecto(['Antiguo', texto(DOC_V10)], ['Actual', texto({ ...DOC_V20, items: [{ id: 'baja', title: 'Baja' }] })]);
    const trace = projectTrace(snapshot, registry);
    expect(trace.skipped).toEqual([]);
    expect([...trace.owners.keys()].sort()).toEqual(['urn:iark:prueba:alta', 'urn:iark:prueba:baja']);
    expect(trace.owners.get('urn:iark:prueba:alta')?.map((d) => d.name)).toEqual(['Antiguo']);
  });

  it('un diagrama de una versión MÁS NUEVA se marca de esquema con el mensaje claro, sin romper a los demás', async () => {
    const snapshot = await proyecto(['Actual', texto(DOC_V20)], ['Futuro', texto({ ...DOC_V20, version: '3.0' })]);
    const check = checkProject(snapshot, registry);
    expect(check.ok).toBe(false);
    expect(check.diagrams.map((d) => d.status)).toEqual(['ok', 'schema']);
    expect(check.diagrams[1].detail).toMatch(/version: Este documento se creó con una versión más nueva \(3\.0\).*Actualiza DIAgrams/);
  });
});

describe('banco de trabajo: borradores y puente postMessage', () => {
  const sources = [{ id: 'prueba', label: 'Prueba', load: async () => moduloMigrable as AnyModule }];
  let activo: ModuleBridge | undefined;
  afterEach(() => activo?.dispose());

  it('un borrador guardado en 1.0 (localDrafts) se abre migrado, con la nota informativa', async () => {
    const controller = new WorkbenchController(sources, { renderDelay: 0, storage: { read: () => texto(DOC_V10), write: () => undefined } });
    await controller.selectModule('prueba');
    const { analysis, choices } = controller.getState();
    expect(analysis.status).toBe('ok');
    if (analysis.status !== 'ok') return;
    expect(analysis.migrated).toEqual({ from: '1.0', to: '2.0' });
    expect(analysis.document).toEqual(DOC_V20);
    expect(analysis.issues.map((i) => i.severity)).toEqual(['info']);
    expect(choices.views.map((v) => v.id)).toEqual(['lista']);
  });

  it('load, validate y save del anfitrión: el documento viejo llega migrado y el guardado lo escribe en la versión nueva', async () => {
    const controller = new WorkbenchController(sources, { renderDelay: 0 });
    const eventos: ModuleEvent[] = [];
    const bridge = createModuleBridge({ controller, post: (e) => eventos.push(e), changeDelay: 5 });
    activo = bridge;
    const last = <T extends ModuleEvent['event']>(name: T): Extract<ModuleEvent, { event: T }> | undefined => [...eventos].reverse().find((e): e is Extract<ModuleEvent, { event: T }> => e.event === name);
    const send = (action: unknown): Promise<void> => bridge.receive(JSON.stringify(action));

    await send({ action: 'load', module: 'prueba', document: DOC_V10 });
    expect(last('error')).toBeUndefined();
    expect(last('load')!.document).toEqual(DOC_V20);
    expect(last('load')!.issues).toEqual([{ severity: 'info', message: 'Documento migrado de la versión 1.0 a 2.0; al guardarlo se escribe en la nueva.' }]);

    await send({ action: 'validate', requestId: 'v1' });
    expect(last('issues')).toMatchObject({ valid: true, schemaIssues: [], requestId: 'v1' });

    await send({ action: 'save' });
    expect(last('save')!.document).toEqual(DOC_V20);

    // y por la vía de «versión intermedia»: 1.1 también
    await send({ action: 'load', module: 'prueba', document: DOC_V11 });
    expect(last('load')!.document).toEqual(DOC_V20);
  });

  it('un documento de una versión más nueva se rechaza en el load con el mensaje claro (no se carga a medias)', async () => {
    const controller = new WorkbenchController(sources, { renderDelay: 0 });
    const eventos: ModuleEvent[] = [];
    const bridge = createModuleBridge({ controller, post: (e) => eventos.push(e) });
    activo = bridge;
    await bridge.receive(JSON.stringify({ action: 'load', module: 'prueba', document: { ...DOC_V20, version: '9.0' } }));
    const error = eventos.find((e) => e.event === 'error') as Extract<ModuleEvent, { event: 'error' }>;
    expect(error.message).toMatch(/versión más nueva \(9\.0\)/);
    expect(error.issues).toMatchObject([{ path: 'version' }]);
    expect(eventos.some((e) => e.event === 'load')).toBe(false);
  });
});

describe('comparar y servicio HTTP', () => {
  it('«Comparar» lee la versión base antigua ya migrada: se compara versión 2.0 contra versión 2.0', async () => {
    const result = await readComparable(module, texto(DOC_V10), 'antes.json');
    expect(result).toEqual({ ok: true, document: DOC_V20 });
  });

  it('POST /api/<módulo>/validate de un documento antiguo es válido y trae la nota; el export usa el documento migrado', async () => {
    const validate = await executeJob(registry, { op: 'validate', module: 'prueba', body: texto(DOC_V10) });
    expect(validate.kind).toBe('ok');
    const body = JSON.parse(validate.kind === 'ok' ? validate.body : '{}');
    expect(body).toMatchObject({ module: 'prueba', valid: true, schemaIssues: [], issues: [{ severity: 'info' }] });

    const exported = await executeJob(registry, { op: 'export', module: 'prueba', body: texto(DOC_V10), format: 'txt' });
    expect(exported).toMatchObject({ kind: 'ok', body: 'Alta' });
  });

  it('POST /api/<módulo>/validate de una versión más nueva dice por qué no es válido', async () => {
    const outcome = await executeJob(registry, { op: 'validate', module: 'prueba', body: texto({ ...DOC_V20, version: '4.2' }) });
    const body = JSON.parse(outcome.kind === 'ok' ? outcome.body : '{}');
    expect(body.valid).toBe(false);
    expect(body.schemaIssues[0]).toMatchObject({ path: 'version' });
    expect(body.schemaIssues[0].message).toMatch(/más nueva \(4\.2\)/);
  });
});
