import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { ProjectError } from '@iark/kernel';
import { projectStoreContract } from '../../tests/helpers/projectStoreContract';
import { projectVersionsContract } from '../../tests/helpers/projectVersionsContract';
import { IndexedDbProjectStore, indexedDbAvailable } from './indexedDbStore';

// Cada prueba del contrato usa su propia base (una fábrica de IndexedDB nueva), sin estado compartido.
projectStoreContract('IndexedDB', async () => {
  const store = new IndexedDbProjectStore(new IDBFactory());
  return { store, cleanup: () => store.close() };
});

projectVersionsContract('IndexedDB', async ({ policy, clock }) => {
  const store = new IndexedDbProjectStore(new IDBFactory(), 'iark-projects', { versions: policy, clock: () => clock.now().getTime() });
  return { store, cleanup: () => store.close() };
});

/** Abre la base como la dejaba la versión 1 del almacén (sin historial) y le pone un proyecto con un diagrama. */
async function legacyDatabase(factory: IDBFactory): Promise<{ projectId: string; diagramId: string }> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = factory.open('iark-projects', 1);
    opening.onupgradeneeded = () => {
      const created = opening.result;
      created.createObjectStore('projects', { keyPath: 'id' });
      created.createObjectStore('diagrams', { keyPath: 'id' }).createIndex('byProject', 'projectId');
      created.createObjectStore('documents', { keyPath: 'id' });
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['projects', 'diagrams', 'documents'], 'readwrite');
    const stamp = '2026-01-01T10:00:00.000Z';
    tx.objectStore('projects').add({ id: 'p-viejo', name: 'Antiguo', createdAt: stamp, updatedAt: stamp });
    tx.objectStore('diagrams').add({ id: 'd-viejo', projectId: 'p-viejo', module: 'c4', name: 'Contexto', createdAt: stamp, updatedAt: stamp });
    tx.objectStore('documents').add({ id: 'd-viejo', text: 'contenido de antes del historial' });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return { projectId: 'p-viejo', diagramId: 'd-viejo' };
}

describe('almacén IndexedDB: historial de versiones', () => {
  it('una base de la versión 1 se actualiza sola: nada se pierde y el contenido de antes queda como línea base al guardar', async () => {
    const factory = new IDBFactory();
    const { projectId, diagramId } = await legacyDatabase(factory);
    const store = new IndexedDbProjectStore(factory, 'iark-projects', { versions: { coalesceSeconds: 0 } });
    expect((await store.getDiagram(projectId, diagramId))?.text).toBe('contenido de antes del historial');
    expect(await store.listVersions(projectId, diagramId)).toEqual([]); // sin historial hasta que se guarde
    await store.saveDiagram(projectId, { id: diagramId, text: 'primer guardado nuevo' });
    const versions = await store.listVersions(projectId, diagramId);
    expect(versions.map((v) => v.id)).toEqual([2, 1]);
    expect((await store.getVersion(projectId, diagramId, 1))?.text).toBe('contenido de antes del historial');
    expect((await store.getVersion(projectId, diagramId, 2))?.text).toBe('primer guardado nuevo');
    // y se puede volver al contenido de antes
    await store.restoreVersion(projectId, diagramId, 1);
    expect((await store.getDiagram(projectId, diagramId))?.text).toBe('contenido de antes del historial');
    await store.close();
  });

  it('el historial sobrevive a cerrar y reabrir la base, y dos conexiones (dos pestañas) ven las mismas versiones', async () => {
    const factory = new IDBFactory();
    const tabA = new IndexedDbProjectStore(factory, 'iark-projects', { versions: { coalesceSeconds: 0 } });
    const project = await tabA.createProject({ name: 'Tienda' });
    const diagram = await tabA.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text: 'uno' });
    await tabA.saveDiagram(project.id, { id: diagram.id, text: 'dos' });
    const tabB = new IndexedDbProjectStore(factory, 'iark-projects', { versions: { coalesceSeconds: 0 } });
    await tabB.labelVersion(project.id, diagram.id, 1, 'Inicio');
    expect((await tabA.listVersions(project.id, diagram.id)).map((v) => [v.id, v.label])).toEqual([
      [2, undefined],
      [1, 'Inicio'],
    ]);
    await tabA.saveDiagram(project.id, { id: diagram.id, text: 'tres' }); // los ids siguen sin chocar entre pestañas
    await tabB.saveDiagram(project.id, { id: diagram.id, text: 'cuatro' });
    await tabA.close();
    await tabB.close();
    const again = new IndexedDbProjectStore(factory);
    expect((await again.listVersions(project.id, diagram.id)).map((v) => v.id)).toEqual([4, 3, 2, 1]);
    await again.close();
  });

  it('borrar el proyecto borra su historial entero; no quedan versiones huérfanas ni cuentan en el uso', async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbProjectStore(factory, 'iark-projects', { versions: { coalesceSeconds: 0 } });
    const a = await store.createProject({ name: 'A' });
    const b = await store.createProject({ name: 'B' });
    for (const project of [a, b]) {
      const diagram = await store.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text: 'xx' });
      await store.saveDiagram(project.id, { id: diagram.id, text: 'yyy' });
    }
    expect(await store.versionUsage(a.id)).toEqual({ versions: 2, bytes: 5 });
    await store.deleteProject(a.id);
    expect(await store.versionUsage(b.id)).toEqual({ versions: 2, bytes: 5 });
    const raw = await new Promise<number>((resolve, reject) => {
      const opening = factory.open('iark-projects', 2);
      opening.onsuccess = () => {
        const tx = opening.result.transaction(['versions', 'versionTexts', 'versionState'], 'readonly');
        const counts = ['versions', 'versionTexts', 'versionState'].map((name) => tx.objectStore(name).count());
        tx.oncomplete = () => {
          opening.result.close();
          resolve(counts.reduce((n, c) => n + c.result, 0));
        };
        tx.onerror = () => reject(tx.error);
      };
    });
    expect(raw).toBe(2 + 2 + 1); // solo las del proyecto B: dos versiones, sus dos documentos y el estado de su diagrama
    await store.close();
  });

  it('con el historial desactivado el almacén lo declara, no guarda nada y el resto funciona igual', async () => {
    const store = new IndexedDbProjectStore(new IDBFactory(), 'iark-projects', { versions: false });
    expect(store.keepsVersions).toBe(false);
    const project = await store.createProject({ name: 'Tienda' });
    const diagram = await store.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text: 'a' });
    await store.saveDiagram(project.id, { id: diagram.id, text: 'b' });
    expect((await store.getDiagram(project.id, diagram.id))?.text).toBe('b');
    await expect(store.listVersions(project.id, diagram.id)).rejects.toMatchObject({ code: 'unsupported' });
    await store.close();
  });
});

