# Architecture proposal: simplicity-first

> One of three competing proposals scored by two judges ([judges.md](judges.md)). The final blueprint is [../blueprint.md](../blueprint.md). Kept for traceability; not normative.

**Philosophy.** Simplicity and agent-velocity first. One engine bundle, one Angular build, one contract, one router, one policy-enforced action layer, one job runner, one live protocol, and one way to add code (Nx generators). Prefer boring, mature pieces (Fastify 5, Kysely, amqplib, pino, node:sqlite/Postgres) and explicit composition over framework magic: no DI container, no decorators, no runtime reflection. Version-dependent broker behaviour is data (the semantics registry), not code paths. Anything that can be a pure function is one, in an isomorphic library the UI can reuse. Anything that touches the world sits behind a port with a fake in testkit. Every rule an agent must follow is enforced by a tool (module-boundary lint, banned-dependency checks, contract snapshots, conformance coverage), not by prose. All of this sits inside the binding decisions (TypeScript, Node 24, Angular 22, three delivery modes, fully open source) and DC-01..DC-60.

## Summary

A modular monolith in an Nx 23 + pnpm monorepo. One Node 24 ESM engine bundle runs in three hosts: an Electron 45 utilityProcess (desktop), a loopback Node process started with npx or Docker (local web), and a container backed by Postgres (team server). One Angular 22 build (zoneless, signals, SignalStore, Spartan/CDK/Aria + Tailwind 4) is served by every host.

Contract: each action is defined once in @app/contracts with zod 4. The definition carries its input and output, permission, risk, two-phase flag, and its HTTP, MCP and CLI bindings. Topics for the live protocol are defined the same way. OpenAPI 3.1 and AsyncAPI 3.0 are generated from these definitions and gated with snapshots and oasdiff. The Angular client takes its types straight from the contracts, so there is no Orval codegen.

Engine: Fastify 5.12.5 alone, with a small in-house contract router and a hand-written composition root per mode. NestJS 12 was evaluated and rejected (ADR-002).

Transports: desktop honours DC-35 by sending the same REST router over a MessagePort. The Angular side uses a custom HttpBackend, and the engine side runs fastify.inject. No TCP listener is opened for the UI. Local web and team modes use HTTP plus one multiplexed WebSocket. The live protocol uses credits for backpressure, with bounded rings, conflation and sampling. The CLI and the stdio MCP shim reach the engine over a permission-protected named pipe or Unix socket.

Safety: every UI, CLI, MCP and job request goes through one ActionExecutor. It handles authentication, RBAC, guardrails by environment class, two-phase plan/execute with consents, typed confirmations, four-eyes approvals, side-effect receipts and hash-chained audit. Peek is an atomic engine job planned from the data-driven BrokerSemantics registry (era x queue type x settle action). It uses a mandatory HTTP preflight, a post-acquire guard with rescue, a nack plus basic.qos barrier and a watchdog. Connections are separated by role per broker profile.

Storage: Kysely over node:sqlite (desktop and local) and Postgres (team), with envelope-encrypted secrets.

Other pieces:
- Prometheus-first metrics with SQLite/Postgres rollups and forecasts.
- Data-first decoders run in a worker-thread plugin host.
- A public conformance suite on Testcontainers.
- Signed, notarised releases with no telemetry.

The appendices hold a DC traceability table, the M0 spikes and an agent-sized milestone plan.

# <Product> for RabbitMQ(R): architecture blueprint (v1)

Status: proposed, 2026-10-16. Internal workspace scope: `@app/*`, which is never published. `<Product>` and `<product>` are brand placeholders (DC-57: no "rabbitmq" or "rmq" in any identifier). Pins follow fact sheet section (m).

**Core rules**
- One engine bundle, one UI build, one contract, one router, one action layer.
- Desktop UI-to-engine traffic uses a MessagePort.
- All broker I/O stays in the engine (DC-34).

---

## 1. Process model per delivery mode

### 1.1 Desktop (Electron 45.0.x; 44.8.0 until GA on 2026-10-20)

```
+---------------------------- Electron app -----------------------------------------------+
| MAIN (thin, trusted)                                                                     |
|  app:// protocol (asar dist/web, CSP header + nonce, SPA fallback, traversal checks)      |
|  windows, menus (built from the UI command registry), safeStorage (async), openExternal  |
|  allow-list, powerMonitor, before-quit, crash supervisor                                 |
|      | parentPort control channel: init/ready/dek/shutdown/suspend/resume/openExternal/  |
|      | notify/resolveProxy                                                               |
|      v                                                                                   |
| ENGINE utilityProcess (Electron Node 24.22, BoringSSL)                                   |
|  Fastify app with NO TCP listener; contract router -> ActionExecutor -> modules          |
|  PortSessionServer <==== MessagePort (MessageChannelMain) ====> RENDERER (sandboxed,     |
|                                                                 contextIsolation)        |
|  live hub (credits/rings)     preload: forwards port to main world via window.postMessage|
|  Dialer -> brokers (AMQP 0-9-1/1.0, HTTPS mgmt, Prometheus); Angular 22: MessagePort     |
|    HttpBackend + LiveChannel                                                             |
|  node:sqlite (WAL) in userData                                                           |
|  worker_threads: plugin/codec pool, search worker                                        |
|  IPC listener: named pipe / Unix socket (CLI + stdio MCP shim), capability tokens        |
+------------------------------------------------------------------------------------------+
```

**Startup**
1. `app.whenReady()` runs first. `utilityProcess.fork` is legal only after `ready`.
2. Main calls `utilityProcess.fork(engine.mjs, ['--mode=desktop'], {serviceName, stdio:'pipe', env: minimal})`.
3. Main reads the wrapped DEK, unwraps it with `safeStorage.decryptStringAsync`, and posts `init{paths, dek, settings}` on the private parentPort. The DEK never reaches the renderer.
4. The engine opens the DB, migrates, starts modules (target: ready in 400 ms or less; spike S2) and posts `ready`.
5. For each renderer load (including reloads), main creates a `MessageChannelMain` and sends `child.postMessage({t:'ui-port'}, [port1])` and `webContents.postMessage('engine-port', null, [port2])`.
6. The preload forwards the port with `window.postMessage('engine-port', 'app://main', event.ports)`. The Electron docs prescribe this because, under contextIsolation, IPC is delivered to the isolated world.
7. The engine authenticates the port session with a per-launch UI token.
8. The port's `close` event, which Electron adds to MessagePortMain, ends that UI session. Leased resources (taps, jobs) outlive the UI session until their lease expires.

**Shutdown** (DC-04, DC-46)
1. `before-quit` is prevented once. Main posts `shutdown`.
2. The engine runs `drain(2s)`:
   - stop accepting actions;
   - `PeekExecutor.flushAll()` sends an explicit `nack(multiple, requeue)` and then a synchronous `basic.qos` barrier per holder;
   - replay and move `source` consumers flush the same way;
   - taps cancel their consumers (copies in exclusive tap queues need no flush);
   - jobs checkpoint;
   - the engine writes a WAL checkpoint and calls `process.exit(0)` from its own SIGTERM/`shutdown` handler.
3. Main waits up to 5 s for `exit`. Then it calls `child.kill()`, which only sends SIGTERM from Electron 46. If that fails, it uses `process.kill(pid,'SIGKILL')`.

**Sleep/resume**
- On `powerMonitor suspend`, main posts `suspend`. The engine:
  - flushes holders;
  - closes `observe`/`source` connections cleanly;
  - pauses pollers and jobs, with a checkpoint.
- On `resume`, the engine reconnects, re-probes the BrokerProfile, resumes jobs and sends `status:stale -> active` on live subscriptions.

**Crash**
- Main restarts the engine with exponential backoff (at most 3 in 60 s), then shows an error page with "export diagnostics".
- On start, the engine reconciles write-ahead records:
  - a `peek_started` without a `peek_settled` produces an "interrupted" receipt (W-CRASH: held messages got DC+1 on 4.3, AC+1 on 4.0-4.2);
  - expired firehose leases are switched off;
  - orphaned tap exchanges are swept (DC-18);
  - jobs resume from their checkpoints.
- A renderer crash triggers a reload only. The engine is unaffected.

### 1.2 Local web (npx or Docker)

```
Browser tab --HTTP + WS--> 127.0.0.1:PORT
  engine --mode=local (same bundle; serves dist/web)
  - SQLite file in the user config dir (or a Docker volume)
  - IPC pipe/socket for CLI + MCP shim

CLI: npx <product> serve  -> prints http://127.0.0.1:PORT/#token=<256-bit>
Docker: docker run -p 127.0.0.1:PORT:PORT ...  (token always required)
```

- Shutdown on SIGINT/SIGTERM uses the same drain.
- Plain Node has no powerMonitor. A clock-jump detector (5 s ticker; a gap over 30 s means resume) triggers re-probe and reconnect.
- One engine per data dir, enforced by a lock file that records the pipe path.

### 1.3 Team server (Docker/Helm)

```
Browsers --HTTPS (Ingress / Gateway API HTTPRoute, TLS)--> engine --mode=team
                                                           (distroless nodejs24, non-root, 1 replica in v1)
MCP clients --/mcp (OAuth protected resource)------------>   OIDC BFF, RBAC, approvals, audit
CLI (PAT or device code) --/api/v1----------------------->   shared pollers, per-user delegated pools, durable jobs

The engine connects to:
  - PostgreSQL (state, audit, jobs, metrics rollups)
  - KEK provider (file/env, Vault or OpenBao Transit)
  - IdP (discovery/JWKS) and brokers, all through the Dialer egress policy
```

- Startup:
  1. validate config (zod);
  2. migrate under a Postgres advisory lock;
  3. load the KEK;
  4. start modules;
  5. `/readyz` turns true.
- SIGTERM:
  1. `/readyz` turns false;
  2. drain (DC-04) within `terminationGracePeriodSeconds` (30; engine budget 20 s);
  3. exit.
- After a crash, Kubernetes restarts the pod and the same reconciliation runs.

### 1.4 Threads and IPC (all modes)

| Thread | Work |
| --- | --- |
| Main event loop | HTTP, AMQP, actions |
| `plugin-host` worker pool | codecs and decoders (DC-53) |
| `search` worker | read-only node:sqlite connection for FTS5 queries (WAL); Postgres uses the pool |
| On demand | large Prometheus payload parsing |

UI workers (ELK layout, Monaco) live in the browser.

---

## 2. Module map (Nx projects, tags, dependency rules)

### Tags

| Tag | Projects |
| --- | --- |
| `type:contracts` | contracts |
| `type:pure` | domain-model, semantics, effective-config, routing, topology-code, deaths, lint-rules, masking, forecast |
| `type:sdk` | plugin-sdk; self-contained and publishable |
| `type:kernel` | kernel, jobs, live |
| `type:port` | ports |
| `type:adapter` | adapter-*, net-*, persistence, secrets, plugin-host, decoders |
| `type:service` | svc-* |
| `type:transport` | transport |
| `type:app` | engine, web, desktop, cli |
| `type:ui-platform`, `type:ui-data`, `type:ui-design`, `type:ui-lib`, `type:ui-feature` | UI layers |
| `type:test` | testkit, conformance, e2e-*, perf |
| `runtime:isomorphic` / `runtime:node` / `runtime:browser` / `runtime:electron-main` | runtime environment |

### Rules (`@nx/enforce-module-boundaries` plus `no-restricted-imports`)

| From | May depend on |
| --- | --- |
| contracts | zod only |
| pure | contracts, pure (no `node:*`, Angular or protocol libraries) |
| port | contracts, pure |
| kernel | contracts, pure, port |
| adapter | contracts, pure, port, other `net-*` |
| service | contracts, pure, port, kernel, sdk |

Further rules:
- **A service never imports another service or any adapter.** Cross-service needs are declared as ports (for example `BrokerProfileProvider`, `ConnectionLeases`, `CaptureStore`) and wired in the composition root.
- transport depends on kernel, live, contracts and port.
- `apps/engine` may depend on anything engine-side.
- UI direction: feature -> data/design/lib/platform/contracts/pure. A feature never imports another feature; cross-feature navigation goes through router URLs or commands.
- `runtime:browser` never depends on `runtime:node`.
- Globally banned imports:
  - `rabbitmq-amqp-js-client` (test oracle only)
  - `@types/amqplib`
  - `typescript@7`
  - `primeng`, `@primeui/*`
  - `ag-grid-enterprise`
  - `apexcharts`
  - `nestjs-zod`
  - `ngx-monaco-editor-v2`
- Protocol libraries (amqplib, rhea, undici, pg) may be imported only inside their adapter.

### Projects

| Group | Projects |
| --- | --- |
| Shared (isomorphic) | `contracts` (contract kit + actions/topics/errors/config/bridge API) · `domain-model` (object model, BrokerProfile, VersionRange) · `semantics` (DC-01/02 registry) · `effective-config` (DC-30) · `routing` (routing simulator + graph builder) · `topology-code` (normalise/diff/plan/export) · `deaths` (x-death / x-opt-deaths normaliser, replay header rules DC-27/28) · `lint-rules` (DC-56 catalogue) · `masking` · `forecast` · `plugin-sdk` (DC-53) |
| Engine kernel | `kernel` (runtime, config, logger, clock, ids, problems, events, action registry/executor/plans/guardrails/receipts) · `jobs` (runner, journal, token bucket) · `live` (hub, rings, conflation, frames) · `transport` (Fastify builder, contract router, auth hooks, Host/Origin checks, WS endpoint, PortSessionServer, pipe listener, OpenAPI/AsyncAPI emitters, static UI with CSP nonce) |
| Ports | `ports` (every port interface) |
| Adapters | `persistence` (Kysely schema + migrations, in-repo node:sqlite dialect, pg dialect, repositories, FTS5/tsvector search, blob store) · `adapter-mgmt-http` (undici + zod; DC-32/48/55) · `adapter-amqp091` (amqplib 2.2.0 primary; @cloudamqp/amqp-client 4.1.1 secondary for the contract suite) · `adapter-amqp10` (in-house rhea 3.0.5 adapter, DC-22..25) · `adapter-stream` (optional; lazy; rabbitmq-stream-js-client 1.1.0) · `adapter-prometheus` (per-node scraper + streaming parser) · `adapter-k8s` (lazy; @kubernetes/client-node 2.0.0) · `net-dialer` (DC-43; socks 2.8.10, ssh2 1.17.0, system ssh, k8s port-forward) · `net-truststore` (DC-44) · `secrets` (vault + key wraps) · `plugin-host` · `decoders` (built-in, on plugin-sdk) |
| Services | `svc-connections` (profiles, catalog, role-separated pools, managed-by detection DC-54) · `svc-identity` (credential providers, TokenManager, OAuth discovery/pinning) · `svc-capabilities` (probe -> BrokerProfile, gates) · `svc-explorer` (snapshots, deltas, object search index, details) · `svc-peek` (planner + executor + guard/rescue) · `svc-messages` (publish, templates, capture store, export, decode pipeline) · `svc-tap` (taps + firehose) · `svc-dlq` (DLQ centre, replay/move jobs, journal, undo) · `svc-streams` · `svc-topology` (graph, routing simulator, effective-config view, topology-as-code apply) · `svc-admin` (CRUD, definitions, vhost GET-merge-PUT, ops, runbooks) · `svc-metrics` · `svc-alerts` · `svc-lint` · `svc-audit` · `svc-access` (authentication: local token, OIDC BFF, PATs, MCP OAuth resource; authorisation: RBAC, approvals) · `svc-workspace` (views, collections, layouts, settings, keybindings) · `svc-mcp` |
| UI | `ui-platform` (EngineTransport, PlatformBridge + implementations) · `ui-data` (EngineApi, engineResource, LiveClient, global stores) · `ui-design` (tokens, Tailwind preset, Spartan helm copies, Aria wrappers, ThemeService) · `ui-grid` · `ui-graph` · `ui-editor` · `ui-charts` · `ui-commands` · feature libraries `feature-{connections, explorer, messages, tap, dlq, streams, topology, admin, metrics, lint, jobs, governance, settings}` |
| Apps | `engine` · `web` · `desktop` (main + preload + electron-builder) · `cli` (serve, open, mcp, lint, export, doctor) · `conformance` · `e2e-web` · `e2e-desktop` · `perf` |
| Tooling | `tools/generators` (Nx local plugin) · `tools/scripts` (licence gate, git-URL lockfile ban, banned dependencies, notices, snapshots) · `packaging/docker` · `packaging/helm` |

