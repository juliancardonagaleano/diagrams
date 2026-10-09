// @vitest-environment jsdom
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { EMBED_PROTOCOL_VERSION, INCOMPATIBLE_PROTOCOL_CODE } from '@iark/kernel';
import { sampleDocument } from '@core/model/sample';
import { DOC_C4_0_9, instalarMigracionesC4 } from '../../tests/helpers/migracionC4';
import './iark-module-element';
import type { IarkModuleElement } from './iark-module-element';
import { createIarkEmbed } from './iark-embed';
import { createIarkModuleEmbed } from './iark-module-embed';
import { MODULE_PROTOCOL_VERSION, parseModuleAction, type SuiteCapabilitiesInfo } from './moduleProtocol';
import { parseHostAction, PROTOCOL_VERSION } from './protocol';

/**
 * Negociación de la versión del protocolo `postMessage`: el `init` del iframe y el `load` del anfitrión llevan `version`; cada
 * lado la compara con la suya (`negotiateProtocol`). Una diferencia de MAYOR se avisa con un `error` de código
 * `incompatible-protocol` en vez de funcionar a medias; una de menor se acepta; un lado sin versión habla 1.0.
 */
const capabilities: SuiteCapabilitiesInfo = { protocol: MODULE_PROTOCOL_VERSION, suite: 'IArk - DIAgrams', available: ['data'], modules: [] };

function fromIframe(iframe: HTMLIFrameElement, data: unknown, origin = 'http://localhost') {
  window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data), source: iframe.contentWindow, origin }));
}

describe('la versión del protocolo', () => {
  it('es la misma constante del núcleo en los dos protocolos', () => {
    expect(PROTOCOL_VERSION).toBe(EMBED_PROTOCOL_VERSION);
    expect(MODULE_PROTOCOL_VERSION).toBe(EMBED_PROTOCOL_VERSION);
  });

  it('el `load` del anfitrión admite `version` (opcional) en los dos protocolos', () => {
    expect(parseHostAction({ action: 'load', version: '1.0' })).toMatchObject({ ok: true, action: { version: '1.0' } });
    expect(parseHostAction({ action: 'load' })).toMatchObject({ ok: true });
    expect(parseHostAction({ action: 'load', version: 2 }).ok).toBe(false);
    expect(parseModuleAction({ action: 'load', module: 'data', version: '1.2' })).toMatchObject({ ok: true, action: { version: '1.2' } });
    expect(parseModuleAction({ action: 'load', module: 'data' })).toMatchObject({ ok: true });
  });
});

