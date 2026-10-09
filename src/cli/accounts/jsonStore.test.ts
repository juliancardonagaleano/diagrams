import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { accountStoreContract, ana, beto, OPEN } from '../../../tests/helpers/accountStoreContract';
import { hashSessionToken, JsonAccountStore, MAX_SESSIONS_PER_USER, parseAccountsFile, SESSION_PREFIX } from './store';

accountStoreContract('json', { fileName: 'cuentas.json', open: (path, options) => JsonAccountStore.open(path, options) });

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
  return { file, store: JsonAccountStore.open(file, options as never) };
};

describe('JsonAccountStore: el archivo', () => {
  it('se crea vacío con modo 0600 si no existe y vuelve a leerse igual', () => {
    const { file, store } = open();
    expect(store.kind).toBe('json');
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const user = store.signIn(ana, OPEN);
    store.registerProject('tienda', user.id);
    const session = store.createSession(user.id, 60_000);
    const again = JsonAccountStore.open(file);
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
      expect(() => JsonAccountStore.open(file)).toThrowError(expect.objectContaining({ code: 'corrupt' }));
      expect(readFileSync(file, 'utf8')).toBe(text);
    }
    const secret = 'hash-secreto-que-no-debe-salir';
    expect(() => parseAccountsFile(JSON.stringify({ version: 1, users: [], sessions: [{ hash: secret, userId: 'x', createdAt: 'a', expiresAt: 'b' }], projects: {} }))).toThrowError(
      expect.objectContaining({ code: 'corrupt', message: expect.not.stringContaining(secret) }),
    );
  });

  it('la cuota personal se lee y se guarda en el archivo; un archivo sin ella (de antes de las cuotas) se lee igual y una cuota inválida lo daña', () => {
    const { file, store } = open();
    const user = store.signIn(ana, OPEN);
    store.updateUser(user.id, { quota: { bytes: 1_000_000, projects: 0 } });
    expect(JSON.parse(readFileSync(file, 'utf8')).users[0].quota).toEqual({ bytes: 1_000_000, projects: 0 });
    expect(JsonAccountStore.open(file).findUser(user.id)?.quota).toEqual({ bytes: 1_000_000, projects: 0 });
    store.updateUser(user.id, { quota: { bytes: null, projects: null } });
    expect(JSON.parse(readFileSync(file, 'utf8')).users[0]).not.toHaveProperty('quota'); // sin cuota fijada no queda ni el campo
    expect(JsonAccountStore.open(file).findUser(user.id)?.quota).toBeUndefined();

    const entry = { id: 'u_1', login: 'ana', siteRole: 'member', createdAt: '2026-01-01T00:00:00Z' };
    const withQuota = (quota: unknown): string => JSON.stringify({ version: 1, users: [{ ...entry, quota }], sessions: [], projects: {} });
    expect(parseAccountsFile(withQuota({ diagramsPerProject: 12 })).users[0].quota).toEqual({ diagramsPerProject: 12 });
    for (const bad of [[], 'mucho', { bytes: -1 }, { bytes: 1.5 }, { bytes: '10' }, { bytes: null }, { discos: 3 }]) {
      expect(() => parseAccountsFile(withQuota(bad)), JSON.stringify(bad)).toThrowError(expect.objectContaining({ code: 'corrupt', message: expect.stringMatching(/quota/) }));
    }
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
    expect(() => JsonAccountStore.open(join(dir, 'cuentas.json'))).toThrowError(/no es un archivo.*Docker/s);
  });

  it('si el archivo es una base SQLite, lo dice y sugiere --accounts-store sqlite (no lo reemplaza)', () => {
    const file = join(tmp(), 'cuentas.db');
    const head = Buffer.concat([Buffer.from('SQLite format 3\u0000', 'latin1'), Buffer.alloc(100)]);
    writeFileSync(file, head);
    expect(() => JsonAccountStore.open(file)).toThrowError(expect.objectContaining({ code: 'corrupt', message: expect.stringMatching(/base SQLite.*--accounts-store sqlite/) }));
    expect(readFileSync(file).equals(head)).toBe(true);
  });

  it('una sesión no vale si su cuenta está desactivada, aunque la sesión siga en el archivo', () => {
    const file = join(tmp(), 'cuentas.json');
    const token = `${SESSION_PREFIX}${'a'.repeat(43)}`;
    const user = { id: 'u1', login: 'ana', githubId: 1, siteRole: 'member', disabled: true, createdAt: '2026-01-01T00:00:00Z' };
    const session = { hash: hashSessionToken(token), userId: 'u1', createdAt: '2026-01-01T00:00:00Z', expiresAt: '2999-01-01T00:00:00Z' };
    writeFileSync(file, JSON.stringify({ version: 1, users: [user], sessions: [session], projects: {} }));
    const store = JsonAccountStore.open(file);
    expect(store.sessionCount('u1')).toBe(1);
    expect(store.lookupSession(token)).toBeUndefined();
  });

  it('el archivo guarda las sesiones que quedan, no las podadas', () => {
    const { file, store } = open();
    const user = store.signIn(ana, OPEN);
    for (let i = 0; i < MAX_SESSIONS_PER_USER + 5; i++) store.createSession(user.id, 3600_000);
    expect(JSON.parse(readFileSync(file, 'utf8')).sessions).toHaveLength(MAX_SESSIONS_PER_USER);
  });

  it('olvidar un proyecto lo quita del archivo', () => {
    const { file, store } = open();
    const user = store.signIn(ana, OPEN);
    store.registerProject('p', user.id);
    store.dropProject('p');
    expect(JSON.parse(readFileSync(file, 'utf8')).projects).toEqual({});
  });
});
