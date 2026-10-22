// What metrics.query and metrics.forecast answer from the hot store: windows, thinning, rates, the
// states of a forecast and the visibility rule. The store is filled by the collector over the scripted
// ports, on manual time (the generated metrics-query.spec.ts and metrics-forecast.spec.ts hold the
// kit-level checks).
import {
  metricsForecast,
  metricsQuery,
  type ConnectionId,
} from '@app/contracts';
import {
  createTestContext,
  createTestExecutor,
  createTestPrincipal,
} from '@app/kernel';
import { describe, expect, it } from 'vitest';

import { createMetricsFakeDeps, type MetricsFakeDeps } from '../testing';

import { createMetricsForecastAction } from './metrics-forecast';
import { createMetricsQueryAction } from './metrics-query';

const CID = 'c1' as ConnectionId;

/** `n` rounds, 15 s apart, driven by the collector's own loop. */
async function filled(
  n: number,
  options: Parameters<typeof createMetricsFakeDeps>[0] = {},
): Promise<MetricsFakeDeps> {
  const fakes = createMetricsFakeDeps(options);
  fakes.collector.touch(CID);
  await fakes.timers.settle();
  for (let i = 1; i < n; i++) await fakes.timers.advance(15_000);
  return fakes;
}

async function query(
  fakes: MetricsFakeDeps,
  input: Record<string, unknown>,
  userId = 'user-1',
) {
  const engine = createTestExecutor();
  engine.executor.register(createMetricsQueryAction(fakes));
  const outcome = await engine.executor.run(
    metricsQuery,
    { cid: 'c1', ...input },
    createTestContext({ principal: createTestPrincipal({ id: userId }) }),
  );
  if (outcome.kind !== 'output')
    throw new Error(`expected output, got ${outcome.kind}`);
  return outcome.output;
}

async function forecast(
  fakes: MetricsFakeDeps,
  input: Record<string, unknown>,
  userId = 'user-1',
) {
  const engine = createTestExecutor();
  engine.executor.register(createMetricsForecastAction(fakes));
  const outcome = await engine.executor.run(
    metricsForecast,
    { cid: 'c1', ...input },
    createTestContext({ principal: createTestPrincipal({ id: userId }) }),
  );
  if (outcome.kind !== 'output')
    throw new Error(`expected output, got ${outcome.kind}`);
  return outcome.output;
}

const READY = { metric: 'messages_ready' };

