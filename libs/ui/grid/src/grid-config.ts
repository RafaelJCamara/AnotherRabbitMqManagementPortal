// Everything about AG Grid that is configuration: the explicit list of Community modules (OQ-551),
// the options that never change, the column definitions and the theme bridge. This and the
// component are the only files that import `ag-grid-community` (I-11); nothing from it crosses the
// public API.
import {
  CellStyleModule,
  ColumnApiModule,
  EventApiModule,
  InfiniteRowModelModule,
  LocaleModule,
  RenderApiModule,
  RowApiModule,
  RowSelectionModule,
  ScrollApiModule,
  themeQuartz,
  type ColDef,
  type GridApi,
  type GridOptions,
  type LocaleText,
  type Module,
  type RowSelectionOptions,
  type Theme,
} from 'ag-grid-community';

import { cellText, type ResolvedColumn } from './columns';
import type { GridColumnChooserLabels } from './column-chooser';
import type { GridMenuLabels } from './context-menu';
import type { GridSelectionMode } from './selection';
import type { GridStatusLabels } from './status-bar';
import { GRID_BLOCK_SIZE, GRID_MAX_BLOCKS } from './window-source';

/**
 * The Community modules the adapter registers, by name, instead of `AllCommunityModule`: the
 * feature chunk stays small and AC-3 is a statement about names. Each one is here for a reason:
 *
 * - InfiniteRowModel: the engine-windowed row model.
 * - RowSelection: shows selection (`aria-selected`, the selected-row class); the set itself is ours.
 * - ColumnApi: apply and read the column state (order, width, visibility, sort).
 * - RowApi, ScrollApi, RenderApi: find a loaded row by id, scroll, refresh cells.
 * - EventApi: events from the grid.
 * - CellStyle: cell classes (alignment).
 * - Locale: every word the grid shows comes from `labels`.
 */
export const GRID_MODULES: readonly Module[] = [
  InfiniteRowModelModule,
  RowSelectionModule,
  ColumnApiModule,
  RowApiModule,
  ScrollApiModule,
  RenderApiModule,
  EventApiModule,
  CellStyleModule,
  LocaleModule,
];

/** The names of the registered modules; `ui-grid:bundle-check` compares them with the Community set. */
export const GRID_MODULE_NAMES: readonly string[] = GRID_MODULES.map(
  (m) => m.moduleName,
);

/** Requests in flight at once; the datasource queues the rest (AC-5). */
export const GRID_MAX_CONCURRENT_REQUESTS = 2;

/** The words of the grid itself; the status bar, the menu and the chooser have their own sets. */
export interface GridLabels {
  /** The accessible name of the grid. */
  readonly gridLabel: string;
  /** Shown in a row whose block is loading. */
  readonly loading: string;
  /** Shown when the query has no rows. */
  readonly noRows: string;
  /** The context menu and the reason of a closed gate. */
  readonly menu: GridMenuLabels;
  /** The status bar. */
  readonly status: GridStatusLabels;
  /** The column chooser. */
  readonly columnChooser: GridColumnChooserLabels;
}

/** Locale text the adapter forwards (OQ-555); a string it cannot intercept is a gap S-14 lists. */
export function buildLocaleText(labels: GridLabels): LocaleText {
  return {
    loadingOoo: labels.loading,
    noRowsToShow: labels.noRows,
  };
}

/** What the component passes at creation; everything else in `GridOptions` is fixed here. */
export interface GridOptionsInput<Row> {
  /** One sort column only (the engine sorts by one); a header click replaces the sort. */
  readonly suppressMultiSort?: boolean;
  readonly styleNonce: string | undefined;
  readonly columnDefs: readonly ColDef<Row>[];
  readonly getRowId: (row: Row) => string;
  readonly theme: Theme;
  readonly rowHeight: number;
  readonly labels: GridLabels;
  readonly selectionMode: GridSelectionMode;
  /** Tests only: render every row and column, because jsdom has no layout. */
  readonly renderAll: boolean;
}

export function selectionOptions(mode: GridSelectionMode): RowSelectionOptions {
  // Our click handler owns the selection set; AG Grid only shows it (no click selection, no boxes).
  // Mode none keeps the single-row options: the set stays empty, so nothing is ever shown selected.
  return {
    mode: mode === 'multiple' ? 'multiRow' : 'singleRow',
    enableClickSelection: false,
    checkboxes: false,
    headerCheckbox: false,
  };
}

