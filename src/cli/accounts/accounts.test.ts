import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GithubError, GithubOAuth, parseGithubProfile } from './github';
import { Accounts, normalizePublicUrl, parseAdminList } from './service';
import { readClientSecret, setupAccounts } from './setup';
import { asAsync, JsonAccountStore } from './store';

const folders: string[] = [];
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'iark-cuentas-'));
  folders.push(dir);
  return dir;
};
const open = () => {
  const file = join(tmp(), 'cuentas.json');
  return { file, store: asAsync(JsonAccountStore.open(file)) };
};

const ana = { id: 101, login: 'ana', name: 'Ana Pérez', avatarUrl: 'https://avatars.example.test/101' };

describe('Accounts: reglas de la instancia', () => {
  const make = (admins: string[], extra: Partial<ConstructorParameters<typeof Accounts>[0]> = {}) => new Accounts({ store: open().store, publicUrl: 'https://iark.example.org/', admins, ...extra });

  it('los administradores salen de la lista, por id numérico o por nombre, y solo cuenta quien ya entró con GitHub', async () => {
    const accounts = make(['583231', '@Ana']);
    expect(accounts.adminCount).toBe(2);
    expect(accounts.isAdminProfile({ id: 583231, login: 'otro-nombre' })).toBe(true);
    expect(accounts.isAdminProfile({ id: 1, login: 'ANA' })).toBe(true);
    expect(accounts.isAdminProfile({ id: 2, login: 'beto' })).toBe(false);
    const user = await accounts.store.signIn(ana, { signup: 'open', admin: true });
    expect(accounts.siteRoleOf(user)).toBe('admin');
    // una invitación pendiente a ese nombre todavía no es de nadie: no es administradora hasta que alguien entre con él
    expect(accounts.siteRoleOf({ id: 'u_x', login: 'ana', siteRole: 'guest', createdAt: '2026-01-01T00:00:00Z' })).toBe('guest');
    // quitar a alguien de la lista le quita el rol aunque su cuenta guarde otro
    expect(user.siteRole).toBe('member'); // la cuenta no guarda el rol de la lista
    expect(make([]).siteRoleOf(user)).toBe('member');
    expect(() => parseAdminList('ana, ¿quién?')).toThrowError(/no es un nombre de usuario/);
  });

  it('solo se devuelve a la persona al propio sitio o a un origen nombrado: nunca a `*` ni a otro', () => {
    const accounts = make([], { allowedOrigins: ['https://app.example.org', '*', 'http://localhost:5173'] });
    for (const ok of ['https://iark.example.org/', 'https://iark.example.org/modulos.html?module=data', 'https://app.example.org/x', 'http://localhost:5173/']) expect(accounts.redirectAllowed(new URL(ok)), ok).toBe(true);
    for (const bad of ['https://evil.example.com/', 'http://iark.example.org/', 'https://iark.example.org.evil.com/', 'https://user:pw@iark.example.org/', 'javascript:alert(1)', 'https://app.example.org:8443/']) {
      expect(accounts.redirectAllowed(new URL(bad)), bad).toBe(false);
    }
  });

  it('la dirección pública es https (solo localhost puede ser http), sin usuario ni parámetros, y se normaliza', () => {
    expect(normalizePublicUrl('https://iark.example.org/')).toBe('https://iark.example.org');
    expect(normalizePublicUrl('https://example.org/iark/')).toBe('https://example.org/iark');
    expect(normalizePublicUrl('http://localhost:8787')).toBe('http://localhost:8787');
    expect(normalizePublicUrl('http://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787');
    for (const bad of ['iark.example.org', 'ftp://example.org', 'http://iark.example.org', 'https://u:p@example.org', 'https://example.org/?x=1', 'https://example.org/#a']) expect(() => normalizePublicUrl(bad), bad).toThrowError();
    expect(make([]).callbackUrl).toBe('https://iark.example.org/api/auth/github/callback');
  });
});

describe('GithubOAuth', () => {
  const secret = 'client-secret-que-no-debe-salir';
  const reply = (status: number, body: unknown): Response => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const client = (handler: (url: string, init: RequestInit) => Response | Promise<Response>) => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return handler(url, init);
    }) as unknown as typeof fetch;
    return { requests, github: new GithubOAuth({ clientId: 'abc', clientSecret: secret, fetch: fetchImpl }) };
  };
  const profile = { id: 7, login: 'ana', name: 'Ana', avatar_url: 'https://avatars.example.test/7', type: 'User' };

  it('la dirección de autorización lleva el cliente, la vuelta y el state, y ningún permiso', () => {
    const { github } = client(() => reply(200, {}));
    const url = new URL(github.authorizeUrl({ redirectUri: 'https://iark.example.org/api/auth/github/callback', state: 'estado' }));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: 'abc', redirect_uri: 'https://iark.example.org/api/auth/github/callback', state: 'estado', allow_signup: 'true' });
    expect(url.searchParams.has('scope')).toBe(false);
  });

  it('cambia el código por el perfil y revoca el token de GitHub', async () => {
    const { github, requests } = client((url) => {
      if (url.endsWith('/login/oauth/access_token')) return reply(200, { access_token: 'gho_tok', token_type: 'bearer', scope: '' });
      if (url.endsWith('/user')) return reply(200, profile);
      return reply(204, '');
    });
    expect(await github.profileFromCode('el-codigo', 'https://iark.example.org/api/auth/github/callback')).toEqual({ id: 7, login: 'ana', name: 'Ana', avatarUrl: 'https://avatars.example.test/7' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests.map((r) => `${r.init.method} ${new URL(r.url).pathname}`)).toEqual(['POST /login/oauth/access_token', 'GET /user', 'DELETE /applications/abc/token']);
    expect(JSON.parse(requests[0].init.body as string)).toEqual({ client_id: 'abc', client_secret: secret, code: 'el-codigo', redirect_uri: 'https://iark.example.org/api/auth/github/callback' });
    expect((requests[1].init.headers as Record<string, string>).Authorization).toBe('Bearer gho_tok');
    expect(JSON.parse(requests[2].init.body as string)).toEqual({ access_token: 'gho_tok' });
    expect(requests.every((r) => (r.init as { redirect?: string }).redirect === 'error')).toBe(true);
  });

  it('distingue lo que es de la persona (código rechazado, sin permiso) de lo que es de GitHub (caído, lento, error)', async () => {
    const cases: Array<[string, (url: string) => Response | Promise<Response>, string]> = [
      ['código malo', () => reply(200, { error: 'bad_verification_code' }), 'rejected'],
      ['credenciales de la app malas', () => reply(200, { error: 'incorrect_client_credentials' }), 'rejected'],
      ['GitHub falla al cambiar el código', () => reply(503, { error: 'x' }), 'unavailable'],
      ['sin token ni error', () => reply(200, {}), 'unavailable'],
      ['la red falla', () => Promise.reject(new TypeError('fetch failed')), 'unavailable'],
      ['tiempo agotado', () => Promise.reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), 'unavailable'],
      ['GitHub no deja leer el perfil', (url) => (url.endsWith('/user') ? reply(401, { message: 'Bad credentials' }) : reply(200, { access_token: 't' })), 'rejected'],
      ['GitHub falla al leer el perfil', (url) => (url.endsWith('/user') ? reply(502, {}) : reply(200, { access_token: 't' })), 'unavailable'],
      ['el perfil no vale', (url) => (url.endsWith('/user') ? reply(200, { id: 'x' }) : reply(200, { access_token: 't' })), 'bad-profile'],
    ];
    for (const [name, handler, code] of cases) {
      const { github } = client(handler);
      await expect(github.profileFromCode('c', 'https://x/cb'), name).rejects.toMatchObject({ name: 'GithubError', code });
    }
  });

  it('un error nunca incluye el secreto de la OAuth App ni lo que respondió GitHub', async () => {
    const { github } = client(() => reply(200, { error: 'bad_verification_code', error_description: `el secreto ${secret} y gho_filtrado` }));
    const error = await github.profileFromCode('c', 'https://x/cb').catch((e: Error) => e);
    expect(error).toBeInstanceOf(GithubError);
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error).message).not.toContain('gho_filtrado');
  });

  it('el perfil solo se acepta si es de una persona con id y nombre de usuario válidos, y la foto solo si es https', () => {
    expect(parseGithubProfile(profile)).toEqual({ id: 7, login: 'ana', name: 'Ana', avatarUrl: 'https://avatars.example.test/7' });
    expect(parseGithubProfile({ id: 7, login: 'ana', avatar_url: 'http://insegura.example.test/a.png', name: '  \n ' })).toEqual({ id: 7, login: 'ana' });
    expect(parseGithubProfile({ id: 7, login: 'ana', avatar_url: 'https://u:p@x.example.test/a.png' })).toEqual({ id: 7, login: 'ana' });
    expect(parseGithubProfile({ id: 7, login: 'ana', name: 'A\u0000B\nC'.padEnd(500, 'x') }).name).toHaveLength(120);
    for (const bad of [null, 'x', { login: 'ana' }, { id: 0, login: 'ana' }, { id: 1.5, login: 'ana' }, { id: 1, login: 'ana[bot]' }, { id: 1, login: '' }, { id: 1, login: 'ana', type: 'Organization' }, { id: 1, login: 'ana', type: 'Bot' }]) {
      expect(() => parseGithubProfile(bad), JSON.stringify(bad)).toThrowError(expect.objectContaining({ code: 'bad-profile' }));
    }
  });
});

