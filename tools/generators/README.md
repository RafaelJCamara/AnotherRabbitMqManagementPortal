# generators

Nx generators (M0-08) that scaffold projects and registry entries so that they satisfy the workspace rules out of the box: tags, module boundaries, third-party confinement, the `@app/*` lint rules, explicit `lint`, `typecheck` and `test` targets, a README and a path alias. Imported as `@app/generators`.

```sh
pnpm nx g @app/generators:service-module svc-demo
pnpm nx g @app/generators:adapter demo --port=DemoPort --confine=left-pad
```

The full command list, the rules the generators enforce and the gotchas are in [docs/architecture/generators.md](../../docs/architecture/generators.md).

Tags: `type:tooling`, `runtime:node`.

## Public API

- `generators.json`: the thirteen generators `library`, `service-module`, `adapter`, `ui-feature`, `eslint-rule`, `lint-rule`, `decoder`, `semantics-cell`, `conformance-cell`, `migration`, `action`, `topic` and `job`.
- `src/index.ts`: the generator functions, for the unit tests and the `@app/generators` alias.

## Invariants

- Every generated action starts as a failing test: the stub bodies fail, and implemented as `docs/golden-path/` shows it passes lint, typecheck, test and `contracts:api-docs-check` (`e2e/golden-path.spec.ts`, which runs those pages verbatim). A generator checks every option before it writes a file, and never overwrites one.`n- Every generated project passes `lint` (including the custom `@app` rules and module boundaries), `typecheck` and `test` without edits, and is already Prettier-clean (`e2e/generated-projects.spec.ts`).
- Project generation goes through `scaffoldLibrary`; policy tables in `eslint.config.mjs` are edited through the syntax-aware helpers in `src/shared/`, never with regular expressions.
- A generator never widens an existing confinement row and never writes lab evidence.
- Flag names follow `docs/plan/execution-plan.md` section 2.5; `src/plugin.spec.ts` pins them.
- The plugin has no dependency beyond the workspace catalog (`@nx/devkit`, `typescript`, `prettier`). It never calls the Nx Vitest generators, which refuse Vitest 5 (OQ-24).

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p generators
pnpm nx run generators:unit     # snapshots and tree assertions, seconds
pnpm nx run generators:e2e      # real nx g in temporary workspaces: every generator, and the golden-path pages
```

`generators:test` runs both. Update snapshots with `pnpm vitest run --config tools/generators/vitest.config.mts -u` only after reading the diff: the snapshots are the contract agents rely on.
