> **Design-phase output (2026-10-16).** Amended by [`docs/plan/amendments.md`](../plan/amendments.md), which takes precedence, and re-sequenced web-first ([ADR-030](../adr/ADR-030-web-first-delivery-order.md), [`docs/product/milestones.md`](../product/milestones.md)). Content about a specific third-party product was removed under the docs policy ([ADR-034](../adr/ADR-034-docs-policy.md)).

# Architecture blueprint (final)

This is the final blueprint. It takes simplicity-first's skeleton and grafts in safety-first's safety semantics and scale-first's scale mechanisms, as both judges recommended. It also fixes every item in both judges' gaps lists.

**Delivery and engine.** A single Node 24 ESM engine bundle runs in three hosts:
- an Electron utilityProcess (44.8 now, 45.0.x after GA);
- a loopback Node process, started with npx or as an explicit Docker container mode;
- a Helm-deployed container on Postgres.

One Angular 22.2 build serves all three. The engine is Fastify 5.12.7 only, not NestJS. DC-49's 5.12.5 clause existed to match Nest's pin; 5.12.5 is affected by GHSA-389g-gv7q-r4x8, so we pin 5.12.7. A ≤800-LOC kit turns a single zod `defineAction`/`defineTopic` registry in `@app/contracts` into:
- the router;
- OpenAPI 3.1 and AsyncAPI 3.0;
- MCP tools and CLI commands;
- the typed Angular `EngineApi` (no Orval).

**Transport.** On desktop, one MessagePort per page load tunnels that same router through `fastify.inject`, with header hygiene, a carrier secret and chunked streaming (DC-35). Local web and team modes use HTTP plus one credit-based, multiplexed live WebSocket. The CLI and the stdio MCP shim use a pipe or Unix socket with mutual challenge-response auth.

**Safety layer.** Every mutation and every message touch goes through one fail-closed ActionExecutor: plan/execute, TOCTOU recheck, approvals, receipts, and a hash-chained audit. WritePorts are reachable only from action implementations. The parts:
- **Semantics registry.** A data registry of cells, each linked to lab-evidence artefacts that are recorded independently of the registry.
- **Peek.** A pure peek planner and an executor state machine: sequential `basic.get` (AMQP 1.0 uses credit-1 stepping), stop at the first doomed message, a mandatory disposition, a preflighted rescue path with a defined failure path, `nack` plus a `qos` barrier, and a hold journal.
- **Taps.** A pure TapPlanner with Khepri churn budgets.
- **DLQ replay.** An isolated source role, prefetch 1 on finite-limit QQ sources, park-by-confirm instead of nack, at-least-once identity rules, and drain rules that never nack-flush those sources.

**Persistence and the team server.** Kysely over `node:sqlite` and Postgres, with field encryption covering secrets, captures and plan payloads. Team migrations run as a Helm hook Job under a DDL role; the app role is DML only. The team server ships free, as v1 single-replica Recreate:
- OIDC BFF;
- deny-by-default RBAC;
- four-eyes approvals;
- shared pollers filtered by RBAC;
- per-user delegated pools;
- emergency revoke and maintenance freeze;
- audit anchors outside the database.

**Testing and release.**
- Tests: a broker-lab conformance matrix with mutation testing; executor failure-path cells; chaos runs that assert counter deltas.
- Release: signed releases; supply-chain gates in pnpm 12 (`minimumReleaseAge` plus a reviewed exclusion list and a security lane).
- Delivery: a core-first plan of agent-sized work packages.

# <Product> for RabbitMQ® — Final Architecture Blueprint v1.0

Final architecture, 2026-10-16.

**Binding inputs**
- User decisions: TypeScript end to end (Node 24 engine, Angular 22 UI); one engine and one UI build for desktop, local web and team server; fully open source (Apache-2.0, every feature free); built mostly by AI agents.
- Constraints: DC-01..DC-60, plus the verified fact sheet. Any deviation from a DC is stated inline, with its evidence.

**Naming**
- `<Product>` / `<product>` is the brand placeholder. Workspace libraries use `@app/*`, which is never published.
- No identifier contains "rabbitmq" or "rmq" (DC-57).

**Status of the material**
- Everything about broker behaviour is still code-derived. The conformance suite is on the critical path.
- Numbers marked *target* are budgets that CI verifies, not measurements.

---

## 0. Ground rules

### 0.1 Invariants (enforced mechanically; an agent task may not break one)

| # | Invariant | Enforced by |
| --- | --- | --- |
| I-1 | All broker I/O happens in the engine. Users are never asked to configure CORS or Web-STOMP (DC-34). | Protocol libraries are banned in `runtime:browser`; CSP `connect-src 'self'` |
| I-2 | Every UI, CLI, MCP, job and automation call that mutates state or touches messages goes through `ActionExecutor` (DC-42). | `WritePort` tokens are injectable only into `implementAction` modules (ts-morph architecture test) |
| I-3 | Version-dependent broker behaviour lives in the semantics registry as data (DC-01). | Lint rule `no-broker-version-compare` outside `semantics/` and `svc-capabilities` |
| I-4 | Deliveries are never held across a UI round trip. A hold ends in an explicit `nack` + `basic.qos` barrier, a confirmed park, or a proof-backed `ack` (DC-04/05). | Port types (proofs, role-typed leases); executor model tests |
| I-5 | Engine event-loop delay p99 ≤ 20 ms under sweep + tap load. Watchdogs, heartbeats and nack flushes run on the loop. | `monitorEventLoopDelay` gate in perf CI. Repository ports are async from day one, so SQLite can move to one storage worker if the gate fails. |
| I-6 | Every buffer is bounded by both item count and bytes. Every drop is counted and surfaced. | Lint rule `bounded-buffers-only` (`BoundedRing`/`BoundedQueue`) |
| I-7 | The UI never materialises an unbounded collection. | No "list all" queries for inventory kinds; windowed queries only |
| I-8 | Each broker has a background load budget, and interactive work pre-empts background work. | `BrokerScheduler` is the only path to `MgmtHttpPort` and `PromScrapePort` |
| I-9 | Every outbound socket goes through the Dialer and the TrustStore (DC-43/44). | `net`, `tls` and `undici` imports confined to `net-*` and adapter connectors |
| I-10 | After entry, secrets are write-only. They never reach the renderer, logs, URLs, argv or env (DC-45). | Write-only contract fields; canary-secret log scan in E2E |
| I-11 | Each third-party library is imported only by the project that owns it. | Confinement table (§2.4) |
| I-12 | No telemetry and no phone-home. Update checks are opt-in (DC-59). | Desktop E2E behind a deny-all egress proxy |
| I-13 | No silent loss. Overflow, sampling, gaps, interrupted holds and uncertain replays all appear in receipts and frames. | Live-protocol model tests; receipt schema |
| I-14 | Lab truth outranks registry text. A cell's status changes only with an attached lab evidence artefact and CODEOWNERS sign-off. | `semantics-evidence` CI check |

### 0.2 Registry facts verified today (they change pins)

| Fact (npm or GitHub, 2026-10-16) | Consequence |
| --- | --- |
| fastify 5.12.6 is a security release for GHSA-389g-gv7q-r4x8 / CVE-2026-107832 (low; affects ≥5.12.2 <5.12.6), dated 2026-10-13. `latest` is 5.12.7. `@nestjs/platform-fastify@12.1.3` hard-pins fastify 5.12.5 and light-my-request 6.6.0. | Pin **fastify 5.12.7** directly. There is no NestJS. ADR-004 records the deviation from DC-49's "5.12.5 only" clause. |
| electron-builder `latest` is 26.15.3, which is below DC-50's ≥26.16.1. The `v26` tag is 26.17.0. electron-updater `latest` is 6.8.9; its `v26` tag is 6.8.10. | Pin **electron-builder 26.17.0** and **electron-updater 6.8.10** exactly. |
| `@spartan-ng/brain` 1.8.0 became `latest` today. 1.7.0 was published 2026-10-14. | Pin **1.7.0** (the fact-sheet pin). Moving to 1.8 is a reviewed PR. |
| The npm package `oasdiff` is a `0.0.1-security` placeholder. | Run oasdiff as a digest-pinned Go binary. Ban the npm name. |
| Electron `latest` is 44.8.0; 45.0.0-beta.5 is out, with GA expected 2026-10-20. | Ship 44.8.x. Move to 45.0.x after GA and a 7-day soak. |
| `@modelcontextprotocol/sdk` 1.32.1 depends on express 5, hono, @hono/node-server, cors, cross-spawn and express-rate-limit. | Use it as a test oracle only (§5.12). |
| quickjs-emscripten 0.32.0 is WASM-only, with no native addon. | Use it as the tier-3 plugin sandbox (§11). |
| pnpm 12.14.0 supports `minimumReleaseAge` with `minimumReleaseAgeStrict` and exact-version `minimumReleaseAgeExclude` (`pkg@x.y.z`). It also supports `trustPolicy: no-downgrade` with `trustPolicyExclude`, `blockExoticSubdeps` (default true), `strictDepBuilds` (default true) and `allowBuilds`. `onlyBuiltDependencies` has been removed. | Supply-chain configuration and security lane (§14.3). Many fact-sheet pins are under 7 days old (Angular 22.2.3, zod 4.6.7, Playwright 1.64.1, Testcontainers 12.2.1, Spartan 1.7.0), so the exclusion list is mandatory from M0. |

### 0.3 Threat model

| # | Threat | Primary controls | Owner |
| --- | --- | --- | --- |
| T1 | A web page or local process drives the engine (DNS rebinding, CSRF, cross-site WebSocket hijacking) | Desktop: MessagePort only. Web: 127.0.0.1, token, Host/Origin/Sec-Fetch-Site checks, JSON-only bodies, WS tickets. | transport |
| T2 | Other local users reach CLI/MCP; or an impostor engine phishes the CLI | 0700 directory or user pipe; **mutual HMAC challenge-response** (§7.4); scoped capability tokens | transport/ipc |
| T3 | The tool destroys or reorders production messages | ActionExecutor, registry, preflight, guard + disposition, barrier, watchdog, park-by-confirm, receipts | svc-peek, svc-dlq, svc-tap |
| T4 | Secrets or PII at rest, in logs, plans or approvals | AES-256-GCM field encryption (secrets, captures, plan payloads, journals); redaction; masking | secrets, svc-access |
| T5 | SSRF via broker, IdP, JWKS, Vault or webhook URLs | Dialer egress policy, connect-time DNS validation, no redirects, issuer pinning | net-dialer, svc-identity |
| T6 | Malicious payloads or plugins | Caps, workers, QuickJS-WASM for third-party code, text-only rendering, Trusted Types | plugin-host, UI |
| T7 | Over-privileged user or confused deputy | Deny-by-default RBAC ∩ broker identity; four-eyes approval; delegated pools | svc-access |
| T8 | Prompt injection or token passthrough | MCP only through the executor; opaque IDs; mutations off; peek counts as a mutation | svc-mcp |
| T9 | Audit tampering or gaps | Attempt row before execution, fail-closed; hash chain; DML-only app role; external anchors | svc-audit |
| T10 | Compromised renderer | Sandbox, contextIsolation, port possession only, header stripping, no secrets in preload | desktop |
| T11 | Supply chain, including packages installed by agents | Exact pins, release-age gate + security lane, allow-list, licence gate, SBOM, signing | tooling |
| T12 | The tool's own blast radius during an incident | Per-broker emergency revoke, maintenance freeze, churn budgets | svc-ops |
| T13 | Version skew (UI↔engine, or a broker newer than verified) | Asset retention + controlled reload; "unverified version" mode | web, semantics |

---

## 1. Process model per delivery mode

One `dist/engine/main.mjs` (esbuild ESM) runs in all three hosts. The mode files `modes/{desktop,local,team}.ts` only swap adapters: storage dialect, key wrap, auth, authz policy and listeners. Everything else lives in `compose-core.ts`, and the lint rule `no-mode-branching` keeps mode logic out of the services.

### 1.1 Desktop (Electron 44.8.x, then 45.0.x)

```
+------------------------------- Electron app (release fuses) ------------------------------+
| MAIN (thin): single-instance lock | app:// protocol (asar, CSP nonce, SPA fallback)         |
|  windows/menus (from command registry) | safeStorage *Async | powerMonitor | openExternal   |
|  EngineSupervisor (backoff, port re-issue) | ctl channel (zod CtlFrame)                       |
|        | parentPort ctl                         | per page load: MessageChannelMain          |
|        v                                        v                                            |
| ENGINE utilityProcess (Node 24.22)          RENDERER (sandbox, contextIsolation, app://main) |
|  Fastify app, NO TCP listener <== port ==>   preload: PlatformBridge v1 + port forward        |
|  PortSessionServer -> inject -> router       Angular: MessagePortHttpBackend + LiveClient    |
|  ActionExecutor | LiveHub | services | Dialer -> brokers/IdP/Vault                           |
|  workers: plugin/codec pool, capture-ingest/search worker                                    |
|  IPC: pipe / UDS (CLI, stdio MCP shim; mutual HMAC auth)                                    |
+---------------------------------------------------------------------------------------------+
```

**Startup**
1. Before `ready`, main takes `requestSingleInstanceLock()` and registers the `app` scheme as privileged.
2. On `whenReady`, main serves `protocol.handle('app', …)` and creates the window with `show:false`.
3. Main forks the engine with `utilityProcess.fork(engine.mjs, ['--mode=desktop'], {serviceName, stdio:'pipe', env:{minimal}})`. A fork is legal only after `ready`.
4. Main unwraps the DEK with `safeStorage.decryptStringAsync` and posts `ctl:init{paths, dek, settings}`. On a Linux `basic_text` or keyutils backend there is no DEK, so the renderer asks for a master password first (DC-45).
5. The engine:
   - takes the data-dir lock file (one engine per data directory);
   - backs up the database, then migrates it (refusing a newer schema);
   - loads the TrustStore;
   - reconciles write-ahead records (§1.5);
   - posts `ready{contract, schemaHash}`. Target: within 600 ms (spike S-02).
6. For every renderer load, including reloads:
   - The preload calls `requestEnginePort()`.
   - Main validates `event.senderFrame.url` (origin `app://main`) and issues **exactly one port per page load**.
   - It creates a `MessageChannelMain`, sends `port1` to the engine (`child.postMessage({t:'attach', windowId}, [port1])`) and `port2` to the renderer (`webContents.postMessage('engine-port', null, [port2])`).
   - The preload forwards `port2` to the main world with `window.postMessage(m, 'app://main', ports)`.
   - The port `close` event (MessagePortMain) ends that UI session. Leased resources (taps, jobs) outlive the session until their lease expires.

**Shutdown: DrainCoordinator, about 2 s total (DC-04, DC-46)**

Main prevents `before-quit` once, then posts `ctl:shutdown{deadlineMs:2000}`. The engine's own SIGTERM handler runs the same coordinator.

