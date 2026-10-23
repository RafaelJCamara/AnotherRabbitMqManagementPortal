// The k.3 effective-config tables (DC-30, POL-01), read from fact sheet k.3 and b.5, the semantics
// matrix and the broker source at the tags in the citations. Nothing here was lab-tested: the rows
// carry no status or evidence (OQ-361, OQ-960) and name the planned lab cells CF-EFFCFG-01..07
// (OQ-968).
//
// Step 1 (`merges`): the operator policy merged with the user policy, per key.
// Step 2 (`resolutions`): the merged policy value against the queue argument, per queue type, key
// and broker version. `versions` is the range a row speaks for; `sourceRead` is the part of it the
// cited source was read at (v4.3.6, and v3.13.7 for the quorum `expires` quirk). The rest of
// `versions` is extrapolated, and every answer says so (OQ-961). There is no row for 4.4 (OQ-963),
// and none for a key or queue type nobody described: those are gaps, not defaults.
//
// Open disagreement (OQ-962): k.3 puts delayed-retry-min/max under min(policy, argument); b.5 says
// max() applies to min and min() to max. Both rows are `undetermined` from 4.3.1.
import type { ConformanceId, WarningRef } from '@app/contracts';
import type {
  EffectiveConfigData,
  OperatorMergeRule,
  ResolutionRule,
  ResolveKind,
  WarningCondition,
} from '../effective-config.ts';
import type { Citation } from '../schema.ts';

const source = (ref: string): Citation => ({ kind: 'S', ref });
const docs = (ref: string): Citation => ({ kind: 'D', ref });
const matrix = (ref: string): Citation => ({ kind: 'M3', ref });

const POLICIES_ERL = source(
  'RS@v4.3.6:deps/rabbit/src/rabbit_policies.erl merge_policy_value L218-245 (operator and user policy merged per key)',
);
const POLICY_GET0 = source(
  'RS@v4.3.6:deps/rabbit/src/rabbit_policy.erl get0 (the operator policy is merged with the user policy before a queue sees it)',
);
const ARGS_LOOKUP = source(
  'RS@v4.3.6:deps/rabbit/src/rabbit_queue_type_util.erl args_policy_lookup (the merged policy value resolved against the argument by a resolver per key and queue type)',
);
const CLASSIC_43 = source(
  'RS@v4.3.6:deps/rabbit/src/rabbit_amqqueue_process.erl L486-502 (min for expires, message-ttl, max-length and max-length-bytes; the argument for dead-letter-exchange, dead-letter-routing-key and overflow)',
);
const QUORUM_43 = source(
  'RS@v4.3.6:deps/rabbit/src/rabbit_quorum_queue.erl L424-445, L1968-1985, L2014-2016, L2069-2074 (the resolvers of the quorum queue keys)',
);
const QUORUM_313_EXPIRES = source(
  'RS@v3.13.7:deps/rabbit/src/rabbit_quorum_queue.erl L316 (the policy wins for expires)',
);
const STREAM_43 = source(
  'RS@v4.3.6:deps/rabbit/src/rabbit_stream_queue.erl L200-201, L1253-1258 (the policy wins for the retention and segment keys and initial-cluster-size)',
);
const FACT_K3 = matrix(
  'docs/research/fact-sheet.md k.3 (effective-policy precedence, S@v4.3.6)',
);
const FACT_B5 = matrix(
  'docs/research/fact-sheet.md b.5 (delayed retry: policy keys from 4.3.1, the policy type beats the argument, an operator policy wins the type, max() for min and min() for max)',
);
const MATRIX_LIMIT = matrix(
  'docs/research/semantics-matrix.md (effective delivery limit: merge_policy_value, then resolve_delivery_limit; a missing limit is 20 on 4.0+ and unlimited on 3.13)',
);
const MATRIX_TARGET = matrix(
  'docs/research/competitors-2026.md section 7 (target-group-size: the greater value, from the docs)',
);
const POLICIES_GUIDE = docs(
  'WEB:docs/policies/index.md L863-869 (client arguments take precedence over user policies, with stream settings and quorum overflow as exceptions; operator policies override both)',
);
const MAXLENGTH_GUIDE = docs(
  'WEB:docs/maxlength/index.md (the minimum of the two values specified is used)',
);

const CF_MIN: ConformanceId[] = ['CF-EFFCFG-01'];
const CF_313: ConformanceId[] = ['CF-EFFCFG-02'];
const CF_LIMIT: ConformanceId[] = ['CF-EFFCFG-03'];
const CF_OPERATOR: ConformanceId[] = ['CF-EFFCFG-04'];
const CF_STREAM: ConformanceId[] = ['CF-EFFCFG-05'];
const CF_CLASSIC_OVERFLOW: ConformanceId[] = ['CF-EFFCFG-06'];
const CF_DELAYED: ConformanceId[] = ['CF-EFFCFG-07'];

// The ranges the rows speak for (see the header).
const ALL = '>=3.13.0 <4.4.0';
const V313 = '>=3.13.0 <4.0.0';
const V4 = '>=4.0.0 <4.4.0';
const V43 = '>=4.3.0 <4.4.0';
const BELOW_430 = '>=3.13.0 <4.3.0';
const V430 = '>=4.3.0 <4.3.1';
const V431 = '>=4.3.1 <4.4.0';

