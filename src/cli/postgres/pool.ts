import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { DatabaseConfig } from './config';

/**
 * El pool de conexiones a Postgres de `iark serve`: lo único que los almacenes (cuentas, proyectos) necesitan de `pg`. Se carga
 * `pg` bajo demanda para que quien no usa Postgres no pague su arranque.
 *
 * Pensado para correr detrás del pooler de Supabase (Supavisor, y PgBouncer en general) en modo de TRANSACCIÓN, que es el más
 * estrecho: no hay sentencias preparadas con nombre, no se cambia ningún parámetro de sesión (`SET`), no se usan candados de sesión
 * (solo `pg_advisory_xact_lock`, que vive lo que dura la transacción) ni `LISTEN`. Por eso tampoco se mandan `statement_timeout` ni
 * `options` al conectar (PgBouncer los rechaza como parámetros de arranque): el tope de tiempo es del lado del cliente (`query_timeout`).
 */

export type DatabaseErrorCode =
  /** No se puede llegar a la base o no responde (red, credenciales, TLS, límite de conexiones). */
  | 'unavailable'
  /** La base existe pero no es la que este IArk espera (esquema más nuevo, tabla ajena). */
  | 'incompatible'
  /** Una transacción no se pudo completar tras varios reintentos por concurrencia (serialización, interbloqueo). */
  | 'contention';

export class DatabaseError extends Error {
  constructor(
    readonly code: DatabaseErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'DatabaseError';
  }
}

export const QUERY_TIMEOUT_MS = 20_000;
export const CONNECT_TIMEOUT_MS = 10_000;
export const IDLE_TIMEOUT_MS = 30_000;

/** El código SQLSTATE de un error de `pg`, si lo tiene. */
export const sqlState = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
};

/** `23505`: se violó una restricción de unicidad. */
export const isUniqueViolation = (error: unknown): boolean => sqlState(error) === '23505';
/** `40001` (fallo de serialización) y `40P01` (interbloqueo): la transacción se puede repetir tal cual. */
export const isRetryable = (error: unknown): boolean => {
  const state = sqlState(error);
  return state === '40001' || state === '40P01';
};

export type Isolation = 'read committed' | 'repeatable read' | 'serializable';

/** Lo que se puede hacer dentro de una transacción. */
export interface Tx {
  query<R extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<R[]>;
  /** Toma un candado de asesoramiento que dura hasta el fin de la transacción: serializa lo que comparta esa clave, entre procesos y máquinas. */
  lock(key: string): Promise<void>;
}

export interface TransactionOptions {
  isolation?: Isolation;
  /** Veces que se repite entera si choca con otra (serialización, interbloqueo). Por omisión 4. */
  retries?: number;
}

const BACKOFF_MS = [10, 40, 120, 300];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Un identificador entre comillas dobles. Solo para nombres que YA pasaron `isSchemaName` o son constantes del código. */
export const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

export class PostgresDatabase {
  /** Para tablas: `"esquema"."nombre"`. */
  readonly schemaQuoted: string;

  private constructor(
    private readonly pool: Pool,
    readonly config: DatabaseConfig,
  ) {
    this.schemaQuoted = quoteIdent(config.schema);
  }

  /** Abre el pool y comprueba que la base contesta (una consulta). Lanza `DatabaseError('unavailable')` con el motivo, sin la contraseña. */
  static async connect(config: DatabaseConfig, onIdleError: (error: Error) => void = (error) => process.stderr.write(`postgres: conexión inactiva perdida: ${error.message}\n`)): Promise<PostgresDatabase> {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({
      connectionString: config.connectionString,
      ssl: config.ssl,
      max: config.poolMax,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      query_timeout: QUERY_TIMEOUT_MS,
      application_name: 'iark',
    });
    // Una conexión inactiva que la base cierra (reinicio, límite del pooler) emite 'error' en el pool: sin escucha tumbaría el proceso.
    pool.on('error', onIdleError);
    const db = new PostgresDatabase(pool, config);
    try {
      await db.query('select 1');
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw db.unavailable(error);
    }
    return db;
  }

  /** `"esquema"."tabla"` para una tabla de IArk. */
  table(name: string): string {
    return `${this.schemaQuoted}.${quoteIdent(name)}`;
  }

