# ADR-014: Field encryption covering secrets, captures, plans and journals; backups and audit anchors

- **Status:** Accepted
- **Date:** 2026-10-16
- **Source:** design panel (final blueprint); see [docs/architecture/blueprint.md](../architecture/blueprint.md)

## Decision

AES-256-GCM with a DEK and AAD set to table, column and row id. The DEK is wrapped by safeStorage async, the keyring or passphrase, a file KEK, or Vault/OpenBao Transit/KMS. Plan payloads and replay journal copies are encrypted and purged after use. Approvers see masked previews. Backup and restore drills run nightly, KEK escrow and rewrap have runbooks, and audit chain heads are anchored outside the database.

## Rationale

DC-45 and DC-40. Plans and journals carry message bodies and PII.

## Alternatives considered

Database-level cipher; encrypting only secrets; anchors inside the DB.

## Consequences

A lost KEK means lost secrets, which the docs state. Restores re-verify the chain against the anchors.

## Amendments

Web-first: the single-user container wraps the DEK with a KEK from a Docker secret/file or a UI passphrase (M0/M1); desktop key wrap arrives with each desktop milestone. See [docs/plan/amendments.md](../plan/amendments.md).
