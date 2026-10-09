// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpProjectStore, MemoryProjectStore, ProjectError, type ProjectStore, type VersionPolicy } from '@iark/kernel';
import { ProjectSession } from './session';
import { fakeServer } from './testing';

/**
 * El historial de versiones desde la sesión de proyectos: cuándo se ofrece, que restaurar guarda antes lo pendiente y respeta la marca del diagrama
 * abierto, y qué puede hacer cada rol. Las reglas del historial en sí (coalescencia, retención, ids) están en la suite de contrato de los almacenes.
 */
const BASE = 'http://localhost:8787';
const POLICY: Partial<VersionPolicy> = { coalesceSeconds: 0, keepAutomatic: 5, maxVersions: 7 };

const memory = (versions: Partial<VersionPolicy> | false = POLICY) => new MemoryProjectStore(undefined, { versions });

async function open(store: ProjectStore = memory(), options: { debounceMs?: number } = {}) {
  const session = new ProjectSession(store, { broadcast: false, persist: false, pollMs: 0, debounceMs: options.debounceMs ?? 20 });
  await session.init();
  const project = await session.createProject('Tienda');
  const meta = await session.createDiagram({ module: 'c4', name: 'Contexto', text: 'uno' });
  await session.store.saveDiagram(project.id, { id: meta.id, text: 'dos' });
  await session.store.saveDiagram(project.id, { id: meta.id, text: 'tres' });
  await session.refresh();
  await session.openDiagram(project.id, meta.id);
  return { session, project, meta };
}

