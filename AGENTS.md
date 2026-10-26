# AGENTS.md

Canonical guide for every coding agent working in this repository (Claude Code, Codex, Copilot, ...). `CLAUDE.md` imports this file. Human contributors: read [CONTRIBUTING.md](CONTRIBUTING.md) first.

The source of truth for design is [docs/architecture/blueprint.md](docs/architecture/blueprint.md) (cited below as "blueprint §n"), the plan is [docs/plan/execution-plan.md](docs/plan/execution-plan.md), and binding changes are in [docs/plan/amendments.md](docs/plan/amendments.md). When documents disagree, [docs/README.md](docs/README.md) gives the precedence. Unsettled questions are in [docs/open-questions.md](docs/open-questions.md): do not decide them silently.

## 1. Mission and honesty rules

`<Product> for RabbitMQ®` is an open-source (Apache-2.0) workbench and control plane for RabbitMQ: one TypeScript engine and one Angular UI, shipped as a local web app, desktop apps and a team server. It is built mostly by agents under human review.

**Current goal: Web 1.0** (M0 + M1, the single-user Docker web app), public release targeted for 2026-11-30 ([ADR-035](docs/adr/ADR-035-web-1-0-by-2026-11-30-desktop-after.md), amendment A-26). Pick issues labelled `priority:critical-path` first. Do not start desktop work (Electron, `apps/desktop`, signing, OS packaging) before Web 1.0 ships.

- **Honest wording (DC-15).** Say "side-effect-aware peek". Never call a classic-queue or quorum-queue read "non-destructive" or "read-only". Only the allow-listed stream and node-agent i18n keys may. The `@app/honest-wording` lint rule enforces this in UI strings and i18n JSON; apply the same care in docs and commit messages.
- **Evidence over assertion.** Broker behaviour is data in the semantics registry, backed by lab evidence. Never claim a behaviour the registry or the fact sheet does not support.
- **Names.** The product name is a placeholder (`<Product>`, ADR-029). Keep the placeholder; do not invent a name. Never put "rabbitmq" or "rmq" in a coined name. RabbitMQ is a Broadcom trademark; keep the attribution and non-affiliation line ([TRADEMARKS.md](TRADEMARKS.md)).
- **Docs policy (ADR-034).** Never name the third-party product on the banned-terms list in docs, issues, UI strings, commit messages or code comments. Describe needs as unattributed product requirements.
- **Telemetry.** None, ever (I-12). Update checks are opt-in.

## 2. Invariants I-1..I-14

An agent task may not break one. "Today" means the check exists in this repository now; "planned" means the work package that adds it has not landed, so you are the check: follow the rule by hand.

