// The DrainCoordinator (M0-31, blueprint 1.1, DC-04, DC-46): the budgeted shutdown used on quit,
// SIGTERM, suspend and emergency. It runs five phases in a fixed order, each with its own budget:
//
//   gate           the executor stops taking new work                      10 ms
//   peeks          holders nack and wait for the qos barrier              600 ms
//   sources-jobs   jobs stop at a checkpoint, sources are parked or acked  800 ms
//   taps-firehose  taps are cancelled, firehose leases switched off         300 ms
//   flush          journal, receipts, audit, WAL checkpoint, close the DB   200 ms
//
// The budgets are for a 2 s drain and scale with `totalMs` (a team server drains for 20 s). What
// the coordinator guarantees, whatever a phase does:
//   - a phase that overruns is cut off at its deadline (it keeps running in the background, but
//     the drain does not wait for it) and is reported `timedOut`;
//   - a phase that throws is reported `ok: false` and never stops the phases after it;
//   - a phase's deadline leaves every later phase its own budget, so `flush` always starts with the
//     whole of its 200 ms (scaled), even when `peeks` and `sources-jobs` used all of theirs.
// Several modules can contribute to one phase; their `run`s start together and share its deadline.
import type { Clock } from '../clock/clock.ts';
import type { Logger } from '../log/logger.ts';
import { toProblem } from '../problem/problem.ts';
import type { ActionExecutor } from '../actions/executor.ts';
import type { Timers } from '../scheduler/timers.ts';

export type DrainReason = 'quit' | 'sigterm' | 'suspend' | 'emergency';

/** The phases, in the order they run. */
export const DRAIN_PHASE_ORDER = [
  'gate',
  'peeks',
  'sources-jobs',
  'taps-firehose',
  'flush',
] as const;
export type DrainPhaseName = (typeof DRAIN_PHASE_ORDER)[number];

/** Each phase's budget for a drain of `NOMINAL_DRAIN_MS` (blueprint 1.1); the rest is slack. */
export const DEFAULT_DRAIN_BUDGETS_MS: Readonly<
  Record<DrainPhaseName, number>
> = Object.freeze({
  gate: 10,
  peeks: 600,
  'sources-jobs': 800,
  'taps-firehose': 300,
  flush: 200,
});
export const NOMINAL_DRAIN_MS = 2000;

export interface DrainContext {
  readonly reason: DrainReason;
  /** The instant, on `Clock.monotonic`, by which the phase must be done. */
  readonly deadline: number;
  /** Milliseconds from now to `deadline`. */
  readonly budgetMs: number;
}

/** What a module contributes to one phase. */
export interface DrainPhaseSpec {
  readonly name: DrainPhaseName;
  run(ctx: DrainContext): Promise<void>;
  /** The reasons this contribution runs for. Default: all. */
  readonly reasons?: readonly DrainReason[];
}

export interface DrainResult {
  readonly phase: DrainPhaseName;
  /** Milliseconds the phase took (on the monotonic clock), at most its budget. */
  readonly ms: number;
  readonly ok: boolean;
  /** No module contributed to this phase for this reason. */
  readonly skipped?: true;
  /** The phase did not finish by its deadline. */
  readonly timedOut?: true;
  /** The error code of the first contribution that threw. */
  readonly error?: string;
}

export interface DrainCoordinatorOptions {
  phases: readonly DrainPhaseSpec[];
  clock: Clock;
  timers: Timers;
  logger?: Logger;
}

export interface DrainCoordinator {
  /**
   * Runs the phases for `reason` within `totalMs`. A drain that is already running is not started
   * again: the caller gets the running one's results (a second SIGTERM must not restart it).
   */
  drain(reason: DrainReason, totalMs: number): Promise<readonly DrainResult[]>;
}

function isName(value: string): value is DrainPhaseName {
  return (DRAIN_PHASE_ORDER as readonly string[]).includes(value);
}

