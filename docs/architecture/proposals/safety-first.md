# Architecture proposal: safety-first

> One of three competing proposals scored by two judges ([judges.md](judges.md)). The final blueprint is [../blueprint.md](../blueprint.md). Kept for traceability; not normative.

**Philosophy.** Safety and security first, driven by a threat model. The tool sits between people and AI agents on one side and production message flows and credentials on the other. Five rules follow from that:
(1) ONE write path. Every change to broker or message state, including peeks (which have side effects), goes through a single policy-enforced action layer: plan (dry run), then capability gate, RBAC and environment policy, then confirmation or approval, then an audit 'attempt' row, then execute, then a side-effect receipt, then an audit 'outcome' row. This holds whether the request comes from the UI, CLI, MCP or a job.
(2) Version-dependent broker behaviour is data, not code. It lives in a semantics registry with source citations and conformance-test IDs, plus a BrokerProfile probed on every connect.
(3) Fail closed. An unknown build gets the conservative era. An unknown exchange type gets no tap. A failed audit write means no mutation. Unknown config keys mean no boot. A broker-advertised IdP needs a pin and user confirmation.
(4) Least privilege at every boundary. The renderer has no Node, no secrets and no sockets. Only the engine talks to brokers, and only through one SSRF-aware Dialer and a code-configured TrustStore. Protocol libraries sit behind narrow ports whose types cannot express forbidden settlements. Third-party code runs in a WASM sandbox.
(5) Honesty is a security property. We say 'side-effect-aware', never 'non-destructive'. Every touch produces a receipt. Every claim is backed by a public conformance matrix.

## Summary

The blueprint uses one Node 24 engine and one Angular 22 build for three delivery modes:
- **Desktop:** Electron 44.8, then 45 at GA. The engine runs in a utilityProcess and talks to the UI over a MessagePort, with no TCP listener.
- **Local web:** npx or Docker, bound to 127.0.0.1, with a token passed in the URL fragment, using HTTP and WebSocket.
- **Team server:** distroless container, Postgres, OIDC BFF, RBAC, approvals and a hash-chained audit log.

One contract runs over all three carriers. It has REST resources (OpenAPI 3.1) and a credit-based multiplexed live protocol (AsyncAPI 3). On desktop, REST frames are tunnelled over the MessagePort into the same NestJS/Fastify pipeline through fastify.inject. So authentication, validation, the policy layer and serialization are identical in every mode, and the Orval-generated Angular client runs unchanged behind a custom HttpBackend.

Engine structure:
- NestJS 12.1.3 on Fastify serves only as the composition root. Constructor injection uses explicit tokens, so the engine can be bundled with esbuild.
- Domain logic is pure TypeScript in Nx libraries, with enforced module boundaries.
- All mutations go through the ActionGateway.
- The message-safety core consists of the semantics registry (DC-01/02), the capability probe and BrokerProfile (DC-31), an HTTP-only peek preflight, a pure PeekPlanner and a PeekExecutor. The executor uses dedicated peek connections, `basic.get`, then `nack(multiple, requeue)`, then a qos barrier, a watchdog and a hold journal (DC-03..11). Around them sit the tap planner, a DLQ replay engine (confirm-then-ack with a journal) and receipts.

Persistence is Kysely over node:sqlite on desktop and local, and over Postgres on the team server. Secrets are protected by an AES-256-GCM DEK wrapped by safeStorage, the OS keyring, a master password, or KMS/Vault Transit.

Metrics are Prometheus-first and scraped per node, with downsampled local storage, forecasts and alerts.

Build and release: Nx 23.3 with pnpm 12, pinned toolchains, licence and supply-chain gates, a public conformance suite on Linux Testcontainers, signed releases, and an agent-sized work-package plan with verification commands.

Registry checks run today found traps for coding agents. electron-builder 'latest' is 26.15.3, which violates DC-50, so pin 26.17.0. 'oasdiff' on npm is a security placeholder. isolated-vm is a native addon, so the plugin sandbox uses quickjs-emscripten instead.

# <Product> for RabbitMQ® — Architecture Blueprint v0.1 (2026-10-16)

Role: system architect (safety and security first). Status: proposed. Binding inputs: the user decisions and DC-01..DC-60. Where older research conflicts with the fact sheet, the fact sheet wins:
- stream browsing is AMQP-first (fact sheet 0.4);
- desktop uses a MessagePort (DC-35), not loopback HTTP;
- persistence is Kysely + node:sqlite, not Drizzle/PGlite;
- AMQP 1.0 uses our own rhea adapter, not the coders51 client.

## 0. Ground rules, new facts, threat model

**Registry facts checked today.** They are pinned in `pnpm-workspace.yaml` catalogs and enforced by CI.
- electron-builder: npm `latest` = 26.15.3, which **violates DC-50** (>=26.16.1). Pin **26.17.0** (`v26` tag) and electron-updater **6.8.10**.
- Electron: `latest` = 44.8.0, and 45 is beta (45.0.0-beta.5). Ship 44.8.x and move to 45.0.x after GA (2026-10-20) and a soak.
- `@nestjs/platform-fastify` 12.1.3 pins fastify **5.12.5** and light-my-request 6.6.0, so `inject` is available with no direct fastify dependency (DC-49).
- **`oasdiff` on npm is a security placeholder (0.0.1-security).** Use the Go binary through a SHA-pinned GitHub Action or container digest. A lint rule bans it from package.json.
- isolated-vm 7.0.1 is a native gyp addon. The plugin sandbox uses **quickjs-emscripten 0.32.0** (WASM) instead.
- pnpm `latest` = **12.14.0**, which has `minimumReleaseAge`, `blockExoticSubdeps` (enforces DC-24), `strictDepBuilds` and `trustPolicy`.
- Other pins: @modelcontextprotocol/sdk 1.32.1, pg-boss 12.38.0, openid-client 6.8.8, @casl/ability 7.0.2, ws 8.22.0, undici 8.12.2, piscina 5.3.2, pino 10.4.0, p-queue 10.0.0, socks 2.8.10, ssh2 1.17.0, @napi-rs/keyring 2.1.1, @kubernetes/client-node 2.0.0, @ngrx/signals 22.0.1.
- @spartan-ng/brain 1.8.0 was published today. Pin 1.7.0 until it has been reviewed.

**Threat model.** Assets: broker credentials and tokens, message bodies (PII), production message integrity (counters, ordering, survival), audit integrity, and the user's host.

| # | Threat | Primary controls | Owner module |
| --- | --- | --- | --- |
| T1 | Local attacker or web page drives the engine (DNS rebinding, CSRF, cross-site WebSocket hijacking) | Desktop: MessagePort, no listener. Web: 127.0.0.1, 256-bit token, Host/Origin/Sec-Fetch-Site checks, JSON-only, WebSocket ticket | engine/transport |
| T2 | Other local users reach the CLI/MCP endpoint | UDS 0600 or user pipe; capability token on the first frame; scoped, expiring and revocable tokens | transport/ipc |
| T3 | Peek, tap or replay destroys or reorders production messages | ActionGateway, semantics registry, preflight, guard and rescue, nack + barrier, watchdog, receipts | actions, peek, tap, dlq |
| T4 | Secrets at rest or in logs | AES-256-GCM DEK wrapped per mode; redaction at sinks; no tokens in localStorage | secrets, logging |
| T5 | SSRF through broker, IdP, JWKS or Vault URLs, including broker-advertised IdPs | Dialer egress policy, connect-time DNS validation, no redirects, issuer pin and user confirmation | dialer, identity |
| T6 | Malicious broker or payload (parser bombs, XSS, deserialization) | Size/depth caps, worker isolation, text-only rendering, Trusted Types and CSP, no pickle or PHP unserialize | codecs, UI |
| T7 | Over-privileged team user or confused deputy | Deny-by-default RBAC intersected with broker permissions; four-eyes approval; per-user delegated connections | authz, approvals |
| T8 | AI prompt injection or token passthrough (CVE-2026-18655) | MCP only through ActionGateway; opaque connection IDs; mutations off; peek counts as a mutation; quoted, capped output | mcp |
| T9 | Audit tampering or gaps | Append-only hash chain; attempt row written before execution; mutation fails closed if audit fails | audit |
| T10 | Compromised renderer (XSS) | Sandbox and contextIsolation; preload API v1 with no secrets and no paths; strict CSP | desktop |
| T11 | Supply chain, including agent-installed packages | Pins, licence gate, `blockExoticSubdeps`, minimum release age, build-script allow-list, SBOM, signing, SHA-pinned Actions | tooling |

## 1. Process model

### 1.1 Desktop (Electron)
```
+-------------------- Electron app (signed; release fuses: RunAsNode, NodeOptions, NodeCliInspect OFF;
|                     EmbeddedAsarIntegrity, OnlyLoadAppFromAsar, CookieEncryption ON)
| MAIN (trusted, thin): EngineSupervisor | app:// protocol.handle (CSP+nonce, traversal-safe)
|   windows/menus (from command registry) | KeyWrap (safeStorage *Async) | powerMonitor
|   notifications | save dialogs | openExternal allow-list | IPC-sender validation
|      | ctl channel (MessageChannelMain, zod-validated CtlFrame)   | per-window MessageChannelMain
|      v                                                            v
| ENGINE utilityProcess (Node 24 in Electron)        RENDERER (sandbox, contextIsolation, app://main)
|   Nest+Fastify (no listener) <- PortGateway  <== port ==>  Angular: PortHttpBackend + LiveClient
|   LiveHub | ActionGateway | services | adapters            ^ preload: PlatformBridge v1 + port hand-off
|   Dialer --> brokers / IdP / Vault (TrustStore)
|   workers: codec pool (piscina) | FTS indexer | plugin sandbox (QuickJS-WASM) | prom parser
|   IPC endpoint: UDS 0600 / \\.\pipe\<product>-<sid>-<rand>  <== `<product> mcp` (stdio shim), CLI
+-----------------------------------------------------------------------------------------------
```

**Channels.**
- **ctl** (main to engine). Frame types: `init{dataDir, appVersion}`, `keywrap.unwrap/wrap`, `notify`, `export.save{artifactId, path}`, `power.suspend/resume`, `shutdown{deadlineMs}`, `health`. The engine never receives main's privileges.
- **port** (renderer to engine). Contract frames (section 3). The renderer requests a port through `PlatformBridge.requestEnginePort()`. Main checks that `senderFrame.url` has origin app://main, creates a `MessageChannelMain`, sends `port1` to the engine (`attach{windowId}`) and `port2` to the renderer via `webContents.postMessage`. The preload forwards it to the main world with `window.postMessage(msg, location.origin, ports)`. The app accepts exactly one port per page load.

**Startup.**
1. `app.whenReady` (DC: utilityProcess only after `ready`).
2. Register the privileged `app` scheme.
3. `utilityProcess.fork(engine.mjs, {serviceName, stdio:'pipe', respondToAuthRequestsFromMainProcess:true})`.
4. The engine runs migrations, then unlocks the vault: it asks main for `keywrap.unwrap`. If the backend is basic_text or keyutils, the renderer prompts for a master password.
5. The engine loads the TrustStore (`tls.setDefaultCACertificates`) and sends `ready{contract, schemaHash}`.
6. Main creates the BrowserWindow, then the port handshake runs. A contract major mismatch shows a fatal screen.

Budget: engine ready ≤ 600 ms (spike S-03), first paint ≤ 1.5 s.

**Shutdown.** Triggers: `before-quit` (preventDefault once), window close, or OS logoff.
1. Main sends `shutdown{deadlineMs:2000}`.
2. The engine's **DrainCoordinator** runs, in order:
   - stop admitting plans and jobs;
   - `PeekExecutor.flushAll()`: for every holding channel, `nack(lastTag, multiple, requeue)`, then a synchronous `basic.qos` barrier, then close (DC-04);
   - stop taps (cancel, delete, gap marker);
   - checkpoint jobs;
   - close connections;
   - WAL checkpoint;
   - `exit(0)`.
3. If the engine is still alive after 5 s, main calls `utilityProcess.kill()` (SIGTERM on Electron 46). After another 3 s it calls `process.kill(pid,'SIGKILL')`.

The engine's own SIGTERM handler runs the same drain (DC-46).

**Crash and restart.**
- **Engine exits with code ≠ 0.** The supervisor restarts it with backoff (1 s, 3 s, 9 s; at most 3 restarts in 60 s, then an error screen with a diagnostics bundle). The renderer shows an "engine restarted" banner and re-handshakes. On boot the engine reads the **hold journal**: any peek row in `acquiring|holding` state becomes a **W-CRASH incident receipt** ("up to N messages may have DC+1 on 4.3", or AC+1 on 4.0-4.2) and is audited. Jobs resume from their checkpoints only after user confirmation on desktop.
- **Renderer crash.** Main reloads the window. The engine tears down the sessions on that port, and peek jobs complete on their own because they are atomic.

**Sleep and resume.**
- `powerMonitor.suspend` sends `power.suspend`. The engine flushes holds (same protocol), pauses taps, pollers and jobs at their checkpoints, and records a `suspendedAt` marker. Holds last at most 5-30 s (DC-05), so the exposure window is small.
- `resume` makes the engine revalidate connections (heartbeats may have expired), re-probe the BrokerProfile (a broker may have been upgraded), re-run preflight before resuming any job, and emit gap frames.

### 1.2 Local web (npx / Docker)
```
`npx <product>@x.y.z` | docker run -p 127.0.0.1:7341:7341 ghcr.io/<org>/<product>:x.y.z
  Node 24 process = engine (mode=local)
    Fastify listener 127.0.0.1:<port> (Host/Origin allow-list) --> /api/v1 (REST) | /live (WS) | static UI
    IPC endpoint (UDS/pipe) <== CLI, `<product> mcp`
    workers as desktop; data dir ~/.local/share/<product> (or /data volume)
  Browser tab(s): http://127.0.0.1:<port>/#t=<256-bit token>
```

**Startup.**
1. Parse config. Unknown keys fail the boot.
2. Refuse a non-loopback bind unless OIDC or password auth **and** TLS are configured (DC-36).
3. Generate a token in memory. It is never written to argv or env; an optional `--token-file` is written with mode 0600.
4. Print the URL and open the browser (`--no-open` suppresses this).

**Shutdown.** SIGINT or SIGTERM runs the same DrainCoordinator.

**Sleep.** Node gets no suspend event. A `SuspendDetector` notices monotonic and wall-clock drift above 10 s and runs the resume path. That a sleep can land mid-hold is a documented residual risk; it is bounded by the hold caps.

**Docker.** The token is always required, because the peer address is never loopback inside a container. Docs prescribe `-p 127.0.0.1:` (DC-36).

