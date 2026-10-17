# ADR-008: Peek: sequential basic.get, mandatory disposition, preflighted rescue, nack plus qos barrier

- **Status:** Accepted
- **Date:** 2026-10-16
- **Source:** design panel (final blueprint); see [docs/architecture/blueprint.md](../architecture/blueprint.md)

## Decision

The flow is:
- HTTP-only preflight;
- a pure planner;
- sequential basic.get on a peek-role lease (AMQP 1.0 uses credit 1 and drain per step);
- copy, then guard;
- stop at the first doomed message;
- apply the mandatory disposition: quarantine (with a preflighted classic durable quarantine queue and a pre-armed confirm channel), raise-limit, or let-broker-handle (human with typed consent only);
- nack the last unacked tag, then a basic.qos barrier, then a lazy close.
A watchdog and a write-ahead hold journal back this up. Every failure path has its own conformance cell.

## Rationale

Implements DC-03 to DC-16 and DC-09 correctly. Batch credit or parallel channels would acquire doomed messages before the guard sees them, or would scramble HEAD order.

## Alternatives considered

HTTP /get as the primary path; parallel get channels; a stop-only default; AMQP 1.0 batch credit.

## Consequences

Peek depth is bounded. A rescue that fails residually still drops the message, and the receipt and audit record say so. AI runs need a fresh rescue preflight.

## Amendments

A-1 (doom guard, see ADR-028), A-2 (DLX-source completeness and unknown limits), A-3 (HTTP /get fallback never offered for finite/unknown-L QQs on 3.13 or 4.0-4.2), A-5 (literal QuarantineQueueSpec: durable classic, x-overflow=reject-publish, no max-length, headroom preflight). See [docs/plan/amendments.md](../plan/amendments.md).
