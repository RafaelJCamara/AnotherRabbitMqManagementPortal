import { describe, expect, it } from 'vitest';

import { FILTER_CAPS } from './inventory-model';
import type { ExplorerKind, RowChange, WindowRequest } from './ports';
import { createFakeExplorerData } from './testing';
import {
  createInventoryWindowSource,
  type InventoryQuery,
} from './window-source';

const NONE: readonly never[] = [];
const request = (
  offset: number,
  sort: WindowRequest['sort'] = NONE,
  limit = 200,
): WindowRequest => ({ offset, limit, sort });
const signal = (): AbortSignal => new AbortController().signal;

function query<K extends ExplorerKind>(
  kind: K,
  filter: InventoryQuery['filter'] = {},
): InventoryQuery<K> {
  return { cid: 'c1', kind, filter };
}

describe('createInventoryWindowSource: windows (R1)', () => {
  it('AC-3 windows are 200-row blocks mapped to inventory.query and nothing larger is sent', async () => {
    const data = createFakeExplorerData({ rows: { queues: 20_000 } });
    const caps = {
      text: 'x'.repeat(FILTER_CAPS.text),
      vhosts: Array.from(
        { length: FILTER_CAPS.vhosts },
        (_, i) => `vhost-${String(i)}`,
      ),
      types: Array.from(
        { length: FILTER_CAPS.types },
        (_, i) => `type-${String(i)}`,
      ),
      states: Array.from(
        { length: FILTER_CAPS.states },
        (_, i) => `state-${String(i)}`,
      ),
      hasConsumers: true,
      minMessages: 1,
    };
    const sources = [
      createInventoryWindowSource(data, query('queues')),
      createInventoryWindowSource(data, query('queues', caps)),
    ];
    const sorts: WindowRequest['sort'][] = [
      NONE,
      [
        { columnId: 'messages', direction: 'desc' },
        { columnId: 'name', direction: 'asc' }, // the grid may carry two; the engine takes one
      ],
    ];
    for (const source of sources) {
      for (const sort of sorts) {
        for (const offset of [0, 200, 4_000, 19_800]) {
          const answer = await source.window(request(offset, sort), signal());
          expect(answer.rows.length).toBeLessThanOrEqual(200);
          expect(
            answer.rows.every((row) => source.rowId(row) === row.key),
          ).toBe(true);
        }
      }
    }
    expect(data.queries).toHaveLength(16);
    for (const input of data.queries) {
      expect(input.window.limit).toBeLessThanOrEqual(200);
      expect(input.window.limit).toBeLessThan(500);
      expect(input.window.offset % 200).toBe(0);
      expect(input.cid).toBe('c1');
      expect(input.kind).toBe('queues');
      if (input.sort)
        expect(input.sort).toEqual({ column: 'messages', dir: 'desc' });
    }
    // The filter at the contract's caps goes through as it is.
    expect(data.queries.at(-1)?.filter).toEqual(caps);
    expect(data.queries[0]?.filter).toBeUndefined();

    // The answer is `{rows, total: matched}`: the filtered count, not the index total.
    const narrowed = createInventoryWindowSource(
      data,
      query('queues', { text: 'queue-0001' }),
    );
    const answer = await narrowed.window(request(0), signal());
    expect(answer.total).toBe(10);
    expect(answer.rows).toHaveLength(10);
    expect(narrowed.state().matched).toBe(10);
    expect(narrowed.state().freshness?.loaded).toBe(20_000);

    // A request that is not a block is refused before anything is sent.
    const before = data.queries.length;
    for (const bad of [
      request(50),
      request(-200),
      request(0, NONE, 201),
      request(0, NONE, 500),
      request(0, NONE, 0),
      request(200.5),
    ]) {
      await expect(narrowed.window(bad, signal())).rejects.toBeInstanceOf(
        RangeError,
      );
    }
    expect(data.queries).toHaveLength(before);
  });

  it('AC-3 sends only the facets that apply to the kind, and a bindings source needs exactly one vhost', async () => {
    const data = createFakeExplorerData();
    const exchanges = createInventoryWindowSource(
      data,
      query('exchanges', {
        text: 'ex',
        vhosts: ['/'],
        types: ['topic'],
        states: ['running'],
        hasConsumers: true,
        minMessages: 5,
      }),
    );
    await exchanges.window(request(0), signal());
    expect(data.queries[0]?.filter).toEqual({
      text: 'ex',
      vhosts: ['/'],
      types: ['topic'],
    });
    expect(() => createInventoryWindowSource(data, query('bindings'))).toThrow(
      RangeError,
    );
    expect(() =>
      createInventoryWindowSource(
        data,
        query('bindings', { vhosts: ['/', 'orders'] }),
      ),
    ).toThrow(RangeError);
    const bindings = createInventoryWindowSource(
      data,
      query('bindings', { vhosts: ['orders'], types: ['x'] }),
    );
    const answer = await bindings.window(request(0), signal());
    expect(data.queries.at(-1)?.filter).toEqual({ vhosts: ['orders'] });
    expect(answer.rows.length).toBeGreaterThan(0);
  });

  it('a failed window rejects the block whole and is counted; an aborted one is not a failure', async () => {
    const data = createFakeExplorerData();
    const source = createInventoryWindowSource(data, query('queues'));
    data.failNext(new Error('broker unreachable'));
    await expect(source.window(request(0), signal())).rejects.toThrow(
      'broker unreachable',
    );
    expect(source.state().counters.windowFailures).toBe(1);

    const hold = data.hold();
    const controller = new AbortController();
    const pending = source.window(request(0), controller.signal);
    controller.abort();
    hold.release();
    await expect(pending).rejects.toBeDefined();
    expect(source.state().counters.windowFailures).toBe(1);
  });
});

