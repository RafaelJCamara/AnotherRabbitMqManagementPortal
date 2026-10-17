# ADR-012: In-house protocol adapters behind ports

- **Status:** Accepted
- **Date:** 2026-10-16
- **Source:** design panel (final blueprint); see [docs/architecture/blueprint.md](../architecture/blueprint.md)

## Decision

MgmtHttpPort is in-house on undici and zod, with golden fixtures. Amqp091Port uses amqplib 2.2.0, and the same contract suite runs against @cloudamqp/amqp-client 4.1.1. Amqp10Port is our own adapter on rhea 3.0.5: vhost hostname, described filters, credit window 0, filter echo, explicit settlement. StreamPort is optional. rabbitmq-amqp-js-client serves only as a differential oracle.

## Rationale

Required by DC-22 to DC-25 and DC-48, and by the verified defects in the JS 1.0 client.

## Alternatives considered

Use the official JS AMQP 1.0 client; stale npm management clients.

## Consequences

A named workstream of 6 to 9 engineer-weeks, plus upstream PRs.
