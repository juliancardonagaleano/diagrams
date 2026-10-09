import { readFileSync } from 'node:fs';
import { CliError, info } from '../io';
import { DatabaseConfigError, hasDatabaseSetting } from '../postgres/config';
import { DatabaseError } from '../postgres/pool';
import { acquireDatabase, releaseDatabase } from '../postgres/shared';
import { GithubOAuth } from './github';
import { describeImport, importAccounts, type ImportTarget } from './migrate';
import { Accounts, normalizePublicUrl, parseAdminList, type QuotaLimits, type SignupMode } from './service';
import { parseByteSize } from './usage';
import { ACCOUNT_STORE_KINDS, AccountError, asAsync, isAccountStoreKind, JsonAccountStore, PostgresAccountStore, SqliteAccountStore, type AccountStore, type AccountStoreKind } from './store';

/**
 * Las opciones de `iark serve` que activan las cuentas con inicio de sesión de GitHub, comprobadas y convertidas en un `Accounts`. Todas
 * tienen su variable de entorno (para contenedores) salvo el secreto de la OAuth App, que **solo** se acepta por entorno o por archivo:
 * una opción de la línea de comandos se ve en la lista de procesos y en el historial del intérprete.
 */
export interface AccountsCliOptions {
  /** Dónde viven las cuentas con `json` (el archivo) y `sqlite` (la base). Con `postgres` no se usa: la conexión sale del entorno. */
  accounts?: string;
  /** `json` (por omisión), `sqlite` o `postgres`: qué almacén guarda las cuentas. */
  accountsStore?: string;
  /** Con `sqlite` o `postgres`: un JSON de cuentas (o una base SQLite) que se importa al arrancar si la base está vacía (ver `migrate.ts`). */
  accountsImport?: string;
  githubClientId?: string;
  githubUrl?: string;
  githubApiUrl?: string;
  publicUrl?: string;
  signup?: string;
  admins?: string;
  sessionDays?: number;
  /** Proyectos que puede poseer cada persona; `0`, sin tope. */
  maxProjects?: number;
  /** Diagramas que admite cada proyecto; `0`, sin tope. */
  maxDiagrams?: number;
  /** Bytes en total de los proyectos de cada persona (documentos y versiones): un número o un tamaño (`256M`, `2G`); `0`, sin tope. */
  maxBytes?: string | number;
}

export interface AccountsSetupContext {
  /** Hay espacio de trabajo (`--workspace`): las cuentas protegen su API de proyectos. */
  workspace: boolean;
  /** Los orígenes de `--cors`. */
  cors: string[];
  env?: Record<string, string | undefined>;
  /** Dónde cuenta lo que hace al arrancar (la importación del JSON, un aviso). Por omisión, la salida de errores. */
  log?: (line: string) => void;
}

/** El secreto de la OAuth App: `IARK_GITHUB_CLIENT_SECRET` o el contenido de `IARK_GITHUB_CLIENT_SECRET_FILE` (Docker secrets, Kubernetes…). */
export function readClientSecret(env: Record<string, string | undefined>): string | undefined {
  const direct = env.IARK_GITHUB_CLIENT_SECRET?.trim();
  if (direct) return direct;
  const file = env.IARK_GITHUB_CLIENT_SECRET_FILE?.trim();
  if (!file) return undefined;
  let text: string;
  try {
    text = readFileSync(file, 'utf8').trim();
  } catch (error) {
    throw new CliError(`No se pudo leer el secreto de GitHub de «${file}» (${(error as NodeJS.ErrnoException).code ?? 'error'}).`, 2);
  }
  if (!text) throw new CliError(`El archivo del secreto de GitHub «${file}» está vacío.`, 2);
  return text;
}

/** Un error del almacén o de la configuración de la base como error de uso (2) o, si la base no responde, de entorno (1). */
function asCliError(error: unknown): unknown {
  if (error instanceof DatabaseConfigError) return new CliError(error.message, 2);
  if (error instanceof DatabaseError) return new CliError(error.message, error.code === 'incompatible' ? 2 : 1);
  if (error instanceof AccountError) return new CliError(error.message, error.code === 'unreachable' ? 1 : 2);
  return error;
}

