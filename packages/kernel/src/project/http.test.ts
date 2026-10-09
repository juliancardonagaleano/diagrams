import { describe, expect, it, vi } from 'vitest';
import { HttpProjectStore, normalizeBaseUrl } from './http';
import { ProjectError } from './errors';

/** Un `fetch` que responde lo que se le diga y recuerda las peticiones. */
function fakeFetch(respond: (url: string, init: RequestInit) => { status?: number; body?: unknown; text?: string; headers?: Record<string, string> } | Error) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const out = respond(url, init);
    if (out instanceof Error) throw out;
    const text = out.text ?? (out.body === undefined ? '' : JSON.stringify(out.body));
    return new Response(text, { status: out.status ?? 200, headers: out.headers });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const store = (respond: Parameters<typeof fakeFetch>[0], options: { token?: string; baseUrl?: string } = {}) => {
  const { fetch, calls } = fakeFetch(respond);
  return { store: new HttpProjectStore({ baseUrl: options.baseUrl ?? 'https://iark.example/', token: options.token, fetch }), calls };
};

const failure = async (promise: Promise<unknown>): Promise<ProjectError> => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ProjectError);
  return error as ProjectError;
};

describe('normalizeBaseUrl', () => {
  it('deja el origen (y la ruta de un proxy), sin barra final ni la ruta de la API', () => {
    expect(normalizeBaseUrl(' https://iark.example/ ')).toBe('https://iark.example');
    expect(normalizeBaseUrl('https://iark.example/api/projects/')).toBe('https://iark.example');
    expect(normalizeBaseUrl('http://localhost:8787')).toBe('http://localhost:8787');
    expect(normalizeBaseUrl('https://example.org/iark/api')).toBe('https://example.org/iark');
  });

  it('rechaza lo que no es una dirección http(s) y las que llevan usuario o contraseña', () => {
    for (const bad of ['', 'iark.example', 'ftp://iark.example', 'javascript:alert(1)', 'https://user:pass@iark.example']) {
      expect(() => normalizeBaseUrl(bad), bad).toThrow(ProjectError);
    }
  });
});

