import {
  AppError,
  createCanaryScanner,
  createIdGenerator,
  createLogger,
} from '@app/kernel';
import type { FieldSealer } from '@app/ports';
import { describe, expect, it } from 'vitest';

import {
  createFakeSealer,
  createMemoryCaptureRepository,
  sampleMessage,
} from '../testing';
import {
  createCaptureStore,
  type CaptureStore,
  type CaptureStoreOptions,
} from './capture-store';
import {
  BLOB_MAX_BYTES,
  CHUNK_BYTES,
  INLINE_MAX_BYTES,
  sha256Hex,
} from './seal';
import type { CaptureInput } from './types';

const OWNER = 'user-1';
const input = (over: Partial<CaptureInput> = {}): CaptureInput => ({
  kind: 'manual',
  label: 'orders to check',
  target: { connection: 'c1', queue: 'orders' },
  envClass: 'dev',
  persist: 'saved',
  ...over,
});

function setup(
  options: Partial<CaptureStoreOptions> = {},
  extra: { sealer?: FieldSealer; clock?: { now: number } } = {},
) {
  const repo = createMemoryCaptureRepository();
  const fake = createFakeSealer();
  const ids = createIdGenerator();
  const clock = extra.clock ?? { now: 1_000_000 };
  const lines: string[] = [];
  const logger = createLogger({
    level: 'trace',
    sink: { write: (line) => lines.push(line) },
  });
  const store: CaptureStore = createCaptureStore({
    repo,
    sealer: extra.sealer ?? fake,
    newId: () => ids.ulid(),
    now: () => clock.now,
    logger,
    options,
  });
  return { repo, fake, store, clock, lines };
}

/** Equal bytes. 	oEqual on megabytes of typed array is far too slow. */
const same = (a: Uint8Array, b: Uint8Array): boolean =>
  Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

const pattern = (length: number): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (i * 7 + 3) % 251);

