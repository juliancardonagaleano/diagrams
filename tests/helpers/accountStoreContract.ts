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
  /**
   * Abre el almacén en esta ruta (la crea vacía si no existe). Los de archivo son síncronos y se presentan con `asAsync`; el de Postgres
   * toma la ruta como identificador de su esquema de prueba (volver a abrir la misma ruta es volver al mismo esquema).
   */
  open(path: string, options?: AccountStoreOptions): AccountStore | Promise<AccountStore>;
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
    afterEach(async () => {
      for (const store of opened.splice(0)) {
        try {
          await store.close();
        } catch {
          // ya estaba cerrado
        }
      }
      for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    /** Un almacén vacío en una carpeta temporal; `reopen()` lo cierra y lo vuelve a abrir (un reinicio del servicio). */
    const make = async (options: AccountStoreOptions = {}) => {
      const dir = mkdtempSync(join(tmpdir(), 'iark-contrato-'));
      folders.push(dir);
      const path = join(dir, harness.fileName);
      let store = await harness.open(path, options);
      opened.push(store);
      return {
        path,
        get store(): AccountStore {
          return store;
        },
        async reopen(reopenOptions: AccountStoreOptions = options): Promise<AccountStore> {
          await store.close();
          store = await harness.open(path, reopenOptions);
          opened.push(store);
          return store;
        },
      };
    };
    const open = async (options: AccountStoreOptions = {}): Promise<AccountStore> => (await make(options)).store;

    describe('quién entra', () => {
      it('con invitación solo entran las cuentas invitadas y los administradores; abierta, cualquiera como member', async () => {
        const store = await open();
        await expect(store.signIn(ana, INVITE)).rejects.toMatchObject({ code: 'not-invited' });
        expect((await store.userCount())).toBe(0);
        // un administrador de la lista entra aunque sea por invitación, y su cuenta guarda `member`: el rol de administrador lo da la lista, no el almacén
        expect((await store.signIn(ana, { signup: 'invite', admin: true })).siteRole).toBe('member');
        expect((await store.signIn(beto, OPEN)).siteRole).toBe('member');
      });

      it('una invitación por nombre de usuario la reclama quien entra con ese nombre, sin distinguir mayúsculas', async () => {
        const store = await open();
        const invited = await store.invite('@BETO', 'guest');
        expect(invited).toMatchObject({ login: 'BETO', siteRole: 'guest' });
        expect(invited.githubId).toBeUndefined();
        const signedIn = await store.signIn(beto, INVITE);
        expect(signedIn).toMatchObject({ id: invited.id, githubId: 202, login: 'Beto', siteRole: 'guest' });
        expect((await store.userCount())).toBe(1);
      });

      it('invitar a un nombre que ya tiene cuenta devuelve esa cuenta sin cambiarla', async () => {
        const store = await open();
        const first = await store.invite('carla', 'guest');
        expect(await store.invite('CARLA', 'member')).toEqual(first);
        expect((await store.findByLogin('carla'))?.siteRole).toBe('guest');
        await expect(store.invite('dani', 'rey' as never)).rejects.toMatchObject({ code: 'invalid' });
        expect(await store.findByLogin('dani')).toBeUndefined();
      });

      it('se reconoce a la persona por su id de GitHub: si cambia de nombre de usuario se actualiza su cuenta, no se crea otra', async () => {
        const store = await open();
        const first = await store.signIn(ana, OPEN);
        const again = await store.signIn({ ...ana, login: 'ana-nueva', name: undefined }, OPEN);
        expect(again.id).toBe(first.id);
        expect(again).toMatchObject({ login: 'ana-nueva' });
        expect(again.name).toBeUndefined();
        expect((await store.userCount())).toBe(1);
      });

      it('si alguien toma el nombre de usuario que dejó otra persona, la cuenta antigua conserva su id pero pierde el nombre', async () => {
        const store = await open();
        const old = await store.signIn(ana, OPEN);
        const newcomer = await store.signIn({ id: 303, login: 'ANA' }, OPEN);
        expect(newcomer.id).not.toBe(old.id);
        expect((await store.findByLogin('ana'))?.id).toBe(newcomer.id);
        expect((await store.findUser(old.id))?.login).toBe('ana~101');
        expect(() => parseLogin('ana~101')).toThrowError(AccountError); // ese nombre no se puede invitar ni reclamar
      });

      it('una persona conocida que entra con el nombre al que habían invitado hereda lo invitado y la invitación desaparece', async () => {
        const store = await open();
        const known = await store.signIn({ id: 5, login: 'viejo' }, OPEN);
        const pending = await store.invite('nuevo', 'guest');
        await store.setMember('p1', pending.id, 'editor');
        await store.setMember('p2', pending.id, 'admin');
        await store.setMember('p2', known.id, 'viewer');
        await store.signIn({ id: 5, login: 'nuevo' }, OPEN);
        expect((await store.users()).map((u) => u.login)).toEqual(['nuevo']);
        expect(await store.roleOf(known.id, 'p1')).toBe('editor');
        expect(await store.roleOf(known.id, 'p2')).toBe('admin'); // el rol mayor de los dos
        expect(await store.membersOf('p2')).toHaveLength(1);
      });

      it('una cuenta desactivada no entra y pierde sus sesiones', async () => {
        const store = await open();
        const user = await store.signIn(ana, OPEN);
        const { token } = await store.createSession(user.id, 60_000);
        await store.updateUser(user.id, { disabled: true });
        expect(await store.lookupSession(token)).toBeUndefined();
        expect(await store.sessionCount(user.id)).toBe(0);
        await expect(store.signIn(ana, OPEN)).rejects.toMatchObject({ code: 'disabled' });
        await store.updateUser(user.id, { disabled: false });
        expect((await store.signIn(ana, OPEN)).id).toBe(user.id);
      });

      it('si entrar falla, no queda nada a medias: ni la invitación fusionada ni el nombre cambiado', async () => {
        const store = await open();
        const known = await store.signIn({ id: 5, login: 'viejo' }, OPEN);
        await store.updateUser(known.id, { disabled: true });
        const pending = await store.invite('nuevo', 'guest');
        await store.setMember('p1', pending.id, 'editor');
        await expect(store.signIn({ id: 5, login: 'nuevo' }, OPEN)).rejects.toMatchObject({ code: 'disabled' });
        expect((await store.users()).map((u) => u.login)).toEqual(['viejo', 'nuevo']);
        expect(await store.roleOf(pending.id, 'p1')).toBe('editor');
        expect(await store.roleOf(known.id, 'p1')).toBeUndefined();
        expect((await store.findUser(known.id))?.lastLoginAt).toEqual(known.lastLoginAt);
      });

      it('solo se acumulan invitaciones hasta un tope', async () => {
        const store = await open();
        await expect(
          (async () => {
            for (let i = 0; i < MAX_PENDING_USERS * 2; i++) await store.invite(`persona${i}`);
          })(),
        ).rejects.toMatchObject({ code: 'limit' });
        expect((await store.userCount())).toBe(MAX_PENDING_USERS);
      });

      it('parseLogin acepta nombres de GitHub y rechaza lo demás', async () => {
        expect(parseLogin('  @ana-maria ')).toBe('ana-maria');
        expect(parseLogin('ana_acme')).toBe('ana_acme');
        for (const bad of ['', '-ana', 'ana-', 'a--b', 'ana maria', 'a'.repeat(40), 'ana/../x', 'ana[bot]', 3]) expect(() => parseLogin(bad)).toThrowError(code('invalid'));
      });

      it('una cuenta se busca por id y por nombre (sin distinguir mayúsculas) y se devuelve una copia', async () => {
        const store = await open();
        const user = await store.signIn(ana, OPEN);
        expect(await store.findUser(user.id)).toEqual(user);
        expect(await store.findByLogin('ANA')).toEqual(user);
        expect(await store.findUser('u_nadie')).toBeUndefined();
        expect(await store.findByLogin('nadie')).toBeUndefined();
        const copy = (await store.findUser(user.id))!;
        copy.siteRole = 'admin';
        expect((await store.findUser(user.id))?.siteRole).toBe('member');
        expect(user).toMatchObject({ githubId: 101, name: 'Ana Pérez', avatarUrl: 'https://avatars.example.test/101', siteRole: 'member' });
        expect(user.disabled).toBeUndefined();
      });
    });

    describe('sesiones', () => {
      it('una sesión vale hasta que caduca o se cierra', async () => {
        let now = Date.parse('2026-10-01T00:00:00Z');
        const store = await open({ now: () => new Date(now) });
        const user = await store.signIn(ana, OPEN);
        const { token, expiresAt } = await store.createSession(user.id, 3600_000);
        expect(token.startsWith(SESSION_PREFIX)).toBe(true);
        expect(expiresAt).toBe('2026-10-01T01:00:00.000Z');
        expect((await store.lookupSession(token))?.id).toBe(user.id);
        now += 3600_000 - 1;
        expect(await store.lookupSession(token)).toBeDefined();
        now += 1;
        expect(await store.lookupSession(token)).toBeUndefined();

        const fresh = await store.createSession(user.id, 3600_000);
        expect(await store.revokeSession(fresh.token)).toBe(true);
        expect(await store.lookupSession(fresh.token)).toBeUndefined();
        expect(await store.revokeSession(fresh.token)).toBe(false);
        expect(await store.lookupSession('iark_s_inventado')).toBeUndefined();
      });

      it('crear una sesión limpia las caducadas y cierra las más antiguas si hay demasiadas', async () => {
        let now = Date.parse('2026-10-01T00:00:00Z');
        const store = await open({ now: () => new Date(now) });
        const user = await store.signIn(ana, OPEN);
        const first = await store.createSession(user.id, 1000);
        now += 5000;
        const tokens: string[] = [];
        for (let i = 0; i < MAX_SESSIONS_PER_USER + 5; i++) {
          now += 1000;
          tokens.push((await store.createSession(user.id, 3600_000)).token);
        }
        expect(await store.lookupSession(first.token)).toBeUndefined();
        expect(await store.sessionCount(user.id)).toBe(MAX_SESSIONS_PER_USER);
        expect((await store.snapshot()).sessions).toHaveLength(MAX_SESSIONS_PER_USER);
        expect(await store.lookupSession(tokens[0])).toBeUndefined(); // las más antiguas se cerraron
        expect(await store.lookupSession(tokens[tokens.length - 1])).toBeDefined();
      });

      it('las sesiones de una cuenta no se cuentan ni se podan por las de otra', async () => {
        const store = await open();
        const a = await store.signIn(ana, OPEN);
        const b = await store.signIn(beto, OPEN);
        const own = await store.createSession(a.id, 60_000);
        for (let i = 0; i < MAX_SESSIONS_PER_USER + 3; i++) await store.createSession(b.id, 60_000);
        expect(await store.sessionCount(a.id)).toBe(1);
        expect(await store.sessionCount(b.id)).toBe(MAX_SESSIONS_PER_USER);
        expect((await store.lookupSession(own.token))?.id).toBe(a.id);
        await expect(store.createSession('u_nadie', 60_000)).rejects.toMatchObject({ code: 'not-found' });
      });

      it('del token de una sesión solo queda su hash', async () => {
        const store = await open();
        const { token } = await store.createSession((await store.signIn(ana, OPEN)).id, 60_000);
        const dump = await store.snapshot();
        expect(JSON.stringify(dump)).not.toContain(token);
        expect(dump.sessions[0].hash).toMatch(/^[0-9a-f]{64}$/);
      });
    });

    describe('pertenencia a proyectos', () => {
      it('quien crea un proyecto es su administrador; registrar el mismo id otra vez reemplaza a los miembros anteriores', async () => {
        const store = await open();
        const a = await store.signIn(ana, OPEN);
        const b = await store.signIn(beto, OPEN);
        await store.registerProject('tienda', a.id);
        await store.setMember('tienda', b.id, 'viewer');
        expect((await store.membersOf('tienda')).map((m) => [m.user.login, m.role])).toEqual([['ana', 'admin'], ['Beto', 'viewer']]);
        expect([...(await store.rolesOf(b.id))]).toEqual([['tienda', 'viewer']]);
        expect(await store.adminCount(a.id)).toBe(1);
        expect(await store.adminCount(b.id)).toBe(0);
        await store.registerProject('tienda', b.id); // otro proyecto con el mismo id: no hereda a Ana
        expect(await store.roleOf(a.id, 'tienda')).toBeUndefined();
        expect(await store.roleOf(b.id, 'tienda')).toBe('admin');
        await expect(store.registerProject('otro', 'u_nadie')).rejects.toMatchObject({ code: 'not-found' });
        expect(await store.membersOf('otro')).toEqual([]);
      });

      it('añadir, cambiar de rol, quitar y olvidar un proyecto', async () => {
        const store = await open();
        const a = await store.signIn(ana, OPEN);
        const b = await store.signIn(beto, OPEN);
        await store.registerProject('p', a.id);
        await store.setMember('p', b.id, 'viewer');
        await store.setMember('p', b.id, 'editor');
        expect(await store.roleOf(b.id, 'p')).toBe('editor');
        expect(await store.removeMember('p', b.id)).toBe(true);
        expect(await store.removeMember('p', b.id)).toBe(false);
        await expect(store.setMember('p', 'u_nadie', 'viewer')).rejects.toMatchObject({ code: 'not-found' });
        await expect(store.setMember('p', b.id, 'dios' as never)).rejects.toMatchObject({ code: 'invalid' });
        await store.dropProject('p');
        expect(await store.membersOf('p')).toEqual([]);
        expect((await store.snapshot()).projects).toEqual({});
        await store.dropProject('no-existe'); // no falla
      });

      it('los miembros salen con los administradores primero y luego por nombre sin distinguir mayúsculas', async () => {
        const store = await open();
        const owner = await store.signIn({ id: 1, login: 'zoe' }, OPEN);
        await store.registerProject('p', owner.id);
        for (const [login, role] of [['Ana', 'viewer'], ['beto', 'editor'], ['Carla', 'viewer'], ['dani', 'admin']] as const) await store.shareProject('p', login, role, 'guest');
        expect((await store.membersOf('p')).map((m) => `${m.user.login}:${m.role}`)).toEqual(['dani:admin', 'zoe:admin', 'beto:editor', 'Ana:viewer', 'Carla:viewer']);
        expect((await store.membersOf('p'))[0].addedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      });

      it('un proyecto admite hasta un máximo de personas', async () => {
        const store = await open();
        const owner = await store.signIn(ana, OPEN);
        await store.registerProject('p', owner.id);
        for (let i = 0; i < MAX_MEMBERS_PER_PROJECT - 1; i++) await store.setMember('p', (await store.invite(`persona${i}`)).id, 'viewer');
        await expect(store.setMember('p', (await store.invite('una-mas')).id, 'viewer')).rejects.toMatchObject({ code: 'limit' });
        expect(await store.membersOf('p')).toHaveLength(MAX_MEMBERS_PER_PROJECT);
      });

      it('membershipCounts cuenta los proyectos de cada cuenta', async () => {
        const store = await open();
        const a = await store.signIn(ana, OPEN);
        const b = await store.signIn(beto, OPEN);
        await store.registerProject('p', a.id);
        await store.registerProject('q', a.id);
        await store.setMember('q', b.id, 'viewer');
        expect([...(await store.membershipCounts())].sort()).toEqual([[a.id, 2], [b.id, 1]].sort());
      });
    });

    describe('compartir proyectos y administrar cuentas', () => {
      it('un proyecto no se queda sin administrador: ni quitando ni bajando de rol a la única persona que lo administra', async () => {
        const store = await open();
        const a = await store.signIn(ana, OPEN);
        const b = await store.signIn(beto, OPEN);
        await store.registerProject('p', a.id);
        await store.setMember('p', b.id, 'editor');
        await expect(store.removeMember('p', a.id)).rejects.toMatchObject({ code: 'last-admin' });
        await expect(store.setMember('p', a.id, 'editor')).rejects.toMatchObject({ code: 'last-admin' });
        await expect(store.shareProject('p', 'ana', 'viewer', 'guest')).rejects.toMatchObject({ code: 'last-admin' });
        expect(await store.roleOf(a.id, 'p')).toBe('admin');
        await store.setMember('p', b.id, 'admin'); // con otra persona administradora, la primera puede irse o bajar
        expect(await store.removeMember('p', a.id)).toBe(true);
        await expect(store.setMember('p', b.id, 'viewer')).rejects.toMatchObject({ code: 'last-admin' });
      });

      it('shareProject comparte con quien ya entró, invita a quien no tiene cuenta y cambia el rol si ya pertenece', async () => {
        const store = await open();
        const a = await store.signIn(ana, OPEN);
        await store.registerProject('p', a.id);
        await store.signIn(beto, OPEN);
        const known = await store.shareProject('p', '@BETO', 'editor', 'guest');
        expect(known).toMatchObject({ added: true, invited: false, user: { login: 'Beto', githubId: 202 } });
        const invited = await store.shareProject('p', 'carla', 'viewer', 'guest');
        expect(invited).toMatchObject({ added: true, invited: true, user: { login: 'carla', siteRole: 'guest' } });
        expect(invited.user.githubId).toBeUndefined();
        const changed = await store.shareProject('p', 'Carla', 'editor', 'guest');
        expect(changed).toMatchObject({ added: false, invited: false });
        expect((await store.membersOf('p')).map((m) => [m.user.login, m.role])).toEqual([['ana', 'admin'], ['Beto', 'editor'], ['carla', 'editor']]);
        await expect(store.shareProject('p', 'no es un usuario', 'viewer', 'guest')).rejects.toMatchObject({ code: 'invalid' });
        await expect(store.shareProject('p', 'dani', 'dios' as never, 'guest')).rejects.toMatchObject({ code: 'invalid' });
        expect(await store.findByLogin('dani')).toBeUndefined();
        // la invitación se reclama al entrar: la misma cuenta, con sus proyectos
        const claimed = await store.signIn(carla, INVITE);
        expect(claimed.id).toBe(invited.user.id);
        expect(await store.roleOf(claimed.id, 'p')).toBe('editor');
        expect(await store.users()).toHaveLength(3);
      });

      it('shareProject es una sola operación: si el proyecto está lleno no queda la invitación, y tampoco un proyecto vacío', async () => {
        const store = await open();
        const owner = await store.signIn(ana, OPEN);
        await store.registerProject('p', owner.id);
        for (let i = 0; i < MAX_MEMBERS_PER_PROJECT - 1; i++) await store.shareProject('p', `persona${i}`, 'viewer', 'guest');
        await expect(store.shareProject('p', 'una-mas', 'viewer', 'guest')).rejects.toMatchObject({ code: 'limit' });
        expect(await store.findByLogin('una-mas')).toBeUndefined();
        await expect(store.shareProject('otro', 'una-mas', 'viewer', 'guest')).resolves.toBeDefined(); // este sí cabe
        await expect(store.shareProject('otro', 'x', 'viewer', 'dios' as never)).rejects.toMatchObject({ code: 'invalid' });
        expect(await store.findByLogin('x')).toBeUndefined();
      });

      it('si compartir falla por la última persona administradora tampoco queda una invitación nueva', async () => {
        const store = await open();
        const a = await store.signIn(ana, OPEN);
        await store.registerProject('p', a.id);
        const before = (await store.userCount());
        await expect(store.shareProject('p', 'ana', 'viewer', 'guest')).rejects.toMatchObject({ code: 'last-admin' });
        expect((await store.userCount())).toBe(before);
      });

      it('quitar a un invitado que no ha entrado de su último proyecto cancela su invitación; a un miembro que sí entró, no', async () => {
        const store = await open();
        const a = await store.signIn(ana, OPEN);
        await store.registerProject('p', a.id);
        await store.registerProject('q', a.id);
        const pending = (await store.shareProject('p', 'carla', 'viewer', 'guest')).user;
        await store.shareProject('q', 'carla', 'viewer', 'guest');
        await store.removeMember('p', pending.id);
        expect(await store.findByLogin('carla')).toBeDefined(); // todavía le queda q
        await store.dropProject('q');
        expect(await store.findByLogin('carla')).toBeUndefined(); // sin proyectos, no le queda entrada a la instancia
        // un invitado de la instancia (rol member) o quien ya entró se queda
        const member = (await store.shareProject('p', 'dani', 'viewer', 'member')).user;
        await store.removeMember('p', member.id);
        expect(await store.findByLogin('dani')).toBeDefined();
        const b = await store.signIn(beto, OPEN);
        await store.setMember('p', b.id, 'viewer');
        await store.removeMember('p', b.id);
        expect(await store.findByLogin('beto')).toBeDefined();
      });

      it('upsertUser crea una invitación con rol member (o el que se pida) y cambia las cuentas que existen, en una sola operación', async () => {
        const store = await open();
        const created = await store.upsertUser('@Carla', {});
        expect(created).toMatchObject({ created: true, user: { login: 'Carla', siteRole: 'member' } });
        expect(created.user.githubId).toBeUndefined();
        expect(await store.upsertUser('carla', { siteRole: 'guest' })).toMatchObject({ created: false, user: { siteRole: 'guest' } });
        expect(await store.upsertUser('dani', { siteRole: 'guest', disabled: true })).toMatchObject({ created: true, user: { siteRole: 'guest', disabled: true } });
        await expect(store.upsertUser('eva', { siteRole: 'rey' as never })).rejects.toMatchObject({ code: 'invalid' });
        expect(await store.findByLogin('eva')).toBeUndefined();
        await expect(store.upsertUser('no es un usuario', {})).rejects.toMatchObject({ code: 'invalid' });
      });

      it('updateUser cambia el rol y desactiva o reactiva; con un rol inválido o una cuenta inexistente no cambia nada', async () => {
        const store = await open();
        const user = await store.signIn(ana, OPEN);
        expect(await store.updateUser(user.id, { siteRole: 'guest' })).toMatchObject({ siteRole: 'guest' });
        await expect(store.updateUser(user.id, { siteRole: 'rey' as never, disabled: true })).rejects.toMatchObject({ code: 'invalid' });
        expect(await store.findUser(user.id)).toMatchObject({ siteRole: 'guest' });
        expect((await store.findUser(user.id))?.disabled).toBeUndefined();
        await expect(store.updateUser('u_nadie', { disabled: true })).rejects.toMatchObject({ code: 'not-found' });
        expect((await store.updateUser(user.id, { disabled: true })).disabled).toBe(true);
        expect((await store.updateUser(user.id, { disabled: false })).disabled).toBeUndefined();
      });

      it('la cuota personal se fija campo a campo, se quita con null, sobrevive a un reinicio y a un volcado, y un valor inválido no cambia nada', async () => {
        const harnessed = await make();
        const store = harnessed.store;
        const user = await store.signIn(ana, OPEN);
        expect(user.quota).toBeUndefined();
        expect((await store.updateUser(user.id, { quota: { bytes: 5_000_000, diagramsPerProject: 0 } })).quota).toEqual({ bytes: 5_000_000, diagramsPerProject: 0 });
        // un cambio parcial no toca los demás campos; null quita solo ese
        expect((await store.updateUser(user.id, { quota: { projects: 3 } })).quota).toEqual({ bytes: 5_000_000, projects: 3, diagramsPerProject: 0 });
        expect((await store.updateUser(user.id, { quota: { bytes: null } })).quota).toEqual({ projects: 3, diagramsPerProject: 0 });
        // lo inválido se rechaza entero: ni el campo bueno de la misma petición se aplica
        for (const bad of [-1, 1.5, Number.NaN, Infinity, '10' as never, true as never]) {
          await expect(store.updateUser(user.id, { quota: { projects: 9, bytes: bad } }), String(bad)).rejects.toMatchObject({ code: 'invalid' });
        }
        expect((await store.findUser(user.id))?.quota).toEqual({ projects: 3, diagramsPerProject: 0 });
        // con todos los campos quitados, la cuenta ya no lleva cuota
        expect((await store.updateUser(user.id, { quota: { projects: null, diagramsPerProject: null } })).quota).toBeUndefined();
        await store.updateUser(user.id, { quota: { bytes: 1024 } });
        // el volcado lleva la cuota, y cambiar lo que se devuelve no cambia el almacén
        const dump = await store.snapshot();
        expect(dump.users[0].quota).toEqual({ bytes: 1024 });
        dump.users[0].quota!.bytes = 1;
        (await store.findUser(user.id))!.quota!.bytes = 2;
        expect((await store.findUser(user.id))?.quota).toEqual({ bytes: 1024 });
        const again = await harnessed.reopen();
        expect((await again.findUser(user.id))?.quota).toEqual({ bytes: 1024 });
        // upsertUser crea la invitación con su cuota, en una sola operación; si la cuota es inválida no queda la invitación
        expect(await again.upsertUser('dani', { quota: { projects: 2 } })).toMatchObject({ created: true, user: { quota: { projects: 2 } } });
        await expect(again.upsertUser('eva', { quota: { bytes: -5 } })).rejects.toMatchObject({ code: 'invalid' });
        expect(await again.findByLogin('eva')).toBeUndefined();
      });

      it('removePending cancela una invitación y sus proyectos, y se niega con quien ya entró', async () => {
        const store = await open();
        const a = await store.signIn(ana, OPEN);
        await store.registerProject('p', a.id);
        const pending = (await store.shareProject('p', 'carla', 'viewer', 'member')).user;
        await store.removePending(pending.id);
        expect(await store.findByLogin('carla')).toBeUndefined();
        expect((await store.membersOf('p')).map((m) => m.user.login)).toEqual(['ana']);
        await expect(store.removePending(a.id)).rejects.toMatchObject({ code: 'conflict' });
        await expect(store.removePending('u_nadie')).rejects.toMatchObject({ code: 'not-found' });
      });
    });

    describe('recuentos para las métricas y lectura', () => {
      it('stats() cuenta cuentas activas, desactivadas y pendientes, y solo las sesiones vigentes; nada más', async () => {
        let now = Date.parse('2026-10-01T00:00:00Z');
        const store = await open({ now: () => new Date(now) });
        expect(await store.stats()).toEqual({ users: 0, active: 0, disabled: 0, pending: 0, sessions: 0 });
        const a = await store.signIn(ana, OPEN);
        const b = await store.signIn(beto, OPEN);
        await store.invite('carla', 'guest'); // pendiente
        await store.invite('dani', 'guest'); // pendiente que luego se desactiva: cuenta como desactivada, no como pendiente
        await store.updateUser((await store.findByLogin('dani'))!.id, { disabled: true });
        await store.updateUser(b.id, { disabled: true });
        await store.createSession(a.id, 3600_000);
        await store.createSession(a.id, 3 * 3600_000);
        expect(await store.stats()).toEqual({ users: 4, active: 1, disabled: 2, pending: 1, sessions: 2 });
        now += 2 * 3600_000; // la primera sesión caduca
        expect(await store.stats()).toEqual({ users: 4, active: 1, disabled: 2, pending: 1, sessions: 1 });
        // son solo números
        expect(Object.values(await store.stats()).every((value) => typeof value === 'number')).toBe(true);
        await store.updateUser(b.id, { disabled: false });
        expect(await store.stats()).toEqual({ users: 4, active: 2, disabled: 1, pending: 1, sessions: 1 });
      });

      it('readable() dice que sí con el almacén abierto y no lanza nunca, tampoco cerrado', async () => {
        const harness = await make();
        expect(await harness.store.readable()).toBe(true);
        await harness.store.signIn(ana, OPEN);
        expect(await harness.store.readable()).toBe(true);
        await harness.store.close();
        await expect(harness.store.readable()).resolves.toEqual(expect.any(Boolean)); // cerrado: no rechaza nunca, responde sí o no
      });
    });

    describe('reinicio', () => {
      it('al volver a abrir, todo sigue: cuentas, invitaciones, sesiones y pertenencias', async () => {
        const harnessed = await make();
        const { store } = harnessed;
        const a = await store.signIn(ana, OPEN);
        await store.registerProject('tienda', a.id);
        await store.shareProject('tienda', 'carla', 'editor', 'guest');
        const session = await store.createSession(a.id, 60_000);
        const before = await store.snapshot();
        const usersBefore = await store.users();
        const again = await harnessed.reopen();
        expect(await again.users()).toEqual(usersBefore);
        expect(await again.users()).toEqual([expect.objectContaining({ login: 'ana', githubId: 101, name: 'Ana Pérez', siteRole: 'member' }), expect.objectContaining({ login: 'carla', siteRole: 'guest' })]);
        expect(await again.roleOf(a.id, 'tienda')).toBe('admin');
        expect((await again.membersOf('tienda')).map((m) => [m.user.login, m.role])).toEqual([['ana', 'admin'], ['carla', 'editor']]);
        expect((await again.lookupSession(session.token))?.login).toBe('ana');
        expect(await again.snapshot()).toEqual(before);
        // y se puede seguir escribiendo
        expect((await again.signIn(carla, INVITE)).login).toBe('carla');
      });

      it('un volcado completo (snapshot) es una copia: cambiarla no cambia el almacén', async () => {
        const store = await open();
        await store.signIn(ana, OPEN);
        const dump = await store.snapshot();
        dump.users[0].login = 'otro';
        dump.users.length = 0;
        expect((await store.users()).map((u) => u.login)).toEqual(['ana']);
        expect((await store.snapshot()).version).toBe(1);
      });
    });
  });
}
