// The data-key vault (ADR-014, blueprint 6.4). It owns the data keys (DEKs) of one database: it
// creates the first one, stores it wrapped (never in the open), unwraps the stored ones at start, and
// hands the field cipher its keys. Rules it keeps, each with a test:
//
//   - A DEK is stored only as what a KeyWrap returned for storage. The vault writes nothing else.
//   - A stored key that cannot be opened is never replaced: no new DEK is made over an existing row,
//     because that would orphan every value sealed under the old one.
//   - A wrap that cannot protect a key here (a keyring that is `basic_text`) is skipped, and the next
//     configured wrap is used; if none is usable, nothing is created.
//   - Locking zeroes the keys in memory. The cipher then fails with VAULT_LOCKED instead of using a
//     stale key.
import { randomBytes as nodeRandomBytes } from 'node:crypto';

import type { DataKeyRecord, DataKeyRepository } from '@app/ports';

import { SecretsError } from './errors.ts';
import {
  createAadCipher,
  createFieldCipher,
  KEY_BYTES,
  type AadCipher,
  type FieldCipher,
} from './field-crypto.ts';
import type {
  KeyRing,
  KeyWrap,
  WrapBinding,
  WrapInput,
  WrapKind,
  WrappedKey,
  WrapParamValue,
} from './types.ts';
import { zeroize } from './wraps/kek-seal.ts';

export type VaultStatus =
  /** `open` has not run yet. */
  | { readonly state: 'closed' }
  | {
      readonly state: 'unlocked';
      readonly wrapKind: WrapKind;
      readonly keyId: string;
    }
  | {
      readonly state: 'locked';
      readonly wrapKind: WrapKind;
      /** What `open` needs to unlock: `nothing` means calling it again is enough (a KEK file, the keyring). */
      readonly needs: 'passphrase' | 'dek' | 'nothing';
    }
  /** No configured wrap can protect or open a key; `reason` lists why, secret-free. */
  | { readonly state: 'unavailable'; readonly reason: string };

export interface DataKeyVaultOptions {
  repository: DataKeyRepository;
  /** In order of preference. The first that is not `unavailable` creates the first key. */
  wraps: readonly KeyWrap[];
  /** What the keys are for. A lowercase identifier. Default `main`. */
  purpose?: string;
  /** Wall-clock milliseconds. Default `Date.now`. */
  now?: () => number;
  /** Test seam for key and id generation. Default `node:crypto`. */
  randomBytes?: (size: number) => Uint8Array;
}

export interface DataKeyVault {
  /**
   * Opens the vault: unwraps the stored keys, or creates the first one. Safe to call again (with
   * input, to unlock). Returns where it ended; a wrong passphrase rejects with a retryable
   * `UNWRAP_FAILED` and leaves the vault locked.
   */
  open(input?: WrapInput): Promise<VaultStatus>;
  status(): VaultStatus;
  /**
   * True when a person has to type a master password for this vault: the wrap in use is the
   * passphrase wrap, or no other wrap can work here (a keyring that reports `basic_text` or
   * `none`). Until `open` has finished it answers true (fail closed).
   */
  requiresMasterPassword(): boolean;
  /** Zeroes every key in memory. `open` with the input again unlocks. */
  lock(): void;
  /** The cipher of this vault. It fails with `VAULT_LOCKED` while the vault is not unlocked. */
  readonly fields: FieldCipher;
  /** The same cipher in the shape of the kernel's `PayloadCipher`. */
  readonly payloads: AadCipher;
}

const PURPOSE = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_PARAMS_JSON_CHARS = 2048;
const MAX_ATTEMPTS = 3;

function parseParams(json: string): WrappedKey['params'] {
  const damaged = new SecretsError(
    'UNWRAP_FAILED',
    'the stored key record is damaged',
  );
  if (json.length > MAX_PARAMS_JSON_CHARS) throw damaged;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw damaged;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw damaged;
  }
  const params: Record<string, WrapParamValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string' && typeof entry !== 'number') throw damaged;
    params[key] = entry;
  }
  return params;
}

