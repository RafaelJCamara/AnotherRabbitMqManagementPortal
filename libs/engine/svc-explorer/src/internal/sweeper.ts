// The only code that lists the broker for the explorer, and it lists in the `background` lane (I-8):
// per vhost, paged at 500, with the statistics-off flags. A finished kind is installed as a new
// index version; a failed, aborted or partial read never replaces a good one (AC-4). Demand starts
// the sweeps; `stop()` ends them.
import {
  ErrorCodeSchema,
  type ConnectionId,
  type SweptKind,
  type Problem,
} from '@app/contracts';
import {
  AppError,
  systemClock,
  systemTimers,
  toProblem,
  type Clock,
  type Timers,
} from '@app/kernel';
import type { MgmtQuery } from '@app/ports';
import type { z } from 'zod';

import { DEFAULT_EXPLORER_LIMITS, type ExplorerModuleDeps } from '../deps';

import {
  createInventoryIndex,
  KINDS,
  type IndexChange,
  type IndexVersion,
  type InventoryIndex,
} from './index';
import {
  ConnectionPageSchema,
  connectionRow,
  ExchangePageSchema,
  exchangeRow,
  QueuePageSchema,
  queueRow,
  VhostListSchema,
  type IndexRow,
} from './rows';

/** The broker's own page ceiling; `pageSize` is never above it. */
const PAGE_SIZE_CEILING = 500;

type Entry = Parameters<InventoryIndex['installAll']>[0][number];

export interface SweepOutcome {
  ended: 'complete' | 'partial' | 'failed';
  requests: number;
  /** Sum of the request durations, measured with the injected Clock. */
  serverTimeMs: number;
  /** Vhosts past `maxVhostsPerSweep`, counted and not swept. */
  skippedVhosts: number;
  /**
   * Rows that repeated the key of an earlier row of the same kind and were left out, counted (I-13).
   * The management paging is not a snapshot, so a queue created or deleted between two pages can
   * send one key twice and miss another; the kind is then installed incomplete.
   */
  duplicates: number;
  problem?: Problem;
}

export interface Sweeper {
  /** Demand: starts the first sweep and keeps the connection swept until `idleStopMs` passes without demand. */
  touch(cid: ConnectionId): void;
  index(cid: ConnectionId): InventoryIndex | undefined;
  /** One sweep now, single-flight per connection (a second call joins the one in flight). */
  sweepNow(cid: ConnectionId, signal: AbortSignal): Promise<SweepOutcome>;
  onInstall(
    cid: ConnectionId,
    listener: (change: IndexChange) => void,
  ): () => void;
  /** What a reader needs to tell a first load from a settled index (I-13). */
  status(cid: ConnectionId): SweepStatus;
  /** Stops every sweep and timer and aborts the requests in flight. */
  stop(): Promise<void>;
}

export interface SweepStatus {
  /** A sweep is running now. */
  sweeping: boolean;
  /** The broker's own object count per kind, as far as the current or last sweep has read it. */
  expected: ReadonlyMap<SweptKind, number>;
}

export type SweeperDeps = Pick<
  ExplorerModuleDeps,
  'mgmt' | 'clock' | 'timers' | 'limits'
>;

interface State {
  readonly index: InventoryIndex;
  readonly abort: AbortController;
  inflight?: Promise<SweepOutcome> | undefined;
  cancelTimer?: (() => void) | undefined;
  auto: boolean;
  /** The monotonic time of the last `touch`; the idle stop counts from it. */
  lastDemand: number;
  expected: Map<SweptKind, number>;
}

/** A fixed Problem per failure class: broker text never reaches an output (I-10). */
function sweepProblem(error: unknown, aborted: boolean): Problem {
  if (aborted) {
    return toProblem(
      new AppError('ENGINE_SHUTTING_DOWN', {
        detail: 'The inventory sweep was cancelled.',
      }),
    );
  }
  const code = ErrorCodeSchema.safeParse(
    (error as { code?: unknown } | null)?.code,
  );
  return toProblem(
    new AppError(code.success ? code.data : 'BROKER_ERROR', {
      detail: 'The inventory sweep failed.',
    }),
  );
}

