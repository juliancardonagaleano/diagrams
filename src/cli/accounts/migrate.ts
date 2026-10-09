import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, copyFileSync, existsSync, openSync, readSync } from 'node:fs';
import { AccountError, type AccountsFile } from './model';
import { parseAccountsFile, readAccountsText } from './jsonStore';
import { SqliteAccountStore, type ImportCounts, type ImportProvenance } from './sqliteStore';

/**
 * Pasar las cuentas de un archivo JSON (el almacén `json`) o de una base SQLite (el almacén `sqlite`) a una base SQLite o Postgres:
 * `iark accounts migrate` a mano o, al arrancar `iark serve`, con `--accounts-import <archivo>` (`IARK_ACCOUNTS_IMPORT`). El origen puede ser
 * el JSON de cuentas o una base SQLite (se distingue por su cabecera, no por el nombre); el destino, cualquier almacén que sepa importar un volcado
 * (`ImportTarget`: SQLite y Postgres).
 *
 * - **Sin perder nada.** Entran las cuentas, las invitaciones pendientes, las sesiones (el token sigue valiendo: solo se guardó su hash) y
 *   la pertenencia a proyectos, todo en una sola transacción; antes de confirmar se cuenta lo guardado y, si no cuadra con el origen, se
 *   deshace. Los instantes se guardan en su forma canónica (`toISOString()`), que para lo que escribió el almacén JSON es idéntica.
 *   Un proyecto sin ninguna persona no se importa (no tiene efecto).
 * - **Copia de seguridad.** Antes de importar se copia el origen a `<archivo>.bak-<fecha>` (modo 0600; de una base SQLite, con una copia coherente
 *   `VACUUM INTO`). El origen no se borra: sirve para volver atrás (con `--accounts-store json` o `sqlite`, perdiendo lo que cambió después de migrar).
 *   Abrir una base SQLite de origen la deja como la dejaría arrancar `iark serve` con ella (modo WAL y, si es antigua, su esquema al día).
 * - **Idempotente.** El destino anota el sha256 del origen importado (`meta`; el de una base SQLite es el de su volcado). Repetir la migración con
 *   el mismo origen no hace nada (`already-imported`); con el destino ya en uso por otra vía no mezcla (`target-not-empty`): para rehacerlo, se
 *   borra el destino (el archivo de la base SQLite; las tablas `cuentas_*` de Postgres) y se repite. Si dos instancias arrancan a la vez con la
 *   importación puesta, la transacción deja pasar a una y la otra ve que ya está hecho (en Postgres, además, el candado de escritura las ordena).
 */

/** Lo que hace falta de un destino para importarle un volcado: lo cumplen `SqliteAccountStore` (síncrono) y `PostgresAccountStore`. */
export interface ImportTarget {
  meta(key: string): string | undefined | Promise<string | undefined>;
  isEmpty(): boolean | Promise<boolean>;
  importSnapshot(file: AccountsFile, provenance?: ImportProvenance): ImportCounts | Promise<ImportCounts>;
}

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

