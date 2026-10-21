import { ConnectionIdSchema } from '@app/contracts';
import { createManualClock, createManualTimers } from '@app/kernel';
import type { MgmtGetRequest, MgmtReadPort } from '@app/ports';
import { describe, expect, it } from 'vitest';

import { brokerFailure, createScriptedBroker } from '../testing';

import { createSweeper } from './sweeper';

const cid = ConnectionIdSchema.parse('c1');
const first = { kind: 'queues', offset: 0, limit: 1 } as const;

describe('explorer sweeper', () => {
  it('AC-3 explorer sweep of 20k queues is paged at 500 with stats-off flags in the background lane', async () => {
    const broker = createScriptedBroker({ queueCount: 20_000, vhostCount: 4 });
    const sweeper = createSweeper({ mgmt: broker.read });

    const outcome = await sweeper.sweepNow(cid, new AbortController().signal);

    const lists = broker.requests.filter((r) =>
      r.path.startsWith('/api/queues/'),
    );
    const others = broker.requests.filter((r) => !lists.includes(r));
    expect(outcome).toMatchObject({ ended: 'complete', requests: 45 });
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
    // The vhost list is asked once and unpaged; the rest are 4 exchange lists, all paged.
    expect(others.map((r) => r.path)).toEqual([
      '/api/vhosts',
      ...broker.vhosts.map((v) => `/api/exchanges/${encodeURIComponent(v)}`),
    ]);
    expect(others[0]?.query).toEqual({});
    expect(others.slice(1).every((r) => r.query.page === 1)).toBe(true);
    expect(
      new Set(broker.requests.map((r) => r.path + JSON.stringify(r.query)))
        .size,
    ).toBe(45);
    expect(sweeper.index(cid)?.window(first).total).toBe(20_000);
  });

  it('AC-4 explorer failed or partial sweep keeps the last good index and says stale', async () => {
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

    // The next sweep waits the fixed interval, not less.
    const clock = createManualClock();
    const timers = createManualTimers(clock);
    const flaky = createScriptedBroker({ queueCount: 10 });
    flaky.intercept = () => brokerFailure();
    const auto = createSweeper({ mgmt: flaky.read, clock, timers });
    auto.touch(cid);
    await timers.settle();
    await timers.advance(59_999);
    expect(flaky.requests).toHaveLength(1);
    await timers.advance(1);
    expect(flaky.requests).toHaveLength(2);
    await auto.stop();
  });

  it('AC-5 explorer sweeps follow demand, a fixed interval and the drain', async () => {
    const broker = createScriptedBroker({ queueCount: 3 });
    const clock = createManualClock();
    const timers = createManualTimers(clock);
    let hang = false;
    const mgmt: MgmtReadPort = {
      get<T>(request: MgmtGetRequest<T>, signal: AbortSignal): Promise<T> {
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
    await idle(59_999);
    expect(sweeps()).toBe(1);
    await idle(1); // a fixed 60 s, not the cost-based cadence (the named cut)
    expect(sweeps()).toBe(2);
    expect(timers.pending()).toBe(1);
    const signal = new AbortController().signal;
    const [a, b] = await Promise.all([
      sweeper.sweepNow(cid, signal),
      sweeper.sweepNow(cid, signal),
    ]);
    expect(a).toBe(b); // the second joined the first
    expect(sweeps()).toBe(3);

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
