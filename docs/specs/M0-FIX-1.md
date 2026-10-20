# M0-FIX-1 Review findings: conformance harness, conformance workflows and capability gates

**Issue:** #262 · **Milestone:** M0 · **Wave:** M0-W2 · **Size:** L by label, about 1,000 changed lines by estimate (three slices, each at most 600) · **Owner area:** conformance (lane: evidence) · **trust:critical:** yes

## Goal

Close the findings of the independent reviews of M0-46, M0-42 (slices A and B) and the lab-cell slices of M0-39 and M0-40 (OQ-632, OQ-635 to OQ-642; B1 and B2 were fixed by M0-38 slice A). The maintainer approved this work package and said to proceed with the defaults in the issue and to record any new question in `docs/open-questions.md` instead of asking in chat. Serves I-14 (lab truth outranks registry text: the live leg must be comparable with recorded evidence), I-10 (no broker text in a gate reason) and the required check `conformance` (M0-42).

Nothing here records evidence, edits a registry cell or flips a status. CODEOWNERS lines (OQ-633), the `oversize-approved` label (OQ-634) and the lab statistics interval (`testing/broker-lab`) stay with the maintainer.

## Files & interfaces

**Slice 1, lab artefacts** (`apps/conformance`, Nx project `conformance`, tags `type:test`, `runtime:node`)

- `src/dsl.ts`: `mgmtQueue` records the class of each count (`zero`, `nonzero`, `absent`) instead of the number (B3, OQ-632). `nextDelayedAt` keeps its existing clock class.
- `src/it/dr-determinism.ts`: new. CF-DR-01 and CF-DR-02 twice on a real lab broker; the two records must be equal. Run by `libs/testkit/src/it/conformance.it.ts` (new test beside the CF-DOWN-01 one).
- `src/cells/lab-cells-m0-40.spec.ts`: AC-11 scoped to "the wiring is in place and no cell it names is inconsistent" (see Risks), not "no evidence ever exists".
- `src/record/record.spec.ts`: `openLabHost` forwards `cancel`.
- `src/testing/era-broker.ts`: two corrupted comments (a `\n` that became a line break, `ck_requeue_true`). No behaviour change.
- `src/dsl.spec.ts`: test names that reuse an AC id across work packages get a work-package suffix. No behaviour change.
- `src/scenarios/cf-dr-01.spec.ts`, `src/dsl.spec.ts`, `README.md`, `docs/open-questions.md`.

**Slice 2, conformance workflows** (`tools/conformance-ci`, `tools/supply-chain`, `.github/workflows/conformance-pr.yml`)

- `tools/supply-chain/conformance-workflows.ts` (+ selftest, `project.json` inputs): pin the run text of the nightly leg-status step (NB-4); a `pr.concurrency` rule (NB-7); `checkSingleConformanceJob` over all workflow files (NB-9).
- `.github/workflows/conformance-pr.yml`: the concurrency group is `conformance-pr-${{ github.event.pull_request.number || github.sha }}`. Nothing else changes (permissions, pins, jobs).
- `tools/conformance-ci/src/plan.ts`: file names lose control characters before they reach a reason (NB-8); `plan.spec.ts` pins `CONFORMANCE_PROJECTS` (NB-6).
- `tools/conformance-ci/src/cli.spec.ts`: new; `spawnSync` tests of `verdict-cli`, `report-cli`, `plan-cli` (NB-5).

**Slice 3, gates** (`libs/engine/svc-capabilities`, `type:service`)

- `src/gates/index.ts`: still fail closed; the closed decision of a thrown error names the error class (constructor name, never the message) in `source` (NB-2). `src/gates/gates.spec.ts`: NB-1 and NB-2 tests. README line.

## Out of scope

- CODEOWNERS, labels, repository settings, `testing/broker-lab` (statistics interval), dependencies, `testing/lab-evidence/**`, registry cells and their statuses.
- M0-38 slice B (CF-SETTLE) and M0-41 slice A (refusal recording): other agents; shared files are edited additively.
- The `projections-down.ts` refactor onto `counters.ts` (OQ-574).

## Acceptance criteria

Test names quote the AC id with the work package, `AC-n (M0-FIX-1) ...`, so the ids do not collide with those of the specs M0-15, M0-39, M0-40, M0-42 and M0-46 that share a file.

