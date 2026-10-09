import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToken, revokeToken } from '../../src/cli/tokens';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, startFakeGithub, type FakeGithub, type FakeProfile } from '../helpers/fakeGithub';

/**
 * Un `iark serve --workspace <carpeta temporal>` de verdad para las pruebas e2e de «guardar en la nube»: el CLI real
 * (con `tsx`, que resuelve los alias del repositorio sin compilar nada), en un puerto libre que elige el propio sistema
 * (`-p 0`) y con `--cors <origen de la prueba>`. Cada prueba arranca el suyo y lo para al terminar, así que no queda
 * ningún puerto ocupado ni estado compartido entre pruebas.
 */
export interface CloudServer {
  /** `http://127.0.0.1:<puerto>`. */
  url: string;
  /** La carpeta de trabajo (la fuente de verdad: un directorio por proyecto). */
  workspace: string;
  /** Con `tokens`: el token de cada persona (por nombre). */
  tokens: Record<string, string>;
  /** Revoca el token de una persona en el archivo (el servidor lo nota en la siguiente petición). */
  revoke(name: string): void;
  stop(): Promise<void>;
}

export async function startCloudServer(options: { cors?: string; people?: Array<{ name: string; role: 'viewer' | 'editor' | 'admin' }>; env?: Record<string, string> } = {}): Promise<CloudServer> {
  const workspace = mkdtempSync(join(tmpdir(), 'iark-e2e-nube-'));
  const args = ['node_modules/tsx/dist/cli.mjs', 'src/cli/index.ts', 'serve', '--workspace', workspace, '-p', '0'];
  if (options.cors) args.push('--cors', options.cors);
  // Con personas, el servidor pide token: el archivo de tokens va fuera de la carpeta de trabajo (que es lo que se comparte).
  const tokenDir = options.people ? mkdtempSync(join(tmpdir(), 'iark-e2e-tokens-')) : undefined;
  const tokenFile = tokenDir ? join(tokenDir, 'tokens.json') : undefined;
  const tokens: Record<string, string> = {};
  for (const person of options.people ?? []) tokens[person.name] = createToken(tokenFile!, person).token;
  if (tokenFile) args.push('--tokens', tokenFile);
  const child: ChildProcess = spawn(process.execPath, args, { cwd: process.cwd(), env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`El servidor no arrancó en 30 s:\n${output}`)), 30_000);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const found = /escuchando en (http:\/\/[^\s]+?)(?: \(|\s|$)/.exec(output);
      if (found) {
        clearTimeout(timer);
        resolve(found[1]);
      }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`El servidor terminó (código ${code}) antes de escuchar:\n${output}`));
    });
  });
  return {
    url,
    workspace,
    tokens,
    revoke(name: string) {
      if (tokenFile) revokeToken(tokenFile, name);
    },
    async stop() {
      if (child.exitCode === null) {
        await new Promise<void>((resolve) => {
          child.once('exit', () => resolve());
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 5000).unref();
        });
      }
      rmSync(workspace, { recursive: true, force: true });
      if (tokenDir) rmSync(tokenDir, { recursive: true, force: true });
    },
  };
}

/**
 * Un servicio gestionado de verdad para las pruebas del inicio de sesión: `iark serve --workspace <carpeta> --accounts <archivo>` con una OAuth App
 * que apunta a un GitHub de mentira (`startFakeGithub`, cuya pantalla de autorización acepta al instante, así que sirve a un navegador real).
 * `--public-url` y `--cors` llevan direcciones que hay que conocer antes de arrancar, así que el puerto no es `0`: se elige uno libre de antemano.
 * Cada prueba arranca el suyo (servidor, GitHub de mentira y carpetas) y lo para al terminar.
 */
