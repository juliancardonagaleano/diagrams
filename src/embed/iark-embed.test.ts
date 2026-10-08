// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { sampleDocument } from '@core/model/sample';
import { createIarkEmbed } from './iark-embed';

function fromIframe(iframe: HTMLIFrameElement, data: unknown, origin = 'http://localhost') {
  window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data), source: iframe.contentWindow, origin }));
}

describe('createIarkEmbed (SDK de anfitrión)', () => {
  it('crea el iframe con los parámetros de embebido y responde al handshake con load', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const onLoad = vi.fn();
    const embed = createIarkEmbed({ container, url: 'http://localhost/app/', document: sampleDocument, autosave: true, theme: 'dark', onLoad });
    const url = new URL(embed.iframe.src);
    expect(url.searchParams.get('embed')).toBe('1');
    expect(url.searchParams.get('proto')).toBe('json');
    expect(url.searchParams.get('origin')).toBe(window.location.origin);
    expect(url.searchParams.get('theme')).toBe('dark');

    const post = vi.spyOn(embed.iframe.contentWindow!, 'postMessage');
    fromIframe(embed.iframe, { event: 'init', version: '1.0' });
    expect(post).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(post.mock.calls[0][0] as string);
    expect(sent.action).toBe('load');
    expect(sent.autosave).toBe(true);
    expect(sent.document.workspace.name).toBe('Banca en línea');
    expect(post.mock.calls[0][1]).toBe('http://localhost');

    fromIframe(embed.iframe, { event: 'load', document: sampleDocument });
    await embed.ready;
    expect(onLoad).toHaveBeenCalledOnce();
    embed.destroy();
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('rechaza una URL que no sea http(s) sin crear el iframe (javascript:, data:…) y acepta las relativas', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    for (const url of ['javascript:alert(document.domain)', 'data:text/html,<script>alert(1)</script>', 'blob:http://localhost/x', 'file:///etc/passwd']) {
      expect(() => createIarkEmbed({ container, url }), url).toThrow(/solo se admiten URL http: y https:/);
    }
    expect(container.querySelector('iframe')).toBeNull();
    const embed = createIarkEmbed({ container, url: '../editor/' });
    expect(new URL(embed.iframe.src).pathname).toBe('/editor/');
    embed.destroy();
  });

  it('correlaciona export por requestId y rechaza en error', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const embed = createIarkEmbed({ container, url: 'http://localhost/app/' });
    const post = vi.spyOn(embed.iframe.contentWindow!, 'postMessage');
    const promise = embed.export('drawio', 'ctx');
    const sent = JSON.parse(post.mock.calls[0][0] as string);
    expect(sent).toMatchObject({ action: 'export', format: 'drawio', viewId: 'ctx' });
    fromIframe(embed.iframe, { event: 'export', format: 'drawio', data: '<mxfile/>', requestId: sent.requestId });
    await expect(promise).resolves.toBe('<mxfile/>');

    const failing = embed.export('png');
    const sent2 = JSON.parse(post.mock.calls[1][0] as string);
    fromIframe(embed.iframe, { event: 'error', message: 'no soportado', requestId: sent2.requestId });
    await expect(failing).rejects.toThrow('no soportado');
    embed.destroy();
  });

  it('ignora mensajes de otros orígenes o fuentes', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const onEvent = vi.fn();
    const embed = createIarkEmbed({ container, url: 'http://localhost/app/', onEvent });
    window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ event: 'init' }), source: window, origin: 'http://localhost' }));
    fromIframe(embed.iframe, { event: 'init', version: '1.0' }, 'https://evil.example');
    expect(onEvent).not.toHaveBeenCalled();
    embed.destroy();
  });

  it('un mensaje con JSON roto (string que empieza por "{") dispara onError, no se ignora en silencio', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const onError = vi.fn();
    const onEvent = vi.fn();
    const embed = createIarkEmbed({ container, url: 'http://localhost/app/', onError, onEvent });
    window.dispatchEvent(new MessageEvent('message', { data: '{"event": "load", roto', source: embed.iframe.contentWindow, origin: 'http://localhost' }));
    expect(onError).toHaveBeenCalledOnce();
    expect(onEvent).not.toHaveBeenCalled();
    embed.destroy();
  });

  it('un mensaje ajeno al protocolo (no parece JSON) se sigue ignorando en silencio', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const onError = vi.fn();
    const embed = createIarkEmbed({ container, url: 'http://localhost/app/', onError });
    window.dispatchEvent(new MessageEvent('message', { data: 'webpackHotUpdate', source: embed.iframe.contentWindow, origin: 'http://localhost' }));
    window.dispatchEvent(new MessageEvent('message', { data: 42, source: embed.iframe.contentWindow, origin: 'http://localhost' }));
    expect(onError).not.toHaveBeenCalled();
    embed.destroy();
  });

  it('load()/export() rechazan si el iframe nunca responde, en vez de colgarse', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const embed = createIarkEmbed({ container, url: 'http://localhost/app/', responseTimeout: 30 });
    await expect(embed.load(sampleDocument)).rejects.toThrow(/no respondió/);
    await expect(embed.export('drawio')).rejects.toThrow(/no respondió/);
    embed.destroy();
  });
});
