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

// --- The graph of a vhost (topology.graph, topology.subgraph) ------------------------------------

/** Nodes plus edges one answer carries, at most (I-7). */
export const GRAPH_ELEMENTS_MAX = 2_000;
/** The smallest cap that still leaves room for a focus and its aggregates. */
export const GRAPH_ELEMENTS_MIN = 10;
/** A subgraph reaches this many hops from its focus, at most. */
export const SUBGRAPH_DEPTH_MAX = 2;
/** Names an aggregate node lists of what it folded. */
export const AGGREGATE_SAMPLE_MAX = 5;

export const GRAPH_OBJECT_KINDS = ['exchange', 'queue'] as const;
export const GraphFocusSchema = z.strictObject({
  kind: z.enum(GRAPH_OBJECT_KINDS),
  name: z.string().max(TOPOLOGY_NAME_MAX),
});

export const GraphNodeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    id: z.string().max(TOPOLOGY_NAME_MAX + 2),
    kind: z.literal('exchange'),
    name: z.string().max(TOPOLOGY_NAME_MAX),
    type: z.string().max(64),
    internal: z.boolean(),
    /** The exchange has neighbours that this answer does not show one by one. */
    hasMore: z.boolean(),
  }),
  z.strictObject({
    id: z.string().max(TOPOLOGY_NAME_MAX + 2),
    kind: z.literal('queue'),
    name: z.string().max(TOPOLOGY_NAME_MAX),
    type: z.enum(QUEUE_TYPES).nullable(),
    hasMore: z.boolean(),
  }),
  /** Objects folded together because the answer is capped: how many, and a few names. */
  z.strictObject({
    id: z.string().max(TOPOLOGY_NAME_MAX + 16),
    kind: z.literal('aggregate'),
    of: z.enum(GRAPH_OBJECT_KINDS),
    count: z.number().int().min(1),
    sample: z
      .array(z.string().max(TOPOLOGY_NAME_MAX))
      .max(AGGREGATE_SAMPLE_MAX),
    /** The id of the node they hang from; null when they are linked to nothing that is shown. */
    via: z
      .string()
      .max(TOPOLOGY_NAME_MAX + 2)
      .nullable(),
  }),
]);

export const GraphEdgeSchema = z.strictObject({
  id: z.string().max(2 * TOPOLOGY_NAME_MAX + 512),
  kind: z.enum(['binding', 'alternate-exchange', 'dead-letter', 'aggregate']),
  from: z.string().max(TOPOLOGY_NAME_MAX + 16),
  to: z.string().max(TOPOLOGY_NAME_MAX + 16),
  /** The routing key of a binding, or the fixed dead-letter routing key; null otherwise. */
  label: z.string().max(TOPOLOGY_NAME_MAX).nullable(),
  /** Bindings or links behind the edge: 1, or more for an aggregate edge. */
  count: z.number().int().min(1),
});

export const TopologyGraphSchema = z.strictObject({
  nodes: z.array(GraphNodeSchema).max(GRAPH_ELEMENTS_MAX),
  edges: z.array(GraphEdgeSchema).max(GRAPH_ELEMENTS_MAX),
  /** Nodes plus edges in this answer; never above the cap asked for. */
  elements: z.number().int().nonnegative().max(GRAPH_ELEMENTS_MAX),
  /**
   * True when the scope did not fit: objects were folded into aggregate nodes, or parallel edges
   * (the same ends and kind) were merged into one edge that counts them.
   */
  aggregated: z.boolean(),
  /** What the scope held and the answer does not show one by one. */
  omitted: z.strictObject({ nodes: count, edges: count }),
  /** The scope before the cap: the whole vhost, or the neighbourhood of the focus. */
  scope: z.strictObject({ nodes: count, edges: count }),
  /** Exact figures of the vhost. `unrepresented`: implicit bindings of the default exchange and links to nothing in the vhost. */
  totals: z.strictObject({
    exchanges: count,
    queues: count,
    bindings: count,
    links: count,
    unrepresented: count,
  }),
  focus: GraphFocusSchema.nullable(),
  depth: z.number().int().min(0).max(SUBGRAPH_DEPTH_MAX).nullable(),
});
export type TopologyGraph = z.infer<typeof TopologyGraphSchema>;
export type GraphNode = z.infer<typeof GraphNodeSchema>;
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

/** The answer of topology.graph and topology.subgraph. */
export const GraphAnswerSchema = z.strictObject({
  vhost: VhostNameSchema,
  graph: TopologyGraphSchema,
  gaps: TopologyGapsSchema,
  snapshot: SnapshotMetaSchema,
});
export type GraphAnswer = z.infer<typeof GraphAnswerSchema>;

/** `maxElements` of an input: the cap the caller wants, within the ceiling of the contract. */
export const MaxElementsSchema = z
  .number()
  .int()
  .min(GRAPH_ELEMENTS_MIN)
  .max(GRAPH_ELEMENTS_MAX);