// Several tests here seal and hash megabytes (a 3 MiB body, a 16 MiB body over the cap) and read them back
// in chunks, giving the loop a turn between chunks. That takes about a second on a developer machine and
// several on a loaded CI runner (6.9 s on one), so the 5 s default failed on load, not on behaviour. The
// limit only stops a hung test; no assertion depends on the time.
describe('capture store', { timeout: 60_000 }, () => {
  it('M1-09 AC-7 keeps small bodies inline, chunks bigger ones, and stores equal large bodies once', async () => {
    const { repo, store } = setup();
    const capture = await store.create(OWNER, input());
    const big = pattern(3 * 1024 * 1024 + 7);
    const bodies = [
      new Uint8Array(0),
      pattern(10),
      pattern(INLINE_MAX_BYTES),
      pattern(INLINE_MAX_BYTES + 1),
      big,
      big,
    ];

    const receipt = await store.append(
      OWNER,
      capture.id,
      bodies.map((body, n) => sampleMessage(n + 1, { body })),
    );
    await store.flush();

    expect(receipt).toEqual({
      accepted: 6,
      refused: { queueFull: 0, tooLarge: 0, invalid: 0, locked: 0 },
    });
    const all = await store.query(OWNER, {
      captureId: capture.id,
      order: 'asc',
      limit: 10,
    });
    expect(all.items.map((m) => [m.size, m.bodyState])).toEqual([
      [0, 'inline'],
      [10, 'inline'],
      [INLINE_MAX_BYTES, 'inline'],
      [INLINE_MAX_BYTES + 1, 'blob'],
      [big.byteLength, 'blob'],
      [big.byteLength, 'blob'],
    ]);
    const bigRef = all.items[4]?.blobRef ?? '';
    expect(bigRef).toBe(await sha256Hex(big));
    expect(all.items[5]?.blobRef).toBe(bigRef);
    const slice = await repo.getBlobChunks(OWNER, bigRef, 0, 100);
    expect(slice?.chunkCount).toBe(Math.ceil(big.byteLength / CHUNK_BYTES));
    expect(same(await store.blob(OWNER, bigRef, 0, big.byteLength), big)).toBe(
      true,
    );
    // Equal bodies are one blob with two references: deleting the capture removes it once.
    expect(await store.remove(OWNER, capture.id)).toMatchObject({
      blobsRemoved: 2,
      messages: 6,
    });
  });

  it('M1-09 AC-7 reads any range of a blob across chunk borders, and refuses a reader who does not own it', async () => {
    const { store } = setup();
    const capture = await store.create(OWNER, input());
    const other = await store.create('user-2', input());
    const body = pattern(CHUNK_BYTES * 2 + 1000);
    await store.append(OWNER, capture.id, [sampleMessage(1, { body })]);
    await store.flush();
    const ref = await sha256Hex(body);

    const ranges: [number, number][] = [
      [0, 1],
      [CHUNK_BYTES - 1, 2],
      [CHUNK_BYTES, CHUNK_BYTES],
      [CHUNK_BYTES - 5, CHUNK_BYTES + 10],
      [body.byteLength - 3, 100],
      [0, body.byteLength],
    ];
    for (const [offset, length] of ranges) {
      const got = await store.blob(OWNER, ref, offset, length);
      expect(
        same(
          got,
          body.subarray(offset, Math.min(offset + length, body.byteLength)),
        ),
      ).toBe(true);
    }
    expect(await store.blob(OWNER, ref, body.byteLength, 10)).toEqual(
      new Uint8Array(0),
    );
    expect((await store.blob(OWNER, ref, 0, 0)).byteLength).toBe(0);
    await expect(store.blob('user-2', ref, 0, 10)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      store.blob(OWNER, 'f'.repeat(64), 0, 10),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(store.blob(OWNER, ref, -1, 10)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(store.blob(OWNER, ref, 0, 1.5)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(other.id).not.toBe(capture.id);
  });

  it('M1-09 AC-7 stores a body over the blob cap as omitted, with its size and hash, and counts it', async () => {
    const { store } = setup();
    const capture = await store.create(OWNER, input());
    const huge = new Uint8Array(BLOB_MAX_BYTES + 1).fill(9);

    const receipt = await store.append(OWNER, capture.id, [
      sampleMessage(1, { body: huge }),
    ]);
    await store.flush();

    expect(receipt.accepted).toBe(1);
    const found = await store.query(OWNER, { captureId: capture.id, limit: 5 });
    expect(found.items[0]).toMatchObject({
      bodyState: 'omitted',
      size: BLOB_MAX_BYTES + 1,
      bodySha256: await sha256Hex(huge),
      blobRef: null,
      bodyIndexed: false,
    });
    const detail = await store.get(OWNER, capture.id, found.items[0]?.id ?? '');
    expect(detail?.body).toBeUndefined();
    expect(detail?.properties).toEqual({
      messageId: 'm-1',
      correlationId: 'c-1',
    });
    expect(store.stats().omittedBodies).toBe(1);
    expect(await store.capture(OWNER, capture.id)).toMatchObject({
      omittedBodies: 1,
      messages: 1,
    });
  });

  it('M1-09 AC-8 refuses a message over the size the store takes, and counts it on the capture', async () => {
    const { store } = setup({ maxMessageBytes: 100 });
    const capture = await store.create(OWNER, input());

    const receipt = await store.append(OWNER, capture.id, [
      sampleMessage(1, { body: pattern(101) }),
      sampleMessage(2, { body: pattern(100) }),
    ]);
    await store.flush();

    expect(receipt).toEqual({
      accepted: 1,
      refused: { queueFull: 0, tooLarge: 1, invalid: 0, locked: 0 },
    });
    expect(await store.capture(OWNER, capture.id)).toMatchObject({
      messages: 1,
      droppedLimit: 1,
    });
    expect(store.stats().refused.tooLarge).toBe(1);
  });

  it('M1-09 AC-8 reports what the repository refused over the owner quota and the message limit', async () => {
    const { store } = setup({ ownerQuotaBytes: 5000, captureMaxMessages: 100 });
    const capture = await store.create(OWNER, input());

    await store.append(
      OWNER,
      capture.id,
      Array.from({ length: 30 }, (_, i) => sampleMessage(i + 1)),
    );
    await store.flush();

    const view = await store.capture(OWNER, capture.id);
    expect(view?.droppedQuota).toBeGreaterThan(0);
    expect((view?.messages ?? 0) + (view?.droppedQuota ?? 0)).toBe(30);
    expect(store.stats().rejected.quota).toBe(view?.droppedQuota);
    expect(view?.storedBytes).toBeLessThanOrEqual(5000);
  });

  it('M1-09 AC-9 refuses messages when its queue is full, counts them on the capture, and writes the rest', async () => {
    const { repo, store } = setup({ queueMaxItems: 8, maxBatch: 4 });
    const capture = await store.create(OWNER, input());
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = repo.appendMessages.bind(repo);
    repo.appendMessages = async (...args) => {
      await gate;
      return write(...args);
    };

    const receipt = await store.append(
      OWNER,
      capture.id,
      Array.from({ length: 60 }, (_, i) => sampleMessage(i + 1)),
    );
    release();
    await store.flush();

    expect(receipt.refused.queueFull).toBeGreaterThan(0);
    expect(receipt.accepted + receipt.refused.queueFull).toBe(60);
    const view = await store.capture(OWNER, capture.id);
    expect(view?.messages).toBe(receipt.accepted);
    expect(view?.droppedQueue).toBe(receipt.refused.queueFull);
    expect(store.stats()).toMatchObject({
      accepted: receipt.accepted,
      stored: receipt.accepted,
      refused: { queueFull: receipt.refused.queueFull },
    });
  });

  it('M1-09 AC-9 stores nothing when the vault is locked, and says so with GATE_BLOCKED', async () => {
    const { repo, fake, store } = setup();
    const capture = await store.create(OWNER, input());
    fake.lock();

    const refusal = await store
      .append(OWNER, capture.id, [sampleMessage(1), sampleMessage(2)])
      .catch((error: unknown) => error);
    await store.flush();

    expect(refusal).toBeInstanceOf(AppError);
    expect((refusal as AppError).code).toBe('GATE_BLOCKED');
    expect(await store.capture(OWNER, capture.id)).toMatchObject({
      messages: 0,
      storedBytes: 0,
    });
    expect((JSON.parse(repo.dump()) as unknown[][])[1]).toEqual([]);
    expect(store.stats().accepted).toBe(0);
  });

  it('M1-09 AC-9 keeps what it took and reports the rest as locked when the vault locks part way', async () => {
    const real = createFakeSealer();
    let seals = 0;
    const flaky: FieldSealer = {
      open: (...args) => real.open(...args),
      seal: (...args) => {
        seals += 1;
        return seals > 2
          ? Promise.reject(new Error('locked'))
          : real.seal(...args);
      },
    };
    const { store } = setup({}, { sealer: flaky });
    const capture = await store.create(OWNER, input());

    const receipt = await store.append(
      OWNER,
      capture.id,
      [1, 2, 3].map((n) => sampleMessage(n)),
    );
    await store.flush();

    expect(receipt).toEqual({
      accepted: 1,
      refused: { queueFull: 0, tooLarge: 0, invalid: 0, locked: 2 },
    });
    expect(await store.capture(OWNER, capture.id)).toMatchObject({
      messages: 1,
    });
    expect(store.stats().refused.locked).toBe(2);
  });

  it('M1-09 AC-2 does not index the body of a prod capture or of an unset class, and does index a dev one', async () => {
    const { store } = setup();
    const dev = await store.create(OWNER, input({ envClass: 'dev' }));
    const prod = await store.create(OWNER, input({ envClass: 'prod' }));
    const unset = await store.create(OWNER, {
      kind: 'manual',
      label: 'unset class',
      target: {},
      persist: 'saved',
    });
    const off = await store.create(
      OWNER,
      input({ envClass: 'dev', indexBodies: false }),
    );
    for (const [n, capture] of [dev, prod, unset, off].entries()) {
      await store.append(OWNER, capture.id, [sampleMessage(2 * n + 2)]);
    }
    await store.flush();

    const word = async (id: string, text: string): Promise<number> =>
      (await store.query(OWNER, { captureId: id, text, limit: 10 })).items
        .length;

    expect(unset.envClass).toBe('prod');
    expect([dev, prod, unset, off].map((c) => c.indexBodies)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(await word(dev.id, 'london')).toBe(1);
    expect(await word(prod.id, 'london')).toBe(0);
    expect(await word(unset.id, 'london')).toBe(0);
    expect(await word(off.id, 'london')).toBe(0);
    for (const capture of [dev, prod, unset, off]) {
      expect(await word(capture.id, 'orders')).toBe(1);
    }
  });

  it('M1-09 AC-11 turns a missing full-text index into CAPABILITY_MISSING and keeps metadata queries', async () => {
    const { repo, store } = setup();
    const capture = await store.create(OWNER, input());
    await store.append(OWNER, capture.id, [sampleMessage(1), sampleMessage(2)]);
    await store.flush();
    repo.disableSearch();

    const refusal = await store
      .query(OWNER, { captureId: capture.id, text: 'london', limit: 10 })
      .catch((error: unknown) => error);
    const metadata = await store.query(OWNER, {
      captureId: capture.id,
      exchange: 'orders',
      limit: 10,
    });

    expect((refusal as AppError).code).toBe('CAPABILITY_MISSING');
    expect(metadata.items).toHaveLength(1);
  });

  it('M1-09 AC-12 turns a busy, lost or failing capture worker into a Problem, and says nothing of why', async () => {
    const { repo, store } = setup();
    const fail = (code: string) => () =>
      Promise.reject(
        Object.assign(new Error('CANARY-SQL-text-from-the-database'), { code }),
      );

    repo.getCapture = fail('CAPTURE_WORKER_BUSY');
    const busy = await store.capture(OWNER, 'c').catch((e: unknown) => e);
    repo.getCapture = fail('CAPTURE_WORKER_GONE');
    const gone = await store.capture(OWNER, 'c').catch((e: unknown) => e);
    repo.getCapture = fail('CAPTURE_STORE_ERROR');
    const failed = await store.capture(OWNER, 'c').catch((e: unknown) => e);
    repo.getCapture = fail('SOMETHING_ELSE');
    const other = await store.capture(OWNER, 'c').catch((e: unknown) => e);

    expect(busy).toBeInstanceOf(AppError);
    expect((busy as AppError).code).toBe('RATE_LIMITED');
    expect((busy as AppError).retryable).toBe(true);
    expect((gone as AppError).code).toBe('INTERNAL');
    expect((failed as AppError).code).toBe('INTERNAL');
    for (const mapped of [busy, gone, failed]) {
      expect((mapped as AppError).message).not.toContain('CANARY');
      expect((mapped as AppError).detail).not.toContain('CANARY');
    }
    // An error that is none of the worker's is not disguised.
    expect(other).not.toBeInstanceOf(AppError);
  });

  it('M1-09 AC-10 shows a capture only to its owner', async () => {
    const { store } = setup();
    const mine = await store.create(OWNER, input());
    await store.append(OWNER, mine.id, [sampleMessage(1)]);
    await store.flush();

    expect(await store.capture('user-2', mine.id)).toBeUndefined();
    expect(
      await store.query('user-2', { captureId: mine.id, limit: 10 }),
    ).toEqual({ items: [] });
    expect((await store.list('user-2', { limit: 10 })).items).toEqual([]);
    await expect(
      store.append('user-2', mine.id, [sampleMessage(2)]),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(
      await store.get('user-2', mine.id, sampleMessage(1).id ?? ''),
    ).toBeUndefined();
    expect(await store.remove('user-2', mine.id)).toBeUndefined();
    expect(
      (await store.list(OWNER, { limit: 10 })).items.map((c) => c.id),
    ).toEqual([mine.id]);
  });

  it('M1-09 AC-4 purges expired captures with their messages and blobs, and leaves the rest', async () => {
    const clock = { now: 1_000_000 };
    const { store } = setup({ retentionMs: 1000 }, { clock });
    const soon = await store.create(OWNER, input());
    const later = await store.create(OWNER, input({ retentionMs: 60_000 }));
    const memory = await store.create(OWNER, input({ persist: 'volatile' }));
    for (const [n, capture] of [soon, later, memory].entries()) {
      await store.append(OWNER, capture.id, [
        sampleMessage(n + 1, { body: pattern(INLINE_MAX_BYTES + 5) }),
      ]);
    }
    await store.flush();

    clock.now += 2000;
    const purged = await store.purgeExpired(10);

    expect(purged).toMatchObject({ captures: 2, messages: 1 });
    expect(await store.capture(OWNER, soon.id)).toBeUndefined();
    expect(await store.capture(OWNER, memory.id)).toBeUndefined();
    expect(await store.capture(OWNER, later.id)).toMatchObject({ messages: 1 });
  });

  it('M1-09 AC-4 gives a saved capture its retention, 7 days by default', async () => {
    const { store } = setup();

    const view = await store.create(OWNER, input());

    expect(view.expiresAt - view.createdAt).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('M1-09 AC-1 returns the body, the properties and the headers of a message, and only small bodies by default', async () => {
    const { store } = setup();
    const capture = await store.create(OWNER, input());
    const small = pattern(500);
    const large = pattern(2 * 1024 * 1024);
    await store.append(OWNER, capture.id, [
      sampleMessage(1, {
        body: small,
        headers: { 'x-n': 1, nested: { a: [1, 'b', null] } },
      }),
      sampleMessage(2, { body: large }),
    ]);
    await store.flush();

    const one = await store.get(OWNER, capture.id, sampleMessage(1).id ?? '');
    const two = await store.get(OWNER, capture.id, sampleMessage(2).id ?? '');
    const twoFull = await store.get(
      OWNER,
      capture.id,
      sampleMessage(2).id ?? '',
      {
        maxBodyBytes: 4 * 1024 * 1024,
      },
    );

    expect(one?.body).toEqual(small);
    expect(one?.headers).toEqual({ 'x-n': 1, nested: { a: [1, 'b', null] } });
    expect(two?.body).toBeUndefined();
    expect(two?.summary.bodyState).toBe('blob');
    expect(same(twoFull?.body ?? new Uint8Array(), large)).toBe(true);
    expect(
      await store.get(OWNER, capture.id, 'missing-id-0001'),
    ).toBeUndefined();
  });

  it('M1-09 AC-3 cannot open a message whose sealed values were moved or altered, and says nothing about why', async () => {
    const { repo, store } = setup();
    const capture = await store.create(OWNER, input());
    await store.append(OWNER, capture.id, [sampleMessage(1), sampleMessage(2)]);
    await store.flush();
    const a = await repo.getMessage(
      OWNER,
      capture.id,
      sampleMessage(1).id ?? '',
    );
    const original = repo.getMessage.bind(repo);
    // The repository now hands out message 1's sealed bodies under message 2's id.
    repo.getMessage = async (owner, cid, id) => {
      const found = await original(owner, cid, id);
      return id === sampleMessage(2).id &&
        found !== undefined &&
        a !== undefined
        ? { ...found, bodySealed: a.bodySealed, metaSealed: a.metaSealed }
        : found;
    };

    const moved = await store
      .get(OWNER, capture.id, sampleMessage(2).id ?? '')
      .catch((error: unknown) => error);

    expect(moved).toBeInstanceOf(AppError);
    expect((moved as AppError).code).toBe('INTERNAL');
    expect((moved as Error).message).not.toMatch(/aes|tag|gcm|row|column/i);
    await expect(
      store.get(OWNER, capture.id, sampleMessage(1).id ?? ''),
    ).resolves.toBeDefined();
  });

  it('M1-09 AC-5 leaves a canary secret in no plain value, sealed byte, log line, error or Problem', async () => {
    const canary = 'CANARY-0b8e61d4-do-not-leak';
    const known = 'pa55-phrase-known-value';
    const { repo, fake, store, lines } = setup();
    const scanner = createCanaryScanner([canary, known]);
    const capture = await store.create(OWNER, input({ label: 'canary run' }));
    const secretMessage = (n: number) =>
      sampleMessage(n, {
        properties: { messageId: `m-${String(n)}`, appId: 'shop' },
        headers: {
          Authorization: `Bearer ${canary}`,
          'x-api-key': canary,
          'x-trace': 'abc',
        },
        body: new TextEncoder().encode(
          JSON.stringify({
            city: 'London',
            password: canary,
            card: { token: canary },
            memo: `see ${known}`,
            url: `amqps://bob:${canary}@broker/vhost`,
          }),
        ),
      });

    await store.append(OWNER, capture.id, [1, 2, 3].map(secretMessage), {
      secretValues: [known],
    });
    await store.flush();
    const found = await store.query(OWNER, {
      captureId: capture.id,
      text: 'london',
      limit: 10,
    });
    const detail = await store.get(OWNER, capture.id, found.items[0]?.id ?? '');
    const errors: string[] = [];
    const record = (e: unknown): void => {
      errors.push(
        e instanceof Error
          ? `${e.name} ${e.message} ${JSON.stringify(e)}`
          : String(e),
      );
    };
    fake.lock();
    await store
      .append(OWNER, capture.id, [secretMessage(9)], { secretValues: [known] })
      .catch(record);
    await store.get(OWNER, capture.id, found.items[0]?.id ?? '').catch(record);
    fake.unlock();
    await store.get('user-2', capture.id, 'x').catch(record);
    await store
      .append(OWNER, 'no-such-capture', [secretMessage(10)])
      .catch(record);
    await store.blob(OWNER, 'e'.repeat(64), 0, 1).catch(record);
    repo.failAppends(1);
    await store.append(OWNER, capture.id, [secretMessage(11)], {
      secretValues: [known],
    });
    await store.flush();

    expect(found.items).toHaveLength(3);
    // What the repository holds in the clear.
    expect(scanner.scan(repo.dump())).toEqual([]);
    expect(repo.dump()).toContain('London');
    // What the repository holds sealed.
    for (const id of [1, 2, 3].map((n) => sampleMessage(n).id ?? '')) {
      const stored = await repo.getMessage(OWNER, capture.id, id);
      expect(scanner.scan(stored?.metaSealed ?? new Uint8Array())).toEqual([]);
      expect(scanner.scan(stored?.bodySealed ?? new Uint8Array())).toEqual([]);
    }
    // What the store says out loud.
    expect(scanner.scan(lines.join('\n'))).toEqual([]);
    expect(lines.join('\n')).toContain('could not be written');
    expect(errors).toHaveLength(4);
    expect(scanner.scan(errors.join('\n'))).toEqual([]);
    expect(scanner.scan(JSON.stringify(found))).toEqual([]);
    // The owner still gets the real values back: sealing is not redaction.
    expect(JSON.stringify(detail?.headers)).toContain(canary);
    expect(Buffer.from(detail?.body ?? []).toString()).toContain(canary);
  });

  it('M1-09 AC-9 rejects a bad capture description and a message it cannot represent, and caps what an owner can open', async () => {
    const { store } = setup({ maxCapturesPerOwner: 2, volatileMaxCaptures: 1 });
    const capture = await store.create(OWNER, input());

    await expect(
      store.create(OWNER, input({ kind: 'Bad Kind' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      store.create(OWNER, input({ label: '' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      store.create(OWNER, input({ target: { big: 'x'.repeat(5000) } })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await store.create(OWNER, input());
    await expect(store.create(OWNER, input())).rejects.toMatchObject({
      code: 'BUDGET_EXCEEDED',
    });
    await store.create(OWNER, input({ persist: 'volatile' }));
    await expect(
      store.create(OWNER, input({ persist: 'volatile' })),
    ).rejects.toMatchObject({
      code: 'BUDGET_EXCEEDED',
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const receipt = await store.append(OWNER, capture.id, [
      sampleMessage(1, { id: 'bad id!' }),
      sampleMessage(2, { properties: cyclic as never }),
      sampleMessage(3, { headers: { big: 'x'.repeat(300_000) } }),
      sampleMessage(4),
    ]);
    await store.flush();

    expect(receipt).toEqual({
      accepted: 1,
      refused: { queueFull: 0, tooLarge: 0, invalid: 3, locked: 0 },
    });
  });

  it('M1-09 AC-9 refuses new work after close, after writing what it had', async () => {
    const { store } = setup();
    const capture = await store.create(OWNER, input());
    await store.append(
      OWNER,
      capture.id,
      [1, 2, 3].map((n) => sampleMessage(n)),
    );

    await store.close();

    expect(await store.capture(OWNER, capture.id)).toMatchObject({
      messages: 3,
    });
    await expect(
      store.append(OWNER, capture.id, [sampleMessage(4)]),
    ).rejects.toMatchObject({
      code: 'ENGINE_SHUTTING_DOWN',
    });
    await expect(store.create(OWNER, input())).rejects.toMatchObject({
      code: 'ENGINE_SHUTTING_DOWN',
    });
    await store.close();
  });
});
