import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectError } from '@iark/kernel';
import { BACKEND_KEY, loadBackend, saveBackend, TOKEN_KEY_PREFIX, type StorageAreas } from './backend';
import {
  completeGithubLogin,
  createPkcePair,
  detectManagedServer,
  getLoginNotice,
  isSessionToken,
  loginErrorMessage,
  PENDING_KEY,
  PENDING_MAX_AGE_MS,
  setLoginNotice,
  startGithubLogin,
  type LoginEnv,
} from './login';
import { fakeServer, type FakePerson, type FakeServer } from './testing';

const SERVER = 'https://iark.ejemplo.org';
const PAGE = 'https://app.ejemplo.org/modulos.html?module=data';
const ANA: FakePerson = { id: 'u_1', login: 'ana', name: 'Ana García', avatarUrl: 'https://avatars.example/u/1', siteRole: 'member' };

/** Un almacén en memoria con la forma de `Storage`; con `broken` lanza como en una ventana privada. */
const memory = (broken = false) => {
  const data = new Map<string, string>();
  const fail = (): never => {
    throw new DOMException('bloqueado', 'SecurityError');
  };
  return {
    data,
    getItem: (key: string) => (broken ? fail() : (data.get(key) ?? null)),
    setItem: (key: string, value: string) => (broken ? fail() : void data.set(key, value)),
    removeItem: (key: string) => (broken ? fail() : void data.delete(key)),
  };
};

/** Una pestaña de mentira: la página (con su dirección), `sessionStorage`, los almacenes del navegador y lo que se navega o se escribe en el historial. */
function tab(server: FakeServer, options: { href?: string; clock?: { now: number }; brokenSession?: boolean; brokenAreas?: boolean } = {}) {
  const clock = options.clock ?? { now: Date.parse('2026-10-06T10:00:00Z') };
  const session = memory(options.brokenSession);
  const areas = { local: memory(options.brokenAreas), session: memory(options.brokenAreas) } satisfies StorageAreas;
  const location = { href: options.href ?? PAGE };
  const navigations: string[] = [];
  const replaced: string[] = [];
  const env: LoginEnv = {
    crypto: webcrypto as unknown as LoginEnv['crypto'],
    fetch: server.fetch,
    session,
    areas,
    location,
    history: { state: null, replaceState: (_state: unknown, _title: string, url?: string | URL | null) => void replaced.push(String(url)) },
    navigate: (url) => void navigations.push(url),
    now: () => clock.now,
  };
  return { env, session, areas, location, navigations, replaced, clock };
}

/** Sale hacia GitHub y vuelve con el código que el servidor habría emitido para esa persona. */
async function roundTrip(server: FakeServer, t: ReturnType<typeof tab>, person: FakePerson, input: { remember: boolean; server?: string } = { remember: true }): Promise<string> {
  await startGithubLogin({ server: input.server ?? SERVER, remember: input.remember }, t.env);
  const challenge = new URL(t.navigations.at(-1)!).searchParams.get('challenge')!;
  const code = server.issueCode(person, challenge);
  t.location.href = `${PAGE}#iark_code=${code}`;
  return code;
}

