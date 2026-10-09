import { describe, expect, it } from 'vitest';
import { IMPORT_LIMITS, textSizeProblem, treeProblem } from './limits';

const nested = (depth: number): unknown => {
  let value: unknown = 'hoja';
  for (let i = 0; i < depth; i += 1) value = [value];
  return value;
};

describe('topes de lectura de los importadores', () => {
  it('un texto dentro del tope no tiene problema y uno mayor lo explica', () => {
    expect(textSizeProblem('abc', 'El archivo')).toBeUndefined();
    expect(textSizeProblem('x'.repeat(11), 'El archivo', 10)).toMatch(/^El archivo es demasiado grande \(11 caracteres; el máximo que se importa es 10\)\.$/);
  });

  it('un árbol razonable cabe: objetos, listas y escalares', () => {
    expect(treeProblem({ a: [1, 2, { b: null }], c: 'x' }, 'El documento')).toBeUndefined();
    expect(treeProblem('texto', 'El documento')).toBeUndefined();
    expect(treeProblem(nested(IMPORT_LIMITS.maxDepth - 1), 'El documento')).toBeUndefined();
  });

  it('rechaza un árbol demasiado profundo sin agotar la pila de llamadas', () => {
    expect(treeProblem(nested(50_000), 'El documento')).toBe(`El documento está anidado en más de ${IMPORT_LIMITS.maxDepth} niveles.`);
    expect(treeProblem(nested(5), 'El documento', { maxDepth: 3 })).toMatch(/más de 3 niveles/);
  });

  it('rechaza un árbol con demasiados nodos', () => {
    const wide = { items: Array.from({ length: 10_000 }, (_, i) => ({ i })) };
    expect(treeProblem(wide, 'El documento')).toBeUndefined();
    expect(treeProblem(wide, 'El documento', { maxNodes: 1_000 })).toMatch(/demasiados nodos \(más de 1\.000\)/);
  });

  it('una referencia circular (que ni el JSON ni el YAML producen) se rechaza en lugar de colgarse', () => {
    const a: Record<string, unknown> = { nombre: 'a' };
    a.yo = a;
    expect(treeProblem(a, 'El documento')).toMatch(/anidado|demasiados nodos/);
  });
});
