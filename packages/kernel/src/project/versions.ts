import { ProjectError } from './errors';
import { cleanName, MAX_NAME_LENGTH } from './names';
import type { DiagramMeta, ProjectStore } from './types';

/**
 * Historial de versiones de un diagrama de un proyecto. Cada guardado crea una versión inmutable con el documento tal cual;
 * restaurar una versión crea otra versión nueva con su contenido (el historial nunca se pierde). Aquí está lo que comparten
 * todos los almacenes —el modelo, la política de retención, la decisión de qué versión se crea, se sustituye o se descarta, y
 * el resumen del contenido (tamaño y hash)—; cada almacén (memoria, IndexedDB, carpeta, servidor) solo decide dónde lo guarda.
 *
 * Reglas (las aplica `planSave`, de la misma manera en todos los almacenes):
 *  - Un guardado cuyo contenido es idéntico al de la última versión no crea otra (no hay nada que distinguir).
 *  - Coalescencia: si la persona que guarda es la misma que guardó la última versión, esa versión es automática (sin nombre) y
 *    no pasaron `coalesceSeconds` desde que se abrió, el guardado SUSTITUYE esa versión en lugar de añadir otra. Sustituir es
 *    descartar la anterior y crear una nueva con id nuevo (los ids nunca se reutilizan ni cambian de contenido). La ventana se
 *    mide desde el primer guardado de la serie, no desde el último: una hora de edición continua deja una versión cada
 *    `coalesceSeconds`, no una sola. Una versión con nombre, o la que resulta de restaurar, nunca se sustituye.
 *  - Retención: se conservan las últimas `keepAutomatic` versiones automáticas más todas las nombradas, hasta `maxVersions` en
 *    total por diagrama. Al pasarse, se descarta la automática más vieja. Las nombradas solo se quitan a mano.
 *  - Línea base: si el contenido que había antes de guardar no es el de la última versión (un diagrama anterior al historial, o
 *    editado fuera de IArk: a mano, con git), ese contenido se registra primero como versión, para no perderlo al sobrescribirlo.
 */

/** Una versión de un diagrama, sin su documento. */
export interface VersionMeta {
  /** Entero creciente por diagrama (1, 2, 3…). No se reutiliza aunque la versión se descarte. */
  id: number;
  /** Cuándo se guardó (ISO 8601). En una serie coalescida, el primer guardado de la serie. */
  savedAt: string;
  /** Quién la guardó, si el servicio sabe quién es (el nombre de su token, o `@usuario` de GitHub). Un almacén local no lo anota. */
  savedBy?: string;
  /** Nombre que le dio una persona. Una versión con nombre no se sustituye ni se descarta sola. */
  label?: string;
  /** Tamaño del documento en bytes (UTF-8). Es lo que una política de cuotas sumaría: ver `VersionedProjectStore.versionUsage`. */
  size: number;
  /** SHA-256 del documento (UTF-8), en hexadecimal: sirve para saber si dos versiones, o una versión y el documento actual, son iguales. */
  hash: string;
  /** Si la creó una restauración: la versión cuyo contenido se recuperó. */
  restoredFrom?: number;
}

/** Una versión con su documento. */
export interface DiagramVersion extends VersionMeta {
  text: string;
}

/** Cuánto historial guarda un almacén por diagrama. */
export interface VersionPolicy {
  /** Guardados seguidos de la misma persona en menos de este tiempo (segundos) comparten versión. `0`: cada guardado es una versión. */
  coalesceSeconds: number;
  /** Cuántas versiones automáticas (sin nombre) se conservan: al pasarse se descarta la más vieja. */
  keepAutomatic: number;
  /** Tope de versiones por diagrama, con nombre o sin él. Quedan `maxVersions - keepAutomatic` para las nombradas. */
  maxVersions: number;
}

export const DEFAULT_VERSION_POLICY: Readonly<VersionPolicy> = { coalesceSeconds: 30, keepAutomatic: 50, maxVersions: 150 };

