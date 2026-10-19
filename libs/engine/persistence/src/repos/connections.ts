// The Kysely implementation of the ConnectionStore port of @app/ports (M0-44): a profile row of
// `connection_profiles` and its sealed secrets in `credentials` (0007_credentials), changed in one
// transaction. The cryptography is @app/secrets'; a row here is ciphertext and nothing else.
import type {
  ConnectionInput,
  ConnectionStore,
  CredentialChange,
  CredentialProtocol,
} from '@app/ports';
import type { ExpressionBuilder, Kysely } from 'kysely';

import type { Database } from '../database';
import {
  createConnectionProfileRepository,
  toRecord,
} from './connection-profiles';
import type { JsonValue } from './ports';
import { clampLimit } from './settings';

const DEFAULT_LIMIT = 100;

/** The protocols a profile has a credential for: the table's CHECK constraint says the same. */
const PROTOCOLS: readonly CredentialProtocol[] = ['http', 'amqp'];

export function createConnectionStore(
  db: Kysely<Database>,
  now: () => number,
): ConnectionStore {
  const visible =
    (visibleTo: string) =>
    (eb: ExpressionBuilder<Database, 'connection_profiles'>) =>
      eb.or([eb('visibility', '=', 'team'), eb('owner_id', '=', visibleTo)]);

  return {
    get: (id) => createConnectionProfileRepository(db, now).get(id),

    async save(profile: ConnectionInput, credentials?: CredentialChange) {
      return db.transaction().execute(async (trx) => {
        const saved = await createConnectionProfileRepository(trx, now).save({
          ...profile,
          config: profile.config as JsonValue,
        });
        const at = now();
        for (const protocol of PROTOCOLS) {
          const ciphertext = credentials?.put?.[protocol];
          if (ciphertext !== undefined) {
            await trx
              .insertInto('credentials')
              .values({
                connection_id: profile.id,
                protocol,
                ciphertext,
                updated_at: at,
              })
              .onConflict((conflict) =>
                conflict
                  .columns(['connection_id', 'protocol'])
                  .doUpdateSet({ ciphertext, updated_at: at }),
              )
              .execute();
          } else if (credentials?.remove?.includes(protocol) === true) {
            await trx
              .deleteFrom('credentials')
              .where('connection_id', '=', profile.id)
              .where('protocol', '=', protocol)
              .execute();
          }
        }
        return saved;
      });
    },

    delete(id) {
      return db.transaction().execute(async (trx) => {
        await trx
          .deleteFrom('credentials')
          .where('connection_id', '=', id)
          .execute();
        // The probed profile is the cache of what this connection's broker said (0008).
        await trx
          .deleteFrom('broker_profiles')
          .where('connection_id', '=', id)
          .execute();
        const result = await trx
          .deleteFrom('connection_profiles')
          .where('id', '=', id)
          .executeTakeFirst();
        return result.numDeletedRows > 0n;
      });
    },

    async list(query) {
      const limit = clampLimit(query.limit, DEFAULT_LIMIT);
      let select = db
        .selectFrom('connection_profiles')
        .selectAll()
        .where(visible(query.visibleTo));
      if (query.cursor !== undefined) {
        select = select.where('id', '>', query.cursor);
      }
      // One row more than asked tells whether there is another window.
      const rows = await select
        .orderBy('id')
        .limit(limit + 1)
        .execute();
      const page = rows.slice(0, limit).map(toRecord);
      const last = page.at(-1);
      return rows.length > limit && last !== undefined
        ? { items: page, nextCursor: last.id }
        : { items: page };
    },

    async count(visibleTo) {
      const row = await db
        .selectFrom('connection_profiles')
        .select((builder) => builder.fn.countAll<number | string>().as('n'))
        .where(visible(visibleTo))
        .executeTakeFirstOrThrow();
      return Number(row.n);
    },

    async credentials(id) {
      const rows = await db
        .selectFrom('credentials')
        .selectAll()
        .where('connection_id', '=', id)
        .orderBy('protocol')
        .execute();
      return rows.map((row) => ({
        protocol: row.protocol,
        // pg returns a Buffer and node:sqlite a Uint8Array: hand out a plain Uint8Array either way.
        ciphertext: Uint8Array.from(row.ciphertext),
        updatedAt: row.updated_at,
      }));
    },
  };
}
