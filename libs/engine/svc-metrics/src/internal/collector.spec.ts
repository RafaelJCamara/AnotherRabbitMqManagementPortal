import { describe, expect, it } from 'vitest';

import type { ConnectionId } from '@app/contracts';

import {
  brokerFailure,
  createMetricsFakeDeps,
  sampleProfile,
} from '../testing';

import type { Collector } from './collector';

const CID = 'c1' as ConnectionId;
const START = new AbortController().signal;

/** The collector over the fakes, with the pieces a spec drives. */
function setup(options: Parameters<typeof createMetricsFakeDeps>[0] = {}) {
  const fakes = createMetricsFakeDeps(options);
  const { collector } = fakes;
  return { ...fakes, collector };
}

const value = (
  collector: Collector,
  metric: 'messages_ready' | 'queue_messages',
) =>
  collector.store
    .read(
      CID,
      metric === 'messages_ready'
        ? { metric }
        : { metric, vhost: '/', queue: 'orders' },
    )
    ?.points.at(-1)?.v;

describe('collector rounds', () => {
  it('AC-15 demand starts a round that scrapes through the port in the background lane and stores the points', async () => {
    const t = setup();
    expect(t.collector.status(CID).state).toBe('unavailable');
    t.collector.touch(CID);
    expect(t.collector.status(CID).state).toBe('loading');
    await t.timers.settle();

    expect(t.promScript.requests).toHaveLength(1);
    expect(t.promScript.requests[0]).toEqual({
      connectionId: CID,
      node: 'rabbit@n1',
      endpoint: 'http://127.0.0.1:15692/metrics',
      path: '/metrics',
      lane: 'background',
    });
    expect(value(t.collector, 'messages_ready')).toBe(990);
    // Nothing reached the management API: Prometheus answered.
    expect(t.mgmtScript.paths).toEqual([]);
    const status = t.collector.status(CID);
    expect(status).toMatchObject({
      state: 'live',
      source: 'prometheus',
      intervalMs: 15_000,
      partial: [],
      approximate: false,
      dropped: { points: 0, series: 0, samples: 0 },
    });
    expect(status.asOf).toBe(t.clock.now());

    // The next round comes at the planned interval, not sooner.
    await t.timers.advance(14_999);
    expect(t.promScript.requests).toHaveLength(1);
    await t.timers.advance(1);
    expect(t.promScript.requests).toHaveLength(2);
    expect(
      t.collector.store.read(CID, { metric: 'messages_ready' })?.points,
    ).toHaveLength(2);
  });

  it('AC-15 queue demand adds the detailed read, with the queue= filter, and its series', async () => {
    const t = setup();
    t.collector.touch(CID, [{ vhost: '/', name: 'orders' }]);
    await t.timers.settle();

    expect(t.promScript.requests.map((request) => request.path)).toEqual([
      '/metrics',
      '/metrics/detailed',
    ]);
    expect(t.promScript.requests[1]?.query).toEqual({
      family: ['queue_coarse_metrics', 'queue_consumer_count'],
      vhost: '/',
      queue: '^(?:orders)$',
    });
    // `audit` was on the page too, but nobody asked for it: not stored.
    expect(value(t.collector, 'queue_messages')).toBe(124);
    expect(
      t.collector.store.read(CID, {
        metric: 'queue_messages',
        vhost: '/',
        queue: 'audit',
      }),
    ).toBeUndefined();
    expect(t.collector.status(CID).dropped.samples).toBeGreaterThan(0);
  });

  it('AC-15 no demand, no request; idle demand ends the loop with no timer left', async () => {
    const t = setup({ limits: { idleStopMs: 40_000 } });
    await t.timers.advance(600_000);
    expect(t.promScript.requests).toHaveLength(0);
    expect(t.mgmtScript.paths).toHaveLength(0);

    t.collector.touch(CID);
    await t.timers.settle();
    expect(t.promScript.requests).toHaveLength(1);
    // Rounds at 0, 15 and 30 s; the check at 45 s sees 45 s without demand (limit 40) and stops.
    await t.timers.advance(45_000);
    expect(t.promScript.requests).toHaveLength(3);
    expect(t.timers.pending()).toBe(0);
    await t.timers.advance(600_000);
    expect(t.promScript.requests).toHaveLength(3);
    // Demand again restarts it.
    t.collector.touch(CID);
    await t.timers.settle();
    expect(t.promScript.requests).toHaveLength(4);
  });

  it('AC-15 stop aborts what is running and nothing is requested after it', async () => {
    const t = setup();
    t.collector.touch(CID);
    await t.timers.settle();
    expect(t.timers.pending()).toBe(1);
    await t.collector.stop();
    expect(t.timers.pending()).toBe(0);
    await t.timers.advance(600_000);
    expect(t.promScript.requests).toHaveLength(1);
    t.collector.touch(CID);
    await t.timers.settle();
    expect(t.promScript.requests).toHaveLength(1);
    const late = await t.collector.roundNow(CID, START);
    expect(late.ended).toBe('failed');
  });

  it('AC-15 a connection with no profile is unavailable and nothing is asked of the broker', async () => {
    const t = setup({ seeded: false });
    t.collector.touch(CID);
    await t.timers.settle();
    expect(t.promScript.requests).toHaveLength(0);
    expect(t.mgmtScript.paths).toHaveLength(0);
    expect(t.collector.status(CID)).toMatchObject({
      state: 'unavailable',
      source: 'none',
    });
  });
});