| # | Invariant | Enforced by | Today |
| --- | --- | --- | --- |
| I-1 | All broker I/O happens in the engine; users never configure CORS or Web-STOMP | Protocol libraries confined or banned in `runtime:browser`; CSP `connect-src 'self'` | Lint (boundaries, confinement); CSP planned |
| I-2 | Every call that mutates state or touches messages goes through `ActionExecutor` | `WritePort` tokens injectable only into `implementAction` modules (architecture test) | `ActionExecutor` and `tools/arch-tests` (syntax rules); `defineJob` and the router check wait for M0-31 and M0-32 |
| I-3 | Version-dependent broker behaviour lives in the semantics registry as data | Lint `@app/no-broker-version-compare` outside `semantics/` and `svc-capabilities` | Lint |
| I-4 | Deliveries are never held across a UI round trip; a hold ends in `nack` + `basic.qos` barrier, a confirmed park, or a proof-backed `ack` | Port types (proofs, role-typed leases); executor model tests | Planned |
| I-5 | Engine event-loop delay p99 <= 20 ms under sweep + tap load | `monitorEventLoopDelay` gate in perf CI | Planned |
| I-6 | Every buffer is bounded by item count and bytes; every drop is counted and surfaced | Lint `@app/bounded-buffers-only` (`BoundedRing` / `BoundedQueue`) | Lint |
| I-7 | The UI never materialises an unbounded collection | Windowed queries only; no "list all" for inventory kinds | Planned |
| I-8 | Each broker has a background load budget; interactive work pre-empts background work | `BrokerScheduler` is the only path to `MgmtHttpPort` and `PromScrapePort` | Planned |
| I-9 | Every outbound socket goes through the Dialer and the TrustStore | `net`, `tls`, `undici`, `ssh2`, `socks` confined to `net-*` and adapter connectors | Lint (confinement of `net`, `tls`, `undici`, `ssh2`, `socks`); direct and TLS Dialer and TrustStore landed (M0-26); tunnel routes and the SSRF policy planned |
| I-10 | After entry, secrets are write-only: never in the renderer, logs, URLs, argv or env | Write-only contract fields; canary-secret log scan in E2E | Contract fields (`secretInput`, `checkRegistry`) and field encryption (`@app/secrets`) landed; the canary scanner (`createCanaryScanner`) checks the diagnostics bundle (M0-69); the canary-secret scan over every log sink is planned |
| I-11 | Each third-party library is imported only by the project that owns it | Confinement table in `eslint.config.mjs` | Lint |
| I-12 | No telemetry, no phone-home | Desktop E2E behind a deny-all egress proxy | Container: the engine bundle runs under an egress guard (`engine:smoke`, and `engine:egress` for 10 minutes), the Dialer purpose registry generates the outbound-calls page; the network-less container run and the desktop run are planned (OQ-400) |
| I-13 | No silent loss: overflow, sampling, gaps, interrupted holds and uncertain replays appear in receipts and frames | Live-protocol model tests; receipt schema | Planned |
| I-14 | Lab truth outranks registry text: a cell's status changes only with a lab evidence artefact and CODEOWNERS sign-off | `semantics-evidence` CI check | CODEOWNERS, the `guard-paths` hook and `nx run semantics-evidence:check` (M0-37): a status or effect change needs valid CI-recorded evidence, and the run behind each stamp is checked through the GitHub API |

## 3. Repo map

Nx 23.3 + pnpm 12.14 workspace with `@app/*` path aliases. Layout: [docs/architecture/repo-layout.md](docs/architecture/repo-layout.md).

