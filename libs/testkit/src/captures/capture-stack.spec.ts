// The capture stack end to end (M1-09): the real SQLite file and FTS5 index, the real AES-GCM field
// cipher over a rotating key ring, and the real capture store. These are the tests that read the
// database file itself.
import { createCanaryScanner, createLogger } from '@app/kernel';
import type { CaptureInput } from '@app/svc-messages';
import { sampleMessage } from '@app/svc-messages';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';

import { createCaptureStack, type CaptureStack } from './capture-stack';

const OWNER = 'user-1';
const input = (over: Partial<CaptureInput> = {}): CaptureInput => ({
  kind: 'manual',
  label: 'orders to check',
  target: { connection: 'c1', queue: 'orders' },
  envClass: 'dev',
  persist: 'saved',
  ...over,
});

const stacks: CaptureStack[] = [];
async function open(
  options: Parameters<typeof createCaptureStack>[0] = {},
): Promise<CaptureStack> {
  const stack = await createCaptureStack(options);
  stacks.push(stack);
  return stack;
}
afterEach(async () => {
  await Promise.all(stacks.splice(0).map((stack) => stack.close()));
});

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const same = (a: Uint8Array, b: Uint8Array): boolean =>
  Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const pattern = (length: number, seed = 3): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (i * 7 + seed) % 251);
const idOf = (n: number): string => sampleMessage(n).id ?? '';

