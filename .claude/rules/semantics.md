---
paths:
  - 'libs/shared/semantics/**'
  - 'apps/conformance/**'
  - 'testing/**'
---

# Semantics and evidence rules

Applies to the semantics registry, the conformance suite and everything under `testing/`. Trust-critical. Source: blueprint 5.2, invariant I-14, amendment A-20.

- **The registry is data.** Cells live in `libs/shared/semantics/src/data/*.data.ts` as typed constants validated with zod at build time. No behaviour, no version comparisons in the data files.
- **Every cell carries** `citations[]`, `conformance[]` (CF ids), `status` (`code-derived`, `lab-verified`, `lab-contradicted`) and `evidence[]` (paths to lab evidence artefacts).
- **What an agent may do:** add a `code-derived` cell with citations and a CF id, add the linked conformance-cell stub (`/new-semantics-cell`), fix lookups and tests.
- **What an agent must never do:** edit `testing/lab-evidence/**`; flip a cell's `status`; add `evidence[]` paths that CI did not record; weaken a conformance assertion to make a cell pass. `guard-paths` blocks lab-evidence edits.
- **Lab truth outranks registry text (I-14).** Evidence is recorded by CI (`conformance:record`, which does not read the registry), on digest-pinned images, and arrives as a bot PR labelled `lab-evidence` for a human to approve. A negative result changes the registry or the design, never the test.
- **Three-way rule.** Conformance tests assert (a) the live run matches the recorded evidence and (b) the registry cell matches the evidence. A status flips only with an evidence artefact in the same PR plus CODEOWNERS sign-off.
- **Fail closed.** A missing cell throws `SemanticsGapError`; the planner then uses the conservative 4.0-4.2 rules and extra consent, and rejects the plan for unattended principals. Do not add silent defaults.
- **Honest wording** in cell texts and warnings (`W-*` keys): "side-effect-aware peek", never "non-destructive" for classic or quorum queue reads.
- **Unverified broker versions** (newer patch or minor, unknown build) are never treated as verified: conservative caps, extra consent, MCP mutations off.
- New broker releases follow [docs/runbooks/new-broker-release.md](../../docs/runbooks/new-broker-release.md). Changes to RabbitMQ semantics need an RFC issue first (GOVERNANCE.md).
- Test names quote the CF or AC id. Mutation testing must kill the listed mutants (nack-for-reject, dropped qos barrier, close-before-barrier, `>` to `>=` in `isDoomed`, skipped DLX-source check, `ack` without proof, AMQP 1.0 credit above 1).
