import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandInfos, runCommand } from '@iark/kernel';
import { buildProgram } from '../src/cli/main';
import { createDefaultRegistry } from '../src/cli/registry';

/**
 * `POST /api/<módulo>/run/<comando>` es público y pasa `options` y `args` del cliente a `runCommand`. Un comando que lee archivos
 * (`icons --pack <archivo>`) dejaba a cualquiera leer el disco del servidor (existencia del archivo y parte de su contenido en el
 * error de `JSON.parse`). Los comandos que tocan el disco, la red o los procesos deben marcar esa opción con `local: true`
 * (`CommandOption.local`), y `runCommand` la rechaza con `remote: true`. Estas pruebas fijan la auditoría de los seis módulos.
 */

const registry = createDefaultRegistry();

/** `módulo comando --opción` de cada opción o argumento marcado `local`. */
function localSurface(): string[] {
  const found: string[] = [];
  for (const module of registry.list()) {
    for (const spec of module.cliCommands ?? []) {
      for (const option of spec.options ?? []) if (option.local) found.push(`${module.id} ${spec.name} ${/--[a-z0-9-]+/i.exec(option.flags)![0]}`);
      for (const arg of spec.args ?? []) if (arg.local) found.push(`${module.id} ${spec.name} <${arg.name}>`);
    }
  }
  return found.sort();
}

/** Los archivos `.ts` de producción (sin pruebas) de los módulos de dominio. */
function domainSources(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) files.push(path);
    }
  };
  for (const pkg of readdirSync('packages').filter((d) => d.startsWith('domain-'))) walk(join('packages', pkg, 'src'));
  return files.sort();
}

/** Lo que da acceso al sistema de archivos, la red, los procesos o el entorno de la máquina. */
const HOST_ACCESS = [
  /\bnode:[a-z_]+/,
  /from\s+['"](fs|path|os|child_process|net|http|https|http2|dns|tls|dgram|worker_threads|vm|cluster|readline|zlib)(\/[a-z]+)?['"]/,
  /\bprocess\.(env|cwd|argv|stdin|stdout|stderr|exit|chdir|binding|kill|spawn)\b/,
  /\bfetch\s*\(/,
  /\bnew\s+(XMLHttpRequest|WebSocket|EventSource)\b/,
  /\brequire\s*\(/,
  /\beval\s*\(|\bnew\s+Function\s*\(/,
];

describe('auditoría de los comandos de los módulos (alcanzables por POST /api/<módulo>/run/<comando>)', () => {
  it('solo `platform icons --pack` lee del disco, y está marcado como local', () => {
    expect(localSurface()).toEqual(['platform icons --pack']);
  });

  it('ningún otro código de los módulos de dominio accede al sistema de archivos, la red, los procesos o el entorno', () => {
    const using = domainSources().filter((file) => HOST_ACCESS.some((pattern) => pattern.test(readFileSync(file, 'utf8'))));
    // Si esto falla, un comando nuevo toca la máquina: márcalo `local: true` (CommandOption/CommandSpec.args) y añádelo aquí.
    expect(using.map((file) => relative('.', file))).toEqual(['packages/domain-platform/src/icons/commands.ts']);
  });

  it('el servicio rechaza `--pack` aunque la ruta exista y aunque no exista, con el mismo mensaje y sin ejecutar el comando', async () => {
    const platform = registry.require('platform');
    const dir = mkdtempSync(join(tmpdir(), 'iark-pack-remoto-'));
    try {
      const secret = join(dir, 'secreto.txt');
      writeFileSync(secret, 'contraseña-que-no-debe-salir');
      const input = readFileSync('examples/plataforma-ejemplo.json', 'utf8');
      const ask = (pack: string) => runCommand(platform, 'icons', { input, options: { pack } }, { remote: true }).then(() => 'respondió', (error: Error) => error.message);
      const existing = await ask(secret);
      const missing = await ask(join(dir, 'no-existe.json'));
      expect(existing).toBe(missing);
      expect(existing).toMatch(/solo está disponible en el CLI local/);
      expect(existing).not.toContain('contraseña');
      expect(existing).not.toContain(dir);
      // sin la opción, el mismo comando funciona en remoto
      expect((await runCommand(platform, 'icons', { input }, { remote: true })).output).toContain('Paquetes de iconos');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('las superficies remotas pueden ocultar las opciones locales: `commandInfos` las marca', () => {
    const icons = commandInfos(registry.require('platform')).find((c) => c.name === 'icons')!;
    expect(icons.options.map((o) => [o.key, o.local ?? false])).toEqual([['pack', true]]);
  });
});

describe('el CLI local sigue aceptando las opciones locales', () => {
  afterEach(() => vi.restoreAllMocks());

  it('`iark platform icons <documento> --pack <archivo>` lee el paquete del disco', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iark-pack-local-'));
    try {
      const pack = join(dir, 'oci.json');
      writeFileSync(pack, JSON.stringify({ id: 'oci-propio', name: 'Oracle Cloud', provider: 'oci', color: '#c74634', icons: { adb: { label: 'Autonomous Database', paths: ['M2 2h12v12H2z'], kinds: ['database'] } } }));
      const out: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => (out.push(String(chunk)), true)) as never);
      await buildProgram().parseAsync(['node', 'iark', 'platform', 'icons', 'examples/plataforma-nubes.json', '--pack', pack]);
      const text = out.join('');
      expect(text).toContain('oci · Oracle Cloud');
      expect(text).toContain(`Paquete oci-propio (${pack}): válido, 1 servicios.`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
