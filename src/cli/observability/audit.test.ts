import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AuditLog, ACTIONS, deriveAudit, type Actor, type FinishedRequest } from './audit';
import { Metrics } from './metrics';
import { classifyRoute } from './route';
import { memorySink } from '../../../tests/helpers/observability';

const ANA: Actor = { kind: 'user', id: 'u_1', login: 'ana', role: 'admin' };
const BETO: Actor = { kind: 'user', id: 'u_2', login: 'beto', role: 'member' };
const TOKEN: Actor = { kind: 'token', name: 'servicio', role: 'admin' };
const ANON: Actor = { kind: 'anonymous' };

const finished = (method: string, path: string, status: number, over: Partial<FinishedRequest> = {}): FinishedRequest => ({ method, route: classifyRoute(method, path), status, actor: ANA, ...over });
const derive = (...args: Parameters<typeof finished>) => deriveAudit(finished(...args));

describe('deriveAudit: qué petición es qué fila', () => {
  it('las lecturas, las peticiones que salen bien sin ser un cambio y las 429 no dejan fila', () => {
    expect(derive('GET', '/api/projects', 200)).toEqual([]);
    expect(derive('GET', '/api/projects/tienda/members', 200)).toEqual([]);
    expect(derive('POST', '/api/c4/validate', 200)).toEqual([]);
    expect(derive('POST', '/api/projects', 429, { actor: ANON, errorCode: 'rate-limited', authFailure: 'rate_limited' })).toEqual([]);
    expect(derive('GET', '/api/projects', 401, { actor: ANON, authFailure: 'missing' })).toEqual([]);
  });

  it('un cambio que sale bien: la acción, el resultado ok y el objetivo (el que se creó sale de Location)', () => {
    expect(derive('POST', '/api/projects', 201, { location: '/api/projects/tienda' })).toEqual([{ action: 'project.create', result: 'ok', target: { project: 'tienda', diagram: undefined, login: undefined } }]);
    expect(derive('POST', '/api/projects/tienda/diagrams', 201, { location: '/api/projects/tienda/diagrams/contexto' })[0]).toMatchObject({ action: 'diagram.create', target: { project: 'tienda', diagram: 'contexto' } });
    expect(derive('POST', '/api/projects/import', 201, { location: '/api/projects/importado?x=1' })[0]).toMatchObject({ action: 'project.import', target: { project: 'importado' } });
    expect(derive('DELETE', '/api/projects/tienda', 200)[0]).toMatchObject({ action: 'project.delete', result: 'ok', target: { project: 'tienda' } });
    expect(derive('POST', '/api/auth/logout', 200)[0]).toMatchObject({ action: 'auth.logout', result: 'ok' });
  });

  it('un Location que no es un identificador válido no se convierte en objetivo', () => {
    const rows = derive('POST', '/api/projects', 201, { location: '/api/projects/con espacio\n{"a":1}' });
    expect(rows[0].target?.project).toBeUndefined();
  });

  it('el resultado: 401 y 403 son denied; 404 solo si una persona sin rol de administración no pertenece al proyecto; el resto de fallos, error con su código', () => {
    expect(derive('POST', '/api/projects', 401, { actor: ANON, errorCode: 'unauthorized' })[0]).toMatchObject({ result: 'denied', code: 'unauthorized' });
    expect(derive('POST', '/api/projects', 403, { actor: TOKEN, errorCode: 'forbidden' })[0]).toMatchObject({ result: 'denied', code: 'forbidden' });
    expect(derive('GET', '/api/projects/x/bundle', 404, { actor: BETO, errorCode: 'not-found' })[0]).toMatchObject({ action: 'project.export', result: 'denied', code: 'not-found' });
    expect(derive('GET', '/api/projects/x/bundle', 404, { actor: ANA, errorCode: 'not-found' })[0]).toMatchObject({ result: 'error', code: 'not-found' });
    expect(derive('GET', '/api/projects/x/bundle', 404, { actor: TOKEN, errorCode: 'not-found' })[0]).toMatchObject({ result: 'error' });
    expect(derive('DELETE', '/api/admin/users/x', 404, { actor: BETO, errorCode: 'not-found' })[0]).toMatchObject({ result: 'error' });
    expect(derive('PATCH', '/api/projects/tienda', 409, { errorCode: 'conflict' })[0]).toMatchObject({ result: 'error', code: 'conflict' });
    expect(derive('PATCH', '/api/projects/tienda', 500)[0]).toMatchObject({ result: 'error', code: 'http-500' });
    expect(derive('PATCH', '/api/projects/tienda', 400, { errorCode: 'invalid' })[0]).toMatchObject({ result: 'error', code: 'invalid' });
  });

  it('compartir: alta (201), cambio de rol (200) o intento rechazado (member.set); el rol sale del cuerpo solo si es uno de los tres', () => {
    const body = JSON.stringify({ role: 'viewer', nota: 'texto libre que no debe salir' });
    expect(derive('PUT', '/api/projects/tienda/members/beto', 201, { body })).toEqual([{ action: 'member.add', result: 'ok', target: { project: 'tienda', diagram: undefined, login: 'beto' }, change: { role: 'viewer' } }]);
    expect(derive('PUT', '/api/projects/tienda/members/beto', 200, { body })[0]).toMatchObject({ action: 'member.role', change: { role: 'viewer' } });
    expect(derive('PUT', '/api/projects/tienda/members/beto', 403, { body, errorCode: 'forbidden' })[0]).toMatchObject({ action: 'member.set', result: 'denied', change: { role: 'viewer' } });
    for (const bad of [JSON.stringify({ role: 'dios' }), JSON.stringify({ role: 7 }), '{no es json', '[]', '"admin"', undefined]) {
      expect(derive('PUT', '/api/projects/tienda/members/beto', 400, { body: bad, errorCode: 'invalid' })[0].change?.role, String(bad)).toBeUndefined();
    }
    expect(JSON.stringify(derive('PUT', '/api/projects/tienda/members/beto', 201, { body }))).not.toContain('texto libre');
    expect(derive('DELETE', '/api/projects/tienda/members/beto', 200)[0]).toMatchObject({ action: 'member.remove', target: { project: 'tienda', login: 'beto' } });
  });

  it('cuentas: invitar (201), cambiar rol, desactivar y reactivar; una petición con dos cambios deja dos filas', () => {
    expect(derive('PUT', '/api/admin/users/dani', 201, { body: JSON.stringify({ siteRole: 'guest' }) })).toEqual([{ action: 'user.invite', result: 'ok', target: { project: undefined, diagram: undefined, login: 'dani' }, change: { siteRole: 'guest' } }]);
    expect(derive('PUT', '/api/admin/users/dani', 200, { body: JSON.stringify({ siteRole: 'admin' }) }).map((r) => r.action)).toEqual(['user.role']);
    expect(derive('PUT', '/api/admin/users/dani', 200, { body: JSON.stringify({ disabled: true }) })[0]).toMatchObject({ action: 'user.disable', change: { disabled: true } });
    expect(derive('PUT', '/api/admin/users/dani', 200, { body: JSON.stringify({ disabled: false }) })[0]).toMatchObject({ action: 'user.enable', change: { disabled: false } });
    expect(derive('PUT', '/api/admin/users/dani', 200, { body: JSON.stringify({ siteRole: 'member', disabled: true }) }).map((r) => r.action)).toEqual(['user.role', 'user.disable']);
    expect(derive('PUT', '/api/admin/users/dani', 409, { body: JSON.stringify({ siteRole: 'guest', disabled: true }), errorCode: 'self' }).map((r) => [r.action, r.result, r.code])).toEqual([['user.role', 'error', 'self'], ['user.disable', 'error', 'self']]);
    // si no se leyó el cuerpo (403 antes de leerlo) o no dice nada que entendamos, queda una sola fila genérica
    expect(derive('PUT', '/api/admin/users/dani', 403, { actor: BETO, errorCode: 'forbidden' }).map((r) => [r.action, r.result])).toEqual([['user.set', 'denied']]);
    expect(derive('PUT', '/api/admin/users/dani', 400, { body: JSON.stringify({ siteRole: 'dios', disabled: 'sí' }), errorCode: 'invalid' }).map((r) => r.action)).toEqual(['user.set']);
    expect(derive('DELETE', '/api/admin/users/dani', 200)[0]).toMatchObject({ action: 'user.remove', target: { login: 'dani' } });
  });

  it('las rutas de cálculo solo dejan fila cuando se deniegan (compute.denied); las protegidas sin acción, cuando la credencial es falsa o el rol no alcanza (auth.denied)', () => {
    expect(derive('POST', '/api/c4/validate', 401, { actor: ANON, errorCode: 'unauthorized', authFailure: 'missing' })).toEqual([{ action: 'compute.denied', result: 'denied', code: 'unauthorized' }]);
    expect(derive('POST', '/api/trace', 403, { actor: TOKEN, errorCode: 'forbidden' })[0]).toMatchObject({ action: 'compute.denied', code: 'forbidden' });
    expect(derive('POST', '/api/c4/validate', 422, { errorCode: 'invalid' })).toEqual([]);
    expect(derive('GET', '/api/whoami', 401, { actor: ANON, errorCode: 'unauthorized', authFailure: 'invalid' })[0]).toMatchObject({ action: 'auth.denied', result: 'denied', code: 'unauthorized' });
    expect(derive('GET', '/api/whoami', 401, { actor: ANON, errorCode: 'unauthorized', authFailure: 'missing' })).toEqual([]);
    expect(derive('GET', '/api/admin/users', 403, { actor: BETO, errorCode: 'forbidden' })[0]).toMatchObject({ action: 'auth.denied', code: 'forbidden' });
    expect(derive('GET', '/api/projects', 401, { actor: ANON, errorCode: 'unauthorized', authFailure: 'invalid' })[0]).toMatchObject({ action: 'auth.denied' });
  });

  it('un cambio denegado deja una sola fila (la de su acción), no además un auth.denied', () => {
    expect(derive('POST', '/api/projects', 401, { actor: ANON, errorCode: 'unauthorized', authFailure: 'invalid' }).map((r) => r.action)).toEqual(['project.create']);
  });
});

