import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildCliBundle, BUNDLE_TIMEOUT, PROCESS_TEST_TIMEOUT, type CliBundle } from './helpers/cliBundle';

// Terraform repartido en varios `.tf` con el CLI empaquetado tal como se publica: `iark import <carpeta> --module platform
// --format terraform` lee los `*.tf` de la carpeta (sin entrar en subcarpetas, en orden alfabético) y también acepta varios
// archivos. El documento es el mismo que el de importar sus textos concatenados; los avisos y errores dicen de qué archivo vienen.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT, hookTimeout: BUNDLE_TIMEOUT });

let bundle: CliBundle;
let cli: string;
beforeAll(async () => {
  bundle = await buildCliBundle('importar-terraform-multiarchivo');
  cli = bundle.cli;
});
afterAll(() => bundle?.dispose());

const run = (args: string[], input?: string) => spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8' });
const tmp = mkdtempSync(join(tmpdir(), 'iark-terraform-multi-'));

const FOLDER = 'tests/fixtures/importar/terraform/aws-tienda-multiarchivo';
const tfFiles = readdirSync(FOLDER).filter((n) => n.endsWith('.tf')).sort();
const importOk = (args: string[], input?: string) => {
  const r = run(['import', '--module', 'platform', ...args], input);
  expect(r.status, r.stderr).toBe(0);
  return { doc: JSON.parse(r.stdout), stdout: r.stdout, stderr: r.stderr, warnings: r.stderr.split('\n').filter((l) => l.startsWith('aviso:')) };
};
const importFails = (args: string[], expectedStatus = 2) => {
  const r = run(['import', '--module', 'platform', ...args]);
  expect(r.status, r.stdout + r.stderr).toBe(expectedStatus);
  expect(r.stdout).toBe('');
  return r.stderr;
};
/** Una carpeta temporal con estos archivos (nombre → texto). */
const folder = (name: string, files: Record<string, string>): string => {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
};
const QUEUE = 'resource "aws_sqs_queue" "q" {\n  name = "q"\n}\n';

