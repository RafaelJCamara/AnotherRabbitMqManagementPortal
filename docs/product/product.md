> **Design-phase output (2026-10-16).** Amended by [`docs/plan/amendments.md`](../plan/amendments.md), which takes precedence, and re-sequenced web-first ([ADR-030](../adr/ADR-030-web-first-delivery-order.md), [`docs/product/milestones.md`](../product/milestones.md)). Content about a specific third-party product was removed under the docs policy ([ADR-034](../adr/ADR-034-docs-policy.md)).

# <Product> for RabbitMQ® — product definition and roadmap (2026-10-16)

RabbitMQ is a trademark of Broadcom, Inc. in the U.S. and other countries. <Product> is not affiliated with or endorsed by Broadcom (DC-57).

## 1. Vision, positioning, personas, principles

**Vision.** Make <Product> the de facto tool for both *using* RabbitMQ (developers) and *managing* it (operators, security, platform teams). It is free forever, and every feature is open source, including the team server.

**One-line positioning.** *The open-source workbench and control plane for RabbitMQ®. One engine and one UI run on your desktop, in your browser or on your team's server, with message tools that know what your RabbitMQ version really does.*

**Why we can win** (fact sheet §k):
- No competitor covers developer IDE + full admin + ops + team server.
- Every competitor is wrong about at least one QQ era.
- Team features are closed or paid everywhere else (Warren, Qarote, HZN).
- The official next-gen UI is 'later'.

| Persona | Code | Jobs to be done |
| --- | --- | --- |
| Application developer | DEV | See what is in a queue without breaking it; publish test messages; watch live traffic; find out why a message went where it did; fix and replay dead letters; read streams by offset or time. Local Docker, staging and prod brokers on Windows, macOS, Linux or a browser. |
| Operator / SRE | OPS | Health, alarms, backlog: why is this queue growing; safe bulk ops; policies and effective config; QQ replicas; upgrades from 3.13 to 4.3/4.4; history and alerts beyond the management UI's minutes of samples. |
| Team / security | SEC | SSO; least privilege that is stricter than the broker (purge needs only read); audit of every peek, publish, purge and replay; approvals; PII masking; secrets never in exports. |
| Platform team | PLAT | Many clusters, managed brokers (Amazon MQ, CloudAMQP, Kubernetes); topology as code; drift; self-service within guardrails; fleet views; an air-gapped install. |

**Product principles (binding)**
1. **Correct by version.** All behaviour comes from the BrokerSemantics registry (DC-01, DC-02). The UI shows the resolved era (3.13 / 4.0-4.2 / 4.3 / 4.4) on every message action.
2. **Side-effect-aware honesty (DC-15).** We never say 'non-destructive' or 'read-only' about CQ/QQ reads. Every peek has a plan before it runs and a receipt after it.
3. **Safe by default in production.** Prod profiles are read-only until unlocked. Destructive actions need a typed confirmation, a dry run and a receipt.
4. **Local-first and private.** No telemetry, licence server or phone-home. It works fully offline. AI talks only to endpoints the user configures (DC-59).
5. **The engine does all broker I/O.** The browser never talks to brokers, and users never configure CORS or Web-STOMP (DC-34).
6. **Capability-gated degradation.** A probe runs on every connect. Every disabled feature says why, with a source link. It works on OSS 3.13-4.3 and on managed brokers (DC-31, DC-60).
7. **Everything is open source**, including SSO, RBAC, audit, approvals and masking. There are no tiers and no CLA (DCO only).
8. **Keyboard-first** IDE ergonomics, with a browser-safe keymap.
9. **One engine, one UI build** for desktop, local web and team server.
10. **Evidence over claims.** A public conformance matrix backs every semantic claim (DC-47).
11. **Respect other operators.** Objects owned by ServiceControl, the Topology Operator or a provider are read-only by default (DC-54).
12. **Accessible (WCAG 2.2 AA) and translatable** from day one.

## 2. UX and information architecture

