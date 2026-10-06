import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GithubError, GithubOAuth, parseGithubProfile } from './github';
import { Accounts, normalizePublicUrl, parseAdminList } from './service';
import { readClientSecret, setupAccounts } from './setup';
import { AccountError, AccountStore, MAX_MEMBERS_PER_PROJECT, MAX_SESSIONS_PER_USER, parseAccountsFile, parseLogin, SESSION_PREFIX } from './store';

const folders: string[] = [];
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'iark-cuentas-'));
  folders.push(dir);
  return dir;
};
const open = (options: ConstructorParameters<typeof Object>[0] = {}) => {
  const file = join(tmp(), 'cuentas.json');
  return { file, store: AccountStore.open(file, options as never) };
};

const ana = { id: 101, login: 'ana', name: 'Ana Pérez', avatarUrl: 'https://avatars.example.test/101' };
const beto = { id: 202, login: 'Beto' };
const OPEN = { signup: 'open', admin: false } as const;
const INVITE = { signup: 'invite', admin: false } as const;

describe('AccountStore: el archivo', () => {
  it('se crea vacío con modo 0600 si no existe y vuelve a leerse igual', () => {
    const { file, store } = open();
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const user = store.signIn(ana, OPEN);
    store.registerProject('tienda', user.id);
    const session = store.createSession(user.id, 60_000);
    const again = AccountStore.open(file);
    expect(again.users()).toEqual([expect.objectContaining({ login: 'ana', githubId: 101, name: 'Ana Pérez', siteRole: 'member' })]);
    expect(again.roleOf(user.id, 'tienda')).toBe('admin');
    expect(again.lookupSession(session.token)?.login).toBe('ana');
  });

  it('del token de una sesión solo queda su hash: ni el archivo ni la memoria lo guardan', () => {
    const { file, store } = open();
    const { token } = store.createSession(store.signIn(ana, OPEN).id, 60_000);
    expect(token.startsWith(SESSION_PREFIX)).toBe(true);
    expect(readFileSync(file, 'utf8')).not.toContain(token);
    expect(JSON.parse(readFileSync(file, 'utf8')).sessions[0].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('un archivo dañado no se abre ni se reemplaza: lo dice sin citar su contenido', () => {
    const file = join(tmp(), 'cuentas.json');
    for (const text of ['no es json', '[]', '{"version":2,"users":[],"sessions":[],"projects":{}}', '{"version":1,"users":[{"id":"u","login":"ana","siteRole":"rey","createdAt":"2026-01-01T00:00:00Z"}],"sessions":[],"projects":{}}']) {
      writeFileSync(file, text);
      expect(() => AccountStore.open(file)).toThrowError(expect.objectContaining({ code: 'corrupt' }));
      expect(readFileSync(file, 'utf8')).toBe(text);
    }
    const secret = 'hash-secreto-que-no-debe-salir';
    expect(() => parseAccountsFile(JSON.stringify({ version: 1, users: [], sessions: [{ hash: secret, userId: 'x', createdAt: 'a', expiresAt: 'b' }], projects: {} }))).toThrowError(
      expect.objectContaining({ code: 'corrupt', message: expect.not.stringContaining(secret) }),
    );
  });

  it('referencias rotas, duplicados y miembros repetidos son un archivo dañado', () => {
    const user = { id: 'u1', login: 'ana', githubId: 1, siteRole: 'member', createdAt: '2026-01-01T00:00:00Z' };
    const base = { version: 1, users: [user], sessions: [], projects: {} };
    const bad = [
      { ...base, users: [user, { ...user, id: 'u2' }] }, // login repetido
      { ...base, users: [user, { ...user, id: 'u2', login: 'otra' }] }, // githubId repetido
      { ...base, sessions: [{ hash: 'a'.repeat(64), userId: 'nadie', createdAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-02T00:00:00Z' }] },
      { ...base, projects: { p: [{ userId: 'nadie', role: 'admin', addedAt: '2026-01-01T00:00:00Z' }] } },
      { ...base, projects: { p: [{ userId: 'u1', role: 'dios', addedAt: '2026-01-01T00:00:00Z' }] } },
      { ...base, projects: { p: [{ userId: 'u1', role: 'admin', addedAt: '2026-01-01T00:00:00Z' }, { userId: 'u1', role: 'viewer', addedAt: '2026-01-01T00:00:00Z' }] } },
    ];
    for (const value of bad) expect(() => parseAccountsFile(JSON.stringify(value))).toThrowError(expect.objectContaining({ code: 'corrupt' }));
    expect(() => parseAccountsFile(JSON.stringify(base))).not.toThrow();
  });

  it('un cambio que no se pudo guardar se deshace en memoria', () => {
    const { file, store } = open();
    store.signIn(ana, OPEN);
    rmSync(file);
    mkdirSync(file); // el destino pasa a ser una carpeta que no está vacía: el `rename` falla
    writeFileSync(join(file, 'x'), '');
    expect(() => store.signIn(beto, OPEN)).toThrowError(expect.objectContaining({ code: 'unavailable' }));
    expect(store.users().map((u) => u.login)).toEqual(['ana']);
    expect(store.userCount).toBe(1);
  });

  it('con una carpeta en lugar del archivo, avisa de lo que pasa con Docker', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'cuentas.json'));
    expect(() => AccountStore.open(join(dir, 'cuentas.json'))).toThrowError(/no es un archivo.*Docker/s);
  });
});

describe('AccountStore: quién entra', () => {
  it('con invitación solo entran las cuentas invitadas y los administradores; abierta, cualquiera como member', () => {
    const { store } = open();
    expect(() => store.signIn(ana, INVITE)).toThrowError(expect.objectContaining({ code: 'not-invited' }));
    expect(store.userCount).toBe(0);
    // un administrador de la lista entra aunque sea por invitación, y su cuenta guarda `member`: el rol de administrador lo da la lista, no el archivo
    expect(store.signIn(ana, { signup: 'invite', admin: true }).siteRole).toBe('member');
    expect(store.signIn(beto, OPEN).siteRole).toBe('member');
  });

  it('una invitación por nombre de usuario la reclama quien entra con ese nombre, sin distinguir mayúsculas', () => {
    const { store } = open();
    const invited = store.invite('@BETO', 'guest');
    expect(invited).toMatchObject({ login: 'BETO', siteRole: 'guest' });
    expect(invited.githubId).toBeUndefined();
    const signedIn = store.signIn(beto, INVITE);
    expect(signedIn).toMatchObject({ id: invited.id, githubId: 202, login: 'Beto', siteRole: 'guest' });
    expect(store.userCount).toBe(1);
  });

  it('se reconoce a la persona por su id de GitHub: si cambia de nombre de usuario se actualiza su cuenta, no se crea otra', () => {
    const { store } = open();
    const first = store.signIn(ana, OPEN);
    const again = store.signIn({ ...ana, login: 'ana-nueva', name: undefined }, OPEN);
    expect(again.id).toBe(first.id);
    expect(again).toMatchObject({ login: 'ana-nueva' });
    expect(again.name).toBeUndefined();
    expect(store.userCount).toBe(1);
  });

  it('si alguien toma el nombre de usuario que dejó otra persona, la cuenta antigua conserva su id pero pierde el nombre', () => {
    const { store } = open();
    const old = store.signIn(ana, OPEN);
    const newcomer = store.signIn({ id: 303, login: 'ANA' }, OPEN);
    expect(newcomer.id).not.toBe(old.id);
    expect(store.findByLogin('ana')?.id).toBe(newcomer.id);
    expect(store.findUser(old.id)?.login).toBe('ana~101');
    expect(() => parseLogin('ana~101')).toThrowError(AccountError); // ese nombre no se puede invitar ni reclamar
  });

  it('una persona conocida que entra con el nombre al que habían invitado hereda lo invitado y la invitación desaparece', () => {
    const { store } = open();
    const known = store.signIn({ id: 5, login: 'viejo' }, OPEN);
    const pending = store.invite('nuevo', 'guest');
    store.setMember('p1', pending.id, 'editor');
    store.setMember('p2', pending.id, 'admin');
    store.setMember('p2', known.id, 'viewer');
    store.signIn({ id: 5, login: 'nuevo' }, OPEN);
    expect(store.users().map((u) => u.login)).toEqual(['nuevo']);
    expect(store.roleOf(known.id, 'p1')).toBe('editor');
    expect(store.roleOf(known.id, 'p2')).toBe('admin'); // el rol mayor de los dos
    expect(store.membersOf('p2')).toHaveLength(1);
  });

  it('una cuenta desactivada no entra y pierde sus sesiones', () => {
    const { store } = open();
    const user = store.signIn(ana, OPEN);
    const { token } = store.createSession(user.id, 60_000);
    store.updateUser(user.id, { disabled: true });
    expect(store.lookupSession(token)).toBeUndefined();
    expect(() => store.signIn(ana, OPEN)).toThrowError(expect.objectContaining({ code: 'disabled' }));
    store.updateUser(user.id, { disabled: false });
    expect(store.signIn(ana, OPEN).id).toBe(user.id);
  });

  it('solo se acumulan invitaciones hasta un tope', () => {
    const { store } = open();
    expect(() => {
      for (let i = 0; i < 1000; i++) store.invite(`persona${i}`);
    }).toThrowError(expect.objectContaining({ code: 'limit' }));
    expect(store.userCount).toBe(500);
  });

  it('parseLogin acepta nombres de GitHub y rechaza lo demás', () => {
    expect(parseLogin('  @ana-maria ')).toBe('ana-maria');
    expect(parseLogin('ana_acme')).toBe('ana_acme');
    for (const bad of ['', '-ana', 'ana-', 'a--b', 'ana maria', 'a'.repeat(40), 'ana/../x', 'ana[bot]', 3]) expect(() => parseLogin(bad)).toThrowError(expect.objectContaining({ code: 'invalid' }));
  });
});

describe('AccountStore: sesiones', () => {
  it('una sesión vale hasta que caduca o se cierra', () => {
    let now = Date.parse('2026-10-01T00:00:00Z');
    const { store } = open({ now: () => new Date(now) });
    const user = store.signIn(ana, OPEN);
    const { token, expiresAt } = store.createSession(user.id, 3600_000);
    expect(expiresAt).toBe('2026-10-01T01:00:00.000Z');
    expect(store.lookupSession(token)?.id).toBe(user.id);
    now += 3600_000 - 1;
    expect(store.lookupSession(token)).toBeDefined();
    now += 1;
    expect(store.lookupSession(token)).toBeUndefined();

    const fresh = store.createSession(user.id, 3600_000);
    expect(store.revokeSession(fresh.token)).toBe(true);
    expect(store.lookupSession(fresh.token)).toBeUndefined();
    expect(store.revokeSession(fresh.token)).toBe(false);
    expect(store.lookupSession('iark_s_inventado')).toBeUndefined();
  });

  it('crear una sesión limpia las caducadas y cierra las más antiguas si hay demasiadas', () => {
    let now = Date.parse('2026-10-01T00:00:00Z');
    const { store, file } = open({ now: () => new Date(now) });
    const user = store.signIn(ana, OPEN);
    const first = store.createSession(user.id, 1000);
    now += 5000;
    const tokens: string[] = [];
    for (let i = 0; i < MAX_SESSIONS_PER_USER + 5; i++) {
      now += 1000;
      tokens.push(store.createSession(user.id, 3600_000).token);
    }
    expect(store.lookupSession(first.token)).toBeUndefined();
    expect(store.sessionCount(user.id)).toBe(MAX_SESSIONS_PER_USER);
    expect(JSON.parse(readFileSync(file, 'utf8')).sessions).toHaveLength(MAX_SESSIONS_PER_USER);
    expect(store.lookupSession(tokens[0])).toBeUndefined(); // las más antiguas se cerraron
    expect(store.lookupSession(tokens[tokens.length - 1])).toBeDefined();
  });
});

describe('AccountStore: pertenencia a proyectos', () => {
  it('quien crea un proyecto es su administrador; registrar el mismo id otra vez reemplaza a los miembros anteriores', () => {
    const { store } = open();
    const a = store.signIn(ana, OPEN);
    const b = store.signIn(beto, OPEN);
    store.registerProject('tienda', a.id);
    store.setMember('tienda', b.id, 'viewer');
    expect(store.membersOf('tienda').map((m) => [m.user.login, m.role])).toEqual([['ana', 'admin'], ['Beto', 'viewer']]);
    expect([...store.rolesOf(b.id)]).toEqual([['tienda', 'viewer']]);
    expect(store.adminCount(a.id)).toBe(1);
    expect(store.adminCount(b.id)).toBe(0);
    store.registerProject('tienda', b.id); // otro proyecto con el mismo id: no hereda a Ana
    expect(store.roleOf(a.id, 'tienda')).toBeUndefined();
    expect(store.roleOf(b.id, 'tienda')).toBe('admin');
  });

  it('añadir, cambiar de rol, quitar y olvidar un proyecto', () => {
    const { store, file } = open();
    const a = store.signIn(ana, OPEN);
    const b = store.signIn(beto, OPEN);
    store.registerProject('p', a.id);
    store.setMember('p', b.id, 'viewer');
    store.setMember('p', b.id, 'editor');
    expect(store.roleOf(b.id, 'p')).toBe('editor');
    expect(store.removeMember('p', b.id)).toBe(true);
    expect(store.removeMember('p', b.id)).toBe(false);
    expect(() => store.setMember('p', 'u_nadie', 'viewer')).toThrowError(expect.objectContaining({ code: 'not-found' }));
    expect(() => store.setMember('p', b.id, 'dios' as never)).toThrowError(expect.objectContaining({ code: 'invalid' }));
    store.dropProject('p');
    expect(store.membersOf('p')).toEqual([]);
    expect(JSON.parse(readFileSync(file, 'utf8')).projects).toEqual({});
  });

  it('un proyecto admite hasta un máximo de personas', () => {
    const { store } = open();
    const owner = store.signIn(ana, OPEN);
    store.registerProject('p', owner.id);
    for (let i = 0; i < MAX_MEMBERS_PER_PROJECT - 1; i++) store.setMember('p', store.invite(`persona${i}`).id, 'viewer');
    expect(() => store.setMember('p', store.invite('una-mas').id, 'viewer')).toThrowError(expect.objectContaining({ code: 'limit' }));
  });
});

describe('AccountStore: compartir proyectos y administrar cuentas', () => {
  const carla = { id: 303, login: 'carla' };

  it('un proyecto no se queda sin administrador: ni quitando ni bajando de rol a la única persona que lo administra', () => {
    const { store } = open();
    const a = store.signIn(ana, OPEN);
    const b = store.signIn(beto, OPEN);
    store.registerProject('p', a.id);
    store.setMember('p', b.id, 'editor');
    expect(() => store.removeMember('p', a.id)).toThrowError(expect.objectContaining({ code: 'last-admin' }));
    expect(() => store.setMember('p', a.id, 'editor')).toThrowError(expect.objectContaining({ code: 'last-admin' }));
    expect(() => store.shareProject('p', 'ana', 'viewer', 'guest')).toThrowError(expect.objectContaining({ code: 'last-admin' }));
    expect(store.roleOf(a.id, 'p')).toBe('admin');
    store.setMember('p', b.id, 'admin'); // con otra persona administradora, la primera puede irse o bajar
    expect(store.removeMember('p', a.id)).toBe(true);
    expect(() => store.setMember('p', b.id, 'viewer')).toThrowError(expect.objectContaining({ code: 'last-admin' }));
  });

  it('shareProject comparte con quien ya entró, invita a quien no tiene cuenta y cambia el rol si ya pertenece', () => {
    const { store, file } = open();
    const a = store.signIn(ana, OPEN);
    store.registerProject('p', a.id);
    store.signIn(beto, OPEN);
    const known = store.shareProject('p', '@BETO', 'editor', 'guest');
    expect(known).toMatchObject({ added: true, invited: false, user: { login: 'Beto', githubId: 202 } });
    const invited = store.shareProject('p', 'carla', 'viewer', 'guest');
    expect(invited).toMatchObject({ added: true, invited: true, user: { login: 'carla', siteRole: 'guest' } });
    expect(invited.user.githubId).toBeUndefined();
    const changed = store.shareProject('p', 'Carla', 'editor', 'guest');
    expect(changed).toMatchObject({ added: false, invited: false });
    expect(store.membersOf('p').map((m) => [m.user.login, m.role])).toEqual([['ana', 'admin'], ['Beto', 'editor'], ['carla', 'editor']]);
    expect(() => store.shareProject('p', 'no es un usuario', 'viewer', 'guest')).toThrowError(expect.objectContaining({ code: 'invalid' }));
    expect(() => store.shareProject('p', 'dani', 'dios' as never, 'guest')).toThrowError(expect.objectContaining({ code: 'invalid' }));
    expect(store.findByLogin('dani')).toBeUndefined();
    // la invitación se reclama al entrar: la misma cuenta, con sus proyectos
    const claimed = store.signIn(carla, INVITE);
    expect(claimed.id).toBe(invited.user.id);
    expect(store.roleOf(claimed.id, 'p')).toBe('editor');
    expect(JSON.parse(readFileSync(file, 'utf8')).users).toHaveLength(3);
  });

  it('shareProject es de un solo guardado: si el proyecto está lleno no queda la invitación, y tampoco un proyecto vacío', () => {
    const { store } = open();
    const owner = store.signIn(ana, OPEN);
    store.registerProject('p', owner.id);
    for (let i = 0; i < MAX_MEMBERS_PER_PROJECT - 1; i++) store.shareProject('p', `persona${i}`, 'viewer', 'guest');
    expect(() => store.shareProject('p', 'una-mas', 'viewer', 'guest')).toThrowError(expect.objectContaining({ code: 'limit' }));
    expect(store.findByLogin('una-mas')).toBeUndefined();
    expect(() => store.shareProject('otro', 'una-mas', 'viewer', 'guest')).not.toThrow(); // este sí cabe
    expect(() => store.shareProject('otro', 'x', 'viewer', 'dios' as never)).toThrowError(expect.objectContaining({ code: 'invalid' }));
    expect(store.findByLogin('x')).toBeUndefined();
  });

  it('quitar a un invitado que no ha entrado de su último proyecto cancela su invitación; a un miembro que sí entró, no', () => {
    const { store } = open();
    const a = store.signIn(ana, OPEN);
    store.registerProject('p', a.id);
    store.registerProject('q', a.id);
    const pending = store.shareProject('p', 'carla', 'viewer', 'guest').user;
    store.shareProject('q', 'carla', 'viewer', 'guest');
    store.removeMember('p', pending.id);
    expect(store.findByLogin('carla')).toBeDefined(); // todavía le queda q
    store.dropProject('q');
    expect(store.findByLogin('carla')).toBeUndefined(); // sin proyectos, no le queda entrada a la instancia
    // un invitado de la instancia (rol member) o quien ya entró se queda
    const member = store.shareProject('p', 'dani', 'viewer', 'member').user;
    store.removeMember('p', member.id);
    expect(store.findByLogin('dani')).toBeDefined();
    const b = store.signIn(beto, OPEN);
    store.setMember('p', b.id, 'viewer');
    store.removeMember('p', b.id);
    expect(store.findByLogin('beto')).toBeDefined();
  });

  it('upsertUser crea una invitación con rol member (o el que se pida) y cambia las cuentas que existen, en un solo guardado', () => {
    const { store } = open();
    const created = store.upsertUser('@Carla', {});
    expect(created).toMatchObject({ created: true, user: { login: 'Carla', siteRole: 'member' } });
    expect(created.user.githubId).toBeUndefined();
    expect(store.upsertUser('carla', { siteRole: 'guest' })).toMatchObject({ created: false, user: { siteRole: 'guest' } });
    expect(store.upsertUser('dani', { siteRole: 'guest', disabled: true })).toMatchObject({ created: true, user: { siteRole: 'guest', disabled: true } });
    expect(() => store.upsertUser('eva', { siteRole: 'rey' as never })).toThrowError(expect.objectContaining({ code: 'invalid' }));
    expect(store.findByLogin('eva')).toBeUndefined();
    expect(() => store.upsertUser('no es un usuario', {})).toThrowError(expect.objectContaining({ code: 'invalid' }));
  });

  it('removePending cancela una invitación y sus proyectos, y se niega con quien ya entró', () => {
    const { store } = open();
    const a = store.signIn(ana, OPEN);
    store.registerProject('p', a.id);
    const pending = store.shareProject('p', 'carla', 'viewer', 'member').user;
    store.removePending(pending.id);
    expect(store.findByLogin('carla')).toBeUndefined();
    expect(store.membersOf('p').map((m) => m.user.login)).toEqual(['ana']);
    expect(() => store.removePending(a.id)).toThrowError(expect.objectContaining({ code: 'conflict' }));
    expect(() => store.removePending('u_nadie')).toThrowError(expect.objectContaining({ code: 'not-found' }));
  });

  it('membershipCounts cuenta los proyectos de cada cuenta', () => {
    const { store } = open();
    const a = store.signIn(ana, OPEN);
    const b = store.signIn(beto, OPEN);
    store.registerProject('p', a.id);
    store.registerProject('q', a.id);
    store.setMember('q', b.id, 'viewer');
    expect([...store.membershipCounts()].sort()).toEqual([[a.id, 2], [b.id, 1]].sort());
  });
});

describe('Accounts: reglas de la instancia', () => {
  const make = (admins: string[], extra: Partial<ConstructorParameters<typeof Accounts>[0]> = {}) => new Accounts({ store: open().store, publicUrl: 'https://iark.example.org/', admins, ...extra });

  it('los administradores salen de la lista, por id numérico o por nombre, y solo cuenta quien ya entró con GitHub', () => {
    const accounts = make(['583231', '@Ana']);
    expect(accounts.adminCount).toBe(2);
    expect(accounts.isAdminProfile({ id: 583231, login: 'otro-nombre' })).toBe(true);
    expect(accounts.isAdminProfile({ id: 1, login: 'ANA' })).toBe(true);
    expect(accounts.isAdminProfile({ id: 2, login: 'beto' })).toBe(false);
    const user = accounts.store.signIn(ana, { signup: 'open', admin: true });
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

  it('sin ninguna opción de cuentas no hace nada', () => {
    expect(setupAccounts({}, { workspace: true, cors: [], env: {} })).toBeUndefined();
    expect(setupAccounts({ signup: 'open', admins: 'ana', publicUrl: 'https://x.org' }, { workspace: true, cors: [], env: {} })).toBeUndefined();
  });

  it('pide todo lo que falta de una vez y no acepta el secreto por la línea de comandos', () => {
    expect(() => setupAccounts({ githubClientId: 'abc' }, { workspace: false, cors: [], env: {} })).toThrowError(
      expect.objectContaining({ message: expect.stringMatching(/--accounts[\s\S]*IARK_GITHUB_CLIENT_SECRET[\s\S]*--public-url[\s\S]*--workspace/) }),
    );
    expect(() => setupAccounts(base(), { ...ctx, workspace: false })).toThrowError(/--workspace/);
    expect(() => setupAccounts({ ...base(), publicUrl: undefined }, ctx)).toThrowError(/--public-url/);
    expect(() => setupAccounts({ accounts: join(tmp(), 'c.json') }, { workspace: true, cors: [], env: {} })).toThrowError(/IARK_GITHUB_CLIENT_SECRET/);
  });

  it('con todo en orden devuelve las cuentas, con los orígenes de --cors como destinos de vuelta', () => {
    const accounts = setupAccounts({ ...base(), signup: 'open', sessionDays: 7, maxProjects: 3 }, { ...ctx, cors: ['https://app.example.org'] })!;
    expect(accounts.signup).toBe('open');
    expect(accounts.sessionTtlMs).toBe(7 * 24 * 3600 * 1000);
    expect(accounts.maxProjectsPerUser).toBe(3);
    expect(accounts.callbackUrl).toBe('https://iark.example.org/api/auth/github/callback');
    expect(accounts.redirectAllowed(new URL('https://app.example.org/'))).toBe(true);
  });

  it('rechaza valores que no valen, con el motivo', () => {
    for (const [change, message] of [
      [{ signup: 'cualquiera' }, /--signup/],
      [{ sessionDays: 0 }, /--session-days/],
      [{ sessionDays: 400 }, /--session-days/],
      [{ maxProjects: 0 }, /--max-projects/],
      [{ publicUrl: 'http://iark.example.org' }, /https/],
      [{ admins: 'ana, ¿quién?' }, /nombre de usuario/],
      [{ githubUrl: 'git.empresa.com' }, /--github-url/],
    ] as const) {
      expect(() => setupAccounts({ ...base(), ...change }, ctx), JSON.stringify(change)).toThrowError(message);
    }
  });

  it('con entrada por invitación y sin administradores ni cuentas, nadie podría entrar: no arranca', () => {
    expect(() => setupAccounts({ ...base(), admins: undefined }, ctx)).toThrowError(/al menos un administrador/);
    // con la entrada abierta no hace falta
    expect(setupAccounts({ ...base(), admins: undefined, signup: 'open' }, ctx)).toBeDefined();
    // ni con cuentas ya registradas
    const file = join(tmp(), 'c.json');
    AccountStore.open(file).invite('ana');
    expect(setupAccounts({ ...base(), accounts: file, admins: undefined }, ctx)).toBeDefined();
  });

  it('un archivo de cuentas dañado es un error de uso, no una excepción', () => {
    const file = join(tmp(), 'c.json');
    writeFileSync(file, 'roto');
    expect(() => setupAccounts({ ...base(), accounts: file }, ctx)).toThrowError(/no es válido/);
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
