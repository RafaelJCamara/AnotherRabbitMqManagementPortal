# Maintainer batch: the human-only changes

Prepared 2026-10-21 by an agent. Agents may not edit protected paths (`tools/agent-hooks/protected-paths.mjs`), so the edits below are scripted and rehearsed on a scratch copy; you apply them with one command. `docs/maintainer/` is not a protected path.

```powershell
pwsh docs/maintainer/apply-batch.ps1 -WhatIf      # dry run: prints every change, writes nothing
pwsh docs/maintainer/apply-batch.ps1              # applies, then pnpm install + supply-chain:gates
```

Switches: `-SkipInstall`, `-SkipGates`, `-IncludeTagDerived` (also adds CODEOWNERS lines for the four projects that carry the `trust:critical` tag but that no open question proposed), `-Root <dir>` (rehearse on a copy). The script never commits.

It is idempotent: each step checks whether its entry is already there and says "already applied (no change)"; a second run changes nothing. It verifies every anchor first and stops without touching the file when one is missing, and it refuses to overwrite an existing `vite@8.3.0` override that has another value.

## Checklist

- [ ] Run the script (dry run first), read `git diff`.
- [ ] Item 1: vite override applied (`pnpm-workspace.yaml`, `pnpm-lock.yaml`, ADR-027 log row).
- [ ] Item 2: tick the Actions setting (or run the `gh api` command) so release-please can open its PR.
- [ ] Item 3: CODEOWNERS lines applied; decide the "not applied" rows below.
- [ ] Item 4: skim the commit table once.
- [ ] Commit with the commands at the end.

## 1. osv-scanner red on main: vite 8.3.0

| What | Finding |
| --- | --- |
| Advisories | GHSA-587h-7wmj-h5pm (CVSS 7.5), GHSA-698v-4r3x-3vcv and GHSA-r825-w8mm-5pxw (6.3). All three are about `launch-editor`, which vite bundles for its dev-server open-in-editor middleware. Fixed in vite 8.3.3 (also 8.2.4, 8.1.6, 7.3.7, 6.4.4). Confirmed with the OSV API: vite 8.3.0 has these three, 8.3.3, 8.3.4 and 8.3.5 have none. |
| How vite arrives | `pnpm why vite` shows two versions. `vite@8.3.0`: `@angular/build@22.2.3` (catalog, devDependency) and `@vitejs/plugin-basic-ssl`. `vite@8.3.4`: `vitest@5.0.5`, `@vitest/mocker`, `@nx/vitest`, `astro@7.3.8` (docs) and `vitefu`. vite is not a catalog entry or a direct dependency, so a catalog bump is not possible and no allow-list entry is needed. `@angular/build` pins vite 8.3.0 itself; a newer `@angular/build` patch will move it. |
| Reachability | Build and dev tooling only. No source file imports `vite` (searched `apps`, `libs`, `tools`). The production web build uses the `@angular/build:application` executor (esbuild); vite runs only for `ng serve` (`@angular/build:dev-server`) and the unit-test executor. The engine bundles with `@nx/esbuild`. The advisories need a developer running the dev server on Windows with crafted editor paths or hostile environment values; nothing ships. CVSS 7.5 is the scanner's number, not a shipped-code exposure. |
| Remedy (smallest, exact) | `overrides: { 'vite@8.3.0': 8.3.4 }` in `pnpm-workspace.yaml`. The selector only matches the vulnerable version, so it expires by itself when `@angular/build` moves. 8.3.4 is the version the rest of the tree already resolves, so the lockfile ends with one vite. |
| Release-age gate | vite 8.3.4 was published 2026-10-08 12:07 UTC (13 days old), vite 8.3.3 on 2026-10-06. Both are past the 3-day gate: no `minimumReleaseAgeExclude` entry and no ADR-027 exclusion row are needed. 8.3.5 (published 2026-10-21 06:38) is inside the gate and is deliberately not used. The script adds an "Overrides" section with one row to `docs/adr/ADR-027-log.md` for traceability (the gate reads only the two exclusion settings, so this cannot break it). |
| Gates | `supply-chain:gates` requires override versions to be exact (`pin.non-exact-version`): `8.3.4` is. Rehearsed in a scratch copy of the repository: `pnpm install` leaves a single `vite@8.3.4`, `supply-chain:gates` succeeds, and `nx test` for `agent-hooks`, `arch-tests` and `web` (the Angular unit-test builder, which uses vite) succeeds. |
| Other vulnerable versions | Checked every package@version of the new lockfile (1,296) against the OSV API: the only findings left are `form-data@4.0.4`, `postcss-selector-parser@6.1.4` and `undici@7.29.0` (10 ids), and every id is in `osv-scanner.toml`. Their `ignoreUntil` is **2026-11-14**: after that date osv-scanner goes red again unless they are fixed or the dates are moved (OQ-40). `osv-scanner` itself is not installed locally; the OSV API was used instead. |
| Rebuild (security lane step 6) | vite is not in any bundle, so no artefact contains the vulnerable code. The script's gates step runs the engine and web builds; for a full pass use `pnpm nx run-many -t build test typecheck lint`. |
| Release | Conventional Commit `fix(deps): ...` (below); release-please would pick it up once item 2 works. No advisory is needed (dev tooling only). |

