// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://localhost/modulos.html?embed=1&origin=https%3A%2F%2Fhost.example" }
import { afterEach, describe, expect, it } from 'vitest';
import { currentHostOriginSources, parseOrigin, resolveHostOrigin } from './hostOrigin';

describe('parseOrigin', () => {
  it('reduce una URL a su origen y descarta lo que no sirve de destino de postMessage', () => {
    expect(parseOrigin('https://host.example')).toBe('https://host.example');
    expect(parseOrigin('https://host.example/')).toBe('https://host.example');
    expect(parseOrigin('https://host.example/app/pagina.html?x=1#y')).toBe('https://host.example');
    expect(parseOrigin('http://localhost:5173')).toBe('http://localhost:5173');
    expect(parseOrigin('HTTPS://Host.Example:443')).toBe('https://host.example');
  });

  it.each([undefined, null, '', '*', 'null', 'host.example', 'file:///tmp/host.html', 'about:srcdoc', 'data:text/html,hola'])('descarta %j', (value) => {
    expect(parseOrigin(value)).toBeUndefined();
  });
});

describe('resolveHostOrigin: por orden de fiabilidad', () => {
  it('manda el origen declarado en la URL del iframe', () => {
    expect(resolveHostOrigin({ declared: 'https://a.example', ancestorOrigins: ['https://b.example'], referrer: 'https://c.example/p' })).toBe('https://a.example');
  });

  it('sin declarado, el del padre inmediato según el navegador (ancestorOrigins[0]) antes que el Referer', () => {
    expect(resolveHostOrigin({ ancestorOrigins: ['https://b.example', 'https://top.example'], referrer: 'https://c.example/p' })).toBe('https://b.example');
    expect(resolveHostOrigin({ declared: '', ancestorOrigins: ['https://b.example'] })).toBe('https://b.example');
  });

  it('sin ancestorOrigins (Firefox), el origen del referrer', () => {
    expect(resolveHostOrigin({ referrer: 'https://c.example/pagina?x=1' })).toBe('https://c.example');
    expect(resolveHostOrigin({ ancestorOrigins: [], referrer: 'https://c.example/pagina' })).toBe('https://c.example');
  });

  it('un declarado inservible (`*`, basura) no bloquea el respaldo, pero tampoco se toma tal cual', () => {
    expect(resolveHostOrigin({ declared: '*', ancestorOrigins: ['https://b.example'] })).toBe('https://b.example');
    expect(resolveHostOrigin({ declared: '*' })).toBeUndefined();
    expect(resolveHostOrigin({ declared: 'no-es-una-url', referrer: 'https://c.example/p' })).toBe('https://c.example');
  });

  it('un padre de origen opaco (sandbox, file:) no da ningún origen utilizable', () => {
    expect(resolveHostOrigin({ ancestorOrigins: ['null'], referrer: '' })).toBeUndefined();
    expect(resolveHostOrigin({ ancestorOrigins: ['null'], referrer: 'file:///tmp/host.html' })).toBeUndefined();
  });

  it('sin ninguna fuente, ninguno: quien llama no debe hablar con `*`', () => {
    expect(resolveHostOrigin({})).toBeUndefined();
    expect(resolveHostOrigin({ declared: null, ancestorOrigins: null, referrer: '' })).toBeUndefined();
  });
});

describe('currentHostOriginSources (lee la ventana actual)', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/modulos.html?embed=1&origin=https%3A%2F%2Fhost.example');
    delete (window.location as { ancestorOrigins?: unknown }).ancestorOrigins;
    delete (document as { referrer?: unknown }).referrer;
  });

  it('toma ?origin= de la URL, ancestorOrigins de location y document.referrer', () => {
    Object.defineProperty(window.location, 'ancestorOrigins', { value: ['https://padre.example'], configurable: true });
    Object.defineProperty(document, 'referrer', { value: 'https://ref.example/p', configurable: true });
    expect(currentHostOriginSources()).toEqual({ declared: 'https://host.example', ancestorOrigins: ['https://padre.example'], referrer: 'https://ref.example/p' });
    window.history.replaceState(null, '', '/modulos.html?embed=1');
    expect(currentHostOriginSources().declared).toBeNull();
    expect(resolveHostOrigin(currentHostOriginSources())).toBe('https://padre.example');
  });
});
