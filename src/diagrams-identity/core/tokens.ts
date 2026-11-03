import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync, type Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { cleanName, nameKey, ProjectError, sameName } from '@iark/kernel';

/**
 * Tokens de acceso de `iark serve` (con `--tokens <archivo>`): una «cuenta» es un token que emite quien administra el servidor,
 * con un nombre (la persona) y un rol. El archivo guarda solo el **hash** (sha256) de cada token, nunca el token: quien lea
 * el archivo no puede usarlo, y el token se muestra una sola vez, al crearlo.
 *
 *   { "version": 1, "tokens": [{ "name": "Ana", "role": "editor", "hash": "<sha256 en hex>", "createdAt": "<ISO 8601>" }] }
 *
 * Este módulo tiene dos mitades: las operaciones de administración sobre el archivo (`createToken`, `listTokens`,
 * `revokeToken`; las usa `iark auth`) y `TokenStore`, que es lo que lee el servidor: recarga el archivo cuando cambia (revocar o
 * crear surte efecto sin reiniciar) y, si no puede leerlo o está dañado, deniega todo el acceso en vez de abrirlo.
 * Solo usa `node:` (nada de dependencias).
 */

/** Los roles, de menos a más permisos: `viewer` solo lee; `editor` además escribe diagramas y crea/renombra proyectos; `admin` además borra proyectos. */
export const TOKEN_ROLES = ['viewer', 'editor', 'admin'] as const;
export type TokenRole = (typeof TOKEN_ROLES)[number];

const RANK: Record<TokenRole, number> = { viewer: 0, editor: 1, admin: 2 };

/** ¿Un token con este rol puede hacer lo que exige `needed`? Cada rol incluye los de abajo. */
export const roleAllows = (role: TokenRole, needed: TokenRole): boolean => RANK[role] >= RANK[needed];

export const isTokenRole = (value: unknown): value is TokenRole => typeof value === 'string' && (TOKEN_ROLES as readonly string[]).includes(value);

export const TOKEN_FILE_VERSION = 1;
export const TOKEN_PREFIX = 'iark_';

/** Un token del archivo: el hash, no el token. */
export interface TokenRecord {
  name: string;
  role: TokenRole;
  /** sha256 del token, en hexadecimal (64 caracteres). */
  hash: string;
  /** Fecha de creación (ISO 8601, UTC). */
  createdAt: string;
}

export interface TokenFile {
  version: typeof TOKEN_FILE_VERSION;
  tokens: TokenRecord[];
}

/** Lo que se puede enseñar de un token (nunca su hash): lo que imprime `iark auth list`. */
export type TokenSummary = Omit<TokenRecord, 'hash'>;

/** Quién es el dueño de un token que se presentó. */
export interface TokenIdentity {
  name: string;
  role: TokenRole;
}

export type TokenErrorCode =
  /** Nombre o rol que no se pueden aceptar. */
  | 'invalid'
  /** Ya hay un token con ese nombre. */
  | 'exists'
  /** No existe el token o el archivo. */
  | 'not-found'
  /** El archivo existe pero no es un archivo de tokens válido. */
  | 'corrupt'
  /** No se puede leer o escribir (permisos, disco, no es un archivo). */
  | 'unavailable';

export class TokenError extends Error {
  constructor(
    readonly code: TokenErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TokenError';
  }
}

// ───────────── tokens: generar y comprobar ─────────────

/** Un token nuevo: `iark_` y 32 bytes aleatorios en base64url (256 bits). */
export const generateToken = (): string => `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;

/** El hash que se guarda de un token: sha256 en hexadecimal. */
export const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

const HASH = /^[0-9a-f]{64}$/i;

/** Rol indicado por una persona (`--role Editor`): minúsculas y sin espacios alrededor. */
export function parseRole(value: unknown): TokenRole {
  const role = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!isTokenRole(role)) throw new TokenError('invalid', `Rol inválido «${String(value ?? '').slice(0, 40)}»: use ${TOKEN_ROLES.slice(0, -1).join(', ')} o ${TOKEN_ROLES[TOKEN_ROLES.length - 1]}.`);
  return role;
}

/** El nombre de un token, con las mismas reglas que el de un proyecto (sin caracteres de control, sin pasar de 120 caracteres). */
function tokenName(raw: unknown): string {
  try {
    return cleanName(raw, 'del token');
  } catch (error) {
    if (error instanceof ProjectError) throw new TokenError('invalid', error.message);
    throw error;
  }
}

// ───────────── el archivo ─────────────

const MAX_FILE_BYTES = 4 * 1024 * 1024;

const corrupt = (reason: string): TokenError => new TokenError('corrupt', `El archivo de tokens no es válido (${reason}).`);

/**
 * Interpreta el contenido del archivo. Es estricto a propósito: ante la menor duda (versión desconocida, un campo que falta, un
 * nombre o un hash repetidos) lo rechaza entero, y quien lo lea denegará todo. Los motivos nunca citan el contenido.
 */
export function parseTokenFile(text: string): TokenFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw corrupt('no es un JSON válido');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw corrupt('la raíz debe ser un objeto');
  const { version, tokens } = value as { version?: unknown; tokens?: unknown };
  if (version !== TOKEN_FILE_VERSION) throw corrupt(`versión no admitida; se esperaba ${TOKEN_FILE_VERSION}`);
  if (!Array.isArray(tokens)) throw corrupt('falta la lista "tokens"');
  const names = new Set<string>();
  const hashes = new Set<string>();
  const records = tokens.map((entry: unknown, index): TokenRecord => {
    const at = `tokens[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw corrupt(`${at} debe ser un objeto`);
    const { name, role, hash, createdAt } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim()) throw corrupt(`${at}: falta "name"`);
    if (!isTokenRole(role)) throw corrupt(`${at}: "role" debe ser ${TOKEN_ROLES.join(', ')}`);
    if (typeof hash !== 'string' || !HASH.test(hash)) throw corrupt(`${at}: "hash" debe ser un sha256 en hexadecimal`);
    if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) throw corrupt(`${at}: "createdAt" debe ser una fecha ISO 8601`);
    if (names.has(nameKey(name))) throw corrupt(`${at}: nombre repetido`);
    if (hashes.has(hash.toLowerCase())) throw corrupt(`${at}: hash repetido`);
    names.add(nameKey(name));
    hashes.add(hash.toLowerCase());
    return { name, role, hash: hash.toLowerCase(), createdAt };
  });
  return { version: TOKEN_FILE_VERSION, tokens: records };
}

