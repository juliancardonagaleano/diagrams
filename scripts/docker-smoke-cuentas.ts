/**
 * Prueba real de la imagen Docker como servicio gestionado (`iark serve --accounts`): la imagen se construye (o se usa una ya
 * construida), se ejecuta de verdad con Docker y se recorre el inicio de sesión de GitHub contra un GitHub de mentira
 * (`tests/helpers/fakeGithub.ts`) que el contenedor alcanza por `--network host`. No usa la red: solo Docker y el puerto local.
 *
 * Lo que comprueba (cada línea sale como «ok» o «FALLO»; el código de salida es 1 si algo falla):
 *   - la imagen: usuario `node`, `/data` de 1000:1000, sin `IARK_WORKSPACE` fijado y con HEALTHCHECK (que consulta `/healthz`, el «vivo»
 *     que no depende del disco; `/readyz` es el «listo» para un balanceador o un monitor);
 *   - sin variables arranca la demo (API y sitio, sin proyectos ni cuentas); con `IARK_WORKSPACE` y sin autenticación se niega;
 *   - con cuentas, un volumen con nombre y el secreto por archivo (Docker secrets), con las mismas opciones de seguridad que
 *     `deploy/docker-compose.yml` (`--read-only --cap-drop ALL …`): el HEALTHCHECK sigue sano, inicio de sesión completo, crear un
 *     proyecto, que quede en el volumen con el dueño y el modo correctos, que la sesión y el proyecto sobrevivan a
 *     `docker restart` y a sustituir el contenedor por otro (actualizar la imagen), una copia de `/data` con el servicio en marcha
 *     restaurada en un volumen nuevo, y que `docker stop` salga con código 0;
 *   - `IARK_SIGNUP=invite` deja fuera a quien no es administrador (`#iark_error=not_invited`);
 *   - `--cors` deja volver al sitio de GitHub Pages tras entrar y no a otro origen; `--trust-proxy` da a cada cliente su freno;
 *   - un bind mount con el dueño 1000:1000 funciona (y con el de root el servicio dice por qué no arranca); con el disco de root,
 *     la imagen corre bien como root (`--build-arg IARK_RUN_AS=root`, probado con `--user 0`);
 *   - el secreto por archivo ilegible o vacío, el Client secret equivocado (`#iark_error=login_failed`, sin nada en el registro) y
 *     las variables que faltan dan lo que la guía de despliegue dice;
 *   - `/healthz` y `/readyz` responden sin sesión (también con la autenticación activa) y con `X-Request-Id`; `/metrics` no existe si no se
 *     activó (`--metrics`); y ni el secreto, ni las sesiones, ni los códigos de un solo uso aparecen en `docker logs` ni en el archivo de cuentas.
 *
 * Uso (desde la raíz del repositorio; hace falta Docker y Linux, por `--network host`):
 *   npx tsx scripts/docker-smoke-cuentas.ts                          # construye la imagen y la prueba
 *   npx tsx scripts/docker-smoke-cuentas.ts --image iark-diagrams    # prueba una imagen ya construida
 * Variables: IARK_SMOKE_IMAGE (como --image), IARK_SMOKE_DOCKERFILE (otro Dockerfile para construir; el contexto es siempre la
 * raíz), IARK_SMOKE_BUILD_ARGS (opciones extra de `docker build`, separadas por espacios; en una máquina con proxy:
 * `--network host --build-arg HTTPS_PROXY=… --build-context ca=<carpeta de la CA>`) e IARK_SMOKE_KEEP_IMAGE=1 (no borra al final
 * la imagen que construyó). Sin Docker, o sin un servicio que responda, se salta con un mensaje y sale con código 0.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, startFakeGithub, type FakeGithub } from '../tests/helpers/fakeGithub';
import { loginWithGithub } from '../tests/helpers/githubLogin';

const PAGES_ORIGIN = 'https://juliancardonagaleano.github.io';
const ADMIN = { id: 583231, login: 'duena', name: 'La Dueña' };
const VISITA = { id: 4242, login: 'visita' };
const SECRET_PATH = '/run/secrets/github_client_secret';
/** Las opciones de `deploy/docker-compose.yml` para el contenedor de IArk. */
const HARDENED = ['--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp'];

// ───────────── utilidades ─────────────

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

const docker = (args: string[]): Run => {
  const res = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
};

