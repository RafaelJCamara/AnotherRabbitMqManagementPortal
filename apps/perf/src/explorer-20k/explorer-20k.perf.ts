// perf:explorer-20k (M0-48 slice F, AC-24): what a window query costs the engine while sweeps keep
// installing new index versions, and what that does to the event loop (I-5).
//
// The broker is synthetic: the scripted management API of svc-explorer serves N queues across four
// vhosts, paged at 500, and answers from memory, so the figures are the engine's own CPU (parsing,
// building a version, sorting, filtering) and not a network or a broker. They are SYNTHETIC
// figures: they do not replace the lab run (`svc-explorer:it`, docs/architecture/s-13-mgmt-api-cost-100k.md).
//
// Node only, no browser: `pnpm nx run perf:explorer-20k`. At 20,000 queues the budgets are asserted;
// at 100,000 (`PERF_EXPLORER_LARGE`, 0 to skip) the same run is measured and printed, not asserted
// (OQ-665: a sort of 100,000 rows on the loop may exceed the budget, and then a worker or a chunked
// sort is a new issue).
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

import { ConnectionIdSchema } from '@app/contracts';
import { createTestContext, createTestExecutor } from '@app/kernel';
import type { MgmtReadPort } from '@app/ports';
import {
  createExplorerFakeDeps,
  createInventoryQueryAction,
  createSearchQueryAction,
} from '@app/svc-explorer';
import { describe, expect, it } from 'vitest';

const cid = ConnectionIdSchema.parse('c1');

// Vitest 5 hides the console output of a passing test, and these figures are the point of the run.
const report = (line: string): void => {
  process.stdout.write(line + '\n');
};

/** Budgets of AC-24. */
const WINDOW_P95_BUDGET_MS = 100;
/**
 * The budget is on the delay above what the sampler reads on an idle loop. `monitorEventLoopDelay`
 * reports the whole interval between two ticks of its timer, so an idle loop reads about the
 * resolution (1 ms) on Linux, but about 16 ms on Windows, where the operating system's timer tick
 * is 15.6 ms whatever resolution is asked for: a raw 20 ms limit would leave 4 ms there. On Linux
 * the floor is 1 ms and this is the limit of I-5 as written.
 */
const LOOP_DELAY_P99_BUDGET_MS = 20;
const QUERIES = 1_000;
const VHOSTS = 4;
const EXCHANGES_PER_VHOST = 25;
/** A new index version is wanted this often while the windows are read. */
const SWEEP_PERIOD_MS = 50;
/** The loop-delay sampler wakes this often, so an idle loop reads about 1 ms, not 10. */
const SAMPLE_RESOLUTION_MS = 1;

const largeQueues = Number(process.env.PERF_EXPLORER_LARGE ?? 100_000);

const NS_PER_MS = 1e6;
const percentile = (sorted: readonly number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0;

/** The same sequence on every run: an LCG, so a figure can be compared with the last one. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const FILTERS: readonly Record<string, unknown>[] = [
  {},
  { text: 'queue-00' },
  { text: '7' },
  { text: 'QUEUE-1' },
  { vhosts: ['vhost-1'] },
  { vhosts: ['/', 'vhost-2'], minMessages: 50 },
  { types: ['classic'], minMessages: 90 },
  { text: 'no-such-queue' },
];
const SORTS: readonly (Record<string, unknown> | undefined)[] = [
  undefined,
  { column: 'name', dir: 'asc' },
  { column: 'name', dir: 'desc' },
  { column: 'messages', dir: 'asc' },
  { column: 'messages', dir: 'desc' },
  { column: 'vhost', dir: 'asc' },
  { column: 'durable', dir: 'desc' },
];
const LIMITS = [1, 200, 500] as const;

interface ExplorerPerfResult {
  readonly queues: number;
  readonly queries: number;
  /** Index versions installed while the windows were read. */
  readonly installs: number;
  readonly sweepMsMedian: number;
  readonly windowMsP50: number;
  readonly windowMsP95: number;
  readonly windowMsMax: number;
  /** Event-loop delay as `monitorEventLoopDelay` reports it, sampled every millisecond. */
  readonly loopDelayMsIdleP99: number;
  readonly loopDelayMsP99: number;
  /** The p99 less the idle floor beyond the sampling resolution: the figure the budget is on. */
  readonly loopDelayMsP99AboveFloor: number;
  readonly loopDelayMsMax: number;
  readonly dropped: number;
}

