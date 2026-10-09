import { describe, expect, it } from 'vitest';
import { isSafeRequestId, requestIdFrom } from './requestId';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('isSafeRequestId', () => {
  it('acepta UUID, identificadores de traza y los de los proxies (de 1 a 64 caracteres seguros)', () => {
    for (const ok of ['a', '7', 'req-1', '3973a1bd-331c-42a0-8aab-b437527a5dd3', 'abc.DEF_123:456-789', 'a'.repeat(64), 'Root=1-67891233-abcdef012345678912345678']) {
      expect(isSafeRequestId(ok), ok).toBe(ok !== 'Root=1-67891233-abcdef012345678912345678');
    }
  });

  it('rechaza lo que no es seguro en una línea de registro o en una cabecera', () => {
    const bad = ['', ' ', 'a b', 'a'.repeat(65), '-empieza', '.empieza', '_empieza', 'a"b', "a'b", 'a\\b', 'a/b', 'a=b', 'a,b', 'a;b', '{"a":1}', '<x>', 'ñ', 'a\nb', 'a\rb', 'a\0b', 'a\u0085b', 'a\u2028b', 'a\u2029b', '😀'];
    for (const value of bad) expect(isSafeRequestId(value), JSON.stringify(value)).toBe(false);
    for (const value of [undefined, null, 7, {}, ['a']]) expect(isSafeRequestId(value)).toBe(false);
  });
});

describe('requestIdFrom', () => {
  it('devuelve el que viene si es seguro y, si no, un UUID v4 nuevo cada vez', () => {
    expect(requestIdFrom('mi-id-1')).toBe('mi-id-1');
    const generated = [undefined, '', 'a b', ['uno', 'dos'], 'uno, dos'].map((value) => requestIdFrom(value as string | undefined));
    for (const id of generated) expect(id).toMatch(UUID);
    expect(new Set([requestIdFrom(undefined), requestIdFrom(undefined)]).size).toBe(2);
  });
});
