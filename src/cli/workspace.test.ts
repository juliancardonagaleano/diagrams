import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkProject, createBundle, describeContent, importBundle, ProjectError, snapshotProject, type ModuleLookup } from '@iark/kernel';
import { projectStoreContract } from '../../tests/helpers/projectStoreContract';
import { projectVersionsContract } from '../../tests/helpers/projectVersionsContract';
import { FolderProjectStore, HISTORY_FORMAT, isWorkspaceId, MAX_DOCUMENT_BYTES, SIDECAR_FORMAT, VERSIONS_DIR, versionPolicyFromEnv } from './workspace';

const made: string[] = [];
/** Una carpeta temporal nueva; se borra al terminar cada prueba. */
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iark-ws-'));
  made.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Un espacio de trabajo dentro de una carpeta temporal (la raíz es un hijo: lo de fuera del espacio se ve en el padre). */
function workspace(): { outside: string; root: string; store: FolderProjectStore } {
  const outside = tmp();
  const root = join(outside, 'espacio');
  mkdirSync(root);
  return { outside, root, store: new FolderProjectStore(root) };
}

const rejects = async (promise: Promise<unknown>, code: string): Promise<ProjectError> => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ProjectError);
  expect((error as ProjectError).code).toBe(code);
  return error as ProjectError;
};

/** Lo que hay en un directorio de proyecto SIN el historial (`.versiones`, que tiene sus propias pruebas): el formato de siempre. */
const listing = (dir: string): string[] => readdirSync(dir).filter((name) => name !== VERSIONS_DIR).sort();

const symlinkOrSkip = (target: string, path: string): boolean => {
  try {
    symlinkSync(target, path);
    return true;
  } catch {
    return false; // sin permiso para crear enlaces (Windows sin modo desarrollador)
  }
};

projectStoreContract('carpeta', async () => {
  const dir = tmp();
  return { store: new FolderProjectStore(join(dir, 'espacio')), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
});

projectVersionsContract('carpeta', async ({ policy, clock }) => {
  const dir = tmp();
  return { store: new FolderProjectStore(join(dir, 'espacio'), { versions: policy, clock: () => clock.now() }), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
});

describe('FolderProjectStore: disposición en disco', () => {
  it('crea un directorio con project.json por proyecto y un <id>.<módulo>.json por diagrama, sin dejar temporales', async () => {
    const { root, store } = workspace();
    const project = await store.createProject({ name: 'Tienda web', description: 'Pedidos y pagos' });
    expect(project.id).toBe('tienda-web');
    const text = JSON.stringify({ hola: 'mundo' }, null, 2);
    const diagram = await store.saveDiagram(project.id, { module: 'security', name: 'Amenazas de «Tienda»', text });
    expect(diagram.id).toBe('amenazas-de-tienda');

    expect(readdirSync(root)).toEqual(['tienda-web']);
    expect(listing(join(root, 'tienda-web'))).toEqual(['amenazas-de-tienda.security.json', 'project.json']);
    // el documento es el texto, byte a byte
    expect(readFileSync(join(root, 'tienda-web', 'amenazas-de-tienda.security.json'), 'utf8')).toBe(text);
    const sidecar = JSON.parse(readFileSync(join(root, 'tienda-web', 'project.json'), 'utf8'));
    expect(sidecar).toMatchObject({
      format: SIDECAR_FORMAT,
      name: 'Tienda web',
      description: 'Pedidos y pagos',
      diagrams: { 'amenazas-de-tienda': { name: 'Amenazas de «Tienda»' } },
    });
    expect(sidecar.diagrams['amenazas-de-tienda'].createdAt).toBe(diagram.createdAt);
    expect(Object.keys(sidecar)).toEqual(['format', 'name', 'description', 'createdAt', 'diagrams']);
  });

  it('el id sale del nombre sin tildes y se numera si está tomado; renombrar no mueve nada', async () => {
    const { root, store } = workspace();
    const a = await store.createProject({ name: 'Gestión Ñandú' });
    const b = await store.createProject({ name: 'Gestion nandu!' }); // otro nombre, mismo slug
    expect([a.id, b.id]).toEqual(['gestion-nandu', 'gestion-nandu-2']);
    const renamed = await store.renameProject(a.id, 'Otro nombre');
    expect(renamed).toMatchObject({ id: 'gestion-nandu', name: 'Otro nombre' });
    expect(readdirSync(root).sort()).toEqual(['gestion-nandu', 'gestion-nandu-2']);

    const d = await store.saveDiagram(a.id, { module: 'c4', name: 'Contexto', text: '{}' });
    const d2 = await store.renameDiagram(a.id, d.id, 'Visión general');
    expect(d2).toMatchObject({ id: 'contexto', name: 'Visión general', updatedAt: d.updatedAt });
    expect(listing(join(root, a.id))).toEqual(['contexto.c4.json', 'project.json']);
    // los nombres se comparan sin distinguir mayúsculas ni tildes de normalización, y entre ids distintos
    await rejects(store.createProject({ name: 'OTRO NOMBRE' }), 'exists');
    const c = await store.saveDiagram(a.id, { module: 'data', name: 'Contexto', text: '{}' }); // el nombre `Contexto` quedó libre
    expect(c.id).toBe('contexto-2');
    expect((await store.getProject(a.id))!.diagrams.map((x) => x.name)).toEqual(['Contexto', 'Visión general']);
  });

  it('dos módulos para el mismo nombre no pisan el archivo del otro (el id no incluye el módulo)', async () => {
    const { root, store } = workspace();
    const p = await store.createProject({ name: 'P' });
    await store.saveDiagram(p.id, { module: 'c4', name: 'Mapa', text: 'uno' });
    await store.renameDiagram(p.id, 'mapa', 'Mapa viejo');
    const second = await store.saveDiagram(p.id, { module: 'data', name: 'Mapa', text: 'dos' });
    expect(second.id).toBe('mapa-2');
    expect(listing(join(root, p.id))).toEqual(['mapa-2.data.json', 'mapa.c4.json', 'project.json']);
  });

  it('no usa nombres que Windows reserva', async () => {
    const { root, store } = workspace();
    const p = await store.createProject({ name: 'con' });
    expect(p.id).toBe('con-2');
    const d = await store.saveDiagram(p.id, { module: 'c4', name: 'NUL', text: '{}' });
    expect(d.id).toBe('nul-2');
    expect(readdirSync(root)).toEqual(['con-2']);
  });

  it('las fechas: createdAt se conserva y updatedAt crece con cada guardado (aunque sea en el mismo milisegundo)', async () => {
    const { store } = workspace();
    const p = await store.createProject({ name: 'P' });
    const d = await store.saveDiagram(p.id, { module: 'c4', name: 'D', text: 'a' });
    let previous = d.updatedAt;
    for (const text of ['b', 'c', 'd', 'e']) {
      const next = await store.saveDiagram(p.id, { id: d.id, text });
      expect(next.updatedAt > previous).toBe(true);
      expect(next.createdAt).toBe(d.createdAt);
      previous = next.updatedAt;
    }
    const read = (await store.getDiagram(p.id, d.id))!;
    expect(read.updatedAt).toBe(previous);
    expect((await store.getProject(p.id))!.diagrams[0].updatedAt).toBe(previous);
    expect((await store.getProject(p.id))!.updatedAt >= previous).toBe(true);
  });

  it('listProjects en una raíz que no existe devuelve [] y createProject la crea', async () => {
    const dir = tmp();
    const store = new FolderProjectStore(join(dir, 'a', 'b', 'espacio'));
    expect(await store.listProjects()).toEqual([]);
    expect(await store.getProject('x')).toBeUndefined();
    await store.createProject({ name: 'Uno' });
    expect(readdirSync(join(dir, 'a', 'b', 'espacio'))).toEqual(['uno']);
  });

  it('si la raíz es un archivo, falla como `unavailable`', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'archivo'), 'x');
    const store = new FolderProjectStore(join(dir, 'archivo'));
    await rejects(store.listProjects(), 'unavailable');
    await rejects(store.createProject({ name: 'X' }), 'unavailable');
  });

  it('la descripción es opcional, se recorta y no puede ser enorme ni algo que no sea texto', async () => {
    const { store } = workspace();
    expect((await store.createProject({ name: 'A', description: '   ' })).description).toBeUndefined();
    expect((await store.createProject({ name: 'B', description: '  Pedidos  ' })).description).toBe('Pedidos');
    await rejects(store.createProject({ name: 'C', description: 'x'.repeat(5000) }), 'invalid');
    await rejects(store.createProject({ name: 'D', description: 42 as unknown as string }), 'invalid');
    expect((await store.listProjects()).map((p) => p.name)).toEqual(['A', 'B']);
  });

  it('rechaza documentos que pasan del tamaño máximo', async () => {
    const { store } = workspace();
    const p = await store.createProject({ name: 'P' });
    await rejects(store.saveDiagram(p.id, { module: 'c4', name: 'Enorme', text: 'x'.repeat(MAX_DOCUMENT_BYTES + 1) }), 'invalid');
    expect((await store.getProject(p.id))!.diagrams).toEqual([]);
  });
});

