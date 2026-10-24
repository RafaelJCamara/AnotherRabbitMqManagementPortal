// The dead-letter hazard (R7, W-OVERLIMIT, DC-07, amendment A-2). Where the delivery count is
// carried into a dead-letter target, a message that died for exceeding a source's limit arrives
// with a count above it, and the target's own doom rule drops or dead-letters it on ANY return,
// a peek included. This module decides, from the dead-letter evidence the preflight read, whether
// the peeked queue is `safe`, `blocked` or `unknown`.
//
// The two rules that matter most:
//  - An empty list of sources is "no hazard" ONLY when the evidence is complete (A-2). An
//    incomplete answer, an unknown source limit or an unknown own limit is `unknown`, which the
//    planner reads as a finite but unknown limit: a human consents, AI and unattended runs stop.
//  - A queue named by the x-death of held messages is a source even when no current queue feeds
//    the target (A-2). The planner merges `heldDeathSources` itself and does not trust the caller
//    to have done it.
//
// Nothing here names an era or a number: whether the era carries the count, how many failed
// deliveries a hold can add, and whether a count is doomed all come from the registry.
import type { Era } from '@app/domain-model';
import type { DeliveryLimit } from '@app/semantics';
import { carriesDeliveryCount, resolveCell, type LimitView } from './limit.ts';
import type {
  PeekPreflight,
  PlannerRegistry,
  PreflightQueue,
} from './types.ts';

export type UnknownWhy =
  | 'own-limit-unknown'
  | 'evidence-incomplete'
  | 'source-limit-unknown'
  | 'held-death-source-unknown';

export type BlockReason = 'dlx-sources-over-limit' | 'dlx-source-unbounded';

export type DlxVerdict =
  | { readonly kind: 'not-applicable' }
  | { readonly kind: 'safe' }
  | { readonly kind: 'unknown'; readonly why: readonly UnknownWhy[] }
  | {
      readonly kind: 'blocked';
      /** `dlx-source-unbounded` when a source has no limit, so its count has no ceiling. */
      readonly reasons: readonly [BlockReason, ...BlockReason[]];
      /** The sources that make it unsafe, sorted. */
      readonly sources: readonly string[];
      /** The lowest finite limit that is safe; null when a source is unlimited (only -1 is). */
      readonly minimumFinite: number | null;
    };

export interface DlxAssessment {
  readonly verdict: DlxVerdict;
  /** Whether the x-death of held messages was looked at (`heldDeathSources` present). */
  readonly heldDeath: 'covered' | 'not-checked';
  /** The registry row for a failed delivery was missing, so one was assumed (R12). */
  readonly gap: string | null;
}

interface Source {
  readonly queue: string;
  readonly limit: DeliveryLimit;
}

const compareText = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/** The evidence is complete only when it says so and lists no unknown (defence in depth). */
const isComplete = (evidence: PeekPreflight['dlxSources']): boolean =>
  evidence.complete && evidence.unknownReasons.length === 0;

/** The sources of the evidence plus every queue of an x-death that is not among them (unknown limit). */
function mergedSources(preflight: PeekPreflight): {
  sources: Source[];
  addedFromDeaths: string[];
} {
  const byQueue = new Map<string, Source>();
  for (const source of preflight.dlxSources.sources) {
    byQueue.set(source.queue, { queue: source.queue, limit: source.limit });
  }
  const addedFromDeaths: string[] = [];
  for (const queue of preflight.heldDeathSources ?? []) {
    if (!byQueue.has(queue)) {
      byQueue.set(queue, { queue, limit: { kind: 'unknown' } });
      addedFromDeaths.push(queue);
    }
  }
  return {
    sources: [...byQueue.values()].sort((a, b) =>
      compareText(a.queue, b.queue),
    ),
    addedFromDeaths,
  };
}

/** True only for a queue that nothing dead-letters into and whose x-death was looked at (A-3). */
export function provablyNonDlx(preflight: PeekPreflight): boolean {
  return (
    isComplete(preflight.dlxSources) &&
    preflight.heldDeathSources !== undefined &&
    mergedSources(preflight).sources.length === 0
  );
}