/** Importa `importFrom` al almacén si procede y cuenta lo que pasó en una línea (si no hay nada que decir, ninguna). */
async function importAtStartup(target: ImportTarget, importFrom: string, destination: 'sqlite' | 'postgres', log: (line: string) => void): Promise<void> {
  const report = await importAccounts(target, importFrom);
  if (report.status === 'imported') log(describeImport(report, destination));
  else if (report.status === 'target-not-empty') log(`aviso: no se importa «${importFrom}» (IARK_ACCOUNTS_IMPORT): la base ya tiene cuentas que no salen de ese origen. Quite la importación de la configuración.`);
}

/**
 * Abre el almacén y, con SQLite o Postgres y `--accounts-import`, importa el JSON de cuentas (o una base SQLite) si la base está vacía.
 * Postgres no usa `path`: toma la conexión del entorno (la comparte con el almacén de proyectos si lo hay) y la suelta al cerrar el almacén.
 */
async function openStore(kind: AccountStoreKind, path: string | undefined, importFrom: string | undefined, env: Record<string, string | undefined>, log: (line: string) => void): Promise<AccountStore> {
  if (kind === 'json') return asAsync(JsonAccountStore.open(path!));
  if (kind === 'sqlite') {
    const store = SqliteAccountStore.open(path!);
    try {
      if (importFrom) await importAtStartup(store, importFrom, 'sqlite', log);
    } catch (error) {
      store.close();
      throw error;
    }
    return asAsync(store);
  }
  const store = await PostgresAccountStore.open(await acquireDatabase(env), { release: releaseDatabase });
  try {
    if (importFrom) await importAtStartup(store, importFrom, 'postgres', log);
  } catch (error) {
    await store.close().catch(() => undefined);
    throw error;
  }
  return store;
}

