// The bindings of a vhost, on demand (M0-48 slice H). A broker with 100,000 queues can hold millions
// of bindings, so they are not part of the background sweep: a window of bindings names exactly one
// vhost, the vhost is read the first time it is asked for (paged at 500, in the `interactive` lane
// because a person is waiting) and then kept resident. The resident rows of a connection are bounded
// (I-6): rows past the cap are dropped and counted, and a vhost that no longer fits is evicted, least
// recently used first, and counted. Nothing is silent (I-13): `dropped` and `truncated` ride in the
// answer's freshness, and `stats()` shows the evictions. RabbitMQ ignores `page` on this endpoint and
// answers every binding of the vhost as a bare array (the golden recordings, OQ-433): the cap is then
// applied after that one answer, and the freshness says the broker sent it unpaged (OQ-688).
import {
  ErrorCodeSchema,
  type ConnectionId,
  type InventoryFilterSchema,
  type InventorySortSchema,
} from '@app/contracts';
import { AppError, systemClock, type Clock } from '@app/kernel';
import type { z } from 'zod';

import { DEFAULT_EXPLORER_LIMITS, type ExplorerModuleDeps } from '../deps';

import { comparator, type IndexVersion } from './index';
import { BindingPageSchema, bindingRow, type BindingRow } from './rows';

type InventoryFilter = z.infer<typeof InventoryFilterSchema>;
type InventorySort = z.infer<typeof InventorySortSchema>;

const PAGE_SIZE_CEILING = 500;
const SORT_CACHE_ENTRIES = 4;
/** The order of a window when the caller names none; the key breaks every tie. */
const DEFAULT_SORT: InventorySort = { column: 'source', dir: 'asc' };

export interface BindingsQuery {
  filter?: InventoryFilter | undefined;
  sort?: InventorySort | undefined;
  offset: number;
  limit: number;
  /** Pins the read to an earlier answer's version of this vhost. */
  version?: number | undefined;
}

export interface BindingsRead {
  rows: readonly BindingRow[];
  /** Rows after the filter. */
  matched: number;
  /** Rows of the vhost that are resident. */
  total: number;
  version: IndexVersion;
  /** The pinned version is gone; this answer is from `version`. */
  versionChanged: boolean;
  /** The broker's own count of the vhost's bindings, when it sent one. */
  expected: number | undefined;
  /** The broker answered the whole vhost at once (no paging): the cap was applied after the answer. */
  unpaged: boolean;
}

export interface BindingsStats {
  /** The resident vhosts, least recently used first. */
  vhosts: readonly string[];
  /** Resident rows across those vhosts. */
  rows: number;
  /** Rows the cap kept out of the resident vhosts, counted. */
  dropped: number;
  /** Vhosts evicted to stay under the cap, and the rows that left with them. */
  evictions: number;
  evictedRows: number;
}

export interface BindingsStore {
  /** Reads the vhost on first use, then answers from memory; a vhost past its age is read again. */
  window(
    cid: ConnectionId,
    vhost: string,
    query: BindingsQuery,
    signal: AbortSignal,
  ): Promise<BindingsRead>;
  stats(cid: ConnectionId): BindingsStats;
  /** Aborts every read in flight and refuses new ones. */
  stop(): void;
}

export type BindingsDeps = Pick<
  ExplorerModuleDeps,
  'mgmt' | 'clock' | 'limits'
>;

interface Entry {
  readonly rows: readonly BindingRow[];
  readonly dropped: number;
  readonly expected: number | undefined;
  /** The broker sent the whole vhost in one answer and ignored the paging. */
  readonly unpaged: boolean;
  readonly loadedAt: number;
  /** The last time the broker was asked, whether it answered or not. */
  readonly checkedAt: number;
  readonly version: number;
  /** The last read failed; these rows are from an earlier one. */
  readonly stale: boolean;
  readonly sorted: Map<string, readonly BindingRow[]>;
}

interface ConnectionState {
  /** In use order: the first is the least recently used. */
  readonly vhosts: Map<string, Entry>;
  readonly loading: Map<string, Promise<Entry>>;
  rows: number;
  versions: number;
  evictions: number;
  evictedRows: number;
}

function failure(error: unknown, aborted: boolean): AppError {
  if (aborted) {
    return new AppError('ENGINE_SHUTTING_DOWN', {
      detail: 'The bindings read was cancelled.',
    });
  }
  const code = ErrorCodeSchema.safeParse(
    (error as { code?: unknown } | null)?.code,
  );
  // Fixed text: broker text never reaches an output (I-10).
  return new AppError(code.success ? code.data : 'BROKER_ERROR', {
    detail: 'The bindings of the vhost could not be read.',
  });
}

/** Text looks at the three names of a binding; the facets that have no meaning here match nothing. */
function matcher(
  filter: InventoryFilter | undefined,
): ((row: BindingRow) => boolean) | undefined {
  if (filter === undefined) return undefined;
  const text = filter.text?.toLowerCase();
  const types = filter.types && new Set(filter.types);
  const meaningless =
    filter.states !== undefined ||
    filter.hasConsumers !== undefined ||
    filter.minMessages !== undefined;
  return (row) =>
    !meaningless &&
    (text === undefined ||
      [row.source, row.destination, row.routingKey ?? ''].some((s) =>
        s.toLowerCase().includes(text),
      )) &&
    (types === undefined || types.has(row.destinationType));
}

