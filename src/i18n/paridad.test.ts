import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LANGS, PLURAL_CATEGORIES, paramsOf, tagsOf, type Catalog } from './core';
import { CATALOGS } from './index';

/**
 * La puerta de paridad: todos los idiomas tienen exactamente las mismas claves, con los mismos parámetros y las mismas etiquetas, y ninguna clave
 * queda sin usar ni se usa sin estar definida. Si falla, el mensaje dice qué clave y en qué idioma.
 */

const ROOT = join(import.meta.dirname, '..');
const SOURCE = 'es' as const;

/** `clave.one`/`clave.other`… → `clave`; las demás, tal cual. */
const baseOf = (key: string): string => {
  const dot = key.lastIndexOf('.');
  return dot > 0 && (PLURAL_CATEGORIES as readonly string[]).includes(key.slice(dot + 1)) ? key.slice(0, dot) : key;
};

/** Por clave normalizada (plural colapsado): los parámetros y las etiquetas de todas sus variantes. */
function describeCatalog(catalog: Catalog): Map<string, { params: string[]; tags: string[]; categories: string[] }> {
  const out = new Map<string, { params: Set<string>; tags: string[]; categories: string[] }>();
  for (const [key, text] of Object.entries(catalog)) {
    const base = baseOf(key);
    const entry = out.get(base) ?? { params: new Set<string>(), tags: [], categories: [] };
    for (const param of paramsOf(text)) entry.params.add(param);
    entry.tags = entry.tags.length ? entry.tags : tagsOf(text);
    entry.categories.push(base === key ? '' : key.slice(base.length + 1));
    out.set(base, entry);
  }
  return new Map([...out].map(([key, v]) => [key, { params: [...v.params].sort(), tags: v.tags, categories: v.categories }]));
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === 'node_modules') continue;
      found.push(...sourceFiles(path));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) found.push(path);
  }
  return found;
}

/** El código de la interfaz sin los catálogos: ahí es donde se usan las claves. */
function interfaceSource(): { path: string; text: string }[] {
  const catalogs = [join(ROOT, 'i18n', 'es'), join(ROOT, 'i18n', 'en')];
  return sourceFiles(ROOT)
    .filter((path) => !catalogs.some((dir) => path.startsWith(dir + '/')))
    .map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, 'utf8') }));
}

describe('paridad de los catálogos', () => {
  const described = Object.fromEntries(LANGS.map((lang) => [lang, describeCatalog(CATALOGS[lang])]));

  it('hay un catálogo por idioma y el de origen no está vacío', () => {
    for (const lang of LANGS) expect(CATALOGS[lang], lang).toBeDefined();
    expect(Object.keys(CATALOGS[SOURCE]).length).toBeGreaterThan(50);
  });

  it.each(LANGS.filter((l) => l !== SOURCE))('%s tiene exactamente las mismas claves que el español', (lang) => {
    const source = Object.keys(CATALOGS[SOURCE]);
    const other = Object.keys(CATALOGS[lang]);
    expect(
      source.filter((k) => !(k in CATALOGS[lang])),
      `faltan en ${lang}`,
    ).toEqual([]);
    expect(
      other.filter((k) => !(k in CATALOGS[SOURCE])),
      `sobran en ${lang}`,
    ).toEqual([]);
  });

  it.each(LANGS.filter((l) => l !== SOURCE))('%s usa los mismos parámetros y las mismas etiquetas en cada texto', (lang) => {
    const problems: string[] = [];
    for (const [key, text] of Object.entries(CATALOGS[SOURCE])) {
      const translated = CATALOGS[lang][key];
      if (translated === undefined) continue;
      const a = paramsOf(text).join(',');
      const b = paramsOf(translated).join(',');
      if (a !== b) problems.push(`${key}: parámetros {${a}} en ${SOURCE} y {${b}} en ${lang}`);
      const ta = tagsOf(text).join('');
      const tb = tagsOf(translated).join('');
      if (ta !== tb) problems.push(`${key}: etiquetas «${ta}» en ${SOURCE} y «${tb}» en ${lang}`);
    }
    expect(problems).toEqual([]);
  });

  it('los textos de las claves plurales: todas tienen «other» y sus categorías son válidas, con los mismos parámetros entre idiomas', () => {
    for (const lang of LANGS) {
      for (const [base, entry] of described[lang]) {
        const plural = entry.categories.some((c) => c !== '');
        if (!plural) continue;
        expect(entry.categories, `${lang}: ${base}`).toContain('other');
        expect(entry.categories.every((c) => (PLURAL_CATEGORIES as readonly string[]).includes(c)), `${lang}: ${base}`).toBe(true);
        expect(entry.params, `${lang}: ${base} usa {count}`).toContain('count');
        expect(entry.categories.includes(''), `${lang}: ${base} mezcla plural y simple`).toBe(false);
      }
    }
    for (const lang of LANGS) {
      expect([...described[lang].keys()].sort(), lang).toEqual([...described[SOURCE].keys()].sort());
      for (const [base, entry] of described[lang]) expect(entry.params, `${lang}: ${base}`).toEqual(described[SOURCE].get(base)!.params);
    }
  });

  it('ningún texto está vacío ni sobra espacio al borde', () => {
    for (const lang of LANGS) {
      for (const [key, text] of Object.entries(CATALOGS[lang])) {
        expect(typeof text, `${lang}: ${key}`).toBe('string');
        expect(text.trim(), `${lang}: ${key} vacío`).not.toBe('');
        expect(text, `${lang}: ${key} con espacios al borde`).toBe(text.trim());
      }
    }
  });

  it('un texto en inglés no es el español sin traducir (sin ¿ ¡ « » ni vocales con tilde)', () => {
    // Nombres propios y marcas que se escriben igual pueden listarse aquí: ninguno hace falta hoy.
    const allowed = new Set<string>();
    const left = Object.entries(CATALOGS.en).filter(([key, text]) => !allowed.has(key) && /[¿¡«»áéíóúñÁÉÍÓÚÑ]/.test(text));
    expect(left.map(([key]) => key)).toEqual([]);
  });
});

describe('uso de las claves', () => {
  const files = interfaceSource();
  const all = files.map((f) => f.text).join('\n');
  const keys = Object.keys(CATALOGS[SOURCE]);
  const bases = new Set(keys.map(baseOf));

  it('no queda ninguna clave sin usar', () => {
    // Una clave se da por usada si su texto exacto aparece entre comillas en el código (`t('x.y')`, una tabla `motivo → clave`…). Las plurales, por su clave base.
    const unused = [...bases].filter((base) => !new RegExp(`['"\`]${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(all));
    expect(unused, 'claves definidas que ningún código usa: bórralas o úsalas').toEqual([]);
  });

  it('no se usa ninguna clave sin definir', () => {
    const calls = [...all.matchAll(/\b(?:t|tp|tr|tIn|tpIn|tAny)\(\s*(?:'lang'|'[a-z]{2}',\s*)?(['"])([a-z][\w.-]*)\1/g)].map((m) => m[2]);
    const undefinedKeys = [...new Set(calls)].filter((key) => !(key in CATALOGS[SOURCE]) && !bases.has(key));
    expect(undefinedKeys, 'claves que el código pide y el catálogo no tiene').toEqual([]);
    expect(calls.length, 'la búsqueda de usos encontró llamadas').toBeGreaterThan(20);
  });
});
