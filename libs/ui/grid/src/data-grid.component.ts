// <app-data-grid>: AG Grid Community behind the contract of this library (blueprint 10, DC-52). The
// component calls `createGrid` itself (no `ag-grid-angular`, OQ-541), reads rows only through an
// `EngineWindowSource` and keeps the selection and the column state as plain values the feature can
// store. Everything the user sees is text; no cell is ever markup (ADR-021, AC-9).
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  model,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ThemeService } from '@app/ui-design';
import { createGrid, type GridApi, type GridOptions } from 'ag-grid-community';

import {
  defaultColumnState,
  normalizeColumnState,
  type GridColumnEntry,
  type GridColumnState,
} from './column-state';
import { resolveColumns, type GridColumn } from './columns';
import {
  buildGridOptions,
  GRID_MAX_CONCURRENT_REQUESTS,
  GRID_MODULES,
  pushGridTheme,
  readGridTheme,
  selectionOptions,
  toColDefs,
  type GridLabels,
} from './grid-config';
import { GRID_RENDER_ALL, GRID_STYLE_NONCE } from './grid-internals';
import { selectRow, type GridSelectionMode } from './selection';
import {
  EMPTY_GRID_STATS,
  mapSortModel,
  WindowedDatasource,
  type GridStats,
} from './windowed-datasource';
import {
  GRID_BLOCK_SIZE,
  GRID_MAX_BLOCKS,
  type EngineWindowSource,
  type GridRowChange,
  type GridSort,
} from './window-source';

const NO_IDS: ReadonlySet<string> = new Set();

@Component({
  selector: 'app-data-grid',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div #host class="grid-host"></div>`,
  styles: `
    :host {
      display: block;
      height: 100%;
      min-height: 0;
    }
    .grid-host {
      height: 100%;
    }
  `,
})
export class DataGrid<Row> {
  /** The columns, already translated. A new array re-maps the columns; the column state is kept. */
  readonly columns = input.required<readonly GridColumn<Row>[]>();
  /** A new object is a new query: the cache is purged, in-flight requests are aborted and the grid rebinds. */
  readonly source = input.required<EngineWindowSource<Row>>();
  readonly selectionMode = input<GridSelectionMode>('single');
  /** Selected row ids, not indexes: the set survives the eviction of blocks (AC-15). */
  readonly selection = model<ReadonlySet<string>>(NO_IDS);
  /** Order, width, visibility, pinning and sort as plain JSON; a feature stores it as a view. */
  readonly columnState = model<GridColumnState | null>(null);
  /** Every word the grid shows, already translated. */
  readonly labels = input.required<GridLabels>();

  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private readonly theme = inject(ThemeService);
  private readonly nonce = inject(GRID_STYLE_NONCE);
  private readonly renderAll = inject(GRID_RENDER_ALL);

  private readonly api = signal<GridApi<Row> | null>(null);
  private readonly datasource = signal<WindowedDatasource<Row> | null>(null);
  private readonly resolved = computed(() => resolveColumns(this.columns()));

  /** Counters for the status bar: blocks, drops, refreshes (I-13). */
  readonly stats = computed<GridStats>(
    () => this.datasource()?.stats() ?? EMPTY_GRID_STATS,
  );
  /** `null` until the source says; never 0 for unknown. */
  readonly total = computed(() => this.datasource()?.total() ?? null);
  /** The reason of the last failed block, until a retry. */
  readonly error = computed(() => this.datasource()?.error() ?? null);

  #lastState = '';
  #applyingState = false;
  #mirrored: ReadonlySet<string> = NO_IDS;

