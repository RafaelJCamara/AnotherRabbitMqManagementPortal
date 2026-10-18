# platform-lane

Automation for the platform upgrade lane ([runbook](../../docs/runbooks/platform-upgrade-lane.md), amendment A-25, work item M0-76). It finds a new stable major of a pinned platform and opens one `lane:platform` issue for it. Plain TypeScript on Node type stripping; the only dependency is `yaml`.

## Proof commands

| Command                                                          | What it proves                                                                                                                                             |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm nx run platform-lane:test`                                 | The self-test: detection against fake registries, the release-age gate, the compatibility checks, the issue text, de-duplication, and the workflow and Renovate rules. |
| `node tools/platform-lane/run-platform-lane.ts detect`           | Reads the real pins and registries and prints the plan and a table of every platform. Needs the network, no token.                                         |
| `node tools/platform-lane/run-platform-lane.ts open --plan=<f> --dry-run` | Prints the issues it would open for a plan file. Needs `gh` with read access to issues.                                                            |

## How it decides

1. **Pins** come from the repository: the pnpm catalog, `.nvmrc` and `packageManager`. `platforms.json` carries a `fallback` only for a platform that is not installed yet (Electron, fastify).
2. **Candidates** are platforms with a stable release of a higher major (Node: even majors only) that is at least `minimumReleaseAge` old, read from `pnpm-workspace.yaml`. The target is the newest version of the newest such major that passes the gate.
3. **Checks** read `engines.node` and `peerDependencies` from the npm registry and compare them with the pinned set (for example: does the latest `@angular/compiler-cli` accept the new TypeScript). A check that fails and is marked `blocking` defers the issue; the others are listed in it. Missing metadata is `unknown`, never a pass.
4. **Issues** carry a hidden marker (`<!-- platform-lane:<platform>:<major> -->`). A platform and major with an issue, open or closed, is never filed again.

## Files

| File                       | Role                                                                    |
| -------------------------- | ----------------------------------------------------------------------- |
| `platforms.json`           | The pinned platform set, runbook targets, checks and Renovate groups    |
| `manifest.ts`              | Manifest validation and pin resolution                                  |
| `registry.ts`              | npm and Node release data behind a `Registry` interface                 |
| `detect.ts`                | Candidates, the release-age gate and the checks                         |
| `issue.ts`                 | Issue text, plan validation, de-duplication and the job-summary table   |
| `semver.ts`                | The small semver subset needed to read `engines` and peer ranges        |
| `run-platform-lane.ts`     | CLI used by `.github/workflows/platform-upgrade-lane.yml`               |
| `platform-lane-selftest.ts` | The `node --test` self-test                                            |

To add a platform, add an entry to `platforms.json` and a group with the same package list to `renovate.json`; the self-test fails when they disagree.
