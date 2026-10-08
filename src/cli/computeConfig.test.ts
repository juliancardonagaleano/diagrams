import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { addComputeOptions, resolveComputeSettings } from './computeConfig';
import { DEFAULT_COMPUTE_QUEUE, DEFAULT_COMPUTE_TIMEOUT_MS, defaultWorkerCount } from './computePool';
import { CliError } from './io';

/** Los ajustes del cálculo de `iark serve`: opción, variable de entorno y valores por omisión. */
describe('resolveComputeSettings', () => {
  it('sin nada indicado: hilos por omisión, 30 s, cola de 16 y el cálculo no es público', () => {
    expect(resolveComputeSettings({}, {})).toEqual({ workers: defaultWorkerCount(), timeoutMs: 30_000, maxQueue: 16, publicCompute: false });
    expect(DEFAULT_COMPUTE_TIMEOUT_MS).toBe(30_000);
    expect(DEFAULT_COMPUTE_QUEUE).toBe(16);
  });

  it('lee las variables de entorno y la opción manda sobre la variable', () => {
    const env = { IARK_WORKERS: '3', IARK_COMPUTE_TIMEOUT_MS: '5000', IARK_COMPUTE_QUEUE: '4', IARK_PUBLIC_COMPUTE: '1' };
    expect(resolveComputeSettings({}, env)).toEqual({ workers: 3, timeoutMs: 5000, maxQueue: 4, publicCompute: true });
    expect(resolveComputeSettings({ workers: '1', computeTimeout: '2s', computeQueue: '0' }, env)).toEqual({ workers: 1, timeoutMs: 2000, maxQueue: 0, publicCompute: true });
    expect(resolveComputeSettings({ publicCompute: true }, {}).publicCompute).toBe(true);
  });

  it('el tiempo acepta milisegundos o el sufijo s, y 0 hilos significa sin hilos', () => {
    for (const [raw, ms] of [['30000', 30000], ['1500ms', 1500], ['30s', 30000], ['0.5s', 500], [' 45 s ', 45000]] as const) expect(resolveComputeSettings({ computeTimeout: raw }, {}).timeoutMs, raw).toBe(ms);
    expect(resolveComputeSettings({ workers: '0' }, {}).workers).toBe(0);
  });

  it('las variables vacías cuentan como no indicadas y IARK_PUBLIC_COMPUTE solo se activa con un valor afirmativo', () => {
    expect(resolveComputeSettings({}, { IARK_WORKERS: '', IARK_COMPUTE_QUEUE: '  ' }).maxQueue).toBe(16);
    for (const [value, expected] of [['1', true], ['true', true], ['YES', true], ['on', true], ['0', false], ['false', false], ['', false], ['no', false]] as const) {
      expect(resolveComputeSettings({}, { IARK_PUBLIC_COMPUTE: value }).publicCompute, value).toBe(expected);
    }
  });

  it('un valor inválido es un error de uso (código 2) que nombra la opción o la variable', () => {
    const fail = (flags: Parameters<typeof resolveComputeSettings>[0], env: NodeJS.ProcessEnv = {}): CliError => {
      try {
        resolveComputeSettings(flags, env);
      } catch (error) {
        expect(error).toBeInstanceOf(CliError);
        return error as CliError;
      }
      throw new Error('debía fallar');
    };
    expect(fail({ workers: 'dos' }).message).toContain('--workers');
    expect(fail({ workers: '-1' }).exitCode).toBe(2);
    expect(fail({ workers: '1000' }).message).toMatch(/entre 0 y 64/);
    expect(fail({ workers: '1.5' }).message).toContain('--workers');
    expect(fail({}, { IARK_WORKERS: 'muchos' }).message).toContain('IARK_WORKERS');
    expect(fail({ computeTimeout: '0' }).message).toContain('--compute-timeout');
    expect(fail({ computeTimeout: 'rápido' }).message).toMatch(/milisegundos/);
    expect(fail({ computeTimeout: '99999h' }).message).toContain('--compute-timeout');
    expect(fail({}, { IARK_COMPUTE_TIMEOUT_MS: '-5' }).message).toContain('IARK_COMPUTE_TIMEOUT_MS');
    expect(fail({ computeQueue: '-1' }).message).toContain('--compute-queue');
    expect(fail({}, { IARK_COMPUTE_QUEUE: 'x' }).message).toContain('IARK_COMPUTE_QUEUE');
  });
});

describe('addComputeOptions', () => {
  it('añade --workers, --compute-timeout, --compute-queue y --public-compute a `serve`', () => {
    const command = addComputeOptions(new Command('serve'));
    command.parse(['--workers', '2', '--compute-timeout', '10s', '--compute-queue', '8', '--public-compute'], { from: 'user' });
    expect(command.opts()).toEqual({ workers: '2', computeTimeout: '10s', computeQueue: '8', publicCompute: true });
    expect(resolveComputeSettings(command.opts(), {})).toEqual({ workers: 2, timeoutMs: 10_000, maxQueue: 8, publicCompute: true });
    const bare = addComputeOptions(new Command('serve'));
    bare.parse([], { from: 'user' });
    expect(bare.opts()).toEqual({});
  });
});
