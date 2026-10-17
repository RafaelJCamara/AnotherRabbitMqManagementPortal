# ADR-001: One engine bundle, one UI build, three hosts

- **Status:** Accepted
- **Date:** 2026-10-16
- **Source:** design panel (final blueprint); see [docs/architecture/blueprint.md](../architecture/blueprint.md)

## Decision

A single Node 24 ESM engine bundle runs in an Electron utilityProcess, in a loopback or container Node process, and in a team container. All three serve one Angular 22 build. Mode files only swap adapters (storage, key wrap, auth, authz policy, listeners).

## Rationale

This is a binding user decision. A utilityProcess isolates engine crashes and CPU load from the UI. One conformance matrix and one security review cover every mode.

## Alternatives considered

A separate server codebase; microservices; running the engine in Electron main; Tauri with a sidecar.

## Consequences

Lint rule no-mode-branching. CI runs the engine on Node 24, Node 26 and Electron's Node. Desktop pays for one extra process.

## Amendments

Hosts are introduced web-first: container (M0/M1), Electron on Windows (M2), Linux (M3), macOS (M4), team server (M5). See ADR-030. See [docs/plan/amendments.md](../plan/amendments.md).
