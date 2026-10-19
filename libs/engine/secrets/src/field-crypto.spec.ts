import { createDecipheriv, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { SecretsError } from './errors.ts';
import {
  createAadCipher,
  createFieldCipher,
  ENVELOPE_OVERHEAD,
  fieldAad,
  KEY_BYTES,
  MAX_PLAINTEXT_BYTES,
} from './field-crypto.ts';
import type { KeyRing } from './types.ts';

const KEY_A = {
  id: 'a'.repeat(32),
  key: new Uint8Array(randomBytes(KEY_BYTES)),
};
const KEY_B = {
  id: 'b'.repeat(32),
  key: new Uint8Array(randomBytes(KEY_BYTES)),
};

function ring(
  current: { id: string; key: Uint8Array } = KEY_A,
  all = [KEY_A, KEY_B],
): KeyRing {
  return {
    current: () => current,
    byId: (id) => all.find((key) => key.id === id)?.key,
  };
}

const text = (value: string) => new TextEncoder().encode(value);

async function failure(work: Promise<unknown>): Promise<SecretsError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(SecretsError);
    return error as SecretsError;
  }
  throw new Error('expected a SecretsError');
}

describe('field encryption', () => {
  const cipher = createFieldCipher(ring());

  it('round-trips a value under its own table, column and row', async () => {
    const sealed = await cipher.seal(
      'connection_profiles',
      'password',
      'row-1',
      text('hunter2'),
    );
    expect(
      new TextDecoder().decode(
        await cipher.open('connection_profiles', 'password', 'row-1', sealed),
      ),
    ).toBe('hunter2');
    expect(sealed.byteLength).toBe(ENVELOPE_OVERHEAD + 7);
  });

  it('round-trips an empty value and one at the size limit', async () => {
    const empty = await cipher.seal('t', 'c', 'r', new Uint8Array(0));
    expect((await cipher.open('t', 'c', 'r', empty)).byteLength).toBe(0);
    const big = new Uint8Array(MAX_PLAINTEXT_BYTES).fill(7);
    const sealedBig = await cipher.seal('t', 'c', 'r', big);
    // `equals`, not toEqual: a failing diff of 16 MiB would take the test worker down.
    const opened = await cipher.open('t', 'c', 'r', sealedBig);
    expect(Buffer.from(opened).equals(Buffer.from(big))).toBe(true);
  });

  it('refuses a value over the size limit', async () => {
    const error = await failure(
      cipher.seal('t', 'c', 'r', new Uint8Array(MAX_PLAINTEXT_BYTES + 1)),
    );
    expect(error.code).toBe('INVALID_INPUT');
  });

  it('AC-1 a ciphertext moved to another row fails AAD verification', async () => {
    const sealed = await cipher.seal(
      'plans',
      'payload',
      'plan-1',
      text('body'),
    );
    const error = await failure(
      cipher.open('plans', 'payload', 'plan-2', sealed),
    );
    expect(error.code).toBe('DECRYPT_FAILED');
  });

  it('AC-1 a ciphertext moved to another column fails AAD verification', async () => {
    const sealed = await cipher.seal(
      'plans',
      'payload',
      'plan-1',
      text('body'),
    );
    const error = await failure(
      cipher.open('plans', 'preview', 'plan-1', sealed),
    );
    expect(error.code).toBe('DECRYPT_FAILED');
  });

  it('AC-1 a ciphertext moved to another table fails AAD verification', async () => {
    const sealed = await cipher.seal(
      'plans',
      'payload',
      'plan-1',
      text('body'),
    );
    const error = await failure(
      cipher.open('captures', 'payload', 'plan-1', sealed),
    );
    expect(error.code).toBe('DECRYPT_FAILED');
  });

  it('AC-1 two rows swapped with each other do not open', async () => {
    const one = await cipher.seal('t', 'c', 'row-1', text('one'));
    const two = await cipher.seal('t', 'c', 'row-2', text('two'));
    expect((await failure(cipher.open('t', 'c', 'row-1', two))).code).toBe(
      'DECRYPT_FAILED',
    );
    expect((await failure(cipher.open('t', 'c', 'row-2', one))).code).toBe(
      'DECRYPT_FAILED',
    );
  });

  it('names that differ only by where the separator falls are not the same place', () => {
    expect(() => fieldAad('a:b', 'c', 'd')).toThrow(SecretsError);
    expect(() => fieldAad('a', 'b:c', 'd')).toThrow(SecretsError);
    expect(fieldAad('a', 'b', 'c:d')).toBe('a:b:c:d');
    expect(() => fieldAad('A', 'b', 'c')).toThrow(SecretsError);
    expect(() => fieldAad('a', 'b', '')).toThrow(SecretsError);
    expect(() => fieldAad('a', 'b', 'x'.repeat(900))).toThrow(SecretsError);
  });

  it('changing any byte of a sealed value makes it fail, whichever region it is in', async () => {
    const sealed = await cipher.seal('t', 'c', 'r', text('a secret value'));
    for (let index = 0; index < sealed.byteLength; index += 1) {
      const altered = new Uint8Array(sealed);
      altered[index] = (altered[index] ?? 0) ^ 0x01;
      const error = await failure(cipher.open('t', 'c', 'r', altered));
      // A flipped key id names a key that is not held; every other flip fails authentication.
      expect(['DECRYPT_FAILED', 'KEY_NOT_FOUND']).toContain(error.code);
    }
  });

  it('authenticates the header: the key id is part of the authenticated data, not just a lookup', async () => {
    // Two ids that map to the same key material: only the header's place in the AAD can tell a
    // value sealed under one id from the same bytes relabelled with the other.
    const SHARED = new Uint8Array(randomBytes(KEY_BYTES));
    const twin = { id: 'c'.repeat(32), key: SHARED };
    const original = { id: 'd'.repeat(32), key: SHARED };
    const both = ring(original, [original, twin]);
    const sealed = await createFieldCipher(both).seal('t', 'c', 'r', text('v'));

    const relabelled = new Uint8Array(sealed);
    relabelled.set(Buffer.from(twin.id, 'hex'), 1);

    const error = await failure(
      createFieldCipher(both).open('t', 'c', 'r', relabelled),
    );
    expect(error.code).toBe('DECRYPT_FAILED');
  });

  it('rejects truncated, extended, empty and unknown-version values', async () => {
    const sealed = await cipher.seal('t', 'c', 'r', text('value'));
    for (const bad of [
      new Uint8Array(0),
      sealed.subarray(0, ENVELOPE_OVERHEAD - 1),
      sealed.subarray(0, sealed.byteLength - 1),
      Uint8Array.of(...sealed, 0),
      Uint8Array.of(2, ...sealed.subarray(1)),
    ]) {
      expect((await failure(cipher.open('t', 'c', 'r', bad))).code).toBe(
        'DECRYPT_FAILED',
      );
    }
  });

  it('uses a new IV for every seal, so equal values do not look equal', async () => {
    const ivs = new Set<string>();
    const bodies = new Set<string>();
    for (let count = 0; count < 500; count += 1) {
      const sealed = await cipher.seal('t', 'c', 'r', text('same'));
      ivs.add(Buffer.from(sealed.subarray(17, 29)).toString('hex'));
      bodies.add(Buffer.from(sealed).toString('hex'));
    }
    expect(ivs.size).toBe(500);
    expect(bodies.size).toBe(500);
  });

  it('keeps the plaintext out of the sealed bytes', async () => {
    const secret = 'correct-horse-battery-staple';
    const sealed = await cipher.seal('t', 'c', 'r', text(secret));
    expect(Buffer.from(sealed).includes(Buffer.from(secret))).toBe(false);
  });

  it('follows the documented format: an independent AES-256-GCM read opens it', async () => {
    const sealed = await cipher.seal('t', 'c', 'r', text('format check'));
    const header = Buffer.from(sealed.subarray(0, 17));
    expect(header[0]).toBe(1);
    expect(header.subarray(1).toString('hex')).toBe(KEY_A.id);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      KEY_A.key,
      sealed.subarray(17, 29),
    );
    decipher.setAAD(Buffer.concat([header, Buffer.from('t:c:r')]));
    decipher.setAuthTag(sealed.subarray(29, 45));
    const plain = Buffer.concat([
      decipher.update(sealed.subarray(45)),
      decipher.final(),
    ]);
    expect(plain.toString()).toBe('format check');
  });

  it('opens a value sealed under a retired key and seals new ones under the current key', async () => {
    const oldCipher = createFieldCipher(ring(KEY_A));
    const newCipher = createFieldCipher(ring(KEY_B));
    const old = await oldCipher.seal('t', 'c', 'r', text('old'));
    expect(
      new TextDecoder().decode(await newCipher.open('t', 'c', 'r', old)),
    ).toBe('old');
    const fresh = await newCipher.seal('t', 'c', 'r', text('new'));
    expect(Buffer.from(fresh.subarray(1, 17)).toString('hex')).toBe(KEY_B.id);
  });

  it('says the same thing for a wrong row, a wrong key and altered bytes', async () => {
    const sealed = await cipher.seal('t', 'c', 'r', text('v'));
    const wrongRow = await failure(cipher.open('t', 'c', 'other', sealed));
    const stranger = createFieldCipher(
      ring(KEY_A, [{ id: KEY_A.id, key: new Uint8Array(KEY_BYTES).fill(9) }]),
    );
    const wrongKey = await failure(stranger.open('t', 'c', 'r', sealed));
    const altered = new Uint8Array(sealed);
    altered[altered.byteLength - 1] =
      (altered[altered.byteLength - 1] ?? 0) ^ 1;
    const tampered = await failure(cipher.open('t', 'c', 'r', altered));
    expect(wrongRow.message).toBe(wrongKey.message);
    expect(wrongRow.message).toBe(tampered.message);
    expect(wrongRow.cause).toBeUndefined();
  });

  it('fails with VAULT_LOCKED when the ring has no key', async () => {
    const locked: KeyRing = {
      current: () => {
        throw new SecretsError('VAULT_LOCKED', 'the vault is locked');
      },
      byId: () => undefined,
    };
    const error = await failure(
      createFieldCipher(locked).seal('t', 'c', 'r', text('v')),
    );
    expect(error.code).toBe('VAULT_LOCKED');
  });

  it('refuses a malformed current key rather than sealing under it', async () => {
    const bad = createFieldCipher({
      current: () => ({ id: 'a'.repeat(32), key: new Uint8Array(16) }),
      byId: () => undefined,
    });
    expect((await failure(bad.seal('t', 'c', 'r', text('v')))).code).toBe(
      'INVALID_INPUT',
    );
    const badId = createFieldCipher({
      current: () => ({ id: 'not-hex', key: KEY_A.key }),
      byId: () => undefined,
    });
    expect((await failure(badId.seal('t', 'c', 'r', text('v')))).code).toBe(
      'INVALID_INPUT',
    );
  });
});

describe('the kernel-shaped cipher', () => {
  it('seals with the aad the caller names, and agrees with the field cipher on table:column:rowId', async () => {
    const keys = ring();
    const fields = createFieldCipher(keys);
    const payloads = createAadCipher(keys);
    const sealed = await payloads.encrypt(
      text('plan body'),
      'plans:payload:p1',
    );
    expect(
      new TextDecoder().decode(
        await fields.open('plans', 'payload', 'p1', sealed),
      ),
    ).toBe('plan body');
    const other = await fields.seal('plans', 'payload', 'p2', text('x'));
    expect(
      new TextDecoder().decode(
        await payloads.decrypt(other, 'plans:payload:p2'),
      ),
    ).toBe('x');
  });

  it('AC-1 a plan payload opened with another plan id fails', async () => {
    const payloads = createAadCipher(ring());
    const sealed = await payloads.encrypt(text('body'), 'plans:payload:p1');
    await expect(
      payloads.decrypt(sealed, 'plans:payload:p2'),
    ).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
  });

  it('refuses an empty or oversized aad', async () => {
    const payloads = createAadCipher(ring());
    await expect(payloads.encrypt(text('v'), '')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      payloads.encrypt(text('v'), 'x'.repeat(1025)),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
