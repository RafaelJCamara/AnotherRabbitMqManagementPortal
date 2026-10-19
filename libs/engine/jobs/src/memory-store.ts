// A JobStore in memory, for the runner's specs and for service specs that submit jobs. It meets the
// same contract as the SQLite and Postgres stores (`@app/ports/testing`), so what a spec shows
// about the runner holds there too. Not for a composition root: nothing here survives a restart.
import type { JobId } from '@app/contracts';
import type { JobEventRecord, JobRecord, JobState, JobStore } from '@app/ports';

const FINAL_STATES: ReadonlySet<JobState> = new Set([
  'succeeded',
  'failed',
  'cancelled',
]);
const MAX_LIST_WINDOW = 200;
const MAX_EVENT_WINDOW = 1000;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface MemoryJobStore extends JobStore {
  /** Every stored job, for a spec that wants to look or to edit a row behind the runner's back. */
  readonly rows: Map<JobId, Mutable<JobRecord>>;
  /** Makes the next `count` calls of `method` reject, as a failing database would. */
  failNext(method: keyof JobStore, count?: number): void;
}

export function createMemoryJobStore(): MemoryJobStore {
  const rows = new Map<JobId, Mutable<JobRecord>>();
  const events = new Map<JobId, JobEventRecord[]>();
  const failures = new Map<string, number>();

  /** The failure `failNext` asked for, if one is due. */
  const guard = (method: keyof JobStore): Error | undefined => {
    const left = failures.get(method) ?? 0;
    if (left === 0) return undefined;
    failures.set(method, left - 1);
    return new Error(`job store ${method} failed`);
  };

  const record = (
    row: JobRecord,
    at: number,
    fromState: JobState | null,
    reason: string | null,
    owner: string | null,
  ): void => {
    const list = events.get(row.id) ?? [];
    list.push({
      jobId: row.id,
      seq: list.length + 1,
      at,
      fromState,
      toState: row.state,
      reason,
      attempt: row.attempts,
      owner,
    });
    events.set(row.id, list);
  };

  /** A copy, so a caller cannot change a stored row by holding the record it was given. */
  const copy = (row: JobRecord): JobRecord => ({
    ...row,
    input: Uint8Array.from(row.input),
    checkpoint:
      row.checkpoint === null ? null : Uint8Array.from(row.checkpoint),
    result: row.result === null ? null : Uint8Array.from(row.result),
  });

  const holds = (
    row: Mutable<JobRecord> | undefined,
    lease: { owner: string; attempt: number },
  ): row is Mutable<JobRecord> =>
    row?.state === 'running' &&
    row.leaseOwner === lease.owner &&
    row.attempts === lease.attempt;

  const store: MemoryJobStore = {
    rows,
    failNext(method, count = 1) {
      failures.set(method, count);
    },

    create(job, now) {
      const down = guard('create');
      if (down !== undefined) return Promise.reject(down);
      for (const row of rows.values()) {
        if (
          row.principalId === job.principalId &&
          row.idempotencyKey === job.idempotencyKey
        ) {
          return Promise.resolve({ job: copy(row), created: false });
        }
      }
      if (rows.has(job.id))
        return Promise.reject(new Error('Duplicate job id.'));
      const row: Mutable<JobRecord> = {
        ...job,
        input: Uint8Array.from(job.input),
        state: 'queued',
        stateReason: null,
        checkpoint: null,
        result: null,
        leaseOwner: null,
        leaseUntil: null,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(job.id, row);
      record(row, now, null, null, null);
      return Promise.resolve({ job: copy(row), created: true });
    },

    get(id) {
      const down = guard('get');
      if (down !== undefined) return Promise.reject(down);
      const row = rows.get(id);
      return Promise.resolve(row === undefined ? undefined : copy(row));
    },

    claim(owner, leaseMs, types, now) {
      const down = guard('claim');
      if (down !== undefined) return Promise.reject(down);
      const holders = new Set<string>();
      for (const row of rows.values()) {
        if (row.state === 'running' && row.concurrencyKey !== null) {
          holders.add(row.concurrencyKey);
        }
      }
      const next = [...rows.values()]
        .filter(
          (row) =>
            row.state === 'queued' &&
            types.includes(row.type) &&
            (row.concurrencyKey === null || !holders.has(row.concurrencyKey)),
        )
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))[0];
      if (next === undefined) return Promise.resolve(undefined);
      next.state = 'running';
      next.stateReason = null;
      next.leaseOwner = owner;
      next.leaseUntil = now + leaseMs;
      next.attempts += 1;
      next.updatedAt = now;
      record(next, now, 'queued', null, owner);
      return Promise.resolve(copy(next));
    },

    heartbeat(lease, leaseMs, now) {
      const down = guard('heartbeat');
      if (down !== undefined) return Promise.reject(down);
      const row = rows.get(lease.id);
      if (!holds(row, lease) || (row.leaseUntil ?? 0) <= now) {
        return Promise.resolve(false);
      }
      row.leaseUntil = now + leaseMs;
      row.updatedAt = now;
      return Promise.resolve(true);
    },

    saveCheckpoint(lease, checkpoint, now) {
      const down = guard('saveCheckpoint');
      if (down !== undefined) return Promise.reject(down);
      const row = rows.get(lease.id);
      if (!holds(row, lease) || (row.leaseUntil ?? 0) <= now) {
        return Promise.resolve(false);
      }
      row.checkpoint = Uint8Array.from(checkpoint);
      row.updatedAt = now;
      return Promise.resolve(true);
    },

    finish(lease, state, reason, now, result) {
      const down = guard('finish');
      if (down !== undefined) return Promise.reject(down);
      const row = rows.get(lease.id);
      if (!holds(row, lease)) return Promise.resolve(false);
      row.state = state;
      row.stateReason = reason;
      row.leaseOwner = null;
      row.leaseUntil = null;
      row.updatedAt = now;
      if (FINAL_STATES.has(state)) row.checkpoint = null;
      if (result !== undefined) row.result = Uint8Array.from(result);
      record(row, now, 'running', reason, lease.owner);
      return Promise.resolve(true);
    },

    transition(id, from, to, reason, now) {
      const down = guard('transition');
      if (down !== undefined) return Promise.reject(down);
      if (from.includes('running')) {
        return Promise.reject(
          new TypeError('transition() never moves a running job.'),
        );
      }
      const row = rows.get(id);
      if (row === undefined || !from.includes(row.state)) {
        return Promise.resolve(false);
      }
      const before = row.state;
      row.state = to;
      row.stateReason = reason;
      row.updatedAt = now;
      record(row, now, before, reason, null);
      return Promise.resolve(true);
    },

    interruptRunning(scope, now, limit) {
      const down = guard('interruptRunning');
      if (down !== undefined) return Promise.reject(down);
      const reason = scope === 'expired' ? 'lease-expired' : 'engine-restart';
      let interrupted = 0;
      const running = [...rows.values()]
        .filter(
          (row) =>
            row.state === 'running' &&
            (scope === 'all' || (row.leaseUntil ?? 0) <= now),
        )
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      for (const row of running) {
        if (interrupted >= limit) break;
        const owner = row.leaseOwner;
        row.state = 'paused-interrupted';
        row.stateReason = reason;
        row.leaseOwner = null;
        row.leaseUntil = null;
        row.updatedAt = now;
        record(row, now, 'running', reason, owner);
        interrupted += 1;
      }
      return Promise.resolve(interrupted);
    },

    list(states, page) {
      const down = guard('list');
      if (down !== undefined) return Promise.reject(down);
      const limit = Math.max(
        1,
        Math.min(Math.trunc(page.limit), MAX_LIST_WINDOW),
      );
      const matching = [...rows.values()]
        .filter(
          (row) =>
            states.includes(row.state) &&
            (page.cursor === undefined || row.id > page.cursor),
        )
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      const items = matching.slice(0, limit).map(copy);
      const last = items.at(-1);
      return Promise.resolve(
        matching.length > limit && last !== undefined
          ? { items, nextCursor: last.id }
          : { items },
      );
    },

    events(id, afterSeq, limit) {
      const down = guard('events');
      if (down !== undefined) return Promise.reject(down);
      return Promise.resolve(
        (events.get(id) ?? [])
          .filter((event) => event.seq > afterSeq)
          .slice(0, Math.max(1, Math.min(Math.trunc(limit), MAX_EVENT_WINDOW))),
      );
    },

    purgeFinishedBefore(cutoff, limit) {
      const down = guard('purgeFinishedBefore');
      if (down !== undefined) return Promise.reject(down);
      let removed = 0;
      for (const [id, row] of rows) {
        if (removed >= limit) break;
        if (FINAL_STATES.has(row.state) && row.updatedAt < cutoff) {
          rows.delete(id);
          events.delete(id);
          removed += 1;
        }
      }
      return Promise.resolve(removed);
    },
  };
  return store;
}
