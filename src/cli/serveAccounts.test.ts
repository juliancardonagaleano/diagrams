import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBundle, MemoryProjectStore, bundleToText } from '@iark/kernel';
import { GithubOAuth } from './accounts/github';
import { Accounts, type AccountsOptions } from './accounts/service';
import { AccountStore } from './accounts/store';
import { createDefaultRegistry } from './registry';
import { createSuiteServer, type ServeOptions } from './serve';
import { createToken, TokenStore } from './tokens';
import { FolderProjectStore } from './workspace';
import { challengeOf, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, newVerifier, startFakeGithub, type FakeGithub, type FakeProfile } from '../../tests/helpers/fakeGithub';
import { loginWithGithub } from '../../tests/helpers/githubLogin';

/**
 * `iark serve --accounts`: el inicio de sesión de GitHub (contra un GitHub de mentira que corre en la propia prueba), las sesiones y el
 * alcance de cada persona sobre los proyectos. El servidor es el de verdad (`createSuiteServer`); lo único falso es GitHub.
 */

const JSON_TYPE = { 'Content-Type': 'application/json' };
const example = (file: string): string => readFileSync(`examples/${file}`, 'utf8');

const folders: string[] = [];
const servers: Server[] = [];
const fakes: FakeGithub[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const server of servers.splice(0)) server.close();
  for (const fake of fakes.splice(0)) await fake.stop();
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ANA: FakeProfile = { id: 583231, login: 'ana', name: 'Ana Pérez' };
const BETO: FakeProfile = { id: 202, login: 'beto' };
const CARLA: FakeProfile = { id: 303, login: 'carla' };

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

interface Cloud {
  base: string;
  root: string;
  file: string;
  fake: FakeGithub;
  accounts: Accounts;
  tokens?: { admin: string };
}

interface CloudOptions extends Partial<Omit<AccountsOptions, 'store' | 'github' | 'publicUrl'>> {
  tokens?: boolean;
  cors?: string[];
  serve?: Partial<ServeOptions>;
}

async function startCloud(options: CloudOptions = {}): Promise<Cloud> {
  const fake = await startFakeGithub();
  fakes.push(fake);
  const dir = mkdtempSync(join(tmpdir(), 'iark-cuentas-api-'));
  folders.push(dir);
  const root = join(dir, 'espacio');
  mkdirSync(root);
  const file = join(dir, 'cuentas.json');
  const port = await freePort();
  const { tokens: withTokens, cors, serve, ...rest } = options;
  const accounts = new Accounts({
    store: AccountStore.open(file),
    github: new GithubOAuth({ clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET, baseUrl: fake.url, apiUrl: fake.url }),
    publicUrl: `http://127.0.0.1:${port}`,
    signup: 'invite',
    admins: [String(ANA.id)],
    allowedOrigins: cors,
    ...rest,
  });
  let tokenStore: TokenStore | undefined;
  let adminToken: string | undefined;
  if (withTokens) {
    const tokenFile = join(dir, 'tokens.json');
    adminToken = createToken(tokenFile, { name: 'servicio', role: 'admin' }).token;
    tokenStore = TokenStore.open(tokenFile);
  }
  const server = createSuiteServer({ registry: createDefaultRegistry(), version: '1', projects: new FolderProjectStore(root), accounts, tokens: tokenStore, cors, ...serve });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${port}`, root, file, fake, accounts, ...(adminToken ? { tokens: { admin: adminToken } } : {}) };
}

/** Una persona entra y devuelve su token de sesión. */
async function signIn(cloud: Cloud, profile: FakeProfile): Promise<string> {
  const result = await loginWithGithub(cloud.base, cloud.fake, profile);
  if (!result.token) throw new Error(`no entró (${profile.login}): ${result.fragment}`);
  return result.token;
}

function call(base: string, token?: string) {
  const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined || method !== 'GET' ? JSON_TYPE : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
  return {
    get: (path: string, headers?: Record<string, string>) => send('GET', path, undefined, headers),
    post: (path: string, body?: unknown, headers?: Record<string, string>) => send('POST', path, body ?? {}, headers),
    put: (path: string, body?: unknown) => send('PUT', path, body ?? {}),
    patch: (path: string, body?: unknown) => send('PATCH', path, body ?? {}),
    del: (path: string) => send('DELETE', path),
  };
}

describe('iark serve --accounts: formas de entrar y manifiesto', () => {
  it('providers dice qué ofrece la instancia, sin pedir nada, con y sin cuentas', async () => {
    const cloud = await startCloud({ tokens: true });
    expect(await (await fetch(`${cloud.base}/api/auth/providers`)).json()).toEqual({ providers: [{ id: 'github', label: 'GitHub' }], tokens: true, signup: 'invite' });
    const open = await startCloud({ signup: 'open' });
    expect(await (await fetch(`${open.base}/api/auth/providers`)).json()).toMatchObject({ tokens: false, signup: 'open' });

    // sin cuentas ni tokens (un servidor de siempre): no hay formas de entrar, pero la ruta responde
    const plain = createSuiteServer({ registry: createDefaultRegistry(), version: '1' });
    servers.push(plain);
    await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(plain.address() as AddressInfo).port}`;
    expect(await (await fetch(`${base}/api/auth/providers`)).json()).toEqual({ providers: [], tokens: false });
    expect((await fetch(`${base}/api/auth/github/login?challenge=${challengeOf(newVerifier())}`, { redirect: 'manual' })).status).toBe(404);
    expect((await call(base).post('/api/auth/exchange', { code: 'x', verifier: newVerifier() })).status).toBe(404);
    expect((await call(base).post('/api/auth/logout')).status).toBe(404);
    const post = await call(cloud.base).post('/api/auth/providers');
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET');
    expect((await fetch(`${cloud.base}/api/auth/inventada`)).status).toBe(404);
  });

  it('el manifiesto anuncia que la API de proyectos usa cabecera Bearer', async () => {
    const cloud = await startCloud();
    expect((await (await fetch(`${cloud.base}/.well-known/iark.json`)).json()).projectsAuth).toBe('bearer');
  });
});

