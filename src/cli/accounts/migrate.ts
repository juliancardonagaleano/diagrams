import { createHash } from 'node:crypto';
import { chmodSync, constants, copyFileSync } from 'node:fs';
import { AccountError, type AccountsFile } from './model';
import { parseAccountsFile, readAccountsText } from './jsonStore';
import type { ImportCounts, SqliteAccountStore } from './sqliteStore';

/**
 * Pasar las cuentas de un archivo JSON (el almacén `json`) a una base SQLite (el almacén `sqlite`): `iark accounts migrate` a mano o,
 * al arrancar `iark serve`, con `--accounts-import <archivo.json>` (`IARK_ACCOUNTS_IMPORT`).
 *
 * - **Sin perder nada.** Entran las cuentas, las invitaciones pendientes, las sesiones (el token sigue valiendo: solo se guardó su hash) y
 *   la pertenencia a proyectos, todo en una sola transacción; antes de confirmar se cuenta lo guardado y, si no cuadra con el archivo, se
 *   deshace. Los instantes se guardan en su forma canónica (`toISOString()`), que para lo que escribió el almacén JSON es idéntica.
 *   Un proyecto sin ninguna persona no se importa (no tiene efecto).
 * - **Copia de seguridad.** Antes de importar se copia el JSON a `<archivo>.bak-<fecha>` (modo 0600). El JSON original no se modifica ni
 *   se borra: sirve para volver atrás (con `--accounts-store json`, perdiendo lo que cambió después de migrar).
 * - **Idempotente.** La base anota el sha256 del JSON importado (`meta`). Repetir la migración con el mismo archivo no hace nada
 *   (`already-imported`); con la base ya en uso por otra vía no mezcla (`target-not-empty`): para rehacerla, se borra la base y se repite.
 *   Si dos instancias arrancan a la vez con la importación puesta, la transacción deja pasar a una y la otra ve que ya está hecho.
 */

export type ImportStatus =
  /** Se importó (o, con `dryRun`, se importaría). */
  | 'imported'
  | 'dry-run'
  /** Esta base ya salió de este mismo archivo (mismo sha256). */
  | 'already-imported'
  /** La base ya tiene cuentas que no salen de este archivo: no se mezcla. */
  | 'target-not-empty'
  /** El archivo no existe. */
  | 'no-source';

export interface ImportReport {
  status: ImportStatus;
  source: string;
  sha256?: string;
  /** Lo que hay en el archivo (`dry-run`) o lo que entró (`imported`). */
  counts?: ImportCounts;
  /** La copia de seguridad del JSON, si se hizo. */
  backup?: string;
}

export interface ImportOptions {
  /** Solo comprobar y contar: no copia nada ni escribe en la base. */
  dryRun?: boolean;
  /** Copiar el JSON a `<archivo>.bak-<fecha>` antes de importar (por omisión, sí). */
  backup?: boolean;
  now?: () => Date;
}

const countsOf = (file: AccountsFile): ImportCounts => ({
  users: file.users.length,
  sessions: file.sessions.length,
  memberships: Object.values(file.projects).reduce((total, members) => total + members.length, 0),
  projects: Object.values(file.projects).filter((members) => members.length > 0).length,
});

/** `20261009T123456789Z`: la fecha para el nombre de la copia (ordena alfabéticamente y no lleva `:`). */
const stamp = (date: Date): string => date.toISOString().replace(/[-:.]/g, '');

/** Copia el JSON a `<archivo>.bak-<fecha>` (modo 0600), sin pisar una copia anterior (si el nombre existe, añade `-1`, `-2`…). */
function backupJson(source: string, at: Date): string {
  const base = `${source}.bak-${stamp(at)}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    const destination = attempt === 0 ? base : `${base}-${attempt}`;
    try {
      copyFileSync(source, destination, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw new AccountError('unavailable', `No se pudo hacer la copia de seguridad «${destination}» (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}): no se importa nada.`);
    }
    try {
      chmodSync(destination, 0o600);
    } catch (error) {
      throw new AccountError('unavailable', `No se pudo restringir el modo de la copia de seguridad «${destination}» (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}): no se importa nada.`);
    }
    return destination;
  }
  throw new AccountError('unavailable', `No se pudo hacer la copia de seguridad de «${source}»: ya hay demasiadas con el mismo nombre.`);
}

/** Importa el JSON de cuentas `source` en `target` si procede. Falla con `AccountError` si el JSON no es válido o no se puede leer. */
export function importJsonAccounts(target: SqliteAccountStore | undefined, source: string, options: ImportOptions = {}): ImportReport {
  const now = options.now ?? ((): Date => new Date());
  if (!target && !options.dryRun) throw new Error('importJsonAccounts: sin base de destino solo se puede simular (dryRun).');
  const text = readAccountsText(source);
  if (text === undefined) return { status: 'no-source', source };
  const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
  if (target?.meta('imported_json_sha256') === sha256) return { status: 'already-imported', source, sha256 };
  if (target && !target.isEmpty()) return { status: 'target-not-empty', source, sha256 };

  const file = parseAccountsFile(text); // estricto: un JSON dañado no se importa a medias
  if (options.dryRun) return { status: 'dry-run', source, sha256, counts: countsOf(file) };

  if (!target) throw new Error('importJsonAccounts: falta la base de destino.');
  let backup: string | undefined;
  if (options.backup !== false) backup = backupJson(source, now());
  try {
    const counts = target.importSnapshot(file, { sha256, source, at: now().toISOString() });
    return { status: 'imported', source, sha256, counts, ...(backup ? { backup } : {}) };
  } catch (error) {
    // Otro proceso importó entre la comprobación y la transacción: si fue este mismo archivo, ya está hecho.
    if (error instanceof AccountError && error.code === 'conflict') {
      return { status: target.meta('imported_json_sha256') === sha256 ? 'already-imported' : 'target-not-empty', source, sha256, ...(backup ? { backup } : {}) };
    }
    throw error;
  }
}

const many = (n: number, one: string, other: string): string => `${n} ${n === 1 ? one : other}`;

/** Una frase para decir lo que pasó (la usan `iark accounts migrate` y el arranque de `iark serve`). */
export function describeImport(report: ImportReport): string {
  const { counts, source } = report;
  const what = counts ? `${many(counts.users, 'cuenta', 'cuentas')}, ${many(counts.sessions, 'sesión', 'sesiones')} y ${many(counts.memberships, 'pertenencia', 'pertenencias')} a ${many(counts.projects, 'proyecto', 'proyectos')}` : '';
  switch (report.status) {
    case 'imported':
      return `Cuentas importadas de «${source}»: ${what}.${report.backup ? ` Copia de seguridad del JSON: ${report.backup}.` : ''} El JSON original no se ha tocado.`;
    case 'dry-run':
      return `Simulacro: «${source}» está en orden y se importarían ${what}. No se ha escrito nada.`;
    case 'already-imported':
      return `Nada que hacer: la base ya se importó de «${source}» (mismo contenido).`;
    case 'target-not-empty':
      return `La base ya tiene cuentas que no salen de «${source}»: no se mezclan. Para rehacerla, borre el archivo de la base (y su -wal y -shm) con el servicio parado y repita la importación.`;
    case 'no-source':
      return `No existe «${source}».`;
  }
}
