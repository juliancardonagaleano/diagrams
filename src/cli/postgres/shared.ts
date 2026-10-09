import { resolveDatabaseConfig } from './config';
import { PostgresDatabase } from './pool';

/**
 * Una sola conexión (un pool) a la base por proceso, compartida por los almacenes que la usen (cuentas y proyectos): dos pools de
 * `IARK_DATABASE_POOL` conexiones cada uno gastarían el doble de las que admite una base pequeña (el plan gratuito de Supabase tiene
 * pocas). Cada `acquireDatabase()` suma una referencia y cada `releaseDatabase()` la quita; el pool se cierra con la última.
 */

let current: { db: Promise<PostgresDatabase>; refs: number } | undefined;

/** Abre (o reutiliza) el pool descrito por el entorno. Lanza `DatabaseConfigError` o `DatabaseError` con un mensaje listo para mostrar. */
export function acquireDatabase(env: NodeJS.ProcessEnv = process.env): Promise<PostgresDatabase> {
  if (!current) {
    const config = resolveDatabaseConfig(env);
    const db = PostgresDatabase.connect(config);
    const entry = { db, refs: 0 };
    current = entry;
    // si la conexión falla, no se deja un fallo guardado: el siguiente intento vuelve a probar
    db.catch(() => {
      if (current === entry) current = undefined;
    });
  }
  current.refs++;
  return current.db;
}

/** Suelta una referencia tomada con `acquireDatabase`; con la última, cierra el pool. */
export async function releaseDatabase(): Promise<void> {
  const entry = current;
  if (!entry) return;
  entry.refs--;
  if (entry.refs > 0) return;
  current = undefined;
  try {
    await (await entry.db).close();
  } catch {
    // no llegó a abrirse o ya estaba cerrado
  }
}