**Shell.** The layout follows VS Code:
- **Activity bar (left):** Explorer, Messages, Streams, Topology, Admin, Metrics, Diagnostics, Team (server only), Settings.
- **Connection switcher** (top-left): profile chips coloured by environment. Switching keeps the open entity when the same name exists in the target.
- **Explorer tree:** cluster > vhost > queues / streams / exchanges / policies.
- **Tabbed workspace** with splits and deep links (`app://` on desktop, URL routes on the web).
- **Bottom panel:** Jobs, Receipts, Tap feed, Problems (lint), Output.
- **Status bar:** profile, environment, broker version and era badge, stats mode, read-only lock, engine health.

```
A. SHELL
+--+------------------+-------------------------------------------+
|Ex| [PROD-EU v] 4.3.6 era:4.3  stats:off  [lock] read-only        |
|Ms|------------------+-------------------------------------------|
|St| > prod-eu        | [orders.q x][orders.dlq x][topology x]    |
|To|   > / (vhost)    |  (active tab content)                     |
|Ad|     queues (412) |                                           |
|Me|     exchanges    |-------------------------------------------|
|Dx|     policies     | Jobs | Receipts | Tap | Problems(3) | Out  |
+--+------------------+-------------------------------------------+
B. CONNECTIONS            [+ New] [Import bundle] [Discover k8s]
 name      env   endpoints                auth     last probe
 local     DEV   localhost:15672/5672     pass     4.3.6 ok
 prod-eu   PROD  vpce-..:443/5671 (ssh)   OAuth    4.2.9 W-MIXED
 Detail: HTTP | AMQP | TLS(CA,SNI) | Tunnel | Auth | Colour | Read-only
C. OVERVIEW  nodes 3/3 | alarms 0 | queues 412 | msgs 1.2M | DLQ 3,410
 [rates chart][top backlogs][capability card: why-disabled x4][lint 3]
D. QUEUE LIST [filter chips: type=quorum consumers=0] [view: My DLQs v]
 name        type  ready  unacked  cons  in/s  out/s  limit  policy
 orders.q    QQ    120    3        4     40    41     20     ttl-1d
E. QUEUE DETAIL: Overview|Messages|Publish|Tap|Consumers|Routing|
   Config(effective)|Charts|Forecast|Lint
F. MESSAGE WORKBENCH (Messages tab)
 Plan: QQ era 4.0-4.2, L=20, method basic.get x20 + nack(requeue)
  Effects: each message +1 acquired (attempts used shown); hold<=5s
  W-BUDGET [x] I consent   Rescue doomed msgs to: quarantine.orders
 [Peek 20] -> grid | message pane (JSON|Raw|Hex|Headers|Deaths)
 Receipt #r-81: 20 acquired, 20 nacked, AC +1 each, 0 rescued, 1.2s
G. PUBLISH  exchange[orders.x v] key[order.created|] props[+] headers[+]
 Monaco body | [mandatory][confirm] [Publish] -> routed: 2 queues
H. TAP  mode: copied-binding (exclusive classic, drop-head 10k)
 badges: [blind: default exchange] [masks AE/unroutable]  [Stop]
I. DLQ CENTRE  groups by fingerprint | reason | source | framework
 'NullReferenceException @ OrderHandler:42' 312 msgs (MassTransit)
 [Dry run replay] -> target orders.q via default exch, 5/s, canary 1
J. STREAM BROWSER  start: [offset|timestamp|first|last|next]
 filters: bloom[eu] sql[properties.subject = 'x'] applied: OK
K. TOPOLOGY + SIMULATOR  exchange[orders.x] key[order.eu.created]
 headers{..} -> e2e hop -> 2 queues; AE not used; DLX path dashed
L. EFFECTIVE CONFIG  key | arg | user policy | op policy | effective
 max-length | 500 | 1000 (p:limits) | - | 500 (min, QQ, 4.0+)
M. ADMIN  Users | Permissions matrix (user x vhost) | Vhosts | Limits
 | Policies | Definitions | Feature flags | Shovels | Federation | Nodes
N. METRICS  source: Prometheus per node (fallback: mgmt sampling)
 [range 1h|24h|7d] queue depth + rates, forecast overlay, annotations
O. TEAM ADMIN  Users&Groups | Roles | Connections | Approvals(2) |
 Audit (attempt/outcome, hash chain OK) | Masking | Egress | Settings
```

**Top 40 command-palette commands.** Mod = Ctrl on Windows/Linux, Cmd on macOS.