describe('ACTIONS: toda ruta documentada que cambia algo está en la tabla', () => {
  const docs = ['docs/proyectos.md', 'docs/cuentas-github.md'].map((file) => readFileSync(file, 'utf8')).join('\n');
  const METHODS = 'GET|POST|PUT|PATCH|DELETE';
  const documented = new Set<string>();
  for (const match of docs.matchAll(new RegExp(`\`((?:${METHODS})(?:\\\\\\|(?:${METHODS}))*) (/api/[^\`\\s]*)\``, 'g'))) {
    const path = match[2].replace(/\[\?[^\]]*\]|\?.*$/g, '').replace('<p>', 'tienda').replace('<d>', 'contexto').replace('<usuario>', 'beto');
    for (const method of match[1].split('\\|')) documented.add(`${method} ${classifyRoute(method, path).template}`);
  }

  it('las rutas documentadas son las que se esperan (si cambia la documentación, esta lista se revisa)', () => {
    expect(documented.size).toBeGreaterThan(15);
    expect(documented).toContain('PUT /api/projects/:project/members/:login');
    expect(documented).toContain('PUT /api/admin/users/:login');
    expect(documented).toContain('DELETE /api/projects/:project/diagrams/:diagram');
    expect([...documented].filter((entry) => entry.endsWith('/*'))).toEqual([]);
  });

  it('cada una que no es GET figura en ACTIONS (salvo el cambio del código por una sesión, que anota el manejador de /api/auth)', () => {
    const annotatedByHandlers = new Set(['POST /api/auth/exchange']);
    const missing = [...documented].filter((entry) => !entry.startsWith('GET ') && !annotatedByHandlers.has(entry) && !(entry in ACTIONS));
    expect(missing).toEqual([]);
  });

  it('y cada fila de ACTIONS corresponde a una ruta documentada (sin erratas ni rutas que ya no existen)', () => {
    const undocumented = Object.keys(ACTIONS).filter((entry) => !documented.has(entry));
    expect(undocumented).toEqual([]);
  });
});

