import type { Migration } from '../migrate/types';

// Plans and idempotency keys for the ActionExecutor (M0-29, blueprint 5.1 and 6.2). A plan row holds
// the bound fields in the clear and the input plus the sensitive payload as one ciphertext
// (`payload`, AES-256-GCM with AAD plans:payload:<id>, purged on expiry, rejection and execution).
// `version` is the compare-and-set token. Approvals are a JSON column of the plan for now
// (OQ-226); `gates`, `warnings` and `preview` are canonical JSON text written by the kernel.
export const migration0002Plans: Migration = {
  id: '0002_plans',
  up: async (db) => {
    const { t } = db;

    await db.execute(`CREATE TABLE plans (
  id ${t.id()} NOT NULL PRIMARY KEY,
  action_id ${t.id()} NOT NULL,
  input_hash ${t.id()} NOT NULL,
  digest ${t.id()} NOT NULL,
  principal_id ${t.id()} NOT NULL,
  on_behalf_of_id ${t.id()},
  profile_fingerprint ${t.id()},
  env TEXT NOT NULL,
  risk TEXT NOT NULL,
  state TEXT NOT NULL,
  approvals_required INTEGER NOT NULL,
  approvals ${t.json()} NOT NULL,
  gates ${t.json()} NOT NULL,
  warnings ${t.json()} NOT NULL,
  consents_required ${t.json()} NOT NULL,
  confirmation_phrase TEXT,
  preview ${t.json()} NOT NULL,
  payload ${t.bytes()},
  expires_at ${t.epochMs()} NOT NULL,
  created_at ${t.epochMs()} NOT NULL,
  updated_at ${t.epochMs()} NOT NULL,
  version INTEGER NOT NULL
)`);
    await db.execute(
      'CREATE INDEX plans_principal_state ON plans (principal_id, state, expires_at)',
    );
    await db.execute('CREATE INDEX plans_expiry ON plans (state, expires_at)');
    await db.execute('CREATE INDEX plans_retention ON plans (updated_at)');

    await db.execute(`CREATE TABLE idempotency_keys (
  principal_id ${t.id()} NOT NULL,
  key ${t.id()} NOT NULL,
  action_id ${t.id()} NOT NULL,
  plan_id ${t.id()},
  created_at ${t.epochMs()} NOT NULL,
  PRIMARY KEY (principal_id, key)
)`);
    await db.execute(
      'CREATE INDEX idempotency_keys_created ON idempotency_keys (created_at)',
    );
  },
};
