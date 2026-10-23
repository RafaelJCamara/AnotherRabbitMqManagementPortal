// The input and output types of the death-history normaliser (DLQ-02). The input is what a client
// sees (no body, so no payload can reach the output); the output is one model for both protocols.

export type DeathProtocol = 'amqp091' | 'amqp10';

/** Where the death records came from: the 0-9-1 header or the 1.0 message annotation. */
export type DeathSource = 'x-death' | 'x-opt-deaths';

/**
 * The death headers of a message as a client sees them. Values may be plain JavaScript (amqplib: a
 * timestamp is `{ '!': 'timestamp', value }`), the engine's typed form (`{ t, v }`, the shape of
 * `Delivery.headers`) or `Map`s; `unknown` because none of it is trusted.
 */
export type DeathMessage =
  | {
      readonly protocol: 'amqp091';
      /** The header table of the message properties. */
      readonly headers?: unknown;
      /** True when the caller knows a client published this message (a replay, a republish). */
      readonly clientPublished?: boolean;
    }
  | {
      readonly protocol: 'amqp10';
      /** The message annotations (`x-opt-deaths`, `x-first-death-*`, `x-last-death-*`). */
      readonly messageAnnotations?: unknown;
      /** The application properties (a replay stamp is one). */
      readonly applicationProperties?: unknown;
      /** The header section (`delivery-count`). */
      readonly header?: unknown;
      readonly clientPublished?: boolean;
    };

/** The reasons the broker records (rejected, expired, maxlen, delivery_limit). */
export const DEATH_REASONS = [
  'rejected',
  'expired',
  'maxlen',
  'delivery_limit',
] as const;
export type DeathReason = (typeof DEATH_REASONS)[number];

/** What is wrong with one record. A field that is wrong is null, never guessed. */
export type EntryFlag =
  | 'not-a-table'
  | 'queue-missing'
  | 'reason-missing'
  | 'reason-unknown'
  | 'count-invalid'
  | 'exchange-missing'
  | 'routing-keys-invalid'
  | 'routing-keys-truncated'
  | 'time-invalid'
  | 'last-time-invalid'
  | 'last-time-unavailable'
  | 'ttl-invalid'
  | 'text-truncated';

/** One death record, the same shape for both protocols. Times are epoch milliseconds. */
export interface DeathEntry {
  /** The position of the record in the array the client sent (before any reordering). */
  readonly index: number;
  readonly queue: string | null;
  /** The reason when it is one the broker is known to record; null otherwise. */
  readonly reason: DeathReason | null;
  /** The reason as sent, when it is not a known one (a newer broker); null otherwise. */
  readonly reasonText: string | null;
  /** How many times the message died in this queue for this reason. */
  readonly count: number | null;
  /** The exchange the message was published to before its first death in this queue. */
  readonly exchange: string | null;
  readonly routingKeys: readonly string[];
  readonly firstTimeMs: number | null;
  /** 1.0 sends it; 0-9-1 does not, so it is known there only for a count of 1. */
  readonly lastTimeMs: number | null;
  /** The per-message TTL the message had (0-9-1 `original-expiration`, 1.0 `ttl`), in ms. */
  readonly originalTtlMs: number | null;
  readonly flags: readonly EntryFlag[];
}

/** What is wrong with the history as a whole. */
export type HistoryFlag =
  | 'read-error'
  | 'death-field-wrong-type'
  | 'foreign-form'
  | 'both-forms-present'
  | 'reordered'
  | 'truncated'
  | 'client-stripped'
  | 'first-death-header-missing'
  | 'last-death-header-missing'
  | 'first-death-mismatch'
  | 'last-death-mismatch'
  | 'counter-invalid'
  | 'total-overflow'
  | 'replay-stamp-present'
  | 'republish-marker-present';

/** Everything that was cut, counted (I-6, I-13). */
export interface Truncation {
  readonly entriesDropped: number;
  readonly routingKeysDropped: number;
  readonly textsTruncated: number;
}

/** `none`: no death header at all. `unreadable`: the container could not be read. */
export type HistoryState = 'none' | 'present' | 'unreadable';

/** `last-time`: sorted by the 1.0 last-time. `broker-order`: the order the broker sent. */
export type OrderBasis = 'last-time' | 'broker-order';

/** What the broker knows about client-published death headers on the connected cluster. */
export interface DeathContext {
  /**
   * Whether the broker interprets a client-published `x-death` (merges it into its own record, as
   * up to 3.13 does) or keeps it as an opaque header (4.0 and later). It is registry data,
   * `clientDeathHeaderInterpreted` (I-3); null when unknown, which fails closed.
   */
  readonly clientDeathInterpreted: boolean | null;
}

/** The queue, reason and exchange of the first or the last death, as the broker's headers say. */
export interface DeathSummary {
  readonly queue: string | null;
  /** As sent; a reason this library does not know stays text. */
  readonly reason: string | null;
  readonly exchange: string | null;
}

/** A delivery counter and the header it was read from. */
export interface Counter {
  readonly value: number;
  readonly source: string;
}

export interface DeathCounters {
  /** `x-delivery-count` (quorum queues), or the 1.0 header's `delivery-count`. */
  readonly deliveryCount: Counter | null;
  /** `x-acquired-count`. */
  readonly acquiredCount: Counter | null;
}

/**
 * `interpreted`: the broker merges a client-published `x-death`, so the record is its own.
 * `broker-shaped`: kept as an opaque header on 4.0+, but self-consistent and with no sign of a
 * client copy; nothing proves it was not copied (OQ-1043). `client-supplied`: there is evidence a
 * client published it, so the broker did not interpret it. `inconsistent`: first/last disagree
 * with the records. `unknown-broker`: the context could not say. `no-history`: nothing to judge.
 */
export type TrustState =
  | 'interpreted'
  | 'broker-shaped'
  | 'client-supplied'
  | 'inconsistent'
  | 'unknown-broker'
  | 'no-history';

export type TrustReason =
  | 'broker-interprets-client-value'
  | 'broker-behaviour-unknown'
  | 'client-published-hint'
  | 'replay-stamp'
  | 'republish-marker'
  | 'first-death-header-missing'
  | 'first-last-mismatch'
  | 'provenance-unproven';

export interface DeathTrust {
  /** True for `interpreted` and `broker-shaped` only. */
  readonly trusted: boolean;
  readonly state: TrustState;
  readonly reasons: readonly TrustReason[];
}

/** The result of reading the records alone. */
export interface EntriesResult {
  readonly protocol: DeathProtocol;
  readonly state: HistoryState;
  /** The form the records were read from; null when there were none. */
  readonly source: DeathSource | null;
  /** Newest first. */
  readonly entries: readonly DeathEntry[];
  readonly orderBasis: OrderBasis;
  readonly flags: readonly HistoryFlag[];
  readonly truncation: Truncation;
  /** The names of the headers and annotations that were read, in reading order. */
  readonly provenance: readonly string[];
}

/** The normalised death history of one message. */
export interface DeathHistory extends EntriesResult {
  /** `x-first-death-*`; null when the message carries none. */
  readonly first: DeathSummary | null;
  /** `x-last-death-*`; null when the message carries none. */
  readonly last: DeathSummary | null;
  /** The sum of the counts, or null when any count is unknown or entries were cut. */
  readonly totalDeaths: number | null;
  readonly counters: DeathCounters;
  readonly trust: DeathTrust;
  /** `trust.trusted`, the flag the issue's interface names. */
  readonly trusted: boolean;
}
