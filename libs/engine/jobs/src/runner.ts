// The JobRunner (M0-31, ADR-015, blueprint 1.1 and 1.5): durable jobs that run as async generators
// with checkpoints, a lease, a throttle and a budgeted drain. One runner, one JobStore interface, the
// same semantics on desktop, local and team.
//
// What it guarantees (each has a test, and the store enforces the fencing):
//   - a job runs as its own `job` principal acting for whoever submitted it, never as someone else:
//     the requester is sealed with the input, so a row edited in the database does not change it;
//   - a job is claimed by one runner at a time, under a 30 s lease renewed every 10 s; a runner that
//     loses the lease aborts the job and cannot write to it again (the store fences every write by
//     owner and attempt);
//   - when a job is asked to stop (cancel, pause, shutdown, suspend, emergency) its `onDrain` runs
//     first, to park what it holds and checkpoint, within the budget; only then is the job released;
//     a stop wins over a normal return, so a job that was cut short is never recorded as succeeded;
//   - a job interrupted by a stop, a crash or a lost lease is `paused-interrupted`; it runs again
//     only after a resume (a person, or the runner for a `resumable` job when told to), and only
//     after its `preflight` allows it;
//   - nothing the store sees is readable: input, checkpoint and result are sealed, bound to the job id.
import type { JobId } from '@app/contracts';
import {
  AppError,
  isPrincipal,
  mayActFor,
  parseIdempotencyKey,
  snapshotPrincipal,
  toProblem,
  type Clock,
  type DrainPhaseSpec,
  type ExecutorWrite,
  type IdGenerator,
  type Logger,
  type PayloadCipher,
  type Timers,
} from '@app/kernel';
import type {
  JobLease,
  JobRecord,
  JobReleaseState,
  JobState,
  JobStore,
  Principal,
  ReplayJournal,
} from '@app/ports';

import { abortError } from './abort.ts';
import { isDefinedJob } from './define-job.ts';
import {
  openCheckpoint,
  openJobInput,
  sealCheckpoint,
  sealJobInput,
  sealResult,
} from './envelope.ts';
import { createTokenBucket, type TokenBucket } from './token-bucket.ts';
import type {
  JobCommand,
  JobContext,
  JobDef,
  JobDrainEntry,
  JobEvent,
  JobPreflight,
  JobRecoveryReport,
  JobRunnerStats,
  JobStopReason,
  OnDrainOutcome,
} from './types.ts';

/** The lease a claim takes, and how often it is renewed (blueprint 8, "Durable jobs"). */
export const LEASE_MS = 30_000;
export const HEARTBEAT_MS = 10_000;

const PLAN_HASH = /^[0-9a-f]{64}$/;
const MAX_CONCURRENCY_KEY = 200;
const RECOVER_PAGE = 100;
/** Interrupted jobs one `recover` looks at for automatic resume (I-7); the rest wait for a person. */
const MAX_AUTO_RESUME = 1000;

export interface JobRunnerOptions {
  store: JobStore;
  /** Seals what the store keeps (AES-256-GCM in production; see `@app/secrets`). */
  cipher: PayloadCipher;
  clock: Clock;
  timers: Timers;
  ids: IdGenerator;
  /** The write-capable ports; a job body gets them as `ctx.executorWrite` and nobody else does (I-2). */
  writes: ExecutorWrite;
  logger?: Logger;
  journal?: ReplayJournal;
  /** Names this runner's leases. Default: a random UUID. */
  owner?: string;
  leaseMs?: number;
  heartbeatMs?: number;
  /** How often to look for queued jobs when nothing wakes the runner. Default 1,000 ms. */
  pollMs?: number;
  /** Jobs running at once. Default 4. */
  maxConcurrent?: number;
  /** A job claimed more often than this is failed, not run again (a job that kills the engine). Default 5. */
  maxAttempts?: number;
  /** How long `pause` and `cancel` give a job to stop. Default 5,000 ms. */
  commandBudgetMs?: number;
  /** Kept back from a drain budget for writing the final state. Default 100 ms. */
  settleReserveMs?: number;
  /**
   * What `start` does with jobs the store still shows as running. `interrupt-all-running` is for an
   * engine that is the only one on its database (desktop and local hold the data-dir lock);
   * `interrupt-expired` leaves a running job whose lease is still valid to the runner that holds it.
   */
  recovery?: 'interrupt-expired' | 'interrupt-all-running';
  /** `resumable`: queue interrupted jobs that declared themselves resumable, after preflight (team). */
  autoResume?: 'never' | 'resumable';
  /** May this principal command a job it did not submit (an administrator)? Default: no. */
  mayOverride?: (principal: Principal, record: JobRecord) => boolean;
  /** A job's events, for the live hub. A throw is logged and ignored. */
  onEvent?: (jobId: JobId, event: JobEvent) => void;
  /** Every state the runner puts a job in. A throw is logged and ignored. */
  onState?: (jobId: JobId, state: JobState, reason: string | null) => void;
}

