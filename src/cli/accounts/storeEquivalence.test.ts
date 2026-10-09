import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountError, JsonAccountStore, MAX_PENDING_USERS, MAX_SESSIONS_PER_USER, SqliteAccountStore, type AccountsFile, type AccountStore } from './store';

/**
 * Prueba diferencial: la misma vida de una instancia (entrar, invitar, compartir, desactivar, caducar sesiones, topes…) se ejecuta paso a
 * paso en el almacén JSON y en el SQLite con el mismo reloj, y después de CADA paso deben coincidir lo que devolvió (o el código del error) y
 * el volcado completo de las cuentas. Es la prueba de que cambiar de almacén no cambia el comportamiento observable. Los ids de cuenta y los
 * hashes de sesión son aleatorios en cada almacén; se comparan por su lugar en la lista de cuentas y por lo que dicen de la sesión.
 */

const folders: string[] = [];
const stores: AccountStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Run {
  store: AccountStore;
  tokens: Record<string, string>;
  advance(ms: number): void;
  id(login: string): string;
}

function start(kind: 'json' | 'sqlite'): Run {
  const dir = mkdtempSync(join(tmpdir(), 'iark-equivalencia-'));
  folders.push(dir);
  let now = Date.parse('2026-10-01T09:00:00Z');
  const options = { now: () => new Date(now) };
  const store = kind === 'json' ? JsonAccountStore.open(join(dir, 'cuentas.json'), options) : SqliteAccountStore.open(join(dir, 'cuentas.db'), options);
  stores.push(store);
  return {
    store,
    tokens: {},
    advance: (ms) => void (now += ms),
    id: (login) => {
      const found = store.findByLogin(login);
      if (!found) throw new AccountError('not-found', `sin cuenta «${login}»`);
      return found.id;
    },
  };
}

/** El volcado sin lo aleatorio: cada id de cuenta es su posición, y cada sesión, a quién es y cuándo caduca. */
function view(dump: AccountsFile): unknown {
  const index = new Map(dump.users.map((u, i) => [u.id, `U${i}`]));
  const at = (id: string): string => index.get(id) ?? `?${id}`;
  return {
    users: dump.users.map(({ id, ...rest }) => ({ at: at(id), ...rest })),
    sessions: dump.sessions.map((s) => ({ user: at(s.userId), createdAt: s.createdAt, expiresAt: s.expiresAt })),
    projects: Object.fromEntries(Object.entries(dump.projects).map(([project, members]) => [project, members.map((m) => ({ user: at(m.userId), role: m.role, addedAt: m.addedAt }))])),
  };
}

/** Lo que devuelve una operación, sin ids ni tokens (cambian en cada almacén) y con los `Map` como listas ordenadas. */
function plain(value: unknown, run: Run): unknown {
  if (value instanceof Map) return [...value].sort(([a], [b]) => String(a).localeCompare(String(b)));
  if (Array.isArray(value)) return value.map((v) => plain(v, run));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'id' && key !== 'token' && key !== 'userId')
        .map(([key, v]) => [key, plain(v, run)]),
    );
  }
  return value;
}

const ana = { id: 101, login: 'ana', name: 'Ana Pérez', avatarUrl: 'https://avatars.example.test/101' };
const beto = { id: 202, login: 'Beto' };
const carla = { id: 303, login: 'carla' };
const OPEN = { signup: 'open', admin: false } as const;
const INVITE = { signup: 'invite', admin: false } as const;
const ADMIN = { signup: 'invite', admin: true } as const;

type Step = [label: string, step: (run: Run) => unknown];

