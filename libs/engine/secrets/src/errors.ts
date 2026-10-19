// Errors of the secrets library. A message never carries key material, a passphrase or plaintext,
// and says no more about a failed decryption than "it failed" (no oracle for a forger). The
// composition root maps a `SecretsError` to a Problem (blueprint 3.6); the codes are stable.

export type SecretsErrorCode =
  /** The vault has not been opened, or was locked: no data key is in memory. */
  | 'VAULT_LOCKED'
  /** No configured key wrap can protect a data key here (for example a keyring that is `basic_text`). */
  | 'WRAP_UNAVAILABLE'
  /** A stored data key was wrapped by a kind this process was not configured with. */
  | 'WRAP_NOT_CONFIGURED'
  /** The wrap refused: wrong passphrase or KEK, or a damaged record. */
  | 'UNWRAP_FAILED'
  /** The KEK file is missing, unreadable or malformed. */
  | 'KEK_INVALID'
  /** The KEK is valid but is not the one that wrapped the stored key. */
  | 'KEK_MISMATCH'
  /** A passphrase is shorter than the minimum. */
  | 'WEAK_PASSPHRASE'
  /** A ciphertext does not open: wrong key, wrong row, or altered. */
  | 'DECRYPT_FAILED'
  /** A ciphertext names a data key this vault does not hold. */
  | 'KEY_NOT_FOUND'
  /** A caller passed a value the library refuses (bad table name, oversized plaintext, bad key size). */
  | 'INVALID_INPUT';

export class SecretsError extends Error {
  readonly code: SecretsErrorCode;
  /** True when asking again with other input (a passphrase) can succeed. */
  readonly retryable: boolean;

  constructor(
    code: SecretsErrorCode,
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = 'SecretsError';
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}
