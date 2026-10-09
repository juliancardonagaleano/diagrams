import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildCliBundle, BUNDLE_TIMEOUT, PROCESS_TEST_TIMEOUT, type CliBundle } from './helpers/cliBundle';

// `iark project (CLI)` lanza el CLI empaquetado como proceso, igual que `tests/trace.test.ts`: se empaqueta una vez y se
// ejecuta con `node`, con margen de sobra por si la máquina está saturada.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT, hookTimeout: BUNDLE_TIMEOUT });

describe('iark project (CLI empaquetado)', () => {
  let bundle: CliBundle;
  const dirs: string[] = [];
  beforeAll(async () => {
    bundle = await buildCliBundle('project');
  });
  afterAll(() => {
    bundle?.dispose();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  const tmp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'iark-project-cli-'));
    dirs.push(dir);
    return dir;
  };
  const example = (file: string): string => resolve('examples', file);
  /** `iark …` con `cwd` como directorio actual (el espacio de trabajo por omisión es `./iark-workspace`). */
  const iark = (cwd: string, args: string[], options: { input?: string; env?: Record<string, string> } = {}) =>
    spawnSync(process.execPath, [bundle.cli, ...args], { cwd, encoding: 'utf8', input: options.input, env: { ...process.env, IARK_WORKSPACE: '', ...options.env } });

  it('recorre el flujo completo: create → add → show → check → trace → export → import en otra carpeta → check', () => {
    const cwd = tmp();
    const created = iark(cwd, ['project', 'create', 'Tienda web', '--description', 'Pedidos y pagos']);
    expect(created.status, created.stderr).toBe(0);
    expect(created.stdout).toContain('«Tienda web» creado (id tienda-web)');
    // sin --workspace ni IARK_WORKSPACE, el espacio de trabajo es ./iark-workspace
    expect(readdirSync(join(cwd, 'iark-workspace'))).toEqual(['tienda-web']);

    for (const [file, moduleId] of [
      ['seguridad-ejemplo.json', 'security'],
      ['plataforma-ejemplo.json', 'platform'],
      ['pedidos-integracion.json', 'integration'],
    ]) {
      const added = iark(cwd, ['project', 'add', 'tienda-web', example(file)]);
      expect(added.status, added.stderr).toBe(0);
      expect(added.stdout).toContain(`módulo ${moduleId}`);
    }
    // los diagramas, `project.json` y el historial de versiones (`.versiones`, oculto: ver docs/proyectos.md)
    expect(readdirSync(join(cwd, 'iark-workspace', 'tienda-web')).sort()).toEqual([
      '.versiones',
      'pedidos-integracion.integration.json',
      'plataforma-ejemplo.platform.json',
      'project.json',
      'seguridad-ejemplo.security.json',
    ]);

    const show = iark(cwd, ['project', 'show', 'Tienda web']);
    expect(show.status).toBe(0);
    expect(show.stdout).toContain('Diagramas (3):');
    expect(show.stdout).toMatch(/pedidos-integracion\s+integration/);

    const check = iark(cwd, ['project', 'check', 'tienda-web']);
    expect(check.status, check.stderr).toBe(0);
    expect(check.stdout).toContain('Proyecto «Tienda web» (tienda-web): 3 diagramas');
    expect(check.stdout).toMatch(/Referencias entre diagramas: 11 enlaces, 0 rotas o ambiguas, 0 sin resolver/);
    expect(iark(cwd, ['project', 'check', 'tienda-web', '--json']).stdout).toContain('"passed": true');

    const trace = iark(cwd, ['project', 'trace', 'tienda-web', '--from', 'integration:pedidos', '--direction', 'referrers']);
    expect(trace.status, trace.stderr).toBe(0);
    expect(trace.stdout).toContain('security:pedidos (Servicio de pedidos)');
    expect(iark(cwd, ['project', 'trace', 'tienda-web', '--format', 'mermaid']).stdout.startsWith('flowchart LR')).toBe(true);

    const file = join(cwd, 'tienda.iark-project.json');
    const exported = iark(cwd, ['project', 'export', 'tienda-web', '-o', file]);
    expect(exported.status, exported.stderr).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ format: 'iark.project', project: { name: 'Tienda web', description: 'Pedidos y pagos' } });

    // otra carpeta de trabajo, elegida con IARK_WORKSPACE; el archivo único trae todo
    const elsewhere = tmp();
    const env = { IARK_WORKSPACE: join(elsewhere, 'otro-espacio') };
    const imported = iark(elsewhere, ['project', 'import', file], { env });
    expect(imported.status, imported.stderr).toBe(0);
    expect(imported.stdout).toContain('«Tienda web» importado (id tienda-web, 3 diagramas)');
    expect(readdirSync(join(elsewhere, 'otro-espacio', 'tienda-web')).sort()).toEqual(readdirSync(join(cwd, 'iark-workspace', 'tienda-web')).sort());
    const again = iark(elsewhere, ['project', 'check', 'tienda-web'], { env });
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain('Comprobación correcta.');
    expect(existsSync(join(elsewhere, 'iark-workspace'))).toBe(false);
    // los documentos importados son idénticos (hasta el formato) a los de origen
    for (const name of ['seguridad-ejemplo.security.json', 'plataforma-ejemplo.platform.json', 'pedidos-integracion.integration.json']) {
      const a = JSON.parse(readFileSync(join(cwd, 'iark-workspace', 'tienda-web', name), 'utf8'));
      const b = JSON.parse(readFileSync(join(elsewhere, 'otro-espacio', 'tienda-web', name), 'utf8'));
      expect(b).toEqual(a);
    }
  });

  it('lee de la entrada estándar (add e import con "-") y escribe con -o', () => {
    const cwd = tmp();
    expect(iark(cwd, ['project', 'create', 'P']).status).toBe(0);
    const added = iark(cwd, ['project', 'add', 'p', '-', '--module', 'data', '--name', 'Ventas'], { input: readFileSync(example('ventas-datos.json'), 'utf8') });
    expect(added.status, added.stderr).toBe(0);
    expect(added.stdout).toContain('Añadido «Ventas» (módulo data, id ventas)');
    const out = join(cwd, 'salida', 'ventas.json');
    expect(iark(cwd, ['project', 'get', 'p', 'ventas', '-o', out]).status).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(readFileSync(example('ventas-datos.json'), 'utf8'));
    const bundle = iark(cwd, ['project', 'export', 'p']).stdout;
    const imported = iark(cwd, ['project', 'import', '-', '--name', 'Q'], { input: bundle });
    expect(imported.status, imported.stderr).toBe(0);
    expect(imported.stdout).toContain('«Q» importado (id q, 1 diagrama)');
    // sin el archivo, commander rechaza el comando
    expect(iark(cwd, ['project', 'add', 'p']).status).not.toBe(0);
  });

  it('los errores de uso salen con código 2 y un mensaje de una línea; las comprobaciones fallidas, con 3', () => {
    const cwd = tmp();
    const failed = (args: string[], status: number, message: RegExp) => {
      const r = iark(cwd, args);
      expect(r.stderr, args.join(' ')).toMatch(message);
      expect(r.stderr).not.toMatch(/\n\s+at /);
      expect(r.status, args.join(' ')).toBe(status);
    };
    failed(['project', 'show', 'nada'], 2, /No existe el proyecto «nada»/);
    expect(iark(cwd, ['project', 'create', 'P']).status).toBe(0);
    failed(['project', 'create', 'p'], 2, /Ya existe un proyecto/);
    failed(['project', 'delete', 'p'], 2, /elimina su directorio entero.*--yes/s);
    expect(existsSync(join(cwd, 'iark-workspace', 'p'))).toBe(true);
    failed(['project', 'add', 'p', example('banca.json'), '--module', 'inventado'], 2, /No existe el módulo/);
    failed(['project', 'trace', 'p'], 2, /no tiene diagramas/);
    writeFileSync(join(cwd, 'roto.json'), JSON.stringify({ zones: [{ id: 'z', name: 'Z', trust: 'x' }] }));
    failed(['project', 'add', 'p', join(cwd, 'roto.json'), '--module', 'security'], 2, /no cumple el esquema/);
    expect(iark(cwd, ['project', 'add', 'p', join(cwd, 'roto.json'), '--module', 'security', '--force']).status).toBe(0);
    expect(iark(cwd, ['project', 'check', 'p']).status).toBe(3);
    expect(iark(cwd, ['project', 'delete', 'p', '--yes']).status).toBe(0);
    expect(existsSync(join(cwd, 'iark-workspace', 'p'))).toBe(false);
  });

  it('`iark project --help` describe los subcomandos y la carpeta de trabajo', () => {
    const help = iark(tmp(), ['project', '--help']);
    expect(help.status).toBe(0);
    for (const name of ['list', 'create', 'rename', 'delete', 'show', 'add', 'get', 'rename-diagram', 'remove', 'copy', 'export', 'import', 'check', 'trace']) expect(help.stdout).toContain(name);
    expect(iark(tmp(), ['project', 'add', '--help']).stdout).toMatch(/--workspace <carpeta>[\s\S]*IARK_WORKSPACE/);
    expect(iark(tmp(), ['serve', '--help']).stdout).toMatch(/--workspace <carpeta>[\s\S]*\/api\/projects/);
  });
});
