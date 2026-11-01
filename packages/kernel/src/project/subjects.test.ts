import { describe, expect, it } from 'vitest';
import { otherAppearances, parseSubjects } from './subjects';

describe('sujetos de un proyecto', () => {
  const raw = [
    {
      id: 'api',
      name: ' API de pedidos ',
      appearances: [
        { diagramId: 'c4', module: 'c4', elementId: 'api' },
        { diagramId: 'plat', module: 'platform', elementId: 'svc-api', viewId: 'env:prod' },
        { diagramId: 'mal', module: '' },
      ],
    },
    { id: 'vacio', name: 'Sin sitios', appearances: [] },
    { id: '!!', name: 'Id inválido', appearances: [{ diagramId: 'c4', module: 'c4', elementId: 'x' }] },
  ];

  it('deja fuera lo que no se entiende y recorta el nombre', () => {
    expect(parseSubjects(raw)).toEqual([
      {
        id: 'api',
        name: 'API de pedidos',
        appearances: [
          { diagramId: 'c4', module: 'c4', elementId: 'api' },
          { diagramId: 'plat', module: 'platform', elementId: 'svc-api', viewId: 'env:prod' },
        ],
      },
    ]);
    expect(parseSubjects([])).toBeUndefined();
    expect(parseSubjects('no')).toBeUndefined();
  });

  it('otras apariciones son las del mismo sujeto, menos la actual', () => {
    const subjects = parseSubjects(raw);
    expect(otherAppearances(subjects, 'c4', 'api')).toEqual([
      { diagramId: 'plat', module: 'platform', elementId: 'svc-api', viewId: 'env:prod', subject: 'API de pedidos' },
    ]);
    expect(otherAppearances(subjects, 'c4', 'otro')).toEqual([]);
    expect(otherAppearances(undefined, 'c4', 'api')).toEqual([]);
  });
});
