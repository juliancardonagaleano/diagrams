import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import { CliError } from '../io';
import { DatabaseConfigError } from '../postgres/config';
import { DatabaseError } from '../postgres/pool';
import { acquireDatabase, releaseDatabase } from '../postgres/shared';
import { describeImport, importAccounts } from './migrate';
import { AccountError } from './model';
import { PostgresAccountStore } from './postgresStore';
import { SqliteAccountStore } from './sqliteStore';

/**
 * `iark accounts`: mantenimiento de las cuentas de `iark serve`. Funciona con el servicio en marcha: las bases admiten varios procesos a la vez.
 *
 *   iark accounts migrate --from <cuentas.json|cuentas.db> [--accounts <cuentas.db>] [--dry-run] [--no-backup]   pasa un JSON (o una base SQLite) a una base SQLite
 *   iark accounts migrate --from <cuentas.json|cuentas.db> --accounts-store postgres [--dry-run] [--no-backup]    … o a Postgres (conexión en IARK_DATABASE_URL)
 *   iark accounts backup <destino> [--accounts <cuentas.db>]                                            copia coherente de la base SQLite viva
 *   iark accounts info [--accounts <cuentas.db>] [--json]                                               versión del esquema, conteos y salud de la base SQLite
 *
 * `backup` e `info` son de SQLite. Con Postgres la copia de seguridad la hace el servicio de la base (Supabase la incluye en su plan; `pg_dump` en cualquier caso).
 */

const ACCOUNTS_HELP = 'la base SQLite de cuentas (o la variable IARK_ACCOUNTS)';
const POSTGRES_NOTE = 'con Postgres no existe: la copia de seguridad y el estado los da el servicio de la base (Supabase: Database → Backups; o `pg_dump`)';

interface AccountsOptions {
  accounts?: string;
}

/** La base indicada con `--accounts` o con `IARK_ACCOUNTS`. */
function databasePath(opts: AccountsOptions): string {
  const file = opts.accounts || process.env.IARK_ACCOUNTS;
  if (!file) throw new CliError(`Indique la base SQLite de cuentas con --accounts <archivo> o con la variable IARK_ACCOUNTS (${POSTGRES_NOTE}).`, 2);
  return file;
}

/** Un error del almacén o de la conexión como error de uso (2) o, si el disco o la base no responden, de entorno (1). */
function asCliError(error: unknown): unknown {
  if (error instanceof DatabaseConfigError) return new CliError(error.message, 2);
  if (error instanceof DatabaseError) return new CliError(error.message, error.code === 'incompatible' ? 2 : 1);
  return error instanceof AccountError ? new CliError(error.message, error.code === 'unavailable' || error.code === 'unreachable' ? 1 : 2) : error;
}

const writeLine = (text: string): void => void process.stdout.write(`${text}\n`);

/** Corre `body` y traduce un error del almacén a error de uso. */
function translate<T>(body: () => T): T {
  try {
    return body();
  } catch (error) {
    throw asCliError(error);
  }
}

/** Lo mismo con un cuerpo asíncrono. */
async function translateAsync<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    throw asCliError(error);
  }
}

/** Corre `body` con la base abierta y la cierra al terminar. */
function withStore<T>(path: string, mustExist: boolean, body: (store: SqliteAccountStore) => T): T {
  return translate(() => {
    const store = SqliteAccountStore.open(path, { mustExist });
    try {
      return body(store);
    } finally {
      store.close();
    }
  });
}

/** Como `withStore`, para un `body` asíncrono (la importación): la base se cierra cuando éste termina, no antes. */
async function withStoreAsync<T>(path: string, mustExist: boolean, body: (store: SqliteAccountStore) => Promise<T>): Promise<T> {
  return translateAsync(async () => {
    const store = SqliteAccountStore.open(path, { mustExist });
    try {
      return await body(store);
    } finally {
      store.close();
    }
  });
}

/** Corre `body` con la base de Postgres del entorno abierta (el esquema al día) y suelta la conexión al terminar. */
async function withPostgres<T>(body: (store: PostgresAccountStore) => Promise<T>): Promise<T> {
  return translateAsync(async () => {
    const store = await PostgresAccountStore.open(await acquireDatabase(), { release: releaseDatabase });
    try {
      return await body(store);
    } finally {
      await store.close();
    }
  });
}

/** El almacén de destino de `migrate`: lo que pide `--accounts-store` (o `IARK_ACCOUNTS_STORE`, solo si es uno de los dos destinos). */
function migrateTarget(opts: { accountsStore?: string }): 'sqlite' | 'postgres' {
  const asked = (opts.accountsStore ?? '').trim().toLowerCase();
  if (asked === 'sqlite' || asked === 'postgres') return asked;
  if (asked !== '') throw new CliError(`--accounts-store debe ser «sqlite» o «postgres» (el destino de la migración), no «${asked.slice(0, 40)}».`, 2);
  const fromEnv = (process.env.IARK_ACCOUNTS_STORE ?? '').trim().toLowerCase();
  return fromEnv === 'postgres' ? 'postgres' : 'sqlite';
}

