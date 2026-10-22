// Rates from counters, a smoothed rate, and the plain "backlog over net outflow" estimate.
import { cleanSeries, type Point } from './series.ts';

export interface CounterRateOptions {
  /**
   * Two samples further apart than this are not joined: the interval between them is a gap (a
   * node that was down, a paused scrape), and a rate over it would be a guess. Default: none.
   */
  readonly maxGapMs?: number;
}

/**
 * The per-second rate between consecutive samples of a counter, stamped at the later sample. An
 * interval where the counter went down is a reset (a restart): it is skipped, because the increase
 * before the reset is unknown and a negative rate would be false. An interval with no time, or a
 * gap past `maxGapMs`, is skipped too.
 */
export function counterRate(
  points: readonly Point[],
  options: CounterRateOptions = {},
): Point[] {
  const out: Point[] = [];
  let before: Point | undefined;
  for (const after of cleanSeries(points)) {
    const previous = before;
    before = after;
    if (previous === undefined) continue;
    const elapsed = after.t - previous.t;
    if (elapsed <= 0) continue;
    if (options.maxGapMs !== undefined && elapsed > options.maxGapMs) continue;
    const increase = after.v - previous.v;
    if (increase < 0) continue;
    out.push({ t: after.t, v: increase / (elapsed / 1000) });
  }
  return out;
}

/**
 * An exponentially weighted average that weighs by elapsed time, so uneven sampling does not skew
 * it: a sample `halfLifeMs` older counts half as much. Undefined for no points.
 */
export function ewma(
  points: readonly Point[],
  halfLifeMs: number,
): number | undefined {
  if (!(halfLifeMs > 0) || !Number.isFinite(halfLifeMs)) {
    throw new RangeError('halfLifeMs must be a positive finite number.');
  }
  let average: number | undefined;
  let before: Point | undefined;
  for (const point of cleanSeries(points)) {
    if (average === undefined || before === undefined) {
      average = point.v;
    } else {
      const weight = 1 - Math.pow(0.5, (point.t - before.t) / halfLifeMs);
      average += weight * (point.v - average);
    }
    before = point;
  }
  return average;
}

export type RateEta =
  | { readonly state: 'ok'; readonly etaMs: number }
  | { readonly state: 'reached' }
  | { readonly state: 'moving-away' };

/**
 * Drain ETA = backlog / (outflow - inflow), the blueprint's definition, for callers that have rates
 * and no history of the depth. Rates are per second and must be finite and not negative.
 */
export function drainEtaFromRates(
  backlog: number,
  inflowPerSec: number,
  outflowPerSec: number,
): RateEta {
  if (
    ![backlog, inflowPerSec, outflowPerSec].every(Number.isFinite) ||
    inflowPerSec < 0 ||
    outflowPerSec < 0
  ) {
    throw new RangeError(
      'backlog and rates must be finite; rates not negative.',
    );
  }
  if (backlog <= 0) return { state: 'reached' };
  const net = outflowPerSec - inflowPerSec;
  if (net <= 0) return { state: 'moving-away' };
  return { state: 'ok', etaMs: (backlog / net) * 1000 };
}
