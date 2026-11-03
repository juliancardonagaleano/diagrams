import type { DatabaseConfig } from '../../../cli/postgres/config';
import { DatabaseError, type PostgresDatabase } from '../../../cli/postgres/pool';
import type { ChangeEvent, PublishOptions } from './types';

/** Canal `NOTIFY`/`LISTEN` entre `diagrams-app` (publica) y `diagrams-sse` (escucha). Global por base, no por esquema. */
export const IARK_EVENTS_NOTIFY_CHANNEL = 'iark_project_change';

const MAX_PAYLOAD_BYTES = 7500;

export interface SerializedProjectChange {
  event: ChangeEvent;
  options?: { alsoUsers?: string[] };
}

export function serializeProjectChange(event: ChangeEvent, options: PublishOptions = {}): string {
  const alsoUsers = options.alsoUsers ? [...options.alsoUsers] : undefined;
  const payload: SerializedProjectChange = {
    event,
    ...(alsoUsers?.length ? { options: { alsoUsers } } : {}),
  };
  const text = JSON.stringify(payload);
  if (Buffer.byteLength(text, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new Error('El aviso de cambio es demasiado grande para NOTIFY de Postgres.');
  }
  return text;
}

export function parseProjectChange(payload: string): { event: ChangeEvent; options: PublishOptions } | undefined {
  try {
    const parsed = JSON.parse(payload) as SerializedProjectChange;
    if (!parsed?.event?.type || !parsed.event.project) return undefined;
    const alsoUsers = parsed.options?.alsoUsers;
    return {
      event: parsed.event,
      options: alsoUsers?.length ? { alsoUsers } : {},
    };
  } catch {
    return undefined;
  }
}

/** Publica en el canal transaccional (vale en el pool de Supavisor en modo transacción). */
export async function notifyProjectChange(db: PostgresDatabase, event: ChangeEvent, options: PublishOptions = {}): Promise<void> {
  const payload = serializeProjectChange(event, options);
  try {
    await db.query('select pg_notify($1, $2)', [IARK_EVENTS_NOTIFY_CHANNEL, payload]);
  } catch (error) {
    if (error instanceof DatabaseError) throw error;
    throw new DatabaseError('unavailable', `No se pudo avisar por Postgres NOTIFY: ${(error as Error).message}`, { cause: error });
  }
}

export interface PostgresEventListenerOptions {
  config: DatabaseConfig;
  /** Cadena de sesión directa (sin pooler en modo transacción). Por omisión la misma que el pool; ver README. */
  sessionConnectionString?: string;
  onChange: (event: ChangeEvent, options: PublishOptions) => void;
  onError?: (error: Error) => void;
}

/**
 * Conexión de sesión dedicada para `LISTEN` (al margen del pool transaccional). Una instancia por proceso que reparte avisos al hub.
 */
export class PostgresEventListener {
  private client: import('pg').Client | undefined;
  private connected = false;
  private closing = false;

  constructor(private readonly options: PostgresEventListenerOptions) {}

  get isConnected(): boolean {
    return this.connected;
  }

  async start(): Promise<void> {
    if (this.client) return;
    const { default: pg } = await import('pg');
    const connectionString = this.options.sessionConnectionString ?? this.options.config.connectionString;
    const client = new pg.Client({
      connectionString,
      ssl: this.options.config.ssl,
      connectionTimeoutMillis: 10_000,
      application_name: 'iark-events-listen',
    });
    client.on('error', (error) => {
      this.connected = false;
      if (!this.closing) this.options.onError?.(error);
    });
    client.on('notification', (msg) => {
      if (msg.channel !== IARK_EVENTS_NOTIFY_CHANNEL || !msg.payload) return;
      const parsed = parseProjectChange(msg.payload);
      if (parsed) this.options.onChange(parsed.event, parsed.options);
    });
    await client.connect();
    await client.query(`listen ${IARK_EVENTS_NOTIFY_CHANNEL}`);
    this.client = client;
    this.connected = true;
  }

  /** ¿Sigue viva la conexión de sesión? Es lo que mira `/readyz` del proceso `sse`. */
  async ping(): Promise<boolean> {
    if (!this.client || !this.connected) return false;
    try {
      await this.client.query('select 1');
      return true;
    } catch {
      this.connected = false;
      return false;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    const client = this.client;
    this.client = undefined;
    this.connected = false;
    if (!client) return;
    try {
      await client.query(`unlisten ${IARK_EVENTS_NOTIFY_CHANNEL}`);
    } catch {
      /* la conexión puede estar rota */
    }
    await client.end().catch(() => undefined);
  }
}
