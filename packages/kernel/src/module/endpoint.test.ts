import { describe, expect, it } from 'vitest';
import { embedUrlFromManifest, EndpointUrlError, manifestCompatibilityProblem, manifestSchemaVersion, moduleCompatibilityProblem, resolveEndpointUrl } from './endpoint';

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

describe('versiones de un manifiesto: esquema, protocolo y contrato', () => {
  it('manifestSchemaVersion lee el número de `iark.manifest/<n>`', () => {
    expect(manifestSchemaVersion('iark.manifest/1')).toBe(1);
    expect(manifestSchemaVersion('iark.manifest/12')).toBe(12);
    for (const otro of ['iark.manifest', 'iark.manifest/', 'iark.manifest/1.5', 'otro/1', 1, null, undefined]) expect(manifestSchemaVersion(otro)).toBeUndefined();
  });

  it('un manifiesto del esquema actual, con o sin `protocol`, se puede usar', () => {
    expect(manifestCompatibilityProblem({ schema: 'iark.manifest/1', modules: [] }, BASE)).toBeUndefined(); // instancia anterior: protocolo 1.0
    expect(manifestCompatibilityProblem({ schema: 'iark.manifest/1', protocol: '1.0', modules: [] }, BASE)).toBeUndefined();
    expect(manifestCompatibilityProblem({ schema: 'iark.manifest/1', protocol: '1.7', modules: [] }, BASE)).toBeUndefined(); // diferencia de menor: se acepta
    expect(manifestCompatibilityProblem(null, BASE)).toBeUndefined(); // lo que no es un manifiesto lo dice quien lo valida
  });

  it('un esquema de manifiesto de versión MAYOR se rechaza con un mensaje que dice cuál es', () => {
    const problem = manifestCompatibilityProblem({ schema: 'iark.manifest/2', modules: [] }, BASE);
    expect(problem).toMatch(/versión más nueva del formato \(iark\.manifest\/2\).*entiende iark\.manifest\/1.*Actualiza IArk/);
    expect(problem).toContain(BASE);
  });

  it('un `protocol` de versión mayor distinta se rechaza (para ambos lados); uno ilegible, también', () => {
    expect(manifestCompatibilityProblem({ schema: 'iark.manifest/1', protocol: '2.0' }, BASE)).toMatch(/habla el protocolo embebido 2\.0 y esta suite el 1\.0.*Actualiza esta suite/);
    expect(manifestCompatibilityProblem({ schema: 'iark.manifest/1', protocol: '0.9' }, BASE)).toMatch(/protocolo embebido 0\.9.*Actualiza la instancia/);
    expect(manifestCompatibilityProblem({ schema: 'iark.manifest/1', protocol: 'uno' }, BASE)).toMatch(/ilegible/);
    expect(manifestCompatibilityProblem({ schema: 'iark.manifest/1', protocol: 2 }, BASE)).toMatch(/ilegible/);
  });

  it('moduleCompatibilityProblem: sin contractVersion vale 1; uno mayor que el de la suite o inválido se rechaza', () => {
    expect(moduleCompatibilityProblem({ id: 'data' })).toBeUndefined();
    expect(moduleCompatibilityProblem({ id: 'data', contractVersion: 1 })).toBeUndefined();
    expect(moduleCompatibilityProblem({ id: 'data', contractVersion: 2 })).toMatch(/«data» exige la versión 2 del contrato de módulos y esta suite entiende hasta la 1/);
    for (const invalido of [0, -1, 1.5, '1', null, true]) expect(moduleCompatibilityProblem({ id: 'data', contractVersion: invalido })).toMatch(/contractVersion inválido/);
  });

  it('embedUrlFromManifest (el Web Component) rechaza un manifiesto de esquema o protocolo mayor y un módulo de contrato mayor', () => {
    const manifest = (extra: Record<string, unknown>, moduleExtra: Record<string, unknown> = {}) => ({
      schema: 'iark.manifest/1',
      name: 'X',
      version: '1',
      modules: [{ id: 'data', name: 'Datos', version: '1', documentVersion: '1.0', importFormats: [], exportFormats: [], endpoints: { embed: '../modulos.html?module=data' }, ...moduleExtra }],
      ...extra,
    });
    expect(embedUrlFromManifest(manifest({ protocol: '1.4' }, { contractVersion: 1 }), BASE, 'data')).toBe('https://instancia.example/app/modulos.html?module=data');
    expect(() => embedUrlFromManifest(manifest({ schema: 'iark.manifest/2' }), BASE, 'data')).toThrow(EndpointUrlError);
    expect(() => embedUrlFromManifest(manifest({ schema: 'iark.manifest/2' }), BASE, 'data')).toThrow(/versión más nueva del formato \(iark\.manifest\/2\)/);
    expect(() => embedUrlFromManifest(manifest({ protocol: '2.0' }), BASE, 'data')).toThrow(/protocolo embebido 2\.0/);
    expect(() => embedUrlFromManifest(manifest({}, { contractVersion: 2 }), BASE, 'data')).toThrow(/«data» exige la versión 2 del contrato de módulos/);
  });
});
