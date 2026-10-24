// Shared schemas of the routing contracts (M1-20): a publish to simulate, the answer of the routing
// simulator, the dead-letter walk and the dead-letter sources. They mirror the result types of
// @app/routing, which this package cannot import (contracts import zod only); the engine's service
// maps one to the other, and TypeScript fails the build if they drift. Every list is bounded (I-7) and
// every cut is a count next to it (I-13). Nothing here is prose: notes, ends and reasons are codes.
import { z } from 'zod';

import { TOPOLOGY_NAME_MAX } from './topology-types.ts';

/** A routing key, an exchange or a queue name: an AMQP short string. */
const shortText = z.string().max(TOPOLOGY_NAME_MAX);
const count = z.number().int().nonnegative();

/** Names a result lists at most; the number left out rides next to the list. */
export const ROUTING_LIST_MAX = 1_000;
/** Paths a result lists at most. */
export const ROUTING_PATHS_MAX = 2_000;
/** Hops of one path, at most (the simulator's depth limit plus the queue). */
export const ROUTING_HOPS_MAX = 65;
/** Notes of one result, at most (the simulator's own limit). */
export const ROUTING_NOTES_MAX = 100;
/** Names a dead-letter loop lists at most. */
export const LOOP_QUEUES_MAX = 200;
/** Source queues the caller may name as holding dead letters. */
export const HELD_DEATH_SOURCES_MAX = 100;

// --- A publish -----------------------------------------------------------------------------------

const HeaderScalarSchema = z.union([
  z.string().max(4_096),
  z.number(),
  z.boolean(),
  z.null(),
]);
const HeaderNestedSchema = z.union([
  HeaderScalarSchema,
  z.array(HeaderScalarSchema).max(64),
  z.record(shortText, HeaderScalarSchema),
]);

/**
 * An AMQP table value; null is the AMQP void (presence only). Lists and tables may nest one level:
 * the specs of this API do not describe recursive schemas, and routing never reads deeper.
 */
export const HeaderValueSchema = z.union([
  HeaderScalarSchema,
  z.array(HeaderNestedSchema).max(64),
  z.record(shortText, HeaderNestedSchema),
]);

export const HEADERS_MAX = 64;
export const HeadersSchema = z
  .record(shortText, HeaderValueSchema)
  .refine((table) => Object.keys(table).length <= HEADERS_MAX, {
    message: 'At most 64 headers.',
  });

// --- The simulator's result ----------------------------------------------------------------------

const KeySourceSchema = z.enum(['routing-key', 'cc', 'bcc']);

export const MatchRuleSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('default-exchange'),
    routingKey: shortText,
    keySource: KeySourceSchema,
  }),
  z.strictObject({
    kind: z.literal('direct'),
    routingKey: shortText,
    keySource: KeySourceSchema,
  }),
  z.strictObject({ kind: z.literal('fanout') }),
  z.strictObject({
    kind: z.literal('topic'),
    pattern: shortText,
    routingKey: shortText,
    keySource: KeySourceSchema,
  }),
  z.strictObject({
    kind: z.literal('headers'),
    mode: z.enum(['all', 'any', 'all-with-x', 'any-with-x']),
    arguments: z.array(shortText).max(HEADERS_MAX),
  }),
]);

const BindingRefSchema = z.strictObject({
  source: shortText,
  destination: shortText,
  destinationType: z.enum(['queue', 'exchange']),
  routingKey: shortText,
});

export const RouteHopSchema = z.strictObject({
  exchange: shortText,
  how: z.enum(['default-exchange', 'binding', 'alternate-exchange']),
  destination: shortText,
  destinationType: z.enum(['queue', 'exchange']),
  /** The binding used; null for the default exchange and for an alternate exchange. */
  binding: BindingRefSchema.nullable(),
  /** Why it matched; null for an alternate exchange. */
  rule: MatchRuleSchema.nullable(),
});

export const RoutePathSchema = z.strictObject({
  queue: shortText,
  hops: z.array(RouteHopSchema).max(ROUTING_HOPS_MAX),
});

