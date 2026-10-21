# M0-ENGINE-WIRING Engine composition: service modules, topics, drain and a run command

**Issue:** #278 · **Milestone:** M0 · **Wave:** M0-W3 · **Size:** M (about 700 changed lines, tests and docs included) · **Owner area:** engine · **trust:critical:** yes (`apps/engine` is the composition root; a one-line additive export in `libs/engine/svc-connections` rides along)

Working spec written under the maintainer's agile mode (no approval stop). Questions that were decided by default are rows OQ-764 to OQ-771 in `docs/open-questions.md`; each has a working default in use.

## Goal

`svc-connections`, `svc-capabilities`, `svc-workspace` and `svc-explorer` are built and tested over fakes but are not registered on a real engine, and the live hub has no topic sources (OQ-441, OQ-472, OQ-669). Register them in `coreModules` with real ports built in the composition root, register `explorer.window` with the hub, end the explorer on drain, and add a run command and a runbook, so a person can start the engine, open the served UI and see what works.

Serves: ADR-001 (one composition root), I-2 (the executor is the only mutation path), I-8 (the BrokerScheduler is the only path to the management API), I-9 (every socket through the Dialer and the TrustStore), I-10 (logins are opened for one call, never logged). Blueprint 1 and 1.1.

## What the code gives and what it does not

| Fact | Where | Consequence |
| --- | --- | --- |
| `composeEngine` builds executor, job runner, hub and router; `coreModules` holds `meta`, `ops`, `svc-ops`. `EngineModule` has no topics. | `apps/engine/src/compose-core.ts`, `modules/index.ts` | `EngineModule` gains `topics`; `ModuleContext` gains `services` (the ports). |
| `svc-explorer` returns `topicSources` and a final `stop()`. The other three return a local `EngineModule` with `actions: unknown[]`. | each `module.ts` | The explorer's stop is a drain phase; the others are cast to `ActionImpl[]` in `coreModules` (the executor refuses anything that is not one). |
| `MgmtReadPort` services need the adapter behind `scheduleMgmtRead`; the adapter throws `MgmtHttpError` and may not import the kernel. | `adapter-mgmt-http/src/errors.ts` | The composition root maps `MgmtHttpError` to `AppError` outside the scheduler. |
| The management client needs a `MgmtTarget` per request: endpoint, login, TLS trust, route, probed profile. | `adapter-mgmt-http/src/client.ts` | A resolver in `apps/engine` reads the stored profile, opens the sealed login with the vault's field cipher and reads the cached BrokerProfile (unprobed until `probe.run` stored one). |
| The wire probe and the connection prober existed only in `libs/testkit/src/it` (lab options). | `wire-probe.ts`, `connection-prober.ts` | Moved into `apps/engine/src/broker/` over the stored profile; the testkit copies stay for the lab ITs. |
| The guardrail policy locks every mutating action with no connection target: `connections.create`, `bundles.import`, `views.*`, `settings.put`, `keybindings.put` answer 422 `GATE_BLOCKED` through the real router (OQ-380, OQ-283, OQ-529). | `kernel/src/guardrails/policy.ts` | Not changed (hard limit). A test pins the deny; the runbook says so. |

## Files & interfaces

**Create**

- `apps/engine/src/broker/{endpoints,mgmt,failures,wire-probe,connection-prober,index}.ts`: the broker-facing ports (`createBrokerPorts`), the target resolver, the error mapper, the wire probe and the prober.
- `apps/engine/src/testing/services.ts`: the harness (a composed local engine over a temp SQLite file, scripted broker, real-router `call`).
- `apps/engine/src/compose-services.spec.ts`, `broker/broker-ports.spec.ts`, `broker/mgmt.spec.ts`.
- `apps/engine/scripts/serve.mjs` and the `serve` target of `apps/engine/project.json`.
- `docs/runbooks/run-locally.md`.

**Modify**

- `apps/engine/src/compose-core.ts`: builds the scheduler and the broker ports, hands `services` to the module factory, registers topics with the hub's `TopicRegistry`, closes the scheduler and the ports on drain and on undo, `Engine.served`, the `ComposeOptions.brokerPorts` seam.
- `apps/engine/src/modules/index.ts`: `ServicePorts`, `EngineModule.topics`, the four service modules, the explorer's drain phase.
- `libs/engine/svc-connections/src/index.ts`: exports `configOf`, `StoredConfig` and `openSecret` (read-only helpers the resolver needs; no behaviour change).
- READMEs of `apps/engine`, `svc-connections`, `svc-capabilities`, `svc-explorer`, `svc-workspace`; `docs/open-questions.md` (rows added, OQ-441 / OQ-472 / OQ-669 pointed here).

**Interfaces**

