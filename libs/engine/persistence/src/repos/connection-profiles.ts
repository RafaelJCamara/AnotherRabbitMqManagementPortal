import type { Kysely, Selectable } from 'kysely';

import type { ConnectionProfilesTable, Database } from '../database';
import type {
  ConnectionProfileInput,
  ConnectionProfileRecord,
  ConnectionProfileRepository,
  ConnectionVisibility,
} from './ports';
import { clampLimit, parseJson } from './settings';

const DEFAULT_LIMIT = 100;

export function toRecord(
  row: Selectable<ConnectionProfilesTable>,
): ConnectionProfileRecord {
  return {
    id: row.id,
    name: row.name,
    envClass: row.env_class,
    color: row.color,
    config: parseJson(row.config),
    ownerId: row.owner_id,
    visibility: row.visibility as ConnectionVisibility,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createConnectionProfileRepository(
  db: Kysely<Database>,
  now: () => number,
): ConnectionProfileRepository {
  const get = async (
    id: string,
  ): Promise<ConnectionProfileRecord | undefined> => {
    const row = await db
      .selectFrom('connection_profiles')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  };

  return {
    get,

    async save(profile: ConnectionProfileInput) {
      const at = now();
      const fields = {
        name: profile.name,
        env_class: profile.envClass,
        color: profile.color,
        config: JSON.stringify(profile.config),
        owner_id: profile.ownerId,
        visibility: profile.visibility,
        updated_at: at,
      };
      // created_at is absent from the update set, so a replace keeps the original.
      await db
        .insertInto('connection_profiles')
        .values({ id: profile.id, created_at: at, ...fields })
        .onConflict((conflict) => conflict.column('id').doUpdateSet(fields))
        .execute();
      const saved = await get(profile.id);
      if (saved === undefined) {
        throw new Error(
          `Connection profile ${profile.id} vanished after save.`,
        );
      }
      return saved;
    },

    async delete(id) {
      const result = await db
        .deleteFrom('connection_profiles')
        .where('id', '=', id)
        .executeTakeFirst();
      return result.numDeletedRows > 0n;
    },

    async list(page = {}) {
      let query = db.selectFrom('connection_profiles').selectAll();
      if (page.afterId !== undefined) {
        query = query.where('id', '>', page.afterId);
      }
      const rows = await query
        .orderBy('id')
        .limit(clampLimit(page.limit, DEFAULT_LIMIT))
        .execute();
      return rows.map(toRecord);
    },
  };
}
