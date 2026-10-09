import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModuleRegistry, ProjectError, type DomainModule } from '@iark/kernel';
import { buildProgram, run } from './main';
import { createDefaultRegistry } from './registry';
import { FolderProjectStore } from './workspace';

const example = (file: string): string => readFileSync(`examples/${file}`, 'utf8');

const folders: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'iark-project-'));
  folders.push(dir);
  return dir;
};

interface Result {
  code: number;
  out: string;
  err: string;
}

/** Ejecuta `iark …` en este proceso (con el mismo manejo de errores y códigos de salida que el binario) y recoge su salida. */
async function capture(body: () => Promise<void>): Promise<Result> {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => (out.push(String(chunk)), true)) as never);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => (err.push(String(chunk)), true)) as never);
  process.exitCode = undefined;
  try {
    await body();
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return { code, out: out.join(''), err: err.join('') };
}

const iark = (...args: string[]): Promise<Result> => capture(() => run(['node', 'iark', ...args]));

/** Un espacio de trabajo temporal y un `iark` ya apuntado a él. */
function workspace(): { ws: string; ark: (...args: string[]) => Promise<Result>; store: FolderProjectStore } {
  const ws = join(tmp(), 'espacio');
  return { ws, ark: (...args) => iark(...args, '-w', ws), store: new FolderProjectStore(ws) };
}

const ok = async (promise: Promise<Result>): Promise<Result> => {
  const result = await promise;
  expect(result.err, 'stderr').toBe('');
  expect(result.code).toBe(0);
  return result;
};
const fails = async (promise: Promise<Result>, code: number, message: RegExp): Promise<Result> => {
  const result = await promise;
  expect(result.err).toMatch(message);
  expect(result.err.trim().split('\n').every((line) => !/^\s+at /.test(line)), 'sin stack').toBe(true);
  expect(result.code).toBe(code);
  return result;
};

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.IARK_WORKSPACE;
});

describe('iark project: proyectos', () => {
  it('create, list, show, rename y delete', async () => {
    const { ws, ark } = workspace();
    expect((await ark('project', 'list')).out).toContain('No hay proyectos');
    expect((await ok(ark('project', 'create', 'Tienda web', '--description', 'Pedidos y pagos'))).out).toContain('«Tienda web» creado (id tienda-web)');
    expect(readdirSync(ws)).toEqual(['tienda-web']);

    await fails(ark('project', 'create', 'tienda WEB'), 2, /Ya existe un proyecto llamado «tienda WEB»/);
    await fails(ark('project', 'create', '   '), 2, /no puede estar vacío/);

    const list = (await ok(ark('project', 'list'))).out;
    expect(list).toContain('Tienda web (tienda-web) · 0 diagramas');
    const listed = JSON.parse((await ok(ark('project', 'list', '--json'))).out);
    expect(listed).toMatchObject([{ id: 'tienda-web', name: 'Tienda web', description: 'Pedidos y pagos', diagrams: [] }]);

    const show = (await ok(ark('project', 'show', 'tienda web'))).out; // por nombre, sin distinguir mayúsculas
    expect(show).toContain('Tienda web (tienda-web)');
    expect(show).toContain('Pedidos y pagos');
    expect(show).toContain('Sin diagramas');
    expect(JSON.parse((await ok(ark('project', 'show', 'tienda-web', '--json'))).out)).toMatchObject({ id: 'tienda-web', name: 'Tienda web' });

    expect((await ok(ark('project', 'rename', 'tienda-web', 'Tienda en línea'))).out).toContain('renombrado a «Tienda en línea» (el id sigue siendo tienda-web)');
    expect(readdirSync(ws)).toEqual(['tienda-web']); // el directorio no se mueve
    await ok(ark('project', 'create', 'Banca'));
    await fails(ark('project', 'rename', 'banca', 'TIENDA EN LÍNEA'), 2, /Ya existe un proyecto/);
    await fails(ark('project', 'show', 'nada'), 2, /No existe el proyecto «nada»/);

    // borrar exige --yes, no pregunta, y explica qué borra
    const refused = await fails(ark('project', 'delete', 'banca'), 2, /elimina su directorio entero/);
    expect(refused.err).toContain(join(ws, 'banca'));
    expect(refused.err).toContain('--yes');
    expect(readdirSync(ws).sort()).toEqual(['banca', 'tienda-web']);
    expect((await ok(ark('project', 'delete', 'Banca', '--yes'))).out).toContain('borrado');
    expect(readdirSync(ws)).toEqual(['tienda-web']);
    await fails(ark('project', 'delete', 'banca', '--yes'), 2, /No existe el proyecto/);
  });

  it('la carpeta de trabajo: --workspace manda sobre IARK_WORKSPACE', async () => {
    const dir = tmp();
    process.env.IARK_WORKSPACE = join(dir, 'del-entorno');
    await ok(iark('project', 'create', 'Uno'));
    expect(readdirSync(join(dir, 'del-entorno'))).toEqual(['uno']);
    await ok(iark('project', 'create', 'Dos', '--workspace', join(dir, 'explicita')));
    expect(readdirSync(join(dir, 'explicita'))).toEqual(['dos']);
    expect(readdirSync(join(dir, 'del-entorno'))).toEqual(['uno']);
    expect((await ok(iark('project', 'list', '-w', join(dir, 'explicita')))).out).toContain('dos');
    expect((await ok(iark('project', 'list'))).out).toContain('uno');
  });

  it('un espacio de trabajo que no es una carpeta sale como error de una línea con código 1; un conflicto, con 3', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'archivo'), 'x');
    await fails(iark('project', 'list', '-w', join(dir, 'archivo')), 1, /no es una carpeta/);
    vi.spyOn(FolderProjectStore.prototype, 'listProjects').mockRejectedValue(new ProjectError('conflict', 'Alguien cambió el diagrama.'));
    await fails(iark('project', 'list', '-w', dir), 3, /Alguien cambió el diagrama/);
  });
});