describe('createInventoryWindowSource: the version pin (R2)', () => {
  it('AC-4 a scroll is pinned to one version, and the pin ends on a new sort or a reload', async () => {
    const data = createFakeExplorerData({ version: 7 });
    const source = createInventoryWindowSource(data, query('queues'));
    const changes: RowChange<unknown>[] = [];
    source.onChanges((c) => changes.push(...c));
    const byName = [{ columnId: 'name', direction: 'asc' as const }];
    const byMessages = [{ columnId: 'messages', direction: 'desc' as const }];

    // The first block fixes the pin; the second block of the same scroll sends it.
    await source.window(request(0, byName), signal());
    expect(data.queries[0]?.window.version).toBeUndefined();
    expect(source.state().pin).toBe(7);
    data.bump(); // 8: version 7 is still readable
    await source.window(request(200, byName), signal());
    expect(data.queries[1]?.window.version).toBe(7);
    expect(source.state().freshness?.versionChanged).toBe(false);
    expect(source.state().versionChanged).toBe(false);
    expect(changes).toEqual([]);

    // The index moves on to 11: version 7 is gone, the answer comes from 11 and says so.
    data.bump();
    data.bump();
    data.bump();
    await source.window(request(400, byName), signal());
    expect(data.queries[2]?.window.version).toBe(7);
    expect(source.state().versionChanged).toBe(true);
    expect(source.state().counters.versionChanges).toBe(1);
    expect(source.state().pin).toBeNull();
    expect(changes).toEqual([{ kind: 'refresh' }]); // one reload is asked for
    await source.window(request(600, byName), signal());
    expect(changes).toHaveLength(1); // not again until the grid reloaded

    // The grid reloads: the pin was dropped, the next block starts a new scroll at 11.
    source.refreshed();
    await source.window(request(0, byName), signal());
    expect(data.queries.at(-1)?.window.version).toBeUndefined();
    expect(source.state().pin).toBe(11);

    // A different sort sends no version and pins its own answer.
    await source.window(request(0, byMessages), signal());
    expect(data.queries.at(-1)?.window.version).toBeUndefined();
    expect(data.queries.at(-1)?.sort).toEqual({
      column: 'messages',
      dir: 'desc',
    });
    expect(source.state().pin).toBe(11);
    data.bump(); // 12
    await source.window(request(200, byMessages), signal());
    expect(data.queries.at(-1)?.window.version).toBe(11);

    // refreshed() sends none either.
    source.refreshed();
    expect(source.state().pin).toBeNull();
    await source.window(request(200, byMessages), signal());
    expect(data.queries.at(-1)?.window.version).toBeUndefined();
    expect(source.state().pin).toBe(12);
  });

  it('AC-4 an answer that belongs to an older epoch never sets the pin and never asks for a reload', async () => {
    const data = createFakeExplorerData({ version: 7 });
    const source = createInventoryWindowSource(data, query('queues'));
    const changes: RowChange<unknown>[] = [];
    source.onChanges((c) => changes.push(...c));
    const hold = data.hold();
    const older = source.window(
      request(0, [{ columnId: 'name', direction: 'asc' }]),
      signal(),
    );
    // The user sorts again before the first answer arrives: a new epoch.
    const newer = source.window(
      request(0, [{ columnId: 'messages', direction: 'desc' }]),
      signal(),
    );
    hold.release(1);
    await older;
    expect(source.state().pin).toBeNull(); // the old sort's answer set nothing
    hold.release();
    await newer;
    expect(source.state().pin).toBe(7);

    // A gone version in an answer of an older epoch asks for nothing either.
    const stale = createFakeExplorerData({ version: 7 });
    const staleSource = createInventoryWindowSource(stale, query('queues'));
    const staleChanges: RowChange<unknown>[] = [];
    staleSource.onChanges((c) => staleChanges.push(...c));
    await staleSource.window(request(0), signal());
    stale.bump();
    stale.bump();
    stale.bump(); // version 7 is gone
    const slow = stale.hold();
    const old = staleSource.window(request(200), signal()); // pinned to 7, in flight
    staleSource.refreshed(); // the grid reloaded meanwhile
    slow.release();
    await old;
    expect(staleChanges).toEqual([]);
    expect(staleSource.state().pin).toBeNull();
  });
});
