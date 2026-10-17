---
paths:
  - 'libs/engine/**'
  - 'apps/engine/**'
  - 'libs/shared/**'
---

# Engine rules

Applies to engine and shared code. Source: blueprint sections 2, 4, 5 and invariants I-1..I-13 in AGENTS.md.

- **Mutations only through the executor (I-2).** A state change or message touch is an `implementAction(...)` or `defineJob(...)` module registered with the `ActionExecutor`. `WritePort` symbols (and `Amqp091Channel.publish`) are reachable only from those files. A controller-like file never calls a service directly.
- **Pipeline order is fixed and fails closed** (blueprint 5.1): resolve, validate, authenticate, profile and era, capability gates, authorise, guardrail policy, plan, execute, audit attempt, run, finish. An unknown action is denied. If the audit attempt cannot be written, the action is denied.
- **`plan()` reads only.** Every `plan()` must run against `WritePort` fakes that throw on any call. Plans are bound to principal, input hash and BrokerProfile fingerprint; `revalidate()` returns 409 `PLAN_STALE` on drift.
- **Ports.** Ports are split into `*ReadPort` and `*WritePort`. Connections are role-typed leases; settlement needs a proof (no `ack` without one). Repository ports are async from day one.
- **Errors are Problem objects** (blueprint 3.6): stable codes, no stack traces or secrets in messages.
- **Broker versions are data (I-3).** No version comparison outside `libs/shared/semantics` and `libs/engine/svc-capabilities` (`@app/no-broker-version-compare`). Ask the registry, not the version string.
- **No branching on delivery mode (ADR-001).** Mode logic lives in `apps/engine/src/{entry,modes,modules}` only (`@app/no-mode-branching`).
- **Bounded buffers only (I-6).** Use `BoundedRing` / `BoundedQueue` (bounded by items and bytes, drops counted and surfaced). Raw arrays, queues and backlogs are rejected by `@app/bounded-buffers-only`. Nothing in the engine may block the event loop (I-5); no unbounded collection is ever returned (I-7).
- **Layering.** A service imports contracts, pure, ports, kernel and sdk only: never another service, never an adapter. Cross-service needs are ports wired in the composition root (`compose-core.ts`).
- **Third-party libraries** are imported only by the project that owns them (I-11, confinement table in `eslint.config.mjs`). Sockets go through the Dialer (I-9).
- **No silent loss (I-13).** Overflow, sampling, gaps, interrupted holds and uncertain replays appear in receipts and live frames.
- **Logs redact.** Secrets never reach logs, URLs, argv or env (I-10).
- **Every service has the uniform shape:** `src/{module.ts, actions/*.ts, topics.ts, jobs/*.ts, internal/**, *.spec.ts}` and a README (purpose, public API, invariants, proof commands). Use the generators.
- **Contracts are explicit zod** (`@app/explicit-zod-schemas`): no `z.any()`, no passthrough or loose objects.
