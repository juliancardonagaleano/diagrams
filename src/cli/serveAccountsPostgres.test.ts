import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Observability } from './observability';
import { FolderProjectStore } from './workspace';
import { hashSessionToken } from './accounts/store';
import { ANA, BETO, call, CARLA, cleanupCloud, cloudPostgres, signIn, startCloud, tracked } from '../../tests/helpers/cloud';
import { loginWithGithub } from '../../tests/helpers/githubLogin';
import { postgresAvailable, requirePostgresIfCi, startTestPostgres, testConfig } from '../../tests/helpers/postgres';
import { PostgresDatabase } from './postgres/pool';

requirePostgresIfCi();

/**
 * `iark serve --accounts --accounts-store postgres` de punta a punta, por HTTP: el servidor es el de verdad (`createSuiteServer`) con un Postgres de
 * verdad; lo único falso es GitHub. Dos servidores («réplicas») sobre el mismo esquema: lo que hace uno lo ve el otro al instante, porque las cuentas
 * viven en la base y no en la memoria de cada proceso. Lo que SÍ es de cada proceso (el `state` del inicio de sesión, los códigos de un solo uso y los
 * frenos de intentos) no se prueba aquí como compartido: es el límite documentado en `docs/cuentas-github.md` (con varias réplicas, afinidad de sesión).
 * Los mismos flujos corren contra Postgres sin cambiar nada con `IARK_TEST_ACCOUNTS_STORE=postgres` en `serveAccounts`, `serveMembers`, `serveQuotas`
 * y `serveVersions`. Los procesos de verdad están en `postgresProcesses.test.ts`.
 */

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupCloud();
  for (const close of closers.splice(0)) await close();
});

async function replicas() {
  const a = await startCloud({ store: 'postgres', signup: 'open' });
  const b = await startCloud({ store: 'postgres', signup: 'open', accountsFile: a.file, root: a.root });
  return { a, b };
}

const noisy = (): void => void vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

