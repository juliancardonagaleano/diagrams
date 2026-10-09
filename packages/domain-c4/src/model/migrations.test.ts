import { afterEach, describe, expect, it } from 'vitest';
import { analyzeValue } from '@iark/kernel';
import { DOC_C4_0_9, instalarMigracionesC4 } from '../../../../tests/helpers/migracionC4';
import { c4Module } from '../module';
import { C4_MIGRATIONS } from './migrations';
import { DocumentValidationError, parseDocument, validateDocument } from './schema';
import { sampleDocument } from './sample';

let restaurar: (() => void) | undefined;
afterEach(() => restaurar?.());

describe('migraciones del documento C4 (hoy no hay ninguna real)', () => {
  it('el módulo expone la misma cadena que usa validateDocument, y hoy está vacía', () => {
    expect(c4Module.migrations).toBe(C4_MIGRATIONS);
    expect(C4_MIGRATIONS).toEqual([]);
  });

  it('un documento de la versión actual, o sin versión, no cambia de comportamiento', () => {
    expect(validateDocument(sampleDocument)).toMatchObject({ ok: true });
    expect(validateDocument(sampleDocument)).not.toHaveProperty('migrated');
    const sinVersion = validateDocument({ workspace: { name: 'X' } });
    expect(sinVersion).toMatchObject({ ok: true, document: { version: '1.0', workspace: { name: 'X' } } });
  });

  it('una versión anterior sin migración se rechaza diciendo por qué (en vez del «Invalid input» del literal)', () => {
    const result = validateDocument(DOC_C4_0_9);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([{ path: 'version', message: expect.stringMatching(/versión 0\.9 del documento no está soportada por el módulo «c4».*no declara migraciones/) }]);
  });

  it('una versión MÁS NUEVA se rechaza con el mensaje claro, también desde parseDocument', () => {
    const futuro = { ...sampleDocument, version: '2.0' };
    const result = validateDocument(futuro);
    expect(result.ok === false && result.issues[0].message).toMatch(/versión más nueva \(2\.0\).*Actualiza DIAgrams/);
    expect(() => parseDocument(futuro)).toThrow(DocumentValidationError);
    expect(() => parseDocument(futuro)).toThrow(/más nueva/);
  });

  it('con una migración declarada, validateDocument migra antes de validar y lo dice en `migrated`', () => {
    restaurar = instalarMigracionesC4();
    const entrada = structuredClone(DOC_C4_0_9);
    const result = validateDocument(entrada);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.migrated).toEqual({ from: '0.9', to: '1.0' });
    expect(result.document.version).toBe('1.0');
    expect(result.document.workspace.name).toBe('Banca antigua');
    expect(entrada).toEqual(DOC_C4_0_9); // la entrada no se muta
    expect(parseDocument(DOC_C4_0_9).workspace.name).toBe('Banca antigua');
  });

  it('el módulo C4 (analyzeValue) migra con la misma cadena y antepone la nota informativa', () => {
    restaurar = instalarMigracionesC4();
    const analysis = analyzeValue(c4Module, DOC_C4_0_9);
    expect(analysis.status).toBe('ok');
    if (analysis.status !== 'ok') return;
    expect(analysis.migrated).toEqual({ from: '0.9', to: '1.0' });
    expect(analysis.issues[0]).toEqual({ severity: 'info', message: 'Documento migrado de la versión 0.9 a 1.0; al guardarlo se escribe en la nueva.' });
  });
});
