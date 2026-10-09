import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { assertModuleContract, CONTRACT_VERSION, contractVersionOf, DEFAULT_CONTRACT_VERSION, isContractCompatible } from './contract';
import { ModuleRegistry } from './registry';
import type { DomainModule } from './types';

const base = (overrides: Partial<DomainModule<{ n: number }>> = {}): DomainModule<{ n: number }> => ({
  id: 'externo',
  name: 'Módulo externo',
  version: '1.0.0',
  documentVersion: '1.0',
  schema: z.object({ n: z.number() }),
  jsonSchema: () => ({}),
  validate: () => [],
  importers: [],
  exporters: [],
  ...overrides,
});

describe('contractVersion', () => {
  it('el contrato de este anfitrión es la versión 1 (un entero) y es la que se asume si el módulo la omite', () => {
    expect(CONTRACT_VERSION).toBe(1);
    expect(Number.isInteger(CONTRACT_VERSION)).toBe(true);
    expect(DEFAULT_CONTRACT_VERSION).toBe(1);
    expect(contractVersionOf(base())).toBe(1);
    expect(contractVersionOf(base({ contractVersion: 1 }))).toBe(1);
  });

  it('isContractCompatible: omitido vale 1; solo enteros ≥ 1 y no mayores que los del anfitrión', () => {
    expect(isContractCompatible(undefined)).toBe(true);
    expect(isContractCompatible(1)).toBe(true);
    expect(isContractCompatible(2)).toBe(false);
    expect(isContractCompatible(0)).toBe(false);
    expect(isContractCompatible(-1)).toBe(false);
    expect(isContractCompatible(1.5)).toBe(false);
    expect(isContractCompatible(Number.NaN)).toBe(false);
    // con otro anfitrión (p. ej. uno futuro que implemente el contrato 3), los contratos anteriores se aceptan
    expect(isContractCompatible(2, 3)).toBe(true);
    expect(isContractCompatible(3, 3)).toBe(true);
    expect(isContractCompatible(4, 3)).toBe(false);
  });

  it('assertModuleContract acepta el módulo que no declara contrato y el que declara el del anfitrión', () => {
    expect(() => assertModuleContract(base())).not.toThrow();
    expect(() => assertModuleContract(base({ contractVersion: CONTRACT_VERSION }))).not.toThrow();
  });

  it('rechaza un contrato MAYOR que el del anfitrión, diciendo cuál es cada uno', () => {
    expect(() => assertModuleContract(base({ contractVersion: CONTRACT_VERSION + 1 }))).toThrow(/«externo» se escribió para la versión 2 del contrato DomainModule y este DIAgrams implementa la 1/);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rechaza un contractVersion que no es un entero ≥ 1 (%s)', (value) => {
    expect(() => assertModuleContract(base({ contractVersion: value }))).toThrow(/contractVersion inválido/);
  });

  it('ModuleRegistry.register aplica la comprobación: el módulo rechazado no queda registrado', () => {
    const registry = new ModuleRegistry();
    expect(() => registry.register(base({ contractVersion: 2 }))).toThrow(/contrato DomainModule/);
    expect(registry.has('externo')).toBe(false);
    expect(registry.register(base({ contractVersion: 1 })).has('externo')).toBe(true);
  });
});
