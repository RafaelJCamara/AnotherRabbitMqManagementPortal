// Shared schemas of the svc-topology contracts (M1-20): the vhost and object names, the gaps an answer
// can carry, what a snapshot of a vhost reports about itself, and the effective-config answer. Every
// array in an output has a maximum (I-7); no schema here is open (`z.any()`, `passthrough`).
import { z } from 'zod';

import { WarningIdSchema } from '../brands.ts';

/** A vhost or object name: an AMQP short string. */
export const TOPOLOGY_NAME_MAX = 255;
export const TopologyNameSchema = z.string().min(1).max(TOPOLOGY_NAME_MAX);
/** A vhost is never empty either (the default vhost is `/`). */
export const VhostNameSchema = TopologyNameSchema;

/**
 * Why an answer may be incomplete. The first four are the context gaps of the dead-letter source
 * analysis (A-2): an answer built with any of them is not exact, and an empty list of sources is
 * never "no hazard" while one exists.
 */
export const TOPOLOGY_GAPS = [
  'policy-unreadable',
  'operator-policy-unreadable',
  'stats-fields-missing',
  'other-clients-may-declare',
  'policy-match-undecided',
  'truncated',
] as const;
export const TopologyGapSchema = z.enum(TOPOLOGY_GAPS);
export type TopologyGapCode = z.infer<typeof TopologyGapSchema>;
export const TopologyGapsSchema = z
  .array(TopologyGapSchema)
  .max(TOPOLOGY_GAPS.length);

const count = z.number().int().nonnegative();

/** What the read of the vhost reports about itself; every cut is counted, none is silent (I-13). */
export const SnapshotMetaSchema = z.strictObject({
  /** Milliseconds since the epoch, when the read of the broker ended. */
  takenAt: count,
  /** Objects read but not used because of a bound; a minimum when the broker gave no total. */
  truncation: z.strictObject({
    queues: count,
    exchanges: count,
    bindings: count,
    consumers: count,
    policies: count,
    operatorPolicies: count,
  }),
  /** Whether the consumers, which tell whether a queue may reject, were read whole. */
  consumers: z.enum(['read', 'unreadable', 'truncated']),
});

export const QUEUE_TYPES = ['classic', 'quorum', 'stream'] as const;

/** The policy layer of a queue (user or operator): none, one policy, or not decidable. */
export const PolicyLayerSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('none') }),
  z.strictObject({
    state: z.literal('policy'),
    name: z.string().max(TOPOLOGY_NAME_MAX),
  }),
  z.strictObject({
    state: z.literal('unknown'),
    why: z.enum(['unreadable', 'not-listed', 'ambiguous']),
  }),
]);

const PolicyValueSchema = z.union([z.number(), z.string(), z.boolean()]);

const CitationSchema = z.strictObject({
  kind: z.enum(['S', 'D', 'RN', 'GH', 'M3', 'LAB']),
  ref: z.string().min(1).max(512),
});

export const EffectiveWarningSchema = z.strictObject({
  id: WarningIdSchema,
  severity: z.enum(['info', 'warn', 'consent', 'block']),
  /** The i18n key of the text and its version; the UI words it. */
  textKey: z.string().max(256),
  textVersion: count,
  params: z.record(z.string(), z.string()),
  citations: z.array(CitationSchema).max(32),
});

export const ProvenanceEntrySchema = z.strictObject({
  layer: z.enum([
    'argument',
    'user-policy',
    'operator-policy',
    'broker-default',
  ]),
  /** The argument name, the policy name, or `broker default`. */
  name: z.string().max(TOPOLOGY_NAME_MAX),
  value: z.unknown(),
  role: z.enum(['deciding', 'compared', 'overridden', 'ignored', 'unresolved']),
});

export const EffectiveEntrySchema = z.strictObject({
  /** The policy key, `max-length`. */
  key: z.string().max(TOPOLOGY_NAME_MAX),
  /** The queue argument, `x-max-length`; null when the registry has no row that names it. */
  argument: z.string().max(TOPOLOGY_NAME_MAX).nullable(),
  status: z.enum(['effective', 'default', 'unset', 'unknown', 'invalid']),
  value: PolicyValueSchema.nullable(),
  rule: z.string().max(256).nullable(),
  mergeRule: z.string().max(256).nullable(),
  basis: z.enum(['source-read', 'extrapolated']).nullable(),
  provenance: z.array(ProvenanceEntrySchema).max(16),
  warnings: z.array(EffectiveWarningSchema).max(32),
});

/** Step 1 for one key: the user and operator policy merged. Not the setting a queue has. */
export const MergedEntrySchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('value'),
    value: z.unknown(),
    rule: z.string().max(256).nullable(),
  }),
  z.strictObject({
    status: z.literal('unknown'),
    reason: z.literal('no-merge-rule'),
    userValue: z.unknown(),
    operatorValue: z.unknown(),
  }),
  z.strictObject({
    status: z.literal('invalid'),
    reason: z.string().max(512),
    userValue: z.unknown(),
    operatorValue: z.unknown(),
  }),
]);

export const EffectiveConfigSchema = z.strictObject({
  queueType: z.enum(QUEUE_TYPES),
  /** The version text the answer is for; null when it was unreadable. */
  version: z.string().max(64).nullable(),
  entries: z.record(z.string(), EffectiveEntrySchema),
  mergedPolicy: z.strictObject({
    notEffective: z.literal(true),
    entries: z.record(z.string(), MergedEntrySchema),
  }),
  /** Argument names no registry row uses: reported, never silently dropped. */
  unrecognisedArguments: z.array(z.string().max(TOPOLOGY_NAME_MAX)).max(256),
  warnings: z.array(EffectiveWarningSchema).max(32),
});