export interface JobRunner {
  /** Accepts only what `defineJob` returned, and each type once. */
  register(def: JobDef): void;
  /**
   * Stores a job for `requester` and returns its id. The same requester and idempotency key give the
   * same job again. `planHash` is the digest of the plan (or input hash) the job carries out.
   */
  submit(
    type: string,
    input: unknown,
    requester: Principal,
    options: { idempotencyKey: string; planHash: string },
  ): Promise<JobId>;
  /** The requester, whoever the requester acted for, and a job for them may command; so may `mayOverride`. */
  command(id: JobId, command: JobCommand, principal: Principal): Promise<void>;
  /** Recovers interrupted jobs, then starts claiming. */
  start(): Promise<JobRecoveryReport>;
  /** Interrupts what a crash left running and, when configured, queues resumable jobs again. */
  recover(): Promise<JobRecoveryReport>;
  /**
   * Stops claiming and stops every running job within `budgetMs` (see the header): `onDrain`, then
   * `paused-interrupted`. A submit is refused until `reopen`.
   */
  drain(
    reason: Exclude<JobStopReason, 'cancel'>,
    budgetMs: number,
  ): Promise<readonly JobDrainEntry[]>;
  /** Accepts and claims again after a `suspend` drain (a resume from sleep). */
  reopen(): Promise<JobRecoveryReport>;
  /** The `sources-jobs` phase of the DrainCoordinator. */
  drainPhase(): DrainPhaseSpec;
  stats(): JobRunnerStats;
}

const unavailableJournal: ReplayJournal = {
  append: () => Promise.reject(noJournal()),
  counts: () => Promise.reject(noJournal()),
  decideOnRedelivery: () => Promise.reject(noJournal()),
};
function noJournal(): AppError {
  return new AppError('INTERNAL', {
    detail: 'No replay journal is configured for jobs.',
  });
}

/** Why a job's signal was aborted. */
class JobStopped extends Error {
  constructor(readonly why: string) {
    super(`The job was stopped: ${why}.`);
    this.name = 'JobStopped';
  }
}

interface StopRequest {
  reason: JobStopReason;
  final: Extract<
    JobReleaseState,
    'paused' | 'paused-interrupted' | 'cancelled'
  >;
  /** The state reason stored with the job. */
  why: string;
}

/** A job this runner holds the lease of. */
interface Active {
  readonly record: JobRecord;
  readonly lease: JobLease;
  readonly def: JobDef;
  readonly controller: AbortController;
  settled: boolean;
  finalState: JobState | undefined;
  lost: boolean;
  started: boolean;
  stop: StopRequest | undefined;
  stopping: Promise<JobDrainEntry> | undefined;
  ctx: JobContext<unknown, unknown> | undefined;
  saving: Promise<unknown>;
  /** On the monotonic clock: when the lease ends unless a heartbeat is answered. */
  leaseDeadline: number;
  cancelHeartbeat: (() => void) | undefined;
  /** Resolved once the job's context is ready (true) or could not be built (false). */
  opened: Promise<boolean>;
  resolveOpened(ready: boolean): void;
  /** Resolved when `run` has ended or was given up on. */
  ended: Promise<void>;
  resolveEnded(): void;
  /**
   * Set while the run loop waits for the body's next step: settling the job calls it, so a loop
   * stuck on a body that never answers can move on. One slot, replaced at each step, so a body
   * that yields a million events does not pile up a million waiters.
   */
  wake: (() => void) | undefined;
  done: Promise<void> | undefined;
}

