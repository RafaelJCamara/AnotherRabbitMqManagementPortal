# semantics

`@app/semantics`: the broker semantics registry core (DC-01/02, ADR-007, blueprint 5.2). Typed data cells keyed by era, queue type, protocol, action, limit state and delayed-retry mode, each linked to lab evidence that is recorded outside the registry, plus a fail-closed lookup interface and the conservative era and verification resolver.

Tags: `type:pure`, `runtime:isomorphic`, `trust:critical` (a human CODEOWNERS sign-off is required).

This package is the mechanism plus the data. M0-12 ships the 137 cells (see "The M0-12 cells"); M0-13 ships the hazards, capabilities, warnings, peek caps, tap rules and provider presets (see "The M0-13 data tables").

## Public API

| Area         | Exports                                                                                                                                         | File                |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Cell types   | `SemanticsCell` / `SemanticsCellSchema`, `CellKey`, `SettleEffect`, `Citation`, `CellStatus`, `EvidencePathSchema`, `cellKeyString` (types and schemas) | `src/schema.ts`     |
| Errors       | `SemanticsGapError` (a missing or unusable entry), `RegistryDataError` (invalid data)                                                           | `src/schema.ts`     |
| Registry     | `createRegistry(data)`, `BrokerSemanticsRegistry`, `RegistryDataSchema`, `validateRegistryData`; `semanticsRegistry` is the one this release ships | `src/registry.ts`   |
| Era          | `resolveEra(EraInputs)` returning `{ era, reasons, conservative, verification }`                                                                | `src/era.ts`        |
| Doom guard   | `isDoomed(era, counters, limit)`, `DeliveryLimit`                                                                                               | `src/doomed.ts`     |
| Tables       | `WarningDefSchema`, `GateRuleSchema`, `PeekCapRowSchema`, `TapRuleSchema`, `HazardRuleSchema`, `CapabilityRuleSchema`, `ProviderPresetSchema`, `presetIdFor` and their types | `src/{warnings,gates,caps,tap-rules,hazards,capabilities,provider-presets}.ts` |
| Audit        | `auditCells(cells, { require, evidenceExists })`                                                                                                | `src/audit.ts`      |
| Data         | `registryData`, `SEMANTICS_VERSION`, `settleMatrix` (the other cell tables are inside `registryData`)                                          | `src/data/`         |

## How the lookups fail

| Lookup                      | When it throws `SemanticsGapError`                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `cell(key)`                 | No cell has exactly this key, or the cell's effect is `null` (not derived yet), or its status is `lab-contradicted`.       |
| `warning(id)`               | Unknown `W-*` id.                                                                                                         |
| `gate(feature, profile)`    | The feature has no gate rule.                                                                                             |
| `peekCaps(era, q, role, v)` | No row for the key (streams have none), or, for a build that is not `verified`, no row in the conservative 4.0-4.2 era.   |
| `capability(id, profile)`   | Unknown capability id. A known capability the evidence does not prove answers `false`, not a gap.                          |
| `providerPreset(target, v)` | The table has no preset for the provider or product (the shipped table has one for each).                                  |

Not a gap, by design: `tapRule` refuses an exchange type nobody described (`diverts`, no e2e, refuse by default; blueprint 5.8), and `isDoomed` treats an unknown limit or an unreadable counter as doomed (ADR-028). Callers never catch the error to supply a default: the planner uses the 4.0-4.2 rules, asks for extra consent and rejects unattended plans.

## The M0-13 data tables

Files in `src/data/`; every claim in them is read from the fact sheet (`docs/research/fact-sheet.md`) and cited, none is lab-verified. The tables carry no `status` or `evidence` field, so a human can not mistake them for verified: the cells do, and that is where the lab evidence goes (OQ-361).