describe('HttpProjectStore', () => {
  it('pide cada operación a su ruta, con los ids codificados y el cuerpo que espera la API', async () => {
    const { store: s, calls } = store((url, init) => {
      if (init.method === 'POST' && url.endsWith('/api/projects')) return { status: 201, body: { id: 'tienda', name: 'Tienda', diagrams: [] } };
      return { body: { id: 'x' } };
    });
    await s.listProjects();
    await s.createProject({ name: 'Tienda', description: 'Pedidos' });
    await s.renameProject('a b', 'Otro');
    await s.saveDiagram('p', { module: 'c4', name: 'Contexto', text: '{}' });
    await s.saveDiagram('p', { id: 'd/1', text: '{"a":1}', ifUpdatedAt: '2026-01-01T00:00:00.000Z' });
    await s.renameDiagram('p', 'd', 'Nuevo');
    await s.deleteDiagram('p', 'd');
    await s.deleteProject('p');
    expect(calls.map((c) => `${c.init.method} ${c.url.replace('https://iark.example', '')}`)).toEqual([
      'GET /api/projects',
      'POST /api/projects',
      'PATCH /api/projects/a%20b',
      'POST /api/projects/p/diagrams',
      'PUT /api/projects/p/diagrams/d%2F1',
      'PATCH /api/projects/p/diagrams/d',
      'DELETE /api/projects/p/diagrams/d',
      'DELETE /api/projects/p',
    ]);
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ name: 'Tienda', description: 'Pedidos' });
    expect(JSON.parse(String(calls[3].init.body))).toEqual({ module: 'c4', name: 'Contexto', text: '{}' });
    expect(JSON.parse(String(calls[4].init.body))).toEqual({ text: '{"a":1}', ifUpdatedAt: '2026-01-01T00:00:00.000Z' });
  });

  it('manda el token como Bearer, JSON también en DELETE, y nunca cookies ni credenciales', async () => {
    const { store: s, calls } = store(() => ({ body: [] }), { token: ' iark_secreto ' });
    await s.listProjects();
    await s.deleteProject('p');
    const [get, del] = calls.map((c) => ({ headers: c.init.headers as Record<string, string>, credentials: (c.init as { credentials?: string }).credentials }));
    expect(get.headers.Authorization).toBe('Bearer iark_secreto');
    expect(get.headers['Content-Type']).toBeUndefined();
    expect(del.headers['Content-Type']).toBe('application/json');
    expect([get.credentials, del.credentials]).toEqual(['omit', 'omit']);
    const anonymous = store(() => ({ body: [] }));
    await anonymous.store.listProjects();
    expect((anonymous.calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('traduce los errores del servidor a los códigos del contrato', async () => {
    const cases: Array<[number, unknown, string]> = [
      [404, { error: 'No existe', code: 'not-found' }, 'not-found'],
      [409, { error: 'Ya existe', code: 'exists' }, 'exists'],
      [409, { error: 'Cambió', code: 'conflict' }, 'conflict'],
      [400, { error: 'Mal', code: 'invalid' }, 'invalid'],
      [400, { error: 'Id inválido' }, 'invalid'],
      [413, { error: 'Grande' }, 'invalid'],
      [401, { error: 'Falta token', code: 'unauthorized' }, 'unauthorized'],
      [403, { error: 'Sin permiso', code: 'forbidden' }, 'forbidden'],
      [403, { error: 'Origen no autorizado «https://x.org»' }, 'forbidden'],
      [429, { error: 'Calma', code: 'rate-limited' }, 'unavailable'],
      [404, { error: 'Este servicio no tiene espacio de trabajo (use --workspace <carpeta>)' }, 'unavailable'],
      [500, { error: 'Fallo', code: 'unavailable' }, 'unavailable'],
      [502, '<html>Bad gateway</html>', 'unavailable'],
    ];
    for (const [status, body, code] of cases) {
      const s = store(() => (typeof body === 'string' ? { status, text: body } : { status, body })).store;
      const error = await failure(s.createProject({ name: 'x' }));
      expect(error.code, `${status} ${JSON.stringify(body)}`).toBe(code);
      if (typeof body === 'object' && body && 'error' in body) expect(error.message).toContain(String(body.error));
    }
  });

  it('el 429 dice cuánto esperar y un 401 sin mensaje lo explica', async () => {
    const limited = store(() => ({ status: 429, body: {}, headers: { 'Retry-After': '12' } })).store;
    const limitedError = await failure(limited.listProjects());
    expect(limitedError.message).toContain('12 s');
    expect(limitedError.info).toMatchObject({ status: 429, retryAfterSec: 12 }); // quien reintenta respeta la espera
    const sinEspera = await failure(store(() => ({ status: 429, body: {} })).store.listProjects());
    expect(sinEspera.info.retryAfterSec).toBeUndefined();
    const noToken = store(() => ({ status: 401, body: {} })).store;
    expect((await failure(noToken.listProjects())).message).toContain('token');
  });

  it('una lectura de algo que no existe (o de un id que el servidor no acepta) es `undefined`; otros fallos siguen siéndolo', async () => {
    const missing = store(() => ({ status: 404, body: { error: 'No existe', code: 'not-found' } })).store;
    expect(await missing.getProject('x')).toBeUndefined();
    expect(await missing.getDiagram('x', 'y')).toBeUndefined();
    const badId = store(() => ({ status: 400, body: { error: 'Identificador inválido' } })).store;
    expect(await badId.getProject('../x')).toBeUndefined();
    const denied = store(() => ({ status: 401, body: { error: 'x', code: 'unauthorized' } })).store;
    expect((await failure(denied.getProject('x'))).code).toBe('unauthorized');
  });

  it('un fallo de red o de tiempo es `unavailable` con la dirección, y una respuesta que no es JSON no se da por buena', async () => {
    const offline = store(() => new TypeError('fetch failed')).store;
    const error = await failure(offline.listProjects());
    expect(error).toMatchObject({ code: 'unavailable' });
    expect(error.message).toContain('https://iark.example');
    expect(error.message).toContain('fetch failed');
    const timeout = store(() => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })).store;
    expect((await failure(timeout.listProjects())).message).toContain('no respondió');
    const html = store(() => ({ text: '<html>login</html>' })).store;
    expect((await failure(html.listProjects())).message).toContain('no es JSON');
  });

  it('cambiar el módulo de un diagrama al guardarlo se rechaza sin llegar a escribir', async () => {
    const { store: s, calls } = store((_url, init) => (init.method === 'GET' ? { body: { id: 'd', module: 'c4', name: 'A', text: '{}' } } : { body: {} }));
    expect((await failure(s.saveDiagram('p', { id: 'd', module: 'data', text: 'x' }))).code).toBe('invalid');
    expect(calls.map((c) => c.init.method)).toEqual(['GET']);
    await s.saveDiagram('p', { id: 'd', module: 'c4', text: 'x' }); // el mismo módulo es válido
    expect(calls.map((c) => c.init.method)).toEqual(['GET', 'GET', 'PUT']);
  });

  it('whoami lee quién es el token; con un servidor anterior a la autenticación comprueba que ofrezca proyectos', async () => {
    const auth = store(() => ({ body: { auth: true, name: 'ana', role: 'editor' } }), { token: 'iark_x' }).store;
    expect(await auth.whoami()).toEqual({ auth: true, name: 'ana', role: 'editor' });
    const open = store(() => ({ body: { auth: false } })).store;
    expect(await open.whoami()).toEqual({ auth: false, name: undefined, role: undefined });
    const legacy = store((url) => (url.endsWith('/api/whoami') ? { status: 404, body: { error: 'módulo desconocido' } } : { body: [] })).store;
    expect((await legacy.whoami()).auth).toBe(false);
    const locked = store(() => ({ status: 401, body: { error: 'Token inválido', code: 'unauthorized' } })).store;
    expect((await failure(locked.whoami())).code).toBe('unauthorized');
  });

  it('los proyectos de un servidor con cuentas traen el rol de quien pregunta, tal cual', async () => {
    const { store: s } = store(() => ({ body: [{ id: 'tienda', name: 'Tienda', diagrams: [], role: 'admin' }, { id: 'viejo', name: 'Viejo', diagrams: [] }] }), { token: 'iark_s_x' });
    const [first, second] = await s.listProjects();
    expect(first.role).toBe('admin');
    expect(second.role).toBeUndefined();
  });

  it('whoami de una sesión de persona trae quién es; con un token de iark auth sigue sin `user`', async () => {
    const user = { id: 'u_1', login: 'ana', name: 'Ana', avatarUrl: 'https://avatars.example/u/1', siteRole: 'member' };
    const session = store(() => ({ body: { auth: true, name: 'Ana', role: 'member', user } }), { token: 'iark_s_x' }).store;
    expect(await session.whoami()).toEqual({ auth: true, name: 'Ana', role: 'member', user });
    const token = store(() => ({ body: { auth: true, name: 'ci', role: 'editor' } }), { token: 'iark_x' }).store;
    expect(await token.whoami()).toEqual({ auth: true, name: 'ci', role: 'editor' });
    expect((await token.whoami()).user).toBeUndefined();
    // un `user` que no tiene lo mínimo se ignora y un rol desconocido es el de menos permisos
    const broken = store(() => ({ body: { auth: true, name: 'x', role: 'admin', user: { login: 7 } } })).store;
    expect((await broken.whoami()).user).toBeUndefined();
    const odd = store(() => ({ body: { auth: true, user: { id: 'u', login: 'x', siteRole: 'superman' } } })).store;
    expect((await odd.whoami()).user?.siteRole).toBe('guest');
  });
});

