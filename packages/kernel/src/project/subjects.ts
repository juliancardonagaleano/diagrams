/**
 * Sujetos de un proyecto: la misma cosa de arquitectura cuando aparece en varios diagramas con ids distintos y nadie
 * quiere una URN en cada elemento. Es un índice del sidecar, no un elemento. Borrarlo no toca los diagramas.
 */

export interface SubjectAppearance {
  /** Id del diagrama dentro del proyecto. */
  diagramId: string;
  /** Id del módulo (`c4`, `platform`…). */
  module: string;
  /** Id del elemento dentro de ese diagrama. */
  elementId: string;
  /** Vista concreta, si se conoce (`env:prod`, `componentes-api`…). */
  viewId?: string;
}

export interface ProjectSubject {
  id: string;
  name: string;
  appearances: SubjectAppearance[];
}

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,118}[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;

function appearance(raw: unknown): SubjectAppearance | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.diagramId !== 'string' || !ID.test(record.diagramId)) return undefined;
  if (typeof record.module !== 'string' || !ID.test(record.module)) return undefined;
  if (typeof record.elementId !== 'string' || !ID.test(record.elementId)) return undefined;
  const viewId = typeof record.viewId === 'string' && record.viewId.trim() ? record.viewId.trim() : undefined;
  return { diagramId: record.diagramId, module: record.module, elementId: record.elementId, ...(viewId ? { viewId } : {}) };
}

/** Interpreta `subjects` del sidecar. Lo que no se entiende se deja fuera. Sin filas válidas, `undefined`. */
export function parseSubjects(raw: unknown): ProjectSubject[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const subjects: ProjectSubject[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || !ID.test(record.id)) continue;
    if (typeof record.name !== 'string' || !record.name.trim()) continue;
    const appearances = Array.isArray(record.appearances) ? record.appearances.map(appearance).filter((a): a is SubjectAppearance => a !== undefined) : [];
    if (appearances.length === 0) continue;
    subjects.push({ id: record.id, name: record.name.trim(), appearances });
  }
  return subjects.length > 0 ? subjects : undefined;
}

/** Otras apariciones del elemento, si algún sujeto lo nombra. */
export function otherAppearances(subjects: readonly ProjectSubject[] | undefined, module: string, elementId: string): Array<SubjectAppearance & { subject: string }> {
  if (!subjects) return [];
  const out: Array<SubjectAppearance & { subject: string }> = [];
  for (const subject of subjects) {
    const here = subject.appearances.some((a) => a.module === module && a.elementId === elementId);
    if (!here) continue;
    for (const appearance of subject.appearances) {
      if (appearance.module === module && appearance.elementId === elementId) continue;
      out.push({ ...appearance, subject: subject.name });
    }
  }
  return out;
}