describe('collector fallback', () => {
  it('AC-15 three failed rounds fall back to management sampling, and Prometheus is tried again after the cool-down', async () => {
    const t = setup();
    t.promScript.intercept = () => brokerFailure(503);
    t.collector.touch(CID);
    await t.timers.settle();
    await t.timers.advance(15_000);
    await t.timers.advance(15_000);
    expect(t.promScript.requests).toHaveLength(3);
    expect(t.collector.status(CID)).toMatchObject({
      state: 'unavailable',
      source: 'prometheus',
    });
    expect(t.mgmtScript.paths).toEqual([]);

    // The fourth round reads the management API instead: aggregate reads only.
    await t.timers.advance(15_000);
    expect(t.promScript.requests).toHaveLength(3);
    expect(t.mgmtScript.paths).toEqual(['/api/overview', '/api/nodes']);
    const status = t.collector.status(CID);
    expect(status).toMatchObject({
      state: 'live',
      source: 'management',
      fallbackReason: 'failing',
      approximate: true,
      intervalMs: 30_000,
    });
    expect(status.partial).toEqual(['fallback']);
    expect(
      t.collector.store.read(CID, { metric: 'messages' })?.info,
    ).toMatchObject({
      source: 'management',
      approximate: false,
    });
    // A counter from sampling is labelled approximate.
    expect(
      t.collector.store.read(CID, { metric: 'published_total' })?.info
        .approximate,
    ).toBe(true);

    // Within the cool-down the broker's Prometheus endpoint is left alone.
    await t.timers.advance(240_000);
    expect(t.promScript.requests).toHaveLength(3);

    // After it, one try; it fails, and the fallback returns at once.
    await t.timers.advance(60_000);
    expect(t.promScript.requests).toHaveLength(4);
    const before = t.mgmtScript.paths.length;
    await t.timers.advance(30_000);
    expect(t.promScript.requests).toHaveLength(4);
    expect(t.mgmtScript.paths.length).toBeGreaterThan(before);

    // The endpoint recovers: the next try after a cool-down succeeds and Prometheus is back. The person
    // is still looking (demand keeps the loop alive past its idle stop).
    t.collector.touch(CID);
    t.promScript.intercept = undefined;
    await t.timers.advance(300_000);
    await t.timers.advance(30_000);
    expect(t.collector.status(CID)).toMatchObject({
      source: 'prometheus',
      approximate: false,
    });
    expect(t.collector.status(CID).fallbackReason).toBeUndefined();
    expect(t.collector.status(CID).partial).toEqual([]);
  });

  it('AC-13 a profile with no endpoint is read through management from the start, per-object only where allowed', async () => {
    const none = setup({
      profile: {
        prometheus: {
          endpoints: [],
          perObjectAllowed: false,
          queueFilter: false,
          minIntervalSec: 60,
        },
      },
    });
    none.collector.touch(CID, [{ vhost: '/', name: 'orders' }]);
    await none.timers.settle();
    expect(none.promScript.requests).toHaveLength(0);
    // No per-object read is made on a provider that forbids it.
    expect(none.mgmtScript.paths).toEqual(['/api/overview', '/api/nodes']);
    expect(none.collector.status(CID)).toMatchObject({
      source: 'management',
      fallbackReason: 'no-endpoint',
      intervalMs: 60_000,
    });
    expect(none.collector.status(CID).partial).toEqual([
      'fallback',
      'per-object-unavailable',
    ]);

    const allowed = setup({
      profile: {
        prometheus: {
          endpoints: [],
          perObjectAllowed: true,
          queueFilter: false,
          minIntervalSec: 15,
        },
      },
    });
    allowed.collector.touch(CID, [{ vhost: '/', name: 'orders' }]);
    await allowed.timers.settle();
    expect(allowed.mgmtScript.paths).toEqual([
      '/api/overview',
      '/api/nodes',
      '/api/queues/%2F/orders',
    ]);
    expect(value(allowed.collector, 'queue_messages')).toBe(50);
  });

  it('AC-13 statistics off: the series the overview cannot give are absent, not zero', async () => {
    const t = setup({
      profile: {
        prometheus: {
          endpoints: [],
          perObjectAllowed: true,
          queueFilter: false,
          minIntervalSec: 15,
        },
      },
    });
    t.mgmtScript.statsOff = true;
    t.collector.touch(CID);
    await t.timers.settle();
    expect(
      t.collector.store.read(CID, { metric: 'messages_ready' }),
    ).toBeUndefined();
    expect(
      t.collector.store.read(CID, { metric: 'published_total' }),
    ).toBeUndefined();
    expect(
      t.collector.store.read(CID, { metric: 'connections' })?.points.at(-1)?.v,
    ).toBe(3);
  });
});