/** La salida de un comando de Docker que debe salir bien. */
function dockerOut(args: string[]): string {
  const res = docker(args);
  if (res.status !== 0) throw new Error(`docker ${args.slice(0, 3).join(' ')}… salió con ${res.status}: ${res.stderr.trim() || res.stdout.trim()}`);
  return res.stdout.trim();
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const results: { ok: boolean; text: string }[] = [];

function check(condition: unknown, text: string, detail?: string): boolean {
  const ok = Boolean(condition);
  results.push({ ok, text });
  console.log(`  ${ok ? 'ok   ' : 'FALLO'} ${text}${!ok && detail ? `\n         ${detail.replace(/\n/g, '\n         ')}` : ''}`);
  return ok;
}

async function scenario(title: string, body: () => Promise<void>): Promise<void> {
  console.log(`\n${title}`);
  try {
    await body();
  } catch (error) {
    check(false, `${title}: no se pudo completar`, (error as Error).message);
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

// ───────────── la imagen y lo que se crea (todo se borra al final) ─────────────

const prefix = `iark-smoke-${process.pid}`;
const containers: string[] = [];
const volumes: string[] = [];
const hostDirs: string[] = [];
let image = '';
let builtImage = false;
let counter = 0;

const nextName = (kind: string): string => `${prefix}-${kind}-${++counter}`;

function newVolume(): string {
  const name = nextName('vol');
  dockerOut(['volume', 'create', name]);
  volumes.push(name);
  return name;
}

/** Una carpeta del anfitrión con el dueño 1000:1000 (se cambia con la propia imagen como root: no hace falta serlo en el anfitrión). */
function newHostDir(kind: string, owner: '1000:1000' | 'root'): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-${kind}-`));
  hostDirs.push(dir);
  chmodSync(dir, 0o755); // como la crea `mkdir`; mkdtemp la deja en 0700
  if (owner === '1000:1000') dockerOut(['run', '--rm', '--user', '0', '-v', `${dir}:/d`, '--entrypoint', 'chown', image, '1000:1000', '/d']);
  return dir;
}

/** Ejecuta un comando como root en un contenedor efímero con `mount` montado en /d (para mirar o limpiar volúmenes y carpetas). */
function asRoot(mount: string, script: string): string {
  return dockerOut(['run', '--rm', '--user', '0', '-v', `${mount}:/d`, '--entrypoint', 'sh', image, '-c', script]);
}

interface ServiceOptions {
  kind: string;
  /** El puerto (la dirección pública, IARK_PUBLIC_URL, lleva el suyo: hay que conocerlo antes); por omisión, uno libre. */
  port?: number;
  env?: Record<string, string>;
  /** Montajes `-v` (volumen con nombre o carpeta:destino). */
  mounts?: string[];
  /** Argumentos que se añaden al ENTRYPOINT (`--trust-proxy`, `--cors=…`). */
  args?: string[];
  flags?: string[];
}

/** Arranca la imagen con la red del anfitrión y un puerto libre (el servidor y el HEALTHCHECK lo toman de PORT). */
async function startService(options: ServiceOptions): Promise<{ name: string; port: number; base: string }> {
  const port = options.port ?? (await freePort());
  const name = nextName(options.kind);
  containers.push(name);
  const env = { PORT: String(port), ...options.env };
  const args = ['run', '-d', '--name', name, '--network', 'host', ...(options.flags ?? []), ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), ...(options.mounts ?? []).flatMap((m) => ['-v', m]), image, ...(options.args ?? [])];
  dockerOut(args);
  return { name, port, base: `http://127.0.0.1:${port}` };
}

const state = (name: string, format: string): string => dockerOut(['inspect', '-f', format, name]);
const logs = (name: string): string => {
  const res = docker(['logs', name]);
  return `${res.stdout}${res.stderr}`;
};

/** Espera a que el HEALTHCHECK de la imagen diga `healthy` (o falla si el contenedor se detuvo). */
async function waitHealthy(name: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state(name, '{{.State.Status}}') !== 'running') throw new Error(`el contenedor ${name} se detuvo antes de estar sano:\n${logs(name).trim()}`);
    const health = state(name, '{{if .State.Health}}{{.State.Health.Status}}{{end}}');
    if (health === 'healthy') return;
    await sleep(1000);
  }
  throw new Error(`el contenedor ${name} no llegó a «healthy» en ${timeoutMs / 1000} s (${state(name, '{{.State.Health.Status}}')})`);
}

/** Espera a que el contenedor termine y devuelve su código de salida y lo que escribió (el servicio que «no arranca»). */
async function waitExit(name: string, timeoutMs = 30_000): Promise<{ code: number; output: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state(name, '{{.State.Status}}') === 'exited') return { code: Number(state(name, '{{.State.ExitCode}}')), output: logs(name) };
    await sleep(300);
  }
  throw new Error(`el contenedor ${name} sigue en marcha tras ${timeoutMs / 1000} s: se esperaba que se detuviera`);
}

