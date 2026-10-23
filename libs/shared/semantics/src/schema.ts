// The registry's cell types (blueprint 5.2, core-interfaces.md "@app/semantics"), written once in
// zod so that the data files are validated when the registry is built. Replaces the stand-in types
// the `semantics-cell` generator creates (OQ-61).
//
// A cell says what a settle action does to the counters and the position of a message for one
// era, queue type, protocol and limit state. It starts `code-derived`: read off the broker source
// and the docs, cited, and linked to the conformance ids that will record independent lab
// evidence. It only leaves `code-derived` when that evidence exists and a human has signed it off
// (I-14); nothing in this library sets a status or writes evidence.
import { CellIdSchema, ConformanceIdSchema } from '@app/contracts';
import { EraSchema, QueueTypeSchema } from '@app/domain-model';
import { z } from 'zod';

export const ProtocolSchema = z.enum(['amqp091', 'amqp10', 'http']);
export type Protocol = z.infer<typeof ProtocolSchema>;

export const SettleActionSchema = z.enum([
  'amqp091.nack_requeue',
  'amqp091.reject_requeue',
  'amqp091.no_requeue',
  'amqp10.released',
  'amqp10.modified_df_false',
  'amqp10.modified_df_true',
  'amqp10.rejected',
  'close_while_holding',
  'tcp_loss',
  'partition',
  'amqp10.detach_unsettled',
  'consumer_timeout',
  'http.ack_requeue_true',
]);
export type SettleAction = z.infer<typeof SettleActionSchema>;

export const LimitStateSchema = z.enum(['unset', 'finite', 'minus1']);
export type LimitState = z.infer<typeof LimitStateSchema>;

export const DelayedRetrySchema = z.enum([
  'disabled',
  'all',
  'failed',
  'returned',
]);
export type DelayedRetry = z.infer<typeof DelayedRetrySchema>;

/** What a lookup is keyed by. `limit` and `delayedRetry` are part of the key only when set. */
export const CellKeySchema = z.strictObject({
  era: EraSchema,
  queueType: QueueTypeSchema,
  protocol: ProtocolSchema,
  action: SettleActionSchema,
  limit: LimitStateSchema.optional(),
  delayedRetry: DelayedRetrySchema.optional(),
});
export type CellKey = z.infer<typeof CellKeySchema>;

export const SettleEffectSchema = z.strictObject({
  deltaAC: z.union([z.literal(0), z.literal(1)]),
  deltaDC: z.union([z.literal(0), z.literal(1)]),
  countsTowardLimit: z.enum(['yes', 'no', 'if-dc-gt-limit', 'if-limit-set']),
  position: z.enum([
    'head',
    'tail',
    'original',
    'delayed',
    'dlx-or-drop',
    'removed',
  ]),
  destructive: z.boolean(),
});
export type SettleEffect = z.infer<typeof SettleEffectSchema>;

/**
 * Where a claim comes from: S broker source, D official docs, RN release notes, GH an issue or
 * pull request, M3 the semantics matrix, LAB a recorded lab run.
 */
export const CitationSchema = z.strictObject({
  kind: z.enum(['S', 'D', 'RN', 'GH', 'M3', 'LAB']),
  ref: z.string().min(1),
});
export type Citation = z.infer<typeof CitationSchema>;

/** `code-derived` until lab evidence exists; the other two are set by humans with evidence. */
export const CellStatusSchema = z.enum([
  'code-derived',
  'lab-verified',
  'lab-contradicted',
]);
export type CellStatus = z.infer<typeof CellStatusSchema>;

/** `testing/lab-evidence/<broker-version>/<CF-id>.json`, recorded by CI and approved by a human. */
export const EVIDENCE_PATH =
  /^testing\/lab-evidence\/[0-9A-Za-z.+-]+\/CF-[A-Z0-9-]+\.json$/;
export const EvidencePathSchema = z.string().regex(EVIDENCE_PATH);

export const SemanticsCellSchema = z.strictObject({
  id: CellIdSchema,
  key: CellKeySchema,
  /**
   * Null until the effect is derived from the cited sources. A lookup treats a null effect as a
   * gap and fails closed, exactly like a missing cell.
   */
  effect: SettleEffectSchema.nullable(),
  citations: z.array(CitationSchema),
  conformance: z.array(ConformanceIdSchema),
  status: CellStatusSchema,
  evidence: z.array(EvidencePathSchema),
});
export type SemanticsCell = z.infer<typeof SemanticsCellSchema>;

/** The key as one string, with an unset `limit` or `delayedRetry` written as `-`. */
export function cellKeyString(key: CellKey): string {
  return [
    key.era,
    key.queueType,
    key.protocol,
    key.action,
    key.limit ?? '-',
    key.delayedRetry ?? '-',
  ].join('|');
}

/** A lookup other than a cell: a table name and the identifier that was not found. */
export interface TableKey {
  readonly table:
    | 'warning'
    | 'gate'
    | 'peek-caps'
    | 'capability'
    | 'provider-preset'
    | 'effective-config';
  readonly id: string;
}
export type GapKey = CellKey | TableKey;

function describeGap(key: GapKey): string {
  return 'table' in key
    ? `${key.table} ${key.id}`
    : `cell ${cellKeyString(key)}`;
}

/** Thrown when registry data is invalid: a build-time failure, never a lookup outcome. */
export class RegistryDataError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`invalid semantics registry data:\n- ${problems.join('\n- ')}`);
    this.name = 'RegistryDataError';
    this.problems = problems;
  }
}

/**
 * Thrown when the registry has no (usable) entry for a lookup. Callers handle it conservatively:
 * the planner uses the 4.0-4.2 rules, asks for extra consent and rejects unattended plans
 * (blueprint 5.2). It is never caught to supply a default.
 */
export class SemanticsGapError extends Error {
  /** The contracts error code the engine maps this to. */
  readonly code = 'SEMANTICS_GAP';
  readonly key: GapKey;

  constructor(key: GapKey, reason?: string) {
    super(
      `semantics gap: no entry for ${describeGap(key)}${reason === undefined ? '' : ` (${reason})`}`,
    );
    this.name = 'SemanticsGapError';
    this.key = key;
  }
}