- Present now: `apps/engine`, `apps/web`, `apps/docs`, `apps/perf` (performance harnesses: node-only ones such as `perf:explorer-20k`, and the real-browser ones), `apps/perf-grid-page` (the harness page of `perf:grid-100k`), `libs/shared/contracts`, `libs/shared/domain-model`, `libs/shared/semantics` (registry core, no data yet), `libs/shared/routing` (the pure routing simulator: `simulate(topology, publish)` for direct, topic, fanout, headers, exchange-to-exchange, alternate exchanges, the default exchange and CC/BCC; and the dead-letter half: `deadLetterPath`, `findDlxLoops` and `dlxSources` with its A-2 `complete`/`unknownReasons`), `libs/shared/effective-config` (the pure effective-config resolver, DC-30), `libs/engine/svc-ops` (the diagnostics bundle), `libs/engine/live` (the live hub, ticket store and topic registry), `libs/engine/kernel` (with the `BrokerScheduler`, the `ActionExecutor`, the audit chain, receipts, the prod lock and the `DrainCoordinator`), `libs/engine/jobs` (`JobRunner`, token bucket, `defineJob`), `libs/engine/ports`, `libs/engine/persistence`, `libs/engine/net-dialer`, `libs/engine/net-truststore`, `libs/engine/secrets`, `libs/engine/adapter-amqp091`, `libs/engine/adapter-mgmt-http` (management HTTP client: paging, stats flags, status map, product rules), `libs/engine/adapter-prometheus` (the Prometheus scrape client over the Dialer and the bounded exposition parser), `libs/engine/svc-metrics` (the ScrapePlanner, the hot store, the collector with its management fallback, `metrics.query`, `metrics.forecast`, `metrics.live`), `libs/engine/svc-topology` (reads one vhost and answers `topology.graph`, `topology.subgraph`, `routing.simulate`, `routing.dead-letter`, `routing.dlx-sources` and `queues.effective-config`: the engine face of `routing` and `effective-config`, reads only, every cut counted), `libs/shared/forecast` (rates, the drain ETA with a band), `libs/engine/transport` (Fastify router, guards, static UI), `libs/engine/svc-messages` (the capture store: sealed saved captures, content-addressed blobs, a redacted FTS projection and the ingest queue; no action yet), `libs/engine/plugin-host` (the tier-1 worker pool over `node:worker_threads`: bounded queue, time and memory limits, abort, counted rejections), `libs/engine/decoders` (the payload codecs: json, xml, msgpack, cbor, gzip, deflate, brotli, zstd, base64, hex, pickle and PHP listings, CloudEvents; `decodePayload` never throws and never loads), `libs/shared/live-protocol`, `libs/shared/deaths` (the death-history normaliser: `x-death`, `x-opt-deaths`, `x-first/last-death-*` and a trust verdict, pure), `libs/shared/peek-planner` (the pure peek planner: `planPeek` turns the registry cells, the preflight, the profile and the principal into a side-effect-aware peek plan with caps, hold budget, guard and a mandatory disposition, or a rejection with a closed code; the DLX-source rules of A-2 and the HTTP fallback rule of A-3; asks the registry, compares no version), `libs/ui/design` (tokens, themes, `ThemeService`, `<app-gated>`, env chrome, verification banner), `libs/ui/grid` (the AG Grid Community adapter: `<app-data-grid>`, engine windows, own menu, clipboard, column chooser, status bar), `libs/ui/commands` (the command registry: typed commands with contexts and engine-sent gates, the keymap kept by `keybindings.get`/`put`, the palette, the shortcuts dialog and the typed native menu model; a feature registers its own commands with `registerCommands`), `libs/shared/chart-math` (the pure draw maths of the charts), `libs/ui/charts` (local SVG charts, no charting dependency: `<app-line-chart>`, `<app-sparkline>`, `<app-chart-table>`), `libs/shared/metrics-model` (the pure model behind the live charts: bounded series ring, the session that joins `metrics.query` history and `metrics.live` points, status explanations, forecast view, chart definitions), `libs/testkit` (broker-lab helpers, `createTestEngine`, port fakes), `testing/broker-lab` (broker images), `testing/fixtures` (golden fixtures recorded from real brokers), and tooling in `tools/{eslint-rules,lint-selftest,supply-chain,agent-hooks,api-docs,work-graph,semantics-audit,semantics-evidence,conformance-ci,platform-lane,arch-tests,web-gallery-check,grid-bundle-check}`. Everything else in the blueprint is built by later work packages.
- Every project carries a layer tag `type:*` and a runtime tag `runtime:*` in its `project.json`; `trust:critical` marks paths that need human CODEOWNERS sign-off (blueprint §2.1).

| From | May import |
| --- | --- |
| contracts | zod only |
| pure | contracts, pure |
| port | contracts, pure, port |
| kernel | contracts, pure, port, kernel |
| adapter | contracts, pure, port, `net-*` |
| service | contracts, pure, port, kernel, sdk. **Never another service, never an adapter** |
| transport | kernel, contracts, port |
| ui-feature | ui-data, ui-design, ui-lib, ui-platform, contracts, pure. **Never another feature** |

The authoritative tables (full dependency rules, runtime rules, third-party confinement, banned packages) are data in [eslint.config.mjs](eslint.config.mjs); blueprint §2.2 and §2.4 explain them. Do not copy them elsewhere. A new project gets its tags and a README (purpose, public API, invariants, proof commands) from the generators, never by hand.

## 4. Toolchain pins and dependency policy

Pins: Node 24.22 (`.nvmrc`; `engines` >=24.15), pnpm 12.14, TypeScript 6.0.3, Nx 23.3, Angular 22.2.3, Vitest 5.0.5, ESLint 10; for desktop (M2, after Web 1.0), Electron 44.8 then 45.0 after GA plus a soak.

