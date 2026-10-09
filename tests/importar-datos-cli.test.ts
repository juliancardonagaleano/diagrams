import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { validateDataDocument } from '@iark/domain-data';
import { buildCliBundle, BUNDLE_TIMEOUT, PROCESS_TEST_TIMEOUT, type CliBundle } from './helpers/cliBundle';

// `iark import --module data` con los importadores de DDL de SQL y de dbt: el CLI empaquetado, como se publica.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT, hookTimeout: BUNDLE_TIMEOUT });

const DDL = 'tests/fixtures/importar/ddl';
const MANIFEST = 'tests/fixtures/importar/dbt/manifest-tienda.json';

describe('iark import --module data (DDL de SQL y dbt)', () => {
  let bundle: CliBundle;
  let dir: string;
  const run = (args: string[], input?: string) => {
    const r = spawnSync(process.execPath, [bundle.cli, ...args], { encoding: 'utf8', input });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const json = (out: string) => JSON.parse(out) as { workspace: { name: string }; assets: Array<{ id: string; kind: string }>; pipelines: unknown[]; relations: unknown[] };

  beforeAll(async () => {
    bundle = await buildCliBundle('importar-datos');
    dir = mkdtempSync(join(tmpdir(), 'iark-importar-datos-'));
  }, BUNDLE_TIMEOUT);
  afterAll(() => {
    bundle?.dispose();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('modules lista los dos importadores nuevos junto al de Mermaid', () => {
    const manifest = JSON.parse(run(['modules', '--json']).out) as { modules: Array<{ id: string; importFormats: string[] }> };
    expect(manifest.modules.find((m) => m.id === 'data')!.importFormats).toEqual(['mermaid', 'ddl', 'dbt', 'openlineage']);
  });

  it('importa un volcado de PostgreSQL con --format ddl: JSON válido por stdout, resumen y avisos por stderr', () => {
    const r = run(['import', `${DDL}/tienda-postgres.sql`, '--module', 'data', '--format', 'ddl']);
    expect(r.code).toBe(0);
    const doc = json(r.out);
    expect(validateDataDocument(doc).ok).toBe(true);
    expect(doc.workspace.name).toBe('tienda-postgres');
    expect(doc.assets.filter((a) => a.kind === 'table').length).toBeGreaterThanOrEqual(8);
    expect(doc.relations).toHaveLength(8);
    expect(r.err).toMatch(/^Importado "tienda-postgres" en el módulo data: \d+ elementos, 4 aviso\(s\)\.$/m);
    expect(r.err).toContain('aviso: línea 187: «categorias» se refiere a sí misma');
    expect(r.err).toContain('aviso: 2 columna(s) tienen nombre de dato personal');
    expect(r.err).toContain('aviso: Sin mapear (el modelo de datos no los recoge)');
  });

  it('deduce el formato de la extensión (.sql) y del contenido (stdin), y acepta --name', () => {
    const byExtension = run(['import', `${DDL}/tienda-mysql.sql`, '--module', 'data']);
    expect(byExtension.code).toBe(0);
    expect(json(byExtension.out).workspace.name).toBe('tienda-mysql');
    const sql = readFileSync(`${DDL}/tienda-sqlserver.sql`, 'utf8');
    const byContent = run(['import', '--stdin', '--module', 'data', '--name', 'Tienda SQL Server'], sql);
    expect(byContent.code).toBe(0);
    expect(json(byContent.out).workspace.name).toBe('Tienda SQL Server');
    expect(validateDataDocument(JSON.parse(byContent.out)).ok).toBe(true);
  });

  it('cada dialecto sale como documento válido con las mismas tablas', () => {
    for (const dialect of ['postgres', 'mysql', 'sqlserver', 'oracle', 'snowflake']) {
      const r = run(['import', `${DDL}/tienda-${dialect}.sql`, '--module', 'data', '--format', 'ddl']);
      expect(r.code, `${dialect}: ${r.err}`).toBe(0);
      const doc = json(r.out);
      expect(validateDataDocument(doc).ok, dialect).toBe(true);
      expect(doc.assets.some((a) => /pedidos$/.test(a.id)), dialect).toBe(true);
    }
  });

  it('importa el manifest de dbt con --format dbt y lo deduce por contenido incluso con una extensión genérica', () => {
    const r = run(['import', MANIFEST, '--module', 'data', '--format', 'dbt']);
    expect(r.code).toBe(0);
    const doc = json(r.out);
    expect(validateDataDocument(doc).ok).toBe(true);
    expect(doc.workspace.name).toBe('tienda_analitica');
    expect(doc.pipelines).toHaveLength(13);
    expect(doc.relations).toHaveLength(4);
    expect(r.err).toContain('Importado "tienda_analitica" en el módulo data: 40 elementos, 3 aviso(s).');
    expect(r.err).toContain('aviso: Sin mapear (no son activos de datos): 1 analysis, 1 operation');
    const auto = run(['import', MANIFEST, '--module', 'data']);
    expect(auto.code).toBe(0);
    expect(auto.out).toBe(r.out);
    const viaStdin = run(['import', '-', '--module', 'data'], readFileSync(MANIFEST, 'utf8'));
    expect(viaStdin.code).toBe(0);
    expect(json(viaStdin.out).pipelines).toHaveLength(13);
  });

  it('el resultado se guarda con -o y pasa por validate, catalog y convert del módulo', () => {
    for (const [file, name] of [
      [`${DDL}/tienda-postgres.sql`, 'ddl'],
      [MANIFEST, 'dbt'],
    ] as const) {
      const out = join(dir, `${name}.json`);
      const imported = run(['import', file, '--module', 'data', '-o', out]);
      expect(imported.code, imported.err).toBe(0);
      expect(imported.err).toContain(`Documento del módulo data escrito en ${out}`);
      const valid = run(['validate', out, '--module', 'data']);
      expect(valid.code, valid.err + valid.out).toBe(0);
      expect(valid.out).toContain('Documento válido (módulo data). 0 error(es)');
      expect(run(['data', 'catalog', out]).out).toContain('| Activo | Tipo |');
      const mermaid = run(['convert', out, '--module', 'data', '--to', 'mermaid', '--view', 'erd']);
      expect(mermaid.code, mermaid.err).toBe(0);
      expect(mermaid.out).toContain('erDiagram');
      const lineage = run(['convert', out, '--module', 'data', '--to', 'mermaid', '--view', 'lineage']);
      expect(lineage.code, lineage.err).toBe(0);
      expect(lineage.out).toMatch(/flowchart/);
    }
  });

  it('un documento importado se importa igual dos veces (idempotencia por el CLI)', () => {
    const a = run(['import', `${DDL}/tienda-oracle.sql`, '--module', 'data']);
    const b = run(['import', `${DDL}/tienda-oracle.sql`, '--module', 'data']);
    expect(a.code).toBe(0);
    expect(a.out).toBe(b.out);
    expect(a.err).toBe(b.err);
  });

  it('entradas rotas: error claro por stderr, código de salida 2 y nada en stdout', () => {
    const cases: Array<{ args: string[]; input?: string; message: string | RegExp }> = [
      { args: ['--format', 'ddl', '--stdin'], input: "CREATE TABLE a (x text DEFAULT 'abc", message: 'línea 1: una cadena sin cerrar' },
      { args: ['--format', 'ddl', '--stdin'], input: '', message: /vacío|no hay/i },
      { args: ['--format', 'ddl', '--stdin'], input: 'SELECT 1;', message: /no hay ninguna tabla|CREATE TABLE/i },
      { args: ['--format', 'dbt', '--stdin'], input: 'CREATE TABLE a (x int);', message: 'no es JSON válido' },
      { args: ['--format', 'dbt', '--stdin'], input: '{"nodes": {}}', message: 'no parece un manifest de dbt' },
      { args: ['--format', 'dbt', '--stdin'], input: JSON.stringify({ metadata: { dbt_schema_version: 'https://schemas.getdbt.com/dbt/catalog/v1.json' } }), message: 'artefacto de dbt «catalog»' },
      { args: ['--format', 'dbt', '--stdin'], input: readFileSync(MANIFEST, 'utf8').slice(0, 3000), message: 'no es JSON válido' },
      { args: ['--format', 'zzz', '--stdin'], input: 'x', message: 'Formato inválido «zzz». Use: auto, dbt, ddl, mermaid, openlineage.' },
      { args: ['--stdin'], input: 'texto sin formato', message: 'No se reconoce el formato de la entrada: use --format dbt, ddl, mermaid o openlineage.' },
    ];
    for (const c of cases) {
      const r = run(['import', '--module', 'data', ...c.args], c.input);
      expect(r.code, `${c.args.join(' ')} → ${r.err}`).toBe(2);
      expect(r.out).toBe('');
      expect(r.err).toMatch(c.message instanceof RegExp ? c.message : new RegExp(c.message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  it('un archivo de DDL que no existe falla sin trazas de pila', () => {
    const r = run(['import', join(dir, 'no-existe.sql'), '--module', 'data', '--format', 'ddl']);
    expect(r.code).not.toBe(0);
    expect(r.err).not.toMatch(/\n\s+at /);
  });

  it('un DDL guardado con BOM y saltos de línea de Windows se importa igual', () => {
    const file = join(dir, 'windows.sql');
    writeFileSync(file, `\uFEFF${readFileSync(`${DDL}/tienda-mysql.sql`, 'utf8').replace(/\n/g, '\r\n')}`);
    const r = run(['import', file, '--module', 'data']);
    expect(r.code, r.err).toBe(0);
    const reference = json(run(['import', `${DDL}/tienda-mysql.sql`, '--module', 'data']).out);
    const doc = json(r.out);
    expect(doc.assets.map((a) => a.id)).toEqual(reference.assets.map((a) => a.id));
    expect(doc.workspace.name).toBe('windows');
  });
});
