---
name: new-lint-rule
description: Add a broker lint rule (the product's configuration linter, DC-56) to libs/shared/lint-rules with the lint-rule generator, with fixtures per broker version. Use for rules that inspect a RabbitMQ topology, policy or configuration, not for ESLint rules.
argument-hint: '<rule-id> --severity=<s> --since=<version>'
---

# /new-lint-rule

A **broker lint rule** is product functionality: it flags risky or deprecated RabbitMQ configuration for users (DC-56). It is data-driven and version-aware. It is not an ESLint rule; for those use `/new-eslint-rule`.

## Availability

The `lint-rule` generator ships with **M0-08** (issue #8, "Base Nx generators"):

```sh
pnpm nx g @app/generators:lint-rule <id> --severity --since=<ver>
```

Documented effect (execution plan 2.5): a rule in `libs/shared/lint-rules` with fixtures per version. The `lint-rules` library and the lint service that runs the rules arrive with later work packages (the linter feature is an M4 milestone item), so check `pnpm nx g @app/generators:lint-rule --help` and `ls libs/shared` first. If either is missing on your base, stop and say so in your report.

## Steps

1. The spec must give: rule id, what it detects, severity, the first broker version it applies to (`--since`), the documentation source, and the fix suggestion.
2. Run the generator once. Flag values (severity names, version syntax) come from the generator's `--help`; do not invent them.
3. The rule is pure (`type:pure`, isomorphic): it receives parsed definitions and returns findings. No I/O, no `node:*`, no network.
4. **Version knowledge is data (I-3).** Applicability by broker version goes through the semantics registry / `VersionRange`, never through a version string compare in the rule.
5. Fixtures: one folder per supported broker version (3.13.7, 4.0.9, 4.1.8, 4.2.9, 4.3.6) with an input that must trigger the rule and one that must not. Tests quote the AC id.
6. Wording is honest and actionable; findings link to the documentation source and carry a stable rule id.
7. Verify: `pnpm nx run-many -t lint typecheck test -p lint-rules`, then `pnpm nx affected -t lint typecheck test`.
