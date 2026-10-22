// The palette's fuzzy filter (M1-41, R10): a subsequence match of the query over the title and over the
// id, scored so that word starts and consecutive characters win, with the index ranges to highlight.
// Plain strings in, plain data out: the palette draws the ranges as text, never as markup.

export interface Rankable {
  readonly id: string;
  readonly title: string;
}

export type Range = readonly [start: number, end: number];

export interface Ranked<T extends Rankable> {
  readonly item: T;
  readonly score: number;
  /** Which text the highlight belongs to: the title when it matched, else the id. */
  readonly matchedIn: 'title' | 'id' | 'none';
  readonly ranges: readonly Range[];
}

/** How many rows the palette draws. */
export const PALETTE_LIMIT = 50;

const TITLE_BONUS = 3;
const WORD_START = 9;
const CONSECUTIVE = 7;
const GAP_PENALTY = 1;
const GAP_PENALTY_CAP = 4;
const BOUNDARY = /[\s.\-_/:]/;

interface Match {
  readonly score: number;
  readonly positions: readonly number[];
}

const startsWord = (text: string, index: number): boolean =>
  index === 0 ||
  BOUNDARY.test(text.charAt(index - 1)) ||
  (/[a-z]/.test(text.charAt(index - 1)) && /[A-Z]/.test(text.charAt(index)));

/** The best-scoring subsequence match of `query` in `text`, or null when a character is missing. */
function bestMatch(query: string, text: string): Match | null {
  const lower = text.toLowerCase();
  const m = query.length;
  const n = text.length;
  if (m === 0 || m > n) return null;
  // score[i][j]: the best score with query[i] matched at text[j]; from[i][j]: where query[i-1] matched.
  const score: number[][] = [];
  const from: number[][] = [];
  for (let i = 0; i < m; i += 1) {
    score.push(new Array<number>(n).fill(Number.NEGATIVE_INFINITY));
    from.push(new Array<number>(n).fill(-1));
  }
  for (let i = 0; i < m; i += 1) {
    const row = score[i];
    const back = from[i];
    if (row === undefined || back === undefined) continue;
    for (let j = i; j < n; j += 1) {
      if (lower.charAt(j) !== query.charAt(i)) continue;
      const own = 1 + (startsWord(text, j) ? WORD_START : 0);
      if (i === 0) {
        row[j] = own - Math.min(j, GAP_PENALTY_CAP);
        continue;
      }
      const prev = score[i - 1];
      if (prev === undefined) continue;
      let best = Number.NEGATIVE_INFINITY;
      let bestAt = -1;
      for (let k = i - 1; k < j; k += 1) {
        const before = prev[k];
        if (before === undefined || before === Number.NEGATIVE_INFINITY)
          continue;
        const gap = j - k - 1;
        const value =
          before +
          (gap === 0
            ? CONSECUTIVE
            : -Math.min(gap * GAP_PENALTY, GAP_PENALTY_CAP));
        if (value > best) {
          best = value;
          bestAt = k;
        }
      }
      if (bestAt >= 0) {
        row[j] = best + own;
        back[j] = bestAt;
      }
    }
  }
  const last = score[m - 1];
  if (last === undefined) return null;
  let end = -1;
  let top = Number.NEGATIVE_INFINITY;
  for (let j = 0; j < n; j += 1) {
    const value = last[j];
    if (value !== undefined && value > top) {
      top = value;
      end = j;
    }
  }
  if (end < 0) return null;
  const positions: number[] = [];
  let at = end;
  for (let i = m - 1; i >= 0; i -= 1) {
    positions.unshift(at);
    at = from[i]?.[at] ?? -1;
  }
  return { score: top, positions };
}

/** Merges matched positions into `[start, end)` ranges. */
export function toRanges(positions: readonly number[]): readonly Range[] {
  const ranges: [number, number][] = [];
  for (const position of positions) {
    const lastRange = ranges[ranges.length - 1];
    if (lastRange?.[1] === position) lastRange[1] = position + 1;
    else ranges.push([position, position + 1]);
  }
  return ranges;
}

/**
 * Ranks items against a query. An empty query returns the items in their order. Otherwise an item
 * stays only if every character of the query (spaces ignored) appears in its title or its id in
 * order; a title match beats an id match of the same quality. Ties keep the input order.
 */
export function rankCommands<T extends Rankable>(
  query: string,
  items: readonly T[],
  limit: number = PALETTE_LIMIT,
): readonly Ranked<T>[] {
  const needle = query.toLowerCase().replace(/\s+/g, '');
  if (needle === '') {
    return items
      .slice(0, limit)
      .map((item) => ({ item, score: 0, matchedIn: 'none', ranges: [] }));
  }
  const ranked: { readonly entry: Ranked<T>; readonly order: number }[] = [];
  items.forEach((item, order) => {
    const inTitle = bestMatch(needle, item.title);
    const inId = bestMatch(needle, item.id);
    const title = inTitle === null ? null : inTitle.score + TITLE_BONUS;
    if (
      inTitle !== null &&
      (inId === null || title === null || title >= inId.score)
    ) {
      ranked.push({
        order,
        entry: {
          item,
          score: title ?? 0,
          matchedIn: 'title',
          ranges: toRanges(inTitle.positions),
        },
      });
    } else if (inId !== null) {
      ranked.push({
        order,
        entry: {
          item,
          score: inId.score,
          matchedIn: 'id',
          ranges: toRanges(inId.positions),
        },
      });
    }
  });
  ranked.sort((a, b) => b.entry.score - a.entry.score || a.order - b.order);
  return ranked.slice(0, limit).map((r) => r.entry);
}