describe('almacén IndexedDB', () => {
  it('lo guardado sobrevive a cerrar y reabrir la base (persistencia real)', async () => {
    const factory = new IDBFactory();
    const first = new IndexedDbProjectStore(factory);
    const project = await first.createProject({ name: 'Tienda', description: 'Pedidos' });
    const diagram = await first.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text: '{"a":1}' });
    await first.close();

    const second = new IndexedDbProjectStore(factory);
    const [listed] = await second.listProjects();
    expect(listed).toMatchObject({ id: project.id, name: 'Tienda', description: 'Pedidos' });
    expect(listed.diagrams).toEqual([diagram]);
    expect((await second.getDiagram(project.id, diagram.id))?.text).toBe('{"a":1}');
    await second.close();
  });

  it('dos conexiones a la misma base ven los cambios de la otra (dos pestañas)', async () => {
    const factory = new IDBFactory();
    const tabA = new IndexedDbProjectStore(factory);
    const tabB = new IndexedDbProjectStore(factory);
    const project = await tabA.createProject({ name: 'Tienda' });
    await expect(tabB.createProject({ name: 'tienda' })).rejects.toMatchObject({ code: 'exists' });
    const created = await tabB.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text: 'uno' });
    // la pestaña A guarda con la marca que conocía: B ya lo cambió → conflicto, no se pisa
    const fromB = await tabB.saveDiagram(project.id, { id: created.id, text: 'dos', ifUpdatedAt: created.updatedAt });
    await expect(tabA.saveDiagram(project.id, { id: created.id, text: 'tres', ifUpdatedAt: created.updatedAt })).rejects.toMatchObject({ code: 'conflict' });
    expect((await tabA.getDiagram(project.id, created.id))?.text).toBe('dos');
    expect(fromB.updatedAt > created.updatedAt).toBe(true);
    await Promise.all([tabA.close(), tabB.close()]);
  });

  it('una operación que falla a mitad no deja cambios (transacción única)', async () => {
    const store = new IndexedDbProjectStore(new IDBFactory());
    const project = await store.createProject({ name: 'Tienda' });
    await store.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text: 'a' });
    await expect(store.saveDiagram(project.id, { module: 'data', name: 'contexto', text: 'b' })).rejects.toBeInstanceOf(ProjectError);
    expect((await store.getProject(project.id))?.diagrams).toHaveLength(1);
    await store.close();
  });

  it('sin IndexedDB, todo falla con un error claro de almacenamiento no disponible', async () => {
    expect(indexedDbAvailable(null)).toBe(false);
    expect(indexedDbAvailable(new IDBFactory())).toBe(true);
    const store = new IndexedDbProjectStore(null);
    await expect(store.listProjects()).rejects.toMatchObject({ code: 'unavailable' });
    await expect(store.createProject({ name: 'x' })).rejects.toMatchObject({ code: 'unavailable' });
  });
});