export function buildGridOptions<Row>(
  input: GridOptionsInput<Row>,
): GridOptions<Row> {
  return {
    ...(input.styleNonce === undefined ? {} : { styleNonce: input.styleNonce }),
    ...(input.suppressMultiSort === true ? { suppressMultiSort: true } : {}),
    rowModelType: 'infinite',
    cacheBlockSize: GRID_BLOCK_SIZE,
    maxBlocksInCache: GRID_MAX_BLOCKS,
    maxConcurrentDatasourceRequests: GRID_MAX_CONCURRENT_REQUESTS,
    // The first block loads and the real count arrives with it; one row until then.
    infiniteInitialRowCount: 1,
    columnDefs: [...input.columnDefs],
    getRowId: (params) => input.getRowId(params.data),
    theme: input.theme,
    rowHeight: input.rowHeight,
    headerHeight: input.rowHeight,
    localeText: buildLocaleText(input.labels),
    rowSelection: selectionOptions(input.selectionMode),
    // Our own menu, never the browser's and never AG Grid's (AC-2).
    suppressContextMenu: true,
    preventDefaultOnContextMenu: true,
    // No Google Fonts, no fetch: the grid loads nothing (I-1, I-12, CSP).
    loadThemeGoogleFonts: false,
    animateRows: false,
    suppressRowHoverHighlight: false,
    ...(input.renderAll
      ? { suppressRowVirtualisation: true, suppressColumnVirtualisation: true }
      : {}),
  };
}

/**
 * Column definitions from validated columns. Value getters are functions that read the row; no
 * AG Grid string expression is ever produced (it would call `new Function`, ADR-021, AC-10).
 */
export function toColDefs<Row>(
  columns: readonly ResolvedColumn<Row>[],
): ColDef<Row>[] {
  return columns.map((c): ColDef<Row> => {
    const end = c.align === 'end';
    return {
      colId: c.id,
      headerName: c.header,
      width: c.width,
      minWidth: c.minWidth,
      sortable: c.sortable,
      hide: c.hidden,
      resizable: true,
      suppressHeaderMenuButton: true,
      valueGetter: (params) =>
        params.data === undefined ? undefined : c.value(params.data),
      valueFormatter: (params) =>
        params.data === undefined ? '' : cellText(c, params.data),
      ...(end
        ? {
            cellClass: 'ag-right-aligned-cell',
            headerClass: 'ag-right-aligned-header',
          }
        : {}),
    };
  });
}

// ---- Theme bridge -------------------------------------------------------------------------------

/** Reads a design token (`--ds-color-text`); `ThemeService.token` in production. */
export type TokenReader = (name: string) => string;

export interface GridThemeSnapshot {
  readonly theme: Theme;
  /** The row height of the density token; the grid chooses no number of its own (OQ-548). */
  readonly rowHeight: number;
}

const FALLBACK_ROW_HEIGHT = 32;

function px(value: string): number | undefined {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * The AG Grid theme for the design tokens in force. A token that is empty (before the stylesheet
 * has loaded, or in a test DOM) leaves the AG Grid default in place instead of a broken value.
 */
export function readGridTheme(
  read: TokenReader,
  scheme: 'light' | 'dark',
): GridThemeSnapshot {
  const color = (name: string): string | undefined => {
    const value = read(name);
    return value === '' ? undefined : value;
  };
  const rowHeight = px(read('--ds-row-height')) ?? FALLBACK_ROW_HEIGHT;
  const fontSize = px(read('--ds-font-size'));
  const fontFamily = color('--ds-font-family-ui');
  const params = {
    browserColorScheme: scheme,
    rowHeight,
    headerHeight: rowHeight,
    ...(fontSize === undefined ? {} : { fontSize }),
    ...(fontFamily === undefined ? {} : { fontFamily }),
    ...pick('backgroundColor', color('--ds-color-surface')),
    ...pick('foregroundColor', color('--ds-color-text')),
    ...pick('borderColor', color('--ds-color-border')),
    ...pick('accentColor', color('--ds-color-accent')),
    ...pick('headerBackgroundColor', color('--ds-color-surface-raised')),
    ...pick('headerTextColor', color('--ds-color-text')),
    selectedRowBackgroundColor: {
      ref: 'accentColor',
      mix: 0.18,
      onto: 'backgroundColor',
    },
    rowHoverColor: {
      ref: 'foregroundColor',
      mix: 0.06,
      onto: 'backgroundColor',
    },
  } as const;
  return { theme: themeQuartz.withParams(params), rowHeight };
}

function pick<K extends string>(
  key: K,
  value: string | undefined,
): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

/** Pushes the theme and the row height in one turn (AC-17). */
export function pushGridTheme(
  api: Pick<GridApi, 'setGridOption'>,
  snapshot: GridThemeSnapshot,
): void {
  api.setGridOption('theme', snapshot.theme);
  api.setGridOption('rowHeight', snapshot.rowHeight);
  api.setGridOption('headerHeight', snapshot.rowHeight);
}
