import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { applySecurityHeaders, contentSecurityPolicy, DEFAULT_FRAME_ANCESTORS, HSTS, isDocumentPath, isSecureRequest, parseFrameAncestors, securityHeaders } from './securityHeaders';

/** Las directivas de una CSP, por nombre. */
function directives(csp: string): Record<string, string[]> {
  return Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
}

describe('securityHeaders (función pura)', () => {
  it('una respuesta que no es página (la API JSON, scripts, estilos…) lleva solo nosniff', () => {
    expect(securityHeaders({ kind: 'resource' })).toEqual({ 'X-Content-Type-Options': 'nosniff' });
    // aunque se le diga que es una carga embebida: la CSP y las políticas de documento no aplican
    expect(securityHeaders({ kind: 'resource', embed: true, frameAncestors: ['https://a.example'] })).toEqual({ 'X-Content-Type-Options': 'nosniff' });
  });

  it('HSTS solo si la petición llegó por https, en documentos y en recursos', () => {
    expect(securityHeaders({ kind: 'document' })['Strict-Transport-Security']).toBeUndefined();
    expect(securityHeaders({ kind: 'document', secure: false })['Strict-Transport-Security']).toBeUndefined();
    expect(securityHeaders({ kind: 'document', secure: true })['Strict-Transport-Security']).toBe(HSTS);
    expect(securityHeaders({ kind: 'resource', secure: true })).toEqual({ 'X-Content-Type-Options': 'nosniff', 'Strict-Transport-Security': HSTS });
    expect(HSTS).toBe('max-age=15552000'); // 180 días, sin includeSubDomains ni preload
  });

  it('una página HTML normal: nosniff, Referrer-Policy, Permissions-Policy vacía para cámara, micrófono y geolocalización, CSP y solo ella misma como marco', () => {
    const headers = securityHeaders({ kind: 'document' });
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Referrer-Policy']).toBe('no-referrer');
    expect(headers['Permissions-Policy']).toMatch(/\bcamera=\(\)/);
    expect(headers['Permissions-Policy']).toMatch(/\bmicrophone=\(\)/);
    expect(headers['Permissions-Policy']).toMatch(/\bgeolocation=\(\)/);
    expect(headers['X-Frame-Options']).toBe('SAMEORIGIN');
    expect(directives(headers['Content-Security-Policy'])['frame-ancestors']).toEqual(["'self'"]);
  });

  it('una carga embebida no lleva X-Frame-Options y su frame-ancestors sale de la lista (por omisión *)', () => {
    const embed = securityHeaders({ kind: 'document', embed: true });
    expect(embed['X-Frame-Options']).toBeUndefined();
    expect(directives(embed['Content-Security-Policy'])['frame-ancestors']).toEqual(['*']);
    expect(DEFAULT_FRAME_ANCESTORS).toEqual(['*']);
  });
});

