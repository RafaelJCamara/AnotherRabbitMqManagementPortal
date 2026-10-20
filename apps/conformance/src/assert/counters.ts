// The one place that knows which delivery header is which counter in which era (fact sheet b.1), so
// a projection never reads `x-acquired-count` and `x-delivery-count` the same way on every broker.
//
// 4.3 sends both: the acquired count (AC) in `x-acquired-count`, the delivery count (DC) in
// `x-delivery-count`. 4.0 to 4.2 send no `x-acquired-count`; `x-delivery-count` IS the acquired
// count there, and the delivery count is not shown. 3.13 has no acquired count at all. A counter an
// era cannot show is left out of the result, never inferred and never read as 0.
import type { Observed } from './three-way.ts';

type Header = 'x-delivery-count' | 'x-acquired-count';

export interface CounterHeaders {
  /** null: the broker sent none. */
  readonly 'x-delivery-count': number | null;
  readonly 'x-acquired-count': number | null;
}

type Counter = 'deltaAC' | 'deltaDC';

/** The header each era reads a counter from; an era without an entry for a counter cannot show it. */
const READS: Readonly<
  Record<string, Readonly<Partial<Record<Counter, Header>>>>
> = {
  '4.3': { deltaAC: 'x-acquired-count', deltaDC: 'x-delivery-count' },
  '4.0-4.2': { deltaAC: 'x-delivery-count' },
  '3.13': { deltaDC: 'x-delivery-count' },
};

/** Whether the era is one whose headers this file knows how to read. */
export const hasCounterReading = (era: string): boolean =>
  Object.hasOwn(READS, era);

/** The counter headers of a recorded delivery or observation; anything but a number is "none sent". */
export const countersOf = (
  record: Readonly<Partial<Record<Header, unknown>>>,
): CounterHeaders => ({
  'x-delivery-count': numberOrNull(record['x-delivery-count']),
  'x-acquired-count': numberOrNull(record['x-acquired-count']),
});
const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' ? value : null;

/**
 * What moved between two deliveries of one message (or from a source to its dead letter).
 *
 * `absent-is-zero` (the default) is for two deliveries of the same queue: a first delivery sends no
 * counter yet, so a missing header is 0. `both-present` is for a comparison across queues, where a
 * header that one side does not send says nothing about the counter: the field is left out. An era
 * this does not know gives null.
 */
export function counterDeltas(
  era: string,
  before: CounterHeaders,
  after: CounterHeaders,
  mode: 'absent-is-zero' | 'both-present' = 'absent-is-zero',
): Pick<Observed, 'deltaAC' | 'deltaDC'> | null {
  if (!hasCounterReading(era)) return null;
  const reads = READS[era] ?? {};
  const deltas: { deltaAC?: 0 | 1; deltaDC?: 0 | 1 } = {};
  for (const counter of ['deltaAC', 'deltaDC'] as const) {
    const header = reads[counter];
    if (header === undefined) continue;
    const [was, now] = [before[header], after[header]];
    if (mode === 'both-present' && (was === null || now === null)) continue;
    // The schema types a delta as 0 or 1 (what the registry claims); the evidence is whatever the
    // broker did, so a different delta is kept as it is and shows up as a field-level mismatch.
    deltas[counter] = ((now ?? 0) - (was ?? 0)) as 0 | 1;
  }
  return deltas;
}
