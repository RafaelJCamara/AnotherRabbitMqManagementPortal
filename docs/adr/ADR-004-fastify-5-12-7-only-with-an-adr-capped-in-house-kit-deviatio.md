# ADR-004: Fastify 5.12.7 only, with an ADR-capped in-house kit (deviation from DC-49's fastify clause)

- **Status:** Accepted
- **Date:** 2026-10-16
- **Source:** design panel (final blueprint); see [docs/architecture/blueprint.md](../architecture/blueprint.md)

## Decision

No NestJS. A kit of at most 800 LOC provides the registry router, Problem mapping, auth hooks, Host, Origin and Sec-Fetch checks, the inject tunnel and the spec emitters. Wiring is a typed composition root. fastify is pinned at exactly 5.12.7.

## Rationale

@nestjs/platform-fastify 12.1.3 hard-pins fastify 5.12.5, which GHSA-389g-gv7q-r4x8 / CVE-2026-107832 affects (fixed in 5.12.6, 2026-10-13, verified). DC-49's 5.12.5 clause existed only to match Nest's pin. Policy must live in the framework-free executor (DC-42) anyway. Nest 12 is ESM-only and 7 weeks old, with no nestjs-zod or @nx/nest support.

## Alternatives considered

NestJS 12.1.3 with platform-fastify; Hono 4; oRPC 1.15.

## Consequences

We maintain the kit under its cap. DC-49's other clauses still apply: TS 6.0.3, TS 7 and @types/amqplib banned, amqplib and rhea pinned exactly, no @nx/nest. Module encapsulation comes from Nx tags and ts-morph tests.

## Amendments

Deviation from DC-49 (fastify 5.12.5 / NestJS) is deliberate: NestJS 12 pins a vulnerable fastify and @nx/nest does not support Nest 12; fastify is pinned at 5.12.7. See [docs/plan/amendments.md](../plan/amendments.md).
