// The collector: demand-driven rounds per connection (blueprint section 8). A `touch` is demand; it
// starts a loop that plans (planner), reads (Prometheus through the scheduler, or the management API
// as the fallback), merges the nodes (ingest) and stores (store-hot), then waits the planned interval.
// No demand for `idleStopMs` ends the loop with no timer left; `stop()` aborts what is running.
//
// Every request goes out in the background lane through a scheduled port, so the BrokerScheduler's
// one-background-request rule, its spacing and its back-off apply (I-8); this loop adds its own
// cadence on top and never retries inside a round.
//
// The fallback: a plan whose every target failed `failuresBeforeFallback` rounds in a row is replaced
// by management sampling for `fallbackCooldownMs`; then Prometheus is tried once, and one more
// failure returns to the fallback at once (OQ-866).
import {
  ErrorCodeSchema,
  type ConnectionId,
  type MetricsStatusSchema,
  type Problem,
} from '@app/contracts';
import { BrokerProfileSchema, type BrokerProfile } from '@app/domain-model';
import {
  AppError,
  systemClock,
  systemTimers,
  toProblem,
  type Clock,
  type Timers,
} from '@app/kernel';
import type { z } from 'zod';

import { DEFAULT_METRICS_LIMITS, type MetricsModuleDeps } from '../deps';

import { wantedFamily } from './catalog';
import { beginRound } from './ingest';
import { sampleManagement } from './mgmt-sampler';
import {
  MANAGEMENT_HISTORY_KEY,
  planScrape,
  type PartialReason,
  type QueueDemand,
  type ScrapePlan,
  type TargetHistory,
} from './scrape-planner';
import { createHotStore, queueKeyOf, type HotStore } from './store-hot';

export type CollectorStatus = z.infer<typeof MetricsStatusSchema>;

export interface RoundOutcome {
  readonly ended: 'complete' | 'partial' | 'failed';
  readonly source: 'prometheus' | 'management' | 'none';
  readonly stored: number;
  readonly requests: number;
  /** Targets that did not answer in this round. */
  readonly failedTargets: number;
  readonly problem?: Problem;
}

export interface Collector {
  /** Demand: starts the first round and keeps the connection collected until `idleStopMs` passes. */
  touch(cid: ConnectionId, queues?: readonly QueueDemand[]): void;
  /** One round now, single-flight per connection. */
  roundNow(cid: ConnectionId, signal: AbortSignal): Promise<RoundOutcome>;
  readonly store: HotStore;
  status(cid: ConnectionId): CollectorStatus;
  /** Called after every round, whether it stored something or not (the status may have changed). */
  onRound(
    cid: ConnectionId,
    listener: (outcome: RoundOutcome) => void,
  ): () => void;
  /** Stops every loop and timer and aborts the requests in flight. */
  stop(): Promise<void>;
}

export type CollectorDeps = Pick<
  MetricsModuleDeps,
  'prom' | 'mgmt' | 'profiles' | 'clock' | 'timers' | 'limits'
>;

interface State {
  readonly abort: AbortController;
  inflight: Promise<RoundOutcome> | undefined;
  cancelTimer: (() => void) | undefined;
  auto: boolean;
  lastDemand: number;
  readonly demand: Map<string, { queue: QueueDemand; seen: number }>;
  readonly history: Map<string, TargetHistory>;
  failedRounds: number;
  fallbackUntil: number | undefined;
  plan: ScrapePlan | undefined;
  last: RoundOutcome | undefined;
  droppedSamples: number;
  readonly listeners: Set<(outcome: RoundOutcome) => void>;
}

/** A fixed Problem per failure class: broker text never reaches an output (I-10). */
function roundProblem(error: unknown, aborted: boolean): Problem {
  if (aborted) {
    return toProblem(
      new AppError('ENGINE_SHUTTING_DOWN', {
        detail: 'The metrics collection was cancelled.',
      }),
    );
  }
  const code = ErrorCodeSchema.safeParse(
    (error as { code?: unknown } | null)?.code,
  );
  return toProblem(
    new AppError(code.success ? code.data : 'BROKER_ERROR', {
      detail: 'Reading the metrics failed.',
    }),
  );
}

