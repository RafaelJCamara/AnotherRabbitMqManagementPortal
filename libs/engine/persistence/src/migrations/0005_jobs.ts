import type { Migration } from '../migrate/types';

// Durable jobs (M0-31, ADR-015, blueprint 6.2). `input`, `checkpoint` and `result` are ciphertext
// made by the JobRunner: the requester, the bound fields (type, version, plan hash, idempotency and
// concurrency keys) and the job's own input live inside `input`, so a row edited by someone without
// the key does not run as another principal. `attempts` counts claims; a lease is one attempt and
// every write of a running job is fenced by owner and attempt, so a runner that lost the job cannot
// change it. `UNIQUE (principal_id, idempotency_key)` makes a repeated submit return the first job.
// The partial unique index lets one running job hold a concurrency key, whatever races: a second
// claim that would break it fails and the store looks at the next candidate.
export const migration0005Jobs: Migration = {
  id: '0005_jobs',
  up: async (db) => {
    const { t } = db;

    await db.execute(`CREATE TABLE jobs (
  id ${t.id()} NOT NULL PRIMARY KEY,
  type TEXT NOT NULL,
  version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'paused', 'paused-interrupted', 'awaiting-credentials', 'succeeded', 'failed', 'cancelled')),
  state_reason TEXT,
  principal_id ${t.id()} NOT NULL,
  on_behalf_of_id ${t.id()},
  plan_hash ${t.id()},
  idempotency_key ${t.id()} NOT NULL,
  concurrency_key ${t.id()},
  resumable INTEGER NOT NULL,
  input ${t.bytes()} NOT NULL,
  checkpoint ${t.bytes()},
  result ${t.bytes()},
  lease_owner ${t.id()},
  lease_until ${t.epochMs()},
  attempts INTEGER NOT NULL,
  created_at ${t.epochMs()} NOT NULL,
  updated_at ${t.epochMs()} NOT NULL,
  UNIQUE (principal_id, idempotency_key)
)`);
    await db.execute(
      'CREATE INDEX jobs_claim ON jobs (state, type, created_at, id)',
    );
    await db.execute('CREATE INDEX jobs_lease ON jobs (state, lease_until)');
    await db.execute('CREATE INDEX jobs_retention ON jobs (state, updated_at)');
    await db.execute(
      `CREATE UNIQUE INDEX jobs_concurrency_running ON jobs (concurrency_key)
WHERE state = 'running' AND concurrency_key IS NOT NULL`,
    );

    await db.execute(`CREATE TABLE job_events (
  job_id ${t.id()} NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  at ${t.epochMs()} NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason TEXT,
  attempt INTEGER NOT NULL,
  owner ${t.id()},
  PRIMARY KEY (job_id, seq)
)`);
  },
};