describe('FolderProjectStore: la carpeta es la fuente de verdad', () => {
  it('detecta proyectos y diagramas copiados a mano, aunque no estén en el sidecar', async () => {
    const { root, store } = workspace();
    mkdirSync(join(root, 'banca'));
    writeFileSync(join(root, 'banca', 'contexto.c4.json'), '{"a":1}');
    writeFileSync(join(root, 'banca', 'Ventas.v2.data.json'), '{"b":2}');
    const when = new Date('2025-03-04T05:06:07.123Z');
    utimesSync(join(root, 'banca', 'contexto.c4.json'), when, when);

    const [project] = await store.listProjects();
    expect(project).toMatchObject({ id: 'banca', name: 'banca' });
    expect(project.description).toBeUndefined();
    const [contexto, ventas] = project.diagrams;
    expect(ventas).toMatchObject({ id: 'Ventas.v2', module: 'data', name: 'Ventas.v2' });
    expect(contexto).toMatchObject({ id: 'contexto', module: 'c4', name: 'contexto', createdAt: '2025-03-04T05:06:07.123Z', updatedAt: '2025-03-04T05:06:07.123Z' });
    expect((await store.getDiagram('banca', 'contexto'))?.text).toBe('{"a":1}');
    expect(await store.getDiagram('banca', 'Ventas.v2')).toMatchObject({ module: 'data', text: '{"b":2}' });

    // se pueden renombrar y actualizar como cualquier otro; el sidecar se crea al escribir
    const updated = await store.saveDiagram('banca', { id: 'contexto', text: '{"a":2}' });
    expect(updated.createdAt).toBe('2025-03-04T05:06:07.123Z'); // la creación no sigue a la modificación
    expect(updated.updatedAt > '2025-03-04T05:06:07.123Z').toBe(true);
    await store.renameProject('banca', 'Banca móvil');
    await store.renameDiagram('banca', 'contexto', 'Contexto general');
    const after = (await store.getProject('banca'))!;
    expect(after.name).toBe('Banca móvil');
    expect(after.diagrams.map((d) => d.name)).toEqual(['Contexto general', 'Ventas.v2']);
    expect(listing(join(root, 'banca'))).toEqual(['Ventas.v2.data.json', 'contexto.c4.json', 'project.json']);
  });

  it('un archivo borrado a mano desaparece de la lista y su entrada del sidecar se poda al escribir', async () => {
    const { root, store } = workspace();
    const p = await store.createProject({ name: 'P' });
    await store.saveDiagram(p.id, { module: 'c4', name: 'Uno', text: '1' });
    await store.saveDiagram(p.id, { module: 'c4', name: 'Dos', text: '2' });
    rmSync(join(root, p.id, 'uno.c4.json'));
    expect((await store.getProject(p.id))!.diagrams.map((d) => d.name)).toEqual(['Dos']);
    await store.saveDiagram(p.id, { module: 'c4', name: 'Tres', text: '3' });
    expect(Object.keys(JSON.parse(readFileSync(join(root, p.id, 'project.json'), 'utf8')).diagrams).sort()).toEqual(['dos', 'tres']);
    // y un nombre que quedó libre se puede volver a usar
    expect((await store.saveDiagram(p.id, { module: 'c4', name: 'Uno', text: '1b' })).id).toBe('uno');
  });

  it('ignora sin fallar lo que no encaja: otros archivos, ocultos, node_modules, ids o módulos inválidos, directorios con nombre de diagrama', async () => {
    const { root, store } = workspace();
    mkdirSync(join(root, 'p'));
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, '.algo'));
    mkdirSync(join(root, 'node_modules'));
    mkdirSync(join(root, 'con sustancia')); // un nombre que no es un id válido
    mkdirSync(join(root, 'aux')); // reservado en Windows
    writeFileSync(join(root, 'suelto.c4.json'), '{}'); // un archivo en la raíz no es un proyecto
    writeFileSync(join(root, '.git', 'x.c4.json'), '{}');
    for (const name of [
      'ok.c4.json',
      'sin-modulo.json',
      'notas.txt',
      'otro.c4.json.bak',
      '.oculto.c4.json',
      'MAYUS.C4.json', // el módulo va en minúsculas
      'con espacio.c4.json',
      'acentuación.c4.json',
      '1.2.json',
      'proyecto.iark-project.json', // el archivo único de un proyecto exportado a su carpeta no es un diagrama
      '.ok.c4.json.123.tmp',
    ]) {
      writeFileSync(join(root, 'p', name), '{}');
    }
    mkdirSync(join(root, 'p', 'directorio.c4.json')); // un directorio con forma de diagrama
    mkdirSync(join(root, 'p', 'subcarpeta'));
    writeFileSync(join(root, 'p', 'subcarpeta', 'hondo.c4.json'), '{}'); // no se baja a subcarpetas

    const projects = await store.listProjects();
    expect(projects.map((x) => x.id)).toEqual(['p']);
    expect(projects[0].diagrams.map((d) => d.id)).toEqual(['ok']);
    expect(await store.getProject('.git')).toBeUndefined();
    expect(await store.getProject('node_modules')).toBeUndefined();
    expect(await store.getProject('suelto.c4.json')).toBeUndefined();
    expect(await store.getDiagram('p', 'directorio')).toBeUndefined();
    // crear con un nombre que choca con una entrada ignorada no la toca
    expect((await store.saveDiagram('p', { module: 'c4', name: 'directorio', text: 'x' })).id).toBe('directorio-2');
    expect(statSync(join(root, 'p', 'directorio.c4.json')).isDirectory()).toBe(true);
  });

  it('con dos archivos del mismo id y distinto módulo se usa el primero por orden alfabético, sin fallar', async () => {
    const { root, store } = workspace();
    mkdirSync(join(root, 'p'));
    writeFileSync(join(root, 'p', 'x.data.json'), '{"d":1}');
    writeFileSync(join(root, 'p', 'x.c4.json'), '{"c":1}');
    const project = (await store.getProject('p'))!;
    expect(project.diagrams).toHaveLength(1);
    expect(project.diagrams[0]).toMatchObject({ id: 'x', module: 'c4' });
    // un diagrama nuevo llamado `x` no choca con ninguno de los dos
    expect((await store.saveDiagram('p', { module: 'c4', name: 'Otro', text: '{}' })).id).toBe('otro');
    expect((await store.getProject('p'))!.diagrams.map((d) => d.id).sort()).toEqual(['otro', 'x']);
  });

  it('un sidecar corrupto, de otro formato o con campos raros se ignora con tolerancia', async () => {
    const { root, store } = workspace();
    mkdirSync(join(root, 'a'));
    mkdirSync(join(root, 'b'));
    mkdirSync(join(root, 'c'));
    mkdirSync(join(root, 'd'));
    for (const id of ['a', 'b', 'c', 'd']) writeFileSync(join(root, id, 'x.c4.json'), '{}');
    writeFileSync(join(root, 'a', 'project.json'), '{ esto no es json');
    writeFileSync(join(root, 'b', 'project.json'), JSON.stringify({ format: 'otra/9', name: 'Nombre ajeno' }));
    writeFileSync(join(root, 'c', 'project.json'), JSON.stringify({ format: SIDECAR_FORMAT, name: 42, description: {}, createdAt: 'ayer', diagrams: { x: 'no', '../y': { name: 'Y' }, z: { name: ['a'] } } }));
    writeFileSync(join(root, 'd', 'project.json'), JSON.stringify({ format: SIDECAR_FORMAT, name: 'Bueno', diagrams: { x: { name: 'Equis', createdAt: '2024-01-02T03:04:05.000Z' } } }));
    const projects = await store.listProjects();
    expect(projects.map((p) => [p.id, p.name])).toEqual([
      ['a', 'a'],
      ['b', 'b'],
      ['d', 'Bueno'],
      ['c', 'c'],
    ].sort((x, y) => x[1].localeCompare(y[1])));
    expect(projects.every((p) => p.diagrams.length === 1)).toBe(true);
    expect((await store.getProject('c'))!.diagrams[0].name).toBe('x');
    expect((await store.getProject('d'))!.diagrams[0]).toMatchObject({ name: 'Equis', createdAt: '2024-01-02T03:04:05.000Z' });
    // al escribir en uno con el sidecar roto se reconstruye uno válido
    await store.renameProject('a', 'Reparado');
    expect(JSON.parse(readFileSync(join(root, 'a', 'project.json'), 'utf8'))).toMatchObject({ format: SIDECAR_FORMAT, name: 'Reparado' });
    expect((await store.getProject('a'))!.diagrams.map((d) => d.id)).toEqual(['x']);
  });

  it('un sidecar que es un directorio o un enlace no rompe el listado', async () => {
    const { outside, root, store } = workspace();
    mkdirSync(join(root, 'p'));
    mkdirSync(join(root, 'p', 'project.json'));
    writeFileSync(join(root, 'p', 'x.c4.json'), '{}');
    writeFileSync(join(outside, 'ajeno.json'), JSON.stringify({ format: SIDECAR_FORMAT, name: 'Ajeno' }));
    mkdirSync(join(root, 'q'));
    if (symlinkOrSkip(join(outside, 'ajeno.json'), join(root, 'q', 'project.json'))) {
      expect((await store.getProject('q'))!.name).toBe('q'); // no se lee el sidecar a través de un enlace
    }
    expect((await store.getProject('p'))!.diagrams.map((d) => d.id)).toEqual(['x']);
  });
});

