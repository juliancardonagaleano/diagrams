import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build, type Options } from 'tsup';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import configs from '../tsup.config';

// El CLI se publica empaquetado por tsup (`dist/cli/index.js`, ESM). Las pruebas ejecutan el código fuente, así que un
// paquete CJS que tsup incruste en el bundle ESM (p. ej. `yaml`, que hace `require('process')`) solo falla al arrancar
// el binario real: así se rompió la imagen Docker. Esta prueba empaqueta el CLI con la misma configuración y lo ejecuta.
describe('CLI empaquetado (tsup)', () => {
  // Dentro del repo para que node resuelva las dependencias externas desde `node_modules`.
  const outDir = resolve('node_modules/.cache/iark-cli-bundle-test');
  const cli = join(outDir, 'cli/index.js');
  const run = (...args: string[]): string => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

  beforeAll(async () => {
    const options = (configs as Options[]).find((c) => c.entry && !Array.isArray(c.entry) && 'cli/index' in c.entry);
    expect(options, 'tsup.config.ts debe definir la entrada cli/index').toBeDefined();
    rmSync(outDir, { recursive: true, force: true });
    await build({ ...options, config: false, outDir, dts: false, sourcemap: false, silent: true });
  }, 60_000);

  afterAll(() => rmSync(outDir, { recursive: true, force: true }));

  it('arranca y lista los módulos del registro', () => {
    expect(run('--help')).toContain('Usage: iark');
    const modules = run('modules');
    for (const id of ['c4', 'integration', 'data', 'enterprise', 'platform', 'security']) expect(modules).toContain(id);
  });

  it('empaqueta junto al CLI el hilo de trabajo del cálculo de `iark serve` (dist/cli/compute-worker.js: lo busca el pool con `new URL`)', () => {
    expect(existsSync(join(outDir, 'cli/compute-worker.js'))).toBe(true);
  });

  it('ejecuta comandos de módulo y emite el manifiesto', () => {
    expect(run('data', 'catalog', 'examples/ventas-datos.json')).toContain('| Activo | Tipo |');
    expect(JSON.parse(run('modules', '--json')).schema).toBe('iark.manifest/1');
  });
});