export interface DlxInput {
  readonly registry: PlannerRegistry;
  readonly era: Era;
  readonly queue: PreflightQueue;
  readonly limit: LimitView;
  readonly preflight: PeekPreflight;
}

/**
 * The lowest finite limit for which no count in `worst` is doomed, found by asking the registry
 * (the rule is monotonic: a higher limit never dooms more). Starts at the highest count, so a
 * strict rule answers it in one step; bounded, so a strange rule cannot loop.
 */
function lowestSafeLimit(
  registry: PlannerRegistry,
  era: Era,
  worst: readonly number[],
): number {
  const doomedAt = (limit: number): boolean =>
    worst.some((count) =>
      registry.isDoomed(
        era,
        { deliveryCount: count },
        { kind: 'finite', value: limit },
      ),
    );
  let candidate = Math.max(...worst);
  for (let step = 0; step < 8 && doomedAt(candidate); step += 1) candidate += 1;
  for (
    let step = 0;
    step < 8 && candidate > 1 && !doomedAt(candidate - 1);
    step += 1
  ) {
    candidate -= 1;
  }
  return candidate;
}

export function assessDlxHazard(input: DlxInput): DlxAssessment {
  const { registry, era, queue, limit, preflight } = input;
  const heldDeath =
    preflight.heldDeathSources === undefined ? 'not-checked' : 'covered';
  const none = (kind: 'not-applicable'): DlxAssessment => ({
    verdict: { kind },
    heldDeath,
    gap: null,
  });

  if (queue.type !== 'quorum') return none('not-applicable');
  if (limit.basis === 'unlimited') return none('not-applicable');
  if (!carriesDeliveryCount(registry, era)) return none('not-applicable');
  if (limit.basis === 'finite-unknown' || limit.value === undefined) {
    return {
      verdict: { kind: 'unknown', why: ['own-limit-unknown'] },
      heldDeath,
      gap: null,
    };
  }

  // A failed delivery while holding adds this much to a count that arrived at the source's limit + 1.
  const failed = resolveCell(registry, {
    era,
    queueType: 'quorum',
    protocol: 'amqp091',
    action: 'close_while_holding',
    limitState: 'finite',
    delayedRetryMatters: false,
  });
  const extra = failed?.cell.effect?.deltaDC ?? 1;
  const gap = failed === null ? 'close_while_holding' : failed.gap;

  const { sources, addedFromDeaths } = mergedSources(preflight);
  const target: DeliveryLimit = { kind: 'finite', value: limit.value };
  const over: string[] = [];
  const unbounded: string[] = [];
  const unknownSources: string[] = [];
  const worst: number[] = [];
  for (const source of sources) {
    if (source.limit.kind === 'unlimited') {
      unbounded.push(source.queue);
    } else if (source.limit.kind === 'unknown') {
      unknownSources.push(source.queue);
    } else {
      const count = source.limit.value + 1 + extra;
      worst.push(count);
      if (registry.isDoomed(era, { deliveryCount: count }, target)) {
        over.push(source.queue);
      }
    }
  }

  if (over.length > 0 || unbounded.length > 0) {
    const reasons: [BlockReason, ...BlockReason[]] =
      over.length > 0
        ? unbounded.length > 0
          ? ['dlx-sources-over-limit', 'dlx-source-unbounded']
          : ['dlx-sources-over-limit']
        : ['dlx-source-unbounded'];
    return {
      verdict: {
        kind: 'blocked',
        reasons,
        sources: [...over, ...unbounded].sort(compareText),
        minimumFinite:
          unbounded.length > 0 ? null : lowestSafeLimit(registry, era, worst),
      },
      heldDeath,
      gap,
    };
  }

  const why: UnknownWhy[] = [];
  if (!isComplete(preflight.dlxSources)) why.push('evidence-incomplete');
  if (unknownSources.length > addedFromDeaths.length) {
    why.push('source-limit-unknown');
  }
  if (addedFromDeaths.length > 0) why.push('held-death-source-unknown');
  if (why.length > 0) {
    return { verdict: { kind: 'unknown', why }, heldDeath, gap };
  }
  return { verdict: { kind: 'safe' }, heldDeath, gap };
}
