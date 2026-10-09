import { describe, expect, it } from 'vitest';
import { isMixedContent, mixedContentWarning, testConnection } from './connection';
import { fakeServer } from './testing';

const PAGE = { protocol: 'https:', origin: 'https://usuario.github.io' };
const DEV = { protocol: 'http:', origin: 'http://localhost:5173' };

describe('probar la conexión con un servidor', () => {
  it('un servidor con autenticación: dice quién eres, tu rol y cuántos proyectos hay', async () => {
    const server = fakeServer({ token: 'secreto', name: 'Ana', role: 'editor' });
    await server.store.createProject({ name: 'Tienda' });
    const result = await testConnection({ url: 'http://localhost:8787/', token: 'secreto' }, { fetch: server.fetch, page: DEV });
    expect(result).toEqual({ ok: true, url: 'http://localhost:8787', auth: true, name: 'Ana', role: 'editor', projects: 1 });
  });

  it('un servidor abierto (sin autenticación) también sirve, y no hace falta token', async () => {
    const result = await testConnection({ url: 'http://localhost:8787' }, { fetch: fakeServer().fetch, page: DEV });
    expect(result).toMatchObject({ ok: true, auth: false, projects: 0 });
  });

  it('token inválido o ausente: 401 explicado con lenguaje claro', async () => {
    const server = fakeServer({ token: 'secreto' });
    const wrong = await testConnection({ url: 'http://localhost:8787', token: 'otro' }, { fetch: server.fetch, page: DEV });
    expect(wrong).toMatchObject({ ok: false, problem: 'unauthorized', message: expect.stringContaining('no aceptó el token') });
    const missing = await testConnection({ url: 'http://localhost:8787' }, { fetch: server.fetch, page: DEV });
    expect(missing).toMatchObject({ ok: false, problem: 'unauthorized' });
  });

  it('403 (sin permiso) se distingue del token inválido y deja ver lo que respondió el servidor', async () => {
    const fetch403 = (async () => new Response(JSON.stringify({ error: 'Origen no permitido: use --cors.', code: 'forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
    const result = await testConnection({ url: 'http://localhost:8787' }, { fetch: fetch403, page: DEV });
    expect(result).toMatchObject({ ok: false, problem: 'forbidden', message: expect.stringContaining('no te da permiso'), detail: 'Origen no permitido: use --cors.' });
  });

  it('un servidor que arrancó sin --workspace no ofrece proyectos', async () => {
    const result = await testConnection({ url: 'http://localhost:8787' }, { fetch: fakeServer({ noProjects: true }).fetch, page: DEV });
    expect(result).toMatchObject({ ok: false, problem: 'no-projects', message: expect.stringContaining('--workspace') });
  });

  it('demasiados intentos fallidos (429) se explican y se indica esperar', async () => {
    const limited = (async () => new Response(JSON.stringify({ error: 'Demasiados intentos.', code: 'rate-limited' }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '30' } })) as unknown as typeof fetch;
    const result = await testConnection({ url: 'http://localhost:8787', token: 'x' }, { fetch: limited, page: DEV });
    expect(result).toMatchObject({ ok: false, problem: 'rate-limited', message: expect.stringContaining('Demasiados intentos') });
  });

  it('sin conexión: no se llega al servidor', async () => {
    const server = fakeServer();
    server.down = true;
    const result = await testConnection({ url: 'http://localhost:8787' }, { fetch: server.fetch, page: DEV });
    expect(result).toMatchObject({ ok: false, problem: 'unreachable', message: expect.stringContaining('No se llega a localhost:8787') });
  });

  it('CORS rechazado: el servidor responde a una petición opaca, así que se explica que hay que arrancarlo con --cors y el origen exacto', async () => {
    const server = fakeServer();
    server.corsBlocked = true;
    const result = await testConnection({ url: 'http://localhost:8787' }, { fetch: server.fetch, page: DEV });
    expect(result).toMatchObject({ ok: false, problem: 'cors' });
    expect((result as { message: string }).message).toContain('--cors http://localhost:5173');
  });

  it('en el mismo origen no hay CORS que culpar: un fallo de red es solo falta de conexión', async () => {
    const server = fakeServer();
    server.corsBlocked = true;
    const result = await testConnection({ url: 'http://localhost:5173' }, { fetch: server.fetch, page: DEV });
    expect(result).toMatchObject({ ok: false, problem: 'unreachable' });
  });

  it('contenido mixto: desde una página https una dirección http (que no sea la propia máquina) ni se intenta', async () => {
    const server = fakeServer();
    const result = await testConnection({ url: 'http://iark.ejemplo.org' }, { fetch: server.fetch, page: PAGE });
    expect(result).toMatchObject({ ok: false, problem: 'mixed-content', message: expect.stringContaining('contenido mixto') });
    expect(server.log).toEqual([]);
    expect(isMixedContent('http://iark.ejemplo.org', PAGE)).toBe(true);
    for (const safe of ['https://iark.ejemplo.org', 'http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787', 'http://iark.localhost']) {
      expect(isMixedContent(safe, PAGE)).toBe(false);
    }
    expect(isMixedContent('http://iark.ejemplo.org', DEV)).toBe(false);
    expect(mixedContentWarning('http://iark.ejemplo.org', PAGE)).toMatch(/https/);
    expect(mixedContentWarning('https://iark.ejemplo.org', PAGE)).toBeUndefined();
  });

  it('una dirección que no vale se rechaza antes de llamar a nadie', async () => {
    const server = fakeServer();
    expect(await testConnection({ url: 'iark.ejemplo.org' }, { fetch: server.fetch, page: DEV })).toMatchObject({ ok: false, problem: 'invalid-url' });
    expect(await testConnection({ url: 'ftp://x.org' }, { fetch: server.fetch, page: DEV })).toMatchObject({ ok: false, problem: 'invalid-url', message: expect.stringContaining('http') });
    expect(server.log).toEqual([]);
  });

  it('un servidor que responde con otra cosa (no es JSON) se dice con claridad', async () => {
    const html = (async () => new Response('<html>hola</html>', { status: 200, headers: { 'Content-Type': 'text/html' } })) as unknown as typeof fetch;
    const result = await testConnection({ url: 'http://localhost:8787' }, { fetch: html, page: DEV });
    expect(result).toMatchObject({ ok: false, problem: 'server', detail: expect.stringContaining('no respondió como un servidor de DIAgrams') });
  });
});