### 1.3 Team server (Docker / Helm)
```
 browser --TLS--> ingress/Gateway (HTTPRoute) --> pod: <product> (distroless nodejs24 nonroot, RO rootfs)
                                                   +- HTTP: /api/v1, /live (WS), /mcp (Streamable HTTP), /auth/*
                                                   +- leader-only (pg advisory lock): pollers, alert eval, sweeper
                                                   +- job workers (pg-boss 12.38.0)
                                                   +- workers: codecs, plugin sandbox
                                                   +- Dialer --egress NetworkPolicy--> brokers, IdP, Vault/KMS
                                                   +--> Postgres (DML role; migrations run by a Helm hook Job with the DDL role)
```

**Startup.**
1. Validate config against the zod schema. The same schema generates the Helm `values.schema.json`.
2. Check that the migration version matches and the KEK is reachable. Otherwise readiness stays false.
3. Join leader election.

**SIGTERM** (terminationGracePeriodSeconds 30, preStop sleep 5):
- readiness false;
- reject new plans;
- flush peeks;
- pause pg-boss jobs at their checkpoints, so they resume elsewhere or after restart;
- stop taps;
- close WebSockets with code 1012;
- release leadership;
- exit.

**Crash.** The pod restarts. Hold-journal incidents are written to audit. pg-boss retries jobs whose heartbeat expired, but **only resumable and idempotent** jobs. Replay jobs resume from the per-message journal, never by blind re-run.

## 2. Module map (Nx 23.3, pnpm 12, TS 6.0.3)

**Tags.**

| Kind | Values |
| --- | --- |
| `scope:` | shared, engine, ui, desktop, cli, server, testkit, tooling |
| `type:` | contracts, domain, port, adapter, service, actions, api, transport, app, feature, ui-lib, data-access, util, testkit, sdk |
| `platform:` | isomorphic, node, browser, electron-main |
| `trust:` | critical (CODEOWNERS plus a mandatory human review: actions, authz, audit, secrets, identity, dialer, truststore, transport, desktop main/preload, MCP, Helm chart) |

**Dependency rules** (`@nx/enforce-module-boundaries` depConstraints plus `tools/arch-tests` written with ts-morph):
1. `type:contracts` may depend only on zod.
2. `type:domain` is pure: it may depend on contracts and domain, and lint bans `node:*`, timers and I/O libraries. Time and randomness are injected through `Clock` and `Rng`.
3. `type:port` may depend on domain and contracts.
4. `type:adapter` may depend on port, domain, contracts and util. **Only adapters** may import amqplib, rhea, undici, pg, node:sqlite, ssh2, socks or @kubernetes/client-node (no-restricted-imports).
5. `type:service` may depend on port, domain, contracts and util. It never imports adapters; bindings happen in `apps/engine`.
6. **Mutation funnel:** ports are split into `*ReadPort` and `*WritePort`. WritePort DI tokens are exported only to `@app/engine-actions` executors. An architecture test fails if any other project imports `*WritePort`, `Amqp091Channel.publish` or `MgmtHttpPort.send`.
7. `type:api` and `type:transport` may depend on services, actions and contracts. Controllers stay thin: at most 15 lines per handler, and mutating handlers call `ActionGateway` only.
8. `scope:ui` may depend on `scope:shared` (`import type` for contracts) and `scope:ui`. It never imports `scope:engine`. `platform:browser` cannot import `platform:node`.
9. `scope:desktop` (main and preload) may depend on contracts and `desktop/*` only. The engine is loaded as a built artefact, not imported.
10. `trust:critical` projects cannot depend on new third-party packages without an ADR. A CI diff check enforces this.

**Projects.**

| Project (import path) | Tags | Responsibility, DCs |
| --- | --- | --- |
| shared/contracts (`@app/contracts`) | contracts, isomorphic | zod: REST DTOs, LiveFrame, Problem, config schema, branded IDs, ActionDescriptor I/O, WarningId |
| shared/domain-core | domain | BrokerProfile, Era, QueueRef, Gate, EnvClass, Result types |
| shared/semantics (`@app/semantics`) | domain | DC-01/02: era resolver; cells for (era × queueType × settleAction × distribution) with citations and `SEM-*` test IDs; PeekPolicy table; warning texts; hazard table (DC-32); known-bug gates |
| shared/effective-config | domain | DC-30: pure resolver tables per key, queue type and version, with provenance |
| shared/routing-sim | domain | Routing: direct, topic, fanout, headers, E2E, AE, DLX chains, CHX/hash/random flagged non-deterministic; policy matching simulation |
| shared/peek-planner | domain | DC-03..16: pure `plan(request, facts, profile, semantics, guardrails)` |
| shared/tap-planner | domain | DC-17..20: source analysis, refusal of hash/random/unknown types, binding copy with arguments, masking badges |
| shared/dlq-model | domain | x-death / x-opt-deaths normalisation, DC-28 destination resolution, DC-27 header strip and stamp, replay plan |
| shared/topology-model, lint-rules, metrics-math, masking | domain | Definitions diff/plan; DC-56 rules; rates, downsampling, forecasts; redaction detectors |
| sdk/decoder-sdk (published), sdk/header-registry (published JSON) | sdk | DC-53 public API and harness |
| engine/ports | port | Mgmt, Amqp091, Amqp10, Stream, Prometheus, Dialer, TrustStore, SecretVault, KeyWrap, Store repos, JobBackend, AuditSink, Notifier, K8s, Clock |
| engine/adapters/mgmt-http | adapter | DC-48/55/32: undici + zod passthrough schemas, product-aware `/get`, query defaults, golden fixtures |
| engine/adapters/amqp091-amqplib (+ amqp091-cloudamqp, contract and test only) | adapter | DC-48: amqplib 2.2.0; no `@types/amqplib`; engine-owned recovery |
| engine/adapters/amqp10-rhea | adapter, critical | DC-22..25: rhea 3.0.5; `vhost:` hostname; described filters; ulong and timestamp encoding; credit 0 plus grant/drain; explicit settle; filter-set echo check |
| engine/adapters/stream (optional) | adapter | rabbitmq-stream-js-client 1.1.0; anonymous only; behind a probe and feature flag |
| engine/adapters/prometheus | adapter | Streaming text parser; per-node scrape |
| engine/adapters/dialer, truststore | adapter, critical | DC-43/44: direct, SOCKS5, CONNECT, ssh2, system ssh, k8s port-forward; egress policy; CA management |
| engine/adapters/{k8s, oidc, vault, notify} | adapter | Cluster discovery; openid-client; Vault/OpenBao dynamic credentials and Transit; webhook/SMTP/desktop |
| engine/adapters/{persistence-sqlite, persistence-postgres, jobs-local, jobs-pgboss} | adapter | Kysely dialects (in-repo node:sqlite dialect), migrations, job backends |
| engine/actions (`@app/engine-actions`) | actions, critical | ActionRegistry, ActionGateway, plan store, confirmation and approval checks, receipts (DC-42) |
| engine/{authz, audit, identity, secrets, approvals} | service, critical | RBAC (CASL 7 in the engine only); hash-chained audit; CredentialProviders + TokenManager (DC-37..39); vault (DC-45); four-eyes |
| engine/services/connections | service | DC-12: per-profile role pools (control, peek, publish, consume), budgets from the BrokerProfile, leases, throwaway channels (DC-11) |
| engine/services/probe | service | DC-31: read-only probe sequence (fact sheet j.2); BrokerProfile cache; on-demand write probes |
| engine/services/{explorer, peek, tap, publish, dlq, decoders-host, streams, topology, effective-config, admin, metrics, alerts, lint, tac, jobs, mcp, live, session} | service | Feature services. The peek and tap executors live here and receive WritePorts only via actions. `admin` enforces DC-21 GET-merge-PUT |
| engine/api-http | api | Nest controllers (reads) and generated action routes |
| engine/transport | transport, critical | HTTP listener guard, WebSocket upgrade (ws 8.22, noServer), PortGateway (inject), IPC socket, FrameCarrier, LiveHub binding |
| engine/config | util | Config zod schema; also exported to Helm |
| apps/engine | app, node | Composition root; mode switch `desktop | local | server`; esbuild bundle |
| apps/web | app, browser | Angular shell; one artefact for all modes |
| ui/{transport, api-client(gen), state, design-system, grid, graph, editor, charts, commands, i18n} | ui-lib/data-access | Section 10 |
| ui/feature-* | feature | connections, overview, queues, exchanges, messages (peek), publish, tap, dlq, streams, topology, policies, admin, metrics, alerts, lint, tac, jobs, audit, approvals, settings, team-admin |
| apps/desktop-main, apps/desktop-preload, desktop/{ipc-contracts, hardening} | desktop, electron-main | Section 1.1 |
| apps/cli | cli, node | npm package `<product>`: `start`, `serve`, `mcp`, `doctor`, `migrate`, `export`, `token` |
| apps/server-image, deploy/helm | server | Image and chart |
| testkit/{broker, fixtures, conformance, fakes, e2e} | testkit | Section 12 |
| tools/{generators, arch-tests, licence-gate, fuse-check, notices, release} | tooling | Agent generators and gates |

## 3. API and transport

### 3.1 One contract
- **Reads** are REST resources under `/api/v1`, for example:
  - `GET /profiles`, `/profiles/{pid}/broker-profile`, `/profiles/{pid}/vhosts/{v}/queues?page&sort&filter&columns`, `/queues/{q}`;
  - `/exchanges`, `/bindings`, `/policies`;
  - `/effective-config/queues/{q}`, `/topology/graph`, `/simulate/route` (pure, so POST is allowed);
  - `/metrics/series`, `/alerts`, `/lint/findings`, `/jobs/{id}`, `/receipts/{id}`, `/captures/{cid}/messages/{mid}/body`, `/audit` (team).
- **All writes and all message touches** go through the action layer:
  - `POST /api/v1/actions/{actionId}/plans`, with the zod input as body, returns an `ActionPlan`: planId, preview, warnings, side effects, confirmation, approval and `expiresAt` (5 min).
  - `POST /api/v1/actions/{actionId}/plans/{planId}/execute {confirmation?, approvalId?, idempotencyKey}` returns a `Receipt` or a `JobRef`.
  - Example action IDs: `queue.peek`, `queue.purge`, `queue.delete`, `tap.start`, `firehose.lease`, `message.publish`, `dlq.replay`, `policy.put`, `vhost.update`, `user.put`, `tac.apply`, `profile.create`.
- **The UI, CLI and MCP call the same endpoints.** CLI calls go over IPC; MCP calls go in process, still through `ActionGateway`. There are no GET mutations anywhere.

### 3.2 Live protocol (AsyncAPI 3, `LiveFrame` in contracts)
One multiplexed channel per UI session.
- **Frames:** `sub{sid, topic, params, credit}`, `credit{sid, n}`, `unsub`, `data{sid, seq, items, dropped, sampled}`, `gap{sid, reason, lost}`, `end`, `err{problem}`, `ping/pong`. On the MessagePort also `http.req/http.res/http.abort` (3.3).
- **Topics:** `tap.messages`, `job.progress`, `metrics.series`, `broker.health`, `profile.changed`, `explorer.delta`, `alerts`, `audit.tail`, `approvals.inbox`.

### 3.3 Carriers

**Desktop: DC-35 evaluated and confirmed.**
- **Loopback HTTP+WS:** one code path, but it opens a TCP surface to every local process and to browsers (DNS rebinding, CSRF, cross-site WebSocket hijacking). Electron hard-disables Local Network Access, and the token would have to reach the renderer. Rejected. It exists only behind a compile-time `DEV_HTTP` flag in dev builds, and `tools/fuse-check` verifies the flag is absent from release builds.
- **MessagePort:** no listener at all, and the capability is possession of a port that main hands only to app://main. Chosen.

**Tunnelling REST over the port, or a separate RPC protocol?**
- (a) **Chosen: tunnel REST.** A custom Angular `HttpBackend` (`PortHttpBackend`) serialises each HttpRequest into `http.req` (bodies as transferable ArrayBuffer or JSON). The engine's `PortGateway` calls `fastify.inject()` (light-my-request), so the **same** Nest pipeline runs: carrier authentication, problem mapping, Standard Schema validation, controller, ActionGateway.
  - Cost: estimated 0.1-0.5 ms per request (spike S-04). Angular `httpResource` and interceptors work unchanged.
  - Abort: `http.abort` forwards to an AbortSignal in the request context.
  - Large exports never travel over HTTP bodies: they become jobs whose artefacts are saved by main (`export.save`), so the renderer never sees file paths.
- (b) A separate RPC protocol (oRPC or JSON-RPC) would mean two API surfaces, duplicated validation and authorisation, and losing OpenAPI and Orval. `@orpc/nest` is beta. Rejected.

**Principal binding for injected requests.** PortGateway adds `x-app-carrier: <per-boot 256-bit secret>`, which lives in engine memory only. The auth hook maps it to the desktop `local-user` principal. The network listener, which exists only in web and server modes, rejects any request that carries this header.

**Local web.** HTTP + WS on 127.0.0.1. Requests carry `Authorization: Bearer <startup token>`; the UI keeps the token in sessionStorage after stripping the URL fragment, never in localStorage or cookies. For WebSocket, the UI first calls `POST /api/v1/session/ws-ticket`, which returns a single-use ticket valid for 30 s and bound to the principal; the ticket travels in `Sec-WebSocket-Protocol: app.v1, app.ticket.<t>`. The server checks Host and Origin on upgrade.

**Team server.** `__Host-sid` cookie, `X-CSRF-Token` header on non-GET requests, the same WebSocket ticket, and an Origin allow-list.

**IPC (CLI/MCP).** Length-prefixed LiveFrames over UDS or a named pipe. The first frame must be `auth{capabilityToken}`; anything else closes the connection within 1 s.
- Unix: directory 0700, socket 0600.
- Windows: Node cannot set a custom DACL on named pipes, and the default DACL grants Everyone read access. So the pipe name carries a random suffix published only in a user-only file, the mandatory token is the control, and spike S-08 evaluates a DACL helper.
- Capability tokens are created in the UI, read-only by default, with a connection allow-list and an expiry. They are stored hashed.

### 3.4 Flow control and backpressure
- **Credits.** The client grants item credits per subscription, for example 256, and refills them as it renders. The server never sends beyond credit. This is mandatory on MessagePort, which has no backpressure signal.
- **Server ring buffer per subscription.** Default 2,000 items or 8 MiB. Overflow policy depends on the topic:
  - `drop-oldest` with a `dropped` counter (tap);
  - `coalesce-latest` (metrics and state, 1-4 Hz);
  - `bounded-block` (job progress).