describe('contentSecurityPolicy', () => {
  const csp = directives(contentSecurityPolicy());

  it('los scripts solo del propio origen: sin unsafe-inline, unsafe-eval ni comodines', () => {
    expect(csp['script-src']).toEqual(["'self'"]);
    expect(csp['default-src']).toEqual(["'self'"]);
    for (const [name, values] of Object.entries(csp)) {
      if (name === 'style-src') continue;
      expect(values, name).not.toContain("'unsafe-inline'");
      expect(values, name).not.toContain("'unsafe-eval'");
    }
  });

  it('cierra object, base y formularios; los estilos admiten los atributos style de React/Semi', () => {
    expect(csp['object-src']).toEqual(["'none'"]);
    expect(csp['base-uri']).toEqual(["'self'"]);
    expect(csp['form-action']).toEqual(["'self'"]);
    expect(csp['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it('imágenes y fuentes: data: y blob: donde la app los usa', () => {
    expect(csp['img-src']).toEqual(["'self'", 'data:', 'blob:']);
    expect(csp['font-src']).toEqual(["'self'", 'data:']);
  });

  it('connect-src y frame-src dejan hablar con otras instancias: https y el bucle local por http, no http en abierto', () => {
    for (const name of ['connect-src', 'frame-src']) {
      expect(csp[name], name).toEqual(["'self'", 'https:', 'http://localhost:*', 'http://127.0.0.1:*']);
      expect(csp[name], name).not.toContain('http:');
      expect(csp[name], name).not.toContain('*');
    }
  });

  it('frame-ancestors: la propia página solo; una carga embebida con lista concreta añade siempre self (el banco incrusta el editor C4)', () => {
    expect(directives(contentSecurityPolicy({ embed: false, frameAncestors: ['https://a.example'] }))['frame-ancestors']).toEqual(["'self'"]);
    expect(directives(contentSecurityPolicy({ embed: true }))['frame-ancestors']).toEqual(['*']);
    expect(directives(contentSecurityPolicy({ embed: true, frameAncestors: ['https://a.example', 'https://*.b.example'] }))['frame-ancestors']).toEqual(["'self'", 'https://a.example', 'https://*.b.example']);
    expect(directives(contentSecurityPolicy({ embed: true, frameAncestors: ["'self'", 'https://a.example'] }))['frame-ancestors']).toEqual(["'self'", 'https://a.example']);
    expect(directives(contentSecurityPolicy({ embed: true, frameAncestors: ["'none'"] }))['frame-ancestors']).toEqual(["'self'"]);
    expect(directives(contentSecurityPolicy({ embed: true, frameAncestors: ['https://a.example', '*'] }))['frame-ancestors']).toEqual(['*']);
  });
});

describe('parseFrameAncestors (IARK_FRAME_ANCESTORS / --frame-ancestors)', () => {
  it('vacío o ausente: la lista de por omisión', () => {
    expect(parseFrameAncestors(undefined)).toEqual(['*']);
    expect(parseFrameAncestors('')).toEqual(['*']);
    expect(parseFrameAncestors(' , ')).toEqual(['*']);
  });

  it('acepta orígenes separados por comas y/o espacios, comodines y esquemas', () => {
    expect(parseFrameAncestors('https://a.example, https://b.example:8443 http://localhost:5173')).toEqual(['https://a.example', 'https://b.example:8443', 'http://localhost:5173']);
    expect(parseFrameAncestors('https://*.example.com')).toEqual(['https://*.example.com']);
    expect(parseFrameAncestors("'self' https:")).toEqual(["'self'", 'https:']);
    expect(parseFrameAncestors('*')).toEqual(['*']);
    expect(parseFrameAncestors('app.example')).toEqual(['app.example']);
  });

  it.each(["https://a.example; script-src *", "'unsafe-inline'", 'https://a.example/ruta', 'a b;c', "https://a.example'", '<x>', 'https://']) ('rechaza %j: iría dentro de una cabecera', (value) => {
    expect(() => parseFrameAncestors(value)).toThrow(/no es un origen válido para frame-ancestors/);
  });
});

function fakeRequest({ url = '/', headers = {}, encrypted = false }: { url?: string; headers?: Record<string, string | string[]>; encrypted?: boolean } = {}): IncomingMessage {
  return { url, headers, socket: { encrypted } } as unknown as IncomingMessage;
}

describe('isSecureRequest', () => {
  it('sin proxy de confianza solo cuenta una conexión TLS propia: un X-Forwarded-Proto puesto por el cliente no vale', () => {
    expect(isSecureRequest(fakeRequest({ headers: { 'x-forwarded-proto': 'https' } }), false)).toBe(false);
    expect(isSecureRequest(fakeRequest({ encrypted: true }), false)).toBe(true);
  });

  it('con proxy de confianza manda la última X-Forwarded-Proto (la que añadió ese proxy)', () => {
    expect(isSecureRequest(fakeRequest({ headers: { 'x-forwarded-proto': 'https' } }), true)).toBe(true);
    expect(isSecureRequest(fakeRequest({ headers: { 'x-forwarded-proto': 'HTTPS' } }), true)).toBe(true);
    expect(isSecureRequest(fakeRequest({ headers: { 'x-forwarded-proto': 'http' } }), true)).toBe(false);
    expect(isSecureRequest(fakeRequest({ headers: { 'x-forwarded-proto': 'https, http' } }), true)).toBe(false);
    expect(isSecureRequest(fakeRequest({ headers: { 'x-forwarded-proto': 'http, https' } }), true)).toBe(true);
    expect(isSecureRequest(fakeRequest({ headers: { 'x-forwarded-proto': ['http', 'https'] } }), true)).toBe(true);
    expect(isSecureRequest(fakeRequest(), true)).toBe(false);
  });
});

describe('isDocumentPath', () => {
  it('son documentos la raíz, las carpetas y los .html; no los assets, los JSON ni la API', () => {
    for (const path of ['/', '/index.html', '/modulos.html', '/examples/embed-host.html', '/SUITE.HTML', '/app/']) expect(isDocumentPath(path), path).toBe(true);
    for (const path of ['/assets/main-abc.js', '/assets/main.css', '/.well-known/iark.json', '/schema/data-document.schema.json', '/api/modules', '/favicon.svg']) expect(isDocumentPath(path), path).toBe(false);
  });
});

describe('applySecurityHeaders', () => {
  function apply(req: IncomingMessage, settings?: Parameters<typeof applySecurityHeaders>[2]): Record<string, string> {
    const set: Record<string, string> = {};
    applySecurityHeaders(req, { setHeader: (name: string, value: string) => void (set[name] = value) } as unknown as ServerResponse, settings);
    return set;
  }

  it('páginas, recursos y la API reciben lo que les corresponde según la ruta y la consulta', () => {
    expect(Object.keys(apply(fakeRequest({ url: '/api/modules' })))).toEqual(['X-Content-Type-Options']);
    expect(Object.keys(apply(fakeRequest({ url: '/api/' })))).toEqual(['X-Content-Type-Options']);
    expect(Object.keys(apply(fakeRequest({ url: '/assets/main-abc.js?embed=1' })))).toEqual(['X-Content-Type-Options']);
    const page = apply(fakeRequest({ url: '/modulos.html?module=data' }));
    expect(directives(page['Content-Security-Policy'])['frame-ancestors']).toEqual(["'self'"]);
    const embed = apply(fakeRequest({ url: '/modulos.html?embed=1&proto=json&origin=https%3A%2F%2Fa.example' }), { frameAncestors: ['https://a.example'] });
    expect(directives(embed['Content-Security-Policy'])['frame-ancestors']).toEqual(["'self'", 'https://a.example']);
    expect(embed['X-Frame-Options']).toBeUndefined();
    // `embed=0` y otros valores no cuentan como carga embebida
    expect(directives(apply(fakeRequest({ url: '/?embed=0' }))['Content-Security-Policy'])['frame-ancestors']).toEqual(["'self'"]);
  });

  it('?embed=1 solo abre la incrustación del editor y del banco: en cualquier otra página sigue valiendo solo la propia instancia (sin clickjacking por enlace)', () => {
    for (const url of ['/?embed=1', '/index.html?embed=1', '/modulos.html?embed=1&module=data']) {
      const headers = apply(fakeRequest({ url }));
      expect(directives(headers['Content-Security-Policy'])['frame-ancestors'], url).toEqual(['*']);
      expect(headers['X-Frame-Options'], url).toBeUndefined();
    }
    for (const url of ['/suite.html?embed=1', '/trazabilidad.html?embed=1', '/examples/embed-host.html?embed=1', '/otra/?embed=1']) {
      const headers = apply(fakeRequest({ url }));
      expect(directives(headers['Content-Security-Policy'])['frame-ancestors'], url).toEqual(["'self'"]);
      expect(headers['X-Frame-Options'], url).toBe('SAMEORIGIN');
    }
  });

  it('HSTS según el proxy de confianza', () => {
    const req = fakeRequest({ url: '/', headers: { 'x-forwarded-proto': 'https' } });
    expect(apply(req)['Strict-Transport-Security']).toBeUndefined();
    expect(apply(req, { trustProxy: true })['Strict-Transport-Security']).toBe(HSTS);
  });
});
