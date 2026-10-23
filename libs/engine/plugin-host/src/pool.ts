// The tier-1 worker pool over `node:worker_threads` (blueprint 11, OQ-1200). First-party code runs
// here, off the main loop, with a bounded queue (I-6), a time budget and a memory limit per call,
// abort, and a counter for every job that did not complete (I-13). A worker that times out, runs
// out of memory, exits or misbehaves is terminated and replaced by the next job; the engine's own
// thread is never involved in the work and is never blocked by it (I-5).
import { Worker } from 'node:worker_threads';

import {
  REJECT_REASONS,
  type PoolEvent,
  type PoolOutcome,
  type PoolStats,
  type RejectReason,
  type RunOptions,
  type WorkerPool,
  type WorkerPoolOptions,
} from './types.ts';

const MIB = 1024 * 1024;
const MAX_TIMEOUT_MS = 60_000;

interface Job<I, O> {
  readonly input: I;
  readonly bytes: number;
  readonly timeoutMs: number;
  readonly settle: (outcome: PoolOutcome<O>) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
  id: number;
  settled: boolean;
}

interface Slot<I, O> {
  readonly worker: Worker;
  state: 'starting' | 'idle' | 'busy' | 'gone';
  job: Job<I, O> | undefined;
  timer: NodeJS.Timeout | undefined;
  startTimer: NodeJS.Timeout | undefined;
}

