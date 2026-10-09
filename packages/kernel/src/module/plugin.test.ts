import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CONTRACT_VERSION } from './contract';
import { ModuleError } from './errors';
import { assertModuleShape, defineModule, MODULE_ID_PATTERN, resolveModuleExport } from './plugin';
import { ModuleRegistry } from './registry';
import type { DomainModule } from './types';

const schema = z.object({ n: z.number() });

const valid = (overrides: Record<string, unknown> = {}): DomainModule<{ n: number }> =>
  ({
    id: 'externo',
    name: 'Módulo externo',
    version: '1.0.0',
    documentVersion: '1.0',
    schema,
    jsonSchema: () => ({ type: 'object' }),
    validate: () => [],
    importers: [],
    exporters: [],
    ...overrides,
  }) as DomainModule<{ n: number }>;

/** El mensaje con el que falla `assertModuleShape` (o `undefined` si no falla). */
function failure(module: unknown, origin = '@acme/externo'): string | undefined {
  try {
    assertModuleShape(module, origin);
  } catch (error) {
    return (error as Error).message;
  }
  return undefined;
}

describe('defineModule', () => {
  it('es la identidad: devuelve el mismo objeto y fija el tipo del documento', () => {
    const module = valid();
    const defined = defineModule(module);
    expect(defined).toBe(module);
    // El tipo del documento se infiere del esquema: si dejara de inferirse, esta línea no compilaría (typecheck).
    const parsed: { n: number } = defined.schema.parse({ n: 1 });
    expect(parsed.n).toBe(1);
  });
});

describe('resolveModuleExport', () => {
  it('un módulo (valor) se devuelve tal cual', async () => {
    const module = valid();
    expect(await resolveModuleExport(module, '@acme/externo')).toBe(module);
  });

  it('una fábrica síncrona o asíncrona se ejecuta', async () => {
    const module = valid();
    expect(await resolveModuleExport(() => module, 'a')).toBe(module);
    expect(await resolveModuleExport(async () => module, 'a')).toBe(module);
  });

  it('si la fábrica falla, el mensaje nombra el plugin y la causa', async () => {
    await expect(resolveModuleExport(() => { throw new Error('no hay red'); }, '@acme/externo')).rejects.toThrow(/«@acme\/externo» falló al construirlo: no hay red/);
    await expect(resolveModuleExport(async () => { throw new Error('tarde'); }, './x.mjs')).rejects.toThrow(/«\.\/x\.mjs» falló al construirlo: tarde/);
  });
});

