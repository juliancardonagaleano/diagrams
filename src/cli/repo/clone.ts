import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, stat } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliError } from '../io';
import { redactSecrets } from './redact';
import { isValidRepoRef, REF_ERROR } from './source';

/**
 * Clonado de un repositorio remoto a un directorio temporal, para que el escáner lo lea como una carpeta cualquiera.
 *
 * Este es el ÚNICO sitio de `--from-repo` que ejecuta un programa, y ejecuta UNO solo: `git clone`, con un arreglo de argumentos
 * (nunca a través de un intérprete de comandos), `--` antes de la URL y las opciones que quitan a un repositorio hostil
 * cualquier forma de ejecutar código en tu equipo:
 *  - `--template=` (vacía): no se copian hooks de plantillas; `core.hooksPath=/dev/null`: tampoco los de la configuración.
 *  - `core.fsmonitor=false`: no se lanza ningún monitor de archivos.
 *  - `protocol.allow=never` y solo `https` y `ssh` en `always` (y lo mismo en `GIT_ALLOW_PROTOCOL`, que manda sobre la
 *    configuración): ni `file`, ni `git`, ni `ext::` ni un `http` al que una redirección intente bajarnos.
 *  - `--depth 1 --single-branch --no-tags --no-recurse-submodules`: un solo commit de una sola rama, sin etiquetas ni submódulos
 *    (los submódulos no se siguen: serían otros repositorios, con otras URL).
 *  - `GIT_TERMINAL_PROMPT=0`: git falla en lugar de quedarse pidiendo una contraseña; y el proceso va en una sesión propia, sin
 *    terminal de control, así que ssh tampoco puede preguntar nada (falla). No se desactivan las credenciales de git (gestor de
 *    credenciales, `credential.helper`) ni la configuración de ssh (claves, ssh-agent, `~/.ssh/config`): son las del usuario y
 *    por eso funcionan los repositorios privados. DIAgrams no las lee, no las guarda y no las muestra.
 *  - `GIT_LFS_SKIP_SMUDGE=1`: los archivos de Git LFS se quedan como punteros (no se descargan).
 *
 * Después del clonado NO se ejecuta nada más dentro del clon (ni git ni nada del repositorio): se lee con el escáner de
 * carpetas, que ya ignora `.git`. El directorio temporal se borra siempre: al terminar, si falla el clonado o el escaneo, y
 * cuando llega SIGINT, SIGTERM o SIGHUP.
 */

export const DEFAULT_CLONE_TIMEOUT_MS = 120_000;

/** Prefijo del directorio temporal del clon (bajo `os.tmpdir()`): lo que no debe quedar jamás tras un comando. */
export const CLONE_DIR_PREFIX = 'iark-clone-';

/** Protocolos que se permiten (y solo ellos). */
export const CLONE_PROTOCOLS: readonly string[] = ['https', 'ssh'];

export interface CloneRequest {
  /** La URL ya validada por `classifyRepoSource`. */
  url: string;
  /** Rama o etiqueta (`--repo-ref`). */
  ref?: string;
}

/**
 * Puntos de inyección que SOLO existen para las pruebas (el CLI no pasa nunca ninguno ni los lee de opciones o del entorno):
 * un `git` falso o un protocolo local permiten probar un clon real sin la red.
 */
export interface CloneTestHooks {
  /** Ejecutable de git (por defecto `git`, resuelto con el PATH). */
  gitPath?: string;
  /** Protocolos permitidos (por defecto `https` y `ssh`). */
  protocols?: readonly string[];
  /** Carpeta bajo la que se crea el directorio temporal (por defecto `os.tmpdir()`). */
  tmpRoot?: string;
  /** Entorno de partida (por defecto `process.env`). */
  env?: NodeJS.ProcessEnv;
}

export interface CloneOptions extends CloneTestHooks {
  /** Tiempo máximo del clonado en ms (por defecto 120 s). */
  timeoutMs?: number;
}

const FORBIDDEN = /[\u0000-\u0020\u007f-\u009f]/;

/** Última barrera antes de ejecutar: lo que llegue aquí ya pasó por `classifyRepoSource`, pero se vuelve a comprobar. */
function assertSafeRequest(request: CloneRequest): void {
  if (!request.url || FORBIDDEN.test(request.url) || request.url.startsWith('-')) throw new CliError('La URL del repositorio no es válida.', 2);
  if (request.ref !== undefined && !isValidRepoRef(request.ref)) throw new CliError(REF_ERROR, 2);
}

