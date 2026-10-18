# AGENTS.md

Canonical guide for every coding agent working in this repository (Claude Code, Codex, Copilot, ...). `CLAUDE.md` imports this file. Human contributors: read [CONTRIBUTING.md](CONTRIBUTING.md) first.

The source of truth for design is [docs/architecture/blueprint.md](docs/architecture/blueprint.md) (cited below as "blueprint §n"), the plan is [docs/plan/execution-plan.md](docs/plan/execution-plan.md), and binding changes are in [docs/plan/amendments.md](docs/plan/amendments.md). When documents disagree, [docs/README.md](docs/README.md) gives the precedence. Unsettled questions are in [docs/open-questions.md](docs/open-questions.md): do not decide them silently.

## 1. Mission and honesty rules

`<Product> for RabbitMQ®` is an open-source (Apache-2.0) workbench and control plane for RabbitMQ: one TypeScript engine and one Angular UI, shipped as a local web app, desktop apps and a team server. It is built mostly by agents under human review.

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
| I-2 | Every call that mutates state or touches messages goes through `ActionExecutor` | `WritePort` tokens injectable only into `implementAction` modules (ts-morph architecture test) | Planned (`tools/arch-tests`) |
| I-3 | Version-dependent broker behaviour lives in the semantics registry as data | Lint `@app/no-broker-version-compare` outside `semantics/` and `svc-capabilities` | Lint |
| I-4 | Deliveries are never held across a UI round trip; a hold ends in `nack` + `basic.qos` barrier, a confirmed park, or a proof-backed `ack` | Port types (proofs, role-typed leases); executor model tests | Planned |
| I-5 | Engine event-loop delay p99 <= 20 ms under sweep + tap load | `monitorEventLoopDelay` gate in perf CI | Planned |
| I-6 | Every buffer is bounded by item count and bytes; every drop is counted and surfaced | Lint `@app/bounded-buffers-only` (`BoundedRing` / `BoundedQueue`) | Lint |
| I-7 | The UI never materialises an unbounded collection | Windowed queries only; no "list all" for inventory kinds | Planned |
| I-8 | Each broker has a background load budget; interactive work pre-empts background work | `BrokerScheduler` is the only path to `MgmtHttpPort` and `PromScrapePort` | Planned |
| I-9 | Every outbound socket goes through the Dialer and the TrustStore | `net`, `tls`, `undici`, `ssh2`, `socks` confined to `net-*` and adapter connectors | Partial lint (confinement); Dialer planned |
| I-10 | After entry, secrets are write-only: never in the renderer, logs, URLs, argv or env | Write-only contract fields; canary-secret log scan in E2E | Planned |
| I-11 | Each third-party library is imported only by the project that owns it | Confinement table in `eslint.config.mjs` | Lint |
| I-12 | No telemetry, no phone-home | Desktop E2E behind a deny-all egress proxy | Planned |
| I-13 | No silent loss: overflow, sampling, gaps, interrupted holds and uncertain replays appear in receipts and frames | Live-protocol model tests; receipt schema | Planned |
| I-14 | Lab truth outranks registry text: a cell's status changes only with a lab evidence artefact and CODEOWNERS sign-off | `semantics-evidence` CI check | CODEOWNERS and the `guard-paths` hook; CI check planned |

## 3. Repo map

Nx 23.3 + pnpm 12.14 workspace with `@app/*` path aliases. Layout: [docs/architecture/repo-layout.md](docs/architecture/repo-layout.md).

- Present now: `apps/engine`, `apps/web`, `apps/docs`, `libs/shared/contracts`, `libs/shared/domain-model`, `libs/shared/semantics` (registry core, no data yet), `libs/engine/kernel`, `libs/shared/live-protocol`, `libs/testkit` (broker-lab helpers), `testing/broker-lab` (broker images), and tooling in `tools/{eslint-rules,lint-selftest,supply-chain,agent-hooks,api-docs,work-graph,semantics-audit,platform-lane}`. Everything else in the blueprint is built by later work packages.
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

Pins: Node 24.22 (`.nvmrc`; `engines` >=24.15), pnpm 12.14, TypeScript 6.0.3, Nx 23.3, Angular 22.2.3, Vitest 5.0.5, ESLint 10, Electron 44.8 then 45.0 after GA plus a soak.

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

Also planned: generators `topic`, `job` (M0-35), and `library`, `service-module`, `migration` (M0-08). The forms above come from the execution plan (section 2.5); the generators' own `--help` is authoritative once they exist. If a generator is not available on your base, say so in the PR; do not hand-write what it would generate and do not invent its behaviour.

## 7. Command cheat sheet

Run everything from the repository root.

| Purpose | Command |
| --- | --- |
| Install | `pnpm install --frozen-lockfile` |
| Whole workspace | `pnpm nx run-many -t build test typecheck lint` |
| Affected (before you finish) | `pnpm nx affected -t lint typecheck test --base=origin/main` |
| Supply-chain gates | `pnpm nx run supply-chain:gates` (needs engine and web builds; the target runs them) |
| Actions pinned by SHA | `pnpm nx run supply-chain:actions-pinned` |
| Gate self-tests | `pnpm nx run-many -t gates-selftest actions-pinned-selftest -p supply-chain` |
| Custom ESLint rules | `pnpm nx test eslint-rules` and `pnpm nx test lint-selftest` |
| Agent hooks | `pnpm nx test agent-hooks` |
| Spec emitters (regenerate / drift gate) | `pnpm nx run contracts:api-docs` / `pnpm nx run contracts:api-docs-check` |
| Semantics registry audit (ids, keys, CF links, evidence) | `pnpm nx run semantics:audit-cells [--require=citations,conformance,effect]` |
| Plan graph (features, work items, dependencies) | `pnpm nx run work-graph:validate` and `pnpm nx run work-graph:test` |
| Platform upgrade lane (self-test; the workflow opens `lane:platform` issues) | `pnpm nx run platform-lane:test` |
| Docs site | `pnpm nx build docs` |
| Broker lab (needs a Docker daemon, Linux for CI) | `pnpm nx run broker-lab:verify --versions=3.13.7,4.0.9,4.1.8,4.2.9,4.3.6` (`--variants=plain,tls,oauth --nodes=1,3` for the variants) |
| Formatting | `pnpm format:check` / `pnpm format` |
| Planned | `pnpm nx test arch-tests`, `pnpm nx run conformance:test --versions=...`, `pnpm nx e2e e2e-web`, `pnpm nx run perf:smoke` |

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