1. Go to anything (Mod+K)
2. Switch connection (Mod+Shift+E)
3. Switch vhost
4. Peek messages (side-effect-aware)
5. Publish message
6. Start tap
7. Stop all taps
8. Open DLQ centre
9. Replay selection (dry run)
10. Browse stream from timestamp
11. Simulate routing
12. Open topology around entity
13. Explain effective config
14. Create queue
15. Create exchange
16. Create binding
17. Purge queue (typed)
18. Delete entity (typed)
19. Bulk action on selection
20. Edit policy
21. Preview policy impact
22. Export messages
23. Import and publish file
24. Copy as code
25. Show as curl / rabbitmqadmin
26. Close connection (with reason)
27. Run lint
28. Upgrade readiness for target version
29. Why is this queue growing?
30. Open metrics for entity
31. Create alert from current chart
32. Export definitions
33. Diff topology against…
34. Toggle read-only lock
35. Open receipts
36. Open jobs
37. Rescan capabilities
38. Toggle theme / density
39. Show keyboard shortcuts (Mod+/)
40. Report diagnostics bundle (redacted, local)

**Keyboard map** (all commands are remappable in a JSON keymap). The browser-safe set avoids chords that browsers reserve.

| Action | Desktop | Browser-safe |
| --- | --- | --- |
| Palette | Mod+K | Mod+K |
| Commands | Mod+Shift+P | Mod+Shift+P (Firefox: Alt+Shift+P) |
| New tab / close tab | Mod+T / Mod+W | Alt+T / Alt+W |
| Next / previous tab | Ctrl+Tab | Alt+PageDown / Alt+PageUp |
| Focus explorer / panel | Mod+Shift+X / Mod+J | same |
| Find in view | Mod+F | Mod+F (captured inside grids only) |
| Peek / publish / tap | Alt+P / Alt+U / Alt+L | same |
| Run / confirm in dialog | Mod+Enter | Mod+Enter |
| Back / forward | Alt+Left / Alt+Right | same |
| Shortcut sheet | Mod+/ | Mod+/ |
| Chord prefix (e.g. g q = go to queues) | g then key | g then key |

**Safety UX**
- **Environment chrome.** Colour bar plus label (DEV green, TEST blue, STAGE amber, PROD red). The colour is never the only signal: a text label and icon always accompany it (WCAG 1.4.1).
- **Read-only prod.** Prod profiles default to locked. Unlocking is per session and audited. Peeks count as mutations for this lock (DC-42).
- **Typed confirmations** for purge, delete, bulk and firehose.
- **Dry runs** freeze the message identities or object list first.
- **Plans before actions:** the peek plan, tap plan and replay plan.
- **Receipts after actions** (DC-15), kept in the Receipts panel and in the audit log.
- **'Why disabled'** tooltips with source links (DC-31).

**Warning registry** (texts versioned; IDs fixed; generated from DC-01):

| Code | Meaning | Default |
| --- | --- | --- |
| W-BUDGET | 4.0-4.2 QQ: each return spends delivery-limit budget | consent required |
| W-313 | 3.13 QQ semantics | confirm |
| W-TAIL | an unlimited QQ returns to the TAIL (order changes) | confirm |
| W-OVERLIMIT | 4.3 QQ DLQ can drop over-limit arrivals on any return | **block**, one-click fix |
| W-DELAY | delayed retry will hide nacked messages | inform |
| W-REDELIVERED | the redelivered flag will be set | inform |
| W-HOLD | consumers cannot see held messages | inform |
| W-DROPHEAD | drop-head with near-full queue | confirm |
| W-TTL | TTL may expire held messages | inform / cap hold |
| W-SAC-CQ | `get` bypasses SAC ordering | confirm |
| W-SAC-QQ | QQ+SAC with an active consumer | refuse |
| W-EXCLUSIVE | owned by another connection | refuse |
| W-CRASH | a broken connection while holding counts on 4.3 | inform |
| W-UPGRADED | limit stat mismatch (3.13-era queue) | inform |
| W-MIXED | mixed-version cluster uses older rules | inform |
| W-STREAM | streams are browsed by offset, never `get` | inform |