describe('iark serve --accounts: el inicio de sesión', () => {
  it('recorre el flujo entero: GitHub, código de un solo uso, sesión, whoami y cierre', async () => {
    const cloud = await startCloud();
    const result = await loginWithGithub(cloud.base, cloud.fake, ANA);
    expect(result.callbackStatus).toBe(302);
    expect(result.returnedTo).toBe(`${cloud.base}/`); // por omisión, al propio sitio
    expect(result.exchangeStatus).toBe(200);
    expect(result.token).toMatch(/^iark_s_[A-Za-z0-9_-]{43}$/);
    expect(result.user).toEqual({ id: expect.stringMatching(/^u_/), login: 'ana', name: 'Ana Pérez', avatarUrl: `https://avatars.example.test/u/${ANA.id}`, siteRole: 'admin' });
    expect(Date.parse(result.expiresAt!) - Date.now()).toBeGreaterThan(29 * 24 * 3600 * 1000);

    // el token de GitHub se revocó y no se pidió nada más que el perfil
    await vi.waitFor(() => expect(cloud.fake.revoked).toHaveLength(1));
    expect(cloud.fake.calls['POST /login/oauth/access_token']).toBe(1);
    expect(cloud.fake.calls['GET /user']).toBe(1);

    const who = await (await call(cloud.base, result.token).get('/api/whoami')).json();
    expect(who).toEqual({ auth: true, name: 'Ana Pérez', role: 'admin', user: result.user });
    expect((await call(cloud.base, result.token).post('/api/auth/logout')).status).toBe(200);
    const after = await call(cloud.base, result.token).get('/api/whoami');
    expect(after.status).toBe(401);
    expect(await after.json()).toMatchObject({ code: 'unauthorized' });
  });

  it('whoami usa el nombre de usuario si la persona no tiene nombre público', async () => {
    const cloud = await startCloud({ signup: 'open' });
    const token = await signIn(cloud, BETO);
    expect(await (await call(cloud.base, token).get('/api/whoami')).json()).toMatchObject({ auth: true, name: 'beto', role: 'member', user: { login: 'beto', siteRole: 'member' } });
  });

  it('en una instancia por invitación, quien no está invitado vuelve con un motivo y no se crea nada', async () => {
    const cloud = await startCloud();
    const result = await loginWithGithub(cloud.base, cloud.fake, BETO);
    expect(result.fragment.get('iark_error')).toBe('not_invited');
    expect(result.fragment.has('iark_code')).toBe(false);
    expect(cloud.accounts.store.userCount).toBe(0);
    await vi.waitFor(() => expect(cloud.fake.revoked).toHaveLength(1)); // aun así no se queda con el token de GitHub (se revoca sin hacer esperar a la persona)
    // invitada por su nombre de usuario, entra como invitada
    cloud.accounts.store.invite('Beto', 'guest');
    const invited = await loginWithGithub(cloud.base, cloud.fake, BETO);
    expect(invited.user).toMatchObject({ login: 'beto', siteRole: 'guest' });
  });

  it('una cuenta desactivada no entra, y si ya tenía sesión deja de valer', async () => {
    const cloud = await startCloud({ signup: 'open' });
    const token = await signIn(cloud, BETO);
    const user = cloud.accounts.store.findByLogin('beto')!;
    cloud.accounts.store.updateUser(user.id, { disabled: true });
    expect((await call(cloud.base, token).get('/api/whoami')).status).toBe(401);
    expect((await loginWithGithub(cloud.base, cloud.fake, BETO)).fragment.get('iark_error')).toBe('disabled');
  });

  it('si la persona no acepta en GitHub o GitHub falla, vuelve con un motivo claro y sin sesión', async () => {
    const cloud = await startCloud();
    cloud.fake.deny();
    const start = await fetch(`${cloud.base}/api/auth/github/login?challenge=${challengeOf(newVerifier())}`, { redirect: 'manual' });
    const cookie = start.headers.get('set-cookie')!.split(';')[0];
    const authorize = await fetch(start.headers.get('location')!, { redirect: 'manual' });
    const denied = await fetch(`${cloud.base}/api/auth/github/callback${new URL(authorize.headers.get('location')!).search}`, { redirect: 'manual', headers: { Cookie: cookie } });
    expect(new URL(denied.headers.get('location')!).hash).toBe('#iark_error=access_denied');

    cloud.fake.failNext('token', 500);
    expect((await loginWithGithub(cloud.base, cloud.fake, ANA)).fragment.get('iark_error')).toBe('github_unavailable');
    cloud.fake.failNext('user', 502);
    expect((await loginWithGithub(cloud.base, cloud.fake, ANA)).fragment.get('iark_error')).toBe('github_unavailable');
    expect((await loginWithGithub(cloud.base, cloud.fake, ANA)).token).toBeDefined(); // y luego, con GitHub bien, entra
  });

  it('un código que GitHub rechaza (caducado o ya usado) vuelve como login_failed', async () => {
    const cloud = await startCloud();
    const start = await fetch(`${cloud.base}/api/auth/github/login?challenge=${challengeOf(newVerifier())}`, { redirect: 'manual' });
    const cookie = start.headers.get('set-cookie')!.split(';')[0];
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const callback = await fetch(`${cloud.base}/api/auth/github/callback?code=inventado&state=${state}`, { redirect: 'manual', headers: { Cookie: cookie } });
    expect(new URL(callback.headers.get('location')!).hash).toBe('#iark_error=login_failed');
    const missing = await fetch(`${cloud.base}/api/auth/github/login?challenge=${challengeOf(newVerifier())}`, { redirect: 'manual' });
    const state2 = new URL(missing.headers.get('location')!).searchParams.get('state')!;
    const noCode = await fetch(`${cloud.base}/api/auth/github/callback?state=${state2}`, { redirect: 'manual', headers: { Cookie: missing.headers.get('set-cookie')!.split(';')[0] } });
    expect(new URL(noCode.headers.get('location')!).hash).toBe('#iark_error=login_failed');
  });

  it('el login pide un challenge de PKCE y solo vuelve a este sitio o a un origen de --cors', async () => {
    const cloud = await startCloud({ cors: ['https://app.example.org', '*'] });
    const challenge = challengeOf(newVerifier());
    const login = (query: string) => fetch(`${cloud.base}/api/auth/github/login?${query}`, { redirect: 'manual' });
    for (const query of ['', 'challenge=corto', `challenge=${challenge}x`, 'challenge=' + '!'.repeat(43)]) {
      const res = await login(query);
      expect(res.status, query).toBe(400);
      expect((await res.json()).error).toMatch(/challenge/);
    }
    for (const redirect of ['https://evil.example.com/', '//evil.example.com', 'https://app.example.org.evil.com/', 'javascript:alert(1)', 'no es una url', `${cloud.base.replace('http:', 'https:')}/`]) {
      const res = await login(new URLSearchParams({ challenge, redirect }).toString());
      expect(res.status, redirect).toBe(400);
    }
    const ok = await login(new URLSearchParams({ challenge, redirect: 'https://app.example.org/modulos.html?module=data#basura' }).toString());
    expect(ok.status).toBe(302);
    const authorize = new URL(ok.headers.get('location')!);
    expect(authorize.origin).toBe(cloud.fake.url);
    expect(authorize.pathname).toBe('/login/oauth/authorize');
    expect(authorize.searchParams.get('client_id')).toBe(FAKE_CLIENT_ID);
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${cloud.base}/api/auth/github/callback`);
    expect(authorize.searchParams.has('scope')).toBe(false);
    expect(authorize.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const cookie = ok.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^iark_oauth=[A-Za-z0-9_-]{32}; Max-Age=600; Path=\/api\/auth\/github; HttpOnly; SameSite=Lax$/); // http en pruebas: sin Secure
    // la vuelta lleva el código en el fragmento, al origen que se pidió, con su camino y sus parámetros pero sin el fragmento anterior
    const result = await loginWithGithub(cloud.base, cloud.fake, ANA, { redirect: 'https://app.example.org/modulos.html?module=data#basura' });
    expect(result.returnedTo).toBe('https://app.example.org/modulos.html?module=data');
    expect(result.fragment.get('iark_code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.token).toBeDefined();
  });

  it('con una dirección pública https la cookie del state es Secure y cuelga del camino de la instancia', async () => {
    const fake = await startFakeGithub();
    fakes.push(fake);
    const dir = mkdtempSync(join(tmpdir(), 'iark-cuentas-secure-'));
    folders.push(dir);
    const accounts = new Accounts({
      store: AccountStore.open(join(dir, 'c.json')),
      github: new GithubOAuth({ clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET, baseUrl: fake.url, apiUrl: fake.url }),
      publicUrl: 'https://iark.example.org/herramientas',
      admins: ['1'],
    });
    const server = createSuiteServer({ registry: createDefaultRegistry(), version: '1', projects: new MemoryProjectStore(), accounts });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${base}/api/auth/github/login?challenge=${challengeOf(newVerifier())}&redirect=https://iark.example.org/herramientas/`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('set-cookie')).toMatch(/Path=\/herramientas\/api\/auth\/github; HttpOnly; SameSite=Lax; Secure$/);
    expect(new URL(res.headers.get('location')!).searchParams.get('redirect_uri')).toBe('https://iark.example.org/herramientas/api/auth/github/callback');
  });
});

