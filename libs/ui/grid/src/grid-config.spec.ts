import * as agGrid from 'ag-grid-community';
import { describe, expect, it, vi } from 'vitest';

import { resolveColumns, type GridColumn } from './columns';
import {
  buildGridOptions,
  GRID_MAX_CONCURRENT_REQUESTS,
  GRID_MODULE_NAMES,
  GRID_MODULES,
  pushGridTheme,
  readGridTheme,
  selectionOptions,
  toColDefs,
  type GridLabels,
  type TokenReader,
} from './grid-config';
import { GRID_BLOCK_SIZE, GRID_MAX_BLOCKS } from './window-source';

const LABELS: GridLabels = {
  gridLabel: 'Queues',
  loading: 'Loading',
  noRows: 'Nothing here',
};

const TOKENS: Record<string, Record<string, string>> = {
  comfortable: {
    '--ds-row-height': '32px',
    '--ds-font-size': '14px',
    '--ds-font-family-ui': 'system-ui, sans-serif',
    '--ds-color-surface': '#ffffff',
    '--ds-color-text': '#14171a',
    '--ds-color-border': '#c3c8d0',
    '--ds-color-accent': '#0a4cad',
    '--ds-color-surface-raised': '#f4f5f7',
  },
  compact: {
    '--ds-row-height': '24px',
    '--ds-font-size': '12px',
    '--ds-font-family-ui': 'system-ui, sans-serif',
    '--ds-color-surface': '#000000',
    '--ds-color-text': '#ffffff',
    '--ds-color-border': '#b3b3b3',
    '--ds-color-accent': '#a8cbff',
    '--ds-color-surface-raised': '#0a0a0a',
  },
};
const reader =
  (set: string): TokenReader =>
  (name) =>
    TOKENS[set]?.[name] ?? '';

interface Row {
  readonly name: string;
  readonly size: number | null;
}