describe('iark project: diagramas', () => {
  it('add deduce el módulo del nombre del archivo, o del contenido cuando solo uno lo reconoce entero', async () => {
    const { ws, ark } = workspace();
    await ok(ark('project', 'create', 'Tienda'));
    const dir = tmp();
    writeFileSync(join(dir, 'amenazas.security.json'), '{"version":"1.0"}'); // por el nombre (aunque el contenido encajaría en todos)
    expect((await ok(ark('project', 'add', 'Tienda', join(dir, 'amenazas.security.json'), '--force'))).out).toContain('Añadido «amenazas» (módulo security, id amenazas)');
    // por el contenido, sin pistas en el nombre: los ejemplos de cada módulo
    for (const [file, moduleId] of [
      ['seguridad-ejemplo.json', 'security'],
      ['plataforma-ejemplo.json', 'platform'],
      ['pedidos-integracion.json', 'integration'],
      ['empresa-arquitectura.json', 'enterprise'],
      ['ventas-datos.json', 'data'],
      ['banca.json', 'c4'],
    ]) {
      expect((await ok(ark('project', 'add', 'tienda', `examples/${file}`))).out, file).toContain(`(módulo ${moduleId}, id ${file.replace('.json', '')})`);
    }
    const names = readdirSync(join(ws, 'tienda')).sort();
    expect(names).toContain('seguridad-ejemplo.security.json');
    expect(names).toContain('banca.c4.json');
    // el documento se guarda tal cual
    expect(readFileSync(join(ws, 'tienda', 'ventas-datos.data.json'), 'utf8')).toBe(example('ventas-datos.json'));
    const shown = (await ok(ark('project', 'show', 'tienda'))).out;
    expect(shown).toContain('Diagramas (7):');
    expect(shown).toMatch(/seguridad-ejemplo\s+security\s+seguridad-ejemplo/);
  });

  it('add con un documento que ningún módulo identifica (o varios) es un error de uso que lista los módulos', async () => {
    const { ark } = workspace();
    await ok(ark('project', 'create', 'P'));
    const dir = tmp();
    writeFileSync(join(dir, 'vacio.json'), '{}');
    writeFileSync(join(dir, 'roto.json'), '{ no es json');
    writeFileSync(join(dir, 'lista.json'), '[]');
    writeFileSync(join(dir, 'nada.json'), '   ');
    const ambiguous = await fails(ark('project', 'add', 'p', join(dir, 'vacio.json')), 2, /No se pudo deducir el módulo/);
    expect(ambiguous.err).toContain('c4, integration, data, enterprise, platform, security');
    expect(ambiguous.err).toContain('--module');
    await fails(ark('project', 'add', 'p', join(dir, 'roto.json')), 2, /no es JSON válido/);
    await fails(ark('project', 'add', 'p', join(dir, 'lista.json')), 2, /Ningún módulo/);
    await fails(ark('project', 'add', 'p', join(dir, 'nada.json')), 2, /está vacío/);
    await fails(ark('project', 'add', 'p', join(dir, 'no-existe.json'), '--module', 'c4'), 2, /No se pudo leer/);
    await fails(ark('project', 'add', 'p', 'examples/banca.json', '--module', 'inventado'), 2, /No existe el módulo «inventado»/);
  });

  it('add --module valida contra el esquema: rechaza con la lista de errores, salvo --force (borrador)', async () => {
    const { ws, ark } = workspace();
    await ok(ark('project', 'create', 'P'));
    const dir = tmp();
    const bad = join(dir, 'malo.json');
    writeFileSync(bad, JSON.stringify({ zones: [{ id: 'z', name: 'Z', trust: 'inexistente' }] }));
    const refused = await fails(ark('project', 'add', 'p', bad, '--module', 'security'), 2, /no cumple el esquema del módulo «security»/);
    expect(refused.err).toMatch(/- zones\.0\.trust/);
    expect(refused.err).toContain('--force');
    expect(readdirSync(join(ws, 'p'))).toEqual(['project.json']);

    const forced = await ark('project', 'add', 'p', bad, '--module', 'security', '--force');
    expect(forced.code).toBe(0);
    expect(forced.err).toMatch(/borrador/);
    expect(JSON.parse(readFileSync(join(ws, 'p', 'malo.security.json'), 'utf8')).zones).toHaveLength(1);
    // un borrador que ni es JSON también se guarda con --force
    writeFileSync(join(dir, 'a-medias.json'), '{ "zones": [');
    expect((await ark('project', 'add', 'p', join(dir, 'a-medias.json'), '--module', 'security', '--force')).code).toBe(0);
    expect(readFileSync(join(ws, 'p', 'a-medias.security.json'), 'utf8')).toBe('{ "zones": [');
    // y `check` los marca (código 3)
    const check = await ark('project', 'check', 'p');
    expect(check.code).toBe(3);
    expect(check.out).toMatch(/esquema\s+security\s+malo/);
    expect(check.out).toMatch(/no es JSON\s+security\s+a-medias/);
    expect(check.err).toContain('2 diagramas inválidos');
  });

  it('add: el nombre por omisión, --name, nombres repetidos (exists), --update y un JSON entre vallas de código', async () => {
    const { ws, ark } = workspace();
    await ok(ark('project', 'create', 'P'));
    await ok(ark('project', 'add', 'p', 'examples/seguridad-ejemplo.json', '--name', 'Amenazas'));
    const again = await fails(ark('project', 'add', 'p', 'examples/seguridad-ejemplo.json', '--name', 'AMENAZAS'), 2, /Ya hay un diagrama llamado «Amenazas»/);
    expect(again.err).toContain('--update');

    const dir = tmp();
    const changed = JSON.parse(example('seguridad-ejemplo.json'));
    changed.workspace.name = 'Otro nombre de seguridad';
    writeFileSync(join(dir, 'v2.json'), JSON.stringify(changed));
    const updated = await ok(ark('project', 'add', 'p', join(dir, 'v2.json'), '--name', 'amenazas', '--update', '--module', 'security'));
    expect(updated.out).toContain('Actualizado «Amenazas» (módulo security, id amenazas)'); // conserva id y nombre
    expect(JSON.parse(readFileSync(join(ws, 'p', 'amenazas.security.json'), 'utf8')).workspace.name).toBe('Otro nombre de seguridad');
    expect(readdirSync(join(ws, 'p')).filter((f) => f.endsWith('.json') && f !== 'project.json')).toEqual(['amenazas.security.json']);
    // --update con un nombre nuevo lo añade; con un módulo distinto, no cambia el de un diagrama que existe
    await ok(ark('project', 'add', 'p', 'examples/plataforma-ejemplo.json', '--name', 'Nuevo', '--update'));
    await fails(ark('project', 'add', 'p', 'examples/plataforma-ejemplo.json', '--name', 'Amenazas', '--update', '--module', 'platform'), 2, /un diagrama no cambia de módulo/);

    // la salida de una IA suele venir entre vallas: se guarda el JSON limpio
    writeFileSync(join(dir, 'ia.json'), `\`\`\`json\n${example('ventas-datos.json')}\n\`\`\``);
    await ok(ark('project', 'add', 'p', join(dir, 'ia.json'), '--module', 'data', '--name', 'Desde la IA'));
    expect(JSON.parse(readFileSync(join(ws, 'p', 'desde-la-ia.data.json'), 'utf8')).domains).toBeDefined();
  });

  it('get, rename-diagram, remove y copy', async () => {
    const { ws, ark } = workspace();
    await ok(ark('project', 'create', 'A'));
    await ok(ark('project', 'create', 'B'));
    await ok(ark('project', 'add', 'a', 'examples/ventas-datos.json', '--name', 'Ventas'));

    expect((await ok(ark('project', 'get', 'a', 'ventas'))).out).toBe(example('ventas-datos.json')); // por nombre; tal cual
    const target = join(tmp(), 'sub', 'ventas.json');
    const got = await ark('project', 'get', 'A', 'Ventas', '-o', target);
    expect(got.code).toBe(0);
    expect(got.out).toBe('');
    expect(readFileSync(target, 'utf8')).toBe(example('ventas-datos.json'));
    await fails(ark('project', 'get', 'a', 'nada'), 2, /No existe el diagrama «nada» en el proyecto «A»/);

    expect((await ok(ark('project', 'rename-diagram', 'a', 'ventas', 'Ventas 2025'))).out).toContain('renombrado a «Ventas 2025» (el id sigue siendo ventas)');
    expect(existsSync(join(ws, 'a', 'ventas.data.json'))).toBe(true);
    expect((await ok(ark('project', 'show', 'a'))).out).toMatch(/ventas\s+data\s+Ventas 2025/);

    expect((await ok(ark('project', 'copy', 'a', 'ventas'))).out).toContain('copiado como «Ventas 2025 (copia)» (id ventas-2025-copia)');
    expect((await ok(ark('project', 'copy', 'a', 'ventas', '--to', 'B', '--name', 'Ventas de A'))).out).toContain('en el proyecto «B»');
    expect(JSON.parse((await ok(ark('project', 'list', '--json'))).out).map((p: { diagrams: unknown[] }) => p.diagrams.length)).toEqual([2, 1]);
    await fails(ark('project', 'copy', 'a', 'ventas', '--to', 'nada'), 2, /No existe el proyecto «nada»/);
    await fails(ark('project', 'copy', 'a', 'ventas', '--to', 'b', '--name', 'ventas de a'), 2, /Ya hay un diagrama/);

    const refused = await fails(ark('project', 'remove', 'a', 'ventas'), 2, /borra su archivo/);
    expect(refused.err).toContain('--yes');
    expect(existsSync(join(ws, 'a', 'ventas.data.json'))).toBe(true);
    expect((await ok(ark('project', 'remove', 'a', 'Ventas 2025', '--yes'))).out).toContain('quitado');
    expect(existsSync(join(ws, 'a', 'ventas.data.json'))).toBe(false);
    await fails(ark('project', 'remove', 'a', 'ventas', '--yes'), 2, /No existe el diagrama/);
  });
});