export function createJobRunner(options: JobRunnerOptions): JobRunner {
  const { store, cipher, clock, timers, ids, writes, logger } = options;
  const owner = options.owner ?? ids.uuid();
  const leaseMs = options.leaseMs ?? LEASE_MS;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const pollMs = options.pollMs ?? 1000;
  const maxConcurrent = options.maxConcurrent ?? 4;
  const maxAttempts = options.maxAttempts ?? 5;
  const commandBudgetMs = options.commandBudgetMs ?? 5000;
  const settleReserveMs = options.settleReserveMs ?? 100;
  if (!(heartbeatMs > 0 && leaseMs > heartbeatMs)) {
    throw new RangeError('The heartbeat must be shorter than the lease.');
  }
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new RangeError('maxConcurrent must be at least 1.');
  }

  const defs = new Map<string, JobDef>();
  const running = new Map<JobId, Active>();
  let accepting = false;
  let draining = false;
  let started = false;
  let pumping: Promise<void> | undefined;
  let pumpAgain = false;
  let cancelPoll: (() => void) | undefined;

  // ---- helpers ------------------------------------------------------------------------------
  // TypeScript keeps a narrowing across an `await`, but these change while a call is pending.
  const isSettled = (a: Active): boolean => a.settled;
  const stopOf = (a: Active): StopRequest | undefined => a.stop;
  const isAccepting = (): boolean => accepting;
  const isPumpRequested = (): boolean => pumpAgain;

  const conflict = (detail: string): AppError =>
    new AppError('VALIDATION_FAILED', { detail, status: 409 });

  /** `promise`, or `onTimeout` when `ms` pass first. */
  function within<T>(
    promise: Promise<T>,
    ms: number,
    onTimeout: T,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cancel = timers.setTimer(
        () => {
          resolve(onTimeout);
        },
        Math.max(0, ms),
      );
      promise.then(
        (value) => {
          cancel();
          resolve(value);
        },
        (error: unknown) => {
          cancel();
          reject(error instanceof Error ? error : new Error('rejected'));
        },
      );
    });
  }

  function notify(call: () => void, what: string): void {
    try {
      call();
    } catch (error) {
      logger?.warn({ event: 'job.observer.failed', what, err: error });
    }
  }

  function announce(id: JobId, state: JobState, reason: string | null): void {
    if (options.onState !== undefined) {
      const onState = options.onState;
      notify(() => {
        onState(id, state, reason);
      }, 'state');
    }
  }

  // ---- settling ------------------------------------------------------------------------------
  /** Releases the job into `state`, once. Returns whether this call wrote it. */
  async function settle(
    a: Active,
    state: JobReleaseState,
    reason: string | null,
    result?: Uint8Array,
  ): Promise<boolean> {
    if (a.settled) return false;
    a.settled = true;
    a.finalState = a.lost ? undefined : state;
    a.cancelHeartbeat?.();
    a.cancelHeartbeat = undefined;
    a.wake?.();
    if (a.lost) return false;
    let wrote = false;
    try {
      wrote = await store.finish(a.lease, state, reason, clock.now(), result);
    } catch (error) {
      logger?.error({
        event: 'job.finish.failed',
        jobId: a.record.id,
        type: a.record.type,
        err: error,
      });
    }
    if (wrote) announce(a.record.id, state, reason);
    else {
      logger?.warn({
        event: 'job.finish.not-written',
        jobId: a.record.id,
        state,
      });
    }
    return wrote;
  }

  /** The runner no longer holds the job: abort its work and write nothing more. */
  function loseLease(a: Active): void {
    if (a.settled) return;
    a.lost = true;
    a.controller.abort(new JobStopped('lease-lost'));
    logger?.warn({ event: 'job.lease.lost', jobId: a.record.id });
    // `lost` makes `settle` write nothing: the job is whatever the store says it is.
    void settle(a, 'failed', 'lease-lost');
  }

  // ---- heartbeat -----------------------------------------------------------------------------
  function scheduleHeartbeat(a: Active): void {
    a.cancelHeartbeat = timers.setTimer(() => {
      void beat(a);
    }, heartbeatMs);
  }

  async function beat(a: Active): Promise<void> {
    if (a.settled) return;
    const askedAt = clock.monotonic();
    let answer: boolean | undefined;
    try {
      answer = await store.heartbeat(a.lease, leaseMs, clock.now());
    } catch (error) {
      logger?.warn({
        event: 'job.heartbeat.failed',
        jobId: a.record.id,
        err: error,
      });
    }
    if (isSettled(a)) return;
    if (answer === true) {
      a.leaseDeadline = askedAt + leaseMs;
      scheduleHeartbeat(a);
    } else if (answer === undefined && clock.monotonic() < a.leaseDeadline) {
      // The store did not answer: try again until the lease would have ended anyway.
      scheduleHeartbeat(a);
    } else {
      loseLease(a);
    }
  }

  // ---- checkpoints ---------------------------------------------------------------------------
  function save(a: Active, value: unknown): Promise<void> {
    const next = a.saving
      .catch(() => undefined)
      .then(async () => {
        if (a.settled || a.lost) {
          throw new AppError('INTERNAL', {
            detail: 'The job no longer holds its lease.',
          });
        }
        const checkpoint = a.def.checkpoint.parse(value);
        const sealed = await sealCheckpoint(cipher, a.record.id, checkpoint);
        if (!(await store.saveCheckpoint(a.lease, sealed, clock.now()))) {
          loseLease(a);
          throw new AppError('INTERNAL', {
            detail: 'The job lost its lease while saving.',
          });
        }
      });
    a.saving = next;
    return next;
  }

  // ---- running one job -----------------------------------------------------------------------
  function emit(a: Active, event: JobEvent): void {
    if (options.onEvent === undefined) return;
    const onEvent = options.onEvent;
    notify(() => {
      onEvent(a.record.id, event);
    }, 'event');
  }

  async function failOrStop(a: Active, error: unknown): Promise<void> {
    if (a.lost || a.settled) return;
    if (a.stop !== undefined) return; // the stop settles it, after onDrain
    const code = toProblem(error).code;
    logger?.error({
      event: 'job.failed',
      jobId: a.record.id,
      type: a.record.type,
      code,
      err: error,
    });
    // Delegated credentials that expired are a wait, not a failure (ADR-015).
    const waits = code === 'TOKEN_EXPIRED' || code === 'UNAUTHENTICATED';
    await settle(a, waits ? 'awaiting-credentials' : 'failed', code);
  }

  async function execute(a: Active): Promise<void> {
    const { record, def } = a;
    let ctx: JobContext<unknown, unknown>;
    try {
      if (def.version !== record.version) {
        a.resolveOpened(false);
        await settle(a, 'failed', 'version-mismatch');
        return;
      }
      if (record.attempts > maxAttempts) {
        a.resolveOpened(false);
        await settle(a, 'failed', 'attempts-exhausted');
        return;
      }
      let envelope;
      try {
        envelope = await openJobInput(cipher, record);
      } catch (error) {
        logger?.error({
          event: 'job.unreadable',
          jobId: record.id,
          err: error,
        });
        a.resolveOpened(false);
        await settle(a, 'failed', 'job-unreadable');
        return;
      }
      const input = def.input.parse(envelope.input);
      const checkpoint =
        record.checkpoint === null
          ? undefined
          : def.checkpoint.parse(
              await openCheckpoint(cipher, record.id, record.checkpoint),
            );
      const bucket: TokenBucket | undefined =
        def.throttle === undefined
          ? undefined
          : createTokenBucket({ ...def.throttle(input), clock, timers });
      const requester = envelope.requester;
      ctx = Object.freeze({
        jobId: record.id,
        input,
        ...(checkpoint === undefined ? {} : { checkpoint }),
        // The job acts for the requester and for nobody else, whatever the row says.
        principal: snapshotPrincipal({
          kind: 'job',
          id: `job:${record.id}`,
          display: def.type,
          roles: [...requester.roles],
          surface: 'job',
          unattended: true,
          onBehalfOf: requester,
        }),
        signal: a.controller.signal,
        save: (value: unknown) => save(a, value),
        journal: options.journal ?? unavailableJournal,
        throttle: {
          take: (n?: number, signal?: AbortSignal) => {
            const both =
              signal === undefined
                ? a.controller.signal
                : AbortSignal.any([a.controller.signal, signal]);
            return bucket === undefined
              ? both.aborted
                ? Promise.reject(abortError(both))
                : Promise.resolve()
              : bucket.take(n, both);
          },
        },
        leases: writes.connections,
        executorWrite: writes,
      });
    } catch (error) {
      a.resolveOpened(false);
      logger?.error({ event: 'job.invalid', jobId: record.id, err: error });
      await settle(a, 'failed', 'input-invalid');
      return;
    }
    a.ctx = ctx;
    a.resolveOpened(true);

    if (a.stop === undefined && !a.settled) {
      a.started = true;
      const generator = def.run(ctx);
      try {
        for (;;) {
          const step = await new Promise<
            IteratorResult<JobEvent, unknown> | 'settled'
          >((resolve, reject) => {
            if (a.settled) {
              resolve('settled');
              return;
            }
            a.wake = () => {
              resolve('settled');
            };
            generator.next().then(resolve, reject);
          });
          a.wake = undefined;
          if (step === 'settled') {
            // Settled while the body was still going (a stop that timed out, a lost lease).
            void generator.return(undefined).catch(() => undefined);
            break;
          }
          if (step.done === true) {
            // A stop wins over a return: a job cut short is not a job that succeeded (I-13).
            if (stopOf(a) === undefined && !isSettled(a)) {
              await complete(a, step.value);
            }
            break;
          }
          emit(a, step.value);
          if (step.value.kind === 'paused') {
            stopJob(
              a,
              { reason: 'suspend', final: 'paused', why: 'paused-by-job' },
              commandBudgetMs,
            ).catch((error: unknown) => {
              logger?.error({
                event: 'job.stop.failed',
                jobId: record.id,
                err: error,
              });
            });
          }
        }
      } catch (error) {
        await failOrStop(a, error);
      }
    }
    a.resolveEnded();
    if (a.stopping !== undefined) await a.stopping;
    if (a.stop !== undefined && !a.settled) {
      await settle(a, a.stop.final, a.stop.why);
    }
  }

  async function complete(a: Active, value: unknown): Promise<void> {
    let result: Uint8Array;
    try {
      result = await sealResult(cipher, a.record.id, a.def.output.parse(value));
    } catch (error) {
      await failOrStop(a, error);
      return;
    }
    await settle(a, 'succeeded', null, result);
  }

  // ---- stopping ------------------------------------------------------------------------------
  function stopJob(
    a: Active,
    request: StopRequest,
    budgetMs: number,
  ): Promise<JobDrainEntry> {
    a.stop ??= request;
    a.stopping ??= doStop(a, a.stop, budgetMs);
    return a.stopping;
  }

  async function doStop(
    a: Active,
    request: StopRequest,
    budgetMs: number,
  ): Promise<JobDrainEntry> {
    const begun = clock.monotonic();
    const left = (): number =>
      Math.max(0, budgetMs - settleReserveMs - (clock.monotonic() - begun));
    a.controller.abort(new JobStopped(request.why));

    let onDrain: OnDrainOutcome = 'skipped';
    const ready = await within(a.opened, left(), false);
    const { ctx } = a;
    if (ready && ctx !== undefined && a.started && !a.settled) {
      const budget = left();
      onDrain = await within(
        Promise.resolve()
          .then(() => a.def.onDrain(ctx, request.reason, budget))
          .then(
            () => 'ok' as const,
            (error: unknown) => {
              logger?.error({
                event: 'job.onDrain.failed',
                jobId: a.record.id,
                type: a.record.type,
                err: error,
              });
              return 'error' as const;
            },
          ),
        budget,
        'timeout' as const,
      );
      if (onDrain === 'timeout') {
        logger?.warn({
          event: 'job.onDrain.timeout',
          jobId: a.record.id,
          type: a.record.type,
        });
      }
    }
    // Let the body wind down, for as long as the budget allows, then release the job.
    await within(a.ended, left(), undefined);
    await settle(
      a,
      request.final,
      onDrain === 'ok' || onDrain === 'skipped'
        ? request.why
        : `${request.why}:on-drain-${onDrain}`,
    );
    return {
      jobId: a.record.id,
      type: a.record.type,
      state: a.finalState ?? request.final,
      onDrain,
      ms: clock.monotonic() - begun,
    };
  }

  // ---- claiming ------------------------------------------------------------------------------
  function launch(record: JobRecord): void {
    const def = defs.get(record.type);
    let resolveOpened!: (ready: boolean) => void;
    let resolveEnded!: () => void;
    const a: Active = {
      record,
      lease: { id: record.id, owner, attempt: record.attempts },
      // A type nobody registered is never claimed; if it happens anyway the job is failed below.
      def: def ?? ({ type: record.type } as JobDef),
      controller: new AbortController(),
      settled: false,
      finalState: undefined,
      lost: false,
      started: false,
      stop: undefined,
      stopping: undefined,
      ctx: undefined,
      saving: Promise.resolve(),
      leaseDeadline: clock.monotonic() + leaseMs,
      cancelHeartbeat: undefined,
      opened: new Promise<boolean>((resolve) => {
        resolveOpened = resolve;
      }),
      resolveOpened: (ready) => {
        resolveOpened(ready);
      },
      ended: new Promise<void>((resolve) => {
        resolveEnded = resolve;
      }),
      resolveEnded: () => {
        resolveEnded();
      },
      wake: undefined,
      done: undefined,
    };
    running.set(record.id, a);
    scheduleHeartbeat(a);
    announce(record.id, 'running', null);
    a.done = (
      def === undefined
        ? Promise.resolve(settle(a, 'failed', 'unknown-job-type')).then(() => {
            a.resolveOpened(false);
            a.resolveEnded();
          })
        : execute(a)
    )
      .catch((error: unknown) => {
        logger?.error({
          event: 'job.runner.failed',
          jobId: record.id,
          err: error,
        });
        a.resolveOpened(false);
        a.resolveEnded();
        return settle(a, 'failed', 'INTERNAL').then(() => undefined);
      })
      .finally(() => {
        // However it ended, nobody may be left waiting on this job.
        a.resolveOpened(false);
        a.resolveEnded();
        running.delete(record.id);
        if (accepting) void pump();
      });
  }

  function pump(): Promise<void> {
    if (pumping !== undefined) {
      pumpAgain = true;
      return pumping;
    }
    const current = (async () => {
      // The first await lets `pumping` be set before the body can finish and clear it; a pump
      // that ended without one would otherwise leave a finished promise there for good.
      await Promise.resolve();
      try {
        do {
          pumpAgain = false;
          while (accepting && running.size < maxConcurrent) {
            const record = await store.claim(
              owner,
              leaseMs,
              [...defs.keys()],
              clock.now(),
            );
            if (record === undefined) break;
            launch(record);
          }
        } while (isPumpRequested() && isAccepting());
      } catch (error) {
        logger?.error({ event: 'job.claim.failed', err: error });
      } finally {
        pumping = undefined;
      }
    })();
    pumping = current;
    return current;
  }

  function schedulePoll(): void {
    cancelPoll = timers.setTimer(() => {
      cancelPoll = undefined;
      if (!accepting) return;
      void pump().finally(() => {
        if (accepting && cancelPoll === undefined) schedulePoll();
      });
    }, pollMs);
  }

  // ---- preflight, recovery and resume --------------------------------------------------------
  async function preflight(
    record: JobRecord,
    def: JobDef,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      const envelope = await openJobInput(cipher, record);
      const input = def.input.parse(envelope.input);
      const checkpoint =
        record.checkpoint === null
          ? undefined
          : def.checkpoint.parse(
              await openCheckpoint(cipher, record.id, record.checkpoint),
            );
      if (def.preflight === undefined) return { ok: true };
      const ask = (): Promise<JobPreflight> | undefined =>
        def.preflight?.({
          jobId: record.id,
          input,
          ...(checkpoint === undefined ? {} : { checkpoint }),
          principal: envelope.requester,
          signal: AbortSignal.timeout(commandBudgetMs),
        });
      // A preflight that never answers must not hold a resume (or the start-up) for ever.
      const result = await within<JobPreflight | undefined>(
        Promise.resolve().then(ask),
        commandBudgetMs,
        { ok: false, reason: 'preflight-timeout' },
      );
      // Only a plain `ok: true` lets a job resume; anything else, however odd, blocks it.
      if (result?.ok === true) return { ok: true };
      return {
        ok: false,
        reason: result?.ok === false ? result.reason : 'preflight-invalid',
      };
    } catch (error) {
      // Fail closed: a job that cannot be checked is not resumed.
      logger?.warn({
        event: 'job.preflight.failed',
        jobId: record.id,
        err: error,
      });
      return { ok: false, reason: 'preflight-failed' };
    }
  }

  async function recover(): Promise<JobRecoveryReport> {
    const scope =
      options.recovery === 'interrupt-all-running' && running.size === 0
        ? 'all'
        : 'expired';
    let interrupted = 0;
    for (;;) {
      const n = await store.interruptRunning(scope, clock.now(), RECOVER_PAGE);
      interrupted += n;
      if (n < RECOVER_PAGE) break;
    }
    let resumed = 0;
    let blocked = 0;
    if (options.autoResume === 'resumable') {
      let cursor: string | undefined;
      let seen = 0;
      do {
        const page = await store.list(['paused-interrupted'], {
          limit: RECOVER_PAGE,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const record of page.items) {
          seen += 1;
          const def = defs.get(record.type);
          // The definition decides, not the column: a row edited to `resumable` is not resumed.
          if (
            def === undefined ||
            !def.resumable ||
            def.version !== record.version
          ) {
            continue;
          }
          if (!(await preflight(record, def)).ok) {
            blocked += 1;
          } else if (
            await store.transition(
              record.id,
              ['paused-interrupted'],
              'queued',
              'auto-resume',
              clock.now(),
            )
          ) {
            resumed += 1;
            announce(record.id, 'queued', 'auto-resume');
          }
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined && seen < MAX_AUTO_RESUME);
    }
    return { interrupted, resumed, blocked };
  }

  // ---- the public surface --------------------------------------------------------------------
  const runner: JobRunner = {
    register(def) {
      if (!isDefinedJob(def)) {
        throw new TypeError(
          'register() accepts only what defineJob() returned.',
        );
      }
      if (defs.has(def.type)) {
        throw new TypeError(`The job type ${def.type} is already registered.`);
      }
      defs.set(def.type, def);
    },

    async submit(type, input, requester, { idempotencyKey, planHash }) {
      if (draining) {
        throw new AppError('ENGINE_SHUTTING_DOWN', {
          detail: 'The engine is shutting down.',
        });
      }
      const def = defs.get(type);
      if (def === undefined) {
        throw new AppError('NOT_FOUND', { detail: 'Unknown job type.' });
      }
      const candidate: unknown = requester;
      if (!isPrincipal(candidate)) {
        throw new AppError('UNAUTHENTICATED', {
          detail: 'No valid principal.',
        });
      }
      const key = parseIdempotencyKey(idempotencyKey);
      if (typeof planHash !== 'string' || !PLAN_HASH.test(planHash)) {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'planHash must be a sha256 digest in lower case hex.',
        });
      }
      const parsed = def.input.safeParse(input);
      if (!parsed.success) {
        throw new AppError('VALIDATION_FAILED', {
          detail: parsed.error.issues
            .map(
              (issue) =>
                `${issue.path.map(String).join('.')}: ${issue.message}`,
            )
            .join('; '),
        });
      }
      const concurrencyKey = def.concurrencyKey?.(parsed.data) ?? null;
      if (
        concurrencyKey !== null &&
        (concurrencyKey === '' || concurrencyKey.length > MAX_CONCURRENCY_KEY)
      ) {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'The job declared an unusable concurrency key.',
        });
      }
      const frozen = snapshotPrincipal(candidate);
      const id = ids.jobId();
      const sealed = await sealJobInput(cipher, id, {
        v: 1,
        type,
        version: def.version,
        planHash,
        idempotencyKey: key,
        concurrencyKey,
        requester: frozen,
        input: parsed.data,
      });
      const { job, created } = await store.create(
        {
          id,
          type,
          version: def.version,
          principalId: frozen.id,
          onBehalfOfId: frozen.onBehalfOf?.id ?? null,
          planHash,
          idempotencyKey: key,
          concurrencyKey,
          resumable: def.resumable,
          input: sealed,
        },
        clock.now(),
      );
      if (!created) {
        // The same key again returns the same job, but only for the same work.
        if (job.type !== type || job.planHash !== planHash) {
          throw conflict('This idempotencyKey was used for a different job.');
        }
        return job.id;
      }
      announce(job.id, 'queued', null);
      if (accepting) void pump();
      return job.id;
    },

    async command(id, command, principal) {
      const candidate: unknown = principal;
      if (!isPrincipal(candidate)) {
        throw new AppError('UNAUTHENTICATED', {
          detail: 'No valid principal.',
        });
      }
      const record = await store.get(id);
      if (
        record === undefined ||
        !(
          mayActFor(candidate, {
            principalId: record.principalId,
            onBehalfOfId: record.onBehalfOfId,
          }) || options.mayOverride?.(candidate, record) === true
        )
      ) {
        // Not telling a stranger which job ids exist.
        throw new AppError('NOT_FOUND', { detail: 'Unknown job.' });
      }
      const active = running.get(id);
      if (command === 'resume') {
        if (
          record.state !== 'paused' &&
          record.state !== 'paused-interrupted' &&
          record.state !== 'awaiting-credentials'
        ) {
          throw conflict(`A job that is ${record.state} cannot be resumed.`);
        }
        const def = defs.get(record.type);
        if (def === undefined)
          throw conflict('This job type is not available.');
        const check = await preflight(record, def);
        if (!check.ok) {
          throw new AppError('GATE_BLOCKED', {
            detail: `The job cannot resume yet: ${check.reason}`,
          });
        }
        if (
          !(await store.transition(
            id,
            [record.state],
            'queued',
            'resumed',
            clock.now(),
          ))
        ) {
          throw conflict('The job changed while it was being resumed.');
        }
        announce(id, 'queued', 'resumed');
        if (accepting) void pump();
        return;
      }
      const request: StopRequest =
        command === 'pause'
          ? { reason: 'suspend', final: 'paused', why: 'paused-by-user' }
          : { reason: 'cancel', final: 'cancelled', why: 'cancelled' };
      if (active !== undefined) {
        await stopJob(active, request, commandBudgetMs);
        return;
      }
      const from: JobState[] =
        command === 'pause'
          ? ['queued']
          : ['queued', 'paused', 'paused-interrupted', 'awaiting-credentials'];
      if (record.state === 'running') {
        throw conflict('The job is running on another engine.');
      }
      if (
        !(await store.transition(
          id,
          from,
          request.final === 'paused' ? 'paused' : 'cancelled',
          request.why,
          clock.now(),
        ))
      ) {
        throw conflict(
          `A job that is ${record.state} cannot be ${command === 'pause' ? 'paused' : 'cancelled'}.`,
        );
      }
      announce(
        id,
        request.final === 'paused' ? 'paused' : 'cancelled',
        request.why,
      );
    },

    async start() {
      if (started) return { interrupted: 0, resumed: 0, blocked: 0 };
      started = true;
      const report = await recover();
      accepting = true;
      draining = false;
      schedulePoll();
      void pump();
      return report;
    },

    recover,

    async drain(reason, budgetMs) {
      if (!Number.isFinite(budgetMs) || budgetMs < 0) {
        throw new RangeError(
          'drain(reason, budgetMs) needs a budget of 0 or more.',
        );
      }
      accepting = false;
      draining = true;
      cancelPoll?.();
      cancelPoll = undefined;
      // A claim that is in flight finishes first, so the job it takes is stopped like the others.
      if (pumping !== undefined) await pumping;
      return Promise.all(
        [...running.values()].map((a) =>
          stopJob(
            a,
            { reason, final: 'paused-interrupted', why: reason },
            budgetMs,
          ),
        ),
      );
    },

    async reopen() {
      const report = await recover();
      draining = false;
      accepting = started;
      if (accepting) {
        if (cancelPoll === undefined) schedulePoll();
        void pump();
      }
      return report;
    },

    drainPhase() {
      return {
        name: 'sources-jobs',
        run: async ({ reason, budgetMs }) => {
          const entries = await runner.drain(
            reason === 'suspend'
              ? 'suspend'
              : reason === 'emergency'
                ? 'emergency'
                : 'shutdown',
            budgetMs,
          );
          const unclean = entries.filter(
            (entry) => entry.onDrain !== 'ok' && entry.onDrain !== 'skipped',
          );
          if (unclean.length > 0) {
            throw new AppError('INTERNAL', {
              detail: `${String(unclean.length)} job(s) did not finish their onDrain in time.`,
            });
          }
        },
      };
    },

    stats: () => ({ running: running.size, accepting, draining }),
  };
  return runner;
}
