import { encodeObjectKey, EXPLORER_VERSION_KEY } from '@app/contracts';
import { describe, expect, it } from 'vitest';

import { createEntityWatch, isCertain, lookupEntity } from './entity-watch';
import type { Freshness, InventoryRow } from './ports';
import {
  createFakeExplorerData,
  type FakeExplorerData,
  type FakeFollower,
} from './testing';

/** A macrotask: every promise the fake started has settled when it returns. */
const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const abort = (): AbortController => new AbortController();

function queueKey(data: FakeExplorerData, at = 1): string {
  const row = data.rows().queues[at];
  if (row === undefined) throw new Error('the fake has no such queue');
  return row.key;
}

function follower(data: FakeExplorerData, at = 0): FakeFollower {
  const found = data.followers[at];
  if (found === undefined) throw new Error('no follower');
  return found;
}

const MARKER = (version: number) => ({
  key: EXPLORER_VERSION_KEY,
  version,
});

/** An item of the topic for a row: the row without its key, as the engine sends it. */
function item(row: InventoryRow, version: number, patch: object = {}) {
  const { key, ...rest } = row;
  return { key, version, row: { ...rest, ...patch } } as never;
}

describe('createEntityWatch: one followed key (R3)', () => {
  it('AC-3 an entity watch follows one key and says found, vanished and ended', async () => {
    const data = createFakeExplorerData({ rows: { queues: 5 } });
    const key = queueKey(data);
    const row = data.rows().queues[1];
    if (row === undefined) throw new Error('no row');
    const seen: string[] = [];
    const watch = createEntityWatch(data, { cid: 'c1', kind: 'queues', key });
    watch.onState((state) => seen.push(state.phase));

    // Exactly one subscription, for exactly one key, and one window of one row for the freshness.
    expect(data.followers).toHaveLength(1);
    expect(follower(data).params).toEqual({
      cid: 'c1',
      kind: 'queues',
      keys: [key],
    });
    expect(data.queries).toHaveLength(1);
    expect(data.queries[0]).toMatchObject({
      cid: 'c1',
      kind: 'queues',
      window: { offset: 0, limit: 1 },
    });
    expect(watch.state()).toMatchObject({
      phase: 'loading',
      live: 'connecting',
      row: null,
    });

    // The snapshot holds the row (the topic omits its key; it is put back) and the marker.
    data.emit(data.snapshotFor(follower(data).params));
    await flush();
    expect(watch.state()).toMatchObject({
      phase: 'found',
      live: 'following',
      row,
    });
    expect(watch.state().freshness?.state).toBe('live');

    // An upsert of the key updates it; the version marker is never a row; another key is ignored.
    data.emit({
      kind: 'delta',
      upserts: [
        item(row, 8, { messages: 999 }),
        MARKER(8),
        item({ ...row, key: queueKey(data, 3) as typeof row.key }, 8, {
          messages: 1,
        }),
      ],
      removes: [],
    });
    expect(watch.state().row).toMatchObject({ key, messages: 999 });

    data.emit({ kind: 'gap' });
    expect(watch.state().gaps).toBe(1);
    expect(watch.state().phase).toBe('found');

    // A removal keeps the last row and says it vanished; the key coming back makes it found again.
    data.emit({ kind: 'delta', upserts: [], removes: [key] });
    expect(watch.state()).toMatchObject({ phase: 'vanished' });
    expect(watch.state().row).toMatchObject({ key, messages: 999 });
    data.emit({ kind: 'delta', upserts: [item(row, 9)], removes: [] });
    expect(watch.state().phase).toBe('found');
    // A snapshot that lacks a row that was read says it vanished too.
    data.emit({ kind: 'snapshot', items: [MARKER(10)] });
    await flush();
    expect(watch.state().phase).toBe('vanished');
    expect(watch.state().row).not.toBeNull();

    // The topic ending after a row was read keeps the row and says why, as received.
    const problem = new Error('the engine said no');
    data.emit({ kind: 'error', error: problem });
    expect(watch.state()).toMatchObject({
      phase: 'vanished',
      live: 'ended',
      problem,
    });
    expect(seen).toContain('found');

    // Nothing polls: still one subscription and one read; destroy aborts and unsubscribes.
    expect(data.followers).toHaveLength(1);
    expect(data.queries).toHaveLength(1);
    watch.destroy();
    expect(follower(data).active).toBe(false);
  });

  it('AC-3 a topic that fails before any row is an error with the Problem as received, and destroy aborts a read in flight', async () => {
    const data = createFakeExplorerData({ rows: { queues: 3 } });
    const held = data.hold();
    const watch = createEntityWatch(data, {
      cid: 'c1',
      kind: 'queues',
      key: queueKey(data),
    });
    const problem = { title: 'Forbidden', code: 'FORBIDDEN_BROKER' };
    data.emit({ kind: 'error', error: problem });
    expect(watch.state()).toMatchObject({
      phase: 'error',
      live: 'ended',
      problem,
      row: null,
    });
    watch.destroy();
    expect(data.signals[0]?.aborted).toBe(true);
    held.release();
    await flush();
    expect(watch.state().freshness).toBeNull(); // a late answer after destroy is dropped
  });

  it('AC-3 a reset reads the freshness again and an ended topic without a Problem is not an error', async () => {
    const data = createFakeExplorerData({ rows: { queues: 3 } });
    const key = queueKey(data);
    const watch = createEntityWatch(data, { cid: 'c1', kind: 'queues', key });
    data.emit(data.snapshotFor(follower(data).params));
    await flush();
    data.emit({ kind: 'reset' });
    await flush();
    expect(data.queries).toHaveLength(2);
    expect(watch.state().reads).toBe(2);
    watch.refresh();
    await flush();
    expect(data.queries).toHaveLength(3);
    data.emit({ kind: 'end' });
    expect(watch.state()).toMatchObject({ phase: 'found', live: 'ended' });
    expect(watch.state().problem).toBeNull();
    watch.destroy();
    watch.refresh(); // after destroy it does nothing
    expect(data.queries).toHaveLength(3);
  });
});

