// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpProjectStore } from '@iark/kernel';
import { NewerVersionNotice } from './NewerVersionNotice';
import { ProjectSession } from './session';
import { fakeServer } from './testing';

/**
 * El aviso «hay una versión más nueva» contra el servidor simulado con canal de eventos: se anuncia en una región de estado cortés que está siempre en la página,
 * ofrece cargar la nueva o ignorarla con el teclado, no hace nada solo, y no se dibuja con un almacén de este navegador.
 */
const BASE = 'http://localhost:8787';

async function setup() {
  const server = fakeServer();
  server.events.supported = true;
  const client = new HttpProjectStore({ baseUrl: BASE, fetch: server.fetch });
  const other = new HttpProjectStore({ baseUrl: BASE, fetch: server.fetch });
  const session = new ProjectSession(client, { debounceMs: 20, broadcast: false, pollMs: 0, offline: false });
  await session.init();
  const project = await session.createProject('Tienda');
  const meta = await session.createDiagram({ module: 'c4', name: 'Contexto', text: 'v0' });
  const load = vi.fn(async () => {
    await session.loadNewer();
  });
  const notify = vi.fn();
  const view = render(<NewerVersionNotice session={session} load={load} notify={notify} />);
  const saveElsewhere = async (text: string, by = '@beto'): Promise<void> => {
    const saved = await other.saveDiagram(project.id, { id: meta.id, text });
    await act(async () => {
      server.events.emit({ type: 'diagram.saved', project: project.id, diagram: meta.id, updatedAt: saved.updatedAt, by });
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
  };
  return { server, session, project, meta, load, notify, saveElsewhere, view };
}

afterEach(cleanup);

describe('NewerVersionNotice', () => {
  it('la región de estado cortés está siempre en la página, vacía mientras no hay nada, y sin botones', async () => {
    const { session } = await setup();
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toBeEmptyDOMElement();
    expect(screen.queryByRole('button')).toBeNull();
    session.dispose();
  });

  it('cuando otra persona guarda, dice quién y de qué diagrama en la misma región, con los dos botones', async () => {
    const { session, saveElsewhere } = await setup();
    const region = screen.getByRole('status');
    await saveElsewhere('de beto');
    expect(screen.getByRole('status')).toBe(region); // la misma región: así el lector de pantalla anuncia el cambio de texto
    expect(region).toHaveTextContent('@beto guardó una versión más nueva de «Contexto».');
    expect(screen.getByRole('button', { name: 'Cargar la nueva' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Ignorar el aviso de versión más nueva' })).toBeEnabled();
    session.dispose();
  });

  it('sin saber quién (un servidor sin autenticación) lo dice sin nombre', async () => {
    const { session, server, project, meta } = await setup();
    const other = new HttpProjectStore({ baseUrl: BASE, fetch: server.fetch });
    const saved = await other.saveDiagram(project.id, { id: meta.id, text: 'x' });
    await act(async () => {
      server.events.emit({ type: 'diagram.saved', project: project.id, diagram: meta.id, updatedAt: saved.updatedAt });
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(screen.getByRole('status')).toHaveTextContent('Se guardó una versión más nueva de «Contexto».');
    session.dispose();
  });

  it('«Cargar la nueva» se alcanza con el teclado, carga, anuncia el resultado y deja el foco en la región (el botón desaparece)', async () => {
    const { session, saveElsewhere, load } = await setup();
    await saveElsewhere('de beto');
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Cargar la nueva' })).toHaveFocus(); // el primer elemento enfocable, en orden de lectura
    await user.keyboard('{Enter}');
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Se cargó la versión nueva de «Contexto».'));
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('status')).toHaveFocus();
    expect(session.getState().newer).toBeUndefined();
    session.dispose();
  });

  it('«Ignorar» quita el aviso sin cargar nada', async () => {
    const { session, saveElsewhere, load } = await setup();
    await saveElsewhere('de beto');
    await userEvent.click(screen.getByRole('button', { name: 'Ignorar el aviso de versión más nueva' }));
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(load).not.toHaveBeenCalled();
    session.dispose();
  });

  it('si al cargar ya hay algo pendiente aquí, lo cuenta sin perderlo y deja el botón con el foco', async () => {
    const { session, saveElsewhere, notify, load } = await setup();
    await saveElsewhere('de beto');
    load.mockImplementationOnce(async () => {
      throw new Error('Hay cambios tuyos sin guardar');
    });
    await userEvent.click(screen.getByRole('button', { name: 'Cargar la nueva' }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Hay cambios tuyos sin guardar'));
    expect(screen.getByRole('status')).toHaveTextContent('versión más nueva'); // el aviso sigue
    expect(screen.getByRole('button', { name: 'Cargar la nueva' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cargar la nueva' })).toHaveFocus();
    session.dispose();
  });

  it('con cambios propios sin guardar el aviso ni sale (manda el conflicto de siempre)', async () => {
    const { session, saveElsewhere } = await setup();
    session.queueSave('lo que escribo'); // sin esperar a que se guarde
    await saveElsewhere('de beto');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(screen.queryByRole('button')).toBeNull();
    session.dispose();
  });

  it('no dibuja nada con un almacén de este navegador', async () => {
    const { MemoryProjectStore } = await import('@iark/kernel');
    const local = new ProjectSession(new MemoryProjectStore(), { broadcast: false, persist: false });
    await local.init();
    cleanup();
    const { container } = render(<NewerVersionNotice session={local} load={async () => undefined} notify={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
    local.dispose();
  });
});
