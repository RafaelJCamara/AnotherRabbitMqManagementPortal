// The Kysely implementation of the JobStore port of @app/ports (M0-31, ADR-015), for SQLite and
// Postgres. It stores rows and compare-and-sets them; sealing, leases, drain and the resume rules
// are the JobRunner's (`@app/jobs`). Every method that changes a job writes its `job_events` row in
// the same transaction.
//
// Claiming: Postgres takes the candidate with `FOR UPDATE SKIP LOCKED`, so two runners never wait
// for each other or take the same job. SQLite has one connection and one writer at a time, so a
// transaction is already exclusive. A concurrency key is held by one running job at a time: the
// candidate query skips a key a running job holds, and the partial unique index of 0005_jobs stops
// two claims that raced past that check (the loser's update fails and the next candidate is tried).
import type { JobId } from '@app/contracts';
import type {
  JobEventRecord,
  JobRecord,
  JobState,
  JobStore,
  NewJob,
} from '@app/ports';
import type { Kysely, Selectable } from 'kysely';

import type { Database, JobEventsTable, JobsTable } from '../database';
import type { DialectName } from '../migrate/helpers';

const FINAL_STATES: JobState[] = ['succeeded', 'failed', 'cancelled'];

/** Candidates one `claim` looks at when concurrency keys keep refusing them. */
const MAX_CLAIM_TRIES = 8;
const MAX_LIST_WINDOW = 200;
const MAX_EVENT_WINDOW = 1000;

