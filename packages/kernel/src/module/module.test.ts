import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildManifest, manifestSchema } from './manifest';
import { EMBED_PROTOCOL_VERSION } from './protocol';
import { importFiles, joinSourceFiles, multiFileImporter, sourceFilesOf } from './operations';
import { ModuleRegistry, UnknownModuleError } from './registry';
import type { DomainModule, ImportContext, Importer } from './types';
import { formatUrn, parseUrn } from './urn';

const importer = (id: string, extensions: string[], detect?: (t: string) => boolean): Importer<{ n: number }> => ({
  id,
  label: id,
  extensions,
  detect,
  import: () => ({ document: { n: 1 }, warnings: [] }),
});

function fakeModule(id: string, importers: Importer<{ n: number }>[] = []): DomainModule<{ n: number }> {
  return {
    id,
    name: `Módulo ${id}`,
    version: '1.2.3',
    documentVersion: '1.0',
    schema: z.object({ n: z.number() }),
    jsonSchema: () => ({}),
    validate: () => [],
    importers,
    exporters: [{ id: 'txt', label: 'Texto', extension: '.txt', mime: 'text/plain', export: (d) => String(d.n) }],
  };
}

describe('urn', () => {
  it('formatea y parsea referencias entre módulos', () => {
    const urn = formatUrn('data', 'clientes:v2');
    expect(urn).toBe('urn:iark:data:clientes:v2');
    expect(parseUrn(urn)).toEqual({ module: 'data', id: 'clientes:v2' });
  });

  it('rechaza módulos e ids inválidos y no parsea lo que no es una URN de la suite', () => {
    expect(() => formatUrn('Datos', 'x')).toThrow(/inválido/);
    expect(() => formatUrn('data', 'con espacio')).toThrow(/espacios/);
    expect(parseUrn('urn:otro:data:x')).toBeNull();
    expect(parseUrn('urn:iark:data:')).toBeNull();
  });
});

describe('ModuleRegistry', () => {
  it('registra, consulta y no admite duplicados ni ids inválidos', () => {
    const registry = new ModuleRegistry().register(fakeModule('c4')).register(fakeModule('data'));
    expect(registry.ids()).toEqual(['c4', 'data']);
    expect(registry.has('data')).toBe(true);
    expect(() => registry.register(fakeModule('c4'))).toThrow(/ya está registrado/);
    expect(() => registry.register(fakeModule('Mal Id'))).toThrow(/inválido/);
  });

  it('require falla listando los módulos disponibles', () => {
    const registry = new ModuleRegistry().register(fakeModule('c4'));
    expect(() => registry.require('datos')).toThrow(UnknownModuleError);
    expect(() => registry.require('datos')).toThrow(/Módulos disponibles: c4/);
  });

  it('detectImporter: la extensión manda y, sin ella, se detecta por el contenido', () => {
    const registry = new ModuleRegistry().register(
      fakeModule('c4', [importer('xml', ['.xml'], (t) => t.startsWith('<')), importer('mmd', ['.mmd'], (t) => t.startsWith('graph')), importer('dsl', ['.dsl'], (t) => t.includes('workspace'))]),
    );
    expect(registry.detectImporter('c4', 'a/B.MMD', 'lo que sea')?.id).toBe('mmd');
    expect(registry.detectImporter('c4', undefined, '<x/>')?.id).toBe('xml');
    expect(registry.detectImporter('c4', 'sin-extension', 'workspace {}')?.id).toBe('dsl');
    expect(registry.detectImporter('c4', 'datos.json', '{}')).toBeUndefined();
  });
});

