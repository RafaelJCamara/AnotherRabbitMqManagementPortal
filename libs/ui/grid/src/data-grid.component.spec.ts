import { Component, signal, type Provider } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { ThemeService } from '@app/ui-design';
import { getGridApi } from 'ag-grid-community';
import { describe, expect, it, vi } from 'vitest';

import { GRID_CLIPBOARD, type GridClipboard } from './clipboard';
import type { GridColumnState } from './column-state';
import { DataGrid } from './data-grid.component';
import { GRID_STYLE_NONCE } from './grid-internals';
import {
  cellAt,
  cellTexts,
  COLUMNS,
  key,
  LABELS,
  rendered,
  ROWS,
  settled,
  source,
  type Row,
} from './grid-spec-support';
import { provideGridRenderAll } from './testing/render-all';
import type { EngineWindowSource } from './window-source';
function fakeClipboard(refuse = false): GridClipboard & { written: string[] } {
  const written: string[] = [];
  return {
    written,
    writeText: (text) => {
      if (refuse) return Promise.reject(new Error('refused'));
      written.push(text);
      return Promise.resolve();
    },
  };
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
    // No quote in it: a cell with a quote is quoted in the copy (AC-11), and AC-9 is about markup.
    const hostile = "<img src=x onerror='window.__pwned = 1'><b>bold</b>";
    const rows: Row[] = [{ id: 'x', name: hostile, size: 1 }];
    const clipboard = fakeClipboard();
    const { el, host, fixture } = await mount(
      (h) => {
        h.source.set(source(rows));
      },
      [{ provide: GRID_CLIPBOARD, useValue: clipboard }],
    );
    await rendered(el, 1);
    expect(cellTexts(el, 'name')).toEqual([hostile]);
    expect(el.querySelector('img, b, script')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();

    // The clipboard gets the same string, not a rendering of it.
    cellAt(el, 'name', 0).click();
    await settled(fixture, () => {
      expect([...host.selection()]).toEqual(['x']);
    });
    key(cellAt(el, 'name', 0), 'c', { ctrlKey: true });
    await settled(fixture, () => {
      expect(clipboard.written).toEqual([`${hostile}\t1`]);
    });
  });

  it('copies the selected rows in the order on screen, only the visible columns, and says what it did', async () => {
    const clipboard = fakeClipboard();
    const { el, host, fixture } = await mount(undefined, [
      { provide: GRID_CLIPBOARD, useValue: clipboard },
    ]);
    await rendered(el, 3);
    host.selection.set(new Set(['c', 'a']));
    host.columnState.set({
      version: 1,
      columns: [{ id: 'size' }, { id: 'name', hidden: true }],
      sort: [],
    });
    await fixture.whenStable();
    await vi.waitFor(() => {
      expect(
        [...el.querySelectorAll('.ag-header-cell-text')].map((h) =>
          h.textContent.trim(),
        ),
      ).toEqual(['Size']);
    });
    key(cellAt(el, 'size', 0), 'c', { ctrlKey: true });
    await settled(fixture, () => {
      expect(clipboard.written).toEqual(['3\n8']);
    });
    await settled(fixture, () => {
      expect(el.querySelector('.copy')?.textContent.trim()).toBe(
        '2 rows copied',
      );
    });
    // Nothing selected: nothing is copied.
    host.selection.set(new Set());
    await fixture.whenStable();
    key(cellAt(el, 'size', 0), 'c', { ctrlKey: true });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(clipboard.written).toHaveLength(1);
  });

  it('counts selected rows that are not loaded as not copied', async () => {
    const accepting = fakeClipboard();
    const { el, host, fixture } = await mount(undefined, [
      { provide: GRID_CLIPBOARD, useValue: accepting },
    ]);
    await rendered(el, 3);
    host.selection.set(new Set(['a', 'not-loaded-1', 'not-loaded-2']));
    await fixture.whenStable();
    key(cellAt(el, 'name', 0), 'c', { ctrlKey: true });
    await settled(fixture, () => {
      expect(el.querySelector('.copy')?.textContent.trim()).toBe(
        '1 rows copied, 2 not copied',
      );
    });
    expect(accepting.written).toEqual(['orders\t3']);
  });

  it('shows an error when the clipboard refuses the copy', async () => {
    const { el, host, fixture } = await mount(undefined, [
      { provide: GRID_CLIPBOARD, useValue: fakeClipboard(true) },
    ]);
    await rendered(el, 3);
    host.selection.set(new Set(['a']));
    await fixture.whenStable();
    key(cellAt(el, 'name', 0), 'c', { ctrlKey: true });
    await settled(fixture, () => {
      expect(el.querySelector('.copy')?.textContent.trim()).toBe(
        'The clipboard did not accept the copy',
      );
    });
  });

  it('shows the total, what is loaded and what is selected in its status bar', async () => {
    const { el, host, fixture } = await mount();
    await rendered(el, 3);
    await settled(fixture, () => {
      expect(el.querySelector('.total')?.textContent.trim()).toBe('3 rows');
      expect(el.querySelector('.loaded')?.textContent.trim()).toBe('3 loaded');
      expect(el.querySelector('.selected')?.textContent.trim()).toBe(
        '0 selected',
      );
    });
    cellAt(el, 'name', 0).click();
    await settled(fixture, () => {
      expect(el.querySelector('.selected')?.textContent.trim()).toBe(
        '1 selected',
      );
    });
    expect(host.selection().size).toBe(1);
  });

  it('says a block failed, and Try again loads it', async () => {
    let failing = true;
    const flaky = source();
    flaky.window = (request, signal) => {
      flaky.requests.push(request);
      flaky.signals.push(signal);
      return failing
        ? Promise.reject(new Error('broker unreachable'))
        : Promise.resolve({ rows: ROWS, total: ROWS.length });
    };
    const { el, fixture } = await mount((h) => {
      h.source.set(flaky);
    });
    await settled(fixture, () => {
      expect(el.querySelector('.error')?.textContent.trim()).toBe(
        'Some rows could not be loaded',
      );
    });
    // No row shows data (AG Grid keeps a placeholder row for the block that did not load).
    expect(cellTexts(el, 'name').filter((text) => text !== '')).toEqual([]);
    failing = false;
    el.querySelector<HTMLButtonElement>('button.retry')?.click();
    await rendered(el, 3);
    await settled(fixture, () => {
      expect(el.querySelector('.error')).toBeNull();
    });
    expect(cellTexts(el, 'name')).toEqual(['orders', 'billing', 'audit']);
  });

  it('hides a column from the chooser and publishes the state', async () => {
    const { el, host, fixture } = await mount();
    await rendered(el, 3);
    el.querySelector<HTMLButtonElement>('button.toggle')?.click();
    await fixture.whenStable();
    const sizeBox = [
      ...el.querySelectorAll<HTMLInputElement>('.panel .show input'),
    ].find((input) => input.closest('label')?.textContent.trim() === 'Size');
    sizeBox?.click();
    await settled(fixture, () => {
      expect(
        host.columnState()?.columns.find((c) => c.id === 'size')?.hidden,
      ).toBe(true);
    });
    await vi.waitFor(() => {
      expect(
        [...el.querySelectorAll('.ag-header-cell-text')].map((h) =>
          h.textContent.trim(),
        ),
      ).toEqual(['Name']);
    });
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
    const cell = (colId: string, index: number): HTMLElement =>
      cellAt(el, colId, index);
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
