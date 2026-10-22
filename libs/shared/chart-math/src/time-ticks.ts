// Time axis ticks (M1-54, R6): epoch milliseconds aligned to a round step, so a tick never reads 12:30:07. Steps
// are multiples of a fixed length from the epoch (UTC): for day-long steps that is not local midnight, and the
// charts here span an hour, so the difference is not visible. Pure; no DOM.

const S = 1000;
const MIN = 60 * S;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The steps a time axis may use, in milliseconds, ascending. */
export const TIME_STEPS_MS: readonly number[] = [
  S,
  2 * S,
  5 * S,
  10 * S,
  15 * S,
  30 * S,
  MIN,
  2 * MIN,
  5 * MIN,
  10 * MIN,
  15 * MIN,
  30 * MIN,
  HOUR,
  2 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
  14 * DAY,
  30 * DAY,
];

/** The smallest step that gives at most `count` intervals across `spanMs`. */
export function timeStep(spanMs: number, count: number): number {
  const wanted = spanMs / Math.max(1, count);
  const found = TIME_STEPS_MS.find((step) => step >= wanted);
  if (found !== undefined) return found;
  const last = TIME_STEPS_MS[TIME_STEPS_MS.length - 1] ?? DAY;
  return Math.ceil(wanted / last) * last;
}

/** Ticks inside `[from, to]`, ascending, each a multiple of the chosen step; none for an empty or non-finite range. */
export function timeTicks(from: number, to: number, count: number): number[] {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  const step = timeStep(to - from, count);
  const ticks: number[] = [];
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) ticks.push(t);
  return ticks;
}