export function createBindingsStore(deps: BindingsDeps): BindingsStore {
  const clock: Clock = deps.clock ?? systemClock;
  const limits = { ...DEFAULT_EXPLORER_LIMITS, ...deps.limits };
  const pageSize = Math.min(limits.pageSize, PAGE_SIZE_CEILING);
  const cap = limits.maxBindingsResident;
  const states = new Map<ConnectionId, ConnectionState>();
  const abort = new AbortController();
  const stopped = (): boolean => abort.signal.aborted;

  const stateOf = (cid: ConnectionId): ConnectionState => {
    let state = states.get(cid);
    if (state === undefined) {
      state = {
        vhosts: new Map(),
        loading: new Map(),
        rows: 0,
        versions: 0,
        evictions: 0,
        evictedRows: 0,
      };
      states.set(cid, state);
    }
    return state;
  };

  /**
   * Pages through the vhost; stops at the cap when the broker's own count tells what is left. A broker
   * that ignores `page` (RabbitMQ on this endpoint) answers the whole vhost at once: the cap is then
   * applied to that one answer, the rest is counted as dropped, and `unpaged` says so.
   */
  async function read(cid: ConnectionId, vhost: string) {
    const rows: BindingRow[] = [];
    let dropped = 0;
    let expected: number | undefined;
    let unpaged = false;
    for (let n = 1; ; n++) {
      abort.signal.throwIfAborted();
      const answer = await deps.mgmt.get(
        {
          connectionId: cid,
          path: `/api/bindings/${encodeURIComponent(vhost)}`,
          query: { page: n, page_size: pageSize },
          schema: BindingPageSchema,
          lane: 'interactive',
        },
        abort.signal,
      );
      if (n === 1) {
        expected = answer.total;
        unpaged = !answer.paged;
      }
      for (const raw of answer.items) {
        if (rows.length < cap) rows.push(bindingRow(raw));
        else dropped++;
      }
      if (n >= answer.pageCount || answer.items.length === 0) break;
      if (rows.length >= cap && expected !== undefined) {
        dropped = Math.max(dropped, expected - rows.length);
        break;
      }
    }
    return { rows, dropped, expected, unpaged };
  }

  /** Makes the vhost the most recently used and evicts the others, oldest first, until it all fits. */
  function install(state: ConnectionState, vhost: string, entry: Entry): void {
    const old = state.vhosts.get(vhost);
    state.rows -= old?.rows.length ?? 0;
    state.vhosts.delete(vhost);
    state.vhosts.set(vhost, entry);
    state.rows += entry.rows.length;
    for (const [name, other] of state.vhosts) {
      if (state.rows <= cap || name === vhost) break;
      state.vhosts.delete(name);
      state.rows -= other.rows.length;
      state.evictions++;
      state.evictedRows += other.rows.length;
    }
  }

  function load(cid: ConnectionId, vhost: string, state: ConnectionState) {
    let inflight = state.loading.get(vhost);
    if (inflight === undefined) {
      inflight = read(cid, vhost)
        .then(({ rows, dropped, expected, unpaged }) => {
          const now = clock.now();
          const entry: Entry = {
            rows,
            dropped,
            expected,
            unpaged,
            loadedAt: now,
            checkedAt: now,
            version: ++state.versions,
            stale: false,
            sorted: new Map(),
          };
          install(state, vhost, entry);
          return entry;
        })
        .finally(() => {
          state.loading.delete(vhost);
        });
      state.loading.set(vhost, inflight);
    }
    return inflight;
  }

  function sortedRows(entry: Entry, sort: InventorySort) {
    const id = `${sort.column}|${sort.dir}`;
    let hit = entry.sorted.get(id);
    if (hit === undefined) {
      hit = [...entry.rows].sort(comparator<BindingRow>(sort));
      if (entry.sorted.size >= SORT_CACHE_ENTRIES) {
        const oldest = entry.sorted.keys().next();
        if (!oldest.done) entry.sorted.delete(oldest.value);
      }
      entry.sorted.set(id, hit);
    }
    return hit;
  }

  return {
    async window(cid, vhost, query, signal) {
      if (stopped()) throw failure(undefined, true);
      const state = stateOf(cid);
      let entry = state.vhosts.get(vhost);
      if (
        entry === undefined ||
        clock.now() - entry.checkedAt >= limits.bindingsMaxAgeMs
      ) {
        try {
          entry = await load(cid, vhost, state);
        } catch (error) {
          // A vhost that was never read has nothing to show; a resident one is served, marked stale.
          if (entry === undefined || stopped()) {
            throw failure(error, stopped() || signal.aborted);
          }
          entry = { ...entry, checkedAt: clock.now(), stale: true };
        }
      }
      signal.throwIfAborted();
      install(state, vhost, entry);
      const all = sortedRows(entry, query.sort ?? DEFAULT_SORT);
      const keep = matcher(query.filter);
      const found = keep ? all.filter(keep) : all;
      const current = entry.version;
      return {
        rows: found.slice(query.offset, query.offset + query.limit),
        matched: found.length,
        total: entry.rows.length,
        version: {
          version: current,
          sweptAt: entry.loadedAt,
          complete: true,
          dropped: entry.dropped,
          truncated: entry.dropped > 0,
          stale: entry.stale,
        },
        versionChanged:
          query.version !== undefined && query.version !== current,
        expected: entry.expected,
        unpaged: entry.unpaged,
      };
    },
    stats(cid) {
      const state = states.get(cid);
      return {
        vhosts: [...(state?.vhosts.keys() ?? [])],
        rows: state?.rows ?? 0,
        dropped: [...(state?.vhosts.values() ?? [])].reduce(
          (n, e) => n + e.dropped,
          0,
        ),
        evictions: state?.evictions ?? 0,
        evictedRows: state?.evictedRows ?? 0,
      };
    },
    stop() {
      abort.abort();
    },
  };
}
