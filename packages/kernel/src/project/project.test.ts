import { describe, expect, it } from 'vitest';
import { projectStoreContract } from '../../../../tests/helpers/projectStoreContract';
import {
  bundleFileName,
  bundleToText,
  createBundle,
  duplicateDiagram,
  findDiagram,
  findProject,
  importBundle,
  MemoryProjectStore,
  parseBundle,
  ProjectError,
  slugify,
  snapshotProject,
  uniqueName,
  uniqueSlug,
} from './index';

projectStoreContract('memoria', async () => ({ store: new MemoryProjectStore() }));

describe('nombres', () => {
  it('uniqueName añade un número hasta encontrar uno libre, sin distinguir mayúsculas', () => {
    expect(uniqueName('Tienda', [])).toBe('Tienda');
    expect(uniqueName('Tienda', ['tienda'])).toBe('Tienda (2)');
    expect(uniqueName('Tienda', ['Tienda', 'Tienda (2)', 'TIENDA (3)'])).toBe('Tienda (4)');
  });

  it('slugify quita tildes y símbolos, y no devuelve vacío', () => {
    expect(slugify('Gestión de pedidos – v2')).toBe('gestion-de-pedidos-v2');
    expect(slugify('  ¡¡¡  ')).toBe('sin-titulo');
    expect(slugify('✓', 'proyecto')).toBe('proyecto');
    expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(60);
    expect(slugify('../../etc/passwd')).toBe('etc-passwd');
  });

  it('uniqueSlug numera los repetidos', () => {
    expect(uniqueSlug('tienda', ['tienda', 'tienda-2'])).toBe('tienda-3');
  });
});

