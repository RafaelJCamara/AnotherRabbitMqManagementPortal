> **Design-phase output (2026-10-16).** Amended by [`docs/plan/amendments.md`](../plan/amendments.md), which takes precedence, and re-sequenced web-first ([ADR-030](../adr/ADR-030-web-first-delivery-order.md), [`docs/product/milestones.md`](../product/milestones.md)). Content about a specific third-party product was removed under the docs policy ([ADR-034](../adr/ADR-034-docs-policy.md)).

> **ID map (web-first re-sequencing).** This is the design-phase execution plan; its WP ids are the original ones. Re-sequenced ids and GitHub issue links are in [`work-items.md`](work-items.md). Moved items: M0-18→M1-67, M0-19→M1-68, M0-34→M2-P01, M0-55→M2-P02, M0-56→M2-P03, M0-57→M2-P04, M0-58→M2-P05, M0-61→M2-P06, M0-67→M2-P07, M0-65→M2-P17, M0-66→M3-P01 + M4-P01; epics M2-01/02/04→M2-F01/F02/F03, M2-03/06/07→M3-F01/F02/F03, M2-05/08/09/10/11→M4-F01…F05, M3-xx→M5-xx, M4-xx→M6-xx, M5-xx→M7-xx, M6-xx→M8-xx.

**Summary.** Execution plan for <Product> for RabbitMQ® (Apache-2.0; one Node 24 engine and one Angular 22 build; desktop, local web and team server), built mostly by AI agents. It follows the final blueprint: Fastify 5.12.7 rather than NestJS, no client codegen, and a fail-closed ActionExecutor. The ordering is evidence first. Wave 0 bootstraps the repository in an exact order: licence, Nx 23.3 + pnpm 12.14, the TS 6.0.3 pin, lint and module boundaries, supply-chain and licence gates, CI, Conventional Commits + release-please, a docs site, governance files, and the agent toolchain (AGENTS.md, CLAUDE.md, path rules, hooks, skills, generators, spec template, CODEOWNERS). Next come contracts, the semantics registry, a broker lab with an independent evidence recorder and three-way assertions, and the capability probe. All peek, tap and DLQ work waits until the settle-path cells are three-way green on 3.13.7, 4.0.9, 4.1.8, 4.2.9 and 4.3.6. M0 has 69 work packages (WPs) and M1 has 59, each with Given/When/Then criteria and exact nx verification commands. M2-M6 are split into 46 epics. The plan also gives waves, critical paths, integration points, the DoD and CI gates, a schedule for all 26 open uncertainties, and a release checklist for each milestone.

# <Product> for RabbitMQ® — Execution plan v1 (2026-10-16)

**Inputs.**
- The product definition: 147 features, milestones M0–M6.
- The final architecture blueprint v1.0 (ADR-001..028).
- The verified fact sheet: DC-01..DC-60 and 26 open uncertainties.

**Unit of work.** A work package (WP) is one spec, one git worktree and one PR.
- Size: 0.5–3 agent-days.
- Ideally ≤800 changed lines, not counting generated files, fixtures or lab evidence.

**Coverage.**
- M0 and M1 are fully decomposed: 69 + 59 WPs.
- M2–M6 are epics: 46 in total. Each epic is split with the same template at milestone kickoff.

**Ordering rule: evidence first.** This order is binding:
1. Repo, then contracts.
2. Semantics registry, then conformance lab.
3. Capability probe.
4. Engine and shells.
5. Only then peek, tap and DLQ.

## 0. Reconciliations (the blueprint wins over older product text)
| Product text | Plan | Why |
| --- | --- | --- |
| PLAT-02 says "NestJS 12 on Fastify"; the M0 spike says "NestJS 12 cold start" | Fastify 5.12.7 plus a kit of at most 800 LOC (ADR-004). Spike S-02 measures the cold start of the esbuild engine bundle in a utilityProcess | platform-fastify pins the vulnerable 5.12.5; @nx/nest is capped below Nest 12 |
| PLAT-03 says "Orval-generated Angular client" | `EngineApi` and `engineResource` are typed from zod (ADR-003). No client codegen | One registry, no drift |
| DC-49 says "fastify 5.12.5 only" | Exact pin 5.12.7; the deviation is logged in ADR-004 | GHSA-389g-gv7q-r4x8 |
| PLAT-05 puts "Amqp10Port (rhea)" in M0 | M0: the port interface, plus a raw-rhea lab driver for the 1.0 settle cells. M1: the product `adapter-amqp10` (STR-02) | The M0 exit needs AMQP 1.0 evidence, not the product adapter |
| PLAT-16 (M2) depends on DIA-01 (M4) | M2 ships the x-death decoder, routing tester, policy tester, URI builder and era explainer. The definitions linter and upgrade checker follow in M4 | Dependency order |
| The M0 exit asks for "signed NSIS" | If S-10 proves headless CI signing, use a Certum Open Source certificate. Otherwise the internal alpha ships NSIS unsigned; MSIX through a private Store flight is still signed. The M1 beta gate requires signed NSIS, via Certum or SignPath | SignPath needs reputation and an existing public release |
| Product name | `<product>` codename until ADR-029 (trademark searches) merges. ADR-029 must merge before the first public artefact (M1 beta) | DC-57 |

**Blueprint WP to plan traceability.**

