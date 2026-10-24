// The hold budget (R5, blueprint 5.4): how long the peek may keep messages unacknowledged and how
// many it may take in that time.
//
//   hardAbort = min(30 s, ttl / 4, queue-level timeout / 4  |  channel-level timeout - 90 s)
//   target    = min(5 s, hardAbort)
//   count    <= floor(target / measured round trip)
//
// Which timeout formula applies is the registry's answer, not an era name: a consumer timeout that
// adds no failed delivery (`deltaDC` 0) is the queue-level kind of 4.3, one that does is the
// channel-level close of earlier versions. No cell (a classic queue, a gap) applies both.
import type { SemanticsCell } from '@app/semantics';
import type { HoldBound } from './types.ts';

export const HARD_CAP_MS = 30_000;
export const TARGET_CAP_MS = 5_000;
/** The channel-level timeout must not fire while the peek holds: leave this much of it. */
export const CHANNEL_MARGIN_MS = 90_000;
/** The broker default on every version (fact sheet b.5); the global value is not visible over HTTP. */
export const DEFAULT_CONSUMER_TIMEOUT_MS = 1_800_000;

export type TimeoutStyle = 'queue' | 'channel' | 'both';

/** Which formula the `consumer_timeout` cell selects; `null` (no cell) selects both. */
export function timeoutStyle(cell: SemanticsCell | null): TimeoutStyle {
  const effect = cell?.effect;
  if (effect === null || effect === undefined) return 'both';
  return effect.deltaDC === 0 ? 'queue' : 'channel';
}

export interface HoldInput {
  readonly ttlMs?: number | undefined;
  readonly consumerTimeoutMs?: number | undefined;
  readonly style: TimeoutStyle;
  readonly rttMs: number;
}

export type HoldFailure =
  | 'hold-hard-abort-too-small'
  | 'rtt-invalid'
  | 'rtt-exceeds-target';

export type HoldOutcome =
  | {
      readonly ok: true;
      readonly targetMs: number;
      readonly hardAbortMs: number;
      /** Every bound that equals the hard abort, in a fixed order. */
      readonly derivedFrom: readonly HoldBound[];
      /** `floor(target / rtt)`: the most messages one hold can take. */
      readonly maxCount: number;
    }
  | { readonly ok: false; readonly reason: HoldFailure };

const ORDER: readonly HoldBound[] = [
  'hard-cap',
  'message-ttl',
  'consumer-timeout',
  'channel-timeout',
];

/** A number that is not finite is a bound of zero: the budget fails closed. */
const bound = (value: number): number =>
  Number.isFinite(value) ? Math.floor(value) : 0;

export function holdBudget(input: HoldInput): HoldOutcome {
  const timeout = input.consumerTimeoutMs ?? DEFAULT_CONSUMER_TIMEOUT_MS;
  const bounds = new Map<HoldBound, number>([['hard-cap', HARD_CAP_MS]]);
  if (input.ttlMs !== undefined) {
    bounds.set('message-ttl', bound(input.ttlMs / 4));
  }
  if (input.style !== 'channel') {
    bounds.set('consumer-timeout', bound(timeout / 4));
  }
  if (input.style !== 'queue') {
    bounds.set('channel-timeout', bound(timeout - CHANNEL_MARGIN_MS));
  }
  const hardAbortMs = Math.min(...bounds.values());
  if (hardAbortMs <= 0)
    return { ok: false, reason: 'hold-hard-abort-too-small' };
  if (!Number.isFinite(input.rttMs) || input.rttMs <= 0) {
    return { ok: false, reason: 'rtt-invalid' };
  }
  const targetMs = Math.min(TARGET_CAP_MS, hardAbortMs);
  const maxCount = Math.floor(targetMs / input.rttMs);
  if (maxCount < 1) return { ok: false, reason: 'rtt-exceeds-target' };
  return {
    ok: true,
    targetMs,
    hardAbortMs,
    derivedFrom: ORDER.filter((name) => bounds.get(name) === hardAbortMs),
    maxCount,
  };
}
