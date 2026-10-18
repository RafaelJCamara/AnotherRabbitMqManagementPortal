import { ConnectionIdSchema, type ConnectionId } from '@app/contracts';
import type {
  Lane,
  MgmtGetRequest,
  MgmtReadPort,
  MgmtSendRequest,
  MgmtWritePort,
  PromScrapePort,
} from '@app/ports';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createManualClock } from '../clock/clock.ts';
import { AppError } from '../problem/problem.ts';
import {
  BrokerScheduler,
  isOverloadError,
  type BrokerSchedulerOptions,
} from './broker-scheduler.ts';
import {
  scheduleMgmtRead,
  scheduleMgmtWrite,
  schedulePromScrape,
} from './scheduled-ports.ts';
import { createManualTimers } from './timers.ts';

const A = ConnectionIdSchema.parse('broker-a');
const B = ConnectionIdSchema.parse('broker-b');
const C = ConnectionIdSchema.parse('broker-c');

function setup(options: BrokerSchedulerOptions = {}) {
  const clock = createManualClock();
  const timers = createManualTimers(clock);
  const scheduler = new BrokerScheduler({ clock, timers, ...options });
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      timers.setTimer(resolve, ms);
    });
  /** Moves time until the promise settles, and reports how it settled. */
  async function finish<T>(
    promise: Promise<T>,
  ): Promise<PromiseSettledResult<T>> {
    let result: PromiseSettledResult<T> | undefined;
    void promise.then(
      (value) => {
        result = { status: 'fulfilled', value };
      },
      (reason: unknown) => {
        result = { status: 'rejected', reason };
      },
    );
    for (let i = 0; i < 20_000 && result === undefined; i++) {
      await timers.advance(100);
    }
    if (result === undefined) throw new Error('The promise never settled.');
    return result;
  }
  const stats = (id: ConnectionId) => {
    const found = scheduler
      .snapshot()
      .brokers.find((b) => b.connectionId === id);
    if (!found) throw new Error(`No stats for ${id}`);
    return found;
  };
  return { clock, timers, scheduler, sleep, finish, stats };
}

function at<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) throw new RangeError(`No item at ${String(index)}.`);
  return item;
}

const overload503 = () =>
  new AppError('BROKER_ERROR', { broker: { protocol: 'http', code: 503 } });
const notFound404 = () =>
  new AppError('NOT_FOUND', { broker: { protocol: 'http', code: 404 } });

describe('scheduler: lanes', () => {
  it('AC-1 runs the interactive request first and keeps at most one background request in flight', async () => {
    const { scheduler, timers, sleep } = setup();
    const started: string[] = [];
    let backgroundNow = 0;
    let backgroundMax = 0;

    const background = Array.from({ length: 10 }, (_, i) =>
      scheduler.run({ connectionId: A, lane: 'background' }, async () => {
        started.push(`background-${String(i)}`);
        backgroundNow += 1;
        backgroundMax = Math.max(backgroundMax, backgroundNow);
        await sleep(30);
        backgroundNow -= 1;
      }),
    );
    const interactive = scheduler.run(
      { connectionId: A, lane: 'interactive' },
      async () => {
        started.push('interactive');
        await sleep(30);
      },
    );

    await timers.advance(0);
    expect(started[0]).toBe('interactive');
    expect(started.filter((s) => s.startsWith('background'))).toHaveLength(1);

    for (let i = 0; i < 400; i++) await timers.advance(50);
    await Promise.all([interactive, ...background]);

    expect(started).toEqual([
      'interactive',
      ...Array.from({ length: 10 }, (_, i) => `background-${String(i)}`),
    ]);
    expect(backgroundMax).toBe(1);
  });

  it('scheduler: an interactive request does not wait for a background request already in flight', async () => {
    const { scheduler, timers, sleep } = setup();
    const started: string[] = [];
    const slow = scheduler.run(
      { connectionId: A, lane: 'background' },
      async () => {
        started.push('background');
        await sleep(1000);
      },
    );
    await timers.advance(10);
    const quick = scheduler.run(
      { connectionId: A, lane: 'interactive' },
      () => {
        started.push('interactive');
        return Promise.resolve('done');
      },
    );
    await timers.advance(10);
    expect(started).toEqual(['background', 'interactive']);
    await timers.advance(2000);
    await expect(quick).resolves.toBe('done');
    await slow;
  });

  it('scheduler: orders live before background and interactive before both, one broker at a time', async () => {
    const { scheduler, timers, sleep } = setup({
      laneConcurrency: { interactive: 1, live: 1 },
      maxInFlight: 1,
    });
    const started: string[] = [];
    const task = (name: string) => async () => {
      started.push(name);
      await sleep(10);
    };
    const all = [
      scheduler.run({ connectionId: A, lane: 'background' }, task('b1')),
      scheduler.run({ connectionId: A, lane: 'live' }, task('l1')),
      scheduler.run({ connectionId: A, lane: 'interactive' }, task('i1')),
      scheduler.run({ connectionId: A, lane: 'live' }, task('l2')),
      scheduler.run({ connectionId: A, lane: 'interactive' }, task('i2')),
      scheduler.run({ connectionId: A, lane: 'background' }, task('b2')),
    ];
    for (let i = 0; i < 100; i++) await timers.advance(50);
    await Promise.all(all);
    expect(started).toEqual(['i1', 'i2', 'l1', 'l2', 'b1', 'b2']);
  });

  it('scheduler: brokers do not share lanes, so a busy broker does not delay another', async () => {
    const { scheduler, timers, sleep } = setup();
    const started: string[] = [];
    const first = scheduler.run(
      { connectionId: A, lane: 'background' },
      async () => {
        started.push('a');
        await sleep(5000);
      },
    );
    const second = scheduler.run(
      { connectionId: B, lane: 'background' },
      async () => {
        started.push('b');
        await sleep(5000);
      },
    );
    await timers.advance(1);
    expect(started).toEqual(['a', 'b']);
    await timers.advance(6000);
    await Promise.all([first, second]);
  });

  it('scheduler: a global background cap holds the background work of other brokers', async () => {
    const { scheduler, timers, sleep } = setup({ globalBackgroundCap: 1 });
    const started: string[] = [];
    let now = 0;
    let peak = 0;
    const work = (name: string, id: ConnectionId) =>
      scheduler.run({ connectionId: id, lane: 'background' }, async () => {
        started.push(name);
        now += 1;
        peak = Math.max(peak, now);
        await sleep(100);
        now -= 1;
      });
    const all = [work('a', A), work('b', B), work('c', C)];
    for (let i = 0; i < 100; i++) await timers.advance(100);
    await Promise.all(all);
    expect(peak).toBe(1);
    expect([...started].sort()).toEqual(['a', 'b', 'c']);
  });

  it('scheduler: an interactive request on a saturated broker waits, and the others keep their caps', async () => {
    const { scheduler, timers, sleep } = setup({
      laneConcurrency: { interactive: 2, live: 1 },
    });
    let now = 0;
    let peak = 0;
    const all = Array.from({ length: 6 }, () =>
      scheduler.run({ connectionId: A, lane: 'interactive' }, async () => {
        now += 1;
        peak = Math.max(peak, now);
        await sleep(20);
        now -= 1;
      }),
    );
    for (let i = 0; i < 20; i++) await timers.advance(20);
    await Promise.all(all);
    expect(peak).toBe(2);
  });
});