describe('sesión: historial de versiones', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: false }));
  afterEach(() => vi.useRealTimers());

  describe('cuándo se ofrece', () => {
    it('un almacén que guarda versiones lo declara (`canVersion`) y la sesión da acceso a su historial', async () => {
      const { session, project, meta } = await open();
      expect(session.canVersion).toBe(true);
      expect((await session.listVersions(project.id, meta.id)).map((v) => v.id)).toEqual([3, 2, 1]);
      expect((await session.getVersion(project.id, meta.id, 2))?.text).toBe('dos');
      expect(await session.getVersion(project.id, meta.id, 99)).toBeUndefined();
      const named = await session.labelVersion(project.id, meta.id, 2, 'Entrega');
      expect(named).toMatchObject({ id: 2, label: 'Entrega' });
      await session.deleteVersion(project.id, meta.id, 2);
      expect((await session.listVersions(project.id, meta.id)).map((v) => v.id)).toEqual([3, 1]);
      session.dispose();
    });

    it('un almacén sin historial (o desactivado) lo declara y la sesión rechaza con `unsupported` en lugar de fallar de otra forma', async () => {
      const { session, project, meta } = await open(memory(false));
      expect(session.canVersion).toBe(false);
      for (const call of [
        () => session.listVersions(project.id, meta.id),
        () => session.getVersion(project.id, meta.id, 1),
        () => session.labelVersion(project.id, meta.id, 1, 'x'),
        () => session.deleteVersion(project.id, meta.id, 1),
        () => session.restoreVersion(project.id, meta.id, 1),
      ]) {
        await expect(call()).rejects.toMatchObject({ code: 'unsupported' });
      }
      // y el diagrama se sigue guardando con normalidad
      session.queueSave('cuatro');
      await vi.advanceTimersByTimeAsync(30);
      expect((await session.store.getDiagram(project.id, meta.id))?.text).toBe('cuatro');
      session.dispose();
    });

    it('un almacén cualquiera que no sabe de versiones (sin `keepsVersions`) tampoco las ofrece', async () => {
      const base = new MemoryProjectStore();
      const plain: ProjectStore = {
        kind: 'plano',
        listProjects: () => base.listProjects(),
        getProject: (id) => base.getProject(id),
        createProject: (input) => base.createProject(input),
        renameProject: (id, name) => base.renameProject(id, name),
        deleteProject: (id) => base.deleteProject(id),
        getDiagram: (p, d) => base.getDiagram(p, d),
        saveDiagram: (p, input) => base.saveDiagram(p, input),
        renameDiagram: (p, d, name) => base.renameDiagram(p, d, name),
        deleteDiagram: (p, d) => base.deleteDiagram(p, d),
      };
      const { session } = await open(plain);
      expect(session.canVersion).toBe(false);
      await expect(session.listVersions('x', 'y')).rejects.toBeInstanceOf(ProjectError);
      session.dispose();
    });

    it('el cliente de un servidor se ofrece siempre; si el servidor es anterior al historial, se sabe al pedirlo (`unsupported`)', async () => {
      const server = fakeServer({ store: memory(false) });
      const session = new ProjectSession(new HttpProjectStore({ baseUrl: BASE, fetch: server.fetch }), { broadcast: false, pollMs: 0, debounceMs: 20 });
      await session.init();
      const project = await session.createProject('Tienda');
      const meta = await session.createDiagram({ module: 'c4', name: 'Contexto', text: 'uno' });
      expect(session.canVersion).toBe(true);
      await expect(session.listVersions(project.id, meta.id)).rejects.toMatchObject({ code: 'unsupported' });
      session.dispose();
    });
  });

  describe('restaurar', () => {
    it('guarda antes lo pendiente (queda en el historial), restaura como versión nueva y devuelve el diagrama como quedó', async () => {
      const { session, project, meta } = await open(memory(), { debounceMs: 60_000 });
      session.queueSave('lo que estaba editando');
      expect(session.getState().save).toBe('pending');
      const result = await session.restoreVersion(project.id, meta.id, 1);
      expect(result.unchanged).toBe(false);
      expect(result.diagram).toMatchObject({ id: meta.id, text: 'uno' });
      expect(result.version).toMatchObject({ id: 5, restoredFrom: 1 });
      // lo pendiente se guardó (versión 4) antes de pisarlo: se puede recuperar
      expect((await session.getVersion(project.id, meta.id, 4))?.text).toBe('lo que estaba editando');
      expect(session.getState()).toMatchObject({ save: 'saved', saveError: undefined });
      expect(session.dirty).toBe(false);
      session.dispose();
    });

    it('deja la sesión al día con la nueva marca: el autoguardado de después no choca con la restauración', async () => {
      const { session, project, meta } = await open();
      await session.restoreVersion(project.id, meta.id, 1);
      session.queueSave('después de restaurar');
      await vi.advanceTimersByTimeAsync(30);
      expect(session.getState()).toMatchObject({ save: 'saved' });
      expect((await session.store.getDiagram(project.id, meta.id))?.text).toBe('después de restaurar');
      session.dispose();
    });

    it('restaurar la versión que ya es el contenido actual no guarda nada y lo dice', async () => {
      const { session, project, meta } = await open();
      const result = await session.restoreVersion(project.id, meta.id, 3);
      expect(result.unchanged).toBe(true);
      expect(result.diagram.text).toBe('tres');
      expect((await session.listVersions(project.id, meta.id)).map((v) => v.id)).toEqual([3, 2, 1]);
      session.dispose();
    });

    it('una versión que no existe rechaza con `not-found` y no toca el diagrama', async () => {
      const { session, project, meta } = await open();
      await expect(session.restoreVersion(project.id, meta.id, 42)).rejects.toMatchObject({ code: 'not-found' });
      expect((await session.store.getDiagram(project.id, meta.id))?.text).toBe('tres');
      session.dispose();
    });

    it('si otra persona guardó el diagrama abierto, rechaza con `conflict`, no toca nada y deja el conflicto donde se resuelve', async () => {
      const server = fakeServer({ store: memory() });
      const session = new ProjectSession(new HttpProjectStore({ baseUrl: BASE, fetch: server.fetch }), { broadcast: false, pollMs: 0, debounceMs: 20 });
      await session.init();
      const project = await session.createProject('Tienda');
      const meta = await session.createDiagram({ module: 'c4', name: 'Contexto', text: 'uno' });
      await session.store.saveDiagram(project.id, { id: meta.id, text: 'dos' });
      await session.refresh();
      await session.openDiagram(project.id, meta.id);
      await server.store.saveDiagram(project.id, { id: meta.id, text: 'de otra persona' });
      await expect(session.restoreVersion(project.id, meta.id, 1)).rejects.toMatchObject({ code: 'conflict' });
      expect((await server.store.getDiagram(project.id, meta.id))?.text).toBe('de otra persona');
      expect(session.getState()).toMatchObject({ save: 'conflict', saveErrorCode: 'conflict' });
      // resolver el conflicto («Cargar la otra») deja restaurar de nuevo
      const reloaded = await session.resolveConflict('reload');
      expect(reloaded?.text).toBe('de otra persona');
      await expect(session.restoreVersion(project.id, meta.id, 1)).resolves.toMatchObject({ unchanged: false });
      session.dispose();
    });

    it('con un conflicto de guardado sin resolver no restaura (sustituiría lo que la persona escribió), y sin tocar nada', async () => {
      const server = fakeServer({ store: memory() });
      const session = new ProjectSession(new HttpProjectStore({ baseUrl: BASE, fetch: server.fetch }), { broadcast: false, pollMs: 0, debounceMs: 20 });
      await session.init();
      const project = await session.createProject('Tienda');
      const meta = await session.createDiagram({ module: 'c4', name: 'Contexto', text: 'uno' });
      await session.store.saveDiagram(project.id, { id: meta.id, text: 'dos' });
      await session.refresh();
      await session.openDiagram(project.id, meta.id);
      await server.store.saveDiagram(project.id, { id: meta.id, text: 'de otra persona' });
      session.queueSave('lo mío');
      await vi.advanceTimersByTimeAsync(30);
      expect(session.getState().save).toBe('conflict');
      await expect(session.restoreVersion(project.id, meta.id, 1)).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('conflicto de guardado') });
      expect((await server.store.getDiagram(project.id, meta.id))?.text).toBe('de otra persona');
      expect(session.dirty).toBe(true);
      session.dispose();
    });

    it('si lo pendiente no se pudo guardar (sin red), no restaura: sustituiría cambios que solo están en esta pestaña', async () => {
      const server = fakeServer({ store: memory() });
      const session = new ProjectSession(new HttpProjectStore({ baseUrl: BASE, fetch: server.fetch }), { broadcast: false, pollMs: 0, debounceMs: 60_000 });
      await session.init();
      const project = await session.createProject('Tienda');
      const meta = await session.createDiagram({ module: 'c4', name: 'Contexto', text: 'uno' });
      await session.store.saveDiagram(project.id, { id: meta.id, text: 'dos' });
      await session.refresh();
      await session.openDiagram(project.id, meta.id);
      session.queueSave('sin guardar');
      server.down = true;
      await expect(session.restoreVersion(project.id, meta.id, 1)).rejects.toMatchObject({ code: 'unavailable' });
      expect(session.dirty).toBe(true);
      server.down = false;
      session.dispose();
    });

    it('un diagrama que no es el abierto se restaura sin tocar el guardado de la sesión', async () => {
      const { session, project } = await open();
      const other = await session.store.saveDiagram(project.id, { module: 'c4', name: 'Otro', text: 'a' });
      await session.store.saveDiagram(project.id, { id: other.id, text: 'b' });
      const before = session.getState();
      const result = await session.restoreVersion(project.id, other.id, 1);
      expect(result.diagram.text).toBe('a');
      expect(session.getState().diagramId).toBe(before.diagramId);
      expect(session.getState().save).toBe(before.save);
      session.dispose();
    });
  });

  describe('qué puede hacer cada rol', () => {
    it('sin roles que consultar (este navegador, un servidor abierto) se le deja intentar todo: decide el servidor', async () => {
      const { session, project } = await open();
      expect(await session.versionRights(project.id)).toEqual({ restore: true, label: true, remove: true });
      session.dispose();
    });

    it('con un token, el rol es el del token (se pregunta a `whoami`)', async () => {
      const server = fakeServer({ token: 'secreto', role: 'viewer', store: memory() });
      const session = new ProjectSession(new HttpProjectStore({ baseUrl: BASE, token: 'secreto', fetch: server.fetch }), { broadcast: false, pollMs: 0 });
      await session.init();
      expect(session.credential).toBe('token');
      expect(await session.versionRights('tienda')).toEqual({ role: 'viewer', restore: false, label: false, remove: false });
      server.role = 'editor';
      expect(await session.versionRights('tienda')).toEqual({ role: 'editor', restore: true, label: true, remove: false });
      server.role = 'admin';
      expect(await session.versionRights('tienda')).toEqual({ role: 'admin', restore: true, label: true, remove: true });
      session.dispose();
    });

    it('con una sesión de persona, el rol es el que tiene en ese proyecto', async () => {
      const server = fakeServer({ accounts: true, store: memory() });
      const ana = { id: 'u_ana', login: 'ana', siteRole: 'member' as const };
      const token = server.openSession(ana);
      const session = new ProjectSession(new HttpProjectStore({ baseUrl: BASE, token, fetch: server.fetch }), { broadcast: false, pollMs: 0 });
      await session.init();
      const project = await session.createProject('Tienda');
      expect(await session.versionRights(project.id)).toMatchObject({ role: 'admin', remove: true });
      server.share(project.id, ana, 'viewer');
      await session.refresh();
      expect(await session.versionRights(project.id)).toEqual({ role: 'viewer', restore: false, label: false, remove: false });
      session.dispose();
    });
  });
});
