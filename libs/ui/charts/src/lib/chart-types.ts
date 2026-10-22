// The shapes the chart components take, and how a series looks (M1-54, R1, R7). A series has a colour token, a dash
// pattern and a marker shape of its own, so colour is never the only signal. The host passes every text in
// (`ChartLabels`): this library has no copy of its own.
import { type Point, type Unit } from '@app/chart-math';

/** A line is `drawn` (it has points) or `not-reported` (the engine holds no such series: no line, never a zero). */
export interface ChartSeries {
  readonly id: string;
  readonly label: string;
  readonly unit: Unit;
  /** 0 to 5: which colour, dash and marker (more wrap around). */
  readonly style: number;
  readonly points: readonly Point[];
  readonly state: 'drawn' | 'not-reported';
  /** For a series that is not reported: the host's words for why, shown beside its name. */
  readonly reason?: string;
  /** The values come from sampling, not from the broker's own counters: shown as a mark beside the name. */
  readonly approximate?: boolean;
}

/** Every text of a chart; the host translates. */
export interface ChartLabels {
  /** How to use the keyboard on the plot (read as its description). */
  readonly keyboardHint: string;
  /** Names the legend group. */
  readonly legend: string;
  /** Shown instead of the plot when no series has a point. */
  readonly noData: string;
  /** A series the engine does not report. */
  readonly notReported: string;
  /** A drawn series with no point at a row's time (table). */
  readonly noPoint: string;
  /** The mark beside the name of a series from sampled data. */
  readonly approximate: string;
  /** The summary of the data table (`<details>`). */
  readonly tableSummary: string;
  readonly tableCaption: string;
  readonly timeColumn: string;
  /** "N older rows are not shown". */
  readonly olderRows: (count: number) => string;
  /** The forecast ETA is further than the chart reaches. */
  readonly forecastBeyond: string;
  /** Names the forecast overlay when it is drawn. */
  readonly forecastDrawn: string;
}

/** Dash patterns of the six series styles; the first is solid. All distinct. */
export const DASHES: readonly string[] = [
  '',
  '7 4',
  '2 3',
  '9 3 2 3',
  '1 4',
  '12 3 2 3 2 3',
];

export type MarkerShape =
  | 'circle'
  | 'square'
  | 'triangle'
  | 'diamond'
  | 'cross'
  | 'ring';

/** Marker shapes of the six series styles. All distinct. */
export const MARKERS: readonly MarkerShape[] = [
  'circle',
  'square',
  'triangle',
  'diamond',
  'cross',
  'ring',
];

export interface SeriesStyle {
  /** The CSS custom property of the colour token (`--ds-color-chart-1` to `-6`). */
  readonly colour: string;
  readonly dash: string;
  readonly marker: MarkerShape;
}

export function styleOf(style: number): SeriesStyle {
  const slot = ((Math.trunc(style) % 6) + 6) % 6;
  return {
    colour: `--ds-color-chart-${String(slot + 1)}`,
    dash: DASHES[slot] ?? '',
    marker: MARKERS[slot] ?? 'circle',
  };
}

const round = (value: number): string => String(Math.round(value * 10) / 10);

/** The `d` of a marker of radius `r` centred on `(cx, cy)`; a `ring` is meant to be stroked, the others filled. */
export function markerPath(
  shape: MarkerShape,
  cx: number,
  cy: number,
  r: number,
): string {
  const x = (dx: number): string => round(cx + dx);
  const y = (dy: number): string => round(cy + dy);
  switch (shape) {
    case 'circle':
    case 'ring':
      return `M${x(-r)} ${y(0)}a${round(r)} ${round(r)} 0 1 0 ${round(2 * r)} 0a${round(r)} ${round(r)} 0 1 0 ${round(-2 * r)} 0Z`;
    case 'square':
      return `M${x(-r)} ${y(-r)}H${x(r)}V${y(r)}H${x(-r)}Z`;
    case 'triangle':
      return `M${x(0)} ${y(-r)}L${x(r)} ${y(r)}L${x(-r)} ${y(r)}Z`;
    case 'diamond':
      return `M${x(0)} ${y(-r)}L${x(r)} ${y(0)}L${x(0)} ${y(r)}L${x(-r)} ${y(0)}Z`;
    case 'cross':
      return `M${x(-r)} ${y(0)}H${x(r)}M${x(0)} ${y(-r)}V${y(r)}`;
  }
}
