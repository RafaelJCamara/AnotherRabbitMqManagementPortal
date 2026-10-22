// Shared by the component specs of this library: texts, series and a point generator. Never part of the build.
import type { ChartLabels, ChartSeries } from './chart-types';
import type { Point } from './draw/downsample';

export const LABELS: ChartLabels = {
  keyboardHint: 'Use the arrow keys to move along the chart.',
  legend: 'Series',
  noData: 'There is nothing to draw.',
  notReported: 'not reported',
  noPoint: 'no point',
  approximate: 'approximate',
  tableSummary: 'Data table',
  tableCaption: 'The values of the chart',
  timeColumn: 'Time',
  olderRows: (count) => `${String(count)} older rows are not shown`,
  forecastBeyond: 'The forecast is beyond the chart.',
  forecastDrawn: 'Forecast drawn.',
};

/** One point per `stepMs`, `count` of them, from `start`; the value is `value(i)`. */
export function points(
  count: number,
  value: (i: number) => number,
  start = 0,
  stepMs = 1000,
): Point[] {
  return Array.from({ length: count }, (_, i) => ({
    t: start + i * stepMs,
    v: value(i),
  }));
}

export function drawn(
  id: string,
  pts: readonly Point[],
  style = 0,
  extra: Partial<ChartSeries> = {},
): ChartSeries {
  return {
    id,
    label: id,
    unit: 'messages',
    style,
    points: pts,
    state: 'drawn',
    ...extra,
  };
}

export function missing(id: string, reason?: string): ChartSeries {
  return {
    id,
    label: id,
    unit: 'messages',
    style: 3,
    points: [],
    state: 'not-reported',
    ...(reason === undefined ? {} : { reason }),
  };
}

/** The number of vertices of a path: every `M` and `L` starts one. */
export function vertices(d: string): number {
  return (d.match(/[ML]/g) ?? []).length;
}
