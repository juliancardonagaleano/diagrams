import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryProjectStore } from '@iark/kernel';
import { MAX_MEMBERS_PER_PROJECT } from './accounts/store';
import { createDefaultRegistry } from './registry';
import { createSuiteServer } from './serve';
import { createToken, TokenStore } from './tokens';
import { ANA, BETO, call, CARLA, cleanupCloud, signIn, startCloud, tracked, type Cloud } from '../../tests/helpers/cloud';
import { loginWithGithub } from '../../tests/helpers/githubLogin';
import type { FakeProfile } from '../../tests/helpers/fakeGithub';

/**
 * Compartir proyectos (`/api/projects/<p>/members`) y administrar las cuentas (`/api/admin/users`) de `iark serve --accounts`. El servidor es el
 * de verdad; lo único falso es GitHub (ver `tests/helpers/cloud.ts`).
 */

afterEach(cleanupCloud);

const DANI: FakeProfile = { id: 404, login: 'dani' };

/** Ana crea el proyecto «Tienda» y devuelve su id. */
async function create(cloud: Cloud, token: string, name = 'Tienda'): Promise<string> {
  const res = await call(cloud.base, token).post('/api/projects', { name });
  expect(res.status).toBe(201);
  return (await res.json()).id;
}

/** Ana (administradora de la instancia) tiene el proyecto `tienda`, y Beto y Carla entraron con la instancia abierta. */
async function team(options: Parameters<typeof startCloud>[0] = {}) {
  const cloud = await startCloud({ signup: 'open', ...options });
  const ana = await signIn(cloud, ANA);
  const beto = await signIn(cloud, BETO);
  const carla = await signIn(cloud, CARLA);
  // el proyecto lo crea Beto: es su administrador, y Ana lo es por administrar la instancia
  const id = await create(cloud, beto, 'Tienda');
  return { cloud, ana, beto, carla, id };
}

/** La lista de miembros, sin la foto (la del GitHub de mentira es de relleno; se comprueba aparte). */
const members = async (cloud: Cloud, token: string, project = 'tienda'): Promise<Array<{ login: string; name?: string; role: string; pending: boolean; you?: boolean }>> => {
  const list = (await (await call(cloud.base, token).get(`/api/projects/${project}/members`)).json()) as Array<Record<string, unknown>>;
  return list.map(({ avatarUrl: _avatar, ...rest }) => rest) as never;
};