describe('HttpProjectStore: inicio de sesión (cuentas)', () => {
  it('providers consulta una ruta pública sin mandar el token, y lee lo que ofrece el servidor', async () => {
    const { store: s, calls } = store(() => ({ body: { providers: [{ id: 'github', label: 'GitHub' }, { nope: 1 }], tokens: false, signup: 'invite' } }), { token: 'iark_s_viejo' });
    expect(await s.providers()).toEqual({ providers: [{ id: 'github', label: 'GitHub' }], tokens: false, signup: 'invite' });
    expect(calls[0].url).toBe('https://iark.example/api/auth/providers');
    expect(calls[0].init.method).toBe('GET');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
    const selfHosted = store(() => ({ body: { providers: [], tokens: true } })).store;
    expect(await selfHosted.providers()).toEqual({ providers: [], tokens: true });
  });

  it('providers: un servidor anterior a las cuentas (o un sitio que no es DIAgrams) no ofrece ningún inicio de sesión; la red caída sí es un fallo', async () => {
    const legacy = store(() => ({ status: 404, body: { error: 'Ruta de la API desconocida. Ver /api/modules.' } })).store;
    expect(await legacy.providers()).toEqual({ providers: [], tokens: true });
    const pages = store(() => ({ status: 404, text: '<html>404 File not found</html>' })).store;
    expect(await pages.providers()).toEqual({ providers: [], tokens: true });
    expect((await failure(store(() => new TypeError('Failed to fetch')).store.providers())).info.network).toBe(true);
    expect((await failure(store(() => ({ text: '<html>app</html>' })).store.providers())).message).toContain('no es JSON');
    expect((await failure(store(() => ({ status: 500, body: { error: 'x' } })).store.providers())).code).toBe('unavailable');
  });

  it('exchangeLoginCode manda { code, verifier } como JSON, sin Authorization, y devuelve la sesión', async () => {
    const grant = { token: 'iark_s_abc', expiresAt: '2026-11-05T00:00:00.000Z', user: { id: 'u_1', login: 'ana', siteRole: 'admin' } };
    const { store: s, calls } = store(() => ({ body: grant }), { token: 'iark_s_viejo' });
    expect(await s.exchangeLoginCode({ code: 'c0d3', verifier: 'v'.repeat(43) })).toEqual(grant);
    expect(calls[0].url).toBe('https://iark.example/api/auth/exchange');
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBeUndefined(); // ni siquiera el token de antes: la ruta es pública
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ code: 'c0d3', verifier: 'v'.repeat(43) });
  });

  it('exchangeLoginCode: un código que no vale es `invalid` (con su código de servidor), el 429 dice cuánto esperar y una respuesta sin sesión no se da por buena', async () => {
    const bad = await failure(store(() => ({ status: 400, body: { error: 'El código de inicio de sesión no es válido o caducó: vuelve a iniciar sesión.', code: 'invalid-grant' } })).store.exchangeLoginCode({ code: 'x', verifier: 'v' }));
    expect(bad).toMatchObject({ code: 'invalid', info: { status: 400, serverCode: 'invalid-grant' } });
    expect(bad.message).toContain('caducó');
    const limited = await failure(store(() => ({ status: 429, body: { error: 'Demasiados intentos', code: 'rate-limited' }, headers: { 'Retry-After': '30' } })).store.exchangeLoginCode({ code: 'x', verifier: 'v' }));
    expect(limited.code).toBe('unavailable');
    expect(limited.message).toContain('Demasiados intentos');
    const empty = await failure(store(() => ({ body: { ok: true } })).store.exchangeLoginCode({ code: 'x', verifier: 'v' }));
    expect(empty.code).toBe('unavailable');
    expect(empty.message).toContain('falta la sesión');
  });

  it('logout cierra la sesión que se usa (con su Authorization) y un token que no es una sesión lo rechaza', async () => {
    const { store: s, calls } = store(() => ({ body: { loggedOut: true } }), { token: 'iark_s_abc' });
    await s.logout();
    expect(calls[0].url).toBe('https://iark.example/api/auth/logout');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer iark_s_abc');
    const notSession = store(() => ({ status: 400, body: { error: 'Este token no es una sesión', code: 'not-a-session' } }), { token: 'iark_x' }).store;
    expect((await failure(notSession.logout())).code).toBe('invalid');
    const expired = store(() => ({ status: 401, body: { error: 'Falta un token válido', code: 'unauthorized' } }), { token: 'iark_s_caducada' }).store;
    expect((await failure(expired.logout())).code).toBe('unauthorized');
  });
});

