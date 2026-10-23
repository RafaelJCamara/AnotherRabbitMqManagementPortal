import { createIdGenerator } from '@app/kernel';
import { describe, expect, it } from 'vitest';

import {
  createFakeSealer,
  createMemoryCaptureRepository,
  sampleMessage,
} from '../testing';
import { createCaptureStore, type CaptureStoreOptions } from './capture-store';
import type { CaptureInput } from './types';

const OWNER = 'user-1';
const volatile = (over: Partial<CaptureInput> = {}): CaptureInput => ({
  kind: 'tap',
  label: 'live look',
  target: { queue: 'orders' },
  envClass: 'dev',
  persist: 'volatile',
  ...over,
});

function setup(options: Partial<CaptureStoreOptions> = {}) {
  const repo = createMemoryCaptureRepository();
  const ids = createIdGenerator();
  const store = createCaptureStore({
    repo,
    sealer: createFakeSealer(),
    newId: () => ids.ulid(),
    options,
  });
  return { repo, store };
}

describe('capture volatile', () => {
  it('M1-09 AC-13 keeps messages in memory only, writes no row, and drops the oldest when its ring is full, counting them', async () => {
    const { repo, store } = setup({ volatileMaxMessages: 5 });
    const capture = await store.create(OWNER, volatile());

    const receipt = await store.append(
      OWNER,
      capture.id,
      Array.from({ length: 12 }, (_, i) => sampleMessage(i + 1)),
    );
    await store.flush();

    expect(receipt.accepted).toBe(12);
    const view = await store.capture(OWNER, capture.id);
    expect(view).toMatchObject({
      persist: 'volatile',
      messages: 5,
      evicted: 7,
      droppedQueue: 7,
    });
    const held = await store.query(OWNER, {
      captureId: capture.id,
      order: 'asc',
      limit: 50,
    });
    expect(held.items.map((m) => m.receivedAt)).toEqual([
      1_000_008, 1_000_009, 1_000_010, 1_000_011, 1_000_012,
    ]);
    expect(store.stats()).toMatchObject({
      volatileEvicted: 7,
      stored: 0,
      batches: 0,
    });
    expect(await repo.usage(OWNER)).toEqual({ captures: 0, storedBytes: 0 });
    expect(JSON.parse(repo.dump())).toEqual([[], []]);
    expect(store.volatile(OWNER).map((c) => c.id)).toEqual([capture.id]);
    expect(store.volatile('user-2')).toEqual([]);
  });

  it('M1-09 AC-13 bounds the ring by bytes too, and counts a message larger than the whole ring', async () => {
    const { store } = setup({ volatileMaxBytes: 4000 });
    const capture = await store.create(OWNER, volatile());

    await store.append(OWNER, capture.id, [
      sampleMessage(1, { body: new Uint8Array(3000) }),
      sampleMessage(2, { body: new Uint8Array(3000) }),
      sampleMessage(3, { body: new Uint8Array(9000) }),
    ]);

    const view = await store.capture(OWNER, capture.id);
    expect(view?.messages).toBe(1);
    expect(view?.evicted).toBe(2);
    expect((view?.storedBytes ?? 0) <= 4000).toBe(true);
  });

  it('M1-09 AC-13 filters and searches the ring with the projection a saved capture indexes, in pages', async () => {
    const { store } = setup();
    const capture = await store.create(OWNER, volatile());
    const prod = await store.create(OWNER, volatile({ envClass: 'prod' }));
    await store.append(
      OWNER,
      capture.id,
      Array.from({ length: 30 }, (_, i) => sampleMessage(i + 1)),
    );
    await store.append(OWNER, prod.id, [sampleMessage(100)]);

    const london = await store.query(OWNER, {
      captureId: capture.id,
      text: 'London',
      order: 'asc',
      limit: 100,
    });
    const paged: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.query(OWNER, {
        captureId: capture.id,
        order: 'desc',
        limit: 4,
        ...(cursor === undefined ? {} : { cursor }),
      });
      paged.push(...page.items.map((m) => m.id));
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    expect(london.items).toHaveLength(15);
    expect(
      (
        await store.query(OWNER, {
          captureId: capture.id,
          text: 'lon* created',
          limit: 50,
        })
      ).items,
    ).toHaveLength(5);
    expect(
      (
        await store.query(OWNER, {
          captureId: capture.id,
          text: '"" OR (',
          limit: 50,
        })
      ).items,
    ).toEqual([]);
    expect(
      (
        await store.query(OWNER, {
          captureId: capture.id,
          exchange: 'billing',
          redelivered: true,
          limit: 50,
        })
      ).items.map((m) => m.receivedAt),
    ).toEqual([1_000_025, 1_000_015, 1_000_005]);
    expect(new Set(paged).size).toBe(30);
    expect(paged).toEqual([...paged].sort().reverse());
    // A prod capture indexes no body in memory either.
    expect(
      (
        await store.query(OWNER, {
          captureId: prod.id,
          text: 'london',
          limit: 5,
        })
      ).items,
    ).toEqual([]);
    expect(
      (
        await store.query(OWNER, {
          captureId: prod.id,
          text: 'orders',
          limit: 5,
        })
      ).items,
    ).toHaveLength(1);
    expect(
      await store.query('user-2', { captureId: capture.id, limit: 5 }),
    ).toEqual({ items: [] });
  });

  it('M1-09 AC-13 hands back the body and headers of a message in the ring', async () => {
    const { store } = setup();
    const capture = await store.create(OWNER, volatile());
    await store.append(OWNER, capture.id, [
      sampleMessage(1, { headers: { a: 'b' } }),
    ]);

    const detail = await store.get(
      OWNER,
      capture.id,
      sampleMessage(1).id ?? '',
    );

    expect(detail?.headers).toEqual({ a: 'b' });
    expect(Buffer.from(detail?.body ?? []).toString()).toContain('Paris');
    expect(detail?.summary.bodyState).toBe('inline');
    expect(await store.get(OWNER, capture.id, 'nope-nope-1')).toBeUndefined();
    expect(await store.remove(OWNER, capture.id)).toMatchObject({
      captures: 1,
      messages: 1,
    });
    expect(await store.capture(OWNER, capture.id)).toBeUndefined();
  });

  it('M1-09 AC-13 saves a volatile capture into a new sealed capture, and a second save adds only what is new', async () => {
    const { repo, store } = setup({ volatileMaxMessages: 5 });
    const capture = await store.create(OWNER, volatile({ label: 'keep this' }));
    await store.append(
      OWNER,
      capture.id,
      Array.from({ length: 5 }, (_, i) => sampleMessage(i + 1)),
    );

    const first = await store.save(OWNER, capture.id);
    await store.append(OWNER, capture.id, [sampleMessage(6), sampleMessage(7)]);
    const second = await store.save(OWNER, capture.id);

    expect(first.capture).toMatchObject({
      persist: 'saved',
      label: 'keep this',
      messages: 5,
      envClass: 'dev',
    });
    expect(first.receipt).toMatchObject({ accepted: 5 });
    expect(second.capture.id).toBe(first.capture.id);
    expect(second.capture.messages).toBe(7);
    expect(store.stats().rejected.duplicate).toBe(3);
    const saved = await store.query(OWNER, {
      captureId: first.capture.id,
      text: 'london',
      limit: 50,
    });
    expect(saved.items).toHaveLength(3);
    // What was saved is sealed: the repository holds no body text beyond the projection.
    const row = await repo.getMessage(
      OWNER,
      first.capture.id,
      sampleMessage(1).id ?? '',
    );
    expect(Buffer.from(row?.bodySealed ?? []).toString()).not.toContain(
      'Paris',
    );
    // The volatile capture stays until it is removed or expires.
    expect(await store.capture(OWNER, capture.id)).toMatchObject({
      persist: 'volatile',
      messages: 5,
    });
  });

  it('M1-09 AC-13 does not save another person’s volatile capture', async () => {
    const { store } = setup();
    const capture = await store.create(OWNER, volatile());

    await expect(store.save('user-2', capture.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(store.save(OWNER, 'no-such-capture')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
