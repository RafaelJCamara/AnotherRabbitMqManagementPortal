import type { Migration } from '../migrate/types';

// The peek hold journal (M1-14, blueprint 5.5): one row per peek hold.
//
//   hold_journal   id, connection, vhost and the queue name SEALED by the caller (ADR-014; the
//                  bytes are stored as given), the state (`acquiring` is written before the first
//                  `get`, then `settled` or `incident`), the number of deliveries returned, a fixed
//                  reason text for an incident, and the start and end times.
//
// `acquiring` rows that outlive their process are found by the state index at start.
export const migration0010HoldJournal: Migration = {
  id: '0010_hold_journal',
  up: async (db) => {
    const { t } = db;

    await db.execute(`CREATE TABLE hold_journal (
  id ${t.id()} NOT NULL PRIMARY KEY,
  connection_id ${t.id()} NOT NULL,
  vhost TEXT NOT NULL,
  queue_sealed ${t.bytes()} NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('acquiring', 'settled', 'incident')),
  returned BIGINT NOT NULL DEFAULT 0,
  reason TEXT,
  started_at ${t.epochMs()} NOT NULL,
  ended_at ${t.epochMs()}
)`);
    await db.execute(
      'CREATE INDEX hold_journal_state ON hold_journal (state, started_at)',
    );
  },
};