describe('FolderProjectStore: seguridad', () => {
  it('los enlaces simbólicos que salen de la raíz se ignoran (proyectos, archivos y el sidecar) y no se siguen al crear ni al borrar', async () => {
    const { outside, root, store } = workspace();
    mkdirSync(join(outside, 'ajeno'));
    writeFileSync(join(outside, 'ajeno', 'secreto.c4.json'), '{"secreto":true}');
    writeFileSync(join(outside, 'secreto.txt'), 'no debe verse ni tocarse');
    if (!symlinkOrSkip(join(outside, 'ajeno'), join(root, 'enlace'))) return;
    // un proyecto de verdad con un enlace a un archivo de fuera con forma de diagrama, y otro a un directorio
    mkdirSync(join(root, 'p'));
    writeFileSync(join(root, 'p', 'bueno.c4.json'), '{}');
    symlinkSync(join(outside, 'secreto.txt'), join(root, 'p', 'espejo.c4.json'));
    symlinkSync(join(outside, 'ajeno'), join(root, 'p', 'carpeta.c4.json'));
    symlinkSync(join(outside, 'ajeno', 'secreto.c4.json'), join(root, 'p', 'secreto.c4.json'));

    expect((await store.listProjects()).map((p) => p.id)).toEqual(['p']);
    expect(await store.getProject('enlace')).toBeUndefined();
    await rejects(store.getDiagram('enlace', 'secreto'), 'not-found');
    await rejects(store.saveDiagram('enlace', { module: 'c4', name: 'X', text: '{}' }), 'not-found');
    await rejects(store.deleteProject('enlace'), 'not-found');
    expect((await store.getProject('p'))!.diagrams.map((d) => d.id)).toEqual(['bueno']);
    expect(await store.getDiagram('p', 'espejo')).toBeUndefined();
    expect(await store.getDiagram('p', 'secreto')).toBeUndefined();
    await rejects(store.saveDiagram('p', { id: 'espejo', text: 'pisado' }), 'not-found');

    // crear con un nombre que ya ocupa un enlace elige otro id y no escribe a través del enlace
    const created = await store.createProject({ name: 'Enlace' });
    expect(created.id).toBe('enlace-2');
    const diagram = await store.saveDiagram('p', { module: 'c4', name: 'Espejo', text: 'nuevo' });
    expect(diagram.id).toBe('espejo-2');
    expect(readFileSync(join(outside, 'secreto.txt'), 'utf8')).toBe('no debe verse ni tocarse');
    expect(readdirSync(join(outside, 'ajeno'))).toEqual(['secreto.c4.json']);

    // borrar un proyecto que contiene enlaces quita los enlaces, no lo que hay al otro lado
    await store.deleteProject('p');
    expect(readFileSync(join(outside, 'secreto.txt'), 'utf8')).toBe('no debe verse ni tocarse');
    expect(readdirSync(join(outside, 'ajeno'))).toEqual(['secreto.c4.json']);
  });

  it('un enlace dentro de la raíz tampoco cuenta como proyecto (no se listaría dos veces)', async () => {
    const { root, store } = workspace();
    await store.createProject({ name: 'Real' });
    if (!symlinkOrSkip(join(root, 'real'), join(root, 'alias'))) return;
    expect((await store.listProjects()).map((p) => p.id)).toEqual(['real']);
    expect(await store.getProject('alias')).toBeUndefined();
  });

  it('la raíz puede ser un enlace (es una decisión de quien configura el espacio de trabajo)', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'real'));
    if (!symlinkOrSkip(join(dir, 'real'), join(dir, 'espacio'))) return;
    const store = new FolderProjectStore(join(dir, 'espacio'));
    await store.createProject({ name: 'Uno' });
    expect(readdirSync(join(dir, 'real'))).toEqual(['uno']);
    expect((await store.listProjects()).map((p) => p.id)).toEqual(['uno']);
  });

  const malicious = ['..', '../x', '../../etc/passwd', '..\\x', '/etc', '/', 'a/b', 'a\\b', '.', '.hidden', 'x..y', 'a.', ' a', 'a b', '', 'a\0b', 'con', 'NUL', 'com1.txt', '%2e%2e', 'é', 'a'.repeat(101)];

  it('isWorkspaceId solo admite un segmento de ruta sencillo', async () => {
    for (const id of malicious) expect(isWorkspaceId(id), JSON.stringify(id)).toBe(false);
    for (const id of ['tienda', 'Tienda_2', 'a', 'x.v2', 'a-b.c_d', 'node_modules', '1.2', 'a'.repeat(100)]) expect(isWorkspaceId(id), id).toBe(true);
    for (const value of [undefined, null, 4, {}, []]) expect(isWorkspaceId(value)).toBe(false);
    // `node_modules` puede ser un diagrama, pero nunca un proyecto
    await rejects(new FolderProjectStore(tmp()).deleteProject('node_modules'), 'invalid');
  });

  it('ningún id que llegue de fuera sale de la raíz: ni para leer, ni para escribir, ni para borrar', async () => {
    const { outside, root, store } = workspace();
    const project = await store.createProject({ name: 'P' });
    await store.saveDiagram(project.id, { module: 'c4', name: 'D', text: '{}' });
    writeFileSync(join(outside, 'x.c4.json'), 'fuera');
    mkdirSync(join(outside, 'otro'));
    const snapshot = () => JSON.stringify([readdirSync(outside).sort(), readdirSync(root).sort(), readdirSync(join(root, 'p')).sort()]);
    const before = snapshot();

    for (const id of malicious) {
      expect(await store.getProject(id), `getProject ${JSON.stringify(id)}`).toBeUndefined();
      await rejects(store.getDiagram(id, 'd'), 'not-found');
      expect(await store.getDiagram('p', id), `getDiagram ${JSON.stringify(id)}`).toBeUndefined();
      await rejects(store.renameProject(id, 'Otro'), 'invalid');
      await rejects(store.deleteProject(id), 'invalid');
      await rejects(store.saveDiagram(id, { module: 'c4', name: 'X', text: '{}' }), 'invalid');
      await rejects(store.saveDiagram('p', { id, text: 'x' }), 'invalid');
      await rejects(store.renameDiagram('p', id, 'X'), 'invalid');
      await rejects(store.deleteDiagram('p', id), 'invalid');
    }
    // un módulo con separadores tampoco forma un archivo fuera de sitio
    for (const module of ['../x', 'a/b', '..', 'C4', 'x.y', '']) await rejects(store.saveDiagram('p', { module, name: 'M', text: '{}' }), 'invalid');
    expect(snapshot()).toBe(before);
    expect(readFileSync(join(outside, 'x.c4.json'), 'utf8')).toBe('fuera');
  });

  it('los nombres con `..` o separadores dan ids dentro de la raíz', async () => {
    const { outside, root, store } = workspace();
    const a = await store.createProject({ name: '../../etc/passwd' });
    const b = await store.createProject({ name: '..\\..\\windows' });
    const c = await store.createProject({ name: '/' }); // solo símbolos: id de reserva
    expect([a.id, b.id, c.id]).toEqual(['etc-passwd', 'windows', 'proyecto']);
    const d = await store.saveDiagram(a.id, { module: 'c4', name: '../../../x', text: '{}' });
    expect(d.id).toBe('x');
    expect(readdirSync(root).sort()).toEqual(['etc-passwd', 'proyecto', 'windows']);
    expect(readdirSync(outside)).toEqual(['espacio']);
  });
});

