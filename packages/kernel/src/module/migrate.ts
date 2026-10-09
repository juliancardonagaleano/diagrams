import type { DocumentMigration } from './types';
import { compareMajorMinor, majorMinorKey, parseMajorMinor, type MajorMinor } from './version';

/**
 * Migración de documentos entre versiones del formato de un módulo. Es lógica pura sobre datos JSON: no valida con el
 * esquema (eso lo hace `analyzeValue` después de migrar) ni toca el módulo más allá de lo que declara.
 *
 * Política (ver `docs/versionado-documentos.md`):
 * - sin `version` en el documento se asume la actual (los esquemas ya la completan con `.default`);
 * - la misma versión no cambia nada y devuelve el mismo objeto;
 * - una versión anterior con cadena de migraciones se lleva a la actual, paso a paso, sobre una copia (la entrada no se muta);
 * - una anterior sin cadena, o una MÁS NUEVA que la del módulo, no se intenta: se devuelve un mensaje claro.
 */

/** Lo único que hace falta de un módulo para migrar sus documentos (un `DomainModule` lo cumple tal cual). */
export interface MigrationSource {
  id: string;
  documentVersion: string;
  migrations?: readonly DocumentMigration[];
}

/** Un paso aplicado, para informar de qué cambió. */
export interface AppliedMigration {
  from: string;
  to: string;
  description?: string;
}

export type MigrationResult =
  /** El documento ya está en la versión actual (o no declara versión): es el mismo objeto de entrada. */
  | { status: 'current'; document: unknown }
  /** El documento venía de `from` y se llevó a `to` (la versión actual del módulo). `document` es un objeto nuevo. */
  | { status: 'migrated'; document: unknown; from: string; to: string; steps: AppliedMigration[] }
  /** No se puede llevar a la versión actual: `message` lo explica a quien lo abrió. */
  | { status: 'unsupported'; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

const show = (value: unknown): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text !== undefined && text.length > 40 ? `${text.slice(0, 40)}…` : String(text);
};

