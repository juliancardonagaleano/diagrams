import { describe, expect, it } from 'vitest';
import { asArray, asRecord, asString, readJsonText } from './json';

describe('lectura de JSON de los importadores', () => {
  it('lee un JSON válido, con o sin marca de orden de bytes', () => {
    expect(readJsonText('{"a":[1,2]}', 'El archivo')).toEqual({ ok: true, value: { a: [1, 2] } });
    expect(readJsonText('﻿[1]', 'El archivo')).toEqual({ ok: true, value: [1] });
  });

  it('explica el motivo de lo que no se puede leer, sin lanzar', () => {
    expect(readJsonText('', 'El archivo')).toEqual({ ok: false, message: 'El archivo está vacío.' });
    expect(readJsonText(' \n\t', 'El archivo')).toEqual({ ok: false, message: 'El archivo está vacío.' });
    const truncated = readJsonText('{"a":', 'El archivo');
    expect(truncated).toMatchObject({ ok: false });
    expect(truncated.ok ? '' : truncated.message).toMatch(/^El archivo no es JSON válido.*termina antes de tiempo/);
    const bad = readJsonText('[1,\n2,\n3 4]', 'El archivo');
    expect(bad.ok ? '' : bad.message).toMatch(/^El archivo no es JSON válido/);
  });

  it('señala la línea y la columna cuando el motor las da', () => {
    const bad = readJsonText('[1,\n2,\n3 4]', 'El archivo');
    const message = bad.ok ? '' : bad.message;
    // Node antiguo no cita la posición: en ese caso solo se dice que no es válido.
    if (message.includes('(')) expect(message).toMatch(/\(línea 3, columna 3\)/);
  });

  it('rechaza un anidamiento enorme sin agotar la pila y un texto de más de 32 MiB sin analizarlo', () => {
    const deep = readJsonText(`${'['.repeat(100_000)}${']'.repeat(100_000)}`, 'El archivo');
    expect(deep.ok ? '' : deep.message).toMatch(/anidado/);
    const big = readJsonText(`"${'a'.repeat(33 * 1024 * 1024)}"`, 'El archivo');
    expect(big.ok ? '' : big.message).toMatch(/demasiado grande/);
  });

  it('los ayudantes de valor distinguen objeto, lista y texto', () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord([1])).toBeUndefined();
    expect(asRecord(null)).toBeUndefined();
    expect(asArray([1])).toEqual([1]);
    expect(asArray({ a: 1 })).toEqual([]);
    expect(asString('  x ')).toBe('x');
    expect(asString('   ')).toBeUndefined();
    expect(asString(3)).toBeUndefined();
  });
});
