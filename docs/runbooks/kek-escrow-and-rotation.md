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
