// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createIarkModuleEmbed } from './iark-module-embed';
import { MODULE_PROTOCOL_VERSION, parseModuleAction, type SuiteCapabilitiesInfo } from './moduleProtocol';

const capabilities: SuiteCapabilitiesInfo = { protocol: MODULE_PROTOCOL_VERSION, suite: 'DIAgrams', available: ['data', 'security'], modules: [] };

function fromIframe(iframe: HTMLIFrameElement, data: unknown, origin = 'http://localhost') {
  window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data), source: iframe.contentWindow, origin }));
}

function setup(options: Partial<Parameters<typeof createIarkModuleEmbed>[0]> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const embed = createIarkModuleEmbed({ container, url: 'http://localhost/app/modulos.html', ...options });
  const post = vi.spyOn(embed.iframe.contentWindow!, 'postMessage');
  const sent = (index: number) => JSON.parse(post.mock.calls[index][0] as string);
  return { embed, post, sent, container };
}

describe('createIarkModuleEmbed (SDK de anfitrión de módulos)', () => {
  it('el idioma del anfitrión viaja como ?lang= en la dirección del iframe, y sin él no se añade', () => {
    const con = setup({ module: 'security', lang: 'en' });
    expect(new URL(con.embed.iframe.src).searchParams.get('lang')).toBe('en');
    const sin = setup({ module: 'security' });
    expect(new URL(sin.embed.iframe.src).searchParams.has('lang')).toBe(false);
  });

  it('crea el iframe con los parámetros de embebido y el módulo, y responde al init con load', async () => {
    const onInit = vi.fn();
    const onLoad = vi.fn();
    const { embed, post, sent, container } = setup({ module: 'security', document: { version: '1.0' }, autosave: true, theme: 'dark', ui: 'min', onInit, onLoad });
    const url = new URL(embed.iframe.src);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ embed: '1', proto: 'json', module: 'security', theme: 'dark', ui: 'min', origin: window.location.origin });

    fromIframe(embed.iframe, { event: 'init', version: '1.0', module: 'security', capabilities });
    expect(onInit).toHaveBeenCalledWith(capabilities);
    await expect(embed.initialized).resolves.toEqual(capabilities);
    expect(post).toHaveBeenCalledTimes(1);
    expect(sent(0)).toMatchObject({ action: 'load', module: 'security', document: { version: '1.0' }, autosave: true, theme: 'dark' });
    expect(post.mock.calls[0][1]).toBe('http://localhost');

    fromIframe(embed.iframe, { event: 'load', module: 'security', document: { version: '1.0' }, issues: [] });
    await embed.ready;
    expect(onLoad).toHaveBeenCalledWith({ module: 'security', document: { version: '1.0' }, viewId: undefined, issues: [], warnings: undefined });
    embed.destroy();
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('rechaza una URL que no sea http(s) sin crear el iframe (javascript:, data:…) y acepta las relativas', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    for (const url of ['javascript:alert(document.domain)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>', 'blob:http://localhost/x', 'file:///etc/passwd']) {
      expect(() => createIarkModuleEmbed({ container, url }), url).toThrow(/La URL del módulo embebido .* solo se admiten URL http: y https:/);
    }
    expect(container.querySelector('iframe')).toBeNull();
    const relative = createIarkModuleEmbed({ container, url: 'modulos.html?module=data' });
    expect(new URL(relative.iframe.src).pathname).toBe('/modulos.html');
    const absolute = createIarkModuleEmbed({ container, url: 'https://otra.example/w/modulos.html' });
    expect(new URL(absolute.iframe.src).origin).toBe('https://otra.example');
    relative.destroy();
    absolute.destroy();
  });

  it('sin módulo en las opciones, no carga nada por su cuenta hasta que el anfitrión llame a load', async () => {
    const { embed, post, sent } = setup();
    fromIframe(embed.iframe, { event: 'init', version: '1.0', capabilities });
    expect(post).not.toHaveBeenCalled();
    const loading = embed.load({ version: '1.0' }, { module: 'data' });
    expect(sent(0)).toMatchObject({ action: 'load', module: 'data', document: { version: '1.0' } });
    fromIframe(embed.iframe, { event: 'load', module: 'data', document: { version: '1.0' }, issues: [] });
    await expect(loading).resolves.toMatchObject({ module: 'data' });
    embed.destroy();
  });

  it('las acciones anteriores al init esperan y salen después de la carga inicial', () => {
    const { embed, post, sent } = setup({ module: 'security' });
    embed.setView('dfd');
    embed.status('Hola');
    expect(post).not.toHaveBeenCalled();
    fromIframe(embed.iframe, { event: 'init', version: '1.0', capabilities });
    expect(post).toHaveBeenCalledTimes(3);
    expect(sent(0).action).toBe('load');
    expect(sent(1)).toEqual({ action: 'setView', viewId: 'dfd' });
    expect(sent(2)).toMatchObject({ action: 'status', message: 'Hola' });
    embed.destroy();
  });

  it('correlaciona export, validate, run y capabilities por requestId', async () => {
    const { embed, sent } = setup({ module: 'security' });
    fromIframe(embed.iframe, { event: 'init', version: '1.0', capabilities });

    const exported = embed.export('svg', 'blast:pedidos');
    expect(sent(1)).toMatchObject({ action: 'export', format: 'svg', viewId: 'blast:pedidos' });
    fromIframe(embed.iframe, { event: 'export', module: 'security', format: 'svg', data: '<svg/>', mime: 'image/svg+xml', extension: '.svg', requestId: sent(1).requestId });
    await expect(exported).resolves.toBe('<svg/>');

    const validated = embed.validate();
    fromIframe(embed.iframe, { event: 'issues', module: 'security', valid: true, schemaIssues: [], issues: [], requestId: sent(2).requestId });
    await expect(validated).resolves.toEqual({ module: 'security', valid: true, schemaIssues: [], issues: [] });

    const ran = embed.run('risks', { options: { status: 'open' } });
    expect(sent(3)).toMatchObject({ action: 'run', command: 'risks', options: { status: 'open' } });
    fromIframe(embed.iframe, { event: 'result', module: 'security', command: 'risks', kind: 'report', output: '| Riesgo |', warnings: [], requestId: sent(3).requestId });
    await expect(ran).resolves.toEqual({ module: 'security', command: 'risks', kind: 'report', output: '| Riesgo |', warnings: [] });

    const caps = embed.capabilities(['data']);
    expect(sent(4)).toMatchObject({ action: 'capabilities', modules: ['data'] });
    fromIframe(embed.iframe, { event: 'capabilities', capabilities, requestId: sent(4).requestId });
    await expect(caps).resolves.toEqual(capabilities);
    embed.destroy();
  });

  it('un error con requestId rechaza esa petición; sin requestId rechaza la carga pendiente', async () => {
    const onError = vi.fn();
    const { embed, sent } = setup({ module: 'security', onError });
    fromIframe(embed.iframe, { event: 'init', version: '1.0', capabilities });
    const failing = embed.export('pdf');
    fromIframe(embed.iframe, { event: 'error', message: 'no exporta a «pdf»', requestId: sent(1).requestId });
    await expect(failing).rejects.toThrow('no exporta');

    const loading = embed.load({ roto: true });
    fromIframe(embed.iframe, { event: 'error', message: 'Documento inválido', issues: [{ path: 'zones', message: 'x' }] });
    await expect(loading).rejects.toThrow('Documento inválido');
    expect(onError).toHaveBeenLastCalledWith({ message: 'Documento inválido', issues: [{ path: 'zones', message: 'x' }] });
    embed.destroy();
  });

  it('rechaza por tiempo si el módulo no responde y limpia la petición', async () => {
    const { embed } = setup({ module: 'security', responseTimeout: 20 });
    fromIframe(embed.iframe, { event: 'init', version: '1.0', capabilities });
    await expect(embed.export('svg')).rejects.toThrow(/no respondió en 20ms/);
    embed.destroy();
  });

  it('reenvía los eventos de la persona: change, viewChange, save, exit', () => {
    const onChange = vi.fn();
    const onViewChange = vi.fn();
    const onSave = vi.fn();
    const onExit = vi.fn();
    const { embed } = setup({ module: 'security', onChange, onViewChange, onSave, onExit });
    fromIframe(embed.iframe, { event: 'init', version: '1.0', capabilities });
    fromIframe(embed.iframe, { event: 'change', module: 'security', document: { a: 1 }, issues: [] });
    fromIframe(embed.iframe, { event: 'autosave', module: 'security', document: { a: 2 }, issues: [] });
    fromIframe(embed.iframe, { event: 'viewChange', module: 'security', viewId: 'threats', title: 'Amenazas' });
    fromIframe(embed.iframe, { event: 'save', module: 'security', document: { a: 2 }, exit: true });
    fromIframe(embed.iframe, { event: 'exit', modified: false });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onViewChange).toHaveBeenCalledWith({ module: 'security', viewId: 'threats', title: 'Amenazas' });
    expect(onSave).toHaveBeenCalledWith({ module: 'security', document: { a: 2 }, exit: true });
    expect(onExit).toHaveBeenCalledWith({ modified: false });
    embed.destroy();
  });

  it('ignora mensajes de otros orígenes o fuentes, y avisa del JSON roto dirigido al protocolo', () => {
    const onEvent = vi.fn();
    const onError = vi.fn();
    const { embed } = setup({ onEvent, onError });
    window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ event: 'init' }), source: window, origin: 'http://localhost' }));
    fromIframe(embed.iframe, { event: 'init', version: '1.0', capabilities }, 'https://evil.example');
    expect(onEvent).not.toHaveBeenCalled();
    window.dispatchEvent(new MessageEvent('message', { data: '{"event": "load", roto', source: embed.iframe.contentWindow, origin: 'http://localhost' }));
    expect(onError).toHaveBeenCalledOnce();
    window.dispatchEvent(new MessageEvent('message', { data: 'hola', source: embed.iframe.contentWindow, origin: 'http://localhost' }));
    expect(onError).toHaveBeenCalledOnce();
    embed.destroy();
  });
});

