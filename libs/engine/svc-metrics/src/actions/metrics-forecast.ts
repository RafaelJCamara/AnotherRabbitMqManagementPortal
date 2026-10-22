// metrics.forecast: Forecast when a queue or the cluster backlog drains
// The drain ETA of the depth series in the hot window (@app/forecast): an adaptive-window regression
// trusted at R2 0.95 and over, with a 95 % band. A series that is missing, too short, flat, growing
// or not explained by a line is answered as such, never with a number (MON-05, I-13).
import { metricsForecast } from '@app/contracts';
import { drainEta, type LimitForecast } from '@app/forecast';
import { implementAction, type ActionImpl } from '@app/kernel';

import type { MetricsActionDeps } from '../deps';
import { depthOf } from '../internal/views';
import { requireVisible } from '../internal/visible';

export type MetricsForecastDeps = Pick<
  MetricsActionDeps,
  'connections' | 'collector'
>;

const whole = (n: number): number => Math.max(0, Math.round(n));

/** The forecast as the contract carries it: whole milliseconds, an ordered band. */
function wire(forecast: LimitForecast) {
  switch (forecast.state) {
    case 'ok':
      return {
        state: 'ok' as const,
        etaMs: whole(forecast.etaMs),
        band: {
          lowMs: whole(forecast.band.lowMs),
          highMs:
            forecast.band.highMs === null ? null : whole(forecast.band.highMs),
        },
        ratePerSec: forecast.ratePerSec,
        r2: forecast.r2,
        windowMs: whole(forecast.windowMs),
        points: forecast.points,
      };
    case 'no-reliable-forecast':
      return { ...forecast, windowMs: whole(forecast.windowMs) };
    case 'insufficient-data':
      return { ...forecast, spanMs: whole(forecast.spanMs) };
    default:
      return forecast;
  }
}

export const createMetricsForecastAction = (
  deps: MetricsForecastDeps,
): ActionImpl<typeof metricsForecast> =>
  implementAction(metricsForecast, {
    execute: async (input, ctx) => {
      await requireVisible(deps.connections, input.cid, ctx.principal.id);
      deps.collector.touch(
        input.cid,
        input.target.scope === 'queue'
          ? [{ vhost: input.target.vhost, name: input.target.name }]
          : [],
      );
      const depth = depthOf(deps.collector.store, input.cid, input.target);
      const newest = depth.points.at(-1)?.t;
      const { windowMs } = input;
      const windowed =
        windowMs === undefined || newest === undefined
          ? depth.points
          : depth.points.filter((point) => point.t >= newest - windowMs);
      return {
        target: input.target,
        metric: depth.metric,
        forecast: wire(drainEta(windowed)),
        points: windowed.length,
        ...(newest === undefined ? {} : { asOf: whole(newest) }),
        status: deps.collector.status(input.cid),
      };
    },
  });
