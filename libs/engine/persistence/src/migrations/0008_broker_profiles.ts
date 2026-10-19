import type { Migration } from '../migrate/types';

// The cache of probed BrokerProfiles (M0-45, blueprint 6.2 `broker_profiles`): one row per
// connection, replaced by every probe. `profile` is the BrokerProfile as JSON (svc-capabilities owns
// and validates it); `fingerprint` and `verification` are copied out so a plan can be checked against
// the fingerprint, and a list filtered by how far a build is verified, without parsing the document.
// A profile holds no secret: it is what a broker said about itself. There is no foreign key: the
// connection store deletes the profile row with the connection, in one transaction.
export const migration0008BrokerProfiles: Migration = {
  id: '0008_broker_profiles',
  up: async (db) => {
    const { t } = db;

    await db.execute(`CREATE TABLE broker_profiles (
  connection_id ${t.id()} NOT NULL PRIMARY KEY,
  fingerprint ${t.id()} NOT NULL,
  verification TEXT NOT NULL,
  probed_at ${t.epochMs()} NOT NULL,
  profile ${t.json()} NOT NULL
)`);
  },
};