/** One run: `queues` queues, a sweep loop installing versions, and `QUERIES` windows read meanwhile. */
async function runExplorerPerf(queues: number): Promise<ExplorerPerfResult> {
  // The scripted broker answers in the same tick, so a whole sweep would run as one chain of
  // microtasks and hold the loop for its full length: nothing a socket does. Each request here
  // gives the loop one turn first, as waiting for a real answer does (the figures of the first
  // version of this harness, without the turn, were a loop-delay p99 of 139 ms: an artefact of the
  // fake, recorded in docs/architecture/s-13-mgmt-api-cost-100k.md). The page is still parsed with
  // the sweeper's own schema, which is the CPU the engine pays per page.
  const scripted: { read?: MgmtReadPort } = {};
  const mgmt: MgmtReadPort = {
    get: async (request, signal) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (scripted.read === undefined) {
        throw new Error('the broker is not scripted');
      }
      return scripted.read.get(request, signal);
    },
    stream: () => Promise.reject(new Error('the explorer never streams')),
  };
  const deps = createExplorerFakeDeps({
    queueCount: queues,
    vhostCount: VHOSTS,
    exchangesPerVhost: EXCHANGES_PER_VHOST,
    mgmt,
  });
  scripted.read = deps.broker.read;
  const engine = createTestExecutor();
  const action = createInventoryQueryAction(deps);
  engine.executor.register(action);
  const ask = async (input: Record<string, unknown>) => {
    const outcome = await engine.executor.run(
      action.def,
      input,
      createTestContext({ idempotencyKey: 'perf-explorer-20k-key-0001' }),
    );
    if (outcome.kind !== 'output') throw new Error(`got ${outcome.kind}`);
    return outcome.output;
  };

  // The first sweep builds the index; `touch` is what the first window query does, `sweepNow` joins it.
  deps.sweeper.touch(cid);
  const first = await deps.sweeper.sweepNow(cid, new AbortController().signal);
  if (first.ended !== 'complete') throw new Error('the first sweep failed');

  const loop = monitorEventLoopDelay({ resolution: SAMPLE_RESOLUTION_MS });
  // What the sampler reads on a loop that is doing nothing: the floor of the figures below.
  loop.enable();
  await sleep(1_000);
  loop.disable();
  const idleP99 = loop.percentile(99) / NS_PER_MS;
  loop.reset();

  const stop = new AbortController();
  const sweepMs: number[] = [];
  let installs = 0;
  const sweeping = (async () => {
    while (!stop.signal.aborted) {
      const began = performance.now();
      const outcome = await deps.sweeper.sweepNow(
        cid,
        new AbortController().signal,
      );
      if (outcome.ended === 'complete') installs++;
      const took = performance.now() - began;
      sweepMs.push(took);
      await sleep(Math.max(0, SWEEP_PERIOD_MS - took));
    }
  })();

  const random = lcg(24);
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)] as T;
  const elapsed: number[] = [];
  loop.enable();
  for (let i = 0; i < QUERIES; i++) {
    const limit = pick(LIMITS);
    const sort = pick(SORTS);
    const filter = pick(FILTERS);
    const offset = Math.floor(random() * queues);
    const began = performance.now();
    await ask({
      cid: 'c1',
      kind: 'queues',
      ...(Object.keys(filter).length === 0 ? {} : { filter }),
      ...(sort === undefined ? {} : { sort }),
      window: { offset, limit },
    });
    elapsed.push(performance.now() - began);
    // A reader that never yields would hide the loop delay it causes from the sampler.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  loop.disable();
  stop.abort();
  await sweeping;
  await deps.sweeper.stop();

  elapsed.sort((a, b) => a - b);
  sweepMs.sort((a, b) => a - b);
  return {
    queues,
    queries: QUERIES,
    installs,
    sweepMsMedian: percentile(sweepMs, 0.5),
    windowMsP50: percentile(elapsed, 0.5),
    windowMsP95: percentile(elapsed, 0.95),
    windowMsMax: elapsed.at(-1) ?? 0,
    loopDelayMsIdleP99: idleP99,
    loopDelayMsP99: loop.percentile(99) / NS_PER_MS,
    loopDelayMsP99AboveFloor: Math.max(
      0,
      loop.percentile(99) / NS_PER_MS -
        Math.max(0, idleP99 - SAMPLE_RESOLUTION_MS),
    ),
    loopDelayMsMax: loop.max / NS_PER_MS,
    dropped:
      deps.sweeper.index(cid)?.window({ kind: 'queues', offset: 0, limit: 1 })
        .version.dropped ?? 0,
  };
}

