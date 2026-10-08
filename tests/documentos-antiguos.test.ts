import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeValue, migrateDocument } from '@iark/kernel';
import { createDefaultRegistry } from '../src/cli/registry';

/**
 * Documentos antiguos congelados: `tests/fixtures/documentos/<módulo>-v<versión>.json` es una FOTO de un documento tal como
 * lo guardaba esa versión del formato (hoy, la 1.0 de los seis módulos: una copia de un ejemplo de `examples/` en el momento
 * de tomarla). La foto NO se regenera ni se edita nunca.
 *
 * Qué protege: lo que la gente ya tiene guardado (en archivos, en git, en proyectos y borradores del navegador) tiene que seguir
 * abriéndose con el módulo actual. Si un cambio de esquema rompe una de estas pruebas, la solución NO es editar la foto: es
 * subir `documentVersion` del módulo y añadir su migración (`DomainModule.migrations`), de modo que `analyzeValue` migre la foto
 * antigua y siga saliendo `ok`. Ver `docs/versionado-documentos.md`.
 */
const DIRECTORIO = new URL('./fixtures/documentos/', import.meta.url);
const fotos = readdirSync(DIRECTORIO)
  .filter((nombre) => nombre.endsWith('.json'))
  .sort();
const registry = createDefaultRegistry();

/** `c4-v1.0.json` → `{ modulo: 'c4', version: '1.0' }`. */
function describir(nombre: string): { modulo: string; version: string } {
  const partes = /^([a-z][a-z0-9-]*)-v(\d+\.\d+)\.json$/.exec(nombre);
  if (!partes) throw new Error(`«${nombre}» no se llama <módulo>-v<mayor.menor>.json`);
  return { modulo: partes[1], version: partes[2] };
}

describe('documentos antiguos congelados', () => {
  it('hay una foto v1.0 de cada módulo de la suite, y ninguna de un módulo que no existe', () => {
    const descritas = fotos.map(describir);
    for (const id of registry.ids()) expect(descritas, `falta la foto v1.0 del módulo «${id}»`).toContainEqual({ modulo: id, version: '1.0' });
    for (const { modulo } of descritas) expect(registry.has(modulo), `la foto es de un módulo que no existe: «${modulo}»`).toBe(true);
  });

  for (const nombre of fotos) {
    const { modulo, version } = describir(nombre);

    it(`${nombre}: la foto declara la versión de su nombre y se analiza ok con el módulo actual`, () => {
      const documento = JSON.parse(readFileSync(new URL(nombre, DIRECTORIO), 'utf8')) as { version?: unknown };
      expect(documento.version, 'la foto debe conservar la versión con la que se tomó').toBe(version);

      const module = registry.require(modulo);
      const analisis = analyzeValue(module, documento);
      expect(analisis.status, analisis.status === 'schema' ? analisis.issues.map((i) => `${i.path}: ${i.message}`).join('; ') : '').toBe('ok');
      if (analisis.status !== 'ok') return;
      expect(analisis.issues.filter((i) => i.severity === 'error')).toEqual([]);

      // Si el módulo ya cambió de versión, la foto tiene que haberse migrado (y decirlo); si no, no hay nada que migrar.
      if (module.documentVersion === version) {
        expect(analisis.migrated).toBeUndefined();
        expect(migrateDocument(module, documento).status).toBe('current');
      } else {
        expect(analisis.migrated, `el módulo «${modulo}» está en la ${module.documentVersion}: debe migrar la foto ${version}`).toEqual({ from: version, to: module.documentVersion });
      }
    });
  }
});
