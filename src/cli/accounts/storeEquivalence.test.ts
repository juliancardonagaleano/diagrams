import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { postgresAvailable, requirePostgresIfCi, startTestPostgres, testConfig, uniqueSchema, type TestPostgres } from '../../../tests/helpers/postgres';
import { PostgresDatabase } from '../postgres/pool';
import { asAsync, AccountError, JsonAccountStore, MAX_PENDING_USERS, MAX_SESSIONS_PER_USER, PostgresAccountStore, SqliteAccountStore, type AccountsFile, type AccountStore } from './store';

requirePostgresIfCi();

/**
 * Prueba diferencial: la misma vida de una instancia (entrar, invitar, compartir, desactivar, caducar sesiones, topes…) se ejecuta paso a
 * paso en el almacén JSON, en el SQLite y (si hay Postgres) en el de Postgres con el mismo reloj, y después de CADA paso deben coincidir lo que
 * devolvió (o el código del error) y el volcado completo de las cuentas. Es la prueba de que cambiar de almacén no cambia el comportamiento
 * observable. Los ids de cuenta y los hashes de sesión son aleatorios en cada almacén; se comparan por su lugar en la lista de cuentas y por lo
 * que dicen de la sesión.
 */

type Kind = 'json' | 'sqlite' | 'postgres';

const folders: string[] = [];
const stores: AccountStore[] = [];
const schemas: string[] = [];
let server: TestPostgres | undefined;
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close().catch(() => undefined);
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Run {
  store: AccountStore;
  tokens: Record<string, string>;
  advance(ms: number): void;
  id(login: string): Promise<string>;
  /** Cierra el almacén y lo vuelve a abrir sobre lo mismo (un reinicio del servicio); el reloj sigue. */
  reopen(): Promise<AccountStore>;
}

async function start(kind: Kind): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), 'iark-equivalencia-'));
  folders.push(dir);
  let now = Date.parse('2026-10-01T09:00:00Z');
  const options = { now: () => new Date(now) };
  const schema = uniqueSchema();
  if (kind === 'postgres') schemas.push(schema);
  const open = async (): Promise<AccountStore> => {
    if (kind === 'json') return asAsync(JsonAccountStore.open(join(dir, 'cuentas.json'), options));
    if (kind === 'sqlite') return asAsync(SqliteAccountStore.open(join(dir, 'cuentas.db'), options));
    const db = await PostgresDatabase.connect(testConfig(server!.url, schema));
    return PostgresAccountStore.open(db, { ...options, release: () => db.close() });
  };
  const run: Run = {
    store: await open(),
    tokens: {},
    advance: (ms) => void (now += ms),
    id: async (login) => {
      const found = await run.store.findByLogin(login);
      if (!found) throw new AccountError('not-found', `sin cuenta «${login}»`);
      return found.id;
    },
    reopen: async () => {
      await run.store.close();
      run.store = await open();
      stores.push(run.store);
      return run.store;
    },
  };
  stores.push(run.store);
  return run;
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
function plain(value: unknown): unknown {
  if (value instanceof Map) return [...value].sort(([a], [b]) => String(a).localeCompare(String(b)));
  if (Array.isArray(value)) return value.map((v) => plain(v));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'id' && key !== 'token' && key !== 'userId')
        .map(([key, v]) => [key, plain(v)]),
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

type Step = [label: string, step: (run: Run) => Promise<unknown>];

/** Hace `count` veces `each`, de una en una (el reloj de la prueba avanza entre una y otra, así que el orden importa). */
async function times<T>(count: number, each: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < count; i++) out.push(await each(i));
  return out;
}

