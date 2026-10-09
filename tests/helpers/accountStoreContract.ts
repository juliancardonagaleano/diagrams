import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AccountError,
  MAX_MEMBERS_PER_PROJECT,
  MAX_PENDING_USERS,
  MAX_SESSIONS_PER_USER,
  parseLogin,
  SESSION_PREFIX,
  type AccountStore,
  type AccountStoreKind,
  type AccountStoreOptions,
} from '../../src/cli/accounts/store';

/**
 * El contrato de `AccountStore`: lo que cualquier almacén de cuentas (JSON, SQLite…) debe cumplir igual, con el mismo comportamiento
 * observable. Cada almacén lo ejecuta con una fábrica que abre uno sobre una ruta; `reopen` vuelve a abrir la misma ruta (un reinicio).
 * Lo que es propio de un almacén —el formato del archivo, los bloqueos, el esquema— se prueba en su archivo, no aquí.
 */
export interface AccountStoreHarness {
  /** Abre el almacén en esta ruta (la crea vacía si no existe). */
  open(path: string, options?: AccountStoreOptions): AccountStore;
  /** El nombre de archivo que le va (`cuentas.json`, `cuentas.db`). */
  fileName: string;
}

export const ana = { id: 101, login: 'ana', name: 'Ana Pérez', avatarUrl: 'https://avatars.example.test/101' };
export const beto = { id: 202, login: 'Beto' };
const carla = { id: 303, login: 'carla' };
export const OPEN = { signup: 'open', admin: false } as const;
export const INVITE = { signup: 'invite', admin: false } as const;

const code = (value: string) => expect.objectContaining({ code: value });