  constructor() {
    afterNextRender(() => {
      this.#create();
    });
    inject(DestroyRef).onDestroy(() => {
      this.datasource()?.destroy();
      this.api()?.destroy();
    });

    // Columns: map to AG Grid definitions (function getters only), then restore the state.
    effect(() => {
      const api = this.api();
      const columns = this.resolved();
      if (!api) return;
      untracked(() => {
        api.setGridOption('columnDefs', toColDefs(columns));
        this.#lastState = '';
        this.#applyState(api, this.columnState());
      });
    });
    // A column state from outside (a saved view) is applied once; the one the grid emitted is not.
    effect(() => {
      const state = this.columnState();
      const api = this.api();
      if (!api) return;
      untracked(() => {
        this.#applyState(api, state);
      });
    });
    // A new source is a new query.
    effect(() => {
      const api = this.api();
      const source = this.source();
      if (!api) return;
      untracked(() => {
        this.#bind(api, source);
      });
    });
    effect(() => {
      const api = this.api();
      const mode = this.selectionMode();
      if (!api) return;
      untracked(() => {
        api.setGridOption('rowSelection', selectionOptions(mode));
        this.#mirror(api, this.selection());
      });
    });
    effect(() => {
      const api = this.api();
      const selection = this.selection();
      if (!api) return;
      untracked(() => {
        this.#mirror(api, selection);
      });
    });
    // The theme bridge: tokens into AG Grid theme parameters and the row height, in one turn (AC-17).
    effect(() => {
      const api = this.api();
      this.theme.revision();
      const scheme =
        this.theme.resolved() === 'light'
          ? ('light' as const)
          : ('dark' as const);
      if (!api) return;
      untracked(() => {
        pushGridTheme(
          api,
          readGridTheme((name) => this.theme.token(name), scheme),
        );
      });
    });
    effect(() => {
      const api = this.api();
      const labels = this.labels();
      if (!api) return;
      untracked(() => {
        api.setGridAriaProperty('label', labels.gridLabel);
      });
    });
  }