| ID | Given | When | Then | Test |
| --- | --- | --- | --- | --- |
| AC-1 | a `mgmtQueue` step and management answers whose counts differ in value but not in class | the scenario runs | each count is recorded as `zero`, `nonzero` or `absent` (a non-count is `absent`); two runs on different values of one class give byte-equal records | `apps/conformance/src/dsl.spec.ts`: "AC-1 (M0-FIX-1) a queue-stats step records the class of each count, never its value" |
| AC-2 | CF-DR-01 on the era broker with the stat counts replaced by other values of the same class | recorded twice | the records are equal; a count that changes class changes the record | `apps/conformance/src/scenarios/cf-dr-01.spec.ts`: "AC-2 (M0-FIX-1) CF-DR-01 records the same artefact whatever the statistics said at the moment of the read" |
| AC-3 | the cells the wired CF ids name, and a planted cell that is `code-derived` with evidence, or `lab-verified` with none | the consistency check runs | the real cells pass (whatever evidence exists later); each planted cell is reported | `apps/conformance/src/cells/lab-cells-m0-40.spec.ts`: "AC-3 (M0-FIX-1) the wired lab cells are consistent: a status and its evidence agree, whenever the evidence arrives" |
| AC-4 | `openLabHost` with an injected connection and a channel that records `basic.cancel` | `consume` is called with `cancel` false, then true | no cancel is sent in the first case and one is sent in the second | `apps/conformance/src/record/record.spec.ts`: "AC-4 (M0-FIX-1) the real host forwards the cancel flag to the driver" |
| AC-5 | a real lab broker | CF-DR-01 and CF-DR-02 each run twice | steps and observations are equal | `libs/testkit/src/it/conformance.it.ts`: "AC-5 (M0-FIX-1) CF-DR-01 and CF-DR-02 are deterministic across two live runs" (needs Docker; runs in CI, not on this Windows machine) |
| AC-6 | `conformance-nightly.yml` | the leg-status step's `run` text changes (another file, another value, a trailing command) | `nightly.leg-status` fires; the real file passes | `tools/supply-chain/conformance-workflows-selftest.ts`: "AC-6 (M0-FIX-1) the run text of the nightly leg-status step is pinned" |
| AC-7 | `verdict-cli`, `report-cli` and `plan-cli` run as processes with a given environment | each runs | exit code, step summary and `$GITHUB_OUTPUT` content are as the contract says (pass and fail, malformed input fails closed) | `tools/conformance-ci/src/cli.spec.ts`: "AC-7 (M0-FIX-1) verdict-cli exits 0 only on a pass and writes the step summary", "... report-cli ...", "... plan-cli ..." (one test per tool, listed as AC-7a, 7b, 7c in the names) |
| AC-8 | `CONFORMANCE_PROJECTS` | the list is compared with the pinned list | it is exactly `semantics, conformance, adapter-amqp091, adapter-mgmt-http, broker-lab, testkit`; a project missing from it fails | `tools/conformance-ci/src/plan.spec.ts`: "AC-8 (M0-FIX-1) the conformance project list is pinned" |
| AC-9 | `conformance-pr.yml` | the concurrency group is changed back to the ref, or `cancel-in-progress` loses its pull-request condition | `pr.concurrency` fires; the real file passes | `tools/supply-chain/conformance-workflows-selftest.ts`: "AC-9 (M0-FIX-1) a push is its own concurrency group, so no intermediate commit loses its run" |
| AC-10 | changed files whose names contain a newline, a carriage return, an escape or a bidi override | the plan is made | no reason holds a control or format character; the name is otherwise kept | `tools/conformance-ci/src/plan.spec.ts`: "AC-10 (M0-FIX-1) a file name cannot inject a line into a reason" |
| AC-11 | the workflow files and a planted copy that defines a job `conformance` (key or `name:`) | the single-job check runs | only `conformance-pr.yml` passes; the planted copy is reported | `tools/supply-chain/conformance-workflows-selftest.ts`: "AC-11 (M0-FIX-1) only conformance-pr.yml defines a job named conformance" |
| AC-12 | a profile whose facts have `amqp` undefined | gates are computed | `amqp.peek`, `amqp.tap`, `amqp.publish`, `amqp.replay` are closed with reason `the AMQP handshake did not run` and source `probe step 12 (amqp-handshake)`; the other gates are unchanged | `libs/engine/svc-capabilities/src/gates/gates.spec.ts`: "AC-12 (M0-FIX-1) a missing AMQP handshake closes the four amqp gates" |
| AC-13 | a registry that throws a `TypeError` whose message holds a secret-looking string | gates are computed | every gate is closed, `source` carries `TypeError` and never the message; a thrown non-error carries a fixed word | `libs/engine/svc-capabilities/src/gates/gates.spec.ts`: "AC-13 (M0-FIX-1) an unreachable decision stays closed and names the error class, never its message" |

