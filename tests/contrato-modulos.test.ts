import { describe, expect, it } from 'vitest';
import { assertModuleContract, CONTRACT_VERSION, moduleCapabilities } from '@iark/kernel';
import { createDefaultRegistry } from '../src/cli/registry';

/**
 * Los seis módulos de la suite declaran contra qué versión del contrato `DomainModule` se escribieron (`contractVersion`), de
 * forma explícita —no por omisión—, y todos cumplen lo que el registro exige. Siguen en la versión 1.0 de su documento y no
 * declaran migraciones: el mecanismo se prueba con un módulo de prueba (`documentos-migrados.test.ts`).
 */
const registry = createDefaultRegistry();

describe('contrato de los módulos de la suite', () => {
  it('hay seis módulos, y cada uno declara explícitamente el contractVersion del anfitrión', () => {
    expect(registry.ids()).toEqual(['c4', 'integration', 'data', 'enterprise', 'platform', 'security']);
    for (const module of registry.list()) expect(module.contractVersion, `el módulo «${module.id}» no declara contractVersion`).toBe(CONTRACT_VERSION);
  });

  it('todos cumplen assertModuleContract y siguen en la versión 1.0 del documento, sin migraciones declaradas aún', () => {
    for (const module of registry.list()) {
      expect(() => assertModuleContract(module), module.id).not.toThrow();
      expect(module.documentVersion, module.id).toBe('1.0');
      expect(module.migrations ?? [], module.id).toEqual([]);
    }
  });

  it('las capacidades de cada módulo publican su contractVersion', () => {
    for (const module of registry.list()) expect(moduleCapabilities(module).contractVersion).toBe(CONTRACT_VERSION);
  });

  it('un módulo externo escrito para un contrato más nuevo no se registra', () => {
    const futuro = { ...registry.require('security'), id: 'futuro', contractVersion: CONTRACT_VERSION + 1 };
    expect(() => registry.register(futuro)).toThrow(/versión 2 del contrato DomainModule/);
    expect(registry.has('futuro')).toBe(false);
  });
});
