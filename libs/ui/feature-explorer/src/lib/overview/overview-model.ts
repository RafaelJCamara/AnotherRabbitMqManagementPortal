// The cluster overview as the page reads it (M0-54, R9). `overview.get` costs up to three interactive-lane
// requests to the broker and there is no overview topic, so the page reads once on open and once per press of
// Refresh, never on a timer, and keeps a floor between two reads.
import type { OutputOf, overviewGet } from '@app/contracts';

export type OverviewAnswer = OutputOf<typeof overviewGet>;
export type OverviewRates = OverviewAnswer['rates'];
export type OverviewAlarms = OverviewAnswer['alarms'];

/** Refresh stays closed this long after a read (I-8: the overview shares the broker's interactive budget). */
export const OVERVIEW_MIN_REFRESH_MS = 10_000;

const numbers = new Intl.NumberFormat();

/** A count as the broker sent it, or `null` when it did not send one (never a zero it did not send). */
export function countText(value: number | undefined): string | null {
  return value === undefined ? null : numbers.format(value);
}

/** A rate: a decimal with at most two digits; `null` when the broker did not report it. */
export function rateText(value: number | undefined): string | null {
  return value === undefined
    ? null
    : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(
        value,
      );
}
