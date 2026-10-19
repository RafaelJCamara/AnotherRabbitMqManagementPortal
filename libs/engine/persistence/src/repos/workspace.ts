import type {
  SavedViewRecord,
  WorkspaceDocumentKind,
  WorkspaceRepository,
} from '@app/ports';
import type { Kysely, Selectable } from 'kysely';

import type { Database, ViewsTable } from '../database';
import { clampLimit, parseJson } from './settings';

const DEFAULT_VIEW_LIMIT = 100;

function toView(row: Selectable<ViewsTable>): SavedViewRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    kind: row.kind,
    definition: parseJson(row.definition),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Layouts, settings and keybindings are documents of the `settings` table, one scope per owner and kind. */
function scopeOf(kind: WorkspaceDocumentKind, ownerId: string): string {
  return `workspace.${kind}:${ownerId}`;
}

export function createWorkspaceRepository(
  db: Kysely<Database>,
  now: () => number,
): WorkspaceRepository {
  return {
    async listViews(ownerId, query) {
      const limit = clampLimit(query.limit, DEFAULT_VIEW_LIMIT);
      let select = db
        .selectFrom('views')
        .selectAll()
        .where('owner_id', '=', ownerId);
      if (query.kind !== undefined) {
        select = select.where('kind', '=', query.kind);
      }
      if (query.cursor !== undefined) {
        select = select.where('id', '>', query.cursor);
      }
      // One row more than asked tells whether there is another window.
      const rows = await select
        .orderBy('id')
        .limit(limit + 1)
        .execute();
      const page = rows.slice(0, limit).map(toView);
      const last = page.at(-1);
      return rows.length > limit && last !== undefined
        ? { items: page, nextCursor: last.id }
        : { items: page };
    },

    async countViews(ownerId) {
      const row = await db
        .selectFrom('views')
        .select((builder) => builder.fn.countAll<number | string>().as('n'))
        .where('owner_id', '=', ownerId)
        .executeTakeFirstOrThrow();
      return Number(row.n);
    },

    async insertView(view) {
      await db
        .insertInto('views')
        .values({
          id: view.id,
          owner_id: view.ownerId,
          kind: view.kind,
          name: view.name,
          definition: JSON.stringify(view.definition),
          created_at: view.createdAt,
          updated_at: view.updatedAt,
        })
        .execute();
    },

    async deleteView(ownerId, id) {
      const result = await db
        .deleteFrom('views')
        .where('owner_id', '=', ownerId)
        .where('id', '=', id)
        .executeTakeFirst();
      return result.numDeletedRows > 0n;
    },

    async getDocument(ownerId, kind, key) {
      const row = await db
        .selectFrom('settings')
        .select(['value', 'updated_at'])
        .where('scope', '=', scopeOf(kind, ownerId))
        .where('key', '=', key)
        .executeTakeFirst();
      return row === undefined
        ? undefined
        : { key, value: parseJson(row.value), updatedAt: row.updated_at };
    },

    async putDocument(ownerId, kind, key, value) {
      const text = JSON.stringify(value);
      const updatedAt = now();
      await db
        .insertInto('settings')
        .values({
          scope: scopeOf(kind, ownerId),
          key,
          value: text,
          updated_at: updatedAt,
        })
        .onConflict((conflict) =>
          conflict
            .columns(['scope', 'key'])
            .doUpdateSet({ value: text, updated_at: updatedAt }),
        )
        .execute();
    },

    async listDocuments(ownerId, kind, limit) {
      const rows = await db
        .selectFrom('settings')
        .select(['key', 'value', 'updated_at'])
        .where('scope', '=', scopeOf(kind, ownerId))
        .orderBy('key')
        .limit(clampLimit(limit, DEFAULT_VIEW_LIMIT))
        .execute();
      return rows.map((row) => ({
        key: row.key,
        value: parseJson(row.value),
        updatedAt: row.updated_at,
      }));
    },
  };
}
