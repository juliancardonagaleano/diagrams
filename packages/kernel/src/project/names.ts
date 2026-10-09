import { ProjectError } from './errors';

export const MAX_NAME_LENGTH = 120;

/** De qué es el nombre (`what` es el complemento en español que ve el CLI): la interfaz lo traduce por esta clase. */
const KIND_OF_NAME: Record<string, string> = { 'del proyecto': 'project', 'del diagrama': 'diagram', 'de la versión': 'version', 'del token': 'token' };

/** Nombre limpio para mostrar: sin caracteres de control, con los espacios colapsados y sin pasarse de largo. */
export function cleanName(raw: unknown, what: string): string {
  const params = { kind: KIND_OF_NAME[what] ?? 'name' };
  if (typeof raw !== 'string') throw new ProjectError('invalid', `El nombre ${what} debe ser un texto.`, { reason: 'name-not-text', params });
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name) throw new ProjectError('invalid', `El nombre ${what} no puede estar vacío.`, { reason: 'name-empty', params });
  if (name.length > MAX_NAME_LENGTH) throw new ProjectError('invalid', `El nombre ${what} no puede pasar de ${MAX_NAME_LENGTH} caracteres.`, { reason: 'name-too-long', params: { ...params, max: MAX_NAME_LENGTH } });
  return name;
}

/** Clave con la que se comparan los nombres: sin mayúsculas ni diferencias de normalización Unicode. */
export const nameKey = (name: string): string => name.normalize('NFC').toLocaleLowerCase();

export const sameName = (a: string, b: string): boolean => nameKey(a) === nameKey(b);

/** `base`, o `base (2)`, `base (3)`… si ya está tomado. */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const keys = new Set([...taken].map(nameKey));
  if (!keys.has(nameKey(base))) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`;
    if (!keys.has(nameKey(candidate))) return candidate;
  }
}

/**
 * Texto apto para nombre de carpeta o de archivo en cualquier sistema: minúsculas, sin tildes, solo letras, dígitos y
 * guiones. `fallback` se usa si no queda nada (un nombre hecho solo de símbolos).
 */
export function slugify(name: string, fallback = 'sin-titulo'): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || fallback;
}

/** `slug`, o `slug-2`, `slug-3`… si ya está tomado. */
export function uniqueSlug(slug: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(slug)) return slug;
  for (let n = 2; ; n++) if (!used.has(`${slug}-${n}`)) return `${slug}-${n}`;
}

/** Ids de módulo válidos (los mismos que admiten las URN). */
export const MODULE_ID = /^[a-z][a-z0-9-]*$/;

export function requireModuleId(module: unknown): string {
  if (typeof module !== 'string' || !MODULE_ID.test(module)) throw new ProjectError('invalid', `Módulo inválido «${String(module)}» (use minúsculas, dígitos y guiones).`, { reason: 'module-invalid', params: { module: String(module).slice(0, 60) } });
  return module;
}
