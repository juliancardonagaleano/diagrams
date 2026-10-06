import { readFileSync } from 'node:fs';
import { CliError } from '../io';
import { GithubOAuth } from './github';
import { Accounts, normalizePublicUrl, parseAdminList, type SignupMode } from './service';
import { AccountError, AccountStore } from './store';

/**
 * Las opciones de `iark serve` que activan las cuentas con inicio de sesión de GitHub, comprobadas y convertidas en un `Accounts`. Todas
 * tienen su variable de entorno (para contenedores) salvo el secreto de la OAuth App, que **solo** se acepta por entorno o por archivo:
 * una opción de la línea de comandos se ve en la lista de procesos y en el historial del intérprete.
 */
export interface AccountsCliOptions {
  accounts?: string;
  githubClientId?: string;
  githubUrl?: string;
  githubApiUrl?: string;
  publicUrl?: string;
  signup?: string;
  admins?: string;
  sessionDays?: number;
  maxProjects?: number;
}

export interface AccountsSetupContext {
  /** Hay espacio de trabajo (`--workspace`): las cuentas protegen su API de proyectos. */
  workspace: boolean;
  /** Los orígenes de `--cors`. */
  cors: string[];
  env?: Record<string, string | undefined>;
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

/** `undefined` si no se pidió nada de cuentas; si se pidió algo, todo lo necesario o un error de uso que dice qué falta. */
export function setupAccounts(opts: AccountsCliOptions, context: AccountsSetupContext): Accounts | undefined {
  const env = context.env ?? process.env;
  const secret = readClientSecret(env);
  if (!opts.accounts && !opts.githubClientId && !secret) return undefined;

  const missing: string[] = [];
  if (!opts.accounts) missing.push('--accounts <archivo> (o IARK_ACCOUNTS): dónde guardar las cuentas y las sesiones');
  if (!opts.githubClientId) missing.push('--github-client-id <id> (o IARK_GITHUB_CLIENT_ID): el Client ID de la OAuth App de GitHub');
  if (!secret) missing.push('IARK_GITHUB_CLIENT_SECRET (o IARK_GITHUB_CLIENT_SECRET_FILE): el Client secret de la OAuth App; no se acepta por la línea de comandos');
  if (!opts.publicUrl) missing.push('--public-url <https://…> (o IARK_PUBLIC_URL): la dirección pública de este servicio, de donde sale la «Authorization callback URL»');
  if (!context.workspace) missing.push('--workspace <carpeta> (o IARK_WORKSPACE): las cuentas protegen la API de proyectos');
  if (missing.length > 0) throw new CliError(`El inicio de sesión con GitHub necesita todo esto y falta:\n  - ${missing.join('\n  - ')}`, 2);

  const signup = (opts.signup ?? 'invite').trim().toLowerCase();
  if (signup !== 'open' && signup !== 'invite') throw new CliError(`--signup debe ser «invite» (solo entran las personas invitadas) u «open» (entra cualquiera con cuenta de GitHub), no «${signup.slice(0, 40)}».`, 2);
  if (opts.sessionDays !== undefined && !(Number.isFinite(opts.sessionDays) && opts.sessionDays > 0 && opts.sessionDays <= 365)) throw new CliError('--session-days debe ser un número de días entre 1 y 365.', 2);
  if (opts.maxProjects !== undefined && !(Number.isInteger(opts.maxProjects) && opts.maxProjects >= 1)) throw new CliError('--max-projects debe ser un entero de al menos 1.', 2);

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
    store = AccountStore.open(opts.accounts!);
  } catch (error) {
    if (error instanceof AccountError) throw new CliError(error.message, 2);
    throw error;
  }
  if (signup === 'invite' && admins.length === 0 && store.userCount === 0) {
    throw new CliError('Con --signup invite hace falta al menos un administrador para que alguien pueda entrar: indícalo con --admins <usuario> (o IARK_ADMINS), mejor por su identificador numérico de GitHub.', 2);
  }

  return new Accounts({
    store,
    github: new GithubOAuth({ clientId: opts.githubClientId!, clientSecret: secret!, baseUrl: opts.githubUrl, apiUrl: opts.githubApiUrl }),
    publicUrl,
    signup: signup as SignupMode,
    admins,
    sessionTtlMs: opts.sessionDays === undefined ? undefined : opts.sessionDays * 24 * 3600 * 1000,
    allowedOrigins: context.cors,
    maxProjectsPerUser: opts.maxProjects,
  });
}
