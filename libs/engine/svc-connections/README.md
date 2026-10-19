# svc-connections

The connections engine service: connection profiles and bundles (M0-44, not yet landed) and the role pools and budgets of the AMQP connections (M0-43, `ConnectionManager`).

Tags: `type:service`, `runtime:node`.

## Public API

- `createConnectionsModule(deps)`: returns the `EngineModule` the composition root registers.
- `ConnectionsModuleDeps` (`src/deps.ts`): the ports the module needs.
- `createConnectionsFakeDeps()` (`src/testing.ts`): fakes for those ports, for specs, the architecture manifest and the HTTP specs.
- `createConnectionManager(options)` (`src/internal/connection-manager`): the `ConnectionManager` port of `@app/ports` plus `refreshBudget` and `close`. `options` take an `Amqp091Connector` (the port the composition root implements with `adapter-amqp091`), a `BudgetSource` (probed limits plus the provider preset), the `connection_name` parts (`product`, `mode`), and optionally `maxQueued`, `maxWaitMs`, a `Clock` and `Timers`.
- `deriveBudget(input)`, `BrokerBudgetInput`, `ResolvedBudget`: the pure rules that turn limits into caps.
- `createFakeConnector()`: an in-memory `Amqp091Connector` for specs.

## ConnectionManager (M0-43, DC-11/12, A-10)

| Rule | What it does |
| --- | --- |
| One lease, one connection, one holder | `peek`, `source`, `publish` and `observe` each open a connection of that role (lazily, when asked) and return a frozen wrapper with only that role's methods. A peek has no `publish`. The adapter closes the connection at `release`, so nothing is kept warm and a connection never serves two jobs. |
| Budgets keyed by (connection, vhost, role) | `budget(connectionId, vhost)` reports `inUse`, `max`, `queued` and `etaMs` per role. `usage(connectionId)` reports "the tool uses X of Y connections" for the broker (A-10). |
| Caps | Per broker for the tool as a whole (2 or 3 on a tight `connection_max`, up to 12) and per vhost and role (peek 2, source 2, publish 2, observe 8, observe held to `consumers_per_channel`). A preset overrides them. See OQ-370, OQ-373. |
| Queueing | A spent budget queues the call (bounded: 64 per broker, 120 s). A full queue or a spent wait is `RATE_LIMITED` (429) with an estimate. An abort removes the call from the queue. |
| Fairness | Of the calls that fit, the principal with the fewest connections in use goes first, then the earliest. |
| Slots | A slot is freed when a release succeeds or the connection reports `closed` (broker close included). A release that is refused (a source with held deliveries) keeps its slot. |

`src/internal/connection-manager` is exempt from the mutation-funnel architecture test (OQ-376): it hands the leases to the executor's context and to nothing else.

## Invariants

- Never imports another service or an adapter; cross-service needs are ports wired in the composition root (blueprint 2.2). The connector is a port; the adapter is wired at the composition root.
- Every mutation is an `implementAction` file in `src/actions/`; nothing writes through a WritePort outside one (mutation funnel), except the ConnectionManager directory above.
- Engine buffers are `BoundedRing` or `BoundedQueue` (`@app/bounded-buffers-only`); the waiting calls are bounded by count and every refusal is a `RATE_LIMITED` Problem (I-6).
- Connection names are `<product>/<mode>/<role>/<session>` with the principal's id as the session, never a token (DC-41).

Open questions: OQ-370 to OQ-379 in [docs/open-questions.md](../../../docs/open-questions.md).

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p svc-connections
pnpm nx test svc-connections --testNamePattern=connection-manager
```