**Empty and error states**
- Every empty view teaches: 'No DLQs found: here is how DLX works; create one with this wizard'.
- Errors are translated by the error explainer. Examples: 405 'Broker settings disallow' becomes the provider restriction and its fix; 'no running replica on the local node' becomes a list of replica nodes.
- One failing endpoint never blanks the app; errors are isolated per panel.
- Offline and disconnected states show cached data, clearly stamped with its age.

**Accessibility (WCAG 2.2 AA)**
- @angular/aria and CDK patterns; a full keyboard path (focus not obscured, 2.4.11).
- Target size ≥24 px in comfortable density, with compact density opt-in.
- Visible focus; contrast tokens checked in CI (axe plus Playwright).
- Screen-reader labels on grids.
- Canvas views (graph, charts) always have a table or tree alternative.
- Reduced-motion and high-contrast themes.
- No time limits on confirmations (2.2.1).
- The authentication flow works with password managers (3.3.8).

**i18n**
- Transloco 8 with lazy scopes; every string externalised from M0.
- English at 1.0. Community locales are added through a Weblate-style flow; the first targets are pt-BR, es, fr, de, zh-CN and ja.
- ICU plurals; locale-aware numbers, dates and durations.
- RTL-safe logical CSS.
- Broker identifiers are never translated.

## 3. Community and go-to-market (fully open source)

**Distribution**
- GitHub Releases (immutable, signed).
- macOS: notarised DMG/zip and our own Homebrew tap.
- Windows: Microsoft Store MSIX (no SmartScreen warnings) and NSIS/zip; SignPath once the project has reputation.
- Linux: deb/rpm with an AppArmor profile, and AppImage.
- npm with provenance (`npx <product>`); GHCR multi-arch images (cosign, SBOM); OCI Helm chart.
- winget from M1. Flathub and Snap in wave 2 (DC-58).

**Discovery**
- A one-line factual PR to rabbitmq-website `client-libraries/devtools.md` at the first public release (DC-57).
- Awesome lists; a comparison page based only on verifiable facts.

**Docs site** (Starlight):
- quickstarts per mode;
- concept guides (peek semantics by era, taps and their blind spots, DLQ replay);
- the provider × capability matrix;
- the **public conformance matrix** (DC-47), regenerated by CI for every release, with test IDs linked to registry cells;
- the security model, an outbound-calls list and ADRs.

**Free web utilities** (static, privacy-first, no backend; they funnel to the app):
- x-death / x-opt-deaths decoder;
- topic and headers routing tester;
- policy pattern and effective-value tester;
- AMQP URI builder;
- definitions linter;
- 4.x upgrade checker;
- delivery-limit era explainer.

**Trust assets.** The conformance matrix, the framework failure-header registry (JSON), reproducible and signed builds, SBOMs, OpenSSF Scorecard and a no-telemetry pledge.

**Launch plan**
- **M1 public beta:** blog post 'What peeking really does on 3.13, 4.0-4.2 and 4.3', backed by the matrix. Show HN and r/rabbitmq. A talk proposal to the RabbitMQ Summit / community calls. Upstream bug reports (orelse guard, amqp-js-client fixes).
- **M3:** a 'free team server' launch.
- **M4:** an 'upgrade advisor' launch timed with 4.4 GA.

**Governance**
- Apache-2.0, DCO, GOVERNANCE.md: BDFL-style until 5 maintainers, then a steering committee. Public roadmap (GitHub Projects), RFCs for semantics changes, CODEOWNERS on auth, secrets, desktop main/preload and release.
- An AI-assisted contribution policy: specs with Given/When/Then and verification commands; agent PRs need human review.
- Path: apply to a neutral foundation, CNCF Sandbox or Commonhaus, after 1.0 traction.

**Contribution model**
- Good-first issues generated from the feature catalog.
- Plugin SDKs for codecs, DLQ decoders and lint rules, so the community extends the product without touching the core.
- A provider adapter contribution guide.

**Sustainability (no paid features)**
- GitHub Sponsors and Open Collective.
- Grants: Sovereign Tech Fund and NLnet (EU).
- Corporate sponsorship tiers: logo and roadmap input only.
- Optional third-party support contracts listed on the docs site, delivered by maintainers or partners.
- Hosted CI donations.
- The Apple fee ($99/yr) is the minimum cost.

## 4. Success metrics