describe('HttpProjectStore: compartir un proyecto (cuentas)', () => {
  const ana = { login: 'ana', name: 'Ana', avatarUrl: 'https://avatars.example/u/1', role: 'admin', pending: false, you: true };
  const beto = { login: 'beto', role: 'editor', pending: true };

  it('pide cada operación a su ruta, con el proyecto y el usuario codificados, y el cuerpo que espera la API', async () => {
    const { store: s, calls } = store((_url, init) => (init.method === 'GET' ? { body: [ana, beto] } : init.method === 'DELETE' ? { body: { removed: 'beto' } } : { status: 201, body: beto }));
    expect(await s.listMembers('a b')).toEqual([{ ...ana }, { login: 'beto', role: 'editor', pending: true }]);
    expect(await s.setMember('a b', ' @beto ', 'editor')).toEqual({ login: 'beto', role: 'editor', pending: true });
    await s.removeMember('p', 'be/to');
    expect(calls.map((c) => `${c.init.method} ${c.url.replace('https://iark.example', '')}`)).toEqual([
      'GET /api/projects/a%20b/members',
      'PUT /api/projects/a%20b/members/beto',
      'DELETE /api/projects/p/members/be%2Fto',
    ]);
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ role: 'editor' });
    expect((calls[2].init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('lo que llega mal formado no rompe la lista: se descartan las entradas sin usuario y un rol desconocido es el de menos permisos', async () => {
    const { store: s } = store(() => ({ body: [{ login: 'x', role: 'dios', pending: 'sí' }, { role: 'admin' }, 7, null] }));
    expect(await s.listMembers('p')).toEqual([{ login: 'x', role: 'viewer', pending: false }]);
    expect(await store(() => ({ body: { nope: 1 } })).store.listMembers('p')).toEqual([]);
    expect((await failure(store(() => ({ body: { nope: 1 } })).store.setMember('p', 'x', 'viewer'))).code).toBe('unavailable');
  });

  it('un nombre de usuario vacío se rechaza sin llegar al servidor', async () => {
    const { store: s, calls } = store(() => ({ body: {} }));
    expect((await failure(s.setMember('p', '  @ ', 'viewer'))).code).toBe('invalid');
    expect((await failure(s.removeMember('p', ''))).code).toBe('invalid');
    expect(calls).toEqual([]);
  });

  it('traduce los errores de compartir: último administrador → conflict, tope → invalid (nunca forbidden), permiso → forbidden', async () => {
    const cases: Array<[number, unknown, string, string | undefined]> = [
      [409, { error: 'No se puede dejar al proyecto sin administrador.', code: 'last-admin' }, 'conflict', 'last-admin'],
      [409, { error: 'Un proyecto admite hasta 50 personas.', code: 'limit' }, 'invalid', 'limit'],
      [403, { error: 'Solo un administrador del proyecto puede compartirlo.', code: 'forbidden' }, 'forbidden', undefined],
      [404, { error: 'No existe el proyecto «p».', code: 'not-found' }, 'not-found', undefined],
      [400, { error: 'Nombre de usuario de GitHub inválido.', code: 'invalid' }, 'invalid', undefined],
      [401, { error: 'Falta un token válido.', code: 'unauthorized' }, 'unauthorized', undefined],
    ];
    for (const [status, body, code, serverCode] of cases) {
      const error = await failure(store(() => ({ status, body })).store.setMember('p', 'beto', 'editor'));
      expect(error.code, JSON.stringify(body)).toBe(code);
      expect(error.info.serverCode).toBe(serverCode);
      expect(error.message).toContain((body as { error: string }).error);
    }
    const removed = await failure(store(() => ({ status: 409, body: { error: 'último', code: 'last-admin' } })).store.removeMember('p', 'ana'));
    expect(removed.code).toBe('conflict');
  });

  it('el tope de proyectos al crear (403 `limit`) es `invalid` y no se confunde con un rol que no alcanza', async () => {
    const error = await failure(store(() => ({ status: 403, body: { error: 'Ya administras 25 proyectos, el máximo por persona en esta instancia.', code: 'limit' } })).store.createProject({ name: 'Otro' }));
    expect(error).toMatchObject({ code: 'invalid', info: { status: 403, serverCode: 'limit' } });
    expect(error.message).toContain('Ya administras 25 proyectos');
  });
});

describe('HttpProjectStore: administrar las cuentas de la instancia', () => {
  const ana = { id: 'u_1', login: 'ana', name: 'Ana', avatarUrl: 'https://avatars.example/u/1', siteRole: 'admin', disabled: false, pending: false, listed: true, createdAt: '2026-01-01T00:00:00.000Z', lastLoginAt: '2026-02-01T10:00:00.000Z', projects: 3 };
  const carla = { id: 'u_2', login: 'carla', siteRole: 'guest', disabled: false, pending: true, createdAt: '2026-01-02T00:00:00.000Z', projects: 0 };

  it('listAccounts pide /api/admin/users con el token y lee todos los campos; lo opcional que falta queda sin definir', async () => {
    const { store: s, calls } = store(() => ({ body: [ana, carla] }), { token: 'iark_s_abc' });
    expect(await s.listAccounts()).toEqual([
      { ...ana, listed: true },
      { id: 'u_2', login: 'carla', siteRole: 'guest', disabled: false, pending: true, listed: false, createdAt: '2026-01-02T00:00:00.000Z', projects: 0 },
    ]);
    expect(calls[0].url).toBe('https://iark.example/api/admin/users');
    expect(calls[0].init.method).toBe('GET');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer iark_s_abc');
  });

  it('lo que llega mal formado no rompe la lista: se descartan las cuentas sin id o sin usuario y un rol desconocido es el de menos permisos', async () => {
    const { store: s } = store(() => ({ body: [{ id: 'u_9', login: 'x', siteRole: 'dios', projects: -4 }, { id: 'u_8' }, { login: 'sin-id' }, 7, null] }));
    expect(await s.listAccounts()).toEqual([{ id: 'u_9', login: 'x', siteRole: 'guest', disabled: false, pending: false, listed: false, createdAt: '', projects: 0 }]);
    expect(await store(() => ({ body: { nope: 1 } })).store.listAccounts()).toEqual([]);
    expect((await failure(store(() => ({ body: { nope: 1 } })).store.setAccount('x', { siteRole: 'member' }))).code).toBe('unavailable');
  });

  it('setAccount manda solo lo que cambia, con el usuario codificado, y distingue la invitación nueva (201) de la cuenta que ya existía (200)', async () => {
    const { store: s, calls } = store((_url, init) => ({ status: JSON.parse(String(init.body)).siteRole === 'guest' ? 201 : 200, body: carla }));
    expect(await s.setAccount(' @carla ', { siteRole: 'guest' })).toMatchObject({ created: true, account: { login: 'carla', pending: true } });
    expect(await s.setAccount('car/la', { disabled: true })).toMatchObject({ created: false });
    expect(calls.map((c) => `${c.init.method} ${c.url.replace('https://iark.example', '')}`)).toEqual(['PUT /api/admin/users/carla', 'PUT /api/admin/users/car%2Fla']);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ siteRole: 'guest' });
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ disabled: true });
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('cancelInvitation es un DELETE con JSON; un usuario vacío se rechaza sin llegar al servidor', async () => {
    const { store: s, calls } = store(() => ({ body: { removed: 'carla' } }));
    await s.cancelInvitation('@carla');
    expect(`${calls[0].init.method} ${calls[0].url}`).toBe('DELETE https://iark.example/api/admin/users/carla');
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((await failure(s.cancelInvitation(' @ '))).code).toBe('invalid');
    expect((await failure(s.setAccount('', { disabled: true }))).code).toBe('invalid');
    expect(calls).toHaveLength(1);
  });

  it('traduce los errores de administración: propia cuenta y lista de --admins → conflict (con su código), tope → invalid, no administra → forbidden', async () => {
    const cases: Array<[number, unknown, string, string | undefined]> = [
      [409, { error: 'No puedes cambiar tu propio rol ni desactivar tu propia cuenta.', code: 'self' }, 'conflict', 'self'],
      [409, { error: '«ana» figura en la lista de administradores.', code: 'listed-admin' }, 'conflict', 'listed-admin'],
      [409, { error: 'Esa persona ya entró: para quitarle el acceso, desactiva su cuenta.', code: 'conflict' }, 'conflict', undefined],
      [409, { error: 'El proyecto se quedaría sin administrador.', code: 'last-admin' }, 'conflict', 'last-admin'],
      [409, { error: 'Hay 500 invitaciones sin aceptar.', code: 'limit' }, 'invalid', 'limit'],
      [403, { error: 'Solo quien administra la instancia puede ver y cambiar las cuentas.', code: 'forbidden' }, 'forbidden', undefined],
      [404, { error: 'No existe la cuenta «x».', code: 'not-found' }, 'not-found', undefined],
      [400, { error: 'Rol inválido.', code: 'invalid' }, 'invalid', undefined],
      [401, { error: 'Falta un token válido.', code: 'unauthorized' }, 'unauthorized', undefined],
    ];
    for (const [status, body, code, serverCode] of cases) {
      const set = await failure(store(() => ({ status, body })).store.setAccount('x', { disabled: true }));
      expect(set.code, JSON.stringify(body)).toBe(code);
      expect(set.info).toMatchObject({ status, ...(serverCode ? { serverCode } : {}) });
      expect(set.message).toContain((body as { error: string }).error);
    }
    expect((await failure(store(() => ({ status: 403, body: { error: 'no', code: 'forbidden' } })).store.listAccounts())).code).toBe('forbidden');
    expect((await failure(store(() => ({ status: 409, body: { error: 'ya entró', code: 'conflict' } })).store.cancelInvitation('x'))).code).toBe('conflict');
  });

  it('un servicio sin cuentas responde 404 a la administración: es `unavailable`, con el mensaje del servidor', async () => {
    const error = await failure(store(() => ({ status: 404, body: { error: 'Este servicio no tiene cuentas de GitHub: la administración de cuentas solo existe con --accounts.' } })).store.listAccounts());
    expect(error).toMatchObject({ code: 'unavailable', info: { status: 404 } });
    expect(error.message).toContain('solo existe con --accounts');
  });
});

