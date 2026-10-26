import type { Migration } from '../migrate/types';

// The publish history (M1-19, PUB-02): what a person published, per owner and per connection.
//
//   publish_history   one row per publish call. The facts a window filters and shows are plain
//                     columns: owner, connection, vhost, time (`published_at`), expiry, exchange, routing key, the
//                     copy count, the per-outcome counts (`summary`, counts only) and the size and
//                     sha256 of the body. The properties, the headers and the body are ONE sealed
//                     document, `data_sealed` (an AES-GCM envelope made by @app/secrets, the row id
//                     in the authenticated data, ADR-014), and the service masks them before it
//                     seals. There is no column that can hold a body, a header or a key in the open.
//
// `publish_history_window` serves the newest-first keyset window of one owner on one connection
// ((published_at, id) descending, read backwards); `publish_history_expiry` serves the bounded purge.
export const migration0011PublishHistory: Migration = {
  id: '0011_publish_history',
  up: async (db) => {
    const { t } = db;

    await db.execute(`CREATE TABLE publish_history (
  id ${t.id()} NOT NULL PRIMARY KEY,
  owner_id ${t.id()} NOT NULL,
  connection_id ${t.id()} NOT NULL,
  vhost TEXT NOT NULL,
  published_at ${t.epochMs()} NOT NULL,
  expires_at ${t.epochMs()} NOT NULL,
  exchange TEXT NOT NULL,
  routing_key TEXT NOT NULL,
  copies BIGINT NOT NULL CHECK (copies >= 1),
  summary ${t.json()} NOT NULL,
  body_bytes BIGINT NOT NULL CHECK (body_bytes >= 0),
  body_sha256 TEXT NOT NULL,
  data_sealed ${t.bytes()} NOT NULL
)`);
    await db.execute(
      'CREATE INDEX publish_history_window ON publish_history (owner_id, connection_id, published_at, id)',
    );
    await db.execute(
      'CREATE INDEX publish_history_expiry ON publish_history (expires_at, id)',
    );
  },
};