describe('iark serve --accounts: el state liga la vuelta de GitHub con quien la empezó', () => {
  async function started(cloud: Cloud, profile: FakeProfile = ANA) {
    cloud.fake.signInAs(profile);
    const start = await fetch(`${cloud.base}/api/auth/github/login?challenge=${challengeOf(newVerifier())}`, { redirect: 'manual' });
    const authorize = await fetch(start.headers.get('location')!, { redirect: 'manual' });
    return { cookie: start.headers.get('set-cookie')!.split(';')[0], query: new URL(authorize.headers.get('location')!).search, state: new URL(start.headers.get('location')!).searchParams.get('state')! };
  }

  it('sin la cookie del navegador que empezó el flujo, la vuelta no vale (una página que te manda el enlace de otro)', async () => {
    const cloud = await startCloud();
    const { query } = await started(cloud);
    const res = await fetch(`${cloud.base}/api/auth/github/callback${query}`, { redirect: 'manual' });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).toMatch(/caducó o no se empezó desde este navegador/);
    expect(cloud.accounts.store.userCount).toBe(0);
    expect(cloud.fake.calls['POST /login/oauth/access_token']).toBeUndefined(); // ni siquiera se gasta el código en GitHub
  });

  it('con la cookie de otro inicio de sesión, o con un state inventado, tampoco; y el state solo vale una vez', async () => {
    const cloud = await startCloud();
    const one = await started(cloud);
    const two = await started(cloud);
    const wrong = await fetch(`${cloud.base}/api/auth/github/callback${one.query}`, { redirect: 'manual', headers: { Cookie: two.cookie } });
    expect(wrong.status).toBe(400);
    const invented = await fetch(`${cloud.base}/api/auth/github/callback?code=x&state=inventado`, { redirect: 'manual', headers: { Cookie: 'iark_oauth=inventado' } });
    expect(invented.status).toBe(400);
    const none = await fetch(`${cloud.base}/api/auth/github/callback?code=x`, { redirect: 'manual' });
    expect(none.status).toBe(400);
    // el intento fallido de `one` ya gastó su state: aun con su cookie, ya no vale
    expect((await fetch(`${cloud.base}/api/auth/github/callback${one.query}`, { redirect: 'manual', headers: { Cookie: one.cookie } })).status).toBe(400);
    // `two` sigue intacto
    const good = await fetch(`${cloud.base}/api/auth/github/callback${two.query}`, { redirect: 'manual', headers: { Cookie: two.cookie } });
    expect(good.status).toBe(302);
    const again = await fetch(`${cloud.base}/api/auth/github/callback${two.query}`, { redirect: 'manual', headers: { Cookie: two.cookie } });
    expect(again.status).toBe(400);
  });

  it('un state caduca a los 10 minutos', async () => {
    const cloud = await startCloud();
    const flow = await started(cloud);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1000);
    const res = await fetch(`${cloud.base}/api/auth/github/callback${flow.query}`, { redirect: 'manual', headers: { Cookie: flow.cookie } });
    expect(res.status).toBe(400);
  });

  it('la página de error no repite nada de lo que llegó en la petición', async () => {
    const cloud = await startCloud();
    const res = await fetch(`${cloud.base}/api/auth/github/callback?state=<script>alert(1)</script>&error=<b>x</b>`, { redirect: 'manual' });
    const html = await res.text();
    expect(res.status).toBe(400);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>x</b>');
  });

  it('solo se admite GET en el login y la vuelta', async () => {
    const cloud = await startCloud();
    for (const path of ['/api/auth/github/login', '/api/auth/github/callback']) {
      const res = await call(cloud.base).post(path);
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET');
    }
  });
});

