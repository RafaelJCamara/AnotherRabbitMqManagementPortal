// The capture repository contract (M1-09): the same tests run on every dialect (SQLite unit tests,
// SQLite and Postgres 16 and 18 integration tests). Test-only; excluded from the library build.
import type {
  AppendLimits,
  CaptureRepository,
  NewCapture,
  NewMessage,
} from '@app/ports';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { PersistenceHandle } from '../database';
import { createRepositories } from '../repos';

export interface CaptureContractOptions {
  /** Prefix of every test name, for example `sqlite (in memory)`. */
  name: string;
  /** Opens a database that already has the migrations applied. */
  open: () => Promise<PersistenceHandle>;
  /**
   * The repository under test over that database. Defaults to the repository itself; the RPC spec
   * passes a client whose server runs over the same handle.
   */
  repository?: (handle: PersistenceHandle) => CaptureRepository;
}

const OWNER = 'user-1';
const OTHER = 'user-2';
const WIDE: AppendLimits = {
  ownerQuotaBytes: 1_000_000_000,
  captureMaxMessages: 100_000,
};

export function newCapture(
  id: string,
  over: Partial<NewCapture> = {},
): NewCapture {
  return {
    id,
    ownerId: OWNER,
    kind: 'manual',
    label: `capture ${id}`,
    target: '{"connection":"c1","queue":"orders"}',
    envClass: 'dev',
    indexBodies: true,
    createdAt: 1_000,
    expiresAt: 1_000_000,
    ...over,
  };
}

/** The id of the n-th message: fixed width, so string order is numeric order. */
export function messageId(n: number): string {
  return `M${String(n).padStart(8, '0')}`;
}

export function newMessage(
  n: number,
  over: Partial<NewMessage> = {},
): NewMessage {
  const sealed = new Uint8Array(64).fill(n % 251);
  return {
    id: messageId(n),
    receivedAt: 10_000 + n,
    exchange: n % 2 === 0 ? 'orders' : 'billing',
    routingKey: `orders.${n % 3 === 0 ? 'created' : 'shipped'}`,
    source: 'orders-queue',
    contentType: n % 4 === 0 ? 'text/plain' : 'application/json',
    redelivered: n % 5 === 0,
    size: 100 + n,
    bodySha256: n.toString(16).padStart(64, '0'),
    bodyState: 'inline',
    bodySealed: sealed,
    blob: null,
    metaSealed: sealed,
    metaText: `orders ${n % 3 === 0 ? 'created' : 'shipped'} queue${String(n % 7)}`,
    bodyText: `order number${String(n)} for ${n % 2 === 0 ? 'london' : 'paris'}`,
    ...over,
  };
}

/** A message whose body is a blob of `chunks` sealed chunks. */
export function blobMessage(
  n: number,
  ref: string,
  chunks: number,
): NewMessage {
  return newMessage(n, {
    bodyState: 'blob',
    bodySealed: null,
    bodyText: null,
    blob: {
      ref,
      size: chunks * 1000,
      chunkBytes: 1000,
      chunks: Array.from({ length: chunks }, (_, i) =>
        new Uint8Array(1016).fill((i + 1) % 251),
      ),
    },
  });
}