/** Cambia si el archivo cambia: su fecha de modificación y de cambio, su tamaño y su inodo (un guardado atómico estrena inodo, aunque el reloj del sistema de archivos sea grueso). */
const signatureOf = (stat: Stats): string => `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}:${stat.mode}`;

const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

/** El texto del archivo y su firma, tomados del mismo descriptor (la firma es la de lo que se leyó). */
function readSnapshot(path: string): { text: string; signature: string } {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    if (errno(error) === 'ENOENT') throw new TokenError('not-found', `No existe el archivo de tokens «${path}»: créelo con \`iark auth create <nombre> --role admin --tokens ${path}\`.`);
    throw new TokenError('unavailable', `No se pudo leer el archivo de tokens «${path}» (${errno(error) ?? (error as Error).message}).`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new TokenError('unavailable', `«${path}» no es un archivo (¿una carpeta? Con Docker, montar un archivo que no existía crea una carpeta con ese nombre).`);
    if (stat.size > MAX_FILE_BYTES) throw corrupt(`pasa de ${MAX_FILE_BYTES} bytes`);
    return { text: readFileSync(fd, 'utf8'), signature: signatureOf(stat) };
  } catch (error) {
    if (error instanceof TokenError) throw error;
    throw new TokenError('unavailable', `No se pudo leer el archivo de tokens «${path}» (${errno(error) ?? (error as Error).message}).`);
  } finally {
    closeSync(fd);
  }
}

/**
 * Escribe el archivo de forma atómica (a un temporal del mismo directorio y `rename`: quien lo lea nunca ve la mitad) y con modo
 * 0600. Al reemplazar, el archivo nuevo es un inodo nuevo: el servidor lo nota aunque la fecha no se distinga.
 */