const warning = (id: WarningRef['id'], severity: WarningRef['severity']) =>
  ({
    id,
    severity,
    textKey: `effective-config.${id}.v1`,
    textVersion: 1,
  }) satisfies WarningRef;

const warnings: readonly WarningRef[] = [
  warning('W-EC-NO-ROW', 'warn'),
  warning('W-EC-VERSION-UNKNOWN', 'warn'),
  warning('W-EC-NO-MERGE', 'warn'),
  warning('W-EC-UNDETERMINED', 'warn'),
  warning('W-EC-BAD-VALUE', 'warn'),
  warning('W-EC-TIE', 'warn'),
  warning('W-EC-PATTERN', 'warn'),
  warning('W-EC-POLICY-IGNORED', 'info'),
  warning('W-EC-UNSUPPORTED', 'info'),
  warning('W-EC-ARG-BEATS-OPERATOR', 'warn'),
  warning('W-EC-POLICY-WINS', 'info'),
  warning('W-EC-POLICY-WINS-313', 'warn'),
  warning('W-EC-DEFAULT', 'info'),
];

const mergeKey = (
  key: string,
  merge: OperatorMergeRule['merge'],
  citations: Citation[],
  conformance: ConformanceId[],
): OperatorMergeRule => ({
  key,
  valueType: null,
  merge,
  citations,
  conformance,
});

const merges: readonly OperatorMergeRule[] = [
  // Limits: the smaller of the two (fact sheet k.3 step 1; max-in-memory-* from the source table).
  ...[
    'message-ttl',
    'max-length',
    'max-length-bytes',
    'max-in-memory-length',
    'max-in-memory-bytes',
    'expires',
  ].map((key) =>
    mergeKey(key, 'min', [FACT_K3, POLICIES_ERL, POLICY_GET0], CF_MIN),
  ),
  // Negative means "no limit": if either is negative the larger one, otherwise the smaller.
  mergeKey(
    'delivery-limit',
    'negative-rule',
    [FACT_K3, POLICIES_ERL, MATRIX_LIMIT],
    CF_LIMIT,
  ),
  mergeKey('overflow', 'operator', [FACT_K3, POLICIES_ERL], CF_OPERATOR),
  mergeKey('queue-version', 'operator', [FACT_K3, POLICIES_ERL], CF_OPERATOR),
  mergeKey('delayed-retry-type', 'operator', [FACT_B5], CF_DELAYED),
  mergeKey('target-group-size', 'max', [MATRIX_TARGET], CF_OPERATOR),
  {
    key: null,
    valueType: 'boolean',
    merge: 'operator',
    citations: [FACT_K3, POLICIES_ERL],
    conformance: CF_OPERATOR,
  },
];

interface Spec {
  readonly queueType: ResolutionRule['queueType'];
  readonly key: string;
  readonly versions: string;
  readonly sourceRead: string | null;
  readonly resolve: ResolveKind;
  readonly citations: Citation[];
  readonly conformance: ConformanceId[];
  readonly warn?: readonly [WarningRef['id'], WarningCondition] | undefined;
  readonly brokerDefault?: number | null;
}

const row = (spec: Spec): ResolutionRule => ({
  queueType: spec.queueType,
  key: spec.key,
  argument: `x-${spec.key}`,
  versions: spec.versions,
  sourceRead: spec.sourceRead,
  resolve: spec.resolve,
  ...(spec.brokerDefault === undefined
    ? {}
    : { brokerDefault: { value: spec.brokerDefault } }),
  warnings:
    spec.warn === undefined ? [] : [{ id: spec.warn[0], when: spec.warn[1] }],
  citations: spec.citations,
  conformance: spec.conformance,
});

const classic = (
  key: string,
  resolve: ResolveKind,
  conformance: ConformanceId[],
  warn?: Spec['warn'],
): ResolutionRule =>
  row({
    queueType: 'classic',
    key,
    versions: ALL,
    sourceRead: V43,
    resolve,
    citations: [
      FACT_K3,
      CLASSIC_43,
      ARGS_LOOKUP,
      MAXLENGTH_GUIDE,
      POLICIES_GUIDE,
    ],
    conformance,
    warn,
  });

const quorum = (
  key: string,
  resolve: ResolveKind,
  conformance: ConformanceId[],
  warn?: Spec['warn'],
): ResolutionRule =>
  row({
    queueType: 'quorum',
    key,
    versions: ALL,
    sourceRead: V43,
    resolve,
    citations: [FACT_K3, QUORUM_43, ARGS_LOOKUP, POLICIES_GUIDE],
    conformance,
    warn,
  });

const stream = (key: string): ResolutionRule =>
  row({
    queueType: 'stream',
    key,
    versions: ALL,
    sourceRead: V43,
    resolve: 'policy-wins',
    citations: [FACT_K3, STREAM_43, ARGS_LOOKUP, POLICIES_GUIDE],
    conformance: CF_STREAM,
    warn: ['W-EC-POLICY-WINS', 'both-present'],
  });