describe.skipIf(!postgresAvailable())('iark serve con el almacén postgres: dos servidores sobre la misma base', () => {
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

    // Carla entra por A y reclama la invitación; la ve B
    const carla = await signIn(a, CARLA);
    expect(await (await call(b.base, carla).get('/api/projects')).json()).toEqual([expect.objectContaining({ id, role: 'viewer' })]);
    const members = (await (await call(a.base, beto).get(`/api/projects/${id}/members`)).json()) as Array<{ login: string; role: string; pending: boolean }>;
    expect(members.map(({ login, role, pending }) => ({ login, role, pending }))).toEqual([
      { login: 'beto', role: 'admin', pending: false },
      { login: 'carla', role: 'viewer', pending: false },
    ]);
  });

  it('la administración vale entre servidores: desactivar una cuenta en uno corta su sesión en el otro en el acto; reactivarla le deja volver a entrar por cualquiera', async () => {
    const { a, b } = await replicas();
    const ana = await signIn(a, ANA);
    const beto = await signIn(b, BETO);
    expect((await call(a.base, beto).get('/api/whoami')).status).toBe(200);
    expect((await call(b.base, ana).put('/api/admin/users/beto', { disabled: true })).status).toBe(200);
    expect((await call(a.base, beto).get('/api/whoami')).status).toBe(401);
    expect((await call(b.base, beto).get('/api/whoami')).status).toBe(401);
    expect((await call(a.base, ana).put('/api/admin/users/beto', { disabled: false })).status).toBe(200);
    expect((await call(a.base, beto).get('/api/whoami')).status).toBe(401); // la sesión cortada no revive
    const again = await signIn(b, BETO);
    expect((await call(a.base, again).get('/api/whoami')).status).toBe(200);
  });

  it('la regla de la última persona administradora de un proyecto vale lo mire el servidor que lo mire', async () => {
    const { a, b } = await replicas();
    const beto = await signIn(a, BETO);
    const id = (await (await call(a.base, beto).post('/api/projects', { name: 'Tienda' })).json()).id as string;
    expect((await call(b.base, beto).put(`/api/projects/${id}/members/beto`, { role: 'viewer' })).status).toBe(409);
    expect((await call(b.base, beto).del(`/api/projects/${id}/members/beto`)).status).toBe(409);
  });

  it('dos servidores que dan de baja a la vez a las dos únicas administradoras: una se queda, nunca ninguna', async () => {
    const { a, b } = await replicas();
    const ana = await signIn(a, ANA);
    const beto = await signIn(b, BETO);
    const id = (await (await call(a.base, beto).post('/api/projects', { name: 'Tienda' })).json()).id as string;
    expect((await call(a.base, beto).put(`/api/projects/${id}/members/ana`, { role: 'admin' })).status).toBeLessThan(300);
    const [x, y] = await Promise.all([call(a.base, ana).del(`/api/projects/${id}/members/beto`), call(b.base, beto).del(`/api/projects/${id}/members/ana`)]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect((await a.accounts.store.membersOf(id)).filter((m) => m.role === 'admin')).toHaveLength(1);
  });

  it('un reinicio no pierde nada: tras apagar los dos servidores, otro nuevo sobre la misma base reconoce las sesiones y los proyectos', async () => {
    const { a, b } = await replicas();
    const ana = await signIn(a, ANA);
    const beto = await signIn(b, BETO);
    const id = (await (await call(a.base, beto).post('/api/projects', { name: 'Tienda' })).json()).id as string;
    await call(a.base, ana).put('/api/admin/users/carla', { siteRole: 'member' });
    await a.stop();
    await b.stop();

    const again = await startCloud({ store: 'postgres', signup: 'open', accountsFile: a.file, root: a.root });
    expect(await (await call(again.base, ana).get('/api/whoami')).json()).toMatchObject({ user: { login: 'ana' } });
    expect(await (await call(again.base, beto).get('/api/projects')).json()).toEqual([expect.objectContaining({ id, role: 'admin' })]);
    const carla = await signIn(again, CARLA); // la invitación de antes del reinicio sigue ahí: entra como `member`
    expect(await (await call(again.base, carla).get('/api/whoami')).json()).toMatchObject({ user: { login: 'carla', siteRole: 'member' } });
    expect(again.accounts.store.kind).toBe('postgres');
  });

  it('en la base solo queda el hash del token de sesión, nunca el token', async () => {
    const { a } = await replicas();
    const ana = await signIn(a, ANA);
    const db = await PostgresDatabase.connect(testConfig((await cloudPostgres()).url, a.file));
    try {
      const hashes = (await db.query<{ hash: string }>(`select hash from ${db.table('cuentas_sessions')}`)).map((row) => row.hash);
      expect(hashes).toEqual([hashSessionToken(ana)]);
      expect(hashes[0]).not.toContain(ana.slice('iark_s_'.length));
    } finally {
      await db.close();
    }
  });

  it('las cuotas se miden y se rechazan igual: el tope de proyectos por persona y el de diagramas por proyecto, con 409 limit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'iark-cuotas-pg-'));
    tracked.folders.push(root);
    const cloud = await startCloud({ store: 'postgres', signup: 'open', root, quotas: { projects: 2, diagramsPerProject: 1, bytes: 0 }, serve: { projects: new FolderProjectStore(root), usageTtlMs: 0 } });
    const beto = await signIn(cloud, BETO);
    const first = await call(cloud.base, beto).post('/api/projects', { name: 'Uno' });
    expect(first.status).toBe(201);
    const project = (await first.json()).id as string;
    expect((await call(cloud.base, beto).post('/api/projects', { name: 'Dos' })).status).toBe(201);
    const third = await call(cloud.base, beto).post('/api/projects', { name: 'Tres' });
    expect(third.status).toBe(409);
    expect(await third.json()).toMatchObject({ code: 'limit', quota: 'projects', limit: 2 });

    expect((await call(cloud.base, beto).post(`/api/projects/${project}/diagrams`, { module: 'c4', name: 'a', text: 'x' })).status).toBe(201);
    const over = await call(cloud.base, beto).post(`/api/projects/${project}/diagrams`, { module: 'c4', name: 'b', text: 'x' });
    expect(over.status).toBe(409);
    expect(await over.json()).toMatchObject({ code: 'limit', quota: 'diagrams' });

    // la cuota personal la fija un administrador por HTTP y se guarda en la base
    const ana = await signIn(cloud, ANA);
    expect((await call(cloud.base, ana).put('/api/admin/users/beto', { quota: { projects: 3 } })).status).toBe(200);
    expect((await call(cloud.base, beto).post('/api/projects', { name: 'Tres' })).status).toBe(201);
    expect((await cloud.accounts.store.findByLogin('beto'))?.quota).toEqual({ projects: 3 });
  });
});

