# semantics-evidence

The semantics-evidence check (M0-37, invariant I-14, blueprint 5.2, amendment A-20): it fails a change to a registry cell's status or effect that no valid, CI-recorded lab evidence artefact supports, and it fails any evidence file that is not what the recorder's CI workflow wrote.

Tags: `type:test`, `runtime:node`, `trust:critical`.

```sh
pnpm nx run semantics-evidence:check --base=origin/main
pnpm nx test semantics-evidence
```

`--base` is required. The change is `merge-base(<base>, HEAD)` to the working tree, untracked files included. The GitHub token for the run check is read from `GITHUB_TOKEN` or `GH_TOKEN`, never from an argument. Exit 0 is a pass, 1 a finding, 2 a usage or environment error (an unreadable base is never a pass).

## What it fails

Cells are matched by key, not by id: deleting a verified cell and adding another with the same key is still a change of that cell.

| Rule              | Fails when                                                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evidence-file`   | A file under `testing/lab-evidence` is not `<broker-version>/<CF-id>.json`, is not valid JSON of the artefact shape, has a wrong digest (tampered), sits under another version or id than its content says, or is a link or too large. `schema.json` and `README.md` are the only other files allowed. |
| `evidence-local`  | An artefact carries a `local` provenance stamp: it was not recorded by the CI workflow.                                                                   |
| `evidence-pin`    | An artefact names a broker version the lab does not pin, or an image digest other than the pin in `testing/broker-lab/versions.json`.                     |
| `evidence-run`    | The `ci` stamp does not trace to a good run (below). Checked for every artefact the change adds or modifies and for the evidence of every cell the change touches; `--verify-all-runs` checks all of them. |
| `cell-evidence`   | A cell lists evidence that does not exist, is not valid (any rule above), is for a conformance id the cell does not name, or was recorded on a broker of another era than the cell's. Applies to every cell that lists evidence, not only to changed ones. |
| `status-evidence` | A cell with a lab status (`lab-verified`, `lab-contradicted`) lists no evidence.                                                                          |
| `status-change`   | A cell's status changed against the base and the cell has no valid evidence.                                                                              |
| `effect-change`   | A cell's effect changed against the base and the cell has no valid evidence. The one exception is deriving a stub: a `null` effect on a `code-derived` cell with no evidence may become a value (OQ-451). |
| `cell-conformance`| A cell names no conformance id (`semantics:audit-cells` fails it too).                                                                                    |

## The run behind a CI stamp (I-14)

A stamp is written from environment variables, so on its own it proves nothing. For each artefact it must check, the check asks the GitHub API (`GET /repos/{repo}/actions/runs/{id}[/attempts/{n}]`) and requires: the run URL is on `https://github.com` and in this repository (`--repo`, else `GITHUB_REPOSITORY`, else the `origin` remote); the stamped workflow is `conformance-record.yml` of this repository on an allowed branch (`--branches`, default `main`); the run is of that workflow file, in this repository, built from that repository, for the stamped commit, started by an allowed event (`--events`, default `workflow_dispatch`), `completed` with conclusion `success`, with the stamp's time inside the run's time (10 minutes of slack), and the stamped commit is in the history of the change. The repository, workflow and host come from the policy, never from the artefact; the artefact only supplies a run number. Any API failure is a finding. The client is injected in the tests (`RunApi`), so every rule is tested offline.

It cannot tell a genuine artefact from one a person edited and re-sealed under the same real run: that needs the workflow to attest the digest (OQ-450).

## Files

| Path                          | Purpose                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `src/check.ts`                | The pure check: everything it looks at is an argument.                                                                                |
| `src/runs.ts`                 | The run verifier and the GitHub API client.                                                                                           |
| `src/evidence-format.ts`      | A second reader of the artefact format. It is not imported from `apps/conformance` (an application cannot be imported by a library); `apps/conformance/src/assert/format-parity.spec.ts` proves both readers accept and refuse the same texts. |
| `src/cli.ts`, `src/dump-cells.ts`, `register.mjs` | The command. `register.mjs` resolves `@app/*` and, with `SEMANTICS_EVIDENCE_REV`, serves the registry sources from the base commit, so the base registry is read without a checkout. The registry code of a revision (the code under check) runs in a child process that does not get the GitHub token (I-10); the era of each lab version is resolved there too. |

It only reads: it never writes `testing/lab-evidence` or the registry.

## Public API

`checkEvidence`, `EVIDENCE_PREFIX`, `createRunVerifier`, `DEFAULT_POLICY`, `githubRunApi`, `parseEvidence`, `canonicalJson`, `digestOf`, `EvidenceFormatError` and the types `CheckInput`, `Finding`, `Evidence`, `CiProvenance`, `RunApi`, `RunInfo`, `RunPolicy`, `CellSnapshot`.

## Invariants

- Fails closed: an unreadable base, a failed API call, an unknown repository, a link in the evidence tree and an unexpected file are all findings or errors, never passes.
- Evidence is trusted for what CI wrote, not for what a file says about itself; the registry is trusted for nothing without evidence (I-14).
- Test names quote the AC id they prove (`AC-1 ...`); the specs build fake evidence in memory or in temporary folders and never write `testing/lab-evidence`.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p semantics-evidence
pnpm nx run semantics-evidence:check --base=origin/main
```

Open questions: OQ-450 to OQ-459 in [docs/open-questions.md](../../docs/open-questions.md).