/** Cotas de lo que se acepta configurar: ni un historial sin versiones ni uno sin límite. */
export const VERSION_POLICY_LIMITS = { coalesceSeconds: { min: 0, max: 3600 }, keepAutomatic: { min: 1, max: 1000 }, maxVersions: { max: 5000 } } as const;

/** La política con los valores que falten por omisión. Un valor que no es un entero dentro de las cotas es un error (`invalid`): no se ajusta en silencio. */
export function resolveVersionPolicy(partial: Partial<VersionPolicy> = {}): VersionPolicy {
  const pick = (name: keyof VersionPolicy, min: number, max: number, label: string): number => {
    const value = partial[name] ?? DEFAULT_VERSION_POLICY[name];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new ProjectError('invalid', `${label} debe ser un entero entre ${min} y ${max} (se recibió ${String(value)}).`, { reason: 'policy-range', params: { setting: name, min, max, value: String(value) } });
    }
    return value;
  };
  const { coalesceSeconds, keepAutomatic, maxVersions } = VERSION_POLICY_LIMITS;
  const policy: VersionPolicy = {
    coalesceSeconds: pick('coalesceSeconds', coalesceSeconds.min, coalesceSeconds.max, 'El tiempo de coalescencia (segundos)'),
    keepAutomatic: pick('keepAutomatic', keepAutomatic.min, keepAutomatic.max, 'El número de versiones automáticas'),
    maxVersions: 0,
  };
  // El tope total debe dejar sitio, como mínimo, para una versión con nombre: si no, nunca se podría nombrar ninguna.
  policy.maxVersions = pick('maxVersions', policy.keepAutomatic + 1, maxVersions.max, 'El tope de versiones por diagrama');
  return policy;
}

/** Cuántas versiones con nombre admite un diagrama con esta política. */
export const maxNamedVersions = (policy: VersionPolicy): number => policy.maxVersions - policy.keepAutomatic;

/** Lo que ocupa el historial: el punto de enganche para contar bytes por proyecto (las cuotas suman `bytes` a lo que ya cuenta cada proyecto). */
export interface VersionUsage {
  versions: number;
  bytes: number;
}

export const versionUsageOf = (versions: Iterable<VersionMeta>): VersionUsage => {
  const usage: VersionUsage = { versions: 0, bytes: 0 };
  for (const v of versions) {
    usage.versions += 1;
    usage.bytes += v.size;
  }
  return usage;
};

/** El resultado de restaurar: el diagrama como quedó y la versión que se creó (o, si ya tenía ese contenido, la última, con `unchanged`). */
export interface RestoredVersion {
  diagram: DiagramMeta;
  version: VersionMeta;
  /** El diagrama ya tenía justo ese contenido: no se guardó nada. */
  unchanged: boolean;
}

export interface RestoreOptions {
  /** Como en `SaveDiagramInput.ifUpdatedAt`: solo restaura si el diagrama sigue teniendo esta marca; si no, `conflict`. */
  ifUpdatedAt?: string;
  /** Quién restaura (lo rellena un servidor con la identidad de la petición; un cliente remoto no lo puede fijar). */
  by?: string;
}

/**
 * Un almacén con historial. Los almacenes que lo guardan (memoria, IndexedDB, carpeta) y el cliente remoto lo cumplen; uno que
 * no (`keepsVersions` ausente o `false`) sigue siendo un `ProjectStore` válido y la interfaz lo degrada sin historial.
 */