/** `undefined` si no se pidió nada de cuentas; si se pidió algo, todo lo necesario o un error de uso que dice qué falta. */
export async function setupAccounts(opts: AccountsCliOptions, context: AccountsSetupContext): Promise<Accounts | undefined> {
  const env = context.env ?? process.env;
  const log = context.log ?? info;
  const secret = readClientSecret(env);
  const kind = (opts.accountsStore ?? 'json').trim().toLowerCase();
  if (!opts.accounts && !opts.githubClientId && !secret && kind !== 'postgres') return undefined;
  if (!isAccountStoreKind(kind)) throw new CliError(`--accounts-store debe ser ${ACCOUNT_STORE_KINDS.map((k) => `«${k}»`).join(', ')}, no «${kind.slice(0, 40)}».`, 2);

  const missing: string[] = [];
  if (kind === 'postgres') {
    if (!hasDatabaseSetting(env)) missing.push('IARK_DATABASE_URL (o IARK_DATABASE_URL_FILE): la conexión de Postgres, postgres://usuario:clave@host:puerto/base; no se acepta por la línea de comandos (docs/postgres.md)');
  } else if (!opts.accounts) {
    missing.push('--accounts <archivo> (o IARK_ACCOUNTS): dónde guardar las cuentas y las sesiones (un JSON, una base SQLite con --accounts-store sqlite; o --accounts-store postgres, que usa IARK_DATABASE_URL)');
  }
  if (!opts.githubClientId) missing.push('--github-client-id <id> (o IARK_GITHUB_CLIENT_ID): el Client ID de la OAuth App de GitHub');
  if (!secret) missing.push('IARK_GITHUB_CLIENT_SECRET (o IARK_GITHUB_CLIENT_SECRET_FILE): el Client secret de la OAuth App; no se acepta por la línea de comandos');
  if (!opts.publicUrl) missing.push('--public-url <https://…> (o IARK_PUBLIC_URL): la dirección pública de este servicio, de donde sale la «Authorization callback URL»');
  if (!context.workspace) missing.push('--workspace <carpeta> (o IARK_WORKSPACE): las cuentas protegen la API de proyectos');
  if (missing.length > 0) throw new CliError(`El inicio de sesión con GitHub necesita todo esto y falta:\n  - ${missing.join('\n  - ')}`, 2);

  if (opts.accountsImport && kind === 'json') throw new CliError('--accounts-import (IARK_ACCOUNTS_IMPORT) solo vale con --accounts-store sqlite o postgres: importa un JSON de cuentas a la base.', 2);
  if (kind === 'postgres' && opts.accounts) log('aviso: --accounts (IARK_ACCOUNTS) no se usa con --accounts-store postgres: las cuentas viven en la base de IARK_DATABASE_URL. Quite la ruta de la configuración.');
  const signup = (opts.signup ?? 'invite').trim().toLowerCase();
  if (signup !== 'open' && signup !== 'invite') throw new CliError(`--signup debe ser «invite» (solo entran las personas invitadas) u «open» (entra cualquiera con cuenta de GitHub), no «${signup.slice(0, 40)}».`, 2);
  if (opts.sessionDays !== undefined && !(Number.isFinite(opts.sessionDays) && opts.sessionDays > 0 && opts.sessionDays <= 365)) throw new CliError('--session-days debe ser un número de días entre 1 y 365.', 2);
  for (const [flag, value] of [['--max-projects', opts.maxProjects], ['--max-diagrams', opts.maxDiagrams]] as const) {
    if (value !== undefined && !(Number.isSafeInteger(value) && value >= 0)) throw new CliError(`${flag} debe ser un entero de 0 en adelante (0 quita el tope).`, 2);
  }
  let maxBytes: number | undefined;
  if (opts.maxBytes !== undefined && opts.maxBytes !== '') {
    try {
      maxBytes = parseByteSize(opts.maxBytes);
    } catch (error) {
      throw new CliError(`--max-bytes (IARK_MAX_BYTES): ${(error as Error).message}`, 2);
    }
  }
  const quotas: Partial<QuotaLimits> = { ...(maxBytes !== undefined ? { bytes: maxBytes } : {}), ...(opts.maxProjects !== undefined ? { projects: opts.maxProjects } : {}), ...(opts.maxDiagrams !== undefined ? { diagramsPerProject: opts.maxDiagrams } : {}) };

  let publicUrl: string;
  let admins: string[];
  try {
    publicUrl = normalizePublicUrl(opts.publicUrl!);
    admins = parseAdminList(opts.admins);
  } catch (error) {
    throw new CliError((error as Error).message, 2);
  }
  for (const [flag, value] of [['--github-url', opts.githubUrl], ['--github-api-url', opts.githubApiUrl]] as const) {
    if (value && !/^https?:\/\//i.test(value)) throw new CliError(`${flag} debe empezar por http:// o https://.`, 2);
  }

  let store: AccountStore;
  try {
    store = await openStore(kind, opts.accounts, opts.accountsImport, env, log);
  } catch (error) {
    throw asCliError(error);
  }
  if (signup === 'invite' && admins.length === 0) {
    let empty: boolean;
    try {
      empty = (await store.userCount()) === 0;
    } catch (error) {
      await store.close().catch(() => undefined);
      throw asCliError(error);
    }
    if (empty) {
      await store.close();
      throw new CliError('Con --signup invite hace falta al menos un administrador para que alguien pueda entrar: indícalo con --admins <usuario> (o IARK_ADMINS), mejor por su identificador numérico de GitHub.', 2);
    }
  }

  return new Accounts({
    store,
    github: new GithubOAuth({ clientId: opts.githubClientId!, clientSecret: secret!, baseUrl: opts.githubUrl, apiUrl: opts.githubApiUrl }),
    publicUrl,
    signup: signup as SignupMode,
    admins,
    sessionTtlMs: opts.sessionDays === undefined ? undefined : opts.sessionDays * 24 * 3600 * 1000,
    allowedOrigins: context.cors,
    quotas,
  });
}
