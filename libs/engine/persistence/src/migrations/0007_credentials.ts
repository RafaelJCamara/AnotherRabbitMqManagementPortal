import type { Migration } from '../migrate/types';

// Connection credentials (M0-44, blueprint 6.2 `credentials`). A profile has at most one secret per
// protocol (`http`, `amqp`): separate credentials, never shared (DC-37). `ciphertext` is the sealed
// value (AES-256-GCM, `@app/secrets`); the envelope names the data key, and the authenticated data
// is `credentials:ciphertext:<connection_id>:<protocol>`, so a row copied to another profile or
// protocol does not open. Nothing here can hold a secret in the open.
//
// There is no foreign key: the repository deletes a profile and its credentials in one
// transaction, so both dialects behave the same whatever their foreign-key settings are.
export const migration0007Credentials: Migration = {
  id: '0007_credentials',
  up: async (db) => {
    const { t } = db;

    await db.execute(`CREATE TABLE credentials (
  connection_id ${t.id()} NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('http', 'amqp')),
  ciphertext ${t.bytes()} NOT NULL,
  updated_at ${t.epochMs()} NOT NULL,
  PRIMARY KEY (connection_id, protocol)
)`);
  },
};
