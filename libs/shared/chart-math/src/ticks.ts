// Nice axis ticks (M1-54, R6): steps of 1, 2 or 5 times a power of ten that cover the data range. Pure; no DOM.

export interface NiceTicks {
  /** Ascending, equally spaced; the first is at or below the range's minimum and the last at or above its maximum. */
  readonly ticks: number[];
  readonly step: number;
  readonly min: number;
  readonly max: number;
}

/** Removes the float noise of `a + i * step` (for example 0.30000000000000004). */
const clean = (value: number): number => Number(value.toPrecision(14));

/** The smallest 1, 2 or 5 times a power of ten that is at least `raw` (`raw` > 0). */
export function niceStep(raw: number): number {
  const exponent = Math.floor(Math.log10(raw));
  const base = 10 ** exponent;
  const fraction = raw / base;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return clean(nice * base);
}

/**
 * Ticks for the range `[min, max]`, aiming at `count` intervals. A flat range (or an empty or non-finite one, or one
 * smaller than a billionth of its size) is padded: a flat zero becomes 0 to 1, any other flat value is widened by a
 * tenth of its size on each side. The ticks always cover the data.
 */
export function niceTicks(min: number, max: number, count: number): NiceTicks {
  let low = Number.isFinite(min) ? min : 0;
  let high = Number.isFinite(max) ? max : low + 1;
  if (low > high) [low, high] = [high, low];
  // A range too small to divide (or none) is padded around its middle, so the axis has height and still covers it.
  const scale = Math.max(1, Math.abs(low), Math.abs(high));
  if (high - low <= scale * 1e-9) {
    const mid = (low + high) / 2;
    if (Math.abs(mid) <= scale * 1e-9) {
      low = Math.min(low, 0);
      high = Math.max(high, 1);
    } else {
      const pad = Math.abs(mid) * 0.1;
      low = Math.min(low, mid - pad);
      high = Math.max(high, mid + pad);
    }
  }
  const intervals = Math.max(1, Math.floor(count));
  const step = niceStep((high - low) / intervals);
  const first = clean(Math.floor(low / step + 1e-9) * step);
  const last = clean(Math.ceil(high / step - 1e-9) * step);
  const ticks: number[] = [];
  const total = Math.round((last - first) / step);
  for (let i = 0; i <= total; i++) ticks.push(clean(first + i * step));
  return { ticks, step, min: first, max: last };
}
