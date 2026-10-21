// Shared by the component specs (never part of the library build). A test DOM has no layout, so the
// specs provide `provideGridRenderAll()`; AG Grid dispatches its events asynchronously, so an
// assertion on their effect waits for it.
import type { ComponentFixture } from '@angular/core/testing';
import { expect, vi } from 'vitest';

import type { GridColumn } from './columns';
import type { GridLabels } from './grid-config';
import type { EngineWindowSource, GridWindowRequest } from './window-source';

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
    { timeout: 3000 },
  );
}

/** Waits until the rows are in the DOM, and a little longer for AG Grid to wire the row's mouse handling. */
export async function rendered(el: HTMLElement, rows: number): Promise<void> {
  await vi.waitFor(
    () => {
      expect(el.querySelectorAll('.ag-row').length).toBeGreaterThanOrEqual(
        rows,
      );
      expect(cellTexts(el, 'name').filter((t) => t !== '')).not.toHaveLength(0);
    },
    { timeout: 4000 },
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
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
