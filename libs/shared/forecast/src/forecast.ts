// Drain ETA and time to a limit (MON-05, blueprint section 8): an adaptive-window regression on the
// recent history, trusted only when it explains the data. The window is the longest recent stretch
// that a straight line fits with R2 at or above the gate, so a queue that filled for an hour and has
// been draining for ten minutes is forecast from the ten minutes. A series no window can explain is
// answered `no-reliable-forecast`, never with a guess, and a series that is too short is
// `insufficient-data`, with what would be enough (I-13: the gap is stated, not papered over).
import { linearFit, tQuantile95, type LinearFit } from './regression.ts';
import { cleanSeries, type Point } from './series.ts';

export interface ForecastOptions {
  /** The fewest points a window may have. Default 8. */
  readonly minPoints?: number;
  /** The shortest time a window may cover. Default one minute. */
  readonly minSpanMs?: number;
  /** The R2 a window must reach to be trusted. Default 0.95. */
  readonly minR2?: number;
  /** An ETA further away than this is not offered. Default 30 days. */
  readonly horizonMs?: number;
  /** Each shorter window keeps this share of the points of the one before. Default 0.75. */
  readonly shrink?: number;
}

export const DEFAULT_FORECAST_OPTIONS = {
  minPoints: 8,
  minSpanMs: 60_000,
  minR2: 0.95,
  horizonMs: 30 * 24 * 3_600_000,
  shrink: 0.75,
} as const;

export type Direction = 'falling' | 'rising';

export type LimitForecast =
  | {
      readonly state: 'ok';
      readonly etaMs: number;
      /** The 95 % band of the ETA; `highMs` is null when the slope could be flat within it. */
      readonly band: { readonly lowMs: number; readonly highMs: number | null };
      /** Change of the value per second (negative when falling). */
      readonly ratePerSec: number;
      readonly r2: number;
      readonly windowMs: number;
      readonly points: number;
    }
  | { readonly state: 'reached' }
  | {
      readonly state: 'moving-away';
      readonly ratePerSec: number;
      readonly r2: number;
      readonly reason: 'flat' | 'away' | 'beyond-horizon';
    }
  | {
      readonly state: 'no-reliable-forecast';
      readonly r2: number;
      readonly windowMs: number;
      readonly points: number;
    }
  | {
      readonly state: 'insufficient-data';
      readonly points: number;
      readonly spanMs: number;
      readonly needed: { readonly points: number; readonly spanMs: number };
    };

/** The drain ETA is the time to reach zero: `reached` is an empty queue, `moving-away` is not draining. */
export type DrainForecast = LimitForecast;

type Resolved = Required<ForecastOptions>;

function resolve(options: ForecastOptions): Resolved {
  const merged = { ...DEFAULT_FORECAST_OPTIONS, ...options };
  if (
    !Number.isInteger(merged.minPoints) ||
    merged.minPoints < 3 ||
    !(merged.minSpanMs >= 0) ||
    !(merged.minR2 >= 0 && merged.minR2 <= 1) ||
    !(merged.horizonMs > 0) ||
    !(merged.shrink > 0 && merged.shrink < 1)
  ) {
    throw new RangeError('The forecast options are out of range.');
  }
  return merged;
}

interface Window {
  readonly fit: LinearFit;
  readonly start: number;
}

/** The longest suffix window that reaches `minR2`; else the best attempt (`trusted: false`). */
function chooseWindow(
  series: readonly Point[],
  options: Resolved,
): { window: Window; trusted: boolean } | undefined {
  let best: Window | undefined;
  let size = series.length;
  while (size >= options.minPoints) {
    const start = series.length - size;
    const slice = series.slice(start);
    const first = slice[0];
    const last = slice.at(-1);
    if (first === undefined || last === undefined) break;
    if (last.t - first.t < options.minSpanMs) break;
    const fit = linearFit(slice);
    if (fit.r2 >= options.minR2)
      return { window: { fit, start }, trusted: true };
    if (best === undefined || fit.r2 > best.fit.r2) best = { fit, start };
    const next = Math.floor(size * options.shrink);
    size = next < size ? next : size - 1;
  }
  return best === undefined ? undefined : { window: best, trusted: false };
}

/**
 * When the series reaches `limit`, moving in `direction`. States: `reached` (the latest value is
 * already there), `insufficient-data`, `no-reliable-forecast`, `moving-away` (flat, the wrong way,
 * or further than the horizon) and `ok` with a 95 % band.
 */
export function timeToLimit(
  points: readonly Point[],
  limit: number,
  direction: Direction,
  options: ForecastOptions = {},
): LimitForecast {
  if (!Number.isFinite(limit)) throw new RangeError('limit must be finite.');
  const resolved = resolve(options);
  const series = cleanSeries(points);
  const latest = series.at(-1);
  const oldest = series[0];
  if (
    latest !== undefined &&
    (direction === 'falling' ? latest.v <= limit : latest.v >= limit)
  ) {
    return { state: 'reached' };
  }
  const spanMs =
    latest === undefined || oldest === undefined ? 0 : latest.t - oldest.t;
  if (series.length < resolved.minPoints || spanMs < resolved.minSpanMs) {
    return {
      state: 'insufficient-data',
      points: series.length,
      spanMs,
      needed: { points: resolved.minPoints, spanMs: resolved.minSpanMs },
    };
  }
  const chosen = chooseWindow(series, resolved);
  if (chosen === undefined) {
    return {
      state: 'insufficient-data',
      points: series.length,
      spanMs,
      needed: { points: resolved.minPoints, spanMs: resolved.minSpanMs },
    };
  }
  const { fit } = chosen.window;
  if (!chosen.trusted) {
    return {
      state: 'no-reliable-forecast',
      r2: fit.r2,
      windowMs: fit.spanMs,
      points: fit.n,
    };
  }
  const towards = direction === 'falling' ? -fit.slope : fit.slope;
  if (towards <= 0) {
    return {
      state: 'moving-away',
      ratePerSec: fit.slope,
      r2: fit.r2,
      reason: fit.slope === 0 ? 'flat' : 'away',
    };
  }
  const distance = Math.max(0, Math.abs(limit - fit.current));
  const etaMs = (distance / towards) * 1000;
  if (etaMs > resolved.horizonMs) {
    return {
      state: 'moving-away',
      ratePerSec: fit.slope,
      r2: fit.r2,
      reason: 'beyond-horizon',
    };
  }
  const margin = tQuantile95(fit.n - 2) * fit.slopeError;
  const slowest = towards - margin;
  return {
    state: 'ok',
    etaMs,
    band: {
      lowMs: (distance / (towards + margin)) * 1000,
      highMs: slowest > 0 ? (distance / slowest) * 1000 : null,
    },
    ratePerSec: fit.slope,
    r2: fit.r2,
    windowMs: fit.spanMs,
    points: fit.n,
  };
}

/** The drain ETA: the time for a backlog to fall to zero at its recent trend. */
export function drainEta(
  points: readonly Point[],
  options: ForecastOptions = {},
): DrainForecast {
  return timeToLimit(points, 0, 'falling', options);
}
