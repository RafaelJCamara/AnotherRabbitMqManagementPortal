import type { JobId } from '@app/contracts';
import {
  AppError,
  createAesGcmTestCipher,
  createDrainCoordinator,
  createIdGenerator,
  createManualClock,
  createManualTimers,
  createRecordingWrites,
  createTestPrincipal,
  type DrainPhaseSpec,
  type PayloadCipher,
} from '@app/kernel';
import type { JobRecord, Principal } from '@app/ports';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { abortError } from './abort.ts';
import { defineJob } from './define-job.ts';
import { openCheckpoint } from './envelope.ts';
import { createMemoryJobStore, type MemoryJobStore } from './memory-store.ts';
import { createJobRunner, type JobRunnerOptions } from './runner.ts';
import type {
  JobContext,
  JobDef,
  JobEvent,
  JobPreflight,
  JobStopReason,
} from './types.ts';

const InputSchema = z.strictObject({ n: z.number() });
const CheckpointSchema = z.strictObject({ at: z.number() });
const OutputSchema = z.strictObject({ ok: z.boolean() });
type In = z.infer<typeof InputSchema>;
type Cp = z.infer<typeof CheckpointSchema>;
type Out = z.infer<typeof OutputSchema>;
type Ctx = JobContext<In, Cp>;

const PLAN = 'a'.repeat(64);
const person = createTestPrincipal({ id: 'user-1' });

/** Rejects when the signal aborts: how a well-behaved job notices a stop. */
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(abortError(signal));
    signal.addEventListener('abort', () => {
      reject(abortError(signal));
    });
  });
}

async function* idle(ctx: Ctx): AsyncGenerator<JobEvent, Out, void> {
  yield { kind: 'progress', done: 0 };
  await untilAborted(ctx.signal);
  return { ok: true };
}

async function* quick(): AsyncGenerator<JobEvent, Out, void> {
  await Promise.resolve();
  yield { kind: 'checkpoint' };
  return { ok: true };
}

interface Hooks {
  type?: string;
  version?: number;
  resumable?: boolean;
  run?: (ctx: Ctx) => AsyncGenerator<JobEvent, Out, void>;
  onDrain?: (
    ctx: Ctx,
    reason: JobStopReason,
    deadlineMs: number,
  ) => Promise<void>;
  concurrencyKey?: (input: In) => string;
  throttle?: (input: In) => { perSec: number; burst?: number };
  preflight?: (ctx: {
    input: In;
    checkpoint?: Cp;
    principal: Principal;
  }) => Promise<JobPreflight>;
}

function makeJob(hooks: Hooks = {}): JobDef {
  const def: JobDef<In, Cp, Out> = {
    type: hooks.type ?? 'test.job',
    version: hooks.version ?? 1,
    input: InputSchema,
    checkpoint: CheckpointSchema,
    output: OutputSchema,
    resumable: hooks.resumable ?? false,
    run: hooks.run ?? idle,
    onDrain: hooks.onDrain ?? (() => Promise.resolve()),
    ...(hooks.concurrencyKey === undefined
      ? {}
      : { concurrencyKey: hooks.concurrencyKey }),
    ...(hooks.throttle === undefined ? {} : { throttle: hooks.throttle }),
    ...(hooks.preflight === undefined ? {} : { preflight: hooks.preflight }),
  };
  return defineJob(def);
}

interface HarnessOptions extends Partial<JobRunnerOptions> {
  store?: MemoryJobStore;
}

function harness(options: HarnessOptions = {}) {
  const clock = createManualClock(1_700_000_000_000);
  const timers = createManualTimers(clock);
  const store = options.store ?? createMemoryJobStore();
  const cipher = createAesGcmTestCipher();
  const ids = createIdGenerator({ clock });
  const { writes } = createRecordingWrites();
  const states: { id: JobId; state: string; reason: string | null }[] = [];
  const events: { id: JobId; event: JobEvent }[] = [];
  const runner = createJobRunner({
    store,
    cipher,
    clock,
    timers,
    ids,
    writes,
    owner: 'runner-a',
    onState: (id, state, reason) => states.push({ id, state, reason }),
    onEvent: (id, event) => events.push({ id, event }),
    ...options,
  });
  let keys = 0;
  const submit = (
    type = 'test.job',
    input: unknown = { n: 1 },
    who: Principal = person,
    key?: string,
  ) => {
    keys += 1;
    return runner.submit(type, input, who, {
      idempotencyKey: key ?? `idem-key-${String(keys)}`,
      planHash: PLAN,
    });
  };
  const flush = async (times = 8): Promise<void> => {
    for (let i = 0; i < times; i += 1) await timers.settle();
  };
  const row = async (id: JobId): Promise<JobRecord> => {
    const found = await store.get(id);
    if (found === undefined) throw new Error('no such job');
    return found;
  };
  return {
    clock,
    timers,
    store,
    cipher,
    ids,
    writes,
    runner,
    states,
    events,
    submit,
    flush,
    row,
  };
}

