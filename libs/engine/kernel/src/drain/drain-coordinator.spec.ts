import { describe, expect, it } from 'vitest';

import { createTestExecutor } from '../actions/testing.ts';
import { createManualClock } from '../clock/clock.ts';
import type { Logger } from '../log/logger.ts';
import { AppError } from '../problem/problem.ts';
import { createManualTimers } from '../scheduler/timers.ts';
import {
  createDrainCoordinator,
  DEFAULT_DRAIN_BUDGETS_MS,
  executorGatePhase,
  type DrainContext,
  type DrainPhaseName,
  type DrainPhaseSpec,
  type DrainReason,
} from './drain-coordinator.ts';

function setup(phases: (record: Seen) => DrainPhaseSpec[], logger?: Logger) {
  const clock = createManualClock(1_700_000_000_000);
  const timers = createManualTimers(clock);
  const seen: Seen = { order: [], contexts: new Map() };
  const coordinator = createDrainCoordinator({
    phases: phases(seen),
    clock,
    timers,
    ...(logger === undefined ? {} : { logger }),
  });
  return { clock, timers, seen, coordinator };
}

interface Seen {
  order: DrainPhaseName[];
  contexts: Map<DrainPhaseName, DrainContext>;
}

/** A contribution that records when it ran and finishes at once. */
function recorder(
  seen: Seen,
  name: DrainPhaseName,
  reasons?: readonly DrainReason[],
): DrainPhaseSpec {
  return {
    name,
    ...(reasons === undefined ? {} : { reasons }),
    run: (ctx) => {
      seen.order.push(name);
      seen.contexts.set(name, ctx);
      return Promise.resolve();
    },
  };
}

const allPhases = (seen: Seen): DrainPhaseSpec[] => [
  recorder(seen, 'flush'),
  recorder(seen, 'taps-firehose'),
  recorder(seen, 'gate'),
  recorder(seen, 'sources-jobs'),
  recorder(seen, 'peeks'),
];