export interface VersionedProjectStore extends ProjectStore {
  readonly keepsVersions: true;
  /** Las versiones de un diagrama, la más reciente primero, sin documento. */
  listVersions(projectId: string, diagramId: string): Promise<VersionMeta[]>;
  /** Una versión con su documento, o `undefined` si ese diagrama no tiene esa versión (ya no existe o se descartó). */
  getVersion(projectId: string, diagramId: string, versionId: number): Promise<DiagramVersion | undefined>;
  /**
   * Guarda como versión NUEVA el contenido de una versión anterior y lo deja como documento del diagrama. No borra ni cambia ninguna
   * versión. Respeta `ifUpdatedAt` (`conflict` si alguien guardó en medio) y lo mismo que `saveDiagram` en un servidor con roles.
   */
  restoreVersion(projectId: string, diagramId: string, versionId: number, options?: RestoreOptions): Promise<RestoredVersion>;
  /** Pone (o cambia) el nombre de una versión: desde entonces no se sustituye ni se descarta sola. `invalid` si ya hay el máximo de nombradas. */
  labelVersion(projectId: string, diagramId: string, versionId: number, label: string): Promise<VersionMeta>;
  /** Borra una versión CON NOMBRE (las automáticas se descartan solas al rotar). `invalid` si no tiene nombre. */
  deleteVersion(projectId: string, diagramId: string, versionId: number): Promise<void>;
  /**
   * Lo que ocupa el historial de un proyecto (versiones y bytes). Es el punto de enganche de las cuotas: quien las implemente suma
   * `bytes` a lo que cuenta el proyecto. Un cliente remoto no lo ofrece (lo cuenta el servidor).
   */
  versionUsage?(projectId: string): Promise<VersionUsage>;
}

/** ¿Este almacén guarda historial de versiones? (La interfaz lo pregunta antes de ofrecerlo.) */
export function isVersioned(store: ProjectStore): store is VersionedProjectStore {
  return store.keepsVersions === true && typeof (store as Partial<VersionedProjectStore>).listVersions === 'function';
}

/** El error de un almacén que no guarda historial. */
export const unsupportedVersions = (): ProjectError => new ProjectError('unsupported', 'Este almacén no guarda historial de versiones.', { reason: 'versions-unsupported' });

// ───────────── contenido: tamaño y hash ─────────────

const K = Uint32Array.of(
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/**
 * SHA-256 en JavaScript puro y síncrono. `crypto.subtle` no existe en una página servida por http fuera de localhost y es asíncrono;
 * el hash se calcula igual en el navegador, en el servidor y en el CLI, y el historial no puede depender de dónde corre.
 */
export function sha256Hex(bytes: Uint8Array): string {
  const h = Uint32Array.of(0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19);
  const length = bytes.length;
  const padded = new Uint8Array(Math.ceil((length + 9) / 64) * 64);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((length * 8) / 2 ** 32));
  view.setUint32(padded.length - 4, (length * 8) >>> 0);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  return [...h].map((word) => word.toString(16).padStart(8, '0')).join('');
}

/** Tamaño en bytes (UTF-8) y hash del documento: lo que cada versión recuerda de su contenido. */
export function describeContent(text: string): { size: number; hash: string } {
  const bytes = new TextEncoder().encode(text);
  return { size: bytes.length, hash: sha256Hex(bytes) };
}

// ───────────── validación de lo que llega de fuera ─────────────

/** El id de una versión escrito en una ruta o un argumento (`7`): un entero positivo y corto. `undefined` si no lo es (`07`, `-1`, `1.5`, `1e3`, `abc`). */
export function parseVersionId(value: unknown): number | undefined {
  const text = typeof value === 'number' ? String(value) : value;
  return typeof text === 'string' && /^[1-9][0-9]{0,8}$/.test(text) ? Number(text) : undefined;
}

export function requireVersionId(value: unknown): number {
  const id = parseVersionId(value);
  if (id === undefined) throw new ProjectError('invalid', `Identificador de versión inválido «${String(value).slice(0, 40)}» (es un número entero positivo).`, { reason: 'version-id-invalid', params: { value: String(value).slice(0, 40) } });
  return id;
}

/** El nombre de una versión: limpio, no vacío y de un tamaño razonable. */
export const cleanVersionLabel = (raw: unknown): string => cleanName(raw, 'de la versión');

/** Quién guarda, tal como se anota en la versión: sin caracteres de control ni espacios sobrantes y acotado; `undefined` si no queda nada. */
export function cleanBy(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const by = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  return by || undefined;
}

