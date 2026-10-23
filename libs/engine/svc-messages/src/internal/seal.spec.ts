import { AppError } from '@app/kernel';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createFakeSealer } from '../testing';
import {
  CHUNK_BYTES,
  createCaptureSealer,
  sha256Hex,
  type SealedMeta,
} from './seal';

const bytes = (length: number, seed = 7): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (i * 31 + seed) % 256);

describe('capture sealing', () => {
  it('M1-09 AC-6 property: a body and its metadata open to exactly what was sealed, and each seal differs', async () => {
    const sealer = createCaptureSealer(createFakeSealer());
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 0, maxLength: 2048 }),
        fc.dictionary(
          fc.string({ maxLength: 12 }),
          fc.string({ maxLength: 24 }),
          {
            maxKeys: 6,
          },
        ),
        fc.stringMatching(/^[0-9A-Za-z]{8,26}$/),
        async (body, headers, id) => {
          const meta: SealedMeta = { properties: { id }, headers };

          const a = await sealer.sealBody(id, body);
          const b = await sealer.sealBody(id, body);
          const m = await sealer.sealMeta(id, meta);

          expect(Buffer.from(await sealer.openBody(id, a))).toEqual(
            Buffer.from(body),
          );
          expect(Buffer.from(a)).not.toEqual(Buffer.from(b));
          expect(await sealer.openMeta(id, m)).toEqual(meta);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('M1-09 AC-6 property: one flipped byte anywhere in a sealed value fails closed, never returns data', async () => {
    const sealer = createCaptureSealer(createFakeSealer());
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 1, maxLength: 256 }),
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        async (body, where, flip) => {
          const sealed = await sealer.sealBody('01TESTMSG00000001', body);
          const damaged = Uint8Array.from(sealed);
          const at = where % damaged.byteLength;
          damaged[at] = (damaged[at] ?? 0) ^ flip;

          await expect(
            sealer.openBody('01TESTMSG00000001', damaged),
          ).rejects.toBeInstanceOf(AppError);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('M1-09 AC-3 a sealed value does not open in another row, another column or another chunk', async () => {
    const sealer = createCaptureSealer(createFakeSealer());
    const body = bytes(100);

    const sealed = await sealer.sealBody('01TESTMSG00000001', body);
    const meta = await sealer.sealMeta('01TESTMSG00000001', {
      properties: {},
      headers: {},
    });
    const chunks = await sealer.sealChunks(
      'a'.repeat(64),
      bytes(CHUNK_BYTES * 2 + 5),
    );

    await expect(
      sealer.openBody('01TESTMSG00000002', sealed),
    ).rejects.toBeInstanceOf(AppError);
    // The body column's value is not a metadata value, and the other way round.
    await expect(
      sealer.openMeta('01TESTMSG00000001', sealed),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      sealer.openBody('01TESTMSG00000001', meta),
    ).rejects.toBeInstanceOf(AppError);
    expect(chunks).toHaveLength(3);
    const first = chunks[0] ?? new Uint8Array();
    await expect(
      sealer.openChunk('a'.repeat(64), 1, first),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      sealer.openChunk('b'.repeat(64), 0, first),
    ).rejects.toBeInstanceOf(AppError);
    expect((await sealer.openChunk('a'.repeat(64), 0, first)).byteLength).toBe(
      CHUNK_BYTES,
    );
  });

  it('M1-09 AC-6 chunks of a large body open to the same bytes, in order, with a short last chunk', async () => {
    const sealer = createCaptureSealer(createFakeSealer());
    const body = bytes(CHUNK_BYTES * 3 + 123, 3);
    const ref = await sha256Hex(body);

    const chunks = await sealer.sealChunks(ref, body);

    expect(chunks).toHaveLength(4);
    const plain: Uint8Array[] = [];
    for (const [index, chunk] of chunks.entries()) {
      plain.push(await sealer.openChunk(ref, index, chunk));
    }
    expect(plain.map((p) => p.byteLength)).toEqual([
      CHUNK_BYTES,
      CHUNK_BYTES,
      CHUNK_BYTES,
      123,
    ]);
    expect(Buffer.concat(plain)).toEqual(Buffer.from(body));
    expect(await sealer.sealChunks(ref, new Uint8Array(0))).toEqual([]);
  });

  it('M1-09 AC-9 a locked vault seals nothing and says so with a Problem code, and an unreadable value says nothing about why', async () => {
    const fake = createFakeSealer();
    const sealer = createCaptureSealer(fake);
    const sealed = await sealer.sealBody('01TESTMSG00000001', bytes(10));
    fake.lock();

    const refused = await sealer
      .sealBody('01TESTMSG00000001', bytes(10))
      .catch((e: unknown) => e);
    const unreadable = await sealer
      .openBody('01TESTMSG00000001', sealed)
      .catch((e: unknown) => e);

    expect(refused).toBeInstanceOf(AppError);
    expect((refused as AppError).code).toBe('GATE_BLOCKED');
    expect((unreadable as AppError).code).toBe('INTERNAL');
    expect((unreadable as Error).message).not.toMatch(/locked|aes|tag|gcm/i);
  });

  it('M1-09 AC-5 hashes a large body in slices and gives the loop a turn between them', async () => {
    let turns = 0;
    const ticker = setInterval(() => {
      turns += 1;
    }, 0);
    const big = bytes(6 * 1024 * 1024);

    const hash = await sha256Hex(big);
    clearInterval(ticker);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(turns).toBeGreaterThan(0);
  });
});
