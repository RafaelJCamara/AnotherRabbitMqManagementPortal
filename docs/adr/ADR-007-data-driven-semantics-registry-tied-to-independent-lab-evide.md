# ADR-007: Data-driven semantics registry tied to independent lab evidence

- **Status:** Accepted
- **Date:** 2026-10-16
- **Source:** design panel (final blueprint); see [docs/architecture/blueprint.md](../architecture/blueprint.md)

## Decision

Typed data files hold the settle matrix, counters, DLX carry-over, delayed retry, hazards, capabilities, warnings, caps, tap rules, provider presets and effective-config tables. Each cell carries citations, CT ids, a status and lab-evidence artefacts. A missing cell throws SemanticsGapError, and the system falls back to conservative rules. Status flips need an evidence artefact and CODEOWNERS sign-off. Tests assert a three-way match between the live run, the recorded evidence and the registry. The suite is mutation-tested nightly. A per-cluster verification state drives the handling of unverified broker versions.

## Rationale

Required by DC-01, DC-02, DC-47 and DC-60. Independent evidence stops an agent from turning a red run green by editing a cell.

## Alternatives considered

Hard-coded version checks; tests that read their expectations only from the cells.

## Consequences

New broker versions become data PRs plus lab runs. Unverified versions get conservative caps, extra consent and MCP mutations turned off.
