// `x-first-death-{queue,reason,exchange}` (set once, at the first death) and
// `x-last-death-{queue,reason,exchange}` (updated at every death): 0-9-1 headers or 1.0 message
// annotations (tap-streams-ops T3; mc.erl `record_death`). They are read as sent and cross-checked
// against the records; a disagreement is reported, never repaired, and the history is never built
// from them: a message whose `x-death` was stripped is `client-stripped`, not reconstructed.
import { field, readText, type ReadContext } from './read.ts';
import type { DeathEntry, DeathSummary, HistoryFlag } from './types.ts';

export interface FirstLast {
  readonly first: DeathSummary | null;
  readonly last: DeathSummary | null;
  /** The headers that were present, in reading order. */
  readonly names: readonly string[];
}

const PARTS = ['queue', 'reason', 'exchange'] as const;

function readSummary(
  ctx: ReadContext,
  container: unknown,
  prefix: 'x-first-death-' | 'x-last-death-',
  names: string[],
): DeathSummary | null {
  const value: Record<(typeof PARTS)[number], string | null> = {
    queue: null,
    reason: null,
    exchange: null,
  };
  let present = false;
  for (const part of PARTS) {
    const name = `${prefix}${part}`;
    const raw = field(ctx, container, name);
    if (raw === undefined) continue;
    present = true;
    names.push(name);
    value[part] = readText(ctx, raw)?.text ?? null;
  }
  return present ? value : null;
}

export function readFirstLast(ctx: ReadContext, container: unknown): FirstLast {
  const names: string[] = [];
  const first = readSummary(ctx, container, 'x-first-death-', names);
  const last = readSummary(ctx, container, 'x-last-death-', names);
  return { first, last, names };
}

const reasonOf = (entry: DeathEntry): string | null =>
  entry.reason ?? entry.reasonText;

/**
 * Adds the flags that first/last and the records imply. `complete` is false when entries were cut,
 * because then a first death may sit in a record that is not here.
 */
export function crossCheck(
  { first, last }: Pick<FirstLast, 'first' | 'last'>,
  entries: readonly DeathEntry[],
  complete: boolean,
  flags: Set<HistoryFlag>,
): void {
  if (entries.length === 0) {
    if (first !== null || last !== null) flags.add('client-stripped');
    return;
  }
  if (first === null) flags.add('first-death-header-missing');
  if (last === null) flags.add('last-death-header-missing');

  const newest = entries[0];
  if (
    last !== null &&
    newest !== undefined &&
    ((last.queue !== null &&
      newest.queue !== null &&
      last.queue !== newest.queue) ||
      (last.reason !== null &&
        reasonOf(newest) !== null &&
        last.reason !== reasonOf(newest)))
  ) {
    flags.add('last-death-mismatch');
  }

  // The first death belongs to some record: the one of its queue and reason. Judged only when
  // every record is readable and none was cut, so a missing field never causes a mismatch.
  const judgeable =
    complete &&
    entries.every((entry) => entry.queue !== null && reasonOf(entry) !== null);
  if (
    first?.queue != null &&
    first.reason !== null &&
    judgeable &&
    !entries.some(
      (entry) =>
        entry.queue === first.queue && reasonOf(entry) === first.reason,
    )
  ) {
    flags.add('first-death-mismatch');
  }
}
