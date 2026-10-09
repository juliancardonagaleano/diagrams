import { describe, expect, it } from 'vitest';
import type { MigrationSource } from '@iark/kernel';
import { migratePersistedDocument, migratePersistedState, PERSIST_VERSION } from './persistMigration';

/** Una cadena de prueba 1.0 → 1.1 → 2.0 sobre un documento mínimo, independiente de las migraciones reales de C4. */
const fuente: MigrationSource = {
  id: 'c4',
  documentVersion: '2.0',
  migrations: [
    { from: '1.0', to: '1.1', migrate: (d) => ({ ...(d as object), paso1: true }) },
    { from: '1.1', to: '2.0', migrate: (d) => ({ ...(d as object), paso2: true }) },
  ],
};

const estado = (doc: unknown) => ({ doc, activeViewId: 'ctx', ui: { theme: 'dark' }, lastSavedAt: 123 });

describe('migratePersistedDocument: el documento guardado en el navegador pasa por las migraciones del módulo', () => {
  it('lleva el documento guardado a la versión actual y conserva el resto del estado', () => {
    const entrada = estado({ version: '1.0', nombre: 'X' });
    const copia = structuredClone(entrada);
    const salida = migratePersistedDocument(entrada, fuente) as ReturnType<typeof estado>;
    expect(salida.doc).toEqual({ version: '2.0', nombre: 'X', paso1: true, paso2: true });
    expect({ ...salida, doc: undefined }).toEqual({ ...copia, doc: undefined });
    expect(entrada).toEqual(copia); // no muta lo que le pasan
  });

  it('un documento en la versión actual, o sin versión, se deja tal cual (mismo objeto)', () => {
    const actual = estado({ version: '2.0' });
    expect(migratePersistedDocument(actual, fuente)).toBe(actual);
    const sinVersion = estado({ nombre: 'X' });
    expect(migratePersistedDocument(sinVersion, fuente)).toBe(sinVersion);
  });

  it('lo que no se puede migrar (más nuevo, o anterior sin cadena) se deja intacto: no se borra el diagrama de la persona', () => {
    const futuro = estado({ version: '3.0', nombre: 'del futuro' });
    expect(migratePersistedDocument(futuro, fuente)).toBe(futuro);
    const antiguo = estado({ version: '0.5' });
    expect(migratePersistedDocument(antiguo, fuente)).toBe(antiguo);
  });

  it('lo que no es un estado con documento (nada guardado, otro tipo) pasa sin tocar', () => {
    expect(migratePersistedDocument(undefined, fuente)).toBeUndefined();
    expect(migratePersistedDocument(null, fuente)).toBeNull();
    expect(migratePersistedDocument('texto', fuente)).toBe('texto');
    const sinDoc = { ui: { theme: 'dark' } };
    expect(migratePersistedDocument(sinDoc, fuente)).toBe(sinDoc);
  });
});

describe('migratePersistedState: el `migrate` de zustand persist', () => {
  it('la versión de la forma persistida es un entero ≥ 1', () => {
    expect(Number.isInteger(PERSIST_VERSION)).toBe(true);
    expect(PERSIST_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('lo guardado con una versión anterior de la forma (0 o ausente) se conserva y su documento se migra', () => {
    for (const version of [0, PERSIST_VERSION]) {
      const salida = migratePersistedState(estado({ version: '1.0' }), version, fuente) as ReturnType<typeof estado>;
      expect(salida.doc).toMatchObject({ version: '2.0', paso1: true, paso2: true });
      expect(salida.activeViewId).toBe('ctx');
    }
  });

  it('un estado de una versión MÁS NUEVA de la forma (se volvió a una app anterior) se deja tal cual', () => {
    const futuro = estado({ version: '1.0' });
    expect(migratePersistedState(futuro, PERSIST_VERSION + 1, fuente)).toBe(futuro);
  });
});
