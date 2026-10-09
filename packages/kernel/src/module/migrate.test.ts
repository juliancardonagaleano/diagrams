import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { analyzeText, analyzeValue, migrateDocument, moduleCapabilities, parseModuleDocument } from './operations';
import { validateMigrationChain } from './migrate';
import { ModuleRegistry } from './registry';
import type { DocumentMigration, DomainModule } from './types';

/**
 * Un módulo de prueba cuyo formato ha cambiado dos veces (los seis módulos reales siguen en 1.0, sin migraciones):
 *  - 1.0: `{ name, items: [{ id, label }] }`
 *  - 1.1: el nombre pasa a `workspace.name`
 *  - 2.0: `label` pasa a `title`
 */
interface Doc {
  version: '2.0';
  workspace: { name: string };
  items: Array<{ id: string; title: string }>;
}

const schema = z.object({
  version: z.literal('2.0').default('2.0'),
  workspace: z.object({ name: z.string() }),
  items: z.array(z.object({ id: z.string(), title: z.string() })).default([]),
});

/** Este paso MUTA su argumento a propósito: la entrada original no debe notarlo (los pasos reciben una copia). */
const toOnePointOne: DocumentMigration = {
  from: '1.0',
  to: '1.1',
  description: 'El nombre pasa a workspace.name',
  migrate(document) {
    const old = document as { name: string };
    const next = { ...old, workspace: { name: old.name } } as Record<string, unknown>;
    delete next.name;
    old.name = 'MUTADO';
    return next;
  },
};

const toTwo: DocumentMigration = {
  from: '1.1',
  to: '2.0',
  description: 'label pasa a title',
  migrate(document) {
    const old = document as { items?: Array<{ id: string; label: string }> };
    return { ...old, items: (old.items ?? []).map(({ id, label }) => ({ id, title: label })) };
  },
};

function testModule(overrides: Partial<DomainModule<Doc>> = {}): DomainModule<Doc> {
  return {
    id: 'prueba',
    name: 'Módulo de prueba',
    version: '1.0.0',
    documentVersion: '2.0',
    migrations: [toOnePointOne, toTwo],
    schema: schema as unknown as DomainModule<Doc>['schema'],
    jsonSchema: () => ({}),
    validate: (doc) => (doc.items.length === 0 ? [{ severity: 'warning', message: 'Sin elementos' }] : []),
    importers: [],
    exporters: [],
    ...overrides,
  };
}

const v10 = { version: '1.0', name: 'Pedidos', items: [{ id: 'a', label: 'Alta' }] };
const v11 = { version: '1.1', workspace: { name: 'Pedidos' }, items: [{ id: 'a', label: 'Alta' }] };

const deepFreeze = <T,>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
};

