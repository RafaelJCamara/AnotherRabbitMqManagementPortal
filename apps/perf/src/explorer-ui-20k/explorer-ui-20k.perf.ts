// perf:explorer-ui-20k (M0-54 slice J, AC-26): what the explorer UI's interactions cost in the adapter and the
// engine. The REAL window source of `@app/explorer-model` (the one the grid page uses) reads through a data port
// that runs the REAL `inventory.query` action over a 20,000-queue index, while sweeps keep installing new index
// versions. 1,000 interactions run: scroll jumps, text filters, facet changes and sorts, each timed from the call
// to the rows of the first block.
//
// WHAT THIS DOES NOT MEASURE: transport (HTTP, the live socket), rendering and the browser. It is "engine plus
// adapter, in Node", on a synthetic broker that answers from memory, and says so in its output. The time from
// input to painted rows in a real browser is AC-27 (`explorer-ui-20k.browser.perf.ts`), which is planned: it needs
// the browser driver and issue #277, and no browser figure is claimed anywhere until it runs.
//
// `pnpm nx run perf:explorer-ui-20k`. At 20,000 queues the budgets are asserted; the 100,000-queue run
// (`PERF_EXPLORER_UI_LARGE`, 0 to skip) is measured and printed, never asserted. This data port has no live topic,
// so the resubscribe and refresh counts printed are those of the source over what the sweeps did to the pinned
// version; the topic's own cost is the engine side of `perf:explorer-20k`.
import { setTimeout as sleep } from 'node:timers/promises';

import { ConnectionIdSchema } from '@app/contracts';
import {
  createInventoryWindowSource,
  type ExplorerData,
  type ExplorerFilter,
  type InventoryQueryInput,
  type WindowSort,
  type WindowSourceCounters,
} from '@app/explorer-model';
import { createTestContext, createTestExecutor } from '@app/kernel';
import type { MgmtReadPort } from '@app/ports';
import {
  createExplorerFakeDeps,
  createInventoryQueryAction,
} from '@app/svc-explorer';
import { describe, expect, it } from 'vitest';

const cid = ConnectionIdSchema.parse('c1');

// Vitest 5 hides the console output of a passing test, and these figures are the point of the run.
const report = (line: string): void => {
  process.stdout.write(line + '\n');
};

/** Budgets of AC-26. */
const INTERACTION_P95_BUDGET_MS = 300;
const BLOCK = 200;
const INTERACTIONS = 1_000;
const VHOSTS = 4;
const EXCHANGES_PER_VHOST = 25;
/** A new index version is wanted this often while the interactions run. */
const SWEEP_PERIOD_MS = 50;

const largeQueues = Number(process.env.PERF_EXPLORER_UI_LARGE ?? 100_000);

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

/** The text filters a person types: a prefix, a fragment, another case, a miss. */
const TEXT_FILTERS: readonly ExplorerFilter[] = [
  { text: 'queue-00' },
  { text: '7' },
  { text: 'QUEUE-1' },
  { text: 'no-such-queue' },
  { text: 'queue-0012' },
];
/** The facet changes: queue types, vhosts, a message minimum, and combinations. */
const FACET_FILTERS: readonly ExplorerFilter[] = [
  { types: ['classic'] },
  { types: ['quorum'], minMessages: 50 },
  { vhosts: ['vhost-1'] },
  { vhosts: ['/', 'vhost-2'], minMessages: 50 },
  { types: ['classic'], minMessages: 90 },
  { text: 'queue-1', types: ['quorum'], vhosts: ['vhost-3'] },
];
const SORTS: readonly (readonly WindowSort[])[] = [
  [],
  [{ columnId: 'name', direction: 'asc' }],
  [{ columnId: 'name', direction: 'desc' }],
  [{ columnId: 'messages', direction: 'asc' }],
  [{ columnId: 'messages', direction: 'desc' }],
  [{ columnId: 'vhost', direction: 'asc' }],
  [{ columnId: 'consumers', direction: 'desc' }],
];

type Interaction = 'scroll' | 'text-filter' | 'facet-change' | 'sort';
const KINDS: readonly Interaction[] = [
  'scroll',
  'scroll',
  'text-filter',
  'facet-change',
  'sort',
];

interface UiPerfResult {
  readonly queues: number;
  readonly interactions: number;
  readonly byInteraction: Record<string, number>;
  /** Index versions installed while the interactions ran. */
  readonly installs: number;
  readonly interactionMsP50: number;
  readonly interactionMsP95: number;
  readonly interactionMsMax: number;
  /** Requests the engine received, and the largest `window.limit` among them. */
  readonly requests: number;
  readonly requestLimitMax: number;
  readonly counters: WindowSourceCounters;
  readonly sources: number;
}

const ZERO: WindowSourceCounters = {
  windows: 0,
  windowFailures: 0,
  resubscribes: 0,
  markers: 0,
  refreshes: 0,
  reconciled: 0,
  gaps: 0,
  resets: 0,
  versionChanges: 0,
  removals: 0,
};

