# semantics

`@app/semantics`: the broker semantics registry core (DC-01/02, ADR-007, blueprint 5.2). Typed data cells keyed by era, queue type, protocol, action, limit state and delayed-retry mode, each linked to lab evidence that is recorded outside the registry, plus a fail-closed lookup interface and the conservative era and verification resolver.

Tags: `type:pure`, `runtime:isomorphic`, `trust:critical` (a human CODEOWNERS sign-off is required).

This package is the mechanism. The data arrives with M0-12 (settle matrix, counters, DLX carry-over, delayed retry) and M0-13 (hazards, capabilities, warnings, peek caps, tap rules, provider presets); until then every table is empty, so every lookup is a gap.

## Public API

| Area         | Exports                                                                                                                                         | File                |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Cell types   | `SemanticsCell` / `SemanticsCellSchema`, `CellKey`, `SettleEffect`, `Citation`, `CellStatus`, `EvidencePathSchema`, `cellKeyString` (types and schemas) | `src/schema.ts`     |
| Errors       | `SemanticsGapError` (a missing or unusable entry), `RegistryDataError` (invalid data)                                                           | `src/schema.ts`     |
| Registry     | `createRegistry(data)`, `BrokerSemanticsRegistry`, `RegistryDataSchema`, `validateRegistryData`; `semanticsRegistry` is the one this release ships | `src/registry.ts`   |
| Era          | `resolveEra(EraInputs)` returning `{ era, reasons, conservative, verification }`                                                                | `src/era.ts`        |
| Doom guard   | `isDoomed(era, counters, limit)`, `DeliveryLimit`                                                                                               | `src/doomed.ts`     |
| Tables       | `WarningDefSchema`, `GateRuleSchema`, `PeekCapRowSchema`, `TapRuleSchema`, `HazardRuleSchema` and their types                                   | `src/{warnings,gates,caps,tap-rules,hazards}.ts` |
| Audit        | `auditCells(cells, { require, evidenceExists })`                                                                                                | `src/audit.ts`      |
| Data         | `registryData`, `SEMANTICS_VERSION`, `settleMatrix`                                                                                             | `src/data/`         |

## How the lookups fail

| Lookup                      | When it throws `SemanticsGapError`                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `cell(key)`                 | No cell has exactly this key, or the cell's effect is `null` (not derived yet), or its status is `lab-contradicted`.       |
| `warning(id)`               | Unknown `W-*` id.                                                                                                         |
| `gate(feature, profile)`    | The feature has no gate rule.                                                                                             |
| `peekCaps(era, q, role, v)` | No row for the key, or, for a build that is not `verified`, no row in the conservative 4.0-4.2 era.                       |

Not a gap, by design: `tapRule` refuses an exchange type nobody described (`diverts`, no e2e, refuse by default; blueprint 5.8), and `isDoomed` treats an unknown limit or an unreadable counter as doomed (ADR-028). Callers never catch the error to supply a default: the planner uses the 4.0-4.2 rules, asks for extra consent and rejects unattended plans.

## The era resolver

`resolveEra` (blueprint 5.2, fact sheet b.8) resolves the semantics era and, separately, how far the build is verified.

- Any node below 4.0 gives 3.13; any node below 4.3 gives 4.0-4.2.
- Otherwise 4.3 (4.4 when every node is 4.4 or later), but only on positive evidence. These all give 4.0-4.2: the `rabbitmq_4.3.0` flag not enabled or unknown, any quorum-queue member with Machine Version below 8, an unreadable node version, a commercial or unknown build, or a version that has no public release tag.
- `conservative` is true whenever the answer is lower than the version numbers say, the cluster mixes eras, or the build is not a known open-source release.
- `verification` is the weakest across nodes: `verified` (exact version in `lastVerified`), `unverified-patch` (same minor), `unverified-minor`, or `unknown-build`. A pre-release is never `verified`. The last public patch of each retired series (3.13.7, 4.0.9, 4.1.8, 4.2.9) is in `src/era.ts`: later patches such as 4.2.10 are commercial-only and so unknown builds.

## Evidence and status (I-14)

A cell starts `code-derived`: cited, linked to the conformance ids that will record independent lab evidence, with `evidence: []`. Nothing in this library sets a status or writes evidence. A cell leaves `code-derived` only with an artefact under `testing/lab-evidence/` recorded by CI (amendment A-20) in the same change and CODEOWNERS approval. The registry rejects a `lab-verified` or `lab-contradicted` cell without evidence, and evidence that is not for one of the cell's own conformance ids.

## Invariants

- Version-dependent broker behaviour is data here and nowhere else (I-3, `@app/no-broker-version-compare`). Data files hold no behaviour.
- Data is validated with zod when the registry is built (`RegistryDataError`), and returned cells are frozen.
- A missing cell, or a cell with a null effect or a contradicted status, is a gap: lookups fail closed.
- Cell ids and keys are unique, and every cell names at least one conformance id.
- Test names quote the AC or CF id they prove. Mutation testing must kill the `>` to `>=` mutant in `isDoomed` (`src/doomed.spec.ts` pins both boundaries).

## Adding a cell

Use the `semantics-cell` generator (skill `/new-semantics-cell`); it appends a `code-derived` cell with a null effect to `src/data/settle-matrix.data.ts`. Fill in the effect and citations from the fact sheet, then `pnpm nx run semantics:audit-cells --require=citations,conformance`.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p semantics domain-model
pnpm nx run semantics:audit-cells
pnpm nx test semantics-audit
```