describe('inicio de sesión con GitHub: salir hacia GitHub', () => {
  beforeEach(() => setLoginNotice(undefined));

  it('genera un verifier de 43 caracteres base64url y su challenge sha256, distintos cada vez', async () => {
    const first = await createPkcePair({ crypto: webcrypto as unknown as LoginEnv['crypto'] });
    const second = await createPkcePair({ crypto: webcrypto as unknown as LoginEnv['crypto'] });
    expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.verifier).not.toBe(second.verifier);
    const expected = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(first.verifier))).toString('base64url');
    expect(first.challenge).toBe(expected);
  });

  it('guarda {url, verifier, remember, startedAt} en sessionStorage y navega a /api/auth/github/login pidiendo volver a esta misma página sin fragmento', async () => {
    const t = tab(fakeServer({ accounts: true }), { href: `${PAGE}#restos` });
    const target = await startGithubLogin({ server: `${SERVER}/`, remember: false }, t.env);
    expect(t.navigations).toEqual([target]);
    const url = new URL(target);
    expect(`${url.origin}${url.pathname}`).toBe(`${SERVER}/api/auth/github/login`);
    expect(url.searchParams.get('redirect')).toBe(PAGE); // la misma página, con su consulta y sin el fragmento
    const challenge = url.searchParams.get('challenge')!;
    const pending = JSON.parse(t.session.data.get(PENDING_KEY)!);
    expect(pending).toEqual({ url: SERVER, verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), remember: false, startedAt: t.clock.now });
    expect(Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(pending.verifier))).toString('base64url')).toBe(challenge);
    expect(target).not.toContain(pending.verifier); // el secreto no viaja en la dirección
    expect([...t.areas.local.data.keys(), ...t.areas.session.data.keys()]).toEqual([]); // aún no hay sesión ni configuración
  });

  it('una dirección que no vale, sin sessionStorage o sin criptografía se explica y no navega', async () => {
    const server = fakeServer({ accounts: true });
    const bad = tab(server);
    await expect(startGithubLogin({ server: 'iark.ejemplo.org', remember: true }, bad.env)).rejects.toMatchObject({ code: 'invalid' });
    const blocked = tab(server, { brokenSession: true });
    await expect(startGithubLogin({ server: SERVER, remember: true }, blocked.env)).rejects.toThrow(/no deja guardar datos de esta pestaña/);
    const full = tab(server);
    await expect(startGithubLogin({ server: SERVER, remember: true }, { ...full.env, session: { getItem: () => null, setItem: () => memory(true).setItem('a', 'b'), removeItem: () => undefined } })).rejects.toThrow(/no deja guardar datos de esta pestaña/);
    const insecure = tab(server);
    const failure = await startGithubLogin({ server: SERVER, remember: true }, { ...insecure.env, crypto: { getRandomValues: ((array: ArrayBufferView) => webcrypto.getRandomValues(array as Uint8Array)) as NonNullable<LoginEnv['crypto']>['getRandomValues'] } }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ProjectError);
    expect((failure as ProjectError).message).toMatch(/https/);
    for (const t of [bad, blocked, full, insecure]) expect(t.navigations).toEqual([]);
  });
});

