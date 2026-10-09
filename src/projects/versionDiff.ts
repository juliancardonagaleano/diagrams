import { analyzeText, diffDocuments, hasChanges, type Analysis, type AnyModule, type DocumentDiff } from '@iark/kernel';

/**
 * Qué cambió entre dos documentos de un mismo módulo, para el historial de versiones. Es el mismo motor de `iark diff` y de la pestaña «Comparar» del
 * banco de trabajo (`diffDocuments` con las reglas de diff del módulo): la maquetación guardada y el orden de las listas no cuentan como cambio.
 */
export type VersionChange =
  /** Sin cambios de contenido. */
  | { status: 'same' }
  | { status: 'changed'; diff: DocumentDiff }
  /** Alguno de los dos documentos no se puede interpretar (un borrador que no es JSON, o que no cumple el esquema del módulo). */
  | { status: 'unreadable'; reason: string };

function parsed(module: AnyModule, text: string, which: string): { ok: true; document: unknown } | { ok: false; reason: string } {
  const analysis: Analysis = analyzeText(module, text);
  if (analysis.status === 'ok') return { ok: true, document: analysis.document };
  if (analysis.status === 'empty') return { ok: false, reason: `${which} está vacío.` };
  if (analysis.status === 'syntax') return { ok: false, reason: `${which} no es JSON válido: ${analysis.error}` };
  return { ok: false, reason: `${which} no cumple el esquema del módulo «${module.id}» (${analysis.issues.length} ${analysis.issues.length === 1 ? 'problema' : 'problemas'}).` };
}

/** Compara el documento `before` con el `after`, ambos como texto, con el motor de diff del módulo. */
export function changesBetween(module: AnyModule, before: string, after: string, labels: { before: string; after: string } = { before: 'La versión', after: 'El contenido actual' }): VersionChange {
  const first = parsed(module, before, labels.before);
  if (!first.ok) return { status: 'unreadable', reason: first.reason };
  const second = parsed(module, after, labels.after);
  if (!second.ok) return { status: 'unreadable', reason: second.reason };
  const diff = diffDocuments(first.document, second.document, module.diff);
  return hasChanges(diff) ? { status: 'changed', diff } : { status: 'same' };
}
