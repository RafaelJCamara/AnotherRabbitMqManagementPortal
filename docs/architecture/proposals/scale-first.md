# Architecture proposal: scale-first

> One of three competing proposals scored by two judges ([judges.md](judges.md)). The final blueprint is [../blueprint.md](../blueprint.md). Kept for traceability; not normative.

**Philosophy.** Scale and performance first, agent-tractable by construction. Size the design for the hard cases from day one: a broker with 100k queues, a tap at 10k msg/s, a 10 MiB payload and a team server with 500 users and 200 brokers. Five mechanisms make that possible. (1) The engine's I/O thread is latency-critical: peek watchdogs, heartbeats and nack flushes depend on it, so all CPU work and all SQLite access run in single-purpose workers. (2) Every buffer is bounded by count and by bytes, and every drop is counted and shown. (3) Every large collection stays in the engine and the UI only sees windows of it. (4) Broker load has a budget per broker; polling and scraping happen only when a view, alert or pin needs them, and interactive requests go first. (5) Every message-touching action follows the same path: plan, consent, execute, receipt. Agent tractability comes from things that are hard to get wrong. There is one contract-first operation registry that every transport, the MCP surface and the docs are generated from. Planners are pure functions and testable in isolation. A data-driven semantics registry is tied cell by cell to a public conformance suite. Port types make unsafe broker calls impossible to express. Nx tag boundaries and per-adapter library confinement are enforced by lint. Generators make the correct structure the easiest one to write.

## Summary

One TypeScript engine (Node 24.22) runs in three hosts. On the desktop it is an Electron 45 utilityProcess. In local web mode it is a loopback Node process started with npx or Docker. In team mode it runs as a container with Postgres. All three use one Angular 22 build. All broker I/O stays in the engine. Inside the engine, an I/O-loop thread owns every socket, the peek watchdogs and the job orchestration. Workers do everything CPU-heavy and own the storage: a storage worker for config.db and data.db, a capture worker (capture.db with FTS5 plus blob files), a metrics worker (Prometheus parsing, rollups, alerts), an index worker (columnar inventory, windowed queries, search) and lazy codec and plugin pools. Large HTTP bodies are streamed in chunks from the loop to the worker that parses them. The loop's event-loop delay is held to p99 ≤ 20 ms as a tested SLO.

The UI talks to the engine through one contract served over three transports. On the desktop, a per-window MessagePort (DC-35) carries REST requests and responses, which are fed into the same Fastify router with fastify.inject behind a custom Angular HttpBackend, plus a multiplexed live protocol. In local web and team mode the same contract runs over HTTP and WebSocket. The CLI and the MCP shim use HTTP over a Unix socket or named pipe. The live protocol uses credits, per-topic QoS (lossless, latest or sampled), bounded outboxes and engine-side coalescing and sampling. The UI decodes frames in a Web Worker, so taps at 10k msg/s never block rendering.

NestJS 12 is used only at the HTTP edge and for wiring: explicit DI tokens, no emitDecoratorMetadata, an esbuild bundle and no @nx/nest. Services, adapters and semantics are framework-free, and controllers are generated from the zod operation registry. If the cold-start spike fails, the fallback is to generate Fastify-only routes from that same registry.

Message safety runs through one OperationGateway shared by the UI, CLI, MCP and jobs: authorize, capability gate, guardrails, plan, consent or approval, audit attempt, execute, receipt, audit outcome. Several pieces sit behind it:
- A data-driven semantics registry, with a conservative era resolver, generates plans, warnings and receipts.
- Peeks are short, engine-side, atomic jobs: basic.get on a role-separated peek connection, a post-acquire guard and rescue, then one multiple-nack followed by a basic.qos barrier.
- Taps default to copied-binding exclusive classic queues.
- DLQ replay uses confirm-then-ack, a journal and throttling.
- Streams are browsed over AMQP with anonymous readers.

Scale comes from engine-resident inventory with windowed queries (AG Grid Community in infinite mode) and from demand-driven sweeps whose cadence is derived from measured broker cost. Metrics are Prometheus-first, scraped per node and demand-driven, stored in chunked tiers (hot ring, then 1m, 5m and 1h). Captures use byte-bounded rings that spill to disk.

The team server v1 runs as a single leader replica. It has an OIDC BFF, deny-by-default scoped RBAC, four-eyes approvals, a hash-chained audit log, shared broker monitors and per-user delegated connection pools. The HA path is lease-based ownership of broker shards. Security, supply chain, testing (public conformance matrix, broker-lab image with ports 5552 and 15692, perf and chaos suites) and the signed release pipeline follow the binding DCs. Appendix A lists the spikes that gate decisions; Appendix B splits the build into 38 agent-sized work packages with executable acceptance checks.

# <Product> System Architecture Blueprint

Version 1.0 · 2026-10-16 · Role: system architect · Design philosophy: scale and performance first, agent-tractable

**Inputs**
- The verified fact sheet, sections a–p, and DC-01..DC-60. These are binding.
- The product and stack research. Where it conflicts with the fact sheet, the fact sheet wins.

**Naming**
- `<Product>` / `<product>` is the brand placeholder.
- Workspace libraries use the `@app/*` scope.
- Published artefacts use `@<product>/*`, `ghcr.io/<org>/<product>` and `oci://ghcr.io/<org>/charts/<product>`.
- No identifier contains "RabbitMQ" or "RMQ" (DC-57).

**Status of the numbers and claims**
- Any number labelled "target" is a design budget. The performance suite (section 12) validates it; it is not a measurement.
- None of the broker behaviour described here has been lab-tested yet (fact sheet legend).
- The conformance suite is therefore on the critical path of the first release.

---

## 0. Invariants and global budgets

### 0.1 Invariants (every agent task must preserve these; most are enforced by lint or tests)

| # | Invariant | Enforced by |
| --- | --- | --- |
| I-1 | All broker I/O happens in the engine. The renderer or browser never opens a broker socket. Nobody is asked to configure CORS or Web-STOMP (DC-34). | Renderer CSP `connect-src 'self'`; protocol libraries banned in `platform:browser` projects |
| I-2 | Every call from the UI, CLI, MCP, jobs and alert automations passes through the OperationGateway (DC-42). | Controllers are generated wrappers; an architecture test checks that edges reach services only through the gateway |
| I-3 | Broker behaviour that depends on version is data in the semantics registry (DC-01). Code never compares broker versions. | ESLint rule `no-broker-version-compare` everywhere outside `libs/engine/semantics/**` and the probe |
| I-4 | Message-touching actions follow plan → consent → execute → receipt. Deliveries are never held across a UI round trip (DC-05, DC-15). | Port types (5.2); planner unit tests |
| I-5 | The engine I/O thread never runs synchronous work longer than 5 ms. Its event-loop delay p99 ≤ 20 ms under load is a tested SLO, because peek watchdogs, heartbeats and nack flushes run on it. | `monitorEventLoopDelay` gate in perf CI; `node:sqlite` may be imported only by worker entrypoints |
| I-6 | Every buffer is bounded by count and by bytes. Every drop is counted and surfaced. | Services may only use `BoundedRing` and `BoundedQueue` (lint) |
| I-7 | The UI never materialises an unbounded collection. Large collections live in the engine and are windowed. | The data-access API has no "list all" for inventory kinds |
| I-8 | Background load on each broker is budgeted, and interactive requests pre-empt background ones. | BrokerScheduler is the only path to MgmtHttpPort and PrometheusPort |
| I-9 | Every outbound socket goes through the Dialer and the TrustStore (DC-43, DC-44). | `net`, `tls` and `undici` imports banned outside the dialer and protocol-adapter connectors |
| I-10 | After a secret is entered, it never reaches the renderer again. Secrets never appear in logs, URLs, argv or env (DC-45). | Write-only API fields; redaction tests; log scan in E2E |
| I-11 | Each third-party UI or protocol library is imported only by its adapter project. | Boundary rules (2.4) |
| I-12 | No telemetry, licence check or phone-home by default. Update checks are opt-in (DC-59). | Desktop E2E run behind a deny-all egress proxy |

### 0.2 Global budgets (targets)

**Reference setup**
- Machines: Apple M1 with 8 GB; Windows 11 on an i5-8250U with 8 GB; Ubuntu 24.04 on a Ryzen 5 with 16 GB.
- Broker: 3 nodes, 100k queues, 10k exchanges, 300k bindings.

| Area | Budget |
| --- | --- |
| Desktop cold start | Window shell visible ≤ 400 ms; engine `ready` ≤ 800 ms p50 and ≤ 1.5 s p95; last workspace rendered from cache ≤ 1.5 s |
| Engine memory | Idle ≤ 180 MB RSS; with the reference broker connected ≤ 600 MB; heap cap 2 GB on desktop (configurable) |
| Renderer memory | ≤ 350 MB with the reference broker open and one 10k msg/s tap running |
| Engine loop | Event-loop delay p99 ≤ 20 ms during a 100k-queue sweep plus a 10k msg/s tap |
| Inventory | First window of a 100k-queue list ≤ 300 ms from cache; search keystroke to results p95 ≤ 50 ms |
| Tap | Capture 10k msg/s of messages ≤ 4 KiB using ≤ 1 engine core; UI renders ≤ 10 batches/s; no long tasks over 50 ms |
| Payloads | A 10 MiB body exists at most twice in engine memory; first 1 MiB chunk rendered ≤ 300 ms after the copy lands |
| Background broker load | ≤ 1 concurrent background management request per broker per engine; broker-side time ≤ 2 % of wall time; Prometheus interval ≥ 10 × scrape duration per node |
| UI bundle | Initial JS ≤ 350 KB gzip; explorer route including the grid ≤ 450 KB gzip; Monaco, ECharts, Cytoscape and ELK load lazily |
| UI frames | 60 fps when scrolling a 100k-row grid; applying a live batch ≤ 4 ms; no task over 50 ms after the route has loaded |
| Team server (medium) | 500 concurrent users, 200 brokers and ≤ 1M resident inventory rows on 4 vCPU / 8 GB, plus Postgres |

---

## 1. Process model per delivery mode

### 1.1 One engine, three hosts

**Build output from `apps/engine`**
- One esbuild ESM bundle, `engine.mjs`.
- Six worker bundles.
- The single Angular build, `web/`, shipped alongside.

The three entrypoints differ only in composition:

