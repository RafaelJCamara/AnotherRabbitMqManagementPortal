// The bindings of one vhost, read for one entity (M1-42, R5). The engine reads bindings of exactly one
// vhost and matches `filter.text` as a substring of source, destination and routing key, so it cannot
// select an exact name. This reads the vhost's windows with the name as text and keeps the rows that
// match exactly, over a bounded number of windows; what was not scanned is counted and said (I-7, I-13).
import { ConnectionIdSchema } from '@app/contracts';

import { WINDOW_BLOCK } from './inventory-model';
import type {
  ExplorerData,
  Freshness,
  InventoryQueryInput,
  InventoryRows,
} from './ports';

export type BindingRow = InventoryRows['bindings'];

/** The most rows one scan reads: five windows of 200. */
export const RELATED_SCAN_MAX = 5 * WINDOW_BLOCK;
/** The most rows of one list that are kept; the rest are counted. */
export const RELATED_SHOWN_MAX = 200;

export interface BindingScan {
  /** Rows read (offered to the visitor). */
  readonly scanned: number;
  /** Rows the engine said match the text; `null` before any answer. */
  readonly matched: number | null;
  /** More rows matched than were read: the scan stopped at the cap. */
  readonly truncated: boolean;
  readonly freshness: Freshness | null;
  /** The Problem (as received) of a window that failed; the rows read before it were offered. */
  readonly problem: unknown;
}

export interface BindingScanQuery {
  readonly cid: string;
  readonly vhost: string;
  /** A substring the engine applies to source, destination and routing key; omitted when empty. */
  readonly text: string;
}

/**
 * Reads the windows of the vhost one after another (never two at once), at most `RELATED_SCAN_MAX` rows,
 * pinned to the version of the first answer, and offers each row to `visit`; `visit` returns `true` to
 * stop. An aborted scan rejects; any other failure is returned as `problem` with what was read.
 */
export async function scanBindings(
  data: ExplorerData,
  query: BindingScanQuery,
  signal: AbortSignal,
  visit: (row: BindingRow) => boolean,
): Promise<BindingScan> {
  const cid = ConnectionIdSchema.parse(query.cid);
  let scanned = 0;
  let matched: number | null = null;
  let freshness: Freshness | null = null;
  let pin: number | undefined;
  let stopped = false;
  try {
    for (
      let offset = 0;
      offset < RELATED_SCAN_MAX && !stopped;
      offset += WINDOW_BLOCK
    ) {
      const input: InventoryQueryInput = {
        cid,
        kind: 'bindings',
        filter: {
          vhosts: [query.vhost],
          ...(query.text === '' ? {} : { text: query.text }),
        },
        sort: { column: 'source', dir: 'asc' },
        window: {
          offset,
          limit: WINDOW_BLOCK,
          ...(pin === undefined ? {} : { version: pin }),
        },
      };
      const out = await data.query(input, signal);
      if (out.kind !== 'bindings') {
        throw new TypeError(
          `The engine answered ${out.kind} rows for a bindings query.`,
        );
      }
      pin ??= out.version;
      matched = out.matched;
      freshness = out.freshness;
      for (const row of out.rows) {
        scanned += 1;
        if (visit(row)) {
          stopped = true;
          break;
        }
      }
      if (
        out.rows.length < WINDOW_BLOCK ||
        offset + out.rows.length >= out.matched
      )
        break;
    }
  } catch (error) {
    if (signal.aborted) throw error;
    return { scanned, matched, truncated: false, freshness, problem: error };
  }
  return {
    scanned,
    matched,
    truncated: !stopped && matched !== null && matched > scanned,
    freshness,
    problem: null,
  };
}

export interface RelatedBindings {
  /** Bindings whose destination is this entity (a queue or an exchange). */
  readonly bindingsIn: readonly BindingRow[];
  /** Bindings whose source is this entity (an exchange). */
  readonly bindingsOut: readonly BindingRow[];
  /** Rows matched but not kept because a list is full (`RELATED_SHOWN_MAX`). */
  readonly moreIn: number;
  readonly moreOut: number;
  readonly scanned: number;
  readonly matched: number | null;
  /** The scan stopped at its cap: bindings after it were not read. */
  readonly truncated: boolean;
  readonly freshness: Freshness | null;
  readonly problem: unknown;
  /** Nothing was asked: the default exchange has implicit bindings the broker does not list. */
  readonly skipped: 'default-exchange' | null;
}

const NOTHING: RelatedBindings = {
  bindingsIn: [],
  bindingsOut: [],
  moreIn: 0,
  moreOut: 0,
  scanned: 0,
  matched: null,
  truncated: false,
  freshness: null,
  problem: null,
  skipped: null,
};

/**
 * The bindings that feed (`bindingsIn`) and leave (`bindingsOut`) a queue or an exchange of a vhost,
 * matched exactly on the name (and, for the destination, on its type).
 */
export async function loadRelatedBindings(
  data: ExplorerData,
  query: {
    readonly cid: string;
    readonly vhost: string;
    readonly name: string;
    readonly as: 'queue' | 'exchange';
  },
  signal: AbortSignal,
): Promise<RelatedBindings> {
  if (query.as === 'exchange' && query.name === '') {
    return { ...NOTHING, skipped: 'default-exchange' };
  }
  const bindingsIn: BindingRow[] = [];
  const bindingsOut: BindingRow[] = [];
  let moreIn = 0;
  let moreOut = 0;
  const scan = await scanBindings(
    data,
    { cid: query.cid, vhost: query.vhost, text: query.name },
    signal,
    (row) => {
      if (row.destination === query.name && row.destinationType === query.as) {
        if (bindingsIn.length < RELATED_SHOWN_MAX) bindingsIn.push(row);
        else moreIn += 1;
      }
      if (query.as === 'exchange' && row.source === query.name) {
        if (bindingsOut.length < RELATED_SHOWN_MAX) bindingsOut.push(row);
        else moreOut += 1;
      }
      return false;
    },
  );
  return {
    bindingsIn,
    bindingsOut,
    moreIn,
    moreOut,
    ...scan,
    skipped: null,
  };
}
