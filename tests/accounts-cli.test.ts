import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildCliBundle, BUNDLE_TIMEOUT, PROCESS_TEST_TIMEOUT, type CliBundle } from './helpers/cliBundle';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, startFakeGithub, type FakeGithub } from './helpers/fakeGithub';
import { loginWithGithub } from './helpers/githubLogin';
import { JsonAccountStore } from '../src/cli/accounts/jsonStore';
import { SqliteAccountStore } from '../src/cli/accounts/sqliteStore';

// `iark serve` con el inicio de sesión de GitHub, lanzado como proceso con el CLI empaquetado (las opciones y las variables de entorno
// de verdad) y hablando con un GitHub de mentira.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT, hookTimeout: BUNDLE_TIMEOUT });

const ANA = { id: 583231, login: 'ana', name: 'Ana' };

describe('iark serve con inicio de sesión de GitHub (CLI empaquetado)', () => {
  let bundle: CliBundle;
  const dirs: string[] = [];
  const children: ChildProcess[] = [];
  const fakes: FakeGithub[] = [];
  beforeAll(async () => {
    bundle = await buildCliBundle('cuentas');
  });
  afterAll(() => bundle?.dispose());
  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null) await new Promise<void>((resolve) => (child.once('exit', () => resolve()), child.kill('SIGTERM')));
    }
    for (const fake of fakes.splice(0)) await fake.stop();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const tmp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'iark-cuentas-cli-'));
    dirs.push(dir);
    return dir;
  };
  const freePort = (): Promise<number> =>
    new Promise((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve(port));
      });
    });
  /** Las variables de la suite, vacías, salvo las que cada prueba pone. */
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    ...process.env,
    IARK_TOKENS: '', IARK_WORKSPACE: '', IARK_ACCOUNTS: '', IARK_ACCOUNTS_STORE: '', IARK_ACCOUNTS_IMPORT: '', IARK_GITHUB_CLIENT_ID: '', IARK_GITHUB_CLIENT_SECRET: '', IARK_GITHUB_CLIENT_SECRET_FILE: '', IARK_PUBLIC_URL: '', IARK_ADMINS: '', IARK_SIGNUP: '',
    ...extra,
  });
  const serve = (args: string[], extra: Record<string, string>) => spawnSync(process.execPath, [bundle.cli, 'serve', ...args], { encoding: 'utf8', env: env(extra), timeout: 30_000 });

  async function start(args: string[], extra: Record<string, string>): Promise<{ base: string; output: () => string; child: ChildProcess }> {
    const child = spawn(process.execPath, [bundle.cli, 'serve', ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: env(extra) });
    children.push(child);
    let output = '';
    const base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no arrancó:\n${output}`)), 60_000);
      const onData = (chunk: Buffer): void => {
        output += chunk.toString();
        const found = /escuchando en (http:\/\/[^\s]+?)(?: \(|\s|$)/.exec(output);
        if (found) (clearTimeout(timer), resolve(found[1]));
      };
      child.stdout!.on('data', onData);
      child.stderr!.on('data', onData);
      child.once('exit', (code) => (clearTimeout(timer), reject(new Error(`terminó (${code}):\n${output}`))));
    });
    await new Promise((resolve) => setTimeout(resolve, 300)); // las líneas de después de «escuchando» llegan en otros trozos
    return { base, output: () => output, child };
  }

  const stop = (child: ChildProcess): Promise<void> => (child.exitCode !== null ? Promise.resolve() : new Promise<void>((resolve) => (child.once('exit', () => resolve()), child.kill('SIGTERM'))));
  const iark = (args: string[], extra: Record<string, string> = {}) => spawnSync(process.execPath, [bundle.cli, ...args], { encoding: 'utf8', env: env(extra), timeout: 60_000 });
  const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

  it('con las variables de entorno de un contenedor arranca, deja entrar por GitHub y guarda las cuentas en disco', async () => {
    const fake = await startFakeGithub();
    fakes.push(fake);
    const dir = tmp();
    mkdirSync(join(dir, 'espacio'));
    const port = await freePort();
    writeFileSync(join(dir, 'secreto'), `${FAKE_CLIENT_SECRET}\n`);
    const { base, output } = await start(['--port', String(port), '--host', '127.0.0.1'], {
      IARK_WORKSPACE: join(dir, 'espacio'),
      IARK_ACCOUNTS: join(dir, 'cuentas.json'),
      IARK_GITHUB_CLIENT_ID: FAKE_CLIENT_ID,
      IARK_GITHUB_CLIENT_SECRET_FILE: join(dir, 'secreto'),
      IARK_GITHUB_URL: fake.url,
      IARK_GITHUB_API_URL: fake.url,
      IARK_PUBLIC_URL: `http://127.0.0.1:${port}`,
      IARK_ADMINS: String(ANA.id),
    });
    expect(output()).toContain(`inicio de sesión: GitHub (${FAKE_CLIENT_ID})`);
    expect(output()).toContain(`callback http://127.0.0.1:${port}/api/auth/github/callback`);
    expect(output()).toContain('solo por invitación');
    expect(output()).not.toContain(FAKE_CLIENT_SECRET);

    expect(await (await fetch(`${base}/api/auth/providers`)).json()).toEqual({ providers: [{ id: 'github', label: 'GitHub' }], tokens: false, signup: 'invite' });
    const result = await loginWithGithub(base, fake, ANA);
    expect(result.token).toMatch(/^iark_s_/);
    const created = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${result.token}` }, body: JSON.stringify({ name: 'Tienda' }) });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ id: 'tienda', role: 'admin' });
  });

  it('exige lo que falta, de una vez, y no acepta el secreto por la línea de comandos', () => {
    const res = serve(['--accounts', join(tmp(), 'c.json')], {});
    expect(res.status).toBe(2);
    for (const wanted of ['--github-client-id', 'IARK_GITHUB_CLIENT_SECRET', '--public-url', '--workspace']) expect(res.stderr).toContain(wanted);
    const flag = serve(['--github-client-secret', 'x'], {});
    expect(flag.status).not.toBe(0);
    expect(flag.stderr).toMatch(/unknown option/i);
  });

  it('una instancia que escucha fuera de loopback con cuentas arranca (sin tokens), y sin ninguna de las dos autenticaciones sigue negándose', async () => {
    const fake = await startFakeGithub();
    fakes.push(fake);
    const dir = tmp();
    const port = await freePort();
    const refused = serve(['--workspace', join(dir, 'espacio'), '--host', '0.0.0.0', '--port', String(port)], {});
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/--accounts/);
    const { output } = await start(['--workspace', join(dir, 'espacio'), '--host', '0.0.0.0', '--port', String(port), '--signup', 'open'], {
      IARK_ACCOUNTS: join(dir, 'cuentas.json'),
      IARK_GITHUB_CLIENT_ID: FAKE_CLIENT_ID,
      IARK_GITHUB_CLIENT_SECRET: FAKE_CLIENT_SECRET,
      IARK_PUBLIC_URL: 'https://iark.example.org',
    });
    expect(output()).toMatch(/entrada: abierta/);
    expect(output()).toMatch(/no habla TLS/);
  });

  it('IARK_CORS e IARK_TRUST_PROXY valen como --cors y --trust-proxy (plataformas que solo se configuran por entorno); con proxy declarado el aviso de TLS es un recordatorio', async () => {
    const dir = tmp();
    const port = await freePort();
    const common = { IARK_ACCOUNTS: join(dir, 'cuentas.json'), IARK_GITHUB_CLIENT_ID: FAKE_CLIENT_ID, IARK_GITHUB_CLIENT_SECRET: FAKE_CLIENT_SECRET, IARK_PUBLIC_URL: 'https://iark.example.org', IARK_ADMINS: String(ANA.id), IARK_WORKSPACE: join(dir, 'espacio') };
    const { output } = await start(['--host', '0.0.0.0', '--port', String(port)], { ...common, IARK_CORS: 'https://app.example.org', IARK_TRUST_PROXY: 'true' });
    expect(output()).toMatch(/detrás de un proxy de confianza \(--trust-proxy\)/);
    expect(output()).not.toMatch(/no habla TLS/);
    const preflight = await fetch(`http://127.0.0.1:${port}/api/projects`, { method: 'OPTIONS', headers: { Origin: 'https://app.example.org', 'Access-Control-Request-Method': 'GET' } });
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://app.example.org');
    const other = await fetch(`http://127.0.0.1:${port}/api/projects`, { method: 'OPTIONS', headers: { Origin: 'https://otro.example.org', 'Access-Control-Request-Method': 'GET' } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();

    // un valor vacío (como lo deja un compose sin IARK_CORS) es «ninguno», y un IARK_TRUST_PROXY que no es verdadero no activa nada
    const port2 = await freePort();
    const empty = await start(['--host', '0.0.0.0', '--port', String(port2)], { ...common, IARK_CORS: '', IARK_TRUST_PROXY: 'no' });
    expect(empty.output()).toMatch(/no habla TLS/);
    const none = await fetch(`http://127.0.0.1:${port2}/api/projects`, { method: 'OPTIONS', headers: { Origin: 'https://app.example.org', 'Access-Control-Request-Method': 'GET' } });
    expect(none.headers.get('access-control-allow-origin')).toBeNull();
  });
  // ───── el almacén SQLite ─────

  /** Las variables de un contenedor para una instancia con cuentas en `dir`; `store`/`accounts` eligen almacén y archivo. */
  const instance = (dir: string, port: number, fake: FakeGithub, extra: Record<string, string> = {}): Record<string, string> => ({
    IARK_WORKSPACE: join(dir, 'espacio'),
    IARK_GITHUB_CLIENT_ID: FAKE_CLIENT_ID,
    IARK_GITHUB_CLIENT_SECRET: FAKE_CLIENT_SECRET,
    IARK_GITHUB_URL: fake.url,
    IARK_GITHUB_API_URL: fake.url,
    IARK_PUBLIC_URL: `http://127.0.0.1:${port}`,
    IARK_ADMINS: String(ANA.id),
    ...extra,
  });
  const listen = (port: number): string[] => ['--port', String(port), '--host', '127.0.0.1'];
  const whoami = (base: string, token: string) => fetch(`${base}/api/whoami`, { headers: { Authorization: `Bearer ${token}` } });
  const projects = async (base: string, token: string): Promise<Array<{ id: string; role: string }>> =>
    (await (await fetch(`${base}/api/projects`, { headers: { Authorization: `Bearer ${token}` } })).json()) as Array<{ id: string; role: string }>;
  const createProject = (base: string, token: string, name: string) =>
    fetch(`${base}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ name }) });

  it('--accounts-store sqlite: guarda las cuentas en una base 0600, sin avisos de Node, y tras reiniciar la sesión y los proyectos siguen', async () => {
    const fake = await startFakeGithub();
    fakes.push(fake);
    const dir = tmp();
    mkdirSync(join(dir, 'espacio'));
    const db = join(dir, 'datos', 'cuentas.db');
    const port = await freePort();
    const vars = instance(dir, port, fake, { IARK_ACCOUNTS: db, IARK_ACCOUNTS_STORE: 'sqlite' });

    const first = await start(listen(port), vars);
    expect(first.output()).toMatch(/cuentas: .*cuentas\.db \(.*almacén sqlite\)/);
    expect(first.output()).not.toMatch(/ExperimentalWarning|node:sqlite|SQLite is an experimental/i);
    const result = await loginWithGithub(first.base, fake, ANA);
    expect(result.token).toMatch(/^iark_s_/);
    expect((await createProject(first.base, result.token!, 'Tienda')).status).toBe(201);
    expect(statSync(db).mode & 0o777).toBe(0o600);
    await stop(first.child);

    const second = await start(listen(port), vars);
    expect(second.output()).not.toMatch(/ExperimentalWarning/);
    expect((await whoami(second.base, result.token!)).status).toBe(200);
    expect(await projects(second.base, result.token!)).toEqual([expect.objectContaining({ id: 'tienda', role: 'admin' })]);
  });

  it('dos servidores sobre la misma base a la vez: la sesión que abre uno vale en el otro y cerrarla en uno la cierra en los dos', async () => {
    const fake = await startFakeGithub();
    fakes.push(fake);
    const dir = tmp();
    mkdirSync(join(dir, 'espacio'));
    const portA = await freePort();
    const portB = await freePort();
    const shared = { IARK_ACCOUNTS: join(dir, 'cuentas.db'), IARK_ACCOUNTS_STORE: 'sqlite' };
    const a = await start(listen(portA), instance(dir, portA, fake, shared));
    const b = await start(listen(portB), instance(dir, portB, fake, shared));
    const result = await loginWithGithub(a.base, fake, ANA);
    expect((await whoami(b.base, result.token!)).status).toBe(200);
    expect((await createProject(b.base, result.token!, 'Tienda')).status).toBe(201);
    expect(await projects(a.base, result.token!)).toEqual([expect.objectContaining({ id: 'tienda' })]);
    expect((await fetch(`${b.base}/api/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${result.token}` } })).status).toBe(200);
    expect((await whoami(a.base, result.token!)).status).toBe(401);
  });

  it('de JSON a SQLite al actualizar: con --accounts-import la primera arrancada importa el JSON (la sesión de antes sigue valiendo), las siguientes no repiten nada', async () => {
    const fake = await startFakeGithub();
    fakes.push(fake);
    const dir = tmp();
    mkdirSync(join(dir, 'espacio'));
    const port = await freePort();
    const json = join(dir, 'cuentas.json');

    // antes: la instancia de siempre, con el almacén JSON
    const before = await start(listen(port), instance(dir, port, fake, { IARK_ACCOUNTS: json }));
    expect(before.output()).toMatch(/almacén json/);
    const result = await loginWithGithub(before.base, fake, ANA);
    expect((await createProject(before.base, result.token!, 'Tienda')).status).toBe(201);
    await stop(before.child);
    const jsonHash = sha(json);

    // después: la imagen nueva (sqlite) con el JSON de antes por importar
    const db = join(dir, 'cuentas.db');
    const upgraded = instance(dir, port, fake, { IARK_ACCOUNTS: db, IARK_ACCOUNTS_STORE: 'sqlite', IARK_ACCOUNTS_IMPORT: json });
    const after = await start(listen(port), upgraded);
    expect(after.output()).toMatch(/Cuentas importadas de .*cuentas\.json»: 1 cuenta, 1 sesión y 1 pertenencia a 1 proyecto\./);
    expect(after.output()).toMatch(/almacén sqlite/);
    expect((await whoami(after.base, result.token!)).status).toBe(200);
    expect(await projects(after.base, result.token!)).toEqual([expect.objectContaining({ id: 'tienda', role: 'admin' })]);
    await stop(after.child);
    expect(sha(json)).toBe(jsonHash); // el JSON no se toca
    expect(readdirSync(dir).filter((name) => name.startsWith('cuentas.json.bak-'))).toHaveLength(1);

    // con la importación todavía puesta, reiniciar no vuelve a importar ni avisa de nada
    const again = await start(listen(port), upgraded);
    expect(again.output()).not.toMatch(/Cuentas importadas|aviso:/);
    expect((await whoami(again.base, result.token!)).status).toBe(200);
    expect(readdirSync(dir).filter((name) => name.startsWith('cuentas.json.bak-'))).toHaveLength(1);
  });

  it('opciones de almacén inválidas: lo dice y sale con 2, sin crear nada', () => {
    const dir = tmp();
    const base = { IARK_WORKSPACE: join(dir, 'espacio'), IARK_ACCOUNTS: join(dir, 'cuentas.db'), IARK_GITHUB_CLIENT_ID: FAKE_CLIENT_ID, IARK_GITHUB_CLIENT_SECRET: FAKE_CLIENT_SECRET, IARK_PUBLIC_URL: 'http://127.0.0.1:1', IARK_ADMINS: '1' };
    const unknown = serve(['--accounts-store', 'postgres'], base);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toMatch(/--accounts-store debe ser .*json.*sqlite/);
    const mixed = serve(['--accounts-store', 'json', '--accounts-import', join(dir, 'x.json')], base);
    expect(mixed.status).toBe(2);
    expect(mixed.stderr).toMatch(/--accounts-import.*solo vale con --accounts-store sqlite/);
    const fromEnv = serve([], { ...base, IARK_ACCOUNTS_STORE: 'mysql' });
    expect(fromEnv.status).toBe(2);
    expect(existsSync(join(dir, 'cuentas.db'))).toBe(false);
  });

  it('con --accounts-store json y una base SQLite en esa ruta (o al revés), no arranca: dice qué pasa y no toca el archivo', () => {
    const dir = tmp();
    const db = join(dir, 'cuentas.db');
    SqliteAccountStore.open(db).close();
    const before = sha(db);
    const base = { IARK_WORKSPACE: join(dir, 'espacio'), IARK_ACCOUNTS: db, IARK_GITHUB_CLIENT_ID: FAKE_CLIENT_ID, IARK_GITHUB_CLIENT_SECRET: FAKE_CLIENT_SECRET, IARK_PUBLIC_URL: 'http://127.0.0.1:1', IARK_ADMINS: '1' };
    const wrong = serve([], base); // el almacén por omisión es json
    expect(wrong.status).toBe(2);
    expect(wrong.stderr).toMatch(/base SQLite.*--accounts-store sqlite/);
    expect(sha(db)).toBe(before);

    const json = join(dir, 'cuentas.json');
    JsonAccountStore.open(json);
    const reverse = serve(['--accounts-store', 'sqlite'], { ...base, IARK_ACCOUNTS: json });
    expect(reverse.status).toBe(2);
    expect(reverse.stderr).toMatch(/iark accounts migrate/);
  });

  describe('iark accounts', () => {
    /** Un JSON de cuentas de verdad, escrito por el almacén JSON: dos cuentas, una invitación, una sesión y un proyecto compartido. */
    function realJson(dir: string): { json: string; token: string } {
      const json = join(dir, 'cuentas.json');
      const store = JsonAccountStore.open(json);
      const ana = store.signIn({ id: 583231, login: 'ana', name: 'Ana Pérez' }, { signup: 'open', admin: true });
      store.signIn({ id: 202, login: 'beto' }, { signup: 'open', admin: false });
      store.registerProject('tienda', ana.id);
      store.shareProject('tienda', 'carla', 'editor', 'guest');
      return { json, token: store.createSession(ana.id, 30 * 24 * 3600 * 1000).token };
    }

    it('migrate pasa el JSON a la base: sin avisos de Node, con copia de seguridad 0600, el JSON intacto, y repetirlo no hace nada', () => {
      const dir = tmp();
      const { json, token } = realJson(dir);
      const db = join(dir, 'datos', 'cuentas.db');
      const jsonHash = sha(json);

      const dry = iark(['accounts', 'migrate', '--from', json, '--accounts', db, '--dry-run']);
      expect(dry.status, dry.stderr).toBe(0);
      expect(dry.stdout).toMatch(/Simulacro: .*se importarían 3 cuentas, 1 sesión y 2 pertenencias a 1 proyecto\./);
      expect(existsSync(db)).toBe(false); // un simulacro no crea la base
      expect(readdirSync(dir).some((name) => name.includes('.bak-'))).toBe(false);

      const run = iark(['accounts', 'migrate', '--from', json, '--accounts', db]);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stderr).toBe(''); // ni «ExperimentalWarning» ni nada
      expect(run.stdout).toMatch(/Cuentas importadas de .*: 3 cuentas, 1 sesión y 2 pertenencias a 1 proyecto\./);
      expect(statSync(db).mode & 0o777).toBe(0o600);
      const backups = readdirSync(dir).filter((name) => name.startsWith('cuentas.json.bak-'));
      expect(backups).toHaveLength(1);
      expect(statSync(join(dir, backups[0]!)).mode & 0o777).toBe(0o600);
      expect(sha(join(dir, backups[0]!))).toBe(jsonHash);
      expect(sha(json)).toBe(jsonHash);

      const store = SqliteAccountStore.open(db);
      try {
        expect(store.lookupSession(token)?.login).toBe('ana'); // la sesión de antes sigue valiendo
        expect(store.membersOf('tienda').map((m) => `${m.user.login}:${m.role}`)).toEqual(['ana:admin', 'carla:editor']);
      } finally {
        store.close();
      }

      const again = iark(['accounts', 'migrate', '--from', json, '--accounts', db]);
      expect(again.status).toBe(0);
      expect(again.stdout).toMatch(/Nada que hacer/);
      expect(readdirSync(dir).filter((name) => name.startsWith('cuentas.json.bak-'))).toHaveLength(1);
    });

    it('migrate también toma el origen y la base de IARK_ACCOUNTS_IMPORT e IARK_ACCOUNTS (como en un contenedor)', () => {
      const dir = tmp();
      const { json } = realJson(dir);
      const run = iark(['accounts', 'migrate', '--no-backup'], { IARK_ACCOUNTS: join(dir, 'cuentas.db'), IARK_ACCOUNTS_IMPORT: json });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toMatch(/Cuentas importadas/);
      expect(readdirSync(dir).some((name) => name.includes('.bak-'))).toBe(false); // --no-backup
    });

    it('migrate no mezcla con una base que ya tiene otras cuentas (sale con 1) y sin origen sale con 2', () => {
      const dir = tmp();
      const { json } = realJson(dir);
      const db = join(dir, 'cuentas.db');
      const other = SqliteAccountStore.open(db);
      other.invite('zoe', 'member');
      other.close();
      const before = sha(db);
      const mixed = iark(['accounts', 'migrate', '--from', json, '--accounts', db]);
      expect(mixed.status).toBe(1);
      expect(mixed.stderr).toMatch(/ya tiene cuentas que no salen de/);
      expect(SqliteAccountStore.open(db).userCount).toBe(1);

      const missing = iark(['accounts', 'migrate', '--from', join(dir, 'no-existe.json'), '--accounts', join(dir, 'otra.db')]);
      expect(missing.status).toBe(2);
      expect(existsSync(join(dir, 'otra.db'))).toBe(false);
      const noFrom = iark(['accounts', 'migrate', '--accounts', join(dir, 'otra.db')]);
      expect(noFrom.status).toBe(2);
      expect(noFrom.stderr).toMatch(/--from/);
      expect(sha(db)).toBe(before);
    });

    it('migrate con un JSON dañado no importa nada ni deja una base a medias', () => {
      const dir = tmp();
      const json = join(dir, 'cuentas.json');
      writeFileSync(json, '{"version":1,"users":[{"id":"u1"');
      const db = join(dir, 'cuentas.db');
      const run = iark(['accounts', 'migrate', '--from', json, '--accounts', db]);
      expect(run.status).toBe(2);
      expect(run.stderr).not.toContain('"u1"');
      expect(readdirSync(dir).some((name) => name.includes('.bak-'))).toBe(false);
      expect(existsSync(db)).toBe(false);
    });

    it('info cuenta lo que hay (en JSON también) y backup hace una copia coherente 0600 que no sobrescribe', () => {
      const dir = tmp();
      const { json } = realJson(dir);
      const db = join(dir, 'cuentas.db');
      expect(iark(['accounts', 'migrate', '--from', json, '--accounts', db]).status).toBe(0);

      const text = iark(['accounts', 'info', '--accounts', db]);
      expect(text.status, text.stderr).toBe(0);
      expect(text.stdout).toMatch(/esquema: 2 de 2 · diario: wal \(sincronización full\) · integridad: ok/);
      expect(text.stdout).toMatch(/cuentas: 3 \(1 invitaciones pendientes, 0 desactivadas\) · sesiones: 1 vigentes de 1/);
      expect(text.stdout).toMatch(/importada de .*cuentas\.json/);
      const data = JSON.parse(iark(['accounts', 'info', '--json'], { IARK_ACCOUNTS: db }).stdout);
      expect(data).toMatchObject({ schemaVersion: 2, journalMode: 'wal', users: 3, pending: 1, sessions: 1, memberships: 2, projects: 1, integrity: ['ok'], importedFrom: { source: json } });

      const copy = join(dir, 'copias', 'cuentas-copia.db');
      const backup = iark(['accounts', 'backup', copy, '--accounts', db]);
      expect(backup.status, backup.stderr).toBe(0);
      expect(backup.stdout).toMatch(/integridad: ok/);
      expect(statSync(copy).mode & 0o777).toBe(0o600);
      expect(SqliteAccountStore.checkFile(copy)).toEqual(['ok']);
      const copied = SqliteAccountStore.open(copy);
      try {
        expect(copied.userCount).toBe(3);
      } finally {
        copied.close();
      }
      const copyHash = sha(copy);
      const twice = iark(['accounts', 'backup', copy, '--accounts', db]);
      expect(twice.status).not.toBe(0);
      expect(sha(copy)).toBe(copyHash); // no sobrescribe
    });

    it('info y backup no inventan una base que no existe (una ruta mal escrita no deja una base vacía) y piden --accounts si falta', () => {
      const dir = tmp();
      const db = join(dir, 'mal-escrita.db');
      for (const args of [['info'], ['backup', join(dir, 'copia.db')]]) {
        const run = iark(['accounts', ...args, '--accounts', db]);
        expect(run.status, args.join(' ')).toBe(2);
        expect(run.stderr).toMatch(/No existe la base de cuentas/);
      }
      expect(existsSync(db)).toBe(false);
      expect(existsSync(join(dir, 'copia.db'))).toBe(false);
      const none = iark(['accounts', 'info']);
      expect(none.status).toBe(2);
      expect(none.stderr).toMatch(/--accounts/);
    });
  });
});
