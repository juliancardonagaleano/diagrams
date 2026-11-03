import type { Command } from 'commander';
import { CliError, info } from './io';
import { createToken, listTokens, revokeToken, TOKEN_ROLES } from '../diagrams-identity/core/tokens';

/**
 * `iark auth`: administra los tokens que `iark serve --tokens <archivo>` exige a quien llama a la API de proyectos. Una «cuenta»
 * es un token que emite quien administra el servidor: se crea con un nombre y un rol, se da a la persona una sola vez y se revoca
 * por su nombre. El archivo solo guarda el hash (ver `tokens.ts`); el servidor lo relee cuando cambia, así que crear o revocar
 * surte efecto sin reiniciarlo.
 */

const TOKENS_HELP = 'archivo de tokens (o la variable IARK_TOKENS)';

interface TokensOptions {
  tokens?: string;
}

/** El archivo de tokens indicado con `--tokens` o con `IARK_TOKENS`. */
function tokensFile(opts: TokensOptions): string {
  const file = opts.tokens || process.env.IARK_TOKENS;
  if (!file) throw new CliError('Indique el archivo de tokens con --tokens <archivo> o con la variable IARK_TOKENS.', 2);
  return file;
}

/** `2026-10-03T12:34:56.789Z` → `2026-10-03 12:34Z` (UTC). */
const when = (isoDate: string): string => `${isoDate.slice(0, 10)} ${isoDate.slice(11, 16)}Z`;

const writeLine = (text: string): void => void process.stdout.write(`${text}\n`);

export function registerAuth(program: Command): void {
  const auth = program
    .command('auth')
    .description(
      'Tokens de acceso de `iark serve --tokens`: uno por persona, con un rol. viewer solo lee; editor además guarda y borra diagramas, y crea y renombra proyectos (también importa); admin además borra proyectos',
    );
  const sub = (name: string) => auth.command(name).option('-t, --tokens <archivo>', TOKENS_HELP);

  sub('create')
    .description('Crea un token y lo imprime UNA vez en la salida estándar (en el archivo solo queda su hash; se crea con modo 0600 si no existe)')
    .argument('<nombre>', 'nombre de la persona (o del servicio); no puede repetirse, sin distinguir mayúsculas')
    .option('--role <rol>', `rol del token: ${TOKEN_ROLES.join(', ')}`)
    .action((name: string, opts: TokensOptions & { role?: string }) => {
      if (!opts.role) throw new CliError(`Falta --role: ${TOKEN_ROLES.join(', ')}.`, 2);
      const file = tokensFile(opts);
      const { token, record } = createToken(file, { name, role: opts.role });
      process.stdout.write(`${token}\n`);
      info(`Token de «${record.name}» (${record.role}) creado en ${file}. Guárdelo ahora: no se vuelve a mostrar (el archivo solo guarda su hash). Se usa con la cabecera «Authorization: Bearer <token>».`);
    });

  sub('list')
    .description('Lista los tokens (nombre, rol y fecha de creación; nunca el hash ni el token)')
    .option('--json', 'salida en JSON', false)
    .action((opts: TokensOptions & { json: boolean }) => {
      const file = tokensFile(opts);
      const tokens = listTokens(file);
      if (opts.json) return void process.stdout.write(`${JSON.stringify(tokens, null, 2)}\n`);
      if (tokens.length === 0) return writeLine(`No hay tokens en «${file}». Cree uno con: iark auth create <nombre> --role admin --tokens ${file}`);
      const width = Math.max(...tokens.map((t) => t.name.length));
      for (const t of tokens) writeLine(`${t.name.padEnd(width)}  ${t.role.padEnd(6)}  ${when(t.createdAt)}`);
    });

  sub('revoke')
    .description('Revoca un token por su nombre: un servidor en marcha deja de aceptarlo en cuanto ve el archivo nuevo')
    .argument('<nombre>', 'nombre del token (ver `iark auth list`)')
    .action((name: string, opts: TokensOptions) => {
      const revoked = revokeToken(tokensFile(opts), name);
      writeLine(`Token de «${revoked.name}» (${revoked.role}) revocado. Un servidor en marcha lo deja de aceptar en cuanto ve el archivo nuevo.`);
    });
}
