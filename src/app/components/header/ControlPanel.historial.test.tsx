// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReactFlowProvider } from '@xyflow/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleDocument } from '@core/model/sample';
import { MemoryProjectStore } from '@iark/kernel';
import { saveBackend } from '../../../projects/backend';
import { HistoryDialog } from '../../../projects/HistoryDialog';
import { fakeServer, type FakeServer } from '../../../projects/testing';
import { MODULE_SOURCES } from '../../../modules-app/modules';
import { useDocumentStore } from '../../store/documentStore';
import { resetProjectSession, useProjectBinding } from '../../projects/useProjectBinding';
import { ControlPanel } from './ControlPanel';

/** «Historial…» en el encabezado del editor C4: con un diagrama abierto en un almacén que guarda versiones; restaurar carga la versión en el editor. */
const URL_ = 'http://localhost:8787';
const doc = (name: string) => JSON.stringify({ ...structuredClone(sampleDocument), workspace: { ...sampleDocument.workspace, name } }, null, 2);

function Host() {
  const binding = useProjectBinding();
  const [show, setShow] = useState(false);
  const session = binding.session;
  return (
    <ReactFlowProvider>
      <ControlPanel projects={{ binding, onManage: () => undefined, onHistory: () => setShow(true) }} />
      {show && session?.attached && session.diagram && session.project && (
        <HistoryDialog
          session={session}
          projectId={session.project.id}
          diagram={session.diagram}
          loadModule={async (id) => MODULE_SOURCES.find((s) => s.id === id)!.load()}
          onRestore={binding.restoreVersion}
          onClose={() => setShow(false)}
          notify={() => undefined}
        />
      )}
    </ReactFlowProvider>
  );
}

async function seed(server: FakeServer) {
  const project = await server.store.createProject({ name: 'Banca' });
  const meta = await server.store.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text: doc('Banca A') });
  await server.store.saveDiagram(project.id, { id: meta.id, text: doc('Banca B') });
  localStorage.setItem(`iark.projects.last:${URL_}`, JSON.stringify({ projectId: project.id, diagramId: meta.id }));
  return { project, meta };
}

describe('encabezado del editor C4: historial de versiones', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    resetProjectSession();
    useDocumentStore.getState().newDocument();
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, onchange: null, dispatchEvent: () => false }));
  });
  afterEach(() => {
    cleanup();
    resetProjectSession();
    vi.unstubAllGlobals();
  });

  it('con un diagrama abierto se ofrece «Historial…»; sin diagrama (borrador) no', async () => {
    const server = fakeServer({ store: new MemoryProjectStore(undefined, { versions: { coalesceSeconds: 0 } }) });
    saveBackend({ url: URL_ });
    vi.stubGlobal('fetch', server.fetch);
    render(<Host />);
    await screen.findByTestId('project-chip');
    expect(screen.queryByTestId('history-open')).toBeNull();
  });

  it('restaurar desde el cuadro carga la versión en el editor (queda como versión nueva)', async () => {
    const store = new MemoryProjectStore(undefined, { versions: { coalesceSeconds: 0 } });
    const server = fakeServer({ store });
    const { project, meta } = await seed(server);
    saveBackend({ url: URL_ });
    vi.stubGlobal('fetch', server.fetch);
    render(<Host />);
    await waitFor(() => expect(useDocumentStore.getState().doc.workspace.name).toBe('Banca B'));
    await userEvent.click(await screen.findByTestId('history-open'));
    await screen.findByRole('dialog', { name: 'Historial de versiones' });
    await userEvent.click((await screen.findAllByTestId('history-item')).find((el) => el.getAttribute('data-version') === '1')!);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restaurar esta versión' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Restaurar esta versión' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sí, restaurar' }));
    await waitFor(() => expect(useDocumentStore.getState().doc.workspace.name).toBe('Banca A'));
    expect((await store.listVersions(project.id, meta.id))[0].id).toBe(3);
    expect(JSON.parse((await server.store.getDiagram(project.id, meta.id))!.text).workspace.name).toBe('Banca A');
    await act(async () => undefined);
  });

  it('un servidor sin historial se sabe al pedirlo: el botón se ofrece y el cuadro lo explica', async () => {
    const server = fakeServer({ store: new MemoryProjectStore(undefined, { versions: false }) });
    await seed(server);
    saveBackend({ url: URL_ });
    vi.stubGlobal('fetch', server.fetch);
    render(<Host />);
    await waitFor(() => expect(screen.getByTestId('project-chip')).toHaveTextContent('Banca'));
    await userEvent.click(await screen.findByTestId('history-open'));
    expect(await screen.findByRole('dialog', { name: 'Historial de versiones' })).toHaveTextContent(/no guarda|no ofrece|historial/i);
  });
});