describe('FolderProjectStore: concurrencia', () => {
  it('muchos guardados a la vez en el mismo almacén no se pisan: ids distintos, archivos completos', async () => {
    const { root, store } = workspace();
    const p = await store.createProject({ name: 'P' });
    const names = Array.from({ length: 25 }, (_, i) => (i % 2 ? `a b ${i}` : `a-b ${i}`)); // slugs repetidos entre nombres distintos
    const metas = await Promise.all(names.map((name, i) => store.saveDiagram(p.id, { module: 'c4', name, text: JSON.stringify({ i }) })));
    expect(new Set(metas.map((m) => m.id)).size).toBe(25);
    const files = readdirSync(join(root, p.id)).filter((f) => f.endsWith('.c4.json'));
    expect(files).toHaveLength(25);
    for (const [i, meta] of metas.entries()) expect((await store.getDiagram(p.id, meta.id))?.text).toBe(JSON.stringify({ i }));
    expect(readdirSync(join(root, p.id)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect((await store.getProject(p.id))!.diagrams).toHaveLength(25);
  });

  it('el mismo nombre a la vez: uno se crea y los demás fallan con `exists`', async () => {
    const { store } = workspace();
    const p = await store.createProject({ name: 'P' });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => store.saveDiagram(p.id, { module: 'c4', name: 'Igual', text: '{}' })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect((r.reason as ProjectError).code).toBe('exists');
  });

  it('con `ifUpdatedAt`, de varias actualizaciones simultáneas sobre la misma versión solo gana una', async () => {
    const { store } = workspace();
    const p = await store.createProject({ name: 'P' });
    const d = await store.saveDiagram(p.id, { module: 'c4', name: 'D', text: 'v0' });
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map((i) => store.saveDiagram(p.id, { id: d.id, text: `v${i}`, ifUpdatedAt: d.updatedAt })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect((r.reason as ProjectError).code).toBe('conflict');
  });

  it('dos almacenes sobre la misma carpeta (dos procesos) que crean el mismo id a la vez no se pisan', async () => {
    const { root, store } = workspace();
    const other = new FolderProjectStore(root);
    const p = await store.createProject({ name: 'P' });
    for (let round = 0; round < 10; round++) {
      const [a, b] = await Promise.all([
        store.saveDiagram(p.id, { module: 'c4', name: `a b ${round}`, text: 'del primero' }),
        other.saveDiagram(p.id, { module: 'c4', name: `a-b ${round}`, text: 'del segundo' }),
      ]);
      expect(a.id).not.toBe(b.id);
      expect((await store.getDiagram(p.id, a.id))?.text).toBe('del primero');
      expect((await store.getDiagram(p.id, b.id))?.text).toBe('del segundo');
    }
    expect((await store.getProject(p.id))!.diagrams).toHaveLength(20);
  });

  it('dos proyectos con el mismo nombre a la vez: uno solo', async () => {
    const { root, store } = workspace();
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => store.createProject({ name: 'Tienda' })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(readdirSync(root)).toEqual(['tienda']);
  });
});

describe('FolderProjectStore: historial de versiones en disco', () => {
  const NOW = Date.now();
  const clockAt = (offsetSeconds = 0) => () => new Date(NOW + offsetSeconds * 1000);
  const historyOf = (root: string, project: string, diagram: string): string => join(root, project, VERSIONS_DIR, diagram);
  const readIndex = (root: string, project: string, diagram: string) => JSON.parse(readFileSync(join(historyOf(root, project, diagram), 'index.json'), 'utf8'));

  it('el historial es un directorio oculto dentro del proyecto: un índice y un documento por versión, y nada más cambia en la carpeta', async () => {
    const { root, store } = workspace();
    const p = await store.createProject({ name: 'Tienda' });
    const d = await store.saveDiagram(p.id, { module: 'c4', name: 'Contexto', text: '{"v":1}' });
    await store.saveDiagram(p.id, { id: d.id, text: '{"v":2}' });
    expect(readdirSync(join(root, p.id)).sort()).toEqual([VERSIONS_DIR, 'contexto.c4.json', 'project.json']);
    // con la política por omisión, el segundo guardado (justo después, de la misma persona) sustituyó a la versión 1: queda la 2
    expect(readdirSync(historyOf(root, p.id, d.id)).sort()).toEqual(['000002.json', 'index.json']);
  });

  it('con la ventana en 0 cada guardado deja su documento tal cual y el índice dice quién, cuándo, cuánto pesa y su hash', async () => {
    const { root } = workspace();
    const store = new FolderProjectStore(root, { versions: { coalesceSeconds: 0 }, clock: clockAt() });
    const p = await store.createProject({ name: 'Tienda' });
    const d = await store.saveDiagram(p.id, { module: 'c4', name: 'Contexto', text: '{"v":1}', by: '@ana' });
    await store.saveDiagram(p.id, { id: d.id, text: '{ "v": 2 }\n', by: 'Token de CI' });
    const dir = historyOf(root, p.id, d.id);
    expect(readdirSync(dir).sort()).toEqual(['000001.json', '000002.json', 'index.json']);
    expect(readFileSync(join(dir, '000001.json'), 'utf8')).toBe('{"v":1}');
    expect(readFileSync(join(dir, '000002.json'), 'utf8')).toBe('{ "v": 2 }\n');
    const index = readIndex(root, p.id, d.id);
    expect(index).toMatchObject({ format: HISTORY_FORMAT, lastId: 2 });
    expect(Object.keys(index)).toEqual(['format', 'lastId', 'head', 'versions']);
    expect(index.versions).toEqual([
      { id: 1, savedAt: expect.any(String), savedBy: '@ana', ...describeContent('{"v":1}') },
      { id: 2, savedAt: expect.any(String), savedBy: 'Token de CI', ...describeContent('{ "v": 2 }\n') },
    ]);
    expect(index.head).toBe(describeContent('{ "v": 2 }\n').hash);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]); // escrituras atómicas: ningún temporal
    // el sidecar y el documento son los de siempre
    expect(readFileSync(join(root, p.id, 'contexto.c4.json'), 'utf8')).toBe('{ "v": 2 }\n');
    expect(Object.keys(JSON.parse(readFileSync(join(root, p.id, 'project.json'), 'utf8')))).toEqual(['format', 'name', 'createdAt', 'diagrams']);
  });

  it('con el historial desactivado la carpeta queda exactamente como antes de existir esta función', async () => {
    const { root } = workspace();
    const store = new FolderProjectStore(root, { versions: false });
    expect(store.keepsVersions).toBe(false);
    const p = await store.createProject({ name: 'Tienda' });
    const d = await store.saveDiagram(p.id, { module: 'c4', name: 'Contexto', text: 'a' });
    await store.saveDiagram(p.id, { id: d.id, text: 'b' });
    expect(readdirSync(join(root, p.id)).sort()).toEqual(['contexto.c4.json', 'project.json']);
    await expect(store.listVersions(p.id, d.id)).rejects.toMatchObject({ code: 'unsupported' });
    await expect(store.versionUsage(p.id)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('el archivo único del proyecto no lleva el historial, importar crea versiones nuevas y la comprobación del proyecto no lo nota', async () => {
    const { root, store } = workspace();
    const p = await store.createProject({ name: 'Tienda' });
    const d = await store.saveDiagram(p.id, { module: 'c4', name: 'Contexto', text: '{"v":1}' });
    await store.saveDiagram(p.id, { id: d.id, text: '{"v":2}' });
    const snapshot = await snapshotProject(store, p.id);
    expect(snapshot.diagrams).toHaveLength(1); // el directorio oculto no es un diagrama
    const bundle = createBundle(snapshot);
    expect(JSON.stringify(bundle)).not.toMatch(/savedAt|hash|versiones/);
    expect(Object.keys(bundle).sort()).toEqual(['diagrams', 'exportedAt', 'format', 'project', 'version']);
    const modules: ModuleLookup = { get: () => undefined };
    expect(checkProject(snapshot, modules).diagrams.map((x) => x.id)).toEqual(['contexto']);
    const elsewhere = workspace();
    const imported = await importBundle(elsewhere.store, bundle);
    const copy = (await elsewhere.store.getProject(imported.project.id))!.diagrams[0];
    expect((await elsewhere.store.listVersions(imported.project.id, copy.id)).map((v) => v.id)).toEqual([1]);
    expect(existsSync(join(root, p.id, VERSIONS_DIR))).toBe(true);
  });

  it('un diagrama anterior al historial, o editado a mano, conserva su contenido como versión antes de sobrescribirlo', async () => {
    const { root } = workspace();
    const store = new FolderProjectStore(root, { versions: { coalesceSeconds: 0 } });
    mkdirSync(join(root, 'p'));
    writeFileSync(join(root, 'p', 'viejo.c4.json'), 'escrito a mano');
    expect(await store.listVersions('p', 'viejo')).toEqual([]); // sin historial hasta el primer guardado
    await store.saveDiagram('p', { id: 'viejo', text: 'primer guardado' });
    expect((await store.listVersions('p', 'viejo')).map((v) => v.id)).toEqual([2, 1]);
    expect((await store.getVersion('p', 'viejo', 1))?.text).toBe('escrito a mano');

    // alguien (git pull, un editor) cambia el archivo por fuera: el guardado siguiente no lo pierde
    writeFileSync(join(root, 'p', 'viejo.c4.json'), 'cambio externo');
    await store.saveDiagram('p', { id: 'viejo', text: 'segundo guardado' });
    expect((await store.listVersions('p', 'viejo')).map((v) => v.id)).toEqual([4, 3, 2, 1]);
    expect((await store.getVersion('p', 'viejo', 3))?.text).toBe('cambio externo');
    // y se puede volver a lo escrito a mano
    await store.restoreVersion('p', 'viejo', 1);
    expect(readFileSync(join(root, 'p', 'viejo.c4.json'), 'utf8')).toBe('escrito a mano');
  });

  it('un índice dañado, truncado o con entradas inválidas no rompe nada: el historial empieza de nuevo y los documentos huérfanos se limpian', async () => {
    const { root } = workspace();
    const store = new FolderProjectStore(root, { versions: { coalesceSeconds: 0 } });
    const p = await store.createProject({ name: 'P' });
    const d = await store.saveDiagram(p.id, { module: 'c4', name: 'D', text: 'uno' });
    await store.saveDiagram(p.id, { id: d.id, text: 'dos' });
    const dir = historyOf(root, p.id, d.id);
    for (const broken of ['', '{', '[]', 'null', '{"format":"otro/1","versions":[]}', JSON.stringify({ format: HISTORY_FORMAT, lastId: 'x', versions: 'no' })]) {
      writeFileSync(join(dir, 'index.json'), broken);
      expect(await store.listVersions(p.id, d.id)).toEqual([]); // no falla al leer
      await store.saveDiagram(p.id, { id: d.id, text: `tras ${broken.slice(0, 5)}` }); // ni al guardar
      expect((await store.getDiagram(p.id, d.id))?.text).toContain('tras');
      expect((await store.listVersions(p.id, d.id)).length).toBeGreaterThan(0);
    }
    // las entradas que no cumplen el contrato se descartan una a una
    writeFileSync(
      join(dir, 'index.json'),
      JSON.stringify({
        format: HISTORY_FORMAT,
        lastId: 5,
        versions: [
          { id: 3, savedAt: '2026-01-01T00:00:00.000Z', size: 3, hash: describeContent('abc').hash },
          { id: 0, savedAt: '2026-01-01T00:00:00.000Z', size: 3, hash: describeContent('abc').hash },
          { id: 4, savedAt: 'ayer', size: 3, hash: describeContent('abc').hash },
          { id: 5, savedAt: '2026-01-01T00:00:00.000Z', size: -1, hash: 'nada' },
          { id: '6', savedAt: '2026-01-01T00:00:00.000Z', size: 3, hash: describeContent('abc').hash },
        ],
      }),
    );
    expect((await store.listVersions(p.id, d.id)).map((v) => v.id)).toEqual([3]);
    writeFileSync(join(dir, '000003.json'), 'abc');
    await store.saveDiagram(p.id, { id: d.id, text: 'nuevo' });
    // el mayor id dado (5) sigue contando aunque su entrada no valiera; el contenido que había (no figuraba en el historial) se registra como línea base (6)
    expect((await store.listVersions(p.id, d.id)).map((v) => v.id)).toEqual([7, 6, 3]);
    expect(readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).sort()).toEqual(['000003.json', '000006.json', '000007.json']);
  });

  it('los documentos huérfanos (un guardado que se cortó antes de anotar el índice) se limpian al guardar', async () => {
    const { root } = workspace();
    const store = new FolderProjectStore(root, { versions: { coalesceSeconds: 0 } });
    const p = await store.createProject({ name: 'P' });
    const d = await store.saveDiagram(p.id, { module: 'c4', name: 'D', text: 'uno' });
    const dir = historyOf(root, p.id, d.id);
    writeFileSync(join(dir, '000009.json'), 'huérfano');
    writeFileSync(join(dir, 'notas.txt'), 'ajeno'); // lo que no tiene forma de versión no se toca
    await store.saveDiagram(p.id, { id: d.id, text: 'dos' });
    expect(readdirSync(dir).sort()).toEqual(['000001.json', '000002.json', 'index.json', 'notas.txt']);
  });

  it('no sigue enlaces simbólicos: con `.versiones` apuntando fuera, listar es no tener historial y guardar falla sin escribir fuera', async () => {
    const { outside, root, store } = workspace();
    const p = await store.createProject({ name: 'P' });
    const d = await store.saveDiagram(p.id, { module: 'c4', name: 'D', text: 'uno' });
    rmSync(join(root, p.id, VERSIONS_DIR), { recursive: true, force: true });
    const target = join(outside, 'ajeno');
    mkdirSync(target);
    writeFileSync(join(target, 'secreto.txt'), 'no tocar');
    if (!symlinkOrSkip(target, join(root, p.id, VERSIONS_DIR))) return;
    expect(await store.listVersions(p.id, d.id)).toEqual([]);
    await expect(store.saveDiagram(p.id, { id: d.id, text: 'dos' })).rejects.toMatchObject({ code: 'unavailable' });
    expect((await store.getDiagram(p.id, d.id))?.text).toBe('uno'); // el diagrama no cambió
    await store.deleteDiagram(p.id, d.id); // borrar el diagrama tampoco sigue el enlace
    expect(readdirSync(target)).toEqual(['secreto.txt']);
    expect(readFileSync(join(target, 'secreto.txt'), 'utf8')).toBe('no tocar');
  });

  it('un directorio de historial que es un enlace (solo el del diagrama) tampoco se sigue', async () => {
    const { outside, root, store } = workspace();
    const p = await store.createProject({ name: 'P' });
    const d = await store.saveDiagram(p.id, { module: 'c4', name: 'D', text: 'uno' });
    const leaf = historyOf(root, p.id, d.id);
    rmSync(leaf, { recursive: true, force: true });
    const target = join(outside, 'ajeno');
    mkdirSync(target);
    if (!symlinkOrSkip(target, leaf)) return;
    await expect(store.saveDiagram(p.id, { id: d.id, text: 'dos' })).rejects.toMatchObject({ code: 'unavailable' });
    expect(readdirSync(target)).toEqual([]);
  });

  it('borrar el diagrama o el proyecto borra su historial; uno nuevo con el mismo id no hereda versiones, aunque hubiera restos', async () => {
    const { root, store } = workspace();
    const p = await store.createProject({ name: 'P' });
    const d = await store.saveDiagram(p.id, { module: 'c4', name: 'D', text: 'uno' });
    await store.saveDiagram(p.id, { id: d.id, text: 'dos' });
    await store.deleteDiagram(p.id, d.id);
    expect(existsSync(historyOf(root, p.id, d.id))).toBe(false);
    // restos de un historial anterior (un borrado a mano del diagrama, sin pasar por DIAgrams)
    mkdirSync(historyOf(root, p.id, 'd'), { recursive: true });
    writeFileSync(join(historyOf(root, p.id, 'd'), '000007.json'), 'resto');
    const again = await store.saveDiagram(p.id, { module: 'c4', name: 'D', text: 'nuevo' });
    expect(again.id).toBe('d');
    expect((await store.listVersions(p.id, again.id)).map((v) => v.id)).toEqual([1]);
    expect(readdirSync(historyOf(root, p.id, 'd')).sort()).toEqual(['000001.json', 'index.json']);
    await store.deleteProject(p.id);
    expect(existsSync(join(root, p.id))).toBe(false);
  });

  it('ids de proyecto, diagrama y versión que intentan salir de la carpeta se rechazan antes de tocar el disco', async () => {
    const { outside, root, store } = workspace();
    const p = await store.createProject({ name: 'P' });
    await store.saveDiagram(p.id, { module: 'c4', name: 'D', text: 'uno' });
    const before = JSON.stringify([readdirSync(outside).sort(), readdirSync(root).sort(), readdirSync(join(root, p.id)).sort()]);
    for (const bad of ['../x', '..', '/etc', 'a/b', '.versiones', '', 'x\u0000y']) {
      await rejects(store.listVersions(p.id, bad), 'invalid');
      await rejects(store.listVersions(bad, 'd'), 'invalid');
      await rejects(store.restoreVersion(p.id, bad, 1), 'invalid');
    }
    for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 40, Number.POSITIVE_INFINITY]) {
      await rejects(store.getVersion(p.id, 'd', bad), 'invalid');
      await rejects(store.restoreVersion(p.id, 'd', bad), 'invalid');
    }
    expect(JSON.stringify([readdirSync(outside).sort(), readdirSync(root).sort(), readdirSync(join(root, p.id)).sort()])).toBe(before);
  });

  it('dos almacenes sobre la misma carpeta (el CLI y `iark serve`) comparten el historial sin repetir ids', async () => {
    const { root } = workspace();
    const options = { versions: { coalesceSeconds: 0 } };
    const a = new FolderProjectStore(root, options);
    const b = new FolderProjectStore(root, options);
    const p = await a.createProject({ name: 'P' });
    const d = await a.saveDiagram(p.id, { module: 'c4', name: 'D', text: 'a1' });
    await b.saveDiagram(p.id, { id: d.id, text: 'b1' });
    await a.saveDiagram(p.id, { id: d.id, text: 'a2' });
    await b.labelVersion(p.id, d.id, 2, 'Del otro proceso');
    expect((await a.listVersions(p.id, d.id)).map((v) => [v.id, v.label])).toEqual([
      [3, undefined],
      [2, 'Del otro proceso'],
      [1, undefined],
    ]);
  });

  it('los guardados simultáneos dentro de un proceso no se pisan: cada contenido distinto deja su versión', async () => {
    const { root } = workspace();
    const store = new FolderProjectStore(root, { versions: { coalesceSeconds: 0, keepAutomatic: 50 } });
    const p = await store.createProject({ name: 'P' });
    const d = await store.saveDiagram(p.id, { module: 'c4', name: 'D', text: 'v0' });
    await Promise.all(Array.from({ length: 12 }, (_, i) => store.saveDiagram(p.id, { id: d.id, text: `v${i + 1}` })));
    const versions = await store.listVersions(p.id, d.id);
    expect(versions).toHaveLength(13);
    expect(new Set(versions.map((v) => v.id)).size).toBe(13);
    const texts = await Promise.all(versions.map(async (v) => (await store.getVersion(p.id, d.id, v.id))?.text));
    expect(new Set(texts).size).toBe(13);
  });

  it('la política puede venir de las variables de entorno y un valor mal escrito se rechaza con el motivo', () => {
    expect(versionPolicyFromEnv({})).toEqual({});
    expect(versionPolicyFromEnv({ IARK_VERSIONS: 'off' })).toBe(false);
    expect(versionPolicyFromEnv({ IARK_VERSIONS: 'OFF' })).toBe(false);
    expect(versionPolicyFromEnv({ IARK_VERSIONS_COALESCE: '0', IARK_VERSIONS_KEEP: '20', IARK_VERSIONS_MAX: '40' })).toEqual({ coalesceSeconds: 0, keepAutomatic: 20, maxVersions: 40 });
    expect(() => versionPolicyFromEnv({ IARK_VERSIONS_KEEP: 'muchas' })).toThrow(/IARK_VERSIONS_KEEP/);
    expect(() => versionPolicyFromEnv({ IARK_VERSIONS_MAX: '-3' })).toThrow(ProjectError);
    const { root } = workspace();
    const previous = { ...process.env };
    process.env.IARK_VERSIONS_KEEP = '2';
    process.env.IARK_VERSIONS_MAX = '3';
    process.env.IARK_VERSIONS_COALESCE = '0';
    try {
      expect(new FolderProjectStore(root).versionPolicy).toEqual({ coalesceSeconds: 0, keepAutomatic: 2, maxVersions: 3 });
      process.env.IARK_VERSIONS_KEEP = '9999';
      expect(() => new FolderProjectStore(root)).toThrow(ProjectError); // fuera de las cotas: no se arranca con otra política en silencio
    } finally {
      process.env = previous;
    }
  });
});