export function createDrainCoordinator(
  options: DrainCoordinatorOptions,
): DrainCoordinator {
  const { clock, timers, logger } = options;
  for (const spec of options.phases) {
    if (!isName(spec.name)) {
      throw new TypeError(`Unknown drain phase "${String(spec.name)}".`);
    }
  }
  const specs = [...options.phases];
  let running: Promise<readonly DrainResult[]> | undefined;

  /** Runs the contributions together; settles at the deadline, or when all have settled. */
  async function runPhase(
    name: DrainPhaseName,
    contributions: readonly DrainPhaseSpec[],
    ctx: DrainContext,
  ): Promise<DrainResult> {
    const started = clock.monotonic();
    let timedOut = false;
    let cancelTimer: (() => void) | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      cancelTimer = timers.setTimer(() => {
        resolve('timeout');
      }, ctx.budgetMs);
    });
    const failures: unknown[] = [];
    // Each contribution's own failure is caught here, so `all` never rejects, and a contribution
    // that fails after the deadline cannot become an unhandled rejection.
    const all = Promise.all(
      contributions.map((contribution) =>
        Promise.resolve()
          .then(() => contribution.run(ctx))
          .catch((error: unknown) => {
            failures.push(error);
          }),
      ),
    ).then(() => 'done' as const);
    try {
      timedOut = (await Promise.race([all, deadline])) === 'timeout';
    } finally {
      cancelTimer?.();
    }
    const ms = clock.monotonic() - started;
    const first = failures[0];
    const error = first === undefined ? undefined : toProblem(first).code;
    if (timedOut || error !== undefined) {
      logger?.warn(
        {
          event: 'drain.phase.failed',
          phase: name,
          reason: ctx.reason,
          timedOut,
          ...(error === undefined ? {} : { code: error }),
        },
        'a drain phase did not finish cleanly',
      );
    }
    return {
      phase: name,
      ms,
      ok: !timedOut && error === undefined,
      ...(timedOut ? { timedOut: true as const } : {}),
      ...(error === undefined ? {} : { error }),
    };
  }

  async function run(
    reason: DrainReason,
    totalMs: number,
  ): Promise<readonly DrainResult[]> {
    const scale = totalMs / NOMINAL_DRAIN_MS;
    const hardDeadline = clock.monotonic() + totalMs;
    const plan = DRAIN_PHASE_ORDER.map((name) => ({
      name,
      contributions: specs.filter(
        (spec) =>
          spec.name === name &&
          (spec.reasons === undefined || spec.reasons.includes(reason)),
      ),
      budget: Math.floor(DEFAULT_DRAIN_BUDGETS_MS[name] * scale),
    }));
    const results: DrainResult[] = [];
    for (const [index, phase] of plan.entries()) {
      if (phase.contributions.length === 0) {
        results.push({ phase: phase.name, ms: 0, ok: true, skipped: true });
        continue;
      }
      const reserved = plan
        .slice(index + 1)
        .filter((later) => later.contributions.length > 0)
        .reduce((sum, later) => sum + later.budget, 0);
      const start = clock.monotonic();
      const deadline = Math.max(
        start,
        Math.min(start + phase.budget, hardDeadline - reserved),
      );
      results.push(
        await runPhase(phase.name, phase.contributions, {
          reason,
          deadline,
          budgetMs: deadline - start,
        }),
      );
    }
    return results;
  }

  return {
    drain(reason, totalMs) {
      if (!Number.isFinite(totalMs) || totalMs <= 0) {
        return Promise.reject(
          new RangeError('drain(reason, totalMs) needs a positive totalMs.'),
        );
      }
      if (running !== undefined) return running;
      const current = run(reason, totalMs).finally(() => {
        running = undefined;
      });
      running = current;
      return current;
    },
  };
}

/**
 * The `gate` phase for an executor: new mutations are refused with `ENGINE_SHUTTING_DOWN` (quit,
 * SIGTERM, emergency) or `FROZEN` (suspend: the engine comes back, so the gate must be liftable).
 */
export function executorGatePhase(
  executor: Pick<ActionExecutor, 'beginDrain' | 'freeze'>,
): DrainPhaseSpec {
  return {
    name: 'gate',
    run: ({ reason }) => {
      if (reason === 'suspend') executor.freeze();
      else executor.beginDrain();
      return Promise.resolve();
    },
  };
}
