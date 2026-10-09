import { JsonAccountStore } from './jsonStore';
import type { AccountStore, AccountStoreKind, AccountStoreOptions } from './model';
import { SqliteAccountStore } from './sqliteStore';

/**
 * El almacén de cuentas de `iark serve --accounts`: el contrato (`AccountStore`, en `model.ts`), sus dos implementaciones y la forma de
 * elegir una. Quien usa las cuentas (`service.ts`, las rutas, la autenticación) importa de aquí y solo conoce el contrato:
 *
 *   - `json` (`jsonStore.ts`, el valor por omisión del CLI): un archivo con un único escritor. Para una instancia y equipos pequeños.
 *   - `sqlite` (`sqliteStore.ts`): una base transaccional con `node:sqlite`. Admite varias instancias sobre el mismo disco local.
 *
 * `iark accounts migrate` (ver `cli.ts` y `migrate.ts`) pasa un JSON existente a SQLite.
 */
export * from './model';
export { JsonAccountStore, parseAccountsFile, readAccountsText } from './jsonStore';
export { MIGRATIONS, SqliteAccountStore, SQLITE_MIN_NODE, type ImportCounts, type ImportProvenance, type SqliteInfo, type SqliteMigration, type SqliteStoreOptions } from './sqliteStore';

/** Abre el almacén de ese tipo en esa ruta (la crea vacía si no existe). Falla con `AccountError` si no es un almacén válido o no se puede usar. */
export function openAccountStore(kind: AccountStoreKind, path: string, options: AccountStoreOptions = {}): AccountStore {
  return kind === 'sqlite' ? SqliteAccountStore.open(path, options) : JsonAccountStore.open(path, options);
}