const ABSENT = encodeObjectKey('/', 'not-on-the-broker');

describe('absence and the lookup (R3, R4)', () => {
  const CASES: readonly (readonly [string, Partial<Freshness>, boolean])[] = [
    ['live and complete', {}, true],
    ['still loading', { state: 'loading', complete: false }, false],
    ['stale', { state: 'stale' }, false],
    ['unavailable', { state: 'unavailable' }, false],
    ['incomplete', { complete: false }, false],
    ['truncated', { truncated: true }, false],
    ['rows dropped', { dropped: 3 }, false],
  ];

  it('AC-4 absence is certain only when the inventory is live and complete, and the lookup never guesses', async () => {
    for (const [label, patch, certain] of CASES) {
      const data = createFakeExplorerData({ rows: { queues: 3 } });
      data.setFreshness(patch);
      const held = data.hold();
      const watch = createEntityWatch(data, {
        cid: 'c1',
        kind: 'queues',
        key: ABSENT,
      });
      data.emit(data.snapshotFor(follower(data).params));
      // The key is not in the snapshot, but how sure that is waits for the freshness.
      expect(watch.state().phase, label).toBe('loading');
      held.release();
      await flush();
      expect(watch.state().phase, label).toBe('missing');
      expect(watch.state().certain, label).toBe(certain);
      expect(isCertain(watch.state().freshness), label).toBe(certain);

      const lookup = lookupEntity(
        data,
        { cid: 'c1', kind: 'queues', key: ABSENT },
        abort().signal,
      );
      data.emit(data.snapshotFor(follower(data, 1).params));
      expect(await lookup, label).toBe(certain ? 'absent' : 'unknown');
      expect(follower(data, 1).active, label).toBe(false); // released before it answered
    }

    // A row that is there is found, whatever the freshness says.
    const data = createFakeExplorerData({ rows: { queues: 3 } });
    data.setFreshness({ state: 'stale', complete: false });
    const found = lookupEntity(
      data,
      { cid: 'c1', kind: 'queues', key: queueKey(data) },
      abort().signal,
    );
    data.emit(data.snapshotFor(follower(data).params));
    expect(await found).toBe('found');

    // An unreadable freshness leaves an absence uncertain; a failure of the topic is unknown.
    const failing = createFakeExplorerData({ rows: { queues: 3 } });
    failing.failNext(new Error('503'));
    const unreadable = lookupEntity(
      failing,
      { cid: 'c1', kind: 'queues', key: ABSENT },
      abort().signal,
    );
    failing.emit(failing.snapshotFor(follower(failing).params));
    expect(await unreadable).toBe('unknown');
    const broken = createFakeExplorerData({ rows: { queues: 3 } });
    const errored = lookupEntity(
      broken,
      { cid: 'c1', kind: 'queues', key: ABSENT },
      abort().signal,
    );
    broken.emit({ kind: 'error', error: new Error('closed') });
    expect(await errored).toBe('unknown');

    // An abort answers unknown at once and releases the subscription and the read.
    const slow = createFakeExplorerData({ rows: { queues: 3 } });
    slow.hold();
    const controller = abort();
    const aborted = lookupEntity(
      slow,
      { cid: 'c1', kind: 'queues', key: ABSENT },
      controller.signal,
    );
    controller.abort();
    expect(await aborted).toBe('unknown');
    expect(follower(slow).active).toBe(false);
    expect(slow.signals[0]?.aborted).toBe(true);
    const never = lookupEntity(
      slow,
      { cid: 'c1', kind: 'queues', key: ABSENT },
      AbortSignal.abort(),
    );
    expect(await never).toBe('unknown');
    expect(slow.followers).toHaveLength(1); // a signal that is already aborted subscribes to nothing
  });
});

