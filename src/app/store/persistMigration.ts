import { migrateValue, type MigrationSource } from '@iark/kernel';
import { c4MigrationSource } from '@core/model/migrations';

/**
 * Migración de lo que el editor C4 guarda en el navegador (zustand `persist`, clave `iark-diagrams` en `localStorage`).
 *
 * Política (ver `docs/versionado-documentos.md`): `PERSIST_VERSION` es la versión de la FORMA de lo persistido (`partialize` en
 * `documentStore.ts`: `doc`, `activeViewId`, `ui`, `lastSavedAt`). Súbela cuando esa forma cambie (un campo que se renombra, una
 * clave que desaparece) y añade el paso en `migratePersistedState`; mientras no se suba, zustand descarta lo guardado con otra
 * versión. La versión del DOCUMENTO C4 es otra cosa: la gobierna `DOCUMENT_VERSION` con sus migraciones (`C4_MIGRATIONS`), que
 * se aplican siempre, también si `PERSIST_VERSION` no cambió.
 */
export const PERSIST_VERSION = 1;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Lleva el documento guardado a la versión actual del formato C4. Lo que no se puede migrar (de una versión más nueva, o
 * anterior sin migración) se deja como está: descartarlo borraría el diagrama de la persona al siguiente guardado, y el
 * editor ya confía en lo persistido.
 */
export function migratePersistedDocument(persisted: unknown, source: MigrationSource = c4MigrationSource): unknown {
  if (!isRecord(persisted) || !('doc' in persisted)) return persisted;
  const result = migrateValue(source, persisted.doc);
  return result.status === 'migrated' ? { ...persisted, doc: result.document } : persisted;
}

/**
 * `migrate` de `persist`: lo llama zustand cuando la versión guardada no es `PERSIST_VERSION`. Cada cambio de forma del almacén
 * añade aquí un `if (version < N)`; después, el documento pasa por las migraciones del módulo C4 (`C4_MIGRATIONS`).
 *
 * Versión 0 o ausente: lo guardado antes de que existiera `version` tiene la misma forma que la 1, así que no se convierte.
 * Una versión MÁS NUEVA que `PERSIST_VERSION` (se volvió a una versión anterior de la app) se deja tal cual.
 */
export function migratePersistedState(persisted: unknown, version: number, source: MigrationSource = c4MigrationSource): unknown {
  if (version > PERSIST_VERSION) return persisted;
  // (cuando PERSIST_VERSION suba: `if (version < 2) persisted = { ...persisted, <forma nueva> }`)
  return migratePersistedDocument(persisted, source);
}
