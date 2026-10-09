import type { AccountUsage, PersonalQuota, QuotaLimits, QuotaUsage } from '@iark/kernel';
import { formatBytes } from '../i18n/format';
import { formatList, t } from '../i18n';

export { formatBytes };

/**
 * Cuotas de uso en la interfaz: cómo se escribe un tamaño, cuándo se avisa y qué líneas se muestran. Los números los pone el servidor
 * (`GET /api/usage`, `/api/admin/users`); aquí solo se interpretan. Qué cuenta y a quién se cobra: `docs/cuentas-github.md`.
 */

/** A partir de qué fracción del tope se avisa de que se está llegando («cerca del límite»). */
export const NEAR_LIMIT = 0.8;

export type QuotaKind = 'bytes' | 'projects' | 'diagrams';
/** `unlimited`: sin tope; `ok`: de sobra; `near`: desde el 80 %; `full`: se alcanzó (ya no se admite crecer en eso). */
export type QuotaLevel = 'unlimited' | 'ok' | 'near' | 'full';

/** En qué punto está `used` respecto a `limit` (0 = sin tope). */
export function levelOf(used: number, limit: number): QuotaLevel {
  if (!(limit > 0)) return 'unlimited';
  if (used >= limit) return 'full';
  return used / limit >= NEAR_LIMIT ? 'near' : 'ok';
}

/** El porcentaje usado, redondeado hacia abajo (99,9 % no es «100 %»), o `undefined` sin tope. */
export function percentOf(used: number, limit: number): number | undefined {
  return limit > 0 ? Math.min(100, Math.floor((used / limit) * 100)) : undefined;
}

export interface QuotaLine {
  kind: QuotaKind;
  /** «Espacio», «Proyectos» o «Diagramas de “X”». */
  label: string;
  used: number;
  limit: number;
  level: QuotaLevel;
  /** «12 MB de 256 MB», «3 de 25», «7» (sin tope). */
  text: string;
}

/** Una línea de lo que se usa, con su tope si lo hay. */
function line(kind: QuotaKind, label: string, used: number, limit: number): QuotaLine {
  const format = kind === 'bytes' ? formatBytes : String;
  return { kind, label, used, limit, level: levelOf(used, limit), text: limit > 0 ? t('quota.of', { used: format(used), limit: format(limit) }) : t('quota.unlimitedUse', { used: format(used) }) };
}

/**
 * Las líneas de uso de una persona: el espacio total, los proyectos que posee y, si se indica un proyecto suyo, los diagramas de ese proyecto
 * (el tope de diagramas es por proyecto, no por persona).
 */
export function quotaLines(usage: AccountUsage, project?: { id: string; name: string; diagrams: number }): QuotaLine[] {
  const lines = [line('bytes', t('quota.space'), usage.usage.bytes, usage.limits.bytes), line('projects', t('quota.projects'), usage.usage.projects, usage.limits.projects)];
  if (project) lines.push(line('diagrams', t('quota.diagramsOf', { name: project.name }), project.diagrams, usage.limits.diagramsPerProject));
  return lines;
}

/** La frase de aviso para las líneas que están cerca del tope o lo alcanzaron, o `undefined` si no hay nada que avisar. */
export function quotaWarning(lines: readonly QuotaLine[]): { level: 'near' | 'full'; text: string } | undefined {
  const bad = lines.filter((l) => l.level === 'near' || l.level === 'full');
  if (bad.length === 0) return undefined;
  const full = bad.filter((l) => l.level === 'full');
  const describe = (l: QuotaLine): string =>
    l.kind === 'bytes' ? t('quota.what.bytes', { text: l.text }) : l.kind === 'projects' ? t('quota.what.projects', { text: l.text }) : t('quota.what.diagrams', { text: l.text });
  if (full.length > 0) return { level: 'full', text: t('quota.full', { what: formatList(full.map(describe)) }) };
  return { level: 'near', text: t('quota.near', { what: formatList(bad.map(describe)) }) };
}

