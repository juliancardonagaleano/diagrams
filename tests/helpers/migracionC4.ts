import { C4_MIGRATIONS, DOCUMENT_VERSION } from '@iark/domain-c4';
import type { DocumentMigration } from '@iark/kernel';

/**
 * El formato C4 sigue en 1.0 y no tiene migraciones reales. Para probar que TODAS las vías que leen un documento C4 (el módulo, el
 * editor, el puente embebido, el CLI, lo persistido en el navegador) lo migran igual, estas pruebas instalan un paso inventado
 * mientras dura la prueba: la «versión 0.9» guardaba el título del espacio de trabajo en `workspace.title` y la actual lo guarda
 * en `workspace.name`.
 */
export const PASO_C4_0_9: DocumentMigration = {
  from: '0.9',
  to: DOCUMENT_VERSION,
  description: 'workspace.title pasa a workspace.name',
  migrate(document) {
    const old = document as { workspace?: { title?: string; description?: string } };
    const { title, ...rest } = old.workspace ?? {};
    return { ...old, workspace: { ...rest, ...(title !== undefined ? { name: title } : {}) } };
  },
};

/** Un documento C4 tal como lo guardaba la «versión 0.9» inventada. */
export const DOC_C4_0_9 = { version: '0.9', workspace: { title: 'Banca antigua' }, model: { elements: [], relationships: [] }, views: [] };

/** Instala la cadena de migraciones C4 de prueba (sustituye la real) y devuelve la función que restaura la que había. */
export function instalarMigracionesC4(pasos: DocumentMigration[] = [PASO_C4_0_9]): () => void {
  const anteriores = [...C4_MIGRATIONS];
  C4_MIGRATIONS.splice(0, C4_MIGRATIONS.length, ...pasos);
  return () => void C4_MIGRATIONS.splice(0, C4_MIGRATIONS.length, ...anteriores);
}