describe('iark serve --accounts: el código se cambia por una sesión (PKCE)', () => {
  /** Recorre el flujo hasta la vuelta de GitHub y devuelve el código que recibe el navegador, sin cambiarlo todavía por la sesión. */
  async function codeFor(cloud: Cloud, verifier = newVerifier()): Promise<string> {
    cloud.fake.signInAs(ANA);
    const start = await fetch(`${cloud.base}/api/auth/github/login?challenge=${challengeOf(verifier)}`, { redirect: 'manual' });
    const authorize = await fetch(start.headers.get('location')!, { redirect: 'manual' });
    const callback = await fetch(`${cloud.base}/api/auth/github/callback${new URL(authorize.headers.get('location')!).search}`, { redirect: 'manual', headers: { Cookie: start.headers.get('set-cookie')!.split(';')[0] } });
    return new URLSearchParams(new URL(callback.headers.get('location')!).hash.slice(1)).get('iark_code')!;
  }
  const exchange = (cloud: Cloud, body: unknown, headers: Record<string, string> = JSON_TYPE) =>
    fetch(`${cloud.base}/api/auth/exchange`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

  it('un código robado no sirve sin el verifier de quien empezó el flujo, y se gasta en el primer intento', async () => {
    const cloud = await startCloud();
    const verifier = newVerifier();
    const code = await codeFor(cloud, verifier);
    const stolen = await exchange(cloud, { code, verifier: newVerifier() });
    expect(stolen.status).toBe(400);
    expect(await stolen.json()).toMatchObject({ code: 'invalid-grant' });
    // el código ya está gastado: ni con el verifier bueno
    expect((await exchange(cloud, { code, verifier })).status).toBe(400);
    expect(cloud.accounts.store.sessionCount(cloud.accounts.store.findByLogin('ana')!.id)).toBe(0); // nadie consiguió una sesión
  });

  it('el código vale una sola vez y caduca a los 60 segundos', async () => {
    const cloud = await startCloud();
    const verifier = newVerifier();
    const code = await codeFor(cloud, verifier);
    expect((await exchange(cloud, { code, verifier })).status).toBe(200);
    expect((await exchange(cloud, { code, verifier })).status).toBe(400);
    const late = await codeFor(cloud, verifier);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60_000 + 1000);
    expect((await exchange(cloud, { code: late, verifier })).status).toBe(400);
  });

  it('exige JSON y un cuerpo bien formado; lo que no vale es 400 con el mismo mensaje', async () => {
    const cloud = await startCloud();
    expect((await exchange(cloud, { code: 'x', verifier: newVerifier() }, { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await exchange(cloud, '{ roto')).status).toBe(400);
    // cada uno de estos cuenta como intento fallido (con el quinto se frena la dirección): todos reciben el mismo mensaje
    const messages = new Set<string>();
    for (const body of [{}, { code: 1, verifier: newVerifier() }, { code: 'x', verifier: 'corto' }, { code: 'x'.repeat(600), verifier: newVerifier() }, { code: 'inventado', verifier: newVerifier() }]) {
      const res = await exchange(cloud, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      messages.add((await res.json()).error);
    }
    expect(messages.size).toBe(1);
    const other = await startCloud();
    for (const body of ['null', '[]', '"x"', '7']) expect((await exchange(other, body)).status, body).toBe(400);
    expect((await call(other.base).get('/api/auth/exchange')).status).toBe(405);
  });

  it('tras cinco intentos fallidos desde la misma dirección responde 429 con Retry-After, también a un código bueno', async () => {
    const cloud = await startCloud();
    const verifier = newVerifier();
    const code = await codeFor(cloud, verifier);
    for (let i = 0; i < 5; i++) expect((await exchange(cloud, { code: 'inventado', verifier })).status).toBe(400);
    const blocked = await exchange(cloud, { code, verifier });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(await blocked.json()).toMatchObject({ code: 'rate-limited' });
  });
});

describe('iark serve --accounts: cierre de sesión y sesiones', () => {
  it('cerrar sesión solo vale para una sesión; un token de `iark auth` no se cierra así', async () => {
    const cloud = await startCloud({ tokens: true });
    const token = await signIn(cloud, ANA);
    const other = await signIn(cloud, ANA);
    expect((await call(cloud.base).post('/api/auth/logout')).status).toBe(401);
    const wrong = await call(cloud.base, cloud.tokens!.admin).post('/api/auth/logout');
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ code: 'not-a-session' });
    expect((await call(cloud.base, cloud.tokens!.admin).get('/api/whoami')).status).toBe(200); // el token sigue valiendo
    expect((await call(cloud.base, token).post('/api/auth/logout')).status).toBe(200);
    expect((await call(cloud.base, token).post('/api/auth/logout')).status).toBe(401);
    expect((await call(cloud.base, other).get('/api/whoami')).status).toBe(200); // las demás sesiones de la persona siguen
  });

  it('una sesión caduca a los días que se configuraron', async () => {
    const cloud = await startCloud({ sessionTtlMs: 2 * 24 * 3600 * 1000 });
    const token = await signIn(cloud, ANA);
    expect((await call(cloud.base, token).get('/api/whoami')).status).toBe(200);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * 24 * 3600 * 1000 + 1000);
    expect((await call(cloud.base, token).get('/api/whoami')).status).toBe(401);
  });

  it('los tokens de sesión y los de `iark auth` conviven; un token con el prefijo de sesión que no existe es 401 y cuenta como intento fallido', async () => {
    const cloud = await startCloud({ tokens: true });
    expect((await call(cloud.base, 'iark_s_inventado').get('/api/whoami')).status).toBe(401);
    expect(await (await call(cloud.base, cloud.tokens!.admin).get('/api/whoami')).json()).toEqual({ auth: true, name: 'servicio', role: 'admin' });
    for (let i = 0; i < 5; i++) await call(cloud.base, `iark_s_mal${i}`).get('/api/whoami');
    expect((await call(cloud.base, await signIn(cloud, ANA)).get('/api/whoami')).status).toBe(429); // el freno vale para todos desde esa dirección
  });

  it('con cuentas y sin archivo de tokens, un token de `iark auth` no abre nada', async () => {
    const cloud = await startCloud();
    expect((await call(cloud.base, 'iark_abcdefghijklmnopqrstuvwxyz').get('/api/projects')).status).toBe(401);
    expect((await call(cloud.base).get('/api/projects')).status).toBe(401);
  });
});

