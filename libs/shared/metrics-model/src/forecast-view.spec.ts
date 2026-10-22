import { describe, expect, it } from 'vitest';

import { forecastView } from './forecast-view';

const ok = {
  state: 'ok',
  etaMs: 600_000,
  band: { lowMs: 500_000, highMs: 700_000 },
  ratePerSec: -2.5,
  r2: 0.974,
  windowMs: 900_000,
  points: 60,
};

describe('M1-54 forecast view', () => {
  it('AC-11 every forecast state is explicit and an invalid one fails closed', () => {
    expect(forecastView(ok)).toEqual({
      state: 'ok',
      etaMs: 600_000,
      lowMs: 500_000,
      highMs: 700_000,
      ratePerSec: -2.5,
      r2Percent: 97,
      windowMs: 900_000,
      points: 60,
    });
    // No upper bound: the slope could be flat within the band.
    expect(
      forecastView({ ...ok, band: { lowMs: 500_000, highMs: null } }),
    ).toMatchObject({ state: 'ok', highMs: null });
    expect(forecastView({ state: 'reached' })).toEqual({ state: 'reached' });
    expect(
      forecastView({
        state: 'moving-away',
        ratePerSec: 1.5,
        r2: 0.99,
        reason: 'away',
      }),
    ).toEqual({
      state: 'moving-away',
      reason: 'away',
      ratePerSec: 1.5,
      r2Percent: 99,
    });
    // No reliable forecast carries the R2 and the window and never an ETA.
    const unreliable = forecastView({
      state: 'no-reliable-forecast',
      r2: 0.4,
      windowMs: 600_000,
      points: 40,
    });
    expect(unreliable).toEqual({
      state: 'no-reliable-forecast',
      r2Percent: 40,
      windowMs: 600_000,
      points: 40,
    });
    expect('etaMs' in unreliable).toBe(false);
    expect(
      forecastView({
        state: 'insufficient-data',
        points: 3,
        spanMs: 30_000,
        needed: { points: 8, spanMs: 60_000 },
      }),
    ).toEqual({
      state: 'insufficient-data',
      points: 3,
      spanMs: 30_000,
      needed: { points: 8, spanMs: 60_000 },
    });
  });

  it('AC-11 an ok that cannot be trusted, an unknown state and junk are unavailable', () => {
    const unavailable = { state: 'unavailable' };
    // The band must contain the ETA.
    expect(
      forecastView({ ...ok, band: { lowMs: 650_000, highMs: 700_000 } }),
    ).toEqual(unavailable);
    expect(
      forecastView({ ...ok, band: { lowMs: 100_000, highMs: 500_000 } }),
    ).toEqual(unavailable);
    // R2 is a share of 0..1, and numbers are counts.
    expect(forecastView({ ...ok, r2: 1.5 })).toEqual(unavailable);
    expect(forecastView({ ...ok, etaMs: -1 })).toEqual(unavailable);
    expect(forecastView({ ...ok, etaMs: 1.5 })).toEqual(unavailable);
    expect(forecastView({ ...ok, ratePerSec: Number.NaN })).toEqual(
      unavailable,
    );
    // Extra fields, an unknown state and anything else.
    expect(forecastView({ ...ok, extra: 1 })).toEqual(unavailable);
    expect(forecastView({ state: 'drained-soon' })).toEqual(unavailable);
    for (const junk of [null, undefined, 5, 'ok', [], {}]) {
      expect(forecastView(junk)).toEqual(unavailable);
    }
  });
});
