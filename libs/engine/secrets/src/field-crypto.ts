// Field encryption (DC-45, ADR-014, blueprint 6.4): AES-256-GCM under a data key, with the
// authenticated data bound to the place the value lives, `table:column:rowId`. A ciphertext copied
// to another row or column therefore fails to open instead of decrypting to somebody else's value.
//
// Envelope (all of it stored in one bytes column):
//
//   byte 0        format version (1)
//   bytes 1..16   id of the data key, 16 raw bytes (the 32 hex characters of the DataKeyRecord id)
//   bytes 17..28  IV, 12 random bytes, new for every seal
//   bytes 29..44  GCM tag
//   bytes 45..    ciphertext, the length of the plaintext
//
// The header (version and key id) is authenticated too: it is prepended to the AAD, so changing the
// key id of a stored value is a failed decryption, not a different key being tried.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { SecretsError } from './errors.ts';
import type { KeyRing } from './types.ts';

export const ENVELOPE_VERSION = 1;
const KEY_ID_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + KEY_ID_BYTES;
/** Bytes a sealed value is longer than its plaintext. */
export const ENVELOPE_OVERHEAD = HEADER_BYTES + IV_BYTES + TAG_BYTES;
/** A DEK is exactly this long: AES-256. */
export const KEY_BYTES = 32;

/**
 * The largest plaintext sealed in one piece. AES-GCM is synchronous here, so the bound also keeps one
 * call short for the event loop (I-5, I-6): about 16 MiB takes a few milliseconds. Bigger bodies are
 * chunked by their owner (captures and blobs, M1-09).
 */
export const MAX_PLAINTEXT_BYTES = 16 * 1024 * 1024;
const MAX_AAD_CHARS = 1024;

const IDENTIFIER = /^[a-z][a-z0-9_]{0,63}$/;
const KEY_ID = /^[0-9a-f]{32}$/;

/** Seals and opens the encrypted fields of one database. */
export interface FieldCipher {
  seal(
    table: string,
    column: string,
    rowId: string,
    plaintext: Uint8Array,
  ): Promise<Uint8Array>;
  /** Throws `DECRYPT_FAILED` when the value, the key or the place it is read from is not the one it was sealed for. */
  open(
    table: string,
    column: string,
    rowId: string,
    sealed: Uint8Array,
  ): Promise<Uint8Array>;
}

/**
 * The shape the kernel's PlanStore takes (`PayloadCipher`, M0-29): the caller names the authenticated
 * data itself, as `table:column:rowId`. Structurally identical, so it can be passed where one is
 * expected without the adapter importing the kernel.
 */
export interface AadCipher {
  encrypt(plaintext: Uint8Array, aad: string): Promise<Uint8Array>;
  decrypt(sealed: Uint8Array, aad: string): Promise<Uint8Array>;
}

/** The authenticated data of a field: `table:column:rowId`. Names are identifiers, so it is unambiguous. */
export function fieldAad(table: string, column: string, rowId: string): string {
  if (!IDENTIFIER.test(table) || !IDENTIFIER.test(column)) {
    throw new SecretsError(
      'INVALID_INPUT',
      'table and column are lowercase identifiers',
    );
  }
  if (rowId.length === 0 || rowId.length > MAX_AAD_CHARS - 130) {
    throw new SecretsError(
      'INVALID_INPUT',
      'rowId must be 1 to 894 characters',
    );
  }
  return `${table}:${column}:${rowId}`;
}

function checkAad(aad: string): Buffer {
  if (aad.length === 0 || aad.length > MAX_AAD_CHARS) {
    throw new SecretsError(
      'INVALID_INPUT',
      'authenticated data must be 1 to 1024 characters',
    );
  }
  return Buffer.from(aad, 'utf8');
}

function seal(keys: KeyRing, aad: string, plaintext: Uint8Array): Uint8Array {
  if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
    throw new SecretsError(
      'INVALID_INPUT',
      `plaintext is larger than ${String(MAX_PLAINTEXT_BYTES)} bytes`,
    );
  }
  const aadBytes = checkAad(aad);
  const { id, key } = keys.current();
  if (!KEY_ID.test(id) || key.byteLength !== KEY_BYTES) {
    throw new SecretsError(
      'INVALID_INPUT',
      'the current data key is malformed',
    );
  }
  const header = Buffer.alloc(HEADER_BYTES);
  header[0] = ENVELOPE_VERSION;
  header.write(id, 1, KEY_ID_BYTES, 'hex');

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(Buffer.concat([header, aadBytes]));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return new Uint8Array(Buffer.concat([header, iv, cipher.getAuthTag(), body]));
}

function open(keys: KeyRing, aad: string, sealed: Uint8Array): Uint8Array {
  const aadBytes = checkAad(aad);
  const buffer = Buffer.from(
    sealed.buffer,
    sealed.byteOffset,
    sealed.byteLength,
  );
  if (
    buffer.byteLength < ENVELOPE_OVERHEAD ||
    buffer.byteLength > ENVELOPE_OVERHEAD + MAX_PLAINTEXT_BYTES ||
    buffer[0] !== ENVELOPE_VERSION
  ) {
    throw new SecretsError('DECRYPT_FAILED', 'the value does not decrypt');
  }
  const header = buffer.subarray(0, HEADER_BYTES);
  const keyId = header.subarray(1).toString('hex');
  const key = keys.byId(keyId);
  if (key === undefined) {
    throw new SecretsError(
      'KEY_NOT_FOUND',
      'the value was sealed under a data key this vault does not hold',
    );
  }
  try {
    const iv = buffer.subarray(HEADER_BYTES, HEADER_BYTES + IV_BYTES);
    const tag = buffer.subarray(HEADER_BYTES + IV_BYTES, ENVELOPE_OVERHEAD);
    const decipher = createDecipheriv('aes-256-gcm', key, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.concat([header, aadBytes]));
    decipher.setAuthTag(tag);
    return new Uint8Array(
      Buffer.concat([
        decipher.update(buffer.subarray(ENVELOPE_OVERHEAD)),
        decipher.final(),
      ]),
    );
  } catch {
    // The cause names nothing: wrong row, wrong key and altered bytes must look the same.
    throw new SecretsError('DECRYPT_FAILED', 'the value does not decrypt');
  }
}

/** Promise wrapper: the API is async so the work can move to a worker without touching a caller (I-5). */
function later<T>(work: () => T): Promise<T> {
  try {
    return Promise.resolve(work());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error('failed'));
  }
}

export function createFieldCipher(keys: KeyRing): FieldCipher {
  return {
    seal: (table, column, rowId, plaintext) =>
      later(() => seal(keys, fieldAad(table, column, rowId), plaintext)),
    open: (table, column, rowId, sealed) =>
      later(() => open(keys, fieldAad(table, column, rowId), sealed)),
  };
}

/** The same cipher for callers that build `table:column:rowId` themselves (the kernel's PlanStore). */
export function createAadCipher(keys: KeyRing): AadCipher {
  return {
    encrypt: (plaintext, aad) => later(() => seal(keys, aad, plaintext)),
    decrypt: (sealed, aad) => later(() => open(keys, aad, sealed)),
  };
}