describe('operaciones sobre un almacén', () => {
  it('encuentra proyectos y diagramas por id o por nombre', async () => {
    const store = new MemoryProjectStore();
    const project = await store.createProject({ name: 'Tienda Web' });
    const d = await store.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text: '{}' });
    expect((await findProject(store, 'tienda web')).id).toBe(project.id);
    expect((await findProject(store, project.id)).name).toBe('Tienda Web');
    await expect(findProject(store, 'nada')).rejects.toMatchObject({ code: 'not-found' });
    const summary = (await store.getProject(project.id))!;
    expect(findDiagram(summary, 'CONTEXTO').id).toBe(d.id);
    expect(findDiagram(summary, d.id).name).toBe('Contexto');
    expect(() => findDiagram(summary, 'nada')).toThrow(ProjectError);
  });

  it('duplicar copia el documento con un nombre libre, en el mismo proyecto o en otro', async () => {
    const store = new MemoryProjectStore();
    const a = await store.createProject({ name: 'A' });
    const b = await store.createProject({ name: 'B' });
    const d = await store.saveDiagram(a.id, { module: 'data', name: 'Ventas', text: '{"x":1}' });
    const copy = await duplicateDiagram(store, a.id, d.id);
    const second = await duplicateDiagram(store, a.id, d.id);
    expect([copy.name, second.name]).toEqual(['Ventas (copia)', 'Ventas (copia) (2)']);
    expect((await store.getDiagram(a.id, copy.id))?.text).toBe('{"x":1}');
    const elsewhere = await duplicateDiagram(store, a.id, d.id, { toProjectId: b.id, name: 'Ventas' });
    expect(elsewhere.module).toBe('data');
    expect((await store.getProject(b.id))?.diagrams.map((x) => x.name)).toEqual(['Ventas']);
    await expect(duplicateDiagram(store, a.id, 'nada')).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('archivo único del proyecto', () => {
  const build = async () => {
    const store = new MemoryProjectStore();
    const project = await store.createProject({ name: 'Tienda', description: 'Pedidos y pagos' });
    await store.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text: JSON.stringify({ workspace: { name: 'Tienda' } }) });
    await store.saveDiagram(project.id, { module: 'data', name: 'Borrador', text: '{ "a": ' });
    return { store, snapshot: await snapshotProject(store, project.id) };
  };

  it('exporta los documentos como JSON y deja como texto los que no lo son', async () => {
    const { snapshot } = await build();
    const bundle = createBundle(snapshot, { now: new Date('2026-10-03T00:00:00Z'), generator: 'DIAgrams' });
    expect(bundle).toMatchObject({ format: 'iark.project', version: 1, exportedAt: '2026-10-03T00:00:00.000Z', project: { name: 'Tienda', description: 'Pedidos y pagos' } });
    expect(bundle.diagrams.find((d) => d.name === 'Contexto')).toMatchObject({ module: 'c4', document: { workspace: { name: 'Tienda' } } });
    const draft = bundle.diagrams.find((d) => d.name === 'Borrador')!;
    expect(draft.text).toBe('{ "a": ');
    expect(draft).not.toHaveProperty('document');
  });

  it('exportar e importar conserva el proyecto; importar dos veces no pisa nada', async () => {
    const { store, snapshot } = await build();
    const text = bundleToText(createBundle(snapshot));
    const first = await importBundle(store, parseBundle(text));
    expect(first.renamedFrom).toBe('Tienda');
    expect(first.project.name).toBe('Tienda (2)');
    expect(first.diagrams).toBe(2);
    const copy = await snapshotProject(store, first.project.id);
    expect(copy.description).toBe('Pedidos y pagos');
    expect(copy.diagrams.map((d) => [d.name, d.module])).toEqual([
      ['Borrador', 'data'],
      ['Contexto', 'c4'],
    ]);
    expect(copy.diagrams.find((d) => d.name === 'Borrador')?.text).toBe('{ "a": ');
    expect(JSON.parse(copy.diagrams.find((d) => d.name === 'Contexto')!.text)).toEqual({ workspace: { name: 'Tienda' } });
    // a un almacén vacío llega con su nombre original
    const fresh = new MemoryProjectStore();
    const imported = await importBundle(fresh, parseBundle(text));
    expect(imported.renamedFrom).toBeUndefined();
    expect(imported.project.name).toBe('Tienda');
    expect((await importBundle(fresh, parseBundle(text), { name: 'Otra' })).project.name).toBe('Otra');
  });

  it('un nombre de diagrama repetido dentro del archivo se desambigua en lugar de fallar', async () => {
    const store = new MemoryProjectStore();
    const bundle = parseBundle(
      JSON.stringify({
        format: 'iark.project',
        version: 1,
        project: { name: 'P' },
        diagrams: [
          { id: 'a', module: 'c4', name: 'Uno', document: {} },
          { id: 'b', module: 'c4', name: 'uno', document: {} },
        ],
      }),
    );
    const { project } = await importBundle(store, bundle);
    expect(project.diagrams.map((d) => d.name)).toEqual(['Uno', 'uno (2)']);
  });

  it('si un diagrama no se puede guardar, el proyecto a medio crear se deshace', async () => {
    const store = new MemoryProjectStore();
    const original = store.saveDiagram.bind(store);
    let calls = 0;
    store.saveDiagram = async (projectId, input) => {
      if (++calls === 2) throw new ProjectError('unavailable', 'disco lleno');
      return original(projectId, input);
    };
    const bundle = parseBundle(
      JSON.stringify({
        format: 'iark.project',
        version: 1,
        project: { name: 'P' },
        diagrams: [
          { id: 'a', module: 'c4', name: 'Uno', document: {} },
          { id: 'b', module: 'c4', name: 'Dos', document: {} },
        ],
      }),
    );
    await expect(importBundle(store, bundle)).rejects.toThrow('disco lleno');
    expect(await store.listProjects()).toEqual([]);
  });

  it('rechaza archivos que no son un proyecto, con el motivo', () => {
    const base = { format: 'iark.project', version: 1, project: { name: 'P' }, diagrams: [] };
    expect(() => parseBundle('no es json')).toThrow(/JSON válido/);
    expect(() => parseBundle(JSON.stringify({ workspace: { name: 'x' } }))).toThrow(/No es un proyecto de DIAgrams/);
    expect(() => parseBundle(JSON.stringify({ ...base, version: 2 }))).toThrow(/versión más nueva/);
    expect(() => parseBundle(JSON.stringify({ ...base, project: {} }))).toThrow(/project\.name/);
    expect(() => parseBundle(JSON.stringify({ ...base, diagrams: [{ id: 'a', module: 'Mal Módulo', name: 'x', document: {} }] }))).toThrow(/módulo inválido/);
    expect(() => parseBundle(JSON.stringify({ ...base, diagrams: [{ id: 'a', module: 'c4', name: 'x' }] }))).toThrow(/ni "document" ni "text"/);
    expect(() =>
      parseBundle(
        JSON.stringify({
          ...base,
          diagrams: [
            { id: 'a', module: 'c4', name: 'x', document: {} },
            { id: 'a', module: 'c4', name: 'y', document: {} },
          ],
        }),
      ),
    ).toThrow(/repite el id/);
    expect(() => parseBundle(JSON.stringify({ ...base, diagrams: Array.from({ length: 501 }, (_, i) => ({ id: `d${i}`, module: 'c4', name: `n${i}`, document: {} })) }))).toThrow(/más de 500/);
    expect(() => parseBundle(JSON.stringify(base))).not.toThrow();
  });

  it('el nombre de archivo sugerido es seguro', () => {
    expect(bundleFileName('Tienda Web / Pagos')).toBe('tienda-web-pagos.iark-project.json');
    expect(bundleFileName('✓')).toBe('proyecto.iark-project.json');
  });
});
