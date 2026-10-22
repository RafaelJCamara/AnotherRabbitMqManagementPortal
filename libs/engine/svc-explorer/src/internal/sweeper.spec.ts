import { ConnectionIdSchema } from '@app/contracts';
import { createManualClock, createManualTimers } from '@app/kernel';
import type { MgmtGetRequest, MgmtReadPort } from '@app/ports';
import { describe, expect, it } from 'vitest';

import { brokerFailure, createScriptedBroker } from '../testing';

import { createSweeper } from './sweeper';

const cid = ConnectionIdSchema.parse('c1');
const first = { kind: 'queues', offset: 0, limit: 1 } as const;

describe('explorer sweeper', () => {
  it('M0-48 AC-3 explorer sweep of 20k queues is paged at 500 with stats-off flags in the background lane', async () => {
    const broker = createScriptedBroker({ queueCount: 20_000, vhostCount: 4 });
    const sweeper = createSweeper({ mgmt: broker.read });

    const outcome = await sweeper.sweepNow(cid, new AbortController().signal);

    const lists = broker.requests.filter((r) =>
      r.path.startsWith('/api/queues/'),
    );
    const others = broker.requests.filter((r) => !lists.includes(r));
    expect(outcome).toMatchObject({ ended: 'complete', requests: 46 });
    expect(lists).toHaveLength(40);
    for (const r of lists) {
      expect(typeof r.query.page).toBe('number');
      expect(r.query).toMatchObject({
        page_size: 500,
        disable_stats: true,
        enable_queue_totals: true,
      });
    }
    expect(broker.requests.every((r) => r.lane === 'background')).toBe(true);
    // The vhost list is asked once and unpaged; the rest are 4 exchange lists and the one global
    // connection list, all paged (the connection list has no queue totals to ask for).
    expect(others.map((r) => r.path)).toEqual([
      '/api/vhosts',
      ...broker.vhosts.map((v) => `/api/exchanges/${encodeURIComponent(v)}`),
      '/api/connections',
    ]);
    expect(others[0]?.query).toEqual({});
    expect(others.slice(1).every((r) => r.query.page === 1)).toBe(true);
    expect(others.at(-1)?.query).toEqual({
      page: 1,
      page_size: 500,
      disable_stats: true,
    });
    expect(
      new Set(broker.requests.map((r) => r.path + JSON.stringify(r.query)))
        .size,
    ).toBe(46);
    expect(sweeper.index(cid)?.window(first).total).toBe(20_000);
  });

  it('M0-48 AC-4 explorer failed or partial sweep keeps the last good index and says stale', async () => {
    const broker = createScriptedBroker({ queueCount: 3_000, vhostCount: 2 });
    const sweeper = createSweeper({ mgmt: broker.read });
    const run = (signal = new AbortController().signal) =>
      sweeper.sweepNow(cid, signal);
    expect((await run()).ended).toBe('complete');
    const index = sweeper.index(cid);
    const good = index?.window(first).version;
    const failAt = (ordinal: number) => {
      const base = broker.requests.length;
      broker.intercept = (_r, n) =>
        n === base + ordinal ? brokerFailure() : undefined;
    };
    const keptGood = () => {
      const now = index?.window(first);
      expect(now).toMatchObject({
        total: 3_000,
        version: { version: good?.version, complete: true, stale: true },
      });
    };

    failAt(5); // a page in the middle of the queue lists
    const paged = await run();
    expect(paged).toMatchObject({
      ended: 'failed',
      problem: { code: 'BROKER_UNREACHABLE' },
    });
    expect(JSON.stringify(paged)).not.toContain('secret-broker-text');
    keptGood();

    const base = broker.requests.length;
    const abort = new AbortController();
    broker.intercept = (_r, n) => {
      if (n === base + 3) abort.abort();
      return undefined;
    };
    expect(await run(abort.signal)).toMatchObject({
      ended: 'failed',
      problem: { code: 'ENGINE_SHUTTING_DOWN' },
    });
    keptGood();

    failAt(1); // the vhost list
    expect((await run()).ended).toBe('failed');
    keptGood();

    broker.intercept = undefined;
    expect((await run()).ended).toBe('complete');
    expect(index?.window(first).version).toMatchObject({ stale: false });
    expect(index?.window(first).version.version).toBeGreaterThan(
      good?.version ?? 0,
    );

    // A first read that dies on the exchanges is partial: the queues show, the index is incomplete.
    const cold = createScriptedBroker({ queueCount: 10, exchangesPerVhost: 1 });
    cold.intercept = (r) =>
      r.path.startsWith('/api/exchanges') ? brokerFailure() : undefined;
    const coldSweeper = createSweeper({ mgmt: cold.read });
    expect(
      (await coldSweeper.sweepNow(cid, new AbortController().signal)).ended,
    ).toBe('partial');
    expect(coldSweeper.index(cid)?.window(first)).toMatchObject({
      total: 10,
      version: { complete: false, stale: true },
    });

    // A failed sweep waits the formula, never less than the 30 s minimum.
    const clock = createManualClock();
    const timers = createManualTimers(clock);
    const flaky = createScriptedBroker({ queueCount: 10 });
    flaky.intercept = () => brokerFailure();
    const auto = createSweeper({ mgmt: flaky.read, clock, timers });
    auto.touch(cid);
    await timers.settle();
    await timers.advance(29_999);
    expect(flaky.requests).toHaveLength(1);
    await timers.advance(1);
    expect(flaky.requests).toHaveLength(2);
    await auto.stop();
  });

  it('M0-48 explorer a warm index takes the queues of a sweep only when every kind was read (one new version per sweep)', async () => {
    const broker = createScriptedBroker({
      queueCount: 3_000,
      vhostCount: 2,
      exchangesPerVhost: 1,
      connectionCount: 4,
    });
    const hidden = new Set<string>();
    const mgmt: MgmtReadPort = {
      async get<T>(request: MgmtGetRequest<T>, signal: AbortSignal) {
        const out = await broker.read.get(request, signal);
        const page = out as { items?: { name: string }[] };
        if (request.path.startsWith('/api/queues/') && page.items) {
          page.items = page.items.filter((item) => !hidden.has(item.name));
        }
        return out;
      },
      stream: (request, signal) => broker.read.stream(request, signal),
    };
    const sweeper = createSweeper({ mgmt });
    const run = () => sweeper.sweepNow(cid, new AbortController().signal);
    expect((await run()).ended).toBe('complete');
    const index = sweeper.index(cid);
    const good = index?.window(first).version.version;

    // The next sweep reads its queues fine (two of them gone) and then a later kind fails.
    hidden.add('queue-000000').add('queue-000001');
    for (const failing of ['/api/exchanges', '/api/connections']) {
      broker.intercept = (r) =>
        r.path.startsWith(failing) ? brokerFailure() : undefined;
      expect((await run()).ended).toBe('failed');
      // Nothing of the sweep is visible: the old version, with all 3,000 queues, marked stale.
      expect(index?.window(first), failing).toMatchObject({
        total: 3_000,
        version: { version: good, complete: true, stale: true },
      });
    }

    broker.intercept = undefined;
    expect((await run()).ended).toBe('complete');
    expect(index?.window(first)).toMatchObject({
      total: 2_998,
      version: { version: (good ?? 0) + 1, stale: false },
    });
  });

  it('M0-48 explorer vhosts past maxVhostsPerSweep are counted and not swept, and the sweep is partial', async () => {
    const broker = createScriptedBroker({
      queueCount: 40,
      vhostCount: 4,
      exchangesPerVhost: 1,
      connectionCount: 5,
    });
    const sweeper = createSweeper({
      mgmt: broker.read,
      limits: { maxVhostsPerSweep: 2 },
    });

    const outcome = await sweeper.sweepNow(cid, new AbortController().signal);

    expect(outcome).toMatchObject({ ended: 'partial', skippedVhosts: 2 });
    expect(outcome.problem).toBeUndefined();
    // Nothing is asked of the two vhosts left out; the connection list spans every vhost.
    expect(broker.requests.map((r) => r.path)).toEqual([
      '/api/vhosts',
      ...broker.vhosts
        .slice(0, 2)
        .map((v) => `/api/queues/${encodeURIComponent(v)}`),
      ...broker.vhosts
        .slice(0, 2)
        .map((v) => `/api/exchanges/${encodeURIComponent(v)}`),
      '/api/connections',
    ]);
    const index = sweeper.index(cid);
    expect(index?.window(first)).toMatchObject({
      total: 20,
      version: { complete: false },
    });
    // The queues are never called whole, and no broker count is offered for a part read.
    expect(index?.queueTotals()).toMatchObject({ queues: 20, complete: false });
    expect(sweeper.status(cid).expected.has('queues')).toBe(false);
    expect(sweeper.status(cid).expected.get('connections')).toBe(5);
  });

  it('M0-48 explorer a key that arrives on two pages of a first read is kept once and the sweep is partial', async () => {
    const broker = createScriptedBroker({ queueCount: 1_200 });
    let last: unknown;
    const mgmt: MgmtReadPort = {
      async get<T>(request: MgmtGetRequest<T>, signal: AbortSignal) {
        const out = await broker.read.get(request, signal);
        const page = out as { items?: unknown[] };
        if (request.path.startsWith('/api/queues/') && page.items) {
          const before = last;
          last = page.items.at(-1);
          // A queue was created while the sweep paged: this page starts with the row that ended the last.
          if (before !== undefined)
            page.items = [before, ...page.items.slice(0, -1)];
        }
        return out;
      },
      stream: (request, signal) => broker.read.stream(request, signal),
    };
    const sweeper = createSweeper({ mgmt });

    const outcome = await sweeper.sweepNow(cid, new AbortController().signal);

    // Pages 2 and 3 are shifted by one: queue-000499 arrives twice, and the last queue of the broker
    // (queue-001199) falls off the end of the read.
    expect(outcome).toMatchObject({ ended: 'partial', duplicates: 1 });
    expect(sweeper.index(cid)?.window(first)).toMatchObject({
      total: 1_199,
      version: { complete: false, duplicates: 1 },
    });
    expect(sweeper.status(cid).expected.get('queues')).toBe(1_200);
  });

  it('M0-48 AC-5 explorer sweeps follow demand, the cost-based cadence and the drain', async () => {
    const broker = createScriptedBroker({ queueCount: 3 });
    const clock = createManualClock();
    const timers = createManualTimers(clock);
    let hang = false;
    // The server time of a sweep, spent on its first request (the vhost list).
    let serverTimeMs = 400;
    const mgmt: MgmtReadPort = {
      get<T>(request: MgmtGetRequest<T>, signal: AbortSignal): Promise<T> {
        if (request.path === '/api/vhosts') clock.advance(serverTimeMs);
        if (!hang) return broker.read.get(request, signal);
        return new Promise<T>((_, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        });
      },
      stream: (request, signal) => broker.read.stream(request, signal),
    };
    const sweeper = createSweeper({ mgmt, clock, timers });
    const sweeps = () =>
      broker.requests.filter((r) => r.path === '/api/vhosts').length;
    const idle = (ms: number) => timers.advance(ms);

    sweeper.touch(cid);
    sweeper.touch(cid); // more demand does not start a second loop
    await timers.settle();
    expect(sweeps()).toBe(1); // at once
    // 0.4 s of server time x 50 = 20 s, under the 30 s minimum: the wait counts from the end.
    await idle(29_999);
    expect(sweeps()).toBe(1);
    await idle(1);
    expect(sweeps()).toBe(2);
    expect(timers.pending()).toBe(1);
    // 4 s x 50 = 200 s.
    serverTimeMs = 4_000;
    await idle(30_000);
    expect(sweeps()).toBe(3);
    await idle(199_999);
    expect(sweeps()).toBe(3);
    await idle(1);
    expect(sweeps()).toBe(4);
    // 20 s x 50 = 1,000 s, held to the 15 minute maximum. A wait that long outlasts the idle stop
    // (10 minutes), so the demand is renewed just before it ends.
    serverTimeMs = 20_000;
    await idle(200_000);
    expect(sweeps()).toBe(5);
    await idle(899_998);
    sweeper.touch(cid);
    await idle(1);
    expect(sweeps()).toBe(5);
    await idle(1);
    expect(sweeps()).toBe(6);
    serverTimeMs = 0;
    await idle(899_999);
    sweeper.touch(cid);
    await idle(1);
    expect(sweeps()).toBe(7);

    // 30 s waits from here; no demand for 10 minutes stops the loop and leaves no timer.
    await idle(570_000);
    expect(sweeps()).toBe(26);
    await idle(29_999);
    expect(timers.pending()).toBe(1);
    await idle(1);
    expect(timers.pending()).toBe(0);
    expect(sweeps()).toBe(26);
    const stoppedAt = sweeps();
    await idle(3_600_000);
    expect(sweeps()).toBe(stoppedAt);
    // A later demand starts it again at once, and one demand is one loop.
    sweeper.touch(cid);
    sweeper.touch(cid);
    await timers.settle();
    expect(sweeps()).toBe(stoppedAt + 1);
    expect(timers.pending()).toBe(1);

    const signal = new AbortController().signal;
    const [a, b] = await Promise.all([
      sweeper.sweepNow(cid, signal),
      sweeper.sweepNow(cid, signal),
    ]);
    expect(a).toBe(b); // the second joined the first
    expect(sweeps()).toBe(stoppedAt + 2);

    hang = true;
    const running = sweeper.sweepNow(cid, signal);
    await timers.settle();
    await sweeper.stop();
    expect(await running).toMatchObject({
      ended: 'failed',
      problem: { code: 'ENGINE_SHUTTING_DOWN' },
    });
    expect(timers.pending()).toBe(0);
  });
});
