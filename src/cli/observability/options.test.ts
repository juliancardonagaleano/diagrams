import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { CliError } from '../io';
import { addObservabilityOptions, setupObservability, type ObservabilityFlags } from './options';
import type { Observability } from './index';

const folders: string[] = [];
const opened: Observability[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'iark-opciones-'));
  folders.push(dir);
  return dir;
};
afterEach(async () => {
  for (const o of opened.splice(0)) await o.close();
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TOKEN = 'a-token-with-at-least-16-chars';
const setup = (flags: ObservabilityFlags, context: Partial<Parameters<typeof setupObservability>[1]> = {}) => {
  const result = setupObservability(flags, { host: '127.0.0.1', trustProxy: false, version: 'x', env: {}, ...context });
  opened.push(result.observability);
  return result;
};
const usageError = (run: () => unknown): CliError => {
  try {
    run();
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error('no falló');
};

describe('addObservabilityOptions', () => {
  const parse = (args: string[], env: NodeJS.ProcessEnv = {}) => {
    const command = addObservabilityOptions(new Command().exitOverride(), env);
    command.parse(['node', 'serve', ...args]);
    return command.opts<ObservabilityFlags>();
  };

  it('todo apagado por omisión', () => {
    expect(parse([])).toEqual({ accessLog: undefined, auditLog: undefined, metrics: false, metricsToken: undefined });
  });

  it('las opciones mandan sobre las variables de entorno, que son los valores por omisión', () => {
    const env = { IARK_ACCESS_LOG: '/var/log/a.jsonl', IARK_AUDIT_LOG: '/var/log/b.jsonl', IARK_METRICS: '1', IARK_METRICS_TOKEN: TOKEN };
    expect(parse([], env)).toEqual({ accessLog: '/var/log/a.jsonl', auditLog: '/var/log/b.jsonl', metrics: true, metricsToken: TOKEN });
    expect(parse(['--access-log', '-', '--audit-log', 'otro.jsonl', '--metrics-token', 'x'.repeat(20)], env)).toMatchObject({ accessLog: '-', auditLog: 'otro.jsonl', metricsToken: 'x'.repeat(20) });
    expect(parse([], { IARK_METRICS: 'no' }).metrics).toBe(false);
    expect(parse([], { IARK_METRICS: 'true' }).metrics).toBe(true);
  });
});

describe('setupObservability', () => {
  it('sin opciones no hay registros ni métricas, y se anuncia solo la salud', () => {
    const { observability, metricsToken, lines } = setup({});
    expect(observability.accessSink).toBeUndefined();
    expect(observability.auditSink).toBeUndefined();
    expect(observability.metrics).toBeUndefined();
    expect(metricsToken).toBeUndefined();
    expect(lines).toEqual(['  salud: /healthz (vivo) · /readyz (listo)']);
  });

  it('abre los registros: la auditoría en un archivo 0600 que ya existe al arrancar, los accesos en la salida estándar con `-`', () => {
    const dir = temp();
    const file = join(dir, 'logs', 'auditoria.jsonl');
    const { observability, lines } = setup({ accessLog: '-', auditLog: file });
    expect(observability.accessSink?.target).toBe('stdout');
    expect(observability.auditSink?.target).toBe(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(lines.join('\n')).toContain(file);
    expect(lines.join('\n')).toContain('0600');
  });

  it('métricas: en loopback valen sin token; con token, solo se anuncia que lo lleva (nunca el valor)', () => {
    const open = setup({ metrics: true });
    expect(open.observability.metrics).toBeDefined();
    expect(open.metricsToken).toBeUndefined();
    expect(open.lines.join('\n')).toContain('solo conexiones locales');
    const closed = setup({ metrics: true, metricsToken: TOKEN }, { host: '0.0.0.0' });
    expect(closed.metricsToken).toBe(TOKEN);
    expect(closed.lines.join('\n')).toContain('con token Bearer');
    expect(closed.lines.join('\n')).not.toContain(TOKEN);
  });

  it('métricas sin token fuera de loopback, o detrás de un proxy: error de uso (código 2) y no se abre ningún archivo', () => {
    const dir = temp();
    const file = join(dir, 'a.jsonl');
    for (const context of [{ host: '0.0.0.0' }, { host: '::' }, { host: 'servicio.interno' }, { host: '127.0.0.1', trustProxy: true }]) {
      const error = usageError(() => setup({ metrics: true, auditLog: file }, context));
      expect(error.exitCode).toBe(2);
      expect(error.message).toContain('--metrics-token');
    }
    expect(() => statSync(file)).toThrow(); // falló antes de abrir nada
  });

  it('el token debe tener entre 16 y 256 caracteres imprimibles, sin espacios', () => {
    for (const bad of ['corto', 'con espacios dentro 123456', 'x'.repeat(257), 'ñ'.repeat(20)]) {
      expect(usageError(() => setup({ metrics: true, metricsToken: bad })).exitCode, bad).toBe(2);
    }
  });

  it('el token también puede venir de un archivo (IARK_METRICS_TOKEN_FILE); uno ilegible o vacío es un error de uso', () => {
    const dir = temp();
    writeFileSync(join(dir, 'token'), `${TOKEN}\n`);
    expect(setup({ metrics: true }, { host: '0.0.0.0', env: { IARK_METRICS_TOKEN_FILE: join(dir, 'token') } }).metricsToken).toBe(TOKEN);
    writeFileSync(join(dir, 'vacio'), '\n');
    expect(usageError(() => setup({ metrics: true }, { env: { IARK_METRICS_TOKEN_FILE: join(dir, 'vacio') } })).exitCode).toBe(2);
    expect(usageError(() => setup({ metrics: true }, { env: { IARK_METRICS_TOKEN_FILE: join(dir, 'no-existe') } })).message).toContain('ENOENT');
  });

  it('un token sin --metrics solo da un aviso: /metrics sigue apagado', () => {
    const { observability, metricsToken, lines } = setup({ metricsToken: TOKEN });
    expect(observability.metrics).toBeUndefined();
    expect(metricsToken).toBeUndefined();
    expect(lines[0]).toContain('falta --metrics');
  });

  it('los dos registros no pueden ser el mismo archivo, y un archivo que no se puede abrir es un error de uso con el nombre de la opción', () => {
    const dir = temp();
    const file = join(dir, 'x.jsonl');
    expect(usageError(() => setup({ accessLog: file, auditLog: join(dir, '.', 'x.jsonl') })).exitCode).toBe(2);
    writeFileSync(join(dir, 'archivo'), 'x');
    const error = usageError(() => setup({ auditLog: join(dir, 'archivo', 'dentro.jsonl') }));
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain('--audit-log');
    expect(usageError(() => setup({ accessLog: join(dir, 'archivo', 'dentro.jsonl') })).message).toContain('--access-log');
  });
});
