import { ProjectError } from '@iark/kernel';
import { CliError } from './io';
import { DatabaseConfigError } from './postgres/config';
import { DatabaseError } from './postgres/pool';
import { acquireDatabase, releaseDatabase } from './postgres/shared';
import { PostgresProjectStore, type PostgresProjectStoreOptions } from './postgresProjects';

/**
 * Qué almacén guarda los proyectos de `iark serve`: la carpeta de siempre (`--workspace <carpeta>`) o Postgres (`--workspace-store postgres`,
 * o `IARK_WORKSPACE_STORE=postgres`). Con Postgres NO se pasa carpeta, y la conexión sale SOLO del entorno (`IARK_DATABASE_URL`…, ver
 * `postgres/config.ts`): una cadena de conexión lleva la contraseña y no viaja por la línea de comandos.
 */

export const WORKSPACE_STORES = ['folder', 'postgres'] as const;
export type WorkspaceStoreKind = (typeof WORKSPACE_STORES)[number];

/** El almacén pedido (por omisión, la carpeta). Error de uso (2) si no existe o si se pide Postgres y también una carpeta. */
export function resolveWorkspaceStore(value: string | undefined, folder: string | undefined): WorkspaceStoreKind {
  const kind = (value ?? '').trim().toLowerCase() || 'folder';
  if (!(WORKSPACE_STORES as readonly string[]).includes(kind)) {
    throw new CliError(`--workspace-store debe ser ${WORKSPACE_STORES.map((k) => `«${k}»`).join(' o ')}, no «${kind.slice(0, 20)}».`, 2);
  }
  if (kind === 'postgres' && folder) {
    throw new CliError(
      'Con --workspace-store postgres no se indica una carpeta de trabajo (--workspace, o la variable IARK_WORKSPACE): los proyectos viven en la base, cuya conexión sale solo del entorno (IARK_DATABASE_URL). ' +
        'Quite la carpeta, o use --workspace-store folder.',
      2,
    );
  }
  return kind as WorkspaceStoreKind;
}

/** Un fallo de configuración o de conexión como error de uso (2) o de entorno (1), con un mensaje que no lleva la contraseña. */
export function asCliError(error: unknown): unknown {
  if (error instanceof DatabaseConfigError) return new CliError(error.message, 2);
  if (error instanceof DatabaseError) return new CliError(error.message, 1);
  if (error instanceof ProjectError && error.code === 'unavailable') return new CliError(error.message, 1);
  return error;
}

/**
 * Abre los proyectos en la base que describe el entorno: toma el pool compartido del proceso (`acquireDatabase`), deja el esquema al día y
 * devuelve el almacén. Quien lo abre debe llamar a `releaseDatabase()` al terminar.
 */
export async function openPostgresProjects(options: PostgresProjectStoreOptions = {}): Promise<PostgresProjectStore> {
  let acquired = false;
  try {
    const db = await acquireDatabase();
    acquired = true;
    return await PostgresProjectStore.open(db, options);
  } catch (error) {
    if (acquired) await releaseDatabase();
    throw asCliError(error);
  }
}
