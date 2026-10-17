# ADR-032: TypeScript end to end with Angular

- **Status:** Accepted
- **Date:** 2026-10-16
- **Decided by:** maintainer

## Decision
The engine is TypeScript on Node 24. The UI is **Angular 22** (explicitly not React). Related ADRs: ADR-004 (Fastify engine), ADR-012 (protocol adapters), ADR-021 (UI stack).

## Consequences
- **Weaker client libraries.** The JS RabbitMQ client ecosystem is weaker than Go's or .NET's, and the official JS AMQP 1.0 client is unfit, so we build an in-house rhea adapter. Mitigations:
  - ports around every protocol client;
  - dual-library contract suites;
  - upstream PRs;
  - a differential oracle.
- **TypeScript pin.** Angular 22 pins TypeScript 6.0.x; TypeScript 7 is banned until Angular supports it.
- **Supersedes** the research recommendation of a Go engine with a React UI.
