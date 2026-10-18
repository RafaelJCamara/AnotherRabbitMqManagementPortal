# adapter-amqp091

AMQP 0-9-1 behind the role-typed lease ports of `@app/ports` (M0-27, ADR-009, ADR-012), on amqplib 2.2.0. One connection serves one role and hands out exactly that role's lease: a peek that cannot publish, a publisher that cannot consume, settlement that needs a proof, and no way to express a `reject` or a `nack` without requeue.

Tags: `type:adapter`, `runtime:node`, `trust:critical` (CODEOWNERS sign-off). Imports `@app/ports`, `@app/contracts`, `@app/domain-model` (the `QueueType` vocabulary), `@app/net-truststore` (`TlsTrust`, `classifyTlsError`) and amqplib, which only `src/driver.ts` imports (I-11; `@types/amqplib` is banned, amqplib's own types are used).

## Public API

| Export                                                                      | Notes                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connectPeek(opts)`, `connectSource`, `connectPublish`, `connectObserve`    | Open a connection for that role (`connection_name` = `<product>/<mode>/<role>/<session>`) and return `{lease, info, subscribe}`. `lease` is exactly `PeekLease`, `SourceLease`, `PublishLease` or `ObserveLease`; nothing else escapes. |
| `connectControl(opts)`                                                      | Metadata only: `checkQueue`, `checkExchange`, each on its own throwaway channel. Never holds a message (OQ-214).                                                                                                                   |
| `ConnectOptions`                                                            | `dialer` (`Pick<DialerPort, 'forwarder'>`), `route`, `endpoint` (`host`, `port`, `vhost`, `tls?: TlsTrust`, `servername?`), `credentials` (`plain` or `external`; used once, never kept), `name`, timeouts, `signal`. `connectPeek` also takes a `QueueTypeLookup`. |
| `ConnectionEvent`                                                           | `blocked`, `unblocked`, `closed`, `channel-error`, `server-cancel`, `handler-error`, `release-flush`. No message content.                                                                                                          |
| `Amqp091Error`, `mapAmqplibError`                                           | A contract `ErrorCode`, a stable `reason`, a safe `detail`, the broker's close frame (OQ-210).                                                                                                                                     |
| `toTypedHeaders`, `fromTypedHeaders`                                        | amqplib values to `TypedHeaderValue` (types inferred, OQ-211) and back (exact types).                                                                                                                                             |
| `formatConnectionName`, `parseConnectionName`                               | The `connection_name` format.                                                                                                                                                                                                      |
| `Amqp091Driver`, `amqplibDriver`                                            | The seam to the client library; the unit tests drive the leases with a scripted fake, and the contract suite (M0-28) can put a second library behind it.                                                                          |

## Invariants

- **I-9, one socket path.** amqplib is never given a host. The Dialer opens the upstream connection first (egress policy, one DNS resolution) and offers it on a local endpoint; amqplib connects to that `path` (OQ-212). `connect.wiring.spec.ts` runs the real amqplib to show it.
- **ADR-009, the types.** Each lease exposes only its role's methods and is frozen. `ackWithProof` takes `ConfirmedCopyProof | DestructiveConsentProof`, a source's `nackRequeue` takes a `SafeReturnProof`, a peek's `nackRequeue` takes `{multiple: true, requeue: true}`, `publish` takes `mandatory: true`. `adapter.types.spec.ts` holds the attempts that must not compile (AC-1).
- **A-9, the proofs at run time.** Every settle calls `assertAckProof` or `assertSafeReturnProof` first, before it looks at the tag or the channel, so a literal, a spread copy, a JSON round trip, a clone or a Proxy is a `ForgedProofError` and nothing is sent. `mintConfirmedCopyProof` is imported by `leases/publish.ts` only, and a proof exists only when the broker confirmed the message and did not return it.
- **DC-04 / I-4, never close over held deliveries.** A settle names a tag the lease holds (a bounded ledger), so the broker never answers 406 and closes the channel. `release('healthy')` on a peek returns what is held (nack, barrier) before it closes; on a source it refuses; `poisoned` closes at once and never nacks. A channel the adapter gave up on can still settle.
- **DC-11.** `get` is sequential and throws before sending when the queue is a stream or its type is unknown. Passive declares run on throwaway channels. Observe works only on the tap queues it declared (exclusive, auto-delete, bounded).
- **I-6, I-10.** Ledgers, tap queues, subscribers and prefetch are bounded; the broker's text is shortened and cleaned; credentials are not kept, logged or put in a URL.

Open questions: OQ-210 to OQ-219, OQ-250 and OQ-260 to OQ-263 in [docs/open-questions.md](../../../docs/open-questions.md).

## Contract suite (M0-28, DC-48)

amqplib has a bus factor of about one, so the same suite runs against a second client, `@cloudamqp/amqp-client` 4.1.1, to keep the library replaceable. `contract/cloudamqp-driver.ts` wraps it as an `Amqp091Driver` (test-only; a dev dependency that nothing under `src/` imports) and `contract/*.contract.spec.ts` run every case once per library, through the adapter's own leases and `ConnectOptions.driver`, on each lab broker:

| Spec                                 | Proves                                                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `get-nack-barrier.contract.spec.ts`  | `get`, `nack(multiple)` plus the qos barrier (classic and quorum), ack, passive declares, properties and typed headers        |
| `confirms.contract.spec.ts`          | confirms, mandatory returns and negative confirms (a proof only for a confirmed, not returned, copy)                          |
| `blocked.contract.spec.ts`           | `connection.blocked` and `unblocked` under a memory alarm                                                                     |
| `server-cancel.contract.spec.ts`     | a server-initiated cancel is an event; whether a held delivery can still be nacked or acked is recorded and equal for both    |
| `connection.contract.spec.ts`        | login (PLAIN; EXTERNAL is an expected skip for `@cloudamqp/amqp-client`), the connection name, a broker-closed connection     |
| `cloudamqp-driver.unit.spec.ts`      | the shim's error and value translations, without a broker (part of `nx test`)                                                 |

The observation of the server-cancel case is written to `dist/contract-evidence/<broker>/server-cancel.json` (CI keeps it as an artifact). It is a candidate for the lab evidence of its cell, not evidence: evidence is recorded by CI and committed by a human (I-14). The known differences between the two libraries are listed at the top of `contract/cloudamqp-driver.ts` and in OQ-260 to OQ-263.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p adapter-amqp091
pnpm nx run adapter-amqp091:it --versions=4.2.9,4.3.6   # lab brokers; needs Docker (and openssl for the TLS variant)
pnpm nx run adapter-amqp091:contract --broker=all       # both libraries on the five lab brokers; needs Docker (or --broker=4.3.6)
```

The integration test lives in `libs/testkit/src/it/adapter-amqp091.it.ts` because a `type:adapter` project may not import `type:test` code (OQ-187). The contract specs live here instead, as the work package says: they do not import the testkit, and the lab broker reaches them as data (`libs/testkit/src/it/contract-broker.setup.ts` starts it, `run-contract.ts` loops over the versions). Both fail, rather than skip, when no Docker daemon runs.
