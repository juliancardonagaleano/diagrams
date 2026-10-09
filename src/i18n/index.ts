import { es } from './es';
import { en } from './en';
import { LANGS, formatDate as formatDateIn, formatNumber as formatNumberIn, resolveLang, translate, translatePlural, type Catalog, type Lang, type LangInputs, type LangSource, type Params } from './core';

export { DEFAULT_LANG, LANGS, LANG_NAMES, normalizeLang, resolveLang, richParts, type Catalog, type Lang, type LangInputs, type LangSource, type Params, type RichPart } from './core';

/**
 * Internacionalización de la interfaz (es / en) sin dependencias: catálogos tipados (`es/` es el de origen y `en/` debe tener las mismas claves y parámetros;
 * lo vigila `src/i18n/i18n.test.ts`), `t()` con parámetros, `tp()` con plurales, fechas y números con `Intl`, y el idioma elegido por
 * `?lang=` > localStorage > `navigator.languages` > español. Cómo añadir una cadena o un idioma: `docs/desarrollo.md`, sección «Internacionalización».
 */

/** Las claves de los mensajes: las del catálogo en español (el de origen). */
export type MessageKey = keyof typeof es;

type ParamNames<S extends string> = S extends `${string}{${infer P}}${infer Rest}` ? P | ParamNames<Rest> : never;
type ParamsFor<K extends MessageKey> = ParamNames<(typeof es)[K]>;
export type MessageArgs<K extends MessageKey> = [ParamsFor<K>] extends [never] ? [params?: undefined] : [params: Record<ParamsFor<K>, string | number>];

/** Las claves base de los mensajes con plural (`algo` cuando existe `algo.other`). */
export type PluralKey = { [K in MessageKey]: K extends `${infer Base}.other` ? Base : never }[MessageKey];
type PluralParams<B extends PluralKey> = Exclude<ParamNames<(typeof es)[`${B}.other` & MessageKey]>, 'count'>;
export type PluralArgs<B extends PluralKey> = [PluralParams<B>] extends [never] ? [params?: undefined] : [params: Record<PluralParams<B>, string | number>];

/** Los catálogos por idioma. Un idioma nuevo se añade aquí (y a `LANGS` en `core.ts`). */
export const CATALOGS: Record<Lang, Catalog> = { es, en };

/** `localStorage`: la elección que hizo la persona con el selector. */
export const LANG_STORAGE_KEY = 'iark.lang';

let current: Lang | undefined;
const listeners = new Set<() => void>();

function browserInputs(): LangInputs {
  if (typeof window === 'undefined') return {};
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(LANG_STORAGE_KEY);
  } catch {
    // ventana privada o datos del sitio bloqueados: se sigue sin lo guardado
  }
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const languages = nav?.languages?.length ? [...nav.languages] : nav?.language ? [nav.language] : [];
  return { search: window.location.search, stored, navigator: languages };
}

/** Por qué se eligió el idioma actual (para el selector y las pruebas). */
export function detectLang(inputs: LangInputs = browserInputs()): { lang: Lang; source: LangSource } {
  return resolveLang(inputs);
}

function applyDocumentLang(lang: Lang): void {
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
}

/** El idioma de la interfaz ahora. La primera vez lo decide `detectLang()`. */
export function getLang(): Lang {
  if (!current) {
    current = detectLang().lang;
    applyDocumentLang(current);
  }
  return current;
}

/** Decide el idioma y pone `<html lang>`; cada pantalla lo llama antes de pintar (leer `getLang()` basta, pero así queda dicho). */
export function initLang(): Lang {
  current = undefined;
  return getLang();
}

export interface SetLangOptions {
  /** Recordar la elección en este navegador (localStorage). Por omisión, sí; el modo embebido no lo recuerda (manda el anfitrión). */
  persist?: boolean;
}

/** Cambia el idioma: `<html lang>`, lo recordado, el `?lang=` de la dirección (si lo trae, para que recargar no lo deshaga) y las pantallas que lo muestran. */
export function setLang(lang: Lang, options: SetLangOptions = {}): void {
  if (!LANGS.includes(lang)) return;
  const changed = current !== lang;
  current = lang;
  applyDocumentLang(lang);
  if (typeof window !== 'undefined') {
    if (options.persist !== false) {
      try {
        window.localStorage.setItem(LANG_STORAGE_KEY, lang);
      } catch {
        // sin almacenamiento: vale para esta visita
      }
    }
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('lang') && url.searchParams.get('lang') !== lang) {
        url.searchParams.set('lang', lang);
        window.history.replaceState(window.history.state, '', url);
      }
    } catch {
      // sin historial (documentos sintéticos): nada que sincronizar
    }
  }
  if (changed) for (const listener of [...listeners]) listener();
}

export function subscribeLang(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Olvida el idioma decidido (solo para pruebas): el siguiente `getLang()` vuelve a decidirlo. */
export function resetLang(): void {
  current = undefined;
}

/** El texto de la clave en el idioma actual, con sus parámetros. */
export function t<K extends MessageKey>(key: K, ...args: MessageArgs<K>): string {
  const lang = getLang();
  return translate(lang, CATALOGS[lang], key, args[0] as Params | undefined);
}

/** Como `t`, pero con una clave y unos parámetros que no se pueden comprobar al compilar (los motivos de error, por ejemplo): las tablas que los usan lo comprueban aparte. */
export function tAny(key: MessageKey, params?: Params): string {
  const lang = getLang();
  return translate(lang, CATALOGS[lang], key, params);
}

/** El texto de una clave en un idioma concreto (no el actual): para pruebas y para quien muestra dos idiomas a la vez. */
export function tIn<K extends MessageKey>(lang: Lang, key: K, ...args: MessageArgs<K>): string {
  return translate(lang, CATALOGS[lang], key, args[0] as Params | undefined);
}

/** El texto plural de la clave base que corresponde a `count` (`{count}` se pone solo), en el idioma actual. */
export function tp<B extends PluralKey>(base: B, count: number, ...args: PluralArgs<B>): string {
  const lang = getLang();
  return translatePlural(lang, CATALOGS[lang], base, count, args[0] as Params | undefined);
}

export function tpIn<B extends PluralKey>(lang: Lang, base: B, count: number, ...args: PluralArgs<B>): string {
  return translatePlural(lang, CATALOGS[lang], base, count, args[0] as Params | undefined);
}

/** Una fecha en el idioma actual (por omisión `dateStyle: 'medium'`). */
export function formatDate(value: Date | number | string, options?: Intl.DateTimeFormatOptions): string {
  return formatDateIn(getLang(), value, options);
}

/** Una hora (`HH:mm:ss`) en el idioma actual. */
export function formatTime(value: Date | number | string): string {
  return formatDateIn(getLang(), value, { timeStyle: 'medium' });
}

/** Una lista de elementos con la conjunción del idioma («a, b y c» / «a, b, and c»). */
export function formatList(items: readonly string[]): string {
  return new Intl.ListFormat(getLang(), { type: 'conjunction', style: 'long' }).format(items);
}

/** Un número en el idioma actual. */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return formatNumberIn(getLang(), value, options);
}