## 2. release-please: "GitHub Actions is not permitted to create or approve pull requests"

Failure (every run since the workflow landed, e.g. run 39613027186): release-please creates the branch `release-please--branches--main--components--source` and its commit, then fails at the pull-request call. The workflow itself says the setting is required (`.github/workflows/release-please.yml`, header comment).

Current repository setting, read only (`gh api repos/RafaelJCamara/AnotherRabbitMqManagementPortal/actions/permissions/workflow`):

```json
{"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}
```

Fix, in the web UI: Settings > Actions > General > Workflow permissions > tick "Allow GitHub Actions to create and approve pull requests" > Save. Leave the radio on "Read repository contents and packages permissions": the release-please job declares its own `contents: write`, `pull-requests: write`, `issues: write`.

Same thing with the CLI (the field `can_approve_pull_request_reviews` is the checkbox; `default_workflow_permissions` is required by the endpoint, so repeat the current value):

```powershell
gh api -X PUT repos/RafaelJCamara/AnotherRabbitMqManagementPortal/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true
gh workflow run release-please.yml          # or push anything to main
```

Can release-please work without pull requests? No. Its model is: it opens a release PR (version bump in `.release-please-manifest.json`, `CHANGELOG.md`, the `extra-files`), and merging that PR makes the next run create the tag and the GitHub release. There is no mode that commits the bump straight to `main`. (`skip-github-pull-request` only skips the PR step for repositories that make the version commit themselves; it would need a hand-edited manifest and changelog, which CLAUDE.md forbids for contributors.) "No PRs" in this repo means contributors push to `main`; the release PR is the one deliberate exception (the workflow header: "The release PR is the human gate"): a bot opens it, you merge it, once per release. A PR opened with `GITHUB_TOKEN` does not trigger other workflows (`ci.yml`, `dco.yml`, `pr-title.yml` will not run on it); `main` has no branch protection and no rulesets, so that blocks nothing, and the push to `main` after you merge runs CI normally. `dco-check.sh` exempts commits authored by `[bot]` accounts, so the release commit passes the DCO check on that push. If you want checks on the release PR, use a PAT or a GitHub App token: that needs `token: ${{ secrets.RELEASE_PLEASE_TOKEN }}` in the workflow, and `release*.yml` is a protected path, so it is a maintainer edit.

Alternatives if you do not want any PR:

1. Turn the workflow off until the first release: `gh workflow disable release-please.yml` (stops the red runs on every push). Re-enable with `gh workflow enable release-please.yml`.
2. Release by hand: `gh release create v0.1.0-alpha.1 --prerelease --generate-notes`, and set the manifest/changelog yourself (against the "release-please owns versions" rule, and the version files in `extra-files` would not be updated).
3. Switch tool (changesets or release-it): a new dependency and an ADR; not recommended.

Housekeeping: every failed run has already pushed `release-please--branches--main--components--source`. It is reused, so it can stay; delete it only if you disable the workflow (`gh api -X DELETE repos/RafaelJCamara/AnotherRabbitMqManagementPortal/git/refs/heads/release-please--branches--main--components--source`). Also note `gh repo view` reports this repository as PUBLIC, while the project notes say private; the setting above is a repository-level one either way.

## 3. Other human-only items recorded in `docs/open-questions.md`

Applied by the script (CODEOWNERS; every owner is `@RafaelJCamara`; the `svc-explorer` line (OQ-653) was applied in cd14469 and is skipped):

| Line added | After | Open question |
| --- | --- | --- |
| `/tools/semantics-audit/` | `/tools/semantics-evidence/` | OQ-107 |
| `/libs/shared/domain-model/` | `/tools/semantics-audit/` | OQ-107 |
| `/tools/arch-tests/` | `/libs/shared/domain-model/` | OQ-429 |
| `/tools/conformance-ci/` | `/tools/arch-tests/` | OQ-492, OQ-633 (blocking review finding) |
| `/libs/engine/kernel/src/scheduler/` | `/libs/engine/kernel/src/actions/` | OQ-178 |
| `/libs/engine/ports/` | `/libs/engine/kernel/src/scheduler/` | OQ-178 |
| `/testing/broker-lab/` | `/apps/conformance/` | OQ-86, OQ-429, OQ-458 |
| `/libs/testkit/` | `/testing/broker-lab/` | OQ-86, OQ-429, OQ-458 |
| `/.github/actions/` | `/.github/workflows/` | OQ-633 |

