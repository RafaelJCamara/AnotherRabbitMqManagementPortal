# ADR-016: Local web container mode: an explicit DC-36 bind exception

- **Status:** Accepted
- **Date:** 2026-10-16
- **Source:** design panel (final blueprint); see [docs/architecture/blueprint.md](../architecture/blueprint.md)

## Decision

Inside a container (image sets <PRODUCT>_RUNTIME=container), the engine binds 0.0.0.0:8765 with these conditions:
- the token is mandatory;
- the Host allow-list accepts loopback names on any port plus configured PUBLIC_ORIGIN values, and Origin is checked against the same set;
- a node HEALTHCHECK runs;
- the documentation requires -p 127.0.0.1:HOSTPORT:8765 and forbids 0.0.0.0 publishes and --network host.

## Rationale

Exposure is decided by the namespace bind plus -p. Allow-lists keyed to the internal port break port remaps.

## Alternatives considered

Refuse non-loopback binds (unusable in Docker); require OIDC and TLS in Docker.

## Consequences

A documented deviation, with dedicated E2E security tests.

## Amendments

A-12 and web-first: the single-user container is the first deliverable. Token mandatory; published only on 127.0.0.1; a non-loopback PUBLIC_ORIGIN is refused unless real auth and https are configured; remote use via SSH tunnel. See [docs/plan/amendments.md](../plan/amendments.md).
