import type { Migration } from '../migrate/types';

// The capture store (M1-09, blueprint 6.2): messages a person saved into the workspace.
//
//   captures             one saved capture: owner, environment class, expiry, and the counters of
//                        what it holds and what was refused or left out (I-13). `deleting` marks a
//                        capture whose rows are being removed in batches; reads skip it.
//   captured_messages    one message: routing facts in the clear, the body and the properties and
//                        headers SEALED (`body_sealed`, `meta_sealed`: AES-GCM envelopes made by
//                        @app/secrets, the row id in the authenticated data), and the redacted
//                        projection (`meta_text`, `body_text`) that the index is built from. A
//                        body over 64 KiB is `blob`: its chunks are in capture_blob_chunks.
//   capture_blobs        a content-addressed body (sha256 of the plaintext) with a reference count.
//   capture_blob_chunks  its sealed chunks.
//   captured_fts         SQLite only: an FTS5 table (contentless, its rowid is the message's rowid).
//                        If the runtime has no FTS5 the table is skipped and the repository says so.
//   captured_messages.search   Postgres only: a tsvector over the same projection, with a GIN index.
//
// Foreign keys have no ON DELETE action on purpose: the repository removes a capture's messages in
// batches (index entries and blob references first), and the database refuses a capture row that
// still has messages.
export const migration0009Captures: Migration = {
  id: '0009_captures',
  up: async (db) => {
    const { t } = db;

    await db.execute(`CREATE TABLE captures (
  id ${t.id()} NOT NULL PRIMARY KEY,
  owner_id ${t.id()} NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  target ${t.json()} NOT NULL,
  env_class TEXT NOT NULL CHECK (env_class IN ('prod', 'staging', 'test', 'dev', 'local')),
  index_bodies INTEGER NOT NULL CHECK (index_bodies IN (0, 1)),
  created_at ${t.epochMs()} NOT NULL,
  expires_at ${t.epochMs()} NOT NULL,
  message_count BIGINT NOT NULL DEFAULT 0,
  stored_bytes BIGINT NOT NULL DEFAULT 0,
  dropped_queue BIGINT NOT NULL DEFAULT 0,
  dropped_quota BIGINT NOT NULL DEFAULT 0,
  dropped_limit BIGINT NOT NULL DEFAULT 0,
  omitted_bodies BIGINT NOT NULL DEFAULT 0,
  deleting INTEGER NOT NULL DEFAULT 0 CHECK (deleting IN (0, 1))
)`);
    await db.execute('CREATE INDEX captures_owner ON captures (owner_id, id)');
    await db.execute('CREATE INDEX captures_expiry ON captures (expires_at)');

    await db.execute(`CREATE TABLE capture_blobs (
  ref ${t.id()} NOT NULL PRIMARY KEY,
  size BIGINT NOT NULL,
  chunk_bytes INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  refcount INTEGER NOT NULL,
  created_at ${t.epochMs()} NOT NULL
)`);
    await db.execute(`CREATE TABLE capture_blob_chunks (
  ref ${t.id()} NOT NULL REFERENCES capture_blobs (ref),
  ix INTEGER NOT NULL,
  sealed ${t.bytes()} NOT NULL,
  PRIMARY KEY (ref, ix)
)`);

    await db.execute(`CREATE TABLE captured_messages (
  id ${t.id()} NOT NULL PRIMARY KEY,
  capture_id ${t.id()} NOT NULL REFERENCES captures (id),
  received_at ${t.epochMs()} NOT NULL,
  exchange TEXT NOT NULL,
  routing_key TEXT NOT NULL,
  source TEXT NOT NULL,
  content_type TEXT,
  redelivered INTEGER NOT NULL CHECK (redelivered IN (0, 1)),
  size BIGINT NOT NULL,
  body_sha256 ${t.id()} NOT NULL,
  body_state TEXT NOT NULL CHECK (body_state IN ('inline', 'blob', 'omitted')),
  body_sealed ${t.bytes()},
  blob_ref ${t.id()} REFERENCES capture_blobs (ref),
  meta_sealed ${t.bytes()} NOT NULL,
  meta_text TEXT NOT NULL,
  body_text TEXT,
  CHECK ((body_state = 'inline') = (body_sealed IS NOT NULL)),
  CHECK ((body_state = 'blob') = (blob_ref IS NOT NULL))
)`);
    await db.execute(
      'CREATE INDEX captured_messages_capture ON captured_messages (capture_id, id)',
    );
    await db.execute(
      'CREATE INDEX captured_messages_blob ON captured_messages (blob_ref)',
    );

    if (db.dialect === 'pg') {
      await db.execute(
        'ALTER TABLE captured_messages ADD COLUMN search tsvector',
      );
      await db.execute(
        'CREATE INDEX captured_messages_search ON captured_messages USING GIN (search)',
      );
      return;
    }
    // SQLite: contentless with deletes (3.43+), so a message's index entry can be removed by rowid.
    // A runtime without FTS5 refuses this statement; the table is then absent and
    // `searchAvailable()` answers false (OQ-988). The statement fails alone: SQLite keeps the
    // transaction open after a failed statement.
    try {
      await db.execute(
        `CREATE VIRTUAL TABLE captured_fts USING fts5(meta, body, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2')`,
      );
    } catch {
      // No FTS5 in this runtime.
    }
  },
};
