import type { JobId } from '@app/contracts';
import { createAesGcmTestCipher, createTestPrincipal } from '@app/kernel';
import type { JobRecord } from '@app/ports';
import { describe, expect, it } from 'vitest';

import {
  MAX_SEALED_BYTES,
  openCheckpoint,
  openJobInput,
  sealCheckpoint,
  sealJobInput,
  sealResult,
  type JobEnvelope,
} from './envelope.ts';

const ID = '01JOBENVELOPE00000000000A' as JobId;
const OTHER = '01JOBENVELOPE00000000000B' as JobId;

const envelope: JobEnvelope = {
  v: 1,
  type: 'replay.run',
  version: 2,
  planHash: 'a'.repeat(64),
  idempotencyKey: 'idem-key-0001',
  concurrencyKey: 'queue:orders',
  requester: createTestPrincipal({ id: 'user-1' }),
  input: { queue: 'orders', limit: 5n, body: new Uint8Array([1, 2]) },
};

function recordFor(
  sealed: Uint8Array,
  overrides: Partial<JobRecord> = {},
): JobRecord {
  return {
    id: ID,
    type: 'replay.run',
    version: 2,
    state: 'running',
    stateReason: null,
    principalId: 'user-1',
    onBehalfOfId: null,
    planHash: 'a'.repeat(64),
    idempotencyKey: 'idem-key-0001',
    concurrencyKey: 'queue:orders',
    resumable: false,
    input: sealed,
    checkpoint: null,
    result: null,
    leaseOwner: 'r',
    leaseUntil: 1,
    attempts: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('job envelope', () => {
  it('seals the input so the store sees no part of it, and opens it again with its types', async () => {
    const cipher = createAesGcmTestCipher();
    const sealed = await sealJobInput(cipher, ID, envelope);

    expect(Buffer.from(sealed).includes(Buffer.from('orders'))).toBe(false);
    const opened = await openJobInput(cipher, recordFor(sealed));
    expect(opened.input).toEqual(envelope.input);
    expect(opened.requester).toEqual(envelope.requester);
  });

  it('refuses an envelope sealed for another job (the id is authenticated)', async () => {
    const cipher = createAesGcmTestCipher();
    const sealed = await sealJobInput(cipher, OTHER, envelope);

    await expect(openJobInput(cipher, recordFor(sealed))).rejects.toThrow();
  });

  it('refuses ciphertext under another key, and edited bytes', async () => {
    const sealed = await sealJobInput(createAesGcmTestCipher(), ID, envelope);
    const cipher = createAesGcmTestCipher();
    const edited = Uint8Array.from(sealed);
    edited[edited.length - 1] = (edited[edited.length - 1] ?? 0) ^ 1;

    await expect(openJobInput(cipher, recordFor(sealed))).rejects.toThrow();
    await expect(
      openJobInput(createAesGcmTestCipher(), recordFor(edited)),
    ).rejects.toThrow();
  });

  it.each([
    ['type', { type: 'other.job' }],
    ['version', { version: 3 }],
    ['planHash', { planHash: 'b'.repeat(64) }],
    ['planHash removed', { planHash: null }],
    ['idempotencyKey', { idempotencyKey: 'idem-key-0002' }],
    ['concurrencyKey', { concurrencyKey: 'queue:other' }],
    ['concurrencyKey removed', { concurrencyKey: null }],
    ['principalId', { principalId: 'user-2' }],
    ['onBehalfOfId', { onBehalfOfId: 'user-9' }],
  ] as const)(
    'refuses a row whose %s column was edited after sealing',
    async (_name, edit) => {
      const cipher = createAesGcmTestCipher();
      const sealed = await sealJobInput(cipher, ID, envelope);

      await expect(
        openJobInput(cipher, recordFor(sealed, edit)),
      ).rejects.toMatchObject({ code: 'INTERNAL' });
    },
  );

  it('refuses an envelope that is not an envelope or carries a malformed principal', async () => {
    const cipher = createAesGcmTestCipher();
    const bad = [
      { ...envelope, v: 2 },
      { ...envelope, requester: { id: 'user-1' } },
      { ...envelope, requester: { ...envelope.requester, kind: 'root' } },
    ];
    for (const value of bad) {
      const sealed = await sealJobInput(cipher, ID, value as never);
      await expect(openJobInput(cipher, recordFor(sealed))).rejects.toThrow();
    }
    const text = await cipher.encrypt(
      new TextEncoder().encode('7'),
      `jobs:input:${ID}`,
    );
    await expect(openJobInput(cipher, recordFor(text))).rejects.toThrow();
  });

  it('seals a checkpoint and a result to the job id, so one cannot be copied to another job', async () => {
    const cipher = createAesGcmTestCipher();
    const checkpoint = await sealCheckpoint(cipher, ID, { at: 3n });
    await sealResult(cipher, ID, { done: true });

    expect(await openCheckpoint(cipher, ID, checkpoint)).toEqual({ at: 3n });
    await expect(openCheckpoint(cipher, OTHER, checkpoint)).rejects.toThrow();
  });

  it('keeps a checkpoint and an input apart: one cannot stand in for the other', async () => {
    const cipher = createAesGcmTestCipher();
    const asCheckpoint = await sealCheckpoint(cipher, ID, envelope);

    await expect(
      openJobInput(cipher, recordFor(asCheckpoint)),
    ).rejects.toThrow();
  });

  it('refuses a value over the size limit, and one JSON cannot hold', async () => {
    const cipher = createAesGcmTestCipher();

    await expect(
      sealCheckpoint(cipher, ID, 'x'.repeat(MAX_SEALED_BYTES)),
    ).rejects.toMatchObject({ code: 'TOKEN_TOO_LARGE' });
    await expect(sealCheckpoint(cipher, ID, Number.NaN)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(sealResult(cipher, ID, () => 1)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});