/** El nombre de la copia de seguridad: `<archivo>.bak-<fecha>`, o con `-1`, `-2`… si ya existe (una copia anterior no se pisa). */
function freeBackupName(source: string, at: Date): string {
  const base = `${source}.bak-${stamp(at)}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    const destination = attempt === 0 ? base : `${base}-${attempt}`;
    if (!existsSync(destination)) return destination;
  }
  throw new AccountError('unavailable', `No se pudo hacer la copia de seguridad de «${source}»: ya hay demasiadas con el mismo nombre.`);
}

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

const SQLITE_HEADER = 'SQLite format 3\u0000';

/** ¿El archivo empieza como una base SQLite? (Se mira la cabecera, no el nombre.) Un archivo que no existe o no se puede leer no lo es: lo dirá la lectura. */
function looksLikeSqlite(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return false;
  }
  try {
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    return head.toString('latin1') === SQLITE_HEADER;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/** Lo que se importa: el origen leído, con su huella y la forma de copiarlo y de obtener el volcado ya validado. */
interface Source {
  sha256: string;
  /** El volcado (estricto: un origen dañado no se importa a medias). */
  load(): AccountsFile;
  /** La copia de seguridad del origen; devuelve su ruta. */
  backup(at: Date): string;
}

/** Lee el origen: el JSON de cuentas o una base SQLite de cuentas. `undefined` si no existe. */
function readSource(source: string): Source | undefined {
  if (looksLikeSqlite(source)) {
    const dump = ((): AccountsFile => {
      const store = SqliteAccountStore.open(source, { mustExist: true });
      try {
        return store.snapshot();
      } finally {
        store.close();
      }
    })();
    return {
      sha256: createHash('sha256').update(JSON.stringify(dump), 'utf8').digest('hex'),
      load: () => dump,
      backup(at) {
        const destination = freeBackupName(source, at);
        const store = SqliteAccountStore.open(source, { mustExist: true });
        try {
          store.backupTo(destination);
        } finally {
          store.close();
        }
        return destination;
      },
    };
  }
  const text = readAccountsText(source);
  if (text === undefined) return undefined;
  return { sha256: createHash('sha256').update(text, 'utf8').digest('hex'), load: () => parseAccountsFile(text), backup: (at) => backupJson(source, at) };
}

/**
 * Importa las cuentas de `source` (el JSON de cuentas o una base SQLite) en `target` si procede. Falla con `AccountError` si el origen no es válido o no
 * se puede leer. Sin `target`, solo se puede simular (`dryRun`).
 */
export async function importAccounts(target: ImportTarget | undefined, source: string, options: ImportOptions = {}): Promise<ImportReport> {
  const now = options.now ?? ((): Date => new Date());
  if (!target && !options.dryRun) throw new Error('importAccounts: sin base de destino solo se puede simular (dryRun).');
  const read = readSource(source);
  if (read === undefined) return { status: 'no-source', source };
  const { sha256 } = read;
  if ((await target?.meta('imported_json_sha256')) === sha256) return { status: 'already-imported', source, sha256 };
  if (target && !(await target.isEmpty())) return { status: 'target-not-empty', source, sha256 };

  const file = read.load();
  if (options.dryRun) return { status: 'dry-run', source, sha256, counts: countsOf(file) };

  if (!target) throw new Error('importAccounts: falta la base de destino.');
  let backup: string | undefined;
  if (options.backup !== false) backup = read.backup(now());
  try {
    const counts = await target.importSnapshot(file, { sha256, source, at: now().toISOString() });
    return { status: 'imported', source, sha256, counts, ...(backup ? { backup } : {}) };
  } catch (error) {
    // Otro proceso importó entre la comprobación y la transacción: si fue este mismo origen, ya está hecho.
    if (error instanceof AccountError && error.code === 'conflict') {
      return { status: (await target.meta('imported_json_sha256')) === sha256 ? 'already-imported' : 'target-not-empty', source, sha256, ...(backup ? { backup } : {}) };
    }
    throw error;
  }
}

const many = (n: number, one: string, other: string): string => `${n} ${n === 1 ? one : other}`;

/** Una frase para decir lo que pasó (la usan `iark accounts migrate` y el arranque de `iark serve`). `destination` dice qué se borra para rehacer la importación. */
export function describeImport(report: ImportReport, destination: 'sqlite' | 'postgres' = 'sqlite'): string {
  const { counts, source } = report;
  const what = counts ? `${many(counts.users, 'cuenta', 'cuentas')}, ${many(counts.sessions, 'sesión', 'sesiones')} y ${many(counts.memberships, 'pertenencia', 'pertenencias')} a ${many(counts.projects, 'proyecto', 'proyectos')}` : '';
  switch (report.status) {
    case 'imported':
      return `Cuentas importadas de «${source}»: ${what}.${report.backup ? ` Copia de seguridad del origen: ${report.backup}.` : ''} El origen no se ha tocado.`;
    case 'dry-run':
      return `Simulacro: «${source}» está en orden y se importarían ${what}. No se ha escrito nada.`;
    case 'already-imported':
      return `Nada que hacer: la base ya se importó de «${source}» (mismo contenido).`;
    case 'target-not-empty':
      return destination === 'postgres'
        ? `La base ya tiene cuentas que no salen de «${source}»: no se mezclan. Para rehacerla, vacíe las tablas cuentas_* del esquema de IArk (o borre ese esquema) con el servicio parado y repita la importación.`
        : `La base ya tiene cuentas que no salen de «${source}»: no se mezclan. Para rehacerla, borre el archivo de la base (y su -wal y -shm) con el servicio parado y repita la importación.`;
    case 'no-source':
      return `No existe «${source}».`;
  }
}