describe('iark import <carpeta> --module platform --format terraform', () => {
  it('lee todos los .tf de la carpeta: documento de plataforma, nombre de la carpeta y el resumen', () => {
    const { doc, stderr } = importOk(['--format', 'terraform', FOLDER]);
    expect(doc.workspace.name).toBe('aws-tienda-multiarchivo');
    expect(doc.environments).toEqual([expect.objectContaining({ id: 'production', kind: 'prod', provider: 'aws' })]);
    expect(doc.networks).toHaveLength(8);
    expect(doc.resources).toHaveLength(11);
    expect(stderr).toContain(`Leídos ${tfFiles.length} archivo(s) para importar juntos: ${tfFiles.join(', ')}.`);
    expect(stderr).toMatch(/Importado "aws-tienda-multiarchivo" en el módulo platform: \d+ elementos, 5 aviso\(s\)\./);
    expect(stderr).toContain('aws_xray_group');
  });

  it('da exactamente el mismo documento y los mismos avisos que importar los textos concatenados', () => {
    const joined = tfFiles.map((n) => readFileSync(join(FOLDER, n), 'utf8')).join('\n');
    const concatenated = importOk(['--stdin', '--format', 'terraform', '--name', 'Tienda'], joined);
    const together = importOk(['--format', 'terraform', '--name', 'Tienda', FOLDER]);
    expect(together.stdout).toBe(concatenated.stdout);
    expect(together.warnings).toEqual(concatenated.warnings);
  });

  it('con auto deduce el formato (la carpeta solo tiene .tf) y lo importado pasa validate sin errores ni avisos', () => {
    const out = join(tmp, 'tienda.platform.json');
    const auto = run(['import', '--module', 'platform', '-o', out, FOLDER]);
    expect(auto.status, auto.stderr).toBe(0);
    expect(auto.stdout).toBe('');
    const explicit = importOk(['--format', 'terraform', FOLDER]);
    expect(readFileSync(out, 'utf8')).toBe(explicit.stdout);
    const valid = run(['validate', out, '--module', 'platform', '--strict']);
    expect(valid.status, valid.stdout + valid.stderr).toBe(0);
  });

  it('importar dos veces la carpeta da la misma salida', () => {
    const a = importOk(['--format', 'terraform', FOLDER]);
    const b = importOk(['--format', 'terraform', FOLDER]);
    expect(a.stdout).toBe(b.stdout);
    expect(a.stderr).toBe(b.stderr);
  });

  it('con "." desde dentro de la carpeta también se nombra por la carpeta', () => {
    const r = spawnSync(process.execPath, [cli, 'import', '--module', 'platform', '--format', 'terraform', '.'], { cwd: FOLDER, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).workspace.name).toBe('aws-tienda-multiarchivo');
  });

  it('un nombre de carpeta genérico (infra, terraform) se sustituye por el de su carpeta padre', () => {
    const dir = folder('tienda-online/infra', { 'main.tf': QUEUE });
    expect(importOk(['--format', 'terraform', dir]).doc.workspace.name).toBe('tienda-online');
    const dir2 = folder('otra/terraform', { 'a.tf': QUEUE, 'b.tf': 'variable "x" {}\n' });
    expect(importOk([dir2]).doc.workspace.name).toBe('otra');
    expect(importOk(['--name', 'Mi tienda', dir2]).doc.workspace.name).toBe('Mi tienda');
  });

  it('no entra en las subcarpetas, ignora lo que no es .tf y avisa de los .tf.json y .tfstate que no lee', () => {
    const dir = folder('con-extras', {
      'a.tf': QUEUE,
      'LEEME.md': '# nada',
      'terraform.tfstate': '{"version":4,"resources":[]}',
      'extra.tf.json': '{"resource":{}}',
      'modules/roto/main.tf': 'resource "aws_vpc" "x" {\n  cidr_block = "10.0.0.0/16\n}\n',
    });
    const { doc, stderr } = importOk(['--format', 'terraform', dir]);
    expect(doc.resources.map((r: { id: string }) => r.id)).toEqual(['q']);
    expect(stderr).toContain('Leídos 1 archivo(s) para importar juntos: a.tf.');
    expect(stderr).toMatch(/aviso: 2 archivo\(s\) de la carpeta no se leen \(solo se juntan los \.tf; el resto de terraform se importa de uno en uno\): extra\.tf\.json, terraform\.tfstate\./);
  });

  it('un .tf vacío o de comentarios no es un error', () => {
    const dir = folder('con-vacio', { 'a.tf': QUEUE, 'outputs.tf': '# nada\n', 'vacio.tf': '' });
    expect(importOk([dir]).doc.resources).toHaveLength(1);
  });
});

