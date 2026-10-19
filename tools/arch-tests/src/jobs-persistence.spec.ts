// The JobRunner (jobs) running over the SQL JobStore (persistence): the two halves of M0-31 agree on
// what a row holds, a job survives the drain as the database sees it, and a row edited behind the
// runner's back is refused. The runner cannot import an adapter and an adapter cannot import the
// runner, so the test that joins them lives in a type:test project.
import {
  AppError,
  createAesGcmTestCipher,
  createDrainCoordinator,
  createIdGenerator,
  createManualClock,
  createManualTimers,
  createRecordingWrites,
  createTestPrincipal,
} from '@app/kernel';
import {
  createJobRunner,
  defineJob,
  type JobDef,
  type JobRunner,
} from '@app/jobs';
import {
  createMigrationRunner,
  createRepositories,
  openSqlite,
  type PersistenceHandle,
  type Repositories,
} from '@app/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

const schema = z.strictObject({ n: z.number() });
const PLAN = 'c'.repeat(64);

describe('job runner over the SQL job store', () => {
  let handle: PersistenceHandle;
  let repos: Repositories;
  let runner: JobRunner;
  const clock = createManualClock(1_700_000_000_000);
  const timers = createManualTimers(clock);
  const person = createTestPrincipal({ id: 'user-1' });
  const seen: { parked: string[]; ran: string[] } = { parked: [], ran: [] };
  let counter = 0;
  const submit = (type = 'test.sql', who = person) => {
    counter += 1;
    return runner.submit(type, { n: counter }, who, {
      idempotencyKey: `sql-job-key-${String(counter)}`,
      planHash: PLAN,
    });
  };
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i += 1) await timers.settle();
  };
  const waiting = (type: string): JobDef =>
    defineJob({
      type,
      version: 1,
      input: schema,
      checkpoint: schema,
      output: schema,
      resumable: true,
      concurrencyKey: () => 'queue:orders',
      async *run(ctx) {
        seen.ran.push(ctx.jobId);
        yield { kind: 'progress', done: 0 };
        await new Promise<never>((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => {
            reject(new AppError('ENGINE_SHUTTING_DOWN'));
          });
        });
        return { n: 0 };
      },
      onDrain: async (ctx) => {
        await ctx.save({ n: 41 });
        seen.parked.push(ctx.jobId);
      },
    });

  beforeEach(async () => {
    seen.parked = [];
    seen.ran = [];
    handle = await openSqlite({ path: ':memory:' });
    await createMigrationRunner({ handle }).migrate();
    repos = createRepositories(handle, { now: () => clock.now() });
    runner = createJobRunner({
      store: repos.jobs,
      cipher: createAesGcmTestCipher(),
      clock,
      timers,
      ids: createIdGenerator({ clock }),
      writes: createRecordingWrites().writes,
      owner: 'runner-sql',
    });
    runner.register(waiting('test.sql'));
    await runner.start();
  });

  afterEach(async () => {
    await handle.close();
  });

  it('keeps a running job, drains it to paused-interrupted with its checkpoint, and resumes it', async () => {
    const id = await submit();
    await flush();
    expect(await repos.jobs.get(id)).toMatchObject({
      state: 'running',
      attempts: 1,
    });

    const coordinator = createDrainCoordinator({
      phases: [runner.drainPhase()],
      clock,
      timers,
    });
    const results = await coordinator.drain('sigterm', 2000);

    expect(results.find((r) => r.phase === 'sources-jobs')).toMatchObject({
      ok: true,
    });
    expect(seen.parked).toEqual([id]);
    const stored = await repos.jobs.get(id);
    expect(stored).toMatchObject({
      state: 'paused-interrupted',
      stateReason: 'shutdown',
      leaseOwner: null,
      leaseUntil: null,
    });
    expect(stored?.checkpoint).not.toBeNull();
    expect((await repos.jobs.events(id, 0, 10)).map((e) => e.toState)).toEqual([
      'queued',
      'running',
      'paused-interrupted',
    ]);

    await runner.reopen();
    await runner.command(id, 'resume', person);
    await flush();

    expect(seen.ran).toEqual([id, id]);
    expect(await repos.jobs.get(id)).toMatchObject({
      state: 'running',
      attempts: 2,
    });
  });

  it('never keeps two jobs with one concurrency key running, and stores no input in the open', async () => {
    const first = await submit();
    const second = await submit();
    await flush();

    expect((await repos.jobs.get(first))?.state).toBe('running');
    expect((await repos.jobs.get(second))?.state).toBe('queued');
    const row = await handle.db
      .selectFrom('jobs')
      .selectAll()
      .where('id', '=', first)
      .executeTakeFirstOrThrow();
    expect(Buffer.from(row.input).includes(Buffer.from('user-1'))).toBe(false);
    expect(Buffer.from(row.input).includes(Buffer.from('"n"'))).toBe(false);
  });

  it('fails a job whose requester or plan hash was edited in SQL, without running it', async () => {
    // One job runs and holds the concurrency key, so the two that follow stay queued to be edited.
    const holder = await submit();
    await flush();
    const forged = await submit();
    const swapped = await submit();
    await handle.db
      .updateTable('jobs')
      .set({ principal_id: 'attacker' })
      .where('id', '=', forged)
      .execute();
    await handle.db
      .updateTable('jobs')
      .set({ plan_hash: 'd'.repeat(64) })
      .where('id', '=', swapped)
      .execute();
    await runner.command(holder, 'cancel', person);
    await flush();

    expect(seen.ran).toEqual([holder]);
    expect(await repos.jobs.get(forged)).toMatchObject({
      state: 'failed',
      stateReason: 'job-unreadable',
    });
    expect(await repos.jobs.get(swapped)).toMatchObject({
      state: 'failed',
      stateReason: 'job-unreadable',
    });
  });

  it('refuses a state the table does not allow (CHECK), and a second running job for one key (unique index)', async () => {
    const id = await submit();
    await flush();
    const other = await submit();

    await expect(
      handle.db
        .updateTable('jobs')
        .set({ state: 'zombie' })
        .where('id', '=', other)
        .execute(),
    ).rejects.toThrow();
    await expect(
      handle.db
        .updateTable('jobs')
        .set({
          state: 'running',
          lease_owner: 'x',
          lease_until: clock.now() + 1,
        })
        .where('id', '=', other)
        .execute(),
    ).rejects.toThrow();
    expect((await repos.jobs.get(id))?.state).toBe('running');
  });
});
