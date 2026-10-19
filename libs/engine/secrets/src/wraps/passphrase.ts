// The passphrase wrap: a KEK derived from a master password with scrypt (N=2^17, r=8, p=1 by
// default; blueprint 6.4; argon2id is the open question of spike S-07, OQ in this work package). It
// serves the container UI passphrase and the Linux desktop with no usable secret store. Derivation
// runs on the libuv thread pool (async `scrypt`), never on the event loop (I-5), one at a time: each
// takes about 128 MiB.
//
// The salt and the cost are stored with the wrapped key and read back at unwrap. Because the database
// can be edited by someone who cannot know the passphrase, the stored cost is clamped: a record that
// asks for an enormous N would otherwise make the engine allocate gigabytes.
import { randomBytes, scrypt } from 'node:crypto';

import { SecretsError } from '../errors.ts';
import type {
  KeyWrap,
  WrapBinding,
  WrapInput,
  WrappedKey,
  WrapStatus,
} from '../types.ts';
import { openKey, sealKey, zeroize } from './kek-seal.ts';

export interface ScryptCost {
  /** CPU/memory cost, a power of two. */
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

export const DEFAULT_SCRYPT_COST: ScryptCost = Object.freeze({
  N: 2 ** 17,
  r: 8,
  p: 1,
});

/** Bounds on a stored cost: weaker than this is not a KDF, stronger is a denial of service. */
const MIN_N = 2 ** 14;
const MAX_N = 2 ** 20;
const MAX_MEMORY_BYTES = 1024 * 1024 * 1024;
const SALT_BYTES = 16;

export const MIN_PASSPHRASE_CHARS = 12;
const MAX_PASSPHRASE_CHARS = 1024;

export interface PassphraseWrapOptions {
  /** Cost for new wraps. Default `DEFAULT_SCRYPT_COST`; tests lower it. */
  cost?: ScryptCost;
  /** Shortest passphrase accepted when creating a wrap. Default 12 characters. */
  minLength?: number;
}

function validCost(cost: ScryptCost, floor: number): boolean {
  return (
    Number.isInteger(cost.N) &&
    (cost.N & (cost.N - 1)) === 0 &&
    cost.N >= floor &&
    cost.N <= MAX_N &&
    Number.isInteger(cost.r) &&
    cost.r >= 1 &&
    cost.r <= 16 &&
    Number.isInteger(cost.p) &&
    cost.p >= 1 &&
    cost.p <= 4 &&
    128 * cost.N * cost.r <= MAX_MEMORY_BYTES
  );
}

function deriveKek(
  passphrase: string,
  salt: Uint8Array,
  cost: ScryptCost,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    scrypt(
      Buffer.from(passphrase.normalize('NFKC'), 'utf8'),
      salt,
      32,
      {
        N: cost.N,
        r: cost.r,
        p: cost.p,
        maxmem: 128 * cost.N * cost.r + 1024 * 1024,
      },
      (error, key) => {
        if (error) {
          reject(
            new SecretsError('INVALID_INPUT', 'the key derivation failed', {
              cause: error,
            }),
          );
        } else {
          resolve(new Uint8Array(key));
        }
      },
    );
  });
}

function requirePassphrase(input: WrapInput | undefined): string {
  const passphrase = input?.passphrase;
  if (passphrase === undefined || passphrase.length === 0) {
    throw new SecretsError('VAULT_LOCKED', 'a passphrase is needed', {
      retryable: true,
    });
  }
  if (passphrase.length > MAX_PASSPHRASE_CHARS) {
    throw new SecretsError('INVALID_INPUT', 'the passphrase is too long');
  }
  return passphrase;
}

export function createPassphraseWrap(
  options: PassphraseWrapOptions = {},
): KeyWrap {
  const cost = options.cost ?? DEFAULT_SCRYPT_COST;
  const minLength = options.minLength ?? MIN_PASSPHRASE_CHARS;
  if (!validCost(cost, MIN_N)) {
    throw new SecretsError('INVALID_INPUT', 'the scrypt cost is out of range');
  }

  // One derivation at a time (I-6): a burst of attempts queues instead of allocating N x 128 MiB.
  let tail: Promise<unknown> = Promise.resolve();
  function serialised<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work, work);
    tail = result.catch(() => undefined);
    return result;
  }

  return {
    kind: 'passphrase',
    origin: 'engine',
    status(input?: WrapInput): Promise<WrapStatus> {
      return Promise.resolve(
        input?.passphrase === undefined
          ? { state: 'needs-input', input: 'passphrase' }
          : { state: 'ready' },
      );
    },
    wrap(dek: Uint8Array, binding: WrapBinding, input?: WrapInput) {
      return serialised(async (): Promise<WrappedKey> => {
        const passphrase = requirePassphrase(input);
        if (Array.from(passphrase.normalize('NFKC')).length < minLength) {
          throw new SecretsError(
            'WEAK_PASSPHRASE',
            `the passphrase needs at least ${String(minLength)} characters`,
            { retryable: true },
          );
        }
        const salt = randomBytes(SALT_BYTES);
        const kek = await deriveKek(passphrase, salt, cost);
        try {
          return {
            params: {
              kdf: 'scrypt',
              N: cost.N,
              r: cost.r,
              p: cost.p,
              salt: salt.toString('base64'),
            },
            bytes: sealKey(kek, dek, binding),
          };
        } finally {
          zeroize(kek);
        }
      });
    },
    unwrap(wrapped: WrappedKey, binding: WrapBinding, input?: WrapInput) {
      return serialised(async () => {
        const passphrase = requirePassphrase(input);
        const { params } = wrapped;
        const stored: ScryptCost = {
          N: Number(params.N),
          r: Number(params.r),
          p: Number(params.p),
        };
        const salt =
          typeof params.salt === 'string'
            ? Buffer.from(params.salt, 'base64')
            : undefined;
        if (
          params.kdf !== 'scrypt' ||
          !validCost(stored, MIN_N) ||
          salt?.byteLength !== SALT_BYTES
        ) {
          throw new SecretsError(
            'UNWRAP_FAILED',
            'the stored key record is damaged',
          );
        }
        const kek = await deriveKek(passphrase, salt, stored);
        try {
          return openKey(kek, wrapped.bytes, binding);
        } finally {
          zeroize(kek);
        }
      });
    },
  };
}
