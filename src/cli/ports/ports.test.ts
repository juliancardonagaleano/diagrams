import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../registry';
import { asModulesPort, createCliProjectStore } from './adapters';

describe('puertos hexagonales del CLI', () => {
  it('el registro existente cumple el puerto Modules', () => {
    const registry = createDefaultRegistry();
    expect(asModulesPort(registry).ids().length).toBeGreaterThan(0);
  });

  it('FolderProjectStore cumple ProjectStore del CLI', () => {
    const store = createCliProjectStore('/tmp/iark-test-workspace');
    expect(store.kind).toBe('folder');
  });
});
