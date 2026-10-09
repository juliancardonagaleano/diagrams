import { acquireDatabase, releaseDatabase } from '../postgres/shared';
import { asAsync } from './asyncStore';
import { JsonAccountStore } from './jsonStore';
import type { AccountStore, AccountStoreKind, AccountStoreOptions } from './model';
import { PostgresAccountStore } from './postgresStore';
import { SqliteAccountStore } from './sqliteStore';

/**
 * El almacén de cuentas de `iark serve --accounts`: el contrato (`AccountStore`, en `model.ts`), sus tres implementaciones y la forma de
 * elegir una. Quien usa las cuentas (`service.ts`, las rutas, la autenticación) importa de aquí y solo conoce el contrato, que es asíncrono:
 *
 *   - `json` (`jsonStore.ts`, el valor por omisión del CLI): un archivo con un único escritor. Para una instancia y equipos pequeños.
 *   - `sqlite` (`sqliteStore.ts`): una base transaccional con `node:sqlite`. Admite varias instancias sobre el mismo disco local.
 *   - `postgres` (`postgresStore.ts`): una base de red (Supabase, Neon, RDS…) que comparten todas las réplicas, sin disco persistente. La
 *     conexión sale solo del entorno (`IARK_DATABASE_URL`…, ver `postgres/config.ts`), nunca de la línea de comandos.
 *
 * Los dos primeros son síncronos por dentro y se presentan con el contrato asíncrono mediante `asAsync` (`asyncStore.ts`).
 * `iark accounts migrate` (ver `cli.ts` y `migrate.ts`) pasa un JSON o una base SQLite a SQLite o a Postgres.
 */
export * from './model';
export { asAsync } from './asyncStore';
export { JsonAccountStore, parseAccountsFile, readAccountsText } from './jsonStore';
export { MIGRATIONS as POSTGRES_MIGRATIONS, PostgresAccountStore, type PostgresStoreOptions } from './postgresStore';
export { MIGRATIONS, SqliteAccountStore, SQLITE_MIN_NODE, type ImportCounts, type ImportProvenance, type SqliteInfo, type SqliteMigration, type SqliteStoreOptions } from './sqliteStore';

/**
 * Abre el almacén de ese tipo. `json` y `sqlite` viven en `path` (se crea vacío si no existe); `postgres` no usa `path`: toma el pool del
 * proceso con la conexión del entorno (`acquireDatabase`) y lo suelta al cerrar. Falla con `AccountError` si no es un almacén válido o no se
 * puede usar, y con `DatabaseConfigError` si falta o es inválida la configuración de Postgres.
 */
export async function openAccountStore(kind: AccountStoreKind, path: string | undefined, options: AccountStoreOptions = {}): Promise<AccountStore> {
  if (kind === 'postgres') {
    const db = await acquireDatabase();
    return PostgresAccountStore.open(db, { ...options, release: releaseDatabase });
  }
  if (!path) throw new Error(`El almacén ${kind} necesita la ruta de su archivo.`);
  return asAsync(kind === 'sqlite' ? SqliteAccountStore.open(path, options) : JsonAccountStore.open(path, options));
}
