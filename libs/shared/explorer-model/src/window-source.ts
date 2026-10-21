// The window source of one explorer grid (M0-54, R1 and R2): one object is one query, a changed
// filter or kind is a new source. It turns the grid's block requests into `inventory.query` calls,
// pins one scroll to one index version and says what the last answer said about its freshness.
// It is structurally an `EngineWindowSource` of `ui-grid`, without importing it.
import { ConnectionIdSchema } from '@app/contracts';

import {
  isFilterEmpty,
  sanitizeFilter,
  WINDOW_BLOCK,
  type ExplorerFilter,
} from './inventory-model';
import type {
  ExplorerData,
  ExplorerKind,
  Freshness,
  InventoryQueryInput,
  InventoryRows,
  RowChange,
  WindowAnswer,
  WindowRequest,
} from './ports';

export interface InventoryQuery<K extends ExplorerKind = ExplorerKind> {
  readonly cid: string;
  readonly kind: K;
  readonly filter: ExplorerFilter;
}

/** What the page and the tests read: counts and shapes, never a clock. */
export interface WindowSourceCounters {
  readonly windows: number;
  readonly windowFailures: number;
  readonly resubscribes: number;
  readonly markers: number;
  readonly refreshes: number;
  readonly reconciled: number;
  readonly gaps: number;
  readonly resets: number;
  readonly versionChanges: number;
}

export interface WindowSourceState {
  /** The freshness of the last answer; `null` before the first. */
  readonly freshness: Freshness | null;
  /** Rows after the filter, as the engine counted them; `null` before the first answer. */
  readonly matched: number | null;
  /** The index version the current scroll is pinned to. */
  readonly pin: number | null;
  /** The last answer said the pinned version was gone and was read from a newer one. */
  readonly versionChanged: boolean;
  readonly live: 'off' | 'connecting' | 'following' | 'ended';
  /** The Problem (or the loss) that ended the topic. */
  readonly liveProblem: unknown;
  readonly followed: number;
  readonly unfollowed: number;
  readonly counters: WindowSourceCounters;
}

export interface InventoryWindowSource<K extends ExplorerKind> {
  readonly rowId: (row: InventoryRows[K]) => string;
  window(
    request: WindowRequest,
    signal: AbortSignal,
  ): Promise<WindowAnswer<InventoryRows[K]>>;
  onChanges(
    listener: (changes: readonly RowChange<InventoryRows[K]>[]) => void,
  ): () => void;
  /** The grid reloaded its cache: the next window starts a new scroll. */
  refreshed(): void;
  state(): WindowSourceState;
  onState(listener: (state: WindowSourceState) => void): () => void;
  /** Aborts what is in flight and releases everything. */
  destroy(): void;
}

const ZERO_COUNTERS: WindowSourceCounters = {
  windows: 0,
  windowFailures: 0,
  resubscribes: 0,
  markers: 0,
  refreshes: 0,
  reconciled: 0,
  gaps: 0,
  resets: 0,
  versionChanges: 0,
};

export function createInventoryWindowSource<K extends ExplorerKind>(
  data: ExplorerData,
  query: InventoryQuery<K>,
): InventoryWindowSource<K> {
  const { kind } = query;
  const cid = ConnectionIdSchema.parse(query.cid);
  const filter = sanitizeFilter(kind, query.filter);
  if (kind === 'bindings' && filter.vhosts?.length !== 1) {
    throw new RangeError('A bindings source names exactly one vhost.');
  }

  let state: WindowSourceState = {
    freshness: null,
    matched: null,
    pin: null,
    versionChanged: false,
    live: 'off',
    liveProblem: null,
    followed: 0,
    unfollowed: 0,
    counters: ZERO_COUNTERS,
  };
  const stateListeners = new Set<(state: WindowSourceState) => void>();
  const changeListeners = new Set<
    (changes: readonly RowChange<InventoryRows[K]>[]) => void
  >();
  const inflight = new Set<AbortController>();
  let destroyed = false;

  // R2: one scroll is one pin. A new sort, a cache reload or a gone version starts a new epoch.
  let pinnedSort = '';
  let epoch = 0;
  let reloadAsked = false;

  const set = (patch: Partial<WindowSourceState>): void => {
    state = { ...state, ...patch };
    for (const listener of stateListeners) listener(state);
  };
  const bump = (name: keyof WindowSourceCounters, by = 1): void => {
    set({ counters: { ...state.counters, [name]: state.counters[name] + by } });
  };
  const emit = (changes: readonly RowChange<InventoryRows[K]>[]): void => {
    for (const listener of changeListeners) listener(changes);
  };
  /** Asks the grid for one cache reload (it spaces them at least 5 s apart). */
  const askReload = (): void => {
    if (reloadAsked || destroyed) return;
    reloadAsked = true;
    bump('refreshes');
    emit([{ kind: 'refresh' }]);
  };

  async function window(
    request: WindowRequest,
    signal: AbortSignal,
  ): Promise<WindowAnswer<InventoryRows[K]>> {
    const { offset, limit } = request;
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset % WINDOW_BLOCK !== 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > WINDOW_BLOCK
    ) {
      throw new RangeError(
        `A window is a block: an offset that is a multiple of ${String(WINDOW_BLOCK)} and at most ${String(WINDOW_BLOCK)} rows (asked ${String(offset)}+${String(limit)}).`,
      );
    }
    if (destroyed)
      throw new DOMException('The source was destroyed.', 'AbortError');
    const sort = request.sort[0];
    const sortKey = sort ? `${sort.columnId}:${sort.direction}` : '';
    if (sortKey !== pinnedSort) {
      pinnedSort = sortKey;
      epoch += 1;
      set({ pin: null });
    }
    const myEpoch = epoch;
    const version = state.pin;
    const input: InventoryQueryInput = {
      cid,
      kind,
      ...(isFilterEmpty(filter) ? {} : { filter }),
      ...(sort ? { sort: { column: sort.columnId, dir: sort.direction } } : {}),
      window: { offset, limit, ...(version === null ? {} : { version }) },
    };

    const link = new AbortController();
    const forward = (): void => {
      link.abort();
    };
    if (signal.aborted) link.abort();
    else signal.addEventListener('abort', forward, { once: true });
    inflight.add(link);
    bump('windows');
    try {
      const out = await data.query(input, link.signal);
      if (out.kind !== kind) {
        throw new TypeError(
          `The engine answered ${out.kind} rows for a ${kind} query.`,
        );
      }
      set({
        freshness: out.freshness,
        matched: out.matched,
        versionChanged: out.freshness.versionChanged,
      });
      if (myEpoch === epoch) {
        if (out.freshness.versionChanged) {
          // The pinned version is gone: this answer is from a newer one. Reload once, from the start.
          bump('versionChanges');
          set({ pin: null });
          askReload();
        } else if (state.pin === null) {
          set({ pin: out.version });
        }
      }
      return {
        rows: out.rows as unknown as readonly InventoryRows[K][],
        total: out.matched,
      };
    } catch (error) {
      if (!link.signal.aborted) bump('windowFailures');
      throw error;
    } finally {
      inflight.delete(link);
      signal.removeEventListener('abort', forward);
    }
  }

  return {
    rowId: (row) => row.key,
    window,
    onChanges(listener) {
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
      };
    },
    refreshed() {
      epoch += 1;
      reloadAsked = false;
      set({ pin: null });
    },
    state: () => state,
    onState(listener) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const link of inflight) link.abort();
      inflight.clear();
      stateListeners.clear();
      changeListeners.clear();
    },
  };
}