### Uniform service shape

```
src/
  module.ts         createXModule(deps): EngineModule
  actions/*.ts      one implementAction per file
  topics.ts
  jobs/*.ts
  internal/
  *.spec.ts
```

`EngineModule = {id, actions, topics, jobs, onStart, onStop(drain), onSuspend, onResume}`. The composition root lists the modules. Mode files (`modes/desktop|local|team.ts`) differ only in the adapters they wire: store, key wrap, authentication, authorisation policy and listeners. Everything else is in `compose-core.ts`.

---

## 3. API and transport

### 3.1 One contract

`defineAction` takes:

```
{
  id, kind: query|command|peek|job, input, output, permission, risk,
  twoPhase: never|when-gated|always, confirm?, audit, target(input),
  http?: {method, path}, mcp?: {expose, mutating, title, description},
  cli?: {command}, since
}
```

Conventions:
- Every endpoint is exactly one action.
- Path parameters are input fields of the same name.
- GET carries only `kind:query` with flat query inputs; commands use a JSON body.
- No GET mutations (DC-36). A kit unit test enforces this for every action.

`defineTopic` takes `{id, params, item, flow: credit|conflate|snapshot-delta, key?, maxHz?, ring?, permission}`.

Resource map (prefix `/api/v1`):

| Area | Endpoints |
| --- | --- |
| Meta and session | `meta`, `session` |
| Connections | `connections[/{id}]`, `/{id}/profile` (BrokerProfile + gates), `/{id}/probe`, `/{id}/login` |
| Explorer | `/connections/{id}/{overview, nodes, vhosts, queues, exchanges, bindings, consumers, client-connections, channels, policies, operator-policies, users, permissions, limits, parameters, feature-flags, deprecated-features, shovels, federation, definitions}` (list queries support filter, sort and page, or snapshot) |
| Two-phase | `plans` (POST create), `plans/{id}`, `plans/{id}/approvals`, `plans/{id}/execute` |
| Jobs and receipts | `jobs`, `jobs/{id}/{cancel, pause, resume}`, `receipts/{id}` |
| Messages | `peeks/{id}`, `captures`, `captures/{id}/messages?q=`, `messages/{ref}/body`, `templates` |
| Live operations | `taps`, `firehose/nodes` |
| DLQ | `dlq`, `dlq/{ref}/groups`, `replays/{id}/journal` |
| Streams | `streams/{vhost}/{name}/read` |
| Topology | `topology/{graph, subgraph, simulate, effective-config, snapshots, diff, export}` |
| Metrics and lint | `metrics/query`, `metrics/watch`, `alerts/{rules, events, channels}`, `lint/{runs, findings, rules}` |
| Workspace | `views`, `collections`, `layouts`, `settings`, `keybindings` |
| Platform | `plugins`, `semantics/matrix` |
| Team only | `audit`, `users`, `roles`, `role-bindings`, `approvals`, `tokens` |
| Team ops | `/healthz`, `/readyz`, `/livez`, `/metrics` |

Topics:
- `connections.status`
- `explorer.objects` (snapshot-delta)
- `metrics.live` (conflate)
- `tap.messages`, `stream.tail`, `jobs.log` (credit)
- `jobs.progress`, `alerts.events`, `notifications` (conflate)
- `audit.tail` (team)

### 3.2 Serving one contract over three listeners

- **HTTP/TCP** (local and team): Fastify `listen`.
- **Named pipe / Unix socket** (CLI, MCP shim): `http.createServer((req, res) => app.routing(req, res))`. `fastify.routing(req, res)` is documented API. The socket lives in a 0700 directory (Windows: per-user pipe name; never `readableAll`/`writableAll`). Each token comes from a user-only token file with scope `cli` or `mcp`.
- **MessagePort** (desktop): `PortSessionServer` maps `{t:'req', id, method, url, headers, body}` to `app.inject({method, url, headers, payload})` and back to `{t:'res', id, status, headers, body}`. Bodies are structured-clone objects or transferable ArrayBuffers. `{t:'abort', id}` aborts the action's AbortSignal. `{t:'live', ...}` frames go to the live hub.
  - The port server adds `Authorization: Bearer <ui-token>` and `Host: engine.internal`, so the **same auth hook** runs.
  - `inject` is documented "for testing purposes", but production serverless adapters use it (`@fastify/aws-lambda` dispatches every event through `app.inject`, with `payloadAsStream` for large bodies).
  - Large downloads never cross the port: desktop exports are written by the engine to a path chosen through the PlatformBridge save dialog.

### 3.3 DC-35 evaluation: MessagePort vs loopback HTTP/WS

|  | MessagePort tunnelling the REST router (chosen) | Loopback HTTP/WS | Separate RPC over MessagePort |
| --- | --- | --- | --- |
| Attack surface | none on the network (no DNS rebinding, CSRF or LNA; LNA is disabled in Electron anyway) | token, Host/Origin checks, any local process can connect | none |
| Engine code paths | one (the HTTP pipeline via inject) | one | two (RPC dispatch plus REST for web) |
| UI code | HttpClient everywhere; only the HttpBackend and LiveChannel differ | identical | a different client in desktop |
| Validation, errors, policy parity | identical by construction | identical | risk of drift |
| Debuggability | own devtools panel (request log) | DevTools network tab | own panel |
| Extra cost | ~200 LOC UI backend + ~150 LOC port server | token plumbing, port selection, firewall/AV prompts | ~600 LOC plus drift risk |

The Angular backend is overridden with `{provide: HttpBackend, useExisting: MessagePortHttpBackend}`, the same mechanism `provideHttpClientTesting()` uses. `httpResource` therefore works unchanged. A loopback fallback stays behind the same `EngineTransport` interface but is not shipped.

### 3.4 Live protocol (one session per UI: WS or the MessagePort)

```
Client: hello{v:1, resume?} | sub{sid, topic, params, credit} | credit{sid, n} | unsub{sid} | ping
Server: welcome{v, session, engine, heartbeatMs} | data{sid, seq, items, dropped?}
        | snapshot{sid, seq, items} | delta{sid, seq, upserts, removes}
        | status{sid, state: active|paused|degraded|stale, reason?}
        | end{sid, reason, problem?} | pong
```

**Credits are universal**, so backpressure is identical on WS and MessagePort. The MessagePort has no `bufferedAmount`; on WS, `bufferedAmount` is only a secondary slow-client signal.

| Flow | Behaviour |
| --- | --- |
| `credit` | Each subscription owns a ring with item and byte caps (defaults 10k items / 32 MiB). The producer pushes; frames go out only while credit > 0. The UI grants credit after rendering in rAF batches of 200. When the ring is full, the oldest items are dropped and counted. |
| `conflate` | Keeps the latest value per key and flushes at `maxHz` (1-4 Hz); credit is auto-granted per frame. |
| `snapshot-delta` | Object lists: one snapshot, then keyed upserts and removes, coalesced. |
| Sampling | Above the render budget (default 500 items/s), the hub sends every k-th item plus counters while the capture store still persists everything within its caps. |

**Upstream backpressure chain for taps**
1. The tap consumer acks only when items enter the ring.
2. Prefetch fills.
3. The tap queue grows.
4. `x-overflow=drop-head` drops copies in *our* exclusive queue.
5. Production is unaffected.

Bodies travel as previews (4 KiB); full bodies are fetched by `bodyRef`. The WebSocket uses one-time tickets in local mode (`POST /live/tickets`) and the session cookie plus an Origin allow-list in team mode.

### 3.5 Errors and versioning

**Errors** follow RFC 9457 `application/problem+json`: `{type, title, status, code, detail, correlationId, retryable, gate?, warnings?, broker?: {protocol, code, text, classId, methodId}, docs?}`.

Stable `ErrorCode` registry:
- `VALIDATION_FAILED`, `NOT_FOUND`
- `UNAUTHENTICATED`, `FORBIDDEN_RBAC`, `FORBIDDEN_BROKER`
- `GATE_BLOCKED`, `CONSENT_REQUIRED`, `CONFIRMATION_MISMATCH`
- `PLAN_REQUIRED` (428 with `Location` set to the plan), `PLAN_EXPIRED`, `PLAN_STALE`, `APPROVAL_REQUIRED`
- `BROKER_UNREACHABLE`, `BROKER_ERROR`, `BROKER_RESOURCE_LOCKED`, `BROKER_PRECONDITION_FAILED`
- `TOKEN_EXPIRED`, `TOKEN_TOO_LARGE`
- `EGRESS_DENIED`, `TLS_UNTRUSTED`, `CAPABILITY_MISSING`
- `BUDGET_EXCEEDED`, `RATE_LIMITED`
- `ENGINE_SHUTTING_DOWN`, `INTERNAL`

Live `error` and `end` frames carry the same Problem.

**Versioning**
- REST lives under `/api/v1` and changes additively. A breaking change means `/api/v2`, gated by `oasdiff breaking` against the last release.
- The live protocol has its own integer version, and the plugin API has its own integer `apiVersion`.
- The UI and the engine always ship together: the UI is always served by the engine it talks to, so there is no skew. Only the CLI and third parties rely on `/api/v1` stability.
- `GET /meta` returns `apiVersion` and `engineVersion`.

### 3.6 Generation

`nx run contracts:api-docs` emits two files from the registry, using zod 4 `z.toJSONSchema` (draft 2020-12):
- `openapi.v1.json` (OpenAPI 3.1);
- `asyncapi.v1.json` (AsyncAPI 3.0: one `/api/v1/live` channel; messages per frame and topic).

Both are committed. CI regenerates them and fails on any diff.

**No Angular codegen.** `ui-data` exposes:
- `EngineApi.call(action, input)`: builds the URL with `encodeURIComponent` per parameter, and validates with `action.output.parse` in dev builds;
- `engineResource(action, () => input)`: wraps `httpResource` with `parse`;
- `plans.create/execute`;
- `LiveClient.subscribe(topic, params)`.

Third parties can generate clients from the published OpenAPI (for example with Orval); we do not depend on that.

---

## 4. Engine framework

| Criterion | NestJS 12.1.3 (+platform-fastify, without @nx/nest) | Fastify 5.12.5 + in-house contract kit (chosen) | Other: Hono 4 / oRPC 1.15 |
| --- | --- | --- | --- |
| Maturity | 12.0 is 7 weeks old; ESM-only; nestjs-zod and @nx/nest unsupported | v5 mature; `inject`, `routing`, pino and hooks built in | Hono mature; oRPC v2 in beta |
| One contract | controllers repeat paths unless a custom `@Endpoint` decorator is used; swagger `standardSchemaConverter` | the route table *is* the action registry; OpenAPI from the same zod | oRPC is contract-first but not "boring" yet |
| Policy location | guards/interceptors duplicate the action layer that MCP/CLI/jobs need anyway (DC-42) | ActionExecutor only | same |
| Build/cold start | decorator metadata needs tsc/SWC, not esbuild; module scan cost unmeasured vs a ~400 ms budget | esbuild single-file bundle; ms-level boot | small |
| Agent risk | rich priors, but agents reach for class-validator, Passport, nestjs-zod, @ApiProperty (pin hazards, DC-49) | small surface; generators teach the conventions | — |
| DI | container | explicit composition root (type-checked factories) | — |

**Decision:** Fastify only. DC-49 compliance:
- TypeScript is pinned to 6.0.3; TS 7 and `@types/amqplib` are banned.
- amqplib, rhea and zod are pinned exactly.
- Fastify is exactly 5.12.5, the version DC-49 allows.
- @nx/nest is not used.
- The NestJS pin clauses are moot.

Extra pins:
- `@fastify/websocket` 11.3.4 (ws ^8.16);
- `@fastify/static`, pinned at M0.

Revisit only if the team server needs Nest-only ecosystem modules.

**How an agent adds an endpoint**

```
pnpm nx g @app/generators:action queues.purge --module=svc-admin --kind=command \
  --http="POST /connections/{connectionId}/vhosts/{vhost}/queues/{queue}/purge" \
  --permission=queue.purge --risk=high --two-phase=always --mcp=mutating --cli="queues purge"
```

The generator creates:
1. `contracts/src/actions/queues/purge.ts` and adds it to the registry;
2. `svc-admin/src/actions/queues-purge.ts` (`implementAction` with plan/execute stubs);
3. registration in `module.ts`;
4. a unit spec using testkit fakes;
5. an HTTP-level spec using `createTestEngine().inject`.

Verify with `pnpm nx affected -t lint typecheck test` and `pnpm nx run contracts:api-docs-check`. Sibling generators: `topic`, `job`, `service-module`, `adapter`, `ui-feature`, `lint-rule`, `decoder`, `semantics-cell`, `migration`, `conformance-cell`.

---

## 5. Message-safety layer

### 5.1 One action pipeline (DC-42)

Every action follows the same pipeline, whatever its origin (UI, CLI, MCP, job):
1. authenticate the Actor (`user|service|ai|cli|job`, `unattended` flag);
2. validate with zod;
3. `Authorizer.check(permission, target)` (desktop: single-user allow; team: RBAC deny-by-default; MCP scope);
4. `GuardrailPolicy`:
   - env class `production|staging|development|local`;
   - prod is read-only until a 15-minute unlock;
   - a typed confirmation phrase is checked **engine-side**;
   - approvals;
   - AI/unattended restrictions;
   - per-actor token-bucket quotas;
5. if two-phase:
   - `plan()` makes read-only calls only (dry run);
   - the persisted Plan has a 15-minute TTL and holds gates, W-* warnings, required consents, the confirmation phrase, an approvals block and a preview;
   - `execute(planId, consents, confirmation)` re-validates (TOCTOU: `revalidate()`; on change, `PLAN_STALE`);
6. audit `attempt` -> execute with deadline and signal -> `SideEffectReceipt` -> audit `outcome` (hash-chained) -> events.

Direct REST calls to gated commands return 428 with a plan. MCP tools only ever create plans for mutating actions; a human approves in the UI, then the MCP `plan_execute` tool runs. **Peeks are mutations** (DC-42).

### 5.2 Peek planner (HTTP-only preflight, DC-06) and executor

**Era resolution** (`semantics.resolveEra`, DC-02):
- any node below 4.0 -> 3.13;
- any node below 4.3, flag `rabbitmq_4.3.0` off, any QQ member machine version below 8, or an unknown or commercial build -> 4.0-4.2;
- otherwise -> 4.3 (4.4 when all nodes are 4.4 or later).

**Preflight inputs:**
- queue type, exclusive owner, `auto_delete`;
- the real `delivery_limit` stat (DC-13; W-UPGRADED on mismatch);
- DLX/DLQ topology via the routing simulator;
- `delayed_retry` / `messages_delayed` / `next_delayed_at`;
- `x-max-length*` and overflow;
- TTL;
- SAC and active consumers;
- QQ leader, members and online state;
- average message size.

Strategy comes from the registry:

