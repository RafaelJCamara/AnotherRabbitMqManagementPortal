# conformance-ci

Plans, gates and reports of the conformance CI workflows, and the targeted-mutant runner (M0-42).

Tags: `type:test`, `runtime:node`, `trust:critical`.

The workflows only **run** the conformance harness. They never record evidence (that is `conformance-record.yml`, amendment A-20), never write to `testing/lab-evidence/**`, and hold no write token and no secret. `tools/supply-chain/conformance-workflows.ts` pins that, and `conformance-workflows-selftest.ts` plants a violation of each rule.

## What is here

| Path                  | Purpose                                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/plan.ts`         | `planConformance`: is a change affected (an Nx project in `CONFORMANCE_PROJECTS`, or a watched file in `WATCHED_PATHS`) and which (lab version, shard) pairs does it run. An unknown base or a failed query means affected (fail closed). |
| `src/plan-input.ts`   | Strict parsers for what the CLI reads: revisions, the shard count, the Nx project list, the changed files, the `$GITHUB_OUTPUT` lines.                                                                                               |
| `src/plan-cli.ts`     | The `plan` job: reads git and Nx, writes `affected=` and `matrix=` to `$GITHUB_OUTPUT`. Also the dry run `nx run conformance-ci:plan --base=origin/main`.                                                                             |
| `src/verdict.ts`      | `verdict`: the decision of the required check `conformance` from the results of the `plan` and `lab` jobs.                                                                                                                           |
| `src/verdict-cli.ts`  | The `conformance` job: reads `AFFECTED`, `PLAN_RESULT`, `LAB_RESULT`; exit 1 fails the check.                                                                                                                                        |
| `src/lab-versions.ts` | The lab versions of `testing/broker-lab/versions.json`, exact `major.minor.patch` only.                                                                                                                                              |

The CLIs use Node built-ins only (erasable TypeScript), so a workflow step runs them with `node` and no build.

## Public API

- `planConformance(input)`, `CONFORMANCE_PROJECTS`, `WATCHED_PATHS`; types `Plan`, `PlanInput`, `MatrixEntry`.
- `verdict(input)`, `parseAffected`, `parseJobResult`, `JOB_RESULTS`; types `Verdict`, `VerdictInput`, `JobResult`.
- `parseLabVersions`, `readLabVersions`, `EXACT_VERSION`.

## Invariants

- Dependencies follow the type:test row of blueprint 2.2; `pnpm nx lint conformance-ci` enforces them.
- I-14: nothing here records evidence or reads or writes `testing/lab-evidence`.
- A required check always reports: an unaffected change passes with a reason, and a plan, lab or affected value that cannot be read fails.
- The matrix is never skipped on doubt: an unreachable base, a failed Nx query or an unknown changed-file list means affected.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p conformance-ci
pnpm nx run conformance-ci:plan --base=origin/main     # prints the plan for this change; starts no broker
pnpm nx run supply-chain:conformance-workflows-selftest
```
