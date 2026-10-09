import { describe, expect, it } from 'vitest';
import { formatDate, formatNumber, interpolate, normalizeLang, paramsOf, pluralCategory, pluralText, resolveLang, richParts, tagsOf, translate, translatePlural } from './core';

describe('normalizeLang', () => {
  it('acepta el código con región, en mayúsculas o con guion bajo y rechaza lo que no tiene catálogo', () => {
    expect(normalizeLang('en')).toBe('en');
    expect(normalizeLang('EN-us')).toBe('en');
    expect(normalizeLang('es_MX')).toBe('es');
    expect(normalizeLang(' es ')).toBe('es');
    expect(normalizeLang('fr')).toBeUndefined();
    expect(normalizeLang('')).toBeUndefined();
    expect(normalizeLang(undefined)).toBeUndefined();
    expect(normalizeLang(42)).toBeUndefined();
  });
});

describe('resolveLang: ?lang= > localStorage > navegador > español', () => {
  it('manda el parámetro de la dirección sobre todo lo demás', () => {
    expect(resolveLang({ search: '?lang=en', stored: 'es', navigator: ['es-ES'] })).toEqual({ lang: 'en', source: 'url' });
    expect(resolveLang({ search: 'x=1&lang=es', stored: 'en', navigator: ['en-US'] })).toEqual({ lang: 'es', source: 'url' });
  });

  it('sin parámetro, lo que eligió la persona sobre el navegador', () => {
    expect(resolveLang({ search: '', stored: 'en', navigator: ['es-ES'] })).toEqual({ lang: 'en', source: 'storage' });
  });

  it('sin parámetro ni elección, el primer idioma del navegador que tenga catálogo', () => {
    expect(resolveLang({ navigator: ['fr-FR', 'en-GB', 'es'] })).toEqual({ lang: 'en', source: 'navigator' });
    expect(resolveLang({ navigator: ['es-AR'] })).toEqual({ lang: 'es', source: 'navigator' });
  });

  it('un valor desconocido se salta y no bloquea a los siguientes', () => {
    expect(resolveLang({ search: '?lang=fr', stored: 'de', navigator: ['en-US'] })).toEqual({ lang: 'en', source: 'navigator' });
    expect(resolveLang({ search: '?lang=', stored: null, navigator: [] })).toEqual({ lang: 'es', source: 'default' });
  });

  it('sin nada que decidir, español', () => {
    expect(resolveLang({})).toEqual({ lang: 'es', source: 'default' });
    expect(resolveLang({ navigator: ['fr', 'ja'] })).toEqual({ lang: 'es', source: 'default' });
  });
});

describe('parámetros y etiquetas', () => {
  it('paramsOf lista los {nombre} sin repetir y ordenados', () => {
    expect(paramsOf('Hola {name}, {count} de {name} y {a_b}')).toEqual(['a_b', 'count', 'name']);
    expect(paramsOf('Sin parámetros')).toEqual([]);
  });

  it('interpolate pone los textos tal cual y formatea los números con el idioma', () => {
    expect(interpolate('es', 'Son {n} y {x}', { n: 1234.5, x: 'ok' })).toBe('Son 1234,5 y ok');
    expect(interpolate('en', 'Son {n} y {x}', { n: 1234.5, x: 'ok' })).toBe('Son 1,234.5 y ok');
  });

  it('interpolate deja a la vista el parámetro que falta', () => {
    expect(interpolate('es', 'Hola {name}', {})).toBe('Hola {name}');
    expect(interpolate('es', 'Hola {name}')).toBe('Hola {name}');
  });

  it('tagsOf devuelve las etiquetas en orden', () => {
    expect(tagsOf('a <b>x</b> <code>y</code>')).toEqual(['<b>', '</b>', '<code>', '</code>']);
  });

  it('richParts parte el texto sin interpretar otro marcado', () => {
    expect(richParts('Usa <b>Exportar</b> e <code>iark</code> <i>no</i>.')).toEqual([
      { kind: 'text', text: 'Usa ' },
      { kind: 'b', text: 'Exportar' },
      { kind: 'text', text: ' e ' },
      { kind: 'code', text: 'iark' },
      { kind: 'text', text: ' <i>no</i>.' },
    ]);
    expect(richParts('sin nada')).toEqual([{ kind: 'text', text: 'sin nada' }]);
  });
});

describe('plurales', () => {
  const catalog = { 'n.one': '{count} cosa', 'n.other': '{count} cosas', 'solo.other': '{count} unidades' };

  it('elige la categoría de Intl.PluralRules y cae en other si el catálogo no la distingue', () => {
    expect(pluralCategory('es', 1)).toBe('one');
    expect(pluralCategory('es', 0)).toBe('other');
    expect(pluralCategory('en', 1)).toBe('one');
    expect(pluralCategory('en', 2)).toBe('other');
    expect(translatePlural('es', catalog, 'n', 1)).toBe('1 cosa');
    expect(translatePlural('es', catalog, 'n', 0)).toBe('0 cosas');
    expect(translatePlural('es', catalog, 'n', 2)).toBe('2 cosas');
    expect(translatePlural('es', catalog, 'solo', 1)).toBe('1 unidades');
    // el español distingue «many» desde el millón: sin esa variante vale other
    expect(translatePlural('es', catalog, 'n', 1_000_000)).toBe('1.000.000 cosas');
  });

  it('pluralText y translatePlural con una clave que no existe', () => {
    expect(pluralText('es', catalog, 'no-existe', 1)).toBeUndefined();
    expect(translatePlural('es', catalog, 'no-existe', 1)).toBe('no-existe');
  });

  it('count y los demás parámetros llegan juntos', () => {
    expect(translatePlural('en', { 'x.one': '{count} of {total}', 'x.other': '{count} of {total}' }, 'x', 3, { total: 9 })).toBe('3 of 9');
  });
});

describe('translate, fechas y números', () => {
  it('una clave que no existe se devuelve tal cual (se nota)', () => {
    expect(translate('es', { a: 'A' }, 'b')).toBe('b');
    expect(translate('es', { a: 'A {x}' }, 'a', { x: 1 })).toBe('A 1');
  });

  it('formatDate usa el idioma y devuelve vacío con una fecha inválida', () => {
    const date = new Date('2026-03-05T12:00:00Z');
    expect(formatDate('es', date, { dateStyle: 'medium', timeZone: 'UTC' })).toBe('5 mar 2026');
    expect(formatDate('en', date, { dateStyle: 'medium', timeZone: 'UTC' })).toBe('Mar 5, 2026');
    expect(formatDate('es', 'no es una fecha')).toBe('');
  });

  it('formatNumber usa el separador del idioma', () => {
    expect(formatNumber('es', 1234567.5)).toBe('1.234.567,5');
    expect(formatNumber('en', 1234567.5)).toBe('1,234,567.5');
    expect(formatNumber('en', 0.25, { style: 'percent' })).toBe('25%');
  });
});