export function accountStoreContract(kind: AccountStoreKind, harness: AccountStoreHarness): void {
  describe(`contrato de AccountStore: ${kind}`, () => {
    const folders: string[] = [];
    const opened: AccountStore[] = [];
    afterEach(() => {
      for (const store of opened.splice(0)) {
        try {
          store.close();
        } catch {
          // ya estaba cerrado
        }
      }
      for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    /** Un almacén vacío en una carpeta temporal; `reopen()` lo cierra y lo vuelve a abrir (un reinicio del servicio). */
    const make = (options: AccountStoreOptions = {}) => {
      const dir = mkdtempSync(join(tmpdir(), 'iark-contrato-'));
      folders.push(dir);
      const path = join(dir, harness.fileName);
      let store = harness.open(path, options);
      opened.push(store);
      return {
        path,
        get store(): AccountStore {
          return store;
        },
        reopen(reopenOptions: AccountStoreOptions = options): AccountStore {
          store.close();
          store = harness.open(path, reopenOptions);
          opened.push(store);
          return store;
        },
      };
    };
    const open = (options: AccountStoreOptions = {}): AccountStore => make(options).store;

    describe('quién entra', () => {
      it('con invitación solo entran las cuentas invitadas y los administradores; abierta, cualquiera como member', () => {
        const store = open();
        expect(() => store.signIn(ana, INVITE)).toThrowError(code('not-invited'));
        expect(store.userCount).toBe(0);
        // un administrador de la lista entra aunque sea por invitación, y su cuenta guarda `member`: el rol de administrador lo da la lista, no el almacén
        expect(store.signIn(ana, { signup: 'invite', admin: true }).siteRole).toBe('member');
        expect(store.signIn(beto, OPEN).siteRole).toBe('member');
      });

      it('una invitación por nombre de usuario la reclama quien entra con ese nombre, sin distinguir mayúsculas', () => {
        const store = open();
        const invited = store.invite('@BETO', 'guest');
        expect(invited).toMatchObject({ login: 'BETO', siteRole: 'guest' });
        expect(invited.githubId).toBeUndefined();
        const signedIn = store.signIn(beto, INVITE);
        expect(signedIn).toMatchObject({ id: invited.id, githubId: 202, login: 'Beto', siteRole: 'guest' });
        expect(store.userCount).toBe(1);
      });

      it('invitar a un nombre que ya tiene cuenta devuelve esa cuenta sin cambiarla', () => {
        const store = open();
        const first = store.invite('carla', 'guest');
        expect(store.invite('CARLA', 'member')).toEqual(first);
        expect(store.findByLogin('carla')?.siteRole).toBe('guest');
        expect(() => store.invite('dani', 'rey' as never)).toThrowError(code('invalid'));
        expect(store.findByLogin('dani')).toBeUndefined();
      });

      it('se reconoce a la persona por su id de GitHub: si cambia de nombre de usuario se actualiza su cuenta, no se crea otra', () => {
        const store = open();
        const first = store.signIn(ana, OPEN);
        const again = store.signIn({ ...ana, login: 'ana-nueva', name: undefined }, OPEN);
        expect(again.id).toBe(first.id);
        expect(again).toMatchObject({ login: 'ana-nueva' });
        expect(again.name).toBeUndefined();
        expect(store.userCount).toBe(1);
      });

      it('si alguien toma el nombre de usuario que dejó otra persona, la cuenta antigua conserva su id pero pierde el nombre', () => {
        const store = open();
        const old = store.signIn(ana, OPEN);
        const newcomer = store.signIn({ id: 303, login: 'ANA' }, OPEN);
        expect(newcomer.id).not.toBe(old.id);
        expect(store.findByLogin('ana')?.id).toBe(newcomer.id);
        expect(store.findUser(old.id)?.login).toBe('ana~101');
        expect(() => parseLogin('ana~101')).toThrowError(AccountError); // ese nombre no se puede invitar ni reclamar
      });

      it('una persona conocida que entra con el nombre al que habían invitado hereda lo invitado y la invitación desaparece', () => {
        const store = open();
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
        const store = open();
        const user = store.signIn(ana, OPEN);
        const { token } = store.createSession(user.id, 60_000);
        store.updateUser(user.id, { disabled: true });
        expect(store.lookupSession(token)).toBeUndefined();
        expect(store.sessionCount(user.id)).toBe(0);
        expect(() => store.signIn(ana, OPEN)).toThrowError(code('disabled'));
        store.updateUser(user.id, { disabled: false });
        expect(store.signIn(ana, OPEN).id).toBe(user.id);
      });

      it('si entrar falla, no queda nada a medias: ni la invitación fusionada ni el nombre cambiado', () => {
        const store = open();
        const known = store.signIn({ id: 5, login: 'viejo' }, OPEN);
        store.updateUser(known.id, { disabled: true });
        const pending = store.invite('nuevo', 'guest');
        store.setMember('p1', pending.id, 'editor');
        expect(() => store.signIn({ id: 5, login: 'nuevo' }, OPEN)).toThrowError(code('disabled'));
        expect(store.users().map((u) => u.login)).toEqual(['viejo', 'nuevo']);
        expect(store.roleOf(pending.id, 'p1')).toBe('editor');
        expect(store.roleOf(known.id, 'p1')).toBeUndefined();
        expect(store.findUser(known.id)?.lastLoginAt).toEqual(known.lastLoginAt);
      });

      it('solo se acumulan invitaciones hasta un tope', () => {
        const store = open();
        expect(() => {
          for (let i = 0; i < MAX_PENDING_USERS * 2; i++) store.invite(`persona${i}`);
        }).toThrowError(code('limit'));
        expect(store.userCount).toBe(MAX_PENDING_USERS);
      });

      it('parseLogin acepta nombres de GitHub y rechaza lo demás', () => {
        expect(parseLogin('  @ana-maria ')).toBe('ana-maria');
        expect(parseLogin('ana_acme')).toBe('ana_acme');
        for (const bad of ['', '-ana', 'ana-', 'a--b', 'ana maria', 'a'.repeat(40), 'ana/../x', 'ana[bot]', 3]) expect(() => parseLogin(bad)).toThrowError(code('invalid'));
      });

      it('una cuenta se busca por id y por nombre (sin distinguir mayúsculas) y se devuelve una copia', () => {
        const store = open();
        const user = store.signIn(ana, OPEN);
        expect(store.findUser(user.id)).toEqual(user);
        expect(store.findByLogin('ANA')).toEqual(user);
        expect(store.findUser('u_nadie')).toBeUndefined();
        expect(store.findByLogin('nadie')).toBeUndefined();
        const copy = store.findUser(user.id)!;
        copy.siteRole = 'admin';
        expect(store.findUser(user.id)?.siteRole).toBe('member');
        expect(user).toMatchObject({ githubId: 101, name: 'Ana Pérez', avatarUrl: 'https://avatars.example.test/101', siteRole: 'member' });
        expect(user.disabled).toBeUndefined();
      });
    });

    describe('sesiones', () => {
      it('una sesión vale hasta que caduca o se cierra', () => {
        let now = Date.parse('2026-10-01T00:00:00Z');
        const store = open({ now: () => new Date(now) });
        const user = store.signIn(ana, OPEN);
        const { token, expiresAt } = store.createSession(user.id, 3600_000);
        expect(token.startsWith(SESSION_PREFIX)).toBe(true);
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
        const store = open({ now: () => new Date(now) });
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
        expect(store.snapshot().sessions).toHaveLength(MAX_SESSIONS_PER_USER);
        expect(store.lookupSession(tokens[0])).toBeUndefined(); // las más antiguas se cerraron
        expect(store.lookupSession(tokens[tokens.length - 1])).toBeDefined();
      });

      it('las sesiones de una cuenta no se cuentan ni se podan por las de otra', () => {
        const store = open();
        const a = store.signIn(ana, OPEN);
        const b = store.signIn(beto, OPEN);
        const own = store.createSession(a.id, 60_000);
        for (let i = 0; i < MAX_SESSIONS_PER_USER + 3; i++) store.createSession(b.id, 60_000);
        expect(store.sessionCount(a.id)).toBe(1);
        expect(store.sessionCount(b.id)).toBe(MAX_SESSIONS_PER_USER);
        expect(store.lookupSession(own.token)?.id).toBe(a.id);
        expect(() => store.createSession('u_nadie', 60_000)).toThrowError(code('not-found'));
      });

      it('del token de una sesión solo queda su hash', () => {
        const store = open();
        const { token } = store.createSession(store.signIn(ana, OPEN).id, 60_000);
        const dump = store.snapshot();
        expect(JSON.stringify(dump)).not.toContain(token);
        expect(dump.sessions[0].hash).toMatch(/^[0-9a-f]{64}$/);
      });
    });

    describe('pertenencia a proyectos', () => {
      it('quien crea un proyecto es su administrador; registrar el mismo id otra vez reemplaza a los miembros anteriores', () => {
        const store = open();
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
        expect(() => store.registerProject('otro', 'u_nadie')).toThrowError(code('not-found'));
        expect(store.membersOf('otro')).toEqual([]);
      });

      it('añadir, cambiar de rol, quitar y olvidar un proyecto', () => {
        const store = open();
        const a = store.signIn(ana, OPEN);
        const b = store.signIn(beto, OPEN);
        store.registerProject('p', a.id);
        store.setMember('p', b.id, 'viewer');
        store.setMember('p', b.id, 'editor');
        expect(store.roleOf(b.id, 'p')).toBe('editor');
        expect(store.removeMember('p', b.id)).toBe(true);
        expect(store.removeMember('p', b.id)).toBe(false);
        expect(() => store.setMember('p', 'u_nadie', 'viewer')).toThrowError(code('not-found'));
        expect(() => store.setMember('p', b.id, 'dios' as never)).toThrowError(code('invalid'));
        store.dropProject('p');
        expect(store.membersOf('p')).toEqual([]);
        expect(store.snapshot().projects).toEqual({});
        store.dropProject('no-existe'); // no falla
      });

      it('los miembros salen con los administradores primero y luego por nombre sin distinguir mayúsculas', () => {
        const store = open();
        const owner = store.signIn({ id: 1, login: 'zoe' }, OPEN);
        store.registerProject('p', owner.id);
        for (const [login, role] of [['Ana', 'viewer'], ['beto', 'editor'], ['Carla', 'viewer'], ['dani', 'admin']] as const) store.shareProject('p', login, role, 'guest');
        expect(store.membersOf('p').map((m) => `${m.user.login}:${m.role}`)).toEqual(['dani:admin', 'zoe:admin', 'beto:editor', 'Ana:viewer', 'Carla:viewer']);
        expect(store.membersOf('p')[0].addedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      });

      it('un proyecto admite hasta un máximo de personas', () => {
        const store = open();
        const owner = store.signIn(ana, OPEN);
        store.registerProject('p', owner.id);
        for (let i = 0; i < MAX_MEMBERS_PER_PROJECT - 1; i++) store.setMember('p', store.invite(`persona${i}`).id, 'viewer');
        expect(() => store.setMember('p', store.invite('una-mas').id, 'viewer')).toThrowError(code('limit'));
        expect(store.membersOf('p')).toHaveLength(MAX_MEMBERS_PER_PROJECT);
      });

      it('membershipCounts cuenta los proyectos de cada cuenta', () => {
        const store = open();
        const a = store.signIn(ana, OPEN);
        const b = store.signIn(beto, OPEN);
        store.registerProject('p', a.id);
        store.registerProject('q', a.id);
        store.setMember('q', b.id, 'viewer');
        expect([...store.membershipCounts()].sort()).toEqual([[a.id, 2], [b.id, 1]].sort());
      });
    });

    describe('compartir proyectos y administrar cuentas', () => {
      it('un proyecto no se queda sin administrador: ni quitando ni bajando de rol a la única persona que lo administra', () => {
        const store = open();
        const a = store.signIn(ana, OPEN);
        const b = store.signIn(beto, OPEN);
        store.registerProject('p', a.id);
        store.setMember('p', b.id, 'editor');
        expect(() => store.removeMember('p', a.id)).toThrowError(code('last-admin'));
        expect(() => store.setMember('p', a.id, 'editor')).toThrowError(code('last-admin'));
        expect(() => store.shareProject('p', 'ana', 'viewer', 'guest')).toThrowError(code('last-admin'));
        expect(store.roleOf(a.id, 'p')).toBe('admin');
        store.setMember('p', b.id, 'admin'); // con otra persona administradora, la primera puede irse o bajar
        expect(store.removeMember('p', a.id)).toBe(true);
        expect(() => store.setMember('p', b.id, 'viewer')).toThrowError(code('last-admin'));
      });

      it('shareProject comparte con quien ya entró, invita a quien no tiene cuenta y cambia el rol si ya pertenece', () => {
        const store = open();
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
        expect(() => store.shareProject('p', 'no es un usuario', 'viewer', 'guest')).toThrowError(code('invalid'));
        expect(() => store.shareProject('p', 'dani', 'dios' as never, 'guest')).toThrowError(code('invalid'));
        expect(store.findByLogin('dani')).toBeUndefined();
        // la invitación se reclama al entrar: la misma cuenta, con sus proyectos
        const claimed = store.signIn(carla, INVITE);
        expect(claimed.id).toBe(invited.user.id);
        expect(store.roleOf(claimed.id, 'p')).toBe('editor');
        expect(store.users()).toHaveLength(3);
      });

      it('shareProject es una sola operación: si el proyecto está lleno no queda la invitación, y tampoco un proyecto vacío', () => {
        const store = open();
        const owner = store.signIn(ana, OPEN);
        store.registerProject('p', owner.id);
        for (let i = 0; i < MAX_MEMBERS_PER_PROJECT - 1; i++) store.shareProject('p', `persona${i}`, 'viewer', 'guest');
        expect(() => store.shareProject('p', 'una-mas', 'viewer', 'guest')).toThrowError(code('limit'));
        expect(store.findByLogin('una-mas')).toBeUndefined();
        expect(() => store.shareProject('otro', 'una-mas', 'viewer', 'guest')).not.toThrow(); // este sí cabe
        expect(() => store.shareProject('otro', 'x', 'viewer', 'dios' as never)).toThrowError(code('invalid'));
        expect(store.findByLogin('x')).toBeUndefined();
      });

      it('si compartir falla por la última persona administradora tampoco queda una invitación nueva', () => {
        const store = open();
        const a = store.signIn(ana, OPEN);
        store.registerProject('p', a.id);
        const before = store.userCount;
        expect(() => store.shareProject('p', 'ana', 'viewer', 'guest')).toThrowError(code('last-admin'));
        expect(store.userCount).toBe(before);
      });

      it('quitar a un invitado que no ha entrado de su último proyecto cancela su invitación; a un miembro que sí entró, no', () => {
        const store = open();
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

      it('upsertUser crea una invitación con rol member (o el que se pida) y cambia las cuentas que existen, en una sola operación', () => {
        const store = open();
        const created = store.upsertUser('@Carla', {});
        expect(created).toMatchObject({ created: true, user: { login: 'Carla', siteRole: 'member' } });
        expect(created.user.githubId).toBeUndefined();
        expect(store.upsertUser('carla', { siteRole: 'guest' })).toMatchObject({ created: false, user: { siteRole: 'guest' } });
        expect(store.upsertUser('dani', { siteRole: 'guest', disabled: true })).toMatchObject({ created: true, user: { siteRole: 'guest', disabled: true } });
        expect(() => store.upsertUser('eva', { siteRole: 'rey' as never })).toThrowError(code('invalid'));
        expect(store.findByLogin('eva')).toBeUndefined();
        expect(() => store.upsertUser('no es un usuario', {})).toThrowError(code('invalid'));
      });

      it('updateUser cambia el rol y desactiva o reactiva; con un rol inválido o una cuenta inexistente no cambia nada', () => {
        const store = open();
        const user = store.signIn(ana, OPEN);
        expect(store.updateUser(user.id, { siteRole: 'guest' })).toMatchObject({ siteRole: 'guest' });
        expect(() => store.updateUser(user.id, { siteRole: 'rey' as never, disabled: true })).toThrowError(code('invalid'));
        expect(store.findUser(user.id)).toMatchObject({ siteRole: 'guest' });
        expect(store.findUser(user.id)?.disabled).toBeUndefined();
        expect(() => store.updateUser('u_nadie', { disabled: true })).toThrowError(code('not-found'));
        expect(store.updateUser(user.id, { disabled: true }).disabled).toBe(true);
        expect(store.updateUser(user.id, { disabled: false }).disabled).toBeUndefined();
      });

      it('removePending cancela una invitación y sus proyectos, y se niega con quien ya entró', () => {
        const store = open();
        const a = store.signIn(ana, OPEN);
        store.registerProject('p', a.id);
        const pending = store.shareProject('p', 'carla', 'viewer', 'member').user;
        store.removePending(pending.id);
        expect(store.findByLogin('carla')).toBeUndefined();
        expect(store.membersOf('p').map((m) => m.user.login)).toEqual(['ana']);
        expect(() => store.removePending(a.id)).toThrowError(code('conflict'));
        expect(() => store.removePending('u_nadie')).toThrowError(code('not-found'));
      });
    });

    describe('recuentos para las métricas y lectura', () => {
      it('stats() cuenta cuentas activas, desactivadas y pendientes, y solo las sesiones vigentes; nada más', () => {
        let now = Date.parse('2026-10-01T00:00:00Z');
        const store = open({ now: () => new Date(now) });
        expect(store.stats()).toEqual({ users: 0, active: 0, disabled: 0, pending: 0, sessions: 0 });
        const a = store.signIn(ana, OPEN);
        const b = store.signIn(beto, OPEN);
        store.invite('carla', 'guest'); // pendiente
        store.invite('dani', 'guest'); // pendiente que luego se desactiva: cuenta como desactivada, no como pendiente
        store.updateUser(store.findByLogin('dani')!.id, { disabled: true });
        store.updateUser(b.id, { disabled: true });
        store.createSession(a.id, 3600_000);
        store.createSession(a.id, 3 * 3600_000);
        expect(store.stats()).toEqual({ users: 4, active: 1, disabled: 2, pending: 1, sessions: 2 });
        now += 2 * 3600_000; // la primera sesión caduca
        expect(store.stats()).toEqual({ users: 4, active: 1, disabled: 2, pending: 1, sessions: 1 });
        // son solo números
        expect(Object.values(store.stats()).every((value) => typeof value === 'number')).toBe(true);
        store.updateUser(b.id, { disabled: false });
        expect(store.stats()).toEqual({ users: 4, active: 2, disabled: 1, pending: 1, sessions: 1 });
      });

      it('readable() dice que sí con el almacén abierto y no lanza nunca, tampoco cerrado', () => {
        const harness = make();
        expect(harness.store.readable()).toBe(true);
        harness.store.signIn(ana, OPEN);
        expect(harness.store.readable()).toBe(true);
        harness.store.close();
        expect(() => harness.store.readable()).not.toThrow();
      });
    });

    describe('reinicio', () => {
      it('al volver a abrir, todo sigue: cuentas, invitaciones, sesiones y pertenencias', () => {
        const harnessed = make();
        const { store } = harnessed;
        const a = store.signIn(ana, OPEN);
        store.registerProject('tienda', a.id);
        store.shareProject('tienda', 'carla', 'editor', 'guest');
        const session = store.createSession(a.id, 60_000);
        const before = store.snapshot();
        const usersBefore = store.users();
        const again = harnessed.reopen();
        expect(again.users()).toEqual(usersBefore);
        expect(again.users()).toEqual([expect.objectContaining({ login: 'ana', githubId: 101, name: 'Ana Pérez', siteRole: 'member' }), expect.objectContaining({ login: 'carla', siteRole: 'guest' })]);
        expect(again.roleOf(a.id, 'tienda')).toBe('admin');
        expect(again.membersOf('tienda').map((m) => [m.user.login, m.role])).toEqual([['ana', 'admin'], ['carla', 'editor']]);
        expect(again.lookupSession(session.token)?.login).toBe('ana');
        expect(again.snapshot()).toEqual(before);
        // y se puede seguir escribiendo
        expect(again.signIn(carla, INVITE).login).toBe('carla');
      });

      it('un volcado completo (snapshot) es una copia: cambiarla no cambia el almacén', () => {
        const store = open();
        store.signIn(ana, OPEN);
        const dump = store.snapshot();
        dump.users[0].login = 'otro';
        dump.users.length = 0;
        expect(store.users().map((u) => u.login)).toEqual(['ana']);
        expect(store.snapshot().version).toBe(1);
      });
    });
  });
}