- Every dependency is declared once in the `pnpm-workspace.yaml` catalog with an **exact version** and referenced as `catalog:`. No ranges, no git or tarball sources.
- A new package needs, in one reviewed change: an entry in `tools/supply-chain/deps-allowlist.json`, a clean 3-day release-age check, an ADR-027 log line when an exclusion is needed, and CODEOWNERS approval. The allow-list, the exclusion log and the supply-chain keys of `pnpm-workspace.yaml` are **protected paths**: you propose the change, a maintainer applies it.
- Never run `pnpm update --latest`, bulk `pnpm update`, global installs, or `pnpm add` of an unlisted or unpinned package. The `guard-bash` hook blocks them.
- Never weaken the release-age gate. Vulnerable dependencies follow the security lane ([docs/runbooks/security-lane.md](docs/runbooks/security-lane.md), skill `/security-lane`).
- After any generator run `pnpm install` and re-check the catalog (generators can write ranges; see [s-11-toolchain-proof](docs/architecture/s-11-toolchain-proof.md)).

## 5. Working a work package (WP)

A WP is one GitHub issue, one spec, one git worktree and one commit landed on `main` (the maintainer uses no pull requests; ADR-033: no work without an issue). Size: 0.5-3 agent-days, ideally at most 800 changed lines (not counting generated files, fixtures and lab evidence) unless a maintainer adds `oversize-approved`.

1. **Read the spec.** `gh issue view <n>` carries scope, interfaces, Given/When/Then and verification. If a working spec exists at `docs/specs/<WP-id>.md`, read it too. If neither has acceptance criteria and exact verification commands, run `/wp-spec` and **stop for human approval**.
2. **Worktree.** `git worktree add ../wt/<WP-id> -b wi/<WP-id>-<slug> origin/main`, then `pnpm install --frozen-lockfile`. Commit on the work branch and land it as in step 6.
3. **Scaffold, do not hand-roll.** Use the generator behind the matching skill (section 6). Then code.
4. **Stay in scope.** Follow the spec's out-of-scope list. Work discovered mid-task becomes a **new issue**, never silent scope creep.
5. **Verify.** Run the spec's verification commands and the checks in section 7. Fix causes; never bypass.
6. **Land.** Conventional Commits message with `Closes #<n>`, the AC-to-test map and the verification output in the body or spec. Rebase on `origin/main`, re-verify, push to `main`, then check CI with `gh run list --branch main`. Outside contributors may still open PRs.
7. **Blocked?** Stop and report the questions to the maintainer (or in the issue). Do not guess.
8. **Review** happens in a fresh session with `/review-wp`. Agents never approve their own PRs; humans merge.

Test names quote the AC id they prove (for example `AC-2 ...`). Every AC maps to exactly one named test.

## 6. Generators and skills

Skills live in `.claude/skills/<name>/SKILL.md` and are invoked as `/<name>`. Generators are Nx generators in `@app/generators`.

| Skill | Generator (documented form) | Ships with |
| --- | --- | --- |
| `/wp-spec` | - (fills [docs/specs/_TEMPLATE.md](docs/specs/_TEMPLATE.md)) | M0-07 |
| `/review-wp` | - (fresh-context review) | M0-07 |
| `/new-action` | `pnpm nx g @app/generators:action <ns.verb> --module=<svc> --kind=query\|command\|peek\|job --http='POST /connections/{cid}/...' --permission=<p> --risk=<r> --planning=none\|optional\|required [--mcp=none\|read\|mutating] [--cli='...']` | M0-35 |
| `/new-adapter` | `pnpm nx g @app/generators:adapter <name> --port=<Port> --confine=<npm-pkg>` | M0-08 |
| `/new-ui-feature` | `pnpm nx g @app/generators:ui-feature <name> --route='/c/:cid/<seg>'` | M0-08 |
| `/new-eslint-rule` | `pnpm nx g @app/generators:eslint-rule <id>` | M0-08 |
| `/new-lint-rule` | `pnpm nx g @app/generators:lint-rule <id> --severity --since=<ver>` | M0-08 |
| `/new-decoder` | `pnpm nx g @app/generators:decoder <framework> --tier=builtin\|declarative` | M0-08 |
| `/new-semantics-cell` | `pnpm nx g @app/generators:semantics-cell --era --queue-type --protocol --action --cf=<CF-id>`, then `pnpm nx g @app/generators:conformance-cell <CF-id>` | M0-08 |
| `/security-lane` | - (runbook) | M0-07 |
| `/release` | - (release-please PR is the human gate) | M0-07 |

