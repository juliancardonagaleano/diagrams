import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashToken } from '../src/cli/tokens';
import { buildCliBundle, BUNDLE_TIMEOUT, PROCESS_TEST_TIMEOUT, type CliBundle } from './helpers/cliBundle';

// `iark auth` lanza el CLI empaquetado como proceso, igual que `tests/project-cli.test.ts`.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT, hookTimeout: BUNDLE_TIMEOUT });

describe('iark auth (CLI empaquetado)', () => {
  let bundle: CliBundle;
  const dirs: string[] = [];
  beforeAll(async () => {
    bundle = await buildCliBundle('auth');
  });
  afterAll(() => {
    bundle?.dispose();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  const tmp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'iark-auth-cli-'));
    dirs.push(dir);
    return dir;
  };
  /** `iark …` sin ninguna variable de entorno de la suite (los tests pasan `IARK_TOKENS` solo cuando la prueban). */
  const iark = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [bundle.cli, ...args], { encoding: 'utf8', env: { ...process.env, IARK_TOKENS: '', IARK_WORKSPACE: '', ...env } });

  it('recorre el flujo: create (el token sale una vez por stdout) → list → revoke', () => {
    const dir = tmp();
    const file = join(dir, 'tokens.json');
    const created = iark(['auth', 'create', 'Ana García', '--role', 'editor', '--tokens', file]);
    expect(created.status, created.stderr).toBe(0);
    // stdout es solo el token (sirve para `TOKEN=$(iark auth create …)`); lo demás va a stderr
    const token = created.stdout.trimEnd();
    expect(created.stdout).toBe(`${token}\n`);
    expect(token).toMatch(/^iark_[A-Za-z0-9_-]{43}$/);
    expect(created.stderr).toContain('«Ana García» (editor)');
    expect(created.stderr).toContain('no se vuelve a mostrar');
    expect(created.stderr).not.toContain(token);
    // en disco: solo el hash, con modo 0600
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(token);
    expect(JSON.parse(text).tokens).toEqual([{ name: 'Ana García', role: 'editor', hash: hashToken(token), createdAt: expect.any(String) }]);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);

    const second = iark(['auth', 'create', 'Luis', '--role', 'viewer', '-t', file]);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout.trimEnd()).not.toBe(token);

    const list = iark(['auth', 'list', '--tokens', file]);
    expect(list.status).toBe(0);
    expect(list.stdout).toMatch(/^Ana García\s+editor\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z$/m);
    expect(list.stdout).toMatch(/^Luis\s+viewer\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z$/m);
    for (const secret of [token, second.stdout.trim(), hashToken(token), hashToken(token).slice(0, 8)]) expect(list.stdout).not.toContain(secret);

    const asJson = iark(['auth', 'list', '--json', '--tokens', file]);
    expect(JSON.parse(asJson.stdout)).toEqual([
      { name: 'Ana García', role: 'editor', createdAt: expect.any(String) },
      { name: 'Luis', role: 'viewer', createdAt: expect.any(String) },
    ]);
    expect(asJson.stdout).not.toContain('hash');

    const revoked = iark(['auth', 'revoke', 'ana garcía', '--tokens', file]);
    expect(revoked.status, revoked.stderr).toBe(0);
    expect(revoked.stdout).toContain('«Ana García» (editor) revocado');
    expect(JSON.parse(iark(['auth', 'list', '--json', '-t', file]).stdout).map((t: { name: string }) => t.name)).toEqual(['Luis']);
    expect(readFileSync(file, 'utf8')).not.toContain(hashToken(token));
  });

  it('el archivo sale de IARK_TOKENS si no se indica --tokens (y --tokens manda)', () => {
    const dir = tmp();
    const fromEnv = join(dir, 'del-entorno.json');
    const explicit = join(dir, 'explicito.json');
    expect(iark(['auth', 'create', 'Ana', '--role', 'admin'], { IARK_TOKENS: fromEnv }).status).toBe(0);
    expect(JSON.parse(readFileSync(fromEnv, 'utf8')).tokens).toHaveLength(1);
    expect(iark(['auth', 'create', 'Luis', '--role', 'admin', '--tokens', explicit], { IARK_TOKENS: fromEnv }).status).toBe(0);
    expect(JSON.parse(readFileSync(explicit, 'utf8')).tokens.map((t: { name: string }) => t.name)).toEqual(['Luis']);
    expect(JSON.parse(readFileSync(fromEnv, 'utf8')).tokens.map((t: { name: string }) => t.name)).toEqual(['Ana']);
    expect(iark(['auth', 'list'], { IARK_TOKENS: fromEnv }).stdout).toContain('Ana');
    expect(iark(['auth', 'revoke', 'Ana'], { IARK_TOKENS: fromEnv }).status).toBe(0);
  });

  it('los errores de uso salen con código 2 y un mensaje claro (sin crear ni tocar nada)', () => {
    const dir = tmp();
    const file = join(dir, 'tokens.json');
    const fails = (args: string[], message: RegExp, env?: Record<string, string>) => {
      const result = iark(args, env);
      expect(result.status, `iark ${args.join(' ')}: ${result.stderr}`).toBe(2);
      expect(result.stderr).toMatch(message);
      expect(result.stdout).toBe(''); // y nunca un token
    };
    fails(['auth', 'create', 'Ana', '--tokens', file], /Falta --role: viewer, editor, admin/);
    fails(['auth', 'create', 'Ana', '--role', 'root', '--tokens', file], /Rol inválido «root»: use viewer, editor o admin/);
    fails(['auth', 'create', '   ', '--role', 'viewer', '--tokens', file], /no puede estar vacío/);
    fails(['auth', 'create', 'Ana', '--role', 'viewer'], /--tokens <archivo> o con la variable IARK_TOKENS/);
    fails(['auth', 'list'], /IARK_TOKENS/);
    fails(['auth', 'revoke', 'Ana'], /IARK_TOKENS/);
    fails(['auth', 'list', '--tokens', file], /No existe el archivo de tokens/);
    fails(['auth', 'revoke', 'Ana', '--tokens', file], /No existe el archivo de tokens/);
    expect(() => readFileSync(file)).toThrow(); // ninguno de los anteriores creó el archivo

    expect(iark(['auth', 'create', 'Ana', '--role', 'viewer', '--tokens', file]).status).toBe(0);
    fails(['auth', 'create', 'ANA', '--role', 'admin', '--tokens', file], /Ya existe un token llamado «ANA»/);
    fails(['auth', 'revoke', 'Nadie', '--tokens', file], /No existe ningún token llamado «Nadie»/);
  });

  it('un archivo dañado es un error de uso (2) y nunca se sobrescribe; uno que no se puede usar (disco, permisos), un error del sistema (1)', () => {
    const dir = tmp();
    const file = join(dir, 'tokens.json');
    writeFileSync(file, '{ "version": 1, "tokens": "roto" }');
    for (const args of [['auth', 'create', 'Ana', '--role', 'viewer'], ['auth', 'list'], ['auth', 'revoke', 'Ana']]) {
      const result = iark([...args, '--tokens', file]);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/El archivo de tokens no es válido/);
      expect(result.stdout).toBe('');
    }
    expect(readFileSync(file, 'utf8')).toBe('{ "version": 1, "tokens": "roto" }');

    writeFileSync(join(dir, 'archivo'), 'x');
    const unwritable = iark(['auth', 'create', 'Ana', '--role', 'viewer', '--tokens', join(dir, 'archivo', 'tokens.json')]);
    expect(unwritable.status).toBe(1);
    expect(unwritable.stderr).toMatch(/No se pudo leer el archivo de tokens/);
    expect(unwritable.stdout).toBe('');
  });

  it('list sin tokens lo dice y enseña cómo crear el primero', () => {
    const dir = tmp();
    const file = join(dir, 'tokens.json');
    iark(['auth', 'create', 'Ana', '--role', 'admin', '--tokens', file]);
    iark(['auth', 'revoke', 'Ana', '--tokens', file]);
    const list = iark(['auth', 'list', '--tokens', file]);
    expect(list.status).toBe(0);
    expect(list.stdout).toMatch(/No hay tokens en .*iark auth create <nombre> --role admin/);
    expect(JSON.parse(iark(['auth', 'list', '--json', '--tokens', file]).stdout)).toEqual([]);
  });

  it('la ayuda explica los roles', () => {
    const help = iark(['auth', '--help']).stdout;
    for (const text of ['viewer', 'editor', 'admin', 'create', 'list', 'revoke']) expect(help).toContain(text);
    expect(iark(['auth', 'create', '--help']).stdout).toContain('UNA vez');
  });
});

