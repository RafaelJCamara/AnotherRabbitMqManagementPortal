// The Kysely implementation of the DataKeyRepository port of @app/ports (M0-22). It stores what a
// key wrap returned and nothing else: the cryptography is @app/secrets'. A row never holds a data key
// in the open (0004_data_keys).
import type { DataKeyRecord, DataKeyRepository } from '@app/ports';
import type { Kysely, Selectable } from 'kysely';

import type { DataKeysTable, Database } from '../database';

/** The most keys one `list` returns: a vault holds a handful (I-7). */
export const MAX_DATA_KEYS = 100;

function toRecord(row: Selectable<DataKeysTable>): DataKeyRecord {
  return {
    id: row.id,
    purpose: row.purpose,
    wrapKind: row.wrap_kind,
    wrapParamsJson: row.wrap_params,
    // pg returns a Buffer and node:sqlite a Uint8Array: hand out a plain Uint8Array either way.
    wrapped: Uint8Array.from(row.wrapped),
    state: row.state,
    createdAt: row.created_at,
    retiredAt: row.retired_at,
  };
}

export function createDataKeyRepository(
  db: Kysely<Database>,
): DataKeyRepository {
  return {
    async insert(record) {
      // ON CONFLICT DO NOTHING covers both keys: the id, and "one active key per purpose" (the
      // partial unique index). A writer that lost the race inserts nothing and is told so.
      const result = await db
        .insertInto('data_keys')
        .values({
          id: record.id,
          purpose: record.purpose,
          wrap_kind: record.wrapKind,
          wrap_params: record.wrapParamsJson,
          wrapped: record.wrapped,
          state: record.state,
          created_at: record.createdAt,
          retired_at: record.retiredAt,
        })
        .onConflict((conflict) => conflict.doNothing())
        .executeTakeFirst();
      return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
    },

    async get(id) {
      const row = await db
        .selectFrom('data_keys')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row === undefined ? undefined : toRecord(row);
    },

    async list(purpose) {
      const rows = await db
        .selectFrom('data_keys')
        .selectAll()
        .where('purpose', '=', purpose)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'asc')
        .limit(MAX_DATA_KEYS)
        .execute();
      return rows.map(toRecord);
    },

    async retire(id, now) {
      const result = await db
        .updateTable('data_keys')
        .set({ state: 'retired', retired_at: now })
        .where('id', '=', id)
        .where('state', '=', 'active')
        .executeTakeFirst();
      return result.numUpdatedRows > 0n;
    },
  };
}