describe('collector targets', () => {
  const two = {
    prometheus: {
      endpoints: [
        {
          node: 'rabbit@n1',
          url: 'http://h1:15692/metrics',
          source: 'listener' as const,
        },
        {
          node: 'rabbit@n2',
          url: 'http://h2:15692/metrics',
          source: 'listener' as const,
        },
      ],
      perObjectAllowed: true,
      queueFilter: true,
      minIntervalSec: 15,
    },
    nodes: [
      { name: 'rabbit@n1', running: true },
      { name: 'rabbit@n2', running: true },
    ],
  };

  it('AC-15 a node that does not answer makes the round partial, and the others are stored', async () => {
    const t = setup({ profile: two });
    t.promScript.intercept = (request) =>
      request.node === 'rabbit@n2' ? brokerFailure(503) : undefined;
    t.collector.touch(CID);
    await t.timers.settle();
    expect(t.promScript.requests.map((request) => request.node)).toEqual([
      'rabbit@n1',
      'rabbit@n2',
    ]);
    expect(value(t.collector, 'messages_ready')).toBe(990);
    expect(t.collector.status(CID)).toMatchObject({
      state: 'live',
      source: 'prometheus',
    });
    expect(t.collector.status(CID).partial).toEqual(['targets-unreachable']);
    // One answering node is no failed round: the fallback counter stays at zero.
    await t.timers.advance(15_000 * 5);
    expect(t.mgmtScript.paths).toEqual([]);
  });

  it('AC-15 a status goes stale when the newest point is older than three intervals', async () => {
    const t = setup({ limits: { failuresBeforeFallback: 99 } });
    t.collector.touch(CID);
    await t.timers.settle();
    expect(t.collector.status(CID).state).toBe('live');
    t.promScript.intercept = () => brokerFailure(503);
    await t.timers.advance(45_000);
    expect(t.collector.status(CID).state).toBe('live');
    await t.timers.advance(15_000);
    expect(t.collector.status(CID).state).toBe('stale');
  });

  it('AC-15 a listener is told of every round and cannot break the loop', async () => {
    const t = setup();
    const seen: string[] = [];
    const off = t.collector.onRound(CID, (outcome) => {
      seen.push(outcome.ended);
      throw new Error('a listener that fails');
    });
    t.collector.touch(CID);
    await t.timers.settle();
    await t.timers.advance(15_000);
    expect(seen).toEqual(['complete', 'complete']);
    off();
    await t.timers.advance(15_000);
    expect(seen).toHaveLength(2);
    expect(t.promScript.requests).toHaveLength(3);
  });

  it('AC-15 the profile is read for every round, so a changed endpoint list applies at once', async () => {
    const t = setup();
    t.collector.touch(CID);
    await t.timers.settle();
    expect(t.promScript.requests[0]?.endpoint).toBe(
      'http://127.0.0.1:15692/metrics',
    );
    const changed = sampleProfile(two);
    const original = t.profiles.get.bind(t.profiles);
    t.profiles.get = async (id) => {
      const record = await original(id);
      return record === undefined ? undefined : { ...record, profile: changed };
    };
    await t.timers.advance(15_000);
    expect(
      t.promScript.requests.slice(1).map((request) => request.endpoint),
    ).toEqual(['http://h1:15692/metrics', 'http://h2:15692/metrics']);
  });
});