- **WebSocket.** When `ws.bufferedAmount` exceeds 4 MiB, the server pauses flushing and lets the ring absorb the excess.
- **Upstream.** Tap consumers use prefetch ≤ 1000. Acks are batched only after ring insert. The tap queue's own `x-max-length` + `drop-head` (DC-17) bounds broker-side growth.
- **Payload size.** Live items carry previews of ≤ 64 KiB. Full bodies come from `GET /captures/...` (volatile store).
- **Sampling.** Modes `all | 1-in-N | time-sampled`, with `sampled` counters shown in the UI.

### 3.5 Error model
RFC 9457 `application/problem+json`, with extensions:
- `code`: a stable enum, for example `BROKER_PERMISSION_DENIED`, `CAPABILITY_UNAVAILABLE`, `PEEK_BLOCKED_OVERLIMIT`, `PLAN_EXPIRED`, `CONFIRMATION_MISMATCH`, `APPROVAL_REQUIRED`, `EGRESS_DENIED`, `CONTRACT_MISMATCH`;
- `gate`: the why-disabled reason plus a source link;
- `warnings[]`, `brokerStatus`, `retryable`, `correlationId`, `docsUrl`.

Broker errors are mapped by signature: 403 becomes a missing-permission hint, 405 a provider restriction, and limit signatures become usage-versus-limit.

### 3.6 Versioning and code generation
- **Contract version.** Paths carry the major version. The handshake sends `contract=1.x` and `schemaHash`. A major mismatch is fatal (team rolling updates prompt a reload). Within a major, changes are additive only.
- **Generation pipeline.**
  1. zod (`@app/contracts`) feeds Nest 12 Standard Schema validation and `@nestjs/swagger` 12 `standardSchemaConverter`.
  2. `nx run engine:openapi` boots the app in spec mode, with no listener and fake ports.
  3. It writes `contracts-snapshots/openapi.json` (3.1). Action routes are generated from the ActionRegistry.
  4. orval 8.43.0 (pinned exactly) generates `libs/ui/api-client` (httpClient + httpResource; zod response validation in dev and test builds).
  5. The LiveTopic registry, converted with `z.toJSONSchema`, produces `asyncapi.json`.
- **CI gates.** Snapshot diff; oasdiff (Go binary, digest-pinned) breaking-change check against the last release; the generated client is committed and must regenerate byte-identical.

## 4. Engine framework
**Decision: NestJS 12.1.3 + `@nestjs/platform-fastify` 12.1.3** (fastify 5.12.5 transitive), used as the composition root, DI container and HTTP pipeline only.

**Fastify-only, rejected.** It is lighter and cold-starts faster, but we would hand-roll DI, module encapsulation (which is how we hide WritePort tokens), guards and interceptors, and testing modules. It also gives agents less structure.

**Hono or oRPC, rejected.** Weaker structure, and Nest integration is beta.

**Mitigations for NestJS risks:**
- **No `emitDecoratorMetadata` dependence.** Every constructor parameter uses `@Inject(TOKEN)`, enforced by a lint rule. That lets esbuild bundle the engine; esbuild cannot emit decorator metadata.
- Validation uses Standard Schema (zod 4.6.7). nestjs-zod and class-validator are not used.
- No `@nx/nest` (DC-49). Build with `@nx/esbuild` (or run-commands) and test with Vitest.
- Cold start is measured in CI (≤ 600 ms in a utilityProcess, spike S-03).
- **Nest module per bounded context.** Each one exports read services. WritePort providers are private to `ActionsModule`. Global pieces: `CarrierAuthGuard`, `ProblemFilter`, `CorrelationInterceptor`. There are no Nest WebSocket gateways: LiveHub is framework-free and bound to carriers.

**Agent generators** (`tools/generators`). Each generator emits code, tests and docs stubs, and CI rejects a descriptor with missing fields.
- `nx g @app/tools:read-endpoint --context=queues --name=list`: creates the contract schema, the controller method, the service method on a ReadPort, a unit test, a golden-fixture test placeholder per broker version, and an OpenAPI regeneration step.
- `nx g @app/tools:action --id=queue.purge --risk=destructive --permission=messages.purge`: creates the ActionDescriptor (risk, permission, capability gate, plan, execute, MCP exposure default off, audit redaction), the executor skeleton, a test pack (deny-by-default, plan purity, confirmation, audit attempt and outcome, receipt) and a UI command stub.
- Also: `adapter`, `semantics-cell` (adds a cell, a citation and a conformance test stub), `lint-rule`, `feature-lib`, `decoder`.

## 5. Message-safety layer (core)

### 5.1 ActionGateway pipeline (DC-42)
Every step fails closed.
1. Resolve the descriptor. Unknown means deny.
2. Validate input with zod.
3. Build the ActorContext from the carrier: principal, surface (`ui | cli | mcp | job | system`), `aiInitiated`, `onBehalfOf`.
4. Load the target's BrokerProfile and era.
5. Capability gate (why-disabled).
6. PDP: tool RBAC (deny by default) ∩ broker permission hints ∩ environment-class policy ∩ surface policy. MCP and AI get lower caps, mutations off, and no 'let broker handle'.
7. `descriptor.plan()`. Plans must be side-effect free; tests run them against fakes that throw on any WritePort call. The plan carries warnings and side effects from the semantics registry, a confirmation requirement and an approval requirement.
8. Persist the plan, bound to the principal, inputHash and BrokerProfile fingerprint, with a 5-minute TTL.
9. On execute:
   - same principal;
   - plan not expired;
   - confirmation matches (typed phrase = resource name, or count for bulk);
   - approval granted by a different principal (team);
   - idempotencyKey unused;
   - **TOCTOU re-check** by re-running the cheap preflight, which invalidates the plan on material drift (queue type, L, consumers, era).
10. Write the audit `attempt` row. If the write fails, deny.
11. Execute with an AbortSignal and leases.
12. Produce a receipt, write the audit `outcome` row, and emit a live event.

### 5.2 Peek: planner, executor, guard
**Preflight** (DC-06; HTTP only, touches no messages):
- `GET /api/queues/{v}/{q}`, which gives the type, exclusive owner, auto_delete, `delivery_limit`, delayed_retry, `messages_delayed`, SAC and consumer details, leader, members and online state;
- arguments, policies and operator policies resolved with effective-config;
- DLQ topology from routing-sim (every DLX source and its L);
- length limits and overflow;
- TTL;
- alarms;
- the consumer timeout (`x-consumer-timeout`, policy, queue argument);
- average message size.

**Planner** (pure; keyed by era from DC-02, so unknown or commercial builds get 4.0-4.2 rules):

| Queue / era | Method | Settle | Caps (default/max) | Hold | Gates |
| --- | --- | --- | --- | --- | --- |
| CQ, all eras | 0-9-1 `basic.get`×n | one `nack(last, multiple, requeue)`, qos barrier, close | 20 / 500, 16 MiB | ≤ 5 s target; abort at min(30 s, TTL/4, timeout−90 s on ≤4.2); watchdog mandatory on 4.3+ | exclusive → refuse; CQ-SAC → W-SAC-CQ; drop-head → W-DROPHEAD; auto-delete → get only |
| QQ 3.13 | get×n | nack (≡ reject, DC+1) | 20 / 50 | < channel timeout | always confirm W-313; L = -1 → refuse (DC-16); W-TAIL if no limit |
| QQ 4.0-4.2 | get×n over 0-9-1 | nack (counts) | 20 / 50 (admin 200) | same | **budget consent showing L and each message's attempts** (DC-08); no auto-refresh; W-TAIL if L = -1 |
| QQ 4.3+ | get×n; SAC queue: consumer only if no consumer is active, `x-consumer-timeout` = budget; or AMQP 1.0 credit N + drain + `released` | nack / released only | 20 / 500, 16 MiB | ≤ min(30 s, QQ timeout/4, TTL/4) | **W-OVERLIMIT blocks** (DC-07, with a one-click policy fix); W-DELAY; delayed messages listed as not peekable (DC-14) |
| Stream | AMQP 1.0 offset spec (rhea) on 4.0+, else 0-9-1 `x-stream-offset` (prefetch ≤ 1000, manual ack); stream protocol only if probed reachable; **never get** | accept or ack (credit only) | by count, bytes, time | n/a | header-loss disclosure (DC-26); filter echo check (DC-23) |
| HTTP fallback | `/get` with `ack_requeue_true` (+ `requeue:true` on LavinMQ), count ≤ 50, truncate | server side | 20 / 50 | client timeout above server work | not offered if over-limit is possible (DC-10); never `reject_*` or `ack_requeue_false` |

**Rescue option chosen at plan time** (DC-09):
- `quarantine`: copy to a durable classic `<product>.quarantine` queue on a `publish`-role connection with confirms and mandatory, then `ack` the original;
- `raise-limit`: admin only; on 4.0-4.2 a finite value; wait for the `.delivery_limit` stat before nacking;
- `let-broker-handle`: human, interactive, typed consent only; refused for MCP, jobs and unattended runs.

If no safe option is available for an AI or unattended actor, the plan is rejected. Acquisition always stops at the first doomed message: 4.3+ `x-delivery-count > L`; 4.0-4.2 `x-delivery-count (=AC) ≥ L`; 3.13 with a limit, DC ≥ L.

**Executor protocol (CQ/QQ over 0-9-1):**
1. Lease the `peek` connection for the profile. It is exclusive: one in-flight job, never publishes, nothing else runs on it (DC-11).
2. Open a throwaway channel.
3. Commit a hold-journal row `acquiring`.
4. Loop `basic.get(noAck=false)` until the count, byte cap or empty queue. Copy each message and run the guard.
5. Run the rescue path if needed.
6. `nack(lastTag, multiple=true, requeue=true)`, then `basic.qos(…)` and await qos-ok as a **barrier**, then close the channel.
7. Mark the journal row `settled`.

The watchdog fires at maxHold − 250 ms and forces step 6. Cancel, shutdown and suspend do the same.

The `Amqp091Channel` port **has no `reject` and only `nack(…, requeue: true)`**, and the AMQP 1.0 receiver port exposes only `released | accepted`. DC-03 is therefore a compile-time property.

**Receipt** (DC-15):
- era, method, queue, count, hold time;
- per message: position, AC/DC observed, expected AC/DC delta, redelivered flag, rescued flag;
- settle method, warnings, semantics data version, incidents.

Receipts are stored, audited and returned to MCP. UI copy reads "side-effect-aware peek — messages stay in the queue".

**Node agent** (true zero-side-effect QQ peek via `rabbitmq-queues peek`): deferred, opt-in sidecar inside the broker's trust boundary (ADR-027).

### 5.3 Tap (DC-17..20)
**TapPlanner.**
- Sources and their exchange types:
  - refuse `x-consistent-hash`, `x-modulus-hash`, `x-random`, `x-local-random` and unknown types unless the user explicitly accepts diversion;
  - no E2E tap on CHX below 4.3.6;
  - mode B (E2E) only on request.
- Copy bindings **with their arguments**.
- Simulate policy matches for the tap name (warn on reject-publish, DLX or max-length).
- Check alarms, that classic queues are enabled (4.2+), and permissions.

**Declare.** `<product>.tap.<uuid>` with `exclusive`, `auto_delete`, non-durable, `x-queue-type=classic`, `x-max-length=10000`, `x-overflow=drop-head`, `x-message-ttl=60000`, `x-expires`.

**While running.**
- Consume with prefetch ≤ 1000 on a `consume` connection.
- Re-sync bindings every 30 s, or from the event exchange when it is available.
- UI badges cover the default-exchange blind spot and AE, mandatory and unroutable-metric masking.

**Firehose** is admin only and runs on a **lease** (default 10 min, auto-off on expiry, disconnect or exit):
- per node, via `PUT /api/traces/node/{node}/{vhost}/{name}` when `rabbitmq_tracing` is present, otherwise generated `rabbitmqctl trace_on -n` runbooks;
- never via `PUT /api/vhosts`;
- labelled 'partial' when the cluster is LB-fronted;
- a sweeper removes orphaned tap exchanges and queues at startup.

### 5.4 DLQ centre and replay (DC-27..29, DC-53/54)
**Read.** 0-9-1 peeks (typed tables), decoders (section 11), fingerprint grouping, and recognition of delay infrastructure. Queues managed by other systems (ServiceControl, Wolverine, Topology Operator, provider-owned objects) are **read-only by default** (DC-54).

**Replay** is a resumable job:
1. Plan: destination resolved queue-first (DC-28); exchange routes need a fan-out confirmation.
2. Canary of 1-5 messages, then an observation window.
3. Token bucket throttle.
4. For each message:
   - consume with manual ack and small prefetch;
   - strip `x-death*`, first/last-death headers, `x-delivery-count`, `x-acquired-count`, an elapsed `expiration` and a mismatched `user_id`;
   - keep the logical ID;
   - stamp `x-<product>-replay-{id,count,from,at,by}`;
   - publish on a confirm channel to the default exchange with `mandatory`;
   - on confirm, **ack the source**;
   - on nack or return, **park by confirm-then-ack** to `<product>.parked`. Never return a source to a budget-limited QQ DLQ.
5. Pause when replayed IDs reappear in the DLQ.
6. Journal each message: fingerprint, logical ID, publish sequence, confirm state, ack state.

"Undo" honestly re-parks the journalled copies. Shovel-based moves are gated and blocked on 4.3.0-4.3.6.

### 5.5 Guardrails: environment classes
Each profile has `envClass: dev | test | staging | prod`, a colour and a banner.

|  | dev/test | staging | prod |
| --- | --- | --- | --- |
| Default posture | read-write | read-write | **read-only until 'armed'** (session-scoped, 15 min, audited) |
| Typed confirmation | destructive | mutating+ | mutating+ (type the resource name or count) |
| Approval (team) | none | bulk-destructive | destructive; QQ budget peeks; firehose; bulk replay above N |
| MCP mutations | off by default, approval | approval | approval |
| Body persistence and FTS | allowed | opt-in | volatile only, metadata-only index |
| Masking | off | on | on; `messages.unmask` permission needed |

## 6. Data model and persistence
**Engine.** Kysely 0.29.6 everywhere. Desktop and local use an in-repo node:sqlite dialect (detects `Database ?? DatabaseSync` for Node 26; WAL; FTS5; `readBigInts`; dates as epoch ms). better-sqlite3 13.0.3 is a fallback behind the same adapter. The team server uses pg 8.23.1.

**Migrations.** Two migration sets, one per dialect, as TS files with static imports so they bundle. A CI test applies both and compares a normalised reflected schema. In team mode, migrations run in a Helm hook Job with the DDL role; the app role is DML only, and `audit_event` gets INSERT and SELECT only.