Also available: `pnpm nx g @app/generators:topic <ns.name> --module=<svc> --flow=credit|snapshot-delta --qos=lossless|latest|sampled --permission=<p>`, `pnpm nx g @app/generators:job <ns.name> --module=<svc>`, and `library`, `service-module`, `migration` (M0-08). Worked examples of an action, a two-phase command and a topic are in [docs/golden-path/](docs/golden-path/). The forms above come from the execution plan (section 2.5); the generators' own `--help` is authoritative. If a generator is not available on your base, say so in the PR; do not hand-write what it would generate and do not invent its behaviour.

## 7. Command cheat sheet

Run everything from the repository root.

| Purpose | Command |
| --- | --- |
| Install | `pnpm install --frozen-lockfile` |
| Whole workspace | `pnpm nx run-many -t build test typecheck lint` |
| Affected (before you finish) | `pnpm nx affected -t lint typecheck test --base=origin/main` |
| Supply-chain gates | `pnpm nx run supply-chain:gates` (needs engine and web builds; the target runs them) |
| Actions pinned by SHA | `pnpm nx run supply-chain:actions-pinned` |
| Gate self-tests | `pnpm nx run-many -t gates-selftest actions-pinned-selftest workflow-hardening-selftest conformance-workflows-selftest -p supply-chain` |
| Custom ESLint rules | `pnpm nx test eslint-rules` and `pnpm nx test lint-selftest` |
| Agent hooks | `pnpm nx test agent-hooks` |
| Spec emitters (regenerate / drift gate) | `pnpm nx run contracts:api-docs` / `pnpm nx run contracts:api-docs-check` |
| Semantics registry audit (ids, keys, CF links, evidence) | `pnpm nx run semantics:audit-cells [--require=citations,conformance,effect]` |
| Routing simulator (direct, topic, fanout, headers, E2E, AE, default exchange, CC/BCC; tables, oracles and properties) and its dead-letter half (paths, cycle rule, loops, DLX sources) | `pnpm nx run-many -t lint typecheck test -p routing` / `pnpm nx test routing --testNamePattern=dlx` |
| Semantics evidence (I-14: a status or effect change needs valid CI-recorded evidence) | `pnpm nx run semantics-evidence:check --base=origin/main` (set `GITHUB_TOKEN` when it must check a run) |
| Conformance (three-way: live run, recorded evidence, registry cell; live needs a Docker daemon) | `pnpm nx run conformance:test [--grep=CF-SMOKE --versions=4.3.6] [--strict]` and `pnpm nx run conformance:coverage [--strict]` |
| Conformance CI (plan for this change, dry run; the PR gate `conformance-pr.yml` runs the matrix, the required check is `conformance`) | `pnpm nx run conformance-ci:plan --base=origin/main` and `pnpm nx run supply-chain:conformance-workflows-selftest` |
| Plan graph (features, work items, dependencies) | `pnpm nx run work-graph:validate` and `pnpm nx run work-graph:test` |
| Platform upgrade lane (self-test; the workflow opens `lane:platform` issues) | `pnpm nx run platform-lane:test` |
| Engine bundle (build, then run it as a process: modes, data-dir lock, metafile) | `pnpm nx build engine` / `pnpm nx run engine:smoke` |
| Run the engine locally with the built web UI (prints the launch URL; [runbook](docs/runbooks/run-locally.md)) / the bundle against a lab broker (needs a Docker daemon) | `pnpm nx run engine:serve` / `pnpm nx run engine:it` |
| Local web mode and container mode (M0-59: loopback bind, launch URL, `APP_RUNTIME=container`, banner, healthcheck; the container cases run the bundle as a process, no Docker needed) | `pnpm nx test engine --testNamePattern=M0-59` / `pnpm nx run engine:smoke` / `pnpm nx run engine:serve -- --open` |
| Docs site | `pnpm nx build docs` |
| Persistence integration tests (SQLite; Postgres 16 and 18 need a Docker daemon) | `pnpm nx run persistence:it --dialects=sqlite,pg` |
| Jobs (runner) and job-store contract on both dialects; shutdown drain | `pnpm nx test jobs` / `pnpm nx run jobs:it --dialects=sqlite,pg` / `pnpm nx test kernel --testNamePattern=drain` |
| Broker lab (needs a Docker daemon, Linux for CI) | `pnpm nx run broker-lab:verify --versions=3.13.7,4.0.9,4.1.8,4.2.9,4.3.6` (`--variants=plain,tls,oauth --nodes=1,3` for the variants) |
| Golden fixtures (replay; record needs a Docker daemon, Linux for CI) | `pnpm nx run adapter-mgmt-http:test-golden` / `pnpm nx run adapter-mgmt-http:record-golden --versions=4.3.6 --check` |
| Formatting | `pnpm format:check` / `pnpm format` |
| Architecture tests (mutation funnel I-2, proof minting A-9, plan-purity manifest) | `pnpm nx test arch-tests` |
| Dev gallery absent from the production web build | `pnpm nx run web-gallery-check:gallery-absent` |
| Production web build renders styled under the real CSP, zero CSP and Trusted Types reports (real browser; skips loudly without one) | `pnpm nx run web-csp-check:csp-check` |
| Grid adapter (component specs run with the lint, typecheck and test targets); no AG Grid Enterprise in its bundle | `pnpm nx run-many -t lint typecheck test -p ui-grid` / `pnpm nx run ui-grid:bundle-check` |
| Command registry, palette, keymap, menu model (component specs run with the test target); no default binding on a reserved chord | `pnpm nx run-many -t lint typecheck test -p ui-commands` and `pnpm nx run web:test --include=apps/web/src/app/commands/shell-commands.spec.ts` |
| Effective config (resolver laws and k.3 data; the rows are in the semantics registry) | `pnpm nx test effective-config` / `pnpm nx test semantics --testNamePattern=M1-01` |
| Action layer (ActionExecutor, PlanStore) | `pnpm nx test kernel --testNamePattern=executor` |
| Explorer: golden replay with the real adapter / lab run (20k queues; `IT_QUEUES=100000` for S-13; needs a Docker daemon) / synthetic perf (window p95, loop delay, search p95) | `pnpm nx test testkit --testNamePattern=AC-22` / `pnpm nx run svc-explorer:it '--versions=4.2.9,4.3.6'` / `pnpm nx run perf:explorer-20k` |
| Live charts (draw maths, session, the Charts and Forecast tabs, the overview Trends) / the draw work of 50 charts at 1 Hz | `pnpm nx run-many -t lint typecheck test -p ui-charts metrics-model feature-explorer` / `pnpm nx run perf:charts-50` |
| Explorer UI interactions: engine plus adapter in Node (AC-26) / the queue page in a real Chromium at 1280x720 under the real CSP with a fake data port (AC-27; needs Chrome or Edge, skips loudly without one, `PERF_REQUIRE_BROWSER` makes that a failure) | `pnpm nx run perf:explorer-ui-20k` / `pnpm nx run perf:explorer-ui-20k-browser` |
| Explorer UI: interaction p95 in the adapter and engine (Node, no rendering) / the calls of the UI through the real router / pages and requests (component specs) | `pnpm nx run perf:explorer-ui-20k` / `pnpm nx test testkit --testNamePattern=AC-28` / `pnpm nx test feature-explorer` |
| Connections UI (M0-52): pages, form, tests, capability card, unlock (component specs) / the same calls through the real router / the source half of the i18n check | `pnpm nx test feature-connections` / `pnpm nx test testkit --testNamePattern=connections` / `pnpm nx test web-gallery-check` |
| Grid at 100,000 rows in a real Chromium at 1280x720 under the real CSP (M0-53 AC-1, AC-4, AC-16: 55 fps and no task above 50 ms while scrolling, at most 25 blocks and a flat heap over 300 jumps, zero CSP and Trusted Types reports; builds `perf-grid-page`; needs Chrome or Edge, skips loudly without one, `PERF_REQUIRE_BROWSER` makes that a failure) | `pnpm nx run perf:grid-100k` |
| Topology, routing simulation, dead-letter sources and effective config over a vhost (snapshot, settings, gaps, graph cap, the six actions; scripted management API, no Docker) / the six routes over the real router | `pnpm nx run-many -t lint typecheck test -p svc-topology` / `pnpm nx test testkit --testNamePattern="M1-20"` |
| Peek planner (M1-12: hold budget, caps, W-OVERLIMIT and the A-2 evidence rules, dispositions, the A-3 fallback per era; pure, no I/O) / registry-driven and mutation-proof checks | `pnpm nx run-many -t lint typecheck test -p peek-planner` / `pnpm nx test peek-planner --testNamePattern="AC-16|AC-19"` |
| Metrics engine: forecast, parser and client, planner / store / collector / actions / topic | `pnpm nx run-many -t lint typecheck test -p forecast adapter-prometheus svc-metrics` |
| Metrics against the recorded Prometheus pages (real client, parser, collector, router) / the composed engine scraping a loopback listener | `pnpm nx test testkit --testNamePattern="golden Prometheus"` / `pnpm nx test engine --testNamePattern=AC-18` |
| Payload codecs (bytes only: hex/base64/text/JSON/XML/msgpack/cbor/gzip/deflate/brotli/zstd, pickle and PHP as listings; bomb caps, properties) / the tier-1 pool (bounded queue, timeouts, memory, abort) / both together in a real worker | `pnpm nx test decoders` / `pnpm nx test plugin-host` / `pnpm nx test testkit --testNamePattern="tier-1 pool"` |
| Metrics at scale (400,000 series, 100,000 queues of demand; counts asserted, times printed) | `pnpm nx run perf:metrics-100k` |
| Capture store (sealed captures, blobs, FTS index, ingest queue; the real SQLite file is read by the testkit specs; Postgres is the same contract in CI) | `pnpm nx test svc-messages --testNamePattern=capture` / `pnpm nx test testkit --testNamePattern='capture stack'` / `pnpm nx run persistence:it --dialects=sqlite,pg` / `pnpm nx run perf:capture-ingest` |
| Planned | `pnpm nx e2e e2e-web`, `pnpm nx run perf:smoke` |

