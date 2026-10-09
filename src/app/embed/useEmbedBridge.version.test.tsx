// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://localhost/?embed=1&origin=https%3A%2F%2Fhost.example" }
// Negociación de la versión del protocolo y migración de documentos antiguos en el lado iframe (editor C4). Mismo montaje que
// useEmbedBridge.test.tsx: `isEmbedMode` se calcula al cargar el módulo, así que la URL de jsdom trae `?embed=1&origin=…`.
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOC_C4_0_9, instalarMigracionesC4 } from '../../../tests/helpers/migracionC4';
import { sampleDocument } from '@core/model/sample';
import { PROTOCOL_VERSION } from '../../embed/protocol';
import { useDocumentStore } from '../store/documentStore';
import { useEmbedBridge } from './useEmbedBridge';

const HOST = 'https://host.example';

function Harness() {
  useEmbedBridge();
  return null;
}

function setupFakeParent() {
  const postMessage = vi.fn();
  const parentWindow = { postMessage } as unknown as Window;
  Object.defineProperty(window, 'parent', { value: parentWindow, configurable: true });
  return { parentWindow, postMessage };
}

type Evento = { event: string; code?: string; message?: string; requestId?: string; document?: { version: string; workspace: { name: string } } };
const eventos = (postMessage: ReturnType<typeof vi.fn>): Evento[] =>
  postMessage.mock.calls.map(([data]) => (typeof data === 'string' ? JSON.parse(data) : data)) as Evento[];

const delAnfitrion = (parentWindow: Window, action: Record<string, unknown>) =>
  window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(action), source: parentWindow, origin: HOST }));

let restaurar: (() => void) | undefined;
beforeEach(() => useDocumentStore.getState().newDocument());
afterEach(() => {
  restaurar?.();
  restaurar = undefined;
});

describe('useEmbedBridge: versión del protocolo', () => {
  it('el init que emite el editor lleva la versión de su protocolo', () => {
    const { postMessage } = setupFakeParent();
    render(<Harness />);
    expect(eventos(postMessage)).toContainEqual({ event: 'init', version: PROTOCOL_VERSION });
  });

  it('un load de un anfitrión con protocolo de OTRA versión mayor se rechaza con un error de código incompatible-protocol', async () => {
    const { parentWindow, postMessage } = setupFakeParent();
    render(<Harness />);
    postMessage.mockClear();

    delAnfitrion(parentWindow, { action: 'load', version: '2.0', document: sampleDocument });

    await waitFor(() => expect(eventos(postMessage).length).toBeGreaterThan(0));
    const evs = eventos(postMessage);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ event: 'error', code: 'incompatible-protocol', message: expect.stringMatching(/incompatible.*1\.0.*2\.0/s) });
    expect(evs.some((e) => e.event === 'load')).toBe(false);
  });

  it('mientras el apretón de manos esté rechazado, ninguna orden se aplica (responde el mismo error con su requestId), salvo exit', async () => {
    const { parentWindow, postMessage } = setupFakeParent();
    render(<Harness />);
    delAnfitrion(parentWindow, { action: 'load', version: '2.0' });
    await waitFor(() => expect(eventos(postMessage).some((e) => e.code === 'incompatible-protocol')).toBe(true));
    postMessage.mockClear();

    delAnfitrion(parentWindow, { action: 'export', format: 'json', requestId: 'r1' });
    await waitFor(() => expect(postMessage).toHaveBeenCalled());
    expect(eventos(postMessage)).toEqual([expect.objectContaining({ event: 'error', code: 'incompatible-protocol', requestId: 'r1' })]);

    postMessage.mockClear();
    delAnfitrion(parentWindow, { action: 'exit' });
    await waitFor(() => expect(postMessage).toHaveBeenCalled());
    expect(eventos(postMessage)).toEqual([{ event: 'exit', modified: expect.any(Boolean) }]);
  });

  it('un load posterior compatible reanuda el trabajo', async () => {
    const { parentWindow, postMessage } = setupFakeParent();
    render(<Harness />);
    delAnfitrion(parentWindow, { action: 'load', version: '2.0' });
    await waitFor(() => expect(eventos(postMessage).some((e) => e.code === 'incompatible-protocol')).toBe(true));
    postMessage.mockClear();

    delAnfitrion(parentWindow, { action: 'load', version: '1.0', document: sampleDocument });
    await waitFor(() => expect(eventos(postMessage).some((e) => e.event === 'load')).toBe(true));
  });

  it.each([['una versión menor distinta (1.5)', '1.5'], ['sin versión (un SDK antiguo = 1.0)', undefined]])('un load con %s se acepta', async (_nombre, version) => {
    const { parentWindow, postMessage } = setupFakeParent();
    render(<Harness />);
    postMessage.mockClear();

    delAnfitrion(parentWindow, { action: 'load', ...(version ? { version } : {}), document: sampleDocument });

    await waitFor(() => expect(eventos(postMessage).some((e) => e.event === 'load')).toBe(true));
    expect(eventos(postMessage).some((e) => e.event === 'error')).toBe(false);
  });
});

describe('useEmbedBridge: documentos de una versión anterior del formato', () => {
  it('sin migración declarada, un documento antiguo se rechaza diciendo por qué (en vez de un «Invalid input»)', async () => {
    const { parentWindow, postMessage } = setupFakeParent();
    render(<Harness />);
    postMessage.mockClear();

    delAnfitrion(parentWindow, { action: 'load', document: DOC_C4_0_9 });

    await waitFor(() => expect(eventos(postMessage).length).toBeGreaterThan(0));
    expect(eventos(postMessage)[0]).toMatchObject({ event: 'error', message: expect.stringMatching(/versión 0\.9.*no está soportada/s) });
  });

  it('con la migración declarada, el load migra el documento antes de aplicarlo y el evento load devuelve el actual', async () => {
    restaurar = instalarMigracionesC4();
    const { parentWindow, postMessage } = setupFakeParent();
    render(<Harness />);
    postMessage.mockClear();

    delAnfitrion(parentWindow, { action: 'load', document: DOC_C4_0_9 });

    await waitFor(() => expect(eventos(postMessage).some((e) => e.event === 'load')).toBe(true));
    const cargado = eventos(postMessage).find((e) => e.event === 'load');
    expect(cargado?.document).toMatchObject({ version: '1.0', workspace: { name: 'Banca antigua' } });
    expect(useDocumentStore.getState().doc.workspace.name).toBe('Banca antigua');
  });

  it('también el merge acepta un documento antiguo migrable', async () => {
    restaurar = instalarMigracionesC4();
    const { parentWindow, postMessage } = setupFakeParent();
    render(<Harness />);
    delAnfitrion(parentWindow, { action: 'load', document: sampleDocument });
    await waitFor(() => expect(eventos(postMessage).some((e) => e.event === 'load')).toBe(true));
    postMessage.mockClear();

    delAnfitrion(parentWindow, { action: 'merge', document: DOC_C4_0_9, autoLayout: false });

    // Sin error: un documento antiguo migrable se fusiona como cualquier otro.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(eventos(postMessage).filter((e) => e.event === 'error')).toEqual([]);
  });
});
