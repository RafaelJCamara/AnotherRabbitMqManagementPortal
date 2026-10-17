# ADR-010: DLQ replay with a source role, park-by-confirm and at-least-once identity

- **Status:** Accepted
- **Date:** 2026-10-16
- **Source:** design panel (final blueprint); see [docs/architecture/blueprint.md](../architecture/blueprint.md)

## Decision

A pure ReplayPlanner resolves destinations queue-first and applies the header strip and stamp rules.

ReplayJob behaviour:
- an isolated source lease, with prefetch 1 for finite-L QQ sources;
- W-OVERLIMIT and W-BUDGET gating, refusing to start from an over-limit DLQ and offering a one-click fix;
- confirm, then ack with proof;
- a nack or return parks the message by confirm-then-ack to <product>.parked;
- cancel, drain and suspend never nack-flush finite-L QQ sources;
- the journal keys deliveries by logical ID or by a fingerprint multiset with an occurrence ordinal, and republishes when in doubt;
- copies are stamped with the replay id and sequence.

## Rationale

On 4.3 a DLQ at default limits receives DC=21, so any return drops the message (b.4). Skipping duplicates can lose identical messages, so at-least-once with visible duplicates is the safe trade.

## Alternatives considered

Nack-requeue on cancel; content-fingerprint dedupe that skips duplicates; shovel-based redrive.

## Consequences

Duplicates are possible but marked uncertain-duplicate. Downstream dedupe can rely on the stamped ids.

## Amendments

A-6: CQ and unlimited-QQ sources: nack(requeue) + qos barrier (message stays in the DLQ); finite-L QQ sources: park by confirm-then-ack, disclosed in plan and receipt. A-7: exit criterion is 0 lost, duplicates detectable via replay-id + seq and bounded per chaos profile. See [docs/plan/amendments.md](../plan/amendments.md).