describe('setupAccounts: las opciones de `iark serve`', () => {
  const base = () => ({ accounts: join(tmp(), 'cuentas.json'), githubClientId: 'abc', publicUrl: 'https://iark.example.org', admins: '583231' });
  const env = { IARK_GITHUB_CLIENT_SECRET: 'secreto' };
  const ctx = { workspace: true, cors: [] as string[], env };

  it('sin ninguna opción de cuentas no hace nada', async () => {
    expect(await setupAccounts({}, { workspace: true, cors: [], env: {} })).toBeUndefined();
    expect(await setupAccounts({ signup: 'open', admins: 'ana', publicUrl: 'https://x.org' }, { workspace: true, cors: [], env: {} })).toBeUndefined();
  });

  it('pide todo lo que falta de una vez y no acepta el secreto por la línea de comandos', async () => {
    await expect(setupAccounts({ githubClientId: 'abc' }, { workspace: false, cors: [], env: {} })).rejects.toThrowError(
      expect.objectContaining({ message: expect.stringMatching(/--accounts[\s\S]*IARK_GITHUB_CLIENT_SECRET[\s\S]*--public-url[\s\S]*--workspace/) }),
    );
    await expect(setupAccounts(base(), { ...ctx, workspace: false })).rejects.toThrowError(/--workspace/);
    await expect(setupAccounts({ ...base(), publicUrl: undefined }, ctx)).rejects.toThrowError(/--public-url/);
    await expect(setupAccounts({ accounts: join(tmp(), 'c.json') }, { workspace: true, cors: [], env: {} })).rejects.toThrowError(/IARK_GITHUB_CLIENT_SECRET/);
  });

  it('con todo en orden devuelve las cuentas, con los orígenes de --cors como destinos de vuelta', async () => {
    const accounts = (await setupAccounts({ ...base(), signup: 'open', sessionDays: 7, maxProjects: 3 }, { ...ctx, cors: ['https://app.example.org'] }))!;
    expect(accounts.signup).toBe('open');
    expect(accounts.sessionTtlMs).toBe(7 * 24 * 3600 * 1000);
    expect(accounts.maxProjectsPerUser).toBe(3);
    expect(accounts.callbackUrl).toBe('https://iark.example.org/api/auth/github/callback');
    expect(accounts.redirectAllowed(new URL('https://app.example.org/'))).toBe(true);
  });

  it('rechaza valores que no valen, con el motivo', async () => {
    for (const [change, message] of [
      [{ signup: 'cualquiera' }, /--signup/],
      [{ sessionDays: 0 }, /--session-days/],
      [{ sessionDays: 400 }, /--session-days/],
      [{ maxProjects: -1 }, /--max-projects/],
      [{ maxProjects: 1.5 }, /--max-projects/],
      [{ maxDiagrams: -2 }, /--max-diagrams/],
      [{ maxBytes: 'muchísimo' }, /--max-bytes/],
      [{ maxBytes: '12XB' }, /--max-bytes/],
      [{ publicUrl: 'http://iark.example.org' }, /https/],
      [{ admins: 'ana, ¿quién?' }, /nombre de usuario/],
      [{ githubUrl: 'git.empresa.com' }, /--github-url/],
    ] as const) {
      await expect(setupAccounts({ ...base(), ...change }, ctx), JSON.stringify(change)).rejects.toThrowError(message);
    }
  });

  it('con entrada por invitación y sin administradores ni cuentas, nadie podría entrar: no arranca', async () => {
    await expect(setupAccounts({ ...base(), admins: undefined }, ctx)).rejects.toThrowError(/al menos un administrador/);
    // con la entrada abierta no hace falta
    const open = (await setupAccounts({ ...base(), admins: undefined, signup: 'open' }, ctx))!;
    expect(open).toBeDefined();
    await open.store.close();
    // ni con cuentas ya registradas
    const file = join(tmp(), 'c.json');
    JsonAccountStore.open(file).invite('ana');
    const withUsers = (await setupAccounts({ ...base(), accounts: file, admins: undefined }, ctx))!;
    expect(withUsers).toBeDefined();
    await withUsers.store.close();
  });

  it('--accounts-store elige el almacén: json por omisión, sqlite si se pide, y cualquier otra cosa es un error de uso', async () => {
    const byDefault = (await setupAccounts(base(), ctx))!;
    expect(byDefault.store.kind).toBe('json');
    await byDefault.store.close();
    const upper = (await setupAccounts({ ...base(), accountsStore: ' JSON ' }, ctx))!;
    expect(upper.store.kind).toBe('json');
    await upper.store.close();
    const sqlite = (await setupAccounts({ ...base(), accounts: join(tmp(), 'c.db'), accountsStore: 'sqlite' }, ctx))!;
    expect(sqlite.store.kind).toBe('sqlite');
    await sqlite.store.close();
    await expect(setupAccounts({ ...base(), accountsStore: 'mysql' }, ctx)).rejects.toThrowError(/--accounts-store debe ser «json», «sqlite», «postgres», no «mysql»/);
    await expect(setupAccounts({ ...base(), accountsImport: '/x/cuentas.json' }, ctx)).rejects.toThrowError(/solo vale con --accounts-store sqlite o postgres/);
  });

  it('--accounts-store postgres no se abre sin IARK_DATABASE_URL, y la conexión no se acepta por la línea de comandos', async () => {
    await expect(setupAccounts({ ...base(), accounts: undefined, accountsStore: 'postgres' }, ctx)).rejects.toThrowError(/IARK_DATABASE_URL/);
    // la ruta de --accounts no se usa con postgres: no es obligatoria y, si se da, se avisa
    const lines: string[] = [];
    await expect(setupAccounts({ ...base(), accountsStore: 'postgres' }, { ...ctx, log: (line) => lines.push(line) })).rejects.toThrowError(/IARK_DATABASE_URL/);
    expect(lines).toEqual([]);
  });

  it('con sqlite, --accounts-import importa el JSON si la base está vacía, lo cuenta una vez y no repite ni mezcla', async () => {
    const dir = tmp();
    const jsonFile = join(dir, 'cuentas.json');
    const old = JsonAccountStore.open(jsonFile);
    const user = old.signIn({ id: 7, login: 'ana' }, { signup: 'open', admin: false });
    old.registerProject('tienda', user.id);
    const { token } = old.createSession(user.id, 3600_000);
    const lines: string[] = [];
    const options = { ...base(), accounts: join(dir, 'cuentas.db'), accountsStore: 'sqlite', accountsImport: jsonFile, admins: undefined };
    const first = (await setupAccounts(options, { ...ctx, log: (line) => lines.push(line) }))!;
    expect(first.store.kind).toBe('sqlite');
    expect((await first.store.lookupSession(token))?.login).toBe('ana');
    expect(await first.store.roleOf(user.id, 'tienda')).toBe('admin');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/Cuentas importadas de .*1 cuenta, 1 sesión y 1 pertenencia a 1 proyecto.*Copia de seguridad del origen/);
    await first.store.close();
    // otra vez: ya está importada, no dice nada ni cambia nada
    const second = (await setupAccounts(options, { ...ctx, log: (line) => lines.push(line) }))!;
    expect(lines).toHaveLength(1);
    expect(await second.store.userCount()).toBe(1);
    await second.store.close();
    // sin el archivo (una instalación nueva) tampoco dice nada
    const fresh = (await setupAccounts({ ...options, admins: '583231', accounts: join(dir, 'nueva.db'), accountsImport: join(dir, 'no-existe.json') }, { ...ctx, log: (line) => lines.push(line) }))!;
    expect(lines).toHaveLength(1);
    await fresh.store.close();
  });

  it('un archivo de cuentas dañado es un error de uso, no una excepción', async () => {
    const file = join(tmp(), 'c.json');
    writeFileSync(file, 'roto');
    await expect(setupAccounts({ ...base(), accounts: file }, ctx)).rejects.toThrowError(/no es válido/);
  });

  it('el secreto se lee del entorno o de un archivo (Docker secrets); un archivo ilegible o vacío es un error', () => {
    expect(readClientSecret({ IARK_GITHUB_CLIENT_SECRET: '  s3  ' })).toBe('s3');
    const file = join(tmp(), 'secreto');
    writeFileSync(file, 's4\n');
    expect(readClientSecret({ IARK_GITHUB_CLIENT_SECRET_FILE: file })).toBe('s4');
    expect(readClientSecret({ IARK_GITHUB_CLIENT_SECRET: 's5', IARK_GITHUB_CLIENT_SECRET_FILE: file })).toBe('s5');
    expect(readClientSecret({})).toBeUndefined();
    writeFileSync(file, '\n');
    expect(() => readClientSecret({ IARK_GITHUB_CLIENT_SECRET_FILE: file })).toThrowError(/vacío/);
    expect(() => readClientSecret({ IARK_GITHUB_CLIENT_SECRET_FILE: join(tmp(), 'no-existe') })).toThrowError(/No se pudo leer/);
  });
});
