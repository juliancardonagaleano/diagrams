/**
 * Versiones `mayor.menor` numéricas: las del documento de un módulo (`documentVersion`) y las del protocolo `postMessage`.
 *
 * Este archivo no importa nada a propósito: lo comparten las migraciones de documentos y la negociación del protocolo
 * (`protocol.ts`), que llegan a los bundles del SDK de anfitrión y del Web Component, que no deben crecer por esto.
 */

export interface MajorMinor {
  major: number;
  minor: number;
}

const MAJOR_MINOR = /^(\d+)\.(\d+)$/;

/** `1.0` → `{ major: 1, minor: 0 }`; `undefined` si no es una cadena `mayor.menor` de enteros sin signo (`1`, `1.0.0`, `v1.0` no lo son). */
export function parseMajorMinor(text: unknown): MajorMinor | undefined {
  if (typeof text !== 'string') return undefined;
  const match = MAJOR_MINOR.exec(text);
  if (!match) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return Number.isSafeInteger(major) && Number.isSafeInteger(minor) ? { major, minor } : undefined;
}

/** Forma canónica (`01.00` → `1.0`): dos escrituras de la misma versión tienen la misma clave. */
export function majorMinorKey(version: MajorMinor): string {
  return `${version.major}.${version.minor}`;
}

/** Negativo si `a` es anterior a `b`, 0 si son la misma versión y positivo si `a` es posterior. */
export function compareMajorMinor(a: MajorMinor, b: MajorMinor): number {
  return a.major !== b.major ? a.major - b.major : a.minor - b.minor;
}
