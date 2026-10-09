import { readFileSync } from 'node:fs';

/**
 * La conexión a Postgres de `iark serve` (Supabase, Neon, RDS o uno propio), leída SOLO del entorno: la cadena de conexión lleva la
 * contraseña de la base, así que nunca viaja por la línea de comandos (se vería en `ps` y en el historial), igual que el secreto de la
 * OAuth App. Aquí no hay red: solo se leen y validan las variables; abrir la conexión es `pool.ts`.
 *
 *   IARK_DATABASE_URL          postgres://usuario:clave@host:puerto/base   (o IARK_DATABASE_URL_FILE: la ruta de un archivo que la contiene)
 *   IARK_DATABASE_SSL          verify | no-verify | off   (por omisión, `verify`, salvo en localhost o un socket, donde es `off`)
 *   IARK_DATABASE_CA_FILE      un certificado de autoridad (PEM) con el que comprobar al servidor (Supabase publica el suyo)
 *   IARK_DATABASE_POOL         conexiones simultáneas como máximo por proceso (1 a 50; por omisión 10)
 *   IARK_DATABASE_SCHEMA       el esquema donde viven las tablas de IArk (por omisión `iark`, NO `public`: ver `migrate.ts`)
 *
 * Una `sslmode` dentro de la cadena se respeta solo en dos casos (`disable` y `verify-full`/`verify-ca`); el resto (`require`,
 * `prefer`…) en libpq NO comprueba al servidor y aquí sí se comprueba, salvo que se pida `IARK_DATABASE_SSL=no-verify`. El resto de
 * parámetros de la cadena se conservan.
 */

export const SSL_MODES = ['verify', 'no-verify', 'off'] as const;
export type SslMode = (typeof SSL_MODES)[number];

export class DatabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseConfigError';
  }
}

export interface DatabaseConfig {
  /** La cadena de conexión SIN `sslmode` (el modo TLS va aparte, en `ssl`). Lleva la contraseña: no se escribe en ningún registro. */
  connectionString: string;
  sslMode: SslMode;
  /** Lo que se le pasa al cliente `pg`: `false` sin TLS; con TLS, si se comprueba el certificado y con qué autoridad. */
  ssl: false | { rejectUnauthorized: boolean; ca?: string };
  poolMax: number;
  /** El esquema (ya validado) donde viven las tablas. */
  schema: string;
  /** Para mensajes: `postgres://usuario@host:puerto/base`, sin la contraseña. */
  description: string;
}

export const DEFAULT_POOL_MAX = 10;
export const MAX_POOL_MAX = 50;
export const DEFAULT_SCHEMA = 'iark';

/** Un identificador de esquema sin comillas: letras minúsculas, dígitos y `_`, hasta 40 caracteres, sin empezar por dígito. */
const SCHEMA = /^[a-z_][a-z0-9_]{0,39}$/;
const RESERVED_SCHEMAS = new Set(['public', 'pg_catalog', 'information_schema', 'auth', 'storage', 'realtime', 'extensions', 'graphql', 'graphql_public', 'vault', 'pgsodium', 'supabase_functions', 'supabase_migrations']);

export const isSchemaName = (value: unknown): value is string => typeof value === 'string' && SCHEMA.test(value) && !value.startsWith('pg_');

/** Quita la contraseña de una cadena de conexión para poder mostrarla. */
export function describeConnection(url: URL): string {
  const user = url.username ? `${decodeURIComponent(url.username)}@` : '';
  return `${url.protocol}//${user}${url.host}${url.pathname}`;
}

const isLocalHost = (host: string): boolean => {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === '' || h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.startsWith('/') || h.startsWith('%2f');
};

/** El texto de una variable o el contenido del archivo de su variante `_FILE` (Docker secrets, Render Secret Files, Kubernetes…). */
function readSetting(env: NodeJS.ProcessEnv, name: string, readFile: (path: string) => string): string | undefined {
  const direct = env[name]?.trim();
  const file = env[`${name}_FILE`]?.trim();
  if (direct && file) throw new DatabaseConfigError(`Defina ${name} o ${name}_FILE, no las dos.`);
  if (file) {
    try {
      return readFile(file).trim() || undefined;
    } catch (error) {
      throw new DatabaseConfigError(`No se pudo leer «${file}» (${name}_FILE): ${(error as NodeJS.ErrnoException).code ?? 'error'}.`);
    }
  }
  return direct || undefined;
}

/**
 * ¿Hay una base configurada? Sin mirar el contenido (para decidir si hay que exigirla o si hay que avisar de que se ignora).
 */
export const hasDatabaseSetting = (env: NodeJS.ProcessEnv = process.env): boolean => Boolean(env.IARK_DATABASE_URL?.trim() || env.IARK_DATABASE_URL_FILE?.trim());