| Queue / era | Method | Settle | Caps (default / max) | Gates |
| --- | --- | --- | --- | --- |
| CQ, all eras | 0-9-1 `basic.get` x n, dedicated `peek` connection | one `nack(last, multiple, requeue)` -> `basic.qos` barrier -> close | 20 / 500, 16 MiB; target 5 s; abort min(30 s, TTL/4, timeout-90 s on 4.2 and earlier); watchdog mandatory on 4.3+ | exclusive (refuse), SAC (W-SAC-CQ), drop-head (W-DROPHEAD), TTL |
| QQ 3.13 | `basic.get` | nack (counts DC) | 20 / 50 | always confirm W-313; W-TAIL if unlimited; `-1` means refuse (DC-16) |
| QQ 4.0-4.2 | `basic.get` over 0-9-1 | nack (counts AC) | 20 / 50 (admin 200) | **W-BUDGET consent every time**; W-TAIL if L=-1; no auto-refresh (DC-08) |
| QQ 4.3+ | `basic.get`; SAC: consumer only when none active, `x-consumer-timeout` = abort budget; alternative: AMQP 1.0 credit N + drain + `released` | nack / released only | 20 / 500, 16 MiB | **W-OVERLIMIT blocks** when a finite L is not above every DLX source's L+1 (DC-07; one-click fix `delivery-limit -1` plus a lint rule); W-DELAY (DC-14) |
| Stream | AMQP 1.0 offset (own adapter) -> 0-9-1 `x-stream-offset` (prefetch 1000 or less, manual ack) -> optional stream protocol; **never `basic.get`** (DC-11) | accept/ack (credit only) | count/bytes/time | anonymous readers only |
| HTTP fallback | `/get` with `ack_requeue_true` only (plus `requeue:true` on LavinMQ, DC-55), count 50 or less, truncate | server-side | 20 / 50 | not offered when over-limit messages are possible (DC-10) |

**Executor**
- One in-flight job per `peek` connection.
- Risky operations run on throwaway channels.
- Each message is copied into the capture store immediately; the UI renders copies only (DC-05).
- **Post-acquire guard** (DC-09). A message is doomed when:
  - 4.3+: `x-delivery-count > L`;
  - 4.0-4.2: `x-delivery-count (=AC) >= L`;
  - 3.13 with a limit: `DC >= L`.

  At the first doomed message the executor stops acquiring and applies the policy chosen beforehand:
  - `stop` (default);
  - `rescue`: copy to a durable classic `<product>.quarantine` queue with confirms on the separate `publish` connection, then ack the original;
  - `raise-limit` (admin: policy, wait for the stat, then nack; finite value on 4.0-4.2);
  - `let-broker-handle`, which the executor refuses for `ai` or `unattended` actors.
- **Never** reject, `modified(df=true)`, rejected/discard, HTTP `reject_*` or `ack_requeue_false`, and never close while holding (DC-03/04).
- The HTTP request lifecycle never controls the hold: the job settles even when the client disconnects.
- A write-ahead `peek_started` record precedes the first `get`.

**Receipt (DC-15):** era, method, settle action, hold ms, per-message `{position, deltaAC, deltaDC, newPosition, outcome}` predicted from the semantics cell plus observed headers, and anomalies. It is stored with the audit record and returned to MCP.

**Wording lint:** a CI test scans `peek.*` i18n keys and fails on "non-destructive" or "read-only" outside the stream and node-agent namespaces.

### 5.3 Taps (DC-17..20)

`TapPlan` contents:
- source exchanges with their types;
- refusals for `x-consistent-hash`, `x-modulus-hash`, `x-random`, `x-local-random` and unknown types unless diversion is accepted; never exchange-to-exchange taps on CHX below 4.3.6;
- binding copies **with arguments**;
- simulated user and operator policy matches for the tap name (warns about reject-publish, DLX policy, max-length);
- `GET /api/health/checks/alarms`;
- classic queue type enabled (4.2+);
- the tap name must fit the user's configure regex.

**Recipe:** `<product>.tap.<uuid>`, exclusive, auto-delete, non-durable, `x-queue-type=classic`, `x-max-length=10000`, `x-overflow=drop-head`, `x-message-ttl=60000`, `x-expires`. Prefetch is about 1000 (per consumer); acks are batched. Bindings are re-synced from explorer deltas. A lease defaults to 10 minutes and is renewed by the UI heartbeat.

**Badges:**
- the default-exchange blind spot;
- AE / mandatory / unroutable masking when the tap matches more than the existing bindings do (DC-19).

**Firehose:**
- admin only, per node, leased with automatic switch-off;
- uses `PUT /api/traces/node/{node}/{vhost}/{name}` when `rabbitmq_tracing` is present, otherwise generated `rabbitmqctl trace_on -n` runbooks;
- never toggled via vhost PUT;
- per-node state is re-verified after restarts;
- labelled "partial" when the cluster is LB-fronted (DC-20).

### 5.4 DLQ replay (DC-27..29, DC-53, DC-54)

A durable job with this sequence:
1. a dedicated **`source`** consumer connection (manual ack, small prefetch; isolated like `peek` because it holds production deliveries);
2. decode with decoders (data-first registry plus code where needed);
3. resolve the destination queue-first (framework field, then the newest rejected/`delivery_limit` x-death, then the naming convention); exchange replay needs a fan-out confirmation; never `x-first-death-queue` alone;
4. strip broker-managed headers;
5. preserve logical IDs; edits get a new ID plus a link header;
6. provenance headers `x-<product>-replay-*` (switchable);
7. publish via the default exchange with `mandatory` on the confirm channel;
8. a `basic.return` counts as a failure;
9. journal `published`;
10. ack the source;
11. journal `acked`.

Further behaviour:
- Throttled by a token bucket; a canary runs first.
- Auto-pause when replay IDs reappear in the DLQ.
- On cancel or shutdown, unprocessed prefetched messages are nacked (requeue) and followed by the qos barrier.
- Resume: when a redelivered message is journaled `published`, it is acked without republishing.
- Undo is an honest re-park of the journaled (encrypted) copies.
- Filtered or group replays stage through a tool-owned classic queue or stream, so no repeated scan-nacks.
- Shovel moves are capability-gated and blocked on 4.3.0-4.3.6.
- Queues managed by other systems (ServiceControl, Wolverine, Topology Operator, provider-owned) are read-only by default.

### 5.5 Guardrail defaults

| Env | Reads/peeks | Writes | Bulk/destructive | AI (MCP) |
| --- | --- | --- | --- | --- |
| production | peek plans require consent; prod chrome | locked; unlock for 15 min plus typed confirm | typed confirm; team: four-eyes | read-only; mutating tools off |
| staging | as dev, plus banner | confirm on high risk | typed confirm | mutating off by default |
| development / local | consents only for hazards | allowed | confirm on critical | admin-enabled |

---

## 6. Data model and persistence

### Stack

**Kysely 0.29.6.**

| Mode | Database | Details |
| --- | --- | --- |
| Desktop and local | `node:sqlite` | in-repo dialect (~30 lines, `Database ?? DatabaseSync`, `readBigInts` for u64 offsets), WAL, FTS5 |
| Team | Postgres 16+ | `pg` 8.23.1, int8 parser to Number for epoch ms; tsvector + GIN |

`better-sqlite3` 13.0.3 is the drop-in fallback behind the same dialect interface.

**Portability rules:**
- one `Database` interface;
- JSON stored as TEXT on both dialects;
- epoch-ms integers;
- UUIDv7 string IDs;
- search and blobs behind ports.

**Migrations:**
- Kysely `Migrator` with TypeScript files and dialect branches;
- run under a lock (file lock / advisory lock);
- CI migrates both dialects up from empty and up from each released schema.

### Entities

| Area | Tables |
| --- | --- |
| Connections | `connection_profiles` (alias ID, env class, colour, endpoints, http/amqp credential refs, TLS, dialer route, owner scope, managed flags), `credentials` (AES-GCM blob + key ID), `broker_profiles` (cache + last snapshot for an instant UI) |
| Workspace | `views`, `collections`, `templates`, `layouts`, `settings`, `keybindings` |
| Captures | `captures` (kind: peek, tap, stream, dlq, export), `captured_messages` (props, headers JSON, masked text, size, hash, decoded summary, blob ref), `captured_messages_fts` (FTS5) or a tsvector column, `blobs` (encrypted; inline up to 16 MiB per message, 512 MiB per capture by default) |
| Plans, jobs, audit | `plans`, `jobs`, `job_journal` (append-only), `receipts`, `audit_events` (seq, prev_hash, hash, ts, actor, action, target, env, phase attempt/outcome, result, receipt_id, masked details) |
| Leases | `leases` (taps, firehose; recovery) |
| Metrics and alerts | `metric_series`, `metric_points` (raw), `metric_rollups` (5m/1h: min/max/avg/last/count), `alert_rules`, `alert_events`, `notification_channels` |
| Team | `users`, `groups`, `roles`, `role_bindings` (subject, role, scope patterns), `sessions`, `api_tokens` (hashed), `approvals`, `delegated_tokens` (envelope-encrypted refresh tokens) |
| Platform | `plugins` (package, version, sha512, enabled, permissions), `data_keys` (wrapped DEKs) |

### Retention defaults

| Data | Desktop/local | Team |
| --- | --- | --- |
| Captures | 7 days or 1 GiB; prod-tagged connections are memory-only unless pinned | 24 h per user |
| Raw metric points | 48 h | 48 h |
| 5-minute rollups | 30 days | 30 days |
| 1-hour rollups | 400 days | 400 days |
| Jobs + journal | 90 days | 90 days |
| Plans | TTL 15 min; executed plans kept with audit | same |
| Audit | 90 days (local activity) | unlimited, configurable |

### Encryption at rest

- Secrets and captured bodies use AES-256-GCM under a DEK (DC-45).
- FTS indexes **masked** decoded text only.
- The SQLite file itself is not encrypted (node:sqlite has no SQLCipher); docs recommend OS disk encryption.
- Team mode adds envelope encryption plus Postgres/platform encryption.

---

## 7. Security model

### Desktop

- No TCP listener for the UI (DC-35).
- The IPC pipe uses OS permissions plus scoped capability tokens rotated at each start (`cli`: full; `mcp`: exposed tools and allowed connections only).
- **DC-46 hardening:**
  - fuses: RunAsNode, NodeOptions, NodeCliInspect and GrantFileProtocolExtraPrivileges off; EmbeddedAsarIntegrityValidation, OnlyLoadAppFromAsar and CookieEncryption on;
  - `sandbox`, `contextIsolation`, `nodeIntegration:false`, `webviewTag:false`;
  - permission handler denies all;
  - `will-navigate` prevented and `setWindowOpenHandler` denies;
  - `shell.openExternal` allow-list (https docs and pinned IdP authorisation endpoints);
  - every IPC sender frame is validated.
- **CSP:**
  ```
  default-src 'none'; script-src 'self'; style-src 'self' 'nonce-N'; img-src 'self' data: blob:;
  font-src 'self'; worker-src 'self' blob:; connect-src 'self'; frame-src 'none';
  base-uri 'none'; form-action 'none'
  ```
  Trusted Types are on if spike S4 passes, otherwise report-only.
- **Secrets:** a DEK wrapped by `safeStorage.*Async` in main. On Linux `basic_text`/`keyutils`, a master password is required (Argon2id if `crypto.argon2` works under BoringSSL, otherwise scrypt; spike S7).
- **OAuth** (DC-39):
  - system browser only; PKCE S256;
  - loopback `http://127.0.0.1:0/cb` listener, single use with a 5-minute TTL, state + nonce;
  - fixed-port or device-code fallback for Okta/Auth0;
  - the issuer is shown, pinned and allow-listed.

### Local web (DC-36)

- Binds 127.0.0.1. A non-loopback bind is refused unless `--auth` (OIDC or hashed basic) and TLS are configured.
- The fragment token moves to sessionStorage and the URL is cleaned. This is the engine token, not a broker credential, so DC-45's localStorage ban is respected.
- `Authorization: Bearer` on every request; WS via one-time tickets.
- Host/Origin allow-lists (`127.0.0.1|localhost|[::1]:PORT`); no CORS headers.
- JSON-only bodies, except token-guarded upload routes.
- Docker docs prescribe `-p 127.0.0.1:...`, and the token is always required in containers.
- **Secrets:** a DEK wrapped by `@napi-rs/keyring` 2.1.1 (Secret Service forced on Linux), otherwise a passphrase, otherwise a KEK file in Docker.

### Team server

- **OIDC BFF** (openid-client 6.8.8, code + PKCE):
  - server-side sessions;
  - `__Host-` cookie, HttpOnly, Secure, SameSite=Lax;
  - CSRF: Origin check plus a required custom header on unsafe methods;
  - session rotation, idle and absolute timeouts.
- PATs are hashed, scoped and expiring. Device-code login for the CLI.
- **RBAC deny-by-default** (DC-40), stricter than the broker. Permissions:
  - `connection.view`, `broker.read`
  - `messages.peek`, `messages.consume`, `messages.read-body`, `messages.unmask`, `messages.publish`, `messages.replay`
  - `queue.purge`, `tap.start`, `firehose.control`
  - `topology.admin`, `policy.admin`, `user.admin`, `catalog.admin`
  - `audit.read`, `approvals.grant`, `mcp.use`, `plugins.admin`, `settings.admin`
- Built-in roles: viewer, developer, operator, admin, auditor. Bindings map IdP groups to roles with connection/vhost/resource patterns.
- **Four-eyes approval** (not self) is required for 4.0-4.2 budget-limited QQ peeks and for bulk replays. Further rules are configurable.
- **Broker credential mode per connection** (DC-41), always intersected with RBAC: delegated OAuth access tokens for the broker audience (never ID tokens), then Vault/OpenBao dynamic, then personal LDAP, then a service account. Each user gets their own pool. The user ID goes into the AMQP `connection_name`.
- **Audit:**
  - append-only (the app DB role has no UPDATE/DELETE on `audit_events`);
  - SHA-256 hash chain with periodic anchor export;
  - JSONL/syslog export.
- **Masking** runs server-side before data leaves the engine (UI, export, MCP, audit).
- **Egress** (DC-43): admin allow-list; private, link-local, metadata and loopback ranges denied by default; DNS validated at connect via a custom lookup; no redirects; the same rules apply to OIDC discovery, JWKS and Vault; plus a Helm NetworkPolicy.
- **Envelope encryption:** the KEK comes from a file/env, Vault Transit or OpenBao Transit; cloud KMS comes in v1.x.

### Across modes

- **TokenManager** (DC-37/38):
  - refresh at 75% of lifetime;
  - assert the username claim is unchanged;
  - 0-9-1 uses update-secret (plus a lazy credentials object for reconnects);
  - AMQP 1.0 uses `PUT /auth/tokens` on 4.1+ and reconnects on 4.0;
  - streams reconnect;
  - HTTP retries a 401 once, for idempotent requests only;
  - on 4.2.5 and earlier, the engine cancels its own consumers at expiry;
  - 320 CONNECTION_FORCED on 4.2.6+ triggers a silent reconnect;
  - token size is checked (header over ~4,000 bytes; PLAIN response over 4096/8192).
- **TrustStore** (DC-44): `tls.setDefaultCACertificates(bundled + getCACertificates('system') + org)`; per-profile CAs are concatenated with the defaults; no leaf pinning; a server-name override; insecure mode needs an explicit switch and shows a banner.
- **MCP** (DC-42):
  - tools come from actions;
  - connections are referenced by human-created aliases only;
  - payloads are quoted, size-capped, stripped of control characters and secret-masked;
  - the team `/mcp` is an OAuth protected resource (RFC 9728 metadata, RFC 8707 audience) with no token passthrough;
  - desktop uses the stdio shim over the pipe; no TCP.
- **Supply chain:**
  - pnpm frozen lockfile;
  - lifecycle scripts blocked except an allow-list (`electron`);
  - CI fails on any git-URL dependency (DC-24);
  - licence gate and notices (DC-50/51);
  - banned-dependency lint (DC-49);
  - `npm audit signatures`;
  - pnpm `minimumReleaseAge`;
  - CycloneDX SBOM, cosign, provenance;
  - Actions pinned by SHA;
  - CODEOWNERS on `svc-peek`, `svc-access`, `secrets`, `net-*`, `apps/desktop`, workflows and Helm;
  - OpenSSF Scorecard.