// ───────────── qué versión se crea, se sustituye o se descarta ─────────────

export interface SaveFacts {
  savedAt: string;
  savedBy?: string;
  size: number;
  hash: string;
  restoredFrom?: number;
}

export interface PlanInput {
  /** Las versiones que hay, de la más antigua a la más reciente. */
  existing: readonly VersionMeta[];
  /** El mayor id que se ha dado a este diagrama (aunque esa versión ya no esté): los ids no se reutilizan. */
  lastId: number;
  /**
   * El hash del último contenido que el historial vio guardar, aunque la versión que lo guardaba ya no esté (se borró a mano): así borrar
   * la última versión no la resucita como «línea base» en el guardado siguiente. Sin él (un historial anterior) se usa el de la última versión.
   */
  headHash?: string;
  /** El contenido que tenía el diagrama justo antes de este guardado, si lo tenía; `at` es su fecha de guardado (ISO 8601). */
  previous?: { size: number; hash: string; at: string };
  next: SaveFacts;
  policy: VersionPolicy;
  /** `false` en una restauración: siempre crea su propia versión, nunca sustituye la anterior. */
  coalesce: boolean;
}

/** Una versión que hay que crear, y de qué documento: el que había antes del guardado (la línea base) o el que se guarda. */
export interface PlannedVersion extends VersionMeta {
  from: 'previous' | 'next';
}

export interface VersionPlan {
  /** Las versiones nuevas, en orden. Vacío si el guardado no cambia el contenido. */
  add: PlannedVersion[];
  /** Los ids de versiones EXISTENTES que se descartan (por sustitución o por rotación). */
  drop: number[];
  /** El mayor id dado a partir de ahora. */
  lastId: number;
  /** El hash del contenido guardado a partir de ahora (a guardar junto a `lastId`). */
  headHash: string;
  /** El contenido es idéntico al de la última versión: no se crea nada. */
  unchanged: boolean;
}

const stamp = (iso: string, after: string | undefined): string => {
  const wanted = Date.parse(iso);
  const floor = after === undefined ? Number.NEGATIVE_INFINITY : Date.parse(after) + 1;
  return new Date(Math.max(Number.isNaN(wanted) ? 0 : wanted, floor)).toISOString();
};

/** Decide, sin tocar nada, qué hay que crear y qué descartar al guardar un diagrama. Pura: los almacenes aplican el resultado. */
export function planSave(input: PlanInput): VersionPlan {
  const { next, policy } = input;
  let versions = [...input.existing];
  let lastId = Math.max(input.lastId, ...versions.map((v) => v.id), 0);
  const add: PlannedVersion[] = [];
  const drop: number[] = [];
  const latest = (): VersionMeta | undefined => versions[versions.length - 1];

  // Retención: lo más viejo sin nombre, hasta quedar dentro de los topes. La versión más reciente (el estado actual) nunca sale.
  const retain = (): void => {
    const automatic = (): VersionMeta[] => versions.filter((v) => v.label === undefined);
    while (automatic().length > policy.keepAutomatic || versions.length > policy.maxVersions) {
      const newest = latest();
      const oldest = automatic().find((v) => v !== newest);
      if (!oldest) break;
      versions = versions.filter((v) => v !== oldest);
      const created = add.findIndex((v) => v.id === oldest.id);
      if (created >= 0) add.splice(created, 1);
      else drop.push(oldest.id);
    }
  };

  let head = input.headHash ?? latest()?.hash;
  let baseline = false;
  if (input.previous && head !== input.previous.hash) {
    const version: PlannedVersion = { id: ++lastId, savedAt: stamp(input.previous.at, latest()?.savedAt), size: input.previous.size, hash: input.previous.hash, from: 'previous' };
    versions.push(version);
    add.push(version);
    head = input.previous.hash;
    baseline = true;
  }

  if (head === next.hash) {
    retain();
    return { add, drop, lastId, headHash: next.hash, unchanged: true };
  }
  const last = latest();

  const opened = last ? Date.parse(last.savedAt) : Number.NaN;
  const elapsed = Date.parse(next.savedAt) - opened;
  const coalescing =
    input.coalesce &&
    !baseline &&
    policy.coalesceSeconds > 0 &&
    last !== undefined &&
    last.hash === head &&
    last.label === undefined &&
    last.restoredFrom === undefined &&
    last.savedBy === next.savedBy &&
    elapsed >= 0 &&
    elapsed < policy.coalesceSeconds * 1000;
  if (coalescing && last) {
    versions = versions.filter((v) => v !== last);
    drop.push(last.id);
  }
  const version: PlannedVersion = {
    id: ++lastId,
    savedAt: coalescing && last ? last.savedAt : stamp(next.savedAt, latest()?.savedAt),
    ...(next.savedBy !== undefined ? { savedBy: next.savedBy } : {}),
    size: next.size,
    hash: next.hash,
    ...(next.restoredFrom !== undefined ? { restoredFrom: next.restoredFrom } : {}),
    from: 'next',
  };
  versions.push(version);
  add.push(version);
  retain();
  return { add, drop, lastId, headHash: next.hash, unchanged: false };
}

