# conformance

The conformance suite: one cell per conformance id, run against recorded lab evidence and a live broker, and the recorder that produces that evidence (M0-15).

Tags: `type:test`, `runtime:node`. Trust-critical (I-14, amendment A-20).

## What is here

| Path                    | Purpose                                                                                                                                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/cells/`            | The lab-cell specs (one per CF id, made by the `conformance-cell` generator). They compare a live run and the registry cell with recorded evidence; they never write it.                                                                       |
| `src/driver/`           | Raw protocol drivers: `amqp091-raw.ts` (amqplib), `amqp10-raw.ts` (rhea), `http-raw.ts` (management API) and `lab-endpoint.ts`, the one door to a broker.                                                                                        |
| `src/dsl.ts`            | The LabScenario DSL: `declareQueue`, `openChannel`, `publish`, `get`, `consume`, `settle`, `recover`, `mgmtGet`, `observe`; `defineScenario` checks a scenario, `runScenario` runs it and returns the evidence's `steps` and `observations`.   |
| `src/scenarios/`        | The scenarios `conformance:record` can run, by CF id (`CF-SMOKE-01` so far).                                                                                                                                                                    |
| `src/record/`           | The recorder: `evidence.ts` (schema, canonical JSON, integrity digest), `provenance.ts`, `secrets.ts`, `write.ts`, `record.ts`, `cli.ts`, `print-schema.ts`; and the workflow's bundle checks `bundle.ts` and `bundle-cli.ts` (Node built-ins only, M0-71). Imports nothing from `@app/semantics` (arch test). |
| `src/assert/`           | The three-way assertion (M0-37): `three-way.ts` (`evaluate`, `CellResult`, `assertResult`), `diff.ts` (field-level diff), `projections.ts` (what evidence says of a cell), `evidence-store.ts`, `live.ts`, `run-case.ts`, `cell-spec.ts` (`describeThreeWay`, called by every lab-cell spec), `coverage.ts` and `coverage-cli.ts` (the coverage gate), `report.ts`. Reads evidence and the registry; writes neither. |
| `src/it/drivers-smoke.ts` | What the raw drivers do on a real lab broker; run by `libs/testkit/src/it/conformance.it.ts`.                                                                                                                                                 |
| `src/it/three-way-smoke.ts` | The live leg of the three-way assertion on a real lab broker (a matching run, then a differing one); run by `conformance.it.ts`.                                                                                                            |
| `src/testing/`          | Test doubles for the specs (a fake Docker, an in-memory broker host). Not used by the recorder.                                                                                                                                                 |

## Recording evidence

```sh
pnpm nx run conformance:record --cells=CF-SMOKE-01 --versions=4.3.6      # needs a Docker daemon
pnpm nx run conformance:record --cells='CF-SETTLE-*' --versions=4.2.9,4.3.6 --out=dist/lab-evidence-local
pnpm nx run conformance:it --versions=4.3.6                              # the recorder and the drivers on a real broker
```

`libs/testkit/src/it/run-record.ts` starts a broker per version with `startBroker` and runs `src/record/cli.ts` as a child process with the broker in `LAB_BROKER` (data, not an import: the recorder does not depend on the testkit).

- **Only CI records evidence (A-20).** In the `conformance-record.yml` workflow (`GITHUB_WORKFLOW_REF`), the artefacts are stamped `ci` (commit, workflow, run URL) and written to `testing/lab-evidence/<broker-version>/<CF-id>.json`; a bot pull request carries them and a human approves. Anywhere else the stamp is `local`, the files go to a fresh temporary folder (or `--out`), and the writer refuses a `local` artefact for the evidence tree, however the folder is spelled or linked. Agents and specs never write `testing/lab-evidence/**`; the specs here use temporary folders.
- **The workflow (M0-71).** `.github/workflows/conformance-record.yml` is manual (`workflow_dispatch`, inputs `cells`, `versions`, `dry_run`, default a dry run) and runs only on the default branch. The `record` job (read-only token) validates the inputs, starts the digest-pinned lab brokers, runs `conformance:record --out=dist/lab-evidence-bundle` and checks the bundle with `src/record/bundle-cli.ts check --integrity`: layout, a `ci` stamp for this commit, run and workflow, the pinned image digests, every requested cell on every requested version, schema and SHA-256. The `propose` job (the only write token, given to its last step; used only when `dry_run` is off) installs nothing, re-checks with Node built-ins, copies the bundle into a `lab-evidence/run-<id>-<attempt>` branch and opens a pull request labelled `lab-evidence`. Nothing is merged, approved or pushed to the default branch. `tools/supply-chain/workflow-hardening-selftest.ts` pins all of this (OQ-460 to OQ-464).
- **The driver refuses any endpoint broker-lab did not create (AC-2).** `verifyLabEndpoint` takes the broker data and asks Docker: the container must be named, labelled and built like a broker-lab container of that version, running, with the AMQP and management ports published on `127.0.0.1` at exactly the ports given, and the digest must be the pin in `testing/broker-lab/versions.json`. It then mints a frozen `LabEndpoint` that it remembers; the three raw drivers and the real host accept nothing else (a copy or a hand-made object is refused, as is any address that is not `127.0.0.1`, or carries a login).
- **Tamper-evident.** An artefact carries a SHA-256 over its own canonical JSON; `verifyArtefact` / `verifyEvidenceText` fail on any edit, a missing or extra field, and a file moved to another version or id. The digest cannot stop someone who recomputes it: the control for that is the bot PR, the human approval and the run URL, which `tools/semantics-evidence` follows through the GitHub API (OQ-450 says what that cannot catch).
- **No secrets.** A step records only the fields its operation defines (queue and channel aliases, message ids, tags, counts, byte sizes, the broker's answers), never a body, a header, a URL or the lab login. `findSecrets` then scans the whole artefact (URL logins, bearer and basic headers, JWTs, private keys, credential key names, and the login in the encodings a URL or header uses) before it is sealed and again before it is written, and the run stops without writing anything.
- **All or nothing.** Every artefact of a run is built and checked before the first file is written.
- **A fresh connection per scenario.** `recordCells` opens (and closes) one connection for each scenario: delivery tags count per channel and a scenario may break its channel on purpose, so an artefact must not depend on the scenarios recorded before it. The live leg of the three-way assertion replays a scenario alone on a fresh connection and compares (M0-37).
- `testing/lab-evidence/schema.json` is a protected path: a maintainer generates it with `node apps/conformance/src/record/print-schema.ts > testing/lab-evidence/schema.json` (OQ-421).

## The three-way assertion (M0-37)

For one conformance id on one lab version, `evaluate` compares three things and returns a `CellResult {cellId, cfId, version, live, evidence, registry, verdict, reasons}` per registry cell that names the id for that version's era (or one with `cellId: null` when none does):

| Leg        | What it checks                                                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live`     | The scenario run now on a lab broker, against the artefact, field by field (`cfId`, title, protocol, broker version, image digest, every step and observation). A difference is a `mismatch` with the path of each field that moved. |
| `evidence` | The artefact must verify (digest, placed where its content says), carry a `ci` stamp (a `local` one is refused), and be recorded on the image the lab pins for that version.                |
| `registry` | The cell's effect against what the evidence shows of it, through the id's `Projection` (`projections.ts`). A cell whose id has no projection, no derived effect or no evidence cannot be confirmed. |

`pass` needs all three to agree. `fail` is any disagreement, evidence that does not verify, and a cell with a lab status that the evidence does not confirm (or a `lab-contradicted` one: a human corrects it against the evidence). Everything the run could not establish is `unverified`: no evidence recorded yet, no live broker, no registry cell for the id, no derived effect, no projection. Unverified is shown, never green: the cell spec skips it with the reasons, `--strict` makes it a failure (the release gate), and the launcher prints every result that is not a pass.

```sh
pnpm nx run conformance:test                                              # every spec, no Docker; the cells compare recorded evidence with the registry
pnpm nx run conformance:test --grep=CF-SMOKE --versions=4.3.6              # the lab-cell specs live on one broker per version (needs Docker)
pnpm nx run conformance:test --versions=3.13.7,4.0.9,4.1.8,4.2.9,4.3.6 --shard=1/4 --strict
pnpm nx run conformance:coverage [--strict]                                # the coverage gate
```

- `conformance:test` is not cached (a replayed result would stand in for a live run). `--versions` runs only the lab-cell specs, live, one broker per version; `--non-blocking` (default `4.0.9`, end-of-life) names versions whose failures are shown but do not fail the command; `--grep` filters the test names and `--shard=i/n` the spec files.
- A lab-cell spec is `describeThreeWay('CF-X-01')`. The older stubs are still `it.todo` pairs; they become `describeThreeWay` calls in the work package that writes their scenario and projection (OQ-459).
- The coverage gate (`coverage.ts`) always fails a cell that names a conformance id without a lab-cell spec, any recorded leg that disagrees, and a cell with a lab status that recorded evidence does not confirm on every lab version of its era. `--strict` also fails any cell without confirming evidence on every lab version of its era, and any id with no scenario (the release gate: no Tier-1 claim and no "lab-verified" badge without a green run over every cell).
- The status of a cell flips only with evidence: that is the `semantics-evidence` check ([tools/semantics-evidence](../../tools/semantics-evidence/README.md)), not this project.

## Conformance in CI (M0-42)

`.github/workflows/conformance-pr.yml` runs this suite on every change that can affect it: the `plan` job (`tools/conformance-ci`) decides from the Nx affected projects (`semantics`, `conformance`, `adapter-amqp091`, `adapter-mgmt-http`, `broker-lab`, `testkit`) and a few watched files, then the `lab` job runs `pnpm nx run conformance:test --versions="$VERSION" --shard="$SHARD"` for each of the five pinned lab versions in 2 shards on the Node of `.nvmrc`. The job named `conformance` is the required check: it always reports, passes an unaffected change with a reason, and fails when the plan or any lab job did not succeed. A cell with no recorded evidence is `unverified` (shown, skipped, never green, never a failure); `--strict` is the release gate and is not used there. The workflows run the suite and never record evidence: only `conformance-record.yml` does (`tools/supply-chain/conformance-workflows-selftest.ts` pins this). Dry run of the plan: `pnpm nx run conformance-ci:plan --base=origin/main`. `.github/workflows/conformance-nightly.yml` runs every lab version on Node 24.22.0 and on Node 26.12.0 (blocking), non-release builds (`alpha`: may fail, listed as `fail`; empty until OQ-81, then `not available`) and reports the Electron-runtime leg as `not available` until M2; its `report` job writes the step summary and the `conformance-nightly-report` artifact.
## Public API

- Nothing is exported from `src/index.ts`; the suite is the specs in `src/cells/`, and the recorder is run as a command.

## Invariants

- Every cell asserts that the live run matches the recorded evidence and that the registry cell matches it (blueprint 5.2).
- Evidence in `testing/lab-evidence/` is recorded by a separate job and committed by a human; a cell never writes it, and neither does any code here outside a `ci` run of the recorder.
- The recorder, the drivers, the DSL and the scenarios read nothing from the registry and import no `@app/*` package (`checkRecorderIndependence` in `tools/arch-tests`), so evidence cannot be shaped to fit a cell, and Node runs them without a build.
- This project may import amqplib and rhea (third-party confinement, blueprint 2.4, OQ-420). Its sockets go only to loopback lab brokers, which is why it is on the `net` confinement list and does not use the Dialer (I-9).

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p conformance
pnpm nx test arch-tests
pnpm nx run conformance:record --cells=CF-SMOKE-01 --versions=4.3.6
pnpm nx run conformance:test --grep=CF-SMOKE --versions=4.3.6
pnpm nx run conformance:coverage
```

Open questions: OQ-420 to OQ-429, OQ-450 to OQ-459 and OQ-460 to OQ-464 in [docs/open-questions.md](../../docs/open-questions.md).
