// The contract every JobStore must meet (M0-31): the in-memory store of `@app/jobs` and the Kysely
// store of `@app/persistence` (SQLite and Postgres) run this one suite, so the runner's tests over
// the first say something true about the second. It lives here, behind `@app/ports/testing`,
// because neither of those projects may import the other.
import type { JobId } from '@app/contracts';
import { describe, expect, it } from 'vitest';

import type { JobLease, JobRecord, JobStore, NewJob } from '../repos.ts';

export interface JobStoreContractOptions {
  /** A prefix for the test names, for example `AC-2 postgres 16`. */
  name: string;
  /** A new, empty store. Closing it is the caller's business. */
  open(): Promise<JobStore>;
}

const T0 = 1_700_000_000_000;
const LEASE_MS = 30_000;
const TYPES = ['test.job'];

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const same = (a: Uint8Array | null | undefined, b: Uint8Array): boolean =>
  a !== null && a !== undefined && Buffer.from(a).equals(Buffer.from(b));

let counter = 0;
function newJob(overrides: Partial<NewJob> = {}): NewJob {
  counter += 1;
  const n = String(counter).padStart(6, '0');
  return {
    id: `01JOBSTORE${n}000000000000`.slice(0, 26) as JobId,
    type: 'test.job',
    version: 1,
    principalId: 'user-1',
    onBehalfOfId: null,
    planHash: 'a'.repeat(64),
    idempotencyKey: `key-${n}-padding`,
    concurrencyKey: null,
    resumable: false,
    input: bytes(1, 2, 3),
    ...overrides,
  };
}

/** Claims the next job and returns it with the lease that goes with it. */
async function claimNext(
  store: JobStore,
  owner: string,
  now: number,
  leaseMs = LEASE_MS,
): Promise<{ job: JobRecord; lease: JobLease }> {
  const job = await store.claim(owner, leaseMs, TYPES, now);
  if (job === undefined) throw new Error('There was nothing to claim.');
  return { job, lease: { id: job.id, owner, attempt: job.attempts } };
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new RangeError(`No item at ${String(index)}.`);
  return item;
}

