// @app/secrets: field encryption, the data-key vault and the key wraps (M0-22, DC-45, ADR-014).
export {
  createDataKeyVault,
  type DataKeyVault,
  type DataKeyVaultOptions,
  type VaultStatus,
} from './dek.ts';
export { SecretsError, type SecretsErrorCode } from './errors.ts';
export {
  createAadCipher,
  createFieldCipher,
  ENVELOPE_OVERHEAD,
  ENVELOPE_VERSION,
  fieldAad,
  KEY_BYTES,
  MAX_PLAINTEXT_BYTES,
  type AadCipher,
  type FieldCipher,
} from './field-crypto.ts';
export {
  createMemoryDataKeyRepository,
  createMemoryKeyring,
  type MemoryDataKeyRepository,
  type MemoryKeyring,
} from './testing.ts';
export type {
  KeyRing,
  KeyWrap,
  WrapBinding,
  WrapInput,
  WrapKind,
  WrappedKey,
  WrapParamValue,
  WrapStatus,
} from './types.ts';
export { createCtlDeliveredWrap } from './wraps/ctl-delivered.ts';
export {
  createFileKekWrap,
  parseKek,
  type FileKekWrapOptions,
} from './wraps/file-kek.ts';
export {
  createKeyringWrap,
  isProtectedKeyring,
  type KeyringBackend,
  type KeyringBackendKind,
  type KeyringWrapOptions,
} from './wraps/keyring.ts';
export {
  createPassphraseWrap,
  DEFAULT_SCRYPT_COST,
  MIN_PASSPHRASE_CHARS,
  type PassphraseWrapOptions,
  type ScryptCost,
} from './wraps/passphrase.ts';