describe('a binding (R3)', () => {
  const identity = (source: string, destination: string, key: string) =>
    encodeObjectKey('/', [source, 'queue', destination, key].join('\u0000'));

  function dataWithBindings() {
    const data = createFakeExplorerData({
      rows: { queues: 0, exchanges: 0, connections: 0, bindings: 0 },
      vhosts: ['/'],
    });
    data.bump((rows) => {
      rows.bindings = [
        {
          key: identity('ex1', 'q1', 'rk'),
          vhost: '/',
          source: 'ex1',
          destination: 'q1',
          destinationType: 'queue',
          routingKey: 'rk',
          propertiesKey: 'rk',
        },
        {
          key: identity('ex2', 'q-other', 'k'),
          vhost: '/',
          source: 'ex2',
          destination: 'q-other',
          destinationType: 'queue',
          routingKey: 'k',
          propertiesKey: 'k',
        },
      ] as never;
    });
    return data;
  }

  it('AC-6 a binding is found by its key in its vhost and never followed live', async () => {
    const data = dataWithBindings();
    const key = identity('ex1', 'q1', 'rk');
    const watch = createEntityWatch(data, { cid: 'c1', kind: 'bindings', key });
    expect(watch.state()).toMatchObject({ phase: 'loading', live: 'off' });
    await flush();
    expect(watch.state()).toMatchObject({ phase: 'found', live: 'off' });
    expect(watch.state().row).toMatchObject({ key, source: 'ex1' });
    expect(data.followers).toHaveLength(0); // bindings have no topic
    expect(data.queries).toHaveLength(1);
    expect(data.queries[0]).toMatchObject({
      kind: 'bindings',
      filter: { vhosts: ['/'], text: 'q1' }, // exactly one vhost, and the destination as text
    });
    expect(data.queries[0]?.window.limit).toBeLessThanOrEqual(200);

    // Refresh reads again, once.
    watch.refresh();
    await flush();
    expect(data.queries).toHaveLength(2);
    expect(watch.state().reads).toBe(2);

    // An absent binding of a whole read is certainly absent; of a stale index it is not.
    const absent = identity('ex1', 'q1', 'other-key');
    const gone = createEntityWatch(data, {
      cid: 'c1',
      kind: 'bindings',
      key: absent,
    });
    await flush();
    expect(gone.state()).toMatchObject({ phase: 'missing', certain: true });
    data.setFreshness({ state: 'stale' });
    const stale = createEntityWatch(data, {
      cid: 'c1',
      kind: 'bindings',
      key: absent,
    });
    await flush();
    expect(stale.state()).toMatchObject({ phase: 'missing', certain: false });
    data.setFreshness(null);

    // A failed read is an error with the Problem as received; a key that is not a binding's is one too.
    const problem = new Error('503');
    data.failNext(problem);
    const failed = createEntityWatch(data, {
      cid: 'c1',
      kind: 'bindings',
      key,
    });
    await flush();
    expect(failed.state()).toMatchObject({ phase: 'error', problem });
    const notABinding = createEntityWatch(data, {
      cid: 'c1',
      kind: 'bindings',
      key: encodeObjectKey('/', 'just-a-name'),
    });
    expect(notABinding.state().phase).toBe('error');

    // Destroyed: a late answer changes nothing.
    const held = data.hold();
    const late = createEntityWatch(data, { cid: 'c1', kind: 'bindings', key });
    late.destroy();
    held.release();
    await flush();
    expect(late.state().phase).toBe('loading');
    const seen = await lookupEntity(
      data,
      { cid: 'c1', kind: 'bindings', key },
      abort().signal,
    );
    expect(seen).toBe('found');
  });
});
