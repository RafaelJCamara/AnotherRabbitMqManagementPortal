import type { Kysely } from 'kysely';

import type { Database } from '../database';
import type { JsonValue, SettingsRepository } from './ports';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/** Page sizes are clamped, never unbounded (I-7). */
export function clampLimit(
  limit: number | undefined,
  fallback: number,
): number {
  return Math.min(Math.max(Math.trunc(limit ?? fallback), 1), MAX_LIMIT);
}

export function parseJson(text: string): JsonValue {
  return JSON.parse(text) as JsonValue;
}

export function createSettingsRepository(
  db: Kysely<Database>,
  now: () => number,
): SettingsRepository {
  return {
    async get(scope, key) {
      const row = await db
        .selectFrom('settings')
        .select('value')
        .where('scope', '=', scope)
        .where('key', '=', key)
        .executeTakeFirst();
      return row === undefined ? undefined : parseJson(row.value);
    },

    async set(scope, key, value) {
      const text = JSON.stringify(value);
      const updatedAt = now();
      await db
        .insertInto('settings')
        .values({ scope, key, value: text, updated_at: updatedAt })
        .onConflict((conflict) =>
          conflict
            .columns(['scope', 'key'])
            .doUpdateSet({ value: text, updated_at: updatedAt }),
        )
        .execute();
    },

    async delete(scope, key) {
      const result = await db
        .deleteFrom('settings')
        .where('scope', '=', scope)
        .where('key', '=', key)
        .executeTakeFirst();
      return result.numDeletedRows > 0n;
    },

    async list(scope, page = {}) {
      let query = db
        .selectFrom('settings')
        .select(['key', 'value'])
        .where('scope', '=', scope);
      if (page.afterKey !== undefined) {
        query = query.where('key', '>', page.afterKey);
      }
      const rows = await query
        .orderBy('key')
        .limit(clampLimit(page.limit, DEFAULT_LIMIT))
        .execute();
      return rows.map((row) => ({ key: row.key, value: parseJson(row.value) }));
    },
  };
}