export function createSweeper(deps: SweeperDeps): Sweeper {
  const clock: Clock = deps.clock ?? systemClock;
  const timers: Timers = deps.timers ?? systemTimers;
  const limits = { ...DEFAULT_EXPLORER_LIMITS, ...deps.limits };
  const pageSize = Math.min(limits.pageSize, PAGE_SIZE_CEILING);
  const states = new Map<ConnectionId, State>();
  let stopped = false;

  const stateOf = (cid: ConnectionId): State => {
    let state = states.get(cid);
    if (state === undefined) {
      state = {
        index: createInventoryIndex(limits),
        abort: new AbortController(),
        auto: false,
        lastDemand: clock.monotonic(),
        expected: new Map(),
      };
      states.set(cid, state);
    }
    return state;
  };

  async function sweep(
    cid: ConnectionId,
    state: State,
    signal: AbortSignal,
  ): Promise<SweepOutcome> {
    const outcome: SweepOutcome = {
      ended: 'failed',
      requests: 0,
      serverTimeMs: 0,
      skippedVhosts: 0,
      duplicates: 0,
    };
    const get = async <T>(
      path: string,
      query: MgmtQuery,
      schema: z.ZodType<T>,
    ): Promise<T> => {
      signal.throwIfAborted();
      const began = clock.monotonic();
      outcome.requests++;
      try {
        return await deps.mgmt.get(
          { connectionId: cid, path, query, schema, lane: 'background' },
          signal,
        );
      } finally {
        outcome.serverTimeMs += clock.monotonic() - began;
      }
    };
    // `vhost` is undefined for the connections: one global list, not one per vhost.
    const readPage = async (
      kind: SweptKind,
      vhost: string | undefined,
      n: number,
    ) => {
      const query = { page: n, page_size: pageSize, disable_stats: true };
      if (kind === 'connections' || vhost === undefined) {
        const answer = await get(
          '/api/connections',
          query,
          ConnectionPageSchema,
        );
        return {
          rows: answer.items.map(connectionRow),
          pages: answer.page_count,
          total: answer.total_count,
        };
      }
      const path = `/api/${kind}/${encodeURIComponent(vhost)}`;
      if (kind === 'queues') {
        const answer = await get(
          path,
          { ...query, enable_queue_totals: true },
          QueuePageSchema,
        );
        return {
          rows: answer.items.map(queueRow),
          pages: answer.page_count,
          total: answer.total_count,
        };
      }
      const answer = await get(path, query, ExchangePageSchema);
      return {
        rows: answer.items.map(exchangeRow),
        pages: answer.page_count,
        total: answer.total_count,
      };
    };

    const sweptAt = clock.now();
    const commits: Entry[] = [];
    let installed = 0;
    let latest: IndexVersion | undefined;
    let failure: unknown;
    try {
      const all = await get('/api/vhosts', {}, VhostListSchema);
      const vhosts = all.slice(0, limits.maxVhostsPerSweep).map((v) => v.name);
      outcome.skippedVhosts = all.length - vhosts.length;
      for (const kind of KINDS) {
        const staging: IndexRow[] = [];
        let overflow = 0;
        let counted: number | undefined = 0;
        // The connection list spans every vhost, so skipped vhosts do not make it partial.
        const whole = kind === 'connections' || outcome.skippedVhosts === 0;
        for (const vhost of kind === 'connections' ? [undefined] : vhosts) {
          for (let n = 1; ; n++) {
            const { rows, pages, total } = await readPage(kind, vhost, n);
            if (n === 1) {
              counted =
                total === undefined || counted === undefined
                  ? undefined
                  : counted + total;
              // A first read shows how much is coming; a re-read keeps the old figure until it ends.
              if (counted !== undefined && !state.index.has(kind)) {
                state.expected.set(kind, counted);
              }
            }
            for (const row of rows) {
              if (staging.length < limits.maxRowsPerConnection) {
                staging.push(row);
              } else {
                overflow++;
              }
            }
            if (n >= pages || rows.length === 0) break;
          }
        }
        if (counted !== undefined && whole) {
          state.expected.set(kind, counted);
        } else {
          state.expected.delete(kind);
        }
        const entry = {
          kind,
          rows: staging,
          meta: {
            sweptAt,
            complete: whole,
            extraDropped: overflow,
          },
        };
        // A kind that already has a good version waits until every kind is read (one new version
        // for the whole sweep); a first read is installed at once, so the explorer can show what is
        // loaded while it says it is partial.
        if (state.index.has(kind)) {
          commits.push(entry);
        } else {
          latest = state.index.installAll([entry]);
          installed++;
        }
      }
      if (commits.length > 0) latest = state.index.installAll(commits);
      installed += commits.length;
      // The last install of the sweep holds every kind this sweep read: its repeats are this sweep's.
      outcome.duplicates = latest?.duplicates ?? 0;
    } catch (error) {
      failure = error;
    }
    state.index.setStale(failure !== undefined);
    if (failure === undefined) {
      // A repeated key is a read that moved under the paging: partial, like a skipped vhost.
      outcome.ended =
        outcome.skippedVhosts > 0 || outcome.duplicates > 0
          ? 'partial'
          : 'complete';
    } else {
      outcome.ended = installed > 0 ? 'partial' : 'failed';
      outcome.problem = sweepProblem(failure, signal.aborted);
    }
    return outcome;
  }

  function sweepNow(
    cid: ConnectionId,
    signal: AbortSignal,
  ): Promise<SweepOutcome> {
    if (stopped) {
      return Promise.resolve({
        ended: 'failed',
        requests: 0,
        serverTimeMs: 0,
        skippedVhosts: 0,
        duplicates: 0,
        problem: sweepProblem(undefined, true),
      });
    }
    const state = stateOf(cid);
    state.inflight ??= sweep(
      cid,
      state,
      AbortSignal.any([signal, state.abort.signal]),
    ).finally(() => {
      state.inflight = undefined;
    });
    return state.inflight;
  }

  /**
   * The wait after a sweep: `sweepCostFactor` times its server time, kept between the minimum and the
   * maximum. A failed sweep waits by the same formula (never sooner), so a broker that fails fast is
   * not asked more often than the minimum; the request pacing of a failing broker is the
   * BrokerScheduler's own backoff (I-8), which this loop does not see.
   */
  const waitAfter = (serverTimeMs: number): number =>
    Math.min(
      limits.sweepMaxIntervalMs,
      Math.max(
        limits.sweepMinIntervalMs,
        limits.sweepCostFactor * serverTimeMs,
      ),
    );

  function cycle(cid: ConnectionId, state: State): void {
    state.cancelTimer = undefined;
    if (stopped) return;
    // No demand for `idleStopMs` ends the loop, with no timer left; a later `touch` starts it again.
    if (clock.monotonic() - state.lastDemand >= limits.idleStopMs) {
      state.auto = false;
      return;
    }
    void sweepNow(cid, state.abort.signal).then((outcome) => {
      if (stopped) return;
      state.cancelTimer = timers.setTimer(() => {
        cycle(cid, state);
      }, waitAfter(outcome.serverTimeMs));
    });
  }

  return {
    touch(cid) {
      if (stopped) return;
      const state = stateOf(cid);
      state.lastDemand = clock.monotonic();
      if (!state.auto) {
        state.auto = true;
        cycle(cid, state);
      }
    },
    index: (cid) => states.get(cid)?.index,
    sweepNow,
    onInstall: (cid, listener) => stateOf(cid).index.subscribe(listener),
    status(cid) {
      const state = states.get(cid);
      return {
        sweeping: state?.inflight !== undefined,
        expected: state?.expected ?? new Map(),
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
