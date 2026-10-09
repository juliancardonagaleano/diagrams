import type { Actor, AuditChange, AuditTarget } from '../../src/cli/observability/audit';
import type { LogSink, SinkStats } from '../../src/cli/observability/sink';

/** Una fila de auditoría tal como sale en el registro. */
export interface AuditRow {
  ts: string;
  type: 'audit';
  requestId: string;
  action: string;
  result: 'ok' | 'denied' | 'error';
  status: number;
  code?: string;
  actor: Actor;
  target?: AuditTarget;
  change?: AuditChange;
}

/** Una línea del registro de accesos tal como sale. */
export interface AccessRow {
  ts: string;
  type: 'access';
  requestId: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  bytes: number;
  remote: string;
  actor?: Actor;
  /** Solo un canal que se queda abierto (los cambios en tiempo real): que lo fue y cuántos avisos se enviaron. */
  stream?: true;
  events?: number;
  aborted?: true;
}

/** Un destino de registro en memoria, para las pruebas: guarda las líneas tal como las recibe (sin el salto final). */
export interface MemorySink extends LogSink {
  lines: string[];
  /** Todas las líneas que llegaron desde el principio (`take` no las borra de aquí): para comprobar que nada sensible se escribió nunca. */
  history: string[];
  /** Cada línea ya interpretada como JSON (falla si alguna no lo es: una línea rota es un fallo). */
  records<T = Record<string, unknown>>(): T[];
  /** Lo escrito desde la última vez, y lo vacía. */
  take<T = Record<string, unknown>>(): T[];
}

export function memorySink(): MemorySink {
  const stats: SinkStats = { written: 0, dropped: 0, errors: 0 };
  const sink: MemorySink = {
    lines: [],
    history: [],
    stats,
    target: 'memoria',
    write(line) {
      sink.lines.push(line);
      sink.history.push(line);
      stats.written += 1;
    },
    reopen() {},
    async close() {},
    records: <T>() => sink.lines.map((line) => JSON.parse(line) as T),
    take<T>() {
      const records = sink.records<T>();
      sink.lines.length = 0;
      return records;
    },
  };
  return sink;
}
