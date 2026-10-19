// Seals a data key under a 32-byte KEK with AES-256-GCM. Shared by the file, passphrase and keyring
// wraps; each differs only in where the KEK comes from. Layout: IV (12) | tag (16) | ciphertext (32).
// The authenticated data names the row the key is stored in (`data_keys:wrapped:<purpose>:<id>`), so
// a wrapped key moved to another row, or to another purpose, does not open.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { KEY_BYTES } from '../field-crypto.ts';
import { SecretsError } from '../errors.ts';
import type { WrapBinding } from '../types.ts';

const IV_BYTES = 12;
const TAG_BYTES = 16;
export const WRAPPED_BYTES = IV_BYTES + TAG_BYTES + KEY_BYTES;

export function wrapAad(binding: WrapBinding): Buffer {
  return Buffer.from(
    `data_keys:wrapped:${binding.purpose}:${binding.dekId}`,
    'utf8',
  );
}

export function requireKey(bytes: Uint8Array, what: 'KEK' | 'DEK'): Buffer {
  if (bytes.byteLength !== KEY_BYTES) {
    throw new SecretsError(
      'INVALID_INPUT',
      `a ${what} is exactly ${String(KEY_BYTES)} bytes`,
    );
  }
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function sealKey(
  kek: Uint8Array,
  dek: Uint8Array,
  binding: WrapBinding,
): Uint8Array {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', requireKey(kek, 'KEK'), iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(wrapAad(binding));
  const body = Buffer.concat([
    cipher.update(requireKey(dek, 'DEK')),
    cipher.final(),
  ]);
  return new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), body]));
}

/** Returns the DEK, or throws `UNWRAP_FAILED`: a wrong KEK, a moved row and altered bytes look alike. */
export function openKey(
  kek: Uint8Array,
  wrapped: Uint8Array,
  binding: WrapBinding,
): Uint8Array {
  if (wrapped.byteLength !== WRAPPED_BYTES) {
    throw new SecretsError('UNWRAP_FAILED', 'the stored key record is damaged');
  }
  const buffer = Buffer.from(
    wrapped.buffer,
    wrapped.byteOffset,
    wrapped.byteLength,
  );
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      requireKey(kek, 'KEK'),
      buffer.subarray(0, IV_BYTES),
      { authTagLength: TAG_BYTES },
    );
    decipher.setAAD(wrapAad(binding));
    decipher.setAuthTag(buffer.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return new Uint8Array(
      Buffer.concat([
        decipher.update(buffer.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]),
    );
  } catch (cause) {
    if (cause instanceof SecretsError) throw cause;
    throw new SecretsError(
      'UNWRAP_FAILED',
      'the data key does not open with this secret',
      { retryable: true },
    );
  }
}

/** Overwrites key material that is no longer needed. Best effort: a JS runtime may have copied it. */
export function zeroize(bytes: Uint8Array): void {
  bytes.fill(0);
}
