# Plan: `<Product>` for RabbitMQ®, the open-source workbench and control plane (web app first, then desktop)

> **Step 0 executed on 2026-10-16 with reduced scope (maintainer instruction):** the repo was switched to **private**; all documentation (this plan, research, product, architecture, ADR-001…034, runbooks, governance files) was committed and pushed to `main`; GitHub milestones, labels and issues were created from [`work-items.json`](work-items.json) (index: [`work-items.md`](work-items.md)). **No product code.** The issue forms, PR template, seed script and banned-terms CI check are deferred to their work packages (M0-04, M0-06, M0-07). The Project board needs the `project` token scope and is tracked as a human prerequisite issue.

> **Status:** final plan, ready for approval.
> **Product name:** deferred by the user. A private `<codename>` is used until a cleared brand (ADR-029) is chosen, and nothing is published before then.
> **Repo:** `AnotherRabbitMqManagementPortal`, empty and greenfield. It stays private while it carries "RabbitMq" in its name.
> **How it was produced:** 4 multi-agent workflows (31 agents), all read-only.
> 1. Research sweep (9 angles + completeness critic)
> 2. Stack deep-dive (3)
> 3. Source-level verification at exact RabbitMQ tags + gap research (8 + fact-sheet editor)
> 4. Design panel: product, 3 competing architectures, 2 judges, lead architect, planner, final consistency critic
>
> In Step 0 (§6.1) everything is documented in `docs/` (this plan, research, product, architecture, ADR-001…034, runbooks), and GitHub is seeded: 9 milestones, ~200 issues, a Project board.

## Context
- **The ask:** build an advanced RabbitMQ management portal that becomes **the de facto tool for both managing and using RabbitMQ**. It must run on all desktop OSes and also as a web application.
- **Exploration requested:**
  - what an advanced, genuinely useful portal must be;
  - the existing tool landscape, including current and roadmap features of existing desktop tools.
- **Intended outcome:**
  - a verified product definition;
  - an architecture that ships one engine and one UI in every delivery mode;
  - an execution plan decomposed for AI coding agents, **delivered web-first**.

| Confirmed decision | Value |
| --- | --- |
| Language | TypeScript end to end: Node 24 engine plus **Angular 22** UI (explicitly not React) |
| Licence / business | **Fully open source (Apache-2.0)**. Team features (SSO, RBAC, audit, approvals, masking) are free. No paid tiers, no SaaS |
| Delivery modes | Web app in Docker; desktop for Windows, Linux and macOS; self-hosted team server (Docker/Helm) |
| **Delivery order** | **1. Docker web app (single user) → 2. Windows desktop → 3. Linux desktop → 4. macOS desktop → 5. team server**, then ops intelligence, AI and platform scale |
| First release users | **Single user.** Loopback-only container with token login, reached through an SSH tunnel when remote. Team features wait for the team-server milestone (after macOS) |
| Delivery method | Built mostly by **AI agents**: agent-sized work packages with Given/When/Then acceptance criteria and exact verification commands |
| Name | Deferred. Private codename until cleared; no public identifiers before then |
| **Docs policy** | **No document in the repo references the third-party product named in the banned-terms list** (see [ADR-034](../adr/ADR-034-docs-policy.md)) (name, domain, vendor, pricing, release history, screenshots). What we learned survives only as unattributed product requirements (§1.1). Enforced by a docs banned-terms check |
| **System of record** | **GitHub.** Every milestone is a GitHub milestone. Every piece of work is a GitHub issue, and no work happens without one. A GitHub Project tracks status. Everything else is docs-as-code in `docs/`: plan, research, product, architecture, ADRs, runbooks |
| **Repo visibility** | `RafaelJCamara/AnotherRabbitMqManagementPortal` is currently **public** (and empty). It is switched to **private** before anything is pushed, consistent with "nothing public until the name is cleared" |

---

## 1. What the research found (verified 2026-10-16)

### 1.1 Lessons from existing desktop tools (unattributed requirements we adopt)
**Market shape**
- Today's desktop tools are closed source and desktop only.
- They use single-machine licences, often with online licence checks and telemetry, and x64-only builds outside macOS.
- None has a web or team edition.

**Our answer**
- Open source, works offline, no telemetry.
- A web app first; then arm64 + x64 desktop builds distributed through package managers.
- A free team server.

**Table-stakes developer features we must match and exceed**
- Messages:
  - A DLQ explorer that copies messages into a local store, with facet filters and throttled republish.
  - A live spy.
- Analysis:
  - A drain-time forecast.
  - A routing graph that includes DLX and alternate exchanges.
  - An effective-policy debugger.
- Workflow:
  - Cmd+K search.
  - A Monaco publish editor with headers, properties and history.
  - Saved views and bulk purge/delete.
  - Dark theme and AMQP connection strings.

**Frequently requested, still unshipped in the market**
- Protobuf; queue alerts; export of consumed messages; a schema-driven dummy-message generator.
- Bulk publish from JSON/CSV/Excel; filtering by JSON keys.
- Users, policies, connections and channels management; monitoring statistics.

**Gaps across the market**
- Users, permissions and limits; connections, channels and nodes.
- Feature flags and deprecated features; definitions; shovels and federation; streams.
- OAuth, mTLS, SSH and proxies.
- Non-JSON codecs; long-term metrics and alerts.

**Correctness pitfalls seen in shipping tools (must not repeat)**
- **Effective-policy precedence shown wrong.** In reality, queue arguments win over user policies for most keys, limits take the minimum, and operator policies merge first.
- **Replays default to the message's exchange.** For dead letters that is the DLX, so replays loop back.
- **Spies are blind to default-exchange traffic and drop binding arguments**, so on headers exchanges they over-capture.
- **Peek docs ignore version semantics.** nack spends the quorum-queue budget on 4.0–4.2.

### 1.2 Official management UI and Tanzu
- The OSS UI is an old Sammy.js/jQuery SPA:
  - "Get messages" is labelled destructive (fetch then requeue) and disabled for streams;
  - no search, export, bulk actions, DLQ redrive, topology graph, multi-cluster or audit;
  - ~130 HTTP routes and no OpenAPI.
- The core team (2026-09-23) will modernise internals first; a new UI comes "later".
- Paid Tanzu is closing gaps OSS users don't get: **Stream Browser, Linter, Message Scheduler, AMQP-over-WebSocket**.
- Management metrics are deprecated in favour of Prometheus but are still on by default. With stats off, fields disappear in ways that differ by version.

### 1.3 RabbitMQ semantics that shape the product
Every claim here comes from source at exact tags; the conformance lab will confirm them (§4.8).

| Era | Counter the QQ limit uses | `nack`/`released` peek | `reject`, `modified(df)`, close/disconnect while holding | Notes |
| --- | --- | --- | --- | --- |
| 3.13 | delivery_count (no default limit) | +1 (to the TAIL if unlimited) | +1 | `x-delivery-limit=-1` **drops on the first return** |
| 4.0–4.2 | **acquired_count**, default L=20 | **spends budget** (0-9-1 `x-delivery-count` shows AC) | spends budget | The HTTP "Get messages" also spends budget; AMQP 1.0 clients cannot see it |
| 4.3+ | delivery_count | only `x-acquired-count`+1 (free), unless DC > L | **counts as failed** | **DLQ trap:** carried-over DC means the first return in a default-L quorum DLQ drops the message. Delayed retry hides nack-peeked messages |

- **Only side-effect-free classic/quorum read:** CLI `rabbitmq-queues peek` (QQ only, needs the Erlang cookie). So the product must say **"side-effect-aware peek", never "non-destructive"**. "Non-destructive" is allowed only for anonymous stream reads and a future node agent.
- **Streams:** the only non-destructive structure.
  - Read via AMQP 1.0 (offset/timestamp; property filters 4.1+; SQL filters 4.2+) or 0-9-1 `x-stream-offset`.
  - `basic.get` on a stream gives a connection-level error 540.
  - Port 5552 is often unreachable, and Amazon MQ has no streams.
- **Taps:**
  - A copied-binding classic queue is blind to the default exchange.
  - It steals messages on consistent-hash, modulus-hash, random and local-random exchanges.
  - It can mask alternate exchanges and mandatory returns.
  - The firehose is per node and not persisted, and the HTTP vhost toggle affects only the serving node.
  - `PUT /api/vhosts` **without default_queue_type resets it**, and also wipes description and tags.
- **4.x ignores a client-set `x-death`.** Replay must strip broker headers and resolve the destination queue-first.
- **Version window:**
  - 4.3.6 is the only community-supported series (until 2027-01-31).
  - 4.2 OSS is frozen at 4.2.9 (commercial to 2030). 4.1 and 3.13 are commercial-only. 4.0 is EOL.
  - **4.4 GA is imminent** (alphas exist).
- **Official JS AMQP 1.0 client (coders51 1.0.0) is unfit:** broken offsets/filters, no vhost, credit race, git dependency. We write our own rhea adapter.

### 1.4 Landscape 2026 and white space
**No de facto RabbitMQ tool exists.**
- Best OSS RabbitMQ GUIs: 154★ / 91★ / 89★.
- Kafka/Redis analogues: kafka-ui 12.3k★, RedisInsight 8.9k★.
- rabbitmq.com's devtools page lists only two third-party visual tools. A listing is a one-line PR.

**Verified competitors**

| Competitor | Model | Notable |
| --- | --- | --- |
| HZN Queue Console | paid desktop; web "Q4 2026" | had a QQ-destroying search bug |
| Queue Studio | paid JetBrains plugin | HTTP /get; its "never counts" claim holds only on 4.3+ |
| QueueExplorer 5 | $149/$249 | session-close returns count on every era |
| Warren | closed DLQ console | team tiers unreleased |
| QueueLens | MIT web, 0★ | — |
| Qarote | open core | SSO/RBAC/audit paid |
| amazon-mq MCP v4 | — | its "read-only" `get_messages` is the stateful HTTP get |

**White space nobody fills:**
- version-correct semantics backed by a **public conformance matrix**;
- a **free OSS team server**;
- one engine and UI for web, desktop and team;
- admin + messages + ops in one tool;
- a correct effective-config debugger;
- multi-framework DLQ decoding;
- an OSS stream browser with stage-2 filters;
- a routing simulator;
- a lint and upgrade advisor;
- governed MCP.

