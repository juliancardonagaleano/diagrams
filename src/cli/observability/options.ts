import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { CliError } from '../io';
import { isLoopbackHost } from '../serveAuth';
import { Observability } from './index';
import { openLogSink, type LogSink } from './sink';

/**
 * Las opciones de observabilidad de `iark serve`, por opción o por variable de entorno (la opción manda), comprobadas y convertidas en un
 * `Observability`. Todo está **apagado por omisión**: sin ninguna de estas opciones el servicio no escribe ningún registro ni sirve métricas
 * (solo pone `X-Request-Id` y atiende `/healthz` y `/readyz`). Los errores de uso salen con código 2 antes de abrir el puerto.
 *
 *   --access-log <archivo|->   IARK_ACCESS_LOG        registro de accesos, JSON por línea (`-` = salida estándar)
 *   --audit-log <archivo|->    IARK_AUDIT_LOG         auditoría de cambios, JSON por línea, solo se añade (archivo 0600)
 *   --metrics                  IARK_METRICS=1         sirve `GET /metrics` (formato Prometheus)
 *   --metrics-token <token>    IARK_METRICS_TOKEN     token Bearer de `/metrics`; o el contenido del archivo de IARK_METRICS_TOKEN_FILE
 *
 * El token de métricas, como el secreto de la OAuth App, es mejor por entorno o por archivo que por la línea de comandos (esta se ve en la lista
 * de procesos y en el historial del intérprete).
 */

export interface ObservabilityFlags {
  accessLog?: string;
  auditLog?: string;
  metrics?: boolean;
  metricsToken?: string;
}

const TRUE = /^(1|true|yes|on)$/i;

export function addObservabilityOptions(command: Command, env: NodeJS.ProcessEnv = process.env): Command {
  return command
    .option('--access-log <archivo|->', 'registro de accesos en JSON por línea (fecha, método, plantilla de ruta sin identificadores ni query string, estado, duración, bytes, dirección, quién y X-Request-Id); «-» es la salida estándar; apagado por omisión (o IARK_ACCESS_LOG)', env.IARK_ACCESS_LOG || undefined)
    .option('--audit-log <archivo|->', 'auditoría de cambios en JSON por línea: quién hizo qué sobre qué y con qué resultado, también lo denegado; solo se añade y el archivo es 0600; apagado por omisión (o IARK_AUDIT_LOG)', env.IARK_AUDIT_LOG || undefined)
    .option('--metrics', 'sirve las métricas de Prometheus en GET /metrics: con --metrics-token o, sin él, solo a conexiones locales (fuera de loopback exige token) (o IARK_METRICS=1)', TRUE.test(env.IARK_METRICS ?? ''))
    .option('--metrics-token <token>', 'token Bearer que protege /metrics, de al menos 16 caracteres (o IARK_METRICS_TOKEN, o el archivo de IARK_METRICS_TOKEN_FILE; mejor esas dos que la línea de comandos, que se ve en la lista de procesos)', env.IARK_METRICS_TOKEN || undefined);
}

export interface ObservabilitySetup {
  observability: Observability;
  /** El token Bearer de `/metrics`, si lo hay (para `createSuiteServer`). */
  metricsToken?: string;
  /** Las líneas que anuncia el arranque (sin el token). */
  lines: string[];
}

const TOKEN = /^[\x21-\x7e]{16,256}$/;

/** El token de métricas: la opción (que ya trae `IARK_METRICS_TOKEN` como valor por omisión) o el contenido del archivo de `IARK_METRICS_TOKEN_FILE`. */
function metricsTokenOf(flags: ObservabilityFlags, env: NodeJS.ProcessEnv): string | undefined {
  const direct = flags.metricsToken?.trim();
  if (direct) return direct;
  const file = env.IARK_METRICS_TOKEN_FILE?.trim();
  if (!file) return undefined;
  let text: string;
  try {
    text = readFileSync(file, 'utf8').trim();
  } catch (error) {
    throw new CliError(`No se pudo leer el token de métricas de «${file}» (${(error as NodeJS.ErrnoException).code ?? 'error'}).`, 2);
  }
  if (!text) throw new CliError(`El archivo del token de métricas «${file}» está vacío.`, 2);
  return text;
}

function open(target: string | undefined, kind: 'access' | 'audit', flag: string): LogSink | undefined {
  const where = target?.trim();
  if (!where) return undefined;
  try {
    return openLogSink(where, kind);
  } catch (error) {
    throw new CliError(`No se pudo abrir el archivo de ${flag} «${where}» (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}).`, 2);
  }
}

export function setupObservability(flags: ObservabilityFlags, context: { host: string; trustProxy: boolean; version: string; env?: NodeJS.ProcessEnv }): ObservabilitySetup {
  const env = context.env ?? process.env;
  const access = flags.accessLog?.trim() || undefined;
  const audit = flags.auditLog?.trim() || undefined;
  if (access && audit && access !== '-' && resolve(access) === resolve(audit)) {
    throw new CliError('--access-log y --audit-log no pueden ser el mismo archivo: la auditoría solo se añade y se conserva, los accesos se rotan.', 2);
  }
  const token = metricsTokenOf(flags, env);
  const lines: string[] = [];
  if (flags.metrics) {
    if (token !== undefined && !TOKEN.test(token)) throw new CliError('El token de métricas debe tener entre 16 y 256 caracteres imprimibles, sin espacios (por ejemplo `openssl rand -hex 32`).', 2);
    if (token === undefined && !isLoopbackHost(context.host)) {
      throw new CliError(
        `Las métricas sin token solo valen en loopback, y el servicio escucha en ${context.host}: quien llegue a ese puerto las leería. ` +
          'Ponga un token con --metrics-token (o IARK_METRICS_TOKEN, o IARK_METRICS_TOKEN_FILE) o escuche solo en loopback con --host 127.0.0.1.',
        2,
      );
    }
    if (token === undefined && context.trustProxy) {
      throw new CliError('Con --trust-proxy hay un proxy delante, y un proxy en la misma máquina publicaría /metrics con una conexión de loopback: ponga un token con --metrics-token (o IARK_METRICS_TOKEN).', 2);
    }
  } else if (token !== undefined) {
    lines.push('aviso: hay un token de métricas pero falta --metrics (o IARK_METRICS=1): /metrics sigue apagado.');
  }

  const accessSink = open(access, 'access', '--access-log');
  const auditSink = open(audit, 'audit', '--audit-log');
  const observability = new Observability({ accessSink, auditSink, metrics: !!flags.metrics, version: context.version });

  if (accessSink) lines.push(`  registro de accesos: ${accessSink.target} (JSON por línea; sin query string, cuerpos ni credenciales)`);
  if (auditSink) lines.push(`  auditoría: ${auditSink.target} (JSON por línea, solo se añade${auditSink.target === 'stdout' ? '' : '; modo 0600'})`);
  if (flags.metrics) lines.push(`  métricas: /metrics ${token === undefined ? '(sin token: solo conexiones locales)' : '(con token Bearer)'}`);
  lines.push('  salud: /healthz (vivo) · /readyz (listo)');
  return { observability, ...(flags.metrics && token !== undefined ? { metricsToken: token } : {}), lines };
}
