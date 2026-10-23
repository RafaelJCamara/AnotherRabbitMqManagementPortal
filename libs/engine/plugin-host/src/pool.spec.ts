import { afterEach, describe, expect, it } from 'vitest';

import { createWorkerPool } from './pool.ts';
import type { PoolEvent, WorkerPool, WorkerPoolOptions } from './types.ts';

interface Input {
  readonly op: string;
  readonly [key: string]: unknown;
}

const workerUrl = new URL('./testing/test-worker.ts', import.meta.url);
const flags = new Int32Array(new SharedArrayBuffer(8));
const open: WorkerPool<Input, unknown>[] = [];

function makePool(
  extra: Partial<WorkerPoolOptions<Input, unknown>> = {},
): WorkerPool<Input, unknown> {
  Atomics.store(flags, 0, 0);
  Atomics.store(flags, 1, 0);
  const pool = createWorkerPool<Input, unknown>({
    workerUrl,
    workerData: { flags: flags.buffer },
    execArgv: ['--no-warnings'],
    size: 1,
    maxQueue: 2,
    timeoutMs: 5000,
    ...extra,
  });
  open.push(pool);
  return pool;
}

afterEach(async () => {
  Atomics.store(flags, 0, 1);
  Atomics.store(flags, 1, 1);
  await Promise.all(open.splice(0).map((pool) => pool.close()));
});

