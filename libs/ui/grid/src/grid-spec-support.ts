// Shared by the component specs (never part of the library build). A test DOM has no layout, so the
// specs provide `provideGridRenderAll()`; AG Grid dispatches its events asynchronously, so an
// assertion on their effect waits for it.
import type { ComponentFixture } from '@angular/core/testing';
import { expect, vi } from 'vitest';

import type { GridColumn } from './columns';
import type { GridLabels } from './grid-config';
import type {
  EngineWindowSource,
  GridRowChange,
  GridWindowRequest,
} from './window-source';

export interface Row {
  readonly id: string;
  readonly name: string;
  readonly size: number;
}

export const LABELS: GridLabels = {
  gridLabel: 'Queues',
  loading: 'Loading',
  noRows: 'Nothing here',
  menu: {
    label: 'Row actions',
    whyDisabled: 'Why disabled',
    degraded: 'Limited',
    source: 'Source',
    noReason: 'No reason given',
  },
  status: {
    total: '{count} rows',
    totalUnknown: 'Total not known yet',
    loaded: '{count} loaded',
    selected: '{count} selected',
    loading: 'Loading rows',
    error: 'Some rows could not be loaded',
    retry: 'Try again',
    copied: '{count} rows copied',
    copyTruncated: '{count} rows copied, {omitted} not copied',
    copyFailed: 'The clipboard did not accept the copy',
    selectionCapped: 'At most {count} rows can be selected',
    dropped: '{count} live changes were not applied',
  },
  columnChooser: {
    button: 'Columns',
    title: 'Choose columns',
    up: 'Up',
    down: 'Down',
    moveUp: 'Move {name} up',
    moveDown: 'Move {name} down',
    width: 'Width of {name}',
    reset: 'Reset columns',
    lastColumn: 'At least one column stays visible',
  },
};

export const COLUMNS: GridColumn<Row>[] = [
  { id: 'name', header: 'Name', value: (r) => r.name, sortable: true },
  { id: 'size', header: 'Size', value: (r) => r.size, align: 'end' },
];

export const ROWS: Row[] = [
  { id: 'a', name: 'orders', size: 3 },
  { id: 'b', name: 'billing', size: 5 },
  { id: 'c', name: 'audit', size: 8 },
];

export function source(rows: readonly Row[] = ROWS) {
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

/** A source with a live feed: it records what the grid reports as visible and lets a test push changes. */
export function liveSource(rows: readonly Row[] = ROWS) {
  const base = source(rows);
  const listeners = new Set<(changes: readonly GridRowChange<Row>[]) => void>();
  const watched: ReadonlySet<string>[] = [];
  const live: typeof base & {
    watched: ReadonlySet<string>[];
    emit(changes: readonly GridRowChange<Row>[]): void;
  } = {
    ...base,
    watched,
    watch: (ids) => void watched.push(ids),
    onChanges(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    emit(changes) {
      for (const listener of listeners) listener(changes);
    },
  };
  return live;
}
export const cellTexts = (el: HTMLElement, colId: string): string[] =>
  [...el.querySelectorAll(`.ag-row [col-id="${colId}"]`)].map((cell) =>
    cell.textContent.trim(),
  );

/** The cell of a column in the n-th rendered row. */
export function cellAt(
  el: HTMLElement,
  colId: string,
  index: number,
): HTMLElement {
  const row = el.querySelectorAll('.ag-row')[index];
  const found = row?.querySelector<HTMLElement>(`[col-id="${colId}"]`);
  if (!found) throw new Error(`No cell ${colId} in row ${String(index)}`);
  return found;
}

/**
 * How often a wait looks again. AG Grid answers within a few milliseconds once the engine promise is
 * resolved, so the 50 ms default of `vi.waitFor` would be most of what a wait costs. Every wait here is
 * bounded by its timeout and checks a condition; none sleeps for a fixed time.
 */
const POLL_MS = 5;

/** `vi.waitFor` with the poll interval of these specs: retries the assertion until it holds or the timeout ends. */
export async function eventually(
  assertion: () => void,
  timeout = 4000,
): Promise<void> {
  await vi.waitFor(assertion, { timeout, interval: POLL_MS });
}

/** AG Grid dispatches its events asynchronously, so an assertion on their effect waits for it. */
export async function settled(
  fixture: ComponentFixture<unknown>,
  assertion: () => void,
): Promise<void> {
  await vi.waitFor(
    async () => {
      await fixture.whenStable();
      assertion();
    },
    { timeout: 3000, interval: POLL_MS },
  );
}

/**
 * Waits until the rows and their data are in the DOM and the component has seen the loaded model (its
 * status bar counts the loaded rows from the same `modelUpdated` event that AG Grid dispatches after
 * it has rendered them), so a click or key sent next reaches a wired row.
 */
export async function rendered(el: HTMLElement, rows: number): Promise<void> {
  await eventually(() => {
    expect(el.querySelectorAll('.ag-row').length).toBeGreaterThanOrEqual(rows);
    expect(
      cellTexts(el, 'name').filter((t) => t !== '').length,
    ).toBeGreaterThanOrEqual(rows);
    expect(el.querySelector('.loaded')?.textContent.trim()).toMatch(/^[1-9]/);
  });
}

export function key(
  target: Element,
  key: string,
  init: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}