const STEPS: Step[] = [
  ['entra un administrador de la lista', (r) => r.store.signIn(ana, ADMIN)],
  ['entra por invitación sin estar invitado', (r) => r.store.signIn(beto, INVITE)],
  ['entra con la instancia abierta', (r) => r.store.signIn(beto, OPEN)],
  ['invita a carla como invitada', (r) => r.store.invite('@Carla', 'guest')],
  ['invitar otra vez no cambia nada', (r) => r.store.invite('CARLA', 'member')],
  ['invitar con un rol inventado', (r) => r.store.invite('dani', 'rey' as never)],
  ['invitar a dani como member', (r) => r.store.invite('dani', 'member')],
  ['ana crea un proyecto', (r) => r.store.registerProject('tienda', r.id('ana'))],
  ['comparte con quien ya entró', (r) => r.store.shareProject('tienda', 'beto', 'editor', 'guest')],
  ['comparte con carla (invitación pendiente)', (r) => r.store.shareProject('tienda', 'carla', 'viewer', 'guest')],
  ['comparte con eva (invitación nueva)', (r) => r.store.shareProject('tienda', 'eva', 'viewer', 'guest')],
  ['comparte con un nombre inválido', (r) => r.store.shareProject('tienda', 'no válido', 'viewer', 'guest')],
  ['comparte con un rol inventado', (r) => r.store.shareProject('tienda', 'fede', 'dios' as never, 'guest')],
  ['abre tres sesiones', (r) => (['a', 'b', 'c'] as const).map((k) => ((r.tokens[k] = r.store.createSession(r.id('ana'), 3600_000).token), r.advance(1000)))],
  ['las tres valen', (r) => ['a', 'b', 'c'].map((k) => r.store.lookupSession(r.tokens[k])?.login)],
  ['cuenta sesiones', (r) => r.store.sessionCount(r.id('ana'))],
  ['cierra una sesión', (r) => r.store.revokeSession(r.tokens.a)],
  ['cerrarla otra vez', (r) => r.store.revokeSession(r.tokens.a)],
  ['una sesión inventada', (r) => r.store.lookupSession('iark_s_inventado')],
  ['sesión de una cuenta que no existe', (r) => r.store.createSession('u_nadie', 1000)],
  ['bajar de rol a la única administradora', (r) => r.store.setMember('tienda', r.id('ana'), 'editor')],
  ['quitar a la única administradora', (r) => r.store.removeMember('tienda', r.id('ana'))],
  ['compartir bajándola de rol', (r) => r.store.shareProject('tienda', 'ana', 'viewer', 'guest')],
  ['beto pasa a administrador', (r) => r.store.setMember('tienda', r.id('beto'), 'admin')],
  ['ahora ana puede irse', (r) => r.store.removeMember('tienda', r.id('ana'))],
  ['irse otra vez', (r) => r.store.removeMember('tienda', r.id('ana'))],
  ['quitar a eva cancela su invitación', (r) => r.store.removeMember('tienda', r.id('eva'))],
  ['miembros del proyecto', (r) => r.store.membersOf('tienda')],
  ['roles de carla y de beto', (r) => [r.store.rolesOf(r.id('carla')), r.store.rolesOf(r.id('beto')), r.store.adminCount(r.id('beto'))]],
  ['carla reclama su invitación', (r) => r.store.signIn(carla, INVITE)],
  ['beto se desactiva', (r) => r.store.updateUser(r.id('beto'), { disabled: true })],
  ['beto ya no entra', (r) => r.store.signIn(beto, OPEN)],
  ['beto vuelve', (r) => r.store.updateUser(r.id('beto'), { disabled: false })],
  ['rol inventado en un cambio', (r) => r.store.updateUser(r.id('beto'), { siteRole: 'rey' as never, disabled: true })],
  ['cambio de una cuenta que no existe', (r) => r.store.updateUser('u_nadie', { disabled: true })],
  ['upsert crea una invitación', (r) => r.store.upsertUser('@Fede', { siteRole: 'guest' })],
  ['upsert la desactiva', (r) => r.store.upsertUser('fede', { disabled: true })],
  ['upsert con un nombre inválido', (r) => r.store.upsertUser('no válido', {})],
  ['cancelar la invitación de dani', (r) => r.store.removePending(r.id('dani'))],
  ['cancelar la de quien ya entró', (r) => r.store.removePending(r.id('ana'))],
  ['cancelar una cuenta que no existe', (r) => r.store.removePending('u_nadie')],
  ['alguien toma el nombre de ana', (r) => r.store.signIn({ id: 999, login: 'ANA' }, OPEN)],
  ['ana cambia de nombre y recupera «ana-vieja»', (r) => r.store.signIn({ ...ana, login: 'ana-vieja', name: undefined }, OPEN)],
  ['beto invita a quien ya figura como miembro de otro proyecto', (r) => r.store.shareProject('banca', 'fede', 'editor', 'member')],
  ['fede entra con su invitación (estaba desactivada)', (r) => r.store.signIn({ id: 404, login: 'Fede' }, OPEN)],
  ['fede reactivada entra y hereda lo invitado', (r) => (r.store.updateUser(r.id('fede'), { disabled: false }), r.store.signIn({ id: 404, login: 'Fede' }, OPEN))],
  ['una persona conocida entra con el nombre al que habían invitado', (r) => (r.store.invite('carla-nueva', 'guest'), r.store.setMember('banca', r.id('carla-nueva'), 'admin'), r.store.signIn({ id: 303, login: 'carla-nueva' }, OPEN))],
  ['registrar un proyecto reemplaza a los miembros', (r) => r.store.registerProject('tienda', r.id('carla-nueva'))],
  ['registrar para una cuenta inexistente', (r) => r.store.registerProject('otro', 'u_nadie')],
  ['olvidar el proyecto', (r) => r.store.dropProject('tienda')],
  ['olvidar uno que no existe', (r) => r.store.dropProject('no-existe')],
  ['cuántos proyectos tiene cada cuenta', (r) => r.store.membershipCounts().size],
  ['pasa una hora: las sesiones que quedan caducan', (r) => r.advance(2 * 3600_000)],
  ['las sesiones caducadas no valen', (r) => [r.store.lookupSession(r.tokens.b), r.store.sessionCount(r.id('ana-vieja'))]],
  ['abrir una sesión poda las caducadas', (r) => r.store.createSession(r.id('ana-vieja'), 3600_000).expiresAt],
  ['demasiadas sesiones cierran las más antiguas', (r) => Array.from({ length: MAX_SESSIONS_PER_USER + 6 }, () => (r.advance(1000), r.store.createSession(r.id('ana-vieja'), 3600_000).expiresAt)).length],
  ['solo quedan las últimas', (r) => r.store.sessionCount(r.id('ana-vieja'))],
  ['llenar las invitaciones hasta el tope', (r) => Array.from({ length: MAX_PENDING_USERS + 5 }, (_, i) => { try { r.store.invite(`relleno${i}`); return 'ok'; } catch (e) { return (e as AccountError).code; } }).filter((x) => x !== 'ok').length],
  ['la cuenta que ya existía se sigue encontrando', (r) => r.store.findByLogin('ana-vieja')?.siteRole],
];