describe('metrics.query', () => {
  it('AC-16 returns the stored points of a series, oldest first, with the status of the source', async () => {
    const fakes = await filled(12);
    const answer = await query(fakes, { series: [READY] });
    const [result] = answer.series;
    expect(result).toMatchObject({
      found: true,
      kind: 'gauge',
      unit: 'messages',
      source: 'prometheus',
      approximate: false,
      view: 'value',
      dropped: 0,
    });
    expect(result?.points).toHaveLength(12);
    expect(result?.points[0]).toEqual([fakes.clock.now() - 11 * 15_000, 990]);
    expect(result?.points.at(-1)).toEqual([fakes.clock.now(), 880]);
    const times = result?.points.map(([t]) => t) ?? [];
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(answer.status).toMatchObject({
      state: 'live',
      source: 'prometheus',
      partial: [],
      approximate: false,
    });
  });

  it('AC-16 never returns more than maxPoints, keeps the newest point, and honours the range', async () => {
    const fakes = await filled(40);
    const thinned = await query(fakes, { series: [READY], maxPoints: 7 });
    const points = thinned.series[0]?.points ?? [];
    expect(points).toHaveLength(7);
    expect(points.at(-1)?.[0]).toBe(fakes.clock.now());
    const one = await query(fakes, { series: [READY], maxPoints: 1 });
    expect(one.series[0]?.points).toEqual([[fakes.clock.now(), 600]]);

    const from = fakes.clock.now() - 4 * 15_000;
    const ranged = await query(fakes, {
      series: [READY],
      from,
      to: fakes.clock.now() - 15_000,
    });
    expect(ranged.series[0]?.points.map(([t]) => t)).toEqual([
      from,
      from + 15_000,
      from + 30_000,
      from + 45_000,
    ]);
  });

  it('AC-16 a counter can be asked for as a per-second rate; a gauge cannot', async () => {
    const fakes = await filled(6);
    const answer = await query(fakes, {
      series: [{ metric: 'published_total' }, READY],
      rate: true,
    });
    const [published, ready] = answer.series;
    // 100 messages more every 15 s.
    expect(published).toMatchObject({ view: 'rate', kind: 'counter' });
    expect(published?.points).toHaveLength(5);
    for (const [, rate] of published?.points ?? [])
      expect(rate).toBeCloseTo(100 / 15, 6);
    expect(ready?.view).toBe('value');
    expect(ready?.points).toHaveLength(6);
  });

  it('AC-16 a series the engine does not hold is absent, not zero; a cold connection says it is loading', async () => {
    const fakes = createMetricsFakeDeps();
    const cold = await query(fakes, { series: [READY] });
    expect(cold.series[0]).toMatchObject({
      found: false,
      points: [],
      dropped: 0,
    });
    expect(cold.status.state).toBe('loading');

    const warm = await filled(3);
    const answer = await query(warm, {
      series: [
        { metric: 'queues' },
        { metric: 'memory_bytes', node: 'rabbit@elsewhere' },
        {
          metric: 'queue_messages',
          queue: { vhost: '/', name: 'nobody-asked' },
        },
      ],
    });
    expect(answer.series.map((s) => s.found)).toEqual([false, false, false]);
    expect(answer.series.every((s) => s.points.length === 0)).toBe(true);
  });

  it('AC-16 a reference whose shape does not fit its metric is refused', async () => {
    const fakes = createMetricsFakeDeps();
    for (const bad of [
      { metric: 'messages_ready', node: 'rabbit@n1' },
      { metric: 'memory_bytes' },
      { metric: 'queue_messages' },
      { metric: 'queue_messages', node: 'n', queue: { vhost: '/', name: 'q' } },
    ]) {
      await expect(query(fakes, { series: [bad] })).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    }
    // Refused references start no collection.
    await fakes.timers.settle();
    expect(fakes.promScript.requests).toHaveLength(0);
  });

  it('AC-16 the input is bounded: at most 50 series and 2,000 points', () => {
    const many = Array.from({ length: 51 }, () => READY);
    expect(
      metricsQuery.input.safeParse({ cid: 'c1', series: many }).success,
    ).toBe(false);
    expect(
      metricsQuery.input.safeParse({ cid: 'c1', series: [] }).success,
    ).toBe(false);
    expect(
      metricsQuery.input.safeParse({
        cid: 'c1',
        series: [READY],
        maxPoints: 2001,
      }).success,
    ).toBe(false);
    expect(
      metricsQuery.input.parse({ cid: 'c1', series: [READY] }),
    ).toMatchObject({ maxPoints: 600 });
  });

  it('AC-16 queue demand in a query starts the detailed read for those queues', async () => {
    const fakes = createMetricsFakeDeps();
    await query(fakes, {
      series: [
        { metric: 'queue_messages', queue: { vhost: '/', name: 'orders' } },
      ],
    });
    await fakes.timers.settle();
    await fakes.timers.advance(15_000);
    const answer = await query(fakes, {
      series: [
        { metric: 'queue_messages', queue: { vhost: '/', name: 'orders' } },
      ],
    });
    expect(answer.series[0]?.found).toBe(true);
    expect(answer.series[0]?.points.at(-1)?.[1]).toBe(124);
  });

  it("AC-16 an unknown connection and one that is not the caller's answer the same NOT_FOUND", async () => {
    const mine = createMetricsFakeDeps();
    await expect(
      query(mine, { cid: 'c9', series: [READY] }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const theirs = createMetricsFakeDeps({ ownerId: 'someone-else' });
    const error = await query(theirs, { series: [READY] }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: 'NOT_FOUND' });
    expect(theirs.promScript.requests).toHaveLength(0);
    await theirs.timers.settle();
    expect(theirs.promScript.requests).toHaveLength(0);
  });
});

describe('metrics.forecast', () => {
  it('AC-16 a steadily falling cluster backlog has a drain ETA with a band', async () => {
    const fakes = await filled(20);
    const answer = await forecast(fakes, { target: { scope: 'cluster' } });
    expect(answer.metric).toBe('messages');
    expect(answer.points).toBe(20);
    expect(answer.asOf).toBe(fakes.clock.now());
    expect(answer.forecast.state).toBe('ok');
    if (answer.forecast.state !== 'ok') return;
    // 10 fewer messages every 15 s from 880 (+7 unacked): 887 / (10 / 15 s).
    expect(answer.forecast.r2).toBeGreaterThanOrEqual(0.95);
    expect(answer.forecast.ratePerSec).toBeCloseTo(-10 / 15, 6);
    const expected = (807 / (10 / 15)) * 1000;
    expect(Math.abs(answer.forecast.etaMs - expected) / expected).toBeLessThan(
      0.01,
    );
    expect(answer.forecast.band.lowMs).toBeLessThanOrEqual(
      answer.forecast.etaMs,
    );
    expect(answer.forecast.band.highMs ?? Infinity).toBeGreaterThanOrEqual(
      answer.forecast.etaMs,
    );
    expect(metricsForecast.output.safeParse(answer).success).toBe(true);
  });

  it('AC-16 too few points is insufficient data; a series no line explains is no reliable forecast', async () => {
    const few = await filled(3);
    const early = await forecast(few, { target: { scope: 'cluster' } });
    expect(early.forecast).toMatchObject({
      state: 'insufficient-data',
      points: 3,
      needed: { points: 8, spanMs: 60_000 },
    });

    const noisy = createMetricsFakeDeps();
    const wobble = [
      500, 900, 120, 800, 60, 950, 300, 700, 40, 880, 200, 760, 100, 640,
    ];
    noisy.promScript.ready = (round) =>
      wobble[(round - 1) % wobble.length] ?? 0;
    noisy.collector.touch(CID);
    await noisy.timers.settle();
    for (let i = 1; i < 14; i++) await noisy.timers.advance(15_000);
    const answer = await forecast(noisy, { target: { scope: 'cluster' } });
    expect(answer.forecast.state).toBe('no-reliable-forecast');
    expect(answer.forecast).not.toHaveProperty('etaMs');
    expect(metricsForecast.output.safeParse(answer).success).toBe(true);
  });

  it('AC-16 a growing or empty backlog is not draining; no data at all is insufficient', async () => {
    const growing = createMetricsFakeDeps();
    growing.promScript.ready = (round) => 100 + 20 * round;
    growing.collector.touch(CID);
    await growing.timers.settle();
    for (let i = 1; i < 12; i++) await growing.timers.advance(15_000);
    expect(
      (await forecast(growing, { target: { scope: 'cluster' } })).forecast,
    ).toMatchObject({
      state: 'moving-away',
      reason: 'away',
    });

    const none = await forecast(createMetricsFakeDeps(), {
      target: { scope: 'cluster' },
    });
    expect(none.forecast.state).toBe('insufficient-data');
    expect(none.points).toBe(0);
    expect(none.asOf).toBeUndefined();
    expect(none.status.state).toBe('loading');
  });

  it('AC-16 a queue is forecast from its own depth, and windowMs limits the history used', async () => {
    const fakes = createMetricsFakeDeps();
    fakes.promScript.queues = [
      { vhost: '/', name: 'orders', ready: 500, unacked: 0, consumers: 1 },
    ];
    fakes.collector.touch(CID, [{ vhost: '/', name: 'orders' }]);
    await fakes.timers.settle();
    for (let i = 1; i < 12; i++) {
      const [queue] = fakes.promScript.queues;
      if (queue !== undefined) {
        fakes.promScript.queues = [{ ...queue, ready: queue.ready - 25 }];
      }
      await fakes.timers.advance(15_000);
    }
    const target = { scope: 'queue', vhost: '/', name: 'orders' };
    const answer = await forecast(fakes, { target });
    expect(answer.metric).toBe('queue_messages');
    expect(answer.forecast.state).toBe('ok');
    const limited = await forecast(fakes, { target, windowMs: 2 * 15_000 });
    expect(limited.points).toBe(3);
    expect(limited.forecast.state).toBe('insufficient-data');
    // A queue nobody collected has no series: insufficient, not an error.
    const other = await forecast(fakes, {
      target: { scope: 'queue', vhost: '/', name: 'ghost' },
    });
    expect(other.forecast.state).toBe('insufficient-data');
  });

  it('AC-16 an unknown or foreign connection is a NOT_FOUND', async () => {
    await expect(
      forecast(createMetricsFakeDeps(), {
        cid: 'c9',
        target: { scope: 'cluster' },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      forecast(createMetricsFakeDeps({ ownerId: 'x' }), {
        target: { scope: 'cluster' },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
