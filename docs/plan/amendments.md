# Binding amendments A-1…A-26

A-1…A-25 come from the final consistency critique ([critique.md](critique.md)); A-26 is a later maintainer decision. They **override** the design-phase text in the blueprint, execution plan, product docs and work packages. Each is reflected in the GitHub issues it affects (label `amended`, or `priority:critical-path` for A-26).

**A-26 (M0/M1, 2026-10-26) Web 1.0 by 2026-11-30; desktop after** ([ADR-035](../adr/ADR-035-web-1-0-by-2026-11-30-desktop-after.md)).
- **Goal and date.** Until it ships, the only goal is Web 1.0: M0 and M1, the single-user Docker web app. Its **public** release is targeted for **2026-11-30** (milestone M1 due date; M0 due 2026-11-13).
- **Full scope.** No M1 feature is cut. If the work is late, the date slips.
- **Desktop out of M0/M1.** M1-67 becomes M2-P18 and M1-68 becomes M2-P19; U-16, U-21 and H-09 move to M2; PLAT-07 leaves the M1 checklist; the Electron leg of the nightly conformance run waits for M2. No agent starts desktop work (Electron, `apps/desktop`, signing, packaging) before Web 1.0 ships.
- **Order after Web 1.0** is ADR-030's: Windows (M2) → Linux (M3) → macOS (M4) → team server (M5) → M6–M8.
- **Critical path** (label `priority:critical-path`). Agents pick these first and reviewers review them first:
  - evidence gate: M0-38..M0-42, M0-62 (IP-4);
  - M0 exit: M0-48, M0-51, M0-54, M0-60, M0-64, M0-68, RC-M0;
  - peek: M1-13 → M1-14 → M1-15 → M1-16 → M1-18 → M1-38 (7 clean chaos nights; start by 2026-11-16), M1-44;
  - DLQ: M1-34 → M1-35;
  - release: M1-56, M1-60, M1-59, RC-M1;
  - public release: H-07 → ADR-029 (accept by 2026-11-16), M0-70;
  - human prerequisites: H-01, H-02, H-03, H-04, H-05, H-08.

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