| Phase | Action | Budget |
| --- | --- | --- |
| 1 Gate | Executor switches to `draining`, so new actions get 503 `ENGINE_SHUTTING_DOWN`. Live sessions get `goaway`. | 10 ms |
| 2 Peeks | `PeekExecutor.flushAll('shutdown')`. Each holder sends `nack(lastUnackedTag, multiple, requeue)`, then awaits a `basic.qos` barrier. The channel is closed lazily after the barrier. AMQP 1.0 holders `release` each delivery, then drain. | 600 ms |
| 3 Sources and jobs | `JobRunner.drain()`. Replay/move jobs stop consuming and wait ≤300 ms for outstanding confirms. Sources with confirmed copies are acked. **Unprocessed sources on a finite-L QQ are parked by confirm-then-ack. They are never nacked.** CQ and unlimited-QQ sources are nack-requeued behind the barrier. Unresolved items are journaled `uncertain-duplicate`, and jobs checkpoint. | 800 ms |
| 4 Taps and firehose | Tap consumers are cancelled; the exclusive queues vanish with the connection. Firehose leases are switched off on a best-effort basis (the lease rows remain for reconciliation). | 300 ms |
| 5 Flush | Journal, receipts, audit, WAL checkpoint, close the database. | 200 ms |
| 6 Exit | `process.exit(0)` | — |

**Escalation.** Main waits for the deadline plus 1 s, then calls `child.kill()`. On Electron 46 that sends SIGTERM only. After a further 2 s main sends `process.kill(pid,'SIGKILL')`.

**Crash and restart**
- The supervisor restarts the engine with backoff of 250 ms, 1 s, 4 s, then 8 s, at most 5 times in 60 s. After that it shows a crash screen offering a redacted diagnostics bundle.
- After each restart, main **re-issues ports to every live renderer**. The renderer shows an "engine restarted" banner, re-handshakes and receives `gap{reason:'engine-restart'}` frames.
- **Jobs resume on desktop only after the user confirms.** Before resuming, preflight runs again and the BrokerProfile is re-probed.
- A renderer crash only reloads the window. Peeks complete on their own because they are atomic.

**Sleep and resume**
- `powerMonitor.suspend` sends `ctl:suspend{deadlineMs:1000}`. The DrainCoordinator runs phases 2–4 in `suspend` mode: holds are flushed, sources parked or flushed, jobs paused at a checkpoint, and pollers and taps paused.
- `resume` marks broker sessions as suspect, reconnects with jitter, re-probes, re-runs preflight before resuming any job (desktop asks the user first), and emits gap frames.
- A clock-jump detector (5 s ticker; a gap over 30 s counts as a resume) backs this up.

### 1.2 Local web: npx and container mode

```
npx <product>@x.y.z serve [--port 0] [--data-dir] [--no-open]
  -> http://127.0.0.1:PORT/#t=<256-bit>   (token only in the URL fragment; optional --token-file 0600)
Browser tab --HTTP+WS--> engine --mode=local (serves dist/web; IPC pipe for CLI/MCP)
```

**Native (npx).**
- Binds 127.0.0.1. Any non-loopback bind is refused unless OIDC or hashed-password auth **and** TLS are configured (DC-36).
- Shutdown on SIGINT/SIGTERM runs the same DrainCoordinator.
- Sleep is caught by the clock-jump detector.
- Tab lifetime does not stop the engine. `--exit-when-idle 10m` is optional.

**Container mode (gap fix).**
- **Activation.** The image sets `<PRODUCT>_RUNTIME=container`. In a container, the network namespace forces a bind on `0.0.0.0:8765` to receive published traffic. This is an explicit exception to DC-36's "refuse non-loopback binds", allowed only under all of these conditions:
  1. the token is **always required**;
  2. the Host allow-list accepts loopback names on **any** port (`127.0.0.1:*`, `localhost:*`, `[::1]:*`), so remaps such as `-p 127.0.0.1:9000:8765` work, plus any `--public-origin`/`PUBLIC_ORIGIN` values;
  3. the Origin check compares against the same set;
  4. the engine logs a startup banner with the exact recommended `docker run -p 127.0.0.1:HOSTPORT:8765` line.
- **Healthcheck.** `HEALTHCHECK` runs `node /app/healthcheck.mjs` against `/healthz`.
- **Documentation.**
  - Docs forbid `-p 8765:8765`, `-p 0.0.0.0:…` and `--network host`, because published ports bypass ufw.
  - The fragment-token URL is printed with the host port taken from `PUBLIC_ORIGIN` when set.
  - The KEK comes from a file secret, or the user enters a passphrase.
- **Why this is not a weakening.** The bind lives inside the container's namespace. Exposure is decided by `-p`, and the token is mandatory on every route.

### 1.3 Team server (Docker or Helm)

```
browsers --TLS--> Ingress / Gateway HTTPRoute --> pod <product> (distroless nodejs24-debian13:nonroot, RO rootfs)
                                                  +- /api/v1, /api/v1/live (WS), /mcp, /auth/*, /healthz /readyz
                                                  +- :9464 /metrics (separate port, token)
                                                  +- shared pollers, per-user pools, JobRunner (SKIP LOCKED), workers
                                                  +- Dialer --NetworkPolicy egress--> brokers, IdP, Vault/KMS, webhooks
Postgres (app role = DML only; migrations = Helm hook Job with DDL role)   PVC (encrypted capture blobs)
```

- **Startup.**
  1. zod-validate the config (unknown keys fail the boot).
  2. Check that the schema version equals the expected one. Migrations already ran in the hook Job, so a mismatch keeps `/readyz` false.
  3. Load the KEK (Vault Transit, OpenBao Transit, KMS or a file).
  4. Acquire the advisory-lock leader **guard**. It stops a second pod from running pollers, but readiness does not depend on it.
  5. Start the modules, then turn `/readyz` true.
- **SIGTERM**:
  1. turn `/readyz` false;
  2. after the preStop sleep of 5 s, run the DrainCoordinator with a 20 s budget (`terminationGracePeriodSeconds: 30`);
  3. close WebSockets with code 1012;
  4. release the guard;
  5. exit.
- **Crash.** Kubernetes restarts the pod, and the same reconciliation runs (§1.5).

### 1.4 Threads (all modes)

| Thread | Work |
| --- | --- |
| Main loop | HTTP, AMQP sockets, watchdogs, executor, live hub, job orchestration |
| Plugin/codec pool (piscina 5.3.2) | Built-in codecs and decoders (tier 1); a QuickJS sandbox host (tier 3) |
| Capture-ingest/search worker | Batched capture writes (≤5 ms per transaction), FTS5 queries on a read-only WAL connection; Postgres uses the pool |
| On demand | Streaming parse of Prometheus and management bodies over 1 MiB, with chunks transferred from the loop |
| Conditional | **One** SQLite storage worker, added only if the I-5 SLO gate fails. Repository ports are async from day one, so the move is mechanical. |

### 1.5 Reconciliation at engine start

| Record | Action |
| --- | --- |
| `hold_journal` rows in `acquiring` or `holding` | W-CRASH incident receipt: up to N messages held. On 4.3 a connection loss counts as a failed delivery (DC+1); on 4.0–4.2 it costs AC+1; positions may have changed. The receipt is audited. |
| `replay_journal` rows in `published` without `acked` | Marked `uncertain-duplicate`. Resolved by the at-least-once rules in §5.8. |
| Firehose lease rows | Expired leases are switched off on each node, then re-verified. |
| Tap exchanges or queues carrying our `x-<product>-session` argument whose session is gone | Swept (DC-18) |
| Jobs in `running` | Become `paused-interrupted`. Desktop resumes after user confirmation; team mode resumes automatically only for `resumable` jobs with idempotent semantics, after preflight. |

---

## 2. Module map: Nx 23.3 projects, tags and rules

### 2.1 Tags

**Layer (`type:`).**

| Tag | Meaning |
| --- | --- |
| `type:contracts` | zod only |
| `type:pure` | isomorphic, no I/O, no `node:*` |
| `type:port` | port interfaces |
| `type:kernel` | executor, jobs, live |
| `type:adapter` | protocol or I/O adapters |
| `type:service` | engine services |
| `type:transport` | carriers |
| `type:app` | applications |
| `type:ui-platform`, `type:ui-data`, `type:ui-design`, `type:ui-lib`, `type:ui-feature` | UI layers |
| `type:sdk` | public SDK |
| `type:test` | test projects |

**Runtime (`runtime:`):** `isomorphic`, `node`, `browser`, `electron-main`, `electron-preload`.

**Trust (`trust:critical`).** These paths need CODEOWNERS sign-off from a human: semantics data and evidence, peek/tap/dlq executors, kernel/actions, svc-access, svc-audit, secrets, svc-identity, net-dialer, net-truststore, transport, desktop main and preload, svc-mcp, the Helm chart, release workflows and `pnpm-workspace.yaml`.

### 2.2 Dependency rules (`@nx/enforce-module-boundaries`, `no-restricted-imports`, `tools/arch-tests` written in ts-morph)

| From | May import |
| --- | --- |
| contracts | zod |
| pure | contracts, pure |
| port | contracts, pure |
| kernel | contracts, pure, port |
| adapter | contracts, pure, port, `net-*` |
| service | contracts, pure, port, kernel, sdk. **Never another service, never an adapter.** Cross-service needs are ports wired in the composition root. |
| transport | kernel, contracts, port |
| apps/engine | anything engine-side (composition root) |
| ui-feature | ui-data, ui-design, ui-lib, ui-platform, contracts, pure. Never another feature. |

Architecture tests:
- **Mutation funnel.** Ports are split into `*ReadPort` and `*WritePort`. `WritePort` symbols and `Amqp091Channel.publish` are reachable only from files that `implementAction(...)` or `defineJob(...)` registered by the executor. The test also fails if a controller-like file calls a service directly.
- **Plan purity.** Every `plan()` runs against WritePort fakes that throw on any call.

Custom lint rules in `tools/eslint-rules`:
- `no-broker-version-compare`
- `no-mode-branching`
- `bounded-buffers-only`
- `honest-wording`: fails on "non-destructive" or "read-only" outside the allow-listed stream and node-agent i18n keys (DC-15)
- `no-inner-html`
- `explicit-zod-schemas`
- `no-direct-fetch` (UI)

### 2.3 Projects

| Group | Projects |
| --- | --- |
| Shared (isomorphic) | `contracts` (kit, actions, topics, errors, config, bridge API, ObjectKey) · `domain-model` (BrokerProfile, ids, VersionRange) · `semantics` (registry data + lookups) · `effective-config` (DC-30) · `routing` (simulator, graph) · `peek-planner` · `tap-planner` · `replay-planner` · `deaths` (x-death / x-opt-deaths normaliser) · `topology-code` · `lint-rules` (DC-56) · `masking` · `forecast` · `live-protocol` (frames + credit/QoS state machines) |
| Engine kernel | `kernel` (config, logger with redaction, clock, ids, Problem mapping, ActionExecutor, PlanStore, guardrails, receipts, DrainCoordinator, BrokerScheduler) · `jobs` (runner, JobStore API, journal, token bucket) · `live` (hub, rings, outboxes, resume) · `transport` (Fastify builder, registry router, auth hooks, Host/Origin/Sec-Fetch checks, WS upgrade + tickets, PortSessionServer, IPC listener + mutual auth, spec emitters, static UI with CSP nonce and asset retention) |
| Ports | `ports` (Read/Write split, role-typed leases, proofs) |
| Adapters | `persistence` (Kysely schema, migrations, in-repo node:sqlite dialect, pg, repositories, FTS5/tsvector, blob store) · `adapter-mgmt-http` (undici + zod, DC-32/48/55) · `adapter-amqp091` (amqplib 2.2.0; @cloudamqp/amqp-client 4.1.1 for contract runs only) · `adapter-amqp10` (in-house, on rhea 3.0.5, DC-22..25) · `adapter-stream` (optional, lazy) · `adapter-prometheus` · `adapter-k8s` (lazy) · `net-dialer` · `net-truststore` · `secrets` (key wraps, field crypto) · `plugin-host` (pool, QuickJS) · `decoders` (built-ins + declarative engine) |
| Services | `svc-connections` (profiles, catalog, role pools, managed-by detection DC-54) · `svc-identity` (providers, TokenManager, discovery and pinning) · `svc-capabilities` (probe → BrokerProfile, gates) · `svc-explorer` (snapshots, windows, search) · `svc-peek` · `svc-messages` (publish, templates, captures, export) · `svc-tap` (taps, firehose) · `svc-dlq` (DLQ centre, replay/move jobs, journal, undo) · `svc-streams` · `svc-topology` (graph, simulator, effective config, topology-as-code) · `svc-admin` (CRUD, DC-21 GET-merge-PUT, ops runbooks) · `svc-ops` (emergency revoke, maintenance freeze, churn budgets) · `svc-metrics` · `svc-alerts` · `svc-lint` · `svc-audit` · `svc-access` (authn, RBAC, approvals, tokens) · `svc-workspace` · `svc-mcp` |
| UI | `ui-platform` (EngineTransport, PlatformBridge) · `ui-data` (EngineApi, engineResource, LiveClient, stores) · `ui-design` (tokens, Tailwind preset, Spartan helm copies, Aria wrappers, ThemeService) · `ui-grid` · `ui-graph` · `ui-editor` · `ui-charts` · `ui-commands` · `ui-payload` · `feature-{connections, explorer, messages, tap, dlq, streams, topology, admin, metrics, lint, jobs, approvals, governance, settings}` |
| SDK | `plugin-sdk` (published later as `@<coined>/plugin-sdk`) · `header-registry` (JSON) |
| Apps | `engine` · `web` · `desktop` (main + preload) · `cli` · `conformance` · `e2e-web` · `e2e-desktop` · `e2e-team` · `perf` · `chaos` |
| Tooling | `tools/generators` · `tools/eslint-rules` · `tools/arch-tests` · `tools/supply-chain` (licence gate, lockfile gate, allow-list, notices from esbuild metafile) · `tools/semantics-evidence` · `packaging/docker` · `packaging/helm` |

### 2.4 Third-party confinement

| Package | Only in |
| --- | --- |
| amqplib | adapter-amqp091 |
| rhea | adapter-amqp10 and testing/oracle-amqp10 (pinned via overrides) |
| undici | adapter-mgmt-http, adapter-prometheus, net-dialer, svc-alerts notify adapter |
| node:sqlite, better-sqlite3 | persistence |
| pg | persistence |
| ssh2, socks | net-dialer |
| @kubernetes/client-node | adapter-k8s, net-dialer |
| openid-client | svc-identity's oidc adapter, svc-access |
| quickjs-emscripten | plugin-host |
| fastify, ws | transport, apps/engine |
| electron | apps/desktop |
| ag-grid-* | ui-grid |
| cytoscape, elkjs (asset), dagre | ui-graph |
| @foblex/flow | ui-graph/flow |
| monaco-editor | ui-editor |
| uplot, echarts, ngx-echarts | ui-charts |