/** Las versiones después de aplicar el plan, de la más antigua a la más reciente. */
export function applyPlan(existing: readonly VersionMeta[], plan: VersionPlan): VersionMeta[] {
  const dropped = new Set(plan.drop);
  return [...existing.filter((v) => !dropped.has(v.id)), ...plan.add.map(versionMeta)].sort((a, b) => a.id - b.id);
}

/** La versión con ese id, o `not-found`. */
export function findVersion(versions: readonly VersionMeta[], id: number): VersionMeta {
  const found = versions.find((v) => v.id === id);
  if (!found) throw new ProjectError('not-found', `No existe la versión ${id} de este diagrama (¿se descartó al rotar el historial?).`, { reason: 'version-missing', params: { id } });
  return found;
}

/** La versión con el nombre puesto. `invalid` (`serverCode: 'limit'`) si ponerlo supera el máximo de versiones nombradas. */
export function planLabel(versions: readonly VersionMeta[], id: number, rawLabel: unknown, policy: VersionPolicy): VersionMeta {
  const label = cleanVersionLabel(rawLabel);
  const current = findVersion(versions, id);
  if (current.label === undefined && versions.filter((v) => v.label !== undefined).length >= maxNamedVersions(policy)) {
    throw new ProjectError('invalid', `Este diagrama ya tiene ${maxNamedVersions(policy)} versiones con nombre, el máximo: borra alguna antes de nombrar otra.`, {
      serverCode: 'limit',
      reason: 'version-limit',
      params: { max: maxNamedVersions(policy) },
    });
  }
  return { ...current, label };
}

/** Comprueba que se puede borrar la versión (solo las nombradas) y la devuelve. */
export function planDelete(versions: readonly VersionMeta[], id: number): VersionMeta {
  const current = findVersion(versions, id);
  if (current.label === undefined) {
    throw new ProjectError('invalid', `La versión ${id} no tiene nombre: solo se borran las versiones con nombre (las automáticas se descartan solas al rotar el historial).`, {
      reason: 'version-unnamed',
      params: { id },
    });
  }
  return current;
}

/** Las versiones de la más reciente a la más antigua (el orden en que se listan). */
export const newestFirst = (versions: readonly VersionMeta[]): VersionMeta[] => [...versions].sort((a, b) => b.id - a.id);

/** Una copia de la versión con solo los campos del contrato (lo que se devuelve a quien llama, sin nada interno). */
export const versionMeta = ({ id, savedAt, savedBy, label, size, hash, restoredFrom }: VersionMeta): VersionMeta => ({
  id,
  savedAt,
  ...(savedBy !== undefined ? { savedBy } : {}),
  ...(label !== undefined ? { label } : {}),
  size,
  hash,
  ...(restoredFrom !== undefined ? { restoredFrom } : {}),
});