| Concern | Desktop (`entry/desktop.ts`) | Local web (`entry/local.ts`) | Team server (`entry/server.ts`) |
| --- | --- | --- | --- |
| Host | Electron 45 utilityProcess (Electron's Node 24.22) | Node 24.22 via `npx @<product>/cli serve` or Docker | Node 24.22 container (distroless, nonroot) |
| UI transport | One MessagePort per window; no TCP listener | HTTP + WebSocket on 127.0.0.1 | HTTPS + WebSocket behind ingress |
| CLI and MCP | Unix socket or named pipe + capability token | Same as desktop | API tokens over HTTPS; `/mcp` |
| Edge identity | Port-bound principal `desktop-user` | Launch token (Bearer) | OIDC BFF session or API token |
| Authorization | Guardrails only (single user) | Guardrails only | RBAC + approvals + guardrails |
| Persistence | node:sqlite files (Kysely) | node:sqlite files | Postgres (Kysely) + PVC for blobs |
| Secrets | DEK wrapped by safeStorage async, via main | Keyring or master password; in Docker, a KEK file | Envelope encryption: KMS, Vault or OpenBao Transit, or a static KEK |
| Default egress policy | Permissive, but metadata and link-local ranges always denied | Same as desktop | Strict allow-list |
| Inventory mode | Per profile | Per profile | One shared monitor per catalog connection |

Mode-specific code may appear only in `apps/engine/src/entry/**` and `apps/engine/src/modules/**` (composition). Services receive capabilities through ports (lint rule `no-mode-branching`).

### 1.2 Threads inside the engine (all modes)

```
                              engine process
 ┌───────────────────────────────────────────────────────────────────────────────┐
 │ I/O LOOP (main thread) — latency-critical                                     │
 │  edge: Nest/Fastify router, tunnel server, WS + socket listeners              │
 │  OperationGateway · PlanStore · LiveHub · BrokerScheduler · TokenManager      │
 │  ConnectionManager: amqplib / rhea / undici sockets, Dialer tunnels           │
 │  PeekExecutor + watchdogs · JobRunner orchestration · DrainCoordinator        │
 │        │ @app/worker-rpc (typed, transferables, bounded in-flight, abort)      │
 ├────────┼─────────────┬──────────────┬──────────────┬─────────────────────────┤
 │ storage worker │ capture worker │ metrics worker │ index worker │ codec pool 0-3 │
 │ config.db      │ capture.db     │ metrics.db     │ inventory    │ plugin pool 0-2│
 │ data.db        │ blob files     │ prom parsing   │ windows      │ (opt-in)       │
 │ jobs, journal, │ FTS5 ingest    │ hot rings,     │ search index │ decompress,    │
 │ receipts,      │ capture query  │ chunk rollups, │ graph        │ codecs,        │
 │ audit, plans   │ exports        │ alerts, ETA    │ extraction   │ decoders       │
 └───────────────────────────────────────────────────────────────────────────────┘
```

**Rules**
- **The loop owns every broker socket.** Large HTTP bodies are fetched on the loop and streamed chunk by chunk, as transferred `ArrayBuffer`s, to the worker that parses them incrementally. This covers management list pages (up to ~30 MB), Prometheus scrapes (~12 MB per node at 100k queues) and definitions exports. Each broker keeps one Dialer and one tunnel, both in one thread, and large JSON parsing never runs on the loop.
- **Each SQLite file has exactly one owning worker** (single writer, WAL). The loop never imports `node:sqlite` (I-5).
- **Team mode** uses async Postgres pools for the storage role. The capture worker owns its own pool.
- **Workers start lazily and stop when idle.**
  - The capture worker starts on the first capture, the metrics worker on the first metrics demand, and the codec pool on the first decode. The codec pool stops after 60 s idle.
  - An idle desktop runs only the loop and the storage worker. The index worker joins once a broker is open.
- **`@app/worker-rpc`** provides:
  - typed request/response and streaming calls;
  - AbortSignal propagation;
  - transfer lists;
  - a bounded in-flight window.

  A crashed worker is restarted and rehydrated; for example, the index worker reloads the inventory snapshot from data.db.

### 1.3 Desktop (Electron)

```
┌─────────────────────────────── Electron app ──────────────────────────────────┐
│ MAIN (thin, never blocks)                                                     │
│  lifecycle · windows · native menus (from commands-manifest) · tray           │
│  app:// protocol (assets + CSP nonce) · updater (opt-in) · safeStorage async  │
│  powerMonitor · dialogs · notifications · crashReporter (local only)          │
│  EngineSupervisor ──fork──▶ ENGINE utilityProcess ◀──── control port #0       │
│        │ per window: MessageChannelMain #n (renderer ⇄ engine, no main hop)    │
│        ▼                                                                       │
│ RENDERER (sandbox, contextIsolation, no Node) — Angular from app://ui          │
│  preload: PlatformBridge via contextBridge; forwards the engine port          │
│  Web Worker "engine-link": owns the port; HTTP tunnel + live frames           │
└───────────────────────────────────────────────────────────────────────────────┘
 CLI / stdio MCP shim ── Unix socket (0600, dir 0700) or named pipe + token ──▶ engine
```

**Startup**
1. **Main, before `ready`.** Call `app.requestSingleInstanceLock()`. Register the app scheme with `protocol.registerSchemesAsPrivileged([{scheme:'app', privileges:{standard, secure, supportFetchAPI, codeCache}}])`.
2. **`app.whenReady()`.**
   - Register `protocol.handle('app', serveUi)`. This is a static server over the asar that is safe against path traversal, sets a CSP nonce per response and falls back to index.html for SPA routes.
   - Create `BrowserWindow({show:false, webPreferences:{sandbox:true, contextIsolation:true, nodeIntegration:false, preload}})` and load `app://ui/`.
3. **Fork the engine, in parallel.** Forking is allowed only after `ready`.
   - Call `utilityProcess.fork(engine.mjs, [], {serviceName:'<Product> Engine', stdio:'pipe', execArgv:[heap/code-cache flags, spike S-13]})`.
   - Main creates control channel #0 and posts `{t:'boot', mode:'desktop', dirs, appVersion, locale}` together with the port.
4. **Engine boot (target ≤ 800 ms).**
   - Load the bundle. Electron backported snapshot and code-cache boot for utility processes.
   - Start the storage worker.
   - Open config.db, backing it up and migrating it if needed.
   - Load profiles, without secrets.
   - Initialise the Nest app: routes are registered but the app does **not listen** on TCP.
   - Listen on the local socket or pipe for the CLI and MCP.
   - Send `ready`.
5. **On every renderer `did-finish-load`, reloads included.**
   - Main creates a `MessageChannelMain`.
   - It posts `{t:'attach', windowId}` plus port A to the engine, and port B to the renderer with `webContents.postMessage('engine-port', …)`.
   - The preload forwards port B to the page. The app transfers it into the engine-link worker, which sends `hello` and receives `welcome`.
6. **`ready-to-show` → show.** The UI renders the cached workspace (profiles, cached BrokerProfiles and inventory windows, marked stale) and re-probes in the background.

**Secrets.** The engine asks main over control port #0 to wrap or unwrap its DEK with `safeStorage.encryptStringAsync` / `decryptStringAsync`. The renderer has no route to this.

**Shutdown (DC-04, DC-46).** On `before-quit`, main calls `preventDefault()` once and sends `{t:'shutdown', deadlineMs:2000}`. The engine's DrainCoordinator then runs these phases in order:

| Phase | Action | Budget |
| --- | --- | --- |
| 1. Gate | OperationGateway switches to `draining`; new actions get 503 `engine.draining`. LiveHub sends `goaway`. | 10 ms |
| 2. Peeks | `PeekExecutor.abortAll('shutdown')`. For each held set: `nack(lastTag, multiple, requeue)`, then an awaited `basic.qos` barrier, then channel close. For AMQP 1.0: `release()` each delivery, then detach. | 700 ms |
| 3. Jobs | Each running job stops at its next checkpoint. A replay job stops consuming, waits ≤ 500 ms for outstanding confirms, acks the sources whose copies were confirmed, nack-requeues the rest and journals them as `uncertain-duplicate`. | 800 ms |
| 4. Taps and firehose | Cancel tap consumers (tap queues are exclusive and auto-delete). Switch off firehose leases on a best-effort basis; the leases are persisted for reconciliation. | 300 ms |
| 5. Flush | Journal, receipts and logs; WAL checkpoint; close the databases. | 200 ms |
| 6. Exit | `process.exit(0)` | — |

**Escalation.** If the engine is still alive after the deadline plus 1 s, main calls `child.kill()`. That sends SIGTERM on POSIX; from Electron 46 it no longer force-kills. After one more second main sends `process.kill(pid,'SIGKILL')`. The engine also handles SIGTERM itself, using the same coordinator.

**Engine crash and restart**
- **Restart policy.** The supervisor restarts the engine after a non-zero `exit` or an `error` event, with backoff from 250 ms to 8 s. After more than 5 restarts in 60 s it stops and shows a crash screen offering a redacted diagnostics bundle.
- **Peek intents.** Before acquiring messages for a peek, the executor durably writes a **peek intent** (queue, era, cap, startedAt).
- **Crash receipts.** On restart, every unresolved intent produces a **crash receipt** with this wording: "up to N messages were held when the engine died; on this era a connection loss counts as a failed delivery; positions may have changed". DC-04 cannot protect a process that has crashed, so this is the honest fallback.
- **Jobs** resume from their checkpoints after re-planning, which re-runs preflight.

**Renderer crash or reload.** On `render-process-gone`, main recreates the window. The engine keeps running jobs and captures within their budgets. Subscriptions belonging to a dead port are released when its `close` event fires.

**Sleep and resume**
- **`powerMonitor 'suspend'`** sends `{t:'suspend', deadlineMs:1000}`. The engine aborts peeks (nack flush), pauses jobs at a checkpoint, and pauses pollers and taps.
- **`'resume'`**:
  - marks every broker session as suspect;
  - reconnects with jitter;
  - re-probes BrokerProfiles, because maintenance windows change versions;
  - re-plans and resumes jobs;
  - resumes pollers.
- **Clock-jump detector.** The engine compares wall-clock and monotonic time to catch missed events. Local web and team mode rely on this detector alone.

**Windows.**
- Each window has its own port and its own LiveSession.
- With no window open (the macOS convention), the engine keeps running jobs and taps and shows them in the tray.
- Pollers are demand-driven and stop when nothing is subscribed.

### 1.4 Local web

```
browser tab ──HTTP + WS (Bearer launch token)──▶ Node 24 process: engine (local mode)
  http://127.0.0.1:PORT/#token=…                  static UI + REST + /api/v1/live + workers
CLI / stdio MCP shim ──Unix socket / named pipe + token──▶ same process
```
- **Start it** with `npx @<product>/cli@x.y.z serve [--port 0] [--data-dir] [--no-open]`, or with Docker: `docker run -p 127.0.0.1:8765:8765 ghcr.io/<org>/<product>:x.y.z local` (DC-36).
- **Shutdown.** SIGINT and SIGTERM run the same DrainCoordinator (2 s).
- **Sleep and crashes.** The clock-jump detector covers sleep, and crash receipts appear on the next start.
- **Tab lifetime.** Closing the tab does not stop the engine. `--exit-when-idle 10m` is optional.

### 1.5 Team server

```
browsers ─HTTPS─▶ Ingress / Gateway API ─▶ Service ─▶ pod: engine (server mode)
                                                      ├ OIDC BFF, REST, /api/v1/live, /mcp
                                                      ├ shared broker monitors, per-user pools
                                                      ├ JobRunner, AlertRouter, AuditWriter
                                                      └ workers (capture, metrics, index, codec)
  Postgres (state, audit, jobs, metric chunks) · PVC (capture blobs) · KMS / Vault / OpenBao (KEK)
  IdP (OIDC) · brokers and Prometheus endpoints (egress policy + NetworkPolicy)
```

**Startup**
1. Validate the config (zod).
2. Run migrations under a Postgres advisory lock.
3. Acquire the leader lease (an advisory lock).
4. The leader starts monitors, jobs and alert evaluation, and serves traffic. A surge pod waits as standby.

**Probes**
- `/healthz`: the event loop is responsive.
- `/readyz`: this pod is the leader, the database is reachable and migrations are done.
- A startup probe covers slow migrations.

**SIGTERM**
1. Readiness turns false.
2. Live sessions receive `goaway`.
3. The DrainCoordinator runs within 30 s, with the pod's `terminationGracePeriodSeconds: 45`.
4. The lease is released.

**Crash.** Kubernetes restarts the pod. Jobs resume from the Postgres journal. Firehose leases and orphaned taps are reconciled at startup.

---

## 2. Module map (Nx 23.3, pnpm workspaces, no @nx/nest)

### 2.1 Tags
- `scope:` shared · engine · web · desktop · cli · sdk · testing · tooling · deploy
- `type:` contracts · domain · semantics · ports · runtime · service · adapter · app · ui-kit · ui-widget · ui-transport · ui-data · ui-feature · ui-util · preload · sdk · plugin · test-kit · test-suite · test-oracle · tooling
- `platform:` isomorphic · node · browser · electron-main · electron-preload

### 2.2 Projects

**Shared (isomorphic)**

| Project (path) | Tags | Responsibility |
| --- | --- | --- |
| contracts (`libs/shared/contracts`) | scope:shared type:contracts | zod 4 schemas for every resource; `defineOperation`, `defineTopic`; Problem types; ObjectKey helpers; engine and server config schemas (also the source of the Helm `values.schema.json`) |
| domain (`libs/shared/domain`) | scope:shared type:domain | Branded ids, Era, QueueType, EnvironmentClass, Principal, the permission catalogue, `BoundedRing`, `BoundedQueue`, `TokenBucket`, Result |
| live-protocol (`libs/shared/live-protocol`) | scope:shared type:domain | Frame types plus pure state machines for credits, coalescing, sampling and gaps. Used by both LiveHub and engine-link. |
| worker-rpc (`libs/shared/worker-rpc`) | scope:shared type:runtime | Typed RPC over any endpoint shaped like a MessagePort: worker_threads, Web Workers, Electron ports |
| commands-manifest (`libs/shared/commands-manifest`) | scope:shared type:contracts | Command ids, titles and default keybindings, used by the UI palette and the native menus |

**Engine semantics core (pure, isomorphic, no I/O)**

| Project (path) | Responsibility |
| --- | --- |
| semantics-registry (`libs/engine/semantics/registry`) | DC-01 cells; W-* warnings; HZ-* hazards; capability rules (DC-32); peek caps; tap rules; provider presets; framework header registry (shared with the SDK) |
| semantics-era (`…/semantics/era`) | DC-02 resolver |
| semantics-effective-config (`…/semantics/effective-config`) | DC-30 resolver tables and policy matching |
| semantics-routing (`…/semantics/routing`) | Routing simulator: direct, fanout, topic, headers, E2E, AE, DLX, CC/BCC, and probabilistic types |
| semantics-peek-planner, semantics-tap-planner, semantics-replay-planner | Pure planners following b.8, c.1/c.2 and DC-27/28 |
| semantics-lint-rules | DC-56 rules evaluated over snapshots |
| ports (`libs/engine/ports`) | Every port interface (section "core_interfaces_ts") |

**Engine runtime and services (node, `libs/engine/services/<name>`)**

| Project | Responsibility |
| --- | --- |
| runtime | Logger with redaction; config loader; BrokerScheduler (lanes, budgets, AIMD); DrainCoordinator; loop monitor; worker host (piscina 5.3.2) |
| actions | OperationGateway, PlanStore, guardrails, consent and approval checks, receipt glue (DC-42) |
| live | LiveHub, topic registry, TunnelServer |
| connections | Profiles, BrokerSessions, ConnectionManager (connection roles and budgets, DC-11/12) |
| identity | CredentialProviders, TokenManager, OAuth discovery with issuer pinning (DC-37..39) |
| probe | Capability probe producing a BrokerProfile (DC-31, sequence j.2) |
| inventory | Sweeps, snapshots, windowed queries, search (host of the index worker) |
| peek | Preflight, PeekExecutor, rescue, receipts, peek intents |
| tap | TapSession, binding re-sync, orphan sweep, FirehoseController (DC-17..20) |
| capture | Capture sessions, queries, exports, body chunk reads |
| publish | Publish with confirms and `mandatory`; templates |
| dlq | DLQ discovery, decoding, fingerprint groups, replay jobs, undo (DC-27..29, DC-54) |
| streams | Stream read planner and anonymous readers (DC-22/23/26) |
| topology | Graph extraction, subgraphs, routing simulation over live data |
| admin | CRUD, including vhost GET-merge-PUT (DC-21); definitions; feature flags; health checks; QQ replica operations |
| metrics | Glue for the ScrapePlanner; fallback sampling via the management API; forecasts |
| alerts | Rules, evaluation, routing, silences |
| lint | Advisor runs and fix plans (DC-56) |
| topology-code | Export, normalise, diff, plan, apply |
| jobs | JobRunner, JobStore, journal |
| audit | AuditLog writer, query and chain verification |
| authz | PolicyEngine (RBAC), role bindings, approvals |
| secrets | SecretVault over the backend adapters |
| mcp | MCP server; tools and resources generated from operations |
| plugins | Plugin registry, loader, worker pools |

**Adapters (node, `libs/engine/adapters/<name>`)**

| Adapter | Built on and responsibilities |
| --- | --- |
| mgmt-http | undici and zod (DC-48): golden fixtures per broker version, stats-off quirks (DC-32), product-aware `/get` (DC-55), streaming bodies |
| amqp091 | amqplib 2.2.0, exactly |
| amqp10 | rhea 3.0.5, exactly (DC-22..25) |
| stream | rabbitmq-stream-js-client 1.1.0; optional and behind a flag |
| prometheus | Streaming text parser that runs in the metrics worker; target discovery |
| dialer | Direct, SOCKS5 (socks 2.8.10), HTTP CONNECT, ssh2 1.17.0, system `ssh -W`, Kubernetes port-forward; egress policy; local Unix-socket forwarders |
| truststore | `tls.setDefaultCACertificates`; per-profile TLS contexts; diagnostics |
| k8s | @kubernetes/client-node 2.0.0: RabbitmqCluster discovery and Topology Operator ownership |
| oidc | openid-client 6.8.8 |
| persistence-sqlite | Kysely 0.29.6 with an in-repo node:sqlite dialect; better-sqlite3 13.0.3 as fallback |
| persistence-pg | Kysely and pg 8.23.1 |
| blobstore-fs | Blob storage on the local filesystem |
| secrets-electron, secrets-keyring, secrets-passphrase, secrets-envelope | Secret storage backends: Electron, OS keyring, passphrase, envelope encryption |
| notify | Desktop notification bridge; webhook, Slack, Teams, Alertmanager, SMTP |

**Apps**

| App | Tags | What it is |
| --- | --- | --- |
| engine | type:app scope:engine platform:node | Nest composition root, generated controllers, tunnel, WS and socket listeners, worker entrypoints |
| web | type:app scope:web platform:browser | Angular 22 shell |
| desktop | type:app scope:desktop platform:electron-main | Electron main process |
| cli | type:app scope:cli platform:node | `@<product>/cli` |

**Web libraries (browser)**

| Library | Tags | Contents |
| --- | --- | --- |
| `libs/web/ui-kit` (`@app/ui`) | type:ui-kit | Spartan helm copies, tokens, Tailwind 4 preset, Aria wrappers |
| `libs/web/widgets/{grid,graph,flow,editor,charts,payload}` | type:ui-widget | One widget per third-party library (see 2.4) |
| `libs/web/transport` | type:ui-transport | EngineTransport, engine-link worker, LiveClient, EngineHttpBackend, bridge clients |
| `libs/web/api-client` | type:ui-data | Generated by Orval and committed |
| `libs/web/data-access/<domain>` | type:ui-data | Data access per domain |
| `libs/web/features/<domain>` | type:ui-feature | Lazy routes |
| `libs/web/commands` | type:ui-util | CommandRegistry, KeybindingService |

**Desktop libraries**

| Library | Tags |
| --- | --- |
| `libs/desktop/preload` | type:preload platform:electron-preload |
| `libs/desktop/bridge-contract` | type:contracts platform:isomorphic |
| `libs/desktop/engine-supervisor` | type:runtime platform:electron-main |

**SDK and plugins**
- `libs/sdk/decoder-sdk` (type:sdk) is published as `@<product>/decoder-sdk`.
- `plugins/first-party/*` (type:plugin) depend on the SDK only.

**Testing and tooling**
- **Test kits:** `testing/broker-lab`, `testing/fixtures`, `testing/fakes` (test-kit).
- **Test suites:** `testing/{conformance, e2e-web, e2e-desktop, e2e-team, perf, chaos, visual}` (test-suite).
- **Oracle:** `testing/oracle-amqp10` (test-oracle; DC-24).
- **Tooling:** `tools/{generators, eslint-rules, supply-chain, codegen}` (tooling).

### 2.3 Dependency rules (`@nx/enforce-module-boundaries` depConstraints)

| Source | May depend on |
| --- | --- |
| type:contracts | Nothing except `zod` and `@standard-schema/spec` |
| type:domain | contracts |
| type:semantics, type:ports | domain, contracts |
| type:runtime | ports, domain, contracts |
| type:service | ports, semantics, runtime, domain, contracts. Never adapters. Other services only through their exported facade. |
| type:adapter | ports, semantics (read-only data), runtime, domain, contracts |
| engine app | Any scope:engine or scope:shared project |
| type:sdk | contracts and domain (types only) |
| type:plugin | sdk |
| type:ui-feature | ui-data, ui-kit, ui-widget, ui-util, contracts (types only) |
| type:ui-data | api-client, ui-transport, contracts |
| type:ui-transport | live-protocol, worker-rpc, contracts, bridge-contract |
| type:ui-widget | ui-kit, ui-util |
| desktop app | engine-supervisor, bridge-contract, commands-manifest, contracts (types) |
| type:preload | bridge-contract |
| test-* | Anything; never imported by non-test projects |

Platform rules:
- `platform:browser` and `platform:node` never import each other.
- Electron main never imports engine services; the engine is a separate bundle.

### 2.4 Third-party confinement (`no-restricted-imports` plus lockfile checks)

| Package | Only in |
| --- | --- |
| amqplib | adapters/amqp091 |
| rhea | adapters/amqp10 (and testing/oracle-amqp10, pinned through overrides) |
| rabbitmq-stream-js-client | adapters/stream |
| undici | adapters/mgmt-http, prometheus, dialer, notify |
| node:sqlite, better-sqlite3 | adapters/persistence-sqlite (worker entrypoints only) |
| pg | adapters/persistence-pg |
| ssh2, socks, @kubernetes/client-node | adapters/dialer, adapters/k8s |
| openid-client | adapters/oidc |
| @napi-rs/keyring | adapters/secrets-keyring |
| @nestjs/*, fastify (5.12.5 only, via platform-fastify), ws | apps/engine |
| electron | apps/desktop, libs/desktop/* |
| ag-grid-community, ag-grid-angular | widgets/grid |
| cytoscape, @dagrejs/dagre, elkjs (unmodified worker asset, DC-51) | widgets/graph |
| @foblex/flow | widgets/flow |
| monaco-editor | widgets/editor |
| uplot, echarts, ngx-echarts | widgets/charts |

**Banned everywhere:**
- `primeng>=22`, `@primeui/*`, `ag-grid-enterprise`, `apexcharts`;
- `@types/amqplib`, `typescript@7`;
- `rabbitmq-amqp-js-client`, except in the oracle project;
- any dependency resolved from a git URL (DC-24, DC-49, DC-50).

### 2.5 Generators: the agent's primary interface

All generators live in `tools/generators`:

| Generator | Produces |
| --- | --- |
| `operation` | Contract, handler stub, generated controller, tests, MCP exposure, docs stub |
| `live-topic` | Topic definition, source stub, protocol test |
| `adapter` | Port implementation skeleton, contract test |
| `service` | Facade, Nest wiring module |
| `feature` | Angular lazy route, data-access store, Storybook story, harness test |
| `semantics-cell` | Registry cell plus a conformance test skeleton with the same CT id |
| `lint-rule` | Lint rule with fixtures |
| `decoder` | Plugin package against the SDK, with a fixture corpus |
| `migration` | Dialect-portable migration with a test that runs on both dialects |
| `conformance-test` | Conformance test skeleton |

Every project has a README listing its purpose, public API, invariants and the commands that prove it works. Targets are uniform: `lint`, `typecheck`, `test`, `test-integration` (Linux, Docker) and an optional `bench`.

---

## 3. API and transport

### 3.1 Contract model

- **Operations.** Every operation is a `defineOperation({...})` record in `libs/shared/contracts/src/ops/<domain>/*.op.ts`. A record holds:
  - id, method and path;
  - zod input and output schemas;
  - `effect` (read, side-effect, mutation or destructive);
  - `permission`, `capabilities` and `planning` (none, optional or required);
  - `audit`, `idempotency` and `lane` (interactive or bulk);
  - `timeoutMs`, `mcp` exposure and docs.
- **Topics.** Every live topic is a `defineTopic({...})` record with a params schema, an item schema, a QoS, a permission and rate caps.
- **Object keys (ADR-027).** Path segments that identify broker objects are an opaque `ObjectKey` = base64url(utf8(vhost) + NUL + utf8(name)). Proxies, ingresses and the tunnel treat `%2F` differently, so names never appear raw in paths.
- **Planned effects.** Side effects are planned through domain plan resources and executed through one generic endpoint:
  - `POST /api/v1/brokers/{pid}/queues/{qkey}/peek-plans` returns a `PlanEnvelope`. The same pattern applies to `tap-plans`, `publish-plans`, `purge-plans`, `replay-plans`, `topology-plans`, `delete-plans` and `feature-flags/{name}/enable-plans`.
  - `GET /api/v1/plans/{planId}` returns the plan.
  - `POST /api/v1/plans/{planId}/execute {consents, approvals}` returns an `ActionResult`: `done` (with receipt), `job` or `pending-approval`.
- **Plans required by environment.** A low-risk mutation (for example, creating a queue in a dev environment) may execute directly. If the environment policy requires a plan, the call returns `428 plan.required` with a link to the plan.

### 3.2 Resource catalogue (abridged; all under `/api/v1`)

| Group | Representative endpoints | Effect |
| --- | --- | --- |
| System | `GET system/info`, `GET system/health`, `POST system/diagnostics` (redacted bundle, job) | read |
| Profiles | `GET/POST profiles`, `GET/PUT/DELETE profiles/{pid}`, `POST profiles/{pid}/tests` | mutation (local state) |
| Broker session | `PUT/DELETE brokers/{pid}/session`, `GET brokers/{pid}/profile` (BrokerProfile), `POST brokers/{pid}/profile/refreshes`, `POST brokers/{pid}/probes/{probeId}` (write-shaped, on demand) | read / side-effect |
| Inventory | `POST brokers/{pid}/inventory/queries` (window), `POST brokers/{pid}/search`, `GET brokers/{pid}/queues/{qkey}`, `…/exchanges/{xkey}`, `…/queues/{qkey}/bindings`, `…/queues/{qkey}/consumers`, `…/queues/{qkey}/effective-config` | read |
| Topology | `GET brokers/{pid}/topology/graph?focus=&depth=&limit=`, `POST brokers/{pid}/routing/simulations` | read |
| Plans | `GET plans/{id}`, `POST plans/{id}/execute` | per plan |
| Captures | `GET captures`, `POST captures/{cid}/queries`, `GET captures/{cid}/messages/{mid}`, `GET blobs/{ref}?offset=&length=`, `POST captures/{cid}/exports` (job), `DELETE captures/{cid}` | read / local mutation |
| Taps and firehose | `POST brokers/{pid}/tap-plans`, `GET taps`, `DELETE taps/{id}`, `POST brokers/{pid}/firehose-plans`, `DELETE firehose-leases/{id}` | side-effect (admin for firehose) |
| Publish | `POST brokers/{pid}/publish-plans`; `GET/POST/PUT/DELETE templates` | mutation |
| DLQ | `GET brokers/{pid}/dlqs`, `POST brokers/{pid}/dlqs/{qkey}/analyses` (job), `GET analyses/{id}/groups`, `POST brokers/{pid}/replay-plans`, `POST jobs/{id}/undo-plans` | read / destructive |
| Streams | `POST brokers/{pid}/streams/{skey}/reads`, `GET stream-reads/{rid}/pages?cursor=`; live topic `stream.tail` | read (non-destructive) |
| Admin | Create queues, exchanges and bindings; `PUT …/policies/{key}`; vhosts (GET-merge-PUT); users; permissions; topic permissions; limits; parameters; feature flags; definitions export and import (job); health checks; QQ replica ops; rebalance; client-connection close | mutation / destructive |
| Metrics and alerts | `POST metrics/queries`, CRUD on `alert-rules`, `GET alert-events`, `notification-routes` (team) | read / mutation |
| Lint and topology-as-code | `POST brokers/{pid}/lint-runs` (job), `GET lint-runs/{id}/findings`, `POST brokers/{pid}/topology/exports`, `POST topology/diffs`, `POST brokers/{pid}/topology-plans` | read / mutation |
| Jobs | `GET jobs`, `GET jobs/{id}`, `GET jobs/{id}/journal?cursor=`, `POST jobs/{id}/commands {pause, resume, cancel}` | mutation |
| Team | `team/users`, `team/roles`, `team/role-bindings`, `team/approvals`, `team/catalog`, `team/api-tokens`, `team/settings`, `audit/events`, `audit/exports` | team only |
| Auth (team) | `auth/login`, `auth/callback`, `auth/logout`, `auth/session`, `live/tickets` | — |
| MCP (team) | `/mcp` (Streamable HTTP), `/.well-known/oauth-protected-resource` | per tool |

### 3.3 Live protocol (one multiplexed channel per UI session)

**Client to engine frames**
- `hello {protocol:1, client, resume?}`
- `sub {sid, topic, params, credit, opts:{maxHz, maxBatch, sampling}}`
- `credit {sid, n}`, `unsub {sid}`, `ping`
- `http.req` and `http.abort` (MessagePort only)

**Engine to client frames**
- `welcome {sessionId, limits}`
- `subok {sid, qos, snapshot?}`
- `data {sid, seq, items[], dropped?, sampledEvery?}`
- `state {sid, live|paused|stalled|degraded|ended}`
- `gap {sid, fromSeq, toSeq, reason}`
- `error {problem}`, `pong`
- `goaway {reason}`
- `http.res` and `http.chunk`

**Flow control**
- Each `data` frame consumes one credit. The client grants credits as it consumes frames; the default window is 8.
- The engine keeps a bounded outbox per subscription (items and bytes) and coalesces or samples by topic QoS:
  - `lossless`: never dropped. If the outbox fills, the session degrades to a `gap` and a snapshot resend.
  - `latest`: coalesced by key.
  - `sampled`: every-nth or time-bucket sampling, with drop counters.
- Sessions survive transport loss for 30 s. A `hello{resume}` restores the subscriptions; lossless topics resume from `seq`, and the others resend a snapshot.

**Session limits:** 64 subscriptions, an 8 MiB outbox and a 1 MiB maximum frame.

| Topic | QoS | Default cap |
| --- | --- | --- |
| `inventory.window` (visible keys only) | latest per key | ≤ 2 Hz |
| `inventory.snapshot` (version bumps) | lossless | on change |
| `object.detail` | latest | ≤ 1 Hz (single-object poll every 5 s while visible) |
| `metrics.series` | latest per key | ≤ 1 Hz |
| `tap.messages` (summaries + 16 KiB preview) | sampled | ≤ 10 frames/s, ≤ 500 items or 1 MiB per frame |
| `tap.stats` | latest | 1 Hz |
| `stream.tail` | sampled, credit-bounded (DC-25) | ≤ 10 frames/s |
| `jobs.progress` | latest per job; terminal state lossless | ≤ 4 Hz |
| `alerts.events`, `approvals.inbox`, `broker.status` | lossless | on change |
| `audit.tail` (team) | lossless, bounded, `gap` on overflow | — |

**Encoding.**
- On MessagePort, frames are structured-cloned objects with `Uint8Array` payloads; there is no JSON step.
- On WebSocket, frames are JSON text. A binary envelope `bin1` (4-byte header length, JSON header, then raw byte segments) is reserved behind a feature flag for `tap.messages`, and will be enabled only if perf shows JSON preview cost matters.

### 3.4 One contract over three transports

```
                    libs/shared/contracts (operations + topics, zod 4)
                       │ generates
       ┌───────────────┼─────────────────────────────┬────────────────────────┐
       ▼               ▼                             ▼                        ▼
 Nest controllers   OpenAPI 3.1 + AsyncAPI 3     Orval Angular client      MCP tool defs
 (generated)                                     HttpClient → HttpBackend
       │                                                   │
       ▼                                                   │ desktop: EngineHttpBackend
 Fastify router ◀─ app.inject() ◀─ TunnelServer ◀─ MessagePort ◀─ engine-link worker
       ▲                                                   │ web/team: FetchBackend
       ├──── HTTP on 127.0.0.1 / behind ingress ◀──────────┘
       └──── HTTP on Unix socket / named pipe ◀──── CLI, stdio MCP shim
 LiveHub ◀── frames ◀── MessagePort (desktop) | WebSocket /api/v1/live (web, team, socket)
```

**Engine side**
- **One Fastify instance, through NestJS.** A `serverFactory` shares Fastify's request handler between the TCP server (local and team modes) and the socket/pipe server (all modes). On the desktop the TCP server never listens.
- **The TunnelServer** maps each `http.req` frame to `app.inject({method, url, headers, payload, remoteAddress})`:
  - Responses larger than 1 MiB use light-my-request's `payloadAsStream` and are sent as `http.chunk` frames.
  - Request bodies may be streams.
  - `http.abort` triggers the operation's AbortController.
- **Header hygiene.** The tunnel strips incoming `authorization`, `cookie`, `x-forwarded-*` and `host`. It then sets `x-<product>-tunnel: <per-process secret>`, which the renderer never sees. The edge hook trusts the port-bound principal only when that header is present.
- **The WebSocket server** is `ws` 8.22.0 with `noServer` on the HTTP `upgrade` event. Auth and Origin checks run before the upgrade completes.

**UI side**
- `EngineHttpBackend implements HttpBackend` is used on the desktop. It supports progress events, abort, and chunked bodies through engine-link.
- In web and team mode, the stock FetchBackend is used, with an auth interceptor:
  - local web sends the Bearer launch token;
  - team mode uses a cookie plus `X-CSRF-Token`.
- The Orval-generated services are identical in every mode.

### 3.5 Evaluation: DC-35 MessagePort vs loopback HTTP/WS for the desktop

| Criterion | MessagePort (MessageChannelMain) | Loopback HTTP + WS |
| --- | --- | --- |
| Attack surface | No listener: no DNS rebinding, CSRF, cross-site WS hijack or port squatting. Chrome's Local Network Access is disabled in Electron anyway. | Needs a 256-bit token, an exact Host allow-list, `app://` Origin checks, Sec-Fetch checks and token transport for WS. One mistake exposes the broker credentials of a local user. |
| Path | Renderer to utilityProcess directly, via Mojo; no hop through main | Through the TCP stack |
| Serialisation | Structured clone; Uint8Array without base64 | HTTP and JSON framing |
| Backpressure | None at the transport level. **Requires credits** (we need them anyway). | `bufferedAmount` is available |
| Debuggability | Not visible in devtools' Network panel. A dev-only Transport Inspector panel compensates. | Visible in devtools |
| Lifecycle | Ports must be re-wired on reload and per window; MessagePortMain emits `close` | Reconnect on reload |
| Parity with web mode | Achieved by tunnelling the same router (3.6) | Native |

**Decision: MessagePort (binding DC-35).** No loopback listener exists in desktop builds, so the desktop renderer CSP can be `connect-src 'self'`, meaning `app:` only.

### 3.6 Evaluation: tunnel the REST router vs a separate RPC protocol

| Criterion | HTTP-over-MessagePort (`fastify.inject` + custom HttpBackend) | Separate RPC (oRPC, or a custom op-id RPC) |
| --- | --- | --- |
| Behavioural parity | Byte-identical: same routing, validation, guards, Problem mapping and logs | Second dispatcher; validation and error mapping duplicated |
| Client | Orval Angular services unchanged | Second client or adapter |
| Cost | light-my-request adds ~tens of µs per call (S-02 measures it). REST traffic is low-volume. | Slightly lower per call |
| Streaming | `payloadAsStream` + `http.chunk`; exports go engine → file directly on the desktop | Native in some libraries |
| Agent ergonomics | One way to add an endpoint | Two |
| Security | Must strip and override headers (3.4) | Own auth path |

**Decision: tunnel.** The live protocol is shared by every transport anyway. REST remains the public API for the CLI, automation and MCP.

### 3.7 End-to-end flow control (example: a tap at 10k msg/s)

```
[1 broker]  tap queue: x-max-length 10k, x-overflow drop-head, x-message-ttl 60 s   (bounds broker memory, never blocks publishers)
[2 consumer] prefetch ~1000 (global=false), batched multi-ack every 100 msgs / 50 ms (bounded in-flight)
[3 engine]   capture ring N msgs / B bytes → capture worker batches ≤ 5 ms per txn
             under pressure drop in this order: FTS indexing → body persistence (keep metadata) → sample
[4 session]  per-subscription outbox (items+bytes) + sampling to ≤ maxHz; credits from UI
[5 UI]       engine-link worker ring (20k summaries) → main thread ≤ 10 batches/s, applyTransactionAsync
```

- Every stage exports `received`, `dropped`, `sampledEvery` and `bytes` into `tap.stats` and the session's receipt.
- Saturation is detected by polling the tap queue's `messages` against `x-max-length` and is shown as "broker dropping oldest (drop-head)".

### 3.8 Error model

- **Format.** RFC 9457 `application/problem+json` with stable `code`s from a registry in contracts:
  - `type` is `https://<product-domain>/problems/<code>`;
  - extension members are `code`, `traceId`, `retryable`, `gates[]`, `missingPermission`, `capability` and `source`, and `brokerError {protocol, classId, code, text}` (sanitised).
- **Standard codes:**
  - `400 validation.failed`
  - `401 auth.required`
  - `403 authz.denied` (with `missingPermission` and the "why")
  - `404 not.found`
  - `409 plan.stale` (preflight changed; re-plan)
  - `412 capability.disabled` (with reason and source link, DC-31)
  - `422 gate.blocked` (with `gates[]`)
  - `428 consent.required` or `428 plan.required`
  - `429 budget.exceeded` (connection or poll budget, with `retryAfterMs`)
  - `502 broker.error`
  - `503 broker.unreachable` or `503 engine.draining`
  - `504 broker.timeout`
- **Broker errors** are normalised by adapters into AMQP class/code (for example 405 RESOURCE_LOCKED, 406 PRECONDITION_FAILED, 540 NOT_IMPLEMENTED, 320 CONNECTION_FORCED) and mapped to Problem codes in a table that lives in the registry.

### 3.9 Versioning

- **REST.** Paths use `/api/v1`. Changes within v1 are additive only. The OpenAPI snapshot `libs/shared/contracts/openapi/v1.json` is committed, and CI runs `oasdiff breaking` against it. Breaking changes require `/api/v2` or a two-minor-release deprecation window.
- **Live protocol.** `protocol: 1` plus `features[]` are negotiated in `hello` and `welcome`.
- **UI and engine skew.**
  - Desktop and local web ship together, so the versions must match exactly; otherwise `goaway version-mismatch`.
  - In team mode, a server version change triggers a UI reload prompt.
- **Other versioned contracts.**
  - The plugin API has an integer `apiVersion`; the engine supports N and N-1.
  - The semantics registry uses a calendar version (`2026.10.0`) that is stamped into every receipt.
  - The product uses SemVer.

### 3.10 Generation pipeline (all deterministic, all in CI)

1. `nx run engine:openapi` builds the generated controllers and emits OpenAPI 3.1 without starting any broker connection. It uses @nestjs/swagger 12.0.2's `standardSchemaConverter` backed by `z.toJSONSchema`; nestjs-zod is not used (DC-49).
2. `nx run codegen:asyncapi` emits AsyncAPI 3.0 from the topic registry, with zod converted to JSON Schema.
3. `nx run api-client:generate` runs Orval 8.43.0, pinned exactly, with `httpClient` for mutations and `httpResource` for reads. The output is committed, and CI fails if it is stale.
4. The registry exports JSON for the docs, the website compatibility matrix and the MCP tool descriptions.

---

## 4. Engine framework choice

### 4.1 Options

| Option | Pros | Cons |
| --- | --- | --- |
| **NestJS 12.1.3 on platform-fastify** (fastify 5.12.5) | Agents recognise its modules, DI, guards and interceptors; Standard Schema `@Body({schema})`; @nestjs/swagger 12 converter; `app.inject` | New ESM major (Aug 2026): ecosystem lag (nestjs-zod, @nx/nest). Cold start unmeasured (budget ~400 ms). Agents' training data is mostly Nest ≤ 11 CJS. Reflection metadata does not bundle with esbuild. |
| Fastify 5 only + own composition root | Fastest start, smallest surface; routes generated from the registry; `inject` native | We own DI conventions, guards and plugin layout; fewer agent priors |
| Hono / oRPC | Small and modern; oRPC has MessagePort adapters | Second ecosystem; Angular client story weaker; oRPC Nest integration in beta |

### 4.2 Decision: NestJS 12 at the edge, framework-free core

- **Nest's scope.** Nest provides HTTP routing, DI wiring, Standard Schema validation, OpenAPI and lifecycle hooks.
- **The core is plain TypeScript.** Services, adapters, semantics and planners take ports through their constructors. Nest modules in `apps/engine/src/modules` only bind ports to adapters with `useFactory`.
- **Controllers are generated** from the operation registry. Each one is about five lines: validate, resolve the principal, call `gateway.query/plan/execute`.
- **Nest guards** only resolve the transport-level Principal. Authorisation, guardrails and audit live in the framework-free OperationGateway, because MCP and jobs call it in-process (I-2).
- **No `emitDecoratorMetadata`.** All injections use explicit tokens (`@Inject(MGMT_HTTP)`), enforced by lint. Validation uses explicit schemas, so no reflection is needed. This lets esbuild bundle the engine into one file, which matters for cold start.
- **Exit criterion (spike S-01).**
  - Measure: engine cold start to `ready` in an Electron 45 utilityProcess. The limit is ≤ 400 ms p95 for the framework part on the reference Windows laptop.
  - Measure: ESM bundling works.
  - If either fails, the generator emits Fastify route registrations from the same registry instead of Nest controllers. The core does not change, and we estimate about a week of work.

### 4.3 Module structure

- **One Nest module per bounded context:** `ConnectionsModule`, `InventoryModule`, `PeekModule`, `TapModule`, … , `McpModule`.
- **Global providers:**
  - the request-id interceptor;
  - the Problem filter;
  - the logging interceptor (with redaction);
  - the transport-auth guard.
- **Mode modules** (`DesktopModule`, `LocalModule`, `ServerModule`) select adapters: persistence, secrets, notify, egress policy, authz.
- **Tokens** are exported from `libs/engine/ports` (`export const MGMT_HTTP = Symbol('MgmtHttpPort')`).

### 4.4 How an agent adds an endpoint

Example: purge, a destructive and planned operation.

```
pnpm nx g @app/generators:operation queues.purge --effect=destructive --permission=message.purge \
  --planning=required --mcp=expose-disabled --lane=interactive
```

**What the generator creates or updates**
1. **Contract.** `libs/shared/contracts/src/ops/queues/purge.op.ts` holds the zod input, plan and output schemas plus `defineOperation({...path:'/api/v1/brokers/:profileId/queues/:queueKey/purge-plans'})`, and is registered in the ops index.
2. **Handler.** `libs/engine/services/admin/src/queues/purge.handler.ts` exports an `OperationHandler<PurgeInput, PurgePlan, PurgeResult>` with `plan()` and `execute()` stubs that throw `NotImplemented`.
3. **Controller.** The generated region in `apps/engine/src/http/generated/queues.controller.ts`.
4. **Tests.**
   - `purge.handler.spec.ts`, using fakes from `testing/fakes`;
   - a schema round-trip test;
   - a skipped E2E spec in `testing/e2e-web/specs/queues/purge.spec.ts`;
   - a docs stub.
5. **Regeneration.** The generator refreshes the OpenAPI snapshot and the Orval client.

**Acceptance**
- `pnpm nx affected -t lint,typecheck,test` is green.
- `pnpm nx run engine:openapi-check` reports no breaking diff.
- `pnpm nx run api-client:generate --check` is clean.
- The architecture test confirms the route goes through the gateway.

Agents then implement `plan()`/`execute()` until the generated tests pass.

---

## 5. Message-safety layer

### 5.1 Era resolution and the semantics registry (DC-01, DC-02)

**Registry data**

The data lives in `libs/engine/semantics/registry/src/data/*.data.ts` as typed constants, validated by zod at build:

| File | Contents |
| --- | --- |
| `settle-matrix` | b.2 cells: era × queue type × protocol × action × limit state |
| `counters` | b.1 |
| `dlx-carryover` | b.4 |
| `delayed-retry` | b.5 |
| `hazards` | Known-bug table with affected semver ranges |
| `capabilities` | Version, flag, stats-mode and provider predicates (DC-32) |
| `warnings` | W-* with severity, i18n key and text version |
| `peek-caps` | b.8 step 3 |
| `tap-rules` | c.1/c.2 |
| `provider-presets` | j.1 |
| `effective-config` | k.3 |
| `framework-registry` | Section l |

**Rules for cells**
- Every cell carries `citations[]`, `conformance[]` (CT ids) and `status` (`code-derived`, `lab-verified` or `lab-contradicted`).
- A unit test fails if any cell lacks a citation, or references a CT id that does not exist in `testing/conformance`.

**Era resolver.** `resolveEra()` implements b.8 step 1 exactly:
- any node below 4.0 → 3.13;
- any node below 4.3, or the `rabbitmq_4.3.0` flag not enabled, or any QQ member Machine Version below 8, or an unknown or commercial build → 4.0-4.2;
- all nodes at 4.4 or above → 4.4;
- otherwise → 4.3.

**Canary (team only).** An opt-in canary QQ test (get + nack twice) runs only on team servers, and only with admin consent.

### 5.2 Connections and port-level safety (DC-11, DC-12)

| Role | Protocol | Use | Rules |
| --- | --- | --- | --- |
| control | HTTP pool; AMQP only if needed | Metadata, admin | Never holds messages |
| peek | AMQP 0-9-1 (1.0 opt-in on 4.3+) | Peek jobs | ≤ 1 in-flight job per connection; never publishes; heartbeat 30 s; fresh channel per job; throwaway channels for risky calls |
| publish | 0-9-1 confirm channels | Publish, replay, rescue copies | Confirms + `mandatory`; one channel per job; `connection.blocked` surfaced |
| consume | 0-9-1, 1.0 or stream | Taps, stream reads, replay source | One consumer per channel (Amazon MQ allows 10 per channel); bounded prefetch or credit |

**Budgets**
- Budgets come from `BrokerProfile.limits` plus provider presets (for example, CloudAMQP shared allows 20 connections).
- Default allocation: the control HTTP pool, plus one peek, one publish and one consume connection, growing to configured maxima per role.
- When a budget is exhausted, work is queued (jobs) or gets `429 budget.exceeded` with an ETA.
- Connection names follow `<product>/<mode>/<role>/<user-or-session>`; in team mode this carries the user id.

**Type-level safety in the ports** (see core_interfaces_ts):
- `nack()` accepts only `requeue: true`. Reject and requeue=false cannot be expressed (DC-03).
- `ack()` requires either a `ConfirmedCopyProof`, obtained only from a confirmed publish, or a `DestructiveConsentProof`, obtained only from an executed destructive plan.
- `qos()` is awaited and acts as the barrier (DC-04).
- AMQP 1.0 receivers are always `creditMode:'manual'`, which means `credit_window 0` and no auto-accept or auto-settle (DC-25). `release()` is the only return outcome. `detach()` throws if any delivery is still unsettled.
- There is no `get()` for queues of type stream: the planner never routes there, and the adapter asserts it (DC-11).

### 5.3 Peek planner (pure, DC-05..16)

**Inputs**
- `PeekRequest`
- `BrokerProfile`
- `PreflightSnapshot`, gathered over HTTP only. It covers the b.8 step 2 checks: type, exclusivity and owner, `auto_delete`, the real `delivery_limit` stat, DLX/DLQ topology, delayed retry, length limits and overflow, TTL, SAC and active consumers, QQ quorum and leader, average size and alarms.
- The output of the effective-config resolver.
- The registry.
- The principal.

**Outputs.** Either a `PeekPlan` or a refusal with gates.

| Queue / era | Method | Settle | Caps (default / max) | Notable gates |
| --- | --- | --- | --- | --- |
| CQ, all eras | 0-9-1 `basic.get` × n | one `nack(lastTag, multiple, requeue)` + `basic.qos` barrier + channel close | 20 / 500, 16 MiB | exclusive (refuse), SAC (W-SAC-CQ), drop-head ≥ 90 % (W-DROPHEAD), TTL; on 4.3+ the watchdog is mandatory |
| QQ 3.13 | `basic.get` × n | nack (≡ reject, DC+1) | 20 / 50 | always confirm (W-313); W-TAIL if unlimited; `x-delivery-limit=-1` → refuse (DC-16) |
| QQ 4.0-4.2 | `basic.get` × n over 0-9-1 (AMQP 1.0 cannot see AC) | nack (counts) | 20 / 50, admin 200 | budget consent showing L and attempts (W-BUDGET, DC-08); no auto-refresh; W-TAIL if L = -1 |
| QQ 4.3+ | `basic.get` × n; SAC queues only via a consumer when no consumer is active, with `x-consumer-timeout` = abort budget; opt-in AMQP 1.0 credit N + drain + released | nack / released only | 20 / 500, 16 MiB | W-OVERLIMIT blocks by default (DC-07, one-click policy fix); W-DELAY (DC-14) |
| Stream | Stream browser (5.7), never `get` | credit only | by count, bytes, time | info only |
| HTTP fallback | `/get` with `ack_requeue_true` (+ `"requeue":true` on LavinMQ), count ≤ 50, truncate | server-side | 20 / 50 | not offered if over-limit messages are possible (DC-10, DC-55) |

**Hold budget**
- `hardAbort = min(30 s, TTL/4, QQ consumer timeout/4 on 4.3+, channel timeout − 90 s on ≤ 4.2)`.
- `target = min(5 s, hardAbort)`.

**Depth.** The planner also derives `count ≤ target / measuredRtt`.
- amqplib serialises synchronous methods per channel. This is code-level and to be verified.
- For high-RTT links it may plan up to 4 parallel channels. It never does this on SAC queues or where ordering matters.
- The UI states honestly that a peek shows the **head N ready messages**. Deeper inspection needs one of: a stream; the CLI `rabbitmq-queues peek` runbook or the optional node agent (post-v1); or an explicit destructive consume-to-capture job.

**Guard and rescue (DC-09)**
- Acquisition always stops at the first doomed message. A message is doomed when:
  - 4.3+: DC > L;
  - 4.0-4.2: AC ≥ L;
  - 3.13 with a limit: DC ≥ L.
- The rescue option for that message is chosen before the peek:
  - **(A) let the broker handle it.** Forbidden when `principal.unattended`.
  - **(B) quarantine.** Publish a copy with confirms on the publish connection to a durable classic quarantine queue (default `<prefix>.quarantine`, created with consent), then ack the original with the proof.
  - **(C) raise the limit.** Admin only. Write the policy through the gateway, wait until the `delivery_limit` stat shows it, then nack. On 4.0-4.2 the new limit must be finite.
- If no rescue option is permitted, the planner refuses any QQ with a finite L.

### 5.4 Peek executor

```
execute(plan, consents, signal):
  verify planHash, expiry, consents ⊇ plan.consentsRequired, gateway state == accepting
  lease = connections.lease(profile, 'peek')               // ≤1 in-flight job per peek connection
  await journal.peekIntent(plan)                            // durable before acquire (crash receipts)
  ch = await lease.amqp091.channel()                        // fresh; no passive declares on it
  wd = watchdog(plan.hold.hardAbort)                        // I/O-loop timer; I-5 SLO protects it
  loop while held < count, bytes < maxBytes, elapsed < target, !wd.fired, !signal.aborted:
     d = await ch.get(queue)                                // noAck=false
     if !d → stoppedBy='empty'; break
     copy = captureCopy(d)                                   // typed headers; body → blob; preview
     if guard.doomed(d): applyRescue(plan.rescue, d) ; stoppedBy='guard'; break
  finally (always, including watchdog/abort/shutdown):
     ch.nack(lastUnackedTag, {multiple:true, requeue:true})
     await ch.qos(0)                                         // synchronous barrier (DC-04)
     await ch.close()
     receipt = registry-derived per-message effects (settle action → SemanticsEntry → AC/DC deltas, position)
     if channel died mid-job → returnPath='channel-down' with 'close-while-holding' effects (W-CRASH)
  audit.outcome(receipt); release lease
```

### 5.5 Taps and firehose (DC-17..20)

**TapPlanner (pure)**

Inputs: target, topology snapshot, BrokerProfile, effective-config lookups, alarms and principal. The plan it produces contains:
- **Mode.** The default is (A) copied-binding. (B) E2E is allowed only on safe exchange types, and never on consistent-hash below 4.3.6. (C) firehose is for admins only.
- **TapQueueSpec.** Literal types force `exclusive`, `auto-delete`, non-durable, `x-queue-type=classic`, `x-overflow=drop-head`, a small `x-max-length` (10k), `x-message-ttl` (60 s) and `x-expires`. The name is `<prefix>.tap.<ulid>`, inside the user's configure regex and never `amq.*`.
- **Bindings to copy, with their arguments.**
- **Simulated policy matches for the tap name.** The planner warns on inherited reject-publish, a catch-all DLX or max-length.
- **Refusals.** Diverting exchange types (`x-consistent-hash`, `x-modulus-hash`, `x-random`, `x-local-random`, unknown) are refused unless the user accepts diversion.
- **Badges** (DC-19):
  - default-exchange blind spot;
  - AE, mandatory and unroutable-metric masking when the tap is broader than the existing bindings, computed with the routing simulator;
  - "partial, node-local" behind load balancers.
- **Checks.** A check that the classic queue type is enabled, and an alarms check.
- **Consumer settings.** prefetch ~1000; ack every 100 messages or 50 ms; lease duration.

**TapSession**
- Declares the queue, binds, consumes and ack-batches.
- Re-syncs bindings every 30 s, or on events from the event exchange when it is available.
- Watches for saturation.
- Auto-stops on lease expiry or when idle with no subscribers for 5 min.
- E2E tap exchanges carry an ownership argument `x-<product>-session`. An orphan sweep runs at engine start and every 10 min, and deletes only exchanges we own (DC-18).

**FirehoseController** (admin only, per node, DC-20)
- **Lease.** Default 10 min, maximum 60 min, persisted.
- **Enabling.** Uses `PUT /api/traces/node/{node}/{vhost}/{name}` when rabbitmq_tracing is present. Otherwise it generates per-node `rabbitmqctl trace_on -n` runbooks.
- **Never** touches the tracing setting through `PUT /api/vhosts`.
- **State.** Tracks state per node and re-verifies it after node uptime resets.
- **Reconciliation.** Leftover leases are reconciled at startup.
- **Labels.** Capture is labelled "partial" behind load balancers.

### 5.6 DLQ centre and replay (DC-26..29, DC-53, DC-54)

**Discovery**
- Effective DLX/DLRK targets from the resolver.
- Framework naming conventions from the framework registry.
- Managed-queue detection: consumers' `client_properties` (ServiceControl, Wolverine), Topology Operator ownership and provider-owned objects. Those queues are read-only by default (DC-54).

**Reading.** DLQ reads use the same PeekPlanner, so W-OVERLIMIT protects QQ DLQs. For deep analysis, an explicit consent-gated "archive to stream" job confirm-copies DLQ messages into a stream before acking them. Analysis can then be repeated without side effects. This is available only where streams exist.

**ReplayPlanner (pure, DC-27/28)**
- Resolves the destination queue-first, in this order: framework field, then the newest `rejected`/`delivery_limit` x-death entry (skipping delay infrastructure), then a naming convention, then `x-original-*` (with a fan-out confirmation), then a user mapping.
- Never routes by `x-first-death-queue` alone.
- Strip list: `x-death*`, `x-first-death-*`, `x-last-death-*`, `x-delivery-count`, `x-acquired-count`, an elapsed `expiration`, and a `user_id` that does not match.
- Preserves logical ids. Edited messages get a new id plus an EditOf link.
- Adds switchable provenance headers `x-<product>-replay-*`.
- Sets a token-bucket rate and a canary.
- Pause conditions: replayed ids reappearing in the error queue, `basic.return`, a broker nack, or a `max_message_size` violation.
- Produces a dry-run sample.

**ReplayJob**
1. Consume the source with manual ack on the consume connection.
2. Publish through the default exchange with `mandatory` on the confirm channel of the publish connection.
3. Ack the source only with a `ConfirmedCopyProof`.
4. Journal every step, keyed by an idempotency key (message fingerprint + replay id).
5. Checkpoint every 100 messages.
6. **Undo** is an honest re-park: journaled copies are republished to a parking queue.

**Shovel-based moves** are capability-gated, blocked on 4.3.0–4.3.6, and deprioritised (DC-29).

### 5.7 Stream browsing (the non-destructive path; DC-22/23/26)

**Read planner path order**
1. The in-house AMQP 1.0 adapter on 4.0+. Filters are described values, offsets are ulong, timestamps are in ms; Bloom filters on 3.13+, property filters on 4.1+, SQL filters on 4.2+.
2. AMQP 0-9-1 `x-stream-offset` with manual ack and prefetch > 0. This is also the path on 3.13.
3. The stream protocol, only if the probe shows every advertised host:port is reachable. It is feature-flagged.

**Rules**
- Readers are always anonymous.
- Every AMQP 1.0 attach compares the requested filters with the filter-set the broker reports as applied, and fails closed with "broker ignored filter X" (DC-23).
- The connected node must host a replica. On the "no running replica on the local node" error, the UI lists the nodes that do.
- Pages are fetched by offset or timestamp. Tail-follow uses `stream.tail` with bounded credit.
- Header-conversion loss is disclosed in the UI (DC-26).
- The stream browser is hidden on Amazon MQ.

### 5.8 Guardrails

| Guardrail | Behaviour |
| --- | --- |
| Environment classes | `local`, `dev`, `test`, `staging`, `prod`, each with a colour. Every profile has one, and it drives the default guardrail profile. |
| Typed confirmation | In `prod`, destructive operations require typing the object name. Bulk operations require typing the count. |
| Dry run | Plan endpoints return the exact effects: routing simulation, objects changed, estimated messages affected. Bulk operations in `prod` must be planned before they run. |
| Approvals (team) | Four-eyes. The approval is bound to the plan hash and expires; the approver must differ from the requester. Defaults: budget-limited QQ peeks (4.0-4.2), bulk replays over 1,000 messages, purges in `prod`, firehose. |
| Rate limits | Per principal and per operation lane. |
| Unattended principals | MCP, jobs and alerts may never choose rescue option A. Mutating MCP tools are off by default and always need human approval. |
| Honest wording | An ESLint/i18n rule rejects "non-destructive" and "read-only" in UI strings, except on allow-listed stream and node-agent keys (DC-15). |

### 5.9 Side-effect receipts

**Contents.** Every side-effect or destructive execution returns a receipt with:
- operation id and action id;
- era and method;
- registry version;
- per message: settle action, semantics entry, AC/DC deltas and position;
- hold time;
- return path;
- warnings;
- confidence (`code-derived` or `lab-verified`).

**Where receipts go.**
- Receipts are persisted and linked from audit rows.
- MCP tools return them.
- The UI shows them in a "What happened" drawer.

### 5.10 One action layer for the UI, CLI, MCP and jobs

```
UI (REST via tunnel/HTTP) ─┐
CLI (HTTP over socket) ────┤
MCP (stdio shim / /mcp) ───┼──▶ edge: authenticate → Principal{kind, unattended, transport}
jobs / alert automations ──┘                   │
                                               ▼
OperationGateway: lookup OperationDefinition → validate (zod) → capability gate (BrokerProfile; 412 + why)
  → authorize (PolicyEngine: RBAC ∩ broker identity; 403 / needs-approval) → guardrails (env, rate, unattended)
  → plan (pure planner + HTTP preflight) → PlanStore {planId, planHash, ttl}
  → consent/approval check (bound to planHash; plan.stale if preflight drifted)
  → audit.attempt (durable before side effects) → execute (service; AbortSignal; budgets)
  → receipt → audit.outcome → response | job handle
```

---

## 6. Data model and persistence

### 6.1 Entities

Desktop and local web use node:sqlite. Team mode uses Postgres.

| Entity | Key fields | Desktop / local | Team | Default retention |
| --- | --- | --- | --- | --- |
| profile | id, name, envClass, colour; endpoints (mgmt, amqp(s), prometheus overrides); dialer chain; tls (caRefs, servername, insecure); credentialRefs per protocol (http, amqp091, amqp10, stream); provider hint; tags; team only: ownerId, visibility | config.db | PG | until deleted |
| credential_ref | id, kind, non-secret params (issuer, clientId, scopes, command), secretId? | config.db | PG | with profile |
| secret / dek | AES-256-GCM ciphertext, iv, tag, aad (entity + field), dekId / wrapped key, wrap method | config.db | PG | rotation: team yearly |
| broker_profile_cache | profileId, probedAt, registryVersion, json | config.db | PG | latest + previous |
| inventory_snapshot | profileId, kind, vhost, version, chunk no, compressed bytes (gzip or brotli) | data.db | PG | latest 2 versions |
| view, template, collection | owner, kind, filter/sort/columns or message items (body refs) | config.db + blobs | PG + PVC | until deleted |
| plan | planId, opId, planHash, principal, json, expiresAt | memory (+ data.db while awaiting consent) | PG | 5 min; 24 h if awaiting approval |
| peek_intent | planId, profileId, queue, era, startedAt, resolvedAt | data.db | PG | 7 d after resolution |
| capture_session | kind (peek, tap, stream, dlq), target, settings, stats, persist mode, dekId? | capture.db | PG | desktop: session-only unless saved; team: 24 h or quota |
| captured_message | sessionId, seq, receivedAt, exchange, routingKey, queue, props, typed headers, bodyInline ≤ 64 KiB or bodyRef, size, truncated, contentType, encoding, framework, fingerprint, counters, death summary | capture.db + FTS5 (headers text, first 16 KiB of textual bodies, routing key) | PG + tsvector GIN | with session |
| blob | sha256 ref, size, path, refCount, encrypted | capture/blobs/aa/bb/ | PVC (S3 later) | refcount GC |
| job / journal_entry | kind, version, state, principal, planHash, params, checkpoint, progress, lease owner/until / seq, kind, messageKey, data | data.db | PG (journal partitioned monthly) | 30 d (team journal 90 d) |
| receipt | actionId, opId, era, method, registryVersion, summary, perMessage (compressed) | data.db | PG | desktop 30 d; team follows audit |
| audit_event | seq, ts, actor snapshot, onBehalfOf, actionId, opId, phase (attempt/outcome), resource, paramsDigest, planHash, approvalId, outcome, problemCode, receiptId, prevHash, hash | data.db (local activity log) | PG: INSERT-only role, hash chain | desktop 90 d; team 365 d |
| metric_series / metric_chunk | profileId, metric, labels, watchReasons / seriesId, tier (1m, 5m, 1h), chunkStart, count, codec, bytes | metrics.db | PG (partitioned by tier and day) | 1m: 48 h (team 24 h); 5m: 14 d (team 30 d); 1h: 180 d (team 400 d) |
| alert_rule, alert_state, alert_event, silence, notification_route | scope, expr, forMs, severity, routes | metrics.db + config.db | PG | events 30 d (team 90 d) |
| lint_run / finding; topology_doc | ruleId, severity, object, evidence, fix / normalised doc, hash | data.db | PG | last 20 runs; last 50 docs |
| firehose_lease, tap_registry | profileId, node, vhost, traceName, expiresAt, state | config.db | PG | reconciled at start |
| team only: user, group_claim, role, role_binding, session, api_token (hashed), approval, delegated_token (encrypted refresh), mcp_client, setting | — | — | PG | sessions: 12 h idle; approvals 30 d |

### 6.2 Storage layout and engines

**Desktop and local web: `<dataDir>/`**

| Path | Contents |
| --- | --- |
| `config.db` | `synchronous=FULL` |
| `data.db` | `NORMAL` |
| `capture/capture.db` | `NORMAL`, incremental vacuum |
| `capture/blobs/` | Blob files |
| `metrics.db` | `NORMAL`, incremental vacuum |
| `logs/` | Log files |
| `run/engine.token` | Created mode 0600; under `%LOCALAPPDATA%` it inherits user-only ACLs |
| `run/engine.sock` | Unix socket, or a pipe name published inside the token file |

**SQLite settings**
- All files use WAL, `busy_timeout=5000`, `foreign_keys=ON` and `temp_store=MEMORY`, with a periodic `PRAGMA optimize`.
- Each file has exactly one owning worker (1.2).

**Kysely 0.29.6**
- **node:sqlite** goes through an in-repo dialect of about 30 lines.
  - It detects `Database ?? DatabaseSync` (the Node 26 rename).
  - `readBigInts` is enabled for stream offsets.
  - Dates are stored as epoch milliseconds.
  - better-sqlite3 13.0.3 is a drop-in fallback behind the same dialect interface.
- **Team mode** uses `PostgresDialect` and pg 8.23.1. Postgres 15+ is supported; CI runs 16 and 18.
- **Repository ports** are always async. SQLite implementations are proxied to the owning worker through worker-rpc; Postgres implementations run directly.

### 6.3 Migrations

- **Authoring.** Migrations are written once with Kysely's schema builder plus a small dialect helper (`t.id()`, `t.json()`, `t.bytes()`, `t.epochMs()`). Each migration is tested against SQLite and against Postgres 16 and 18.
- **Locking and backups.**
  - Migrations run at startup under a lock: an advisory lock on Postgres, an exclusive transaction on SQLite.
  - The desktop copies the database file first.
- **Data migrations** run as background jobs.
- **Downgrade protection.** The engine refuses to open a database with a newer schema version, and offers to keep the backup.

### 6.4 Encryption at rest

- **Secrets** are always encrypted. The AAD binds each secret to its entity and field.
- **Capture bodies** are encrypted per session when enabled.
  - Team mode enables this by default.
  - On the desktop it is off by default, but captures are session-only unless saved.
- **Audit** stores digests, not payloads.
- **Whole-file encryption** is not available, because node:sqlite has no SQLCipher. The docs rely on OS disk encryption for this.

---

## 7. Security model per mode

### 7.1 Overview

| Concern | Desktop | Local web | Team server |
| --- | --- | --- | --- |
| UI to engine | MessagePort per window; no listener; renderer CSP `default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'nonce-…'; worker-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'` plus Trusted Types (Monaco policies verified in S-10b) | 127.0.0.1 only; refuses public binds without real auth and TLS; launch token in the URL fragment, then sent as Bearer; exact Host allow-list (`127.0.0.1:PORT`, `localhost:PORT`, `[::1]:PORT`, configured names); Origin and Sec-Fetch-Site checks; JSON-only mutation bodies; no GET mutations; WS needs an Origin check plus a token in the subprotocol | HTTPS via ingress; OIDC BFF; `__Host-` session cookie (HttpOnly, Secure, SameSite=Lax) + `X-CSRF-Token`; WS needs an exact Origin match plus a one-time ticket (`POST /api/v1/live/tickets`); HSTS; CSP with per-request nonces |
| CLI and MCP | Unix socket 0600 in a 0700 directory, or a named pipe with a random name, plus a scoped capability token from `run/engine.token`. No TCP (DC-35). | Same as desktop | API tokens (hashed, scoped, expiring); `/mcp` is its own OAuth resource |
| Identity | OS user; credentials per profile | Launch token; optional local password | OIDC users; group or app-role claims map to roles; optional break-glass admin from a secret, off by default |
| Authorization | Guardrails | Guardrails | Deny-by-default RBAC ∩ broker identity; approvals; guardrails |
| Secrets | DEK wrapped by safeStorage async in main, or @napi-rs/keyring forced to Secret Service. A master password is required on Linux `basic_text` or keyutils (DC-45). | Keyring or master password; in Docker, a KEK from a file secret | Envelope encryption: KMS, Vault Transit, OpenBao Transit, or a static KEK for small installs |
| Egress | Permissive plus default denies (metadata IPs, link-local), no redirects, issuer pinning | Same as desktop; `--strict-egress` option | Strict admin allow-list; private, loopback, link-local and metadata denied by default; NetworkPolicy |
| Audit | Local activity log + receipts | Same as desktop | Append-only, hash-chained, attempt + outcome |
| Platform hardening | Fuses: RunAsNode, NodeOptions and NodeCliInspect off; ASAR integrity and OnlyLoadAppFromAsar on. Sandbox, contextIsolation, navigation and window-open guards, `openExternal` allow-list, deny-all permission handler, single-instance lock (DC-46) | Least-privilege process; no CORS headers ever | Distroless nonroot, read-only root filesystem, restricted Pod Security Standard, seccomp RuntimeDefault |

### 7.2 Identity providers and the TokenManager (DC-37..39)

**CredentialProviders**
- password
- oauth-pkce-loopback: system browser, PKCE S256, `http://127.0.0.1:0/cb` (RFC 8252); fixed-port fallback for Okta and Auth0; device code fallback
- oauth-device-code
- oauth-client-credentials
- token-command (kubeconfig-exec style)
- static-token
- x509-external (SASL EXTERNAL)
- vault-dynamic (Vault or OpenBao)
- delegated-user (team only)

**Credentials per protocol.** Profiles hold separate HTTP and AMQP credentials, because the broker may run a separate HTTP auth chain (4.0.8+ and 4.1+).

**TokenManager**
- **Schedule.** Refreshes at 75 % of a token's lifetime, with jitter.
- **Username check.** Asserts that the username claim has not changed.
- **Size preflight.** Warns before use when a Bearer header exceeds about 4,000 bytes (risk of 431), or when the PLAIN response exceeds 4096 bytes (broker ≤ 4.0) or 8192 bytes (4.1+). Always prefers Bearer over Basic.
- **Renewal per protocol:**
  - AMQP 0-9-1: `updateSecret`, plus a lazy credentials object for reconnects.
  - AMQP 1.0 on 4.1+: `PUT /auth/tokens`.
  - AMQP 1.0 on 4.0, and the stream protocol: planned reconnect.
  - HTTP: one retry on 401, for idempotent requests only.
- **Expiry handling by broker version (DC-38).**
  - On brokers ≤ 4.2.5, the engine cancels its own consumers and taps at expiry.
  - On 4.2.6+, it handles `320 CONNECTION_FORCED` reconnects transparently.

**OAuth discovery**
- Reads the unauthenticated `/js/oidc-oauth/bootstrap.js`; falls back to `/api/auth` only on ≤ 4.1.
- Shows the issuer to the user, pins it to the profile and checks it against an allow-list.
- Fetches discovery and JWKS through the Dialer.

### 7.3 Team server: OIDC BFF, RBAC, approvals, audit (DC-40, DC-41)

- **Login.** openid-client 6.8.8, authorization code + PKCE as a confidential client. Tokens stay on the server, and refresh tokens are envelope-encrypted.
- **Broker credential mode,** chosen per catalog connection. Every mode is intersected with the tool's RBAC.

| Mode | Notes |
| --- | --- |
| delegated OAuth | Preferred. Access tokens for the broker audience only, never ID tokens, via token exchange (Keycloak 26.2+), OBO (Entra) or a stored refresh token. Uses per-user connection pools. |
| Vault/OpenBao dynamic | — |
| personal LDAP credentials | — |
| service account | Fallback. |

- **Permission catalogue:**
  - Viewing: `broker.view`, `inventory.view`, `metrics.view`, `stream.read`.
  - Messages: `message.peek`, `message.peek.budgeted`, `message.view-unmasked`, `message.consume`, `message.publish`, `message.replay`, `message.replay.bulk`, `message.purge`.
  - Capture: `tap.start`, `firehose.control`.
  - Administration: `topology.admin`, `user.admin`, `ops.admin`, `lint.run`, `alerts.manage`, `jobs.manage`.
  - Governance: `audit.view`, `approval.grant`, `catalog.manage`, `tool.admin`, `mcp.use`.
- **Built-in roles:** Viewer, Developer, Operator, Admin, Auditor. Custom roles are allowed.
- **Role bindings** attach a subject (user or group) to a role, scoped by environment class, connection, vhost pattern and resource pattern.
- **Evaluation** is allow-only, deny by default, and done by a pure PolicyEngine with table-driven tests.
- **Approvals** are bound to the plan hash. Approvers come from `approval.grant` holders other than the requester.
- **Audit.**
  - The table is INSERT-only for the application's database role. Triggers reject UPDATE and DELETE.
  - Rows form a hash chain (`prevHash`, `hash`), and verification runs nightly.
  - Export to a SIEM is available as JSON lines, via webhook or download.
  - Broker events from `amq.rabbitmq.event` are correlated when available.
  - The user id is placed in the AMQP `connection_name`.
- **Masking.**
  - Payload masking rules (key names, regexes, JSONPath-like selectors) apply in team mode to users without `message.view-unmasked`.
  - MCP output is always masked.

### 7.4 SSRF and egress through the Dialer (DC-43) and TLS through the TrustStore (DC-44)

**Dialer**
- **Validation.** Every dial is validated against the egress policy, by host, CIDR, port and purpose. DNS is resolved and validated at connect time through a custom `lookup` (handling `all:true`).
- **No redirects** on management, OIDC, JWKS or Vault fetches.
- **Error messages** are sanitised.
- **Tunnel types:**
  - SOCKS5 (`socks`);
  - HTTP CONNECT (undici);
  - ssh2 jump chains, with agents, keyboard-interactive and host-key TOFU or `known_hosts`;
  - system OpenSSH `ssh -W`, for certificates, FIDO keys and ProxyJump;
  - Kubernetes port-forward (pod, one port per call).
- **Wiring into libraries.**
  - Sockets are injected in-process wherever the library allows it: amqps via `tls.connect({socket})`, undici's `connect`, rhea's `connection_details`.
  - Plain-TCP amqplib and the stream client go through a permission-protected Unix-socket forwarder.
- **SNI.** `servername` is always set on tunnelled connections and connections to IP addresses.
- **Same-host tunnels** trigger a warning: guest and ANONYMOUS become "local".

**TrustStore**
- At engine start it calls `tls.setDefaultCACertificates(bundled + tls.getCACertificates('system') + org CAs)`.
- Per-profile `ca` = defaults + profile CAs, concatenated, never replaced.
- No leaf pinning.
- An explicit insecure switch, which shows a red banner.
- A TLS diagnostics panel.

**Desktop option.** A per-profile "system network" toggle routes management HTTPS through Electron `net.fetch` in the utilityProcess. This gives PAC, Kerberos/NTLM, the OS trust store and smartcard certificates. Raw AMQP obtains proxies from `session.resolveProxy()`.

### 7.5 MCP security (DC-42)

- **One server, two entry points.** The MCP server lives in the engine, behind the OperationGateway.
  - Locally, the stdio shim (`<product> mcp`) pipes JSON-RPC to the engine over the local socket, using a read-only capability token by default.
  - On the team server, `/mcp` is its own OAuth resource: Protected Resource Metadata (RFC 9728) and an audience check (RFC 8707). There is no token passthrough. The token's subject maps to a tool user, whose broker credential mode then applies.
- **Tool definitions** are generated from operations marked `mcp.expose`.
- **Connections** are referenced only by opaque ids created by humans.
- **Peeks count as mutations.** Mutating tools are off by default and need human approval through the approvals inbox.
- **Payload handling.** Payloads are quoted, size-capped, stripped of control characters and secret-masked. Receipts are returned.
- **Rendering.** Model output is rendered as text: no remote images (`img-src 'self'`), no automatic link fetching.

### 7.6 Supply chain (DC-24, DC-49, DC-50)

**Dependency resolution**
- pnpm with a frozen lockfile and catalogs.
- Lifecycle scripts are disabled except for an `onlyBuiltDependencies` allow-list.
- `minimumReleaseAge` is set to 3 days, with the setting available since pnpm 10.16.

**Pins**
- TypeScript 6.0.3, NestJS 12.1.x, Orval 8.43.0, amqplib 2.2.0, rhea 3.0.5.

**Lockfile CI checks**
- No git-URL dependency.
- Banned packages (2.4) are absent.
- Every new dependency is on `tools/supply-chain/deps-allowlist.json`. Additions need a labelled PR, which guards against hallucinated packages from agents.

**Verification and publishing**
- Licence gate (DC-50) and `npm audit signatures`.
- SBOM per artefact.
- Signed images (cosign) and signed desktop builds.
- GitHub Actions pinned by SHA, plus OpenSSF Scorecard.
- CODEOWNERS on auth, secrets, desktop main and preload, release workflows and the Helm chart.

---

## 8. Metrics architecture, including the broker polling model

### 8.1 BrokerScheduler: one place that spends broker capacity

**Lanes per broker**

| Lane | Used for | Concurrency |
| --- | --- | --- |
| interactive | User actions and detail opens | 1 reserved |
| live | Visible-object polls | Shares with interactive |
| background | Sweeps and scrapes | 1 |

- **Management HTTP** uses one undici Pool per origin with 2 connections.
- **AIMD backoff.** Concurrency is reduced when p50 latency exceeds twice the baseline, on 5xx responses and on 429.
- **Team-server cap.** A global cap of 64 background requests applies across all brokers.

**Inventory sweeps**
- **Request shape.** Requests go per vhost to `GET /api/queues/{vhost}?page=N&page_size=500&disable_stats=true&columns=…` (the same pattern applies to exchanges and policies).
  - Policy attribution is computed locally by the effective-config resolver, because policy fields are missing with stats off below 4.2.5 (DC-32).
  - `delivery_limit` comes from detail GETs.
- **Cost of pagination.** At the code level (`rabbit_mgmt_wm_queues` @v4.3.6), every page re-reads and re-sorts the full list, and only the page itself is augmented with stats.
  - The scheduler measures the server time of each page.
  - Per broker, it chooses between paging and a single columns-restricted unpaged request. The unpaged body is streamed to the index worker.
  - S-04 sets the default choice and checks the cost of `enable_queue_totals`.
- **Cadence:** `clamp(30 s, 15 min, 50 × lastSweepServerTime)`, which keeps broker time at about 2 %.
- **Targeted refreshes** are triggered by:
  - event-exchange messages, when present and permitted;
  - membership changes in Prometheus series (queues appearing or disappearing);
  - our own mutations, which apply immediately.
- **Warm start.** Snapshots are persisted as compressed per-vhost chunks.

**Detail views**
- A single-flight GET, cached for 2 s.
- While an object is visible, `object.detail` polls it every 5 s.
- In team mode, 100 viewers of the same queue cost the broker one request every 2–5 s.

**Index worker data structures**
- Columnar typed arrays for numeric fields and interned strings, with stable integer row ids.
- Cached sort permutations per (snapshot, column), invalidated on change.
- Window queries pin a snapshot version, so scrolling stays stable.
- **Bindings** are loaded per vhost on demand into an LRU with a resident cap (default 500k).
- **Search** pipeline:
  1. Per-name character bitmask prefilter.
  2. fzf-style word-start and camel-hump scorer.
  3. Incremental refinement on each keystroke.
  - Target: p95 ≤ 50 ms at 100k objects.

### 8.2 Metrics sources (DC-33)

**Prometheus first, scraped per node** — never through a Service or load balancer.

**Discovery order**
1. Provider adapters: Amazon MQ ports 16001–16003, with scrapes ≥ 60 s and never `/metrics/per-object`; CloudAMQP per-node hosts.
2. The `http/prometheus` and `https/prometheus` listeners in `/api/overview`.
3. Default ports: 15692 and 15691 (9419 for Bitnami; 127.0.0.1:15692 with a `lavinmq_` prefix for LavinMQ).
4. Per-node user overrides, including Kubernetes per-pod port-forwards.

**Scrape kinds**

| Kind | Endpoint | When |
| --- | --- | --- |
| Aggregated | `/metrics` | Always (small) |
| Coarse | `/metrics/detailed?family=queue_coarse_metrics&family=queue_consumer_count[&vhost=…]` | Only while there is per-queue demand |
| Coarse, filtered | adds `queue=<regex>` (4.3+ only; ≤ 2,000 characters; chunked into several requests) | When demand covers ≤ ~500 named queues |
| Delivery | `queue_delivery_metrics` | Only for watched queues, gated by cost on versions below 4.3 |

**Fallbacks**
- **Management API sampling.** Stats-on rates come from `message_stats`. Otherwise counts come from the `enable_queue_totals` sweep, and rates are derived approximately from deltas and labelled as such.
- **Remote PromQL (optional).** Query the user's own Prometheus for full history. This is the recommended scale path for teams that already run Prometheus.

**Load-balanced clusters.** Behind a load balancer without per-node reachability, metrics are labelled "partial". QQ series duplicated across nodes are de-duplicated using the leader recorded in the inventory (S-05 checks this).

### 8.3 Demand-driven scrape planning

- **Inputs.** `ScrapePlanner` (pure) takes `MetricsDemand`: open views (visible series), pinned series, alert rules and dashboards. It also takes the BrokerProfile and the scrape cost history.
- **Output.** A per-node plan of families, vhosts, queue regexes and intervals.
- **Interval** = `clamp(15 s, 5 min, 10 × lastScrapeDuration)`, subject to provider floors.
- **Off-switch.** When nothing needs per-queue data, only aggregated scrapes run.

### 8.4 Parsing and storage tiers

**Parsing (metrics worker)**
- A streaming line parser handles escapes, HELP and TYPE, interns label sets and keeps only the needed families.
- Counters become rates via deltas, with reset handling.
- Output is compact typed-array batches.

**Storage tiers**
1. **Hot ring.** One Float32 ring per watched series: 1 h at scrape resolution. For non-watched queues, only the latest value, an EWMA trend and the last-change timestamp (about 64 bytes per queue, so ~6.4 MB at 100k queues).
2. **Chunked rollups.** Rows are `(series, tier, chunkStart, bytes)`:
   - 1m tier: chunks of 60 points;
   - 5m tier: daily chunks of 288 points;
   - 1h tier: monthly chunks.
   - Each point is min, max, last and count, delta-encoded as float32.

   This keeps the team server at about 20k persisted series × 24 rows per day instead of hundreds of millions of point rows.
3. **Series budgets.** Desktop allows 50k watched series and team mode 200k. View-driven watches expire through an LRU.

### 8.5 Forecasts

**Drain and backlog ETA**
- Formula: `backlog / (outflow − inflow)` with EWMA smoothing, plus a confidence band. When the queue is growing, the ETA is "time to max-length", using effective limits.
- For watched queues, delivery metrics give separate inflow and outflow.
- For all queues, a net-trend forecast is computed from count deltas and labelled as such.

### 8.6 Alert evaluation and delivery

**Evaluation**
- **Rule kinds:** threshold, absent-consumers, drain ETA, broker health (alarms, node down, quorum-critical, failing health checks), and lint hazards.
- **Streaming evaluation.** Rules run inside the metrics worker on every ingest.
- **Wildcard rules.** A rule such as "any queue ready > 10k for 5 m" keeps state only for keys currently in violation, so memory is O(violators), and it forces a coarse scrape at the rule's interval.

**Delivery**
- **Desktop:** native notifications through PlatformBridge, plus an in-app inbox.
- **Local web:** browser Notification API, with permission, plus the in-app inbox.
- **Team:** routes to webhook, Slack, Microsoft Teams, Alertmanager (push API) and SMTP, with grouping, deduplication, silences and per-route rate limits.

---

## 9. Team-server specifics

**Multi-user isolation**
- **Taps and captures** are per session and owned by a user. They are visible to others only when explicitly shared. Each capture session gets its own DEK.
- **No cross-user body caches.**
- **RBAC row filtering** is applied inside index-worker queries, with patterns compiled to predicates. An optional "strict delegated visibility" mode intersects the results with visibility derived from OAuth scopes (`<resource_server_id>.<perm>:<vhost>/<name>` patterns). This is an approximation; enforcement always happens at action time with the user's own token.
- **Quotas:**
  - taps: 3 per user, 10 per broker, 50 globally;
  - capture bytes per user: 1 GB on disk and 64 MiB in rings;
  - peeks: a per-user rate limit;
  - jobs: a per-broker concurrency limit.

**Shared monitors**
- There is one `BrokerMonitor` per catalog connection. It uses a monitoring credential, chosen per connection, for inventory and metrics only.
- It never touches messages.
- Results are deduplicated with single-flight requests and cached for every viewer.

**Inventory residency**
- *Hot*: brokers with viewers in the last 10 min.
- *Warm*: compressed snapshot in Postgres.
- *Cold*: no snapshot.
- `inventory.maxResidentRows` defaults to 1M, with an LRU by broker. A cold load takes 1–2 s for 100k rows.

**Delegated connections**
- Pools are keyed by (user, broker, vhost, protocol, role), because a connection's username cannot change.
- Idle connections close after 60 s.
- Per-broker caps apply, with fair queueing.
- `connection_name` carries the user id.

**Durable jobs**
- JobStore on Postgres:
  - claims use `FOR UPDATE SKIP LOCKED` with a lease of 30 s and a heartbeat every 10 s;
  - the journal is partitioned monthly;
  - jobs are resumable after restart.
- Background jobs run under an explicit service identity or as "job X on behalf of Y", which is recorded in the audit log.

**Single replica in v1**
- Deployment `replicas: 1`.
- Rolling updates are safe because a surge pod waits as a standby on the leader advisory lock. `strategy: Recreate` is optional.
- Documented limits: about 500 concurrent users, 200 brokers and 1M resident rows on 4 vCPU / 8 GB. These are targets.

**HA path (v2)**
- N stateless API replicas.
- Broker shard ownership via a `broker_lease` table: TTL 15 s, heartbeat 5 s, assignment by consistent hashing.
- A live subscription for a broker owned by another replica is forwarded over an authenticated internal mesh: WebSocket between pods through a headless Service, protected by mTLS or a shared secret.
- Jobs are claimed with SKIP LOCKED.
- Sessions are stored in Postgres.
- When a lease moves, the client reconnects and resumes.
- Postgres `NOTIFY` is used only for small control signals, never bodies, because its payload limit is 8,000 bytes.

**Helm chart (`deploy/helm/<product>`, OCI)**
- `apiVersion: v2`, tested with Helm 4 and with Helm 3 until Feb 2027.
- Values (flat camelCase):
  - `image`, `replicaCount` (1), `publicUrl`;
  - `oidc {issuer, clientId, existingSecret, groupsClaim}`;
  - `postgres {url | existingSecret}`;
  - `kek {provider: static | kms | vault | openbao, …}`;
  - `egress {allow[], denyPrivate: true}`;
  - `persistence.captures {size, storageClass}`;
  - `retention {…}`, `plugins.allow[]` (by integrity hash);
  - `bootstrap.adminGroups[]`, `mcp.enabled`;
  - `extraCA {configMap}`, `otel {endpoint}`.
- Kubernetes objects:
  - `ingress` and `httpRoute`;
  - `networkPolicy` (egress allow-list);
  - optional `serviceMonitor`;
  - `podSecurityContext` (restricted), `readOnlyRootFilesystem` and an `emptyDir` for `/tmp`;
  - `resources`.
- `values.schema.json` is generated from the zod `ServerConfigSchema`.
- The chart is tested with chart-testing on kind.

**Configuration schema**
- **Source of truth.** One zod `ServerConfigSchema` in contracts drives everything.
- **Inputs, in order:**
  1. a YAML file;
  2. environment variables `<PRODUCT>_*`;
  3. `*_FILE` variants for secrets.
- **Startup output.** The engine validates the configuration with exact error paths and prints the effective configuration with secrets redacted.

---

## 10. UI architecture (Angular 22)

**App structure**
- Standalone components, zoneless (the default), OnPush (the default in v22), signals and Signal Forms.
- NgRx SignalStore (22.0.1) holds shared feature state. `httpResource` handles reads and HttpClient handles mutations.
- The app is one build. Runtime config comes from PlatformBridge on the desktop and from `/runtime-config.json` in web modes. It selects:
  - `ENGINE_TRANSPORT` (MessagePort or WebSocket);
  - `PLATFORM_BRIDGE` (Electron or browser);
  - the HttpBackend.
- **Shell layout:**
  - connection switcher with environment colour bars;
  - Cmd/Ctrl+K global search and command palette;
  - workspace tabs with split panes (Spartan resizable, Aria tabs, CDK drag-drop);
  - a status bar showing transport state, era badge, budget usage and running jobs.
- Feature routes are lazy (`loadChildren`), and heavy widgets use `@defer (on viewport)`.

**Transport abstraction**
- **engine-link worker.** A Web Worker owns the port (desktop) or the WebSocket (web). It:
  - decodes frames;
  - keeps rings per subscription;
  - grants credits as the main thread consumes;
  - posts coalesced batches aligned to animation frames.
- **Main thread.** Gets an `EngineLink` proxy, and LiveClient exposes signals: status, stats and a batch stream.
- **Large data stays out of the signal graph.** Message rings live in the worker or in plain arrays. Signals hold only view models such as the visible window and counters.

**Design system (`@app/ui`)**
- **Components:**
  - Spartan 1.7 helm components, copied into the repo with their MIT notice;
  - @angular/aria for tree, grid, listbox, menu, menubar, toolbar and tabs;
  - CDK for overlay, virtual scroll, drag-drop, clipboard and context menus.
- **Styling.** Tailwind 4 with an `@theme` preset over CSS custom properties. Themes are light, dark and high-contrast, and the density is compact: rows of 22–24 px and a 12–13 px UI font.
- **Theming of third-party widgets.** A ThemeService pushes tokens into AG Grid theme params, Monaco, uPlot, ECharts and Cytoscape.

**Grids (`widgets/grid`)**
- `<app-data-grid>` is an adapter over AG Grid Community 36.2.0. AG Grid Enterprise is banned.
- **Row models** are chosen by the data source:
  - client-side when there are ≤ 5k rows;
  - **infinite** otherwise, backed by the engine's windowed queries: block size 200, up to 25 cached blocks (5k rows), fixed 24 px rows.
- **Live updates.** The UI sends the visible keys, debounced to 100 ms. The engine pushes `inventory.window` deltas, which are applied with `getRowNode(id).setData()`. When the snapshot version changes, `refreshInfiniteCache()` runs at most every 5 s and keeps the scroll position.
- **Own features:** context menu (CDK/Aria), clipboard, column chooser and status bar. Column state persists to views.
- **TanStack Table v9** remains the swap-in implementation behind the same adapter.

**Topology and diagrams**
- **Cytoscape 3.34.4** (`widgets/graph`):
  - feature-detects WebGL2, and uses WebGL above about 1k elements with straight, haystack or bezier edges in solid colours;
  - canvas fallback;
  - level-of-detail rendering.
- **Layout.** ELK 0.12.0 runs as an unmodified separate worker asset under the elected EPL-2.0 licence (DC-51). `@dagrejs/dagre` is the fallback.
- **Graph sizes.** The engine serves focused subgraphs (depth ≤ 2, ≤ 2,000 elements) or aggregated vhost and prefix-cluster views. The UI never lays out 50k queues.
- **Foblex Flow 19.3** draws small diagrams: message-path traces, DLX flows and the shovel editor.
- **Accessibility.** Every canvas view has a keyboard tree or table alternative.

**Editor and payload viewers**
- **Monaco.** `widgets/editor` is our own ESM wrapper around monaco-editor 0.57:
  - workers via `new Worker(new URL(...))`;
  - JSON, XML and YAML only, with no TS worker;
  - a lazy chunk;
  - models disposed on destroy;
  - signal inputs and ControlValueAccessor support.
- **Payload viewer** (`widgets/payload`). Choice by size:
  - Monaco for textual payloads ≤ 2 MiB;
  - a virtualised text or hex viewer beyond that;
  - bodies loaded in 1 MiB chunks through `GET /blobs/{ref}`.
- **Decoded views** come from decoder and codec plugins. DOMPurify (Apache-2.0 elected) is used, and `innerHTML` with raw payloads is banned.

**Charts.** `widgets/charts` uses:
- uPlot 1.6.32, pinned and vendored if needed, for live rates and sparklines;
- ECharts 6.1 via ngx-echarts 22, tree-shaken, for dashboards and long history.

**Commands and keybindings**
- `CommandRegistry` holds commands as {id, title, `when` context, handler, menu placement}.
- `KeybindingService` uses tinykeys 4.0.1 and loads JSON keymaps. Web-safe alternates cover browser-reserved chords.
- The Spartan command palette shows the commands.
- Native menu accelerators are generated from the same `commands-manifest`.

**Other libraries:** i18n with Transloco 8.4 (with the honest-wording lint, DC-15); icons with @lucide/angular.

**Performance budgets** (enforced in CI)
- Angular `budgets` in `project.json`, as raw-size errors.
- Gzip size checks per chunk.
- Playwright perf scenarios using CDP long-task and frame metrics:
  - scrolling a 100k-row grid;
  - a tap at 10k msg/s;
  - search typing.
- Renderer heap is checked in desktop test builds.

---

## 11. Plugin and codec SDK (DC-53)

**Package and kinds**
- `@<product>/decoder-sdk` (Apache-2.0) contains:
  - types;
  - `defineDecoder` and `defineCodec`;
  - the machine-readable framework header registry (JSON);
  - a test harness that runs plugins against fixture corpora;
  - golden-output snapshot helpers.
- Plugin kinds:
  - `decoder`: `detect`, `decode`, `fingerprint`, `replayPlan`;
  - `codec`: `detect`, `decode`, `encode?`, for protobuf, Avro, msgpack, CBOR, BSON, XML, gzip, deflate and brotli. zstd is opt-in while Node marks it experimental.

**Packaging**
- A plugin is an npm package whose `package.json` contains `"<product>Plugin": {apiVersion: 1, kind, entry, frameworks[], codecs[]}`.
- It may depend only on the SDK and on pure-JS libraries; native addons are refused.
- First-party plugins in `plugins/first-party/*` are built on the same SDK:
  - v1.0: generic, MassTransit (built from v8 Apache-2.0 fixtures), Spring, NServiceBus, EasyNetQ, Celery;
  - v1.1: Symfony, Rebus, Wolverine, Laravel, Dramatiq, Sneakers.
- Plugins recognise delay infrastructure, so "expired" deaths in delay queues are classified as scheduled, not failed.
- Plugins never deserialise pickle or PHP objects.

**Registration**
- Discovered from the data dir (`plugins/`) or from the team server's `plugins.allow[]`, pinned by package name and integrity hash.
- Loaded by the plugin pool and listed with version and permissions.
- Disabled per profile if needed.

**Sandboxing: honest limits**
- First-party code runs in the codec pool. Third-party plugins run in a separate plugin pool, so a misbehaving plugin cannot starve first-party decoding.
- Each worker runs with `resourceLimits {maxOldGenerationSizeMb:128, maxYoungGenerationSizeMb:32, stackSizeMb:4}`.
- Per call:
  - a 200 ms timeout, after which the worker is terminated and respawned;
  - input caps: detect sees ≤ 64 KiB, decode ≤ 16 MiB;
  - an output cap of 4 MiB of JSON.
- Plugins get bytes in and plain data out. They have no engine objects and no sockets through the API.
- Worker threads are **not a security boundary**. On Node 24 the permission model neither applies to workers nor restricts the network. Third-party plugins are therefore treated as trusted code:
  - they are opt-in;
  - desktop installs show an explicit warning;
  - the team server accepts only allow-listed hashes.
- A separate plugin-host process using Node's permission model (with `--allow-net` absent) is planned for hosts on Node 26 or later.

**Versioning**
- The SDK follows SemVer.
- The runtime contract is `apiVersion` (integer); the engine supports N and N-1.
- The framework header registry has its own version, and fixture corpora are versioned with it.

---

## 12. Testing architecture

### 12.1 Layers

| Layer | Tooling | What it covers | Where it runs |
| --- | --- | --- | --- |
| Unit | Vitest 5 | Pure planners, resolvers, registry, PolicyEngine, live-protocol state machines (model-based), parsers (fuzz) | All runners |
| Contract | Vitest + `testing/fixtures` | Port contract suites: amqplib vs @cloudamqp/amqp-client for 0-9-1; mgmt client against golden fixtures for 3.13.7, 4.0.9, 4.1.8, 4.2.9, 4.3.6 (nightly refresh diff) | Linux |
| Conformance (public, DC-47) | Testcontainers 12.2.1 + broker-lab | Every registry cell (CT ids), every settle path, peek and tap and replay receipts, vhost GET-merge-PUT (DC-21), filter-set verification (DC-23), token expiry per version | Linux |
| Differential | `testing/oracle-amqp10` | rhea adapter vs coders51 client (with rhea overridden to 3.0.5) on overlapping features | Linux, nightly |
| E2E web | Playwright 1.64.1 | Local web mode against broker-lab | Linux |
| E2E team | Playwright + Postgres + Keycloak 26 containers | OIDC, RBAC, approvals, audit chain, MCP OAuth resource | Linux |
| E2E desktop | Playwright Electron on a **test-fused** binary (nodeCliInspect and RunAsNode on; never shipped) | Boot, tunnel, reload re-wiring, crash restart, suspend/resume simulation, safeStorage | Linux (xvfb) smoke and full; macOS and Windows smoke |
| Perf | Custom harness + CDP | Section 0.2 budgets | Linux nightly; PR smoke |
| Chaos | toxiproxy + 3-node cluster + HAProxy | Nack/qos-barrier vs DOWN ordering under leader transfer, latency, resets, timeouts (thousands of peeks; DC deltas asserted) | Linux nightly |
| Visual and a11y | Storybook 10 (`@storybook/angular-vite`) + Playwright screenshots; axe-core; Aria/CDK harnesses | Components and key pages | Linux |

### 12.2 Broker lab

**Images.** `testing/broker-lab` builds `ghcr.io/<org>/broker-lab:<version>` from `rabbitmq:<version>-management`:
- plugins enabled: stream, prometheus, tracing, shovel(+management), federation, consistent-hash, event-exchange;
- ports exposed: 5672, 5671, 15672, 15671, 5552, 5551, 15692;
- generated TLS certificates;
- optional OAuth configuration pointing at a Keycloak container;
- `stream.advertised_host=localhost` and `advertised_port` = a fixed mapped port.

**Helpers**
- A `BrokerLabContainer` Testcontainers helper.
- A docker-compose file for a 3-node cluster plus an HAProxy (TCP) load balancer and toxiproxy.

**Version matrix**
- **Per PR:** 3.13.7, 4.0.9, 4.1.8, 4.2.9 and 4.3.6 on Node 24.22, sharded.
- **Nightly:**
  - the full cross product with Node 26.12 and Electron 45's Node (ELECTRON_RUN_AS_NODE on the test-fused binary);
  - alpha builds 4.3.7, 4.4.0 and 5.0.0 (allowed to fail).
- **Published output.** Results go to `conformance-results.json`, which feeds the website compatibility matrix.
- **Re-verification.** A new broker release is re-verified before support is claimed (DC-60).

**Registry ↔ test linkage**
- Each conformance test reads its expected effect from the registry cell it covers and asserts the measured `x-delivery-count`, `x-acquired-count`, `redelivered`, position and survival.
- A contradiction fails CI.
- The fix PR flips the cell to `lab-contradicted` and corrects the data.
- Uncertainty items 1–5 of the fact sheet are the first cells to cover.

### 12.3 Scale fakes

`testing/fakes` provides:
- a synthetic management API server that serves 100k queues, 10k exchanges and 300k bindings with realistic pagination cost;
- a synthetic Prometheus endpoint (400k series per node, about 12 MB);
- a team load generator: 500 WebSocket clients and 200 fake brokers, written in-house to avoid licence questions.

A real-broker scale run (50k queues via definitions import) runs nightly.

### 12.4 CI runners

| Runner | Jobs |
| --- | --- |
| ubuntu-24.04 (x64) | Lint, typecheck, unit, contract, conformance matrix, E2E web and team, desktop E2E (xvfb), perf smoke, licence and lockfile gates, Docker amd64, Helm lint and chart-testing (kind) |
| ubuntu-24.04-arm | Docker arm64, Linux arm64 desktop packaging, unit subset |
| macos-15 / macos-26 (arm64), macos-15-intel | Build, sign and notarise; desktop smoke against `brew install rabbitmq` 4.3.6 or fakes; keychain tests |
| windows-2025 | NSIS, MSIX and zip packaging and signing; desktop smoke against fakes; named-pipe tests (Windows runners cannot run Linux containers) |
| Nightly (Linux) | Alphas, full matrix, scale, chaos, framework fixture apps (MassTransit v8, Spring, Celery, ...; licences reviewed), managed-broker contract tests in a protected environment with secrets |

---

## 13. Observability of the tool itself

- **Logs.**
  - pino, pinned, writing structured JSON.
  - Each module has its own logger, carrying `requestId`, `actionId`, `jobId`, `profileId` and `traceId`.
- **Redaction:**
  - fixed paths: `*.password`, `*.secret`, `*.token`, `headers.authorization`, `cookie`;
  - pattern scrubbers for AMQP URIs with credentials, JWT-shaped strings, `x-` headers that carry JWTs, and shovel/federation URIs;
  - message bodies are never logged, only sizes and hashes.
- **Redaction tests.** These feed canary secrets through every path and scan the log output.
- **Sinks:**
  - desktop: rotating files of 10 MB × 5;
  - local: stdout plus a file;
  - team: stdout (12-factor).
- **Internal metrics:**
  - event-loop delay, worker queue depths and restarts;
  - scheduler lane waits and AIMD state;
  - scrape and sweep durations and sizes;
  - live sessions, stalls and drops;
  - job throughput;
  - DB latency.

  They are exposed in-app (Diagnostics page). In team mode they are also available at `/internal/metrics` in Prometheus format: opt-in, with a separate token.
- **OpenTelemetry (optional, off by default).** `@opentelemetry/sdk-node` exports OTLP only to an endpoint the user configures, such as a local collector. Spans cover operations, broker calls and jobs, and span attributes are redacted.
- **Crash reports: opt-in only.**
  - Electron `crashReporter` uses `uploadToServer:false`, keeping minidumps local.
  - "Create report" builds a redacted diagnostics bundle (logs, BrokerProfile without secrets, versions) for the user to attach manually.
  - Upload goes only to an endpoint the user configures (DC-59).
- **Uncaught exceptions.** On an uncaught exception, the engine logs, writes the bundle and exits; the supervisor or orchestrator restarts it.

---

## 14. Build, packaging and release (DC-58)

**Toolchain**
- Nx 23.3 with @nx/angular, @nx/vitest, @nx/playwright, @nx/eslint-plugin and @nx/esbuild.
- No @nx/nest; the engine is bundled with esbuild.
- pnpm catalogs.
- Pins: Node 24.22.x, TypeScript 6.0.3.
- Electron 45.0.x from its GA on 2026-10-20; 44.8.0 until then.
- electron-builder 26.17.x (≥ 26.16.1 for licence files).
- Nx remote cache: Nx Cloud Hobby or self-hosted.

**Versioning**
- One product SemVer for the desktop app, engine, CLI, image and chart.
- Conventional Commits on PR titles, squash merges.
- release-please 17 in manifest mode; its release PR is the human checkpoint.
- Separate SemVer for `@<product>/decoder-sdk`.
- Calendar version for the registry.
- Channels: `stable` and `beta`.

**Pipeline, on tag**
1. Run the full CI and conformance gate (Tier 1 brokers must pass).
2. Build the matrix:
   - macOS arm64 and x64 DMG + zip, Developer ID-signed and notarised;
   - Windows MSIX for the Microsoft Store, the first-class channel, plus NSIS and zip on GitHub;
   - Linux deb and rpm (x64, arm64) with the AppArmor profile, plus AppImage with the Ubuntu 24.04 caveat; never `--no-sandbox`.
3. Sign Windows builds externally once SignPath is available: sign the app exe, build NSIS, sign the installer, then regenerate `latest.yml` and the blockmap.
4. Publish npm `@<product>/cli` and the SDK with provenance (trusted publishing).
5. Build GHCR images: multi-arch on native runners, merged by digest, on `gcr.io/distroless/nodejs24-debian13:nonroot`; cosign keyless signatures; SBOM attestation.
6. Push the Helm chart as an OCI artefact, signed.
7. Generate THIRD_PARTY_NOTICES per artefact (DC-50) and SHA256SUMS; attest build provenance.
8. Publish an immutable GitHub Release from a draft once all assets are signed.
9. Bump our own Homebrew tap and winget manifests, then deploy the docs and the compatibility matrix.

**Updates.** electron-updater is opt-in at first run (privacy notice, DC-59). Store, Homebrew and winget builds update through their own channels.

**Not shipped in v1:** a single executable (SEA). npx, Docker and Electron cover all modes.

---

## Appendix A — Spikes that gate decisions (run in M0, before dependent work)

| Id | Question | Exit criterion and the decision it affects |
| --- | --- | --- |
| S-01 | NestJS 12 cold start and ESM bundling in an Electron 45 utilityProcess | ≤ 400 ms p95 for the framework part on the reference Windows laptop; else generate Fastify-only routes (ADR-003) |
| S-02 | MessagePort tunnel cost and live throughput | REST p95 overhead ≤ 2 ms; 10 frames/s × 1 MiB sustained without renderer long tasks |
| S-03 | node:sqlite in utilityProcess worker threads; FTS5 ingest | 10k rows/s with FTS on the reference laptop; else move FTS off the hot path or use better-sqlite3 |
| S-04 | Management API cost at 50k/100k queues: paged vs unpaged; `enable_queue_totals` cost; Khepri | Choose sweep defaults (8.1) |
| S-05 | Prometheus detailed-scrape size and time at 100k queues; QQ series duplication across nodes | Choose dedup and interval defaults |
| S-06 | safeStorage async round trip from the engine via main; keychain prompts; Linux backends | Secrets bootstrap design confirmed |
| S-07 | Windows named-pipe default DACL; whether a custom DACL is needed | Keep token-only defence or add a small native helper |
| S-08 | light-my-request `payloadAsStream` through the Nest adapter | Streaming tunnel vs blob-chunk-only |
| S-09 | AG Grid Community infinite model at 100k rows with windowed live updates | 60 fps scroll; batch apply ≤ 4 ms |
| S-10 | Cytoscape WebGL in VMs and RDP; Monaco Trusted Types policy names | Fallback thresholds; CSP list |
| S-11 | Nack + qos barrier vs DOWN ordering under leader transfer (fact-sheet uncertainty) | If failures appear: W-CRASH wording plus a protocol change (e.g. a longer post-barrier linger) |
| S-12 | Aborted HTTP `/get` behaviour (fact-sheet uncertainty) | Client-timeout policy for the fallback |
| S-13 | utilityProcess `execArgv` heap flags and V8 code cache | Memory cap and startup settings |
| S-14 | MSIX packaging of the Electron app with the utilityProcess engine | Store channel feasibility |

## Appendix B — First agent work packages

Each package is 1–3 agent-days. Verification commands are executable from the repo root.

| WP | Scope | Depends on | Acceptance | Verify |
| --- | --- | --- | --- | --- |
| WP-01 | Repo scaffold: Nx + pnpm catalogs; TS 6.0.3; ESLint boundary/banned rules; supply-chain gates; AGENTS.md / CLAUDE.md; Renovate | — | Gates reject fixtures that use `typescript@7`, a git URL, primeng 22 or `@types/amqplib` | `pnpm nx run supply-chain:test && pnpm nx run-many -t lint,typecheck` |
| WP-02 | contracts core: `defineOperation`, `defineTopic`, ObjectKey, Problem, config schemas | 01 | 100 % branch coverage on helpers; JSON Schema export works | `pnpm nx test contracts` |
| WP-03 | domain + worker-rpc: BoundedRing/Queue, TokenBucket, typed RPC with abort and transfer | 01 | Property tests; worker crash → restart test | `pnpm nx test domain worker-rpc` |
| WP-04 | live-protocol state machines | 02 | Model-based tests for credits, coalescing, sampling, gap and resume | `pnpm nx test live-protocol` |
| WP-05 | Engine skeleton: Nest edge, explicit tokens, esbuild bundle, gateway stub, `system.info`, DrainCoordinator, loop monitor | 02, 03 | `/api/v1/system/info` served; SIGTERM drains within 2 s | `pnpm nx run engine:e2e-smoke` |
| WP-06 | Generators: operation, live-topic, adapter, feature, semantics-cell, migration | 05 | Generated `demo.ping` compiles; its tests fail with NotImplemented | `pnpm nx run generators:test` |
| WP-07 | Electron shell: main, preload, app://, supervisor, ports, TunnelServer, test-fused profile | 05 | Smoke: UI calls `system.info` via the tunnel; engine killed → restart → UI reconnects | `pnpm nx run e2e-desktop:smoke` |
| WP-08 | Angular shell: zoneless app, bridges, engine-link worker, EngineHttpBackend, ui-kit tokens and themes | 04, 07 | Same smoke in web and desktop | `pnpm nx run e2e-web:smoke` |
| WP-09 | broker-lab images + Testcontainers helpers | 01 | All 5 versions start; 5552 and 15692 reachable | `pnpm nx run broker-lab:verify` |
| WP-10 | Conformance harness + registry linkage check + results JSON | 09, 13 | Linkage check fails on a missing CT id | `pnpm nx run conformance:test -c broker-4.3.6` |
| WP-11 | Dialer (direct + TLS) + egress policy + TrustStore | 03 | SSRF test suite (metadata IPs, DNS rebinding at connect time, redirects) | `pnpm nx test adapter-dialer adapter-truststore` |
| WP-12 | mgmt-http adapter (~60 endpoints, lanes, streaming, stats-off quirks, product-aware `/get`) | 11 | Golden fixtures parse on all 5 versions | `pnpm nx run adapter-mgmt-http:test-integration -c all-brokers` |
| WP-13 | Semantics registry v0 + era resolver (all b.1/b.2/b.4 cells) | 02 | Every cell has citations and a CT id | `pnpm nx test semantics-registry semantics-era` |
| WP-14 | Probe → BrokerProfile; capability gates with "why" | 12, 13 | Profiles correct on all versions; provider fingerprints work on fixtures | `pnpm nx run conformance:test -c all-brokers --grep probe` |
| WP-15 | Secrets vault + backends; profiles CRUD ops; password provider | 05, 11 | Redaction scan clean; Linux `basic_text` requires a master password | `pnpm nx test svc-secrets svc-connections` |
| WP-16 | Inventory: index worker, sweeps via BrokerScheduler, windows, search | 12, 14 | 0.2 inventory budgets; loop p99 ≤ 20 ms during a sweep | `pnpm nx run perf:inventory-100k` |
| WP-17 | Explorer UI: grid adapter (infinite model), list/detail, search palette | 08, 16 | 60 fps scroll; 0 long tasks over 50 ms | `pnpm nx run e2e-web:e2e --grep explorer && pnpm nx run perf:grid-scroll` |
| WP-18 | Effective-config resolver + policy debugger UI | 13 | Table tests incl. QQ 4.0.8 arg 500 vs policy 1000 → 500 | `pnpm nx test semantics-effective-config` |
| WP-19 | Metrics: Prometheus parser (worker), ScrapePlanner, rings + chunks, management fallback, charts | 14 | Parser fuzz; 12 MB scrape parsed off the loop | `pnpm nx run perf:metrics-100k` |
| WP-20 | amqp091 adapter + ConnectionManager roles and budgets; contract suite vs @cloudamqp | 11, 14 | Contract suite green on both libraries | `pnpm nx run adapter-amqp091:test-integration` |
| WP-21 | Peek planner (pure) | 13, 18 | All b.8 gates, caps and warnings; property tests | `pnpm nx test semantics-peek-planner` |
| WP-22 | Peek executor + receipts + intents + conformance cells for the settle matrix | 20, 21 | Measured counters match the registry on all versions | `pnpm nx run conformance:test -c all-brokers --grep peek` |
| WP-23 | Capture store (worker, FTS5, blobs) + payload viewers | 03, 08 | 10k rows/s ingest; 10 MiB body ≤ 2 copies | `pnpm nx run perf:capture-ingest` |
| WP-24 | Publish (confirms, mandatory, templates) | 20 | Returns and nacks surfaced; size limits | `pnpm nx run conformance:test --grep publish` |
| WP-25 | Taps (planner, session, re-sync, orphan sweep) + firehose controller | 20, 23 | DC-17..20 tests; 10k msg/s budget | `pnpm nx run perf:tap-10k` |
| WP-26 | amqp10 adapter on rhea (credit/drain/release, described filters, filter-set verification) | 11 | Differential tests vs the oracle | `pnpm nx run adapter-amqp10:test-integration` |
| WP-27 | Stream browser (planner, readers, UI) | 26 | Fail-closed on dropped filters; header-loss banner | `pnpm nx run conformance:test --grep stream` |
| WP-28 | Decoder SDK + first-party decoders + DLQ centre + replay job (journal, throttle, canary, undo) | 22, 24 | DC-27/28 tests; framework fixtures | `pnpm nx test decoder-sdk plugins-first-party && pnpm nx run conformance:test --grep replay` |
| WP-29 | Admin CRUD incl. vhost GET-merge-PUT, flags, definitions, health, replica ops | 14 | DC-21 round-trip test on 4.1.8, 4.2.9, 4.3.6 | `pnpm nx run conformance:test --grep admin` |
| WP-30 | Topology graph + routing simulator + graph widget (ELK worker asset) | 16 | Simulator vs broker routing on fixture topologies | `pnpm nx test semantics-routing && pnpm nx run conformance:test --grep routing` |
| WP-31 | Linter/advisor + topology-as-code + CLI `lint` / `topology plan` | 18, 29 | Exit codes in CI usage | `pnpm nx run cli:e2e` |
| WP-32 | Local web mode (CLI `serve`, edge checks, Docker image) | 05, 08 | Host/Origin/DNS-rebinding test suite | `pnpm nx run e2e-web:security` |
| WP-33 | Team server: OIDC BFF, PolicyEngine, approvals, audit chain, PG adapter + migrations, Helm chart | 05, 15 | Keycloak E2E; audit verify; chart-testing | `pnpm nx run e2e-team:e2e && pnpm nx run helm-chart:ct` |
| WP-34 | MCP (socket shim + `/mcp` resource; read tools; approvals for mutations) | 33 | No token passthrough; opaque ids only | `pnpm nx run e2e-team:e2e --grep mcp` |
| WP-35 | Alerts + notifications (desktop and team routes) | 19 | Streaming evaluation O(violators) | `pnpm nx test svc-alerts` |
| WP-36 | Perf gates for all 0.2 budgets + chaos suite | all | Nightly green | `pnpm nx run perf:all && pnpm nx run chaos:nightly` |
| WP-37 | Release pipeline (sign, notarise, MSIX, deb/rpm/AppImage, npm provenance, GHCR + cosign + SBOM, Helm OCI, notices) | all | Dry-run release on a tag in a fork | `gh workflow run release.yml -f dry_run=true` |
| WP-38 | Docs site + published compatibility matrix | 10 | Matrix generated from results JSON | `pnpm nx run docs:build` |

## ADRs proposed

- **ADR-001 One engine bundle, three hosts, one UI build:** A single Node 24.22 engine (apps/engine → engine.mjs + worker bundles) runs in three hosts: an Electron 45 utilityProcess (desktop), a loopback Node process via npx or Docker (local web) and a container with Postgres (team server). All three serve one Angular 22 build. Mode differences exist only in the entrypoints and the composition modules (EngineModeConfig); services receive capabilities through ports.
- **ADR-002 Desktop UI↔engine over MessagePort; REST tunnelled into the same router with fastify.inject:** Each window gets its own MessageChannelMain between renderer and engine. One port carries http.req/res/chunk frames, fed into the engine's Fastify router via app.inject (payloadAsStream for large bodies), plus the live protocol. Desktop builds have no TCP listener. The renderer CSP is connect-src 'self' (app: only). The tunnel strips and overrides security-relevant headers and marks requests with a per-process secret header.
- **ADR-003 NestJS 12 at the HTTP edge only; framework-free core; explicit DI tokens; esbuild bundle:** Use NestJS 12.1.3 on @nestjs/platform-fastify (fastify 5.12.5) for routing, DI wiring, Standard Schema validation, OpenAPI (@nestjs/swagger 12.0.2 standardSchemaConverter) and lifecycle. Services, adapters, planners and semantics are plain TS with constructor-injected ports. Controllers are generated from the operation registry and contain no logic. emitDecoratorMetadata is off and all injections use explicit tokens. The engine is bundled with esbuild. Nx is used without @nx/nest (DC-49).
- **ADR-004 Contract-first operation and topic registry (zod 4) → OpenAPI 3.1, AsyncAPI 3, Orval, MCP:** libs/shared/contracts defines every operation (defineOperation: method, path, schemas, effect, permission, capabilities, planning, audit, idempotency, lane, timeout, MCP exposure) and every live topic (defineTopic). Generated from it: Nest controllers, OpenAPI 3.1, AsyncAPI 3.0, the Orval 8.43.0 Angular client (committed) and MCP tool definitions. CI gates: oasdiff breaking-change check, generated-code freshness.
- **ADR-005 Single multiplexed live protocol with credit-based flow control and per-topic QoS:** There is one bidirectional channel per UI session: a WebSocket at /api/v1/live, or the desktop MessagePort. Frames are hello/welcome, sub/subok, credit, data (seq, items, dropped, sampledEvery), state, gap, goaway and ping/pong. Each topic declares a QoS: lossless, latest-by-key or sampled. The engine keeps a bounded outbox per subscription (items and bytes) and coalesces and samples there. Sessions can resume within 30 s. The UI decodes frames in an engine-link Web Worker.
- **ADR-006 Data-driven semantics registry with conservative per-cluster era resolution:** All version-dependent broker behaviour is data, held as TS constants validated by zod in libs/engine/semantics/registry: settle matrix, counters, DLX carry-over, delayed retry, hazards, capabilities, warnings, peek caps, tap rules, provider presets, effective-config tables and the framework registry. Each cell carries citations, conformance test ids and a status (code-derived, lab-verified or lab-contradicted). resolveEra implements DC-02 exactly. The registry version is stamped into receipts. Lint bans broker-version comparisons outside the semantics and probe projects.
- **ADR-007 Peek is a short engine-side atomic job over AMQP 0-9-1 basic.get on a role-separated peek connection:** The flow is: HTTP-only preflight → pure PeekPlanner (method, caps, hold budget, guard, rescue, gates, consents, expected effects) → consent → PeekExecutor. The executor acquires, copies and stops at the first doomed message (applying the pre-chosen rescue), then returns everything with one nack(lastTag, multiple, requeue=true) followed by an awaited basic.qos barrier and a channel close, under a watchdog. At most one in-flight peek job runs per peek connection, and that connection never publishes. AMQP 1.0 credit+drain+released is an opt-in fast path on 4.3+. HTTP /get with ack_requeue_true is a gated fallback.
- **ADR-008 One OperationGateway enforces policy for UI, CLI, MCP, jobs and automations:** Every call passes through a framework-free OperationGateway. Its pipeline is: definition lookup → validation → capability gate (BrokerProfile, with a 'why disabled' reason) → PolicyEngine (RBAC ∩ broker identity) → guardrails (environment class, rate, unattended rules) → plan via PlanStore (planId, planHash, TTL) → consent and approval bound to the planHash, with re-validation for staleness → durable audit attempt → execute with AbortSignal and budgets → receipt → audit outcome. A generic POST /plans/{id}/execute runs any planned action.
- **ADR-009 In-house protocol adapters behind ports, with contract suites against alternates:** MgmtHttpPort is built in-house on undici + zod with golden fixtures per broker version (DC-48). Amqp091Port uses amqplib 2.2.0, with its contract suite also run against @cloudamqp/amqp-client 4.1.1. Amqp10Port is an in-house adapter on raw rhea 3.0.5 (credit_window 0, described filters, filter-set verification, percent-encoded v2 addresses, vhost hostname). StreamPort (rabbitmq-stream-js-client 1.1.0) is optional and feature-flagged. rabbitmq-amqp-js-client is only a differential oracle.
- **ADR-010 Engine threading: latency-critical I/O loop plus single-owner workers:** The main thread owns all sockets, timers, watchdogs and orchestration, and must never block for more than 5 ms. Single-purpose workers do everything else: storage (config.db, data.db), capture (capture.db + blobs + FTS5), metrics (parsing, rings, chunks, alerts), index (inventory, windows, search), a lazy codec pool and an opt-in plugin pool. Large HTTP bodies are streamed from the loop to the parsing worker as transferred chunks. Each SQLite file has exactly one owning worker. Event-loop delay p99 ≤ 20 ms under load is a CI-gated SLO.
- **ADR-011 Engine-resident inventory with windowed queries and demand-driven, cost-adaptive refresh:** Inventory lives in the index worker as columnar typed arrays with interned strings. The UI requests windows (offset/limit with a pinned snapshot version) and receives live deltas only for visible keys. Sweeps run per vhost with disable_stats and column projection. The scheduler chooses paged or unpaged requests from measured broker cost. Cadence is clamp(30 s, 15 min, 50 × sweep server time). Targeted refreshes come from the event exchange, Prometheus series membership and our own mutations. Snapshots persist for warm start, and bindings are loaded lazily into an LRU.
- **ADR-012 Prometheus-first, per-node, demand-driven metrics with tiered chunked storage:** Scrape every node directly, never through a load balancer. Discovery order: provider adapters → overview listeners → default ports → overrides. Aggregated metrics are always scraped. Detailed families (coarse counts, delivery) are scraped only for current demand (views, pins, alerts), with vhost filters and the queue= regex on 4.3+. Parsing streams in the metrics worker. Storage: a hot ring for watched series, O(1) state for the rest, and chunked 1m/5m/1h tiers. Management API sampling is the fallback, and remote PromQL is an option.
- **ADR-013 Persistence: Kysely over node:sqlite (desktop/local) and Postgres (team); dialect-portable migrations:** Kysely 0.29.6 with an in-repo node:sqlite dialect (Database ?? DatabaseSync, readBigInts, epoch-ms dates) and better-sqlite3 13.0.3 as a drop-in fallback. Desktop and local web split data across four files, each owned by one worker. Team mode uses PostgresDialect with pg 8.23.1 (PG 15+, CI on 16 and 18). Migrations are written once with a dialect helper, tested on both dialects, run under locks with desktop backups and downgrade protection.
- **ADR-014 Capture store: byte-bounded rings, SQLite/FTS5 metadata, content-addressed blobs, session-only by default:** Captures from peeks, taps, streams and DLQs flow through a bounded ring into the capture worker, in batched transactions of ≤ 5 ms. Metadata, typed headers and bodies ≤ 64 KiB go in capture.db, with FTS5 over headers and the first 16 KiB of textual bodies. Larger bodies go to sha256-addressed blob files. Under pressure, drop order is indexing → body persistence → sampling, all counted. Desktop captures are session-only unless saved. Team captures are encrypted per session, with quotas and retention. Bodies reach the UI as 1 MiB chunks on demand.
- **ADR-015 Identity subsystem: pluggable CredentialProviders and a per-protocol TokenManager:** Credential providers: password, OAuth PKCE loopback (system browser, RFC 8252), device code, client credentials, token-command, static token, x509/EXTERNAL, Vault/OpenBao dynamic, delegated user. Profiles hold separate HTTP and AMQP credentials. The TokenManager refreshes at 75 % of lifetime, asserts the username claim is unchanged, renews per protocol (update-secret; PUT /auth/tokens on 4.1+; reconnect for 4.0 AMQP 1.0 and streams; one 401 retry for idempotent HTTP), checks token size before use, and adapts expiry handling to the version (cancels its own consumers on ≤ 4.2.5). OAuth discovery uses bootstrap.js, then /api/auth on ≤ 4.1, with issuer pinning.
- **ADR-016 All egress through one Dialer with an SSRF policy; TLS trust configured in code:** The Dialer supports direct, SOCKS5, HTTP CONNECT, ssh2 jump chains, system OpenSSH and Kubernetes port-forward. It validates DNS at connect time, follows no redirects, preserves SNI, injects sockets into libraries where possible and uses a permission-protected Unix-socket forwarder where not. Egress is permissive with default denies on the desktop and a strict allow-list on the team server. The TrustStore calls tls.setDefaultCACertificates(bundled + system + org CAs) and concatenates per-profile CAs onto the defaults. There is no leaf pinning. The insecure mode is explicit and shows a banner.
- **ADR-017 Secrets: AES-256-GCM with DEKs wrapped by the OS keystore or a KMS; master password fallback:** Secrets are encrypted per secret with an AAD bound to entity and field. On the desktop the DEK is wrapped by Electron safeStorage async in main (over the control port only) or by @napi-rs/keyring forced to Secret Service. A master password (scrypt/argon2) is required on Linux basic_text or keyutils. Local web mode uses the keyring, a master password or a KEK file in Docker. The team server uses envelope encryption with KMS, Vault Transit, OpenBao Transit or a static KEK. Secret API fields are write-only. No tokens are kept in localStorage.
- **ADR-018 Team server v1: single active replica with Postgres; HA later via broker-shard leases:** v1 runs one leader pod, chosen by Postgres advisory lock (a surge pod waits as standby), with in-memory monitors, live sessions and caches, durable jobs and journal in Postgres, and blobs on a PVC. HA v2 runs N API replicas with broker ownership leases (TTL 15 s, consistent hashing). Live subscriptions for brokers owned by another replica are forwarded over an authenticated internal mesh. Jobs are claimed with SKIP LOCKED. Postgres NOTIFY carries control signals only.
- **ADR-019 Team authentication and authorisation: OIDC BFF, deny-by-default scoped RBAC, four-eyes approvals, hash-chained audit:** openid-client 6.8.8 authorization code + PKCE as a confidential client. A __Host- session cookie with SameSite=Lax plus a CSRF header. WebSocket tickets with exact Origin checks. A permission catalogue that separates peek, consume, purge, replay, publish, topology admin and user admin. Role bindings scoped by environment class, connection, vhost and resource patterns. A pure PolicyEngine. Approvals bound to the planHash. An INSERT-only, hash-chained audit with attempt and outcome rows and a SIEM export. Broker credential mode is chosen per connection and always intersected with RBAC.
- **ADR-020 MCP served by the same gateway: stdio shim over a local socket; team /mcp as its own OAuth resource:** The MCP server runs inside the engine, and its tools are generated from operations marked for MCP exposure. Locally, the `<product> mcp` stdio shim pipes JSON-RPC to the engine over the Unix socket or named pipe with a read-only capability token by default. On the team server, /mcp is a separate OAuth protected resource (RFC 9728/8707) with no token passthrough. Connections are referenced only by opaque ids created by humans. Peeks are classified as mutations. Mutating tools are off by default and need human approval. Output is masked, capped and quoted, and receipts are returned.
- **ADR-021 Angular 22 UI: zoneless signals, transport in a Web Worker, third-party widgets behind adapters:** Standalone components, zoneless, OnPush and signals, with SignalStore for shared state and httpResource for reads. EngineTransport (MessagePort or WebSocket) runs inside an engine-link Web Worker that decodes frames, keeps rings and handles credits. PlatformBridge abstracts the desktop and browser differences. The @app/ui design system uses Spartan helm + Angular Aria + CDK + Tailwind 4 tokens. Third-party widgets sit behind adapters: AG Grid Community (infinite model; our own context menu, clipboard and status bar), Cytoscape with the ELK worker asset, Foblex, a Monaco ESM wrapper, uPlot and ECharts. A command registry drives both the palette and the native menus.
- **ADR-022 Nx 23 + pnpm monorepo with tag boundaries, exact pins, supply-chain gates and generators as the agent interface:** Nx 23.3 with @nx/angular, @nx/vitest, @nx/playwright, @nx/esbuild and @nx/eslint-plugin, without @nx/nest. Tags cover scope, type and platform, with depConstraints and per-project confinement of third-party imports. pnpm catalogs pin exact versions: TS 6.0.3, NestJS 12.1.x, Orval 8.43.0, amqplib 2.2.0, rhea 3.0.5. minimumReleaseAge is set. A dependency allow-list, licence gate and git-URL lockfile check run in CI. Local generators exist for operations, topics, adapters, features, semantics cells, decoders and migrations. AGENTS.md and scoped .claude rules document conventions.
- **ADR-023 Decoder and codec plugins: pure functions in resource-limited worker pools; third-party plugins opt-in and hash-allow-listed:** @<product>/decoder-sdk defines detect/decode/fingerprint/replayPlan for decoders and detect/decode/encode for codecs, with apiVersion 1, a manifest in package.json and a fixture-based test harness. First-party decoders use the same SDK in the codec pool. Third-party plugins run in a separate plugin pool with resourceLimits, a 200 ms per-call timeout and input and output caps. They are opt-in on the desktop and allow-listed by integrity hash on the team server. Pickle and PHP objects are never deserialised.
- **ADR-024 Conformance-first testing with a custom broker-lab image and registry↔test linkage:** A public conformance suite runs on Testcontainers 12.2.1 against broker-lab images derived from the official management images (plugins enabled; ports 5552 and 15692 exposed; TLS and OAuth variants) for 3.13.7, 4.0.9, 4.1.8, 4.2.9 and 4.3.6. Nightly runs add alpha builds, Node 26.12 and Electron's Node. Each registry cell names its conformance tests, and each test asserts the registry's expectation. Results feed a published compatibility matrix. Separate suites cover performance (synthetic 100k-queue fakes), chaos (toxiproxy, leader transfers) and E2E (web, team, test-fused Electron).
- **ADR-025 Stream browsing over AMQP first (rhea adapter, 0-9-1 fallback); stream protocol optional:** The read planner picks the AMQP 1.0 rhea adapter on 4.0+ (described filters, ulong offsets, ms timestamps, applied-filter verification that fails closed), then AMQP 0-9-1 x-stream-offset (manual ack, prefetch > 0, also used on 3.13), then the stream protocol only when every advertised host:port is reachable. Readers are always anonymous. Header-conversion loss is disclosed, and the replica-node constraint is explained.
- **ADR-026 Release and distribution: one product version, signed and notarised builds, Store MSIX, GHCR + cosign, OCI Helm, opt-in updates:** Use release-please manifest mode with one product SemVer. macOS builds are Developer ID-signed and notarised from day one, distributed through our own Homebrew tap. Microsoft Store MSIX is the first-class Windows channel, with NSIS and zip on GitHub (SignPath added later with the two-pass latest.yml regeneration). Linux ships deb and rpm with the AppArmor profile, plus AppImage with a caveat. npm packages use trusted publishing with provenance. Multi-arch distroless GHCR images are signed with cosign and carry SBOMs. The Helm chart is published to an OCI registry. THIRD_PARTY_NOTICES are generated per artefact. Releases are immutable. electron-updater checks are opt-in at first run.
- **ADR-027 Opaque ObjectKeys in API paths:** Broker objects are identified in URL paths by ObjectKey = base64url(utf8(vhost) + NUL + utf8(name)), produced and parsed by helpers in contracts. Human names appear only in bodies, query results and logs.

## Core interfaces

```ts
// =============================================================================
// Core interfaces (illustrative signatures; split across @app/domain, @app/contracts,
// @app/live-protocol, libs/engine/ports, libs/engine/semantics/*, libs/sdk/decoder-sdk)
// =============================================================================
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Duplex } from 'node:stream';
import type { SecureContextOptions } from 'node:tls';

// ----------------------------------------------------------------------------- domain
export type Brand<T, B extends string> = T & { readonly __brand: B };
export type ProfileId = Brand<string, 'ProfileId'>;
export type PlanId = Brand<string, 'PlanId'>;
export type PlanHash = Brand<string, 'PlanHash'>;
export type ActionId = Brand<string, 'ActionId'>;
export type JobId = Brand<string, 'JobId'>;
export type CaptureId = Brand<string, 'CaptureId'>;
export type MessageCopyId = Brand<string, 'MessageCopyId'>;
export type BlobRef = Brand<string, 'BlobRef'>;                 // 'sha256:<hex>'
export type TapId = Brand<string, 'TapId'>;
export type ReceiptId = Brand<string, 'ReceiptId'>;
export type SecretId = Brand<string, 'SecretId'>;
export type OperationId = Brand<string, 'OperationId'>;         // e.g. 'peek.plan'
export type PermissionId = Brand<string, 'PermissionId'>;       // e.g. 'message.peek'
export type CapabilityId = Brand<string, 'CapabilityId'>;       // e.g. 'cap.firehose.http'
export type SemanticsEntryId = Brand<string, 'SemanticsEntryId'>;
export type ObjectKey = Brand<string, 'ObjectKey'>;             // base64url(vhost NUL name) — ADR-027
export type WarningId = `W-${string}`;                           // W-BUDGET, W-OVERLIMIT, W-CRASH …
export type HazardId = `HZ-${string}`;                           // HZ-15182, HZ-17255 …
export type ConformanceTestId = `CT-${string}`;
export type EpochMs = number;
export type SemVer = `${number}.${number}.${number}${string}`;

export type Era = '3.13' | '4.0-4.2' | '4.3' | '4.4';
export type QueueType = 'classic' | 'quorum' | 'stream' | 'unknown';
export type Protocol = 'amqp091' | 'amqp10' | 'stream' | 'http';
export type EnvironmentClass = 'local' | 'dev' | 'test' | 'staging' | 'prod';
export type Effect = 'read' | 'side-effect' | 'mutation' | 'destructive';
export type LimitState = 'unset' | 'finite' | 'minus-one' | 'unlimited';

export interface SourceRef { kind: 'S' | 'D' | 'RN' | 'GH' | 'R' | 'M3' | 'ED' | 'LAB'; ref: string; confidence: 'H' | 'M' | 'L' }
export interface Evidence { probe: string; observed: unknown; at: EpochMs }

export interface Clock { now(): EpochMs; monotonicMs(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> }
export interface Logger { debug(o: object, msg?: string): void; info(o: object, msg?: string): void; warn(o: object, msg?: string): void; error(o: object, msg?: string): void; child(b: object): Logger }

/** Bounded buffers are the only buffers services may use (invariant I-6). */
export interface BoundedRing<T> { push(item: T, bytes: number): { evicted: number }; drain(max: number): T[]; readonly size: number; readonly bytes: number; readonly dropped: number }
export interface TokenBucket { take(n?: number, signal?: AbortSignal): Promise<void>; readonly ratePerSec: number }

// ----------------------------------------------------------------------------- BrokerProfile (DC-31)
export interface TlsFacts { protocol: string; cipher: string; sans: string[]; notAfter?: EpochMs; chainTrusted: boolean; sniUsed?: string }
export interface ObjectRefLite { kind: 'queue' | 'exchange' | 'binding' | 'policy' | 'operator-policy' | 'user' | 'vhost'; vhost?: string; name: string }
export interface CapabilityGate { state: 'enabled' | 'degraded' | 'disabled'; reason?: string; source?: SourceRef; userFix?: string }

export interface BrokerProfile {
  readonly schemaVersion: 1;
  readonly profileId: ProfileId;
  readonly probedAt: EpochMs;
  readonly probeMs: number;
  readonly registryVersion: string;
  readonly product: { name: 'rabbitmq' | 'lavinmq' | 'tanzu' | 'apsaramq' | 'unknown'; version?: SemVer; build: 'oss' | 'commercial-or-unknown'; managementApi: 'present' | 'absent' };
  readonly provider: { kind: 'self-hosted' | 'amazon-mq' | 'cloudamqp-shared' | 'cloudamqp-dedicated' | 'ibm' | 'k8s-operator' | 'bitnami' | 'unknown'; evidence: Evidence[] };
  readonly cluster: {
    name?: string;
    nodes: Array<{ name: string; version?: SemVer; running: boolean; beingDrained?: boolean; enabledPlugins?: string[]; authMechanisms?: string[] }>;
    mixedVersions: boolean;
    loadBalancer: { suspected: boolean; distinctNodesSeen: number };
    metadataStore?: 'mnesia' | 'khepri';
  };
  readonly era: EraResolution;                                   // DC-02
  readonly identity: { user: string; tags: string[]; roles: { administrator: boolean; monitoring: boolean; policymaker: boolean; management: boolean; protectedUser?: boolean } };
  readonly stats: { disabled: boolean; queueTotals: boolean };
  readonly flags: { featureFlags: Record<string, 'enabled' | 'disabled'>; deprecatedFeaturesInUse: string[]; ff43Enabled: boolean | 'unknown' };
  readonly topologyFacts: { exchangeTypes: string[]; defaultQueueType?: QueueType; classicQueueTypeEnabled?: boolean };
  readonly extensions: { tracing: boolean; shovel: boolean; federation: boolean; streamUi: boolean; top: boolean; eventExchange: boolean | 'unknown' };
  readonly listeners: Array<{ node: string; protocol: string; port: number }>;
  readonly endpoints: {
    prometheus: Array<{ node: string; url: string; source: 'provider' | 'listener' | 'default' | 'user'; auth: 'none' | 'basic' | 'bearer' }>;
    stream?: { advertised: Array<{ host: string; port: number; reachable: boolean | 'unknown' }> };
  };
  readonly restrictions: { operatorPolicyChanges: 'allowed' | 'disabled' | 'unknown'; qqReplicaOps: 'allowed' | 'disabled' | 'unknown'; definitionsUploadCapBytes?: number };
  readonly limits: {
    frameMax?: number; channelMax?: number; heartbeatS?: number;
    connectionsMax?: number; channelsPerConnectionMax?: number; consumersPerChannelMax?: number; maxMessageSizeBytes?: number;
    provenance: Record<string, 'handshake' | 'provider-preset' | 'error-signature' | 'user'>;
  };
  readonly auth: {
    oauth?: { issuer: string; clientId?: string; scopes?: string[]; pinned: boolean; discoveredVia: 'bootstrap.js' | '/api/auth' };
    preAuthFrameMaxBytes: 4096 | 8192;
    expiry091: 'not-closed' | 'connection-forced';
    amqp10Renewal: 'none' | 'put-auth-tokens';
    separateHttpChain: boolean | 'unknown';
  };
  readonly tls: { mgmt?: TlsFacts; amqp?: TlsFacts };
  readonly hazards: HazardId[];
  readonly capabilities: Readonly<Record<CapabilityId, CapabilityGate>>;
  readonly managedObjects: {                                     // DC-54
    providerOwned: ObjectRefLite[];
    externallyManaged: Array<ObjectRefLite & { manager: 'servicecontrol' | 'wolverine' | 'k8s-topology-operator' | 'nservicebus-policy' | 'other' }>;
  };
}

// ----------------------------------------------------------------------------- era + semantics registry (DC-01, DC-02)
export interface EraInput {
  nodeVersions: Record<string, SemVer | undefined>;
  ff43Enabled: boolean | 'unknown';
  qqMachineVersions?: Record<string, number>;
  build: BrokerProfile['product']['build'];
  canary?: { acquiredHeaderSeen: boolean; deliveryCountAfterTwoNacks?: number };
}
export interface EraResolution {
  era: Era;
  conservative: boolean;
  reasons: Array<{ code: 'node-below-4.0' | 'node-below-4.3' | 'ff-4.3-not-enabled' | 'machine-version-below-8' | 'unknown-build' | 'all-nodes-4.4' | 'canary'; detail: string }>;
}
export declare function resolveEra(input: EraInput): EraResolution;   // PURE

export type SettleAction =
  | 'basic.nack(requeue)' | 'basic.reject(requeue)' | 'amqp10.released' | 'amqp10.modified(df,!uh)' | 'amqp10.modified(!df,!uh)'
  | 'amqp10.rejected' | 'amqp10.modified(uh)' | 'basic.nack/reject(!requeue)' | 'close-while-holding' | 'tcp-loss'
  | 'intra-cluster-partition' | 'basic.cancel' | 'amqp10.detach-unsettled' | 'consumer-timeout'
  | 'http.get.ack_requeue_true' | 'http.get.reject_requeue_true' | 'http.get.reject_requeue_false' | 'http.get.ack_requeue_false';

export interface SettleEffect {
  acquiredCount: 0 | 1;
  deliveryCount: 0 | 1;
  countsTowardLimit: 'yes' | 'no' | 'no-unless-dc-gt-limit' | 'only-if-limit-set';
  position: 'head' | 'tail' | 'original' | 'delayed' | 'dead-lettered-or-dropped' | 'removed' | 'unchanged';
  redeliveredFlag: boolean;
  destructive: boolean;
}
export interface SemanticsEntry {
  id: SemanticsEntryId;
  era: Era; queueType: QueueType; protocol: Protocol; action: SettleAction;
  when?: { limit?: LimitState; delayedRetry?: 'disabled' | 'all' | 'failed' | 'returned' };
  effect: SettleEffect;
  citations: SourceRef[];                // ≥1 enforced by unit test
  conformance: ConformanceTestId[];      // ≥1, must exist in testing/conformance
  status: 'code-derived' | 'lab-verified' | 'lab-contradicted';
  notes?: string;
}
export interface WarningDef { id: WarningId; severity: 'info' | 'warn' | 'consent' | 'block'; textKey: string; textVersion: number; appliesTo: Era[] }
export interface HazardDef { id: HazardId; affected: string /* semver range */; fixedIn?: string; summary: string; gates: CapabilityId[]; lintRule?: string; citations: SourceRef[] }

export interface SemanticsRegistry {
  readonly version: string;                                      // calendar version, stamped into receipts
  settle(q: { era: Era; queueType: QueueType; protocol: Protocol; action: SettleAction; limit?: LimitState; delayedRetry?: SemanticsEntry['when'] extends { delayedRetry?: infer D } ? D : never }): SemanticsEntry;
  warnings(ids?: readonly WarningId[]): WarningDef[];
  hazardsFor(product: BrokerProfile['product'], nodes: BrokerProfile['cluster']['nodes']): HazardDef[];
  capability(id: CapabilityId, profile: BrokerProfile): CapabilityGate;
  peekCaps(era: Era, queueType: QueueType, role: 'user' | 'admin'): { default: number; max: number; maxBytes: number };
  tapRule(exchangeType: string, version?: SemVer): { divertsMessages: boolean; e2eAllowed: boolean; refuseByDefault: boolean; reason?: string };
  toJSON(): unknown;                                             // docs, website matrix, MCP tool descriptions
}

// ----------------------------------------------------------------------------- effective config (DC-30) + routing simulator
export interface PolicyDoc { name: string; vhost: string; pattern: string; applyTo: 'queues' | 'exchanges' | 'all' | 'classic_queues' | 'quorum_queues' | 'streams'; priority: number; definition: Record<string, unknown> }
export interface EffectiveConfigInput { version: SemVer; era: Era; queueType: QueueType; vhost: string; queueName: string; arguments: Record<string, unknown>; policies: PolicyDoc[]; operatorPolicies: PolicyDoc[]; providerDefaults?: PolicyDoc[] }
export interface EffectiveValue { key: string; value: unknown; source: 'argument' | 'policy' | 'operator-policy' | 'merged' | 'default' | 'none'; rule: string; chain: Array<{ from: string; value: unknown; note?: string }> }
export interface EffectiveConfig { values: Record<string, EffectiveValue>; matchedPolicy?: string; matchedOperatorPolicy?: string; warnings: WarningId[] }
export declare function resolveEffectiveConfig(i: EffectiveConfigInput): EffectiveConfig;   // PURE; never presents effective_policy_definition as effective

export interface TopologySnapshot { version: number; exchanges: ReadonlyMap<string, { vhost: string; name: string; type: string; args: Record<string, unknown>; alternateExchange?: string }>; bindingsFrom(vhost: string, exchange: string): ReadonlyArray<{ destinationType: 'queue' | 'exchange'; destination: string; key: string; args: Record<string, unknown> }> }
export interface RoutingInput { vhost: string; exchange: string; routingKey: string; headers?: Record<string, unknown>; cc?: string[]; bcc?: string[]; mandatory: boolean }
export interface RoutingResult {
  routed: Array<{ queue: string; path: Array<{ kind: 'binding' | 'e2e' | 'ae' | 'default-exchange'; from: string; to: string; key?: string; args?: Record<string, unknown> }> }>;
  probabilistic: Array<{ exchange: string; type: string; candidates: string[] }>;
  unroutable: boolean; returnedToPublisher: boolean; warnings: WarningId[]; hazards: HazardId[];
}
export interface RoutingSimulator { simulate(i: RoutingInput, topo: TopologySnapshot, era: Era, version?: SemVer): RoutingResult }   // PURE

// ----------------------------------------------------------------------------- principal, operations, gateway (DC-42)
export interface Principal {
  kind: 'desktop-user' | 'local-token' | 'team-user' | 'api-token' | 'mcp-client' | 'job' | 'system';
  id: string; display: string;
  transport: 'messageport' | 'http' | 'socket' | 'internal';
  unattended: boolean;                                           // MCP, jobs, alert automations ⇒ true
  roles: string[];
  onBehalfOf?: Principal;
  brokerIdentity?: 'delegated' | 'vault-dynamic' | 'personal' | 'service-account' | 'profile';
}
export interface OperationDefinition<I = unknown, O = unknown> {
  id: OperationId;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: `/api/v1/${string}`;
  input: { params?: StandardSchemaV1; query?: StandardSchemaV1; body?: StandardSchemaV1<I> };
  output: StandardSchemaV1<O>;
  effect: Effect;
  permission: PermissionId;
  capabilities?: CapabilityId[];
  planning: 'none' | 'optional' | 'required';                    // side-effect | destructive ⇒ 'required'
  audit: 'none' | 'outcome' | 'attempt+outcome';
  idempotency: 'natural' | 'key-required' | 'none';
  lane: 'interactive' | 'bulk';
  timeoutMs: number;
  mcp?: { expose: boolean; defaultEnabled: boolean; approval: 'never' | 'always' };
  docs: { summary: string; sideEffects?: string };
}
export declare function defineOperation<I, O>(def: OperationDefinition<I, O>): OperationDefinition<I, O>;

export interface ResourceScope { profileId?: ProfileId; envClass?: EnvironmentClass; vhost?: string; objectKind?: string; objectName?: string; messageCount?: number }
export type PolicyDecision =
  | { allow: true; obligations: Array<'mask-payloads' | 'audit-attempt' | 'require-dry-run' | 'require-typed-confirmation'> }
  | { allow: false; code: 'denied' | 'needs-approval' | 'capability-disabled' | 'environment-guardrail'; reason: string; missingPermission?: PermissionId };
export interface PolicyEngine { authorize(p: Principal, op: OperationDefinition, scope: ResourceScope): PolicyDecision }   // PURE

export interface GateResult { id: string; outcome: 'pass' | 'warn' | 'consent' | 'block'; warning?: WarningId; detail: string; fix?: { operationId: OperationId; input: unknown } }
export interface ConsentRequirement { id: string; kind: 'budget' | 'hazard' | 'typed-confirmation' | 'approval'; text: string; expected?: string }
export interface ConsentBundle { planHash: PlanHash; accepted: Array<{ consentId: string; typed?: string }>; approvals?: string[] }
export interface PlanEnvelope<P = unknown> { planId: PlanId; planHash: PlanHash; operationId: OperationId; plan: P; expiresAt: EpochMs; consentsRequired: ConsentRequirement[]; gates: GateResult[]; dryRun?: unknown }
export type ActionResult<O> =
  | { kind: 'done'; actionId: ActionId; output: O; receipt?: SideEffectReceipt }
  | { kind: 'job'; actionId: ActionId; jobId: JobId }
  | { kind: 'pending-approval'; actionId: ActionId; approvalId: string };

export interface HandlerContext { principal: Principal; signal: AbortSignal; clock: Clock; log: Logger; profile?: BrokerProfile; registry: SemanticsRegistry }
export interface OperationHandler<I, P, O> { plan?(ctx: HandlerContext, input: I): Promise<{ plan: P; gates: GateResult[]; consents: ConsentRequirement[]; dryRun?: unknown }>; execute(ctx: HandlerContext, inputOrPlan: I | P, consent?: ConsentBundle): Promise<O | { jobId: JobId }> }

export interface OperationGateway {
  query<O>(opId: OperationId, input: unknown, p: Principal, signal: AbortSignal): Promise<O>;                      // effect 'read'
  plan<P>(opId: OperationId, input: unknown, p: Principal, signal: AbortSignal): Promise<PlanEnvelope<P>>;          // preflight I/O + pure planner
  execute<O>(req: { planId: PlanId } | { opId: OperationId; input: unknown }, p: Principal, consent: ConsentBundle | undefined, signal: AbortSignal): Promise<ActionResult<O>>;
  state(): 'accepting' | 'draining' | 'stopped';
}

// ----------------------------------------------------------------------------- receipts (DC-15)
export interface SideEffectReceipt {
  id: ReceiptId; actionId: ActionId; operationId: OperationId; registryVersion: string;
  era: Era; method: string; startedAt: EpochMs; holdMs: number;
  perMessage: Array<{ copy: MessageCopyId; settle: SettleAction; semantics: SemanticsEntryId; acDelta: 0 | 1; dcDelta: 0 | 1; position: SettleEffect['position']; rescued?: 'quarantined' | 'raised-limit' }>;
  returnPath: 'explicit-nack+barrier' | 'released+drain' | 'server-side' | 'channel-down' | 'connection-lost';
  confidence: 'code-derived' | 'lab-verified';
  warnings: WarningId[];
}

// ----------------------------------------------------------------------------- peek planner + executor (b.8, DC-03..16)
export type RescueOption =
  | { kind: 'let-broker-handle' }                                // forbidden when principal.unattended (DC-09)
  | { kind: 'quarantine'; queue: string }                        // confirm-copy on publish connection, then ack with proof
  | { kind: 'raise-limit'; policyName: string };                 // admin; finite on 4.0-4.2
export interface PeekRequest { profileId: ProfileId; vhost: string; queue: string; count: number; maxBytes?: number; previewBytes?: number; rescue?: RescueOption; prefer?: 'amqp091' | 'amqp10-fast' | 'http-fallback' }
export interface PreflightSnapshot {
  takenAt: EpochMs;
  queue: {
    type: QueueType; durable: boolean; exclusive: boolean; exclusiveOwnedByUs: boolean; autoDelete: boolean; arguments: Record<string, unknown>;
    messagesReady?: number; messageBytesReady?: number; consumers: number; activeConsumerTag?: string; sac: boolean;
    leader?: string; members?: string[]; online?: string[];
    deliveryLimit: number | 'unlimited' | 'missing';             // from the stat, never recomputed (DC-13)
    delayedRetry?: { type: 'disabled' | 'all' | 'failed' | 'returned'; minMs?: number; maxMs?: number }; messagesDelayed?: number;
  };
  effective: EffectiveConfig;
  dlqSources: Array<{ sourceQueue: string; sourceLimit: number | 'unlimited'; strategy: 'at-most-once' | 'at-least-once' }>;
  alarms: { memory: boolean; disk: boolean };
  rttMs: number;
}
export interface PeekPlan {
  planId: PlanId; planHash: PlanHash; expiresAt: EpochMs; registryVersion: string;
  era: Era; queueType: QueueType;
  method: 'basic.get' | 'amqp10.credit-drain' | 'http.get.ack_requeue_true';
  settle: { action: SettleAction; multiple: boolean; barrier: 'basic.qos' | 'drain' | 'server-side' };
  count: number; maxBytes: number; parallelChannels: 1 | 2 | 3 | 4;
  hold: { targetMs: number; hardAbortMs: number; derivedFrom: Array<'default' | 'ttl/4' | 'qq-timeout/4' | 'channel-timeout-90s'> };
  guard: { counter: 'x-delivery-count' | 'x-acquired-count'; doomedWhen: '>' | '>='; limit: number | 'unlimited'; stopAtFirstDoomed: true };
  rescue: RescueOption;
  gates: GateResult[]; warnings: WarningId[]; consentsRequired: ConsentRequirement[];
  expectedEffects: Array<{ semantics: SemanticsEntryId; effect: SettleEffect }>;
  connectionRole: 'peek';
}
export type PeekPlanResult = { kind: 'plan'; plan: PeekPlan } | { kind: 'refused'; gates: GateResult[] };
export interface PeekPlanner {                                   // PURE, deterministic
  plan(req: PeekRequest, ctx: { profile: BrokerProfile; preflight: PreflightSnapshot; principal: Principal; registry: SemanticsRegistry; now: EpochMs }): PeekPlanResult;
}
export interface MessageCopyRef { id: MessageCopyId; seq: number; sizeBytes: number; bodyRef?: BlobRef; previewTruncated: boolean; counters: { deliveryCount?: number; acquiredCount?: number; redelivered: boolean }; doomed?: boolean }
export interface PeekOutcome { captureId: CaptureId; copies: MessageCopyRef[]; stoppedBy: 'count' | 'bytes' | 'empty' | 'guard' | 'watchdog' | 'target' | 'abort' | 'broker-error'; receipt: SideEffectReceipt }
export interface PeekExecutor {
  execute(plan: PeekPlan, consent: ConsentBundle, signal: AbortSignal): Promise<PeekOutcome>;
  abortAll(reason: 'shutdown' | 'suspend' | 'cancel'): Promise<{ flushed: number; failed: number }>;   // DC-04 nack-flush
}

// ----------------------------------------------------------------------------- tap planner (DC-17..19)
export interface TapQueueSpec {
  name: string;                                                  // `<prefix>.tap.<ulid>`; never 'amq.*'
  exclusive: true; autoDelete: true; durable: false;
  args: { 'x-queue-type': 'classic'; 'x-max-length': number; 'x-overflow': 'drop-head'; 'x-message-ttl': number; 'x-expires': number };
}
export interface TapRequest { profileId: ProfileId; vhost: string; target: { kind: 'queue' | 'exchange'; name: string }; mode?: 'copied-binding' | 'e2e' | 'firehose'; acceptDiversion?: boolean; capture: { maxMessages: number; maxBytes: number; bodyCapBytes: number; sampling?: 'all' | 'every-nth'; persist: 'session' | 'saved' } }
export interface TapPlan {
  planId: PlanId; planHash: PlanHash; mode: 'copied-binding' | 'e2e' | 'firehose';
  queue: TapQueueSpec; bindings: Array<{ source: string; key: string; args: Record<string, unknown> }>;
  matchedPolicies: string[];
  badges: Array<'default-exchange-blind' | 'ae-masking' | 'mandatory-masking' | 'unroutable-metric-masking' | 'partial-node-local' | 'diversion'>;
  gates: GateResult[]; warnings: WarningId[];
  consumer: { prefetch: number; ackEveryN: number; ackEveryMs: number }; leaseMs: number;
}
export interface TapPlanner { plan(req: TapRequest, ctx: { profile: BrokerProfile; topology: TopologySnapshot; effectiveFor(queueName: string): EffectiveConfig; alarms: { memory: boolean; disk: boolean }; principal: Principal; registry: SemanticsRegistry }): { kind: 'plan'; plan: TapPlan } | { kind: 'refused'; gates: GateResult[] } }

// ----------------------------------------------------------------------------- dialer, trust, protocol ports (DC-43/44/48)
export type DialPurpose = 'broker-mgmt' | 'broker-amqp' | 'broker-stream' | 'prometheus' | 'oidc' | 'jwks' | 'vault' | 'k8s' | 'webhook';
export interface DialTarget { profileId: ProfileId; host: string; port: number; tls?: { servername?: string; ca: 'defaults' | 'defaults+profile'; insecure?: boolean; clientCert?: SecretId } }
export interface Dialer {
  dial(t: DialTarget, purpose: DialPurpose, signal: AbortSignal): Promise<Duplex>;                     // policy + connect-time DNS validation
  undiciConnector(t: DialTarget, purpose: DialPurpose): unknown;                                       // for undici Agent({ connect })
  localForwarder(t: DialTarget, purpose: DialPurpose): Promise<{ path: string; close(): Promise<void> }>; // for libraries that cannot take a socket
}
export interface EgressPolicy { evaluate(host: string, resolved: readonly string[], port: number, purpose: DialPurpose): { allow: boolean; rule: string } }
export interface TrustStore { install(): void; contextFor(profileId: ProfileId): SecureContextOptions; diagnose(t: DialTarget): Promise<TlsFacts & { chain: string[]; errors: string[] }> }

export type Lane = 'interactive' | 'live' | 'background';
export interface MgmtHttpPort {
  request<T>(spec: { profileId: ProfileId; method: 'GET' | 'PUT' | 'POST' | 'DELETE'; path: string; query?: Record<string, string | number | boolean>; body?: unknown; schema: StandardSchemaV1<T>; lane: Lane; timeoutMs?: number }, signal: AbortSignal): Promise<T>;
  stream(spec: { profileId: ProfileId; path: string; query?: Record<string, string | number | boolean>; lane: Lane }, signal: AbortSignal): Promise<{ status: number; headers: Record<string, string>; chunks: AsyncIterable<Uint8Array> }>;
  /** DC-10/DC-55: ackmode is fixed to ack_requeue_true (+ requeue:true on LavinMQ); count ≤ 50. */
  getMessagesFallback(spec: { profileId: ProfileId; vhost: string; queue: string; count: number; truncate: number }, signal: AbortSignal): Promise<unknown[]>;
}
export interface PrometheusPort {
  scrape(t: { profileId: ProfileId; node: string; url: string; path: '/metrics' | '/metrics/detailed' | '/metrics/memory-breakdown'; query?: { family?: string[]; vhost?: string[]; queue?: string } }, signal: AbortSignal): Promise<{ status: number; startedAt: EpochMs; chunks: AsyncIterable<Uint8Array> }>;
}

export type ConnectionRole = 'control' | 'peek' | 'publish' | 'consume';
export interface CredentialHandle { readonly key: string; current(): Promise<Credential> }
export interface AmqpConnectSpec { profileId: ProfileId; role: ConnectionRole; vhost: string; connectionName: string; heartbeatS: number; credential: CredentialHandle }

/** Proof objects make destructive settlement impossible to express by accident. */
export interface ConfirmedCopyProof { readonly __proof: 'confirmed-copy'; readonly destination: string; readonly confirmedAt: EpochMs }
export interface DestructiveConsentProof { readonly __proof: 'destructive-consent'; readonly planHash: PlanHash }

export interface Delivery091 { deliveryTag: number; redelivered: boolean; exchange: string; routingKey: string; properties: Record<string, unknown>; headers: Readonly<Record<string, TypedHeaderValue>>; body: Uint8Array }
export interface Amqp091Port { connect(spec: AmqpConnectSpec, signal: AbortSignal): Promise<Amqp091Connection> }
export interface Amqp091Connection {
  readonly role: ConnectionRole;
  readonly negotiated: { frameMax: number; channelMax: number; heartbeatS: number };
  readonly serverProperties: Record<string, unknown>;
  channel(): Promise<Amqp091Channel>;
  confirmChannel(): Promise<Amqp091ConfirmChannel>;
  updateSecret(token: string, reason: string): Promise<void>;
  on(ev: 'blocked' | 'unblocked' | 'closed' | 'error', cb: (info?: unknown) => void): () => void;
  close(): Promise<void>;
}
export interface Amqp091Channel {
  get(queue: string): Promise<Delivery091 | null>;              // always noAck=false; adapter asserts queue type ≠ stream
  nack(tag: number, opts: { multiple: boolean; requeue: true }): void;          // requeue=false/reject are not expressible (DC-03)
  ack(tag: number, proof: ConfirmedCopyProof | DestructiveConsentProof, opts?: { multiple?: boolean }): void;
  qos(prefetch: number): Promise<void>;                          // global=false; awaited ⇒ barrier (DC-04)
  consume(queue: string, onDelivery: (d: Delivery091 | null /* null = server cancel */) => void, opts: { prefetch: number; exclusive?: boolean; args?: Record<string, unknown> }): Promise<{ consumerTag: string }>;
  ackTap(tag: number, opts: { multiple: boolean }): void;        // only valid on tap-owned queues (adapter checks prefix + ownership)
  cancel(consumerTag: string): Promise<void>;
  declareTapQueue(spec: TapQueueSpec): Promise<void>;
  bindQueue(queue: string, source: string, key: string, args: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
  on(ev: 'close' | 'error', cb: (err?: unknown) => void): () => void;
}
export interface Amqp091ConfirmChannel {
  publish(exchange: string, routingKey: string, body: Uint8Array, props: Record<string, unknown>, opts: { mandatory: boolean }): Promise<{ outcome: 'confirmed'; proof: ConfirmedCopyProof } | { outcome: 'returned' | 'nacked'; reason?: string }>;
  close(): Promise<void>;
}

export interface Amqp10FilterSet {
  streamOffset?: { kind: 'first' | 'last' | 'next' } | { kind: 'offset'; value: bigint } | { kind: 'timestamp'; ms: number } | { kind: 'interval'; value: string };
  bloom?: string[]; matchUnfiltered?: boolean;
  properties?: Record<string, unknown>; applicationProperties?: Record<string, unknown>; sql?: string;
}
export interface Delivery10 { id: number; annotations: Record<string, unknown>; properties: Record<string, unknown>; applicationProperties: Record<string, unknown>; body: Uint8Array; deliveryCount?: number }
export interface StreamCreditOnly { readonly __proof: 'stream-credit' }
export interface Amqp10Port { connect(spec: AmqpConnectSpec, signal: AbortSignal): Promise<Amqp10Connection> }   // hostname 'vhost:<v>'
export interface Amqp10Connection {
  receiver(spec: { address: string /* percent-encoded v2 */; filters?: Amqp10FilterSet; creditMode: 'manual' }): Promise<Amqp10Receiver>;   // credit_window 0 (DC-25)
  refreshToken(token: string): Promise<void>;                    // PUT /auth/tokens (4.1+)
  close(): Promise<void>;
}
export interface Amqp10Receiver {
  readonly appliedFilters: Amqp10FilterSet;                      // from attach reply; compared and fail-closed (DC-23)
  addCredit(n: number): void;
  drain(): Promise<void>;
  deliveries(): AsyncIterable<Delivery10>;
  release(d: Delivery10): void;                                  // the only return outcome exposed (DC-03)
  accept(d: Delivery10, proof: ConfirmedCopyProof | DestructiveConsentProof | StreamCreditOnly): void;
  detach(): Promise<void>;                                       // throws if unsettled deliveries remain (DC-04)
}

export interface ConnectionLease { readonly role: ConnectionRole; readonly amqp091?: Amqp091Connection; readonly amqp10?: Amqp10Connection; release(state: 'healthy' | 'poisoned'): void }
export interface ConnectionManager {
  lease(profileId: ProfileId, role: ConnectionRole, principal: Principal, signal: AbortSignal): Promise<ConnectionLease>;   // queues or 429 when budget exhausted (DC-12)
  budget(profileId: ProfileId): Array<{ role: ConnectionRole; inUse: number; max: number; queued: number }>;
}

// ----------------------------------------------------------------------------- identity + secrets (DC-37..39, DC-45)
export type CredentialKind = 'password' | 'oauth-pkce-loopback' | 'oauth-device-code' | 'oauth-client-credentials' | 'token-command' | 'static-token' | 'x509-external' | 'vault-dynamic' | 'delegated-user';
export interface Credential { kind: CredentialKind; username?: string; secret?: () => Promise<string>; bearer?: () => Promise<string>; expiresAt?: EpochMs; usernameClaim?: string; external?: { certSecret: SecretId } }
export interface CredentialProvider { kind: CredentialKind; acquire(ctx: { profileId: ProfileId; protocol: Protocol; principal: Principal; signal: AbortSignal }): Promise<Credential>; refresh?(c: Credential, signal: AbortSignal): Promise<Credential> }
export interface TokenManager {
  handle(key: { profileId: ProfileId; protocol: Protocol; principalId: string }): CredentialHandle;
  bind(conn: { protocol: Protocol; renew(token: string): Promise<'renewed' | 'reconnect-required'> }, h: CredentialHandle): () => void;   // 75% lifetime; same-username assertion
  preflightSize(token: string, profile: BrokerProfile): WarningId[];                                                                      // 431 / frame_too_large (DC-38)
}
export interface SecretVault {
  seal(plaintext: Uint8Array, aad: string): Promise<SecretId>;
  open(id: SecretId, aad: string): Promise<Uint8Array>;
  destroy(id: SecretId): Promise<void>;
  status(): Promise<{ backend: 'safeStorage' | 'keyring' | 'passphrase' | 'kms' | 'transit' | 'static-kek'; locked: boolean; weak?: 'linux-basic-text' | 'keyutils' }>;
}

// ----------------------------------------------------------------------------- job runner + journal
export interface JournalEntry { seq?: number; kind: 'consumed' | 'published' | 'confirmed' | 'returned' | 'acked' | 'nacked' | 'parked' | 'skipped' | 'uncertain-duplicate' | 'error'; messageKey: string; at: EpochMs; data?: Record<string, unknown> }
export interface JournalWriter { append(e: JournalEntry): Promise<void>; appendBatch(e: readonly JournalEntry[]): Promise<void> }
export interface JobProgress { phase: string; done: number; total?: number; ratePerSec?: number; warnings?: WarningId[] }
export interface JobContext<P, C> {
  jobId: JobId; params: P; checkpoint: C | undefined; principal: Principal;
  signal: AbortSignal;                                           // cancel and drain
  journal: JournalWriter;
  saveCheckpoint(c: C): Promise<void>;                           // durable before the next ack-side effect
  budget: TokenBucket; clock: Clock; log: Logger;
}
export interface JobDefinition<P, C, R> {
  kind: string; version: number;
  params: StandardSchemaV1<P>; checkpoint: StandardSchemaV1<C>;
  concurrency: { perProfile: number; global: number };
  resumable: boolean;
  run(ctx: JobContext<P, C>): AsyncGenerator<JobProgress, R, void>;
  onDrain?(ctx: JobContext<P, C>, deadlineMs: number): Promise<void>;
}
export interface JobRecord { id: JobId; kind: string; version: number; state: 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled'; params: unknown; checkpoint?: unknown; progress?: JobProgress; leaseOwner?: string; leaseUntil?: EpochMs; attempts: number; planHash?: PlanHash; principal: Principal }
export interface JobStore {
  create(rec: Omit<JobRecord, 'id' | 'state' | 'attempts'>): Promise<JobId>;
  claim(owner: string, leaseMs: number, kinds: readonly string[]): Promise<JobRecord | undefined>;   // FOR UPDATE SKIP LOCKED on PG
  heartbeat(id: JobId, owner: string, leaseMs: number): Promise<boolean>;
  saveCheckpoint(id: JobId, c: unknown): Promise<void>;
  finish(id: JobId, outcome: 'succeeded' | 'failed' | 'cancelled', result?: unknown): Promise<void>;
}
export interface JobRunner {
  register<P, C, R>(def: JobDefinition<P, C, R>): void;
  submit<P>(kind: string, params: P, p: Principal, opts?: { idempotencyKey?: string; planHash?: PlanHash }): Promise<JobId>;
  command(id: JobId, cmd: 'pause' | 'resume' | 'cancel-graceful' | 'cancel-abort'): Promise<void>;
  drain(deadlineMs: number): Promise<{ paused: JobId[]; aborted: JobId[] }>;
}

// ----------------------------------------------------------------------------- live protocol + transports (DC-35)
export type SubId = number;
export type Qos = 'lossless' | 'latest' | 'sampled';
export interface Problem { type: string; code: string; title: string; status: number; detail?: string; traceId?: string; retryable?: boolean; gates?: GateResult[]; missingPermission?: PermissionId; capability?: CapabilityId; source?: SourceRef; brokerError?: { protocol: Protocol; classId?: number; code?: number | string; text?: string } }
export type ClientFrame =
  | { t: 'hello'; protocol: 1; client: { kind: 'desktop' | 'web' | 'cli'; version: string }; resume?: { sessionId: string } }
  | { t: 'sub'; sid: SubId; topic: string; params: unknown; credit: number; opts?: { maxHz?: number; maxBatch?: number; sampling?: 'all' | 'every-nth' | 'latest' } }
  | { t: 'credit'; sid: SubId; n: number }
  | { t: 'unsub'; sid: SubId }
  | { t: 'ping'; ts: number }
  | { t: 'http.req'; id: number; method: string; url: string; headers: Record<string, string>; body?: Uint8Array | string }
  | { t: 'http.abort'; id: number };
export type ServerFrame =
  | { t: 'welcome'; sessionId: string; protocol: 1; engineVersion: string; limits: { maxSubs: number; maxFrameBytes: number; outboxBytes: number } }
  | { t: 'subok'; sid: SubId; qos: Qos; snapshot?: unknown }
  | { t: 'data'; sid: SubId; seq: number; items: unknown[]; dropped?: number; sampledEvery?: number }
  | { t: 'state'; sid: SubId; status: 'live' | 'paused' | 'stalled' | 'degraded' | 'ended'; reason?: string }
  | { t: 'gap'; sid: SubId; fromSeq: number; toSeq: number; reason: 'overflow' | 'resume-unavailable' }
  | { t: 'error'; sid?: SubId; problem: Problem }
  | { t: 'pong'; ts: number }
  | { t: 'goaway'; reason: 'drain' | 'version-mismatch' | 'auth-expired'; reconnectAfterMs?: number }
  | { t: 'http.res'; id: number; status: number; headers: Record<string, string>; body?: Uint8Array | string; streamed?: boolean }
  | { t: 'http.chunk'; id: number; body: Uint8Array; last: boolean };

// UI side (libs/web/transport) — runs inside the engine-link Web Worker
export interface EngineTransport {
  readonly kind: 'messageport' | 'websocket';
  connect(): Promise<Extract<ServerFrame, { t: 'welcome' }>>;
  http(req: { method: string; url: string; headers: Record<string, string>; body?: Uint8Array | string }, signal?: AbortSignal): Promise<{ status: number; headers: Record<string, string>; body?: Uint8Array | string }>;
  subscribe<I>(topic: string, params: unknown, opts?: { maxHz?: number; maxBatch?: number; window?: number }): LiveSubscription<I>;
  onState(cb: (s: 'connecting' | 'open' | 'reconnecting' | 'closed') => void): () => void;
}
export interface LiveSubscription<I> {
  batches(): AsyncIterable<readonly I[]>;                        // pulling grants credits automatically
  stats(): { received: number; dropped: number; sampledEvery: number };
  status(): 'pending' | 'live' | 'paused' | 'stalled' | 'degraded' | 'ended';
  close(): void;
}
export interface PlatformBridge {
  readonly kind: 'electron' | 'browser';
  enginePort?(): Promise<MessagePort>;                           // electron only
  appInfo(): Promise<{ version: string; mode: 'desktop' | 'local-web' | 'team'; platform: string }>;
  openExternal(url: string): Promise<'opened' | 'blocked'>;      // allow-list + confirmation
  pickSaveTarget(opts: { suggestedName: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<{ fileToken: string } | null>;  // engine writes the file
  notify(n: { title: string; body: string; actionId?: string }): Promise<void>;
  writeClipboard(text: string): Promise<void>;
  onCommand(cb: (commandId: string) => void): () => void;        // native menu → command registry
}

// Engine side (libs/engine/services/live)
export interface LiveConnection { readonly kind: 'messageport' | 'websocket'; send(f: ServerFrame): void; onFrame(cb: (f: ClientFrame) => void): void; onClose(cb: () => void): void; close(code: number, reason: string): void; bufferedBytes(): number }
export interface TopicSource<I> { snapshot?(): Promise<unknown>; onItems(cb: (items: readonly I[]) => void): void; coalesceKey?(item: I): string; close(): void }
export interface LiveTopic<P, I> { name: string; params: StandardSchemaV1<P>; item: StandardSchemaV1<I>; qos: Qos; permission: PermissionId; caps: { maxHz: number; maxBatch: number; maxFrameBytes: number }; open(params: P, ctx: { principal: Principal; signal: AbortSignal }): TopicSource<I> }
export declare function defineTopic<P, I>(t: LiveTopic<P, I>): LiveTopic<P, I>;
export interface LiveHub { register<P, I>(t: LiveTopic<P, I>): void; attach(conn: LiveConnection, principal: Principal): { sessionId: string }; drain(deadlineMs: number): Promise<void> }
export interface TunnelServer { attach(conn: LiveConnection, principal: Principal): void }   // http.req → app.inject({ payloadAsStream })

// ----------------------------------------------------------------------------- inventory, search, metrics, capture
export type FilterExpr = { op: 'and' | 'or'; of: FilterExpr[] } | { field: string; cmp: 'eq' | 'ne' | 'lt' | 'gt' | 'glob' | 'regex' | 'in'; value: unknown };
export interface InventoryQuery { profileId: ProfileId; kind: 'queue' | 'exchange' | 'binding' | 'vhost' | 'policy' | 'connection' | 'consumer'; filter?: FilterExpr; sort?: Array<{ field: string; dir: 'asc' | 'desc' }>; window: { offset: number; limit: number }; snapshot?: number; columns?: string[] }
export interface InventoryPage<Row> { rows: Row[]; total: number; snapshot: number; asOf: { metadata: EpochMs; counts: EpochMs | null }; stale: boolean }
export interface InventoryService {
  query<Row>(q: InventoryQuery, p: Principal): Promise<InventoryPage<Row>>;        // RBAC row filtering inside the index worker
  watchWindow(sessionId: string, profileId: ProfileId, keys: readonly ObjectKey[]): void;
  refresh(profileId: ProfileId, scope: { vhost?: string; kind?: InventoryQuery['kind'] }, lane: Lane): Promise<void>;
}
export interface SearchIndex { search(profileId: ProfileId, q: string, opts: { kinds?: string[]; limit: number }): Promise<Array<{ key: ObjectKey; kind: string; label: string; score: number; highlights: Array<[number, number]> }>> }

export interface SeriesKey { profileId: ProfileId; metric: string; labels: Record<string, string> }
export interface MetricsDemand { views: SeriesKey[]; pins: SeriesKey[]; alertSelectors: Array<{ profileId: ProfileId; metric: string; selector: Record<string, string> }> }
export interface ScrapePlan { perNode: Array<{ node: string; url: string; path: '/metrics' | '/metrics/detailed'; query?: { family?: string[]; vhost?: string[]; queue?: string }; intervalMs: number }> }
export interface ScrapePlanner { plan(profile: BrokerProfile, demand: MetricsDemand, cost: ReadonlyMap<string, { lastDurationMs: number; lastBytes: number }>): ScrapePlan }   // PURE
export interface MetricsStore {
  query(q: { keys: SeriesKey[]; from: EpochMs; to: EpochMs; stepMs: number }): Promise<Array<{ key: SeriesKey; points: Float64Array /* t,v pairs */ }>>;
  watch(keys: readonly SeriesKey[], reason: 'view' | 'alert' | 'pin'): () => void;
}
export type AlertExpr =
  | { kind: 'threshold'; metric: string; selector: Record<string, string>; op: '>' | '<'; value: number }
  | { kind: 'absent-consumers'; selector: Record<string, string> }
  | { kind: 'drain-eta'; selector: Record<string, string>; maxMs: number }
  | { kind: 'broker-health'; check: 'alarm' | 'node-down' | 'quorum-critical' | 'health-check' };
export interface AlertRule { id: string; scope: ResourceScope; expr: AlertExpr; forMs: number; severity: 'info' | 'warning' | 'critical'; routes: string[] }

export interface CapturedMessageRow { id: MessageCopyId; seq: number; receivedAt: EpochMs; exchange?: string; routingKey?: string; queue?: string; sizeBytes: number; bodyRef?: BlobRef; contentType?: string; framework?: string; fingerprint?: string; counters: MessageCopyRef['counters']; deathSummary?: string }
export interface CaptureStore {
  open(session: { kind: 'peek' | 'tap' | 'stream' | 'dlq'; profileId: ProfileId; target: string; persist: 'session' | 'saved'; encrypt: boolean; limits: { maxMessages: number; maxBytes: number } }): Promise<CaptureId>;
  append(id: CaptureId, batch: ReadonlyArray<{ properties: Record<string, unknown>; headers: Record<string, TypedHeaderValue>; body: Uint8Array; meta: Partial<CapturedMessageRow> }>): Promise<{ accepted: number; droppedIndex: number; droppedBody: number; sampled: number }>;
  query(id: CaptureId, q: { text?: string; filter?: FilterExpr; window: { offset: number; limit: number } }): Promise<{ rows: CapturedMessageRow[]; total: number }>;
  readBody(ref: BlobRef, range: { offset: number; length: number }): Promise<Uint8Array>;
  close(id: CaptureId): Promise<void>;
}

// ----------------------------------------------------------------------------- audit (team system of record, DC-40)
export interface AuditEvent { seq?: bigint; id: string; ts: EpochMs; actor: Principal; actionId: ActionId; operationId: OperationId; phase: 'attempt' | 'outcome'; resource: ResourceScope; paramsDigest: string; planHash?: PlanHash; approvalId?: string; outcome?: 'ok' | 'denied' | 'failed'; problemCode?: string; receiptId?: ReceiptId; prevHash?: string; hash?: string }
export interface AuditLog { append(e: AuditEvent): Promise<{ seq: bigint; hash: string }>; query(f: { from?: EpochMs; to?: EpochMs; actorId?: string; profileId?: ProfileId; operationId?: OperationId }): AsyncIterable<AuditEvent>; verifyChain(fromSeq?: bigint): Promise<{ ok: boolean; brokenAt?: bigint }> }

// ----------------------------------------------------------------------------- decoder / codec SDK (DC-53) — @<product>/decoder-sdk
export type TypedHeaderValue =
  | { t: 'string' | 'long' | 'int' | 'short' | 'byte' | 'double' | 'float' | 'bool' | 'timestamp' | 'decimal' | 'bytes' | 'void'; v: unknown }
  | { t: 'array'; v: TypedHeaderValue[] }
  | { t: 'table'; v: Record<string, TypedHeaderValue> };
export interface DecodeInput {
  contentType?: string; contentEncoding?: string;
  properties: Readonly<Record<string, unknown>>;
  headers: Readonly<Record<string, TypedHeaderValue>>;
  body: Uint8Array; bodyTruncated: boolean;                      // detect() sees ≤ 64 KiB; decode() ≤ 16 MiB
  source: { queue?: string; exchange?: string; routingKey?: string; protocol: Protocol };
  era: Era;
}
export interface DeathRecord { queue: string; reason: 'rejected' | 'expired' | 'maxlen' | 'delivery_limit'; count: number; firstTime?: EpochMs; lastTime?: EpochMs; exchange?: string; routingKeys?: string[]; scheduledNotFailed?: boolean }
export interface DecodedFailure {
  framework: string; messageId?: string; logicalIds: Record<string, string>;
  exception?: { type?: string; message?: string; stack?: string; frames?: string[] };
  failedAt?: EpochMs; sourceQueue?: string; retryCount?: number;
  deaths: DeathRecord[];
  infra?: { isDelayInfrastructure: boolean; kind?: string };
  payload?: { contentType: string; preview: string };
}
export interface ReplayPlanHint {
  destination: { queue: string; via: 'default-exchange' } | { exchange: string; routingKey: string; fanOutConfirmed: false };
  resolution: 'framework-field' | 'x-death-newest' | 'naming-convention' | 'x-original' | 'user-mapping';
  stripHeaders: string[]; preserveIds: string[]; warnings: string[];
}
export interface DecoderPlugin {
  readonly apiVersion: 1; readonly id: string; readonly version: string; readonly frameworks: readonly string[];
  detect(input: DecodeInput): number;                            // 0..1
  decode(input: DecodeInput): DecodedFailure;                    // never unpickles / PHP-unserializes
  fingerprint(d: DecodedFailure): string;
  replayPlan(d: DecodedFailure, ctx: { knownQueues: ReadonlySet<string> }): ReplayPlanHint | null;
}
export interface CodecPlugin {
  readonly apiVersion: 1; readonly id: string; readonly version: string;
  detect(input: DecodeInput): number;
  decode(input: DecodeInput): { kind: 'json' | 'text' | 'tree' | 'binary'; value: unknown };
  encode?(value: unknown, opts?: unknown): Uint8Array;
}
export declare function defineDecoder(p: DecoderPlugin): DecoderPlugin;
export declare function defineCodec(p: CodecPlugin): CodecPlugin;
```

## Repo layout

```text
<product>/                                    # monorepo root (Apache-2.0); "RabbitMQ"/"RMQ" appear in no identifier (DC-57)
├─ AGENTS.md                                   # primary agent guide (<200 lines): invariants I-1..I-12, generators, verify commands
├─ CLAUDE.md                                   # "@AGENTS.md" import + Claude-specific notes
├─ .claude/
│  ├─ rules/*.md                               # path-scoped rules (engine/, web/, desktop/, semantics/, adapters/)
│  ├─ hooks/                                   # format+lint on edit; affected typecheck/test on Stop
│  └─ skills/                                  # add-operation, add-semantics-cell, add-decoder, run-conformance
├─ docs/
│  ├─ adr/ADR-001..027.md                      # decisions (template: context, decision, alternatives, consequences)
│  ├─ architecture/                            # this blueprint split per section + diagrams
│  ├─ semantics/                               # GENERATED from the registry (era × type × action pages)
│  └─ site/                                    # Starlight docs + published compatibility matrix (from conformance results)
├─ apps/
│  ├─ engine/                                  # NestJS 12 composition root (no @nx/nest); esbuild → engine.mjs + worker bundles
│  │  ├─ src/entry/{desktop,local,server}.ts   # the ONLY place mode differences live (with modules/)
│  │  ├─ src/modules/                          # Nest modules = wiring only (useFactory: ports → adapters)
│  │  ├─ src/http/generated/                   # GENERATED controllers from the operation registry (do not edit)
│  │  ├─ src/edge/                             # transport auth guards, Host/Origin/Sec-Fetch checks, Problem filter
│  │  ├─ src/tunnel/                           # MessagePort TunnelServer (app.inject, payloadAsStream)
│  │  ├─ src/listeners/                        # serverFactory: TCP + Unix socket/named pipe; ws upgrade handler
│  │  └─ src/workers/{storage,capture,metrics,index,codec,plugin}.ts   # worker entrypoints (only place node:sqlite is imported)
│  ├─ web/                                     # Angular 22 app shell (one build for all modes; runtime config)
│  ├─ desktop/                                 # Electron 45 main: lifecycle, app:// protocol, windows, menus, tray,
│  │                                           #   EngineSupervisor wiring, safeStorage bridge, powerMonitor, updater (opt-in)
│  └─ cli/                                     # @<product>/cli: serve | mcp | lint | topology plan/apply | doctor
├─ libs/
│  ├─ shared/
│  │  ├─ contracts/                            # zod schemas, defineOperation/defineTopic, Problem, ObjectKey, config schemas
│  │  │  ├─ src/ops/<domain>/*.op.ts           # one file per operation
│  │  │  ├─ src/topics/*.topic.ts
│  │  │  └─ openapi/v1.json                    # committed snapshot (oasdiff gate)
│  │  ├─ domain/                               # ids, Era, Principal, permissions, BoundedRing/Queue, TokenBucket
│  │  ├─ live-protocol/                        # frames + pure credit/coalesce/sample/gap state machines
│  │  ├─ worker-rpc/                           # typed RPC over MessagePort-like endpoints
│  │  └─ commands-manifest/                    # command ids, titles, default keybindings (palette + native menus)
│  ├─ engine/
│  │  ├─ ports/                                # every port interface + DI tokens
│  │  ├─ runtime/                              # logger+redaction, config, BrokerScheduler, DrainCoordinator, loop monitor, worker host
│  │  ├─ semantics/
│  │  │  ├─ registry/src/data/*.data.ts        # settle-matrix, counters, dlx-carryover, delayed-retry, hazards, capabilities,
│  │  │  │                                     #   warnings, peek-caps, tap-rules, provider-presets, effective-config, framework-registry
│  │  │  ├─ era/  effective-config/  routing/  # pure resolvers / simulator
│  │  │  ├─ peek-planner/  tap-planner/  replay-planner/  lint-rules/
│  │  ├─ services/{actions,live,connections,identity,probe,inventory,peek,tap,capture,publish,dlq,streams,
│  │  │            topology,admin,metrics,alerts,lint,topology-code,jobs,audit,authz,secrets,mcp,plugins}/
│  │  └─ adapters/{mgmt-http,amqp091,amqp10,stream,prometheus,dialer,truststore,k8s,oidc,persistence-sqlite,
│  │               persistence-pg,blobstore-fs,secrets-electron,secrets-keyring,secrets-passphrase,secrets-envelope,notify}/
│  ├─ web/
│  │  ├─ ui-kit/                               # @app/ui: Spartan helm (copied, MIT notice), tokens, Tailwind 4 preset, Aria wrappers
│  │  ├─ widgets/{grid,graph,flow,editor,charts,payload}/   # sole importers of ag-grid / cytoscape+elk asset / foblex / monaco / uplot+echarts
│  │  ├─ transport/                            # EngineTransport (MessagePort|WS), engine-link worker, LiveClient, EngineHttpBackend, bridges
│  │  ├─ api-client/                           # GENERATED by Orval 8.43.0 (committed; CI freshness check)
│  │  ├─ commands/                             # CommandRegistry, KeybindingService (tinykeys), palette
│  │  ├─ data-access/<domain>/                 # SignalStores, resources, view models
│  │  └─ features/{connections,explorer,queue,peek,tap,publish,dlq,streams,topology,policies,admin,metrics,
│  │               alerts,lint,topology-code,jobs,audit,team-admin,approvals,settings,ai}/   # lazy routes
│  ├─ desktop/{preload,bridge-contract,engine-supervisor}/
│  └─ sdk/decoder-sdk/                         # published @<product>/decoder-sdk (types, defineDecoder/defineCodec, harness, header registry JSON)
├─ plugins/first-party/{generic,masstransit,spring,nservicebus,easynetq,celery}/   # v1.0 decoders on the public SDK (+ fixtures)
├─ testing/
│  ├─ broker-lab/                              # Dockerfiles per version (plugins, 5552/15692, TLS, OAuth), Testcontainers helpers,
│  │                                           #   3-node + HAProxy + toxiproxy compose
│  ├─ fixtures/{mgmt/<version>/, messages/<framework>/, prometheus/}   # golden fixtures (nightly refresh diff)
│  ├─ fakes/                                   # in-memory ports; synthetic 100k-queue mgmt API + 400k-series Prometheus; team load gen
│  ├─ conformance/                             # PUBLIC suite (DC-47): CT-* tests ↔ registry cells; results JSON → website matrix
│  ├─ oracle-amqp10/                           # differential oracle (coders51 client, rhea overridden to 3.0.5) — DC-24
│  ├─ e2e-web/  e2e-team/  e2e-desktop/        # Playwright 1.64.1 (desktop uses the test-fused Electron binary)
│  ├─ perf/  chaos/  visual/                   # budgets (section 0.2), toxiproxy/leader-transfer, Storybook screenshots + axe
├─ tools/
│  ├─ generators/                              # Nx local generators: operation, live-topic, adapter, service, feature, semantics-cell,
│  │                                           #   lint-rule, decoder, migration, conformance-test
│  ├─ eslint-rules/                            # boundaries + per-project import confinement, no-broker-version-compare,
│  │                                           #   no-mode-branching, explicit-inject, honest-wording (DC-15)
│  ├─ supply-chain/                            # licence gate (DC-50), git-URL lockfile check (DC-24), banned packages,
│  │                                           #   deps-allowlist.json, THIRD_PARTY_NOTICES generator
│  └─ codegen/                                 # openapi/asyncapi emit + oasdiff, orval config, registry → docs, config → values.schema.json
├─ deploy/
│  ├─ docker/                                  # Dockerfile (node:24-trixie-slim build → distroless nodejs24-debian13:nonroot); compose examples
│  └─ helm/<product>/                          # chart (values.schema.json GENERATED), templates, ci/ values for chart-testing
├─ electron-builder.config.ts                  # release profile (fuses off: RunAsNode, NodeOptions, NodeCliInspect; ASAR integrity on)
├─ electron-builder.test.config.ts             # test-fused profile (never published)
├─ nx.json · pnpm-workspace.yaml (catalogs, minimumReleaseAge, onlyBuiltDependencies) · package.json
├─ tsconfig.base.json (TypeScript 6.0.3, strict) · eslint.config.mjs · renovate.json · release-please-config.json
└─ .github/workflows/{ci,conformance-nightly,perf-nightly,chaos-nightly,release,codeql,scorecard}.yml   # actions pinned by SHA
```

## Risks

- The semantics registry is wrong in some cells. Every b.2/b.4 cell is code-derived and none has been lab-tested, so plans, warnings and receipts could misstate side effects. → Make the conformance suite the M0–M2 critical path, starting with the fact sheet's priority uncertainty list. Link every cell to its CT tests, and have a lab contradiction fail CI and flip the cell's status. Receipts carry a confidence field (code-derived or lab-verified). Era resolution stays conservative (DC-02).
- Under Raft leader changes or load, a nack plus qos barrier may be overtaken by the channel-close DOWN signal. On 4.3 that would still record failed deliveries. → Spike S-11: a chaos suite running thousands of peeks under leader transfers and toxiproxy faults, asserting DC deltas. If the race is confirmed, linger after the barrier before closing, prefer AMQP 1.0 released+drain on 4.3, and make W-CRASH wording explicit in receipts.
- Event-loop starvation on the engine I/O thread delays peek watchdogs, heartbeats and nack flushes, which turns performance problems into message-safety problems. → Invariant I-5: CPU and SQLite work run in workers, large bodies are streamed to the parsing workers, and lint bans node:sqlite and large JSON.parse on the loop. A CI gate holds monitorEventLoopDelay p99 ≤ 20 ms under combined sweep and tap load.
- NestJS 12 (a new ESM major) misses the cold-start budget in an Electron utilityProcess, or its ecosystem lags (nestjs-zod, @nx/nest). → Keep Nest at the edge only and keep services framework-free. Use explicit DI tokens and an esbuild bundle. Spike S-01 has an exit criterion; the fallback generates Fastify-only routes from the same operation registry.
- Management API cost at 50k–100k queues. Each paged request re-sorts the full list (code-level), and enable_queue_totals may be expensive, so sweeps could load brokers. → Prometheus-first counts. Cost-adaptive sweep cadence targeting about 2 % of broker time. Per-vhost sharding, and a choice between paged and unpaged requests from measured cost (S-04). Event-exchange and series-membership triggers. A single concurrent background request per broker, with AIMD backoff.
- Prometheus scrape volume at scale: ~12 MB per node per detailed scrape and hundreds of brokers on a team server. → Demand-driven ScrapePlanner (aggregated only unless views, pins or alerts need per-queue data). Family and vhost filters, and queue= regex on 4.3+. Streaming parse in the metrics worker. Interval ≥ 10 × scrape duration. Offer remote PromQL for teams that already run Prometheus.
- Memory blow-ups from captures, 10 MiB payloads and large inventories, in the desktop engine or renderer. → Rings bounded by count and bytes everywhere (I-6). Spill to disk via the capture worker. Truncation defaults, with bodies fetched in 1 MiB chunks. The UI windows everything (I-7). Engine heap cap. Inventory residency LRU on the team server. Perf gates on RSS.
- Single-maintainer protocol libraries (amqplib about 84 % one author; rhea one npm maintainer) and no Node client testing against 4.3. → Put every client behind a port (DC-48). Run the contract suite against @cloudamqp/amqp-client as an alternate. Pin exactly. Be ready to vendor or fork (MIT and Apache licences). Our own conformance CI covers 4.3 and nightly alphas. Contribute upstream PRs.
- The in-house AMQP 1.0 adapter is complex: credit, drain, settlement, described filters, link races. → A minimal API surface (manual credit only, release as the only return outcome, detach throws if anything is unsettled). Per-link open listeners. Differential tests against the coders51 oracle and conformance tests on 4.0–4.3. Filter-set verification fails closed (DC-23).
- Windows named-pipe default security (the default DACL grants Everyone read) weakens the local CLI/MCP channel. → Defence in depth: a randomised pipe name published only in a user-only token file under LOCALAPPDATA, plus a scoped capability token on every request. Spike S-07 decides whether a small native helper is needed to set a strict DACL.
- Firehose tracing is left enabled after an engine crash. It is node-local, not persisted by the broker, and costs CPU. → Durable lease records written before enabling, with maximum lease durations. Reconciliation at engine start and team-server restart. A per-node re-verification loop. Generated switch-off runbooks. Admin-only access with approvals in team mode.
- Cross-user data leakage on the team server (shared caches, captures, inventories). → Per-user capture ownership and per-session encryption. No cross-user body caches. RBAC row filtering inside the index worker. Per-user delegated pools. Shared monitors restricted to metadata and metrics. Dedicated isolation tests in e2e-team.
- Coding agents introduce drift: they install npm 'latest' (TS 7, @types/amqplib), hallucinate packages or bypass layers. → Exact pins via pnpm catalogs, minimumReleaseAge, a dependency allow-list, lockfile and licence gates. Nx tag boundaries and per-project import confinement. Generators as the default path. Architecture tests (gateway-only reachability, no mode branching, no version compares). CODEOWNERS on sensitive areas.
- Third-party decoder plugins are not really sandboxed. Worker threads are not a security boundary, and on Node 24 the permission model does not cover workers or the network. → Treat plugins as trusted code: opt-in on the desktop with a warning, integrity-hash allow-listing on the team server, no native addons, resource and time limits for robustness, and honest documentation. Plan an isolated plugin-host process for Node 26 runtimes.
- MessagePort transport limits: no transport backpressure, copies through structured clone, invisible to devtools, port re-wiring on reload. → Credits and bounded outboxes are mandatory (ADR-005). Sampling caps the UI rate. Bodies stream in 1 MiB chunks. A dev-only Transport Inspector. Re-wiring is covered by desktop E2E. Spike S-02 measures throughput and latency.
- node:sqlite is a release candidate: possible Electron or Node regressions, and the Node 26 API rename. → An in-repo dialect with contract tests on Node 24.22, Node 26.12 and Electron's Node. Runtime detection of Database ?? DatabaseSync. better-sqlite3 13.0.3 as a drop-in fallback behind the same interface. Spike S-03.
- AG Grid licence or feature changes, or performance limits at 100k rows with live updates. → An adapter isolates AG Grid. We build the context menu, clipboard and status bar ourselves. TanStack Table v9 is the swap-in. The infinite row model with engine windows keeps the DOM and data small. Spike S-09 sets frame budgets.
- The signing and distribution pipeline is not feasible as planned: SignPath reputation and its 'no hacking tools' clause, MSIX packaging with a utilityProcess engine, notarisation cost. → Store MSIX is the first-class Windows channel. Frame the linter strictly as hygiene for brokers the user has connected to, with no scanning (DC-56). Spike S-14 for MSIX. Budget $99/yr for Apple from day one. Linux defaults to deb/rpm because AppImage hits the Ubuntu 24.04 sandbox issue.
- Version churn across the stack: Electron every 8 weeks (Electron 46 kill and safeStorage changes), Angular yearly, Orval weekly, Node 24 entering maintenance. → Pins plus Renovate groups with stability days. CI on Node 24.22, Node 26.12 and Electron's Node. SIGTERM self-drain and escalation already compatible with Electron 46. Only the async safeStorage API is used. Upgrades are deliberate PRs.
- Token and IdP variability: 431 errors on large tokens, ephemeral loopback ports unsupported by Okta and Auth0, Entra token-version and audience mismatches. → TokenManager size preflight and Bearer preference. IdP presets and validators. Fixed-port and device-code fallbacks. Lab tests with Keycloak 26 and an Entra tenant. Delegated mode documented with token-exchange and OBO recipes.
- Team-server v1 is a single replica, so a pod failure interrupts live sessions and pollers until the restart. → Fast restart, with durable jobs and journal resuming from checkpoints. Session resume within 30 s. Documented v1 limits and recovery objectives. The HA design (broker-shard leases, internal mesh) is specified so it can be added without changing the interfaces.
- Trademark or naming conflicts, including misuse of 'RabbitMQ' in identifiers and branding. → DC-57 enforced by a lint and CI scan across package names, image and chart names and binaries. Coined non-rabbit brand. Attribution and non-affiliation text in the README, About dialog and site. Trademark clearance before release.
- Privacy expectations: any phone-home (update checks, crash uploads) breaks the no-telemetry promise and SignPath conditions. → Update checks are opt-in at first run with a privacy notice. Crash reports stay local unless the user configures an upload target. OTel is off by default and only goes to user endpoints. A desktop E2E runs behind a deny-all egress proxy and fails on unexpected connections (I-12).