describe('iark serve --accounts: cada persona ve sus proyectos', () => {
  const create = async (cloud: Cloud, token: string, name: string) => {
    const res = await call(cloud.base, token).post('/api/projects', { name });
    expect(res.status, `crear ${name}`).toBe(201);
    return res.json();
  };

  it('la lista solo trae los proyectos de quien llama, con su rol; uno ajeno es 404, como si no existiera', async () => {
    const cloud = await startCloud({ signup: 'open' });
    const ana = await signIn(cloud, ANA);
    const beto = await signIn(cloud, BETO);
    const tienda = await create(cloud, ana, 'Tienda');
    expect(tienda).toMatchObject({ id: 'tienda', role: 'admin' });
    expect(await (await call(cloud.base, beto).get('/api/projects')).json()).toEqual([]);
    const taller = await create(cloud, beto, 'Taller');
    expect(taller).toMatchObject({ role: 'admin' });
    expect((await (await call(cloud.base, beto).get('/api/projects')).json()).map((p: { id: string }) => p.id)).toEqual(['taller']);
    // Ana es administradora de la instancia: ve todos y es admin de todos
    expect((await (await call(cloud.base, ana).get('/api/projects')).json()).map((p: { id: string; role: string }) => [p.id, p.role])).toEqual([['taller', 'admin'], ['tienda', 'admin']]);
    // lo ajeno no se distingue de lo que no existe, en ninguna ruta, y no toca el disco
    const api = call(cloud.base, beto);
    const notFound = await api.get('/api/projects/tienda');
    const missing = await api.get('/api/projects/no-existe');
    expect(notFound.status).toBe(404);
    expect(missing.status).toBe(404);
    expect((await notFound.json()).error.replace('tienda', '')).toBe((await missing.json()).error.replace('no-existe', ''));
    for (const res of [
      await api.get('/api/projects/tienda/bundle'),
      await api.get('/api/projects/tienda/check'),
      await api.get('/api/projects/tienda/diagrams/x'),
      await api.post('/api/projects/tienda/diagrams', { module: 'data', text: example('ventas-datos.json') }),
      await api.put('/api/projects/tienda/diagrams/x', { text: '{}' }),
      await api.patch('/api/projects/tienda', { name: 'Mío' }),
      await api.del('/api/projects/tienda'),
    ]) {
      expect(res.status).toBe(404);
    }
    expect(readdirSync(join(cloud.root, 'tienda'))).toEqual(['project.json']);
    expect((await call(cloud.base, ana).get('/api/projects/tienda')).status).toBe(200);
  });

  it('un invitado (guest) no crea ni importa proyectos; entra a los que le comparten, con el rol que le dieron', async () => {
    const cloud = await startCloud();
    const ana = await signIn(cloud, ANA);
    await create(cloud, ana, 'Tienda');
    const guest = cloud.accounts.store.invite('carla', 'guest');
    const carla = await signIn(cloud, CARLA);
    const api = call(cloud.base, carla);
    expect((await api.get('/api/projects')).status).toBe(200);
    expect(await (await api.get('/api/projects')).json()).toEqual([]);
    for (const res of [await api.post('/api/projects', { name: 'Mío' }), await api.post('/api/projects/import', bundleToText(createBundle({ id: 'x', name: 'X', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', diagrams: [] })))]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'forbidden' });
    }
    expect(readdirSync(cloud.root)).toEqual(['tienda']);

    cloud.accounts.store.setMember('tienda', guest.id, 'viewer');
    expect((await api.get('/api/projects/tienda')).status).toBe(200);
    expect(await (await api.get('/api/projects')).json()).toEqual([expect.objectContaining({ id: 'tienda', role: 'viewer' })]);
    const denied = await api.post('/api/projects/tienda/diagrams', { module: 'data', text: example('ventas-datos.json') });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toMatch(/Tu rol en este proyecto es «viewer».*«editor»/);
    expect((await api.del('/api/projects/tienda')).status).toBe(403);
    expect((await api.patch('/api/projects/tienda', { name: 'Otro' })).status).toBe(403);

    cloud.accounts.store.setMember('tienda', guest.id, 'editor');
    expect((await api.post('/api/projects/tienda/diagrams', { module: 'data', name: 'Ventas', text: example('ventas-datos.json') })).status).toBe(201);
    expect((await api.patch('/api/projects/tienda', { name: 'Tienda web' })).status).toBe(200);
    expect((await api.del('/api/projects/tienda')).status).toBe(403); // borrar el proyecto es del admin
    cloud.accounts.store.setMember('tienda', guest.id, 'admin');
    expect((await api.del('/api/projects/tienda')).status).toBe(200);
  });

  it('el rol se comprueba antes que el cuerpo y que el disco: un viewer no sondea ni con peticiones torcidas', async () => {
    const cloud = await startCloud();
    const ana = await signIn(cloud, ANA);
    await create(cloud, ana, 'Tienda');
    const viewer = cloud.accounts.store.invite('carla', 'guest');
    cloud.accounts.store.setMember('tienda', viewer.id, 'viewer');
    const carla = await signIn(cloud, CARLA);
    const res = await fetch(`${cloud.base}/api/projects/tienda/diagrams/x`, { method: 'PUT', headers: { Authorization: `Bearer ${carla}`, 'Content-Type': 'text/plain' }, body: '¿?' });
    expect(res.status).toBe(403); // y no 415 ni 400
    expect((await call(cloud.base, carla).put('/api/projects/tienda/diagrams/..%2Fx', {})).status).toBe(403);
  });

  it('crear deja a la persona como admin del proyecto; borrarlo olvida a sus miembros: otro proyecto con el mismo nombre no los hereda', async () => {
    const cloud = await startCloud({ signup: 'open' });
    const ana = await signIn(cloud, ANA);
    const beto = await signIn(cloud, BETO);
    const betoId = cloud.accounts.store.findByLogin('beto')!.id;
    await create(cloud, ana, 'Tienda');
    cloud.accounts.store.setMember('tienda', betoId, 'editor');
    expect((await call(cloud.base, beto).get('/api/projects/tienda')).status).toBe(200);
    expect((await call(cloud.base, ana).del('/api/projects/tienda')).status).toBe(200);
    expect(cloud.accounts.store.membersOf('tienda')).toEqual([]);
    expect(JSON.parse(readFileSync(cloud.file, 'utf8')).projects).toEqual({});
    await create(cloud, ana, 'Tienda');
    expect((await call(cloud.base, beto).get('/api/projects/tienda')).status).toBe(404);
  });

  it('importar un proyecto desde su archivo único lo deja a nombre de quien lo importa', async () => {
    const cloud = await startCloud({ signup: 'open' });
    const beto = await signIn(cloud, BETO);
    const bundle = bundleToText(createBundle({ id: 'x', name: 'Importado', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', diagrams: [{ id: 'd', module: 'data', name: 'Ventas', text: example('ventas-datos.json'), createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }] }));
    const res = await fetch(`${cloud.base}/api/projects/import`, { method: 'POST', headers: { ...JSON_TYPE, Authorization: `Bearer ${beto}` }, body: bundle });
    expect(res.status).toBe(201);
    const imported = await res.json();
    expect(imported.project).toMatchObject({ name: 'Importado', role: 'admin' });
    expect(cloud.accounts.store.roleOf(cloud.accounts.store.findByLogin('beto')!.id, imported.project.id)).toBe('admin');
  });

  it('hay un tope de proyectos por persona; los administradores de la instancia no lo tienen', async () => {
    const cloud = await startCloud({ signup: 'open', maxProjectsPerUser: 2 });
    const ana = await signIn(cloud, ANA);
    const beto = await signIn(cloud, BETO);
    await create(cloud, beto, 'Uno');
    await create(cloud, beto, 'Dos');
    const third = await call(cloud.base, beto).post('/api/projects', { name: 'Tres' });
    expect(third.status).toBe(403);
    expect(await third.json()).toMatchObject({ code: 'limit', error: expect.stringContaining('máximo por persona') });
    expect(readdirSync(cloud.root).sort()).toEqual(['dos', 'uno']);
    for (const name of ['A', 'B', 'C']) await create(cloud, ana, name);
    // al borrar uno vuelve a caber
    expect((await call(cloud.base, beto).del('/api/projects/uno')).status).toBe(200);
    await create(cloud, beto, 'Tres');
  });

  it('si no se pueden guardar las cuentas, el proyecto recién creado no se queda huérfano en la carpeta', async () => {
    const cloud = await startCloud({ signup: 'open' });
    const beto = await signIn(cloud, BETO);
    rmSync(cloud.file);
    mkdirSync(cloud.file);
    writeFileSync(join(cloud.file, 'x'), '');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const res = await call(cloud.base, beto).post('/api/projects', { name: 'Tienda' });
    stderr.mockRestore();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'unavailable' });
    expect(readdirSync(cloud.root)).toEqual([]);
  });

  it('los tokens de `iark auth` siguen con su rol para toda la carpeta y sus respuestas no cambian', async () => {
    const cloud = await startCloud({ tokens: true, signup: 'open' });
    const beto = await signIn(cloud, BETO);
    await create(cloud, beto, 'Taller');
    const listed = await (await call(cloud.base, cloud.tokens!.admin).get('/api/projects')).json();
    expect(listed.map((p: { id: string }) => p.id)).toEqual(['taller']);
    expect(listed[0]).not.toHaveProperty('role');
    expect((await call(cloud.base, cloud.tokens!.admin).post('/api/projects', { name: 'Del servicio' })).status).toBe(201);
    // un proyecto creado con un token no pertenece a nadie: lo ven los tokens y los administradores, no los demás
    expect((await call(cloud.base, beto).get('/api/projects/del-servicio')).status).toBe(404);
    expect((await call(cloud.base, await signIn(cloud, ANA)).get('/api/projects/del-servicio')).status).toBe(200);
  });
});

describe('iark serve --accounts: CORS y secretos', () => {
  it('desde un origen de --cors el navegador puede cambiar el código, usar la sesión y cerrarla (preflight con Authorization)', async () => {
    const cloud = await startCloud({ cors: ['https://app.example.org'] });
    const pre = await fetch(`${cloud.base}/api/auth/exchange`, { method: 'OPTIONS', headers: { Origin: 'https://app.example.org', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://app.example.org');
    expect(pre.headers.get('access-control-allow-methods')).toMatch(/POST/);
    expect(pre.headers.get('access-control-allow-headers')).toMatch(/Authorization/);
    expect(pre.headers.get('access-control-allow-credentials')).toBeNull(); // la sesión es una cabecera, no una cookie

    const result = await loginWithGithub(cloud.base, cloud.fake, ANA, { redirect: 'https://app.example.org/' });
    const who = await fetch(`${cloud.base}/api/whoami`, { headers: { Origin: 'https://app.example.org', Authorization: `Bearer ${result.token}` } });
    expect(who.status).toBe(200);
    expect(who.headers.get('access-control-allow-origin')).toBe('https://app.example.org');
    const providers = await fetch(`${cloud.base}/api/auth/providers`, { headers: { Origin: 'https://app.example.org' } });
    expect(providers.headers.get('access-control-allow-origin')).toBe('https://app.example.org');
    const stranger = await fetch(`${cloud.base}/api/auth/providers`, { headers: { Origin: 'https://evil.example.com' } });
    expect(stranger.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('ni las sesiones, ni los códigos, ni el secreto de la OAuth App salen en lo que se escribe en stderr, en las respuestas de error ni en el archivo', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const cloud = await startCloud({ signup: 'open' });
    const verifier = newVerifier();
    const result = await loginWithGithub(cloud.base, cloud.fake, ANA, { verifier });
    const probes: string[] = [];
    for (const res of [
      await call(cloud.base, result.token).get('/api/projects/no-existe'),
      await call(cloud.base, 'iark_s_inventado').get('/api/projects'),
      await call(cloud.base).post('/api/auth/exchange', { code: result.fragment.get('iark_code') ?? 'x', verifier }),
      await fetch(`${cloud.base}/api/auth/github/callback?code=x&state=y`),
    ]) {
      probes.push(await res.text());
    }
    cloud.fake.failNext('token', 500);
    await loginWithGithub(cloud.base, cloud.fake, ANA);
    const everything = [...probes, readFileSync(cloud.file, 'utf8'), ...stderr.mock.calls.map((c) => String(c[0]))].join('\n');
    stderr.mockRestore();
    for (const secret of [result.token!, FAKE_CLIENT_SECRET, verifier, result.fragment.get('iark_code') ?? 'sin-codigo']) expect(everything).not.toContain(secret);
    expect(readFileSync(cloud.file, 'utf8')).toContain('"hash"');
  });
});