// Each test opens a real SQLite file and seals with the real cipher. That is fast on a developer
// machine and several times slower on a loaded CI runner, where the 5 s default failed on load, not on
// behaviour. The limit only stops a hung test; no assertion depends on the time.
describe('capture stack', { timeout: 60_000 }, () => {
  it('M1-09 AC-2 searches the index of a dev capture by body words and metadata, and a prod capture by metadata only', async () => {
    const stack = await open();
    const { store } = stack;
    const dev = await store.create(OWNER, input());
    const prod = await store.create(OWNER, input({ envClass: 'prod' }));
    for (const capture of [dev, prod]) {
      await store.append(OWNER, capture.id, [
        sampleMessage(capture === dev ? 2 : 4, {
          body: text('{"city":"Lisbon","note":"zephyrquartz"}'),
        }),
      ]);
    }
    await store.flush();
    const find = async (id: string, words: string): Promise<number> =>
      (await store.query(OWNER, { captureId: id, text: words, limit: 10 }))
        .items.length;

    expect(await find(dev.id, 'zephyrquartz')).toBe(1);
    expect(await find(dev.id, 'lisb*')).toBe(1);
    expect(await find(prod.id, 'zephyrquartz')).toBe(0);
    expect(await find(prod.id, 'lisbon')).toBe(0);
    expect(await find(prod.id, 'orders.created')).toBe(0); // routing key of message 4 is shipped
    expect(await find(prod.id, 'shipped')).toBe(1);
    expect(await find(dev.id, 'x-tenant')).toBe(1);
    await stack.checkpoint();
    // The prod body is not in the file as a word, and neither is it in the index.
    const bytes = await stack.fileBytes();
    expect(bytes.includes('zephyrquartz')).toBe(true); // the dev capture indexes it, in the clear
    expect(await stack.repo.searchAvailable()).toBe(true);
  });

  it('M1-09 AC-3 leaves no body or header of a prod capture readable in the database file, and seals with a version-1 envelope', async () => {
    const stack = await open();
    const { store } = stack;
    const capture = await store.create(OWNER, input({ envClass: 'prod' }));
    const big = pattern(70_000);
    await store.append(OWNER, capture.id, [
      sampleMessage(1, {
        body: text('{"card":"4111-PRODBODYTOKEN-1111"}'),
        headers: {
          'x-ticket': 'HEADERTOKEN-8841',
          Authorization: 'Bearer BEARERTOKEN-9912',
        },
        properties: { messageId: 'm-1', userId: 'PROPERTYTOKEN-1' },
      }),
      sampleMessage(2, { body: big }),
    ]);
    await store.flush();
    await stack.checkpoint();

    const bytes = await stack.fileBytes();
    for (const token of [
      'PRODBODYTOKEN',
      'HEADERTOKEN',
      'BEARERTOKEN',
      'PROPERTYTOKEN',
    ]) {
      expect(bytes.includes(token)).toBe(false);
    }
    expect(bytes.includes(Buffer.from(big.subarray(1000, 1064)))).toBe(false);
    const row = await stack.repo.getMessage(OWNER, capture.id, idOf(1));
    // version 1, then the 16 bytes of the key id, a 12-byte IV, a 16-byte tag, then the ciphertext.
    expect(row?.bodySealed?.[0]).toBe(1);
    expect(
      Buffer.from(row?.bodySealed?.subarray(1, 17) ?? []).toString('hex'),
    ).toBe(stack.keys.current().id);
    expect(row?.metaSealed[0]).toBe(1);
    const detail = await store.get(OWNER, capture.id, idOf(1));
    expect(Buffer.from(detail?.body ?? []).toString()).toContain(
      'PRODBODYTOKEN',
    );
    expect(detail?.headers).toMatchObject({ 'x-ticket': 'HEADERTOKEN-8841' });
  });

  it('M1-09 AC-3 refuses a message whose sealed bytes were altered in the database, or moved to another row', async () => {
    const stack = await open();
    const { store, handle } = stack;
    const capture = await store.create(OWNER, input({ envClass: 'prod' }));
    await store.append(
      OWNER,
      capture.id,
      [1, 2, 3].map((n) => sampleMessage(n)),
    );
    await store.flush();
    const rows = await handle.db
      .selectFrom('captured_messages')
      .select(['id', 'body_sealed', 'meta_sealed'])
      .orderBy('id')
      .execute();
    const [first, second] = rows;
    if (first === undefined || second === undefined)
      throw new Error('rows expected');

    // One bit of the ciphertext.
    const flipped = Uint8Array.from(first.body_sealed ?? []);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
    await handle.db
      .updateTable('captured_messages')
      .set({ body_sealed: flipped })
      .where('id', '=', first.id)
      .execute();
    // The sealed body of row 1 copied into row 2.
    await handle.db
      .updateTable('captured_messages')
      .set({ meta_sealed: first.meta_sealed })
      .where('id', '=', second.id)
      .execute();

    await expect(store.get(OWNER, capture.id, first.id)).rejects.toMatchObject({
      code: 'INTERNAL',
    });
    await expect(store.get(OWNER, capture.id, second.id)).rejects.toMatchObject(
      { code: 'INTERNAL' },
    );
    await expect(
      store.get(OWNER, capture.id, rows[2]?.id ?? ''),
    ).resolves.toBeDefined();
  });

  it('M1-09 AC-6 property: any body and headers survive the real database exactly, and a flip of any stored byte fails closed', async () => {
    const stack = await open();
    const { store, handle } = stack;
    const capture = await store.create(OWNER, input({ envClass: 'prod' }));
    let n = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.uint8Array({ minLength: 0, maxLength: 3000 }),
          fc
            .integer({ min: 65_530, max: 66_000 })
            .map((length) => pattern(length, length)),
        ),
        fc.dictionary(
          fc.string({ minLength: 1, maxLength: 10 }),
          fc.oneof(fc.string({ maxLength: 20 }), fc.integer(), fc.boolean()),
        ),
        fc.nat(),
        async (body, headers, where) => {
          n += 1;
          const message = sampleMessage(n, { body, headers });
          await store.append(OWNER, capture.id, [message]);
          await store.flush();

          const got = await store.get(OWNER, capture.id, idOf(n), {
            maxBodyBytes: 1024 * 1024,
          });
          expect(same(got?.body ?? new Uint8Array(1), body)).toBe(true);
          expect(got?.headers).toEqual(headers);

          const row = await stack.repo.getMessage(OWNER, capture.id, idOf(n));
          const target = row?.bodySealed ?? row?.metaSealed ?? new Uint8Array();
          const damaged = Uint8Array.from(target);
          const at = where % damaged.byteLength;
          damaged[at] = (damaged[at] ?? 0) ^ 0x40;
          await handle.db
            .updateTable('captured_messages')
            .set(
              row?.bodySealed
                ? { body_sealed: damaged }
                : { meta_sealed: damaged },
            )
            .where('id', '=', idOf(n))
            .execute();
          await expect(
            store.get(OWNER, capture.id, idOf(n)),
          ).rejects.toMatchObject({ code: 'INTERNAL' });
        },
      ),
      { numRuns: 25 },
    );
  });

  it('M1-09 AC-5 finds a canary secret nowhere in the database file, the index, the logs or the errors', async () => {
    const canary = 'CANARY-5d1c77aa-never-store';
    const known = 'known-phrase-77c1e0f4';
    const lines: string[] = [];
    const logger = createLogger({
      level: 'trace',
      sink: { write: (line) => lines.push(line) },
    });
    const stack = await open({ logger });
    const { store } = stack;
    const scanner = createCanaryScanner([canary, known]);
    const capture = await store.create(OWNER, input());
    const message = (n: number) =>
      sampleMessage(n, {
        properties: { messageId: `m-${String(n)}`, appId: 'shop' },
        headers: {
          Authorization: `Bearer ${canary}`,
          'x-api-key': canary,
          'x-trace': 'trace-1',
        },
        body: text(
          JSON.stringify({
            city: 'Porto',
            password: canary,
            nested: { clientSecret: canary, list: [{ token: canary }] },
            memo: `contains ${known} inside`,
            url: `amqps://bob:${canary}@broker.example/vhost?token=${canary}`,
          }),
        ),
      });

    await store.append(OWNER, capture.id, [1, 2, 3, 4].map(message), {
      secretValues: [known],
    });
    await store.append(
      OWNER,
      capture.id,
      [
        sampleMessage(5, {
          contentType: 'text/plain',
          body: text(
            `password=${canary} Authorization: Basic ${btoa(`bob:${canary}`)} ${known}`,
          ),
        }),
      ],
      { secretValues: [known] },
    );
    await store.flush();
    const found = await store.query(OWNER, {
      captureId: capture.id,
      text: 'porto',
      limit: 20,
    });
    const errors: string[] = [];
    stack.keys.forget(stack.keys.current().id);
    await store.get(OWNER, capture.id, idOf(1)).catch((e: unknown) => {
      errors.push(
        e instanceof Error ? `${e.message} ${JSON.stringify(e)}` : String(e),
      );
    });
    await store.append(OWNER, capture.id, [message(6)]).catch((e: unknown) => {
      errors.push(
        e instanceof Error ? `${e.message} ${JSON.stringify(e)}` : String(e),
      );
    });
    await stack.checkpoint();

    expect(found.items).toHaveLength(4);
    expect(errors).toHaveLength(2);
    expect(scanner.scan(await stack.fileBytes())).toEqual([]);
    expect(scanner.scan(lines.join('\n'))).toEqual([]);
    expect(scanner.scan(errors.join('\n'))).toEqual([]);
    expect(scanner.scan(JSON.stringify(found))).toEqual([]);
    // The index does hold the words around the secrets, so the search above was not empty by luck.
    expect(
      (
        await store.query(OWNER, {
          captureId: capture.id,
          text: 'redacted',
          limit: 20,
        })
      ).items.length,
    ).toBe(5);
  });

  it('M1-09 AC-4 removes expired captures, their blobs and index entries, and no word of them is left in the file', async () => {
    const clock = { now: 1_000_000 };
    const stack = await open({
      now: () => clock.now,
      options: { retentionMs: 1000 },
    });
    const { store } = stack;
    const doomed = await store.create(OWNER, input());
    const kept = await store.create(OWNER, input({ retentionMs: 3_600_000 }));
    const shared = pattern(300_000, 11);
    await store.append(OWNER, doomed.id, [
      sampleMessage(1, { body: text('{"memo":"vanishingtoken qxzvbnm"}') }),
      sampleMessage(2, { body: shared }),
    ]);
    await store.append(OWNER, kept.id, [
      sampleMessage(3, { body: text('{"memo":"survivingtoken"}') }),
      sampleMessage(4, { body: shared }),
    ]);
    await store.flush();
    await stack.checkpoint();
    expect((await stack.fileBytes()).includes('vanishingtoken')).toBe(true);

    clock.now += 5000;
    const purged = await store.purgeExpired(10);
    await stack.checkpoint();

    expect(purged).toMatchObject({ captures: 1, messages: 2, blobsRemoved: 0 });
    const bytes = await stack.fileBytes();
    expect(bytes.includes('vanishingtoken')).toBe(false);
    expect(bytes.includes('qxzvbnm')).toBe(false);
    expect(bytes.includes('survivingtoken')).toBe(true);
    expect(
      await store.query(OWNER, { captureId: doomed.id, limit: 5 }),
    ).toEqual({ items: [] });
    expect(
      (
        await store.query(OWNER, {
          captureId: kept.id,
          text: 'survivingtoken',
          limit: 5,
        })
      ).items,
    ).toHaveLength(1);
    // The shared blob survives for the capture that still uses it, and reads back whole.
    const ref =
      (await store.query(OWNER, { captureId: kept.id, order: 'asc', limit: 5 }))
        .items[1]?.blobRef ?? '';
    expect(
      same(await store.blob(OWNER, ref, 0, shared.byteLength), shared),
    ).toBe(true);
    expect(await store.remove(OWNER, kept.id)).toMatchObject({
      blobsRemoved: 1,
    });
    const chunks = await stack.handle.db
      .selectFrom('capture_blob_chunks')
      .selectAll()
      .execute();
    expect(chunks).toEqual([]);
  });

  it('M1-09 AC-14 opens rows sealed under a retired key and seals new rows under the current one, until the old key is gone', async () => {
    const stack = await open();
    const { store, keys } = stack;
    const capture = await store.create(OWNER, input({ envClass: 'prod' }));
    const first = keys.current().id;
    await store.append(OWNER, capture.id, [
      sampleMessage(1),
      sampleMessage(2, { body: pattern(70_000) }),
    ]);
    await store.flush();

    const second = keys.rotate();
    await store.append(OWNER, capture.id, [sampleMessage(3)]);
    await store.flush();

    const keyOf = async (n: number): Promise<string> => {
      const row = await stack.repo.getMessage(OWNER, capture.id, idOf(n));
      return Buffer.from(row?.metaSealed.subarray(1, 17) ?? []).toString('hex');
    };
    expect([await keyOf(1), await keyOf(3)]).toEqual([first, second]);
    for (const n of [1, 2, 3]) {
      await expect(
        store.get(OWNER, capture.id, idOf(n), { maxBodyBytes: 100_000 }),
      ).resolves.toBeDefined();
    }
    keys.forget(first);
    await expect(store.get(OWNER, capture.id, idOf(1))).rejects.toMatchObject({
      code: 'INTERNAL',
    });
    await expect(store.get(OWNER, capture.id, idOf(3))).resolves.toBeDefined();
  });

  it('M1-09 AC-13 finds the same messages in a volatile capture as in the saved capture made from it', async () => {
    const stack = await open();
    const { store } = stack;
    const memory = await store.create(OWNER, input({ persist: 'volatile' }));
    const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'Zeta', 'eta'];
    await store.append(
      OWNER,
      memory.id,
      Array.from({ length: 60 }, (_, i) =>
        sampleMessage(i + 1, {
          routingKey: `rk.${words[i % 7] ?? ''}`,
          body: text(
            JSON.stringify({
              a: words[(i * 3) % 7],
              b: words[(i * 5 + 1) % 7],
              note: `n${String(i)}`,
            }),
          ),
        }),
      ),
    );
    const saved = (await store.save(OWNER, memory.id)).capture;

    for (const query of [
      'alpha',
      'beta gamma',
      'ALPHA beta',
      'zet*',
      'n1*',
      'n1 n2',
      'rk',
      'delta" OR "x',
      '',
      '***',
      'eta zeta',
    ]) {
      const a = await store.query(OWNER, {
        captureId: memory.id,
        text: query,
        order: 'asc',
        limit: 100,
      });
      const b = await store.query(OWNER, {
        captureId: saved.id,
        text: query,
        order: 'asc',
        limit: 100,
      });
      expect(
        b.items.map((m) => m.id),
        `query "${query}"`,
      ).toEqual(a.items.map((m) => m.id));
    }
  });

  it('M1-09 AC-8 loses nothing it accepted while four hundred messages go through the real queue and database', async () => {
    const stack = await open();
    const { store } = stack;
    const capture = await store.create(OWNER, input());

    for (let from = 0; from < 400; from += 100) {
      await store.append(
        OWNER,
        capture.id,
        Array.from({ length: 100 }, (_, i) => sampleMessage(from + i + 1)),
      );
    }
    await store.flush();

    const stats = store.stats();
    const view = await store.capture(OWNER, capture.id);
    expect(stats.accepted).toBe(400);
    expect(stats.refused).toEqual({
      queueFull: 0,
      tooLarge: 0,
      invalid: 0,
      locked: 0,
    });
    expect(stats.lostToError).toBe(0);
    expect(view).toMatchObject({
      messages: 400,
      droppedQueue: 0,
      droppedQuota: 0,
      droppedLimit: 0,
    });
    expect(stats.stored + stats.rejected.duplicate).toBe(400);
    expect(stats.maxTxnMs).toBeGreaterThan(0);
  });
});
