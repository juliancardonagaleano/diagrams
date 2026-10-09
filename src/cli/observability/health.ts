import { randomBytes } from 'node:crypto';
import { access, constants, open, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Salud de `iark serve`:
 *
 *  - `GET /healthz` (**vivo**): 200 `{"status":"ok"}` mientras el proceso atienda conexiones. Sin autenticación, sin detalles y sin tocar el disco
 *    ni el pool: es lo que mira el `HEALTHCHECK` de la imagen, y no depende de nada que pueda estar roto (un `HEALTHCHECK` que consultara el disco
 *    haría que Docker o una plataforma dieran por muerto un servicio que solo tiene un problema pasajero con un archivo).
 *  - `GET /readyz` (**listo**): 200 si puede hacer su trabajo y 503 si no, con el nombre de cada comprobación y `ok` o `fail`, sin rutas ni
 *    secretos: `{"status":"ok","checks":{"workspace":"ok","tokens":"ok","accounts":"ok","compute":"ok"}}`. Solo salen las comprobaciones que el
 *    servicio tiene (sin `--workspace` no hay `workspace`). Es para un balanceador o un monitor externo.
 *
 * Una comprobación de disco es un trabajo de verdad (crear y borrar un archivo): por eso `/readyz` **cachea** su resultado unos segundos (varias
 * peticiones a la vez comparten una sola ronda) y cada comprobación tiene un tiempo máximo. Así no es un vector de carga ni se cuelga con un
 * disco de red atascado. Cuando una comprobación cambia de estado se anota una línea en stderr (con su nombre; nunca con rutas).
 */

export type CheckState = 'ok' | 'fail';

export interface ReadyReport {
  ok: boolean;
  checks: Record<string, CheckState>;
}

export type Check = () => boolean | Promise<boolean>;

export interface ReadinessOptions {
  /** Cuánto se reutiliza un resultado (ms). Por omisión 5000; 0 = siempre se vuelve a comprobar (pruebas). */
  cacheMs?: number;
  /** Tiempo máximo de cada comprobación (ms). Por omisión 2000. */
  timeoutMs?: number;
  /** Dónde van los avisos de cambio de estado. Por omisión, stderr. */
  warn?: (message: string) => void;
  now?: () => number;
}

export class Readiness {
  private cached: { at: number; report: ReadyReport } | undefined;
  private running: Promise<ReadyReport> | undefined;
  private readonly states = new Map<string, CheckState>();
  private readonly cacheMs: number;
  private readonly timeoutMs: number;
  private readonly warn: (message: string) => void;
  private readonly now: () => number;

  constructor(
    private readonly checks: Readonly<Record<string, Check>>,
    options: ReadinessOptions = {},
  ) {
    this.cacheMs = options.cacheMs ?? 5000;
    this.timeoutMs = options.timeoutMs ?? 2000;
    this.warn = options.warn ?? ((message) => void process.stderr.write(`${message}\n`));
    this.now = options.now ?? ((): number => Date.now());
  }

  async status(): Promise<ReadyReport> {
    if (this.cached && this.now() - this.cached.at < this.cacheMs) return this.cached.report;
    this.running ??= this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async run(): Promise<ReadyReport> {
    const names = Object.keys(this.checks);
    const states = await Promise.all(names.map((name) => this.check(name)));
    const checks: Record<string, CheckState> = {};
    names.forEach((name, index) => {
      checks[name] = states[index];
      const before = this.states.get(name);
      if (before !== states[index]) {
        this.states.set(name, states[index]);
        if (states[index] === 'fail') this.warn(`aviso: la comprobación de salud «${name}» falla: /readyz responde 503 hasta que vuelva a pasar.`);
        else if (before === 'fail') this.warn(`aviso: la comprobación de salud «${name}» vuelve a pasar.`);
      }
    });
    const report: ReadyReport = { ok: states.every((state) => state === 'ok'), checks };
    this.cached = { at: this.now(), report };
    return report;
  }

  private async check(name: string): Promise<CheckState> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const limit = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), this.timeoutMs);
        timer.unref();
      });
      return (await Promise.race([Promise.resolve().then(this.checks[name]), limit])) ? 'ok' : 'fail';
    } catch {
      return 'fail';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * ¿Se puede escribir en esta carpeta? Una sonda de verdad: crea un archivo temporal (oculto, que nadie confunde con un proyecto), escribe y lo
 * borra. `access(W_OK)` no basta: no detecta un disco lleno, un volumen de solo lectura montado encima ni los permisos de un sistema de archivos
 * de red. Si la carpeta aún no existe (el espacio de trabajo se crea con el primer proyecto), se sondea la carpeta existente más cercana por
 * encima, que es donde se crearía.
 */
export async function directoryWritable(directory: string): Promise<boolean> {
  let dir = directory;
  for (;;) {
    try {
      if ((await stat(dir)).isDirectory()) break;
      return false;
    } catch (error) {
      const parent = dirname(dir);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === dir) return false;
      dir = parent;
    }
  }
  const probe = join(dir, `.iark-ready-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  try {
    const handle = await open(probe, 'wx', 0o600);
    try {
      await handle.write('ok');
    } finally {
      await handle.close();
    }
    return true;
  } catch {
    return false;
  } finally {
    await unlink(probe).catch(() => undefined);
  }
}

/** ¿Es un archivo normal y se puede leer? (El archivo de cuentas.) */
export async function fileReadable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
