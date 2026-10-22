// The forecast the engine sent, as a view the page words (M1-54, R5, MON-05). The UI never computes a forecast: it
// shows what `metrics.forecast` answered, every state explicit. An `ok` whose numbers cannot be trusted (not finite,
// an R2 outside 0..1, a band that does not contain the ETA) and anything the contract does not describe are
// `unavailable`: fail closed, never an invented ETA.
import { ForecastSchema } from '@app/contracts';

export type ForecastView =
  | {
      readonly state: 'ok';
      readonly etaMs: number;
      readonly lowMs: number;
      /** `null`: the slope could be flat within the band, so there is no upper bound. */
      readonly highMs: number | null;
      readonly ratePerSec: number;
      /** R2 as a percentage, rounded. */
      readonly r2Percent: number;
      readonly windowMs: number;
      readonly points: number;
    }
  | { readonly state: 'reached' }
  | {
      readonly state: 'moving-away';
      readonly reason: 'flat' | 'away' | 'beyond-horizon';
      readonly ratePerSec: number;
      readonly r2Percent: number;
    }
  | {
      readonly state: 'no-reliable-forecast';
      readonly r2Percent: number;
      readonly windowMs: number;
      readonly points: number;
    }
  | {
      readonly state: 'insufficient-data';
      readonly points: number;
      readonly spanMs: number;
      readonly needed: { readonly points: number; readonly spanMs: number };
    }
  | { readonly state: 'unavailable' };

const UNAVAILABLE: ForecastView = { state: 'unavailable' };
const percent = (r2: number): number => Math.round(r2 * 100);

/** `forecast` is the `forecast` field of a `metrics.forecast` answer, as received. */
export function forecastView(forecast: unknown): ForecastView {
  const parsed = ForecastSchema.safeParse(forecast);
  if (!parsed.success) return UNAVAILABLE;
  const f = parsed.data;
  switch (f.state) {
    case 'ok': {
      const { etaMs, band, ratePerSec, r2, windowMs, points } = f;
      const trusted =
        Number.isFinite(etaMs) &&
        Number.isFinite(ratePerSec) &&
        Number.isFinite(r2) &&
        band.lowMs <= etaMs &&
        (band.highMs === null || band.highMs >= etaMs);
      return trusted
        ? {
            state: 'ok',
            etaMs,
            lowMs: band.lowMs,
            highMs: band.highMs,
            ratePerSec,
            r2Percent: percent(r2),
            windowMs,
            points,
          }
        : UNAVAILABLE;
    }
    case 'reached':
      return { state: 'reached' };
    case 'moving-away':
      return Number.isFinite(f.ratePerSec)
        ? {
            state: 'moving-away',
            reason: f.reason,
            ratePerSec: f.ratePerSec,
            r2Percent: percent(f.r2),
          }
        : UNAVAILABLE;
    case 'no-reliable-forecast':
      return {
        state: 'no-reliable-forecast',
        r2Percent: percent(f.r2),
        windowMs: f.windowMs,
        points: f.points,
      };
    case 'insufficient-data':
      return {
        state: 'insufficient-data',
        points: f.points,
        spanMs: f.spanMs,
        needed: f.needed,
      };
  }
}
