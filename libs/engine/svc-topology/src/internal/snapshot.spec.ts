import type { ConnectionId } from '@app/contracts';
import { describe, expect, it } from 'vitest';

import { DEFAULT_TOPOLOGY_LIMITS } from '../deps';
import {
  FAKE_CONNECTION_ID,
  SAMPLE_VHOST,
  brokerFailure,
  createScriptedBroker,
  createTopologyFakeDeps,
  sampleProfile,
  type FakeQueue,
  type FakeVhost,
} from '../testing';

import { createSnapshotReader } from './snapshot';
import { toRoutingTopology } from './to-routing';

const cid = FAKE_CONNECTION_ID as ConnectionId;
const signal = new AbortController().signal;
const names = (count: number, prefix = 'q'): FakeQueue[] =>
  Array.from({ length: count }, (_, i) => ({
    name: `${prefix}-${String(i).padStart(5, '0')}`,
    type: 'quorum',
    policy: null,
    operator_policy: null,
    delivery_limit: 20,
  }));
const readerOver = (
  vhosts: Record<string, FakeVhost>,
  options: Parameters<typeof createSnapshotReader>[0]['limits'] = {},
) => {
  const deps = createTopologyFakeDeps({ vhosts, limits: options });
  return {
    deps,
    reader: createSnapshotReader({
      mgmt: deps.mgmt,
      clock: deps.clock,
      limits: options,
    }),
  };
};

describe('M1-20 AC-10 snapshot cuts are counted', () => {
  it('keeps the first rows of every kind past its bound and counts the rest', async () => {
    const { reader } = readerOver(
      {
        '/': {
          queues: names(5),
          exchanges: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
          bindings: [
            { source: 'a', destination: 'q-00000' },
            { source: 'a', destination: 'q-00001' },
            { source: 'b', destination: 'q-00002' },
            { source: 'c', destination: 'q-00003' },
          ],
          policies: [
            { name: 'p1', pattern: 'a', definition: {} },
            { name: 'p2', pattern: 'b', definition: {} },
            { name: 'p3', pattern: 'c', definition: {} },
          ],
          operatorPolicies: [],
          consumers: { acking: ['q-00000', 'q-00001'], noAck: ['q-00002'] },
        },
      },
      {
        maxQueues: 2,
        maxExchanges: 1,
        maxBindings: 2,
        maxConsumers: 1,
        maxPolicies: 1,
        pageSize: 2,
      },
    );

    const snapshot = await reader.read(cid, '/', signal);

    expect(snapshot.queues.map((q) => q.name)).toEqual(['q-00000', 'q-00001']);
    expect(snapshot.exchanges).toHaveLength(1);
    expect(snapshot.bindings).toHaveLength(2);
    // A list cut at its bound could hide the policy that decides: it is unreadable, not partial.
    expect(snapshot.policies).toEqual({ state: 'unreadable' });
    expect(snapshot.operatorPolicies.state).toBe('read');
    expect(snapshot.consumers).toBe('truncated');
    expect([...snapshot.ackingQueues]).toEqual(['q-00000']);
    expect(snapshot.truncation).toEqual({
      queues: 3,
      exchanges: 2,
      bindings: 2,
      consumers: 2,
      policies: 2,
      operatorPolicies: 0,
    });
  });

  it('cuts nothing at the default bounds for a vhost of 5,000 queues', async () => {
    const { reader, deps } = readerOver({ '/': { queues: names(5_000) } });

    const snapshot = await reader.read(cid, '/', signal);

    expect(snapshot.queues).toHaveLength(5_000);
    expect(Object.values(snapshot.truncation).every((n) => n === 0)).toBe(true);
    // 5,000 queues at the broker's page ceiling are ten pages, in the interactive lane.
    const pages = deps.broker.requests.filter((r) =>
      r.path.startsWith('/api/queues/'),
    );
    expect(pages).toHaveLength(10);
    expect(new Set(pages.map((r) => r.lane))).toEqual(new Set(['interactive']));
  });

  it('reads a policy list that is exactly at its bound and refuses one past it by a single policy', async () => {
    const policy = (name: string) => ({ name, pattern: name, definition: {} });
    const at = readerOver(
      { '/': { policies: [policy('a'), policy('b')] } },
      { maxPolicies: 2 },
    );
    const over = readerOver(
      { '/': { policies: [policy('a'), policy('b'), policy('c')] } },
      { maxPolicies: 2 },
    );

    const exact = await at.reader.read(cid, '/', signal);
    const cut = await over.reader.read(cid, '/', signal);

    expect(exact.policies.state).toBe('read');
    expect(exact.truncation.policies).toBe(0);
    expect(cut.policies).toEqual({ state: 'unreadable' });
    expect(cut.truncation.policies).toBe(1);
  });

  it('reports a refused policy list and a refused consumer list as gaps, not errors', async () => {
    const { reader } = readerOver({
      '/': {
        ...SAMPLE_VHOST,
        policies: 'forbidden',
        operatorPolicies: 'method-not-allowed',
        consumers: 'forbidden',
      },
    });

    const snapshot = await reader.read(cid, '/', signal);

    expect(snapshot.policies).toEqual({ state: 'unreadable' });
    expect(snapshot.operatorPolicies).toEqual({ state: 'unreadable' });
    expect(snapshot.consumers).toBe('unreadable');
    expect(snapshot.queues).toHaveLength(2);
  });
});