describe('job runner', () => {
  it('AC-1 drain("shutdown", 2000) calls onDrain within the phase-3 budget, pauses the job, and flushes even when a phase overruns', async () => {
    const h = harness();
    const drained: { reason: string; deadlineMs: number }[] = [];
    h.runner.register(
      makeJob({
        type: 'test.good',
        onDrain: async (ctx, reason, deadlineMs) => {
          drained.push({ reason, deadlineMs });
          await ctx.save({ at: 7 });
        },
      }),
    );
    // A job that ignores its signal and whose onDrain never ends: the worst case.
    h.runner.register(
      makeJob({
        type: 'test.hung',
        run: async function* () {
          yield { kind: 'progress', done: 0 };
          await new Promise<never>(() => undefined);
          return { ok: true };
        },
        onDrain: () => new Promise<void>(() => undefined),
      }),
    );
    await h.runner.start();
    const good = await h.submit('test.good');
    const hung = await h.submit('test.hung');
    await h.flush();
    expect(h.runner.stats().running).toBe(2);

    const flushedWith: string[] = [];
    const phases: DrainPhaseSpec[] = [
      { name: 'gate', run: () => Promise.resolve() },
      { name: 'peeks', run: () => new Promise<void>(() => undefined) },
      h.runner.drainPhase(),
      {
        name: 'flush',
        run: async () => {
          flushedWith.push(
            `${(await h.row(good)).state}/${(await h.row(hung)).state}`,
          );
        },
      },
    ];
    const coordinator = createDrainCoordinator({
      phases,
      clock: h.clock,
      timers: h.timers,
    });
    const started = h.clock.monotonic();

    const pending = coordinator.drain('quit', 2000);
    await h.flush();
    await h.timers.advance(2000);
    const results = await pending;

    // Peeks hung and was cut off at 600 ms; the jobs phase ran from 600 ms for at most 800 ms.
    expect(drained).toHaveLength(1);
    expect(drained[0]?.reason).toBe('shutdown');
    expect(drained[0]?.deadlineMs).toBeLessThanOrEqual(800);
    expect(await h.row(good)).toMatchObject({
      state: 'paused-interrupted',
      stateReason: 'shutdown',
      leaseOwner: null,
    });
    const saved = (await h.row(good)).checkpoint;
    expect(
      await openCheckpoint(h.cipher, good, saved ?? new Uint8Array()),
    ).toEqual({ at: 7 });
    expect(await h.row(hung)).toMatchObject({
      state: 'paused-interrupted',
      stateReason: 'shutdown:on-drain-timeout',
    });
    // The database is flushed after the jobs were written, and within the 2000 ms.
    expect(flushedWith).toEqual(['paused-interrupted/paused-interrupted']);
    expect(results.map((r) => [r.phase, r.ok, r.timedOut === true])).toEqual([
      ['gate', true, false],
      ['peeks', false, true],
      ['sources-jobs', false, false],
      ['taps-firehose', true, false],
      ['flush', true, false],
    ]);
    expect(
      results.find((r) => r.phase === 'sources-jobs')?.ms,
    ).toBeLessThanOrEqual(800);
    expect(h.clock.monotonic() - started).toBeLessThanOrEqual(2000);
    expect(h.runner.stats()).toEqual({
      running: 0,
      accepting: false,
      draining: true,
    });
  });

  describe('submit', () => {
    it('stores a queued job and returns its id; the same requester and key return the same job', async () => {
      const h = harness();
      h.runner.register(makeJob());

      const first = await h.submit('test.job', { n: 1 }, person, 'same-key-1');
      const again = await h.submit('test.job', { n: 1 }, person, 'same-key-1');
      const other = await h.submit(
        'test.job',
        { n: 1 },
        createTestPrincipal({ id: 'user-2' }),
        'same-key-1',
      );

      expect(again).toBe(first);
      expect(other).not.toBe(first);
      expect(await h.row(first)).toMatchObject({
        state: 'queued',
        type: 'test.job',
        version: 1,
        principalId: 'user-1',
        planHash: PLAN,
        idempotencyKey: 'same-key-1',
      });
      expect(h.states).toEqual([
        { id: first, state: 'queued', reason: null },
        { id: other, state: 'queued', reason: null },
      ]);
    });

    it('refuses the same key for different work, and malformed requests, before storing anything', async () => {
      const h = harness();
      h.runner.register(makeJob());
      h.runner.register(makeJob({ type: 'test.other' }));
      await h.submit('test.job', { n: 1 }, person, 'key-reused-1');
      const bad = (call: Promise<unknown>) =>
        call.catch((error: unknown) => error);

      expect(
        await bad(h.submit('test.other', { n: 1 }, person, 'key-reused-1')),
      ).toMatchObject({
        code: 'VALIDATION_FAILED',
        status: 409,
      });
      expect(
        await bad(
          h.runner.submit('test.job', { n: 1 }, person, {
            idempotencyKey: 'key-reused-1',
            planHash: 'b'.repeat(64),
          }),
        ),
      ).toMatchObject({ status: 409 });
      expect(await bad(h.submit('nope.job'))).toMatchObject({
        code: 'NOT_FOUND',
      });
      expect(await bad(h.submit('test.job', { n: 'x' }))).toMatchObject({
        code: 'VALIDATION_FAILED',
      });
      expect(await bad(h.submit('test.job', { n: 1, extra: 1 }))).toMatchObject(
        { code: 'VALIDATION_FAILED' },
      );
      expect(
        await bad(h.submit('test.job', { n: 1 }, { id: 'x' } as never)),
      ).toMatchObject({
        code: 'UNAUTHENTICATED',
      });
      expect(
        await bad(h.submit('test.job', { n: 1 }, person, 'short')),
      ).toMatchObject({
        code: 'VALIDATION_FAILED',
      });
      for (const planHash of ['', 'A'.repeat(64), 'a'.repeat(63), 7 as never]) {
        expect(
          await bad(
            h.runner.submit('test.job', { n: 1 }, person, {
              idempotencyKey: 'key-valid-12',
              planHash,
            }),
          ),
        ).toMatchObject({ code: 'VALIDATION_FAILED' });
      }
      expect(h.store.rows.size).toBe(1);
    });

    it('refuses a concurrency key that is empty or too long', async () => {
      const h = harness();
      h.runner.register(
        makeJob({
          concurrencyKey: (input) => (input.n === 0 ? '' : 'x'.repeat(201)),
        }),
      );

      await expect(h.submit('test.job', { n: 0 })).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
      await expect(h.submit('test.job', { n: 1 })).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
      expect(h.store.rows.size).toBe(0);
    });

    it('stores the input sealed: the row holds none of it in the open', async () => {
      const h = harness();
      h.runner.register(makeJob());

      const id = await h.submit('test.job', { n: 424242 });

      const stored = await h.row(id);
      expect(Buffer.from(stored.input).includes(Buffer.from('424242'))).toBe(
        false,
      );
      expect(Buffer.from(stored.input).includes(Buffer.from('user-1'))).toBe(
        false,
      );
    });

    it('is refused with ENGINE_SHUTTING_DOWN while draining, and works again after reopen', async () => {
      const h = harness();
      h.runner.register(makeJob());
      await h.runner.start();

      await h.runner.drain('shutdown', 1000);
      await expect(h.submit()).rejects.toMatchObject({
        code: 'ENGINE_SHUTTING_DOWN',
      });
      await h.runner.reopen();

      expect(h.runner.stats()).toMatchObject({
        accepting: true,
        draining: false,
      });
      await expect(h.submit()).resolves.toBeTypeOf('string');
    });
  });

  describe('registration', () => {
    it('accepts only what defineJob returned, and each type once', () => {
      const h = harness();
      const def = makeJob();

      expect(() => {
        h.runner.register({ ...def });
      }).toThrow(TypeError);
      h.runner.register(def);
      expect(() => {
        h.runner.register(def);
      }).toThrow(/already registered/);
    });

    it('checks that the heartbeat is shorter than the lease, and the concurrency', () => {
      expect(() => harness({ heartbeatMs: 30_000, leaseMs: 30_000 })).toThrow(
        RangeError,
      );
      expect(() => harness({ heartbeatMs: 0 })).toThrow(RangeError);
      expect(() => harness({ maxConcurrent: 0 })).toThrow(RangeError);
    });
  });

  describe('running', () => {
    it('runs a job as its own job principal acting for the requester, with the typed input', async () => {
      const h = harness();
      const seen: Ctx[] = [];
      h.runner.register(
        makeJob({
          run: async function* (ctx) {
            seen.push(ctx);
            await Promise.resolve();
            yield { kind: 'checkpoint' };
            return { ok: true };
          },
        }),
      );
      const admin = createTestPrincipal({
        id: 'user-1',
        roles: ['admin', 'ops'],
      });
      await h.runner.start();

      const id = await h.submit('test.job', { n: 5 }, admin);
      await h.flush();

      const ctx = seen[0];
      expect(ctx?.input).toEqual({ n: 5 });
      expect(ctx?.jobId).toBe(id);
      expect(ctx?.principal).toMatchObject({
        kind: 'job',
        id: `job:${id}`,
        surface: 'job',
        unattended: true,
        roles: ['admin', 'ops'],
        onBehalfOf: { id: 'user-1', kind: 'desktop-user' },
      });
      expect(Object.isFrozen(ctx?.principal)).toBe(true);
      expect(ctx?.checkpoint).toBeUndefined();
      expect(ctx?.executorWrite).toBe(h.writes);
      expect(ctx?.leases).toBe(h.writes.connections);
    });

    it('stores the output sealed, drops the checkpoint and records the states in order', async () => {
      const h = harness();
      h.runner.register(
        makeJob({
          run: async function* (ctx) {
            await ctx.save({ at: 1 });
            yield { kind: 'progress', done: 1, total: 1 };
            return { ok: true };
          },
        }),
      );
      await h.runner.start();

      const id = await h.submit();
      await h.flush();

      const stored = await h.row(id);
      expect(stored).toMatchObject({
        state: 'succeeded',
        stateReason: null,
        checkpoint: null,
        leaseOwner: null,
        attempts: 1,
      });
      expect(stored.result).not.toBeNull();
      expect(
        Buffer.from(stored.result ?? new Uint8Array()).includes(
          Buffer.from('true'),
        ),
      ).toBe(false);
      expect(h.states.map((s) => s.state)).toEqual([
        'queued',
        'running',
        'succeeded',
      ]);
      expect((await h.store.events(id, 0, 10)).map((e) => e.toState)).toEqual([
        'queued',
        'running',
        'succeeded',
      ]);
      expect(h.events).toEqual([
        { id, event: { kind: 'progress', done: 1, total: 1 } },
      ]);
    });

    it('fails a job that throws, with the error code and never its message', async () => {
      const h = harness();
      h.runner.register(
        makeJob({
          type: 'test.plain',
          run: async function* () {
            await Promise.resolve();
            yield { kind: 'checkpoint' };
            throw new Error('password=hunter2 at /home/me/secret');
          },
        }),
      );
      h.runner.register(
        makeJob({
          type: 'test.app',
          run: async function* () {
            await Promise.resolve();
            yield { kind: 'checkpoint' };
            throw new AppError('BROKER_ERROR', { detail: 'token=abc123' });
          },
        }),
      );
      await h.runner.start();

      const plain = await h.submit('test.plain');
      const app = await h.submit('test.app');
      await h.flush();

      expect(await h.row(plain)).toMatchObject({
        state: 'failed',
        stateReason: 'INTERNAL',
      });
      expect(await h.row(app)).toMatchObject({
        state: 'failed',
        stateReason: 'BROKER_ERROR',
      });
      const events = JSON.stringify([
        ...(await h.store.events(plain, 0, 10)),
        ...(await h.store.events(app, 0, 10)),
      ]);
      expect(events).not.toContain('hunter2');
      expect(events).not.toContain('abc123');
    });

    it.each(['TOKEN_EXPIRED', 'UNAUTHENTICATED'] as const)(
      'moves a job whose delegated credentials expired (%s) to awaiting-credentials, keeping its checkpoint',
      async (code) => {
        const h = harness();
        h.runner.register(
          makeJob({
            run: async function* (ctx) {
              await ctx.save({ at: 4 });
              yield { kind: 'checkpoint' };
              throw new AppError(code);
            },
          }),
        );
        await h.runner.start();

        const id = await h.submit();
        await h.flush();

        const stored = await h.row(id);
        expect(stored).toMatchObject({
          state: 'awaiting-credentials',
          stateReason: code,
        });
        expect(stored.checkpoint).not.toBeNull();
      },
    );

    it('fails a job whose output does not match its schema', async () => {
      const h = harness();
      h.runner.register(
        makeJob({
          run: async function* () {
            await Promise.resolve();
            yield { kind: 'checkpoint' };
            return { ok: 'yes' } as never;
          },
        }),
      );
      await h.runner.start();

      const id = await h.submit();
      await h.flush();

      expect(await h.row(id)).toMatchObject({
        state: 'failed',
        stateReason: 'VALIDATION_FAILED',
      });
    });

    it('rejects a checkpoint that does not match its schema, and serialises concurrent saves', async () => {
      const h = harness();
      const outcome: string[] = [];
      h.runner.register(
        makeJob({
          run: async function* (ctx) {
            await ctx
              .save({ at: 'x' } as never)
              .catch(() => outcome.push('rejected'));
            await Promise.all([
              ctx.save({ at: 1 }),
              ctx.save({ at: 2 }),
              ctx.save({ at: 3 }),
            ]);
            yield { kind: 'checkpoint' };
            await untilAborted(ctx.signal);
            return { ok: true };
          },
        }),
      );
      await h.runner.start();

      const id = await h.submit();
      await h.flush();

      expect(outcome).toEqual(['rejected']);
      const stored = await h.row(id);
      expect(
        await openCheckpoint(
          h.cipher,
          id,
          stored.checkpoint ?? new Uint8Array(),
        ),
      ).toEqual({ at: 3 });
    });

    it('does not let a job save once it is settled', async () => {
      const h = harness();
      const contexts: Ctx[] = [];
      h.runner.register(
        makeJob({
          run: async function* (ctx) {
            contexts.push(ctx);
            await Promise.resolve();
            yield { kind: 'checkpoint' };
            return { ok: true };
          },
        }),
      );
      await h.runner.start();
      await h.submit();
      await h.flush();
      let saves = 0;
      const save = h.store.saveCheckpoint.bind(h.store);
      h.store.saveCheckpoint = (...args) => {
        saves += 1;
        return save(...args);
      };

      // The runner refuses it itself: a settled job does not touch the store again.
      await expect(contexts[0]?.save({ at: 1 })).rejects.toMatchObject({
        code: 'INTERNAL',
        detail: 'The job no longer holds its lease.',
      });
      expect(saves).toBe(0);
    });

    it('fails a job of another version instead of guessing at it', async () => {
      const h = harness();
      h.runner.register(makeJob({ version: 1 }));
      const id = await h.submit();
      const next = harness({ store: h.store });
      next.runner.register(makeJob({ version: 2 }));

      await next.runner.start();
      await next.flush();

      expect(await h.row(id)).toMatchObject({
        state: 'failed',
        stateReason: 'version-mismatch',
      });
    });

    it('fails a job claimed more often than maxAttempts instead of running it again', async () => {
      const h = harness({ maxAttempts: 1 });
      let runs = 0;
      h.runner.register(
        makeJob({
          run: async function* (ctx) {
            runs += 1;
            yield { kind: 'progress', done: 0 };
            await untilAborted(ctx.signal);
            return { ok: true };
          },
        }),
      );
      await h.runner.start();
      const id = await h.submit();
      await h.flush();
      await h.runner.command(id, 'pause', person);

      await h.runner.command(id, 'resume', person);
      await h.flush();

      expect(runs).toBe(1);
      expect(await h.row(id)).toMatchObject({
        state: 'failed',
        stateReason: 'attempts-exhausted',
        attempts: 2,
      });
    });

    it('runs at most maxConcurrent jobs at once and starts the next when one ends', async () => {
      const h = harness({ maxConcurrent: 2 });
      const gates: (() => void)[] = [];
      let active = 0;
      let peak = 0;
      h.runner.register(
        makeJob({
          run: async function* () {
            active += 1;
            peak = Math.max(peak, active);
            yield { kind: 'progress', done: 0 };
            await new Promise<void>((resolve) => gates.push(resolve));
            active -= 1;
            return { ok: true };
          },
        }),
      );
      await h.runner.start();
      await h.submit();
      await h.submit();
      const third = await h.submit();
      await h.flush();

      expect(h.runner.stats().running).toBe(2);
      expect((await h.row(third)).state).toBe('queued');

      gates.shift()?.();
      await h.flush();

      expect(peak).toBe(2);
      expect(h.runner.stats().running).toBe(2);
      expect((await h.row(third)).state).toBe('running');
    });

    it('keeps jobs that share a concurrency key one at a time', async () => {
      const h = harness();
      const gates: (() => void)[] = [];
      h.runner.register(
        makeJob({
          concurrencyKey: () => 'queue:orders',
          run: async function* () {
            yield { kind: 'progress', done: 0 };
            await new Promise<void>((resolve) => gates.push(resolve));
            return { ok: true };
          },
        }),
      );
      await h.runner.start();
      const first = await h.submit();
      const second = await h.submit();
      await h.flush();

      expect(h.runner.stats().running).toBe(1);
      expect((await h.row(second)).state).toBe('queued');
      gates.shift()?.();
      await h.flush();

      expect((await h.row(first)).state).toBe('succeeded');
      expect((await h.row(second)).state).toBe('running');
    });

    it('does not run a type nobody registered, even when the store hands one out', async () => {
      const h = harness();
      h.runner.register(makeJob());
      const id = await h.submit();
      const wanted = h.store.claim.bind(h.store);
      const sneaky = harness({
        store: Object.assign(h.store, {
          claim: (
            owner: string,
            lease: number,
            _types: readonly string[],
            now: number,
          ) => wanted(owner, lease, ['test.job'], now),
        }),
      });
      sneaky.runner.register(makeJob({ type: 'test.other' }));

      await sneaky.runner.start();
      await sneaky.flush();

      expect(await h.row(id)).toMatchObject({
        state: 'failed',
        stateReason: 'unknown-job-type',
      });
    });

    it('delivers events to the observer, and an observer that throws changes nothing', async () => {
      const seen: JobEvent[] = [];
      const h = harness({
        onEvent: (_id, event) => {
          seen.push(event);
          throw new Error('observer broke');
        },
        onState: () => {
          throw new Error('observer broke');
        },
      });
      h.runner.register(
        makeJob({
          run: async function* () {
            await Promise.resolve();
            yield { kind: 'progress', done: 1 };
            yield {
              kind: 'warning',
              warning: {
                id: 'W-X',
                severity: 'warn',
                textKey: 'k',
                textVersion: 1,
              } as never,
            };
            return { ok: true };
          },
        }),
      );
      await h.runner.start();

      const id = await h.submit();
      await h.flush();

      expect(seen.map((event) => event.kind)).toEqual(['progress', 'warning']);
      expect((await h.row(id)).state).toBe('succeeded');
    });

    it('throttles a job with its token bucket and stops waiting when the job is stopped', async () => {
      const h = harness();
      const takes: number[] = [];
      let blocked = 'waiting';
      h.runner.register(
        makeJob({
          throttle: () => ({ perSec: 1, burst: 1 }),
          run: async function* (ctx) {
            await ctx.throttle.take();
            takes.push(h.clock.monotonic());
            await ctx.throttle.take();
            takes.push(h.clock.monotonic());
            yield { kind: 'progress', done: 2 };
            await ctx.throttle
              .take(1, new AbortController().signal)
              .catch(() => {
                blocked = 'rejected';
              });
            return { ok: true };
          },
        }),
      );
      await h.runner.start();
      const t0 = h.clock.monotonic();
      const id = await h.submit();
      await h.flush();
      expect(takes).toEqual([t0]);

      await h.timers.advance(1000);
      expect(takes).toEqual([t0, t0 + 1000]);

      // The third take is waiting: stopping the job rejects it.
      await h.flush();
      await h.runner.command(id, 'cancel', person);
      await h.timers.advance(1000);
      expect(blocked).toBe('rejected');
      expect(await h.row(id)).toMatchObject({ state: 'cancelled' });
    });

    it('lets an unthrottled job take without waiting, and refuses once it is stopped', async () => {
      const h = harness();
      const outcome: string[] = [];
      h.runner.register(
        makeJob({
          run: async function* (ctx) {
            await ctx.throttle.take(100);
            outcome.push('took');
            yield { kind: 'progress', done: 1 };
            await untilAborted(ctx.signal).catch(() => undefined);
            await ctx.throttle.take().catch(() => outcome.push('refused'));
            return { ok: true };
          },
        }),
      );
      await h.runner.start();
      const id = await h.submit();
      await h.flush();

      await h.runner.command(id, 'cancel', person);

      expect(outcome).toEqual(['took', 'refused']);
    });
  });

  describe('integrity of the stored job', () => {
    it('fails a job whose requester column was edited, without running it', async () => {
      const h = harness();
      let ran = false;
      h.runner.register(
        makeJob({
          run: async function* () {
            ran = true;
            await Promise.resolve();
            yield { kind: 'checkpoint' };
            return { ok: true };
          },
        }),
      );
      const id = await h.submit();
      const stored = h.store.rows.get(id);
      if (stored !== undefined) stored.principalId = 'attacker';

      await h.runner.start();
      await h.flush();

      expect(ran).toBe(false);
      expect(await h.row(id)).toMatchObject({
        state: 'failed',
        stateReason: 'job-unreadable',
      });
    });

    it('fails a job whose plan hash or input was swapped for another job’s', async () => {
      const h = harness();
      let runs = 0;
      h.runner.register(
        makeJob({
          run: async function* () {
            runs += 1;
            await Promise.resolve();
            yield { kind: 'checkpoint' };
            return { ok: true };
          },
        }),
      );
      const a = await h.submit('test.job', { n: 1 });
      const b = await h.submit('test.job', { n: 2 });
      const rowA = h.store.rows.get(a);
      const rowB = h.store.rows.get(b);
      if (rowA !== undefined && rowB !== undefined) rowA.input = rowB.input;

      await h.runner.start();
      await h.flush();

      expect(await h.row(a)).toMatchObject({
        state: 'failed',
        stateReason: 'job-unreadable',
      });
      expect(await h.row(b)).toMatchObject({ state: 'succeeded' });
      expect(runs).toBe(1);
    });

    it('fails a job whose sealed checkpoint was edited', async () => {
      const h = harness();
      let runs = 0;
      h.runner.register(
        makeJob({
          run: async function* (ctx) {
            runs += 1;
            await ctx.save({ at: 1 });
            yield { kind: 'progress', done: 0 };
            await untilAborted(ctx.signal);
            return { ok: true };
          },
        }),
      );
      await h.runner.start();
      const id = await h.submit();
      await h.flush();
      await h.runner.command(id, 'pause', person);
      const stored = h.store.rows.get(id);
      if (stored?.checkpoint != null)
        stored.checkpoint = stored.checkpoint.map((byte) => byte ^ 1);

      await h.runner.command(id, 'resume', person).catch(() => undefined);
      await h.flush();

      expect(runs).toBe(1);
      expect((await h.row(id)).state).toBe('paused');
    });
  });

  describe('stopping', () => {
    it('lets a stop win over a normal return: a job cut short is not recorded as succeeded', async () => {
      const h = harness();
      h.runner.register(
        makeJob({
          run: async function* (ctx) {
            yield { kind: 'progress', done: 0 };
            await untilAborted(ctx.signal).catch(() => undefined);
            return { ok: true };
          },
        }),
      );
      await h.runner.start();
      const id = await h.submit();
      await h.flush();
      let finishes = 0;
      const finish = h.store.finish.bind(h.store);
      h.store.finish = (...args) => {
        finishes += 1;
        return finish(...args);
      };

      await h.runner.drain('shutdown', 2000);

      expect(await h.row(id)).toMatchObject({
        state: 'paused-interrupted',
        stateReason: 'shutdown',
      });
      // Both the body's end and the stop try to release the job; only one does.
      expect(finishes).toBe(1);
      expect(h.states.filter((s) => s.id === id).map((s) => s.state)).toEqual([
        'queued',
        'running',
        'paused-interrupted',
      ]);
    });

    it.each([
      ['shutdown', 'shutdown'],
      ['suspend', 'suspend'],
      ['emergency', 'emergency'],
    ] as const)(
      'drain(%s) calls onDrain with that reason and records it as the state reason',
      async (reason, why) => {
        const h = harness();
        const calls: [string, number][] = [];
        h.runner.register(
          makeJob({
            onDrain: (_ctx, called, deadlineMs) => {
              calls.push([called, deadlineMs]);
              return Promise.resolve();
            },
          }),
        );
        await h.runner.start();
        const id = await h.submit();
        await h.flush();

        const entries = await h.runner.drain(reason, 1000);

        expect(calls).toEqual([[reason, 900]]);
        expect(entries).toEqual([
          expect.objectContaining({
            jobId: id,
            state: 'paused-interrupted',
            onDrain: 'ok',
          }),
        ]);
        expect((await h.row(id)).stateReason).toBe(why);
      },
    );

    it('keeps the settle reserve out of the time onDrain is given, and reports an onDrain that failed', async () => {
      const h = harness({ settleReserveMs: 250 });
      const given: number[] = [];
      h.runner.register(
        makeJob({
          onDrain: (_ctx, _reason, deadlineMs) => {
            given.push(deadlineMs);
            return Promise.reject(new Error('could not park'));
          },
        }),
      );
      await h.runner.start();
      const id = await h.submit();
      await h.flush();

      const entries = await h.runner.drain('shutdown', 1000);

      expect(given).toEqual([750]);
      expect(entries[0]).toMatchObject({
        onDrain: 'error',
        state: 'paused-interrupted',
      });
      expect((await h.row(id)).stateReason).toBe('shutdown:on-drain-error');
    });

    it('gives a job that ignores its signal only the budget, then moves on and frees its slot', async () => {
      const h = harness();
      h.runner.register(
        makeJob({
          run: async function* () {
            yield { kind: 'progress', done: 0 };
            await new Promise<never>(() => undefined);
            return { ok: true };
          },
        }),
      );
      await h.runner.start();
      const id = await h.submit();
      await h.flush();

      const pending = h.runner.drain('shutdown', 500);
      await h.flush();
      await h.timers.advance(500);
      const entries = await pending;

      expect(entries[0]?.ms).toBeLessThanOrEqual(500);
      expect(await h.row(id)).toMatchObject({ state: 'paused-interrupted' });
      expect(h.runner.stats().running).toBe(0);
    });

    it('releases a job once even when the stop arrives while its result is being sealed', async () => {
      const real = createAesGcmTestCipher();
      let openGate: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      const cipher: PayloadCipher = {
        decrypt: (ciphertext, aad) => real.decrypt(ciphertext, aad),
        encrypt: async (plaintext, aad) => {
          if (aad.startsWith('jobs:result:')) await gate;
          return real.encrypt(plaintext, aad);
        },
      };
      const h = harness({ cipher });
      h.runner.register(makeJob({ run: quick }));
      await h.runner.start();
      const id = await h.submit();
      await h.flush(); // the job has returned and waits for its result to be sealed
      let finishes = 0;
      const finish = h.store.finish.bind(h.store);
      h.store.finish = (...args) => {
        finishes += 1;
        return finish(...args);
      };

      const draining = h.runner.drain('shutdown', 1000);
      await h.flush();
      await h.timers.advance(1000);
      const entries = await draining;
      openGate(); // the seal finishes after the job was released
      await h.flush();

      expect(entries[0]).toMatchObject({ state: 'paused-interrupted' });
      expect(await h.row(id)).toMatchObject({
        state: 'paused-interrupted',
        stateReason: 'shutdown',
        result: null,
      });
      expect(finishes).toBe(1);
    });

    it('stops a job that was claimed just as the drain began, instead of letting it run on', async () => {
      const h = harness();
      h.runner.register(makeJob());
      const claim = h.store.claim.bind(h.store);
      let release: () => void = () => undefined;
      h.store.claim = async (...args) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return claim(...args);
      };
      await h.runner.start();
      const id = await h.submit();
      await h.flush();

      const draining = h.runner.drain('shutdown', 1000);
      release(); // the claim in flight completes after the drain has begun
      const entries = await draining;

      expect(entries.map((entry) => entry.jobId)).toEqual([id]);
      expect(await h.row(id)).toMatchObject({
        state: 'paused-interrupted',
        stateReason: 'shutdown',
      });
      expect(h.runner.stats().running).toBe(0);
    });

    it('drains nothing when nothing runs, and stops claiming at once', async () => {
      const h = harness();
      h.runner.register(makeJob());
      await h.runner.start();

      expect(await h.runner.drain('suspend', 1000)).toEqual([]);
      const id = await h.submit().catch(() => undefined);
      await h.timers.advance(5000);

      expect(id).toBeUndefined();
      expect(h.runner.stats()).toEqual({
        running: 0,
        accepting: false,
        draining: true,
      });
    });

    it('rejects a negative budget', async () => {
      const h = harness();

      await expect(h.runner.drain('shutdown', -1)).rejects.toThrow(RangeError);
      await expect(h.runner.drain('shutdown', Number.NaN)).rejects.toThrow(
        RangeError,
      );
    });

    it.each([
      ['quit', 'shutdown'],
      ['sigterm', 'shutdown'],
      ['suspend', 'suspend'],
      ['emergency', 'emergency'],
    ] as const)(
      'the sources-jobs phase maps a %s drain to onDrain(%s)',
      async (drainReason, jobReason) => {
        const h = harness();
        const calls: string[] = [];
        h.runner.register(
          makeJob({
            onDrain: (_ctx, reason) => {
              calls.push(reason);
              return Promise.resolve();
            },
          }),
        );
        await h.runner.start();
        await h.submit();
        await h.flush();
        const coordinator = createDrainCoordinator({
          phases: [h.runner.drainPhase()],
          clock: h.clock,
          timers: h.timers,
        });

        const results = await coordinator.drain(drainReason, 2000);

        expect(calls).toEqual([jobReason]);
        expect(results.find((r) => r.phase === 'sources-jobs')).toMatchObject({
          ok: true,
        });
      },
    );

    it('a job that asks to pause is parked and left paused, with onDrain called as for a suspend', async () => {
      const h = harness();
      const calls: string[] = [];
      h.runner.register(
        makeJob({
          run: async function* (ctx) {
            yield { kind: 'paused', reason: 'broker alarm' };
            await untilAborted(ctx.signal);
            return { ok: true };
          },
          onDrain: (_ctx, reason) => {
            calls.push(reason);
            return Promise.resolve();
          },
        }),
      );
      await h.runner.start();

      const id = await h.submit();
      await h.flush();

      expect(calls).toEqual(['suspend']);
      expect(await h.row(id)).toMatchObject({
        state: 'paused',
        stateReason: 'paused-by-job',
      });
    });
  });

  describe('commands', () => {
    const stranger = createTestPrincipal({ id: 'user-2' });

    it('pauses a running job, then resumes it from its checkpoint', async () => {
      const h = harness();
      const seen: (Cp | undefined)[] = [];
      const calls: string[] = [];
      h.runner.register(
        makeJob({
          run: async function* (ctx) {
            seen.push(ctx.checkpoint);
            if (ctx.checkpoint !== undefined) return { ok: true };
            yield { kind: 'progress', done: 0 };
            await untilAborted(ctx.signal);
            return { ok: true };
          },
          onDrain: async (ctx, reason) => {
            calls.push(reason);
            await ctx.save({ at: 9 });
          },
        }),
      );
      await h.runner.start();
      const id = await h.submit();
      await h.flush();

      await h.runner.command(id, 'pause', person);
      expect(await h.row(id)).toMatchObject({
        state: 'paused',
        stateReason: 'paused-by-user',
      });
      await h.runner.command(id, 'resume', person);
      await h.flush();

      expect(calls).toEqual(['suspend']);
      expect(seen).toEqual([undefined, { at: 9 }]);
      expect(await h.row(id)).toMatchObject({
        state: 'succeeded',
        attempts: 2,
      });
    });

    it('cancels a running job after its onDrain, and a queued, paused or interrupted one at once', async () => {
      const h = harness({ maxConcurrent: 1 });
      const calls: string[] = [];
      h.runner.register(
        makeJob({
          onDrain: (_ctx, reason) => {
            calls.push(reason);
            return Promise.resolve();
          },
        }),
      );
      await h.runner.start();
      const running = await h.submit();
      const queued = await h.submit();
      await h.flush();

      await h.runner.command(queued, 'cancel', person);
      await h.runner.command(running, 'cancel', person);
      await h.flush();

      expect(calls).toEqual(['cancel']);
      expect(await h.row(running)).toMatchObject({
        state: 'cancelled',
        stateReason: 'cancelled',
      });
      expect((await h.row(queued)).state).toBe('cancelled');
    });

    it('cancels a paused job, and pauses a queued one', async () => {
      const h = harness();
      h.runner.register(makeJob());
      const a = await h.submit();
      const b = await h.submit();

      await h.runner.command(a, 'pause', person);
      expect((await h.row(a)).state).toBe('paused');
      await h.runner.command(a, 'cancel', person);
      await h.runner.command(b, 'pause', person);

      expect((await h.row(a)).state).toBe('cancelled');
      expect((await h.row(b)).state).toBe('paused');
    });

    it('refuses a command a job’s state does not allow, with a 409', async () => {
      const h = harness();
      h.runner.register(makeJob({ run: quick }));
      // The runner has not started, so these two stay where they are.
      const queued = await h.submit();
      const paused = await h.submit();
      await h.runner.command(paused, 'pause', person);

      await expect(
        h.runner.command(queued, 'resume', person),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        h.runner.command(paused, 'pause', person),
      ).rejects.toMatchObject({ status: 409 });
      await h.runner.start();
      const done = await h.submit();
      await h.flush();

      for (const command of ['pause', 'cancel', 'resume'] as const) {
        await expect(
          h.runner.command(done, command, person),
        ).rejects.toMatchObject({ status: 409 });
      }
      expect((await h.row(paused)).state).toBe('paused');
    });

    it('treats a job nobody may command as not found, so a stranger learns nothing', async () => {
      const h = harness();
      h.runner.register(makeJob());
      const id = await h.submit();

      for (const command of ['pause', 'resume', 'cancel'] as const) {
        await expect(
          h.runner.command(id, command, stranger),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      }
      await expect(
        h.runner.command('missing' as JobId, 'cancel', person),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        h.runner.command(id, 'cancel', { id: 'user-1' } as never),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      expect((await h.row(id)).state).toBe('queued');
    });

    it('lets the requester, the person the requester acted for and an override command a job', async () => {
      const h = harness({
        mayOverride: (principal) => principal.roles.includes('admin'),
      });
      h.runner.register(makeJob());
      const mcp = createTestPrincipal({
        id: 'mcp-1',
        kind: 'mcp-client',
        surface: 'mcp',
        onBehalfOf: person,
      });
      const a = await h.submit('test.job', { n: 1 }, mcp);
      const b = await h.submit();
      const c = await h.submit();

      await h.runner.command(a, 'pause', person); // acted for
      await h.runner.command(b, 'pause', person); // requester
      await h.runner.command(
        c,
        'pause',
        createTestPrincipal({ id: 'root', roles: ['admin'] }),
      );
      await expect(
        h.runner.command(
          c,
          'cancel',
          createTestPrincipal({ id: 'other', roles: ['ops'] }),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      expect((await h.row(a)).state).toBe('paused');
      expect((await h.row(b)).state).toBe('paused');
      expect((await h.row(c)).state).toBe('paused');
    });

    it('does not let a job’s own principal for another requester command it', async () => {
      const h = harness();
      h.runner.register(makeJob());
      const id = await h.submit();
      const impostor = createTestPrincipal({
        id: 'job:other',
        kind: 'job',
        surface: 'job',
        unattended: true,
        onBehalfOf: stranger,
      });

      await expect(
        h.runner.command(id, 'cancel', impostor),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('blocks a resume that preflight refuses, or that throws, and leaves the job as it was', async () => {
      const h = harness();
      let verdict: JobPreflight | Error = {
        ok: false,
        reason: 'the broker is down',
      };
      h.runner.register(
        makeJob({
          preflight: () =>
            verdict instanceof Error
              ? Promise.reject(verdict)
              : Promise.resolve(verdict),
        }),
      );
      const id = await h.submit();
      await h.runner.command(id, 'pause', person);

      await expect(
        h.runner.command(id, 'resume', person),
      ).rejects.toMatchObject({
        code: 'GATE_BLOCKED',
        detail: expect.stringContaining('the broker is down') as string,
      });
      verdict = new Error('boom');
      await expect(
        h.runner.command(id, 'resume', person),
      ).rejects.toMatchObject({ code: 'GATE_BLOCKED' });
      expect((await h.row(id)).state).toBe('paused');
      verdict = { ok: true };
      await h.runner.command(id, 'resume', person);

      expect((await h.row(id)).state).toBe('queued');
    });

    it('blocks a resume whose preflight never answers or answers with anything but ok: true', async () => {
      const h = harness({ commandBudgetMs: 2000 });
      let answer: () => Promise<unknown> = () => new Promise(() => undefined);
      h.runner.register(
        makeJob({ preflight: () => answer() as Promise<JobPreflight> }),
      );
      const id = await h.submit();
      await h.runner.command(id, 'pause', person);

      const hung = h.runner
        .command(id, 'resume', person)
        .catch((e: unknown) => e);
      await h.flush();
      await h.timers.advance(2000);
      expect(await hung).toMatchObject({
        code: 'GATE_BLOCKED',
        detail: expect.stringContaining('preflight-timeout') as string,
      });
      for (const odd of [undefined, null, {}, { ok: 'yes' }, { ok: 1 }, 'ok']) {
        answer = () => Promise.resolve(odd);
        await expect(
          h.runner.command(id, 'resume', person),
        ).rejects.toMatchObject({
          code: 'GATE_BLOCKED',
        });
      }
      expect((await h.row(id)).state).toBe('paused');
    });

    it('resumes a job that awaits credentials, and refuses one whose type is not available', async () => {
      const h = harness();
      h.runner.register(makeJob());
      const id = await h.submit();
      const row = h.store.rows.get(id);
      if (row !== undefined) row.state = 'awaiting-credentials';
      await h.runner.command(id, 'resume', person);
      expect((await h.row(id)).state).toBe('queued');

      const lone = harness({ store: h.store });
      const parked = h.store.rows.get(id);
      if (parked !== undefined) parked.state = 'paused';

      await expect(
        lone.runner.command(id, 'resume', person),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('refuses to move a job that is running on another engine', async () => {
      const h = harness();
      h.runner.register(makeJob());
      const id = await h.submit();
      await h.store.claim(
        'another-engine',
        30_000,
        ['test.job'],
        h.clock.now(),
      );

      await expect(
        h.runner.command(id, 'cancel', person),
      ).rejects.toMatchObject({ status: 409 });
      await expect(h.runner.command(id, 'pause', person)).rejects.toMatchObject(
        { status: 409 },
      );
      expect((await h.row(id)).state).toBe('running');
    });
  });

  describe('leases', () => {
    it('renews the lease every 10 s while a job runs', async () => {
      const h = harness();
      h.runner.register(makeJob());
      await h.runner.start();
      const id = await h.submit();
      await h.flush();
      const t0 = h.clock.now();
      expect((await h.row(id)).leaseUntil).toBe(t0 + 30_000);

      await h.timers.advance(10_000);
      expect((await h.row(id)).leaseUntil).toBe(t0 + 10_000 + 30_000);
      await h.timers.advance(10_000);
      expect((await h.row(id)).leaseUntil).toBe(t0 + 20_000 + 30_000);
      expect((await h.row(id)).state).toBe('running');
    });

    it('aborts the job at once when the store says the lease is gone, and writes nothing more', async () => {
      const h = harness();
      const seen: { ctx?: Ctx } = {};
      h.runner.register(
        makeJob({
          run: async function* (ctx) {
            seen.ctx = ctx;
            yield { kind: 'progress', done: 0 };
            await untilAborted(ctx.signal);
            return { ok: true };
          },
        }),
      );
      await h.runner.start();
      const id = await h.submit();
      await h.flush();
      // Another engine reaped it: the row is no longer this attempt's.
      await h.store.interruptRunning('all', h.clock.now(), 10);

      await h.timers.advance(10_000);

      expect(seen.ctx?.signal.aborted).toBe(true);
      await expect(seen.ctx?.save({ at: 1 })).rejects.toMatchObject({
        code: 'INTERNAL',
      });
      expect(await h.row(id)).toMatchObject({
        state: 'paused-interrupted',
        stateReason: 'engine-restart',
      });
      expect(h.runner.stats().running).toBe(0);
    });

    it('keeps retrying a heartbeat the store cannot answer, and gives the job up when the lease would have ended', async () => {
      const h = harness();
      const seen: { ctx?: Ctx } = {};
      h.runner.register(
        makeJob({
          run: async function* (ctx) {
            seen.ctx = ctx;
            yield { kind: 'progress', done: 0 };
            await untilAborted(ctx.signal);
            return { ok: true };
          },
        }),
      );
      await h.runner.start();
      const id = await h.submit();
      await h.flush();
      h.store.failNext('heartbeat', 100);

      await h.timers.advance(20_000);
      expect(seen.ctx?.signal.aborted).toBe(false);
      await h.timers.advance(9_999);
      expect(seen.ctx?.signal.aborted).toBe(false);
      await h.timers.advance(1);

      expect(seen.ctx?.signal.aborted).toBe(true);
      expect(h.runner.stats().running).toBe(0);
      // Nothing was written by the runner that lost the job; the store reaps it on its own clock.
      expect((await h.row(id)).state).toBe('running');
      h.clock.advance(1);
      await h.store.interruptRunning('expired', h.clock.now(), 10);
      expect(await h.row(id)).toMatchObject({
        state: 'paused-interrupted',
        stateReason: 'lease-expired',
      });
    });

    it('counts the 30 s from the last heartbeat the store answered, not from the claim', async () => {
      const h = harness();
      const seen: { ctx?: Ctx } = {};
      h.runner.register(
        makeJob({
          run: async function* (ctx) {
            seen.ctx = ctx;
            yield { kind: 'progress', done: 0 };
            await untilAborted(ctx.signal);
            return { ok: true };
          },
        }),
      );
      await h.runner.start();
      await h.submit();
      await h.flush();
      await h.timers.advance(20_000); // the heartbeats at 10 s and 20 s are answered
      h.store.failNext('heartbeat', 100);

      await h.timers.advance(29_999);
      expect(seen.ctx?.signal.aborted).toBe(false);
      await h.timers.advance(1);

      expect(seen.ctx?.signal.aborted).toBe(true);
    });

    it('survives one failed heartbeat when the next is answered', async () => {
      const h = harness();
      h.runner.register(makeJob());
      await h.runner.start();
      const id = await h.submit();
      await h.flush();
      h.store.failNext('heartbeat', 1);

      await h.timers.advance(10_000);
      await h.timers.advance(10_000);

      expect((await h.row(id)).state).toBe('running');
      expect((await h.row(id)).leaseUntil).toBe(h.clock.now() + 30_000);
    });

    it('never runs a job twice when two runners share a store', async () => {
      const store = createMemoryJobStore();
      const cipher = createAesGcmTestCipher(); // both runners hold the same key
      const a = harness({ store, cipher, owner: 'runner-a', maxConcurrent: 2 });
      const b = harness({ store, cipher, owner: 'runner-b', maxConcurrent: 2 });
      const runs: string[] = [];
      for (const [name, h] of [
        ['a', a],
        ['b', b],
      ] as const) {
        h.runner.register(
          makeJob({
            run: async function* (ctx) {
              runs.push(`${name}:${ctx.jobId}`);
              await Promise.resolve();
              yield { kind: 'checkpoint' };
              return { ok: true };
            },
          }),
        );
      }
      const ids: JobId[] = [];
      for (let i = 0; i < 8; i += 1)
        ids.push(await a.submit('test.job', { n: i }));

      await Promise.all([a.runner.start(), b.runner.start()]);
      await a.flush();
      await b.flush();

      const ranIds = runs.map((run) => run.split(':')[1]);
      expect(ranIds.sort()).toEqual([...ids].sort());
      for (const id of ids)
        expect((await store.get(id))?.state).toBe('succeeded');
    });
  });

  describe('recovery and resume', () => {
    async function crashedJob(
      h: ReturnType<typeof harness>,
      type = 'test.job',
    ) {
      const id = await h.submit(type);
      await h.store.claim('crashed-engine', 30_000, [type], h.clock.now());
      return id;
    }

    it('interrupts every running job at start when it is the only engine on its database', async () => {
      const h = harness({ recovery: 'interrupt-all-running' });
      h.runner.register(makeJob());
      const id = await crashedJob(h);

      const report = await h.runner.start();

      expect(report).toEqual({ interrupted: 1, resumed: 0, blocked: 0 });
      expect(await h.row(id)).toMatchObject({
        state: 'paused-interrupted',
        stateReason: 'engine-restart',
      });
      // A person decides: nothing runs by itself.
      await h.flush();
      expect((await h.row(id)).state).toBe('paused-interrupted');
    });

    it('leaves a running job whose lease is still valid to the engine that holds it', async () => {
      const h = harness({ recovery: 'interrupt-expired' });
      h.runner.register(makeJob());
      const id = await crashedJob(h);

      expect((await h.runner.start()).interrupted).toBe(0);
      expect((await h.row(id)).state).toBe('running');
      h.clock.advance(30_001);

      expect((await h.runner.recover()).interrupted).toBe(1);
      expect(await h.row(id)).toMatchObject({
        state: 'paused-interrupted',
        stateReason: 'lease-expired',
      });
    });

    it('does not interrupt its own running jobs when recovery runs again', async () => {
      const h = harness({ recovery: 'interrupt-all-running' });
      h.runner.register(makeJob());
      await h.runner.start();
      const id = await h.submit();
      await h.flush();

      expect((await h.runner.recover()).interrupted).toBe(0);

      expect((await h.row(id)).state).toBe('running');
    });

    it('queues interrupted jobs again only when they are resumable and preflight allows it', async () => {
      const h = harness({
        recovery: 'interrupt-all-running',
        autoResume: 'resumable',
      });
      h.runner.register(
        makeJob({ type: 'test.resumable', resumable: true, run: quick }),
      );
      h.runner.register(
        makeJob({ type: 'test.manual', resumable: false, run: quick }),
      );
      h.runner.register(
        makeJob({
          type: 'test.blocked',
          resumable: true,
          run: quick,
          preflight: () => Promise.resolve({ ok: false, reason: 'no' }),
        }),
      );
      const resumable = await crashedJob(h, 'test.resumable');
      const manual = await crashedJob(h, 'test.manual');
      const blocked = await crashedJob(h, 'test.blocked');

      const report = await h.runner.start();
      await h.flush();

      expect(report).toEqual({ interrupted: 3, resumed: 1, blocked: 1 });
      expect((await h.row(resumable)).state).toBe('succeeded');
      expect((await h.row(manual)).state).toBe('paused-interrupted');
      expect((await h.row(blocked)).state).toBe('paused-interrupted');
    });

    it('trusts the definition, not the row, on whether a job may resume by itself', async () => {
      const h = harness({
        recovery: 'interrupt-all-running',
        autoResume: 'resumable',
      });
      h.runner.register(
        makeJob({ type: 'test.manual', resumable: false, run: quick }),
      );
      const id = await crashedJob(h, 'test.manual');
      const row = h.store.rows.get(id);
      if (row !== undefined) row.resumable = true; // edited in the database

      const report = await h.runner.start();
      await h.flush();

      expect(report).toEqual({ interrupted: 1, resumed: 0, blocked: 0 });
      expect((await h.row(id)).state).toBe('paused-interrupted');
    });

    it('does not resume by itself a job stored under another version of its definition', async () => {
      const first = harness({ recovery: 'interrupt-all-running' });
      first.runner.register(
        makeJob({
          type: 'test.versioned',
          version: 1,
          resumable: true,
          run: quick,
        }),
      );
      const id = await crashedJob(first, 'test.versioned');
      const next = harness({
        store: first.store,
        recovery: 'interrupt-all-running',
        autoResume: 'resumable',
      });
      next.runner.register(
        makeJob({
          type: 'test.versioned',
          version: 2,
          resumable: true,
          run: quick,
        }),
      );

      const report = await next.runner.start();

      expect(report).toEqual({ interrupted: 1, resumed: 0, blocked: 0 });
      expect((await first.row(id)).state).toBe('paused-interrupted');
    });

    it('never resumes by itself unless told to', async () => {
      const h = harness({ recovery: 'interrupt-all-running' });
      h.runner.register(makeJob({ resumable: true, run: quick }));
      const id = await crashedJob(h);

      await h.runner.start();
      await h.flush();

      expect((await h.row(id)).state).toBe('paused-interrupted');
    });

    it('starts once: a second start does nothing', async () => {
      const h = harness();
      h.runner.register(makeJob());

      await h.runner.start();

      expect(await h.runner.start()).toEqual({
        interrupted: 0,
        resumed: 0,
        blocked: 0,
      });
    });

    it('picks up a job queued while the runner was idle by polling', async () => {
      const h = harness({ pollMs: 1000 });
      h.runner.register(makeJob({ run: quick }));
      await h.runner.start();
      const id = await h.submit();
      await h.flush();
      await h.runner.drain('suspend', 100);
      await h.runner.reopen();
      // A job written by someone else while the runner was not looking.
      await h.store.create(
        {
          id: 'x' as JobId,
          type: 'test.job',
          version: 1,
          principalId: 'user-1',
          onBehalfOfId: null,
          planHash: PLAN,
          idempotencyKey: 'written-elsewhere',
          concurrencyKey: null,
          resumable: false,
          input: new Uint8Array([1]),
        },
        h.clock.now(),
      );

      await h.timers.advance(1000);

      expect((await h.row(id)).state).toBe('succeeded');
      expect((await h.row('x' as JobId)).state).toBe('failed');
    });
  });
});