| Table                  | File                      | What a lookup answers                                                                                                                          |
| ---------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `hazards(profile)`     | `hazards.data.ts`         | Ids of the known-bug rules that might apply (fact sheet section a). Written to over-report: an unreadable node version matches every rule.      |
| `capability(id, p)`    | `capabilities.data.ts`    | Whether the broker answers a request shape correctly (DC-32), for example `channelsAcceptDisableStats`. Written to under-grant: every node must be proven inside the range, and `unknown` is not a RabbitMQ product. |
| `warning(id)`          | `warnings.data.ts`        | The 16 `W-*` ids with a severity and a versioned text key. The words are in `i18n/en/warnings.json` under `<id>.v<textVersion>`; a changed text gets a new version and keeps the old one. |
| `peekCaps(...)`        | `peek-caps.data.ts`       | Default, maximum and byte cap per era, queue type and role. An unverified build is capped at the 4.0-4.2 default.                               |
| `tapRule(type, v)`     | `tap-rules.data.ts`       | Whether a tap on the exchange type diverts, allows e2e and is refused by default. An unlisted type is refused.                                  |
| `providerPreset(t, v)` | `provider-presets.data.ts`| Documented limits, owned objects and the support level of ten areas for a provider or non-RabbitMQ product (fact sheet j.1). A probe result outranks it. |

The texts use `{{name}}` placeholders (Transloco syntax); the planner fills them. They never say a classic or quorum read is non-destructive or read-only (DC-15); the `@app/honest-wording` rule lints the JSON file and a spec repeats the banned terms.

## The M0-12 cells

Files in `src/data/`; every value is read from the fact sheet (b.1, b.2, b.4, b.5) and cited with an `RS@<tag>:<path>` source reference (`citations.ts`). All 137 cells are `code-derived` with empty `evidence`; the lab (M0-38 to M0-40) records the evidence and a human approves it.

| File                      | Cells | What it holds                                                                                                              | Conformance ids         |
| ------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `settle-matrix.data.ts`   | 39    | The requeue family (`nack`, `reject`, `released`, `modified`, HTTP `/get` nack) for 3.13, 4.0-4.2 and 4.3 (delayed retry `disabled`) | CF-SETTLE-*, CF-STAMP-01 |
| `delayed-retry.data.ts`   | 36    | The same family on 4.3 with `x-delayed-retry-type` `all`, `failed` and `returned` (position `delayed` or `head`)             | CF-DR-*                  |
| `dlx-carryover.data.ts`   | 7     | The dead-letter family (`no_requeue`, `rejected`, 3.13 `modified(df=false)`); the carry-over facts are in citations and ids   | CF-CARRY-*, CF-SETTLE-06 |
| `counters.data.ts`        | 55    | Broker-side events that move the counters: close, TCP loss, partition, AMQP 1.0 detach, consumer timeout                    | CF-DOWN-*                |

Key convention: `limit` is in the key when the effect depends on it (`unset` exists on 3.13 only; from 4.0 an unlimited queue is `minus1`), `delayedRetry` is in the key on 4.3 only, and a key the fact sheet does not settle has no cell, so its lookup is a `SemanticsGapError` (classic queues, streams, era 4.4, the 3.13 detach row, 4.3 events under an active delayed-retry mode). Lookups are exact; the caller builds the whole key. The judgement calls are OQ-390 to OQ-399.

`src/data/cells.data.spec.ts` holds an oracle written from the fact sheet rows that answers for every possible key (era x queue type x protocol x action x limit x delayed retry): a settled key must have exactly the described cell and every other key must be a gap, so a changed value, a dropped cell or an extra cell fails. `apps/conformance/src/cells/registry-links.spec.ts` checks that every conformance id of a cell has a lab-cell stub.
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

Use the `semantics-cell` generator (skill `/new-semantics-cell`); it appends a `code-derived` cell with a null effect to `src/data/settle-matrix.data.ts` (move it to the file of its family, for example `counters.data.ts`). Fill in the effect and citations from the fact sheet (the shared sources are in `citations.ts`), run `conformance-cell` for its CF id, then `pnpm nx run semantics:audit-cells --require=citations,conformance`.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p semantics domain-model
pnpm nx run semantics:audit-cells
pnpm nx test semantics-audit
```