describe('documentos antiguos en las acciones del anfitrión (editor C4)', () => {
  let restaurar: (() => void) | undefined;
  afterEach(() => restaurar?.());

  it('un documento de una versión anterior sin migración se rechaza ya al interpretar la acción, con el motivo', () => {
    const result = parseHostAction({ action: 'load', document: DOC_C4_0_9 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/document\.version: La versión 0\.9 del documento no está soportada/);
  });

  it('con una migración declarada, el mismo documento se acepta (load y merge) y la acción conserva el original', () => {
    restaurar = instalarMigracionesC4();
    const load = parseHostAction({ action: 'load', document: DOC_C4_0_9 });
    expect(load.ok && load.action.action === 'load' && load.action.document).toEqual(DOC_C4_0_9);
    expect(parseHostAction({ action: 'merge', document: DOC_C4_0_9 }).ok).toBe(true);
  });

  it('un documento de una versión más nueva se rechaza con el mensaje claro', () => {
    const result = parseHostAction({ action: 'load', document: { ...sampleDocument, version: '2.0' } });
    expect(result.ok === false && result.error).toMatch(/versión más nueva \(2\.0\)/);
  });

  it('un documento válido sigue aceptándose, y uno inválido sigue diciendo por qué', () => {
    expect(parseHostAction({ action: 'load', document: sampleDocument }).ok).toBe(true);
    const bad = parseHostAction({ action: 'load', document: { model: { elements: [{ id: 'a', type: 'container', name: 'A', parentId: 'zz' }] } } });
    expect(bad.ok === false && bad.error).toMatch(/padre inexistente/);
    expect(parseHostAction({ action: 'load', document: [1, 2] }).ok).toBe(false);
    expect(parseHostAction({ action: 'load', document: 42 }).ok).toBe(false);
  });
});

describe('SDK de anfitrión del editor C4: negociación', () => {
  function setup(options: Partial<Parameters<typeof createIarkEmbed>[0]> = {}) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const embed = createIarkEmbed({ container, url: 'http://localhost/app/', ...options });
    const post = vi.spyOn(embed.iframe.contentWindow!, 'postMessage');
    return { embed, post, sent: (i: number) => JSON.parse(post.mock.calls[i][0] as string) };
  }

  it('todo `load` que envía lleva la versión del protocolo que habla (también el que pide load())', async () => {
    const { embed, post, sent } = setup({ document: sampleDocument });
    fromIframe(embed.iframe, { event: 'init', version: '1.0' });
    expect(sent(0)).toMatchObject({ action: 'load', version: EMBED_PROTOCOL_VERSION });
    const pending = embed.load(sampleDocument);
    expect(sent(1)).toMatchObject({ action: 'load', version: EMBED_PROTOCOL_VERSION });
    fromIframe(embed.iframe, { event: 'load', document: sampleDocument });
    await pending;
    embed.send({ action: 'load', version: '1.5' });
    expect(post.mock.calls.map((c) => JSON.parse(c[0] as string).version)).toEqual(['1.0', '1.0', '1.5']); // una versión explícita se respeta
    embed.destroy();
  });

  it('un iframe de versión MAYOR distinta: no se envía el load, ready se rechaza, onError trae el código y onInit no se llama', async () => {
    const onError = vi.fn();
    const onInit = vi.fn();
    const onEvent = vi.fn();
    const { embed, post } = setup({ document: sampleDocument, onError, onInit, onEvent });
    const pending = embed.load(sampleDocument).catch((e: Error) => e);
    post.mockClear();
    fromIframe(embed.iframe, { event: 'init', version: '2.0' });
    expect(post).not.toHaveBeenCalled();
    expect(onInit).not.toHaveBeenCalled();
    await expect(embed.ready).rejects.toThrow(/Protocolo embebido incompatible.*versión 1\.0.*2\.0/);
    expect(await pending).toBeInstanceOf(Error);
    expect(onError).toHaveBeenCalledWith({ message: expect.stringMatching(/incompatible/), code: INCOMPATIBLE_PROTOCOL_CODE });
    // quien escucha `onEvent` lo recibe como un `error` más, igual que si lo hubiera enviado el iframe
    expect(onEvent).toHaveBeenCalledWith({ event: 'error', code: INCOMPATIBLE_PROTOCOL_CODE, message: expect.stringMatching(/incompatible/) });
    embed.destroy();
  });

  it('una diferencia de menor se acepta, y un iframe sin versión (anterior a la negociación) habla 1.0', () => {
    for (const init of [{ event: 'init', version: '1.7' }, { event: 'init' }]) {
      const { embed, post, sent } = setup({ document: sampleDocument });
      fromIframe(embed.iframe, init);
      expect(post).toHaveBeenCalledTimes(1);
      expect(sent(0).action).toBe('load');
      embed.destroy();
    }
  });

  it('si es el iframe quien rechaza nuestra versión (error con código), ready se rechaza y el código llega a onError', async () => {
    const onError = vi.fn();
    const { embed } = setup({ onError });
    fromIframe(embed.iframe, { event: 'init', version: '1.0' });
    fromIframe(embed.iframe, { event: 'error', code: INCOMPATIBLE_PROTOCOL_CODE, message: 'Protocolo embebido incompatible: …' });
    await expect(embed.ready).rejects.toThrow(/incompatible/);
    expect(onError).toHaveBeenCalledWith({ message: 'Protocolo embebido incompatible: …', code: INCOMPATIBLE_PROTOCOL_CODE });
    embed.destroy();
  });

  it('un error corriente no lleva código ni rechaza ready', () => {
    const onError = vi.fn();
    const { embed } = setup({ onError });
    fromIframe(embed.iframe, { event: 'error', message: 'documento inválido' });
    expect(onError).toHaveBeenCalledWith({ message: 'documento inválido', issues: undefined });
    embed.destroy();
  });
});

