import type { Migration } from '../migrate/types';

// The non-secret settings of a credential provider (M1-23, OQ-1455, ADR-036): the token endpoint, the
// client id, the scope, the token command and its arguments, the claims that name the user. One row
// per (connection, protocol), the same key as `credentials` (0007), and the same protocols.
//
//   config       the provider config as JSON text. The owner of its schema, svc-identity, validates it
//                on every read; this table never decides what it means. It holds no secret: the
//                password, the token or the client secret stays in the profile's sealed `credentials`
//                row, and nothing here can hold a secret in the open by design (no column for one).
//   updated_at   milliseconds since the epoch of the last write.
//
// There is no foreign key: the connection store deletes the profile, its credentials, its probed
// profile and these rows in one transaction, so both dialects behave the same whatever their
// foreign-key settings are (the rule of 0007 and 0008).
export const migration0012CredentialProviders: Migration = {
  id: '0012_credential_providers',
  up: async (db) => {
    const { t } = db;

    await db.execute(`CREATE TABLE credential_providers (
  connection_id ${t.id()} NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('http', 'amqp')),
  config ${t.json()} NOT NULL,
  updated_at ${t.epochMs()} NOT NULL,
  PRIMARY KEY (connection_id, protocol)
)`);
  },
};