export const NOTE_CODES = [
  'invalid-x-match',
  'dangling-destination',
  'missing-exchange',
  'ignored-default-exchange-binding',
  'keys-ignored',
  'bcc-stripped',
  'duplicate-exchange',
  'truncated',
  'non-deterministic-share',
  'random-destination',
] as const;
export const RoutingNoteSchema = z.strictObject({
  code: z.enum(NOTE_CODES),
  exchange: shortText.optional(),
  detail: shortText.optional(),
});

export const UnknownExchangeSchema = z.strictObject({
  exchange: shortText,
  type: z.string().max(64),
  hint: z.enum([
    'hash-single-destination',
    'random-single-destination',
    'delayed',
    'recent-history',
    'unmodelled',
  ]),
  alternateExchange: shortText.nullable(),
});

export const SimulationTruncationSchema = z.strictObject({
  depth: count,
  exchanges: count,
  bindings: count,
  queues: count,
  paths: count,
  loops: count,
  topicWords: count,
  notes: count,
});

export const RoutingResultSchema = z.strictObject({
  outcome: z.enum(['routed', 'unroutable', 'indeterminate', 'refused']),
  fate: z.enum(['delivered', 'returned', 'dropped', 'refused', 'unknown']),
  /** True only for an exact answer that reaches no queue. */
  unroutable: z.boolean(),
  queues: z.array(shortText).max(ROUTING_LIST_MAX),
  paths: z.array(RoutePathSchema).max(ROUTING_PATHS_MAX),
  usedAE: z.boolean(),
  /** False when the queues are a lower bound: an unknown exchange, a cut, or a gap in what was read. */
  exact: z.boolean(),
  refusal: z
    .discriminatedUnion('code', [
      z.strictObject({
        code: z.literal('exchange-not-found'),
        replyCode: z.literal(404),
      }),
      z.strictObject({
        code: z.literal('internal-exchange'),
        replyCode: z.literal(403),
      }),
      z.strictObject({
        code: z.literal('invalid-routing-header'),
        replyCode: z.literal(406),
        header: shortText,
      }),
    ])
    .nullable(),
  unknownExchanges: z.array(UnknownExchangeSchema).max(ROUTING_LIST_MAX),
  loops: z
    .array(
      z.strictObject({ exchanges: z.array(shortText).max(ROUTING_LIST_MAX) }),
    )
    .max(16),
  reachedExchanges: z.array(shortText).max(ROUTING_LIST_MAX),
  keys: z.strictObject({
    routingKey: shortText,
    cc: z.array(shortText).max(HEADERS_MAX),
    bcc: z.array(shortText).max(HEADERS_MAX),
  }),
  notes: z.array(RoutingNoteSchema).max(ROUTING_NOTES_MAX),
  truncation: SimulationTruncationSchema,
});
export type RoutingResultView = z.infer<typeof RoutingResultSchema>;

// --- Dead letters ---------------------------------------------------------------------------------

export const DEAD_LETTER_REASONS = [
  'rejected',
  'expired',
  'maxlen',
  'delivery_limit',
] as const;
export const DeadLetterReasonSchema = z.enum(DEAD_LETTER_REASONS);

export const DlxTruncationSchema = z.strictObject({
  sources: count,
  steps: count,
  paths: count,
  loops: count,
  candidates: count,
});

/** A queue limit: unknown is never read as unlimited. */
export const DeliveryLimitSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('unlimited') }),
  z.strictObject({
    kind: z.literal('finite'),
    value: z.number().int().nonnegative(),
  }),
  z.strictObject({ kind: z.literal('unknown') }),
]);

export const DeadLetterTargetSchema = z.strictObject({
  queue: shortText,
  certainty: z.enum(['definite', 'possible']),
  /** The exchanges of the first path found, from the dead-letter exchange on. */
  via: z.array(shortText).max(ROUTING_HOPS_MAX),
});