const json = (token?: string): Record<string, string> => ({ 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) });

async function get(base: string, path: string, token?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // no es JSON: se devuelve el texto
  }
  return { status: res.status, body };
}

/** El secreto de la OAuth App en un archivo, como lo monta Docker (`/run/secrets/…`); `owner` decide quién puede leerlo. */
function secretFile(content: string, owner: '1000:1000' | 'root'): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-secreto-`));
  hostDirs.push(dir);
  const file = join(dir, 'github_client_secret');
  writeFileSync(file, content, { mode: 0o600 });
  dockerOut(['run', '--rm', '--user', '0', '-v', `${dir}:/d`, '--entrypoint', 'sh', image, '-c', owner === 'root' ? 'chown 0:0 /d/github_client_secret && chmod 600 /d/github_client_secret' : 'chown 1000:1000 /d/github_client_secret && chmod 400 /d/github_client_secret']);
  return file;
}

function accountsEnv(fake: FakeGithub, port: number, extra: Record<string, string> = {}): Record<string, string> {
  return {
    IARK_WORKSPACE: '/data/workspace',
    IARK_ACCOUNTS: '/data/accounts.json',
    IARK_GITHUB_CLIENT_ID: FAKE_CLIENT_ID,
    IARK_GITHUB_URL: fake.url,
    IARK_GITHUB_API_URL: fake.url,
    IARK_PUBLIC_URL: `http://127.0.0.1:${port}`,
    IARK_ADMINS: String(ADMIN.id),
    ...extra,
  };
}

/** Que ni el secreto ni una sesión ni un código de un solo uso salgan en los registros del contenedor ni en el archivo de cuentas. */
function noLeaks(name: string, secrets: Record<string, string | undefined>): void {
  const output = logs(name);
  for (const [what, value] of Object.entries(secrets)) {
    if (value) check(!output.includes(value), `${what} no aparece en «docker logs»`);
  }
}

function cleanup(): void {
  for (const name of containers) docker(['rm', '-f', name]);
  for (const dir of hostDirs) {
    // lo que crearon los contenedores es de 1000 o de root: se devuelve a quien ejecuta el script para poder borrar solo esta carpeta temporal
    if (image && process.getuid) docker(['run', '--rm', '--user', '0', '-v', `${dir}:/d`, '--entrypoint', 'chown', image, '-R', `${process.getuid()}:${process.getgid?.() ?? process.getuid()}`, '/d']);
    rmSync(dir, { recursive: true, force: true });
  }
  for (const name of volumes) docker(['volume', 'rm', '-f', name]);
  if (builtImage && !process.env.IARK_SMOKE_KEEP_IMAGE) docker(['rmi', '-f', image]);
}

// ───────────── los escenarios ─────────────