## 8. Engine rules (`libs/engine`, `apps/engine`; details in `.claude/rules/engine.md`)

- Mutations only through `implementAction` or `defineJob`; `WritePort`s are injected only inside them (I-2). `plan()` makes reads only.
- Errors are Problem objects (blueprint §3.6), never ad hoc strings or thrown HTTP errors.
- No broker-version comparisons outside `libs/shared/semantics` and `svc-capabilities` (I-3). No branching on delivery mode outside `apps/engine/src/{entry,modes,modules}`.
- Bounded buffers only: `BoundedRing` / `BoundedQueue` (I-6). Services never import services or adapters.
- Sockets only through the Dialer and TrustStore (I-9). Logs redact secrets (I-10).

## 9. UI rules (`libs/ui`, `apps/web`; details in `.claude/rules/ui.md`)

- Standalone components, zoneless, OnPush, signals. Features are lazy routes and never import another feature.
- The UI renders the `gates` and `allowedActions` the engine sends; it never computes authorisation.
- No `innerHTML` (ADR-021), no direct `fetch` or sockets (use `EngineApi` / the live channel), no raw template text (Transloco keys only), accessible components (Aria and CDK patterns), bundle budgets respected.

## 10. Semantics and evidence (details in `.claude/rules/semantics.md`)