### 1.5 Top user pains (Stack Overflow, GitHub, HN; frequency × severity)
1. Unsafe message inspection.
2. Manual DLQ triage and replay.
3. Stuck unacked consumers and prefetch.
4. Upgrade readiness (flags, deprecated features, Khepri).
5. Memory/disk alarms.
6. "Why is this queue growing?" with no history.
7. Classic→quorum migration.
8. Connection churn.
9. Retry/delay patterns (the delayed-message plugin is archived and has no 4.3 build).
10. Accidental purge/delete in prod.
11. Cluster/quorum health.
12. "Where did my message go?"
13. Coarse permissions (purge needs only *read*).
14. No audit.
15. Brittle OAuth.

### 1.6 What makes a tool de facto
- Free and runnable with one command (`docker run …` fits this exactly).
- Vendor-neutral, local-first, no forced login, no telemetry.
- Precedents: kafka-ui and kafbat (fully OSS, including RBAC and masking), Bruno's offline pledge.
- **One codebase shipped as web + desktop**, as pgAdmin 4, RedisInsight, Headlamp and Hoppscotch do. Conduktor killed its desktop app and IBM deprecated MQ Explorer.
- Trust assets: correctness evidence, signed builds, docs and free web utilities.

---

## 2. Product definition
**Positioning:** *The open-source workbench and control plane for RabbitMQ®: one engine and one UI in your browser, on your desktop or on your team's server, with message tools that know what your RabbitMQ version really does.*

**Personas:**
- **DEV:** inspect, publish, tap, debug routing, fix and replay dead letters, read streams.
- **OPS/SRE:** health, alarms, backlog, effective config, QQ replicas, upgrades, history, alerts.
- **SEC:** SSO, least privilege stricter than the broker, audit of every peek/publish/purge/replay, approvals, masking.
- **PLAT:** many clusters, managed brokers, topology-as-code, drift, self-service, air-gapped installs.

**Principles (binding):**
1. Correct by version: everything comes from the semantics registry, and the era badge is shown on every message action.
2. Honest side-effect wording, with a plan before and a receipt after every peek.
3. Production is read-only until armed; destructive actions need typed confirmation, a dry run and a receipt.
4. Local-first: no telemetry or phone-home, works offline.
5. The engine does all broker I/O; the browser never talks to brokers and users never configure CORS.
6. A capability probe runs on every connect, and every disabled feature says why.
7. Everything is open source.
8. Keyboard-first, with a browser-safe keymap.
9. One engine and one UI build for every delivery mode.
10. A public conformance matrix backs every claim.
11. Objects owned by other systems (ServiceControl, the Topology Operator, AWS) are read-only by default.
12. WCAG 2.2 AA and i18n from day one.

**Feature catalogue: 147 features in 17 areas** (full list in `docs/product/features.md`; Step 0 re-tags milestones per §3)

| Area (count) | Headline capabilities |
| --- | --- |
| Connections & environments (9) | Profiles with environment colours and prod lock; encrypted secrets; TLS/mTLS; SSH (ssh2 + system OpenSSH), SOCKS5, HTTP CONNECT; OAuth PKCE, device code, token command, Vault dynamic; Kubernetes discovery; provider presets (Amazon MQ, CloudAMQP, LavinMQ) |
| Explorer & search (7) | VS Code-style shell, inventory windows to 100k queues, command palette, deep links, error explainer and show-as-curl |
| Message workbench: peek (14) | Semantics registry and era resolver; planned, side-effect-aware peek with receipts; post-acquire guard and dispositions (quarantine / raise-limit); viewer (JSON/raw/hex/headers/deaths/diff); codecs (JSON, text, gzip/deflate/brotli, MessagePack, CBOR, BSON, XML, Protobuf, Avro); encrypted capture workspace with FTS5 search; extract; restricted HTTP fallback; zero-side-effect node-agent peek |
| Publish (7) | Monaco studio with mandatory flag and confirms, routing result, history; Git-friendly templates/collections; rate-limited bulk publish (JSON/CSV/Excel); schema-driven generators; request/reply tester; copy-as-code |
| Tap (6) | Copied-binding tap with blind-spot badges; exchange-to-exchange tap; firehose leases; capture-to-stream; message lifecycle trace |
| DLQ operations centre (11) | DLQ inventory and hazard advisor; death-history normaliser; replay (confirm-then-ack, park, journal, canary, throttle); framework decoders (MassTransit, Spring, NServiceBus, EasyNetQ, Celery, then Symfony, Rebus, Wolverine, Laravel, Dramatiq, Sneakers); fingerprint grouping; edit and resend; move/copy/selective delete; analytics |
| Streams (6) | Offset/timestamp browser (0-9-1 + AMQP 1.0); Bloom/property/SQL filters with filter echo; super streams and offsets; stream-protocol fast path; range replay |
| Topology & routing (4) | Cytoscape + ELK graph; simulator covering topic, headers, exchange-to-exchange, alternate exchange, DLX/TTL, CC/BCC; binding CRUD; live flow overlay |
| Policies & effective config (3) | **Correct** effective-config resolver with provenance; policy and operator-policy editor with impact preview |
| Admin CRUD (15) | Vhosts (GET-merge-PUT); users, permissions, topic permissions, limits; connections, channels, consumers; nodes and health checks; feature flags and deprecated features; definitions; shovels and federation; QQ replica ops and rebalance; CLI-only runbooks; guarded bulk ops |
| Monitoring & alerts (8) | Prometheus-first per-node scraping; live charts; drain forecast; history store; time-series explorer; alerts (in-app/desktop + Slack, Teams, email, webhook); fleet overview; event timeline |
| Diagnostics, lint & upgrade (9) | Lint catalogue (all DC-56 hazards); upgrade-readiness advisor; consumer, connection-hygiene and alarm diagnostics; quorum health; classic→quorum migration wizard |
| Topology-as-code (5) | Snapshots and diff; plan/apply; Terraform, Topology Operator CRD and AsyncAPI export/import; drift detection |
| Team server (14) | OIDC BFF; deny-by-default RBAC (peek ≠ purge ≠ replay); hash-chained audit; four-eyes approvals; masking; SSRF egress policy; shared catalogue and RBAC-filtered pollers; delegated broker credentials; emergency revoke and freeze; Helm; SCIM; HA; self-service |
| AI & MCP (5) | Read-only local MCP; team `/mcp` as its own OAuth resource with no token passthrough; mutating tools only as plans through approvals; prompt-injection hardening; grounded copilot with BYO or local models |
| Extensibility (6) | Plugin SDK (3 trust tiers: worker, declarative, QuickJS sandbox); header registry; lint-rule SDK; tool CLI; REST tokens; UI extension points |
| Distribution & platform (18) | Docker image first; then signed desktop builds for Windows, Linux and macOS; Helm; opt-in updates; a11y; i18n; docs; free web utilities (x-death decoder, topic-pattern tester, policy tester, URI builder, era explainer); no telemetry |

**UX shell** (identical in browser and desktop):
- Activity bar: Explorer, Messages, Streams, Topology, Admin, Metrics, Diagnostics, Team, Settings.
- Environment-coloured connection switcher and an explorer tree (cluster › vhost › objects).
- Tabbed workspace with splits.
- Bottom panel: Jobs, Receipts, Tap feed, Problems, Output.
- Status bar: era badge, stats mode, read-only lock.

**M1 developer checklist** (`docs/product/m1-checklist.md`), met first in the Docker web app:
- every table-stakes feature in §1.1;
- plus streams, OAuth/mTLS/SSH/proxies, correct policy precedence and version-correct peek;
- free.

---

## 3. Roadmap: web first, then Windows, Linux, macOS

Each desktop milestone has two lanes, run by agents in parallel worktrees:
- a **platform lane**: shell, packaging, signing, OS integration;
- a **feature lane**: features that ship to the web app and to every desktop platform already released.