| Blueprint WP | Plan WPs |
| --- | --- |
| WP-01 | M0-01..05, M0-08 |
| WP-02 | M0-10 |
| WP-03 | M0-11..13 |
| WP-04 | M0-14, M0-15, M0-37..42 |
| WP-05 | M0-24, M0-25 |
| WP-06 | M0-26, M3-09 |
| WP-07 | M0-27, M0-28, M0-43 |
| WP-08 | M0-45, M0-46 |
| WP-09 | M0-21, M0-22, M0-31 |
| WP-10 | M0-29, M0-30 |
| WP-11 | M1-12 |
| WP-12 | M1-13..18 |
| WP-13 | M0-32..34, M2-10 |
| WP-14 | M0-55..58 |
| WP-15 | M0-49..51 |
| WP-16 | M0-48, M0-53, M0-54 |
| WP-17 | M1-27..29, M2-05 |
| WP-18 | M1-07, M1-08, M1-30, M1-31 |
| WP-19 | M1-32..35, M2-06, M2-07 |
| WP-20 | M1-01..03, M1-20, M1-36, M2-01..04, M4-01 |
| WP-21 | M1-26, M4-04, M4-05 |
| WP-22 | M0-59, M0-60 |
| WP-23 | M3-01..12 |
| WP-24 | M3-11 |
| WP-25 | M2-10, M5-* |
| WP-26 | M2-07 |
| WP-27 | M0-64..68 |

## 1. Repository bootstrap (exact order)
Each step is one squash-merged PR with a Conventional Commits title and a DCO sign-off. Step 0 is human-only and starts on day 1.

0. **Human prerequisites (M0-09; long lead time).**
   - GitHub org and repo named after the codename, never containing "rabbitmq" or "rmq".
   - Branch protection: required checks, code-owner review, linear history, merge queue. Also turn on private vulnerability reporting and immutable releases.
   - Accounts: Apple Developer ($99/yr), Microsoft Partner Center, npm org with trusted publishing, GHCR, and the Certum OSS certificate.
   - Test infrastructure: Amazon MQ 3.13/4.2/4.3 and CloudAMQP shared + dedicated brokers; Keycloak 26 and Entra test tenants.
   - Naming: USPTO/EUIPO/WIPO searches and an email to the RabbitMQ core team.
   - SignPath: apply after the first public release.
1. **Licence-first commit.**
   - LICENSE (Apache-2.0) and NOTICE.
   - A README stub with "<Product> for RabbitMQ®", the Broadcom attribution and the non-affiliation line.
   - .gitignore, `.gitattributes` (`* text=auto eol=lf`), .editorconfig, and `.nvmrc` = 24.22.0.
2. **Nx + pnpm workspace (M0-01).**
   - Run `pnpm dlx create-nx-workspace@23.3.0 <codename> --preset=apps --pm=pnpm --workspaces=false --nxCloud=skip --skipGit --interactive=false`, then move the output into the repo root. This gives the integrated layout with `@app/*` path aliases.
   - Set `"packageManager": "pnpm@12.14.0"` and `"engines": {"node": ">=24.15"}`.
   - Declare every dependency once in the `pnpm-workspace.yaml` catalog with an exact version, and reference it as `catalog:`.
   - Nx plugins, all at 23.3.0: @nx/angular, @nx/js, @nx/vitest, @nx/playwright, @nx/esbuild, @nx/eslint, @nx/eslint-plugin, @nx/devkit. No @nx/nest.