- The registry is data (`libs/shared/semantics/src/data/*.data.ts`), validated with zod. Each cell carries `citations[]`, `conformance[]` (CF ids), `status` and `evidence[]`.
- Agents may add `code-derived` cells **with citations and CF ids**. Agents **never** edit `testing/lab-evidence/**` and **never** flip a cell's status. Evidence is recorded by CI (`conformance:record`, amendment A-20) and approved by a human.
- A missing cell is a `SemanticsGapError` handled conservatively; never paper over it with a default.

## 11. Testing

- Unit tests with Vitest 5; fast-check for pure libraries; testkit fakes (`createTestEngine().inject` for HTTP specs). Broker tests run on Linux only, through the broker lab.
- Coverage targets: >= 90 % lines on `type:pure` and kernel, >= 80 % elsewhere.
- Test strength matters: ask whether the obvious mutant would survive.
- The agent hooks and supply-chain tools use `node --test` (see `tools/agent-hooks`, `tools/supply-chain`); the Nx Vitest generators refuse Vitest 5 (OQ-24), so Vitest projects use a hand-written `vitest.config.mts`.

## 12. Security (details in `.claude/rules/security.md`)

- Secrets are write-only after entry. No new listeners. No telemetry. Outbound traffic only through the Dialer.
- Desktop main and preload stay thin: one MessagePort per page load, validated `senderFrame`, fuses, `shell.openExternal` on an https allow-list with user confirmation.
- Trust-critical paths (blueprint §2.1) need an adversarial second review and a human CODEOWNERS approval. Work in progress on trust-critical WPs is capped at 2.

