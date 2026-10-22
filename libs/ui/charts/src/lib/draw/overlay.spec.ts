import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { forecastOverlay, withOverlayRoom } from './overlay';

const DOMAIN = { from: 0, to: 1000 };
const LATEST = { t: 500, v: 100 };

describe('M1-54 forecast overlay', () => {
  it('AC-5 the overlay ends at the zero line inside the chart and clips the band', () => {
    const o = forecastOverlay(
      { etaMs: 300, lowMs: 200, highMs: 400 },
      LATEST,
      DOMAIN,
    );
    expect(o).toEqual({
      line: { from: LATEST, to: { t: 800, v: 0 } },
      etaT: 800,
      band: { fromT: 700, toT: 900, open: false },
      beyond: false,
    });
    // No upper bound: the band goes on past the right edge.
    const open = forecastOverlay(
      { etaMs: 300, lowMs: 200, highMs: null },
      LATEST,
      DOMAIN,
    );
    expect(open?.band).toEqual({ fromT: 700, toT: 1000, open: true });
  });

  it('AC-5 an ETA beyond the chart is said, not drawn: the line stops at the edge and the band may vanish', () => {
    const o = forecastOverlay(
      { etaMs: 2000, lowMs: 1000, highMs: 3000 },
      LATEST,
      DOMAIN,
    );
    expect(o?.beyond).toBe(true);
    expect(o?.etaT).toBeNull();
    expect(o?.line.to.t).toBe(1000);
    // At the edge the line has come down by the share of the way it went (500 of 2000).
    expect(o?.line.to.v).toBeCloseTo(75, 9);
    expect(o?.band).toBeNull(); // starts at 1500, past the edge
  });

  it('AC-5 a forecast that is not usable gives no overlay (fail closed)', () => {
    const cases = [
      { etaMs: 0, lowMs: 0, highMs: 10 },
      { etaMs: -5, lowMs: 0, highMs: 10 },
      { etaMs: Number.NaN, lowMs: 0, highMs: 10 },
      { etaMs: 100, lowMs: 200, highMs: 300 }, // low above the ETA
      { etaMs: 100, lowMs: 50, highMs: 80 }, // high below the ETA
      { etaMs: 100, lowMs: 50, highMs: Infinity },
      { etaMs: 100, lowMs: -1, highMs: 120 },
    ];
    for (const forecast of cases) {
      expect(
        forecastOverlay(forecast, LATEST, DOMAIN),
        JSON.stringify(forecast),
      ).toBeNull();
    }
    const fine = { etaMs: 100, lowMs: 50, highMs: 150 };
    expect(forecastOverlay(fine, { t: 500, v: 0 }, DOMAIN)).toBeNull(); // nothing to drain
    expect(forecastOverlay(fine, { t: 500, v: Number.NaN }, DOMAIN)).toBeNull();
    expect(forecastOverlay(fine, { t: -5, v: 1 }, DOMAIN)).toBeNull(); // newest point outside the chart
    expect(forecastOverlay(fine, { t: 1000, v: 1 }, DOMAIN)).toBeNull();
  });

  it('AC-5 whatever the forecast, an overlay stays inside the chart and its band is ordered (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 9000 }),
        fc.boolean(),
        (eta, lowShare, extra, open) => {
          const low = Math.floor((eta * lowShare) / 100);
          const forecast = {
            etaMs: eta,
            lowMs: low,
            highMs: open ? null : eta + extra,
          };
          const o = forecastOverlay(forecast, LATEST, DOMAIN);
          expect(o).not.toBeNull();
          if (o === null) return;
          expect(o.line.to.t).toBeLessThanOrEqual(DOMAIN.to);
          expect(o.line.to.v).toBeGreaterThanOrEqual(0);
          expect(o.line.to.v).toBeLessThanOrEqual(LATEST.v);
          if (o.band !== null) {
            expect(o.band.fromT).toBeLessThanOrEqual(o.band.toT);
            expect(o.band.fromT).toBeGreaterThanOrEqual(LATEST.t);
            expect(o.band.toT).toBeLessThanOrEqual(DOMAIN.to);
          }
          expect(o.beyond).toBe(LATEST.t + eta > DOMAIN.to);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('AC-5 the chart keeps a quarter of its span free on the right for the overlay', () => {
    expect(withOverlayRoom({ from: 0, to: 1000 })).toEqual({
      from: 0,
      to: 1250,
    });
  });
});
