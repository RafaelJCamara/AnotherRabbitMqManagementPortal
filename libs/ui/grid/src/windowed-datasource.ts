import { computed, signal, type Signal } from '@angular/core';

import {
  GRID_BLOCK_SIZE,
  GRID_MAX_BLOCKS,
  type EngineWindowSource,
  type GridRowChange,
  type GridSort,
} from './window-source';

/** Counters the status bar shows. Every drop is counted (I-6, I-13). */
export interface GridStats {
  readonly blocksLoaded: number;
  readonly blocksFailed: number;
  readonly changesApplied: number;
  readonly changesDropped: number; // a change for an id that is not shown
  readonly staleAnswers: number; // an answer that arrived after its request was aborted
  readonly refreshes: number;
  readonly copyTruncated: number; // owned by the clipboard (a later slice); kept here so one object carries all counters
}

/** One block request, in the shape of AG Grid's infinite-model `getRows` params (mapped by the component). */
export interface BlockRequest<Row> {
  readonly startRow: number;
  readonly endRow: number;
  readonly sort: readonly GridSort[];
  success(rows: readonly Row[], lastRow: number | undefined): void;
  fail(): void;
}

export interface WindowedDatasourceOptions<Row> {
  readonly source: EngineWindowSource<Row>;
  /** Requests allowed in flight at once; the rest wait (at most GRID_MAX_BLOCKS), then fail. */
  readonly maxConcurrent?: number;
  /** Rows of the cache changed in place (visible ids only). */
  readonly onApply?: (changes: readonly GridRowChange<Row>[]) => void;
  /** The cache must reload: a row left, or the user retried. */
  readonly onRefresh?: () => void;
}

export const CHANGE_WINDOW_MS = 100;
export const WATCH_DEBOUNCE_MS = 100;
export const REFRESH_MIN_INTERVAL_MS = 5000;

/** All counters at zero: the stats of a grid that has no datasource yet. */
export const EMPTY_GRID_STATS: GridStats = {
  blocksLoaded: 0,
  blocksFailed: 0,
  changesApplied: 0,
  changesDropped: 0,
  staleAnswers: 0,
  refreshes: 0,
  copyTruncated: 0,
};

/** Maps AG Grid's sort model to the contract's sort. */
export function mapSortModel(
  model: readonly { readonly colId: string; readonly sort: 'asc' | 'desc' }[],
): readonly GridSort[] {
  return model.map((m) => ({ columnId: m.colId, direction: m.sort }));
}

/**
 * Turns an `EngineWindowSource` into block loads for the infinite row model. A new source is a new
 * datasource: `destroy()` aborts what is in flight, and nothing from it reaches the grid afterwards.
 */
export class WindowedDatasource<Row> {
  readonly #opts: WindowedDatasourceOptions<Row>;
  readonly #max: number;
  readonly #stats = signal<GridStats>(EMPTY_GRID_STATS);
  readonly #total = signal<number | null>(null);
  readonly #error = signal<unknown>(null);
  readonly #failed = signal(false);
  readonly #busy = signal(0); // requests in flight plus requests waiting
  readonly #inflight = new Set<AbortController>();
  readonly #waiting: BlockRequest<Row>[] = [];
  readonly #pending = new Map<string, GridRowChange<Row>>(); // keyed by visible id, so bounded by the visible set
  readonly #unsubscribe: (() => void) | undefined;
  #visible: ReadonlySet<string> = new Set();
  #destroyed = false;
  #changeTimer: ReturnType<typeof setTimeout> | undefined;
  #watchTimer: ReturnType<typeof setTimeout> | undefined;
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #lastRefresh = Number.NEGATIVE_INFINITY;

