import { afterEach, describe, expect, it } from 'vitest';
import { loadSqlite, SqliteAccountStore } from './accounts/sqliteStore';
import { hashSessionToken } from './accounts/store';
import { ANA, BETO, call, CARLA, cleanupCloud, signIn, startCloud } from '../../tests/helpers/cloud';

/**
 * `iark serve --accounts --accounts-store sqlite` con dos servidores (dos «réplicas») sobre la misma base y el mismo espacio de trabajo:
 * lo que hace uno lo ve el otro al instante, porque las cuentas viven en la base y no en la memoria de cada proceso. Los servidores son
 * los de verdad (`createSuiteServer`); lo único falso es GitHub (cada servidor tiene el suyo). Los procesos de verdad están en
 * `sqliteProcesses.test.ts` y `tests/accounts-cli.test.ts`.
 */

afterEach(cleanupCloud);

async function replicas() {
  const a = await startCloud({ store: 'sqlite', signup: 'open' });
  const b = await startCloud({ store: 'sqlite', signup: 'open', accountsFile: a.file, root: a.root });
  return { a, b };
}

describe('iark serve con el almacén sqlite: dos servidores sobre la misma base', () => {
  it('la sesión abierta en un servidor vale en el otro, y cerrarla en uno la cierra en los dos', async () => {
    const { a, b } = await replicas();
    const ana = await signIn(a, ANA);
    const who = await call(b.base, ana).get('/api/whoami');
    expect(who.status).toBe(200);
    expect(await who.json()).toMatchObject({ auth: true, user: { login: 'ana', siteRole: 'admin' } });

    expect((await call(b.base, ana).post('/api/auth/logout')).status).toBe(200);
    expect((await call(a.base, ana).get('/api/whoami')).status).toBe(401);
    expect((await call(b.base, ana).get('/api/whoami')).status).toBe(401);
  });

  it('compartir un proyecto en un servidor vale en el otro: la invitación la reclama quien entra por el otro', async () => {
    const { a, b } = await replicas();
    const ana = await signIn(a, ANA);
    const beto = await signIn(b, BETO);
    const created = await call(a.base, beto).post('/api/projects', { name: 'Tienda' });
    expect(created.status).toBe(201);
    const id = (await created.json()).id as string;

    // Ana comparte por B con Carla, que aún no ha entrado: queda una invitación (cuenta pendiente) que ve también A
    expect((await call(b.base, ana).put(`/api/projects/${id}/members/carla`, { role: 'viewer' })).status).toBe(201);
    const pending = (await (await call(a.base, ana).get('/api/admin/users')).json()) as Array<{ login: string; pending: boolean }>;
    expect(pending.find((u) => u.login === 'carla')).toMatchObject({ pending: true });

    // Carla entra por A (que no sabe nada de B salvo por la base) y reclama la invitación; la ve B
    const carla = await signIn(a, CARLA);
    expect(await (await call(b.base, carla).get('/api/projects')).json()).toEqual([expect.objectContaining({ id, role: 'viewer' })]);
    const members = (await (await call(a.base, beto).get(`/api/projects/${id}/members`)).json()) as Array<{ login: string; role: string; pending: boolean }>;
    expect(members.map(({ login, role, pending }) => ({ login, role, pending }))).toEqual([
      { login: 'beto', role: 'admin', pending: false },
      { login: 'carla', role: 'viewer', pending: false },
    ]);
  });

  it('desactivar una cuenta en un servidor corta su sesión en el otro en el acto', async () => {
    const { a, b } = await replicas();
    const ana = await signIn(a, ANA);
    const beto = await signIn(b, BETO);
    expect((await call(a.base, beto).get('/api/whoami')).status).toBe(200);
    expect((await call(b.base, ana).put('/api/admin/users/beto', { disabled: true })).status).toBe(200);
    expect((await call(a.base, beto).get('/api/whoami')).status).toBe(401);
    expect((await call(b.base, beto).get('/api/whoami')).status).toBe(401);
  });

  it('la regla de la última persona administradora de un proyecto vale lo mire el servidor que lo mire', async () => {
    const { a, b } = await replicas();
    const beto = await signIn(a, BETO);
    const id = (await (await call(a.base, beto).post('/api/projects', { name: 'Tienda' })).json()).id as string;
    // Beto es la única persona administradora del proyecto: ni se baja el rol ni se va
    const demote = await call(b.base, beto).put(`/api/projects/${id}/members/beto`, { role: 'viewer' });
    expect(demote.status).toBe(409);
    expect((await call(b.base, beto).del(`/api/projects/${id}/members/beto`)).status).toBe(409);
  });

  it('un reinicio no pierde nada: tras apagar los dos servidores, otro nuevo sobre la misma base reconoce las sesiones y los proyectos', async () => {
    const { a, b } = await replicas();
    const ana = await signIn(a, ANA);
    const beto = await signIn(b, BETO);
    const id = (await (await call(a.base, beto).post('/api/projects', { name: 'Tienda' })).json()).id as string;
    await call(a.base, ana).put('/api/admin/users/carla', { siteRole: 'member' });
    await a.stop();
    await b.stop();

    const again = await startCloud({ store: 'sqlite', signup: 'open', accountsFile: a.file, root: a.root });
    expect(await (await call(again.base, ana).get('/api/whoami')).json()).toMatchObject({ user: { login: 'ana' } });
    expect(await (await call(again.base, beto).get('/api/projects')).json()).toEqual([expect.objectContaining({ id, role: 'admin' })]);
    const carla = await signIn(again, CARLA); // la invitación de antes del reinicio sigue ahí: entra como `member`
    expect(await (await call(again.base, carla).get('/api/whoami')).json()).toMatchObject({ user: { login: 'carla', siteRole: 'member' } });
    expect(again.accounts.store).toBeInstanceOf(SqliteAccountStore);
  });

  it('en la base solo queda el hash del token de sesión, nunca el token', async () => {
    const { a } = await replicas();
    const ana = await signIn(a, ANA);
    const db = new (loadSqlite().DatabaseSync)(a.file, { readOnly: true });
    try {
      const hashes = (db.prepare('SELECT hash FROM sessions').all() as Array<{ hash: string }>).map((row) => row.hash);
      expect(hashes).toEqual([hashSessionToken(ana)]);
      expect(hashes[0]).not.toContain(ana.slice('iark_s_'.length));
    } finally {
      db.close();
    }
  });
});