describe('grid config', () => {
  it('AC-17 a theme or density change is pushed into the grid', () => {
    const setGridOption = vi.fn();
    const api = { setGridOption } as unknown as agGrid.GridApi;

    const comfortable = readGridTheme(reader('comfortable'), 'light');
    pushGridTheme(api, comfortable);
    const compact = readGridTheme(reader('compact'), 'dark');
    pushGridTheme(api, compact);

    // The row height is the density token, not a number of our own (OQ-548).
    expect(comfortable.rowHeight).toBe(32);
    expect(compact.rowHeight).toBe(24);
    // Theme and row height go in the same call, in this order, and the theme object is a new one.
    expect(setGridOption.mock.calls).toEqual([
      ['theme', comfortable.theme],
      ['rowHeight', 32],
      ['headerHeight', 32],
      ['theme', compact.theme],
      ['rowHeight', 24],
      ['headerHeight', 24],
    ]);
    expect(compact.theme).not.toBe(comfortable.theme);
    // A token that is not there yet (the stylesheet has not loaded) falls back instead of breaking.
    expect(readGridTheme(() => '', 'light').rowHeight).toBe(32);
  });

  it('registers an explicit list of Community modules and no Enterprise one (OQ-551)', () => {
    expect(GRID_MODULE_NAMES).toEqual([
      'InfiniteRowModel',
      'RowSelection',
      'ColumnApi',
      'RowApi',
      'ScrollApi',
      'RenderApi',
      'EventApi',
      'CellStyle',
      'Locale',
    ]);
    expect(GRID_MODULES.some((m) => m.enterprise === true)).toBe(false);
    // Every registered module is one `ag-grid-community` itself exports.
    const exported = new Set(
      Object.values(agGrid)
        .filter(
          (v): v is agGrid.Module => typeof v === 'object' && 'moduleName' in v,
        )
        .map((m) => m.moduleName),
    );
    expect(GRID_MODULE_NAMES.every((n) => exported.has(n as never))).toBe(true);
    // Not the everything module.
    expect(GRID_MODULES).not.toContain(agGrid.AllCommunityModule);
  });

  it('fixes the infinite model: block 200, 25 blocks, few requests, no AG Grid menu, no fonts', () => {
    const options = buildGridOptions<Row>({
      styleNonce: 'n0nce',
      columnDefs: [],
      getRowId: (row) => row.name,
      theme: readGridTheme(reader('comfortable'), 'light').theme,
      rowHeight: 32,
      labels: LABELS,
      selectionMode: 'multiple',
      renderAll: false,
    });
    expect(options.rowModelType).toBe('infinite');
    expect(options.cacheBlockSize).toBe(GRID_BLOCK_SIZE);
    expect(options.maxBlocksInCache).toBe(GRID_MAX_BLOCKS);
    expect(options.maxConcurrentDatasourceRequests).toBe(
      GRID_MAX_CONCURRENT_REQUESTS,
    );
    expect(GRID_MAX_CONCURRENT_REQUESTS).toBeLessThanOrEqual(2);
    expect(options.suppressContextMenu).toBe(true);
    expect(options.preventDefaultOnContextMenu).toBe(true);
    expect(options.loadThemeGoogleFonts).toBe(false);
    expect(options.styleNonce).toBe('n0nce');
    expect(options.suppressRowVirtualisation).toBeUndefined();
    expect(options.localeText).toMatchObject({
      loadingOoo: 'Loading',
      noRowsToShow: 'Nothing here',
    });
    expect(options.rowHeight).toBe(32);
    // No datasource and no data are baked in; the component binds the source.
    expect(options.datasource).toBeUndefined();
    expect(options.rowData).toBeUndefined();
  });

  it('leaves the nonce out when there is none, and renders everything only for a test DOM', () => {
    const options = buildGridOptions<Row>({
      styleNonce: undefined,
      columnDefs: [],
      getRowId: (row) => row.name,
      theme: readGridTheme(reader('comfortable'), 'light').theme,
      rowHeight: 32,
      labels: LABELS,
      selectionMode: 'none',
      renderAll: true,
    });
    expect('styleNonce' in options).toBe(false);
    expect(options.suppressRowVirtualisation).toBe(true);
    expect(options.suppressColumnVirtualisation).toBe(true);
  });

  it('shows selection but never lets AG Grid decide it', () => {
    for (const mode of ['none', 'single', 'multiple'] as const) {
      expect(selectionOptions(mode)).toMatchObject({
        enableClickSelection: false,
        checkboxes: false,
        headerCheckbox: false,
      });
    }
    expect(selectionOptions('multiple')).toMatchObject({ mode: 'multiRow' });
    expect(selectionOptions('single')).toMatchObject({ mode: 'singleRow' });
  });

  it('AC-10 maps columns to function getters only and shows rows that are not loaded as empty', () => {
    const columns: GridColumn<Row>[] = [
      { id: 'name', header: 'Name', value: (r) => r.name, sortable: true },
      {
        id: 'size',
        header: 'Size',
        value: (r) => r.size,
        format: (v) => (v === null ? 'n/a' : `${String(v)} msg`),
        align: 'end',
        hidden: true,
      },
    ];
    const defs = toColDefs(resolveColumns(columns));
    for (const def of defs) {
      expect(typeof def.valueGetter).toBe('function');
      expect(typeof def.valueFormatter).toBe('function');
      expect(def.suppressHeaderMenuButton).toBe(true);
    }
    const [name, size] = defs;
    const params = (data: Row | undefined): never => ({ data }) as never;
    const getter = (def: agGrid.ColDef<Row> | undefined, row?: Row) =>
      (def?.valueGetter as (p: never) => unknown)(params(row));
    const format = (def: agGrid.ColDef<Row> | undefined, row?: Row) =>
      (def?.valueFormatter as (p: never) => unknown)(params(row));
    expect(getter(name, { name: 'orders', size: 3 })).toBe('orders');
    expect(getter(name)).toBeUndefined();
    expect(format(size, { name: 'orders', size: null })).toBe('n/a');
    expect(format(size, { name: 'orders', size: 3 })).toBe('3 msg');
    expect(format(size)).toBe('');
    expect(name).toMatchObject({ colId: 'name', sortable: true, hide: false });
    expect(size).toMatchObject({
      hide: true,
      cellClass: 'ag-right-aligned-cell',
    });
    // No string expression anywhere in the definitions.
    expect(JSON.stringify(defs)).not.toContain('data.');
  });
});
