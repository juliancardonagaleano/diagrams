import { execFileSync } from 'node:child_process';
import { chownSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDatabaseConfig, type DatabaseConfig } from '../../src/cli/postgres/config';
import { PostgresDatabase } from '../../src/cli/postgres/pool';

/**
 * Un Postgres de verdad para las pruebas, sin Docker ni cuentas: arranca un clúster temporal con los binarios del sistema
 * (`initdb`, `pg_ctl`) en una carpeta propia y un puerto libre, sin fsync (es de usar y tirar), y lo borra al terminar. Cada archivo de
 * pruebas arranca el suyo (≈3 s), así que no comparten estado ni puertos.
 *
 * Dónde busca los binarios: `IARK_PG_BIN` (la carpeta con `initdb`), `/usr/lib/postgresql/<versión>/bin` (Debian y Ubuntu; ahí los
 * trae el runner de GitHub) y el `PATH`. Si ya hay una base de pruebas, `IARK_TEST_DATABASE_URL` la usa tal cual (con esquemas propios
 * por prueba). Si no hay nada de eso, `postgresAvailable()` es `false` y las pruebas de Postgres se omiten, salvo que
 * `IARK_REQUIRE_POSTGRES=1` (el CI): entonces fallan con un mensaje claro en lugar de pasar sin probar nada.
 *
 * Como `root`, `initdb` se niega a correr: se arranca como el usuario `postgres` del sistema (`runuser`).
 */

export function findPostgresBin(): string | undefined {
  const candidates: string[] = [];
  if (process.env.IARK_PG_BIN) candidates.push(process.env.IARK_PG_BIN);
  const root = '/usr/lib/postgresql';
  if (existsSync(root)) {
    candidates.push(...readdirSync(root).sort((a, b) => Number(b) - Number(a)).map((v) => join(root, v, 'bin')));
  }
  for (const dir of candidates) if (existsSync(join(dir, 'initdb')) && existsSync(join(dir, 'pg_ctl'))) return dir;
  return undefined;
}

export const postgresAvailable = (): boolean => Boolean(process.env.IARK_TEST_DATABASE_URL) || Boolean(findPostgresBin());

/** En el CI se exige Postgres: omitir en silencio escondería que no se probó. */
export function requirePostgresIfCi(): void {
  if (process.env.IARK_REQUIRE_POSTGRES === '1' && !postgresAvailable()) {
    throw new Error('IARK_REQUIRE_POSTGRES=1 pero no hay Postgres: instale postgresql (initdb y pg_ctl) o defina IARK_PG_BIN o IARK_TEST_DATABASE_URL.');
  }
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

export interface TestPostgres {
  /** La cadena de conexión (sin SSL, en localhost). */
  url: string;
  stop(): Promise<void>;
}

export async function startTestPostgres(): Promise<TestPostgres> {
  requirePostgresIfCi();
  const external = process.env.IARK_TEST_DATABASE_URL;
  if (external) return { url: external, stop: async () => undefined };
  const bin = findPostgresBin();
  if (!bin) throw new Error('No hay Postgres para las pruebas (ver tests/helpers/postgres.ts).');

  const dir = mkdtempSync(join(tmpdir(), 'iark-pg-'));
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (asRoot) chownSync(dir, Number(execFileSync('id', ['-u', 'postgres']).toString().trim()), Number(execFileSync('id', ['-g', 'postgres']).toString().trim()));
  const run = (cmd: string, args: string[]): string => {
    const [file, ...rest] = asRoot ? ['runuser', '-u', 'postgres', '--', join(bin, cmd), ...args] : [join(bin, cmd), ...args];
    return execFileSync(file, rest, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  };
  const data = join(dir, 'data');
  const port = await freePort();
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-sync', '-E', 'UTF8', '--locale=C.UTF-8']);
    run('pg_ctl', ['-D', data, '-l', join(dir, 'log'), '-w', '-t', '60', '-o', `-c listen_addresses=127.0.0.1 -p ${port} -c unix_socket_directories=${dir} -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=200`, 'start']);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try {
      run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    } catch {
      // ya estaba parado
    }
    rmSync(dir, { recursive: true, force: true });
  };
  process.once('exit', () => {
    if (!stopped) {
      try {
        run('pg_ctl', ['-D', data, '-m', 'immediate', 'stop']);
      } catch {
        // nada que hacer
      }
    }
  });
  return { url: `postgres://postgres@127.0.0.1:${port}/postgres`, stop };
}

let counter = 0;
/** Un nombre de esquema nuevo para una prueba (así comparten servidor sin pisarse). */
export const uniqueSchema = (): string => `t_${process.pid}_${Date.now().toString(36)}_${counter++}`;

/** La configuración de conexión de una prueba: esa base, ese esquema. */
export function testConfig(url: string, schema = uniqueSchema(), extra: NodeJS.ProcessEnv = {}): DatabaseConfig {
  return resolveDatabaseConfig({ IARK_DATABASE_URL: url, IARK_DATABASE_SCHEMA: schema, IARK_DATABASE_POOL: '8', ...extra });
}

/** Abre una conexión de prueba con un esquema propio; `drop()` lo borra y cierra. */
export async function openTestDatabase(url: string, extra: NodeJS.ProcessEnv = {}): Promise<{ db: PostgresDatabase; drop: () => Promise<void> }> {
  const db = await PostgresDatabase.connect(testConfig(url, undefined, extra));
  return {
    db,
    drop: async () => {
      try {
        await db.query(`drop schema if exists ${db.schemaQuoted} cascade`);
      } finally {
        await db.close();
      }
    },
  };
}
