# semantics-audit

The runner behind `nx run semantics:audit-cells` (M0-11): it loads the registry data of `@app/semantics`, validates it with the library's own schema and cell rules, and exits 1 on any problem. It is a separate project because `@app/semantics` is isomorphic and may not touch the file system (it needs to check that evidence files exist).

Tags: `type:tooling`, `runtime:node`.

```
pnpm nx run semantics:audit-cells
pnpm nx run semantics:audit-cells --require=citations,conformance,effect
```

## What it checks

- The data parses against `RegistryDataSchema`; no table has a duplicate entry or an invalid version range.
- Cell ids and cell keys are unique, and every cell names at least one conformance id.
- A cell that is not `code-derived` has evidence, each evidence path belongs to one of the cell's own conformance ids (`testing/lab-evidence/<version>/<CF-id>.json`), and the file exists.
- With `--require`: `citations` (at least one per cell) and `effect` (no null effect). `conformance` is always on; naming it is accepted.

It only reads. It never changes a cell, a status or `testing/lab-evidence/**` (I-14).

## Options

`--data=<path>` audits another module that exports `registryData` (the tests use fixtures); `--root=<dir>` is where evidence paths are resolved (default: the working directory).

`register.mjs` lets Node resolve the `@app/*` path aliases, so the script runs on the TypeScript sources directly (Node type stripping): `node --import ./tools/semantics-audit/register.mjs tools/semantics-audit/audit-cells.ts`.

## Proof

`pnpm nx test semantics-audit` runs the real command against fixtures and against the shipped data.
