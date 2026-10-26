// The publish history repository contract (M1-19): the same tests run on every dialect (SQLite unit
// tests, SQLite and Postgres 16 and 18 integration tests). Test-only; excluded from the library build.
import {
  PUBLISH_HISTORY_MAX_PURGE,
  PUBLISH_HISTORY_MAX_SEALED_BYTES,
  PUBLISH_HISTORY_MAX_WINDOW,
  type NewPublishHistory,
  type PublishHistoryRepository,
} from '@app/ports';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { PersistenceHandle } from '../database';
import { createRepositories } from '../repos';

export interface PublishHistoryContractOptions {
  /** Prefix of every test name, for example `sqlite (in memory)`. */
  name: string;
  /** Opens a database that already has the migrations applied. */
  open: () => Promise<PersistenceHandle>;
}

const OWNER = 'user-1';
const OTHER = 'user-2';
const CONN = 'conn-1';
const NOW = 1_000_000;

/** The id of the n-th row: fixed width, so string order is numeric order. */
export function historyId(n: number): string {
  return `P${String(n).padStart(6, '0')}`;
}

export function newEntry(
  id: string,
  over: Partial<NewPublishHistory> = {},
): NewPublishHistory {
  return {
    id,
    ownerId: OWNER,
    connectionId: CONN,
    vhost: '/',
    at: 10_000,
    expiresAt: NOW + 10_000,
    exchange: 'orders',
    routingKey: 'orders.created',
    copies: 1,
    summary: '{"confirmed":1}',
    bodyBytes: 12,
    bodySha256: 'a'.repeat(64),
    dataSealed: new Uint8Array([1, 2, 3, 4]),
    ...over,
  };
}