describe('iark serve --tokens (comando)', () => {
  let bundle: CliBundle;
  const dirs: string[] = [];
  beforeAll(async () => {
    bundle = await buildCliBundle('serve-tokens');
  });
  afterAll(() => {
    bundle?.dispose();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  const tmp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'iark-serve-tokens-'));
    dirs.push(dir);
    return dir;
  };
  const cleanEnv = { ...process.env, IARK_TOKENS: '', IARK_WORKSPACE: '' };
  const iark = (args: string[]) => spawnSync(process.execPath, [bundle.cli, ...args], { encoding: 'utf8', env: cleanEnv });
  const createToken = (file: string, name: string, role: string): string => {
    const result = iark(['auth', 'create', name, '--role', role, '--tokens', file]);
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  const as = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

  /** Arranca `iark serve` en un puerto libre; devuelve la URL (con 127.0.0.1 aunque escuche en 0.0.0.0), su stderr y cómo pararlo. */
  async function serve(args: string[], env: Record<string, string> = {}): Promise<{ url: string; stderr: () => string; stop: () => Promise<number | null> }> {
    const child = spawn(process.execPath, [bundle.cli, 'serve', '--port', '0', ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...cleanEnv, ...env } });
    let stderr = '';
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`no arrancó: ${stderr}`));
      }, PROCESS_TEST_TIMEOUT - 10_000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`terminó con ${code} sin arrancar: ${stderr}`));
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        const match = /escuchando en (http:\/\/\S+)/.exec(stderr);
        if (match) {
          clearTimeout(timer);
          resolve(match[1].replace('//0.0.0.0:', '//127.0.0.1:'));
        }
      });
    });
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
    return {
      url,
      stderr: () => stderr,
      stop: () => {
        child.kill('SIGTERM');
        return exited;
      },
    };
  }

  /** Arranca `iark serve` esperando que se niegue: su código de salida y su stderr. */
  const refuses = (args: string[], env: Record<string, string> = {}) =>
    new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, [bundle.cli, 'serve', '--port', '0', ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...cleanEnv, ...env } });
      let stderr = '';
      let stdout = '';
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
      child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
      const timer = setTimeout(() => child.kill('SIGKILL'), PROCESS_TEST_TIMEOUT - 10_000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ code, stderr, stdout });
      });
    });

  it('de punta a punta: crea tokens, arranca fuera de loopback con --tokens, exige token y rol, y una revocación surte efecto al instante', async () => {
    const dir = tmp();
    const file = join(dir, 'tokens.json');
    const workspace = join(dir, 'espacio');
    const ana = createToken(file, 'Ana', 'admin');
    const vic = createToken(file, 'Vic', 'viewer');
    const running = await serve(['--host', '0.0.0.0', '--workspace', workspace, '--tokens', file]);
    try {
      // el aviso sale en varias escrituras: se espera a las líneas que se comprueban, no solo a la primera
      await vi.waitFor(() => {
        expect(running.stderr()).toContain('proyectos: /api/projects');
        expect(running.stderr()).toContain(`autenticación: tokens de ${file} (2)`);
        expect(running.stderr()).toContain('no habla TLS'); // fuera de loopback, el aviso del proxy con HTTPS
      });
      expect(running.stderr()).not.toMatch(/aviso: escucha en/); // el aviso de antes ya no existe: ahora se exige --tokens

      const api = (path: string, init: RequestInit = {}) => fetch(`${running.url}${path}`, init);
      expect((await api('/api/projects')).status).toBe(401);
      expect((await api('/api/projects')).headers.get('www-authenticate')).toBe('Bearer realm="iark"');
      expect(await (await api('/api/whoami', { headers: as(ana) })).json()).toEqual({ auth: true, name: 'Ana', role: 'admin' });
      const manifest = await (await api('/.well-known/iark.json')).json();
      expect(manifest).toMatchObject({ projects: '../api/projects', projectsAuth: 'bearer' });

      expect((await api('/api/projects', { method: 'POST', headers: as(ana), body: JSON.stringify({ name: 'Nube' }) })).status).toBe(201);
      expect(readdirSync(workspace)).toEqual(['nube']);
      // el viewer lee, pero escribir le da 403
      expect((await api('/api/projects', { headers: as(vic) })).status).toBe(200);
      const denied = await api('/api/projects', { method: 'POST', headers: as(vic), body: JSON.stringify({ name: 'Colado' }) });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: 'forbidden' });
      expect((await api('/api/projects/nube', { method: 'DELETE', headers: as(vic) })).status).toBe(403);
      expect(readdirSync(workspace)).toEqual(['nube']);

      // revocar con el CLI (otro proceso) y comprobar que cae en la siguiente petición, sin reiniciar
      expect(iark(['auth', 'revoke', 'Vic', '--tokens', file]).status).toBe(0);
      expect((await api('/api/projects', { headers: as(vic) })).status).toBe(401);
      expect((await api('/api/projects', { headers: as(ana) })).status).toBe(200);
      // y crear uno nuevo funciona igual de rápido
      const eva = createToken(file, 'Eva', 'editor');
      expect(await (await api('/api/whoami', { headers: as(eva) })).json()).toEqual({ auth: true, name: 'Eva', role: 'editor' });
      expect(running.stderr()).toMatch(/archivo de tokens recargado: 1 token\(s\)/);
      // un token no sale nunca en el registro del servidor
      for (const token of [ana, vic, eva]) expect(running.stderr()).not.toContain(token);
    } finally {
      expect(await running.stop()).toBe(0);
    }
  });

  it('se niega a escuchar fuera de loopback con un espacio de trabajo y sin --tokens (código 2), y explica las dos salidas', async () => {
    const dir = tmp();
    const workspace = join(dir, 'espacio');
    for (const host of ['0.0.0.0', '::', '192.0.2.10', 'nube.example.org']) {
      const result = await refuses(['--host', host, '--workspace', workspace]);
      expect(result.code, host).toBe(2);
      expect(result.stderr).toContain(`escuchar en ${host} sin autenticación`);
      expect(result.stderr).toContain('--tokens <archivo>');
      expect(result.stderr).toContain('--host 127.0.0.1');
      expect(result.stderr).not.toContain('escuchando en'); // no llegó a abrir el puerto
    }
    // también si el espacio de trabajo viene de IARK_WORKSPACE
    const viaEnv = await refuses(['--host', '0.0.0.0'], { IARK_WORKSPACE: workspace });
    expect(viaEnv.code).toBe(2);
    expect(viaEnv.stderr).toContain('--tokens');
    expect(readdirSync(dir)).toEqual([]); // y no creó nada
  });

  it('en loopback sin --tokens arranca como siempre (sin autenticación), y sin espacio de trabajo no hace falta nada, ni fuera de loopback', async () => {
    const dir = tmp();
    for (const host of ['127.0.0.1', 'localhost']) {
      const running = await serve(['--host', host, '--workspace', join(dir, host)]);
      try {
        expect(await (await fetch(`${running.url}/api/whoami`)).json()).toEqual({ auth: false });
        expect((await fetch(`${running.url}/api/projects`)).status).toBe(200);
        expect(await (await fetch(`${running.url}/.well-known/iark.json`)).json()).toMatchObject({ projectsAuth: 'none' });
        expect(running.stderr()).not.toContain('autenticación');
      } finally {
        await running.stop();
      }
    }
    const solo = await serve(['--host', '0.0.0.0']); // sin --workspace no hay nada que proteger
    try {
      expect((await fetch(`${solo.url}/api/modules`)).status).toBe(200);
      expect((await fetch(`${solo.url}/api/projects`)).status).toBe(404);
      expect(await (await fetch(`${solo.url}/.well-known/iark.json`)).json()).not.toHaveProperty('projectsAuth');
    } finally {
      await solo.stop();
    }
  });

  it('IARK_TOKENS equivale a --tokens, y --trust-proxy hace que el freno distinga a cada cliente por X-Forwarded-For', async () => {
    const dir = tmp();
    const file = join(dir, 'tokens.json');
    const ana = createToken(file, 'Ana', 'admin');
    const running = await serve(['--host', '0.0.0.0', '--workspace', join(dir, 'espacio'), '--trust-proxy'], { IARK_TOKENS: file });
    try {
      const whoami = (token: string, client: string) => fetch(`${running.url}/api/whoami`, { headers: { Authorization: `Bearer ${token}`, 'X-Forwarded-For': client } });
      expect((await whoami(ana, '198.51.100.1')).status).toBe(200);
      for (let i = 0; i < 5; i++) expect((await whoami('iark_mal', '198.51.100.1')).status).toBe(401);
      const blocked = await whoami(ana, '198.51.100.1');
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      expect((await whoami(ana, '198.51.100.2')).status).toBe(200); // otro cliente tras el mismo proxy
    } finally {
      await running.stop();
    }
  });

  it('el archivo de tokens debe existir y ser válido al arrancar (código 2); sin espacio de trabajo, --tokens protege el cálculo en vez de ignorarse', async () => {
    const dir = tmp();
    const workspace = join(dir, 'espacio');
    const missing = await refuses(['--workspace', workspace, '--tokens', join(dir, 'no-existe.json')]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/No existe el archivo de tokens.*iark auth create/);
    expect(missing.stderr).not.toContain('escuchando en');

    const broken = join(dir, 'roto.json');
    writeFileSync(broken, '{ "version": 1, "tokens": [ { "name": "Ana", "role": "root" } ] }');
    const damaged = await refuses(['--workspace', workspace, '--tokens', broken]);
    expect(damaged.code).toBe(2);
    expect(damaged.stderr).toMatch(/El archivo de tokens no es válido/);
    expect(readFileSync(broken, 'utf8')).toContain('"root"'); // no lo tocó

    const file = join(dir, 'tokens.json');
    const ana = createToken(file, 'Ana', 'admin');
    const compute = await serve(['--tokens', file]); // en loopback y sin --workspace: ya no se ignora, protege las rutas de cálculo
    try {
      expect((await fetch(`${compute.url}/api/whoami`)).status).toBe(401);
      expect((await fetch(`${compute.url}/api/c4/validate`, { method: 'POST', body: '{}' })).status).toBe(401);
      expect((await fetch(`${compute.url}/api/c4/validate`, { method: 'POST', body: '{}', headers: as(ana) })).status).not.toBe(401);
      expect((await fetch(`${compute.url}/api/modules`)).status).toBe(200); // lo público sigue siéndolo
    } finally {
      await compute.stop();
    }
  });

  it('un archivo de tokens vacío arranca (nadie entra todavía) y avisa de cómo crear el primero', async () => {
    const dir = tmp();
    const file = join(dir, 'tokens.json');
    createToken(file, 'Ana', 'admin');
    expect(iark(['auth', 'revoke', 'Ana', '--tokens', file]).status).toBe(0);
    const running = await serve(['--workspace', join(dir, 'espacio'), '--tokens', file]);
    try {
      await vi.waitFor(() => expect(running.stderr()).toContain('ningún token'));
      expect((await fetch(`${running.url}/api/projects`)).status).toBe(401);
      const ana = createToken(file, 'Ana', 'admin'); // el primero, con el servidor en marcha
      expect((await fetch(`${running.url}/api/whoami`, { headers: as(ana) })).status).toBe(200);
    } finally {
      await running.stop();
    }
  });
});
