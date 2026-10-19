// The OS keyring wrap (local web and Linux/macOS/Windows desktop without safeStorage, blueprint 6.4):
// a random 32-byte KEK is kept in the OS secret store, and the DEK is sealed under it. The native
// binding (`@napi-rs/keyring`) is not imported here: a `KeyringBackend` is injected by the
// composition root, so this library has no native dependency and the logic is testable with a fake.
//
// A Linux machine with no Secret Service or wallet gives `basic_text` (or no store at all). Storing
// the KEK there is storing it in a plain file, so the wrap reports itself unavailable and the vault
// falls back to a master password (DC-45). An `unknown` kind is treated the same way: fail closed.
import { randomBytes } from 'node:crypto';

import { SecretsError } from '../errors.ts';
import type { KeyWrap, WrapBinding, WrappedKey, WrapStatus } from '../types.ts';
import { openKey, sealKey, zeroize } from './kek-seal.ts';

export type KeyringBackendKind =
  | 'macos-keychain'
  | 'windows-credential'
  | 'secret-service'
  | 'kwallet'
  /** Linux with no secret store: the OS API would write the secret to a plain file. */
  | 'basic_text'
  | 'none'
  | 'unknown';

const PROTECTED_KINDS: ReadonlySet<KeyringBackendKind> = new Set([
  'macos-keychain',
  'windows-credential',
  'secret-service',
  'kwallet',
]);

/** What the wrap needs of the OS secret store. */
export interface KeyringBackend {
  readonly kind: KeyringBackendKind;
  get(service: string, account: string): Promise<Uint8Array | null>;
  set(service: string, account: string, secret: Uint8Array): Promise<void>;
}

export interface KeyringWrapOptions {
  backend: KeyringBackend;
  /** The keyring entry's service name. Default `app-data-keys` (the product name is a placeholder, ADR-029). */
  service?: string;
}

/** True when the backend protects a secret at rest; false means a master password is required. */
export function isProtectedKeyring(kind: KeyringBackendKind): boolean {
  return PROTECTED_KINDS.has(kind);
}

export function createKeyringWrap(options: KeyringWrapOptions): KeyWrap {
  const { backend } = options;
  const service = options.service ?? 'app-data-keys';
  const accountOf = (binding: WrapBinding): string =>
    `kek:${binding.purpose}:${binding.dekId}`;

  function requireProtected(): void {
    if (!isProtectedKeyring(backend.kind)) {
      throw new SecretsError(
        'WRAP_UNAVAILABLE',
        'the OS keyring does not protect secrets here; a master password is required',
      );
    }
  }

  return {
    kind: 'keyring',
    origin: 'engine',
    status(): Promise<WrapStatus> {
      return Promise.resolve(
        isProtectedKeyring(backend.kind)
          ? { state: 'ready' }
          : { state: 'unavailable', reason: `keyring-${backend.kind}` },
      );
    },
    async wrap(dek: Uint8Array, binding: WrapBinding): Promise<WrappedKey> {
      requireProtected();
      const kek = new Uint8Array(randomBytes(32));
      try {
        const account = accountOf(binding);
        // The KEK is stored first: a crash after this and before the row is written leaves an unused
        // keyring entry, never a wrapped key whose KEK is gone.
        await backend.set(service, account, new Uint8Array(kek));
        return {
          params: { service, account },
          bytes: sealKey(kek, dek, binding),
        };
      } finally {
        zeroize(kek);
      }
    },
    async unwrap(wrapped: WrappedKey, binding: WrapBinding) {
      requireProtected();
      // The account is derived from the binding, never read from the row: an edited row cannot
      // redirect the lookup to another entry. The service is the one the key was stored under.
      const storedService = wrapped.params.service;
      if (typeof storedService !== 'string') {
        throw new SecretsError(
          'UNWRAP_FAILED',
          'the stored key record is damaged',
        );
      }
      const stored = await backend.get(storedService, accountOf(binding));
      if (stored === null) {
        throw new SecretsError(
          'UNWRAP_FAILED',
          'the OS keyring no longer holds the key that wrapped this data key',
        );
      }
      // A copy: zeroing it must not reach into whatever the backend keeps.
      const kek = new Uint8Array(stored);
      try {
        return openKey(kek, wrapped.bytes, binding);
      } finally {
        zeroize(kek);
      }
    },
  };
}
