import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../../cli/registry';
import { suiteManifest } from '../../cli/suiteManifest';
import { expectedEmbedPath, manifestEmbedForModule } from './manifestRoutes';
import { listModuleRemotes, moduleRemoteId } from './registry';
import { builtInFederationManifest } from './suiteFederation';

describe('federación mfe-*', () => {
  it('registra seis remotos de especialidad', () => {
    expect(listModuleRemotes().map((r) => r.remoteId)).toEqual([
      'mfe-c4', 'mfe-integration', 'mfe-data', 'mfe-enterprise', 'mfe-platform', 'mfe-security',
    ]);
    expect(moduleRemoteId('security')).toBe('mfe-security');
  });

  it('alinea embed del manifiesto con rutas del shell', () => {
    const manifest = suiteManifest(createDefaultRegistry(), { version: 'test' });
    for (const module of manifest.modules) {
      expect(module.endpoints?.embed).toBe(manifestEmbedForModule(module.id));
      if (module.id === 'c4') expect(expectedEmbedPath(module.id)).toBe('/');
      else expect(expectedEmbedPath(module.id)).toBe(`/modules/${module.id}`);
    }
  });

  it('incluye mfe-trace en la composición incorporada', () => {
    expect(builtInFederationManifest().some((e) => e.remoteId === 'mfe-trace' && e.mountPath === '/trace')).toBe(true);
  });
});
