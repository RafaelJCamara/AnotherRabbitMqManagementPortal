# work-graph

Validator for the feature catalogue ([docs/product/features.md](../../docs/product/features.md)) and the work-item graph ([docs/plan/work-items.json](../../docs/plan/work-items.json) and its issue index [work-items.md](../../docs/plan/work-items.md)). It is the "CI graph validator" required by [amendments.md](../../docs/plan/amendments.md) (M0-77). Plain TypeScript on Node type stripping; no dependencies.

## Proof commands

| Command                                                  | What it proves                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `pnpm nx run work-graph:validate`                        | The real plan passes (known findings aside). Fails with the offending ids.      |
| `pnpm nx run work-graph:test`                            | The self-test: one planted violation per rule, plus the CLI on committed fixtures. |
| `node tools/work-graph/run-validate.ts --root=<dir>`     | Validates a tree with the same `docs/` layout (used by the fixtures).           |

## Rules

Every violation prints `[rule] subject: message`, where the subject holds the offending ids (for example `M0-12->M0-99`).

- **Dependencies** (`items.*`): no dangling, self or duplicate dependency; no cycle; no dependency on a later milestone; no dependency on a later numbered wave (`M0-W2` before `M0-W1`); parents exist and are epics.
- **Consistency** (`items.*`): ids and titles unique and well-formed; milestone, kind, lane and size known; labels, areas, `trust:critical`, `amended`, `needs-split` and `wave:*` follow the fields; the first body line agrees with the fields; every milestone has exactly one `RC-Mn` checklist chore; lab-cell work-package lists name real items.
- **Index** (`index.*`): every work item has a row, hence an issue number; issue numbers and ids are unique; milestone, title, type, lane and URL agree with the JSON; the intro counts are right.
- **Catalogue** (`features.*`): ids unique; the heading and section counts match the rows; each summary row matches its detail section; no dangling, self or cyclic feature dependency; no feature depends on one that starts in a later milestone.
- **Coverage** (`coverage.*`): every feature is cited by at least one work item (title or body, including `ADM-04/05/06` and `PUB-03..07`); no work item cites a feature id that does not exist; no feature starts in a milestone earlier than the earliest work item that cites it.

## Known exceptions

A finding that is a judgement call is recorded as an open question in [docs/open-questions.md](../../docs/open-questions.md) and listed in `known-exceptions.json` (`rule`, `subject`, `oq`, `reason`) rather than rewritten silently. The run reports it, but passes. An exception is honoured only while the finding exists: when the plan is fixed, the stale entry fails the run (`exceptions.stale`) so the list only shrinks. An entry whose `oq` is not a row in the open-questions file also fails.

## Layout

| File                    | Role                                                            |
| ----------------------- | --------------------------------------------------------------- |
| `parse.ts`              | Parsers for the three documents and the feature-id shorthand    |
| `check-items.ts`        | Dependency graph, waves, labels and header checks               |
| `check-index.ts`        | work-items.md against work-items.json                           |
| `check-features.ts`     | Catalogue checks                                                |
| `check-coverage.ts`     | Feature to work-item mapping                                    |
| `exceptions.ts`         | Known-exception handling                                        |
| `validate.ts`           | Pure entry point: documents in, violations out                  |
| `run-validate.ts`       | CLI used by `nx run work-graph:validate` and CI                 |
| `validate-selftest.ts`  | Planted-violation self-test                                     |
| `fixtures/`             | `clean`, `dangling-dependency`, `forward-dependency` trees      |