describe('inicio de sesión con GitHub: volver', () => {
  beforeEach(() => setLoginNotice(undefined));

  it('sin fragmento no hace nada ni toca el almacenamiento; un inicio a medias y viejo se olvida, uno reciente se respeta', async () => {
    const server = fakeServer({ accounts: true });
    const t = tab(server);
    expect(await completeGithubLogin(t.env)).toEqual({ status: 'none' });
    expect(t.replaced).toEqual([]);
    expect(server.log).toEqual([]);
    await startGithubLogin({ server: SERVER, remember: true }, t.env);
    t.clock.now += PENDING_MAX_AGE_MS - 1_000;
    await completeGithubLogin(t.env);
    expect(t.session.data.has(PENDING_KEY)).toBe(true); // todavía puede volver
    t.clock.now += 2_000;
    await completeGithubLogin(t.env);
    expect(t.session.data.has(PENDING_KEY)).toBe(false); // el verifier no se queda eternamente en la pestaña
    expect(getLoginNotice()).toBeUndefined();
  });

  it('cambia el código por la sesión, la guarda (en este equipo si se pidió), deja activo el servidor y quita el código de la dirección', async () => {
    const server = fakeServer({ accounts: true });
    const t = tab(server);
    saveBackend({ url: SERVER, label: 'Oficina' }, { active: false }, t.areas); // un servidor ya conocido con su nombre
    const code = await roundTrip(server, t, ANA, { remember: true });
    const outcome = await completeGithubLogin(t.env);

    expect(outcome).toMatchObject({ status: 'ok', url: SERVER, remember: true, user: { login: 'ana', name: 'Ana García', siteRole: 'member' } });
    expect(t.replaced).toEqual(['/modulos.html?module=data']); // sin código, sin fragmento: no queda en el historial
    expect(t.replaced.join('')).not.toContain(code);
    expect(t.session.data.has(PENDING_KEY)).toBe(false);
    const stored = loadBackend(t.areas);
    expect(stored).toMatchObject({ kind: 'remote', url: SERVER, label: 'Oficina', remembered: true });
    expect(stored.kind === 'remote' && isSessionToken(stored.token)).toBe(true);
    expect([...server.sessions.values()].map((p) => p.login)).toEqual(['ana']);
    expect(getLoginNotice()).toEqual({ kind: 'ok', message: 'Sesión iniciada como Ana García (@ana) en iark.ejemplo.org.' });
  });

  it('sin «mantener la sesión» el token queda solo en la pestaña', async () => {
    const server = fakeServer({ accounts: true });
    const t = tab(server);
    await roundTrip(server, t, ANA, { remember: false });
    expect(await completeGithubLogin(t.env)).toMatchObject({ status: 'ok', remember: false });
    expect([...t.areas.local.data.keys()]).toEqual([BACKEND_KEY]);
    expect([...t.areas.session.data.keys()]).toEqual([`${TOKEN_KEY_PREFIX}${SERVER}`]);
    expect(loadBackend(t.areas)).toMatchObject({ remembered: false });
  });

  it('solo quita iark_code e iark_error del fragmento: lo demás se respeta', async () => {
    const server = fakeServer({ accounts: true });
    const t = tab(server);
    const code = await roundTrip(server, t, ANA);
    t.location.href = `${PAGE}#seccion=2&iark_code=${code}`;
    await completeGithubLogin(t.env);
    expect(t.replaced).toEqual(['/modulos.html?module=data#seccion=2']);
  });

  it('ni la sesión ni el verifier aparecen en lo que devuelve, en el aviso ni en la dirección', async () => {
    const server = fakeServer({ accounts: true });
    const t = tab(server);
    await roundTrip(server, t, ANA);
    const verifier = JSON.parse(t.session.data.get(PENDING_KEY)!).verifier as string;
    const outcome = await completeGithubLogin(t.env);
    const token = [...server.sessions.keys()][0];
    for (const text of [JSON.stringify(outcome), JSON.stringify(getLoginNotice()), t.replaced.join('\n'), t.location.href]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(verifier);
    }
  });

  it('cada motivo con que el servidor devuelve a la persona se explica en español; uno desconocido no se repite', async () => {
    const server = fakeServer({ accounts: true });
    const messages = new Map<string, string>();
    for (const reason of ['access_denied', 'not_invited', 'disabled', 'github_unavailable', 'login_failed']) {
      const t = tab(server);
      await startGithubLogin({ server: SERVER, remember: true }, t.env);
      t.location.href = `${PAGE}#iark_error=${reason}`;
      const outcome = await completeGithubLogin(t.env);
      expect(outcome).toMatchObject({ status: 'error', reason, url: SERVER });
      expect(t.replaced).toEqual(['/modulos.html?module=data']);
      expect(t.session.data.has(PENDING_KEY)).toBe(false);
      expect(loadBackend(t.areas)).toEqual({ kind: 'local' }); // no se guardó nada
      expect(getLoginNotice()).toEqual({ kind: 'error', reason, message: (outcome as { message: string }).message, url: SERVER });
      messages.set(reason, getLoginNotice()!.message);
    }
    expect(messages.get('not_invited')).toBe('Esta instancia es solo por invitación: pide a quien la administra que te invite con tu usuario de GitHub.');
    expect(new Set(messages.values()).size).toBe(5); // cada una dice lo suyo
    const t = tab(server);
    t.location.href = `${PAGE}#iark_error=%3Cb%3Ehackeado%3C%2Fb%3E`;
    const outcome = await completeGithubLogin(t.env);
    expect(outcome).toMatchObject({ status: 'error', reason: 'login_failed' });
    expect(getLoginNotice()!.message).toBe(loginErrorMessage('login_failed'));
    expect(getLoginNotice()!.message).not.toContain('hackeado');
  });

  it('un código sin un inicio de sesión anotado en esta pestaña no se manda a ningún servidor', async () => {
    const server = fakeServer({ accounts: true });
    const t = tab(server);
    t.location.href = `${PAGE}#iark_code=abc`;
    const outcome = await completeGithubLogin(t.env);
    expect(outcome).toMatchObject({ status: 'error', reason: 'stale' });
    expect(getLoginNotice()!.message).toMatch(/esta pestaña no lo había empezado/);
    expect(t.replaced).toEqual(['/modulos.html?module=data']);
    expect(server.log).toEqual([]);
  });

  it('un anotado dañado o con otra forma tampoco vale, y se borra', async () => {
    const server = fakeServer({ accounts: true });
    for (const garbage of ['no es json', '{"url":1}', 'null', JSON.stringify({ url: SERVER, verifier: 7, startedAt: 1 })]) {
      const t = tab(server);
      t.session.data.set(PENDING_KEY, garbage);
      t.location.href = `${PAGE}#iark_code=abc`;
      expect(await completeGithubLogin(t.env)).toMatchObject({ status: 'error', reason: 'stale' });
      expect(t.session.data.has(PENDING_KEY)).toBe(false);
    }
    expect(server.log).toEqual([]);
  });

  it('si pasaron más de 10 minutos caduca sin preguntar al servidor', async () => {
    const server = fakeServer({ accounts: true });
    const t = tab(server);
    await roundTrip(server, t, ANA);
    t.clock.now += PENDING_MAX_AGE_MS + 1;
    expect(await completeGithubLogin(t.env)).toMatchObject({ status: 'error', reason: 'expired' });
    expect(getLoginNotice()!.message).toMatch(/10 minutos/);
    expect(server.exchanges).toBe(0);
    expect(server.sessions.size).toBe(0);
  });

  it('el código solo se entrega al servidor que se eligió al empezar, no a otro, y un código no se puede usar dos veces', async () => {
    const server = fakeServer({ accounts: true });
    const asked: string[] = [];
    const t = tab(server, { href: 'https://otro-sitio.example/modulos.html' });
    t.env.fetch = ((input: RequestInfo | URL, init?: RequestInit) => (asked.push(String(input)), server.fetch(input, init))) as typeof fetch;
    const code = await roundTrip(server, t, ANA, { remember: true, server: 'https://elegido.example:8443' });
    t.location.href = `https://otro-sitio.example/modulos.html#iark_code=${code}`;
    await completeGithubLogin(t.env);
    expect(asked).toEqual(['https://elegido.example:8443/api/auth/exchange']);
    expect(loadBackend(t.areas)).toMatchObject({ url: 'https://elegido.example:8443' });
    // repetir la vuelta (otra vez la misma dirección con el mismo código) no vuelve a llegar al servidor
    t.location.href = `https://otro-sitio.example/modulos.html#iark_code=${code}`;
    expect(await completeGithubLogin(t.env)).toMatchObject({ status: 'error', reason: 'stale' });
    expect(asked).toHaveLength(1);
    expect(server.exchanges).toBe(1);
  });

  it('si el servidor no acepta el código (caducó o se usó) lo dice y no guarda nada; el código quedó gastado', async () => {
    const server = fakeServer({ accounts: true });
    const t = tab(server);
    await startGithubLogin({ server: SERVER, remember: true }, t.env);
    // un código que el servidor nunca emitió (o ya gastó) con el verifier bueno
    t.location.href = `${PAGE}#iark_code=ya-no-vale`;
    expect(await completeGithubLogin(t.env)).toMatchObject({ status: 'error', reason: 'invalid_grant', url: SERVER });
    expect(getLoginNotice()!.message).toMatch(/no aceptó el código/);
    expect(loadBackend(t.areas)).toEqual({ kind: 'local' });
    expect(t.session.data.has(PENDING_KEY)).toBe(false);
    expect(server.exchanges).toBe(1);
  });

  it('un servidor al que no se llega o que frena los intentos se explica', async () => {
    const server = fakeServer({ accounts: true });
    const t = tab(server);
    await roundTrip(server, t, ANA);
    server.down = true;
    expect(await completeGithubLogin(t.env)).toMatchObject({ status: 'error', reason: 'unreachable' });
    expect(getLoginNotice()!.message).toContain('iark.ejemplo.org');

    const limited = tab(server);
    await startGithubLogin({ server: SERVER, remember: true }, limited.env);
    limited.location.href = `${PAGE}#iark_code=x`;
    const frozen: LoginEnv = { ...limited.env, fetch: (async () => new Response(JSON.stringify({ error: 'Demasiados intentos', code: 'rate-limited' }), { status: 429, headers: { 'Retry-After': '30' } })) as typeof fetch };
    expect(await completeGithubLogin(frozen)).toMatchObject({ status: 'error', reason: 'rate_limited' });
    expect(getLoginNotice()!.message).toMatch(/Demasiados intentos/);

    const broken = tab(server);
    await startGithubLogin({ server: SERVER, remember: true }, broken.env);
    broken.location.href = `${PAGE}#iark_code=x`;
    const html: LoginEnv = { ...broken.env, fetch: (async () => new Response('<html>Bad gateway</html>', { status: 502 })) as typeof fetch };
    expect(await completeGithubLogin(html)).toMatchObject({ status: 'error', reason: 'server' });
  });

  it('si el navegador no deja guardar la sesión, lo dice y la cierra en el servidor para no dejarla abierta', async () => {
    const server = fakeServer({ accounts: true });
    const t = tab(server);
    await roundTrip(server, t, ANA);
    const blocked: LoginEnv = { ...t.env, areas: { local: memory(true), session: memory(true) } };
    const outcome = await completeGithubLogin(blocked);
    expect(outcome).toMatchObject({ status: 'error', reason: 'storage' });
    expect(getLoginNotice()!.message).toMatch(/no deja guardar la sesión/);
    expect(server.sessions.size).toBe(0);
  });

  it('la sesión de otra pestaña (sessionStorage aparte) no se mezcla: cada pestaña completa solo su inicio', async () => {
    const server = fakeServer({ accounts: true });
    const first = tab(server);
    const second = tab(server);
    const code = await roundTrip(server, first, ANA);
    second.location.href = `${PAGE}#iark_code=${code}`; // el enlace se abrió en otra pestaña
    expect(await completeGithubLogin(second.env)).toMatchObject({ status: 'error', reason: 'stale' });
    expect(server.exchanges).toBe(0);
    expect(await completeGithubLogin(first.env)).toMatchObject({ status: 'ok' });
  });
});

