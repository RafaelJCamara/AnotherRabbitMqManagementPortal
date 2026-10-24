// The delivery limit of the peeked queue and everything the planner asks the registry about it
// (R3, R6, R12). No broker version or era name is compared here: the doom rule is probed through
// `isDoomed`, and every effect is a settle cell looked up by (era, queue type, protocol, action,
// limit state). A missing row is a gap, handled with a conservative substitute and reported.
import type { Era, QueueType } from '@app/domain-model';
import {
  cellKeyString,
  SemanticsGapError,
  type CellKey,
  type DelayedRetry,
  type LimitState,
  type SemanticsCell,
  type SettleAction,
} from '@app/semantics';
import type {
  LimitBasis,
  LimitReason,
  PeekPreflight,
  PlannerRegistry,
  PreflightQueue,
} from './types.ts';

/** The era whose rules `semantics.md` and the caps lookup use when a row is missing. */
export const CONSERVATIVE_ERA: Era = '4.0-4.2';

/** The nominal limit the doom rule is probed with, and the largest estimate of A-2. */
export const PROBE_LIMIT = 20;

/** What the planner knows about the queue's own limit, before the dead-letter evidence is added. */
export interface LimitView {
  readonly basis: LimitBasis;
  /** The finite limit, when `basis` is `finite`. */
  readonly value?: number;
  /** The configured form used to look up cells; `finite` stands in for an unknown limit. */
  readonly state: LimitState;
  readonly reasons: readonly LimitReason[];
}

const isPositiveInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 1;

/**
 * Reads the limit of a queue (R3). A classic queue has none. A quorum queue's `DeliveryLimit` and
 * `limitState` must agree: `finite` with `finite`, `unlimited` with `unset` or `minus1`; anything
 * else is incoherent and read as unknown, which is the dangerous reading (A-2).
 */
export function readLimit(queue: PreflightQueue): LimitView {
  if (queue.type !== 'quorum') {
    return { basis: 'unlimited', state: 'unset', reasons: [] };
  }
  const { deliveryLimit: limit, limitState: state } = queue;
  if (limit.kind === 'unknown') {
    return {
      basis: 'finite-unknown',
      state: 'finite',
      reasons: ['own-limit-unknown'],
    };
  }
  if (limit.kind === 'unlimited') {
    if (state === 'unset' || state === 'minus1') {
      return { basis: 'unlimited', state, reasons: [] };
    }
  } else if (state === 'finite' && isPositiveInteger(limit.value)) {
    return { basis: 'finite', value: limit.value, state, reasons: [] };
  }
  return {
    basis: 'finite-unknown',
    state: 'finite',
    reasons: ['limit-incoherent'],
  };
}

/**
 * The operator of the doom rule, probed: a finite limit with the counter exactly at it. `>=` when
 * the registry says that message is doomed, `>` when it is not. Nothing here names an era.
 */
export function doomedOperator(
  registry: PlannerRegistry,
  era: Era,
): '>' | '>=' {
  return registry.isDoomed(
    era,
    { deliveryCount: PROBE_LIMIT },
    { kind: 'finite', value: PROBE_LIMIT },
  )
    ? '>='
    : '>';
}

/**
 * Whether the era delivers the delivery count into a dead-letter target (W-OVERLIMIT). The
 * registry has no row for it (OQ-390), so it is inferred from the doom rule: the count is the
 * limit counter and the comparison is strict (OQ-1422). A test pins an answer for every `Era`.
 */
export function carriesDeliveryCount(
  registry: PlannerRegistry,
  era: Era,
): boolean {
  const limit = { kind: 'finite', value: PROBE_LIMIT } as const;
  return (
    !registry.isDoomed(era, { deliveryCount: PROBE_LIMIT }, limit) &&
    registry.isDoomed(era, { deliveryCount: PROBE_LIMIT + 1 }, limit)
  );
}

