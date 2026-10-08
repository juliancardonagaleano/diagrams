// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://localhost/?embed=1" }
// Un editor incrustado A MANO, sin `?origin=` (el SDK `createIarkEmbed` siempre lo añade): solo habla con el origen del padre si el
// navegador lo da de forma fiable (`location.ancestorOrigins[0]`, o el origen de `document.referrer` como respaldo). Si no, calla.
// Archivo aparte de useEmbedBridge.test.tsx: el aviso de «origen desconocido» es de una sola vez por módulo cargado.
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDocumentStore } from '../store/documentStore';
import { useEmbedBridge } from './useEmbedBridge';

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

const fromParent = (parentWindow: Window, origin: string, data: unknown = JSON.stringify({ action: 'exit' })) =>
  window.dispatchEvent(new MessageEvent('message', { data, source: parentWindow, origin }));

/** Lo que el navegador dice del padre: `ancestorOrigins` (Chromium, Safari) y `document.referrer`. */
function browserSays({ ancestor, referrer }: { ancestor?: string[]; referrer?: string }) {
  if (ancestor) Object.defineProperty(window.location, 'ancestorOrigins', { value: ancestor, configurable: true });
  Object.defineProperty(document, 'referrer', { value: referrer ?? '', configurable: true });
}

describe('useEmbedBridge sin ?origin=: el origen del padre solo si el navegador lo da de forma fiable', () => {
  beforeEach(() => {
    useDocumentStore.getState().newDocument();
  });
  afterEach(() => {
    delete (window.location as { ancestorOrigins?: unknown }).ancestorOrigins;
    delete (document as { referrer?: unknown }).referrer;
    vi.restoreAllMocks();
  });

  it('usa location.ancestorOrigins[0]: emite a ese origen y solo obedece a ese origen', () => {
    browserSays({ ancestor: ['https://padre.example', 'https://abuelo.example'], referrer: 'https://otro.example/p' });
    const { parentWindow, postMessage } = setupFakeParent();
    render(<Harness />);

    expect(postMessage).toHaveBeenCalled();
    for (const [, targetOrigin] of postMessage.mock.calls) expect(targetOrigin).toBe('https://padre.example');

    postMessage.mockClear();
    fromParent(parentWindow, 'https://otro.example'); // ni el referrer ni el abuelo son el padre
    fromParent(parentWindow, 'https://abuelo.example');
    expect(postMessage).not.toHaveBeenCalled();
    fromParent(parentWindow, 'https://padre.example');
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][1]).toBe('https://padre.example');
  });

  it('sin ancestorOrigins (Firefox) usa el origen de document.referrer', () => {
    browserSays({ referrer: 'https://padre.example/pagina/con/ruta?x=1' });
    const { parentWindow, postMessage } = setupFakeParent();
    render(<Harness />);

    for (const [, targetOrigin] of postMessage.mock.calls) expect(targetOrigin).toBe('https://padre.example');
    postMessage.mockClear();
    fromParent(parentWindow, 'https://padre.example');
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('sin ninguna forma fiable NO emite con "*" ni obedece, y avisa una sola vez en la consola', () => {
    browserSays({ ancestor: ['null'], referrer: '' }); // p. ej. un padre con sandbox (origen opaco) y sin Referer
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { parentWindow, postMessage } = setupFakeParent();
    render(<Harness />);

    expect(postMessage).not.toHaveBeenCalled(); // ni `init`
    for (const origin of ['null', '', 'https://cualquiera.example']) fromParent(parentWindow, origin);
    fromParent(parentWindow, 'https://cualquiera.example', '{"action": "export", roto'); // ni siquiera responde con error
    expect(postMessage).not.toHaveBeenCalled();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/origen del anfitrión.*\?origin=/);
  });

  it('un ?origin= inservible ("*") no se toma tal cual: se cae al origen fiable del navegador', () => {
    window.history.replaceState(null, '', '/?embed=1&origin=*');
    browserSays({ ancestor: ['https://padre.example'] });
    const { postMessage } = setupFakeParent();
    render(<Harness />);

    expect(postMessage).toHaveBeenCalled();
    for (const [, targetOrigin] of postMessage.mock.calls) expect(targetOrigin).toBe('https://padre.example');
    window.history.replaceState(null, '', '/?embed=1');
  });
});