/** Lee y valida la configuración de la base. Lanza `DatabaseConfigError` con un mensaje que dice qué variable corregir y nunca repite la contraseña. */
export function resolveDatabaseConfig(env: NodeJS.ProcessEnv = process.env, readFile: (path: string) => string = (path) => readFileSync(path, 'utf8')): DatabaseConfig {
  const raw = readSetting(env, 'IARK_DATABASE_URL', readFile);
  if (!raw) {
    throw new DatabaseConfigError('Falta IARK_DATABASE_URL (o IARK_DATABASE_URL_FILE): la cadena de conexión de Postgres, postgres://usuario:clave@host:puerto/base. No se acepta por la línea de comandos.');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DatabaseConfigError('IARK_DATABASE_URL no es una dirección válida; debe ser postgres://usuario:clave@host:puerto/base (si la clave lleva símbolos como @ : / # ? hay que codificarlos con %XX).');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new DatabaseConfigError(`IARK_DATABASE_URL debe empezar por postgres:// o postgresql://, no por «${url.protocol}//».`);
  }
  if (!url.hostname) throw new DatabaseConfigError('IARK_DATABASE_URL no dice el servidor (host).');
  if (url.pathname.length <= 1) throw new DatabaseConfigError('IARK_DATABASE_URL no dice la base de datos (el último tramo, /postgres en Supabase).');
  const description = describeConnection(url);

  // El modo TLS: lo decide IARK_DATABASE_SSL; sin él, una `sslmode` de la cadena que sea inequívoca; sin ninguna, `verify` fuera de localhost.
  const fromUrl = url.searchParams.get('sslmode')?.toLowerCase();
  url.searchParams.delete('sslmode');
  url.searchParams.delete('sslcert');
  url.searchParams.delete('sslkey');
  url.searchParams.delete('sslrootcert');
  const requested = env.IARK_DATABASE_SSL?.trim().toLowerCase();
  let sslMode: SslMode;
  if (requested) {
    if (!(SSL_MODES as readonly string[]).includes(requested)) {
      throw new DatabaseConfigError(`IARK_DATABASE_SSL debe ser ${SSL_MODES.map((m) => `«${m}»`).join(', ')}, no «${requested.slice(0, 20)}».`);
    }
    sslMode = requested as SslMode;
  } else if (fromUrl === 'disable') sslMode = 'off';
  else if (fromUrl === 'verify-full' || fromUrl === 'verify-ca') sslMode = 'verify';
  else sslMode = isLocalHost(url.hostname) ? 'off' : 'verify';

  let ca: string | undefined;
  const caFile = env.IARK_DATABASE_CA_FILE?.trim();
  if (caFile) {
    try {
      ca = readFile(caFile);
    } catch (error) {
      throw new DatabaseConfigError(`No se pudo leer «${caFile}» (IARK_DATABASE_CA_FILE): ${(error as NodeJS.ErrnoException).code ?? 'error'}.`);
    }
    if (!ca.includes('BEGIN CERTIFICATE')) throw new DatabaseConfigError(`«${caFile}» (IARK_DATABASE_CA_FILE) no parece un certificado PEM (falta «BEGIN CERTIFICATE»).`);
    if (sslMode === 'off') throw new DatabaseConfigError('IARK_DATABASE_CA_FILE no tiene sentido con IARK_DATABASE_SSL=off.');
  }
  const ssl = sslMode === 'off' ? false : { rejectUnauthorized: sslMode === 'verify', ...(ca ? { ca } : {}) };

  let poolMax = DEFAULT_POOL_MAX;
  const poolText = env.IARK_DATABASE_POOL?.trim();
  if (poolText) {
    const n = Number(poolText);
    if (!Number.isInteger(n) || n < 1 || n > MAX_POOL_MAX) throw new DatabaseConfigError(`IARK_DATABASE_POOL debe ser un entero de 1 a ${MAX_POOL_MAX}, no «${poolText.slice(0, 20)}».`);
    poolMax = n;
  }

  const schema = env.IARK_DATABASE_SCHEMA?.trim() || DEFAULT_SCHEMA;
  if (!isSchemaName(schema)) {
    throw new DatabaseConfigError(`IARK_DATABASE_SCHEMA debe ser un nombre en minúsculas (letras, dígitos y _, hasta 40 caracteres), no «${String(schema).slice(0, 40)}».`);
  }
  if (RESERVED_SCHEMAS.has(schema)) {
    throw new DatabaseConfigError(`IARK_DATABASE_SCHEMA no puede ser «${schema}»: es un esquema del sistema o de Supabase y IArk no guarda sus tablas ahí (en Supabase, el esquema «public» se expone por la API pública).`);
  }

  return { connectionString: url.toString(), sslMode, ssl, poolMax, schema, description };
}
