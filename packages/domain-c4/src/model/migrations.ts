import type { DocumentMigration, MigrationSource } from '@iark/kernel';
import { DOCUMENT_VERSION } from './types';

/**
 * Migraciones del documento C4: llevan lo guardado con una versión anterior del formato a `DOCUMENT_VERSION`. Hoy no hay
 * ninguna (el formato sigue en 1.0). Cuando un cambio de esquema no sea aditivo: se sube `DOCUMENT_VERSION`, se añade aquí el
 * paso `from → to` y se conserva una foto del documento antiguo en `tests/fixtures/documentos/` (ver
 * `docs/versionado-documentos.md`).
 *
 * Lo comparten el módulo (`c4Module.migrations`, que usa `analyzeValue`) y `validateDocument` (editor, puente embebido y CLI,
 * que leen C4 sin pasar por el módulo), de modo que un documento antiguo se migra igual lo abra quien lo abra.
 */
export const C4_MIGRATIONS: DocumentMigration[] = [];

/** Lo que `migrateValue` necesita para migrar un documento C4. */
export const c4MigrationSource: MigrationSource = { id: 'c4', documentVersion: DOCUMENT_VERSION, migrations: C4_MIGRATIONS };
