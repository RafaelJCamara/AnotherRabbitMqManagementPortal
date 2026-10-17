# ADR-005: Multiplexed live protocol with credits and per-topic QoS

- **Status:** Accepted
- **Date:** 2026-10-16
- **Source:** design panel (final blueprint); see [docs/architecture/blueprint.md](../architecture/blueprint.md)

## Decision

One live session per UI over WebSocket or MessagePort. Topics declare a QoS (lossless, latest or sampled) and a flow (credit or snapshot-delta). Outboxes are bounded by both items and bytes. The protocol has gap, goaway and 30 s resume. Session limits are 64 subscriptions, an 8 MiB outbox and 1 MiB frames. Items carry previews only; bodies are fetched by reference.

## Rationale

MessagePort has no transport backpressure. Making loss explicit and counted keeps the UI from ever backing up into broker consumers.

## Alternatives considered

SSE plus POST; Socket.IO; relying on bufferedAmount.

## Consequences

Every topic declares its QoS and caps. The state machines are model-tested on both sides.