**Banned everywhere:**
- `typescript@7`, `@types/amqplib`, `@nestjs/*`, `nestjs-zod`, `@nx/nest`, `orval`
- `primeng>=22`, `@primeui/*`, `ag-grid-enterprise`, `apexcharts`, `ngx-monaco-editor-v2`
- `oasdiff` (npm)
- `rabbitmq-amqp-js-client` outside the oracle project
- any git or tarball source (DC-24)

**Uniform service shape:**

```
src/
  module.ts        createXModule(deps): EngineModule
  actions/*.ts     one implementAction per file
  topics.ts
  jobs/*.ts
  internal/**
  *.spec.ts
README.md          purpose, public API, invariants, proof commands
```

---

## 3. API and transport

### 3.1 One contract (`@app/contracts`, zod 4.6.7)

Each capability is declared once with `defineAction`. The declaration carries:
- `id`, `kind` (`query | command | peek | job`)
- `input` and `output` schemas
- `permission` and `risk`
- `planning` (`none | optional | required`; environment policy can raise it)
- `confirm`, `audit`, `target(input)`
- bindings: `http{method, path}`, `mcp{expose, mutating}`, `cli{command}`
- `since`

`defineTopic` declares `{id, params, item, qos: lossless | latest | sampled, flow: credit | snapshot-delta, key?, maxHz?, ring{items, bytes}, permission}`.

Kit invariants are unit-tested:
- every endpoint is exactly one action;
- path parameters are input fields;
- GET requests carry only `kind:query` with flat inputs;
- there are no GET mutations;
- every mutating action has `audit: attempt+outcome`.

**ObjectKey.** Broker objects appear in paths as `ObjectKey = base64url(utf8(vhost) + 0x00 + utf8(name))`, built with helpers from the contracts. This avoids `%2F` and the `/` vhost being mangled by ingresses, proxies and the tunnel.

### 3.2 Resource map (`/api/v1`, abridged)

| Area | Endpoints |
| --- | --- |
| Meta | `meta`, `session` |
| Connections | `connections[/{cid}]`, `/{cid}/profile` (BrokerProfile + gates + allowedActions), `/{cid}/probe`, `/{cid}/login` |
| Explorer | `/{cid}/inventory/queries` (windowed), `/{cid}/search`, `/{cid}/queues/{qkey}`, `…/exchanges/{xkey}`, `…/bindings`, `…/consumers`, `…/client-connections`, `…/policies`, `…/users`, `…/feature-flags`, `…/definitions` |
| Two-phase | `POST actions/{actionId}/plans`, `GET plans/{id}`, `POST plans/{id}/approvals`, `POST plans/{id}/execute {consents, confirmation?, idempotencyKey}` |
| Jobs and receipts | `jobs`, `jobs/{id}/commands {pause, resume, cancel}`, `jobs/{id}/journal?cursor=`, `receipts/{id}` |
| Messages | `captures`, `captures/{id}/queries`, `blobs/{ref}?offset&length`, `templates` |
| Live operations | `taps`, `firehose/leases` |
| DLQ | `dlq`, `dlq/{qkey}/analyses`, `analyses/{id}/groups` |
| Streams | `streams/{skey}/reads`, `stream-reads/{rid}/pages` |
| Topology | `topology/{graph, subgraph}`, `routing/simulations`, `effective-config/{qkey}`, `topology/{exports, diffs}` |
| Ops | `ops/{cid}/emergency-revoke`, `ops/{cid}/freeze` |
| Metrics and lint | `metrics/queries`, `alerts/{rules, events, routes}`, `lint/{runs, findings}` |
| Workspace | `views`, `collections`, `layouts`, `settings`, `keybindings` |
| Platform | `plugins`, `semantics/matrix` |
| Team only | `audit/{events, exports, anchors}`, `team/{users, roles, role-bindings, approvals, catalog, tokens}` |
| Team ops | `/healthz`, `/readyz` |

A direct call to an action that needs a plan returns **428 `PLAN_REQUIRED`**, and the response's `Location` header points to the plan that was created automatically.

**Live topics:**

| QoS | Topics |
| --- | --- |
| snapshot-delta, latest | `explorer.window` |
| latest | `metrics.live`, `jobs.progress`, `tap.stats` |
| sampled | `tap.messages`, `stream.tail` |
| lossless | `connections.status`, `alerts.events`, `approvals.inbox`, `notifications`, `audit.tail` (team) |

### 3.3 One router behind three carriers

| Carrier | Mechanism | Principal binding |
| --- | --- | --- |
| HTTP/TCP (local, team) | Fastify `listen` | Bearer launch token (local) or `__Host-sid` cookie + `X-CSRF-Token` (team) |
| Pipe / UDS (CLI, MCP shim; all modes) | `http.createServer((q, s) => app.routing(q, s))` on a 0700 directory or user-only pipe; mutual HMAC auth on connect (§7.4) | Capability token proven by HMAC; scope `cli` or `mcp` |
| MessagePort (desktop) | `PortSessionServer`: `{t:'http.req', id, method, url, headers, body}` → `app.inject({…, payloadAsStream: size > 1 MiB})` → `http.res` / `http.chunk`; `http.abort` triggers an AbortSignal; `live` frames go to the hub | **Tunnel hygiene:** strip renderer-supplied `authorization`, `cookie`, `host` and `x-forwarded-*`; set `host: engine.internal` and `x-<product>-carrier: <per-boot 256-bit secret>`. The auth hook maps the carrier secret to `desktop-user`. **Every network listener rejects a request that carries the carrier header.** |

Large exports never cross the port. The engine writes them to a path chosen through `PlatformBridge.pickSaveTarget`, which returns an opaque file token. The renderer never sees paths.

### 3.4 DC-35 evaluation

|  | MessagePort tunnelling the REST router (**chosen**) | Loopback HTTP/WS | Separate RPC over the port |
| --- | --- | --- | --- |
| Network surface | None: no DNS rebinding, CSRF, WS hijack or port squatting | A listener reachable by any local process; needs a token plus Host, Origin and Sec-Fetch checks | None |
| Dispatch paths | One (inject runs hooks, validation, Problem mapping and the executor) | One | Two, with drift risk |
| UI code | HttpClient everywhere; only the `HttpBackend` and LiveChannel differ | Identical | A second client |
| Backpressure | None from the transport, so credits are mandatory (needed anyway) | `bufferedAmount` | Same as the port |
| Debuggability | Dev-only Transport Inspector panel | DevTools | Own panel |
| Cost | About 200 LOC in the UI backend and about 200 LOC in the port server | Token plumbing, firewall prompts | About 600 LOC plus drift |

**Decision.** Use MessagePort with the tunnel. `{provide: HttpBackend, useExisting: MessagePortHttpBackend}` is the same override `provideHttpClientTesting` uses, so interceptors and `httpResource` keep working. `inject` is documented as being "for testing", but `@fastify/aws-lambda` dispatches every event through it in production, and spike S-01 measures it. An engine-link Web Worker that owns the port is added **only if** S-01 shows that main-thread decode exceeds 4 ms per frame at 10 Hz. The loopback transport exists only in dev builds behind a compile-time `DEV_HTTP` flag, and `fuse-check` asserts it is absent from release builds.

### 3.5 Live protocol: one session per UI, identical on WebSocket and MessagePort

```
Client: hello{v:1, resume?} | sub{sid, topic, params, credit} | credit{sid, n} | unsub{sid} | ping
Server: welcome{session, limits} | subok{sid, qos} | data{sid, seq, items, dropped?, sampledEvery?}
        | snapshot{sid, seq, items} | delta{sid, seq, upserts, removes} | status{sid, state}
        | gap{sid, fromSeq, toSeq, reason} | end{sid, reason, problem?} | goaway{reason} | pong
```

- **Credits.** Every `data`, `snapshot` and `delta` frame consumes one credit. The UI grants credits after rendering, in rAF batches.
- **Outboxes.** Each subscription has an outbox bounded by items and bytes.
  - `lossless`: never dropped. On overflow the engine sends a `gap` followed by a snapshot resend.
  - `latest`: coalesced by key at `maxHz`.
  - `sampled`: every n-th item, with counters.
- **Session limits:** 64 subscriptions, 8 MiB total outbox, 1 MiB per frame.
- **Resume.** A session survives transport loss for 30 s. `hello{resume}` restores subscriptions: lossless topics continue from `seq`, others resend a snapshot.
- **Bodies.** Items carry previews of at most 16 KiB. Full bodies are fetched by `bodyRef` in 1 MiB chunks.
- **Tap backpressure chain:**
  1. The engine acks a tap delivery only after the item enters the capture ring.
  2. When the ring backs up, prefetch fills.
  3. The tap queue grows.
  4. `x-overflow=drop-head` drops copies in **our** exclusive queue.
  5. Production publishers are unaffected.
  Each stage reports `received`, `dropped` and `sampledEvery` into `tap.stats`.

### 3.6 Error model

Errors use RFC 9457 `application/problem+json`:

```
{type, title, status, code, detail?, correlationId, retryable, gate?, warnings?, missingPermission?,
 broker?{protocol, classId, code, text}, docs?}
```

| Code | Status |
| --- | --- |
| `VALIDATION_FAILED` | 400 |
| `UNAUTHENTICATED` | 401 |
| `FORBIDDEN_RBAC`, `FORBIDDEN_BROKER` | 403 |
| `NOT_FOUND` | 404 |
| `PLAN_STALE` | 409 |
| `CAPABILITY_MISSING` | 412 |
| `GATE_BLOCKED` | 422 |
| `PLAN_REQUIRED`, `CONSENT_REQUIRED`, `APPROVAL_REQUIRED` | 428 |
| `BUDGET_EXCEEDED`, `RATE_LIMITED` | 429 |
| `BROKER_ERROR`, `BROKER_RESOURCE_LOCKED`, `BROKER_PRECONDITION_FAILED` | 502 |
| `BROKER_UNREACHABLE`, `ENGINE_SHUTTING_DOWN`, `FROZEN` | 503 |
| `TOKEN_EXPIRED`, `TOKEN_TOO_LARGE`, `EGRESS_DENIED`, `TLS_UNTRUSTED`, `INTERNAL` | as appropriate |

Live `error` and `end` frames carry the same Problem.

### 3.7 Versioning and skew

**Independent version numbers**
- The REST API is `/api/v1` and changes additively. A breaking change needs `/api/v2`, and `oasdiff breaking` gates against the last release.
- The live protocol carries a version in `hello`/`welcome`.
- The plugin `apiVersion`: the engine supports N and N−1.
- The semantics data version, e.g. `sem-2026.10.1`, is stamped into receipts.
- The DB schema version and the config `schemaVersion`.

**Skew (gap fix)**

| Mode | Handling |
| --- | --- |
| Desktop | Always matched, because the UI is served from the same asar. |
| Local and team | The engine serves the current Angular build **plus the previous release's hashed chunks**: the image carries `dist/web/<version>/` for N and N−1. |
| Live session | `welcome` carries `engineVersion`. On a mismatch the UI shows a non-blocking "Reload to update" banner. |
| Lazy chunks | A global `ChunkLoadError` handler performs **one** controlled reload that preserves the route, and never loops. |
| Team rollouts | `goaway{reason:'version-mismatch'}` is sent only after the new pod is serving. |

### 3.8 Generation (no client codegen)

- **Spec generation.** `nx run contracts:api-docs` emits `openapi.v1.json` (OpenAPI 3.1) and `asyncapi.v1.json` (AsyncAPI 3.0) with `z.toJSONSchema`. Both files are committed.
- **CI gates.**
  - Regenerate and fail on any diff.
  - Run the `oasdiff` Go binary, pinned by digest, against the last release tag.
- **UI.** `ui-data` exposes these, all with types inferred from zod:
  - `EngineApi.call(action, input)`: URL building, with response `parse` in dev and test builds;
  - `engineResource(action, () => input)`: `httpResource` plus `parse`;
  - `EngineApi.plan/execute`;
  - `LiveClient.subscribe(topic, params)`.
- **Third parties** may generate their own clients from the published OpenAPI.

---

## 4. Engine framework

|  | NestJS 12.1.3 (+platform-fastify) | **Fastify 5.12.7 + in-house kit (chosen)** | Hono 4 / oRPC 1.15 |
| --- | --- | --- | --- |
| Maturity | 12.0 is 7 weeks old and ESM-only; nestjs-zod and @nx/nest do not support it | v5 is mature; `inject`, `routing`, pino and hooks are built in | Second ecosystem; oRPC v2 is in beta |
| Security pin | platform-fastify 12.1.3 hard-pins **vulnerable** fastify 5.12.5 | We control the fastify pin | — |
| One contract | Controllers repeat paths unless we write custom decorators | The route table *is* the action registry | oRPC is contract-first |
| Policy location | Guards duplicate the action layer that MCP, CLI and jobs need anyway (DC-42) | ActionExecutor only | Same |
| Build / cold start | Decorator metadata fights esbuild; cold start unmeasured | Single-file esbuild bundle, fast boot | Small |
| Agent risk | Agents reach for class-validator, Passport and @ApiProperty | Small surface; generators teach the conventions | — |

**Decision.** Fastify only.
- The **kit is capped at about 800 LOC** by ADR: registry router, Problem mapping, auth hooks, Host/Origin/Sec-Fetch checks, the inject tunnel, and spec emitters. Anything larger needs a new ADR.
- DI is a **typed composition root**: plain factory functions with no container.
- Module encapsulation, which Nest would have given, comes from Nx tags and ts-morph tests instead.
- **DC-49 deviation (ADR-004).** DC-49's "add no direct fastify version other than 5.12.5" exists to match Nest's exact pin. With no Nest, the engine pins `fastify` 5.12.7, because 5.12.5 is affected by GHSA-389g-gv7q-r4x8. DC-49's other clauses still apply in full: TS 6.0.3, bans on TS 7 and `@types/amqplib`, exact pins for amqplib 2.2.0 and rhea 3.0.5, and no @nx/nest. The NestJS and Orval clauses no longer apply.
- `ws` 8.22.0 is used with `noServer` on `upgrade`; the auth, Origin and ticket checks run before the handshake completes. `@fastify/static` 10.1.6 serves the UI with a per-response CSP nonce.

**How an agent adds an endpoint**

```
pnpm nx g @app/generators:action queues.purge --module=svc-admin --kind=command \
  --http="POST /connections/{cid}/queues/{qkey}/purge" --permission=messages.purge \
  --risk=critical --planning=required --mcp=mutating --cli="queues purge"
```

The generator creates:
1. the contract file, added to the registry index;
2. `implementAction` with `plan`/`revalidate`/`execute` stubs that throw `NotImplemented`;
3. the module registration;
4. a unit spec with testkit fakes, including plan purity, deny-by-default, audit attempt and outcome, and the receipt;
5. an HTTP spec through `createTestEngine().inject`;
6. a UI command stub.

**Verification:** `pnpm nx affected -t lint typecheck test` plus `pnpm nx run contracts:api-docs-check`.

**Sibling generators:** `topic`, `job`, `service-module`, `adapter`, `ui-feature`, `lint-rule`, `decoder`, `semantics-cell`, `migration`, `conformance-cell`.

---

## 5. Message-safety layer

### 5.1 One action pipeline (DC-40/42); every step fails closed

