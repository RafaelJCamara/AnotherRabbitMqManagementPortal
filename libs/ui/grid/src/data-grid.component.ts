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
  output,
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
import { GridColumnChooser } from './column-chooser';
import {
  copyRows,
  GRID_CLIPBOARD,
  GRID_MAX_COPY_ROWS,
  type CopyOutcome,
} from './clipboard';
import { resolveColumns, type GridColumn } from './columns';
import {
  GridContextMenu,
  type GridCellTarget,
  type GridMenuItem,
  type GridMenuProvider,
} from './context-menu';
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
import {
  DEFAULT_GRID_KEYBINDINGS,
  matchesChord,
  type GridKeybinding,
} from './keybindings';
import {
  GRID_MAX_SELECTION,
  selectRow,
  type GridSelectionMode,
} from './selection';
import { GridStatusBar } from './status-bar';
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
  imports: [GridColumnChooser, GridContextMenu, GridStatusBar],
  template: `
    <div class="toolbar">
      <app-grid-column-chooser
        [columns]="resolved()"
        [state]="effectiveState()"
        [labels]="labels().columnChooser"
        (stateChange)="columnState.set($event)"
      />
    </div>
    <div #host class="grid-host"></div>
    <app-grid-status-bar
      [labels]="labels().status"
      [total]="total()"
      [loaded]="loadedRows()"
      [selected]="selection().size"
      [loading]="loading()"
      [failed]="error() !== null"
      [copy]="copyOutcome()"
      [capped]="selectionCapped()"
      [selectionCap]="selectionCap"
      [dropped]="stats().changesDropped"
      (retry)="retry()"
    />
    @if (menu(); as open) {
      <app-grid-context-menu
        [items]="open.items"
        [labels]="labels().menu"
        [x]="open.x"
        [y]="open.y"
        (chosen)="onMenuChosen($event)"
        (dismissed)="closeMenu($event.returnFocus)"
      />
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
    }
    .toolbar {
      flex: 0 0 auto;
      padding: var(--ds-space-1) 0;
    }
    .grid-host {
      flex: 1 1 auto;
      min-height: 0;
    }
  `,
})
export class DataGrid<Row> {
  /** The columns, already translated. A new array re-maps the columns; the column state is kept. */
  readonly columns = input.required<readonly GridColumn<Row>[]>();
  /** A new object is a new query: the cache is purged, in-flight requests are aborted and the grid rebinds. */
  readonly source = input.required<EngineWindowSource<Row>>();
  readonly selectionMode = input<GridSelectionMode>('single');
  /**
   * `single` keeps one sort column: a source that sorts by one column (the engine's `inventory.query`)
   * never receives two. A second sort entry is dropped, the first is kept, and `sortTrimmed` says so.
   */
  readonly sortMode = input<'multi' | 'single'>('multi');
  /** A second sort column was dropped in `single` mode. */
  readonly sortTrimmed = output();
  /** Selected row ids, not indexes: the set survives the eviction of blocks (AC-15). */
  readonly selection = model<ReadonlySet<string>>(NO_IDS);
  /** Order, width, visibility, pinning and sort as plain JSON; a feature stores it as a view. */
  readonly columnState = model<GridColumnState | null>(null);
  /** Every word the grid shows, already translated. */
  readonly labels = input.required<GridLabels>();
  /**
   * What the right-click menu holds for a cell. `null` (the default) means no menu. Gated items render
   * the engine's decision as sent; the grid never computes authorisation.
   */
  readonly contextMenu = input<GridMenuProvider<Row> | null>(null);
  /** Key chords; unset means the defaults (open the menu with Shift+F10 or the context-menu key). */
  readonly keybindings = input<readonly GridKeybinding<Row>[] | undefined>(
    undefined,
  );
  /**
   * The user activated a loaded row: Enter on one of its cells (no modifier) or a double click. The row id and
   * the row are given; nothing is selected or opened by the grid itself (M1-42).
   */
  readonly rowActivated = output<{
    readonly rowId: string;
    readonly row: Row;
  }>();
  /** An open item of the menu was chosen. */
  readonly menuAction = output<{
    readonly itemId: string;
    readonly target: GridCellTarget<Row>;
  }>();