describe('scheduler: model test (properties)', () => {
  const lanes: Lane[] = ['interactive', 'live', 'background'];
  const op = fc.record({
    broker: fc.integer({ min: 0, max: 2 }),
    lane: fc.constantFrom(...lanes),
    at: fc.integer({ min: 0, max: 300 }),
    duration: fc.integer({ min: 0, max: 120 }),
    outcome: fc.constantFrom('ok', 'ok', 'ok', 'overload', 'other'),
  });

  it('never exceeds a lane, broker or global cap, never lets a lower lane jump a runnable higher one, and finishes every request', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(op, { minLength: 1, maxLength: 30 }),
        async (ops) => {
          const caps = { interactive: 3, live: 2, background: 1 } as const;
          const maxInFlight = 4;
          const globalBackgroundCap = 2;
          const { scheduler, timers, sleep } = setup({
            laneConcurrency: { interactive: 3, live: 2 },
            maxInFlight,
            globalBackgroundCap,
            aimd: { baseIntervalMs: 20, maxIntervalMs: 200 },
          });
          const ids = [A, B, C];
          const perBroker = new Map<
            ConnectionId,
            { interactive: number; live: number; background: number }
          >();
          let globalBackground = 0;
          const violations: string[] = [];

          const submit = (index: number) => {
            const spec = at(ops, index);
            const id = at(ids, spec.broker);
            return scheduler.run(
              { connectionId: id, lane: spec.lane },
              async () => {
                const counts = perBroker.get(id) ?? {
                  interactive: 0,
                  live: 0,
                  background: 0,
                };
                perBroker.set(id, counts);
                counts[spec.lane] += 1;
                if (spec.lane === 'background') globalBackground += 1;
                const total =
                  counts.interactive + counts.live + counts.background;
                if (counts[spec.lane] > caps[spec.lane])
                  violations.push('lane cap');
                if (total > maxInFlight) violations.push('broker cap');
                if (globalBackground > globalBackgroundCap)
                  violations.push('global cap');

                // Priority: no higher lane may be runnable (queued, below its cap, room left).
                const snapshot = scheduler
                  .snapshot()
                  .brokers.find((b) => b.connectionId === id);
                for (const higher of lanes.slice(0, lanes.indexOf(spec.lane))) {
                  const queued = snapshot?.queued[higher] ?? 0;
                  const room = (snapshot?.inFlight[higher] ?? 0) < caps[higher];
                  if (queued > 0 && room) {
                    violations.push(`${spec.lane} jumped a runnable ${higher}`);
                  }
                }

                await sleep(spec.duration);
                counts[spec.lane] -= 1;
                if (spec.lane === 'background') globalBackground -= 1;
                if (spec.outcome === 'overload') throw overload503();
                if (spec.outcome === 'other') throw notFound404();
                return index;
              },
            );
          };

          const results: Promise<PromiseSettledResult<number>>[] = [];
          const order = ops
            .map((spec, index) => ({ at: spec.at, index }))
            .sort((x, y) => x.at - y.at || x.index - y.index);
          let elapsed = 0;
          for (const { at, index } of order) {
            await timers.advance(at - elapsed);
            elapsed = at;
            results.push(
              submit(index).then(
                (value): PromiseSettledResult<number> => ({
                  status: 'fulfilled',
                  value,
                }),
                (reason: unknown): PromiseSettledResult<number> => ({
                  status: 'rejected',
                  reason,
                }),
              ),
            );
          }
          const settled = Promise.all(results);
          const progress = { done: false };
          void settled.then(() => {
            progress.done = true;
          });
          for (let i = 0; i < 100_000 && !progress.done; i++) {
            await timers.advance(250);
          }

          expect(progress.done).toBe(true);
          expect(violations).toEqual([]);
          const final = await settled;
          final.forEach((result, position) => {
            const { index } = at(order, position);
            const spec = at(ops, index);
            if (spec.outcome === 'ok') {
              expect(result).toEqual({ status: 'fulfilled', value: index });
            } else {
              expect(result.status).toBe('rejected');
            }
          });
          const left = scheduler.snapshot();
          expect(left.backgroundInFlight).toBe(0);
          for (const broker of left.brokers) {
            expect(broker.queued).toEqual({
              interactive: 0,
              live: 0,
              background: 0,
            });
            expect(broker.inFlight).toEqual({
              interactive: 0,
              live: 0,
              background: 0,
            });
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('scheduler: AIMD backoff', () => {
  const failing = () => Promise.reject(overload503());
  const ok = () => Promise.resolve('ok');

  it('AC-2 doubles the background interval after three consecutive 503s', async () => {
    const { scheduler, finish, stats } = setup();
    const background = { connectionId: A, lane: 'background' } as const;

    await finish(scheduler.run(background, failing).catch(() => undefined));
    await finish(scheduler.run(background, failing).catch(() => undefined));
    expect(stats(A).backgroundIntervalMs).toBe(200);
    expect(stats(A).consecutiveFailures).toBe(2);

    await finish(scheduler.run(background, failing).catch(() => undefined));
    expect(stats(A).backgroundIntervalMs).toBe(400);
    expect(stats(A).consecutiveFailures).toBe(0);
  });

  it('scheduler: waits the new interval before the next background request', async () => {
    const { scheduler, timers, clock, finish } = setup();
    const background = { connectionId: A, lane: 'background' } as const;
    for (let i = 0; i < 3; i++) {
      await finish(scheduler.run(background, failing).catch(() => undefined));
    }
    const failedAt = clock.monotonic();
    let startedAt = -1;
    const next = scheduler.run(background, () => {
      startedAt = clock.monotonic();
      return Promise.resolve('next');
    });
    await timers.advance(399);
    expect(startedAt).toBe(-1);
    await timers.advance(2);
    expect(startedAt).toBeGreaterThanOrEqual(failedAt + 400);
    expect(await next).toBe('next');
  });

  it('scheduler: keeps multiplying while the broker stays overloaded, up to the maximum', async () => {
    const { scheduler, finish, stats } = setup({
      aimd: { maxIntervalMs: 1000 },
    });
    const background = { connectionId: A, lane: 'background' } as const;
    const seen: number[] = [];
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 3; i++) {
        await finish(scheduler.run(background, failing).catch(() => undefined));
      }
      seen.push(stats(A).backgroundIntervalMs);
    }
    expect(seen).toEqual([400, 800, 1000, 1000, 1000]);
  });

  it('scheduler: recovers additively on healthy answers, down to the base interval', async () => {
    const { scheduler, finish, stats } = setup();
    const background = { connectionId: A, lane: 'background' } as const;
    for (let i = 0; i < 3; i++) {
      await finish(scheduler.run(background, failing).catch(() => undefined));
    }
    expect(stats(A).backgroundIntervalMs).toBe(400);
    await finish(scheduler.run(background, ok));
    expect(stats(A).backgroundIntervalMs).toBe(350);
    for (let i = 0; i < 6; i++) await finish(scheduler.run(background, ok));
    expect(stats(A).backgroundIntervalMs).toBe(200);
  });

  it('scheduler: a healthy answer resets the run of consecutive failures', async () => {
    const { scheduler, finish, stats } = setup();
    const background = { connectionId: A, lane: 'background' } as const;
    await finish(scheduler.run(background, failing).catch(() => undefined));
    await finish(scheduler.run(background, failing).catch(() => undefined));
    await finish(scheduler.run(background, ok));
    await finish(scheduler.run(background, failing).catch(() => undefined));
    await finish(scheduler.run(background, failing).catch(() => undefined));
    expect(stats(A).backgroundIntervalMs).toBe(200);
  });

  it('scheduler: a 404 or a bug says nothing about load, a 429 and a 500 do', async () => {
    const { scheduler, finish, stats } = setup();
    const background = { connectionId: A, lane: 'background' } as const;
    for (let i = 0; i < 6; i++) {
      await finish(
        scheduler
          .run(background, () => Promise.reject(notFound404()))
          .catch(() => undefined),
      );
    }
    for (let i = 0; i < 3; i++) {
      await finish(
        scheduler
          .run(background, () => Promise.reject(new Error('bug')))
          .catch(() => undefined),
      );
    }
    expect(stats(A).backgroundIntervalMs).toBe(200);

    const tooMany = () =>
      Promise.reject(
        new AppError('RATE_LIMITED', {
          broker: { protocol: 'http', code: 429 },
        }),
      );
    for (let i = 0; i < 3; i++) {
      await finish(scheduler.run(background, tooMany).catch(() => undefined));
    }
    expect(stats(A).backgroundIntervalMs).toBe(400);
  });

  it('scheduler: failures of interactive requests also push the background interval up', async () => {
    const { scheduler, finish, stats } = setup();
    for (let i = 0; i < 3; i++) {
      await finish(
        scheduler
          .run({ connectionId: A, lane: 'interactive' }, failing)
          .catch(() => undefined),
      );
    }
    expect(stats(A).backgroundIntervalMs).toBe(400);
  });

  it('scheduler: a request nobody waits for any more is not counted against the broker', async () => {
    const { scheduler, timers, stats, sleep } = setup();
    for (let i = 0; i < 3; i++) {
      const controller = new AbortController();
      const run = scheduler
        .run(
          { connectionId: A, lane: 'background', signal: controller.signal },
          async (signal) => {
            await sleep(10);
            if (signal.aborted) throw overload503();
            return 1;
          },
        )
        .catch(() => undefined);
      await timers.advance(1);
      controller.abort();
      await timers.advance(300);
      await run;
    }
    expect(stats(A).backgroundIntervalMs).toBe(200);
    expect(stats(A).consecutiveFailures).toBe(0);
  });

  it('scheduler: a p50 latency above twice the baseline counts as overload', async () => {
    const { scheduler, clock, timers, finish, stats } = setup({
      aimd: { latencyWindow: 4, latencyMinSamples: 4 },
    });
    const background = { connectionId: A, lane: 'background' } as const;
    const timed = (ms: number) => async () => {
      await new Promise<void>((resolve) => {
        timers.setTimer(resolve, ms);
      });
      return clock.monotonic();
    };
    for (let i = 0; i < 4; i++)
      await finish(scheduler.run(background, timed(10)));
    expect(stats(A).baselineMs).toBe(10);
    expect(stats(A).backgroundIntervalMs).toBe(200);

    for (let i = 0; i < 4; i++)
      await finish(scheduler.run(background, timed(100)));
    // The window is [10, 10, 100, 100]: p50 55 > 20, then 100, 100 and 100: three signals.
    expect(stats(A).p50Ms).toBe(100);
    expect(stats(A).backgroundIntervalMs).toBe(400);
  });
});

describe('scheduler: single-flight and the detail cache', () => {
  const schema = z.object({ name: z.string() });

  function fakeRead(
    delayMs: number,
    timers: { setTimer: (cb: () => void, ms: number) => () => void },
  ) {
    const calls: string[] = [];
    const port: MgmtReadPort = {
      async get<T>(request: MgmtGetRequest<T>) {
        calls.push(`${request.path}?${JSON.stringify(request.query ?? {})}`);
        await new Promise<void>((resolve) => {
          timers.setTimer(resolve, delayMs);
        });
        return request.schema.parse({ name: request.path });
      },
      stream: () => Promise.reject(new Error('not used')),
    };
    return { calls, port };
  }
  const request = (path: string, lane: Lane = 'interactive') => ({
    connectionId: A,
    path,
    schema,
    lane,
  });

  it('AC-2 makes one HTTP call for two identical detail GETs within 2 s', async () => {
    const { scheduler, timers, finish, stats } = setup();
    const { calls, port } = fakeRead(50, timers);
    const read = scheduleMgmtRead(port, scheduler);
    const signal = new AbortController().signal;

    // At the same moment: single-flight.
    const both = Promise.all([
      read.get(request('/api/queues/%2F/orders'), signal),
      read.get(request('/api/queues/%2F/orders'), signal),
    ]);
    const [first, second] = await finish(both).then((r) =>
      r.status === 'fulfilled' ? r.value : [],
    );
    expect(first).toEqual({ name: '/api/queues/%2F/orders' });
    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);

    // 1.5 s later: served from the cache.
    await timers.advance(1500);
    await finish(read.get(request('/api/queues/%2F/orders'), signal));
    expect(calls).toHaveLength(1);
    expect(stats(A).cacheHits).toBe(1);
    expect(stats(A).singleFlightJoins).toBe(1);

    // Past 2 s from the answer: a new call.
    await timers.advance(600);
    await finish(read.get(request('/api/queues/%2F/orders'), signal));
    expect(calls).toHaveLength(2);
  });

  it('scheduler: a different path, query, broker, lane-independent schema or method is not the same request', async () => {
    const { scheduler, timers, finish } = setup();
    const { calls, port } = fakeRead(10, timers);
    const read = scheduleMgmtRead(port, scheduler);
    const signal = new AbortController().signal;
    const otherSchema = z.object({ name: z.string() });

    await finish(
      Promise.all([
        read.get(request('/api/a'), signal),
        read.get(request('/api/b'), signal),
        read.get({ ...request('/api/a'), query: { page: 2 } }, signal),
        read.get({ ...request('/api/a'), connectionId: B }, signal),
        read.get({ ...request('/api/a'), schema: otherSchema }, signal),
      ]),
    );
    expect(calls).toHaveLength(5);
  });

  it('scheduler: the order of query parameters does not matter', async () => {
    const { scheduler, timers, finish } = setup();
    const { calls, port } = fakeRead(10, timers);
    const read = scheduleMgmtRead(port, scheduler);
    const signal = new AbortController().signal;
    await finish(
      Promise.all([
        read.get(
          { ...request('/api/a'), query: { page: 1, name: 'x' } },
          signal,
        ),
        read.get(
          { ...request('/api/a'), query: { name: 'x', page: 1 } },
          signal,
        ),
      ]),
    );
    expect(calls).toHaveLength(1);
  });

  it('scheduler: a failure is not cached, and every waiter of the shared call sees it', async () => {
    const { scheduler, timers, finish } = setup();
    let attempts = 0;
    const port: MgmtReadPort = {
      get<T>(r: MgmtGetRequest<T>) {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(overload503())
          : Promise.resolve(r.schema.parse({ name: 'ok' }));
      },
      stream: () => Promise.reject(new Error('not used')),
    };
    const read = scheduleMgmtRead(port, scheduler);
    const signal = new AbortController().signal;
    const both = await finish(
      Promise.allSettled([
        read.get(request('/api/x'), signal),
        read.get(request('/api/x'), signal),
      ]),
    );
    expect(both.status).toBe('fulfilled');
    if (both.status === 'fulfilled') {
      expect(both.value.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    }
    expect(attempts).toBe(1);

    await timers.advance(1);
    const retry = await finish(read.get(request('/api/x'), signal));
    expect(retry.status).toBe('fulfilled');
    expect(attempts).toBe(2);
  });

  it('scheduler: an interactive caller promotes a queued background request it shares', async () => {
    const { scheduler, timers, sleep, finish } = setup({ detailCacheMs: 0 });
    const order: string[] = [];
    const blocker = scheduler.run(
      { connectionId: A, lane: 'background' },
      async () => {
        order.push('blocker');
        await sleep(500);
      },
    );
    await timers.advance(1);
    const task = (name: string) => () => {
      order.push(name);
      return Promise.resolve(name);
    };
    const backgroundCopy = scheduler.run(
      { connectionId: A, lane: 'background', dedupeKey: 'shared' },
      task('shared'),
    );
    const otherBackground = scheduler.run(
      { connectionId: A, lane: 'background' },
      task('other'),
    );
    const interactiveCopy = scheduler.run(
      { connectionId: A, lane: 'interactive', dedupeKey: 'shared' },
      task('never-runs-twice'),
    );
    await finish(
      Promise.all([blocker, backgroundCopy, otherBackground, interactiveCopy]),
    );
    // The shared request ran at once in the interactive lane, ahead of the queued background one.
    expect(order).toEqual(['blocker', 'shared', 'other']);
  });

  it('scheduler: keeps at most cacheMaxEntries results', async () => {
    const { scheduler, timers, finish, stats } = setup({ cacheMaxEntries: 3 });
    const { port } = fakeRead(1, timers);
    const read = scheduleMgmtRead(port, scheduler);
    const signal = new AbortController().signal;
    for (let i = 0; i < 10; i++) {
      await finish(read.get(request(`/api/${String(i)}`), signal));
    }
    expect(scheduler.snapshot().cacheEntries).toBeLessThanOrEqual(3);
    expect(stats(A).cacheHits).toBe(0);
  });

  it('scheduler: a new caller never inherits the cancellation of a run everybody gave up on', async () => {
    const { scheduler, timers, sleep, finish } = setup();
    let runs = 0;
    const task = async (signal: AbortSignal) => {
      runs += 1;
      await sleep(100);
      if (signal.aborted) throw new Error('cancelled');
      return runs;
    };
    const controller = new AbortController();
    const abandoned = scheduler
      .run(
        {
          connectionId: A,
          lane: 'interactive',
          dedupeKey: 'k',
          signal: controller.signal,
        },
        task,
      )
      .catch(() => undefined);
    await timers.advance(10);
    controller.abort();
    await abandoned;

    // The first run is still on the wire, but nobody wants it. A new caller gets its own run.
    const fresh = await finish(
      scheduler.run(
        { connectionId: A, lane: 'interactive', dedupeKey: 'k' },
        task,
      ),
    );
    expect(fresh).toEqual({ status: 'fulfilled', value: 2 });
    expect(runs).toBe(2);
  });

  it('scheduler: a request without a key runs every time and a zero cache keeps nothing', async () => {
    const { scheduler, finish } = setup({ detailCacheMs: 0 });
    let runs = 0;
    const task = () => {
      runs += 1;
      return Promise.resolve(runs);
    };
    await finish(scheduler.run({ connectionId: A, lane: 'interactive' }, task));
    await finish(scheduler.run({ connectionId: A, lane: 'interactive' }, task));
    await finish(
      scheduler.run(
        { connectionId: A, lane: 'interactive', dedupeKey: 'k' },
        task,
      ),
    );
    await finish(
      scheduler.run(
        { connectionId: A, lane: 'interactive', dedupeKey: 'k' },
        task,
      ),
    );
    expect(runs).toBe(4);
  });
});

describe('scheduler: cancellation, limits and shutdown', () => {
  it('scheduler: a queued request that is aborted never runs and frees its place', async () => {
    const { scheduler, timers, sleep, stats } = setup();
    const blocker = scheduler.run({ connectionId: A, lane: 'background' }, () =>
      sleep(500),
    );
    await timers.advance(1);
    let ran = false;
    const controller = new AbortController();
    const waiting = scheduler.run(
      { connectionId: A, lane: 'background', signal: controller.signal },
      () => {
        ran = true;
        return Promise.resolve();
      },
    );
    expect(stats(A).queued.background).toBe(1);
    controller.abort(new Error('user cancelled'));
    await expect(waiting).rejects.toThrow('user cancelled');
    expect(stats(A).queued.background).toBe(0);
    await timers.advance(2000);
    await blocker;
    expect(ran).toBe(false);
  });

  it('scheduler: an already aborted signal is refused at once without queueing', async () => {
    const { scheduler, stats } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      scheduler.run(
        { connectionId: A, lane: 'live', signal: controller.signal },
        () => Promise.resolve(1),
      ),
    ).rejects.toThrow();
    expect(scheduler.snapshot().brokers).toHaveLength(0);
    expect(() => stats(A)).toThrow();
  });

  it('scheduler: aborting one of two callers of a shared request leaves the other its result', async () => {
    const { scheduler, timers, sleep, finish } = setup();
    let taskSignal: AbortSignal | undefined;
    const task = async (signal: AbortSignal) => {
      taskSignal = signal;
      await sleep(100);
      return 'shared-result';
    };
    const first = new AbortController();
    const one = scheduler.run(
      {
        connectionId: A,
        lane: 'interactive',
        dedupeKey: 'k',
        signal: first.signal,
      },
      task,
    );
    const two = scheduler.run(
      { connectionId: A, lane: 'interactive', dedupeKey: 'k' },
      task,
    );
    await timers.advance(10);
    first.abort();
    await expect(one).rejects.toThrow();
    expect(taskSignal?.aborted).toBe(false);
    const result = await finish(two);
    expect(result).toEqual({ status: 'fulfilled', value: 'shared-result' });
  });

  it('scheduler: when every caller of a running request gives up, its task is told to stop', async () => {
    const { scheduler, timers, sleep } = setup();
    let taskSignal: AbortSignal | undefined;
    const controller = new AbortController();
    const run = scheduler
      .run(
        { connectionId: A, lane: 'interactive', signal: controller.signal },
        async (signal) => {
          taskSignal = signal;
          await sleep(1000);
        },
      )
      .catch(() => undefined);
    await timers.advance(10);
    controller.abort();
    expect(taskSignal?.aborted).toBe(true);
    await timers.advance(2000);
    await run;
  });

  it('scheduler: refuses a request when its lane is full, counts it and reports it (I-6, I-13)', async () => {
    const drops: { lane: Lane; reason: string; items: number }[] = [];
    const { scheduler, timers, sleep, stats } = setup({
      queueLimit: { background: 2 },
      onDrop: (event) => drops.push(event),
    });
    const running = scheduler.run({ connectionId: A, lane: 'background' }, () =>
      sleep(300),
    );
    await timers.advance(1);
    const queued = [
      scheduler.run({ connectionId: A, lane: 'background' }, () =>
        Promise.resolve(1),
      ),
      scheduler.run({ connectionId: A, lane: 'background' }, () =>
        Promise.resolve(2),
      ),
    ];
    const refused = scheduler.run({ connectionId: A, lane: 'background' }, () =>
      Promise.resolve(3),
    );
    await expect(refused).rejects.toMatchObject({
      code: 'BUDGET_EXCEEDED',
      retryable: true,
    });
    expect(stats(A).dropped.background).toBe(1);
    expect(drops).toEqual([
      expect.objectContaining({
        lane: 'background',
        reason: 'full',
        items: 1,
      }) as unknown,
    ]);
    await timers.advance(5000);
    await Promise.all([running, ...queued]);
  });

  it('scheduler: cancelled requests do not use up queue capacity', async () => {
    const drops: unknown[] = [];
    const { scheduler, timers, sleep, stats } = setup({
      queueLimit: { background: 2 },
      onDrop: (event) => drops.push(event),
    });
    const running = scheduler.run({ connectionId: A, lane: 'background' }, () =>
      sleep(300),
    );
    await timers.advance(1);
    for (let round = 0; round < 5; round++) {
      const controllers = [new AbortController(), new AbortController()];
      const waiting = controllers.map((c) =>
        scheduler
          .run({ connectionId: A, lane: 'background', signal: c.signal }, () =>
            Promise.resolve(),
          )
          .catch(() => undefined),
      );
      controllers.forEach((c) => {
        c.abort();
      });
      await Promise.all(waiting);
    }
    const accepted = scheduler.run(
      { connectionId: A, lane: 'background' },
      () => Promise.resolve('accepted'),
    );
    await timers.advance(5000);
    await expect(accepted).resolves.toBe('accepted');
    await running;
    // Making room by dropping dead entries is not a drop: nobody lost a request.
    expect(drops).toEqual([]);
    expect(stats(A).dropped.background).toBe(0);
  });

  it('scheduler: close() rejects queued work, aborts running work and refuses new work', async () => {
    const { scheduler, timers, sleep } = setup();
    let taskSignal: AbortSignal | undefined;
    const running = scheduler
      .run({ connectionId: A, lane: 'interactive' }, async (signal) => {
        taskSignal = signal;
        await sleep(1000);
      })
      .catch((error: unknown) => error);
    const blocker = scheduler.run({ connectionId: A, lane: 'background' }, () =>
      sleep(1000),
    );
    const queued = scheduler.run({ connectionId: A, lane: 'background' }, () =>
      Promise.resolve(),
    );
    const queuedResult = queued.catch((error: unknown) => error);
    void blocker.catch(() => undefined);
    await timers.advance(10);

    scheduler.close();
    expect(taskSignal?.aborted).toBe(true);
    expect(await queuedResult).toMatchObject({ code: 'ENGINE_SHUTTING_DOWN' });
    await expect(
      scheduler.run({ connectionId: A, lane: 'interactive' }, () =>
        Promise.resolve(),
      ),
    ).rejects.toMatchObject({ code: 'ENGINE_SHUTTING_DOWN' });
    await timers.advance(2000);
    await running;
  });

  it('scheduler: refuses nonsense options', () => {
    expect(() => new BrokerScheduler({ maxInFlight: 0 })).toThrow(RangeError);
    expect(
      () => new BrokerScheduler({ laneConcurrency: { interactive: -1 } }),
    ).toThrow(RangeError);
    expect(() => new BrokerScheduler({ aimd: { backoffFactor: 1 } })).toThrow(
      RangeError,
    );
    expect(
      () =>
        new BrokerScheduler({
          aimd: { baseIntervalMs: 500, maxIntervalMs: 100 },
        }),
    ).toThrow(RangeError);
    expect(() => new BrokerScheduler({ queueLimit: { live: 0 } })).toThrow(
      RangeError,
    );
    expect(() => new BrokerScheduler({ detailCacheMs: -1 })).toThrow(
      RangeError,
    );
  });

  it('scheduler: a task that throws before returning a promise is a rejection, not a crash', async () => {
    const { scheduler, finish } = setup();
    const result = await finish(
      scheduler.run(
        { connectionId: A, lane: 'interactive' },
        (): Promise<never> => {
          throw new Error('sync failure');
        },
      ),
    );
    expect(result).toMatchObject({ status: 'rejected' });
  });

  it('scheduler: a task that rejects with a bare value still rejects with an Error that keeps the value', async () => {
    const { scheduler, finish } = setup();
    // Code written in plain JavaScript can reject with anything; the cast is the test input.
    const bare: unknown = { code: 'NOT_AN_ERROR' };
    const result = await finish(
      scheduler.run({ connectionId: A, lane: 'interactive' }, () =>
        Promise.reject(bare as Error),
      ),
    );
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.reason).toBeInstanceOf(Error);
      expect((result.reason as Error).cause).toEqual({ code: 'NOT_AN_ERROR' });
    }
  });
});

