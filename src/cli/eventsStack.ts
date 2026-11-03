import type { Accounts } from '../diagrams-identity/core/accounts/service';
import { CliError } from './io';
import type { PostgresProjectStore } from './postgresProjects';
import {
  createEventPublisherStack,
  eventsPublishOnly,
  eventsStreamOnly,
  resolveEventsBridgeMode,
  type EventHubOptions,
  type EventPublisherStack,
} from '../diagrams-sse';
import type { ProjectStore } from '@iark/kernel';

export async function openEventsStack(options: {
  projects: ProjectStore | undefined;
  accounts: Accounts | undefined;
  events: false | Pick<EventHubOptions, 'maxPerPerson' | 'maxTotal' | 'heartbeatMs' | 'maxBufferedBytes'>;
}): Promise<EventPublisherStack | undefined> {
  if (!options.projects || options.events === false) return undefined;
  const publishOnly = eventsPublishOnly();
  const streamOnly = eventsStreamOnly();
  if (publishOnly && streamOnly) {
    throw new CliError('IARK_EVENTS_ROLE no puede ser publish y stream a la vez.', 2);
  }
  const bridge = resolveEventsBridgeMode(options.projects.kind);
  const postgres = bridge === 'postgres' ? (options.projects as PostgresProjectStore).postgres() : undefined;
  const hubOptions = { accounts: options.accounts, ...options.events };
  return createEventPublisherStack({
    hub: streamOnly || !publishOnly ? hubOptions : undefined,
    publish: !streamOnly,
    listen: bridge === 'postgres' && !publishOnly,
    postgres,
  });
}
