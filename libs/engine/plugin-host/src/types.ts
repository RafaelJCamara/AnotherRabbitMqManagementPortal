// The contract of the tier-1 worker pool (blueprint 11).
//
// A worker module speaks a three-message convention over its `parentPort`:
//   worker -> pool  { type: 'ready' }                    once its module has loaded
//   pool -> worker  { type: 'job', id, input }           one job at a time per worker
//   worker -> pool  { type: 'result', id, value }        or { type: 'failure', id } when it threw
// A worker that does not answer within the timeout, runs out of memory or exits is terminated and
// replaced; the pool itself never throws and `run` never rejects.

export type RejectReason =
  | 'timeout' // ran past its time budget; the worker was terminated
  | 'out-of-memory' // passed the worker's memory limit; the worker was terminated
  | 'aborted' // the caller's signal fired (a running job's worker was terminated)
  | 'queue-full' // no worker free and no room to wait
  | 'input-too-large'
  | 'output-too-large'
  | 'worker-error' // the worker threw, died, sent nonsense, or could not start
  | 'closed';

export const REJECT_REASONS: readonly RejectReason[] = [
  'timeout',
  'out-of-memory',
  'aborted',
  'queue-full',
  'input-too-large',
  'output-too-large',
  'worker-error',
  'closed',
];

export type PoolOutcome<O> =
  | { readonly ok: true; readonly value: O }
  | { readonly ok: false; readonly reason: RejectReason };

/** What the event sink sees: counts, sizes and codes only, never an input or an output. */
export type PoolEvent =
  | {
      readonly type: 'rejected';
      readonly reason: RejectReason;
      readonly inputBytes: number;
    }
  | { readonly type: 'worker-started' }
  | {
      readonly type: 'worker-terminated';
      readonly reason: RejectReason | 'idle-exit';
    }
  | { readonly type: 'worker-start-failed' };

export interface PoolStats {
  readonly size: number;
  readonly maxQueue: number;
  readonly workers: {
    readonly starting: number;
    readonly idle: number;
    readonly busy: number;
  };
  /** Jobs waiting for a worker. */
  readonly queued: number;
  readonly queuedBytes: number;
  /** The most jobs that ever waited at once (never above `maxQueue`). */
  readonly queueHighWater: number;
  readonly running: number;
  readonly submitted: number;
  readonly completed: number;
  /** Jobs that did not complete, by reason. Every one is counted (I-6, I-13). */
  readonly rejected: Readonly<Record<RejectReason, number>>;
  readonly workersStarted: number;
  readonly workersTerminated: number;
  readonly workerStartFailures: number;
}

export interface WorkerPoolOptions<I, O> {
  /** The worker module. It must import only what Node can resolve itself (no aliases). */
  readonly workerUrl: URL;
  /** Workers, 1 to 8. Default 2. Workers start on demand. */
  readonly size?: number;
  /** Jobs that may wait for a free worker, 0 to 1024. Default 64. */
  readonly maxQueue?: number;
  /** Bytes of input that may wait, by `sizeOfInput`. Default 64 MiB. */
  readonly maxQueuedBytes?: number;
  /** Time a job may run once a worker has it. Default 250 ms. */
  readonly timeoutMs?: number;
  /** Time a worker may take to load its module. Default 5 s. */
  readonly startTimeoutMs?: number;
  /** V8 limits of each worker. Default 64 MB old generation, 16 MB young. */
  readonly resourceLimits?: {
    readonly maxOldGenerationSizeMb?: number;
    readonly maxYoungGenerationSizeMb?: number;
    readonly stackSizeMb?: number;
  };
  /** Size of an input in bytes, for the input and queue limits. Default 0. */
  readonly sizeOfInput?: (input: I) => number;
  /** Largest input a job may carry. Default 16 MiB. */
  readonly maxInputBytes?: number;
  /** Size of an output in bytes, for the output limit. Default 0. */
  readonly sizeOfOutput?: (output: O) => number;
  /** Largest output a job may return. Default 4 MiB. */
  readonly maxOutputBytes?: number;
  readonly workerData?: unknown;
  /** Node options for the workers. Default none (a worker does not inherit the main thread's). */
  readonly execArgv?: readonly string[];
  readonly onEvent?: (event: PoolEvent) => void;
}

export interface RunOptions {
  readonly signal?: AbortSignal;
  /** Overrides the pool's time budget for this job, never above 60 s. */
  readonly timeoutMs?: number;
}

export interface WorkerPool<I, O> {
  /** Never rejects: every failure is a `PoolOutcome` with a reason. */
  run(input: I, options?: RunOptions): Promise<PoolOutcome<O>>;
  stats(): PoolStats;
  /** Rejects the queue as `closed`, terminates the workers, and waits for them. Idempotent. */
  close(): Promise<void>;
}