  /** Convierte un fallo de `pg` en uno que dice qué pasó sin contraseña ni cadena de conexión. */
  unavailable(error: unknown): DatabaseError {
    const e = error as NodeJS.ErrnoException & { message?: string };
    const state = sqlState(error);
    let why = e?.code && !state ? e.code : (e?.message ?? 'error desconocido').replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgres://…');
    if (/self[- ]signed|unable to (?:get|verify)|certificate/i.test(String(e?.message ?? ''))) {
      why += ' (no se pudo comprobar el certificado del servidor: indique su autoridad con IARK_DATABASE_CA_FILE, o IARK_DATABASE_SSL=no-verify para no comprobarlo)';
    } else if (state === '28P01' || state === '28000') {
      why += ' (usuario o contraseña rechazados: revise IARK_DATABASE_URL)';
    } else if (state === '53300' || /too many (?:clients|connections)|max(?:imum)? clients/i.test(String(e?.message ?? ''))) {
      why += ' (la base no admite más conexiones: baje IARK_DATABASE_POOL o use el pooler de la base)';
    }
    return new DatabaseError('unavailable', `No se puede usar Postgres (${this.config.description}): ${why}`, { cause: error });
  }

  async query<R extends QueryResultRow = QueryResultRow>(sql: string, params: readonly unknown[] = []): Promise<R[]> {
    try {
      return (await this.pool.query<R>(sql, params as unknown[])).rows;
    } catch (error) {
      if (sqlState(error)?.startsWith('23') || sqlState(error)?.startsWith('42')) throw error; // fallos de datos o de SQL: son del código que llama
      throw this.isConnectionProblem(error) ? this.unavailable(error) : error;
    }
  }

  private isConnectionProblem(error: unknown): boolean {
    const e = error as NodeJS.ErrnoException & { message?: string };
    if (sqlState(error)) return /^(08|53|57|28)/.test(sqlState(error)!);
    return Boolean(e?.code && /^(ECONN|ENOTFOUND|ETIMEDOUT|EAI_|EPIPE|ENETUNREACH|EHOSTUNREACH|CERT|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO)/.test(e.code)) || /timeout|terminated|Connection|ended/i.test(String(e?.message ?? ''));
  }

  /**
   * Corre `fn` en una transacción y la confirma si termina bien; si lanza, la deshace entera y relanza el error. Si choca con otra por
   * concurrencia (`40001`, `40P01`) se repite desde el principio, así que `fn` NO debe tener efectos fuera de la base.
   */
  async transaction<T>(fn: (tx: Tx) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    const retries = options.retries ?? BACKOFF_MS.length;
    for (let attempt = 0; ; attempt++) {
      let client: PoolClient;
      try {
        client = await this.pool.connect();
      } catch (error) {
        throw this.unavailable(error);
      }
      let broken = false;
      try {
        await client.query(`begin isolation level ${options.isolation ?? 'read committed'}`);
        const tx: Tx = {
          query: async (sql, params = []) => (await client.query(sql, params as unknown[])).rows,
          lock: async (key) => {
            await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
          },
        };
        const result = await fn(tx);
        await client.query('commit');
        return result;
      } catch (error) {
        try {
          await client.query('rollback');
        } catch {
          broken = true; // la conexión murió: se descarta del pool
        }
        if (isRetryable(error) && attempt < retries) {
          await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] * (1 + Math.random()));
          continue;
        }
        if (isRetryable(error)) throw new DatabaseError('contention', 'La base está muy ocupada con cambios simultáneos; vuelva a intentarlo.', { cause: error });
        if (!sqlState(error) && this.isConnectionProblem(error)) throw this.unavailable(error);
        throw error;
      } finally {
        client.release(broken ? new Error('conexión descartada') : undefined);
      }
    }
  }

  /** ¿Contesta la base ahora mismo? No lanza: es lo que mira `/readyz`. */
  async ping(): Promise<boolean> {
    try {
      await this.pool.query('select 1');
      return true;
    } catch {
      return false;
    }
  }

  /** Cierra todas las conexiones. Después no se puede usar. */
  async close(): Promise<void> {
    await this.pool.end();
  }
}
