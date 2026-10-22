// perf:metrics-100k (M1-26, AC-19): what a Prometheus page of 400,000 series (100,000 queues, four
// families each) costs the engine, and what keeps it bounded (I-5, I-6).
//
// The page is synthetic and generated while it is read, so nothing holds it: the figures are the
// engine's own work (the parser, the filter, the round, the store) and not a network or a broker.
// They are SYNTHETIC figures; the lab run against a real 100,000-queue broker is a maintainer task.
//
// The assertions are counts, not clocks: the turns the parser gives the loop, the series the store
// holds and the samples it counted as dropped. Wall times and the event-loop delay are printed (a
// loaded CI machine would make them flaky), as is the heap.
//
// Node only: `pnpm nx run perf:metrics-100k`.
import { monitorEventLoopDelay } from 'node:perf_hooks';

import { createPromReader, parseExposition } from '@app/adapter-prometheus';
import { ConnectionIdSchema } from '@app/contracts';
import {
  beginRound,
  createHotStore,
  createMetricsFakeDeps,
} from '@app/svc-metrics';
import { describe, expect, it } from 'vitest';

const cid = ConnectionIdSchema.parse('c1');
const QUEUES = Number(process.env.PERF_METRICS_QUEUES ?? 100_000);
const FAMILIES = [
  ['rabbitmq_detailed_queue_messages_ready', 7],
  ['rabbitmq_detailed_queue_messages_unacked', 3],
  ['rabbitmq_detailed_queue_messages', 10],
  ['rabbitmq_detailed_queue_consumers', 1],
] as const;
const SERIES = QUEUES * FAMILIES.length;
const CHUNK_BYTES = 64 * 1024;
const MIB = 1024 * 1024;
const NS_PER_MS = 1e6;

// Vitest 5 hides the console output of a passing test, and these figures are the point of the run.
const report = (line: string): void => {
  process.stdout.write(line + '\n');
};

const queueName = (i: number): string => `queue-${String(i).padStart(6, '0')}`;
const vhostOf = (i: number): string => `vhost-${String(i % 4)}`;

/** The detailed page of `QUEUES` queues, in 64 KiB chunks, generated as it is read. */
function syntheticPage(): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  return {
    [Symbol.asyncIterator]: async function* chunks() {
      let pending = '';
      for (const [family] of FAMILIES) {
        pending += `# TYPE ${family} gauge\n`;
        for (let i = 0; i < QUEUES; i++) {
          const value =
            (FAMILIES.find(([name]) => name === family)?.[1] ?? 0) + (i % 5);
          pending += `${family}{vhost="${vhostOf(i)}",queue="${queueName(i)}"} ${String(value)}\n`;
          if (pending.length >= CHUNK_BYTES) {
            await Promise.resolve();
            yield encoder.encode(pending);
            pending = '';
          }
        }
      }
      if (pending !== '') {
        await Promise.resolve();
        yield encoder.encode(pending);
      }
    },
  };
}

const heapMiB = (): number => process.memoryUsage().heapUsed / MIB;