  protected readonly menu = signal<{
    readonly items: readonly GridMenuItem[];
    readonly x: number;
    readonly y: number;
    readonly target: GridCellTarget<Row>;
    readonly returnTo: HTMLElement | null;
  } | null>(null);

  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private readonly chooser = viewChild(GridColumnChooser);
  private readonly theme = inject(ThemeService);
  private readonly nonce = inject(GRID_STYLE_NONCE);
  private readonly renderAll = inject(GRID_RENDER_ALL);

  private readonly clipboard = inject(GRID_CLIPBOARD);

  private readonly api = signal<GridApi<Row> | null>(null);
  private readonly datasource = signal<WindowedDatasource<Row> | null>(null);
  protected readonly resolved = computed(() => resolveColumns(this.columns()));
  /** The column state in force, whether the feature gave one or not. */
  protected readonly effectiveState = computed(() => {
    const state = this.columnState();
    const columns = this.resolved();
    return state === null
      ? defaultColumnState(columns)
      : normalizeColumnState(state, columns);
  });
  protected readonly selectionCap = GRID_MAX_SELECTION;
  protected readonly selectionCapped = signal(false);
  protected readonly loadedRows = signal(0);
  protected readonly copyOutcome = signal<CopyOutcome | null>(null);
  private readonly copyTruncated = signal(0);

  /** Counters for the status bar: blocks, drops, refreshes, truncated copies (I-13). */
  readonly stats = computed<GridStats>(() => ({
    ...(this.datasource()?.stats() ?? EMPTY_GRID_STATS),
    copyTruncated: this.copyTruncated(),
  }));
  /** `null` until the source says; never 0 for unknown. */
  readonly total = computed(() => this.datasource()?.total() ?? null);
  /** The reason of the last failed block, until a retry; `null` when none failed. */
  readonly error = computed(() =>
    this.datasource()?.failed() === true
      ? (this.datasource()?.error() ?? 'failed')
      : null,
  );
  /** True while a block is in flight or waiting. */
  readonly loading = computed(() => this.datasource()?.loading() ?? false);

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
      const single = this.sortMode() === 'single';
      if (!api) return;
      untracked(() => {
        api.setGridOption('suppressMultiSort', single);
        this.#lastState = '';
        this.#applyState(api, this.columnState());
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
        suppressMultiSort: this.sortMode() === 'single',
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
          id === undefined ||
          !('column' in event) // a full-width row has no cell
        )
          return;
        const target: GridCellTarget<Row> = {
          rowId: id,
          row: event.data,
          columnId: event.column.getColId(),
        };
        const cell =
          original.target instanceof HTMLElement ? original.target : null;
        const binding = (this.keybindings() ?? DEFAULT_GRID_KEYBINDINGS).find(
          (candidate) => matchesChord(original, candidate.chord),
        );
        if (binding) {
          original.preventDefault();
          binding.run({
            target,
            selection: this.selection(),
            openMenu: () => {
              this.#openMenuAtCell(target, cell);
            },
            copy: () => {
              void this.copySelection();
            },
          });
          return;
        }
        if (original.key === ' ' && event.data !== undefined) {
          original.preventDefault(); // Space selects; it does not scroll the page
          this.#select(id, true);
        } else if (
          original.key === 'Enter' &&
          event.data !== undefined &&
          !original.ctrlKey &&
          !original.metaKey &&
          !original.shiftKey &&
          !original.altKey
        ) {
          original.preventDefault();
          this.rowActivated.emit({ rowId: id, row: event.data });
        }
      },
      onRowDoubleClicked: (event) => {
        const id = event.node.id;
        if (event.data === undefined || id === undefined) return;
        this.rowActivated.emit({ rowId: id, row: event.data });
      },
      onCellContextMenu: (event) => {
        const original = event.event;
        const id = event.node.id;
        if (!(original instanceof MouseEvent) || id === undefined) return;
        original.preventDefault();
        const cell =
          original.target instanceof Element
            ? original.target.closest<HTMLElement>('.ag-cell')
            : null;
        this.#openMenu(
          { rowId: id, row: event.data, columnId: event.column.getColId() },
          original.clientX,
          original.clientY,
          cell,
        );
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
        this.#countLoaded();
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
    this.menu.set(null); // a menu belongs to the query it was opened on
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
          sort: this.#sortOf(mapSortModel(params.sortModel)),
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

