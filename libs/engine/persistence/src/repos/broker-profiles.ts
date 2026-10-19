// The Kysely implementation of the BrokerProfileStore port of @app/ports (M0-45): the cache of probed
// BrokerProfiles in `broker_profiles` (0008_broker_profiles). The document is opaque here;
// svc-capabilities validates it on every read.
import type { BrokerProfileStore } from '@app/ports';
import type { Kysely } from 'kysely';

import type { Database } from '../database';
import { parseJson } from './settings';

export function createBrokerProfileStore(
  db: Kysely<Database>,
): BrokerProfileStore {
  return {
    async get(connectionId) {
      const row = await db
        .selectFrom('broker_profiles')
        .selectAll()
        .where('connection_id', '=', connectionId)
        .executeTakeFirst();
      return row === undefined
        ? undefined
        : {
            connectionId: row.connection_id,
            fingerprint: row.fingerprint,
            verification: row.verification,
            probedAt: row.probed_at,
            profile: parseJson(row.profile),
          };
    },

    async put(record) {
      const profile = JSON.stringify(record.profile);
      await db
        .insertInto('broker_profiles')
        .values({
          connection_id: record.connectionId,
          fingerprint: record.fingerprint,
          verification: record.verification,
          probed_at: record.probedAt,
          profile,
        })
        .onConflict((conflict) =>
          conflict.column('connection_id').doUpdateSet({
            fingerprint: record.fingerprint,
            verification: record.verification,
            probed_at: record.probedAt,
            profile,
          }),
        )
        .execute();
    },

    async delete(connectionId) {
      const result = await db
        .deleteFrom('broker_profiles')
        .where('connection_id', '=', connectionId)
        .executeTakeFirst();
      return result.numDeletedRows > 0n;
    },
  };
}
