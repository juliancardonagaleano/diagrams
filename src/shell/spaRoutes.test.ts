import { describe, expect, it } from 'vitest';
import { normalizePathname, resolveSpaBootTarget } from './spaRoutes';

describe('spaRoutes', () => {
  it('normaliza barras finales', () => {
    expect(normalizePathname('/studio/')).toBe('/studio');
  });

  it('ruta /modules carga el banco (module en la consulta)', () => {
    const target = resolveSpaBootTarget('/modules/data', new URLSearchParams('embed=1'));
    expect(target.kind).toBe('legacy-modules');
    if (target.kind !== 'legacy-modules') return;
    expect(target.moduleId).toBe('data');
    expect(new URLSearchParams(target.search).get('module')).toBe('data');
    expect(new URLSearchParams(target.search).get('embed')).toBe('1');
  });

  it('/studio gana sobre consultas antiguas', () => {
    expect(resolveSpaBootTarget('/studio', new URLSearchParams())).toEqual({ kind: 'studio' });
  });

  it('conserva ?editor=1 como estudio', () => {
    expect(resolveSpaBootTarget('/', new URLSearchParams('editor=1'))).toEqual({ kind: 'studio' });
  });
});