describe('migrateDocument: cadena 1.0 → 1.1 → 2.0', () => {
  const module = testModule();

  it('aplica los pasos en orden y deja el documento en la versión actual', () => {
    const result = migrateDocument(module, v10);
    expect(result.status).toBe('migrated');
    if (result.status !== 'migrated') return;
    expect(result.from).toBe('1.0');
    expect(result.to).toBe('2.0');
    expect(result.steps.map((s) => `${s.from}→${s.to}`)).toEqual(['1.0→1.1', '1.1→2.0']);
    expect(result.steps[0].description).toBe('El nombre pasa a workspace.name');
    expect(result.document).toEqual({ version: '2.0', workspace: { name: 'Pedidos' }, items: [{ id: 'a', title: 'Alta' }] });
  });

  it('desde una versión intermedia solo aplica los pasos que faltan', () => {
    const result = migrateDocument(module, v11);
    expect(result.status === 'migrated' && result.steps.map((s) => s.from)).toEqual(['1.1']);
    expect(result.status === 'migrated' && result.document).toMatchObject({ version: '2.0', items: [{ id: 'a', title: 'Alta' }] });
  });

  it('es pura: no muta la entrada (ni siquiera congelada) aunque un paso mute la copia que recibe', () => {
    const input = deepFreeze(structuredClone(v10));
    const before = JSON.stringify(input);
    const result = migrateDocument(module, input);
    expect(result.status).toBe('migrated');
    expect(JSON.stringify(input)).toBe(before);
    expect(input.name).toBe('Pedidos'); // el paso puso «MUTADO» en SU copia, no en la entrada
    // y el resultado es un objeto nuevo, no la entrada
    expect(result.status === 'migrated' && result.document).not.toBe(input);
    // llamarla dos veces da lo mismo
    expect(migrateDocument(module, input)).toEqual(result);
  });

  it('la versión actual no cambia nada y devuelve el mismo objeto', () => {
    const current = { version: '2.0', workspace: { name: 'X' }, items: [] };
    const result = migrateDocument(module, current);
    expect(result.status).toBe('current');
    expect(result.status === 'current' && result.document).toBe(current);
  });

  it('sin `version` se asume la actual: no migra y deja que el esquema complete el valor por omisión', () => {
    const bare = { workspace: { name: 'X' } };
    const result = migrateDocument(module, bare);
    expect(result.status).toBe('current');
    const analysis = analyzeValue(module, bare);
    expect(analysis.status).toBe('ok');
    expect(analysis.status === 'ok' && analysis.migrated).toBeUndefined();
    expect(analysis.status === 'ok' && (analysis.document as Doc).version).toBe('2.0');
  });

  it('lo que no es un objeto no se migra: lo juzga el esquema', () => {
    for (const value of [null, 3, 'texto', [1, 2]]) expect(migrateDocument(module, value).status).toBe('current');
    expect(analyzeValue(module, [1]).status).toBe('schema');
  });

  it('una versión MÁS NUEVA que la del módulo se rechaza con un mensaje claro', () => {
    const result = migrateDocument(module, { version: '2.1', workspace: { name: 'X' } });
    expect(result.status).toBe('unsupported');
    expect(result.status === 'unsupported' && result.message).toMatch(/versión más nueva \(2\.1\) del formato.*hasta la 2\.0/);
    expect(result.status === 'unsupported' && result.message).toMatch(/Actualiza DIAgrams/);
    const analysis = analyzeValue(module, { version: '3.0' });
    expect(analysis).toMatchObject({ status: 'schema', issues: [{ path: 'version' }] });
  });

  it('una versión más antigua SIN cadena para ella se rechaza diciendo desde dónde sí hay migraciones', () => {
    const result = migrateDocument(module, { version: '0.9', name: 'X' });
    expect(result.status).toBe('unsupported');
    const message = result.status === 'unsupported' ? result.message : '';
    expect(message).toMatch(/versión 0\.9/);
    expect(message).toMatch(/no está soportada/);
    expect(message).toMatch(/Hay migraciones desde: 1\.0, 1\.1/);
  });

  it('un módulo sin migraciones rechaza lo anterior diciéndolo', () => {
    const plain = testModule({ migrations: undefined, documentVersion: '2.0' });
    const result = migrateDocument(plain, { version: '1.0' });
    expect(result.status === 'unsupported' && result.message).toMatch(/no declara migraciones/);
  });

  it('una `version` que no es «mayor.menor» se rechaza con su propio mensaje', () => {
    for (const version of ['abc', '1', '1.0.0', 2, null, ['1.0']]) {
      const result = migrateDocument(module, { version });
      expect(result.status).toBe('unsupported');
      expect(result.status === 'unsupported' && result.message).toMatch(/mayor\.menor/);
    }
  });

  it('un paso que lanza un error se informa con las versiones implicadas', () => {
    const broken = testModule({ migrations: [{ ...toOnePointOne, migrate: () => { throw new Error('falta el campo name'); } }, toTwo] });
    const result = migrateDocument(broken, v10);
    expect(result.status === 'unsupported' && result.message).toMatch(/migrar el documento de la versión 1\.0 a la 1\.1.*falta el campo name/);
  });

  it('las versiones se comparan como números, no como texto (1.10 es posterior a 1.9)', () => {
    const numeric = testModule({
      documentVersion: '1.10',
      migrations: [{ from: '1.9', to: '1.10', migrate: (d) => d }],
      schema: z.object({ version: z.literal('1.10').default('1.10') }) as unknown as DomainModule<Doc>['schema'],
    });
    expect(migrateDocument(numeric, { version: '1.9' }).status).toBe('migrated');
    expect(migrateDocument(numeric, { version: '1.11' }).status).toBe('unsupported');
    expect(migrateDocument(numeric, { version: '1.10' }).status).toBe('current');
  });
});