describe('miembros de un proyecto: ver y compartir', () => {
  it('quien crea el proyecto aparece como admin y `you`; compartir con alguien que ya entró lo añade, y volver a compartir cambia el rol', async () => {
    const { cloud, beto, carla } = await team();
    expect(await members(cloud, beto)).toEqual([{ login: 'beto', role: 'admin', pending: false, you: true }]);
    expect((await (await call(cloud.base, beto).get('/api/projects/tienda/members')).json())[0].avatarUrl).toMatch(/^https:\/\//);

    const added = await call(cloud.base, beto).put('/api/projects/tienda/members/carla', { role: 'viewer' });
    expect(added.status).toBe(201);
    expect(added.headers.get('location')).toBe('/api/projects/tienda/members/carla');
    expect(await added.json()).toEqual({ login: 'carla', avatarUrl: expect.stringMatching(/^https:/), role: 'viewer', pending: false });
    // ahora Carla lo ve, con su rol
    expect(await (await call(cloud.base, carla).get('/api/projects')).json()).toEqual([expect.objectContaining({ id: 'tienda', role: 'viewer' })]);
    expect(await members(cloud, carla)).toEqual([
      { login: 'beto', role: 'admin', pending: false },
      { login: 'carla', role: 'viewer', pending: false, you: true },
    ]);

    const changed = await call(cloud.base, beto).put('/api/projects/tienda/members/CARLA', { role: 'editor' });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ login: 'carla', role: 'editor' });
    expect((await call(cloud.base, carla).post('/api/projects/tienda/diagrams', { module: 'data', text: '{}' })).status).not.toBe(403);
  });

  it('el nombre y la foto de GitHub se ven en la lista, y `@usuario` también vale', async () => {
    const { cloud, beto } = await team();
    await call(cloud.base, beto).put('/api/projects/tienda/members/%40ana', { role: 'editor' });
    const list = await members(cloud, beto);
    expect(list.find((m: { login: string }) => m.login === 'ana')).toEqual({ login: 'ana', name: 'Ana Pérez', role: 'editor', pending: false });
  });

  it('compartir con un nombre sin cuenta crea una invitación (guest si la instancia es por invitación, member si está abierta) que se reclama al entrar', async () => {
    const invite = await startCloud({ signup: 'invite' });
    const ana = await signIn(invite, ANA);
    const id = await create(invite, ana);
    const shared = await call(invite.base, ana).put(`/api/projects/${id}/members/dani`, { role: 'editor' });
    expect(shared.status).toBe(201);
    expect(await shared.json()).toEqual({ login: 'dani', role: 'editor', pending: true });
    expect(await invite.accounts.store.findByLogin('dani')).toMatchObject({ siteRole: 'guest' });
    expect(await members(invite, ana, id)).toEqual([
      { login: 'ana', name: 'Ana Pérez', role: 'admin', pending: false, you: true },
      { login: 'dani', role: 'editor', pending: true },
    ]);
    // Dani entra por primera vez: reclama la invitación, ve el proyecto con su rol y no puede crear proyectos propios
    const dani = await signIn(invite, DANI);
    expect(await (await call(invite.base, dani).get('/api/projects')).json()).toEqual([expect.objectContaining({ id, role: 'editor' })]);
    expect((await call(invite.base, dani).post('/api/projects', { name: 'Mío' })).status).toBe(403);
    expect((await members(invite, dani, id)).find((m: { login: string }) => m.login === 'dani')).toEqual({ login: 'dani', name: undefined, role: 'editor', pending: false, you: true });

    const open = await startCloud({ signup: 'open' });
    const beto = await signIn(open, BETO);
    const other = await create(open, beto);
    await call(open.base, beto).put(`/api/projects/${other}/members/dani`, { role: 'viewer' });
    expect(await open.accounts.store.findByLogin('dani')).toMatchObject({ siteRole: 'member' });
  });

  it('quitar una invitación de invitado cancela la invitación: esa persona ya no puede entrar a la instancia', async () => {
    const cloud = await startCloud({ signup: 'invite' });
    const ana = await signIn(cloud, ANA);
    const id = await create(cloud, ana);
    await call(cloud.base, ana).put(`/api/projects/${id}/members/dani`, { role: 'viewer' });
    const removed = await call(cloud.base, ana).del(`/api/projects/${id}/members/dani`);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: 'dani' });
    expect(await cloud.accounts.store.findByLogin('dani')).toBeUndefined();
    const attempt = await loginWithGithub(cloud.base, cloud.fake, DANI);
    expect(attempt.token).toBeUndefined();
    expect(attempt.fragment.get('iark_error')).toBe('not_invited');
  });

  it('un administrador de la instancia comparte y quita en cualquier proyecto, aunque no sea miembro; en uno que no existe, 404', async () => {
    const { cloud, ana } = await team();
    const res = await call(cloud.base, ana).put('/api/projects/tienda/members/carla', { role: 'editor' });
    expect(res.status).toBe(201);
    expect((await members(cloud, ana)).map((m: { login: string; you?: boolean }) => [m.login, !!m.you])).toEqual([['beto', false], ['carla', false]]);
    expect((await call(cloud.base, ana).del('/api/projects/tienda/members/carla')).status).toBe(200);
    for (const res of [await call(cloud.base, ana).get('/api/projects/nada/members'), await call(cloud.base, ana).put('/api/projects/nada/members/carla', { role: 'viewer' })]) {
      expect(res.status).toBe(404);
    }
  });

  it('los miembros respetan los topes: personas por proyecto (409 limit) y datos inválidos (400)', async () => {
    const { cloud, beto } = await team();
    for (let i = 0; i < MAX_MEMBERS_PER_PROJECT - 1; i++) await cloud.accounts.store.shareProject('tienda', `persona${i}`, 'viewer', 'member');
    const full = await call(cloud.base, beto).put('/api/projects/tienda/members/una-mas', { role: 'viewer' });
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ code: 'limit' });
    expect(await cloud.accounts.store.findByLogin('una-mas')).toBeUndefined();

    const api = call(cloud.base, beto);
    for (const [path, body] of [
      ['/api/projects/tienda/members/carla', {}],
      ['/api/projects/tienda/members/carla', { role: 'dios' }],
      ['/api/projects/tienda/members/carla', { role: 7 }],
      ['/api/projects/tienda/members/no%20es%20usuario', { role: 'viewer' }],
      ['/api/projects/tienda/members/ab--cd', { role: 'viewer' }],
    ] as const) {
      const res = await api.put(path, body);
      expect(res.status, path).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'invalid' });
    }
    expect((await api.put('/api/projects/tienda/members/carla', '[]')).status).toBe(400);
    expect((await api.put('/api/projects/tienda/members/carla', 'no es json')).status).toBe(400);
  });

  it('rutas y métodos: 405 con su `Allow`, 404 para lo desconocido y JSON obligatorio al modificar', async () => {
    const { cloud, beto } = await team();
    const api = call(cloud.base, beto);
    const post = await api.post('/api/projects/tienda/members', {});
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET');
    const get = await api.get('/api/projects/tienda/members/beto');
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('PUT, DELETE');
    expect((await api.get('/api/projects/tienda/members/beto/mas')).status).toBe(404);
    expect((await api.del('/api/projects/tienda/members/nadie')).status).toBe(404);
    const plain = await fetch(`${cloud.base}/api/projects/tienda/members/carla`, { method: 'PUT', headers: { Authorization: `Bearer ${beto}`, 'Content-Type': 'text/plain' }, body: '{"role":"viewer"}' });
    expect(plain.status).toBe(415);
  });
});