describe('AuditLog', () => {
  it('escribe una línea JSON con los campos en orden fijo, sin target ni change vacíos, y cuenta la fila en las métricas', () => {
    const sink = memorySink();
    const metrics = new Metrics('x');
    const log = new AuditLog(sink, metrics, () => new Date('2025-01-02T03:04:05.678Z'));
    log.record({ action: 'member.add', result: 'ok', actor: ANA, target: { project: 'tienda', login: 'beto' }, change: { role: 'viewer' } }, { requestId: 'r1', status: 201 });
    log.record({ action: 'project.create', result: 'denied', code: 'forbidden', actor: ANON, target: { project: undefined }, change: {} }, { requestId: 'r2', status: 403 });
    expect(sink.lines).toEqual([
      '{"ts":"2025-01-02T03:04:05.678Z","type":"audit","requestId":"r1","action":"member.add","result":"ok","status":201,"actor":{"kind":"user","id":"u_1","login":"ana","role":"admin"},"target":{"project":"tienda","login":"beto"},"change":{"role":"viewer"}}',
      '{"ts":"2025-01-02T03:04:05.678Z","type":"audit","requestId":"r2","action":"project.create","result":"denied","status":403,"code":"forbidden","actor":{"kind":"anonymous"}}',
    ]);
    expect(metrics.auditEvents.get({ action: 'member.add', result: 'ok' })).toBe(1);
    expect(metrics.auditEvents.get({ action: 'project.create', result: 'denied' })).toBe(1);
  });

  it('una línea es una línea aunque un campo traiga saltos de línea o separadores; sin destino solo se cuenta', () => {
    const sink = memorySink();
    new AuditLog(sink).record({ action: 'a\nb', result: 'error', code: 'x\u2028y', actor: { kind: 'token', name: 'n\r\n"m"', role: 'admin' } }, { requestId: 'r', status: 500 });
    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]).not.toMatch(/[\n\r\u0085\u2028\u2029]/);
    const metrics = new Metrics('x');
    new AuditLog(undefined, metrics).record({ action: 'project.create', result: 'ok', actor: ANA }, { requestId: 'r', status: 201 });
    expect(metrics.auditEvents.get({ action: 'project.create', result: 'ok' })).toBe(1);
  });
});
