import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { drainEta, timeToLimit, type LimitForecast } from './forecast.ts';
import type { Point } from './series.ts';

/** A small seeded generator: the specs never depend on `Math.random`. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const T0 = 1_760_000_000_000;

function lastOf(points: readonly Point[]): Point {
  const last = points.at(-1);
  if (last === undefined) throw new Error('the series is empty');
  return last;
}

/** `count` points `stepMs` apart, value `start + perSec * seconds + noise`. */
function line(
  count: number,
  stepMs: number,
  start: number,
  perSec: number,
  noise = 0,
  seed = 1,
): Point[] {
  const random = mulberry32(seed);
  return Array.from({ length: count }, (_, i) => ({
    t: T0 + i * stepMs,
    v: start + perSec * ((i * stepMs) / 1000) + (random() - 0.5) * 2 * noise,
  }));
}

const finiteForecast = (forecast: LimitForecast): boolean => {
  if (forecast.state !== 'ok') return true;
  const { lowMs, highMs } = forecast.band;
  return (
    Number.isFinite(forecast.etaMs) &&
    Number.isFinite(lowMs) &&
    (highMs === null || Number.isFinite(highMs)) &&
    lowMs <= forecast.etaMs + 1e-6 &&
    (highMs === null || forecast.etaMs <= highMs + 1e-6)
  );
};

describe('drainEta', () => {
  it('AC-1 a steady decline has a drain ETA with a confidence band', () => {
    // 60 points 10 s apart, 10,000 messages falling 5 per second: empty after 2,000 s from the start.
    const points = line(60, 10_000, 10_000, -5, 8);
    const last = lastOf(points);
    const trueEtaMs = (last.v / 5) * 1000;
    const forecast = drainEta(points);
    expect(forecast.state).toBe('ok');
    if (forecast.state !== 'ok') return;
    expect(forecast.r2).toBeGreaterThanOrEqual(0.95);
    expect(Math.abs(forecast.etaMs - trueEtaMs) / trueEtaMs).toBeLessThan(0.1);
    expect(forecast.band.lowMs).toBeLessThanOrEqual(forecast.etaMs);
    expect(forecast.band.highMs).not.toBeNull();
    expect(forecast.etaMs).toBeLessThanOrEqual(forecast.band.highMs ?? 0);
    // The band is a real interval, not a point.
    expect(forecast.band.lowMs).toBeLessThan(forecast.band.highMs ?? 0);
    expect(forecast.ratePerSec).toBeCloseTo(-5, 0);
    expect(forecast.points).toBeGreaterThanOrEqual(8);
  });

  it('AC-2 R2 below 0.95 is no reliable forecast', () => {
    // A downward drift buried in noise: no straight line explains it at any window.
    const points = line(60, 10_000, 1_000, -0.2, 400, 7);
    const forecast = drainEta(points);
    expect(forecast.state).toBe('no-reliable-forecast');
    if (forecast.state !== 'no-reliable-forecast') return;
    expect(forecast.r2).toBeLessThan(0.95);
    expect(forecast).not.toHaveProperty('etaMs');
    // The same series with a looser gate is trusted: the gate is what answered.
    expect(drainEta(points, { minR2: 0.0 }).state).toBe('ok');
  });

  it('AC-3 insufficient data, not draining, adaptive window, finite outputs', () => {
    // Too few points, and too short a span.
    expect(drainEta(line(5, 10_000, 100, -1)).state).toBe('insufficient-data');
    const short = drainEta(line(20, 1_000, 100, -1));
    expect(short.state).toBe('insufficient-data');
    if (short.state === 'insufficient-data') {
      expect(short.needed).toEqual({ points: 8, spanMs: 60_000 });
      expect(short.points).toBe(20);
    }
    expect(drainEta([]).state).toBe('insufficient-data');

    // Flat and growing backlogs are not draining; an empty queue has reached zero.
    const flat = drainEta(line(30, 10_000, 500, 0));
    expect(flat).toMatchObject({ state: 'moving-away', reason: 'flat' });
    const growing = drainEta(line(30, 10_000, 500, 2));
    expect(growing).toMatchObject({ state: 'moving-away', reason: 'away' });
    expect(drainEta(line(30, 10_000, 0, 0)).state).toBe('reached');

    // A backlog that filled, then drains: the forecast follows the recent slope, not the whole hour.
    const filling = line(40, 10_000, 0, 10);
    const peak = lastOf(filling).v;
    const draining = line(30, 10_000, peak, -5).map((point, i) => ({
      t: T0 + (40 + i) * 10_000,
      v: point.v,
    }));
    const forecast = drainEta([...filling, ...draining]);
    expect(forecast.state).toBe('ok');
    if (forecast.state === 'ok') {
      expect(forecast.ratePerSec).toBeCloseTo(-5, 0);
      expect(forecast.windowMs).toBeLessThanOrEqual(30 * 10_000);
    }

    // A far-away drain is not offered.
    const slow = drainEta(line(30, 10_000, 1_000_000, -0.01));
    expect(slow).toMatchObject({
      state: 'moving-away',
      reason: 'beyond-horizon',
    });

    // Bad input is cleaned, never thrown on; bad options are refused.
    const dirty: Point[] = [
      ...line(30, 10_000, 1_000, -2),
      { t: Number.NaN, v: 1 },
      { t: T0, v: Number.POSITIVE_INFINITY },
    ];
    expect(drainEta(dirty).state).toBe('ok');
    expect(() => drainEta(dirty, { minPoints: 2 })).toThrow(RangeError);
    expect(() => drainEta(dirty, { shrink: 1 })).toThrow(RangeError);

    // Property: whatever the series, an `ok` answer is finite and its band is ordered.
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            t: fc.integer({ min: 0, max: 3_600_000 }),
            v: fc.double({ min: -1e6, max: 1e6, noNaN: true }),
          }),
          { maxLength: 80 },
        ),
        (raw) => {
          const forecast = drainEta(raw.map((p) => ({ t: T0 + p.t, v: p.v })));
          return finiteForecast(forecast);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('AC-3 a rising limit has a time to reach it, with the same gate', () => {
    // Disk free falls towards its limit of 50 at 2 per second; it was 3,000 at the start.
    const points = line(40, 15_000, 3_000, -2, 1, 3);
    const toLimit = timeToLimit(points, 50, 'falling');
    expect(toLimit.state).toBe('ok');
    const latest = lastOf(points);
    if (toLimit.state === 'ok') {
      const expected = ((latest.v - 50) / 2) * 1000;
      expect(Math.abs(toLimit.etaMs - expected) / expected).toBeLessThan(0.05);
    }
    // Moving the other way towards a limit it is already past is `reached`.
    expect(timeToLimit(points, 5_000, 'rising').state).toBe('moving-away');
    expect(timeToLimit(points, 2_000, 'falling').state).toBe('reached');
    expect(() => timeToLimit(points, Number.NaN, 'falling')).toThrow(
      RangeError,
    );
  });
});
