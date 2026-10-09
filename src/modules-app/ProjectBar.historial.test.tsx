// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryProjectStore, pretty } from '@iark/kernel';
import { ProjectSession } from '../projects/session';
import { WorkbenchController, type ModuleSource } from './controller';
import { ProjectBar } from './ProjectBar';
import { FAKE_DOC, fakeModule } from './testing-editor';

/** «Historial…» en la barra del proyecto: solo con un diagrama abierto en un almacén que guarda versiones, y restaurar recarga el editor. */
const DOC = pretty(FAKE_DOC);
const OTHER = pretty({ ...FAKE_DOC, name: 'Pedidos v2' });
const SOURCES: ModuleSource[] = [{ id: 'fake', label: 'Con contratos', load: async () => fakeModule as never, example: async () => DOC }];

async function setup(versions: boolean | undefined, open = true) {
  const store = new MemoryProjectStore(undefined, { versions: versions === false ? false : { coalesceSeconds: 0 } });
  const session = new ProjectSession(store, { broadcast: false, persist: false, debounceMs: 10 });
  await session.init();
  const project = await session.createProject('Tienda');
  const meta = await session.createDiagram({ module: 'fake', name: 'Pedidos', text: DOC });
  const controller = new WorkbenchController(SOURCES, { renderDelay: 0, projects: session });
  if (open) await controller.openDiagram(project.id, meta.id);
  else await session.release(); // un borrador: ningún diagrama del proyecto queda abierto
  render(<ProjectBar controller={controller} state={controller.getState()} onManage={vi.fn()} notify={vi.fn()} />);
  return { session, controller, project, meta, store };
}

describe('barra del proyecto: historial de versiones', () => {
  afterEach(() => cleanup());

  it('con un diagrama abierto en un almacén con versiones se ofrece «Historial…», y abre el cuadro del diagrama', async () => {
    const { session } = await setup(true);
    await userEvent.click(screen.getByRole('button', { name: 'Historial…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Historial de versiones' });
    expect(dialog).toHaveTextContent('Pedidos');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'Historial…' })).toHaveFocus();
    session.dispose();
  });

  it('sin diagrama abierto (borrador) no hay historial que ver', async () => {
    const { session } = await setup(true, false);
    expect(screen.queryByRole('button', { name: 'Historial…' })).toBeNull();
    session.dispose();
  });

  it('un almacén sin historial no lo ofrece, y la barra sigue como siempre', async () => {
    const { session } = await setup(false);
    expect(session.canVersion).toBe(false);
    expect(screen.queryByRole('button', { name: 'Historial…' })).toBeNull();
    expect(screen.getByTestId('save-status')).toHaveTextContent('Guardado en «Tienda»');
    session.dispose();
  });

  it('restaurar una versión desde el cuadro carga su contenido en el editor y lo deja guardado como versión nueva', async () => {
    const { session, controller, project, meta, store } = await setup(true);
    await store.saveDiagram(project.id, { id: meta.id, text: OTHER });
    await session.openDiagram(project.id, meta.id); // la sesión toma lo guardado
    await controller.openDiagram(project.id, meta.id);
    expect(controller.getState().text).toBe(OTHER);
    await userEvent.click(screen.getByRole('button', { name: 'Historial…' }));
    await screen.findByRole('dialog', { name: 'Historial de versiones' });
    await userEvent.click((await screen.findAllByTestId('history-item')).find((el) => el.getAttribute('data-version') === '1')!);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restaurar esta versión' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Restaurar esta versión' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sí, restaurar' }));
    await waitFor(() => expect(controller.getState().text).toBe(DOC));
    const versions = await store.listVersions(project.id, meta.id);
    expect(versions[0].id).toBe(3);
    expect((await store.getDiagram(project.id, meta.id))?.text).toBe(DOC);
    session.dispose();
  });
});
