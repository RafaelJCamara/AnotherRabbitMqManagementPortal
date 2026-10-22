// perf:charts-50 (M1-54, AC-24): the draw work of 50 live charts at 1 Hz for 300 ticks (five minutes).
//
// The issue asks for the renderer CPU of 50 charts to stay under 20 %. That is a browser profile and is not
// measured here (OQ-930). What this run measures is the work the charts hand the renderer: per tick, for each of 50
// charts of three series, the session takes one point, the ring keeps it, and the chart downsamples to the pixel
// width and builds its paths. The assertions are counts, not clocks (a loaded machine would make a clock flaky): the
// vertices of a path never exceed four per pixel column, a ring never exceeds its bounds and every point it pushed
// out is counted. The time per tick and the heap are printed.
//
// Node only: `pnpm nx run perf:charts-50`.
import {
  createMetricsSession,
  type MetricsSession,
  type SessionState,
} from '@app/metrics-model';
import {
  createFakeMetricsData,
  liveItem,
  quietStatus,
  seriesResult,
  type FakeMetricsData,
} from '@app/metrics-model/testing';
import {
  downsample,
  gapThreshold,
  linearScale,
  pathOf,
  yAxis,
} from '@app/chart-math';
import { describe, expect, it } from 'vitest';

const CHARTS = 50;
const LINES = 3;
const TICKS = 300;
const HISTORY = 900;
const WIDTH = 640;
const PLOT = WIDTH - 68;
const STEP = 1000;
const T0 = 1_760_000_000_000;
const METRICS = [
  'queue_messages_ready',
  'queue_messages_unacked',
  'queue_messages',
] as const;

const report = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const refOf = (chart: number, line: number) => ({
  metric: METRICS[line] ?? METRICS[0],
  queue: { vhost: '/', name: `queue-${String(chart).padStart(3, '0')}` },
});

const value = (chart: number, line: number, i: number): number =>
  Math.round(500 + 400 * Math.sin((i + chart * 7 + line * 13) / 25));

/** What one chart does for one frame: the same maths the component runs. */
function drawChart(state: SessionState): number {
  const [from, to] = [(state.newestT ?? 0) - 900_000, state.newestT ?? 0];
  let low = Infinity;
  let high = -Infinity;
  for (const series of state.series) {
    for (const p of series.points) {
      if (p.t >= from) {
        low = Math.min(low, p.v);
        high = Math.max(high, p.v);
      }
    }
  }
  const axis = yAxis('zero', low, high, 148);
  const x = linearScale(from, to, 0, PLOT);
  let vertices = 0;
  for (const series of state.series) {
    const drawn = downsample(series.points, from, to, PLOT);
    const d = pathOf(drawn, x, axis.map, gapThreshold(series.points));
    const count = (d.match(/[ML]/g) ?? []).length;
    // The bound the renderer relies on: four vertices per pixel column at most.
    expect(count).toBeLessThanOrEqual(4 * PLOT);
    vertices += count;
  }
  return vertices;
}

describe('the draw work of 50 live charts', () => {
  it('M1-54 AC-24 50 charts at 1 Hz stay bounded in vertices, ring size and counted drops', () => {
    const sessions: { data: FakeMetricsData; session: MetricsSession }[] = [];
    for (let chart = 0; chart < CHARTS; chart++) {
      const data = createFakeMetricsData();
      data.answer = (input) => ({
        series: input.series.map((ref, line) =>
          seriesResult(
            ref,
            Array.from(
              { length: HISTORY },
              (_, i) => [T0 + i * STEP, value(chart, line, i)] as const,
            ),
          ),
        ),
        status: quietStatus(),
      });
      const session = createMetricsSession(data, {
        cid: 'c1',
        series: METRICS.map((_, line) => refOf(chart, line)),
      });
      sessions.push({ data, session });
    }
    return Promise.resolve().then(async () => {
      // Let every history read finish.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      let drawn = 0;
      let vertices = 0;
      let worst = 0;
      const started = performance.now();
      const heapBefore = process.memoryUsage().heapUsed;
      for (let tick = 0; tick < TICKS; tick++) {
        const t = T0 + (HISTORY + tick) * STEP;
        const tickStart = performance.now();
        sessions.forEach(({ data, session }, chart) => {
          data.emit({
            kind: 'delta',
            upserts: METRICS.map((_, line) =>
              liveItem(
                refOf(chart, line),
                t,
                value(chart, line, HISTORY + tick),
              ),
            ),
            removes: [],
          });
          vertices += drawChart(session.state());
          drawn += 1;
        });
        worst = Math.max(worst, performance.now() - tickStart);
      }
      const elapsed = performance.now() - started;
      // Every chart drew once per tick, each from the newest point, within the bound.
      expect(drawn).toBe(CHARTS * TICKS);
      expect(vertices).toBeLessThanOrEqual(CHARTS * TICKS * LINES * 4 * PLOT);
      expect(vertices).toBeGreaterThan(CHARTS * TICKS * LINES);
      // Every ring is within its bounds and every point it pushed out is counted: 900 + 300 pushed, 1,000 kept.
      for (const { session } of sessions) {
        const state = session.state();
        expect(state.phase).toBe('ready');
        for (const series of state.series) {
          expect(series.points).toHaveLength(1000);
          expect(series.points.length * 16).toBeLessThanOrEqual(16_000);
          expect(series.evicted).toBe(HISTORY + TICKS - 1000);
        }
        session.destroy();
      }
      report(
        `charts-50: ${String(CHARTS)} charts x ${String(LINES)} series, ${String(TICKS)} ticks at 1 Hz, ${String(HISTORY)} points of history`,
      );
      report(
        `charts-50: ${(elapsed / TICKS).toFixed(1)} ms per tick for all charts (worst ${worst.toFixed(1)} ms), ${String(vertices)} vertices drawn in total`,
      );
      report(
        `charts-50: heap grew ${((process.memoryUsage().heapUsed - heapBefore) / 1048576).toFixed(1)} MiB (printed, not asserted)`,
      );
    });
  });
});