describe('iark project: archivo único, comprobación y trazabilidad', () => {
  async function suite(ark: (...args: string[]) => Promise<Result>, name = 'Tienda'): Promise<void> {
    await ok(ark('project', 'create', name));
    for (const file of ['seguridad-ejemplo', 'plataforma-ejemplo', 'pedidos-integracion', 'empresa-arquitectura', 'ventas-datos']) await ok(ark('project', 'add', name, `examples/${file}.json`));
  }

  it('export a stdout, a un archivo y a una carpeta; import crea uno nuevo y avisa si lo renombra', async () => {
    const { ark } = workspace();
    await suite(ark);
    const stdout = (await ok(ark('project', 'export', 'tienda'))).out;
    const bundle = JSON.parse(stdout);
    expect(bundle).toMatchObject({ format: 'iark.project', version: 1, generator: 'IArk - DIAgrams', project: { name: 'Tienda' } });
    expect(bundle.diagrams.map((d: { module: string }) => d.module).sort()).toEqual(['data', 'enterprise', 'integration', 'platform', 'security']);

    const dir = tmp();
    const file = join(dir, 'copia', 'mi.json');
    const exported = await ark('project', 'export', 'Tienda', '-o', file);
    expect(exported.code).toBe(0);
    expect(exported.err).toContain('exportado a');
    expect({ ...JSON.parse(readFileSync(file, 'utf8')), exportedAt: '' }).toEqual({ ...bundle, exportedAt: '' }); // solo cambia la hora de exportación
    mkdirSync(join(dir, 'carpeta'));
    expect((await ark('project', 'export', 'tienda', '-o', join(dir, 'carpeta'))).code).toBe(0);
    expect((await ark('project', 'export', 'tienda', '-o', `${join(dir, 'nueva')}/`)).code).toBe(0);
    expect(readdirSync(join(dir, 'carpeta'))).toEqual(['tienda.iark-project.json']);
    expect(readdirSync(join(dir, 'nueva'))).toEqual(['tienda.iark-project.json']);

    const { ark: other } = workspace();
    const first = await other('project', 'import', file);
    expect(first.code).toBe(0);
    expect(first.out).toContain('«Tienda» importado (id tienda, 5 diagramas)');
    const second = await other('project', 'import', file);
    expect(second.out).toContain('«Tienda (2)» importado (id tienda-2');
    expect(second.err).toContain('Ya había un proyecto llamado «Tienda»');
    expect((await ok(other('project', 'import', file, '--name', 'Mía'))).out).toContain('«Mía» importado');
    expect((await ok(other('project', 'check', 'tienda'))).out).toContain('Comprobación correcta.');
    await fails(other('project', 'import', join(dir, 'no-existe.json')), 2, /No se pudo leer/);
    writeFileSync(join(dir, 'raro.json'), '{"a":1}');
    await fails(other('project', 'import', join(dir, 'raro.json')), 2, /No es un proyecto de IArk/);
    writeFileSync(join(dir, 'roto.json'), '{ roto');
    await fails(other('project', 'import', join(dir, 'roto.json')), 2, /no es JSON válido/);
  });

  it('check: una línea por diagrama y las referencias; --json; falla (3) con referencias rotas', async () => {
    const { ws, ark } = workspace();
    await suite(ark);
    const good = await ok(ark('project', 'check', 'tienda'));
    expect(good.out).toContain('Proyecto «Tienda» (tienda): 5 diagramas');
    expect(good.out).toMatch(/ok\s+security\s+seguridad-ejemplo\s+0 errores, \d+ avisos?, \d+ notas?/);
    expect(good.out).toContain('Referencias entre diagramas: 15 enlaces, 0 rotas o ambiguas, 0 sin resolver');
    expect(good.out).toContain('Comprobación correcta.');
    const asJson = JSON.parse((await ok(ark('project', 'check', 'tienda', '--json'))).out);
    expect(asJson).toMatchObject({ ok: true, passed: true, strict: false, brokenRefs: 0, unresolvedRefs: 0 });
    expect(asJson.diagrams).toHaveLength(5);
    expect(asJson.graph.links).toHaveLength(15);

    // `--strict` también falla con avisos de los módulos (el ejemplo de seguridad los trae)
    const strict = await ark('project', 'check', 'tienda', '--strict');
    expect(strict.code).toBe(3);
    expect(strict.err).toMatch(/no pasa la comprobación: \d+ avisos/);

    // una referencia a un elemento que no existe rompe el proyecto
    const file = join(ws, 'tienda', 'plataforma-ejemplo.platform.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"urn:iark:integration:pedidos"', '"urn:iark:integration:no-existe"'));
    const broken = await ark('project', 'check', 'tienda');
    expect(broken.code).toBe(3);
    expect(broken.out).toMatch(/rota: urn:iark:platform:pedidos → apunta a «no-existe»/);
    expect(broken.out).toContain('La comprobación falló.');
    expect(broken.err).toContain('1 referencia rota o ambigua');
    expect(JSON.parse((await ark('project', 'check', 'tienda', '--json')).out)).toMatchObject({ ok: false, passed: false, brokenRefs: 1 });
  });

  it('check: dos diagramas del mismo módulo con los mismos ids dan referencias ambiguas', async () => {
    const { ark } = workspace();
    await suite(ark);
    await ok(ark('project', 'copy', 'tienda', 'pedidos-integracion'));
    const check = await ark('project', 'check', 'tienda');
    expect(check.code).toBe(3);
    expect(check.out).toMatch(/ambigua:/);
  });

  it('check --strict falla con referencias sin resolver (un módulo sin diagrama en el proyecto); sin --strict, no', async () => {
    const { ark } = workspace();
    await ok(ark('project', 'create', 'Solo plataforma'));
    await ok(ark('project', 'add', 'solo plataforma', 'examples/plataforma-ejemplo.json'));
    const lenient = await ok(ark('project', 'check', 'solo plataforma'));
    expect(lenient.out).toMatch(/0 rotas o ambiguas, \d+ sin resolver/);
    expect(lenient.out).toMatch(/sin resolver: urn:iark:platform:/);
    const strict = await ark('project', 'check', 'solo plataforma', '--strict');
    expect(strict.code).toBe(3);
    expect(strict.err).toMatch(/referencias sin resolver/);
  });

  it('check: los errores de las reglas del módulo también hacen fallar; los avisos, solo con --strict', async () => {
    const demo: DomainModule<{ n: number }> = {
      id: 'demo',
      name: 'Prueba',
      version: '0',
      documentVersion: '1',
      schema: z.object({ n: z.number() }),
      jsonSchema: () => ({}),
      validate: ({ n }) => (n < 0 ? [{ severity: 'error', message: 'n negativo' }] : n === 0 ? [{ severity: 'warning', message: 'n es cero' }] : []),
      importers: [],
      exporters: [],
    };
    const registry = new ModuleRegistry().register(demo);
    const ws = join(tmp(), 'espacio');
    const ark = async (...args: string[]): Promise<Result> => capture(async () => void (await buildProgram(registry).parseAsync(['node', 'iark', 'project', ...args, '-w', ws])));
    await ark('create', 'P');
    const dir = tmp();
    for (const [name, n] of [['bien', 1], ['cero', 0], ['mal', -1]] as const) writeFileSync(join(dir, `${name}.demo.json`), JSON.stringify({ n }));
    await ark('add', 'p', join(dir, 'bien.demo.json'));
    expect((await ark('check', 'p')).code).toBe(0);
    await ark('add', 'p', join(dir, 'cero.demo.json'));
    expect((await ark('check', 'p')).code).toBe(0);
    const strict = await ark('check', 'p', '--strict');
    expect(strict.code).toBe(3);
    expect(strict.err).toContain('1 aviso');
    await ark('add', 'p', join(dir, 'mal.demo.json'));
    const failed = await ark('check', 'p');
    expect(failed.code).toBe(3);
    expect(failed.out).toMatch(/ok\s+demo\s+mal\s+1 error/);
    expect(failed.err).toContain('1 error de reglas');
  });

  it('trace: informe, alcance con --from, JSON con quién define cada URN, Mermaid y SVG', async () => {
    const { ark } = workspace();
    await suite(ark);
    const general = (await ok(ark('project', 'trace', 'tienda'))).out;
    expect(general).toContain('5 documentos');
    const impact = (await ok(ark('project', 'trace', 'Tienda', '--from', 'integration:pedidos', '--direction', 'referrers'))).out;
    expect(impact).toContain('security:pedidos (Servicio de pedidos)');
    const json = JSON.parse((await ok(ark('project', 'trace', 'tienda', '--from', 'urn:iark:platform:pedidos', '--format', 'json'))).out);
    expect(json).toMatchObject({ project: { id: 'tienda', name: 'Tienda' }, from: 'urn:iark:platform:pedidos', skipped: [] });
    expect(json.reached).toHaveLength(3);
    expect(json.owners['urn:iark:platform:pedidos']).toEqual([{ id: 'plataforma-ejemplo', name: 'plataforma-ejemplo', module: 'platform' }]);
    expect((await ok(ark('project', 'trace', 'tienda', '--format', 'mermaid'))).out.startsWith('flowchart LR')).toBe(true);
    expect((await ok(ark('project', 'trace', 'tienda', '--from', 'integration:pedidos', '--format', 'svg'))).out.startsWith('<svg')).toBe(true);
    const target = join(tmp(), 'traza.md');
    await ok(ark('project', 'trace', 'tienda', '-o', target));
    expect(readFileSync(target, 'utf8')).toBe(general);
    // errores de uso: elemento inexistente, URN sin forma, sentido o formato inválidos
    await fails(ark('project', 'trace', 'tienda', '--from', 'platform:inexistente'), 2, /No existe el elemento/);
    await fails(ark('project', 'trace', 'tienda', '--from', 'sin-formato'), 2, /no es una URN/);
    await fails(ark('project', 'trace', 'nada'), 2, /No existe el proyecto/);
  });

  it('trace: acepta las banderas de iark trace (--type, --orphans, --matrix, --coverage, --min-coverage y --strict)', async () => {
    const { ark } = workspace();
    await suite(ark);
    const typed = JSON.parse((await ok(ark('project', 'trace', 'tienda', '--type', 'protects', '--format', 'json'))).out);
    expect(typed.types).toEqual(['protects']);
    expect(typed.graph.links).toHaveLength(5);
    expect(typed.graph.links.every((l: { type: string }) => l.type === 'protects')).toBe(true);
    expect(typed.project).toMatchObject({ id: 'tienda' });

    const sections = (await ok(ark('project', 'trace', 'tienda', '--orphans', 'security:zone', '--matrix', 'kind', '--coverage', 'security:asset -> platform'))).out;
    expect(sections).toContain('Huérfanos en security:zone: 4 de 4');
    expect(sections).toContain('Matriz de trazabilidad por tipo de elemento: 15 enlaces.');
    expect(sections).toContain('| `security:asset -> platform` | 5 | 11 | 45,5 % |');

    // la cobertura mínima hace fallar con código 3 y --strict la fija en 100 %
    const below = await ark('project', 'trace', 'tienda', '--coverage', 'security:asset -> platform', '--min-coverage', '50');
    expect(below.code).toBe(3);
    expect(below.err).toMatch(/Cobertura de «security:asset -> platform»: 45,5 %, por debajo del mínimo \(50 %\)/);
    expect((await ark('project', 'trace', 'tienda', '--coverage', 'security:asset -> platform', '--strict')).code).toBe(3);
    expect((await ark('project', 'trace', 'tienda', '--strict')).code).toBe(0);
    await fails(ark('project', 'trace', 'tienda', '--orphans', 'nada'), 2, /no existe el módulo «nada»/);
    await fails(ark('project', 'trace', 'tienda', '--min-coverage', '80'), 2, /necesita al menos una regla/);
  });

  it('trace --strict-unresolved cuenta las referencias a un módulo sin diagrama en el proyecto; --strict no', async () => {
    const { ark } = workspace();
    await ok(ark('project', 'create', 'Solo plataforma'));
    await ok(ark('project', 'add', 'solo plataforma', 'examples/plataforma-ejemplo.json'));
    expect((await ark('project', 'trace', 'solo plataforma', '--strict')).code).toBe(0);
    const strict = await ark('project', 'trace', 'solo plataforma', '--strict-unresolved');
    expect(strict.code).toBe(3);
    expect(strict.err).toMatch(/referencia\(s\) sin resolver/);
  });

  it('trace: deja fuera con un aviso los diagramas que no se pueden leer, y un proyecto vacío es un error de uso', async () => {
    const { ark } = workspace();
    await ok(ark('project', 'create', 'P'));
    await fails(ark('project', 'trace', 'p'), 2, /no tiene diagramas que trazar/);
    await ok(ark('project', 'add', 'p', 'examples/plataforma-ejemplo.json'));
    const dir = tmp();
    writeFileSync(join(dir, 'roto.json'), '{ "zones": [');
    expect((await ark('project', 'add', 'p', join(dir, 'roto.json'), '--module', 'security', '--force')).code).toBe(0);
    const traced = await ark('project', 'trace', 'p');
    expect(traced.code).toBe(0);
    expect(traced.err).toMatch(/aviso: se omite el diagrama «roto» \(security\): No es JSON válido/);
    expect(traced.out).toContain('1 documento');
  });
});

describe('iark project: registro y ayuda', () => {
  it('cuelga de `iark project` con sus subcomandos y la opción de carpeta de trabajo en todos', () => {
    const project = buildProgram(createDefaultRegistry()).commands.find((c) => c.name() === 'project')!;
    expect(project.commands.map((c) => c.name())).toEqual(['list', 'create', 'rename', 'delete', 'show', 'add', 'get', 'rename-diagram', 'remove', 'copy', 'export', 'import', 'check', 'trace']);
    for (const sub of project.commands) expect(sub.options.some((o) => o.long === '--workspace' && o.short === '-w'), sub.name()).toBe(true);
  });
});
