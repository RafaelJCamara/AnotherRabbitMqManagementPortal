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
| `src/it/drivers-smoke.ts` | What the raw drivers do on a real lab broker; run by `libs/testkit/src/it/conformance.it.ts`.                                                                                                                                                 |
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
- **Tamper-evident.** An artefact carries a SHA-256 over its own canonical JSON; `verifyArtefact` / `verifyEvidenceText` fail on any edit, a missing or extra field, and a file moved to another version or id. The digest cannot stop someone who recomputes it: the control for that is the bot PR, the human approval and the run URL (OQ-422).
- **No secrets.** A step records only the fields its operation defines (queue and channel aliases, message ids, tags, counts, byte sizes, the broker's answers), never a body, a header, a URL or the lab login. `findSecrets` then scans the whole artefact (URL logins, bearer and basic headers, JWTs, private keys, credential key names, and the login in the encodings a URL or header uses) before it is sealed and again before it is written, and the run stops without writing anything.
- **All or nothing.** Every artefact of a run is built and checked before the first file is written.
- `testing/lab-evidence/schema.json` is a protected path: a maintainer generates it with `node apps/conformance/src/record/print-schema.ts > testing/lab-evidence/schema.json` (OQ-421).

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
```

Open questions: OQ-420 to OQ-429 and OQ-460 to OQ-464 in [docs/open-questions.md](../../docs/open-questions.md).
