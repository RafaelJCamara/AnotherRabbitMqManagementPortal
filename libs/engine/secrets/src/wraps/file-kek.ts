// The file KEK wrap (container and team modes, ADR-014 amendment): a 32-byte key-encryption key from
// a Docker secret or a mounted file. The KEK is read when a wrap or unwrap needs it and zeroed right
// after; it is not held between calls. Back it up apart from the data volume: a lost KEK means the
// stored credentials are lost (docs/runbooks/kek-escrow-and-rotation.md).
//
// Accepted file contents: exactly 32 raw bytes, or text (surrounding whitespace ignored) that is 64
// hex characters or the base64 of 32 bytes.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

import { SecretsError } from '../errors.ts';
import { KEY_BYTES } from '../field-crypto.ts';
import type { KeyWrap, WrapBinding, WrappedKey, WrapStatus } from '../types.ts';
import { openKey, sealKey, zeroize } from './kek-seal.ts';

/** A KEK file is a few dozen bytes; anything larger is not one. */
const MAX_FILE_BYTES = 4096;
const HEX = /^[0-9a-fA-F]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]{43}=?$/;

export interface FileKekWrapOptions {
  /** The file (a Docker secret is `/run/secrets/<name>`). */
  path: string;
}

/** Decodes the contents of a KEK file; exported for the tests of the accepted formats. */
export function parseKek(contents: Uint8Array): Uint8Array {
  if (contents.byteLength === KEY_BYTES) return new Uint8Array(contents);
  const text = Buffer.from(contents).toString('utf8').trim();
  let kek: Buffer | undefined;
  if (HEX.test(text)) kek = Buffer.from(text, 'hex');
  else if (BASE64.test(text)) kek = Buffer.from(text, 'base64');
  if (kek?.byteLength !== KEY_BYTES) {
    throw new SecretsError(
      'KEK_INVALID',
      'the KEK file holds neither 32 raw bytes, 64 hex characters nor 32 bytes in base64',
    );
  }
  return new Uint8Array(kek);
}

/** A short check value of the KEK, stored beside the wrapped key so a wrong file is told apart from damage. */
function kekCheck(kek: Uint8Array): string {
  return createHmac('sha256', kek)
    .update('data_keys:kek-check:v1')
    .digest()
    .subarray(0, 8)
    .toString('hex');
}

export function createFileKekWrap(options: FileKekWrapOptions): KeyWrap {
  async function readKek(): Promise<Uint8Array> {
    let contents: Buffer;
    try {
      const info = await stat(options.path);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) {
        throw new SecretsError(
          'KEK_INVALID',
          'the KEK path is not a small file',
        );
      }
      contents = await readFile(options.path);
    } catch (cause) {
      if (cause instanceof SecretsError) throw cause;
      // Neither the path nor the system error go into the error: both name it, and a log line is
      // read by more people than the configuration. The errno code is enough to act on.
      const errno = (cause as NodeJS.ErrnoException).code;
      throw new SecretsError(
        'KEK_INVALID',
        `the KEK file cannot be read${typeof errno === 'string' ? ` (${errno})` : ''}`,
      );
    }
    try {
      const kek = parseKek(contents);
      if (kek.every((byte) => byte === 0)) {
        throw new SecretsError('KEK_INVALID', 'the KEK is all zero bytes');
      }
      return kek;
    } finally {
      zeroize(contents);
    }
  }

  return {
    kind: 'file-kek',
    origin: 'engine',
    async status(): Promise<WrapStatus> {
      try {
        zeroize(await readKek());
        return { state: 'ready' };
      } catch (error) {
        if (error instanceof SecretsError) {
          return { state: 'unavailable', reason: 'kek-invalid' };
        }
        throw error;
      }
    },
    async wrap(dek: Uint8Array, binding: WrapBinding): Promise<WrappedKey> {
      const kek = await readKek();
      try {
        return {
          params: { kekCheck: kekCheck(kek) },
          bytes: sealKey(kek, dek, binding),
        };
      } finally {
        zeroize(kek);
      }
    },
    async unwrap(wrapped: WrappedKey, binding: WrapBinding) {
      const kek = await readKek();
      try {
        const expected = wrapped.params.kekCheck;
        const actual = Buffer.from(kekCheck(kek));
        if (
          typeof expected !== 'string' ||
          expected.length !== actual.byteLength ||
          !timingSafeEqual(Buffer.from(expected), actual)
        ) {
          throw new SecretsError(
            'KEK_MISMATCH',
            'the KEK file is not the one that wrapped this data key',
          );
        }
        return openKey(kek, wrapped.bytes, binding);
      } finally {
        zeroize(kek);
      }
    },
  };
}
