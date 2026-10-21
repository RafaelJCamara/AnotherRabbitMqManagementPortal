# svc-connections

The connections engine service: connection profiles with separate HTTP and AMQP endpoints and credentials, URI parsing, separate HTTP and AMQP tests and secret-free bundles (M0-44), and the role pools and budgets of the AMQP connections (M0-43, `ConnectionManager`).

Tags: `type:service`, `runtime:node`.

## Public API

- `createConnectionsModule(deps)`: returns the `EngineModule` the composition root registers, with nine actions (below). Registered in `apps/engine/src/modules/index.ts` (issue #278). The composition root builds its ports in `apps/engine/src/broker/`: the prober over the management and AMQP adapters, and a resolver that reads a stored profile with `configOf` and opens its login with `openSecret` (both exported for it); a secret is held for one call and logged nowhere (I-10).
- `ConnectionsModuleDeps` (`src/deps.ts`): four ports, all from `@app/ports`: `store` (`ConnectionStore`: `repos.connections` of persistence), `sealer` (`FieldSealer`: `vault.fields` of secrets), `prober` (`ConnectionProber`) and `newId`.
- `createConnectionsFakeDeps()` (`src/testing.ts`): an in-memory store, an AES-GCM sealer that binds the row like the real one, a scripted `FakeProber` that records the logins it was given, for specs, the architecture manifest and the HTTP specs.
- `parseConnectionUri`, `amqpPortsFromListeners`, `findSecretsInBundle`: the URI parser (WHATWG `URL`), the AMQP ports of `/api/overview` listeners and the bundle scanner.
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

## Profiles, tests and bundles (M0-44, CON-01, CON-04)

| Action | Kind and route | What it does |
| --- | --- | --- |
| `connections.create` | command, `POST /connections` | Saves a profile from a pasted `amqp(s)://` URI or management URL and/or explicit `http` and `amqp` fields; derives what is missing. Secrets are `secretInput()` fields and are sealed. |
| `connections.update` | command, `PATCH /connections/{cid}` | Changes a profile. A secret is replaced only when a new one is sent; moving an endpoint needs its secret again (OQ-444). |
| `connections.delete` | command, `DELETE /connections/{cid}` | Deletes the profile and its credentials; a plan is offered. |
| `connections.list`, `connections.get` | query, `GET /connections[/{cid}]` | Profiles in windows; a secret is only `{ isSet, updatedAt }`. |
| `connections.test-http` | query, `POST /connections/test-http` | Tests the management API of a saved profile (`cid`) or a draft, on its own: product, version, user, tags and the AMQP ports the broker listens on, or one of eight specific causes. |
| `connections.test-amqp` | query, `POST /connections/test-amqp` | Opens and closes an AMQP connection to the vhost, on its own: `AMQP port blocked` when nothing answers, or a refused login, a refused vhost, an untrusted certificate. A failure closes the AMQP feature gates with that reason (OQ-445). |
| `bundles.export` | query, `POST /bundles/export` | Profiles as a document with no password, token or URI credential (`secretsIncluded: false`); the export scans its own output. |
| `bundles.import` | command, `POST /bundles/import` | Creates the profiles of a bundle, credentials unset; a name that exists is skipped or renamed. |

A profile has two endpoints with their own address, TLS flag and credential: the management HTTP API (`basic` or `bearer`) and AMQP (`plain`). Storage: the endpoints are the `config` JSON of `connection_profiles`; each secret is one `credentials` row (migration `0007_credentials`) sealed by `FieldSealer`, whose authenticated data names the profile and the protocol.

## More invariants (M0-44)

- **Secrets are write-only (I-10).** A password or token is accepted in the input of a create, update or test and is never in an output, a plan preview, an audit row, a receipt, a log line, an error or a URL; the specs plant canary values and scan for them in six encodings. A profile reads back only `secret: { isSet, updatedAt }`.
- **No socket here (I-9).** The service dials nothing: tests go through `ConnectionProber`, implemented at the composition root over the adapters, which dial through the Dialer.
- **A stored secret does not follow an address.** Moving an endpoint requires the secret to be sent again (OQ-444).
- **Bounded (I-6, I-7).** 200 profiles per person, 100 per list page, 15 s per test, bounded broker facts.

Open questions: OQ-440 to OQ-449 in [docs/open-questions.md](../../../docs/open-questions.md).
## Invariants

- Never imports another service or an adapter; cross-service needs are ports wired in the composition root (blueprint 2.2). The connector is a port; the adapter is wired at the composition root.
- Every mutation is an `implementAction` file in `src/actions/`; nothing writes through a WritePort outside one (mutation funnel), except the ConnectionManager directory above.
- Engine buffers are `BoundedRing` or `BoundedQueue` (`@app/bounded-buffers-only`); the waiting calls are bounded by count and every refusal is a `RATE_LIMITED` Problem (I-6).
- Connection names are `<product>/<mode>/<role>/<session>` with the principal's id as the session, never a token (DC-41).

Open questions: OQ-370 to OQ-379 (ConnectionManager) and OQ-440 to OQ-449 (profiles and bundles) in [docs/open-questions.md](../../../docs/open-questions.md).

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p svc-connections
pnpm nx test svc-connections --testNamePattern=connection-manager
pnpm nx run svc-connections:it --versions=4.3.6   # real brokers, real vault and SQLite; needs Docker (and openssl for the TLS variant)
```