/** Cuántos bytes hay en `megabytes` MB; el campo de la pantalla de administración escribe los topes de espacio en MB. */
export const bytesFromMb = (megabytes: number): number => Math.round(megabytes * 1024 * 1024);
/** Los MB de una cantidad de bytes, con un decimal como mucho. */
export const mbFromBytes = (bytes: number): number => Math.round((bytes / (1024 * 1024)) * 10) / 10;

/** Cómo está fijado un tope en la cuota personal: sin valor propio (el de la instancia), sin tope, o uno concreto. */
export type QuotaMode = 'instance' | 'none' | 'custom';

export const modeOf = (value: number | undefined): QuotaMode => (value === undefined ? 'instance' : value === 0 ? 'none' : 'custom');

export type QuotaDraft = Record<keyof QuotaLimits, { mode: QuotaMode; amount: string }>;

/** El borrador del editor a partir de la cuota personal que ya tiene la cuenta. Los bytes se escriben en MB. */
export function draftOf(quota: PersonalQuota | undefined, limits: QuotaLimits | undefined): QuotaDraft {
  const field = (key: keyof QuotaLimits): { mode: QuotaMode; amount: string } => {
    const own = quota?.[key];
    const shown = own !== undefined && own > 0 ? own : (limits?.[key] ?? 0);
    const amount = shown > 0 ? String(key === 'bytes' ? mbFromBytes(shown) : shown) : '';
    return { mode: modeOf(own), amount };
  };
  return { bytes: field('bytes'), projects: field('projects'), diagramsPerProject: field('diagramsPerProject') };
}

/**
 * El cambio que hay que mandar al servidor para que la cuota personal quede como dice el borrador (`null` quita el valor propio, `0` es «sin
 * tope»), o el motivo por el que no se puede (un número que no vale). Siempre se mandan los tres campos: así lo que se ve es lo que queda.
 */
export function quotaChangeOf(draft: QuotaDraft): { change: Record<keyof QuotaLimits, number | null> } | { error: string; field: keyof QuotaLimits } {
  const names: Record<keyof QuotaLimits, string> = { bytes: t('quota.field.bytes'), projects: t('quota.field.projects'), diagramsPerProject: t('quota.field.diagramsPerProject') };
  const change = {} as Record<keyof QuotaLimits, number | null>;
  for (const key of ['bytes', 'projects', 'diagramsPerProject'] as const) {
    const { mode, amount } = draft[key];
    if (mode === 'instance') change[key] = null;
    else if (mode === 'none') change[key] = 0;
    else {
      const parsed = Number(amount.replace(',', '.'));
      const value = key === 'bytes' ? bytesFromMb(parsed) : parsed;
      if (!amount.trim() || !Number.isFinite(parsed) || parsed <= 0 || (key !== 'bytes' && !Number.isInteger(parsed)) || !Number.isSafeInteger(value) || value <= 0) {
        return { error: key === 'bytes' ? t('quota.invalidMb', { name: names[key] }) : t('quota.invalid', { name: names[key] }), field: key };
      }
      change[key] = value;
    }
  }
  return { change };
}

/** El peor nivel entre el espacio y los proyectos de una cuenta (el de diagramas es por proyecto y no se ve en la lista). */
export function accountLevel(usage: QuotaUsage | undefined, limits: QuotaLimits | undefined): QuotaLevel {
  if (!usage || !limits) return 'unlimited';
  const levels = [levelOf(usage.bytes, limits.bytes), levelOf(usage.projects, limits.projects)];
  return levels.includes('full') ? 'full' : levels.includes('near') ? 'near' : levels.includes('ok') ? 'ok' : 'unlimited';
}

/** `true` si no hay ningún tope (no hay nada que mostrar al usuario normal). */
export const isUnlimited = (limits: QuotaLimits): boolean => limits.bytes === 0 && limits.projects === 0 && limits.diagramsPerProject === 0;