describe('analyzeValue / analyzeText: migran antes de validar', () => {
  const module = testModule();

  it('un documento 1.0 que el esquema 2.0 rechazaría llega válido, con `migrated` y una nota informativa al principio', () => {
    // El esquema actual no acepta el documento tal cual: es lo que pasaba antes de las migraciones.
    expect(module.schema.safeParse(v10).success).toBe(false);
    const analysis = analyzeValue(module, v10);
    expect(analysis.status).toBe('ok');
    if (analysis.status !== 'ok') return;
    expect(analysis.migrated).toEqual({ from: '1.0', to: '2.0' });
    expect(analysis.document).toEqual({ version: '2.0', workspace: { name: 'Pedidos' }, items: [{ id: 'a', title: 'Alta' }] });
    expect(analysis.issues[0]).toEqual({ severity: 'info', message: 'Documento migrado de la versión 1.0 a 2.0; al guardarlo se escribe en la nueva.' });
  });

  it('las reglas del dominio ven el documento ya migrado y sus problemas siguen a la nota', () => {
    const analysis = analyzeValue(module, { version: '1.0', name: 'Vacío' });
    expect(analysis.status === 'ok' && analysis.issues.map((i) => i.severity)).toEqual(['info', 'warning']);
  });

  it('un documento de la versión actual no lleva `migrated` ni nota', () => {
    const analysis = analyzeValue(module, { version: '2.0', workspace: { name: 'X' }, items: [{ id: 'a', title: 'A' }] });
    expect(analysis.status === 'ok' && 'migrated' in analysis).toBe(false);
    expect(analysis.status === 'ok' && analysis.issues).toEqual([]);
  });

  it('también por texto (lo que escribe la persona en el editor, con o sin vallas de código)', () => {
    expect(analyzeText(module, JSON.stringify(v10)).status).toBe('ok');
    const fenced = analyzeText(module, '```json\n' + JSON.stringify(v10) + '\n```');
    expect(fenced.status === 'ok' && fenced.migrated).toEqual({ from: '1.0', to: '2.0' });
  });

  it('si el documento migrado sigue sin cumplir el esquema, se informan los problemas de esquema', () => {
    const analysis = analyzeValue(module, { version: '1.0', name: 'X', items: [{ id: 'a' }] });
    expect(analysis.status).toBe('schema');
    expect(analysis.status === 'schema' && analysis.issues.some((i) => i.path.startsWith('items'))).toBe(true);
  });

  it('parseModuleDocument: migra y valida con el esquema, sin las reglas del dominio', () => {
    const parsed = parseModuleDocument(module, v10);
    expect(parsed).toMatchObject({ ok: true, migrated: { from: '1.0', to: '2.0' } });
    expect(parseModuleDocument(module, { version: '9.9' })).toMatchObject({ ok: false, issues: [{ path: 'version' }] });
  });

  it('si `validate` lanza un error, lo informa y conserva la nota de migración', () => {
    const fragile = testModule({ validate: () => { throw new Error('boom'); } });
    const analysis = analyzeValue(fragile, v10);
    expect(analysis.status === 'ok' && analysis.issues.map((i) => i.severity)).toEqual(['info', 'error']);
  });
});

