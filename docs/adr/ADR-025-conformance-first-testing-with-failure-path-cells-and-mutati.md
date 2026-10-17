# ADR-025: Conformance-first testing with failure-path cells and mutation testing

- **Status:** Accepted
- **Date:** 2026-10-16
- **Source:** design panel (final blueprint); see [docs/architecture/blueprint.md](../architecture/blueprint.md)

## Decision

Broker-lab images expose ports 5552 and 15692. Every PR runs all 5 brokers on Node 24.22, sharded. Nightly runs cover Node 26.12, Electron's Node and alphas. The suite includes:
- executor failure-path and replay crash cells;
- chaos tests asserting DC deltas;
- scale fakes;
- model-based protocol tests;
- Keycloak team E2E;
- a deny-all egress desktop E2E;
- nightly mutation testing of the suite.

## Rationale

Required by DC-47 and DC-60. Correctness is the differentiator, and agent-written tests need tests of their own.

## Alternatives considered

Mock-only tests; manual lab runs.

## Consequences

CI cost is substantial; it is managed by sharding and a nightly scope. The full matrix runs on Linux only.

## Amendments

A-20: lab evidence is recorded only by CI on digest-pinned images and approved via bot PRs. A-24: cross-OS broker-lab reachability for desktop runners from M2. While the repo is private, PRs run a 2-version smoke and the full matrix runs nightly on a self-hosted runner. See [docs/plan/amendments.md](../plan/amendments.md).