describe('manifiesto de federación', () => {
  it('describe los módulos registrados y valida con su esquema', () => {
    const registry = new ModuleRegistry().register(fakeModule('c4', [importer('xml', ['.xml'])]));
    const manifest = buildManifest(registry, { name: 'IArk - DIAgrams', version: '0.1.0', endpoints: { c4: { embed: '/embed/c4/' } } });
    expect(manifest).toMatchObject({
      schema: 'iark.manifest/1',
      modules: [{ id: 'c4', version: '1.2.3', importFormats: ['xml'], exportFormats: ['txt'], endpoints: { embed: '/embed/c4/' } }],
    });
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifestSchema.safeParse({ ...manifest, schema: 'otro' }).success).toBe(false);
  });

  it('lleva la versión del protocolo embebido (`protocol`) y el contrato de cada módulo (`contractVersion`)', () => {
    const registry = new ModuleRegistry().register(fakeModule('c4')).register({ ...fakeModule('data'), contractVersion: 1 });
    const manifest = buildManifest(registry, { name: 'IArk - DIAgrams', version: '0.1.0' });
    expect(manifest.protocol).toBe(EMBED_PROTOCOL_VERSION);
    // el módulo que no declara contrato se publica como 1, el que sí lo declara, con el suyo
    expect(manifest.modules.map((m) => m.contractVersion)).toEqual([1, 1]);
    expect(manifest.schema).toBe('iark.manifest/1'); // el literal no cambia
    expect(manifestSchema.parse(manifest)).toMatchObject({ protocol: '1.0', modules: [{ contractVersion: 1 }, { contractVersion: 1 }] });
  });

  it('`protocol` y `contractVersion` son opcionales al leer (una instancia anterior no los publica) y solo admiten lo que son', () => {
    const base = buildManifest(new ModuleRegistry().register(fakeModule('c4')), { name: 'IArk - DIAgrams', version: '0.1.0' });
    const { protocol: _protocol, ...withoutProtocol } = base;
    const old = { ...withoutProtocol, modules: base.modules.map(({ contractVersion: _contract, ...rest }) => rest) };
    const parsed = manifestSchema.safeParse(old);
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty('protocol');
    expect(parsed.data?.modules[0]).not.toHaveProperty('contractVersion');
    expect(manifestSchema.safeParse({ ...base, protocol: 1 }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base, modules: [{ ...base.modules[0], contractVersion: '1' }] }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base, modules: [{ ...base.modules[0], contractVersion: 1.5 }] }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base, modules: [{ ...base.modules[0], contractVersion: 0 }] }).success).toBe(false);
  });

  it('`projects` y `projectsAuth` son opcionales: se conservan al interpretar el manifiesto y solo admiten los valores conocidos', () => {
    const base = buildManifest(new ModuleRegistry().register(fakeModule('c4')), { name: 'IArk - DIAgrams', version: '0.1.0' });
    // sin ellos (un sitio estático, o una instancia sin espacio de trabajo) el manifiesto sigue siendo válido
    const plain = manifestSchema.safeParse(base);
    expect(plain.success).toBe(true);
    expect(plain.data).not.toHaveProperty('projects');
    expect(plain.data).not.toHaveProperty('projectsAuth');
    // con ellos, el esquema no los descarta (un cliente que lee el manifiesto con `manifestSchema` los necesita)
    for (const projectsAuth of ['bearer', 'none'] as const) {
      const parsed = manifestSchema.safeParse({ ...base, projects: '../api/projects', projectsAuth });
      expect(parsed.success).toBe(true);
      expect(parsed.data).toMatchObject({ projects: '../api/projects', projectsAuth });
    }
    expect(manifestSchema.safeParse({ ...base, projects: '../api/projects' }).data?.projectsAuth).toBeUndefined();
    expect(manifestSchema.safeParse({ ...base, projectsAuth: 'oauth' }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base, projects: 7 }).success).toBe(false);
  });
});