| Milestone | Deliverable | Platform lane | Feature lane | Exit criteria (abridged) |
| --- | --- | --- | --- | --- |
| **M0 Foundations & evidence** (internal alpha 0.1) | Engine + UI running as a **single-user Docker web app**, proving what each RabbitMQ version does, with a read-only explorer | Container mode (loopback bind, token, data volume, healthcheck), multi-arch image, private GHCR, release workflow for images | Repo, gates, agent toolchain; contracts kit; semantics registry and era resolver; broker lab and lab evidence; capability probe; persistence and secrets (file KEK / passphrase); ActionExecutor and audit; HTTP + WebSocket transport; Angular shell; explorer | Settle-path cells three-way green on 3.13.7 / 4.1.8 / 4.2.9 / 4.3.6 (4.0.9 visible, non-blocking); matrix v0. Explorer works in the container against local, Amazon MQ and CloudAMQP brokers. Image signed (cosign) and private. All gates enforced |
| **M1 Web 1.0 "Developer"** (first public release; needs ADR-029 name) | **The dockerized web app** as the best developer tool for RabbitMQ | Compose quickstart (app + RabbitMQ); host-broker networking (`host.docker.internal`, Linux `host-gateway`); SSH-tunnel guide for remote use; browser matrix (Chrome, Edge, Firefox, Safari); public GHCR (and optional Docker Hub mirror) | Safe peek, publish, tap, stream browser, routing simulator, effective config, DLQ basics (inventory, deaths, replay), queue/exchange admin, TLS/mTLS/tunnels/OAuth (PKCE redirect to the app origin), live metrics and forecast, palette, a11y, i18n, docs | Every peek receipt matches the conformance matrix. M1 developer checklist 100%. Time-to-first-peek < 3 min from `docker run` in usability tests (Windows, macOS and Linux hosts). Devtools listing PR |
| **M2 Windows desktop 1.0** | Signed Windows app (x64 + arm64) | Electron shell (main, preload, supervisor, **MessagePort tunnel**, `app://`, fuses, CSP); safeStorage key wrap; OS notifications; system-browser OAuth; native menus; MSIX (Store) + NSIS (Certum/SignPath), electron-updater; Windows CI with broker-lab reachability; MSIX virtualisation and data-directory rules; spellchecker off; desktop egress E2E; optional `npx` local-web channel | **Management parity I:** vhosts, users, permissions, topic permissions, limits; connections, channels, consumers; nodes and health checks; feature flags and deprecated features; **policy and operator-policy editor** | Windows release passes signature, WACK and SmartScreen-free (Store) checks. Desktop E2E green on Windows x64 and arm64. Parity I live on web + Windows |
| **M3 Linux desktop 1.0** | Linux app (x64 + arm64) | deb/rpm with AppArmor profile, AppImage (Ubuntu 24.04 caveat), signed apt/rpm repositories or updater; Secret Service / basic_text → master password; X11 and Wayland checks; Linux desktop E2E (xvfb) | **Management parity II + DLQ operations centre:** definitions, shovels/federation, QQ replica ops, CLI runbooks, guarded bulk ops; full replay engine, edit and resend, move/copy/selective delete; plugin SDK + framework decoders v1.0 | Official-UI parity checklist: every HTTP-available action native, CLI-only actions have runbooks. Decoder fixture apps pass. Replay chaos: **0 lost; duplicates detectable (replay-id) and within a stated bound**. Linux packages pass install/upgrade tests on Ubuntu, Fedora and Debian |
| **M4 macOS desktop 1.0** | Notarised macOS app (arm64 + x64) | Developer ID signing + notarisation, DMG + zip, Local Network permission (`NSLocalNetworkUsageDescription`), keychain prompts, Homebrew tap, macOS E2E | **Advanced messaging & ecosystem:** exchange-to-exchange tap, firehose leases, stream ops and filter builder; publish collections, bulk publish, generators, request/reply, copy-as-code; providers + Kubernetes discovery; local IPC + tool CLI + read-only MCP; free web utilities | `spctl`/`codesign` checks pass. macOS E2E green on arm64 + x64. **All four platforms at 1.x** with parity and the DLQ centre |
| **M5 Free team server** (2.0) | The Docker web app gains multi-user mode | Helm chart (restricted PSS), Compose quickstart, Postgres, air-gap kit | Team runtime, OIDC BFF, RBAC, shared catalogue and pollers, delegated credentials, audit and anchors, approvals, masking, SSRF egress, desktop remote workspaces, revoke/freeze, security review, team privacy, scale tests | Every mutating API has RBAC and audit tests. Delegated OAuth works with Keycloak 26 and Entra. Compose quickstart < 10 min |
| **M6 Ops intelligence** | All platforms | Flathub / Snap wave | Lint engine, upgrade advisor, diagnostics, history store, alerts, fleet and event timeline, decoders v1.1 + analytics, stream fast path, topology diff | Rule catalogue covers all DC-56 hazards with per-version fixtures. Upgrade advisor validated on 4.2→4.3 and 4.4. Alerts proven end to end |
| **M7 Governed AI & MCP** | All platforms | — | Team `/mcp` OAuth resource, governed mutating tools, injection hardening, grounded copilot, red-team gate | RFC 8707 audience tests pass. Red-team corpus passes. Zero AI calls when unconfigured |
| **M8 Platform scale & ecosystem** | All platforms | HA team server | Plan/apply topology-as-code, IaC/AsyncAPI, drift, SCIM, self-service, node agent, migration wizard, UI extensions, foundation application | Terraform and Topology Operator round-trips. HA survives replica loss. Node-agent zero-side-effect cells pass |

**Why this order** (user decision plus supporting reasons):
- **Docker web first.** One artefact runs everywhere Docker runs. It needs no signing costs or OS approvals, and gives the fastest feedback loop. It is the natural base for the later team server.
- **Desktop shells add platforms, not a rewrite.** Each one reuses the same engine and UI.
- **Windows before Linux and macOS.** Windows has the largest desktop share and the hardest signing story.
- **macOS last.** That defers the Apple Developer cost.
- **Correctness evidence still comes first (M0).** Peek, tap and DLQ ship only behind the conformance gate.

**Desktop is deferred, not designed out.**
- The ADR-002 MessagePort transport, the `EngineTransport`/`PlatformBridge` abstractions and the engine's mode files are designed in M0.
- A transport test runs the contract suite over HTTP/WS and a fake port.
- The UI stays browser-API-clean.
- Desktop spikes run at the tail of M1 so that M2 starts de-risked.
- **Signing lead time:** Windows signing accounts (Microsoft Partner Center, Certum) are opened during M1.

---

## 4. Architecture (final blueprint)
Synthesis: the simplicity-first skeleton plus safety-first semantics plus scale-first mechanisms. The judges scored simplicity-first 8.03/7.80, safety-first 7.93/8.10 and scale-first 7.73/7.63. Hosts are introduced in roadmap order.

```
                ┌──────────── one Angular 22 build (dist/web) ────────────┐
 M0/M1 Web (Docker): browser ──HTTP + 1 multiplexed WebSocket (token, Host/Origin checks)──► engine container (127.0.0.1-published)
 M2–M4 Desktop:      Electron main ──MessagePort (fastify.inject tunnel)──► engine (utilityProcess)   [Windows → Linux → macOS]
 M5 Team:            browser ──OIDC BFF cookie + CSRF──► engine container(s) ── Postgres
 M4+ CLI / stdio MCP shim ── UDS / named pipe, mutual HMAC ──► engine
 engine ──(Dialer: direct | TLS | SSH | SOCKS5 | HTTP CONNECT | k8s port-forward; SSRF policy)──► brokers
        mgmt HTTP (undici+zod) · AMQP 0-9-1 (amqplib) · AMQP 1.0 (own rhea adapter) · streams (optional) · Prometheus (per node)
```

### 4.1 Key decisions (34 ADRs → `docs/adr/`, MADR format, indexed in `docs/adr/README.md`)

| ADR | Decision |
| --- | --- |
| 001 | One Node 24 ESM engine bundle and one UI build in every host. Container first (M0/M1), Electron per OS (M2–M4), team (M5). Mode files only swap adapters: storage, key wrap, auth, authz policy, listeners |
| 002 | Desktop transport (from M2): **one MessagePort per page load tunnelling the same REST router via `fastify.inject`**. Renderer auth headers are stripped and a carrier secret is added. Bodies over 1 MiB stream as chunks. Angular uses a custom `HttpBackend`. The abstraction exists from M0 |
| 003 | **One zod contract registry** (`defineAction`/`defineTopic`) generates the router, OpenAPI 3.1, AsyncAPI 3.0, MCP tools, CLI commands and a typed Angular `EngineApi`. No client codegen (no Orval) |
| 004 | **Fastify 5.12.7 only**, with an in-house kit capped at 800 LOC. No NestJS: @nx/nest doesn't support Nest 12, and Nest pins a vulnerable fastify. This is a deliberate deviation from DC-49 |
| 005 | One multiplexed live protocol with credits, per-topic QoS (lossless / latest / sampled), bounded outboxes, gap/goaway/resume; previews only, bodies by reference |
| 006 | **A single fail-closed ActionExecutor** for UI, CLI, MCP and jobs: plan → execute, TOCTOU recheck, idempotency, approvals, receipts. An audit-attempt failure denies the action. WritePorts are reachable only from actions |
| 007 | **Data-driven semantics registry** (era × queue type × settle action), tied to **independently recorded lab evidence** with three-way assertions and nightly mutation testing. A missing cell falls back to conservative rules |
| 008 | Peek: HTTP-only preflight → pure planner → sequential `basic.get` on a peek lease (AMQP 1.0: credit 1 + drain) → copy → guard → stop at the first doomed message → mandatory disposition → `nack(requeue)` + `basic.qos` barrier → lazy close. Watchdog and write-ahead hold journal |
| 009 | Five role-typed connections (control, peek, source, publish, observe). ack/nack need **nominal settlement proofs** (amended §5) |
| 010 | DLQ replay: pure planner (queue-first destinations, header strip and stamp), isolated source lease, confirm-then-ack, park-by-confirm for finite-L QQ sources, at-least-once journal |
| 011 | Taps: pure TapPlanner; exclusive classic tap queue with drop-head and max-length; bindings copied *with arguments*; diverting exchange types refused; firehose under durable leases; Khepri churn budget |
| 012 | Protocol adapters behind ports. Contract suite runs against amqplib *and* @cloudamqp/amqp-client. coders51 client used only as a differential oracle |
| 013 | Kysely over node:sqlite (in-repo dialect, WAL, FTS5) and Postgres; one migration set; team DDL/DML role split |
| 014 | AES-256-GCM field encryption for secrets, captures, plans and journals. DEK wrapped per mode: container file KEK or passphrase (M0/M1), safeStorage/keyring (desktop), Vault Transit/KMS (team). Audit anchors kept outside the DB |
| 015 | One durable in-house job runner (async generators, AbortSignal, checkpoints, token bucket; SKIP LOCKED on Postgres) |
| 016 | Single-user container mode is the first deliverable: an explicit DC-36 bind exception (amended A-12). Token mandatory, published only on `127.0.0.1`, remote use via SSH tunnel |
| 017 | Local IPC (UDS / named pipe) with mutual HMAC; scoped, expiring, read-only-by-default capability tokens (from M4) |
| 018 | Team v1: single replica, Recreate strategy, guard-only leader. HA via shard leases later (M8) |
| 019 | Team identity: OIDC BFF (openid-client), deny-by-default RBAC with split permissions, four-eyes approval, per-connection broker credential mode (delegated OAuth, then Vault dynamic, then LDAP, then service account) |
| 020 | Blast-radius controls: emergency revoke of all leases on a broker; maintenance freeze |
| 021 | UI: zoneless, OnPush, signals + SignalStore; Spartan + Aria + CDK + Tailwind 4; AG Grid Community behind an adapter; Cytoscape + unmodified ELK worker; own Monaco ESM wrapper; uPlot + ECharts; tinykeys registry (drives native menus from M2); innerHTML banned |
| 022 | Plugin SDK with 3 trust tiers: first-party worker pool / declarative manifests / QuickJS-WASM sandbox (off by default; allow-list in team mode) |
| 023 | In-house, tools-only MCP generated from actions: stdio shim locally, `/mcp` as its own OAuth resource in team mode. Peeks count as mutations; mutating tools are plan-only |
| 024 | Prometheus-first, demand-driven metrics behind a BrokerScheduler (≤1 background management request per broker, AIMD backoff); raw + 5m/1h rollups |
| 025 | Conformance-first testing: broker-lab images exposing 5552 and 15692; 5 versions on every PR; failure-path cells; chaos runs asserting counter deltas; mutation testing |
| 026 | Signed, telemetry-free releases; one product version via release-please; opt-in update checks |
| 027 | Supply chain: pnpm 12 exact catalogs, `minimumReleaseAge` 3 d with a reviewed exclusion log, no-downgrade, `blockExoticSubdeps`, dependency allow-list for agents, security lane |
| 028 | **Rewritten per amendment A-1 (§5):** the doom guard applies DC-09 literally; unverifiable counters are treated as doomed. The rejected "counter-trust" variant is kept in the ADR's history |
| 029 | Product name and brand (**Proposed**; must be Accepted before Web 1.0). Candidates: Sortyard, Kewbench, Relaybay |
| 030 | Web-first delivery order: Docker web app (single user) → Windows → Linux → macOS → team server |
| 031 | Fully open source: Apache-2.0, DCO, no paid tiers, team features free |
| 032 | TypeScript end to end with Angular (not React) |
| 033 | GitHub as system of record: milestones, issue-first work, Project board, docs-as-code |
| 034 | Docs policy: banned-terms list for a specific third-party product, enforced in CI. The ADR itself does not name the product |