| Entity | Key fields | Notes |
| --- | --- | --- |
| profile | id (opaque, human-named), name, envClass, color, endpoints (http, amqp, stream, prometheus), dialRoute, tlsOpts, credentialRefs (http, amqp separate), issuerPin | team: `connection_catalog` + `broker_credential_mode` |
| credential | id, kind (password, oauth-*, token-command, x509, vault, delegated), ciphertext (AES-GCM), dekId, createdBy | never returned to the UI |
| broker_profile_cache | profileId, json, fingerprint, probedAt | invalidated on resume or version change |
| view / collection / template | grid state, filters; publish templates (headers, properties, body, codec) | per user |
| capture_session / captured_message | sessionId, source (peek, tap, stream), seq, props, headers, bodyCipher or preview, decoded, receiptId | volatile by default; persisted only per 5.5 |
| captured_fts (FTS5) / tsvector | metadata always; decoded body text only for dev/test or opt-in |  |
| plan | planId, actionId, principal, inputHash, payload, expiresAt | TTL 5 min |
| job / job_journal / job_checkpoint | type, state, actor, idempotencyKey, progress; per-message replay rows | pg-boss tables in team mode |
| hold_journal | peekJobId, profileId, queue, state, startedAt, settledAt, held | crash forensics (W-CRASH) |
| receipt | id, actionId, json |  |
| audit_event | seq, ts, actor, surface, action, target, planId, phase (attempt/outcome), result, approvalId, detail (redacted), prevHash, hash | append-only, hash chain, monthly partitions in PG |
| metric_series / metric_points_{raw,1m,1h} | series (broker, node, family, labels hash) and (series, ts, value) | downsampled |
| alert_rule / alert_state / notification_channel | rule DSL, state machine, channel config (secret refs) |  |
| lint_finding, tac_snapshot, tac_plan |  |  |
| decoder_install | id, version, sha256, tier, approvedBy |  |
| team only | user, role, role_binding, group_mapping, session, api_token (SHA-256), approval_request, delegated_token (cipher), mcp_client |  |

**Retention defaults:**
- volatile captures: memory only;
- persisted captures: 30 days;
- plans: 5 minutes;
- receipts and jobs: 90 days;
- audit: 180 days on desktop, 400 days on team (export to SIEM);
- metrics: raw 10-15 s for 24 h, 1 min for 14 d, 1 h for 400 d (desktop: 1 min for 7 d, 1 h for 90 d).

**Encryption at rest.**
- Secrets and persisted bodies are encrypted at field level with AES-256-GCM under a DEK.
- Desktop: the DEK is wrapped with safeStorage `encryptStringAsync` in main.
- Local web: @napi-rs/keyring (optional dependency) or a master password with scrypt (N=2^17); argon2id once spike S-03 verifies `crypto.argon2` under BoringSSL.
- Team: envelope encryption with KMS, Vault Transit, OpenBao Transit, or a file KEK, plus `<product> rewrap` for rotation.
- The SQLite file inherits OS file permissions (0600) and full-disk encryption. The FTS index is documented as plaintext metadata.

## 7. Security model per mode