function clamp(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function createWorkerPool<I, O>(
  options: WorkerPoolOptions<I, O>,
): WorkerPool<I, O> {
  const size = clamp(options.size, 1, 8, 2);
  const maxQueue = clamp(options.maxQueue, 0, 1024, 64);
  const maxQueuedBytes = clamp(options.maxQueuedBytes, 0, 1024 * MIB, 64 * MIB);
  const timeoutMs = clamp(options.timeoutMs, 1, MAX_TIMEOUT_MS, 250);
  const startTimeoutMs = clamp(options.startTimeoutMs, 1, MAX_TIMEOUT_MS, 5000);
  const maxInputBytes = clamp(options.maxInputBytes, 0, 1024 * MIB, 16 * MIB);
  const maxOutputBytes = clamp(options.maxOutputBytes, 0, 1024 * MIB, 4 * MIB);
  const limits = options.resourceLimits ?? {};
  const resourceLimits = {
    maxOldGenerationSizeMb: clamp(limits.maxOldGenerationSizeMb, 8, 4096, 64),
    maxYoungGenerationSizeMb: clamp(
      limits.maxYoungGenerationSizeMb,
      1,
      1024,
      16,
    ),
    stackSizeMb: clamp(limits.stackSizeMb, 1, 64, 4),
  };

  const slots: Slot<I, O>[] = [];
  const waiting: Job<I, O>[] = [];
  const terminating = new Set<Promise<number>>();
  const rejected = Object.fromEntries(
    REJECT_REASONS.map((reason) => [reason, 0]),
  ) as Record<RejectReason, number>;
  let queuedBytes = 0;
  let highWater = 0;
  let submitted = 0;
  let completed = 0;
  let started = 0;
  let terminated = 0;
  let startFailures = 0;
  let nextId = 1;
  let closed = false;

  const emit = (event: PoolEvent): void => {
    try {
      options.onEvent?.(event);
    } catch {
      // a sink that throws must not take the pool down
    }
  };

  const finish = (job: Job<I, O>, outcome: PoolOutcome<O>): void => {
    if (job.settled) return;
    job.settled = true;
    job.signal?.removeEventListener('abort', job.onAbort);
    if (outcome.ok) {
      completed++;
    } else {
      rejected[outcome.reason]++;
      emit({ type: 'rejected', reason: outcome.reason, inputBytes: job.bytes });
    }
    job.settle(outcome);
  };

  const retire = (
    slot: Slot<I, O>,
    reason: RejectReason | 'idle-exit',
  ): void => {
    if (slot.state === 'gone') return;
    slot.state = 'gone';
    if (slot.timer !== undefined) clearTimeout(slot.timer);
    if (slot.startTimer !== undefined) clearTimeout(slot.startTimer);
    const at = slots.indexOf(slot);
    if (at !== -1) slots.splice(at, 1);
    terminated++;
    emit({ type: 'worker-terminated', reason });
    const done = slot.worker.terminate();
    terminating.add(done);
    void done
      .catch(() => 0)
      .finally(() => {
        terminating.delete(done);
      });
  };

  /** Ends the slot's job with `reason` and kills the worker. */
  const fail = (slot: Slot<I, O>, reason: RejectReason): void => {
    const { job } = slot;
    slot.job = undefined;
    retire(slot, reason);
    if (job !== undefined) finish(job, { ok: false, reason });
    pump();
  };

  const dispatch = (slot: Slot<I, O>): void => {
    const { job } = slot;
    if (job === undefined || slot.state !== 'idle') return;
    job.id = nextId++;
    slot.state = 'busy';
    try {
      slot.worker.postMessage({ type: 'job', id: job.id, input: job.input });
    } catch {
      // The input cannot be cloned: the worker is fine, the job is not.
      slot.job = undefined;
      slot.state = 'idle';
      finish(job, { ok: false, reason: 'worker-error' });
      pump();
      return;
    }
    slot.timer = setTimeout(() => {
      fail(slot, 'timeout');
    }, job.timeoutMs);
    slot.timer.unref();
  };

  const onMessage = (slot: Slot<I, O>, message: unknown): void => {
    if (slot.state === 'gone') return;
    if (!isRecord(message) || typeof message.type !== 'string') {
      fail(slot, 'worker-error');
      return;
    }
    if (message.type === 'ready' && slot.state === 'starting') {
      if (slot.startTimer !== undefined) clearTimeout(slot.startTimer);
      slot.startTimer = undefined;
      slot.state = 'idle';
      started++;
      emit({ type: 'worker-started' });
      if (slot.job === undefined) pump();
      else dispatch(slot);
      return;
    }
    const { job } = slot;
    if (slot.state !== 'busy' || job === undefined || message.id !== job.id) {
      fail(slot, 'worker-error');
      return;
    }
    if (slot.timer !== undefined) clearTimeout(slot.timer);
    slot.timer = undefined;
    slot.job = undefined;
    slot.state = 'idle';
    if (message.type === 'result') {
      let outputBytes = 0;
      try {
        outputBytes = options.sizeOfOutput?.(message.value as O) ?? 0;
      } catch {
        outputBytes = Number.POSITIVE_INFINITY;
      }
      finish(
        job,
        outputBytes > maxOutputBytes
          ? { ok: false, reason: 'output-too-large' }
          : { ok: true, value: message.value as O },
      );
    } else {
      finish(job, { ok: false, reason: 'worker-error' });
    }
    pump();
  };

  const spawn = (job: Job<I, O>): void => {
    let worker: Worker;
    try {
      worker = new Worker(options.workerUrl, {
        resourceLimits,
        // A worker gets neither the main thread's environment (I-10) nor its node options.
        env: {},
        execArgv: [...(options.execArgv ?? [])],
        workerData: options.workerData,
        stdout: false,
        stderr: false,
        trackUnmanagedFds: false,
      });
    } catch {
      startFailures++;
      emit({ type: 'worker-start-failed' });
      finish(job, { ok: false, reason: 'worker-error' });
      return;
    }
    worker.unref();
    const slot: Slot<I, O> = {
      worker,
      state: 'starting',
      job,
      timer: undefined,
      startTimer: undefined,
    };
    slots.push(slot);
    slot.startTimer = setTimeout(() => {
      startFailures++;
      emit({ type: 'worker-start-failed' });
      fail(slot, 'worker-error');
    }, startTimeoutMs);
    slot.startTimer.unref();
    worker.on('message', (message: unknown) => {
      onMessage(slot, message);
    });
    worker.on('error', (error: unknown) => {
      if (slot.state === 'gone') return;
      const code = isRecord(error) ? error.code : undefined;
      if (slot.state === 'starting') {
        startFailures++;
        emit({ type: 'worker-start-failed' });
      }
      fail(
        slot,
        code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'out-of-memory' : 'worker-error',
      );
    });
    worker.on('messageerror', () => {
      fail(slot, 'worker-error');
    });
    worker.on('exit', () => {
      if (slot.state === 'gone') return;
      if (slot.job === undefined) {
        retire(slot, 'idle-exit');
        return;
      }
      fail(slot, 'worker-error');
    });
  };

  /** Hands waiting jobs to idle workers, and starts workers up to `size` for the rest. */
  function pump(): void {
    while (waiting.length > 0 && !closed) {
      const idle = slots.find(
        (slot) => slot.state === 'idle' && slot.job === undefined,
      );
      const job = waiting[0];
      if (job === undefined) return;
      if (idle !== undefined) {
        waiting.shift();
        queuedBytes -= job.bytes;
        idle.job = job;
        dispatch(idle);
      } else if (slots.length < size) {
        waiting.shift();
        queuedBytes -= job.bytes;
        spawn(job);
      } else {
        return;
      }
    }
  }

  const run = (
    input: I,
    runOptions: RunOptions = {},
  ): Promise<PoolOutcome<O>> =>
    new Promise<PoolOutcome<O>>((resolve) => {
      submitted++;
      let bytes = 0;
      try {
        bytes = options.sizeOfInput?.(input) ?? 0;
      } catch {
        bytes = Number.POSITIVE_INFINITY;
      }
      const signal = runOptions.signal;
      const job: Job<I, O> = {
        input,
        bytes: Number.isFinite(bytes) ? bytes : maxInputBytes + 1,
        timeoutMs: clamp(runOptions.timeoutMs, 1, MAX_TIMEOUT_MS, timeoutMs),
        settle: resolve,
        signal,
        id: 0,
        settled: false,
        onAbort: () => {
          const queued = waiting.indexOf(job);
          if (queued !== -1) {
            waiting.splice(queued, 1);
            queuedBytes -= job.bytes;
            finish(job, { ok: false, reason: 'aborted' });
            return;
          }
          const slot = slots.find((candidate) => candidate.job === job);
          if (slot !== undefined) fail(slot, 'aborted');
        },
      };
      if (closed) {
        finish(job, { ok: false, reason: 'closed' });
        return;
      }
      if (signal?.aborted === true) {
        finish(job, { ok: false, reason: 'aborted' });
        return;
      }
      if (job.bytes > maxInputBytes) {
        finish(job, { ok: false, reason: 'input-too-large' });
        return;
      }
      const free =
        slots.some((slot) => slot.state === 'idle' && slot.job === undefined) ||
        slots.length < size;
      if (
        !free &&
        (waiting.length >= maxQueue || queuedBytes + job.bytes > maxQueuedBytes)
      ) {
        finish(job, { ok: false, reason: 'queue-full' });
        return;
      }
      signal?.addEventListener('abort', job.onAbort, { once: true });
      waiting.push(job);
      queuedBytes += job.bytes;
      pump();
      highWater = Math.max(highWater, waiting.length);
      return undefined;
    });

  const stats = (): PoolStats => {
    let starting = 0;
    let idle = 0;
    let busy = 0;
    for (const slot of slots) {
      if (slot.state === 'starting') starting++;
      else if (slot.state === 'idle') idle++;
      else if (slot.state === 'busy') busy++;
    }
    return {
      size,
      maxQueue,
      workers: { starting, idle, busy },
      queued: waiting.length,
      queuedBytes,
      queueHighWater: highWater,
      running: slots.filter((slot) => slot.job !== undefined).length,
      submitted,
      completed,
      rejected: { ...rejected },
      workersStarted: started,
      workersTerminated: terminated,
      workerStartFailures: startFailures,
    };
  };

  const close = async (): Promise<void> => {
    closed = true;
    for (const job of waiting.splice(0)) {
      queuedBytes -= job.bytes;
      finish(job, { ok: false, reason: 'closed' });
    }
    for (const slot of [...slots]) {
      const { job } = slot;
      slot.job = undefined;
      retire(slot, 'closed');
      if (job !== undefined) finish(job, { ok: false, reason: 'closed' });
    }
    await Promise.allSettled([...terminating]);
  };

  return { run, stats, close };
}