export function registerAccounts(program: Command): void {
  const accounts = program
    .command('accounts')
    .description('Mantenimiento de las cuentas de `iark serve --accounts`: pasar un JSON o una base SQLite a SQLite o a Postgres, copias de seguridad y estado de SQLite. Funciona con el servicio en marcha');
  const sub = (name: string) => accounts.command(name).option('--accounts <archivo>', ACCOUNTS_HELP);

  sub('migrate')
    .description(
      'Importa el archivo JSON de cuentas (o una base SQLite) a la base de destino, SQLite o Postgres (cuentas, invitaciones, sesiones y pertenencia a proyectos) en una sola transacción, con copia de seguridad del origen, que no se modifica. ' +
        'Es idempotente: repetirlo con el mismo origen no hace nada, y una base que ya tiene otras cuentas no se mezcla',
    )
    .option('--from <archivo>', 'el JSON de cuentas (o la base SQLite) de origen (o la variable IARK_ACCOUNTS_IMPORT)')
    .option('--accounts-store <almacén>', 'el destino: «sqlite» (por omisión; la base va en --accounts) o «postgres» (la conexión sale solo de IARK_DATABASE_URL, docs/postgres.md; también vale IARK_ACCOUNTS_STORE=postgres)')
    .option('--dry-run', 'solo comprobar el origen y contar lo que se importaría (con Postgres no se conecta)', false)
    .option('--no-backup', 'no copiar el origen a <archivo>.bak-<fecha> antes de importar')
    .action(async (opts: AccountsOptions & { from?: string; accountsStore?: string; dryRun: boolean; backup: boolean }) => {
      const source = opts.from || process.env.IARK_ACCOUNTS_IMPORT;
      if (!source) throw new CliError('Indique el origen (el JSON de cuentas o una base SQLite) con --from <archivo> o con la variable IARK_ACCOUNTS_IMPORT.', 2);
      const destination = migrateTarget(opts);
      if (destination === 'postgres' && opts.accounts) throw new CliError('--accounts es la base SQLite de destino: con --accounts-store postgres las cuentas van a la base de IARK_DATABASE_URL. Quite --accounts.', 2);
      const path = destination === 'sqlite' ? databasePath(opts) : undefined;
      // Primero se lee y valida el origen sin abrir la base: uno que no existe o está dañado no deja una base vacía creada por el camino.
      const check = await translateAsync(() => importAccounts(undefined, source, { dryRun: true }));
      if (check.status === 'no-source') throw new CliError(describeImport(check), 2);
      // Un simulacro tampoco inventa la base ni se conecta a ella: el origen ya está comprobado.
      let report;
      if (opts.dryRun && (destination === 'postgres' || !existsSync(path!))) report = check;
      else if (destination === 'postgres') report = await withPostgres((store) => importAccounts(store, source, { dryRun: opts.dryRun, backup: opts.backup }));
      else report = await withStoreAsync(path!, false, (store) => importAccounts(store, source, { dryRun: opts.dryRun, backup: opts.backup }));
      if (report.status === 'no-source') throw new CliError(describeImport(report, destination), 2);
      if (report.status === 'target-not-empty') throw new CliError(describeImport(report, destination), 1);
      writeLine(describeImport(report, destination));
    });

  sub('backup')
    .description(`Hace una copia coherente de la base SQLite viva en <destino> (modo 0600; no sobrescribe) y comprueba su integridad. No hace falta parar el servicio ni copiar los -wal y -shm a mano; ${POSTGRES_NOTE}`)
    .argument('<destino>', 'archivo de la copia (por ejemplo /data/copias/cuentas-2026-10-09.db)')
    .action((destination: string, opts: AccountsOptions) => {
      const path = databasePath(opts);
      withStore(path, true, (store) => store.backupTo(destination));
      const check = SqliteAccountStore.checkFile(destination);
      if (check.length !== 1 || check[0] !== 'ok') throw new CliError(`La copia «${destination}» se hizo pero no pasa la comprobación de integridad: ${check.join('; ')}. No la use.`, 1);
      writeLine(`Copia de seguridad de «${path}» en «${destination}» (integridad: ok).`);
    });

  sub('info')
    .description(`Muestra el estado de la base SQLite: versión del esquema, modo del diario, conteos y, si se importó de un JSON, de cuál; ${POSTGRES_NOTE}`)
    .option('--json', 'salida en JSON', false)
    .action((opts: AccountsOptions & { json: boolean }) => {
      const path = databasePath(opts);
      const info = withStore(path, true, (store) => ({ ...store.info(), integrity: store.integrityCheck() }));
      if (opts.json) return void process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
      writeLine(`Base de cuentas: ${info.path} (${(info.sizeBytes / 1024).toFixed(0)} KiB)`);
      writeLine(`  esquema: ${info.schemaVersion} de ${info.latestSchemaVersion} · diario: ${info.journalMode} (sincronización ${info.synchronous}) · integridad: ${info.integrity.join('; ')}`);
      writeLine(`  cuentas: ${info.users} (${info.pending} invitaciones pendientes, ${info.disabled} desactivadas) · sesiones: ${info.activeSessions} vigentes de ${info.sessions}`);
      writeLine(`  proyectos: ${info.projects} (${info.memberships} pertenencias)`);
      if (info.importedFrom) writeLine(`  importada de «${info.importedFrom.source}» el ${info.importedFrom.at} (sha256 ${info.importedFrom.sha256.slice(0, 12)}…)`);
    });
}