### 4.2 Pinned stack

| Layer | Pins |
| --- | --- |
| Runtime | Node **24.22.x** (CI also 26.12), ESM only; engines `>=24.15` |
| Engine | fastify 5.12.7, zod 4.6.7, ws 8.22, pino 10.4, piscina 5.3, undici (built-in) |
| Broker I/O | amqplib 2.2.0; rhea 3.0.5 + own AMQP 1.0 adapter; rabbitmq-stream-js-client 1.1.0 (optional); own management client and Prometheus parser |
| Data | kysely 0.29.6; node:sqlite (better-sqlite3 13 fallback); pg 8.23.1 / Postgres 17 |
| Identity / MCP | openid-client 6.8.8; @napi-rs/keyring 2.1 (desktop); in-house MCP (@modelcontextprotocol/sdk 1.32.1 only as a test oracle); quickjs-emscripten 0.32 |
| UI | Angular 22.2.3, @ngrx/signals 22, Spartan 1.7, Tailwind 4, AG Grid Community 36.2 (Enterprise banned), cytoscape 3.34.4, elkjs 0.12 (EPL, separate asset), @dagrejs/dagre 3, @foblex/flow 19, monaco-editor 0.57, uPlot 1.6.32, echarts 6.1 + ngx-echarts 22, Transloco 8.4, @lucide/angular, tinykeys 4, dompurify 3.4 |
| Container (M0) | node:24-trixie-slim build → distroless nodejs24-debian13:nonroot; multi-arch amd64/arm64; cosign keyless; SBOM |
| Desktop (M2+) | Electron 45.0.x (track latest stable); electron-builder 26.17.0; electron-updater 6.8.10 |
| Tooling | Nx 23.3 (no @nx/nest), pnpm 12.14, **TypeScript 6.0.3** (TS 7 and @types/amqplib banned), ESLint 10 + typescript-eslint + angular-eslint 22, Prettier, Vitest 5, Playwright 1.64, Testcontainers 12.2 (custom broker-lab images), release-please 17, Astro Starlight docs (built without sharp) |
| **Banned** | primeng ≥22 / @primeui/* (proprietary), ag-grid-enterprise, apexcharts, git/tarball dependencies, `rabbitmq-amqp-js-client` on the product path |

### 4.3 Repo layout (abridged; full tree in `docs/architecture/blueprint.md`)
```
AGENTS.md  CLAUDE.md(≤200 lines, @AGENTS.md)  .claude/{rules,skills,settings.json}  CODEOWNERS  LICENSE NOTICE ...
apps/  engine/ (esbuild → dist/engine/main.mjs; modes/{container,local,desktop,team}.ts)  web/ (Angular shell)
       desktop/ (Electron main/preload, electron-builder.{release,test}.yml — created in M2)  cli/ (M4)
       docs/  conformance/  e2e-web/  e2e-desktop/ (M2)  e2e-team/ (M5)  perf/  chaos/
libs/  shared/{contracts, domain-model, semantics(data/*.data.ts), effective-config, routing, peek-planner, tap-planner,
               replay-planner, deaths, topology-code, lint-rules, masking, forecast, live-protocol}      # pure, isomorphic
       engine/{kernel, jobs, live, transport, ports, persistence, adapter-*, net-dialer, net-truststore, secrets,
               plugin-host, decoders, svc-* (connections, identity, capabilities, explorer, peek, messages, tap, dlq,
               streams, topology, admin, ops, metrics, alerts, lint, audit, access, workspace, mcp)}
       ui/{platform, data, design, grid, graph, editor, charts, commands, payload, feature-*}   sdk/{plugin-sdk, header-registry}  testkit/
testing/ broker-lab/ (Dockerfiles 3.13.7…4.3.6 + 4.4 alpha, 3-node + HAProxy + toxiproxy)  lab-evidence/<version>/<CF-id>.json  fixtures/
tools/   generators/  eslint-rules/  arch-tests/  supply-chain/  semantics-evidence/  docs-terms/ (banned terms incl. the docs policy)
packaging/ docker/ (Dockerfile, healthcheck.mjs, compose.quickstart.yaml)  helm/<codename>/ (M5)
.github/workflows/ ci, conformance-pr, conformance-nightly, conformance-record, mutation-nightly, perf, chaos, restore-drill, security-lane, release-image, release-desktop (M2+), codeql, scorecard
```

### 4.4 Message-safety layer
Design constraints DC-01…DC-60 are recorded in `docs/research/design-constraints.md`.

**Era resolution (DC-01/02), conservative**
- Any node < 4.0 → 3.13 rules.
- Any node < 4.3, or flag `rabbitmq_4.3.0` off, or QQ machine version < 8 → 4.0–4.2 rules.
- Unknown or commercial builds → 4.0–4.2 rules.

**Peek**
- **Preflight (HTTP only):**
  - queue type, exclusive/auto-delete;
  - the **real `delivery_limit` stat**;
  - DLX/DLQ topology;
  - delayed retry; length limit + overflow; TTL;
  - single active consumer (SAC) and active consumers;
  - quorum health; size.
- **Gates and caps:**
  - 4.0–4.2 QQ: explicit W-BUDGET consent, caps 20 / max 50.
  - 4.3 QQ DLQ at risk: W-OVERLIMIT blocks by default, with a one-click policy fix.
  - Settle only with `nack(requeue=true)` or AMQP 1.0 `released`.
  - Never return messages by closing a channel.
  - 5 s target / 30 s hard abort.
  - Watchdog; nack flush on shutdown (SIGTERM in the container), and on quit and suspend in desktop.

**Taps:** exclusive classic queue with explicit name, drop-head, small max-length, TTL and expiry; binding arguments copied; policy matches simulated; alarms checked; badges for blind spots and masking; firehose admin-only under a lease.

**DLQ replay:** dedicated confirm channel + mandatory flag; ack the source only after the confirm; strip x-death/x-*-death-*/x-delivery-count/x-acquired-count/stale expiration/mismatched user_id; preserve logical IDs; stamp provenance; token bucket + canary + journal; pause on re-failure.

**Honest receipts:** every peek, tap and replay emits a receipt (era, method, counter deltas, positions, hold time) that goes to the audit log and MCP.

### 4.5 Security per mode (in delivery order)
**Docker web app (M0/M1, single user)**
- Engine binds `0.0.0.0:8765` *inside* the container. Docs and Compose publish only `-p 127.0.0.1:8765:8765`; never `0.0.0.0` or `--network host`.
- Token is mandatory and carried in the URL fragment; Host/Origin allow-lists; JSON-only bodies, no GET mutations.
- A non-loopback `PUBLIC_ORIGIN` is refused unless real auth and https are configured (A-12). Remote use goes through an SSH tunnel.
- Image: non-root distroless, read-only rootfs, healthcheck.
- Secrets: field-encrypted. The DEK is wrapped by a KEK from a Docker secret or file, or by a passphrase entered in the UI. The data volume is documented as sensitive.

**Desktop (M2–M4)**
- No TCP listener; MessagePort only.
- Fuses: RunAsNode / NodeOptions / NodeCliInspect off, ASAR integrity on.
- Sandbox + contextIsolation, strict CSP + Trusted Types, navigation guards.
- `safeStorage` async (master password on Linux basic_text).
- CAs configured in code; system-browser OAuth (RFC 8252 PKCE).
- Spellchecker disabled (no Google CDN calls).

**Team server (M5)**
- OIDC BFF (`__Host-` cookie + CSRF); deny-by-default RBAC stricter than the broker.
- Append-only hash-chained audit with external anchors; four-eyes approvals; masking.
- SSRF egress allow-list through one Dialer; envelope encryption (KMS / Vault Transit).
- `/mcp` has its own OAuth audience, no token passthrough, and opaque connection IDs only.

### 4.6 Data, metrics, team server
**Entities:** profiles, credential refs, BrokerProfile cache, views, collections/templates, encrypted captures + FTS, jobs/journal, receipts, audit, metric series, alerts, users/roles/approvals (team).

**Container persistence:** SQLite on the `/data` volume. Back up and migrate on start; refuse a newer schema; export-everything is available.

**Metrics**
- Prometheus scraped per node (never through a load balancer); `queue=` filter only on 4.3+; Amazon MQ ports 16001–16003 at ≥60 s.
- Management-API sampling as fallback; forecasts are pure functions.

**Team server (M5):** one shared poller per broker, filtered by RBAC; per-user delegated pools; durable jobs; single replica on Postgres for v1.

### 4.7 Distribution (in delivery order)

| Milestone | Channel | Details |
| --- | --- | --- |
| **M0/M1** | **Docker** | GHCR multi-arch images (amd64 + arm64), cosign keyless, SBOM, private until ADR-029. Compose quickstart. Optional Docker Hub mirror. Docs cover Docker Desktop on Windows and macOS (`host.docker.internal`) and Linux (`--add-host=host.docker.internal:host-gateway`) |
| **M2** | **Windows** | Microsoft Store MSIX (free; no SmartScreen warnings). NSIS signed via Certum OSS or SignPath once reputable: two-pass signing, then regenerate `latest.yml` and the blockmap. winget. Optional npm `npx` local-web channel |
| **M3** | **Linux** | deb/rpm with AppArmor profile, AppImage with a caveat, signed apt/rpm repositories |
| **M4** | **macOS** | Developer ID + notarisation ($99/yr starts here), DMG + zip, own Homebrew tap |
| **M5** | Team server | OCI Helm chart + Compose |
| **M6** | Linux stores | Flathub and Snap |