Not added as separate lines because the lines above already cover them: `/libs/testkit/src/it/run-record.ts`, `/libs/testkit/src/it/conformance.it.ts`, `/libs/testkit/src/it/run-conformance.ts` (OQ-429, OQ-458) and `/testing/broker-lab/versions.json` (OQ-458).

With `-IncludeTagDerived` (these projects carry the `trust:critical` tag in `project.json` but no open question proposes a line): `/libs/engine/adapter-amqp091/`, `/libs/engine/jobs/`, `/libs/engine/svc-ops/`, `/libs/ui/design/`.

Not applied, needs your decision (no edit was prepared because the text is a choice, not a transcription):

| Item | What is pending | Where |
| --- | --- | --- |
| `/libs/shared/json-stream/` CODEOWNERS line and `--trustCritical` tag | The reader parses untrusted broker bytes; default is no tag. Line if you want it: `/libs/shared/json-stream/ @RafaelJCamara`. Three recent commits touch it (table in item 4). | OQ-718 |
| UI packages for M0-50 (Spartan helm copies, `@angular/aria`, `@angular/cdk`, `tailwindcss`, `@lucide/angular`, peers `clsx`, `luxon`, `tw-animate-css`) | Catalog + allow-list entries + 3-day check. The report that lists exact versions is not in the repo, so no exact text exists yet; ask for a `wp-spec` pass that pins them. Blocks the explorer's `aria/` wrappers (OQ-758). | OQ-340 |
| `monaco-editor@0.57.0`, `elkjs@0.12.0` catalog and allow-list entries | Wanted by M1-46 and M1-11, not by M0 (`ag-grid-community` 36.2.0 landed in cd14469). The advisories on the `dompurify` that Monaco bundles are unchecked. | OQ-230 |
| `@streamparser/json` 0.0.26 | Only if you prefer it over the hand-written reader that landed (default). Allow-list entry, catalog line, confinement row, no release-age exclusion. | OQ-711 |
| `@napi-rs/keyring` (catalog, allow-list, `allowBuilds`) | Waits for the desktop work package. | OQ-301 |
| Review of allow-list entries added without a block | `zod`, `fast-check` (OQ-151); `rhea` 3.0.5 (OQ-420). | OQ-151, OQ-420 |
| `undici` instead of `node:http` for the management client | Confirm `node:http`, or add `undici`. | OQ-410 |
| `osv-scanner.toml` ignores expire 2026-11-14 | form-data, postcss-selector-parser, undici (build/docs tooling). Not a protected file; needs a decision before the date. | OQ-40 |

Edits to the supply-chain keys that no open question asks for are not in the script.

## 4. Trust-critical commits landed by agents without a human code-owner review (2026-10-20 to 2026-10-21, `origin/main`)

How to read this: every commit below carries `Co-Authored-By: Claude Sonnet 5.5` and your `Signed-off-by`. There is no PR, so CODEOWNERS (which only acts on pull requests) never asked anyone to approve them; "without a human code-owner review" is true of all rows. 27 commits touch these paths; the 49 commits since 2026-10-20 include docs and other changes not listed. No commit since 2026-10-20 touched `libs/engine/kernel/src/actions`, `libs/engine/transport`, `libs/shared/semantics`, `libs/engine/secrets` or `libs/engine/net-*`. Table generated from `git log origin/main --since=2026-10-20 --no-merges` and the files of each commit.

### A. The paths you named

| sha | subject | trust path |
| --- | --- | --- |
| 0e43f9b | fix(ci): give the semantics-evidence hooks room and wait out the quorum return in get-nack-barrier | `libs/engine/adapter-amqp091`, `tools/semantics-evidence` |
| 6ff6d6b | feat(conformance): facts leg for hazards that no registry cell names (M0-41, slice B) | `apps/conformance` |
| 399a1ad | feat(conformance): AMQP 1.0 steps in the lab DSL (M0-38, slice D) | `apps/conformance` |
| c3743c6 | feat(conformance): CF-SETTLE-02 and CF-SETTLE-05 lab scenarios (M0-38, slice C) | `apps/conformance` |
| 33212b4 | fix(conformance): record only the status of a queue-stats read (M0-FIX-1, slice 1b) | `apps/conformance` |
| b74f875 | feat(conformance): CF-SETTLE-01 lab scenario and projection (M0-38, slice B) | `apps/conformance` |
| 1f6e9f3 | fix(conformance): keep management statistics out of the compared artefact (M0-FIX-1, slice 1) | `apps/conformance` |
| 6ad784e | feat(conformance): record broker refusals in the lab DSL and driver (M0-41, slice A) | `apps/conformance` |

