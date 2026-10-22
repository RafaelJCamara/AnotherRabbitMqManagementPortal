// Scales (M1-54, R6). `x` maps a time to a pixel, `yAxis` builds the vertical axis for one of the three
// scale choices the person can make: from zero, fitted to the data, or logarithmic. Pure; no DOM.
import { niceTicks } from './ticks';

export type YScaleKind = 'zero' | 'fit' | 'log';

/** A linear map from a data domain to a pixel range; a flat domain maps to the middle of the range. */
export function linearScale(
  d0: number,
  d1: number,
  r0: number,
  r1: number,
): (value: number) => number {
  const span = d1 - d0;
  return (value) =>
    span === 0 ? (r0 + r1) / 2 : r0 + ((value - d0) / span) * (r1 - r0);
}

/** A signed log10(1 + |v|): zero is drawn, and a negative value is not lost. */
export const symlog = (value: number): number =>
  Math.sign(value) * Math.log10(1 + Math.abs(value));

export interface YAxis {
  readonly kind: YScaleKind;
  /** Value to pixel; pixel 0 is the top of the plot, `height` its bottom. */
  readonly map: (value: number) => number;
  readonly ticks: number[];
  readonly min: number;
  readonly max: number;
}

const TICK_COUNT = 4;

function powersOfTen(max: number): number[] {
  const ticks = [0];
  // The last tick is the smallest power of ten at or above `max` (at least 1), so the data is inside the axis.
  for (let tick = 1; ticks.length < 310; tick *= 10) {
    ticks.push(tick);
    if (tick >= max) break;
  }
  return ticks;
}

/**
 * The vertical axis for data between `dataMin` and `dataMax` in a plot `height` pixels high.
 * `zero` includes zero, `fit` is the nice range of the data (a flat series gets height), `log` uses `symlog`
 * with ticks at 0 and the powers of ten. A negative minimum is kept on every scale.
 */
export function yAxis(
  kind: YScaleKind,
  dataMin: number,
  dataMax: number,
  height: number,
): YAxis {
  const low = Number.isFinite(dataMin) ? dataMin : 0;
  const high = Number.isFinite(dataMax) ? Math.max(dataMax, low) : low;
  if (kind === 'log') {
    const top = powersOfTen(Math.max(high, 0)).at(-1) ?? 1;
    const bottom = low < 0 ? -(powersOfTen(-low).at(-1) ?? 1) : 0;
    const f0 = symlog(bottom);
    const f1 = symlog(top);
    const ticks = [
      ...(low < 0
        ? powersOfTen(-low)
            .slice(1)
            .reverse()
            .map((t) => -t)
        : []),
      ...powersOfTen(Math.max(high, 0)),
    ];
    const scale = linearScale(f0, f1, height, 0);
    return {
      kind,
      map: (value) => scale(symlog(value)),
      ticks,
      min: bottom,
      max: top,
    };
  }
  const range = niceTicks(
    kind === 'zero' ? Math.min(0, low) : low,
    kind === 'zero' ? Math.max(0, high) : high,
    TICK_COUNT,
  );
  return {
    kind,
    map: linearScale(range.min, range.max, height, 0),
    ticks: range.ticks,
    min: range.min,
    max: range.max,
  };
}
