import { t, tp } from '../i18n';
import { analyzeText, diffDocuments, hasChanges, type Analysis, type AnyModule, type DocumentDiff } from '@iark/kernel';

/**
 * Qué cambió entre dos documentos de un mismo módulo, para el historial de versiones. Es el mismo motor de `iark diff` y de la pestaña «Versiones» del
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
  if (analysis.status === 'empty') return { ok: false, reason: t('hist.diff.empty', { which }) };
  if (analysis.status === 'syntax') return { ok: false, reason: t('hist.diff.syntax', { which, detail: analysis.error }) };
  return { ok: false, reason: tp('hist.diff.schema', analysis.issues.length, { which, module: module.id }) };
}

/** Compara el documento `before` con el `after`, ambos como texto, con el motor de diff del módulo. */
export function changesBetween(module: AnyModule, before: string, after: string, labels: { before: string; after: string } = { before: t('hist.diff.version'), after: t('hist.diff.current') }): VersionChange {
  const first = parsed(module, before, labels.before);
  if (!first.ok) return { status: 'unreadable', reason: first.reason };
  const second = parsed(module, after, labels.after);
  if (!second.ok) return { status: 'unreadable', reason: second.reason };
  const diff = diffDocuments(first.document, second.document, module.diff);
  return hasChanges(diff) ? { status: 'changed', diff } : { status: 'same' };
}