1. **Resolve the definition.** An unknown action is denied.
2. **Validate** the input with zod.
3. **Authenticate.** Build a `Principal` with `kind`, `surface` (ui, cli, mcp, job, system), `unattended` (true for MCP, jobs and automations) and `onBehalfOf`.
4. **Load the BrokerProfile and era,** including its verification state (§5.2).
5. **Check capability gates**, each with a "why disabled" reason and source (412).
6. **Authorise.** `Authorizer` = tool RBAC (deny by default) ∩ broker permission hints. Desktop is single-user, so this step always allows there.
7. **Apply the guardrail policy:**
   - environment class, where an **unset environment class means prod**;
   - maintenance freeze;
   - quotas and token buckets;
   - unattended and AI restrictions;
   - an unverified-version penalty;
   - the result fixes `planning` and `approvalsRequired`.
8. **Plan.** `plan()` makes reads only, which tests enforce. The persisted Plan is bound to principal, `inputHash` and BrokerProfile `fingerprint`, and carries gates, W-* warnings, consents, the typed phrase, the approvals block and a preview.
   - TTL is **5 min** interactive and **24 h** while awaiting approval.
   - Payload fields are encrypted (§6.4).
9. **Execute.** Checks, in order:
   - same principal, or an approved delegate;
   - not expired;
   - **idempotency key required** and unused;
   - consents ⊇ required;
   - the typed phrase matches, checked engine-side;
   - approvals come from **different** principals;
   - **TOCTOU** `revalidate()` re-runs the cheap preflight. Drift in queue type, L, consumers, era or fingerprint returns 409 `PLAN_STALE`.
10. **Audit attempt** row. If the write fails, the action is denied.
11. **Run** `execute` with an AbortSignal, deadline, role-typed leases and budgets.
12. **Finish:** produce a receipt, write the audit `outcome` row (hash-chained), emit events, then purge plan payloads, keeping only digests.

The UI, CLI, MCP and jobs all use this path. MCP can only create plans for mutating actions (§5.12). **Peeks count as mutations.**

### 5.2 Semantics registry (DC-01/02/47/60)

**Data files.** `libs/shared/semantics/src/data/*.data.ts` holds typed constants, validated with zod at build time:
- `settle-matrix` (b.2), keyed by era × queue type × protocol × action × limit state × delayed-retry;
- `counters` (b.1), `dlx-carryover` (b.4), `delayed-retry` (b.5);
- `hazards` (known-bug table with semver ranges), `capabilities` (DC-32 predicates);
- `warnings` (W-* with severity and a versioned text key);
- `peek-caps`, `tap-rules`, `provider-presets`, `effective-config` (k.3), `framework-registry` (l).

**What each cell carries:**
- `citations[]`;
- `conformance[]`, as CT ids;
- `status`: `code-derived`, `lab-verified` or `lab-contradicted`;
- `evidence[]`: paths to lab evidence artefacts.

**Fail-closed lookup.** A missing cell throws `SemanticsGapError`. The planner then applies conservative 4.0–4.2 rules (every return counts), and requires extra consent. For AI or unattended principals the plan is rejected.

**`resolveEra`** returns `{era, reasons[], conservative}`:
- any node below 4.0 → 3.13;
- any node below 4.3, or `rabbitmq_4.3.0` not enabled, or any QQ member reporting Machine Version below 8, or an unknown or commercial build → 4.0–4.2;
- all nodes at 4.4 or later → 4.4;
- otherwise → 4.3.
An opt-in canary QQ test (get + nack twice) runs only on team servers, and only with admin consent.

**Verification state (gap fix).** `profile.verification` is one of:
- `verified`: the exact broker version has a green conformance run;
- `unverified-patch`: newer patch, same minor, e.g. 4.3.7;
- `unverified-minor`: e.g. 4.4 alpha;
- `unknown-build`.

Anything other than `verified` triggers:
- an amber banner;
- receipt `confidence: 'unverified-version'`;
- caps capped at the conservative row's defaults;
- an extra consent on every message-touching action;
- **MCP mutating tools forced off**.

Registry updates ship **only** as product patch releases (signed artefacts), never fetched remotely (DC-59).

**Breaking the registry ↔ test circle (gap fix)**
- **Evidence recorded outside the registry.** `testing/lab-evidence/<broker-version>/<CT-id>.json` holds raw before/after traces: `x-delivery-count`, `x-acquired-count`, `redelivered`, queue position, survival, broker version and image digest. They are recorded by `conformance:record`, a separate job that does not read the registry.
- **Two-way assertions.** Conformance tests assert that **(a)** the live run matches the recorded evidence, and **(b)** the registry cell matches the evidence. An agent cannot turn CI green by editing a cell, because the evidence would then disagree. Re-recording evidence needs the `lab-evidence` CODEOWNERS label and a human.
- **Status changes** require an evidence artefact in the same PR plus CODEOWNERS approval (`tools/semantics-evidence` check).
- **Mutation testing of the suite** (nightly; Stryker plus targeted mutants). Each of these mutants must make at least one test fail:
  - swap `nack` for `reject`;
  - drop the qos barrier;
  - close before the barrier;
  - change `>` to `>=` in `isDoomed`;
  - skip the DLX-source check;
  - `ack` without a proof;
  - raise AMQP 1.0 credit above 1.
- **Release gate.** No Tier-1 support claim, and no "lab-verified" badge, without a green run covering every cell.

### 5.3 Connection roles and role-typed leases (DC-11/12, refined)

| Role | Purpose | Lease exposes | Rules |
| --- | --- | --- | --- |
| `control` | Metadata, admin and AMQP management calls | HTTP pool; AMQP management channel | Never holds messages |
| `peek` | Peek jobs | `get`, `nackRequeue`, `qosBarrier`, `ackWithProof` (rescue only) | One in-flight job per connection; **never publishes**; heartbeat 30 s; fresh channel per job; throwaway channels for passive declares |
| `source` | Replay and move consumers (DLQ) | `consume(prefetch)`, `ackWithProof`, `nackRequeue(SafeReturnProof)` | Isolated, so a tap or stream error cannot return held DLQ deliveries through DOWN; one job per connection |
| `publish` | Rescue copies, replay, publish, park | Confirm channels only | Confirms + `mandatory`; blocked/unblocked surfaced; never consumes |
| `observe` | Taps and stream readers | `declareTapQueue`, `bindQueue`, `consume`, `ackTap`, AMQP 1.0 stream receivers | Own exclusive queues only |

- **Budgets** come from `BrokerProfile.limits` and provider presets: `connection_max`, `channel_max`, and `consumers_per_channel` (10 on Amazon MQ 4.x). Use one consumer per channel. When a budget is exhausted, work is queued, or the call returns 429 with an ETA.
- **Team mode:** pools are keyed by `(user, broker, vhost, protocol, role)`, with fair queueing.
- **`connection_name`:** `<product>/<mode>/<role>/<user-or-session>`.

### 5.4 Peek planner (pure; DC-03..16)

**Preflight** runs over HTTP only and touches no messages. It reads:
- `GET /api/queues/{v}/{q}`: type, exclusive owner, `auto_delete`, the **`delivery_limit` stat**, `delayed_retry`, `messages_delayed`, SAC and consumer details, leader, members, online;
- effective-config resolution of arguments, policies and operator policies;
- DLX topology from the routing simulator: every DLX source and its L;
- length limits and overflow, TTL, the consumer timeout, alarms, and average size;
- the **rescue preflight** (§5.5).

| Queue / era | Method | Settle | Caps (default / max) | Gates |
| --- | --- | --- | --- | --- |
| CQ, all eras | sequential 0-9-1 `basic.get` | one `nack(lastUnackedTag, multiple, requeue)`, then `basic.qos` barrier, then lazy close | 20 / 500, 16 MiB | exclusive → refuse; CQ-SAC → W-SAC-CQ; drop-head ≥90 % → W-DROPHEAD; TTL; auto-delete → get only |
| QQ 3.13 | get | nack (counts as DC+1) | 20 / 50 | always confirm W-313; W-TAIL if unlimited; `x-delivery-limit=-1` → refuse (DC-16) |
| QQ 4.0–4.2 | get over 0-9-1 | nack (counts as AC+1) | 20 / 50 (admin 200) | **W-BUDGET consent every time**, showing L and attempts used; no auto-refresh; W-TAIL if L=−1 |
| QQ 4.3+ | get. SAC queues: consumer only when none is active, with `x-consumer-timeout` = abort budget. Opt-in AMQP 1.0 path: **credit 1 + drain per step**. | nack / released only | 20 / 500, 16 MiB | **W-OVERLIMIT blocks** when a finite L is not above every DLX source's L+1 (one-click `delivery-limit -1` policy fix, plus a lint rule); W-DELAY (DC-14) |
| Stream | Stream browser (§5.7); **never get** | credit only | count / bytes / time | info only |
| HTTP fallback | `/get` with `ack_requeue_true` (+`"requeue":true` on LavinMQ), count ≤ 50, truncate; client timeout above server work | server-side | 20 / 50 | Not offered when over-limit messages are possible (DC-10/55) |

- **Hold budget:**
  - `hardAbort = min(30 s, TTL/4, QQ consumer-timeout/4 on 4.3+, channel-timeout − 90 s on ≤4.2)`;
  - `target = min(5 s, hardAbort)`;
  - `count ≤ min(cap, ⌊target / measuredRtt⌋)`.
- **Gets are sequential on one channel.** Parallel channels would scramble QQ HEAD return order and widen exposure.
- **Disposition is mandatory** for any QQ with a finite or unknown L (DC-09). It is chosen at plan time:
  - `quarantine`: confirm-copy to `<product>.quarantine`, then ack with proof;
  - `raise-limit`: admin only; write a policy, wait until the `delivery_limit` stat shows the new value, then nack. Must be finite on 4.0–4.2. Impossible when an argument or operator policy caps the limit;
  - `let-broker-handle`: a human, interactive run with typed consent only.
- **AI or unattended plans with no safe disposition are rejected at plan time.**
- **Doomed when:**
  - 4.3+: `DC > L`;
  - 4.0–4.2: `x-delivery-count (= AC) ≥ L`;
  - 3.13 with a limit: `DC ≥ L`.
- **Acquisition always stops at the first doomed message.**

