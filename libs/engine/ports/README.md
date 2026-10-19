# ports

Read/Write-split ports, role-typed connection leases and nominal settlement proofs (ADR-009, M0-23). Types, plus the small runtime that makes the proofs nominal. Adapters implement the ports; the `BrokerScheduler` in `@app/kernel` is the only way to reach the management and Prometheus ports (I-8).

Tags: `type:port`, `runtime:node`, `trust:critical`. Imports `@app/contracts` and `zod` (types only).

## Public API

| File                 | Exports                                                                                                                                                     | Notes                                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mgmt.ts`            | `LANES`, `Lane`, `MgmtReadPort`, `MgmtWritePort`, `PromScrapePort`, request types                                                                           | Reads (`get`, `stream`) and writes (`send`) are separate ports. Every read names a lane.                                                                |
| `amqp091.ts`         | `PeekLease`, `SourceLease`, `PublishLease`, `ObserveLease`, `Delivery`, `PublishOutcome`, `TypedHeaderValue`, `TapQueueSpec`                                | A lease exposes only its role's methods. A peek never publishes; a publisher never consumes; nothing acks without a proof.                              |
| `amqp10.ts`          | `Amqp10Receiver`                                                                                                                                            | `accept` needs a proof; `detach` throws while deliveries are unsettled.                                                                                 |
| `dialer.ts`          | `DialerPort`, `DialTarget`, `DialCheck`                                                                                                                     | I-9: the one way to open a socket. Implemented by `net-dialer`.                                                                                         |
| `connection-manager.ts` | `ConnectionManager`, `ConnectionRole`, `RoleBudget`, `ConnectionUsage`, `Principal` | One method per role, each taking the connection id and the vhost and returning exactly that role's lease; `budget(connectionId, vhost)` and `usage(connectionId)` report the budgets (A-10, M0-43, OQ-372). |
| `amqp091-connector.ts` | `Amqp091Connector`, `ConnectorRequest`, `OpenedConnection`, `ConnectorEvent` | The seam through which the ConnectionManager opens connections; the composition root implements it with `adapter-amqp091` (M0-43). |
| `repos.ts`           | `JobStore`, `JobRecord`, `JobLease`, `NewJob`, `JobState`, `JobReleaseState`, `JobEventRecord` (M0-31: a lease-fenced store of sealed jobs, OQ-311), `ReplayJournal`, `ReplayJournalEntry`, `JournalState`, `Window`, `WindowQuery`, `PlanRepository`, `PlanRecord`, `PlanPatch`, `PlanState`, `PlanApprovalRecord`, `IdempotencyRepository` | Async from day one; lists are windows (I-7). The plan and idempotency ports only store and compare-and-set rows (M0-29); the policy is the kernel's `PlanStore`. |
| `workspace.ts` | `WorkspaceRepository`, `SavedViewRecord`, `WorkspaceDocument`, `WorkspaceDocumentKind` | The store of `svc-workspace` (M0-47): a person's saved views and per-owner documents (layout, setting, keybindings). Every call carries the owner; views are windows (I-7). |
| `connections.ts` | `ConnectionStore`, `ConnectionRecord`, `CredentialChange`, `FieldSealer`, `ConnectionProber` and the probe types | The ports of `svc-connections` (M0-44): profiles with their sealed credentials (stored in one transaction), sealing, and testing the HTTP and the AMQP endpoint separately. |
| `testing/` (`@app/ports/testing`) | `jobStoreContract`, `JobStoreContractOptions` | The suite every `JobStore` passes (the in-memory store of `@app/jobs`, the SQLite and Postgres stores of `@app/persistence`). It imports the test runner, so no production code may import this subpath. |
| `proofs.ts`          | `ConfirmedCopyProof`, `DestructiveConsentProof`, `SafeReturnProof`, `StreamCreditProof`, `mint*`, `is*Proof`, `assert*Proof`, `ForgedProofError`           | Nominal proofs (A-9). See below.                                                                                                                        |

## Invariants

- **Compile time (ADR-009).** `ack` takes `ConfirmedCopyProof | DestructiveConsentProof`; `nackRequeue` takes `requeue: true` only, and a source's `nackRequeue` takes a `SafeReturnProof`; `publish` takes `mandatory: true`. The proof interfaces are keyed by `unique symbol`s that this package does not export, so an object literal (or a copy of a proof's fields) is not assignable. `src/leases.types.spec.ts` holds the attempts that must fail to compile.
- **Run time (A-9).** `mint*` records each proof in a module-private `WeakMap`; lease implementations call `assertAckProof`, `assertSafeReturnProof` or `assertAcceptProof` before settling. A literal cast with `as`, a spread copy, a structured clone, a JSON round trip, an inheriting object and a `Proxy` are all refused with `ForgedProofError`.
- **Who mints.** `mintConfirmedCopyProof`: `PublishLease` implementations, from a broker confirm. `mintDestructiveConsentProof` and `mintSafeReturnProof`: the planners. `mintStreamCreditProof`: the stream consumer of an observe lease. The architecture test that bans any other import of `mint*` (and a type assertion to a proof type) is `tools/arch-tests` (`checkProofMinting`, M0-29); its allow-list of locations is `PROOF_MINTING_PREFIXES`.
- **I-8.** The `lane` on `MgmtReadPort.get/stream` and `PromScrapePort.scrape` is how the scheduler orders work. Services are given the scheduled wrappers (`scheduleMgmtRead`, `scheduleMgmtWrite`, `schedulePromScrape` in `@app/kernel`), never the adapter.
- **I-2.** `MgmtWritePort` and the leases are write-capable ports. The ActionExecutor (M0-29) hands them to `execute()` as `ExecutorWrite` and to nothing else; `tools/arch-tests` (`checkMutationFunnel`) fails any file outside the plumbing that names one without calling `implementAction` or `defineJob`.

Open questions: OQ-170 to OQ-178 in [docs/open-questions.md](../../../docs/open-questions.md).

## Proof commands

```sh
pnpm nx test ports
pnpm nx run-many -t lint typecheck test -p ports
```