describe('miembros de un proyecto: quién puede qué', () => {
  it('ver la lista basta con ser viewer; compartir y quitar piden ser admin del proyecto, y se decide antes de leer el cuerpo', async () => {
    const { cloud, beto, carla } = await team();
    await cloud.accounts.store.setMember('tienda', (await cloud.accounts.store.findByLogin('carla'))!.id, 'editor');
    const api = call(cloud.base, carla);
    expect((await api.get('/api/projects/tienda/members')).status).toBe(200);
    for (const res of [await api.put('/api/projects/tienda/members/dani', { role: 'viewer' }), await api.del('/api/projects/tienda/members/beto'), await api.put('/api/projects/tienda/members/carla', { role: 'admin' })]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'forbidden', error: expect.stringMatching(/Tu rol en este proyecto es «editor».*«admin»/) });
    }
    const plain = await fetch(`${cloud.base}/api/projects/tienda/members/dani`, { method: 'PUT', headers: { Authorization: `Bearer ${carla}`, 'Content-Type': 'text/plain' }, body: '¿?' });
    expect(plain.status).toBe(403); // y no 415 ni 400
    expect(await cloud.accounts.store.findByLogin('dani')).toBeUndefined();
    expect((await members(cloud, beto)).map((m: { login: string }) => m.login)).toEqual(['beto', 'carla']);
  });

  it('quien no pertenece al proyecto no ve ni sus miembros: 404, igual que si no existiera', async () => {
    const { cloud, carla } = await team();
    const api = call(cloud.base, carla);
    const responses = [await api.get('/api/projects/tienda/members'), await api.put('/api/projects/tienda/members/carla', { role: 'admin' }), await api.del('/api/projects/tienda/members/beto')];
    for (const res of responses) expect(res.status).toBe(404);
    const missing = await api.get('/api/projects/nada/members');
    expect(missing.status).toBe(404);
    expect((await responses[0].json()).error.replace('tienda', '')).toBe((await missing.json()).error.replace('nada', ''));
    expect(await cloud.accounts.store.roleOf((await cloud.accounts.store.findByLogin('carla'))!.id, 'tienda')).toBeUndefined();
  });

  it('quitar a alguien le cierra el proyecto al instante, aunque conserve su sesión', async () => {
    const { cloud, beto, carla } = await team();
    await call(cloud.base, beto).put('/api/projects/tienda/members/carla', { role: 'editor' });
    expect((await call(cloud.base, carla).get('/api/projects/tienda')).status).toBe(200);
    expect((await call(cloud.base, beto).del('/api/projects/tienda/members/carla')).status).toBe(200);
    expect((await call(cloud.base, carla).get('/api/projects/tienda')).status).toBe(404);
    expect(await (await call(cloud.base, carla).get('/api/projects')).json()).toEqual([]);
  });

  it('cualquiera puede dejar un proyecto (aunque sea viewer), sin importar cómo escriba su nombre; irse por otro no vale', async () => {
    const { cloud, beto, carla } = await team();
    await call(cloud.base, beto).put('/api/projects/tienda/members/carla', { role: 'viewer' });
    await call(cloud.base, beto).put('/api/projects/tienda/members/ana', { role: 'editor' });
    const api = call(cloud.base, carla);
    expect((await api.del('/api/projects/tienda/members/ana')).status).toBe(403); // quitar a otra persona exige admin
    const left = await api.del('/api/projects/tienda/members/CARLA');
    expect(left.status).toBe(200);
    expect(await left.json()).toEqual({ removed: 'carla' });
    expect((await api.get('/api/projects/tienda')).status).toBe(404);
    // quien no era miembro no «deja» nada, y sin pertenecer no se entera de que el proyecto existe
    expect((await api.del('/api/projects/tienda/members/carla')).status).toBe(404);
  });

  it('el último administrador no puede irse ni bajar de rol: 409 `last-admin`; con otro administrador, sí', async () => {
    const { cloud, beto } = await team();
    const api = call(cloud.base, beto);
    for (const res of [await api.del('/api/projects/tienda/members/beto'), await api.put('/api/projects/tienda/members/beto', { role: 'editor' })]) {
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'last-admin' });
    }
    expect((await members(cloud, beto)).map((m: { role: string }) => m.role)).toEqual(['admin']);
    await api.put('/api/projects/tienda/members/carla', { role: 'admin' });
    expect((await api.put('/api/projects/tienda/members/beto', { role: 'editor' })).status).toBe(200);
    // Carla es ahora la única administradora
    expect((await call(cloud.base, await signIn(cloud, CARLA)).del('/api/projects/tienda/members/carla')).status).toBe(409);
  });

  it('los administradores de la instancia ven la lista aunque no pertenezcan, y no se les cuenta como miembros', async () => {
    const { cloud, ana } = await team();
    expect(await members(cloud, ana)).toEqual([{ login: 'beto', role: 'admin', pending: false }]);
  });
});

