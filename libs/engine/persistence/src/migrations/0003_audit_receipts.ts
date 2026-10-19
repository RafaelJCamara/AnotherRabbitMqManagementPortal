import type { Migration } from '../migrate/types';

// The audit chain and the receipts of the ActionExecutor (M0-30, blueprint 5.1, 5.10 and 6.2).
//
// `audit_events` is append-only. Each row carries the hash of the row before it (`prev_hash`) and a
// hash over all its other columns (`hash`), written by the kernel; `seq` is assigned by the kernel
// too (no autoincrement), so a gap is a deleted row. The primary key on `seq` and the unique key on
// `prev_hash` make a second writer lose the race instead of forking the chain. Triggers reject
// UPDATE and DELETE (and TRUNCATE on Postgres), the DML-only app role of blueprint 6.1 in
// SQL form: a schema owner can still drop them, which is what `audit verify` and the anchors are for.
//
// This is migration 0003 because `0002_data_keys` (M0-22) had not landed. M0-22 landed second and
// took 0004 (see that file), so nothing here was renumbered.
export const migration0003AuditReceipts: Migration = {
  id: '0003_audit_receipts',
  up: async (db) => {
    const { t } = db;

    await db.execute(`CREATE TABLE audit_events (
  seq ${t.epochMs()} NOT NULL PRIMARY KEY,
  at ${t.epochMs()} NOT NULL,
  phase TEXT NOT NULL,
  correlation_id ${t.id()} NOT NULL,
  action_id ${t.id()} NOT NULL,
  kind TEXT NOT NULL,
  actor_id ${t.id()} NOT NULL,
  surface TEXT NOT NULL,
  on_behalf_of_id ${t.id()},
  actor ${t.json()} NOT NULL,
  target ${t.json()} NOT NULL,
  env TEXT NOT NULL,
  risk TEXT NOT NULL,
  plan_id ${t.id()},
  plan_digest ${t.id()},
  approved_by ${t.json()} NOT NULL,
  attempt_seq ${t.epochMs()},
  result TEXT,
  code TEXT,
  job_id ${t.id()},
  receipt_id ${t.id()},
  detail ${t.json()} NOT NULL,
  prev_hash ${t.id()} NOT NULL UNIQUE,
  hash ${t.id()} NOT NULL
)`);
    await db.execute(
      'CREATE INDEX audit_events_actor ON audit_events (actor_id, seq)',
    );
    await db.execute(
      'CREATE INDEX audit_events_action ON audit_events (action_id, seq)',
    );
    await db.execute(
      'CREATE INDEX audit_events_correlation ON audit_events (correlation_id)',
    );
    await db.execute('CREATE INDEX audit_events_at ON audit_events (at)');

    if (db.dialect === 'pg') {
      await db.execute(`CREATE FUNCTION audit_events_reject() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = 'insufficient_privilege';
END
$$`);
      await db.execute(
        `CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION audit_events_reject()`,
      );
      await db.execute(
        `CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
FOR EACH STATEMENT EXECUTE FUNCTION audit_events_reject()`,
      );
    } else {
      await db.execute(`CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END`);
      await db.execute(`CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END`);
    }

    await db.execute(`CREATE TABLE receipts (
  id ${t.id()} NOT NULL PRIMARY KEY,
  action_id ${t.id()} NOT NULL,
  plan_id ${t.id()},
  plan_digest ${t.id()},
  principal_id ${t.id()} NOT NULL,
  on_behalf_of_id ${t.id()},
  correlation_id ${t.id()} NOT NULL,
  env TEXT NOT NULL,
  risk TEXT NOT NULL,
  started_at ${t.epochMs()} NOT NULL,
  finished_at ${t.epochMs()} NOT NULL,
  result TEXT NOT NULL,
  code TEXT,
  job_id ${t.id()},
  audit_seq ${t.epochMs()},
  detail ${t.json()} NOT NULL,
  created_at ${t.epochMs()} NOT NULL
)`);
    await db.execute('CREATE INDEX receipts_plan ON receipts (plan_id)');
    await db.execute('CREATE INDEX receipts_created ON receipts (created_at)');
  },
};