| Control | Desktop | Local web | Team server |
| --- | --- | --- | --- |
| UI auth | possession of the port | startup token (fragment, sessionStorage); WebSocket ticket | OIDC BFF (openid-client 6.8.8, confidential client, PKCE); `__Host-sid` (Secure, HttpOnly, Lax); idle 30 min / absolute 12 h; CSRF header; API tokens (scoped, hashed); break-glass admin off by default |
| Network surface | none (IPC socket for CLI/MCP) | 127.0.0.1; public bind refused without auth + TLS; Host, Origin and Sec-Fetch-Site checks; JSON-only; no GET mutations | TLS at ingress; `trustProxy` configurable; Origin allow-list |
| CSP | app:// headers: `default-src 'self'; script-src 'self' 'nonce-{n}'; style-src 'self' 'nonce-{n}'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'` | same, served by the engine | same; `connect-src 'self' wss://<host>` |
| Renderer | sandbox, contextIsolation, no nodeIntegration or webview; deny window.open, navigation, permissions and webview attach; devtools off in release; `openExternal` only https and an allow-list after user confirmation | browser sandbox | browser |
| Secrets | DEK via safeStorage async; master password on basic_text or keyutils | keyring or master password | envelope with KMS/Transit; existingSecret |
| Broker identity (DC-37..39) | CredentialProviders + TokenManager | same; device code is useful headless | per-connection mode: delegated OAuth (access tokens only; per-user pools keyed by user, broker, vhost, protocol) > Vault dynamic > personal LDAP > service account (tool RBAC only); user ID in `connection_name` |
| RBAC | single local user + environment guardrails | same | deny by default; permissions `topology.read`, `messages.peek`, `messages.peek.budgeted`, `messages.browseStream`, `messages.tap`, `messages.firehose`, `messages.publish`, `messages.replay`, `messages.purge`, `messages.export`, `messages.unmask`, `topology.write`, `policy.write`, `users.write`, `connections.manage`, `audit.read`, `approvals.grant`, `mcp.use`, `mcp.mutate`; scope patterns (env, connection, vhost, type, name glob); roles: viewer, message-reader, operator, topology-admin, user-admin, auditor, owner |
| Egress (DC-43) | Dialer; private ranges allowed (the user's own network); metadata IPs denied; broker-advertised IdP needs confirmation and a pin | same | admin allow-list per environment; deny loopback, link-local, metadata, RFC1918, CGNAT, ULA and IPv4-mapped forms by default; connect-time DNS validation (`lookup` with `all:true`); `maxRedirections: 0`; NetworkPolicy |
| Audit | local hash chain | local hash chain | system of record; event-exchange correlation; SIEM export |
| MCP (DC-42) | stdio shim to IPC; capability token | same | `/mcp` OAuth resource (RFC 9728 metadata, RFC 8707 audience); no passthrough; maps the subject to a user |

**Identity details** (DC-37/38):
- The TokenManager refreshes at 75% of lifetime and asserts that the username claim is unchanged.
- Renewal per protocol: 0-9-1 `updateSecret` (plus a lazy credentials object for reconnects); AMQP 1.0 `PUT /auth/tokens` on 4.1+, reconnect on 4.0; stream reconnects with offset resume; HTTP retries a 401 once, and only for idempotent requests.
- On ≤4.2.5 the engine cancels its own consumers at token expiry. On 4.2.6+ it absorbs 320 reconnects.
- Size checks: Bearer header ≤ ~4000 bytes; PLAIN response ≤ 4096 (≤4.0) or 8192 bytes.
- Bearer is always preferred over Basic.
- OAuth discovery reads `/js/oidc-oauth/bootstrap.js` (`/api/auth` only on ≤4.1). The issuer is shown, pinned and checked against the allow-list. Desktop always uses the system browser and a loopback PKCE redirect.

**TrustStore** (DC-44): `tls.setDefaultCACertificates(bundled + system + org)`. Per-profile CAs are concatenated with the defaults. `servername` and `checkServerIdentity` are always set for tunnels and IPs. The insecure switch shows a banner. There is no leaf pinning.

**Supply chain.**
- pnpm 12 with exact pins and catalogs, `minimumReleaseAge` (7 days, with an override list for security fixes), `blockExoticSubdeps`, `strictDepBuilds` with an explicit build allow-list (@napi-rs/keyring, electron), and `trustPolicy`.
- A lockfile check bans git or tarball sources (DC-24), TS 7, `@types/amqplib`, primeng ≥22, @primeui, ag-grid-enterprise, apexcharts and `oasdiff`.
- Licence gate per DC-50 via `pnpm licenses list --json`; generated THIRD_PARTY_NOTICES.
- Renovate with release-age delay; Actions pinned by SHA; CodeQL; OpenSSF Scorecard; SBOM (CycloneDX via syft); cosign; npm provenance.
- An **agent dependency allow-list**: adding a package needs an ADR line plus CODEOWNERS review.

## 8. Metrics architecture
**Sources**, behind a `MetricsSource` port, in priority order:
1. Provider adapters: Amazon MQ DescribeBroker ports 16001-16003, at ≥ 60 s, never per-object; CloudAMQP per-node hosts.
2. Prometheus listeners from the overview.
3. Default ports (15692/15691, 9419, 127.0.0.1:15692 on LavinMQ).
4. Fallback: a management API sampler (`columns=`, paged, adaptive interval at most 1 request/s per broker; when stats are off, counts only via `enable_queue_totals`, and rates show "unavailable — enable Prometheus").

**Scraping** is per node, never through a Service or load balancer (DC-33). It uses `/metrics/detailed?family=queue_coarse_metrics&family=queue_consumer_count&vhost=…`, adding `queue=<regex>` only on 4.3+. A streaming parser runs in a worker when the payload exceeds 1 MiB.

**Store.** Counters become rates (with reset detection). Downsampling keeps avg, min, max and last per bucket. Postgres uses daily raw partitions and BRIN indexes.

**Analysis** (pure, in `@app/metrics-math`):
- drain ETA = backlog ÷ EWMA(consume − publish), with a confidence band;
- "why is this queue growing" rules: no consumers, consumer utilisation, unacked at the prefetch ceiling, redelivery rate, alarms or flow control, publisher spikes;
- capacity forecasts against `max-length` and the disk alarm.

**Alerts.** Rule DSL types: threshold, rate-of-change, absence, forecast-breach. Each rule has `for:` and hysteresis. States run pending, firing, resolved. The leader evaluates each tick.
- Desktop and local route to OS or browser notifications (permission prompt).
- Team routes to webhook (generic, Slack-compatible), SMTP or an Alertmanager webhook. Delivery is limited to user-configured endpoints (DC-59), goes through the Dialer, and is deduplicated and rate-limited.

An optional team-mode PromQL adapter reads from an existing Prometheus or Mimir.

## 9. Team-server specifics
**Isolation.**
- Taps and exclusive queues are per session.
- No body caches are shared across users; captures are keyed by session and user.
- IDs are scoped.
- Workers run with `resourceLimits`.
- Quotas: taps (3 per user, 50 global), peek concurrency per broker = 1 per peek connection, jobs per user.

**Shared pollers.** One per broker, run by the leader, using a monitoring-tag service credential. Results fan out through LiveHub to users who hold `topology.read` on that connection.

**Message actions** use the user's delegated or personal connections, with pools keyed by user, broker, vhost and protocol.

**Durable jobs** use pg-boss 12.38.0 with SKIP LOCKED, heartbeats and checkpoints.
- Jobs run as `onBehalfOf` the user. If delegated tokens expire, the job moves to `awaiting-credentials` instead of switching silently to a service account. Running under a job service identity is an explicit per-connection policy and is audited.

**v1 deployment.** Single replica, RollingUpdate, with a Postgres advisory-lock leader so a rollout never doubles pollers.

**HA path (v2):**
- N replicas with leases per broker (row plus TTL) for pollers and alerts;
- live subscriptions stay pod-local, with ingress affinity for `/live`;
- `LISTEN/NOTIFY` for invalidations only (8 KB limit, never payloads);
- optional Valkey or NATS bus for cross-pod fan-out;
- an optional read-only node agent per cluster.

**Helm chart** (OCI on GHCR, cosign-signed):
- `values.schema.json` generated from the config schema;
- `existingSecret` for the DB URL, OIDC secret and KEK;
- restricted Pod Security Standard, `readOnlyRootFilesystem`, non-root;
- liveness `/healthz`, readiness `/readyz` (DB, migrations, KEK);
- optional ServiceMonitor (the tool's own `/metrics` on a separate port), NetworkPolicy (egress to DNS, broker CIDRs, IdP, KMS), PodDisruptionBudget, HTTPRoute and Ingress, and a migration hook Job;
- tested with chart-testing on kind, under Helm 4 and Helm 3.

**Configuration schema** (env or YAML, zod-validated, unknown keys rejected):
- `server {bind, publicUrl, tls, trustProxy}`
- `auth.oidc {issuer, clientId, clientSecretRef, scopes, groupsClaim, roleMappings, session}`
- `database {urlRef, poolMax}`
- `crypto {kekProvider: kms | vaultTransit | openbaoTransit | file, ref}`
- `egress {allow[], denyPrivate: true, allowMetadata: false}`
- `catalog {seedFile?}`
- `rbac {roles, bindings}`
- `approvals {rules}`
- `retention {...}`
- `mcp {enabled: false, audience}`
- `alerts {channels}`
- `logging {level, redact+}`
- `otel {enabled: false, endpoint}`

## 10. UI architecture (Angular 22.2.x)
**Foundations.**
- Standalone components, zoneless (the default), OnPush, signals.
- `resource` and `httpResource` for reads; Signal Forms for forms.
- SignalStore (@ngrx/signals 22.0.1) for shared stores: connections, workspace and tabs, live metrics.
- RxJS 7.8 for socket plumbing. High-frequency data lives in **ring buffers outside the signal graph** and is published to signals at ≤ 10 Hz.
- Transloco 8.4 (all strings externalised); Lucide icons.

**Shell.** IDE layout: activity bar, resizable tree, editor tabs, bottom panel. Routes look like `/c/:profileId/v/:vhost/queues/:q`. Feature libraries are lazy, and heavy panels use `@defer`. Layout is persisted per profile.

**Transport abstraction.**
- `ENGINE_TRANSPORT` has three implementations:
  - `PortTransport` (desktop): `PortHttpBackend` plus `PortLiveClient`;
  - `WebTransport` (local): fetch backend with Bearer, plus WebSocket with a ticket;
  - `ServerTransport`: cookie, CSRF and WebSocket.
- `PLATFORM_BRIDGE` has `DesktopBridge` (preload API v1: `requestEnginePort`, `notify`, `saveExport`, `openExternal`, `onMenuCommand`, `appInfo`) and `WebBridge`.
- Mode is chosen at bootstrap from `window.__APP_PLATFORM__` (set by preload) or `/bootstrap.json`.
- The UI never computes authorisation. It renders `gates` and `allowedActions` sent by the engine.

**Design system** (`@app/ui-ds`):
- Spartan brain 1.7.0 (pinned) plus copied helm code (MIT notice kept), @angular/aria (tree, grid, listbox, menu, tabs), CDK (overlay, virtual scroll, drag-drop), Tailwind 4 tokens as CSS variables.
- Light, dark and high-contrast themes; a compact density of 22-24 px rows.
- A ThemeService pushes tokens into AG Grid, Monaco, uPlot, ECharts and Cytoscape.
- Policy: Aria for composite widgets, Spartan for overlays and forms.

**Grids.** AG Grid Community 36.2.0 behind `<app-data-grid>`, with our own context menu, clipboard, column chooser and status bar. Live updates use `applyTransactionAsync` at 4-10 Hz. Small tables use TanStack.

**Graph.**
- Cytoscape 3.34.4 with compound nodes per vhost. WebGL is used when WebGL2 is available and there are more than 1k elements; otherwise canvas.
- **elkjs 0.12.0 ships unmodified as `assets/elk/elk-worker.min.js`**, with its EPL-2.0 text and a source pointer (DC-51). dagre 3.1.1 is the fallback.
- Foblex 19.3.0 for small editable diagrams.
- Accessible table alternative for every graph.

**Editor.** Our own ESM wrapper around Monaco 0.57.0: JSON plus schema diagnostics, the diff editor, workers via `new Worker(new URL(...))`, and models disposed on destroy.

**Charts.** uPlot 1.6.32 (pinned or vendored) for live series; ECharts 6.1 via ngx-echarts 22 with tree-shaken `echarts/core` for dashboards.

**Commands.** A CommandRegistry (id, title, category, when-context, handler) with a remappable JSON keymap (tinykeys 4.0.1), a palette, and Electron menus generated from the same registry with web-safe alternates.

**Payload rendering.** Text only, through Angular bindings. `innerHTML` is banned by lint, except for the sanitised markdown docs path (DOMPurify).

**Performance budgets** (CI-enforced):

| Metric | Budget |
| --- | --- |
| initial JS (shell + overview) | ≤ 450 KB gzip; any lazy feature chunk ≤ 250 KB except Monaco (≤ 700 KB over the wire), ECharts (≤ 360 KB) and graph (≤ 300 KB plus the ELK worker) |
| engine-ready to first paint (desktop) | ≤ 800 ms; INP ≤ 100 ms |
| live updates | ≤ 4 ms of main-thread script per frame at 10 Hz; no long tasks over 50 ms during tap at 2,000 msg/s with sampling |
| 50k-row grid | first render ≤ 300 ms; 60 fps scroll; sort or filter ≤ 150 ms |
| memory | renderer ≤ 350 MB with a 50k-row grid plus a 10k tap ring |

## 11. Plugin and codec SDK (DC-53)
**`@app/decoder-sdk`** (Apache-2.0, published, semver; SDK version independent of the product). Interface: `detect(msg) → score 0..1`, `decode(msg) → DecodedFailure | DecodedPayload`, `fingerprint(decoded)`, `replayPlan(decoded, ctx) → ReplayHint`. Ships with a harness (`sdk test` against fixture folders) and the machine-readable `header-registry.json`.

**Three trust tiers.**
1. **Built-in, first-party.** Generic death layer, MassTransit, Spring, NServiceBus, EasyNetQ, Celery (v1.1 adds Symfony, Rebus, Wolverine, Laravel, Dramatiq, Sneakers). They run in a piscina worker pool with `resourceLimits` (old generation 64 MB) for resource isolation, not trust isolation.
2. **Declarative manifests.** JSON or YAML: header mappings, JSONPath extraction, regexes compiled with a timeout-safe engine, delay-queue patterns. Interpreted by the engine and safe by construction.
3. **Code plugins.** A single ESM file run in **quickjs-emscripten 0.32.0 (WASM) inside a worker**:
   - no host APIs except injected pure helpers;
   - 32 MiB memory limit;
   - 50 ms interrupt budget per call;
   - 1 MiB input cap;
   - output validated by zod;
   - off by default; desktop install from a local `.tgz` only (no network fetch); team install by admin approval of a sha256 allow-list.

**Payload codecs** (protobufjs or @bufbuild, avsc, msgpack, cbor-x, bson, gzip, deflate, brotli) treat input as untrusted:
- worker execution;
- decompressed size ≤ 16 MiB and ratio ≤ 100×;
- depth limits;
- never unpickle or PHP-unserialize (show hex plus "unsafe format, not deserialized").

**Registration.** A manifest declares `{id, version, sdkRange, tier, frameworks, headerRegistry, entrySha256}`. Incompatible `sdkRange` is refused, and every install is audited.

## 12. Testing architecture

| Layer | What | Where |
| --- | --- | --- |
| Unit (Vitest 5) | domain purity; planner tables; effective-config and routing-sim property tests (fast-check); x-death parsing; masking; ActionGateway deny-by-default; plan purity (WritePort fakes that throw) | all OS |
| Architecture and security | Nx boundaries; mutation funnel (ts-morph); lockfile and licence gates; CSP and header tests; Host, Origin and ticket tests; SSRF policy tests including DNS-rebinding simulation; `fuse-check` on packaged apps | Linux (plus packaging on each OS) |
| Adapter contract | Same suites against amqplib and @cloudamqp/amqp-client; rhea adapter against the broker; mgmt client against **golden fixtures** per version (recorded nightly; a diff opens a PR) | Linux |
| Conformance (public, DC-47) | Each semantics cell `SEM-<era>-<qtype>-<action>` asserts x-delivery-count, x-acquired-count, redelivered, position and survival. Also peek, tap, replay and DC-21 vhost round trip. Brokers 3.13.7, 4.0.9, 4.1.8, 4.2.9, 4.3.6 (required) plus nightly 4.3.7, 4.4 and 5.0 alphas (allowed to fail) × Node 24.22, Node 26.12 and Electron Node (test-fused binary, `ELECTRON_RUN_AS_NODE`). Produces `compatibility.json`, published to the site | Linux (ubuntu-24.04 x64 and arm) |
| Testcontainers 12.2.1 | GenericContainer from `docker/rabbitmq-test` (enables stream and prometheus; exposes 5672, 5552, 15672, 15692). Not the RabbitMQ module, which lacks 5552 and 15692. A 3-node compose cluster runs nightly | Linux |
| Chaos | toxiproxy: latency, reset and blackhole during holds; leader transfer during peek (verifies the nack-barrier ordering uncertainty); token expiry; 320 reconnect; memory alarm | Linux nightly |
| E2E web | Playwright 1.64.1 (Chromium, Firefox, WebKit) against the local-mode engine and a real broker | Linux |
| E2E desktop | Playwright `_electron` against the **test-fused** build (NodeCliInspect and RunAsNode on; never released). Smoke tests with the engine using fake ports; macOS also against `brew install rabbitmq` 4.3.6 | windows-2025, windows-11-arm, macos-15, macos-15-intel |
| Performance | Engine tap ingest (msg/s, GC); peek latency; UI budgets via Playwright traces; 50k-row grid | Linux nightly |
| Visual and a11y | Screenshot tests per theme (Linux fonts pinned); axe on every route; Storybook 10 interaction tests for the design system | Linux |
| Provider contract (manual or nightly with secrets) | Amazon MQ 3.13, 4.2 and 4.3; CloudAMQP; LavinMQ 2.10.2 (recorded expected deviations) | gated workflow |

## 13. Observability of the tool itself
- **Logs.** pino 10.4.0 structured JSON with correlation IDs (requestId, planId, jobId, peekJobId, receiptId).
- **Redaction** at the sink: paths (`authorization`, `password`, `token`, `cookie`, `*.secret`) plus value detectors (`amqps?://user:pass@`, JWT `eyJ…`, Bearer, shovel and federation URIs). Bodies are never logged.
- **Log locations.** Desktop: rotating files in `userData/logs`, 10 MB × 5. Local: stdout plus an optional file. Team: stdout.
- **OpenTelemetry** (`@opentelemetry/sdk-node`) is **off by default**. It is enabled only with an explicit user-configured OTLP endpoint, has no auto-instrumentation of payloads, and uses span attributes from an allow-list.
- **Crash reports.** Electron `crashReporter` is started with `uploadToServer:false` and minidumps stay local. "Export diagnostics bundle" produces redacted logs, versions, BrokerProfile summaries (hostnames optional) and hold-journal incidents, which the user attaches to issues manually.
- **No telemetry, licence server or phone-home** (DC-59). The update check is a user-visible setting that is on by default but only contacts GitHub Releases, with an install-time notice and an opt-out.
- **Team server** exposes its own `/metrics` (opt-in port), `/healthz` and `/readyz`, and audits its own admin actions.

## 14. Build, packaging, release, versioning
- **Toolchain.** Nx 23.3.0 (@nx/angular, @nx/vitest, @nx/playwright, @nx/esbuild, @nx/eslint-plugin; no @nx/nest), pnpm 12.14.x (`packageManager`), Node 24.22.x (engines), TS 6.0.3 strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), ESLint 10 flat config with typescript-eslint and angular-eslint 22, Prettier.
- **Artefacts.**
  - `dist/engine/engine.mjs` (esbuild ESM; native optional `@napi-rs/keyring` outside the bundle);
  - `dist/web`;
  - the desktop app;
  - the npm CLI (engine plus web assets);
  - the container image;
  - the Helm chart.
- **Desktop** (electron-builder **26.17.0** exact, electronFuses, `afterSign` notarise):
  - macOS: dmg + zip for arm64 and x64, Developer ID, hardened runtime, notarised, `NSLocalNetworkUsageDescription`;
  - Windows: NSIS + zip for x64 and arm64, plus MSIX for the Store;
  - Linux: deb and rpm with the AppArmor profile, and AppImage with the Ubuntu 24.04 caveat; never `--no-sandbox`.
  - electron-updater 6.8.10 from GitHub Releases, with differential blockmaps and staged rollout.
- **Release pipeline** (DC-58):
  1. release-please manifest mode; one product semver (0.x until 1.0); Conventional Commits.
  2. The release PR is the human gate.
  3. Tag, then build on native runners.
  4. macOS: sign and notarise.
  5. Windows: sign the app exe (SignPath once eligible; Store for MSIX), build NSIS, sign the installer, **regenerate `latest.yml` and the blockmap**.
  6. Verify: fuses off (`@electron/fuses read`), signatures, licence gate, notices present, SBOM.
  7. GitHub attestations (SLSA provenance), then a draft release, then publish as an **immutable** release.
  8. npm publish via trusted publishing with provenance.
  9. Multi-arch image (node:24-trixie-slim build, distroless nodejs24-debian13:nonroot runtime, native amd64 and arm64 runners, merged by digest), cosign keyless, Trivy.
  10. Helm chart to OCI, signed.
  11. Update the Homebrew tap and winget.
- **Version identifiers:** product semver; API contract major (`/api/v1`); decoder-sdk semver; semantics data version `sem-YYYY.MM.n` (shown in About and in every receipt); config schema version.

## 15. Spikes (must finish before the dependent work packages) and agent work packages

**Spikes:**
- **S-01** MessagePort plus `fastify.inject` round trip; Angular `HttpBackend` override with httpResource; abort handling.
- **S-02** Nest 12 under esbuild with explicit tokens; decorator mode under TS 6.0.3.
- **S-03** Electron 44/45 utilityProcess: cold start; `tls.getCACertificates('system')`; `setDefaultCACertificates`; `crypto.argon2`; safeStorage async timing; keychain prompts.
- **S-04** Port RPC throughput (requests/s, p99) and live frame cost.
- **S-05** app:// with CSP nonces, Trusted Types, Monaco ESM workers, ECharts and Cytoscape style injection.
- **S-06** node:sqlite Kysely dialect plus FTS5 in Electron.
- **S-07** quickjs-emscripten sandbox limits and performance.
- **S-08** Windows named-pipe DACL.
- **S-09** nack, barrier and close ordering under leader transfer (toxiproxy).
- **S-10** MSIX packaging with utilityProcess; SignPath two-pass signing.

**Work packages.** Each WP is one agent task: its own spec file, interfaces from `core_interfaces`, a Given/When/Then list, and a verify command that must pass.

| WP | Scope | Depends | Acceptance (verify) |
| --- | --- | --- | --- |
| WP-01 | Nx and pnpm skeleton, tags, boundaries, pins, lockfile and licence gates, arch-tests | — | `nx run-many -t lint test` green; the gate fails on a planted git dependency or banned package (`nx run tools:gates-selftest`) |
| WP-02 | `@app/contracts` + Problem + LiveFrame + config schema | 01 | `nx test contracts`; `nx run engine:openapi` snapshot stable |
| WP-03 | `@app/semantics`: era resolver + cells + warnings + hazard data | 02 | Unit table tests; every cell has a citation and a test ID (`nx run semantics:audit-cells`) |
| WP-04 | mgmt-http adapter + golden fixtures for 5 versions | 01, 02 | `nx run adapter-mgmt-http:test-golden` |
| WP-05 | Dialer + TrustStore + egress policy | 02 | SSRF suite including rebinding (`nx test dialer`) |
| WP-06 | amqp091 adapter (no reject in the type) + contract suite on two libraries | 04 | `nx run adapter-amqp091:contract --broker=4.3.6` |
| WP-07 | amqp10-rhea adapter (credit 0, drain, described filters, echo check) | 05 | `nx run adapter-amqp10:contract --broker=4.2.9,4.3.6` |
| WP-08 | Capability probe → BrokerProfile + gates | 03, 04 | `nx run probe:it --matrix` (5 versions) |
| WP-09 | Connection manager (roles, budgets, leases, throwaway channels) | 06, 08 | `nx run connections:it` (budget exhaustion queues work) |
| WP-10 | ActionGateway + plan store + RBAC (local) + audit chain | 02, 03 | `nx test engine-actions` (deny by default, TOCTOU, audit-fail-closed) |
| WP-11 | Peek planner (pure) | 03 | Planner table tests for every era × type row |
| WP-12 | Peek executor + watchdog + hold journal + receipts | 09, 10, 11 | `nx run conformance:peek --broker=all` |
| WP-13 | Engine app, carriers, PortGateway, LiveHub, IPC | 10 | `nx run engine:it-transport` (Host, Origin, ticket, inject parity) |
| WP-14 | Electron main and preload, hardening, supervisor, drain | 13 | `nx run desktop:e2e-smoke` (test-fused) + `fuse-check` on the release build |
| WP-15 | Angular shell, transport, design system, command registry | 02, 13 | `nx run web:e2e` (local mode) + budgets |
| WP-16 | Explorer and admin CRUD (DC-21 merge) | 08, 10 | `nx run conformance:vhost-roundtrip` |
| WP-17 | Tap planner and executor + firehose lease | 09, 10 | `nx run conformance:tap` |
| WP-18 | DLQ model, decoders v1, replay job | 10, 12 | `nx run conformance:replay` + framework fixtures |
| WP-19 | Streams browser (AMQP-first) | 07, 08 | `nx run conformance:streams` |
| WP-21 | Metrics scrape, store, forecasts, alerts | 05, 08 | `nx run metrics:it` (Prometheus fixtures per provider) |
| WP-22 | Team: OIDC BFF, Postgres, pg-boss, approvals, Helm | 10, 13 | `nx run server:it` (Keycloak container) + `ct lint-and-install` |
| WP-23 | MCP (stdio and /mcp) over ActionGateway | 10, 13 | `nx run mcp:it` (mutations denied by default; opaque IDs only) |
| WP-24 | Release pipeline, signing, notices | 14 | dry-run release workflow on a tag in a fork |

## ADRs proposed

- **ADR-001 One engine and one UI build serve three delivery modes:** A single Node 24 engine bundle (apps/engine, mode = desktop | local | server) and a single Angular 22 build (apps/web) serve the Electron desktop app, the local web UI (npx/Docker) and the self-hosted team server. Each mode is a composition of carriers and adapters, not a fork of the code.
- **ADR-002 Desktop transport: MessagePort carrying REST via fastify.inject plus the live protocol:** Main creates a MessageChannelMain per window and hands one port each to the engine utilityProcess and to the renderer. REST requests are serialized into http.req frames and dispatched with fastify.inject through the same Nest pipeline. Live subscriptions use the same frame protocol. The desktop app has no TCP listener; loopback HTTP exists only in dev builds behind a compile-time flag.
- **ADR-003 Single policy-enforced action layer, two-phase plan/execute, as the only write path:** Every mutation and every message touch (peek, tap, publish, replay, purge, admin CRUD, firehose, topology apply) is an ActionDescriptor executed through ActionGateway: plan (side-effect free), gate, RBAC, environment and surface policy, confirmation or approval, audit attempt, execute, receipt, audit outcome. WritePort tokens are injectable only inside the actions module, and an architecture test enforces this.
- **ADR-004 Data-driven broker semantics registry with conformance IDs:** @app/semantics holds every version-dependent behaviour as cells keyed by era, queue type, settle action and distribution, each with source citations and a SEM-* conformance test ID. It also holds the PeekPolicy table, warning texts and the hazard table. The era is resolved conservatively per cluster (DC-02). Unknown builds get 4.0-4.2 rules.
- **ADR-005 Peek is a short atomic engine job: AMQP basic.get primary, HTTP /get fallback:** Peeking a classic or quorum queue runs a mandatory HTTP-only preflight, then a pure plan, then execution on a dedicated peek connection: basic.get N, then a single nack(multiple, requeue), then a synchronous basic.qos barrier, then close. A watchdog and a durable hold journal back it up. A post-acquire guard applies the rescue chosen beforehand. Streams use offset reads only. HTTP /get is allowed only with ack_requeue_true, count of at most 50, and never where over-limit messages are possible.
- **ADR-006 Role-separated broker connections with budgets and throwaway channels:** ConnectionManager keeps per broker profile (and per user in delegated team mode) the roles control, peek (one in-flight job, never publishes), publish (confirm channels) and consume (tap and stream). Each role is budgeted against the probed and provider limits. Risky calls (passive declares, gets on SAC or exclusive queues) run on throwaway channels. Work is queued rather than exceeding the budget.
- **ADR-007 NestJS 12 on Fastify as composition root only; framework-free domain; explicit DI tokens:** Use NestJS 12.1.3 with @nestjs/platform-fastify 12.1.3 (fastify 5.12.5 transitive) for DI, module encapsulation, guards, filters and the HTTP pipeline. All constructor injection uses @Inject(TOKEN), so no decorator metadata is needed, and esbuild bundles the engine. Validation uses Standard Schema with zod 4.6.7. No @nx/nest and no nestjs-zod. LiveHub and domain logic are framework-free.
- **ADR-008 In-house protocol adapters behind ports: mgmt HTTP (undici+zod), AMQP 1.0 on raw rhea, amqplib for 0-9-1:** MgmtHttpPort is implemented with undici 8 and zod passthrough schemas, plus golden fixtures for 3.13.7, 4.0.9, 4.1.8, 4.2.9 and 4.3.6. Amqp10Port is our rhea 3.0.5 adapter: vhost hostname, described filters, ulong and timestamp encoding, credit_window 0 with grant and drain, explicit settlement, and a filter-set echo check. Amqp091Port uses amqplib 2.2.0, with the contract suite also run against @cloudamqp/amqp-client. Port types make forbidden settlements unrepresentable: no reject, and nack only with requeue true.
- **ADR-009 Stream browsing is AMQP-first; the stream protocol is an optional fast path:** On 4.0+ use the rhea adapter with offset spec and filters (properties 4.1+, SQL 4.2+). Fall back to AMQP 0-9-1 x-stream-offset (also used on 3.13). Use the stream protocol only when probes show every advertised host:port is reachable. Readers are always anonymous.
- **ADR-010 Persistence: Kysely over node:sqlite (desktop/local) and Postgres (team):** Kysely 0.29.6 with an in-repo node:sqlite dialect (WAL, FTS5, Database or DatabaseSync detection), with better-sqlite3 13.0.3 as fallback, and pg 8.23.1 on the team server. Two migration sets are checked for schema equivalence in CI. In team mode, migrations run in a hook Job with a DDL role and the app uses a DML-only role.
- **ADR-011 Secrets: AES-256-GCM vault with a mode-specific wrapped DEK:** All credentials and persisted bodies are encrypted at field level with AES-256-GCM. The DEK is wrapped by: desktop, Electron safeStorage async APIs in main (handed over via the ctl channel); local web, @napi-rs/keyring forced to Secret Service or a master password (scrypt, argon2id once verified); team, KMS, Vault Transit, OpenBao Transit or a file KEK, with a rewrap command. A master password is required on Linux basic_text or keyutils. The renderer never receives secrets.
- **ADR-012 One Dialer with an SSRF egress policy, and a code-configured TrustStore:** Every outbound socket (broker, mgmt HTTP, Prometheus, OIDC discovery, JWKS, Vault, webhooks) goes through the Dialer: direct, SOCKS5, HTTP CONNECT, ssh2, system ssh -W, or Kubernetes port-forward. It applies connect-time DNS validation of all resolved addresses, private, metadata and link-local deny lists (team default), no redirects, and SNI preservation. The TrustStore calls tls.setDefaultCACertificates and concatenates per-profile CAs.
- **ADR-013 Team identity: OIDC BFF plus per-connection broker credential modes:** The team server is a confidential OIDC client (openid-client 6.8.8, PKCE) with server-side sessions (__Host- cookie, CSRF header). Broker credentials are chosen per connection: delegated OAuth access tokens for the broker audience (never ID tokens) through per-user pools; Vault or OpenBao dynamic users; personal LDAP credentials; or a service account. The result is always intersected with tool RBAC.
- **ADR-014 Deny-by-default RBAC stricter than the broker, plus four-eyes approvals:** Separate permissions for peek, budgeted peek, stream browse, tap, firehose, publish, replay, purge, export, unmask, topology write, policy write, user admin and MCP use or mutate, scoped by environment, connection, vhost, type and name glob. Evaluated in the engine only, with CASL 7. Approval rules per environment class (for example prod purge, 4.0-4.2 QQ budget peek, firehose, bulk replay).
- **ADR-015 Append-only hash-chained audit as system of record, fail closed:** Every action writes an attempt row before execution and an outcome row after, with actor, surface, plan, approval, target, redacted detail and receipt link, chained by SHA-256. In Postgres: INSERT and SELECT only for the app role, monthly partitions, SIEM export. On desktop: a local chain. If the audit write fails, the mutation is denied.
- **ADR-016 Contract-first: zod, then OpenAPI 3.1 and AsyncAPI 3, then the Orval Angular client:** @app/contracts zod schemas drive Nest validation (Standard Schema), OpenAPI via @nestjs/swagger 12 standardSchemaConverter, AsyncAPI generated from the live topic registry, the Helm values schema, and the Orval 8.43.0 client (httpClient plus httpResource). Snapshots are committed. Breaking changes are checked with the oasdiff Go binary, pinned by digest (the npm package of that name is a security placeholder).
- **ADR-017 Live protocol: multiplexed, credit-based subscriptions with server ring buffers:** One channel per session carries sub, credit, data, gap, end and err frames. Per-topic overflow policies: drop-oldest with counters for taps, coalesce-latest for metrics, bounded for jobs. WebSocket bufferedAmount is watched. Previews only (64 KiB or less), with full bodies fetched on demand. Sampling modes.
- **ADR-018 Prometheus-first per-node metrics with a local downsampled store:** Discovery order: provider adapters, then overview listeners, then default ports. Scrape each node with /metrics/detailed family filters (queue= regex only on 4.3+), never through a load balancer. Fall back to adaptive management API sampling. Store raw, 1-minute and 1-hour series. Pure forecasting and diagnosis functions. Alerts evaluated by the leader.
- **ADR-019 Angular 22 zoneless UI with SignalStore, Spartan/Aria/CDK, and AG Grid Community behind adapters:** Standalone components, OnPush, signals, resource and httpResource, Signal Forms, @ngrx/signals 22 stores. Design system from Spartan brain (pinned) plus helm copies, @angular/aria, CDK and Tailwind 4 tokens. AG Grid Community 36.2 behind app-data-grid with our own menu, clipboard and status bar. Cytoscape plus an ELK worker asset (EPL-2.0, unmodified), with a dagre fallback. Our own Monaco 0.57 ESM wrapper. uPlot and ECharts.
- **ADR-020 Decoder and plugin SDK with three trust tiers:** Tier 1: first-party decoders in piscina workers with resourceLimits. Tier 2: declarative manifests interpreted by the engine. Tier 3: third-party code in quickjs-emscripten 0.32.0 (WASM) inside a worker, with memory, time and input caps, no host APIs, off by default, installed from a local file on desktop or from an admin sha256 allow-list on the team server.
- **ADR-021 MCP is a surface of the action layer: opaque IDs, mutations off, peek counts as a mutation:** An in-engine MCP server (@modelcontextprotocol/sdk 1.32.1 pinned): desktop through a stdio shim to the IPC socket with scoped capability tokens; team through /mcp as its own OAuth resource (RFC 9728 and 8707) with no token passthrough. Tools take only human-created opaque connection IDs. Read and plan tools are on. Execute requires human approval in the UI. Outputs are quoted, size-capped, control-character-stripped and masked.
- **ADR-022 Electron hardening and a separate test-fused binary:** Release fuses: RunAsNode, NodeOptions and NodeCliInspect off; ASAR integrity and OnlyLoadAppFromAsar on; cookie encryption on. app:// privileged scheme with per-response CSP nonce and Trusted Types. Sandbox and contextIsolation. Navigation, window-open, permission and webview guards. IPC sender validation. openExternal allow-list. Devtools off in release. A distinct test-fused build (inspect and RunAsNode on) is used only for Playwright and engine-in-Electron tests, and is never published; CI fuse-check verifies this.
- **ADR-023 Team server v1 is a single replica with an advisory-lock leader; HA later:** v1 ships replicas: 1 with a RollingUpdate. A Postgres advisory-lock leader runs pollers, alert evaluation and sweepers. pg-boss 12.38.0 runs durable jobs. The HA path adds per-broker lease rows, ingress affinity for /live, pod-local taps, LISTEN/NOTIFY invalidation, and an optional Valkey or NATS fan-out.
- **ADR-024 Nx module boundaries, generators and pinned toolchain for an agent-built codebase:** Nx 23.3 with pnpm 12 catalogs. Tags for scope, type, platform and trust, plus depConstraints and a ts-morph architecture test for the mutation funnel. Local generators for read endpoints, actions, adapters, semantics cells, lint rules, features and decoders. Exact pins (TS 6.0.3, Nest 12.1.3, orval 8.43.0, amqplib 2.2.0, rhea 3.0.5, electron-builder 26.17.0). Bans on TS 7, @types/amqplib, git dependencies and banned licences. AGENTS.md, a short CLAUDE.md, CODEOWNERS on trust:critical paths.
- **ADR-025 Environment classes drive guardrails, with fail-closed defaults:** Each profile declares dev, test, staging or prod. Prod is read-only until armed (session-scoped, 15 min, audited). Typed confirmations, approval rules, MCP mutation policy, masking and body persistence and indexing all derive from the class. Unknown or unset means prod.
- **ADR-026 Message capture store is volatile by default; persistence is encrypted and indexed by policy:** Peek and tap copies live in per-session memory rings by default. Persisting requires user action (or is disallowed in prod). Persisted bodies are AES-GCM encrypted. FTS5 or tsvector indexes metadata always, and decoded body text only for dev or test or by explicit opt-in.
- **ADR-027 Zero-side-effect QQ peek via a node agent is deferred and lives in a separate trust boundary:** No node agent in v1. A later optional sidecar inside the broker pod or host runs only 'rabbitmq-queues peek' with positional paging and small N, exposes a narrow mTLS API to the team server, and never ships the Erlang cookie outside the broker boundary. It is labelled non-destructive only when used.

## Core interfaces

```ts
// ===== @app/domain-core (pure, isomorphic) =====
export type Brand<T, B extends string> = T & { readonly __brand: B };
export type ProfileId = Brand<string, 'ProfileId'>;   // human-created opaque id; the only handle MCP may use
export type PlanId = Brand<string, 'PlanId'>; export type JobId = Brand<string, 'JobId'>; export type ReceiptId = Brand<string, 'ReceiptId'>;
export type Era = '3.13' | '4.0-4.2' | '4.3' | '4.4';
export type QueueType = 'classic' | 'quorum' | 'stream';
export type EnvClass = 'dev' | 'test' | 'staging' | 'prod';
export interface SourceRef { url: string; note?: string }
export interface Gate { enabled: boolean; reasonCode?: string; reason?: string; source?: SourceRef }
export type Limit = number | 'unlimited' | null; // null = unknown (stats off < 4.2.5)

export interface BrokerProfile {
  profileId: ProfileId; probedAt: string; fingerprint: string;
  product: 'rabbitmq' | 'lavinmq' | 'apsaramq' | 'unknown';
  provider: 'self-hosted' | 'amazon-mq' | 'cloudamqp-shared' | 'cloudamqp-dedicated' | 'ibm' | 'k8s-operator' | 'tanzu' | 'bitnami' | 'unknown';
  versions: { perNode: Record<string, string>; minNode: string | null; build: 'oss' | 'commercial-or-unknown' };
  era: Era; eraEvidence: string[]; qqMachineVersionMin: number | null;
  featureFlags: Record<string, 'enabled' | 'disabled'>; deprecatedFeaturesUsed: string[];
  identity: { username: string; tags: string[]; protected?: boolean };
  nodes: Array<{ name: string; running: boolean; beingDrained?: boolean }>; lbFronted: boolean | 'unknown';
  extensions: string[]; plugins: string[]; exchangeTypes: string[];
  stats: { disabled: boolean; queueTotals: boolean };
  restrictions: { opPolicyEdit: boolean; replicaOps: 'allowed' | 'restricted' | 'unknown'; definitionsExport: boolean };
  limits: { connectionMax?: number; channelMax?: number; frameMax?: number; consumersPerChannel?: number; maxMessageBytes?: number };
  prometheus: { endpoints: Array<{ node: string; url: string }>; perObject: boolean; queueFilter: boolean } | null;
  streams: { available: boolean; streamProtocolReachable: boolean | 'unknown'; amqp10Filters: Array<'bloom' | 'properties' | 'sql'> };
  auth: { oauthIssuer?: { issuer: string; pinned: boolean }; httpChainSeparate: 'yes' | 'no' | 'unknown'; preAuthFrameMax: 4096 | 8192 };
  tls: { verified: boolean; sni?: string; notAfter?: string; insecureOverride: boolean };
  knownHazards: string[];                 // e.g. 'HZ-17255-CHX-E2E', 'HZ-CHANNELS-400-STATS-OFF'
  gates: Record<string, Gate>;            // feature id -> enabled + why-disabled
}

// ===== @app/semantics (DC-01/02) =====
export type SettleAction = 'nack.requeue' | 'reject.requeue' | 'released' | 'modified.df0' | 'modified.df1' | 'rejected'
  | 'close.holding' | 'conn.loss.holding' | 'consumer.timeout' | 'detach.unsettled' | 'http.get.ack_requeue_true';
export type WarningId = 'W-BUDGET' | 'W-313' | 'W-TAIL' | 'W-OVERLIMIT' | 'W-DELAY' | 'W-REDELIVERED' | 'W-HOLD' | 'W-DROPHEAD'
  | 'W-TTL' | 'W-SAC-CQ' | 'W-SAC-QQ' | 'W-EXCLUSIVE' | 'W-CRASH' | 'W-UPGRADED' | 'W-MIXED' | 'W-STREAM';
export interface CounterEffect { acDelta: 0 | 1; dcDelta: 0 | 1; countsTowardLimit: 'yes' | 'no' | 'if-dc-gt-limit' | 'if-limit-set';
  position: 'head' | 'tail' | 'original' | 'delayed' | 'dropped-or-dlx' | 'n/a' }
export interface SemanticsCell { id: `SEM-${string}`; era: Era; queueType: QueueType; action: SettleAction; effect: CounterEffect;
  warnings: WarningId[]; allowedForPeek: boolean; sources: SourceRef[]; conformanceTestId: string; status: 'code-derived' | 'lab-verified' }
export interface PeekPolicy { methods: PeekMethod[]; settle: PeekSettle; caps: { def: number; max: number; adminMax?: number; maxBytes: number };
  maxHoldMs: (f: PeekPreflightFacts) => number; budgetConsent: boolean; autoRefresh: boolean }
export interface SemanticsRegistry {
  readonly dataVersion: string;   // 'sem-2026.10.1'
  resolveEra(p: Pick<BrokerProfile, 'versions' | 'featureFlags' | 'qqMachineVersionMin' | 'product'>): { era: Era; evidence: string[] };
  cell(era: Era, q: QueueType, a: SettleAction): SemanticsCell;   // throws SemanticsGapError -> fail closed
  peekPolicy(era: Era, q: QueueType): PeekPolicy;
  isDoomed(era: Era, h: { xDeliveryCount?: number; xAcquiredCount?: number }, limit: Limit): boolean;
  warning(id: WarningId, locale?: string): { title: string; body: string; source: SourceRef };
}

// ===== @app/peek-planner (pure) =====
export type PeekMethod = 'amqp091.get' | 'amqp091.consume-sac' | 'amqp10.credit-drain' | 'stream.offset-read' | 'http.get';
export type PeekSettle = 'basic.nack.requeue' | 'amqp10.released' | 'credit-only' | 'server-side';
export type RescueOption = 'quarantine' | 'raise-limit' | 'let-broker-handle';
export interface PeekPreflightFacts {
  queue: { name: string; vhost: string; type: QueueType; durable: boolean; autoDelete: boolean; exclusiveOwner?: string;
    messagesReady: number; bytesReady: number; consumers: number; sacActive?: boolean; leaderOk?: boolean; quorumOk?: boolean };
  deliveryLimit: Limit; limitMismatch: boolean;                       // DC-13 W-UPGRADED
  dlqSources: Array<{ queue: string; limit: Limit }>;                // DC-07 check when this queue is a DLQ
  delayedRetry?: { type: 'disabled' | 'all' | 'failed' | 'returned'; messagesDelayed: number };
  lengthLimit?: { max?: number; maxBytes?: number; overflow: 'drop-head' | 'reject-publish' | 'reject-publish-dlx' };
  ttlMs?: number; consumerTimeoutMs?: number; xDeliveryLimitArgMinus1On313?: boolean; alarms: string[];
}
export interface PeekRequest { profileId: ProfileId; vhost: string; queue: string; count: number; truncateBytes: number;
  rescue: RescueOption; consentToken?: string; surface: Surface; aiInitiated: boolean }
export interface PeekPlan { era: Era; queueType: QueueType; method: PeekMethod; settle: PeekSettle; count: number; maxHoldMs: number;
  byteCap: number; warnings: WarningId[]; expectedEffect: CounterEffect; guard: { limit: Limit; era: Era } | null; rescue: RescueOption;
  consent: { kind: 'none' | 'warning-ack' | 'budget' | 'typed'; details?: unknown } }
export type PlanRejection = { rejected: true; code: 'EXCLUSIVE' | 'OVERLIMIT_DLQ' | 'SAC_ACTIVE' | 'NO_QUORUM' | 'LIMIT_MINUS1_313' | 'NO_SAFE_RESCUE' | 'GATE'; reason: string };
export interface PeekPlanner { plan(req: PeekRequest, facts: PeekPreflightFacts, profile: BrokerProfile, sem: SemanticsRegistry, g: GuardrailPolicy): PeekPlan | PlanRejection }

// ===== engine: executor, receipts =====
export interface CapturedMessage { position: number; props: Record<string, unknown>; headers: Record<string, unknown>;
  bodyPreview: Uint8Array; bodyBytes: number; truncated: boolean; redelivered: boolean; xDeliveryCount?: number; xAcquiredCount?: number }
export interface SideEffectReceipt { id: ReceiptId; actionId: string; era: Era; method: PeekMethod; queue: string; holdMs: number;
  settledWith: string; perMessage: Array<{ position: number; acObserved?: number; dcObserved?: number; expectedAcDelta: 0 | 1;
  expectedDcDelta: 0 | 1; rescued?: boolean }>; warnings: WarningId[]; semanticsDataVersion: string; incidents: string[] }
export interface PeekExecutor {
  execute(plan: PeekPlan, ctx: ExecContext): Promise<{ messages: CapturedMessage[]; receipt: SideEffectReceipt;
    stoppedBy: 'count' | 'bytes' | 'empty' | 'guard' | 'watchdog' | 'abort' }>;
  flushAll(reason: 'shutdown' | 'suspend' | 'cancel'): Promise<{ flushed: number; failed: number }>; // nack+qos barrier, DC-04
}

// ===== ports (adapters implement; only actions get WritePorts) =====
export type ConnRole = 'control' | 'peek' | 'publish' | 'consume';
export interface Amqp091Channel {
  get(queue: string): Promise<RawDelivery | null>;                    // noAck=false always
  nack(tag: bigint, multiple: boolean, requeue: true): void;          // no reject, no requeue=false: DC-03 by type
  ack(tag: bigint, multiple: boolean): void;
  qosBarrier(prefetch: number): Promise<void>;                        // synchronous basic.qos -> qos-ok (never global)
  consume(queue: string, o: { prefetch: number; args?: Record<string, unknown> }, on: (d: RawDelivery | null) => void): Promise<string>;
  cancel(consumerTag: string): Promise<void>; close(): Promise<void>;
}
export interface Amqp091PublishChannel { publish(exchange: string, routingKey: string, body: Uint8Array, props: AmqpProps,
  o: { mandatory: boolean }): Promise<'ack' | 'nack' | 'returned'>; close(): Promise<void> }
export interface Amqp091Connection { readonly role: ConnRole; channel(): Promise<Amqp091Channel>; publishChannel(): Promise<Amqp091PublishChannel>;
  updateSecret(token: string, reason: string): Promise<void>; on(e: 'blocked' | 'unblocked' | 'error' | 'close', cb: (x?: unknown) => void): void; close(): Promise<void> }
export interface Amqp10Receiver { grant(n: number): void; drain(): Promise<void>; settle(d: Amqp10Delivery, o: 'released' | 'accepted'): void;
  appliedFilters(): Record<string, unknown>; close(): Promise<void> }    // credit_window 0; filter echo for DC-23
export interface Amqp10Port { openReceiver(c: ConnSpec, address: string, o: { filters?: StreamFilterSpec; offset?: StreamOffsetSpec }): Promise<Amqp10Receiver> }
export interface StreamPort { openAnonymousReader(c: ConnSpec, stream: string, offset: StreamOffsetSpec): Promise<AsyncIterable<StreamRecord>> }
export interface MgmtReadPort { get<T>(req: { profileId: ProfileId; path: string; query?: Record<string, string>; schema: ZodLike<T> }): Promise<MgmtResult<T>> }
export interface MgmtWritePort { send<T>(req: { profileId: ProfileId; method: 'PUT' | 'POST' | 'DELETE'; path: string; body?: unknown; schema: ZodLike<T> }): Promise<MgmtResult<T>> }
export type MgmtResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; signature: string; problem: Problem };
export interface ConnectionManager {
  lease(p: ProfileId, role: ConnRole, o: { vhost: string; principalKey: string; signal: AbortSignal }): Promise<ConnectionLease>;
  budget(p: ProfileId): { used: Record<ConnRole, number>; max: Record<ConnRole, number> };
}
export interface ConnectionLease { readonly id: string; readonly connection: Amqp091Connection; release(): Promise<void> }

export type EgressPurpose = 'broker-amqp' | 'broker-http' | 'prometheus' | 'oidc' | 'jwks' | 'vault' | 'webhook' | 'k8s';
export interface DialTarget { host: string; port: number; tls?: { servername?: string; ca?: string[]; cert?: string; key?: string; insecure?: boolean } ; route: DialRoute }
export type DialRoute = { kind: 'direct' } | { kind: 'socks5'; proxy: string } | { kind: 'http-connect'; proxy: string }
  | { kind: 'ssh'; hops: SshHop[] } | { kind: 'system-ssh'; jump: string } | { kind: 'k8s-port-forward'; context: string; ns: string; pod: string };
export interface EgressPolicy { evaluate(t: { host: string; addresses: string[]; port: number; purpose: EgressPurpose; profileId?: ProfileId }): { allow: true } | { allow: false; code: 'EGRESS_DENIED'; reason: string } }
export interface Dialer { dial(t: DialTarget, purpose: EgressPurpose, signal?: AbortSignal): Promise<import('node:stream').Duplex>;
  undiciConnect(purpose: EgressPurpose, t: DialTarget): unknown; tlsOptions(t: DialTarget): import('node:tls').ConnectionOptions }
export interface TrustStore { init(): Promise<void>; caFor(profileId: ProfileId): string[]; importCa(pem: string, scope: 'org' | ProfileId): Promise<void> }
export interface KeyWrapper { wrap(dek: Uint8Array): Promise<Uint8Array>; unwrap(blob: Uint8Array): Promise<Uint8Array>; readonly backend: string }
export interface SecretVault { put(kind: string, plaintext: Uint8Array, meta: object): Promise<string>; get(ref: string, actor: ActorContext): Promise<Uint8Array>; destroy(ref: string): Promise<void> }
export interface AuditSink { attempt(e: AuditAttempt): Promise<{ seq: bigint }>; outcome(seq: bigint, o: AuditOutcome): Promise<void> } // throws -> deny
export interface CredentialProvider { readonly kind: 'password' | 'oauth-pkce-loopback' | 'oauth-device-code' | 'oauth-client-credentials'
  | 'token-command' | 'static-token' | 'x509' | 'vault-dynamic' | 'delegated-user'; acquire(p: ProfileId, protocol: 'http' | 'amqp' | 'stream', a: ActorContext): Promise<Credential> }
export interface TokenManager { current(p: ProfileId, protocol: 'http' | 'amqp' | 'stream', principalKey: string): Promise<Credential>;
  onRefresh(cb: (e: { profileId: ProfileId; protocol: string; usernameUnchanged: boolean }) => void): void } // asserts same username (DC-37)

// ===== action layer (DC-42) =====
export type Surface = 'ui' | 'cli' | 'mcp' | 'job' | 'system';
export type RiskClass = 'read' | 'side-effect' | 'mutating' | 'destructive' | 'bulk-destructive';
export interface Principal { id: string; kind: 'local-user' | 'oidc-user' | 'api-token' | 'mcp-client' | 'service'; display: string; roles: string[] }
export interface ActorContext { principal: Principal; surface: Surface; aiInitiated: boolean; sessionId: string; requestId: string; onBehalfOf?: Principal }
export type Confirmation = { kind: 'none' } | { kind: 'click' } | { kind: 'typed'; phrase: string };
export interface ActionPlan<P = unknown> { planId: PlanId; actionId: string; inputHash: string; principalId: string; profileFingerprint?: string;
  expiresAt: string; payload: P; preview: unknown; warnings: WarningId[]; sideEffects: CounterEffect[] | string[];
  confirmation: Confirmation; approval: { required: boolean; rule?: string } }
export interface ActionDescriptor<I, P, R> {
  id: `${string}.${string}`; version: number; input: ZodLike<I>; output: ZodLike<R>;
  risk: RiskClass; permission: string; target(i: I): { profileId?: ProfileId; vhost?: string; kind: string; name?: string };
  capability?(p: BrokerProfile): Gate;
  plan(i: I, ctx: PlanContext): Promise<ActionPlan<P> | PlanRejection>;            // MUST be side-effect free (tested)
  recheck?(plan: ActionPlan<P>, ctx: PlanContext): Promise<'valid' | { invalid: string }>; // TOCTOU
  execute(plan: ActionPlan<P>, ctx: ExecContext): Promise<R | { job: JobRequest }>;
  mcp: { exposed: boolean; classification: 'read' | 'mutation'; enabledByDefault: boolean };
  audit: { redact: string[]; summarize(i: I, r?: R): string };
}
export type Decision = { effect: 'allow'; obligations: Array<'mask-bodies' | 'require-approval' | 'typed-confirmation' | 'lower-caps'> } | { effect: 'deny'; code: string; reason: string };
export interface PolicyDecisionPoint { decide(q: { actor: ActorContext; action: ActionDescriptor<unknown, unknown, unknown>; target: ReturnType<ActionDescriptor<unknown, unknown, unknown>['target']>; profile?: BrokerProfile; env: EnvClass }): Decision }
export interface ActionGateway {
  plan(actionId: string, input: unknown, actor: ActorContext): Promise<ActionPlan | PlanRejection | Denial>;
  execute(planId: PlanId, proof: { confirmation?: string; approvalId?: string; idempotencyKey: string }, actor: ActorContext): Promise<Receipt | JobRef | Denial>;
}
export interface ExecContext { actor: ActorContext; signal: AbortSignal; leases: ConnectionManager; mgmtWrite: MgmtWritePort; clock: Clock; receipts: ReceiptWriter }

// ===== jobs =====
export interface JobDefinition<I, C> { type: string; version: number; input: ZodLike<I>; idempotent: boolean; resumable: boolean;
  run(ctx: JobContext<C>, input: I): AsyncGenerator<{ done: number; total?: number; note?: string }, { status: 'succeeded' | 'failed' | 'cancelled'; summary: unknown }> }
export interface JobContext<C> { jobId: JobId; actor: ActorContext; signal: AbortSignal; checkpoint(c: C): Promise<void>; lastCheckpoint(): C | undefined;
  journal: { append(row: Record<string, unknown>): Promise<void> }; throttle: { take(n?: number): Promise<void> }; leases: ConnectionManager }
export interface JobRunner { submit<I>(type: string, input: I, actor: ActorContext, o: { idempotencyKey: string; planId: PlanId }): Promise<JobRef>;
  cancel(id: JobId, actor: ActorContext): Promise<void>; pause(id: JobId): Promise<void>; resume(id: JobId, actor: ActorContext): Promise<void>;
  watch(id: JobId): AsyncIterable<JobEvent> }
export interface JobBackend { enqueue(j: JobRecord): Promise<void>; claim(types: string[], workerId: string): Promise<JobRecord | null>;
  heartbeat(id: JobId): Promise<void>; complete(id: JobId, outcome: unknown): Promise<void>; fail(id: JobId, err: Problem, retryAt?: string): Promise<void> } // sqlite | pg-boss

// ===== transport (contracts + engine + UI) =====
export type LiveFrame =
  | { t: 'hello'; contract: string; schemaHash: string; engine: string; session: string }
  | { t: 'sub'; sid: number; topic: LiveTopic; params: unknown; credit: number } | { t: 'credit'; sid: number; n: number } | { t: 'unsub'; sid: number }
  | { t: 'data'; sid: number; seq: number; items: unknown[]; dropped?: number; sampled?: number }
  | { t: 'gap'; sid: number; reason: 'overflow' | 'reconnect' | 'resume' | 'engine-restart'; lost?: number }
  | { t: 'end'; sid: number; reason: string } | { t: 'err'; sid?: number; problem: Problem }
  | { t: 'http.req'; rid: number; method: string; url: string; headers: Record<string, string>; body?: ArrayBuffer | string }
  | { t: 'http.res'; rid: number; status: number; headers: Record<string, string>; body?: ArrayBuffer | string }
  | { t: 'http.abort'; rid: number } | { t: 'ping' | 'pong'; ts: number };
export type LiveTopic = 'tap.messages' | 'job.progress' | 'metrics.series' | 'broker.health' | 'profile.changed' | 'explorer.delta' | 'alerts' | 'audit.tail' | 'approvals.inbox';
export interface Problem { type: string; title: string; status: number; code: string; detail?: string; gate?: Gate; warnings?: WarningId[]; retryable?: boolean; correlationId: string }
// engine side
export interface FrameCarrier { readonly kind: 'messageport' | 'websocket' | 'ipc'; principal(): Principal; send(f: LiveFrame, transfer?: ArrayBuffer[]): void;
  bufferedBytes(): number; onFrame(cb: (f: LiveFrame) => void): void; onClose(cb: () => void): void }
export interface PortGateway { attach(port: Electron.MessagePortMain, windowId: number): void }  // http.req -> fastify.inject (carrier secret header)
// UI side (Angular)
export interface EngineTransport { readonly kind: 'port' | 'web' | 'server'; readonly httpBackend: import('@angular/common/http').HttpBackend;
  readonly live: LiveClient; readonly state: import('@angular/core').Signal<'connecting' | 'ready' | 'reconnecting' | 'down'> }
export interface LiveClient { subscribe<T>(topic: LiveTopic, params: unknown, o: { credit: number }): LiveSubscription<T> }
export interface LiveSubscription<T> { readonly frames$: import('rxjs').Observable<{ seq: number; items: T[]; dropped?: number } | { gap: string }>; grant(n: number): void; close(): void }
export interface PlatformBridge { readonly platform: 'desktop' | 'web'; requestEnginePort?(): void; notify(n: { title: string; body: string }): Promise<void>;
  saveExport(artifactId: string, suggestedName: string): Promise<'saved' | 'cancelled'>; openExternal(url: string): Promise<boolean>;
  onMenuCommand?(cb: (commandId: string) => void): () => void; appInfo(): Promise<{ version: string; semanticsDataVersion: string }> }

// ===== @app/decoder-sdk (public) =====
export interface DecoderManifest { id: string; version: string; sdkRange: string; tier: 'builtin' | 'declarative' | 'sandboxed'; frameworks: string[]; entrySha256?: string }
export interface DecoderInput { headers: Readonly<Record<string, unknown>>; props: Readonly<Record<string, unknown>>; body: Uint8Array; queue: string; deaths: readonly NormalizedDeath[] }
export interface DecoderPlugin { manifest: DecoderManifest; detect(m: DecoderInput): number;  // 0..1
  decode(m: DecoderInput): DecodedFailure | DecodedPayload; fingerprint(d: DecodedFailure): string;
  replayPlan(d: DecodedFailure, ctx: { knownQueues: readonly string[] }): { destinationQueue?: string; preserveIds: string[]; stripHeaders: string[]; confidence: number } }
```

## Repo layout

```text
<repo>/                                   (Apache-2.0; NOTICE; DCO; never dual-licensed)
├─ AGENTS.md                             canonical agent guide (commands, boundaries, how to add endpoint/action/adapter)
├─ CLAUDE.md                             <=200 lines, imports AGENTS.md; .claude/rules/{engine,ui,desktop,security}.md; .claude/skills/{new-endpoint,new-action,semantics-cell,release}
├─ nx.json  package.json (packageManager pnpm@12.14.x, engines node 24.22.x)  tsconfig.base.json (TS 6.0.3 strict)
├─ pnpm-workspace.yaml                   catalogs (exact pins), minimumReleaseAge, blockExoticSubdeps, strictDepBuilds + build allow-list, trustPolicy
├─ apps/
│  ├─ engine/                            Nest 12 composition root; mode desktop|local|server; esbuild -> dist/engine/engine.mjs
│  ├─ web/                               Angular 22 shell; ONE build for all modes (budgets in project.json)
│  ├─ desktop-main/                      Electron main: supervisor, app:// handler+CSP, KeyWrap, power, menus; electron-builder.yml (26.17.0, fuses)
│  ├─ desktop-preload/                   contextBridge PlatformBridge v1 + engine-port hand-off (separately bundled)
│  ├─ cli/                               npm package `<product>`: start | serve | mcp (stdio shim) | doctor | migrate | rewrap | token
│  └─ server-image/                      Dockerfile (node:24-trixie-slim build -> distroless nodejs24-debian13:nonroot), healthcheck
├─ libs/
│  ├─ shared/                            [scope:shared]
│  │  ├─ contracts/                      zod: REST DTOs, LiveFrame, Problem, config schema, ids, warnings  (type:contracts)
│  │  ├─ domain-core/  semantics/  effective-config/  routing-sim/  peek-planner/  tap-planner/
│  │  └─ dlq-model/  topology-model/  lint-rules/  metrics-math/  masking/  util/      (type:domain, pure, isomorphic)
│  ├─ sdk/  decoder-sdk/ (published)  header-registry/ (published JSON)
│  ├─ engine/                            [scope:engine, platform:node]
│  │  ├─ ports/                          Read/Write port interfaces + DI tokens
│  │  ├─ actions/                        ActionRegistry, ActionGateway, plan store, receipts           (trust:critical)
│  │  ├─ authz/ audit/ identity/ secrets/ approvals/                                                (trust:critical)
│  │  ├─ adapters/  mgmt-http/ amqp091-amqplib/ amqp091-cloudamqp/ amqp10-rhea/ stream/ prometheus/
│  │  │             dialer/ truststore/ k8s/ oidc/ vault/ notify/ persistence-sqlite/ persistence-postgres/ jobs-local/ jobs-pgboss/
│  │  ├─ services/  connections/ probe/ explorer/ peek/ tap/ publish/ dlq/ decoders-host/ streams/ topology/
│  │  │             effective-config/ admin/ metrics/ alerts/ lint/ tac/ jobs/ mcp/ live/ session/
│  │  ├─ api-http/                       thin Nest controllers (reads) + generated action routes
│  │  ├─ transport/                      http guard, ws upgrade+ticket, PortGateway(inject), IPC socket, FrameCarrier (trust:critical)
│  │  └─ config/                         zod config schema -> Helm values.schema.json
│  ├─ ui/                                [scope:ui, platform:browser]
│  │  ├─ transport/  api-client/ (Orval-generated, DO NOT EDIT)  state/  design-system/  grid/  graph/  editor/  charts/  commands/  i18n/
│  │  └─ feature-{connections,overview,queues,exchanges,messages,publish,tap,dlq,streams,topology,policies,admin,metrics,alerts,lint,tac,jobs,audit,approvals,settings,team-admin}/
│  ├─ desktop/  ipc-contracts/ (ctl frames)  hardening/ (CSP, nav guards, permission handlers)       (trust:critical)
│  └─ testkit/  broker/ (images, 3-node compose, toxiproxy)  fixtures/ (golden per broker version)  conformance/ (public SEM-* suite)  fakes/  e2e/
├─ contracts-snapshots/                  openapi.json, asyncapi.json, config.schema.json (committed; CI diff + oasdiff via pinned Go binary)
├─ docker/rabbitmq-test/                 test image enabling stream + prometheus; exposes 5672/5552/15672/15692
├─ deploy/  helm/<product>/ (OCI chart, generated values.schema.json)  compose/ (local dev cluster)
├─ tools/  generators/ (read-endpoint, action, adapter, semantics-cell, lint-rule, feature, decoder)  arch-tests/ (ts-morph funnel)
│          licence-gate/  lockfile-gate/  fuse-check/  notices/  release/
├─ docs/  adr/ (ADR-001..)  site/ (Starlight + OpenAPI)  compatibility/ (generated matrix)  threat-model.md
└─ .github/  workflows/ (ci, conformance-nightly, e2e-desktop, release, codeql, scorecard; actions pinned by SHA)  CODEOWNERS  renovate.json
```

## Risks

- The safety semantics are code-derived, not lab-verified. A wrong registry cell would make peeks destroy or reorder messages while the UI claims safety. → Ship every cell as code-derived. Gate Tier-1 claims on SEM-* conformance passes for 3.13.7, 4.0.9, 4.1.8, 4.2.9 and 4.3.6. Publish the compatibility matrix. Missing or failed cells fail closed with conservative 4.0-4.2 rules and extra consent.
- Under Raft leader changes, a DOWN from channel close could overtake a pipelined nack despite the qos barrier, causing occasional failed-delivery counts on 4.3. → Spike S-09 chaos runs (toxiproxy plus leader transfer, thousands of iterations). Keep the peek connection open after the barrier and close channels lazily. Report observed deltas in receipts. Mark W-CRASH incidents honestly.
- The MessagePort plus fastify.inject tunnel adds latency or breaks Angular HttpClient features such as progress, abort or binary bodies. → Spikes S-01 and S-04 measure p99. Exports go through jobs and main-process save, never HTTP bodies. Abort maps to an AbortSignal. Fallback: a thin port-native read API for hot paths, with no change to the action layer.
- NestJS 12 is new and ESM-only. esbuild bundling, cold start in utilityProcess and ecosystem gaps (no @nx/nest, no nestjs-zod) may bite. → Explicit @Inject tokens, enforced by lint, so no metadata is needed. A cold-start budget test in CI. Nest is confined to the composition root and controllers. Business logic is framework-free, so a Fastify-only swap stays bounded.
- amqplib and rhea each depend on about one maintainer, and the in-house rhea adapter is critical code. → Ports plus contract suites against two 0-9-1 libraries. Pin exactly. Fork-ready vendoring plan. Upstream PRs. The adapter is trust:critical with mandatory human review and fuzzing of decoders.
- Coding agents drift from pins or install placeholder or malicious packages (electron-builder latest violates DC-50; oasdiff on npm is a placeholder; TS 7 breaks Angular). → pnpm catalogs with exact pins, minimumReleaseAge, blockExoticSubdeps and strictDepBuilds. A lockfile gate with a ban list. An agent dependency allow-list requiring an ADR line. CODEOWNERS on manifests. Renovate with delays.
- CSP with nonces and Trusted Types conflicts with Monaco, ECharts or Cytoscape style injection under app://. → Spike S-05 before UI work. Documented style-src exception, styles only, never scripts. Libraries isolated in lazy chunks behind adapters.
- Windows named pipes cannot be ACL-restricted from Node (the default DACL grants Everyone read), exposing the CLI and MCP endpoint to other local users. → Mandatory capability token on the first frame, a random pipe name published in a user-only file, and a 1 s auth timeout. Spike S-08 for a DACL helper. Tokens are read-only by default and expiring.
- Delegated OAuth on the team server is fragile across IdPs (audience, token exchange, Entra one-resource-per-token, size limits causing 431). → IdP presets and a config validator. Token size checks (DC-38). A per-connection mode fallback to Vault dynamic or a service account with explicit audit attribution. Jobs pause in awaiting-credentials instead of escalating.
- Team server v1 single replica is a single point of failure, and rollouts drop live sessions. → An advisory-lock leader prevents duplicate pollers. Resumable jobs. Clients reconnect with gap frames. Documented HA path (leases, affinity, optional bus) for v2.
- Signing and distribution eligibility (SignPath reputation and 'no hacking tools' clause, MSIX with utilityProcess, notarisation costs) delays Windows and macOS trust. → Store MSIX first, Apple notarisation from day one. The linter is framed as configuration hygiene on connected brokers only, with no scanning. Ask SignPath early. Spike S-10.
- Native optional pieces (@napi-rs/keyring) and node:sqlite RC status (Node 26 renames) break npx or Electron installs. → Keyring as optionalDependency with a master-password fallback. The dialect adapter detects Database or DatabaseSync, with a better-sqlite3 fallback. CI on Node 24.22, Node 26.12 and Electron Node.
- Third-party decoder plugins or crafted payloads exhaust memory or CPU, or execute code. → QuickJS-WASM sandbox with memory, time and input caps. Built-in codecs run in workers with resourceLimits and decompression caps. Never deserialize pickle or PHP. Admin sha256 allow-list in team mode.
- Scope is large for an agent-built project, and features crowd out the safety core. → Work packages ordered core-first (semantics, probe, action layer, peek) with executable acceptance. Feature WPs blocked until the gateway and conformance are green. Human review on trust:critical paths.
