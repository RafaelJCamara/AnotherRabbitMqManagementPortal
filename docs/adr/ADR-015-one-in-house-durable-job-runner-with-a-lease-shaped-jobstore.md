# ADR-015: One in-house durable job runner with a lease-shaped JobStore

- **Status:** Accepted
- **Date:** 2026-10-16
- **Source:** design panel (final blueprint); see [docs/architecture/blueprint.md](../architecture/blueprint.md)

## Decision

Jobs are async generators with an AbortSignal, checkpoints, a journal, a token bucket, and idempotency and concurrency keys. JobStore provides claim, heartbeat and lease, using FOR UPDATE SKIP LOCKED on Postgres. Desktop resumes jobs only after the user confirms. Team mode resumes resumable jobs after preflight. Jobs whose delegated credentials expire move to awaiting-credentials.

## Rationale

Gives identical semantics in every mode, and makes HA additive.

## Alternatives considered

pg-boss (Postgres only); BullMQ (Redis); in-memory jobs.

## Consequences

Runner contract tests run on both dialects.
