import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { MODULE_ID_PATTERN } from '@iark/kernel';
import { z } from 'zod';

/**
 * `iark.config.json`: qué módulos de terceros carga el CLI y el servicio, además de los seis incorporados. Es solo JSON a
 * propósito (la configuración no ejecuta código): lo que ejecuta código es cargar los módulos que nombra, y por eso se carga
 * únicamente de una configuración que la persona puso a mano en su máquina (`--config`, `IARK_CONFIG` o el `iark.config.json`
 * del directorio actual), nunca de lo que haya dentro de un proyecto clonado (`--from-repo`), un espacio de trabajo
 * (`--workspace`), una petición HTTP ni un documento. Ver docs/plugins.md.
 */

export const CONFIG_FILE_NAME = 'iark.config.json';

/** Error de uso de la configuración (no existe, no es JSON, no cumple el esquema): el CLI lo muestra y sale con código 2. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const iarkConfigSchema = z
  .object({
    $schema: z.string().optional().describe('Dirección del JSON Schema de este archivo (para el editor); DIAgrams la ignora.'),
    modules: z
      .array(z.string().min(1))
      .default([])
      .describe(
        'Módulos de terceros que se cargan, en este orden: un nombre de paquete npm (@acme/iark-module-riesgos, resuelto desde la carpeta de este archivo), ' +
          'una ruta a un archivo .mjs/.js o a la carpeta de un paquete (relativa a la carpeta de este archivo) o una URL file:. ' +
          'Cargar un módulo ejecuta su código con los permisos del proceso.',
      ),
    defaultModule: z
      .string()
      .regex(MODULE_ID_PATTERN)
      .optional()
      .describe('Módulo que usan por omisión los comandos con --module (por omisión, c4). Debe ser un módulo incorporado o uno de los cargados.'),
  })
  .strict();

export type IarkConfigFile = z.infer<typeof iarkConfigSchema>;

/** El JSON Schema publicado en `schema/iark-config.schema.json` (lo escribe `npm run schema` y una prueba comprueba que está al día). */
export function iarkConfigJsonSchema(): Record<string, unknown> {
  return {
    $id: 'https://github.com/juliancardonagaleano/DIAgrams/schema/iark-config.schema.json',
    title: 'Configuración de DIAgrams (iark.config.json)',
    ...(z.toJSONSchema(iarkConfigSchema, { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>),
  };
}

/** Una configuración leída y validada. */
export interface LoadedConfig {
  /** Ruta absoluta del archivo. */
  path: string;
  /** Su carpeta: respecto a ella se resuelven las rutas y los paquetes de `modules`. */
  dir: string;
  modules: string[];
  defaultModule?: string;
}

/** Lee y valida un archivo de configuración. Falla con `ConfigError` (mensaje que nombra el archivo y qué está mal). */
export function readConfig(path: string): LoadedConfig {
  const file = resolve(path);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new ConfigError(`No se pudo leer el archivo de configuración «${file}»: ${(error as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^﻿/, ''));
  } catch (error) {
    throw new ConfigError(`El archivo de configuración «${file}» no es JSON válido: ${(error as Error).message}`);
  }
  const parsed = iarkConfigSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `- ${i.path.length > 0 ? `${i.path.join('.')}: ` : ''}${i.message}`).join('\n');
    throw new ConfigError(`El archivo de configuración «${file}» no es válido:\n${issues}`);
  }
  return { path: file, dir: dirname(file), modules: parsed.data.modules, ...(parsed.data.defaultModule ? { defaultModule: parsed.data.defaultModule } : {}) };
}

// ───────────── qué configuración se usa ─────────────

/** Las opciones de la línea de comandos que deciden qué configuración se carga, leídas antes de construir el árbol de comandos. */
export interface GlobalFlags {
  /** `--config <archivo>`. */
  config?: string;
  /** `--no-config`. */
  noConfig: boolean;
  /** `--workspace <carpeta>` (o `-w`): los proyectos de esa carpeta no son de fiar. */
  workspace: string[];
  /** `--from-repo <carpeta|url>`: el contenido de un repositorio ajeno tampoco. */
  fromRepo: string[];
}

const VALUE_FLAGS: Record<string, 'config' | 'workspace' | 'fromRepo'> = { '--config': 'config', '--workspace': 'workspace', '-w': 'workspace', '--from-repo': 'fromRepo' };

/**
 * Lee de los argumentos (sin `node` ni el guion) las opciones que influyen en la configuración. No sustituye a commander, que
 * las vuelve a leer y valida después: hace falta ANTES de construir el árbol de comandos, porque los comandos de un módulo de
 * terceros (`iark <módulo> …`) salen de los módulos cargados. Respeta `--` (lo que sigue ya no son opciones).
 */
export function scanGlobalFlags(args: readonly string[]): GlobalFlags {
  const flags: GlobalFlags = { noConfig: false, workspace: [], fromRepo: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') break;
    if (arg === '--no-config') {
      flags.noConfig = true;
      continue;
    }
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const target = VALUE_FLAGS[name];
    if (!target) continue;
    const value = eq > 0 ? arg.slice(eq + 1) : args[(i += 1)];
    if (value === undefined || value === '') continue; // commander avisará del valor que falta
    if (target === 'config') flags.config = value;
    else flags[target].push(value);
  }
  return flags;
}

/** Qué configuración se carga (o por qué ninguna). */
export type ConfigSelection =
  | { kind: 'none'; note?: string }
  | { kind: 'file'; path: string; via: '--config' | 'IARK_CONFIG' | 'directorio actual' };

const TRUE = /^(1|true|yes|on)$/i;

function realOrResolved(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function isInside(root: string, path: string): boolean {
  const rel = relative(realOrResolved(root), realOrResolved(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Decide qué configuración se carga:
 *
 *  1. `--no-config` o `IARK_NO_CONFIG=1`: ninguna (manda sobre todo lo demás; sirve de cerrojo, p. ej. en integración continua).
 *  2. `--config <archivo>`, y si no `IARK_CONFIG`: ese archivo, que tiene que existir. Es una decisión explícita de quien ejecuta.
 *  3. `iark.config.json` en el directorio actual, si existe. NO se busca en los directorios padre, y NO se carga si está dentro
 *     de una carpeta que esta misma ejecución trata como contenido ajeno (`--workspace`, `IARK_WORKSPACE`, `--from-repo`):
 *     ahí lo escribió quien creó el proyecto, no quien ejecuta el comando, y cargarlo ejecutaría su código.
 *  4. Si no, ninguna.
 */
export function selectConfig(flags: GlobalFlags, options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): ConfigSelection {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  if (flags.noConfig && flags.config !== undefined) throw new ConfigError('--config y --no-config se contradicen: use solo una de las dos.');
  const explicit = flags.config ?? (env.IARK_CONFIG?.trim() ? env.IARK_CONFIG : undefined);
  if (flags.noConfig || TRUE.test(env.IARK_NO_CONFIG ?? '')) {
    return { kind: 'none', ...(explicit !== undefined && !flags.noConfig ? { note: `aviso: se ignora ${flags.config !== undefined ? '--config' : 'IARK_CONFIG'} porque IARK_NO_CONFIG está activo.` } : {}) };
  }
  if (explicit !== undefined) {
    const via = flags.config !== undefined ? '--config' : 'IARK_CONFIG';
    const path = resolve(cwd, explicit);
    if (!existsSync(path)) throw new ConfigError(`No existe el archivo de configuración «${path}» (${via}).`);
    if (!statSync(path).isFile()) throw new ConfigError(`«${path}» (${via}) no es un archivo de configuración: es una carpeta.`);
    return { kind: 'file', path, via };
  }
  const found = resolve(cwd, CONFIG_FILE_NAME);
  if (!existsSync(found) || !statSync(found).isFile()) return { kind: 'none' };
  const foreign = [...flags.workspace, ...(env.IARK_WORKSPACE?.trim() ? [env.IARK_WORKSPACE] : []), ...flags.fromRepo].map((root) => resolve(cwd, root));
  const inside = foreign.find((root) => isInside(root, found));
  if (inside) {
    return {
      kind: 'none',
      note: `aviso: no se carga «${found}» porque está dentro de una carpeta que se trata como contenido ajeno (${inside}): cargar módulos ejecuta código. Si es suyo, indíquelo con --config.`,
    };
  }
  return { kind: 'file', path: found, via: 'directorio actual' };
}
