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

// ---- R3: following the rows on screen -------------------------------------------------------------

type Changes = RowChange<unknown>[];

function following(rows = 3) {
  const data = createFakeExplorerData();
  const source = createInventoryWindowSource(data, query('queues'));
  const changes: Changes = [];
  source.onChanges((c) => changes.push(...c));
  const queues = data.rows().queues.slice(0, rows);
  source.watch(new Set(queues.map((r) => r.key)));
  const [follower] = data.followers;
  if (follower === undefined) throw new Error('no follower');
  const itemOf = (row: (typeof queues)[number], version = data.version) => {
    const { key, ...rest } = row;
    return { key, version, row: rest };
  };
  return { data, source, changes, queues, follower, itemOf };
}

const MARKER = '~version';

describe('createInventoryWindowSource: following the rows (R3)', () => {
  it('AC-5 topic items regain their key and the version marker is not a row', () => {
    const { data, source, changes, queues, follower, itemOf } = following();
    const [a, b, c] = queues;
    if (!a || !b || !c) throw new Error('rows');
    data.emit(data.snapshotFor(follower.params));
    // Each row comes out as an upsert with its key put back and the rest unchanged.
    expect(changes).toHaveLength(3);
    for (const [i, row] of [a, b, c].entries()) {
      expect(changes[i]).toEqual({ kind: 'upsert', row });
      expect(source.rowId(row)).toBe(row.key);
    }
    expect(JSON.stringify(changes)).not.toContain(MARKER);
    expect(source.state().counters.markers).toBe(1);

    // A delta: a changed row, a row nobody asked for, a removal and a marker.
    const stranger = data.rows().queues[300];
    if (!stranger) throw new Error('rows');
    changes.length = 0;
    data.emit(
      {
        kind: 'delta',
        upserts: [
          itemOf({ ...a, messages: 999 }),
          itemOf(stranger),
          { key: MARKER, version: data.version },
        ],
        removes: [b.key],
      },
      follower,
    );
    expect(changes).toEqual([
      { kind: 'remove', rowId: b.key },
      { kind: 'upsert', row: { ...a, messages: 999 } },
    ]);
    expect(source.state().counters.markers).toBe(2);
    expect(source.state().counters.removals).toBe(1);
    for (const change of changes) {
      if (change.kind === 'remove') expect(change.rowId).not.toBe(MARKER);
    }
  });

  it('AC-6 a snapshot is reconciled and only a newer marker asks for a reload', async () => {
    const { data, source, changes, queues, follower, itemOf } = following();
    const [a, b, c] = queues;
    if (!a || !b || !c) throw new Error('rows');
    await source.window(request(0), signal()); // the pin is 7
    expect(source.state().pin).toBe(7);

    // The snapshot lacks b: it has left the inventory. The marker is at the pin: no reload.
    data.emit(
      {
        kind: 'snapshot',
        items: [itemOf(a), itemOf(c), { key: MARKER, version: 7 }],
      },
      follower,
    );
    expect(changes.filter((c2) => c2.kind === 'remove')).toEqual([
      { kind: 'remove', rowId: b.key },
    ]);
    expect(changes.some((c2) => c2.kind === 'refresh')).toBe(false);
    expect(source.state().counters.reconciled).toBe(1);
    expect(source.state().counters.removals).toBe(1);

    // A marker newer than the pin asks for exactly one reload per version.
    changes.length = 0;
    data.emit(
      {
        kind: 'snapshot',
        items: [itemOf(a), itemOf(b), itemOf(c), { key: MARKER, version: 9 }],
      },
      follower,
    );
    expect(changes.filter((c2) => c2.kind === 'refresh')).toHaveLength(1);
    data.emit(
      { kind: 'delta', upserts: [{ key: MARKER, version: 9 }], removes: [] },
      follower,
    );
    expect(changes.filter((c2) => c2.kind === 'refresh')).toHaveLength(1);
    data.emit(
      { kind: 'delta', upserts: [{ key: MARKER, version: 10 }], removes: [] },
      follower,
    );
    expect(changes.filter((c2) => c2.kind === 'refresh')).toHaveLength(2);
    expect(source.state().counters.refreshes).toBe(2);
    expect(source.state().counters.reconciled).toBe(2);
    expect(source.state().counters.markers).toBe(4);

    // With no pin yet nothing is compared: the marker alone does not ask for a reload.
    const fresh = following();
    fresh.data.emit(
      { kind: 'snapshot', items: [{ key: MARKER, version: 99 }] },
      fresh.follower,
    );
    expect(fresh.changes.some((c2) => c2.kind === 'refresh')).toBe(false);
  });

  it('AC-7 the subscription follows the visible keys with one resubscribe per change', () => {
    const data = createFakeExplorerData();
    const source = createInventoryWindowSource(data, query('queues'));
    const ids = 'abcdefghijklmnopqrst'.split('');
    source.watch(new Set(ids));
    expect(data.followers).toHaveLength(1);
    expect(data.followers[0]?.params).toEqual({
      cid: 'c1',
      kind: 'queues',
      keys: ids,
    });
    source.watch(new Set(ids)); // the same ids
    source.watch(new Set(ids.slice(0, 5))); // a subset
    source.watch(new Set()); // nothing on screen
    expect(data.followers).toHaveLength(1);
    expect(data.followers[0]?.active).toBe(true);
    expect(source.state().counters.resubscribes).toBe(0);

    // A different set: an unsub, then a sub with the new keys in screen order.
    const next = ['z', 'y', 'x', 'a'];
    source.watch(new Set(next));
    expect(data.followers).toHaveLength(2);
    expect(data.followers[0]?.active).toBe(false);
    expect(data.followers[1]?.active).toBe(true);
    expect(data.followers[1]?.params.keys).toEqual(next);
    expect(source.state().counters.resubscribes).toBe(1);
    expect(source.state().followed).toBe(4);
    expect(source.state().live).toBe('connecting');

    // Events of the ended subscription change nothing.
    const changes: Changes = [];
    source.onChanges((c) => changes.push(...c));
    data.followers[0]?.listener({
      kind: 'delta',
      upserts: [],
      removes: ['z'],
    });
    expect(changes).toEqual([]);

    // Never more than 500 keys, and what is left out is counted.
    const many = createInventoryWindowSource(data, query('queues'));
    many.watch(new Set(Array.from({ length: 600 }, (_, i) => `k${String(i)}`)));
    const last = data.followers.at(-1);
    expect(last?.params.keys).toHaveLength(500);
    expect(many.state().followed).toBe(500);
    expect(many.state().unfollowed).toBe(100);

    source.destroy();
    expect(data.followers[1]?.active).toBe(false);
    source.watch(new Set(['q'])); // nothing after destroy
    expect(data.followers).toHaveLength(3); // two of the first source, one of the second
  });

  it('AC-9 a failed window, a gap, a reset and an ended topic are each counted, shown and recoverable', async () => {
    const { data, source, changes, queues, follower, itemOf } = following();
    const [a, b] = queues;
    if (!a || !b) throw new Error('rows');

    // A failed window fails its block whole; the grid retries and the next one is served.
    data.failNext(new Error('broker unreachable'));
    await expect(source.window(request(0), signal())).rejects.toThrow(
      'broker unreachable',
    );
    expect(source.state().counters.windowFailures).toBe(1);
    expect((await source.window(request(0), signal())).rows).toHaveLength(200);
    expect(source.state().pin).toBe(7);

    // The topic's own health is shown.
    data.emit({ kind: 'status', state: 'degraded' }, follower);
    expect(source.state().liveStatus).toBe('degraded');

    // A gap is counted, and the snapshot after it reconciles.
    data.emit({ kind: 'gap' }, follower);
    expect(source.state().counters.gaps).toBe(1);
    data.emit(
      {
        kind: 'snapshot',
        items: [itemOf(a), { key: MARKER, version: 7 }],
      },
      follower,
    );
    expect(changes).toContainEqual({ kind: 'remove', rowId: b.key });
    expect(source.state().live).toBe('following');

    // A reset (a new engine session): the pin is dropped and one reload is asked.
    changes.length = 0;
    data.emit({ kind: 'reset' }, follower);
    expect(source.state().counters.resets).toBe(1);
    expect(source.state().pin).toBeNull();
    expect(changes).toEqual([{ kind: 'refresh' }]);

    // The topic ends with a Problem: it is shown, following stops, and windows still work.
    const problem = Object.assign(new Error('Subscription refused'), {
      code: 'FORBIDDEN_RBAC',
    });
    data.emit({ kind: 'error', error: problem }, follower);
    expect(source.state().live).toBe('ended');
    expect(source.state().liveProblem).toBe(problem);
    expect(source.state().followed).toBe(0);
    expect(follower.active).toBe(false);
    source.watch(new Set(['other']));
    expect(data.followers).toHaveLength(1); // no new subscription
    expect((await source.window(request(0), signal())).rows).toHaveLength(200);

    // An end without a Problem ends it too, with nothing to show.
    const ended = following();
    ended.data.emit({ kind: 'end' }, ended.follower);
    expect(ended.source.state().live).toBe('ended');
    expect(ended.source.state().liveProblem).toBeNull();
  });
});
