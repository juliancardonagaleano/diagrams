import { describe, expect, it } from 'vitest';
import { describeContent, isVersioned, ProjectError, type ProjectStore, type VersionedProjectStore, type VersionPolicy } from '@iark/kernel';

/**
 * El contrato del HISTORIAL DE VERSIONES: lo que cualquier almacén que lo guarda (memoria, IndexedDB, carpeta y el cliente remoto contra un
 * servidor real) debe cumplir igual. Cada uno lo ejecuta con una fábrica que devuelve un almacén vacío con la política pedida y un reloj
 * que la prueba controla: la coalescencia y la rotación dependen del tiempo, y no se prueban esperando.
 */
export interface VersionsHarness {
  store: ProjectStore;
  cleanup?: () => Promise<void> | void;
}

/** Un reloj que solo avanza cuando la prueba lo dice. Arranca en la hora real (los almacenes en disco ponen la fecha de modificación de verdad). */
export interface TestClock {
  now(): Date;
  advance(ms: number): void;
}

export const testClock = (): TestClock => {
  let t = Date.now();
  return {
    now: () => new Date(t),
    advance: (ms) => {
      t += ms;
    },
  };
};

export type VersionsFactory = (setup: { policy: Partial<VersionPolicy>; clock: TestClock }) => Promise<VersionsHarness>;

export interface VersionsContractOptions {
  /** El almacén anota quién guarda (`SaveDiagramInput.by`). El cliente remoto no: lo decide el servidor con la identidad de la petición. */
  recordsActor?: boolean;
  /** El almacén cuenta lo que ocupa el historial (`versionUsage`). El cliente remoto no. */
  reportsUsage?: boolean;
}

const SECOND = 1000;

