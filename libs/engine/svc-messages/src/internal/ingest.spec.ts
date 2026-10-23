import type { NewMessage } from '@app/ports';
import { describe, expect, it } from 'vitest';

import { createMemoryCaptureRepository } from '../testing';
import { createIngest, type IngestItem } from './ingest';

const LIMITS = { ownerQuotaBytes: 1e9, captureMaxMessages: 1e6 };

function message(n: number): NewMessage {
  return {
    id: `01TESTMSG${String(n).padStart(8, '0')}`,
    receivedAt: n,
    exchange: 'orders',
    routingKey: 'orders.created',
    source: 'q',
    contentType: null,
    redelivered: false,
    size: 10,
    bodySha256: '0'.repeat(64),
    bodyState: 'inline',
    bodySealed: new Uint8Array(40),
    blob: null,
    metaSealed: new Uint8Array(40),
    metaText: 'orders',
    bodyText: 'hello',
  };
}

const item = (n: number, captureId = 'cap-1', bytes = 400): IngestItem => ({
  captureId,
  ownerId: 'user-1',
  message: message(n),
  bytes,
});

async function setup(
  over: {
    maxItems?: number;
    maxBytes?: number;
    maxBatch?: number;
    budgetMs?: number;
  } = {},
) {
  const repo = createMemoryCaptureRepository();
  for (const id of ['cap-1', 'cap-2']) {
    await repo.createCapture({
      id,
      ownerId: 'user-1',
      kind: 'manual',
      label: id,
      target: '{}',
      envClass: 'dev',
      indexBodies: true,
      createdAt: 1,
      expiresAt: 1e12,
    });
  }
  const errors: string[] = [];
  const ingest = createIngest({
    repo,
    limits: () => LIMITS,
    maxItems: over.maxItems ?? 1000,
    maxBytes: over.maxBytes ?? 1e9,
    budgetMs: over.budgetMs ?? 5,
    maxBatch: over.maxBatch ?? 64,
    onError: (code) => errors.push(code),
  });
  return { repo, ingest, errors };
}