describe('miembros de un proyecto: tokens y servidores sin cuentas', () => {
  it('un token admin comparte y quita; uno editor no; uno viewer solo lee (y sin `you`)', async () => {
    const cloud = await startCloud({ signup: 'open', tokens: true });
    const beto = await signIn(cloud, BETO);
    await signIn(cloud, CARLA);
    await create(cloud, beto);
    const admin = call(cloud.base, cloud.tokens!.admin);
    expect(await (await admin.get('/api/projects/tienda/members')).json()).toEqual([expect.objectContaining({ login: 'beto', role: 'admin', pending: false })]);
    expect((await (await admin.get('/api/projects/tienda/members')).json())[0]).not.toHaveProperty('you');
    expect((await admin.put('/api/projects/tienda/members/carla', { role: 'editor' })).status).toBe(201);
    expect((await admin.del('/api/projects/tienda/members/carla')).status).toBe(200);

    const editor = createToken(cloud.tokens!.file, { name: 'editor', role: 'editor' }).token;
    const viewer = createToken(cloud.tokens!.file, { name: 'lector', role: 'viewer' }).token;
    expect((await call(cloud.base, editor).put('/api/projects/tienda/members/carla', { role: 'viewer' })).status).toBe(403);
    expect((await call(cloud.base, viewer).put('/api/projects/tienda/members/carla', { role: 'viewer' })).status).toBe(403);
    expect((await call(cloud.base, viewer).del('/api/projects/tienda/members/beto')).status).toBe(403);
    expect((await call(cloud.base, viewer).get('/api/projects/tienda/members')).status).toBe(200);
    expect(await cloud.accounts.store.findByLogin('carla')).toMatchObject({ githubId: 303 });
    expect((await cloud.accounts.store.membersOf('tienda')).map((m) => m.user.login)).toEqual(['beto']);
  });

  it('sin cuentas (tokens solos o ninguna autenticación) los miembros no existen: 404', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iark-tokens-'));
    const file = join(dir, 'tokens.json');
    const admin = createToken(file, { name: 'admin', role: 'admin' }).token;
    const projects = new MemoryProjectStore();
    const { id } = await projects.createProject({ name: 'Tienda' });
    const server = createSuiteServer({ registry: createDefaultRegistry(), version: '1', projects, tokens: TokenStore.open(file) });
    tracked.servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const res of [await call(base, admin).get(`/api/projects/${id}/members`), await call(base, admin).put(`/api/projects/${id}/members/ana`, { role: 'viewer' }), await call(base, admin).get('/api/admin/users')]) {
      expect(res.status).toBe(404);
      expect((await res.json()).error).toMatch(/--accounts/);
    }
    const plain = createSuiteServer({ registry: createDefaultRegistry(), version: '1', projects });
    tracked.servers.push(plain);
    await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve));
    const plainBase = `http://127.0.0.1:${(plain.address() as AddressInfo).port}`;
    expect((await call(plainBase).get(`/api/projects/${id}/members`)).status).toBe(404);
    expect((await call(plainBase).get('/api/admin/users')).status).toBe(404);
  });
});