/** The three delayed-retry keys (b.5): unsupported, argument only, then the 4.3.1 policy keys. */
const delayedRetry = (
  key: string,
  from431: ResolveKind,
  warn431: Spec['warn'],
): ResolutionRule[] => {
  const citations = [FACT_B5, FACT_K3, QUORUM_43];
  const common = {
    queueType: 'quorum',
    key,
    sourceRead: V43,
    citations,
    conformance: CF_DELAYED,
  } as const;
  return [
    row({
      ...common,
      versions: BELOW_430,
      resolve: 'unsupported',
      warn: ['W-EC-UNSUPPORTED', 'always'],
    }),
    row({
      ...common,
      versions: V430,
      resolve: 'argument-only',
      warn: ['W-EC-POLICY-IGNORED', 'policy-present'],
    }),
    row({ ...common, versions: V431, resolve: from431, warn: warn431 }),
  ];
};

const resolutions: readonly ResolutionRule[] = [
  // Classic queues (k.3): the smaller of policy and argument for the limits; the argument for the
  // dead-letter keys and overflow (the argument beats even an operator policy: source-read,
  // untested).
  classic('expires', 'min', CF_MIN),
  classic('message-ttl', 'min', CF_MIN),
  classic('max-length', 'min', CF_MIN),
  classic('max-length-bytes', 'min', CF_MIN),
  classic('dead-letter-exchange', 'argument-wins', CF_OPERATOR),
  classic('dead-letter-routing-key', 'argument-wins', CF_OPERATOR),
  classic('overflow', 'argument-wins', CF_CLASSIC_OVERFLOW, [
    'W-EC-ARG-BEATS-OPERATOR',
    'operator-and-argument',
  ]),

  // Quorum queues (k.3).
  quorum('max-length', 'min', CF_MIN),
  quorum('max-length-bytes', 'min', CF_MIN),
  quorum('message-ttl', 'min', CF_MIN),
  // expires: the policy wins on 3.13.7 (L316), the smaller of the two from 4.0.
  row({
    queueType: 'quorum',
    key: 'expires',
    versions: V313,
    sourceRead: V313,
    resolve: 'policy-wins',
    citations: [FACT_K3, QUORUM_313_EXPIRES],
    conformance: CF_313,
    warn: ['W-EC-POLICY-WINS-313', 'both-present'],
  }),
  row({
    queueType: 'quorum',
    key: 'expires',
    versions: V4,
    sourceRead: V43,
    resolve: 'min',
    citations: [FACT_K3, QUORUM_43, ARGS_LOOKUP],
    conformance: CF_MIN,
  }),
  // Only read at 4.3: the sources do not say when the key appeared.
  row({
    queueType: 'quorum',
    key: 'consumer-disconnected-timeout',
    versions: V43,
    sourceRead: V43,
    resolve: 'min',
    citations: [FACT_K3, QUORUM_43, ARGS_LOOKUP],
    conformance: CF_MIN,
  }),
  // delivery-limit: the negative rule against the argument too; the default is data (OQ-967).
  row({
    queueType: 'quorum',
    key: 'delivery-limit',
    versions: V313,
    sourceRead: null,
    resolve: 'negative-rule',
    brokerDefault: null,
    warn: ['W-EC-DEFAULT', 'neither-present'],
    citations: [FACT_K3, MATRIX_LIMIT, QUORUM_43],
    conformance: CF_LIMIT,
  }),
  row({
    queueType: 'quorum',
    key: 'delivery-limit',
    versions: V4,
    sourceRead: V43,
    resolve: 'negative-rule',
    brokerDefault: 20,
    warn: ['W-EC-DEFAULT', 'neither-present'],
    citations: [FACT_K3, MATRIX_LIMIT, QUORUM_43],
    conformance: CF_LIMIT,
  }),
  quorum('dead-letter-exchange', 'argument-wins', CF_OPERATOR),
  quorum('dead-letter-routing-key', 'argument-wins', CF_OPERATOR),
  quorum('dead-letter-strategy', 'argument-wins', CF_OPERATOR),
  quorum('overflow', 'policy-wins', CF_OPERATOR, [
    'W-EC-POLICY-WINS',
    'both-present',
  ]),
  ...delayedRetry('delayed-retry-type', 'policy-wins', [
    'W-EC-POLICY-WINS',
    'both-present',
  ]),
  ...delayedRetry('delayed-retry-min', 'undetermined', [
    'W-EC-UNDETERMINED',
    'always',
  ]),
  ...delayedRetry('delayed-retry-max', 'undetermined', [
    'W-EC-UNDETERMINED',
    'always',
  ]),

  // Streams (k.3): the policy wins for the retention and segment keys and initial-cluster-size.
  stream('max-length-bytes'),
  stream('max-age'),
  stream('stream-max-segment-size-bytes'),
  stream('stream-filter-size-bytes'),
  stream('initial-cluster-size'),
];

export const effectiveConfig: EffectiveConfigData = {
  merges: [...merges],
  resolutions: [...resolutions],
  warnings: [...warnings],
};