describe('protocolo de módulos (acciones del anfitrión)', () => {
  it('valida cada acción y explica los errores', () => {
    expect(parseModuleAction({ action: 'load', module: 'data', document: { version: '1.0' } })).toMatchObject({ ok: true });
    expect(parseModuleAction(JSON.stringify({ action: 'export', format: 'svg', viewId: 'dfd', requestId: 'r' }))).toMatchObject({ ok: true });
    expect(parseModuleAction({ action: 'run', command: 'risks', options: { status: 'open', gaps: true }, args: ['x'] })).toMatchObject({ ok: true });
    expect(parseModuleAction({ action: 'configure', theme: 'dark', ui: 'min' })).toMatchObject({ ok: true });
    expect(parseModuleAction({ action: 'load', theme: 'azul' })).toMatchObject({ ok: false });
    expect(parseModuleAction({ action: 'export' })).toMatchObject({ ok: false, error: expect.stringContaining('format') });
    expect(parseModuleAction({ action: 'inventada' })).toMatchObject({ ok: false });
    expect(parseModuleAction('{ roto')).toEqual({ ok: false, error: 'El mensaje no es JSON válido' });
    expect(parseModuleAction({ sin: 'accion' })).toEqual({ ok: false, error: 'Mensaje sin campo "action"' });
    // los campos que solo conoce el editor C4 (merge, autoLayout…) no existen en los módulos
    expect(parseModuleAction({ action: 'merge', document: {} }).ok).toBe(false);
  });
});
