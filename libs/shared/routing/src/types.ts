// The shapes of the routing simulator (M1-02, TOP-02). The input is a plain description of one
// vhost's exchanges, queues and bindings; the output says which queues receive a copy and why.
// Nothing here is a broker call and nothing carries English text: notes, refusals and hints are
// codes the UI words.

import type { DeliveryLimit } from '@app/semantics';

/** An AMQP table value. `null` is the AMQP "void" (presence only, OQ-1101). */
export type HeaderValue =
  | string
  | number
  | boolean
  | null
  | readonly HeaderValue[]
  | { readonly [key: string]: HeaderValue };

export type HeaderTable = Readonly<Record<string, HeaderValue>>;

export interface TopologyExchange {
  readonly name: string;
  /** `direct`, `fanout`, `topic`, `headers` or anything else (a plugin type: reported unknown). */
  readonly type: string;
  /** An internal exchange cannot be published to (403); it can be reached by E2E and AE. */
  readonly internal?: boolean;
  /** The resolved alternate exchange (argument or policy, OQ-1104), or none. */
  readonly alternateExchange?: string | null;
}

export interface TopologyQueue {
  readonly name: string;
  // The fields below are for the dead-letter analysis (M1-03, OQ-1300). All are optional so that
  // every M1-02 input stays valid. The caller resolves argument against policy (M1-01) first.
  readonly type?: 'classic' | 'quorum' | 'stream';
  /** Absent: the queue has no dead-letter exchange, so a message that dies there is dropped. */
  readonly deadLetter?: DeadLetterSetting;
  /** The resolved message TTL in milliseconds; null or absent: none. */
  readonly messageTtlMs?: number | null;
  readonly maxLength?: number | null;
  readonly maxLengthBytes?: number | null;
  readonly overflow?:
    | 'drop-head'
    | 'reject-publish'
    | 'reject-publish-dlx'
    | null;
  /** Absent is `unknown`, never `unlimited` (OQ-1301). */
  readonly deliveryLimit?: DeliveryLimit;
  /** A consumer may reject (nack or reject without requeue). Absent: not known to (OQ-1302). */
  readonly rejectable?: boolean;
  /** Queues named by the broker's `x-death` of the messages this queue holds (A-2). */
  readonly heldDeathSources?: readonly string[];
}

/** The dead-letter reasons of the broker (`rabbit_dead_letter:reason()`). */
export type DeadLetterReason =
  | 'rejected'
  | 'expired'
  | 'maxlen'
  | 'delivery_limit';

export type DeadLetterSetting =
  | {
      readonly status: 'set';
      readonly exchange: string;
      /** `x-dead-letter-routing-key`; absent or null: the message's own routing keys. */
      readonly routingKey?: string | null;
      readonly strategy?: 'at-most-once' | 'at-least-once';
    }
  /** A policy or setting that could not be read decides it (A-2). */
  | { readonly status: 'unknown' };

export interface TopologyBinding {
  readonly source: string;
  readonly destination: string;
  readonly destinationType: 'queue' | 'exchange';
  readonly routingKey: string;
  readonly arguments?: HeaderTable;
}

/** One vhost. Names are unique within their kind. */
export interface RoutingTopology {
  readonly exchanges: readonly TopologyExchange[];
  readonly queues: readonly TopologyQueue[];
  readonly bindings: readonly TopologyBinding[];
}

export interface PublishInput {
  /** The exchange name; `""` is the default exchange. */
  readonly exchange: string;
  readonly routingKey: string;
  /** The message headers (the `CC`, `BCC` and `x-` headers are read from here). */
  readonly headers?: HeaderTable;
  /** With `mandatory` an unroutable message is returned to the publisher. */
  readonly mandatory?: boolean;
}

export const X_MATCH_MODES = [
  'all',
  'any',
  'all-with-x',
  'any-with-x',
] as const;
export type XMatchMode = (typeof X_MATCH_MODES)[number];

/** Where a routing key of the message comes from. */
export type KeySource = 'routing-key' | 'cc' | 'bcc';

/** Why a binding (or the default exchange) matched. */
export type MatchRule =
  | {
      readonly kind: 'default-exchange';
      readonly routingKey: string;
      readonly keySource: KeySource;
    }
  | {
      readonly kind: 'direct';
      readonly routingKey: string;
      readonly keySource: KeySource;
    }
  | { readonly kind: 'fanout' }
  | {
      readonly kind: 'topic';
      readonly pattern: string;
      readonly routingKey: string;
      readonly keySource: KeySource;
    }
  | {
      readonly kind: 'headers';
      readonly mode: XMatchMode;
      /** The binding arguments that decided: all compared ones for `all`, the first hit for `any`. */
      readonly arguments: readonly string[];
    };

export interface BindingRef {
  readonly source: string;
  readonly destination: string;
  readonly destinationType: 'queue' | 'exchange';
  readonly routingKey: string;
}

export interface RouteHop {
  /** The exchange whose routing produced this hop. */
  readonly exchange: string;
  readonly how: 'default-exchange' | 'binding' | 'alternate-exchange';
  readonly destination: string;
  readonly destinationType: 'queue' | 'exchange';
  /** The binding used; `null` for the default exchange and for an alternate exchange. */
  readonly binding: BindingRef | null;
  /** Why it matched; `null` for an alternate exchange. */
  readonly rule: MatchRule | null;
}

/** The hops from the published exchange to one queue, the last hop being the queue. */
export interface RoutePath {
  readonly queue: string;
  readonly hops: readonly RouteHop[];
}

