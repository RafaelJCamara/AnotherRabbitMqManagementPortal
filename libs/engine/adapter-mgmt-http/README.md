# adapter-mgmt-http

The management HTTP API of the broker behind `MgmtReadPort` and `MgmtWritePort` (`@app/ports`): paging, `columns=`, the statistics flags, the status-to-code map and product awareness (DC-32/48/55). It speaks to RabbitMQ and to products with a compatible management API (LavinMQ and others, where the differences are handled in `product.ts`).

Tags: `type:adapter`, `runtime:node`.

## Public API

- `createMgmtHttpClient({ dialer, targets, capability?, requestTimeoutMs?, maxBodyBytes?, maxSocketsPerConnection? })` returns `{ read, write, invalidate, close }`. `read` is a `MgmtReadPort`, `write` a `MgmtWritePort`. It is also the hook the shared port contract suite uses to build the adapter under test.
- `MgmtTargetResolver.resolve(connectionId, signal)` is how the composition root hands over one broker's endpoint, credentials (`basic` or `bearer`), TLS trust, route and probed profile. The client keeps none of it.
- `endpoints` / `ENDPOINTS` / `matchEndpoint`: the catalogue of endpoints as data (path template, zod schema, columns, paged or not), in `src/endpoints/`: `overview` (with `whoami`, `extensions`), `cluster` (nodes, feature flags, deprecated features), `queues`, `topology` (exchanges, bindings, vhosts), `clients` (connections, channels, consumers), `access` (policies, operator policies, users, permissions), `health` (health checks, definitions).
- `MgmtHttpError` carries a contract `code`, a safe `detail`, `broker: { protocol: 'http', code: <status>, text }` and, for a provider restriction, a `gate`. Mapping it to a Problem is the caller's job (OQ-180).
- `shapeRequest`, `clampPageSize`, `pagedSchema`, `productFromOverview`, `normaliseGetMessagesBody`: the rules, exported for the golden fixtures (M0-25) and the probe.

## Invariants

- Imports only contracts, pure, port and `net-*` projects (blueprint 2.2); never a service or another adapter.
- Every socket comes from the Dialer (I-9): the agent's `createConnection` calls `Dialer.dial`, so the egress policy and the TrustStore apply, redirects are refused and an `https` origin is verified before the first byte. `node:net` and `node:tls` are not imported at run time.
- The adapter does not schedule, cache or retry. The BrokerScheduler's wrappers are the only callers (I-8).
- Broker versions are never compared here (I-3): `channelsAcceptDisableStats`, `channelsListWithStatsOff`, `enableQueueTotalsOn*` come from `semanticsRegistry.capability`. `disable_stats` is never sent to `/api/channels` unless the registry says so.
- Lists are always paged and `page_size` is clamped to 500 (I-7); answers are read up to a byte cap (I-6).
- Credentials exist for one request, only as the `Authorization` header; they never reach an error, a URL or a log (I-10).

## Golden fixtures (M0-25)

`testing/fixtures/{mgmt,prometheus}/<version>/<mode>/` holds what real brokers answered: the five lab RabbitMQ versions (3.13.7, 4.0.9, 4.1.8, 4.2.9, 4.3.6) with statistics on and off, and LavinMQ 2.10.2, each with a manifest naming product, version, image digest, statistics mode and seed ([testing/fixtures/README.md](../../../testing/fixtures/README.md)). `golden/golden.spec.ts` replays them through the real client: every endpoint of the catalogue is asked for, the request the client sends equals the one recorded, every successful answer parses with its schema, every failure becomes the contract error the status map says, the recorded LavinMQ deviations and the stats-off gaps are asserted, the hazard table and the capability cells are checked against the fixtures, and every committed file is scanned for secrets and host names. An endpoint added to the catalogue fails `test-golden` until `libs/testkit/src/golden/plan.ts` asks for it and the fixtures are recorded again.

The recorder lives in the testkit (`libs/testkit/src/golden`, an adapter may not import `type:test`); the nightly `golden-refresh` workflow compares shapes and opens a pull request on a difference.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p adapter-mgmt-http
pnpm nx run adapter-mgmt-http:test-golden                              # replay the committed fixtures; no Docker
pnpm nx run adapter-mgmt-http:record-golden --versions=4.3.6 --check   # fresh recording against the committed shapes; needs Docker
pnpm nx run adapter-mgmt-http:record-golden                            # record everything again (about 12 minutes)
```