export function jobStoreContract(options: JobStoreContractOptions): void {
  const open = (): Promise<JobStore> => options.open();

  describe(`${options.name} job store`, () => {
    it('create stores a queued job, and the same principal and key returns it unchanged', async () => {
      const store = await open();
      const job = newJob({ resumable: true, concurrencyKey: 'queue:a' });

      const first = await store.create(job, T0);
      const again = await store.create(
        { ...newJob(), idempotencyKey: job.idempotencyKey },
        T0 + 5,
      );

      expect(first.created).toBe(true);
      expect(first.job).toMatchObject({
        id: job.id,
        type: 'test.job',
        version: 1,
        state: 'queued',
        stateReason: null,
        principalId: 'user-1',
        planHash: 'a'.repeat(64),
        concurrencyKey: 'queue:a',
        resumable: true,
        attempts: 0,
        leaseOwner: null,
        leaseUntil: null,
        checkpoint: null,
        result: null,
        createdAt: T0,
        updatedAt: T0,
      });
      expect(same(first.job.input, bytes(1, 2, 3))).toBe(true);
      expect(again.created).toBe(false);
      expect(again.job.id).toBe(job.id);
      expect((await store.get(job.id))?.updatedAt).toBe(T0);
    });

    it('create scopes the idempotency key to the principal', async () => {
      const store = await open();
      const mine = newJob({ idempotencyKey: 'shared-key-1' });
      const theirs = newJob({
        idempotencyKey: 'shared-key-1',
        principalId: 'user-2',
        onBehalfOfId: 'user-9',
      });

      const a = await store.create(mine, T0);
      const b = await store.create(theirs, T0);

      expect(b.created).toBe(true);
      expect(b.job.id).not.toBe(a.job.id);
      expect(b.job.onBehalfOfId).toBe('user-9');
    });

    it('claim takes the oldest queued job of a wanted type, with a lease and one more attempt', async () => {
      const store = await open();
      const other = newJob({ type: 'other.job' });
      const first = newJob();
      const second = newJob();
      await store.create(other, T0);
      await store.create(first, T0 + 1);
      await store.create(second, T0 + 2);

      const { job } = await claimNext(store, 'runner-a', T0 + 10);

      expect(job).toMatchObject({
        id: first.id,
        state: 'running',
        leaseOwner: 'runner-a',
        leaseUntil: T0 + 10 + LEASE_MS,
        attempts: 1,
        updatedAt: T0 + 10,
      });
      expect((await store.get(other.id))?.state).toBe('queued');
      expect((await claimNext(store, 'runner-b', T0 + 11)).job.id).toBe(
        second.id,
      );
    });

    it('claim returns nothing when no type is wanted, nothing is queued or the type differs', async () => {
      const store = await open();
      await store.create(newJob(), T0);

      expect(await store.claim('runner-a', LEASE_MS, [], T0)).toBeUndefined();
      expect(
        await store.claim('runner-a', LEASE_MS, ['unwanted.job'], T0),
      ).toBeUndefined();
      expect(await store.claim('runner-a', LEASE_MS, TYPES, T0)).toBeDefined();
      expect(
        await store.claim('runner-a', LEASE_MS, TYPES, T0),
      ).toBeUndefined();
    });

    it('a running job keeps jobs with its concurrency key queued until it ends', async () => {
      const store = await open();
      const a = newJob({ concurrencyKey: 'queue:a' });
      const b = newJob({ concurrencyKey: 'queue:a' });
      const c = newJob({ concurrencyKey: 'queue:c' });
      await store.create(a, T0);
      await store.create(b, T0 + 1);
      await store.create(c, T0 + 2);

      const first = await claimNext(store, 'r1', T0 + 10);
      const second = await claimNext(store, 'r2', T0 + 10);

      expect(first.job.id).toBe(a.id);
      expect(second.job.id).toBe(c.id);
      expect(await store.claim('r3', LEASE_MS, TYPES, T0 + 10)).toBeUndefined();

      await store.finish(first.lease, 'succeeded', null, T0 + 20);
      expect((await claimNext(store, 'r3', T0 + 21)).job.id).toBe(b.id);
    });

    it('AC-2 two claimers racing over queued jobs never claim one twice', async () => {
      const store = await open();
      const ids = new Set<string>();
      // A pool opens its connections on demand: warm it, so the claimers really overlap.
      await Promise.all(
        Array.from({ length: 6 }, () => store.get('warm-up' as JobId)),
      );
      for (let i = 0; i < 24; i += 1) {
        const job = newJob();
        ids.add(job.id);
        await store.create(job, T0 + i);
      }

      const claimedBy = async (owner: string): Promise<string[]> => {
        const mine: string[] = [];
        for (;;) {
          const job = await store.claim(owner, LEASE_MS, TYPES, T0 + 100);
          if (job === undefined) return mine;
          mine.push(job.id);
        }
      };
      const results = await Promise.all(
        ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map(claimedBy),
      );

      const all = results.flat();
      expect(all).toHaveLength(24);
      expect(new Set(all)).toEqual(ids);
    });

    it('AC-2 a concurrency key is never held by two running jobs, even when claims race', async () => {
      const store = await open();
      const owners = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'];
      // A pool opens its connections on demand: warm it, so the claims below really overlap.
      await Promise.all(owners.map(() => store.get('warm-up' as JobId)));

      // Each round has its own type and key, so what one round leaves behind does not touch the next.
      for (let round = 0; round < 5; round += 1) {
        const type = `test.race${String(round)}`;
        for (let i = 0; i < 6; i += 1) {
          await store.create(
            newJob({ type, concurrencyKey: `queue:${String(round)}` }),
            T0 + i,
          );
        }

        const claims = await Promise.all(
          owners.map((owner) => store.claim(owner, LEASE_MS, [type], T0 + 100)),
        );

        expect(claims.filter((job) => job !== undefined)).toHaveLength(1);
      }
    });

    it('AC-2 a lease expires after 30 s without a heartbeat and the job is not taken by another runner', async () => {
      const store = await open();
      const queued = newJob();
      await store.create(queued, T0);
      const { lease } = await claimNext(store, 'runner-a', T0);

      // A heartbeat at 29.999 s keeps it; nothing is reaped yet.
      expect(await store.heartbeat(lease, LEASE_MS, T0 + 29_999)).toBe(true);
      expect(await store.interruptRunning('expired', T0 + 59_998, 10)).toBe(0);
      expect((await store.get(queued.id))?.leaseUntil).toBe(
        T0 + 29_999 + LEASE_MS,
      );

      // Silence for 30 s: the lease is over, a heartbeat cannot revive it, and the job is reaped.
      expect(await store.heartbeat(lease, LEASE_MS, T0 + 59_999)).toBe(false);
      expect(await store.interruptRunning('expired', T0 + 59_999, 10)).toBe(1);
      expect(await store.get(queued.id)).toMatchObject({
        state: 'paused-interrupted',
        stateReason: 'lease-expired',
        leaseOwner: null,
        leaseUntil: null,
      });
      expect(
        await store.claim('runner-b', LEASE_MS, TYPES, T0 + 60_000),
      ).toBeUndefined();
      expect(await store.saveCheckpoint(lease, bytes(9), T0 + 60_000)).toBe(
        false,
      );
      expect(await store.finish(lease, 'succeeded', null, T0 + 60_000)).toBe(
        false,
      );
    });

    it('a lease of an older attempt cannot write, even under the same owner name', async () => {
      const store = await open();
      const queued = newJob();
      await store.create(queued, T0);
      const stale = (await claimNext(store, 'runner-a', T0)).lease;
      await store.interruptRunning('all', T0 + 1, 10);
      expect(
        await store.transition(
          queued.id,
          ['paused-interrupted'],
          'queued',
          'resume',
          T0 + 2,
        ),
      ).toBe(true);
      const fresh = (await claimNext(store, 'runner-a', T0 + 3)).lease;

      expect(stale.attempt).toBe(1);
      expect(fresh.attempt).toBe(2);
      expect(await store.heartbeat(stale, LEASE_MS, T0 + 4)).toBe(false);
      expect(await store.saveCheckpoint(stale, bytes(7), T0 + 4)).toBe(false);
      expect(await store.finish(stale, 'failed', 'stale', T0 + 4)).toBe(false);
      expect((await store.get(queued.id))?.state).toBe('running');
      expect(await store.heartbeat(fresh, LEASE_MS, T0 + 4)).toBe(true);
    });

    it('a checkpoint is stored while the lease holds and dropped with a final state', async () => {
      const store = await open();
      const queued = newJob();
      await store.create(queued, T0);
      const { lease } = await claimNext(store, 'runner-a', T0);

      expect(await store.saveCheckpoint(lease, bytes(4, 5), T0 + 1)).toBe(true);
      expect(same((await store.get(queued.id))?.checkpoint, bytes(4, 5))).toBe(
        true,
      );
      expect(
        await store.saveCheckpoint(
          { ...lease, owner: 'runner-b' },
          bytes(6),
          T0 + 2,
        ),
      ).toBe(false);
      expect(same((await store.get(queued.id))?.checkpoint, bytes(4, 5))).toBe(
        true,
      );

      expect(
        await store.finish(lease, 'succeeded', null, T0 + 3, bytes(8, 8)),
      ).toBe(true);
      const done = await store.get(queued.id);
      expect(done).toMatchObject({
        state: 'succeeded',
        checkpoint: null,
        leaseOwner: null,
      });
      expect(same(done?.result, bytes(8, 8))).toBe(true);
    });

    it('finish releases into the given state and keeps the checkpoint of an interrupted job', async () => {
      const store = await open();
      const queued = newJob();
      await store.create(queued, T0);
      const { lease } = await claimNext(store, 'runner-a', T0);
      await store.saveCheckpoint(lease, bytes(4), T0 + 1);

      expect(
        await store.finish(
          { ...lease, owner: 'runner-b' },
          'paused',
          'x',
          T0 + 2,
        ),
      ).toBe(false);
      expect(
        await store.finish(lease, 'paused-interrupted', 'shutdown', T0 + 3),
      ).toBe(true);
      expect(await store.finish(lease, 'paused', 'again', T0 + 4)).toBe(false);

      const stored = await store.get(queued.id);
      expect(stored).toMatchObject({
        state: 'paused-interrupted',
        stateReason: 'shutdown',
        leaseOwner: null,
        leaseUntil: null,
        updatedAt: T0 + 3,
      });
      expect(same(stored?.checkpoint, bytes(4))).toBe(true);
    });

    it('transition moves a job that is not running, only from the listed states', async () => {
      const store = await open();
      const queued = newJob();
      await store.create(queued, T0);

      expect(
        await store.transition(
          queued.id,
          ['paused'],
          'cancelled',
          'no',
          T0 + 1,
        ),
      ).toBe(false);
      expect(
        await store.transition(queued.id, ['queued'], 'paused', 'user', T0 + 2),
      ).toBe(true);
      expect(await store.get(queued.id)).toMatchObject({
        state: 'paused',
        stateReason: 'user',
        updatedAt: T0 + 2,
      });
      expect(
        await store.transition(
          queued.id,
          ['paused'],
          'cancelled',
          null,
          T0 + 3,
        ),
      ).toBe(true);
      expect(
        await store.transition(queued.id, ['paused'], 'queued', null, T0 + 4),
      ).toBe(false);
      expect(
        await store.transition('nope' as JobId, ['queued'], 'paused', null, T0),
      ).toBe(false);
      await expect(
        store.transition(
          queued.id,
          ['running', 'queued'],
          'cancelled',
          null,
          T0,
        ),
      ).rejects.toThrow(TypeError);
    });

    it('interruptRunning reaps only expired leases, or every running job, up to the limit', async () => {
      const store = await open();
      for (let i = 0; i < 3; i += 1) await store.create(newJob(), T0 + i);
      await claimNext(store, 'r1', T0 + 10, 10_000);
      await claimNext(store, 'r2', T0 + 10, 50_000);
      await claimNext(store, 'r3', T0 + 10, 50_000);

      expect(await store.interruptRunning('expired', T0 + 20_000, 10)).toBe(1);
      expect(await store.interruptRunning('all', T0 + 20_001, 1)).toBe(1);
      expect(await store.interruptRunning('all', T0 + 20_002, 10)).toBe(1);
      expect(await store.interruptRunning('all', T0 + 20_003, 10)).toBe(0);
      const { items } = await store.list(['paused-interrupted'], { limit: 10 });
      expect(items.map((job) => job.stateReason).sort()).toEqual([
        'engine-restart',
        'engine-restart',
        'lease-expired',
      ]);
    });

    it('list returns a bounded window per state, oldest first, with a cursor', async () => {
      const store = await open();
      const ids: JobId[] = [];
      for (let i = 0; i < 5; i += 1) {
        const job = newJob();
        ids.push(job.id);
        await store.create(job, T0 + i);
      }
      await store.transition(at(ids, 1), ['queued'], 'paused', null, T0 + 10);

      const first = await store.list(['queued'], { limit: 2 });
      const second = await store.list(['queued'], {
        limit: 2,
        ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }),
      });

      expect(first.items.map((job) => job.id)).toEqual([
        at(ids, 0),
        at(ids, 2),
      ]);
      expect(first.nextCursor).toBeDefined();
      expect(second.items.map((job) => job.id)).toEqual([
        at(ids, 3),
        at(ids, 4),
      ]);
      expect(second.nextCursor).toBeUndefined();
      expect(
        (await store.list(['paused', 'queued'], { limit: 100 })).items,
      ).toHaveLength(5);
      expect((await store.list([], { limit: 10 })).items).toEqual([]);
    });

    it('events record each state change in order, with the attempt and the owner', async () => {
      const store = await open();
      const queued = newJob();
      await store.create(queued, T0);
      const { lease } = await claimNext(store, 'runner-a', T0 + 1);
      await store.finish(lease, 'paused-interrupted', 'shutdown', T0 + 2);
      await store.transition(
        queued.id,
        ['paused-interrupted'],
        'queued',
        'resume',
        T0 + 3,
      );

      const events = await store.events(queued.id, 0, 100);

      expect(
        events.map((e) => [
          e.seq,
          e.fromState,
          e.toState,
          e.reason,
          e.attempt,
          e.owner,
          e.at,
        ]),
      ).toEqual([
        [1, null, 'queued', null, 0, null, T0],
        [2, 'queued', 'running', null, 1, 'runner-a', T0 + 1],
        [3, 'running', 'paused-interrupted', 'shutdown', 1, 'runner-a', T0 + 2],
        [4, 'paused-interrupted', 'queued', 'resume', 1, null, T0 + 3],
      ]);
      expect((await store.events(queued.id, 3, 100)).map((e) => e.seq)).toEqual(
        [4],
      );
      expect(await store.events(queued.id, 0, 2)).toHaveLength(2);
    });

    it('purgeFinishedBefore removes only old finished jobs, with their events', async () => {
      const store = await open();
      const old = newJob();
      const recent = newJob();
      const active = newJob();
      for (const job of [old, recent, active]) await store.create(job, T0);
      await store.finish(
        (await claimNext(store, 'r', T0)).lease,
        'failed',
        'x',
        T0 + 10,
      );
      await store.finish(
        (await claimNext(store, 'r', T0)).lease,
        'succeeded',
        null,
        T0 + 100,
      );

      expect(await store.purgeFinishedBefore(T0 + 50, 10)).toBe(1);

      expect(await store.get(old.id)).toBeUndefined();
      expect(await store.events(old.id, 0, 10)).toEqual([]);
      expect((await store.get(recent.id))?.state).toBe('succeeded');
      expect((await store.get(active.id))?.state).toBe('queued');
      expect(await store.purgeFinishedBefore(T0 + 1000, 0)).toBe(0);
    });
  });
}