const STEPS: Step[] = [
  ['entra un administrador de la lista', async (r) => r.store.signIn(ana, ADMIN)],
  ['entra por invitación sin estar invitado', async (r) => r.store.signIn(beto, INVITE)],
  ['entra con la instancia abierta', async (r) => r.store.signIn(beto, OPEN)],
  ['invita a carla como invitada', async (r) => r.store.invite('@Carla', 'guest')],
  ['invitar otra vez no cambia nada', async (r) => r.store.invite('CARLA', 'member')],
  ['invitar con un rol inventado', async (r) => r.store.invite('dani', 'rey' as never)],
  ['invitar a dani como member', async (r) => r.store.invite('dani', 'member')],
  ['ana crea un proyecto', async (r) => r.store.registerProject('tienda', await r.id('ana'))],
  ['comparte con quien ya entró', async (r) => r.store.shareProject('tienda', 'beto', 'editor', 'guest')],
  ['comparte con carla (invitación pendiente)', async (r) => r.store.shareProject('tienda', 'carla', 'viewer', 'guest')],
  ['comparte con eva (invitación nueva)', async (r) => r.store.shareProject('tienda', 'eva', 'viewer', 'guest')],
  ['comparte con un nombre inválido', async (r) => r.store.shareProject('tienda', 'no válido', 'viewer', 'guest')],
  ['comparte con un rol inventado', async (r) => r.store.shareProject('tienda', 'fede', 'dios' as never, 'guest')],
  [
    'abre tres sesiones',
    async (r) =>
      times(3, async (i) => {
        r.tokens['abc'[i]] = (await r.store.createSession(await r.id('ana'), 3600_000)).token;
        r.advance(1000);
      }),
  ],
  ['las tres valen', async (r) => Promise.all(['a', 'b', 'c'].map(async (k) => (await r.store.lookupSession(r.tokens[k]))?.login))],
  ['cuenta sesiones', async (r) => r.store.sessionCount(await r.id('ana'))],
  ['cierra una sesión', async (r) => r.store.revokeSession(r.tokens.a)],
  ['cerrarla otra vez', async (r) => r.store.revokeSession(r.tokens.a)],
  ['una sesión inventada', async (r) => r.store.lookupSession('iark_s_inventado')],
  ['sesión de una cuenta que no existe', async (r) => r.store.createSession('u_nadie', 1000)],
  ['bajar de rol a la única administradora', async (r) => r.store.setMember('tienda', await r.id('ana'), 'editor')],
  ['quitar a la única administradora', async (r) => r.store.removeMember('tienda', await r.id('ana'))],
  ['compartir bajándola de rol', async (r) => r.store.shareProject('tienda', 'ana', 'viewer', 'guest')],
  ['beto pasa a administrador', async (r) => r.store.setMember('tienda', await r.id('beto'), 'admin')],
  ['ahora ana puede irse', async (r) => r.store.removeMember('tienda', await r.id('ana'))],
  ['irse otra vez', async (r) => r.store.removeMember('tienda', await r.id('ana'))],
  ['quitar a eva cancela su invitación', async (r) => r.store.removeMember('tienda', await r.id('eva'))],
  ['miembros del proyecto', async (r) => r.store.membersOf('tienda')],
  ['roles de carla y de beto', async (r) => [await r.store.rolesOf(await r.id('carla')), await r.store.rolesOf(await r.id('beto')), await r.store.adminCount(await r.id('beto'))]],
  ['carla reclama su invitación', async (r) => r.store.signIn(carla, INVITE)],
  ['beto se desactiva', async (r) => r.store.updateUser(await r.id('beto'), { disabled: true })],
  ['beto ya no entra', async (r) => r.store.signIn(beto, OPEN)],
  ['beto vuelve', async (r) => r.store.updateUser(await r.id('beto'), { disabled: false })],
  ['rol inventado en un cambio', async (r) => r.store.updateUser(await r.id('beto'), { siteRole: 'rey' as never, disabled: true })],
  ['cambio de una cuenta que no existe', async (r) => r.store.updateUser('u_nadie', { disabled: true })],
  ['upsert crea una invitación', async (r) => r.store.upsertUser('@Fede', { siteRole: 'guest' })],
  ['upsert la desactiva', async (r) => r.store.upsertUser('fede', { disabled: true })],
  ['upsert con un nombre inválido', async (r) => r.store.upsertUser('no válido', {})],
  ['cancelar la invitación de dani', async (r) => r.store.removePending(await r.id('dani'))],
  ['cancelar la de quien ya entró', async (r) => r.store.removePending(await r.id('ana'))],
  ['cancelar una cuenta que no existe', async (r) => r.store.removePending('u_nadie')],
  ['alguien toma el nombre de ana', async (r) => r.store.signIn({ id: 999, login: 'ANA' }, OPEN)],
  ['ana cambia de nombre y recupera «ana-vieja»', async (r) => r.store.signIn({ ...ana, login: 'ana-vieja', name: undefined }, OPEN)],
  ['beto invita a quien ya figura como miembro de otro proyecto', async (r) => r.store.shareProject('banca', 'fede', 'editor', 'member')],
  ['fede entra con su invitación (estaba desactivada)', async (r) => r.store.signIn({ id: 404, login: 'Fede' }, OPEN)],
  [
    'fede reactivada entra y hereda lo invitado',
    async (r) => {
      await r.store.updateUser(await r.id('fede'), { disabled: false });
      return r.store.signIn({ id: 404, login: 'Fede' }, OPEN);
    },
  ],
  [
    'una persona conocida entra con el nombre al que habían invitado',
    async (r) => {
      await r.store.invite('carla-nueva', 'guest');
      await r.store.setMember('banca', await r.id('carla-nueva'), 'admin');
      return r.store.signIn({ id: 303, login: 'carla-nueva' }, OPEN);
    },
  ],
  ['registrar un proyecto reemplaza a los miembros', async (r) => r.store.registerProject('tienda', await r.id('carla-nueva'))],
  ['registrar para una cuenta inexistente', async (r) => r.store.registerProject('otro', 'u_nadie')],
  ['olvidar el proyecto', async (r) => r.store.dropProject('tienda')],
  ['olvidar uno que no existe', async (r) => r.store.dropProject('no-existe')],
  ['cuántos proyectos tiene cada cuenta', async (r) => (await r.store.membershipCounts()).size],
  ['pasa una hora: las sesiones que quedan caducan', async (r) => r.advance(2 * 3600_000)],
  ['las sesiones caducadas no valen', async (r) => [await r.store.lookupSession(r.tokens.b), await r.store.sessionCount(await r.id('ana-vieja'))]],
  ['abrir una sesión poda las caducadas', async (r) => (await r.store.createSession(await r.id('ana-vieja'), 3600_000)).expiresAt],
  [
    'demasiadas sesiones cierran las más antiguas',
    async (r) =>
      (
        await times(MAX_SESSIONS_PER_USER + 6, async () => {
          r.advance(1000);
          return (await r.store.createSession(await r.id('ana-vieja'), 3600_000)).expiresAt;
        })
      ).length,
  ],
  ['solo quedan las últimas', async (r) => r.store.sessionCount(await r.id('ana-vieja'))],
  [
    'llenar las invitaciones hasta el tope',
    async (r) =>
      (
        await times(MAX_PENDING_USERS + 5, async (i) => {
          try {
            await r.store.invite(`relleno${i}`);
            return 'ok';
          } catch (e) {
            return (e as AccountError).code;
          }
        })
      ).filter((x) => x !== 'ok').length,
  ],
  ['la cuenta que ya existía se sigue encontrando', async (r) => (await r.store.findByLogin('ana-vieja'))?.siteRole],
];