export interface ManagedCloud {
  /** `http://127.0.0.1:<puerto>`: la dirección pública del servicio y la que se escribe en «Dirección del servidor». */
  url: string;
  workspace: string;
  /** El archivo donde el servicio guarda las cuentas (`cuentas.json` o, con el almacén `sqlite`, `cuentas.db`). */
  accounts: string;
  github: FakeGithub;
  /** Apaga el servicio y lo vuelve a arrancar en el mismo puerto, con las mismas cuentas y carpetas: lo que se guardó tiene que seguir ahí. */
  restart(): Promise<void>;
  /** La próxima persona que «acepte» en GitHub (el que inicie sesión a continuación entra como ella). */
  signInAs(profile: FakeProfile): void;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = (probe.address() as { port: number });
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Qué almacén guarda las cuentas del servicio gestionado de las pruebas: el que pida la prueba o, si no, `json` (el de siempre);
 * con `IARK_TEST_ACCOUNTS_STORE=sqlite` en el entorno, todas las pruebas que no piden otro corren con SQLite.
 */
const defaultStore = (): 'json' | 'sqlite' => (process.env.IARK_TEST_ACCOUNTS_STORE === 'sqlite' ? 'sqlite' : 'json');

export async function startManagedCloud(options: { cors: string; admins?: FakeProfile[]; signup?: 'open' | 'invite'; store?: 'json' | 'sqlite' }): Promise<ManagedCloud> {
  const github = await startFakeGithub();
  const dir = mkdtempSync(join(tmpdir(), 'iark-e2e-gestionada-'));
  const workspace = join(dir, 'espacio');
  const store = options.store ?? defaultStore();
  const accounts = join(dir, store === 'sqlite' ? 'cuentas.db' : 'cuentas.json');
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const admins = (options.admins ?? []).map((admin) => String(admin.id)).join(',');
  const args = [
    'node_modules/tsx/dist/cli.mjs', 'src/cli/index.ts', 'serve',
    '--workspace', workspace, '--accounts', accounts, '--accounts-store', store,
    '--github-client-id', FAKE_CLIENT_ID, '--public-url', url, '--cors', options.cors,
    '--signup', options.signup ?? 'invite', '--host', '127.0.0.1', '-p', String(port),
  ];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // lo de la suite que pudiera haber en el entorno de quien corre las pruebas no debe colarse
    IARK_TOKENS: '', IARK_WORKSPACE: '', IARK_ACCOUNTS: '', IARK_ACCOUNTS_STORE: '', IARK_ACCOUNTS_IMPORT: '', IARK_GITHUB_CLIENT_ID: '', IARK_PUBLIC_URL: '', IARK_SIGNUP: '', IARK_GITHUB_CLIENT_SECRET_FILE: '',
    IARK_GITHUB_URL: github.url, IARK_GITHUB_API_URL: github.url, IARK_GITHUB_CLIENT_SECRET: FAKE_CLIENT_SECRET, IARK_ADMINS: admins,
  };

  /** Arranca el servicio y espera a que escuche. */
  async function launch(): Promise<ChildProcess> {
    const child: ChildProcess = spawn(process.execPath, args, { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`El servidor no arrancó en 30 s:\n${output}`)), 30_000);
        const onData = (chunk: Buffer): void => {
          output += chunk.toString();
          if (/escuchando en http:\/\//.test(output)) {
            clearTimeout(timer);
            resolve();
          }
        };
        child.stdout!.on('data', onData);
        child.stderr!.on('data', onData);
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`El servidor terminó (código ${code}) antes de escuchar:\n${output}`));
        });
      });
    } catch (error) {
      child.kill('SIGKILL');
      throw error;
    }
    return child;
  }
  const halt = async (child: ChildProcess): Promise<void> => {
    if (child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    });
  };

  let child: ChildProcess;
  try {
    child = await launch();
  } catch (error) {
    await github.stop();
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    url,
    workspace,
    accounts,
    github,
    signInAs: (profile) => github.signInAs(profile),
    async restart() {
      await halt(child);
      child = await launch();
    },
    async stop() {
      await halt(child);
      await github.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