describe.skipIf(!postgresAvailable())('iark serve con el almacén postgres: salud y caída de la base', () => {
  it('/readyz comprueba la base de verdad: ok con la base sana, fail si la conexión se cierra, y /metrics sigue saliendo', async () => {
    const obs = new Observability({ metrics: true, version: 'prueba' });
    closers.push(() => obs.close());
    const cloud = await startCloud({ store: 'postgres', signup: 'open', serve: { observability: obs, metricsToken: 'x'.repeat(24), readyCacheMs: 0 } });
    await signIn(cloud, ANA);
    await signIn(cloud, BETO);
    const ready = async () => {
      const res = await fetch(`${cloud.base}/readyz`);
      return { status: res.status, checks: ((await res.json()) as { checks: Record<string, string> }).checks };
    };
    const metrics = async () => {
      const res = await fetch(`${cloud.base}/metrics`, { headers: { Authorization: `Bearer ${'x'.repeat(24)}` } });
      return { status: res.status, text: await res.text() };
    };

    expect(await ready()).toEqual({ status: 200, checks: expect.objectContaining({ accounts: 'ok' }) });
    const before = await metrics();
    expect(before.text).toMatch(/^iark_accounts\{state="active"\} 2$/m);
    expect(before.text).toMatch(/^iark_sessions_active 2$/m);
    expect(before.text).toContain('iark_accounts{state="pending"} 0');

    await cloud.accounts.store.close();
    expect(await ready()).toEqual({ status: 503, checks: expect.objectContaining({ accounts: 'fail' }) });
    const during = await metrics();
    expect(during.status).toBe(200);
    expect(during.text).not.toContain('iark_accounts{');
    expect(during.text).toContain('iark_http_requests_total');
  });

  it('si la base se cae con el servicio en marcha: 503 con Retry-After y sin detalles (ni cadena de conexión) para quien llama, y el servicio sigue en pie', async () => {
    noisy();
    // Postgres propio de esta prueba, para poder apagarlo (el compartido sirve a las demás)
    const own = await startTestPostgres();
    let stopped = false;
    try {
      const obs = new Observability({ version: 'prueba' });
      closers.push(() => obs.close());
      const cloud = await startCloud({ store: 'postgres', postgresUrl: own.url, signup: 'open', serve: { observability: obs, readyCacheMs: 0 } });
      const ana = await signIn(cloud, ANA);
      expect((await call(cloud.base, ana).get('/api/whoami')).status).toBe(200);

      await own.stop();
      stopped = true;
      const whoami = await call(cloud.base, ana).get('/api/whoami');
      expect(whoami.status).toBe(503);
      expect(whoami.headers.get('retry-after')).toBe('5');
      const text = await whoami.text();
      expect(text).toMatch(/no puede acceder a las cuentas/);
      expect(text).not.toMatch(/postgres|127\.0\.0\.1|ECONN|pool/i);
      // entrar con GitHub tampoco entra a medias: la persona vuelve a la página con el error genérico de inicio de sesión (el motivo va al registro del servidor)
      const login = await loginWithGithub(cloud.base, cloud.fake, BETO);
      expect(login.token).toBeUndefined();
      expect(login.fragment.get('iark_error')).toBe('login_failed');
      expect((await fetch(`${cloud.base}/readyz`)).status).toBe(503);
      // el servicio no se cae: el resto de rutas sin cuentas siguen contestando
      expect((await fetch(`${cloud.base}/healthz`)).status).toBe(200);
    } finally {
      if (!stopped) await own.stop();
    }
  });
});
