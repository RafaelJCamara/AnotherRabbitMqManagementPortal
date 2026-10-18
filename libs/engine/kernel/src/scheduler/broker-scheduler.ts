// BrokerScheduler (I-8, ADR-009, ADR-024, blueprint section 8): the only path to the management
// API and to Prometheus. It spends one broker's capacity in three lanes, `interactive` before
// `live` before `background`, and protects the broker:
//
//  - at most ONE background request per broker is in flight, and the next one waits for the
//    background interval after the last finished;
//  - the interval backs off multiplicatively (AIMD) after consecutive overload signals (429, 5xx,
//    or a p50 latency above twice the baseline) and recovers additively on healthy answers;
//  - identical GETs are single-flighted, and a successful answer is reused for `detailCacheMs`;
//  - every queue is bounded by items (I-6) and a refused request is counted and reported (I-13).
//
// The scheduler knows nothing about HTTP. It runs a task for a broker in a lane; the wrappers in
// `scheduled-ports.ts` put the Mgmt and Prometheus ports behind it.
import type { ConnectionId } from '@app/contracts';
import { LANES, type Lane } from '@app/ports';

import {
  BoundedQueue,
  BoundedRing,
  type DropReason,
} from '../bounded/index.ts';
import { systemClock, type Clock } from '../clock/clock.ts';
import { AppError } from '../problem/problem.ts';
import { systemTimers, type Timers } from './timers.ts';

/** I-8: never more than one background request per broker. Not configurable. */
const BACKGROUND_PER_BROKER = 1;

export interface AimdOptions {
  /** The pause after a background request when the broker is healthy. */
  baseIntervalMs: number;
  /** The longest pause back-off can reach. */
  maxIntervalMs: number;
  /** This many consecutive overload signals multiply the interval by `backoffFactor`. */
  failureThreshold: number;
  backoffFactor: number;
  /** A healthy answer shortens the interval by this much, down to `baseIntervalMs`. */
  recoverStepMs: number;
  /** Background latencies kept to compute the p50. */
  latencyWindow: number;
  /** The p50 is judged only once this many latencies are known. */
  latencyMinSamples: number;
  /** A p50 above `slowFactor` times the baseline counts as an overload signal. */
  slowFactor: number;
}

export const DEFAULT_AIMD: Readonly<AimdOptions> = {
  baseIntervalMs: 200,
  maxIntervalMs: 30_000,
  failureThreshold: 3,
  backoffFactor: 2,
  recoverStepMs: 50,
  latencyWindow: 16,
  latencyMinSamples: 8,
  slowFactor: 2,
};

export interface SchedulerDrop {
  connectionId: ConnectionId;
  lane: Lane;
  reason: DropReason;
  items: number;
}

export interface BrokerSchedulerOptions {
  clock?: Clock;
  timers?: Timers;
  /** In-flight limits of the interactive and live lanes (the background lane is always 1). */
  laneConcurrency?: Partial<Record<'interactive' | 'live', number>>;
  /** In-flight limit of all lanes of one broker together; lower lanes yield first. */
  maxInFlight?: number;
  /** Queue capacity per lane and broker. A request that does not fit is refused. */
  queueLimit?: Partial<Record<Lane, number>>;
  /** Background requests in flight over all brokers (team mode: 64). */
  globalBackgroundCap?: number;
  /** How long a successful keyed request is reused (blueprint section 8: 2 s). */
  detailCacheMs?: number;
  /** Most keyed results kept. */
  cacheMaxEntries?: number;
  aimd?: Partial<AimdOptions>;
  /** Decides whether a failed task is an overload signal. */
  isOverload?: (error: unknown) => boolean;
  /** The longest a held slot (a stream body) is counted, in case its consumer vanishes. */
  holdMs?: number;
  /** Called for every request refused because its queue was full (I-13). */
  onDrop?: (event: SchedulerDrop) => void;
}