describe('HttpProjectStore: cuotas de uso', () => {
  const limits = { bytes: 268435456, projects: 25, diagramsPerProject: 200 };
  const usage = { bytes: 2400, documentBytes: 700, versionBytes: 1700, versions: 2, projects: 1 };

  it('usage() pide /api/usage con el token y lee topes, uso y desglose por proyecto; descarta lo que no tiene lo mínimo', async () => {
    const { store: s, calls } = store(
      () => ({ body: { limits, usage, projects: [{ id: 'p', name: 'Tienda', diagrams: 1, documentBytes: 700, versions: 2, versionBytes: 1700, bytes: 2400 }, { id: 'sin-bytes', name: 'Roto' }, 7, null] } }),
      { token: 'iark_s_abc' },
    );
    expect(await s.usage()).toEqual({ limits, usage, projects: [{ id: 'p', name: 'Tienda', diagrams: 1, documentBytes: 700, versions: 2, versionBytes: 1700, bytes: 2400 }] });
    expect(`${calls[0].init.method} ${calls[0].url}`).toBe('GET https://iark.example/api/usage');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer iark_s_abc');
  });

  it('un servidor sin cuotas por persona (404, con o sin código), o que responde otra cosa, no es un error: no hay nada que mostrar', async () => {
    expect(await store(() => ({ status: 404, body: { error: 'Ruta de la API desconocida.' } })).store.usage()).toBeUndefined();
    expect(await store(() => ({ status: 404, body: { error: 'Las cuotas son por persona.', code: 'not-found' } })).store.usage()).toBeUndefined();
    expect(await store(() => ({ body: { nope: 1 } })).store.usage()).toBeUndefined();
    expect(await store(() => ({ body: { limits: { bytes: -1, projects: 1, diagramsPerProject: 1 }, usage } })).store.usage()).toBeUndefined();
    // los demás fallos sí se cuentan: una sesión caducada o un servidor caído no se disfrazan de «sin cuotas»
    expect((await failure(store(() => ({ status: 401, body: { error: 'caducó' } })).store.usage())).code).toBe('unauthorized');
    expect((await failure(store(() => new Error('sin red')).store.usage())).info.network).toBe(true);
  });

  it('listAccounts lee la cuota personal, los topes y el uso de cada cuenta; con valores inválidos los ignora', async () => {
    const base = { id: 'u_1', login: 'ana', siteRole: 'member', disabled: false, pending: false, createdAt: '2026-01-01T00:00:00.000Z', projects: 2 };
    const { store: s } = store(() => ({
      body: [
        { ...base, quota: { bytes: 1000, diagramsPerProject: 0, projects: -3, discos: 9 }, limits, usage },
        { ...base, id: 'u_2', login: 'beto', quota: 'mucho', limits: { bytes: 1 }, usage: { bytes: 'x' } },
      ],
    }));
    const [ana, beto] = await s.listAccounts();
    expect(ana).toMatchObject({ quota: { bytes: 1000, diagramsPerProject: 0 }, limits, usage });
    expect(ana.quota).not.toHaveProperty('projects');
    expect(beto).not.toHaveProperty('quota');
    expect(beto).not.toHaveProperty('limits');
    expect(beto).not.toHaveProperty('usage');
  });

  it('setAccount manda la cuota tal cual (un número fija, null quita) junto a lo demás que cambie', async () => {
    const { store: s, calls } = store(() => ({ body: { id: 'u_1', login: 'ana', siteRole: 'member', disabled: false, pending: false, createdAt: '', projects: 0, quota: { bytes: 5 } } }));
    expect((await s.setAccount('ana', { quota: { bytes: 5, projects: null, diagramsPerProject: 0 } })).account.quota).toEqual({ bytes: 5 });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ quota: { bytes: 5, projects: null, diagramsPerProject: 0 } });
    await s.setAccount('ana', { disabled: true });
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ disabled: true });
  });

  it('un guardado que no cabe en la cuota llega como invalid con serverCode limit y el mensaje del servidor', async () => {
    const error = await failure(store(() => ({ status: 409, body: { error: 'No hay espacio para guardar esto.', code: 'limit', quota: 'bytes', used: 10, limit: 10 } })).store.saveDiagram('p', { id: 'd', text: 'x' }));
    expect(error).toMatchObject({ code: 'invalid', message: 'No hay espacio para guardar esto.', info: { status: 409, serverCode: 'limit' } });
  });
});