/** Los argumentos de `git` para el clonado, en el orden exacto en que se pasan (sin shell, cada uno va como un argumento aparte). */
export function buildCloneArgs(request: CloneRequest, dest: string, protocols: readonly string[] = CLONE_PROTOCOLS): string[] {
  assertSafeRequest(request);
  return [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
    '-c', 'protocol.allow=never',
    ...protocols.flatMap((p) => ['-c', `protocol.${p}.allow=always`]),
    '-c', 'advice.detachedHead=false',
    'clone',
    '--quiet',
    '--depth', '1',
    '--single-branch',
    '--no-tags',
    '--no-recurse-submodules',
    '--template=',
    ...(request.ref !== undefined ? [`--branch=${request.ref}`] : []),
    '--',
    request.url,
    dest,
  ];
}

/** Variables de git que redirigirían el clonado a otro repositorio o árbol de trabajo (si el usuario las tiene definidas). */
const REDIRECTING_GIT_ENV = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_TEMPLATE_DIR']);

/** El entorno del clonado: el del usuario (credenciales, ssh, proxy) más lo que lo hace seguro y sin preguntas. */
export function buildCloneEnv(base: NodeJS.ProcessEnv, protocols: readonly string[] = CLONE_PROTOCOLS, ceiling: string = tmpdir()): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !REDIRECTING_GIT_ENV.has(key.toUpperCase())) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_ALLOW_PROTOCOL = protocols.join(':');
  env.GIT_LFS_SKIP_SMUDGE = '1';
  env.GIT_CEILING_DIRECTORIES = ceiling;
  // Mensajes de git en inglés: así se reconocen para traducir el motivo del fallo.
  env.LC_ALL = 'C';
  env.LANGUAGE = 'C';
  return env;
}

/** Quita de lo que dijo git (o ssh) lo que no debe llegar a la pantalla: credenciales en URL, secretos, rutas temporales, controles. */
export function sanitizeGitOutput(text: string, hide: string[] = []): string {
  let out = text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
  out = out.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/]*@/g, '$1');
  for (const path of hide) if (path) out = out.split(path).join('[directorio temporal]');
  out = redactSecrets(out).text;
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const tail = lines.slice(-6).join('\n');
  return tail.length > 600 ? `${tail.slice(0, 600)}…` : tail;
}

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  timedOut: boolean;
  spawnError?: NodeJS.ErrnoException;
}

const MAX_STDERR = 16 * 1024;

/** Mata el proceso de git y todo lo que haya lanzado (ssh, git-remote-https…): van en su propio grupo de procesos. */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* ya terminó */
    }
  }
}

function runGit(gitPath: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, track: (child: ChildProcess | undefined) => void): Promise<RunResult> {
  return new Promise((resolve) => {
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let hardStop: NodeJS.Timeout | undefined;
    const finish = (result: Omit<RunResult, 'stderr' | 'timedOut'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardStop);
      track(undefined);
      resolve({ ...result, stderr, timedOut });
    };
    // Sin shell. En sesión propia (sin terminal de control) para que ni git ni ssh puedan preguntar nada, y para poder matar el grupo entero.
    const child = spawn(gitPath, args, { cwd, env, stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    track(child);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR);
    });
    child.once('error', (error) => finish({ code: null, signal: null, spawnError: error as NodeJS.ErrnoException }));
    child.once('close', (code, signal) => finish({ code, signal }));
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGTERM');
      // Si git no cae con SIGTERM, a la fuerza; y si aun así no cierra sus tuberías, no se espera más.
      hardStop = setTimeout(() => {
        killTree(child, 'SIGKILL');
        hardStop = setTimeout(() => finish({ code: null, signal: 'SIGKILL' }), 1500);
      }, 2000);
    }, timeoutMs);
  });
}