export interface SchedulerRequest {
  connectionId: ConnectionId;
  lane: Lane;
  /** The caller's cancellation. It cancels this caller's wait, and the task when nobody else waits. */
  signal?: AbortSignal | undefined;
  /**
   * Requests with the same key for the same broker share one run (single-flight), and a success
   * is reused for `detailCacheMs`. Leave it out for anything that must run every time.
   */
  dedupeKey?: string | undefined;
}

export interface HeldSlot<T> {
  value: T;
  /** Ends the hold. Safe to call more than once. */
  readonly release: () => void;
}

export interface BrokerStats {
  connectionId: ConnectionId;
  queued: Record<Lane, number>;
  inFlight: Record<Lane, number>;
  /** Requests refused because the lane's queue was full. */
  dropped: Record<Lane, number>;
  backgroundIntervalMs: number;
  consecutiveFailures: number;
  baselineMs: number | undefined;
  p50Ms: number | undefined;
  cacheHits: number;
  singleFlightJoins: number;
}

export interface SchedulerStats {
  brokers: BrokerStats[];
  backgroundInFlight: number;
  cacheEntries: number;
  /** Holds that ended by the watchdog instead of by their consumer. */
  holdTimeouts: number;
}

const DEFAULT_CONCURRENCY = { interactive: 4, live: 2 } as const;
const DEFAULT_QUEUE_LIMIT: Record<Lane, number> = {
  interactive: 256,
  live: 256,
  background: 1024,
};

type JobState = 'queued' | 'running' | 'done' | 'cancelled';

interface Job {
  readonly connectionId: ConnectionId;
  lane: Lane;
  state: JobState;
  readonly task: (signal: AbortSignal) => Promise<unknown>;
  readonly controller: AbortController;
  readonly key: string | undefined;
  /** False for a held slot, whose duration includes reading the body. */
  readonly measureLatency: boolean;
  readonly promise: Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  subscribers: number;
}

interface Entry {
  readonly job: Job;
  /** The lane this entry was queued in; stale once the job moved to a better lane. */
  readonly lane: Lane;
}

interface Aimd {
  intervalMs: number;
  consecutiveFailures: number;
  readonly latencies: BoundedRing<number>;
  baselineMs: number | undefined;
}

interface Broker {
  readonly id: ConnectionId;
  readonly queues: Record<Lane, BoundedQueue<Entry>>;
  readonly queued: Record<Lane, number>;
  readonly inFlight: Record<Lane, number>;
  readonly dropped: Record<Lane, number>;
  readonly aimd: Aimd;
  nextBackgroundAt: number;
  pumpQueued: boolean;
  cancelWake: (() => void) | undefined;
  cacheHits: number;
  joins: number;
}

type CacheEntry =
  | { readonly kind: 'flight'; readonly job: Job }
  | {
      readonly kind: 'value';
      readonly value: unknown;
      readonly expiresAt: number;
    };

const laneRank = (lane: Lane): number => LANES.indexOf(lane);

const perLane = <T>(make: (lane: Lane) => T): Record<Lane, T> => ({
  interactive: make('interactive'),
  live: make('live'),
  background: make('background'),
});

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The default overload test: HTTP 429 or 5xx from the broker, `RATE_LIMITED`, or an unreachable
 * broker. Reads an `AppError` or a Problem; anything else (a bug, a 404, a validation error) says
 * nothing about the broker's load.
 */
