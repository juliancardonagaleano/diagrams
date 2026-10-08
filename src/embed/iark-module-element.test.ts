// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import './iark-module-element';
import type { IarkModuleElement } from './iark-module-element';
import type { SuiteCapabilitiesInfo } from './moduleProtocol';

const capabilities: SuiteCapabilitiesInfo = { protocol: '1.0', suite: 'IArk - DIAgrams', available: ['data', 'security'], modules: [] };

// jsdom no crea la ventana de un iframe que vive dentro de un shadow root (sí lo hace Chromium: lo cubre el e2e). Para
// probar el protocolo, el iframe «habla» a través de la propia ventana de jsdom, que sí es un Window válido como `source`.
const original = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow')!;
beforeAll(() => Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', { configurable: true, get: () => window }));
afterAll(() => Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', original));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function create(attributes: Record<string, string>, beforeConnect?: (el: IarkModuleElement) => void): IarkModuleElement {
  const el = document.createElement('iark-module');
  for (const [k, v] of Object.entries(attributes)) el.setAttribute(k, v);
  beforeConnect?.(el);
  document.body.appendChild(el);
  return el;
}

const iframeOf = (el: IarkModuleElement): HTMLIFrameElement | null => el.shadowRoot!.querySelector('iframe');

function fromIframe(iframe: HTMLIFrameElement, data: unknown, origin = 'http://localhost') {
  window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data), source: iframe.contentWindow, origin }));
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('<iark-module>', () => {
  it('se registra y monta el banco de trabajo del atributo src con el módulo y el tema', async () => {
    expect(customElements.get('iark-module')).toBeTruthy();
    const el = create({ src: 'http://localhost/app/modulos.html', module: 'security', theme: 'dark', ui: 'min' });
    await flush();
    const iframe = iframeOf(el)!;
    const url = new URL(iframe.src);
    expect(url.pathname).toBe('/app/modulos.html');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ embed: '1', proto: 'json', module: 'security', theme: 'dark', ui: 'min' });
  });

  it('hace el handshake con el documento de la propiedad y traduce los eventos a eventos DOM', async () => {
    const seen: Array<[string, unknown]> = [];
    const el = create({ src: 'http://localhost/app/modulos.html', module: 'security', autosave: '', readonly: '' }, (element) => {
      element.document = { version: '1.0', workspace: { name: 'Antes de conectar' } };
      for (const name of ['iark-init', 'iark-load', 'iark-change', 'iark-view-change', 'iark-save', 'iark-exit', 'iark-error']) element.addEventListener(name, (e) => seen.push([name, (e as CustomEvent).detail]));
    });
    await flush();
    const iframe = iframeOf(el)!;
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage');

    fromIframe(iframe, { event: 'init', version: '1.0', module: 'security', capabilities });
    const sent = JSON.parse(post.mock.calls[0][0] as string);
    expect(sent).toMatchObject({ action: 'load', module: 'security', autosave: true, readOnly: true, document: { workspace: { name: 'Antes de conectar' } } });

    fromIframe(iframe, { event: 'load', module: 'security', document: { ok: 1 }, viewId: 'dfd', issues: [] });
    fromIframe(iframe, { event: 'change', module: 'security', document: { ok: 2 }, issues: [] });
    fromIframe(iframe, { event: 'viewChange', module: 'security', viewId: 'threats', title: 'Amenazas' });
    fromIframe(iframe, { event: 'save', module: 'security', document: { ok: 2 }, exit: true });
    fromIframe(iframe, { event: 'exit', modified: false });
    fromIframe(iframe, { event: 'error', message: 'algo falló' });
    expect(seen.map(([name]) => name)).toEqual(['iark-init', 'iark-load', 'iark-change', 'iark-view-change', 'iark-save', 'iark-exit', 'iark-error']);
    expect(seen[0][1]).toEqual(capabilities);
    expect(seen[2][1]).toMatchObject({ document: { ok: 2 }, autosave: false });
    expect(seen[3][1]).toEqual({ module: 'security', viewId: 'threats', title: 'Amenazas' });
  });

  it('los métodos esperan al widget y correlacionan las respuestas', async () => {
    const el = create({ src: 'http://localhost/app/modulos.html', module: 'security' });
    const promise = el.export('svg', 'blast:pedidos');
    await flush();
    const iframe = iframeOf(el)!;
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage');
    fromIframe(iframe, { event: 'init', version: '1.0', capabilities });
    const exportAction = JSON.parse(post.mock.calls[1][0] as string);
    expect(exportAction).toMatchObject({ action: 'export', format: 'svg', viewId: 'blast:pedidos' });
    fromIframe(iframe, { event: 'export', module: 'security', format: 'svg', data: '<svg/>', mime: 'image/svg+xml', extension: '.svg', requestId: exportAction.requestId });
    await expect(promise).resolves.toBe('<svg/>');
  });

  it('con manifest descubre el editor del módulo en la instancia (federación)', async () => {
    const manifest = {
      schema: 'iark.manifest/1',
      name: 'Otra instancia',
      version: '1',
      modules: [{ id: 'data', name: 'Datos', version: '1', documentVersion: '1.0', importFormats: [], exportFormats: [], endpoints: { embed: '../modulos.html?module=data' } }],
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(manifest)));
    vi.stubGlobal('fetch', fetchMock);
    const el = create({ manifest: 'https://otra.example/base/.well-known/iark.json', module: 'data' });
    await flush();
    await flush();
    expect(fetchMock).toHaveBeenCalledOnce();
    const url = new URL(iframeOf(el)!.src);
    expect(url.origin + url.pathname).toBe('https://otra.example/base/modulos.html');
    expect(url.searchParams.get('module')).toBe('data');
    expect(url.searchParams.get('origin')).toBe(window.location.origin);
  });

  it('rechaza un editor con esquema peligroso, venga del atributo src o del manifiesto, y no crea ningún iframe', async () => {
    const errors: string[] = [];
    const listen = (el: IarkModuleElement) => el.addEventListener('iark-error', (e) => errors.push((e as CustomEvent).detail.message));

    const direct = create({ src: 'javascript:alert(document.domain)', module: 'data' }, listen);
    await flush();
    expect(errors.at(-1)).toMatch(/atributo "src".*«javascript:»/);
    expect(iframeOf(direct)).toBeNull();
    expect(direct.shadowRoot!.querySelector('.message')!.textContent).toMatch(/solo se admiten URL http: y https:/);

    for (const embed of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>']) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ schema: 'iark.manifest/1', name: 'X', version: '1', modules: [{ id: 'data', name: 'Datos', version: '1', documentVersion: '1', importFormats: [], exportFormats: [], endpoints: { embed } }] }))));
      const federated = create({ manifest: 'https://x.example/.well-known/iark.json', module: 'data' }, listen);
      await flush();
      await flush();
      expect(errors.at(-1), embed).toMatch(/endpoint «embed» del módulo «data».*solo se admiten URL http: y https:/);
      expect(iframeOf(federated)).toBeNull();
    }
  });

  it('explica con un evento y un mensaje visible lo que falta o lo que la instancia no ofrece', async () => {
    const errors: string[] = [];
    const listen = (el: IarkModuleElement) => el.addEventListener('iark-error', (e) => errors.push((e as CustomEvent).detail.message));

    const none = create({}, listen);
    await flush();
    expect(errors.at(-1)).toMatch(/necesita el atributo "src"/);
    expect(none.shadowRoot!.querySelector('.message')!.textContent).toMatch(/src/);

    const noModule = create({ manifest: 'https://x.example/.well-known/iark.json' }, listen);
    await flush();
    expect(errors.at(-1)).toMatch(/necesita el atributo "module"/);
    expect(noModule.isConnected).toBe(true);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ schema: 'iark.manifest/1', name: 'X', version: '1', modules: [{ id: 'data', name: 'Datos', version: '1', documentVersion: '1', importFormats: [], exportFormats: [] }] }))));
    create({ manifest: 'https://x.example/.well-known/iark.json', module: 'security' }, listen);
    await flush();
    await flush();
    expect(errors.at(-1)).toMatch(/no ofrece el módulo «security»\. Módulos: data/);
    create({ manifest: 'https://x.example/.well-known/iark.json', module: 'data' }, listen);
    await flush();
    await flush();
    expect(errors.at(-1)).toMatch(/no publica un editor embebible/);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('nada', { status: 404 })));
    create({ manifest: 'https://x.example/m.json', module: 'data' }, listen);
    await flush();
    await flush();
    expect(errors.at(-1)).toMatch(/respondió 404/);
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    create({ manifest: 'https://x.example/m.json', module: 'data' }, listen);
    await flush();
    await flush();
    expect(errors.at(-1)).toMatch(/CORS/);
  });

  it('cambiar el tema o la vista no recarga; cambiar el módulo sí; al desconectar se limpia', async () => {
    const el = create({ src: 'http://localhost/app/modulos.html', module: 'security' });
    await flush();
    const first = iframeOf(el)!;
    const post = vi.spyOn(first.contentWindow!, 'postMessage');
    fromIframe(first, { event: 'init', version: '1.0', capabilities });
    post.mockClear();

    el.setAttribute('theme', 'dark');
    el.setAttribute('view', 'threats');
    await flush();
    expect(post.mock.calls.map((c) => JSON.parse(c[0] as string))).toEqual([{ action: 'configure', theme: 'dark' }, { action: 'setView', viewId: 'threats' }]);
    expect(iframeOf(el)).toBe(first);

    el.setAttribute('module', 'data');
    await flush();
    const second = iframeOf(el)!;
    expect(second).not.toBe(first);
    expect(new URL(second.src).searchParams.get('module')).toBe('data');
    expect(el.shadowRoot!.querySelectorAll('iframe')).toHaveLength(1);

    el.remove();
    expect(el.shadowRoot!.querySelectorAll('iframe')).toHaveLength(0);
  });
});