describe('metrics perf', () => {
  it('AC-19 a 400,000-series page is parsed in counted turns and held nowhere', async () => {
    const baseline = heapMiB();
    let peak = baseline;
    const loop = monitorEventLoopDelay({ resolution: 1 });
    loop.enable();
    const began = performance.now();
    let seen = 0;
    const summary = await parseExposition(
      syntheticPage(),
      () => {
        seen++;
      },
      {
        yieldNow: () => {
          peak = Math.max(peak, heapMiB());
          return new Promise<void>((resolve) => setImmediate(resolve));
        },
      },
    );
    const tookMs = performance.now() - began;
    loop.disable();

    report(
      `[perf] parse-${String(SERIES / 1_000)}k (synthetic page) ${JSON.stringify(
        {
          series: summary.samples,
          mib: Number((summary.bytes / MIB).toFixed(1)),
          turns: summary.yields,
          maxKiBBetweenTurns: Math.round(summary.maxCharsBetweenYields / 1024),
          maxLinesBetweenTurns: summary.maxLinesBetweenYields,
          parseMs: Math.round(tookMs),
          loopDelayMsP99: Number((loop.percentile(99) / NS_PER_MS).toFixed(2)),
          loopDelayMsMax: Number((loop.max / NS_PER_MS).toFixed(2)),
          heapGrowthMiB: Number((peak - baseline).toFixed(1)),
        },
      )}`,
    );

    expect(summary.samples).toBe(SERIES);
    expect(seen).toBe(SERIES);
    expect(summary).toMatchObject({
      malformed: 0,
      oversizedLines: 0,
      skipped: 0,
    });
    // I-5: a turn at least every 64 KiB of text and every 2,000 lines, and the turns are taken.
    expect(summary.maxCharsBetweenYields).toBeLessThanOrEqual(64 * 1024 + 256);
    expect(summary.maxLinesBetweenYields).toBeLessThanOrEqual(2_000);
    expect(summary.yields).toBeGreaterThanOrEqual(
      Math.floor(summary.bytes / (64 * 1024)) - 1,
    );
    // I-6: streaming. Keeping 400,000 parsed samples would cost more than this by itself.
    expect(peak - baseline).toBeLessThan(96);
  }, 300_000);

  it('AC-19 100,000 queues of demand reach the collector capped, and the queues nobody asked for are skipped, not stored and not lost', async () => {
    const fakes = createMetricsFakeDeps({
      prom: createPromReader({
        scrape: (request) =>
          Promise.resolve(
            request.path === '/metrics/detailed'
              ? syntheticPage()
              : (async function* aggregated() {
                  await Promise.resolve();
                  yield new TextEncoder().encode('rabbitmq_connections 3\n');
                })(),
          ),
      }),
    });
    const demand = Array.from({ length: QUEUES }, (_, i) => ({
      vhost: vhostOf(i),
      name: queueName(i),
    }));
    const loop = monitorEventLoopDelay({ resolution: 1 });
    loop.enable();
    const began = performance.now();
    fakes.collector.touch(cid, demand);
    const outcome = await fakes.collector.roundNow(
      cid,
      new AbortController().signal,
    );
    const tookMs = performance.now() - began;
    loop.disable();
    const status = fakes.collector.status(cid);
    const held = fakes.collector.store.status(cid);

    report(
      `[perf] collector-${String(QUEUES / 1_000)}k-demand (synthetic page) ${JSON.stringify(
        {
          roundMs: Math.round(tookMs),
          requests: outcome.requests,
          queueSeries: held.queueSeries,
          droppedSamples: status.dropped.samples,
          loopDelayMsP99: Number((loop.percentile(99) / NS_PER_MS).toFixed(2)),
        },
      )}`,
    );

    expect(outcome.ended).toBe('complete');
    // The demand is capped at 50 queues, so the planner asks once, and only 50 queues are stored.
    expect(outcome.requests).toBeLessThanOrEqual(1 + 8);
    expect(held.queueSeries).toBeLessThanOrEqual(50 * FAMILIES.length);
    expect(held.queueSeries).toBeGreaterThan(0);
    // Samples of queues nobody asked for are skipped by the parser: not delivered, and not lost.
    expect(status.dropped.samples).toBe(0);
    await fakes.collector.stop();
  }, 300_000);

  it('AC-19 the store holds at most its caps however many queue series arrive, and counts every refusal', () => {
    const limits = { ringPoints: 720, maxQueueSeries: 2_000, maxBrokers: 64 };
    const store = createHotStore(limits);
    const round = beginRound(
      { maxRoundCandidates: SERIES },
      new Set(
        Array.from(
          { length: QUEUES },
          (_, i) => `${vhostOf(i)}\u001f${queueName(i)}`,
        ),
      ),
    );
    const baseline = heapMiB();
    for (const [family, base] of FAMILIES) {
      for (let i = 0; i < QUEUES; i++) {
        round.add('rabbit@n1', {
          name: family,
          labels: { vhost: vhostOf(i), queue: queueName(i) },
          value: base + (i % 100),
        });
      }
    }
    const summary = round.commit(store, cid, 1_700_000_000_000, {
      source: 'prometheus',
      approximate: false,
    });
    const held = store.status(cid);

    report(
      `[perf] store-${String(SERIES / 1_000)}k-series ${JSON.stringify({
        stored: summary.stored,
        refused: summary.refused,
        queueSeries: held.queueSeries,
        droppedSeries: held.droppedSeries,
        heapGrowthMiB: Number((heapMiB() - baseline).toFixed(1)),
      })}`,
    );

    // Every series is accounted for: refused at the door (twice the cap, counted) or evicted by the
    // end of the round, so a round may overshoot the cap while it runs but never double it.
    expect(summary.stored).toBe(2 * limits.maxQueueSeries);
    expect(summary.refused).toBe(SERIES - 2 * limits.maxQueueSeries);
    expect(summary.stored + summary.refused).toBe(SERIES);
    expect(held.queueSeries).toBeLessThanOrEqual(limits.maxQueueSeries);
    expect(held.droppedSeries).toBe(SERIES - limits.maxQueueSeries);

    // A series is a ring: a thousand points leave 720.
    for (let t = 1; t <= 1_000; t++) {
      store.append(
        cid,
        { metric: 'messages' },
        { source: 'prometheus', approximate: false },
        { t, v: t },
      );
    }
    expect(store.read(cid, { metric: 'messages' })?.points).toHaveLength(720);
  }, 300_000);
});