export const ShareNoteSchema = z.strictObject({
  code: z.enum(['non-deterministic-share', 'random-destination']),
  exchange: shortText,
  candidates: z.array(shortText).max(ROUTING_LIST_MAX),
  exchangeDestinations: z.array(shortText).max(ROUTING_LIST_MAX),
  truncated: count,
});

export const DeadLetterStepSchema = z.strictObject({
  from: shortText,
  reasons: z.array(DeadLetterReasonSchema).max(DEAD_LETTER_REASONS.length),
  exchange: shortText,
  /** The routing keys the dead letter is routed with; `original` when they are the message's own (unknown). */
  keys: z.union([z.array(shortText).max(HEADERS_MAX), z.literal('original')]),
  exact: z.boolean(),
  targets: z.array(DeadLetterTargetSchema).max(ROUTING_LIST_MAX),
  /** Routed, then removed by the broker's cycle rule. */
  dropped: z.array(shortText).max(ROUTING_LIST_MAX),
  strategy: z.enum(['at-most-once', 'at-least-once']).nullable(),
  unknownExchanges: z.array(UnknownExchangeSchema).max(ROUTING_LIST_MAX),
  shares: z.array(ShareNoteSchema).max(ROUTING_LIST_MAX),
  notes: z.array(RoutingNoteSchema).max(ROUTING_NOTES_MAX),
});

export const PathEndSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('terminal'), queue: shortText }),
  z.strictObject({
    kind: z.literal('dropped-no-dead-letter'),
    queue: shortText,
  }),
  z.strictObject({ kind: z.literal('dropped-cycle'), queue: shortText }),
  z.strictObject({
    kind: z.literal('dropped-unroutable'),
    exchange: shortText,
  }),
  z.strictObject({
    kind: z.literal('dropped-missing-exchange'),
    exchange: shortText,
  }),
  z.strictObject({
    kind: z.literal('indeterminate'),
    queue: shortText,
    why: z.enum([
      'dead-letter-unknown',
      'unknown-exchange',
      'open-default-exchange',
      'cut',
    ]),
  }),
  z.strictObject({ kind: z.literal('truncated'), queue: shortText }),
]);

export const DeadLetterPathSchema = z.strictObject({
  steps: z.array(DeadLetterStepSchema).max(ROUTING_LIST_MAX),
  end: PathEndSchema,
});

export const DlxLoopSchema = z.strictObject({
  /** Sorted; the first LOOP_QUEUES_MAX of a longer loop, with the rest counted. */
  queues: z.array(shortText).max(LOOP_QUEUES_MAX),
  queuesMore: count,
  /** A drop loop: no queue in it can reject, so the broker drops the message when it comes back. */
  kind: z.enum(['drop-loop', 'retry-ring']),
  /** An edge of the loop is a may-reach edge (the dead-letter routing key is open). */
  possible: z.boolean(),
});

// --- Sources of dead letters (A-2) ----------------------------------------------------------------

export const UNKNOWN_REASON_CODES = [
  'policy-unreadable',
  'operator-policy-unreadable',
  'stats-fields-missing',
  'other-clients-may-declare',
  'dead-letter-unknown',
  'source-limit-unknown',
  'unknown-exchange-in-path',
  'held-death-source-missing',
  'target-not-found',
  'truncated',
  // This module's: a policy match that could not be decided, so a route may be missing.
  'policy-match-undecided',
] as const;
export const UnknownReasonSchema = z.strictObject({
  code: z.enum(UNKNOWN_REASON_CODES),
  /** The queue or exchange concerned, when there is one. */
  subject: shortText.optional(),
});

export const DlxSourceSchema = z.strictObject({
  queue: shortText,
  /** The limit of the source queue, never of the target. */
  limit: DeliveryLimitSchema,
  certainty: z.enum(['definite', 'possible']),
  via: z.array(shortText).max(ROUTING_HOPS_MAX),
  reasons: z.array(DeadLetterReasonSchema).max(DEAD_LETTER_REASONS.length),
});
