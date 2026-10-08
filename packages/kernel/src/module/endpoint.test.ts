import { describe, expect, it } from 'vitest';
import { embedUrlFromManifest, EndpointUrlError, resolveEndpointUrl } from './endpoint';

const BASE = 'https://instancia.example/app/.well-known/iark.json';

describe('resolveEndpointUrl: solo http(s) tras resolver contra el manifiesto', () => {
  it('resuelve las URL relativas (de cualquier forma) contra la del manifiesto', () => {
    expect(resolveEndpointUrl('../modulos.html?module=data', BASE)).toBe('https://instancia.example/app/modulos.html?module=data');
    expect(resolveEndpointUrl('/w/modulos.html', BASE)).toBe('https://instancia.example/w/modulos.html');
    expect(resolveEndpointUrl('modulos.html', BASE)).toBe('https://instancia.example/app/.well-known/modulos.html');
    expect(resolveEndpointUrl('//otra.example/x', BASE)).toBe('https://otra.example/x'); // sin esquema: hereda el del manifiesto
  });

  it('deja pasar las absolutas http: y https:, de este y de otro origen', () => {
    expect(resolveEndpointUrl('https://otra.example/modulos.html', BASE)).toBe('https://otra.example/modulos.html');
    expect(resolveEndpointUrl('http://localhost:8787/api/data', BASE)).toBe('http://localhost:8787/api/data');
    expect(resolveEndpointUrl('HTTPS://Otra.Example/x', BASE)).toBe('https://otra.example/x');
  });

  it.each([
    ['javascript:alert(document.domain)', 'javascript:'],
    ['JaVaScRiPt:alert(1)', 'javascript:'],
    [' \tjava\nscript:alert(1)', 'javascript:'], // el analizador de URL quita espacios iniciales, tabuladores y saltos de línea
    ['\u0001javascript:alert(1)', 'javascript:'],
    ['data:text/html,<script>alert(1)</script>', 'data:'],
    ['blob:https://instancia.example/3a1f', 'blob:'],
    ['file:///etc/passwd', 'file:'],
    ['vbscript:msgbox(1)', 'vbscript:'],
    ['ftp://otra.example/x', 'ftp:'],
    ['about:blank', 'about:'],
  ])('rechaza %j con un error que nombra el esquema', (endpoint, scheme) => {
    expect(() => resolveEndpointUrl(endpoint, BASE)).toThrow(EndpointUrlError);
    expect(() => resolveEndpointUrl(endpoint, BASE)).toThrow(`«${scheme}»`);
    expect(() => resolveEndpointUrl(endpoint, BASE)).toThrow(/solo se admiten URL http: y https:/);
  });

  it('el mensaje lleva la etiqueta de origen y recorta los valores enormes', () => {
    const huge = `data:text/html;base64,${'A'.repeat(5000)}`;
    let message = '';
    try {
      resolveEndpointUrl(huge, BASE, 'El endpoint «embed» del módulo «data»');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.startsWith('El endpoint «embed» del módulo «data» «data:text/html;base64,')).toBe(true);
    expect(message.length).toBeLessThan(250);
  });

  it('una URL que no se puede analizar es un error claro, no una excepción de TypeError', () => {
    expect(() => resolveEndpointUrl('http://', BASE)).toThrow(/no es una URL válida/);
    expect(() => resolveEndpointUrl('https://[::1', BASE)).toThrow(EndpointUrlError);
    // Una base que no es http(s) hace que lo relativo herede un esquema inaceptable
    expect(() => resolveEndpointUrl('modulos.html', 'file:///tmp/iark.json')).toThrow(/«file:»/);
    expect(() => resolveEndpointUrl('modulos.html', 'data:application/json,{}')).toThrow(/no es una URL válida/);
  });
});

describe('embedUrlFromManifest (lo que usa <iark-module>)', () => {
  const manifest = (embed: unknown) => ({
    schema: 'iark.manifest/1',
    name: 'X',
    version: '1',
    modules: [{ id: 'data', name: 'Datos', version: '1', documentVersion: '1', importFormats: [], exportFormats: [], endpoints: { embed } }, { id: 'security' }],
  });

  it('devuelve el editor del módulo resuelto contra el manifiesto', () => {
    expect(embedUrlFromManifest(manifest('../modulos.html?module=data'), BASE, 'data')).toBe('https://instancia.example/app/modulos.html?module=data');
  });

  it('rechaza un editor con esquema peligroso', () => {
    expect(() => embedUrlFromManifest(manifest('javascript:alert(1)'), BASE, 'data')).toThrow(/«data».*«javascript:»/);
    expect(() => embedUrlFromManifest(manifest('data:text/html,hola'), BASE, 'data')).toThrow(/«data:»/);
  });

  it('explica qué falta: no es un manifiesto, no hay módulo o no hay editor', () => {
    expect(() => embedUrlFromManifest(null, BASE, 'data')).toThrow(/no es un manifiesto iark.manifest\/1/);
    expect(() => embedUrlFromManifest({ schema: 'otro', modules: [] }, BASE, 'data')).toThrow(/no es un manifiesto/);
    expect(() => embedUrlFromManifest({ schema: 'iark.manifest/1' }, BASE, 'data')).toThrow(/no es un manifiesto/);
    expect(() => embedUrlFromManifest(manifest('x'), BASE, 'platform')).toThrow(/no ofrece el módulo «platform»\. Módulos: data, security/);
    expect(() => embedUrlFromManifest(manifest('x'), BASE, 'security')).toThrow(/no publica un editor embebible para «security»/);
    expect(() => embedUrlFromManifest(manifest(42), BASE, 'data')).toThrow(/no publica un editor embebible/);
  });
});