| Metric | 6 months after M1 | 12 months | 24 months |
| --- | --- | --- | --- |
| GitHub stars (comparators: RabbitScout 154★, kafka-ui 12.3k★) | 1.5k | 5k | 12k |
| Monthly active installs (opt-in update checks only; no telemetry, so measured by download counters) | 3k | 15k | 50k |
| npm weekly downloads / GHCR pulls per month | 1k / 2k | 5k / 10k | 15k / 40k |
| Conformance matrix | 5 versions × all settle paths green | + 4.4 GA within 14 days | every patch within 14 days |
| Broker-correctness bugs (semantic) open > 30 days | 0 P0 | 0 P0 | 0 P0 |
| Team-server deployments (self-reported, adopters file) | — | 50 | 300 |
| External contributors (merged PRs) / plugins | 20 / 3 | 60 / 10 | 150 / 30 |
| Listed on rabbitmq.com devtools | yes | yes | yes |
| Time-to-first-peek (install to first receipt) | < 3 min | < 2 min | < 2 min |
| p95 UI latency on a 10k-queue broker list | < 300 ms | < 200 ms | < 200 ms |
| Accessibility | axe 0 serious | WCAG 2.2 AA audit | AA re-audit |

## 5. Naming

The brand must be coined, contain no rabbit, and carry the descriptor '<Name> for RabbitMQ®' (DC-57).

| Candidate | Status |
| --- | --- |
| **Sortyard** | Recommended. A rail classification yard sorts wagons onto tracks through switches, which maps to exchanges, bindings and queues, with a yardmaster for ops. |
| **Kewbench** | Runner-up. Reads as 'queue workbench'. Fully free across npm, GitHub, DNS and Docker Hub. |
| Relaybay, Tapyard, Packetboat, Viadux, Queuewright, Hemero, Routelle, Sluicegate, Tidegate | Alternatives; collision notes are in name_candidates. |

**Rejected** after checks:
- npm taken: Penstock, Sluice, Millrace, Patchbay, Signalbox, Estafette, Bindery, Postern, Heliograph.
- Lockkeeper: GitHub org exists, an AI tool uses the name, and all three domains are registered.
- Weirgate: an active GitHub org since 2026-07.
- Junctor: the DEF CON HackerTracker org.
- Strowger: strowger.io is a live product.
- Signalyard, Mailcoach, Quay, Kestrel, Heron, Flume, Envoy: well-known or registered.

**Before committing:** USPTO, EUIPO and WIPO searches, and an email to the RabbitMQ core team (an open uncertainty). The internal npm scope stays @app/* until then.

## 6. Roadmap at a glance and ordering rationale

| Milestone | Target | Theme |
| --- | --- | --- |
| M0 Foundations (internal alpha) | ~Dec 2026 | semantics registry, probe, conformance suite, shells, read-only explorer |
| M1 Developer daily driver (public beta → 1.0 'Developer') | ~Mar 2027 | peek, publish, tap, streams, simulator, effective config, DLQ basics |
| M2 Management parity + DLQ operations centre | ~Jun 2027 | full admin, framework decoders, replay engine, read-only local MCP |
| M3 Free team server | ~Sep 2027 | OIDC, RBAC, audit, approvals, masking, Helm |
| M4 Ops intelligence | ~Dec 2027 | lint, upgrade advisor, diagnostics, Prometheus history, alerts, topology diff |
| M5 Governed AI and MCP | ~Feb 2028 | — |
| M6 Platform scale | 2028 | plan/apply, drift, self-service, HA, node agent, UI extensions |

**Every milestone ships** signed Windows, macOS (arm64 + x64) and Linux desktop builds, an npm package and a Docker image; the team-server image and chart ship from M3 on.

**Alternatives considered**
- **Team server at M2.** Rejected: governance only pays off once there is a breadth of governed actions, and parity is needed for operators to switch.
- **DLQ-first wedge.** Partly adopted: M1 ships DLQ basics, and M2 ships the full centre that depends on the decoders.
- **AI first.** Rejected: DC-42 requires the action layer, receipts and RBAC first. A read-only local MCP arrives at M2 to keep pace with amazon-mq's MCP.

**Gating dependencies.** Peek, tap and DLQ features depend on PLAT-06 (conformance) and MSG-01 (registry). A cell that has not passed in the matrix is shown as 'unverified' and defaults to the most conservative era (DC-02).
