# <WP-id> <title>

<!--
Spec template for one work package (docs/plan/execution-plan.md section 2.6). Copy this file to
docs/specs/<WP-id>.md (for example docs/specs/M0-14.md), fill every section and delete the comments.
One spec = one GitHub issue = one worktree = one PR. The issue stays the system of record (ADR-033);
this file is the reviewable working spec. Do not invent facts: unknowns go under "Risks / questions".
-->

**Issue:** #<n> · **Milestone:** <M0..> · **Wave:** <wave> · **Size:** <S|M|L> · **Owner area:** <area> · **trust:critical:** <yes|no>

## Goal

<!-- 1-2 sentences, plus the feature ids, DC ids and ADRs this serves. -->

## Files & interfaces

<!-- Exact paths. Name the Nx project and its tags. Respect module boundaries (eslint.config.mjs). -->

**Create**

- `<path>`: <purpose>

**Modify**

- `<path>`: <what changes>

**Interfaces**

```ts
// TypeScript signatures introduced by this WP

// ... and consumed from other projects (name the project)
```

## Out of scope

<!-- Explicit list. Anything deferred to another WP or issue goes here, with its id. -->

- <item>

## Acceptance criteria

<!--
AC-1..n as Given/When/Then. Each AC maps to exactly one named automated test, and the test name
quotes the AC id. Include the failure paths the invariants require (fail closed, bounded buffers,
no silent loss, honest wording).
-->

| ID   | Given     | When     | Then     | Test (name quotes the AC id)        |
| ---- | --------- | -------- | -------- | ----------------------------------- |
| AC-1 | <context> | <action> | <result> | `<file>`: "AC-1 <what it proves>"   |

## Verification

<!-- Exact, copy-paste-runnable commands, run from the repository root. Only existing Nx targets. -->

```sh
pnpm nx run-many -t lint typecheck test -p <project>
pnpm nx affected -t lint typecheck test build --base=origin/main
pnpm nx run supply-chain:gates
```

## Risks / questions

<!-- Open questions for the human (link docs/open-questions.md ids), protected paths this WP needs
a human to change, uncertainties (U-nn) it depends on, estimated changed lines (limit 800). -->

- <risk or question>

## DoD checklist

- [ ] Spec merged or linked; every AC has a named passing test.
- [ ] Verification commands pass locally and in CI.
- [ ] `nx affected -t lint typecheck test build` and the supply-chain gates are green.
- [ ] Module boundaries, confinement and custom lint rules pass; no `eslint-disable` without a linked issue.
- [ ] Project README updated (purpose, public API, invariants, proof commands); decisions recorded in an ADR.
- [ ] UI: strings are i18n keys, axe clean, budgets met. Engine: errors are Problems, buffers bounded, redaction canary passes.
- [ ] trust:critical: adversarial review and human CODEOWNERS approval. Semantics: recorded evidence and three-way green.
- [ ] At most 800 changed lines (excluding generated files, fixtures and evidence), or `oversize-approved`.
- [ ] Conventional Commits title, DCO sign-off, agent co-author trailer, `Closes #<n>`.