describe('iark import con varios archivos .tf', () => {
  const files = ['red.tf', 'computo.tf', 'seguridad.tf', 'datos.tf', 'entrada.tf', 'variables.tf', 'providers.tf', 'otros.tf'].map((n) => join(FOLDER, n));

  it('da lo mismo que la carpeta (salvo el nombre del documento, que es el de la carpeta de los archivos) y no depende del orden', () => {
    const fromFolder = importOk(['--format', 'terraform', FOLDER]);
    const listed = importOk(['--format', 'terraform', ...files]);
    const reversed = importOk(['--format', 'terraform', ...[...files].reverse()]);
    expect(listed.doc.workspace.name).toBe('aws-tienda-multiarchivo');
    // Sin outputs.tf (que solo tiene comentarios) es el mismo documento; los avisos citan las rutas tal como se escribieron.
    expect(listed.doc).toEqual(fromFolder.doc);
    expect(reversed.stdout).toBe(listed.stdout);
    expect(listed.stderr).toContain(`Leídos ${files.length} archivo(s) para importar juntos:`);
  });

  it('con auto deduce el formato por la extensión', () => {
    const { doc } = importOk([join(FOLDER, 'red.tf'), join(FOLDER, 'datos.tf')]);
    expect(doc.networks.length).toBeGreaterThan(5);
  });

  it('un error de sintaxis nombra el archivo con su ruta y la línea', () => {
    const dir = folder('roto', { 'bien.tf': QUEUE, 'roto.tf': 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16\n}\n' });
    // Con carpeta, el nombre del archivo; con lista, la ruta tal como se escribió.
    expect(importFails(['--format', 'terraform', dir])).toContain('El HCL de Terraform no es válido (roto.tf, línea 2): cadena sin cerrar.');
    expect(importFails(['--format', 'terraform', join(dir, 'bien.tf'), join(dir, 'roto.tf')])).toContain(`El HCL de Terraform no es válido (${join(dir, 'roto.tf')}, línea 2): cadena sin cerrar.`);
  });

  it('los avisos de líneas que no entiende llevan el archivo', () => {
    const dir = folder('con-aviso', { 'a.tf': 'resource "aws_s3_bucket" "a" {\n  bucket = "x"\n  ???\n}\n', 'b.tf': QUEUE });
    const { stderr } = importOk([dir]);
    expect(stderr).toMatch(/aviso: a\.tf, línea 3: no se entiende/);
  });

  it('rechaza con un mensaje claro lo que no se puede juntar', () => {
    const dir = folder('mezcla', { 'a.tf': QUEUE, 'b.yaml': 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: x\n' });
    expect(importFails([join(dir, 'a.tf'), join(dir, 'b.yaml')])).toMatch(/Los archivos no son todos del mismo formato: solo se leen juntos los \.tf o los \.yaml, \.yml\./);
    expect(importFails(['--format', 'kubernetes', FOLDER])).toMatch(/El formato «kubernetes» no se puede leer repartido en varios archivos ni desde una carpeta: indique un solo archivo \(los formatos que sí: terraform, helm\)\./);
    expect(importFails(['--format', 'nada', FOLDER])).toMatch(/Formato inválido «nada»/);
    expect(importFails([FOLDER, join(dir, 'a.tf')])).toMatch(/Indique una carpeta o varios archivos, no las dos cosas a la vez\./);
    expect(importFails(['-', join(dir, 'a.tf')])).toMatch(/«-» \(la entrada estándar\) no se puede combinar con otros archivos\./);
    expect(importFails([folder('sin-tf', { 'LEEME.md': 'nada' })])).toMatch(/no tiene ningún archivo que se pueda importar junto con otros \(\.tf o \.yaml, \.yml\)/);
    expect(importFails([join(dir, 'a.tf'), join(dir, 'no-existe.tf')], 1)).toMatch(/No se pudo leer ".*no-existe\.tf"/);
  });

  it('otros módulos no importan carpetas ni varios archivos', () => {
    const r = run(['import', '--module', 'data', FOLDER]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/El módulo «data» no importa carpetas ni varios archivos a la vez: indique un solo archivo\./);
    const c4 = run(['import', join(FOLDER, 'red.tf'), join(FOLDER, 'datos.tf')]);
    expect(c4.status).toBe(2);
    expect(c4.stderr).toMatch(/El módulo «c4» no importa carpetas ni varios archivos/);
  });

  it('un archivo suelto sigue importándose como siempre', () => {
    const copy = join(tmp, 'solo.tf');
    copyFileSync('tests/fixtures/importar/terraform/aws-tienda/main.tf', copy);
    const { doc, stderr } = importOk(['--format', 'terraform', copy]);
    expect(doc.workspace.name).toBe('solo');
    expect(stderr).not.toContain('Leídos');
  });

  it('la ayuda del comando describe las carpetas y los varios archivos', () => {
    const help = run(['import', '--help']).stdout.replace(/\s+/g, ' ');
    expect(help).toContain('[archivos...]');
    expect(help).toMatch(/una carpeta/);
    expect(help).toMatch(/orden alfabético/);
    expect(help).toMatch(/los módulos locales no se resuelven/);
  });
});