export type NoteCode =
  | 'invalid-x-match'
  | 'dangling-destination'
  | 'missing-exchange'
  | 'ignored-default-exchange-binding'
  | 'keys-ignored'
  | 'bcc-stripped'
  | 'duplicate-exchange'
  | 'truncated'
  // M1-03: the exchange picks one bound queue, so the share is not a fixed set (R6).
  | 'non-deterministic-share'
  | 'random-destination';

export interface RoutingNote {
  readonly code: NoteCode;
  /** The exchange concerned, when there is one. */
  readonly exchange?: string;
  /** A name or a number: never prose. */
  readonly detail?: string;
}

export type UnknownHint =
  | 'hash-single-destination'
  | 'random-single-destination'
  | 'delayed'
  | 'recent-history'
  | 'unmodelled';

/** An exchange the simulator reached and cannot model: not expanded (R4). */
export interface UnknownExchange {
  readonly exchange: string;
  readonly type: string;
  readonly hint: UnknownHint;
  /** Where the message may also go if the exchange routes nowhere. */
  readonly alternateExchange: string | null;
}

export interface LoopReport {
  /** The exchanges of one loop, sorted by name. */
  readonly exchanges: readonly string[];
}

export type Refusal =
  | { readonly code: 'exchange-not-found'; readonly replyCode: 404 }
  | { readonly code: 'internal-exchange'; readonly replyCode: 403 }
  | {
      readonly code: 'invalid-routing-header';
      readonly replyCode: 406;
      /** `CC` or `BCC`. */
      readonly header: string;
    };

export interface SimulationLimits {
  /** Exchange hops from the published exchange. */
  readonly maxDepth: number;
  /** Exchanges expanded. */
  readonly maxExchanges: number;
  /** Binding evaluations over the whole walk. */
  readonly maxBindingsScanned: number;
  /** Distinct queues in the result. */
  readonly maxQueues: number;
  /** Paths kept per queue. */
  readonly maxPathsPerQueue: number;
  /** Loops listed. */
  readonly maxLoops: number;
  /** Words of a topic key or pattern. */
  readonly maxTopicWords: number;
  /** Notes listed. */
  readonly maxNotes: number;
}

export const DEFAULT_LIMITS: SimulationLimits = {
  maxDepth: 64,
  maxExchanges: 1000,
  maxBindingsScanned: 200_000,
  maxQueues: 10_000,
  maxPathsPerQueue: 8,
  maxLoops: 16,
  maxTopicWords: 256,
  maxNotes: 100,
};

/** What each limit cut, counted (I-13). All zero means nothing was cut. */
export interface Truncation {
  /** Distinct exchanges not expanded because of `maxDepth`. */
  readonly depth: number;
  /** Distinct exchanges not expanded because of `maxExchanges`. */
  readonly exchanges: number;
  /** Bindings of expanded exchanges that were not evaluated because of `maxBindingsScanned`. */
  readonly bindings: number;
  /** Bindings whose queue was not listed because of `maxQueues`. */
  readonly queues: number;
  /** Paths not kept because of `maxPathsPerQueue` (the queue itself is listed). */
  readonly paths: number;
  /** Loops not listed because of `maxLoops`. */
  readonly loops: number;
  /** Topic keys or patterns longer than `maxTopicWords` (treated as not matching, counted). */
  readonly topicWords: number;
  /** Notes not listed because of `maxNotes`. */
  readonly notes: number;
}

export interface RoutingKeys {
  readonly routingKey: string;
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
}

export type Outcome = 'routed' | 'unroutable' | 'indeterminate' | 'refused';
export type Fate = 'delivered' | 'returned' | 'dropped' | 'refused' | 'unknown';

export interface RoutingResult {
  readonly outcome: Outcome;
  /** What the broker does with the message; `unknown` when the answer is indeterminate. */
  readonly fate: Fate;
  /** True only for an exact answer with no queue. */
  readonly unroutable: boolean;
  /** Destination queues, sorted by name, without duplicates. */
  readonly queues: readonly string[];
  /** One entry per distinct path to a queue (the issue's `path[]`). */
  readonly paths: readonly RoutePath[];
  /** True when at least one alternate-exchange hop was taken. */
  readonly usedAE: boolean;
  /** False when the queues are a lower bound (an unknown exchange or a cut). */
  readonly exact: boolean;
  readonly refusal: Refusal | null;
  readonly unknownExchanges: readonly UnknownExchange[];
  readonly loops: readonly LoopReport[];
  /** The exchanges expanded, in walk order. */
  readonly reachedExchanges: readonly string[];
  readonly keys: RoutingKeys;
  readonly notes: readonly RoutingNote[];
  readonly truncation: Truncation;
}

/** Limits of the dead-letter analysis (M1-03, R8). Every cut is counted and never silent. */
export interface DlxLimits {
  /** Queues examined as possible sources. */
  readonly maxDlxSourcesScanned: number;
  /** Steps of dead-letter paths. */
  readonly maxDlxSteps: number;
  /** Paths kept per start queue. */
  readonly maxDlxPaths: number;
  /** Dead-letter loops listed. */
  readonly maxDlxLoops: number;
  /** Candidates listed for a hash or random exchange. */
  readonly maxDlxCandidates: number;
}

export const DEFAULT_DLX_LIMITS: DlxLimits = {
  maxDlxSourcesScanned: 10_000,
  maxDlxSteps: 1000,
  maxDlxPaths: 64,
  maxDlxLoops: 16,
  maxDlxCandidates: 1000,
};

/** What each dead-letter limit cut, counted (I-13). All zero means nothing was cut. */
export interface DlxTruncation {
  readonly sources: number;
  readonly steps: number;
  readonly paths: number;
  readonly loops: number;
  readonly candidates: number;
}

export const NO_DLX_TRUNCATION: DlxTruncation = {
  sources: 0,
  steps: 0,
  paths: 0,
  loops: 0,
  candidates: 0,
};