describe('instancia gestionada de la que viene la página', () => {
  it('la carpeta de la página con api/auth/providers que ofrece GitHub es la dirección que se propone', async () => {
    const server = fakeServer({ accounts: true });
    expect(await detectManagedServer({ fetch: server.fetch, location: { href: 'https://iark.ejemplo.org/modulos.html?module=data' } })).toMatchObject({ url: 'https://iark.ejemplo.org', providers: { providers: [{ id: 'github', label: 'GitHub' }] } });
    expect(server.log).toEqual(['GET /api/auth/providers']);
    // detrás de un proxy en una subcarpeta, la API está junto a la página
    const asked: string[] = [];
    const behindProxy = (async (input: RequestInfo | URL) => (asked.push(String(input)), Response.json({ providers: [{ id: 'github', label: 'GitHub' }], tokens: false }))) as typeof fetch;
    expect(await detectManagedServer({ fetch: behindProxy, location: { href: 'https://ejemplo.org/iark/index.html' } })).toMatchObject({ url: 'https://ejemplo.org/iark' });
    expect(asked).toEqual(['https://ejemplo.org/iark/api/auth/providers']);
  });

  it('en GitHub Pages (404), con una página que no es JSON, sin GitHub, sin red o fuera de http no hay nada que proponer, y sin lanzar', async () => {
    const location = { href: 'https://usuario.github.io/diagrams/modulos.html' };
    expect(await detectManagedServer({ fetch: fakeServer().fetch, location })).toBeUndefined(); // 404 de un sitio estático
    expect(await detectManagedServer({ fetch: (async () => new Response('<!doctype html><title>app</title>')) as typeof fetch, location })).toBeUndefined();
    expect(await detectManagedServer({ fetch: (async () => Response.json({ providers: [], tokens: true })) as typeof fetch, location })).toBeUndefined();
    const down = fakeServer({ accounts: true });
    down.down = true;
    expect(await detectManagedServer({ fetch: down.fetch, location })).toBeUndefined();
    expect(await detectManagedServer({ fetch: fakeServer({ accounts: true }).fetch, location: { href: 'file:///home/yo/dist/modulos.html' } })).toBeUndefined();
    expect(await detectManagedServer({ fetch: fakeServer({ accounts: true }).fetch, location: { href: 'no es una url' } })).toBeUndefined();
  });

  it('el aviso de la vuelta se puede leer, suscribirse y quitar', () => {
    const listener = vi.fn();
    // se importa aquí abajo para no depender del orden de las demás pruebas
    return import('./login').then(({ subscribeLoginNotice }) => {
      const off = subscribeLoginNotice(listener);
      setLoginNotice({ kind: 'error', message: 'x', reason: 'y' });
      expect(getLoginNotice()).toEqual({ kind: 'error', message: 'x', reason: 'y' });
      setLoginNotice(undefined);
      off();
      setLoginNotice({ kind: 'ok', message: 'z' });
      expect(listener).toHaveBeenCalledTimes(2);
      setLoginNotice(undefined);
    });
  });
});
