---
name: wp-spec
description: Write the working spec for a work package (docs/specs/<WP-id>.md) from its GitHub issue and the design docs, then stop for human approval. Use when a WP has no spec with Given/When/Then and exact verification commands, or when asked to "spec", "scope" or "plan" a WP.
argument-hint: '<WP-id or issue number>'
---

# /wp-spec

Turns a work package into a reviewable spec. You write the spec; you do **not** implement anything in this session.

## Steps

1. **Collect the inputs.**
   - `gh issue view <n>` (system of record, ADR-033). Note labels: size, lane, `trust:critical`, wave, amendments (A-n are binding).
   - The design entry in `docs/plan/work-packages-design.md` for the same id, and the blueprint sections, ADRs and invariants it cites.
   - `docs/open-questions.md`: do not decide an open question inside a spec; list it under Risks / questions.
2. **Copy the template.** `docs/specs/_TEMPLATE.md` to `docs/specs/<WP-id>.md` (for example `docs/specs/M0-14.md`). Fill every section; delete the guidance comments.
3. **Goal.** One or two sentences plus the feature, DC and ADR ids it serves.
4. **Files and interfaces.** Lists of files to create and modify, with the TypeScript signatures introduced and consumed. Respect the module boundaries in `eslint.config.mjs`; name the Nx project and its tags.
5. **Out of scope.** An explicit list. Anything the issue defers goes here.
6. **Acceptance criteria.** `AC-1..n` in Given/When/Then form, copied or tightened from the issue. Each AC maps to **exactly one named test**; write the test name now (it must quote the AC id). Add the failure-path ACs the invariants require (fail closed, bounded, no silent loss).
7. **Verification.** Exact, copy-paste-runnable commands. Only reference Nx targets that exist: check with `pnpm nx show project <name>`. Mark targets that a later WP adds as planned and give the interim check.
8. **Size and risk.** Estimate changed lines (limit 800 excluding generated files, fixtures, evidence). If larger, propose a split. State whether the WP is `trust:critical` and which protected paths it needs a human to change.
9. **Risks / questions** and the **DoD checklist** (execution plan section 4).
10. **Stop.** Show the spec path and the open questions, and wait for human approval. Do not start coding, do not open a PR for code.

## Rules

- Never invent facts. If something is not in the issue or the docs, it is a question, not a requirement.
- Honest wording and the docs policy apply (AGENTS.md section 1).
- The spec is documentation: commit it as `docs(specs): add <WP-id> spec` and close nothing.
