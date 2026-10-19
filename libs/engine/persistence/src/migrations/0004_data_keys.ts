import type { Migration } from '../migrate/types';

// Wrapped data keys (M0-22, ADR-014, blueprint 6.2 `data_keys`). A row holds a data key (DEK) only
// in sealed form: `wrapped` is the DEK under a KEK that lives outside the database (a KEK file, a
// passphrase, the OS keyring), or, for a key the desktop main process delivers, a key check value
// and nothing that opens anything. `wrap_params` carries the non-secret parameters of the wrap (KDF
// salt and cost, KEK check, keyring account) as JSON text. The id is the 32 hex characters named
// inside every ciphertext made with the key.
//
// One active key per purpose: the partial unique index makes a second process that initialises at
// the same moment lose the race instead of forking the keys. A retired key stays, because values
// sealed under it must still open.
//
// This is migration 0004: the issue names `0002_data_keys`, but 0002 is `0002_plans` (M0-29) and
// 0003 is `0003_audit_receipts` (M0-30), both landed first. The set must stay contiguous and no
// released schema exists, so this one, landing last, takes the next free number.
export const migration0004DataKeys: Migration = {
  id: '0004_data_keys',
  up: async (db) => {
    const { t } = db;

    await db.execute(`CREATE TABLE data_keys (
  id ${t.id()} NOT NULL PRIMARY KEY,
  purpose ${t.id()} NOT NULL,
  wrap_kind TEXT NOT NULL CHECK (wrap_kind IN ('file-kek', 'passphrase', 'keyring', 'ctl-delivered')),
  wrap_params ${t.json()} NOT NULL,
  wrapped ${t.bytes()} NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'retired')),
  created_at ${t.epochMs()} NOT NULL,
  retired_at ${t.epochMs()}
)`);
    await db.execute(
      `CREATE UNIQUE INDEX data_keys_one_active ON data_keys (purpose) WHERE state = 'active'`,
    );
    await db.execute(
      'CREATE INDEX data_keys_purpose ON data_keys (purpose, created_at)',
    );
  },
};