`apps/conformance` is where lab evidence is recorded and compared (I-14); `0e43f9b` edits the `get-nack-barrier` adapter contract spec and the vitest timeouts of `tools/semantics-evidence`, so skim that one first. `libs/engine/adapter-amqp091` has no CODEOWNERS line (it carries `trust:critical`; `-IncludeTagDerived` adds it).

### B. Other `trust:critical` or proposed-CODEOWNERS paths

| sha | subject | trust path |
| --- | --- | --- |
| 035fac7 | test(conformance-ci): run the CI tools as processes, pin the project list, clean file names (M0-FIX-1, 2b) | `tools/conformance-ci` |
| a23c84c | test(adapter-mgmt-http): wire proof for the bounded streaming reader (M0-48l, slice D) | `libs/shared/json-stream` |
| e563c1c | feat(json-stream): value reader, abort race and cooperative yield (M0-48l, slice B) | `libs/shared/json-stream` |
| a14a07e | feat(json-stream): bounded array reader (M0-48l, slice A) | `libs/shared/json-stream` |
| e8bbb17 | test(explorer): keep the search equivalence test fast on slow runners (M0-48) | `libs/engine/svc-explorer` |
| 64acd52 | feat(explorer): bindings read through the bounded streaming reader (M0-48l, slice C) | `libs/engine/svc-explorer` |
| b326a91 | perf(explorer): faster name search with a cached folded name (M0-48) | `libs/engine/svc-explorer` |
| 4458d3e | feat(explorer): golden replay, lab run and perf harness (M0-48, slice F) | `libs/engine/svc-explorer` |
| 1f3df6b | test(explorer): keep the 20k specs inside the CI timeout (M0-48) | `libs/engine/svc-explorer` |
| 33e325d | feat(explorer): connections kind (M0-48, #270) | `libs/engine/svc-explorer` |
| 5d8a9fd | fix(explorer): bindings read against the recorded bare-array answer (M0-48, #269) | `libs/engine/svc-explorer` |
| 1b9cb87 | feat(explorer): cost-based sweep cadence and idle stop (M0-48, #271) | `libs/engine/svc-explorer` |
| 7208f4f | feat(explorer): bindings kind (M0-48, slice H) | `libs/engine/svc-explorer` |
| 2c38d5d | feat(explorer): search.query (M0-48, slice G) | `libs/engine/svc-explorer`, `tools/arch-tests` |
| c9d2111 | feat(explorer): explorer.window topic (M0-48, slice E) | `libs/engine/svc-explorer` |
| 6645fbb | feat(explorer): overview.get (M0-48, slice D) | `libs/engine/svc-explorer`, `tools/arch-tests` |
| 6d42494 | feat(explorer): inventory.query over the index (M0-48, slice C) | `libs/engine/svc-explorer` |
| fc3be45 | feat(explorer): bounded inventory index and sweeper (M0-48, slice B) | `libs/engine/svc-explorer` |
| bfe5a79 | feat(explorer): svc-explorer skeleton and inventory.query contract (M0-48, slice A) | `libs/engine/svc-explorer`, `tools/arch-tests` |

`svc-explorer` got its CODEOWNERS line only in cd14469, after most of these landed. `tools/arch-tests` enforces I-2, A-9 and the I-14 independence rule: the two explorer commits that touch it (`2c38d5d`, `6645fbb`) and `bfe5a79` are the ones to read for "did a test get loosened".

## Commit

After the script finishes and `git diff` looks right (run from the repository root; the `pnpm-lock.yaml` change comes from `pnpm install`):

```powershell
git add pnpm-workspace.yaml pnpm-lock.yaml docs/adr/ADR-027-log.md CODEOWNERS
git commit -s -m "fix(deps): override vite 8.3.0 to 8.3.4 (launch-editor advisories); add CODEOWNERS lines for trust-critical paths" -m "osv-scanner: vite 8.3.0 (GHSA-587h-7wmj-h5pm, GHSA-698v-4r3x-3vcv, GHSA-r825-w8mm-5pxw), fixed in 8.3.3. Dev-server only; no bundle contains vite. 8.3.4 is 13 days old, so no release-age exclusion. CODEOWNERS lines from OQ-86, OQ-107, OQ-178, OQ-429, OQ-492, OQ-633. See docs/maintainer/BATCH.md." -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
git fetch origin main; git rebase origin/main; git push origin HEAD:main
gh run list --branch main --limit 5
```

Afterwards: confirm `osv-scanner` goes green (`gh run list --workflow osv-scanner.yml`), then do item 2.
