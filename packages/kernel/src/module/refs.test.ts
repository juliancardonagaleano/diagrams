import { describe, expect, it } from 'vitest';
import { carryRefs } from './refs';

describe('carryRefs', () => {
  const base = {
    services: [
      { id: 'pedidos', name: 'Pedidos', ref: 'urn:iark:integration:pedidos' },
      { id: 'sin-ref', name: 'Sin enlace' },
    ],
    resources: [{ id: 'pedidos', name: 'Recurso homónimo', ref: 'urn:iark:integration:pedidos-db' }],
    nested: { deep: [{ id: 'k', ref: 'urn:iark:integration:kafka' }] },
  };

  it('devuelve los ref del documento base a lo generado sin ellos', () => {
    const generated = {
      services: [{ id: 'pedidos', name: 'Pedidos v2' }, { id: 'sin-ref', name: 'Sin enlace' }, { id: 'nuevo', name: 'Nuevo' }],
      resources: [{ id: 'pedidos', name: 'Recurso homónimo' }],
      nested: { deep: [{ id: 'k' }] },
    };
    expect(carryRefs(base, generated)).toEqual({
      services: [
        { id: 'pedidos', name: 'Pedidos v2', ref: 'urn:iark:integration:pedidos' },
        { id: 'sin-ref', name: 'Sin enlace' },
        { id: 'nuevo', name: 'Nuevo' },
      ],
      resources: [{ id: 'pedidos', name: 'Recurso homónimo', ref: 'urn:iark:integration:pedidos-db' }],
      nested: { deep: [{ id: 'k', ref: 'urn:iark:integration:kafka' }] },
    });
  });

  it('casa por colección e id: un id repetido en otra colección no hereda el enlace', () => {
    const out = carryRefs(base, { services: [], other: [{ id: 'pedidos' }] });
    expect(out.other).toEqual([{ id: 'pedidos' }]);
  });

  it('respeta el ref que ya traiga el elemento y no muta ninguno de los dos documentos', () => {
    const generated = { services: [{ id: 'pedidos', ref: 'urn:iark:integration:otro' }] };
    const snapshot = structuredClone(generated);
    const baseSnapshot = structuredClone(base);
    expect(carryRefs(base, generated).services[0].ref).toBe('urn:iark:integration:otro');
    expect(generated).toEqual(snapshot);
    expect(base).toEqual(baseSnapshot);
  });

  it('el refType (el tipo del enlace) viaja con su ref y no pisa el que ya traiga lo generado', () => {
    const typed = {
      services: [
        { id: 'a', ref: 'urn:iark:integration:a', refType: 'implements' },
        { id: 'b', ref: 'urn:iark:integration:b' },
        { id: 'c', ref: 'urn:iark:integration:c', refType: 'deploys' },
      ],
    };
    const out = carryRefs(typed, { services: [{ id: 'a' }, { id: 'b' }, { id: 'c', refType: 'protects' }] });
    expect(out.services).toEqual([
      { id: 'a', ref: 'urn:iark:integration:a', refType: 'implements' },
      { id: 'b', ref: 'urn:iark:integration:b' },
      { id: 'c', ref: 'urn:iark:integration:c', refType: 'protects' },
    ]);
    // lo generado que ya trae su ref conserva también su (falta de) tipo
    expect(carryRefs(typed, { services: [{ id: 'a', ref: 'urn:iark:integration:otro' }] }).services[0]).toEqual({ id: 'a', ref: 'urn:iark:integration:otro' });
  });

  it('sin enlaces en la base devuelve lo generado tal cual', () => {
    const generated = { services: [{ id: 'a' }] };
    expect(carryRefs({ services: [{ id: 'a' }] }, generated)).toBe(generated);
    expect(carryRefs(undefined, generated)).toBe(generated);
  });
});
