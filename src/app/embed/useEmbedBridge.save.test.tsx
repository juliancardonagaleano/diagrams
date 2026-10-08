// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://localhost/?embed=1&origin=https%3A%2F%2Fhost.example" }
// Mismo montaje que useEmbedBridge.test.tsx: `isEmbedMode` se calcula al cargar el módulo, así que la URL de jsdom trae `?embed=1`,
// y `origin` es el del anfitrión (sin él el editor no emite ni obedece).
import { act, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDocumentStore } from '../store/documentStore';
import { useEmbedBridge } from './useEmbedBridge';

// El autolayout de la acción `save` (`autoLayoutDocument`) se retiene hasta que la prueba lo suelta: así se puede editar el
// documento mientras el guardado espera a ELK, que es la ventana del fallo (mismo estilo que useActions.exportDrawio.test.tsx).
const gate = vi.hoisted(() => ({ hold: undefined as Promise<void> | undefined }));
vi.mock('@core/layout/elkLayout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/layout/elkLayout')>();
  return {
    ...actual,
    autoLayoutDocument: async (...args: Parameters<typeof actual.autoLayoutDocument>) => {
      await gate.hold;
      return actual.autoLayoutDocument(...args);
    },
  };
});

const store = useDocumentStore;

interface SaveEvent {
  event: 'save';
  document: { workspace: { name: string } };
  drawio?: string;
  exit?: boolean;
}
interface ExitEvent {
  event: 'exit';
  modified: boolean;
}

// jsdom no simula un iframe real: se sustituye `window.parent` por un objeto con su propio `postMessage` (como en useEmbedBridge.test.tsx).
function setupFakeParent() {
  const postMessage = vi.fn();
  const parentWindow = { postMessage } as unknown as Window;
  Object.defineProperty(window, 'parent', { value: parentWindow, configurable: true });
  const events = () => postMessage.mock.calls.map(([data]) => (typeof data === 'string' ? JSON.parse(data) : data)) as Array<{ event: string }>;
  return { parentWindow, events };
}

beforeEach(() => {
  store.getState().newDocument();
  store.getState().setWorkspaceName('Original'); // un documento con edición pendiente: lo habitual cuando el anfitrión pide guardar
  expect(store.getState().modified).toBe(true);
});
afterEach(() => {
  gate.hold = undefined;
});

/** Pide guardar con el autolayout retenido; `release()` lo suelta y `done` espera a que el guardado termine. */
function startSave(exit: boolean) {
  let release: () => void = () => undefined;
  gate.hold = new Promise<void>((resolve) => (release = resolve));
  const { events } = setupFakeParent();
  const { result } = renderHook(() => useEmbedBridge());
  let done: Promise<void> = Promise.resolve();
  act(() => {
    done = result.current.save(exit);
  });
  return { release, events, done: () => act(async () => done) };
}

describe('acción «save» del anfitrión: la marca «Cambios sin guardar» (espera a ELK)', () => {
  // `save` tomaba `doc` antes del `await` del autolayout (publica ESE documento) y después llamaba a `markSaved()` sin mirar el
  // store: una edición hecha en la espera quedaba sin publicar pero con «Cambios sin guardar» apagado.
  it('sin edición en la espera: se publica el documento y «Cambios sin guardar» se apaga', async () => {
    const { release, events, done } = startSave(false);
    expect(store.getState().modified).toBe(true); // sigue encendida mientras espera
    release();
    await done();

    const saves = events().filter((e) => e.event === 'save') as unknown as SaveEvent[];
    expect(saves).toHaveLength(1);
    expect(saves[0]!.document.workspace.name).toBe('Original');
    expect(typeof saves[0]!.drawio).toBe('string');
    expect(store.getState().modified).toBe(false);
    expect(store.getState().lastSavedAt).not.toBeNull();
  }, 60000);

  it('una edición hecha durante la espera deja «Cambios sin guardar» encendido, y lo publicado es el documento de antes', async () => {
    const { release, events, done } = startSave(false);
    act(() => store.getState().setWorkspaceName('Editado en la espera'));
    release();
    await done();

    const saves = events().filter((e) => e.event === 'save') as unknown as SaveEvent[];
    expect(saves).toHaveLength(1);
    expect(saves[0]!.document.workspace.name).toBe('Original'); // lo publicado es el documento de antes de la edición
    expect(store.getState().doc.workspace.name).toBe('Editado en la espera'); // y la edición no se revierte
    expect(store.getState().modified).toBe(true); // sigue sin guardar
  }, 60000);

  it('una edición en la espera sobre un documento ya guardado también lo marca como modificado', async () => {
    store.getState().markSaved();
    expect(store.getState().modified).toBe(false);
    const { release, done } = startSave(false);
    act(() => store.getState().setWorkspaceName('Editado en la espera'));
    expect(store.getState().modified).toBe(true);
    release();
    await done();

    expect(store.getState().modified).toBe(true);
  }, 60000);

  it('con exit: sin edición en la espera avisa de la salida sin cambios pendientes', async () => {
    const { release, events, done } = startSave(true);
    release();
    await done();

    const exits = events().filter((e) => e.event === 'exit') as unknown as ExitEvent[];
    expect(exits).toEqual([{ event: 'exit', modified: false }]);
    expect(store.getState().modified).toBe(false);
  }, 60000);

  it('con exit: una edición durante la espera no se declara guardada en el evento «exit»', async () => {
    const { release, events, done } = startSave(true);
    act(() => store.getState().setWorkspaceName('Editado en la espera'));
    release();
    await done();

    const exits = events().filter((e) => e.event === 'exit') as unknown as ExitEvent[];
    expect(exits).toEqual([{ event: 'exit', modified: true }]);
    expect(store.getState().modified).toBe(true);
  }, 60000);

  it('por mensaje del anfitrión ({"action":"save"}) se comporta igual: la edición de la espera no se declara guardada', async () => {
    let release: () => void = () => undefined;
    gate.hold = new Promise<void>((resolve) => (release = resolve));
    const { parentWindow, events } = setupFakeParent();
    function Harness() {
      useEmbedBridge();
      return null;
    }
    render(<Harness />);

    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ action: 'save' }), source: parentWindow, origin: 'https://host.example' }));
    });
    act(() => store.getState().setWorkspaceName('Editado en la espera'));
    release();
    await vi.waitFor(() => expect(events().some((e) => e.event === 'save')).toBe(true), { timeout: 30000 });

    expect(store.getState().modified).toBe(true);
    const save = events().find((e) => e.event === 'save') as unknown as SaveEvent;
    expect(save.document.workspace.name).toBe('Original');
  }, 60000);
});
