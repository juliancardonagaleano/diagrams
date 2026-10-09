import { describe, expect, it } from 'vitest';
import { classifyRoute } from './route';

/** Todas las plantillas que puede devolver `classifyRoute`: un conjunto cerrado, que es lo que protege la cardinalidad de las métricas y del registro. */
const TEMPLATES = new Set([
  '/', '/assets/*', '/*', '/healthz', '/readyz', '/metrics', '/.well-known/iark.json',
  '/api', '/api/*', '/api/modules', '/api/whoami', '/api/trace', '/api/events', '/api/events/*',
  '/api/projects', '/api/projects/import', '/api/projects/:project', '/api/projects/:project/diagrams', '/api/projects/:project/bundle', '/api/projects/:project/check',
  '/api/projects/:project/members', '/api/projects/:project/diagrams/:diagram', '/api/projects/:project/members/:login', '/api/projects/*',
  '/api/projects/:project/diagrams/:diagram/versions', '/api/projects/:project/diagrams/:diagram/versions/:version', '/api/projects/:project/diagrams/:diagram/versions/:version/restore',
  '/api/auth/providers', '/api/auth/exchange', '/api/auth/logout', '/api/auth/github/login', '/api/auth/github/callback', '/api/auth/*',
  '/api/admin/users', '/api/admin/users/:login', '/api/admin/*',
  '/api/:module/validate', '/api/:module/views', '/api/:module/export', '/api/:module/import', '/api/:module/diff', '/api/:module/run', '/api/:module/run/:command',
  '/api/:module/capabilities', '/api/:module/schema', '/api/:module/*',
]);

