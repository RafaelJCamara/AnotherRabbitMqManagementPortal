---
name: new-eslint-rule
description: Add a project-specific ESLint rule to tools/eslint-rules (rule, RuleTester spec, registration, path scoping, lint-selftest case). Use when an invariant or convention should be enforced mechanically by lint rather than by review.
argument-hint: '<rule-id>'
---

# /new-eslint-rule

Custom rules enforce invariants mechanically (I-3, I-6, ADR-001, ADR-003, ADR-021, DC-15). They live in `tools/eslint-rules`, are registered as `@app/<rule>`, and are scoped by path in `eslint.config.mjs`. This is the ESLint rule for **code**; for broker lint rules (DC-56) use `/new-lint-rule`.

## Availability

The `eslint-rule` generator ships with **M0-08** (issue #8, "Base Nx generators"):

```sh
pnpm nx g @app/generators:eslint-rule <id>
```

Documented effect (execution plan 2.5): the rule, a `RuleTester` spec and the registration. Check `pnpm nx g @app/generators:eslint-rule --help` first. If it is not available on your base, follow the manual steps in `tools/eslint-rules/README.md` ("Add a rule"), which are the same steps.

## Steps

1. Name the invariant or decision the rule guards (an `I-n`, an ADR, a DC id). A rule without one is a style preference: do not add it.
2. Generate (or create) `src/rules/<id>.ts` and `src/rules/<id>.spec.ts`; register the rule in `src/index.ts`.
3. Constraints of this package: Node loads the plugin as TypeScript by type stripping, so use only erasable syntax and `.ts` import specifiers; the rules work on names and AST shapes and never import zod, semver or Angular.
4. Specs: a `RuleTester` case for each way the rule should fire and for the allowed neighbours. Include at least one case that a lazy author would get wrong.
5. Scope it. Add an entry to `projectRules` in `eslint.config.mjs` stating the invariant, where the rule applies and where it deliberately does not. Add a path-scoping case to `tools/lint-selftest/src/project-rules.spec.ts`.
6. Document it in the table in `tools/eslint-rules/README.md`. If you made a name-based heuristic, record the open question in `docs/open-questions.md`.
7. Verify: `pnpm nx test eslint-rules`, `pnpm nx test lint-selftest`, and `pnpm nx run-many -t lint` (the whole repository must stay lint-clean; fix real findings, do not add `eslint-disable`).

`eslint.config.mjs` is shared policy: keep the change minimal and call it out in the commit message.