describe('scheduler: scheduled ports', () => {
  const sendSchema = z.object({ ok: z.boolean() });

  it('scheduler: writes run in the interactive lane, are never cached and carry the caller abort', async () => {
    const { scheduler, timers, finish, stats } = setup();
    const seen: string[] = [];
    const inner: MgmtWritePort = {
      send<T>(r: MgmtSendRequest<T>) {
        seen.push(`${r.method} ${r.path}`);
        return Promise.resolve(r.schema.parse({ ok: true }));
      },
    };
    const write = scheduleMgmtWrite(inner, scheduler);
    const signal = new AbortController().signal;
    const send = () =>
      write.send(
        {
          connectionId: A,
          method: 'PUT',
          path: '/api/queues/%2F/q',
          schema: sendSchema,
        },
        signal,
      );
    await finish(send());
    await finish(send());
    expect(seen).toEqual(['PUT /api/queues/%2F/q', 'PUT /api/queues/%2F/q']);
    expect(stats(A).cacheHits).toBe(0);
    expect(stats(A).inFlight).toEqual({
      interactive: 0,
      live: 0,
      background: 0,
    });
    await timers.advance(1);
  });

  it('scheduler: a background write option moves writes to the chosen lane', async () => {
    const { scheduler, timers, sleep, finish } = setup();
    const order: string[] = [];
    const inner: MgmtWritePort = {
      async send<T>(r: MgmtSendRequest<T>) {
        order.push(r.path);
        await sleep(10);
        return r.schema.parse({ ok: true });
      },
    };
    const lazyWrite = scheduleMgmtWrite(inner, scheduler, {
      lane: 'background',
    });
    const signal = new AbortController().signal;
    const one = lazyWrite.send(
      { connectionId: A, method: 'POST', path: '/first', schema: sendSchema },
      signal,
    );
    const two = lazyWrite.send(
      { connectionId: A, method: 'POST', path: '/second', schema: sendSchema },
      signal,
    );
    await timers.advance(0);
    expect(order).toEqual(['/first']);
    await finish(Promise.all([one, two]));
    expect(order).toEqual(['/first', '/second']);
  });

  async function* chunks(parts: string[]): AsyncGenerator<Uint8Array> {
    for (const part of parts) {
      await Promise.resolve();
      yield new TextEncoder().encode(part);
    }
  }

  const streamRequest = {
    connectionId: A,
    path: '/api/definitions',
    lane: 'background',
  } as const;

  it('scheduler: a streamed body keeps its background slot until it has been read', async () => {
    const { scheduler, timers, finish } = setup();
    const read = scheduleMgmtRead(
      {
        get: () => Promise.reject(new Error('not used')),
        stream: () => Promise.resolve(chunks(['a', 'b'])),
      },
      scheduler,
    );
    const signal = new AbortController().signal;
    const body = await finish(read.stream(streamRequest, signal));
    if (body.status !== 'fulfilled') throw new Error('stream failed');

    let second = false;
    const next = scheduler.run({ connectionId: A, lane: 'background' }, () => {
      second = true;
      return Promise.resolve();
    });
    await timers.advance(5000);
    expect(second).toBe(false);

    const text: string[] = [];
    for await (const chunk of body.value)
      text.push(new TextDecoder().decode(chunk));
    expect(text).toEqual(['a', 'b']);
    await finish(next);
    expect(second).toBe(true);
  });

  it('scheduler: stopping early releases the slot', async () => {
    const { scheduler, timers, finish } = setup();
    const scrape: PromScrapePort = {
      scrape: () => Promise.resolve(chunks(['a', 'b', 'c'])),
    };
    const scheduled = schedulePromScrape(scrape, scheduler);
    const signal = new AbortController().signal;
    const body = await finish(
      scheduled.scrape(
        {
          connectionId: A,
          node: 'rabbit@a',
          path: '/metrics',
          lane: 'background',
        },
        signal,
      ),
    );
    if (body.status !== 'fulfilled') throw new Error('scrape failed');
    for await (const chunk of body.value) {
      expect(chunk).toBeInstanceOf(Uint8Array);
      break;
    }
    let ran = false;
    const next = scheduler.run({ connectionId: A, lane: 'background' }, () => {
      ran = true;
      return Promise.resolve();
    });
    await timers.advance(1000);
    await next;
    expect(ran).toBe(true);
  });

  it('scheduler: a body that is never read is released by the watchdog and counted', async () => {
    const { scheduler, timers, finish } = setup({ holdMs: 1000 });
    const read = scheduleMgmtRead(
      {
        get: () => Promise.reject(new Error('not used')),
        stream: () => Promise.resolve(chunks(['a'])),
      },
      scheduler,
    );
    const signal = new AbortController().signal;
    await finish(read.stream(streamRequest, signal));
    let ran = false;
    const next = scheduler.run({ connectionId: A, lane: 'background' }, () => {
      ran = true;
      return Promise.resolve();
    });
    await timers.advance(900);
    expect(ran).toBe(false);
    await timers.advance(1000);
    await next;
    expect(ran).toBe(true);
    expect(scheduler.snapshot().holdTimeouts).toBe(1);
  });

  it('scheduler: the time a body takes to read is not a latency sample', async () => {
    const { scheduler, timers, finish, stats } = setup();
    const read = scheduleMgmtRead(
      {
        get: () => Promise.reject(new Error('not used')),
        stream: () => Promise.resolve(chunks(['a'])),
      },
      scheduler,
    );
    const signal = new AbortController().signal;
    const body = await finish(read.stream(streamRequest, signal));
    if (body.status !== 'fulfilled') throw new Error('stream failed');
    await timers.advance(50_000);
    for await (const chunk of body.value) expect(chunk.length).toBe(1);
    await timers.advance(1);
    expect(stats(A).p50Ms).toBeUndefined();
  });

  it('scheduler: a failing stream releases the slot and surfaces the error', async () => {
    const { scheduler, finish } = setup();
    const read = scheduleMgmtRead(
      {
        get: () => Promise.reject(new Error('not used')),
        stream: () => Promise.reject(overload503()),
      },
      scheduler,
    );
    const signal = new AbortController().signal;
    const failed = await finish(read.stream(streamRequest, signal));
    expect(failed.status).toBe('rejected');
    const next = await finish(
      scheduler.run({ connectionId: A, lane: 'background' }, () =>
        Promise.resolve(1),
      ),
    );
    expect(next).toEqual({ status: 'fulfilled', value: 1 });
  });
});

