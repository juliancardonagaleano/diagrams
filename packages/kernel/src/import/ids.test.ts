import { describe, expect, it } from 'vitest';
import { MAX_ID_LENGTH, pickId } from './ids';

describe('pickId', () => {
  it('da la base si está libre y base-2, base-3… si no', () => {
    const taken = new Set<string>();
    expect([pickId('a', taken), pickId('a', taken), pickId('a', taken), pickId('b', taken)]).toEqual(['a', 'a-2', 'a-3', 'b']);
    expect([...taken]).toEqual(['a', 'a-2', 'a-3', 'b']);
  });

  it('salta los ids ya ocupados por otro camino y los reservados', () => {
    const taken = new Set(['a', 'a-2']);
    expect(pickId('a', taken)).toBe('a-3');
    expect(pickId('a', new Set(['a']), new Set(['a-2']))).toBe('a-3');
    const used = new Set(['x']);
    const reserved = new Set(['x-2', 'x-3']);
    expect(pickId('x', used, reserved)).toBe('x-4');
    // sin reservados, la misma base vuelve a dar el primer hueco
    expect(pickId('x', used)).toBe('x-2');
  });

  it('recorta la base a la longitud máxima y no se vuelve cuadrático con miles de colisiones', () => {
    const long = pickId('z'.repeat(500), new Set());
    expect(long.length).toBeLessThanOrEqual(MAX_ID_LENGTH);
    const taken = new Set<string>();
    const started = Date.now();
    for (let i = 0; i < 100_000; i += 1) pickId('proceso', taken);
    expect(taken.size).toBe(100_000);
    expect(taken.has('proceso-100000')).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