/** Canonical (sorted-key) JSON, so the same parameters are always the same text. */
function stringifyParams(params: WrappedKey['params']): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.keys(params)
        .sort()
        .map((key) => [key, params[key]]),
    ),
  );
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function createDataKeyVault(options: DataKeyVaultOptions): DataKeyVault {
  const purpose = options.purpose ?? 'main';
  if (!PURPOSE.test(purpose)) {
    throw new SecretsError(
      'INVALID_INPUT',
      'purpose is a lowercase identifier',
    );
  }
  if (options.wraps.length === 0) {
    throw new SecretsError('INVALID_INPUT', 'at least one key wrap is needed');
  }
  const { repository, wraps } = options;
  const now = options.now ?? Date.now;
  const random = options.randomBytes ?? ((size) => nodeRandomBytes(size));

  let keys = new Map<string, Uint8Array>();
  let currentId: string | undefined;
  let status: VaultStatus = { state: 'closed' };
  /** The wrap kind the vault ended up with; undefined when none could be chosen. */
  let chosen: WrapKind | undefined;
  let opened = false;
  /** Bumped by `lock()`, so an `open` that was already running can tell it was locked meanwhile. */
  let epoch = 0;

  /** Zeroes every key in memory and reports the vault as locked. */
  function forgetKeys(): void {
    for (const key of keys.values()) zeroize(key);
    keys = new Map();
    currentId = undefined;
    status =
      chosen === undefined
        ? { state: 'closed' }
        : {
            state: 'locked',
            wrapKind: chosen,
            needs:
              chosen === 'ctl-delivered'
                ? 'dek'
                : chosen === 'passphrase'
                  ? 'passphrase'
                  : 'nothing',
          };
  }

  const ring: KeyRing = {
    current() {
      const key = currentId === undefined ? undefined : keys.get(currentId);
      if (currentId === undefined || key === undefined) {
        throw new SecretsError('VAULT_LOCKED', 'the vault is locked', {
          retryable: true,
        });
      }
      return { id: currentId, key };
    },
    byId(id) {
      if (keys.size === 0) {
        throw new SecretsError('VAULT_LOCKED', 'the vault is locked', {
          retryable: true,
        });
      }
      return keys.get(id);
    },
  };

  // One open at a time: two callers must not both find "no key" and both create one.
  let tail: Promise<unknown> = Promise.resolve();
  function serialised<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work, work);
    tail = result.catch(() => undefined);
    return result;
  }

  function commit(next: Map<string, Uint8Array>, active: DataKeyRecord): void {
    for (const key of keys.values()) zeroize(key);
    keys = next;
    currentId = active.id;
    chosen = active.wrapKind;
    status = { state: 'unlocked', wrapKind: active.wrapKind, keyId: active.id };
  }

  async function unlockStored(
    records: readonly DataKeyRecord[],
    input: WrapInput | undefined,
  ): Promise<VaultStatus> {
    const active = records.find((record) => record.state === 'active');
    if (active === undefined) {
      throw new SecretsError(
        'UNWRAP_FAILED',
        'the key store has no active data key',
      );
    }
    chosen = active.wrapKind;
    const next = new Map<string, Uint8Array>();
    try {
      for (const record of records) {
        const wrap = wraps.find(
          (candidate) => candidate.kind === record.wrapKind,
        );
        if (wrap === undefined) {
          throw new SecretsError(
            'WRAP_NOT_CONFIGURED',
            `a stored data key is wrapped by '${record.wrapKind}', which is not configured`,
          );
        }
        const ready = await wrap.status(input);
        if (ready.state === 'unavailable') {
          return (status = { state: 'unavailable', reason: ready.reason });
        }
        if (ready.state === 'needs-input') {
          return (status = {
            state: 'locked',
            wrapKind: record.wrapKind,
            needs: ready.input,
          });
        }
        const binding: WrapBinding = { purpose, dekId: record.id };
        const dek = await wrap.unwrap(
          { params: parseParams(record.wrapParamsJson), bytes: record.wrapped },
          binding,
          input,
        );
        next.set(record.id, dek);
      }
    } catch (error) {
      for (const key of next.values()) zeroize(key);
      throw error;
    }
    commit(next, active);
    return status;
  }

  async function initialise(
    input: WrapInput | undefined,
  ): Promise<VaultStatus | 'raced'> {
    const reasons: string[] = [];
    for (const wrap of wraps) {
      const ready = await wrap.status(input);
      if (ready.state === 'unavailable') {
        reasons.push(`${wrap.kind}:${ready.reason}`);
        continue;
      }
      chosen = wrap.kind;
      if (ready.state === 'needs-input') {
        // Nothing is created without the input: a key made now could not be wrapped.
        return (status = {
          state: 'locked',
          wrapKind: wrap.kind,
          needs: ready.input,
        });
      }
      const delivered = wrap.origin === 'delivered';
      const dek = delivered
        ? new Uint8Array(input?.dek ?? new Uint8Array(0))
        : new Uint8Array(random(KEY_BYTES));
      if (dek.byteLength !== KEY_BYTES) {
        zeroize(dek);
        throw new SecretsError('INVALID_INPUT', 'a data key is 32 bytes');
      }
      const id = hex(random(16));
      try {
        const wrapped = await wrap.wrap(dek, { purpose, dekId: id }, input);
        const record: DataKeyRecord = {
          id,
          purpose,
          wrapKind: wrap.kind,
          wrapParamsJson: stringifyParams(wrapped.params),
          wrapped: wrapped.bytes,
          state: 'active',
          createdAt: now(),
          retiredAt: null,
        };
        if (!(await repository.insert(record))) {
          zeroize(dek);
          return 'raced';
        }
        commit(new Map([[id, dek]]), record);
        return status;
      } catch (error) {
        zeroize(dek);
        throw error;
      }
    }
    chosen = undefined;
    return (status = {
      state: 'unavailable',
      reason: reasons.join(', ') || 'no-wrap',
    });
  }

  return {
    open(input) {
      return serialised(async () => {
        opened = false;
        const startedAt = epoch;
        try {
          if (keys.size > 0) return status;
          for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
            const records = await repository.list(purpose);
            const result =
              records.length > 0
                ? await unlockStored(records, input)
                : await initialise(input);
            if (epoch !== startedAt) {
              // `lock()` ran while the keys were being unwrapped: it wins. Nothing is kept.
              forgetKeys();
              throw new SecretsError(
                'VAULT_LOCKED',
                'the vault was locked while it was opening',
                { retryable: true },
              );
            }
            if (result !== 'raced') return result;
          }
          throw new SecretsError(
            'INVALID_INPUT',
            'the key store changed while it was being initialised',
            { retryable: true },
          );
        } finally {
          opened = true;
        }
      });
    },
    status: () => status,
    requiresMasterPassword: () =>
      !opened || chosen === undefined || chosen === 'passphrase',
    lock() {
      epoch += 1;
      forgetKeys();
    },
    fields: createFieldCipher(ring),
    payloads: createAadCipher(ring),
  };
}
