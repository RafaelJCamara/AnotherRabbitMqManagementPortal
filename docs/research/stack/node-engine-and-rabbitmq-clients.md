# Node engine and RabbitMQ client libraries

> **Pre-verification research (2026-10-16).** Where this conflicts with [`docs/research/fact-sheet.md`](../fact-sheet.md), the fact sheet wins. Content about a specific third-party product was removed under the docs policy ([ADR-034](../../adr/ADR-034-docs-policy.md)).

_Stack research `node-engine-and-rabbitmq-clients` · 2026-10-16_

## Executive summary

Recommended engine stack as of October 2026, with the reasoning below:

- **Runtime:** Node 24 LTS is the floor. Electron 40–46 all bundle Node 24.x, and Node 26 becomes LTS on 2026-10-28.
- **Framework:** ESM TypeScript on NestJS 12 with the Fastify adapter. Its modules and dependency injection are familiar to Angular developers and give AI agents clear conventions to follow.
- **API contract:** zod 4 schemas in a shared contracts package generate OpenAPI 3.1, and orval generates the Angular HttpClient services from that.
- **Live data:** one multiplexed WebSocket with credit-based flow control. SSE is the fallback.

Protocol access sits behind narrow interfaces (ports):

- **AMQP 0-9-1: amqplib 2.2.0** (2026-09-28). After a 2026 revival it ships TypeScript types and opt-in recovery. It is the only Node 0-9-1 client confirmed to support SASL EXTERNAL, update-secret, blocked/unblocked events, server-sent consumer cancel, confirms and basic.get.
- **AMQP 1.0: rabbitmq-amqp-js-client 1.0.0** (2026-06-25), the official one. It is needed for the released and modified outcomes and for stream filter expressions and SQL filters, which only work over AMQP 1.0. It is young: 9 stars, some features marked not implemented, and a git-URL dependency on rhea.
- **Streams: rabbitmq-stream-js-client 1.1.0**, for high-throughput reads and super streams.

**Management HTTP API:** RabbitMQ publishes no official OpenAPI spec, so the engine needs its own typed client, built on zod. At 50k+ queues it should page (page_size max 500) and use columns=, disable_stats and enable_queue_totals. Metrics should come from Prometheus /metrics/detailed through our own parser, because management metrics collection is a deprecated feature.

**Peek must depend on version and queue type.** On RabbitMQ 4.0–4.2 every requeue on a quorum queue counts toward the default delivery limit of 20. In 4.3, basic.nack and the AMQP 1.0 released outcome no longer count, but basic.reject still does.

**Persistence:** Kysely over node:sqlite locally (release candidate, no native dependencies, FTS5 built in) and over Postgres on the server.

**Secrets:** Electron safeStorage, @napi-rs/keyring (keytar is archived), or envelope encryption with a KMS or OpenBao Transit.

**Team server:** openid-client 6, server-side sessions, CASL 7 and a hash-chained audit log.

**Distribution:** npm/npx with trusted publishing plus a multi-arch Docker image. Node SEA single-file binaries are optional, because macOS x64 is not CI-tested.

**Top risks:**
- maturity of the AMQP 1.0 JS client
- side effects of peeking
- management API cost on large clusters
- a Tauri desktop shell would force a sidecar binary

## Recommendations

### AMQP 0-9-1 client

**Recommendation.** Use amqplib 2.x (2.2.0, 2026-09-28) as the main 0-9-1 adapter behind an internal Amqp091Port. The engine should own connection and session recovery rather than relying on the library's new recovery wrapper, so the UI can be told about gaps (for example, a tap that was interrupted). Run each risky operation on its own short-lived channel, and name connections so they show up clearly in the RabbitMQ UI. Keep @cloudamqp/amqp-client 4.x as an optional adapter only for brokers reachable solely through a WebSocket relay.

**Why.** amqplib is the only Node 0-9-1 client verified to support everything an admin tool needs: SASL EXTERNAL (credentials.external), updateSecret for OAuth2, blocked/unblocked events, server-sent consumer cancel, confirm channels and basic.get. Since 2026 it also bundles TypeScript types and has opt-in recovery. It is the most widely used (about 3.8k stars) and has two maintainers.

**Alternatives.** @cloudamqp/amqp-client 4.1.1: faster, zero dependencies, has AMQPSession and WebSocket support, but only SASL PLAIN. rabbitmq-client 5.0.8: good typed API, but no EXTERNAL, no update-secret, and a single maintainer.

**Risks.** The 2026 releases are new: recovery arrived 2026-05-09, and several ConfirmChannel and channel-close fixes landed this year. Edge cases need heavy integration testing. @cloudamqp's fix for a crash on Node 24.18+ shows that a Node minor release can break protocol libraries.

### AMQP 1.0 client

**Recommendation.** Adopt rabbitmq-amqp-js-client 1.x, the official RabbitMQ AMQP 1.0 JavaScript client, behind an Amqp10Port. Use it for: released and modified outcomes, stream offset browsing, stream filter expressions and SQL filters, address v2, the /management node, and refreshToken. Pin it, and use npm overrides to replace its git-URL rhea dependency with registry rhea 3.0.5. Fall back to raw rhea for anything it lacks. Contribute fixes upstream: purge, lifecycle listeners, graceful shutdown, topology recovery.

**Why.** Stream filtering beyond Bloom filters (property filters and SQL) works only over AMQP 1.0. The released outcome is the gentlest way to peek a quorum queue on 4.3+. Being official means its features follow the broker's roadmap.

**Alternatives.** Raw rhea 3.0.5 (mature, but RabbitMQ-specific address v2 and management must be written by hand). rhea-promise 3.1.0 (an Azure-focused wrapper).

**Risks.** The client is young: 1.0.0 on 2026-06-25, about 9 stars. RabbitMQ's docs mark lifecycle listeners and graceful shutdown as not implemented and topology recovery as not tested. It has no purge. SASL EXTERNAL and vhost selection could not be verified. The git dependency hurts reproducibility and supply-chain checks. It only works on RabbitMQ 4.x.

### Stream protocol client

**Recommendation.** Use rabbitmq-stream-js-client 1.1.x as an optional fast path for high-throughput stream reads, super streams, single active consumer inspection and offset tracking. Make AMQP 1.0 on port 5672 the default path for stream browsing and search.

**Why.** The client is feature-complete: offset specs, filtering, super streams, single active consumer, EXTERNAL and OIDC. But the stream protocol needs a separate plugin, port 5552 (5551 for TLS), and correct advertised host and port behind proxies or in containers. Those are often unavailable in enterprise networks.

**Alternatives.** Reading streams over 0-9-1 with x-stream-offset (works, but no stage 2 filters). AMQP 1.0 only (simpler, but slower for bulk reads and no super-stream tooling).

**Risks.** Small community (about 52 stars). It is unclear how credentials are refreshed on long-lived stream connections. Behaviour with load balancers and advertised hosts varies by site.

### Peek, tap and move semantics

**Recommendation.** Build a strategy layer that picks methods from each broker's capabilities. Streams: offset reads. Quorum queues on 4.3+: AMQP 1.0 credit plus released, or basic.get plus basic.nack(requeue), never basic.reject. Quorum queues on 4.0–4.2: same mechanics, but behind an explicit destructive-peek warning that shows x-delivery-count and caps repeat peeks. Classic queues: get plus nack(requeue). Live tap: a bounded exclusive tap queue that copies the target's bindings (x-max-length, drop-head, TTL); firehose only when explicitly enabled, under a lease with guaranteed cleanup. Move and redrive: confirm-then-ack, mandatory flag with basic.return handling, throttling, checkpoints, and the x-death / x-opt-deaths metadata.

**Why.** Quorum queues have had a default delivery limit of 20 since 4.0. In 4.3 requeue counting changed: basic.nack and released no longer count, basic.reject still does. A naive peek can therefore dead-letter or drop production messages. Firehose has a performance cost, and tap queues miss messages published to the default exchange.

**Alternatives.** The HTTP API get endpoint (simple, but the exact requeue method is unknown and it gives no control). Firehose for all taps (complete, but costly and vhost-wide).

**Risks.** The exact behaviour before 4.3 should be confirmed with version-matrix integration tests. Creating and deleting tap queues costs Khepri writes on 4.3. Peek may interact with single-active-consumer queues. Exclusive queues cannot be inspected from another connection.

### Management HTTP API client