describe('assertModuleShape', () => {
  it('acepta un módulo completo y uno con importadores, exportadores y comandos bien formados', () => {
    expect(failure(valid())).toBeUndefined();
    const completo = valid({
      importers: [{ id: 'csv', label: 'CSV', extensions: ['.csv'], import: () => ({ document: { n: 1 }, warnings: [] }) }],
      exporters: [{ id: 'md', label: 'Markdown', extension: '.md', mime: 'text/markdown', export: () => '' }],
      cliCommands: [{ name: 'resumen', description: 'Resume', run: () => '' }],
      traceViews: [{ prefix: 'impacto', label: 'Impacto' }],
      entities: () => [],
      views: () => [],
    });
    expect(failure(completo)).toBeUndefined();
  });

  it.each([
    ['undefined', undefined, /no es un módulo \(es undefined\)/],
    ['un número', 3, /no es un módulo \(es number\)/],
    ['una lista', [], /no es un módulo \(es una lista\)/],
  ])('lo que no es un objeto (%s) se rechaza explicando qué se esperaba', (_nombre, value, pattern) => {
    const message = failure(value)!;
    expect(message).toMatch(pattern);
    expect(message).toContain('«@acme/externo»');
    expect(message).toContain('export default defineModule');
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ['un id con mayúsculas', { id: 'Riesgos' }, /«id» debe ser un identificador en minúsculas/],
    ['un id que empieza por dígito', { id: '1riesgos' }, /«id» debe ser/],
    ['sin id', { id: undefined }, /«id» debe ser/],
    ['sin nombre', { name: '' }, /falta «name»/],
    ['sin versión', { version: undefined }, /falta «version»/],
    ['una documentVersion que no es mayor.menor', { documentVersion: '1' }, /«documentVersion» debe ser «mayor.menor»/],
    ['un esquema que no es de zod', { schema: {} }, /«schema» debe ser un esquema de zod/],
    ['sin jsonSchema', { jsonSchema: undefined }, /falta «jsonSchema»/],
    ['sin validate', { validate: 'no' }, /falta «validate»/],
    ['importers que no es una lista', { importers: {} }, /«importers» debe ser una lista/],
    ['exporters ausente', { exporters: undefined }, /«exporters» debe ser una lista/],
    ['un importador sin import', { importers: [{ id: 'csv', label: 'CSV', extensions: ['.csv'] }] }, /importers «csv» no tiene la función «import»/],
    ['una extensión sin punto', { importers: [{ id: 'csv', label: 'CSV', extensions: ['csv'], import: () => ({}) }] }, /importers «csv»: «extensions» debe ser una lista de extensiones en minúsculas con punto/],
    ['una extensión en mayúsculas', { importers: [{ id: 'csv', label: 'CSV', extensions: ['.CSV'], import: () => ({}) }] }, /«extensions» debe ser/],
    ['un importador sin id', { importers: [{ label: 'CSV', extensions: [], import: () => ({}) }] }, /importers\[0\] no tiene «id»/],
    ['dos importadores con el mismo id', { importers: [1, 2].map(() => ({ id: 'csv', label: 'CSV', extensions: [], import: () => ({}) })) }, /importers repite el id «csv»/],
    ['un exportador sin mime', { exporters: [{ id: 'md', label: 'MD', extension: '.md', export: () => '' }] }, /exporters «md» no tiene «mime»/],
    ['un exportador sin extensión válida', { exporters: [{ id: 'md', label: 'MD', extension: 'md', mime: 'text/plain', export: () => '' }] }, /exporters «md»: «extension» debe ser/],
    ['dos exportadores con el mismo id', { exporters: [1, 2].map(() => ({ id: 'md', label: 'MD', extension: '.md', mime: 'text/plain', export: () => '' })) }, /exporters repite el id «md»/],
    ['un comando con nombre en mayúsculas', { cliCommands: [{ name: 'Resumen', description: 'x', run: () => '' }] }, /cliCommands «Resumen»: el nombre del comando/],
    ['un comando sin run', { cliCommands: [{ name: 'resumen', description: 'x' }] }, /cliCommands «resumen» no tiene la función «run»/],
    ['entities que no es una función', { entities: [] }, /«entities» debe ser una función/],
    ['una especificación de IA incompleta', { ai: { system: () => '' } }, /«ai» debe traer/],
  ])('rechaza %s y lo nombra junto al plugin', (_nombre, overrides, pattern) => {
    const message = failure(valid(overrides))!;
    expect(message, 'debería haber fallado').toBeDefined();
    expect(message).toContain('El módulo de terceros «@acme/externo» no cumple el contrato DomainModule');
    expect(message).toMatch(pattern);
  });

  it('lista todo lo que falla de una vez, no solo lo primero', () => {
    const message = failure(valid({ id: 'MAL', name: '', validate: undefined }))!;
    expect(message).toMatch(/«id» debe ser/);
    expect(message).toMatch(/falta «name»/);
    expect(message).toMatch(/falta «validate»/);
    expect(message.split('\n').filter((line) => line.startsWith('  - '))).toHaveLength(3);
  });

  it('un contractVersion mayor que el del anfitrión se rechaza con el plugin en el mensaje', () => {
    const message = failure(valid({ contractVersion: CONTRACT_VERSION + 1 }))!;
    expect(message).toContain('«@acme/externo»');
    expect(message).toMatch(/versión 2 del contrato DomainModule/);
  });

  it('un contractVersion inválido o una cadena de migraciones rota también', () => {
    expect(failure(valid({ contractVersion: 0 }))).toMatch(/contractVersion inválido/);
    expect(failure(valid({ documentVersion: '2.0', migrations: [{ from: '1.0', to: '1.5', migrate: (d: unknown) => d }] }))).toMatch(/migraciones de documento inválidas/);
  });

  it('un jsonSchema() que lanza o no devuelve un objeto se rechaza al cargar, no más tarde', () => {
    expect(failure(valid({ jsonSchema: () => { throw new Error('z.toJSONSchema no existe'); } }))).toMatch(/jsonSchema\(\) falló: z\.toJSONSchema no existe/);
    expect(failure(valid({ jsonSchema: () => undefined }))).toMatch(/jsonSchema\(\) falló: devolvió undefined en vez de un objeto/);
  });

  it('el id debe cumplir la misma forma que exige el registro', () => {
    expect(MODULE_ID_PATTERN.test('risk')).toBe(true);
    expect(MODULE_ID_PATTERN.test('mi-modulo2')).toBe(true);
    for (const id of ['', 'Risk', '2risk', '-risk', 'ri sk', 'risk_x']) expect(MODULE_ID_PATTERN.test(id), id).toBe(false);
  });
});

describe('ModuleRegistry: origen de los módulos', () => {
  it('un módulo registrado con origen lo conserva; los incorporados no lo llevan', () => {
    const registry = new ModuleRegistry().register(valid({ id: 'propio' })).register(valid({ id: 'ajeno' }), { origin: '@acme/ajeno' });
    expect(registry.originOf('propio')).toBeUndefined();
    expect(registry.originOf('ajeno')).toBe('@acme/ajeno');
    expect(registry.originOf('no-existe')).toBeUndefined();
  });

  it('un id repetido sigue fallando aunque el segundo traiga origen (un plugin no sustituye a un módulo incorporado)', () => {
    const registry = new ModuleRegistry().register(valid({ id: 'propio' }));
    expect(() => registry.register(valid({ id: 'propio' }), { origin: '@acme/ajeno' })).toThrow(/ya está registrado/);
    expect(registry.originOf('propio')).toBeUndefined();
  });
});

describe('ModuleError entre copias del kernel', () => {
  it('reconoce por la marca a un ModuleError de otra copia, y no confunde subclases ni errores comunes', () => {
    class Subclase extends ModuleError {}
    class OtraSubclase extends ModuleError {}
    // «Otra copia» del kernel: una clase distinta que lleva la misma marca global.
    class OtraCopia extends Error {
      constructor(message: string) {
        super(message);
        Object.defineProperty(this, Symbol.for('iark.ModuleError'), { value: true });
      }
    }
    const foreign = new OtraCopia('de un plugin');
    expect(foreign instanceof ModuleError).toBe(true);
    expect(new ModuleError('x') instanceof ModuleError).toBe(true);
    expect(new Subclase('x') instanceof ModuleError).toBe(true);
    expect(new Error('común') instanceof ModuleError).toBe(false);
    expect({ [Symbol.for('iark.ModuleError')]: true } instanceof ModuleError).toBe(false); // no es un Error
    // La marca no hace que una subclase reconozca a cualquier error: el `instanceof` de las subclases sigue siendo el normal.
    expect(foreign instanceof Subclase).toBe(false);
    expect(new OtraSubclase('x') instanceof Subclase).toBe(false);
    expect(new Subclase('x') instanceof Subclase).toBe(true);
  });
});
