import { describe, expect, it } from 'vitest';
import { DEFAULT_PROTOCOL_VERSION, EMBED_PROTOCOL_VERSION, INCOMPATIBLE_PROTOCOL_CODE, negotiateProtocol } from './protocol';

describe('negotiateProtocol', () => {
  it('la versión del protocolo es «mayor.menor» y el código del error es estable', () => {
    expect(EMBED_PROTOCOL_VERSION).toMatch(/^\d+\.\d+$/);
    expect(DEFAULT_PROTOCOL_VERSION).toBe('1.0');
    expect(INCOMPATIBLE_PROTOCOL_CODE).toBe('incompatible-protocol');
  });

  it('la misma versión es compatible', () => {
    expect(negotiateProtocol('1.0', '1.0')).toEqual({ ok: true, version: '1.0', local: '1.0', remote: '1.0' });
  });

  it('una diferencia de MENOR se acepta y se habla la menor de las dos, en cualquier sentido', () => {
    expect(negotiateProtocol('1.0', '1.3')).toMatchObject({ ok: true, version: '1.0' });
    expect(negotiateProtocol('1.3', '1.0')).toMatchObject({ ok: true, version: '1.0' });
    expect(negotiateProtocol('1.10', '1.9')).toMatchObject({ ok: true, version: '1.9' }); // numérico, no alfabético
  });

  it('una diferencia de MAYOR es incompatible, con un mensaje que dice las dos versiones y quién está desactualizado', () => {
    const newerRemote = negotiateProtocol('1.0', '2.0');
    expect(newerRemote).toMatchObject({ ok: false, reason: 'major', local: '1.0', remote: '2.0' });
    expect(newerRemote.ok === false && newerRemote.message).toMatch(/este lado habla la versión 1\.0 y el otro la 2\.0/);
    expect(newerRemote.ok === false && newerRemote.message).toMatch(/Actualiza este lado/);
    const olderRemote = negotiateProtocol('2.0', '1.5');
    expect(olderRemote).toMatchObject({ ok: false, reason: 'major' });
    expect(olderRemote.ok === false && olderRemote.message).toMatch(/Actualiza el otro lado/);
  });

  it('un lado sin versión se trata como 1.0', () => {
    expect(negotiateProtocol('1.0', undefined)).toMatchObject({ ok: true, version: '1.0', remote: '1.0' });
    expect(negotiateProtocol(undefined, '1.2')).toMatchObject({ ok: true, version: '1.0', local: '1.0' });
    expect(negotiateProtocol(undefined, undefined)).toMatchObject({ ok: true, version: '1.0' });
    // y un lado sin versión frente a un protocolo 2.x es una diferencia mayor
    expect(negotiateProtocol('2.0', undefined)).toMatchObject({ ok: false, reason: 'major', remote: '1.0' });
  });

  it('una versión ilegible no se adivina: es incompatible con su propio motivo', () => {
    for (const remote of ['abc', '1', '1.0.0', 'v1.0', '']) {
      const result = negotiateProtocol('1.0', remote);
      expect(result).toMatchObject({ ok: false, reason: 'invalid' });
      expect(result.ok === false && result.message).toMatch(/mayor\.menor/);
    }
    expect(negotiateProtocol('x', '1.0')).toMatchObject({ ok: false, reason: 'invalid' });
  });
});
