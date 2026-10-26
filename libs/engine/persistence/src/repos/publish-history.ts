// The Kysely implementation of the PublishHistoryRepository port of @app/ports (M1-19), for SQLite
// and Postgres. It stores what it is given: the properties, headers and body arrive masked and
// sealed in one document (ADR-014) and are never opened here (I-10). Every read is bounded: a window
// is a keyset page of at most PUBLISH_HISTORY_MAX_WINDOW rows ordered by (published_at, id)
// descending and carries no sealed bytes, a purge removes at most PUBLISH_HISTORY_MAX_PURGE rows
// (I-6, I-7). A row of another owner or connection is simply not found.
import {
  PUBLISH_HISTORY_MAX_PURGE,
  PUBLISH_HISTORY_MAX_SEALED_BYTES,
  PUBLISH_HISTORY_MAX_WINDOW,
  type NewPublishHistory,
  type PublishHistoryHead,
  type PublishHistoryQuery,
  type PublishHistoryRepository,
  type PublishHistoryRow,
} from '@app/ports';
import { sql, type Kysely } from 'kysely';

import type { Database, PublishHistoryTable } from '../database';

const HEAD_COLUMNS = [
  'id',
  'owner_id',
  'connection_id',
  'vhost',
  'published_at',
  'expires_at',
  'exchange',
  'routing_key',
  'copies',
  'summary',
  'body_bytes',
  'body_sha256',
] as const;

type HeadRow = Pick<PublishHistoryTable, (typeof HEAD_COLUMNS)[number]>;

const toHead = (row: HeadRow): PublishHistoryHead => ({
  id: row.id,
  ownerId: row.owner_id,
  connectionId: row.connection_id,
  vhost: row.vhost,
  at: row.published_at,
  expiresAt: row.expires_at,
  exchange: row.exchange,
  routingKey: row.routing_key,
  copies: row.copies,
  summary: row.summary,
  bodyBytes: row.body_bytes,
  bodySha256: row.body_sha256,
});

/** A cursor is the last row's time and id: `<published_at>.<id>`. */
const CURSOR = /^(\d{1,16})\.(.+)$/s;

function parseCursor(cursor: string): { at: number; id: string } {
  const match = CURSOR.exec(cursor);
  if (match === null)
    throw new RangeError('The cursor is not a window cursor.');
  return { at: Number(match[1]), id: match[2] ?? '' };
}

function requireCount(name: string, value: number, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(
      `${name} must be a safe integer of at least ${String(min)}`,
    );
  }
}

function requireWindow(name: string, value: number, max: number): void {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${name} must be an integer from 1 to ${String(max)}`);
  }
}

export function createPublishHistory(
  db: Kysely<Database>,
): PublishHistoryRepository {
  return {
    async insert(row: NewPublishHistory): Promise<void> {
      requireCount('at', row.at, 0);
      requireCount('expiresAt', row.expiresAt, 0);
      requireCount('copies', row.copies, 1);
      requireCount('bodyBytes', row.bodyBytes, 0);
      if (row.dataSealed.byteLength > PUBLISH_HISTORY_MAX_SEALED_BYTES) {
        throw new RangeError(
          `The sealed document is over ${String(PUBLISH_HISTORY_MAX_SEALED_BYTES)} bytes.`,
        );
      }
      await db
        .insertInto('publish_history')
        .values({
          id: row.id,
          owner_id: row.ownerId,
          connection_id: row.connectionId,
          vhost: row.vhost,
          published_at: row.at,
          expires_at: row.expiresAt,
          exchange: row.exchange,
          routing_key: row.routingKey,
          copies: row.copies,
          summary: row.summary,
          body_bytes: row.bodyBytes,
          body_sha256: row.bodySha256,
          data_sealed: row.dataSealed,
        })
        .execute();
    },

    async window(ownerId: string, query: PublishHistoryQuery) {
      requireWindow('limit', query.limit, PUBLISH_HISTORY_MAX_WINDOW);
      let select = db
        .selectFrom('publish_history')
        .select(HEAD_COLUMNS)
        .where('owner_id', '=', ownerId)
        .where('connection_id', '=', query.connectionId)
        .where('expires_at', '>', query.now);
      if (query.vhost !== undefined)
        select = select.where('vhost', '=', query.vhost);
      if (query.exchange !== undefined)
        select = select.where('exchange', '=', query.exchange);
      if (
        query.routingKeyPrefix !== undefined &&
        query.routingKeyPrefix !== ''
      ) {
        // substr, not LIKE: LIKE ignores case on SQLite and honours it on Postgres, and a prefix
        // may hold wildcard characters. Both dialects count characters in substr.
        const prefix = query.routingKeyPrefix;
        select = select.where(
          sql<boolean>`substr(routing_key, 1, ${Array.from(prefix).length}) = ${prefix}`,
        );
      }
      if (query.from !== undefined)
        select = select.where('published_at', '>=', query.from);
      if (query.to !== undefined)
        select = select.where('published_at', '<=', query.to);
      if (query.cursor !== undefined) {
        const cursor = parseCursor(query.cursor);
        select = select.where((eb) =>
          eb.or([
            eb('published_at', '<', cursor.at),
            eb.and([
              eb('published_at', '=', cursor.at),
              eb('id', '<', cursor.id),
            ]),
          ]),
        );
      }
      const found = await select
        .orderBy('published_at', 'desc')
        .orderBy('id', 'desc')
        .limit(query.limit + 1)
        .execute();
      const rows = found.slice(0, query.limit).map(toHead);
      const last = rows.at(-1);
      return found.length > query.limit && last !== undefined
        ? { rows, nextCursor: `${String(last.at)}.${last.id}` }
        : { rows };
    },

    async get(
      ownerId: string,
      connectionId: string,
      id: string,
    ): Promise<PublishHistoryRow | undefined> {
      const row = await db
        .selectFrom('publish_history')
        .select([...HEAD_COLUMNS, 'data_sealed'])
        .where('id', '=', id)
        .where('owner_id', '=', ownerId)
        .where('connection_id', '=', connectionId)
        .executeTakeFirst();
      return row === undefined
        ? undefined
        : { ...toHead(row), dataSealed: row.data_sealed };
    },

    async purgeExpired(now: number, limit: number): Promise<number> {
      requireWindow('limit', limit, PUBLISH_HISTORY_MAX_PURGE);
      const result = await db
        .deleteFrom('publish_history')
        .where(
          'id',
          'in',
          db
            .selectFrom('publish_history')
            .select('id')
            .where('expires_at', '<=', now)
            .orderBy('expires_at')
            .orderBy('id')
            .limit(limit),
        )
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };
}
