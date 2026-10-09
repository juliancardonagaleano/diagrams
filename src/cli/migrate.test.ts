import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModuleRegistry } from '@iark/kernel';
import { DOC_V10, DOC_V11, DOC_V20, moduloMigrable } from '../../tests/helpers/moduloMigrable';
import { DOC_C4_0_9, instalarMigracionesC4 } from '../../tests/helpers/migracionC4';
import { CliError } from './io';
import { buildProgram } from './main';
import { createDefaultRegistry } from './registry';

/**
 * `iark migrate` y el aviso de migración en `validate`, en proceso (sin empaquetar el CLI). Los seis módulos reales siguen en la
 * versión 1.0 y no tienen migraciones, así que se prueba con el módulo de `tests/helpers/moduloMigrable.ts` (1.0 → 1.1 → 2.0) y, para
 * C4, con una migración instalada mientras dura la prueba.
 */
const dir = mkdtempSync(join(tmpdir(), 'iark-migrate-'));
let n = 0;
function archivo(contenido: unknown): string {
  const ruta = join(dir, `doc-${++n}.json`);
  writeFileSync(ruta, JSON.stringify(contenido));
  return ruta;
}

let stdout: string;
let stderr: string;
beforeEach(() => {
  stdout = '';
  stderr = '';
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation(((texto: string) => ((stdout += texto), true)) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((texto: string) => ((stderr += texto), true)) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const registroDePrueba = () => new ModuleRegistry().register(moduloMigrable);
const iark = (registro: ModuleRegistry, ...args: string[]) => buildProgram(registro).parseAsync(['node', 'iark', ...args]);

describe('iark migrate --module <otro>', () => {
  it('lleva un documento de la versión 1.0 a la actual por toda la cadena y lo escribe por stdout', async () => {
    await iark(registroDePrueba(), 'migrate', archivo(DOC_V10), '--module', 'prueba');
    expect(JSON.parse(stdout)).toEqual(DOC_V20);
    expect(stderr).toMatch(/versión 1\.0 → 2\.0/);
    expect(stderr).toMatch(/1\.0 → 1\.1: El nombre pasa a workspace\.name/);
    expect(stderr).toMatch(/1\.1 → 2\.0: label pasa a title/);
    expect(process.exitCode).toBeUndefined();
  });

  it('empieza en el paso que corresponde a la versión del documento', async () => {
    await iark(registroDePrueba(), 'migrate', archivo(DOC_V11), '--module', 'prueba');
    expect(JSON.parse(stdout)).toEqual(DOC_V20);
    expect(stderr).toMatch(/versión 1\.1 → 2\.0/);
    expect(stderr).not.toMatch(/1\.0 → 1\.1/);
  });

  it('--out escribe el documento migrado en el archivo y deja la salida estándar vacía; el original no cambia', async () => {
    const origen = archivo(DOC_V10);
    const destino = join(dir, 'migrado.json');
    await iark(registroDePrueba(), 'migrate', origen, '--module', 'prueba', '--out', destino);
    expect(JSON.parse(readFileSync(destino, 'utf8'))).toEqual(DOC_V20);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/Documento migrado escrito en/);
    expect(JSON.parse(readFileSync(origen, 'utf8'))).toEqual(DOC_V10);
  });

  it('un documento que ya está en la versión actual se escribe tal cual y no se considera migrado', async () => {
    await iark(registroDePrueba(), 'migrate', archivo(DOC_V20), '--module', 'prueba');
    expect(JSON.parse(stdout)).toEqual(DOC_V20);
    expect(stderr).toMatch(/ya está en la versión 2\.0.*no necesita migración/);
  });

  it('--check no escribe nada y sale con código 1 si el documento necesita migración', async () => {
    await iark(registroDePrueba(), 'migrate', archivo(DOC_V10), '--module', 'prueba', '--check');
    expect(stdout).toBe('');
    expect(process.exitCode).toBe(1);
    expect(stderr).toMatch(/Necesita migración/);
  });

  it('--check con --out tampoco escribe el archivo', async () => {
    const destino = join(dir, 'no-debe-existir.json');
    await iark(registroDePrueba(), 'migrate', archivo(DOC_V10), '--module', 'prueba', '--check', '--out', destino);
    expect(process.exitCode).toBe(1);
    expect(() => readFileSync(destino, 'utf8')).toThrow();
  });

  it('--check sale con 0 (y no escribe) si el documento ya está en la versión actual', async () => {
    await iark(registroDePrueba(), 'migrate', archivo(DOC_V20), '--module', 'prueba', '--check');
    expect(stdout).toBe('');
    expect(process.exitCode).toBeUndefined();
  });

  it('un documento de una versión MÁS NUEVA termina con código 2 y el mensaje de actualizar DIAgrams (también con --check)', async () => {
    const futuro = archivo({ ...DOC_V20, version: '3.0' });
    await expect(iark(registroDePrueba(), 'migrate', futuro, '--module', 'prueba')).rejects.toMatchObject({ exitCode: 2, message: expect.stringMatching(/versión más nueva \(3\.0\).*Actualiza DIAgrams/s) });
    await expect(iark(registroDePrueba(), 'migrate', futuro, '--module', 'prueba', '--check')).rejects.toBeInstanceOf(CliError);
    expect(stdout).toBe('');
  });

  it('una versión anterior sin cadena de migraciones termina con código 2 diciendo desde dónde sí se puede migrar', async () => {
    await expect(iark(registroDePrueba(), 'migrate', archivo({ ...DOC_V10, version: '0.5' }), '--module', 'prueba')).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringMatching(/versión 0\.5.*no está soportada.*desde: 1\.0, 1\.1/s),
    });
  });

  it('un documento migrado que el esquema rechaza termina con código 2 y las incidencias', async () => {
    await expect(iark(registroDePrueba(), 'migrate', archivo({ version: '1.0', name: 7, items: [] }), '--module', 'prueba')).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringMatching(/Documento inválido para el módulo «prueba»/),
    });
  });

  it('un archivo que no existe, o que no es JSON, es un error de uso (CliError), no un volcado de pila', async () => {
    await expect(iark(registroDePrueba(), 'migrate', join(dir, 'no-existe.json'), '--module', 'prueba')).rejects.toThrow(/No se pudo leer/);
    const roto = join(dir, 'roto.json');
    writeFileSync(roto, '{ "version": ');
    await expect(iark(registroDePrueba(), 'migrate', roto, '--module', 'prueba')).rejects.toBeInstanceOf(CliError);
  });

  it('un módulo inexistente se rechaza', async () => {
    await expect(iark(registroDePrueba(), 'migrate', archivo(DOC_V10), '--module', 'nada')).rejects.toThrow(/nada/);
  });
});

