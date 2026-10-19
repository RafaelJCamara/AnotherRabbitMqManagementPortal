# Runbook: key-encryption key (KEK) escrow and rotation

Secrets, captures, plans and journals are field-encrypted with AES-256-GCM. Each data key is wrapped by a KEK (ADR-014). Where the KEK comes from depends on the mode:

| Mode | KEK source | Notes |
|---|---|---|
| **Container (M0/M1)** | A Docker secret or file, or a passphrase entered in the UI | Back up the KEK separately from the `/data` volume; losing it loses the stored credentials |
| **Desktop (M2+)** | OS keychain / safeStorage | Linux without a secret store requires a master password |
| **Team server (M5)** | Envelope encryption via KMS or Vault/OpenBao Transit | — |

**Rotation**
1. Generate a new KEK.
2. Re-wrap the data keys (`rewrap` command, planned).
3. Verify that reads still work.
4. Retire the old KEK.

Record every rotation in the audit log.

**File KEK format (container and team modes)**
- The file holds exactly 32 raw bytes, or text (surrounding whitespace is ignored) with 64 hex characters or the base64 of 32 bytes. Anything else is refused at start. A text file of exactly 32 characters is read as 32 raw bytes.
- An all-zero key is refused. Generate one with a cryptographic source, for example `openssl rand -hex 32`.
- The engine reads the file when it needs it and does not keep the key in memory between uses. A different file than the one that wrapped the data keys is reported as a KEK mismatch, and the engine creates no new key over the stored one: restore the right file.
- The stored record keeps a short check value of the KEK so a wrong file can be told from damage. The check value reveals nothing practical about the key.

**Passphrase mode (container UI passphrase, Linux without a secret store)**
- The KEK is derived with scrypt (N=2^17, r=8, p=1) from the passphrase (NFKC-normalised, at least 12 characters). The salt and cost are stored with the wrapped key.
- There is no recovery: a forgotten passphrase means the stored credentials are lost.