export function captureContract(options: CaptureContractOptions): void {
  describe(`${options.name} captures`, () => {
    let handle: PersistenceHandle;
    let repo: CaptureRepository;
    let clock = 1_000;

    beforeAll(async () => {
      handle = await options.open();
      repo =
        options.repository?.(handle) ??
        createRepositories(handle, { now: () => clock }).captures;
    });

    afterAll(async () => {
      await handle.close();
    });

    beforeEach(async () => {
      clock = 1_000;
      await handle.db.deleteFrom('captured_messages').execute();
      await handle.db.deleteFrom('capture_blob_chunks').execute();
      await handle.db.deleteFrom('capture_blobs').execute();
      await handle.db.deleteFrom('captures').execute();
      if (handle.dialect === 'sqlite' && (await repo.searchAvailable())) {
        await sql`DELETE FROM captured_fts`.execute(handle.db);
      }
    });

    const seed = async (
      count: number,
      id = 'cap-1',
      over: Partial<NewCapture> = {},
    ): Promise<void> => {
      await repo.createCapture(newCapture(id, over));
      for (let from = 1; from <= count; from += 400) {
        const messages: NewMessage[] = [];
        for (let n = from; n < Math.min(from + 400, count + 1); n += 1) {
          messages.push(newMessage(n));
        }
        await repo.appendMessages(
          { captureId: id, ownerId: over.ownerId ?? OWNER, messages },
          WIDE,
        );
      }
    };

    const ids = async (
      query: Partial<Parameters<CaptureRepository['queryMessages']>[1]>,
      ownerId = OWNER,
    ): Promise<string[]> => {
      const found: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 100; guard += 1) {
        const window = await repo.queryMessages(ownerId, {
          captureId: 'cap-1',
          order: 'asc',
          limit: 500,
          ...query,
          ...(cursor === undefined ? {} : { cursor }),
        });
        found.push(...window.items.map((m) => m.id));
        if (window.nextCursor === undefined) return found;
        cursor = window.nextCursor;
      }
      throw new Error('a query did not end');
    };

    it('M1-09 AC-10 stores a message and reads every plain column back, sealed bytes included', async () => {
      await repo.createCapture(newCapture('cap-1'));
      const message = newMessage(1);

      const result = await repo.appendMessages(
        { captureId: 'cap-1', ownerId: OWNER, messages: [message] },
        WIDE,
      );

      expect(result.stored).toBe(1);
      expect(result.rejected).toEqual([]);
      expect(result.storedBytes).toBeGreaterThan(300);
      expect(result.txnMs).toBeGreaterThanOrEqual(0);
      const stored = await repo.getMessage(OWNER, 'cap-1', messageId(1));
      expect(stored).toEqual({
        id: messageId(1),
        captureId: 'cap-1',
        receivedAt: 10_001,
        exchange: 'billing',
        routingKey: 'orders.shipped',
        source: 'orders-queue',
        contentType: 'application/json',
        redelivered: false,
        size: 101,
        bodySha256: message.bodySha256,
        bodyState: 'inline',
        blobRef: null,
        bodyIndexed: true,
        preview: 'order number1 for paris',
        bodySealed: message.bodySealed,
        metaSealed: message.metaSealed,
      });
      expect(
        await repo.getMessage(OTHER, 'cap-1', messageId(1)),
      ).toBeUndefined();
      expect(
        await repo.getMessage(OWNER, 'cap-2', messageId(1)),
      ).toBeUndefined();
      const capture = await repo.getCapture(OWNER, 'cap-1');
      expect(capture).toMatchObject({
        messages: 1,
        storedBytes: result.storedBytes,
        droppedQueue: 0,
        omittedBodies: 0,
      });
    });

    it('M1-09 AC-10 pages 1,200 messages exactly once, clamps the window and orders both ways', async () => {
      await seed(1200);

      const all = await ids({});
      expect(all).toHaveLength(1200);
      expect(all).toEqual([...all].sort());
      expect(new Set(all).size).toBe(1200);
      const first = await repo.queryMessages(OWNER, {
        captureId: 'cap-1',
        order: 'asc',
        limit: 1_000_000,
      });
      expect(first.items).toHaveLength(500);
      expect(first.nextCursor).toBe(messageId(500));
      const desc = await ids({ order: 'desc', limit: 100 });
      expect(desc).toEqual([...all].reverse());
      const none = await repo.queryMessages(OWNER, {
        captureId: 'cap-1',
        order: 'asc',
        limit: 0,
      });
      expect(none.items).toHaveLength(1);
    });

    it('M1-09 AC-10 combines metadata filters, and never shows a capture to another owner', async () => {
      await seed(1200);

      expect(await ids({ exchange: 'orders' })).toHaveLength(600);
      expect(await ids({ routingKey: 'orders.created' })).toHaveLength(400);
      expect(await ids({ contentType: 'text/plain' })).toHaveLength(300);
      expect(await ids({ redelivered: true })).toHaveLength(240);
      expect(await ids({ sizeMin: 1_000, sizeMax: 1_049 })).toHaveLength(50);
      expect(await ids({ from: 10_101, to: 10_111 })).toEqual(
        Array.from({ length: 10 }, (_, i) => messageId(101 + i)),
      );
      expect(
        await ids({
          exchange: 'orders',
          routingKey: 'orders.created',
          redelivered: true,
        }),
      ).toEqual(
        Array.from({ length: 1200 }, (_, i) => i + 1)
          .filter((n) => n % 2 === 0 && n % 3 === 0 && n % 5 === 0)
          .map(messageId),
      );
      expect(await ids({}, OTHER)).toEqual([]);
      expect(await repo.getCapture(OTHER, 'cap-1')).toBeUndefined();
      expect((await repo.listCaptures(OTHER, { limit: 10 })).items).toEqual([]);
      expect(
        (await repo.listCaptures(OWNER, { limit: 10 })).items,
      ).toHaveLength(1);
    });

    it('M1-09 AC-10 finds words in the index, as prefixes and with other filters, and treats operators as text', async () => {
      await seed(1200);

      expect(await ids({ text: 'london' })).toHaveLength(600);
      expect(await ids({ text: 'London PARIS' })).toEqual([]);
      expect(await ids({ text: 'number77' })).toEqual([messageId(77)]);
      expect(await ids({ text: 'number7*' })).toHaveLength(1 + 10 + 100);
      expect(await ids({ text: 'london created' })).toHaveLength(200);
      expect(await ids({ text: 'queue3 london', exchange: 'orders' })).toEqual(
        Array.from({ length: 1200 }, (_, i) => i + 1)
          .filter((n) => n % 7 === 3 && n % 2 === 0)
          .map(messageId),
      );
      // Words of the metadata projection are searched too.
      expect(await ids({ text: 'shipped' })).toHaveLength(800);
      // Nothing in these is a query operator.
      for (const text of [
        '"',
        'london" OR "paris',
        'NOT london',
        'meta: london',
        'london NEAR paris',
        '(((',
        '*',
        '-',
        'order* OR',
        "'; DROP TABLE captures; --",
      ]) {
        await expect(ids({ text })).resolves.toBeInstanceOf(Array);
      }
      expect(await ids({ text: 'london" OR "paris' })).toEqual([]);
      expect(await ids({ text: '"""' })).toEqual([]);
      expect(await ids({ text: 'unheardofword' })).toEqual([]);
    });

    it('M1-09 AC-8 refuses messages over the owner quota and over the message limit, and counts them', async () => {
      await repo.createCapture(newCapture('cap-1'));
      const one = (
        await repo.appendMessages(
          { captureId: 'cap-1', ownerId: OWNER, messages: [newMessage(1)] },
          WIDE,
        )
      ).storedBytes;

      const quota = await repo.appendMessages(
        {
          captureId: 'cap-1',
          ownerId: OWNER,
          messages: [2, 3, 4, 5].map((n) => newMessage(n)),
        },
        { ownerQuotaBytes: one * 3 + 10, captureMaxMessages: 100 },
      );
      expect(quota.stored).toBe(2);
      expect(quota.rejected.map((r) => [r.id, r.reason])).toEqual([
        [messageId(4), 'quota'],
        [messageId(5), 'quota'],
      ]);

      const limit = await repo.appendMessages(
        {
          captureId: 'cap-1',
          ownerId: OWNER,
          messages: [6, 7].map((n) => newMessage(n)),
        },
        { ownerQuotaBytes: 1_000_000, captureMaxMessages: 4 },
      );
      expect(limit.stored).toBe(1);
      expect(limit.rejected).toEqual([
        { id: messageId(7), reason: 'capture-limit' },
      ]);

      expect(await repo.getCapture(OWNER, 'cap-1')).toMatchObject({
        messages: 4,
        droppedQuota: 2,
        droppedLimit: 1,
      });
      expect(await ids({})).toHaveLength(4);
      // Deleting a capture gives its quota back.
      await repo.deleteCapture(OWNER, 'cap-1');
      expect(await repo.usage(OWNER)).toEqual({ captures: 0, storedBytes: 0 });
    });

    it('M1-09 AC-8 ignores a message id it already holds, rejects a missing or foreign capture, and counts losses', async () => {
      await repo.createCapture(newCapture('cap-1'));
      await repo.appendMessages(
        { captureId: 'cap-1', ownerId: OWNER, messages: [newMessage(1)] },
        WIDE,
      );

      const again = await repo.appendMessages(
        {
          captureId: 'cap-1',
          ownerId: OWNER,
          messages: [newMessage(1), newMessage(2)],
        },
        WIDE,
      );
      expect(again.stored).toBe(1);
      expect(again.rejected).toEqual([
        { id: messageId(1), reason: 'duplicate' },
      ]);
      const foreign = await repo.appendMessages(
        { captureId: 'cap-1', ownerId: OTHER, messages: [newMessage(3)] },
        WIDE,
      );
      expect(foreign.rejected).toEqual([
        { id: messageId(3), reason: 'capture-missing' },
      ]);
      await repo.noteLoss('cap-1', { queue: 5, omitted: 2 });
      await repo.noteLoss('cap-1', { queue: 1 });
      await repo.noteLoss('missing', { queue: 1 });
      expect(await repo.getCapture(OWNER, 'cap-1')).toMatchObject({
        messages: 2,
        droppedQueue: 6,
        omittedBodies: 2,
      });
      await expect(
        repo.appendMessages(
          {
            captureId: 'cap-1',
            ownerId: OWNER,
            messages: Array.from({ length: 1001 }, (_, i) =>
              newMessage(i + 10),
            ),
          },
          WIDE,
        ),
      ).rejects.toThrow(RangeError);
    });

    it('M1-09 AC-7 stores a blob once for equal bodies, reads its chunks only for its owner, and counts omitted bodies', async () => {
      await repo.createCapture(newCapture('cap-1'));
      await repo.createCapture(newCapture('cap-2', { ownerId: OTHER }));
      const ref = 'a'.repeat(64);

      const result = await repo.appendMessages(
        {
          captureId: 'cap-1',
          ownerId: OWNER,
          messages: [
            blobMessage(1, ref, 3),
            blobMessage(2, ref, 3),
            newMessage(3, {
              bodyState: 'omitted',
              bodySealed: null,
              bodyText: null,
            }),
          ],
        },
        WIDE,
      );

      expect(result.stored).toBe(3);
      expect(
        await handle.db.selectFrom('capture_blobs').selectAll().execute(),
      ).toMatchObject([
        { ref, size: 3000, chunk_bytes: 1000, chunk_count: 3, refcount: 2 },
      ]);
      expect(
        (
          await handle.db
            .selectFrom('capture_blob_chunks')
            .select('ix')
            .execute()
        ).map((r) => r.ix),
      ).toHaveLength(3);
      const slice = await repo.getBlobChunks(OWNER, ref, 1, 3);
      expect(slice).toMatchObject({
        size: 3000,
        chunkBytes: 1000,
        chunkCount: 3,
      });
      expect(
        slice?.chunks.map((c) => [c.index, c.sealed[0], c.sealed.byteLength]),
      ).toEqual([
        [1, 2, 1016],
        [2, 3, 1016],
      ]);
      expect(
        (await repo.getBlobChunks(OWNER, ref, 0, 1000))?.chunks,
      ).toHaveLength(3);
      // A hash alone opens nothing: only an owner of a message that uses the blob reads it.
      expect(await repo.getBlobChunks(OTHER, ref, 0, 3)).toBeUndefined();
      expect(
        await repo.getBlobChunks(OWNER, 'b'.repeat(64), 0, 3),
      ).toBeUndefined();
      expect(await repo.getMessage(OWNER, 'cap-1', messageId(1))).toMatchObject(
        {
          bodyState: 'blob',
          blobRef: ref,
          bodySealed: null,
          bodyIndexed: false,
        },
      );
      expect(await repo.getMessage(OWNER, 'cap-1', messageId(3))).toMatchObject(
        {
          bodyState: 'omitted',
          bodySealed: null,
        },
      );
      expect(await repo.getCapture(OWNER, 'cap-1')).toMatchObject({
        omittedBodies: 1,
      });
    });

    it('M1-09 AC-4 purges only expired captures, in a bounded way, with their messages, chunks and index entries', async () => {
      await repo.createCapture(newCapture('cap-1', { expiresAt: 5_000 }));
      await repo.createCapture(newCapture('cap-2', { expiresAt: 6_000 }));
      await repo.createCapture(newCapture('cap-3', { expiresAt: 90_000 }));
      const shared = 'c'.repeat(64);
      const own = 'd'.repeat(64);
      const add = (id: string, messages: NewMessage[]) =>
        repo.appendMessages({ captureId: id, ownerId: OWNER, messages }, WIDE);
      await add('cap-1', [
        newMessage(1),
        blobMessage(2, shared, 2),
        blobMessage(3, own, 1),
      ]);
      await add('cap-2', [newMessage(4), newMessage(5)]);
      await add('cap-3', [newMessage(6), blobMessage(7, shared, 2)]);
      const bytes = (await repo.getCapture(OWNER, 'cap-1'))?.storedBytes;

      expect(await repo.purgeExpired(4_999, 10)).toEqual({
        captures: 0,
        messages: 0,
        blobsRemoved: 0,
        bytesFreed: 0,
      });
      const first = await repo.purgeExpired(6_500, 1);
      expect(first).toEqual({
        captures: 1,
        messages: 3,
        blobsRemoved: 1,
        bytesFreed: bytes,
      });
      expect(await repo.getCapture(OWNER, 'cap-1')).toBeUndefined();
      expect(await repo.getCapture(OWNER, 'cap-2')).toBeDefined();
      // The blob that a live capture still uses stays, with one reference left.
      expect(
        await handle.db
          .selectFrom('capture_blobs')
          .select(['ref', 'refcount'])
          .execute(),
      ).toEqual([{ ref: shared, refcount: 1 }]);
      expect(
        await handle.db
          .selectFrom('capture_blob_chunks')
          .select('ref')
          .execute(),
      ).toHaveLength(2);

      const second = await repo.purgeExpired(6_500, 10);
      expect(second).toMatchObject({ captures: 1, messages: 2 });
      expect(await repo.purgeExpired(6_500, 10)).toMatchObject({ captures: 0 });
      expect(await ids({ text: 'london' })).toEqual([]);
      const left = await handle.db
        .selectFrom('captured_messages')
        .select('id')
        .execute();
      expect(left.map((r) => r.id)).toEqual([messageId(6), messageId(7)]);
      if (handle.dialect === 'sqlite') {
        const rows = await sql<{
          n: number;
        }>`SELECT count(*) AS n FROM captured_fts`.execute(handle.db);
        expect(rows.rows[0]?.n).toBe(2);
      }
      // The surviving capture is whole, and deleting it removes the last blob.
      expect(await repo.deleteCapture(OTHER, 'cap-3')).toBeUndefined();
      expect(await repo.deleteCapture(OWNER, 'cap-3')).toMatchObject({
        captures: 1,
        messages: 2,
        blobsRemoved: 1,
      });
      expect(
        await handle.db.selectFrom('capture_blobs').selectAll().execute(),
      ).toEqual([]);
      expect(
        await handle.db.selectFrom('capture_blob_chunks').selectAll().execute(),
      ).toEqual([]);
    });

    it('M1-09 AC-4 finishes a delete that stopped half way, and hides the capture meanwhile', async () => {
      await seed(900);
      await handle.db.updateTable('captures').set({ deleting: 1 }).execute();

      expect(await repo.getCapture(OWNER, 'cap-1')).toBeUndefined();
      expect(
        await repo.queryMessages(OWNER, {
          captureId: 'cap-1',
          order: 'asc',
          limit: 5,
        }),
      ).toEqual({
        items: [],
      });
      expect((await repo.listCaptures(OWNER, { limit: 5 })).items).toEqual([]);
      expect(
        (
          await repo.appendMessages(
            {
              captureId: 'cap-1',
              ownerId: OWNER,
              messages: [newMessage(5000)],
            },
            WIDE,
          )
        ).rejected,
      ).toEqual([{ id: messageId(5000), reason: 'capture-missing' }]);
      expect(await repo.purgeExpired(0, 10)).toMatchObject({
        captures: 1,
        messages: 900,
      });
      expect(
        await handle.db.selectFrom('captured_messages').select('id').execute(),
      ).toEqual([]);
    });

    it('M1-09 AC-10 lists captures newest first in windows', async () => {
      for (const n of [1, 2, 3, 4, 5])
        await repo.createCapture(newCapture(`cap-${String(n)}`));

      const first = await repo.listCaptures(OWNER, { limit: 2 });
      expect(first.items.map((c) => c.id)).toEqual(['cap-5', 'cap-4']);
      const second = await repo.listCaptures(OWNER, {
        limit: 2,
        cursor: first.nextCursor ?? '',
      });
      expect(second.items.map((c) => c.id)).toEqual(['cap-3', 'cap-2']);
      const third = await repo.listCaptures(OWNER, {
        limit: 2,
        cursor: second.nextCursor ?? '',
      });
      expect(third).toEqual({
        items: [expect.objectContaining({ id: 'cap-1' })],
      });
      await expect(repo.createCapture(newCapture('cap-1'))).rejects.toThrow();
    });
  });
}
