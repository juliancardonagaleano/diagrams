// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DOC_C4_0_9, instalarMigracionesC4 } from '../../../tests/helpers/migracionC4';
import { sampleDocument } from '@core/model/sample';
import { useDocumentStore } from './documentStore';

/**
 * Lo que el editor C4 guarda en `localStorage` (zustand `persist`, clave `iark-diagrams`) se rehidrata pasando por las
 * migraciones: antes, un `version` guardado distinto del de la app descartaba el diagrama de la persona (no había `migrate`), y
 * un documento de una versión anterior del formato entraba tal cual.
 */
const CLAVE = 'iark-diagrams';

function guardar(state: Record<string, unknown>, version: number): void {
  window.localStorage.setItem(CLAVE, JSON.stringify({ state, version }));
}

let restaurar: (() => void) | undefined;
beforeEach(() => {
  window.localStorage.clear();
  useDocumentStore.getState().loadSample();
});
afterEach(() => {
  restaurar?.();
  restaurar = undefined;
  window.localStorage.clear();
  useDocumentStore.getState().loadSample();
});

describe('persist del editor C4: rehidratar con migraciones', () => {
  const propio = { ...sampleDocument, workspace: { ...sampleDocument.workspace, name: 'Mi diagrama guardado' } };

  it('lo guardado con otra versión de la forma persistida ya no se descarta: se rehidrata', async () => {
    guardar({ doc: propio, activeViewId: null, ui: { theme: 'dark' }, lastSavedAt: 1 }, 0);
    await useDocumentStore.persist.rehydrate();
    const { doc, ui } = useDocumentStore.getState();
    expect(doc.workspace.name).toBe('Mi diagrama guardado');
    expect(ui.theme).toBe('dark');
  });

  it('un documento guardado con una versión anterior del formato se migra al rehidratar, aunque la forma persistida no haya cambiado', async () => {
    restaurar = instalarMigracionesC4();
    guardar({ doc: DOC_C4_0_9, activeViewId: null, ui: { theme: 'light' }, lastSavedAt: 1 }, 1);
    await useDocumentStore.persist.rehydrate();
    const { doc } = useDocumentStore.getState();
    expect(doc.version).toBe('1.0');
    expect(doc.workspace.name).toBe('Banca antigua');
  });

  it('el documento actual se rehidrata tal cual', async () => {
    guardar({ doc: propio, activeViewId: null, ui: {}, lastSavedAt: 1 }, 1);
    await useDocumentStore.persist.rehydrate();
    expect(useDocumentStore.getState().doc).toEqual(propio);
  });
});