describe('validateMigrationChain y registro de módulos', () => {
  const step = (from: string, to: string): DocumentMigration => ({ from, to, migrate: (d) => d });

  it('una cadena sin huecos que termina en la versión actual es válida (y la vacía también)', () => {
    expect(validateMigrationChain('2.0', [step('1.0', '1.1'), step('1.1', '2.0')])).toEqual([]);
    expect(validateMigrationChain('2.0', [step('1.1', '2.0'), step('1.0', '1.1')])).toEqual([]); // el orden de declaración da igual
    expect(validateMigrationChain('1.0', [])).toEqual([]);
    expect(validateMigrationChain('2.0', [step('1.0', '2.0')])).toEqual([]); // un salto de mayor sin pasos intermedios
  });

  it('detecta un hueco', () => {
    const problems = validateMigrationChain('2.0', [step('1.0', '1.1'), step('1.2', '2.0')]);
    expect(problems.join(' ')).toMatch(/huecos/);
  });

  it('detecta que no termina en la versión actual', () => {
    expect(validateMigrationChain('2.0', [step('1.0', '1.1')]).join(' ')).toMatch(/termina en la versión 1\.1.*2\.0/);
    expect(validateMigrationChain('1.0', [step('1.0', '1.1')]).join(' ')).toMatch(/termina en la versión 1\.1/);
  });

  it('detecta un ciclo', () => {
    expect(validateMigrationChain('1.1', [step('1.0', '1.1'), step('1.1', '1.0')]).join(' ')).toMatch(/ciclos/);
    expect(validateMigrationChain('1.0', [step('1.0', '1.0')]).join(' ')).toMatch(/ciclos/);
  });

  it('detecta dos pasos desde la misma versión, formatos inválidos y pasos sin función', () => {
    expect(validateMigrationChain('2.0', [step('1.0', '1.1'), step('1.0', '2.0')]).join(' ')).toMatch(/dos migraciones que parten de la versión 1\.0/);
    expect(validateMigrationChain('2.0', [step('uno', '2.0')]).join(' ')).toMatch(/mayor\.menor/);
    expect(validateMigrationChain('v2', [step('1.0', '2.0')]).join(' ')).toMatch(/mayor\.menor/);
    expect(validateMigrationChain('2.0', [{ from: '1.0', to: '2.0' } as unknown as DocumentMigration]).join(' ')).toMatch(/función «migrate»/);
  });

  it('ModuleRegistry.register rechaza el módulo con la cadena rota, nombrándolo', () => {
    const registry = new ModuleRegistry();
    expect(() => registry.register(testModule({ migrations: [toOnePointOne] }))).toThrow(/«prueba».*migraciones de documento inválidas.*termina en la versión 1\.1/);
    expect(() => registry.register(testModule({ migrations: [toOnePointOne, { ...toTwo, from: '1.2' }] }))).toThrow(/huecos/);
    expect(registry.ids()).toEqual([]);
    expect(registry.register(testModule()).ids()).toEqual(['prueba']);
  });

  it('un módulo sin migraciones y con una documentVersion cualquiera sigue registrándose (compatibilidad)', () => {
    const odd = testModule({ migrations: undefined, documentVersion: 'borrador' });
    expect(() => new ModuleRegistry().register(odd)).not.toThrow();
    // y como no se puede comparar, no migra: lo decide el esquema
    expect(migrateDocument(odd, { version: '1.0' }).status).toBe('current');
  });
});

describe('capacidades', () => {
  it('publican el contractVersion del módulo (1 si lo omite)', () => {
    expect(moduleCapabilities(testModule()).contractVersion).toBe(1);
    expect(moduleCapabilities(testModule({ contractVersion: 1 })).contractVersion).toBe(1);
  });
});
