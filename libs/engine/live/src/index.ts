// @app/live: the engine live hub (M0-33, ADR-005). Carriers (the WebSocket upgrade of
// `@app/transport`, the MessagePort tunnel of M0-34) call `LiveHub.attach` with their transport.
export {
  DEFAULT_MAX_CLIENT_FRAME_BYTES,
  DEFAULT_MAX_CONNECTIONS,
  LiveHub,
  type LiveHubOptions,
  type LiveHubStats,
} from './hub.ts';
export {
  createTicketStore,
  MAX_TICKETS,
  TICKET_TTL_MS,
  type TicketStore,
} from './tickets.ts';
export type { LiveLink, LiveTransport } from './session.ts';
export {
  createTopicRegistry,
  type RegisteredTopic,
  type TopicRegistry,
  type TopicSink,
  type TopicSource,
} from './topic-registry.ts';
