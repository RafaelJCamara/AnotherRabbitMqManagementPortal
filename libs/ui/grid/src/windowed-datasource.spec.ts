import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeWindowSource, fakeRow, type FakeRow } from './testing';
import {
  WindowedDatasource,
  mapSortModel,
  type BlockRequest,
} from './windowed-datasource';
import type { GridSort } from './window-source';

interface Probe extends BlockRequest<FakeRow> {
  readonly calls: {
    rows?: readonly FakeRow[];
    lastRow?: number | undefined;
    failed: boolean;
  };
}

function block(startRow: number, sort: readonly GridSort[] = []): Probe {
  const calls: Probe['calls'] = { failed: false };
  return {
    startRow,
    endRow: startRow + 200,
    sort,
    calls,
    success(rows, lastRow) {
      calls.rows = rows;
      calls.lastRow = lastRow;
    },
    fail() {
      calls.failed = true;
    },
  };
}

describe('WindowedDatasource', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('AC-5 requests are block-aligned, bounded and carry the sort', async () => {
    const source = createFakeWindowSource({ latencyMs: 10 });
    const ds = new WindowedDatasource({ source, maxConcurrent: 2 });
    const probes = [0, 200, 400, 600].map((s) =>
      block(s, mapSortModel([{ colId: 'name', sort: 'desc' }])),
    );
    probes.forEach((p) => {
      ds.getRows(p);
    });
    expect(source.requests).toHaveLength(2); // at most two in flight, the others wait
    await vi.advanceTimersByTimeAsync(10);
    expect(source.requests).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(10);
    for (const r of source.requests) {
      expect(r.offset % 200).toBe(0);
      expect(r.limit).toBeLessThanOrEqual(200);
      expect(r.sort).toEqual([{ columnId: 'name', direction: 'desc' }]);
    }
    expect(probes[0]?.calls.rows).toHaveLength(200);
    expect(probes[0]?.calls.lastRow).toBe(100_000);
    expect(ds.total()).toBe(100_000);
    expect(ds.stats().blocksLoaded).toBe(4);
    // a request that is not aligned never reaches the source
    const misaligned = block(50);
    ds.getRows(misaligned);
    expect(misaligned.calls.failed).toBe(true);
    expect(source.requests).toHaveLength(4);
  });

  it('an unknown total keeps the end open until a short block shows it', async () => {
    const source = createFakeWindowSource({ rows: 250, unknownTotal: true });
    const ds = new WindowedDatasource({ source });
    const first = block(0);
    const second = block(200);
    ds.getRows(first);
    ds.getRows(second);
    await vi.advanceTimersByTimeAsync(0);
    expect(first.calls.lastRow).toBeUndefined();
    expect(second.calls.rows).toHaveLength(50);
    expect(second.calls.lastRow).toBe(250);
    expect(ds.total()).toBe(250);
  });

  it('AC-6 a stale answer never reaches the grid', async () => {
    const source = createFakeWindowSource({ latencyMs: 50, ignoreAbort: true });
    const ds = new WindowedDatasource({ source });
    const probe = block(0);
    ds.getRows(probe);
    ds.destroy();
    await vi.advanceTimersByTimeAsync(60);
    expect(probe.calls.rows).toBeUndefined();
    expect(probe.calls.failed).toBe(false);
    expect(ds.stats().staleAnswers).toBe(1);
    expect(ds.stats().blocksLoaded).toBe(0);
    // an aborting source is cancelled, not counted as a failure
    const aborting = createFakeWindowSource({ latencyMs: 50 });
    const ds2 = new WindowedDatasource({ source: aborting });
    const p2 = block(0);
    ds2.getRows(p2);
    ds2.destroy();
    await vi.advanceTimersByTimeAsync(60);
    expect(p2.calls).toEqual({ failed: false });
    expect(ds2.stats().blocksFailed).toBe(0);
  });

  it('AC-7 a failed or oversized block fails whole, is counted and can be retried', async () => {
    const source = createFakeWindowSource({ failAt: (o) => o === 200 });
    const onRefresh = vi.fn();
    const ds = new WindowedDatasource({ source, onRefresh });
    const ok = block(0);
    const rejected = block(200);
    ds.getRows(ok);
    ds.getRows(rejected);
    await vi.advanceTimersByTimeAsync(0);
    expect(ok.calls.rows).toHaveLength(200);
    expect(rejected.calls).toEqual({ failed: true });
    expect(ds.stats().blocksFailed).toBe(1);
    expect(String(ds.error())).toContain('fake failure at 200');

    const big = new WindowedDatasource({
      source: createFakeWindowSource({ oversizeBy: 1 }),
    });
    const oversized = block(0);
    big.getRows(oversized);
    await vi.advanceTimersByTimeAsync(0);
    expect(oversized.calls).toEqual({ failed: true }); // not truncated to 200
    expect(big.stats().blocksFailed).toBe(1);

    ds.retry();
    expect(ds.error()).toBeNull();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('AC-8 live changes touch visible rows only and refresh at most every 5 s', async () => {
    vi.setSystemTime(100_000);
    const source = createFakeWindowSource();
    const onApply = vi.fn();
    const onRefresh = vi.fn();
    const ds = new WindowedDatasource({ source, onApply, onRefresh });
    const visible = new Set(
      Array.from({ length: 41 }, (_, i) => `row-${String(40 + i)}`),
    );
    ds.setVisibleIds(visible);
    ds.setVisibleIds(visible); // debounced: one watch call
    await vi.advanceTimersByTimeAsync(100);
    expect(source.watched).toEqual([visible]);

    const upserts = Array.from({ length: 50 }, (_, i) => ({
      kind: 'upsert' as const,
      row: fakeRow(i * 2),
    }));
    source.emit(upserts); // rows 0..98 even; shown: 40..80 even = 21 of them
    source.emit([{ kind: 'remove', rowId: 'row-41' }]);
    expect(onApply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0]?.[0]).toHaveLength(22);
    expect(ds.stats().changesApplied).toBe(22);
    expect(ds.stats().changesDropped).toBe(29);
    await vi.advanceTimersByTimeAsync(0);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    source.emit([{ kind: 'remove', rowId: 'row-42' }]);
    await vi.advanceTimersByTimeAsync(100);
    expect(onRefresh).toHaveBeenCalledTimes(1); // inside the 5 s interval
    await vi.advanceTimersByTimeAsync(5000);
    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(ds.stats().refreshes).toBe(2);
  });
  it('AC-1 a refresh change reloads the cache at most every 5 s and tells the source', async () => {
    vi.setSystemTime(100_000);
    const source = createFakeWindowSource();
    const onRefresh = vi.fn();
    const ds = new WindowedDatasource({ source, onRefresh });
    ds.setVisibleIds(new Set(['row-40', 'row-41']));
    await vi.advanceTimersByTimeAsync(100);

    // Rows 40..80 are shown; a refresh does not name a row, so it is never "not shown".
    source.emit([{ kind: 'refresh' }]);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(source.refreshedCalls).toBe(1);
    expect(ds.stats().changesDropped).toBe(0);

    // A second one inside 5 s waits; two more in the window still reload once.
    source.emit([{ kind: 'refresh' }]);
    source.emit([{ kind: 'refresh' }]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(source.refreshedCalls).toBe(2);

    // The source hears of a retry too.
    ds.retry();
    expect(onRefresh).toHaveBeenCalledTimes(3);
    expect(source.refreshedCalls).toBe(3);
    expect(ds.stats().refreshes).toBe(3);
    expect(ds.stats().changesDropped).toBe(0);
    expect(ds.stats().changesApplied).toBe(0);
  });

  it('is loading while a block is in flight or waiting for a slot, and not after', async () => {
    const source = createFakeWindowSource({ latencyMs: 10 });
    const ds = new WindowedDatasource({ source, maxConcurrent: 1 });
    expect(ds.loading()).toBe(false);
    ds.getRows(block(0));
    ds.getRows(block(200)); // waits for the slot
    expect(ds.loading()).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(ds.loading()).toBe(true); // the second block is now in flight
    await vi.advanceTimersByTimeAsync(10);
    expect(ds.loading()).toBe(false);
    ds.getRows(block(400));
    expect(ds.loading()).toBe(true);
    ds.destroy();
    expect(ds.loading()).toBe(false);
  });
});
