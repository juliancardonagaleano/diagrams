/**
 * Compatibilidad de imports históricos: el canal SSE vive en `src/diagrams-sse/`.
 */
export {
  createEventsApi,
  createEventsHost,
  EventHub,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_MAX_STREAMS_PER_PERSON,
  type ChangeEvent,
  type ChangeType,
  type EventHubOptions,
  type EventPublisher,
  type EventsApiContext,
  type EventStats,
  type PublishOptions,
  type StreamSummary,
} from '../diagrams-sse';