/** Copia profunda de un documento JSON: la entrada de `migrate` nunca es el objeto del llamador. */
function cloneDocument(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

/**
 * Problemas de una cadena de migraciones respecto a `documentVersion`, uno por frase (vacío si es válida o no hay ninguna).
 * Una cadena válida: versiones `mayor.menor`, cada paso sube de versión, ninguna `from` repetida, sin huecos (cada paso
 * empieza donde acaba el anterior), sin ciclos y termina en `documentVersion`.
 */
export function validateMigrationChain(documentVersion: string, migrations: readonly DocumentMigration[]): string[] {
  if (migrations.length === 0) return [];
  const target = parseMajorMinor(documentVersion);
  if (!target) return [`la versión del documento «${show(documentVersion)}» no tiene el formato «mayor.menor» (p. ej. «1.0»), necesario para migrar.`];

  const steps: Array<{ migration: DocumentMigration; from: MajorMinor; to: MajorMinor }> = [];
  for (const migration of migrations) {
    const from = parseMajorMinor(migration.from);
    const to = parseMajorMinor(migration.to);
    if (!from || !to) return [`la migración de «${show(migration.from)}» a «${show(migration.to)}» debe usar versiones «mayor.menor».`];
    if (typeof migration.migrate !== 'function') return [`la migración de ${migration.from} a ${migration.to} no tiene función «migrate».`];
    if (compareMajorMinor(to, from) <= 0) {
      return [`la migración de ${migration.from} a ${migration.to} no sube de versión: una cadena no admite ciclos ni pasos hacia atrás.`];
    }
    steps.push({ migration, from, to });
  }

  const problems: string[] = [];
  const byFrom = new Map<string, (typeof steps)[number]>();
  for (const step of steps) {
    const key = majorMinorKey(step.from);
    if (byFrom.has(key)) problems.push(`hay dos migraciones que parten de la versión ${key}.`);
    else byFrom.set(key, step);
  }
  if (problems.length > 0) return problems;

  // Se sigue la cadena desde su único comienzo (la `from` a la que no llega ninguna migración).
  const reached = new Set(steps.map((s) => majorMinorKey(s.to)));
  const starts = steps.filter((s) => !reached.has(majorMinorKey(s.from)));
  if (starts.length === 0) return ['la cadena de migraciones forma un ciclo.'];
  if (starts.length > 1) {
    const froms = starts.map((s) => majorMinorKey(s.from)).join(', ');
    return [`la cadena de migraciones tiene huecos: hay ${starts.length} tramos que empiezan en ${froms}, y nada migra de la versión donde acaba uno a donde empieza el siguiente.`];
  }
  let current = majorMinorKey(starts[0].from);
  let visited = 0;
  for (let step = byFrom.get(current); step && visited <= steps.length; step = byFrom.get(current)) {
    visited += 1;
    current = majorMinorKey(step.to);
  }
  if (visited < steps.length) return ['la cadena de migraciones tiene huecos: hay pasos que no enlazan con el resto.'];
  if (current !== majorMinorKey(target)) {
    return [`la cadena de migraciones termina en la versión ${current}, pero el documento actual del módulo es la ${documentVersion}: falta el paso hasta la actual.`];
  }
  return [];
}

/**
 * Lleva `value` (el documento tal como se guardó) a la versión actual del módulo. No muta `value` ni lo valida con el
 * esquema. Los pasos reciben una copia, y el núcleo escribe `version` tras cada uno.
 */
export function migrateValue(source: MigrationSource, value: unknown): MigrationResult {
  if (!isRecord(value) || value.version === undefined) return { status: 'current', document: value };
  const target = parseMajorMinor(source.documentVersion);
  // Una versión de documento que no es «mayor.menor» no se puede comparar: que decida el esquema del módulo.
  if (!target) return { status: 'current', document: value };

  const declared = value.version;
  const found = parseMajorMinor(declared);
  if (!found) {
    return { status: 'unsupported', message: `La versión del documento (${show(declared)}) no tiene el formato «mayor.menor»; el módulo «${source.id}» usa la ${source.documentVersion}.` };
  }
  const order = compareMajorMinor(found, target);
  if (order === 0) return { status: 'current', document: value };
  if (order > 0) {
    return {
      status: 'unsupported',
      message: `Este documento se creó con una versión más nueva (${declared}) del formato; el módulo «${source.id}» entiende hasta la ${source.documentVersion}. Actualiza DIAgrams para abrirlo.`,
    };
  }

  const migrations = source.migrations ?? [];
  const byFrom = new Map<string, DocumentMigration>();
  for (const migration of migrations) {
    const from = parseMajorMinor(migration.from);
    if (from) byFrom.set(majorMinorKey(from), migration);
  }
  const available = (): string => {
    const froms = [...byFrom.values()].map((m) => m.from);
    return froms.length > 0 ? `Hay migraciones desde: ${froms.join(', ')}.` : 'El módulo no declara migraciones.';
  };

  let document = cloneDocument(value);
  let current = majorMinorKey(found);
  const steps: AppliedMigration[] = [];
  while (current !== majorMinorKey(target)) {
    const step = byFrom.get(current);
    if (!step || steps.length >= migrations.length) {
      const where = steps.length === 0 ? `La versión ${declared} del documento` : `La cadena de migraciones del documento (desde la ${declared}) se interrumpe en la versión ${current}, que`;
      return { status: 'unsupported', message: `${where} no está soportada por el módulo «${source.id}» (versión actual: ${source.documentVersion}). ${available()}` };
    }
    let migrated: unknown;
    try {
      migrated = step.migrate(document);
    } catch (error) {
      return { status: 'unsupported', message: `No se pudo migrar el documento de la versión ${step.from} a la ${step.to} (módulo «${source.id}»): ${(error as Error).message}` };
    }
    document = isRecord(migrated) ? { ...migrated, version: step.to } : migrated;
    steps.push({ from: step.from, to: step.to, ...(step.description ? { description: step.description } : {}) });
    const to = parseMajorMinor(step.to);
    if (!to) return { status: 'unsupported', message: `La migración de ${step.from} a ${step.to} del módulo «${source.id}» no usa versiones «mayor.menor».` };
    current = majorMinorKey(to);
  }
  return { status: 'migrated', document, from: String(declared), to: source.documentVersion, steps };
}
