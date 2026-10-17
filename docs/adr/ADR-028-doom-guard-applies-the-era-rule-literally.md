# ADR-028: Doom guard applies the era rule literally

- **Status:** Accepted (rewritten per amendment A-1, which replaced the design-phase "counter-trust" rule)
- **Date:** 2026-10-16
- **Related:** ADR-007, ADR-008, DC-05, DC-09

## Context

A peek acquires a message and must return it. Returning a message whose delivery counter is already at the effective limit makes RabbitMQ drop it or dead-letter it. The guard runs after each acquire and decides whether a message is *doomed*. The design phase proposed a "counter-trust" rule that classified some counters as unverified and treated them as not doomed. The final critique showed this fails open (for example, a carried-over message in a 4.3 quorum DLQ is nacked and dropped), forbids nothing for AI/unattended runs, and needs human confirmation while deliveries are held, which DC-05 forbids.

## Decision

- A message is doomed exactly when the era rule holds on the observed header, **whatever its provenance**:
  - RabbitMQ 4.3+: `x-delivery-count > L`;
  - 4.0-4.2: `x-delivery-count >= L` (the header shows acquired_count);
  - 3.13 with a limit: `>= L`.
- When counters cannot be verified, the message is treated as doomed.
- The disposition is chosen **before** the peek starts (default: quarantine via the rescue path). It applies automatically; there are **no prompts while deliveries are held**.
- AI and unattended plans are rejected unless a quarantine or raise-limit disposition passed rescue preflight within the last 60 s.
- Counter provenance is kept only as a label in receipts and the UI.

## Consequences

- False positives land recoverably in quarantine instead of being lost.
- New conformance cells: a carried-over message whose source queue was deleted; a source whose policy is invisible to the principal; a client-copied header (ends quarantined, not lost).
- New nightly mutant: "unverified counter treated as not doomed" must be killed.

## Alternatives considered

- **Counter-trust (rejected):** A counter seen with redelivered=true is verified. A counter seen with redelivered=false counts as carried-over only when the routing simulator shows finite-L DLX sources on 4.3. Otherwise it is treated as unverified (possibly copied by a client) and not doomed. Rescuing any message whose counter is unverified or not redelivered requires per-message human confirmation.