describe('drain coordinator', () => {
  it('AC-1 drain runs the five phases in the blueprint order, each with its own budget', async () => {
    const { seen, coordinator, clock } = setup(allPhases);
    const started = clock.monotonic();

    const results = await coordinator.drain('quit', 2000);

    expect(seen.order).toEqual([
      'gate',
      'peeks',
      'sources-jobs',
      'taps-firehose',
      'flush',
    ]);
    expect(results.map((r) => [r.phase, r.ok])).toEqual([
      ['gate', true],
      ['peeks', true],
      ['sources-jobs', true],
      ['taps-firehose', true],
      ['flush', true],
    ]);
    for (const [name, budget] of Object.entries(DEFAULT_DRAIN_BUDGETS_MS)) {
      const ctx = seen.contexts.get(name as DrainPhaseName);
      expect(ctx?.budgetMs).toBe(budget);
      expect(ctx?.reason).toBe('quit');
    }
    expect(clock.monotonic() - started).toBe(0);
  });

  it('AC-1 drain still flushes, with the whole flush budget, when peeks never ends and sources-jobs throws', async () => {
    const { seen, coordinator, clock, timers } = setup((record) => [
      recorder(record, 'gate'),
      { name: 'peeks', run: () => new Promise<void>(() => undefined) },
      {
        name: 'sources-jobs',
        run: () => Promise.reject(new AppError('BROKER_ERROR')),
      },
      recorder(record, 'taps-firehose'),
      recorder(record, 'flush'),
    ]);
    const started = clock.monotonic();

    const pending = coordinator.drain('sigterm', 2000);
    await timers.advance(2000);
    const results = await pending;

    expect(results).toEqual([
      { phase: 'gate', ms: 0, ok: true },
      { phase: 'peeks', ms: 600, ok: false, timedOut: true },
      { phase: 'sources-jobs', ms: 0, ok: false, error: 'BROKER_ERROR' },
      { phase: 'taps-firehose', ms: 0, ok: true },
      { phase: 'flush', ms: 0, ok: true },
    ]);
    expect(seen.order).toEqual(['gate', 'taps-firehose', 'flush']);
    const flush = seen.contexts.get('flush');
    expect(flush?.budgetMs).toBe(200);
    // Peeks was cut off at 600 ms, so flush started then and was due 200 ms later.
    expect(flush?.deadline).toBe(started + 600 + 200);
    expect(clock.monotonic() - started).toBeLessThanOrEqual(2000);
  });

  it('drain does not let a late start of one phase take the budget of the phases after it', async () => {
    const { seen, coordinator, clock, timers } = setup((record) => [
      {
        name: 'gate',
        run: () => {
          // The event loop stalls for 1.9 s inside the first phase.
          clock.advance(1900);
          return Promise.resolve();
        },
      },
      {
        name: 'peeks',
        run: (ctx) => {
          record.contexts.set('peeks', ctx);
          return new Promise<void>(() => undefined);
        },
      },
      recorder(record, 'flush'),
    ]);
    const started = clock.monotonic();

    const pending = coordinator.drain('quit', 2000);
    await timers.settle(); // the gate stalls the clock, then peeks starts
    await timers.advance(0);
    const results = await pending;

    // Peeks must leave sources-jobs, taps-firehose and flush their share: it gets nothing, and
    // every deadline stays inside the 2000 ms the caller allowed.
    expect(seen.contexts.get('peeks')?.budgetMs).toBe(0);
    expect(seen.contexts.get('flush')?.deadline).toBe(started + 2000);
    expect(results.find((r) => r.phase === 'peeks')).toMatchObject({
      ok: false,
      timedOut: true,
    });
    expect(results.at(-1)).toMatchObject({ phase: 'flush', ok: true });
  });

  it('drain scales every budget with the total it is given', async () => {
    const long = setup(allPhases);
    const short = setup(allPhases);

    await long.coordinator.drain('sigterm', 20_000);
    await short.coordinator.drain('suspend', 1000);

    expect(long.seen.contexts.get('sources-jobs')?.budgetMs).toBe(8000);
    expect(long.seen.contexts.get('flush')?.budgetMs).toBe(2000);
    expect(short.seen.contexts.get('sources-jobs')?.budgetMs).toBe(400);
    expect(short.seen.contexts.get('peeks')?.budgetMs).toBe(300);
  });

  it('drain runs only the contributions that apply to the reason and reports the rest as skipped', async () => {
    const { seen, coordinator } = setup((record) => [
      recorder(record, 'gate', ['quit', 'sigterm', 'emergency']),
      recorder(record, 'peeks'),
      recorder(record, 'flush', ['quit', 'sigterm', 'emergency']),
    ]);

    const results = await coordinator.drain('suspend', 1000);

    expect(seen.order).toEqual(['peeks']);
    expect(results.map((r) => [r.phase, r.skipped === true])).toEqual([
      ['gate', true],
      ['peeks', false],
      ['sources-jobs', true],
      ['taps-firehose', true],
      ['flush', true],
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('drain starts the contributions of one phase together and cuts them off at one deadline', async () => {
    const started: string[] = [];
    const { coordinator, timers } = setup(() => [
      {
        name: 'peeks',
        run: () => {
          started.push('a');
          return new Promise<void>(() => undefined);
        },
      },
      {
        name: 'peeks',
        run: () => {
          started.push('b');
          return Promise.resolve();
        },
      },
    ]);

    const pending = coordinator.drain('quit', 2000);
    await timers.settle();
    expect(started).toEqual(['a', 'b']);
    await timers.advance(2000);

    expect((await pending).find((r) => r.phase === 'peeks')).toMatchObject({
      ok: false,
      timedOut: true,
      ms: 600,
    });
  });

  it('a drain called while one is running returns that one instead of starting again', async () => {
    let runs = 0;
    const { coordinator, timers } = setup(() => [
      {
        name: 'peeks',
        run: async () => {
          runs += 1;
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 5);
          });
        },
      },
    ]);

    const first = coordinator.drain('sigterm', 2000);
    const second = coordinator.drain('emergency', 100);
    await timers.settle();

    expect(second).toBe(first);
    expect(await first).toHaveLength(5);
    expect(runs).toBe(1);

    // Once it has ended, a later drain (a suspend, then a quit) runs again.
    await coordinator.drain('quit', 2000);
    expect(runs).toBe(2);
  });

  it('reports an error by its Problem code and logs no message', async () => {
    const lines: unknown[] = [];
    const logger = {
      warn: (fields: unknown) => lines.push(fields),
    } as unknown as Logger;
    const { coordinator } = setup(
      () => [
        {
          name: 'flush',
          run: () => Promise.reject(new Error('password=hunter2')),
        },
      ],
      logger,
    );

    const results = await coordinator.drain('quit', 2000);

    expect(results.at(-1)).toMatchObject({ ok: false, error: 'INTERNAL' });
    expect(JSON.stringify(lines)).not.toContain('hunter2');
    expect(lines).toEqual([
      {
        event: 'drain.phase.failed',
        phase: 'flush',
        reason: 'quit',
        timedOut: false,
        code: 'INTERNAL',
      },
    ]);
  });

  it('refuses an unknown phase, a missing total and a total that is not positive', async () => {
    const clock = createManualClock();
    const timers = createManualTimers(clock);
    expect(() =>
      createDrainCoordinator({
        phases: [
          { name: 'nope' as DrainPhaseName, run: () => Promise.resolve() },
        ],
        clock,
        timers,
      }),
    ).toThrow(TypeError);
    const coordinator = createDrainCoordinator({ phases: [], clock, timers });

    await expect(coordinator.drain('quit', 0)).rejects.toThrow(RangeError);
    await expect(coordinator.drain('quit', Number.NaN)).rejects.toThrow(
      RangeError,
    );
    await expect(coordinator.drain('quit', -5)).rejects.toThrow(RangeError);
  });

  it('the gate phase refuses new mutations on quit and only freezes them on suspend', async () => {
    const quit = createTestExecutor();
    const suspend = createTestExecutor();
    const gate = (executor: ReturnType<typeof createTestExecutor>) =>
      createDrainCoordinator({
        phases: [executorGatePhase(executor.executor)],
        clock: executor.clock,
        timers: createManualTimers(executor.clock),
      });

    await gate(quit).drain('quit', 2000);
    await gate(suspend).drain('suspend', 1000);

    expect(quit.executor.state()).toBe('draining');
    expect(suspend.executor.state()).toBe('frozen-partial');
    suspend.executor.unfreeze();
    expect(suspend.executor.state()).toBe('accepting');
  });
});
