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
  /** `rows[i].name` case-folded, built once per index version (`InventoryIndex.folded`). */
  readonly folded: readonly string[];
}

/** Best first: the position is the rank's order. */
const RANKS: readonly SearchRank[] = ['exact', 'prefix', 'substring'];

/** A shortlist entry: the hit and the numbers its order is made of, so a compare reads no row. */
interface Entry {
  readonly hit: SearchHit;
  readonly rank: number;
  readonly length: number;
  readonly key: string;
  readonly source: number;
}

/** Negative when `a` is the better hit. The source (the kind's place) is last, so the order is total. */
function compare(a: Entry, b: Entry): number {
  return (
    a.rank - b.rank ||
    a.length - b.length ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) ||
    a.source - b.source
  );
}

/**
 * The best `max` hits for `text` and the number of rows that matched at all.
 *
 * The shortlist is kept sorted. Once it is full, a hit that cannot beat its last entry is turned
 * away after comparing two numbers and at most one string, without building a hit or searching the
 * list: that is nearly every match when the text is common, and it is what keeps the pass cheap.
 */
export function searchNames(
  sources: readonly SearchSource[],
  text: string,
  max: number,
): { hits: SearchHit[]; matched: number } {
  const needle = text.toLowerCase();
  const best: Entry[] = [];
  let matched = 0;
  // The last (worst) entry of a full shortlist, unpacked for the cheap turn-away test.
  let worstRank = 0;
  let worstLength = 0;
  let worstKey = '';
  for (let s = 0; s < sources.length; s++) {
    const source = sources[s];
    if (source === undefined) continue;
    const { kind, rows, folded } = source;
    for (let i = 0; i < folded.length; i++) {
      const name = folded[i];
      if (name === undefined) continue;
      const at = name.indexOf(needle);
      if (at < 0) continue;
      matched++;
      const row = rows[i];
      if (row === undefined) continue;
      const rank = at > 0 ? 2 : name.length === needle.length ? 0 : 1;
      const length = row.name.length;
      if (best.length >= max) {
        if (rank > worstRank) continue;
        if (rank === worstRank) {
          if (length > worstLength) continue;
          // Equal on all three: a later row (the sources come in order) loses the tie.
          if (length === worstLength && row.key >= worstKey) continue;
        }
      }
      const entry: Entry = {
        hit: { kind, row, rank: RANKS[rank] ?? 'substring' },
        rank,
        length,
        key: row.key,
        source: s,
      };
      // Insert into the sorted shortlist (binary search).
      let low = 0;
      let high = best.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        const other = best[mid];
        if (other !== undefined && compare(other, entry) <= 0) low = mid + 1;
        else high = mid;
      }
      if (low >= max) continue;
      best.splice(low, 0, entry);
      if (best.length > max) best.pop();
      if (best.length >= max) {
        const worst = best[best.length - 1];
        if (worst !== undefined) {
          worstRank = worst.rank;
          worstLength = worst.length;
          worstKey = worst.key;
        }
      }
    }
  }
  return { hits: best.map((e) => e.hit), matched };
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
