/**
 * Núcleo de la internacionalización de la interfaz: sin DOM ni React, para poder probarlo en Node.
 *
 * Un catálogo es un objeto plano `clave → texto`. Un texto puede llevar parámetros `{nombre}` y, en los de varias formas, la clave base tiene una
 * variante por categoría plural de `Intl.PluralRules` (`clave.one`, `clave.other`…; `other` es obligatoria y la que se usa si falta la categoría).
 * Un texto puede llevar `<b>…</b>` y `<code>…</code>` para un fragmento destacado (ver `richParts`); no admite ningún otro marcado.
 */

/** Idiomas de la interfaz. El primero es el de origen: de él salen las claves (`es.ts`) y es el que se usa si no se puede decidir otro. */
export const LANGS = ['es', 'en'] as const;
export type Lang = (typeof LANGS)[number];
export const DEFAULT_LANG: Lang = 'es';

/** Cómo se llama cada idioma en sí mismo (el selector los muestra así, nunca traducidos: quien no lee el idioma actual debe poder encontrar el suyo). */
export const LANG_NAMES: Record<Lang, string> = { es: 'Español', en: 'English' };

/** `en`, `EN`, `en-US` o `en_GB` → `en`; cualquier otra cosa (o un idioma sin catálogo) → `undefined`. */
export function normalizeLang(value: unknown): Lang | undefined {
  if (typeof value !== 'string') return undefined;
  const primary = value.trim().toLowerCase().split(/[-_]/)[0];
  return (LANGS as readonly string[]).includes(primary) ? (primary as Lang) : undefined;
}

export type LangSource = 'url' | 'storage' | 'navigator' | 'default';

export interface LangInputs {
  /** La parte `?…` de la dirección (con o sin el `?`). */
  search?: string;
  /** Lo que haya guardado el selector (localStorage). */
  stored?: string | null;
  /** `navigator.languages` (o `[navigator.language]`), en orden de preferencia. */
  navigator?: readonly string[];
}

/**
 * El idioma de la interfaz: el parámetro `?lang=` de la dirección, y si no, el que la persona eligió (localStorage), y si no, el del navegador (el
 * primero de sus idiomas preferidos que tenga catálogo) y si no, el español. Un valor que no sea un idioma con catálogo se salta (no bloquea a los siguientes).
 */
export function resolveLang(inputs: LangInputs): { lang: Lang; source: LangSource } {
  const fromUrl = normalizeLang(new URLSearchParams(inputs.search ?? '').get('lang'));
  if (fromUrl) return { lang: fromUrl, source: 'url' };
  const fromStorage = normalizeLang(inputs.stored);
  if (fromStorage) return { lang: fromStorage, source: 'storage' };
  for (const candidate of inputs.navigator ?? []) {
    const fromNavigator = normalizeLang(candidate);
    if (fromNavigator) return { lang: fromNavigator, source: 'navigator' };
  }
  return { lang: DEFAULT_LANG, source: 'default' };
}

export type Catalog = Readonly<Record<string, string>>;
export type Params = Readonly<Record<string, string | number>>;

/** Las categorías plurales que se reconocen en el sufijo de una clave. */
export const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;

/** Los parámetros `{nombre}` de un texto, sin repetidos y ordenados. */
export function paramsOf(text: string): string[] {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
}

/** Las etiquetas `<b>`/`</b>`/`<code>`/`</code>` de un texto, en orden (la prueba de paridad exige las mismas en todos los idiomas). */
export function tagsOf(text: string): string[] {
  return [...text.matchAll(/<\/?(?:b|code)>/g)].map((m) => m[0]);
}

const numberFormats = new Map<string, Intl.NumberFormat>();
/** Un número como se escribe en el idioma (`1.234,5` en es, `1,234.5` en en). */
export function formatNumber(lang: Lang, value: number, options?: Intl.NumberFormatOptions): string {
  if (options) return new Intl.NumberFormat(lang, options).format(value);
  let format = numberFormats.get(lang);
  if (!format) numberFormats.set(lang, (format = new Intl.NumberFormat(lang)));
  return format.format(value);
}

/** Sustituye `{nombre}` por su valor (los números, con el formato del idioma). Un parámetro que no se pasó queda tal cual para que se note. */
export function interpolate(lang: Lang, text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : typeof value === 'number' ? formatNumber(lang, value) : value;
  });
}

const pluralRules = new Map<string, Intl.PluralRules>();
/** La categoría plural de `count` en el idioma (`one`, `other`…). */
export function pluralCategory(lang: Lang, count: number): Intl.LDMLPluralRule {
  let rules = pluralRules.get(lang);
  if (!rules) pluralRules.set(lang, (rules = new Intl.PluralRules(lang)));
  return rules.select(count);
}

/** El texto de la clave base `base` que corresponde a `count`: su categoría plural, o `other` si el catálogo no distingue esa. */
export function pluralText(lang: Lang, catalog: Catalog, base: string, count: number): string | undefined {
  return catalog[`${base}.${pluralCategory(lang, count)}`] ?? catalog[`${base}.other`];
}

/** El texto de una clave en un catálogo con sus parámetros puestos; si la clave no existe, la propia clave (se nota en pantalla y en las pruebas). */
export function translate(lang: Lang, catalog: Catalog, key: string, params?: Params): string {
  const text = catalog[key];
  return text === undefined ? key : interpolate(lang, text, params);
}

/** `translate` de una clave plural: `count` se pasa también como `{count}`. */
export function translatePlural(lang: Lang, catalog: Catalog, base: string, count: number, params?: Params): string {
  const text = pluralText(lang, catalog, base, count);
  return text === undefined ? base : interpolate(lang, text, { count, ...params });
}

export type RichPart = { kind: 'text' | 'b' | 'code'; text: string };

/** Parte un texto con `<b>…</b>` y `<code>…</code>` en trozos para dibujarlos (sin `innerHTML`: el resto se escribe tal cual, aunque lleve `<`). */
export function richParts(text: string): RichPart[] {
  const parts: RichPart[] = [];
  const pattern = /<(b|code)>(.*?)<\/\1>/gs;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) parts.push({ kind: 'text', text: text.slice(last, at) });
    parts.push({ kind: match[1] as 'b' | 'code', text: match[2] });
    last = at + match[0].length;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}

/** Una fecha (un `Date`, milisegundos o un texto ISO) en el idioma; `''` si no es una fecha válida. */
export function formatDate(lang: Lang, value: Date | number | string, options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(lang, options).format(date);
}