**Recommendation.** Write our own typed client: undici (Node's built-in fetch) with one keep-alive pool per broker, plus zod 4 loose (passthrough) schemas for the endpoints we use. Record golden fixtures from RabbitMQ 3.13 and 4.0–4.3 with Testcontainers. Defaults: pagination (page_size up to 500), columns=, disable_stats=true and enable_queue_totals=true, sort on the server. Support basic auth, bearer tokens and client certificates. Give each broker a polling budget tied to the stats interval (5 s by default, 30–60 s on large clusters).

**Why.** RabbitMQ publishes no OpenAPI spec and npm has only stale, untyped clients. The HTTP API is expensive on large clusters, and the docs recommend external monitoring there.

**Alternatives.** Generating an OpenAPI from the Rust rabbitmq_http_client types or from rabbitmqadmin v2 (good references, but no machine-readable spec). Using the stale npm clients (rejected).

**Risks.** The API drifts between versions. Polling large clusters can load the management plugin. Some deployments disable the management plugin entirely; AMQP 1.0 management through the /management node partly covers topology in that case.

### Metrics ingestion

**Recommendation.** Make Prometheus the main source of metrics. Use /metrics/detailed with family= (start with queue_coarse_metrics and queue_consumer_count), vhost= and queue= regex filters. Parse with our own streaming text-format parser and compute rates from counter deltas. Treat management stats as an optional fallback, and never poll /metrics/memory-breakdown by default.

**Why.** management_metrics_collection is a deprecated feature with the advice to use Prometheus. Per-family detailed scraping keeps payloads bounded at 50k+ queues. The only npm parser was last published in 2019.

**Alternatives.** Management API message_stats (convenient, but deprecated and expensive). Querying an existing Prometheus or Mimir server with PromQL (good optional integration for the team server).

**Risks.** The Prometheus plugin may be disabled or firewalled (port 15692). Per-object output can be very large. Metric names may change between versions, which golden fixtures should catch.

### Payload codecs

**Recommendation.** Define a codec plugin SDK (detect score, decode, encode) with rules per queue or exchange. Libraries: protobufjs 8.x for runtime .proto parsing; @bufbuild/protobuf 2.x for descriptor sets from buf build and registries; avsc 5.7 for Avro; @msgpack/msgpack 3; cbor-x in pure-JS mode; bson 7; fast-xml-parser 5; node:zlib for gzip, deflate and brotli, with zstd marked experimental; ajv 8 for JSON Schema; json-schema-faker 0.6 with @faker-js/faker 10 for test data. Implement the CloudEvents AMQP binding ourselves (cloudEvents_ prefix) and use the cloudevents SDK only for the event model. Run bulk decoding in piscina worker threads.

**Why.** Covers the formats real RabbitMQ users send.

**Alternatives.** protobuf-es alone (needs pre-built descriptor sets). cbor 10 instead of cbor-x. A Bun-specific build of JSF (avoid).

**Risks.** avsc releases slowly. zstd in Node is experimental. json-schema-faker 0.6 targets Bun, so verify it on Node. Decoding user-supplied schemas can be slow or malicious; enforce size and time limits in workers.

### Engine framework

**Recommendation.** Use NestJS 12.x (ESM) on the Fastify adapter as the composition root, with validation through Nest 12's Standard Schema option and zod 4. Keep domain logic in framework-free packages using ports and adapters. One engine binary supports three modes, chosen by configuration: desktop (Electron utilityProcess), local web (loopback, token) and team server.

**Why.** Nest's modules, DI, guards and interceptors fit RBAC and audit, its testing utilities are strong, and its structure is familiar to Angular developers. That structure gives AI agents conventions to follow. Fastify adds performance underneath.

**Alternatives.** Plain Fastify 5.12 (lighter, but less structure for agents to follow). Hono 4.13 (tiny and runs on Bun and Deno, which helps compile-to-binary, but has the least structure).

**Risks.** Nest 12 is ESM-only and new (around August 2026). Decorator metadata complicates bundling for single-executable builds. Nest adds startup overhead.

### API contracts and Angular client

**Recommendation.** Work contract-first. Keep zod 4 schemas and route descriptors in a shared contracts package. Emit OpenAPI 3.1 with @asteasolutions/zod-to-openapi or nestjs-zod. Generate the Angular HttpClient services, zod validators and MSW mocks with orval 8 (@orval/angular). In CI, fail on spec drift and on breaking changes (oasdiff). Publish the same OpenAPI for CLI and automation users of the team server.

**Why.** Generated HttpClient services are idiomatic Angular (interceptors, HttpTestingController). OpenAPI also serves third parties. orval is very active (8.43.0, 2026-10-14).

**Alternatives.** oRPC 1.15 (strong: contract-first, SSE and WebSocket, MessagePort for Electron; but @orpc/nest is beta and Angular uses a fetch-based client). tRPC 11 (no official Angular adapter, no native OpenAPI). ts-rest (stalled since March 2025). ng-openapi-gen 1.1 and hey-api 0.99 as other generators.

**Risks.** Two layers of code generation (zod to OpenAPI to Angular) can drift unless CI enforces them. Zod 4 to OpenAPI 3.1 has edge cases with unrepresentable types.

### Live transport (tap, rates, job progress)

**Recommendation.** Use one multiplexed WebSocket per UI session (ws 8.x) with typed zod envelopes. Flow control: client credit frames, a bounded ring buffer per subscription, sampling modes with dropped-message counters, rate updates coalesced to 1–4 Hz, payloads truncated with full bodies fetched on demand. Detect slow clients from bufferedAmount. Upstream backpressure comes from tap-queue max-length with drop-head plus prefetch. SSE is the fallback for read-only feeds; MessagePort is optional in Electron.

**Why.** Over HTTP/1.1 (the local loopback case) SSE is limited to 6 connections per browser per domain. Tap needs two-way control. Credit-based flow means a slow UI never backs up into broker consumers.

**Alternatives.** SSE plus POST for control (fine behind HTTP/2 proxies, but hits the connection limit locally). Socket.IO (unnecessary overhead).

**Risks.** Some corporate proxies break WebSockets, hence the SSE fallback. WebSocket authentication needs cookies or one-time tickets. On a multi-replica team server, taps must run on the replica that holds the socket (sticky sessions).

### Job runner

**Recommendation.** Build an in-engine JobService. Each job is an async generator with an AbortSignal, progress events, checkpoints and idempotency keys. Throttle with a token bucket on p-queue 10. Persist jobs in SQLite or Postgres and audit every job. On the team server with several replicas, use pg-boss 12 (or SKIP LOCKED plus an advisory-lock leader), and fan out with Postgres LISTEN/NOTIFY instead of adding Redis.

**Why.** Bulk move, copy and redrive must survive UI disconnects, report progress, be cancellable and avoid flooding brokers. Desktop and local modes have no Redis or Postgres.

**Alternatives.** BullMQ (needs Redis). graphile-worker (Postgres only). Purely in-memory (not durable).

**Risks.** At-least-once moves can duplicate messages after a crash, so record message-ids and make the trade-off visible in the UI. Two job backends double the test matrix; keep one shared JobRunner port with conformance tests.

### Persistence

**Recommendation.** Use Kysely 0.29 as the query layer everywhere. Desktop and local web: node:sqlite through a thin in-house SqliteDialect adapter, with WAL and FTS5 for the search index. Team server: Postgres through PostgresDialect and pg. Keep better-sqlite3 13 (N-API prebuilt) as a drop-in fallback behind the same adapter. Write migrations in TypeScript using portable SQL, with dialect-specific branches where needed.

**Why.** node:sqlite has no native dependency, which makes single-executable packaging and pnpm installs easier. It is built into Electron 40+ (Node 24) and Bun, is at release-candidate stability, and has FTS5. Kysely uses one database type across SQLite and Postgres, whereas Drizzle needs a schema per dialect and Prisma is mid-churn on 8.0 RCs.

**Alternatives.** Drizzle 0.45 or the 1.0 RC (separate sqliteTable and pgTable schemas; node:sqlite only in the RC). Prisma 7/8 (heavy and churning). libSQL (only worth it if sync is needed).

**Risks.** node:sqlite is still RC and Node 26 renames its classes (deprecated aliases), so wrap it. Its API is synchronous only, so heavy queries block the event loop; use a worker for big index rebuilds. The Kysely adapter must be maintained in-house.

### Secrets

**Recommendation.** Define a SecretStore port with these implementations. (1) Electron safeStorage on desktop, using the async APIs and refusing or warning when the Linux backend is basic_text. (2) @napi-rs/keyring 2.x in local web mode. (3) Envelope encryption on the server: AES-256-GCM with one data key per secret, and the key-encryption key from env or file, a cloud KMS, or the OpenBao/Vault Transit datakey endpoint. Never store raw broker passwords in SQLite or Postgres.

**Why.** keytar has been archived since December 2022. @napi-rs/keyring is a maintained, keytar-compatible replacement with prebuilt binaries for every target. Containers have no OS keychain. OpenBao is open source (MPL) and Vault-API compatible.

**Alternatives.** keytar (archived). A key derived from a user passphrase (poor UX). Plaintext with file permissions (rejected).

**Risks.** Headless Linux may have no Secret Service, so offer an explicit passphrase mode. Native addons inside SEA binaries need extraction and signing. A lost key-encryption key means lost secrets; document rotation and rewrap.

### AuthN, AuthZ and audit (team server)

**Recommendation.** Login: OIDC through openid-client 6 (authorization code with PKCE), with server-side sessions (httpOnly, SameSite=Lax cookies) and CSRF tokens. API tokens for automation. Map IdP groups to roles. Authorization: CASL 7 with ABAC conditions on cluster, vhost and resource-name patterns, mirrored in Angular with @casl/angular. Broker identity: shared service credentials by default, with optional per-user OAuth pass-through or token exchange (genericGrantRequest). Audit: an append-only, hash-chained table exportable via OTLP or syslog, with no payloads by default. Local mode: no login, but loopback binding, a random token and Host/Origin allow-lists.

**Why.** Small, auditable building blocks. openid-client is certified and covers device code and client credentials for broker OAuth2 too. CASL matches resource-pattern permissions.

**Alternatives.** Better Auth 1.7 (SSO with OIDC and SAML, plus organizations and access control; quicker to build but opinionated). Lucia (deprecated as a library). External policy engines such as Cerbos or OpenFGA (overkill for v1).

**Risks.** SAML demand would push toward Better Auth or a SAML library. Pass-through tokens need IdP audience alignment with RabbitMQ's OAuth2 plugin. Chrome Local Network Access affects any hosted UI that calls a local engine.

### Runtime baseline

**Recommendation.** Target Node 24 LTS as the minimum and run CI on Node 24 and 26. Require Electron 40 or later (Node 24). Ship ESM only. Plan for the annual major-release schedule that starts with Node 27.

**Why.** Node 24 moves to maintenance on 2026-10-20 (EOL 2028-04-30). Node 26 becomes LTS on 2026-10-28. Electron 40–46 all bundle Node 24.x, so the engine must run on 24 for the desktop build.

**Alternatives.** Node 26 as the minimum (would break the Electron embedding). Bun as the runtime (TLS and crypto gaps, and a different runtime from the one tests run on).

**Risks.** Node minor releases can break protocol parsers (seen with @cloudamqp on Node 24.18+), so pin and test patch updates.

### Packaging and distribution

**Recommendation.** Main channels: npm/npx for local web mode, published with npm trusted publishing (provenance included), and a multi-arch Docker image (amd64 and arm64; distroless nodejs24-debian13 or node:24-trixie-slim) built on native arm64 runners. Avoid dependencies with install scripts. Treat Node SEA (--build-sea) binaries as a later deliverable built per OS on native runners (including macos-15-intel or macos-26-intel), with Bun --compile as a fallback for experiments. For the desktop app, run the engine in Electron's utilityProcess; a Tauri shell would force SEA or Bun sidecars.

**Why.** Developers already have Node, and Docker covers the team server. SEA has real limits: macOS x64 is not CI-tested, native addons must be extracted, and cross-platform builds must turn off code cache and snapshot. The npm ecosystem was hardened after Shai-Hulud, and pnpm 10 blocks install scripts by default.

**Alternatives.** Deno compile (cross-compiles and handles node-api addons, but is a different runtime). @yao-pkg/pkg (maintained fork). Bun compile (cross-compiles to darwin-x64).

**Risks.** SEA's useVfs is early development. Code-signing and notarising binaries that extract addons is fiddly. Intel macOS CI runners may disappear.

### Testing strategy for AI-written code

**Recommendation.** Build a testkit package with: a Testcontainers 12 RabbitMQ matrix (3.13, 4.0, 4.1, 4.2, 4.3) running nightly and on adapter changes; golden HTTP and Prometheus fixtures for each version; executable specs for peek side effects (delivery-count and acquired-count assertions for every queue type and version); toxiproxy fault injection for reconnects, blocked connections and consumer cancels; property tests for the codecs; contract tests that compare the served OpenAPI with the contracts package.

**Why.** Behaviour differs a lot by RabbitMQ version (requeue counting, Khepri, filters), and AI agents need fast, deterministic feedback.

**Alternatives.** Mocked brokers only (they miss version-specific semantics).

**Risks.** CI time and cost. Images of commercial Tanzu-only features are not available.

## Report

# Node/TS engine and RabbitMQ clients: research findings (2026-10-16)

## 0. Context, method, caveats

**RabbitMQ versions**
- 4.3 was released 2026-04-23. It is now the only series with community support: the latest patch is 4.3.6 (2026-09-16) and support runs to 2027-01-31.
- Community support for 4.2 ended 2026-07-31, and for 4.1 on 2026-01-31 ([release info](https://www.rabbitmq.com/release-information)).
- 4.3 makes Khepri the only metadata store (Mnesia is gone). It also changes how quorum queues count requeues: it adds `acquired-count`, and `delivery-count` now counts failed deliveries only ([4.3 highlights](https://www.rabbitmq.com/blog/2026/04/23/rabbitmq-4.3-release)).
- Enterprises on commercial LTS still run 3.13 and 4.0–4.2. The engine must therefore detect each broker's version and capabilities: `/api/overview`, `/api/feature-flags`, `/api/deprecated-features/used`, enabled plugins and reachable ports.

**Method**
- The web-search budget shared across agents ran out early in this session. Everything below comes from direct fetches of primary sources: official docs, GitHub source and changelogs, and npm registry metadata.
- Some GitHub release pages came back with the wrong year. In those cases dates are taken from the npm registry `time` field.

---

## 1. RabbitMQ protocol clients for Node/TS

### 1.1 Comparison

|  | **amqplib** | **@cloudamqp/amqp-client** | **rabbitmq-client** | **rabbitmq-amqp-js-client** (official AMQP 1.0) | **rabbitmq-stream-js-client** |
| --- | --- | --- | --- | --- | --- |
| Protocol | AMQP 0-9-1 | AMQP 0-9-1 | AMQP 0-9-1 | AMQP 1.0 (RabbitMQ 4.x) | Stream |
| Latest | 2.2.0 (2026-09-28) | 4.1.1 (2026-08-28) | 5.0.8 (2025-12-01) | 1.0.0 (2026-06-25) | 1.1.0 (2026-07-23) |
| Licence / stars | MIT / ~3.8k | Apache-2.0 / ~241 | MIT / ~176 | ISC / ~9 | ISC (npm) / ~52 |
| TS types | bundled since 1.2.0 | native | native | native | native |
| Recovery | opt-in since 1.1.0; `setup` callback rebuilds topology and consumers | `AMQPSession` with consumer recovery (4.0.0) | auto-reconnect and re-subscribe | reconnect options; topology recovery "NOT TESTED" | reconnect |
| Pull / peek | `channel.get` | `basicGet` | `basicGet` | credit-based receiver, then `requeue()` (released outcome) | offset consumer |
| Server consumer-cancel | consume callback receives `null` | consumer closed with "cancelled by the server" | `basic.cancel` event | n/a | n/a |
| Publisher confirms | ConfirmChannel / `waitForConfirms` | `confirmSelect` | `confirm: true` | outcome per publish | yes |
| connection.blocked | `blocked` / `unblocked` events | `onblocked` / `onunblocked` | `connection.blocked` / `connection.unblocked` | n/a | n/a |
| TLS / mTLS | socket options passed to `tls.connect` | `tlsOptions` | `tls` | key / cert / ca | yes |
| SASL EXTERNAL | **yes**, `credentials.external()` | **no** (only PLAIN in source) | **no** (`// TODO support EXTERNAL`) | not exposed in EnvironmentParams (needs verification) | yes (0.6.1) |
| OAuth2 refresh | `updateSecret()` | `updateSecret()` | **no** | `refreshToken()`, which sends HTTP-over-AMQP PUT /auth/tokens | OIDC login (1.1.0); re-auth unclear |
| WebSocket | no | `AMQPWebSocketClient` (needs a relay) | no | yes, but the broker plugin is Tanzu-only | no |

**amqplib** ([changelog](https://raw.githubusercontent.com/amqp-node/amqplib/main/CHANGELOG.md), [registry](https://registry.npmjs.org/amqplib), [API](https://amqp-node.github.io/amqplib/channel_api.html), [credentials.js](https://raw.githubusercontent.com/amqp-node/amqplib/main/lib/credentials.js))
- Revived in 2026, maintained by squaremo and cressie176.
- Release history: 1.0.0 on 2026-03-28 (Node 18 minimum), recovery on 2026-05-09, bundled types on 2026-05-09, 2.0.0 on 2026-05-10, 2.2.0 on 2026-09-28.
- Recent fixes in 2026:
  - ConfirmChannel callbacks were being dropped when the channel closed.
  - A ConfirmChannel memory leak.
  - `close()` now acts immediately while the connection is blocked.
  - `channel.get` now rejects properly when the channel closes.
- Takeaway: test confirms and channel-close paths heavily.

**@cloudamqp/amqp-client** ([changelog](https://github.com/cloudamqp/amqp-client.js/blob/main/CHANGELOG.md), [source](https://raw.githubusercontent.com/cloudamqp/amqp-client.js/main/src/amqp-base-client.ts), [AMQPClient](https://cloudamqp.github.io/amqp-client.js/classes/AMQPClient.html))
- Zero dependencies. Claims about 300k msg/s publishing versus amqplib's 172k.
- 4.0 added sessions, RPC and a codec registry with gzip/deflate.
- 4.1.0 fixed frame-parsing crashes on **Node 24.18+**. This is evidence that protocol libraries can break on a Node minor release, so CI must track Node patch versions.
- WebSocket support needs a relay in front of the broker: CloudAMQP's `/ws/amqp` or the self-hostable [websocket-tcp-relay](https://github.com/cloudamqp/websocket-tcp-relay) ([blog](https://www.cloudamqp.com/blog/cloudamqp-releases-amqp-websockets.html)).

**rabbitmq-client** ([Connection.ts](https://raw.githubusercontent.com/cody-greene/node-rabbitmq-client/master/src/Connection.ts), [Channel.ts](https://raw.githubusercontent.com/cody-greene/node-rabbitmq-client/master/src/Channel.ts), [options](https://cody-greene.github.io/node-rabbitmq-client/latest/interfaces/ConnectionOptions.html))
- A good API with a single maintainer.
- It has no SASL EXTERNAL and no update-secret, which rules it out as the main adapter for a tool that has to connect to arbitrary enterprise brokers.

**Official AMQP 1.0 JS client** ([RabbitMQ AMQP 1.0 client page](https://www.rabbitmq.com/client-libraries/amqp-client-libraries), [1.0 announcement](https://groups.google.com/g/rabbitmq-users/c/fF3W3NQJtkQ), [repo](https://github.com/coders51/rabbitmq-amqp-js-client), [registry](https://registry.npmjs.org/rabbitmq-amqp-js-client))
- RabbitMQ lists it as the JavaScript member of its AMQP 1.0 client family. It is maintained by coders51.
- Releases: 0.1.0 (2025-06-18), then 0.3.x, then 1.0.0 (2026-06-25).
- Present in the source:
  - Stream offsets: First, Last, Next, Offset, Timestamp.
  - Bloom `filterValues`, property and application-property filters, and `sqlFilter`.
  - `matchUnfiltered` and `preSettled`.
  - `discard` and `requeue`, each with annotations (giving rejected/modified and released/modified outcomes).
  - Management through `/management`: declare and delete for queues and exchanges, bind/unbind, `getQueueInfo`, `refreshToken`. There is **no purge**.
  - Direct reply-to.
  - A browser build.
- Gaps: RabbitMQ's own docs mark JS lifecycle listeners and graceful shutdown as "CURRENTLY NOT IMPLEMENTED", and topology recovery as "NOT TESTED".
- Packaging problem: `dependencies: {"rhea": "github:amqp/rhea"}` is a git-URL dependency ([manifest](https://registry.npmjs.org/rabbitmq-amqp-js-client/1.0.0)). It is not reproducible from the registry, needs git at install time, and gets no npm provenance.
- [rhea](https://github.com/amqp/rhea) 3.0.5 (2026-04-28) itself supports PLAIN, ANONYMOUS and EXTERNAL, TLS, reconnect and `websocket_connect`.

**rabbitmq-stream-js-client** ([repo](https://github.com/coders51/rabbitmq-stream-js-client), [releases](https://github.com/coders51/rabbitmq-stream-js-client/releases))
- Supports all offset specs, Bloom filtering, super streams (including filtering on super streams since 1.1.0), single active consumer, deduplication, sub-entry gzip/zstd, TLS, load-balancer mode, EXTERNAL (0.6.1) and OIDC (1.1.0).

**Other libraries:** amqp-connection-manager 5.0.0, rascal 21.0.1 and @golevelup/nestjs-rabbitmq 9.1.0 are wrappers for building applications and are not needed here. For later multi-protocol testing, mqtt 5.16.1 and @stomp/stompjs 7.5.0 are both current ([npm search](https://registry.npmjs.org/-/v1/search?text=rabbitmq%20management%20http%20api%20client&size=25)).

### 1.2 Peek/browse semantics (decision-critical)

Default delivery limit for quorum queues has been 20 since RabbitMQ 4.0. Messages over the limit are dead-lettered or dropped ([4.0.1 notes](https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.0.1)).

The current docs now distinguish two counters, `x-acquired-count` (every acquire) and `x-delivery-count` (failures only). They list what increments `delivery-count`:
- **Increments:** AMQP 1.0 `rejected`; `modified` with `delivery-failed=true`; **AMQP 0-9-1 `basic.reject`**; connection loss; consumer timeout.
- **Does not increment:** `released`; `modified` with `delivery-failed=false`; **`basic.nack`** ([quorum queues](https://www.rabbitmq.com/docs/quorum-queues)).

The 4.2 docs only describe counting "unsuccessful (re)delivery attempts" ([4.2 docs](https://www.rabbitmq.com/docs/4.2/quorum-queues)). The 2024 modified-outcome post says requeues over either protocol always increment `x-delivery-count` ([blog](https://www.rabbitmq.com/blog/2024/10/11/modified-outcome)).

| Queue type / broker | Engine method | Side effects |
| --- | --- | --- |
| Stream | Consumer at an offset or timestamp. Over 0-9-1 this needs `x-stream-offset` plus per-consumer prefetch, with acks acting as credit ([streams](https://www.rabbitmq.com/docs/streams)) | Non-destructive |
| Quorum, 4.3+ | AMQP 1.0 receiver with credit N, then `released`; or `basic.get` + **`basic.nack(requeue)`**, never `basic.reject` | `acquired-count` goes up; the message is briefly invisible to real consumers |
| Quorum, 4.0–4.2 | Same mechanics | Each peek counts toward the limit of 20, so messages can be dead-lettered or dropped. Show `x-delivery-count`, require an explicit "destructive peek" acknowledgement, and cap repeated peeks |
| Classic | `basic.get` + nack/requeue | `redelivered=true`; the message goes back to its original position "if possible" ([confirms](https://www.rabbitmq.com/docs/confirms)) |

The HTTP `POST /api/queues/{vhost}/{q}/get` endpoint takes `ackmode` values `ack_requeue_true` and `reject_requeue_true` ([HTTP API](https://www.rabbitmq.com/docs/http-api-reference)). Avoid it for quorum queues until it is confirmed whether it uses reject or nack.

### 1.3 Live tap strategies
1. **Tap queue.** Create an exclusive, server-named queue that copies the target queue's bindings, with `x-max-length`, `overflow=drop-head` and a TTL.
   - Use exclusive queues because `transient_nonexcl_queues` is deprecated ([deprecated features](https://www.rabbitmq.com/release-information/deprecated-features-list)).
   - It does not see messages published through the default exchange.
2. **Firehose tracing.** Enable it with `PUT /api/vhosts/{vhost}` and body `{"tracing":true}`, then bind to `amq.rabbitmq.trace` on `publish.#` and `deliver.<queue>`.
   - The docs warn that "performance will drop somewhat" ([firehose](https://www.rabbitmq.com/docs/firehose)).
   - Tracing must be switched off reliably, using a lease that is cleaned up if the engine crashes.
3. **Streams.** Consume from `next`.

On 4.3 clusters, creating and deleting tap queues and bindings costs Khepri/Raft writes (this is an inference, not measured). Under 4.3, a quorum-queue consumer timeout cancels the consumer instead of closing the channel ([4.3 highlights](https://www.rabbitmq.com/blog/2026/04/23/rabbitmq-4.3-release)).

### 1.4 Move, copy and DLQ redrive
- Order of operations: consume with a window; publish with `mandatory` and confirms; ack the source only after the target confirms; nack/requeue whatever is unprocessed when a job is cancelled. This gives at-least-once delivery.
- Use `x-death` (queue, reason, count, exchange, routing-keys), `x-first-death-*`/`x-last-death-*`, and AMQP 1.0 `x-opt-deaths` to rebuild the original route ([DLX](https://www.rabbitmq.com/docs/dlx)).
- The `modified` outcome with annotations (AMQP 1.0, quorum queues only) lets a requeue record why it happened ([AMQP 1.0](https://www.rabbitmq.com/docs/amqp)).

### 1.5 Streams: which path
- Stage 2 filtering (property filters and SQL filter expressions, SQL from 4.2) is **AMQP 1.0 only**. Bloom filtering works over 0-9-1, AMQP 1.0, the stream protocol and STOMP ([stream filtering](https://www.rabbitmq.com/docs/stream-filtering), [SQL filters](https://www.rabbitmq.com/blog/2025/09/23/sql-filter-expressions)).
- The stream protocol needs the `rabbitmq_stream` plugin and port 5552 (5551 for TLS). It also needs `advertised_host`/`advertised_port` set when the broker is behind proxies or in containers ([stream](https://www.rabbitmq.com/docs/stream)).
- Default stream browsing and search should therefore go over AMQP 1.0 on 5672. The stream protocol is an optional fast path.
- AMQP 1.0 over WebSocket (`rabbitmq_web_amqp`) is "a closed-source feature available exclusively in the commercial VMware Tanzu RabbitMQ offering" ([blog](https://www.rabbitmq.com/blog/2025/04/16/amqp-websocket)).

### 1.6 OAuth2 token refresh
- AMQP 1.0: the broker disconnects when the token expires. Refresh with PUT `/auth/tokens` over HTTP-over-AMQP.
- AMQP 0-9-1: the broker refuses operations after expiry. Refresh with `update-secret` or reconnect ([OAuth2](https://www.rabbitmq.com/docs/oauth2)).
- HTTP API: accepts `Authorization: Bearer` ([management](https://www.rabbitmq.com/docs/management)).

---

## 2. Management HTTP API and metrics

**No official OpenAPI.** The [HTTP API reference](https://www.rabbitmq.com/docs/http-api-reference) is a prose document. I found no published spec; this is an absence claim, so verify it.
- The reference clients are the Rust `rabbitmq_http_client`, which targets 4.x and 3.13 and has paged list functions ([repo](https://github.com/michaelklishin/rabbitmq-http-api-rs)), and [rabbitmqadmin v2](https://github.com/rabbitmq/rabbitmqadmin-ng).
- On npm the only RabbitMQ HTTP API clients are stale and untyped: http-rabbitmq-manager 0.0.4 (2018) and rabbitmq-stats 1.2.5 (2023).
- So the engine should own a typed client: undici (Node's built-in fetch) with zod 4 loose schemas, and golden fixtures recorded from each RabbitMQ version.

**Behaviour that matters at 50k+ queues**
- `page`, `page_size` (default 100, **max 500**), `name`, `use_regex` and `pagination`.
- `columns=` (dotted subfields) and `sort`/`sort_reverse`.
- `disable_stats=true` combined with `enable_queue_totals=true`.
- `/api/aliveness-test` does nothing as of 4.1.
- Stream endpoints: `/api/stream/{connections,publishers,consumers}`.
- `/api/deprecated-features/used`.
- Stats are emitted every 5 s by default; large installations should use 30–60 s and "prefer external monitoring" ([management](https://www.rabbitmq.com/docs/management)).
- `management_metrics_collection` is a **deprecated feature**, with the advice to "use the Prometheus plugin" ([deprecated list](https://www.rabbitmq.com/release-information/deprecated-features-list)).

**Engine tactics**
- Page the list with stats disabled and only the needed columns.
- Refresh incrementally into a local SQLite FTS5 index.
- Get message counts from Prometheus.
- Give each broker a polling budget and adaptive concurrency.

**Prometheus** ([docs](https://www.rabbitmq.com/docs/prometheus))
- Endpoints on port 15692:
  - `/metrics` (aggregated)
  - `/metrics/per-object`
  - `/metrics/detailed?family=…&vhost=…&queue=<regex>`, with the `rabbitmq_detailed_` prefix
  - `/metrics/memory-breakdown`, which is expensive
- Families include `queue_coarse_metrics` (cheapest), `queue_consumer_count`, `queue_delivery_metrics`, `queue_metrics` (most expensive), `connection_churn_metrics`, `ra_metrics` and `stream_consumer_metrics`.
- The only npm parser, parse-prometheus-text-format, was last published in 2019 ([npm](https://registry.npmjs.org/-/v1/search?text=prometheus%20text%20format%20parser&size=20)). Write a small streaming line parser that handles escapes, HELP and TYPE, and compute rates from counter deltas.

---

## 3. Payload codecs

| Need | Choice (latest) | Notes |
| --- | --- | --- |
| Protobuf from `.proto` at runtime | **protobufjs 8.8.1** (2026-10-11) | `protobuf.load()` parses at runtime. Claims 100% conformance, including Edition 2026 since 8.8.0 ([repo](https://github.com/protobufjs/protobuf.js)) |
| Protobuf from descriptor sets / `buf build` | **@bufbuild/protobuf 2.16.0** (2026-09-29) | Registries from FileDescriptorSet, dynamic messages, `Any` ([docs](https://protobufes.com/)). No runtime `.proto` compiler |
| Avro | avsc 5.7.9 (2025-07-13) | Schema-evolution resolvers. Slow release cadence ([repo](https://github.com/mtth/avsc)) |
| MessagePack | @msgpack/msgpack 3.1.3 (2025-12-26) |  |
| CBOR | cbor-x 1.6.6 (2026-08-25) or cbor 10.0.12 | cbor-x has an optional native helper (cbor-extract); prefer pure JS |
| BSON | bson 7.3.3 (2026-09-15) | MongoDB official |
| XML | fast-xml-parser 5.11.2 (2026-09-29) |  |
| Compression | node:zlib gzip, deflate, brotli; **zstd is Stability 1, Experimental**, added in v23.8.0 / v22.15.0 ([zlib](https://nodejs.org/api/zlib.html)) | Read `content_encoding` / `content-encoding` |
| CloudEvents | cloudevents 10.0.0 (2025-06-10) | **No AMQP binding** ([sdk](https://github.com/cloudevents/sdk-javascript)). Implement the spec ourselves: binary mode uses the `cloudEvents_` or `cloudEvents:` prefix in application-properties ([binding](https://github.com/cloudevents/spec/blob/main/cloudevents/bindings/amqp-protocol-binding.md)) |
| JSON Schema validation | ajv 8.20.0 (2026-04-24) |  |
| Fake data | json-schema-faker 0.6.3 plus @faker-js/faker 10.6.0 | JSF 0.6 is a TypeScript rewrite, "optimized for Bun", with zero dependencies; verify it on Node ([repo](https://github.com/json-schema-faker/json-schema-faker)) |
| zod interop | zod 4.6.7 | `z.toJSONSchema()` (2020-12, draft-7, OpenAPI 3.0); `z.fromJSONSchema()` is experimental ([docs](https://zod.dev/json-schema)) |

**Design:** codecs are plugins (`detect` → score, `decode`, `encode`), resolved through per-queue/exchange header rules. Bulk decoding runs in a piscina 5.3.2 worker pool so the event loop stays free.

---

## 4. Engine framework, contracts and transport

|  | NestJS 12.1.3 (2026-10-12) | Fastify 5.12.7 | Hono 4.13.13 |
| --- | --- | --- | --- |
| Structure | Modules, DI, guards and interceptors (useful for RBAC and audit), Test.createTestingModule | Plugin encapsulation | Minimal |
| Validation | v12 adds a Standard Schema `schema` option, so zod 4 works directly ([v12 notes](https://github.com/nestjs/nest/releases/tag/v12.0.0)) | Type providers | Validators |
| Module format | ESM-only since v12 (about late Aug 2026); requires Node 20.19+ or 22.12+ | ESM/CJS | ESM; also runs on Bun and Deno |

**Recommendation: NestJS 12 on the Fastify adapter.** It gives AI agents strong conventions and Angular developers a familiar structure. Domain code stays framework-free (hexagonal ports and adapters).

**Contract options**

| Option | Status | Angular fit |
| --- | --- | --- |
| **zod 4 → OpenAPI 3.1 → orval 8.43.0** (2026-10-14; `@orval/angular`, `@orval/zod`, MSW mocks) | Active. Alternatives: ng-openapi-gen 1.1.0 (OpenAPI 3.0/3.1) and @hey-api/openapi-ts 0.99 (has an Angular client) | Idiomatic HttpClient services, so interceptors and HttpTestingController keep working |
| oRPC 1.15.7 (2026-10-14; ~5.7k stars) | Contract-first, generates OpenAPI, SSE event iterators, WebSocket and MessagePort (Electron) adapters ([docs](https://orpc.dev/docs/getting-started), [electron](https://orpc.dev/docs/adapters/electron)). `@orpc/nest` is installed as `@beta` | fetch-based client; TanStack Angular Query is still `-experimental` (5.104.3) |
| tRPC 11.19.0 | Active | No official Angular adapter (@analogjs/trpc 0.5 is Nitro-based); OpenAPI only through add-ons |
| ts-rest | Last `@ts-rest/core` publish was 3.52.1 on 2025-03-04; a Zod 4 fork exists | Stalling |

Use `@asteasolutions/zod-to-openapi` 9.1.0 or `nestjs-zod` 5.5.0 to emit the spec. In CI, fail on spec drift and on breaking changes (oasdiff).

**Live transport**
- Use **one multiplexed WebSocket** (ws 8.22.0) for all live data.
- SSE over HTTP/1.1 is limited to **6 connections per browser per domain**, and Chrome and Firefox have marked that "Won't fix" ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/EventSource)). Local loopback servers run HTTP/1.1.
- Protocol: zod discriminated-union envelopes; per-subscription credit frames; a bounded ring buffer on the server; sampling modes (all, 1-in-N, latest-only) with dropped-message counters; rates coalesced to 1–4 Hz; payloads truncated with full bodies fetched on demand.
- Slow clients are detected from `bufferedAmount`.
- Upstream backpressure: tap queue `x-max-length` with drop-head, plus consumer prefetch.
- SSE remains a fallback for read-only feeds. MessagePort is an option for Electron.

**Job runner (bulk move, copy, republish)**
- An in-engine JobService: each job is an async generator with an AbortSignal, progress events and checkpoints.
- Throttling uses a token bucket built on p-queue 10.0.0.
- Jobs persist in a jobs table (SQLite or Postgres) and every job is audited.
- Team server with several replicas: pg-boss 12.38.0 (2026-10-13), or `SKIP LOCKED` with an advisory-lock leader.
- One collector role polls brokers and fans results out through Postgres LISTEN/NOTIFY, so Redis is not required.

---

## 5. Persistence and security

**SQLite**
- **node:sqlite**
  - Stability "1.2 – Release candidate" since v25.7.0, and the v24.22.0 docs also say 1.2 ([v26 docs](https://nodejs.org/api/sqlite.html), [v24 docs](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)).
  - The API is synchronous.
  - FTS5, the session extension and math functions are compiled in ([sqlite.gyp](https://raw.githubusercontent.com/nodejs/node/main/deps/sqlite/sqlite.gyp)).
  - Node 26 renames `DatabaseSync`/`StatementSync` to `Database`/`Statement`, with deprecated aliases (DEP0210/0211).
  - Electron fixed a missing sqlite binding in July 2025 ([issues](https://github.com/electron/electron/issues?q=node%3Asqlite)).
  - Bun implements node:sqlite fully ([Bun compat](https://bun.com/docs/runtime/nodejs-compat)).
- **better-sqlite3 13.0.0** (2026-07-21) switched to N-API. Prebuilt binaries ship inside the npm package and "should theoretically work across Node.js and Electron"; engines require Node 22+ ([release](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0)).

**Query layer**
- **Kysely 0.29.6.** Its SqliteDialect needs a better-sqlite3-shaped statement (`reader`, `all`, `run`, `iterate`) ([API](https://kysely-org.github.io/kysely-apidoc/interfaces/SqliteStatement.html)), so node:sqlite needs a thin adapter. The community dialect has 3 stars ([repo](https://github.com/wolfie/kysely-node-native-sqlite)). PostgresDialect covers the server.
- **Drizzle.** Schemas are dialect-specific: "there is no such thing as a common table object" ([docs](https://orm.drizzle.team/docs/sql-schema-declaration)). Supporting SQLite and Postgres would mean two schemas. The stable 0.45.4 has no node:sqlite driver; only the 1.0 RC does ([docs](https://orm.drizzle.team/docs/get-started-sqlite)).
- **Prisma.** The npm `latest` tag currently points to 8.0.0-rc.23 ([registry](https://registry.npmjs.org/prisma/latest)), which signals heavy churn.

**Secrets**
- keytar was archived on 2022-12-15 ([repo](https://github.com/atom/node-keytar)).
- **@napi-rs/keyring 2.1.1** (2026-10-10) is keytar-compatible. It has prebuilt binaries for Windows, macOS, Linux (gnu and musl) and FreeBSD, and on Linux uses Secret Service or keyutils ([repo](https://github.com/Brooooooklyn/keyring-node), [registry](https://registry.npmjs.org/@napi-rs/keyring)).
- Electron **safeStorage** uses Keychain on macOS, DPAPI on Windows, and libsecret or kwallet on Linux. The Linux `basic_text` fallback encrypts with a "hardcoded plaintext password". Check `getSelectedStorageBackend()` and warn the user ([docs](https://www.electronjs.org/docs/latest/api/safe-storage)).
- Server: AES-256-GCM envelope encryption with one data key per secret. The key-encryption key comes from env/file, a cloud KMS, or the **OpenBao Transit** datakey endpoint. OpenBao is Vault-API compatible ([transit](https://openbao.org/docs/secrets/transit/)).

**AuthN/Z and audit (team server)**
- **openid-client 6.8.8** (2026-09-05): universal ESM; auth code + PKCE, DPoP, device flow, client credentials, CIBA, `genericGrantRequest` (for token exchange) and a Passport strategy; certified for FAPI 1.0/2.0 ([repo](https://github.com/panva/openid-client), [API](https://github.com/panva/openid-client/blob/main/docs/README.md)).
- Alternative: **Better Auth 1.7.10**, with an SSO plugin (OIDC and SAML 2.0) and an organization plugin with `createAccessControl` ([SSO](https://www.better-auth.com/docs/plugins/sso)).
- **CASL 7.0.2** (2026-10-15) for RBAC and ABAC, plus @casl/angular ([repo](https://github.com/stalniy/casl)).
- Broker identity can work two ways: shared service credentials plus app-level RBAC, or the user's own OAuth token passed through (or exchanged).
- Audit: an append-only, hash-chained table that never stores payloads by default.

**Hardening local web mode**
- Bind to loopback only and use a random token.
- Allow-list the Host and Origin headers to block DNS rebinding.
- Serve the Angular UI from the same origin. From Chrome 142, requests from a public site to loopback trigger a Local Network Access permission prompt ([Chrome](https://developer.chrome.com/blog/local-network-access)).

---

## 6. Runtime and packaging

**Node timeline**
- Node 24 (Krypton) has been Active LTS since 2025-10-28. It moves to maintenance on **2026-10-20** and reaches EOL on 2028-04-30.
- Node 26 was released 2026-05-05 and becomes **LTS on 2026-10-28** (EOL 2029-04-30).
- Node 20 reached EOL on 2026-04-30 ([schedule](https://github.com/nodejs/Release)).
- From Node 27 there will be one major release per year, and every release becomes LTS ([announcement](https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule)).
- **Electron 40–46 bundle Node 24.x**: Electron 45 ships 2026-10-20 with Node 24.22.0 ([schedule](https://releases.electronjs.org/schedule)).
- Engine policy: Node 24 is the minimum, and CI runs on 24 and 26.

**Single-executable options**

| Option | Notes |
| --- | --- |
| Node SEA | `node --build-sea` since v25.5.0. ESM entry supported with `mainFormat: module`. `useVfs` (v26.9, early development) allows require/import from bundled files, but native addons must still be extracted to disk and loaded with `process.dlopen`. **macOS CI covers arm64 only, not x64.** Cross-platform builds must disable code cache and snapshot ([docs](https://nodejs.org/api/single-executable-applications.html)) |
| Bun 1.4 `--compile` | Cross-compiles for every target including darwin-x64 and embeds `.node` files. Not a Node runtime: TLS lacks psk/OCSP and some crypto key types ([exe](https://bun.com/docs/bundler/executables)) |
| Deno compile | Cross-compiles; embeds npm packages and node-api addons; offers `--self-extracting` ([docs](https://docs.deno.com/runtime/reference/cli/compile/)) |
| @yao-pkg/pkg | Maintained fork of the archived vercel/pkg; has an SEA mode ([repo](https://github.com/yao-pkg/pkg)) |

**Distribution**
- npm/npx using trusted publishing. This went GA on 2025-07-31, needs npm CLI 11.5.1 or later and adds provenance automatically ([changelog](https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/)). npm was also hardened after the Shai-Hulud worm ([plan](https://github.blog/security/supply-chain-security/our-plan-for-a-more-secure-npm-supply-chain/)).
- pnpm 10 does not run dependency lifecycle scripts by default ([release](https://github.com/pnpm/pnpm/releases/tag/v10.0.0)). This is a reason to avoid dependencies with install scripts; node:sqlite helps.
- Docker: `node:24-trixie-slim`, or `gcr.io/distroless/nodejs24-debian13` (amd64, arm64, s390x, ppc64le) ([distroless](https://github.com/GoogleContainerTools/distroless), [node](https://hub.docker.com/_/node)).
- CI runners: native `ubuntu-24.04-arm` runners are free for public repositories ([changelog](https://github.blog/changelog/2025-01-16-linux-arm64-hosted-runners-now-available-for-free-in-public-repositories-public-preview/)); macOS Intel builds can use `macos-15-intel` or `macos-26-intel` ([runner-images](https://github.com/actions/runner-images)).

**Desktop shell implication**
- Electron's `utilityProcess` runs the engine on Electron's own Node and talks over MessagePort ([docs](https://www.electronjs.org/docs/latest/api/utility-process)).
- Tauri would need a sidecar binary for each target triple ([Tauri](https://v2.tauri.app/develop/sidecar/)), which means SEA or Bun binaries and handling their native-addon and code-signing problems.

---

## 7. Proposed engine module map (AI-agent friendly)
- `contracts`: zod 4 schemas, the REST contract, the live-channel protocol and the generated OpenAPI.
- `engine-core`: domain services with ports only — profiles, capabilities, topology, messages (peek, publish, move), tap, metrics, jobs, codecs, audit.
- Adapters:
  - `amqp091-amqplib`
  - `amqp10-rabbitmq` (rhea fallback)
  - `stream`
  - `mgmt-http` (undici + zod)
  - `prometheus`
  - `persistence-sqlite` / `persistence-postgres` (Kysely)
  - `secrets-{electron,keyring,envelope}`
  - `auth-oidc`
- Apps: `engine` (NestJS composition root with desktop, local and server modes), `web` (Angular), `desktop`.
- `testkit`: a Testcontainers 12.2.1 matrix covering RabbitMQ 3.13 and 4.0–4.3, golden API fixtures, peek side-effect tests (the delivery-count assertions above), toxiproxy fault injection, and codec property tests.
- Rule: wrap every risky AMQP operation (passive declare, get on exclusive queues) in its own throwaway channel, because 0-9-1 channel errors close the channel.

## Claims flagged for verification

- **[medium]** Quorum queues have had a default delivery limit of 20 since RabbitMQ 4.0, and messages over it are dead-lettered or dropped. In 4.3, AMQP 0-9-1 basic.nack and the AMQP 1.0 released outcome no longer increment delivery-count, while basic.reject and modified(delivery-failed=true) still do. On 4.0–4.2, every requeue counts.
- **[high]** Stage 2 stream filtering (AMQP property filters, and SQL filter expressions from 4.2) works only over AMQP 1.0. Bloom filtering works over AMQP 0-9-1, AMQP 1.0, the stream protocol and STOMP.
- **[high]** The official RabbitMQ AMQP 1.0 JavaScript client is the npm package rabbitmq-amqp-js-client (repo coders51/rabbitmq-amqp-js-client), with 1.0.0 published 2026-06-25. It depends on rhea through a git URL (github:amqp/rhea). RabbitMQ's docs mark JS lifecycle listeners and graceful shutdown as not implemented and topology recovery as not tested, and its management class has no purge.
- **[high]** amqplib was actively revived in 2026: 1.0.0 on 2026-03-28, opt-in connection recovery in 1.1.0 and bundled TypeScript types in 1.2.0 (both 2026-05-09), and 2.2.0 on 2026-09-28. It supports SASL EXTERNAL (credentials.external), updateSecret, blocked/unblocked events, server consumer cancel (callback receives null), confirm channels and channel.get.
- **[medium]** @cloudamqp/amqp-client 4.x authenticates only with SASL PLAIN (no EXTERNAL), though it does support updateSecret, onblocked and server cancel. rabbitmq-client 5.0.8 has no EXTERNAL (a TODO in its source) and no update-secret.
- **[medium]** RabbitMQ publishes no official OpenAPI spec for the management HTTP API. List endpoints take page_size up to 500, columns=, disable_stats and enable_queue_totals. management_metrics_collection is a deprecated feature with the advice to use the Prometheus plugin.
- **[high]** AMQP 1.0 over WebSocket (the rabbitmq_web_amqp plugin) is closed source and available only in commercial VMware Tanzu RabbitMQ.
- **[high]** node:sqlite is at Stability 1.2 (release candidate) in the Node 24.22.0 and 26.x docs (RC since v25.7.0). It is synchronous-only, is compiled with FTS5, and Node 26 renames DatabaseSync and StatementSync to Database and Statement with deprecated aliases (DEP0210/DEP0211).
- **[high]** Node 24 moves from Active LTS to maintenance on 2026-10-20 (EOL 2028-04-30). Node 26 becomes LTS on 2026-10-28. Electron 40–46 all bundle Node 24.x. From Node 27, Node.js ships one major release per year and every release becomes LTS.
- **[high]** Node SEA gained a built-in --build-sea flag in v25.5.0. SEA is CI-tested on macOS for arm64 only (x64 is not supported). Native addons must be extracted to a real file and loaded with process.dlopen, and cross-platform builds require useCodeCache and useSnapshot to be false.
- **[high]** keytar (atom/node-keytar) was archived on 2022-12-15. @napi-rs/keyring 2.1.1 (2026-10-10) is a maintained, keytar-compatible replacement with prebuilt binaries for Windows, macOS, Linux (gnu and musl) and FreeBSD. Electron safeStorage's Linux basic_text fallback uses a hardcoded password.
- **[high]** Drizzle schemas are dialect-specific ('no such thing as a common table object'), and node:sqlite support exists only in Drizzle's 1.0 RC, not the stable 0.45.4. Prisma's npm latest tag currently points to 8.0.0-rc.23.
- **[medium]** ts-rest's last @ts-rest/core release was 3.52.1 on 2025-03-04, and a separately maintained fork exists for Zod 4. tRPC 11 has no official Angular adapter. oRPC 1.15.7 is active, with OpenAPI, SSE, WebSocket and MessagePort adapters, but its NestJS integration is installed as a beta.

## Open questions

- Electron or Tauri for the desktop shell? Electron lets the engine run on its bundled Node 24 via utilityProcess. Tauri forces a per-platform SEA or Bun sidecar, with native-addon and code-signing problems.
- Which RabbitMQ versions are the minimum (3.13 commercial LTS? 4.0+?), and should LavinMQ or Amazon MQ for RabbitMQ be supported? Native AMQP 1.0 and the official JS client need 4.x.
- On RabbitMQ 4.3, does the management API's POST /api/queues/{vhost}/{q}/get with ackmode=ack_requeue_true requeue via basic.reject or basic.nack? It decides whether that endpoint increments delivery-count.
- Exactly how do pre-4.3 brokers (4.0–4.2) count AMQP 1.0 'released' against delivery-count? Confirm with an integration test, because the docs disagree in wording.
- Can the official AMQP 1.0 JS client do SASL EXTERNAL and select a vhost? When will it add purge, lifecycle listeners and graceful shutdown? Is the git-URL rhea dependency removed in a later release?
- Can the stream protocol refresh OAuth2 credentials on long-lived connections without reconnecting?
- How much Khepri/Raft load do frequent tap-queue and binding create/delete cycles add on RabbitMQ 4.3 clusters? Is firehose a better default for busy vhosts?
- How should peeking behave on queues with single active consumer enabled (basic.get versus a temporary consumer that could become the active one) and on exclusive queues?
- Should @orpc/nest (beta) or TanStack Angular Query (still published as -experimental) be adopted once they stabilise, replacing the OpenAPI plus orval pipeline?
- Does json-schema-faker 0.6 (rewritten in TypeScript, 'optimized for Bun') run fully on Node 24, with no Bun-only APIs?
- Licence choice (Apache-2.0 or MIT): the dependencies found are MIT, ISC or Apache-2.0, which are compatible, but SBOM and NOTICE handling must be decided.
- Team server topology: one replica with a leader or several replicas (pg-boss, LISTEN/NOTIFY, sticky WebSockets)? Is SAML needed at launch, which would favour Better Auth?
- Note on method: the shared WebSearch budget ran out early. Some 2026 facts (for example the NestJS 12.0.0 date of about Aug 2026, inferred from registry metadata) should be re-checked once searching is available again.

## Sources

- https://www.rabbitmq.com/client-libraries/amqp-client-libraries
- https://groups.google.com/g/rabbitmq-users/c/fF3W3NQJtkQ
- https://github.com/coders51/rabbitmq-amqp-js-client
- https://github.com/coders51/rabbitmq-amqp-js-client/releases
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/main/README.md
- https://registry.npmjs.org/rabbitmq-amqp-js-client
- https://registry.npmjs.org/rabbitmq-amqp-js-client/1.0.0
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/main/src/consumer.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/main/src/delivery_context.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/main/src/connection.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/main/src/management.ts
- https://raw.githubusercontent.com/coders51/rabbitmq-amqp-js-client/main/src/environment.ts
- https://github.com/amqp/rhea
- https://registry.npmjs.org/-/v1/search?text=rhea&size=5
- https://raw.githubusercontent.com/amqp-node/amqplib/main/CHANGELOG.md
- https://raw.githubusercontent.com/amqp-node/amqplib/main/README.md
- https://raw.githubusercontent.com/amqp-node/amqplib/main/lib/credentials.js
- https://registry.npmjs.org/amqplib
- https://github.com/amqp-node/amqplib
- https://github.com/amqp-node/amqplib/releases
- https://amqp-node.github.io/amqplib/channel_api.html
- https://registry.npmjs.org/rabbitmq-client
- https://github.com/cody-greene/node-rabbitmq-client
- https://raw.githubusercontent.com/cody-greene/node-rabbitmq-client/master/src/Connection.ts
- https://raw.githubusercontent.com/cody-greene/node-rabbitmq-client/master/src/Channel.ts
- https://cody-greene.github.io/node-rabbitmq-client/latest/interfaces/ConnectionOptions.html
- https://registry.npmjs.org/@cloudamqp/amqp-client
- https://github.com/cloudamqp/amqp-client.js
- https://github.com/cloudamqp/amqp-client.js/blob/main/CHANGELOG.md
- https://raw.githubusercontent.com/cloudamqp/amqp-client.js/main/src/amqp-base-client.ts
- https://cloudamqp.github.io/amqp-client.js/classes/AMQPClient.html
- https://cloudamqp.github.io/amqp-client.js/classes/AMQPChannel.html
- https://www.cloudamqp.com/blog/cloudamqp-releases-amqp-websockets.html
- https://github.com/cloudamqp/websocket-tcp-relay
- https://registry.npmjs.org/rabbitmq-stream-js-client
- https://github.com/coders51/rabbitmq-stream-js-client
- https://github.com/coders51/rabbitmq-stream-js-client/releases
- https://www.rabbitmq.com/blog/2025/04/16/amqp-websocket
- https://www.rabbitmq.com/blog/2026/04/23/rabbitmq-4.3-release
- https://rabbitmq.com/blog/tags/new-features
- https://www.rabbitmq.com/blog/2025/09/23/sql-filter-expressions
- https://www.rabbitmq.com/release-information
- https://www.rabbitmq.com/release-information/deprecated-features-list
- https://www.rabbitmq.com/docs/http-api-reference
- https://www.rabbitmq.com/docs/management
- https://www.rabbitmq.com/docs/quorum-queues
- https://www.rabbitmq.com/docs/4.2/quorum-queues
- https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.0.1
- https://www.rabbitmq.com/blog/2024/10/11/modified-outcome
- https://www.rabbitmq.com/blog/2024/08/05/native-amqp
- https://www.rabbitmq.com/docs/amqp
- https://www.rabbitmq.com/docs/oauth2
- https://www.rabbitmq.com/docs/prometheus
- https://www.rabbitmq.com/docs/firehose
- https://www.rabbitmq.com/docs/confirms
- https://www.rabbitmq.com/docs/dlx
- https://www.rabbitmq.com/docs/stream
- https://www.rabbitmq.com/docs/streams
- https://www.rabbitmq.com/docs/stream-filtering
- https://github.com/rabbitmq/rabbitmqadmin-ng
- https://github.com/michaelklishin/rabbitmq-http-api-rs
- https://registry.npmjs.org/-/v1/search?text=rabbitmq%20management%20http%20api%20client&size=25
- https://registry.npmjs.org/-/v1/search?text=prometheus%20text%20format%20parser&size=20
- https://github.com/nodejs/Release
- https://nodejs.org/en/blog/announcements
- https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule
- https://nodejs.org/api/sqlite.html
- https://nodejs.org/docs/latest-v24.x/api/sqlite.html
- https://raw.githubusercontent.com/nodejs/node/main/deps/sqlite/sqlite.gyp
- https://nodejs.org/api/single-executable-applications.html
- https://nodejs.org/api/zlib.html
- https://releases.electronjs.org/schedule
- https://www.electronjs.org/docs/latest/api/safe-storage
- https://www.electronjs.org/docs/latest/api/utility-process
- https://github.com/electron/electron/issues?q=node%3Asqlite
- https://github.com/WiseLibs/better-sqlite3/releases
- https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0
- https://registry.npmjs.org/better-sqlite3
- https://orm.drizzle.team/docs/get-started-sqlite
- https://orm.drizzle.team/docs/sql-schema-declaration
- https://github.com/drizzle-team/drizzle-orm/releases
- https://registry.npmjs.org/drizzle-orm/latest
- https://registry.npmjs.org/-/v1/search?text=drizzle-orm&size=3
- https://registry.npmjs.org/prisma/latest
- https://github.com/prisma/prisma/releases
- https://registry.npmjs.org/-/v1/search?text=prisma&size=5
- https://kysely.dev/docs/dialects
- https://kysely-org.github.io/kysely-apidoc/interfaces/SqliteStatement.html
- https://github.com/wolfie/kysely-node-native-sqlite
- https://registry.npmjs.org/-/v1/search?text=kysely&size=5
- https://github.com/atom/node-keytar
- https://github.com/Brooooooklyn/keyring-node
- https://registry.npmjs.org/@napi-rs/keyring
- https://openbao.org/docs/secrets/transit/
- https://github.com/panva/openid-client
- https://github.com/panva/openid-client/blob/main/docs/README.md
- https://registry.npmjs.org/-/v1/search?text=openid-client&size=3
- https://github.com/stalniy/casl
- https://registry.npmjs.org/-/v1/search?text=@casl/ability&size=4
- https://registry.npmjs.org/-/v1/search?text=better-auth&size=6
- https://www.better-auth.com/docs/plugins/sso
- https://www.better-auth.com/docs/plugins/organization
- https://github.com/nestjs/nest/releases
- https://github.com/nestjs/nest/releases/tag/v12.0.0
- https://registry.npmjs.org/@nestjs/core/12.0.0
- https://registry.npmjs.org/-/v1/search?text=@nestjs/core&size=3
- https://registry.npmjs.org/-/v1/search?text=@nestjs/swagger&size=3
- https://registry.npmjs.org/-/v1/search?text=fastify&size=3
- https://registry.npmjs.org/-/v1/search?text=hono&size=3
- https://github.com/orval-labs/orval
- https://registry.npmjs.org/-/v1/search?text=orval&size=3
- https://registry.npmjs.org/-/v1/search?text=ng-openapi-gen&size=3
- https://github.com/hey-api/openapi-ts
- https://registry.npmjs.org/-/v1/search?text=@hey-api/openapi-ts&size=5
- https://orpc.dev/docs/getting-started
- https://orpc.dev/docs/adapters/electron
- https://orpc.dev/docs/integrations/tanstack-query
- https://orpc.dev/docs/openapi/integrations/implement-contract-in-nest
- https://github.com/middleapi/orpc
- https://registry.npmjs.org/-/v1/search?text=@orpc&size=12
- https://github.com/ts-rest/ts-rest
- https://registry.npmjs.org/-/v1/search?text=@ts-rest/core&size=5
- https://registry.npmjs.org/-/v1/search?text=@trpc/server&size=5
- https://registry.npmjs.org/-/v1/search?text=trpc%20angular&size=10
- https://registry.npmjs.org/-/v1/search?text=@analogjs/trpc&size=3
- https://registry.npmjs.org/-/v1/search?text=@tanstack/angular-query&size=5
- https://registry.npmjs.org/-/v1/search?text=@angular/core&size=3
- https://zod.dev/json-schema
- https://zod.dev/v4
- https://registry.npmjs.org/-/v1/search?text=zod&size=5
- https://registry.npmjs.org/-/v1/search?text=zod-to-openapi&size=5
- https://registry.npmjs.org/-/v1/search?text=nestjs-zod&size=5
- https://developer.mozilla.org/en-US/docs/Web/API/EventSource
- https://developer.chrome.com/blog/local-network-access
- https://github.com/protobufjs/protobuf.js
- https://registry.npmjs.org/-/v1/search?text=protobufjs&size=5
- https://github.com/bufbuild/protobuf-es
- https://protobufes.com/
- https://registry.npmjs.org/-/v1/search?text=@bufbuild/protobuf&size=6
- https://github.com/mtth/avsc
- https://registry.npmjs.org/-/v1/search?text=avsc&size=5
- https://registry.npmjs.org/-/v1/search?text=@msgpack/msgpack&size=3
- https://registry.npmjs.org/-/v1/search?text=cbor&size=8
- https://registry.npmjs.org/-/v1/search?text=bson&size=4
- https://registry.npmjs.org/-/v1/search?text=fast-xml-parser&size=3
- https://github.com/cloudevents/sdk-javascript
- https://registry.npmjs.org/-/v1/search?text=cloudevents&size=5
- https://github.com/cloudevents/spec/blob/main/cloudevents/bindings/amqp-protocol-binding.md
- https://registry.npmjs.org/-/v1/search?text=ajv&size=5
- https://github.com/json-schema-faker/json-schema-faker
- https://registry.npmjs.org/-/v1/search?text=json-schema-faker&size=5
- https://registry.npmjs.org/-/v1/search?text=@faker-js/faker&size=3
- https://registry.npmjs.org/-/v1/search?text=pg-boss&size=3
- https://registry.npmjs.org/-/v1/search?text=p-queue&size=3
- https://registry.npmjs.org/-/v1/search?text=piscina&size=3
- https://registry.npmjs.org/-/v1/search?text=@testcontainers/rabbitmq&size=3
- https://registry.npmjs.org/-/v1/search?text=mqtt&size=3
- https://registry.npmjs.org/-/v1/search?text=amqp-connection-manager&size=3
- https://bun.com/docs/bundler/executables
- https://bun.com/docs/runtime/nodejs-compat
- https://docs.deno.com/runtime/reference/cli/compile/
- https://github.com/yao-pkg/pkg
- https://v2.tauri.app/develop/sidecar/
- https://github.com/GoogleContainerTools/distroless
- https://hub.docker.com/_/node
- https://github.com/actions/runner-images
- https://github.blog/changelog/2025-01-16-linux-arm64-hosted-runners-now-available-for-free-in-public-repositories-public-preview/
- https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/
- https://github.blog/security/supply-chain-security/our-plan-for-a-more-secure-npm-supply-chain/
- https://github.com/pnpm/pnpm/releases/tag/v10.0.0