async function main(): Promise<number> {
  const argImage = process.argv.indexOf('--image') >= 0 ? process.argv[process.argv.indexOf('--image') + 1] : undefined;
  if (process.platform !== 'linux') {
    console.log('Se omite la prueba de la imagen: usa `docker run --network host`, que solo se comporta así en Linux.');
    return 0;
  }
  const version = docker(['version', '--format', '{{.Server.Version}}']);
  if (version.status !== 0) {
    console.log('Se omite la prueba de la imagen: Docker no está disponible (no hay `docker` o su servicio no responde).');
    return 0;
  }
  console.log(`Docker ${version.stdout.trim()}`);

  image = argImage ?? process.env.IARK_SMOKE_IMAGE ?? '';
  if (!image) {
    image = `${prefix}:build`;
    const dockerfile = process.env.IARK_SMOKE_DOCKERFILE;
    const extra = (process.env.IARK_SMOKE_BUILD_ARGS ?? '').split(/\s+/).filter(Boolean);
    console.log(`Construyendo la imagen (${dockerfile ?? 'Dockerfile'})…`);
    const built = spawnSync('docker', ['build', ...extra, ...(dockerfile ? ['-f', dockerfile] : []), '-t', image, '.'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (built.status !== 0) {
      console.error(`${(built.stderr ?? '').split('\n').slice(-40).join('\n')}\nFALLO: no se pudo construir la imagen.`);
      return 1;
    }
    builtImage = true;
  }
  if (docker(['image', 'inspect', image]).status !== 0) {
    console.error(`FALLO: la imagen «${image}» no existe.`);
    return 1;
  }

  const fake = await startFakeGithub();
  try {
    await scenario('La imagen', async () => {
      const config = JSON.parse(dockerOut(['image', 'inspect', image, '--format', '{{json .Config}}'])) as { User?: string; Env?: string[]; Healthcheck?: { Test?: string[] } };
      check(config.User === 'node', 'corre como el usuario «node» (no root)', `Config.User = ${config.User}`);
      check(!(config.Env ?? []).some((e) => e.startsWith('IARK_WORKSPACE=')), 'no fija IARK_WORKSPACE (la red de seguridad de escuchar sin autenticación sigue puesta)');
      check(Boolean(config.Healthcheck?.Test?.length), 'declara un HEALTHCHECK');
      check((config.Healthcheck?.Test ?? []).join(' ').includes('/healthz'), 'y el HEALTHCHECK consulta /healthz (vivo, sin tocar el disco), no una ruta de la API', JSON.stringify(config.Healthcheck?.Test));
      check(asRoot('/tmp', 'stat -c "%u:%g %a" /data') === '1000:1000 755', '/data existe y es de 1000:1000 (node)');
      console.log(`  info  tamaño: ${(Number(dockerOut(['image', 'inspect', image, '--format', '{{.Size}}'])) / 1e6).toFixed(0)} MB`);
    });

    await scenario('Demo: sin variables, solo API y sitio (docker run … iark-diagrams)', async () => {
      const demo = await startService({ kind: 'demo' });
      await waitHealthy(demo.name);
      check((await get(demo.base, '/api/modules')).status === 200, 'GET /api/modules responde 200');
      check(JSON.stringify((await get(demo.base, '/healthz')).body) === JSON.stringify({ status: 'ok' }), 'GET /healthz responde 200 {"status":"ok"}');
      check((await get(demo.base, '/readyz')).status === 200, 'GET /readyz responde 200 (sin espacio de trabajo ni cuentas no hay disco que comprobar)');
      check((await get(demo.base, '/metrics')).status === 404, 'GET /metrics responde 404: las métricas están apagadas por omisión');
      check((await get(demo.base, '/')).status === 200, 'el sitio se sirve en /');
      check((await get(demo.base, '/api/projects')).status === 404, '/api/projects responde 404 (sin espacio de trabajo no hay proyectos)');
      check(JSON.stringify((await get(demo.base, '/api/auth/providers')).body) === JSON.stringify({ providers: [], tokens: false }), '/api/auth/providers: ninguna forma de entrar');
      check(dockerOut(['exec', demo.name, 'sh', '-c', 'grep ^Uid: /proc/1/status']).split(/\s+/).slice(1, 5).every((u) => u === '1000'), 'el proceso 1 corre con uid 1000 (node)');
      const stop = docker(['stop', demo.name]);
      check(stop.status === 0 && state(demo.name, '{{.State.ExitCode}}') === '0', '`docker stop` lo detiene con código 0');
    });

    await scenario('Se niega a arrancar con un espacio de trabajo y sin autenticación', async () => {
      const refused = await startService({ kind: 'sin-auth', env: { IARK_WORKSPACE: '/data/workspace' }, mounts: [`${newVolume()}:/data`] });
      const { code, output } = await waitExit(refused.name);
      check(code === 2, 'sale con código 2', `código ${code}`);
      check(/sin autenticación/.test(output) && /--accounts/.test(output) && /--tokens/.test(output), 'el mensaje dice por qué y las salidas (--tokens, --accounts, loopback)', output);
    });

    await scenario('Faltan variables de GitHub: el servicio lo dice todo de una vez', async () => {
      const partial = await startService({ kind: 'incompleto', env: { IARK_GITHUB_CLIENT_ID: 'Iv1.algo' } });
      const { code, output } = await waitExit(partial.name);
      check(code === 2, 'sale con código 2', `código ${code}`);
      check(/El inicio de sesión con GitHub necesita todo esto y falta/.test(output) && /IARK_GITHUB_CLIENT_SECRET/.test(output) && /IARK_PUBLIC_URL|--public-url/.test(output), 'lista lo que falta (secreto, dirección pública, espacio de trabajo…)', output);
    });

    await scenario('Secreto por archivo ilegible o vacío (el error de Docker secrets mal permitidos)', async () => {
      const volume = newVolume();
      for (const [kind, file, expected] of [
        ['secreto-root', secretFile(FAKE_CLIENT_SECRET, 'root'), /No se pudo leer el secreto de GitHub de «\/run\/secrets\/github_client_secret» \(EACCES\)/],
        ['secreto-vacio', secretFile('', '1000:1000'), /está vacío/],
      ] as const) {
        const svc = await startService({ kind, env: accountsEnv(fake, 1, { IARK_GITHUB_CLIENT_SECRET_FILE: SECRET_PATH }), mounts: [`${volume}:/data`, `${file}:${SECRET_PATH}:ro`] });
        const { code, output } = await waitExit(svc.name);
        check(code === 2 && expected.test(output), `${kind}: sale con código 2 y dice qué pasa`, `código ${code}\n${output}`);
      }
    });

    await scenario('Client secret equivocado (el error más común al configurar la OAuth App)', async () => {
      const port = await freePort();
      const wrong = secretFile('un-secreto-que-no-es', '1000:1000');
      const svc = await startService({ kind: 'secreto-malo', port, env: accountsEnv(fake, port, { IARK_GITHUB_CLIENT_SECRET_FILE: SECRET_PATH }), mounts: [`${newVolume()}:/data`, `${wrong}:${SECRET_PATH}:ro`] });
      await waitHealthy(svc.name);
      const attempt = await loginWithGithub(svc.base, fake, ADMIN);
      check(!attempt.token && attempt.fragment.get('iark_error') === 'login_failed', 'GitHub rechaza las credenciales: la persona vuelve con #iark_error=login_failed', attempt.fragment.toString());
      const output = logs(svc.name);
      check(!/login_failed|incorrect_client_credentials|GitHub no aceptó/.test(output), 'y el servicio no escribe nada en el registro (por eso la guía lo cuenta aparte)', output);
      docker(['stop', svc.name]);
    });

    // ── el servicio gestionado completo: volumen con nombre, secreto por archivo y las opciones de seguridad del compose ──
    await scenario('Servicio gestionado: volumen con nombre, secreto por archivo y contenedor endurecido', async () => {
      const volume = newVolume();
      const secret = secretFile(FAKE_CLIENT_SECRET, '1000:1000');
      const port = await freePort();
      const start = async (): Promise<{ name: string; base: string }> => {
        // el mismo puerto en cada arranque: la dirección pública (IARK_PUBLIC_URL) lleva el puerto
        const svc = await startService({
          kind: 'cuentas',
          port,
          flags: HARDENED,
          env: accountsEnv(fake, port, { IARK_GITHUB_CLIENT_SECRET_FILE: SECRET_PATH }),
          mounts: [`${volume}:/data`, `${secret}:${SECRET_PATH}:ro`],
          args: ['--trust-proxy', `--cors=${PAGES_ORIGIN}`],
        });
        await waitHealthy(svc.name);
        return svc;
      };
      let svc = await start();
      check(true, 'arranca y el HEALTHCHECK de la imagen pasa a «healthy» con la autenticación activa');
      const startup = logs(svc.name);
      check(/inicio de sesión: GitHub/.test(startup) && startup.includes(`callback http://127.0.0.1:${port}/api/auth/github/callback`) && /solo por invitación/.test(startup), 'el arranque anuncia el inicio de sesión, la «callback URL» y la entrada por invitación', startup);
      check(JSON.stringify((await get(svc.base, '/api/auth/providers')).body) === JSON.stringify({ providers: [{ id: 'github', label: 'GitHub' }], tokens: false, signup: 'invite' }), '/api/auth/providers ofrece GitHub con entrada por invitación');
      check((await get(svc.base, '/api/projects')).status === 401, 'sin sesión, /api/projects responde 401');
      check((await get(svc.base, '/api/modules')).status === 200, 'la API de módulos sigue pública');
      const alive = await fetch(`${svc.base}/healthz`);
      check(alive.status === 200 && JSON.stringify(await alive.json()) === JSON.stringify({ status: 'ok' }) && Boolean(alive.headers.get('x-request-id')), '/healthz responde 200 sin sesión y con X-Request-Id (lo usa el HEALTHCHECK)');
      const ready = await get(svc.base, '/readyz');
      check(ready.status === 200 && ready.body?.status === 'ok' && ready.body?.checks?.workspace === 'ok' && ready.body?.checks?.accounts === 'ok', '/readyz responde 200 sin sesión: la carpeta de trabajo se puede escribir y las cuentas se pueden leer', JSON.stringify(ready.body));
      check(!JSON.stringify(ready.body).includes('/data'), '/readyz no dice ninguna ruta', JSON.stringify(ready.body));

      const login = await loginWithGithub(svc.base, fake, ADMIN);
      const token = login.token;
      check(Boolean(token?.startsWith('iark_s_')) && login.user?.siteRole === 'admin' && login.user?.id !== undefined, 'inicio de sesión completo: la persona de IARK_ADMINS (por id numérico) entra como administradora', JSON.stringify({ fragment: login.fragment.toString(), status: login.callbackStatus, exchange: login.exchangeStatus }));
      if (!token) throw new Error('sin sesión no se puede seguir');
      const who = await get(svc.base, '/api/whoami', token);
      check(who.status === 200 && who.body.user?.login === ADMIN.login, '/api/whoami reconoce la sesión');

      const created = await fetch(`${svc.base}/api/projects`, { method: 'POST', headers: json(token), body: JSON.stringify({ name: 'Tienda' }) });
      const project = (await created.json()) as { id?: string; role?: string };
      check(created.status === 201 && project.id === 'tienda' && project.role === 'admin', 'se crea un proyecto (la persona queda como admin de él)');
      const diagram = await fetch(`${svc.base}/api/projects/tienda/diagrams`, { method: 'POST', headers: json(token), body: JSON.stringify({ module: 'c4', name: 'Banca', text: sample() }) });
      check(diagram.status === 201, 'se guarda un diagrama en él', await diagram.text());

      const visitor = await loginWithGithub(svc.base, fake, VISITA);
      check(!visitor.token && visitor.fragment.get('iark_error') === 'not_invited', 'IARK_SIGNUP=invite: quien no es administradora ni está invitada vuelve con #iark_error=not_invited', visitor.fragment.toString());

      const pages = await loginWithGithub(svc.base, fake, ADMIN, { redirect: `${PAGES_ORIGIN}/iark-diagrams/` });
      check(Boolean(pages.token) && pages.returnedTo === `${PAGES_ORIGIN}/iark-diagrams/`, '--cors: tras entrar se vuelve al sitio de GitHub Pages', `${pages.returnedTo} ${pages.fragment}`);
      const elsewhere = await fetch(`${svc.base}/api/auth/github/login?challenge=${login.challenge}&redirect=${encodeURIComponent('https://otro.example/')}`, { redirect: 'manual' });
      check(elsewhere.status === 400, 'y no a un origen que no se nombró (sin redirección abierta)');
      const preflight = await fetch(`${svc.base}/api/projects`, { method: 'OPTIONS', headers: { Origin: PAGES_ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
      check(preflight.status === 204 && preflight.headers.get('access-control-allow-origin') === PAGES_ORIGIN && /authorization/i.test(preflight.headers.get('access-control-allow-headers') ?? ''), 'el preflight CORS de ese origen pasa (con Authorization)');
      const exchangePreflight = await fetch(`${svc.base}/api/auth/exchange`, { method: 'OPTIONS', headers: { Origin: PAGES_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
      check(exchangePreflight.status === 204 && exchangePreflight.headers.get('access-control-allow-origin') === PAGES_ORIGIN, 'y el de /api/auth/exchange (donde el sitio de Pages cambia el código por la sesión)');

      const exchange = (forwarded: string): Promise<Response> => fetch(`${svc.base}/api/auth/exchange`, { method: 'POST', headers: { ...json(), 'X-Forwarded-For': forwarded }, body: JSON.stringify({ code: 'x', verifier: 'a'.repeat(43) }) });
      for (let i = 0; i < 6; i++) await exchange('203.0.113.7');
      check((await exchange('203.0.113.7')).status === 429, '--trust-proxy: tras varios fallos, esa dirección (X-Forwarded-For) recibe 429');
      check((await exchange('198.51.100.9')).status === 400, 'otra dirección detrás del proxy no queda frenada');
      check((await exchange('198.51.100.9, 203.0.113.7')).status === 429, 'y se usa la última entrada: anteponer otra dirección no sirve para esquivar el freno');

      const files = asRoot(`${volume}`, 'cd /d && stat -c "%u:%g %a %n" . accounts.json workspace && ls workspace/tienda').split('\n');
      check(files[0] === '1000:1000 755 .', 'el volumen con nombre heredó /data de la imagen: dueño 1000:1000', files.join('\n'));
      check(files[1] === '1000:1000 600 accounts.json', 'accounts.json existe, es de node y su modo es 0600', files.join('\n'));
      check(files[2]?.startsWith('1000:1000') && files.length > 3, 'el proyecto está en el volumen (workspace/tienda con sus archivos)', files.join('\n'));
      const accounts = asRoot(volume, 'cat /d/accounts.json');
      check(!accounts.includes(token) && !accounts.includes(FAKE_CLIENT_SECRET) && /"hash"/.test(accounts), 'el archivo de cuentas guarda solo el hash de la sesión, ni la sesión ni el secreto');
      console.log(`  info  ${dockerOut(['exec', svc.name, 'sh', '-c', 'grep -E "VmRSS|Threads" /proc/1/status']).replace(/\s+/g, ' ')}`);

      // reiniciar: la sesión y el proyecto siguen
      const restarted = docker(['restart', svc.name]);
      check(restarted.status === 0, '`docker restart` termina bien', restarted.stderr);
      await waitHealthy(svc.name);
      const after = await get(svc.base, '/api/projects', token);
      check(after.status === 200 && after.body.some?.((p: { id: string }) => p.id === 'tienda'), 'tras reiniciar, la misma sesión sigue valiendo y el proyecto sigue en la lista', JSON.stringify(after));
      check((await get(svc.base, '/api/projects/tienda/diagrams/banca', token)).status === 200, 'y el diagrama se lee');

      // sustituir el contenedor (actualizar la imagen): lo único que sobrevive es el volumen
      noLeaks(svc.name, { 'el secreto de la OAuth App': FAKE_CLIENT_SECRET, 'la sesión': token, 'el código de un solo uso': login.fragment.get('iark_code') ?? undefined });
      const t0 = Date.now();
      const stopped = docker(['stop', svc.name]);
      check(stopped.status === 0 && state(svc.name, '{{.State.ExitCode}}') === '0', `\`docker stop\` lo detiene con código 0 (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      dockerOut(['rm', svc.name]);
      svc = await start();
      const replaced = await get(svc.base, '/api/projects', token);
      check(replaced.status === 200 && replaced.body.some?.((p: { id: string }) => p.id === 'tienda'), 'con un contenedor nuevo sobre el mismo volumen, la sesión y el proyecto siguen', JSON.stringify(replaced));
      check(dockerOut(['exec', svc.name, 'sh', '-c', 'grep ^Uid: /proc/1/status']).split(/\s+/).slice(1, 5).every((u) => u === '1000'), 'sigue corriendo con uid 1000 (node), con el sistema de archivos de solo lectura y sin capacidades');
      // copia de seguridad con el servicio en marcha (lo que explica la guía) y restauración en un volumen nuevo, como en otra máquina
      const backups = newHostDir('copias', 'root');
      const tarball = dockerOut(['run', '--rm', '--user', '0', '-v', `${volume}:/data:ro`, '-v', `${backups}:/backup`, '--entrypoint', 'sh', image, '-c', 'tar czf /backup/iark-data.tar.gz -C /data . && ls -l /backup/iark-data.tar.gz']);
      check(/iark-data\.tar\.gz/.test(tarball), 'la copia de /data con el servicio en marcha se hace (tar en un contenedor aparte, con el volumen en solo lectura)', tarball);
      check(docker(['stop', svc.name]).status === 0, 'se detiene el servicio');
      dockerOut(['rm', svc.name]);
      const restored = newVolume();
      dockerOut(['run', '--rm', '--user', '0', '-v', `${restored}:/data`, '-v', `${backups}:/backup:ro`, '--entrypoint', 'sh', image, '-c', 'tar xzf /backup/iark-data.tar.gz -C /data && chown -R 1000:1000 /data']);
      const fresh = await startService({ kind: 'restaurado', port, flags: HARDENED, env: accountsEnv(fake, port, { IARK_GITHUB_CLIENT_SECRET_FILE: SECRET_PATH }), mounts: [`${restored}:/data`, `${secret}:${SECRET_PATH}:ro`], args: ['--trust-proxy', `--cors=${PAGES_ORIGIN}`] });
      await waitHealthy(fresh.name);
      const back = await get(fresh.base, '/api/projects', token);
      check(back.status === 200 && back.body.some?.((p: { id: string }) => p.id === 'tienda'), 'restaurada en un volumen nuevo, la copia devuelve la sesión y el proyecto', JSON.stringify(back));
      svc = fresh;

      const out = await get(svc.base, '/api/auth/logout', token);
      check(out.status === 405, '/api/auth/logout solo admite POST');
      const closed = await fetch(`${svc.base}/api/auth/logout`, { method: 'POST', headers: json(token) });
      check(closed.status === 200 && (await get(svc.base, '/api/whoami', token)).status === 401, 'cerrar sesión la invalida (401 después)');
      noLeaks(svc.name, { 'la sesión': token });
    });

    // ── bind mount: el dueño de la carpeta del anfitrión decide ──
    await scenario('Bind mount de una carpeta del anfitrión (secreto por variable, entrada abierta, sin --cors)', async () => {
      const port = await freePort();
      const env = (extra: Record<string, string> = {}): Record<string, string> => accountsEnv(fake, port, { IARK_GITHUB_CLIENT_SECRET: FAKE_CLIENT_SECRET, ...extra });

      const rootDir = newHostDir('bind-root', 'root');
      const denied = await startService({ kind: 'bind-root', port, env: env(), mounts: [`${rootDir}:/data`] });
      const refused = await waitExit(denied.name);
      check(refused.code !== 0 && /No se pudo escribir el archivo de cuentas «\/data\/accounts\.json» \(EACCES\)/.test(refused.output), 'con una carpeta de root el servicio no arranca y dice que no puede escribir el archivo de cuentas (EACCES)', `código ${refused.code}\n${refused.output}`);

      const dir = newHostDir('bind-1000', '1000:1000');
      const svc = await startService({ kind: 'bind', port, env: env({ IARK_SIGNUP: 'open' }), mounts: [`${dir}:/data`], args: ['--trust-proxy', '--cors='] });
      await waitHealthy(svc.name);
      check(true, 'con la carpeta de 1000:1000 arranca y el HEALTHCHECK pasa a «healthy» (también con --cors= vacío, como lo pasa el compose sin IARK_CORS)');
      check((await get(svc.base, '/api/auth/providers')).body.signup === 'open', 'IARK_SIGNUP=open se nota en /api/auth/providers');
      const login = await loginWithGithub(svc.base, fake, VISITA);
      check(Boolean(login.token) && login.user?.siteRole === 'member', 'con la entrada abierta, cualquiera con cuenta de GitHub entra como miembro', login.fragment.toString());
      if (!login.token) throw new Error('sin sesión no se puede seguir');
      const created = await fetch(`${svc.base}/api/projects`, { method: 'POST', headers: json(login.token), body: JSON.stringify({ name: 'Mi proyecto' }) });
      check(created.status === 201, 'crea un proyecto', await created.text());
      const preflight = await fetch(`${svc.base}/api/projects`, { method: 'OPTIONS', headers: { Origin: PAGES_ORIGIN, 'Access-Control-Request-Method': 'GET' } });
      check(!preflight.headers.get('access-control-allow-origin'), 'sin --cors, ningún origen ajeno recibe Access-Control-Allow-Origin');
      const listing = asRoot(dir, 'cd /d && stat -c "%u:%g %a %n" accounts.json workspace workspace/* && ls workspace/mi-proyecto').split('\n');
      check(listing.slice(0, 3).every((l) => l.startsWith('1000:1000')) && listing.length > 3, 'los archivos quedan en la carpeta del anfitrión, de 1000:1000', listing.join('\n'));
      console.log(`  info  el secreto por variable se ve con «docker inspect» (por eso el compose usa Docker secrets): ${state(svc.name, '{{json .Config.Env}}').includes(FAKE_CLIENT_SECRET) ? 'sí se ve' : 'no se ve'}`);
      noLeaks(svc.name, { 'el secreto de la OAuth App': FAKE_CLIENT_SECRET, 'la sesión': login.token, 'el código de un solo uso': login.fragment.get('iark_code') ?? undefined });
      check(docker(['stop', svc.name]).status === 0 && state(svc.name, '{{.State.ExitCode}}') === '0', '`docker stop` lo detiene con código 0');
    });
    // ── plataformas que montan el disco con dueño root: la imagen construida con `--build-arg IARK_RUN_AS=root` corre como root ──
    await scenario('Disco con dueño root (lo que da `--build-arg IARK_RUN_AS=root`, probado aquí con --user 0)', async () => {
      const port = await freePort();
      const dir = newHostDir('root-disk', 'root');
      const svc = await startService({ kind: 'root', port, flags: ['--user', '0'], env: accountsEnv(fake, port, { IARK_GITHUB_CLIENT_SECRET: FAKE_CLIENT_SECRET }), mounts: [`${dir}:/data`], args: ['--trust-proxy'] });
      await waitHealthy(svc.name);
      const login = await loginWithGithub(svc.base, fake, ADMIN);
      check(Boolean(login.token), 'con el servicio como root, el disco de root sirve: inicio de sesión completo', login.fragment.toString());
      if (!login.token) throw new Error('sin sesión no se puede seguir');
      const created = await fetch(`${svc.base}/api/projects`, { method: 'POST', headers: json(login.token), body: JSON.stringify({ name: 'En disco de root' }) });
      check(created.status === 201, 'y guarda proyectos en él', await created.text());
      check(asRoot(dir, 'stat -c "%u:%g" /d/accounts.json') === '0:0', 'los archivos son de root (por eso es el último recurso: solo cuando la plataforma no deja cambiar el dueño del disco)');
    });
  } finally {
    await fake.stop();
    cleanup();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} comprobaciones correctas, ${failed.length} con fallo.`);
  return failed.length === 0 ? 0 : 1;
}

/** Un diagrama C4 de verdad (examples/banca.json) para guardarlo en el proyecto. */
function sample(): string {
  return readFileSync(new URL('../examples/banca.json', import.meta.url), 'utf8');
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    cleanup();
    process.exit(1);
  },
);