describe('classifyRoute: la plantilla de una petición', () => {
  const table: Array<[string, string, string, Record<string, string>]> = [
    ['GET', '/', '/', {}],
    ['GET', '/index.html', '/*', {}],
    ['GET', '/assets/index-abc123.js', '/assets/*', {}],
    ['GET', '/healthz', '/healthz', {}],
    ['GET', '/metrics', '/metrics', {}],
    ['GET', '/.well-known/iark.json', '/.well-known/iark.json', {}],
    ['GET', '/api/modules', '/api/modules', {}],
    ['GET', '/api/whoami', '/api/whoami', {}],
    ['POST', '/api/trace', '/api/trace', {}],
    ['GET', '/api/events', '/api/events', {}],
    ['GET', '/api/events/otra', '/api/events/*', {}],
    ['GET', '/api/projects', '/api/projects', {}],
    ['POST', '/api/projects/import', '/api/projects/import', {}],
    ['GET', '/api/projects/tienda', '/api/projects/:project', { project: 'tienda' }],
    ['PATCH', '/api/projects/Tienda-2', '/api/projects/:project', { project: 'Tienda-2' }],
    ['GET', '/api/projects/tienda/bundle', '/api/projects/:project/bundle', { project: 'tienda' }],
    ['GET', '/api/projects/tienda/check', '/api/projects/:project/check', { project: 'tienda' }],
    ['POST', '/api/projects/tienda/diagrams', '/api/projects/:project/diagrams', { project: 'tienda' }],
    ['PUT', '/api/projects/tienda/diagrams/contexto', '/api/projects/:project/diagrams/:diagram', { project: 'tienda', diagram: 'contexto' }],
    ['GET', '/api/projects/tienda/members', '/api/projects/:project/members', { project: 'tienda' }],
    ['PUT', '/api/projects/tienda/members/beto', '/api/projects/:project/members/:login', { project: 'tienda', login: 'beto' }],
    ['DELETE', '/api/projects/tienda/members/%40ana', '/api/projects/:project/members/:login', { project: 'tienda' }],
    ['DELETE', '/api/projects/tienda/members/ana~583231', '/api/projects/:project/members/:login', { project: 'tienda', login: 'ana~583231' }],
    ['GET', '/api/projects/tienda/diagrams/contexto/versions', '/api/projects/:project/diagrams/:diagram/versions', { project: 'tienda', diagram: 'contexto' }],
    ['GET', '/api/projects/tienda/diagrams/contexto/versions/12', '/api/projects/:project/diagrams/:diagram/versions/:version', { project: 'tienda', diagram: 'contexto', version: '12' }],
    ['PATCH', '/api/projects/tienda/diagrams/contexto/versions/3', '/api/projects/:project/diagrams/:diagram/versions/:version', { project: 'tienda', diagram: 'contexto', version: '3' }],
    ['POST', '/api/projects/tienda/diagrams/contexto/versions/3/restore', '/api/projects/:project/diagrams/:diagram/versions/:version/restore', { project: 'tienda', diagram: 'contexto', version: '3' }],
    ['DELETE', '/api/projects/tienda/diagrams/contexto/versions/%2e%2e', '/api/projects/:project/diagrams/:diagram/versions/:version', { project: 'tienda', diagram: 'contexto' }],
    ['GET', '/api/projects/tienda/diagrams/contexto/versions/0', '/api/projects/:project/diagrams/:diagram/versions/:version', { project: 'tienda', diagram: 'contexto' }],
    ['POST', '/api/projects/tienda/diagrams/contexto/versions/3/otra', '/api/projects/*', {}],
    ['GET', '/api/projects/tienda/otra-cosa', '/api/projects/*', {}],
    ['GET', '/api/projects/tienda/diagrams/a/b', '/api/projects/*', {}],
    ['GET', '/api/auth/providers', '/api/auth/providers', {}],
    ['POST', '/api/auth/exchange', '/api/auth/exchange', {}],
    ['POST', '/api/auth/logout', '/api/auth/logout', {}],
    ['GET', '/api/auth/github/login', '/api/auth/github/login', {}],
    ['GET', '/api/auth/github/callback', '/api/auth/github/callback', {}],
    ['GET', '/api/auth/github/otro', '/api/auth/*', {}],
    ['GET', '/api/admin/users', '/api/admin/users', {}],
    ['PUT', '/api/admin/users/dani', '/api/admin/users/:login', { login: 'dani' }],
    ['GET', '/api/admin/algo', '/api/admin/*', {}],
    ['POST', '/api/c4/validate', '/api/:module/validate', {}],
    ['POST', '/api/security/export', '/api/:module/export', {}],
    ['POST', '/api/security/run/risks', '/api/:module/run/:command', {}],
    ['POST', '/api/security/run', '/api/:module/run', {}],
    ['GET', '/api/c4/capabilities', '/api/:module/capabilities', {}],
    ['GET', '/api/c4/schema', '/api/:module/schema', {}],
    ['GET', '/api/c4/otra', '/api/:module/*', {}],
    ['GET', '/api/c4', '/api/*', {}],
    ['GET', '/api', '/api', {}],
    ['GET', '/api/', '/api', {}],
  ];
  it.each(table)('%s %s → %s', (method, path, template, params) => {
    const found = classifyRoute(method, path);
    expect(found.template).toBe(template);
    expect(found.params).toEqual(params);
    expect(TEMPLATES.has(found.template)).toBe(true);
  });

  it('marca qué rutas exigen credencial, cuáles son de cálculo y cuáles las comprueban máquinas', () => {
    expect(classifyRoute('GET', '/api/projects').protected).toBe(true);
    expect(classifyRoute('GET', '/api/whoami').protected).toBe(true);
    expect(classifyRoute('GET', '/api/events')).toMatchObject({ template: '/api/events', protected: true });
    expect(classifyRoute('POST', '/api/auth/logout').protected).toBe(true);
    expect(classifyRoute('GET', '/api/admin/users').protected).toBe(true);
    expect(classifyRoute('POST', '/api/auth/exchange').protected).toBe(false);
    expect(classifyRoute('GET', '/api/modules').protected).toBe(false);
    expect(classifyRoute('POST', '/api/c4/validate')).toMatchObject({ compute: true, protected: false });
    expect(classifyRoute('POST', '/api/trace').compute).toBe(true);
    expect(classifyRoute('GET', '/api/c4/schema').compute).toBe(false);
    for (const path of ['/healthz', '/readyz', '/metrics']) expect(classifyRoute('GET', path).operational).toBe(true);
    expect(classifyRoute('GET', '/api/modules').operational).toBe(false);
  });

  it('un identificador que no es válido no llega a los parámetros (nunca texto libre)', () => {
    for (const bad of ['con espacio', 'a..b', '.oculto', 'x'.repeat(200), 'a;b', '%00', 'CON', 'ñandú']) {
      const found = classifyRoute('GET', `/api/projects/${encodeURIComponent(bad)}/diagrams/${encodeURIComponent(bad)}`);
      expect(found.template).toBe('/api/projects/:project/diagrams/:diagram');
      expect(found.params).toEqual({});
    }
    const login = classifyRoute('PUT', `/api/projects/tienda/members/${encodeURIComponent('a b\n"x')}`);
    expect(login.params).toEqual({ project: 'tienda' });
    expect(classifyRoute('PUT', `/api/admin/users/${'a'.repeat(80)}`).params).toEqual({});
  });

  it('mil rutas inventadas dan solo plantillas del conjunto cerrado, sin nada de lo que se escribió en ellas', () => {
    let seed = 42;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const words = ['api', 'projects', 'auth', 'admin', 'users', 'github', 'diagrams', 'members', 'bundle', 'run', 'validate', 'export', 'import', 'diff', 'schema', 'capabilities', 'trace', 'whoami', 'events', 'modules', 'assets', 'metrics', 'healthz', '..', '.', '%2e%2e', '%00', '%0a', '%E2%80%A8', '%zz', 'ñandú', '', 'x'.repeat(300), '{"a":1}', 'token=abc', 'ana', 'tienda', '0', '-1'];
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const depth = 1 + Math.floor(random() * 6);
      const path = `/${Array.from({ length: depth }, () => (random() < 0.4 ? `${words[Math.floor(random() * words.length)]}${Math.floor(random() * 1000)}` : words[Math.floor(random() * words.length)])).join('/')}`;
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        const { template } = classifyRoute(method, path);
        expect(TEMPLATES.has(template), `${method} ${path} → ${template}`).toBe(true);
        seen.add(template);
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(8); // y las inventadas dieron de verdad varias formas
  });
});