export function isOverloadError(error: unknown): boolean {
  const fields = asRecord(error);
  if (fields === undefined) return false;
  if (fields.code === 'RATE_LIMITED' || fields.code === 'BROKER_UNREACHABLE') {
    return true;
  }
  const broker = asRecord(fields.broker);
  if (broker?.protocol !== 'http') return false;
  const status = Number(broker.code);
  return status === 429 || (status >= 500 && status <= 599);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (index: number): number => sorted[index] ?? 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? at(middle)
    : (at(middle - 1) + at(middle)) / 2;
}

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`);
  }
}

export class BrokerScheduler {
  private readonly clock: Clock;
  private readonly timers: Timers;
  private readonly concurrency: Record<Lane, number>;
  private readonly maxInFlight: number;
  private readonly queueLimit: Record<Lane, number>;
  private readonly globalBackgroundCap: number;
  private readonly detailCacheMs: number;
  private readonly cacheMaxEntries: number;
  private readonly aimd: AimdOptions;
  private readonly isOverload: (error: unknown) => boolean;
  private readonly holdMs: number;
  private readonly onDrop: ((event: SchedulerDrop) => void) | undefined;

  private readonly brokers = new Map<ConnectionId, Broker>();
  private readonly cache = new Map<string, CacheEntry>();
  /** Brokers whose background work is waiting for the global cap. */
  private readonly waitingForGlobal = new Set<Broker>();
  /** Jobs whose task has started and not yet settled; bounded by the in-flight caps. */
  private readonly running = new Set<Job>();
  private backgroundInFlight = 0;
  private holdTimeouts = 0;
  private closed = false;

  constructor(options: BrokerSchedulerOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.timers = options.timers ?? systemTimers;
    this.concurrency = {
      interactive:
        options.laneConcurrency?.interactive ?? DEFAULT_CONCURRENCY.interactive,
      live: options.laneConcurrency?.live ?? DEFAULT_CONCURRENCY.live,
      background: BACKGROUND_PER_BROKER,
    };
    this.maxInFlight = options.maxInFlight ?? 6;
    this.queueLimit = { ...DEFAULT_QUEUE_LIMIT, ...options.queueLimit };
    this.globalBackgroundCap = options.globalBackgroundCap ?? 64;
    this.detailCacheMs = options.detailCacheMs ?? 2000;
    this.cacheMaxEntries = options.cacheMaxEntries ?? 1024;
    this.aimd = { ...DEFAULT_AIMD, ...options.aimd };
    this.isOverload = options.isOverload ?? isOverloadError;
    this.holdMs = options.holdMs ?? 120_000;
    this.onDrop = options.onDrop;

    assertPositive('laneConcurrency.interactive', this.concurrency.interactive);
    assertPositive('laneConcurrency.live', this.concurrency.live);
    assertPositive('maxInFlight', this.maxInFlight);
    assertPositive('globalBackgroundCap', this.globalBackgroundCap);
    assertPositive('cacheMaxEntries', this.cacheMaxEntries);
    assertPositive('holdMs', this.holdMs);
    for (const lane of LANES)
      assertPositive(`queueLimit.${lane}`, this.queueLimit[lane]);
    assertPositive('aimd.baseIntervalMs', this.aimd.baseIntervalMs);
    assertPositive('aimd.failureThreshold', this.aimd.failureThreshold);
    if (this.aimd.maxIntervalMs < this.aimd.baseIntervalMs) {
      throw new RangeError(
        'aimd.maxIntervalMs must not be below baseIntervalMs.',
      );
    }
    if (this.aimd.backoffFactor <= 1) {
      throw new RangeError('aimd.backoffFactor must be greater than 1.');
    }
    if (this.detailCacheMs < 0) {
      throw new RangeError('detailCacheMs must not be negative.');
    }
  }

  /**
   * Runs `task` for the broker in the lane and returns its result. The task receives a signal that
   * aborts when every caller waiting for it has given up (or the scheduler closes).
   *
   * Rejects with `BUDGET_EXCEEDED` when the lane's queue is full, and with `ENGINE_SHUTTING_DOWN`
   * after `close()`.
   */
  run<T>(
    request: SchedulerRequest,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return this.submit(request, task, true);
  }

  private submit<T>(
    request: SchedulerRequest,
    task: (signal: AbortSignal) => Promise<T>,
    measureLatency: boolean,
  ): Promise<T> {
    if (this.closed) return Promise.reject(shuttingDown());
    if (request.signal?.aborted)
      return Promise.reject(abortReason(request.signal));

    const broker = this.broker(request.connectionId);
    const key =
      request.dedupeKey === undefined
        ? undefined
        : `${request.connectionId}\u0000${request.dedupeKey}`;

    if (key !== undefined) {
      const existing = this.cache.get(key);
      if (existing?.kind === 'value') {
        if (existing.expiresAt > this.clock.monotonic()) {
          broker.cacheHits += 1;
          return Promise.resolve(existing.value as T);
        }
        this.cache.delete(key);
      } else if (existing?.kind === 'flight') {
        if (!existing.job.controller.signal.aborted) {
          broker.joins += 1;
          this.promote(broker, existing.job, request.lane);
          return this.attach<T>(existing.job, request.signal);
        }
        // Everyone waiting for that run gave up and it was told to stop: do not hand its
        // cancellation to a new caller. The old run, when it ends, finds its entry replaced.
        this.cache.delete(key);
      }
    }

    const job = this.createJob(
      request.connectionId,
      request.lane,
      task,
      key,
      measureLatency,
    );
    if (!this.enqueue(broker, job)) {
      return Promise.reject(
        new AppError('BUDGET_EXCEEDED', {
          detail: `The ${request.lane} queue for this broker is full.`,
          retryable: true,
        }),
      );
    }
    if (key !== undefined) this.cache.set(key, { kind: 'flight', job });
    this.requestPump(broker);
    return this.attach<T>(job, request.signal);
  }

  /**
   * Like `run`, but the slot stays counted until `release()` is called (or the caller gives up, or
   * `holdMs` passes). For a response whose body is read after the request returns.
   */
  holdSlot<T>(
    request: Omit<SchedulerRequest, 'dedupeKey'>,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<HeldSlot<T>> {
    return new Promise<HeldSlot<T>>((resolve, reject) => {
      // The time a body takes to read says nothing about the broker, so it is not a latency sample.
      this.submit(
        request,
        async (signal) => {
          const value = await task(signal);
          await new Promise<void>((ended) => {
            let finished = false;
            let cancelWatchdog: () => void = () => undefined;
            const release = () => {
              if (finished) return;
              finished = true;
              cancelWatchdog();
              signal.removeEventListener('abort', release);
              ended();
            };
            cancelWatchdog = this.timers.setTimer(() => {
              if (!finished) this.holdTimeouts += 1;
              release();
            }, this.holdMs);
            signal.addEventListener('abort', release, { once: true });
            // The caller may have given up while the request was in flight: nobody will read.
            if (signal.aborted) release();
            resolve({ value, release });
          });
        },
        false,
      ).catch(reject);
    });
  }

  snapshot(): SchedulerStats {
    const brokers: BrokerStats[] = [];
    for (const broker of this.brokers.values()) {
      const samples = broker.aimd.latencies.toArray();
      brokers.push({
        connectionId: broker.id,
        queued: { ...broker.queued },
        inFlight: { ...broker.inFlight },
        dropped: { ...broker.dropped },
        backgroundIntervalMs: broker.aimd.intervalMs,
        consecutiveFailures: broker.aimd.consecutiveFailures,
        baselineMs: broker.aimd.baselineMs,
        p50Ms: samples.length === 0 ? undefined : median(samples),
        cacheHits: broker.cacheHits,
        singleFlightJoins: broker.joins,
      });
    }
    return {
      brokers,
      backgroundInFlight: this.backgroundInFlight,
      cacheEntries: this.cache.size,
      holdTimeouts: this.holdTimeouts,
    };
  }

  /**
   * Stops the scheduler: queued requests are rejected with `ENGINE_SHUTTING_DOWN`, running tasks
   * are aborted, and no new request is accepted.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = shuttingDown();
    for (const broker of this.brokers.values()) {
      broker.cancelWake?.();
      broker.cancelWake = undefined;
      for (const lane of LANES) {
        for (const entry of broker.queues[lane].drain()) {
          if (this.isLive(entry)) this.cancelJob(entry.job, error);
        }
        broker.queued[lane] = 0;
      }
    }
    this.waitingForGlobal.clear();
    for (const job of this.running) job.controller.abort(error);
    this.cache.clear();
  }

  // ---------------------------------------------------------------------------------------------

  private broker(id: ConnectionId): Broker {
    const known = this.brokers.get(id);
    if (known) return known;
    const created: Broker = {
      id,
      queues: perLane(
        (lane) =>
          new BoundedQueue<Entry>({
            maxItems: this.queueLimit[lane],
            maxBytes: this.queueLimit[lane],
            sizeOf: () => 1,
            onDrop: (event) => {
              created.dropped[lane] += event.items;
              this.onDrop?.({
                connectionId: id,
                lane,
                reason: event.reason,
                items: event.items,
              });
            },
          }),
      ),
      queued: perLane(() => 0),
      inFlight: perLane(() => 0),
      dropped: perLane(() => 0),
      aimd: {
        intervalMs: this.aimd.baseIntervalMs,
        consecutiveFailures: 0,
        latencies: new BoundedRing<number>({
          maxItems: this.aimd.latencyWindow,
          maxBytes: this.aimd.latencyWindow,
          sizeOf: () => 1,
        }),
        baselineMs: undefined,
      },
      nextBackgroundAt: 0,
      pumpQueued: false,
      cancelWake: undefined,
      cacheHits: 0,
      joins: 0,
    };
    this.brokers.set(id, created);
    return created;
  }

  private createJob(
    connectionId: ConnectionId,
    lane: Lane,
    task: (signal: AbortSignal) => Promise<unknown>,
    key: string | undefined,
    measureLatency: boolean,
  ): Job {
    let resolve: (value: unknown) => void = () => undefined;
    let reject: (error: unknown) => void = () => undefined;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Every caller attaches its own handlers; this one only keeps a cancelled job from being
    // reported as an unhandled rejection.
    promise.catch(() => undefined);
    return {
      connectionId,
      lane,
      state: 'queued',
      task,
      controller: new AbortController(),
      key,
      measureLatency,
      promise,
      resolve,
      reject,
      subscribers: 0,
    };
  }

  /** Queues the job in its lane. False when the lane is full even after dropping dead entries. */
  private enqueue(broker: Broker, job: Job): boolean {
    const lane = job.lane;
    // Only a request that really finds the lane full is offered, so only it counts as a drop.
    if (!this.hasRoom(broker, lane)) {
      // Count the refusal through the queue, so it is reported like every other drop (I-13).
      broker.queues[lane].offer({ job, lane });
      return false;
    }
    broker.queues[lane].offer({ job, lane });
    broker.queued[lane] += 1;
    return true;
  }

  /** Room in the lane's queue, after dropping the dead entries that cancelled and promoted jobs leave. */
  private hasRoom(broker: Broker, lane: Lane): boolean {
    const queue = broker.queues[lane];
    if (queue.size < this.queueLimit[lane]) return true;
    if (broker.queued[lane] < queue.size) this.compact(broker, lane);
    return queue.size < this.queueLimit[lane];
  }

  private compact(broker: Broker, lane: Lane): void {
    const queue = broker.queues[lane];
    for (const entry of queue.drain()) {
      if (this.isLive(entry)) queue.offer(entry);
    }
  }

  private isLive(entry: Entry): boolean {
    return entry.job.state === 'queued' && entry.job.lane === entry.lane;
  }

  /** A caller with a better lane joined a job that is still queued: move it up. */
  private promote(broker: Broker, job: Job, lane: Lane): void {
    if (job.state !== 'queued' || laneRank(lane) >= laneRank(job.lane)) return;
    if (!this.hasRoom(broker, lane)) return;
    broker.queues[lane].offer({ job, lane });
    broker.queued[job.lane] -= 1;
    job.lane = lane;
    broker.queued[lane] += 1;
    this.requestPump(broker);
  }

  private attach<T>(job: Job, signal: AbortSignal | undefined): Promise<T> {
    job.subscribers += 1;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        job.subscribers -= 1;
        reject(abortReason(signal));
        if (job.subscribers === 0) this.abandon(job, abortReason(signal));
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      job.promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          resolve(value as T);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          reject(toError(error));
        },
      );
    });
  }

  /** Nobody is waiting for the job any more. */
  private abandon(job: Job, reason: unknown): void {
    if (job.state === 'queued') {
      this.cancelJob(job, reason);
      const broker = this.brokers.get(job.connectionId);
      if (broker) broker.queued[job.lane] -= 1;
    } else if (job.state === 'running') {
      job.controller.abort(reason);
    }
  }

  private cancelJob(job: Job, reason: unknown): void {
    job.state = 'cancelled';
    job.controller.abort(reason);
    job.reject(reason);
    this.forget(job);
  }

  private forget(job: Job): void {
    if (job.key !== undefined) {
      const entry = this.cache.get(job.key);
      if (entry?.kind === 'flight' && entry.job === job) {
        this.cache.delete(job.key);
      }
    }
  }

  // --- dispatch --------------------------------------------------------------------------------

  /** Batches everything submitted in one turn, so the lanes (not arrival order) decide who runs. */
  private requestPump(broker: Broker): void {
    if (broker.pumpQueued || this.closed) return;
    broker.pumpQueued = true;
    queueMicrotask(() => {
      broker.pumpQueued = false;
      this.pump(broker);
    });
  }

  private totalInFlight(broker: Broker): number {
    return (
      broker.inFlight.interactive +
      broker.inFlight.live +
      broker.inFlight.background
    );
  }

  private nextLive(broker: Broker, lane: Lane): Entry | undefined {
    const queue = broker.queues[lane];
    for (;;) {
      const entry = queue.peek();
      if (entry === undefined) return undefined;
      if (this.isLive(entry)) return entry;
      queue.shift();
    }
  }

  private pump(broker: Broker): void {
    if (this.closed) return;
    for (const lane of LANES) {
      while (
        this.totalInFlight(broker) < this.maxInFlight &&
        broker.inFlight[lane] < this.concurrency[lane]
      ) {
        const entry = this.nextLive(broker, lane);
        if (entry === undefined) break;
        if (lane === 'background') {
          const wait = broker.nextBackgroundAt - this.clock.monotonic();
          if (wait > 0) {
            this.armWake(broker, wait);
            break;
          }
          if (this.backgroundInFlight >= this.globalBackgroundCap) {
            this.waitingForGlobal.add(broker);
            break;
          }
        }
        broker.queues[lane].shift();
        this.start(broker, entry.job);
      }
    }
  }

  private armWake(broker: Broker, ms: number): void {
    broker.cancelWake?.();
    broker.cancelWake = this.timers.setTimer(() => {
      broker.cancelWake = undefined;
      this.pump(broker);
    }, ms);
  }

  private start(broker: Broker, job: Job): void {
    const lane = job.lane;
    job.state = 'running';
    this.running.add(job);
    broker.queued[lane] -= 1;
    broker.inFlight[lane] += 1;
    if (lane === 'background') this.backgroundInFlight += 1;
    const startedAt = this.clock.monotonic();

    let running: Promise<unknown>;
    try {
      running = Promise.resolve(job.task(job.controller.signal));
    } catch (error) {
      running = Promise.reject(toError(error));
    }
    running.then(
      (value) => {
        this.finish(broker, job, lane, startedAt, { ok: true, value });
      },
      (error: unknown) => {
        this.finish(broker, job, lane, startedAt, { ok: false, error });
      },
    );
  }

  private finish(
    broker: Broker,
    job: Job,
    lane: Lane,
    startedAt: number,
    outcome: { ok: true; value: unknown } | { ok: false; error: unknown },
  ): void {
    const now = this.clock.monotonic();
    broker.inFlight[lane] -= 1;
    const wasAtGlobalCap = this.backgroundInFlight >= this.globalBackgroundCap;
    if (lane === 'background') this.backgroundInFlight -= 1;
    job.state = 'done';
    this.running.delete(job);

    if (job.controller.signal.aborted) {
      // Nobody is waiting and the task was told to stop: the result says nothing about the broker.
    } else if (outcome.ok) {
      this.observe(
        broker,
        lane,
        'ok',
        job.measureLatency ? now - startedAt : undefined,
      );
    } else {
      this.observe(
        broker,
        lane,
        this.isOverload(outcome.error) ? 'overload' : 'ok',
        undefined,
      );
    }
    if (lane === 'background') {
      // The interval may have just changed; it applies from the end of this request.
      broker.nextBackgroundAt = now + broker.aimd.intervalMs;
    }

    if (outcome.ok) {
      this.storeResult(job, outcome.value, now);
      job.resolve(outcome.value);
    } else {
      this.forget(job);
      job.reject(toError(outcome.error));
    }

    this.requestPump(broker);
    if (lane === 'background' && wasAtGlobalCap) this.wakeWaiting();
  }

  private wakeWaiting(): void {
    for (const waiting of this.waitingForGlobal) {
      this.waitingForGlobal.delete(waiting);
      this.requestPump(waiting);
    }
  }

  // --- AIMD ------------------------------------------------------------------------------------

  private observe(
    broker: Broker,
    lane: Lane,
    health: 'ok' | 'overload',
    latencyMs: number | undefined,
  ): void {
    const aimd = broker.aimd;
    if (health === 'overload') {
      this.failure(aimd);
      return;
    }
    if (lane === 'background' && latencyMs !== undefined) {
      aimd.latencies.add(latencyMs);
      if (this.isSlow(aimd)) {
        this.failure(aimd);
        return;
      }
    }
    aimd.consecutiveFailures = 0;
    aimd.intervalMs = Math.max(
      this.aimd.baseIntervalMs,
      aimd.intervalMs - this.aimd.recoverStepMs,
    );
  }

  /** The p50 of recent background latencies against twice the learned baseline. */
  private isSlow(aimd: Aimd): boolean {
    const samples = aimd.latencies.toArray();
    if (samples.length < this.aimd.latencyMinSamples) return false;
    const p50 = median(samples);
    if (aimd.baselineMs === undefined) {
      aimd.baselineMs = p50;
      return false;
    }
    if (p50 > aimd.baselineMs * this.aimd.slowFactor) return true;
    aimd.baselineMs = aimd.baselineMs * 0.9 + p50 * 0.1;
    return false;
  }

  private failure(aimd: Aimd): void {
    aimd.consecutiveFailures += 1;
    if (aimd.consecutiveFailures >= this.aimd.failureThreshold) {
      aimd.consecutiveFailures = 0;
      aimd.intervalMs = Math.min(
        this.aimd.maxIntervalMs,
        aimd.intervalMs * this.aimd.backoffFactor,
      );
    }
  }

  // --- cache -----------------------------------------------------------------------------------

  private storeResult(job: Job, value: unknown, now: number): void {
    if (job.key === undefined) return;
    const current = this.cache.get(job.key);
    if (current?.kind !== 'flight' || current.job !== job) return;
    this.cache.delete(job.key);
    if (this.detailCacheMs === 0) return;
    this.cache.set(job.key, {
      kind: 'value',
      value,
      expiresAt: now + this.detailCacheMs,
    });
    this.trimCache(now);
  }

  /** Keeps the cache within `cacheMaxEntries`: expired results first, then the oldest. */
  private trimCache(now: number): void {
    if (this.cache.size <= this.cacheMaxEntries) return;
    for (const [key, entry] of this.cache) {
      if (entry.kind === 'value' && entry.expiresAt <= now)
        this.cache.delete(key);
    }
    for (const [key, entry] of this.cache) {
      if (this.cache.size <= this.cacheMaxEntries) return;
      if (entry.kind === 'value') this.cache.delete(key);
    }
    for (const key of this.cache.keys()) {
      if (this.cache.size <= this.cacheMaxEntries) return;
      this.cache.delete(key);
    }
  }
}

function shuttingDown(): AppError {
  return new AppError('ENGINE_SHUTTING_DOWN', {
    detail: 'The scheduler is closed.',
  });
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error
    ? reason
    : new DOMException('The operation was aborted.', 'AbortError');
}

/** Tasks should throw Errors; a bare value is wrapped so a rejection is always an Error. */
function toError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error(
        'A scheduled task rejected with a value that is not an Error.',
        {
          cause: value,
        },
      );
}