export function writeTokenFile(path: string, file: TokenFile): void {
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  let fd: number | undefined;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    fd = openSync(tmp, 'wx', 0o600);
    writeSync(fd, `${JSON.stringify(file, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ya estaba cerrado
      }
    }
    rmSync(tmp, { force: true });
    throw new TokenError('unavailable', `No se pudo escribir el archivo de tokens «${path}» (${errno(error) ?? (error as Error).message}).`);
  }
}

/** El archivo para modificarlo. Dañado, nunca se reemplaza: el error le dice a quien administra que lo mire. Sin archivo, con `create` se parte de uno vacío. */
function loadForEdit(path: string, create: boolean): TokenFile {
  try {
    return parseTokenFile(readSnapshot(path).text);
  } catch (error) {
    if (create && error instanceof TokenError && error.code === 'not-found') return { version: TOKEN_FILE_VERSION, tokens: [] };
    throw error;
  }
}

const summary = ({ name, role, createdAt }: TokenRecord): TokenSummary => ({ name, role, createdAt });

/**
 * Crea un token y guarda su hash (el archivo se crea si no existe). Devuelve el token: es la única vez que se conoce. Un nombre
 * repetido (sin distinguir mayúsculas) es el error `exists`. Dos administradores a la vez pueden pisarse el cambio: una
 * persona cada vez.
 */
export function createToken(path: string, input: { name: string; role: string }, now: Date = new Date()): { token: string; record: TokenSummary } {
  const role = parseRole(input.role);
  const name = tokenName(input.name);
  const file = loadForEdit(path, true);
  if (file.tokens.some((t) => sameName(t.name, name))) throw new TokenError('exists', `Ya existe un token llamado «${name}».`);
  const token = generateToken();
  const record: TokenRecord = { name, role, hash: hashToken(token), createdAt: now.toISOString() };
  writeTokenFile(path, { version: TOKEN_FILE_VERSION, tokens: [...file.tokens, record] });
  return { token, record: summary(record) };
}

/** Los tokens del archivo, sin hash. Sin archivo es el error `not-found`. */
export const listTokens = (path: string): TokenSummary[] => loadForEdit(path, false).tokens.map(summary);

/** Revoca un token por su nombre (sin distinguir mayúsculas). El servidor lo deja de aceptar en cuanto ve el archivo nuevo. */
export function revokeToken(path: string, name: string): TokenSummary {
  const file = loadForEdit(path, false);
  const found = file.tokens.find((t) => sameName(t.name, name));
  if (!found) throw new TokenError('not-found', `No existe ningún token llamado «${String(name).slice(0, 120)}» (ver \`iark auth list\`).`);
  writeTokenFile(path, { version: TOKEN_FILE_VERSION, tokens: file.tokens.filter((t) => t !== found) });
  return summary(found);
}

// ───────────── lo que lee el servidor ─────────────

export type TokenLookup = ({ status: 'ok' } & TokenIdentity) | { status: 'unknown' } | { status: 'unavailable' };

interface Entry extends TokenIdentity {
  digest: Buffer;
}

const logToStderr = (message: string): void => void process.stderr.write(`${message}\n`);

/**
 * Los tokens del archivo, para el servidor. Se vuelve a leer cuando el archivo cambia (revocar o crear surte efecto sin
 * reiniciar). Si no se puede leer o está dañado, **no queda ningún token válido**: todo se deniega hasta que el archivo vuelva a
 * estar bien. Lo que informa de un problema (a `log`, por omisión stderr) nunca incluye tokens, hashes ni el contenido.
 *
 * Usa llamadas síncronas: el archivo es pequeño y se mira una vez por petición con un `stat`.
 */
export class TokenStore {
  private entries: Entry[] = [];
  private signature: string | undefined;
  private failure: string | undefined;

  private constructor(
    readonly path: string,
    private readonly log: (message: string) => void,
  ) {}

  /** Abre el archivo. Al arrancar el servicio sí falla (`TokenError`) si no existe o no es válido: así una errata en la ruta no deja un servidor que rechaza a todos sin decir por qué. */
  static open(path: string, log: (message: string) => void = logToStderr): TokenStore {
    const store = new TokenStore(path, log);
    const { text, signature } = readSnapshot(path);
    store.entries = TokenStore.entriesOf(parseTokenFile(text));
    store.signature = signature;
    return store;
  }

  private static entriesOf(file: TokenFile): Entry[] {
    return file.tokens.map((t) => ({ name: t.name, role: t.role, digest: Buffer.from(t.hash, 'hex') }));
  }

  /** Cuántos tokens válidos hay ahora (0 si el archivo no se puede usar). */
  get size(): number {
    return this.entries.length;
  }

  /** El motivo por el que se está denegando todo, o `undefined` si el archivo es válido. */
  get problem(): string | undefined {
    return this.failure;
  }

  /** Vuelve a leer el archivo si cambió. Nunca lanza: un problema cierra el acceso y se anota. */
  refresh(): void {
    let current: string | undefined;
    try {
      current = signatureOf(statSync(this.path));
    } catch {
      current = undefined; // no existe o no se puede ver: se intenta leer abajo y se informa del motivo
    }
    if (current !== undefined && current === this.signature) return;
    this.signature = undefined;
    try {
      const snapshot = readSnapshot(this.path);
      this.signature = snapshot.signature; // también si está dañado: no se vuelve a leer hasta que cambie
      this.entries = TokenStore.entriesOf(parseTokenFile(snapshot.text));
      this.log(`archivo de tokens recargado: ${this.entries.length} token(s)${this.failure ? ' (vuelve a haber acceso)' : ''}.`);
      this.failure = undefined;
    } catch (error) {
      this.entries = [];
      const message = error instanceof TokenError ? error.message : 'error inesperado al leer el archivo de tokens';
      if (message !== this.failure) this.log(`error: ${message} Se deniega todo el acceso hasta que el archivo vuelva a ser válido.`);
      this.failure = message;
    }
  }

  /**
   * ¿De quién es este token? Refresca el archivo antes. Con `undefined` solo comprueba que el archivo sea utilizable. La
   * comparación es en tiempo constante: se mira el hash del token contra todos los guardados, sin cortar al encontrarlo.
   */
  lookup(token: string | undefined): TokenLookup {
    this.refresh();
    if (this.failure !== undefined) return { status: 'unavailable' };
    if (token === undefined) return { status: 'unknown' };
    const digest = createHash('sha256').update(token, 'utf8').digest();
    let found: Entry | undefined;
    for (const entry of this.entries) {
      if (timingSafeEqual(digest, entry.digest) && !found) found = entry;
    }
    return found ? { status: 'ok', name: found.name, role: found.role } : { status: 'unknown' };
  }
}
