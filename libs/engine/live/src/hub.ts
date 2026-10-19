// The live hub (blueprint 3.5, ADR-005): one credit-based session per UI, identical on the
// WebSocket and on the MessagePort. The transports (M0-33 here, M0-34 for the port) call `attach`
// with their own `LiveTransport` and forward what they read to the returned `LiveLink`.
//
// The hub owns what must outlive a transport: the sessions, the 30 s resume window and the topic
// sources. It is bounded everywhere (I-6): connections, parked sessions, every outbox (by the
// session), and the bytes a slow peer may leave unread.
import {
  createIdGenerator,
  systemClock,
  systemTimers,
  type Clock,
  type IdGenerator,
  type Timers,
} from '@app/kernel';
import {
  DEFAULT_MAX_PARKED,
  DEFAULT_SESSION_LIMITS,
  RESUME_WINDOW_MS,
  ResumeRegistry,
  type LiveSession,
  type SessionLimits,
} from '@app/live-protocol';
import type { Principal } from '@app/ports';

import {
  HubSession,
  LiveConnection,
  type HubDeps,
  type LiveLink,
  type LiveTransport,
  type SessionHost,
} from './session.ts';
import type { TopicRegistry } from './topic-registry.ts';

export const DEFAULT_MAX_CONNECTIONS = 64;
export const DEFAULT_MAX_CLIENT_FRAME_BYTES = 64 * 1024;

export interface LiveHubOptions {
  readonly engineVersion: string;
  readonly topics: TopicRegistry;
  /** Whether the principal may subscribe to a topic that needs `permission`. */
  readonly canSubscribe: HubDeps['canSubscribe'];
  readonly clock?: Clock;
  readonly timers?: Timers;
  readonly ids?: IdGenerator;
  readonly limits?: Partial<SessionLimits>;
  readonly maxConnections?: number;
  readonly maxParked?: number;
  readonly resumeWindowMs?: number;
  readonly maxClientFrameBytes?: number;
  readonly validateItems?: boolean;
}

export interface LiveHubStats {
  readonly connections: number;
  readonly sessions: number;
  readonly parked: number;
  /** Connections refused because the hub was full. */
  readonly refused: number;
}

export class LiveHub implements SessionHost {
  readonly deps: HubDeps;
  readonly registry: ResumeRegistry<LiveSession>;
  readonly sessions = new Map<string, HubSession>();
  readonly #connections = new Set<LiveConnection>();
  readonly #maxConnections: number;
  readonly #windowMs: number;
  #refused = 0;

  constructor(options: LiveHubOptions) {
    const ids = options.ids ?? createIdGenerator();
    const limits = { ...DEFAULT_SESSION_LIMITS, ...options.limits };
    this.#maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.#windowMs = options.resumeWindowMs ?? RESUME_WINDOW_MS;
    this.deps = {
      engineVersion: options.engineVersion,
      topics: options.topics,
      canSubscribe: options.canSubscribe,
      clock: options.clock ?? systemClock,
      timers: options.timers ?? systemTimers,
      limits,
      maxBufferedBytes: limits.outboxBytes,
      maxClientFrameBytes:
        options.maxClientFrameBytes ?? DEFAULT_MAX_CLIENT_FRAME_BYTES,
      validateItems: options.validateItems ?? false,
      newSessionId: () => ids.uuid(),
    };
    this.registry = new ResumeRegistry<LiveSession>({
      windowMs: this.#windowMs,
      maxParked: options.maxParked ?? DEFAULT_MAX_PARKED,
      // A parked session nobody claimed stops its sources (the registry forgets it itself).
      onDrop: (id) => {
        this.#release(id);
      },
    });
  }

  get stats(): LiveHubStats {
    return {
      connections: this.#connections.size,
      sessions: this.sessions.size,
      parked: this.registry.size,
      refused: this.#refused,
    };
  }

  /**
   * Binds a transport to the hub for `principal` (already authenticated by the carrier). The
   * client's first frame must be `hello`. Returns undefined, after closing the transport, when
   * the hub is full.
   */
  attach(transport: LiveTransport, principal: Principal): LiveLink | undefined {
    if (this.#connections.size >= this.#maxConnections) {
      this.#refused += 1;
      transport.close(1013, 'too many live connections');
      return undefined;
    }
    const connection = new LiveConnection(this, transport, principal);
    this.#connections.add(connection);
    const link: LiveLink = {
      receive: (text) => {
        connection.receive(text);
      },
      closed: () => {
        connection.closed();
        this.#connections.delete(connection);
      },
    };
    return link;
  }

  /** Tells every client to reconnect elsewhere (engine drain) and closes the connections. */
  drain(reconnectAfterMs?: number): void {
    for (const connection of this.#connections) {
      connection.goaway('drain', reconnectAfterMs);
    }
    this.#connections.clear();
  }

  /** Stops every source and forgets every session. */
  close(): void {
    this.drain();
    for (const session of [...this.sessions.values()]) this.drop(session);
  }

  adopt(session: HubSession): void {
    this.sessions.set(session.live.id, session);
  }

  park(session: HubSession): void {
    session.live.park(this.registry, this.deps.clock.monotonic());
    // The registry only forgets an expired session when it is touched; make sure it is.
    this.deps.timers.setTimer(() => {
      this.registry.sweep(this.deps.clock.monotonic());
    }, this.#windowMs + 1);
  }

  drop(session: HubSession): void {
    this.sessions.delete(session.live.id);
    session.close();
  }

  #release(id: string): void {
    const session = this.sessions.get(id);
    if (session !== undefined) this.drop(session);
  }
}