```ts
// apps/engine/src/broker/index.ts
export interface BrokerPorts { mgmt: MgmtReadPort; wire: BrokerWireProbe; prober: ConnectionProber; close(): void }
export type BrokerPortsFactory = (input: BrokerPortsInput) => BrokerPorts;
// apps/engine/src/modules/index.ts
export interface ServicePorts { connections; profiles; workspace; sealer; mgmt; wire; prober; authorizer; newId; clock; timers }
export interface EngineModule { id; actions; jobs?; topics?: readonly RegisteredTopic[]; drainPhases? }
// apps/engine/src/compose-core.ts
Engine.served: { actions: readonly string[]; topics: readonly string[] }
```

## Out of scope

- Any change to the guardrails, the authorizer, the prod lock, arming, plans or RBAC (kernel): OQ-380 and OQ-283 stay with the maintainer.
- Broker write ports and the ConnectionManager (peek, publish, source, observe): `createUnwiredWrites` stays (`CAPABILITY_MISSING`).
- The executor's `ProfileResolver` (fingerprint and gates on plans), `lastVerified` (OQ-478), the diagnostics `profiles` hook, a re-probe on endpoint change or resume.
- The served page's CSP nonce (issue #277, landed separately) and any UI work (M0-54).

## Acceptance criteria

| ID | Given | When | Then | Test |
| --- | --- | --- | --- | --- |
| AC-1 | A composed local engine | Its served actions are compared with the contract registry | Every action is served, or listed as intentionally unserved with a reason (the list is empty today) | `compose-services.spec.ts`: "AC-1 every action of the contract registry ..." |
| AC-2 | The same engine | Its served topics are compared with the registry | Every live topic has a source | "AC-2 every live topic ..." |
| AC-3 | A connection seeded in the engine's database and a scripted broker | `probe.run`, `profile.get`, `inventory.query`, `overview.get` are called through the real router | Each answers 200 in order; the profile is cached; the queues are read from the index | "AC-3 probe.run, profile.get, ..." |
| AC-4 | A missing connection, and one another person owns | The probe is called | 404 NOT_FOUND for both, and no request reaches the broker | "AC-4 a connection that does not exist ..." |
| AC-5 | The real engine and the current guardrails | `connections.create`, `views.create`, `settings.put` are called; `views.list` is read | The writes answer 422 GATE_BLOCKED (the documented limitation), the read 200 | "AC-5 workspace and connection writes ..." |
| AC-6 | The module factory | The explorer's drain phases are read | One phase, `taps-firehose`, for quit, SIGTERM and emergency, not suspend | "AC-6 the explorer ends its sweeps ..." |
| AC-7 | A live client past the handshake | It subscribes to `explorer.window` | `subok` and a `snapshot` arrive | "AC-7 explorer.window is registered with the hub ..." |
| AC-8 | A quit drain | A connection nobody asked about is queried afterwards | No management request is made (the sweeper is stopped), and every drain phase is ok | "AC-8 a quit drain stops the explorer ..." |
| AC-9 | The real broker ports and a management API on loopback | `probe.run` and the explorer run | Every request is a GET with the stored login; the AMQP handshake of a closed port is "unavailable" | `broker/broker-ports.spec.ts`: "AC-9 ..." |
| AC-10 | A broker that refuses the login, and an adapter error | The probe runs; the mapper is called | The Problem carries the code of the refusal, no secret; a streamed failure and a non-adapter error behave as documented | "AC-10 ..." in both files |
| AC-11 | A stored login that cannot be opened | The probe runs | It fails and the broker saw no request | "AC-11 a stored login that cannot be opened ..." |

`engine:serve` is checked by running it (runbook), not by a unit test: it starts a process, which `engine:smoke` already covers for the bundle.

## Verification

```sh
pnpm nx run-many -t lint typecheck test -p engine svc-connections
pnpm nx run contracts:api-docs-check
pnpm nx test arch-tests
pnpm format:check
pnpm nx affected -t lint typecheck test build --base=origin/main
pnpm nx run engine:smoke
pnpm nx run engine:serve        # then open the printed URL
```

## Risks / questions

OQ-764 (the executor's profile resolver), OQ-765 (diagnostics profiles), OQ-766 (drain phases of the new parts), OQ-767 (the resolver's trust and auth defaults), OQ-768 (a broker 401 is an engine 401), OQ-769 (the serve command's defaults and its local key), OQ-770 (`connections.create` and `bundles.import` are locked too, so no connection can be added to a running engine), OQ-771 (what stays unwired). Trust-critical paths touched: `apps/engine/**` (composition root) and `libs/engine/svc-connections/src/index.ts`; both need the CODEOWNERS review.

## DoD checklist

- [x] Spec linked; every AC has a named test.
- [ ] Verification commands pass locally and in CI.
- [x] No dependency added; no lint loosened; no guardrail touched.
- [x] READMEs updated; decisions recorded as OQ rows.
- [ ] trust-critical: human CODEOWNERS review (`apps/engine`, `svc-connections` index).