export interface CellRequest {
  readonly era: Era;
  readonly queueType: QueueType;
  readonly protocol: CellKey['protocol'];
  readonly action: SettleAction;
  readonly limitState: LimitState;
  /** The delayed-retry type the preflight read; absent when it was not read. */
  readonly delayedRetry?: DelayedRetry | undefined;
  /**
   * False for a cell whose effect does not depend on delayed retry (a consumer timeout, a close):
   * the type is then not part of the key that is tried first, and `disabled` is no assumption.
   */
  readonly delayedRetryMatters?: boolean | undefined;
}

export interface CellResolution {
  readonly cell: SemanticsCell;
  /**
   * The key that was asked for when a conservative substitute answered instead (R12); null when
   * the first choice answered.
   */
  readonly gap: string | null;
  /**
   * The cell is keyed by delayed retry and the preflight did not read it, so `disabled` was
   * assumed: the planner adds W-DELAY because messages may be held back.
   */
  readonly delayedRetryUnread: boolean;
}

function tryCell(
  registry: PlannerRegistry,
  key: CellKey,
): SemanticsCell | null {
  try {
    return registry.cell(key);
  } catch (error) {
    if (error instanceof SemanticsGapError) return null;
    throw error;
  }
}

/**
 * Looks a cell up (R3, R12). Within one (era, limit) pair the delayed-retry dimension is tried
 * first as read, then not at all (eras whose cells do not have it), then as `disabled` when it was
 * not read. If nothing answers, the same era with limit `finite`, then the conservative era with
 * the limit state, then with `finite`. Null when no row answers (SEMANTICS_GAP).
 */
export function resolveCell(
  registry: PlannerRegistry,
  request: CellRequest,
): CellResolution | null {
  const { era, queueType, protocol, action } = request;
  const matters = request.delayedRetryMatters ?? true;
  const delayedRetry = matters ? request.delayedRetry : undefined;
  const base = { queueType, protocol, action };
  const pairs: { era: Era; limit: LimitState }[] = [];
  for (const candidateEra of [era, CONSERVATIVE_ERA]) {
    for (const limit of [request.limitState, 'finite'] as const) {
      if (!pairs.some((p) => p.era === candidateEra && p.limit === limit)) {
        pairs.push({ era: candidateEra, limit });
      }
    }
  }
  const asked = cellKeyString({
    era,
    ...base,
    limit: request.limitState,
    ...(delayedRetry === undefined ? {} : { delayedRetry }),
  });
  for (const [index, pair] of pairs.entries()) {
    const key = { era: pair.era, ...base, limit: pair.limit };
    const variants: { key: CellKey; unread: boolean }[] = [];
    if (delayedRetry !== undefined) {
      variants.push({ key: { ...key, delayedRetry }, unread: false });
    }
    variants.push({ key, unread: false });
    if (delayedRetry === undefined) {
      variants.push({
        key: { ...key, delayedRetry: 'disabled' },
        unread: matters,
      });
    }
    for (const variant of variants) {
      const cell = tryCell(registry, variant.key);
      if (cell !== null) {
        return {
          cell,
          gap: index === 0 ? null : asked,
          delayedRetryUnread: variant.unread,
        };
      }
    }
  }
  return null;
}

/** The estimate of A-2: the lowest finite limit seen anywhere, at most 20. */
export function estimateLimit(visible: readonly number[]): number {
  let lowest = PROBE_LIMIT;
  for (const value of visible) {
    if (isPositiveInteger(value) && value < lowest) lowest = value;
  }
  return lowest;
}

/** Every finite limit the preflight shows: the queue's, the disagreeing pair and the sources'. */
export function visibleLimits(preflight: PeekPreflight): number[] {
  const seen: number[] = [...(preflight.queue.visibleLimits ?? [])];
  const disagreement = preflight.queue.limitDisagreement;
  for (const limit of [
    disagreement?.stat,
    disagreement?.computed,
    ...preflight.dlxSources.sources.map((source) => source.limit),
  ]) {
    if (limit?.kind === 'finite') seen.push(limit.value);
  }
  return seen;
}
