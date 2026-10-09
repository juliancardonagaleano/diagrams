import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import { CliError } from '../io';
import { describeImport, importJsonAccounts } from './migrate';
import { AccountError } from './model';
import { SqliteAccountStore } from './sqliteStore';

/**
 * `iark accounts`: mantenimiento del almacén SQLite de cuentas (`iark serve --accounts-store sqlite`). Funciona con el servicio en marcha:
 * la base admite varios procesos a la vez.
 *
 *   iark accounts migrate --from <cuentas.json> [--accounts <cuentas.db>] [--dry-run] [--no-backup]   pasa el JSON a la base
 *   iark accounts backup <destino> [--accounts <cuentas.db>]                                            copia coherente de la base viva
 *   iark accounts info [--accounts <cuentas.db>] [--json]                                               versión del esquema, conteos y salud
 */

const ACCOUNTS_HELP = 'la base SQLite de cuentas (o la variable IARK_ACCOUNTS)';

interface AccountsOptions {
  accounts?: string;
}

/** La base indicada con `--accounts` o con `IARK_ACCOUNTS`. */
function databasePath(opts: AccountsOptions): string {
  const file = opts.accounts || process.env.IARK_ACCOUNTS;
  if (!file) throw new CliError('Indique la base de cuentas con --accounts <archivo> o con la variable IARK_ACCOUNTS.', 2);
  return file;
}

/** Un error del almacén como error de uso (2) o, si el disco no responde, de entorno (1). */
function asCliError(error: unknown): unknown {
  return error instanceof AccountError ? new CliError(error.message, error.code === 'unavailable' ? 1 : 2) : error;
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

export function registerAccounts(program: Command): void {
  const accounts = program
    .command('accounts')
    .description('Mantenimiento de las cuentas de `iark serve --accounts` con el almacén SQLite: pasar un JSON a la base, copias de seguridad y estado. Funciona con el servicio en marcha');
  const sub = (name: string) => accounts.command(name).option('--accounts <archivo>', ACCOUNTS_HELP);

  sub('migrate')
    .description(
      'Importa el archivo JSON de cuentas a la base SQLite (cuentas, invitaciones, sesiones y pertenencia a proyectos) en una sola transacción, con copia de seguridad del JSON, que no se modifica. ' +
        'Es idempotente: repetirlo con el mismo JSON no hace nada, y una base que ya tiene otras cuentas no se mezcla',
    )
    .option('--from <archivo>', 'el JSON de cuentas de origen (o la variable IARK_ACCOUNTS_IMPORT)')
    .option('--dry-run', 'solo comprobar el JSON y contar lo que se importaría', false)
    .option('--no-backup', 'no copiar el JSON a <archivo>.bak-<fecha> antes de importar')
    .action((opts: AccountsOptions & { from?: string; dryRun: boolean; backup: boolean }) => {
      const source = opts.from || process.env.IARK_ACCOUNTS_IMPORT;
      if (!source) throw new CliError('Indique el JSON de cuentas de origen con --from <archivo> o con la variable IARK_ACCOUNTS_IMPORT.', 2);
      const path = databasePath(opts);
      // Primero se lee y valida el JSON sin abrir la base: un origen que no existe o está dañado no deja una base vacía creada por el camino.
      const check = translate(() => importJsonAccounts(undefined, source, { dryRun: true }));
      if (check.status === 'no-source') throw new CliError(describeImport(check), 2);
      // Un simulacro tampoco inventa la base: si no existe, el JSON ya está comprobado.
      const report = opts.dryRun && !existsSync(path)
        ? check
        : withStore(path, false, (store) => importJsonAccounts(store, source, { dryRun: opts.dryRun, backup: opts.backup }));
      if (report.status === 'no-source') throw new CliError(describeImport(report), 2);
      if (report.status === 'target-not-empty') throw new CliError(describeImport(report), 1);
      writeLine(describeImport(report));
    });

  sub('backup')
    .description('Hace una copia coherente de la base viva en <destino> (modo 0600; no sobrescribe) y comprueba su integridad. No hace falta parar el servicio ni copiar los -wal y -shm a mano')
    .argument('<destino>', 'archivo de la copia (por ejemplo /data/copias/cuentas-2026-10-09.db)')
    .action((destination: string, opts: AccountsOptions) => {
      const path = databasePath(opts);
      withStore(path, true, (store) => store.backupTo(destination));
      const check = SqliteAccountStore.checkFile(destination);
      if (check.length !== 1 || check[0] !== 'ok') throw new CliError(`La copia «${destination}» se hizo pero no pasa la comprobación de integridad: ${check.join('; ')}. No la use.`, 1);
      writeLine(`Copia de seguridad de «${path}» en «${destination}» (integridad: ok).`);
    });

  sub('info')
    .description('Muestra el estado de la base: versión del esquema, modo del diario, conteos y, si se importó de un JSON, de cuál')
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
