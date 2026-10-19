// The desktop wrap (blueprint 4.1, M2): the main process unwraps the data key with safeStorage and
// posts it to the engine in `ctl:init`. The engine never sees the key at rest, so the database holds
// no wrapped key for it, only a key check value: an HMAC of a fixed label under the key. It lets the
// engine tell "main delivered the key this database was made with" from "a different key", and
// reveals nothing about the key (HMAC-SHA256 under a 256-bit key). Until the key is delivered the
// wrap needs input; once delivered, `unwrap` hands back a copy.
import { createHmac, timingSafeEqual } from 'node:crypto';

import { SecretsError } from '../errors.ts';
import type {
  KeyWrap,
  WrapBinding,
  WrapInput,
  WrappedKey,
  WrapStatus,
} from '../types.ts';
import { requireKey } from './kek-seal.ts';

/** A bad key is a rejection, as the KeyWrap port promises, never a synchronous throw. */
function rejecting<T>(work: () => T): Promise<T> {
  try {
    return Promise.resolve(work());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error('failed'));
  }
}

function keyCheck(dek: Uint8Array, binding: WrapBinding): Buffer {
  return createHmac('sha256', dek)
    .update(`data_keys:key-check:v1:${binding.purpose}:${binding.dekId}`)
    .digest();
}

function delivered(input: WrapInput | undefined): Uint8Array {
  const dek = input?.dek;
  if (dek === undefined) {
    throw new SecretsError(
      'VAULT_LOCKED',
      'the desktop main process has not delivered the data key',
      { retryable: true },
    );
  }
  requireKey(dek, 'DEK');
  return dek;
}

export function createCtlDeliveredWrap(): KeyWrap {
  return {
    kind: 'ctl-delivered',
    origin: 'delivered',
    status(input?: WrapInput): Promise<WrapStatus> {
      return Promise.resolve(
        input?.dek === undefined
          ? { state: 'needs-input', input: 'dek' }
          : { state: 'ready' },
      );
    },
    wrap(dek: Uint8Array, binding: WrapBinding): Promise<WrappedKey> {
      return rejecting(() => {
        requireKey(dek, 'DEK');
        return {
          params: { check: 'hmac-sha256' },
          bytes: new Uint8Array(keyCheck(dek, binding)),
        };
      });
    },
    unwrap(wrapped: WrappedKey, binding: WrapBinding, input?: WrapInput) {
      return rejecting(() => {
        const dek = delivered(input);
        const expected = Buffer.from(wrapped.bytes);
        const actual = keyCheck(dek, binding);
        if (
          expected.byteLength !== actual.byteLength ||
          !timingSafeEqual(expected, actual)
        ) {
          throw new SecretsError(
            'UNWRAP_FAILED',
            'the delivered data key is not the one this database was made with',
          );
        }
        return new Uint8Array(dek);
      });
    },
  };
}