describe('M1-20 AC-11 snapshot reads fail closed', () => {
  it('fails the whole read when queues cannot be read, with the port Problem and nothing partial', async () => {
    const { reader, deps } = readerOver({ '/': SAMPLE_VHOST });
    deps.broker.intercept = (request) =>
      request.path.startsWith('/api/bindings/') ? brokerFailure() : undefined;

    await expect(reader.read(cid, '/', signal)).rejects.toMatchObject({
      code: 'BROKER_UNREACHABLE',
    });
    expect(reader.stats().held).toBe(0);
  });

  it('says a vhost that the broker does not know is not found, in one fixed text', async () => {
    const { reader } = readerOver({ '/': SAMPLE_VHOST });

    await expect(reader.read(cid, 'nope', signal)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: 'There is no such vhost.',
    });
  });

  it('does not turn an unreachable broker into an unreadable policy list', async () => {
    const { reader, deps } = readerOver({ '/': SAMPLE_VHOST });
    deps.broker.intercept = (request) =>
      request.path.startsWith('/api/policies/') ? brokerFailure() : undefined;

    await expect(reader.read(cid, '/', signal)).rejects.toMatchObject({
      code: 'BROKER_UNREACHABLE',
    });
  });

  it('stops the sibling reads of a failed one', async () => {
    const deps = createTopologyFakeDeps({ vhosts: { '/': SAMPLE_VHOST } });
    let stopped = false;
    const mgmt = {
      ...deps.mgmt,
      get: (request: { path: string }, s: AbortSignal) => {
        if (request.path.startsWith('/api/bindings/')) {
          return Promise.reject(brokerFailure());
        }
        // The other reads hang until they are told to stop.
        return new Promise((_, reject) => {
          s.addEventListener('abort', () => {
            if (request.path.startsWith('/api/queues/')) stopped = true;
            reject(new Error('stopped'));
          });
        });
      },
    } as unknown as typeof deps.mgmt;
    const reader = createSnapshotReader({ mgmt, clock: deps.clock });

    await expect(reader.read(cid, '/', signal)).rejects.toMatchObject({
      code: 'BROKER_UNREACHABLE',
    });
    expect(stopped).toBe(true);
    expect(reader.stats().held).toBe(0);
  });
});

describe('M1-20 AC-13 conversion yields and the snapshot cache is bounded', () => {
  it('yields to the event loop while it converts 20,000 queues, and the yields change nothing', async () => {
    const { reader, deps } = readerOver({ '/': { queues: names(20_000) } });
    const snapshot = await reader.read(cid, '/', signal);
    const profile = sampleProfile();

    const often = await toRoutingTopology(snapshot, profile, {
      yieldNow: deps.yieldNow ?? (() => Promise.resolve()),
      every: DEFAULT_TOPOLOGY_LIMITS.yieldEveryItems,
    });
    const never = await toRoutingTopology(snapshot, profile, {
      yieldNow: () => Promise.reject(new Error('should not yield')),
      every: 1_000_000,
    });

    expect(often.topology.queues).toHaveLength(20_000);
    expect(deps.yields.count).toBe(
      Math.floor(20_000 / DEFAULT_TOPOLOGY_LIMITS.yieldEveryItems),
    );
    expect(often).toEqual(never);
  });

  it('answers a second call inside the time to live from the snapshot, and reads again on refresh or after it', async () => {
    const { reader, deps } = readerOver({ '/': SAMPLE_VHOST });
    const reads = () => deps.broker.requests.length;

    const first = await reader.read(cid, '/', signal);
    const afterFirst = reads();
    const again = await reader.read(cid, '/', signal);
    expect(again).toBe(first);
    expect(reads()).toBe(afterFirst);

    const refreshed = await reader.read(cid, '/', signal, { refresh: true });
    expect(refreshed).not.toBe(first);
    expect(reads()).toBe(afterFirst * 2);

    deps.clock.advance(DEFAULT_TOPOLOGY_LIMITS.snapshotTtlMs - 1);
    expect(await reader.read(cid, '/', signal)).toBe(refreshed);
    deps.clock.advance(1);
    expect(await reader.read(cid, '/', signal)).not.toBe(refreshed);
    expect(reads()).toBe(afterFirst * 3);
  });

  it('never holds more than maxSnapshots and counts what it drops', async () => {
    const { reader } = readerOver(
      { '/': SAMPLE_VHOST, a: SAMPLE_VHOST, b: SAMPLE_VHOST },
      { maxSnapshots: 2 },
    );

    for (const vhost of ['/', 'a', 'b']) await reader.read(cid, vhost, signal);

    expect(reader.stats()).toEqual({ held: 2, evicted: 1 });
    reader.stop();
    expect(reader.stats().held).toBe(0);
  });

  it('keeps one snapshot per connection and vhost', async () => {
    const broker = createScriptedBroker({ '/': SAMPLE_VHOST });
    const reader = createSnapshotReader({ mgmt: broker.read });
    await reader.read(cid, '/', signal);
    await reader.read('c2' as ConnectionId, '/', signal);
    expect(reader.stats().held).toBe(2);
  });
});
