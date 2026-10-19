# secrets

Field encryption (AES-256-GCM with authenticated data), the data-key vault and the pluggable key wraps: file KEK, passphrase, OS keyring and desktop-delivered (M0-22, DC-45, ADR-014).

Tags: `type:adapter`, `runtime:node`, `trust:critical`. It uses `node:crypto` only; no third-party package. It imports `@app/ports` (the `DataKeyRepository` port). It never imports the kernel: the kernel's `PayloadCipher` is satisfied structurally by `vault.payloads`, and `apps/engine/src/secrets-plans.spec.ts` proves it against the real `PlanStore`.

## What it does

- **Field cipher.** `seal(table, column, rowId, plaintext)` and `open(...)` encrypt a value under the current data key. The authenticated data is `table:column:rowId` (and the envelope header), so a ciphertext moved to another row, column or table fails to open with `DECRYPT_FAILED`, as does any altered byte. Envelope: version (1) | key id (16) | IV (12, random each time) | tag (16) | ciphertext.
- **Vault.** `createDataKeyVault({repository, wraps})` owns the data keys (DEKs) of one database. `open()` creates the first key or unwraps the stored ones; `lock()` zeroes them; `fields` and `payloads` are the ciphers and fail with `VAULT_LOCKED` while it is not unlocked. A stored key that cannot be opened is never replaced, so no value is orphaned.
- **Key wraps** (`KeyWrap`): a DEK is stored only as what a wrap returned for storage.
  - `createFileKekWrap({path})`: a 32-byte KEK from a Docker secret or a file (raw, 64 hex or base64); read when needed, zeroed after.
  - `createPassphraseWrap({cost?, minLength?})`: scrypt (N=2^17, r=8, p=1) on the thread pool, one derivation at a time; the stored cost is clamped on read.
  - `createKeyringWrap({backend})`: a KEK held in the OS secret store, through an injected `KeyringBackend`. A backend that reports `basic_text`, `none` or `unknown` is unavailable: the vault falls back to the next wrap (the passphrase) and `requiresMasterPassword()` is true.
  - `createCtlDeliveredWrap()`: the desktop main process delivers the DEK; the database keeps only a key check value (an HMAC), never the key.
- **`requiresMasterPassword()`**: true when a person has to type a password (the passphrase wrap is in use, or no other wrap works here), and until `open` has run.

## Public API

| Export                                                                                                               | File                    |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `createFieldCipher`, `createAadCipher`, `fieldAad`, `FieldCipher`, `AadCipher`, `KEY_BYTES`, `ENVELOPE_*`, `MAX_PLAINTEXT_BYTES` | `src/field-crypto.ts`   |
| `createDataKeyVault`, `DataKeyVault`, `DataKeyVaultOptions`, `VaultStatus`                                           | `src/dek.ts`            |
| `KeyWrap`, `KeyRing`, `WrapInput`, `WrapBinding`, `WrappedKey`, `WrapStatus`, `WrapKind`, `WrapParamValue`          | `src/types.ts`          |
| `createFileKekWrap`, `parseKek`                                                                                      | `src/wraps/file-kek.ts` |
| `createPassphraseWrap`, `DEFAULT_SCRYPT_COST`, `MIN_PASSPHRASE_CHARS`, `ScryptCost`                                  | `src/wraps/passphrase.ts` |
| `createKeyringWrap`, `isProtectedKeyring`, `KeyringBackend`, `KeyringBackendKind`                                    | `src/wraps/keyring.ts`  |
| `createCtlDeliveredWrap`                                                                                             | `src/wraps/ctl-delivered.ts` |
| `SecretsError`, `SecretsErrorCode`                                                                                   | `src/errors.ts`         |
| `createMemoryDataKeyRepository`, `createMemoryKeyring` (tests only)                                                  | `src/testing.ts`        |

Write-only secret fields in the contracts are `secretInput()` and `SecretStatusSchema` in `@app/contracts`; `checkRegistry` rejects a secret in an output, a topic or a URL.

## Invariants

- **No DEK is stored unwrapped (I-10).** The `data_keys` table (`0004_data_keys`) has no column that can hold a key in the open; the tests search every stored byte, and the keyring, for the key the vault made.
- **A stored key is never replaced.** A wrong passphrase, a different KEK, a missing wrap, a lost keyring entry and an edited record all leave the stored row alone and create nothing.
- **Fail closed.** A wrap that cannot protect a key here is skipped; if none can, nothing is created and the cipher refuses with `VAULT_LOCKED`.
- **Errors say little.** A wrong row, a wrong key and altered bytes give the same message; no error contains a passphrase, a key or the KEK path.
- **Bounded (I-5, I-6).** One value is at most 16 MiB; scrypt runs on the thread pool, one at a time; a stored scrypt cost above N=2^20 or 1 GiB is refused.
- **Honest limits.** Zeroing key material is best effort in a JavaScript runtime. A lost KEK means lost secrets (docs/runbooks/kek-escrow-and-rotation.md).

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p secrets
pnpm nx test engine                                  # the real PlanStore over the vault
pnpm nx run persistence:it --dialects=sqlite,pg      # data_keys on SQLite and Postgres 16 and 18
pnpm nx run-many -t lint typecheck test -p contracts # the write-only secret rule
```

Test names quote the acceptance criterion they prove (`AC-1`: a moved ciphertext fails; `AC-2`: a `basic_text` or `none` keyring requires a master password and stores no DEK unwrapped).

Open questions: OQ-300 to OQ-306 in [docs/open-questions.md](../../../docs/open-questions.md).
