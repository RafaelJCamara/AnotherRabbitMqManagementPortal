# peek-planner

The pure peek planner (M1-12): turns the semantics registry, the preflight, the broker profile and the principal into a **side-effect-aware peek** plan, or into a rejection with a closed code. It plans; it never reads, writes or waits. The executor (M1-14), the guard and dispositions (M1-15) and the `messages.peek` action (M1-16) follow what it decides.

Tags: `type:pure`, `runtime:isomorphic`, `trust:critical`. Spec: [docs/specs/M1-12.md](../../../docs/specs/M1-12.md) (rules R1..R12, the evaluation order, the preflight contract). Open questions: OQ-1421..1436.

The wording is honest on purpose: a classic-queue or quorum-queue read is never called "non-destructive" or "read-only". The headline claim is `peek-planner.honestLabel.v1`.

## Public API

- `planPeek(req, facts)` and `peekPlanner.plan`: the planner. Returns a `PeekPlanDraft` (preview, gates, warnings, consents) or a `PeekRejection`. The order of its checks is the contract (spec R2). `PEEK_FEATURE` is the feature id a broker profile may switch off.
- `REJECTION_CODES`, `REASON_CODES`, `isRejection`, `rejectionTextKey`, `reasonTextKey`, `HONEST_LABEL_KEY`, `TEXT_SCOPE`, `TEXT_VERSION`: the closed vocabulary. A rejection carries a code, closed reasons and a text key, never prose.
- `PLANNER_WARNING_IDS`, `plannerWarning`: the four warnings the planner owns (`W-BROKER-UNVERIFIED`, `W-DLX-UNVERIFIED`, `W-LIMIT-UNKNOWN`, `W-SEMANTICS-GAP`, all consents; OQ-1425). The 16 warnings of fact sheet b.8 come from the registry.
- `isHumanInteractive`: who may let the broker handle a message (R11).
- Types: `PeekRequest`, `PeekFacts`, `PeekPreflight`, `PeekPlanDraft`, `PeekPlanPreview`, `PeekRejection`, `Disposition` and the rest of `src/types.ts`.

Text lives in [`i18n/en/peek-planner.json`](i18n/en/peek-planner.json); a text key is `peek-planner.<group>.<id>.v<version>`.

## Invariants

- **Pure and total (R1).** No I/O, no clock (`facts.nowMs` is an input), no randomness; the input is never mutated; every list is sorted.
- **I-3.** No broker version or era name is compared. Every era-dependent fact is asked of the registry: a settle `cell`, `isDoomed`, `peekCaps`, `warning`.
- **Fail closed.** A missing registry row is a `SemanticsGapError`, handled with a conservative substitute and a consent, and refused for non-human principals. An absent preflight field means unknown.
- **No silent loss (I-13).** A clamp, a substitution and an estimate are all in the answer.
- Imports only `@app/contracts`, `@app/domain-model` and `@app/semantics` (`type:pure` row of blueprint 2.2).
- Confidence is `code-derived` (or `unverified-version`), never `lab-verified` (OQ-1421).

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p peek-planner
pnpm nx test peek-planner
```
