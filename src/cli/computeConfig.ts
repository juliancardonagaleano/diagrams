import type { Command } from 'commander';
import { DEFAULT_COMPUTE_QUEUE, DEFAULT_COMPUTE_TIMEOUT_MS, defaultWorkerCount } from './computePool';
import { CliError } from './io';

/**
 * Los ajustes del cálculo de `iark serve` (hilos de trabajo, tiempo límite, cola y acceso público), por opción o por variable de
 * entorno; la opción manda. Se validan aquí, con un mensaje de uso claro, y no en el pool: un `IARK_WORKERS=dos` no debe arrancar
 * el servicio con un valor cualquiera.
 */

export interface ComputeSettings {
  /** Hilos de trabajo; 0 = sin hilos (el cálculo corre en el hilo principal, sin tiempo límite ni cola: solo para depurar). */
  workers: number;
  timeoutMs: number;
  maxQueue: number;
  /** Las rutas de cálculo siguen abiertas aunque haya tokens o cuentas. */
  publicCompute: boolean;
}

export interface ComputeFlags {
  workers?: string;
  computeTimeout?: string;
  computeQueue?: string;
  publicCompute?: boolean;
}

const MAX_WORKERS = 64;
const MAX_QUEUE = 10_000;
const MAX_TIMEOUT_MS = 60 * 60_000;

/** Añade a `iark serve` las opciones del cálculo. Sin valor por omisión en la opción: lo resuelve `resolveComputeSettings` (opción, luego variable, luego lo de siempre). */
export function addComputeOptions(command: Command): Command {
  return command
    .option('--workers <n>', `hilos de trabajo que calculan las exportaciones, importaciones, informes y trazas fuera del hilo que atiende las conexiones (o IARK_WORKERS); por omisión min(2, CPU − 1), al menos 1. 0 = en el hilo principal, sin tiempo límite ni cola (solo para depurar)`)
    .option('--compute-timeout <tiempo>', `tiempo máximo de cada operación de cálculo, en milisegundos o con sufijo s («30s») (o IARK_COMPUTE_TIMEOUT_MS); al agotarse se cancela y responde 503. Por omisión ${DEFAULT_COMPUTE_TIMEOUT_MS / 1000} s`)
    .option('--compute-queue <n>', `operaciones que esperan un hilo libre (o IARK_COMPUTE_QUEUE); con la cola llena, 503 con Retry-After. Por omisión ${DEFAULT_COMPUTE_QUEUE}`)
    .option('--public-compute', 'con --tokens o --accounts, deja abiertas las rutas de cálculo (validar, vistas, exportar, importar, comparar, informes y /api/trace) en vez de exigir una credencial (o IARK_PUBLIC_COMPUTE=1)');
}

const TRUE = /^(1|true|yes|on)$/i;

function integer(name: string, raw: string, min: number, max: number): number {
  const value = Number(raw.trim());
  if (raw.trim() === '' || !Number.isInteger(value) || value < min || value > max) throw new CliError(`${name} debe ser un entero entre ${min} y ${max} (recibido «${raw}»).`, 2);
  return value;
}

/** `30000` o `30000ms` → 30000; `30s` → 30000. */
function duration(name: string, raw: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s)?$/i.exec(raw.trim());
  const ms = match ? Number(match[1]) * (match[2]?.toLowerCase() === 's' ? 1000 : 1) : NaN;
  if (!Number.isFinite(ms) || ms < 1 || ms > MAX_TIMEOUT_MS) throw new CliError(`${name} debe ser un tiempo en milisegundos (o con sufijo s, «30s») entre 1 ms y 1 hora (recibido «${raw}»).`, 2);
  return Math.round(ms);
}

export function resolveComputeSettings(flags: ComputeFlags, env: NodeJS.ProcessEnv = process.env): ComputeSettings {
  const workers = flags.workers ?? env.IARK_WORKERS;
  const timeout = flags.computeTimeout ?? env.IARK_COMPUTE_TIMEOUT_MS;
  const queue = flags.computeQueue ?? env.IARK_COMPUTE_QUEUE;
  const nonEmpty = (value: string | undefined): value is string => value !== undefined && value.trim() !== '';
  return {
    workers: nonEmpty(workers) ? integer(flags.workers === undefined ? 'IARK_WORKERS' : '--workers', workers, 0, MAX_WORKERS) : defaultWorkerCount(),
    timeoutMs: nonEmpty(timeout) ? duration(flags.computeTimeout === undefined ? 'IARK_COMPUTE_TIMEOUT_MS' : '--compute-timeout', timeout) : DEFAULT_COMPUTE_TIMEOUT_MS,
    maxQueue: nonEmpty(queue) ? integer(flags.computeQueue === undefined ? 'IARK_COMPUTE_QUEUE' : '--compute-queue', queue, 0, MAX_QUEUE) : DEFAULT_COMPUTE_QUEUE,
    publicCompute: flags.publicCompute === true || TRUE.test(env.IARK_PUBLIC_COMPUTE ?? ''),
  };
}
