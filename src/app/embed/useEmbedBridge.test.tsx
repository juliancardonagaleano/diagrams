// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://localhost/?embed=1&origin=https%3A%2F%2Fhost.example" }
// `isEmbedMode` (documentStore.ts) se calcula una vez a partir de `window.location.search` al
// cargar el módulo, así que la URL de jsdom para este archivo debe traer `?embed=1` desde el
// principio (por eso el pragma de arriba, no un `Object.defineProperty` posterior). `origin` es el
// del anfitrión, que el SDK siempre añade; el origen deducido sin él se prueba en useEmbedBridge.origin.test.tsx.
import '@testing-library/jest-dom/vitest';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDocumentStore } from '../store/documentStore';
import { useEmbedBridge } from './useEmbedBridge';

const HOST = 'https://host.example';

function Harness() {
  useEmbedBridge();
  return null;
}

// jsdom no simula un iframe real: `window.parent === window` por defecto, así que `post()` del
// bridge (que exige `window.parent !== window`) no-opearía siempre. Se sustituye `window.parent`
// por un objeto distinto con su propio `postMessage`, y los mensajes "del anfitrión" se despachan
// con ese objeto como `source`, tal como haría un iframe real recibiendo de su padre.
function setupFakeParent() {
  const postMessage = vi.fn();
  const parentWindow = { postMessage } as unknown as Window;
  Object.defineProperty(window, 'parent', { value: parentWindow, configurable: true });
  return { parentWindow, postMessage };
}

function postedEvents(postMessage: ReturnType<typeof vi.fn>): unknown[] {
  return postMessage.mock.calls.map(([data]) => (typeof data === 'string' ? JSON.parse(data) : data));
}

/** Un mensaje del anfitrión: con su ventana como `source` y, por omisión, desde el origen que declaró. */
function fromHost(parentWindow: Window, data: unknown, origin = HOST) {
  window.dispatchEvent(new MessageEvent('message', { data, source: parentWindow, origin }));
}

describe('useEmbedBridge (lado iframe)', () => {
  beforeEach(() => {
    useDocumentStore.getState().newDocument();
  });

  it('un mensaje del anfitrión con JSON roto (string que empieza por "{") emite un evento de error', () => {
    const { parentWindow, postMessage } = setupFakeParent();
    render(<Harness />);
    postMessage.mockClear(); // descarta init/configure del montaje

    fromHost(parentWindow, '{"action": "export", roto');

    const events = postedEvents(postMessage);
    expect(events.some((e) => (e as { event?: string }).event === 'error')).toBe(true);
  });

  it('un mensaje ajeno al protocolo (no parece JSON) se ignora en silencio', () => {
    const { parentWindow, postMessage } = setupFakeParent();
    render(<Harness />);
    postMessage.mockClear();

    fromHost(parentWindow, 'ping');
    fromHost(parentWindow, 42);

    expect(postMessage).not.toHaveBeenCalled();
  });

  it('pedir autoLayout antes de "load" responde con un error explícito, no en silencio', () => {
    const { parentWindow, postMessage } = setupFakeParent();
    render(<Harness />);
    postMessage.mockClear();
    useDocumentStore.setState({ activeViewId: null });

    fromHost(parentWindow, JSON.stringify({ action: 'autoLayout' }));

    const events = postedEvents(postMessage);
    const error = events.find((e) => (e as { event?: string }).event === 'error') as { message?: string } | undefined;
    expect(error?.message).toMatch(/no hay ninguna vista activa/i);
  });

  describe('origen del anfitrión declarado con ?origin=', () => {
    it('todo lo que emite va dirigido a ese origen, nunca a "*"', () => {
      const { parentWindow, postMessage } = setupFakeParent();
      render(<Harness />);

      expect(postedEvents(postMessage)).toContainEqual({ event: 'init', version: expect.any(String) });
      fromHost(parentWindow, JSON.stringify({ action: 'status', message: 'x' })); // una orden cualquiera que no responde
      fromHost(parentWindow, JSON.stringify({ action: 'exit' })); // y otra que sí: emite `exit`
      expect(postMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
      for (const [, targetOrigin] of postMessage.mock.calls) expect(targetOrigin).toBe(HOST);
    });

    it('una orden de otro origen se ignora aunque venga de la ventana padre, sin responder ni error', () => {
      const { parentWindow, postMessage } = setupFakeParent();
      render(<Harness />);
      postMessage.mockClear();

      for (const origin of ['https://evil.example', 'http://host.example', 'https://host.example:8443', '']) {
        fromHost(parentWindow, JSON.stringify({ action: 'exit' }), origin);
        fromHost(parentWindow, '{"action": "export", roto', origin); // ni siquiera un error por mensaje roto: no es de nuestro anfitrión
      }

      expect(postMessage).not.toHaveBeenCalled();
    });

    it('una orden que no viene de la ventana padre se ignora aunque lleve el origen correcto', () => {
      const { postMessage } = setupFakeParent();
      render(<Harness />);
      postMessage.mockClear();

      window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ action: 'exit' }), source: window, origin: HOST }));

      expect(postMessage).not.toHaveBeenCalled();
    });

    it('la orden del anfitrión legítimo sí se obedece', () => {
      const { parentWindow, postMessage } = setupFakeParent();
      render(<Harness />);
      postMessage.mockClear();

      fromHost(parentWindow, JSON.stringify({ action: 'exit' }));

      expect(postedEvents(postMessage)).toEqual([{ event: 'exit', modified: expect.any(Boolean) }]);
    });
  });
});
