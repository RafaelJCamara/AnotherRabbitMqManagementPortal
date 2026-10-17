# ADR-022: Plugin SDK: data-first registry and three trust tiers

- **Status:** Accepted
- **Date:** 2026-10-16
- **Source:** design panel (final blueprint); see [docs/architecture/blueprint.md](../architecture/blueprint.md)

## Decision

A published framework header registry drives a declarative decoder. Plugins run in three tiers:
- tier 1: first-party code in a resource-limited worker pool;
- tier 2: declarative manifests, interpreted;
- tier 3: third-party code in quickjs-emscripten 0.32.0 (WASM) inside a worker, with memory, time and input caps. Off by default; team installs need a sha256 allow-list.
The engine supports apiVersion N and N-1.

## Rationale

Worker threads are not a security boundary, and Node 24's permission model cannot restrict the network. QuickJS needs no native addon.

## Alternatives considered

Trusted worker_threads plugins; isolated-vm (native addon); a Node permission-model subprocess.

## Consequences

Third-party decoders are slower. The SDK has its own semver.
