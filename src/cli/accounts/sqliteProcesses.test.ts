import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROCESS_TEST_TIMEOUT } from '../../../tests/helpers/cliBundle';
import { loadSqlite, MIGRATIONS, SqliteAccountStore } from './sqliteStore';
import { MAX_PENDING_USERS, MAX_SESSIONS_PER_USER } from './store';

// Varios procesos de verdad (no varias conexiones de uno) sobre el mismo archivo SQLite: lo que promete el almacén transaccional.
// Cada proceso es `tests/helpers/sqliteWorker.ts`, lanzado con `node --import tsx`.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT });

const WORKER = resolve('tests/helpers/sqliteWorker.ts');

interface Outcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Una línea por operación confirmada: `{ ok: true }` o `{ error: <código> }`. */
  lines: Array<{ ok?: true; ready?: true; error?: string }>;
  stderr: string;
}

const folders: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'iark-sqlite-procs-'));
  folders.push(dir);
  return dir;
};

function launch(mode: string, path: string, count: number, key = 'w'): { child: ChildProcess; done: Promise<Outcome>; seen: () => number } {
  const child = spawn(process.execPath, ['--import', 'tsx', WORKER, mode, path, String(count), key], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const done = new Promise<Outcome>((resolveOutcome) => {
    child.once('close', (code, signal) => {
      // Una línea cortada por un SIGKILL a mitad de escritura no cuenta: solo las completas.
      const complete = out.split('\n').slice(0, -1).filter(Boolean);
      resolveOutcome({ code, signal, lines: complete.map((line) => JSON.parse(line) as Outcome['lines'][number]), stderr });
    });
  });
  return { child, done, seen: () => out.split('\n').length - 1 };
}

/** Lanza `processes` procesos a la vez con el mismo trabajo y espera a todos. */
async function race(mode: string, path: string, processes: number, count: number, key?: (index: number) => string): Promise<Outcome[]> {
  const runs = Array.from({ length: processes }, (_, index) => launch(mode, path, count, key?.(index)));
  return Promise.all(runs.map((run) => run.done));
}

const expectClean = (outcomes: Outcome[]): void => {
  for (const outcome of outcomes) {
    expect(outcome.stderr, 'stderr del proceso').toBe('');
    expect(outcome.code).toBe(0);
    expect(outcome.lines.every((line) => line.ok || line.error === 'limit' || line.error === 'conflict')).toBe(true);
  }
};

const countOf = (outcomes: Outcome[], pick: (line: Outcome['lines'][number]) => boolean): number => outcomes.reduce((total, outcome) => total + outcome.lines.filter(pick).length, 0);

/** Una conexión de solo lectura a la base, para mirarla desde fuera de los procesos. */
function inspect<T>(path: string, read: (query: (sql: string) => Array<Record<string, unknown>>) => T): T {
  const db = new (loadSqlite().DatabaseSync)(path, { readOnly: true });
  try {
    return read((sql) => db.prepare(sql).all() as Array<Record<string, unknown>>);
  } finally {
    db.close();
  }
}

describe('SqliteAccountStore entre procesos (varios procesos, una base)', () => {
  it('el tope de invitaciones sin aceptar se respeta aunque lo disputen cuatro procesos: ni una más ni una menos', async () => {
    const path = join(tmp(), 'cuentas.db');
    SqliteAccountStore.open(path).close(); // el esquema, creado una vez antes de la carrera
    // 4 procesos x 150 invitaciones distintas = 600 intentos para 500 plazas.
    const outcomes = await race('invite', path, 4, 150, (index) => `p${index}`);
    expectClean(outcomes);
    expect(countOf(outcomes, (line) => line.ok === true)).toBe(MAX_PENDING_USERS);
    expect(countOf(outcomes, (line) => line.error === 'limit')).toBe(600 - MAX_PENDING_USERS);
    inspect(path, (query) => {
      expect(query('SELECT count(*) AS n FROM users WHERE github_id IS NULL')[0]?.n).toBe(MAX_PENDING_USERS);
      expect(query('PRAGMA integrity_check')[0]?.integrity_check).toBe('ok');
    });
  });

  it('la misma persona que entra a la vez por cuatro procesos acaba con una sola cuenta (nunca duplicada)', async () => {
    const path = join(tmp(), 'cuentas.db');
    SqliteAccountStore.open(path).close();
    const outcomes = await race('signin', path, 4, 60);
    expectClean(outcomes);
    expect(countOf(outcomes, (line) => line.ok === true)).toBe(4 * 60);
    inspect(path, (query) => {
      expect(query('SELECT count(*) AS n FROM users')[0]?.n).toBe(60);
      expect(query('SELECT count(DISTINCT github_id) AS n FROM users')[0]?.n).toBe(60);
      expect(query('SELECT count(DISTINCT login_key) AS n FROM users')[0]?.n).toBe(60);
    });
  });

  it('el tope de sesiones por cuenta se respeta con cuatro procesos abriendo sesiones a la vez', async () => {
    const path = join(tmp(), 'cuentas.db');
    const seed = SqliteAccountStore.open(path);
    const user = seed.invite('ana', 'member');
    seed.close();
    const outcomes = await race('sessions', path, 4, 40, () => 'ana');
    expectClean(outcomes);
    expect(countOf(outcomes, (line) => line.ok === true)).toBe(160);
    inspect(path, (query) => {
      expect(query(`SELECT count(*) AS n FROM sessions WHERE user_id = '${user.id}'`)[0]?.n).toBe(MAX_SESSIONS_PER_USER);
    });
  });

  it('compartir un proyecto con una persona nueva (invitación y pertenencia) es indivisible: nunca queda una sin la otra', async () => {
    const path = join(tmp(), 'cuentas.db');
    SqliteAccountStore.open(path).close();
    const outcomes = await race('share', path, 4, 80, (index) => `c${index}`);
    expectClean(outcomes);
    expect(countOf(outcomes, (line) => line.ok === true)).toBe(320);
    inspect(path, (query) => {
      expect(query('SELECT count(*) AS n FROM users')[0]?.n).toBe(320);
      expect(query('SELECT count(*) AS n FROM members')[0]?.n).toBe(320);
      expect(query('SELECT count(*) AS n FROM users u WHERE NOT EXISTS (SELECT 1 FROM members m WHERE m.user_id = u.id)')[0]?.n).toBe(0);
    });
  });

  it('un proceso que muere de golpe (SIGKILL) en plena escritura no deja la base dañada ni una operación a medias', async () => {
    const path = join(tmp(), 'cuentas.db');
    SqliteAccountStore.open(path).close();
    const run = launch('flood', path, 0, 'k');
    // Esperar a que lleve unas cuantas operaciones confirmadas y matarlo sin avisar, a mitad de la siguiente.
    await vi.waitFor(() => expect(run.seen()).toBeGreaterThanOrEqual(25), { timeout: 60_000, interval: 20 });
    run.child.kill('SIGKILL');
    const outcome = await run.done;
    expect(outcome.signal).toBe('SIGKILL');

    const confirmed = outcome.lines.filter((line) => line.ok).length;
    expect(confirmed).toBeGreaterThanOrEqual(25);
    inspect(path, (query) => {
      expect(query('PRAGMA integrity_check')[0]?.integrity_check).toBe('ok');
      const users = Number(query('SELECT count(*) AS n FROM users')[0]?.n);
      const members = Number(query('SELECT count(*) AS n FROM members')[0]?.n);
      // Todo lo confirmado está, y como mucho una operación más (la que llegó a confirmarse justo antes del golpe sin que el padre leyera su línea).
      expect(users).toBeGreaterThanOrEqual(confirmed);
      expect(users).toBeLessThanOrEqual(confirmed + 1);
      expect(members).toBe(users); // la invitación y la pertenencia van juntas o no van
    });

    // Y la base sigue usable: se abre (recuperando el WAL) y acepta escrituras.
    const store = SqliteAccountStore.open(path);
    try {
      const before = store.userCount;
      store.invite('despues', 'guest');
      expect(store.userCount).toBe(before + 1);
    } finally {
      store.close();
    }
  });

  it('migrar espera el candado y, ya con él, vuelve a mirar la versión: si otro proceso migró entretanto, no repite la migración', async () => {
    const path = join(tmp(), 'cuentas.db');
    // Esta conexión se queda con el candado de escritura de una base recién creada (sin esquema) y deja que el servicio arranque y espere.
    const holder = new (loadSqlite().DatabaseSync)(path);
    try {
      holder.exec('PRAGMA journal_mode = WAL');
      holder.exec('BEGIN IMMEDIATE');
      const run = launch('open', path, 0);
      await vi.waitFor(() => expect(run.seen()).toBeGreaterThanOrEqual(1), { timeout: 60_000, interval: 10 });
      await new Promise((done) => setTimeout(done, 500)); // el proceso ya miró la versión (0) y está esperando el candado
      MIGRATIONS[0]!.up(holder);
      holder.exec(`PRAGMA user_version = ${MIGRATIONS[0]!.version}`);
      holder.exec('COMMIT');
      const outcome = await run.done;
      expect(outcome.stderr).toBe('');
      expect(outcome.code).toBe(0);
      expect(outcome.lines).toEqual([{ ready: true }, { ok: true }]);
    } finally {
      holder.close();
    }
    inspect(path, (query) => expect(query('PRAGMA user_version')[0]?.user_version).toBe(1));
  });

  it('un servicio que arranca mientras otros procesos escriben abre la base y migra sin errores (el esquema se aplica una sola vez)', async () => {
    const path = join(tmp(), 'cuentas.db'); // sin crear: los cuatro procesos la crean y migran a la vez
    const outcomes = await race('invite', path, 4, 10, (index) => `a${index}`);
    expectClean(outcomes);
    expect(countOf(outcomes, (line) => line.ok === true)).toBe(40);
    inspect(path, (query) => {
      expect(query('PRAGMA user_version')[0]?.user_version).toBe(1);
      expect(query('SELECT count(*) AS n FROM users')[0]?.n).toBe(40);
    });
  });
});
