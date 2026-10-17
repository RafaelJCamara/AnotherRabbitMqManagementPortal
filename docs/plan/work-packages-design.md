# Work packages (design phase, original ids)

> **Design-phase output (2026-10-16).** Amended by [`docs/plan/amendments.md`](../plan/amendments.md), which takes precedence, and re-sequenced web-first ([ADR-030](../adr/ADR-030-web-first-delivery-order.md), [`docs/product/milestones.md`](../product/milestones.md)). Content about a specific third-party product was removed under the docs policy ([ADR-034](../adr/ADR-034-docs-policy.md)).

> **ID map (web-first re-sequencing).** This is the design-phase execution plan; its WP ids are the original ones. Re-sequenced ids and GitHub issue links are in [`work-items.md`](work-items.md). Moved items: M0-18→M1-67, M0-19→M1-68, M0-34→M2-P01, M0-55→M2-P02, M0-56→M2-P03, M0-57→M2-P04, M0-58→M2-P05, M0-61→M2-P06, M0-67→M2-P07, M0-65→M2-P17, M0-66→M3-P01 + M4-P01; epics M2-01/02/04→M2-F01/F02/F03, M2-03/06/07→M3-F01/F02/F03, M2-05/08/09/10/11→M4-F01…F05, M3-xx→M5-xx, M4-xx→M6-xx, M5-xx→M7-xx, M6-xx→M8-xx.

### M0-01 Workspace scaffold: Nx 23.3 + pnpm 12.14 + TS 6.0.3 pin (includes S-11 toolchain proof)

