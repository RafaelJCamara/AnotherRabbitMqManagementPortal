// An in-memory Amqp091Connector for specs (and for the specs of the services that take leases).
// Every open makes one fake connection; releasing its lease closes it and reports `closed`, as the
// adapter does. It touches no socket.
import type {
  Amqp091Connector,
  ConnectorEvent,
  ConnectorRequest,
  ConnectionRole,
  ObserveLease,
  OpenedConnection,
  PeekLease,
  PublishLease,
  SourceLease,
} from '@app/ports';

export interface FakeConnection {
  readonly role: ConnectionRole;
  readonly request: ConnectorRequest;
  /** The name the adapter would have sent: `<product>/<mode>/<role>/<session>`. */
  readonly connectionName: string;
  readonly closed: boolean;
  /** The release calls this connection received, in order. */
  readonly releases: readonly string[];
  /** Ends the connection as if the broker had closed it. */
  breakConnection(): void;
  /** While true, releasing the lease fails and the connection stays open. */
  refuseRelease: boolean;
}

export interface FakeConnector extends Amqp091Connector {
  /** Every connection opened so far. */
  readonly opened: readonly FakeConnection[];
  /** The next open fails with this error. */
  failNext(error: Error): void;
  /** Opens wait until `resume()`; the connection exists only after that. */
  pauseOpens(): void;
  resume(): void;
}

class Fake implements FakeConnection {
  closed = false;
  readonly releases: string[] = [];
  readonly #listeners = new Set<(event: ConnectorEvent) => void>();

  readonly role: ConnectionRole;
  readonly request: ConnectorRequest;

  // No parameter properties: the testkit compiles this file with erasableSyntaxOnly (M0-44).
  constructor(role: ConnectionRole, request: ConnectorRequest) {
    this.role = role;
    this.request = request;
  }

  get connectionName(): string {
    const { product, mode, session } = this.request.name;
    return `${product}/${mode}/${this.role}/${session}`;
  }

  subscribe(listener: (event: ConnectorEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of [...this.#listeners]) listener({ type: 'closed' });
  }

  breakConnection(): void {
    this.close();
  }

  release(label: string): Promise<void> {
    this.releases.push(label);
    if (this.refuseRelease) {
      // As a source does while it still holds deliveries: the lease stays open and usable.
      return Promise.reject(new Error('deliveries are still held'));
    }
    this.close();
    return Promise.resolve();
  }

  refuseRelease = false;
}

export function createFakeConnector(): FakeConnector {
  const opened: Fake[] = [];
  let failure: Error | undefined;
  let gate: Promise<void> | undefined;
  let open: (() => void) | undefined;

  const make = async <L>(
    role: ConnectionRole,
    request: ConnectorRequest,
    lease: (fake: Fake) => L,
  ): Promise<OpenedConnection<L>> => {
    if (gate !== undefined) await gate;
    if (failure !== undefined) {
      const error = failure;
      failure = undefined;
      throw error;
    }
    const fake = new Fake(role, request);
    opened.push(fake);
    return {
      lease: lease(fake),
      info: { connectionName: fake.connectionName },
      subscribe: (listener) => fake.subscribe(listener),
    };
  };

  return {
    opened,
    failNext(error) {
      failure = error;
    },
    pauseOpens() {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    resume() {
      gate = undefined;
      open?.();
      open = undefined;
    },
    openPeek: (request) =>
      make<PeekLease>('peek', request, (fake) => ({
        get: () => Promise.resolve(null),
        nackRequeue: () => undefined,
        qosBarrier: () => Promise.resolve(),
        ackWithProof: () => undefined,
        throwaway: (fn) =>
          fn({
            checkQueue: () =>
              Promise.resolve({ messageCount: 0, consumerCount: 0 }),
          }),
        release: (state) => fake.release(`peek:${state}`),
      })),
    openSource: (request) =>
      make<SourceLease>('source', request, (fake) => ({
        consume: () => Promise.resolve({ consumerTag: 'fake' }),
        ackWithProof: () => undefined,
        nackRequeue: () => undefined,
        qosBarrier: () => Promise.resolve(),
        cancel: () => Promise.resolve(),
        release: (state) => fake.release(`source:${state}`),
      })),
    openPublish: (request) =>
      make<PublishLease>('publish', request, (fake) => ({
        publish: () => Promise.resolve({ outcome: 'timeout' }),
        blocked: () => false,
        release: () => fake.release('publish'),
      })),
    openObserve: (request) =>
      make<ObserveLease>('observe', request, (fake) => ({
        declareTapQueue: () => Promise.resolve(),
        bindQueue: () => Promise.resolve(),
        unbindQueue: () => Promise.resolve(),
        consume: () => Promise.resolve({ consumerTag: 'fake' }),
        ackTap: () => undefined,
        release: () => fake.release('observe'),
      })),
  };
}
