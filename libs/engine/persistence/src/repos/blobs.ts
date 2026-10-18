import { createHash } from 'node:crypto';

import type { Kysely } from 'kysely';

import type { Database } from '../database';
import type { BlobRepository } from './ports';

export function createBlobRepository(
  db: Kysely<Database>,
  now: () => number,
): BlobRepository {
  return {
    put: (body) => {
      const sha256 = createHash('sha256').update(body).digest('hex');
      return db.transaction().execute(async (trx) => {
        await trx
          .insertInto('blobs')
          .values({
            sha256,
            body,
            size: body.byteLength,
            refcount: 0,
            created_at: now(),
          })
          .onConflict((conflict) => conflict.column('sha256').doNothing())
          .execute();
        const row = await trx
          .updateTable('blobs')
          .set((eb) => ({ refcount: eb('refcount', '+', 1) }))
          .where('sha256', '=', sha256)
          .returning('refcount')
          .executeTakeFirstOrThrow();
        return { sha256, refcount: row.refcount };
      });
    },

    async get(sha256) {
      const row = await db
        .selectFrom('blobs')
        .select('body')
        .where('sha256', '=', sha256)
        .executeTakeFirst();
      // pg returns a Buffer and node:sqlite a Uint8Array: hand out a plain Uint8Array either way.
      return row === undefined ? undefined : Uint8Array.from(row.body);
    },

    release: (sha256) =>
      db.transaction().execute(async (trx) => {
        const row = await trx
          .updateTable('blobs')
          .set((eb) => ({ refcount: eb('refcount', '-', 1) }))
          .where('sha256', '=', sha256)
          .returning('refcount')
          .executeTakeFirst();
        if (row === undefined) return undefined;
        if (row.refcount <= 0) {
          await trx.deleteFrom('blobs').where('sha256', '=', sha256).execute();
          return 0;
        }
        return row.refcount;
      }),
  };
}