- **Milestone (design):** M0 · **Wave:** M0-W0 · **Size:** S
- **Depends on:** -
- **Goal:** Create the integrated Nx workspace with exact pins and prove that Angular 22.2, the esbuild engine and Vitest 5 build together on 3 OSes.
- **Scope:** package.json, pnpm-workspace.yaml (catalog), nx.json, tsconfig.base.json, .nvmrc, LICENSE, NOTICE, README.md, .editorconfig, .gitattributes, apps/web (hello), apps/engine (hello), libs/shared/contracts (empty)
- **Interfaces:** Catalog pins (typescript 6.0.3, nx 23.3.0, @angular/* 22.2.3, vitest 5); packageManager pnpm@12.14.0; engines node >=24.15; @app/* path aliases
- **Acceptance criteria:**
  - Given a clean clone on Node 24.22 and pnpm 12.14, when pnpm install --frozen-lockfile runs, then it succeeds and pnpm why typescript lists only 6.0.3
  - Given the hello projects, when run-many build/test/typecheck runs on ubuntu-24.04, macos-15 and windows-2025, then web (esbuild builder) and engine (ESM bundle) build and tests pass
- **Verification:**
  - `pnpm install --frozen-lockfile`
  - `pnpm nx run-many -t build test typecheck`
  - `pnpm why typescript`

### M0-02 Supply-chain configuration and gates

- **Milestone (design):** M0 · **Wave:** M0-W0 · **Size:** M
- **Depends on:** M0-01
- **Goal:** Make the dependency policy mechanical: exact catalogs, release-age gate, licence allow-list, git/tarball ban, pins and bans, all proven by a self-test.
- **Scope:** pnpm-workspace.yaml (minimumReleaseAge 4320 strict, exact excludes, trustPolicy no-downgrade, blockExoticSubdeps, strictDepBuilds, allowBuilds), tools/supply-chain/{licence-gate,lockfile-gate,pin-gate,allowlist-gate}.ts, deps-allowlist.json, fixtures/, docs/adr/ADR-027-log.md
- **Interfaces:** Targets supply-chain:gates and supply-chain:gates-selftest; DC-50 licence allow-list (elkjs EPL-2.0 and CC-BY-4.0 assets as named exceptions)
- **Acceptance criteria:**
  - Given planted fixtures (git dependency, typescript@7, @types/amqplib, primeng@22, ag-grid-enterprise, apexcharts, npm oasdiff, a GPL package), when gates-selftest runs, then each one fails with its own rule id
  - Given the real lockfile, when gates run, then they pass; given a dependency missing from deps-allowlist.json, then the allow-list gate fails
- **Verification:**
  - `pnpm nx run supply-chain:gates`
  - `pnpm nx run supply-chain:gates-selftest`

### M0-03 Lint, format, module boundaries and third-party confinement

- **Milestone (design):** M0 · **Wave:** M0-W0 · **Size:** M
- **Depends on:** M0-01
- **Goal:** Encode the layer/runtime/trust tags, dependency rules and confinement table so that violations fail lint.
- **Scope:** eslint.config.mjs, .prettierrc, nx.json targetDefaults, tools/lint-selftest (planted violations)
- **Interfaces:** Tags type:*, runtime:*, trust:critical; @nx/enforce-module-boundaries depConstraints (blueprint 2.2); no-restricted-imports confinement (blueprint 2.4); banned imports
- **Acceptance criteria:**
  - Given a type:pure lib importing node:fs, or a ui-feature importing another ui-feature, when lint runs, then enforce-module-boundaries fails
  - Given amqplib imported outside adapter-amqp091 or apps/conformance, when lint runs, then the confinement rule fails
- **Verification:**
  - `pnpm nx run-many -t lint`
  - `pnpm nx test lint-selftest`

### M0-04 Custom ESLint rules

- **Milestone (design):** M0 · **Wave:** M0-W0 · **Size:** M
- **Depends on:** M0-03
- **Goal:** Ship the project-specific rules that guard I-3, I-6, DC-15, i18n and UI safety.
- **Scope:** tools/eslint-rules/src/rules/{no-broker-version-compare,no-mode-branching,bounded-buffers-only,honest-wording,no-inner-html,no-direct-fetch,explicit-zod-schemas,ui-no-raw-template-text}.ts + RuleTester specs; i18n JSON linting via @eslint/json
- **Interfaces:** Rule ids @app/<rule>; honest-wording allow-listed keys (stream browse, node agent)
- **Acceptance criteria:**
  - Given an en.json value 'non-destructive peek' outside allow-listed keys, when lint runs, then honest-wording fails
  - Given a semver comparison against '4.3.0' in libs/engine/svc-peek, when lint runs, then no-broker-version-compare fails, while the same code in libs/shared/semantics passes
- **Verification:**
  - `pnpm nx test eslint-rules`
  - `pnpm nx test lint-selftest`

### M0-05 CI skeleton

- **Milestone (design):** M0 · **Wave:** M0-W0 · **Size:** M
- **Depends on:** M0-02, M0-03
- **Goal:** Run gates and affected targets on every PR, with SHA-pinned actions and security scanning.
- **Scope:** .github/workflows/{ci,codeql,scorecard,pr-title,dco,dependency-review}.yml, .github/actions/setup, renovate.json, zizmor config, OSV-Scanner job
- **Interfaces:** Required checks: ci/gates, ci/affected, codeql, pr-title, dco
- **Acceptance criteria:**
  - Given a PR, when CI runs, then the supply-chain gates run before nx affected -t lint typecheck test build, and every action is pinned by a 40-character SHA (checked by a gate)
  - Given a PR titled 'update stuff', when pr-title runs, then it fails, while 'feat(engine): add probe' passes
- **Verification:**
  - `pnpm nx run supply-chain:actions-pinned`
  - `gh pr checks <pr> --watch`

### M0-06 Governance files, Conventional Commits, release-please and docs site skeleton

- **Milestone (design):** M0 · **Wave:** M0-W0 · **Size:** M
- **Depends on:** M0-01
- **Goal:** Publish the OSS governance files, a single-version release-please flow and a Starlight docs site carrying the ADRs.
- **Scope:** CONTRIBUTING.md (DCO, AI-assisted contribution policy), CODE_OF_CONDUCT.md, SECURITY.md, GOVERNANCE.md, TRADEMARKS.md, SUPPORT.md, ADOPTERS.md, .github/ISSUE_TEMPLATE/*, PULL_REQUEST_TEMPLATE.md, release-please-config.json, .release-please-manifest.json, .github/workflows/release-please.yml, apps/docs (Starlight + starlight-openapi), docs/adr/ADR-001..028.md
- **Interfaces:** One product SemVer (root '.', release-type node, prerelease-type alpha, extra-files for desktop/cli package.json and Chart.yaml); docs routes /adr, /matrix, /security/outbound-calls
- **Acceptance criteria:**
  - Given a merged feat commit, when release-please runs in dry-run, then it proposes an alpha prerelease and bumps every extra-file
  - Given the docs build, then every page footer carries the Broadcom attribution and the non-affiliation line, and the ADR index lists 28 ADRs
- **Verification:**
  - `pnpm exec release-please release-pr --repo-url=<org>/<repo> --dry-run`
  - `pnpm nx build docs`

### M0-07 Agent toolchain: AGENTS.md, CLAUDE.md, path rules, hooks, skills, spec template, CODEOWNERS

- **Milestone (design):** M0 · **Wave:** M0-W0 · **Size:** M
- **Depends on:** M0-04, M0-05
- **Goal:** Give every agent the same deterministic guard-rails and workflows.
- **Scope:** AGENTS.md, CLAUDE.md, .claude/settings.json, .claude/rules/{engine,ui,desktop,semantics,security,release}.md, .claude/skills/{wp-spec,review-wp,new-action,new-adapter,new-ui-feature,new-eslint-rule,new-lint-rule,new-decoder,new-semantics-cell,security-lane,release}/SKILL.md, tools/agent-hooks/{post-edit,on-stop,guard-paths,guard-bash}.mjs, docs/specs/_TEMPLATE.md, CODEOWNERS
- **Interfaces:** Hook protocol (stdin JSON tool_input.file_path; exit 2 surfaces stderr); protected-path list; the spec template
- **Acceptance criteria:**
  - Given a fixture Edit payload for a mis-formatted .ts file with a lint error, when post-edit runs, then the file is formatted and exit code 2 reports the remaining lint error
  - Given an Edit targeting testing/lab-evidence/**, when guard-paths runs, then it exits 2 with 'human-only path'; given failing affected tests, then on-stop exits 2 unless stop_hook_active is set; CLAUDE.md is under 200 lines and imports @AGENTS.md
- **Verification:**
  - `pnpm nx test agent-hooks`
  - `node tools/agent-hooks/post-edit.mjs < tools/agent-hooks/fixtures/edit.json`

### M0-08 Base Nx generators

- **Milestone (design):** M0 · **Wave:** M0-W0 · **Size:** M
- **Depends on:** M0-04
- **Goal:** Encode module templates so that agents scaffold instead of inventing structure.
- **Scope:** tools/generators/src/{library,service-module,adapter,ui-feature,eslint-rule,lint-rule,decoder,semantics-cell,conformance-cell,migration}/ + snapshot specs; README template (purpose, public API, invariants, proof commands)
- **Interfaces:** pnpm nx g @app/generators:<name> (tags + README per project)
- **Acceptance criteria:**
  - Given nx g @app/generators:service-module svc-demo, then files, tags (type:service, runtime:node) and README match snapshots, and the generated lib lints and tests clean
  - Given nx g @app/generators:adapter demo --port=DemoPort --confine=left-pad, then the confinement entry is added and lint rejects left-pad anywhere else
- **Verification:**
  - `pnpm nx test generators`

### M0-09 Governance (human-owned): name, trademark search, signing and provider accounts

- **Milestone (design):** M0 · **Wave:** M0-W0 · **Size:** S
- **Depends on:** -
- **Goal:** Start the long-lead human tasks on day 1 so that none of them blocks a release.
- **Scope:** docs/adr/ADR-029-product-name.md; accounts: Apple Developer, Microsoft Partner Center, npm org + trusted publishing, GHCR, Certum OSS certificate, SignPath (after the public beta), Amazon MQ + CloudAMQP test brokers, Keycloak 26 and Entra tenants; GitHub environments
- **Interfaces:** Protected environments: apple-notary, msstore, certum-signing, providers (required reviewers)
- **Acceptance criteria:**
  - Given USPTO/EUIPO/WIPO searches and the RabbitMQ core-team email, when ADR-029 merges, then the coined name (Sortyard; runner-up Kewbench) contains no 'rabbit' or 'rmq' and is used by M1 beta artefacts
  - Given the protected signing and providers environments, then M0-63, M0-66 and M0-67 can run with required-reviewer approval
- **Verification:**
  - `gh api repos/<org>/<repo>/environments --jq '.environments[].name'`
  - `test -f docs/adr/ADR-029-product-name.md`

### M0-10 Contracts kit and spec emitters

- **Milestone (design):** M0 · **Wave:** M0-W1 · **Size:** L
- **Depends on:** M0-08
- **Goal:** One zod registry for actions, topics, errors and frames that emits OpenAPI 3.1 and AsyncAPI 3.0 behind a diff gate (ADR-003).
- **Scope:** libs/shared/contracts/src/{kit/define-action,kit/define-topic,brands,object-key,errors,live-frames,port-frames,ctl-frames,bridge,config/*,emit/{openapi,asyncapi}}.ts; docs/api/{openapi,asyncapi}.v1.json; CI step running the digest-pinned oasdiff Go binary
- **Interfaces:** ActionDef, defineAction, TopicDef, defineTopic, InputOf/OutputOf, ObjectKey encode/decode, ErrorCode, Problem, ClientFrame/ServerFrame/PortFrame, CtlFrame, PlatformBridge v1
- **Acceptance criteria:**
  - Given a sample registry, when the kit invariants run, then each of these fails: a GET bound to kind:command, a path parameter missing from the input, and a mutating action without audit attempt+outcome
  - Given arbitrary vhost/name pairs including '/' and unicode, then decodeObjectKey(encodeObjectKey(x)) equals x (fast-check); given a new action without regenerated specs, then api-docs-check fails
- **Verification:**
  - `pnpm nx test contracts`
  - `pnpm nx run contracts:api-docs-check`

### M0-11 Domain model and semantics registry core (MSG-01 core)

- **Milestone (design):** M0 · **Wave:** M0-W1 · **Size:** L
- **Depends on:** M0-10
- **Goal:** Typed BrokerProfile and SemVer types, plus a fail-closed registry with the conservative era and verification resolver (DC-01/02/60).
- **Scope:** libs/shared/domain-model/src/{semver,version-range,broker-profile,ids}.ts; libs/shared/semantics/src/{schema,registry,era,doomed,warnings,gates,caps,tap-rules}.ts; target audit-cells
- **Interfaces:** BrokerProfile (schemaVersion 1), BrokerSemanticsRegistry, SemanticsCell, EraInputs, SemanticsGapError, Verification
- **Acceptance criteria:**
  - Given nodes [4.3.6,4.3.6] with rabbitmq_4.3.0 disabled, or [4.3.6,4.2.9], or any QQ member Machine Version below 8, when resolveEra runs, then era is 4.0-4.2 with conservative=true and a reason; given 4.2.10 (no public tag), then 4.0-4.2 and unknown-build; given 4.3.7, then 4.3 and unverified-patch
  - Given a key with no cell, when cell() runs, then SemanticsGapError is thrown; given isDoomed, then 4.3 DC=21 with L=20 is doomed, 4.0-4.2 x-delivery-count (=AC) 20 with L=20 is doomed, and an unlimited queue is never doomed
- **Verification:**
  - `pnpm nx run-many -t test -p domain-model semantics`
  - `pnpm nx run semantics:audit-cells`

### M0-12 Semantics data I: settle matrix, counters, DLX carry-over, delayed retry

- **Milestone (design):** M0 · **Wave:** M0-W1 · **Size:** M
- **Depends on:** M0-11
- **Goal:** Encode fact sheet b.1, b.2, b.4 and b.5 as code-derived cells with citations and conformance ids.
- **Scope:** libs/shared/semantics/src/data/{settle-matrix,counters,dlx-carryover,delayed-retry}.data.ts
- **Interfaces:** SemanticsCell[] (status code-derived); reserves CF-SETTLE-*, CF-DOWN-*, CF-CARRY-*, CF-DR-*, CF-STAMP-* ids for M0-38..40
- **Acceptance criteria:**
  - Given every b.2 action x era x queue type, when audit-cells runs, then each has a cell with at least one RS@tag citation and at least one CF id
  - Given cell(4.0-4.2, quorum, amqp091, nack_requeue, finite), then deltaAC=1, countsTowardLimit=yes, position=head; given cell(3.13, quorum, amqp10, modified_df_false), then destructive=true
- **Verification:**
  - `pnpm nx run semantics:audit-cells --require=citations,conformance`
  - `pnpm nx test semantics`

### M0-13 Semantics data II: hazards, capabilities, warnings, peek caps, tap rules, provider presets

- **Milestone (design):** M0 · **Wave:** M0-W1 · **Size:** M
- **Depends on:** M0-11
- **Goal:** Turn the known-bug table, the DC-32 predicates and the W-* registry into data, not code.
- **Scope:** libs/shared/semantics/src/data/{hazards,capabilities,warnings,peek-caps,tap-rules,provider-presets}.data.ts; i18n/en/warnings.json (versioned texts)
- **Interfaces:** hazards(profile); capability predicates (e.g. channelsAcceptDisableStats); WarningRef for the 16 W-* ids; peekCaps; tapRule
- **Acceptance criteria:**
  - Given 4.3.5 with stats off, when hazards() runs, then it includes channels-400-stats-off and the predicate forbids disable_stats on /api/channels; given 4.3.6, it does not
  - Given tapRule('x-consistent-hash', 4.3.4), then diverts=true and e2eAllowed=false; given peekCaps(4.0-4.2, quorum, admin, verified), then def=20 and max=200
- **Verification:**
  - `pnpm nx test semantics`

### M0-14 Broker-lab images and Testcontainers helpers

- **Milestone (design):** M0 · **Wave:** M0-W1 · **Size:** M
- **Depends on:** M0-05
- **Goal:** Reproducible broker images for 3.13.7 to 4.3.6, plus alphas and TLS/OAuth/3-node variants, exposing 5552 and 15692.
- **Scope:** testing/broker-lab/{Dockerfile (ARG VERSION; digest-pinned rabbitmq:<v>-management), enabled_plugins, rabbitmq.conf, tls/, compose.3node.yaml (+HAProxy, toxiproxy)}; libs/testkit/src/broker-lab.ts; project broker-lab (build, verify)
- **Interfaces:** startBroker({version, variant: plain|tls|oauth, nodes: 1|3}) returning {amqp, amqps, http, stream, prometheus, digest}
- **Acceptance criteria:**
  - Given each version, when broker-lab:verify runs, then 5672, 15672, 5552 and 15692 respond and /api/overview rabbitmq_version equals the tag
  - Given the enabled plugins, then /api/extensions lists shovel, federation, stream and tracing, and the consistent-hash and event exchanges exist
- **Verification:**
  - `pnpm nx run broker-lab:verify --versions=3.13.7,4.0.9,4.1.8,4.2.9,4.3.6`

### M0-15 Lab driver and evidence recorder (conformance:record)

- **Milestone (design):** M0 · **Wave:** M0-W1 · **Size:** M
- **Depends on:** M0-14, M0-10
- **Goal:** A raw protocol driver that can perform every settle path, including forbidden ones, and records evidence independently of the registry (ADR-007).
- **Scope:** apps/conformance/src/{driver/amqp091-raw.ts (amqplib), driver/amqp10-raw.ts (rhea), driver/http-raw.ts, dsl.ts, record.ts}; testing/lab-evidence/schema.json; documented confinement exception for apps/conformance
- **Interfaces:** LabScenario DSL (declare, publish, get/consume, settle, observe); EvidenceArtefact {cfId, brokerVersion, imageDigest, steps, observations: x-delivery-count, x-acquired-count, redelivered, position, survived}
- **Acceptance criteria:**
  - Given CF-SMOKE-01 (CQ get + nack requeue) on 4.3.6, when conformance:record runs, then testing/lab-evidence/4.3.6/CF-SMOKE-01.json shows redelivered=true at position 0
  - Given the arch test, then apps/conformance/src/record imports nothing from @app/semantics, and the driver refuses any endpoint that broker-lab did not create
- **Verification:**
  - `pnpm nx run conformance:record --cells=CF-SMOKE-01 --versions=4.3.6`
  - `pnpm nx test conformance`

### M0-16 Kernel primitives

- **Milestone (design):** M0 · **Wave:** M0-W1 · **Size:** M
- **Depends on:** M0-10
- **Goal:** Config loading, a redacting logger, ids and clock, Problem mapping and bounded buffers, shared by every engine module.
- **Scope:** libs/engine/kernel/src/{config,log,clock,ids,problem,bounded}/
- **Interfaces:** loadConfig(schema) (precedence env > *_FILE > file > defaults; unknown keys rejected); pino 10.4.0 logger with path and value redaction; toProblem(err); BoundedRing/BoundedQueue {items, bytes, dropped}
- **Acceptance criteria:**
  - Given log lines containing amqps://u:p@h, a Bearer JWT, a JWT inside an x- header and a shovel URI, when logged, then the output contains none of the canary secrets
  - Given a BoundedRing of 3 items or 1 KiB, when 5 items arrive, then the 2 oldest are dropped and dropped=2 is reported
- **Verification:**
  - `pnpm nx test kernel`

### M0-17 Live protocol state machines (pure)

- **Milestone (design):** M0 · **Wave:** M0-W1 · **Size:** M
- **Depends on:** M0-10
- **Goal:** Credit flow, per-topic QoS outboxes, gap and resume as a pure, model-tested library (ADR-005).
- **Scope:** libs/shared/live-protocol/src/{session,outbox,credits,resume}.ts
- **Interfaces:** Outbox<qos> with item and byte bounds; SessionLimits {maxSubs 64, outbox 8 MiB, frame 1 MiB}
- **Acceptance criteria:**
  - Given random command sequences (fast-check), when a lossless outbox overflows, then a gap followed by a snapshot is emitted and nothing is dropped silently
  - Given a latest topic at maxHz 4 receiving 100 updates for one key in 1 s, then at most 4 frames carry the newest value, and credits never go negative
- **Verification:**
  - `pnpm nx test live-protocol`

### M0-18 Spike S-01/S-02/S-03: MessagePort tunnel, utilityProcess cold start, node:sqlite in Electron

- **Milestone (design):** M0 · **Wave:** M0-W1 · **Size:** M
- **Depends on:** M0-01
- **Goal:** Measure the desktop transport and runtime assumptions on all three OSes before building them (U-16).
- **Scope:** spikes/desktop-runtime/ (throwaway); .github/workflows/spike.yml (ubuntu-24.04, windows-2025, macos-15, macos-15-intel); ADR-002 and ADR-013 addenda with the numbers
- **Interfaces:** Decision records: ESM vs CJS engine bundle; engine-link worker yes/no; node:sqlite vs better-sqlite3 fallback
- **Acceptance criteria:**
  - Given Electron 44.8 and an ESM engine bundle forked as a utilityProcess, then ready is reported within 600 ms p95 on each OS, or the CJS fallback decision is recorded
  - Given 10,000 requests of 4 KiB and one 16 MiB response over MessagePort + fastify.inject, then overhead p95 is at most 2 ms with no renderer long task above 50 ms, and FTS5 works inside the utilityProcess
- **Verification:**
  - `gh workflow run spike.yml -f spike=desktop-runtime`
  - `pnpm nx run spikes:desktop-runtime-report`

### M0-19 Spike S-07/S-10: Electron crypto/TLS and Windows packaging/signing

- **Milestone (design):** M0 · **Wave:** M0-W1 · **Size:** M
- **Depends on:** M0-01
- **Goal:** Prove key wrapping, system CAs and the MSIX/NSIS signing flows before the vault and release work starts (U-16, U-21).
- **Scope:** spikes/desktop-platform/; test signing certificates; ADR-014 and ADR-026 addenda
- **Interfaces:** Decision records: argon2 vs scrypt; Linux backend matrix; Certum CI signing yes/no; MSIX + utilityProcess viability
- **Acceptance criteria:**
  - Given Electron's Node (BoringSSL), when tls.getCACertificates('system'), setDefaultCACertificates, PKCS#12 client certs, crypto.argon2 and safeStorage async are exercised on 3 OSes (plus Linux gnome-libsecret, kwallet6 and basic_text), then each result is recorded with a fallback
  - Given an MSIX built by electron-builder 26.17.0 and installed on windows-2025 with a test certificate, then the utilityProcess engine starts; given a two-pass signed NSIS, then the regenerated latest.yml sha512 matches
- **Verification:**
  - `gh workflow run spike.yml -f spike=desktop-platform`

### M0-20 Spike S-04: CSP and Trusted Types with AG Grid, Monaco and ELK under app://

- **Milestone (design):** M0 · **Wave:** M0-W1 · **Size:** S
- **Depends on:** M0-01
- **Goal:** Decide between enforced and report-only Trusted Types, and fix the worker/CSP recipe for the heavy UI libraries.
- **Scope:** spikes/csp/ (Angular app with the three libraries in Electron app:// and in Chromium over http); ADR-021 addendum
- **Interfaces:** Final CSP string and Trusted Types policy-name allow-list
- **Acceptance criteria:**
  - Given the blueprint CSP with require-trusted-types-for 'script', when AG Grid Community 36.2, Monaco 0.57 ESM workers and the unmodified elk-worker.min.js load, then there are zero CSP violations, or the report-only fallback and policy names are recorded
- **Verification:**
  - `pnpm nx e2e spikes-csp`

### M0-21 Persistence foundation

- **Milestone (design):** M0 · **Wave:** M0-W2 · **Size:** M
- **Depends on:** M0-16
- **Goal:** Kysely over an in-repo node:sqlite dialect and over pg, with one migration set, backup before migrating and refusal of a newer schema (ADR-013).
- **Scope:** libs/engine/persistence/src/{dialects/node-sqlite,dialects/pg,migrate/{helpers,runner},migrations/0001_core,repos/*}.ts
- **Interfaces:** Async repository ports; dialect helpers t.id/json/epochMs/bytes; MigrationRunner {backup, apply, refuseNewer}
- **Acceptance criteria:**
  - Given empty SQLite and Postgres 16 and 18 (Testcontainers), when migrations apply, then both reach the same schema version and the repository tests pass on both
  - Given a database stamped with a newer schema, when the engine starts, then it refuses with a Problem; given a desktop migration, then a VACUUM INTO backup exists first
- **Verification:**
  - `pnpm nx run persistence:it --dialects=sqlite,pg`

### M0-22 Secrets and field crypto

- **Milestone (design):** M0 · **Wave:** M0-W2 · **Size:** M
- **Depends on:** M0-16, M0-21, M0-19
- **Goal:** AES-256-GCM field encryption with AAD and pluggable data-key wraps (DC-45, ADR-014).
- **Scope:** libs/engine/secrets/src/{field-crypto,dek,wraps/{passphrase,keyring,ctl-delivered,file-kek}}.ts; migration 0002_data_keys
- **Interfaces:** FieldCipher {seal(table,column,rowId,plain), open(...)}; KeyWrap port; requiresMasterPassword(); write-only secret contract fields
- **Acceptance criteria:**
  - Given a ciphertext moved to another row or column, when opened, then AAD verification fails
  - Given a Linux keyring backend reporting basic_text or none, when the vault initialises, then requiresMasterPassword=true and no DEK is ever stored unwrapped
- **Verification:**
  - `pnpm nx test secrets`

### M0-23 Ports and BrokerScheduler

- **Milestone (design):** M0 · **Wave:** M0-W2 · **Size:** M
- **Depends on:** M0-10, M0-11, M0-16
- **Goal:** Read/Write-split ports and role-typed leases with proofs, plus the scheduler that is the only path to management and Prometheus HTTP (I-8, ADR-009).
- **Scope:** libs/engine/ports/src/{mgmt,amqp091,amqp10,dialer,connection-manager,repos}.ts; libs/engine/kernel/src/scheduler/broker-scheduler.ts
- **Interfaces:** MgmtReadPort/MgmtWritePort, PeekLease, SourceLease, PublishLease, ObserveLease, settlement proofs, Amqp10Receiver, DialerPort, ConnectionManager; BrokerScheduler lanes interactive > live > background
- **Acceptance criteria:**
  - Given 10 queued background requests and 1 interactive request for one broker, then the interactive one runs first and at most one background request is in flight
  - Given two identical detail GETs within 2 s, then one HTTP call is made; given three consecutive 503s, then the background interval doubles (AIMD)
- **Verification:**
  - `pnpm nx test ports`
  - `pnpm nx test kernel --testNamePattern=scheduler`

### M0-24 adapter-mgmt-http core (PLAT-04)

- **Milestone (design):** M0 · **Wave:** M0-W2 · **Size:** L
- **Depends on:** M0-23, M0-13
- **Goal:** In-house undici + zod management client with paging, columns, stats flags, the bug table and product awareness (DC-32/48/55).
- **Scope:** libs/engine/adapter-mgmt-http/src/{client,paging,query,errors,product}.ts and endpoints/*.ts (overview, whoami, extensions, nodes, feature-flags, deprecated-features, queues, exchanges, bindings, connections, channels, consumers, policies, operator-policies, vhosts, users, permissions, health checks, definitions)
- **Interfaces:** Implements MgmtReadPort/MgmtWritePort; status-to-ErrorCode map (401 variants, 404, 405 'Broker settings disallow', 503, timeout)
- **Acceptance criteria:**
  - Given a stats-off 4.3.5 profile, when /api/channels is requested, then disable_stats is never sent; given page_size 1000, then it is clamped to 500 and columns= is set
  - Given a 405 'Broker settings disallow' body, then the Problem is FORBIDDEN_BROKER with a provider-restriction gate; given LavinMQ, then /get bodies always carry an explicit ackmode and requeue:true
- **Verification:**
  - `pnpm nx test adapter-mgmt-http`

### M0-25 Golden fixtures (management + Prometheus) per broker version

- **Milestone (design):** M0 · **Wave:** M0-W2 · **Size:** M
- **Depends on:** M0-24, M0-14
- **Goal:** Record and parse real responses for 5 versions (stats on and off) and LavinMQ 2.10.2, with a nightly refresh-diff (U-13 part).
- **Scope:** testing/fixtures/{mgmt,prometheus}/<version>/; adapter-mgmt-http targets record-golden and test-golden; .github/workflows/golden-refresh.yml (opens a PR on any diff)
- **Interfaces:** Fixture manifest (version, image digest, stats mode, seed definitions)
- **Acceptance criteria:**
  - Given fixtures for 3.13.7, 4.0.9, 4.1.8, 4.2.9, 4.3.6 and LavinMQ 2.10.2, when test-golden runs, then every endpoint schema parses (passthrough) and the recorded LavinMQ deviations are asserted
  - Given stats-off fixtures from 4.1.8, then the missing policy and delivery_limit fields are tolerated and flagged by the hazard table
- **Verification:**
  - `pnpm nx run adapter-mgmt-http:test-golden`
  - `pnpm nx run adapter-mgmt-http:record-golden --versions=4.3.6 --check`

### M0-26 net-dialer (direct + TLS) and net-truststore

- **Milestone (design):** M0 · **Wave:** M0-W2 · **Size:** M
- **Depends on:** M0-16, M0-19
- **Goal:** The single socket path (I-9) with trust configured in code (DC-43/44). Tunnels and the SSRF policy land later.
- **Scope:** libs/engine/net-dialer/src/{dialer,undici-connector,policy-hook}.ts; libs/engine/net-truststore/src/{truststore,diagnostics}.ts
- **Interfaces:** DialerPort.check/connect/forwarder (route 'direct'); TrustStore {defaults (bundled + system + org), forProfile(ca[]) concatenated, servername, insecure}; CertDiagnostics
- **Acceptance criteria:**
  - Given the broker-lab TLS variant with a private CA imported into a profile, when connecting by IP with a servername override, then the handshake verifies and a public HTTPS endpoint still verifies against system CAs
  - Given insecure=true, then the connection succeeds and the profile records tls.insecureOverride=true
- **Verification:**
  - `pnpm nx test net-truststore`
  - `pnpm nx run net-dialer:it --versions=4.3.6`

### M0-27 adapter-amqp091 with role-typed leases and proofs

- **Milestone (design):** M0 · **Wave:** M0-W2 · **Size:** L
- **Depends on:** M0-23, M0-26
- **Goal:** amqplib 2.2.0 behind Amqp091 ports in which forbidden settle paths cannot be expressed (DC-03/04/11, ADR-009).
- **Scope:** libs/engine/adapter-amqp091/src/{connect,leases/{control,peek,source,publish,observe},proofs,headers,errors,blocked}.ts
- **Interfaces:** PeekLease.get/nackRequeue/qosBarrier/ackWithProof/throwaway/release; PublishLease (confirm + mandatory); TypedHeaderValue; connection_name format
- **Acceptance criteria:**
  - Given the type tests, then peekLease.reject(...) and nackRequeue with requeue:false do not compile, and ackWithProof requires a ConfirmedCopyProof or a DestructiveConsentProof
  - Given 4.3.6, when get x3, then nackRequeue(last, multiple), then qosBarrier, then the barrier resolves only after qos-ok and the messages are ready again; given a cached stream type, then get throws before sending
- **Verification:**
  - `pnpm nx test adapter-amqp091`
  - `pnpm nx run adapter-amqp091:it --versions=4.2.9,4.3.6`

### M0-28 AMQP 0-9-1 dual-library contract suite

- **Milestone (design):** M0 · **Wave:** M0-W2 · **Size:** M
- **Depends on:** M0-27, M0-14
- **Goal:** Keep amqplib replaceable (bus factor about 1) by running one contract suite against amqplib and @cloudamqp/amqp-client (DC-48, U-17 part).
- **Scope:** libs/engine/adapter-amqp091/contract/*.spec.ts; test-only @cloudamqp/amqp-client 4.1.1 shim; cell for nack after a server-initiated basic.cancel
- **Interfaces:** Amqp091 contract: get, nack(multiple), qos barrier, confirms, mandatory returns, blocked/unblocked, server cancel
- **Acceptance criteria:**
  - Given 5 broker versions, when the contract suite runs, then both libraries pass, with EXTERNAL recorded as an expected skip for @cloudamqp/amqp-client
  - Given a server-initiated consumer cancel, then the adapter surfaces it as an event, and whether pending deliveries can still be nacked is recorded as evidence
- **Verification:**
  - `pnpm nx run adapter-amqp091:contract --broker=all`

### M0-29 ActionExecutor, PlanStore and implementAction

- **Milestone (design):** M0 · **Wave:** M0-W2 · **Size:** L
- **Depends on:** M0-11, M0-16, M0-21
- **Goal:** The single fail-closed pipeline for every mutation and message touch (ADR-006, DC-40/42).
- **Scope:** libs/engine/kernel/src/actions/{executor,plan-store,implement-action,principal,idempotency,authorizer}.ts; migration 0003_plans; tools/arch-tests (WritePort funnel, plan-purity harness)
- **Interfaces:** ActionExecutor.run/plan/approve/execute/state; implementAction; Plan (TTL 5 min, or 24 h awaiting approval); Authorizer port (desktop and local: allow); PayloadCipher port
- **Acceptance criteria:**
  - Given an unknown action, a missing idempotencyKey, an expired plan or an approval by the requester, when executed, then each is refused with its ErrorCode and execute() is never called
  - Given a planning:required action called directly, then 428 PLAN_REQUIRED returns the auto-created plan; given revalidate drift, then 409 PLAN_STALE; plan() of every registered action passes against WritePorts that throw
- **Verification:**
  - `pnpm nx test kernel --testNamePattern=executor`
  - `pnpm nx test arch-tests`

### M0-30 Audit chain, receipts store and local guardrails (prod lock)

- **Milestone (design):** M0 · **Wave:** M0-W2 · **Size:** M
- **Depends on:** M0-29
- **Goal:** Hash-chained attempt/outcome audit, receipts, and the prod lock: an unset environment class means prod, and peeks count as mutations (CON-02 engine).
- **Scope:** libs/engine/kernel/src/{audit/chain,receipts/store,guardrails/policy}.ts; migration 0004_audit_receipts; actions ops.arm and ops.disarm
- **Interfaces:** AuditSink.attempt/outcome; ReceiptStore; GuardrailDecision; arm (15 min, audited)
- **Acceptance criteria:**
  - Given the audit attempt write fails, when any command runs, then it is denied and execute() is not called; given a tampered audit row, then audit verify reports the first broken seq
  - Given a PROD or unset profile that is not armed, when a command or peek is planned, then GATE_BLOCKED 'prod-lock'; after arming, mutations are allowed for 15 min and every arm and disarm is audited
- **Verification:**
  - `pnpm nx test kernel --testNamePattern='audit|guardrail'`

### M0-31 JobRunner, JobStore and DrainCoordinator

- **Milestone (design):** M0 · **Wave:** M0-W2 · **Size:** M
- **Depends on:** M0-29
- **Goal:** Durable jobs with checkpoints, and the budgeted drain used on quit, suspend and SIGTERM (DC-04/46, ADR-015).
- **Scope:** libs/engine/jobs/src/{runner,store-sqlite,store-pg,token-bucket}.ts; libs/engine/kernel/src/drain/drain-coordinator.ts; migration 0005_jobs
- **Interfaces:** JobDef/JobRunner/JobStore; DrainCoordinator.drain(reason, totalMs) with phases gate, peeks, sources-jobs, taps-firehose, flush
- **Acceptance criteria:**
  - Given a running job, when drain('shutdown', 2000) runs, then onDrain is called within the phase-3 budget, the job becomes paused-interrupted, and the DB is flushed even if a phase overruns
  - Given the pg store, when two runners claim concurrently, then no job is claimed twice (SKIP LOCKED), and a lease expires after 30 s without a heartbeat
- **Verification:**
  - `pnpm nx test jobs`
  - `pnpm nx run jobs:it --dialects=sqlite,pg`
  - `pnpm nx test kernel --testNamePattern=drain`

### M0-32 Transport: Fastify router, auth hooks, request guards, static UI

- **Milestone (design):** M0 · **Wave:** M0-W2 · **Size:** M
- **Depends on:** M0-29
- **Goal:** Derive routes from the action registry on Fastify 5.12.7, within the kit capped at 800 LOC (ADR-004).
- **Scope:** libs/engine/transport/src/{app,router,problem-handler,auth/{local-token,carrier},guards/{host-origin,sec-fetch,json-only},static-ui}.ts; target kit-loc
- **Interfaces:** buildApp(registry, executor, auth); carrier header x-<product>-carrier; static UI with a CSP nonce and N and N-1 asset directories
- **Acceptance criteria:**
  - Given an action bound to POST /connections/{cid}/probe, then the route exists, GET returns 405 and invalid input returns a 400 Problem
  - Given a TCP request carrying the carrier header, a foreign Origin, a Host not on the allow-list, or Sec-Fetch-Site cross-site, then each is rejected; the kit stays at or below 800 LOC
- **Verification:**
  - `pnpm nx test transport`
  - `pnpm nx run transport:kit-loc`

### M0-33 Live hub, WebSocket endpoint and tickets

- **Milestone (design):** M0 · **Wave:** M0-W2 · **Size:** M
- **Depends on:** M0-32, M0-17
- **Goal:** One credit-based live session per UI over WebSocket, with the same semantics as the MessagePort carrier.
- **Scope:** libs/engine/live/src/{hub,session,topic-registry}.ts; libs/engine/transport/src/ws/{upgrade,tickets}.ts
- **Interfaces:** POST /api/v1/live/tickets (single use, 30 s, bound to the principal); Sec-WebSocket-Protocol app.v1 + app.ticket.<t>; welcome {engineVersion, limits}
- **Acceptance criteria:**
  - Given a reused or expired ticket, when upgrading, then the handshake is refused; given a client that stops granting credit, then the outbox bound holds and lossless topics emit gap then snapshot
  - Given a dropped transport, when hello with resume arrives within 30 s, then lossless subscriptions resume from their seq
- **Verification:**
  - `pnpm nx run transport:it --testNamePattern=live`

### M0-34 PortSessionServer (MessagePort inject tunnel)

- **Milestone (design):** M0 · **Wave:** M0-W2 · **Size:** M
- **Depends on:** M0-32, M0-33, M0-18
- **Goal:** Tunnel the same router over a MessagePort with header hygiene, a carrier secret and chunked streaming (ADR-002, DC-35).
- **Scope:** libs/engine/transport/src/port/{port-session-server,hygiene}.ts; perf bench messageport-p95
- **Interfaces:** PortSessionServer.attach(port, windowId); PortFrame http.req/res/chunk/abort and live frames
- **Acceptance criteria:**
  - Given a renderer request carrying Authorization, Cookie, Host and x-forwarded-* headers, when tunnelled, then those headers are stripped and the principal is desktop-user
  - Given a 16 MiB response, then it streams as http.chunk frames of at most 1 MiB ending with last=true; given http.abort, then the handler's AbortSignal fires
- **Verification:**
  - `pnpm nx test transport --testNamePattern=port`
  - `pnpm nx run perf:messageport-p95`

### M0-35 Action, topic and job generators with golden-path examples

- **Milestone (design):** M0 · **Wave:** M0-W2 · **Size:** M
- **Depends on:** M0-08, M0-29, M0-32
- **Goal:** Make adding an endpoint a one-command, test-first operation.
- **Scope:** tools/generators/src/{action,topic,job}/; libs/testkit/src/{create-test-engine,fakes}.ts; docs/golden-path/{explorer.queues.list,queues.purge,tap.messages}.md
- **Interfaces:** nx g @app/generators:action <id> --module --kind --http --permission --risk --planning --mcp --cli; createTestEngine().inject
- **Acceptance criteria:**
  - Given the action generator, then it creates the contract, an implementAction stub (NotImplemented), the registration, a unit spec (plan purity, deny-by-default, audit attempt/outcome), an HTTP spec and a UI command stub, and the generated tests fail until implemented
  - Given a generated action implemented per the golden path, then lint, typecheck, test and api-docs-check all pass
- **Verification:**
  - `pnpm nx test generators --testNamePattern=action`

### M0-36 Engine composition root, modes and esbuild bundle

- **Milestone (design):** M0 · **Wave:** M0-W2 · **Size:** M
- **Depends on:** M0-30, M0-31, M0-34, M0-22, M0-26
- **Goal:** One dist/engine/main.mjs (plus metafile) that boots the desktop and local modes through compose-core (ADR-001).
- **Scope:** apps/engine/src/{main,compose-core,modules}.ts; modes/{desktop,local,team}.ts (team refuses to start until M3); esbuild config; target smoke
- **Interfaces:** node main.mjs --mode=desktop|local; startup order: data-dir lock, backup + migrate, TrustStore, reconciliation stubs, then ready {contract, schemaHash}
- **Acceptance criteria:**
  - Given --mode=local --port=0, when started, then /healthz is green within 1 s, and a second engine on the same data directory refuses with a lock error
  - Given the bundle, then no-mode-branching passes (mode logic lives only in modes/*) and the metafile lists every bundled package
- **Verification:**
  - `pnpm nx build engine`
  - `pnpm nx run engine:smoke`

### M0-37 Three-way conformance harness, semantics-evidence check, coverage gate

- **Milestone (design):** M0 · **Wave:** M0-W2 · **Size:** M
- **Depends on:** M0-15, M0-12
- **Goal:** Break the registry-test circle: the live run, the recorded evidence and the registry cell must agree, and a status flips only with evidence (I-14).
- **Scope:** apps/conformance/src/assert/three-way.ts; target conformance:test (--versions, --grep, --shard); tools/semantics-evidence (check on the PR diff); CODEOWNERS label lab-evidence
- **Interfaces:** CellResult {cellId, cfId, version, live, evidence, registry, verdict: pass|fail|unverified}
- **Acceptance criteria:**
  - Given a PR changing a cell's effect or status without a matching evidence artefact, when semantics-evidence:check runs, then it fails; given a cell without a CF id, then audit-cells fails
  - Given a live run that differs from the recorded evidence, when conformance:test runs, then it fails with a field-level diff
- **Verification:**
  - `pnpm nx run semantics-evidence:check --base=origin/main`
  - `pnpm nx run conformance:test --grep=CF-SMOKE --versions=4.3.6`

### M0-38 Lab cells: CQ and QQ nack, reject, released, modified per era (U-01)

- **Milestone (design):** M0 · **Wave:** M0-W2 · **Size:** L
- **Depends on:** M0-37
- **Goal:** Measure the return-path cells: x-delivery-count = AC on 4.0-4.2 (get and consume paths), TAIL on 3.13 unlimited and on 4.0-4.2 with L=-1, and the 3.13 x-delivery-limit=-1 drop.
- **Scope:** apps/conformance/src/cells/settle/*.cell.ts; testing/lab-evidence/<version>/CF-SETTLE-*.json (recorded, human-approved)
- **Interfaces:** CF-SETTLE-* ids reserved by M0-12
- **Acceptance criteria:**
  - Given each CF-SETTLE cell on 3.13.7, 4.0.9, 4.1.8, 4.2.9 and 4.3.6, when recorded and tested, then live, evidence and registry agree, or the cell is marked lab-contradicted and a registry-fix PR is opened for human review
  - Given a 3.13.7 QQ with x-delivery-limit=-1, when nacked once, then the evidence records the drop (DC-16)
- **Verification:**
  - `pnpm nx run conformance:record --cells='CF-SETTLE-*' --versions=3.13.7,4.0.9,4.1.8,4.2.9,4.3.6`
  - `pnpm nx run conformance:test --grep=CF-SETTLE --versions=3.13.7,4.0.9,4.1.8,4.2.9,4.3.6`

### M0-39 Lab cells: DOWN paths: close, cancel-then-close, TCP loss, detach, consumer timeout (U-01 priority 1)

- **Milestone (design):** M0 · **Wave:** M0-W2 · **Size:** M
- **Depends on:** M0-37
- **Goal:** Measure whether a graceful close and cancel-then-close count as failed deliveries on 4.3, and what the 4.0-4.2 and 3.13 equivalents do.
- **Scope:** apps/conformance/src/cells/down/*.cell.ts (toxiproxy for TCP loss); evidence CF-DOWN-*
- **Interfaces:** CF-DOWN-* ids
- **Acceptance criteria:**
  - Given 4.3.6, when a channel closes while holding a QQ delivery, then the evidence records the DC and AC deltas and the registry cell is confirmed or contradicted
  - Given each version, then every CF-DOWN cell is three-way green or flagged for human review
- **Verification:**
  - `pnpm nx run conformance:test --grep=CF-DOWN --versions=3.13.7,4.0.9,4.1.8,4.2.9,4.3.6`

### M0-40 Lab cells: DLX carry-over, delayed retry, header stamping (U-01 priority 4, U-05)

- **Milestone (design):** M0 · **Wave:** M0-W2 · **Size:** M
- **Depends on:** M0-37
- **Goal:** Measure 4.3 DC carry-over into QQ DLQs (at-most-once and at-least-once; CQ and QQ sources), delayed-retry visibility, and whether a copied x-delivery-count survives.
- **Scope:** apps/conformance/src/cells/{carryover,delayed-retry,stamping}/*.cell.ts; evidence CF-CARRY-*, CF-DR-*, CF-STAMP-*
- **Interfaces:** CF-CARRY-*, CF-DR-*, CF-STAMP-* ids
- **Acceptance criteria:**
  - Given a message dead-lettered at L+1 into a default-L QQ DLQ on 4.3.6, when nacked once, then the evidence shows the drop or re-dead-letter; on 4.2.9 it shows a fresh budget
  - Given x-delayed-retry-type all with min 5000 on 4.3.6, when nack-peeked, then the invisibility window and messages_delayed/next_delayed_at are recorded
- **Verification:**
  - `pnpm nx run conformance:test --grep='CF-CARRY|CF-DR|CF-STAMP' --versions=3.13.7,4.0.9,4.1.8,4.2.9,4.3.6`

### M0-41 Lab cells: operational hazards: SAC, exclusive, stream get, passive declare, vhost PUT, machine version (U-02, U-09)

- **Milestone (design):** M0 · **Wave:** M0-W2 · **Size:** L
- **Depends on:** M0-37, M0-13
- **Goal:** Measure the gating facts that the probe, peek planner and admin writes rely on.
- **Scope:** apps/conformance/src/cells/ops/*.cell.ts: QQ+SAC get 405; CQ+SAC get bypass; exclusive 405; stream basic.get 540; passive-declare permissions per version; vhost PUT without default_queue_type; QQ status Machine Version; 3-node rolling upgrade 4.2.9 to 4.3.6 with rabbitmq_4.3.0 off and on
- **Interfaces:** CF-OPS-* ids
- **Acceptance criteria:**
  - Given 4.1.8, 4.2.9 and 4.3.6, when a vhost with default queue type quorum is PUT without default_queue_type, then the evidence records the reset (DC-21), and the GET-merge-PUT cell keeps quorum
  - Given a 4.2.9 to 4.3.6 rolling upgrade with the flag disabled, then the status Machine Version and a canary QQ result are recorded, and resolveEra stays at 4.0-4.2
- **Verification:**
  - `pnpm nx run conformance:test --grep=CF-OPS --versions=3.13.7,4.0.9,4.1.8,4.2.9,4.3.6`

### M0-42 Conformance CI workflows

- **Milestone (design):** M0 · **Wave:** M0-W2 · **Size:** M
- **Depends on:** M0-37, M0-14, M0-05
- **Goal:** Run the matrix on every PR (sharded) and nightly across runtimes and alphas, with mutation testing of the registry.
- **Scope:** .github/workflows/{conformance-pr,conformance-nightly,mutation-nightly}.yml; Stryker config for semantics and the harness
- **Interfaces:** Required check 'conformance' when affected; nightly runs Node 26.12, Electron's Node (ELECTRON_RUN_AS_NODE on the test-fused binary) and alphas that may fail and feed the 'unverified' state
- **Acceptance criteria:**
  - Given a PR touching semantics, adapters or conformance, then 5 versions run on Node 24.22 in shards and block the merge on failure
  - Given the nightly registry mutants (swap nack for reject; '>' to '>=' in isDoomed; drop a W-* gate), then each is killed by at least one test
- **Verification:**
  - `gh workflow run conformance-nightly.yml`
  - `gh workflow run mutation-nightly.yml`

### M0-43 ConnectionManager: role pools and budgets (PLAT-05)

- **Milestone (design):** M0 · **Wave:** M0-W3 · **Size:** M
- **Depends on:** M0-27, M0-35
- **Goal:** Role-separated connections budgeted against probed and provider limits (DC-11/12).
- **Scope:** libs/engine/svc-connections/src/internal/connection-manager/*.ts (Amqp091Connector port injected at the composition root)
- **Interfaces:** ConnectionManager.peek/source/publish/observe/budget; connection_name '<product>/<mode>/<role>/<session>'
- **Acceptance criteria:**
  - Given consumersPerChannelMax=10 (Amazon MQ preset) and 11 observe requests, then the 11th is queued and budget() reports queued=1 with an ETA
  - Given the peek role, then at most one job is in flight per connection and the lease never exposes publish
- **Verification:**
  - `pnpm nx test svc-connections --testNamePattern=connection-manager`

### M0-44 svc-connections: profiles, URI parsing, separate HTTP/AMQP tests, bundles (CON-01, CON-04 bundles)

- **Milestone (design):** M0 · **Wave:** M0-W3 · **Size:** L
- **Depends on:** M0-43, M0-24, M0-22
- **Goal:** Connection profiles with separate HTTP and AMQP endpoints and credentials, plus secret-safe bundle export and import.
- **Scope:** libs/engine/svc-connections/src/{module,actions/connections.*,actions/bundles.*,internal/{uri,listeners}}.ts; contracts/actions/connections.ts
- **Interfaces:** connections.create/update/delete/list/get, connections.test-http, connections.test-amqp, bundles.export/import; write-only secret fields
- **Acceptance criteria:**
  - Given 'amqps://u:p@host:5671/%2Fprod', when saved, then host, vhost '/prod', TLS and the derived management URL are filled, and HTTP and AMQP are tested separately with specific errors
  - Given HTTP OK but 5672 blocked, then test-amqp returns 'AMQP port blocked' and AMQP gates are disabled with that reason; given a bundle exported without secrets, then the secret scanner finds no password, token or URI credentials
- **Verification:**
  - `pnpm nx test svc-connections`
  - `pnpm nx run svc-connections:it --versions=4.3.6`

### M0-45 svc-capabilities: probe sequence and BrokerProfile (CON-03 part 1)

- **Milestone (design):** M0 · **Wave:** M0-W3 · **Size:** L
- **Depends on:** M0-24, M0-27, M0-11, M0-35
- **Goal:** The read-only probe (fact sheet j.2 steps 1-12) builds and caches the BrokerProfile (DC-31).
- **Scope:** libs/engine/svc-capabilities/src/{probe/steps/01-tls..12-amqp-handshake,profile-builder,actions/{profile.get,probe.run}}.ts; migration broker_profiles
- **Interfaces:** BrokerProfile plus fingerprint; the probe never touches MgmtWritePort
- **Acceptance criteria:**
  - Given repeated /api/overview responses with different node names, then lbFronted=true with evidence and node-local results are labelled
  - Given LavinMQ fixtures (no rabbitmq_version, extensions []), then product=lavinmq; given any probe run, then zero write-shaped requests are made (recording fake)
- **Verification:**
  - `pnpm nx test svc-capabilities`
  - `pnpm nx run svc-capabilities:it --versions=3.13.7,4.0.9,4.1.8,4.2.9,4.3.6`

### M0-46 svc-capabilities: gates, hazards, era and verification (CON-03 part 2, MSG-01 integration)

- **Milestone (design):** M0 · **Wave:** M0-W3 · **Size:** M
- **Depends on:** M0-45, M0-13
- **Goal:** Every feature gate carries a why-disabled reason with a source, and every profile carries its era and verification state.
- **Scope:** libs/engine/svc-capabilities/src/gates/*.ts, era.ts; allowedActions computation
- **Interfaces:** profile.gates Record<FeatureId, GateDecision {enabled, reason, source, fix}>; profile.era; profile.verification
- **Acceptance criteria:**
  - Given an Amazon MQ 4.2 fixture, then streams, firehose and event audit are disabled with source-linked reasons, and operator-policy edits show the 405 remediation
  - Given 4.3.6 with rabbitmq_4.3.0 disabled, then the era is 4.0-4.2 with the reason shown; given 4.3.7, then verification is unverified-patch
- **Verification:**
  - `pnpm nx test svc-capabilities --testNamePattern=gates`

### M0-47 svc-workspace: layouts, saved views, settings, keybindings

- **Milestone (design):** M0 · **Wave:** M0-W3 · **Size:** S
- **Depends on:** M0-35, M0-21
- **Goal:** Persist the UI workspace per profile through engine actions.
- **Scope:** libs/engine/svc-workspace/src/actions/{layouts,views,settings,keybindings}.*.ts; migration 0006_workspace
- **Interfaces:** layouts.get/put (per profile), views.list/create/delete (not bound to a connection), settings.get/put (zod-validated)
- **Acceptance criteria:**
  - Given a saved view created on connection A, when views are listed on connection B, then it is available; layouts are stored per profile
  - Given a settings write with an unknown key, then it is rejected with VALIDATION_FAILED
- **Verification:**
  - `pnpm nx test svc-workspace`

### M0-48 svc-explorer: inventory windows, overview, explorer.window topic (EXP-02/03 engine, S-13)

- **Milestone (design):** M0 · **Wave:** M0-W3 · **Size:** L
- **Depends on:** M0-46, M0-33, M0-23
- **Goal:** Windowed inventory and an overview that stay correct with stats off and stay cheap at 20k-100k queues.
- **Scope:** libs/engine/svc-explorer/src/{actions/{inventory.query,overview.get,search},topics/explorer-window,internal/{sweeper,index}}.ts; perf/explorer-20k; S-13 measurements on broker-lab recorded in an ADR-024 addendum
- **Interfaces:** inventory.query {kind, filter, sort, window}; explorer.window topic (snapshot-delta; deltas only for visible keys)
- **Acceptance criteria:**
  - Given 20k queues (synthetic fake and broker-lab), when windows are queried and scrolled, then no request exceeds page_size 500, stats-off lists use disable_stats + enable_queue_totals, and engine p95 is at most 100 ms
  - Given stats off on 4.2.9, then overview totals come from enable_queue_totals and rates are labelled unavailable; given an alarm, then the overview names the node and the resource
- **Verification:**
  - `pnpm nx test svc-explorer`
  - `pnpm nx run perf:explorer-20k`

### M0-49 ui-platform and ui-data: transports, bridge, EngineApi, LiveClient

- **Milestone (design):** M0 · **Wave:** M0-W3 · **Size:** M
- **Depends on:** M0-10, M0-17
- **Goal:** One Angular build that talks to the engine over MessagePort or HTTP/WebSocket through typed APIs.
- **Scope:** libs/ui/platform/src/{engine-transport,messageport-transport,httpws-transport,platform-bridge,bootstrap}.ts; libs/ui/data/src/{engine-api,engine-resource,live-client,interceptors}.ts
- **Interfaces:** ENGINE_TRANSPORT and PLATFORM_BRIDGE tokens; EngineApi.call/plan/execute; engineResource; LiveClient.subscribe (credit granted after rAF)
- **Acceptance criteria:**
  - Given the same component spec, when run against a fake MessagePort transport and a fake WebSocket transport, then the results are identical
  - Given a Problem response, then the interceptor yields a typed error carrying gate and warnings; LiveClient grants credit only after a rendered rAF batch
- **Verification:**
  - `pnpm nx run-many -t test -p ui-platform ui-data`

### M0-50 ui-design system: tokens, themes, Spartan helm, gated, env chrome, dev gallery

- **Milestone (design):** M0 · **Wave:** M0-W3 · **Size:** M
- **Depends on:** M0-04, M0-20
- **Goal:** Accessible design tokens and the safety components every feature uses.
- **Scope:** libs/ui/design/src/{tokens.css,tailwind-preset,theme.service,helm/ (Spartan 1.7.0 copies + MIT notice),aria/,components/{gated,env-chrome,verification-banner}}; apps/web dev gallery route (dev builds only)
- **Interfaces:** <app-gated>, <app-env-chrome>, <app-verification-banner>, ThemeService
- **Acceptance criteria:**
  - Given the high-contrast theme, then every text token pair is at least 7:1, and comfortable-density targets are at least 24 px (token tests)
  - Given a disabled <app-gated>, then the reason and source link are keyboard-reachable and announced; the gallery route is absent from production builds
- **Verification:**
  - `pnpm nx test ui-design`
  - `pnpm nx e2e e2e-web --grep=@gallery`

### M0-51 Web shell: IDE layout, status bar, layout persistence, Transloco, budgets (EXP-01)

- **Milestone (design):** M0 · **Wave:** M0-W3 · **Size:** L
- **Depends on:** M0-49, M0-50, M0-47
- **Goal:** The VS Code-style shell, with every string externalised and bundle budgets enforced from day one.
- **Scope:** apps/web/src/app/{shell/{activity-bar,explorer-tree,tabs,bottom-panel,status-bar},routes,i18n}; Transloco 8.4 scopes; ChunkLoadError single controlled reload; version-skew banner; Angular budgets + target web:budgets (gzip)
- **Interfaces:** Routes /c/:cid/...; status bar: profile, environment, version, era badge, stats mode, lock, engine health
- **Acceptance criteria:**
  - Given a restart, when the app reopens, then tabs, splits and panel sizes are restored per profile
  - Given a 1280x720 window, then every region is usable with no horizontal page scroll; every visible string comes from a Transloco key; the initial bundle is at most 350 kB gzip
- **Verification:**
  - `pnpm nx e2e e2e-web --grep=@shell`
  - `pnpm nx run web:budgets`

### M0-52 feature-connections UI: profiles, tests, capability card, env chrome, prod lock (CON-01/02 UI)

- **Milestone (design):** M0 · **Wave:** M0-W3 · **Size:** M
- **Depends on:** M0-51, M0-44, M0-46, M0-30
- **Goal:** Create, test and switch connections, with environment chrome and the audited prod unlock.
- **Scope:** libs/ui/feature-connections (list, form with URI paste and separate HTTP/AMQP credentials, test results, capability card, unlock dialog); connection switcher
- **Interfaces:** Uses connections.*, profile.get, ops.arm
- **Acceptance criteria:**
  - Given a PROD profile, then every mutating control, including peek, is disabled with reason 'prod-lock' until the unlock dialog is confirmed, and the unlock is audited
  - Given orders.q open on staging, when switching to prod, then orders.q opens if it exists, otherwise the explorer root opens with a notice
- **Verification:**
  - `pnpm nx e2e e2e-web --grep=@connections`

### M0-53 ui-grid adapter: AG Grid Community with engine-windowed infinite model (S-14)

- **Milestone (design):** M0 · **Wave:** M0-W3 · **Size:** M
- **Depends on:** M0-50, M0-49, M0-20
- **Goal:** A grid adapter that keeps memory flat at 100k rows and owns the Enterprise-only features (DC-52).
- **Scope:** libs/ui/grid/src/{data-grid.component,windowed-datasource,context-menu,clipboard,column-chooser,status-bar}.ts; perf:grid-100k
- **Interfaces:** <app-data-grid> {columns, source: EngineWindowSource, selection, columnState, onContextMenu, keybindings}
- **Acceptance criteria:**
  - Given 100k rows served by a fake engine window (block 200, at most 25 blocks), when scrolling, then frame rate is at least 55 fps with no long task above 50 ms (CDP trace)
  - Given a right-click, then our Aria menu opens, and no AG Grid Enterprise module is present in the bundle (licence gate)
- **Verification:**
  - `pnpm nx test ui-grid`
  - `pnpm nx run perf:grid-100k`

### M0-54 feature-explorer grids, saved views and cluster overview (EXP-02/03 UI)

- **Milestone (design):** M0 · **Wave:** M0-W3 · **Size:** M
- **Depends on:** M0-53, M0-48, M0-51
- **Goal:** The read-only explorer: grids for queues, exchanges, bindings and connections, plus the overview with its capability card.
- **Scope:** libs/ui/feature-explorer (grids, filter chips, regex filter, column picker, saved views, overview page with capability card and why-disabled reasons)
- **Interfaces:** Uses inventory.query, explorer.window, overview.get, views.*
- **Acceptance criteria:**
  - Given 20k queues, when scrolling and filtering, then p95 interaction is under 300 ms and no engine request exceeds page_size 500
  - Given a saved view, when reopened on another connection, then its filters and columns apply
- **Verification:**
  - `pnpm nx e2e e2e-web --grep=@explorer`
  - `pnpm nx run perf:explorer-ui-20k`

### M0-55 Desktop main: app:// protocol, windows and security handlers

- **Milestone (design):** M0 · **Wave:** M0-W3 · **Size:** M
- **Depends on:** M0-18, M0-20
- **Goal:** A thin, hardened Electron main process that serves the UI from asar (DC-46).
- **Scope:** apps/desktop/src/main/{index,protocol,windows,security,menus}.ts (single-instance lock, privileged app scheme, CSP nonce, SPA fallback, navigation/window-open guards, permission handler, openExternal allow-list with confirm)
- **Interfaces:** app://main origin; CSP from M0-20
- **Acceptance criteria:**
  - Given a renderer navigation or window.open to an external URL, then it is blocked; given app://main/../../secret, then the response is 404
  - Given index.html, then it carries the M0-20 CSP with a fresh nonce, and every permission request is denied
- **Verification:**
  - `pnpm nx test desktop --testNamePattern=main`
  - `pnpm nx e2e e2e-desktop --grep=@security`

### M0-56 Desktop supervisor, ctl channel, port issuance, preload, quit/suspend drain

- **Milestone (design):** M0 · **Wave:** M0-W3 · **Size:** L
- **Depends on:** M0-55, M0-34, M0-36
- **Goal:** Run the engine as a supervised utilityProcess, with one MessagePort per page load and DC-04 flushes on quit and suspend.
- **Scope:** apps/desktop/src/main/{engine-supervisor,ctl,power,quit}.ts; apps/desktop/src/preload/index.ts
- **Interfaces:** CtlFrame; PlatformBridge v1 (requestEnginePort, pickSaveTarget, openExternal, notify, setMenu, onMenuCommand, onDeepLink, appInfo)
- **Acceptance criteria:**
  - Given an engine crash, then it restarts with backoff, every live renderer gets a new port, and an 'engine restarted' banner and gap frames appear
  - Given quit, then ctl:shutdown with a 2000 ms deadline precedes kill (escalation after +1 s, SIGKILL after +2 s); given a sender frame that is not app://main, then no port is issued
- **Verification:**
  - `pnpm nx e2e e2e-desktop --grep='@supervisor|@quit'`

### M0-57 Desktop key wrap and master password (CON-04 desktop)

- **Milestone (design):** M0 · **Wave:** M0-W3 · **Size:** S
- **Depends on:** M0-56, M0-22, M0-19
- **Goal:** Wrap the DEK with safeStorage async, and require a master password on weak Linux backends.
- **Scope:** apps/desktop/src/main/keywrap.ts; master-password dialog in libs/ui/feature-settings
- **Interfaces:** ctl:init {dek}; settings.masterPassword flow
- **Acceptance criteria:**
  - Given Linux reports basic_text, when the first secret is saved, then a master password is required
  - Given safeStorage async, then the DEK reaches the engine only through ctl:init and never reaches the renderer (canary scan)
- **Verification:**
  - `pnpm nx e2e e2e-desktop --grep=@keywrap`

### M0-58 Electron fuses, test-fused build and fuse-check (DC-46)

- **Milestone (design):** M0 · **Wave:** M0-W3 · **Size:** S
- **Depends on:** M0-56
- **Goal:** Release binaries are hardened by fuses; only the test-fused build is automatable.
- **Scope:** apps/desktop/electron-builder.{release,test}.yml (electron-builder 26.17.0 exact); tools/fuse-check
- **Interfaces:** Target fuse-check:check --artefact=<path>
- **Acceptance criteria:**
  - Given the release artefact, then RunAsNode, NodeOptions, NodeCliInspect and GrantFileProtocolExtraPrivileges are off, and EmbeddedAsarIntegrityValidation, OnlyLoadAppFromAsar and CookieEncryption are on
  - Given the release bundle, then the DEV_HTTP loopback transport is absent (metafile check), and the test-fused build is never uploaded
- **Verification:**
  - `pnpm nx run desktop:package --config=release --dir`
  - `pnpm nx run fuse-check:check --artefact=dist/desktop/release`

### M0-59 Local web mode: npx serve and container mode (PLAT-08, ADR-016)

- **Milestone (design):** M0 · **Wave:** M0-W3 · **Size:** M
- **Depends on:** M0-36
- **Goal:** A loopback-only, token-protected local web mode, with the explicit container-mode exception.
- **Scope:** apps/cli/src/commands/serve.ts; apps/web bootstrap (fragment token moved to sessionStorage, URL cleaned, Bearer); container mode via <PRODUCT>_RUNTIME=container
- **Interfaces:** npx <product> serve [--port 0] [--data-dir] [--no-open] [--token-file]; PUBLIC_ORIGIN
- **Acceptance criteria:**
  - Given --host 0.0.0.0 without auth and TLS, then startup is refused with guidance; given a foreign Origin, then requests are rejected
  - Given container mode, then the token is always required, loopback Host names on any port and PUBLIC_ORIGIN are accepted while any other Host is refused, and the banner prints the -p 127.0.0.1 command
- **Verification:**
  - `pnpm nx test cli`
  - `pnpm nx e2e e2e-web --grep=@local-security`

### M0-60 e2e-web smoke and security suite

- **Milestone (design):** M0 · **Wave:** M0-W3 · **Size:** M
- **Depends on:** M0-59, M0-54, M0-52
- **Goal:** Prove the read-only explorer over WebSocket and the local-mode attack surface.
- **Scope:** apps/e2e-web (Playwright 1.64.1, broker-lab 4.3.6): connect, probe, overview, grids; security cases (DNS-rebinding Host, Origin, Sec-Fetch-Site, WebSocket ticket reuse, carrier header, no CORS headers, no GET mutation); axe on every route
- **Interfaces:** Tags @smoke, @security, @a11y
- **Acceptance criteria:**
  - Given an npx-mode engine and broker-lab, when the explorer flow runs, then the read-only explorer works over WebSocket and axe reports 0 serious violations
  - Given each request in the attack list, then it is rejected
- **Verification:**
  - `pnpm nx e2e e2e-web`

### M0-61 e2e-desktop smoke suite

- **Milestone (design):** M0 · **Wave:** M0-W3 · **Size:** M
- **Depends on:** M0-56, M0-58, M0-54
- **Goal:** Prove the read-only explorer over MessagePort and the desktop lifecycle on all three OSes.
- **Scope:** apps/e2e-desktop (Playwright _electron on the test-fused build): boot, tunnel, reload re-wiring, crash and port re-issue, simulated suspend/resume; explorer against broker-lab on Linux; fakes on macOS and Windows
- **Interfaces:** Tags @smoke, @supervisor, @quit, @security, @keywrap
- **Acceptance criteria:**
  - Given the Linux runner, then the read-only explorer works over MessagePort against broker-lab 4.3.6
  - Given macOS and Windows runners, then the boot, tunnel and crash-recovery smoke tests pass against fake engine data
- **Verification:**
  - `pnpm nx e2e e2e-desktop --grep=@smoke`

### M0-62 Matrix generator and docs publication (matrix v0)

- **Milestone (design):** M0 · **Wave:** M0-W3 · **Size:** S
- **Depends on:** M0-38, M0-39, M0-40, M0-41, M0-06
- **Goal:** Publish the conformance matrix per release, linking each cell to its CF id and evidence (DC-47).
- **Scope:** apps/conformance/src/matrix/generate.ts producing apps/docs/src/content/matrix/<release>.json and its page
- **Interfaces:** Target conformance:matrix --versions=...; docs route /matrix
- **Acceptance criteria:**
  - Given a release tag, when conformance:matrix runs, then every registry cell is listed with pass, fail or unverified for each version, and the docs page renders it
  - Given any settle-path cell that is not green on the 5 versions, then the M0 release gate fails
- **Verification:**
  - `pnpm nx run conformance:matrix --versions=3.13.7,4.0.9,4.1.8,4.2.9,4.3.6`
  - `pnpm nx build docs`

### M0-63 Provider contract run v0: Amazon MQ and CloudAMQP (U-11, U-12 part)

- **Milestone (design):** M0 · **Wave:** M0-W4 · **Size:** M
- **Depends on:** M0-46, M0-48, M0-09
- **Goal:** Prove the probe and the read-only explorer against managed brokers, as the M0 exit requires.
- **Scope:** testing/providers/{amazon-mq,cloudamqp}.spec.ts; .github/workflows/providers.yml (protected environment, manual approval); redacted fixture snapshots
- **Interfaces:** gh workflow providers.yml -f targets=...
- **Acceptance criteria:**
  - Given Amazon MQ 4.2 and 4.3 test brokers, when probed, then streams, firehose and event audit are gated off with reasons and the explorer lists queues read-only
  - Given CloudAMQP shared, then definitions export is 'synthetic' and admin-only features are hidden with reasons
- **Verification:**
  - `gh workflow run providers.yml -f targets=amazon-mq,cloudamqp`

### M0-64 Container image (PLAT-09)

- **Milestone (design):** M0 · **Wave:** M0-W4 · **Size:** M
- **Depends on:** M0-59
- **Goal:** A distroless, non-root, multi-arch, signed image with an SBOM and a SIGTERM drain.
- **Scope:** packaging/docker/{Dockerfile (node:24-trixie-slim build stage, distroless nodejs24-debian13:nonroot runtime pinned by digest),healthcheck.mjs,compose.yaml}; .github/workflows/image.yml (native amd64/arm64, merge by digest, cosign keyless, SBOM, provenance, Trivy)
- **Interfaces:** Image ghcr.io/<org>/<product>; HEALTHCHECK on /healthz
- **Acceptance criteria:**
  - Given the image, then cosign verify succeeds, Trivy reports no CRITICAL, and it runs as nonroot with a read-only root filesystem
  - Given SIGTERM, then the process drains and exits within 2 s
- **Verification:**
  - `pnpm nx run docker:build`
  - `pnpm nx run docker:test`

### M0-65 npm CLI package, THIRD_PARTY_NOTICES and SBOM from the esbuild metafile

- **Milestone (design):** M0 · **Wave:** M0-W4 · **Size:** M
- **Depends on:** M0-59, M0-02
- **Goal:** Ship npx <product> with provenance and accurate notices generated from the bundled inputs (DC-50).
- **Scope:** apps/cli/package.json (bin) and pack target bundling engine + web; tools/supply-chain/{notices,sbom}.ts (CycloneDX); npm trusted-publishing workflow (alpha dist-tag)
- **Interfaces:** Target supply-chain:notices-check --artefact=<dir>
- **Acceptance criteria:**
  - Given npm pack, then the tarball contains LICENSE, NOTICE and THIRD_PARTY_NOTICES (covering every metafile input) and no absolute source-map paths, and npx ./<tgz> serve --no-open starts
  - Given a bundled package missing from the notices, then notices-check fails
- **Verification:**
  - `pnpm nx run cli:pack`
  - `pnpm nx run supply-chain:notices-check --artefact=dist/cli`

### M0-66 Desktop packaging: macOS notarised, Linux deb/rpm/AppImage

- **Milestone (design):** M0 · **Wave:** M0-W4 · **Size:** M
- **Depends on:** M0-58, M0-09
- **Goal:** Signed and notarised macOS builds for arm64 and x64, and Linux packages that keep the sandbox (DC-58).
- **Scope:** electron-builder.release.yml mac section (dmg + zip arm64/x64, hardened runtime, notarize, NSLocalNetworkUsageDescription) and linux section (deb/rpm x64 + arm64 with AppArmor profile, AppImage)
- **Interfaces:** Targets desktop:package --platform=mac|linux and desktop:install-smoke
- **Acceptance criteria:**
  - Given the macOS artefacts, then codesign --verify --deep --strict, spctl --assess and xcrun stapler validate pass for arm64 and x64
  - Given the deb on ubuntu-24.04, then it installs the AppArmor profile and launches sandboxed, never with --no-sandbox
- **Verification:**
  - `pnpm nx run desktop:package --platform=mac --publish=never`
  - `pnpm nx run desktop:package --platform=linux --publish=never`
  - `pnpm nx run desktop:install-smoke --os=linux`

### M0-67 Desktop packaging: Windows Store MSIX and NSIS/zip

- **Milestone (design):** M0 · **Wave:** M0-W4 · **Size:** M
- **Depends on:** M0-58, M0-19, M0-09
- **Goal:** MSIX as the first-class Windows channel, plus NSIS/zip whose update metadata is regenerated after external signing.
- **Scope:** electron-builder.release.yml win section (msix, nsis, zip for x64/arm64); tools/release/regenerate-update-metadata.ts; Partner Center private flight; Certum signing step (or the documented alpha exception)
- **Interfaces:** Targets desktop:package --platform=win and desktop:msix-smoke
- **Acceptance criteria:**
  - Given the MSIX, when installed on windows-2025 with the test certificate and submitted to a private Store flight, then the engine utilityProcess starts
  - Given NSIS signed after the build, then latest.yml and the blockmap are regenerated and verified
- **Verification:**
  - `pnpm nx run desktop:package --platform=win --publish=never`
  - `pnpm nx run desktop:msix-smoke`

### M0-68 Release workflow, opt-in updates, Homebrew tap and winget scaffolding (PLAT-10)

- **Milestone (design):** M0 · **Wave:** M0-W4 · **Size:** L
- **Depends on:** M0-64, M0-65, M0-66, M0-67, M0-42, M0-62
- **Goal:** One gated pipeline from tag to immutable release, with update checks that are off until the user opts in.
- **Scope:** .github/workflows/release.yml; apps/desktop/src/main/updater.ts (electron-updater 6.8.10; first-run opt-in with no preselection; enterprise disable); homebrew-tap template; winget-releaser config
- **Interfaces:** Release stages: conformance gate, build, sign/notarise, metadata regeneration, fuse-check, notices/SBOM, SHA256SUMS + attestations, draft, immutable publish
- **Acceptance criteria:**
  - Given a release-please tag on a fork, then every stage completes in order and produces an immutable release with all artefacts attached
  - Given the enterprise disable setting, or no opt-in, then no update request is made (egress proxy log)
- **Verification:**
  - `gh workflow run release.yml -f dry_run=true --ref <fork-tag>`

### M0-69 Privacy: outbound-calls list, deny-all egress E2E, diagnostics bundle (PLAT-12)

- **Milestone (design):** M0 · **Wave:** M0-W4 · **Size:** M
- **Depends on:** M0-61, M0-36
- **Goal:** Prove that there is no telemetry and no phone-home, and give users a redacted local diagnostics bundle (DC-59).
- **Scope:** Dialer purpose registry generating the docs outbound-calls page; e2e-desktop deny-all egress proxy run; libs/engine/svc-ops/src/actions/diagnostics.bundle.ts; crashReporter uploadToServer:false
- **Interfaces:** diagnostics.bundle writes to a PlatformBridge file token
- **Acceptance criteria:**
  - Given a fresh install with updates disabled, when exercised for 10 minutes, then there are zero outbound connections other than to configured brokers
  - Given a diagnostics bundle built with planted canary secrets in logs and profiles, then the secret scanner finds none
- **Verification:**
  - `pnpm nx e2e e2e-desktop --grep=@egress`
  - `pnpm nx test svc-ops --testNamePattern=diagnostics`

### M1-01 Effective-config resolver and k.3 tables (POL-01 core, DC-30)

- **Milestone (design):** M1 · **Wave:** M1-W1 · **Size:** M
- **Depends on:** M0-11, M0-13
- **Goal:** A pure per-key, per-queue-type, per-version resolver with provenance and hypothetical names.
- **Scope:** libs/shared/semantics/src/data/effective-config.data.ts; libs/shared/effective-config/src/{merge-operator,resolve,provenance,hypothetical}.ts
- **Interfaces:** resolveEffective({queueType, version, args, userPolicy, operatorPolicy}) returns Record<key, {value, provenance[]}>
- **Acceptance criteria:**
  - Given a 4.0.8 QQ with x-max-length 500 and a policy max-length of 1000, then the effective value is 500 with provenance 'min(arg, policy)'
  - Given a 3.13 QQ with an expires argument of 60000 and a policy of 120000, then the result is 120000 (policy wins); given user delivery-limit -1 and operator 50, then the merge yields 50; effective_policy_definition is never returned as effective
- **Verification:**
  - `pnpm nx test effective-config`

### M1-02 Routing simulator I: exchange matching, E2E, AE, default exchange, CC/BCC (TOP-02 core)

- **Milestone (design):** M1 · **Wave:** M1-W1 · **Size:** M
- **Depends on:** M0-10, M0-11
- **Goal:** Pure evaluation of direct, topic, fanout and headers routing, including exchange-to-exchange chains and alternate exchanges.
- **Scope:** libs/shared/routing/src/{direct,topic,fanout,headers,e2e,ae,default-exchange,cc-bcc}.ts
- **Interfaces:** simulate({topology, exchange, routingKey, headers, props}) returns {queues, path[], usedAE, unroutable, notes[]}
- **Acceptance criteria:**
  - Given headers bindings with x-match all, any, any-with-x and all-with-x, then matches follow broker rules (property tests)
  - Given an exchange whose own destinations are empty, then the AE path is used; given the default exchange and key q1, then queue q1; given CC/BCC headers, then the extra queues are added
- **Verification:**
  - `pnpm nx test routing`

### M1-03 Routing simulator II: DLX/TTL paths, loops, DLX-source analysis

- **Milestone (design):** M1 · **Wave:** M1-W1 · **Size:** M
- **Depends on:** M1-02, M1-01
- **Goal:** Dead-letter paths and DLX-source limits, as inputs to W-OVERLIMIT and the DLQ views.
- **Scope:** libs/shared/routing/src/{dlx,ttl,cycles,dlx-sources,hash-random-notes}.ts
- **Interfaces:** dlxSources(topology, queue) returns Array<{queue, limit: DeliveryLimit}>; deadLetterPath(...)
- **Acceptance criteria:**
  - Given a QQ DLQ with L=20 fed by a QQ source with L=20, then dlxSources returns that source with finite 20
  - Given a fully automatic DLX cycle (no rejected death), then it is flagged as a drop loop; given x-consistent-hash, then a 'non-deterministic weight share' note is returned
- **Verification:**
  - `pnpm nx test routing --testNamePattern=dlx`

### M1-04 Death-history normaliser (DLQ-02)

- **Milestone (design):** M1 · **Wave:** M1-W1 · **Size:** S
- **Depends on:** M0-10, M0-11
- **Goal:** Parse x-death, x-first/last-death-* and x-opt-deaths into one timeline, and flag client-published x-death as untrusted on 4.0+.
- **Scope:** libs/shared/deaths/src/{x-death,x-opt-deaths,first-last,trust}.ts
- **Interfaces:** normalizeDeaths(msg, era) returns {entries newest-first in ms, trusted: boolean}
- **Acceptance criteria:**
  - Given a 0-9-1 x-death (seconds) and a 1.0 x-opt-deaths (ms) describing the same history, then both normalise to the same model, newest first
  - Given a 4.x message with a client-set x-death, then it is marked untrusted; on 3.13 it is interpreted
- **Verification:**
  - `pnpm nx test deaths`

### M1-05 Lab: routing-simulator conformance via firehose routed_queues

- **Milestone (design):** M1 · **Wave:** M1-W1 · **Size:** M
- **Depends on:** M1-03, M0-37
- **Goal:** Prove that the simulator equals the broker's real routing for every fixture.
- **Scope:** apps/conformance/src/cells/routing/*.cell.ts (fixture topologies; tracing on; routed_queues captured from publish traces)
- **Interfaces:** CF-ROUTE-* ids
- **Acceptance criteria:**
  - Given the routing fixture set on all 5 versions, then the simulator's queues equal the broker's routed_queues for 100% of cases
- **Verification:**
  - `pnpm nx run conformance:test --grep=CF-ROUTE --versions=3.13.7,4.0.9,4.1.8,4.2.9,4.3.6`

### M1-06 Lab: M1 uncertainties (U-03, U-04 pre-run, U-08, U-17, U-18)

- **Milestone (design):** M1 · **Wave:** M1-W1 · **Size:** L
- **Depends on:** M0-37
- **Goal:** Record the evidence that the peek executor, the HTTP fallback and the viewer badges depend on, before they are built.
- **Scope:** apps/conformance/src/cells/{http-get-abort,fidelity,server-cancel,cq-order}/*.cell.ts; lab-driver chaos pre-run of nack, qos barrier, close under toxiproxy (2,000 iterations)
- **Interfaces:** CF-HTTPGET-*, CF-FIDELITY-*, CF-CANCEL-*, CF-CQORDER-* ids
- **Acceptance criteria:**
  - Given an aborted HTTP POST /get on 4.2.9 and 4.3.6, then the counter deltas are recorded and the HTTP-fallback client-timeout rule is set from them
  - Given 0-9-1 and 1.0 publishes into CQ, QQ and stream, read back over each protocol, then a header-fidelity table is recorded; given priority and paged CQs, then requeue positions are recorded; given the chaos pre-run, then any DC delta after nack + barrier is recorded
- **Verification:**
  - `pnpm nx run conformance:test --grep='CF-HTTPGET|CF-FIDELITY|CF-CANCEL|CF-CQORDER' --versions=3.13.7,4.0.9,4.1.8,4.2.9,4.3.6`
  - `pnpm nx run chaos:lab-nack-barrier --runs=2000`

### M1-07 adapter-amqp10 on rhea 3.0.5 (STR-02 core, DC-22..25)

- **Milestone (design):** M1 · **Wave:** M1-W1 · **Size:** L
- **Depends on:** M0-23, M0-26
- **Goal:** An in-house, spec-correct AMQP 1.0 adapter with explicit credit, described filters and filter echo.
- **Scope:** libs/engine/adapter-amqp10/src/{connect (hostname 'vhost:<v>', SASL PLAIN/EXTERNAL),address-v2,receiver (credit_window 0, autoaccept and autosettle off),filters (described),offsets (ulong, ms timestamps),settle,management-node}.ts
- **Interfaces:** Amqp10Receiver {appliedFilters, addCredit, drain, deliveries, release, accept(proof), detach (throws if unsettled)}
- **Acceptance criteria:**
  - Given a peek of N, when credit N is granted and then drained, then at most N deliveries are acquired; detach with unsettled deliveries throws
  - Given 4.3.6 and a Bloom filter, then the attach reply lists it as applied, or the read fails with 'broker ignored filter X'; queue names containing spaces are percent-encoded
- **Verification:**
  - `pnpm nx test adapter-amqp10`
  - `pnpm nx run adapter-amqp10:it --versions=4.0.9,4.1.8,4.2.9,4.3.6`

### M1-08 AMQP 1.0 differential oracle and stream labs (U-07, U-25)

- **Milestone (design):** M1 · **Wave:** M1-W1 · **Size:** M
- **Depends on:** M1-07, M0-14
- **Goal:** Cross-check the adapter against the official client, and settle the stream read-path questions.
- **Scope:** testing/oracle-amqp10 (coders51 client with rhea overridden to registry 3.0.5); apps/conformance/src/cells/streams/*.cell.ts including 3-node + HAProxy replica landing; upstream PRs opened (filters, credit #94, vhost #95, race #96)
- **Interfaces:** Target adapter-amqp10:contract --oracle; CF-STREAM-* ids
- **Acceptance criteria:**
  - Given matching operations, then our adapter and the oracle agree, except for the documented oracle defects (non-described filters, BigInt offsets)
  - Given 3.13.7, then whether the 1.0 plugin honours stream offset specs is recorded, and if it does not, the registry gates 3.13 stream reads to 0-9-1
- **Verification:**
  - `pnpm nx run adapter-amqp10:contract --oracle`
  - `pnpm nx run conformance:test --grep=CF-STREAM --versions=3.13.7,4.2.9,4.3.6`

### M1-09 Capture store: encrypted captures, blobs, FTS5 ingest/search worker (MSG-10 core)

- **Milestone (design):** M1 · **Wave:** M1-W1 · **Size:** M
- **Depends on:** M0-21, M0-22
- **Goal:** Store captured copies locally with encryption, retention, and off-loop ingest.
- **Scope:** libs/engine/persistence (captures, captured_messages, blobs, FTS5/tsvector); libs/engine/svc-messages/src/internal/capture-store.ts; apps/engine/src/workers/capture.ts
- **Interfaces:** CaptureStore.append(batch) (at most 5 ms per transaction), query, blob(ref, offset, length); volatile vs saved captures; metadata-only FTS in prod
- **Acceptance criteria:**
  - Given 50k captured messages, when filtered by full text, then results return within 1 s and ingest stays at or below 5 ms per transaction off the main loop
  - Given a PROD capture, then bodies are not indexed and saved bodies are sealed with AES-GCM; the retention purge removes expired rows and blobs
- **Verification:**
  - `pnpm nx test svc-messages --testNamePattern=capture`
  - `pnpm nx run perf:capture-ingest`

### M1-10 Payload codecs v1 in the tier-1 worker pool (MSG-08)

- **Milestone (design):** M1 · **Wave:** M1-W1 · **Size:** M
- **Depends on:** M0-16
- **Goal:** Decode common payload formats safely off the main loop.
- **Scope:** libs/engine/plugin-host/src/pool.ts (piscina 5.3.2; 250 ms timeout; 64 MB old space); libs/engine/decoders/src/codecs/{json,xml,text,base64,hex,gzip,deflate,brotli,zstd,msgpack,cbor,cloudevents}.ts
- **Interfaces:** CodecPlugin {detect, decode, encode?}; selection by content_type, content_encoding and per-queue rules
- **Acceptance criteria:**
  - Given content-encoding gzip and a msgpack body, then the decoded tree renders; given a malformed payload, then hex plus the inline decode error is returned
  - Given a decode exceeding 250 ms or 64 MB, then the worker is terminated and the engine stays healthy; pickle and PHP payloads are never deserialised
- **Verification:**
  - `pnpm nx run-many -t test -p decoders plugin-host`

### M1-11 Spike: Cytoscape WebGL on VMs/RDP and the ELK worker under app:// (U-23)

- **Milestone (design):** M1 · **Wave:** M1-W1 · **Size:** S
- **Depends on:** M0-55, M0-20
- **Goal:** Decide the default graph renderer before the topology view is built.
- **Scope:** spikes/graph/ (5k-element topology in Electron and Chromium on a GPU blocklist, a VM and an RDP session); ADR-021 addendum
- **Interfaces:** Decision record: canvas vs WebGL default; fallback rule
- **Acceptance criteria:**
  - Given VM and RDP sessions, then WebGL2 availability and fps are recorded, and the automatic canvas fallback rule is decided (canvas by default if WebGL is unreliable)
- **Verification:**
  - `gh workflow run spike.yml -f spike=graph`

### M1-12 Peek planner, pure, covering all b.8 rows (MSG-02, MSG-05 planning)

- **Milestone (design):** M1 · **Wave:** M1-W2 · **Size:** L
- **Depends on:** M0-62, M0-46, M1-01, M1-03
- **Goal:** Turn the registry, preflight and principal into a plan with effects, gates, caps, hold budget and a mandatory disposition (DC-06..10, 13, 14, 16).
- **Scope:** libs/shared/peek-planner/src/{plan,hold-budget,caps,disposition,warnings,rejections}.ts
- **Interfaces:** PeekPlanner.plan(req, {profile, preflight, principal, registry, env}) returns PlanDraft<PeekPlanPreview> or PlanRejection
- **Acceptance criteria:**
  - Given a 4.3 QQ DLQ whose finite L is not above every DLX source's L+1, then the plan is blocked with W-OVERLIMIT and offers the delivery-limit -1 fix; given a 3.13 QQ with x-delivery-limit=-1, then LIMIT_MINUS1_313
  - Given a 4.0-4.2 QQ with L=20, then W-BUDGET consent is required, caps are 20/50 (admin 200) and the hold is min(30 s, TTL/4, channel timeout minus 90 s); given an unattended principal with no safe disposition, then NO_SAFE_DISPOSITION
- **Verification:**
  - `pnpm nx test peek-planner`

### M1-13 Peek preflight and rescue preflight (DC-06, DC-09)

- **Milestone (design):** M1 · **Wave:** M1-W2 · **Size:** M
- **Depends on:** M1-12, M0-43, M0-24
- **Goal:** HTTP-only preflight, plus a pre-armed and checked quarantine path before any acquisition.
- **Scope:** libs/engine/svc-peek/src/internal/{preflight,rescue-preflight,quarantine}.ts
- **Interfaces:** PeekPreflight; RescuePreflight; '<product>.quarantine' (durable classic, created once per vhost and reused; QQ with L=-1 as the fallback on 4.0+ only)
- **Acceptance criteria:**
  - Given an Amazon MQ-style '.*' max-length reject-publish policy, then the quarantine declare sets explicit arguments and the policy match is reported; given classic disabled on 3.13, then the quarantine disposition is unavailable
  - Given a blocked publish connection or an alarm, then the peek does not start; preflight issues only HTTP GETs (recording fake)
- **Verification:**
  - `pnpm nx test svc-peek --testNamePattern=preflight`
  - `pnpm nx run svc-peek:it --versions=4.2.9,4.3.6`

### M1-14 Peek executor: state machine, hold journal, watchdog, nack + qos barrier (MSG-03/04 core)

- **Milestone (design):** M1 · **Wave:** M1-W2 · **Size:** L
- **Depends on:** M1-12, M0-27, M0-43, M0-30, M0-31
- **Goal:** A short, atomic, engine-side peek that never returns messages by closing (DC-03/04/05/11).
- **Scope:** libs/engine/svc-peek/src/internal/{executor,state-machine,hold-journal,watchdog}.ts; migration hold_journal
- **Interfaces:** PeekExecutor.execute/flushAll/reconcileInterrupted; states idle through settled or incident
- **Acceptance criteria:**
  - Given 100 ready CQ messages, when peeking 20, then they return to their original positions with redelivered=true via one nack(multiple) plus barrier, and the channel closes lazily after the barrier
  - Given an app quit mid-peek, then flushAll nacks and awaits the barrier before close; the watchdog aborts at the hard limit
- **Verification:**
  - `pnpm nx test svc-peek --testNamePattern=executor`
  - `pnpm nx run svc-peek:it --versions=3.13.7,4.0.9,4.1.8,4.2.9,4.3.6`

### M1-15 Post-acquire guard, dispositions and counter trust (MSG-06, ADR-028)

- **Milestone (design):** M1 · **Wave:** M1-W2 · **Size:** M
- **Depends on:** M1-14, M1-13
- **Goal:** Stop at the first doomed message and apply the disposition chosen at plan time, with honest counter trust.
- **Scope:** libs/engine/svc-peek/src/internal/{guard,dispositions/{quarantine,raise-limit,let-broker},counter-trust}.ts
- **Interfaces:** CounterSource broker-stamped|dlx-carryover|unverified-copied|absent; Disposition
- **Acceptance criteria:**
  - Given a doomed message with quarantine chosen, then a confirmed copy exists in quarantine before the original is acked with a ConfirmedCopyProof, and acquisition stops
  - Given redelivered=false with a counter present and no finite-L DLX source, then the counter is unverified-copied and the message is not doomed; AI and unattended runs stop instead of rescuing
- **Verification:**
  - `pnpm nx test svc-peek --testNamePattern=guard`

### M1-16 svc-peek actions, receipts, captures and W-CRASH reconciliation (MSG-06)

- **Milestone (design):** M1 · **Wave:** M1-W2 · **Size:** M
- **Depends on:** M1-15, M1-09
- **Goal:** Expose messages.peek as a two-phase action whose receipts reach audit and the UI (DC-15).
- **Scope:** libs/engine/svc-peek/src/{module,actions/messages.peek}.ts (kind peek, planning required); receipts; capture writes; reconciliation at startup
- **Interfaces:** messages.peek plan/execute; PeekReceipt (era, method, deltas, positions, hold, stoppedBy, confidence)
- **Acceptance criteria:**
  - Given any peek, then the receipt lists era, method, AC/DC deltas, positions and hold time, and is written to the audit log
  - Given hold_journal rows in acquiring or holding at startup, then a W-CRASH incident receipt is produced and audited
- **Verification:**
  - `pnpm nx test svc-peek`
  - `pnpm nx run engine:it --testNamePattern=peek`

### M1-17 Executor model-based tests with a fast-check fake broker

- **Milestone (design):** M1 · **Wave:** M1-W2 · **Size:** M
- **Depends on:** M1-14
- **Goal:** Explore the executor's state space against a fake broker that tracks AC/DC per era.
- **Scope:** libs/testkit/src/fake-broker/ (AC/DC tracking per era); libs/engine/svc-peek/src/model.spec.ts
- **Interfaces:** FakeBroker implementing the Amqp091 ports
- **Acceptance criteria:**
  - Given random command sequences (get, guard, rescue, abort, watchdog, quit), then no sequence closes a channel while holding, uses reject, or acks without a proof
- **Verification:**
  - `pnpm nx test svc-peek --testNamePattern=model`

### M1-18 Conformance: per-era peek cells and CF-EXEC failure paths

- **Milestone (design):** M1 · **Wave:** M1-W2 · **Size:** L
- **Depends on:** M1-16, M0-37
- **Goal:** Prove that every peek path's receipts match the matrix on 5 versions (M1 exit criterion).
- **Scope:** apps/conformance/src/cells/{peek,exec}/*.cell.ts: CF-QQ-42-GUARD-01/02; quarantine confirm nacked, returned, blocked or timed out; 406 unknown tag; 405 race; 404 deleted mid-peek; watchdog during rescue; blocked mid-hold
- **Interfaces:** CF-PEEK-*, CF-EXEC-*, CF-QQ-42-* ids
- **Acceptance criteria:**
  - Given a 4.2.9 QQ with L=20 and a message at AC=19, then the first peek returns it with deltaAC=+1, and the second stops with stoppedBy=guard and quarantines it
  - Given each CF-EXEC fault on 4.2.9 and 4.3.6, then the receipt matches the documented failure path and the evidence
- **Verification:**
  - `pnpm nx run conformance:test --grep='CF-PEEK|CF-EXEC|CF-QQ-42' --versions=3.13.7,4.0.9,4.1.8,4.2.9,4.3.6`

### M1-19 Publish engine: publish action and history (PUB-01/02 engine)

- **Milestone (design):** M1 · **Wave:** M1-W2 · **Size:** M
- **Depends on:** M0-43, M0-30, M0-35
- **Goal:** Publish with confirms and mandatory on a dedicated publish lease, with honest per-copy outcomes.
- **Scope:** libs/engine/svc-messages/src/actions/{messages.publish,publish-history.*}.ts
- **Interfaces:** messages.publish {exchange, routingKey, props, headers, body, copies, mandatory, confirm} returns per-copy confirmed|nacked|returned
- **Acceptance criteria:**
  - Given mandatory and no matching binding, then the result is 'returned: NO_ROUTE', not success; with confirms, confirmed, nacked and returned are distinguished
  - Given a prior publish, then its data is returned for re-sending with secrets masked; entries older than the 30-day retention are purged
- **Verification:**
  - `pnpm nx test svc-messages --testNamePattern=publish`
  - `pnpm nx run svc-messages:it --versions=4.3.6`

### M1-20 svc-topology: graph/subgraph, routing simulation and effective-config actions

- **Milestone (design):** M1 · **Wave:** M1-W2 · **Size:** M
- **Depends on:** M1-01, M1-03, M0-24, M0-35
- **Goal:** Engine-side topology extraction and the simulator and effective-config APIs.
- **Scope:** libs/engine/svc-topology/src/actions/{topology.graph,topology.subgraph,routing.simulate,effective-config.get}.ts
- **Interfaces:** subgraph (depth at most 2, at most 2,000 elements); routing.simulate with an optional verification publish (mandatory)
- **Acceptance criteria:**
  - Given a 5k-element vhost, then subgraph returns at most 2,000 elements with an aggregation marker
  - Given an unroutable key, then the AE path or 'unroutable' is returned; effective-config.get returns per-key provenance
- **Verification:**
  - `pnpm nx test svc-topology`

### M1-21 TLS trust store and mTLS engine (CON-05)

- **Milestone (design):** M1 · **Wave:** M1-W2 · **Size:** M
- **Depends on:** M0-26
- **Goal:** CA import, client certificates and certificate diagnostics, without leaf pinning (DC-44).
- **Scope:** libs/engine/net-truststore (CA import including the IBM connection-string CA; PEM and PKCS#12 client certificates); TLS fields in svc-connections; certificate diagnostics action
- **Interfaces:** tls.diagnostics action; profile.tls {ca[], clientCert, servername, insecure}
- **Acceptance criteria:**
  - Given a private CA imported, when connecting by IP with an SNI override, then the handshake verifies and system CAs remain trusted
  - Given the insecure flag, then a persistent banner state is set on the profile and every receipt records it
- **Verification:**
  - `pnpm nx test net-truststore`
  - `pnpm nx run net-dialer:it --variant=tls --versions=4.3.6`

### M1-22 Dialer routes: ssh2, system OpenSSH -W, SOCKS5, HTTP CONNECT (CON-06)

- **Milestone (design):** M1 · **Wave:** M1-W2 · **Size:** L
- **Depends on:** M0-26
- **Goal:** One dialer for every socket, with tunnel routes and SNI preserved (DC-43).
- **Scope:** libs/engine/net-dialer/src/routes/{ssh2,openssh,socks5,http-connect,unix-forwarder}.ts; lab bastions in broker-lab compose
- **Interfaces:** DialRoute union; forwarder() for plain-TCP clients
- **Acceptance criteria:**
  - Given a two-hop SSH profile (lab bastions), then HTTP, AMQP 0-9-1 and AMQP 1.0 all traverse the tunnel with SNI preserved
  - Given system-OpenSSH mode with ProxyJump, then the connection succeeds on Linux, macOS and Windows runners; tunnelled 'local' access shows the guest/ANONYMOUS warning
- **Verification:**
  - `pnpm nx run net-dialer:it --routes=ssh2,openssh,socks5,http-connect`

### M1-23 Credential providers and TokenManager (CON-07 core, DC-37/38)

- **Milestone (design):** M1 · **Wave:** M1-W2 · **Size:** L
- **Depends on:** M0-44, M0-27, M0-22
- **Goal:** Pluggable credential providers with per-protocol token renewal and an unchanged-username assertion.
- **Scope:** libs/engine/svc-identity/src/{providers/{password,client-credentials,token-command,static-token,x509-external},token-manager,size-preflight}.ts
- **Interfaces:** CredentialProvider; TokenManager (refresh at 75 %, username claim asserted, renewal per protocol)
- **Acceptance criteria:**
  - Given a 4.3 broker with Keycloak, when the token nears expiry, then update-secret refreshes AMQP 0-9-1 without dropping taps and the username claim is unchanged
  - Given 4.2.5 or earlier, then the engine cancels its own consumers at expiry; given a Bearer above 4,000 B or a PLAIN response above the pre-auth frame limit, then a warning precedes use
- **Verification:**
  - `pnpm nx test svc-identity`
  - `pnpm nx run svc-identity:it --variant=oauth --versions=4.2.9,4.3.6`

### M1-24 OAuth discovery, PKCE loopback, device code, issuer pinning (DC-39)

- **Milestone (design):** M1 · **Wave:** M1-W2 · **Size:** M
- **Depends on:** M1-23, M0-45, M0-56
- **Goal:** Broker OAuth discovered from bootstrap.js, logged in through the system browser, with the issuer pinned.
- **Scope:** libs/engine/svc-identity/src/{discovery (bootstrap.js; /api/auth only on 4.1 and earlier),oauth-pkce-loopback,device-code,issuer-pin}.ts; desktop openExternal flow
- **Interfaces:** identity.login plan/execute; issuer allow-list per profile
- **Acceptance criteria:**
  - Given a broker advertising an issuer that is not on the allow-list, then login is blocked until the user confirms and pins it
  - Given a desktop login, then the system browser opens with PKCE S256 and a single-use 127.0.0.1:0 redirect; Okta and Auth0 presets fall back to fixed ports or device code
- **Verification:**
  - `pnpm nx test svc-identity --testNamePattern=oauth`
  - `pnpm nx e2e e2e-desktop --grep=@oauth`

### M1-25 Auth lab: Keycloak 26 variant and token expiry by protocol and version (U-14, U-15 part)

- **Milestone (design):** M1 · **Wave:** M1-W2 · **Size:** M
- **Depends on:** M1-23, M0-14
- **Goal:** Record real expiry and size-threshold behaviour before the TokenManager reaches GA.
- **Scope:** broker-lab oauth variant (Keycloak 26); apps/conformance/src/cells/auth/*.cell.ts (expiry per 0-9-1, 1.0 and stream x version; 431 and frame_too_large thresholds; ?token= on /api/definitions)
- **Interfaces:** CF-AUTH-* ids
- **Acceptance criteria:**
  - Given 3.13.7 through 4.3.6, then expiry behaviour per protocol is recorded and the registry auth cells are three-way green
  - Given oversized tokens, then the 431 and pre-auth frame thresholds are recorded and match the size-preflight constants
- **Verification:**
  - `pnpm nx run conformance:test --grep=CF-AUTH --versions=3.13.7,4.0.9,4.1.8,4.2.9,4.3.6`

### M1-26 Metrics engine: Prometheus adapter, ScrapePlanner, fallback, forecast (MON-01, MON-05 core)

- **Milestone (design):** M1 · **Wave:** M1-W2 · **Size:** L
- **Depends on:** M0-46, M0-23, M0-33, M0-26
- **Goal:** Prometheus-first, demand-driven metrics scraped per node, with management sampling as the fallback (DC-33, ADR-024).
- **Scope:** libs/engine/adapter-prometheus (streaming text parser in a worker above 1 MiB); libs/engine/svc-metrics/src/{scrape-planner,store-hot,topics/metrics.live}.ts; libs/shared/forecast
- **Interfaces:** metrics.live topic (latest); MetricsStore port (hot 1 h); forecast.drainEta (R2 at least 0.95)
- **Acceptance criteria:**
  - Given an Amazon MQ profile, then scrapes target ports 16001-16003 per node at 60 s or slower with no per-object endpoints; given an LB-fronted Service, then per-node targets are used or the source is marked partial
  - Given a steady decline, then the drain ETA has a confidence band; given R2 below 0.95, then 'no reliable forecast' is returned
- **Verification:**
  - `pnpm nx run-many -t test -p svc-metrics adapter-prometheus forecast`
  - `pnpm nx run perf:metrics-100k`

### M1-27 Tap planner, pure (TAP-01)

- **Milestone (design):** M1 · **Wave:** M1-W3 · **Size:** M
- **Depends on:** M1-02, M1-01, M0-62, M0-13
- **Goal:** Plan taps before creating them: refusals, policy-match simulation, badges and churn cost (DC-17/18/19).
- **Scope:** libs/shared/tap-planner/src/{plan,policy-match,badges,refusals,churn}.ts
- **Interfaces:** TapPlanner.plan returns TapPlan or PlanRejection; literal TapQueueSpec type
- **Acceptance criteria:**
  - Given a source of type x-consistent-hash, then the tap is refused unless diversion is explicitly accepted; E2E on CHX below 4.3.6 is never offered
  - Given a policy with reject-publish matching the tap name, then the plan shows the risk and the argument override; the name stays inside the configure regex and never starts with amq.
- **Verification:**
  - `pnpm nx test tap-planner`

### M1-28 Tap session, orphan sweep and churn budget (TAP-02)

- **Milestone (design):** M1 · **Wave:** M1-W3 · **Size:** L
- **Depends on:** M1-27, M0-43, M0-33
- **Goal:** A copied-binding exclusive classic tap with re-sync, bounded rings, leases and Khepri-friendly reuse (ADR-011).
- **Scope:** libs/engine/svc-tap/src/{module,actions/{taps.start,taps.stop},topics/{tap.messages,tap.stats},internal/{session,resync,sweeper,churn-bucket}}.ts
- **Interfaces:** tap.messages (sampled, credit); tap.stats (latest); lease of 10 min renewed by UI heartbeats
- **Acceptance criteria:**
  - Given a headers binding with x-match=all, then the tap binding carries the same arguments; bindings re-sync every 30 s and the tap queue is reused (rebind, no re-declare)
  - Given traffic through the default exchange, then the 'blind: default exchange' badge is shown and firehose is suggested; orphans carrying our session argument are swept at start and every 10 min
- **Verification:**
  - `pnpm nx test svc-tap`
  - `pnpm nx run svc-tap:it --versions=3.13.7,4.2.9,4.3.6`

### M1-29 Tap conformance cells and back-pressure load test (U-10, U-11 part)

- **Milestone (design):** M1 · **Wave:** M1-W3 · **Size:** M
- **Depends on:** M1-28, M0-37
- **Goal:** Prove tap behaviour on 5 versions and bound its effect on production publishers.
- **Scope:** apps/conformance/src/cells/tap/*.cell.ts; perf/tap-backpressure (10k-message tap, slow consumer, publisher latency); Amazon MQ tap check in providers.yml
- **Interfaces:** CF-TAP-* ids
- **Acceptance criteria:**
  - Given copied headers bindings, drop-head overflow, and exclusive classic coercion under a quorum default, then the cells are three-way green on 5 versions
  - Given a slow UI, then production publisher p99 latency stays within the documented bound and drops are counted in tap.stats
- **Verification:**
  - `pnpm nx run conformance:test --grep=CF-TAP --versions=3.13.7,4.0.9,4.1.8,4.2.9,4.3.6`
  - `pnpm nx run perf:tap-backpressure`

### M1-30 Stream browser via 0-9-1 x-stream-offset (STR-01)

- **Milestone (design):** M1 · **Wave:** M1-W3 · **Size:** M
- **Depends on:** M0-27, M0-43, M0-46, M0-62
- **Goal:** Anonymous stream reads with manual ack and prefetch above 0; never basic.get (DC-11, DC-22).
- **Scope:** libs/engine/svc-streams/src/{actions/{streams.read,stream-reads.pages},internal/{amqp091-reader,replica-helper,range-export}}.ts
- **Interfaces:** streams.read {start: offset|timestamp|first|last|next|interval} with paged results
- **Acceptance criteria:**
  - Given a 3.13.7 stream, when reading from a timestamp (seconds), then messages from that time are shown and no offset is stored
  - Given a node without a replica, then the error names the nodes that host one; basic.get is never sent to a stream
- **Verification:**
  - `pnpm nx test svc-streams`
  - `pnpm nx run svc-streams:it --versions=3.13.7,4.2.9,4.3.6`

### M1-31 Stream browser via AMQP 1.0 with filter echo (STR-02)

- **Milestone (design):** M1 · **Wave:** M1-W3 · **Size:** M
- **Depends on:** M1-07, M1-30, M1-08
- **Goal:** Server-side Bloom, property and SQL filters that fail closed when the broker ignores a filter (DC-23).
- **Scope:** libs/engine/svc-streams/src/internal/amqp10-reader.ts (Bloom 4.0+, properties 4.1+, SQL 4.2+; applied-filter check)
- **Interfaces:** streams.read {protocol: amqp10, filters}
- **Acceptance criteria:**
  - Given 4.3.6 with a Bloom filter, then the attach reply lists it as applied, or the read fails with 'broker ignored filter X' instead of scanning
  - Given 4.1.8, then SQL filters are refused with a version reason; property and SQL filters together are rejected as mutually exclusive
- **Verification:**
  - `pnpm nx run svc-streams:it --protocol=amqp10 --versions=4.0.9,4.1.8,4.2.9,4.3.6`

### M1-32 DLQ inventory, managed-by detection and hazard advisor (DLQ-01/08, DC-54)

- **Milestone (design):** M1 · **Wave:** M1-W3 · **Size:** M
- **Depends on:** M1-03, M1-12, M0-46
- **Goal:** Find DLQs and their sources, respect other operators, and block the 4.3 over-limit trap with a previewed fix.
- **Scope:** libs/engine/svc-dlq/src/{actions/{dlq.list,dlq.hazards,dlq.fix-delivery-limit},internal/{discovery,managed-by}}.ts
- **Interfaces:** dlq.list; dlq.hazards; dlq.fix-delivery-limit (plan with policy preview)
- **Acceptance criteria:**
  - Given a ServiceControl consumer on 'error', then the queue is badged 'managed by ServiceControl' and its actions are read-only; policies that set a DLX yield derived DLQs with their sources
  - Given a 4.3 QQ DLQ with default L=20 fed by a QQ with L=20, then a blocking finding offers the delivery-limit -1 policy with a preview; an nsb.* delivery-limit policy is never overridden
- **Verification:**
  - `pnpm nx test svc-dlq --testNamePattern='inventory|hazard'`
  - `pnpm nx run svc-dlq:it --versions=4.2.9,4.3.6`

### M1-33 Replay planner, pure (DLQ-03 planning, DC-27/28)

- **Milestone (design):** M1 · **Wave:** M1-W3 · **Size:** M
- **Depends on:** M1-04, M1-03, M0-62
- **Goal:** Queue-first destination resolution, header strip and stamp, pacing, and source gating.
- **Scope:** libs/shared/replay-planner/src/{destination,headers,pacing,source-gating}.ts
- **Interfaces:** ReplayPlanner.plan returns PlanDraft<ReplayPlanPreview> or PlanRejection
- **Acceptance criteria:**
  - Given a dead letter, then the destination resolves framework field, then newest rejected/delivery_limit x-death entry, then naming convention, and publishes through the default exchange; exchange replay requires fanOutConfirmed
  - Given a replay, then x-death*, x-delivery-count, x-acquired-count and a mismatched user_id are stripped and messageId is preserved; a finite-L 4.3 source at over-limit risk is refused and the fix is offered
- **Verification:**
  - `pnpm nx test replay-planner`

### M1-34 Replay job (basic) with park-by-confirm and at-least-once journal (DLQ-03)

- **Milestone (design):** M1 · **Wave:** M1-W3 · **Size:** L
- **Depends on:** M1-33, M0-31, M0-43, M1-09, M1-18
- **Goal:** Confirm-then-ack replay that never nack-flushes finite-L QQ sources (ADR-010).
- **Scope:** libs/engine/svc-dlq/src/{jobs/replay,internal/{journal,park}}.ts; migration replay_journal
- **Interfaces:** ReplayJournal (multiset per occurrence key); '<product>.parked'; source lease with prefetch 1 for finite-L QQs
- **Acceptance criteria:**
  - Given a basic.return or a nack, then the source is not acked and the message is parked by confirm-then-ack; finite-L QQ sources use prefetch 1 and are never nack-flushed on cancel or drain
  - Given a crash mid-replay, then on resume the journal allows ack-without-republish only for confirmed copies with the same replay-id; otherwise it republishes and marks uncertain-duplicate
- **Verification:**
  - `pnpm nx test svc-dlq --testNamePattern=replay`
  - `pnpm nx run svc-dlq:it --versions=4.2.9,4.3.6`

### M1-35 Replay conformance cells (CF-DLQ-*, U-19 part)

- **Milestone (design):** M1 · **Wave:** M1-W3 · **Size:** M
- **Depends on:** M1-34, M0-37
- **Goal:** Prove no loss under cancel, shutdown and crash mid-flight on finite-L QQ DLQs.
- **Scope:** apps/conformance/src/cells/dlq/*.cell.ts: cancel, shutdown and crash mid-flight; basic.return; header stripping; survival of a copied x-delivery-count
- **Interfaces:** CF-DLQ-* ids
- **Acceptance criteria:**
  - Given a crash mid-flight on a 4.3.6 finite-L QQ DLQ, then no message is lost and any duplicates are journaled as uncertain-duplicate
  - Given stripping enabled, then replayed copies carry no broker-managed counters on any version
- **Verification:**
  - `pnpm nx run conformance:test --grep=CF-DLQ --versions=3.13.7,4.0.9,4.1.8,4.2.9,4.3.6`

### M1-36 Queue and exchange admin actions (ADM-01/02 engine)

- **Milestone (design):** M1 · **Wave:** M1-W3 · **Size:** M
- **Depends on:** M1-01, M0-24, M0-35
- **Goal:** Type-aware declare, two-phase purge with a receipt, and delete with a dependents list.
- **Scope:** libs/engine/svc-admin/src/actions/{queues.declare,queues.purge,queues.delete,exchanges.declare,exchanges.delete,bindings.create,bindings.delete}.ts
- **Interfaces:** queues.purge (planning required, typed phrase in prod); exchanges.delete returns dependents in its plan preview
- **Acceptance criteria:**
  - Given 4.3, then x-queue-mode and other denied arguments are rejected with a reason, and deprecated arguments are flagged by version
  - Given a purge on PROD, then a plan with a typed phrase is required and a receipt is stored; an exchange delete with bindings lists its dependents first
- **Verification:**
  - `pnpm nx test svc-admin`
  - `pnpm nx run svc-admin:it --versions=3.13.7,4.2.9,4.3.6`

### M1-37 Alternative peek paths: HTTP fallback (MSG-13) and AMQP 1.0 credit-1 step

- **Milestone (design):** M1 · **Wave:** M1-W3 · **Size:** M
- **Depends on:** M1-16, M1-07, M1-06
- **Goal:** Product-aware HTTP /get only when AMQP is unreachable, and an opt-in 1.0 path that steps credit 1 (DC-10, DC-25, DC-55).
- **Scope:** libs/engine/svc-peek/src/internal/{http-fallback,amqp10-step}.ts
- **Interfaces:** PeekRequest.prefer http-fallback|amqp10-step
- **Acceptance criteria:**
  - Given LavinMQ, then the /get body includes ackmode and requeue:true; given a 4.3 QQ DLQ at over-limit risk, then the HTTP fallback is hidden with a reason
  - Given the opt-in 1.0 path on 4.3.6, then each step grants credit 1, drains, and settles with released only
- **Verification:**
  - `pnpm nx test svc-peek --testNamePattern='http-fallback|amqp10-step'`
  - `pnpm nx run conformance:test --grep=CF-PEEK-ALT --versions=4.2.9,4.3.6`

### M1-38 Peek hardening: chaos S-09 and executor mutation testing (U-04)

- **Milestone (design):** M1 · **Wave:** M1-W3 · **Size:** M
- **Depends on:** M1-18
- **Goal:** Show over thousands of faulted runs that receipts match real counter deltas, and that the test suite kills safety mutants.
- **Scope:** apps/chaos (toxiproxy, leader transfer, HAProxy, 3-node compose) target peek-down-race; Stryker targets svc-peek and peek-planner; .github/workflows/chaos-nightly.yml
- **Interfaces:** Targets chaos:peek-down-race and svc-peek:mutation
- **Acceptance criteria:**
  - Given 2,000 peeks under faults on 4.2.9 and 4.3.6, then the observed DC/AC deltas match the receipts with zero unexplained failed-delivery counts
  - Given the mutant list (nack to reject, no barrier, close before barrier, '>' to '>=' in isDoomed, skip DLX-source check, ack without proof, credit above 1), then each one is killed
- **Verification:**
  - `pnpm nx run chaos:peek-down-race --runs=2000`
  - `pnpm nx run svc-peek:mutation`

### M1-39 Workspace queries, export and import with redaction (MSG-10)

- **Milestone (design):** M1 · **Wave:** M1-W3 · **Size:** M
- **Depends on:** M1-09, M1-10
- **Goal:** Search, facet and export captured messages without leaking masked fields.
- **Scope:** libs/engine/svc-messages/src/actions/{captures.query,captures.export,captures.import}.ts (JSONPath/CEL subset, facets, saved queries; JSON, NDJSON, CSV, TSV, XLSX through a licence-gated writer)
- **Interfaces:** captures.query; captures.export writes to a PlatformBridge file token and never crosses the port
- **Acceptance criteria:**
  - Given 50k captured messages, when filtering by a JSONPath, then results return within 1 s
  - Given an export with redaction rules, then masked fields never appear in the file (scanner test)
- **Verification:**
  - `pnpm nx test svc-messages --testNamePattern='query|export'`

### M1-40 Extract (consume to workspace) job (MSG-11)

- **Milestone (design):** M1 · **Wave:** M1-W3 · **Size:** M
- **Depends on:** M1-09, M0-31, M0-43, M1-36
- **Goal:** A destructive extract that writes each message durably before its ack, with a typed confirm in prod.
- **Scope:** libs/engine/svc-messages/src/jobs/extract.ts; extract-before-purge option for queues.purge
- **Interfaces:** messages.extract (job; resumable; throttled)
- **Acceptance criteria:**
  - Given a crash mid-extract, then every acked message exists in the journal (fsync before ack)
  - Given a PROD profile, then extract requires an armed lock and the typed queue name
- **Verification:**
  - `pnpm nx test svc-messages --testNamePattern=extract`
  - `pnpm nx run svc-messages:it --versions=4.3.6`

### M1-41 Command registry, palette, keymap and native menus (EXP-04)

- **Milestone (design):** M1 · **Wave:** M1-W1 · **Size:** M
- **Depends on:** M0-51
- **Goal:** A VS Code-style command system shared by the palette, shortcuts and native menus.
- **Scope:** libs/ui/commands (CommandRegistry with when-contexts; tinykeys 4.0.1; JSON keymap; cheat sheet; browser-safe alternates); PlatformBridge.setMenu
- **Interfaces:** CommandRegistry.register({id, title, category, when, keybinding, run})
- **Acceptance criteria:**
  - Given the query 'abau', then account.balance.update ranks first with highlights (engine search)
  - Given the browser build, then no default binding collides with the reserved-chord test list, and native menus are generated from the registry
- **Verification:**
  - `pnpm nx test ui-commands`
  - `pnpm nx e2e e2e-web --grep=@palette`

### M1-42 Deep links, linked navigation and entity detail tabs (EXP-05/06)

- **Milestone (design):** M1 · **Wave:** M1-W1 · **Size:** M
- **Depends on:** M0-51, M0-54
- **Goal:** Every entity is a link, and every entity type has its tab set, with gated tabs explaining why they are disabled.
- **Scope:** apps/web routes, breadcrumbs and history; app:// handoff via PlatformBridge.onDeepLink; detail-tab framework in libs/ui/feature-explorer (queue, exchange and stream tab sets)
- **Interfaces:** Route schema /c/:cid/queues/:qkey/:tab
- **Acceptance criteria:**
  - Given a stream, then Messages is replaced by Browse and no get-based action is reachable; a gated tab shows its why-disabled reason
  - Given an app:// link clicked in the OS, then the desktop app focuses the entity; a copied web deep link opens the same entity and tab
- **Verification:**
  - `pnpm nx e2e e2e-web --grep=@navigation`
  - `pnpm nx e2e e2e-desktop --grep=@deeplink`

### M1-43 Error explainer, inline docs and show-as-curl (EXP-07)

- **Milestone (design):** M1 · **Wave:** M1-W2 · **Size:** S
- **Depends on:** M1-42, M0-13
- **Goal:** Translate broker errors into fixes, and show every action as curl, rabbitmqadmin or a definitions snippet.
- **Scope:** libs/ui/feature-explorer/explainer; error catalogue in contracts; show-as generators with masking
- **Interfaces:** explain(problem) returns {cause, fix, docs}
- **Acceptance criteria:**
  - Given PRECONDITION_FAILED for an inequivalent argument, then the explainer shows the differing argument and a fix
  - Given a queue declare form, when 'Show as curl' is clicked, then an equivalent masked curl command is produced
- **Verification:**
  - `pnpm nx test feature-explorer --testNamePattern=explainer`

### M1-44 Message workbench UI: plan review, consent, disposition, results, receipts (MSG-02..06 UI)

- **Milestone (design):** M1 · **Wave:** M1-W3 · **Size:** L
- **Depends on:** M1-16, M1-42
- **Goal:** The side-effect-aware peek experience: plan before, receipt after, behind the 'peek' flag until M1-18 is green.
- **Scope:** libs/ui/feature-messages (PlanReviewPanel with W-ids, consents, disposition picker and typed phrase; results grid; receipt drawer); feature flag 'peek'
- **Interfaces:** Uses messages.peek plan/execute and receipts/{id}
- **Acceptance criteria:**
  - Given a 4.2.9 QQ with L=20, when the user declines W-BUDGET consent, then no peek executes; given consent, then the receipt drawer shows AC+1 per message
  - Given any plan, then the label 'side-effect-aware peek - messages stay in the queue' is shown and 'non-destructive' never appears
- **Verification:**
  - `pnpm nx e2e e2e-web --grep=@peek`

### M1-45 Message viewer and diff, ui-payload (MSG-07)

- **Milestone (design):** M1 · **Wave:** M1-W2 · **Size:** M
- **Depends on:** M1-10, M1-09, M0-51
- **Goal:** View any payload safely, including multi-megabyte bodies and conversion-loss disclosures (DC-26).
- **Scope:** libs/ui/payload (JSON tree, raw, hex, text; 0-9-1 properties and headers or 1.0 sections; deaths timeline; virtualised viewer above 2 MiB; 1 MiB chunks; two-message diff)
- **Interfaces:** <app-payload-viewer>; blobs/{ref}?offset&length
- **Acceptance criteria:**
  - Given a 10 MB body, then the preview is truncated and the full body streams on demand with no long task above 50 ms
  - Given a stream message published via 0-9-1 with table headers, then a 'headers lost at write' badge is shown
- **Verification:**
  - `pnpm nx test ui-payload`
  - `pnpm nx e2e e2e-web --grep=@viewer`

### M1-46 Monaco ESM wrapper and publish studio UI with history (PUB-01/02 UI)

- **Milestone (design):** M1 · **Wave:** M1-W3 · **Size:** M
- **Depends on:** M1-19, M0-20, M1-42
- **Goal:** VS Code-grade editing for publishing, with honest outcomes.
- **Scope:** libs/ui/editor (Monaco 0.57 ESM; JSON/XML/YAML workers; diff editor; disposal); libs/ui/feature-messages/publish (typed props, header grid, routing-key autocomplete from bindings, mandatory and confirm, N copies, history)
- **Interfaces:** <app-code-editor>; uses messages.publish and publish-history.*
- **Acceptance criteria:**
  - Given mandatory and no binding match, then the UI shows 'returned: NO_ROUTE', and confirmed, nacked and returned are distinguished
  - Given 'Send again', then the studio is prefilled; Monaco stays a lazy chunk of at most 1.1 MB
- **Verification:**
  - `pnpm nx e2e e2e-web --grep=@publish`
  - `pnpm nx run web:budgets`

### M1-47 Tap UI: live feed, badges and stats (TAP-01/02 UI)

- **Milestone (design):** M1 · **Wave:** M1-W4 · **Size:** M
- **Depends on:** M1-28, M1-42, M1-45
- **Goal:** A responsive live tap with visible sampling and drops, and blind-spot badges.
- **Scope:** libs/ui/feature-tap (plan review, live ring outside the signal graph with rAF snapshots, sampling and dropped counters, badges, stop and stop-all)
- **Interfaces:** LiveClient.subscribe('tap.messages'), 'tap.stats'
- **Acceptance criteria:**
  - Given 2,000 msg/s, then rendering samples with visible counters and the renderer stays responsive
  - Given blind-spot and masking conditions, then the matching badges are shown with explanations
- **Verification:**
  - `pnpm nx e2e e2e-web --grep=@tap`
  - `pnpm nx run perf:tap-render`

### M1-48 Stream browser UI (STR-01/02 UI)

- **Milestone (design):** M1 · **Wave:** M1-W4 · **Size:** M
- **Depends on:** M1-30, M1-31, M1-42, M1-45
- **Goal:** Browse streams by offset or time, with visible applied filters and a replica helper.
- **Scope:** libs/ui/feature-streams (start offset/timestamp/first/last/next/interval, filters, live tail, range export, replica helper)
- **Interfaces:** Uses streams.read and stream-reads.pages
- **Acceptance criteria:**
  - Given 'browse from timestamp', then messages from that time load in pages and the applied filters are shown
  - Given a 'broker ignored filter' failure, then it is shown verbatim and no scan starts
- **Verification:**
  - `pnpm nx e2e e2e-web --grep=@streams`

### M1-49 ui-graph and topology view (TOP-01)

- **Milestone (design):** M1 · **Wave:** M1-W3 · **Size:** L
- **Depends on:** M1-20, M1-11
- **Goal:** A scalable topology graph with an unmodified ELK worker and an accessible alternative (DC-51/52).
- **Scope:** libs/ui/graph (Cytoscape 3.34.4, WebGL2 detection plus canvas fallback, ELK 0.12.0 unmodified worker asset with the EPL notice, dagre fallback, LOD); libs/ui/feature-topology (focus upstream/downstream; export PNG/SVG/Mermaid; accessible tree)
- **Interfaces:** <app-graph>; uses topology.subgraph
- **Acceptance criteria:**
  - Given 5k elements, then layout completes off the main thread and pan/zoom stays above 30 fps
  - Given a screen reader, then the tree alternative exposes the same edges; elk-worker.min.js ships unmodified (hash check) with its licence
- **Verification:**
  - `pnpm nx e2e e2e-web --grep=@topology`
  - `pnpm nx run perf:graph-5k`
  - `pnpm nx run supply-chain:elk-asset-check`

### M1-50 Routing simulator UI, routing tab, binding CRUD, effective-config view (TOP-02/03, POL-01 UI)

- **Milestone (design):** M1 · **Wave:** M1-W4 · **Size:** M
- **Depends on:** M1-49, M1-20
- **Goal:** Explain where messages go and why each config value applies.
- **Scope:** libs/ui/feature-topology/{simulator,routing-tab}; libs/ui/feature-explorer/effective-config; binding CRUD using svc-admin bindings.*
- **Interfaces:** Uses routing.simulate, effective-config.get, bindings.create/delete
- **Acceptance criteria:**
  - Given a headers binding, then its arguments are editable as typed fields; a delete on PROD needs a typed confirm
  - Given a 4.0.8 QQ (argument 500, policy 1000), then the effective-config view shows 500 with 'min' provenance
- **Verification:**
  - `pnpm nx e2e e2e-web --grep='@routing|@effective-config'`

### M1-51 DLQ centre basics UI (DLQ-01/02/03/08 UI)

- **Milestone (design):** M1 · **Wave:** M1-W4 · **Size:** M
- **Depends on:** M1-32, M1-34, M1-44
- **Goal:** Inventory, death timelines, the hazard advisor and replay dry runs in one place.
- **Scope:** libs/ui/feature-dlq (inventory, death timeline, hazard advisor with fix preview, replay dry run, job progress, parked-queue view)
- **Interfaces:** Uses dlq.*, replay plan/execute, jobs.*
- **Acceptance criteria:**
  - Given a replay dry run, then the frozen message list, the destination resolution and the stripped headers are shown before execution
  - Given a managed-by badge, then replay and purge controls are disabled with the reason
- **Verification:**
  - `pnpm nx e2e e2e-web --grep=@dlq`

### M1-52 Admin UI: queue and exchange wizards with typed confirms (ADM-01/02 UI)

- **Milestone (design):** M1 · **Wave:** M1-W4 · **Size:** M
- **Depends on:** M1-36, M1-42
- **Goal:** Safe CRUD with version-aware forms.
- **Scope:** libs/ui/feature-admin (type-aware declare wizard; purge and delete with typed confirm; extract-before-purge option; dependents list)
- **Interfaces:** Uses queues.*, exchanges.*
- **Acceptance criteria:**
  - Given 4.3, then x-queue-mode is rejected in the form with a reason
  - Given a purge on PROD, then the queue name must be typed and the receipt opens afterwards
- **Verification:**
  - `pnpm nx e2e e2e-web --grep=@admin`

### M1-53 Connections UI: TLS/mTLS, tunnels and auth providers (CON-05..07 UI)

- **Milestone (design):** M1 · **Wave:** M1-W3 · **Size:** M
- **Depends on:** M1-21, M1-22, M1-24, M0-52
- **Goal:** Configure trust, tunnels and identity providers with clear safety prompts.
- **Scope:** libs/ui/feature-connections/{tls,tunnel,auth} panels; certificate diagnostics view; OAuth login and issuer-pin dialog
- **Interfaces:** Uses tls.diagnostics, identity.login, connections.update
- **Acceptance criteria:**
  - Given the insecure switch, then a persistent banner is shown in every view for that profile
  - Given an unknown issuer, then the pin dialog names the issuer and blocks login until the user confirms
- **Verification:**
  - `pnpm nx e2e e2e-web --grep=@connections-advanced`

### M1-54 Live charts and forecast overlay (MON-02/05 UI)

- **Milestone (design):** M1 · **Wave:** M1-W3 · **Size:** M
- **Depends on:** M1-26, M0-51
- **Goal:** Cheap live charts that explain metric gaps and show drain forecasts.
- **Scope:** libs/ui/charts (uPlot 1.6.32 directive; setData in rAF; coalesced updates); libs/ui/feature-metrics (queue charts, ranges, forecast overlay, gap explanations)
- **Interfaces:** Uses metrics.live and metrics.queries
- **Acceptance criteria:**
  - Given 50 charts at 1 Hz, then renderer CPU stays below 20 %
  - Given stats off and no Prometheus, then each chart explains the gap
- **Verification:**
  - `pnpm nx e2e e2e-web --grep=@charts`
  - `pnpm nx run perf:charts-50`

### M1-55 Jobs and Receipts panels, workspace browser UI (MSG-10/11 UI)

- **Milestone (design):** M1 · **Wave:** M1-W4 · **Size:** M
- **Depends on:** M1-16, M1-39, M1-40
- **Goal:** Make jobs, receipts and captured messages first-class in the bottom panel and workspace.
- **Scope:** libs/ui/feature-jobs (bottom-panel Jobs and Receipts); libs/ui/feature-messages/workspace (captures, facets, saved queries, export dialog, extract)
- **Interfaces:** Uses jobs.*, receipts/{id}, captures.*
- **Acceptance criteria:**
  - Given a running extract or replay, then progress, pause/resume/cancel and journal links appear in the Jobs panel
  - Given a receipt id from a peek, then the Receipts panel opens the 'What happened' drawer
- **Verification:**
  - `pnpm nx e2e e2e-web --grep='@jobs|@workspace'`

### M1-56 Accessibility programme (PLAT-13)

- **Milestone (design):** M1 · **Wave:** M1-W5 · **Size:** M
- **Depends on:** M1-44, M1-46, M1-47, M1-51, M1-53
- **Goal:** WCAG 2.2 AA for the core flows, enforced in CI.
- **Scope:** e2e-web keyboard-only flows (connect, peek, publish, tap, replay); axe on all routes and the gallery; focus-management audit; target sizes; canvas alternatives
- **Interfaces:** Tag @a11y
- **Acceptance criteria:**
  - Given the core flows, then each can be completed with the keyboard only (E2E)
  - Given axe in CI, then there are 0 serious or critical violations on every route
- **Verification:**
  - `pnpm nx e2e e2e-web --grep=@a11y`

### M1-57 i18n and theming (PLAT-14)

- **Milestone (design):** M1 · **Wave:** M1-W5 · **Size:** M
- **Depends on:** M0-50, M1-46, M1-49, M1-54
- **Goal:** A pseudo-locale-clean UI, with themes and density applied across every rendering library.
- **Scope:** Transloco pseudo-locale build, ICU plurals, locale formats, RTL-safe logical CSS; ThemeService tokens pushed to AG Grid, Monaco, uPlot, ECharts and Cytoscape; density modes
- **Interfaces:** web build configuration 'pseudo'
- **Acceptance criteria:**
  - Given a pseudo-locale build, then no hard-coded string is found (E2E text scan)
  - Given the high-contrast theme, then all text tokens pass 7:1 across the grid, editor, charts and graph
- **Verification:**
  - `pnpm nx run web:build --configuration=pseudo`
  - `pnpm nx e2e e2e-web --grep=@i18n`

### M1-58 Docs: quickstarts, W-* pages, semantics guides, provider matrix, per-release matrix (PLAT-15)

- **Milestone (design):** M1 · **Wave:** M1-W5 · **Size:** M
- **Depends on:** M0-62, M1-18
- **Goal:** Documentation that is generated from the registry and the conformance results.
- **Scope:** apps/docs (quickstart per mode; peek by era; taps and their blind spots; DLQ replay; provider x capability matrix; security model; outbound calls; W-* pages generated from the registry)
- **Interfaces:** Target docs:check-warnings
- **Acceptance criteria:**
  - Given every W-* code in the registry, then a docs page explains it (generated check)
  - Given a release, then the docs are rebuilt with that release's conformance matrix
- **Verification:**
  - `pnpm nx build docs`
  - `pnpm nx run docs:check-warnings`

### M1-59 Beta to 1.0 'Developer': parity checklist, time-to-first-peek, channels, devtools listing

- **Milestone (design):** M1 · **Wave:** M1-W5 · **Size:** M
- **Depends on:** M1-56, M1-57, M1-58, M1-38, M1-35, M1-29, M0-68
- **Goal:** Meet the M1 exit criteria and ship publicly on every channel.
- **Interfaces:** Release channel 'stable'
- **Acceptance criteria:**
  - Given usability tests on Windows, macOS, Linux and npx, then median install-to-first-receipt is under 3 minutes
- **Verification:**
  - `pnpm nx e2e e2e-web --grep=@parity`
  - `gh workflow run release.yml -f channel=stable`

### M2-01 Epic: Admin parity I: vhosts, users, permissions, access evaluator (ADM-04/05/06)

- **Milestone (design):** M2 · **Wave:** M2-W1 · **Size:** L
- **Depends on:** M1-36, M1-01
- **Goal:** Native vhost, user and permission management with DC-21 GET-merge-PUT and a 'can X do Y' evaluator.
- **Scope:** libs/engine/svc-admin (vhosts, users, user-limits, permissions, topic-permissions, access.evaluate); libs/ui/feature-admin
- **Interfaces:** vhosts.update (GET-merge-PUT); users.*; permissions.*; access.evaluate
- **Acceptance criteria:**
  - Given a vhost with default queue type quorum, when its description is edited, then the default stays quorum on 4.1.8, 4.2.9 and 4.3.6
  - Given a protected user (4.2+) or 'guest' on Amazon MQ, then edit, delete or create is blocked with a reason; given user X and queue Y, then the evaluator answers per action with the matching regex
- **Verification:**
  - `pnpm nx run conformance:test --grep=CF-OPS-VHOST --versions=4.1.8,4.2.9,4.3.6`
  - `pnpm nx e2e e2e-web --grep=@admin-access`

### M2-02 Epic: Admin parity II: connections/channels/sessions, consumers, nodes, health checks, feature flags (ADM-07/08/09/10/14)

- **Milestone (design):** M2 · **Wave:** M2-W1 · **Size:** L
- **Depends on:** M0-48, M1-26
- **Goal:** Runtime views that degrade correctly with stats off and behind load balancers.
- **Scope:** svc-admin runtime actions; feature-admin runtime views
- **Interfaces:** connections.close (with reason); health.run; feature-flags.enable (typed confirm)
- **Acceptance criteria:**
  - Given stats off on 4.3.5, then the channels view shows a degraded mode, not an error
  - Given DELETE /api/reset, then it is labelled 'reset management statistics' with a confirm; given an LB-fronted cluster, then node-local health checks are labelled
- **Verification:**
  - `pnpm nx run svc-admin:it --versions=3.13.7,4.0.9,4.1.8,4.2.9,4.3.6`
  - `pnpm nx e2e e2e-web --grep=@admin-runtime`

### M2-03 Epic: Admin parity III: definitions, shovels/federation, QQ replica ops, CLI runbooks, bulk ops (ADM-03/11/12/13/15)

- **Milestone (design):** M2 · **Wave:** M2-W2 · **Size:** L
- **Depends on:** M2-01, M2-02
- **Goal:** Close the parity gap with the official UI; CLI-only operations become generated runbooks.
- **Scope:** svc-admin (definitions export/import with synthetic mode, shovels, federation, qq-replicas, runbooks, bulk jobs); feature-admin
- **Interfaces:** definitions.export/import (preview); bulk.* jobs with dry run
- **Acceptance criteria:**
  - Given a policymaker user, then a labelled synthetic export is produced, and an import preview lists additions and changes
  - Given 200 selected queues, then the bulk dry run lists them, the run reports per-item results, and resume skips items that already succeeded; the official UI 4.3.6 parity checklist is 100% covered
- **Verification:**
  - `pnpm nx e2e e2e-web --grep=@parity-official`
  - `pnpm nx run svc-admin:it --testNamePattern=bulk --versions=4.3.6`

### M2-04 Epic: Policy and operator-policy editor with impact preview (POL-02/03)

- **Milestone (design):** M2 · **Wave:** M2-W1 · **Size:** L
- **Depends on:** M1-01, M1-32
- **Goal:** Schema-aware policy editing that shows its blast radius before save.
- **Scope:** svc-admin policies.*; libs/ui/feature-admin/policies
- **Interfaces:** policies.plan returns an impact diff
- **Acceptance criteria:**
  - Given 4.3.0, then delayed-retry keys are not offered; given equal-priority matches, then a tie warning is shown
  - Given a draft, then a diff of affected queues and effective values is shown before save, and upgraded unlimited QQs are named (W-UPGRADED)
- **Verification:**
  - `pnpm nx test svc-admin --testNamePattern=policy`
  - `pnpm nx e2e e2e-web --grep=@policies`

### M2-05 Epic: Taps and streams advanced: E2E tap, firehose leases, filter builder, stream ops (TAP-03/04, STR-03/05)

- **Milestone (design):** M2 · **Wave:** M2-W1 · **Size:** L
- **Depends on:** M1-28, M1-31
- **Goal:** Exchange-wide and firehose capture with leases, plus stream filter composition and operations.
- **Scope:** svc-tap (e2e mode, firehose leases per node via the rabbitmq_tracing node routes or runbooks); svc-streams (filter builder, super streams, ops panel)
- **Interfaces:** firehose/leases; streams.super.create
- **Acceptance criteria:**
  - Given a 4.3.4 CHX source, then E2E mode is unavailable with a citation; given a 3-node cluster with tracing, when the lease expires, then tracing is off on all nodes and verified
  - Given 4.1+, then a super stream with N partitions can be created; given 4.1.8, then SQL filters are disabled with a version reason
- **Verification:**
  - `pnpm nx run conformance:test --grep='CF-TAP-E2E|CF-FIREHOSE' --versions=4.2.9,4.3.6`
  - `pnpm nx e2e e2e-web --grep=@streams-advanced`

### M2-06 Epic: DLQ operations centre: full replay engine, edit and resend, move/copy/selective delete, local-shovel lab (DLQ-04/09, MSG-12, U-06)

- **Milestone (design):** M2 · **Wave:** M2-W1 · **Size:** L
- **Depends on:** M1-34, M1-35, M1-40
- **Goal:** Dry runs on frozen identities, canaries, auto-pause and honest undo; message moves with confirm-then-ack.
- **Scope:** svc-dlq (replay engine full, undo), svc-messages (move/copy/selective delete); chaos replay-10k; CF-SHOVEL-CARRY cells
- **Interfaces:** replay jobs with dryRun, canary, observeMs; messages.move/copy/delete-selected
- **Acceptance criteria:**
  - Given 5 replayed ids reappearing in the DLQ, then the job pauses and lists them; undo re-parks journaled copies and is audited
  - Given 10k replays under toxiproxy chaos, then there are zero lost and zero duplicate messages after journal dedupe; local-shovel carry-over is recorded as evidence
- **Verification:**
  - `pnpm nx run chaos:replay-10k`
  - `pnpm nx run conformance:test --grep='CF-DLQ|CF-SHOVEL' --versions=4.2.9,4.3.6`

### M2-07 Epic: Plugin SDK v1, plugin host tiers 1-3, framework decoders v1.0, header registry, fingerprinting (EXT-01, DLQ-05/07, S-12, U-19/U-20)

- **Milestone (design):** M2 · **Wave:** M2-W1 · **Size:** L
- **Depends on:** M1-10, M1-04, M1-34
- **Goal:** A data-first decoder ecosystem with a real sandbox for third-party code (ADR-022).
- **Scope:** libs/sdk/{plugin-sdk,header-registry}; libs/engine/plugin-host (QuickJS tier 3); libs/engine/decoders (generic, MassTransit, Spring, NServiceBus, EasyNetQ, Celery); testing/fixture-apps
- **Interfaces:** DecoderPlugin and CodecPlugin apiVersion 1; header-registry.json
- **Acceptance criteria:**
  - Given MassTransit v8 fixtures from CI apps, then exception type, message and consumer are extracted; an expired nsb.v2.delay-level-05 death is classified as scheduled, not failed
  - Given a sample decoder from the template, then it loads in desktop, local and team modes; a throwing or looping tier-3 plugin is terminated and the engine stays healthy
- **Verification:**
  - `pnpm nx run-many -t test -p decoders plugin-host`
  - `pnpm nx run fixture-apps:decode --frameworks=masstransit8,spring,nservicebus,easynetq,celery`

### M2-08 Epic: Publish and codecs advanced (PUB-03..07, MSG-09)

- **Milestone (design):** M2 · **Wave:** M2-W2 · **Size:** L
- **Depends on:** M1-19, M2-07
- **Goal:** Collections, bulk publishing, consumer/RPC bench, AMQP 1.0 publisher, copy-as-code, Protobuf and Avro.
- **Scope:** svc-messages (collections, bulk publish jobs, consumer bench, rpc), adapter-amqp10 publisher, decoders (protobuf, avro), copy-as-code fixtures
- **Interfaces:** collections file format (git-friendly); bulk.publish job
- **Acceptance criteria:**
  - Given a collection file in git, then variables resolve per environment and the CLI runs it headless; given 100k rows at 500/s, then bulk publish resumes after a restart without duplicates
  - Given a descriptor set and a type rule, then a protobuf message decodes and re-encodes byte-identical; each copy-as-code snippet compiles in its CI fixture
- **Verification:**
  - `pnpm nx run-many -t test -p svc-messages decoders`
  - `pnpm nx run copy-as-code:compile-fixtures`

### M2-09 Epic: Connectivity and providers: Kubernetes discovery, provider adapters and presets, provider contract suite v1 (CON-08/09, U-11/12/13)

- **Milestone (design):** M2 · **Wave:** M2-W1 · **Size:** L
- **Depends on:** M1-22, M0-63
- **Goal:** First-class managed-broker and Kubernetes support, gated by evidence.
- **Scope:** libs/engine/adapter-k8s; svc-connections presets (Amazon MQ, CloudAMQP, IBM, LavinMQ, ApsaraMQ AMQP-only); providers.yml expansion
- **Interfaces:** discovery.k8s; provider presets as registry data
- **Acceptance criteria:**
  - Given a kubeconfig with a RabbitmqCluster, then a profile with per-pod forwards is created, and no Secret is read without consent
  - Given Amazon MQ 4.x, then budgets assume 10 consumers per channel and 512 KiB messages; given LavinMQ, then the HTTP get adapter always sends requeue:true
- **Verification:**
  - `pnpm nx run adapter-k8s:it --kind`
  - `gh workflow run providers.yml -f targets=amazon-mq,cloudamqp,lavinmq`

### M2-10 Epic: Local IPC with mutual HMAC, tool CLI, read-only local MCP (EXT-02, AI-01, S-08)

- **Milestone (design):** M2 · **Wave:** M2-W1 · **Size:** L
- **Depends on:** M0-36, M0-29
- **Goal:** A headless CLI and a metadata-only MCP shim over an authenticated pipe or socket, never TCP (DC-35/42, ADR-017/023).
- **Scope:** libs/engine/transport/src/ipc (UDS / named pipe, HMAC handshake, capability tokens); apps/cli (export, diff, tail, jobs, doctor, mcp); libs/engine/svc-mcp (tools-only JSON-RPC subset)
- **Interfaces:** run/engine.json (0600); capability tokens (read-only by default)
- **Acceptance criteria:**
  - Given an impostor socket or pipe, then the CLI refuses before sending anything; given no running engine, then the CLI starts one on demand
  - Given an MCP client, then tools accept only opaque profile ids, and no peek tool is exposed in read-only mode (SDK-oracle conformance)
- **Verification:**
  - `pnpm nx run transport:it --testNamePattern=ipc`
  - `pnpm nx run svc-mcp:it`

### M2-11 Epic: Free web utilities (PLAT-16; definitions linter and upgrade checker follow in M4)

- **Milestone (design):** M2 · **Wave:** M2-W2 · **Size:** L
- **Depends on:** M1-03, M1-01, M1-04
- **Goal:** Static, privacy-first utilities that reuse the pure libraries.
- **Scope:** apps/utilities (x-death decoder, routing tester, policy tester, URI builder, delivery-limit era explainer) on GitHub Pages
- **Interfaces:** Reuses @app/deaths, @app/routing, @app/effective-config
- **Acceptance criteria:**
  - Given pasted headers, then decoding happens client-side with zero network requests
  - Given shared fixtures, then the routing tester's results equal the in-app simulator's
- **Verification:**
  - `pnpm nx e2e utilities-e2e`
  - `pnpm nx test routing`

### M3-01 Epic: Team mode runtime (TEAM-01)

- **Milestone (design):** M3 · **Wave:** M3-W1 · **Size:** L
- **Depends on:** M0-36, M0-21, M0-31
- **Goal:** The same engine on Postgres, with zod TeamServerConfig, a migrations Job under the DDL role, single-replica Recreate deployment, readiness and SIGTERM drain.
- **Scope:** apps/engine/src/modes/team.ts; persistence pg (partitions, DML-only app role); packaging/docker/compose.yaml with postgres:17
- **Interfaces:** TeamServerConfig (env > *_FILE > file); /healthz, /readyz
- **Acceptance criteria:**
  - Given docker compose up with Postgres, then the server passes readiness within 30 s, and readiness ignores leadership
  - Given SIGTERM, then pending nacks are flushed within the drain budget and WebSockets close with code 1012
- **Verification:**
  - `pnpm nx e2e e2e-team --grep=@runtime`

### M3-02 Epic: OIDC BFF (TEAM-02)

- **Milestone (design):** M3 · **Wave:** M3-W2 · **Size:** L
- **Depends on:** M3-01
- **Goal:** Authorization code + PKCE with server sessions, CSRF, group mapping and break-glass.
- **Scope:** libs/engine/svc-access (oidc via openid-client 6.8.8, sessions, csrf, trusted-header mode, break-glass)
- **Interfaces:** /auth/*; __Host-sid cookie; X-CSRF-Token
- **Acceptance criteria:**
  - Given Keycloak 26 and Entra test tenants, then login maps groups to roles with __Host-sid cookies and CSRF tokens
  - Given the break-glass admin, then its use raises an audit event and a banner
- **Verification:**
  - `pnpm nx e2e e2e-team --grep=@oidc`

### M3-03 Epic: Deny-by-default RBAC, quotas and kill switch (TEAM-03; U-02 canary decision)

- **Milestone (design):** M3 · **Wave:** M3-W2 · **Size:** L
- **Depends on:** M3-02
- **Goal:** RBAC stricter than the broker, with separate permissions for peek, consume, purge, replay, publish and admin (DC-40).
- **Scope:** libs/engine/svc-access (PolicyEngine, role bindings, quotas, kill switch); generated RBAC test matrix over every mutating action
- **Interfaces:** Authorizer = RBAC intersected with broker hints; permission catalogue
- **Acceptance criteria:**
  - Given a role with peek but not purge, then purge is hidden in the UI and refused by the API with FORBIDDEN_RBAC
  - Given the kill switch, then all taps and jobs stop and nacks are flushed; every mutating action has an RBAC test
- **Verification:**
  - `pnpm nx test svc-access`
  - `pnpm nx e2e e2e-team --grep=@rbac`

### M3-04 Epic: Shared catalog and RBAC-filtered shared pollers (TEAM-04)

- **Milestone (design):** M3 · **Wave:** M3-W3 · **Size:** L
- **Depends on:** M3-03
- **Goal:** Admin-defined connections, with one poller per broker whose results are filtered per user.
- **Scope:** svc-connections catalog (UI, file, Helm values); shared pollers with row filtering
- **Interfaces:** catalog.*; visibility per-user mode
- **Acceptance criteria:**
  - Given Helm values with connections, then they appear read-only to users; given lockdown, then users cannot add brokers
  - Given 3 users with different scopes on one broker, then one poller runs and each user sees only the rows they are permitted to see
- **Verification:**
  - `pnpm nx e2e e2e-team --grep=@catalog`

### M3-05 Epic: Broker credential modes and delegated pools (TEAM-05, CON-07 delegated, U-15)

- **Milestone (design):** M3 · **Wave:** M3-W3 · **Size:** L
- **Depends on:** M3-03, M1-23
- **Goal:** Per-user broker identity through delegated OAuth or Vault, always intersected with RBAC (DC-41).
- **Scope:** svc-identity (token exchange / OBO, Vault/OpenBao dynamic, LDAP, service account); per-user pools; awaiting-credentials job state
- **Interfaces:** credentialMode per connection
- **Acceptance criteria:**
  - Given delegated mode, then each user has their own AMQP connection whose broker identity is that user, and expired delegation moves jobs to awaiting-credentials
  - Given Vault/OpenBao dynamic credentials, then they are leased and revoked on logout
- **Verification:**
  - `pnpm nx e2e e2e-team --grep=@delegated`

### M3-06 Epic: Team audit log, anchors, verify tool and restore drill (TEAM-06)

- **Milestone (design):** M3 · **Wave:** M3-W2 · **Size:** L
- **Depends on:** M3-01, M0-30
- **Goal:** An append-only, hash-chained system of record that is verifiable from outside the database.
- **Scope:** svc-audit (partitions, anchors, OTLP/syslog/JSON export, retention); cli audit verify; restore-drill.yml
- **Interfaces:** audit/{events,exports,anchors}
- **Acceptance criteria:**
  - Given a purge, then an attempt row precedes the call and a linked outcome row follows; a tampered row fails verification at the next anchor
  - Given the nightly restore drill, then restore, migrate and audit verify all succeed
- **Verification:**
  - `pnpm nx e2e e2e-team --grep=@audit`
  - `gh workflow run restore-drill.yml`

### M3-07 Epic: Four-eyes approvals and approvals inbox (TEAM-07)

- **Milestone (design):** M3 · **Wave:** M3-W3 · **Size:** L
- **Depends on:** M3-03
- **Goal:** Configurable second-approver rules for risky actions.
- **Scope:** svc-access approvals; feature-approvals UI
- **Interfaces:** plans/{id}/approvals
- **Acceptance criteria:**
  - Given a bulk replay of more than 1,000 messages on PROD, then it waits for a second approver; given an expired approval, then the action cannot run
  - Given an approver who is also the requester, then the approval is rejected
- **Verification:**
  - `pnpm nx e2e e2e-team --grep=@approvals`

### M3-08 Epic: PII masking engine (TEAM-08)

- **Milestone (design):** M3 · **Wave:** M3-W3 · **Size:** L
- **Depends on:** M3-03
- **Goal:** Engine-side masking for the UI, exports, audit, AI and failure headers, with audited unmask.
- **Scope:** libs/shared/masking; svc-access unmask permission
- **Interfaces:** Masking rules per vhost and queue (JSONPath, regex, detectors)
- **Acceptance criteria:**
  - Given a masked field, then it never leaves the engine unmasked for unprivileged roles across UI, export, audit and failure headers (API test)
  - Given a replay, then the original bytes are republished unmasked, and every unmask is audited
- **Verification:**
  - `pnpm nx test masking`
  - `pnpm nx e2e e2e-team --grep=@masking`

### M3-09 Epic: SSRF egress policy (TEAM-09)

- **Milestone (design):** M3 · **Wave:** M3-W2 · **Size:** L
- **Depends on:** M3-01, M0-26
- **Goal:** Deny private, link-local and metadata ranges by default, with connect-time DNS validation (DC-43).
- **Scope:** net-dialer egress policy; Helm NetworkPolicy
- **Interfaces:** egress {allow[], denyPrivate: true}
- **Acceptance criteria:**
  - Given a profile pointing at 169.254.169.254, then the connection is refused; given DNS rebinding to a private IP, then the connect-time check blocks it
  - Given OIDC discovery, JWKS, Vault and webhook URLs, then the same policy applies and redirects are not followed
- **Verification:**
  - `pnpm nx run net-dialer:it --suite=ssrf`

### M3-10 Epic: Desktop remote workspaces and team admin console (TEAM-10/11)

- **Milestone (design):** M3 · **Wave:** M3-W3 · **Size:** L
- **Depends on:** M3-02, M3-03
- **Goal:** The desktop app attaches to a team server; admins govern users, roles, connections, approvals, audit and masking.
- **Scope:** apps/desktop remote mode (RFC 8252 login); libs/ui/feature-governance
- **Interfaces:** Remote workspace transport over HTTP/WebSocket
- **Acceptance criteria:**
  - Given a team server, then desktop login uses the system browser with PKCE, and the UI reflects the server's permissions
  - Given an auditor role, then audit is searchable but settings are read-only; a role change takes effect on the next request and is audited
- **Verification:**
  - `pnpm nx e2e e2e-team --grep='@remote|@admin-console'`

### M3-11 Epic: Team REST API tokens, emergency revoke and maintenance freeze (EXT-03, ADR-020)

- **Milestone (design):** M3 · **Wave:** M3-W3 · **Size:** L
- **Depends on:** M3-03, M3-06
- **Goal:** Scoped automation tokens, plus blast-radius controls for incidents.
- **Scope:** svc-access api tokens; svc-ops emergency-revoke and freeze; published OpenAPI
- **Interfaces:** team/tokens; ops/{cid}/emergency-revoke; ops/{cid}/freeze
- **Acceptance criteria:**
  - Given a token scoped to metadata, then message endpoints return 403, and oasdiff blocks breaking changes to the published OpenAPI
  - Given an emergency revoke on a broker, then taps stop, firehose is off on every node, peeks flush and replays park, all in one audited action
- **Verification:**
  - `pnpm nx e2e e2e-team --grep='@tokens|@ops'`

### M3-12 Epic: Helm chart, compose quickstart, e2e-team suite, security review (PLAT-11)

- **Milestone (design):** M3 · **Wave:** M3-W3 · **Size:** L
- **Depends on:** M3-01, M3-02, M3-03, M3-06, M3-09
- **Goal:** An installable, hardened team server, reviewed against the threat model.
- **Scope:** packaging/helm/<product> (values schema generated from zod; hook Job under the DDL role; NetworkPolicy, PDB, ServiceMonitor, HTTPRoute/Ingress); docs quickstart; threat-model review; pen-test if funded
- **Interfaces:** OCI chart on GHCR, signed with cosign
- **Acceptance criteria:**
  - Given helm install on kind with defaults, then the pod passes restricted PSS and readiness, migrations run in the hook Job under the DDL role, and the schema rejects invalid values
  - Given the compose quickstart, then a new user reaches a logged-in explorer in under 10 minutes; the security review closes all high findings
- **Verification:**
  - `pnpm nx run helm:ct`
  - `pnpm nx e2e e2e-team`

### M4-01 Epic: Lint engine, rule catalogue, CLI/SARIF, lint rule SDK (DIA-01, EXT-04)

- **Milestone (design):** M4 · **Wave:** M4-W1 · **Size:** L
- **Depends on:** M1-01, M0-46
- **Goal:** A versioned DC-56 hazard catalogue with fix plans, usable in the UI and in CI.
- **Scope:** libs/shared/lint-rules; libs/engine/svc-lint; cli lint; rule SDK
- **Interfaces:** lint.run; SARIF output
- **Acceptance criteria:**
  - Given a QQ without a DLX, then a finding with a fix policy is produced; given the CI command against a definitions file, then it exits non-zero on errors and emits valid SARIF
  - Given every DC-56 hazard, then a rule with per-version fixtures exists, and a version-gated rule is skipped on other versions
- **Verification:**
  - `pnpm nx test lint-rules`
  - `pnpm nx run cli:e2e --testNamePattern=lint`

### M4-02 Epic: Upgrade readiness advisor (DIA-02)

- **Milestone (design):** M4 · **Wave:** M4-W2 · **Size:** L
- **Depends on:** M4-01
- **Goal:** Answer 'what breaks if I upgrade to 4.3 or 4.4' with an ordered plan.
- **Scope:** svc-lint upgrade rules; lab upgrade cells
- **Interfaces:** upgrade.report {target}
- **Acceptance criteria:**
  - Given a 4.2 cluster using x-delayed-message, then the report lists the 4.3 blocker and the alternatives, and the required flags are listed in order
  - Given lab upgrades from 4.2.9 to 4.3.6, then the advisor's predictions match the observed outcomes; 4.4 GA is verified within 14 days
- **Verification:**
  - `pnpm nx run conformance:test --grep=CF-UPGRADE --versions=4.2.9,4.3.6`

### M4-03 Epic: Diagnostics suite (DIA-03..07, DIA-09)

- **Milestone (design):** M4 · **Wave:** M4-W2 · **Size:** L
- **Depends on:** M4-04, M2-02
- **Goal:** Deterministic explanations for growing queues, stuck consumers, connection hygiene, alarms, security posture and capacity.
- **Scope:** svc-lint diagnostics; feature-lint views
- **Interfaces:** diagnostics.* actions
- **Acceptance criteria:**
  - Given consumers dropped to 0, then 'why is this queue growing' names 'no consumers since T' with evidence; a stuck consumer is flagged with its connection and age
  - Given 4.3.2 with OAuth, then the client-secret leak finding cites the fix version; CloudAMQP shared shows connection usage against 20/100
- **Verification:**
  - `pnpm nx test svc-lint`
  - `pnpm nx e2e e2e-web --grep=@diagnostics`

### M4-04 Epic: History store and time-series explorer (MON-03/04)

- **Milestone (design):** M4 · **Wave:** M4-W1 · **Size:** L
- **Depends on:** M1-26, M3-01
- **Goal:** Days-to-weeks of history with rollups, annotations and forecasts.
- **Scope:** svc-metrics persistence (raw 48 h, 5 m and 1 h rollups, cardinality caps); feature-metrics explorer
- **Interfaces:** metrics.queries over a range
- **Acceptance criteria:**
  - Given 7 days at 30 s for 1k queues, then storage stays under the documented budget and rollups compact
  - Given a replay receipt, then an annotation appears at its time on the chart
- **Verification:**
  - `pnpm nx run perf:history-7d`
  - `pnpm nx e2e e2e-web --grep=@history`

### M4-05 Epic: Alerts, local and server-evaluated (MON-06)

- **Milestone (design):** M4 · **Wave:** M4-W2 · **Size:** L
- **Depends on:** M4-04, M3-01
- **Goal:** Rules, dedupe and silences, delivered only to user-configured endpoints (DC-59).
- **Scope:** libs/engine/svc-alerts (state machine, routes through the Dialer, notifiers)
- **Interfaces:** alerts/{rules,events,routes}
- **Acceptance criteria:**
  - Given a team-server rule, then it fires with laptops closed and is delivered once, with dedupe, to Slack, Teams, email and webhook (E2E)
  - Given a snooze, then nothing is sent until it expires, and only user-configured endpoints are contacted
- **Verification:**
  - `pnpm nx e2e e2e-team --grep=@alerts`

### M4-06 Epic: Fleet overview and event timeline (MON-07/08)

- **Milestone (design):** M4 · **Wave:** M4-W1 · **Size:** L
- **Depends on:** M1-26, M1-28
- **Goal:** All clusters in one view, plus broker events correlated with metrics.
- **Scope:** feature-metrics fleet; svc-metrics event ingestion from amq.rabbitmq.event
- **Interfaces:** fleet.overview; events topic
- **Acceptance criteria:**
  - Given 20 profiles, then the fleet view loads within 3 s from cached probes, and EOL versions are badged with dates
  - Given amq.rabbitmq.event, then events show user_who_performed_action; when the exchange is absent, the feature is disabled with enable instructions
- **Verification:**
  - `pnpm nx e2e e2e-web --grep=@fleet`

### M4-07 Epic: DLQ decoders v1.1, dead-letter analytics, shovel-based move (DLQ-06/10/11)

- **Milestone (design):** M4 · **Wave:** M4-W1 · **Size:** L
- **Depends on:** M2-07, M2-06, M2-03
- **Goal:** Cover the second wave of frameworks and show DLQ trends; shovel moves only where evidence allows (DC-29).
- **Scope:** decoders (Symfony safe tokeniser, Rebus, Wolverine, Laravel, Dramatiq, Sneakers); svc-dlq analytics; shovel move job
- **Interfaces:** dlq.analytics; move.shovel (capability-gated)
- **Acceptance criteria:**
  - Given a PHP-serialized Symfony body, then stamps are read without unserialize; Dramatiq .XQ messages show the time left before the 7-day drop
  - Given 4.3.5, then shovel move is unavailable citing #17794; given 4.2.9 with verified carry-over, then the move completes and the shovel is removed
- **Verification:**
  - `pnpm nx run fixture-apps:decode --frameworks=symfony,rebus,wolverine,laravel,dramatiq,sneakers`
  - `pnpm nx run conformance:test --grep=CF-SHOVEL --versions=4.2.9,4.3.6`

### M4-08 Epic: Streams fast path and range replay, live flow overlay, message lifecycle trace (STR-04/06, TOP-04, TAP-06)

- **Milestone (design):** M4 · **Wave:** M4-W1 · **Size:** L
- **Depends on:** M1-31, M2-06, M2-05, M1-49
- **Goal:** High-throughput stream reads where reachable, plus a flow overlay and per-message tracing.
- **Scope:** libs/engine/adapter-stream (optional, lazy); svc-streams range replay; feature-topology overlay; svc-tap trace
- **Interfaces:** streams.replay; trace.start (leased)
- **Acceptance criteria:**
  - Given an unresolvable advertised_host, then the fast path stays off; on a large range, the fast path is at least 3x faster than the AMQP path
  - Given a traced id, then publish, routing and delivery appear on a timeline, and tracing switches off when the lease ends
- **Verification:**
  - `pnpm nx run perf:stream-fastpath`
  - `pnpm nx e2e e2e-web --grep=@trace`

### M4-09 Epic: Topology snapshots and diff, local broker launcher, Flathub and Snap (TAC-01/02, PLAT-17)

- **Milestone (design):** M4 · **Wave:** M4-W1 · **Size:** L
- **Depends on:** M2-03, M1-49
- **Goal:** Normalised topology snapshots and diffs, version-rehearsal brokers, and the second distribution wave.
- **Scope:** libs/shared/topology-code; svc-topology diffs; svc-ops launcher (Docker/Podman); Flathub source build and Snap
- **Interfaces:** topology/{exports,diffs}; launcher.start
- **Acceptance criteria:**
  - Given two exports of an unchanged broker, then the snapshots are byte-identical; a changed QQ argument is marked 'forces replacement'
  - Given 'launch 4.3.6 with streams', then a profile is created and connected; the Flathub source build and the Snap pass store checks
- **Verification:**
  - `pnpm nx test topology-code`
  - `pnpm nx run desktop:flatpak-build`

### M5-01 Epic: Team /mcp as its own OAuth protected resource (AI-02)

- **Milestone (design):** M5 · **Wave:** M5-W1 · **Size:** L
- **Depends on:** M3-03, M2-10
- **Goal:** MCP access with no token passthrough, under RBAC, masking and audit (DC-42).
- **Scope:** svc-mcp team transport (RFC 9728 metadata, RFC 8707 audience)
- **Interfaces:** /mcp
- **Acceptance criteria:**
  - Given a token with the wrong audience, then /mcp rejects it, and no token-passthrough path exists
  - Given a tool call, then an audit row names both the human principal and the agent
- **Verification:**
  - `pnpm nx e2e e2e-team --grep=@mcp-auth`

### M5-02 Epic: Governed mutating MCP tools via approvals (AI-03)

- **Milestone (design):** M5 · **Wave:** M5-W2 · **Size:** L
- **Depends on:** M5-01, M3-07
- **Goal:** Mutating tools (peek counts as one) can only create plans, which run after human approval.
- **Scope:** svc-mcp mutating tools; approvals inbox integration (team and desktop)
- **Interfaces:** mcp.mutate permission; plan-only tools
- **Acceptance criteria:**
  - Given an AI peek of a 4.0-4.2 QQ, then approval is required and the receipt is returned to the agent
  - Given a doomed message, then 'let RabbitMQ handle' is unavailable to AI principals
- **Verification:**
  - `pnpm nx run svc-mcp:it --suite=mutating`

### M5-03 Epic: Prompt-injection hardening (AI-05)

- **Milestone (design):** M5 · **Wave:** M5-W1 · **Size:** L
- **Depends on:** M3-08
- **Goal:** Payloads reach models only as quoted, capped, masked data; output is rendered as text.
- **Scope:** svc-mcp payload quoting, size caps, control-character stripping, masking; UI text-only rendering; tool allow-lists per environment
- **Interfaces:** McpPayloadPolicy
- **Acceptance criteria:**
  - Given a message body containing tool instructions, then it reaches the model as quoted, size-capped, control-stripped and masked data
  - Given an exfiltration URL in model output, then it is not auto-rendered
- **Verification:**
  - `pnpm nx run svc-mcp:redteam`

### M5-04 Epic: Grounded copilot with BYO or local endpoints (AI-04)

- **Milestone (design):** M5 · **Wave:** M5-W2 · **Size:** L
- **Depends on:** M5-03, M4-01, M4-03
- **Goal:** Answers grounded in lint, diagnostics, effective config and docs; never auto-applies changes.
- **Scope:** feature-copilot; svc-mcp grounding; user-configured endpoints only
- **Interfaces:** copilot.ask (metadata-only by default)
- **Acceptance criteria:**
  - Given 'why is orders.q growing', then the answer cites decision-tree evidence
  - Given no endpoint configured, then the copilot is disabled and makes zero outbound calls (egress test)
- **Verification:**
  - `pnpm nx e2e e2e-web --grep=@copilot`

### M5-05 Epic: Red-team corpus and AI release gate

- **Milestone (design):** M5 · **Wave:** M5-W2 · **Size:** L
- **Depends on:** M5-01, M5-02, M5-03, M5-04
- **Goal:** Make AI safety a release gate, not a one-off test.
- **Scope:** testing/redteam corpus; CI gate
- **Interfaces:** Target svc-mcp:redteam --corpus=full
- **Acceptance criteria:**
  - Given the injection corpus, then every case passes in CI
  - Given the M5 tag, then the audience, approval and egress tests are release gates
- **Verification:**
  - `pnpm nx run svc-mcp:redteam --corpus=full`

### M6-01 Epic: Plan and apply topology-as-code (TAC-03)

- **Milestone (design):** M6 · **Wave:** M6-W1 · **Size:** L
- **Depends on:** M4-09, M3-07
- **Goal:** Dependency-ordered plans with flagged replacements and approvals, never touching operator-owned objects.
- **Scope:** svc-topology plan/apply jobs
- **Interfaces:** topology.apply (planning required)
- **Acceptance criteria:**
  - Given a plan with a queue replacement, then apply requires approval and moves messages only by explicit option
  - Given an object owned by the Topology Operator, then the plan refuses to edit it
- **Verification:**
  - `pnpm nx run conformance:test --grep=CF-TAC --versions=4.2.9,4.3.6`

### M6-02 Epic: IaC and AsyncAPI export/import (TAC-04)

- **Milestone (design):** M6 · **Wave:** M6-W1 · **Size:** L
- **Depends on:** M4-09
- **Goal:** Export to definitions, Terraform, Topology Operator CRDs and AsyncAPI 3; import AsyncAPI as a plan.
- **Scope:** libs/shared/topology-code exporters and importers
- **Interfaces:** topology.export {format}
- **Acceptance criteria:**
  - Given a vhost, then the generated Topology Operator CRDs apply cleanly on kind, and Terraform (cyrilgdn) plans show no diff
  - Given an AsyncAPI 3 file, then a reviewable plan is produced
- **Verification:**
  - `pnpm nx run topology-code:it --kind`

### M6-03 Epic: Drift detection (TAC-05)

- **Milestone (design):** M6 · **Wave:** M6-W1 · **Size:** L
- **Depends on:** M4-09, M4-05
- **Goal:** Scheduled comparison against git or IaC, with alerts and edit warnings.
- **Scope:** svc-topology drift job; svc-alerts integration
- **Interfaces:** drift.rules
- **Acceptance criteria:**
  - Given a manual change on prod, then a drift alert fires at the next run
  - Given a UI edit on a managed object, then a warning names the managing system
- **Verification:**
  - `pnpm nx e2e e2e-team --grep=@drift`

### M6-04 Epic: SCIM provisioning (TEAM-12)

- **Milestone (design):** M6 · **Wave:** M6-W1 · **Size:** L
- **Depends on:** M3-02
- **Goal:** Provisioning from the IdP, with fast deprovisioning.
- **Scope:** svc-access SCIM 2.0
- **Interfaces:** /scim/v2
- **Acceptance criteria:**
  - Given a deprovisioned user, then their sessions and broker connections close within 60 s
  - Given group sync, then role bindings follow
- **Verification:**
  - `pnpm nx e2e e2e-team --grep=@scim`

### M6-05 Epic: HA team server (TEAM-13)

- **Milestone (design):** M6 · **Wave:** M6-W1 · **Size:** L
- **Depends on:** M3-12
- **Goal:** Multiple replicas with per-broker leases and resumable jobs (ADR-018 v2).
- **Scope:** broker_lease table; internal mesh for live forwarding; Helm PDB/NetworkPolicy updates
- **Interfaces:** broker_lease (TTL 15 s, heartbeat 5 s)
- **Acceptance criteria:**
  - Given one replica killed, then running jobs resume on another without duplicate publishes
  - Given 3 replicas, then each broker is polled exactly once
- **Verification:**
  - `pnpm nx run chaos:team-ha`

### M6-06 Epic: Self-service within guardrails (TEAM-14)

- **Milestone (design):** M6 · **Wave:** M6-W2 · **Size:** L
- **Depends on:** M6-01, M3-07
- **Goal:** App teams request resources; naming and policy rules are enforced; owners approve; results go through plan/apply.
- **Scope:** feature-governance self-service; svc-access request workflow
- **Interfaces:** requests.* (plan/apply backed)
- **Acceptance criteria:**
  - Given a request that violates a naming rule, then it is rejected with that rule
  - Given an approved request, then the plan applies and is audited
- **Verification:**
  - `pnpm nx e2e e2e-team --grep=@self-service`

### M6-07 Epic: Node agent zero-side-effect QQ peek (MSG-14)

- **Milestone (design):** M6 · **Wave:** M6-W1 · **Size:** L
- **Depends on:** M1-22, M1-18
- **Goal:** The only QQ path allowed to be called non-destructive (DC-15), running inside the broker trust boundary.
- **Scope:** apps/node-agent (rabbitmq-queues peek via SSH, kubectl exec or local Docker; mTLS)
- **Interfaces:** agent.peek {queue, positions}
- **Acceptance criteria:**
  - Given the agent peeking positions 1-20, then QQ counters are unchanged (conformance)
  - Given a CQ, then the agent reports classic_queue_not_supported; the Erlang cookie never leaves the broker trust boundary
- **Verification:**
  - `pnpm nx run conformance:test --grep=CF-AGENT --versions=4.2.9,4.3.6`

### M6-08 Epic: Capture to stream and queue-type migration wizard (TAP-05, DIA-08)

- **Milestone (design):** M6 · **Wave:** M6-W1 · **Size:** L
- **Depends on:** M1-28, M1-31, M3-01, M2-06
- **Goal:** Shared replayable captures, and guided CQ-to-QQ migration.
- **Scope:** svc-tap capture-to-stream; svc-admin migration jobs
- **Interfaces:** captures.stream; migration.plan
- **Acceptance criteria:**
  - Given a capture with max-age 1h, then it is deleted at session end or on TTL, and two users can browse it by offset
  - Given a CQ with exclusive or global-QoS consumers, then migration is blocked with reasons; a completed batch has matching message counts
- **Verification:**
  - `pnpm nx run conformance:test --grep='CF-CAPTURE|CF-MIGRATE' --versions=4.2.9,4.3.6`

### M6-09 Epic: UI extension points, executable runbooks, on-call PWA, foundation application (EXT-05/06, PLAT-18)

- **Milestone (design):** M6 · **Wave:** M6-W2 · **Size:** L
- **Depends on:** M2-07, M2-10, M3-12
- **Goal:** Open the ecosystem and the on-call workflow, and apply to a neutral foundation.
- **Scope:** Signed plugin bundles for UI extensions; runbook notebooks; PWA view of the team server; foundation application (CNCF Sandbox or Commonhaus)
- **Interfaces:** Extension manifest (signed); runbook format (git)
- **Acceptance criteria:**
  - Given an unsigned bundle on the team server, then it is refused, and plugin actions go through RBAC and audit
  - Given a 390 px viewport, then alerts and approvals are usable without horizontal scroll; the foundation application is submitted
- **Verification:**
  - `pnpm nx e2e e2e-team --grep='@extensions|@pwa'`