/** Lo que devuelve un paso, o el código del error de cuentas que lanzó (cualquier otro error sí se propaga). */
async function outcome(step: Step[1], run: Run): Promise<unknown> {
  try {
    return { value: plain(await step(run)) };
  } catch (error) {
    if (error instanceof AccountError) return { error: error.code };
    throw error;
  }
}

describe('JSON, SQLite y Postgres se comportan igual', () => {
  const others: Kind[] = postgresAvailable() ? ['sqlite', 'postgres'] : ['sqlite'];
  beforeAll(async () => {
    if (postgresAvailable()) server = await startTestPostgres();
  }, 120_000);
  afterAll(async () => {
    if (server) {
      const admin = await PostgresDatabase.connect(testConfig(server.url));
      try {
        for (const schema of schemas) await admin.query(`drop schema if exists "${schema}" cascade`);
      } finally {
        await admin.close();
      }
    }
    await server?.stop();
  });

  it('la misma vida de una instancia, paso a paso: mismos resultados, mismos errores y el mismo volcado después de cada paso', async () => {
    const reference = await start('json');
    const runs = await Promise.all(others.map((kind) => start(kind)));
    for (const [label, step] of STEPS) {
      const expected = await outcome(step, reference);
      for (const [i, run] of runs.entries()) {
        expect(await outcome(step, run), `resultado de «${label}» en ${others[i]}`).toEqual(expected);
        expect(view(await run.store.snapshot()), `estado después de «${label}» en ${others[i]}`).toEqual(view(await reference.store.snapshot()));
        expect(await run.store.stats(), `recuentos después de «${label}» en ${others[i]}`).toEqual(await reference.store.stats());
      }
    }
    // y la prueba no es vacía: pasaron cosas de verdad
    const dump = await reference.store.snapshot();
    expect(dump.users.length).toBeGreaterThan(MAX_PENDING_USERS);
    expect(dump.sessions.length).toBeGreaterThan(0);
    expect(STEPS.length).toBeGreaterThan(50);
  }, 300_000);

  it('y sigue igual después de reiniciar todos', async () => {
    const reference = await start('json');
    const runs = [reference, ...(await Promise.all(others.map((kind) => start(kind))))];
    for (const [, step] of STEPS.slice(0, 30)) {
      for (const run of runs) await step(run).catch(() => undefined); // los errores esperados ya los compara la prueba anterior
    }
    const expected = view(await reference.store.snapshot());
    for (const run of runs) expect(view(await run.store.snapshot())).toEqual(expected);
    for (const run of runs) expect(view(await (await run.reopen()).snapshot())).toEqual(expected);
  }, 300_000);
});
