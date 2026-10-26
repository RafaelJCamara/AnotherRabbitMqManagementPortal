# Status and what is left (as of 2026-10-26)

A hand-off note for whoever picks the work up next: a person, or an agent session. It lists what landed, what is waiting for a human, and what is next. It is a snapshot, not a plan: the plan is [execution-plan.md](execution-plan.md), the issues are the source of truth, and a spec in `docs/specs/` beats this file. Update or delete this file when it goes stale.

## Work packages in flight

Every slice below landed as commits on `main` (the maintainer uses no pull requests). Each WP issue stays open until its last slice lands, and only that slice carries `Closes #<n>`.

### M1-14 Peek executor (#99, trust-critical): slices A and B landed, C waits

Spec: [specs/M1-14.md](../specs/M1-14.md).

- **Landed:** the hold journal (migration `0010`, repository), the state machine, the executor with its watchdog, `flushAll`, `reconcileInterrupted`, and the OQ-215 decision: on a quorum queue the executor waits up to 10 s for the ready count to be back where it was before the first `get`, else the hold ends as an incident (`return-unconfirmed`). The `svc-peek` executor file is exempt from the I-2 architecture check as funnel plumbing (`tools/arch-tests/src/rules.ts`); the rest of `svc-peek` is checked.
- **Left:**
  - Slice C: the lab run `svc-peek:it` on the five broker versions. It waits on the lab cells M0-38 to M0-41 (issues #258, #259, #261 and others) and needs a Docker daemon.
  - The executor is not wired to anything. M1-15 (guard and dispositions) and M1-16 (actions, receipts, captures) wire it. The peek flag stays off until the chaos evidence of M1-38 exists (IP-6).
  - An ADR for the quorum wait, if the maintainer wants one (the DoD asks that decisions have an ADR).

### M1-19 Publish engine (#104): slices A, B and C landed

Spec: [specs/M1-19.md](../specs/M1-19.md), with "As built" sections for slices A, B and C (read them before slice D: the code differs from the spec text in places).

- **Landed:** slice A, the `messages.publish` contract and action over the publish lease (AC-1 to AC-10). Slice B, the `PublishHistoryRepository` port, migration `0011`, and the repository for SQLite and Postgres with its contract suite (AC-17, AC-18). Slice C, the mask and the history store (`createPublishHistory`: record, window, get, purge, sealing) over a memory repository (AC-11 to AC-16).
- **Left:**
  - Slice D: the two history actions (built on the store's `window` and `get`, whose types the contracts must match), building the store in `createMessagesModule` and passing it to the action as `recorder`, `apps/engine` registration, README, `AGENTS.md` rows (AC-19). Slice D must remove the `messages.publish` entry that `compose-services.spec.ts` lists as intentionally unserved. Writes are unwired in the composed engine, so publish returns `CAPABILITY_MISSING` there until the ConnectionManager wiring exists.
  - Slice E: the `svc-messages:it` target and the lab cases (AC-20), which need the lab and a Docker daemon.
  - **Postgres is unconfirmed.** Slice B was built and tested without a Docker daemon; the SQLite contract passes. The first CI run of `persistence:it` on Postgres 16 and 18 is the proof. Check it before building on the repository.

### M1-23 Credential providers and TokenManager (#108, trust-critical): slices A and B landed

Spec: [specs/M1-23.md](../specs/M1-23.md), with "As built" sections for slices A and B.

- **Landed:** slice A, the `svc-identity` project, `SecretValue`, the JWT claim reader, the password, static-token, token-command and x509-external providers, hardened after an adversarial review (fixed texts with no `cause`, a 366-day lifetime bound, an absolute-path-only token command), and eight extra tests for mutants the review found. Slice B, the `adapter-token-endpoint` project, the `oidc` Dialer purpose, and the client-credentials provider (AC-5 client-secret case, AC-6 to AC-8).
- **Slice B has had no fresh review.** Slice A got a `/review-wp` and an adversarial `security-review` before it landed; slice B was pushed on the maintainer's instruction without them. Run both on `fd0b345..87540ab` (the commit hashes may have moved when rebased: use `git log --grep "M1-23, slice B"`).
- **Open answers for the maintainer** (slice B deviations, recorded in the spec): (1) the adapter uses `node:http` over the Dialer socket, with no `undici` confinement row; (2) `malformed`, `too-large` and a non-bearer token type map to `BROKER_ERROR`; (3) the `oidc` registry row text still describes all of M1-24 while the docs page says "Built", and only the token request exists.
- **Left:**
  - Slice C: the TokenManager (renewal plan, username assertion, single-flight, backoff, bounds; AC-9 to AC-17).
  - Slice D: the size preflight, the i18n warnings and three capability rules in the semantics registry (AC-18 to AC-22).
  - Slice E: `adapter-amqp091` `updateSecret`, the composition in `apps/engine` (including the `StoredLoginPort` implementation and the command runner), the optional `credential_providers` table (OQ-1455), the `it` target and the lab cases (AC-23 to AC-25). Slice E needs its own adversarial review: the command runner and the delivery-mode gate for the token command are code execution if the gate is missing (OQ-1460). It must also keep `usernameClaims` in step between the provider config and `createStaticTokenProvider`.
  - The ADR for the provider and renewal model (not written).
  - Dependencies outside this WP: the auth lab #110 (M1-25) and OAuth discovery #109 (M1-24) are open; U-14 needs the lab before the TokenManager is GA.

### M1-13 Peek preflight and rescue preflight (#98, trust-critical): spec only, awaiting approval

Spec: [specs/M1-13.md](../specs/M1-13.md) (26 acceptance criteria, questions OQ-1466 to OQ-1480). **No code yet and the spec is not approved.**

- **Decide before slice A:** confirm or change the agent's extension of A-5 (an effective `message-ttl` or `expires` makes the quarantine unsafe), and the other defaults in the spec's Risks section.
- **Slices:** A quarantine spec, `ensureQuarantine` and a new `PeekEvidencePort` (about 550 lines); B the peek preflight (about 750); C the rescue preflight (about 800); D the lab spec and the `svc-peek:it` target (about 250).

### M0-64 Container image (#57): written without a Docker daemon, live checks unproved

Spec: [specs/M0-64.md](../specs/M0-64.md) (questions OQ-1486 to OQ-1491). `packaging/docker` holds the Dockerfile (two stages, both base images pinned by digest, distroless non-root runtime), the compose file, the static and live checks, and `.github/workflows/image.yml` (native amd64 and arm64, Trivy, push by digest with SBOM and provenance, cosign keyless).

- **Proved without a daemon:** the static checks (`pnpm nx run docker:test`), the workflow's shape and pins, and the build stage and layout (a clean copy of the build context was installed and built, the runtime tree was assembled with the Dockerfile's commands and started in container mode).
- **Not proved, needs a daemon:** the image build itself, the live checks (non-root, read-only root, SIGTERM within 2 s, no shell, `--network none`, usage error on a misspelt setting), and the workflow-only criteria (multi-arch manifest, signature, SBOM, Trivy). Run `pnpm nx run docker:test` on a machine with Docker, then `gh workflow run image.yml` on the repository, before closing #57.
- **For a maintainer:** set the repository variable `IMAGE_NAME` when the name is decided (OQ-1487); decide Trivy's `ignore-unfixed` (OQ-1488); M0-68 must start `image.yml` from a release tag (OQ-1489).

## Not started

- **M1-15** guard and dispositions (needs M1-13 and M1-14), **M1-16** peek actions, receipts and captures, **M1-17** model-based executor tests, **M1-18** per-era peek conformance. They follow M1-13 to M1-14 in that order.
- **M1-21** TLS trust store and mTLS (#106) and **M1-22** Dialer routes (#107): ready (depend only on M0-26) but trust-critical; the cap is 2 (see below).
- **M1-24** OAuth discovery (needs M1-23), **M1-25** auth lab.
- **M1-43** error explainer (needs M1-42, still open) and **M1-45** message viewer (needs M0-51, still open).
- Small follow-ups from M1-12 and M1-20: #286 (registry rows for DLX carry-over and peek-method availability), #287 (classic-queue settle cells), #288 (move the four planner warnings into the registry), #289 (policy-write fix action for W-OVERLIMIT), #283 to #285 (routing verify, streaming bindings, routing scans against the I-5 budget).
- Open M0 work in the issue list that these slices did not touch: the explorer slices M0-48b to M0-48l (#263 to #276), and the lab-evidence cells M0-39-C/D, M0-40-D (#258, #259, #261).

## Waiting for a maintainer

- **CODEOWNERS** (a protected path, agents cannot edit it): add `/libs/engine/svc-peek/ @RafaelJCamara` and `/libs/engine/adapter-token-endpoint/ @RafaelJCamara`.
- **DCO is red on three commits already on `main`:** `5269954`, `2842a6c` and `a091b29` have no `Signed-off-by`. Fixing them needs a history rewrite, which the project forbids, so they were left. Every later commit is signed off (`git commit -s`, or `git rebase --signoff origin/main` before pushing).
- **An intermittent `ci` failure** in `engine:smoke` (`src/bundle.smoke.spec.ts`: the startup time must be under 1000 ms and was 1248 ms on a CI runner). It is a timing flake, unrelated to the commits it failed on. Consider raising the bound or making it relative.
- **CI state of the newest pushes is unconfirmed:** a push cancels the `ci` run of the previous one. At the time of writing the last completed `ci` run was green on `2827ab8`; the runs for the later commits were still going. Run `gh run list --branch main` and look at the newest.
- **Trust-critical cap (AGENTS.md section 12) is 2 in progress.** M1-14 was counted as paused (slice C waits on the lab), so M1-23 and M1-13 hold the two slots. Starting M1-21 or M1-22 needs one of them to finish or pause.

## How the work was done, and traps for the next session

- One WP per worktree under `../wt/<WP-id>` on a branch `wi/<WP-id>-<slug>`; the current ones are `wt/M1-13`, `wt/M1-14`, `wt/M1-19` and `wt/M1-23`. There are many stale worktrees under `../wt/` and `.claude/worktrees/`; none were touched or removed.
- **Spec first.** A WP with a thin issue gets `/wp-spec` and a human approval before code. Each spec lists its slices; each slice lands as one commit green on its own, rebased on `origin/main`.
- **Parallel specs collide on ids.** Two specs drafted from the same base both took the next open-question numbers (OQ-1438 and up) and had to be renumbered on rebase. Take the next free OQ number and migration number from the latest `origin/main` just before committing.
- **Verify, do not trust a hand-back.** Slice reports from agents were re-run (lint, typecheck, tests, format) before a push. The mutation passes found real test gaps, so for trust-critical code run a mutation pass and a fresh `/review-wp` plus an adversarial `security-review`.
- **Tooling trap:** in this environment the shell layer halves backslashes inside commands and heredocs. Never put a backslash in a Bash or Python heredoc; use the Write and Edit tools for files that contain one (a regex with `\\` was silently corrupted once).
- **The I-2 architecture check** fails any file outside the plumbing list that names a write-capable port (`PeekLease`, `PublishLease`, ...) unless it calls `implementAction` or `defineJob`. A fake lease therefore lives inside a spec file. The exemption list is in `tools/arch-tests/src/rules.ts` and is CODEOWNERS-owned.