## 13. Guard-rails, review and commits

**Hooks** (`.claude/settings.json`, scripts in `tools/agent-hooks`) run for Claude Code sessions:

- **Edit/Write/MultiEdit:** `guard-paths` blocks protected paths (below); afterwards `post-edit` runs `prettier --write` and `eslint --fix --max-warnings=0` and reports what is left (exit 2). Fix the cause.
- **Bash:** `guard-bash` blocks unlisted or unpinned `pnpm add/up`, `--no-verify`, any force push, `git push --all`/`--mirror`, deleting main, and global installs.
- **Stop:** `on-stop` runs `nx affected -t lint typecheck test` and keeps you working until it passes.

**Protected paths (human-only):** `testing/lab-evidence/**`; `.github/workflows/release*.yml`; `CODEOWNERS`; the supply-chain keys of `pnpm-workspace.yaml` (release-age, trust policy, build allow-list, overrides); `tools/supply-chain/deps-allowlist.json`; `docs/adr/ADR-027-log.md`; `.claude/settings.json` and the hook scripts. The list is [tools/agent-hooks/protected-paths.mjs](tools/agent-hooks/protected-paths.mjs).

**Forbidden:** `--no-verify`; force-push; disabling or loosening lint rules, hooks or gates; `eslint-disable` without a linked issue; editing protected paths; adding dependencies outside the policy; approving your own PR.

**Definition of Done** (execution plan section 4): the spec is linked and every AC has a named passing test; `nx affected -t lint typecheck test build` and the supply-chain gates are green; boundaries, confinement and custom rules pass; the project README is updated and decisions have an ADR; UI strings come from i18n keys and engine errors are Problems; trust-critical work has the extra review and approval; at most 800 changed lines; Conventional Commits title and DCO sign-off.

**Commits and PRs:** Conventional Commits (`feat(scope): summary`); every commit carries `Signed-off-by:` (the accountable human adds it) and, for agent-authored work, a `Co-Authored-By:` trailer; the commit message (or PR body, for outside contributors) contains `Closes #<n>`. Contributors never edit versions or `CHANGELOG.md` (release-please owns them).

**Review protocol:** a fresh session runs `/review-wp`: re-run the verification commands, check the DoD, invariants, boundaries and honest wording, and judge test strength. Findings are marked blocking or non-blocking. CODEOWNERS ([CODEOWNERS](CODEOWNERS)) maps trust-critical paths to named maintainers.