**Corrected acceptance example (replaces simplicity-first's M2 example)**
- *Given* a 4.2.9 QQ with L=20 and a message at AC=19, *when* it is peeked, *then*:
  - it is returned (not doomed, because 19 < 20);
  - the receipt shows `deltaAC=+1`;
  - the message stays at the HEAD with AC=20.
- *When* it is peeked again, *then*:
  - the guard sees `x-delivery-count=20 ≥ L` and stops;
  - the chosen disposition is applied, e.g. quarantined with a confirm then acked;
  - the receipt says `stoppedBy:'guard'`.
- Conformance cells: CF-QQ-42-GUARD-01 and CF-QQ-42-GUARD-02.

### 5.5 Peek executor: state machine, rescue preflight, failure paths

**States:**

```
idle → preflighted → acquiring ⇄ guarding → (rescuing | raising) → returning(nack + barrier)
     → settled
any state → watchdog/abort → returning
error → incident
```

**Write-ahead.** A `hold_journal(state='acquiring')` row is committed before the first `get`. Each acquired delivery's tag is recorded in memory. `lastUnackedTag` is tracked **excluding tags already acked by rescue**, so `nack(multiple)` never hits 406 unknown-tag.

**Rescue preflight (gap fix).** Performed before acquisition, when the disposition is `quarantine`:
1. Simulate user and operator policy matches for the quarantine name. Amazon MQ's `.*` default policies set `max-length` with `reject-publish`, so the arguments set `x-overflow` explicitly.
2. Declare `<product>.quarantine` explicitly: `durable`, `x-queue-type=classic`, `x-overflow=drop-head`… — **not** drop-head. It uses `reject-publish-dlx: false`, i.e. no overflow argument, and no max-length.
   - If the classic type is disabled (possible from 4.2), fall back to a QQ with `x-delivery-limit=-1` on 4.0+. On 3.13 the QQ fallback is refused, because −1 means drop.
   - Declaration happens once per vhost and is reused. If the queue cannot be created, the disposition is unavailable.
3. Check configure/write permission against the user's regex.
4. Check alarms (`/api/health/checks/alarms`).
5. Open and **pre-arm** the `publish` connection and a confirm channel. If the connection is `blocked`, the peek does not start.

**Execution loop** (sequential; stops on count, bytes, target, empty queue, abort or watchdog):
1. `d = get(q)`.
2. `copy(d)`: write it to the capture store.
3. `guard(d)`:
   - not doomed → continue;
   - doomed → stop acquiring and apply the disposition:
     - **quarantine:** `publish(copy, mandatory)` and wait for the confirm, which must arrive within `min(2 s, remaining hold)`, then `ackWithProof(d, ConfirmedCopyProof)`;
     - **raise-limit:** policy write, then poll the stat (≤ the hold budget).
4. `finally`: `nack(lastUnackedTag, multiple, requeue)`, then the `qosBarrier`, then mark the journal `settled`, then lazy-close the channel (later, or on lease release).

**Failure paths.** Each one has a conformance and fault-injection cell (`CF-EXEC-*`).

| Failure | Handling |
| --- | --- |
| Quarantine confirm nacked, returned, blocked or timed out | Retry once on a fresh confirm channel within the budget. If it still fails, the doomed delivery cannot be saved. It is returned with the others, so the broker DLXes or drops it per the cell. The receipt records `rescue-failed` with the predicted outcome, a high-severity audit row is written, and an alert fires. Because of this residual risk, AI or unattended plans require that the rescue preflight passed in the last 60 s; a human-run plan states the risk in the consent text. |
| 406 unknown delivery tag | Prevented by `lastUnackedTag` tracking. If it still occurs, the channel is dead. The receipt says `channel-down` with close-while-holding effects (W-CRASH semantics), plus an incident. |
| 405 RESOURCE_LOCKED (SAC or exclusive) | Prevented by preflight. On a race, the same incident path applies, and the throwaway channel is isolated from other holds. |
| 403 on passive declare | Passive declares run only on throwaway channels, never on the holding channel. |
| 404: queue deleted mid-peek | Holds are lost by definition. The receipt says `queue-deleted`. |
| Watchdog fires during the rescue publish | Abort the publish wait, nack all unacked tags (including the doomed one), barrier. The receipt says `rescue-aborted`. |
| Connection blocked mid-hold | Publish fails fast: blocked means no rescue. Return the messages, and record it in the receipt. |

The executor is covered by **model-based tests** (fast-check command sequences over a fake broker that tracks AC/DC) and by fault-injection cells on real brokers.

### 5.6 Counter trust (gap fix)

QQs stamp `x-delivery-count` only on messages returned at least once, so a header copied by a client survives into the queue. On 4.3, a DC carried over through dead-lettering also arrives with `redelivered=false`.

| Observation | Treatment |
| --- | --- |
| `redelivered=true` | Counter **verified** (broker-stamped) |
| `redelivered=false`, counter present, and the queue is a 4.3 DLX target whose sources have finite L (routing simulator) | Treated as **carried-over and real**: doomed when `DC > L`. Marked `counterSource:'dlx-carryover'`. |
| `redelivered=false`, counter present, and no DLX source can feed this queue | Counter **unverified**: likely copied by a client, and the broker's internal DC is 0. Not doomed, and the message is returned normally. The receipt and UI badge say "counter unverified (copied header?)". |
| Any rescue of a message whose counter is unverified or `redelivered=false` | Requires explicit per-message human confirmation. For AI or unattended runs: stop and return. |

Lab cells: `CF-43-QQ-COPIED-HEADER-01` (a client-published `x-delivery-count: 99` is returned and survives) and `CF-43-QQ-DLX-CARRY-01`.

### 5.7 Taps, firehose and stream browsing (DC-17..20, 22..26)

**TapPlanner** (pure; literal-typed spec)
- **Queue spec:** `TapQueueSpec{name: <product>.tap.<ulid>, exclusive: true, autoDelete: true, durable: false, args: {x-queue-type: 'classic', x-max-length: 10000, x-overflow: 'drop-head', x-message-ttl: 60000, x-expires}, x-<product>-session}`.
- **Bindings** are copied **with their arguments**.
- **Checks before declaring:**
  - policy-match simulation for the tap name, warning on reject-publish, a DLX policy or max-length;
  - alarms;
  - classic queue type enabled (4.2+);
  - the name fits the user's configure regex and never starts with `amq.`.
- **Refusals:** `x-consistent-hash`, `x-modulus-hash`, `x-random`, `x-local-random` and unknown types, unless the user accepts diversion. E2E taps on CHX below 4.3.6 are never allowed.
- **Badges:** default-exchange blind spot; AE / mandatory / unroutable-metric masking (routing simulator); "partial, node-local" behind a load balancer.

**TapSession**
- prefetch about 1000 (`global=false`), with batched acks after ring insert;
- binding re-sync every 30 s, or from the event exchange;
- saturation detection;
- lease of 10 min, renewed by UI heartbeats;
- an orphan sweep at start and every 10 min, which deletes **only objects carrying our session argument**.

**Khepri churn budget (gap fix).** On 4.3 every declare and delete is a Khepri metadata write.
- A tap **reuses its queue** when bindings change, rebinding instead of re-declaring.
- Quarantine and parked queues are durable, created once per vhost, and reused.
- Replay staging queues are reused per job.
- Per broker, a declare/delete token bucket allows 1/s with a burst of 5.
- The team server enforces a churn budget per broker (default 120 declares per hour) and per user (3 concurrent taps, 50 global).
- Exhausted budgets return 429 `BUDGET_EXCEEDED`. Lint warns about other clients' churn.

**Firehose** (admin only, per node, DC-20)
- **Durable lease rows are written before enabling.** The default lease is 10 min, the maximum 60 min.
- Enabled through `PUT /api/traces/node/{node}/{vhost}/{name}` when `rabbitmq_tracing` is present. Otherwise the tool generates `rabbitmqctl trace_on -n` runbooks.
- **Never** set through vhost PUT.
- State is re-verified per node after uptime resets.
- Captures are labelled "partial" behind a load balancer.
- Leases are reconciled at start.

**Stream browser**, in this order:
1. our AMQP 1.0 adapter on 4.0+: described filters, ulong offsets, ms timestamps, properties filters on 4.1+, SQL filters on 4.2+, **applied-filter echo, failing closed**;
2. 0-9-1 `x-stream-offset` (prefetch > 0, manual ack). This is also the path on 3.13;
3. the stream protocol, only if every advertised host:port is reachable.

Readers are always anonymous. Header-loss disclosure is shown (DC-26). On "no running replica on the local node", the browser lists the replica nodes. It is hidden on Amazon MQ.

### 5.8 DLQ centre and replay (DC-27..29, 53, 54)

**Reading.** DLQ reads use the peek planner, so W-OVERLIMIT and W-BUDGET apply. Decoders, fingerprint groups and delay-infrastructure recognition follow. Queues managed by other tools (ServiceControl, Wolverine, the Topology Operator, provider-owned queues, NServiceBus `nsb.{q}.delivery-limit`) are **read-only by default**. Deep analysis can use an explicit, consent-gated "archive to stream" job, which confirm-copies messages, then acks.

**ReplayPlanner** (pure)
- **Destination** is resolved queue-first:
  1. framework field;
  2. newest `rejected`/`delivery_limit` x-death entry, skipping delay infrastructure;
  3. naming convention;
  4. `x-original-*`, which needs a **fan-out confirmation**;
  5. user mapping.
  Never route by `x-first-death-queue` alone.
- **Header handling:**
  - strip `x-death*`, `x-first/last-death-*`, `x-delivery-count`, `x-acquired-count`, an elapsed `expiration`, and a mismatched `user_id`;
  - keep logical IDs; edits get a new ID plus an `EditOf` link;
  - stamp `x-<product>-replay-{id, seq, count, from, at, by}`.
- **Pacing:** token bucket, canary of 1–5 messages, then an observation window.
- **Source gating (gap fix).** When the source is a finite-L QQ:
  - on 4.3, run the W-OVERLIMIT DLX-source check;
  - on 4.0–4.2, require W-BUDGET consent.
  - If messages may already be over the limit, replay is **refused**, with a one-click fix to set `delivery-limit -1` on the DLQ and wait for the stat.

**ReplayJob** (durable)
1. Lease a **`source`** connection.
   - Prefetch is **1** for finite-L QQ sources and ≤ 32 otherwise.
   - A `SafeReturnProof` is issued only for CQ sources and unlimited-QQ sources. Without it, `nackRequeue` cannot be expressed.
2. For each delivery:
   1. journal `consumed(occurrenceKey)`;
   2. publish via the default exchange with `mandatory`, on a `publish` confirm channel;
   3. confirmed → `ackWithProof` → journal `acked`;
   4. nack, return or timeout → **park**: confirm-copy to `<product>.parked` with the reason headers, then `ackWithProof` → journal `parked`. If parking also fails: on safe-return sources, `nackRequeue`; on finite-L QQ sources, **hold, retry once, then stop the job** with the delivery still held under the source watchdog (≤30 s). The final fallback is a human-visible incident; it is never a silent nack.
3. Auto-pause when replayed IDs reappear in the DLQ, or on `max_message_size`, reject-publish nacks or blocked connections.
4. **Cancel, drain, suspend:**
   - stop consuming;
   - wait ≤300 ms for confirms;
   - ack the confirmed sources;
   - **park the unprocessed ones by confirm** (finite-L QQ), or nack + barrier (safe-return sources);
   - journal the rest as `uncertain-duplicate`.
   It **never blindly nack-flushes a finite-L QQ source** (DC-04 rule as amended).
5. Filtered or grouped replays first stage through a reused, tool-owned classic queue or stream. The job never scan-nacks.

**Resume identity: at-least-once (gap fix)**
- CQ and QQ deliveries have no stable broker ID.
- The occurrence key is `logicalId` when a framework provides one; otherwise `fingerprint = sha256(body ‖ canonical headers minus broker-managed ones)` plus an **occurrence ordinal**. Journal counts are a **multiset** per key.
- On resume, a redelivered source message whose key's `acked` count is below its `published` count is **acked without republishing only if** the journal holds a confirmed publish **and** the copies carry the same `x-<product>-replay-id`. Otherwise it is **republished**: when in doubt, republish.
- Duplicates are marked `uncertain-duplicate` in the journal and the receipt. Downstream dedupe can use the stamped `replay-id`/`seq` and the logical IDs.

**Undo.** An honest re-park of the journaled, encrypted copies.

**Shovel moves** are gated, blocked on 4.3.0–4.3.6, and deprioritised (DC-29).

### 5.9 Guardrails and blast-radius controls

| Env class (unset = prod) | Reads / peeks | Writes | Bulk / destructive | AI (MCP) |
| --- | --- | --- | --- | --- |
| prod | Peek plans need consent; prod chrome; captures volatile; FTS indexes metadata only | Locked until **armed** (15 min, audited) | Typed confirm. Team: four-eyes approval for purge, budget peeks, firehose, bulk replay above N | Read tools only; mutations off |
| staging | Like dev, plus a banner | Confirm on high risk | Typed confirm | Mutations off by default |
| dev / test / local | Consents only for hazards | Allowed | Confirm on critical | Admin may enable |

**Emergency revoke** (`ops.emergency-revoke`, per broker, gap fix):
- stop every tap;
- switch firehose off on every node;
- flush every in-flight peek (nack + barrier);
- pause every replay or move (park and drain);
- across all users, in one audited action.
- Admin only. Team mode allows a single approver ("break-glass", not four-eyes).

**Maintenance freeze** (per broker):
- forces read-only mode;
- pauses pollers and Prometheus scrapes, or slows them to one per minute;
- blocks plans with `FROZEN`;
- banners in every session.

Both are exposed in the UI, CLI and MCP (read-only status only) and are drilled in E2E.

### 5.10 Receipts (DC-15)

Every message-touching or destructive execution produces a receipt containing:
- `{actionId, planId, era, method, semanticsVersion, verification, holdMs, returnPath}`;
- `perMessage[{position, settle, cellId, deltaAC, deltaDC, newPosition, counterSource, outcome}]`;
- `anomalies[]`, `warnings[]`;
- `confidence: code-derived | lab-verified | unverified-version`.

Receipts are stored, linked from the audit log, returned to MCP, and shown in a "What happened" drawer. The honest UI copy is "side-effect-aware peek — messages stay in the queue".

### 5.11 Node agent

A zero-side-effect QQ peek via `rabbitmq-queues peek` is **deferred**. It would be an optional sidecar inside the broker's trust boundary, using mTLS, and it never exports the Erlang cookie.

### 5.12 MCP (DC-42)

- **Server.** An in-house, tools-only JSON-RPC subset: `initialize`, `tools/list`, `tools/call`, `ping`. Tools are generated from actions with `mcp.expose`.
- **Conformance.** Tested against `@modelcontextprotocol/sdk` 1.32.1, which is used **only as a test client**.
- **Transports:**
  - desktop and local: a `<product> mcp` stdio shim over the pipe, with a read-only capability token by default;
  - team: `/mcp` as its own OAuth resource (RFC 9728 metadata, RFC 8707 audience), with **no token passthrough**.
- **Rules:**
  - connections are referenced only by opaque IDs that a human created;
  - peeks count as mutations;
  - mutating tools are off by default and **plan-only**, executed after a human approves in the **approvals inbox**, which also exists on desktop;
  - payloads are quoted, capped at 16 KiB, stripped of control characters and masked;
  - receipts are returned.

---

## 6. Data model and persistence

### 6.1 Stack

| Mode | Storage |
| --- | --- |
| Desktop and local | Kysely 0.29.6 over an in-repo `node:sqlite` dialect: about 40 LOC, `Database ?? DatabaseSync` detection, `readBigInts`, WAL, `busy_timeout=5000`, FTS5. better-sqlite3 13.0.3 is the fallback behind the same interface. Files: `data.db`, plus `capture.db` + `blobs/`. |
| Team | pg 8.23.1 (Postgres 16+; CI runs 16 and 18), tsvector GIN indexes, monthly partitions for audit and journals |

Migrations are **one set** written with dialect helpers (`t.id()`, `t.json()` stored as TEXT, `t.epochMs()`, `t.bytes()`) and applied on both dialects in CI, from empty and from every released schema.
- **Desktop:** online backup (`VACUUM INTO`) before migrating; **a newer schema is refused**.
- **Team:** migrations run as a **Helm pre-install/pre-upgrade hook Job using the DDL role**. The app role is DML only; `audit_events` grants INSERT and SELECT only, and triggers reject UPDATE and DELETE.

### 6.2 Entities

| Area | Tables |
| --- | --- |
| Connections | `connection_profiles` (alias id, env class, colour, endpoints, dial route, TLS, HTTP/AMQP credential refs, issuer pin, managed flags, team owner/visibility); `credentials` (ciphertext, dekId, aad); `broker_profiles` (json, fingerprint, verification, probedAt) |
| Workspace | `views`, `collections`, `templates` (body ref), `layouts`, `settings`, `keybindings` |
| Captures | `captures` (kind, target, persist: volatile/saved, dekId); `captured_messages` (props, typed headers, masked text, size, hash, decoded summary, counters, `body_inline ≤64 KiB` or `blob_ref`); `captured_fts` / tsvector; `blobs` (sha256 content-addressed, encrypted, refcount) |
| Safety | `plans` (bound fields, **encrypted payload**, ttl, state); `approvals`; `hold_journal`; `receipts`; `replay_journal` (jobId, occurrenceKey, ordinal, state, publishSeq, encrypted copy ref) |
| Jobs | `jobs` (type, version, state incl. `awaiting-credentials` and `paused-interrupted`, principal, planHash, idempotencyKey, concurrencyKey, checkpoint, lease_owner, lease_until, attempts); `job_events` |
| Audit | `audit_events` (seq, ts, actor snapshot, surface, onBehalfOf, action, target, env, phase, result, planHash, approvalId, receiptId, masked detail, prev_hash, hash); `audit_anchors` (seq, head hash, exported_to, at) |
| Leases | `leases` (tap, firehose, emergency) |
| Metrics | `metric_series`, `metric_points` (raw), `metric_rollups` (5 m / 1 h: min, max, avg, last, count); `alert_rules`, `alert_state`, `alert_events`, `notification_routes` |
| Team | `users`, `groups`, `roles`, `role_bindings`, `sessions`, `api_tokens` (hashed), `capability_tokens` (hashed), `delegated_tokens` (envelope-encrypted refresh tokens), `mcp_clients`, `quotas` |
| Platform | `plugins` (id, version, sha256, tier, approvedBy); `data_keys` (wrapped DEKs) |

### 6.3 Retention defaults

| Data | Desktop / local | Team |
| --- | --- | --- |
| Captures | Volatile (memory rings); saved ones 7 days or 1 GiB | 24 h per user, quota |
| Plans | 5 min / 24 h; **payload purged at expiry or execution**, digest kept | Same |
| Receipts, jobs, journals | 90 days | 90 days (partition drop) |
| Audit | 90 days (local activity) | 400 days default; partitions dropped with chain anchors kept |
| Metrics | Raw 48 h; 5 m for 30 d; 1 h for 400 d | Same, with cardinality caps |

### 6.4 Encryption at rest

AES-256-GCM is applied at field level under a DEK, with **AAD = table:column:rowId**. It covers:
- secrets;
- saved capture bodies and blobs;
- **plan payloads** (publish bodies, edited replay payloads);
- **replay and undo journal copies**;
- template bodies;
- delegated refresh tokens.

**Approvals.** Approvers see masked previews plus body hashes. Unmasking requires `messages.unmask` and is audited.

**DEK wrapping:**
- desktop: safeStorage async in main;
- local: `@napi-rs/keyring` 2.1.1 (Secret Service forced on Linux), or a passphrase (scrypt N=2^17; argon2id if `crypto.argon2` works under BoringSSL, spike S-07);
- container: a KEK file secret;
- team: Vault Transit, OpenBao Transit, KMS, or a file KEK.

There is no SQLCipher, so OS disk encryption is documented as the whole-file layer. FTS stores masked text, and in prod, metadata only.

### 6.5 Backup, restore and key custody (gap fix)

**Desktop and local**
- "Export backup" produces `VACUUM INTO` plus blobs, encrypted with the wrapped DEK.
- A restore wizard verifies the audit chain.

**Team**
- **Postgres PITR** is the operator's responsibility; docs cover CloudNativePG and managed databases.
- **Restore drill CI job** (nightly): restore a dump, run migrations, `audit verify`, and compare the anchors.

**Key custody**
- KEK escrow runbook (Shamir split recommended for the file KEK).
- `<product> rewrap` for rotation, which re-wraps DEKs without re-encrypting the rows.
- Annual rotation by default.
- A lost KEK means lost secrets; the docs state this loudly.

**Audit anchors**
- Every N events (default 1,000) or hourly, the chain head `(seq, hash)` is exported to a target outside the database: SIEM webhook, S3 Object Lock / WORM bucket, or a signed file on a separate volume.
- `audit verify` checks the chain against the anchors. Retention deletes keep the anchors, so verification restarts from an anchor.
- A schema owner cannot rewrite history without the mismatch showing at the next anchor check.

---

## 7. Security model per mode

### 7.1 Desktop

**UI ↔ engine**
- The renderer holds a single port and nothing else. There is no TCP listener (DC-35).

**Fuses (DC-46)**
- Off: RunAsNode, NodeOptions, NodeCliInspect, GrantFileProtocolExtraPrivileges.
- On: EmbeddedAsarIntegrityValidation, OnlyLoadAppFromAsar, CookieEncryption.
- A separate **test-fused** build (inspect and RunAsNode on) is never published. `fuse-check` reads the fuses of every release artefact.

**Renderer**
- Isolation: `sandbox`, `contextIsolation`, `nodeIntegration:false`, `webviewTag:false`.
- Handlers: a permission handler that denies everything; `will-navigate` prevented; `setWindowOpenHandler` denies.
- Devtools are off in release builds.
- `shell.openExternal` accepts https only, from an allow-list (docs, pinned IdP endpoints), and **asks the user to confirm**.
- Every IPC `senderFrame` is validated.

**CSP**

```
default-src 'none'; script-src 'self'; style-src 'self' 'nonce-N'; img-src 'self' data: blob:;
font-src 'self'; worker-src 'self' blob:; connect-src 'self'; frame-src 'none'; object-src 'none';
base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'
```

Trusted Types are enforced if spike S-04 passes with Monaco, ELK and AG Grid; otherwise report-only, with the policy-name allow-list. `innerHTML` is banned by lint.

**OAuth (DC-39)**
- System browser only, PKCE S256.
- Redirect to `http://127.0.0.1:0/cb`: single use, 5-minute TTL, state and nonce checked.
- Fixed-port or device-code fallback for Okta and Auth0.
- The issuer is shown to the user, pinned and allow-listed.

**macOS:** `NSLocalNetworkUsageDescription`, with guidance shown when access is denied.

### 7.2 Local web (DC-36) and container mode

- Binds 127.0.0.1 (or uses container mode, §1.2).
- **Token handling.** A 256-bit fragment token moves to `sessionStorage` and the URL is cleaned. It is the engine token, not a broker credential, and is sent as Bearer.
- **Request checks:**
  - exact Host allow-list, Origin check and `Sec-Fetch-Site: same-origin`;
  - JSON-only bodies, except token-guarded upload routes;
  - no CORS headers ever;
  - no GET mutations.
- **WebSocket.** `POST /api/v1/live/tickets` returns a single-use ticket, valid 30 s and bound to the principal, carried in `Sec-WebSocket-Protocol: app.v1, app.ticket.<t>`. Host and Origin are checked on upgrade.

### 7.3 Team server

**Login and sessions**
- **OIDC BFF.** openid-client 6.8.8, confidential client, authorization code + PKCE.
- **Session cookie.** `__Host-sid` (HttpOnly, Secure, SameSite=Lax), idle timeout 30 min, absolute 12 h, rotated on login.
- **CSRF.** An Origin check plus a required `X-CSRF-Token` on unsafe methods.
- **Tokens.** PATs are hashed, scoped and expiring. The CLI uses device code. Break-glass admin is off by default.

**RBAC (DC-40)**
- Deny by default, evaluated by a pure `PolicyEngine` with table-driven tests.
- **Permission catalogue:**
  - Read: `connection.view`, `broker.read`.
  - Messages: `messages.peek`, `messages.peek.budgeted`, `messages.browse-stream`, `messages.consume`, `messages.read-body`, `messages.unmask`, `messages.publish`, `messages.replay`, `messages.replay.bulk`, `messages.purge`, `messages.export`.
  - Capture: `tap.start`, `firehose.control`.
  - Administration: `topology.admin`, `policy.admin`, `user.admin`, `catalog.admin`, `ops.emergency`, `ops.freeze`.
  - Governance: `audit.read`, `approvals.grant`, `mcp.use`, `mcp.mutate`, `plugins.admin`, `settings.admin`.
- **Roles:** viewer, developer, operator, admin, auditor.
- **Bindings:** IdP groups → roles, with patterns for env class, connection, vhost and resource.
- **Row filtering:** applied to shared inventory and metrics.
- **Four-eyes approval** (approver ≠ requester): budget peeks on 4.0–4.2 QQs, bulk replays, prod purge and firehose. More rules are configurable.

**Broker credentials (DC-41)**
- Mode is chosen per connection, always intersected with RBAC. Preference order:
  1. delegated OAuth access token for the broker audience (never ID tokens), via token exchange, OBO or a stored refresh token;
  2. Vault/OpenBao dynamic credentials;
  3. personal LDAP;
  4. service account.
- Delegated mode uses per-user pools.
- When a token expires, a job moves to **`awaiting-credentials`**. It never silently falls back to a service account; service-account execution is an explicit, audited per-connection policy.

**Other controls**
- Masking runs server-side before data reaches the UI, exports, MCP or audit.
- **Egress (DC-43):**
  - admin allow-list per environment;
  - denied by default: loopback, link-local, metadata, RFC 1918, CGNAT, ULA and IPv4-mapped forms;
  - DNS checked at connect time (custom `lookup` with `all:true`), `maxRedirections: 0`;
  - the same policy covers OIDC discovery, JWKS, Vault and webhooks;
  - backed by a Helm NetworkPolicy.

### 7.4 Local IPC (CLI and MCP shim): mutual authentication (gap fix)

**Discovery.** `run/engine.json`, mode 0600 under a 0700 directory (on Windows, `%LOCALAPPDATA%` with user-only ACLs), holds `{pipePath, key: 32 random bytes, pid}`. The pipe name carries a random suffix.

**Handshake.** No secret is ever sent over the wire:
1. The client sends `hello{nonceC}`.
2. The engine replies `{nonceS, macS = HMAC(key, "srv" ‖ nonceC ‖ nonceS)}`.
3. The client **verifies `macS` before sending anything else**, which defeats impostor engines and pipe squatting.
4. The client sends `macC = HMAC(key, "cli" ‖ nonceS ‖ nonceC)` plus the capability-token id.
5. The engine verifies it. Any other first frame closes the connection within 1 s.

**Additional checks**
- **Unix:** the client also checks that the socket directory's uid matches its own and the mode is 0700.
- **Windows:** the default named-pipe DACL grants Everyone read. Spike S-08 evaluates a `GetNamedPipeServerProcessId` + owner-SID check through a tiny optional helper. The HMAC handshake is the control that does not depend on it.

**Capability tokens**
- Created in the UI, **read-only by default**, scoped to connection aliases, expiring, and stored hashed.

### 7.5 Identity across modes (DC-37/38)

**Credential providers:**
- password
- oauth-pkce-loopback
- device-code
- client-credentials
- token-command
- static-token
- x509-external
- vault-dynamic
- delegated-user

Profiles hold separate HTTP and AMQP credentials.

**TokenManager**
- Refreshes at 75 % of the token's lifetime.
- Asserts that the username claim is unchanged.
- Renewal by protocol:
  - 0-9-1: `updateSecret`, plus a lazy credentials object used on reconnect;
  - AMQP 1.0: `PUT /auth/tokens` on 4.1+, reconnect on 4.0;
  - streams: reconnect;
  - HTTP: one retry after a 401, for idempotent requests only.
- Version-specific behaviour:
  - ≤4.2.5: the engine cancels its own consumers at expiry;
  - 4.2.6+: transparent reconnect after `320`.
- Size preflight warns when the Bearer header exceeds about 4,000 B, or when the PLAIN response exceeds 4096 B (≤4.0) or 8192 B (4.1+).
- Bearer is always preferred over Basic.

**OAuth discovery:** `/js/oidc-oauth/bootstrap.js` first; `/api/auth` only on ≤4.1.

**TrustStore (DC-44)**
- Starts from `tls.setDefaultCACertificates(bundled + getCACertificates('system') + org)`.
- Per-profile CAs are concatenated onto these, never replacing them.
- No leaf pinning.
- Server-name override; the insecure switch shows a red banner.

### 7.6 Supply chain

See §14.3. Also:
- an agent dependency allow-list (`tools/supply-chain/deps-allowlist.json`), where any addition needs an ADR line plus CODEOWNERS approval;
- `npm audit signatures`;
- GitHub Actions pinned by SHA;
- CodeQL and OpenSSF Scorecard.

---

## 8. Metrics architecture (DC-32/33)

**BrokerScheduler**
- The **only** path to the management API and Prometheus.
- Lanes: `interactive` pre-empts `live`, which pre-empts `background`.
- At most **one background management request per broker** at a time.
- AIMD backoff on 429, 5xx, or p50 latency above twice the baseline.
- Team: a global background cap of 64 requests.
- Single-flight detail GETs with a 2 s cache.
- Sweep cadence is `clamp(30 s, 15 min, 50 × lastSweepServerTime)`.

**ScrapePlanner** (pure, demand-driven)
- **Inputs:** views, pins and alert selectors, plus the BrokerProfile and scrape-cost history.
- **Scrape each node directly**, never through a Service or load balancer.
- **Discovery order:**
  1. provider adapters (Amazon MQ 16001–16003 with broker credentials; CloudAMQP per-node hosts);
  2. `http/prometheus` listeners from `/api/overview`;
  3. defaults: 15692/15691, 9419 (Bitnami), and 127.0.0.1:15692 with the `lavinmq_` prefix (LavinMQ).
- **Request shape.** Aggregated `/metrics` is always scraped. `/metrics/detailed?family=queue_coarse_metrics&family=queue_consumer_count&vhost=` runs only on demand. `queue=<regex>` is used **only on 4.3+**: at most 2,000 characters, chunked across requests.
- **Amazon MQ:** never per-object, and at most one scrape per 60 s.
- **Interval** is at least 10 × the scrape duration.
- **Parsing.** Bodies over 1 MiB go to the streaming parser in a worker.
- **Fallback:** management sampling with `?disable_stats=true&enable_queue_totals=true&columns=`; `disable_stats` is never sent to `/api/channels` below 4.3.6. Rates derived approximately are labelled as such.
- Clusters fronted by a load balancer are labelled "partial". QQ series are deduplicated by leader.

**Store**
- Hot in-memory window: 1 h at scrape resolution.
- Persisted: raw points for 48 h, plus 5 m and 1 h rollups.
- **Cardinality caps:** 2,000 queue series on desktop and 20,000 per broker on team. Watched queues and the top-K by backlog or growth are kept; cluster, node and vhost series always are.
- Chunked, delta-encoded tiers stay behind the `MetricsStore` port until a team-scale perf test demands them.

**Forecasts** (pure `forecast` library)
- EWMA rates.
- Drain ETA = backlog ÷ (outflow − inflow), with a band.
- Time to max-length, or to memory and disk alarms.
- z-score anomaly detection.
- A deterministic "why is this queue growing?" decision tree: no consumers, consumer utilisation, unacked at the prefetch ceiling, redeliveries, alarms or flow control, publisher spike.

**Alerts**
- **Rule kinds:** threshold with `for:`, absent consumers, DLQ inflow, ETA, broker health (alarms, node down, quorum-critical), certificate expiry, new high-severity lint finding.
- **State machine:** pending → firing → resolved, with dedupe and silences.
- **Delivery:**
  - desktop: native notification via PlatformBridge, plus the in-app inbox;
  - local web: browser Notification API;
  - team: webhook, Slack, Teams, PagerDuty v2, Alertmanager and SMTP, through the Dialer, with per-route rate limits.

---

## 9. Team-server specifics

**Isolation**
- Captures, taps and views are per user; sharing is explicit.
- There are no cross-user body caches.
- Per-capture-session DEKs.
- Quotas: taps (3 per user, 10 per broker, 50 global), capture bytes, peek rate, jobs per broker, Khepri churn.

**Shared pollers**
- One probe/explorer/metrics/lint poller per catalog connection, using a monitoring credential. It never touches messages.
- Results are cached and **filtered by RBAC on read**.
- `visibility: per-user` polls with the user's delegated credentials, for strict tenants.

**Delegated pools**
- Keyed by user, broker, vhost, protocol and role.
- Idle pools close after 60 s.
- Per-broker caps with fair queueing.
- `connection_name` carries the user ID.

**Durable jobs**
- One in-house runner, shared with desktop and local.
- `JobStore` exposes `claim`, `heartbeat`, `lease` and `finish`, using `FOR UPDATE SKIP LOCKED` on Postgres with a 30 s lease and a 10 s heartbeat.
- Every job is "X on behalf of Y". Expired delegation moves the job to `awaiting-credentials`.
- pg-boss is not used.

**v1 deployment**
- `replicaCount: 1` with `strategy: Recreate`, so there is never a second poller set and no RWO PVC surge.
- The advisory-lock leader acts as a **guard only**; readiness reflects DB, KEK and schema, never leadership.
- PodDisruptionBudget (`maxUnavailable: 1`, documented as a single point of failure).
- NetworkPolicy egress, ServiceMonitor on the separate port, restricted PSS, `readOnlyRootFilesystem`, an `emptyDir` for `/tmp`.

**HA path (v2)**
- N stateless API replicas.
- A `broker_lease` table (TTL 15 s, heartbeat 5 s, consistent-hash assignment) gives pollers and taps an owner per broker.
- Live subscriptions for brokers owned by another replica are forwarded over an authenticated internal mesh.
- Jobs are claimed with SKIP LOCKED.
- Sessions live in Postgres.
- Clients resume on lease moves (30 s resume window).
- `NOTIFY` carries control signals only.

**Helm chart** (OCI on GHCR, cosign-signed; Helm 4 and Helm 3)
- **Values:**
  - `image.digest`, `replicaCount: 1`, `publicUrl`;
  - `config` (YAML → ConfigMap), `existingSecret` (DATABASE_URL, OIDC secret, KEK or Vault token);
  - `migrations.job` (DDL secret), `ingress`/`httpRoute`, `networkPolicy`, `serviceMonitor`, `pdb`;
  - `persistence.captures`, `audit.anchors`, `plugins.allow[]` (sha256), `mcp.enabled:false`, `extraCA`.
- `values.schema.json` is generated from the zod `TeamServerConfig`.
- Tested with chart-testing on kind.
- No Postgres is bundled: docs point to CloudNativePG or a managed database, and a compose file with postgres:17 covers trials.

**Configuration schema** (zod; precedence: env, then `*_FILE`, then file, then defaults; unknown keys rejected)
- `server{bind, publicUrl, tls, trustProxy}`
- `database{urlRef, poolMax}`
- `crypto{kek: file | vaultTransit | openbaoTransit | kms}`
- `auth.oidc{issuer, clientId, secretRef, scopes, groupsClaim, roleMappings, session}`
- `auth.pats`, `egress{allow[], denyPrivate: true}`, `catalog`, `rbac`, `approvals`, `quotas`, `churn`
- `retention`, `audit{anchors}`, `metrics`, `alerts.routes`, `mcp`, `plugins`, `logging`, `otel{enabled: false}`

---

## 10. UI architecture: Angular 22.2.3, TypeScript 6.0.3

**Shell**
- `bootstrapApplication`, standalone components, zoneless and OnPush (both defaults).
- `provideRouter` with input binding.
- `provideHttpClient(withInterceptors([correlation, auth, problem]))`.
- Transport and bridge providers are chosen at boot: the preload sets `__APP_PLATFORM__`, otherwise the app reads `/bootstrap.json`.
- Transloco 8.4 with lazy scopes; the honest-wording lint runs over i18n keys.
- IDE layout: activity bar, resizable tree, tabs, bottom panel; layout persisted per profile.
- Routes: `/c/:cid/{explorer, queues/:qkey, exchanges, messages, tap, dlq, streams, topology, admin, metrics, lint}`, `/jobs`, `/approvals`, `/settings`, `/governance`.

**State**
- Signals and `linkedSignal` for local state.
- NgRx SignalStore 22.0.1 globally: Connections, BrokerProfile (gates, allowedActions, verification), Workspace; `withEntities` per feature.
- High-frequency data (tap, tail) sits in **rings outside the signal graph**, exposed through rAF-throttled snapshot signals.
- Signal Forms validate with contract schemas (Standard Schema).
- **The UI never computes authorisation.** It renders the `gates` and `allowedActions` the engine sends.

**Transport**
- `ENGINE_TRANSPORT`: `MessagePortTransport` (HttpBackend + LiveChannel) or `HttpWsTransport`.
- `PLATFORM_BRIDGE`: a typed, versioned `ElectronBridge` v1 (`requestEnginePort`, `pickSaveTarget`, `openExternal`, `notify`, `setMenu`/`onMenuCommand`, `onDeepLink`, `appInfo`), or `WebBridge`.

**Design system** (`ui-design`)
- **Tailwind:** Tailwind 4.3 tokens as CSS variables; light, dark and high-contrast themes; compact density (22–24 px rows, 12–13 px type).
- **Component sources:** Spartan brain **1.7.0** plus helm copies with the MIT notice (dialog, popover, select, command, sonner, resizable, sidebar, kbd); `@angular/aria` (tree, grid, listbox, menu, tabs, toolbar); CDK (overlay, virtual scroll, drag-drop).
- **Icons:** Lucide.
- **ThemeService** pushes tokens into AG Grid, Monaco, uPlot, ECharts and Cytoscape.
- **Safety components:** `<app-gated>` (why-disabled reason plus source), prod chrome, `PlanReviewPanel` (W-ids, consents, disposition, typed phrase, masked previews), receipt drawer, verification banner.
- A **dev-only gallery route** replaces Storybook; visual and axe tests run against it.

**Grids**
- `<app-data-grid>` adapts AG Grid Community 36.2.0. We build the context menu (`onCellContextMenu` + Aria menu), clipboard, column chooser and status bar ourselves.
- Up to about 5k rows: client row model with `applyTransactionAsync` at 4–10 Hz.
- Beyond that: the **infinite row model bound to engine windows** (block 200, at most 25 blocks), with **deltas pushed only for visible keys** (debounced to 100 ms) and `refreshInfiniteCache` at most every 5 s.
- TanStack Table v9 is the swap-in.

**Topology**
- Cytoscape 3.34.4 detects WebGL2, falling back to canvas, with level of detail.
- The engine extracts subgraphs (depth ≤ 2, ≤ 2,000 elements) and aggregated vhost views.
- **ELK 0.12.0 runs unmodified** as `assets/elk/elk-worker.min.js` (EPL-2.0 elected, with licence text and source pointer; DC-51). dagre 3.1.1 is the fallback.
- Foblex 19.3 for small editors.
- Every graph has an accessible table alternative.

**Editor and payloads**
- Our own Monaco 0.57 ESM wrapper: lazy chunk, JSON/XML/YAML workers only, diff editor, models disposed on destroy.
- **Payload viewer:** Monaco up to 2 MiB; a virtualised text/hex viewer beyond that. Bodies load in 1 MiB chunks via `blobs/{ref}`. Text only, and never `innerHTML`.

**Charts.** uPlot 1.6.32 (pinned or vendored) for live series; ECharts 6.1 via ngx-echarts 22 (tree-shaken) for dashboards.

**Commands**
- A single registry `{id, title, category, when, keybinding per OS/web, run}`.
- tinykeys 4.0.1 handles key matching; the palette is Spartan command.
- Entity search uses the engine's `search`.
- Native menus are generated from the same registry through `PlatformBridge.setMenu`.

**Budgets** (CI-enforced)

| Budget | Limit |
| --- | --- |
| Initial JS + CSS | 350 kB gzip (error at 450) |
| Feature chunk | ≤ 200 kB |
| Monaco | ≤ 1.1 MB, on demand |
| ECharts | ≤ 250 kB |
| Desktop cold start to interactive | ≤ 2.5 s |
| 50k-row grid | ≥ 55 fps scroll, no task > 50 ms |
| Live batch apply | ≤ 4 ms |
| Tap rendering | 2,000 msg/s, then sampling with counters |
| Renderer heap | ≤ 350 MB with a 50k grid plus a 10k ring |

---

## 11. Plugin and codec SDK (DC-53)

**Data first.**
- `header-registry.json` is published and machine-readable. It holds header mappings, queue naming conventions and delay-infrastructure patterns: `nsb.v2.delay-level-*`, `celery_delayed_*`, `mt-delay-*`, `delay_*_retry`, `{q}.delay.{ms}`, `{q}-retry`, `{q}.DQ`.
- A generic declarative decoder interprets it, so most v1.0 frameworks are pure data. Code is needed only for body envelopes and fingerprints.

**Contracts** (`plugin-sdk`)
- `DecoderPlugin`: `detect`, `decode` → `NormalizedFailure`, `fingerprint`, `replayPlan`.
- `CodecPlugin`: `detect`, `decode`, `encode?`.
- `apiVersion: 1`; the engine supports N and N−1.

**Built-ins in v1.0:** generic, MassTransit (fixtures from v8, Apache-2.0), Spring, NServiceBus, EasyNetQ, Celery. v1.1 adds Symfony, Rebus, Wolverine, Laravel, Dramatiq and Sneakers. Pickle and PHP objects are never deserialised; they are shown as an opcode disassembly or tokens.

**Trust tiers**

| Tier | Runs as | Limits |
| --- | --- | --- |
| 1. First-party | Code in the piscina pool | `resourceLimits` (64 MB old generation), 250 ms per call with terminate-on-timeout, input ≤ 16 MiB, output ≤ 4 MiB of JSON |
| 2. Declarative manifests | Interpreted by the engine | Timeout-safe regex engine and JSONPath subset |
| 3. Third-party code | **quickjs-emscripten 0.32.0 (WASM) inside a worker** | No host APIs except pure helpers; 32 MiB memory; 50 ms interrupt budget per call; 1 MiB input; zod-validated output |

**Third-party policy.** Off by default. Desktop installs only from a local `.tgz`. Team installs need admin approval and a sha256 allow-list. All installs are audited.

**Honest limits.** Worker threads are not a security boundary, and Node 24's permission model cannot restrict the network (`--allow-net` exists only in the Node 26 docs). That is why tier 3 uses QuickJS.

**Packaging.** An npm tarball whose manifest contains `<product>Plugin{apiVersion, kind, entry, tier, frameworks, sha256}`. Single-file ESM, no native code, no install scripts.

---

## 12. Testing architecture

| Layer | What it covers | Where it runs |
| --- | --- | --- |
| Unit (Vitest 5) | Pure planners, effective-config and routing (fast-check), deaths, masking, PolicyEngine, kit invariants, live-protocol **model-based** tests, parser fuzzing | All runners |
| Architecture and security | Nx boundaries; mutation funnel and **plan purity** (ts-morph and throwing WritePorts); lockfile, licence and allow-list gates; CSP and header tests; Host/Origin/Sec-Fetch/ticket tests; carrier-header rejection; **SSRF suite including DNS rebinding**; IPC mutual-auth tests; `fuse-check`; `gates-selftest` | Linux, plus packaging on each OS |
| HTTP specs | `createTestEngine().inject` for every action | Linux |
| Adapter contract | 0-9-1 suite on amqplib **and** @cloudamqp/amqp-client; AMQP 1.0 adapter vs a **differential oracle** (coders51 client with rhea overridden to 3.0.5); management client vs **golden fixtures** for 3.13.7, 4.0.9, 4.1.8, 4.2.9, 4.3.6 and LavinMQ 2.10.2 (nightly refresh diff opens a PR) | Linux |
| **Conformance (public, DC-47)** | Every registry cell, settle path and executor failure path (`CF-EXEC-*`); replay cancel/shutdown/crash mid-flight on finite-L QQ DLQs; counter-trust cells; DC-21 vhost round trip; filter echo (DC-23); token expiry by version. **Recorded lab evidence vs live run vs registry** (§5.2). Mutation testing nightly. | Linux (amd64 and arm64) |
| Broker matrix | `broker-lab` images based on `rabbitmq:<v>-management` with stream, prometheus, tracing, shovel, federation, consistent-hash and event-exchange plugins; ports 5672/5671/15672/15671/5552/5551/15692; TLS and Keycloak OAuth variants; fixed stream advertised port. **Per PR:** all 5 versions on Node 24.22, sharded. **Nightly:** Node 26.12, Electron's Node (`ELECTRON_RUN_AS_NODE` on the test-fused binary), 4.3.7, 4.4 and 5.0 alphas (allowed to fail; they feed the "unverified" state) | Linux |
| Chaos (toxiproxy, leader transfer, HAProxy, 3-node compose) | Thousands of peeks under faults, **asserting DC/AC deltas** for the nack-vs-DOWN race (S-09); replay crash mid-flight; memory alarm during taps; publish blocked during rescue | Linux nightly |
| E2E web | Playwright 1.64.1, local mode against broker-lab; axe on every route; visual snapshots of the dev gallery | Linux |
| E2E team | Postgres + Keycloak 26: OIDC, RBAC row filtering, approvals, audit chain + anchors, restore drill, MCP OAuth resource, emergency revoke, freeze | Linux |
| E2E desktop | Playwright `_electron` on the test-fused build: boot, tunnel, reload re-wiring, **engine crash → port re-issue**, suspend/resume, safeStorage; **deny-all egress proxy run (I-12)** | Linux (xvfb) full; macOS (brew rabbitmq 4.3.6) and Windows (fakes) smoke |
| Performance | I-5 loop SLO under sweep + tap; MessagePort p95 (≤ 2 ms overhead); tap ingest; capture ingest ≤ 5 ms per transaction; **100k-queue synthetic management API and 400k-series Prometheus fakes**; UI 50k/100k grid fps (CDP); nightly regression gate at 15 % | Linux nightly, PR smoke |
| Provider contracts | Amazon MQ 3.13/4.2/4.3, CloudAMQP, LavinMQ (recorded deviations) | Gated workflow with secrets |
| Packaging | Fuses, notarisation, MSIX install smoke, Docker `/readyz` + container-mode Host tests, Helm `ct lint/install` on kind | Per OS |

---

## 13. Observability of the tool itself

**Logs**
- pino 10.4.0 structured JSON. Correlation IDs: `requestId`, `actionId`, `planId`, `jobId`, `peekId`, `receiptId`.
- Redaction:
  - by path: `authorization`, `cookie`, `password`, `token`, `*.secret`;
  - by value: credentialed AMQP/HTTP URIs, JWTs (`eyJ…`), Bearer values, shovel and federation URIs, JWT-bearing `x-` headers.
- Bodies are never logged.
- A canary-secret scan runs in E2E.
- Sinks: desktop rotating files (10 MB × 5); local stdout plus a file; team stdout.

**Self-metrics**
- Loop delay, worker queues, scheduler lanes and AIMD state, pool budgets, live drops and gaps, job states, DB latency.
- Shown on an in-app Diagnostics page. Team mode also exposes `/metrics` on a separate port behind a token.

**OpenTelemetry** is off by default. `@opentelemetry/*` is lazy-loaded only when the user configures an OTLP endpoint. Span attributes come from an allow-list.

**Crash reports**
- `crashReporter{uploadToServer: false}`; minidumps stay local.
- "Export diagnostics bundle" collects redacted logs, versions, a BrokerProfile summary, receipts and incidents. Upload happens only to an endpoint the user configures.
- No telemetry, licence check or phone-home (DC-59).

---

## 14. Build, packaging, release and versioning (DC-58)

### 14.1 Toolchain and artefacts

**Toolchain**
- Nx 23.3.0: @nx/angular, @nx/vitest, @nx/playwright, @nx/esbuild, @nx/eslint; **no @nx/nest**.
- pnpm 12.14.x (`packageManager`), Node 24.22.x (`engines >=24.15`).
- TypeScript 6.0.3 strict: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`.
- ESLint 10 with typescript-eslint strictTypeChecked and angular-eslint 22; Prettier.

**Artefacts**
- `dist/web/<version>`
- `dist/engine/main.mjs` (ESM, with an esbuild **metafile**; a CJS fallback if spike S-02 fails)
- `dist/desktop` (ESM main; CJS single-file preload)
- the npm CLI (engine plus web)
- the container image
- the Helm chart

### 14.2 Packaging and release

**Desktop** (electron-builder **26.17.0** exact, electron-updater **6.8.10** exact)

| Platform | Packaging |
| --- | --- |
| macOS | dmg + zip for arm64 and x64; Developer ID, hardened runtime, notarised from day one; own Homebrew tap |
| Windows | **Store MSIX first** (updates come from the Store); NSIS + zip on GitHub, signed in two passes via SignPath once eligible: sign the app, build NSIS, sign the installer, **regenerate `latest.yml` and the blockmap** |
| Linux | deb and rpm (x64, arm64) with an AppArmor profile; AppImage with the Ubuntu 24.04 caveat; never `--no-sandbox` |

**Update checks are opt-in.** A first-run dialog with no preselected choice asks the user. Store, Homebrew and winget builds use their own channels.

**Other channels**
- npm: trusted publishing with provenance.
- GHCR: multi-arch images built on native runners and merged by digest; `distroless/nodejs24-debian13:nonroot` pinned by digest; cosign keyless; SBOM and provenance attestations; Trivy scan.
- OCI Helm chart, signed.

**Release flow**
1. release-please 17 in manifest mode keeps **one product SemVer**; its release PR is the human gate.
2. On tag: the full CI and **conformance gate** (Tier-1 brokers green).
3. Build the matrix.
4. Sign and notarise.
5. Regenerate update metadata.
6. Run `fuse-check` and the licence gate.
7. Generate `THIRD_PARTY_NOTICES` and the CycloneDX SBOM **from the esbuild metafile**, plus Angular stats and electron-builder file lists. Lockfile-based generation would over- or under-report bundled code.
8. Generate SHA256SUMS and attestations.
9. Create a draft, then publish an **immutable** release.
10. Bump the Homebrew tap and winget manifests; publish the docs and compatibility matrix.

### 14.3 Pins, release-age gate and security lane (gap fix)

`pnpm-workspace.yaml`:

```yaml
catalog: { ... exact pins ... }        # every dependency via catalog:, exact versions
minimumReleaseAge: 4320                 # 3 days
minimumReleaseAgeStrict: true
minimumReleaseAgeExclude:               # reviewed list; each entry -> docs/adr/ADR-028-log.md line + CODEOWNERS
  - '@spartan-ng/brain@1.7.0'
  - '@spartan-ng/cli@1.7.0'
  - '@angular/core@22.2.3'              # and the rest of @angular/* 22.2.3
  - 'fastify@5.12.7'
  - 'zod@4.6.7'
  - '@playwright/test@1.64.1'
  - 'testcontainers@12.2.1'
  - 'undici@8.12.2'
trustPolicy: no-downgrade
blockExoticSubdeps: true
strictDepBuilds: true
allowBuilds: { electron: true, esbuild: true, '@napi-rs/keyring': true }
overrides: { }                           # security lane writes here
```

**Security lane (expedited, under 24 h).**
1. An OSV-Scanner or Renovate vulnerability alert fires.
2. A triage issue opens using the `security-lane` template.
3. A `pnpm.overrides` entry and an **exact-version** `minimumReleaseAgeExclude` entry are added, plus an ADR log line, approved by CODEOWNERS.
4. **Every esbuild-bundled artefact is rebuilt** (engine, CLI, desktop, image), because bundles bake in the vulnerable code.
5. The conformance smoke runs.
6. A patch release ships.

Electron 45.0.0 GA follows the same reviewed exclusion after a 7-day soak.

**Stale-exclusion check.** Exclusions are pruned when they are no longer resolved (`minimumReleaseAgeExcludePrune: true`). A monthly job flags exclusions older than 30 days.

---

## 15. Agent delivery plan

**Conventions**
- AGENTS.md is canonical. CLAUDE.md is kept under 200 lines and imports AGENTS.md.
- Path-scoped `.claude/rules/{engine, ui, desktop, semantics, security}.md`.
- Hooks: format and lint on edit; affected typecheck and tests on Stop.
- Skills: `new-action`, `new-adapter`, `new-ui-feature`, `new-semantics-cell`, `security-lane`, `release`.
- Every project has a README covering purpose, public API, invariants and proof commands.
- One spec per work package: goal, files and interfaces, out of scope, Given/When/Then, verify command.
- Writer/reviewer split. Fresh-context review on `trust:critical`.
- Golden-path examples: `explorer.queues.list` (query), `queues.purge` (two-phase), `tap.messages` (credit topic).
- WP size: 1–3 agent-days. **Feature WPs stay blocked until WP-10 (executor) and WP-12 (peek conformance) are green.**

**Spikes (M0):**
- S-01: MessagePort + inject p95, 16 MiB payloads, reload/close, `payloadAsStream`.
- S-02: utilityProcess ESM cold start ≤ 600 ms.
- S-03: node:sqlite dialect + FTS5 in Electron.
- S-04: CSP and Trusted Types with Monaco, ELK and AG Grid under `app://`.
- S-05: nack + barrier counters on 4.2.9 and 4.3.6.
- S-06: rhea credit-1 stepping, drain, release, filter echo.
- S-07: safeStorage async, Linux backends, `crypto.argon2` under BoringSSL.
- S-08: Windows pipe DACL / owner check.
- S-09: nack-vs-DOWN chaos.
- S-10: MSIX + utilityProcess; SignPath two-pass signing.
- S-11: Nx 23.3 + Angular 22.2 + esbuild engine.
- S-12: QuickJS limits and performance.
- S-13: management API cost at 100k queues (paged vs unpaged).
- S-14: AG Grid infinite model at 100k rows.

| WP | Scope | Depends on | Verify |
| --- | --- | --- | --- |
| 01 | Workspace, catalogs, pnpm supply-chain configuration, boundaries, banned list, licence/lockfile/allow-list gates, arch-test skeleton | — | `nx run tools:gates-selftest` (planted git dependency, TS 7, `oasdiff` and primeng all fail) |
| 02 | Contracts kit, ObjectKey, Problem, live frames, config schemas, spec emitters | 01 | `nx test contracts && nx run contracts:api-docs-check` |
| 03 | Semantics registry v0, era and verification resolver, evidence checker | 02 | `nx test semantics && nx run semantics:audit-cells` |
| 04 | broker-lab images, Testcontainers helpers, `conformance:record` | 01 | `nx run broker-lab:verify` (5552 and 15692 reachable on 5 versions) |
| 05 | adapter-mgmt-http, golden fixtures | 02 | `nx run adapter-mgmt-http:test-golden` |
| 06 | Dialer, TrustStore, egress policy | 02 | `nx test net-dialer` (SSRF + rebinding) |
| 07 | adapter-amqp091 (role-typed leases, proofs, no reject) + dual-library contract suite | 05, 06 | `nx run adapter-amqp091:contract --broker=all` |
| 08 | Capability probe → BrokerProfile, gates | 03, 05 | `nx run svc-capabilities:it --matrix` |
| 09 | Persistence (dialects, one migration set, encryption, backup) + JobStore | 02 | `nx run persistence:it --dialects=sqlite,pg` |
| 10 | ActionExecutor, PlanStore, local guardrails, audit chain, receipts | 03, 09 | `nx test kernel` (fail-closed matrix, TOCTOU, audit-fail-deny, plan purity) |
| 11 | Peek planner (pure) | 03 | `nx test peek-planner` (every b.8 row; corrected M2 example) |
| 12 | Peek executor + state machine + rescue preflight + hold journal | 07, 08, 10, 11 | `nx run conformance:test --grep 'peek\|CF-EXEC'` |
| 13 | Transport: router, inject tunnel, live hub, WS tickets, IPC mutual auth | 10 | `nx run engine:it-transport` |
| 14 | Electron main and preload, supervisor, DrainCoordinator, port re-issue | 13 | `nx run e2e-desktop:smoke && nx run tools:fuse-check` |
| 15 | Angular shell, transports, design system, command registry | 02, 13 | `nx run e2e-web:smoke` + budgets |
| 16 | Explorer (windows, search) + grid adapter | 08, 15 | `nx run perf:grid-100k` |
| 17 | Taps + firehose + churn budgets | 07, 10 | `nx run conformance:test --grep tap` |
| 18 | amqp10 adapter + stream browser | 06, 08 | `nx run adapter-amqp10:contract && conformance --grep stream` |
| 19 | DLQ: decoders, ReplayPlanner, ReplayJob, drain/park rules | 12, 17 | `nx run conformance:test --grep 'replay\|CF-DLQ'` |
| 20 | Admin CRUD (DC-21), effective config, routing simulator, lint | 08 | `nx run conformance:test --grep vhost-roundtrip` |
| 21 | Metrics (scheduler, scrape planner, store, forecasts, alerts) | 06, 08 | `nx run perf:metrics-100k` |
| 22 | Local web + container mode | 13, 15 | `nx run e2e-web:security` |
| 23 | Team: OIDC BFF, RBAC, approvals, delegated pools, Helm, migrations Job, anchors | 10, 13 | `nx run e2e-team:e2e && nx run helm:ct` |
| 24 | Ops: emergency revoke, freeze | 17, 19 | `nx run e2e-team:e2e --grep ops` |
| 25 | MCP (in-house server, SDK oracle tests) + CLI | 10, 13 | `nx run svc-mcp:it` |
| 26 | Plugin host (tiers 1–3) + SDK publish | 19 | `nx test plugin-host` |
| 27 | Release pipeline + security lane workflow | 14, 22, 23 | Dry-run release on a fork tag |

---

## 16. DC traceability (compact)

| DC | Where it is met |
| --- | --- |
| 01/02 | §5.2 |
| 03–16 | §5.4–5.6 |
| 17–20 | §5.7 |
| 21 | svc-admin + conformance |
| 22–26 | §5.7, adapter-amqp10 |
| 27–29 | §5.8 |
| 30 | effective-config |
| 31/32 | svc-capabilities, §8 |
| 33 | §8 |
| 34–36 | §1, §3, §7 (DC-36 container exception, §1.2) |
| 37–39 | §7.5 |
| 40/41 | §7.3, §6.5 |
| 42 | §5.1, §5.12 |
| 43/44 | §7 |
| 45 | §6.4 |
| 46 | §1.1, §7.1 |
| 47 | §12 |
| 48 | §2, §12 |
| 49 | §4 (fastify deviation), §14.3 |
| 50/51/52 | §10, §14 |
| 53 | §11 |
| 54 | §5.8 |
| 55 | adapter-mgmt-http |
| 56 | lint-rules |
| 57 | naming |
| 58 | §14 |
| 59 | §13, §14 (opt-in updates) |
| 60 | §5.2 (verification state), §12 |

---

## 17. Decision provenance

| Decision area | Chosen option | Source → judge | Reason |
| --- | --- | --- | --- |
| Base design | simplicity-first skeleton + safety-first semantics | A (simplicity won) + B (safety won) | Both judges' graft lists converge on this hybrid |
| Process model | Thin main, utilityProcess, DEK via ctl, supervisor, lock file, clock-jump detector, DrainCoordinator with budgets, port re-issue, desktop job resume after confirmation; workers minimal, I-5 SLO gate | simplicity + scale + safety → A, B | Closes the port-reissue, drain-budget and unattended-resume holes without speculative workers |
| Desktop transport | MessagePort per page load + inject tunnel + header hygiene + carrier secret + chunking; engine-link worker only after S-01 | all three → A, B | DC-35 with a single dispatch path |
| Live protocol | Per-topic QoS, credits, bounded outboxes, gap, goaway, resume, session limits; snapshot-delta; ack after ring insert | scale + simplicity → A | Loss is always visible; same semantics on both carriers |
| Contract | defineAction/defineTopic, z.toJSONSchema, no Orval, ObjectKey, oasdiff Go binary | simplicity + scale + safety → A, B | No drift; avoids the npm placeholder trap |
| Engine framework | **Fastify 5.12.7**, ≤800 LOC kit, typed composition root | simplicity → A, B; pin per judges | Nest 12 pins vulnerable fastify; policy lives in the executor anyway |
| Module boundaries | Layer tags + Read/Write funnel + trust:critical + confinement table + custom lint rules | all → A, B | Mechanical guards for agents |
| Semantics registry | Typed data + citations, CT ids, status; fail-closed lookup; coverage gate; **independent lab evidence + mutation testing** | scale + safety + simplicity → A, B; gap fix | Breaks the spec/expectation circle |
| Peek | DC-09 disposition model, sequential get, proof-typed ports, hold budget formula, lazy close; **credit-1 AMQP 1.0**; rescue preflight + failure paths | safety + scale + simplicity → A, B; gap fix | The only model that reads DC-09 correctly |
| Taps | Pure TapPlanner, literal spec, ownership argument, durable firehose leases; **churn budgets** | scale → A, B; gap fix | Robust to crashes; bounds Khepri writes |
| DLQ replay | Source role, park-by-confirm, pure planner, idempotency; **prefetch 1, source gating, no nack-flush, at-least-once identity** | simplicity + safety + scale → A, B; gap fix | Prevents b.4 carry-over losses |
| Action layer | Simplicity shape + safety fail-closed semantics + scale TTLs (5 min / 24 h) | → A, B | DC-40/42; four-eyes approval feasible |
| Persistence | Kysely + node:sqlite / pg, one migration set, encrypted blobs, DDL/DML split, volatile captures; **plan/journal encryption, backup and anchors** | all → A, B; gap fix | Real system of record; PII minimised |
| Job runner | In-house runner + lease-shaped JobStore; no pg-boss | simplicity + scale → A, B | Same semantics in every mode; HA additive |
| Metrics | Scale planner + scheduler; simplicity storage | → A, B | Broker load is the real scaling risk |
| Security | safety-first threat model and controls + I-10/I-12; **IPC mutual auth**; **container mode** | safety + scale + simplicity → A, B; gap fix | Most complete set; fixes Windows pipe and Docker contradictions |
| Updates | **Opt-in at first run** | scale (A) over safety (B, on by default with notice) | Both satisfy DC-59; opt-in keeps I-12 strict and avoids SignPath privacy friction |
| Team deployment | Single replica, **Recreate**, guard-only leader | simplicity → A; B allows it | Avoids duplicate pollers and RWO surge problems; scale-first's leader-gated readiness stalls rollouts |
| Team identity and ops | awaiting-credentials, Helm DDL hook, quotas, PDB, NetworkPolicy, ServiceMonitor; shard-lease HA path; **emergency revoke and freeze** | safety + scale → A, B; gap fix | DC-41 accountability; tool blast radius |
| UI | Common stack + EngineApi + no UI authorisation logic + innerHTML ban + engine windows + chunked payloads + dev gallery; **chunk-skew handling** | all → A, B; gap fix | Flat memory at 100k objects; version safety |
| Plugins | Data-first registry + 3 trust tiers (QuickJS) + N/N−1 | simplicity + safety + scale → A, B | Real sandbox for third-party code, no native addon |
| MCP | In-house tools-only server; SDK as oracle; approvals inbox on desktop | simplicity + safety + scale → A, B | Small attack surface; DC-42 |
| Testing | Broker-lab, PR matrix, nightly runtimes and alphas, scale fakes, model tests, Keycloak E2E, deny-all egress, plan purity, SSRF, packaging smoke; **failure-path cells, mutation testing** | all → A, B; gap fix | Correctness is the differentiator |
| Release | Common pipeline + exact pins (electron-builder 26.17.0, electron-updater 6.8.10, Spartan 1.7.0) + notices from metafile + conformance gate; **security lane** | safety + scale → A, B; gap fix | Avoids registry traps; bundled code needs rebuilds |
| Delivery plan | Core-first WP graph, 1–3 day WPs, generators, corrected M2 example | safety + scale + simplicity → B | Agents follow acceptance criteria literally |