describe('capture ingest', () => {
  it('M1-09 AC-9 writes everything it accepted, in order, and flush waits for it', async () => {
    const { repo, ingest } = await setup();

    for (let n = 1; n <= 300; n += 1) expect(ingest.offer(item(n))).toBe(true);
    await ingest.flush();

    const all = await repo.queryMessages('user-1', {
      captureId: 'cap-1',
      order: 'asc',
      limit: 500,
    });
    expect(all.items.map((m) => m.receivedAt)).toEqual(
      Array.from({ length: 300 }, (_, i) => i + 1),
    );
    expect(ingest.stats()).toMatchObject({
      items: 0,
      bytes: 0,
      stored: 300,
      lostToError: 0,
    });
  });

  it('M1-09 AC-9 refuses an offer over the item bound or the byte bound, and counts nothing as stored', async () => {
    const byItems = await setup({ maxItems: 3 });
    const byBytes = await setup({ maxBytes: 1000 });

    const items = [1, 2, 3, 4, 5].map((n) => byItems.ingest.offer(item(n)));
    const bytes = [1, 2, 3].map((n) =>
      byBytes.ingest.offer(item(n, 'cap-1', 400)),
    );

    expect(items).toEqual([true, true, true, false, false]);
    expect(bytes).toEqual([true, true, false]);
    expect(byItems.ingest.hasRoom(1)).toBe(false);
    expect(byBytes.ingest.hasRoom(400)).toBe(false);
    expect(byBytes.ingest.hasRoom(200)).toBe(true);
    await byItems.ingest.flush();
    expect(byItems.ingest.stats()).toMatchObject({ stored: 3, items: 0 });
    expect(byItems.ingest.hasRoom(1)).toBe(true);
  });

  it('M1-09 AC-9 writes the loss of a refused message on its capture, with the next batch', async () => {
    const { repo, ingest } = await setup();

    ingest.refused('cap-1', 4, 'queue');
    ingest.refused('cap-1', 2, 'limit');
    ingest.refused('cap-2', 1, 'queue');
    ingest.refused('cap-2', 0, 'queue');
    await ingest.flush();

    expect(await repo.getCapture('user-1', 'cap-1')).toMatchObject({
      droppedQueue: 4,
      droppedLimit: 2,
    });
    expect(await repo.getCapture('user-1', 'cap-2')).toMatchObject({
      droppedQueue: 1,
    });
  });

  it('M1-09 AC-9 halves the batch after a slow transaction and grows it again after fast ones', async () => {
    const { repo, ingest } = await setup({ maxBatch: 64, budgetMs: 5 });
    repo.setTxnMs(12);
    for (let n = 1; n <= 80; n += 1) ingest.offer(item(n));
    await ingest.flush();
    const slow = ingest.stats().batchSize;
    const sizesWhileSlow = [...repo.batches];

    repo.setTxnMs(1);
    for (let n = 101; n <= 700; n += 1) ingest.offer(item(n));
    await ingest.flush();

    expect(sizesWhileSlow[0]).toBe(16);
    expect(sizesWhileSlow.slice(0, 5)).toEqual([16, 8, 4, 2, 1]);
    expect(slow).toBe(1);
    expect(ingest.stats().batchSize).toBe(64);
    expect(Math.max(...repo.batches)).toBeLessThanOrEqual(64);
    expect(ingest.stats().maxTxnMs).toBe(12);
  });

  it('M1-09 AC-9 never mixes two captures in one transaction, and keeps their order', async () => {
    const { repo, ingest } = await setup();

    for (const n of [1, 2, 3]) ingest.offer(item(n, 'cap-1'));
    for (const n of [4, 5]) ingest.offer(item(n, 'cap-2'));
    ingest.offer(item(6, 'cap-1'));
    await ingest.flush();

    expect(repo.batches).toEqual([3, 2, 1]);
  });

  it('M1-09 AC-9 counts a batch whose write fails as lost, keeps going, and reports only a code', async () => {
    const { repo, ingest, errors } = await setup();
    repo.failAppends(1);

    for (let n = 1; n <= 40; n += 1) ingest.offer(item(n));
    await ingest.flush();

    const stats = ingest.stats();
    expect(stats.lostToError).toBe(16);
    expect(stats.stored).toBe(24);
    expect(errors).toEqual(['ERROR']);
    expect(JSON.stringify(errors)).not.toMatch(/write failed/);
  });

  it('M1-09 AC-9 counts rows the repository refuses (quota, limit, duplicate, missing capture) from its answer', async () => {
    const { repo, ingest } = await setup();
    const tight = createIngest({
      repo,
      limits: () => ({ ownerQuotaBytes: 1e9, captureMaxMessages: 2 }),
      maxItems: 100,
      maxBytes: 1e9,
      budgetMs: 5,
      maxBatch: 64,
    });

    for (const n of [1, 2, 3, 3]) tight.offer(item(n));
    tight.offer({ ...item(9), captureId: 'cap-gone' });
    await tight.flush();
    ingest.offer(item(1, 'cap-2'));
    await ingest.flush();

    expect(tight.stats().rejected).toEqual({
      quota: 0,
      captureLimit: 2,
      duplicate: 0,
      captureMissing: 1,
    });
    expect(ingest.stats().rejected.duplicate).toBe(1);
  });

  it('M1-09 AC-9 gives the event loop a turn between batches', async () => {
    const { ingest } = await setup({ maxBatch: 4 });
    let turns = 0;
    const ticker = setInterval(() => {
      turns += 1;
    }, 0);

    for (let n = 1; n <= 400; n += 1) ingest.offer(item(n));
    await ingest.flush();
    clearInterval(ticker);

    expect(ingest.stats().batches).toBeGreaterThan(40);
    expect(turns).toBeGreaterThan(0);
  });
});