describe('SDK de anfitrión de módulos: negociación', () => {
  function setup(options: Partial<Parameters<typeof createIarkModuleEmbed>[0]> = {}) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const embed = createIarkModuleEmbed({ container, url: 'http://localhost/app/modulos.html', ...options });
    const post = vi.spyOn(embed.iframe.contentWindow!, 'postMessage');
    return { embed, post, sent: (i: number) => JSON.parse(post.mock.calls[i][0] as string) };
  }

  it('el `load` automático y el de load() llevan la versión del protocolo', async () => {
    const { embed, sent } = setup({ module: 'data', document: { version: '1.0' } });
    fromIframe(embed.iframe, { event: 'init', version: '1.0', module: 'data', capabilities });
    expect(sent(0)).toMatchObject({ action: 'load', module: 'data', version: EMBED_PROTOCOL_VERSION });
    const pending = embed.load({ version: '1.0' }, { module: 'data' });
    expect(sent(1)).toMatchObject({ action: 'load', version: EMBED_PROTOCOL_VERSION });
    fromIframe(embed.iframe, { event: 'load', module: 'data', document: {}, issues: [] });
    await pending;
    embed.destroy();
  });

  it('un banco de trabajo de versión MAYOR distinta: no se envía nada, initialized y ready se rechazan y lo pendiente también', async () => {
    const onError = vi.fn();
    const onInit = vi.fn();
    const { embed, post } = setup({ module: 'data', document: { version: '1.0' }, onError, onInit });
    const exporting = embed.export('svg').catch((e: Error) => e); // queda en cola hasta el init
    post.mockClear();
    fromIframe(embed.iframe, { event: 'init', version: '3.0', module: 'data', capabilities });
    expect(post).not.toHaveBeenCalled();
    expect(onInit).not.toHaveBeenCalled();
    await expect(embed.initialized).rejects.toThrow(/Protocolo embebido incompatible/);
    await expect(embed.ready).rejects.toThrow(/incompatible/);
    expect(await exporting).toBeInstanceOf(Error);
    expect(onError).toHaveBeenCalledWith({ message: expect.stringMatching(/versión 1\.0 y el otro la 3\.0/), code: INCOMPATIBLE_PROTOCOL_CODE });
    // a partir de ahí, lo que se pida se rechaza al instante y nada se envía
    await expect(embed.validate()).rejects.toThrow(/incompatible/);
    await expect(embed.load({ version: '1.0' })).rejects.toThrow(/incompatible/);
    embed.status('x');
    expect(post).not.toHaveBeenCalled();
    embed.destroy();
  });

  it('si el banco de trabajo rechaza nuestra versión (error con código), lo pendiente se rechaza con su mensaje', async () => {
    const { embed } = setup({ module: 'data' });
    fromIframe(embed.iframe, { event: 'init', version: '1.0', module: 'data', capabilities });
    const pending = embed.validate().catch((e: Error) => e);
    fromIframe(embed.iframe, { event: 'error', code: INCOMPATIBLE_PROTOCOL_CODE, message: 'Protocolo embebido incompatible: otro' });
    expect(((await pending) as Error).message).toBe('Protocolo embebido incompatible: otro');
    await expect(embed.ready).rejects.toThrow(/otro/);
    embed.destroy();
  });

  it('versión de menor distinta o ausente: se acepta', () => {
    for (const version of ['1.4', undefined]) {
      const { embed, post, sent } = setup({ module: 'data' });
      fromIframe(embed.iframe, { event: 'init', ...(version ? { version } : {}), module: 'data', capabilities });
      expect(post).toHaveBeenCalledTimes(1);
      expect(sent(0).action).toBe('load');
      embed.destroy();
    }
  });
});

describe('<iark-module>: el error de protocolo llega como evento DOM', () => {
  const original = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow')!;
  beforeAll(() => Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', { configurable: true, get: () => window }));
  afterAll(() => Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', original));
  afterEach(() => document.body.replaceChildren());

  it('iark-error lleva el código `incompatible-protocol` cuando el banco de trabajo habla una versión mayor distinta', async () => {
    const el = document.createElement('iark-module') as IarkModuleElement;
    el.setAttribute('src', 'http://localhost/app/modulos.html');
    el.setAttribute('module', 'data');
    const errors: unknown[] = [];
    el.addEventListener('iark-error', (e) => errors.push((e as CustomEvent).detail));
    document.body.appendChild(el);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const iframe = el.shadowRoot!.querySelector('iframe')!;
    fromIframe(iframe, { event: 'init', version: '2.0', module: 'data', capabilities });
    expect(errors).toEqual([{ message: expect.stringMatching(/incompatible/), issues: undefined, code: INCOMPATIBLE_PROTOCOL_CODE }]);
  });
});
