import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION, EMBED_PROTOCOL_VERSION, manifestSchema } from '@iark/kernel';
import { createDefaultRegistry } from '../src/cli/registry';
import { suiteManifest } from '../src/cli/suiteManifest';
import { MANIFEST_PATH, renderManifest } from '../scripts/generate-manifest';

describe('manifiesto de federación del sitio estático', () => {
  const published = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

  it('está al día con el registro de módulos (regenerar con `npm run manifest`)', () => {
    expect(readFileSync(MANIFEST_PATH, 'utf8')).toBe(renderManifest());
  });

  it('cumple el esquema iark.manifest/1 y lista todos los módulos del CLI', () => {
    const parsed = manifestSchema.safeParse(published);
    expect(parsed.success).toBe(true);
    expect(published.modules.map((m: { id: string }) => m.id)).toEqual(createDefaultRegistry().ids());
  });

  it('publica la versión del protocolo embebido y el contrato de cada módulo (los lee el shell)', () => {
    expect(published.protocol).toBe(EMBED_PROTOCOL_VERSION);
    for (const module of published.modules) expect(module.contractVersion, module.id).toBe(CONTRACT_VERSION);
    expect(published.schema).toBe('iark.manifest/1'); // el literal del esquema no cambia al añadir campos opcionales
  });

  it('cada endpoint apunta a algo que el sitio publica', () => {
    for (const module of published.modules) {
      // relativos al manifiesto: `public/.well-known/iark.json` → raíz del sitio = `..`
      expect(module.endpoints.schema).toBe(`../schema/${module.id}-document.schema.json`);
      expect(existsSync(module.endpoints.schema.replace('../', ''))).toBe(true);
      const embed = new URL(module.endpoints.embed, 'http://sitio/.well-known/iark.json');
      const page = embed.pathname === '/' ? 'index.html' : embed.pathname.slice(1);
      expect(existsSync(page), `${module.id}: ${page}`).toBe(true);
      if (module.id !== 'c4') expect(embed.searchParams.get('module')).toBe(module.id);
      expect(module.endpoints.api).toBeUndefined();
    }
  });

  it('una instancia con servicio HTTP anuncia además su API por módulo', () => {
    const manifest = suiteManifest(createDefaultRegistry(), { version: '1.2.3', api: '/api/' });
    expect(manifest.version).toBe('1.2.3');
    expect(manifest.modules.find((m) => m.id === 'data')!.endpoints!.api).toBe('/api/data');
  });

  it('una instancia con espacio de trabajo anuncia además su API de proyectos (relativa al manifiesto); el sitio estático, no', () => {
    const registry = createDefaultRegistry();
    const withWorkspace = suiteManifest(registry, { version: '1', api: '../api', projects: true });
    expect(withWorkspace.projects).toBe('../api/projects');
    expect(manifestSchema.safeParse(withWorkspace).success).toBe(true);
    expect(suiteManifest(registry, { version: '1', api: '../api/', projects: true }).projects).toBe('../api/projects');
    expect(suiteManifest(registry, { version: '1', api: '../api' }).projects).toBeUndefined();
    expect(suiteManifest(registry, { version: '1', projects: true }).projects).toBeUndefined(); // sin API no hay a dónde apuntar
    expect(published.projects).toBeUndefined();
    expect(published.projectsAuth).toBeUndefined();
  });

  it('con espacio de trabajo anuncia también cómo se autentica (`projectsAuth`): `none` por omisión, `bearer` con tokens; nunca sin proyectos', () => {
    const registry = createDefaultRegistry();
    const open = suiteManifest(registry, { version: '1', api: '../api', projects: true });
    expect(open.projectsAuth).toBe('none');
    const protectedInstance = suiteManifest(registry, { version: '1', api: '../api', projects: true, projectsAuth: 'bearer' });
    expect(protectedInstance).toMatchObject({ projects: '../api/projects', projectsAuth: 'bearer' });
    // el manifiesto de la instancia lo lee un cliente con `manifestSchema`, que ya no descarta ninguno de los dos campos
    expect(manifestSchema.parse(protectedInstance)).toMatchObject({ projects: '../api/projects', projectsAuth: 'bearer' });
    expect(manifestSchema.parse(open).projectsAuth).toBe('none');
    // sin espacio de trabajo (o sin API a la que apuntar) no hay nada que autenticar: no se anuncia
    expect(suiteManifest(registry, { version: '1', api: '../api', projectsAuth: 'bearer' })).not.toHaveProperty('projectsAuth');
    expect(suiteManifest(registry, { version: '1', projects: true, projectsAuth: 'bearer' })).not.toHaveProperty('projectsAuth');
    expect(suiteManifest(registry, { version: '1', api: '../api' })).not.toHaveProperty('projects');
  });
});