export function createCollector(deps: CollectorDeps): Collector {
  const clock: Clock = deps.clock ?? systemClock;
  const timers: Timers = deps.timers ?? systemTimers;
  const limits = { ...DEFAULT_METRICS_LIMITS, ...deps.limits };
  const store = createHotStore(limits);
  const states = new Map<ConnectionId, State>();
  let stopped = false;

  const stateOf = (cid: ConnectionId): State => {
    let state = states.get(cid);
    if (state === undefined) {
      state = {
        abort: new AbortController(),
        inflight: undefined,
        cancelTimer: undefined,
        auto: false,
        lastDemand: clock.monotonic(),
        demand: new Map(),
        history: new Map(),
        failedRounds: 0,
        fallbackUntil: undefined,
        plan: undefined,
        last: undefined,
        droppedSamples: 0,
        listeners: new Set(),
      };
      states.set(cid, state);
    }
    return state;
  };

  /** The queues somebody still wants: recent demand, at most `maxPinnedQueues`, newest first. */
  function demanded(state: State): QueueDemand[] {
    const now = clock.monotonic();
    for (const [key, entry] of state.demand) {
      if (now - entry.seen > limits.idleStopMs) state.demand.delete(key);
    }
    return [...state.demand.values()]
      .sort((a, b) => b.seen - a.seen)
      .slice(0, limits.maxPinnedQueues)
      .map((entry) => entry.queue);
  }

  async function readProfile(cid: ConnectionId): Promise<BrokerProfile> {
    const record = await deps.profiles.get(cid);
    const parsed = BrokerProfileSchema.safeParse(record?.profile);
    if (!parsed.success) {
      throw new AppError('NOT_FOUND', {
        detail: 'This connection has not been probed yet. Run the probe first.',
      });
    }
    return parsed.data;
  }

  async function prometheusRound(
    cid: ConnectionId,
    state: State,
    plan: Extract<ScrapePlan, { source: 'prometheus' }>,
    wantedQueues: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<RoundOutcome> {
    const round = beginRound(limits, wantedQueues);
    let requests = 0;
    let failedTargets = 0;
    let firstFailure: unknown;
    for (const target of plan.targets) {
      const began = clock.monotonic();
      try {
        for (const step of target.steps) {
          signal.throwIfAborted();
          requests++;
          const summary = await deps.prom.read(
            {
              connectionId: cid,
              node: target.node,
              endpoint: target.endpoint,
              path: step.path,
              ...(step.query === undefined ? {} : { query: step.query }),
              lane: 'background',
            },
            (sample) => {
              round.add(target.node, sample);
            },
            {
              wanted: wantedFamily,
              accept: (sample) => round.accepts(sample),
              maxSamples: limits.maxSamplesPerScrape,
              maxBodyBytes: limits.maxBodyBytes,
            },
            signal,
          );
          if (summary.truncated !== undefined) state.droppedSamples++;
        }
        state.history.set(target.id, {
          lastDurationMs: clock.monotonic() - began,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        failedTargets++;
        firstFailure ??= error;
      }
    }
    if (failedTargets === plan.targets.length) {
      return {
        ended: 'failed',
        source: 'prometheus',
        stored: 0,
        requests,
        failedTargets,
        problem: roundProblem(firstFailure, false),
      };
    }
    const summary = round.commit(store, cid, clock.now(), {
      source: 'prometheus',
      approximate: false,
    });
    state.droppedSamples += summary.droppedSamples;
    return {
      ended: failedTargets > 0 ? 'partial' : 'complete',
      source: 'prometheus',
      stored: summary.stored,
      requests,
      failedTargets,
    };
  }

  async function managementRound(
    cid: ConnectionId,
    state: State,
    plan: Extract<ScrapePlan, { source: 'management' }>,
    signal: AbortSignal,
  ): Promise<RoundOutcome> {
    const began = clock.monotonic();
    try {
      const sampled = await sampleManagement(
        deps.mgmt,
        cid,
        plan.queues,
        signal,
      );
      state.history.set(MANAGEMENT_HISTORY_KEY, {
        lastDurationMs: clock.monotonic() - began,
      });
      const at = clock.now();
      let stored = 0;
      for (const point of sampled.points) {
        if (
          store.append(
            cid,
            point.parts,
            { source: 'management', approximate: point.approximate },
            { t: at, v: point.value },
          )
        ) {
          stored++;
        }
      }
      store.endRound(cid);
      return {
        ended: 'complete',
        source: 'management',
        stored,
        requests: sampled.requests,
        failedTargets: 0,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      return {
        ended: 'failed',
        source: 'management',
        stored: 0,
        requests: 0,
        failedTargets: 1,
        problem: roundProblem(error, false),
      };
    }
  }

  async function round(
    cid: ConnectionId,
    state: State,
    signal: AbortSignal,
  ): Promise<RoundOutcome> {
    let outcome: RoundOutcome;
    try {
      const profile = await readProfile(cid);
      const now = clock.monotonic();
      if (state.fallbackUntil !== undefined && now >= state.fallbackUntil) {
        // The cool-down is over: Prometheus is tried once, and one failure returns to the fallback.
        state.fallbackUntil = undefined;
        state.failedRounds = Math.max(0, limits.failuresBeforeFallback - 1);
      }
      const queues = demanded(state);
      store.pin(cid, queues);
      const plan = planScrape({
        profile,
        queues,
        history: state.history,
        fallback: state.fallbackUntil !== undefined,
        limits,
      });
      state.plan = plan;
      outcome =
        plan.source === 'prometheus'
          ? await prometheusRound(
              cid,
              state,
              plan,
              new Set(queues.map((q) => queueKeyOf(q.vhost, q.name))),
              signal,
            )
          : await managementRound(cid, state, plan, signal);
      if (plan.source === 'prometheus') {
        if (outcome.ended === 'failed') {
          state.failedRounds++;
          if (state.failedRounds >= limits.failuresBeforeFallback) {
            state.fallbackUntil = now + limits.fallbackCooldownMs;
          }
        } else {
          state.failedRounds = 0;
        }
      }
    } catch (error) {
      outcome = {
        ended: 'failed',
        source: state.plan?.source ?? 'none',
        stored: 0,
        requests: 0,
        failedTargets: 0,
        problem: roundProblem(error, signal.aborted),
      };
    }
    state.last = outcome;
    for (const listener of [...state.listeners]) {
      try {
        listener(outcome);
      } catch {
        // A listener must never break the loop that feeds it.
      }
    }
    return outcome;
  }

  function roundNow(
    cid: ConnectionId,
    signal: AbortSignal,
  ): Promise<RoundOutcome> {
    const state = stateOf(cid);
    if (stopped) {
      return Promise.resolve({
        ended: 'failed',
        source: 'none',
        stored: 0,
        requests: 0,
        failedTargets: 0,
        problem: roundProblem(undefined, true),
      });
    }
    state.inflight ??= round(
      cid,
      state,
      AbortSignal.any([signal, state.abort.signal]),
    ).finally(() => {
      state.inflight = undefined;
    });
    return state.inflight;
  }

  function cycle(cid: ConnectionId, state: State): void {
    state.cancelTimer = undefined;
    if (stopped) return;
    // No demand for `idleStopMs` ends the loop, with no timer left; a later `touch` starts it again.
    if (clock.monotonic() - state.lastDemand >= limits.idleStopMs) {
      state.auto = false;
      return;
    }
    void roundNow(cid, state.abort.signal).then(() => {
      if (stopped) return;
      state.cancelTimer = timers.setTimer(() => {
        cycle(cid, state);
      }, state.plan?.intervalMs ?? limits.baseIntervalMs);
    });
  }

  return {
    store,
    touch(cid, queues = []) {
      if (stopped) return;
      const state = stateOf(cid);
      const now = clock.monotonic();
      state.lastDemand = now;
      for (const queue of queues) {
        state.demand.set(queueKeyOf(queue.vhost, queue.name), {
          queue,
          seen: now,
        });
      }
      // Bounded (I-6): the oldest wishes go first.
      if (state.demand.size > limits.maxPinnedQueues * 2) {
        const oldest = [...state.demand]
          .sort(([, a], [, b]) => a.seen - b.seen)
          .slice(0, state.demand.size - limits.maxPinnedQueues);
        for (const [key] of oldest) state.demand.delete(key);
      }
      if (!state.auto) {
        state.auto = true;
        cycle(cid, state);
      }
    },
    roundNow,
    status(cid) {
      const state = states.get(cid);
      const held = store.status(cid);
      const plan = state?.plan;
      const intervalMs = plan?.intervalMs ?? limits.baseIntervalMs;
      const partial: PartialReason[] = [...(plan?.partial ?? [])];
      if (
        (state?.last?.failedTargets ?? 0) > 0 &&
        plan?.source === 'prometheus'
      ) {
        partial.push('targets-unreachable');
      }
      let health: CollectorStatus['state'];
      if (state?.last === undefined) {
        health = state?.auto === true ? 'loading' : 'unavailable';
      } else if (held.newest === undefined) {
        health = state.last.ended === 'failed' ? 'unavailable' : 'loading';
      } else {
        health =
          clock.now() - held.newest > limits.staleAfterIntervals * intervalMs
            ? 'stale'
            : 'live';
      }
      return {
        state: health,
        source: plan?.source ?? 'none',
        ...(held.newest === undefined ? {} : { asOf: held.newest }),
        ...(plan === undefined ? {} : { intervalMs }),
        partial,
        ...(plan?.source === 'management'
          ? { fallbackReason: plan.reason }
          : {}),
        approximate: plan?.source === 'management',
        dropped: {
          points: held.droppedPoints,
          series: held.droppedSeries,
          samples: state?.droppedSamples ?? 0,
        },
      };
    },
    onRound(cid, listener) {
      const state = stateOf(cid);
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    },
    async stop() {
      stopped = true;
      for (const state of states.values()) {
        state.auto = false;
        state.cancelTimer?.();
        state.abort.abort();
      }
      for (const state of states.values()) await state.inflight;
    },
  };
}