describe('importar varios archivos', () => {
  // Un importador que se reparte en `.part` y deja a la vista lo que recibe: el texto concatenado y el detalle por archivo.
  const received: Array<{ text: string; context: ImportContext }> = [];
  const parts: Importer<{ n: number }> = {
    id: 'partes',
    label: 'Partes',
    extensions: ['.part', '.json'],
    multiFile: { extensions: ['.part'] },
    import: (text, context) => (received.push({ text, context }), { document: { n: text.length }, warnings: [] }),
  };
  const single = importer('solo', ['.uno']);
  const mod = fakeModule('multi', [single, parts]);

  it('joinSourceFiles ordena por nombre, concatena con un salto de línea y deja el detalle en extra.files', () => {
    const joined = joinSourceFiles([
      { name: 'b.part', text: 'B' },
      { name: 'C.part', text: 'C' },
      { name: 'a.part', text: 'A' },
    ]);
    expect(joined.text).toBe('A\nB\nC');
    expect(joined.extra.files.map((f) => f.name)).toEqual(['a.part', 'b.part', 'C.part']);
    // Con nombres que solo difieren en las mayúsculas, el orden sigue siendo estable.
    const same = [{ name: 'a.part', text: '1' }, { name: 'A.part', text: '2' }];
    expect(joinSourceFiles(same).text).toBe(joinSourceFiles([...same].reverse()).text);
  });

  it('sourceFilesOf solo da los archivos si vienen bien formados', () => {
    expect(sourceFilesOf(undefined)).toBeUndefined();
    expect(sourceFilesOf({ files: [] })).toBeUndefined();
    expect(sourceFilesOf({ files: [{ name: 'a' }] })).toBeUndefined();
    expect(sourceFilesOf({ files: 'a' })).toBeUndefined();
    expect(sourceFilesOf({ files: [{ name: 'a.part', text: 'A' }] })).toEqual([{ name: 'a.part', text: 'A' }]);
  });

  it('multiFileImporter elige el importador por la extensión de todos los archivos', () => {
    expect(multiFileImporter(mod, ['a.part', 'B.PART'])?.id).toBe('partes');
    expect(multiFileImporter(mod, ['a.part', 'b.uno'])).toBeUndefined();
    expect(multiFileImporter(mod, ['a.json'])).toBeUndefined();
    expect(multiFileImporter(mod, ['a.part'], 'partes')?.id).toBe('partes');
    expect(multiFileImporter(mod, ['a.part'], 'solo')).toBeUndefined();
  });

  it('importFiles pasa al importador el texto concatenado y el detalle por archivo', async () => {
    received.length = 0;
    const result = await importFiles(mod, [{ name: 'b.part', text: 'BB' }, { name: 'a.part', text: 'AA' }], undefined, { file: '/proyecto/infra' });
    expect(result).toEqual({ document: { n: 5 }, warnings: [], importer: 'partes' });
    expect(received).toHaveLength(1);
    expect(received[0].text).toBe('AA\nBB');
    expect(received[0].context.file).toBe('/proyecto/infra');
    expect(received[0].context.extra?.files).toEqual([{ name: 'a.part', text: 'AA' }, { name: 'b.part', text: 'BB' }]);
  });

  it('importFiles explica por qué no puede: mezcla de formatos, formato que no se reparte, importador desconocido o nada que importar', async () => {
    const files = (...names: string[]) => names.map((name) => ({ name, text: 'x' }));
    await expect(importFiles(mod, files('a.part', 'b.uno'))).rejects.toThrow(/no son todos del mismo formato: solo se leen juntos los \.part/);
    await expect(importFiles(mod, files('a.uno', 'b.uno'), 'solo')).rejects.toThrow(/«solo» no se puede leer repartido en varios archivos/);
    await expect(importFiles(mod, files('a.part'), 'nada')).rejects.toThrow(/no importa «nada»/);
    await expect(importFiles(fakeModule('sin', [single]), files('a.uno', 'b.uno'))).rejects.toThrow(/no importa varios archivos a la vez/);
    await expect(importFiles(mod, [])).rejects.toThrow(/No hay ningún archivo/);
  });
});