describe('iark validate --module <otro> con un documento antiguo', () => {
  it('lo valida migrado y lo dice en la salida estándar', async () => {
    await iark(registroDePrueba(), 'validate', archivo(DOC_V10), '--module', 'prueba');
    expect(stdout).toMatch(/Documento migrado de la versión 1\.0 a 2\.0/);
    expect(stdout).toMatch(/Documento válido/);
    expect(stderr).not.toMatch(/migrado/); // una sola vez: validate lo cuenta en su informe, no además por stderr
  });

  it('un documento de la versión actual no menciona migración', async () => {
    await iark(registroDePrueba(), 'validate', archivo(DOC_V20), '--module', 'prueba');
    expect(stdout).not.toMatch(/migrado/);
    expect(stderr).not.toMatch(/migrado/);
  });
});

describe('iark migrate / validate con el módulo C4 (por la vía de validateDocument)', () => {
  let restaurar: (() => void) | undefined;
  afterEach(() => restaurar?.());

  it('sin migraciones declaradas, el documento antiguo se rechaza con un mensaje que lo explica', async () => {
    await expect(iark(createDefaultRegistry(), 'migrate', archivo(DOC_C4_0_9))).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringMatching(/versión 0\.9 del documento no está soportada por el módulo «c4»/),
    });
  });

  it('con la migración declarada: migrate escribe el documento actual, --check sale con 1 y validate lo informa', async () => {
    restaurar = instalarMigracionesC4();
    const registro = createDefaultRegistry();
    const origen = archivo(DOC_C4_0_9);

    await iark(registro, 'migrate', origen);
    expect(JSON.parse(stdout)).toMatchObject({ version: '1.0', workspace: { name: 'Banca antigua' } });
    expect(stderr).toMatch(/versión 0\.9 → 1\.0/);

    stdout = '';
    await iark(registro, 'migrate', origen, '--check');
    expect(stdout).toBe('');
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    await iark(registro, 'validate', origen);
    expect(stdout).toMatch(/info\s+Documento migrado de la versión 0\.9 a 1\.0/);
    expect(stdout).toMatch(/Documento válido/);
  });

  it('un documento C4 de la versión actual: --check sale con 0', async () => {
    await iark(createDefaultRegistry(), 'migrate', 'examples/banca.json', '--check');
    expect(stdout).toBe('');
    expect(process.exitCode).toBeUndefined();
  });
});