export function projectVersionsContract(label: string, create: VersionsFactory, options: VersionsContractOptions = {}): void {
  const { recordsActor = true, reportsUsage = true } = options;

  describe(`contrato del historial de versiones: ${label}`, () => {
    const withStore = async (policy: Partial<VersionPolicy>, body: (store: VersionedProjectStore, clock: TestClock) => Promise<void>): Promise<void> => {
      const clock = testClock();
      const { store, cleanup } = await create({ policy, clock });
      try {
        expect(isVersioned(store)).toBe(true);
        await body(store as VersionedProjectStore, clock);
      } finally {
        await cleanup?.();
      }
    };
    const rejects = async (promise: Promise<unknown>, code: string): Promise<ProjectError> => {
      const error = await promise.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ProjectError);
      expect((error as ProjectError).code).toBe(code);
      return error as ProjectError;
    };
    /** Un proyecto con un diagrama; la política por omisión salvo lo que se pida. */
    const diagramOf = async (store: VersionedProjectStore, text = 'uno') => {
      const project = await store.createProject({ name: 'Tienda' });
      const diagram = await store.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text });
      return { project, diagram, p: project.id, d: diagram.id };
    };
    const ids = async (store: VersionedProjectStore, p: string, d: string): Promise<number[]> => (await store.listVersions(p, d)).map((v) => v.id);

    it('se declara versionado y crear un diagrama crea la versión 1 con su documento, tamaño y hash', () =>
      withStore({}, async (store) => {
        expect(store.keepsVersions).toBe(true);
        const text = '{"nombre":"Gestión ✓ 日本"}';
        const { p, d } = await diagramOf(store, text);
        const versions = await store.listVersions(p, d);
        expect(versions).toHaveLength(1);
        expect(versions[0]).toMatchObject({ id: 1, size: new TextEncoder().encode(text).length, hash: describeContent(text).hash });
        expect(versions[0].size).toBeGreaterThan(text.length); // son bytes UTF-8, no caracteres
        expect(Number.isNaN(Date.parse(versions[0].savedAt))).toBe(false);
        expect(versions[0]).not.toHaveProperty('text'); // la lista no lleva documentos
        expect(versions[0].label).toBeUndefined();
        expect(await store.getVersion(p, d, 1)).toMatchObject({ id: 1, text, hash: describeContent(text).hash });
      }));

    it('cada guardado separado en el tiempo crea una versión con un id mayor, y la lista va de la más reciente a la más antigua', () =>
      withStore({}, async (store, clock) => {
        const { p, d } = await diagramOf(store, 'uno');
        for (const text of ['dos', 'tres', 'cuatro']) {
          clock.advance(120 * SECOND);
          await store.saveDiagram(p, { id: d, text });
        }
        expect(await ids(store, p, d)).toEqual([4, 3, 2, 1]);
        const all = await store.listVersions(p, d);
        expect(all.map((v) => v.savedAt)).toEqual([...all.map((v) => v.savedAt)].sort().reverse());
        for (const [id, text] of [[1, 'uno'], [2, 'dos'], [3, 'tres'], [4, 'cuatro']] as const) expect((await store.getVersion(p, d, id))?.text).toBe(text);
        expect(await store.getVersion(p, d, 5)).toBeUndefined();
      }));

    it('guardar el mismo contenido no crea una versión nueva', () =>
      withStore({}, async (store, clock) => {
        const { p, d } = await diagramOf(store, 'uno');
        clock.advance(120 * SECOND);
        await store.saveDiagram(p, { id: d, text: 'uno' });
        expect(await ids(store, p, d)).toEqual([1]);
      }));

    it('coalescencia: guardados seguidos dentro de la ventana sustituyen la última versión automática (con un id nuevo); fuera de ella, añaden', () =>
      withStore({ coalesceSeconds: 30 }, async (store, clock) => {
        const { p, d } = await diagramOf(store, 'uno');
        clock.advance(40 * SECOND);
        await store.saveDiagram(p, { id: d, text: 'dos' }); // v2, abre la ventana
        clock.advance(5 * SECOND);
        await store.saveDiagram(p, { id: d, text: 'tres' }); // sustituye a v2
        expect(await ids(store, p, d)).toEqual([3, 1]);
        expect(await store.getVersion(p, d, 2)).toBeUndefined(); // una versión sustituida desaparece y su id no vuelve
        expect((await store.getVersion(p, d, 3))?.text).toBe('tres');
        clock.advance(60 * SECOND);
        await store.saveDiagram(p, { id: d, text: 'cuatro' }); // fuera de la ventana
        expect(await ids(store, p, d)).toEqual([4, 3, 1]);
      }));

    it('la ventana se mide desde el primer guardado de la serie: una edición continua deja una versión por ventana, no una sola', () =>
      withStore({ coalesceSeconds: 30 }, async (store, clock) => {
        const { p, d } = await diagramOf(store, 'v0');
        clock.advance(60 * SECOND);
        for (let i = 1; i <= 8; i++) {
          await store.saveDiagram(p, { id: d, text: `v${i}` });
          clock.advance(10 * SECOND); // 8 guardados cada 10 s: 70 s de edición continua
        }
        const versions = await store.listVersions(p, d);
        expect(versions).toHaveLength(4); // v0 y tres ventanas de 30 s (guardados en 0, 10 y 20 s; 30, 40 y 50 s; 60 y 70 s)
        expect((await store.getVersion(p, d, versions[0].id))?.text).toBe('v8'); // la última versión es el estado actual
        expect((await store.getVersion(p, d, versions[versions.length - 1].id))?.text).toBe('v0');
      }));

    it('con coalescencia 0 cada guardado es una versión', () =>
      withStore({ coalesceSeconds: 0 }, async (store) => {
        const { p, d } = await diagramOf(store, 'a');
        for (const text of ['b', 'c', 'd']) await store.saveDiagram(p, { id: d, text });
        expect(await ids(store, p, d)).toEqual([4, 3, 2, 1]);
      }));

    it('una versión con nombre nunca se sustituye: el guardado siguiente, aun dentro de la ventana, añade otra', () =>
      withStore({ coalesceSeconds: 30 }, async (store, clock) => {
        const { p, d } = await diagramOf(store, 'uno');
        clock.advance(40 * SECOND);
        await store.saveDiagram(p, { id: d, text: 'dos' });
        const named = await store.labelVersion(p, d, 2, '  Entrega 1  ');
        expect(named).toMatchObject({ id: 2, label: 'Entrega 1' });
        clock.advance(2 * SECOND);
        await store.saveDiagram(p, { id: d, text: 'tres' });
        expect(await ids(store, p, d)).toEqual([3, 2, 1]);
        expect(await store.getVersion(p, d, 2)).toMatchObject({ label: 'Entrega 1', text: 'dos' });
        clock.advance(2 * SECOND);
        await store.saveDiagram(p, { id: d, text: 'cuatro' }); // sí sustituye a la v3 (automática)
        expect(await ids(store, p, d)).toEqual([4, 2, 1]);
      }));

    it('quién guarda se anota en la versión y dos personas distintas no comparten versión', async () => {
      if (!recordsActor) return;
      await withStore({ coalesceSeconds: 30 }, async (store, clock) => {
        const project = await store.createProject({ name: 'Tienda' });
        const d = (await store.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text: 'uno', by: '@ana' })).id;
        clock.advance(5 * SECOND);
        await store.saveDiagram(project.id, { id: d, text: 'dos', by: '@beto' }); // otra persona: no sustituye
        clock.advance(5 * SECOND);
        await store.saveDiagram(project.id, { id: d, text: 'tres', by: '  @beto\n ' }); // la misma (limpia): sí
        const versions = await store.listVersions(project.id, d);
        expect(versions.map((v) => [v.id, v.savedBy])).toEqual([
          [3, '@beto'],
          [1, '@ana'],
        ]);
        await store.saveDiagram(project.id, { id: d, text: 'cuatro', by: '\u0000\u0007' }); // sin nada utilizable: anónimo
        expect((await store.listVersions(project.id, d))[0].savedBy).toBeUndefined();
      });
    });

    it('retención: se conservan las últimas N automáticas, se descarta la más vieja y los ids no se reutilizan', () =>
      withStore({ coalesceSeconds: 0, keepAutomatic: 3, maxVersions: 6 }, async (store) => {
        const { p, d } = await diagramOf(store, 'v1');
        for (let i = 2; i <= 10; i++) await store.saveDiagram(p, { id: d, text: `v${i}` });
        expect(await ids(store, p, d)).toEqual([10, 9, 8]);
        expect(await store.getVersion(p, d, 7)).toBeUndefined();
        expect((await store.getVersion(p, d, 8))?.text).toBe('v8');
        await store.saveDiagram(p, { id: d, text: 'v11' });
        expect(await ids(store, p, d)).toEqual([11, 10, 9]);
      }));

    it('retención: las versiones con nombre se conservan siempre, hasta el máximo de nombradas', () =>
      withStore({ coalesceSeconds: 0, keepAutomatic: 2, maxVersions: 4 }, async (store) => {
        const { p, d } = await diagramOf(store, 'v1');
        await store.labelVersion(p, d, 1, 'Primera');
        for (let i = 2; i <= 8; i++) await store.saveDiagram(p, { id: d, text: `v${i}` });
        expect(await ids(store, p, d)).toEqual([8, 7, 1]);
        expect(await store.getVersion(p, d, 1)).toMatchObject({ label: 'Primera', text: 'v1' });
        // caben 4 - 2 = 2 nombradas; la tercera se rechaza con el motivo, y renombrar una ya nombrada sigue valiendo
        await store.labelVersion(p, d, 7, 'Segunda');
        const full = await rejects(store.labelVersion(p, d, 8, 'Tercera'), 'invalid');
        expect(full.info.serverCode).toBe('limit');
        expect(await store.labelVersion(p, d, 1, 'Primera, revisada')).toMatchObject({ label: 'Primera, revisada' });
        for (let i = 9; i <= 12; i++) await store.saveDiagram(p, { id: d, text: `v${i}` });
        expect(await ids(store, p, d)).toEqual([12, 11, 7, 1]);
      }));

    it('nombrar valida el nombre: ni vacío, ni solo espacios, ni que no sea un texto, ni larguísimo', () =>
      withStore({}, async (store) => {
        const { p, d } = await diagramOf(store);
        for (const bad of ['', '   ', '\u0000\t', 'x'.repeat(500)]) await rejects(store.labelVersion(p, d, 1, bad), 'invalid');
        await rejects(store.labelVersion(p, d, 1, 42 as unknown as string), 'invalid');
        await rejects(store.labelVersion(p, d, 99, 'Nada'), 'not-found');
        expect((await store.labelVersion(p, d, 1, 'Línea\n dos')).label).toBe('Línea dos'); // se limpia como el resto de nombres
      }));

    it('borrar: solo las versiones con nombre; el id de una versión borrada no se reutiliza', () =>
      withStore({ coalesceSeconds: 0 }, async (store) => {
        const { p, d } = await diagramOf(store, 'v1');
        await store.saveDiagram(p, { id: d, text: 'v2' });
        const automatic = await rejects(store.deleteVersion(p, d, 2), 'invalid');
        expect(automatic.message).toMatch(/nombre/);
        await store.labelVersion(p, d, 2, 'Para borrar');
        await store.deleteVersion(p, d, 2);
        expect(await ids(store, p, d)).toEqual([1]);
        expect(await store.getVersion(p, d, 2)).toBeUndefined();
        await rejects(store.deleteVersion(p, d, 2), 'not-found');
        await store.saveDiagram(p, { id: d, text: 'v3' });
        expect(await ids(store, p, d)).toEqual([3, 1]); // la 2 no vuelve, aunque sea la última que se borró
      }));

    it('restaurar crea una versión NUEVA con el contenido antiguo y no pierde ninguna', () =>
      withStore({ coalesceSeconds: 30 }, async (store, clock) => {
        const { p, d } = await diagramOf(store, 'bueno');
        clock.advance(120 * SECOND);
        await store.saveDiagram(p, { id: d, text: 'malo' });
        const before = await store.getDiagram(p, d);
        clock.advance(1 * SECOND); // dentro de la ventana: una restauración no sustituye la versión anterior
        const restored = await store.restoreVersion(p, d, 1);
        expect(restored.unchanged).toBe(false);
        expect(restored.version).toMatchObject({ id: 3, restoredFrom: 1, hash: describeContent('bueno').hash });
        expect(restored.diagram.updatedAt > before!.updatedAt).toBe(true);
        expect((await store.getDiagram(p, d))?.text).toBe('bueno');
        expect(await ids(store, p, d)).toEqual([3, 2, 1]);
        expect((await store.getVersion(p, d, 2))?.text).toBe('malo'); // lo que se deshizo sigue en el historial
        expect((await store.getVersion(p, d, 1))?.text).toBe('bueno');
        expect((await store.listVersions(p, d))[0].restoredFrom).toBe(1);
      }));

    it('una versión restaurada no se sustituye con el guardado siguiente: la restauración queda como punto de partida', () =>
      withStore({ coalesceSeconds: 30 }, async (store, clock) => {
        const { p, d } = await diagramOf(store, 'bueno');
        clock.advance(120 * SECOND);
        await store.saveDiagram(p, { id: d, text: 'malo' });
        clock.advance(120 * SECOND);
        await store.restoreVersion(p, d, 1);
        clock.advance(2 * SECOND);
        await store.saveDiagram(p, { id: d, text: 'bueno, corregido' });
        expect(await ids(store, p, d)).toEqual([4, 3, 2, 1]);
        expect(await store.getVersion(p, d, 3)).toMatchObject({ restoredFrom: 1, text: 'bueno' });
      }));

    it('restaurar respeta `ifUpdatedAt`: si alguien guardó en medio, conflicto y no cambia nada', () =>
      withStore({}, async (store, clock) => {
        const { p, d, diagram } = await diagramOf(store, 'bueno');
        clock.advance(120 * SECOND);
        const second = await store.saveDiagram(p, { id: d, text: 'malo', ifUpdatedAt: diagram.updatedAt });
        await rejects(store.restoreVersion(p, d, 1, { ifUpdatedAt: diagram.updatedAt }), 'conflict');
        expect((await store.getDiagram(p, d))?.text).toBe('malo');
        expect(await ids(store, p, d)).toEqual([2, 1]);
        const ok = await store.restoreVersion(p, d, 1, { ifUpdatedAt: second.updatedAt });
        expect(ok.diagram.updatedAt > second.updatedAt).toBe(true);
        expect((await store.getDiagram(p, d))?.text).toBe('bueno');
      }));

    it('restaurar una versión que ya es el documento actual no guarda nada', () =>
      withStore({}, async (store) => {
        const { p, d, diagram } = await diagramOf(store, 'igual');
        const restored = await store.restoreVersion(p, d, 1);
        expect(restored.unchanged).toBe(true);
        expect(restored.version.id).toBe(1);
        expect(restored.diagram.updatedAt).toBe(diagram.updatedAt);
        expect(await ids(store, p, d)).toEqual([1]);
      }));

    it('restaurar: una versión que no existe es not-found y un id que no es un entero positivo es invalid', () =>
      withStore({}, async (store) => {
        const { p, d } = await diagramOf(store);
        await rejects(store.restoreVersion(p, d, 7), 'not-found');
        for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 40]) {
          await rejects(store.restoreVersion(p, d, bad), 'invalid');
          await rejects(store.labelVersion(p, d, bad, 'x'), 'invalid');
          await rejects(store.deleteVersion(p, d, bad), 'invalid');
          await rejects(store.getVersion(p, d, bad), 'invalid');
        }
      }));

    it('un proyecto o un diagrama que no existen dan not-found', () =>
      withStore({}, async (store) => {
        const { p, d } = await diagramOf(store);
        await rejects(store.listVersions('nada', d), 'not-found');
        await rejects(store.listVersions(p, 'nada'), 'not-found');
        await rejects(store.restoreVersion(p, 'nada', 1), 'not-found');
        await rejects(store.labelVersion('nada', d, 1, 'x'), 'not-found');
      }));

    it('cada diagrama tiene su historial, y renombrar el diagrama no lo toca', () =>
      withStore({ coalesceSeconds: 0 }, async (store) => {
        const { p, d } = await diagramOf(store, 'a1');
        const other = await store.saveDiagram(p, { module: 'data', name: 'Ventas', text: 'b1' });
        await store.saveDiagram(p, { id: d, text: 'a2' });
        expect(await ids(store, p, d)).toEqual([2, 1]);
        expect(await ids(store, p, other.id)).toEqual([1]);
        await store.renameDiagram(p, d, 'Visión general');
        expect(await ids(store, p, d)).toEqual([2, 1]);
        expect((await store.getVersion(p, other.id, 1))?.text).toBe('b1');
      }));

    it('borrar el diagrama borra su historial: uno nuevo con el mismo nombre empieza en la versión 1', () =>
      withStore({ coalesceSeconds: 0 }, async (store) => {
        const { p, d } = await diagramOf(store, 'viejo');
        await store.saveDiagram(p, { id: d, text: 'viejo 2' });
        await store.deleteDiagram(p, d);
        await rejects(store.listVersions(p, d), 'not-found');
        const again = await store.saveDiagram(p, { module: 'c4', name: 'Contexto', text: 'nuevo' });
        const versions = await store.listVersions(p, again.id);
        expect(versions.map((v) => v.id)).toEqual([1]);
        expect((await store.getVersion(p, again.id, 1))?.text).toBe('nuevo');
      }));

    it('guarda los documentos tal cual: borradores que no son JSON, saltos de línea, BOM y documentos grandes', () =>
      withStore({ coalesceSeconds: 0 }, async (store) => {
        const { p, d } = await diagramOf(store, '{ "a": ');
        const texts = ['﻿{"bom":true}\r\n', 'línea 1\nlínea 2\r\n\ttab ✓ 日本 𝄞', JSON.stringify({ filas: Array.from({ length: 4000 }, (_, i) => ({ i, v: `línea ${i}\n` })) }, null, 2)];
        for (const text of texts) await store.saveDiagram(p, { id: d, text });
        const found = await store.listVersions(p, d);
        expect(found).toHaveLength(4);
        for (const [i, text] of [...texts].reverse().entries()) {
          const version = await store.getVersion(p, d, found[i].id);
          expect(version?.text).toBe(text);
          expect(version?.hash).toBe(describeContent(text).hash);
          expect(found[i].size).toBe(new TextEncoder().encode(text).length);
        }
        expect((await store.getVersion(p, d, 1))?.text).toBe('{ "a": ');
      }));

    it('el historial cuenta lo que ocupa (punto de enganche de las cuotas)', async () => {
      if (!reportsUsage) return;
      await withStore({ coalesceSeconds: 0 }, async (store) => {
        const { p, d } = await diagramOf(store, 'aaaa');
        await store.saveDiagram(p, { id: d, text: 'bbbbbb' });
        await store.labelVersion(p, d, 2, 'Con nombre');
        expect(await store.versionUsage?.(p)).toEqual({ versions: 2, bytes: 10 });
        await store.deleteVersion(p, d, 2);
        expect(await store.versionUsage?.(p)).toEqual({ versions: 1, bytes: 4 });
        await rejects(store.versionUsage!('nada'), 'not-found');
      });
    });
  });
}
