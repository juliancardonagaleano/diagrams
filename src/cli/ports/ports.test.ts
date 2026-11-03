import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../registry';
import { asModulesPort, createCliProjectStore, createModelProvider, createRepositoryReader } from './adapters';

describe('puertos hexagonales del CLI', () => {
  it('el registro existente cumple el puerto Modules', () => {
    const registry = createDefaultRegistry();
    expect(asModulesPort(registry).ids().length).toBeGreaterThan(0);
  });

  it('FolderProjectStore cumple ProjectStore del CLI', () => {
    const store = createCliProjectStore('/tmp/iark-test-workspace');
    expect(store.kind).toBe('folder');
  });

  it('ModelProvider delega en generateDocument', () => {
    const provider = createModelProvider();
    expect(typeof provider.generate).toBe('function');
  });

  it('RepositoryReader resume un árbol local', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iark-ports-'));
    writeFileSync(join(dir, 'README.md'), '# demo\n');
    const reader = createRepositoryReader();
    const out = await reader.readTree({ path: dir });
    expect(out.text).toMatch(/1 archivo\(s\) clave/);
  });
});
