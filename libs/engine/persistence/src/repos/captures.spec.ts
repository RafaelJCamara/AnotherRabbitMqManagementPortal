// SQLite-only tests of the capture repository (M1-09): what needs a file or the FTS5 table itself.
// The behaviour shared with Postgres is in testing/capture-contract.ts.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  CaptureSearchUnavailableError,
  type CaptureRepository,
} from '@app/ports';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';

import type { PersistenceHandle } from '../database';
import {
  blobMessage,
  messageId,
  newCapture,
  newMessage,
} from '../testing/capture-contract';
import { openMigratedSqlite, tempDirectory } from '../testing/sqlite-fixtures';
import { createRepositories } from '.';

const WIDE = { ownerQuotaBytes: 1_000_000_000, captureMaxMessages: 100_000 };
const opened: PersistenceHandle[] = [];
const disposers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((handle) => handle.close()));
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

async function open(path?: string): Promise<{
  handle: PersistenceHandle;
  repo: CaptureRepository;
}> {
  const handle = await openMigratedSqlite(path);
  opened.push(handle);
  return { handle, repo: createRepositories(handle).captures };
}

/** All bytes a database file and its write-ahead log hold. */
async function fileBytes(path: string): Promise<Buffer> {
  const parts = await Promise.all(
    [path, `${path}-wal`].map((file) =>
      readFile(file).catch(() => Buffer.alloc(0)),
    ),
  );
  return Buffer.concat(parts);
}

describe('M1-09 capture repository on SQLite', () => {
  it('M1-09 AC-11 stores and filters by metadata without the FTS5 table, and refuses a text query with an error', async () => {
    const { handle, repo } = await open();
    await sql`DROP TABLE captured_fts`.execute(handle.db);
    expect(await repo.searchAvailable()).toBe(false);
    await repo.createCapture(newCapture('cap-1'));

    const result = await repo.appendMessages(
      {
        captureId: 'cap-1',
        ownerId: 'user-1',
        messages: [
          newMessage(1),
          newMessage(2),
          blobMessage(3, 'e'.repeat(64), 2),
        ],
      },
      WIDE,
    );

    expect(result.stored).toBe(3);
    const found = await repo.queryMessages('user-1', {
      captureId: 'cap-1',
      exchange: 'orders',
      order: 'asc',
      limit: 10,
    });
    expect(found.items.map((m) => m.id)).toEqual([messageId(2)]);
    const error = await repo
      .queryMessages('user-1', {
        captureId: 'cap-1',
        text: 'london',
        order: 'asc',
        limit: 10,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CaptureSearchUnavailableError);
    expect((error as CaptureSearchUnavailableError).code).toBe(
      'CAPTURE_SEARCH_UNAVAILABLE',
    );
    // Blank text is no text query.
    expect(
      (
        await repo.queryMessages('user-1', {
          captureId: 'cap-1',
          text: '  ',
          order: 'asc',
          limit: 10,
        })
      ).items,
    ).toHaveLength(3);
    // Deleting still works with no index.
    expect(await repo.deleteCapture('user-1', 'cap-1')).toMatchObject({
      messages: 3,
      blobsRemoved: 1,
    });
  });

  it('M1-09 AC-4 leaves no word of a deleted message in the database file, its log or its index', async () => {
    const directory = await tempDirectory();
    disposers.push(directory.dispose);
    const path = join(directory.dir, 'capture.db');
    const { handle, repo } = await open(path);
    await repo.createCapture(newCapture('cap-1', { expiresAt: 5_000 }));
    await repo.createCapture(newCapture('cap-2', { expiresAt: 90_000 }));
    const doomed = newMessage(1, {
      bodyText: 'zqxwvutok rareword',
      metaText: 'orders kjhgfdsa',
    });
    await repo.appendMessages(
      {
        captureId: 'cap-1',
        ownerId: 'user-1',
        messages: [doomed, ...[2, 3, 4].map((n) => newMessage(n))],
      },
      WIDE,
    );
    await repo.appendMessages(
      {
        captureId: 'cap-2',
        ownerId: 'user-1',
        messages: [newMessage(5), newMessage(6)],
      },
      WIDE,
    );
    await sql`PRAGMA wal_checkpoint(TRUNCATE)`.execute(handle.db);
    // The words really are in the file before the delete, or the test would prove nothing.
    const before = await fileBytes(path);
    expect(before.includes('zqxwvutok')).toBe(true);
    expect(before.includes('kjhgfdsa')).toBe(true);

    expect(await repo.purgeExpired(6_000, 10)).toMatchObject({
      captures: 1,
      messages: 4,
    });
    await sql`PRAGMA wal_checkpoint(TRUNCATE)`.execute(handle.db);

    const after = await fileBytes(path);
    expect(after.includes('zqxwvutok')).toBe(false);
    expect(after.includes('rareword')).toBe(false);
    expect(after.includes('kjhgfdsa')).toBe(false);
    const hits = await repo.queryMessages('user-1', {
      captureId: 'cap-2',
      text: 'london',
      order: 'asc',
      limit: 10,
    });
    expect(hits.items).toHaveLength(1);
  });

  it('M1-09 AC-1 appends a batch of 100 messages in a transaction of a few milliseconds and reports the time', async () => {
    const { repo } = await open();
    await repo.createCapture(newCapture('cap-1'));
    const times: number[] = [];

    for (let batch = 0; batch < 5; batch += 1) {
      const messages = Array.from({ length: 100 }, (_, i) =>
        newMessage(batch * 100 + i + 1),
      );
      const result = await repo.appendMessages(
        { captureId: 'cap-1', ownerId: 'user-1', messages },
        WIDE,
      );
      expect(result.stored).toBe(100);
      times.push(result.txnMs);
    }

    expect(times.every((ms) => ms > 0)).toBe(true);
    // Generous: the 5 ms budget is proved by perf:capture-ingest; this guards against a quadratic insert.
    expect(Math.max(...times)).toBeLessThan(250);
  });

  it('M1-09 AC-8 keeps the quota check inside the transaction, so a failing insert stores nothing', async () => {
    const { repo } = await open();
    await repo.createCapture(newCapture('cap-1'));
    const bad = newMessage(2, {
      blob: null,
      bodyState: 'blob',
      bodySealed: null,
    });

    await expect(
      repo.appendMessages(
        {
          captureId: 'cap-1',
          ownerId: 'user-1',
          messages: [newMessage(1), bad],
        },
        WIDE,
      ),
    ).rejects.toThrow();

    expect(
      await repo.getMessage('user-1', 'cap-1', messageId(1)),
    ).toBeUndefined();
    expect(await repo.getCapture('user-1', 'cap-1')).toMatchObject({
      messages: 0,
      storedBytes: 0,
    });
  });
});