---

## 8. Metrics architecture (DC-32/33)

**Scrape planner** (inputs: BrokerProfile):
- Endpoint discovery order:
  1. provider adapters (Amazon MQ 16001-16003 per node with broker credentials; CloudAMQP per-node hosts);
  2. `/api/overview` listeners (`http/prometheus`);
  3. defaults (15692/15691; 9419 for Bitnami).
- Scrape **each node directly**, never through a Service or LB.
- Requests: `/metrics/detailed?family=queue_coarse_metrics&family=queue_consumer_count&...&vhost=`; `queue=<regex>` for watched queues on 4.3+ only.
- Amazon MQ: never `/metrics/per-object`, and 60 s or slower.
- Default interval: 15 s for small clusters, adaptive to 60 s.

**Parser:** an in-house streaming Prometheus text parser (zero dependencies, fuzz-tested). Counters become rates by delta, with reset detection.

**Fallback:** management sampling with `?disable_stats=true&enable_queue_totals=true&columns=` for counts, and `message_stats` only when stats are on. Never `disable_stats` on `/api/channels` below 4.3.6. Node resources come from Prometheus.

**Store:**
- in-memory hot window (1 h at full resolution) for live charts;
- persisted raw points and 5m/1h rollups;
- **cardinality caps:** desktop 2,000 queue series (watched plus top-K by backlog or growth); team 20,000 per broker; cluster, node and vhost series are always kept.

**Forecasts** (pure `forecast` lib):
- EWMA rates;
- drain ETA = backlog / (consume - publish) with a band from rate variance;
- when growing, time to max-length or alarm;
- time-to-memory/disk-alarm by linear regression;
- anomaly flags (z-score).

**Alerts:**
- Evaluated per scrape tick.
- Rule types:
  - threshold for a duration;
  - zero consumers with ready > 0;
  - DLQ inflow;
  - ETA;
  - broker alarms;
  - node down;
  - certificate expiry;
  - new high-severity lint finding.
- State machine: inactive -> pending -> firing -> resolved, with dedupe and silences.
- Routing:
  - desktop: native notification via PlatformBridge plus the in-app centre;
  - team: channels (generic webhook, Slack, Teams workflow webhook, PagerDuty Events v2, SMTP) through the Dialer.
- **Why is this queue growing:** a deterministic decision tree over rates, consumers, unacked vs prefetch, redeliveries, alarms and policy limits.

---

## 9. Team-server specifics

**Isolation**
- Per-user sessions, captures, views (shareable on request) and quotas (concurrent taps, peeks per minute, replay msgs/s).
- The catalog is curated by `catalog.admin`. Personal connections are allowed only inside the egress allow-list.

**Shared pollers**
- One probe/explorer/metrics/lint poller per catalog connection, using a monitoring service account. Results are cached and filtered at read time by RBAC scope.
- `visibility: per-user` polls with each user's delegated credentials, for strict tenants.

**Delegated connections**
- User-initiated broker work uses per-user pools.
- Long jobs need either a stored refresh token (envelope-encrypted, revoked at logout) or an admin-approved service-account fallback, which is recorded in the receipt.

**Durable jobs**
- Postgres job store and journal; resume on restart.

**Replicas and HA**
- v1: `replicaCount: 1`, `strategy: Recreate` (no duplicate pollers), `terminationGracePeriodSeconds: 30` with a preStop hook.
- HA path:
  1. stateless HTTP;
  2. leader election for pollers, alerts and the job scheduler via `pg_try_advisory_lock`;
  3. job leasing with `FOR UPDATE SKIP LOCKED`;
  4. live sessions owned by the replica that owns the consumer, using sticky sessions first and a NATS/Valkey bus later.

**Helm chart** (OCI on GHCR, Helm 4 and 3)
- Values:
  - image digest;
  - `config` (YAML -> ConfigMap);
  - `existingSecret` (`DATABASE_URL`, OIDC secret, KEK or Vault token);
  - Ingress or HTTPRoute;
  - NetworkPolicy egress;
  - ServiceMonitor;
  - restricted PodSecurity, `readOnlyRootFilesystem`, non-root;
  - probes;
  - optional ServiceAccount for Kubernetes discovery (off by default).
- No bundled Postgres (Bitnami is frozen). Docs point to CloudNativePG or a managed database; `compose.yaml` with postgres:17 covers trials.

**Config schema**
- zod `TeamServerConfig`: `server`, `database`, `crypto.kek`, `auth.oidc` (issuer, clientId, secretRef, scopes, groupsClaim, roleMappings), `auth.pats`, `egress`, `catalog` (preconfigured, lockable connections), `rbac`, `approvals`, `audit`, `metrics`, `alerts.channels`, `mcp`, `limits`, `features`.
- Precedence: env over file over defaults.
- `values.schema.json` is generated from the same schema.

---

## 10. UI architecture (Angular 22.2.3, TypeScript 6.0.3)

**Shell**
- `bootstrapApplication` with standalone components, zoneless (default) and OnPush (default).
- `provideRouter` with component input binding.
- `provideHttpClient(withInterceptors([correlation, auth, problem]))`.
- Providers for the transport and PlatformBridge are chosen at boot: the desktop preload exposes `platform.kind='desktop'`.
- Transloco 8.4.0 with lazy scopes; CSP nonce.
- Routes: `/c/:connectionId/{explorer, queues/:vhost/:name, exchanges, messages, tap, dlq, streams, topology, admin, metrics, lint}`, `/jobs`, `/settings`, `/governance`.

**State**
- Signals and `linkedSignal` locally.
- NgRx SignalStore 22 globally: Connections, BrokerProfile (gates), Workspace. `withEntities` per feature.
- High-frequency data (tap, tail) lives in ring buffers **outside** the signal graph, read through rAF-throttled snapshot signals.
- Signal Forms validate with the contracts' zod schemas (Standard Schema).

**Transport abstraction**
- `ENGINE_TRANSPORT`: `MessagePortTransport` (implements both the HttpBackend and the LiveChannel) or `HttpWsTransport`.
- `PLATFORM_BRIDGE`: `ElectronBridge` (typed, versioned contextBridge API: openExternal, open/save dialogs, notify, setMenu/onMenuCommand, deep links, appInfo) or `WebBridge`.

**Design system** (`ui-design`)
- Tailwind 4.3 tokens as CSS custom properties; light, dark and high-contrast themes; compact density (22-24 px rows, 12-13 px type).
- Library split:
  - Spartan 1.7 helm, copied in with its MIT notice: dialog, popover, select, command, sonner, resizable, sidebar, kbd;
  - `@angular/aria`: tree, grid, listbox, menu, tabs, toolbar;
  - CDK: overlay, virtual scroll, drag-drop.
- Lucide icons.
- `ThemeService` pushes tokens into AG Grid, Monaco, uPlot, ECharts and Cytoscape.
- Gate UX: `<app-gated feature>` shows the why-disabled reason and source link (DC-31). Prod chrome. `PlanReviewPanel` (warnings with W-IDs, consents, doomed-message policy, typed phrase).

**Grids**
- `<app-data-grid>` adapter over AG Grid Community 36.2.0. Our own context menu (`onCellContextMenu` plus an Aria menu), clipboard, column chooser and status bar.
- `RowSource` is either client (up to 10k rows; `applyTransactionAsync` at 4-10 Hz) or server (engine-side sort, filter and page with the infinite row model and live invalidation) for larger lists.
- TanStack Table is the fallback.

**Topology**
- Cytoscape 3.34.4: WebGL2 detection, canvas fallback, LOD.
- Server-side subgraph extraction (never render 50k nodes).
- ELK 0.12.0 runs **unmodified** as `assets/elk/elk-worker.min.js` (EPL-2.0 elected, DC-51); dagre 3.1.1 is the fallback.
- Foblex 19.3 for small editors (routing trace, shovel editor).
- An accessible table alternative for every graph.

**Editor and charts**
- Monaco 0.57 through our own ESM wrapper (lazy chunk; JSON worker only, plus the diff editor).
- uPlot 1.6.32 directive for live series; ECharts 6.1 via ngx-echarts 22 (tree-shaken) for dashboards.

**Commands**
- One registry (`id, title, category, keybinding per OS/web, when-context, run`).
- tinykeys 4 handles keys; the Spartan command palette shows commands, and entity search goes through engine `search.objects`.
- Electron menus are generated from the registry via `PlatformBridge.setMenu`.

**Budgets (CI-enforced)**

| Budget | Limit |
| --- | --- |
| Initial JS + CSS | 350 kB gzip (error at 450) |
| Feature chunk | 200 kB gzip or less |
| Monaco chunk | 1.1 MB gzip or less, on demand |
| ECharts chunk | 250 kB gzip or less |
| Desktop cold start to interactive | 2.5 s or less (engine ready 0.4 s or less) |
| 50k-row grid | scroll at 55+ fps; no long task over 50 ms |
| Live tap | 2,000 msg/s rendered; beyond that, sampling with counters |
| Renderer heap | 300 MB or less with 50k rows plus a 10k ring |
| Contracts import | deep imports per domain; bundle check fails on growth over 10% |

---

## 11. Plugin and codec SDK (DC-53)

**SDK shape**
- `plugin-sdk`: `apiVersion: 1`; published later as `@<coined>/plugin-sdk`.
- Decoder contract: `detect` (confidence), `decode` -> `NormalizedFailure`, `fingerprint`, `replayPlan` (target, headersToStrip, headersToSet, optional body transform).
- Codec contract: `detect`, `decode`, `encode`.
- **Data-first:** a machine-readable *framework header registry* (JSON) drives a generic declarative decoder that covers header mappings, queue naming conventions and delay-infrastructure patterns (`nsb.v2.delay-level-*`, `celery_delayed_*`, `mt-delay-*`, `delay_*_retry`, `{q}.delay.{ms}`, `{q}-retry`, `{q}.DQ`). Code is needed only for body envelopes and fingerprinting.
- v1.0 built-ins: generic, MassTransit, Spring, NServiceBus, EasyNetQ, Celery.
- Never unpickle or PHP-unserialize: pickle is shown as an opcode disassembly, PHP through a safe tokeniser.

**Packaging**
- An npm tarball with a `<product>Plugin` manifest (`apiVersion`, `kinds`, `entry`, `permissions`).
- Single-file ESM; no native modules or install scripts; sha512 recorded at install.
- Desktop: the user installs into `userData/plugins`. Team: admin-only, from a mounted volume or an OCI artifact.

**Sandboxing (honest)**
- `worker_threads` pool with `resourceLimits` (64 MB heap), a per-call timeout of 250 ms with terminate-on-timeout, and input caps of 16 MiB. Data-only messages; no secrets passed.
- This gives isolation from the event loop, **not** a security boundary. Third-party plugins are therefore trusted installs (VS Code model) with integrity hashes.
- v1.x: a process sandbox using the Node permission model (`--permission`, no fs-write, net or child-process) on team and local Node; on desktop only if `utilityProcess` with `execArgv` passes spike S12.

**Versioning:** semver on the SDK; the engine loads plugins with a matching `apiVersion` and reports incompatible ones.

---

## 12. Testing architecture

| Layer | Tool | Where |
| --- | --- | --- |
| Unit (pure libraries, services with testkit fakes, kit invariants) | Vitest | every runner |
| Golden fixtures: management API JSON and Prometheus text per broker version (3.13.7, 4.0.9, 4.1.8, 4.2.9, 4.3.6, plus LavinMQ 2.10.2); zod schemas must parse them; nightly refresh-and-diff | Vitest + Testcontainers recorder | Linux |
| Port contract suites: `Amqp091Port` against amqplib **and** @cloudamqp/amqp-client; `Amqp10Port` against the own adapter with rabbitmq-amqp-js-client as a differential oracle (rhea overridden to 3.0.5) | Vitest + Testcontainers | Linux |
| **Conformance suite (DC-47):** every `SemanticsCell.conformanceId` has a test asserting `x-delivery-count`, `x-acquired-count`, redelivered flag, position and survival. Matrix: 3.13.7, 4.0.9, 4.1.8, 4.2.9, 4.3.6 (plus nightly alphas, allowed to fail) x Node 24.22, Node 26.12 and Electron Node (`ELECTRON_RUN_AS_NODE` on the test-fused binary). `ExtendedRabbitContainer` exposes 5552 and 15692 and enables stream, prometheus, tracing and shovel. A coverage gate fails if any cell lacks a passing test. The published matrix is generated from results. | apps/conformance | Linux (amd64 + arm64) |
| Integration: DC-21 vhost round trip, tap/firehose, replay, OAuth (Keycloak 26 container), egress denial | Vitest + Testcontainers | Linux |
| E2E web against a real engine and broker; axe-core on every route; visual snapshots of a dev-only component gallery route (no Storybook) | Playwright 1.64.1 | Linux |
| E2E desktop smoke on the test-fused binary (nodeCliInspect on); macOS against `brew install rabbitmq` 4.3.6; Windows against the scenario engine (testkit fakes) | Playwright `_electron` | macOS-15, macos-15-intel, windows-2025, ubuntu |
| Chaos: toxiproxy latency/reset during peek and replay; leader transfer during peek; memory alarm during tap/publish. Assert receipts and counters (nack-vs-DOWN race uncertainty). | Testcontainers + toxiproxy | Linux, nightly |
| Performance: MessagePort RPC p95 under 5 ms; inject overhead; tap 5k msg/s; peek latency; 1-10 MB bodies; metrics ingest; UI 50k-row fps via CDP trace. Nightly regression gate at 15%. | apps/perf | Linux nightly |
| Packaging: fuse assertions on release binaries, notarisation check, MSIX install smoke, Docker image boot + `/readyz`, Helm `ct lint/install` on kind | scripts | per OS |

---

## 13. Observability of the tool itself