3. **TS 6.0.3 pin.**
   - Catalog entry `typescript: 6.0.3`.
   - `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `moduleResolution: bundler`.
   - Toolchain proof (S-11): generate `pnpm nx g @nx/angular:application apps/web --bundler=esbuild --ssr=false --unitTestRunner=vitest --e2eTestRunner=none`, an `@nx/esbuild` engine app and a Vitest library. Then `pnpm nx run-many -t build test typecheck` must pass on Linux, macOS and Windows.
4. **Lint and format (M0-03, M0-04).**
   - ESLint 10 flat config, typescript-eslint strictTypeChecked, angular-eslint 22, Prettier.
   - `@nx/enforce-module-boundaries` with type, runtime and trust tags.
   - Third-party confinement through `no-restricted-imports`.
   - Custom rules live in tools/eslint-rules.
5. **Licence gate and supply chain (M0-02).**
   - `pnpm-workspace.yaml` supply-chain keys exactly as in blueprint §14.3: `minimumReleaseAge` 4320 with strict mode; exact-version exclusions logged in ADR-027-log; `trustPolicy: no-downgrade`; `blockExoticSubdeps`; `strictDepBuilds`; `allowBuilds`.
   - `tools/supply-chain` gates:
     - licence allow-list (DC-50);
     - git/tarball dependency ban (DC-24);
     - exact pins, TS 6.0.3 only, and the banned list (DC-49/50);
     - agent dependency allow-list.
   - `gates-selftest` runs the gates against planted violations.
6. **CI skeleton (M0-05).**
   - Workflows: ci.yml (setup → gates → `nx affected -t lint typecheck test build`), CodeQL, Scorecard, pr-title (Conventional Commits), DCO, dependency-review, zizmor.
   - Every action is pinned by SHA.
   - Renovate (respecting the release-age gate) and OSV-Scanner.
7. **Conventional Commits + release-please (M0-06).**
   - Squash merges only.
   - release-please 17 in manifest mode with one root package `"."`:
     - `release-type: node`;
     - `extra-files`: apps/desktop/package.json, apps/cli/package.json, packaging/helm/<product>/Chart.yaml;
     - `prerelease: true` and `prerelease-type: alpha` until M1.
   - `.release-please-manifest.json` = `{".": "0.0.0"}`.
   - The release PR is the human gate.
8. **Docs site (M0-06).**
   - `apps/docs` built with Astro Starlight + starlight-openapi.
   - Content: ADR-001..028, `/matrix`, `/security/outbound-calls`, and the attribution footer.
   - Deployed to GitHub Pages by the release workflow.
9. **OSS governance files (M0-06, M0-07).**
   - CONTRIBUTING: DCO, plus the AI-assisted contribution policy:
     - every change has a spec with Given/When/Then and verification commands;
     - a human reviews every agent PR;
     - the agent gets a `Co-Authored-By` trailer;
     - the accountable human adds `Signed-off-by`.
   - CODE_OF_CONDUCT (Contributor Covenant 2.1) and SECURITY.
   - GOVERNANCE: BDFL until there are 5 maintainers, then a steering committee; RFCs for semantics changes.
   - TRADEMARKS, SUPPORT, ADOPTERS, issue/PR templates and CODEOWNERS.
10. **Agent toolchain (M0-07), generators (M0-08), then contracts (M0-10).** From this point on, all code arrives through WPs.

## 2. Agent workflow conventions
### 2.1 AGENTS.md (canonical) — outline
1. Mission and honesty rules: DC-15 wording; say "side-effect-aware peek" and never "non-destructive" for CQ/QQ reads.
2. Invariants I-1..I-14, each with the check that enforces it.
3. Repo map: layer, runtime and trust tags; the dependency table; the third-party confinement table; banned packages.
4. Toolchain pins and dependency policy.
   - Pins: Node 24.22, pnpm 12.14, TS 6.0.3, Nx 23.3, Angular 22.2.3, Electron 44.8 then 45.0.
   - Never run `pnpm update --latest`.
   - A new package needs a deps-allowlist entry, an ADR-027 log line and CODEOWNERS approval.
5. Working a WP.
   - Flow: `docs/specs/<WP>.md`, then worktree, generator, code, verification commands, PR template.
   - Respect size limits and out-of-scope discipline.
   - When blocked, open a draft PR labelled `blocked` that lists the questions.
6. Generators and skills index, with exact commands.
7. Command cheat sheet: install, affected, conformance, e2e, api-docs, gates, perf.
8. Engine rules:
   - mutations only through `implementAction` or `defineJob`, and WritePorts only inside them;
   - errors as Problem objects;
   - no broker-version comparisons outside semantics and svc-capabilities;
   - bounded buffers only;
   - no branching on delivery mode;
   - sockets only through the Dialer;
   - log redaction.
9. UI rules:
   - zoneless, OnPush, signals;
   - render `gates` and `allowedActions`; never compute authorisation;
   - no innerHTML and no direct fetch;
   - i18n keys only;
   - Aria and CDK patterns;
   - bundle budgets.
10. Semantics and evidence:
    - the registry is data;
    - agents may add code-derived cells with citations and CF ids;
    - agents never edit `testing/lab-evidence/**` and never flip a cell's status.
11. Testing:
    - test names quote AC ids;
    - fast-check for pure libraries;
    - testkit fakes;
    - broker tests run on Linux only, through broker-lab.
12. Security: secrets are write-only; no new listeners; no telemetry; desktop main and preload rules.
13. DoD, review protocol, CODEOWNERS and commit/PR conventions. Forbidden: `--no-verify`, force-push, disabling lint or hooks, editing protected paths.

### 2.2 CLAUDE.md (≤60 lines; it imports AGENTS.md, so Claude Code loads both)
```md
@AGENTS.md
## Claude Code specifics
- One WP per worktree: git worktree add ../wt/<WP> -b wp/<WP> origin/main. Never commit to main.
- Read docs/specs/<WP>.md first; if it is missing run /wp-spec and stop for human approval.
- Scaffold with skills (/new-action, /new-adapter, /new-ui-feature, /new-eslint-rule, /new-lint-rule, /new-decoder, /new-semantics-cell); never hand-roll module structure.
- Hooks format+lint every edit and run affected lint/typecheck/test on Stop: fix the cause, never bypass.
- Protected paths are human-only; a PreToolUse hook blocks them.
- Finish by running the spec's verification commands and paste their output into the PR.
- Reviews always run in a fresh session with /review-wp.
```

### 2.3 Path-scoped rules (`.claude/rules/*.md`, using `paths:` frontmatter)
| File | paths | Key content |
| --- | --- | --- |
| engine.md | libs/engine/**, apps/engine/**, libs/shared/** | executor-only mutations, ports, Problem errors, bounded buffers, no mode branching, redaction |
| ui.md | libs/ui/**, apps/web/** | signals/OnPush, EngineApi only, gated components, i18n, a11y, budgets |
| desktop.md | apps/desktop/** | thin main, CtlFrame, one port per page load, fuses, openExternal allow-list |
| semantics.md | libs/shared/semantics/**, apps/conformance/**, testing/** | data-only cells, citations, CF ids, three-way rule; evidence is recorded and approved by humans |
| security.md | libs/engine/secrets/**, libs/engine/net-*/**, libs/engine/transport/**, libs/engine/svc-identity/**, libs/engine/svc-access/**, libs/engine/svc-audit/**, libs/engine/svc-mcp/** | write-only secrets, Dialer/TrustStore, carrier header, Host/Origin/CSRF rules |
| release.md | .github/**, packaging/**, tools/supply-chain/** | SHA-pinned actions, signing order, notices from the metafile, owner review |

### 2.4 Hooks (`.claude/settings.json`)
```json
{"hooks":{
 "PreToolUse":[{"matcher":"Edit|Write|MultiEdit","hooks":[{"type":"command","command":"node tools/agent-hooks/guard-paths.mjs"}]},
               {"matcher":"Bash","hooks":[{"type":"command","command":"node tools/agent-hooks/guard-bash.mjs"}]}],
 "PostToolUse":[{"matcher":"Edit|Write|MultiEdit","hooks":[{"type":"command","command":"node tools/agent-hooks/post-edit.mjs"}]}],
 "Stop":[{"hooks":[{"type":"command","command":"node tools/agent-hooks/on-stop.mjs","timeout":900}]}]}}
```
- **post-edit.mjs** reads `tool_input.file_path` from stdin.
  - It runs `prettier --write`, then `eslint --fix --max-warnings=0` on .ts, .html and .json files.
  - Any problem left over goes to stderr with exit 2, so the agent sees it.
- **on-stop.mjs** exits 0 when `stop_hook_active` is set.
  - Otherwise it runs `pnpm nx affected -t lint typecheck test --base=origin/main --parallel=3`, plus `contracts:api-docs-check` when contracts changed.
  - On failure it writes a summary to stderr and exits 2, so the agent keeps working.
- **guard-paths.mjs** exits 2 for these paths:
  - `testing/lab-evidence/**` and `.github/workflows/release*.yml`;
  - `CODEOWNERS`;
  - the supply-chain keys in `pnpm-workspace.yaml`;
  - `tools/supply-chain/deps-allowlist.json` and `docs/adr/ADR-027-log.md`.
- **guard-bash.mjs** exits 2 for:
  - `pnpm add` or `pnpm up` of a package that is not on the allow-list, or without an exact version;
  - `--no-verify`;
  - `git push` to main, or with `--force`;
  - `npm i -g`.

### 2.5 Skills and Nx generators
| Skill | Generator command | Creates |
| --- | --- | --- |
| new-action (new endpoint) | `pnpm nx g @app/generators:action <ns.verb> --module=<svc> --kind=query | command | peek | job --http='POST /connections/{cid}/...' --permission=<p> --risk=<r> --planning=none | optional | required [--mcp=none | read | mutating] [--cli='...']` | contract; `implementAction` stub (throws NotImplemented); registration; unit spec (plan purity, deny-by-default, audit attempt/outcome, receipt); HTTP spec via `createTestEngine().inject`; UI command stub |
| new-topic / new-job | `@app/generators:topic <id> --module --qos --flow`; `@app/generators:job <type> --module` | topic or job with a bounded ring and a model test |
| new-adapter | `@app/generators:adapter <name> --port=<Port> --confine=<npm-pkg>` | type:adapter library, port implementation skeleton, contract-suite hook, confinement entry |
| new-ui-feature (feature lib) | `@app/generators:ui-feature <name> --route='/c/:cid/<seg>'` | lazy route, Transloco scope, gallery entry, Playwright spec with axe |
| new-eslint-rule | `@app/generators:eslint-rule <id>` | rule, RuleTester spec, registration |
| new-lint-rule (broker linter, DC-56) | `@app/generators:lint-rule <id> --severity --since=<ver>` | rule in libs/shared/lint-rules with fixtures per version |
| new-decoder | `@app/generators:decoder <framework> --tier=builtin | declarative` | decoder skeleton, header-registry entry, fixture folder |
| new-semantics-cell | `@app/generators:semantics-cell --era --queue-type --protocol --action --cf=<CF-id>`, then `@app/generators:conformance-cell <CF-id>` | code-derived cell plus a linked lab-cell stub |

Also available:
- generators: `service-module`, `migration`, `library`;
- workflow skills: wp-spec, review-wp, security-lane, release.

### 2.6 One spec per WP (`docs/specs/_TEMPLATE.md`)
```md
# <WP-id> <title>   (milestone · wave · size · owner area · trust:critical yes/no)
## Goal              1-2 sentences + feature / DC / ADR ids
## Files & interfaces   create / modify lists; TS signatures introduced and consumed
## Out of scope      explicit list
## Acceptance criteria   AC-1..n as Given/When/Then; each maps to exactly one named test
## Verification      exact, copy-paste-runnable commands
## Risks / questions
## DoD checklist
```

### 2.7 Writer/reviewer split
- **Writer.** One Claude Code session per WP, inside its worktree. It opens the PR with the spec link, the AC→test map and the verification output.
- **Reviewer.** A fresh session that never saw the writer's context runs `/review-wp`. It:
  - re-runs the verification commands;
  - checks the DoD, invariants, boundaries and honest wording;
  - checks test strength: would the obvious mutant survive?
  - posts findings marked blocking or non-blocking.
- **trust:critical WPs** also get an adversarial second reviewer (the security-review skill) and a mandatory human CODEOWNERS approval.
- **Merging.** Humans merge through the merge queue. Agents never approve their own PRs.

### 2.8 CODEOWNERS (one line per path in the real file)
| Paths | Owner |
| --- | --- |
| libs/engine/{secrets, svc-identity, svc-access, svc-audit, net-dialer, net-truststore, transport, svc-mcp}/ | @org/security |
| apps/desktop/src/main/, apps/desktop/src/preload/ | @org/desktop-security |
| libs/shared/{semantics, peek-planner, tap-planner, replay-planner}/; libs/engine/{svc-peek, svc-tap, svc-dlq}/; libs/engine/kernel/src/actions/ | @org/semantics |
| testing/lab-evidence/, apps/conformance/ | @org/semantics (label `lab-evidence`) |
| .github/workflows/, packaging/, pnpm-workspace.yaml, tools/supply-chain/ | @org/release |
| CODEOWNERS, AGENTS.md, CLAUDE.md, .claude/ | @org/maintainers |

### 2.9 Worktrees and merge flow
1. `git worktree add ../wt/M0-14 -b wp/M0-14 origin/main`.
2. `pnpm install --frozen-lockfile` (the pnpm store is shared).
3. Work, rebase, open the PR, get the reviewer's approval (plus CODEOWNERS where required), then merge through the merge queue.

Testcontainers uses random ports, so parallel worktrees can run broker tests at the same time.

**WIP limit:** 6 writer worktrees and 3 reviewer sessions.

**The bottleneck is human CODEOWNERS review.** About 40 % of M0 WPs are trust:critical. Maintainers review in two batches a day.

## 3. Waves, critical path, integration points
A wave lists WPs whose dependencies are met at about the same time. Within a wave, WPs run in parallel in separate worktrees, subject to `depends_on`.

| Wave | WPs | Theme |
| --- | --- | --- |
| M0-W0 | M0-01..M0-09 | Bootstrap, governance, agent toolchain, generators. 01→03→04→08 is serial; 02, 05, 06, 07 and 09 fan out |
| M0-W1 | M0-10..M0-20 | Contracts; domain model, registry core and data; broker-lab; lab driver; kernel primitives; live protocol; spikes S-01/02/03, S-07/10 and S-04 |
| M0-W2 | M0-21..M0-42 | Persistence, secrets, ports and scheduler, adapters, executor, audit, jobs/drain, transport, live hub, MessagePort tunnel, generators, composition root. In parallel, evidence lane C: harness, lab cells, conformance CI |
| M0-W3 | M0-43..M0-62 | Connection manager, connections, probe, gates, workspace, explorer; UI libraries and shell; desktop main, supervisor and fuses; local web; e2e suites; matrix v0 |
| M0-W4 | M0-63..M0-69 | Provider runs, container image, npm package, desktop packaging, release workflow, privacy |
| M1-W1 | M1-01..M1-11, M1-41, M1-42 | Pure libraries, adapter-amqp10, labs, capture store, codecs, graph spike, palette and navigation |
| M1-W2 | M1-12..M1-26, M1-43, M1-45 | Peek core and its conformance, publish, topology actions, TLS/tunnels/identity, metrics engine, explainer, viewer |
| M1-W3 | M1-27..M1-40, M1-44, M1-46, M1-49, M1-53, M1-54 | Taps, streams, DLQ, admin, alternative peek paths, hardening, workspace, extract; first UI features |
| M1-W4 | M1-47, M1-48, M1-50, M1-51, M1-52, M1-55 | Remaining UI features |
| M1-W5 | M1-56..M1-59 | Accessibility, i18n/theming, docs, 1.0 'Developer' release |

**M0 critical path.** About 17 WPs, roughly 30 agent-days if done serially:

M0-01 → 03 → 04 → 08 → 10 → 11 → 16 → 21 → 29 → 32 → 33 → 34 → 36 → 56 → 58 → 67 → 68

- **Near-critical evidence lane:** M0-05 → 14 → 15 → 37 → 38/39/40/41 → 62.
- **Calendar risks outside the agent path:** verification of the Apple, Store and Certum accounts (start on day 1), and human approval of lab evidence.

**M1 critical path:** M0-62 → M1-12 → 14 → 15 → 16 → 18 → 38 (needs 7 clean chaos nights) → 59.
- UI tail: M1-16 → 44 → 56 → 59.
- DLQ tail: M1-18 → 34 → 35.

**Integration points**
| IP | When | Proof |
| --- | --- | --- |
| IP-1: contracts and registry schema freeze v0 | End of M0-W1 | OpenAPI/AsyncAPI committed; `semantics:audit-cells` green |
| IP-2: walking skeleton | Mid M0-W2 | A golden-path query runs executor → router over HTTP, WebSocket and MessagePort (`transport:it`, `perf:messageport-p95`) |
| IP-3: three shells, one UI build | M0-W3 | M0-60 (npx/WebSocket) and M0-61 (Electron/MessagePort) pass on the same `dist/web` |
| IP-4: conformance gate on | M0-W3 | M0-38..41 three-way green on 5 versions; matrix v0 (M0-62). Peek, tap and DLQ WPs unblock |
| IP-5: M0 release dry run | M0-W4 | M0-68 on a fork tag |
| IP-6: peek vertical slice | M1-W3 | M1-16 + M1-44 behind the `peek` flag. The flag is removed when M1-18 is green and M1-38 has 7 clean nights |
| IP-7: beta freeze → 1.0 | M1-W5 | Public beta 0.9.x, then 1.0 'Developer' once parity and usability pass |

**Later milestones.** A milestone opens when the previous one ships.
- **M2.** W1: admin I/II, policies, taps/streams, DLQ engine, SDK + decoders, providers, IPC/CLI/MCP. W2: admin III, publish/codecs, web utilities.
- **M3.** Runtime → OIDC → RBAC/audit/egress → everything else. The Helm chart and security review come last.
- **M4.** Lint and history first.
- **Then M5, then M6.**

**Capacity.** M0 is about 115 agent-days and M1 about 120 agent-days. With 6 parallel writers and a 1.5× integration/review factor, each milestone takes roughly 6 weeks. That fits the ~Dec 2026 and ~Mar 2027 targets only if human review keeps pace.

## 4. Definition of Done and CI gates
**DoD for every WP**
1. The spec is merged or linked. Every AC has a named automated test. The verification commands pass locally and in CI.
2. Builds and gates:
   - `nx affected -t lint typecheck test build` is green;
   - supply-chain gates are green;
   - `contracts:api-docs-check` is clean;
   - no dependency outside the allow-list.
3. Boundaries, confinement and custom rules pass. No `eslint-disable` without a linked issue.
4. The project README is updated (purpose, public API, invariants, proof commands). Any decision gets an ADR or ADR addendum.
5. UI and engine checks:
   - UI: strings come from Transloco keys, axe is clean on touched routes, and budgets are met.
   - Engine: errors are Problems, buffers are bounded, and the redaction canary passes.
6. Extra approval:
   - trust:critical: adversarial review plus CODEOWNERS approval;
   - semantics: evidence plus a three-way green result.
7. At most 800 changed lines, not counting generated files, fixtures and evidence, unless a maintainer adds the `oversize-approved` label.
8. Conventional Commits PR title, DCO sign-off, and the agent co-author trailer.

**CI gates**
| Gate | Command | Threshold | Runs |
| --- | --- | --- | --- |
| Supply chain + licence | `pnpm nx run supply-chain:gates` | 0 violations: licence allow-list, git/tarball deps, exact pins, TS 6.0.3 only, banned list, allow-list, SHA-pinned actions, zizmor | every PR |
| Lint, typecheck, unit | `pnpm nx affected -t lint typecheck test` | 0 errors; line coverage ≥90 % on type:pure and kernel, ≥80 % elsewhere | every PR |
| Architecture | `pnpm nx test arch-tests` | WritePort funnel, plan purity, service isolation | every PR |
| Contracts | `pnpm nx run contracts:api-docs-check`, plus the digest-pinned oasdiff Go binary against the last tag | no drift; no breaking change in /api/v1 | every PR |
| Golden fixtures | `pnpm nx run adapter-mgmt-http:test-golden` | 5 versions + LavinMQ parse | affected |
| Adapter contract | `pnpm nx run adapter-amqp091:contract --broker=all` (from M1 also `adapter-amqp10:contract`) | pass | affected |
| Conformance matrix | `pnpm nx run conformance:test --versions=3.13.7,4.0.9,4.1.8,4.2.9,4.3.6 --shard=i/n`, `semantics:audit-cells`, `semantics-evidence:check` | every cell three-way green; no cell without a CF id; a status flips only with evidence | affected PRs; full run nightly and on every tag |
| E2E web | `pnpm nx e2e e2e-web` | pass; axe 0 serious or critical | affected |
| Electron smoke | `pnpm nx e2e e2e-desktop --grep=@smoke` | Linux on PRs; macOS and Windows nightly and on tags | affected |
| Accessibility | axe on all routes and the gallery; keyboard-only flows from M1 | 0 serious | affected |
| Bundle budgets | Angular budgets + `pnpm nx run web:budgets` | initial ≤350 kB gzip (error at 450); feature chunk ≤200 kB; Monaco ≤1.1 MB lazy; ECharts ≤250 kB | affected web |
| Performance | `perf:smoke` on PRs, `perf:nightly` nightly | event-loop delay p99 ≤20 ms; MessagePort overhead p95 ≤2 ms; grid ≥55 fps; regression ≤15 % | PR smoke / nightly |
| Security | CodeQL, OSV-Scanner, secret scanning, canary-secret log scan, Trivy (image), fuse-check | 0 high or critical without an approved exception | PR / tag |
| Mutation and chaos | `mutation-nightly`; `chaos:peek-down-race` (M1+) | listed mutants killed; 0 unexplained DC deltas in 2,000 runs | nightly |
| Release only | notarisation, signing, notices/SBOM from the metafile, cosign, Helm `ct` (M3+) | all green | tag |

## 5. Remaining uncertainties → spikes and lab tests
**Rule.** A feature whose correctness depends on an uncertainty cannot merge, or stays behind a flag that is off, until the lab result or spike is recorded. A negative result changes the registry or the design, never the test.

| # | Uncertainty | Resolved by | WP | Must land before | If negative |
| --- | --- | --- | --- | --- | --- |
| U-01 | Settle matrix never measured (priorities 1–5) | CF-SETTLE, CF-DOWN and CF-CARRY cells on 5 versions | M0-38/39/40 | every peek/tap/DLQ WP; M0 exit | Human-reviewed registry fix; the planner uses the corrected cell |
| U-02 | Effective QQ machine version (v7/v8) in mixed or upgraded clusters | Rolling upgrade 4.2.9→4.3.6 with the flag off and on; status endpoint vs canary QQ | M0-41 (canary decision in M3-03) | era resolver GA (M0); team canary (M3) | Keep the conservative rule; canary stays opt-in |
| U-03 | Aborted HTTP /get may turn held messages into failed deliveries | CF-HTTPGET-ABORT on 4.2.9/4.3.6 | M1-06 | MSG-13 (M1-37) | Client timeout above server work; hide the fallback for finite-L QQs on 4.3 |
| U-04 | DOWN overtaking a pipelined nack | Lab-driver chaos pre-run, then executor chaos (S-09) | M1-06, M1-38 | 'lab-verified' badge on QQ peek; 1.0 | Lazy close after the barrier, W-CRASH disclosure; badge stays 'code-derived' |
| U-05 | 4.3 delayed-retry visibility after a nack peek | CF-DR cells | M0-40 | planner W-DELAY (M1-12) | Treat types all/returned as consent-gated |
| U-06 | Local shovels carrying DC and death annotations | CF-SHOVEL-CARRY | M2-06 | shovel moves (M4-07) | Shovel moves stay off; engine republish only |
| U-07 | Stream reads: oracle offsets, 3.13 AMQP 1.0, replica landing behind an LB | Oracle diff, plus cells on 3 nodes behind HAProxy | M1-08 | STR-01/02 (M1-30/31) | 3.13 streams via 0-9-1 only; replica helper |
| U-08 | Header fidelity across protocols and streams | CF-FIDELITY | M1-06 | viewer badges (M1-45); DLQ views (M1-51) | Show the 'possible loss' badge by default |
| U-09 | Runtime side effects of vhost PUT | CF-OPS-VHOST | M0-41 | any vhost write (M2-01); firehose (M2-05) | GET-merge-PUT regardless (DC-21) |
| U-10 | Tap back-pressure on publishers | Load test | M1-29 | tap defaults GA | Lower max-length and prefetch; add a warning |
| U-11, U-12 | Amazon MQ and CloudAMQP specifics | Provider contract runs, v0 then v1 | M0-63, M1-29, M2-09 | M0 exit (probe); presets (M2) | Gate the feature off with a reason |
| U-13 | LavinMQ compatibility | Golden fixtures and a contract suite with recorded deviations | M0-25, M1-37, M2-09 | HTTP get adapter (M1); presets (M2) | AMQP-only and read-only for unverified endpoints |
| U-14 | Auth behaviour per protocol/version; 431 and frame thresholds; `?token=` | Keycloak 26 + Entra lab | M1-25 | TokenManager GA (M1-23/24) | Reconnect before expiry everywhere; size warnings |
| U-15 | IdP specifics: ephemeral ports, OBO, token exchange | Per-tenant spikes | M1-24/25, M3-05 | OAuth login (M1); delegated mode (M3) | Fixed ports or device code; service-account mode |
| U-16 | Electron runtime: CA APIs, argon2, PKCS#12, safeStorage, prompts, MessagePort performance, cold start | S-01/02/03 and S-07 | M0-18, M0-19 | M0-26, M0-34, M0-56/57 | CJS bundle; scrypt; engine-link worker; documented prompts |
| U-17 | amqplib nack after a server cancel; GC with 1–10 MB messages; rhea `release()` | Contract cells and benchmarks | M0-28, M1-06, M1-08 | peek executor (M1-14) | Get-only peek, with no consumer path where unsafe |
| U-18 | CQ requeue order for paged and priority queues | CF-CQORDER | M1-06 | CQ 'original position' claim (M1-14) | Receipt says 'position may change' |
| U-19 | Copied x-delivery-count vs framework retry logic | CF-DLQ cells; fixture apps | M1-35, M2-07 | replay defaults (M1-34); decoders (M2) | Strip by default (already the plan) |
| U-20 | MassTransit v9 wire details | Licensed harness (optional) | M2-07 | any v9 claim | Claim v8 only |
| U-21 | Signing pipeline: SignPath, MSIX + utilityProcess, Certum in CI | S-10 plus a SignPath inquiry | M0-19 | M0-67/68 | Unsigned NSIS for the internal alpha only |
| U-22 | Monorepo tooling | S-11 inside M0-01 (@nx/nest is moot) | M0-01 | everything | Pin Nx 23.3.0; run-commands targets |
| U-23 | Cytoscape WebGL on VMs and RDP | Spike | M1-11 | topology view (M1-49) | Canvas by default; WebGL opt-in |
| U-24 | Trademark clearance | Searches plus the core-team email | M0-09 | first public artefact | Runner-up name (Kewbench) |
| U-25 | Upstream fixes (coders51, stream client, cloudamqp EXTERNAL) | PRs opened in M1-08; status reviewed at each release | — | nothing | Keep the in-house adapters |
| U-26 | Market data | Survey after the beta; download counters | M1-59 | roadmap reprioritisation only | — |

Other spikes:
- S-08 (Windows pipe DACL) runs in M2-10.
- S-12 (QuickJS limits) runs in M2-07.
- S-13 (management API cost at 100k queues) runs in M0-48.
- S-14 (AG Grid infinite model at 100k rows) runs in M0-53.

## 6. Release checklist per milestone
**Every milestone** (gated on the release-please PR and the tag):
- [ ] A maintainer has reviewed the release PR: changelog, version, ADR links.
- [ ] Conformance:
  - Tier 1 (4.2.9, 4.3.6) and Tier 2 (3.13.7, 4.1.8) cells are all green.
  - 4.0.9 is recorded on a best-effort basis.
  - Nightly alpha runs have been reviewed.
  - The matrix is regenerated and published.
- [ ] Full CI on the tag:
  - unit, architecture, golden and contract suites;
  - e2e-web; e2e-desktop (full on Linux, smoke on macOS and Windows);
  - accessibility, bundle budgets, and performance (no regression above 15 %);
  - CodeQL and OSV clean.
  - Release-age exclusions have been reviewed.
- [ ] Desktop:
  - **macOS:** arm64 and x64 dmg/zip are signed, notarised and stapled. `codesign --verify --deep --strict`, `spctl --assess` and `xcrun stapler validate` pass.
  - **Windows:** the MSIX goes to the Store flight. NSIS/zip for x64 and arm64 are signed, and `latest.yml` and the blockmap are regenerated after signing.
  - **Linux:** deb/rpm for x64 and arm64 install the AppArmor profile; AppImage carries the documented caveat.
  - `fuse-check` passes on every artefact.
  - A fresh-VM install smoke passes on all three OSes: launch → connect to broker-lab → explorer, plus a receipt where applicable.
  - Update metadata is correct and the opt-in choice is respected.
- [ ] npm:
  - Published through trusted publishing with provenance, under the `alpha`, `beta` or `latest` dist-tag.
  - `npx <product>@x.y.z serve --no-open` passes a smoke test on Linux, macOS and Windows.
  - `npm audit signatures` passes.
- [ ] Docker:
  - Multi-arch image published by digest; `cosign verify` passes.
  - SBOM and provenance attestations are attached.
  - Trivy reports no CRITICAL.
  - Smoke with `docker run -p 127.0.0.1:8765:8765`, including the container-mode Host tests.
  - SIGTERM exits within 2 s.
- [ ] Helm (from M3):
  - `helm lint` passes.
  - `ct install` on kind passes under restricted PSS and readiness.
  - The values schema rejects invalid values.
  - The chart is signed with cosign and pushed as OCI.
- [ ] Per artefact: THIRD_PARTY_NOTICES and a CycloneDX SBOM, generated from the esbuild metafile, Angular stats and the electron-builder file list. Plus SHA256SUMS and build attestations.
- [ ] Draft release assets are verified, then the release is published as immutable. Docs are deployed. The outbound-calls page is unchanged, or has been reviewed.
- [ ] Within 24 h of release:
  - Install from every public channel: brew tap, winget, npx, docker pull, Store.
  - Have a rollback ready: move the npm dist-tag, revert the tap or winget manifest, repoint the image tag. Desktop rollback means shipping an N+1 patch, because releases are immutable.

**Milestone deltas**
| Milestone | Version and channels | Extra gates |
| --- | --- | --- |
| **M0 internal alpha** | 0.1.0-alpha.N. Channels: GitHub prerelease; npm `alpha` (under the codename if ADR-029 is still pending); GHCR; private Store flight. No tap or winget yet | - Matrix v0 published<br>- Amazon MQ + CloudAMQP probe run<br>- Licence, git-dependency and TS-pin gates proven by the self-test<br>- NSIS signing exception documented if Certum fails |
| **M2** | 1.x | - Parity checklist against the official UI 4.3.6<br>- Decoder fixture apps: MassTransit v8, Spring, NServiceBus, EasyNetQ, Celery<br>- 10k-replay chaos run with zero loss and zero duplicates<br>- Local MCP passes the SDK-oracle tests |
| **M3** | 2.0, plus the team image and OCI chart | - Helm on kind under restricted PSS<br>- Compose quickstart in under 10 min<br>- An RBAC test and an audit attempt/outcome test for every mutating API<br>- Audit verify and restore drill<br>- Keycloak 26 + Entra delegated OAuth<br>- SSRF suite<br>- Security review sign-off |
| **M4** | 2.x | - DC-56 rule fixtures per version<br>- Upgrade advisor validated on 4.2.9→4.3.6 labs, and on 4.4 within 14 days of GA<br>- Alert delivery E2E (Slack, Teams, email, webhook)<br>- Flathub + Snap |
| **M5** | 2.x | - /mcp audience tests (RFC 8707)<br>- Injection red-team corpus<br>- Zero outbound AI calls when no endpoint is configured |
| **M6** | 3.0 | - Plan/apply round trips on Terraform and Topology Operator fixtures<br>- HA replica-loss chaos with no duplicate publishes<br>- Node-agent zero-side-effect cells<br>- Foundation application |

## 7. Risk notes
- **Human review is the binding constraint.** trust:critical paths need CODEOWNERS sign-off, and lab evidence must be approved by a human.
- **Long-lead items** — accounts, certificates, trademark — start on day 1 in M0-09.
- **Tier-1 broker drift.** A new RabbitMQ patch release (for example 4.3.7) starts as 'unverified-patch'. Support is claimed only after it passes the conformance matrix.
- **Node and Electron upgrades.** Electron 45.0.x is adopted after GA plus a 7-day soak, as a reviewed exclusion. Node 26 runs nightly until the Electron line moves.
