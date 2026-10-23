# effective-config

`@app/effective-config` (DC-30, POL-01): the pure effective-config resolver. Given a queue's arguments, its matching user policy and operator policy, the queue type and the broker version, it says per policy key which value the queue really has, where each input stood, and what is unknown. It is not the management API's `effective_policy_definition` (the merged policy only, which a queue argument can still override): that field is never an input and never an output here.

Tags: `type:pure`, `runtime:isomorphic`, `trust:critical` (a human CODEOWNERS sign-off and an adversarial security review are required; OQ-969 asks for the CODEOWNERS line).

The rules are registry data, not code (I-3): `@app/semantics`, `registry.effectiveConfig` (the k.3 tables in `libs/shared/semantics/src/data/effective-config.data.ts`, texts in `libs/shared/semantics/i18n/en/effective-config.json`). This package holds the mechanism, no broker knowledge and no version comparison.

## Public API

| Export | What it is |
| ------ | ---------- |
| `resolveEffective(input, lookup?)` | Step 1 and 2 for every key the inputs mention (and `input.keys`). Returns `{ entries, mergedPolicy, unrecognisedArguments, warnings, queueType, version }`. |
| `mergeOperator(user, operator, lookup?)` | Step 1 alone: the operator policy merged with the user policy. Marked `notEffective: true`. |
| `mergeDetails(user, operator, lookup)` | Step 1 with the leaves that decided each key (used by the resolver). |
| `combine(kind, a, b)` | The numeric merge rules `min`, `max` and `negative-rule` (a negative value means "no limit": the larger wins, otherwise the minimum). |
| `parseResolveInput(data)`, `ResolveInputSchema` | The strict shape check for data that crosses a boundary; `effective_policy_definition` is a problem, not an input. |
| `describeValue(value)` | How a value is shown in a warning text (short, never an object dump). |

Types: `ResolveInput`, `PolicyInput`, `EffectiveConfig`, `EffectiveEntry`, `EntryStatus`, `ProvenanceEntry`, `Layer`, `Role`, `EffectiveWarning`, `MergedPolicy`, `MergedEntry`, `PolicyValue`, `MergeDetail`, `PolicyLayer`, `ParsedResolveInput`.

## What an answer says

Per policy key an `EffectiveEntry` has:

- `status`: `effective` (a value decided by an argument, a policy or both), `default` (nothing sets it and the registry knows the broker default; `value: null` means "no limit"), `unset` (nothing sets it, or the key has no effect on this queue type and version), `unknown` (the registry cannot say), `invalid` (an input cannot be used with the rule).
- `value` (only for `effective` and `default`), `rule` (step 2: `min(arg, policy)`, `max(arg, policy)`, `negative-rule(arg, policy)`, `arg`, `policy`, `broker-default`), `mergeRule` (step 1: `min(user, operator)`, `negative-rule(user, operator)`, `max(user, operator)`, `operator`).
- `basis`: `source-read` when the cited broker source was read at a version that covers the queue's, `extrapolated` otherwise (the UI should say "inferred from 4.3.6").
- `provenance`: the argument, the user policy (by name), the operator policy (by name) and the broker default, each with a role: `deciding`, `compared`, `overridden`, `ignored`, `unresolved`.
- `warnings`: `W-EC-*` ids with a text key, the values for the `{{name}}` placeholders (`key`, `argument`, `queueType`, `version`, `argumentValue`, `userValue`, `operatorValue`, `policyValue`, `policyName`, `value`, `rule`, `reason`) and the citations of the registry row.

## Unknown is an answer

The resolver never invents a value. It answers `unknown` (with `W-EC-NO-ROW`, `W-EC-VERSION-UNKNOWN`, `W-EC-NO-MERGE` or `W-EC-UNDETERMINED`) when the registry has no row for the queue type, key and version (there are none for 4.4), when the version could not be read, when two policies set a key that no merge rule names, and for `delayed-retry-min` and `delayed-retry-max` while the sources disagree (OQ-962). It answers `invalid` (`W-EC-BAD-VALUE`) for a value the rule cannot use. A `SemanticsGapError` from the registry is turned into `unknown` and nothing else is caught.

## Invariants

- Pure: no I/O, no clock, no randomness; inputs are never mutated; the answer does not depend on the order of keys.
- No broker-version comparison and no broker behaviour in this package (I-3); both are registry data.
- Hostile keys (`__proto__`, `constructor`, inherited properties) are data: lookups use own properties only and results are built with `Object.fromEntries`.
- Lab evidence is not claimed: every row is `code-derived` (read from the fact sheet and the broker source) and names planned lab cells `CF-EFFCFG-01..07` (OQ-968).
- Dependencies follow the type:pure row of blueprint 2.2; `pnpm nx lint effective-config` enforces them.

## Proof commands

```sh
pnpm nx test effective-config
pnpm nx run-many -t lint typecheck test -p effective-config semantics
pnpm nx run semantics:audit-cells
```
