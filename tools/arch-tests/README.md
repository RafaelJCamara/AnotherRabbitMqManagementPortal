# arch-tests

Architecture tests that read the repository's own source (M0-29): the mutation funnel (I-2), the proof-minting rule (A-9) and the plan-purity manifest. They parse TypeScript syntax with the compiler API (no type information, no new dependency), so a rule runs in milliseconds on any file.

Tags: `type:test`, `runtime:node`.

## Public API

| Export                                      | What it is                                                                                                                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listSources(root)`, `SCAN_ROOTS`           | Every `.ts` file under `apps`, `libs`, `tools` and `testing`, skipping `node_modules`, build output and the planted lint fixtures.                                                      |
| `readFacts(path, text)`                     | What a file imports, names, calls and casts to.                                                                                                                                         |
| `checkMutationFunnel(files)`                | I-2. A file outside `FUNNEL_EXEMPT_PREFIXES` that names a write-capable port (`*WritePort`, a role lease, `ConnectionManager`, `ExecutorWrite`, `ctx.writes`) must call `implementAction(...)` or `defineJob(...)`. Specs are exempt. |
| `checkProofMinting(files)`                  | A-9. Only `PROOF_MINTING_PREFIXES` may import a `mint*Proof` function, and no one may forge a proof with `as ConfirmedCopyProof` and friends (the `testing/` and testkit helpers excepted). |
| `findActionSites(files)`, `isActionModule`  | The product files that call `implementAction(...)`, with the number of calls.                                                                                                            |
| `registeredActions()`                       | The plan-purity manifest: one entry per `implementAction` call site, with an input that passes its schema. `repository.spec.ts` compares it with the call sites found in the source.    |

## Invariants

- **The tree is clean.** `repository.spec.ts` runs the rules against the real repository. A new exempt location is a reviewed change to `FUNNEL_EXEMPT_PREFIXES` or `PROOF_MINTING_PREFIXES` in `src/rules.ts`, not an exception in the file that trips the rule.
- **The rules bite.** `rules.spec.ts` plants violations (a service file that imports a write port, an aliased and a type-only import, `ctx.writes`, a forged proof, a mint import from a service) and proves each is reported, and that action modules, the plumbing and specs are not.
- **Plan purity (AC-2).** The manifest is run through `checkPlanPurity` of `@app/kernel`: `plan()` against write ports that throw, which fails a plan that calls one even if it swallowed the error. Adding an action means adding it to `src/registered-actions.ts` (`pnpm nx g @app/generators:action` appends the entry); an `implementAction` call site that is not listed fails the build.
- **The halves agree.** `executor-persistence.spec.ts` runs the kernel executor over the SQL plan and idempotency repositories of `persistence` (SQLite in memory): the kernel cannot import an adapter and an adapter cannot import the kernel, so the test that joins them sits in a `type:test` project. It also edits rows in SQL behind the executor (risk lowered, payload swapped) and expects `PLAN_STALE`.
- **The jobs halves agree (M0-31).** `jobs-persistence.spec.ts` runs the `JobRunner` of `@app/jobs` over the SQL `JobStore` (SQLite in memory): a drained job is `paused-interrupted` with its sealed checkpoint and resumes, one concurrency key is held by one running job, and a row edited in SQL (requester, plan hash) or a state the `CHECK` forbids is refused. Of `libs/engine/jobs`, only `src/runner.ts` and `src/types.ts` are in `FUNNEL_EXEMPT_PREFIXES`. Of `libs/engine/svc-connections`, only `src/internal/connection-manager/` is (M0-43: the ConnectionManager hands out the role leases).
- **Syntax only.** A rule that needs types (is this `Foo` really the port?) is out of scope; the rules go by name, which errs towards reporting.

## Proof commands

```sh
pnpm nx test arch-tests
pnpm nx run-many -t lint typecheck test -p arch-tests
```

Open questions: OQ-240 to OQ-242 in [docs/open-questions.md](../../docs/open-questions.md).