## Verification

```sh
pnpm nx run-many -t lint typecheck test -p conformance
pnpm nx run-many -t lint typecheck test -p conformance-ci
pnpm nx run-many -t lint typecheck test -p svc-capabilities
pnpm nx run-many -t gates-selftest actions-pinned-selftest workflow-hardening-selftest conformance-workflows-selftest -p supply-chain
pnpm nx run supply-chain:actions-pinned
pnpm nx run supply-chain:gates
pnpm nx affected -t lint typecheck test --base=origin/main
pnpm nx test arch-tests
pnpm nx run semantics:audit-cells
pnpm nx run semantics-evidence:check --base=origin/main
pnpm nx run conformance:coverage
pnpm format:check
# needs a Docker daemon (CI): the live determinism check of AC-5
pnpm nx run conformance:it
```

## Slices

| Slice | Content | ACs | Budget (changed lines) |
| --- | --- | --- | --- |
| 1. Lab artefacts | classes in `mgmtQueue`, AC-11 scope, `cancel` test, comments, test names, the live DR determinism check | AC-1 to AC-5 | at most 450 |
| 2. Conformance workflows | NB-4 to NB-9 | AC-6 to AC-11 | at most 600 |
| 3. Gates | NB-1, NB-2 | AC-12, AC-13 | at most 200 |

Each slice is its own commit, rebased on `origin/main` and pushed before the next begins. The last carries `Closes #262`.

## Risks / questions

- **B3 default is not a full cure.** A class (`zero`/`nonzero`/`absent`) read at a fixed moment can still straddle a statistics refresh (a stat read right after a return can be stale, or absent before the first emission). The default narrows the difference from "any value" to "the class", and the live determinism check (AC-5) is the arbiter. If it flakes in CI the maintainer chooses between waiting for a refresh in the scenario and lowering `collect_statistics_interval` in `testing/broker-lab` (OQ-645). No projection or registry cell reads these counts today, so the evidence the cells are judged on (`basic.get` reads) is unaffected.
- **AC-3 mechanism.** A test that compares with a base needs git history and `origin/main`, which a shallow CI checkout lacks, and a pinned list of statuses goes red when a maintainer merges the bot's evidence. The check therefore asserts consistency (status and evidence agree) on the cells the wired ids name, with the planted-violation proof. "This change flips nothing" stays enforced by `semantics-evidence:check --base`, which already compares with the base (I-14).
- **NB-2 carries the class in `source`, not a new contract field.** `GateDecisionSchema` is a strict contract; adding a field is a wider change. The class is the constructor name, accepted only if it is an identifier of at most 64 characters, else `Error`; non-errors give `non-error`.
- **NB-7** changes the group of every non-pull-request run to its commit, so two pushes run concurrently instead of one replacing the other (the maintainer lands on `main` without pull requests, so every commit gets its `conformance` run). Cost: more concurrent lab runs when commits land close together; recorded in OQ-646 as a maintainer choice (the alternative is to accept a run on the latest commit only).
- The DR determinism check is written but cannot run on this machine (no Docker daemon); CI runs it.
- Estimated changed lines: slice 1 about 420, slice 2 about 560, slice 3 about 120.

## DoD checklist

- [ ] Spec linked; every AC has a named test (AC-5 runs in CI only).
- [ ] Verification commands pass locally and in CI.
- [ ] `nx affected -t lint typecheck test` and the supply-chain gates are green.
- [ ] Boundaries, confinement and custom lint rules pass; no `eslint-disable`.
- [ ] READMEs updated (`apps/conformance`, `tools/conformance-ci`, `svc-capabilities`).
- [ ] trust:critical: adversarial review and human CODEOWNERS approval (maintainer).
- [ ] At most 600 changed lines per commit.
- [ ] Conventional Commits title, DCO sign-off, agent co-author trailer, `Closes #262` on the last slice.