describe('administrar cuentas: /api/admin/users', () => {
  it('solo lo ve quien administra la instancia: sesiones de administrador y tokens admin; el resto, 403; sin credenciales, 401', async () => {
    const cloud = await startCloud({ signup: 'open', tokens: true });
    const ana = await signIn(cloud, ANA);
    const beto = await signIn(cloud, BETO);
    expect((await call(cloud.base, ana).get('/api/admin/users')).status).toBe(200);
    expect((await call(cloud.base, cloud.tokens!.admin).get('/api/admin/users')).status).toBe(200);
    const denied = await call(cloud.base, beto).get('/api/admin/users');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'forbidden' });
    for (const res of [await call(cloud.base, beto).put('/api/admin/users/carla', {}), await call(cloud.base, beto).del('/api/admin/users/carla')]) expect(res.status).toBe(403);
    expect(await cloud.accounts.store.findByLogin('carla')).toBeUndefined();
    const anonymous = await fetch(`${cloud.base}/api/admin/users`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toMatch(/Bearer/);
    // un rol que se le da a Beto no se nota hasta que lo tenga: antes de eso, 403 también para escribir
    expect((await call(cloud.base, beto).put('/api/admin/users/beto', { siteRole: 'admin' })).status).toBe(403);
  });

  it('la lista trae cada cuenta con su rol, si está pendiente, si figura en --admins y a cuántos proyectos pertenece', async () => {
    const { cloud, ana, beto } = await team();
    await call(cloud.base, beto).put('/api/projects/tienda/members/dani', { role: 'viewer' });
    await create(cloud, ana, 'Taller');
    const list = await (await call(cloud.base, ana).get('/api/admin/users')).json();
    expect(list.map((u: { login: string }) => u.login)).toEqual(['ana', 'beto', 'carla', 'dani']);
    const byLogin = Object.fromEntries(list.map((u: { login: string }) => [u.login, u]));
    expect(byLogin.ana).toMatchObject({ siteRole: 'admin', listed: true, disabled: false, pending: false, projects: 1, name: 'Ana Pérez' });
    expect(byLogin.beto).toMatchObject({ siteRole: 'member', disabled: false, pending: false, projects: 1 });
    expect(byLogin.beto).not.toHaveProperty('listed');
    expect(byLogin.carla).toMatchObject({ projects: 0 });
    expect(byLogin.dani).toMatchObject({ siteRole: 'member', pending: true, projects: 1 });
    expect(byLogin.dani).not.toHaveProperty('lastLoginAt');
    expect(byLogin.beto.lastLoginAt).toEqual(expect.any(String));
    expect(byLogin.beto.createdAt).toEqual(expect.any(String));
    expect(byLogin.beto.id).toMatch(/^u_/);
    // nunca el id de GitHub ni nada de las sesiones
    expect(JSON.stringify(list)).not.toMatch(/githubId|iark_s_|hash/);
  });

  it('invitar a un nombre de usuario crea una cuenta pendiente (member por omisión) con la que esa persona puede entrar aunque la instancia sea por invitación', async () => {
    const cloud = await startCloud({ signup: 'invite' });
    const ana = await signIn(cloud, ANA);
    const invited = await call(cloud.base, ana).put('/api/admin/users/%40Carla', {});
    expect(invited.status).toBe(201);
    expect(invited.headers.get('location')).toBe('/api/admin/users/Carla');
    expect(await invited.json()).toMatchObject({ login: 'Carla', siteRole: 'member', pending: true, disabled: false, projects: 0 });
    const guest = await call(cloud.base, ana).put('/api/admin/users/dani', { siteRole: 'guest' });
    expect(await guest.json()).toMatchObject({ siteRole: 'guest', pending: true });
    const again = await call(cloud.base, ana).put('/api/admin/users/carla', {});
    expect(again.status).toBe(200);

    const carla = await loginWithGithub(cloud.base, cloud.fake, CARLA);
    expect(carla.user).toMatchObject({ login: 'carla', siteRole: 'member' });
    expect((await call(cloud.base, carla.token).post('/api/projects', { name: 'Mío' })).status).toBe(201);
    const dani = await loginWithGithub(cloud.base, cloud.fake, DANI);
    expect(dani.user).toMatchObject({ siteRole: 'guest' });
    expect((await call(cloud.base, dani.token).post('/api/projects', { name: 'Suyo' })).status).toBe(403);
    expect((await cloud.accounts.store.users()).filter((u) => u.githubId === undefined)).toEqual([]);
  });

  it('cambiar el rol de la instancia surte efecto en la siguiente petición; desactivar una cuenta cierra sus sesiones y le impide volver', async () => {
    const { cloud, ana, beto, carla } = await team();
    const admin = call(cloud.base, ana);
    expect((await call(cloud.base, carla).post('/api/projects', { name: 'Taller' })).status).toBe(201);
    const guest = await admin.put('/api/admin/users/carla', { siteRole: 'guest' });
    expect(await guest.json()).toMatchObject({ siteRole: 'guest', disabled: false });
    expect((await call(cloud.base, carla).post('/api/projects', { name: 'Otro' })).status).toBe(403);
    // Beto, administrador de la instancia por decisión de otro administrador
    expect((await call(cloud.base, beto).get('/api/admin/users')).status).toBe(403);
    expect((await admin.put('/api/admin/users/beto', { siteRole: 'admin' })).status).toBe(200);
    expect((await call(cloud.base, beto).get('/api/admin/users')).status).toBe(200);
    expect(await (await call(cloud.base, beto).get('/api/whoami')).json()).toMatchObject({ role: 'admin' });

    const disabled = await admin.put('/api/admin/users/carla', { disabled: true });
    expect(await disabled.json()).toMatchObject({ disabled: true });
    expect((await call(cloud.base, carla).get('/api/projects')).status).toBe(401);
    const back = await loginWithGithub(cloud.base, cloud.fake, CARLA);
    expect(back.token).toBeUndefined();
    expect(back.fragment.get('iark_error')).toBe('disabled');
    await admin.put('/api/admin/users/carla', { disabled: false });
    expect((await loginWithGithub(cloud.base, cloud.fake, CARLA)).token).toBeDefined();
  });

  it('nadie se baja de rol ni se desactiva a sí mismo (409 `self`), y a quien figura en --admins no se le puede bajar (409 `listed-admin`)', async () => {
    const { cloud, ana, beto } = await team();
    await call(cloud.base, ana).put('/api/admin/users/beto', { siteRole: 'admin' });
    const other = call(cloud.base, beto);
    for (const body of [{ siteRole: 'member' }, { siteRole: 'guest' }, { disabled: true }]) {
      const res = await other.put('/api/admin/users/beto', body);
      expect(res.status, JSON.stringify(body)).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'self' });
    }
    expect(await cloud.accounts.store.findByLogin('beto')).toMatchObject({ siteRole: 'admin' });
    expect((await other.put('/api/admin/users/beto', { siteRole: 'admin', disabled: false })).status).toBe(200); // sin cambios no hay problema
    for (const body of [{ siteRole: 'member' }, { siteRole: 'guest' }, { disabled: true }]) {
      const res = await other.put('/api/admin/users/ana', body);
      expect(res.status, JSON.stringify(body)).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'listed-admin' });
    }
    expect(await cloud.accounts.store.findByLogin('ana')).toMatchObject({ siteRole: 'member' }); // el rol efectivo lo da la lista
    expect((await call(cloud.base, ana).get('/api/admin/users')).status).toBe(200);
    // un token admin (cuenta de servicio) sí puede, pero tampoco a quien figura en la lista
    const service = await startCloud({ signup: 'open', tokens: true });
    await signIn(service, ANA);
    const res = await call(service.base, service.tokens!.admin).put('/api/admin/users/ana', { disabled: true });
    expect(res.status).toBe(409);
  });

  it('cancelar la invitación de quien no ha entrado la borra con sus proyectos; con quien ya entró, 409 `conflict`; con quien no existe, 404', async () => {
    const { cloud, ana, beto } = await team();
    await call(cloud.base, beto).put('/api/projects/tienda/members/dani', { role: 'viewer' });
    const api = call(cloud.base, ana);
    const refused = await api.del('/api/admin/users/carla');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'conflict', error: expect.stringContaining('desactiva') });
    expect((await api.del('/api/admin/users/nadie')).status).toBe(404);
    const removed = await api.del('/api/admin/users/DANI');
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: 'dani' });
    expect((await members(cloud, beto)).map((m: { login: string }) => m.login)).toEqual(['beto']);
    expect(await cloud.accounts.store.findByLogin('dani')).toBeUndefined();
  });

  it('datos inválidos, rutas, métodos y JSON obligatorio', async () => {
    const { cloud, ana } = await team();
    const api = call(cloud.base, ana);
    for (const [path, body] of [
      ['/api/admin/users/carla', { siteRole: 'rey' }],
      ['/api/admin/users/carla', { siteRole: 7 }],
      ['/api/admin/users/carla', { disabled: 'si' }],
      ['/api/admin/users/no%20es%20usuario', {}],
    ] as const) {
      const res = await api.put(path, body);
      expect(res.status, path).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'invalid' });
    }
    expect((await api.put('/api/admin/users/carla', '[]')).status).toBe(400);
    expect((await api.del('/api/admin/users/no%20es%20usuario')).status).toBe(400);
    expect(await cloud.accounts.store.findByLogin('carla')).toMatchObject({ siteRole: 'member', githubId: 303 });
    const post = await api.post('/api/admin/users', {});
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET');
    const get = await api.get('/api/admin/users/carla');
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('PUT, DELETE');
    expect((await api.get('/api/admin/otra')).status).toBe(404);
    expect((await api.get('/api/admin/users/a/b')).status).toBe(404);
    const plain = await fetch(`${cloud.base}/api/admin/users/carla`, { method: 'PUT', headers: { Authorization: `Bearer ${ana}`, 'Content-Type': 'text/plain' }, body: '{}' });
    expect(plain.status).toBe(415);
  });

  it('hay un tope de invitaciones sin aceptar (409 `limit`)', async () => {
    const cloud = await startCloud({ signup: 'open' });
    const ana = await signIn(cloud, ANA);
    for (let i = 0; i < 500; i++) await cloud.accounts.store.invite(`persona${i}`);
    const res = await call(cloud.base, ana).put('/api/admin/users/una-mas', {});
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'limit' });
    expect(await cloud.accounts.store.findByLogin('una-mas')).toBeUndefined();
  });

  it('las respuestas no se guardan en cachés y CORS anuncia `Authorization` para /api/admin', async () => {
    const cloud = await startCloud({ signup: 'open', cors: ['https://app.example.org'] });
    const ana = await signIn(cloud, ANA);
    const preflight = await fetch(`${cloud.base}/api/admin/users/carla`, { method: 'OPTIONS', headers: { Origin: 'https://app.example.org', 'Access-Control-Request-Method': 'PUT' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://app.example.org');
    expect(preflight.headers.get('access-control-allow-headers')).toMatch(/Authorization/);
    expect(preflight.headers.get('access-control-allow-methods')).toMatch(/PUT/);
    const res = await call(cloud.base, ana).get('/api/admin/users');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const members = await call(cloud.base, ana).get('/api/projects/nada/members');
    expect(members.headers.get('cache-control')).toBe('no-store');
  });
});
