import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildCliBundle, BUNDLE_TIMEOUT, PROCESS_TEST_TIMEOUT, type CliBundle } from './helpers/cliBundle';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, startFakeGithub, type FakeGithub } from './helpers/fakeGithub';
import { loginWithGithub } from './helpers/githubLogin';

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
    IARK_TOKENS: '', IARK_WORKSPACE: '', IARK_ACCOUNTS: '', IARK_GITHUB_CLIENT_ID: '', IARK_GITHUB_CLIENT_SECRET: '', IARK_GITHUB_CLIENT_SECRET_FILE: '', IARK_PUBLIC_URL: '', IARK_ADMINS: '', IARK_SIGNUP: '',
    ...extra,
  });
  const serve = (args: string[], extra: Record<string, string>) => spawnSync(process.execPath, [bundle.cli, 'serve', ...args], { encoding: 'utf8', env: env(extra), timeout: 30_000 });

  async function start(args: string[], extra: Record<string, string>): Promise<{ base: string; output: () => string }> {
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
    return { base, output: () => output };
  }

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
});
