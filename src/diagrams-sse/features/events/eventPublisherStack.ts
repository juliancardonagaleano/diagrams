import type { PostgresDatabase } from '../../../cli/postgres/pool';
import { EventHub, type EventHubOptions } from './eventHub';
import { notifyProjectChange, PostgresEventListener } from './postgresBridge';
import type { ChangeEvent, EventPublisher, PublishOptions } from './types';

export type EventsBridgeMode = 'memory' | 'postgres';

export interface EventPublisherStackOptions {
  hub?: EventHubOptions & { accounts?: EventHubOptions['accounts'] };
  /** Publicar avisos (memoria local y, con Postgres, NOTIFY). */
  publish?: boolean;
  /** Escuchar NOTIFY y reenviar al hub (proceso `sse` o suite con base Postgres). */
  listen?: boolean;
  postgres?: PostgresDatabase;
}

export interface EventPublisherStack {
  hub: EventHub | undefined;
  publisher: EventPublisher | undefined;
  listener: PostgresEventListener | undefined;
  close: () => Promise<void>;
}

class BridgePublisher implements EventPublisher {
  constructor(
    private readonly hub: EventHub | undefined,
    private readonly postgres: PostgresDatabase | undefined,
    /** Con LISTEN activo en el mismo proceso, el hub solo recibe por NOTIFY (evita duplicar avisos). */
    private readonly notifyOnlyToHub: boolean,
  ) {}

  async publish(event: ChangeEvent, options: PublishOptions = {}): Promise<void> {
    if (this.postgres) {
      await notifyProjectChange(this.postgres, event, options);
      if (!this.notifyOnlyToHub) await this.hub?.publish(event, options);
      return;
    }
    await this.hub?.publish(event, options);
  }
}

/** Arma hub in-process, NOTIFY al guardar y/o LISTEN hacia el hub según el modo (spec 005). */
export async function createEventPublisherStack(options: EventPublisherStackOptions): Promise<EventPublisherStack> {
  const hub = options.hub ? new EventHub(options.hub) : undefined;
  const postgres = options.postgres;
  const publish = options.publish !== false;
  const listen = options.listen === true && !!postgres;

  let listener: PostgresEventListener | undefined;
  if (listen && hub) {
    const config = postgres!.config;
    const sessionConnectionString = process.env.IARK_DATABASE_SESSION_URL?.trim() || undefined;
    listener = new PostgresEventListener({
      config,
      sessionConnectionString,
      onChange: (event, opts) => void hub.publish(event, opts),
      onError: (error) => process.stderr.write(`postgres listen: ${error.message}\n`),
    });
    await listener.start();
  }

  const notifyOnlyToHub = Boolean(listen && hub && postgres);
  const publisher: EventPublisher | undefined =
    publish && (hub || postgres) ? new BridgePublisher(hub, postgres, notifyOnlyToHub) : hub;

  return {
    hub,
    publisher,
    listener,
    async close() {
      hub?.closeAll();
      await listener?.close();
    },
  };
}

/** Modo del puente según entorno y si los proyectos viven en Postgres. */
export function resolveEventsBridgeMode(projectsKind: string | undefined, env: NodeJS.ProcessEnv = process.env): EventsBridgeMode {
  const raw = (env.IARK_EVENTS_BRIDGE ?? '').trim().toLowerCase();
  if (raw === 'memory' || raw === 'off' || raw === '0' || raw === 'false') return 'memory';
  if (raw === 'postgres' || raw === 'notify') return 'postgres';
  return projectsKind === 'postgres' ? 'postgres' : 'memory';
}

/** ¿Este proceso solo publica NOTIFY (app partida) sin atender SSE? */
export function eventsPublishOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  const role = (env.IARK_EVENTS_ROLE ?? '').trim().toLowerCase();
  return role === 'publish' || role === 'app';
}

/** ¿Este proceso solo atiende SSE (sin API de proyectos)? */
export function eventsStreamOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  const role = (env.IARK_EVENTS_ROLE ?? '').trim().toLowerCase();
  return role === 'stream' || role === 'sse';
}