function toRecord(row: Selectable<JobsTable>): JobRecord {
  // pg returns a Buffer and node:sqlite a Uint8Array: hand out a plain Uint8Array either way.
  const bytes = (value: Uint8Array | null): Uint8Array | null =>
    value === null ? null : Uint8Array.from(value);
  return {
    id: row.id as JobId,
    type: row.type,
    version: row.version,
    state: row.state as JobState,
    stateReason: row.state_reason,
    principalId: row.principal_id,
    onBehalfOfId: row.on_behalf_of_id,
    planHash: row.plan_hash,
    idempotencyKey: row.idempotency_key,
    concurrencyKey: row.concurrency_key,
    resumable: row.resumable === 1,
    input: Uint8Array.from(row.input),
    checkpoint: bytes(row.checkpoint),
    result: bytes(row.result),
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEvent(row: Selectable<JobEventsTable>): JobEventRecord {
  return {
    jobId: row.job_id as JobId,
    seq: row.seq,
    at: row.at,
    fromState: row.from_state as JobState | null,
    toState: row.to_state as JobState,
    reason: row.reason,
    attempt: row.attempt,
    owner: row.owner,
  };
}

/** Postgres `unique_violation`. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}

async function addEvent(
  db: Kysely<Database>,
  event: Omit<JobEventRecord, 'seq'>,
): Promise<void> {
  const last = await db
    .selectFrom('job_events')
    .select((eb) => eb.fn.max('seq').as('last'))
    .where('job_id', '=', event.jobId)
    .executeTakeFirst();
  await db
    .insertInto('job_events')
    .values({
      job_id: event.jobId,
      seq: (last?.last ?? 0) + 1,
      at: event.at,
      from_state: event.fromState,
      to_state: event.toState,
      reason: event.reason,
      attempt: event.attempt,
      owner: event.owner,
    })
    .execute();
}

export function createJobStore(
  db: Kysely<Database>,
  dialect: DialectName,
): JobStore {
  const lockRows = dialect === 'pg';

  /** One try at claiming: the candidate that was tried, and the job when the claim went through. */
  async function tryClaim(
    owner: string,
    leaseMs: number,
    types: readonly string[],
    now: number,
    skip: readonly string[],
    tried: { id?: string },
  ): Promise<JobRecord | undefined> {
    return db.transaction().execute(async (trx) => {
      let candidates = trx
        .selectFrom('jobs')
        .select('id')
        .where('state', '=', 'queued')
        .where('type', 'in', [...types])
        .where((eb) =>
          eb.or([
            eb('concurrency_key', 'is', null),
            eb.not(
              eb.exists(
                eb
                  .selectFrom('jobs as holder')
                  .select('holder.id')
                  .whereRef(
                    'holder.concurrency_key',
                    '=',
                    'jobs.concurrency_key',
                  )
                  .where('holder.state', '=', 'running'),
              ),
            ),
          ]),
        )
        .orderBy('created_at')
        .orderBy('id')
        .limit(1);
      if (skip.length > 0)
        candidates = candidates.where('id', 'not in', [...skip]);
      if (lockRows) candidates = candidates.forUpdate().skipLocked();
      const candidate = await candidates.executeTakeFirst();
      if (candidate === undefined) return undefined;
      tried.id = candidate.id;

      const claimed = await trx
        .updateTable('jobs')
        .set((eb) => ({
          state: 'running',
          state_reason: null,
          lease_owner: owner,
          lease_until: now + leaseMs,
          attempts: eb('attempts', '+', 1),
          updated_at: now,
        }))
        .where('id', '=', candidate.id)
        .where('state', '=', 'queued')
        .returningAll()
        .executeTakeFirst();
      if (claimed === undefined) return undefined;
      await addEvent(trx, {
        jobId: claimed.id as JobId,
        at: now,
        fromState: 'queued',
        toState: 'running',
        reason: null,
        attempt: claimed.attempts,
        owner,
      });
      return toRecord(claimed);
    });
  }

  return {
    async create(job: NewJob, now) {
      return db.transaction().execute(async (trx) => {
        const inserted = await trx
          .insertInto('jobs')
          .values({
            id: job.id,
            type: job.type,
            version: job.version,
            state: 'queued',
            state_reason: null,
            principal_id: job.principalId,
            on_behalf_of_id: job.onBehalfOfId,
            plan_hash: job.planHash,
            idempotency_key: job.idempotencyKey,
            concurrency_key: job.concurrencyKey,
            resumable: job.resumable ? 1 : 0,
            input: job.input,
            checkpoint: null,
            result: null,
            lease_owner: null,
            lease_until: null,
            attempts: 0,
            created_at: now,
            updated_at: now,
          })
          .onConflict((conflict) =>
            conflict.columns(['principal_id', 'idempotency_key']).doNothing(),
          )
          .returningAll()
          .executeTakeFirst();
        if (inserted !== undefined) {
          await addEvent(trx, {
            jobId: job.id,
            at: now,
            fromState: null,
            toState: 'queued',
            reason: null,
            attempt: 0,
            owner: null,
          });
          return { job: toRecord(inserted), created: true };
        }
        const existing = await trx
          .selectFrom('jobs')
          .selectAll()
          .where('principal_id', '=', job.principalId)
          .where('idempotency_key', '=', job.idempotencyKey)
          .executeTakeFirstOrThrow();
        return { job: toRecord(existing), created: false };
      });
    },

    async get(id) {
      const row = await db
        .selectFrom('jobs')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row === undefined ? undefined : toRecord(row);
    },

    async claim(owner, leaseMs, types, now) {
      if (types.length === 0) return undefined;
      const skip: string[] = [];
      for (let attempt = 0; attempt < MAX_CLAIM_TRIES; attempt += 1) {
        const tried: { id?: string } = {};
        try {
          return await tryClaim(owner, leaseMs, types, now, skip, tried);
        } catch (error) {
          // A racing claim took the concurrency key first: leave that job queued, look further.
          if (!isUniqueViolation(error) || tried.id === undefined) throw error;
          skip.push(tried.id);
        }
      }
      return undefined;
    },

    async heartbeat(lease, leaseMs, now) {
      const result = await db
        .updateTable('jobs')
        .set({ lease_until: now + leaseMs, updated_at: now })
        .where('id', '=', lease.id)
        .where('state', '=', 'running')
        .where('lease_owner', '=', lease.owner)
        .where('attempts', '=', lease.attempt)
        .where('lease_until', '>', now)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    async saveCheckpoint(lease, checkpoint, now) {
      const result = await db
        .updateTable('jobs')
        .set({ checkpoint, updated_at: now })
        .where('id', '=', lease.id)
        .where('state', '=', 'running')
        .where('lease_owner', '=', lease.owner)
        .where('attempts', '=', lease.attempt)
        .where('lease_until', '>', now)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    async finish(lease, state, reason, now, result) {
      return db.transaction().execute(async (trx) => {
        const released = await trx
          .updateTable('jobs')
          .set({
            state,
            state_reason: reason,
            lease_owner: null,
            lease_until: null,
            updated_at: now,
            ...(FINAL_STATES.includes(state) ? { checkpoint: null } : {}),
            ...(result === undefined ? {} : { result }),
          })
          .where('id', '=', lease.id)
          .where('state', '=', 'running')
          .where('lease_owner', '=', lease.owner)
          .where('attempts', '=', lease.attempt)
          .returning('attempts')
          .executeTakeFirst();
        if (released === undefined) return false;
        await addEvent(trx, {
          jobId: lease.id,
          at: now,
          fromState: 'running',
          toState: state,
          reason,
          attempt: lease.attempt,
          owner: lease.owner,
        });
        return true;
      });
    },

    async transition(id, from, to, reason, now) {
      if (from.includes('running')) {
        throw new TypeError(
          'A running job is released with finish(), fenced by its lease; transition() never moves one.',
        );
      }
      if (from.length === 0) return false;
      return db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom('jobs')
          .select(['state', 'attempts'])
          .where('id', '=', id)
          .executeTakeFirst();
        if (row === undefined || !from.includes(row.state as JobState)) {
          return false;
        }
        const moved = await trx
          .updateTable('jobs')
          .set({ state: to, state_reason: reason, updated_at: now })
          .where('id', '=', id)
          .where('state', '=', row.state)
          .executeTakeFirst();
        if (Number(moved.numUpdatedRows) === 0) return false;
        await addEvent(trx, {
          jobId: id,
          at: now,
          fromState: row.state as JobState,
          toState: to,
          reason,
          attempt: row.attempts,
          owner: null,
        });
        return true;
      });
    },

    async interruptRunning(scope, now, limit) {
      if (limit < 1) return 0;
      return db.transaction().execute(async (trx) => {
        let running = trx
          .selectFrom('jobs')
          .select(['id', 'attempts', 'lease_owner'])
          .where('state', '=', 'running')
          .orderBy('id')
          .limit(Math.trunc(limit));
        if (scope === 'expired')
          running = running.where('lease_until', '<=', now);
        if (lockRows) running = running.forUpdate().skipLocked();
        const rows = await running.execute();
        const reason = scope === 'expired' ? 'lease-expired' : 'engine-restart';
        let interrupted = 0;
        for (const row of rows) {
          const moved = await trx
            .updateTable('jobs')
            .set({
              state: 'paused-interrupted',
              state_reason: reason,
              lease_owner: null,
              lease_until: null,
              updated_at: now,
            })
            .where('id', '=', row.id)
            .where('state', '=', 'running')
            .executeTakeFirst();
          if (Number(moved.numUpdatedRows) === 0) continue;
          interrupted += 1;
          await addEvent(trx, {
            jobId: row.id as JobId,
            at: now,
            fromState: 'running',
            toState: 'paused-interrupted',
            reason,
            attempt: row.attempts,
            owner: row.lease_owner,
          });
        }
        return interrupted;
      });
    },

    async list(states, page) {
      if (states.length === 0) return { items: [] };
      const limit = Math.max(
        1,
        Math.min(Math.trunc(page.limit), MAX_LIST_WINDOW),
      );
      let query = db
        .selectFrom('jobs')
        .selectAll()
        .where('state', 'in', [...states])
        .orderBy('id')
        .limit(limit + 1);
      if (page.cursor !== undefined)
        query = query.where('id', '>', page.cursor);
      const rows = await query.execute();
      const items = rows.slice(0, limit).map(toRecord);
      const last = items.at(-1);
      return rows.length > limit && last !== undefined
        ? { items, nextCursor: last.id }
        : { items };
    },

    async events(id, afterSeq, limit) {
      const rows = await db
        .selectFrom('job_events')
        .selectAll()
        .where('job_id', '=', id)
        .where('seq', '>', afterSeq)
        .orderBy('seq')
        .limit(Math.max(1, Math.min(Math.trunc(limit), MAX_EVENT_WINDOW)))
        .execute();
      return rows.map(toEvent);
    },

    async purgeFinishedBefore(cutoff, limit) {
      if (limit < 1) return 0;
      const result = await db
        .deleteFrom('jobs')
        .where('id', 'in', (qb) =>
          qb
            .selectFrom('jobs')
            .select('id')
            .where('state', 'in', FINAL_STATES)
            .where('updated_at', '<', cutoff)
            .limit(Math.trunc(limit)),
        )
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };
}
