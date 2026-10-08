import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadManifest, manifestOrigin, ManifestError } from './manifest';

const published = readFileSync(new URL('../../public/.well-known/iark.json', import.meta.url), 'utf8');
const respond = (body: string, status = 200): typeof fetch => (async () => new Response(body, { status })) as typeof fetch;

describe('descubrimiento de módulos por manifiesto', () => {
  it('resuelve los endpoints relativos al manifiesto, bajo cualquier ruta base', async () => {
    const manifest = await loadManifest('https://juliancardonagaleano.github.io/iark-diagrams/.well-known/iark.json', respond(published));
    expect(manifest.name).toBe('IArk - DIAgrams');
    expect(manifest.modules.map((m) => m.id)).toEqual(['c4', 'integration', 'data', 'enterprise', 'platform', 'security']);
    const c4 = manifest.modules.find((m) => m.id === 'c4')!;
    expect(c4.embedUrl).toBe('https://juliancardonagaleano.github.io/iark-diagrams/');
    const security = manifest.modules.find((m) => m.id === 'security')!;
    expect(security.embedUrl).toBe('https://juliancardonagaleano.github.io/iark-diagrams/modulos.html?module=security');
    expect(security.schemaUrl).toBe('https://juliancardonagaleano.github.io/iark-diagrams/schema/security-document.schema.json');
    expect(security.apiUrl).toBeUndefined();
  });

  it('una instancia remota con API resuelve también el endpoint de la API', async () => {
    const remote = JSON.stringify({
      schema: 'iark.manifest/1',
      name: 'Otra instancia',
      version: '2.0.0',
      modules: [{ id: 'data', name: 'Datos', version: '1', documentVersion: '1.0', importFormats: [], exportFormats: ['svg'], endpoints: { embed: '/w/modulos.html?module=data', api: '/api/data' } }],
    });
    const manifest = await loadManifest('https://otra.example/.well-known/iark.json', respond(remote));
    expect(manifest.modules[0].embedUrl).toBe('https://otra.example/w/modulos.html?module=data');
    expect(manifest.modules[0].apiUrl).toBe('https://otra.example/api/data');
  });

  it('explica por qué falla: red, estado HTTP, JSON o esquema', async () => {
    const offline = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    await expect(loadManifest('https://x.example/m.json', offline)).rejects.toThrow(/CORS/);
    await expect(loadManifest('https://x.example/m.json', respond('nada', 404))).rejects.toThrow(/respondió 404/);
    await expect(loadManifest('https://x.example/m.json', respond('<html>'))).rejects.toThrow(/no es JSON válido/);
    await expect(loadManifest('https://x.example/m.json', respond('{"schema":"otro"}'))).rejects.toBeInstanceOf(ManifestError);
  });
});

describe('endpoints del manifiesto: solo http(s)', () => {
  const withEndpoints = (endpoints: Record<string, string>): string =>
    JSON.stringify({
      schema: 'iark.manifest/1',
      name: 'Otra instancia',
      version: '2.0.0',
      modules: [{ id: 'data', name: 'Datos', version: '1', documentVersion: '1.0', importFormats: [], exportFormats: [], endpoints }],
    });

  it.each([
    ['embed', 'javascript:alert(document.domain)', '«javascript:»'],
    ['embed', 'JaVaScRiPt:alert(1)', '«javascript:»'],
    ['embed', 'data:text/html,<script>alert(1)</script>', '«data:»'],
    ['embed', 'blob:https://otra.example/1234', '«blob:»'],
    ['embed', 'file:///etc/passwd', '«file:»'],
    ['schema', 'javascript:void(0)', '«javascript:»'],
    ['api', 'data:application/json,{}', '«data:»'],
  ])('rechaza el manifiesto entero si endpoints.%s es %s', async (field, value, scheme) => {
    const attempt = loadManifest('https://otra.example/.well-known/iark.json', respond(withEndpoints({ [field]: value })));
    await expect(attempt).rejects.toBeInstanceOf(ManifestError);
    await expect(attempt).rejects.toThrow(`endpoint «${field}» del módulo «data»`);
    await expect(attempt).rejects.toThrow(scheme);
  });

  it('acepta las relativas y las absolutas http(s), incluso de otro origen', async () => {
    const manifest = await loadManifest(
      'https://otra.example/base/.well-known/iark.json',
      respond(withEndpoints({ embed: '../modulos.html?module=data', schema: 'http://localhost:8787/api/data/schema', api: 'https://api.otra.example/data' })),
    );
    expect(manifest.modules[0].embedUrl).toBe('https://otra.example/base/modulos.html?module=data');
    expect(manifest.modules[0].schemaUrl).toBe('http://localhost:8787/api/data/schema');
    expect(manifest.modules[0].apiUrl).toBe('https://api.otra.example/data');
  });
});

describe('manifestOrigin: a quién apunta un manifiesto recibido por enlace', () => {
  const page = 'https://suite.example/app/suite.html?manifest=x';

  it('resuelve lo relativo contra la página y distingue el mismo origen del ajeno', () => {
    expect(manifestOrigin('.well-known/iark.json', page)).toBe('https://suite.example');
    expect(manifestOrigin('/otra/.well-known/iark.json', page)).toBe('https://suite.example');
    expect(manifestOrigin('https://otra.example/.well-known/iark.json', page)).toBe('https://otra.example');
    expect(manifestOrigin('http://suite.example/.well-known/iark.json', page)).toBe('http://suite.example'); // otro esquema, otro origen
    expect(manifestOrigin('https://suite.example:8443/m.json', page)).toBe('https://suite.example:8443');
  });

  it('lo que no es una URL no tiene origen', () => {
    expect(manifestOrigin('http://', page)).toBeUndefined();
  });
});
