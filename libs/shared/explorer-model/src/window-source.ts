// The window source of one explorer grid (M0-54, R1 to R3): one object is one query, a changed
// filter or kind is a new source. It turns the grid's block requests into `inventory.query` calls,
// pins one scroll to one index version, says what the last answer said about its freshness, and
// follows the rows on screen through `explorer.window`. It is structurally an `EngineWindowSource`
// of `ui-grid`, without importing it.
import { ConnectionIdSchema, EXPLORER_VERSION_KEY } from '@app/contracts';

import {
  isFilterEmpty,
  sanitizeFilter,
  WINDOW_BLOCK,
  type ExplorerFilter,
} from './inventory-model';
import { fitKeys } from './key-budget';
import type {
  ExplorerData,
  ExplorerKind,
  ExplorerLiveEvent,
  ExplorerWindowItem,
  ExplorerWindowParams,
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
  /** Subscriptions after the first one (an `unsub` and a new `sub` for a changed set of rows). */
  readonly resubscribes: number;
  /** Version markers seen on the topic. */
  readonly markers: number;
  /** `refresh` changes asked of the grid. */
  readonly refreshes: number;
  /** Snapshots reconciled against the followed rows. */
  readonly reconciled: number;
  readonly gaps: number;
  readonly resets: number;
  readonly versionChanges: number;
  /** `remove` changes sent for rows that left the inventory (a removal, or a snapshot that lacked them). */
  readonly removals: number;
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
  /** `off` for bindings (no topic) and until the first rows are reported. */
  readonly live: 'off' | 'connecting' | 'following' | 'ended';
  /** The Problem (or the loss) that ended the topic; `null` when it ended without one. */
  readonly liveProblem: unknown;
  /** The topic's own health (the `status` frame), or `null` before one arrived. */
  readonly liveStatus: string | null;
  readonly followed: number;
  /** Ids on screen that did not fit one subscription (I-13: said, not silent). */
  readonly unfollowed: number;
  readonly counters: WindowSourceCounters;
}

export interface InventoryWindowSource<K extends ExplorerKind> {
  readonly rowId: (row: InventoryRows[K]) => string;
  window(
    request: WindowRequest,
    signal: AbortSignal,
  ): Promise<WindowAnswer<InventoryRows[K]>>;
  /** The grid reports the ids it shows; the source follows exactly those (one resubscribe per change). */
  watch(visibleIds: ReadonlySet<string>): void;
  onChanges(
    listener: (changes: readonly RowChange<InventoryRows[K]>[]) => void,
  ): () => void;
  /** The grid reloaded its cache: the next window starts a new scroll. */
  refreshed(): void;
  state(): WindowSourceState;
  onState(listener: (state: WindowSourceState) => void): () => void;
  /** Aborts what is in flight, ends the subscription and releases everything. */
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
  removals: 0,
};

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

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
    liveStatus: null,
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

  // ---- R3: following the rows on screen ---------------------------------------------------------

  /** The ids of the current subscription; `null` when none is open. */
  let followedIds: ReadonlySet<string> | null = null;
  let lastReported: ReadonlySet<string> = new Set();
  let unsubscribe: (() => void) | null = null;
  /** Bumped on every subscribe and unsubscribe, so an event of an ended subscription is ignored. */
  let generation = 0;
  /** The newest marker version a `refresh` was already asked for (one per version). */
  let askedForMarker = 0;

  const rowOf = (item: ExplorerWindowItem): InventoryRows[K] | undefined =>
    item.row === undefined
      ? undefined
      : ({ ...item.row, key: item.key } as unknown as InventoryRows[K]);

  /** A marker newer than the pin says the membership moved on: ask for one reload per version. */
  const onMarker = (version: number): void => {
    bump('markers');
    const { pin } = state;
    if (pin !== null && version > pin && version > askedForMarker) {
      askedForMarker = version;
      bump('refreshes');
      emit([{ kind: 'refresh' }]);
    }
  };

  const applyItems = (
    items: readonly ExplorerWindowItem[],
    followed: ReadonlySet<string>,
    changes: RowChange<InventoryRows[K]>[],
  ): void => {
    for (const item of items) {
      if (item.key === EXPLORER_VERSION_KEY) {
        onMarker(item.version);
        continue;
      }
      if (!followed.has(item.key)) continue; // a row nobody asked for
      const row = rowOf(item);
      if (row !== undefined) changes.push({ kind: 'upsert', row });
    }
  };

  const stopFollowing = (): void => {
    generation += 1;
    const end = unsubscribe;
    unsubscribe = null;
    followedIds = null;
    end?.();
  };

  const onFollow = (mine: number, event: ExplorerLiveEvent): void => {
    if (destroyed || mine !== generation || followedIds === null) return;
    const followed = followedIds;
    switch (event.kind) {
      case 'snapshot': {
        const changes: RowChange<InventoryRows[K]>[] = [];
        const present = new Set(event.items.map((i) => i.key));
        // A followed key that is not in the snapshot has left the inventory.
        let removed = 0;
        for (const id of followed) {
          if (!present.has(id)) {
            changes.push({ kind: 'remove', rowId: id });
            removed += 1;
          }
        }
        applyItems(event.items, followed, changes);
        set({ live: 'following' });
        bump('reconciled');
        if (removed > 0) bump('removals', removed);
        if (changes.length > 0) emit(changes);
        return;
      }
      case 'delta': {
        const changes: RowChange<InventoryRows[K]>[] = [];
        for (const rowId of event.removes) {
          changes.push({ kind: 'remove', rowId });
        }
        if (event.removes.length > 0) bump('removals', event.removes.length);
        applyItems(event.upserts, followed, changes);
        if (changes.length > 0) emit(changes);
        return;
      }
      case 'gap':
        bump('gaps'); // the snapshot that follows is reconciled like the first one
        return;
      case 'status':
        set({ liveStatus: event.state });
        return;
      case 'reset':
        // The engine started a new session: its versions restart, so the pin means nothing.
        bump('resets');
        epoch += 1;
        reloadAsked = false;
        askedForMarker = 0;
        set({ pin: null, live: 'connecting' });
        bump('refreshes');
        emit([{ kind: 'refresh' }]);
        return;
      case 'error':
      case 'end':
        // The topic is over; the grid keeps working from windows and the person can still reload.
        stopFollowing();
        set({
          live: 'ended',
          liveProblem: event.kind === 'error' ? event.error : null,
          followed: 0,
          unfollowed: 0,
        });
        return;
    }
  };

  function watch(visibleIds: ReadonlySet<string>): void {
    if (destroyed || kind === 'bindings' || state.live === 'ended') return;
    const reported = new Set(visibleIds);
    const same = sameSet(reported, lastReported);
    lastReported = reported;
    if (same || reported.size === 0) return;
    // A set inside what is followed needs nothing: those rows are already named.
    const current = followedIds;
    if (current !== null && [...reported].every((id) => current.has(id)))
      return;

    const { keys, unfollowed } = fitKeys([...reported]);
    const resubscribed = unsubscribe !== null;
    stopFollowing(); // an `unsub`, before the `sub` of the new set (OQ-657)
    const mine = generation;
    followedIds = new Set(keys);
    const params: ExplorerWindowParams = {
      cid,
      kind: kind,
      keys,
    };
    unsubscribe = data.follow(params, (event) => {
      onFollow(mine, event);
    });
    if (resubscribed) bump('resubscribes');
    set({ live: 'connecting', followed: keys.length, unfollowed });
  }

  return {
    rowId: (row) => row.key,
    window,
    watch,
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
      stopFollowing();
      stateListeners.clear();
      changeListeners.clear();
    },
  };
}