### 4.8 Testing and conformance
- **Unit:** Vitest.
- **Contract/golden:** management and Prometheus responses per broker version.
- **Public conformance suite:** Testcontainers on Linux against 3.13.7, 4.0.9, 4.1.8, 4.2.9 and 4.3.6, plus nightly alphas, across Node 24 / 26 (Electron's Node from M2).
  - Covers every settle path, DOWN path, DLX carry-over, delayed retry, tap mode and hazard.
  - Each cell is a three-way match: live run vs recorded evidence vs registry.
- **Executor model-based tests** with fast-check.
- **Chaos:** toxiproxy and leader transfers, asserting counter deltas.
- **Mutation testing**, nightly.
- **E2E:**
  - Playwright against the **built container image** (M0/M1, cross-browser);
  - Electron E2E per OS from M2 (separate test-fused binary);
  - team suite with Keycloak (M5).
- **Deny-all egress E2E** (container from M0; desktop from M2).
- **Perf fakes:** 100k queues, 400k Prometheus series.
- **Accessibility:** axe.

---

## 5. Binding amendments from the final critique
The critique found 1 blocker, 24 majors and ~20 minors. Step 0 applies these to the docs; they **override** the blueprint and plan text. Each is tagged with the milestone where it becomes active under the web-first order.

**A-1 (blocker, M1) Doom guard.** Replace ADR-028 "counter trust":
- A message is doomed exactly when the era rule holds on the observed header, whatever its provenance:
  - 4.3+: `x-delivery-count > L`;
  - 4.0–4.2: `x-delivery-count ≥ L`;
  - 3.13 with a limit: `≥ L`.
- When counters can't be verified, treat the message as doomed. The pre-chosen disposition then applies; the default is quarantine.
- **No prompts while deliveries are held.**
- AI and unattended plans are rejected unless a quarantine or raise-limit disposition passed rescue preflight within the last 60 s.
- Add conformance cells:
  - carried-over message whose source queue was deleted;
  - source policy invisible to the principal;
  - client-copied header (ends quarantined, not lost).
- Add the nightly mutant "unverified counter treated as not doomed".

**Safety-critical majors**
- **A-2 (M1) DLX-source analysis.** `dlxSources` gets `complete` and `unknownReasons[]`.
  - Incomplete or unknown → finite-unknown L: humans must consent; AI and unattended runs are blocked.
  - Any queue holding broker x-death entries counts as a DLX target.
  - Unknown L → guard uses min(20, any visible value), labelled "estimated"; raise-limit is unavailable.
- **A-3 (M1) HTTP /get fallback.** Never offered for QQs with finite or unknown L on 3.13 or 4.0–4.2, nor on 4.3 queues failing the DLX check. Allowed only for classic, unlimited and provably non-DLX 4.3+ QQs. One planner test per era.
- **A-4 (M1) Policy-writing fixes.**
  - Clone the currently winning policy, add `delivery-limit`, and apply it at a higher priority with an anchored pattern (or edit in place if the user owns it).
  - Show a before/after preview.
  - Refuse when an operator policy or argument caps the limit; verify through the `delivery_limit` stat.
  - Never touch `nsb.*` or provider-owned policies.
- **A-5 (M1) QuarantineQueueSpec.** Durable classic queue, `x-overflow=reject-publish`, never drop-head, no max-length argument. Preflight checks headroom against matching policies. A full quarantine means rescue-failed and the receipt says so. Add a "quarantine full" cell.
- **A-6 (M1) Replay failure semantics.** For CQ and unlimited-QQ sources: `nack(requeue)` + qos barrier, so the message stays in the DLQ. For finite-L QQ sources: park by confirm-then-ack, disclosed in the plan and receipt. Propagate this to DLQ-03, MSG-12, ADR-010 and the replay WPs.
- **A-7 (M3) Replay exit criterion.** 0 lost; every duplicate detectable via replay-id + seq and marked uncertain-duplicate; duplicate rate bounded per chaos profile.
- **A-8 (M4) Firehose.**
  - Traces get a small `max_payload_bytes` and the narrowest pattern; check disk headroom first and watch for alarms.
  - At lease end, *delete* the trace and verify per node.
  - Short-lived hosts need an "app must stay running" acknowledgement.
  - Lint rule: tracing on without an active lease.
- **A-9 (M0) Nominal settlement proofs.** Use unique-symbol or private-constructor brands, minted only in PublishLease and the planner, with a runtime WeakSet check. Add an architecture test banning forged literals and a type test proving a forgery fails to compile.

**Security and privacy majors**
- **A-10 (M0) Connection budget.** Per-broker cap on the tool's own connections (2–3 on "tight" provider presets). Lazy role connections with idle close. "Tool uses X of Y connections" on the capability card.
- **A-11 (M0/M4) Authz per principal.** Allow-all only for the UI principal in single-user modes. CLI and MCP principals (M4) are limited to their token scope and DC-42. A read-only token calling purge gets FORBIDDEN.
- **A-12 (M0) Container PUBLIC_ORIGIN.** A non-loopback origin requires real auth (OIDC or a hashed password) **and** https; otherwise the engine refuses to start. Web 1.0 documents SSH-tunnel access instead.
- **A-13 (M2) Electron spellchecker.** `spellcheck:false`, or bundled dictionaries. The deny-all egress E2E types into inputs on Windows and Linux. `/security/outbound-calls` lists every audited network feature.
- **A-14 (M5) Remote team workspaces from desktop.** The local engine acts as an RFC 8252 public client: team tokens stay in the vault, and the engine proxies over MessagePort with Bearer auth. No CORS and no CSP relaxation.

**Packaging and data majors**
- **A-15 (M2) MSIX virtualisation.** Write IPC discovery outside AppData (`~/.<codename>/run`, user-only ACL) or ship the CLI as an AppExecutionAlias. Define NSIS↔Store data migration. Add a Windows CI test for CLI→Store-engine (when the CLI lands in M4).
- **A-16 (M2) Data-directory ownership.**
  - Only the Electron app owns the desktop data directory; the CLI and MCP attach through `engine.json`; "start on demand" launches the app headless.
  - The container and npx use separate data directories.
  - Profiles move between modes by bundle export/import (container → desktop migration documented).
- **A-17 (M5) Audit partitions.** A Helm CronJob under the DDL role (or pg_partman) pre-creates monthly partitions 3 months ahead, plus a DEFAULT partition. Alert when the horizon is under 30 days. Test across a month boundary.
- **A-18 (M1+) Upgrade, downgrade and migration flows.** Expand/contract migrations; no helm rollback across schema versions; "export everything"; versioned export formats with migrators; appId and userData fixed independently of the display name; channel-switch tests; a published support/LTS policy.

**Execution-model majors**
- **A-19 (M0) Licence gate split.** A shipped-artefact gate (esbuild metafile, Angular stats; electron-builder file list from M2) enforces DC-50 exactly. A dev/build lockfile gate uses a broader permissive list plus a hard deny list.
- **A-20 (M0) Lab evidence is recorded only by CI.** The `conformance-record.yml` workflow runs on digest-pinned images, stamps SHA + digest + run URL, and opens a bot PR labelled `lab-evidence` for human approval. Agents never write evidence.
- **A-21 (M0) Agent identity.** A GitHub App or machine user for agent commits and PRs, with signed commits; the human adds DCO sign-off on approval. CODEOWNERS map to named people. Trust-critical work in progress capped at 2. Dates re-baselined on measured review throughput.
- **A-22 (M0) Naming gate.** Everything stays private until ADR-029 merges: private repo and GHCR, no npm, alphas as private images or Actions artefacts. ADR-029 must merge before Web 1.0. appId, data paths and env prefix use a permanent internal codename.
- **A-23 (M0) RabbitMQ 4.4.** A standing "new broker release" runbook (14-day SLA), plus an immediate work package:
  - era-4.4 cells from the v4.4.x source;
  - 4.4 in the broker lab;
  - a `resolveEra` rule on flag `rabbitmq_4.4.0` + machine version ≥ 9;
  - promotion to Tier 1 at GA.
- **A-24 (M2) Cross-OS test infrastructure.** Windows (M2), Linux desktop (M3) and macOS (M4) jobs reach a broker lab on an ephemeral VM or a self-hosted Linux runner over WireGuard/SSH, or use a local brew/choco RabbitMQ with sshd. State the runner for every cross-OS acceptance criterion. M0/M1 need Linux runners only.
- **A-25 (M0) Platform upgrade lane (~10% of capacity).**
  - Electron within 4 weeks of each major (from M2).
  - Angular 23 and TypeScript within one month of GA.
  - Node 26 for container and team images well before Node 24 EOL (2028-04-30).
  - Nx 24 and fastify 6 as they land.
  - Conformance and egress E2E rerun on every bump.

**Minor fixes** (one editorial pass in Step 0)
- **Wording and i18n:**
  - Scope honest-wording lint to message contexts and lint the docs; make receipt labels conditional on the outcome.
  - Safety-critical i18n keys fall back to English when stale, with per-locale maintainer review.
- **Dependency graph:**
  - Fix the graph defects: TAP-04→ADM-16; the TEAM-01↔PLAT-11 cycle; DLQ-08→POL-03; EXP-05→team; M4-07→M4-04; M4-03→M4-01; M0-59→M0-49/51.
  - Add a CI graph validator.
- **Consistency edits:**
  - Pick one CLAUDE.md limit (≤200 lines).
  - Use a 15-minute prod arming window with explicit re-arm.
  - Use ADR-027-log everywhere.
  - Define "green" as a three-way match; 4.0.9 is non-blocking.
- **Tap safety:** neutralise a matching DLX policy on tap queues with an explicit unbound DLX argument; evaluate PCRE-compatible patterns, failing closed; configurable tap and quarantine prefixes.
- **Routing simulator:** the verification probe is a planned mutation behind the prod lock.
- **Desktop and OS integration:**
  - Coined `<codename>://` deep-link scheme (desktop), navigation-only allow-list; never register `app`.
  - Accessibility: warn ≥20 s before plan expiry with one-key extend; manual NVDA/VoiceOver pass per release; external WCAG audit before 1.0.
  - Shutdown/suspend drain acceptance criteria made RTT-aware, with honest W-CRASH disclosure.
  - `publisherName` lists both certificate subjects during the Windows signing transition; `signtool verify` and WACK added to the release gates.
- **npx/CLI (when shipped):** Node-version check at startup; keyring as an optionalDependency; MCP shim takes `--token-file`, never argv/env.
- **Team and API:**
  - Delegated mode defaults to per-user visibility.
  - Entra Graph added to the egress preset.
  - Journal bodies kept for 7 days in team mode.
  - Add vhost to lease APIs; type `executorWrite`.
- **Protocols:** record the DC-03/DC-26 reconciliation for the opt-in AMQP 1.0 peek (never for DLQ reads).
- **Work-package hygiene:**
  - Split oversized WPs (old M0-10/24/45/51, M1-26/49).
  - Follow `gh workflow run` with `gh run watch --exit-status`.
  - Fund provider test brokers via OSS credits or IaC-ephemeral brokers.
- **Supply chain:** set `minimumReleaseAgeIgnoreMissingTime: false`.

**Added scope (missing items)**

| Item | Lands in |
| --- | --- |
| Semantic-correctness advisory channel (GitHub advisories, RSS, opt-in in-app check) | M1 |
| Support/LTS policy | M1 |
| Corporate proxy support (`HTTPS_PROXY` for the container; system/PAC/WPAD and NTLM/Kerberos on desktop) | M1 / M2 |
| Translation platform (Weblate libre) | M1 |
| Pre-1.0 security review (payload-viewer XSS fuzz corpus, threat-model refresh; Electron checklist in M2) | M1 |
| Lifecycle view and cleanup for tool-created broker artefacts (quarantine/parked queues, traces, taps) | M1 |
| Usability-test protocol behind the time-to-first-peek gate | M1 |
| Codespaces/devcontainer forwarding within DC-36 | M1 |
| Signed apt/rpm repositories or updater for deb/rpm | M3 |
| Air-gapped install kit (image/chart mirroring, offline cosign bundles, offline docs) | M5 |
| Team privacy (actor pseudonymisation / crypto-shredding, retention per data class, data-flow doc) | M5 |
| Team-server scale targets + load test | M5 |

---

## 6. Execution plan (AI-agent built)

### 6.1 Step 0, right after approval (me, in this session): document everything and set up GitHub

> **This session's scope (user instruction):** Step 0 only.
> - Write the docs.
> - **Commit and push directly to `main`.**
> - **Create the GitHub milestones, labels and issues** (plus the Project board if the `project` scope is granted).
>
> **No product code.** Implementation (M0-W0 onwards) continues in a later session.
>
> **Tooling:** Node 24.19 is available. Issues come from `tools/github/seed.mjs`. ripgrep is not installed, so the policy gate uses `git grep -i -E`.

**0.1 Lock visibility first.**
- `gh repo edit RafaelJCamara/AnotherRabbitMqManagementPortal --visibility private --accept-visibility-change-consequences`
- Verify with `gh repo view --json visibility` → `PRIVATE`.
- Nothing is pushed while the repo is public.

**0.2 Write all documentation** (docs-as-code, Markdown, in the repo).

Source: the workflow outputs. Apply amendments A-1…A-25, the minor fixes, the web-first re-sequencing (§3) and the docs policy.

| Path | Content |
| --- | --- |
| `docs/plan/` | **`plan.md` (this plan, verbatim)**, `execution-plan.md`, `amendments.md` (A-1…A-25 with status), `release-checklists.md`, `work-items.yaml` (seed manifest), `work-items.md` (index generated from GitHub issues) |
| `docs/research/` | fact-sheet, design-constraints (DC-01…60), uncertainties (U-01…26), competitors-2026, semantics-matrix, tap-streams-ops, managed-brokers, auth-network-security, framework-failure-formats, stack-verification, sources |
| `docs/product/` | product, features (147, re-tagged to M0–M8), milestones, m1-checklist, UX/IA |
| `docs/architecture/` | blueprint, core-interfaces.ts.md, threat-model, repo-layout |
| `docs/adr/` | `README.md` (index + MADR template), **ADR-001…034** (ADR-029 Proposed, the rest Accepted) |
| `docs/runbooks/` | new-broker-release (14-day SLA), platform-upgrade lane, security lane, KEK escrow/rotation, backup/restore, emergency revoke/freeze |
| Root | `README.md` (attribution + non-affiliation), LICENSE (Apache-2.0), NOTICE, CONTRIBUTING (issue-first workflow, DCO, AI policy), CODE_OF_CONDUCT, SECURITY, GOVERNANCE, TRADEMARKS |

**0.3 Docs policy**
- Research reports about that product are **not persisted**.
- Every other document gets a scrub pass: competitor rows, name, domain, vendor, pricing, history and URLs, including in `sources` and issue bodies. Parity texts become "M1 developer checklist".
- Gate: a banned-terms scan of `docs`, `.github`, root Markdown and UI i18n strings must report **no matches**. The scan becomes a CI check in M0-04; until then it is run manually before each docs commit.
- Documents whose text was changed by amendments carry a banner: "Amended: `docs/plan/amendments.md` takes precedence".

**0.4 GitHub templates (committed)**
- `.github/ISSUE_TEMPLATE/` issue forms:
  - `work-package.yml`: goal; feature/DC/ADR refs; files & interfaces; out of scope; Given/When/Then ACs; verification commands; depends-on; size; wave; lane; trust-critical.
  - `epic.yml`, `spike.yml`, `lab-cell.yml`, `adr.yml`, `bug.yml`, `docs.yml`, and `config.yml` (blank issues off).
- `PULL_REQUEST_TEMPLATE.md`: `Closes #`, DoD checklist, verification output, docs/ADR updated.

**0.5 Seed GitHub from the manifest** with `tools/github/seed.mjs` (Node, via `gh`).
- **Idempotent:** keyed by a hidden `<!-- wi:ID -->` marker in each issue body; throttled ~1 write every 2 s to respect secondary rate limits; `--dry-run` first.
- **Labels:**
  - `type:{work-package, epic, spike, lab-cell, adr, bug, docs, chore, security, human}`
  - `area:{engine, ui, container, desktop-win, desktop-linux, desktop-mac, semantics, conformance, adapters, peek, tap, streams, dlq, topology, admin, metrics, team, ai, ci, release, docs}`
  - `lane:{platform, feature, evidence}`, `size:{S, M, L}`, `wave:M0-W0…`, `trust:critical`, `status:blocked`
- **Milestones:** M0…M8. Each description holds the goal, exit criteria, deliverable and a link to `docs/product/milestones.md`. Target months are tentative and re-baselined after M0-W1 (A-21).
- **Issues:**

| Group | Approx. count | Notes |
| --- | --- | --- |
| M0 work packages | ~67 | full specs in the body, amendments applied |
| M1 work packages | ~70 | full specs in the body, amendments applied |
| M2–M8 epics | ~52 | scope + exit criteria + planned WPs as sub-issues or a checklist; broken into WP issues when the milestone opens |
| ADR-029 naming issue | 1 | milestone M1, blocks the Web 1.0 release |
| **human** prerequisite issues | — | assigned to @RafaelJCamara: codename, agent identity, provider brokers, Docker Desktop, signing accounts, Apple account, self-hosted runner, brand clearance |
| Lab/spike issues for U-01…U-26 | — | linked to the WPs they gate |

  - Total **≈ 200 issues**.
  - IDs are re-issued per new milestone (e.g. `M2-P03 Desktop main`), with a `formerly M0-55` field so the design docs stay traceable.
- **Relationships:**
  - native **sub-issues** link epic → WPs;
  - native **blocked-by** dependencies come from `depends_on`. Fallback: a "Depends on" list in the body plus `status:blocked`, maintained by a small workflow.
- **GitHub Project (v2), private, user-owned:** "`<codename>` Roadmap" with every issue.
  - Fields: Status (Todo / In progress / In review / Blocked / Done), Milestone, Wave, Lane, Area, Size, Trust-critical.
  - Views: Board by Status; Table by Wave; Roadmap by Milestone.
  - Built-in workflows: item added → Todo; PR linked → In review; closed → Done.
  - Needs the `project` token scope (§6.2).

**0.6 Save memory**
- Durable preferences: Angular over React, TypeScript, fully OSS, agent-built, web-first order, GitHub as system of record (issue-first).

**0.7 First commit and push** to `origin/main` (private): docs, `.github` templates, the seed script and manifest, LICENSE/NOTICE/README. No product code yet. `docs/plan/work-items.md` is regenerated from GitHub after seeding (issue numbers filled in).

### 6.2 Human prerequisites (staged by milestone)

| When | What |
| --- | --- |
| **Before Step 0.5** | Run `! gh auth refresh -h github.com -s project` (the current token lacks the `project` scope that GitHub Projects needs). Without it, Step 0 seeds labels, milestones and issues, and the Project board is created afterwards |
| **Day 1 (M0)** | Pick a permanent internal **codename** (lowercase, no "rabbit"/"rmq"). Agent identity: a GitHub App or machine user (A-21); branch protection, merge queue, private vulnerability reporting. **Docker Desktop (WSL2 backend)** on the dev machine for broker-lab and Testcontainers. **Self-hosted Linux Actions runner** (WSL2/Docker on the dev machine or a small VM) for conformance and lab jobs while the repo is private. Provider test brokers: Amazon MQ 3.13/4.2/4.3 and CloudAMQP shared/dedicated (ask for OSS credits) |
| **During M0/M1** | Start brand clearance (USPTO/EUIPO/WIPO, email the RabbitMQ core team); ADR-029 must merge before the Web 1.0 public release. Keycloak 26 and Entra test tenants (broker OAuth, M1) |
| **During M1** (lead time for M2) | Microsoft Partner Center (free) and a Certum OSS certificate. Record the maintainer's legal identity and country (Azure Artifact Signing is open to individuals only in the US/Canada) |
| **After the first public release** | Apply to SignPath |
| **Before M4** | Apple Developer Program ($99/yr) |

### 6.3 Bootstrap order (each step is one squash-merged PR)
1. Repo hygiene on top of the Step 0 commit (LICENSE, NOTICE, README and governance docs already exist): `.gitattributes` with LF, `.editorconfig`, `.nvmrc` 24.22.0.
2. `create-nx-workspace@23.3.0` (apps preset, pnpm, no Nx Cloud): `packageManager pnpm@12.14.0`, exact catalogs, `@app/*` aliases, no @nx/nest.
3. TS 6.0.3 strict pin, plus a toolchain proof (Angular app with esbuild + Vitest, esbuild engine app, run-many build/test on Windows, macOS and Linux dev machines).
4. ESLint 10 flat config, Prettier, module boundaries (type/runtime/trust tags), third-party confinement, custom rules, docs banned-terms check.
5. Supply chain and licence gates, split per A-19, with `gates-selftest`.
6. CI: affected lint/typecheck/test/build, CodeQL, Scorecard, Conventional Commits, DCO, dependency review, zizmor; actions pinned by SHA; Renovate.
7. release-please (single product version, alpha prerelease).
8. Starlight docs (private until ADR-029).
9. Governance files (CONTRIBUTING with the AI-contribution policy, CoC, SECURITY, GOVERNANCE, TRADEMARKS, CODEOWNERS).
10. Agent toolchain and generators, then contracts. **From here on, all code arrives through work packages.**

### 6.4 Agent workflow conventions
- **Issue-first (GitHub is the system of record):**
  - No work without an issue. Agents read the spec with `gh issue view <n>` and work on a branch `wi/<ID>-<slug>`.
  - PRs must contain `Closes #<n>`; the CI check `pr-links-issue` enforces it. Commits reference the issue.
  - Issue status moves automatically on the Project board.
  - New work discovered mid-task becomes a **new issue**, never silent scope creep.
- **Docs and ADRs:**
  - Every behaviour change updates `docs/` in the same PR (DoD).
  - Every new or changed decision goes through an `type:adr` issue, then a PR adding or updating `docs/adr/ADR-NNN-*.md` (MADR: status, context, decision, consequences, alternatives, links). Merged means Accepted. Superseded ADRs stay, with links both ways.
  - `docs/adr/README.md` and `docs/plan/work-items.md` are regenerated by a script and checked in CI.
- **Milestone hygiene:**
  - When a milestone opens, its epics are broken down into WP issues (a skill does this from the epic body).
  - A milestone closes only when its exit-criteria checklist is ticked and its release checklist issue is closed.
- **Instruction files:**
  - `AGENTS.md` is canonical: invariants I-1…I-14, generators, verify commands, WP rules, the single gating rule, the docs policy. The policy points to the banned-terms list in `tools/docs-terms` and never repeats the terms, so it passes its own check.
  - `CLAUDE.md` imports it (≤200 lines).
  - Path-scoped `.claude/rules/{engine,ui,desktop,semantics,security}.md`.
- **Hooks:** format and lint after edits; affected typecheck and tests on stop; a guard blocking writes to `testing/lab-evidence/**` and to banned dependencies.
- **Skills and Nx generators:** action, topic, job, service module, adapter, UI feature, lint rule, decoder, semantics cell, migration, conformance cell.
- **One spec per WP** (`docs/specs/_TEMPLATE.md`): goal and ids; files and interfaces; out of scope; ACs as Given/When/Then, each mapped to one named test; copy-paste verification commands; DoD.
- **Writer/reviewer split** with fresh-context reviews.
- **CODEOWNERS** (named humans) on auth, secrets, Electron main/preload (M2+), peek executor, semantics data, lab evidence, and release workflows.
- **Worktrees and merging:** one git worktree per parallel WP; merge queue. Platform and feature lanes run in parallel from M2.

### 6.5 Waves and critical path

| Wave | Content |
| --- | --- |
| M0-W0 | Bootstrap and agent toolchain (M0-01…09) |
| M0-W1 | Contracts, registry and data, broker lab and recorder, kernel, live protocol, CSP spike (AG Grid/Monaco/ELK in the browser) |
| M0-W2 | Persistence, secrets (file KEK/passphrase), ports and scheduler, management/AMQP adapters, executor and audit, jobs, transport (HTTP/WS + fake-port transport test), live hub, composition root. **Evidence lane:** harness + lab cells |
| M0-W3 | Connection manager, probe, explorer, UI shell and design system, grid, container mode, web E2E against the image, matrix v0 |
| M0-W4 | Provider runs, container image hardening, image release workflow, privacy/egress |
| M1-W1…W5 | As before (pure libraries → peek core → taps/streams/DLQ/admin → UIs → a11y/i18n/docs/Web 1.0). **Desktop spikes in W4/W5:** MessagePort tunnel, utilityProcess cold start, node:sqlite in Electron, Electron TLS/crypto, Windows packaging/signing |
| M2 | Platform lane: Electron shell → secrets/OAuth/notifications/menus → MSIX/NSIS/updater/E2E. Feature lane: parity I + policy editor |
| M3 | Platform lane: Linux packaging/keyring/E2E/repositories. Feature lane: parity II + DLQ operations centre + plugin SDK/decoders |
| M4 | Platform lane: macOS signing/notarisation/local network/keychain/Homebrew/E2E. Feature lane: advanced messaging, providers/Kubernetes, IPC/CLI/read-only MCP, web utilities |

- **M0 critical path:** 01→03→04→08→10→11→16→21→29→32→33→36→59→64→68 (container release). It is shorter than before because desktop is out of M0.
- **Evidence lane:** 05→14→15→37→38–41→62.
- **Integration points:**
  - IP-1: contract and registry freeze;
  - IP-2: walking skeleton over HTTP and WebSocket;
  - IP-3: UI served by the container image;
  - IP-4: conformance gate on, which **unblocks peek/tap/DLQ work**;
  - IP-5: image release dry run.
- **Capacity:**
  - Web-first M0 ≈ 95 agent-days and M1 ≈ 115.
  - Each desktop milestone's platform lane ≈ 15–30 agent-days, in parallel with its feature lane.
  - **Human review throughput is the real constraint** (A-21).

### 6.6 Work packages (full specs in `docs/plan/work-packages.md`; IDs are from the design plan, moves below)
**M0 web-first (from the 69 original M0 WPs)**

| Wave | Work packages |
| --- | --- |
| W0 | 01 workspace scaffold · 02 supply-chain gates · 03 lint/boundaries · 04 custom ESLint rules + docs banned-terms check · 05 CI · 06 governance, release-please, docs · 07 agent toolchain · 08 base generators · 09 human prerequisites |
| W1 | 10 contracts kit + spec emitters · 11 domain model + registry core · 12/13 semantics data I/II · 14 broker-lab images · 15 lab driver + recorder · 16 kernel · 17 live protocol · 20 CSP spike (browser part) |
| W2 | 21 persistence · 22 secrets/field crypto (file KEK + passphrase wrap) · 23 ports + BrokerScheduler · 24 management-HTTP adapter · 25 golden fixtures · 26 dialer + trust store · 27 AMQP 0-9-1 adapter with role leases/proofs · 28 dual-library contract suite · 29 ActionExecutor · 30 audit, receipts, prod lock · 31 JobRunner/drain · 32 Fastify router/guards · 33 live hub/WebSocket · 35 generators · 36 composition root/bundle · 37 three-way harness · 38–41 lab cells · 42 conformance CI |
| W3 | 43 ConnectionManager budgets · 44 svc-connections · 45/46 capability probe + gates · 47 workspace · 48 explorer engine · 49 ui-platform/data (EngineTransport + PlatformBridge, web impls) · 50 design system · 51 web shell · 52 connections UI · 53 grid adapter · 54 explorer UI · 59 **container mode first-class** (loopback publish, token, `/data` volume, KEK/passphrase, host-broker networking) · 60 E2E against the built image · 62 matrix v0 |
| W4 | 63 provider contract run · 64 container image (multi-arch, distroless, cosign, SBOM, healthcheck) · 68 release workflow (**image + docs only**) · 69 privacy / deny-all egress for the container |

**Moved out of M0:**

| WP | Moves to |
| --- | --- |
| 18 (MessagePort / utilityProcess / node:sqlite-in-Electron spikes), 19 (Electron crypto/TLS + Windows packaging spike) | M1 tail |
| 34 PortSessionServer, 55 desktop main, 56 supervisor/preload/drain, 57 key wrap, 58 fuses, 61 desktop E2E, 67 Windows MSIX/NSIS, desktop parts of 68/69, 74 cross-OS broker lab | M2 Windows |
| Linux part of 66 | M3 |
| macOS part of 66, Homebrew tap | M4 |
| 65 npm/npx package | optional, M2 |

**Amendment WPs (M0):**
- M0-70 codename/private-identifier gate (A-22)
- M0-71 CI evidence recorder (A-20)
- M0-72 agent identity + review SLAs (A-21)
- M0-73 licence-gate split (A-19)
- M0-75 RabbitMQ 4.4 readiness + release runbook (A-23)
- M0-76 platform-lane automation (A-25)
- M0-77 feature/WP graph validator

Also split oversized M0-10, M0-24, M0-45 and M0-51.

**M1 Web 1.0 (59 + amendments).** Same list as designed, adapted to web-only:

| Wave | Work packages |
| --- | --- |
| W1 | 01 effective-config resolver · 02/03 routing simulator I/II · 04 death normaliser · 05/06 labs · 07 AMQP 1.0 rhea adapter · 08 differential oracle + stream labs · 09 capture store/FTS · 10 codecs · 11 Cytoscape WebGL spike (browser; `app://` part → M2) · 41 command palette/keymap (native menus → M2) · 42 deep links/detail tabs |
| W2 | 12 peek planner · 13 preflight + rescue preflight · 14 peek executor · 15 guard + dispositions (**per A-1**) · 16 svc-peek receipts · 17 model-based tests · 18 per-era peek conformance · 19 publish engine · 20 svc-topology · 21 TLS/mTLS · 22 SSH/SOCKS/CONNECT (from inside the container) · 23 credential providers/TokenManager · 24 OAuth discovery + PKCE redirect to the app origin (system-browser desktop flow → M2) · 25 auth lab · 26 metrics engine · 43 error explainer · 45 message viewer/diff |
| W3 | 27/28/29 taps · 30/31 streams (0-9-1, AMQP 1.0) · 32 DLQ inventory + hazard advisor (**A-2/A-4**) · 33/34/35 replay planner/job/conformance (**A-5/A-6**) · 36 queue/exchange admin · 37 alternative peek paths (**A-3**) · 38 chaos + mutation hardening · 39 workspace export/import · 40 extract job · 44 workbench UI · 46 Monaco + publish studio · 49 graph/topology UI · 53 connections UI · 54 live charts/forecast |
| W4 | 47 tap UI · 48 stream UI · 50 routing simulator / effective-config UI · 51 DLQ UI · 52 admin UI · 55 jobs/receipts UI · desktop spikes (old M0-18/19) |
| W5 | 56 accessibility · 57 i18n/theming · 58 docs (Docker quickstart, networking, SSH-tunnel guide) · 59 **Web 1.0 release** (M1 developer checklist, time-to-first-peek, public GHCR after ADR-029, devtools listing) |

**Added M1 WPs:**
- M1-60 pre-1.0 security review (web)
- M1-61 advisories channel
- M1-62 container proxy support
- M1-63 broker-artefact lifecycle
- M1-64 support/LTS and export-format versioning
- M1-65 usability protocol
- M1-66 translation platform

Also split M1-26 and M1-49.

**Desktop and later milestones**

| Milestone | Platform lane | Feature lane |
| --- | --- | --- |
| **M2 Windows** | Moved desktop WPs above + system-browser OAuth, OS notifications, native menus from the command registry, `app://` CSP, A-13/A-15/A-16, Windows x64 + arm64 CI, Electron security checklist review, optional npx channel | Old epics M2-01 (admin I), M2-02 (admin II), M2-04 (policy editor) |
| **M3 Linux** | deb/rpm + AppArmor, AppImage, Secret Service / master password, X11/Wayland, xvfb E2E, signed apt/rpm repositories, arm64 | Old epics M2-03 (admin III), M2-06 (DLQ operations centre), M2-07 (plugin SDK + decoders v1.0) |
| **M4 macOS** | Developer ID + notarisation, DMG/zip, arm64 + x64, Local Network permission, keychain, Homebrew tap, macOS E2E | Old epics M2-05 (advanced taps/streams), M2-08 (publish advanced), M2-09 (providers/Kubernetes), M2-10 (IPC + CLI + read-only MCP), M2-11 (web utilities) |
| **M5 Team server** | Old M3-01…12 (Helm, Compose, team runtime, OIDC, RBAC, catalogue, credentials, audit, approvals, masking, SSRF, remote workspaces per A-14, revoke/freeze, security review) | + privacy and partitions (A-17), scale/load test, air-gap kit |
| **M6 Ops intelligence** | — | Old M4-01…09 (Flathub/Snap included) |
| **M7 AI & MCP** | — | Old M5-01…05 |
| **M8 Platform scale** | — | Old M6-01…09 |

---

## 7. Verification

**Step 0**
- **Visibility:** `gh repo view RafaelJCamara/AnotherRabbitMqManagementPortal --json visibility` → `PRIVATE` *before* the first push.
- **Docs policy:** the grep in §6.1 returns no matches across `docs`, `.github`, root Markdown and issue bodies (`gh issue list --state all --limit 500 --json body` piped through the same pattern).
- **Docs:**
  - `docs/plan/plan.md` exists and matches this plan.
  - ADR-001…034 are present and indexed.
  - Every amendment A-1…A-25 and the re-sequencing are reflected (checklist in `docs/plan/amendments.md`).
  - The feature/WP graph validator passes on the re-tagged milestones.
- **GitHub:**
  - `gh api repos/RafaelJCamara/AnotherRabbitMqManagementPortal/milestones --jq length` = **9**.
  - The issue count equals the manifest count (`node tools/github/seed.mjs --verify`). It checks that every issue:
    - has exactly one milestone;
    - has `type:*`, `area:*`, `lane:*` and `size:*` labels;
    - carries its `wi:` marker;
    - has dependencies matching the manifest.
  - Epics list their sub-issues.
  - `gh project item-list <n> --owner RafaelJCamara --format json` covers every issue.
- **Re-run safety:** running the seed script a second time creates **0** new items.

**Per WP**
- Each spec's Given/When/Then maps to a named test, and its exact commands must pass. Examples:
  - `pnpm nx test engine-svc-peek`
  - `pnpm nx run conformance:matrix --versions=3.13.7,4.1.8,4.2.9,4.3.6`
  - `pnpm nx e2e e2e-web` (against the built image)
  - from M2: `pnpm nx e2e e2e-desktop`
- Workflow-run checks use `gh run watch --exit-status`.
- DoD: tests green, gates green, docs/ADR updated, receipts and honest wording checked, code-owner review on trust-critical paths.

**CI gates on every PR**
- `pr-links-issue`.
- Affected lint, typecheck and unit tests; licence and supply-chain gates; docs banned-terms check; ADR/work-items index freshness; contract diff gate (OpenAPI/AsyncAPI); golden fixtures.
- **Conformance PR matrix:**
  - While the repo is private, PRs run a 2-version smoke (4.2.9 + 4.3.6) on the self-hosted runner, and the full 5-broker matrix runs nightly.
  - Once public after ADR-029, the full matrix runs on every PR on free GitHub-hosted runners.
- Image build + e2e-web smoke/security against the container; transport test over HTTP/WS + fake port.
- axe a11y; bundle budgets.
- Architecture tests: WritePort funnel, proof minting (A-9), no mode branching.
- Feature/WP graph validator.
- **From M2:** Electron smoke per released OS (test-fused build).

**Nightly**
- Node 26 (+ Electron-Node from M2).
- 4.4 and 5.0 alphas (4.4 promoted at GA, per A-23).
- Mutation testing of conformance and the executor.
- Chaos with toxiproxy and leader transfers, asserting DC/AC deltas.
- Perf (100k-queue fake, 10k msg/s tap); restore drill; deny-all egress E2E.

**Lab:** all 26 uncertainties are scheduled as lab cells or spikes before the features that depend on them. Evidence is recorded only by CI, per A-20.

**Release gates by channel**

| Channel | Gates |
| --- | --- |
| **Image (M0/M1)** | multi-arch manifest, cosign verify, SBOM, Trivy scan, non-root/read-only checks, loopback-only publish in Compose, image E2E |
| **Windows (M2)** | `signtool verify /pa`, WACK for MSIX, updater test, manual smoke on Windows 11 x64 and arm64 |
| **Linux (M3)** | package install/upgrade on Ubuntu 24.04 / Fedora / Debian, AppArmor profile active, AppImage smoke |
| **macOS (M4)** | `spctl -a -vv`, `codesign --verify`, notarisation staple, manual smoke on arm64 and x64 |
| **Team (M5)** | Helm chart-testing on kind, restricted PSS |

**End-to-end demo at each milestone**
1. Start the broker-lab compose (3.13.7 … 4.3.6).
2. Start the app:
   - **M1:** `docker run -p 127.0.0.1:8765:8765 -v <codename>-data:/data ghcr.io/<org>/<codename>`, then open the tokenised URL from the logs;
   - **M2–M4:** install the signed desktop package on that OS.
3. Connect, then check the probe card and the era badge.
4. Peek a 4.2.9 quorum queue (W-BUDGET consent, receipt shows +1 AC each).
5. Peek a 4.3.6 quorum DLQ at default L: W-OVERLIMIT blocks it, the one-click policy fix applies, and the peek succeeds.
6. Run a tap with blind-spot badges.
7. Publish with mandatory and confirm, and see the routing result.
8. Group DLQ failures, dry-run the replay, run it with canary + throttle, and confirm the receipt and audit row.

**Web 1.0 acceptance (M1):**
- M1 developer checklist 100%;
- usability sessions measuring time-to-first-peek under 3 minutes from `docker run` on Windows, macOS and Linux hosts;
- correctness claims re-checked against the conformance matrix before any public comparative messaging.

---

## 8. Open decisions and risks
- **Product name** (deferred): needed before any public artefact, at the latest before the **Web 1.0** release (ADR-029 gates public GHCR, the devtools listing and the public docs). Candidates checked: Sortyard (recommended), Kewbench, Relaybay. Everything stays private until then (A-22).
- **Desktop deferral risk:** desktop-specific issues surface later (MessagePort tunnel, keychains, Electron CSP with Monaco/ELK, signing). Mitigations:
  - the transport and PlatformBridge abstractions plus a fake-port transport test from M0;
  - desktop spikes at the M1 tail;
  - Windows signing accounts opened during M1.
- **Private-repo constraints (until ADR-029):**
  - GitHub Free gives 2,000 Actions minutes a month; Windows runners cost 2× and macOS 10×. Mitigations: a self-hosted Linux runner for conformance and lab work, affected-only PR CI, nightly full matrices.
  - GitHub Pages is unavailable on Free private repos, so docs are read in-repo until public.
  - SignPath requires public, GitHub-hosted builds, so it applies only after going public.
  - Once the name is cleared: rename the repo (redirects keep issues, milestones and the project intact), flip it public, and enable Pages.
- **Seeding volume:** ~200 issues risk GitHub secondary rate limits. Mitigated by the throttled, idempotent, resumable seed script with `--dry-run` and `--verify`.
- **Single-user container caveat:** remote use goes through SSH tunnels until the M5 team server. The data volume holds encrypted secrets, so the passphrase mode is recommended.
- **Maintainer legal identity and country:** decides the Windows signing route. **Cost is $0 until M4** (Apple $99/yr), apart from provider test brokers (seek OSS credits).
- **Review bottleneck:** about 40% of M0/M1 work packages are trust-critical and need human review. Timelines are re-baselined on measured throughput.
- **RabbitMQ 4.4 GA during M0** (A-23). Platform churn: Electron every 8 weeks (from M2), Angular 23 in about June 2027, Node 24 EOL in April 2028 (A-25).
- **Semantics** are code-derived, not yet lab-tested. Peek, tap and DLQ ship only after the conformance gate (IP-4). Unverified broker builds use conservative 4.0–4.2 rules.
- **JS ecosystem immaturity:** the official AMQP 1.0 client is unfit, so we keep our own rhea adapter; amqplib's bus factor is high. Mitigated by ports, a dual-library contract suite, upstream PRs and a differential oracle.
- **Competitive threats:** the official next-gen UI ("later"); AI-paced solo vendors (Warren, QueueLens); HZN's web edition (Q4 2026). The free OSS team server after macOS remains the key differentiator.
- **Optional:** a hands-on, outside-in evaluation of competing tools (no reverse engineering) before any public comparative positioning.