export function publishHistoryContract(
  options: PublishHistoryContractOptions,
): void {
  describe(`M1-19 AC-18 the publish history repository contract (publish_history, ${options.name})`, () => {
    let handle: PersistenceHandle;
    let repo: PublishHistoryRepository;

    beforeAll(async () => {
      handle = await options.open();
      repo = createRepositories(handle).publishHistory;
    });

    afterAll(async () => {
      await handle.close();
    });

    beforeEach(async () => {
      await handle.db.deleteFrom('publish_history').execute();
    });

    const idsOf = async (
      query: Partial<Parameters<PublishHistoryRepository['window']>[1]> = {},
      owner = OWNER,
    ): Promise<string[]> =>
      (
        await repo.window(owner, {
          connectionId: CONN,
          now: NOW,
          limit: PUBLISH_HISTORY_MAX_WINDOW,
          ...query,
        })
      ).rows.map((row) => row.id);

    it('stores a row and gives back every field, with the sealed bytes exactly as given', async () => {
      const sealed = Uint8Array.from({ length: 256 }, (_, i) => i);
      await repo.insert(
        newEntry('p-1', {
          vhost: 'v/é',
          exchange: '',
          routingKey: 'q.😀',
          copies: 3,
          summary: '{"confirmed":2,"returned":1}',
          bodyBytes: 0,
          dataSealed: sealed,
        }),
      );

      const row = await repo.get(OWNER, CONN, 'p-1');

      expect(row).toBeDefined();
      expect({ ...row, dataSealed: undefined }).toEqual({
        id: 'p-1',
        ownerId: OWNER,
        connectionId: CONN,
        vhost: 'v/é',
        at: 10_000,
        expiresAt: NOW + 10_000,
        exchange: '',
        routingKey: 'q.😀',
        copies: 3,
        summary: '{"confirmed":2,"returned":1}',
        bodyBytes: 0,
        bodySha256: 'a'.repeat(64),
        dataSealed: undefined,
      });
      expect(Array.from(row?.dataSealed ?? [])).toEqual(Array.from(sealed));
    });

    it('refuses a second row with the same id, a document over the limit and a count out of range', async () => {
      await repo.insert(newEntry('p-1'));

      await expect(repo.insert(newEntry('p-1'))).rejects.toThrow();
      await expect(
        repo.insert(
          newEntry('p-2', {
            dataSealed: new Uint8Array(PUBLISH_HISTORY_MAX_SEALED_BYTES + 1),
          }),
        ),
      ).rejects.toThrow(RangeError);
      await expect(repo.insert(newEntry('p-3', { copies: 0 }))).rejects.toThrow(
        RangeError,
      );
      await expect(
        repo.insert(newEntry('p-4', { bodyBytes: -1 })),
      ).rejects.toThrow(RangeError);
      await repo.insert(
        newEntry('p-5', {
          dataSealed: new Uint8Array(PUBLISH_HISTORY_MAX_SEALED_BYTES),
        }),
      );

      expect(await idsOf()).toEqual(['p-5', 'p-1']);
    });

    it('answers undefined for another owner, another connection and an unknown id alike', async () => {
      await repo.insert(newEntry('p-1'));

      expect(await repo.get(OWNER, CONN, 'p-1')).toBeDefined();
      expect(await repo.get(OTHER, CONN, 'p-1')).toBeUndefined();
      expect(await repo.get(OWNER, 'conn-2', 'p-1')).toBeUndefined();
      expect(await repo.get(OWNER, CONN, 'p-unknown')).toBeUndefined();
    });

    it('orders a window by time then id, newest first, and holds no sealed bytes', async () => {
      await repo.insert(newEntry('b', { at: 200 }));
      await repo.insert(newEntry('a', { at: 200 }));
      await repo.insert(newEntry('c', { at: 100 }));
      await repo.insert(newEntry('d', { at: 300 }));

      const { rows } = await repo.window(OWNER, {
        connectionId: CONN,
        now: NOW,
        limit: 10,
      });

      expect(rows.map((row) => row.id)).toEqual(['d', 'b', 'a', 'c']);
      expect(rows.map((row) => row.at)).toEqual([300, 200, 200, 100]);
      expect(rows[0]).not.toHaveProperty('dataSealed');
      expect(rows[0]).toMatchObject({
        ownerId: OWNER,
        connectionId: CONN,
        copies: 1,
        bodyBytes: 12,
      });
    });

    it('pages 120 rows in bounded keyset windows without a gap or a repeat', async () => {
      for (let n = 1; n <= 120; n += 1) {
        // Three rows share each time, so the id has to break the ties.
        await repo.insert(newEntry(historyId(n), { at: 1_000 + (n % 40) }));
      }
      await repo.insert(newEntry('other-owner', { ownerId: OTHER, at: 5_000 }));
      await repo.insert(
        newEntry('other-conn', { connectionId: 'conn-2', at: 5_000 }),
      );

      const seen: string[] = [];
      let cursor: string | undefined;
      let windows = 0;
      do {
        const page = await repo.window(OWNER, {
          connectionId: CONN,
          now: NOW,
          limit: 50,
          ...(cursor === undefined ? {} : { cursor }),
        });
        expect(page.rows.length).toBeLessThanOrEqual(50);
        seen.push(...page.rows.map((row) => row.id));
        cursor = page.nextCursor;
        windows += 1;
      } while (cursor !== undefined);

      expect(windows).toBe(3);
      expect(seen).toHaveLength(120);
      expect(new Set(seen).size).toBe(120);
      const expected = Array.from({ length: 120 }, (_, i) => i + 1)
        .sort((x, y) => (y % 40) - (x % 40) || y - x)
        .map(historyId);
      expect(seen).toEqual(expected);
    });

    it('gives no cursor when the rows end exactly at the limit', async () => {
      await repo.insert(newEntry('p-1', { at: 1 }));
      await repo.insert(newEntry('p-2', { at: 2 }));

      const exact = await repo.window(OWNER, {
        connectionId: CONN,
        now: NOW,
        limit: 2,
      });
      const short = await repo.window(OWNER, {
        connectionId: CONN,
        now: NOW,
        limit: 1,
      });

      expect(exact.nextCursor).toBeUndefined();
      expect(short.rows.map((row) => row.id)).toEqual(['p-2']);
      expect(short.nextCursor).toBeDefined();
    });

    it('filters by vhost, exchange, routing-key prefix and an inclusive time range', async () => {
      await repo.insert(
        newEntry('p-1', { at: 100, vhost: '/', routingKey: 'orders.created' }),
      );
      await repo.insert(
        newEntry('p-2', { at: 200, vhost: 'v2', routingKey: 'orders.shipped' }),
      );
      await repo.insert(
        newEntry('p-3', {
          at: 300,
          exchange: 'billing',
          routingKey: 'Orders.paid',
        }),
      );
      await repo.insert(newEntry('p-4', { at: 400, routingKey: 'a_b' }));
      await repo.insert(newEntry('p-5', { at: 500, routingKey: 'axb' }));
      await repo.insert(newEntry('p-6', { at: 600, routingKey: 'a%b' }));
      await repo.insert(newEntry('p-7', { at: 700, routingKey: '😀.k' }));

      expect(await idsOf({ vhost: 'v2' })).toEqual(['p-2']);
      expect(await idsOf({ exchange: 'billing' })).toEqual(['p-3']);
      // Case-sensitive on both dialects.
      expect(await idsOf({ routingKeyPrefix: 'orders.' })).toEqual([
        'p-2',
        'p-1',
      ]);
      // Wildcard characters are plain characters.
      expect(await idsOf({ routingKeyPrefix: 'a_' })).toEqual(['p-4']);
      expect(await idsOf({ routingKeyPrefix: 'a%' })).toEqual(['p-6']);
      expect(await idsOf({ routingKeyPrefix: '😀' })).toEqual(['p-7']);
      expect(await idsOf({ routingKeyPrefix: '' })).toHaveLength(7);
      expect(await idsOf({ from: 200, to: 400 })).toEqual([
        'p-4',
        'p-3',
        'p-2',
      ]);
      expect(await idsOf({ from: 201, to: 399 })).toEqual(['p-3']);
    });

    it('never returns a row that expired at or before now, purged or not', async () => {
      await repo.insert(newEntry('live', { expiresAt: NOW + 1 }));
      await repo.insert(newEntry('edge', { expiresAt: NOW }));
      await repo.insert(newEntry('old', { expiresAt: NOW - 1 }));

      expect(await idsOf()).toEqual(['live']);
      // `get` hands the row over; the expiry is the caller's check, and the row says when.
      expect((await repo.get(OWNER, CONN, 'edge'))?.expiresAt).toBe(NOW);
    });

    it('refuses a window that is not a window', async () => {
      const base = { connectionId: CONN, now: NOW };

      await expect(repo.window(OWNER, { ...base, limit: 0 })).rejects.toThrow(
        RangeError,
      );
      await expect(
        repo.window(OWNER, {
          ...base,
          limit: PUBLISH_HISTORY_MAX_WINDOW + 1,
        }),
      ).rejects.toThrow(RangeError);
      await expect(repo.window(OWNER, { ...base, limit: 1.5 })).rejects.toThrow(
        RangeError,
      );
      await expect(
        repo.window(OWNER, { ...base, limit: 10, cursor: 'not a cursor' }),
      ).rejects.toThrow(RangeError);
    });

    it('purges expired rows oldest first, at most the limit, boundary included', async () => {
      // The oldest rows have the highest ids, so only the expiry ordering picks them (not the id).
      await repo.insert(newEntry('e-1', { expiresAt: NOW }));
      await repo.insert(newEntry('e-2', { expiresAt: NOW - 10 }));
      await repo.insert(newEntry('e-3', { expiresAt: NOW - 20 }));
      await repo.insert(newEntry('e-4', { expiresAt: NOW - 30 }));
      await repo.insert(newEntry('keep', { expiresAt: NOW + 1 }));
      await repo.insert(
        newEntry('keep-other', { ownerId: OTHER, expiresAt: NOW + 1 }),
      );

      expect(await repo.purgeExpired(NOW, 2)).toBe(2);
      expect(await repo.get(OWNER, CONN, 'e-4')).toBeUndefined();
      expect(await repo.get(OWNER, CONN, 'e-3')).toBeUndefined();
      expect(await repo.get(OWNER, CONN, 'e-2')).toBeDefined();

      expect(await repo.purgeExpired(NOW, 10)).toBe(2);
      expect(await repo.get(OWNER, CONN, 'e-1')).toBeUndefined();
      expect(await repo.purgeExpired(NOW, 10)).toBe(0);
      expect(await idsOf({}, OWNER)).toEqual(['keep']);
      expect(await idsOf({}, OTHER)).toEqual(['keep-other']);
    });

    it('purges up to the largest allowed batch and refuses a limit outside 1 to that batch', async () => {
      await expect(repo.purgeExpired(NOW, 0)).rejects.toThrow(RangeError);
      await expect(
        repo.purgeExpired(NOW, PUBLISH_HISTORY_MAX_PURGE + 1),
      ).rejects.toThrow(RangeError);
      await expect(repo.purgeExpired(NOW, 1.5)).rejects.toThrow(RangeError);

      await repo.insert(newEntry('e-1', { expiresAt: NOW - 1 }));
      expect(await repo.purgeExpired(NOW, PUBLISH_HISTORY_MAX_PURGE)).toBe(1);
    });
  });
}
