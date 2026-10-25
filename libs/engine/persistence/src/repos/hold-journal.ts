// The Kysely implementation of the HoldJournalRepository port (M1-14, blueprint 5.5), for SQLite and
// Postgres. It stores what it is given: the queue name arrives sealed (ADR-014) and is never opened
// here. A row changes state only from `acquiring`, so a second settle or incident is refused.
import type {
  HoldJournalRepository,
  HoldOpen,
  InterruptedHold,
} from '@app/ports';
import type { Kysely } from 'kysely';

import type { Database } from '../database';

/** The longest list a single `listInterrupted` returns (I-7: bounded windows). */
export const MAX_INTERRUPTED_WINDOW = 200;

export function createHoldJournal(db: Kysely<Database>): HoldJournalRepository {
  async function leave(
    id: string,
    set: Partial<Database['hold_journal']>,
  ): Promise<void> {
    const result = await db
      .updateTable('hold_journal')
      .set(set)
      .where('id', '=', id)
      .where('state', '=', 'acquiring')
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1) {
      throw new Error(`hold ${id} is not acquiring; it cannot change state`);
    }
  }

  return {
    async open(hold: HoldOpen): Promise<void> {
      await db
        .insertInto('hold_journal')
        .values({
          id: hold.id,
          connection_id: hold.connectionId,
          vhost: hold.vhost,
          queue_sealed: hold.queueSealed,
          state: 'acquiring',
          returned: 0,
          reason: null,
          started_at: hold.startedAt,
          ended_at: null,
        })
        .execute();
    },

    async settle(id: string, returned: number, endedAt: number): Promise<void> {
      await leave(id, { state: 'settled', returned, ended_at: endedAt });
    },

    async markIncident(
      id: string,
      reason: string,
      endedAt: number,
    ): Promise<void> {
      await leave(id, { state: 'incident', reason, ended_at: endedAt });
    },

    async listInterrupted(limit: number): Promise<readonly InterruptedHold[]> {
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > MAX_INTERRUPTED_WINDOW
      ) {
        throw new RangeError(
          `limit must be an integer from 1 to ${String(MAX_INTERRUPTED_WINDOW)}`,
        );
      }
      const rows = await db
        .selectFrom('hold_journal')
        .select(['id', 'connection_id', 'vhost'])
        .where('state', '=', 'acquiring')
        .orderBy('started_at', 'asc')
        .orderBy('id', 'asc')
        .limit(limit)
        .execute();
      return rows.map((row) => ({
        id: row.id,
        connectionId: row.connection_id,
        vhost: row.vhost,
      }));
    },
  };
}