describe('JSON y SQLite se comportan igual', () => {
  it('la misma vida de una instancia, paso a paso: mismos resultados, mismos errores y el mismo volcado después de cada paso', () => {
    const json = start('json');
    const sqlite = start('sqlite');
    for (const [label, step] of STEPS) {
      const outcome = (run: Run): unknown => {
        try {
          return { value: plain(step(run), run) };
        } catch (error) {
          if (error instanceof AccountError) return { error: error.code };
          throw error;
        }
      };
      const a = outcome(json);
      const b = outcome(sqlite);
      expect(b, `resultado de «${label}»`).toEqual(a);
      expect(view(sqlite.store.snapshot()), `estado después de «${label}»`).toEqual(view(json.store.snapshot()));
    }
    // y la prueba no es vacía: pasaron cosas de verdad
    const dump = json.store.snapshot();
    expect(dump.users.length).toBeGreaterThan(MAX_PENDING_USERS);
    expect(dump.sessions.length).toBeGreaterThan(0);
    expect(STEPS.length).toBeGreaterThan(50);
  });

  it('y sigue igual después de reiniciar los dos', () => {
    const json = start('json');
    const sqlite = start('sqlite');
    for (const [, step] of STEPS.slice(0, 30)) {
      for (const run of [json, sqlite]) {
        try {
          step(run);
        } catch {
          // los errores esperados ya los compara la prueba anterior
        }
      }
    }
    const expected = view(json.store.snapshot());
    expect(view(sqlite.store.snapshot())).toEqual(expected);
    const reopen = (kind: 'json' | 'sqlite', run: Run): AccountStore => {
      const path = (run.store as JsonAccountStore | SqliteAccountStore).path;
      run.store.close();
      const store = kind === 'json' ? JsonAccountStore.open(path) : SqliteAccountStore.open(path);
      stores.push(store);
      return store;
    };
    expect(view(reopen('json', json).snapshot())).toEqual(expected);
    expect(view(reopen('sqlite', sqlite).snapshot())).toEqual(expected);
  });
});