  readonly stats: Signal<GridStats> = this.#stats.asReadonly();
  /** `null` until the source says; an unknown total is never 0. */
  readonly total: Signal<number | null> = this.#total.asReadonly();
  /** The reason of the last failed block, until a retry. */
  readonly error: Signal<unknown> = this.#error.asReadonly();
  /** True from a failed block until a retry; unlike `error` it holds when the reason was `undefined`. */
  readonly failed: Signal<boolean> = this.#failed.asReadonly();
  /** True while a block is in flight or waiting for a slot. */
  readonly loading: Signal<boolean> = computed(() => this.#busy() > 0);

  constructor(opts: WindowedDatasourceOptions<Row>) {
    this.#opts = opts;
    this.#max = Math.max(1, opts.maxConcurrent ?? 2);
    this.#unsubscribe = opts.source.onChanges?.((changes) => {
      this.#enqueue(changes);
    });
  }

  getRows(request: BlockRequest<Row>): void {
    if (this.#destroyed) return;
    if (this.#inflight.size >= this.#max) {
      if (this.#waiting.length >= GRID_MAX_BLOCKS) {
        this.#failBlock(request, 'too many queued blocks');
        return;
      }
      this.#waiting.push(request);
      this.#syncBusy();
      return;
    }
    this.#start(request);
  }

  /** The user asked to load a failed block again: the cache reloads, and the error clears. */
  retry(): void {
    this.#error.set(null);
    this.#failed.set(false);
    this.#bump('refreshes');
    this.#opts.onRefresh?.();
  }

  /** The grid reports the ids it shows; the source hears of them after 100 ms without change. */
  setVisibleIds(ids: ReadonlySet<string>): void {
    if (this.#destroyed) return;
    this.#visible = ids;
    clearTimeout(this.#watchTimer);
    this.#watchTimer = setTimeout(
      () => this.#opts.source.watch?.(this.#visible),
      WATCH_DEBOUNCE_MS,
    );
  }

  destroy(): void {
    this.#destroyed = true;
    this.#unsubscribe?.();
    for (const c of this.#inflight) c.abort();
    this.#inflight.clear();
    this.#waiting.length = 0;
    this.#syncBusy();
    this.#pending.clear();
    clearTimeout(this.#changeTimer);
    clearTimeout(this.#watchTimer);
    clearTimeout(this.#refreshTimer);
  }

  #start(request: BlockRequest<Row>): void {
    const limit = request.endRow - request.startRow;
    if (
      request.startRow % GRID_BLOCK_SIZE !== 0 ||
      limit < 1 ||
      limit > GRID_BLOCK_SIZE
    ) {
      this.#failBlock(
        request,
        `block ${String(request.startRow)}-${String(request.endRow)} is not aligned to ${String(GRID_BLOCK_SIZE)}`,
      );
      return;
    }
    const abort = new AbortController();
    this.#inflight.add(abort);
    this.#syncBusy();
    const { source } = this.#opts;
    const settle = (): void => {
      this.#inflight.delete(abort);
      const next = this.#waiting.shift();
      this.#syncBusy();
      if (next && !this.#destroyed) this.#start(next);
    };
    source
      .window(
        { offset: request.startRow, limit, sort: request.sort },
        abort.signal,
      )
      .then(
        (win) => {
          settle();
          if (abort.signal.aborted || this.#destroyed) {
            this.#bump('staleAnswers');
            return;
          }
          if (win.rows.length > limit) {
            this.#failBlock(
              request,
              `answered ${String(win.rows.length)} rows for a limit of ${String(limit)}`,
            );
            return;
          }
          if (win.total !== null) this.#total.set(win.total);
          const lastRow =
            win.total ??
            (win.rows.length < limit
              ? request.startRow + win.rows.length
              : undefined);
          this.#bump('blocksLoaded');
          request.success(win.rows, lastRow);
        },
        (reason: unknown) => {
          settle();
          if (abort.signal.aborted || this.#destroyed) return;
          this.#failBlock(request, reason);
        },
      );
  }

  /** A block fails as a whole: nothing is truncated or shown partly. */
  #failBlock(request: BlockRequest<Row>, reason: unknown): void {
    this.#error.set(reason);
    this.#failed.set(true);
    this.#bump('blocksFailed');
    request.fail();
  }

  #enqueue(changes: readonly GridRowChange<Row>[]): void {
    if (this.#destroyed) return;
    for (const change of changes) {
      const id =
        change.kind === 'upsert'
          ? this.#opts.source.rowId(change.row)
          : change.rowId;
      if (this.#visible.has(id)) this.#pending.set(id, change);
      else this.#bump('changesDropped');
    }
    if (this.#pending.size > 0 && this.#changeTimer === undefined) {
      this.#changeTimer = setTimeout(() => {
        this.#flush();
      }, CHANGE_WINDOW_MS);
    }
  }

  #flush(): void {
    this.#changeTimer = undefined;
    const batch = [...this.#pending.values()];
    this.#pending.clear();
    if (batch.length === 0 || this.#destroyed) return;
    this.#stats.update((s) => ({
      ...s,
      changesApplied: s.changesApplied + batch.length,
    }));
    this.#opts.onApply?.(batch);
    if (batch.some((c) => c.kind === 'remove')) this.#requestRefresh();
  }

  /** At most one refresh every 5 s: the first goes at once, later ones wait for the interval to pass. */
  #requestRefresh(): void {
    if (this.#refreshTimer !== undefined) return;
    const wait = Math.max(
      0,
      this.#lastRefresh + REFRESH_MIN_INTERVAL_MS - Date.now(),
    );
    if (wait === 0) {
      this.#refreshNow();
      return;
    }
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = undefined;
      this.#refreshNow();
    }, wait);
  }

  #refreshNow(): void {
    this.#lastRefresh = Date.now();
    this.#bump('refreshes');
    this.#opts.onRefresh?.();
  }
  #syncBusy(): void {
    this.#busy.set(this.#inflight.size + this.#waiting.length);
  }

  #bump(key: keyof GridStats): void {
    this.#stats.update((s) => ({ ...s, [key]: s[key] + 1 }));
  }
}
