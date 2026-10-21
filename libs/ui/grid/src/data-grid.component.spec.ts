import { Component, signal, type Provider } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { ThemeService } from '@app/ui-design';
import { getGridApi } from 'ag-grid-community';
import { describe, expect, it, vi } from 'vitest';

import type { GridColumnState } from './column-state';
import type { GridColumn } from './columns';
import { DataGrid } from './data-grid.component';
import type { GridLabels } from './grid-config';
import { GRID_STYLE_NONCE } from './grid-internals';
import { provideGridRenderAll } from './testing/render-all';
import type { EngineWindowSource, GridWindowRequest } from './window-source';

interface Row {
  readonly id: string;
  readonly name: string;
  readonly size: number;
}

const LABELS: GridLabels = {
  gridLabel: 'Queues',
  loading: 'Loading',
  noRows: 'Nothing here',
};

const COLUMNS: GridColumn<Row>[] = [
  { id: 'name', header: 'Name', value: (r) => r.name, sortable: true },
  { id: 'size', header: 'Size', value: (r) => r.size, align: 'end' },
];

const ROWS: Row[] = [
  { id: 'a', name: 'orders', size: 3 },
  { id: 'b', name: 'billing', size: 5 },
  { id: 'c', name: 'audit', size: 8 },
];

function source(rows: readonly Row[] = ROWS) {
  const requests: GridWindowRequest[] = [];
  const signals: AbortSignal[] = [];
  const src: EngineWindowSource<Row> & {
    requests: GridWindowRequest[];
    signals: AbortSignal[];
  } = {
    requests,
    signals,
    rowId: (row) => row.id,
    window(request, signal) {
      requests.push(request);
      signals.push(signal);
      return Promise.resolve({
        rows: rows.slice(request.offset, request.offset + request.limit),
        total: rows.length,
      });
    },
  };
  return src;
}

@Component({
  imports: [DataGrid],
  template: `
    <div style="height: 400px">
      <app-data-grid
        [columns]="columns()"
        [source]="source()"
        [labels]="labels"
        [selectionMode]="mode()"
        [(selection)]="selection"
        [(columnState)]="columnState"
      />
    </div>
  `,
})
class Host {
  readonly columns = signal(COLUMNS);
  readonly source = signal<EngineWindowSource<Row>>(source());
  readonly labels = LABELS;
  readonly mode = signal<'none' | 'single' | 'multiple'>('multiple');
  readonly selection = signal<ReadonlySet<string>>(new Set());
  readonly columnState = signal<GridColumnState | null>(null);
}

async function mount(
  configure?: (host: Host) => void,
  providers: Provider[] = [],
) {
  TestBed.configureTestingModule({
    providers: [provideGridRenderAll(), ...providers],
  });
  const fixture: ComponentFixture<Host> = TestBed.createComponent(Host);
  configure?.(fixture.componentInstance);
  const el = fixture.nativeElement as HTMLElement;
  document.body.append(el);
  await fixture.whenStable();
  return { fixture, host: fixture.componentInstance, el };
}

const cellTexts = (el: HTMLElement, colId: string): string[] =>
  [...el.querySelectorAll(`.ag-row [col-id="${colId}"]`)].map((cell) =>
    cell.textContent.trim(),
  );

/** AG Grid dispatches its events asynchronously, so an assertion on their effect waits for it. */
async function settled(
  fixture: ComponentFixture<unknown>,
  assertion: () => void,
): Promise<void> {
  await vi.waitFor(
    async () => {
      await fixture.whenStable();
      assertion();
    },
    { timeout: 3000 },
  );
}

async function rendered(el: HTMLElement, rows: number): Promise<void> {
  await vi.waitFor(
    () => {
      expect(el.querySelectorAll('.ag-row').length).toBeGreaterThanOrEqual(
        rows,
      );
      expect(cellTexts(el, 'name').filter((t) => t !== '')).not.toHaveLength(0);
    },
    { timeout: 4000 },
  );
  // AG Grid wires a row's mouse handling in animation frames after it renders the row.
  await new Promise((resolve) => setTimeout(resolve, 150));
}