/** Traduce el fallo de git a un mensaje en español (y sin credenciales ni rutas del equipo). */
export function describeCloneFailure(result: Pick<RunResult, 'code' | 'signal' | 'stderr' | 'timedOut' | 'spawnError'>, request: CloneRequest & { display?: string }, timeoutMs: number, hide: string[] = []): string {
  const what = request.display ?? request.url;
  if (result.spawnError) {
    if (result.spawnError.code === 'ENOENT') return 'No se encontró git en este equipo (o no está en el PATH): instálalo para usar --from-repo con una URL, o clona el repositorio tú y pasa su carpeta.';
    return `No se pudo ejecutar git: ${sanitizeGitOutput(result.spawnError.message, hide)}`;
  }
  if (result.timedOut) return `El clonado de «${what}» superó el tiempo máximo (${Math.round(timeoutMs / 1000)} s) y se canceló: el repositorio es muy grande o la red muy lenta. Clónalo tú (git clone --depth 1) y pasa su carpeta.`;
  const log = result.stderr;
  if (/Remote branch .* not found|Could not find remote branch|couldn't find remote ref|not found in upstream origin/i.test(log)) {
    return request.ref ? `La rama o etiqueta «${request.ref}» no existe en «${what}».` : `No se encontró la rama por defecto de «${what}» (¿el repositorio está vacío?).`;
  }
  if (/cannot run ssh|ssh: command not found|error: cannot spawn ssh/i.test(log)) {
    return `git no encuentra el cliente ssh (OpenSSH) para clonar «${what}»: instálalo, o usa una URL https:// (con el gestor de credenciales de git si el repositorio es privado).`;
  }
  if (/Host key verification failed/i.test(log)) {
    return `La clave del servidor ssh de «${what}» no está en tu known_hosts (o ha cambiado): conéctate una vez con ssh para aceptarla o añádela con ssh-keyscan; DIAgrams no responde a esa pregunta por ti.`;
  }
  if (/Authentication failed|could not read (?:Username|Password)|terminal prompts disabled|Permission denied|returned error: 40[13]|HTTP 40[13]|publickey|Access denied|invalid credentials|requested URL returned error: 401|SSL certificate problem|self[- ]signed/i.test(log)) {
    if (/SSL certificate problem|self[- ]signed/i.test(log)) return `No se pudo verificar el certificado TLS de «${what}» (certificado caducado, autofirmado o de una autoridad desconocida).`;
    return `No se pudo autenticar en «${what}»: el repositorio es privado o no tienes acceso. DIAgrams usa las credenciales que ya tengas en git (gestor de credenciales) o en ssh (claves, ssh-agent) y nunca pregunta contraseñas: configúralas, prueba \`git ls-remote\` con esa URL, o usa otra forma de la URL (ssh en vez de https).`;
  }
  if (/Repository not found|repository .* not found|does not appear to be a git repository|returned error: 404|HTTP 404/i.test(log)) {
    return `El repositorio «${what}» no existe o no tienes acceso (si es privado, git necesita tus credenciales: ver --help).`;
  }
  if (/Could not resolve host|Could not resolve hostname|Name or service not known|Temporary failure in name resolution|Network is unreachable|Connection (?:timed out|refused|reset)|Failed to connect|Operation timed out|No route to host|unable to access/i.test(log)) {
    return `No se pudo conectar con «${what}»: sin red, host inexistente o servidor inaccesible.`;
  }
  const tail = sanitizeGitOutput(log, hide);
  return `git no pudo clonar «${what}»${result.signal ? ` (señal ${result.signal})` : result.code !== null ? ` (código ${result.code})` : ''}${tail ? `:\n${tail}` : '.'}`;
}

const SIGNAL_CODES: Record<string, number> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

/**
 * Clona `request` a un directorio temporal nuevo, ejecuta `use` con la carpeta del clon y SIEMPRE borra el directorio (también
 * si el clonado o `use` fallan, o llega una señal de terminación). Lanza `CliError` (código 2) con un mensaje claro si git no
 * está, falla la autenticación, no existe el repositorio o la rama, no hay red o se agota el tiempo.
 */
export async function withClonedRepo<T>(request: CloneRequest & { display?: string }, use: (folder: string) => T | Promise<T>, options: CloneOptions = {}): Promise<T> {
  const protocols = options.protocols ?? CLONE_PROTOCOLS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS;
  const parent = options.tmpRoot ?? tmpdir();
  const root = await mkdtemp(join(parent, CLONE_DIR_PREFIX));
  const dest = join(root, 'repo');

  let child: ChildProcess | undefined;
  const cleanup = (): void => {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* se intenta de nuevo en `exit` */
    }
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    if (child) killTree(child, 'SIGKILL');
    cleanup();
    process.exit(SIGNAL_CODES[signal] ?? 1);
  };
  const onSigint = (): void => onSignal('SIGINT');
  const onSigterm = (): void => onSignal('SIGTERM');
  const onSighup = (): void => onSignal('SIGHUP');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  process.on('SIGHUP', onSighup);
  process.on('exit', cleanup);

  try {
    const args = buildCloneArgs(request, dest, protocols);
    const env = buildCloneEnv(options.env ?? process.env, protocols, parent);
    const result = await runGit(options.gitPath ?? 'git', args, root, env, timeoutMs, (c) => {
      child = c;
    });
    if (result.spawnError || result.timedOut || result.code !== 0) {
      throw new CliError(describeCloneFailure(result, request, timeoutMs, [root]), 2);
    }
    try {
      if (!(await stat(dest)).isDirectory()) throw new Error('no es una carpeta');
    } catch {
      throw new CliError(`git terminó sin error pero no dejó el clon de «${request.display ?? request.url}».`, 2);
    }
    return await use(dest);
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    process.off('SIGHUP', onSighup);
    process.off('exit', cleanup);
    if (child) killTree(child, 'SIGKILL');
    cleanup();
  }
}
