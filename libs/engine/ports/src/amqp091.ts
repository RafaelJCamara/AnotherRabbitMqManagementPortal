// AMQP 0-9-1 role-typed leases (ADR-009, DC-11/DC-12). A lease exposes only the methods of its
// role, so "a peek never publishes", "a publisher never consumes" and "nothing is acked without a
// proof" are properties of the types, not of discipline.
import type {
  AckProof,
  ConfirmedCopyProof,
  SafeReturnProof,
} from './proofs.ts';

/** A header value with its AMQP type kept, so a decoder can tell a long from an int. */
export type TypedHeaderValue =
  | {
      t:
        | 'string'
        | 'long'
        | 'int'
        | 'short'
        | 'byte'
        | 'double'
        | 'float'
        | 'bool'
        | 'timestamp'
        | 'decimal'
        | 'bytes'
        | 'void';
      v: unknown;
    }
  | { t: 'array'; v: TypedHeaderValue[] }
  | { t: 'table'; v: Record<string, TypedHeaderValue> };

export interface Delivery {
  tag: bigint;
  redelivered: boolean;
  exchange: string;
  routingKey: string;
  properties: Record<string, unknown>;
  headers: Readonly<Record<string, TypedHeaderValue>>;
  body: Uint8Array;
}

export type PublishOutcome =
  | { outcome: 'confirmed'; proof: ConfirmedCopyProof }
  | {
      outcome: 'nacked' | 'returned' | 'blocked' | 'timeout';
      reason?: string;
    };

/** A queue's counts as the broker reports them on a passive declare. */
export interface QueueCounts {
  messageCount: number;
  consumerCount: number;
}

/** The only operations a throwaway channel offers (it never changes anything). */
export interface ThrowawayChannel {
  checkQueue(name: string): Promise<QueueCounts>;
}

/**
 * Role `peek`: one job per connection, never publishes. `get` uses `noAck=false`; the adapter
 * asserts that the queue is not a stream.
 */
export interface PeekLease {
  get(queue: string): Promise<Delivery | null>;
  /** Returns everything up to the tag to its queue. `requeue` is only ever the literal `true`. */
  nackRequeue(
    upToTag: bigint,
    options: { multiple: true; requeue: true },
  ): void;
  /** A synchronous `basic.qos` round trip: proof that the nack was processed (DC-04). */
  qosBarrier(prefetch: number): Promise<void>;
  ackWithProof(tag: bigint, proof: AckProof): void;
  throwaway<T>(fn: (channel: ThrowawayChannel) => Promise<T>): Promise<T>;
  /** Closes lazily after the barrier. A `poisoned` lease is closed at once and never reused. */
  release(state: 'healthy' | 'poisoned'): Promise<void>;
}

/** Role `source`: the consumers of replay and move jobs. */
export interface SourceLease {
  consume(
    queue: string,
    prefetch: number,
    onDelivery: (delivery: Delivery | null) => void,
  ): Promise<{ consumerTag: string }>;
  ackWithProof(tag: bigint, proof: AckProof): void;
  /** Without a `SafeReturnProof` it cannot be written for a quorum source with a finite limit. */
  nackRequeue(tag: bigint, proof: SafeReturnProof): void;
  qosBarrier(prefetch: number): Promise<void>;
  cancel(consumerTag: string): Promise<void>;
  release(state: 'healthy' | 'poisoned'): Promise<void>;
}

/** Role `publish`: confirm channels only. The one place a ConfirmedCopyProof is minted. */
export interface PublishLease {
  publish(
    exchange: string,
    routingKey: string,
    body: Uint8Array,
    props: Record<string, unknown>,
    options: { mandatory: true; timeoutMs: number },
  ): Promise<PublishOutcome>;
  readonly blocked: () => boolean;
  release(): Promise<void>;
}

export interface TapQueueSpec {
  name: `${string}.tap.${string}`;
  exclusive: true;
  autoDelete: true;
  durable: false;
  args: {
    'x-queue-type': 'classic';
    'x-max-length': number;
    'x-overflow': 'drop-head';
    'x-message-ttl': number;
    'x-expires': number;
    [session: `x-${string}-session`]: string;
  };
}

/** Role `observe`: taps and streams. Acks tap copies only; it never settles a user's message. */
export interface ObserveLease {
  declareTapQueue(spec: TapQueueSpec): Promise<void>;
  bindQueue(
    queue: string,
    source: string,
    key: string,
    args: Record<string, unknown>,
  ): Promise<void>;
  unbindQueue(
    queue: string,
    source: string,
    key: string,
    args: Record<string, unknown>,
  ): Promise<void>;
  consume(
    queue: string,
    prefetch: number,
    onDelivery: (delivery: Delivery | null) => void,
  ): Promise<{ consumerTag: string }>;
  ackTap(tag: bigint, multiple: boolean): void;
  release(): Promise<void>;
}