describe('scheduler: overload detection', () => {
  it.each([
    [overload503(), true],
    [new AppError('RATE_LIMITED'), true],
    [new AppError('BROKER_UNREACHABLE'), true],
    [
      new AppError('BROKER_ERROR', { broker: { protocol: 'http', code: 500 } }),
      true,
    ],
    [
      new AppError('BROKER_ERROR', {
        broker: { protocol: 'http', code: '599' },
      }),
      true,
    ],
    [
      new AppError('BROKER_ERROR', { broker: { protocol: 'http', code: 429 } }),
      true,
    ],
    [{ code: 'BROKER_UNREACHABLE' }, true],
    [
      new AppError('BROKER_ERROR', { broker: { protocol: 'http', code: 600 } }),
      false,
    ],
    [
      new AppError('BROKER_ERROR', { broker: { protocol: 'http', code: 499 } }),
      false,
    ],
    [
      new AppError('BROKER_ERROR', {
        broker: { protocol: 'amqp091', code: 503 },
      }),
      false,
    ],
    [new AppError('NOT_FOUND'), false],
    [notFound404(), false],
    [new Error('boom'), false],
    ['503', false],
    [undefined, false],
    [null, false],
  ])('classifies %o as overload=%s', (error, expected) => {
    expect(isOverloadError(error)).toBe(expected);
  });
});