describe('<app-data-grid>', () => {
  it('shows the rows the source answers, with the columns in their order', async () => {
    const { el } = await mount();
    await rendered(el, 3);
    expect(cellTexts(el, 'name')).toEqual(['orders', 'billing', 'audit']);
    expect(cellTexts(el, 'size')).toEqual(['3', '5', '8']);
    const headers = [...el.querySelectorAll('.ag-header-cell-text')].map((h) =>
      h.textContent.trim(),
    );
    expect(headers).toEqual(['Name', 'Size']);
    expect(el.querySelector('[role="treegrid"], [role="grid"]')).not.toBeNull();
  });

  it('AC-9 cell values are rendered as text only', async () => {
    const hostile = '<img src=x onerror="window.__pwned = 1"><b>bold</b>';
    const rows: Row[] = [{ id: 'x', name: hostile, size: 1 }];
    const { el } = await mount((host) => {
      host.source.set(source(rows));
    });
    await rendered(el, 1);
    expect(cellTexts(el, 'name')).toEqual([hostile]);
    expect(el.querySelector('img, b, script')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('hands the style nonce to AG Grid, so its stylesheets run under the strict policy (S-04)', async () => {
    const { el } = await mount(undefined, [
      { provide: GRID_STYLE_NONCE, useValue: 'abc123' },
    ]);
    await rendered(el, 1);
    const api = getGridApi(el.querySelector('.ag-root-wrapper'));
    expect(api?.getGridOption('styleNonce')).toBe('abc123');
  });

  it('selects by row id with a click, toggles with Ctrl, and shows it on the row', async () => {
    const { el, host, fixture } = await mount();
    await rendered(el, 3);
    const cell = (colId: string, index: number): HTMLElement => {
      const row = el.querySelectorAll('.ag-row')[index];
      const found = row?.querySelector<HTMLElement>(`[col-id="${colId}"]`);
      if (!found) throw new Error(`No cell ${colId} in row ${String(index)}`);
      return found;
    };
    cell('name', 1).click();
    await settled(fixture, () => {
      expect([...host.selection()]).toEqual(['b']);
    });
    cell('name', 2).dispatchEvent(
      new MouseEvent('click', { bubbles: true, ctrlKey: true }),
    );
    await settled(fixture, () => {
      expect([...host.selection()].sort()).toEqual(['b', 'c']);
    });
    await vi.waitFor(() => {
      const selected = [...el.querySelectorAll('.ag-row')]
        .filter((r) => r.getAttribute('aria-selected') === 'true')
        .map((r) => r.querySelector('[col-id="name"]')?.textContent.trim());
      expect(selected.sort()).toEqual(['audit', 'billing']);
    });
    cell('name', 1).dispatchEvent(
      new MouseEvent('click', { bubbles: true, ctrlKey: true }),
    );
    await settled(fixture, () => {
      expect([...host.selection()]).toEqual(['c']);
    });
  });

  it('does not select anything when the mode is none', async () => {
    const { el, host, fixture } = await mount((h) => {
      h.mode.set('none');
    });
    await rendered(el, 3);
    const clicks: string[] = [];
    getGridApi(el.querySelector('.ag-root-wrapper'))?.addEventListener(
      'cellClicked',
      (event) => {
        clicks.push(String(event.node.id));
      },
    );
    el.querySelector<HTMLElement>('.ag-row [col-id="name"]')?.click();
    // The click reached the grid; the selection set did not change.
    await settled(fixture, () => {
      expect(clicks).toHaveLength(1);
    });
    expect(host.selection().size).toBe(0);
  });

  it('a new source is a new query: the old request is aborted and the grid shows the new rows', async () => {
    let release: (() => void) | undefined;
    const slow = source();
    slow.window = (request, signal) => {
      slow.requests.push(request);
      slow.signals.push(signal);
      return new Promise((resolve) => {
        release = () => {
          resolve({ rows: [{ id: 'old', name: 'stale', size: 0 }], total: 1 });
        };
      });
    };
    const { el, host, fixture } = await mount((h) => {
      h.source.set(slow);
    });
    await vi.waitFor(() => {
      expect(slow.requests.length).toBe(1);
    });
    const fresh = source([{ id: 'n', name: 'fresh', size: 9 }]);
    host.source.set(fresh);
    await fixture.whenStable();
    expect(slow.signals[0]?.aborted).toBe(true);
    release?.(); // a late answer
    await rendered(el, 1);
    expect(cellTexts(el, 'name')).toEqual(['fresh']);
    expect(el.textContent).not.toContain('stale');
  });

  it('applies a stored column state: hidden column, width, order, and reads user changes back', async () => {
    const { el, host, fixture } = await mount();
    await rendered(el, 3);
    host.columnState.set({
      version: 1,
      columns: [
        { id: 'size', width: 90 },
        { id: 'name', hidden: true },
      ],
      sort: [],
    });
    await fixture.whenStable();
    await vi.waitFor(() => {
      const headers = [...el.querySelectorAll('.ag-header-cell-text')].map(
        (h) => h.textContent.trim(),
      );
      expect(headers).toEqual(['Size']);
    });
    // The user shows the column again through the grid API; the new state is published.
    const api = getGridApi(el.querySelector('.ag-root-wrapper'));
    api?.setColumnsVisible(['name'], true);
    await vi.waitFor(() => {
      const hidden = host
        .columnState()
        ?.columns.find((c) => c.id === 'name')?.hidden;
      expect(hidden).toBe(false);
    });
    expect(host.columnState()?.columns.map((c) => c.id)).toEqual([
      'size',
      'name',
    ]);
  });

  it('follows the density token for the row height when the theme revision changes', async () => {
    const { el, fixture } = await mount();
    await rendered(el, 1);
    const api = getGridApi(el.querySelector('.ag-root-wrapper'));
    const theme = TestBed.inject(ThemeService);
    const read = vi
      .spyOn(theme, 'token')
      .mockImplementation((name) => (name === '--ds-row-height' ? '24px' : ''));
    theme.setDensity('compact');
    await fixture.whenStable();
    expect(api?.getGridOption('rowHeight')).toBe(24);
    read.mockImplementation((name) =>
      name === '--ds-row-height' ? '32px' : '',
    );
    theme.setDensity('comfortable');
    await fixture.whenStable();
    expect(api?.getGridOption('rowHeight')).toBe(32);
  });

  it('refuses a column that is a string expression and keeps the grid empty', async () => {
    TestBed.configureTestingModule({ providers: [provideGridRenderAll()] });
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.columns.set([
      { id: 'bad', header: 'Bad', value: 'data.size * 2' as never },
    ]);
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((e: unknown) => {
      errors.push(e);
    });
    await fixture.whenStable().catch((e: unknown) => errors.push(e));
    spy.mockRestore();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('.ag-row').length).toBe(0);
    expect(String(errors.map(String))).toContain('string expressions');
  });
});