  /** In `single` mode only the first sort column goes to the source. */
  #sortOf(sort: readonly GridSort[]): readonly GridSort[] {
    return this.sortMode() === 'single' ? sort.slice(0, 1) : sort;
  }

  #openMenuAtCell(target: GridCellTarget<Row>, cell: HTMLElement | null): void {
    const box = cell?.getBoundingClientRect();
    this.#openMenu(target, box?.left ?? 0, box?.bottom ?? 0, cell);
  }

  #openMenu(
    target: GridCellTarget<Row>,
    x: number,
    y: number,
    returnTo: HTMLElement | null,
  ): void {
    const provider = this.contextMenu();
    if (!provider) return;
    const items = provider(target);
    if (items.length === 0) return;
    this.menu.set({ items, x, y, target, returnTo });
  }

  protected onMenuChosen(itemId: string): void {
    const open = this.menu();
    if (open) this.menuAction.emit({ itemId, target: open.target });
  }

  /** Closes the menu; focus goes back to the cell it was opened on unless it already went elsewhere. */
  protected closeMenu(returnFocus: boolean): void {
    const open = this.menu();
    if (!open) return;
    this.menu.set(null);
    if (returnFocus && open.returnTo?.isConnected === true)
      open.returnTo.focus();
  }

  /** The user asks to load failed blocks again. */
  /** Opens the column chooser, for a command (M1-41). */
  openColumnChooser(): void {
    this.chooser()?.show();
  }

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
    this.selectionCapped.set(change.refused);
    this.copyOutcome.set(null); // a message about the last copy is about the old selection
    this.selection.set(change.selection);
  }

  #countLoaded(): void {
    const api = this.api();
    if (!api) return;
    let loaded = 0;
    api.forEachNode((node) => {
      if (node.data !== undefined) loaded += 1;
    });
    this.loadedRows.set(loaded);
  }

  /**
   * Copies the selected rows that are loaded, as tab-separated text of the displayed values of the
   * visible columns, in the order on screen. What the cap or an unloaded block leaves out is counted
   * and said (I-13); a clipboard that refuses is an error, not silence (AC-11).
   */
  async copySelection(): Promise<void> {
    const api = this.api();
    const selection = this.selection();
    if (!api || selection.size === 0) return;
    const byId = new Map(this.resolved().map((c) => [c.id, c]));
    const columns = api
      .getAllDisplayedColumns()
      .flatMap((c) => byId.get(c.getColId()) ?? []);
    const loaded: { index: number; row: Row }[] = [];
    for (const id of selection) {
      const node = api.getRowNode(id);
      if (node?.data !== undefined) {
        loaded.push({
          index: node.rowIndex ?? Number.MAX_SAFE_INTEGER,
          row: node.data,
        });
      }
    }
    loaded.sort((a, b) => a.index - b.index);
    const outcome = await copyRows(
      this.clipboard,
      columns,
      loaded.map((entry) => entry.row),
      selection.size,
      GRID_MAX_COPY_ROWS,
    );
    this.copyOutcome.set(outcome);
    if (outcome.kind === 'truncated') this.copyTruncated.update((n) => n + 1);
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
    const full =
      raw === null
        ? defaultColumnState(columns)
        : normalizeColumnState(raw, columns);
    const state = { ...full, sort: this.#sortOf(full.sort) };
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
    const all = sorted.map((s) => s.sort);
    const kept = this.#sortOf(all);
    const trimmed = kept.length < all.length;
    const state = normalizeColumnState(
      { version: 1, columns: entries, sort: kept },
      columns,
    );
    const json = JSON.stringify(state);
    if (trimmed) {
      // AG Grid still holds the second sort: take it back out, and say so.
      this.#lastState = '';
      this.#applyState(api, state);
      this.columnState.set(state);
      this.sortTrimmed.emit();
      return;
    }
    if (json === this.#lastState) return;
    this.#lastState = json;
    this.columnState.set(state);
  }
}