const SEARCHES = 500;

/**
 * search.query over a complete index (AC-25 leaves the figure at 100,000 names to this slice): 500
 * searches rotating a prefix, a substring, a miss and a long substring, through the executor.
 * Printed, never asserted here; AC-25 asserts the budget at 20,000.
 */
async function runSearchPerf(queues: number) {
  const deps = createExplorerFakeDeps({
    queueCount: queues,
    vhostCount: VHOSTS,
    exchangesPerVhost: EXCHANGES_PER_VHOST,
  });
  const engine = createTestExecutor();
  const action = createSearchQueryAction(deps);
  engine.executor.register(action);
  deps.sweeper.touch(cid);
  await deps.sweeper.sweepNow(cid, new AbortController().signal);
  const texts = ['queue-0012', '77', 'no-such-name', 'Exchange-1', 'queue-00'];
  const elapsed: number[] = [];
  let matched = 0;
  for (let i = 0; i < SEARCHES; i++) {
    const began = performance.now();
    const outcome = await engine.executor.run(
      action.def,
      { cid: 'c1', text: texts[i % texts.length] },
      createTestContext({ idempotencyKey: 'perf-explorer-20k-key-0002' }),
    );
    elapsed.push(performance.now() - began);
    if (outcome.kind !== 'output') throw new Error(`got ${outcome.kind}`);
    matched = Math.max(matched, outcome.output.matched);
  }
  await deps.sweeper.stop();
  elapsed.sort((a, b) => a - b);
  return {
    names: queues + VHOSTS * EXCHANGES_PER_VHOST,
    searches: SEARCHES,
    mostMatched: matched,
    searchMsP50: Number(percentile(elapsed, 0.5).toFixed(2)),
    searchMsP95: Number(percentile(elapsed, 0.95).toFixed(2)),
    searchMsMax: Number((elapsed.at(-1) ?? 0).toFixed(2)),
  };
}

const print = (label: string, result: ExplorerPerfResult): void => {
  const rounded = Object.fromEntries(
    Object.entries(result).map(([key, value]) => [
      key,
      typeof value === 'number' && !Number.isInteger(value)
        ? Number(value.toFixed(2))
        : value,
    ]),
  );
  report(`[perf] ${label} (synthetic broker) ${JSON.stringify(rounded)}`);
};

describe('explorer perf', () => {
  it('M0-48 AC-24 explorer 20k windows stay under 100 ms p95 and 20 ms loop delay p99', async () => {
    const asserted = await runExplorerPerf(20_000);
    print('explorer-20k', asserted);
    if (largeQueues > 0) {
      // Measured and printed, never asserted (OQ-665); run before the assertions so a failure
      // above still leaves the 100,000 figures in the log.
      print(
        `explorer-${String(largeQueues / 1_000)}k`,
        await runExplorerPerf(largeQueues),
      );
    }
    report(
      `[perf] search-20k (synthetic broker) ${JSON.stringify(await runSearchPerf(20_000))}`,
    );
    if (largeQueues > 0) {
      report(
        `[perf] search-${String(largeQueues / 1_000)}k (synthetic broker) ${JSON.stringify(await runSearchPerf(largeQueues))}`,
      );
    }
    expect(asserted.dropped).toBe(0);
    expect(asserted.installs).toBeGreaterThan(1);
    expect(asserted.windowMsP95).toBeLessThanOrEqual(WINDOW_P95_BUDGET_MS);
    expect(asserted.loopDelayMsP99AboveFloor).toBeLessThanOrEqual(
      LOOP_DELAY_P99_BUDGET_MS,
    );
  }, 900_000);
});