**Logs**
- Structured JSON via pino (Fastify's logger), with `redact` paths: `authorization`, `password`, `token`, `*.secret`, `amqpUri`.
- A string scrubber removes AMQP/HTTP URIs with credentials, JWTs (`eyJ...`) and Bearer values in free text (DC-45).
- Desktop: rotating files in `userData/logs`. Containers: stdout.
- Correlation ID per action, also stamped on broker `connection_name` and headers where safe.

**Self-metrics**
- Team: engine `/metrics` (auth required): action latency, broker calls, pool budgets, job states, live subscriptions.
- Desktop: an internal diagnostics page.

**OTel** is off by default. When the user configures an OTLP endpoint, `@opentelemetry/*` is lazy-loaded and exports traces and metrics. Optional replay spans link to `traceparent`.

**Crash reports** are opt-in only. Electron `crashReporter` uses `uploadToServer:false` and keeps local minidumps. "Export diagnostics bundle" collects redacted logs, versions, the BrokerProfile and receipts for users to attach manually. No telemetry or phone-home (DC-59).

---

## 14. Build, packaging, release, versioning (DC-58)

**Toolchain**
- pnpm workspace with catalogs (one version policy); `packageManager` pinned (version fixed at M0).
- Nx 23.3 (MIT) with @nx/angular, @nx/vitest, @nx/playwright, @nx/eslint and @nx/js/esbuild.
- Self-hosted or Nx Cloud Hobby cache, optional.
- ESLint 10 with angular-eslint 22, typescript-eslint strictTypeChecked, Prettier; TypeScript 6.0.3 strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`).

**Build artefacts**
- `dist/web`: one Angular build.
- `dist/engine/main.mjs`: esbuild ESM bundle (CJS fallback if spike S2 fails). Externals: optional `@napi-rs/keyring`, `ssh2` optional native code, `@kubernetes/client-node` and the stream client (lazy imports).
- `dist/desktop`: main (ESM) plus preload (CJS single file, sandbox-compatible).

**Packages**
- **Desktop**, electron-builder (pinned 26.16.1 or later):
  - macOS: DMG and zip for arm64 and x64; Developer ID, hardened runtime, notarised; `NSLocalNetworkUsageDescription`;
  - Windows: MSIX for the Microsoft Store (first-class), plus NSIS and zip on GitHub, with SignPath once reputable (sign app -> build NSIS -> sign installer -> regenerate `latest.yml` and blockmap);
  - Linux: deb and rpm (x64/arm64) with AppArmor profile, plus AppImage with the Ubuntu 24.04 caveat; never `--no-sandbox`;
  - electron-updater with GitHub provider and staged rollouts; disabled for Store builds;
  - own Homebrew tap; winget later.
- **npm:** the `<product>` CLI (bundles the engine and `dist/web`), trusted publishing with provenance, `engines.node >=24.15`.
- **Container:** `gcr.io/distroless/nodejs24-debian13:nonroot` pinned by digest, multi-arch on native runners, cosign keyless, SBOM, provenance, Trivy.
- **Helm:** OCI chart on GHCR.
- **Notices:** a `THIRD_PARTY_NOTICES` per artefact.

**Release flow**
1. Conventional Commits with squash merges.
2. release-please (manifest mode) maintains **one product version** for desktop, npm, image and chart. Its release PR is the human gate.
3. tag -> build -> notarise/sign -> regenerate update metadata -> attest -> draft -> immutable GitHub release -> push image and chart -> tap bump.

**Versioning**
- SemVer `MAJOR.MINOR.PATCH`; MSIX uses `x.y.z.0`.
- REST `/api/v1`, live protocol `v`, plugin `apiVersion`, DB schema migrations and config `schemaVersion` are versioned independently and documented in `docs/compat.md`.
- Supported brokers: 3.13-4.3 with 4.4 readiness (DC-60). A support claim requires a green conformance run.

---

## Appendix A. Agent conventions

- **Instruction files:** AGENTS.md is canonical. CLAUDE.md stays under 200 lines (`@AGENTS.md`). `.claude/rules/{engine, ui, desktop, semantics, security}.md`.
- **Hooks:** format and lint on edit; affected typecheck and tests on stop.
- **Skills:** new-action, new-adapter, new-ui-feature, new-semantics-cell, release.
- **Specs:** one per task: goal, files and interfaces, out of scope, Given/When/Then acceptance, verification commands.
- **Golden-path examples:** `svc-explorer/queues.list` (query), `svc-admin/queues.purge` (two-phase), `svc-tap/tap.messages` (credit topic).
- **Review:** writer/reviewer split; fresh-context review on CODEOWNERS paths.

## Appendix B. Milestones (agent-sized tasks)

Each task touches one or two libraries, ships with tests and has an executable `nx` verification.

| Milestone | Scope |
| --- | --- |
| M0 | Repo, toolchain, gates, generators, spikes S1-S12 |
| M1 | Walking skeleton (local + desktop): contracts kit, router, port transport, persistence, secrets, connections, probe, explorer (read-only), audit (stub) |
| M2 | Semantics registry + conformance harness; peek for all eras with receipts; capture store; message viewer; publish |
| M3 | Taps, firehose, streams (own AMQP 1.0 adapter) |
| M4 | DLQ centre, decoders v1.0, replay jobs |
| M5 | Admin and ops, effective config, routing simulator, topology-as-code, linter |
| M6 | Metrics, forecasts, alerts |
| M7 | Team: OIDC, RBAC, approvals, hash-chained audit, Postgres, delegated credentials, Helm |
| M8 | MCP, CLI, signing/release, published matrix |

Example acceptance criterion for M2: "Given a QQ on 4.2.9 with L=20 and a message at AC=19, when a peek executes with policy `stop`, then 0 messages are returned, the receipt says `stoppedBecause: doomed`, and the message is still in the queue with AC=19" (conformance cell CF-QQ-42-GUARD-01).

## Appendix C. M0 spikes (remaining uncertainties)

| Spike | Question |
| --- | --- |
| S1 | MessagePort forwarding, inject latency, 16 MiB payloads, reload/close semantics (Electron 44/45, three OSes) |
| S2 | utilityProcess cold start of 400 ms or less; ESM entry support |
| S3 | node:sqlite + Kysely dialect + FTS5 on Node 24/26 and in Electron |
| S4 | CSP + Trusted Types with Monaco/ELK/AG Grid under `app://` and http |
| S5 | nack + qos barrier counters on 4.2.9/4.3.6 |
| S6 | rhea credit 0 / drain / released and filter-set echo on 4.3.6 |
| S7 | safeStorage async in main, DEK handoff, Linux backend detection, `crypto.argon2` under BoringSSL |
| S8 | `setDefaultCACertificates` / `getCACertificates('system')` in Electron |
| S9 | Playwright `_electron` on the test-fused binary |
| S10 | electron-builder fuses + MSIX with utilityProcess |
| S11 | Nx 23.3 + Angular 22.2 + esbuild engine target |
| S12 | utilityProcess `execArgv --permission` for the plugin sandbox |

## Appendix D. DC traceability

| DCs | Where satisfied |
| --- | --- |
| DC-01/02 | §5.2, semantics |
| DC-03..16 | §5.2 |
| DC-17..20 | §5.3 |
| DC-21 | svc-admin + integration test |
| DC-22..26 | svc-streams, adapter-amqp10, DLQ reads over 0-9-1 |
| DC-27..29 | §5.4 |
| DC-30 | effective-config |
| DC-31/32 | svc-capabilities, adapter-mgmt-http |
| DC-33 | §8 |
| DC-34/35/36 | §1, §3, §7 |
| DC-37..39 | svc-identity |
| DC-40/41 | svc-access, svc-audit |
| DC-42 | §5.1, svc-mcp |
| DC-43/44 | net-* |
| DC-45 | secrets |
| DC-46 | §1.1, §7 |
| DC-47 | §12 |
| DC-48 | ports + contract suites |
| DC-49 | §4, §14 |
| DC-50/51/52 | §10, §14 |
| DC-53 | §11 |
| DC-54 | svc-connections, svc-dlq |
| DC-55 | adapter-mgmt-http |
| DC-56 | lint-rules |
| DC-57 | naming |
| DC-58 | §14 |
| DC-59 | §13 |
| DC-60 | §12/§14 |

## ADRs proposed

- **ADR-001 Modular monolith: one engine, one UI build, three hosts:** Build one Node 24 ESM engine bundle and one Angular build. The engine runs in an Electron utilityProcess (desktop), in a loopback Node process (local web) and in a container (team). Mode files differ only in which adapters they wire.
- **ADR-002 Fastify 5.12.5 with an in-house contract kit instead of NestJS 12:** Use Fastify only, pinned to exactly 5.12.5. A roughly 600-LOC kit provides the contract router, problem mapping and auth hooks. Dependencies are wired by hand in a typed composition root, with no DI container.
- **ADR-003 One contract: actions with HTTP, MCP and CLI bindings:** Each capability is one defineAction in @app/contracts. It declares zod input and output, permission, risk, a two-phase flag, confirmation, audit level, target, and its http, mcp and cli bindings. Topics are declared the same way with defineTopic. Every route, MCP tool and CLI command is generated from these registries.
- **ADR-004 Generated OpenAPI/AsyncAPI; contract-typed Angular client without codegen:** Emit OpenAPI 3.1 and AsyncAPI 3.0 from the registries using z.toJSONSchema. Commit snapshots, fail CI on any diff, and run oasdiff for breaking changes. The UI calls EngineApi.call(action, input) and engineResource() (httpResource with parse) with types inferred from zod.
- **ADR-005 Desktop transport: tunnel the same REST router over a MessagePort:** Main creates a MessageChannelMain per renderer load and hands one port each to the engine and to the preload. The preload forwards it to the main world with window.postMessage. On the UI side, a custom HttpBackend (the same override mechanism provideHttpClientTesting uses) serialises requests. On the engine side, PortSessionServer runs app.inject and multiplexes live frames on the same port. There is no TCP listener.
- **ADR-006 Multiplexed live protocol with universal credits:** One live session per UI, carried over WS (local and team) or the MessagePort (desktop). Frames are hello, sub, credit, unsub, data, snapshot, delta, status and end. Three flow modes exist: credit (bounded rings with drop-oldest counters), conflate (latest per key at most N Hz) and snapshot-delta. Sampling kicks in above the render budget.
- **ADR-007 Single policy-enforced action layer with two-phase plans and receipts:** Every request runs the same pipeline: ActionExecutor authenticates, validates, authorises, applies guardrails, plans, executes, issues a receipt and writes audit. Risky commands use persisted Plans (15-minute TTL) holding gates, W-* warnings, consents, an engine-checked typed phrase and approvals. Execute revalidates (PLAN_STALE on change). Direct REST calls to gated commands return 428 with a plan.
- **ADR-008 Data-driven BrokerSemantics registry with conservative era resolution:** An isomorphic registry of SemanticsCells, keyed by era, queue type, settle action and limit state. Each cell carries its effects, sources and a conformanceId. The registry also holds warnings (versioned texts), known hazards (the bug table) and feature gates. resolveEra applies the DC-02 rules.
- **ADR-009 Peek as an atomic engine job with preflight, guard, rescue and barrier:** Peek runs as follows:
- HTTP-only preflight, then a registry-selected method.
- basic.get on a dedicated peek connection, one job per connection, or AMQP 1.0 credit+drain+released on 4.3.
- Copies are written immediately and the post-acquire guard runs (stop, rescue or raise-limit; the let-broker option is not available to AI or unattended actors).
- nack(multiple, requeue), then a synchronous basic.qos barrier, then close.
- A watchdog with a 5 s target and 30 s abort, a write-ahead record, and a receipt.
- **ADR-010 Role-separated connection pools with budgets:** Each broker profile gets role-separated connections:
- control;
- peek (holds production deliveries; one job per connection);
- source (replay/move consumers; same isolation as peek);
- publish (confirm channels; never consumes);
- observe (taps on our own exclusive queues; stream readers).
One consumer per channel. Budgets come from the BrokerProfile limits; work queues up instead of exceeding a budget. In team mode, delegated credentials get per-user pools.
- **ADR-011 Protocol ports with in-house AMQP 1.0 and management clients:** The ports are Amqp091Port (amqplib 2.2.0 as primary, @cloudamqp/amqp-client 4.1.1 as the contract-suite alternative), Amqp10Port (our own adapter on rhea 3.0.5), StreamPort (optional) and MgmtHttpPort (undici + zod, with golden fixtures). rabbitmq-amqp-js-client is used only as a test oracle.
- **ADR-012 Stream browsing over AMQP first; stream protocol optional:** The read path order is: our AMQP 1.0 adapter (4.0+, described filters, ulong offsets, ms timestamps); then 0-9-1 x-stream-offset (and 3.13); then the stream protocol, only when probes confirm every advertised host:port is reachable. Readers are always anonymous. Every attach verifies that the broker applied the requested filter set and fails closed if it did not.
- **ADR-013 Kysely over node:sqlite (desktop/local) and Postgres (team):** One Kysely Database interface. node:sqlite goes through an in-repo dialect with WAL and FTS5; Postgres uses pg 8.23.1 with tsvector. Migrations are portable, with JSON stored as TEXT and epoch-ms timestamps. Search and blobs sit behind ports. better-sqlite3 13.0.3 is the fallback.
- **ADR-014 Envelope-encrypted secrets with a key wrap per mode:** Secrets and captured bodies are encrypted with AES-256-GCM under a DEK. The DEK is wrapped by: Electron safeStorage async (in main, handed to the engine over parentPort) on desktop; @napi-rs/keyring (Secret Service forced) for local web, with a passphrase fallback (Argon2id or scrypt); a KEK file, Vault Transit or OpenBao Transit on the team server.
- **ADR-015 One Dialer with egress policy; trust configured in code:** Every outbound socket (broker, IdP discovery and JWKS, Vault, webhooks) goes through the Dialer. Routes are direct, SOCKS5, HTTP CONNECT, ssh2, system ssh -W and k8s port-forward, with SNI preserved. Clients that cannot take a socket use a local forwarder on a permission-restricted socket. The TrustStore calls tls.setDefaultCACertificates with bundled, system and org CAs.
- **ADR-016 Pluggable credential providers and a per-protocol TokenManager:** svc-identity supplies these providers: password, oauth-pkce-loopback, device-code, client-credentials, token-command, static-token, x509-external, vault-dynamic and delegated-user. Profiles keep separate HTTP and AMQP credentials. The TokenManager refreshes at 75% of lifetime and asserts that the username is unchanged. Each protocol has its own renewal path. Issuers are discovered via bootstrap.js and pinned.
- **ADR-017 Team server: OIDC BFF, deny-by-default RBAC, four-eyes, hash-chained audit, single replica v1:** openid-client 6.8.8 provides the BFF with server-side sessions. RBAC roles bind to IdP groups with scope patterns. Permissions are stricter than the broker's. Approvals follow configurable rules. The audit log is append-only with a SHA-256 chain. Broker credential mode is set per connection and intersected with RBAC. v1 runs one replica with Recreate; HA comes later through advisory locks and job leasing.
- **ADR-018 Prometheus-first metrics with a local rollup store:** A per-node scrape planner applies provider rules and feeds an in-house streaming parser. Rates come from counter deltas. Recent data sits in an in-memory hot window, with raw, 5-minute and 1-hour rollups in SQLite or Postgres under cardinality caps. When Prometheus is unavailable, the engine samples the management API. Forecasts and alerts are pure functions.
- **ADR-019 In-house durable job runner on the database:** The JobRunner runs async-generator jobs with an AbortSignal, checkpoints, a journal, a token bucket, idempotency keys and concurrency keys. Storage uses the same tables on SQLite and Postgres.
- **ADR-020 Angular 22 UI stack:** Standalone, zoneless and OnPush components with signals and SignalStore 22. The design system is Spartan 1.7, CDK, @angular/aria and Tailwind 4. Grids use AG Grid Community 36.2 behind an adapter with our own menus, clipboard and status bar. Graphs use Cytoscape with WebGL detection, an unmodified ELK worker and dagre as fallback, plus Foblex for small diagrams. Monaco 0.57 sits behind our own ESM wrapper. uPlot and ECharts handle charts. tinykeys drives the command registry.
- **ADR-021 Data-first decoders and a worker-thread plugin host:** A JSON framework-header registry drives a declarative decoder. Code plugins implement detect, decode, fingerprint and replayPlan, and run in a worker pool with resource limits, timeouts and input caps. Third-party plugins are trusted installs with integrity hashes. A process sandbox using the Node permission model comes in v1.x.
- **ADR-022 Electron shell hardening and a test-fused binary:** Main stays thin. The UI is served from app:// with CSP and a nonce. The engine runs in a utilityProcess. Release fuses: RunAsNode, NodeOptions and NodeCliInspect off; ASAR integrity and OnlyLoadAppFromAsar on. A separate test-fused binary serves Playwright and the Electron-Node conformance run. The engine exits from its own handler; main escalates after 5 s.
- **ADR-023 Nx 23 + pnpm catalogs, exact pins, generators first:** Nx 23.3 uses @nx/angular, vitest, playwright, eslint and js/esbuild; @nx/nest is not used. pnpm catalogs hold exact pins (TypeScript 6.0.3, zod 4.6.7, amqplib 2.2.0, rhea 3.0.5, fastify 5.12.5 and the rest). Module boundaries are enforced through tags. Banned dependencies are checked by lint and a lockfile scan. Local generators are the way to add code.
- **ADR-024 MCP built from the action registry; in-house tools-only server:** svc-mcp exposes MCP tools generated from actions with mcp.expose set. Mutating tools are off by default and plan-only, with human approval. Payloads are quoted, capped, stripped and masked. Desktop uses a stdio shim over the IPC pipe. The team /mcp endpoint is an OAuth protected resource with no token passthrough. The JSON-RPC subset is implemented in-house: initialize, tools/list, tools/call, ping, notifications.
- **ADR-025 Public conformance suite as the correctness backbone:** apps/conformance runs every semantics cell on Testcontainers (Linux) across 3.13.7, 4.0.9, 4.1.8, 4.2.9 and 4.3.6, plus nightly alphas. The runtimes are Node 24.22, Node 26.12 and Electron's Node. A custom container exposes ports 5552 and 15692. A coverage gate requires every cell to have a test. The published compatibility matrix is generated from the results.
- **ADR-026 RFC 9457 problems with a stable error-code registry:** Every failure is returned as application/problem+json carrying a code, correlationId, retryable flag, and optional gate, warnings, broker and docs fields. Live frames carry the same Problem.
- **ADR-027 Single product version and signed, telemetry-free releases:** release-please maintains one SemVer for desktop, npm, image and chart. Releases are signed and notarised: Apple from day one, the Microsoft Store as the primary Windows channel, SignPath once reputable, cosign for images. Releases are immutable. There is no telemetry; crash reports are opt-in.

## Core interfaces

```ts
// ============================================================================
// @app/contracts: contract kit (isomorphic; depends only on zod 4.6.7)
// ============================================================================
import type { z } from 'zod';

export type Brand<T, B extends string> = T & { readonly __brand: B };
export type ConnectionId = Brand<string, 'ConnectionId'>; // human-created opaque alias (DC-42)
export type ActionId = Brand<string, 'ActionId'>;
export type TopicId = Brand<string, 'TopicId'>;
export type PlanId = Brand<string, 'PlanId'>;
export type JobId = Brand<string, 'JobId'>;
export type ReceiptId = Brand<string, 'ReceiptId'>;
export type FeatureId = Brand<string, 'FeatureId'>;   // 'streams.browse', 'tap.firehose', ...
export type WarningId = `W-${string}`;
export type Permission = `${string}.${string}`;
export type EnvClass = 'production' | 'staging' | 'development' | 'local';
export type Risk = 'none' | 'low' | 'medium' | 'high' | 'critical';
export type ActionKind = 'query' | 'command' | 'peek' | 'job';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type EngineMode = 'desktop' | 'local' | 'team';

export interface TargetRef { connectionId?: ConnectionId; vhost?: string; kind?: string; name?: string }

export interface ActionDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  readonly id: ActionId;
  readonly kind: ActionKind;
  readonly summary: string;
  readonly input: I;
  readonly output: O;
  readonly permission: Permission;
  readonly risk: Risk | ((input: z.infer<I>, env: EnvClass) => Risk);
  readonly twoPhase: 'never' | 'when-gated' | 'always';
  readonly confirm?: { requiredWhen(env: EnvClass, risk: Risk): boolean; phrase(input: z.infer<I>): string };
  readonly audit: 'none' | 'outcome' | 'attempt+outcome';
  readonly target: (input: z.infer<I>) => TargetRef;
  readonly http?: { method: HttpMethod; path: `/${string}`; successStatus?: 200 | 201 | 202 | 204 };
  readonly mcp?: { expose: boolean; mutating: boolean; title: string; description: string };
  readonly cli?: { command: string; positional?: readonly string[] };
  readonly since: `${number}.${number}`;
}
export declare function defineAction<I extends z.ZodType, O extends z.ZodType>(d: ActionDef<I, O>): ActionDef<I, O>;
export type InputOf<A> = A extends ActionDef<infer I, any> ? z.infer<I> : never;
export type OutputOf<A> = A extends ActionDef<any, infer O> ? z.infer<O> : never;

export type FlowMode = 'credit' | 'conflate' | 'snapshot-delta';
export interface TopicDef<P extends z.ZodType = z.ZodType, T extends z.ZodType = z.ZodType> {
  readonly id: TopicId; readonly params: P; readonly item: T; readonly flow: FlowMode; readonly permission: Permission;
  readonly key?: (item: z.infer<T>) => string;
  readonly maxHz?: number;
  readonly ring?: { maxItems: number; maxBytes: number };
}
export declare function defineTopic<P extends z.ZodType, T extends z.ZodType>(d: TopicDef<P, T>): TopicDef<P, T>;

export type ErrorCode =
  | 'VALIDATION_FAILED' | 'NOT_FOUND' | 'UNAUTHENTICATED' | 'FORBIDDEN_RBAC' | 'FORBIDDEN_BROKER'
  | 'GATE_BLOCKED' | 'CONSENT_REQUIRED' | 'CONFIRMATION_MISMATCH' | 'PLAN_REQUIRED' | 'PLAN_EXPIRED'
  | 'PLAN_STALE' | 'APPROVAL_REQUIRED' | 'BROKER_UNREACHABLE' | 'BROKER_ERROR' | 'BROKER_RESOURCE_LOCKED'
  | 'BROKER_PRECONDITION_FAILED' | 'TOKEN_EXPIRED' | 'TOKEN_TOO_LARGE' | 'EGRESS_DENIED' | 'TLS_UNTRUSTED'
  | 'CAPABILITY_MISSING' | 'BUDGET_EXCEEDED' | 'RATE_LIMITED' | 'ENGINE_SHUTTING_DOWN' | 'INTERNAL';
export interface Problem {
  type: string; title: string; status: number; code: ErrorCode; detail?: string; instance?: string;
  correlationId: string; retryable: boolean; gate?: GateDecision; warnings?: WarningRef[]; docs?: string;
  broker?: { protocol: 'http' | 'amqp091' | 'amqp10' | 'stream'; code?: number | string; text?: string; classId?: number; methodId?: number };
}
export interface WarningRef { id: WarningId; severity: 'info' | 'warn' | 'block'; text: string; textVersion: number; consentRequired: boolean }

// Live protocol frames (identical on WebSocket and MessagePort)
export type ClientFrame =
  | { t: 'hello'; v: 1; resume?: string }
  | { t: 'sub'; sid: number; topic: TopicId; params: unknown; credit: number }
  | { t: 'credit'; sid: number; n: number }
  | { t: 'unsub'; sid: number }
  | { t: 'ping'; ts: number };
export type ServerFrame =
  | { t: 'welcome'; v: 1; session: string; engine: string; heartbeatMs: number }
  | { t: 'data'; sid: number; seq: number; items: unknown[]; dropped?: number; sampled?: { keep: number; of: number } }
  | { t: 'snapshot'; sid: number; seq: number; items: unknown[] }
  | { t: 'delta'; sid: number; seq: number; upserts: unknown[]; removes: string[] }
  | { t: 'status'; sid: number; state: 'active' | 'paused' | 'degraded' | 'stale'; reason?: Problem }
  | { t: 'end'; sid: number; reason: 'unsub' | 'completed' | 'lease_expired' | 'error'; problem?: Problem }
  | { t: 'pong'; ts: number };
// MessagePort envelope (desktop): HTTP tunnel + live on one port
export type PortFrame =
  | { t: 'req'; id: number; method: HttpMethod; url: string; headers: Record<string, string>; body?: string | ArrayBuffer }
  | { t: 'res'; id: number; status: number; headers: Record<string, string>; body: string | ArrayBuffer }
  | { t: 'abort'; id: number }
  | { t: 'live'; frame: ClientFrame | ServerFrame };

// ============================================================================
// @app/domain-model: BrokerProfile (DC-31)
// ============================================================================
export type Era = '3.13' | '4.0-4.2' | '4.3' | '4.4';
export type QueueType = 'classic' | 'quorum' | 'stream';
export type Product = 'rabbitmq' | 'tanzu-rabbitmq' | 'lavinmq' | 'apsaramq' | 'unknown';
export type Provider = 'self-hosted' | 'amazon-mq' | 'cloudamqp-shared' | 'cloudamqp-dedicated' | 'ibm-cloud'
  | 'k8s-operator' | 'bitnami' | 'tanzu-platform' | 'unknown';
export interface SemVer { major: number; minor: number; patch: number; pre?: string; raw: string }
export interface VersionRange { min?: string; maxExclusive?: string }
export interface GateDecision { enabled: boolean; mode?: 'full' | 'degraded'; reason?: string; source?: string; hazardIds?: string[] }

export interface BrokerProfile {
  schemaVersion: 1;
  connectionId: ConnectionId;
  probedAt: string;
  product: Product;
  provider: Provider;
  providerEvidence: string[];
  clusterName?: string;
  versions: { min: SemVer; max: SemVer; perNode: Record<string, SemVer | null>; mixed: boolean; commercialBuildSuspected: boolean };
  era: { value: Era; reasons: string[] };
  lbFronted: { value: boolean; evidence: string[] };
  nodes: Array<{ name: string; running: boolean; beingDrained?: boolean; enabledPlugins?: string[]; authMechanisms?: string[]; qqMachineVersion?: number }>;
  identity: { user: string; tags: string[]; isAdmin: boolean; canMonitor: boolean; canManage: boolean; isPolicymaker: boolean; isProtected?: boolean; configureRegexByVhost?: Record<string, string> };
  extensions: string[];
  plugins: string[];
  featureFlags: Record<string, 'enabled' | 'disabled' | 'unavailable'>;
  deprecatedFeaturesUsed: string[];
  statsMode: { disableStats: boolean; enableQueueTotals: boolean };
  defaultQueueType?: QueueType;
  exchangeTypes: string[];
  restrictions: { operatorPolicyChangesDisabled: boolean; qqReplicaOpsDisabled: boolean | 'unknown'; definitionsExport: 'full' | 'synthetic' | 'none' };
  limits: { connectionMax?: number; channelMax?: number; consumersPerChannelMax?: number; maxMessageBytes?: number; frameMax?: number; preAuthFrameMax: 4096 | 8192; providerQuotas?: Record<string, number> };
  listeners: Array<{ protocol: string; node: string; port: number; ip?: string }>;
  prometheus: { endpoints: Array<{ node: string; url: string; source: 'provider' | 'listener' | 'default' }>; perObjectAllowed: boolean; queueFilterSupported: boolean; minScrapeIntervalSec: number };
  streams: { supported: boolean; paths: Array<'amqp10' | 'amqp091' | 'stream-protocol' | 'lavinmq-http'>; streamProtocolReachable: boolean | 'unknown' };
  firehose: { available: 'tracing-plugin' | 'runbook-only' | 'none'; nodeLocal: boolean };
  auth: { oauth?: { issuer: string; clientId?: string; pinned: boolean; source: 'bootstrap.js' | 'api/auth' | 'lavinmq' }; httpChainSeparate: boolean | 'unknown'; amqp091ExpiryClosesConnection: boolean };
  tls: { enabled: boolean; sanMatches?: boolean; issuer?: string; expiresAt?: string; insecureOverride: boolean };
  managedObjects: Array<{ kind: string; vhost?: string; name: string; managedBy: 'servicecontrol' | 'wolverine' | 'k8s-topology-operator' | 'provider' | 'nservicebus-policy' | 'other' }>; // DC-54
  hazards: string[];                         // KnownHazard ids applicable (DC-32)
  gates: Record<FeatureId, GateDecision>;    // every feature gate with why-disabled + source
}

// ============================================================================
// @app/semantics: BrokerSemantics registry (DC-01/02)
// ============================================================================
export type SettleAction =
  | 'amqp091.nack_requeue' | 'amqp091.reject_requeue' | 'amqp091.no_requeue'
  | 'amqp10.released' | 'amqp10.modified_df_false' | 'amqp10.modified_df_true' | 'amqp10.rejected'
  | 'close_while_holding' | 'tcp_loss' | 'partition' | 'basic_cancel_only' | 'amqp10.detach_unsettled'
  | 'consumer_timeout' | 'http.ack_requeue_true' | 'http.reject_requeue_true' | 'http.reject_requeue_false' | 'http.ack_requeue_false';
export type Position = 'head' | 'tail' | 'original' | 'delayed' | 'removed' | 'n/a';
export type LimitState = 'unset' | 'finite' | 'minus1';
export type DeliveryLimit = { kind: 'unlimited' } | { kind: 'finite'; value: number } | { kind: 'unknown' };

export interface SemanticsCell {
  key: { era: Era; queueType: QueueType; action: SettleAction; limit?: LimitState };
  effects: {
    acquiredCount: 0 | 1; deliveryCount: 0 | 1;
    countsTowardLimit: 'yes' | 'no' | 'if-limit-set' | 'if-dc-gt-limit';
    position: Position; terminal?: 'dlx-or-drop' | 'removed' | 'connection-error';
  };
  notes?: string[];
  source: Array<{ kind: 'S' | 'D' | 'RN' | 'GH' | 'M3'; ref: string }>;
  conformanceId: `CF-${string}`;
  verification: 'code-derived' | 'lab-verified';
  verifiedOn?: string[];
}
export interface KnownHazard { id: string; affects: VersionRange; fixedIn?: string; when: 'always' | 'stats-off'; gates: FeatureId[]; summary: string; source: string }
export interface EraInputs { nodeVersions: Array<SemVer | null>; ff43Enabled: boolean | 'unknown'; qqMachineVersions: number[]; product: Product; commercialBuildSuspected: boolean }
export interface QueueFacts {
  vhost: string; name: string; type: QueueType; durable: boolean; exclusive: boolean; exclusiveOwnerIsUs: boolean;
  autoDelete: boolean; deliveryLimit: DeliveryLimit; args: Record<string, unknown>; effective: Record<string, unknown>;
  sacActiveConsumer?: string | null; consumers: number; ready?: number; maxLength?: number; overflow?: string;
  messageTtlMs?: number; delayedRetry?: { type: 'disabled' | 'all' | 'failed' | 'returned'; minMs?: number; maxMs?: number; delayed?: number };
  qq?: { leader?: string; members: string[]; online: string[] }; avgMessageBytes?: number;
}
export type PeekMethod = 'amqp091.basic_get' | 'amqp091.consumer_sac' | 'amqp10.credit_drain'
  | 'stream.amqp10' | 'stream.amqp091' | 'stream.protocol' | 'http.get_fallback';
export interface PeekStrategy { method: PeekMethod; settle: SettleAction; caps: { defaultCount: number; maxCount: number; adminMaxCount?: number; maxBytes: number; targetMs: number; abortMs: number }; consents: WarningId[]; blocks: WarningId[] }

export interface BrokerSemanticsRegistry {
  readonly version: string;
  resolveEra(i: EraInputs): { era: Era; reasons: string[]; conservative: boolean };
  cell(era: Era, q: QueueType, action: SettleAction, limit?: LimitState): SemanticsCell;
  cells(): readonly SemanticsCell[];
  peekStrategy(era: Era, q: QueueFacts, profile: BrokerProfile): PeekStrategy;
  isDoomed(era: Era, m: { deliveryCount?: number; acquiredCount?: number }, limit: DeliveryLimit): boolean;
  warning(id: WarningId, locale?: 'en'): WarningRef;
  hazards(p: Pick<BrokerProfile, 'versions' | 'statsMode' | 'featureFlags' | 'product'>): KnownHazard[];
  gate(feature: FeatureId, p: BrokerProfile): GateDecision;
}

// ============================================================================
// @app/kernel: action layer
// ============================================================================
export interface Logger { debug(o: object, m?: string): void; info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void; child(b: object): Logger }
export interface Actor { type: 'user' | 'service' | 'ai' | 'cli' | 'job'; id: string; displayName: string; roles: string[]; scopes?: string[]; unattended: boolean; sessionId?: string }
export interface ActionContext {
  actor: Actor; mode: EngineMode; env: EnvClass; correlationId: string;
  signal: AbortSignal; deadline?: number; log: Logger; now(): number;
}
export interface Gate { id: string; blocking: boolean; reason: string; source?: string; fix?: { actionId: ActionId; input: unknown; label: string } }
export interface Approval { by: Actor; decision: 'approve' | 'reject'; at: string; note?: string }
export interface Plan<I = unknown, P = unknown> {
  id: PlanId; actionId: ActionId; input: I; inputHash: string; actor: Actor; env: EnvClass; risk: Risk;
  gates: Gate[]; warnings: WarningRef[]; consentsRequired: string[]; confirmationPhrase?: string;
  approvals: { required: number; granted: Approval[] }; preview: P;
  createdAt: string; expiresAt: string; state: 'open' | 'approved' | 'executing' | 'executed' | 'expired' | 'rejected';
}
export interface PlanDraft<P> { preview: P; gates: Gate[]; warnings: WarningRef[]; consentsRequired: string[] }
export interface SideEffectReceipt {
  id: ReceiptId; actionId: ActionId; planId?: PlanId; actor: Actor; target: TargetRef;
  startedAt: string; finishedAt: string; dryRun: boolean; summary: string; effects: unknown; brokerCalls: number; auditSeq?: number;
}
export interface ActionImpl<A extends ActionDef, P = unknown> {
  readonly def: A;
  plan?(input: InputOf<A>, ctx: ActionContext): Promise<PlanDraft<P>>;               // read-only calls only
  revalidate?(plan: Plan<InputOf<A>, P>, ctx: ActionContext): Promise<Gate[]>;     // TOCTOU re-check
  execute(input: InputOf<A>, ctx: ActionContext & { plan?: Plan<InputOf<A>, P>; consents: ReadonlySet<string> }): Promise<OutputOf<A> | { jobId: JobId }>;
}
export declare function implementAction<A extends ActionDef, P = unknown>(def: A, impl: Omit<ActionImpl<A, P>, 'def'>): ActionImpl<A, P>;
export interface Authorizer { check(actor: Actor, permission: Permission, target: TargetRef): Promise<{ allowed: boolean; reason?: string }> }
export interface GuardrailPolicy {
  evaluate(def: ActionDef, input: unknown, ctx: ActionContext): Promise<{
    risk: Risk; requirePlan: boolean; confirmationPhrase?: string; approvalsRequired: number;
    denied?: string; forbidLetBrokerHandle: boolean; quotaKey?: string;
  }>;
}
export type PlanRequired = { planRequired: true; plan: Plan };
export interface ActionExecutor {
  run<A extends ActionDef>(def: A, input: unknown, ctx: ActionContext): Promise<OutputOf<A> | PlanRequired | { jobId: JobId }>;
  plan<A extends ActionDef>(def: A, input: unknown, ctx: ActionContext): Promise<Plan>;
  approve(planId: PlanId, approver: Actor, decision: 'approve' | 'reject', note?: string): Promise<Plan>;
  execute(req: { planId: PlanId; consents: string[]; confirmation?: string }, ctx: ActionContext):
    Promise<{ output: unknown; receipt?: SideEffectReceipt } | { jobId: JobId }>;
}

// ============================================================================
// @app/jobs: durable job runner
// ============================================================================
export interface TokenBucket { take(n?: number, signal?: AbortSignal): Promise<void>; setRate(perSec: number, burst?: number): void }
export interface JournalEntry { jobId: JobId; key: string; state: string; data?: unknown; at: string }
export interface Journal { append(e: { key: string; state: string; data?: unknown }): Promise<void>; get(key: string): Promise<JournalEntry | undefined>; list(f?: { state?: string; after?: string }): AsyncIterable<JournalEntry> }
export type JobEvent = { kind: 'progress'; done: number; total?: number; note?: string } | { kind: 'warning'; warning: WarningRef } | { kind: 'paused'; reason: string } | { kind: 'checkpoint' };
export interface JobContext<I, C> { jobId: JobId; input: I; checkpoint: C | undefined; actor: Actor; signal: AbortSignal; save(cp: C): Promise<void>; journal: Journal; throttle: TokenBucket; log: Logger }
export interface JobDef<I, C, O> {
  type: string; input: z.ZodType<I>; checkpoint: z.ZodType<C>; output: z.ZodType<O>;
  concurrencyKey?(input: I): string;                 // e.g. `${connectionId}:${queue}`
  run(ctx: JobContext<I, C>): AsyncGenerator<JobEvent, O, void>;
  onStop?(ctx: JobContext<I, C>, reason: 'cancel' | 'shutdown' | 'suspend'): Promise<void>; // MUST flush held deliveries (DC-04)
}
export interface JobRecord { id: JobId; type: string; state: 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled'; progress?: { done: number; total?: number }; actor: Actor; createdAt: string; finishedAt?: string; error?: Problem }
export interface JobRunner {
  register(def: JobDef<any, any, any>): void;
  start<I>(type: string, input: I, actor: Actor, opts?: { idempotencyKey?: string }): Promise<JobId>;
  cancel(id: JobId): Promise<void>; pause(id: JobId): Promise<void>; resume(id: JobId): Promise<void>;
  get(id: JobId): Promise<JobRecord>;
  drain(deadlineMs: number): Promise<void>;          // checkpoint + onStop('shutdown') for all running jobs
}

// ============================================================================
// @app/ports: protocol, network, storage, platform ports (DC-48)
// ============================================================================
export type ConnectionRole = 'control' | 'peek' | 'source' | 'publish' | 'observe';
export interface AmqpProperties { contentType?: string; contentEncoding?: string; headers?: Record<string, unknown>; deliveryMode?: 1 | 2; priority?: number; correlationId?: string; replyTo?: string; expiration?: string; messageId?: string; timestamp?: number; type?: string; userId?: string; appId?: string }
export interface Delivery { tag: bigint; redelivered: boolean; exchange: string; routingKey: string; properties: AmqpProperties; body: Uint8Array; messageCount?: number }
export type PublishOutcome = { kind: 'confirmed' } | { kind: 'nacked' } | { kind: 'returned'; replyCode: number; replyText: string };

export interface Amqp091Channel {
  get(queue: string): Promise<Delivery | null>;                                   // noAck=false always
  nackRequeue(upTo: Delivery, opts: { multiple: boolean }): void;                 // the only peek settle on 0-9-1
  ack(d: Delivery, opts?: { multiple?: boolean }): void;
  qosBarrier(prefetch: number): Promise<void>;                                    // synchronous basic.qos round trip
  consume(queue: string, onMessage: (d: Delivery | null) => void, opts: { prefetch: number; exclusive?: boolean; args?: Record<string, unknown> }): Promise<string>;
  cancel(consumerTag: string): Promise<void>;
  publish(exchange: string, routingKey: string, body: Uint8Array, props: AmqpProperties, opts: { mandatory: boolean }): Promise<PublishOutcome>;
  declareQueue(name: string, opts: { durable: boolean; exclusive: boolean; autoDelete: boolean; args: Record<string, unknown> }): Promise<void>;
  bindQueue(queue: string, exchange: string, key: string, args: Record<string, unknown>): Promise<void>;
  checkQueue(name: string): Promise<{ messageCount: number; consumerCount: number }>; // throwaway channel only
  close(): Promise<void>;
}
export interface Amqp091Connection {
  readonly role: ConnectionRole;
  channel(opts?: { confirm?: boolean }): Promise<Amqp091Channel>;
  updateSecret(token: string, reason: string): Promise<void>;
  on(ev: 'blocked' | 'unblocked' | 'close' | 'error', fn: (info?: unknown) => void): () => void;
  close(): Promise<void>;
}
export interface Amqp091Port { open(conn: ConnectionId, role: ConnectionRole, opts: { connectionName: string; signal?: AbortSignal }): Promise<Amqp091Connection> }

export interface Amqp10Delivery { id: number; message: { properties: Record<string, unknown>; applicationProperties: Record<string, unknown>; annotations: Record<string, unknown>; body: Uint8Array }; deliveryCount?: number }
export interface DescribedFilter { key: string; descriptor: string | number; value: unknown }
export interface Amqp10Receiver {
  readonly appliedFilters: ReadonlyMap<string, unknown>;      // from attach reply; caller fails closed (DC-23)
  addCredit(n: number): void;                                 // receivers open with credit_window 0 (DC-25)
  drain(timeoutMs: number): AsyncIterable<Amqp10Delivery>;
  release(d: Amqp10Delivery): void;
  accept(d: Amqp10Delivery): void;
  detach(): Promise<void>;                                    // only after every delivery is settled
}
export interface Amqp10Connection {
  receiver(address: string /* v2, percent-encoded */, opts: { filters?: DescribedFilter[] }): Promise<Amqp10Receiver>;
  management(): { purge(queue: string): Promise<number>; getQueue(queue: string): Promise<unknown> };
  putToken(token: string): Promise<void>;                     // 4.1+
  close(): Promise<void>;
}
export interface Amqp10Port { open(conn: ConnectionId, role: ConnectionRole, opts: { vhost: string }): Promise<Amqp10Connection> }

export type OffsetSpec = { kind: 'first' | 'last' | 'next' } | { kind: 'offset'; value: bigint } | { kind: 'timestamp'; ms: number } | { kind: 'interval'; value: string };
export interface StreamReader { read(n: number, timeoutMs: number): Promise<Array<{ offset: bigint; message: Amqp10Delivery['message'] }>>; close(): Promise<void> }
export interface StreamPort { anonymousReader(conn: ConnectionId, vhost: string, stream: string, from: OffsetSpec, filter?: { values?: string[]; matchUnfiltered?: boolean; sql?: string }): Promise<StreamReader> }

export interface MgmtHttpPort {
  request<T>(conn: ConnectionId, r: { method: HttpMethod; path: string; query?: Record<string, string | number | boolean>; body?: unknown; schema: z.ZodType<T>; idempotent: boolean; timeoutMs?: number; signal?: AbortSignal }): Promise<T>;
  list<T>(conn: ConnectionId, path: string, schema: z.ZodType<T>, o?: { columns?: string[]; pageSize?: number; disableStats?: boolean; enableQueueTotals?: boolean; signal?: AbortSignal }): AsyncIterable<T[]>;
  getMessagesFallback(conn: ConnectionId, vhost: string, queue: string, o: { count: number; truncate: number }): Promise<unknown[]>; // ack_requeue_true only (DC-10/55)
}
export interface PromSample { name: string; labels: Record<string, string>; value: number; ts?: number }
export interface PromScrapePort { scrape(endpoint: { node: string; url: string }, q: { families?: string[]; vhosts?: string[]; queueRegex?: string }, signal?: AbortSignal): AsyncIterable<PromSample> }

export type DialRoute =
  | { kind: 'direct' } | { kind: 'socks5'; host: string; port: number; auth?: string }
  | { kind: 'http-connect'; url: string } | { kind: 'ssh2'; hops: Array<{ host: string; port: number; user: string; keyRef?: string; hostKeySha256: string }> }
  | { kind: 'openssh'; destination: string } | { kind: 'k8s-port-forward'; context: string; namespace: string; pod: string; port: number }
  | { kind: 'system' };                                       // desktop v1.x: Electron net.fetch / resolveProxy
export interface DialTarget { host: string; port: number; servername?: string; purpose: 'broker' | 'oidc' | 'jwks' | 'vault' | 'webhook' | 'prometheus' }
export interface DialerPort {
  check(t: DialTarget): Promise<{ allowed: boolean; reason?: string; resolved: string[] }>;   // egress policy (DC-43)
  connect(t: DialTarget, r: DialRoute, signal?: AbortSignal): Promise<import('node:net').Socket>;
  forwarder(t: DialTarget, r: DialRoute): Promise<{ path: string; close(): Promise<void> }>; // for clients that cannot take a socket
  httpDispatcher(r: DialRoute): unknown;                       // undici Dispatcher
}
export interface TrustStorePort { init(): Promise<void>; secureContextFor(p: { connectionId?: ConnectionId; extraCaPem?: string[]; servername?: string; insecure?: boolean }): import('node:tls').SecureContextOptions; importCa(pem: string, scope: 'org' | ConnectionId): Promise<void> }
export interface KeyWrapPort { readonly kind: 'safe-storage' | 'keyring' | 'passphrase' | 'file-kek' | 'vault-transit'; wrap(dek: Uint8Array): Promise<Uint8Array>; unwrap(blob: Uint8Array): Promise<Uint8Array> }
export interface SecretStorePort { put(ref: string, plaintext: Uint8Array): Promise<void>; get(ref: string): Promise<Uint8Array>; delete(ref: string): Promise<void>; rotateDek(): Promise<void> }
export type Credential = { kind: 'basic'; username: string; password: string } | { kind: 'bearer'; token: string; expiresAt?: number; subject: string } | { kind: 'x509'; certRef: string; keyRef: string };
export interface CredentialProvider { readonly kind: string; acquire(c: { connectionId: ConnectionId; protocol: 'http' | 'amqp'; user?: Actor }): Promise<Credential>; refresh?(c: Credential): Promise<Credential> }
export interface TokenManager { current(conn: ConnectionId, protocol: 'http' | 'amqp', user?: Actor): Promise<Credential>; onRotate(fn: (e: { conn: ConnectionId; protocol: 'http' | 'amqp'; credential: Credential }) => void): () => void }
export interface ConnectionLease { readonly role: ConnectionRole; amqp091(): Promise<Amqp091Connection>; amqp10(vhost: string): Promise<Amqp10Connection>; release(): Promise<void> }
export interface ConnectionManager {
  lease(conn: ConnectionId, role: ConnectionRole, actor: Actor, opts?: { jobKey?: string; signal?: AbortSignal }): Promise<ConnectionLease>;
  budget(conn: ConnectionId): { roles: Record<ConnectionRole, { open: number; max: number }>; queued: number };
  registerHolder(h: { flush(reason: 'shutdown' | 'suspend' | 'cancel'): Promise<void> }): () => void; // DC-04 registry
  flushHolders(reason: 'shutdown' | 'suspend' | 'cancel'): Promise<void>;
  closeAll(reason: string): Promise<void>;
}
export interface BrokerProfileProvider { get(conn: ConnectionId, opts?: { maxAgeMs?: number }): Promise<BrokerProfile>; reprobe(conn: ConnectionId): Promise<BrokerProfile> }
export interface CapturedMessage { captureId: string; seq: number; properties: AmqpProperties; headers: Record<string, unknown>; body: Uint8Array; maskedText: string; meta: Record<string, unknown> }
export interface CaptureStore { open(kind: 'peek' | 'tap' | 'stream' | 'dlq' | 'export', source: TargetRef, opts: { retentionMs?: number; memoryOnly?: boolean }): Promise<string>; append(id: string, msgs: CapturedMessage[]): Promise<void>; search(q: { captureId?: string; text?: string; limit: number; cursor?: string }): Promise<{ items: unknown[]; cursor?: string }>; body(ref: string): Promise<Uint8Array> }
export interface Notifier { notify(n: { title: string; body: string; severity: 'info' | 'warn' | 'critical'; link?: string }): Promise<void> }

// ============================================================================
// svc-peek: planner + executor (DC-03..16)
// ============================================================================
export type DoomedPolicy = 'stop' | 'rescue' | 'raise-limit' | 'let-broker-handle';
export interface PeekRequest { connectionId: ConnectionId; vhost: string; queue: string; count: number; maxBytes?: number; doomedPolicy: DoomedPolicy; quarantineQueue?: string; preferTransport?: 'amqp' | 'http' }
export interface Preflight { queue: QueueFacts; dlqRisk?: { sources: Array<{ queue: string; limit: DeliveryLimit }>; blocking: boolean }; alarms: string[]; collectedAt: string }
export interface PeekPlanPreview {
  era: Era; queueType: QueueType; strategy: PeekStrategy; caps: { count: number; bytes: number; targetMs: number; abortMs: number };
  predicted: SemanticsCell; guard: { doomedWhen: string; policy: DoomedPolicy }; honestLabel: string; preflight: Preflight;
}
export interface PeekedMessage { position: number; copyRef: string; properties: AmqpProperties; headers: Record<string, unknown>; bodyPreview: string; size: number; redelivered: boolean; counters: { deliveryCount?: number; acquiredCount?: number }; doomed: boolean; disposition: 'returned' | 'rescued' | 'not-acquired' }
export interface PeekReceipt extends SideEffectReceipt { era: Era; method: PeekMethod; settle: SettleAction; holdMs: number; perMessage: Array<{ position: number; deltaAC: 0 | 1; deltaDC: 0 | 1; newPosition: Position; outcome: 'requeued' | 'rescued' }>; anomalies: string[] }
export interface PeekResult { peekId: string; messages: PeekedMessage[]; receipt: PeekReceipt; stoppedBecause: 'count' | 'bytes' | 'deadline' | 'doomed' | 'empty' | 'error' }
export interface PeekPlanner { plan(req: PeekRequest, ctx: ActionContext): Promise<PlanDraft<PeekPlanPreview>> }       // HTTP-only, touches no messages
export interface PeekExecutor {
  execute(plan: Plan<PeekRequest, PeekPlanPreview>, consents: ReadonlySet<string>, ctx: ActionContext): Promise<PeekResult>; // atomic; watchdog; nack + qos barrier
  flushAll(reason: 'shutdown' | 'suspend' | 'cancel'): Promise<void>;
  reconcileInterrupted(): Promise<PeekReceipt[]>;                                                                        // write-ahead records after a crash
}

// ============================================================================
// Engine composition + transports
// ============================================================================
export interface LiveSink<T> { readonly credit: number; push(item: T): boolean; snapshot(items: T[]): void; delta(upserts: T[], removes: string[]): void; status(s: 'active' | 'paused' | 'degraded' | 'stale', reason?: Problem): void; end(reason: 'completed' | 'lease_expired' | 'error', p?: Problem): void }
export interface TopicImpl<T extends TopicDef> { def: T; open(params: z.infer<T['params']>, sink: LiveSink<z.infer<T['item']>>, ctx: ActionContext): Promise<() => Promise<void>> }
export interface EngineModule {
  id: string; actions: ActionImpl<any, any>[]; topics?: TopicImpl<any>[]; jobs?: JobDef<any, any, any>[];
  onStart?(): Promise<void>; onStop?(drain: { deadline: number; reason: 'quit' | 'sigterm' | 'restart' }): Promise<void>;
  onSuspend?(): Promise<void>; onResume?(): Promise<void>;
}
export interface MessagePortLike { postMessage(msg: PortFrame, transfer?: unknown[]): void; on(ev: 'message', fn: (e: { data: PortFrame }) => void): void; on(ev: 'close', fn: () => void): void; start(): void }
export interface PortSessionServer { attach(port: MessagePortLike, uiToken: string): () => void }   // req -> app.inject; live -> hub
export interface Engine { start(): Promise<void>; drain(deadlineMs: number, reason: 'quit' | 'sigterm' | 'restart'): Promise<void>; suspend(): Promise<void>; resume(): Promise<void> }

// ============================================================================
// UI (Angular 22): transport + platform abstractions
// ============================================================================
export interface EngineRequest { method: HttpMethod; url: string; headers: Record<string, string>; body?: string | ArrayBuffer }
export interface EngineResponse { status: number; headers: Record<string, string>; body: string | ArrayBuffer }
export interface LiveChannel { readonly state: () => 'connecting' | 'open' | 'reconnecting' | 'closed'; send(f: ClientFrame): void; frames(): AsyncIterable<ServerFrame>; close(): void }
export interface EngineTransport { readonly kind: 'messageport' | 'http'; request(r: EngineRequest, signal?: AbortSignal): Promise<EngineResponse>; openLive(): LiveChannel }
export interface MenuModel { items: Array<{ commandId: string; label: string; accelerator?: string; submenu?: MenuModel['items'] }> }
export interface PlatformBridge {
  readonly kind: 'desktop' | 'web'; readonly bridgeVersion: 1;
  openExternal(url: string): Promise<void>;
  showSaveDialog(o: { suggestedName: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | null>;
  showOpenDialog(o: { multi?: boolean; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string[]>;
  notify(n: { title: string; body: string; severity: 'info' | 'warn' | 'critical' }): Promise<void>;
  setMenu(m: MenuModel): void; onMenuCommand(fn: (commandId: string) => void): () => void;
  onDeepLink(fn: (url: string) => void): () => void; appInfo(): Promise<{ version: string; platform: string; arch: string }>;
}
// Angular wiring (signatures):
//   export const ENGINE_TRANSPORT = new InjectionToken<EngineTransport>('ENGINE_TRANSPORT');
//   export const PLATFORM_BRIDGE  = new InjectionToken<PlatformBridge>('PLATFORM_BRIDGE');
//   desktop: { provide: HttpBackend, useExisting: MessagePortHttpBackend }   // same override as provideHttpClientTesting
//   class EngineApi { call<A extends ActionDef>(a: A, input: InputOf<A>): Observable<OutputOf<A>>;
//                     plan<A extends ActionDef>(a: A, input: InputOf<A>): Observable<Plan>;
//                     execute(planId: PlanId, consents: string[], confirmation?: string): Observable<unknown> }
//   function engineResource<A extends ActionDef>(a: A, input: () => InputOf<A> | undefined): HttpResourceRef<OutputOf<A> | undefined>;
//   class LiveClient { subscribe<T extends TopicDef>(t: T, params: z.infer<T['params']>, o?: { credit?: number }): Observable<z.infer<T['item']>> }

// ============================================================================
// @app/plugin-sdk (DC-53), apiVersion 1
// ============================================================================
export interface RawMessage { properties: AmqpProperties; headers: Record<string, unknown>; body: Uint8Array; queue?: string; protocol: 'amqp091' | 'amqp10' }
export interface NormalizedFailure { framework: string; messageType?: string; messageId?: string; exceptionType?: string; exceptionMessage?: string; stack?: string; sourceQueue?: string; failedAt?: string; retries?: number; deaths: Array<{ queue: string; reason: 'rejected' | 'expired' | 'maxlen' | 'delivery_limit'; count: number; exchange?: string; routingKeys?: string[]; time?: string }>; infrastructure?: 'delay' | 'retry' | 'none' }
export interface ReplayPlan { target: { kind: 'queue'; queue: string } | { kind: 'exchange'; exchange: string; routingKey: string; fanOutConfirmed: boolean }; headersToStrip: string[]; headersToSet: Record<string, unknown>; resetCounters: string[]; bodyTransform?: 'none' | 'edit' }
export interface DecoderPlugin { apiVersion: 1; id: string; framework: string; detect(m: RawMessage): number; decode(m: RawMessage): NormalizedFailure; fingerprint(f: NormalizedFailure, level: 'type' | 'type+frame' | 'type+frame+template'): string; replayPlan(f: NormalizedFailure, m: RawMessage): ReplayPlan }
export interface CodecPlugin { apiVersion: 1; id: string; detect(m: RawMessage): number; decode(body: Uint8Array, hints: Record<string, unknown>): unknown; encode?(value: unknown, hints: Record<string, unknown>): Uint8Array }
```

## Repo layout

```text
/                                    # greenfield Nx 23.3 + pnpm workspace, Apache-2.0
|-- AGENTS.md                        # canonical agent guide: conventions, generators, verification commands
|-- CLAUDE.md                        # <=200 lines; imports @AGENTS.md; hooks/skills pointers
|-- .claude/{rules/*.md, skills/*, settings.json}   # path-scoped rules; hooks: format/lint on edit, affected typecheck+test on stop
|-- LICENSE  NOTICE  THIRD_PARTY_NOTICES(generated)  SECURITY.md  CONTRIBUTING.md (DCO, AI policy)  GOVERNANCE.md  TRADEMARKS.md
|-- nx.json  pnpm-workspace.yaml (catalogs = exact pins)  package.json (packageManager)  tsconfig.base.json (TS 6.0.3 strict)
|-- eslint.config.mjs                # boundaries depConstraints + banned imports (TS7, @types/amqplib, primeng, ag-grid-enterprise, ...)
|-- docs/
|   |-- adr/                         # ADR-001..027 from this blueprint
|   |-- architecture/                # blueprint, diagrams, DC traceability
|   |-- specs/                       # one spec per agent task (template: goal, files, out-of-scope, G/W/T, verify)
|   `-- compat.md                    # API/live/plugin/schema/config versions; published broker matrix
|-- apps/
|   |-- engine/                      # composition root; esbuild -> dist/engine/main.mjs
|   |   `-- src/{main.ts, compose-core.ts, modes/{desktop,local,team}.ts, modules.ts}
|   |-- web/                         # Angular 22 shell: routes, layout, provider selection per transport
|   |-- desktop/                     # Electron 45: src/main/{index,engine-host,protocol,windows,security,menus,power,secrets-bridge,updater}.ts
|   |   |-- src/preload/index.ts     # contextBridge PlatformBridge + MessagePort forwarding (CJS bundle)
|   |   `-- electron-builder.yml     # fuses, mac notarize, MSIX/NSIS/zip, deb/rpm/AppImage; test-fused variant
|   |-- cli/                         # npx <product>: serve | open | mcp (stdio shim) | lint | export | doctor (node:util parseArgs)
|   |-- conformance/                 # public conformance suite (DC-47) + matrix report generator
|   |-- e2e-web/  e2e-desktop/  perf/
|-- libs/
|   |-- shared/                      # runtime:isomorphic
|   |   |-- contracts/               # kit + actions/** + topics/** + errors + config schema + bridge API; api/openapi.v1.json, asyncapi.v1.json
|   |   |-- domain-model/  semantics/  effective-config/  routing/  topology-code/
|   |   |-- deaths/  lint-rules/  masking/  forecast/
|   |   `-- plugin-sdk/              # publishable later as @<coined>/plugin-sdk; self-contained
|   |-- engine/                      # runtime:node
|   |   |-- kernel/  jobs/  live/  transport/  ports/  persistence/
|   |   |-- adapter-mgmt-http/  adapter-amqp091/  adapter-amqp10/  adapter-stream/  adapter-prometheus/  adapter-k8s/
|   |   |-- net-dialer/  net-truststore/  secrets/  plugin-host/  decoders/
|   |   `-- svc-{connections,identity,capabilities,explorer,peek,messages,tap,dlq,streams,topology,admin,metrics,alerts,lint,audit,access,workspace,mcp}/
|   |       `-- src/{index.ts, module.ts, actions/*.ts, topics.ts, jobs/*.ts, internal/**, *.spec.ts}   # uniform shape
|   |-- ui/                          # runtime:browser
|   |   |-- platform/  data/  design/ (tokens, tailwind preset, helm/ copied with MIT notice)  grid/  graph/  editor/  charts/  commands/
|   |   `-- feature-{connections,explorer,messages,tap,dlq,streams,topology,admin,metrics,lint,jobs,governance,settings}/
|   `-- testkit/                     # port fakes, scenario engine, Testcontainers builders (5552/15692), toxiproxy, golden fixtures/<version>/
|-- tools/
|   |-- generators/                  # action, topic, job, service-module, adapter, ui-feature, lint-rule, decoder, semantics-cell, migration, conformance-cell
|   `-- scripts/                     # licence gate, git-URL lockfile ban, banned deps, notices, bundle budgets, wording lint
`-- packaging/
    |-- docker/                      # Dockerfile (distroless nodejs24-debian13:nonroot), compose.yaml (dev + postgres:17)
    `-- helm/<product>/              # chart; values.schema.json generated from contracts config schema
```

## Risks

- Tunnelling the router over MessagePort (inject plus structured clone) shows unexpected latency, payload limits or reload edge cases in Electron 44/45. → Spike S1 in M0 with p95 latency and 16 MiB payload targets. Large files go to disk through the engine. A loopback fallback can sit behind the same EngineTransport interface, carrying the DC-36 controls, if ever needed.
- The in-house contract kit grows into a homemade framework. → Cap its scope by ADR (router, problems, auth hooks, emitters) and keep it under about 800 LOC with full tests. Generators carry the conventions. Anything bigger needs a new ADR.
- Every semantics cell is code-derived. A wrong cell can drop production messages. → The conformance harness ships in M2 before any peek UI. Cells are labelled code-derived or lab-verified, and the UI shows the status. The coverage gate requires each cell to have a passing test. Defaults stay conservative (stop on doomed messages, consent on 4.0-4.2).
- A DOWN signal overtakes a pipelined nack, so the nack plus qos barrier still produces failed-delivery counts under leader changes. → Run chaos tests with toxiproxy and leader transfers over thousands of runs. The receipt records anomalies. The 5 s hold target limits exposure. Notes are documented for each era.
- node:sqlite is a release candidate and synchronous; Node 26 renames its classes. → Use the in-repo dialect with runtime detection and a contract test suite. Search runs in a worker. better-sqlite3 13.0.3 is the drop-in fallback.
- Agents install unpinned or banned versions (TypeScript 7, @types/amqplib, NestJS add-ons, PrimeNG). → pnpm catalogs with exact pins, a banned-import lint rule, lockfile scans (including git URLs), a licence gate and Renovate groups, all enforced in CI.
- amqplib has a bus factor of about 1 and rhea has a single maintainer. → Both sit behind ports with contract suites against @cloudamqp/amqp-client. Pin exact versions and be ready to fork (MIT and Apache-2.0 licences). Contribute 4.3 CI and fixes upstream.
- Electron's 8-week cadence and breaking changes (Electron 46 kill() and removal of sync safeStorage) destabilise the desktop shell. → Async APIs only. The engine exits from its own SIGTERM handler. A Renovate Electron group runs the e2e-desktop smoke and the Electron-Node conformance subset before any upgrade.
- Worker-thread plugins are not a security boundary. → Trusted-install model with integrity hashes. Admin-only installs on the team server. Data-first declarative decoders cover most frameworks. A process sandbox using the Node permission model comes in v1.x (spike S12).
- Prompt injection through message payloads steers MCP or AI actions. → Mutating tools are off by default and plan-only, with human approval. Tools use connection aliases only, never hosts or credentials. Payloads are quoted, capped, stripped and masked. The executor forbids let-broker-handle for AI actors. All AI actions are audited.
- The team server runs as a single replica, which is a single point of failure. → Document it. Jobs resume from checkpoints and peeks reconcile after restart. The specified HA path uses advisory-lock leaders, SKIP LOCKED leasing and sticky live sessions.
- Delegated OAuth tokens expire during long replay jobs. → Store refresh tokens with envelope encryption and revoke them at logout. An admin-approved service-account fallback is recorded in the receipt. The job pauses with a clear reason rather than failing silently.
- CSP and Trusted Types break Monaco, AG Grid, Cytoscape or the ELK worker under app://. → Spike S4. Allow-list Trusted Types policy names. Start in report-only mode if needed. Workers are loaded from 'self' only.
- Contracts shipped to the browser inflate the initial bundle. → Deep imports per domain, sideEffects:false and a CI bundle-budget gate. Fallback: a generated route table with type-only imports.
- Metrics cardinality or write load overwhelms SQLite on large clusters. → Cardinality caps (watched plus top-K queues), batched transactions and an in-memory hot window. Per-queue history is opt-in. The team server uses Postgres.
- The SignPath 'no hacking tools' clause or reputation thresholds block Windows signing. → Store MSIX is the primary Windows channel. The linter is framed as hygiene for brokers the user connected to, with no scanning. Certum or an organisation with Azure Artifact Signing are the fallbacks.
- utilityProcess ESM entry and cold start fall outside budget. → Spike S2. Fall back to a CJS bundle, lazy-load optional adapters, and use the Electron snapshot/code-cache improvements.
- Scope is very broad for v1. → Vertical milestones M0-M8, each shippable. The no-plugin core (peek, tap, republish, topology) comes first. Capability-gated enhancements come later.