async function runUiPerf(queues: number): Promise<UiPerfResult> {
  // The scripted broker answers in the same tick; each request gives the loop one turn first, as waiting for a
  // socket does (see explorer-20k.perf.ts).
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

  let requests = 0;
  let requestLimitMax = 0;
  const data: ExplorerData = {
    async query(input: InventoryQueryInput) {
      requests++;
      requestLimitMax = Math.max(requestLimitMax, input.window.limit);
      const outcome = await engine.executor.run(
        action.def,
        input,
        createTestContext({ idempotencyKey: 'perf-explorer-ui-20k-key-0001' }),
      );
      if (outcome.kind !== 'output') throw new Error(`got ${outcome.kind}`);
      return outcome.output;
    },
    // No live topic in this harness (see the header).
    follow: () => () => undefined,
  };

  deps.sweeper.touch(cid);
  const first = await deps.sweeper.sweepNow(cid, new AbortController().signal);
  if (first.ended !== 'complete') throw new Error('the first sweep failed');

  const stop = new AbortController();
  let installs = 0;
  const sweeping = (async () => {
    while (!stop.signal.aborted) {
      const began = performance.now();
      const outcome = await deps.sweeper.sweepNow(
        cid,
        new AbortController().signal,
      );
      if (outcome.ended === 'complete') installs++;
      await sleep(Math.max(0, SWEEP_PERIOD_MS - (performance.now() - began)));
    }
  })();

  const random = lcg(54);
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)] as T;
  const signal = new AbortController().signal;

  // The page holds one source per query (filter) and one pinned scroll per sort; a new filter is a new source.
  let source = createInventoryWindowSource(data, {
    cid,
    kind: 'queues',
    filter: {},
  });
  let sort: readonly WindowSort[] = [];
  let matched = queues;
  const counters: { -readonly [K in keyof WindowSourceCounters]: number } = {
    ...ZERO,
  };
  let sources = 1;
  const retire = (): void => {
    const state = source.state().counters;
    for (const key of Object.keys(counters) as (keyof WindowSourceCounters)[]) {
      counters[key] += state[key];
    }
    source.destroy();
  };
  const read = async (offset: number): Promise<void> => {
    const answer = await source.window({ offset, limit: BLOCK, sort }, signal);
    matched = answer.total ?? matched;
    // The grid reports the rows it shows, and the source follows them (one resubscribe per change).
    source.watch(new Set(answer.rows.map((row) => source.rowId(row))));
  };
  await read(0);

  const elapsed: number[] = [];
  const byInteraction: Record<string, number> = {};
  for (let i = 0; i < INTERACTIONS; i++) {
    const kind = pick(KINDS);
    byInteraction[kind] = (byInteraction[kind] ?? 0) + 1;
    const began = performance.now();
    switch (kind) {
      case 'scroll': {
        // A jump to a random block of the current list.
        const blocks = Math.max(1, Math.ceil(matched / BLOCK));
        await read(Math.floor(random() * blocks) * BLOCK);
        break;
      }
      case 'text-filter':
      case 'facet-change': {
        retire();
        source = createInventoryWindowSource(data, {
          cid,
          kind: 'queues',
          filter: pick(kind === 'text-filter' ? TEXT_FILTERS : FACET_FILTERS),
        });
        sources++;
        await read(0);
        break;
      }
      case 'sort': {
        sort = pick(SORTS);
        await read(0);
        break;
      }
    }
    elapsed.push(performance.now() - began);
    // A reader that never yields would starve the sweeps this run is racing.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  retire();
  stop.abort();
  await sweeping;
  await deps.sweeper.stop();

  elapsed.sort((a, b) => a - b);
  return {
    queues,
    interactions: INTERACTIONS,
    byInteraction,
    installs,
    interactionMsP50: percentile(elapsed, 0.5),
    interactionMsP95: percentile(elapsed, 0.95),
    interactionMsMax: elapsed.at(-1) ?? 0,
    requests,
    requestLimitMax,
    counters,
    sources,
  };
}

const print = (label: string, result: UiPerfResult): void => {
  const rounded = JSON.parse(
    JSON.stringify(result, (_key, value: unknown) =>
      typeof value === 'number' && !Number.isInteger(value)
        ? Number(value.toFixed(2))
        : value,
    ),
  ) as unknown;
  report(
    `[perf] ${label} (synthetic broker; engine plus adapter, Node: no transport, no rendering, no browser) ${JSON.stringify(rounded)}`,
  );
};

describe('explorer ui perf', () => {
  it('AC-26 explorer ui 20k: interactions stay under 300 ms p95 in the adapter and engine', async () => {
    const asserted = await runUiPerf(20_000);
    print('explorer-ui-20k', asserted);
    if (largeQueues > 0) {
      // Measured and printed, never asserted; run before the assertions so a failure above still leaves the
      // 100,000 figures in the log.
      print(
        `explorer-ui-${String(largeQueues / 1_000)}k`,
        await runUiPerf(largeQueues),
      );
    }
    expect(asserted.requests).toBeGreaterThanOrEqual(INTERACTIONS);
    expect(asserted.requestLimitMax).toBeLessThanOrEqual(BLOCK);
    expect(asserted.counters.windowFailures).toBe(0);
    expect(asserted.installs).toBeGreaterThan(1);
    expect(asserted.interactionMsP95).toBeLessThanOrEqual(
      INTERACTION_P95_BUDGET_MS,
    );
  }, 900_000);
});
