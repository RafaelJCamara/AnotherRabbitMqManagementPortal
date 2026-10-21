// The name search over the index (M0-48 slice G): a plain, case-insensitive text matched against
// names, ranked exact, then prefix, then substring, then the shorter name, then the key. One pass
// over the rows keeps only the best `max` hits (I-6, I-7); the count of all matches is still exact.
// No pattern language is built (OQ-666): the text is never a regular expression.
import type { SearchKind } from '@app/contracts';

import type { Freshness } from './freshness';
import type { ExchangeRow, QueueRow } from './rows';

/** The rows a search covers: both have a vhost (a connection may not, and is not searched). */
type SearchRow = QueueRow | ExchangeRow;

export type SearchRank = 'exact' | 'prefix' | 'substring';

export interface SearchHit {
  readonly kind: SearchKind;
  readonly row: SearchRow;
  readonly rank: SearchRank;
}

export interface SearchSource {
  readonly kind: SearchKind;
  readonly rows: readonly SearchRow[];
}

const RANK_ORDER: Readonly<Record<SearchRank, number>> = {
  exact: 0,
  prefix: 1,
  substring: 2,
};

/** Negative when `a` is the better hit. The kind is last, so the order is total. */
function compare(a: SearchHit, b: SearchHit, kinds: readonly string[]): number {
  return (
    RANK_ORDER[a.rank] - RANK_ORDER[b.rank] ||
    a.row.name.length - b.row.name.length ||
    (a.row.key < b.row.key ? -1 : a.row.key > b.row.key ? 1 : 0) ||
    kinds.indexOf(a.kind) - kinds.indexOf(b.kind)
  );
}

/** The best `max` hits for `text` and the number of rows that matched at all. */
export function searchNames(
  sources: readonly SearchSource[],
  text: string,
  max: number,
): { hits: SearchHit[]; matched: number } {
  const needle = text.toLowerCase();
  const kinds = sources.map((s) => s.kind);
  const best: SearchHit[] = [];
  let matched = 0;
  for (const { kind, rows } of sources) {
    for (const row of rows) {
      const name = row.name.toLowerCase();
      const at = name.indexOf(needle);
      if (at < 0) continue;
      matched++;
      const hit: SearchHit = {
        kind,
        row,
        rank:
          at > 0
            ? 'substring'
            : name.length === needle.length
              ? 'exact'
              : 'prefix',
      };
      // Insert into the sorted shortlist (binary search); a hit past the end is not kept.
      let low = 0;
      let high = best.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        const other = best[mid];
        if (other !== undefined && compare(other, hit, kinds) <= 0)
          low = mid + 1;
        else high = mid;
      }
      if (low >= max) continue;
      best.splice(low, 0, hit);
      if (best.length > max) best.pop();
    }
  }
  return { hits: best, matched };
}

const SEVERITY: Readonly<Record<Freshness['state'], number>> = {
  live: 0,
  stale: 1,
  loading: 2,
  unavailable: 3,
};

/**
 * One freshness for an answer drawn from several kinds: the state is the worst of them (a search
 * is never `live` while one kind it covers is loading), the answer is complete only when each kind
 * is, and the counts and hazards are summed. `expected` is given only when every kind knows it.
 */
export function mergeFreshness(
  first: Freshness,
  ...others: readonly Freshness[]
): Freshness {
  const parts = [first, ...others];
  const worst = parts.reduce((a, b) =>
    SEVERITY[b.state] > SEVERITY[a.state] ? b : a,
  );
  const known = parts.every((p) => p.expected !== undefined);
  return {
    state: worst.state,
    ...(worst.sweptAt === undefined ? {} : { sweptAt: worst.sweptAt }),
    complete: parts.every((p) => p.complete),
    loaded: parts.reduce((n, p) => n + p.loaded, 0),
    ...(known
      ? { expected: parts.reduce((n, p) => n + (p.expected ?? 0), 0) }
      : {}),
    truncated: parts.some((p) => p.truncated),
    dropped: Math.max(...parts.map((p) => p.dropped)),
    hazards: [...new Set(parts.flatMap((p) => p.hazards))],
    versionChanged: false,
    ...(worst.reason === undefined ? {} : { reason: worst.reason }),
  };
}