describe('worker pool', () => {
  it('M1-10 AC-2 defaults to two workers, a queue of 64 and the blueprint budget', () => {
    const pool = createWorkerPool<Input, unknown>({ workerUrl });
    open.push(pool);
    expect(pool.stats()).toMatchObject({ size: 2, maxQueue: 64, queued: 0 });
    // Out-of-range options are clamped, not trusted.
    const clamped = createWorkerPool<Input, unknown>({
      workerUrl,
      size: 1000,
      maxQueue: -5,
    });
    open.push(clamped);
    expect(clamped.stats()).toMatchObject({ size: 8, maxQueue: 0 });
  });

  it('M1-10 AC-2 runs a job off the main thread and reuses the worker', async () => {
    const pool = makePool();
    expect(await pool.run({ op: 'echo', value: { a: [1, 2] } })).toEqual({
      ok: true,
      value: { a: [1, 2] },
    });
    expect(await pool.run({ op: 'echo', value: 'again' })).toEqual({
      ok: true,
      value: 'again',
    });
    const stats = pool.stats();
    expect(stats).toMatchObject({
      submitted: 2,
      completed: 2,
      workersStarted: 1,
      workersTerminated: 0,
      queued: 0,
      running: 0,
      workers: { starting: 0, idle: 1, busy: 0 },
    });
  });

  it('M1-10 AC-2 terminates a worker that runs past its time budget, counts it, and serves the next job', async () => {
    const pool = makePool({ timeoutMs: 100 });
    const outcome = await pool.run({ op: 'spin' });
    expect(outcome).toEqual({ ok: false, reason: 'timeout' });
    expect(pool.stats()).toMatchObject({
      workersTerminated: 1,
      rejected: { timeout: 1 },
      workers: { idle: 0, busy: 0 },
    });
    // The engine stays healthy: the next job gets a fresh worker.
    expect(await pool.run({ op: 'echo', value: 7 })).toEqual({
      ok: true,
      value: 7,
    });
    expect(pool.stats()).toMatchObject({ workersStarted: 2, completed: 1 });
    // A per-job budget overrides the pool's, and never beyond 60 s.
    expect(await pool.run({ op: 'spin' }, { timeoutMs: 50 })).toEqual({
      ok: false,
      reason: 'timeout',
    });
  });

  it('M1-10 AC-2 terminates a worker that passes its memory limit, counts it, and serves the next job', async () => {
    const pool = makePool({
      resourceLimits: {
        maxOldGenerationSizeMb: 24,
        maxYoungGenerationSizeMb: 4,
      },
    });
    const outcome = await pool.run({ op: 'hog' });
    expect(outcome).toEqual({ ok: false, reason: 'out-of-memory' });
    expect(pool.stats()).toMatchObject({
      workersTerminated: 1,
      rejected: { 'out-of-memory': 1 },
    });
    expect(await pool.run({ op: 'echo', value: 'alive' })).toEqual({
      ok: true,
      value: 'alive',
    });
  });

  it('M1-10 AC-10 bounds the queue, rejects the overflow at once and counts it', async () => {
    const events: PoolEvent[] = [];
    const pool = makePool({
      onEvent: (event) => {
        events.push(event);
      },
    });
    const seen: number[] = [];
    const watch = (): void => {
      seen.push(pool.stats().queued);
    };
    const first = pool.run({ op: 'hold' });
    watch();
    const second = pool.run({ op: 'echo', value: 2 });
    watch();
    const third = pool.run({ op: 'echo', value: 3 });
    watch();
    // One running, two waiting: the fourth and fifth find no room.
    expect(await pool.run({ op: 'echo', value: 4 })).toEqual({
      ok: false,
      reason: 'queue-full',
    });
    expect(await pool.run({ op: 'echo', value: 5 })).toEqual({
      ok: false,
      reason: 'queue-full',
    });
    watch();
    expect(pool.stats()).toMatchObject({
      queued: 2,
      queueHighWater: 2,
      submitted: 5,
      rejected: { 'queue-full': 2 },
    });
    expect(Math.max(...seen)).toBeLessThanOrEqual(2);
    // Nothing waiting was lost: releasing the held job lets the queue drain in order.
    Atomics.store(flags, 0, 1);
    expect(await first).toEqual({ ok: true, value: 'released' });
    expect(await second).toEqual({ ok: true, value: 2 });
    expect(await third).toEqual({ ok: true, value: 3 });
    expect(pool.stats()).toMatchObject({
      queued: 0,
      completed: 3,
      queueHighWater: 2,
    });
    expect(events.filter((e) => e.type === 'rejected')).toEqual([
      { type: 'rejected', reason: 'queue-full', inputBytes: 0 },
      { type: 'rejected', reason: 'queue-full', inputBytes: 0 },
    ]);
  });

  it('M1-10 AC-10 bounds the bytes that wait as well as the jobs', async () => {
    const pool = makePool({
      maxQueue: 100,
      maxQueuedBytes: 1000,
      sizeOfInput: (input) => (typeof input.size === 'number' ? input.size : 0),
      maxInputBytes: 600,
    });
    const first = pool.run({ op: 'hold' });
    const second = pool.run({ op: 'echo', value: 1, size: 600 });
    expect(await pool.run({ op: 'echo', size: 600 })).toEqual({
      ok: false,
      reason: 'queue-full',
    });
    expect(await pool.run({ op: 'echo', size: 601 })).toEqual({
      ok: false,
      reason: 'input-too-large',
    });
    expect(pool.stats()).toMatchObject({ queued: 1, queuedBytes: 600 });
    Atomics.store(flags, 0, 1);
    await first;
    await second;
    expect(pool.stats().queuedBytes).toBe(0);
  });

  it('M1-10 AC-10 with no room to wait at all, a busy pool rejects at once', async () => {
    const pool = makePool({ maxQueue: 0 });
    const first = pool.run({ op: 'hold' });
    expect(await pool.run({ op: 'echo' })).toEqual({
      ok: false,
      reason: 'queue-full',
    });
    expect(pool.stats().queueHighWater).toBe(0);
    Atomics.store(flags, 0, 1);
    await first;
  });

  it('M1-10 AC-11 removes an aborted job from the queue without touching the running one', async () => {
    const pool = makePool();
    const first = pool.run({ op: 'hold' });
    const controller = new AbortController();
    const second = pool.run({ op: 'echo' }, { signal: controller.signal });
    expect(pool.stats().queued).toBe(1);
    controller.abort();
    expect(await second).toEqual({ ok: false, reason: 'aborted' });
    expect(pool.stats()).toMatchObject({
      queued: 0,
      workersTerminated: 0,
      rejected: { aborted: 1 },
    });
    Atomics.store(flags, 0, 1);
    expect(await first).toEqual({ ok: true, value: 'released' });
  });

  it('M1-10 AC-11 terminates the worker of an aborted running job and serves the next one', async () => {
    const pool = makePool();
    const controller = new AbortController();
    const running = pool.run({ op: 'hold' }, { signal: controller.signal });
    const waitingJob = pool.run({ op: 'echo', value: 'next' });
    // Let the worker start and take the held job.
    for (let i = 0; i < 200 && pool.stats().running === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    controller.abort();
    expect(await running).toEqual({ ok: false, reason: 'aborted' });
    expect(await waitingJob).toEqual({ ok: true, value: 'next' });
    expect(pool.stats()).toMatchObject({
      workersTerminated: 1,
      rejected: { aborted: 1 },
      completed: 1,
    });
  });

  it('M1-10 AC-11 rejects a job whose signal is already aborted without starting a worker', async () => {
    const pool = makePool();
    expect(
      await pool.run({ op: 'echo' }, { signal: AbortSignal.abort() }),
    ).toEqual({
      ok: false,
      reason: 'aborted',
    });
    expect(pool.stats()).toMatchObject({ workersStarted: 0, queued: 0 });
  });

  it('M1-10 AC-12 keeps the main loop turning while a worker is busy', async () => {
    const pool = makePool();
    const job = pool.run({ op: 'spin-until' });
    // The worker is stuck in a busy loop until the main thread says so. If the work ran on this
    // thread these ticks could never happen and this test would never end.
    let ticks = 0;
    while (ticks < 50) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      ticks++;
    }
    expect(pool.stats().running).toBe(1);
    Atomics.store(flags, 1, 1);
    expect(await job).toEqual({ ok: true, value: 'spun' });
    expect(ticks).toBe(50);
  });

  it('M1-10 AC-2 turns a worker that throws, dies, lies or sends nonsense into a coded rejection', async () => {
    const pool = makePool();
    expect(await pool.run({ op: 'throw' })).toEqual({
      ok: false,
      reason: 'worker-error',
    });
    // A thrown job leaves the worker alive.
    expect(pool.stats()).toMatchObject({
      workersStarted: 1,
      workersTerminated: 0,
    });
    expect(await pool.run({ op: 'exit' })).toEqual({
      ok: false,
      reason: 'worker-error',
    });
    expect(await pool.run({ op: 'garbage' })).toEqual({
      ok: false,
      reason: 'worker-error',
    });
    expect(await pool.run({ op: 'wrong-id' })).toEqual({
      ok: false,
      reason: 'worker-error',
    });
    expect(pool.stats().rejected['worker-error']).toBe(4);
    expect(await pool.run({ op: 'echo', value: 1 })).toEqual({
      ok: true,
      value: 1,
    });
    // A value that cannot be cloned never reaches the worker.
    expect(await pool.run({ op: 'echo', value: () => 1 })).toEqual({
      ok: false,
      reason: 'worker-error',
    });
    expect(await pool.run({ op: 'echo', value: 2 })).toEqual({
      ok: true,
      value: 2,
    });
  });

  it('M1-10 AC-2 counts a worker that cannot start, and does not retry in a loop', async () => {
    const pool = makePool({
      workerUrl: new URL('./testing/does-not-exist.ts', import.meta.url),
    });
    expect(await pool.run({ op: 'echo' })).toEqual({
      ok: false,
      reason: 'worker-error',
    });
    expect(pool.stats()).toMatchObject({
      workerStartFailures: 1,
      workersStarted: 0,
    });
    expect(await pool.run({ op: 'echo' })).toEqual({
      ok: false,
      reason: 'worker-error',
    });
    expect(pool.stats().workerStartFailures).toBe(2);
  });

  it('M1-10 AC-2 gives up on a worker that never says ready, after the start timeout', async () => {
    const pool = makePool({
      workerUrl: new URL('./testing/silent-worker.ts', import.meta.url),
      startTimeoutMs: 100,
    });
    expect(await pool.run({ op: 'echo' })).toEqual({
      ok: false,
      reason: 'worker-error',
    });
    expect(pool.stats()).toMatchObject({
      workerStartFailures: 1,
      workersTerminated: 1,
      workers: { starting: 0, idle: 0, busy: 0 },
    });
  });

  it('M1-10 AC-2 refuses an output above the limit', async () => {
    const pool = makePool({
      sizeOfOutput: (output) =>
        (output as { byteLength?: number }).byteLength ?? 0,
      maxOutputBytes: 1000,
    });
    expect(await pool.run({ op: 'big', bytes: 2000 })).toEqual({
      ok: false,
      reason: 'output-too-large',
    });
    expect(await pool.run({ op: 'big', bytes: 500 })).toMatchObject({
      ok: true,
    });
  });

  it('M1-10 AC-2 closes: the queue is rejected, the workers are terminated, later jobs are refused', async () => {
    const pool = makePool();
    const running = pool.run({ op: 'hold' });
    const waitingJob = pool.run({ op: 'echo' });
    await pool.close();
    expect(await running).toEqual({ ok: false, reason: 'closed' });
    expect(await waitingJob).toEqual({ ok: false, reason: 'closed' });
    expect(await pool.run({ op: 'echo' })).toEqual({
      ok: false,
      reason: 'closed',
    });
    await pool.close();
    expect(pool.stats()).toMatchObject({
      queued: 0,
      workers: { starting: 0, idle: 0, busy: 0 },
    });
  });

  it('M1-10 AC-13 tells its event sink about sizes and reasons only, and survives a sink that throws', async () => {
    const events: PoolEvent[] = [];
    let throwing = true;
    const pool = makePool({
      timeoutMs: 100,
      sizeOfInput: () => 12,
      onEvent: (event) => {
        events.push(event);
        if (throwing) throw new Error('sink failed');
      },
    });
    expect(await pool.run({ op: 'spin', secret: 'canary-8c1f' })).toEqual({
      ok: false,
      reason: 'timeout',
    });
    throwing = false;
    expect(await pool.run({ op: 'echo', value: 'canary-8c1f' })).toMatchObject({
      ok: true,
    });
    expect(JSON.stringify(events)).not.toContain('canary');
    expect(events).toContainEqual({
      type: 'rejected',
      reason: 'timeout',
      inputBytes: 12,
    });
    expect(events).toContainEqual({
      type: 'worker-terminated',
      reason: 'timeout',
    });
  });
});