  #create(): void {
    const snapshot = readGridTheme(
      (name) => this.theme.token(name),
      this.theme.resolved() === 'light' ? 'light' : 'dark',
    );
    const options: GridOptions<Row> = {
      ...buildGridOptions<Row>({
        styleNonce: this.nonce,
        columnDefs: toColDefs(this.resolved()),
        getRowId: (row) => this.source().rowId(row),
        theme: snapshot.theme,
        rowHeight: snapshot.rowHeight,
        labels: this.labels(),
        selectionMode: this.selectionMode(),
        renderAll: this.renderAll,
      }),
      onCellClicked: (event) => {
        const id = event.node.id;
        if (event.data === undefined || id === undefined) return;
        const original = event.event;
        const additive =
          original instanceof MouseEvent &&
          (original.ctrlKey || original.metaKey);
        this.#select(id, additive);
      },
      onCellKeyDown: (event) => {
        const original = event.event;
        const id = event.node.id;
        if (
          !(original instanceof KeyboardEvent) ||
          original.key !== ' ' ||
          event.data === undefined ||
          id === undefined
        )
          return;
        original.preventDefault(); // Space selects; it does not scroll the page
        this.#select(id, true);
      },
      onSortChanged: () => {
        this.#capture();
      },
      onColumnMoved: (event) => {
        if (event.finished) this.#capture();
      },
      onColumnVisible: () => {
        this.#capture();
      },
      onColumnPinned: () => {
        this.#capture();
      },
      onColumnResized: (event) => {
        if (event.finished) this.#capture();
      },
      onModelUpdated: () => {
        this.#reportVisible();
        this.#mirror(this.api(), this.selection());
      },
      onViewportChanged: () => {
        this.#reportVisible();
      },
    };
    this.api.set(
      createGrid<Row>(this.host().nativeElement, options, {
        modules: [...GRID_MODULES],
      }),
    );
  }

  #bind(api: GridApi<Row>, source: EngineWindowSource<Row>): void {
    this.datasource()?.destroy(); // aborts what is in flight; a late answer is dropped and counted
    const ds = new WindowedDatasource<Row>({
      source,
      maxConcurrent: GRID_MAX_CONCURRENT_REQUESTS,
      onApply: (changes) => {
        this.#applyChanges(api, changes);
      },
      onRefresh: () => {
        api.refreshInfiniteCache();
      },
    });
    this.datasource.set(ds);
    api.setGridOption('datasource', {
      getRows: (params) => {
        ds.getRows({
          startRow: params.startRow,
          endRow: params.endRow,
          sort: mapSortModel(params.sortModel),
          success: (rows, lastRow) => {
            params.successCallback(rows as Row[], lastRow);
          },
          fail: () => {
            params.failCallback();
          },
        });
      },
    });
  }

  /** The user asks to load failed blocks again. */
  retry(): void {
    this.datasource()?.retry();
  }

  #applyChanges(
    api: GridApi<Row>,
    changes: readonly GridRowChange<Row>[],
  ): void {
    for (const change of changes) {
      if (change.kind !== 'upsert') continue; // a remove is a refresh, decided by the datasource
      api.getRowNode(this.source().rowId(change.row))?.setData(change.row);
    }
  }

  /** Tells the datasource which ids are on screen, so the live feed follows only those. */
  #reportVisible(): void {
    const api = this.api();
    const ds = this.datasource();
    if (!api || !ds) return;
    const first = api.getFirstDisplayedRowIndex();
    const last = api.getLastDisplayedRowIndex();
    if (first < 0 || last < first) {
      ds.setVisibleIds(NO_IDS);
      return;
    }
    const ids = new Set<string>();
    const stop = Math.min(last, first + GRID_BLOCK_SIZE * GRID_MAX_BLOCKS - 1);
    for (let i = first; i <= stop; i++) {
      const node = api.getDisplayedRowAtIndex(i);
      if (node?.data !== undefined && node.id !== undefined) ids.add(node.id);
    }
    ds.setVisibleIds(ids);
  }

  #select(rowId: string, additive: boolean): void {
    const change = selectRow(
      this.selection(),
      this.selectionMode(),
      rowId,
      additive,
    );
    this.selection.set(change.selection);
  }

  /**
   * Shows the selection set on the rows that are loaded. AG Grid only displays it (`aria-selected`,
   * the selected-row class); a row that is not in the cache is not touched, and the set is the truth.
   */
  #mirror(api: GridApi<Row> | null, selection: ReadonlySet<string>): void {
    if (!api || (selection.size === 0 && this.#mirrored.size === 0)) return;
    for (const id of this.#mirrored) {
      if (!selection.has(id))
        api.getRowNode(id)?.setSelected(false, false, 'api');
    }
    for (const id of selection) {
      const node = api.getRowNode(id);
      if (node && !node.isSelected()) node.setSelected(true, false, 'api');
    }
    this.#mirrored = selection;
  }

  #applyState(api: GridApi<Row>, raw: GridColumnState | null): void {
    const columns = this.resolved();
    const state =
      raw === null
        ? defaultColumnState(columns)
        : normalizeColumnState(raw, columns);
    const json = JSON.stringify(state);
    if (json === this.#lastState) return;
    this.#lastState = json;
    const sortIndex = new Map(state.sort.map((s, i) => [s.columnId, i]));
    this.#applyingState = true;
    try {
      api.applyColumnState({
        applyOrder: true,
        state: state.columns.map((c) => {
          const at = sortIndex.get(c.id);
          const sort = at === undefined ? undefined : state.sort[at];
          return {
            colId: c.id,
            hide: c.hidden === true,
            ...(c.width === undefined ? {} : { width: c.width }),
            pinned: c.pinned ?? null,
            sort: sort?.direction ?? null,
            sortIndex: at ?? null,
          };
        }),
      });
    } finally {
      this.#applyingState = false;
    }
  }

  /** Reads the state back from AG Grid after the user changed it, and publishes it if it differs. */
  #capture(): void {
    const api = this.api();
    if (!api || this.#applyingState) return;
    const columns = this.resolved();
    const entries: GridColumnEntry[] = [];
    const sorted: { sortIndex: number; sort: GridSort }[] = [];
    for (const c of api.getColumnState()) {
      entries.push({
        id: c.colId,
        hidden: c.hide === true,
        ...(typeof c.width === 'number' ? { width: Math.round(c.width) } : {}),
        pinned: c.pinned === 'left' || c.pinned === 'right' ? c.pinned : null,
      });
      if (c.sort === 'asc' || c.sort === 'desc') {
        sorted.push({
          sortIndex: c.sortIndex ?? 0,
          sort: { columnId: c.colId, direction: c.sort },
        });
      }
    }
    sorted.sort((a, b) => a.sortIndex - b.sortIndex);
    const state = normalizeColumnState(
      { version: 1, columns: entries, sort: sorted.map((s) => s.sort) },
      columns,
    );
    const json = JSON.stringify(state);
    if (json === this.#lastState) return;
    this.#lastState = json;
    this.columnState.set(state);
  }
}
